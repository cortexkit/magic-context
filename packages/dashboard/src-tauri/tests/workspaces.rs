use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::db;
use magic_context_dashboard_lib::workspaces;
use rusqlite::{params, Connection};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_db_with_workspace_schema(version: i64, include_share_categories: bool) -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    let share_column = if include_share_categories {
        ",\n              share_categories TEXT NOT NULL DEFAULT '[\"CONSTRAINTS\"]'"
    } else {
        ""
    };
    let sql = format!(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES ({version});
         CREATE TABLE memories (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             project_path TEXT NOT NULL,
             category TEXT NOT NULL DEFAULT 'CONSTRAINTS',
             content TEXT NOT NULL,
             normalized_hash TEXT NOT NULL DEFAULT '',
             status TEXT DEFAULT 'active',
             created_at INTEGER DEFAULT 0,
             updated_at INTEGER DEFAULT 0,
             first_seen_at INTEGER DEFAULT 0,
             last_seen_at INTEGER DEFAULT 0,
             source_session_id TEXT,
             source_type TEXT DEFAULT 'test',
             seen_count INTEGER DEFAULT 1,
             retrieval_count INTEGER DEFAULT 0,
             last_retrieved_at INTEGER,
             expires_at INTEGER,
             verification_status TEXT DEFAULT 'unverified',
             verified_at INTEGER,
             superseded_by_memory_id INTEGER,
             merged_from TEXT,
             metadata_json TEXT
         );
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE workspaces (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL UNIQUE,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL{share_column}
         );
         CREATE TABLE workspace_members (
             workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             project_path TEXT NOT NULL,
             display_name TEXT NOT NULL,
             display_path TEXT NOT NULL,
             added_at INTEGER NOT NULL,
             PRIMARY KEY (workspace_id, project_path)
         );
         CREATE UNIQUE INDEX idx_workspace_member_unique ON workspace_members(project_path);
         CREATE UNIQUE INDEX idx_workspace_member_name ON workspace_members(workspace_id, display_name);
         CREATE TABLE memory_embeddings (
             memory_id INTEGER PRIMARY KEY,
             embedding BLOB NOT NULL,
             model_id TEXT
         );"
    );
    conn.execute_batch(&sql).expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn make_db_v35() -> Connection {
    make_db_with_workspace_schema(35, true)
}

fn make_db_v34() -> Connection {
    make_db_with_workspace_schema(34, false)
}

fn make_db_v35_missing_share_column() -> Connection {
    make_db_with_workspace_schema(35, false)
}

fn make_db_fork_only() -> Connection {
    make_db_with_workspace_schema(10_000, true)
}

fn make_db_pre_v34() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (33);
         CREATE TABLE memories (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             project_path TEXT NOT NULL,
             category TEXT NOT NULL,
             content TEXT NOT NULL,
             normalized_hash TEXT NOT NULL,
             status TEXT DEFAULT 'active',
             created_at INTEGER DEFAULT 0,
             updated_at INTEGER DEFAULT 0,
             first_seen_at INTEGER DEFAULT 0,
             last_seen_at INTEGER DEFAULT 0,
             source_session_id TEXT,
             source_type TEXT DEFAULT 'test',
             seen_count INTEGER DEFAULT 1,
             retrieval_count INTEGER DEFAULT 0,
             last_retrieved_at INTEGER,
             expires_at INTEGER,
             verification_status TEXT DEFAULT 'unverified',
             verified_at INTEGER,
             superseded_by_memory_id INTEGER,
             merged_from TEXT,
             metadata_json TEXT
         );
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );",
    )
    .expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn seed_epoch(conn: &Connection, project: &str, epoch: i64) {
    conn.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, ?2, 0, 0)",
        params![project, epoch],
    )
    .expect("seed");
}

fn epoch(conn: &Connection, project: &str) -> i64 {
    conn.query_row(
        "SELECT project_memory_epoch FROM project_state WHERE project_path = ?1",
        params![project],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn add(
    project_path: &str,
    display_name: &str,
    display_path: &str,
) -> workspaces::WorkspaceMemberChange {
    workspaces::WorkspaceMemberChange {
        project_path: project_path.to_string(),
        display_name: display_name.to_string(),
        display_path: display_path.to_string(),
    }
}

fn set_name(project_path: &str, display_name: &str) -> workspaces::WorkspaceDisplayNameChange {
    workspaces::WorkspaceDisplayNameChange {
        project_path: project_path.to_string(),
        display_name: display_name.to_string(),
    }
}

fn default_share_categories() -> Vec<String> {
    vec!["CONSTRAINTS".to_string()]
}

fn apply_add_member(
    conn: &mut Connection,
    workspace_id: i64,
    project_path: &str,
    display_name: &str,
    display_path: &str,
) {
    workspaces::apply_workspace_changes(
        conn,
        workspace_id,
        None,
        vec![add(project_path, display_name, display_path)],
        Vec::new(),
        Vec::new(),
        Some(default_share_categories()),
    )
    .expect("add member");
}

fn seed_workspace(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO workspaces (name, created_at, updated_at) VALUES (?1, 0, 0)",
        params![name],
    )
    .expect("seed workspace");
    conn.last_insert_rowid()
}

fn seed_workspace_member(
    conn: &Connection,
    workspace_id: i64,
    project_path: &str,
    display_name: &str,
    display_path: &str,
) {
    conn.execute(
        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
         VALUES (?1, ?2, ?3, ?4, 0)",
        params![workspace_id, project_path, display_name, display_path],
    )
    .expect("seed member");
}

#[test]
fn workspace_schema_ready_false_before_v34() {
    let _g = env_lock();
    let conn = make_db_pre_v34();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_schema_ready_false_at_v34_without_share_column() {
    let _g = env_lock();
    let conn = make_db_v34();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_schema_ready_requires_share_categories_column() {
    let _g = env_lock();
    let conn = make_db_v35_missing_share_column();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_schema_ready_true_at_v35() {
    let _g = env_lock();
    let conn = make_db_v35();
    assert!(workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_schema_ready_ignores_fork_rows_until_upstream_migration_arrives() {
    let _g = env_lock();
    let conn = make_db_fork_only();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());

    conn.execute(
        "INSERT INTO schema_migrations (version) VALUES (?1)",
        params![35_i64],
    )
    .expect("seed upstream migration");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    assert!(workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_crud_round_trip() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let id = workspaces::create_workspace(&mut conn, "  team-alpha  ").expect("create");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "team-alpha");
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].share_categories, default_share_categories());

    workspaces::rename_workspace(&mut conn, id, "team-beta").expect("rename");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list[0].name, "team-beta");

    workspaces::delete_workspace(&mut conn, id).expect("delete");
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_refuses_the_user_home_directory() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "pool");
    let home = std::fs::canonicalize(dirs::home_dir().expect("user home")).expect("canonical home");
    let digest = format!("{:x}", md5::compute(home.to_string_lossy().as_bytes()));
    let home_identity = format!("dir:{}", &digest[..12]);

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add(
            &home_identity,
            "home",
            home.to_str().expect("utf8 home path"),
        )],
        Vec::new(),
        Vec::new(),
        Some(default_share_categories()),
    )
    .expect_err("home projects must not join workspaces");

    assert!(err
        .to_string()
        .contains("home directory cannot be added to a workspace"));
}

#[test]
fn list_workspaces_returns_normalized_share_categories() {
    let _g = env_lock();
    let conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    conn.execute(
        "UPDATE workspaces SET share_categories = ?1 WHERE id = ?2",
        params!["[\"NAMING\",\"CONSTRAINTS\",\"NAMING\"]", ws],
    )
    .unwrap();

    let list = workspaces::list_workspaces(&conn).unwrap();
    assert_eq!(
        list[0].share_categories,
        vec!["CONSTRAINTS".to_string(), "NAMING".to_string()]
    );
}

#[test]
fn apply_workspace_changes_multiple_add_remove_single_epoch_fanout() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:a", 10);
    seed_epoch(&conn, "git:b", 20);
    seed_epoch(&conn, "git:c", 30);
    let ws = seed_workspace(&conn, "pool");
    seed_workspace_member(&conn, ws, "git:a", "svc-a", "/a");
    seed_workspace_member(&conn, ws, "git:b", "svc-b", "/b");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:c", "svc-c", "/c")],
        vec!["git:a".to_string()],
        vec![set_name("git:b", "svc-b-renamed")],
        Some(default_share_categories()),
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:a"), 11, "old removed member bumped once");
    assert_eq!(
        epoch(&conn, "git:b"),
        21,
        "retained renamed member bumped once"
    );
    assert_eq!(epoch(&conn, "git:c"), 31, "new member bumped once");
}

#[test]
fn apply_workspace_changes_rename_only_does_not_bump_member_epochs() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:m", 5);
    let ws = seed_workspace(&conn, "before");
    seed_workspace_member(&conn, ws, "git:m", "m", "/m");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        Some("after".to_string()),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Some(default_share_categories()),
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:m"), 5);
    assert_eq!(workspaces::list_workspaces(&conn).unwrap()[0].name, "after");
}

#[test]
fn apply_workspace_changes_share_categories_change_bumps_and_stores_canonical_json() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:a", 1);
    seed_epoch(&conn, "git:b", 2);
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "a", "/a");
    seed_workspace_member(&conn, ws, "git:b", "b", "/b");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Some(vec![
            "NAMING".to_string(),
            "PROJECT_RULES".to_string(),
            "NAMING".to_string(),
        ]),
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:a"), 2);
    assert_eq!(epoch(&conn, "git:b"), 3);
    let stored: String = conn
        .query_row(
            "SELECT share_categories FROM workspaces WHERE id = ?1",
            params![ws],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, "[\"PROJECT_RULES\",\"NAMING\"]");
}

#[test]
fn apply_workspace_changes_membership_only_keeps_stored_share_categories() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "a", "/a");
    // Another window narrows sharing between the menu's read and its write.
    conn.execute(
        "UPDATE workspaces SET share_categories = ?1 WHERE id = ?2",
        params!["[\"CONSTRAINTS\"]", ws],
    )
    .unwrap();

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:b", "b", "/b")],
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("membership-only change");

    let stored: String = conn
        .query_row(
            "SELECT share_categories FROM workspaces WHERE id = ?1",
            params![ws],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        stored, "[\"CONSTRAINTS\"]",
        "a membership-only write must not resurrect the categories read earlier"
    );
}

#[test]
fn apply_workspace_changes_validates_against_final_staged_members() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "shared-name", "/a");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:b", "shared-name", "/b")],
        vec!["git:a".to_string()],
        Vec::new(),
        Some(default_share_categories()),
    )
    .unwrap();

    let members = workspaces::list_workspaces(&conn).unwrap()[0]
        .members
        .clone();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].project_path, "git:b");
    assert_eq!(members[0].display_name, "shared-name");
}

#[test]
fn apply_workspace_changes_rejects_identity_in_both_add_and_remove() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "a", "/a");

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:a", "a2", "/a")],
        vec!["git:a".to_string()],
        Vec::new(),
        Some(default_share_categories()),
    )
    .unwrap_err();
    assert!(err.to_string().contains("both added and removed"));
}

#[test]
fn apply_workspace_changes_rejects_unknown_share_categories() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Some(vec!["UNKNOWN".to_string()]),
    )
    .unwrap_err();
    assert!(err.to_string().contains("Unknown workspace share category"));
}

#[test]
fn display_name_unique_within_workspace() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    apply_add_member(&mut conn, ws, "git:a", "dup", "/a");
    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:b", "dup", "/b")],
        Vec::new(),
        Vec::new(),
        Some(default_share_categories()),
    )
    .unwrap_err();
    assert!(err.to_string().contains("already used"));
}

#[test]
fn memory_status_restore_widens_epoch_fan_out() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:a", 5);
    seed_epoch(&conn, "git:b", 7);
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    apply_add_member(&mut conn, ws, "git:a", "a", "/a");
    apply_add_member(&mut conn, ws, "git:b", "b", "/b");

    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:a', 'CONSTRAINTS', 'x', 'h1', 'archived', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    let mid = conn.last_insert_rowid();

    db::update_memory_status(&mut conn, mid, "active").expect("restore");
    assert_eq!(epoch(&conn, "git:a"), 8);
    assert_eq!(epoch(&conn, "git:b"), 9);
}

#[test]
fn enumerate_memory_projects_includes_workspace_only_member() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    apply_add_member(&mut conn, ws, "git:zero-mem", "zero", "/zero");

    let rows = db::enumerate_memory_projects(&conn).expect("enum");
    assert!(rows.iter().any(|r| r.identity == "git:zero-mem"));
}

#[test]
fn workspace_filter_paths_union_members() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    apply_add_member(&mut conn, ws, "git:x", "x", "/x");
    apply_add_member(&mut conn, ws, "git:y", "y", "/y");
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:x', 'C', 'one', 'h1', 'active', 1, 1, 1, 1),
                ('git:y', 'C', 'two', 'h2', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();

    let paths = workspaces::resolve_workspace_filter_paths(&conn, ws).unwrap();
    assert!(paths.contains(&"git:x".to_string()));
    assert!(paths.contains(&"git:y".to_string()));

    let mems = db::get_memories(&conn, None, Some(ws), None, None, None, 50, 0).unwrap();
    assert_eq!(mems.len(), 2);
}

#[test]
fn empty_workspace_filter_returns_no_memories_or_stats() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    // A workspace with ZERO members. There ARE global memories in the DB.
    let ws = workspaces::create_workspace(&mut conn, "empty").unwrap();
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:somewhere', 'C', 'global', 'h1', 'active', 1, 1, 1, 1),
                ('git:elsewhere', 'C', 'other', 'h2', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();

    // Filtering by the empty workspace must NOT leak global memories/stats.
    let mems = db::get_memories(&conn, None, Some(ws), None, None, None, 50, 0).unwrap();
    assert_eq!(
        mems.len(),
        0,
        "empty workspace must not surface global memories"
    );

    let stats = db::get_memory_stats(&conn, None, Some(ws)).unwrap();
    assert_eq!(stats.active, 0, "empty workspace stats must be zero");
    assert_eq!(stats.archived, 0);
    assert_eq!(stats.permanent, 0);

    // Sanity: no filter still sees the globals (the gate is filter-specific).
    let all = db::get_memories(&conn, None, None, None, None, None, 50, 0).unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn rename_workspace_does_not_bump_member_epochs() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "before").unwrap();
    apply_add_member(&mut conn, ws, "git:m", "m", "/m");
    let epoch_before = epoch(&conn, "git:m");

    workspaces::rename_workspace(&mut conn, ws, "after").unwrap();

    let epoch_after = epoch(&conn, "git:m");
    assert_eq!(
        epoch_before, epoch_after,
        "renaming the workspace must not fold member m[0] (name is not rendered)"
    );
}

#[test]
fn enumerate_memory_projects_includes_non_git_dir_project() {
    let _g = env_lock();
    let conn = make_db_v35();
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('dir:1234567890ab', 'CONSTRAINTS', 'some memory', 'h1', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();

    let rows = db::enumerate_memory_projects(&conn).expect("enum");
    let matched = rows.iter().find(|r| r.identity == "dir:1234567890ab");
    assert!(matched.is_some(), "should find the dir: project");
    let row = matched.unwrap();
    assert_eq!(row.display_name, "dir:1234567890…");
    assert_eq!(row.primary_path, "");
    assert_eq!(row.session_count, 0);
}
