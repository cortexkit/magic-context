use super::*;
use cortexkit_role_compaction::{
    part::{Part, PartBody},
    read::{Entry, Role},
};
use std::collections::BTreeSet;

fn key() -> SessionRef {
    SessionRef::new("thalamus-harness", "opencode2", "s")
}
fn fixture() -> Snapshot {
    let mut messages = BTreeMap::new();
    for (i, state) in [(1, "raw"), (2, "raw"), (3, "dropped")] {
        let mid = format!("m{i}");
        messages.insert(mid.clone(), Message { ordinal:i, at_ms:i*10, row:json!({"message_id":mid,"state":state,"compartment_id":null,"outside_reason":null,"split":null,"stamped_parts":[],"dropped_parts":[],"parts":{"tagged":1,"stamped":0,"dropped":0}}) });
    }
    Snapshot {
        key: key(),
        base: 1,
        newest: 3,
        ready: true,
        meta: json!({"compartment_count":1,"newest_compartment_at_ms":40,"queued_stamp_count":0,"compartment_in_progress":false,"historian_failure_count":0,"historian_last_error":null,"memory_block_count":0,"cache_ttl":null,"last_response_time_ms":30}),
        breakdown: Breakdown::from_value(
            json!({"managed":{"value":true},"as_of":{"step_ref":"m3","at_ms":30},"total":{"tokens":80,"source":"provider"},"context_window":{"tokens":100000,"source":"usage"},"parts":[{"part":"history_raw","tokens":10,"estimate":true,"count":2}],"unattributed":70,"estimation_source":"legacy_estimate"}),
        ),
        compartments: vec![
            json!({"compartment_id":"1","ordinal":1,"title":"Earlier work","first_message_id":"m1","last_message_id":"m1","first_message_ordinal":1,"last_message_ordinal":1,"first_at_ms":10,"last_at_ms":10,"message_count":1,"importance":70,"summary_markdown":"A summary","tiers":{"p1":"detail","p2":"short","p3":"tiny","p4":"cue"}}),
        ],
        messages,
        decisions: vec![],
    }
}
fn replica(context: Option<Connection>) -> Replica {
    let s = fixture();
    Replica {
        boundaries: HashMap::new(),
        known: HashSet::new(),
        load_failed: false,
        snapshots: HashMap::from([(s.key.clone(), s)]),
        store: None,
        context,
        watches: watch::Hub::new(),
    }
}
fn request(extra: Value) -> Value {
    let mut p = extra;
    p["session"] = json!(key());
    p
}

fn save_fixture(store: &crate::store::Store, snapshot: &Snapshot, reverted: Option<u64>) {
    let rows: Vec<_> = snapshot
        .messages
        .iter()
        .map(|(mid, m)| IndexRow {
            mid: mid.clone(),
            ordinal: m.ordinal,
            at_ms: m.at_ms,
        })
        .collect();
    store
        .save_app_index(&snapshot.key, &rows, reverted)
        .unwrap();
    store.save_app_snapshot(snapshot).unwrap();
}

#[test]
fn session_data_versions_both_sections_and_preserves_required_fields() {
    let replica = replica(None);
    for section in ["meta", "token_breakdown"] {
        let mut p = request(json!({"section":section}));
        let first = replica.read("session_data.read", &p).unwrap();
        assert_eq!(first["state"], "ready");
        assert!(first["version"].as_str().unwrap().starts_with("mca1:"));
        p["if_version"] = first["version"].clone();
        let next = replica.read("session_data.read", &p).unwrap();
        assert_eq!(next["state"], "unchanged");
        assert!(next.get("row").is_none());
    }
    let row = replica
        .read(
            "session_data.read",
            &request(json!({"section":"token_breakdown"})),
        )
        .unwrap()["row"]
        .clone();
    assert_eq!(row["managed"]["value"], true);
    assert_eq!(row["parts"][0]["estimate"], true);
    assert_eq!(row["total"]["source"], "provider");
    assert_eq!(
        replica
            .read(
                "session_data.read",
                &request(json!({"section":"execute_threshold"}))
            )
            .unwrap_err()
            .code,
        "app_op_unavailable"
    );
}

#[test]
fn states_distinguishes_raw_dropped_summarized_and_outside_and_is_conditional() {
    let replica = replica(None);
    let mut p = request(json!({"message_ids":["m1","m2","m3","absent"]}));
    let value = replica.read("context.states", &p).unwrap();
    assert_eq!(value["state"], "ready");
    let states: Vec<_> = value["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["summarized", "raw", "dropped", "outside"]);
    assert_eq!(value["messages"][0]["compartment_id"], "1");
    let raw = replica
        .read("context.states", &request(json!({"message_ids":["m2"]})))
        .unwrap();
    assert_eq!(raw["compartments"], json!([]));
    assert!(value["messages"][0]["split"].is_null());
    p["if_version"] = value["version"].clone();
    assert_eq!(
        replica.read("context.states", &p).unwrap()["state"],
        "unchanged"
    );
    for ids in [
        json!([]),
        json!(["m1", "m1"]),
        json!((0..101).map(|i| i.to_string()).collect::<Vec<_>>()),
    ] {
        assert_eq!(
            replica
                .read("context.states", &request(json!({"message_ids":ids})))
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }
}

#[test]
fn compartment_returns_stored_tiers_and_boundaries() {
    let replica = replica(None);
    let value = replica
        .read(
            "context.compartment",
            &request(json!({"compartment_id":"1"})),
        )
        .unwrap();
    assert_eq!(value["compartment"]["summary_markdown"], "A summary");
    assert_eq!(value["compartment"]["tiers"]["p4"], "cue");
    assert_eq!(value["compartment"]["first_message_id"], "m1");
    assert_eq!(
        replica
            .read(
                "context.compartment",
                &request(json!({"compartment_id":"2"}))
            )
            .unwrap_err()
            .code,
        "compartment_not_found"
    );
}

#[test]
fn cache_why_refuses_to_invent_a_producer_join_and_bounds_producers() {
    let replica = replica(None);
    let value = replica
        .read(
            "context.cache_why",
            &request(json!({"producers":[{"producer_ref":"step-1","at_ms":10}]})),
        )
        .unwrap();
    assert_eq!(value["join"], "unavailable");
    assert_eq!(value["join_reason"], "runner_step_identity_not_recorded");
    assert_eq!(value["decisions"], json!([]));
    assert!(value.get("cause_detail").is_none());
    let too_many: Vec<_> = (0..101)
        .map(|n| json!({"producer_ref":n.to_string()}))
        .collect();
    assert_eq!(
        replica
            .read("context.cache_why", &request(json!({"producers":too_many})))
            .unwrap_err()
            .code,
        "invalid_params"
    );
}

#[test]
fn lookup_uses_the_recorded_runner_and_fails_closed_on_ambiguity() {
    let mut replica = replica(None);
    let wrong = SessionRef::new("opencode2", "opencode2", "s");
    let refusal = replica.locate(&wrong).unwrap_err();
    assert_eq!(refusal.code, "session_runner_mismatch");
    assert_eq!(refusal.detail.unwrap()["runner"], "thalamus-harness");
    assert_eq!(
        replica
            .locate(&SessionRef::new("runner", "opencode2", "absent"))
            .unwrap_err()
            .code,
        "session_not_found"
    );
    let mut duplicate = fixture();
    duplicate.key.runner = "second-runner".into();
    replica.snapshots.insert(duplicate.key.clone(), duplicate);
    assert_eq!(
        replica.locate(&key()).unwrap_err().code,
        "session_ambiguous"
    );
    for method in [
        "project_memory.read",
        "dreamer.read",
        "store.health",
        "config.read",
        "config.embedding_probe",
        "no_such_method",
    ] {
        assert_eq!(
            replica.read(method, &json!({})).unwrap_err().code,
            "app_op_unavailable"
        );
    }
}

fn search_db() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let entries: Vec<_> = (1..=55)
        .map(|i| {
            Entry::new(
                i,
                format!("m{i}"),
                Role::Assistant,
                i * 10,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: format!("été 🦀 needle {i}"),
                    },
                )],
            )
        })
        .collect();
    db.with_connection(|conn| crate::search::messages::index(conn, "opencode2", "s", &entries))
        .unwrap();
    let conn = Connection::open_with_flags(
        dir.path().join("context.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    (dir, conn)
}

#[test]
fn search_reuses_message_index_paginates_and_returns_utf8_byte_ranges() {
    let (_dir, conn) = search_db();
    let replica = replica(Some(conn));
    let mut p = json!({"query":"needle","scope":{"session":key()},"sources":["message"]});
    let first = replica.read("context.search", &p).unwrap();
    assert_eq!(first["hits"].as_array().unwrap().len(), 50);
    let hit = &first["hits"][0];
    assert_eq!(hit["at_ms"], 10);
    assert_eq!(hit["session"]["runner"], "thalamus-harness");
    assert_eq!(hit["match_ranges"], json!([[11, 17]]));
    let snippet = hit["snippet"].as_str().unwrap();
    assert_eq!(&snippet[11..17], "needle");
    p["cursor"] = first["next_cursor"].clone();
    let second = replica.read("context.search", &p).unwrap();
    assert_eq!(second["hits"].as_array().unwrap().len(), 5);
    assert!(second["next_cursor"].is_null());
    assert_eq!(search::match_ranges("İ and É", "é"), vec![[7, 9]]);
}

#[tokio::test]
async fn watch_is_work_driven_replays_bounds_quotas_and_reports_lag() {
    let mut replica = replica(None);
    let params = json!({"sessions":[key()]});
    let mut sub = replica.subscribe("direct".into(), &params).unwrap();
    let first = sub.recv().await.unwrap().unwrap();
    assert_eq!(first["kind"], "resync");
    replica.watches.changed(key());
    let notice = sub.recv().await.unwrap().unwrap();
    assert_eq!(notice["sessions"], json!([key()]));
    let mut resumed = replica
        .subscribe(
            "direct".into(),
            &json!({"sessions":[key()],"cursor":first["cursor"]}),
        )
        .unwrap();
    assert_eq!(resumed.recv().await.unwrap().unwrap()["kind"], "changes");
    let mut current = replica
        .subscribe(
            "direct".into(),
            &json!({"sessions":[key()],"cursor":notice["cursor"]}),
        )
        .unwrap();
    assert_eq!(
        current.recv().await.unwrap().unwrap()["sessions"],
        json!([])
    );
    let mut others = Vec::new();
    for _ in 3..8 {
        others.push(replica.subscribe("direct".into(), &params).unwrap());
    }
    assert_eq!(
        replica
            .subscribe("direct".into(), &params)
            .err()
            .unwrap()
            .code,
        "watch_limit_exceeded"
    );
    drop(others);
    for _ in 0..18 {
        replica.watches.changed(key());
    }
    assert_eq!(sub.recv().await.unwrap_err().code, "lagged");
    drop(sub);
    drop(resumed);
    drop(current);
    let mut stale = replica
        .subscribe(
            "direct".into(),
            &json!({"sessions":[key()],"cursor":"unknown:0"}),
        )
        .unwrap();
    assert_eq!(stale.recv().await.unwrap().unwrap()["kind"], "resync");
    assert_eq!(
        replica
            .subscribe("direct".into(), &json!({"sessions":[key(),key()]}))
            .err()
            .unwrap()
            .code,
        "invalid_params"
    );
}

#[tokio::test]
async fn a_watch_follows_sessions_ck_mc_does_not_hold_yet() {
    let mut replica = replica(None);
    let unknown = SessionRef::new("opencode", "opencode", "never-moved");
    let params = json!({"sessions":[key(), {"runner":"opencode","harness":"opencode","session":"never-moved"}]});
    let mut sub = replica.subscribe("direct".into(), &params).unwrap();
    let first = sub.recv().await.unwrap().unwrap();
    assert_eq!(first["kind"], "resync");
    // The known session still updates.
    replica.watches.changed(key());
    assert_eq!(
        sub.recv().await.unwrap().unwrap()["sessions"],
        json!([key()])
    );
    // The other one is named once ck-mc starts holding it.
    replica.watches.changed(unknown.clone());
    assert_eq!(
        sub.recv().await.unwrap().unwrap()["sessions"],
        json!([unknown])
    );
}

#[tokio::test]
async fn published_replica_survives_restart_and_does_not_take_the_session_store_lock() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        std::sync::Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
    let reader = AppRead::new(Some(store.path.clone()), None);
    save_fixture(&store, &fixture(), None);
    reader.publish(fixture());
    assert_eq!(
        reader
            .read("session_data.read", request(json!({"section":"meta"})))
            .await
            .unwrap()["row"]["compartment_count"],
        1
    );
    let reopened = AppRead::new(Some(store.path.clone()), None);
    assert_eq!(
        reopened
            .read(
                "context.compartment",
                request(json!({"compartment_id":"1"}))
            )
            .await
            .unwrap()["compartment"]["title"],
        "Earlier work"
    );
    store
        .save(
            &key(),
            &crate::store::Durable {
                queued: BTreeSet::new(),
                ..Default::default()
            },
        )
        .unwrap();
    let (held, locked) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer = store.clone();
    let thread = std::thread::spawn(move || {
        writer.with_connection_held(|| {
            held.send(()).unwrap();
            released.recv().unwrap();
        })
    });
    locked.await.unwrap();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        reader.read("session_data.read", request(json!({"section":"meta"}))),
    )
    .await;
    release.send(()).unwrap();
    thread.join().unwrap();
    assert_eq!(read.unwrap().unwrap()["row"]["compartment_count"], 1);
}

#[test]
fn samples_v5_remain_pinned() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v5");
    let sums = std::fs::read_to_string(root.join("SHA256SUMS")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(sums.as_bytes())),
        "3bfc8103328650fd551e1b2847c195f28e438704f6a1f97db8688a5f4477e536"
    );
    for line in sums.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(name)).unwrap())
            ),
            hash,
            "changed v5 sample {name}"
        );
    }
}

#[test]
fn samples_v6_remain_pinned() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v6");
    let sums = std::fs::read_to_string(root.join("SHA256SUMS")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(sums.as_bytes())),
        "cf68a48f72b966b83fa61cd08f2584d94b836619ec7b2e068d56cca1bd011abf"
    );
    for line in sums.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(name)).unwrap())
            ),
            hash,
            "changed v6 sample {name}"
        );
    }
}

#[test]
fn samples_v7_remain_pinned() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v7");
    let sums = std::fs::read_to_string(root.join("SHA256SUMS")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(sums.as_bytes())),
        "066e35f8267533977f6d26f0b74247356dafb35d67808931b99a37c3394f3b7f"
    );
    for line in sums.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(name)).unwrap())
            ),
            hash,
            "changed v7 sample {name}"
        );
    }
}

#[tokio::test]
async fn samples_v8() {
    let (_dir, conn) = search_db();
    let mut replica = replica(Some(conn));
    replica.snapshots.clear();
    replica.publish(crate::session::Session::app_sample_snapshot());
    let requests = [
        (
            "meta",
            "session_data.read",
            request(json!({"section":"meta"})),
        ),
        (
            "token-breakdown",
            "session_data.read",
            request(json!({"section":"token_breakdown"})),
        ),
        (
            "states",
            "context.states",
            request(json!({"message_ids":["m1","m2","m3","absent"]})),
        ),
        (
            "compartment",
            "context.compartment",
            request(json!({"compartment_id":"1"})),
        ),
        (
            "cache-why",
            "context.cache_why",
            request(json!({"producers":[{"producer_ref":"runner-step"}]})),
        ),
        (
            "search",
            "context.search",
            json!({"query":"needle", "scope":{"session":key()}, "sources":["message"]}),
        ),
    ];
    let mut root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v8");
    let output = std::env::var_os("MC_REGENERATE_APP_READ_SAMPLES");
    let regenerate = output.is_some();
    if let Some(output) = output.filter(|value| value != "1") {
        root = output.into();
    }
    let mut samples = BTreeMap::new();
    for (name, method, params) in requests {
        let mut response = replica.read(method, &params).unwrap();
        response["as_of_ms"] = json!(1700000000000_u64);
        let response: Value = serde_json::from_slice(&result_bytes(response)).unwrap();
        samples.insert(
            format!("{name}.json"),
            json!({"name":name,"request":{"method":method,"params":params},"response":response}),
        );
    }
    let mut sub = replica
        .subscribe("direct".into(), &json!({"sessions":[key()]}))
        .unwrap();
    let mut notice = sub.recv().await.unwrap().unwrap();
    notice["cursor"] = json!("abc:0");
    let response: Value = serde_json::from_slice(&result_bytes(notice)).unwrap();
    samples.insert("watch.json".into(),json!({"name":"watch","request":{"method":"context.watch","params":{"sessions":[key()]}},"response":response}));
    let mut sums = String::new();
    if regenerate {
        std::fs::create_dir_all(&root).unwrap();
    }
    for (name, value) in samples {
        let text = format!("{}\n", serde_json::to_string_pretty(&value).unwrap());
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(text.as_bytes())));
        let path = root.join(&name);
        if regenerate {
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(&path)
                .unwrap_or_else(|_| panic!("missing {name}; regenerate samples")),
            text,
            "stale {name}"
        );
    }
    if regenerate {
        std::fs::write(root.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("SHA256SUMS")).unwrap(),
        sums,
        "stale sample checksums"
    );
}

#[tokio::test]
async fn watch_enforces_global_tracking_limits_expired_cursors_and_clean_end() {
    let mut replica = replica(None);
    let params = json!({"sessions":[key()]});
    let mut watches = Vec::new();
    for caller in 0..32 {
        watches.push(
            replica
                .subscribe(format!("caller-{caller}"), &params)
                .unwrap(),
        );
    }
    assert_eq!(
        replica
            .subscribe("another".into(), &params)
            .err()
            .unwrap()
            .code,
        "watch_limit_exceeded"
    );
    drop(watches);
    let mut first = replica.subscribe("direct".into(), &params).unwrap();
    let cursor = first.recv().await.unwrap().unwrap()["cursor"].clone();
    drop(first);
    for _ in 0..257 {
        replica.watches.changed(key());
    }
    let mut expired = replica
        .subscribe(
            "direct".into(),
            &json!({"sessions":[key()],"cursor":cursor}),
        )
        .unwrap();
    assert_eq!(expired.recv().await.unwrap().unwrap()["kind"], "resync");
    drop(expired);
    let mut watches = Vec::new();
    for group in 0..9 {
        let mut sessions = Vec::new();
        for i in 0..32 {
            let mut snapshot = fixture();
            snapshot.key.session = format!("{group}-{i}");
            sessions.push(snapshot.key.clone());
            replica.snapshots.insert(snapshot.key.clone(), snapshot);
        }
        let result = replica.subscribe(format!("group-{group}"), &json!({"sessions":sessions}));
        if group == 8 {
            assert_eq!(result.err().unwrap().code, "watch_limit_exceeded");
        } else {
            watches.push(result.unwrap());
        }
    }
    let app = AppRead::new(None, None);
    app.publish(fixture());
    let mut sub = app.watch("direct".into(), params).await.unwrap();
    sub.recv().await.unwrap().unwrap();
    drop(app);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), sub.recv())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn app_optional_nulls_match_omitted_fields_and_search_refuses_identity_aliases() {
    let (_dir, conn) = search_db();
    let mut replica = replica(Some(conn));
    let meta = replica
        .read(
            "session_data.read",
            &request(json!({"section":"meta","if_version":null})),
        )
        .unwrap();
    assert_eq!(meta["state"], "ready");
    assert_eq!(
        replica
            .read(
                "context.cache_why",
                &request(json!({"producers":[{"producer_ref":"p","at_ms":null}]}))
            )
            .unwrap()["join"],
        "unavailable"
    );
    let query = json!({"query":"needle absent","scope":{"session":key()},"sources":["message"],"cursor":null});
    let first = replica.read("context.search", &query).unwrap();
    assert_eq!(first["hits"].as_array().unwrap().len(), 50);
    let mut query = query;
    query["cursor"] = first["next_cursor"].clone();
    assert_eq!(
        replica.read("context.search", &query).unwrap()["hits"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    let mut watch = replica
        .subscribe("direct".into(), &json!({"sessions":[key()],"cursor":null}))
        .unwrap();
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "resync");
    let mut other = fixture();
    other.key.harness = "pi".into();
    replica.snapshots.insert(other.key.clone(), other);
    assert_eq!(
        replica.read("context.search", &query).unwrap_err().code,
        "session_ambiguous"
    );
}

#[tokio::test]
async fn archive_message_identity_survives_cut_restart_and_revert() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    save_fixture(&store, &fixture(), None);
    let mut cut = fixture();
    cut.base = 4;
    cut.messages.clear();
    cut.compartments[0]["last_message_id"] = json!("m3");
    cut.compartments[0]["last_message_ordinal"] = json!(3);
    store.save_app_snapshot(&cut).unwrap();
    let app = AppRead::new(Some(store.path.clone()), None);
    let states = app
        .read("context.states", request(json!({"message_ids":["m2"]})))
        .await
        .unwrap();
    assert_eq!(states["messages"][0]["state"], "summarized");
    let compartment = app
        .read(
            "context.compartment",
            request(json!({"compartment_id":"1"})),
        )
        .await
        .unwrap();
    assert_eq!(compartment["compartment"]["first_at_ms"], 10);
    assert_eq!(compartment["compartment"]["last_at_ms"], 30);
    let mut reverted = fixture();
    reverted.base = 1;
    reverted.newest = 1;
    reverted.messages.retain(|_, message| message.ordinal == 1);
    reverted.compartments.clear();
    save_fixture(&store, &reverted, Some(2));
    app.publish(reverted);
    let states = app
        .read("context.states", request(json!({"message_ids":["m2"]})))
        .await
        .unwrap();
    assert_eq!(states["messages"][0]["state"], "outside");
    let conn = Connection::open(&store.path).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM app_read_message_index", [], |row| row
            .get::<_, u64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn cold_session_records_preserve_runner_identity_and_unready_reads_are_transient() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    store
        .save(&key(), &crate::store::Durable::default())
        .unwrap();
    let app = AppRead::new(Some(store.path.clone()), None);
    let mut wrong = request(json!({"section":"meta"}));
    wrong["session"]["runner"] = json!("opencode2");
    let mismatch = app.read("session_data.read", wrong).await.unwrap_err();
    assert_eq!(mismatch.code, "session_runner_mismatch");
    assert_eq!(mismatch.detail.unwrap()["runner"], "thalamus-harness");
    assert_eq!(
        app.read("session_data.read", request(json!({"section":"meta"})))
            .await
            .unwrap_err()
            .code,
        "store_unavailable"
    );
    let mut unready = fixture();
    unready.ready = false;
    app.publish(unready);
    assert_eq!(
        app.read("context.states", request(json!({"message_ids":["m1"]})))
            .await
            .unwrap_err()
            .code,
        "store_unavailable"
    );
    assert_eq!(
        app.read(
            "session_data.read",
            request(json!({"section":"token_breakdown"}))
        )
        .await
        .unwrap_err()
        .code,
        "store_unavailable"
    );
    app.publish(fixture());
    assert_eq!(
        app.read("context.states", request(json!({"message_ids":["m1"]})))
            .await
            .unwrap()["state"],
        "ready"
    );
}

#[test]
fn incremental_boundary_timestamps_fill_when_the_message_arrives_later() {
    let mut replica = replica(None);
    replica.snapshots.clear();
    let mut first = fixture();
    let boundary = first.messages.remove("m1").unwrap();
    first.compartments[0]["first_at_ms"] = Value::Null;
    first.compartments[0]["last_at_ms"] = Value::Null;
    let header = Arc::new(Header {
        base: first.base,
        newest: first.newest,
        ready: first.ready,
        meta: first.meta.clone(),
        breakdown: first.breakdown.clone(),
    });
    replica.publish(first);
    replica.update(Update {
        key: key(),
        header,
        rows: vec![("m1".into(), Arc::new(boundary))],
        reset_from: None,
        prune_before: None,
        compartments: None,
        decisions: None,
        reverted: false,
    });
    let compartment = replica
        .read(
            "context.compartment",
            &request(json!({"compartment_id":"1"})),
        )
        .unwrap();
    assert_eq!(compartment["compartment"]["first_at_ms"], 10);
    assert_eq!(compartment["compartment"]["last_at_ms"], 10);
}

#[tokio::test]
async fn schema_four_app_read_snapshots_migrate_without_changing_reads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version=4; CREATE TABLE app_read_snapshots(runner TEXT,harness TEXT,session TEXT,snapshot TEXT,PRIMARY KEY(runner,harness,session)); CREATE TABLE app_read_decisions(runner TEXT,harness TEXT,session TEXT,decisions TEXT,PRIMARY KEY(runner,harness,session));").unwrap();
    let mut snapshot = fixture();
    snapshot.decisions = vec![json!({"view_version":1,"status":"accepted","at_ms":10})];
    let before = AppRead::new(None, None);
    before.publish(snapshot.clone());
    for session in ["s", "another"] {
        let mut saved = snapshot.clone();
        saved.key.session = session.into();
        conn.execute(
            "INSERT INTO app_read_snapshots VALUES(?1,?2,?3,?4)",
            params![
                saved.key.runner,
                saved.key.harness,
                session,
                serde_json::to_string(&saved).unwrap()
            ],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO app_read_snapshots VALUES('runner','test','broken','not JSON')",
        [],
    )
    .unwrap();
    // Decisions written after the last snapshot must still take precedence.
    conn.execute(
        "INSERT INTO app_read_decisions VALUES(?1,?2,'another','[]')",
        params![snapshot.key.runner, snapshot.key.harness],
    )
    .unwrap();
    drop(conn);
    let store = crate::store::Store::open(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        5
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='app_read_snapshots'",
            [],
            |row| row.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM app_read_headers", [], |row| row
            .get::<_, u64>(0))
            .unwrap(),
        2
    );
    let after = AppRead::new(Some(path.clone()), None);
    for (op, params) in [
        ("session_data.read", json!({"section":"meta"})),
        ("session_data.read", json!({"section":"token_breakdown"})),
        (
            "context.states",
            json!({"message_ids":["m1","m2","m3","missing"]}),
        ),
        ("context.compartment", json!({"compartment_id":"1"})),
        (
            "context.cache_why",
            json!({"producers":[{"producer_ref":"step-1","at_ms":10}]}),
        ),
    ] {
        let params = request(params);
        let expected = before.read(op, params.clone()).await.unwrap();
        let mut actual = after.read(op, params).await.unwrap();
        // The envelope records request time, not checkpoint content.
        actual["as_of_ms"] = expected["as_of_ms"].clone();
        assert_eq!(result_bytes(actual), result_bytes(expected), "changed {op}");
    }
    assert_eq!(
        store.app_decisions(&SessionRef::new(
            &snapshot.key.runner,
            &snapshot.key.harness,
            "another"
        )),
        Vec::<Value>::new()
    );
    drop(store);
    drop(crate::store::Store::open(&path).unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM app_read_headers", [], |row| row
            .get::<_, u64>(0))
            .unwrap(),
        2
    );
}

/// A breakdown keeps its summary items apart, yet reads, compares and
/// serializes as the one object it stands for. A checkpoint header copies
/// the items' JSON and writes the bytes a full serialization writes.
#[test]
fn a_breakdown_reads_and_serializes_as_the_whole_object() {
    #[derive(Serialize)]
    struct Whole<'a> {
        base: u64,
        newest: u64,
        ready: bool,
        meta: &'a Value,
        breakdown: &'a Value,
    }
    let summary = |id: &str, tier: u8| json!({"item":"summary","compartment_id":id,"tier":tier,"tokens":40,"source":"counted"});
    let leading = json!({"item":"memory","tokens":2,"source":"counted"});
    let meta = json!({"session_id":"s\u{1}\"é","compartment_count":2});
    for whole in [
        json!({"as_of":{"step_ref":"m\"3","at_ms":30},"items":[leading.clone(), summary("1", 2), summary("2", 1)],"managed":{"value":true},"total":{"tokens":80},"zz":"é\n"}),
        json!({"items":[summary("1", 3)],"total":null}),
        json!({"items":[leading.clone()],"total":1}),
        json!({"items":[],"total":null}),
        json!({"total":{"tokens":123}}),
        Value::Null,
    ] {
        let breakdown = Breakdown::from_value(whole.clone());
        assert_eq!(breakdown.to_value(), whole);
        assert_eq!(serde_json::to_value(&breakdown).unwrap(), whole);
        assert_eq!(
            serde_json::to_string(&breakdown).unwrap(),
            serde_json::to_string(&whole).unwrap()
        );
        let header = Header {
            base: 3,
            newest: 9,
            ready: true,
            meta: meta.clone(),
            breakdown,
        };
        let full = serde_json::to_string(&Whole {
            base: 3,
            newest: 9,
            ready: true,
            meta: &meta,
            breakdown: &whole,
        })
        .unwrap();
        assert_eq!(header.json(), full);
        assert_eq!(serde_json::to_string(&header).unwrap(), full);
        let loaded: Header = serde_json::from_str(&header.json()).unwrap();
        assert!(loaded == header);
        assert!(Breakdown::from_value(whole.clone()) == header.breakdown);
        if let Some(items) = whole
            .get("items")
            .filter(|items| !items.as_array().unwrap().is_empty())
        {
            let mut other = whole.clone();
            other["items"].as_array_mut().unwrap().pop();
            assert!(Breakdown::from_value(other) != header.breakdown, "{items}");
        }
    }
}
