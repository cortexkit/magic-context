//! Connection-scoped feature discovery; the dashboard never migrates the shared store.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub schema_version: i64,
    pub memory_revision: bool,
    pub memory_history: bool,
    pub memory_undo: bool,
    pub compartment_scores: bool,
    pub legacy_memory_edits: bool,
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
        "memory_mutation_log",
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
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .unwrap_or(0)
    } else {
        0
    };
    let memory_revision = has("memories", &["revision"]);
    let memory_history = memory_revision
        && has("memory_mutation_log", &["operation_id"])
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
        );
    let value = Capabilities {
        schema_version,
        memory_revision,
        memory_history,
        memory_undo: memory_history
            && has("memories", &["safety_critical"])
            && tables.contains("memory_clause_evidence"),
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
        // Never let an incomplete newer schema fall through to a writer that bypasses revisions.
        legacy_memory_edits: schema_version <= 95
            && !memory_revision
            && !tables.contains("memory_history")
            && !tables.contains("memory_journal"),
    };
    // A plugin upgrade can change the schema while the dashboard keeps running.
    // Keep the cache in TEMP storage so it dies with this connection, not with the app.
    conn.execute_batch("CREATE TEMP TABLE dashboard_capabilities(value TEXT NOT NULL)")?;
    conn.execute(
        "INSERT INTO temp.dashboard_capabilities VALUES (?1)",
        [serde_json::to_string(&value).unwrap()],
    )?;
    Ok(value)
}

pub const HISTORY_UNAVAILABLE: &str = "Memory history needs Magic Context 0.50 or later";

pub fn require_history(conn: &Connection, undo: bool) -> Result<(), String> {
    let capabilities = get(conn).map_err(|error| error.to_string())?;
    if capabilities.memory_history && (!undo || capabilities.memory_undo) {
        Ok(())
    } else {
        Err(HISTORY_UNAVAILABLE.into())
    }
}
