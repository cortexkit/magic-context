//! Independent M3 regression cases. Expectations come from the full engine or
//! the durable host contract, not the incremental aggregate under review.
use super::host_tests::{admit, dispatch, handler, hook, key, response, sync_pass, text};
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
    let inputs = transform::Channel1PolicyInputs {
        baseline: baseline.clone(),
        users: 1,
        tool_outputs: (totals.tool_outputs + metrics.tool_outputs) as usize,
        hint: vec![],
        carrier: true,
    };
    let (ops, _) = host_channel1(&inputs, &json!({}));
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
    let inputs = transform::Channel1PolicyInputs {
        baseline,
        users: 1,
        tool_outputs: (totals.tool_outputs + metrics.tool_outputs) as usize,
        hint: vec![(1, "read".into())],
        carrier: true,
    };
    let (ops, _) = host_channel1(&inputs, &json!({}));
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
    sync_pass(&h, &[(1, message.clone())]).await;
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
    sync_pass(&h, &[(1, messages[0].clone()), (2, messages[1].clone())]).await;
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
    sync_pass(&h, &[(1, first.clone()), (2, second.clone())]).await;
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
    sync_pass(&h, &[(2, message.clone())]).await;
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
        sync_pass(&h, &[(ordinal, tool(mid, &output))]).await;
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
    sync_pass(&h, &[(3, tool("c", "next"))]).await;
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

#[tokio::test]
async fn r2_temporal_plan_must_belong_to_the_current_hook_pass() {
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
    sync_pass(&h, &[(1, first.clone())]).await;
    response(
        dispatch(
            &h,
            7,
            "transform.hook",
            hook("u1", 1, "pre_user", &["first"], first.clone()),
        )
        .await,
    );
    h.store
        .get()
        .unwrap()
        .commit_provider_status(
            &key(&h).store_key(),
            &mc_store::provider_records::ProviderLineage {
                lineage_id: "L".into(),
                first_ordinal: 1,
                descends_from: None,
                through_ordinal: None,
            },
            &[],
            Some(1),
            &[],
        )
        .unwrap();
    let mut ctx = engine_context("git:review", "/nonexistent-docs");
    ctx.temporal_awareness = true;
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &engine_request(&[first.clone()], false),
            &ctx,
        )
        .unwrap();
        transform::transform(
            h.store.get().unwrap(),
            &engine_request(&[first.clone()], false),
            &ctx,
        )
        .unwrap();
    }
    let expected = transform::transform(
        full.store.get().unwrap(),
        &engine_request(&[first, second.clone()], false),
        &ctx,
    )
    .unwrap();
    assert_eq!(expected.decision, "SOFT+", "warmed engine selects a defer");
    let expected = engine_text(&expected, "u2", 0);
    assert_eq!(expected, "§2§ second");
    // No exact plan was synchronized for u2. The prior HARD covered u1 only.
    let p = hook("u2", 2, "pre_user", &["second"], second);
    let actual = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(actual[0], expected);
}

#[tokio::test]
async fn r2_three_tool_appends_use_full_pass_protection_and_carrier() {
    let host_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let h = handler(host_dir.path());
    let full = handler(full_dir.path());
    admit(&h, 7).await;
    let base = text("u", "user", "baseline");
    let mut ctx = engine_context("git:review", "/nonexistent-docs");
    ctx.protected_tokens_floor = 16000;
    ctx.history_budget_tokens = 2_000_000.0;
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.protected_tokens_user = Some(16000);
    binding.history_budget_tokens = 2_000_000.0;
    h.bind_route(7, binding);
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &engine_request(std::slice::from_ref(&base), false),
            &ctx,
        )
        .unwrap();
        transform::transform(
            h.store.get().unwrap(),
            &engine_request(std::slice::from_ref(&base), false),
            &ctx,
        )
        .unwrap();
    }
    let output = "spent payload ".repeat(30000);
    let a = tool("a", &output);
    let b = tool("b", &output);
    let c = tool("c", &output);
    sync_pass(&h, &[(2, a.clone()), (3, b.clone()), (4, c.clone())]).await;
    let mut req = engine_request(&[base, a.clone(), b.clone(), c.clone()], false);
    req.render_config = "r2-hard".into();
    let expected = transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    assert_eq!(expected.decision, "HARD");
    let mut pa = hook("a", 2, "post_tool", &[&output], a);
    pa["subject_part"] = json!("part");
    let aa = rendered(
        &pa,
        response(dispatch(&h, 7, "transform.hook", pa.clone()).await),
    );
    let mut pb = hook("b", 3, "post_tool", &[&output], b);
    pb["subject_part"] = json!("part");
    let ab = rendered(
        &pb,
        response(dispatch(&h, 7, "transform.hook", pb.clone()).await),
    );
    assert_eq!(
        aa[0],
        engine_text(&expected, "a", 1),
        "earlier tool cannot carry the reminder"
    );
    assert_eq!(
        ab[0],
        engine_text(&expected, "b", 1),
        "middle tool cannot carry the reminder"
    );
    let mut pc = hook("c", 4, "post_tool", &[&output], c);
    pc["subject_part"] = json!("part");
    let ac = rendered(
        &pc,
        response(dispatch(&h, 7, "transform.hook", pc.clone()).await),
    );
    let suffix = |s: &str| s.find("<system-reminder>").map(|n| s[n..].to_owned());
    let expected = engine_text(&expected, "c", 1);
    assert!(
        suffix(&expected).is_some(),
        "full engine reminder positive control"
    );
    assert_eq!(
        suffix(&ac[0]),
        suffix(&expected),
        "last tool reminder must use full-pass accounting"
    );
}

#[tokio::test]
async fn r2_model_switch_reminder_uses_the_exact_pass_calibration() {
    let host_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let h = handler(host_dir.path());
    let full = handler(full_dir.path());
    admit(&h, 7).await;
    let base = text("u", "user", "baseline");
    let mut ctx = engine_context("git:review", "/nonexistent-docs");
    ctx.protected_tokens_floor = 16000;
    ctx.history_budget_tokens = 2_000_000.0;
    let mut binding = h.facade_binding(7).unwrap();
    binding.config.protected_tokens_user = Some(16000);
    binding.history_budget_tokens = 2_000_000.0;
    h.bind_route(7, binding.clone());
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &engine_request(std::slice::from_ref(&base), false),
            &ctx,
        )
        .unwrap();
        transform::transform(
            h.store.get().unwrap(),
            &engine_request(std::slice::from_ref(&base), false),
            &ctx,
        )
        .unwrap();
    }
    let output = "spent payload ".repeat(20000);
    let a = tool("a", &output);
    binding.model_key = Some("anthropic/claude-fable-5-1".into());
    h.bind_route(7, binding);
    sync_pass(&h, &[(2, a.clone())]).await;
    let mut req = engine_request(&[base, a.clone()], false);
    req.model_key = Some("anthropic/claude-fable-5-1".into());
    let expected = transform::transform(full.store.get().unwrap(), &req, &ctx).unwrap();
    assert_eq!(expected.decision, "HARD");
    assert!(expected.prefix_bust_permitted);
    let mut pa = hook("a", 2, "post_tool", &[&output], a);
    pa["subject_part"] = json!("part");
    let actual = rendered(
        &pa,
        response(dispatch(&h, 7, "transform.hook", pa.clone()).await),
    );
    let expected = engine_text(&expected, "a", 1);
    let suffix = |s: &str| s.find("<system-reminder>").map(|n| s[n..].to_owned());
    assert!(
        suffix(&expected).is_some(),
        "full engine reminder positive control"
    );
    assert_eq!(
        suffix(&actual[0]),
        suffix(&expected),
        "reminder must use the calibration adopted by this exact pass"
    );
}

#[tokio::test]
async fn r2_replayed_served_hook_does_not_resurrect_a_consumed_drop() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    admit(&h, 7).await;
    let message = text("u1", "user", "first");
    sync_pass(&h, &[(1, message.clone())]).await;
    let mut p = hook("u1", 1, "pre_user", &["first"], message);
    let first = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(first, ["§1§ first"]);
    let next = text("u2", "user", "second");
    sync_pass(&h, &[(2, next.clone())]).await;
    let mut next_hook = hook("u2", 2, "pre_user", &["second"], next);
    next_hook["served_through_ordinal"] = json!(1);
    response(dispatch(&h, 7, "transform.hook", next_hook).await);
    let key = key(&h);
    h.provider_host_reduce(key.clone(), &[1]).await.unwrap();
    let store = h.store.get().unwrap();
    let namespace = store
        .load_provider_conversation(&key.store_key())
        .unwrap()
        .unwrap()
        .engine_namespace;
    store
        .append_pending_agent_drops(&namespace, &["u1#0".into()], 1)
        .unwrap();
    let id = store.load_pending_agent_drops(&namespace).unwrap()[0].id;
    let row = store.load(&namespace).unwrap();
    store
        .commit_with_consumed_drops(
            &namespace,
            row.row_version,
            &row.core,
            &row.meta,
            &[id],
            None,
        )
        .unwrap();
    assert!(store
        .load_provider_pending_drops(&key.store_key())
        .unwrap()
        .is_empty());
    assert!(!store
        .provider_answer_tag_known(&key.store_key(), 1)
        .unwrap());
    // This is a transport replay of an acknowledged hook, not a new native message.
    p["served_through_ordinal"] = json!(1);
    let replay = rendered(
        &p,
        response(dispatch(&h, 7, "transform.hook", p.clone()).await),
    );
    assert_eq!(
        replay, first,
        "a served subject must not receive a fresh live tag after its release committed"
    );
    let requeue = store.queue_provider_drops(&key.store_key(), &[1]);
    assert!(
        requeue.is_err(),
        "transport replay re-enabled consumed tag 1: requeue={requeue:?}, pending={:?}",
        store.load_provider_pending_drops(&key.store_key()).unwrap()
    );
}
