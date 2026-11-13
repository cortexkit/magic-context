use super::*;
use std::time::{Duration, Instant};

fn saved(store: &crate::store::Store, name: &str) -> Snapshot {
    let mut snapshot = super::tests::fixture();
    snapshot.key.session = name.into();
    snapshot.decisions = vec![json!({"at_ms":123,"reason":"saved decision"})];
    super::tests::save_fixture(store, &snapshot, None);
    store
        .save_app_decisions(&snapshot.key, &snapshot.decisions)
        .unwrap();
    snapshot
}

fn cold(store: &crate::store::Store) -> Replica {
    let mut replica = super::tests::replica(None);
    replica.snapshots.clear();
    replica.store =
        Some(Connection::open_with_flags(&store.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    replica.load();
    replica
}

fn eager(store: &crate::store::Store) -> Replica {
    let mut replica = cold(store);
    for snapshot in persistence::load(replica.store.as_ref().unwrap()).unwrap() {
        replica.publish(snapshot);
    }
    replica
}

fn delta(snapshot: &Snapshot) -> Update {
    let mut message = snapshot.messages["m2"].clone();
    message.row["state"] = json!("dropped");
    Update {
        key: snapshot.key.clone(),
        header: Arc::new(Header {
            base: snapshot.base,
            newest: snapshot.newest,
            ready: snapshot.ready,
            meta: json!({"changed":true}),
            breakdown: snapshot.breakdown.clone(),
        }),
        rows: vec![("m2".into(), Arc::new(message))],
        reset_from: None,
        prune_before: None,
        compartments: None,
        decisions: None,
        reverted: false,
        head: Default::default(),
    }
}

fn requests(key: &SessionRef) -> Vec<(&'static str, Value)> {
    vec![
        ("session_data.read", json!({"session":key,"section":"meta"})),
        (
            "session_data.read",
            json!({"session":key,"section":"token_breakdown"}),
        ),
        (
            "context.states",
            json!({"session":key,"message_ids":["m1","m2","m3","missing"]}),
        ),
        (
            "context.compartment",
            json!({"session":key,"compartment_id":"1"}),
        ),
        (
            "context.cache_why",
            json!({"session":key,"producers":[{"producer_ref":"m2"}]}),
        ),
        ("context.head", json!({"session":key})),
        (
            "context.head_section",
            json!({"session":key,"view":7,"slot":"baseline","section":0,"part":"text","offset":0,"max_bytes":1024}),
        ),
    ]
}

fn same_reply(mut a: Value, mut b: Value, started: u64) {
    // The envelope timestamp describes when the response was made, not the
    // checkpoint. Its value advances even when two reads have the same version.
    for value in [&mut a, &mut b] {
        if let Some(at) = value.as_object_mut().unwrap().remove("as_of_ms") {
            assert!((started..=now_ms()).contains(&at.as_u64().unwrap()));
        }
    }
    assert_eq!(a, b);
}

fn same_reads(left: &mut Replica, right: &mut Replica, key: &SessionRef) {
    for (method, params) in requests(key) {
        let started = now_ms();
        let a = left.read(method, &params);
        let b = right.read(method, &params);
        match (a, b) {
            (Ok(a), Ok(b)) => {
                if a.get("version").is_some()
                    && matches!(method, "session_data.read" | "context.states")
                {
                    let mut params = params;
                    params["if_version"] = a["version"].clone();
                    same_reply(
                        left.read(method, &params).unwrap(),
                        right.read(method, &params).unwrap(),
                        started,
                    );
                }
                same_reply(a, b, started);
            }
            (Err(a), Err(b)) => assert_eq!(a.code, b.code, "{method}"),
            (a, b) => panic!("different results for {method}: {a:?} / {b:?}"),
        }
    }
}

#[test]
fn app_read_lazy_startup_and_reload_match_eager_answers() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "cold");
    let other = saved(&store, "untouched");
    let mut lazy = cold(&store);
    assert!(lazy.snapshots.is_empty());
    assert!(lazy.boundaries.is_empty());
    assert_eq!(lazy.cache.checkpoints.len(), 2);
    let mut eager = eager(&store);
    same_reads(&mut eager, &mut lazy, &snapshot.key);
    assert_eq!(lazy.cache.loads, 1);
    assert!(!lazy.snapshots.contains_key(&other.key));
    assert_eq!(lazy.snapshots[&snapshot.key].decisions, snapshot.decisions);
    lazy.evict_idle(Instant::now() + Duration::from_secs(61));
    assert!(lazy.snapshots.is_empty());
    same_reads(&mut eager, &mut lazy, &snapshot.key);
    assert_eq!(lazy.cache.loads, 2);
    let mut wrong = snapshot.key.clone();
    wrong.runner = "wrong".into();
    assert_eq!(
        lazy.read("context.head", &json!({"session":wrong}))
            .unwrap_err()
            .code,
        "session_runner_mismatch"
    );
    wrong.session = "unknown".into();
    assert_eq!(
        lazy.read("context.head", &json!({"session":wrong}))
            .unwrap_err()
            .code,
        "session_not_found"
    );
}

#[test]
fn app_read_lazy_write_before_read_merges_the_saved_checkpoint_like_eager() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "updated");
    for scenario in 0..4 {
        let mut lazy = cold(&store);
        let mut eager = eager(&store);
        let update = |scenario| {
            let mut update = delta(&snapshot);
            match scenario {
                1 => {
                    update.reset_from = Some(3);
                    update.reverted = true;
                }
                2 => update.prune_before = Some(2),
                3 => {
                    update.compartments = Some(Arc::new(snapshot.compartments.clone()));
                    update.decisions = Some(Arc::new(vec![json!({"at_ms":456})]));
                }
                _ => {}
            }
            update
        };
        eager.update(update(scenario));
        lazy.update(update(scenario));
        assert_eq!(lazy.snapshots, eager.snapshots, "scenario {scenario}");
        same_reads(&mut eager, &mut lazy, &snapshot.key);
        if scenario == 0 {
            assert!(lazy.snapshots[&snapshot.key].messages.contains_key("m1"));
            assert_eq!(lazy.snapshots[&snapshot.key].decisions, snapshot.decisions);
            assert_eq!(
                lazy.snapshots[&snapshot.key].compartments,
                eager.snapshots[&snapshot.key].compartments
            );
        }
    }
}

#[test]
fn app_read_lazy_search_refuses_unloaded_cross_harness_collision() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "collision");
    let mut other = snapshot.clone();
    other.key.harness = "pi".into();
    store.save_app_snapshot(&other).unwrap();
    let mut lazy = cold(&store);
    let p = json!({"query":"hello","scope":{"session":snapshot.key}});
    assert_eq!(
        lazy.read("context.search", &p).unwrap_err().code,
        "session_ambiguous"
    );
    assert!(!lazy.snapshots.contains_key(&other.key));
    lazy.forget_session(&other.key, false);
    assert!(!lazy.cache.checkpoints.contains(&other.key));
    assert_eq!(
        lazy.read("context.search", &p).unwrap_err().code,
        "app_op_unavailable"
    );
}

#[test]
fn app_read_lazy_eviction_bounds_idle_payloads_and_pins_live_updates() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshots: Vec<_> = (0..12).map(|n| saved(&store, &format!("s{n}"))).collect();
    let mut lazy = cold(&store);
    lazy.update(delta(&snapshots[0]));
    for snapshot in &snapshots[1..] {
        lazy.read(
            "context.states",
            &json!({"session":snapshot.key,"message_ids":["m2"]}),
        )
        .unwrap();
    }
    assert_eq!(lazy.snapshots.len(), 9);
    assert!(!lazy.snapshots.contains_key(&snapshots[1].key));
    lazy.evict_idle(Instant::now() + Duration::from_secs(61));
    assert_eq!(lazy.snapshots.len(), 1);
    assert_eq!(
        lazy.snapshots[&snapshots[0].key].messages["m2"].row["state"],
        "dropped"
    );
    assert_eq!(lazy.cache.checkpoints.len(), 12);
    lazy.forget_session(&snapshots[0].key, false);
    assert!(lazy.cache.active.is_empty());
    assert!(lazy.snapshots.is_empty());
}

async fn stats(app: &AppRead) -> (usize, usize) {
    let (tx, rx) = oneshot::channel();
    app.tx.send(Command::CacheStats(tx)).unwrap();
    rx.await.unwrap()
}

#[tokio::test]
async fn app_read_lazy_two_first_reads_load_one_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "concurrent");
    let app = AppRead::new(Some(store.path.clone()), None);
    let p = json!({"session":snapshot.key,"message_ids":["m1","m2"]});
    let started = now_ms();
    let (left, right) = tokio::join!(
        app.read("context.states", p.clone()),
        app.read("context.states", p)
    );
    same_reply(left.unwrap(), right.unwrap(), started);
    assert_eq!(stats(&app).await, (1, 1));
}

#[tokio::test]
async fn app_read_lazy_load_racing_update_loses_no_saved_or_new_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "race");
    let mut eager = eager(&store);
    let app = AppRead::new(Some(store.path.clone()), None);
    let (started_tx, started_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    app.tx
        .send(Command::LoadGate(started_tx, resume_rx))
        .unwrap();
    let reader = app.clone();
    let p = json!({"session":snapshot.key,"message_ids":["m1","m2","m3"]});
    let read_params = p.clone();
    let started = now_ms();
    let first = tokio::spawn(async move { reader.read("context.states", read_params).await });
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
        .await
        .unwrap();
    app.update(delta(&snapshot));
    resume_tx.send(()).unwrap();
    same_reply(
        first.await.unwrap().unwrap(),
        eager.read("context.states", &p).unwrap(),
        started,
    );
    eager.update(delta(&snapshot));
    same_reply(
        app.read("context.states", p.clone()).await.unwrap(),
        eager.read("context.states", &p).unwrap(),
        started,
    );
    assert_eq!(stats(&app).await, (1, 1));
}

#[test]
fn app_read_lazy_active_head_keeps_view_and_as_of_identical() {
    use cortexkit_role_compaction::view::{Edit, View};
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "head");
    let mut lazy = cold(&store);
    let mut eager = eager(&store);
    for text in ["A preserved summary", "A newer summary"] {
        let view = View::seal(
            7,
            crate::summary::head::head_ops(
                &format!("<session-history>{text}</session-history>"),
                crate::summary::head::M1_EMPTY,
                None,
            )
            .into_iter()
            .map(|op| Edit::new(7, op))
            .collect(),
        );
        let mut state = head::ReadState::default();
        state.record(&view, None, "provider/model");
        state.confirm(7);
        let update = || {
            let mut update = delta(&snapshot);
            update.head = state.clone();
            update
        };
        eager.update(update());
        lazy.update(update());
        same_reads(&mut eager, &mut lazy, &snapshot.key);
        let params = json!({"session":snapshot.key});
        let a = eager.read("context.head", &params).unwrap();
        let b = lazy.read("context.head", &params).unwrap();
        assert_eq!(a["as_of"], b["as_of"]);
        assert_eq!(
            reply_bytes("context.head", a)
                .map(|v| v.len())
                .map_err(|r| r.code),
            reply_bytes("context.head", b)
                .map(|v| v.len())
                .map_err(|r| r.code)
        );
    }
}

#[test]
fn app_read_lazy_failed_load_retains_updates_until_checkpoint_can_be_read() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "retry");
    let conn = Connection::open(&store.path).unwrap();
    conn.execute(
        "UPDATE app_read_messages SET row='not JSON' WHERE message_id='m1'",
        [],
    )
    .unwrap();
    let mut lazy = cold(&store);
    lazy.update(delta(&snapshot));
    assert!(lazy.snapshots.is_empty());
    assert_eq!(lazy.cache.pending[&snapshot.key].len(), 1);
    let p = json!({"session":snapshot.key,"message_ids":["m1","m2"]});
    assert_eq!(
        lazy.read("context.states", &p).unwrap_err().code,
        "store_unavailable"
    );
    store.save_app_snapshot(&snapshot).unwrap();
    let result = lazy.read("context.states", &p).unwrap();
    assert_eq!(result["messages"][0]["state"], "summarized");
    assert_eq!(result["messages"][1]["state"], "dropped");
    assert!(lazy.cache.pending.is_empty());
}

#[test]
fn app_read_lazy_oversized_checkpoint_reply_keeps_the_size_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let mut snapshot = saved(&store, "large");
    snapshot.meta = json!({"value":"large ".repeat(REPLY_BUDGET / 3)});
    store.save_app_snapshot(&snapshot).unwrap();
    let mut lazy = cold(&store);
    let mut eager = eager(&store);
    let params = json!({"session":snapshot.key,"section":"meta"});
    for replica in [&mut lazy, &mut eager] {
        let value = replica.read("session_data.read", &params).unwrap();
        assert_eq!(
            reply_bytes("session_data.read", value).unwrap_err().code,
            "reply_too_large"
        );
    }
}

#[tokio::test]
async fn app_read_lazy_hydration_does_not_emit_a_watch_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let snapshot = saved(&store, "watched");
    let app = AppRead::new(Some(store.path.clone()), None);
    let mut watch = app
        .watch("reader".into(), json!({"sessions":[snapshot.key]}))
        .await
        .unwrap();
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "resync");
    app.read(
        "session_data.read",
        json!({"session":snapshot.key,"section":"meta"}),
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), watch.recv())
            .await
            .is_err()
    );
}

#[test]
#[ignore = "synthetic startup RSS and cold-read measurement; run in separate processes"]
fn app_read_lazy_synthetic_startup_footprint() {
    fn rss_kib() -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }
    let mode = std::env::var("APP_READ_STARTUP_MODE").expect("eager or lazy");
    assert!(matches!(mode.as_str(), "eager" | "lazy"));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let store = crate::store::Store::open(&path).unwrap();
    let mut conn = Connection::open(&path).unwrap();
    let tx = conn.transaction().unwrap();
    let snapshot = super::tests::fixture();
    let header = Header {
        base: 1,
        newest: 200,
        ready: true,
        meta: snapshot.meta,
        breakdown: snapshot.breakdown,
    }
    .json();
    let mut headers = tx
        .prepare("INSERT INTO app_read_headers VALUES('runner','harness',?1,?2)")
        .unwrap();
    let mut messages = tx
        .prepare("INSERT INTO app_read_messages VALUES('runner','harness',?1,?2,?3,?4,?5)")
        .unwrap();
    let mut summaries = tx
        .prepare("INSERT INTO app_read_summaries VALUES('runner','harness',?1,?2,?3)")
        .unwrap();
    let mut count = 0;
    for n in 0..3000 {
        let session = format!("s{n:04}");
        headers.execute(params![session, header]).unwrap();
        let len = if n == 0 {
            2000
        } else if n <= 2981 {
            200
        } else {
            100
        };
        for ordinal in 1..=len {
            let mid = format!("m{ordinal}");
            let row =
                json!({"message_id":mid,"state":"raw","compartment_id":null,"outside_reason":null,
                "split":null,"stamped_parts":["p1","p2"],"dropped_parts":[],
                "parts":{"tagged":2,"stamped":2,"dropped":0}})
                .to_string();
            messages
                .execute(params![session, mid, ordinal, ordinal * 10, row])
                .unwrap();
            count += 1;
        }
        for position in 0..4 {
            let summary = json!({"compartment_id":format!("c{position}"),"ordinal":position,
                "summary_markdown":"summary ".repeat(768),"tiers":{"p1":"detail","p2":"short","p3":"tiny","p4":"cue"}}).to_string();
            summaries
                .execute(params![session, position, summary])
                .unwrap();
        }
    }
    assert_eq!(count, 600_000);
    drop((headers, messages, summaries));
    tx.commit().unwrap();
    let json_bytes: u64 = conn.query_row("SELECT (SELECT SUM(length(row)) FROM app_read_messages) + (SELECT SUM(length(row)) FROM app_read_summaries)", [], |row| row.get(0)).unwrap();
    drop(conn);
    let before = rss_kib();
    let started = Instant::now();
    let mut replica = if mode == "eager" {
        eager(&store)
    } else {
        cold(&store)
    };
    let startup_ms = started.elapsed().as_millis();
    let after = rss_kib();
    assert_eq!(
        replica.snapshots.len(),
        if mode == "eager" { 3000 } else { 0 }
    );
    let key = SessionRef::new("runner", "harness", "s0000");
    let start = Instant::now();
    replica
        .read(
            "session_data.read",
            &json!({"session":key,"section":"meta"}),
        )
        .unwrap();
    let first_read_us = start.elapsed().as_micros();
    let after_read = rss_kib();
    replica.activate(&key);
    assert_eq!(replica.snapshots[&key].messages.len(), 2000);
    println!("synthetic mode={mode} sessions=3000 messages={count} summaries=12000 json_bytes={json_bytes} rss_before_kib={before} rss_startup_kib={after} rss_delta_kib={} startup_ms={startup_ms} first_read_2000_us={first_read_us} rss_after_read_kib={after_read}", after.saturating_sub(before));
}
