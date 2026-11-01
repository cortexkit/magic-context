// UI reads and commands must preserve caller scope, private state, unknown values, and reply bounds.

fn attested_fixture() -> (McHandler, Arc<McStore>, tempfile::TempDir) {
    let (handler, store, dir) = fixture();
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.harness = "opencode".into();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    handler.bind_route(7, binding);
    (handler, store, dir)
}

#[tokio::test]
async fn review_ops_requires_attested_caller_before_any_ui_arm() {
    let (handler, store, _dir) = fixture();
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.harness = "opencode".into();
    binding.principal = None;
    handler.bind_route(7, binding);
    let job = store.ops_flush("ops-a", "existing", true, 1).unwrap();
    let page = store.ops_events("ops-a", 0, 64).unwrap();
    let mut admitted = Vec::new();
    for method in non_served_contract::UI_METHODS {
        let mut req = request(method);
        req["command_id"] = json!("existing");
        req["job_id"] = job["job_id"].clone();
        req["event_id"] = page["events"][0]["event_id"].clone();
        req["acked_position"] = json!(0);
        // A request-supplied identity cannot replace daemon attestation.
        req["principal"] = json!({"type":"reserved","module_id":"thalamus-harness"});
        match handler.dispatch_value(7, req).await {
            HandlerOutcome::Error { code, .. }
                if !matches!(
                    code.as_str(),
                    "route_not_ported" | "cancel_unsupported" | "job_not_found"
                ) => {}
            _ => admitted.push(*method),
        }
    }
    assert!(
        admitted.is_empty(),
        "unattested caller reached UI/domain arms: {admitted:?}"
    );
}

#[tokio::test]
async fn review_ops_ledger_rejects_same_session_from_another_project_binding() {
    let (handler, store, dir) = attested_fixture();
    let job = store
        .ops_flush("ops-a", "project-a-command", true, 1)
        .unwrap();
    let page = store.ops_events("ops-a", 0, 64).unwrap();
    let mut req = request("mc.job_read");
    req["command_id"] = job["command_id"].clone();
    assert_eq!(call(&handler, req).await["job"], job);

    let other_root = dir.path().join("other-project");
    std::fs::create_dir(&other_root).unwrap();
    store.set_route_identity_for_test(other_root.to_str().unwrap(), "project-b");
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.project_root = other_root.clone();
    handler.bind_route(7, binding);
    assert_eq!(
        handler.resolve_binding(7, "ops-a").unwrap().project_root,
        other_root
    );

    let mut leaked = Vec::new();
    for (method, key, value) in [
        ("mc.job_read", "command_id", job["command_id"].clone()),
        ("mc.job_read", "job_id", job["job_id"].clone()),
        ("mc.flush", "command_id", job["command_id"].clone()),
        ("mc.ui_events", "acked_position", json!(0)),
        (
            "mc.notice_currentness",
            "event_id",
            page["events"][0]["event_id"].clone(),
        ),
    ] {
        let mut req = request(method);
        req[key] = value;
        // The request's project hint cannot authorize access to project-a's jobs or events.
        req["project"] = json!("project-a");
        if let HandlerOutcome::Response(bytes) = handler.dispatch_value(7, req).await {
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            let exposes_previous = body.get("job").is_some()
                || body.get("job_id").is_some()
                || body["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
                || body["current"] == true;
            if exposes_previous {
                leaked.push(format!("{method}/{key}"));
            }
        }
    }
    assert!(
        leaked.is_empty(),
        "project-b can observe project-a's retained ledger: {leaked:?}"
    );
}

#[tokio::test]
async fn review_ops_status_does_not_disclose_historian_claim_secret() {
    let (handler, store, _dir) = attested_fixture();
    let mut loaded = store.load_meta("ops-a").unwrap();
    loaded.meta.historian.coordinator_token = Some("claimant-only-test-secret".into());
    loaded.meta.historian.producer_run_id = Some("active-run".into());
    store
        .commit_meta("ops-a", loaded.row_version, &loaded.meta)
        .unwrap();
    let body = call(&handler, request("mc.read_status")).await;
    assert!(
        !body.to_string().contains("claimant-only-test-secret"),
        "UI diagnostics must project public historian fields, not the claimant credential"
    );
}

#[tokio::test]
async fn review_ops_missing_input_usage_is_not_an_authoritative_zero() {
    let (handler, store, _dir) = attested_fixture();
    let usage: mc_store::ModuleUsage =
        serde_json::from_value(json!({"context_limit_tokens":100000})).unwrap();
    assert!(usage.is_non_zero());
    let mut loaded = store.load_meta("ops-a").unwrap();
    // The context transform persists this whole usage object when is_non_zero returns true.
    loaded.meta.last_usage = Some(usage);
    store
        .commit_meta("ops-a", loaded.row_version, &loaded.meta)
        .unwrap();
    let body = call(&handler, request("mc.read_sidebar")).await;
    assert_eq!(body["data"]["context_limit"]["value"], 100000);
    for field in [
        "input_tokens",
        "usage_percentage",
        "native_context_usage_percentage",
    ] {
        assert_eq!(
            body["data"][field]["authority"], "unknown",
            "unobserved {field} must remain unknown"
        );
    }
}

#[tokio::test]
async fn review_ops_todo_read_respects_one_mib_ui_reply_budget() {
    let (handler, _store, _dir) = attested_fixture();
    let mut ingress = request("todo_state.set");
    ingress["owner_message_id"] = json!("todo-owner");
    ingress["state_json"] = json!(json!([{
        "content":"x".repeat(2 * 1024 * 1024), "status":"pending", "priority":"medium"
    }])
    .to_string());
    crate::enforce_request_byte_cap(&serde_json::to_vec(&ingress).unwrap()).unwrap();
    assert_eq!(call(&handler, ingress).await["ok"], true);
    match handler.dispatch_value(7, request("mc.read_todos")).await {
        HandlerOutcome::Response(bytes) => assert!(
            bytes.len() <= 1024 * 1024,
            "UI reply is {} bytes; return a bounded page or explicit unavailable/refusal",
            bytes.len()
        ),
        HandlerOutcome::Error { .. } => {}
        other => panic!("unexpected read outcome: {other:?}"),
    }
}

#[tokio::test]
async fn review_control_foreign_session_cannot_read_or_ack_another_ledger() {
    let (handler, store, _dir) = attested_fixture();
    let job = store
        .ops_flush("ops-a", "shared-command-id", true, 1)
        .unwrap();
    let page = store.ops_events("ops-a", 0, 64).unwrap();
    let event_id = page["events"][0]["event_id"].clone();
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.session = "ops-b".into();
    handler.bind_route(8, binding);
    for method in ["mc.job_read", "mc.job_cancel"] {
        for key in ["command_id", "job_id"] {
            let mut req = json!({"method":method,"v":1,"session_id":"ops-b"});
            req[key] = job[key].clone();
            assert_eq!(code(handler.dispatch_value(8, req).await), "job_not_found");
        }
    }
    assert_eq!(
        code(
            handler
                .dispatch_value(
                    8,
                    json!({
                        "method":"mc.ui_events","v":1,"session_id":"ops-b","acked_position":1
                    })
                )
                .await
        ),
        "invalid_ack"
    );
    let outcome = handler
        .dispatch_value(
            8,
            json!({
                "method":"mc.notice_currentness","v":1,"session_id":"ops-b","event_id":event_id
            }),
        )
        .await;
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("currentness read failed")
    };
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["current"], false);
    assert!(store
        .ops_currentness("ops-a", event_id.as_str().unwrap())
        .unwrap());
    assert_eq!(
        store.ops_events("ops-a", 0, 64).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let other = store
        .ops_flush("ops-b", "shared-command-id", true, 2)
        .unwrap();
    assert_ne!(other["job_id"], job["job_id"]);
}
