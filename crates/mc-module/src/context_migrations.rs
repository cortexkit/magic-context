//! The module's own migrations of `context.db`.
//!
//! Up to version 105 the standalone plugin owned the schema (its
//! `migrations.ts`), and ck-mc only checked the version. 0.49 is the last
//! plugin line, so from 106 on the module migrates the store itself. A store
//! below the plugin's last version is refused, as before: carrying an older
//! store forward is separate work.
//!
//! Each migration runs in its own `BEGIN IMMEDIATE` transaction and records
//! itself in `schema_migrations`, the table the plugin's migrations use, so
//! the version check in [`crate::context_db`] reads one history.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::memory_writes::normalized_hash;

/// The last schema version the plugin's migrations produced.
pub const PLUGIN_SCHEMA_VERSION: u32 = crate::context_db::PLUGIN_SCHEMA_VERSION;

/// The schema version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 106;

struct Migration {
    version: u32,
    description: &'static str,
    /// The migration rebuilds a table that other tables reference with
    /// `ON DELETE CASCADE`. Foreign keys are switched off around it, because
    /// dropping the old table would otherwise delete the referencing rows.
    /// The pragma can't change inside a transaction, so it is set outside.
    rebuilds_referenced_table: bool,
    up: fn(&Transaction) -> rusqlite::Result<()>,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 106,
    description: "memory levels, owners and profile categories",
    rebuilds_referenced_table: true,
    up: memory_levels_106,
}];

/// Apply every pending migration to a store at `found`. Returns the version
/// the store is at afterwards. A store below [`PLUGIN_SCHEMA_VERSION`] or
/// above [`SCHEMA_VERSION`] is refused untouched.
pub(crate) fn upgrade(connection: &mut Connection, found: i64) -> Result<i64, String> {
    if found == i64::from(SCHEMA_VERSION) {
        return Ok(found);
    }
    if found < i64::from(PLUGIN_SCHEMA_VERSION) || found > i64::from(SCHEMA_VERSION) {
        return Err(format!(
            "schema version {found}; this ck-mc reads version {SCHEMA_VERSION} and migrates from {PLUGIN_SCHEMA_VERSION}"
        ));
    }
    let mut at = found;
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| i64::from(migration.version) > found)
    {
        apply(connection, migration)
            .map_err(|error| format!("migration {}: {error}", migration.version))?;
        tracing::info!(
            "ck-mc: context.db migrated to version {} ({})",
            migration.version,
            migration.description
        );
        at = i64::from(migration.version);
    }
    Ok(at)
}

fn apply(connection: &mut Connection, migration: &Migration) -> rusqlite::Result<()> {
    let foreign_keys: bool = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if migration.rebuilds_referenced_table && foreign_keys {
        connection.execute_batch("PRAGMA foreign_keys=OFF")?;
    }
    let outcome = (|| {
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Another process may have applied it while this one waited for the lock.
        let done: Option<i64> = tx
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = ?1",
                [migration.version],
                |row| row.get(0),
            )
            .optional()?;
        if done.is_some() {
            return tx.commit();
        }
        (migration.up)(&tx)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, ?2, ?3)",
            params![migration.version, migration.description, now_ms()],
        )?;
        tx.commit()
    })();
    if migration.rebuilds_referenced_table && foreign_keys {
        connection.execute_batch("PRAGMA foreign_keys=ON")?;
    }
    outcome
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The profile category each tag a memory was written under maps to. Frozen
/// here, not read from the bundled profile, so the migration means the same
/// thing whatever the profile later says: it is the coding profile's
/// `category_map` as it stood when memories had only tags.
const CATEGORY_IDS: [(&str, &str); 12] = [
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

/// The category of a tag no profile maps. Magic Context's own; no profile
/// writes an `mc:` id.
pub const UNMAPPED_CATEGORY: &str = "mc:unmapped";

/// The category today's user memories move into. Reserved: only this
/// migration writes it, and the global review files each row into a real
/// category on its first run.
pub const USER_UNSORTED_CATEGORY: &str = "mc:user-unsorted";

/// The tag a moved user memory keeps as its origin category.
pub const USER_MEMORY_TAG: &str = "USER_MEMORY";

/// The SQL `CASE` that maps a tag column to its category id.
fn category_case(column: &str) -> String {
    let arms: String = CATEGORY_IDS
        .iter()
        .map(|(tag, id)| format!(" WHEN '{tag}' THEN '{id}'"))
        .collect();
    format!("CASE {column}{arms} ELSE '{UNMAPPED_CATEGORY}' END")
}

/// The columns of the leveled `memories` table, after the identity columns.
const MEMORY_COLUMNS: &str = "
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

/// The columns copied unchanged from the plugin's `memories` table.
const KEPT_COLUMNS: &str = "id, content, normalized_hash, importance, scope, shareable,
    source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at,
    updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status,
    verified_at, classified_at, superseded_by_memory_id, merged_from, metadata_json, mural_cue,
    mural_cue_hash, mural_cue_at, mural_cue_rejection_count, safety_critical, revision,
    verify_result, verify_files_json, verify_commit";

/// A memory is live while it is active or permanent. Only live memories must
/// be unique for their owner, category and text: mapping twelve tags onto
/// five categories makes some archived history rows repeat, and every writer
/// looks a row up before it adds one.
const LIVE: &str = "(status IS NULL OR status IN ('active', 'permanent'))";

/// Rows in tables that reference `memories(id)` whose memory doesn't exist.
/// An old store may already hold some, written while foreign keys were off,
/// so the rebuild is checked against the count it started with.
fn dangling_memory_references(tx: &Transaction) -> rusqlite::Result<i64> {
    let tables: Vec<String> = tx
        .prepare(
            "SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
              WHERE m.type = 'table' AND f.\"table\" = 'memories'",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut dangling = 0;
    for table in tables {
        dangling += tx.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check(?1)",
            [&table],
            |row| row.get::<_, i64>(0),
        )?;
    }
    Ok(dangling)
}

fn memory_levels_106(tx: &Transaction) -> rusqlite::Result<()> {
    let dangling_before = dangling_memory_references(tx)?;
    // The guards belong to the removed Rust transform mode; the triggers and
    // the search index are rebuilt for the new table below.
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS memories_authority_guard_insert;
         DROP TRIGGER IF EXISTS memories_authority_guard_update;
         DROP TRIGGER IF EXISTS memories_authority_guard_delete;
         DROP TRIGGER IF EXISTS memories_ai;
         DROP TRIGGER IF EXISTS memories_ad;
         DROP TRIGGER IF EXISTS memories_au;
         DROP TABLE IF EXISTS memories_fts;
         DROP TABLE IF EXISTS memories_v106;",
    )?;
    tx.execute_batch(&format!(
        "CREATE TABLE memories_v106 (id INTEGER PRIMARY KEY AUTOINCREMENT, {MEMORY_COLUMNS});"
    ))?;

    // A placed row keeps what its level record says; an unplaced one belongs
    // to the project it was written in. The placement's `origin_category`
    // holds the category id the writer's profile gave the tag.
    tx.execute_batch(&format!(
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
           FROM memories m LEFT JOIN memory_placement p ON p.memory_id = m.id;",
        case = category_case("m.category"),
    ))?;

    // New rows must never reuse the id of a memory deleted before the
    // migration: history and sync records still name those ids.
    let sequence: Option<i64> = tx
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'memories'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(sequence) = sequence {
        tx.execute(
            "UPDATE sqlite_sequence SET seq = MAX(seq, ?1) WHERE name = 'memories_v106'",
            [sequence],
        )?;
    }

    move_user_memories(tx)?;

    tx.execute_batch(&format!(
        "DROP TABLE memories;
         ALTER TABLE memories_v106 RENAME TO memories;
         CREATE UNIQUE INDEX idx_memories_owner_key
             ON memories(level, owner_id, category, normalized_hash) WHERE {LIVE};
         CREATE INDEX idx_memories_owner_status ON memories(level, owner_id, status);
         CREATE INDEX idx_memories_owner_status_expires
             ON memories(level, owner_id, status, expires_at);
         CREATE INDEX idx_memories_owner_origin_category
             ON memories(owner_id, status, origin_category);

         -- Search matches the category text a memory was written under, as it
         -- did before the migration, so results don't move.
         CREATE VIRTUAL TABLE memories_fts USING fts5(
             content,
             origin_category,
             content='memories',
             content_rowid='id',
             tokenize='porter unicode61'
         );
         INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
         CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
             INSERT INTO memories_fts(rowid, content, origin_category)
             VALUES (new.id, new.content, new.origin_category);
         END;
         CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
             INSERT INTO memories_fts(memories_fts, rowid, content, origin_category)
             VALUES ('delete', old.id, old.content, old.origin_category);
         END;
         CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
             INSERT INTO memories_fts(memories_fts, rowid, content, origin_category)
             VALUES ('delete', old.id, old.content, old.origin_category);
             INSERT INTO memories_fts(rowid, content, origin_category)
             VALUES (new.id, new.content, new.origin_category);
         END;"
    ))?;

    // The rebuilt table must resolve every reference the old one did.
    let dangling_after = dangling_memory_references(tx)?;
    if dangling_after > dangling_before {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other(format!(
                "the rebuild left {} rows referencing missing memories",
                dangling_after - dangling_before
            )),
        )));
    }

    move_observations(tx)?;

    // The level record now lives on the row; the profile version counter has
    // no reader, since the head compares the rows it shows; and the mutation
    // log fed only the plugin's history head.
    tx.execute_batch(
        "DROP TABLE IF EXISTS memory_placement;
         DROP TABLE IF EXISTS memory_mutation_log;
         DROP TABLE IF EXISTS user_memories;",
    )?;
    let has_profile_version: bool = tx.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('project_state')
          WHERE name = 'project_user_profile_version'",
        [],
        |row| row.get(0),
    )?;
    if has_profile_version {
        tx.execute_batch("ALTER TABLE project_state DROP COLUMN project_user_profile_version;")?;
    }
    Ok(())
}

/// Today's user memories become global memories in the reserved unsorted
/// category. Each keeps its old id and promotion time in `metadata_json`: the
/// user profile block orders by promotion time, and a history head rendered
/// before the migration compares the old ids.
fn move_user_memories(tx: &Transaction) -> rusqlite::Result<()> {
    let exists: bool = tx.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'user_memories'",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }
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
    let rows: Vec<UserMemory> = tx
        .prepare(
            "SELECT id, content, status, promoted_at, source_candidate_ids,
                    source_candidate_provenance, created_at, updated_at
               FROM user_memories ORDER BY promoted_at ASC, id ASC",
        )?
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
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, content, status, promoted_at, candidate_ids, provenance, created_at, updated_at) in
        rows
    {
        let mut metadata = serde_json::json!({
            "user_memory_id": id,
            "promoted_at": promoted_at,
        });
        if let Some(ids) = candidate_ids.as_deref() {
            metadata["source_candidate_ids"] =
                serde_json::from_str(ids).unwrap_or(serde_json::Value::String(ids.to_owned()));
        }
        if let Some(provenance) = provenance {
            metadata["source_candidate_provenance"] = serde_json::Value::String(provenance);
        }
        tx.execute(
            "INSERT INTO memories_v106 (level, owner_id, category, origin_category, content,
                 normalized_hash, source_type, seen_count, retrieval_count, first_seen_at,
                 created_at, updated_at, last_seen_at, status, metadata_json)
             VALUES ('global', 'self', ?1, ?2, ?3, ?4, 'user-review', 1, 0, ?5, ?6, ?7, ?5, ?8, ?9)",
            params![
                USER_UNSORTED_CATEGORY,
                USER_MEMORY_TAG,
                content,
                normalized_hash(&content),
                promoted_at,
                created_at,
                updated_at,
                status,
                metadata.to_string(),
            ],
        )?;
    }
    Ok(())
}

/// Today's user-memory candidates become observations: what a summary
/// noticed about the person, which only the global review turns into
/// memories.
fn move_observations(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
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
             anchors_json TEXT,
             created_at INTEGER NOT NULL,
             consumed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_memory_observations_pending
             ON memory_observations(consumed_at, created_at);",
    )?;
    let exists: bool = tx.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master
          WHERE type = 'table' AND name = 'user_memory_candidates'",
        [],
        |row| row.get(0),
    )?;
    if exists {
        tx.execute_batch(
            "INSERT INTO memory_observations (id, content, session_id, anchors_json, created_at)
             SELECT id, content, session_id,
                    CASE WHEN source_compartment_start IS NULL AND source_compartment_end IS NULL
                         THEN NULL
                         ELSE json_object('summary_start', source_compartment_start,
                                          'summary_end', source_compartment_end) END,
                    created_at
               FROM user_memory_candidates;
             DROP TABLE user_memory_candidates;",
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "context_migrations_tests.rs"]
mod tests;
