use magic_context_dashboard_lib::{db, db_capabilities, memory_bridge, memory_history, workspaces};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[path = "support/context_db.rs"]
mod schema_fixture;

fn fixture(version: i64) -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    if version == 105 {
        schema_fixture::create_test_context_db(&path);
    } else {
        Connection::open(&path)
            .unwrap()
            .execute_batch(include_str!("fixtures/context-v95.sql"))
            .unwrap();
    }
    let conn = Connection::open(&path).unwrap();
    for (id, content) in [
        (1, "cache_ttl=5m"),
        (2, "test with bun"),
        (3, "use strict types"),
    ] {
        conn.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_type,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,'git:compat','CONFIG_VALUES',?2,?3,'agent',50,'project',1,'active',1,1,1,1)", params![id,content,memory_history::normalized_hash(content)]).unwrap();
    }
    conn.execute("INSERT INTO session_meta(session_id,harness,last_response_time,cache_ttl,counter,last_nudge_tokens,last_nudge_band,last_transform_error,is_subagent,last_context_percentage,last_input_tokens,observed_safe_input_tokens,cache_alert_sent,times_execute_threshold_reached,compartment_in_progress,system_prompt_hash,cleared_reasoning_through_tag) VALUES('compat','pi',0,'5m',0,0,'','',0,0,0,0,0,0,0,'',0)", []).unwrap();
    conn.execute("INSERT INTO compartments(id,session_id,sequence,start_message,end_message,title,content,p1,importance,created_at,harness) VALUES(1,'compat',0,1,4,'one','P1','P1',75,100,'pi')", []).unwrap();
    (directory, path)
}

fn edit(ids: &[i64], field: &str, value: &str, revision: i64, operation: &str) -> Value {
    memory_bridge::edit_request(
        "git:compat",
        operation,
        ids,
        &ids.iter()
            .map(|&memory_id| memory_history::RevisionExpectation {
                memory_id,
                revision,
            })
            .collect::<Vec<_>>(),
        field,
        value,
    )
}

#[test]
fn capability_cache_is_connection_local_and_objects_override_ledger() {
    let (_directory, path) = fixture(95);
    let conn = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&conn).unwrap();
    assert_eq!(caps.schema_version, 95);
    assert!(
        !caps.memory_history
            && !caps.memory_revision
            && !caps.memory_undo
            && !caps.compartment_scores
    );
    assert!(caps.legacy_memory_edits);
    let writer = Connection::open(&path).unwrap();
    writer
        .execute("UPDATE schema_migrations SET version=105", [])
        .unwrap();
    assert_eq!(db_capabilities::get(&conn).unwrap().schema_version, 95);
    let fresh = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&fresh).unwrap();
    assert_eq!(caps.schema_version, 105);
    assert!(!caps.memory_history && !caps.compartment_scores && !caps.legacy_memory_edits);
    let persistent: i64 = writer
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='dashboard_capabilities'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persistent, 0);
}

#[test]
fn both_schemas_list_memories_sessions_compartments_workspaces_and_projects() {
    for version in [95, 105] {
        let (_directory, path) = fixture(version);
        if version == 95 {
            // An older daemon store need not have the new score-view metadata.
            Connection::open(path.with_file_name("store.db"))
                .unwrap()
                .execute_batch("CREATE TABLE legacy_store(id INTEGER)")
                .unwrap();
        }
        let mut conn = db::open_readwrite(&path).unwrap();
        let caps = db_capabilities::get(&conn).unwrap();
        assert_eq!(caps.schema_version, version);
        assert_eq!(caps.memory_history, version == 105);
        assert_eq!(caps.memory_undo, version == 105);
        assert_eq!(caps.compartment_scores, version == 105);
        for search in [None, Some("cache"), Some("ca"), Some("#1")] {
            let rows =
                db::get_memories(&conn, Some("git:compat"), None, None, None, search, 100, 0)
                    .unwrap();
            assert!(!rows.is_empty(), "schema {version}, search {search:?}");
            assert_eq!(rows[0].revision, 1);
        }
        assert_eq!(db::get_memory_stats(&conn, None, None).unwrap().total, 3);
        assert_eq!(db::get_sessions(&conn).unwrap().len(), 1);
        assert!(db::get_session_meta(&conn, "compat").unwrap().is_some());
        assert!(db::get_session_facts(&conn, "compat").unwrap().is_empty());
        assert!(db::get_session_notes(&conn, "compat").unwrap().is_empty());
        let compartments = db::get_compartments(&conn, "compat").unwrap();
        assert_eq!(compartments.len(), 1);
        assert_eq!(compartments[0].importance, 75);
        assert_eq!(compartments[0].effective_importance, None);
        assert_eq!(compartments[0].applied_importance, None);
        let workspace = workspaces::create_workspace(&mut conn, "Compatibility").unwrap();
        workspaces::apply_workspace_changes(
            &mut conn,
            workspace,
            None,
            vec![workspaces::WorkspaceMemberChange {
                project_path: "git:compat".into(),
                display_name: "Compat".into(),
                display_path: "/compat".into(),
            }],
            vec![],
            vec![],
            vec!["CONSTRAINTS".into()],
        )
        .unwrap();
        assert_eq!(
            workspaces::list_workspace_summaries(&conn).unwrap().len(),
            1
        );
        assert_eq!(workspaces::list_workspaces(&conn).unwrap().len(), 1);
        assert_eq!(
            db::get_memories(&conn, None, Some(workspace), None, None, None, 100, 0)
                .unwrap()
                .len(),
            3
        );
        assert!(!db::get_projects(&conn).unwrap().is_empty());
        assert!(!db::enumerate_memory_projects(&conn).unwrap().is_empty());
        // Project cards come from external host sessions, not context.db memories.
        // This fixture has no external session files; memory project pickers do.
        assert!(db::get_project_cards(&conn).is_empty());
    }
}

#[tokio::test]
async fn schema95_edit_archive_bulk_archive_keep_legacy_side_effects_without_history() {
    let (_directory, path) = fixture(95);
    let mut conn = db::open_readwrite(&path).unwrap();
    conn.execute(
        "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(1,X'00','test')",
        [],
    )
    .unwrap();
    let receipt = db::update_memory_content(
        &mut conn,
        &edit(&[1], "content", "cache_ttl=10m", 1, "content"),
    )
    .unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(receipt["decisionKey"], Value::Null);
    assert_eq!(receipt["revisions"], json!([]));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT shareable FROM memories WHERE id=1", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT new_content FROM memory_mutation_log WHERE mutation_type='update'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "cache_ttl=10m"
    );
    // A category edit keeps the stored unique key, even when an older writer
    // used a different hash. Rehashing here can invent a false collision.
    conn.execute(
        "UPDATE memories SET normalized_hash='legacy-opaque-key' WHERE id=1",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE memories SET category='CONSTRAINTS',normalized_hash=?1 WHERE id=2",
        [memory_history::normalized_hash("cache_ttl=10m")],
    )
    .unwrap();
    db::update_memory_category(
        &mut conn,
        &edit(&[1], "category", "CONSTRAINTS", 1, "category"),
    )
    .unwrap();
    let epoch = || {
        conn.query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path='git:compat'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(epoch(), 1);
    db::update_memory_status(&mut conn, &edit(&[1], "status", "permanent", 1, "pin")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path='git:compat'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    db::delete_memory(&mut conn, &edit(&[1], "status", "archived", 1, "archive")).unwrap();
    db::bulk_delete_memory(&mut conn, &edit(&[2, 3], "status", "archived", 1, "bulk")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status='archived'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM memory_mutation_log WHERE mutation_type='archive'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    db::bulk_update_memory_status(
        &mut conn,
        &edit(&[2, 3], "status", "active", 1, "restore-status"),
    )
    .unwrap();
    drop(conn);
    // Exercise the same asynchronous router used by both desktop and HTTP commands.
    assert_eq!(
        db::memory_request(
            &path,
            "memory.edit",
            edit(&[1], "content", "cache_ttl=15m", 1, "async")
        )
        .await
        .unwrap()["state"],
        "applied"
    );
}

#[tokio::test]
async fn schema95_history_and_undo_are_refused_before_later_schema_queries() {
    let (_directory, path) = fixture(95);
    for (method, request) in [
        ("memory.history", json!({"projectPath":"git:compat"})),
        (
            "memory.restore.preview",
            json!({"projectPath":"git:compat","decisionKey":"missing"}),
        ),
        (
            "memory.restore",
            json!({"projectPath":"git:compat","decisionKey":"missing","operationId":"undo","expectedRevisions":[{"memoryId":1,"revision":1}]}),
        ),
    ] {
        assert_eq!(
            db::memory_request(&path, method, request)
                .await
                .unwrap_err(),
            db_capabilities::HISTORY_UNAVAILABLE
        );
    }
    let mut conn = db::open_readwrite(&path).unwrap();
    let request = memory_history::HistoryRequest {
        project_path: "git:compat".into(),
        memory_id: None,
        limit: None,
        cursor: None,
    };
    assert_eq!(
        memory_history::history(&conn, &request).unwrap_err(),
        db_capabilities::HISTORY_UNAVAILABLE
    );
    assert_eq!(
        memory_history::preview(
            &conn,
            "git:compat",
            "missing",
            100,
            memory_history::MemoryWriter::Local
        )
        .unwrap_err(),
        db_capabilities::HISTORY_UNAVAILABLE
    );
    assert_eq!(
        memory_history::local_write(&mut conn, &edit(&[1], "content", "x", 1, "x"), 100)
            .unwrap_err(),
        db_capabilities::HISTORY_UNAVAILABLE
    );
}

#[tokio::test]
async fn schema105_edits_reject_stale_revisions_and_keep_history_undo_and_safety() {
    let (_directory, path) = fixture(105);
    let conn = Connection::open(&path).unwrap();
    conn.execute("UPDATE memories SET safety_critical=1 WHERE id=1", [])
        .unwrap();
    drop(conn);
    let receipt = db::memory_request(
        &path,
        "memory.edit",
        edit(&[1], "content", "cache_ttl=10m", 1, "modern"),
    )
    .await
    .unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(receipt["revisions"][0]["revision"], 2);
    assert_eq!(
        db::memory_request(
            &path,
            "memory.edit",
            edit(&[1], "content", "stale", 1, "stale")
        )
        .await
        .unwrap()["state"],
        "conflict"
    );
    let history = db::memory_request(&path, "memory.history", json!({"projectPath":"git:compat"}))
        .await
        .unwrap();
    assert_eq!(history["decisions"].as_array().unwrap().len(), 1);
    let preview = db::memory_request(
        &path,
        "memory.restore.preview",
        json!({"projectPath":"git:compat","decisionKey":receipt["decisionKey"]}),
    )
    .await
    .unwrap();
    assert_eq!(preview["state"], "ready");
    let restored = db::memory_request(&path,"memory.restore",json!({"projectPath":"git:compat","decisionKey":receipt["decisionKey"],"operationId":"undo","expectedRevisions":[{"memoryId":1,"revision":2}]})).await.unwrap();
    assert_eq!(restored["state"], "applied");
    let conn = db::open_readonly(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT content,safety_critical,revision FROM memories WHERE id=1",
            [],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?
            ))
        )
        .unwrap(),
        ("cache_ttl=5m".into(), 1, 3)
    );
    drop(conn);
    for (ids, field, value, revision, operation) in [
        (vec![1], "category", "CONSTRAINTS", 3, "category"),
        (vec![1], "status", "permanent", 4, "pin"),
        (vec![1], "status", "archived", 5, "archive"),
        (vec![2, 3], "status", "archived", 1, "bulk"),
    ] {
        let result = db::memory_request(
            &path,
            "memory.edit",
            edit(&ids, field, value, revision, operation),
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "applied");
        assert!(result["decisionKey"].is_string());
    }
    let conn = db::open_readonly(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status='archived'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}

#[tokio::test]
async fn partial_modern_schema_never_uses_legacy_writer() {
    let (_directory, path) = fixture(95);
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        [],
    )
    .unwrap();
    drop(conn);
    let result = db::memory_request(
        &path,
        "memory.edit",
        edit(&[1], "content", "must not save", 1, "partial"),
    )
    .await;
    assert!(result.is_err());
    let conn = db::open_readonly(&path).unwrap();
    assert!(!db_capabilities::get(&conn).unwrap().legacy_memory_edits);
    assert_eq!(
        conn.query_row("SELECT content FROM memories WHERE id=1", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "cache_ttl=5m"
    );
}

#[tokio::test]
async fn missing_safety_column_disables_modern_writes_without_legacy_fallback() {
    let (_directory, path) = fixture(105);
    Connection::open(&path)
        .unwrap()
        .execute("ALTER TABLE memories DROP COLUMN safety_critical", [])
        .unwrap();
    let conn = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&conn).unwrap();
    assert!(caps.memory_history);
    assert!(!caps.memory_undo && !caps.legacy_memory_edits);
    assert_eq!(
        db::memory_request(
            &path,
            "memory.edit",
            edit(&[1], "content", "must not save", 1, "missing-safety")
        )
        .await
        .unwrap_err(),
        db_capabilities::HISTORY_UNAVAILABLE
    );
}

#[test]
fn score_capability_requires_watermark_column_and_does_not_query_partial_tables() {
    let (_directory, path) = fixture(95);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE compartment_score_selections(session_id TEXT,compartment_id INTEGER,sequence INTEGER,revision_id INTEGER);
        CREATE TABLE compartment_score_revisions(id INTEGER,session_id TEXT,compartment_id INTEGER,source_identity TEXT,new_importance INTEGER);
        INSERT INTO compartment_score_selections VALUES('compat',1,1,1);
        INSERT INTO compartment_score_revisions VALUES(1,'compat',1,'mismatch',10);").unwrap();
    let conn = db::open_readonly(&path).unwrap();
    assert!(!db_capabilities::get(&conn).unwrap().compartment_scores);
    let rows = db::get_compartments(&conn, "compat").unwrap();
    assert_eq!(rows[0].importance, 75);
    assert_eq!(rows[0].effective_importance, None);
    assert_eq!(rows[0].applied_importance, None);
}

#[test]
fn schema105_compartments_keep_effective_and_applied_scores_separate() {
    let (_directory, path) = fixture(105);
    let conn = db::open_readwrite(&path).unwrap();
    // Encode this fixture row explicitly so a bug in score identity construction
    // cannot change both the stored revision and the value being checked.
    let identity = format!("{:x}", Sha256::digest(b"mc-rescore-source-v1\0I1;S6:compat;I100;S3:one;N;I0;N;S2:P1;N;N;N;I0;I1;I4;S0:;S0:;N;N;I75;"));
    conn.execute("INSERT INTO compartment_score_revisions(id,compartment_id,session_id,source_identity,old_importance,new_importance,rubric_version,prompt_hash,model,seed_ids,job_id,batch_id,attempt_id,completed_at,reason) VALUES(1,1,'compat',?1,75,10,1,'prompt','test','[]','job','batch','attempt',100,'revised')", [identity]).unwrap();
    conn.execute("INSERT INTO compartment_score_selections(session_id,compartment_id,sequence,revision_id,origin,job_id,batch_id,attempt_id) VALUES('compat',1,1,1,'publication','job','batch','attempt')", []).unwrap();
    let rows = db::get_compartments(&conn, "compat").unwrap();
    assert_eq!(rows[0].importance, 75);
    assert_eq!(rows[0].effective_importance, Some(10));
    assert_eq!(rows[0].applied_importance, Some(75));
    conn.execute(
        "UPDATE session_meta SET cached_m0_score_selection_watermark=1 WHERE session_id='compat'",
        [],
    )
    .unwrap();
    assert_eq!(
        db::get_compartments(&conn, "compat").unwrap()[0].applied_importance,
        Some(10)
    );
}
