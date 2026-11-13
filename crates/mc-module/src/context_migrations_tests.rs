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
    let observation: (String, i64, i64) = connection
        .query_row(
            "SELECT content, source_start_ordinal, source_end_ordinal FROM memory_observations WHERE id = 8",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(observation, ("Likes tables.".to_owned(), 3, 4));

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

    // Global memories, which lived in their own table before, stay out of
    // the index.
    assert!(matches(&connection, "Madrid").is_empty());
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

/// The memory rows the head and search read, for one project, as the
/// readers before migration 106 selected them: the plugin's columns, the
/// workspace predicate on `project_path` and `category`, and the head's
/// filter on the old placement sidecar.
fn old_project_memories(conn: &Connection, project: &str) -> Vec<String> {
    let workspace = crate::workspace::Workspace::resolve(conn, project).unwrap();
    let [all, own, categories] = workspace.bindings();
    let shared = categories != "null";
    let predicate = if shared {
        "(m.project_path IN (SELECT value FROM json_each(?2)) OR
          (m.project_path IN (SELECT value FROM json_each(?1)) AND
           m.category IN (SELECT value FROM json_each(?3)) AND m.shareable = 1
           AND m.scope IN ('project','ecosystem','universe')))"
    } else {
        "m.project_path IN (SELECT value FROM json_each(?1))"
    };
    let order = if workspace.is_workspaced() {
        "m.category ASC, m.updated_at DESC, m.id ASC"
    } else {
        "COALESCE(m.importance, 50) DESC, m.id ASC"
    };
    let sql = format!(
        "SELECT m.id, m.project_path, m.category, m.content, m.importance, m.status, m.expires_at,
                m.superseded_by_memory_id, m.updated_at, m.last_seen_at, m.verified_at
           FROM memories m
          WHERE {predicate} AND m.status IN ('active','permanent')
            AND (m.expires_at IS NULL OR m.expires_at > ?4)
            AND NOT EXISTS (SELECT 1 FROM memory_placement p WHERE p.memory_id = m.id AND p.level <> 'project')
          ORDER BY {order}"
    );
    rows(conn, &sql, params![all, own, categories, PROOF_NOW])
}

fn new_project_memories(conn: &Connection, project: &str) -> Vec<String> {
    let workspace = crate::workspace::Workspace::resolve(conn, project).unwrap();
    workspace
        .memories(conn, PROOF_NOW)
        .unwrap()
        .into_iter()
        .map(|m| {
            format!(
                "{}|{}|{}|{}|{:?}|{}|{:?}|{:?}|{}|{:?}|{:?}",
                m.id,
                m.project_path,
                m.category,
                m.content,
                m.importance,
                m.status,
                m.expires_at,
                m.superseded_by_memory_id,
                m.updated_at,
                m.last_seen_at,
                m.verified_at
            )
        })
        .collect()
}

fn rows(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Vec<String> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map(params, |row| {
            Ok((0..columns)
                .map(|index| {
                    let value: rusqlite::types::Value = row.get(index)?;
                    Ok(match value {
                        rusqlite::types::Value::Null => "None".to_owned(),
                        rusqlite::types::Value::Integer(n) if [4, 6, 7, 9, 10].contains(&index) => {
                            format!("Some({n})")
                        }
                        rusqlite::types::Value::Integer(n) => n.to_string(),
                        rusqlite::types::Value::Text(text) => text,
                        other => format!("{other:?}"),
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()?
                .join("|"))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Memory ids full-text search returns for `query` in `project`, before
/// migration 106 (old predicate) or after it (the module's predicate).
fn fts_ids(conn: &Connection, project: &str, query: &str, migrated: bool) -> Vec<String> {
    let workspace = crate::workspace::Workspace::resolve(conn, project).unwrap();
    let [all, own, categories] = workspace.bindings();
    let predicate = if migrated {
        workspace.predicate(conn, "memories").unwrap()
    } else if categories != "null" {
        "(memories.project_path IN (SELECT value FROM json_each(?2)) OR
          (memories.project_path IN (SELECT value FROM json_each(?1)) AND
           memories.category IN (SELECT value FROM json_each(?3)) AND memories.shareable = 1
           AND memories.scope IN ('project','ecosystem','universe')))"
            .to_owned()
    } else {
        "memories.project_path IN (SELECT value FROM json_each(?1))".to_owned()
    };
    let sql = format!(
        "SELECT memories.id FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid
          WHERE {predicate} AND memories.status IN ('active','permanent')
            AND (memories.expires_at IS NULL OR memories.expires_at > ?4)
            AND memories_fts MATCH ?5
          ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT 50"
    );
    rows(conn, &sql, params![all, own, categories, PROOF_NOW, query])
}

/// A fixed time, so expiry reads the same on both sides.
const PROOF_NOW: i64 = 1_794_500_000_000;

/// Migration 106 changes nothing a session is sent: on a copy of a real
/// store's memory tables, every project's head memories, the user profile
/// and full-text search results are identical before and after. Run it on
/// the machine that holds the store, never on a build server:
/// `MC_MIGRATION_PROOF_SOURCE=<context.db> cargo test -p mc-module --lib
/// migration_106_is_invisible -- --ignored`. The source is attached
/// read-only.
#[test]
#[ignore = "needs a real context.db; run locally with MC_MIGRATION_PROOF_SOURCE"]
fn migration_106_is_invisible_on_a_real_store() {
    let source = std::env::var("MC_MIGRATION_PROOF_SOURCE").expect("MC_MIGRATION_PROOF_SOURCE");
    let mut conn = plugin_store();
    conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    conn.execute(
        "ATTACH DATABASE ?1 AS live",
        [format!("file:{source}?mode=ro")],
    )
    .unwrap();
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM main.sqlite_master WHERE type = 'table'
               AND (name LIKE 'workspace%' OR name IN ('memories', 'memory_placement',
                    'memory_mutation_log', 'memory_embeddings', 'memory_verifications',
                    'user_memories', 'user_memory_candidates', 'v22_identity_rekey_map',
                    'project_state'))",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for table in &tables {
        let columns: Vec<String> = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let list = columns
            .iter()
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ");
        conn.execute_batch(&format!(
            "INSERT INTO main.\"{table}\" ({list}) SELECT {list} FROM live.\"{table}\";"
        ))
        .unwrap_or_else(|error| panic!("copying {table}: {error}"));
    }
    conn.execute_batch(
        "UPDATE main.sqlite_sequence SET seq = (SELECT seq FROM live.sqlite_sequence WHERE name = 'memories')
          WHERE name = 'memories';
         DETACH DATABASE live;
         PRAGMA foreign_keys=ON;",
    )
    .unwrap();

    let projects: Vec<String> = conn
        .prepare("SELECT DISTINCT project_path FROM memories ORDER BY project_path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // A few words from each project's memories, as queries.
    let mut queries: Vec<(String, String)> = Vec::new();
    for project in &projects {
        let texts: Vec<String> = conn
            .prepare(
                "SELECT content FROM memories WHERE project_path = ?1 AND status = 'active'
                  ORDER BY id LIMIT 5",
            )
            .unwrap()
            .query_map([project], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for text in texts {
            let words: Vec<&str> = text
                .split(|ch: char| !ch.is_alphanumeric())
                .filter(|word| word.len() > 4)
                .take(2)
                .collect();
            if !words.is_empty() {
                queries.push((project.clone(), words.join(" OR ")));
            }
        }
        queries.push((project.clone(), "architecture OR constraints".to_owned()));
    }

    let before_memories: Vec<Vec<String>> = projects
        .iter()
        .map(|project| old_project_memories(&conn, project))
        .collect();
    let before_profile = rows(
        &conn,
        "SELECT id, content FROM user_memories WHERE status = 'active' ORDER BY promoted_at ASC, id ASC",
        [],
    );
    let before_search: Vec<Vec<String>> = queries
        .iter()
        .map(|(project, query)| fts_ids(&conn, project, query, false))
        .collect();

    let dangling = |conn: &Connection| -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    let dangling_before = dangling(&conn);
    let found = version(&conn);
    upgrade(&mut conn, found).unwrap();

    let after_memories: Vec<Vec<String>> = projects
        .iter()
        .map(|project| new_project_memories(&conn, project))
        .collect();
    let after_profile = rows(
        &conn,
        "SELECT COALESCE(json_extract(metadata_json, '$.user_memory_id'), id), content
           FROM memories WHERE level = 'global' AND status = 'active'
          ORDER BY COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at) ASC,
                   COALESCE(json_extract(metadata_json, '$.user_memory_id'), id) ASC",
        [],
    );
    let after_search: Vec<Vec<String>> = queries
        .iter()
        .map(|(project, query)| fts_ids(&conn, project, query, true))
        .collect();

    let shown: usize = before_memories.iter().map(Vec::len).sum();
    let hits: usize = before_search.iter().map(Vec::len).sum();
    println!(
        "{} projects, {shown} head memory rows, {} profile lines, {} searches with {hits} hits",
        projects.len(),
        before_profile.len(),
        queries.len()
    );
    for (index, project) in projects.iter().enumerate() {
        assert_eq!(
            before_memories[index], after_memories[index],
            "head memories differ for {project}"
        );
    }
    assert_eq!(before_profile, after_profile, "user profile differs");
    for (index, (project, query)) in queries.iter().enumerate() {
        assert_eq!(
            before_search[index], after_search[index],
            "search differs for {project}: {query}"
        );
    }
    // Every reference that resolved before still does.
    assert_eq!(dangling(&conn), dangling_before);
}
