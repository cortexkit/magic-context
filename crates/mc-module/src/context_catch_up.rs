//! Bringing a store the 0.49 plugin wrote to the schema the module's own
//! migrations start from.
//!
//! Every released 0.49 plugin leaves `context.db` at version 95. Versions 96
//! to 105 were written by the plugin only on the unreleased mode-3 line, so a
//! user's store never has them, and most of what they add is state for the
//! plugin's own transform, which the module never reads. So instead of
//! porting those ten migrations one by one, this step makes a store at 95 to
//! 104 match the plugin's fresh schema at 105
//! ([`crate::context_db::FRESH_SCHEMA`]):
//! - it creates every table, index, trigger and view that schema has and the
//!   store lacks, with that schema's seed rows for the tables it creates;
//! - it adds the columns versions 96 to 105 added to existing tables, with
//!   their definitions as those migrations wrote them;
//! - it drops the columns version 103 moved out of `session_meta`. That
//!   migration moved their contents into other tables for the plugin's
//!   transform; with no plugin left to read them, the contents are not kept.
//!
//! A test builds a store from the 0.49 schema, runs this step and the
//! module's migrations, and compares every table's columns, every index,
//! trigger and view, and the migration history with a store created fresh.

use std::collections::HashSet;

use rusqlite::{params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::PLUGIN_SCHEMA_VERSION;

/// The version every released 0.49 plugin leaves the store at.
pub const RELEASED_PLUGIN_VERSION: i64 = 95;

/// The columns versions 96 to 105 add to tables a store at 95 already has,
/// in the order the fresh schema at 105 lists them, with the definitions
/// those migrations used.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("lkg_slots", "served_capture_id", "INTEGER"),
    ("lkg_slots", "input_move_digests", "TEXT"),
    (
        "memories",
        "safety_critical",
        "INTEGER CHECK (safety_critical IN (0, 1))",
    ),
    ("memories", "revision", "INTEGER NOT NULL DEFAULT 1"),
    ("memories", "verify_result", "TEXT"),
    ("memories", "verify_files_json", "TEXT"),
    ("memories", "verify_commit", "TEXT"),
    ("memory_mutation_log", "operation_id", "TEXT"),
    ("session_meta", "served_prefix", "TEXT"),
    ("session_meta", "held_release", "TEXT"),
    (
        "session_meta",
        "cached_m0_score_selection_watermark",
        "INTEGER NOT NULL DEFAULT 0 CHECK (cached_m0_score_selection_watermark BETWEEN 0 AND 9223372036854775807)",
    ),
];

/// The `session_meta` columns version 103 moved into the plugin's render
/// cache and chunk tables.
const DROPPED_SESSION_META_COLUMNS: &[&str] = &[
    "note_nudge_anchors",
    "auto_search_hint_decisions",
    "memory_block_cache",
    "memory_block_ids",
    "cached_m0_bytes",
    "cached_m1_bytes",
    "cached_m0_upgrade_state",
    "stripped_placeholder_ids",
    "stale_reduce_stripped_ids",
    "processed_image_stripped_ids",
    "merged_reasoning_stripped_ids",
    "trailing_blank_decisions",
    "cached_m0_mural_data_url",
];

/// Bring a store at `found` (95 to 104) to [`PLUGIN_SCHEMA_VERSION`], in one
/// transaction. Another process that got there first leaves nothing to do.
pub(super) fn catch_up(connection: &mut Connection, found: i64, now_ms: i64) -> Result<(), String> {
    let fresh = fresh_schema(now_ms)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let at = crate::context_db::live_schema_version(&tx).map_err(|error| error.to_string())?;
    if at >= i64::from(PLUGIN_SCHEMA_VERSION) {
        return tx.commit().map_err(|error| error.to_string());
    }
    apply(&tx, &fresh, at)
        .map_err(|error| format!("bringing version {found} to {PLUGIN_SCHEMA_VERSION}: {error}"))?;
    tx.commit().map_err(|error| error.to_string())
}

/// The plugin's fresh schema at 105, in memory, with its seed rows stamped
/// `now_ms`.
fn fresh_schema(now_ms: i64) -> Result<Connection, String> {
    let fresh = Connection::open_in_memory().map_err(|error| error.to_string())?;
    fresh
        .execute_batch(&crate::context_db::FRESH_SCHEMA.replace(":applied_at", &now_ms.to_string()))
        .map_err(|error| format!("fresh schema: {error}"))?;
    Ok(fresh)
}

fn apply(tx: &Transaction, fresh: &Connection, at: i64) -> rusqlite::Result<()> {
    for column in DROPPED_SESSION_META_COLUMNS {
        if columns(tx, "session_meta")?.contains(*column) {
            tx.execute_batch(&format!(
                "ALTER TABLE session_meta DROP COLUMN \"{column}\""
            ))?;
        }
    }
    for (table, column, definition) in ADDED_COLUMNS {
        let present = columns(tx, table)?;
        // A table the store lacks is created whole below, columns included.
        if !present.is_empty() && !present.contains(*column) {
            tx.execute_batch(&format!(
                "ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition}"
            ))?;
        }
    }
    let shadows = shadow_tables(fresh)?;
    let mut statement = fresh.prepare(
        "SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )?;
    let objects = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, name, sql) in objects {
        if shadows.contains(&name) || exists(tx, &kind, &name)? {
            continue;
        }
        tx.execute_batch(&sql)?;
        if kind == "table" && !sql.starts_with("CREATE VIRTUAL TABLE") {
            copy_rows(fresh, tx, &name)?;
        }
    }
    let mut history = fresh.prepare(
        "SELECT version, description, applied_at FROM schema_migrations
          WHERE version > ?1 AND version <= ?2 ORDER BY version",
    )?;
    let rows = history
        .query_map([at, i64::from(PLUGIN_SCHEMA_VERSION)], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (version, description, applied_at) in rows {
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, description, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, description, applied_at],
        )?;
    }
    Ok(())
}

fn columns(connection: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_xinfo(\"{table}\")"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect();
    names
}

fn shadow_tables(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_list")?;
    let names = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?
        .filter_map(|row| match row {
            Ok((name, kind)) if kind == "shadow" => Some(Ok(name)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect();
    names
}

fn exists(connection: &Connection, kind: &str, name: &str) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2",
            [kind, name],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
}

/// Copy a created table's seed rows from the fresh schema.
fn copy_rows(fresh: &Connection, tx: &Transaction, table: &str) -> rusqlite::Result<()> {
    let mut select = fresh.prepare(&format!("SELECT * FROM \"{table}\""))?;
    let width = select.column_count();
    if width == 0 {
        return Ok(());
    }
    let placeholders = vec!["?"; width].join(", ");
    let mut insert = tx.prepare(&format!("INSERT INTO \"{table}\" VALUES ({placeholders})"))?;
    let mut rows = select.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..width)
            .map(|index| row.get::<_, rusqlite::types::Value>(index))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        insert.execute(params_from_iter(values))?;
    }
    Ok(())
}
