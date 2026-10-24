use magic_context_dashboard_lib::db;
use magic_context_dashboard_lib::project_identity::normalize_stored_project_path;
use rusqlite::{params, Connection};
use tempfile::tempdir;

fn make_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open test db");
    create_schema(&conn);
    conn
}

fn create_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'CONSTRAINTS',
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL DEFAULT '',
            source_session_id TEXT,
            source_type TEXT DEFAULT 'dashboard-test',
            seen_count INTEGER DEFAULT 1,
            retrieval_count INTEGER DEFAULT 0,
            first_seen_at INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0,
            last_seen_at INTEGER DEFAULT 0,
            last_retrieved_at INTEGER,
            status TEXT DEFAULT 'active',
            expires_at INTEGER,
            verification_status TEXT DEFAULT 'unverified',
            verified_at INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from TEXT,
            metadata_json TEXT
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL,
            model_id TEXT
        );
        CREATE TABLE project_state (
            project_path TEXT PRIMARY KEY,
            project_memory_epoch INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE user_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            promoted_at INTEGER NOT NULL,
            source_candidate_ids TEXT DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE user_memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            session_id TEXT NOT NULL,
            source_compartment_start INTEGER,
            source_compartment_end INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE session_facts (
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
        );
        CREATE TABLE memory_mutation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            mutation_type TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL,
            superseded_by_id INTEGER,
            category TEXT,
            new_content TEXT,
            queued_at INTEGER NOT NULL
        );
        CREATE TABLE tx_probe (value TEXT NOT NULL);
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            content TEXT NOT NULL,
            session_id TEXT,
            project_path TEXT,
            surface_condition TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_checked_at INTEGER,
            ready_at INTEGER,
            ready_reason TEXT
        );",
    )
    .expect("create schema");
}

fn insert_memory(conn: &Connection, project_path: &str, status: &str) -> i64 {
    conn.execute(
        "INSERT INTO memories
           (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES (?1, 'CONSTRAINTS', ?2, ?3, ?4, 1, 1, 1, 1)",
        params![project_path, format!("memory for {project_path}"), format!("hash-{project_path}"), status],
    )
    .expect("insert memory");
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

type MutationLogRow = (String, String, i64, Option<String>, Option<String>);
type SessionCacheRow = (
    String,
    String,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    Option<i64>,
);

fn mutation_log_rows(conn: &Connection) -> Vec<MutationLogRow> {
    let mut stmt = conn
        .prepare(
            "SELECT project_path, mutation_type, target_memory_id, category, new_content
             FROM memory_mutation_log ORDER BY id",
        )
        .expect("prepare mutation log query");
    stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .expect("query mutation log")
    .collect::<Result<Vec<_>, _>>()
    .expect("collect mutation log")
}

fn user_profile_version(conn: &Connection, project_path: &str) -> i64 {
    conn.query_row(
        "SELECT project_user_profile_version FROM project_state WHERE project_path = ?1",
        params![project_path],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn seed_project_state(conn: &Connection, project_path: &str, memory_epoch: i64, user_version: i64) {
    conn.execute(
        "INSERT INTO project_state
           (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, ?2, ?3, 0)",
        params![project_path, memory_epoch, user_version],
    )
    .expect("seed project_state");
}

#[test]
fn archive_memory_status_queues_mutation_without_epoch_bump() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9, 0);
    seed_project_state(&conn, "git:unrelated", 7, 0);

    db::update_memory_status(&mut conn, id, "archived").expect("update status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 9);
    assert_eq!(memory_epoch(&conn, "git:unrelated"), 7);
    assert_eq!(
        mutation_log_rows(&conn),
        vec![(
            "git:project-a".to_string(),
            "archive".to_string(),
            id,
            Some("CONSTRAINTS".to_string()),
            None,
        )]
    );
}

#[test]
fn restore_memory_status_keeps_epoch_bump_without_mutation_log() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "archived");
    seed_project_state(&conn, "git:project-a", 9, 0);

    db::update_memory_status(&mut conn, id, "active").expect("restore status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn pin_active_to_permanent_bumps_epoch_without_mutation_log() {
    // active -> permanent reorders the m[0] baseline (selection is
    // permanent-first under budget pressure), so it must bump the epoch to
    // invalidate cached m[0]. The old code gated restore on archived-origin
    // only, so this transition silently invalidated nothing.
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9, 0);

    db::update_memory_status(&mut conn, id, "permanent").expect("pin status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn unpin_permanent_to_active_bumps_epoch_without_mutation_log() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "permanent");
    seed_project_state(&conn, "git:project-a", 9, 0);

    db::update_memory_status(&mut conn, id, "active").expect("unpin status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 10);
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn no_op_status_change_does_not_bump_epoch() {
    // active -> active changes nothing in the baseline; no bump, no log.
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 9, 0);

    db::update_memory_status(&mut conn, id, "active").expect("no-op status");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 9);
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn bulk_archive_memory_status_queues_one_mutation_per_memory_without_epoch_bumps() {
    let mut conn = make_db();
    let a1 = insert_memory(&conn, "git:project-a", "active");
    let a2 = insert_memory(&conn, "git:project-a", "active");
    let b1 = insert_memory(&conn, "dir:bbbbbbbbbbbb", "active");
    seed_project_state(&conn, "git:project-a", 4, 0);
    seed_project_state(&conn, "dir:bbbbbbbbbbbb", 6, 0);
    seed_project_state(&conn, "git:unrelated", 3, 0);

    let affected =
        db::bulk_update_memory_status(&mut conn, &[a1, a2, b1], "archived").expect("bulk update");

    assert_eq!(affected, 3);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 4);
    assert_eq!(memory_epoch(&conn, "dir:bbbbbbbbbbbb"), 6);
    assert_eq!(memory_epoch(&conn, "git:unrelated"), 3);
    assert_eq!(
        mutation_log_rows(&conn),
        vec![
            (
                "git:project-a".to_string(),
                "archive".to_string(),
                a1,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
            (
                "git:project-a".to_string(),
                "archive".to_string(),
                a2,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
            (
                "dir:bbbbbbbbbbbb".to_string(),
                "archive".to_string(),
                b1,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
        ]
    );
}

#[test]
fn bulk_restore_mixed_selection_changes_and_bumps_only_actually_changed_rows() {
    let mut conn = make_db();
    // a1: no-op (active -> active); a2: archived -> active (changes).
    let a1 = insert_memory(&conn, "git:project-a", "active");
    let a2 = insert_memory(&conn, "git:project-a", "archived");
    // b1: permanent -> active (changes).
    let b1 = insert_memory(&conn, "git:project-b", "permanent");
    // c1: no-op, and the only selected row on its path (path must not bump).
    let c1 = insert_memory(&conn, "git:project-c", "active");
    seed_project_state(&conn, "git:project-a", 4, 0);
    seed_project_state(&conn, "git:project-b", 6, 0);
    seed_project_state(&conn, "git:project-c", 3, 0);

    let affected =
        db::bulk_update_memory_status(&mut conn, &[a1, a2, b1, c1], "active").expect("restore");

    // affected counts matched rows, not changed ones: the UPDATE has no status
    // predicate, so all four selected rows are written even though two of them
    // keep their status.
    assert_eq!(affected, 4);
    for id in [a1, a2, b1, c1] {
        let status: String = conn
            .query_row(
                "SELECT status FROM memories WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("status");
        assert_eq!(status, "active");
    }
    // Only the paths whose rows actually transitioned bump the epoch; the
    // all-no-op path (git:project-c) must not bust it.
    assert_eq!(memory_epoch(&conn, "git:project-a"), 5);
    assert_eq!(memory_epoch(&conn, "git:project-b"), 7);
    assert_eq!(memory_epoch(&conn, "git:project-c"), 3);
    // A restore never queues memory mutations (unlike archive).
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn bulk_make_permanent_mixed_selection_changes_and_bumps_only_actually_changed_rows() {
    let mut conn = make_db();
    // a1: active -> permanent (changes); a2: permanent -> permanent (no-op).
    let a1 = insert_memory(&conn, "git:project-a", "active");
    let a2 = insert_memory(&conn, "git:project-a", "permanent");
    // b1: archived -> permanent (changes).
    let b1 = insert_memory(&conn, "git:project-b", "archived");
    // c1: permanent -> permanent (no-op), and the only selected row on its path.
    let c1 = insert_memory(&conn, "git:project-c", "permanent");
    seed_project_state(&conn, "git:project-a", 4, 0);
    seed_project_state(&conn, "git:project-b", 6, 0);
    seed_project_state(&conn, "git:project-c", 3, 0);
    let ids = [a1, a2, b1, c1];

    let affected =
        db::bulk_update_memory_status(&mut conn, &ids, "permanent").expect("bulk permanent");

    assert_eq!(affected, 4);
    for id in ids {
        let status: String = conn
            .query_row(
                "SELECT status FROM memories WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("status");
        assert_eq!(status, "permanent");
    }
    // Same no-op guard as the restore-to-active path: only the paths whose
    // rows actually transitioned bump the epoch.
    assert_eq!(memory_epoch(&conn, "git:project-a"), 5);
    assert_eq!(memory_epoch(&conn, "git:project-b"), 7);
    assert_eq!(memory_epoch(&conn, "git:project-c"), 3);
    assert!(mutation_log_rows(&conn).is_empty());
}

#[test]
fn bulk_delete_memories_queues_one_delete_per_memory_without_epoch_bumps() {
    let mut conn = make_db();
    let a1 = insert_memory(&conn, "git:project-a", "active");
    let a2 = insert_memory(&conn, "git:project-a", "active");
    let b1 = insert_memory(&conn, "git:project-b", "active");
    let other = insert_memory(&conn, "git:other", "active");
    seed_project_state(&conn, "git:project-a", 2, 0);
    seed_project_state(&conn, "git:project-b", 3, 0);
    seed_project_state(&conn, "git:other", 5, 0);

    let affected = db::bulk_delete_memory(&mut conn, &[a1, a2, b1]).expect("bulk delete");

    assert_eq!(affected, 3);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 2);
    assert_eq!(memory_epoch(&conn, "git:project-b"), 3);
    assert_eq!(memory_epoch(&conn, "git:other"), 5);
    assert_eq!(
        mutation_log_rows(&conn),
        vec![
            (
                "git:project-a".to_string(),
                "delete".to_string(),
                a1,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
            (
                "git:project-a".to_string(),
                "delete".to_string(),
                a2,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
            (
                "git:project-b".to_string(),
                "delete".to_string(),
                b1,
                Some("CONSTRAINTS".to_string()),
                None,
            ),
        ]
    );
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id = ?1",
            params![other],
            |row| row.get(0),
        )
        .expect("remaining count");
    assert_eq!(remaining, 1);
}

#[test]
fn dismiss_user_memory_bumps_global_user_profile_not_project_memory_epoch() {
    let mut conn = make_db();
    conn.execute(
        "INSERT INTO user_memories (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
         VALUES ('remember me', 'active', 1, '[]', 1, 1)",
        [],
    )
    .expect("insert user memory");
    let id = conn.last_insert_rowid();
    seed_project_state(&conn, "git:project-a", 4, 0);

    db::dismiss_user_memory(&mut conn, id).expect("dismiss");

    assert_eq!(memory_epoch(&conn, "__global__"), 0);
    assert_eq!(user_profile_version(&conn, "__global__"), 1);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 4);
    assert_eq!(user_profile_version(&conn, "git:project-a"), 0);
}

#[test]
fn restore_user_memory_returns_row_to_active_set_and_bumps_global_profile() {
    let mut conn = make_db();
    conn.execute(
        "INSERT INTO user_memories (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
         VALUES ('remember me', 'dismissed', 1, '[]', 1, 1)",
        [],
    )
    .expect("insert user memory");
    let id = conn.last_insert_rowid();
    seed_project_state(&conn, "git:project-a", 4, 0);

    db::restore_user_memory(&mut conn, id).expect("restore");

    // The restored row is back in the active set the plugin injects from.
    let active = db::get_user_memories(&conn, Some("active")).expect("active set");
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, id);
    assert_eq!(memory_epoch(&conn, "__global__"), 0);
    assert_eq!(user_profile_version(&conn, "__global__"), 1);
    assert_eq!(memory_epoch(&conn, "git:project-a"), 4);
    assert_eq!(user_profile_version(&conn, "git:project-a"), 0);
}

#[test]
fn restore_user_memory_of_active_row_is_a_no_op_without_bump() {
    let mut conn = make_db();
    conn.execute(
        "INSERT INTO user_memories (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
         VALUES ('remember me', 'active', 1, '[]', 1, 1)",
        [],
    )
    .expect("insert user memory");
    let id = conn.last_insert_rowid();
    seed_project_state(&conn, "git:project-a", 4, 0);

    // A row that is already active must not invalidate the cached profile:
    // the status predicate keeps affected at 0, so no bump fires.
    db::restore_user_memory(&mut conn, id).expect("restore active row");

    let active = db::get_user_memories(&conn, Some("active")).expect("active set");
    assert_eq!(active.len(), 1);
    assert_eq!(user_profile_version(&conn, "__global__"), 0);
    assert_eq!(memory_epoch(&conn, "__global__"), 0);
    let updated_at: i64 = conn
        .query_row(
            "SELECT updated_at FROM user_memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("updated_at");
    assert_eq!(updated_at, 1);
}

#[test]
fn promote_user_memory_candidate_maps_columns_and_bumps_global_profile() {
    let mut conn = make_db();
    conn.execute(
        "INSERT INTO user_memory_candidates
           (content, session_id, source_compartment_start, source_compartment_end, created_at)
         VALUES ('stable preference', 'session-1', 10, 20, 1)",
        [],
    )
    .expect("insert candidate");
    let candidate_id = conn.last_insert_rowid();

    db::promote_user_memory_candidate(&mut conn, candidate_id).expect("promote");

    let row: (String, String, String) = conn
        .query_row(
            "SELECT content, status, source_candidate_ids FROM user_memories",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("promoted row");
    assert_eq!(
        row,
        (
            "stable preference".to_string(),
            "active".to_string(),
            "[1]".to_string()
        )
    );
    let remaining_candidates: i64 = conn
        .query_row("SELECT COUNT(*) FROM user_memory_candidates", [], |row| {
            row.get(0)
        })
        .expect("candidate count");
    assert_eq!(remaining_candidates, 0);
    assert_eq!(user_profile_version(&conn, "__global__"), 1);
}

#[test]
fn session_fact_update_and_delete_bump_session_facts_version() {
    let mut conn = make_db();
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

#[test]
fn routine_memory_mutation_does_not_clear_memory_block_caches() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    conn.execute(
        "INSERT INTO session_meta
           (session_id, session_facts_version, memory_block_cache, memory_block_ids, cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_mutation_id)
         VALUES ('s1', 0, 'cached-body', '1,2,3', X'010203', X'040506', 42)",
        [],
    )
    .expect("insert session meta");

    db::update_memory_status(&mut conn, id, "archived").expect("update status");

    let row: (String, String, Vec<u8>, Vec<u8>, i64) = conn
        .query_row(
            "SELECT memory_block_cache, memory_block_ids, cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_mutation_id FROM session_meta WHERE session_id = 's1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("session cache row");
    assert_eq!(
        row,
        (
            "cached-body".to_string(),
            "1,2,3".to_string(),
            vec![1, 2, 3],
            vec![4, 5, 6],
            42,
        )
    );
}

#[test]
fn bulk_update_binds_status_as_value_and_ids_as_parameters() {
    let mut conn = make_db();
    let target = insert_memory(&conn, "git:project-a", "active");
    let untouched = insert_memory(&conn, "git:project-b", "active");
    let malicious_status = "archived', project_path = 'git:evil";

    db::bulk_update_memory_status(&mut conn, &[target], malicious_status).expect("bulk update");

    let stored: String = conn
        .query_row(
            "SELECT status FROM memories WHERE id = ?1",
            params![target],
            |row| row.get(0),
        )
        .expect("target status");
    let untouched_status: String = conn
        .query_row(
            "SELECT status FROM memories WHERE id = ?1",
            params![untouched],
            |row| row.get(0),
        )
        .expect("untouched status");
    assert_eq!(stored, malicious_status);
    assert_eq!(untouched_status, "active");
}

#[test]
fn update_memory_content_queues_update_without_epoch_bump() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 11, 0);

    db::update_memory_content(&mut conn, id, "new dashboard content").expect("update content");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 11);
    assert_eq!(
        mutation_log_rows(&conn),
        vec![(
            "git:project-a".to_string(),
            "update".to_string(),
            id,
            Some("CONSTRAINTS".to_string()),
            Some("new dashboard content".to_string()),
        )]
    );
}

#[test]
fn invalidate_all_memory_block_caches_clears_m0_m1_and_mutation_cursor() {
    let conn = make_db();
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
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("context.db");
    {
        let conn = Connection::open(&db_path).expect("open db file");
        create_schema(&conn);
    }
    let raw_project = tempfile::tempdir().expect("raw project");
    let raw_project_path = raw_project.path().to_str().expect("utf8 path").to_string();
    let memory_id = {
        let conn = Connection::open(&db_path).expect("open db file");
        insert_memory(&conn, &raw_project_path, "archived")
    };

    let mut conn = Connection::open(&db_path).expect("open db file");
    db::update_memory_status(&mut conn, memory_id, "active").expect("restore memory");

    let expected_identity = normalize_stored_project_path(&raw_project_path);
    assert_eq!(memory_epoch(&conn, &expected_identity), 1);
}

#[test]
fn get_smart_notes_tolerates_null_project_path_rows() {
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

#[test]
fn test_update_memory_category_success() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    seed_project_state(&conn, "git:project-a", 11, 0);

    db::update_memory_category(&mut conn, id, "NAMING").expect("update category");

    // Verify category is updated
    let category: String = conn
        .query_row(
            "SELECT category FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("get category");
    assert_eq!(category, "NAMING");

    // A category change is render- AND visibility-changing (heading + workspace
    // shared/non-shared flip), so it bumps the epoch to force a hard fold and
    // writes NO m[1] mutation-log row (epoch-bump XOR delta, like status changes).
    assert_eq!(memory_epoch(&conn, "git:project-a"), 12);
    assert_eq!(mutation_log_rows(&conn), vec![]);
}

#[test]
fn update_memory_category_noop_does_not_bump_epoch() {
    // Changing a memory to its CURRENT category must not bump any epoch (that
    // would force a needless hard fold across every workspace member).
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");
    // Re-setting a memory to its existing category must be a no-op.
    let current: String = conn
        .query_row(
            "SELECT category FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("get category");
    seed_project_state(&conn, "git:project-a", 5, 0);

    db::update_memory_category(&mut conn, id, &current).expect("noop category update");

    assert_eq!(memory_epoch(&conn, "git:project-a"), 5);
    assert_eq!(mutation_log_rows(&conn), vec![]);
}

#[test]
fn test_update_memory_category_collision() {
    let mut conn = make_db();
    // Insert two memories in project-a:
    // Memory 1: category CONSTRAINTS, content "same content", hash "hash-1"
    // Memory 2: category NAMING, content "same content", hash "hash-1"
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status)
         VALUES ('git:project-a', 'CONSTRAINTS', 'same content', 'hash-1', 'active')",
        [],
    )
    .unwrap();
    let id1 = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status)
         VALUES ('git:project-a', 'NAMING', 'same content', 'hash-1', 'active')",
        [],
    )
    .unwrap();
    // Memory 2 exists with category NAMING; we don't need its id below.

    // Try to update Memory 1's category to NAMING. This should collide with Memory 2.
    let res = db::update_memory_category(&mut conn, id1, "NAMING");
    assert!(res.is_err());
    let err_msg = res.unwrap_err().to_string();
    assert!(err_msg.contains("Memory already exists as ID"));
    assert!(err_msg.contains("in NAMING"));

    // Verify Memory 1's category was NOT changed
    let category: String = conn
        .query_row(
            "SELECT category FROM memories WHERE id = ?1",
            params![id1],
            |row| row.get(0),
        )
        .expect("get category");
    assert_eq!(category, "CONSTRAINTS");
}

#[test]
fn test_update_memory_category_invalid() {
    let mut conn = make_db();
    let id = insert_memory(&conn, "git:project-a", "active");

    let res = db::update_memory_category(&mut conn, id, "INVALID_CATEGORY");
    assert!(res.is_err());
    let err_msg = res.unwrap_err().to_string();
    assert!(err_msg.contains("Invalid category: INVALID_CATEGORY"));

    // Verify category was NOT changed
    let category: String = conn
        .query_row(
            "SELECT category FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("get category");
    assert_eq!(category, "CONSTRAINTS");
}

#[test]
fn managed_memory_update_is_rejected_by_the_database_guard() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("context.db");
    {
        let conn = Connection::open(&path).expect("open context db");
        create_schema(&conn);
        conn.execute_batch(
            "CREATE TABLE context_store_meta (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE authority_managed (
                 project_path TEXT PRIMARY KEY,
                 context_store_uuid TEXT NOT NULL,
                 marked_at INTEGER NOT NULL
             );
             CREATE TABLE context_privilege_state (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 enabled INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO authority_managed(project_path, context_store_uuid, marked_at)
             VALUES ('/managed', 'store', 0);
             CREATE TRIGGER memories_authority_guard_update
             BEFORE UPDATE ON memories
             WHEN EXISTS (
                 SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path
             ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
             BEGIN
                 SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
             END;",
        )
        .expect("create authority guard");
        conn.execute(
            "INSERT INTO memories(project_path, content, normalized_hash) VALUES (?, ?, ?)",
            params!["/managed", "old", "old"],
        )
        .expect("insert managed memory");
    }

    let mut conn = db::open_readwrite(&path).expect("open managed context db");
    let error = db::update_memory_content(&mut conn, 1, "new").expect_err("guard must reject");
    assert!(error.to_string().contains("managed by the Rust module"));
}
