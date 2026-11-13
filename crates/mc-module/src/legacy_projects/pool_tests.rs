//! Moving and copying one legacy key's pool, on a store at the module's
//! schema built from the plugin's fresh schema.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};

use super::pool::{self, Held, Outcome};
use super::store;
use crate::context_db::ContextDb;
use crate::memory_writes::normalized_hash;

const KEY: &str = "git:0123abcd";

fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, db)
}

fn memory(conn: &Connection, owner: &str, content: &str, status: &str) -> i64 {
    conn.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
                               first_seen_at, created_at, updated_at, last_seen_at, status,
                               seen_count, retrieval_count, source_project_id)
         VALUES ('project', ?1, 'swe:naming', 'NAMING', ?2, ?3, 100, 100, 100, 100, ?4, 1, 0, ?1)",
        params![owner, content, normalized_hash(content), status],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn history(conn: &Connection, memory: i64) {
    conn.execute(
        "INSERT INTO memory_history (memory_id, revision, previous_text, applied_at, reason,
                                     evidence_json, source_ids_json, decision_key)
         VALUES (?1, 1, 'an older text', 1, 'edit', '[]', '[]', 'decision-1')",
        [memory],
    )
    .unwrap();
}

fn verification(conn: &Connection, memory: i64, file: &str) {
    conn.execute(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
         VALUES (?1, ?2, 7, 7)",
        params![memory, file],
    )
    .unwrap();
}

fn note(conn: &Connection, kind: &str, project: &str, content: &str) -> i64 {
    conn.execute(
        "INSERT INTO notes (type, content, session_id, project_path, created_at, updated_at)
         VALUES (?1, ?2, 'ses-1', ?3, 1, 1)",
        params![kind, content, project],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// The knowledge and session rows a 0.49 project leaves: a live memory with
/// history and a verification, an archived one it superseded, a smart note,
/// a session note, the session's project mapping and a commit. Returns the
/// two memories' ids.
fn legacy_project(conn: &Connection) -> (i64, i64) {
    // The archived memory comes first, so a batch can copy it before the
    // memory it points at.
    let old = memory(conn, KEY, "The head changes every pass.", "archived");
    let live = memory(conn, KEY, "The head is frozen between folds.", "active");
    conn.execute(
        "UPDATE memories SET superseded_by_memory_id = ?1 WHERE id = ?2",
        [live, old],
    )
    .unwrap();
    history(conn, live);
    verification(conn, live, "src/head.rs");
    note(conn, "smart", KEY, "Check the release once CI is green.");
    note(conn, "session", KEY, "Finish the review.");
    conn.execute(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
         VALUES ('ses-1', 'opencode', ?1, 1)",
        [KEY],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO git_commits (sha, project_path, short_sha, message, committed_at, indexed_at)
         VALUES ('0123abcd0123abcd', ?1, '0123abc', 'first commit', 1, 1)",
        [KEY],
    )
    .unwrap();
    (live, old)
}

fn count(conn: &Connection, sql: &str, project: &str) -> i64 {
    conn.query_row(sql, [project], |row| row.get(0)).unwrap()
}

fn memories_of(conn: &Connection, project: &str) -> i64 {
    count(
        conn,
        "SELECT count(*) FROM memories WHERE level = 'project' AND owner_id = ?1",
        project,
    )
}

fn live_with(conn: &Connection, project: &str, content: &str) -> Vec<i64> {
    conn.prepare(
        "SELECT id FROM memories WHERE level = 'project' AND owner_id = ?1 AND content = ?2
            AND status IN ('active', 'permanent') ORDER BY id",
    )
    .unwrap()
    .query_map(params![project, content], |row| row.get(0))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

fn targets(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

/// Run batches until the pool is settled, as a round does, and add up what
/// they did.
fn settle(conn: &mut Connection, mut step: impl FnMut(&mut Connection) -> Outcome) -> Outcome {
    let mut done: BTreeMap<String, pool::Rows> = BTreeMap::new();
    loop {
        match step(conn) {
            Outcome::Done(batch) => {
                for (project, rows) in batch {
                    let total = done.entry(project).or_default();
                    for (table, count) in rows {
                        *total.entry(table).or_default() += count;
                    }
                }
            }
            Outcome::Nothing if done.is_empty() => return Outcome::Nothing,
            Outcome::Nothing => return Outcome::Done(done),
            held => return held,
        }
    }
}

/// Move the pool to `to`, `limit` rows a batch.
fn move_all(conn: &mut Connection, to: &str, limit: usize) -> Outcome {
    let mut progress = pool::Progress::default();
    settle(conn, |conn| {
        pool::move_step(conn, &mut progress, KEY, to, &targets(&[KEY]), 5, limit).unwrap()
    })
}

/// Copy the pool to `to`, `limit` source rows a batch.
fn copy_all(conn: &mut Connection, to: &[&str], limit: usize) -> Outcome {
    let mut progress = pool::Progress::default();
    settle(conn, |conn| {
        pool::copy_step(conn, &mut progress, KEY, &targets(to), 5, limit).unwrap()
    })
}

#[test]
fn a_key_one_project_claims_moves_whole_and_a_rerun_moves_nothing() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let (live, old) = legacy_project(conn);
        let outcome = move_all(conn, "pj-a", 2);
        let expected: pool::Rows = [
            ("git_commits", 1),
            ("memories", 2),
            ("notes", 2),
            ("session_projects", 1),
        ]
        .into_iter()
        .map(|(table, rows)| (table.to_owned(), rows))
        .collect();
        assert_eq!(
            outcome,
            Outcome::Done(BTreeMap::from([("pj-a".to_owned(), expected)]))
        );
        // Every row moved, the memories with their ids.
        assert!(store::keys_with_rows(conn).unwrap().is_empty());
        let owners: Vec<(i64, String, Option<String>)> = conn
            .prepare("SELECT id, owner_id, source_project_id FROM memories ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            owners,
            vec![
                (old, "pj-a".into(), Some("pj-a".into())),
                (live, "pj-a".into(), Some("pj-a".into()))
            ]
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM identity_merge_log WHERE to_identity = ?1 AND action = 'rekeyed'", "pj-a"),
            6
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM v22_identity_rekey_map WHERE new_project_path = ?1", "pj-a"),
            1
        );
        assert_eq!(move_all(conn, "pj-a", 2), Outcome::Nothing);
        assert_eq!(
            count(conn, "SELECT count(*) FROM identity_merge_log WHERE to_identity = ?1", "pj-a"),
            6
        );
    });
}

#[test]
fn a_moved_memory_that_duplicates_a_live_one_leaves_one_live_memory_with_its_history() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let text = "Keep the head frozen between folds.";
        let survivor = memory(conn, "pj-a", text, "permanent");
        conn.execute(
            "UPDATE memories SET seen_count = 2, retrieval_count = 1, first_seen_at = 100 WHERE id = ?1",
            [survivor],
        )
        .unwrap();
        let duplicate = memory(conn, KEY, text, "active");
        conn.execute(
            "UPDATE memories SET seen_count = 3, retrieval_count = 4, first_seen_at = 50 WHERE id = ?1",
            [duplicate],
        )
        .unwrap();
        verification(conn, duplicate, "src/head.rs");
        move_all(conn, "pj-a", pool::BATCH);

        assert_eq!(live_with(conn, "pj-a", text), vec![survivor]);
        let (seen, retrieved, first, status, merged): (i64, i64, i64, String, String) = conn
            .query_row(
                "SELECT seen_count, retrieval_count, first_seen_at, status, merged_from
                   FROM memories WHERE id = ?1",
                [survivor],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!((seen, retrieved, first), (5, 5, 50));
        assert_eq!(status, "permanent", "a permanent survivor stays permanent");
        assert_eq!(merged, format!("[{duplicate}]"));
        assert_eq!(
            count(conn, "SELECT count(*) FROM memory_verifications WHERE memory_id = ?1", &survivor.to_string()),
            1
        );
        // The duplicate is history now, in the project it moved to.
        let (owner, status, by): (String, String, i64) = conn
            .query_row(
                "SELECT owner_id, status, superseded_by_memory_id FROM memories WHERE id = ?1",
                [duplicate],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((owner.as_str(), status.as_str(), by), ("pj-a", "archived", survivor));
        assert_eq!(
            count(conn, "SELECT count(*) FROM identity_merge_log WHERE action = 'superseded' AND row_id = ?1", &duplicate.to_string()),
            1
        );
    });
}

#[test]
fn a_key_two_projects_claim_gives_each_its_own_copy_with_history() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let (live, old) = legacy_project(conn);
        // One memory a batch: a copy is made before the copy it points at.
        let outcome = copy_all(conn, &["pj-b", "pj-a"], 1);
        let Outcome::Done(done) = outcome else {
            panic!("the pool was copied: {outcome:?}");
        };
        assert_eq!(done.keys().collect::<Vec<_>>(), vec!["pj-a", "pj-b"]);

        // The first project keeps the originals, ids and all.
        let originals: Vec<i64> = conn
            .prepare("SELECT id FROM memories WHERE owner_id = 'pj-a' ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(originals, vec![old, live]);
        // The second gets its own copies, pointing at each other.
        let copies: Vec<(i64, String, Option<i64>)> = conn
            .prepare(
                "SELECT id, status, superseded_by_memory_id FROM memories
                  WHERE owner_id = 'pj-b' ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(copies.len(), 2);
        let (old_copy, live_copy) = (copies[0].0, copies[1].0);
        assert!(old_copy > live, "copies get new ids");
        assert_eq!(copies[0], (old_copy, "archived".into(), Some(live_copy)));
        assert_eq!(copies[1], (live_copy, "active".into(), None));
        for (memory, table) in [(live, "memory_history"), (live_copy, "memory_history"),
                                (live, "memory_verifications"), (live_copy, "memory_verifications")] {
            assert_eq!(
                count(conn, &format!("SELECT count(*) FROM {table} WHERE memory_id = ?1"), &memory.to_string()),
                1,
                "{table} of {memory}"
            );
        }
        // Smart notes are knowledge; the session's note and mapping stay.
        for project in ["pj-a", "pj-b"] {
            assert_eq!(
                count(conn, "SELECT count(*) FROM notes WHERE project_path = ?1 AND type = 'smart'", project),
                1
            );
        }
        assert_eq!(count(conn, "SELECT count(*) FROM notes WHERE project_path = ?1", KEY), 1);
        assert_eq!(
            count(conn, "SELECT count(*) FROM notes WHERE project_path = ?1 AND type = 'session'", KEY),
            1
        );
        assert_eq!(count(conn, "SELECT count(*) FROM session_projects WHERE project_path = ?1", KEY), 1);
        assert_eq!(count(conn, "SELECT count(*) FROM session_projects WHERE project_path <> ?1", KEY), 0);
        // A commit can belong to one project only: the first.
        assert_eq!(count(conn, "SELECT count(*) FROM git_commits WHERE project_path = ?1", "pj-a"), 1);
        assert_eq!(count(conn, "SELECT count(*) FROM git_commits WHERE project_path = ?1", "pj-b"), 0);
        assert_eq!(memories_of(conn, KEY), 0, "no memory is left under the key");
        assert_eq!(
            count(conn, "SELECT count(*) FROM identity_merge_log WHERE action = 'copied' AND to_identity = ?1 AND table_name = 'memories'", "pj-b"),
            2
        );

        // Only session rows are left, so a rerun copies nothing.
        let before = count(conn, "SELECT count(*) FROM identity_merge_log WHERE from_identity = ?1", KEY);
        assert_eq!(copy_all(conn, &["pj-a", "pj-b"], 1), Outcome::Nothing);
        assert_eq!(
            count(conn, "SELECT count(*) FROM identity_merge_log WHERE from_identity = ?1", KEY),
            before
        );
        assert_eq!(memories_of(conn, "pj-b"), 2);
    });
}

#[test]
fn a_copy_that_duplicates_a_live_memory_resolves_only_in_that_project() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let text = "Summaries never bust the cache.";
        let theirs = memory(conn, "pj-b", text, "active");
        let source = memory(conn, KEY, text, "active");
        conn.execute("UPDATE memories SET seen_count = 4 WHERE id = ?1", [source])
            .unwrap();
        copy_all(conn, &["pj-a", "pj-b"], pool::BATCH);

        // The first project had no duplicate: the original lives there.
        assert_eq!(live_with(conn, "pj-a", text), vec![source]);
        // The second keeps its own memory, which absorbs the copy's history.
        assert_eq!(live_with(conn, "pj-b", text), vec![theirs]);
        let seen: i64 = conn
            .query_row(
                "SELECT seen_count FROM memories WHERE id = ?1",
                [theirs],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seen, 5);
        let copy: (String, i64) = conn
            .query_row(
                "SELECT status, superseded_by_memory_id FROM memories
                  WHERE owner_id = 'pj-b' AND id <> ?1",
                [theirs],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(copy, ("archived".into(), theirs));
        let original_seen: i64 = conn
            .query_row(
                "SELECT seen_count FROM memories WHERE id = ?1",
                [source],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original_seen, 4, "the first project's memory is not merged");
    });
}

#[test]
fn a_key_still_guarded_for_the_rust_mode_is_held() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        legacy_project(conn);
        conn.execute(
            "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?1, 'u', 1)",
            [KEY],
        )
        .unwrap();
        assert_eq!(
            move_all(conn, "pj-a", pool::BATCH),
            Outcome::Held(Held::RustManaged(KEY.into()))
        );
        assert_eq!(
            copy_all(conn, &["pj-a", "pj-b"], pool::BATCH),
            Outcome::Held(Held::RustManaged(KEY.into()))
        );
        assert_eq!(memories_of(conn, KEY), 2);
    });
}

#[test]
fn keys_in_different_workspaces_hold_a_move() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        legacy_project(conn);
        conn.execute_batch(&format!(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'one', 1, 1), (2, 'two', 1, 1);
             INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
             VALUES (1, '{KEY}', 'old', '/old', 1), (2, 'pj-a', 'new', '/new', 1);"
        ))
        .unwrap();
        assert_eq!(
            move_all(conn, "pj-a", pool::BATCH),
            Outcome::Held(Held::Workspaces(BTreeSet::from([1, 2])))
        );
        assert_eq!(memories_of(conn, KEY), 2);
    });
}

/// A table added later with a project column must be sorted on purpose:
/// copied, moved to the first project, or left under a contested key.
#[test]
fn every_project_keyed_table_is_sorted_for_a_contested_key() {
    let conn = ContextDb::fresh_in_memory();
    let found: BTreeSet<String> = store::discover(&conn)
        .unwrap()
        .into_iter()
        .map(|table| table.name)
        .collect();
    let (copied, first_only) = pool::contested_tables();
    let sorted: BTreeSet<String> = copied
        .iter()
        .chain(first_only)
        .chain(pool::LEFT)
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(found, sorted);
}

#[test]
fn only_a_category_the_project_had_of_its_own_marks_a_moved_memory_for_review() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let own = memory(conn, "pj-a", "An architecture fact pj-a had.", "active");
        conn.execute(
            "UPDATE memories SET category = 'swe:architecture' WHERE id = ?1",
            [own],
        )
        .unwrap();
        let architecture = memory(conn, KEY, "A new architecture fact.", "active");
        conn.execute(
            "UPDATE memories SET category = 'swe:architecture' WHERE id = ?1",
            [architecture],
        )
        .unwrap();
        // Two naming memories, a batch each: the first reaching pj-a doesn't
        // make naming one of pj-a's own categories for the second.
        let first = memory(conn, KEY, "The first naming rule.", "active");
        let second = memory(conn, KEY, "The second naming rule.", "active");
        move_all(conn, "pj-a", 1);
        let review = |id: i64| -> Option<String> {
            conn.query_row(
                "SELECT json_extract(metadata_json, '$.identity_merge_review') FROM memories WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(review(architecture).as_deref(), Some(KEY));
        assert_eq!(review(first), None);
        assert_eq!(review(second), None);
        assert_eq!(review(own), None);
    });
}
