#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

#[path = "support/context_db.rs"]
mod schema_fixture;

use magic_context_dashboard_lib::db;
use magic_context_dashboard_lib::project_identity::normalize_stored_project_path;
use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::tempdir;

/// A store at the schema version the dashboard reads.
fn make_db() -> Connection {
    schema_fixture::context_db_in_memory()
}

/// The session tables in the older shape that kept the memory block, its ids
/// and the cached prompt bytes on `session_meta`. Session fact edits and the
/// clear-all cache command still handle that shape; neither touches memories.
fn make_session_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open test db");
    conn.execute_batch(
        "CREATE TABLE session_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            session_facts_version INTEGER NOT NULL DEFAULT 0,
            memory_block_cache TEXT DEFAULT '',
            memory_block_ids TEXT DEFAULT '',
            cached_m0_bytes BLOB,
            cached_m1_bytes BLOB,
            cached_m0_max_memory_mutation_id INTEGER
        );",
    )
    .expect("create session schema");
    conn
}

fn audited_edit(
    conn: &mut Connection,
    ids: &[i64],
    field: &str,
    value: &str,
) -> Result<serde_json::Value, String> {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let project: String = conn
        .query_row(
            "SELECT owner_id FROM memories WHERE id=?1",
            [ids[0]],
            |row| row.get(0),
        )
        .unwrap();
    let expected = ids
        .iter()
        .map(
            |id| magic_context_dashboard_lib::memory_history::RevisionExpectation {
                memory_id: *id,
                revision: conn
                    .query_row("SELECT revision FROM memories WHERE id=?1", [id], |row| {
                        row.get(0)
                    })
                    .unwrap(),
            },
        )
        .collect::<Vec<_>>();
    let operation = format!(
        "test-{}",
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let request = magic_context_dashboard_lib::memory_bridge::edit_request(
        &project, &operation, ids, &expected, field, value,
    );
    match field {
        "content" => db::update_memory_content(conn, &request),
        "category" => db::update_memory_category(conn, &request),
        _ if ids.len() > 1 => db::bulk_update_memory_status(conn, &request),
        _ => db::update_memory_status(conn, &request),
    }
}

fn insert_memory(conn: &Connection, project_path: &str, status: &str) -> i64 {
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(id),0)+1 FROM memories", [], |row| {
            row.get(0)
        })
        .unwrap();
    let content = format!("memory {next} for {project_path}");
    schema_fixture::insert_project_memory(conn, project_path, "CONSTRAINTS", &content, status)
}

/// A user memory as ck-mc's migration 106 files one: a global memory.
fn insert_user_memory(conn: &Connection, content: &str, status: &str) -> i64 {
    conn.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content,
             normalized_hash, source_type, seen_count, retrieval_count, first_seen_at,
             created_at, updated_at, last_seen_at, status, metadata_json)
         VALUES ('global', 'self', 'mc:user-unsorted', 'USER_MEMORY', ?1, ?2, 'user-review',
             1, 0, 1, 1, 1, 1, ?3, '{\"promoted_at\":1,\"source_candidate_ids\":[]}')",
        params![content, schema_fixture::normalized_hash(content), status],
    )
    .expect("insert user memory");
    conn.last_insert_rowid()
}

fn memory_epoch(conn: &Connection, project_path: &str) -> i64 {
    conn.query_row(
        "SELECT project_memory_epoch FROM project_state WHERE project_path = ?1",
        params![project_path],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn project_state_rows(conn: &Connection) -> Vec<(String, i64)> {
    conn.prepare(
        "SELECT project_path, project_memory_epoch FROM project_state ORDER BY project_path",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn history_decisions(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(DISTINCT decision_key) FROM memory_history",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

/// The profile lines ck-mc puts in a session's prompt, read as its
/// `ContextDb::user_profile` reads them.
fn prompt_profile(conn: &Connection) -> Vec<String> {
    conn.prepare(
        "SELECT content FROM memories WHERE level = 'global' AND status = 'active'
          ORDER BY COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at) ASC,
                   COALESCE(json_extract(metadata_json, '$.user_memory_id'), id) ASC",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

type SessionCacheRow = (
    String,
    String,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    Option<i64>,
);

fn seed_project_state(conn: &Connection, project_path: &str, memory_epoch: i64) {
    conn.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, updated_at)
         VALUES (?1, ?2, 0)",
        params![project_path, memory_epoch],
    )
    .expect("seed project_state");
}

#[test]
fn archive_memory_status_is_audited_and_bumps_epoch() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9);
    seed_project_state(&conn, "git:other", 5);
    let receipt = audited_edit(&mut conn, &[id], "status", "archived").unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert_eq!(memory_epoch(&conn, "git:other"), 5);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM memory_history WHERE memory_id=?1",
            [id],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn restore_memory_status_keeps_epoch_bump() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "archived");
    seed_project_state(&conn, "git:project-a", 9);

    audited_edit(&mut conn, &[id], "status", "active").expect("restore status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert_eq!(history_decisions(&conn), 1);
}

#[test]
fn pin_active_to_permanent_bumps_epoch() {
    isolated_home();
    // Pinning changes what a session's prompt shows the next time ck-mc
    // rebuilds it from the store; the project's memory epoch moves once.
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9);

    audited_edit(&mut conn, &[id], "status", "permanent").expect("pin status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert_eq!(history_decisions(&conn), 1);
}

#[test]
fn unpin_permanent_to_active_bumps_epoch() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "permanent");
    seed_project_state(&conn, "git:project-a", 9);

    audited_edit(&mut conn, &[id], "status", "active").expect("unpin status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert_eq!(history_decisions(&conn), 1);
}

#[test]
fn no_op_status_change_does_not_bump_epoch() {
    isolated_home();
    // active -> active changes nothing; no bump, no history.
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9);

    audited_edit(&mut conn, &[id], "status", "active").expect("no-op status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 9);
    assert_eq!(history_decisions(&conn), 0);
}

#[test]
fn bulk_archive_status_has_one_audited_decision_and_one_epoch() {
    isolated_home();
    let mut conn = make_db();
    let first = insert_memory(&conn, "git:project-a", "active");
    let second = insert_memory(&conn, "git:project-a", "permanent");
    let other = insert_memory(&conn, "git:other", "active");
    seed_project_state(&conn, "git:project-a", 9);
    seed_project_state(&conn, "git:other", 5);
    let receipt = audited_edit(&mut conn, &[first, second], "status", "archived").unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(receipt["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert_eq!(memory_epoch(&conn, "git:other"), 5);
    assert_eq!(history_decisions(&conn), 1);
    assert_eq!(
        conn.query_row("SELECT status FROM memories WHERE id=?1", [other], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "active"
    );
}

#[test]
fn bulk_delete_archives_rows_in_one_undoable_decision() {
    isolated_home();
    let mut conn = make_db();
    let first = insert_memory(&conn, "git:project-a", "active");
    let second = insert_memory(&conn, "git:project-a", "active");
    let other = insert_memory(&conn, "git:other", "active");
    let ids = [first, second];
    let expected = ids
        .iter()
        .map(
            |id| magic_context_dashboard_lib::memory_history::RevisionExpectation {
                memory_id: *id,
                revision: 1,
            },
        )
        .collect::<Vec<_>>();
    let request = magic_context_dashboard_lib::memory_bridge::edit_request(
        "git:project-a",
        "delete",
        &ids,
        &expected,
        "status",
        "archived",
    );
    let receipt = db::bulk_delete_memory(&mut conn, &request).unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(memory_epoch(&conn, "git:project-a"), 1);
    assert_eq!(memory_epoch(&conn, "git:other"), 0);
    for id in ids {
        assert_eq!(
            conn.query_row("SELECT status FROM memories WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "archived"
        );
    }
    assert_eq!(
        conn.query_row("SELECT status FROM memories WHERE id=?1", [other], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "active"
    );
    let undo = json!({ "projectPath":"git:project-a", "operationId":"undo-delete", "decisionKey":receipt["decisionKey"], "expectedRevisions":receipt["revisions"] });
    let restored = magic_context_dashboard_lib::memory_bridge::local_request(
        &mut conn,
        "memory.restore",
        &undo,
    )
    .unwrap();
    assert_eq!(restored["state"], "applied");
    // Replaying an old durable receipt must remain valid after the render policy changes.
    let mut legacy_receipt = restored.clone();
    legacy_receipt["adoption"] = json!("dashboard_epoch_hard");
    assert!(magic_context_dashboard_lib::memory_history::valid_receipt(
        "memory.restore",
        &undo,
        &legacy_receipt
    ));
    assert_eq!(history_decisions(&conn), 2);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 2);
    for id in ids {
        assert_eq!(
            conn.query_row("SELECT status FROM memories WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "active"
        );
    }
}

#[test]
fn dismiss_user_memory_leaves_project_memory_epochs_alone() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_user_memory(&conn, "remember me", "active");
    seed_project_state(&conn, "git:project-a", 4);

    db::dismiss_user_memory(&mut conn, id).expect("dismiss");

    // ck-mc reads the profile from the rows, so nothing else is signalled.
    assert!(prompt_profile(&conn).is_empty());
    assert_eq!(project_state_rows(&conn), [("git:project-a".to_owned(), 4)]);
}

#[test]
fn dismiss_user_memory_again_or_unknown_id_is_a_no_op() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_user_memory(&conn, "remember me", "active");
    seed_project_state(&conn, "git:project-a", 4);

    db::dismiss_user_memory(&mut conn, id).expect("dismiss");
    let dismissed = db::get_user_memories(&conn, Some("dismissed")).expect("dismissed set");
    assert_eq!(dismissed.len(), 1);
    let updated_at = dismissed[0].updated_at;
    let revision: i64 = conn
        .query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(revision, 2);

    // Let the millisecond clock advance so a redundant timestamp write is observable.
    std::thread::sleep(std::time::Duration::from_millis(2));
    for dismiss_id in [id, id + 1] {
        db::dismiss_user_memory(&mut conn, dismiss_id).expect("no-op dismiss");

        let memories = db::get_user_memories(&conn, None).expect("user memories");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].id, id);
        assert_eq!(memories[0].status, "dismissed");
        assert_eq!(memories[0].updated_at, updated_at);
        assert_eq!(
            conn.query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            revision
        );
        assert_eq!(project_state_rows(&conn), [("git:project-a".to_owned(), 4)]);
    }
}

#[test]
fn restore_user_memory_returns_row_to_active_set() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_user_memory(&conn, "remember me", "dismissed");
    seed_project_state(&conn, "git:project-a", 4);

    db::restore_user_memory(&mut conn, id).expect("restore");

    // The restored row is back in the active set the prompt's profile reads.
    let active = db::get_user_memories(&conn, Some("active")).expect("active set");
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, id);
    assert_eq!(prompt_profile(&conn), ["remember me"]);
    assert_eq!(project_state_rows(&conn), [("git:project-a".to_owned(), 4)]);
}

#[test]
fn restore_user_memory_of_active_row_is_a_no_op() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_user_memory(&conn, "remember me", "active");

    // The status predicate leaves a row that is already active untouched.
    db::restore_user_memory(&mut conn, id).expect("restore active row");

    let active = db::get_user_memories(&conn, Some("active")).expect("active set");
    assert_eq!(active.len(), 1);
    let (updated_at, revision): (i64, i64) = conn
        .query_row(
            "SELECT updated_at, revision FROM memories WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("updated_at");
    assert_eq!((updated_at, revision), (1, 1));
    assert!(project_state_rows(&conn).is_empty());
}

#[test]
fn promote_user_memory_candidate_files_a_global_memory() {
    isolated_home();
    let mut conn = make_db();
    conn.execute(
        "INSERT INTO memory_observations
           (content, session_id, source_start_ordinal, source_end_ordinal, created_at)
         VALUES ('stable preference', 'session-1', 10, 20, 1)",
        [],
    )
    .expect("insert candidate");
    let candidate_id = conn.last_insert_rowid();

    db::promote_user_memory_candidate(&mut conn, candidate_id).expect("promote");

    let row: (String, String, String, String, String, String) = conn
        .query_row(
            "SELECT content, status, level, owner_id, category, json_extract(metadata_json, '$.source_candidate_ids')
               FROM memories",
            [],
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
        .expect("promoted row");
    assert_eq!(
        row,
        (
            "stable preference".to_string(),
            "active".to_string(),
            "global".to_string(),
            "self".to_string(),
            "mc:user-unsorted".to_string(),
            format!("[{candidate_id}]")
        )
    );
    let remaining_candidates: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_observations", [], |row| {
            row.get(0)
        })
        .expect("candidate count");
    assert_eq!(remaining_candidates, 0);
    assert_eq!(prompt_profile(&conn), ["stable preference"]);
    assert!(project_state_rows(&conn).is_empty());
}

#[test]
fn session_fact_update_and_delete_bump_session_facts_version() {
    isolated_home();
    let mut conn = make_session_db();
    conn.execute("INSERT INTO session_meta (session_id) VALUES ('s1')", [])
        .expect("insert meta");
    conn.execute(
        "INSERT INTO session_facts (session_id, category, content, created_at, updated_at)
         VALUES ('s1', 'fact', 'old', 1, 1)",
        [],
    )
    .expect("insert fact");
    let fact_id = conn.last_insert_rowid();

    let affected = db::update_session_fact(&mut conn, fact_id, "new").expect("update fact");
    assert_eq!(affected, 1);
    assert_eq!(session_fact_version(&conn, "s1"), 1);

    let affected = db::delete_session_fact(&mut conn, fact_id).expect("delete fact");
    assert_eq!(affected, 1);
    assert_eq!(session_fact_version(&conn, "s1"), 2);
}

fn session_fact_version(conn: &Connection, session_id: &str) -> i64 {
    conn.query_row(
        "SELECT session_facts_version FROM session_meta WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .expect("session_facts_version")
}

/// The cached prompt state of session `s1`: its mutation cursor on
/// `session_meta` and its cached prompt payloads.
fn cached_prompt_state(conn: &Connection) -> (Option<i64>, Vec<(String, Vec<u8>)>) {
    let cursor = conn
        .query_row(
            "SELECT cached_m0_max_memory_mutation_id FROM session_meta WHERE session_id = 's1'",
            [],
            |row| row.get(0),
        )
        .expect("session meta");
    let payloads = conn
        .prepare("SELECT cache_key, value FROM session_render_cache WHERE session_id = 's1' ORDER BY cache_key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    (cursor, payloads)
}

#[test]
fn routine_memory_mutation_does_not_clear_memory_block_caches() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    conn.execute_batch(
        "INSERT INTO session_meta(session_id,harness,last_response_time,cache_ttl,counter,last_nudge_tokens,last_nudge_band,last_transform_error,is_subagent,last_context_percentage,last_input_tokens,observed_safe_input_tokens,cache_alert_sent,times_execute_threshold_reached,compartment_in_progress,system_prompt_hash,cleared_reasoning_through_tag,cached_m0_max_memory_mutation_id)
             VALUES('s1','opencode',0,'5m',0,0,'','',0,0,0,0,0,0,0,'',0,42);
         INSERT INTO session_render_cache(session_id,cache_key,value)
             VALUES('s1','cached_m0_bytes',X'010203'),('s1','cached_m1_bytes',X'040506'),
                   ('s1','memory_block_cache',CAST('cached-body' AS BLOB));",
    )
    .expect("insert session cache");
    let before = cached_prompt_state(&conn);
    assert_eq!(before.0, Some(42));
    assert_eq!(before.1.len(), 3);

    audited_edit(&mut conn, &[id], "status", "archived").expect("update status");

    assert_eq!(cached_prompt_state(&conn), before);
}

#[test]
fn bulk_update_refuses_invalid_status_without_sql_side_effects() {
    isolated_home();
    let mut conn = make_db();
    let target = insert_memory(&conn, "git:project-a", "active");
    let other = insert_memory(&conn, "git:project-a", "active");
    let receipt = audited_edit(
        &mut conn,
        &[target],
        "status",
        "archived'; DELETE FROM memories; --",
    )
    .unwrap();
    assert_eq!(receipt["state"], "refused");
    assert_eq!(receipt["reason"], "invalid_request");
    for id in [target, other] {
        assert_eq!(
            conn.query_row("SELECT status FROM memories WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "active"
        );
    }
}

#[test]
fn update_memory_content_has_history_and_epoch() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 11);
    let receipt = audited_edit(&mut conn, &[id], "content", "new dashboard content").unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(memory_epoch(&conn, "git:project-a"), 12);
    assert_eq!(history_decisions(&conn), 1);
    let (revision, hash): (i64, String) = conn
        .query_row(
            "SELECT revision, normalized_hash FROM memories WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(revision, 2);
    assert_eq!(
        hash,
        schema_fixture::normalized_hash("new dashboard content")
    );
}

#[test]
fn invalidate_all_memory_block_caches_clears_m0_m1_and_mutation_cursor() {
    isolated_home();
    let conn = make_session_db();
    conn.execute(
        "INSERT INTO session_meta
           (session_id, session_facts_version, memory_block_cache, memory_block_ids, cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_mutation_id)
         VALUES ('s1', 0, 'cached-body', '1,2,3', X'010203', X'040506', 42)",
        [],
    )
    .expect("insert session meta");

    let affected = db::invalidate_all_memory_block_caches(&conn).expect("invalidate caches");

    assert_eq!(affected, 1);
    let row: SessionCacheRow = conn
        .query_row(
            "SELECT memory_block_cache, memory_block_ids, cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_mutation_id FROM session_meta WHERE session_id = 's1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("session cache row");
    assert_eq!(row, ("".to_string(), "".to_string(), None, None, None));
}

#[test]
fn raw_path_memory_mutation_uses_directory_fallback_identity() {
    isolated_home();
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("context.db");
    schema_fixture::create_test_context_db(&db_path);
    let raw_project = tempfile::tempdir().expect("raw project");
    let raw_project_path = raw_project.path().to_str().expect("utf8 path").to_string();
    let memory_id = {
        let conn = Connection::open(&db_path).expect("open db file");
        insert_memory(&conn, &raw_project_path, "archived")
    };

    let mut conn = Connection::open(&db_path).expect("open db file");
    audited_edit(&mut conn, &[memory_id], "status", "active").expect("restore memory");

    let expected_identity = normalize_stored_project_path(&raw_project_path);
    assert_eq!(memory_epoch(&conn, &expected_identity), 1);
}

#[test]
fn get_smart_notes_tolerates_null_project_path_rows() {
    isolated_home();
    // Regression: the notes table holds session-scoped notes with a NULL
    // project_path (most notes). resolve_paths_for_table_filter did
    // `SELECT DISTINCT project_path` into a non-Option String and threw
    // "Invalid column type Null at index: 0, name: project_path", crashing the
    // entire session-detail view. It must skip NULL rows instead.
    let conn = make_db();
    // A session note with NULL project_path (the common case) ...
    conn.execute(
        "INSERT INTO notes (type, status, content, session_id, project_path, created_at, updated_at)
         VALUES ('note', 'active', 'session note', 'ses_x', NULL, 1, 1)",
        [],
    )
    .expect("insert null-path note");
    // ... and a real smart note under a resolved identity.
    conn.execute(
        "INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at)
         VALUES ('smart', 'ready', 'smart note', 'ses_y', 'git:abc123', 'when X', 2, 2)",
        [],
    )
    .expect("insert smart note");

    // Must not error on the NULL row, and must return the smart note.
    let notes = db::get_smart_notes(&conn, "git:abc123").expect("get_smart_notes must not crash");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].content, "smart note");
}

/// `(origin_category, category)`: the tag a memory shows under and the
/// profile category it is filed under.
fn filed_under(conn: &Connection, id: i64) -> (String, String) {
    conn.query_row(
        "SELECT origin_category, category FROM memories WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("get category")
}

#[test]
fn test_update_memory_category_success() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 11);

    audited_edit(&mut conn, &[id], "category", "NAMING").expect("update category");

    // The tag and the category it maps to move together.
    assert_eq!(
        filed_under(&conn, id),
        ("NAMING".to_owned(), "swe:naming".to_owned())
    );

    // The project's memory epoch moves once for the edit, as it did for the
    // 0.49 plugin's stores; ck-mc itself reads the changed row.
    assert_eq!(memory_epoch(&conn, "git:project-a"), 12);
    assert_eq!(history_decisions(&conn), 1);
}

#[test]
fn update_memory_category_noop_does_not_bump_epoch() {
    isolated_home();
    // Changing a memory to its CURRENT category must not bump any epoch (that
    // would force a needless hard fold across every workspace member).
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    // Re-setting a memory to its existing category must be a no-op.
    let (current, _) = filed_under(&conn, id);
    seed_project_state(&conn, "git:project-a", 5);

    audited_edit(&mut conn, &[id], "category", &current).expect("noop category update");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 5);
    assert_eq!(history_decisions(&conn), 0);
}

#[test]
fn test_update_memory_category_collision() {
    isolated_home();
    let mut conn = make_db();
    // Two live memories with the same text, filed under different categories.
    let id1 = schema_fixture::insert_project_memory(
        &conn,
        "git:project-a",
        "CONSTRAINTS",
        "same content",
        "active",
    );
    schema_fixture::insert_project_memory(
        &conn,
        "git:project-a",
        "NAMING",
        "same content",
        "active",
    );

    // Moving the first into the second's category would make two live copies.
    let receipt = audited_edit(&mut conn, &[id1], "category", "NAMING").unwrap();
    assert_eq!(receipt["state"], "conflict");
    assert_eq!(receipt["reason"], "duplicate_content");

    // Verify Memory 1's category was NOT changed
    assert_eq!(
        filed_under(&conn, id1),
        ("CONSTRAINTS".to_owned(), "swe:constraints".to_owned())
    );
}

#[test]
fn test_update_memory_category_invalid() {
    isolated_home();
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");

    let receipt = audited_edit(&mut conn, &[id], "category", "INVALID_CATEGORY").unwrap();
    assert_eq!(receipt["state"], "refused");
    assert_eq!(receipt["reason"], "invalid_request");

    // Verify category was NOT changed
    assert_eq!(
        filed_under(&conn, id),
        ("CONSTRAINTS".to_owned(), "swe:constraints".to_owned())
    );
}

#[test]
fn managed_memory_update_is_refused_for_a_module_owned_project() {
    isolated_home();
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("context.db");
    schema_fixture::create_test_context_db(&path);
    {
        let conn = Connection::open(&path).expect("open context db");
        conn.execute(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at)
             VALUES ('/managed', 'store', 0)",
            [],
        )
        .expect("mark the project module-owned");
        schema_fixture::insert_project_memory(&conn, "/managed", "CONSTRAINTS", "old", "active");
    }

    let mut conn = db::open_readwrite(&path).expect("open managed context db");
    let receipt = audited_edit(&mut conn, &[1], "content", "new").unwrap();
    assert_eq!(receipt["state"], "refused");
    assert_eq!(receipt["reason"], "authority_unavailable");
    let content: String = conn
        .query_row("SELECT content FROM memories WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(content, "old");
    assert_eq!(history_decisions(&conn), 0);
}
