#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use magic_context_dashboard_lib::{db, db_capabilities, memory_bridge, memory_history, workspaces};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[path = "support/context_db.rs"]
mod schema_fixture;

/// A store at the version the dashboard reads, holding three project
/// memories, one session and one compartment.
fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    schema_fixture::create_test_context_db(&path);
    let conn = Connection::open(&path).unwrap();
    for (id, content) in [
        (1, "cache_ttl=5m"),
        (2, "test with bun"),
        (3, "use strict types"),
    ] {
        conn.execute("INSERT INTO memories(id,level,owner_id,category,origin_category,content,normalized_hash,source_type,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,'project','git:compat','swe:config-values','CONFIG_VALUES',?2,?3,'agent',50,'project',1,'active',1,1,1,1)", params![id,content,memory_history::normalized_hash(content)]).unwrap();
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

/// The dashboard's copy of migration 106 is ck-mc's: every copied statement,
/// the memory columns, the live predicate, the version and its description
/// appear, whitespace aside, in `context_migrations.rs`, and so do the tag map
/// the dashboard files edited memories under and the shape of a user memory.
#[test]
fn copied_ddl_is_the_module_migration() {
    isolated_home();
    let squash = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let module = squash(schema_fixture::MODULE_MIGRATIONS);
    let found = |fragment: &str| module.contains(&squash(fragment));
    for statement in schema_fixture::MIGRATION_106.iter().chain(&[
        schema_fixture::COPY_MEMORIES,
        schema_fixture::KEEP_SEQUENCE,
        schema_fixture::MOVE_USER_MEMORY,
        schema_fixture::COPY_OBSERVATIONS,
    ]) {
        assert!(
            found(statement),
            "ck-mc's migration 106 has no statement {statement}"
        );
    }
    for declaration in [
        format!(
            "const MEMORY_COLUMNS: &str = \"{}\";",
            schema_fixture::MEMORY_COLUMNS
        ),
        format!(
            "const KEPT_COLUMNS: &str = \"{}\";",
            schema_fixture::KEPT_COLUMNS
        ),
        format!("const LIVE: &str = \"{}\";", schema_fixture::LIVE),
        format!(
            "pub const SCHEMA_VERSION: u32 = {};",
            db_capabilities::MEMORY_SCHEMA_VERSION
        ),
        format!(
            "version: {}, description: \"{}\",",
            db_capabilities::MEMORY_SCHEMA_VERSION,
            schema_fixture::MIGRATION_106_DESCRIPTION
        ),
        format!(
            "const CATEGORY_IDS: [(&str, &str); {}] = [",
            memory_history::CATEGORY_IDS.len()
        ),
        format!(
            "pub const UNMAPPED_CATEGORY: &str = \"{}\";",
            memory_history::UNMAPPED_CATEGORY
        ),
        "format!(\" WHEN '{tag}' THEN '{id}'\")".to_owned(),
        "format!(\"CASE {column}{arms} ELSE '{UNMAPPED_CATEGORY}' END\")".to_owned(),
        "case = category_case(\"m.category\"),".to_owned(),
        "pub const USER_UNSORTED_CATEGORY: &str = \"mc:user-unsorted\";".to_owned(),
        "pub const USER_MEMORY_TAG: &str = \"USER_MEMORY\";".to_owned(),
        "\"user_memory_id\": id, \"promoted_at\": promoted_at,".to_owned(),
        "metadata[\"source_candidate_ids\"]".to_owned(),
    ] {
        assert!(
            found(&declaration),
            "ck-mc's migration has no {declaration}"
        );
    }
    assert_eq!(schema_fixture::CATEGORY_IDS, memory_history::CATEGORY_IDS);
    for (tag, id) in memory_history::CATEGORY_IDS {
        assert!(found(&format!("(\"{tag}\", \"{id}\"),")), "{tag} -> {id}");
        assert_eq!(memory_history::frozen_category_id(tag), id);
    }
    assert_eq!(
        memory_history::frozen_category_id("TEST_COVERAGE"),
        memory_history::UNMAPPED_CATEGORY
    );
}

#[test]
fn capability_cache_is_connection_local_and_objects_override_ledger() {
    isolated_home();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    schema_fixture::create_plugin_context_db(&path);
    let conn = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&conn).unwrap();
    assert_eq!(caps.schema_version, 105);
    assert!(caps.memory_revision && caps.compartment_scores);
    assert!(!caps.memory_history && !caps.memory_undo);
    // ck-mc upgrades the store while the dashboard holds a connection.
    let writer = Connection::open(&path).unwrap();
    schema_fixture::upgrade_plugin_store(&writer);
    assert_eq!(db_capabilities::get(&conn).unwrap().schema_version, 105);
    let fresh = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&fresh).unwrap();
    assert_eq!(caps.schema_version, 106);
    assert!(caps.memory_history && caps.memory_undo);
    // The ledger alone doesn't make a store readable: one missing memory
    // column refuses it.
    writer
        .execute("ALTER TABLE memories DROP COLUMN safety_critical", [])
        .unwrap();
    let partial = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&partial).unwrap();
    assert_eq!(caps.schema_version, 106);
    assert!(!caps.memory_history && !caps.memory_undo);
    assert_eq!(
        db_capabilities::require_memory_store(&partial).unwrap_err(),
        db_capabilities::STORE_NOT_UPGRADED
    );
    // Versions forks number from 10000 up don't count.
    writer
        .execute("INSERT INTO schema_migrations(version, description, applied_at) VALUES (10001, 'fork', 0)", [])
        .unwrap();
    let forked = db::open_readonly(&path).unwrap();
    assert_eq!(db_capabilities::get(&forked).unwrap().schema_version, 106);
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
fn the_upgraded_store_lists_memories_sessions_compartments_workspaces_and_projects() {
    isolated_home();
    let (_directory, path) = fixture();
    let mut conn = db::open_readwrite(&path).unwrap();
    let caps = db_capabilities::get(&conn).unwrap();
    assert_eq!(caps.schema_version, 106);
    assert!(caps.memory_history && caps.memory_undo && caps.compartment_scores);
    for search in [None, Some("cache"), Some("ca"), Some("#1")] {
        let rows =
            db::get_memories(&conn, Some("git:compat"), None, None, None, search, 100, 0).unwrap();
        assert!(!rows.is_empty(), "search {search:?}");
        assert_eq!(rows[0].revision, 1);
        assert_eq!(rows[0].project_path, "git:compat");
        assert_eq!(rows[0].category, "CONFIG_VALUES");
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
    let listed = workspaces::list_workspaces(&conn).unwrap();
    assert_eq!(listed[0].members[0].memory_count, 3);
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

/// A store ck-mc hasn't opened yet is still at the plugin's last version.
/// Every memory read and write refuses it with one message that says how to
/// upgrade it; pages that only list projects still load.
#[tokio::test]
async fn a_store_ck_mc_has_not_upgraded_refuses_memories_and_still_lists_projects() {
    isolated_home();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    schema_fixture::create_plugin_context_db(&path);
    let writer = Connection::open(&path).unwrap();
    writer.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_type,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(1,'git:compat','CONFIG_VALUES','cache_ttl=5m','h','agent',50,'project',0,'active',1,1,1,1)", []).unwrap();
    writer.execute("INSERT INTO user_memories(id,content,status,promoted_at,created_at,updated_at) VALUES(1,'Prefers tabs','active',1,1,1)", []).unwrap();
    drop(writer);
    let refused = db_capabilities::STORE_NOT_UPGRADED;
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
        ("memory.edit", edit(&[1], "content", "x", 1, "edit")),
    ] {
        assert_eq!(
            db::memory_request(&path, method, request)
                .await
                .unwrap_err(),
            refused,
            "{method}"
        );
    }
    let mut conn = db::open_readwrite(&path).unwrap();
    let sql_refusal = |error: rusqlite::Error| error.to_string();
    assert_eq!(
        sql_refusal(
            db::get_memories(&conn, Some("git:compat"), None, None, None, None, 10, 0).unwrap_err()
        ),
        refused
    );
    assert_eq!(
        sql_refusal(db::get_memory_stats(&conn, None, None).unwrap_err()),
        refused
    );
    assert_eq!(
        sql_refusal(db::enumerate_memory_projects(&conn).unwrap_err()),
        refused
    );
    assert_eq!(
        sql_refusal(db::count_memories_matching_identity(&conn, "git:compat").unwrap_err()),
        refused
    );
    assert_eq!(
        sql_refusal(db::get_user_memories(&conn, None).unwrap_err()),
        refused
    );
    assert_eq!(
        sql_refusal(db::get_user_memory_candidates(&conn).unwrap_err()),
        refused
    );
    assert_eq!(
        sql_refusal(db::update_user_memory_content(&mut conn, 1, "x").unwrap_err()),
        refused
    );
    assert_eq!(
        db::get_dream_run_memory_changes(&conn, 1).unwrap_err(),
        refused
    );
    assert_eq!(
        memory_history::local_write(&mut conn, &edit(&[1], "content", "x", 1, "x"), 100)
            .unwrap_err(),
        refused
    );
    // Nothing was written.
    let content: String = conn
        .query_row("SELECT content FROM memories WHERE id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(content, "cache_ttl=5m");
    // The Projects page and config discovery still load, from the other
    // project sources.
    conn.execute(
        "INSERT INTO dream_runs(project_path,started_at,finished_at,holder_id,tasks_json) VALUES('git:dreamed',1,2,'holder','[]')",
        [],
    )
    .unwrap();
    let projects = db::get_projects(&conn).unwrap();
    assert_eq!(
        projects
            .iter()
            .map(|project| project.identity.as_str())
            .collect::<Vec<_>>(),
        ["git:dreamed"]
    );
    assert!(db::get_project_cards(&conn).is_empty());
}

/// A newer Magic Context may have upgraded the store past what this
/// dashboard reads; its memories are refused with a message that says so.
#[tokio::test]
async fn a_store_newer_than_the_dashboard_refuses_memories() {
    isolated_home();
    let (_directory, path) = fixture();
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO schema_migrations(version, description, applied_at) VALUES (107, 'later', 0)",
            [],
        )
        .unwrap();
    let conn = db::open_readonly(&path).unwrap();
    assert_eq!(
        db::get_memories(&conn, None, None, None, None, None, 10, 0)
            .unwrap_err()
            .to_string(),
        db_capabilities::STORE_TOO_NEW
    );
    drop(conn);
    assert_eq!(
        db::memory_request(&path, "memory.history", json!({"projectPath":"git:compat"}))
            .await
            .unwrap_err(),
        db_capabilities::STORE_TOO_NEW
    );
}

#[tokio::test]
async fn schema106_edits_reject_stale_revisions_and_keep_history_undo_and_safety() {
    isolated_home();
    let (_directory, path) = fixture();
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
    // The history snapshot says where the row sits, as ck-mc's own does.
    let after = &history["decisions"][0]["rows"][0]["after"];
    assert_eq!(after["projectPath"], "git:compat");
    assert_eq!(after["level"], "project");
    assert_eq!(after["category"], "CONFIG_VALUES");
    assert_eq!(after["categoryId"], "swe:config-values");
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
    // Running sessions see the edits on their own: the dashboard keeps no
    // mutation log, and the project's memory epoch moves once per decision.
    assert_eq!(
        conn.query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path='git:compat'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        6
    );
    let log: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='memory_mutation_log'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(log, 0);
}

#[tokio::test]
async fn missing_safety_column_refuses_writes_and_reads() {
    isolated_home();
    let (_directory, path) = fixture();
    Connection::open(&path)
        .unwrap()
        .execute("ALTER TABLE memories DROP COLUMN safety_critical", [])
        .unwrap();
    let conn = db::open_readonly(&path).unwrap();
    let caps = db_capabilities::get(&conn).unwrap();
    assert!(!caps.memory_history && !caps.memory_undo);
    drop(conn);
    assert_eq!(
        db::memory_request(
            &path,
            "memory.edit",
            edit(&[1], "content", "must not save", 1, "missing-safety")
        )
        .await
        .unwrap_err(),
        db_capabilities::STORE_NOT_UPGRADED
    );
    let conn = db::open_readonly(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT content FROM memories WHERE id=1", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "cache_ttl=5m"
    );
}

#[test]
fn score_capability_requires_watermark_column_and_does_not_query_partial_tables() {
    isolated_home();
    let (_directory, path) = fixture();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE compartment_score_selections;
        DROP TABLE compartment_score_revisions;
        ALTER TABLE session_meta DROP COLUMN cached_m0_score_selection_watermark;
        CREATE TABLE compartment_score_selections(session_id TEXT,compartment_id INTEGER,sequence INTEGER,revision_id INTEGER);
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
fn schema106_compartments_keep_effective_and_applied_scores_separate() {
    isolated_home();
    let (_directory, path) = fixture();
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
