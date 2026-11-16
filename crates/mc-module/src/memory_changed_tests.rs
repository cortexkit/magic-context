//! The `memory_changed` wake: its notice, one wake per owner for a burst of
//! writes, owners whose memories did not change, a bus that is down, a
//! revision that never falls, and two write paths reaching the wake: an
//! agent's `ctx_memory` and the summarizer's second turn. The dreamer, owner
//! commands and the move of 0.49 project rows are tested next to their own
//! code.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use cortexkit_role_compaction::read::SessionRef;
use serde_json::{json, Value};

use super::*;
use crate::bus::tests::TestBus;
use crate::memory_writes::{save, Writer};

/// A store at the module's schema, and the wakes its writers signal, published
/// through `test_bus` by the returned publisher.
pub(crate) fn watched(
    test_bus: &Arc<TestBus>,
) -> (
    tempfile::TempDir,
    Arc<ContextDb>,
    Arc<MemoryWakes>,
    Publisher,
) {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    let wakes = Arc::new(MemoryWakes::default());
    let publisher = publisher_for(&db, test_bus.bus(), &wakes);
    (dir, db, wakes, publisher)
}

/// An agent's `ctx_memory` save in `project`, as the session's worker
/// reports it once committed.
pub(crate) fn agent_save(db: &ContextDb, project: &str, content: &str) {
    let who = Writer {
        harness: "mode3",
        session: "s1",
        project,
        authority: None,
        line: None,
    };
    let receipt = db
        .with_connection(|conn| save(conn, &who, "NAMING", content))
        .unwrap();
    assert!(receipt.applied, "{receipt:?}");
    db.changed(crate::app_read::Change::project_memories(project));
}

fn revision_now(db: &ContextDb) -> i64 {
    db.with_connection(|conn| revision(conn)).unwrap()
}

/// Every header value and the digest's body, so a test can check that no
/// memory text is among them.
pub(crate) fn carried(test_bus: &TestBus) -> String {
    test_bus
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(subject, id, _, headers, _)| format!("{subject} {id} {headers:?}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_wake_names_its_owner_and_revision_and_no_memory_text() {
    let account = AccountNames::derive("box_test").unwrap();
    let project = Wake {
        owner: Owner::of("project", "pj-a").unwrap(),
        revision: 7,
    };
    assert_eq!(
        project.body(),
        r#"{"level":"project","owner_id":"pj-a","revision":7}"#
    );
    let notice = project.notice(&account).unwrap();
    assert_eq!(
        notice.subject,
        "ck.box_test.event.magic-context.memory_changed.v1"
    );
    assert_eq!(notice.id, "project:pj-a:7");
    assert_eq!(
        notice.digest,
        ContentDigest::of_bytes(project.body().as_bytes())
    );
    assert_eq!(
        notice.headers,
        BTreeMap::from([
            ("level".to_owned(), "project".to_owned()),
            ("owner_id".to_owned(), "pj-a".to_owned()),
            ("revision".to_owned(), "7".to_owned()),
        ])
    );

    // The person's global memories have no owner id: null in the body, an
    // empty segment in the message id, and no header.
    let global = Wake {
        owner: Owner::of("global", "self").unwrap(),
        revision: 9,
    };
    let body: Value = serde_json::from_str(&global.body()).unwrap();
    assert_eq!(
        body,
        json!({"level": "global", "owner_id": null, "revision": 9})
    );
    let notice = global.notice(&account).unwrap();
    assert_eq!(notice.id, "global::9");
    assert_eq!(
        notice
            .headers
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["level", "revision"]
    );
    let workspace = Wake {
        owner: Owner::of("workspace", "ws-1").unwrap(),
        revision: 3,
    };
    assert_eq!(workspace.event_key(), "workspace:ws-1:3");
    // An agent's own memories are shown by no head.
    assert_eq!(Owner::of("agent", "ag-1"), None);
    // Every header a wake can carry is one the manifest declares.
    for wake in [project, global, workspace] {
        for name in wake.headers().unwrap().keys() {
            assert!(EVENT_HEADERS.contains(&name.as_str()), "{name}");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_writes_is_one_wake_per_owner_with_its_newest_revision() {
    let test_bus = TestBus::new();
    let (_dir, db, wakes, publisher) = watched(&test_bus);
    let task = tokio::spawn(run(publisher, Arc::clone(&db), Arc::clone(&wakes)));
    agent_save(&db, "pj-a", "Views are immutable.");
    agent_save(&db, "pj-a", "Folds happen on cache loss.");
    agent_save(&db, "pj-b", "Ship after CI.");
    agent_save(&db, "pj-a", "Notices never bust the cache.");
    let newest = revision_now(&db);
    // Nothing goes out before the burst had its time to settle.
    tokio::time::sleep(COALESCE - Duration::from_millis(100)).await;
    assert!(test_bus.notices().is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut notices = test_bus.notices();
    notices.sort();
    assert_eq!(
        notices
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        [
            format!("project:pj-a:{newest}"),
            format!("project:pj-b:{newest}")
        ]
    );
    assert_eq!(notices[0].1["revision"], newest.to_string());

    // A later write wakes its owner again, with a higher revision.
    agent_save(&db, "pj-a", "A later rule.");
    tokio::time::sleep(COALESCE + Duration::from_millis(100)).await;
    let notices = test_bus.notices();
    assert_eq!(notices.len(), 3);
    let later: i64 = notices[2].1["revision"].parse().unwrap();
    assert!(later > newest, "{later} > {newest}");
    assert_eq!(notices[2].0, format!("project:pj-a:{later}"));
    let carried = carried(&test_bus);
    for text in ["immutable", "Folds", "Ship", "Notices never", "later rule"] {
        assert!(!carried.contains(text), "{carried}");
    }
    assert!(test_bus.sent.lock().unwrap().iter().all(|sent| !sent.4));
    task.abort();
}

#[tokio::test]
async fn an_owner_whose_memories_did_not_change_is_not_woken() {
    let test_bus = TestBus::new();
    let (_dir, db, wakes, mut publisher) = watched(&test_bus);
    // A report with nothing committed since the publisher started (a
    // candidate fact, a pending observation) wakes no one.
    db.changed(crate::app_read::Change::project_memories("pj-a"));
    assert!(publisher.round(&db, wakes.take()).await.is_empty());
    agent_save(&db, "pj-a", "Views are immutable.");
    assert_eq!(publisher.round(&db, wakes.take()).await.len(), 1);
    // Reported again with nothing new: already woken at this revision.
    db.changed(crate::app_read::Change::project_memories("pj-a"));
    assert!(publisher.round(&db, wakes.take()).await.is_empty());
    assert_eq!(test_bus.notices().len(), 1);
}

#[tokio::test]
async fn with_the_bus_down_writes_succeed_and_nothing_is_published() {
    let test_bus = TestBus::new();
    test_bus.down.store(true, Ordering::Relaxed);
    let (_dir, db, wakes, mut publisher) = watched(&test_bus);
    let (dropped, log) = crate::test_log::logged_async(async {
        agent_save(&db, "pj-a", "Views are immutable.");
        let first = publisher.round(&db, wakes.take()).await;
        agent_save(&db, "pj-a", "Folds happen on cache loss.");
        let second = publisher.round(&db, wakes.take()).await;
        (first, second)
    })
    .await;
    assert_eq!(dropped, (Vec::new(), Vec::new()));
    assert!(test_bus.notices().is_empty());
    assert_eq!(
        log.matches("memory change wakes are dropped until the bus is reachable")
            .count(),
        1,
        "{log}"
    );
    let saved: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE owner_id = 'pj-a'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(saved, 2, "the writes themselves never fail");

    // Back up, the next change wakes the owner once, with the newest
    // revision; the dropped wakes are not sent late.
    test_bus.down.store(false, Ordering::Relaxed);
    agent_save(&db, "pj-a", "Ship after CI.");
    let sent = publisher.round(&db, wakes.take()).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].revision, revision_now(&db));
    assert_eq!(test_bus.notices().len(), 1);
}

#[tokio::test]
async fn an_agent_ctx_memory_write_wakes_its_project() {
    let test_bus = TestBus::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    drop(ContextDb::create_for_tests(&path).unwrap());
    let client = crate::entorhinal_changes::tests::Client::default();
    let module = crate::module::Module::new(
        client,
        crate::pass::Settings::default(),
        Some(ContextDb::open(&path).unwrap()),
        None,
    );
    let db = Arc::clone(module.context_store().unwrap());
    let wakes = Arc::new(MemoryWakes::default());
    let mut publisher = publisher_for(&db, test_bus.bus(), &wakes);
    let floor = revision_now(&db);
    let route = crate::route::Route {
        session: SessionRef::new("runner", "mock", "tools"),
        project: Some(crate::route::Project {
            id: "pj-tools".into(),
            root: dir.path().display().to_string(),
        }),
        workdir: Some(dir.path().display().to_string()),
        agent_id: None,
    };
    let reply = module
        .tool(
            &route,
            "ctx_memory",
            json!({"action": "write", "category": "NAMING", "content": "Secret marker zebra."}),
        )
        .await
        .unwrap();
    assert!(!reply.starts_with("Error"), "{reply}");
    let sent = publisher.round(&db, wakes.take()).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].owner, Owner::of("project", "pj-tools").unwrap());
    assert!(sent[0].revision > floor);
    assert!(!carried(&test_bus).contains("zebra"));
}

#[tokio::test]
async fn the_summarizers_second_turn_wakes_its_project() {
    // Turn two admits each fact through the applier; the module reports the
    // project's memories changed once the turn ends.
    let test_bus = TestBus::new();
    let (_dir, db, wakes, mut publisher) = watched(&test_bus);
    let floor = revision_now(&db);
    let receipt = db
        .with_connection(|conn| {
            crate::summary::two_pass::applier::admit(
                conn,
                &crate::summary::two_pass::applier::Admission {
                    key: "turn-two:1",
                    operation: "new",
                    project: "pj-a",
                    category: "NAMING",
                    content: "Secret marker zebra.",
                    source_session: "s1",
                    memory_enabled: true,
                    auto_promote: true,
                    conflict_target: None,
                    fact_id: 1,
                    reservation: None,
                    authority: None,
                    owner: None,
                    expires: None,
                    line: None,
                },
            )
        })
        .unwrap();
    assert_eq!(receipt.state, "applied", "{receipt:?}");
    db.changed(crate::app_read::Change::project_memories("pj-a"));
    let sent = publisher.round(&db, wakes.take()).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].owner, Owner::of("project", "pj-a").unwrap());
    assert!(sent[0].revision > floor);
    assert!(!carried(&test_bus).contains("zebra"));
}

#[test]
fn the_revision_never_falls() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    agent_save(&db, "pj-a", "Views are immutable.");
    let after = revision_now(&db);
    // A rolled-back write leaves the revision where it was.
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES ('pj-a', 'rolled-back', 'insert', '{}', 1)",
            [],
        )
        .unwrap();
        tx.rollback().unwrap();
    });
    assert_eq!(revision_now(&db), after);
    // Deleting rows never lowers it.
    db.with_connection(|conn| {
        conn.execute_batch("DELETE FROM memory_journal; DELETE FROM memories;")
    })
    .unwrap();
    assert_eq!(revision_now(&db), after);
}
