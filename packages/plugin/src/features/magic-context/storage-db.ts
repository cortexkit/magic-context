import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getOpenCodeStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { runMigrations } from "./migrations";

const databases = new Map<string, Database>();
const FALLBACK_DATABASE_KEY = "__fallback__:memory:";
const persistenceByDatabase = new WeakMap<Database, boolean>();
const persistenceErrorByDatabase = new WeakMap<Database, string>();

function resolveDatabasePath(): { dbDir: string; dbPath: string } {
    const dbDir = join(getOpenCodeStorageDir(), "plugin", "magic-context");
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

export function initializeDatabase(db: Database): void {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA foreign_keys=ON");
    db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER,
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
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id);

    CREATE TABLE IF NOT EXISTS compression_depth (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, message_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_compression_depth_session ON compression_depth(session_id);

    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS smart_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      content TEXT NOT NULL,
      surface_condition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      ready_at INTEGER,
      ready_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_smart_notes_project_status ON smart_notes(project_path, status);

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
      updated_at INTEGER NOT NULL
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
      memory_block_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tags_session_tag_number ON tags(session_id, tag_number);
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
      UNIQUE(session_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_compartments_session ON recomp_compartments(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_facts_session ON recomp_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes(session_id);
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
    ensureColumn(db, "dream_queue", "retry_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "reasoning_byte_size", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "drop_mode", "TEXT DEFAULT 'full'");
    ensureColumn(db, "tags", "tool_name", "TEXT");
    ensureColumn(db, "tags", "input_byte_size", "INTEGER DEFAULT 0");
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

    // One-time heal: when ensureColumn adds a new TEXT DEFAULT '' or
    // INTEGER DEFAULT N column, SQLite leaves pre-existing rows with NULL
    // instead of applying the DEFAULT. isSessionMetaRow used to check
    // `typeof === "string"` / `"number"` strictly (null fails), so rows
    // with NULL columns were rejected → getOrCreateSessionMeta returned
    // defaults (lastResponseTime=0, cacheTtl="5m") → scheduler always
    // returned "execute" → applyPendingOperations re-ran forever → each
    // execute pass mutated message content → sustained cache-bust cascade.
    // The defensive validator now accepts null, but we also heal the data
    // for good measure (belt and suspenders — failures here are non-fatal).
    healNullTextColumns(db);
    healNullIntegerColumns(db);
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
        ["system_prompt_hash", ""],
        ["stripped_placeholder_ids", ""],
        ["memory_block_cache", ""],
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
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createFallbackDatabase(): Database {
    try {
        const fallback = new Database(":memory:");
        initializeDatabase(fallback);
        runMigrations(fallback);
        return fallback;
    } catch (error) {
        throw new Error(
            `[magic-context] storage fatal: failed to initialize fallback database: ${getErrorMessage(error)}`,
        );
    }
}

export function openDatabase(): Database {
    try {
        const { dbDir, dbPath } = resolveDatabasePath();
        const existing = databases.get(dbPath);
        if (existing) {
            if (!persistenceByDatabase.has(existing)) {
                persistenceByDatabase.set(existing, true);
            }
            return existing;
        }

        mkdirSync(dbDir, { recursive: true });

        const db = new Database(dbPath);
        initializeDatabase(db);
        runMigrations(db);
        databases.set(dbPath, db);
        persistenceByDatabase.set(db, true);
        persistenceErrorByDatabase.delete(db);
        return db;
    } catch (error) {
        log("[magic-context] storage error:", error);
        const errorMessage = getErrorMessage(error);
        const existingFallback = databases.get(FALLBACK_DATABASE_KEY);
        if (existingFallback) {
            if (!persistenceByDatabase.has(existingFallback)) {
                persistenceByDatabase.set(existingFallback, false);
                persistenceErrorByDatabase.set(existingFallback, errorMessage);
            }
            return existingFallback;
        }

        const fallback = createFallbackDatabase();
        databases.set(FALLBACK_DATABASE_KEY, fallback);
        persistenceByDatabase.set(fallback, false);
        persistenceErrorByDatabase.set(fallback, errorMessage);
        return fallback;
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
            db.close(false);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = ReturnType<typeof openDatabase>;
