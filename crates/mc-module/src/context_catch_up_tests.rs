//! A store the released 0.49 plugin wrote (version 95) must end up with
//! exactly the schema of a store the module creates, and keep its data.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;

use crate::context_db::{live_schema_version, ContextDb};
use crate::context_migrations::{RELEASED_PLUGIN_VERSION, SCHEMA_VERSION};

/// The fresh schema the 0.49 line's plugin migration chain produces.
const PLUGIN_95_SCHEMA: &str = include_str!("../testdata/context-schema-95.sql");

fn store_at_95(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(&PLUGIN_95_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    assert_eq!(
        live_schema_version(&connection).unwrap(),
        RELEASED_PLUGIN_VERSION
    );
}

/// Every table's columns, and every index, trigger and view, with SQL
/// whitespace collapsed. Shadow tables of full-text indexes and SQLite's own
/// tables are left out: they follow from the rest.
fn schema(path: &Path) -> BTreeMap<String, String> {
    let connection = Connection::open(path).unwrap();
    let shadows: Vec<String> = connection
        .prepare("PRAGMA table_list")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .filter(|(_, kind)| kind == "shadow")
        .map(|(name, _)| name)
        .collect();
    let objects: Vec<(String, String, Option<String>)> = connection
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .filter(|(_, name, _)| !shadows.contains(name))
        .collect();
    let mut schema = BTreeMap::new();
    for (kind, name, sql) in objects {
        let value = if kind == "table" {
            // Columns added with ALTER TABLE leave the table's SQL text
            // different from a table created whole, so tables compare by
            // their columns, in order.
            let mut columns: Vec<String> = connection
                .prepare(&format!("PRAGMA table_xinfo(\"{name}\")"))
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{} {} notnull={} default={:?} pk={}",
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            // The one exception is `session_meta`: the plugin's chain rebuilt
            // it at version 103, placing later columns in the middle, while
            // a 0.49 store gets them appended. Nothing reads that table by
            // column position, so only its set of columns must match.
            if name == "session_meta" {
                columns.sort();
            }
            columns.join(", ")
        } else {
            sql.unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        schema.insert(format!("{kind} {name}"), value);
    }
    let versions: Vec<i64> = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    schema.insert("schema_migrations".into(), format!("{versions:?}"));
    schema
}

#[test]
fn a_0_49_store_ends_with_the_schema_of_a_new_store() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old.db");
    store_at_95(&old);
    drop(ContextDb::open(&old).unwrap());
    let new = dir.path().join("new.db");
    drop(ContextDb::create(&new).unwrap());
    let (old, new) = (schema(&old), schema(&new));
    for (key, value) in &new {
        assert_eq!(old.get(key), Some(value), "{key}");
    }
    for key in old.keys() {
        assert!(new.contains_key(key), "only in the migrated store: {key}");
    }
}

#[test]
fn a_0_49_store_keeps_its_memories_notes_summaries_and_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    store_at_95(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "INSERT INTO memories(project_path, category, content, normalized_hash, importance,
                                  first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES ('git:abc', 'PROJECT_RULES', 'Never push without approval.', 'h1', 90, 1, 1, 1, 1),
                        ('git:abc', 'NAMING', 'Crates are named mc-*.', 'h2', 40, 1, 1, 1, 1);
             INSERT INTO user_memories(content, promoted_at, created_at, updated_at)
                 VALUES ('Prefers light themes.', 1, 1, 1);
             INSERT INTO notes(content, session_id, project_path, created_at, updated_at)
                 VALUES ('Check the release log.', 'ses_1', 'git:abc', 1, 1);
             INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses_1', 0, 1, 40, 'Setup', 'Set up the project.', 1);
             INSERT INTO session_meta(session_id, merged_reasoning_stripped_ids)
                 VALUES ('ses_1', '[\"a\"]');",
        )
        .unwrap();
    drop(connection);
    drop(ContextDb::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        live_schema_version(&connection).unwrap(),
        i64::from(SCHEMA_VERSION)
    );
    let project: Vec<(String, String, String, i64)> = connection
        .prepare(
            "SELECT owner_id, origin_category, content, importance FROM memories
              WHERE level = 'project' ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        project,
        [
            (
                "git:abc".into(),
                "PROJECT_RULES".into(),
                "Never push without approval.".into(),
                90
            ),
            (
                "git:abc".into(),
                "NAMING".into(),
                "Crates are named mc-*.".into(),
                40
            ),
        ]
    );
    let global: Vec<String> = connection
        .prepare("SELECT content FROM memories WHERE level = 'global'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(global, ["Prefers light themes."]);
    let counts: (i64, i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM notes), (SELECT COUNT(*) FROM compartments),
                    (SELECT COUNT(*) FROM session_meta)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 1, 1));
}

#[test]
fn a_store_older_than_0_49_or_newer_than_this_build_is_refused_untouched() {
    for version in [RELEASED_PLUGIN_VERSION - 1, i64::from(SCHEMA_VERSION) + 1] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        store_at_95(&path);
        let connection = Connection::open(&path).unwrap();
        if version < RELEASED_PLUGIN_VERSION {
            connection
                .execute(
                    "DELETE FROM schema_migrations WHERE version > ?1",
                    [version],
                )
                .unwrap();
        } else {
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, 'newer', 0)",
                    [version],
                )
                .unwrap();
        }
        drop(connection);
        let before = schema(&path);
        let error = ContextDb::open(&path).err().expect("refused");
        assert!(error.contains(&version.to_string()), "{error}");
        assert_eq!(schema(&path), before, "version {version}");
    }
}

#[test]
fn a_machine_without_a_store_gets_one_and_an_existing_store_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("context.db");
    let db = ContextDb::create(&path).unwrap();
    db.with_connection(|connection| {
        assert_eq!(
            live_schema_version(connection).unwrap(),
            i64::from(SCHEMA_VERSION)
        );
        connection
            .execute(
                "INSERT INTO notes(content, created_at, updated_at) VALUES ('kept', 1, 1)",
                [],
            )
            .unwrap();
    });
    drop(db);
    // A second create, as when two starts race, opens the store as found.
    let again = ContextDb::create(&path).unwrap();
    let kept: i64 = again.with_connection(|connection| {
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE content = 'kept'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    });
    assert_eq!(kept, 1);
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.contains("creating"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
