//! Independent M3 regression cases. Expectations come from the full engine or
//! the durable host contract, not the incremental aggregate under review.
use super::host_tests::{admit, dispatch, handler, hook, key, response, text};
use super::*;
use crate::config::CacheTtlProvenance;
use hooks::{answer::HookAnswer, hook::HookCall};

fn rendered(params: &Value, answer: Value) -> Vec<String> {
    let call: HookCall = decode(params).unwrap();
    match decode::<HookAnswer>(&answer).unwrap() {
        HookAnswer::Pass => call.subject.blocks().unwrap().to_vec(),
        HookAnswer::Ops { ops } => {
            hooks::answer::apply_ops(call.subject.blocks().unwrap(), &ops).unwrap()
        }
        other => panic!("unexpected answer: {other:?}"),
    }
}

fn tool(mid: &str, output: &str) -> Value {
    json!({"info":{"id":mid,"role":"assistant"},"parts":[
        {"id":"part","type":"tool","callID":format!("call-{mid}"),"tool":"read",
         "state":{"status":"completed","input":{},"output":output}}]})
}

fn engine_request(messages: &[Value], auto_search: bool) -> TransformRequest {
    let entries = messages
        .iter()
        .enumerate()
        .map(|(n, message)| compact::status::StatusMessage {
            mid: message["info"]["id"].as_str().unwrap().into(),
            ordinal: n as u64 + 1,
            message: message.clone(),
        })
        .collect::<Vec<_>>();
    let decoded = codec_opencode::decode_messages(&entries).unwrap();
    decode(&json!({"v":2,"kind":"transform","session_id":"s",
        "serializer_profile":"opencode-aisdk","render_config":"review",
        "messages":decoded.messages,"tool_present":true,
        "auto_search_enabled":auto_search,"auto_search_min_prompt_chars":0,
        "auto_search_score_threshold":0.0}))
    .unwrap()
}

fn engine_context<'a>(project: &'a str, directory: &'a str) -> transform::ProducerContext<'a> {
    transform::ProducerContext {
        project_path: project,
        note_project_path: project,
        project_directory: directory,
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 0.0,
        user_profile_budget_tokens: 0.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: false,
        now_ms: 1,
        execute_threshold_percentage: 80.0,
        protected_tokens_floor: 100_000,
        protected_tokens_provenance: "absolute",
        compaction_enabled: true,
        smart_drops: false,
        protected_tools: Default::default(),
        cache_ttl: "never".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
        injected_reductions: vec![],
    }
}

fn engine_text(response: &transform::TransformResponse, mid: &str, index: usize) -> String {
    let message = response
        .messages()
        .iter()
        .find(|m| m.meta.harness_id.as_deref() == Some(mid))
        .unwrap();
    match &message.content[index].kind {
        mc_store::CkKind::Text { text } => text.clone(),
        mc_store::CkKind::ToolResult { output, .. } => match &output.kind {
            mc_store::CkOutputKind::Text { text } => text.clone(),
            other => panic!("not text output: {other:?}"),
        },
        other => panic!("not text block: {other:?}"),
    }
}

fn enable_hint_memory(h: &McHandler) -> String {
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.memory_enabled = true;
    binding.config.memory_budget_tokens = 0.0;
    binding.config.auto_search.min_prompt_chars = 0;
    binding.config.auto_search.score_threshold = 0.0;
    h.bind_route(7, binding.clone());
    let store = h.store.get().unwrap();
    let project = h.route_project(store, &binding).unwrap().key;
    store
        .seed_memory(
            1,
            &project,
            "CONSTRAINTS",
            "rust ownership borrowing durable context",
            70,
        )
        .unwrap();
    for (id, value) in [
        (2, "separate archive subject"),
        (3, "unrelated fixture material"),
    ] {
        store
            .seed_memory(id, &project, "CONSTRAINTS", value, 50)
            .unwrap();
    }
    project
}

#[test]
fn review_channel1_aggregate_respects_the_engine_protected_token_window() {
    let output = "spent payload ".repeat(30000);
    let req = engine_request(&[tool("a", &output)], false);
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let tags = [mc_store::McTagRow {
        tag_number: 1,
        block_id: "a#1".into(),
        kind: "tool_result".into(),
        token_count: mc_tokenizer::estimate_tokens(&output) as i64,
        created_at_ms: 1,
        source_bytes: output.as_bytes().to_vec().into(),
    }];
    // The full engine's from-scratch walk protects the whole call/result arc.
    let measured = crate::tail_hygiene::measure_tail_hygiene(
        &projection,
        &Default::default(),
        None,
        &tags,
        1,
        &Default::default(),
    );
    assert_eq!(measured.u, 0);
    assert!(measured.t >= crate::tail_hygiene::CHANNEL1_MIN_TOKENS);
    let baseline = mc_store::TailHygieneBaseline {
        baseline_t: measured.t,
        baseline_u: measured.u,
        evaluable: true,
        ..Default::default()
    };
    let expected = transform::decide_channel1(Some(&baseline), &Default::default(), 1);
    assert!(!expected.fire, "protected full-engine control");
    let totals = ProviderPolicyTotals {
        tool_tokens: measured.t,
        reclaimable_tokens: measured.t,
        tool_outputs: 1,
        real_users: 1,
        ..Default::default()
    };
    let metrics = ProviderPolicyTotals {
        tool_outputs: 1,
        ..Default::default()
    };
    let (ops, _) = host_channel1(&totals, &metrics, &json!({}));
    assert!(
        ops.is_empty(),
        "the aggregate treats the protected tool arc as reclaimable and emits a reminder"
    );
}

#[test]
fn review_channel1_reminder_keeps_the_engine_oldest_tag_hint() {
    let totals = ProviderPolicyTotals {
        text_tokens: 70_000,
        tool_tokens: 30_000,
        reclaimable_tokens: 30_000,
        tool_outputs: 3,
        real_users: 1,
    };
    let metrics = ProviderPolicyTotals {
        tool_outputs: 1,
        ..Default::default()
    };
    let baseline = mc_store::TailHygieneBaseline {
        baseline_t: 100_000,
        baseline_u: 30_000,
        evaluable: true,
        ..Default::default()
    };
    let decision = transform::decide_channel1(Some(&baseline), &Default::default(), 1);
    assert!(decision.fire);
    let expected = transform::build_channel1_reminder(
        decision.level,
        30_000,
        4,
        &[(1, "read".into())],
        decision.sticky,
    );
    let (ops, _) = host_channel1(&totals, &metrics, &json!({}));
    let actual = hooks::answer::apply_ops(&["result".into()], &ops).unwrap();
    assert_eq!(
        actual[0],
        format!("result{expected}"),
        "full engine names the oldest reclaimable tool tag"
    );
}

#[tokio::test]
async fn review_disabled_auto_search_produces_no_hint_like_full_engine() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    let project = enable_hint_memory(&h);
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.auto_search.enabled = false;
    h.bind_route(7, binding);
    let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer",
        "auto_search_enabled":false,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    response(dispatch(&h, 7, "transform.declare", json!({"params":plan})).await);
    let message = text("u", "user", "rust ownership borrowing");
    let request = engine_request(&[message.clone()], false);
    let ctx = engine_context(&project, "/nonexistent-docs");
    let store = h.store.get().unwrap();
    transform::transform(store, &request, &ctx).unwrap();
    let expected = transform::transform(store, &request, &ctx).unwrap();
    let expected = engine_text(&expected, "u", 0);
    assert!(!expected.contains("ctx-search-hint"));
    let mut p = hook("u", 1, "pre_user", &["rust ownership borrowing"], message);
    p["params"] = plan;
    let actual = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    // Compare the augmentation independently of tag allocation in the switched namespace.
    assert_eq!(
        actual[0].contains("ctx-search-hint"),
        expected.contains("ctx-search-hint"),
        "disabled auto-search must not search and append an augmentation"
    );
}

#[tokio::test]
async fn review_hint_only_targets_the_physical_user_tail_of_a_multi_append_pass() {
    let host_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let h = handler(host_dir.path());
    enable_hint_memory(&h);
    let full = handler(full_dir.path());
    let project = enable_hint_memory(&full);
    let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer",
        "auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    response(dispatch(&h, 7, "transform.declare", json!({"params":plan})).await);
    let messages = [
        text("u1", "user", "rust ownership borrowing"),
        text("u2", "user", "rust ownership borrowing"),
    ];
    let req = engine_request(&messages, true);
    let ctx = engine_context(&project, "/nonexistent-docs");
    transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    let expected = transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    assert!(
        engine_text(&expected, "u2", 0).contains("ctx-search-hint"),
        "positive tail control"
    );
    let expected = engine_text(&expected, "u1", 0);
    assert!(!expected.contains("ctx-search-hint"));
    let mut p = hook(
        "u1",
        1,
        "pre_user",
        &["rust ownership borrowing"],
        messages[0].clone(),
    );
    p["params"] = plan;
    let actual = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(
        actual[0], expected,
        "an earlier newly appended user is not the full request's physical tail"
    );
}

#[tokio::test]
async fn review_state_sync_busy_refusal_does_not_commit_half_the_sync() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    admit(&h, 7).await;
    response(
        dispatch(
            &h,
            7,
            "transform.hook",
            hook("u", 1, "pre_user", &["hi"], text("u", "user", "hi")),
        )
        .await,
    );
    let store = h.store.get().unwrap();
    let before = store.load_meta("s").unwrap();
    let held = h.provider_serial.lock_for(&key(&h)).await;
    let result = h
        .dispatch_value(
            7,
            json!({"method":"state_sync","session_id":"s",
        "shadow_generation":0,"expected_shadow_seq":0,
        "historian_model_chain":["provider/a"],"pass_complete":true}),
        )
        .await;
    assert!(
        matches!(result, HandlerOutcome::Error { ref code, .. } if code == "transient"),
        "busy control: {result:?}"
    );
    drop(held);
    let conversation = store
        .load_provider_conversation(&key(&h).store_key())
        .unwrap()
        .unwrap();
    assert_eq!(
        conversation.historian_model_chain_json, "[]",
        "chain was not committed on the refused sync"
    );
    let after = store.load_meta("s").unwrap();
    assert_eq!(
        after.row_version, before.row_version,
        "a refused busy sync must not advance durable state before the chain and barrier commit"
    );
}

#[tokio::test]
async fn review_temporal_gap_uses_previous_created_time_when_no_completion_exists() {
    let host_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let h = handler(host_dir.path());
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.temporal_awareness = true;
    h.bind_route(7, binding);
    admit(&h, 7).await;
    let full = handler(full_dir.path());
    let mut first = text("u1", "user", "first");
    first["info"]["time"] = json!({"created":1000});
    let mut second = text("u2", "user", "second");
    second["info"]["time"] = json!({"created":301000});
    let req = engine_request(&[first.clone(), second.clone()], false);
    let mut ctx = engine_context("git:review", "/nonexistent-docs");
    ctx.temporal_awareness = true;
    transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    let expected = transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    let expected = engine_text(&expected, "u2", 0);
    assert!(
        expected.contains("<!-- +5m -->"),
        "full timestamp-walk control"
    );
    response(
        dispatch(
            &h,
            7,
            "transform.hook",
            hook("u1", 1, "pre_user", &["first"], first),
        )
        .await,
    );
    let p = hook("u2", 2, "pre_user", &["second"], second);
    let actual = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(
        actual[0], expected,
        "the temporal basis advances on every message, not just completed responses"
    );
}

#[tokio::test]
async fn review_hint_excludes_fragments_already_rendered_in_the_memory_head() {
    let host_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let h = handler(host_dir.path());
    let host_project = enable_hint_memory(&h);
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.memory_budget_tokens = 8000.0;
    h.bind_route(7, binding);
    let full = handler(full_dir.path());
    let project = enable_hint_memory(&full);
    let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer",
        "auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    response(dispatch(&h, 7, "transform.declare", json!({"params":plan})).await);
    let baseline = text("base", "user", "baseline");
    let baseline_req = engine_request(&[baseline.clone()], false);
    let mut ctx = engine_context(&project, "/nonexistent-docs");
    ctx.memory_budget_tokens = 8000.0;
    let mut host_ctx = engine_context(&host_project, "/nonexistent-docs");
    host_ctx.memory_budget_tokens = 8000.0;
    for _ in 0..2 {
        transform::transform(full.store.get().unwrap(), &baseline_req, &ctx).unwrap();
        transform::transform(h.store.get().unwrap(), &baseline_req, &host_ctx).unwrap();
    }
    let message = text("u", "user", "rust ownership borrowing");
    let req = engine_request(&[baseline, message.clone()], true);
    let expected = transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    assert!(
        expected.rendered_memory_ids.as_ref().unwrap().contains(&1),
        "memory is in the prior frozen head"
    );
    assert!(
        serde_json::to_string(&expected.ck_messages)
            .unwrap()
            .contains("rust ownership borrowing durable context"),
        "rendered memory control"
    );
    let expected = engine_text(&expected, "u", 0);
    assert!(
        !expected.contains("ctx-search-hint"),
        "full engine excludes memories already present in the head"
    );
    let mut p = hook("u", 2, "pre_user", &["rust ownership borrowing"], message);
    p["params"] = plan;
    let actual = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(
        actual[0], expected,
        "the hook passes an empty rendered-memory exclusion set to the shared helper"
    );
}

#[tokio::test]
async fn review_conflict_is_side_effect_free_and_descent_burns_the_stranded_answer() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    admit(&h, 7).await;
    response(
        dispatch(
            &h,
            7,
            "transform.hook",
            hook("x", 1, "pre_user", &["lost"], text("x", "user", "lost")),
        )
        .await,
    );
    let mut conflict = hook(
        "y",
        1,
        "pre_user",
        &["replacement"],
        text("y", "user", "replacement"),
    );
    conflict["served_through_ordinal"] = json!(1);
    let result = dispatch(&h, 7, "transform.hook", conflict.clone()).await;
    assert!(
        matches!(result, HandlerOutcome::ErrorWithDetail { ref detail, .. } if detail["field"] == "subject_ordinal"),
        "{result:?}"
    );
    let store = h.store.get().unwrap();
    assert!(
        store.load_tags_for_session("s").unwrap().is_empty(),
        "a conflicting call did not promote x"
    );
    assert_eq!(
        store
            .load_provider_hook_answers(&key(&h).store_key())
            .unwrap()[0]
            .state,
        "pending"
    );
    conflict["lineage_id"] = json!("B");
    conflict["descends_from"] = json!({"lineage_id":"L","through_ordinal":0});
    conflict["served_through_ordinal"] = json!(0);
    response(dispatch(&h, 7, "transform.hook", conflict).await);
    let mut next = hook("z", 2, "pre_user", &["next"], text("z", "user", "next"));
    next["lineage_id"] = json!("B");
    next["served_through_ordinal"] = json!(1);
    response(dispatch(&h, 7, "transform.hook", next).await);
    let tags = store.load_tags_for_session("s").unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!((tags[0].tag_number, tags[0].block_id.as_str()), (2, "y#0"));
    assert!(!store
        .provider_answer_tag_known(&key(&h).store_key(), 1)
        .unwrap());
}

#[tokio::test]
async fn review_burning_an_earlier_answer_removes_its_inherited_cadence_effect() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    admit(&h, 7).await;
    let output = "spent payload ".repeat(30000);
    for (mid, ordinal) in [("a", 1), ("b", 2)] {
        let mut p = hook(mid, ordinal, "post_tool", &[&output], tool(mid, &output));
        p["subject_part"] = json!("part");
        let answer = rendered(
            &p,
            response(dispatch(&h, 7, "transform.hook", p.clone()).await),
        );
        assert_eq!(
            answer[0].contains("<system-reminder>"),
            mid == "a",
            "first answer fires; same-turn successor does not"
        );
    }
    // a timed out at the host after committing. b was served successfully. The
    // next answered call burns a; b's snapshot must not preserve a's lost fire.
    let mut p = hook("c", 3, "post_tool", &["next"], tool("c", "next"));
    p["subject_part"] = json!("part");
    p["unserved_subjects"] = json!([{"subject_mid":"a","hook":"post_tool","subject_part":"part"}]);
    let answer = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    let store = h.store.get().unwrap();
    let answers = store
        .load_provider_hook_answers(&key(&h).store_key())
        .unwrap();
    assert_eq!(
        answers
            .iter()
            .find(|a| a.answer.subject.subject_mid == "a")
            .unwrap()
            .state,
        "burned"
    );
    assert!(
        store
            .load_provider_policy_totals(&key(&h).store_key())
            .unwrap()
            .tool_tokens
            >= crate::tail_hygiene::CHANNEL1_MIN_TOKENS
    );
    assert!(answer[0].contains("<system-reminder>"), "no surviving answer carried a reminder, but the burned answer's fire still suppresses cadence");
}
