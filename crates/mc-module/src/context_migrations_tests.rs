//! Migration 106 on a populated store at the plugin's last version.

use rusqlite::{params, Connection};

use super::*;

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

fn plugin_store() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    // The plugin's hosts run with foreign keys on; the rebuild must not
    // cascade-delete through them.
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    connection
}

fn insert_memory(
    connection: &Connection,
    id: i64,
    project: &str,
    category: &str,
    content: &str,
    status: &str,
) {
    connection
        .execute(
            "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance,
                 source_session_id, first_seen_at, created_at, updated_at, last_seen_at, status,
                 metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, 50, 'ses_a', 1, 1, 2, 2, ?6, '{\"k\":1}')",
            params![id, project, category, content, normalized_hash(content), status],
        )
        .unwrap();
}

fn version(connection: &Connection) -> i64 {
    crate::context_db::live_schema_version(connection).unwrap()
}

fn populate(connection: &Connection) {
    insert_memory(
        connection,
        1,
        "pj-one",
        "ARCHITECTURE",
        "The parser is incremental.",
        "active",
    );
    insert_memory(
        connection,
        2,
        "pj-one",
        "USER_DIRECTIVES",
        "Run the gate before pushing.",
        "active",
    );
    insert_memory(
        connection,
        3,
        "dir:07a38392e402",
        "TEST_COVERAGE",
        "Tests cover the cut.",
        "active",
    );
    // Two old tags that now share one category, holding the same text.
    insert_memory(
        connection,
        4,
        "pj-one",
        "CONSTRAINTS",
        "Never log tokens.",
        "active",
    );
    insert_memory(
        connection,
        5,
        "pj-one",
        "KNOWN_ISSUES",
        "Never log tokens.",
        "archived",
    );
    // A placed row: its level record names the category id the writer's
    // profile gave it.
    insert_memory(
        connection,
        6,
        "pj-two",
        "NAMING",
        "Files are kebab-case.",
        "active",
    );
    connection
        .execute(
            "INSERT INTO memory_placement (memory_id, level, owner_kind, owner_id,
                 origin_profile_name, origin_profile_version, origin_profile_digest,
                 origin_category, applies_to_json, written_at)
             VALUES (6, 'project', 'project', 'pj-two', 'swe', '1.0.0', 'sha256:x',
                 'swe:naming', '{\"subject\":\"files\"}', 9)",
            [],
        )
        .unwrap();
    connection
        .execute_batch(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (1, x'00', 'm');
             INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES (1, 'a.rs', 5);
             INSERT INTO memory_mutation_log (project_path, mutation_type, target_memory_id, queued_at)
                 VALUES ('pj-one', 'archive', 5, 3);
             INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version)
                 VALUES ('pj-one', 4, 7);
             INSERT INTO user_memories (id, content, status, promoted_at, source_candidate_ids,
                 source_candidate_provenance, created_at, updated_at)
                 VALUES (11, 'Prefers short answers.', 'active', 50, '[3,4]', 'summary', 40, 60),
                        (12, 'Works in Europe/Madrid.', 'active', 20, '[]', NULL, 10, 20);
             INSERT INTO user_memory_candidates (id, content, session_id, source_compartment_start,
                 source_compartment_end, created_at)
                 VALUES (8, 'Likes tables.', 'ses_b', 3, 4, 70);
             -- Ids above every surviving row were used before; new rows must
             -- not take them again.
             UPDATE sqlite_sequence SET seq = 900 WHERE name = 'memories';",
        )
        .unwrap();
}

#[test]
fn a_plugin_store_migrates_to_the_leveled_memory_schema() {
    let mut connection = plugin_store();
    populate(&connection);
    assert_eq!(version(&connection), i64::from(PLUGIN_SCHEMA_VERSION));

    let found = version(&connection);
    assert_eq!(upgrade(&mut connection, found).unwrap(), 106);
    assert_eq!(version(&connection), 106);

    let row = |id: i64| -> (String, String, String, String, Option<String>, String) {
        connection
            .query_row(
                "SELECT level, owner_id, category, origin_category, origin_profile,
                        COALESCE(source_project_id, '')
                   FROM memories WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap()
    };
    assert_eq!(
        row(1),
        (
            "project".into(),
            "pj-one".into(),
            "swe:architecture".into(),
            "ARCHITECTURE".into(),
            None,
            "pj-one".into()
        )
    );
    assert_eq!(row(2).2, "swe:project-rules");
    assert_eq!(row(2).3, "USER_DIRECTIVES");
    // A legacy identity stays the owner; the lift remaps it later.
    assert_eq!(row(3).1, "dir:07a38392e402");
    assert_eq!(row(3).2, UNMAPPED_CATEGORY);
    assert_eq!(row(4).2, row(5).2);
    assert_eq!(
        row(6),
        (
            "project".into(),
            "pj-two".into(),
            "swe:naming".into(),
            "NAMING".into(),
            Some("swe".into()),
            "pj-two".into()
        )
    );
    let applies_to: String = connection
        .query_row(
            "SELECT applies_to_json FROM memories WHERE id = 6",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(applies_to, "{\"subject\":\"files\"}");

    // Unchanged columns came across as they were.
    let (importance, metadata, hash): (i64, String, String) = connection
        .query_row(
            "SELECT importance, metadata_json, normalized_hash FROM memories WHERE id = 2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((importance, metadata.as_str()), (50, "{\"k\":1}"));
    assert_eq!(hash, normalized_hash("Run the gate before pushing."));

    // Rows that reference a memory survived the rebuild.
    let referencing: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM memory_embeddings) + (SELECT COUNT(*) FROM memory_verifications)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(referencing, 2);

    // User memories are global rows in the unsorted category, keeping their
    // order and old ids.
    let users: Vec<(String, String, String, String)> = connection
        .prepare(
            "SELECT content, owner_id, category, metadata_json FROM memories WHERE level = 'global'
              ORDER BY json_extract(metadata_json, '$.promoted_at'), id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(users.len(), 2);
    assert_eq!(users[0].0, "Works in Europe/Madrid.");
    assert_eq!(
        (users[0].1.as_str(), users[0].2.as_str()),
        ("self", USER_UNSORTED_CATEGORY)
    );
    let first: serde_json::Value = serde_json::from_str(&users[1].3).unwrap();
    assert_eq!(first["user_memory_id"], 11);
    assert_eq!(first["source_candidate_ids"], serde_json::json!([3, 4]));
    let user_ids: Vec<i64> = connection
        .prepare("SELECT id FROM memories WHERE level = 'global'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(user_ids.iter().all(|id| *id > 900), "{user_ids:?}");

    // Observations replace the candidates.
    let (content, anchors): (String, String) = connection
        .query_row(
            "SELECT content, anchors_json FROM memory_observations WHERE id = 8",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(content, "Likes tables.");
    assert_eq!(anchors, "{\"summary_start\":3,\"summary_end\":4}");

    let gone: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('memory_placement', 'memory_mutation_log',
                 'user_memories', 'user_memory_candidates', 'memories_v106')
                 OR name LIKE 'memories_authority_guard_%'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(gone.is_empty(), "{gone:?}");
    let profile_version: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('project_state')
              WHERE name = 'project_user_profile_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(profile_version, 0);
    let epoch: i64 = connection
        .query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path = 'pj-one'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(epoch, 4);
}

#[test]
fn search_after_the_migration_finds_the_same_memories() {
    let mut connection = plugin_store();
    populate(&connection);
    let matches = |connection: &Connection, query: &str| -> Vec<i64> {
        connection
            .prepare(
                "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?1
                  ORDER BY bm25(memories_fts), rowid",
            )
            .unwrap()
            .query_map([query], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let queries = ["parser", "tokens", "architecture", "known issues", "kebab"];
    let before: Vec<Vec<i64>> = queries
        .iter()
        .map(|query| matches(&connection, query))
        .collect();
    let found = version(&connection);
    upgrade(&mut connection, found).unwrap();
    let after: Vec<Vec<i64>> = queries
        .iter()
        .map(|query| matches(&connection, query))
        .collect();
    assert_eq!(before, after);
    assert!(before.iter().all(|ids| !ids.is_empty()), "{before:?}");

    // The index follows later writes.
    connection
        .execute(
            "UPDATE memories SET content = 'The lexer is incremental.' WHERE id = 1",
            [],
        )
        .unwrap();
    assert!(matches(&connection, "parser").is_empty());
    assert_eq!(matches(&connection, "lexer"), vec![1]);
}

#[test]
fn only_live_memories_are_unique_for_their_owner_and_category() {
    let mut connection = plugin_store();
    populate(&connection);
    let found = version(&connection);
    upgrade(&mut connection, found).unwrap();
    let insert = |status: &str| {
        connection.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status)
             VALUES ('project', 'pj-one', 'swe:constraints', 'CONSTRAINTS', 'Never log tokens.', ?1,
                 1, 1, 1, 1, ?2)",
            params![normalized_hash("Never log tokens."), status],
        )
    };
    insert("archived").unwrap();
    assert!(
        insert("active").is_err(),
        "a second live copy must be refused"
    );
}

#[test]
fn a_store_outside_the_migrated_range_is_refused_untouched() {
    let mut connection = plugin_store();
    let below = i64::from(PLUGIN_SCHEMA_VERSION) - 1;
    assert!(upgrade(&mut connection, below).is_err());
    assert!(upgrade(&mut connection, i64::from(SCHEMA_VERSION) + 1).is_err());
    assert_eq!(version(&connection), i64::from(PLUGIN_SCHEMA_VERSION));
}

#[test]
fn foreign_keys_are_on_again_after_the_rebuild() {
    let mut connection = plugin_store();
    populate(&connection);
    let found = version(&connection);
    upgrade(&mut connection, found).unwrap();
    let on: bool = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();
    assert!(on);
    // And they work against the rebuilt table.
    connection
        .execute("DELETE FROM memories WHERE id = 1", [])
        .unwrap();
    let left: i64 = connection
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 0);
}
