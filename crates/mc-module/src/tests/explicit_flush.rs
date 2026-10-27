use super::*;

const QUEUED_BODY: &str = "answer queued for removal";

fn wire(messages: Vec<CkIngressMessage>, usage: u64) -> Value {
    let mut request = request_with_usage(messages, usage, 100_000);
    request["serializer_profile"] = json!("opencode-aisdk");
    request["tool_present"] = json!(true);
    request["model_key"] = json!("anthropic/claude-opus-5-5");
    request["system_prompt_hash"] = json!("unchanged-system");
    request["prev_response_completed_at_ms"] = json!(now_ms());
    request
}

fn messages() -> Vec<CkIngressMessage> {
    vec![
        ck("old-user", 1, "old question"),
        ck_with_role("old-answer", 2, "assistant", QUEUED_BODY),
        ck("current-user", 3, "first real user question"),
    ]
}

fn frozen(loaded: &mc_store::LoadedState, key: &str) -> String {
    loaded
        .core
        .frozen_units
        .iter()
        .find(|unit| unit.key == key)
        .unwrap_or_else(|| panic!("missing frozen unit {key}: {:?}", loaded.core.frozen_units))
        .frozen_payload
        .clone()
}

fn queue_answer(store: &McStore) -> String {
    let target = store
        .load_tags_for_session("ses")
        .unwrap()
        .into_iter()
        .find(|tag| tag.block_id.starts_with("old-answer#"))
        .expect("the served assistant text is registered")
        .block_id;
    store
        .append_pending_agent_drops("ses", std::slice::from_ref(&target), 1)
        .unwrap();
    target
}

async fn arm(handler: &McHandler, store: &McStore) {
    let armed = call_dispatch_request(
        handler,
        json!({"method": "session.flush", "v": 1, "session_id": "ses"}),
    )
    .await;
    assert_eq!(armed, json!({"ok": true, "armed": true}));
    assert!(store.load("ses").unwrap().meta.soft_refresh_pending);
}

#[tokio::test(flavor = "current_thread")]
async fn armed_flush_without_boundary_should_refresh_and_drain() {
    flush_case(10_000, false, true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn armed_flush_with_boundary_control_refreshes_and_drains() {
    flush_case(10_000, true, true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn armed_flush_without_boundary_above_execute_refreshes_and_drains() {
    flush_case(90_000, false, true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn armed_flush_without_boundary_and_without_drops_is_consumed() {
    flush_case(10_000, false, false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn boundaryless_flush_keeps_a_signed_head_frozen_until_the_next_user() {
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let mut open_turn = messages();
    let signed_wire = |messages| {
        let mut request = wire(messages, 10_000);
        request["provider_id"] = json!("anthropic");
        request
    };
    let first = call_transform_request(&handler, signed_wire(open_turn.clone())).await;
    assert_eq!(first["action"], "HARD", "{first}");
    let mut call = assistant_tool_call("signed-call", 4);
    call.ck.content.insert(
        0,
        ck_reasoning("thinking", 4, "kept plan")
            .ck
            .content
            .remove(0),
    );
    open_turn.extend([call, tool_result("result-signed-call", 5, "tool output")]);
    let baseline = call_transform_request(&handler, signed_wire(open_turn.clone())).await;
    assert_eq!(baseline["action"], "SOFT+", "{baseline}");
    assert!(serde_json::to_string(&baseline["ck_messages"])
        .unwrap()
        .contains("signature-thinking"));
    let before = store.load("ses").unwrap();
    assert!(before.core.boundary_id.is_empty());
    assert!(before.meta.coverage_ordinal.is_none());
    queue_answer(&store);
    arm(&handler, &store).await;
    for _ in 0..2 {
        let held = call_transform_request(&handler, signed_wire(open_turn.clone())).await;
        assert_eq!(held["action"], "SOFT+", "{held}");
        assert_eq!(held["prefix_bust_permitted"], false, "{held}");
        assert_eq!(held["ck_messages"], baseline["ck_messages"]);
        let after = store.load("ses").unwrap();
        assert!(after.meta.soft_refresh_pending);
        assert_eq!(store.load_pending_agent_drops("ses").unwrap().len(), 1);
        assert_eq!(frozen(&before, "m0"), frozen(&after, "m0"));
        assert_eq!(frozen(&before, "m1"), frozen(&after, "m1"));
    }
    open_turn.push(ck("release-user", 6, "continue"));
    let released = call_transform_request(&handler, signed_wire(open_turn.clone())).await;
    assert_eq!(released["action"], "SOFT", "{released}");
    assert_eq!(
        released["materialize_reason"], "explicit_flush",
        "{released}"
    );
    assert_eq!(released["prefix_bust_permitted"], true, "{released}");
    assert!(!store.load("ses").unwrap().meta.soft_refresh_pending);
    assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());
    assert!(!serde_json::to_string(&released["ck_messages"])
        .unwrap()
        .contains(QUEUED_BODY));
    assert_eq!(
        frozen(&before, "m0"),
        frozen(&store.load("ses").unwrap(), "m0")
    );
    let replay = call_transform_request(&handler, signed_wire(open_turn)).await;
    assert_eq!(replay["action"], "SOFT+", "{replay}");
    assert_eq!(replay["ck_messages"], released["ck_messages"]);
}

#[tokio::test(flavor = "current_thread")]
async fn explicit_flush_does_not_bypass_a_lost_boundary_reconcile() {
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 1, "old-user", "seed")])
        .unwrap();
    let first = call_transform_request(&handler, wire(messages(), 10_000)).await;
    assert_eq!(first["action"], "HARD", "{first}");
    let mut loaded = store.load("ses").unwrap();
    assert!(loaded.meta.coverage_ordinal.is_some());
    // Reverting messages can remove the block that marks the end of cached history.
    // Flush must not replace the HARD rebuild that repairs that lost boundary.
    loaded.core.boundary_id = "lost-boundary#0".to_string();
    loaded.core.reconcile_pending = true;
    store
        .commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    queue_answer(&store);
    arm(&handler, &store).await;
    let repaired = call_transform_request(&handler, wire(messages(), 10_000)).await;
    assert_eq!(repaired["status"], "ok", "{repaired}");
    assert_eq!(repaired["action"], "HARD", "{repaired}");
    let after = store.load("ses").unwrap();
    assert!(!after.core.reconcile_pending);
    assert_eq!(after.core.boundary_id, "old-user#0");
}

#[tokio::test(flavor = "current_thread")]
async fn explicit_flush_coalesces_m1_delta_queued_drop_and_tool_heuristic() {
    let mut config = default_test_config();
    config.cache_ttl = "never".to_string();
    // Disable token-budget protection so the old bash result can be reclaimed
    // once it has aged beyond the newest three tool tags.
    config.protected_tokens_user = Some(0);
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), config);
    // Seed covered history so a later publication can extend m1 while m0 stays frozen.
    // The first publication without a boundary would instead rebuild m0 with HARD.
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 1, "old-user", "seed")])
        .unwrap();
    let tool_body = "old output ".repeat(200);
    let mut request_messages = vec![
        ck("old-user", 1, "covered baseline"),
        ck("publication-end", 2, "history awaiting publication"),
        ck_with_role("old-answer", 3, "assistant", QUEUED_BODY),
        ck("current-user", 4, "first real user question"),
        assistant_tool_call("old-call", 5),
        tool_result("result-old-call", 6, &tool_body),
    ];
    request_messages.push(ck("tail", 7, "continue"));
    request_messages.push(ck("next-turn", 8, "next step"));
    request_messages.push(ck("third-turn", 9, "move on"));
    let boot = call_transform_request(&handler, wire(request_messages.clone(), 10_000)).await;
    assert_eq!(boot["action"], "HARD", "{boot}");
    let aged = call_transform_request(&handler, wire(request_messages.clone(), 75_000)).await;
    assert_eq!(aged["action"], "SOFT+", "{aged}");
    assert_eq!(aged["ck_messages"], boot["ck_messages"]);
    let before = store.load("ses").unwrap();
    assert!(before.meta.last_execute_ordinal >= 5);
    let result_tag = store
        .load_tags_for_session("ses")
        .unwrap()
        .into_iter()
        .find(|tag| tag.block_id == "result-old-call#0")
        .unwrap();
    assert!(result_tag.token_count >= 250, "{result_tag:?}");
    assert!(!before
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key == "red:result-old-call#0"));
    // The newest three tool tag numbers stay protected even with a zero-token floor.
    // Seed newer persisted outputs, which may be absent from the request, to make
    // the older result eligible for cleanup.
    store
        .seed_tags_for_test(
            "ses",
            &(0..3)
                .map(|index| mc_store::TagMintInput {
                    block_id: format!("newer-history-{index}#0"),
                    kind: "tool_result".to_string(),
                    token_count: 20_000,
                    source_bytes: b"newer".to_vec(),
                })
                .collect::<Vec<_>>(),
            1,
        )
        .unwrap();
    store
        .append_compartments(
            "ses",
            &[stored_comp(
                2,
                2,
                2,
                "publication-end",
                "PUBLISHED M1 DELTA",
            )],
        )
        .unwrap();
    let target = queue_answer(&store);
    assert_eq!(store.load_pending_agent_drops("ses").unwrap().len(), 1);
    arm(&handler, &store).await;
    request_messages.push(ck("new-user", 10, "apply the queued work"));
    let flushed = call_transform_request(&handler, wire(request_messages.clone(), 75_000)).await;
    assert_eq!(flushed["status"], "ok", "{flushed}");
    assert_eq!(flushed["action"], "SOFT", "{flushed}");
    assert_eq!(flushed["materialize_reason"], "explicit_flush", "{flushed}");
    assert_eq!(flushed["prefix_bust_permitted"], true, "{flushed}");
    let after = store.load("ses").unwrap();
    assert_eq!(frozen(&before, "m0"), frozen(&after, "m0"));
    assert_ne!(before.meta.m1_revision, after.meta.m1_revision);
    assert!(frozen(&after, "m1").contains("PUBLISHED M1 DELTA"));
    assert!(frozen(&after, &format!("red:{target}")).starts_with("[dropped"));
    assert!(frozen(&after, "red:result-old-call#0").starts_with("[dropped"));
    let delivered = serde_json::to_string(&flushed["ck_messages"]).unwrap();
    assert!(!delivered.contains(QUEUED_BODY));
    assert!(!delivered.contains(&tool_body));
    assert!(!after.meta.soft_refresh_pending);
    assert!(store.load_pending_agent_drops("ses").unwrap().is_empty());
    let replay = call_transform_request(&handler, wire(request_messages, 75_000)).await;
    assert_eq!(replay["action"], "SOFT+", "{replay}");
    assert_eq!(replay["prefix_bust_permitted"], false, "{replay}");
    assert_eq!(replay["ck_messages"], flushed["ck_messages"]);
}
