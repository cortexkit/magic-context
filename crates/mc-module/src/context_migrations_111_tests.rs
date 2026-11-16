//! Migration 111 on a populated store at 110: the attribution facts table
//! arrives empty, every earlier table, index and row stays as it was, and a
//! store ck-mc creates has the table from the start.

use rusqlite::{params, Connection};

use super::*;

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

/// The store as the module left it at 110, with a memory and a docs
/// proposal in it.
fn populated_store_at_110() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let found = crate::context_db::live_schema_version(&conn).unwrap();
    assert_eq!(upgrade_through(&mut conn, found, 110).unwrap(), 110);
    let content = "The parser rejects empty input.";
    conn.execute(
        "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                              normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (1, 'project', 'pj-facts', 'swe:architecture', 'ARCHITECTURE', ?1, ?2, 1, 1, 1, 1)",
        params![content, crate::memory_writes::normalized_hash(content)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO docs_proposals(project, created_at, checkout, base_commit, changes_json,
                                    dropped_json, status, status_at, body)
         VALUES ('pj-facts', 1, '/repo', 'abc', '[]', '[]', 'pending', 1, '{}')",
        [],
    )
    .unwrap();
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

/// Every row of `table`, each as one line of quoted values.
fn rows(conn: &Connection, table: &str) -> Vec<String> {
    let columns: Vec<String> = conn
        .prepare(&format!(
            "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
        ))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let select = columns
        .iter()
        .map(|column| format!("quote({column})"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");
    conn.prepare(&format!("SELECT {select} FROM {table} ORDER BY rowid"))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn insert(conn: &Connection, fact_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO attribution_facts(fact_id, body, recorded_at_ms) VALUES (?1, '{}', 1)",
        params![fact_id],
    )
}

#[test]
fn migration_111_adds_an_empty_fact_table_and_keeps_the_rest() {
    let mut conn = populated_store_at_110();
    let before = schema(&conn);
    assert!(!before.iter().any(|(name, _)| name == "attribution_facts"));
    let memories = rows(&conn, "memories");
    let proposals = rows(&conn, "docs_proposals");
    assert_eq!((memories.len(), proposals.len()), (1, 1));

    assert_eq!(upgrade(&mut conn, 110).unwrap(), 111);
    assert_eq!(SCHEMA_VERSION, 111);

    let after = schema(&conn);
    let added: Vec<&str> = after
        .iter()
        .filter(|entry| !before.contains(entry))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        added,
        ["attribution_facts", "idx_attribution_facts_unpublished"]
    );
    assert!(
        before.iter().all(|entry| after.contains(entry)),
        "every earlier table and index is unchanged"
    );
    assert_eq!(rows(&conn, "memories"), memories);
    assert_eq!(rows(&conn, "docs_proposals"), proposals);
    assert!(rows(&conn, "attribution_facts").is_empty());
    let recorded: i64 = conn
        .query_row(
            "SELECT count(*) FROM schema_migrations WHERE version = 111",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 1);
}

#[test]
fn a_fact_id_is_stored_once_and_seq_never_reuses_a_place() {
    let mut conn = populated_store_at_110();
    upgrade(&mut conn, 110).unwrap();
    insert(&conn, "a").unwrap();
    assert!(insert(&conn, "a").is_err(), "a fact id is stored once");
    insert(&conn, "b").unwrap();
    conn.execute("DELETE FROM attribution_facts WHERE fact_id = 'b'", [])
        .unwrap();
    insert(&conn, "c").unwrap();
    let seqs: Vec<i64> = conn
        .prepare("SELECT seq FROM attribution_facts ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // A cursor a reader holds never comes to name another fact.
    assert_eq!(seqs, [1, 3]);
}

#[test]
fn a_store_ck_mc_creates_has_the_fact_table() {
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
    assert!(tables.iter().any(|(name, _)| name == "attribution_facts"));
}
