//! Wire samples from the daemon rig: requests, notices and terminal errors all
//! pass through McHandler and the subscription transport, never a synthetic reply.
use super::*;

fn params(cursor: Option<&str>) -> Value {
    let mut params = json!({"sessions":[{"runner":"opencode","harness":"opencode","session":"s"}]});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    params
}

impl Rig {
    async fn sample_rig() -> Self {
        Self::start_configured(|handler, _| {
            let hub = Arc::get_mut(&mut handler.context_watches).unwrap();
            hub.epoch = "abc".into();
            // Drive refreshes explicitly. A preinstalled observer avoids
            // background baseline/debounce races;
            // subscription admission and forwarding still use production code.
            *hub.observer.get_mut().unwrap() =
                Some(notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap());
        })
        .await
    }

    async fn sample_subscribe(
        &self,
        management: bool,
        params: &Value,
    ) -> subc_client_rs::Subscription {
        self.consumer
            .subscribe(
                self.target(management),
                self.identity.clone(),
                serde_json::to_vec(&json!({"method":METHOD,"params":params})).unwrap(),
                SubscribeOptions::default(),
            )
            .await
            .unwrap()
    }
}

async fn wire_notice(sub: &mut subc_client_rs::Subscription) -> Value {
    let bytes = tokio::time::timeout(Duration::from_secs(5), sub.events().recv())
        .await
        .expect("sample notice timeout")
        .expect("sample notice");
    serde_json::from_slice(&bytes).expect("notice JSON")
}

async fn wire_refusal(sub: &mut subc_client_rs::Subscription) -> HandlerOutcome {
    let end = tokio::time::timeout(Duration::from_secs(5), sub.ended())
        .await
        .expect("sample refusal timeout");
    match end {
        SubscriptionEnd::Error(error) => HandlerOutcome::ErrorWithDetail {
            code: error.code,
            message: error.message,
            detail: error.detail.unwrap_or(Value::Null),
        },
        other => panic!("expected wire refusal, got {other:?}"),
    }
}

fn record(
    name: &'static str,
    file: &'static str,
    params: Value,
    result: Result<Value, HandlerOutcome>,
) -> Sample {
    Sample {
        name,
        file,
        params,
        result,
    }
}

pub(in super::super) async fn samples() -> Vec<Sample> {
    let rig = Rig::sample_rig().await;
    let mut records = Vec::new();
    let request = params(None);
    let mut direct = rig.sample_subscribe(false, &request).await;
    records.push(record(
        "resync",
        "context.watch/resync.json",
        request.clone(),
        Ok(wire_notice(&mut direct).await),
    ));

    let mut fresh = rig.sample_subscribe(false, &request).await;
    records.push(record(
        "first notice without cursor is resync",
        "context.watch/first-no-cursor.json",
        request.clone(),
        Ok(wire_notice(&mut fresh).await),
    ));
    drop(fresh);
    rig.slots(1).await;

    let mut management = rig.sample_subscribe(true, &request).await;
    records.push(record(
        "management first notice without cursor is wrapped resync",
        "context.watch/management-first-no-cursor.json",
        request.clone(),
        Ok(wire_notice(&mut management).await),
    ));
    super::super::super::tests_support::apply_sql(
        &rig.dir.path().join("context.db"),
        "UPDATE session_meta SET compartment_in_progress=1 WHERE session_id='s'",
    );
    rig.handler
        .context_watches
        .refresh(Arc::clone(rig.handler.store.get().unwrap()));
    records.push(record(
        "changes",
        "context.watch/changes.json",
        request.clone(),
        Ok(wire_notice(&mut direct).await),
    ));
    records.push(record(
        "management changes notice is wrapped",
        "context.watch/management-changes.json",
        request.clone(),
        Ok(wire_notice(&mut management).await),
    ));

    for (name, file, cursor) in [
        (
            "first notice with replayable cursor is changes since that cursor",
            "context.watch/first-valid-cursor.json",
            "abc:0",
        ),
        (
            "first notice with current cursor is changes with no sessions",
            "context.watch/first-current-cursor.json",
            "abc:1",
        ),
    ] {
        let request = params(Some(cursor));
        let mut sub = rig.sample_subscribe(false, &request).await;
        records.push(record(name, file, request, Ok(wire_notice(&mut sub).await)));
        drop(sub);
        rig.slots(2).await;
    }

    // An observer rescan invalidates replay across the resync floor, even when
    // the cursor's epoch is still current and its version is in retained history.
    rig.handler.context_watches.publish(BTreeMap::new(), true);
    for (name, file, cursor) in [
        (
            "first notice with stale cursor is resync",
            "context.watch/first-stale-cursor.json",
            "abc:0",
        ),
        (
            "first notice with unknown epoch is resync",
            "context.watch/first-unknown-cursor.json",
            "def:0",
        ),
    ] {
        let request = params(Some(cursor));
        let mut sub = rig.sample_subscribe(false, &request).await;
        records.push(record(name, file, request, Ok(wire_notice(&mut sub).await)));
        drop(sub);
        rig.slots(2).await;
    }

    let mut held = Vec::new();
    for _ in 2..PER_CALLER {
        let mut sub = rig.sample_subscribe(false, &request).await;
        wire_notice(&mut sub).await;
        held.push(sub);
    }
    let mut refused = rig.sample_subscribe(false, &request).await;
    records.push(record(
        "refusal",
        "context.watch/refusal.json",
        request.clone(),
        Err(wire_refusal(&mut refused).await),
    ));

    // Do not yield while publishing: fill the provider queue, not the consumer's
    // transport buffer, so forwarding must return the handler's lagged refusal.
    for i in 0..=QUEUE {
        rig.handler.context_watches.publish(
            BTreeMap::from([(
                ("opencode".into(), "opencode".into(), "s".into()),
                Snapshot {
                    digest: i.to_le_bytes().to_vec(),
                    deadline: None,
                },
            )]),
            false,
        );
    }
    records.push(record(
        "stream ends with lagged when the subscriber falls behind",
        "context.watch/refusal-lagged.json",
        request,
        Err(wire_refusal(&mut direct).await),
    ));
    drop(held);
    drop(management);
    rig.slots(0).await;

    records.extend(refusal_samples().await);
    records
}

async fn refusal_samples() -> Vec<Sample> {
    let rig = Rig::sample_rig().await;
    let mut records = Vec::new();
    let session = params(None)["sessions"][0].clone();
    for (name, file, request) in [
        (
            "sessions must be an array",
            "context.watch/refusal-invalid-params.json",
            json!({"sessions":false}),
        ),
        (
            "sessions must not be empty",
            "context.watch/refusal-empty-sessions.json",
            json!({"sessions":[]}),
        ),
        (
            "sessions are limited to 32 references",
            "context.watch/refusal-too-many-sessions.json",
            json!({"sessions":vec![session.clone(); SESSION_LIMIT + 1]}),
        ),
        (
            "session references must be unique",
            "context.watch/refusal-duplicate-session.json",
            json!({"sessions":[session.clone(), session.clone()]}),
        ),
        (
            "unknown watch parameters are refused",
            "context.watch/refusal-unknown-param.json",
            json!({"sessions":[session.clone()],"extra":true}),
        ),
        (
            "session reference fields must be strings",
            "context.watch/refusal-invalid-session.json",
            json!({"sessions":[{"runner":"opencode","harness":"opencode","session":false}]}),
        ),
        (
            "cursor must be a bounded nonempty string",
            "context.watch/refusal-cursor-type.json",
            json!({"sessions":[session],"cursor":false}),
        ),
        (
            "cursor must have epoch and version syntax",
            "context.watch/refusal-cursor-syntax.json",
            params(Some("not-a-cursor")),
        ),
        (
            "unknown session is refused before streaming",
            "context.watch/refusal-unknown-session.json",
            json!({"sessions":[{"runner":"opencode","harness":"opencode","session":"missing"}]}),
        ),
        (
            "standalone session runner must equal its harness",
            "context.watch/refusal-runner-mismatch.json",
            json!({"sessions":[{"runner":"other","harness":"opencode","session":"s"}]}),
        ),
    ] {
        let mut sub = rig.sample_subscribe(false, &request).await;
        let refusal = wire_refusal(&mut sub).await;
        assert!(
            sub.events().try_recv().is_err(),
            "setup refusal emitted a notice"
        );
        records.push(record(name, file, request, Err(refusal)));
    }

    // Ambiguity is detected before decoding either async record. Two different
    // conversation keys can name the same harness/session, regardless of runner.
    super::super::super::tests_support::apply_sql(
        &rig.dir.path().join("store.db"),
        r#"INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json)
           VALUES('a','["a","agent","opencode"]','s','{}'),
                 ('b','["b","agent","opencode"]','s','{}');"#,
    );
    let request = params(None);
    let mut sub = rig.sample_subscribe(false, &request).await;
    records.push(record(
        "ambiguous session is refused before streaming",
        "context.watch/refusal-ambiguous-session.json",
        request.clone(),
        Err(wire_refusal(&mut sub).await),
    ));

    let unavailable = Rig::start_configured(|handler, _| {
        handler.store = Arc::default();
    })
    .await;
    let mut sub = unavailable.sample_subscribe(false, &request).await;
    records.push(record(
        "store must be open before subscribing",
        "context.watch/refusal-store-unavailable.json",
        request.clone(),
        Err(wire_refusal(&mut sub).await),
    ));

    let unobservable = Rig::start_configured(|handler, dir| {
        // Keep the read connections open, but remove a database's original path.
        // SQL remains readable while native observation cannot resolve that path.
        let store = handler.store.get().unwrap();
        store
            .with_context_read(|conn| conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0)))
            .unwrap();
        store
            .with_store_read(|conn| conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0)))
            .unwrap();
        std::fs::rename(dir.join("context.db"), dir.join("context-moved.db")).unwrap();
    })
    .await;
    let mut sub = unobservable.sample_subscribe(false, &request).await;
    let refusal = wire_refusal(&mut sub).await;
    assert!(
        matches!(&refusal, HandlerOutcome::ErrorWithDetail { code, .. } if code == "watch_unavailable"),
        "{refusal:?}"
    );
    records.push(record(
        "database path cannot be observed before streaming",
        "context.watch/refusal-watch-unavailable.json",
        request,
        Err(refusal),
    ));
    records
}
