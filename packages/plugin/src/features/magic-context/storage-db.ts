import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    getLegacyOpenCodeMagicContextStorageDir,
    getMagicContextStorageDir,
} from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { deleteOrphanProjectKeyFiles } from "./key-files/project-key-files";
import { runMigrations } from "./migrations";
import {
    loadToolDefinitionMeasurements,
    setDatabase as setToolDefinitionDatabase,
} from "./tool-definition-tokens";
import { runToolOwnerBackfill } from "./tool-owner-backfill";

const databases = new Map<string, Database>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const persistenceErrorByDatabase = new WeakMap<Database, string>();

// Last schema-fence rejection, recorded so startup can surface a user-facing
// message (not just a log line). When OpenCode and Pi share context.db and one
// harness auto-updates first, it migrates the DB to a newer schema; the lagging
// harness's older binary then refuses to open the DB (fail-closed) and silently
// disables ALL of Magic Context until it too updates. The null openDatabase()
// return has no Database handle to key a WeakMap on, so we stash the detail in
// a module global the plugin entrypoint reads after a failed/empty open.
let lastSchemaFenceRejection: { persistedVersion: number; supportedVersion: number } | null = null;

export function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null {
    return lastSchemaFenceRejection;
}

export const LATEST_SUPPORTED_VERSION = 32;

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

/**
 * Create `dir` (recursively) owner-only and tighten an existing dir to 0o700.
 *
 * The storage tree holds project memories, raw conversation history, and
 * embeddings. Created with the default umask these can be group/world-readable,
 * leaking that content to other local users. We create with mode 0o700 and
 * additionally chmod (mkdir's `mode` is masked by umask and a no-op when the
 * dir already exists). Best-effort: a chmod failure is logged, not fatal.
 */
function ensureSecureStorageDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!PERMISSIONS_ENFORCEABLE) return;
    try {
        chmodSync(dir, 0o700);
    } catch (error) {
        log(
            `[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
        );
    }
}

/**
 * Restrict the SQLite DB file and its WAL/SHM sidecars to owner-only (0o600).
 * They are created with the process umask, which can be group/world-readable;
 * since they hold the same durable state as the storage dir, tighten them once
 * they exist. Best-effort per file.
 */
function restrictDatabaseFilePermissions(dbPath: string): void {
    if (!PERMISSIONS_ENFORCEABLE) return;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbPath}${suffix}`;
        if (!existsSync(file)) continue;
        try {
            chmodSync(file, 0o600);
        } catch (error) {
            log(
                `[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
            );
        }
    }
}

export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}

function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    // Test-isolation guard. Under the test runner the preload
    // (bunfig.toml `[test] preload`) sets MAGIC_CONTEXT_TEST_DATA_DIR to a
    // throwaway temp dir AND XDG_DATA_HOME to the same dir. Tests that manage
    // their OWN XDG_DATA_HOME (per-test temp dirs) keep working — we honor XDG
    // below via getMagicContextStorageDir(). The guard fires ONLY when
    // XDG_DATA_HOME is UNSET: that is the dangerous window, because
    // getMagicContextStorageDir() would otherwise fall back to the REAL
    // ~/.local/share and a bare openDatabase() would run migrations on the
    // user's production DB. Some tests delete XDG_DATA_HOME to exercise
    // path-fallback behavior (2026-06-01 incident: a dormant test migrated the
    // live DB to v26 and fail-closed every running v25 binary); in that window
    // we resolve into the dedicated test dir instead of the real path. No test
    // mutates MAGIC_CONTEXT_TEST_DATA_DIR, so the guard cannot be defeated. It
    // is never set in production.
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir && !process.env.XDG_DATA_HOME) {
        const dbDir = join(testDataDir, "cortexkit", "magic-context");
        return { dbDir, dbPath: join(dbDir, "context.db") };
    }
    const dbDir = getMagicContextStorageDir();
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

/**
 * One-time migration of pre-cortexkit OpenCode plugin data into the shared
 * cortexkit/magic-context location. Runs lazily on first openDatabase() call.
 *
 * Safety guarantees:
 *   - Only runs when target DB does not yet exist (idempotent on subsequent
 *     boots; never overwrites newer state).
 *   - Only runs when legacy DB exists (no-op for fresh installs and Pi).
 *   - Copies WAL/SHM sidecars too — WAL mode means uncheckpointed writes live
 *     there, so omitting them would lose recent data.
 *   - Copies the embedding model cache subdirectory if present, avoiding
 *     re-download on first post-migration boot.
 *   - Leaves legacy files in place as a manual rollback path. Manual cleanup
 *     is safe after one stable release.
 */
function migrateLegacyStorageIfNeeded(targetDbPath: string, targetDbDir: string): void {
    if (existsSync(targetDbPath)) return;

    const legacyDir = getLegacyOpenCodeMagicContextStorageDir();
    const legacyDbPath = join(legacyDir, "context.db");
    if (!existsSync(legacyDbPath)) return;

    log(
        `[magic-context] migrating legacy plugin storage: ${legacyDir} -> ${targetDbDir} (legacy left in place as backup)`,
    );
    ensureSecureStorageDir(targetDbDir);

    // Fold the legacy WAL into the main DB FIRST so the copied target is one
    // crash-consistent file. Copying .db/-wal/-shm as three separate files is
    // not atomic: if a legacy process is concurrently writing (or the -wal/-shm
    // are mid-update), the three snapshots can be mutually inconsistent and the
    // target opens corrupt or loses recent writes. wal_checkpoint(TRUNCATE)
    // writes all committed WAL frames back into the main file and empties the
    // WAL, after which the .db alone is complete. Best-effort: if the checkpoint
    // fails (legacy locked by a live writer), we still fall back to copying all
    // three sidecars below.
    try {
        const legacyDb = new Database(legacyDbPath);
        try {
            legacyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
            closeQuietly(legacyDb);
        }
    } catch (error) {
        log(
            `[magic-context] legacy WAL checkpoint before copy failed (continuing with sidecar copy): ${getErrorMessage(error)}`,
        );
    }

    // Copy main DB + WAL/SHM sidecars. After a successful checkpoint the -wal is
    // empty and the .db is self-contained, but we still copy the sidecars in
    // case the checkpoint was skipped (legacy locked) so uncheckpointed writes
    // aren't lost.
    for (const suffix of ["", "-wal", "-shm"]) {
        const src = `${legacyDbPath}${suffix}`;
        const dst = join(targetDbDir, `context.db${suffix}`);
        if (existsSync(src)) {
            try {
                copyFileSync(src, dst);
            } catch (error) {
                log(`[magic-context] failed to copy ${src}:`, getErrorMessage(error));
            }
        }
    }

    // Copy the embedding model cache subdir to avoid re-downloading on first boot.
    const legacyModelsDir = join(legacyDir, "models");
    const targetModelsDir = join(targetDbDir, "models");
    if (existsSync(legacyModelsDir) && !existsSync(targetModelsDir)) {
        try {
            cpSync(legacyModelsDir, targetModelsDir, { recursive: true });
        } catch (error) {
            log("[magic-context] failed to copy embedding model cache:", getErrorMessage(error));
        }
    }
}

export function getPersistedSchemaVersion(db: Database): number {
    const hasMigrationsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!hasMigrationsTable) {
        return 0;
    }
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        | { version: number | null }
        | undefined;
    return row?.version ?? 0;
}

export function schemaVersionIsSupported(
    db: Database,
    latestSupportedVersion = LATEST_SUPPORTED_VERSION,
): boolean {
    return getPersistedSchemaVersion(db) <= latestSupportedVersion;
}

function getRuntimeLatestSupportedVersion(options?: OpenDatabaseOptions): number {
    if (options?.latestSupportedVersion !== undefined) {
        return options.latestSupportedVersion;
    }
    const override = process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION;
    if (override) {
        const parsed = Number.parseInt(override, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return LATEST_SUPPORTED_VERSION;
}

export function enforceSchemaFence(
    db: Database,
    dbPath: string,
    latestSupportedVersion: number,
): boolean {
    const persistedVersion = getPersistedSchemaVersion(db);
    if (persistedVersion <= latestSupportedVersion) {
        return true;
    }
    lastSchemaFenceRejection = { persistedVersion, supportedVersion: latestSupportedVersion };
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; database schema v${persistedVersion} is newer than this binary supports (max v${latestSupportedVersion}). Upgrade Magic Context/OpenCode/Pi before writing to this cache.`,
    );
    return false;
}

// Per-connection SQLite tuning, settable once at plugin init (before the first
// openDatabase) so the 27 openDatabase call sites don't each need config
// threading. Defaults match the config schema (64 MiB cache, mmap disabled) so
// tests and early-init opens still get sane values.
let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export function applySqliteTuningPragmas(db: Database): void {
    // cache_size negative value = KiB of page cache (e.g. -65536 = 64 MiB).
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    // Bound any ANALYZE that a later PRAGMA optimize triggers on this connection.
    db.exec("PRAGMA analysis_limit=400");
}

/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {
        // Best-effort maintenance; never fail a caller over stats refresh.
    }
}

export function initializeDatabase(db: Database): void {
    // Install the busy timeout BEFORE any file-level PRAGMAs like WAL. Two
    // processes can cold-open the same DB at once (real OpenCode/Pi startup, or
    // the subprocess lease tests); without the timeout this connection can throw
    // SQLITE_BUSY immediately while the sibling is switching journal mode.
    db.exec("PRAGMA busy_timeout=5000");
    // SQLite per-connection PRAGMAs. foreign_keys MUST run before any reads
    // or writes: it defaults to OFF, which silently breaks every ON DELETE
    // CASCADE / SET NULL declared in the schema below and in migrations.
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    applySqliteTuningPragmas(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      p1_embedding BLOB,
      p1_embedding_model_id TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id);

    CREATE TABLE IF NOT EXISTS compartment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      compartment_id INTEGER,
      kind TEXT NOT NULL,
      at_compartment INTEGER,
      fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_events_session
      ON compartment_events(session_id);

    CREATE TABLE IF NOT EXISTS compartment_state_lease (
      session_id TEXT PRIMARY KEY NOT NULL,
      holder_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
      ON compartment_state_lease(expires_at);

    CREATE TABLE IF NOT EXISTS compression_depth (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, message_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_compression_depth_session ON compression_depth(session_id);

    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    -- session_notes and smart_notes were merged into the unified notes table
    -- by migration v1 (see features/magic-context/migrations.ts). The old tables
    -- are never recreated; fresh DBs create only notes, upgraded DBs have
    -- their old tables migrated and dropped by the migration runner.

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      importance INTEGER,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      -- FK-cascade audit (v12): memory_embeddings.memory_id -> memories.id
      -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
      -- every connection and v12 cleans historical orphan rows.
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
      target_memory_id INTEGER NOT NULL,
      superseded_by_id INTEGER,
      category TEXT,
      new_content TEXT,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
      ON memory_mutation_log(project_path, id);

    CREATE TABLE IF NOT EXISTS dream_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dream_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      retry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dream_queue_project ON dream_queue(project_path);
CREATE INDEX IF NOT EXISTS idx_dream_queue_pending ON dream_queue(started_at, enqueued_at);

    CREATE TABLE IF NOT EXISTS dream_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      tasks_succeeded INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      smart_notes_surfaced INTEGER NOT NULL DEFAULT 0,
      smart_notes_pending INTEGER NOT NULL DEFAULT 0,
      memory_changes_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_runs_project ON dream_runs(project_path, finished_at DESC);

    CREATE TABLE IF NOT EXISTS project_key_files (
      project_path           TEXT    NOT NULL,
      path                   TEXT    NOT NULL,
      content                TEXT    NOT NULL,
      content_hash           TEXT    NOT NULL,
      local_token_estimate   INTEGER NOT NULL,
      generated_at           INTEGER NOT NULL,
      generated_by_model     TEXT,
      generation_config_hash TEXT    NOT NULL,
      stale_reason           TEXT,
      PRIMARY KEY (project_path, path)
    );
    CREATE INDEX IF NOT EXISTS idx_project_key_files_project ON project_key_files(project_path);
    CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at ON project_key_files(project_path, generated_at);

    CREATE TABLE IF NOT EXISTS project_key_files_version (
      project_path TEXT    PRIMARY KEY,
      version      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schema_migrations_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_state (
      project_path TEXT PRIMARY KEY,
      project_memory_epoch INTEGER NOT NULL DEFAULT 0,
      project_user_profile_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
      project_path TEXT PRIMARY KEY,
      lease_holder TEXT,
      lease_expires_at INTEGER,
      last_swept_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
      ON git_sweep_coordinator(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
      ON git_sweep_coordinator(last_swept_at);

    CREATE TABLE IF NOT EXISTS m0_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN (
        'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
      )),
      target_id INTEGER,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);

    CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
      old_project_path TEXT PRIMARY KEY,
      new_project_path TEXT NOT NULL,
      rekeyed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS v22_backfill_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      raw_project_path TEXT NOT NULL,
      error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
      error_message TEXT,
      failed_at INTEGER NOT NULL,
      UNIQUE(table_name, row_id)
    );

    -- (smart_notes: see note above; merged into unified notes table by migration v1)

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_history_fts USING fts5(
      session_id UNINDEXED,
      message_ordinal UNINDEXED,
      message_id UNINDEXED,
      role,
      content,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_nudge_undropped INTEGER DEFAULT 0,
      last_nudge_level TEXT DEFAULT '',
      channel2_nudge_state TEXT DEFAULT '',
      channel2_nudge_claimed_at INTEGER DEFAULT 0,
      last_emergency_input_sample INTEGER DEFAULT 0,
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      note_nudge_trigger_pending INTEGER DEFAULT 0,
      note_nudge_trigger_message_id TEXT DEFAULT '',
      note_nudge_sticky_text TEXT DEFAULT '',
      note_nudge_sticky_message_id TEXT DEFAULT '',
      note_nudge_anchors TEXT NOT NULL DEFAULT '[]',
      auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]',
      last_todo_state TEXT DEFAULT '',
      todo_synthetic_call_id TEXT DEFAULT '',
      todo_synthetic_anchor_message_id TEXT DEFAULT '',
      todo_synthetic_state_json TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash TEXT DEFAULT '',
      memory_block_cache TEXT DEFAULT '',
      memory_block_count INTEGER DEFAULT 0,
      memory_block_ids TEXT DEFAULT '',
      -- pending_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred marker is SQL NULL; presence is a
      -- valid JSON blob written via setPendingCompactionMarkerState.
      -- Excluded from healNullTextColumns. Readers filter IS NOT NULL AND
      -- != empty-string defensively. Plan v6 section 3.
      pending_compaction_marker_state TEXT,
      -- pending_pi_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred Pi-native marker is SQL NULL; presence
      -- is a valid JSON blob written via setPendingPiCompactionMarkerState.
      -- Excluded from healNullTextColumns.
      pending_pi_compaction_marker_state TEXT,
      new_work_tokens INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      -- deferred_execute_state: intentionally NULLABLE without a default.
      -- Absence is SQL NULL; presence is a JSON blob written via
      -- setDeferredExecutePendingIfAbsent. Excluded from healNullTextColumns.
      deferred_execute_state TEXT,
      cached_m0_bytes BLOB,
      cached_m0_project_memory_epoch INTEGER,
      cached_m0_project_user_profile_version INTEGER,
      cached_m0_max_compartment_seq INTEGER,
      cached_m0_max_memory_id INTEGER,
      cached_m0_max_mutation_id INTEGER,
      cached_m0_max_memory_mutation_id INTEGER,
      cached_m0_project_docs_hash TEXT,
      cached_m1_bytes BLOB,
      last_observed_model_key TEXT,
      last_usage_context_limit INTEGER NOT NULL DEFAULT 0,
      prior_boundary_ordinal INTEGER NOT NULL DEFAULT 1,
      protected_tail_policy_version INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_window_started_at INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_tokens INTEGER NOT NULL DEFAULT 0,
      recovery_no_eligible_head_count INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_window_start INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_used INTEGER NOT NULL DEFAULT 0,
      cached_m0_materialized_at INTEGER,
      cached_m0_session_facts_version INTEGER,
      cached_m0_upgrade_state TEXT,
      cached_m0_system_hash TEXT,
      cached_m0_tool_set_hash TEXT,
      cached_m0_model_key TEXT,
      cached_m0_last_baseline_end_message_id TEXT,
      upgrade_reminded_at INTEGER,
      pi_stable_id_scheme INTEGER
    );

    CREATE TABLE IF NOT EXISTS subagent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      subagent TEXT NOT NULL,
      task TEXT,
      provider_id TEXT,
      model_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parent_invocation_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sai_session_started
      ON subagent_invocations(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sai_subagent
      ON subagent_invocations(subagent, started_at DESC);

    CREATE TABLE IF NOT EXISTS historian_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      subagent_invocation_id INTEGER,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      chunk_start_ordinal INTEGER,
      chunk_end_ordinal INTEGER,
      unprocessed_from INTEGER,
      compartments_produced INTEGER NOT NULL DEFAULT 0,
      compartment_id_min INTEGER,
      compartment_id_max INTEGER,
      facts_emitted INTEGER NOT NULL DEFAULT 0,
      facts_by_category_json TEXT,
      events_emitted INTEGER NOT NULL DEFAULT 0,
      importance_min INTEGER,
      importance_max INTEGER,
      importance_avg REAL,
      discarded_last INTEGER NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_historian_runs_session
      ON historian_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_historian_runs_status
      ON historian_runs(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tags_session_tag_number ON tags(session_id, tag_number);
    CREATE INDEX IF NOT EXISTS idx_tags_session_message_id ON tags(session_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session ON pending_ops(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session_tag_id ON pending_ops(session_id, tag_id);
    CREATE INDEX IF NOT EXISTS idx_source_contents_session ON source_contents(session_id);
    
    CREATE TABLE IF NOT EXISTS recomp_compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_compartments_session ON recomp_compartments(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_facts_session ON recomp_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_category ON memories(project_path, status, category);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_expires ON memories(project_path, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_project_category_hash ON memories(project_path, category, normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_message_history_index_updated_at ON message_history_index(updated_at);
  `);

    ensureColumn(db, "session_meta", "last_nudge_band", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "last_nudge_level", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "channel2_nudge_claimed_at", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "last_emergency_input_sample", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "last_transform_error", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_trigger_pending", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "note_nudge_trigger_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_anchors", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "session_meta", "auto_search_hint_decisions", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "session_meta", "last_todo_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_call_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_state_json", "TEXT DEFAULT ''");
    // Timestamp of last ctx_note(read) call for this session. Used by note-nudger
    // to suppress nudges when the agent has already seen notes in recent context
    // and no new notes have been created or updated since.
    ensureColumn(db, "session_meta", "note_last_read_at", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "times_execute_threshold_reached", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "observed_safe_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "cache_alert_sent", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "compartment_in_progress", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_failure_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_last_error", "TEXT DEFAULT NULL");
    ensureColumn(db, "session_meta", "historian_last_failure_at", "INTEGER DEFAULT NULL");
    ensureColumn(db, "session_meta", "system_prompt_hash", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "cleared_reasoning_through_tag", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "stripped_placeholder_ids", "TEXT DEFAULT ''");
    // Frozen replay watermark for the stale-ctx_reduce strip: message ids whose
    // ctx_reduce parts have aged past the protected window. The set only grows on
    // cache-busting passes and is replayed verbatim on defer passes, so the strip
    // never recomputes a volatile messages.length boundary that would silently
    // strip newly-aged calls mid-prefix on a defer pass (Anthropic cache bust).
    ensureColumn(db, "session_meta", "stale_reduce_stripped_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "start_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "end_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "memory_embeddings", "model_id", "TEXT");
    ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "pi_stable_id_scheme", "INTEGER");
    // JSON array of memory ids currently rendered in the cached <session-history>
    // memory block. Used by ctx_search to hard-filter memories the agent can
    // already see in context — they're wasted tokens and crowd out high-signal
    // raw-history hits.
    ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "dream_queue", "retry_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "reasoning_byte_size", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "drop_mode", "TEXT DEFAULT 'full'");
    ensureColumn(db, "tags", "tool_name", "TEXT");
    ensureColumn(db, "tags", "input_byte_size", "INTEGER DEFAULT 0");
    // Caveman compression depth applied to a tag's text part (user/assistant).
    // 0 = untouched, 1 = lite, 2 = full, 3 = ultra. Used by age-tier caveman
    // heuristic (experimental.caveman_text_compression). Source of truth for
    // the ORIGINAL pre-caveman text is source_contents.content — caveman
    // always compresses from the original, never from an already-cavemaned
    // intermediate, so repeated tier shifts converge to the target depth.
    ensureColumn(db, "tags", "caveman_depth", "INTEGER DEFAULT 0");
    // tool_owner_message_id is the third axis of tool-tag identity
    // (plan v3.3.1 / migration v10). For pre-existing rows, NULL means
    // "legacy orphan" — runtime lazy-adoption + the v10 backfill pass
    // populate it post-upgrade. Migration v10 also creates the partial
    // UNIQUE and lookup indexes; ensureColumn here covers the bare
    // column-existence path for fresh DBs and tests that bypass
    // runMigrations.
    ensureColumn(db, "tags", "tool_owner_message_id", "TEXT DEFAULT NULL");
    // Pi fallback-tag adoption: fingerprint of the raw message a tag was first
    // created for, so a later pass can migrate the tag's message_id from the
    // unstable pi-msg-* fallback to the real SessionEntry id without changing
    // tag_number (hence §N§). NULL on OpenCode and on any tag created before v27.
    ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
    db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
            ON tags(session_id, entry_fingerprint)
            WHERE type='message' AND entry_fingerprint IS NOT NULL`,
    );
    // Per-tag token counts (real Claude tokenizer), computed once when a tag is
    // first inserted and never recomputed — the content a tag covers is final on
    // first sight (assistant text is complete in history; a tool tag is created
    // only once its output is present). These supersede byte_size as the size
    // signal for token-budget consumers: the sidebar conversation/tool-call
    // breakdown and the historian protected-tail true-raw measurement both SUM
    // these instead of re-tokenizing the raw session every pass. NULL on rows
    // created before this column existed; backfilled lazily on next tag insert
    // for that session is not needed — readers treat NULL as "not yet measured"
    // and fall back per-call. byte_size stays for caveman (char-count) thresholds.
    ensureColumn(db, "tags", "token_count", "INTEGER");
    ensureColumn(db, "tags", "input_token_count", "INTEGER");
    ensureColumn(db, "tags", "reasoning_token_count", "INTEGER");
    ensureColumn(db, "session_meta", "system_prompt_tokens", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "key_files", "TEXT DEFAULT ''");
    // Token estimate of output.messages[] after transform manipulation. Used by
    // the sidebar / dashboard to split inputTokens into Conversation vs Tools
    // segments, since Anthropic's usage data rolls system + tools + messages
    // together into cache.write but we want to attribute them separately.
    ensureColumn(db, "session_meta", "conversation_tokens", "INTEGER DEFAULT 0");
    // Token estimate of tool-call parts (tool_use, tool_result, tool, tool-invocation)
    // inside messages. Separate from conversation_tokens so the sidebar can show an
    // actionable "Tool Calls" slice that users can reduce via ctx_reduce.
    ensureColumn(db, "session_meta", "tool_call_tokens", "INTEGER DEFAULT 0");
    // Partial recomp staging: when non-zero, the active recomp staging is for a
    // partial range rebuild (snapStart..snapEnd). Used to discriminate staging
    // resume between full and partial recomp, and to refuse resume if the user
    // requests a different range than what is already staged.
    ensureColumn(db, "session_meta", "recomp_partial_range_start", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "recomp_partial_range_end", "INTEGER DEFAULT 0");
    // Context limit reported by the provider in an overflow error message. When
    // non-zero, this overrides all other resolution sources (models.dev cache,
    // user config, defaults) because it's the most authoritative signal we can
    // get — the model itself told us what fits. Set by overflow event handler
    // when parseReportedLimit() extracts a number; cleared on model switch.
    ensureColumn(db, "session_meta", "detected_context_limit", "INTEGER DEFAULT 0");
    // True when the current session has hit an unrecovered context overflow
    // and needs the emergency recovery path (block at 95%, abort current
    // request, fire historian + aggressive drops) on its next transform pass.
    // Cleared once recovery succeeds.
    ensureColumn(db, "session_meta", "needs_emergency_recovery", "INTEGER DEFAULT 0");
    // Deferred compaction-marker drain (plan v6). Intentionally NO DEFAULT
    // clause — absence is SQL NULL, presence is a JSON blob. Reader must
    // filter `IS NOT NULL AND != ''`. This column MUST NOT be added to
    // `healNullTextColumns` (NULL is the load-bearing absence sentinel).
    ensureColumn(db, "session_meta", "pending_compaction_marker_state", "TEXT");
    // Pi-native deferred compaction marker queue. Intentionally NO DEFAULT;
    // NULL is the load-bearing absence sentinel and this column MUST NOT be
    // added to healNullTextColumns.
    ensureColumn(db, "session_meta", "pending_pi_compaction_marker_state", "TEXT");
    ensureColumn(db, "session_meta", "new_work_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "total_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    // Boundary-execution deferred intent (plan v8). Intentionally NO DEFAULT
    // clause — absence is SQL NULL, presence is a JSON blob. This column MUST
    // NOT be added to `healNullTextColumns`.
    ensureColumn(db, "session_meta", "deferred_execute_state", "TEXT");

    ensureColumn(db, "compartments", "p1", "TEXT");
    ensureColumn(db, "compartments", "p2", "TEXT");
    ensureColumn(db, "compartments", "p3", "TEXT");
    ensureColumn(db, "compartments", "p4", "TEXT");
    ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
    ensureColumn(db, "compartments", "episode_type", "TEXT");
    ensureColumn(db, "compartments", "p1_embedding", "BLOB");
    ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
    ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "recomp_compartments", "p1", "TEXT");
    ensureColumn(db, "recomp_compartments", "p2", "TEXT");
    ensureColumn(db, "recomp_compartments", "p3", "TEXT");
    ensureColumn(db, "recomp_compartments", "p4", "TEXT");
    ensureColumn(db, "recomp_compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
    ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
    ensureColumn(db, "memories", "importance", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
    ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
    ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
    ensureColumn(db, "session_meta", "last_usage_context_limit", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "prior_boundary_ordinal", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "session_meta", "protected_tail_policy_version", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
        db,
        "session_meta",
        "protected_tail_drain_window_started_at",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(db, "session_meta", "protected_tail_drain_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
        db,
        "session_meta",
        "recovery_no_eligible_head_count",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
        db,
        "session_meta",
        "force_emergency_bypass_window_start",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(db, "session_meta", "force_emergency_bypass_used", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
    // Pi-only: frozen baseline boundary (end_message_id) captured at
    // materialization so Pi trims against the snapshot boundary that produced
    // m[0], not a live-recomputed one a concurrent recomp could have moved.
    // Declared centrally (shared session_meta table) rather than via an ad-hoc
    // ALTER in the Pi plugin.
    ensureColumn(db, "session_meta", "cached_m0_last_baseline_end_message_id", "TEXT");
    ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_state (
        project_path TEXT PRIMARY KEY,
        project_memory_epoch INTEGER NOT NULL DEFAULT 0,
        project_user_profile_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS m0_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN (
          'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
        )),
        target_id INTEGER,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);
      CREATE TABLE IF NOT EXISTS memory_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
        target_memory_id INTEGER NOT NULL,
        superseded_by_id INTEGER,
        category TEXT,
        new_content TEXT,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
        ON memory_mutation_log(project_path, id);
      CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
        old_project_path TEXT PRIMARY KEY,
        new_project_path TEXT NOT NULL,
        rekeyed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v22_backfill_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        raw_project_path TEXT NOT NULL,
        error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
        error_message TEXT,
        failed_at INTEGER NOT NULL,
        UNIQUE(table_name, row_id)
      );
    `);

    // NULL-column healing runs as migration v5 (one-shot at schema upgrade).
    // Previously it ran on every plugin startup — each heal function issued
    // ~25 no-op UPDATE statements (one per column) against session_meta,
    // acquiring a write lock each time for zero rows on healed DBs. Moving
    // the heal into the versioned migration system means it runs exactly
    // once on affected DBs (v4 → v5 upgrade) and never again.
    // See features/magic-context/migrations.ts.

    // Plugin v0.16+ — `harness` column on every session-scoped table.
    // SQLite ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT physically backfills
    // existing rows with the default, so OpenCode users transparently get
    // harness='opencode' on all pre-existing data. Pi will be added later
    // by its own plugin entry, also writing to the same shared DB.
    //
    // We don't (yet) include harness in WHERE clauses — OpenCode session IDs
    // never collide with Pi session IDs in practice (different ID formats).
    // The column captures origin for the dashboard and unblocks future
    // cross-harness session migration. Defensive query scoping by harness
    // ships in a later commit once Pi can write to the same DB concurrently
    // and we can validate the safety property end-to-end.
    ensureColumn(db, "tags", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "pending_ops", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "source_contents", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "compression_depth", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "session_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "session_meta", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "recomp_compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "recomp_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "message_history_index", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    // notes table is created by migration v1 (not initializeDatabase). It
    // exists by the time runMigrations() returns, but ensureColumn's PRAGMA
    // table_info check needs the table to exist. Order: initializeDatabase()
    // runs before runMigrations(), so notes won't exist yet on a fresh DB
    // here. Migration v6 handles `notes` separately (see migrations.ts).
    // notes.anchor_ordinal is added by migration v29 for the same reason — it
    // cannot go here because the table doesn't exist yet on a fresh DB.
}

/**
 * Heal NULL columns added via ensureColumn against pre-existing rows.
 *
 * SQLite does NOT backfill column defaults when ALTER TABLE ADD COLUMN runs
 * on an already-populated table — old rows get NULL regardless of the
 * DEFAULT clause. isSessionMetaRow used to require strict typeof === "string"
 * / "number", which NULL fails, so rows with NULL columns were rejected,
 * getOrCreateSessionMeta returned zeroed defaults (lastResponseTime=0,
 * cacheTtl="5m"), the scheduler returned "execute" forever, and every
 * execute pass mutated message content — a sustained cache-bust cascade.
 *
 * The validator now tolerates NULL, but we normalize the data too so every
 * code path sees well-formed values. Each UPDATE is best-effort: if a column
 * doesn't exist yet (migration ran on a DB older than the ensureColumn call),
 * the UPDATE throws and we move on — the next schema upgrade runs ensureColumn
 * first, then this heal again.
 *
 * Exported so migration v5 can call it. Not exported from any barrel.
 */
export function healAllNullColumns(db: Database): void {
    healNullTextColumns(db);
    healNullIntegerColumns(db);
    healMissingMemoryBlockIds(db);
}

const CHANNEL2_CLAIM_TTL_MS = 120_000;

/**
 * Boot heal for a wedged Channel-2 ceiling-nudge lease.
 *
 * The delivery path CAS-claims `pending → claimed` before sending the synthetic
 * user message. A crash can strand that claim and burn the one-shot cap, but a
 * sibling process can also be legitimately mid-send against the shared DB. The
 * claimed_at lease timestamp is the liveness boundary: only old/legacy claims are
 * rewound to `pending`; fresh claims are left alone so boot recovery never steals
 * an in-flight delivery.
 */
function healWedgedChannel2Claims(db: Database): void {
    try {
        const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0 WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
        ).run(staleBefore);
    } catch {
        // Columns may be missing on a very fresh DB before ensureColumn/migration
        // adds them; fresh rows seed the state as '' so there is nothing to heal.
    }
}

/**
 * One-shot heal for sessions upgraded from a build without memory_block_ids.
 *
 * Those sessions have a populated memory_block_cache but no ids — ctx_search's
 * visible-memory filter then silently no-ops. Clearing the cache forces the
 * next transform pass to regenerate BOTH cache + ids in one UPDATE. The
 * regenerated block is byte-identical (renderMemoryBlock is deterministic
 * over the same memory set in stable id order), so this does NOT cause an
 * Anthropic prompt-cache bust.
 *
 * Best-effort — wrapped because the columns may not exist on a brand-new DB
 * that hasn't finished ensureColumn yet.
 */
function healMissingMemoryBlockIds(db: Database): void {
    try {
        db.prepare(
            "UPDATE session_meta SET memory_block_cache = '' WHERE memory_block_cache != '' AND (memory_block_ids IS NULL OR memory_block_ids = '') AND memory_block_count > 0",
        ).run();
    } catch {
        // Column missing on very fresh DBs — next startup reruns this after
        // ensureColumn adds the column.
    }
}

function healNullTextColumns(db: Database): void {
    const columns: Array<[string, string]> = [
        ["cache_ttl", ""],
        ["last_nudge_band", ""],
        ["last_nudge_level", ""],
        ["last_transform_error", ""],
        ["nudge_anchor_message_id", ""],
        ["nudge_anchor_text", ""],
        ["sticky_turn_reminder_text", ""],
        ["sticky_turn_reminder_message_id", ""],
        ["note_nudge_trigger_message_id", ""],
        ["note_nudge_sticky_text", ""],
        ["note_nudge_sticky_message_id", ""],
        ["last_todo_state", ""],
        ["todo_synthetic_call_id", ""],
        ["todo_synthetic_anchor_message_id", ""],
        ["todo_synthetic_state_json", ""],
        ["system_prompt_hash", ""],
        ["stripped_placeholder_ids", ""],
        ["stale_reduce_stripped_ids", ""],
        ["memory_block_cache", ""],
        ["memory_block_ids", ""],
        ["compaction_marker_state", ""],
        ["key_files", ""],
    ];
    for (const [column, fallback] of columns) {
        try {
            db.prepare(`UPDATE session_meta SET ${column} = ? WHERE ${column} IS NULL`).run(
                fallback,
            );
        } catch (_error) {
            // Ignore — the column may not exist yet on a brand-new DB that
            // hasn't gone through all ensureColumn calls yet. The heal runs
            // again on next startup.
        }
    }
}

function healNullIntegerColumns(db: Database): void {
    // INTEGER columns added via ensureColumn against pre-existing rows.
    // SQLite does not backfill the DEFAULT on ALTER TABLE, so old rows have
    // NULL. The validator tolerates null as of this release, but we still
    // normalize to 0 so subsequent reads from any path (including paths
    // that bypass toSessionMeta) see a well-formed row.
    const columns: Array<[string, number]> = [
        ["times_execute_threshold_reached", 0],
        ["compartment_in_progress", 0],
        ["historian_failure_count", 0],
        ["cleared_reasoning_through_tag", 0],
        ["memory_block_count", 0],
        ["system_prompt_tokens", 0],
        ["conversation_tokens", 0],
        ["tool_call_tokens", 0],
        ["note_nudge_trigger_pending", 0],
        ["observed_safe_input_tokens", 0],
        ["cache_alert_sent", 0],
        ["new_work_tokens", 0],
        ["total_input_tokens", 0],
        ["last_emergency_input_sample", 0],
        ["channel2_nudge_claimed_at", 0],
        ["last_usage_context_limit", 0],
        ["prior_boundary_ordinal", 1],
        ["protected_tail_policy_version", 0],
        ["protected_tail_drain_window_started_at", 0],
        ["protected_tail_drain_tokens", 0],
        ["recovery_no_eligible_head_count", 0],
        ["force_emergency_bypass_window_start", 0],
        ["force_emergency_bypass_used", 0],
    ];
    for (const [column, fallback] of columns) {
        try {
            db.prepare(`UPDATE session_meta SET ${column} = ? WHERE ${column} IS NULL`).run(
                fallback,
            );
        } catch (_error) {
            // Same rationale as the text heal — swallow missing-column errors
            // on brand-new DBs; next startup reruns this.
        }
    }
}

// Intentional: the definition regex allows single quotes and parens because SQLite column
// defaults use them (e.g. TEXT DEFAULT '', INTEGER DEFAULT 0). All callsites pass hardcoded
// string literals — no user input reaches this function, so the regex is sufficient.
export function ensureColumn(
    db: Database,
    table: string,
    column: string,
    definition: string,
): void {
    if (
        !/^[a-z][a-z0-9_]*$/.test(table) ||
        !/^[a-z][a-z0-9_]*$/.test(column) ||
        !/^[A-Z0-9_'(),[\]\s]+$/i.test(definition)
    ) {
        throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
    }
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) {
        return;
    }
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
        const recheck = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
        if (recheck.some((row) => row.name === column)) {
            return;
        }
        throw err;
    }
}

/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened (binary ABI mismatch,
 * unwritable path, corrupted file, etc.), this throws. Magic Context CANNOT
 * silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi/OpenCode this can let the full
 *      raw history reach the model and overflow the context window — the
 *      exact failure mode that broke a real test session.
 *
 * Two failure modes, both fail-closed:
 *   - **Schema fence** (the on-disk DB is newer than this binary supports, e.g.
 *     a stale process after a rolling upgrade): returns `null`. This is an
 *     expected, recoverable condition (restart onto the newer binary), so it is
 *     not exceptional.
 *   - **Fatal open error** (ABI mismatch, unwritable path, corrupt file):
 *     throws. The thrown message carries the failure detail for surfacing.
 *
 * The return type is therefore `Database | null`, and callers MUST both
 * null-check the result AND be prepared for a throw (typically a try/catch that
 * also treats a null result as "storage unavailable"). On either outcome the
 * caller disables Magic Context for that run (server plugin: registers a
 * startup warning + skips the runtime; Pi plugin: logs warning + skips the
 * extension). There is NEVER a silent in-memory fallback.
 */
export function openDatabase(): Database | null;
export function openDatabase(dbPath: string): Database | null;
export function openDatabase(options: OpenDatabaseOptions): Database | null;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database | null {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const explicitDbPath = options?.dbPath !== undefined;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    const existing = databases.get(dbPath);
    if (existing) {
        if (!enforceSchemaFence(existing, dbPath, latestSupportedVersion)) {
            return null;
        }
        if (!persistenceByDatabase.has(existing)) {
            persistenceByDatabase.set(existing, true);
        }
        // Re-run the TTL-scoped lease heal on cache hits too. Long-lived
        // processes keep this handle for hours, and a revert/confirm DB lock can
        // leave a stale `claimed` lease behind until some later openDatabase()
        // call. The heal is one idempotent UPDATE gated by claimed_at age.
        healWedgedChannel2Claims(existing);
        return existing;
    }

    try {
        if (!explicitDbPath) {
            migrateLegacyStorageIfNeeded(dbPath, dbDir);
        }
        ensureSecureStorageDir(dbDir);

        const db = new Database(dbPath);
        if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        initializeDatabase(db);
        runMigrations(db);
        if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        if (!explicitDbPath) {
            try {
                deleteOrphanProjectKeyFiles(db);
            } catch (error) {
                log(`[magic-context] key-files orphan GC failed: ${getErrorMessage(error)}`);
            }
        }
        // Recover any Channel-2 ceiling-nudge lease left at `claimed` by a crash
        // mid-delivery (see healWedgedChannel2Claims). Fresh opens and later
        // cached-handle reuses both run this TTL-scoped heal so long-lived
        // processes eventually unwind stuck stale claims without a restart.
        healWedgedChannel2Claims(db);
        // Tool-owner backfill (plan v3.3.1, Layer B). Runs once per
        // boot to populate tool_owner_message_id on legacy tool tags.
        // The backfill module short-circuits when no work is needed
        // (every session has either backfilled rows or is already
        // marked completed/skipped), so re-running is cheap.
        //
        // The backfill is best-effort: missing OpenCode DB, transient
        // SQLite errors, and per-session failures are logged but
        // never fail-close the plugin. Lazy adoption (Layer C) covers
        // any rows the backfill couldn't reach.
        if (!explicitDbPath) {
            try {
                runToolOwnerBackfill(db);
            } catch (error) {
                log(
                    `[magic-context] tool-owner backfill failed (continuing with lazy adoption fallback): ${getErrorMessage(error)}`,
                );
            }
        }
        // Wire the persistence-backed tool-definition measurement store and
        // rehydrate the in-memory map from any prior writes. Doing this here
        // (after migrations) means migration v9 has already created the
        // `tool_definition_measurements` table, so loadToolDefinitionMeasurements
        // never hits a missing-table failure path. See bug #2 in the v0.16+
        // sidebar regression report.
        setToolDefinitionDatabase(db);
        loadToolDefinitionMeasurements(db);
        // Tighten the DB + WAL/SHM sidecars to owner-only now that WAL mode has
        // created the sidecars; best-effort, never fatal.
        restrictDatabaseFilePermissions(dbPath);
        databases.set(dbPath, db);
        persistenceByDatabase.set(db, true);
        persistenceErrorByDatabase.delete(db);
        return db;
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        // No silent in-memory fallback — see comment above. Caller must
        // catch and disable Magic Context for that run.
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

export function isDatabasePersisted(db: Database | null): boolean {
    if (!db) return false;
    return persistenceByDatabase.get(db) ?? false;
}

export function getDatabasePersistenceError(db: Database | null): string | null {
    if (!db) return null;
    return persistenceErrorByDatabase.get(db) ?? null;
}

export function closeDatabase(): void {
    for (const [key, db] of databases) {
        try {
            closeQuietly(db);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = Database;
