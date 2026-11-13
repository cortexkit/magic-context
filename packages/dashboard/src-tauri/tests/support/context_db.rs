//! Throwaway `context.db` stores for the dashboard's tests.
//!
//! ck-mc builds its test stores from the plugin's last fresh schema
//! (`crates/mc-module/testdata/context-schema.sql`, version 105) with its own
//! migrations applied on top. The dashboard is a separate crate that can't
//! call ck-mc's migration code, so this file runs migration 106 from a copy of
//! its SQL, taken from `crates/mc-module/src/context_migrations.rs`, in the
//! order ck-mc runs it. `copied_ddl_is_the_module_migration` in
//! `tests/schema_compatibility.rs` fails when the copy and ck-mc's migration
//! drift apart.
#![allow(dead_code)]

use rusqlite::Connection;
use std::path::Path;

/// The plugin's last fresh schema, the base ck-mc's own test stores start from.
pub const PLUGIN_SCHEMA: &str =
    include_str!("../../../../../crates/mc-module/testdata/context-schema.sql");

/// ck-mc's migrations, which the copies below must match.
pub const MODULE_MIGRATIONS: &str =
    include_str!("../../../../../crates/mc-module/src/context_migrations.rs");

/// The columns of the leveled `memories` table, after the identity column.
pub const MEMORY_COLUMNS: &str = "
    level TEXT NOT NULL CHECK (level IN ('global', 'workspace', 'project', 'agent')),
    owner_id TEXT NOT NULL,
    category TEXT NOT NULL,
    origin_category TEXT NOT NULL,
    origin_profile TEXT,
    origin_profile_version TEXT,
    origin_profile_digest TEXT,
    content TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    importance INTEGER,
    scope TEXT NOT NULL DEFAULT 'project',
    shareable INTEGER NOT NULL DEFAULT 0,
    source_project_id TEXT,
    source_session_id TEXT,
    source_type TEXT DEFAULT 'historian',
    source_agent_id TEXT,
    source_ordinals_json TEXT,
    applies_to_json TEXT,
    overrides_memory_id INTEGER,
    overrides_revision INTEGER,
    authority TEXT NOT NULL DEFAULT 'learned' CHECK (authority IN ('learned', 'policy')),
    epistemic TEXT CHECK (epistemic IS NULL OR epistemic IN ('confirmed', 'claimed')),
    decay_class TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
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
    classified_at INTEGER,
    superseded_by_memory_id INTEGER,
    merged_from TEXT,
    metadata_json TEXT,
    mural_cue TEXT,
    mural_cue_hash TEXT,
    mural_cue_at INTEGER,
    mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
    safety_critical INTEGER CHECK (safety_critical IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1,
    verify_result TEXT,
    verify_files_json TEXT,
    verify_commit TEXT";

/// Which memories are live, and so unique for their owner, category and text.
pub const LIVE: &str = "(status IS NULL OR status IN ('active', 'permanent'))";

/// The migration's statements, in order, as they read in ck-mc's source:
/// `{MEMORY_COLUMNS}` and `{LIVE}` stand for the constants above. Each entry
/// is one stretch of a single SQL string there, so it can be found whole.
pub const MIGRATION_106: [&str; 9] = [
    "DROP TRIGGER IF EXISTS memories_authority_guard_insert;
         DROP TRIGGER IF EXISTS memories_authority_guard_update;
         DROP TRIGGER IF EXISTS memories_authority_guard_delete;
         DROP TRIGGER IF EXISTS memories_ai;
         DROP TRIGGER IF EXISTS memories_ad;
         DROP TRIGGER IF EXISTS memories_au;
         DROP TABLE IF EXISTS memories_fts;
         DROP TABLE IF EXISTS memories_v106;",
    "CREATE TABLE memories_v106 (id INTEGER PRIMARY KEY AUTOINCREMENT, {MEMORY_COLUMNS});",
    "DROP TABLE memories;
         ALTER TABLE memories_v106 RENAME TO memories;
         CREATE UNIQUE INDEX idx_memories_owner_key
             ON memories(level, owner_id, category, normalized_hash) WHERE {LIVE};
         CREATE INDEX idx_memories_owner_status ON memories(level, owner_id, status);
         CREATE INDEX idx_memories_owner_status_expires
             ON memories(level, owner_id, status, expires_at);
         CREATE INDEX idx_memories_owner_origin_category
             ON memories(owner_id, status, origin_category);",
    "CREATE VIRTUAL TABLE memories_fts USING fts5(
             content,
             origin_category,
             content='memories',
             content_rowid='id',
             tokenize='porter unicode61'
         );
         INSERT INTO memories_fts(rowid, content, origin_category)
             SELECT id, content, origin_category FROM memories WHERE level <> 'global';
         CREATE TRIGGER memories_ai AFTER INSERT ON memories WHEN new.level <> 'global' BEGIN
             INSERT INTO memories_fts(rowid, content, origin_category)
             VALUES (new.id, new.content, new.origin_category);
         END;
         CREATE TRIGGER memories_ad AFTER DELETE ON memories WHEN old.level <> 'global' BEGIN
             INSERT INTO memories_fts(memories_fts, rowid, content, origin_category)
             VALUES ('delete', old.id, old.content, old.origin_category);
         END;",
    "CREATE TRIGGER memories_au AFTER UPDATE OF content, origin_category, level ON memories BEGIN
             INSERT INTO memories_fts(memories_fts, rowid, content, origin_category)
             SELECT 'delete', old.id, old.content, old.origin_category WHERE old.level <> 'global';
             INSERT INTO memories_fts(rowid, content, origin_category)
             SELECT new.id, new.content, new.origin_category WHERE new.level <> 'global';
         END;",
    "CREATE TABLE IF NOT EXISTS memory_observations (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             content TEXT NOT NULL,
             proposed_category TEXT,
             origin_profile TEXT,
             origin_profile_version TEXT,
             origin_profile_digest TEXT,
             session_id TEXT NOT NULL,
             agent_id TEXT,
             project_id TEXT,
             workspace_id TEXT,
             -- The session's message ordinals the observation came from.
             source_start_ordinal INTEGER,
             source_end_ordinal INTEGER,
             created_at INTEGER NOT NULL,
             consumed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_memory_observations_pending
             ON memory_observations(consumed_at, created_at);",
    "DROP TABLE user_memory_candidates;",
    "DROP TABLE IF EXISTS memory_placement;
         DROP TABLE IF EXISTS memory_mutation_log;
         DROP TABLE IF EXISTS user_memories;",
    "ALTER TABLE project_state DROP COLUMN project_user_profile_version;",
];

/// How ck-mc describes migration 106 in the store's migration history.
pub const MIGRATION_106_DESCRIPTION: &str = "memory levels, owners and profile categories";

/// The columns copied unchanged from the plugin's `memories` table.
pub const KEPT_COLUMNS: &str = "id, content, normalized_hash, importance, scope, shareable,
    source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at,
    updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status,
    verified_at, classified_at, superseded_by_memory_id, merged_from, metadata_json, mural_cue,
    mural_cue_hash, mural_cue_at, mural_cue_rejection_count, safety_critical, revision,
    verify_result, verify_files_json, verify_commit";

/// Copies every plugin memory into the leveled table. `{case}` stands for
/// the `CASE` that maps the tag in `m.category` to its category id.
pub const COPY_MEMORIES: &str =
    "INSERT INTO memories_v106 ({KEPT_COLUMNS}, level, owner_id, category, origin_category,
             origin_profile, origin_profile_version, origin_profile_digest, source_project_id,
             applies_to_json)
         SELECT m.id, m.content, m.normalized_hash, m.importance, m.scope, m.shareable,
             m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at,
             m.created_at, m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status,
             m.expires_at, m.verification_status, m.verified_at, m.classified_at,
             m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.mural_cue,
             m.mural_cue_hash, m.mural_cue_at, m.mural_cue_rejection_count, m.safety_critical,
             m.revision, m.verify_result, m.verify_files_json, m.verify_commit,
             COALESCE(p.level, 'project'), COALESCE(p.owner_id, m.project_path),
             COALESCE(p.origin_category, {case}), m.category,
             p.origin_profile_name, p.origin_profile_version, p.origin_profile_digest,
             m.project_path, p.applies_to_json
           FROM memories m LEFT JOIN memory_placement p ON p.memory_id = m.id;";

/// Keeps new rows from reusing the id of a memory deleted before the move;
/// `?1` is the old table's sequence.
pub const KEEP_SEQUENCE: &str =
    "UPDATE sqlite_sequence SET seq = MAX(seq, ?1) WHERE name = 'memories_v106'";

/// Files one user memory as a global memory.
pub const MOVE_USER_MEMORY: &str = "INSERT INTO memories_v106 (level, owner_id, category, origin_category, content,
                 normalized_hash, source_type, seen_count, retrieval_count, first_seen_at,
                 created_at, updated_at, last_seen_at, status, metadata_json)
             VALUES ('global', 'self', ?1, ?2, ?3, ?4, 'user-review', 1, 0, ?5, ?6, ?7, ?5, ?8, ?9)";

/// Turns user-memory candidates into observations.
pub const COPY_OBSERVATIONS: &str =
    "INSERT INTO memory_observations (id, content, session_id, source_start_ordinal,
                 source_end_ordinal, created_at)
             SELECT id, content, session_id, source_compartment_start, source_compartment_end,
                    created_at
               FROM user_memory_candidates;";

/// The tag-to-category map the migration froze.
pub const CATEGORY_IDS: [(&str, &str); 12] = [
    ("PROJECT_RULES", "swe:project-rules"),
    ("ARCHITECTURE", "swe:architecture"),
    ("CONSTRAINTS", "swe:constraints"),
    ("CONFIG_VALUES", "swe:config-values"),
    ("NAMING", "swe:naming"),
    ("USER_DIRECTIVES", "swe:project-rules"),
    ("USER_PREFERENCES", "swe:project-rules"),
    ("CONFIG_DEFAULTS", "swe:config-values"),
    ("ARCHITECTURE_DECISIONS", "swe:architecture"),
    ("ENVIRONMENT", "swe:config-values"),
    ("WORKFLOW_RULES", "swe:project-rules"),
    ("KNOWN_ISSUES", "swe:constraints"),
];

/// One of the templates above with its stand-ins filled in.
fn statement(template: &str) -> String {
    let case: String = CATEGORY_IDS
        .iter()
        .map(|(tag, id)| format!(" WHEN '{tag}' THEN '{id}'"))
        .collect();
    template
        .replace("{MEMORY_COLUMNS}", MEMORY_COLUMNS)
        .replace("{LIVE}", LIVE)
        .replace("{KEPT_COLUMNS}", KEPT_COLUMNS)
        .replace(
            "{case}",
            &format!("CASE m.category{case} ELSE 'mc:unmapped' END"),
        )
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |row| row.get(0),
    )
    .expect("look a table up")
}

/// Migration 106 on a store at the plugin's last version, step for step as
/// ck-mc runs it, recorded in the migration history as ck-mc records it.
/// Only ck-mc's check that no reference to a memory was lost is left out.
pub fn upgrade_plugin_store(conn: &Connection) {
    // ck-mc switches foreign keys off around the rebuild, so dropping the old
    // table can't cascade into the tables that reference it.
    conn.execute_batch("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;")
        .expect("begin the migration");
    let run = |template: &str| {
        conn.execute_batch(&statement(template))
            .unwrap_or_else(|error| panic!("{error}: {template}"))
    };
    run(MIGRATION_106[0]);
    run(MIGRATION_106[1]);
    run(COPY_MEMORIES);
    let sequence: Option<i64> = conn
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'memories'",
            [],
            |row| row.get(0),
        )
        .ok();
    if let Some(sequence) = sequence {
        conn.execute(KEEP_SEQUENCE, [sequence])
            .expect("keep the sequence");
    }
    if table_exists(conn, "user_memories") {
        move_user_memories(conn);
    }
    run(MIGRATION_106[2]);
    run(MIGRATION_106[3]);
    run(MIGRATION_106[4]);
    run(MIGRATION_106[5]);
    if table_exists(conn, "user_memory_candidates") {
        run(COPY_OBSERVATIONS);
        run(MIGRATION_106[6]);
    }
    run(MIGRATION_106[7]);
    let profile_version: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('project_state')
              WHERE name = 'project_user_profile_version'",
            [],
            |row| row.get(0),
        )
        .expect("look the profile version up");
    if profile_version {
        run(MIGRATION_106[8]);
    }
    conn.execute(
        "INSERT INTO schema_migrations(version, description, applied_at) VALUES (106, ?1, 0)",
        [MIGRATION_106_DESCRIPTION],
    )
    .expect("record the migration");
    conn.execute_batch("COMMIT;").expect("commit the migration");
}

/// User memories become global memories that keep their old id and
/// promotion time in `metadata_json`, oldest promotion first.
fn move_user_memories(conn: &Connection) {
    type UserMemory = (
        i64,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        i64,
        i64,
    );
    let rows: Vec<UserMemory> = conn
        .prepare(
            "SELECT id, content, status, promoted_at, source_candidate_ids,
                    source_candidate_provenance, created_at, updated_at
               FROM user_memories ORDER BY promoted_at ASC, id ASC",
        )
        .expect("read user memories")
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .expect("read user memories")
        .collect::<rusqlite::Result<_>>()
        .expect("read user memories");
    for (id, content, status, promoted_at, candidate_ids, provenance, created_at, updated_at) in
        rows
    {
        let mut metadata = serde_json::json!({ "user_memory_id": id, "promoted_at": promoted_at });
        if let Some(ids) = candidate_ids.as_deref() {
            metadata["source_candidate_ids"] =
                serde_json::from_str(ids).unwrap_or(serde_json::Value::String(ids.to_owned()));
        }
        if let Some(provenance) = provenance {
            metadata["source_candidate_provenance"] = serde_json::Value::String(provenance);
        }
        conn.execute(
            MOVE_USER_MEMORY,
            rusqlite::params![
                "mc:user-unsorted",
                "USER_MEMORY",
                content,
                normalized_hash(&content),
                promoted_at,
                created_at,
                updated_at,
                status,
                metadata.to_string(),
            ],
        )
        .expect("move a user memory");
    }
}

/// A store at the plugin's last version, 105: what ck-mc migrates the first
/// time it opens a store.
pub fn create_plugin_context_db(path: &Path) {
    Connection::open(path)
        .expect("open the throwaway store")
        .execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .expect("plugin schema");
}

/// A store at version 106, the version the dashboard reads.
pub fn create_test_context_db(path: &Path) {
    build(&Connection::open(path).expect("open the throwaway store"));
}

/// [`create_test_context_db`] in memory.
pub fn context_db_in_memory() -> Connection {
    let conn = Connection::open_in_memory().expect("open an in-memory store");
    build(&conn);
    conn
}

fn build(conn: &Connection) {
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .expect("plugin schema");
    upgrade_plugin_store(conn);
}

/// Insert a project memory row the way ck-mc files one written under `tag`
/// for `project`, and return its id.
pub fn insert_project_memory(
    conn: &Connection,
    project: &str,
    tag: &str,
    content: &str,
    status: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content,
             normalized_hash, source_type, importance, scope, shareable, status,
             first_seen_at, created_at, updated_at, last_seen_at, source_project_id)
         VALUES ('project', ?1, ?2, ?3, ?4, ?5, 'agent', 50, 'project', 0, ?6, 1, 1, 1, 1, ?1)",
        rusqlite::params![
            project,
            category_id(tag),
            tag,
            content,
            normalized_hash(content),
            status
        ],
    )
    .expect("insert a project memory");
    conn.last_insert_rowid()
}

/// The profile category ck-mc's migration gives a tag.
pub fn category_id(tag: &str) -> &'static str {
    CATEGORY_IDS
        .iter()
        .find(|(known, _)| *known == tag)
        .map_or("mc:unmapped", |(_, id)| *id)
}

/// The plugin's duplicate key of a memory's text: MD5 of the lowercased text
/// with whitespace runs collapsed. It treats U+0085 and U+FEFF differently
/// from the plugin's JavaScript whitespace; test texts don't use either.
pub fn normalized_hash(content: &str) -> String {
    let normalized = content
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!("{:032x}", md5::compute(normalized.as_bytes()))
}
