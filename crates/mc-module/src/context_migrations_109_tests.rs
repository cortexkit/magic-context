//! Migration 109 on a store at 108: every memory keeps its row and gains an
//! empty line, so the verify tasks treat it as a memory whose line is
//! unknown; a store ck-mc creates has the columns from the start.

use rusqlite::{params, Connection};

use super::*;

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

/// The store as the module left it at 108.
fn store_at_108() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let found = crate::context_db::live_schema_version(&conn).unwrap();
    assert_eq!(upgrade_through(&mut conn, found, 108).unwrap(), 108);
    conn
}

/// Every column of every memory, in column order, as text.
fn memory_rows(conn: &Connection, columns: &[String]) -> Vec<String> {
    let select = columns
        .iter()
        .map(|column| format!("quote({column})"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");
    conn.prepare(&format!("SELECT {select} FROM memories ORDER BY id"))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn columns(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT name FROM pragma_table_info('memories') ORDER BY cid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn migration_109_gives_every_memory_an_empty_line_and_keeps_the_rest() {
    let mut conn = store_at_108();
    for (id, content) in [(1, "The parser rejects empty input."), (2, "Use the head.")] {
        conn.execute(
            "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                                  normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'project', 'pj-lines', 'swe:architecture', 'ARCHITECTURE', ?2, ?3, 1, 1, 1, 1)",
            params![id, content, crate::memory_writes::normalized_hash(content)],
        )
        .unwrap();
    }
    let before_columns = columns(&conn);
    assert!(!before_columns
        .iter()
        .any(|column| column == "source_branch"));
    let before = memory_rows(&conn, &before_columns);

    assert_eq!(upgrade(&mut conn, 108).unwrap(), 109);
    assert_eq!(SCHEMA_VERSION, 109);

    let after_columns = columns(&conn);
    assert_eq!(
        after_columns[before_columns.len()..],
        ["source_branch", "source_commit"]
    );
    // Every earlier column of every row is unchanged.
    assert_eq!(memory_rows(&conn, &before_columns), before);
    let lines: Vec<(Option<String>, Option<String>)> = conn
        .prepare("SELECT source_branch, source_commit FROM memories ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(lines, [(None, None), (None, None)]);
}

#[test]
fn a_store_ck_mc_creates_has_the_line_columns() {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let found = db.with_connection(|conn| {
        (
            crate::context_db::live_schema_version(conn).unwrap(),
            columns(conn),
        )
    });
    assert_eq!(found.0, i64::from(SCHEMA_VERSION));
    assert!(found.1.contains(&"source_branch".to_owned()));
    assert!(found.1.contains(&"source_commit".to_owned()));
}
