//! Migration 110 on a store at 109: the docs-upkeep task's proposal table
//! arrives empty, and nothing else changes; a store ck-mc creates has it from
//! the start.

use rusqlite::{params, Connection};

use super::*;

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

/// The store as the module left it at 109.
fn store_at_109() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let found = crate::context_db::live_schema_version(&conn).unwrap();
    assert_eq!(upgrade_through(&mut conn, found, 109).unwrap(), 109);
    conn
}

/// Every table and index the store holds, with its definition.
fn schema(conn: &Connection) -> Vec<(String, Option<String>)> {
    conn.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn insert(conn: &Connection, project: &str, status: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO docs_proposals(project, created_at, checkout, base_commit, changes_json,
                                    dropped_json, status, status_at, body)
         VALUES (?1, 1, '/repo', 'abc', '[]', '[]', ?2, 1, '{}')",
        params![project, status],
    )
}

#[test]
fn migration_110_adds_an_empty_proposal_table_and_keeps_the_rest() {
    let mut conn = store_at_109();
    let before = schema(&conn);
    assert!(!before.iter().any(|(name, _)| name == "docs_proposals"));

    assert_eq!(upgrade_through(&mut conn, 109, 110).unwrap(), 110);

    let after = schema(&conn);
    let added: Vec<&str> = after
        .iter()
        .filter(|entry| !before.contains(entry))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        added,
        [
            "docs_proposals",
            "idx_docs_proposals_one_pending",
            "idx_docs_proposals_project",
            "idx_docs_proposals_unpublished",
        ]
    );
    assert!(
        before.iter().all(|entry| after.contains(entry)),
        "every earlier table and index is unchanged"
    );
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM docs_proposals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn a_project_holds_at_most_one_pending_proposal_and_any_number_of_others() {
    let mut conn = store_at_109();
    upgrade(&mut conn, 109).unwrap();
    insert(&conn, "pj-a", "pending").unwrap();
    assert!(
        insert(&conn, "pj-a", "pending").is_err(),
        "a second pending proposal of one project is refused"
    );
    insert(&conn, "pj-b", "pending").unwrap();
    for status in ["stale", "stale", "applied", "dismissed"] {
        insert(&conn, "pj-a", status).unwrap();
    }
    assert!(
        insert(&conn, "pj-a", "accepted").is_err(),
        "a status outside the four is refused"
    );
}

#[test]
fn a_store_ck_mc_creates_has_the_proposal_table() {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let (version, tables) = db.with_connection(|conn| {
        (
            crate::context_db::live_schema_version(conn).unwrap(),
            schema(conn),
        )
    });
    assert_eq!(version, i64::from(SCHEMA_VERSION));
    assert!(tables.iter().any(|(name, _)| name == "docs_proposals"));
}
