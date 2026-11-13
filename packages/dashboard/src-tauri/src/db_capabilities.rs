//! Connection-scoped feature discovery; the dashboard never migrates the shared store.
//!
//! ck-mc owns `context.db`'s schema and migrates it. This dashboard reads
//! memories at exactly one schema version, [`MEMORY_SCHEMA_VERSION`], and
//! refuses memory reads and writes on a store at any other version.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// The schema version whose memory tables this dashboard reads and writes:
/// ck-mc's migration 106, which files memories under a level, an owner and a
/// profile category.
pub const MEMORY_SCHEMA_VERSION: i64 = 106;

/// Migration versions at or above this belong to forks and don't count toward
/// the schema version, as in ck-mc's own version check.
const FORK_MIGRATION_VERSION_FLOOR: i64 = 10_000;

/// Shown instead of memories when the store is older than this dashboard reads.
pub const STORE_NOT_UPGRADED: &str = "This Magic Context store hasn't been upgraded yet. Starting Magic Context 0.50 upgrades it, and then its memories show here.";

/// Shown instead of memories when a newer Magic Context has upgraded the store.
pub const STORE_TOO_NEW: &str =
    "A newer Magic Context has upgraded this store. Update the dashboard to see its memories.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub schema_version: i64,
    pub memory_revision: bool,
    pub memory_history: bool,
    pub memory_undo: bool,
    pub compartment_scores: bool,
}

pub fn get(conn: &Connection) -> rusqlite::Result<Capabilities> {
    let cached: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE name='dashboard_capabilities')",
        [],
        |row| row.get(0),
    )?;
    if cached {
        let json: String =
            conn.query_row("SELECT value FROM temp.dashboard_capabilities", [], |row| {
                row.get(0)
            })?;
        return serde_json::from_str(&json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        });
    }
    let tables = conn
        .prepare("SELECT name FROM main.sqlite_master WHERE type='table'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    let mut columns = HashMap::new();
    for table in [
        "memories",
        "memory_history",
        "memory_journal",
        "compartment_score_selections",
        "compartment_score_revisions",
        "session_meta",
    ] {
        let names = conn
            .prepare(&format!("PRAGMA main.table_info(\"{table}\")"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        columns.insert(table, names);
    }
    let has = |table: &str, names: &[&str]| {
        columns
            .get(table)
            .is_some_and(|columns| names.iter().all(|name| columns.contains(*name)))
    };
    let schema_version = if tables.contains("schema_migrations") {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM main.schema_migrations WHERE version < ?1",
            [FORK_MIGRATION_VERSION_FLOOR],
            |row| row.get::<_, i64>(0),
        )?
    } else {
        0
    };
    // A store at the version this dashboard reads, with every memory table its
    // readers and writers use. Never let an incomplete store fall through to a
    // writer that bypasses revisions.
    let memory_store = schema_version == MEMORY_SCHEMA_VERSION
        && has(
            "memories",
            &[
                "level",
                "owner_id",
                "category",
                "origin_category",
                "revision",
                "safety_critical",
            ],
        )
        && has(
            "memory_history",
            &[
                "id",
                "memory_id",
                "revision",
                "previous_text",
                "after_text",
                "before_json",
                "after_json",
                "applied_at",
                "reason",
                "evidence_json",
                "source_ids_json",
                "decision_key",
            ],
        )
        && has(
            "memory_journal",
            &[
                "project_path",
                "decision_key",
                "operation",
                "receipt_json",
                "before_json",
                "after_json",
                "applied_at",
            ],
        )
        && tables.contains("memory_clause_evidence");
    let value = Capabilities {
        schema_version,
        memory_revision: has("memories", &["revision"]),
        memory_history: memory_store,
        memory_undo: memory_store,
        compartment_scores: has(
            "compartment_score_selections",
            &["session_id", "compartment_id", "sequence", "revision_id"],
        ) && has(
            "compartment_score_revisions",
            &[
                "id",
                "session_id",
                "compartment_id",
                "source_identity",
                "new_importance",
            ],
        ) && has("session_meta", &["cached_m0_score_selection_watermark"]),
    };
    // ck-mc can upgrade the store while the dashboard keeps running. Keep the
    // cache in TEMP storage so it dies with this connection, not with the app.
    conn.execute_batch("CREATE TEMP TABLE dashboard_capabilities(value TEXT NOT NULL)")?;
    conn.execute(
        "INSERT INTO temp.dashboard_capabilities VALUES (?1)",
        [serde_json::to_string(&value).unwrap()],
    )?;
    Ok(value)
}

/// Refuse memory reads and writes on a store this dashboard doesn't read,
/// with a message that tells the person why.
pub fn require_memory_store(conn: &Connection) -> Result<(), String> {
    let capabilities = get(conn).map_err(|error| error.to_string())?;
    if capabilities.memory_history && capabilities.memory_undo {
        Ok(())
    } else if capabilities.schema_version > MEMORY_SCHEMA_VERSION {
        Err(STORE_TOO_NEW.into())
    } else {
        Err(STORE_NOT_UPGRADED.into())
    }
}

/// Whether the store's memories can be read. Pages that only list projects
/// skip memories on another store instead of failing.
pub fn memory_store_ready(conn: &Connection) -> bool {
    require_memory_store(conn).is_ok()
}

/// [`require_memory_store`] for readers that return SQLite errors: the
/// refusal's text is the error's whole message.
pub fn require_memory_store_sql(conn: &Connection) -> rusqlite::Result<()> {
    require_memory_store(conn).map_err(|message| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(message),
        )
    })
}
