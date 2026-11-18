//! Each writer of the replicated tables produces exactly one outbox row per
//! changed row, and raises a sent row's revision once. Rows are first
//! marked sent ([`super::test_support::mark_sent`]) so a change has to
//! raise the revision, as it does on a computer that follows the hub.
//!
//! The writers here are the ones callable from outside their modules: the
//! memory tool, the person's commands and undo, the summary's recall
//! (`store_recall`, observations) and the read counters. The dreamer's
//! tasks, the summarizer's second turn and provisional scores, the primer
//! tasks, the legacy move and the agent-data import are covered next to
//! their own tests, with the same assertion.

use rusqlite::Connection;
use serde_json::json;

use super::test_support::{assert_captured, mark_sent, queued, revisions};
use crate::context_db::ContextDb;
use crate::memory_writes::person::{self, Edit, Status, Target};
use crate::memory_writes::Writer;

fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, db)
}

fn writer() -> Writer<'static> {
    Writer {
        harness: "opencode",
        session: "s1",
        project: "pj-a",
        authority: None,
        line: None,
    }
}

fn tool(conn: &mut Connection, input: serde_json::Value) {
    crate::memory_tool::call(conn, &writer(), &input, Some(3)).unwrap();
}

fn id_of(conn: &Connection, content: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM memories WHERE content = ?1",
        [content],
        |row| row.get(0),
    )
    .unwrap()
}

fn revision(conn: &Connection, id: i64) -> i64 {
    conn.query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn the_memory_tool_queues_one_row_per_memory_it_writes() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the head."}));
        assert_eq!(queued(conn), ["memory:1 create"]);
        // Saving the same text again only counts a sighting: nothing to send.
        mark_sent(conn);
        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the head."}));
        assert!(queued(conn).is_empty());

        let before = revisions(conn);
        tool(conn, json!({"action": "update", "ids": [1], "content": "Call it the history head."}));
        assert_captured(conn, &before, &["memory:1 update"]);

        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the delta."}));
        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the tail."}));
        mark_sent(conn);
        let before = revisions(conn);
        tool(conn, json!({"action": "archive", "ids": [3], "reason": "gone"}));
        assert_captured(conn, &before, &["memory:3 archive"]);

        mark_sent(conn);
        let before = revisions(conn);
        tool(conn, json!({"action": "merge", "ids": [1, 2], "content": "Call it the history head and the delta."}));
        let survivor = id_of(conn, "Call it the history head and the delta.");
        assert_captured(
            conn,
            &before,
            &["memory:1 archive", "memory:2 archive", &format!("memory:{survivor} create")],
        );
        // A global write is an observation for the review.
        mark_sent(conn);
        tool(conn, json!({"action": "write", "level": "global", "category": "USER_PREFERENCES", "content": "Prefers short answers."}));
        assert_eq!(queued(conn), ["observation:1 create"]);
    });
}

fn global_memory(conn: &Connection, content: &str) -> i64 {
    conn.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
             first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('global', 'self', 'mc:user-unsorted', 'USER_MEMORY', ?1, ?2, 1, 1, 1, 1)",
        rusqlite::params![content, crate::memory_writes::normalized_hash(content)],
    )
    .unwrap();
    conn.last_insert_rowid()
}

#[test]
fn the_persons_commands_and_undo_queue_one_row_per_memory() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let owner = person::global();
        let id = global_memory(conn, "Likes tea.");
        let target = |conn: &Connection| Target {
            id,
            revision: revision(conn, id),
        };

        mark_sent(conn);
        let before = revisions(conn);
        person::edit(
            conn,
            &owner,
            target(conn),
            &Edit {
                content: Some("Likes green tea.".into()),
                category: None,
                importance: Some(70),
            },
        )
        .unwrap();
        assert_captured(conn, &before, &[&format!("memory:{id} update")]);

        mark_sent(conn);
        let before = revisions(conn);
        let entry = person::entry(conn, id, revision(conn, id))
            .unwrap()
            .unwrap();
        person::undo(conn, &owner, target(conn), &entry).unwrap();
        assert_captured(conn, &before, &[&format!("memory:{id} update")]);

        mark_sent(conn);
        let before = revisions(conn);
        person::set_status(conn, &owner, &[target(conn)], Status::Archive).unwrap();
        assert_captured(conn, &before, &[&format!("memory:{id} archive")]);

        mark_sent(conn);
        let before = revisions(conn);
        person::set_status(conn, &owner, &[target(conn)], Status::Restore).unwrap();
        assert_captured(conn, &before, &[&format!("memory:{id} restore")]);

        mark_sent(conn);
        let before = revisions(conn);
        person::delete(conn, &owner, &[target(conn)]).unwrap();
        assert_captured(conn, &before, &[&format!("memory:{id} delete")]);
    });
}

#[test]
fn promoting_or_dismissing_an_observation_queues_the_memory_and_the_observation() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memory_observations (content, session_id, created_at) VALUES ('Likes tea.', 's1', 1);
             INSERT INTO memory_observations (content, session_id, created_at) VALUES ('Likes rain.', 's1', 1);",
        )
        .unwrap();
        mark_sent(conn);
        let before = revisions(conn);
        let memory = person::promote(conn, 1, ("mc:user-unsorted", "USER_MEMORY")).unwrap();
        assert_captured(
            conn,
            &before,
            &[&format!("memory:{memory} create"), "observation:1 metadata"],
        );
        mark_sent(conn);
        let before = revisions(conn);
        assert_eq!(person::dismiss_observations(conn, &[2]).unwrap(), 1);
        assert_captured(conn, &before, &["observation:2 metadata"]);
    });
}

#[test]
fn a_summarys_observations_are_queued_once_each() {
    let (_dir, db) = store();
    let compartment = crate::summary::validate::ValidatedCompartment {
        sequence: 1,
        start_message: 1,
        end_message: 4,
        start_message_id: "m1".into(),
        end_message_id: "m4".into(),
        title: "Work".into(),
        content: "Worked.".into(),
        p1: Some("Worked.".into()),
        p2: None,
        p3: None,
        p4: None,
        importance: Some(60),
        episode_type: None,
    };
    let observation = |content: &str| crate::context_db::ObservationSource {
        category: "USER_PREFERENCES".into(),
        content: content.into(),
        start_ordinal: 1,
        end_ordinal: 4,
        profile: None,
        project_id: Some("pj-a".into()),
        workspace_id: None,
    };
    let recall = crate::context_db::Recall {
        observations: vec![observation("Prefers tabs."), observation("Works late.")],
        project: Some("pj-a".into()),
        ..Default::default()
    };
    db.publish_summaries("opencode", "s1", &[compartment], None, &recall, 9)
        .unwrap();
    db.with_connection(|conn| {
        assert_eq!(
            queued(conn),
            ["observation:1 create", "observation:2 create"]
        );
    });
}

#[test]
fn a_read_counter_queues_nothing() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        tool(
            conn,
            json!({"action": "write", "category": "NAMING", "content": "Call it the head."}),
        );
        mark_sent(conn);
        let before = revisions(conn);
        crate::search::sources::count_retrievals(conn, &[1]).unwrap();
        assert_captured(conn, &before, &[]);
    });
}

/// A writer that names itself is recorded in its outbox rows; any other
/// change names the row's source type for a create and `ck-mc` otherwise.
#[test]
fn outbox_rows_name_the_writer_that_named_itself_and_fall_back_otherwise() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the head."}));
        mark_sent(conn);
        tool(conn, json!({"action": "update", "ids": [1], "content": "Call it the history head."}));
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(41), &[]).unwrap();
        tx.execute_batch(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
                 first_seen_at, created_at, updated_at, last_seen_at, source_type)
             VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', 'Dreamed.', 'h', 1, 1, 1, 1, 'dreamer');",
        )
        .unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
        let named: Vec<String> = conn
            .prepare(
                "SELECT local_id || ' ' || actor || ' ' || COALESCE(run_id, '-') || ' ' || COALESCE(epoch, '-')
                   FROM replica_outbox ORDER BY local_id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(named, ["1 ck-mc - -", "2 dreamer 41 -"]);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM replica_writer", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0, "the naming ends with its transaction");
        // A new memory names its own source type.
        tool(conn, json!({"action": "write", "category": "NAMING", "content": "Call it the tail."}));
        let actor: String = conn
            .query_row("SELECT actor FROM replica_outbox WHERE local_id = 3", [], |row| row.get(0))
            .unwrap();
        assert_eq!(actor, "agent");
    });
}

/// A dreamer run that holds several roles (the lift holds its workspace's
/// and its project's) names each with its generation, and each captured
/// change carries the generation of its own row's role: a row moved from
/// the project to the workspace carries the workspace's. A row of a role
/// the run doesn't hold, such as an observation a project's run records,
/// carries none.
#[test]
fn each_dreamer_change_carries_the_generation_of_its_own_rows_role() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        let epochs = [("dreamer.ws-a".to_owned(), 5), ("dreamer.pj-a".to_owned(), 3)];
        super::name_writer(&tx, "dreamer", Some(7), &epochs).unwrap();
        tx.execute_batch(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
                 first_seen_at, created_at, updated_at, last_seen_at, source_type)
             VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', 'Stays here.', 'h1', 1, 1, 1, 1, 'dreamer'),
                    ('project', 'pj-a', 'swe:naming', 'NAMING', 'Moves up.', 'h2', 1, 1, 1, 1, 'dreamer'),
                    ('global', 'self', 'swe:naming', 'NAMING', 'The person''s.', 'h3', 1, 1, 1, 1, 'dreamer');
             UPDATE memories SET level = 'workspace', owner_id = 'ws-a' WHERE content = 'Moves up.';
             INSERT INTO memory_observations (content, session_id, created_at) VALUES ('Likes tea.', 's1', 1);",
        )
        .unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
        let epochs: Vec<String> = conn
            .prepare(
                "SELECT kind || ' ' || local_id || ' ' || COALESCE(epoch, '-')
                   FROM replica_outbox ORDER BY kind, local_id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            epochs,
            ["memory 1 3", "memory 2 5", "memory 3 -", "observation 1 -"]
        );
    });
}
