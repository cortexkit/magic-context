//! Dashboard reads and writes on ck-mc's leveled memory schema (migration
//! 106): project memories are filed under their owner, a profile category and
//! the tag they were written under; user memories are global memories.

#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

#[path = "support/context_db.rs"]
mod schema_fixture;

use magic_context_dashboard_lib::{db, memory_bridge, memory_history};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const PROJECT: &str = "git:levels";

fn store() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    schema_fixture::create_test_context_db(&path);
    (directory, path)
}

fn insert(path: &Path, tag: &str, content: &str, status: &str) -> i64 {
    let conn = Connection::open(path).unwrap();
    schema_fixture::insert_project_memory(&conn, PROJECT, tag, content, status)
}

/// A user memory as ck-mc's migration 106 moves one: a global row in the
/// reserved category that keeps its old id and promotion time in its metadata.
fn insert_moved_user_memory(
    conn: &Connection,
    row: i64,
    old_id: i64,
    content: &str,
    status: &str,
    promoted_at: i64,
    created_at: i64,
) {
    conn.execute(
        "INSERT INTO memories (id, level, owner_id, category, origin_category, content,
             normalized_hash, source_type, seen_count, retrieval_count, first_seen_at,
             created_at, updated_at, last_seen_at, status, metadata_json)
         VALUES (?1, 'global', 'self', 'mc:user-unsorted', 'USER_MEMORY', ?2, ?3, 'user-review',
             1, 0, ?4, ?5, ?5, ?4, ?6, ?7)",
        params![
            row,
            content,
            memory_history::normalized_hash(content),
            promoted_at,
            created_at,
            status,
            json!({"user_memory_id": old_id, "promoted_at": promoted_at, "source_candidate_ids": [3, 4]})
                .to_string()
        ],
    )
    .unwrap();
}

fn revision(path: &Path, id: i64) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

async fn edit(path: &Path, id: i64, field: &str, value: &str, operation: &str) -> Value {
    let request = memory_bridge::edit_request(
        PROJECT,
        operation,
        &[id],
        &[memory_history::RevisionExpectation {
            memory_id: id,
            revision: revision(path, id),
        }],
        field,
        value,
    );
    db::memory_request(path, "memory.edit", request)
        .await
        .unwrap()
}

/// `(status, origin_category, category)` of a memory row.
fn filed(path: &Path, id: i64) -> (String, String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT status, origin_category, category FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn owned(status: &str, tag: &str, category: &str) -> (String, String, String) {
    (status.to_owned(), tag.to_owned(), category.to_owned())
}

/// The profile lines ck-mc puts in a session's prompt, read the way its
/// `ContextDb::user_profile` reads them.
fn prompt_profile(conn: &Connection) -> Vec<(i64, String)> {
    conn.prepare(
        "SELECT COALESCE(json_extract(metadata_json, '$.user_memory_id'), id), content
           FROM memories WHERE level = 'global' AND status = 'active'
          ORDER BY COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at) ASC,
                   COALESCE(json_extract(metadata_json, '$.user_memory_id'), id) ASC",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

#[test]
fn a_global_user_memory_edit_keeps_it_a_global_user_memory() {
    isolated_home();
    let (_directory, path) = store();
    let conn = Connection::open(&path).unwrap();
    insert_moved_user_memory(&conn, 901, 11, "Prefers short answers.", "active", 50, 40);
    insert_moved_user_memory(&conn, 902, 12, "Works in Madrid.", "active", 20, 40);
    let project = schema_fixture::insert_project_memory(
        &conn,
        PROJECT,
        "CONSTRAINTS",
        "Prefers short answers.",
        "active",
    );
    drop(conn);
    let mut conn = db::open_readwrite(&path).unwrap();

    // The screen shows the ids and times the person saw before the move,
    // newest first and, for a tie, in id order as the old table returned them.
    let listed = db::get_user_memories(&conn, None).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|memory| (memory.id, memory.content.as_str(), memory.promoted_at))
            .collect::<Vec<_>>(),
        [
            (11, "Prefers short answers.", Some(50)),
            (12, "Works in Madrid.", Some(20))
        ]
    );
    assert_eq!(listed[0].source_candidate_ids, Some(json!([3, 4])));
    assert_eq!(listed[0].created_at, 40);

    db::update_user_memory_content(&mut conn, 11, "Prefers terse answers.").unwrap();
    let row: (String, String, String, String, String, String, i64, String) = conn
        .query_row(
            "SELECT level, owner_id, category, origin_category, content, normalized_hash,
                    revision, metadata_json
               FROM memories WHERE id = 901",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        (row.0.as_str(), row.1.as_str(), row.2.as_str(), row.3.as_str()),
        ("global", "self", "mc:user-unsorted", "USER_MEMORY")
    );
    assert_eq!(row.4, "Prefers terse answers.");
    // The text is the row's unique key, so the hash follows it.
    assert_eq!(
        row.5,
        memory_history::normalized_hash("Prefers terse answers.")
    );
    assert_eq!(row.6, 2);
    let metadata: Value = serde_json::from_str(&row.7).unwrap();
    assert_eq!(metadata["user_memory_id"], 11);
    assert_eq!(metadata["promoted_at"], 50);

    // The edit shows on the screen under the same id, and in the profile
    // ck-mc puts in a session's prompt.
    let listed = db::get_user_memories(&conn, Some("active")).unwrap();
    assert_eq!(listed[0].id, 11);
    assert_eq!(listed[0].content, "Prefers terse answers.");
    assert_eq!(
        prompt_profile(&conn),
        [
            (12, "Works in Madrid.".to_owned()),
            (11, "Prefers terse answers.".to_owned())
        ]
    );
    // The project memory with the old text is untouched, and the memory list
    // shows project memories only.
    let (content, hash): (String, String) = conn
        .query_row(
            "SELECT content, normalized_hash FROM memories WHERE id = ?1",
            [project],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(content, "Prefers short answers.");
    assert_eq!(hash, memory_history::normalized_hash("Prefers short answers."));
    let memories = db::get_memories(&conn, None, None, None, None, None, 100, 0).unwrap();
    assert_eq!(
        memories.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        [project]
    );
    assert!(db::get_memories(&conn, None, None, None, None, Some("terse"), 100, 0)
        .unwrap()
        .is_empty());
    assert_eq!(db::get_memory_stats(&conn, None, None).unwrap().total, 1);
    // A user-memory edit has never moved a project's memory epoch.
    let epochs: i64 = conn
        .query_row("SELECT COUNT(*) FROM project_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!(epochs, 0);
}

#[tokio::test]
async fn an_edit_that_changes_the_tag_changes_the_category_too() {
    isolated_home();
    let (_directory, path) = store();
    let id = insert(&path, "CONSTRAINTS", "Never log tokens.", "active");

    let first = edit(&path, id, "category", "ARCHITECTURE", "to-architecture").await;
    assert_eq!(first["state"], "applied", "{first}");
    assert_eq!(
        filed(&path, id),
        owned("active", "ARCHITECTURE", "swe:architecture")
    );
    // The list, its category filter and the category counts use the tag.
    let conn = db::open_readonly(&path).unwrap();
    let listed =
        db::get_memories(&conn, Some(PROJECT), None, None, Some("ARCHITECTURE"), None, 10, 0)
            .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].category, "ARCHITECTURE");
    let stats = db::get_memory_stats(&conn, Some(PROJECT), None).unwrap();
    assert_eq!(
        stats
            .categories
            .iter()
            .map(|count| (count.category.as_str(), count.count))
            .collect::<Vec<_>>(),
        [("ARCHITECTURE", 1)]
    );
    drop(conn);

    // Two tags can share a category; the row moves with the tag either way.
    let second = edit(&path, id, "category", "KNOWN_ISSUES", "to-known-issues").await;
    assert_eq!(second["state"], "applied", "{second}");
    assert_eq!(
        filed(&path, id),
        owned("active", "KNOWN_ISSUES", "swe:constraints")
    );

    // Undo puts both back.
    let undone = db::memory_request(
        &path,
        "memory.restore",
        json!({"projectPath": PROJECT, "decisionKey": second["decisionKey"], "operationId": "undo",
               "expectedRevisions": [{"memoryId": id, "revision": revision(&path, id)}]}),
    )
    .await
    .unwrap();
    assert_eq!(undone["state"], "applied", "{undone}");
    assert_eq!(
        filed(&path, id),
        owned("active", "ARCHITECTURE", "swe:architecture")
    );

    // An edit that keeps the tag keeps the category the row is filed under,
    // even one a profile chose instead of the frozen map.
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE memories SET category = 'team:design' WHERE id = ?1",
            [id],
        )
        .unwrap();
    let content = edit(&path, id, "content", "Never log access tokens.", "content").await;
    assert_eq!(content["state"], "applied", "{content}");
    assert_eq!(
        filed(&path, id),
        owned("active", "ARCHITECTURE", "team:design")
    );
}

#[tokio::test]
async fn two_archived_rows_with_the_same_text_may_share_a_category() {
    isolated_home();
    let (_directory, path) = store();
    // Two tags that map to one category, holding the same text, both archived.
    let first = insert(&path, "CONSTRAINTS", "Never log tokens.", "archived");
    let second = insert(&path, "KNOWN_ISSUES", "Never log tokens.", "archived");
    let live = insert(&path, "ARCHITECTURE", "Never log tokens.", "active");

    // Moving the second onto the first's tag is allowed: neither is live.
    let retag = edit(&path, second, "category", "CONSTRAINTS", "retag-archived").await;
    assert_eq!(retag["state"], "applied", "{retag}");
    assert_eq!(
        filed(&path, second),
        owned("archived", "CONSTRAINTS", "swe:constraints")
    );
    // A live copy may join them in the category and then be archived too.
    let join = edit(&path, live, "category", "KNOWN_ISSUES", "join").await;
    assert_eq!(join["state"], "applied", "{join}");
    let archive = edit(&path, live, "status", "archived", "archive").await;
    assert_eq!(archive["state"], "applied", "{archive}");
    let conn = db::open_readonly(&path).unwrap();
    let archived =
        db::get_memories(&conn, Some(PROJECT), None, Some("archived"), None, None, 10, 0).unwrap();
    assert_eq!(archived.len(), 3);
    let shared: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE category = 'swe:constraints' AND normalized_hash = ?1",
            [memory_history::normalized_hash("Never log tokens.")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(shared, 3);
    assert_eq!(
        filed(&path, first),
        owned("archived", "CONSTRAINTS", "swe:constraints")
    );
}

#[tokio::test]
async fn a_second_live_copy_is_refused() {
    isolated_home();
    let (_directory, path) = store();
    let live = insert(&path, "CONSTRAINTS", "Never log tokens.", "active");
    let archived = insert(&path, "KNOWN_ISSUES", "Never log tokens.", "archived");
    let elsewhere = insert(&path, "ARCHITECTURE", "Never log tokens.", "active");
    let other = insert(&path, "CONSTRAINTS", "Rotate keys yearly.", "active");

    // Restoring the archived twin would make two live copies in one category.
    let restore = edit(&path, archived, "status", "active", "restore-twin").await;
    assert_eq!(restore["state"], "conflict", "{restore}");
    assert_eq!(restore["reason"], "duplicate_content");
    assert_eq!(restore["conflicts"][0]["duplicateId"], live);
    assert_eq!(
        filed(&path, archived),
        owned("archived", "KNOWN_ISSUES", "swe:constraints")
    );
    // A different tag that maps to the same category is the same category.
    let retag = edit(&path, elsewhere, "category", "KNOWN_ISSUES", "retag-live").await;
    assert_eq!(retag["state"], "conflict", "{retag}");
    assert_eq!(retag["conflicts"][0]["duplicateId"], live);
    assert_eq!(
        filed(&path, elsewhere),
        owned("active", "ARCHITECTURE", "swe:architecture")
    );
    // New text that normalizes to a live memory's text.
    let rewrite = edit(&path, other, "content", "never   LOG tokens.", "rewrite").await;
    assert_eq!(rewrite["state"], "conflict", "{rewrite}");
    let content: String = Connection::open(&path)
        .unwrap()
        .query_row("SELECT content FROM memories WHERE id = ?1", [other], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(content, "Rotate keys yearly.");

    // User memories: one live memory per text.
    let conn = Connection::open(&path).unwrap();
    insert_moved_user_memory(&conn, 901, 11, "Prefers tabs.", "active", 50, 40);
    insert_moved_user_memory(&conn, 902, 12, "prefers  TABS.", "dismissed", 20, 20);
    conn.execute(
        "INSERT INTO memory_observations (id, content, session_id, created_at) VALUES (8, 'Prefers tabs.', 'ses_a', 70)",
        [],
    )
    .unwrap();
    drop(conn);
    let mut conn = db::open_readwrite(&path).unwrap();
    let refused = db::restore_user_memory(&mut conn, 12).unwrap_err();
    assert!(refused.to_string().contains("#11"), "{refused}");
    let refused = db::promote_user_memory_candidate(&mut conn, 8).unwrap_err();
    assert!(refused.to_string().contains("#11"), "{refused}");
    let statuses: Vec<String> = conn
        .prepare("SELECT status FROM memories WHERE level = 'global' ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(statuses, ["active", "dismissed"]);
    assert_eq!(db::get_user_memory_candidates(&conn).unwrap().len(), 1);
    // Once the live one is dismissed, the other can come back.
    db::dismiss_user_memory(&mut conn, 11).unwrap();
    db::restore_user_memory(&mut conn, 12).unwrap();
    assert_eq!(
        prompt_profile(&conn),
        [(12, "prefers  TABS.".to_owned())]
    );
}

#[test]
fn a_promoted_candidate_is_filed_the_way_ck_mc_moves_user_memories() {
    isolated_home();
    let (_directory, path) = store();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO memory_observations (id, content, session_id, source_start_ordinal,
             source_end_ordinal, created_at)
             VALUES (8, 'Likes tables.', 'ses_b', 3, 4, 70),
                    (9, 'Reads release notes.', 'ses_b', NULL, NULL, 80);
         INSERT INTO memory_observations (id, content, session_id, created_at, consumed_at)
             VALUES (10, 'Already reviewed.', 'ses_b', 90, 95);",
    )
    .unwrap();
    drop(conn);
    let mut conn = db::open_readwrite(&path).unwrap();
    // Pending observations are the candidates, newest first.
    let candidates = db::get_user_memory_candidates(&conn).unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| (
                candidate.id,
                candidate.source_compartment_start,
                candidate.source_compartment_end
            ))
            .collect::<Vec<_>>(),
        [(9, None, None), (8, Some(3), Some(4))]
    );

    db::promote_user_memory_candidate(&mut conn, 8).unwrap();
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
    );
    let row: Row = conn
        .query_row(
            "SELECT level, owner_id, category, origin_category, content, source_type, seen_count,
                    retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, status,
                    metadata_json
               FROM memories WHERE level = 'global'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        (
            row.0.as_str(),
            row.1.as_str(),
            row.2.as_str(),
            row.3.as_str(),
            row.4.as_str(),
            row.5.as_str(),
            row.6,
            row.7,
            row.12.as_str()
        ),
        (
            "global",
            "self",
            "mc:user-unsorted",
            "USER_MEMORY",
            "Likes tables.",
            "user-review",
            1,
            0,
            "active"
        )
    );
    let promoted_at = row.8;
    assert_eq!((row.9, row.10, row.11), (promoted_at, promoted_at, promoted_at));
    let metadata: Value = serde_json::from_str(&row.13).unwrap();
    assert_eq!(
        metadata,
        json!({"promoted_at": promoted_at, "source_candidate_ids": [8]})
    );
    // The observation is used up, and the screen shows the new user memory.
    assert_eq!(db::get_user_memory_candidates(&conn).unwrap().len(), 1);
    let listed = db::get_user_memories(&conn, None).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].promoted_at, Some(promoted_at));
    assert_eq!(listed[0].source_candidate_ids, Some(json!([8])));
    assert_eq!(prompt_profile(&conn), [(listed[0].id, "Likes tables.".to_owned())]);
    // Global memories stay out of project search.
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'tables'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 0);
    // Delete and dismiss act on the id the screen shows.
    db::dismiss_user_memory(&mut conn, listed[0].id).unwrap();
    assert!(prompt_profile(&conn).is_empty());
    db::delete_user_memory(&mut conn, listed[0].id).unwrap();
    assert!(db::get_user_memories(&conn, None).unwrap().is_empty());
    db::delete_user_memory_candidate(&conn, 9).unwrap();
    assert!(db::get_user_memory_candidates(&conn).unwrap().is_empty());
}
