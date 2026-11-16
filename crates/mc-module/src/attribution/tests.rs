//! The attribution facts: their ids and bodies, recording one per child,
//! the `attribution.read` pages and who may read them, and the outbox that
//! puts each fact on the bus with its body.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use subc_protocol::Principal;

use super::*;
use crate::bus::tests::TestBus;
use crate::bus::AttributionEvents;

pub(crate) fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, db)
}

/// Every stored fact: its place, body and when its event was acknowledged.
pub(crate) fn rows(db: &ContextDb) -> Vec<(i64, String, Option<i64>)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT seq, body, published_at_ms FROM attribution_facts ORDER BY seq")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    })
}

fn head() -> SessionRef {
    SessionRef::new("broca", "pi", "ses_head")
}

fn child(name: &str) -> SessionRef {
    SessionRef::new("broca", "pi", format!("ses_head:mc-summary:{name}"))
}

fn summary() -> Purpose {
    Purpose::summary(&head(), Some("agent_alfonso"), Some("pj-a"))
}

/// Store the fact of `child` recorded at `at_ms`.
pub(crate) fn put(db: &ContextDb, child: &SessionRef, purpose: &Purpose, at_ms: i64) {
    let fact = fact(child, purpose, at_ms).unwrap();
    assert!(db.with_connection(|conn| insert(conn, &fact)).unwrap());
}

#[test]
fn a_fact_id_hashes_the_child_and_the_creation_revision() {
    let child = SessionRef::new("thalamus-harness", "opencode2", "ses_1:mc-summary:x");
    // The parts joined by NUL bytes, the creation revision `1` last.
    let input: &[u8] =
        b"magic-context.attribution.v1\x00thalamus-harness\x00opencode2\x00ses_1:mc-summary:x\x001";
    let expected = format!("{:x}", Sha256::digest(input));
    assert_eq!(fact_id(&child), expected);
    assert_eq!(fact_id(&child).len(), 64);
    // The same child always has the same id; any other part changes it.
    assert_eq!(fact_id(&child.clone()), expected);
    for other in [
        SessionRef::new("broca", "opencode2", "ses_1:mc-summary:x"),
        SessionRef::new("thalamus-harness", "pi", "ses_1:mc-summary:x"),
        SessionRef::new("thalamus-harness", "opencode2", "ses_1:mc-summary:y"),
        // The separators keep parts from running into each other.
        SessionRef::new("thalamus-harnessopencode2", "", "ses_1:mc-summary:x"),
    ] {
        assert_ne!(fact_id(&other), expected, "{other:?}");
    }
}

#[test]
fn a_fact_body_is_the_canonical_json_of_the_contract_fields() {
    let child = child("1-4:d:turn-one");
    let summary = fact(&child, &summary(), 1_700_000_000_000).unwrap();
    let id = fact_id(&child);
    assert_eq!(summary.fact_id, id);
    assert_eq!(summary.recorded_at_ms, 1_700_000_000_000);
    assert_eq!(
        summary.body,
        format!(
            concat!(
                r#"{{"alfonso":"agent_alfonso","effective_from_ms":1700000000000,"fact_id":"{id}","#,
                r#""parent":{{"harness":"pi","kind":"session","runner":"broca","session":"ses_head"}},"#,
                r#""project_id":"pj-a","recorded_at_ms":1700000000000,"#,
                r#""subject":{{"harness":"pi","kind":"session","runner":"broca","session":"ses_head:mc-summary:1-4:d:turn-one"}},"#,
                r#""supersedes":null,"task":"magic-context.summary","workload":"summary"}}"#
            ),
            id = id
        )
    );
    let dream_child = SessionRef::new("thalamus-harness", "opencode2", "mc-dream:7.0:0.0");
    let dream = fact(
        &dream_child,
        &Purpose::dream("map-memories", Some("pj-a")),
        5,
    )
    .unwrap();
    let body: Value = serde_json::from_str(&dream.body).unwrap();
    assert_eq!(body["workload"], "dreamer");
    assert_eq!(body["task"], "magic-context.dream.map-memories");
    assert_eq!(body["parent"], Value::Null);
    assert_eq!(body["alfonso"], Value::Null);
    assert_eq!(body["project_id"], "pj-a");
    // Written again, the body has the same bytes, so its digest holds.
    assert_eq!(serde_jcs::to_string(&body).unwrap(), dream.body);
}

#[test]
fn a_name_outside_the_contract_or_an_oversized_fact_is_refused() {
    let mut purpose = summary();
    for task in [
        "",
        "Magic-Context.summary",
        "magic context",
        "magic/context",
    ] {
        purpose.task = task.into();
        assert!(fact(&child("x"), &purpose, 1).is_err(), "{task:?}");
    }
    purpose.task = "a".repeat(128);
    assert!(fact(&child("x"), &purpose, 1).is_ok());
    purpose.task = "a".repeat(129);
    assert!(fact(&child("x"), &purpose, 1).is_err());
    let long = SessionRef::new("broca", "pi", "s".repeat(MAX_BODY_BYTES));
    let refused = fact(&long, &summary(), 1).unwrap_err();
    assert!(refused.contains("under 4096"), "{refused}");
}

#[tokio::test]
async fn recording_a_child_twice_keeps_one_fact_and_wakes_its_publisher_once() {
    let (_dir, db) = store();
    let wake = Arc::new(tokio::sync::Notify::new());
    db.wake_on_attribution_facts(Arc::clone(&wake));
    let purpose = summary();
    let attribution = Attribution {
        db: &db,
        purpose: &purpose,
    };
    attribution.record(&child("a"));
    assert!(
        wake.notified().now_or_never().is_some(),
        "the commit woke the publisher"
    );
    let first = rows(&db);
    attribution.record(&child("a"));
    assert!(wake.notified().now_or_never().is_none(), "nothing new");
    assert_eq!(rows(&db), first);
    attribution.record(&child("b"));
    assert_eq!(rows(&db).len(), 2);
}

#[test]
fn a_store_that_cant_take_the_fact_leaves_the_run_going() {
    let (_dir, db) = store();
    let wake = Arc::new(tokio::sync::Notify::new());
    db.wake_on_attribution_facts(Arc::clone(&wake));
    db.with_connection(|conn| conn.execute_batch("DROP TABLE attribution_facts"))
        .unwrap();
    let purpose = summary();
    Attribution {
        db: &db,
        purpose: &purpose,
    }
    .record(&child("a"));
    assert!(wake.notified().now_or_never().is_none());
}

fn request(params: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"method": read::METHOD, "params": params})).unwrap()
}

fn page(db: &ContextDb, params: Value) -> Value {
    read::handle(Some(db), &request(params)).unwrap()["result"].clone()
}

fn subjects(page: &Value) -> Vec<String> {
    page["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fact| fact["subject"]["session"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_read_pages_every_fact_in_order_from_any_cursor() {
    let (_dir, db) = store();
    let empty = page(&db, json!({}));
    assert_eq!(empty, json!({"facts": [], "next": null, "through": null}));
    for (index, name) in ["a", "b", "c"].into_iter().enumerate() {
        put(&db, &child(name), &summary(), 10 + index as i64);
    }
    let first = page(&db, json!({"limit": 2}));
    assert_eq!(
        subjects(&first),
        ["ses_head:mc-summary:a", "ses_head:mc-summary:b"]
    );
    assert_eq!(first["next"], "2");
    assert_eq!(first["through"], "3");
    // Each fact is served as stored.
    assert_eq!(
        first["facts"][0],
        serde_json::from_str::<Value>(&rows(&db)[0].1).unwrap()
    );
    let second = page(&db, json!({"after": "2", "limit": 2}));
    assert_eq!(subjects(&second), ["ses_head:mc-summary:c"]);
    assert_eq!(second["next"], Value::Null, "the page reached the newest");
    assert_eq!(second["through"], "3");
    // A full page that ends on the newest fact has no next page either.
    let exact = page(&db, json!({"after": "1", "limit": 2}));
    assert_eq!(subjects(&exact).len(), 2);
    assert_eq!(exact["next"], Value::Null);
    let after_newest = page(&db, json!({"after": "3"}));
    assert_eq!(
        after_newest,
        json!({"facts": [], "next": null, "through": "3"})
    );
    // Params may be left out or null, and replay from the start.
    assert_eq!(page(&db, Value::Null), page(&db, json!({"after": null})));
    assert_eq!(subjects(&page(&db, Value::Null)).len(), 3);
}

#[test]
fn a_page_holds_100_facts_unless_asked_and_never_more_than_500() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for index in 0..501 {
            let fact = fact(&child(&index.to_string()), &summary(), 1).unwrap();
            insert(&tx, &fact).unwrap();
        }
        tx.commit().unwrap();
    });
    let default = page(&db, json!({}));
    assert_eq!(default["facts"].as_array().unwrap().len(), 100);
    assert_eq!(default["next"], "100");
    let capped = page(&db, json!({"limit": 10_000}));
    assert_eq!(capped["facts"].as_array().unwrap().len(), 500);
    assert_eq!(capped["next"], "500");
    assert_eq!(capped["through"], "501");
}

#[test]
fn the_read_refuses_params_it_does_not_know() {
    let (_dir, db) = store();
    for (params, field) in [
        (json!({"after": 2}), "params.after"),
        (json!({"after": "-1"}), "params.after"),
        (json!({"after": "x7"}), "params.after"),
        (json!({"after": ""}), "params.after"),
        (json!({"limit": 0}), "params.limit"),
        (json!({"limit": "5"}), "params.limit"),
        (json!({"cursor": "1"}), "params.cursor"),
        (json!([]), "params"),
    ] {
        let refused = read::handle(Some(&db), &request(params.clone())).unwrap_err();
        assert_eq!(refused.code, "invalid_params", "{params}");
        assert_eq!(refused.detail, Some(json!({"field": field})), "{params}");
    }
    let unavailable = read::handle(None, &request(json!({}))).unwrap_err();
    assert_eq!(unavailable.code, "store_unavailable");
}

#[test]
fn only_reserved_astrocyte_is_admitted_to_the_read() {
    assert!(read::admit(&Principal::Reserved {
        module_id: "astrocyte".into()
    })
    .is_ok());
    for caller in [
        Principal::Direct,
        Principal::Unverified,
        Principal::Reserved {
            module_id: "occipital".into(),
        },
        Principal::Reserved {
            module_id: "callosum".into(),
        },
        Principal::Reserved {
            module_id: "astrocyte-dev".into(),
        },
    ] {
        let refused = read::admit(&caller).unwrap_err();
        assert_eq!(refused.code, "caller_not_admitted", "{caller:?}");
        assert_eq!(refused.message, "caller not admitted");
    }
    assert!(read::requested(br#"{"method":"attribution.read"}"#));
    assert!(!read::requested(br#"{"method":"commands.describe"}"#));
    assert!(!read::requested(b"not json"));
}

/// Wait until `done` holds, yielding to the publisher meanwhile.
async fn until(done: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("in time");
}

#[tokio::test]
async fn a_fact_goes_on_the_bus_with_its_body_right_after_its_commit() {
    let (_dir, db) = store();
    let db = Arc::new(db);
    let test_bus = TestBus::new();
    let events = Arc::new(AttributionEvents::over(test_bus.bus()));
    let wake = Arc::new(tokio::sync::Notify::new());
    db.wake_on_attribution_facts(Arc::clone(&wake));
    let publisher = tokio::spawn(crate::bus::run_attribution_events(
        events,
        Arc::clone(&db),
        wake,
    ));
    let purpose = summary();
    let attribution = Attribution {
        db: &db,
        purpose: &purpose,
    };
    attribution.record(&child("a"));
    until(|| rows(&db)[0].2.is_some()).await;
    let sent = test_bus.payloads.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    let (subject, headers, body, duplicate) = &sent[0];
    let stored = &rows(&db)[0].1;
    assert_eq!(
        subject,
        "ck.box_test.event.magic-context.attribution_fact.v1"
    );
    assert_eq!(body, stored.as_bytes(), "the payload is the stored fact");
    assert_eq!(
        *headers,
        std::collections::BTreeMap::from([
            ("Nats-Msg-Id".to_owned(), fact_id(&child("a"))),
            (
                "Ck-Content-Digest".to_owned(),
                format!("{:x}", Sha256::digest(stored.as_bytes()))
            ),
        ])
    );
    assert!(!duplicate);
    assert!(body.len() < MAX_BODY_BYTES);

    // A stream that never acknowledges leaves the next fact unsent.
    test_bus.refuse_payloads.store(true, Ordering::Relaxed);
    attribution.record(&child("b"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rows(&db)[1].2, None, "unacknowledged, so still unsent");
    assert_eq!(test_bus.payloads.lock().unwrap().len(), 1);
    publisher.abort();
}

#[tokio::test]
async fn an_unsent_fact_goes_out_on_a_later_round() {
    let (_dir, db) = store();
    put(&db, &child("a"), &summary(), 1);
    let test_bus = TestBus::new();
    let events = AttributionEvents::over(test_bus.bus());
    // The stream doesn't acknowledge the event: the fact stays unsent.
    test_bus.refuse_payloads.store(true, Ordering::Relaxed);
    events.publish(&db).await;
    assert_eq!(rows(&db)[0].2, None);
    // The bus is down: the fact waits, and the outage is logged once.
    test_bus.refuse_payloads.store(false, Ordering::Relaxed);
    test_bus.down.store(true, Ordering::Relaxed);
    events.publish(&db).await;
    events.publish(&db).await;
    assert_eq!(rows(&db)[0].2, None);
    assert!(test_bus.payloads.lock().unwrap().is_empty());
    // Up again, the dreamer's next minute tick sends it, once.
    test_bus.down.store(false, Ordering::Relaxed);
    events.publish(&db).await;
    assert!(rows(&db)[0].2.is_some());
    events.publish(&db).await;
    let sent = test_bus.payloads.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].2, rows(&db)[0].1.as_bytes());
}

#[tokio::test]
async fn a_round_sends_every_unsent_fact_a_batch_at_a_time() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for index in 0..120 {
            let fact = fact(&child(&index.to_string()), &summary(), 1).unwrap();
            insert(&tx, &fact).unwrap();
        }
        tx.commit().unwrap();
    });
    let test_bus = TestBus::new();
    AttributionEvents::over(test_bus.bus()).publish(&db).await;
    assert!(rows(&db)
        .iter()
        .all(|(_, _, published)| published.is_some()));
    let sent = test_bus.payloads.lock().unwrap();
    assert_eq!(sent.len(), 120);
    // Oldest first, each once.
    let ids: Vec<&str> = sent
        .iter()
        .map(|(_, headers, _, _)| headers["Nats-Msg-Id"].as_str())
        .collect();
    let expected: Vec<String> = (0..120)
        .map(|index| fact_id(&child(&index.to_string())))
        .collect();
    assert_eq!(ids, expected);
}
