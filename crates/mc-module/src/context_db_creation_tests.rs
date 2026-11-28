use std::path::{Path, PathBuf};

use rusqlite::{types::Value, Connection};

use super::{
    initialize_fresh_schema, initialize_schema_statement_by_statement, live_schema_version,
    ContextDb, FRESH_SCHEMA, PLUGIN_SCHEMA_VERSION, SCHEMA_VERSION,
};

type SchemaObject = (String, String, String, Option<String>);
type MigrationRow = (i64, String, i64);

fn objects(connection: &Connection) -> Vec<SchemaObject> {
    connection
        .prepare(
            "SELECT name, type, tbl_name, sql FROM sqlite_master
             ORDER BY name, type, tbl_name, sql",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn migration_rows(connection: &Connection) -> Vec<MigrationRow> {
    connection
        .prepare("SELECT version, description, applied_at FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn store_pragmas(connection: &Connection) -> [Value; 6] {
    [
        "user_version",
        "application_id",
        "journal_mode",
        "page_size",
        "auto_vacuum",
        "synchronous",
    ]
    .map(|name| {
        connection
            .pragma_query_value(None, name, |row| row.get(0))
            .unwrap()
    })
}

#[derive(Debug, PartialEq)]
struct ReadyStore {
    objects: Vec<SchemaObject>,
    version: i64,
    version_history: Vec<(i64, String)>,
    pragmas: [Value; 6],
}

fn ready_store(db: &ContextDb) -> ReadyStore {
    db.with_connection(|connection| ReadyStore {
        objects: objects(connection),
        version: live_schema_version(connection).unwrap(),
        // Applying migrations stamps them with the real time. Compare their
        // versions and descriptions, not the wall times of two separate opens.
        version_history: migration_rows(connection)
            .into_iter()
            .map(|(version, description, _)| (version, description))
            .collect(),
        pragmas: store_pragmas(connection),
    })
}

#[test]
fn fresh_transaction_matches_the_statement_by_statement_store() {
    let root = tempfile::tempdir().unwrap();
    let before = root.path().join("before.db");
    let after = root.path().join("after.db");
    let old = Connection::open(&before).unwrap();
    let mut new = Connection::open(&after).unwrap();
    let schema = FRESH_SCHEMA.replace(":applied_at", "123456");
    initialize_schema_statement_by_statement(&old, &schema).unwrap();
    initialize_fresh_schema(&mut new, &schema).unwrap();
    assert_eq!(objects(&old), objects(&new));
    assert_eq!(migration_rows(&old), migration_rows(&new));
    assert_eq!(store_pragmas(&old), store_pragmas(&new));
    assert_eq!(
        live_schema_version(&new).unwrap(),
        i64::from(PLUGIN_SCHEMA_VERSION)
    );
    drop(old);
    drop(new);

    let old = ready_store(&ContextDb::open(&before).unwrap());
    let new = ready_store(&ContextDb::open(&after).unwrap());
    assert_eq!(old, new);
    assert_eq!(new.version, i64::from(SCHEMA_VERSION));
}

fn draft_path(root: &Path) -> PathBuf {
    root.join(format!("context.db.creating-{}", std::process::id()))
}

#[test]
fn interrupted_fresh_schema_leaves_no_partial_schema_and_creation_retries() {
    let old_root = tempfile::tempdir().unwrap();
    let new_root = tempfile::tempdir().unwrap();
    let normal_root = tempfile::tempdir().unwrap();
    let old_draft = draft_path(old_root.path());
    let new_draft = draft_path(new_root.path());
    let old_path = old_root.path().join("context.db");
    let new_path = new_root.path().join("context.db");
    let schema = FRESH_SCHEMA.replace(":applied_at", "123456");
    let middle = "CREATE TABLE compartment_history_versions (";
    assert_eq!(schema.matches(middle).count(), 1);
    let interrupted = schema.replacen(
        middle,
        &format!("INSERT INTO missing_at_interruption VALUES (1);\n{middle}"),
        1,
    );

    let old = Connection::open(&old_draft).unwrap();
    let error = initialize_schema_statement_by_statement(&old, &interrupted).unwrap_err();
    assert!(
        error.to_string().contains("missing_at_interruption"),
        "{error}"
    );
    drop(old);
    let old_objects = objects(&Connection::open(&old_draft).unwrap());
    assert!(old_objects
        .iter()
        .any(|row| row.0 == "session_meta_collection_revisions"));
    assert!(!old_objects
        .iter()
        .any(|row| row.0 == "compartment_history_versions"));
    let refused = ContextDb::open(&old_draft)
        .err()
        .expect("old partial store refused");
    assert!(
        refused.contains("no such table: schema_migrations"),
        "{refused}"
    );
    eprintln!(
        "old draft: {} committed schema objects; direct open refused",
        old_objects.len()
    );

    let mut new = Connection::open(&new_draft).unwrap();
    let error = initialize_fresh_schema(&mut new, &interrupted).unwrap_err();
    assert!(
        error.to_string().contains("missing_at_interruption"),
        "{error}"
    );
    drop(new);
    assert!(
        objects(&Connection::open(&new_draft).unwrap()).is_empty(),
        "failed schema must roll back on reopen"
    );
    assert!(
        !old_path.exists() && !new_path.exists(),
        "neither draft was published"
    );

    // At startup, an unpublished draft is discarded before fresh creation.
    let expected = ready_store(&ContextDb::create(&normal_root.path().join("context.db")).unwrap());
    assert_eq!(
        ready_store(&ContextDb::create(&old_path).unwrap()),
        expected
    );
    assert_eq!(
        ready_store(&ContextDb::create(&new_path).unwrap()),
        expected
    );
    assert!(
        !old_draft.exists() && !new_draft.exists(),
        "startup must remove the drafts"
    );
}
