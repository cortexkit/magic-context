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
        let notice = next(&mut sub).await;
        assert_eq!(notice["kind"], "changes", "{sql}");
        assert_eq!(notice["sessions"], json!([session()]), "{sql}");
        assert!(notice.get("rows").is_none());
    }
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
