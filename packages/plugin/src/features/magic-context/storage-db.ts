import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

function resolveDatabasePath(): { dbDir: string; dbPath: string } {
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
    mkdirSync(targetDbDir, { recursive: true });

    // Copy main DB + WAL/SHM sidecars. WAL mode keeps uncheckpointed writes in
    // -wal; if the OpenCode plugin was running when the user upgraded, real
    // data could be in -wal only. Same for -shm shared memory metadata.
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

export function initializeDatabase(db: Database): void {
    // SQLite per-connection PRAGMAs. foreign_keys MUST run before any reads
    // or writes: it defaults to OFF, which silently breaks every ON DELETE
    // CASCADE / SET NULL declared in the schema below and in migrations.
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
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
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id);

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
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      note_nudge_trigger_pending INTEGER DEFAULT 0,
      note_nudge_trigger_message_id TEXT DEFAULT '',
      note_nudge_sticky_text TEXT DEFAULT '',
      note_nudge_sticky_message_id TEXT DEFAULT '',
      last_todo_state TEXT DEFAULT '',
      todo_synthetic_call_id TEXT DEFAULT '',
      todo_synthetic_anchor_message_id TEXT DEFAULT '',
      todo_synthetic_state_json TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
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
      -- deferred_execute_state: intentionally NULLABLE without a default.
      -- Absence is SQL NULL; presence is a JSON blob written via
      -- setDeferredExecutePendingIfAbsent. Excluded from healNullTextColumns.
      deferred_execute_state TEXT
    );

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
    ensureColumn(db, "session_meta", "last_transform_error", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_trigger_pending", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "note_nudge_trigger_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "last_todo_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_call_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_state_json", "TEXT DEFAULT ''");
    // Timestamp of last ctx_note(read) call for this session. Used by note-nudger
    // to suppress nudges when the agent has already seen notes in recent context
    // and no new notes have been created or updated since.
    ensureColumn(db, "session_meta", "note_last_read_at", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "times_execute_threshold_reached", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "compartment_in_progress", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_failure_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_last_error", "TEXT DEFAULT NULL");
    ensureColumn(db, "session_meta", "historian_last_failure_at", "INTEGER DEFAULT NULL");
    ensureColumn(db, "session_meta", "system_prompt_hash", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "cleared_reasoning_through_tag", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "stripped_placeholder_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "start_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "end_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "memory_embeddings", "model_id", "TEXT");
    ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
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
    // Boundary-execution deferred intent (plan v8). Intentionally NO DEFAULT
    // clause — absence is SQL NULL, presence is a JSON blob. This column MUST
    // NOT be added to `healNullTextColumns`.
    ensureColumn(db, "session_meta", "deferred_execute_state", "TEXT");

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
function ensureColumn(db: Database, table: string, column: string, definition: string): void {
    if (
        !/^[a-z_]+$/.test(table) ||
        !/^[a-z_]+$/.test(column) ||
        !/^[A-Z0-9_'(),\s]+$/i.test(definition)
    ) {
        throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
    }
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) {
        return;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
 * Callers must catch this error and disable Magic Context for that run
 * (server plugin: registers a startup warning + skips the runtime;
 * Pi plugin: logs warning + skips the extension).
 */
export function openDatabase(): Database {
    const { dbDir, dbPath } = resolveDatabasePath();
    const existing = databases.get(dbPath);
    if (existing) {
        if (!persistenceByDatabase.has(existing)) {
            persistenceByDatabase.set(existing, true);
        }
        return existing;
    }

    try {
        migrateLegacyStorageIfNeeded(dbPath, dbDir);
        mkdirSync(dbDir, { recursive: true });

        const db = new Database(dbPath);
        initializeDatabase(db);
        runMigrations(db);
        try {
            deleteOrphanProjectKeyFiles(db);
        } catch (error) {
            log(`[magic-context] key-files orphan GC failed: ${getErrorMessage(error)}`);
        }
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
        try {
            runToolOwnerBackfill(db);
        } catch (error) {
            log(
                `[magic-context] tool-owner backfill failed (continuing with lazy adoption fallback): ${getErrorMessage(error)}`,
            );
        }
        // Wire the persistence-backed tool-definition measurement store and
        // rehydrate the in-memory map from any prior writes. Doing this here
        // (after migrations) means migration v9 has already created the
        // `tool_definition_measurements` table, so loadToolDefinitionMeasurements
        // never hits a missing-table failure path. See bug #2 in the v0.16+
        // sidebar regression report.
        setToolDefinitionDatabase(db);
        loadToolDefinitionMeasurements(db);
        databases.set(dbPath, db);
        persistenceByDatabase.set(db, true);
        persistenceErrorByDatabase.delete(db);
        return db;
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        // No silent in-memory fallback — see comment above. Caller must
        // catch and disable Magic Context for this run.
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

export function isDatabasePersisted(db: Database): boolean {
    return persistenceByDatabase.get(db) ?? false;
}

export function getDatabasePersistenceError(db: Database): string | null {
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

export type ContextDatabase = ReturnType<typeof openDatabase>;
