use super::*;
use crate::app_read::tests_support::{apply_sql, open_store};

fn session() -> Value {
    json!({"runner":"opencode","harness":"opencode","session":"s"})
}
fn request(cursor: Option<&str>) -> Request {
    let mut params = json!({"sessions":[session()]});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    Request::parse(params.as_object().unwrap()).unwrap_or_else(|e| panic!("{e:?}"))
}
fn setup() -> (tempfile::TempDir, AppReadContext<'static>, Arc<Hub>) {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    apply_sql(
        &dir.path().join("context.db"),
        "INSERT INTO session_meta(session_id,harness) VALUES('s','opencode');",
    );
    (
        dir,
        AppReadContext::from_parts(Some(store), Arc::default(), vec![], crate::now_ms()),
        Arc::new(Hub::default()),
    )
}
async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(5), sub.rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn native_writes_wake_for_each_event_kind_and_plain_reads_stay_identical() {
    let (dir, ctx, hub) = setup();
    let caller = crate::app_read::tests_support::caller();
    let body = serde_json::to_vec(
        &json!({"method":"session_data.read","params":{"session":session(),"section":"meta"}}),
    )
    .unwrap();
    let before =
        crate::app_read::tests_support::response(&super::super::handle(&caller, true, &body, &ctx));
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut sub).await["kind"], "resync");
    assert_eq!(
        before,
        crate::app_read::tests_support::response(&super::super::handle(&caller, true, &body, &ctx))
    );
    for sql in [
        "UPDATE session_meta SET compartment_in_progress=1 WHERE session_id='s'",
        "UPDATE session_meta SET compartment_in_progress=0,historian_failure_count=1,historian_last_error='failure' WHERE session_id='s'",
        "INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness) VALUES('s',1,1,2,'title','summary',10,'opencode')",
        "INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES('s','1','drop',10,'opencode')",
        "UPDATE session_meta SET last_input_tokens=123,total_input_tokens=234,last_context_percentage=12 WHERE session_id='s'",
        "INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES('s',1,'m:p0','message','active',10)",
        "UPDATE tags SET status='dropped' WHERE session_id='s'",
        "UPDATE tags SET byte_size=100,token_count=20,drop_mode='full' WHERE session_id='s'",
        "UPDATE pending_ops SET queued_at=20 WHERE session_id='s'",
        "UPDATE compartments SET content='recompiled' WHERE session_id='s'",
        "DELETE FROM compartments WHERE session_id='s'",
        "DELETE FROM pending_ops WHERE session_id='s'",
    ] {
        apply_sql(&dir.path().join("context.db"), sql);
        if sql.starts_with("UPDATE tags SET byte_size") || sql.starts_with("UPDATE pending_ops SET queued_at") {
            let store = Arc::clone(ctx.store.as_ref().unwrap());
            hub.check_slow(Arc::clone(&store), false, true);
            hub.refresh(store);
        }
        let notice = next(&mut sub).await;
        assert_eq!(notice["kind"], "changes", "{sql}");
        assert_eq!(notice["sessions"], json!([session()]), "{sql}");
        assert!(notice.get("rows").is_none());
    }
}

#[tokio::test]
async fn slow_baseline_closes_admission_window_and_catches_each_payload_edit() {
    let (dir, ctx, hub) = setup();
    apply_sql(&dir.path().join("context.db"), "INSERT INTO tags(session_id,tag_number,message_id,type,status,tool_name,byte_size) VALUES('s',1,'call','tool','dropped','bash',10); INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES('s','1','drop',10,'opencode')");
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut sub).await["kind"], "resync");
    // An edit after the initial notice but before the first hash has no cheap
    // version signal. Baseline completion must still invalidate that window.
    apply_sql(
        &dir.path().join("context.db"),
        "UPDATE tags SET drop_mode='full' WHERE session_id='s'",
    );
    let store = Arc::clone(ctx.store.as_ref().unwrap());
    hub.check_slow(Arc::clone(&store), true, true);
    hub.refresh(Arc::clone(&store));
    assert_eq!(next(&mut sub).await["kind"], "changes");
    for assignment in [
        "drop_mode='skeleton_real'",
        "byte_size=123",
        "token_count=44",
        "tool_name='read'",
        "input_byte_size=77",
        "input_token_count=33",
    ] {
        apply_sql(
            &dir.path().join("context.db"),
            &format!("UPDATE tags SET {assignment} WHERE session_id='s'"),
        );
        hub.check_slow(Arc::clone(&store), false, true);
        hub.refresh(Arc::clone(&store));
        assert_eq!(next(&mut sub).await["kind"], "changes", "{assignment}");
    }
    apply_sql(
        &dir.path().join("context.db"),
        "UPDATE pending_ops SET queued_at=88 WHERE session_id='s'",
    );
    hub.check_slow(Arc::clone(&store), false, true);
    hub.refresh(Arc::clone(&store));
    assert_eq!(next(&mut sub).await["kind"], "changes");
    hub.check_slow(Arc::clone(&store), false, true);
    hub.refresh(store);
    assert!(
        sub.rx.try_recv().is_err(),
        "identical slow checks are silent"
    );
}

#[test]
fn slow_check_interval_is_bounded_by_measured_cost() {
    assert_eq!(slow_interval_ms(0.5), 10_000);
    assert_eq!(slow_interval_ms(99.9), 10_000);
    assert_eq!(slow_interval_ms(250.0), 25_000);
    assert_eq!(slow_interval_ms(333.333), 33_334);
}

#[tokio::test]
async fn host_breakdown_changes_wake_once_and_identical_rewrites_are_silent() {
    let (dir, ctx, hub) = setup();
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut sub).await["kind"], "resync");
    let db = dir.path().join("context.db");
    let sql = "CREATE TABLE IF NOT EXISTS session_render_cache(session_id TEXT, cache_key TEXT, value BLOB, PRIMARY KEY(session_id,cache_key)) WITHOUT ROWID;
        INSERT OR REPLACE INTO session_render_cache VALUES('s','host_token_breakdown','{\"version\":2,\"measured_at\":100,\"parts\":{\"system_prompt\":10}}');";
    apply_sql(&db, sql);
    let store = Arc::clone(ctx.store.as_ref().unwrap());
    // Exercise one FAST refresh, without waiting for the slow payload scanner.
    hub.refresh(Arc::clone(&store));
    let notice = sub
        .rx
        .try_recv()
        .expect("one wake publishes the saved breakdown");
    assert_eq!(notice["kind"], "changes");
    assert_eq!(notice["sessions"], json!([session()]));
    apply_sql(&db, sql);
    hub.refresh(store);
    assert!(sub.rx.try_recv().is_err());
}

#[tokio::test]
async fn burst_coalesces_and_unrelated_commits_are_silent() {
    let (dir, ctx, hub) = setup();
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    next(&mut sub).await;
    for i in 1..=20 {
        apply_sql(
            &dir.path().join("context.db"),
            &format!("UPDATE session_meta SET counter={i} WHERE session_id='s'"),
        );
    }
    assert_eq!(next(&mut sub).await["kind"], "changes");
    tokio::time::sleep(DEBOUNCE * 3).await;
    assert!(sub.rx.try_recv().is_err());
    apply_sql(
        &dir.path().join("context.db"),
        "INSERT INTO session_meta(session_id,harness) VALUES('other','pi')",
    );
    tokio::time::sleep(DEBOUNCE * 3).await;
    assert!(sub.rx.try_recv().is_err());
}

#[tokio::test]
async fn reconnect_replays_changes_or_resyncs_and_dropped_watch_frees_quota() {
    let (dir, ctx, hub) = setup();
    let mut first = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let initial = next(&mut first).await;
    let cursor = initial["cursor"].as_str().unwrap();
    apply_sql(
        &dir.path().join("context.db"),
        "UPDATE session_meta SET counter=1 WHERE session_id='s'",
    );
    next(&mut first).await;
    let mut resumed = hub
        .subscribe("direct".into(), (2, 1), request(Some(cursor)), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut resumed).await["kind"], "changes");
    let mut foreign = hub
        .subscribe("direct".into(), (3, 1), request(Some("abc:0")), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut foreign).await["kind"], "resync");
    let mut slots = vec![first, resumed, foreign];
    for channel in 4..=PER_CALLER {
        slots.push(
            hub.subscribe("direct".into(), (channel as u16, 1), request(None), &ctx)
                .unwrap_or_else(|e| panic!("{e:?}")),
        );
    }
    assert!(
        matches!(hub.subscribe("direct".into(), (9,1), request(None), &ctx), Err(HandlerOutcome::ErrorWithDetail {code,..}) if code == "watch_limit_exceeded")
    );
    slots.pop();
    let replacement = hub
        .subscribe("direct".into(), (9, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    hub.remove_route((9, 2));
    assert!(hub
        .state
        .lock()
        .unwrap()
        .subscribers
        .contains_key(&replacement.id));
    hub.remove_route((9, 1));
    assert!(!hub
        .state
        .lock()
        .unwrap()
        .subscribers
        .contains_key(&replacement.id));
    drop(slots);
    drop(replacement);
    let mut new = hub
        .subscribe("direct".into(), (10, 1), request(Some(cursor)), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut new).await["kind"], "resync");
}

#[tokio::test]
async fn cache_timer_emits_once_without_another_write() {
    let (dir, mut ctx, hub) = setup();
    let now = crate::now_ms();
    apply_sql(
        &dir.path().join("context.db"),
        &format!(
            "UPDATE session_meta SET last_response_time={now},cache_ttl='1s' WHERE session_id='s'"
        ),
    );
    ctx.now_ms = now;
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    next(&mut sub).await;
    assert_eq!(next(&mut sub).await["kind"], "changes");
    tokio::time::sleep(DEBOUNCE * 3).await;
    assert!(sub.rx.try_recv().is_err());
}

#[test]
fn watch_request_is_bounded_and_strict() {
    for (params, code) in [
        (json!({"sessions":[session()],"extra":1}), "invalid_params"),
        (json!({"sessions":[]}), "invalid_params"),
        (json!({"sessions":[session(),session()]}), "invalid_params"),
        (
            json!({"sessions":[session()],"cursor":"bogus"}),
            "cursor_invalid",
        ),
        (
            json!({"sessions":[{"runner":"pi","harness":"pi","session":"s","extra":true}]}),
            "invalid_params",
        ),
    ] {
        assert!(
            matches!(Request::parse(params.as_object().unwrap()), Err(HandlerOutcome::ErrorWithDetail {code: c,..}) | Err(HandlerOutcome::Error {code: c,..}) if c == code)
        );
    }
}

#[tokio::test]
async fn retention_loss_and_notification_loss_resync_once_then_resume() {
    let (_dir, ctx, hub) = setup();
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let initial = next(&mut sub).await;
    for i in 0..=HISTORY {
        let k =
            key(&locator::SessionRef::parse(&session(), "session")
                .unwrap_or_else(|e| panic!("{e:?}")));
        hub.publish(
            BTreeMap::from([(
                k,
                Snapshot {
                    digest: i.to_le_bytes().to_vec(),
                    deadline: None,
                },
            )]),
            false,
        );
        next(&mut sub).await;
    }
    let mut old = hub
        .subscribe(
            "direct".into(),
            (2, 1),
            request(initial["cursor"].as_str()),
            &ctx,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut old).await["kind"], "resync");
    hub.publish(BTreeMap::new(), true);
    let resync = next(&mut sub).await;
    assert_eq!(resync["kind"], "resync");
    let mut resumed = hub
        .subscribe(
            "direct".into(),
            (3, 1),
            request(resync["cursor"].as_str()),
            &ctx,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    let current = next(&mut resumed).await;
    assert_eq!(current["kind"], "changes");
    assert_eq!(current["sessions"], json!([]));
}

#[tokio::test]
async fn lagging_subscriber_is_ended_and_does_not_hold_a_slot() {
    let (_dir, ctx, hub) = setup();
    let mut sub = hub
        .subscribe("direct".into(), (1, 1), request(None), &ctx)
        .unwrap_or_else(|e| panic!("{e:?}"));
    next(&mut sub).await;
    let k =
        key(&locator::SessionRef::parse(&session(), "session").unwrap_or_else(|e| panic!("{e:?}")));
    for i in 0..=QUEUE {
        hub.publish(
            BTreeMap::from([(
                k.clone(),
                Snapshot {
                    digest: i.to_le_bytes().to_vec(),
                    deadline: None,
                },
            )]),
            false,
        );
    }
    assert!(sub.lagged.load(std::sync::atomic::Ordering::Acquire));
    assert!(!hub.state.lock().unwrap().subscribers.contains_key(&sub.id));
}

#[tokio::test]
async fn mode3_runner_publication_queue_usage_and_historian_changes_wake() {
    let (dir, ctx, hub) = setup();
    let key = crate::providers::Key {
        runner: "runner".into(),
        session: "s".into(),
        harness: "opencode".into(),
    };
    let state =
        json!({"key":key,"runner_module":"runner","generation":1,"resync":false,"applied":0});
    let reference = "runner:opencode:s";
    let namespace = format!("{}:async:1", key.engine_key());
    let db = dir.path().join("store.db");
    apply_sql(&db, &format!("INSERT INTO mc_async_compaction(session_ref,session,conversation_key,state_json,version_high_water) VALUES('{reference}','s','{}','{}',0); INSERT INTO mc_cache_state(session_id,row_version,core_state,meta) VALUES('{namespace}',1,'{{}}','{{}}');", key.store_key().conversation_key().replace('\'',"''"), state.to_string().replace('\'',"''")));
    let params = json!({"sessions":[{"runner":"runner","harness":"opencode","session":"s"}]});
    let mut sub = hub
        .subscribe(
            "direct".into(),
            (1, 1),
            Request::parse(params.as_object().unwrap()).unwrap_or_else(|e| panic!("{e:?}")),
            &ctx,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut sub).await["kind"], "resync");
    for sql in [
        "UPDATE mc_async_compaction SET version_high_water=1".to_owned(),
        format!("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('{namespace}','t1',10)"),
        format!("UPDATE mc_cache_state SET meta='{{\"historian\":{{\"state\":\"running\"}}}}' WHERE session_id='{namespace}'"),
        format!("UPDATE mc_cache_state SET meta='{{\"historian\":{{\"state\":\"idle\"}},\"last_usage\":{{\"current_total_input_tokens\":123}}}}' WHERE session_id='{namespace}'"),
        format!("INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json) VALUES('{reference}','s',1,'{{}}')"),
        "UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.applied',1)".into(),
    ] {
        apply_sql(&db, &sql);
        assert_eq!(next(&mut sub).await["kind"], "changes", "{sql}");
    }
    let now = crate::now_ms();
    apply_sql(&db, &format!("UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.usage_policy.last_response_at_ms',{now}); UPDATE mc_cache_state SET meta='{{\"cache_ttl_policy\":{{\"value\":\"1s\"}}}}' WHERE session_id='{namespace}'"));
    assert_eq!(next(&mut sub).await["kind"], "changes");
    assert_eq!(next(&mut sub).await["kind"], "changes");
}

/// Store a mode-3 record for session `s` held by runner `runner`, as a move
/// from standalone leaves it: the standalone `session_meta` row stays.
fn seed_mode3_record(dir: &std::path::Path) {
    let key = crate::providers::Key {
        runner: "runner".into(),
        session: "s".into(),
        harness: "opencode".into(),
    };
    let state =
        json!({"key":key,"runner_module":"runner","generation":1,"resync":false,"applied":0});
    let namespace = format!("{}:async:1", key.engine_key());
    apply_sql(&dir.join("store.db"), &format!("INSERT INTO mc_async_compaction(session_ref,session,conversation_key,state_json,version_high_water) VALUES('runner:opencode:s','s','{}','{}',0); INSERT INTO mc_cache_state(session_id,row_version,core_state,meta) VALUES('{namespace}',1,'{{}}','{{}}');", key.store_key().conversation_key().replace('\'',"''"), state.to_string().replace('\'',"''")));
}

#[tokio::test]
async fn a_refused_session_stays_its_own_and_the_rest_keep_updating() {
    let (dir, ctx, hub) = setup();
    let stale = json!({"runner":"opencode","harness":"opencode","session":"gone"});
    let params = json!({"sessions":[session(), stale]});
    // `gone` has no record anywhere. Before, one unreadable reference refused
    // the whole subscription.
    let mut sub = hub
        .subscribe(
            "direct".into(),
            (1, 1),
            Request::parse(params.as_object().unwrap()).unwrap_or_else(|e| panic!("{e:?}")),
            &ctx,
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(next(&mut sub).await["kind"], "resync");
    // Settle the one admission confirmation every watched session gets after its
    // first full-hash baseline. On the refused session that full hash is its
    // refusal, so it must never turn into a resync of every session.
    let store = Arc::clone(ctx.store.as_ref().unwrap());
    hub.check_slow(Arc::clone(&store), false, true);
    hub.refresh(Arc::clone(&store));
    tokio::time::sleep(DEBOUNCE * 3).await;
    while let Ok(notice) = sub.rx.try_recv() {
        assert_eq!(notice["kind"], "changes", "{notice}");
    }
    let db = dir.path().join("context.db");
    apply_sql(
        &db,
        "UPDATE session_meta SET counter=1 WHERE session_id='s'",
    );
    let notice = next(&mut sub).await;
    assert_eq!(notice["kind"], "changes");
    assert_eq!(notice["sessions"], json!([session()]));
    hub.check_slow(Arc::clone(&store), false, true);
    hub.refresh(Arc::clone(&store));
    tokio::time::sleep(DEBOUNCE * 3).await;
    assert!(sub.rx.try_recv().is_err(), "an unchanged refusal is silent");
    // Becoming readable is reported once, for that session alone.
    apply_sql(
        &db,
        "INSERT INTO session_meta(session_id,harness) VALUES('gone','opencode')",
    );
    let notice = next(&mut sub).await;
    assert_eq!(notice["kind"], "changes");
    assert_eq!(notice["sessions"], json!([stale]));
}

#[test]
fn a_moved_session_is_not_served_from_its_stale_standalone_rows() {
    let (dir, ctx, _hub) = setup();
    seed_mode3_record(dir.path());
    let caller = crate::app_read::tests_support::caller();
    let read = |session: Value| {
        let body = serde_json::to_vec(
            &json!({"method":"session_data.read","params":{"session":session,"section":"meta"}}),
        )
        .unwrap();
        super::super::handle(&caller, true, &body, &ctx)
    };
    match read(session()) {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "session_runner_mismatch");
            assert_eq!(detail["runner"], "runner");
        }
        other => panic!("a moved session's old runner must refuse, got {other:?}"),
    }
}
