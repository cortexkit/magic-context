//! The replica shares the rows a session worker builds, and takes a
//! session's summaries from `context.db`, reading a summary's body only for
//! the read that shows it.
use super::tests::{fixture, insert_summary, key, replica, request, summary_db};
use super::*;

fn update(snapshot: &Snapshot) -> Update {
    Update {
        key: snapshot.key.clone(),
        header: Arc::new(Header {
            base: snapshot.base,
            newest: snapshot.newest,
            ready: snapshot.ready,
            meta: snapshot.meta.clone(),
            breakdown: snapshot.breakdown.clone(),
        }),
        rows: vec![],
        reset_from: None,
        prune_before: None,
        summaries_changed: false,
        decisions: None,
        reverted: false,
        head: Default::default(),
    }
}

fn states(replica: &mut Replica, ids: Value) -> Vec<(String, Value)> {
    let read = replica
        .read("context.states", &request(json!({ "message_ids": ids })))
        .unwrap();
    read["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| (message["state"].as_str().unwrap().to_owned(), message["compartment_id"].clone()))
        .collect()
}

#[test]
fn the_replica_holds_the_rows_the_session_built_not_copies() {
    let mut session = crate::session::Session::app_sample_session();
    let first = session.app_update();
    let built: Vec<(String, Arc<Message>)> = first.rows.clone();
    assert!(!built.is_empty());
    let mut replica = replica(None);
    replica.snapshots.clear();
    replica.update(first);
    let held = &replica.snapshots[&key()].messages;
    for (mid, row) in &built {
        assert!(Arc::ptr_eq(&held[mid], row), "{mid} was copied");
    }
    // A row built again with the same content replaces the one held, so
    // the replica never keeps a row the worker has let go of.
    session.app_prune_stamps([("m2".to_owned(), "p".to_owned())]);
    let again = session.app_update();
    assert_eq!(again.rows.len(), 1);
    let rebuilt = Arc::clone(&again.rows[0].1);
    assert!(!Arc::ptr_eq(&rebuilt, &built[1].1));
    assert_eq!(*rebuilt, *built[1].1);
    replica.update(again);
    assert!(Arc::ptr_eq(&replica.snapshots[&key()].messages["m2"], &rebuilt));
}

#[test]
fn the_session_builds_typed_rows() {
    let mut session = crate::session::Session::app_sample_session();
    let update = session.app_update();
    assert_eq!(update.rows.len(), 5);
    for (mid, message) in &update.rows {
        assert!(
            matches!(message.row, row::Row::Typed(_)),
            "{mid} is held as JSON"
        );
    }
}

#[test]
fn a_summary_read_shows_its_row_in_context_db_now() {
    let (_dir, path, conn) = summary_db(1);
    let mut replica = replica(Some(conn));
    replica.snapshots.clear();
    replica.publish(fixture());
    let compartment = |replica: &mut Replica, id: &str| {
        replica.read(
            "context.compartment",
            &request(json!({ "compartment_id": id })),
        )
    };
    assert_eq!(
        compartment(&mut replica, "1").unwrap()["compartment"]["title"],
        "Earlier work"
    );
    let writer = Connection::open(&path).unwrap();
    writer
        .execute("UPDATE compartments SET title = 'Edited' WHERE sequence = 1", [])
        .unwrap();
    assert_eq!(
        compartment(&mut replica, "1").unwrap()["compartment"]["title"],
        "Edited",
        "the body is read for the read, not held"
    );

    // A summary the session adds is in the index once the session says its
    // summaries changed.
    writer
        .execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                 start_message_id, end_message_id, title, content, created_at, harness)
             VALUES ('s', 2, 2, 3, 'm2', 'm3', 'Later work', 'More', 50, 'opencode2')",
            [],
        )
        .unwrap();
    let ids = json!(["m1", "m2"]);
    assert_eq!(
        states(&mut replica, ids.clone()),
        [("summarized".to_owned(), json!("1")), ("raw".to_owned(), Value::Null)]
    );
    assert_eq!(
        compartment(&mut replica, "2").unwrap_err().code,
        "compartment_not_found"
    );
    let mut changed = update(&fixture());
    changed.summaries_changed = true;
    replica.update(changed);
    assert_eq!(
        states(&mut replica, ids),
        [("summarized".to_owned(), json!("1")), ("summarized".to_owned(), json!("2"))]
    );
    let later = compartment(&mut replica, "2").unwrap();
    assert_eq!(later["compartment"]["title"], "Later work");
    assert_eq!(later["compartment"]["first_at_ms"], 20);
    assert_eq!(later["compartment"]["last_at_ms"], 30);

    // A summary deleted from `context.db` since is not found.
    writer
        .execute("DELETE FROM compartments WHERE sequence = 2", [])
        .unwrap();
    assert_eq!(
        compartment(&mut replica, "2").unwrap_err().code,
        "compartment_not_found"
    );
}

#[test]
fn summaries_context_db_refused_are_read_again_on_the_next_read() {
    let (_dir, path, conn) = summary_db(1);
    let writer = Connection::open(&path).unwrap();
    let table: String = writer
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compartments'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    writer.execute_batch("DROP TABLE compartments").unwrap();
    let mut replica = replica(Some(conn));
    replica.snapshots.clear();
    let mut unsummarized = fixture();
    unsummarized.compartments.clear();
    replica.publish(unsummarized);
    assert!(replica.summaries_unread.borrow().contains(&key()));
    assert!(replica.snapshots[&key()].compartments.is_empty());
    writer.execute_batch(&table).unwrap();
    insert_summary(&writer, "s", 1);
    assert_eq!(
        states(&mut replica, json!(["m1"])),
        [("summarized".to_owned(), json!("1"))]
    );
    assert!(!replica.summaries_unread.borrow().contains(&key()));
}

#[test]
fn a_message_that_ends_one_summary_and_starts_the_next_times_both() {
    let mut replica = replica(None);
    replica.snapshots.clear();
    let mut snapshot = fixture();
    let boundary = snapshot.messages.remove("m2").unwrap();
    snapshot.compartments = vec![
        summaries::Summary {
            sequence: 1,
            first_message_id: "m1".into(),
            last_message_id: "m2".into(),
            first_message_ordinal: 1,
            last_message_ordinal: 2,
            at_ms: [None; 2],
        },
        summaries::Summary {
            sequence: 2,
            first_message_id: "m2".into(),
            last_message_id: "m3".into(),
            first_message_ordinal: 2,
            last_message_ordinal: 3,
            at_ms: [None; 2],
        },
    ];
    replica.publish(snapshot.clone());
    let held = &replica.snapshots[&key()].compartments;
    assert_eq!(
        held.iter().map(|summary| summary.at_ms).collect::<Vec<_>>(),
        [[Some(10), None], [None, Some(30)]]
    );
    let mut arrived = update(&snapshot);
    arrived.rows = vec![("m2".into(), boundary)];
    replica.update(arrived);
    let held = &replica.snapshots[&key()].compartments;
    assert_eq!(
        held.iter().map(|summary| summary.at_ms).collect::<Vec<_>>(),
        [[Some(10), Some(20)], [Some(20), Some(30)]]
    );
}
