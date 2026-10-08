//! Byte oracle for the full-request engine and incremental host hook lane.
//! The frozen digest corpus was emitted by the pre-extraction full engine.
use super::*;
use crate::config::CacheTtlProvenance;
use hooks::answer::HookAnswer;

const SEEDS: [u64; 4] = [0x13a5_9910, 0x72be_041f, 0xcafe_8712, 0xd00d_4405];
const PASSES: usize = 24;
fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}
fn message(mid: &str, role: &str, parts: Value, ordinal: u64, completion: bool) -> Value {
    let created = ordinal as i64 * 301_000;
    let mut value = json!({"info":{"id":mid,"role":role,"time":{"created":created}},"parts":parts});
    if completion {
        value["info"]["time"]["completed"] = json!(created + 1_000);
    }
    value
}
fn corpus(seed: u64) -> Vec<Vec<Value>> {
    let mut random = seed;
    let mut ordinal = 1u64;
    (0..PASSES).map(|pass| {
        let count = if pass < 4 { 3 } else { (next(&mut random) % 3 + 1) as usize };
        (0..count).map(|slot| {
            ordinal += 1;
            let mid = format!("m{ordinal}");
            let choice = if pass < 4 { slot as u64 } else { next(&mut random) % 4 };
            let completed = next(&mut random) & 1 == 1;
            let parts = match choice {
                0 => json!([{"id":format!("{mid}-text"),"type":"text","text":"rust ownership borrowing"}]),
                1 => {
                    let output = if pass < 4 || next(&mut random) & 1 == 1 { "spent payload ".repeat(30_000) } else { "small output".into() };
                    json!([{"id":format!("{mid}-tool"),"type":"tool","tool":"read","callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":output}}])
                },
                2 => json!([{"id":format!("{mid}-a"),"type":"text","text":"§99§ response referencing §3§ inline"},{"id":format!("{mid}-tool"),"type":"tool","tool":"bash","callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":"small output"}},{"id":format!("{mid}-b"),"type":"text","text":"café 🦀 continuation"}]),
                _ => json!([{"id":format!("{mid}-a"),"type":"text","text":"first user block"},{"id":format!("{mid}-b"),"type":"text","text":"second user block"}]),
            };
            message(&mid, if choice == 0 || choice == 3 { "user" } else { "assistant" }, parts, ordinal, completed)
        }).collect()
    }).collect()
}
fn fixture(dir: &Path, memory_budget: f64, temporal: bool) -> (McHandler, String) {
    let h = super::host_tests::handler(dir);
    let mut binding = h.facade_binding(7).unwrap();
    binding.history_budget_tokens = 2_000_000.0;
    binding.config.memory_enabled = true;
    binding.config.memory_budget_tokens = memory_budget;
    binding.config.protected_tokens_user = Some(16_000);
    binding.config.temporal_awareness = temporal;
    binding.config.auto_search.min_prompt_chars = 0;
    binding.config.auto_search.score_threshold = 0.0;
    h.bind_route(7, binding.clone());
    let store = h.store.get().unwrap();
    let project = h.route_project(store, &binding).unwrap().key;
    for (id, text) in [
        (1, "rust ownership borrowing durable context"),
        (2, "separate archive subject"),
        (3, "unrelated fixture material"),
    ] {
        store
            .seed_memory(id, &project, "CONSTRAINTS", text, 50)
            .unwrap();
    }
    (h, project)
}
fn request(messages: &[Value], search: bool) -> TransformRequest {
    let entries = messages
        .iter()
        .enumerate()
        .map(|(n, m)| compact::status::StatusMessage {
            ordinal: n as u64 + 1,
            mid: m["info"]["id"].as_str().unwrap().into(),
            message: m.clone(),
        })
        .collect::<Vec<_>>();
    let decoded = super::super::codec_opencode::decode_messages(&entries).unwrap();
    decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"parity","messages":decoded.messages,"tool_present":true,"auto_search_enabled":search,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0,"geometry":{"usable_soft":4000000,"usable_hard":6000000,"absolute_wall":8000000,"derivation":"parity"}})).unwrap()
}
fn context<'a>(
    project: &'a str,
    memory_budget: f64,
    temporal: bool,
    now: i64,
) -> transform::ProducerContext<'a> {
    transform::ProducerContext {
        project_path: project,
        note_project_path: project,
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 2_000_000.0,
        memory_budget_tokens: memory_budget,
        user_profile_budget_tokens: 0.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: temporal,
        now_ms: now,
        execute_threshold_percentage: 80.0,
        protected_tokens_floor: 16_000,
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
fn scalars(
    response: &transform::TransformResponse,
    mids: &BTreeSet<String>,
) -> BTreeMap<String, Vec<(usize, String)>> {
    response
        .messages()
        .iter()
        .filter_map(|m| {
            let mid = m.meta.harness_id.as_ref()?;
            if !mids.contains(mid) {
                return None;
            }
            let values = m
                .content
                .iter()
                .enumerate()
                .filter_map(|(i, b)| match &b.kind {
                    mc_store::CkKind::Text { text } => Some((i, text.clone())),
                    mc_store::CkKind::ToolResult { output, .. } => match &output.kind {
                        mc_store::CkOutputKind::Text { text }
                        | mc_store::CkOutputKind::ErrorText { text } => Some((i, text.clone())),
                        _ => None,
                    },
                    _ => None,
                })
                .collect();
            Some((mid.clone(), values))
        })
        .collect()
}
fn digest(values: &BTreeMap<String, Vec<(usize, String)>>) -> String {
    sha256_hex(&serde_json::to_vec(values).unwrap())
}
fn baseline() -> Value {
    message(
        "m1",
        "user",
        json!([{"id":"base-text","type":"text","text":"baseline"}]),
        1,
        false,
    )
}
fn full_corpus(seed: u64) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let budget = if seed & 1 == 1 { 8000.0 } else { 0.0 };
    let temporal = seed & 2 != 0;
    let (h, project) = fixture(dir.path(), budget, temporal);
    let store = h.store.get().unwrap();
    let mut raw = vec![baseline()];
    for _ in 0..2 {
        transform::transform(
            store,
            &request(&raw, false),
            &context(&project, budget, temporal, 1),
        )
        .unwrap();
    }
    let mut out = Vec::new();
    for (pass, appended) in corpus(seed).into_iter().enumerate() {
        raw.extend(appended);
        let search = pass % 3 != 0;
        let req = request(&raw, search);
        let response = transform::transform(
            store,
            &req,
            &context(&project, budget, temporal, pass as i64 + 2),
        )
        .unwrap();
        let mids = raw
            .iter()
            .map(|m| m["info"]["id"].as_str().unwrap().to_owned())
            .collect();
        out.push(digest(&scalars(&response, &mids)));
    }
    out
}

#[test]
#[ignore = "explicit pre-extraction corpus generator"]
fn emit_pre_extraction_reference() {
    let path = std::env::var("MC_PROVIDER_PARITY_CAPTURE")
        .expect("set a worktree-local fixture destination");
    let values = SEEDS
        .iter()
        .map(|seed| (seed.to_string(), full_corpus(*seed)))
        .collect::<BTreeMap<_, _>>();
    std::fs::write(path, serde_json::to_vec_pretty(&values).unwrap()).unwrap();
    println!(
        "REFERENCE_CORPUS={}",
        serde_json::to_string(&values).unwrap()
    );
    println!(
        "captured {} seeds, {} passes",
        SEEDS.len(),
        SEEDS.len() * PASSES
    );
}

async fn host_message(h: &McHandler, raw: &Value, ordinal: u64, served: u64) -> Value {
    let mut result = raw.clone();
    let parts = raw["parts"].as_array().unwrap();
    let texts = parts
        .iter()
        .filter(|p| p["type"] == "text")
        .collect::<Vec<_>>();
    let mut subjects = Vec::new();
    if !texts.is_empty() {
        subjects.push((
            if raw["info"]["role"] == "user" {
                "pre_user"
            } else {
                "post_assistant"
            },
            None,
            texts
                .iter()
                .map(|p| p["text"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
        ));
    }
    for p in parts.iter().filter(|p| p["type"] == "tool") {
        subjects.push((
            "post_tool",
            Some(p),
            vec![p["state"]["output"].as_str().unwrap().to_owned()],
        ));
    }
    for (kind, tool, blocks) in subjects {
        let mut call = json!({"session":"s","harness":"opencode","params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0},"lineage_id":"L","subject_mid":raw["info"]["id"],"subject_ordinal":ordinal,"message":raw,"hook":kind,"step_id":"parity","blocks":blocks,"served_through_ordinal":served});
        if let Some(p) = tool {
            call["subject_part"] = p["id"].clone();
            call["tool"] = p["tool"].clone();
            call["tool_call_id"] = p["callID"].clone();
            call["is_error"] = json!(false);
        }
        let answer: HookAnswer = decode(&super::host_tests::response(
            super::host_tests::dispatch(h, 7, "transform.hook", call.clone()).await,
        ))
        .unwrap();
        let rendered = match answer {
            HookAnswer::Pass => blocks.clone(),
            HookAnswer::Ops { ops } => hooks::answer::apply_ops(&blocks, &ops).unwrap(),
            _ => panic!("text answer"),
        };
        if let Some(p) = tool {
            let part = result["parts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["id"] == p["id"])
                .unwrap();
            part["state"]["output"] = json!(rendered[0]);
        } else {
            let mut i = 0;
            for p in result["parts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|p| p["type"] == "text")
            {
                p["text"] = json!(rendered[i]);
                i += 1;
            }
        }
    }
    result
}

async fn drive_overlay_corpus(queued: bool, calibrated: bool) {
    let frozen: BTreeMap<String, Vec<String>> = serde_json::from_str(include_str!(
        "../../testdata/provider-overlay-reference.json"
    ))
    .unwrap();
    let mut comparisons = 0;
    for seed in SEEDS {
        let host_dir = tempfile::tempdir().unwrap();
        let full_dir = tempfile::tempdir().unwrap();
        let budget = if seed & 1 == 1 { 8000.0 } else { 0.0 };
        let temporal = seed & 2 != 0;
        let (host, host_project) = fixture(host_dir.path(), budget, temporal);
        let (full, full_project) = fixture(full_dir.path(), budget, temporal);
        let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
        super::host_tests::response(
            super::host_tests::dispatch(&host, 7, "transform.declare", json!({"params":plan}))
                .await,
        );
        let request_for = |messages: &[Value], search: bool| {
            let mut req = request(messages, search);
            if calibrated {
                req.model_key = Some("anthropic/claude-fable-5-1".into());
            }
            req
        };
        let mut raw = vec![baseline()];
        let mut served_native = raw.clone();
        for _ in 0..2 {
            transform::transform(
                full.store.get().unwrap(),
                &request_for(&raw, false),
                &context(&full_project, budget, temporal, 1),
            )
            .unwrap();
            transform::transform(
                host.store.get().unwrap(),
                &request_for(&raw, false),
                &context(&host_project, budget, temporal, 1),
            )
            .unwrap();
        }
        served_native[0]["parts"][0]["text"] = json!("§1§ baseline");
        for (pass, appended) in corpus(seed).into_iter().enumerate() {
            let prior = raw.len() as u64;
            let search = pass % 3 != 0;
            if queued && (pass == 6 || pass == 13) {
                let (number, block) = if pass == 6 { (3, "m3#1") } else { (4, "m4#0") };
                full.store
                    .get()
                    .unwrap()
                    .append_pending_agent_drops("s", &[block.into()], pass as i64 + 2)
                    .unwrap();
                let mut meta = full.store.get().unwrap().load_meta("s").unwrap();
                meta.meta.channel1_reduce_suppressed = true;
                full.store
                    .get()
                    .unwrap()
                    .commit_meta("s", meta.row_version, &meta.meta)
                    .unwrap();
                let key = super::host_tests::key(&host);
                host.store
                    .get()
                    .unwrap()
                    .queue_provider_drops(&key.store_key(), &[number])
                    .unwrap();
            }
            let mut binding = host.facade_binding(7).unwrap();
            binding.config.auto_search.enabled = search;
            host.bind_route(7, binding);
            let entries = appended
                .iter()
                .enumerate()
                .map(|(n, m)| json!({"mid":m["info"]["id"],"ordinal":prior+n as u64+1,"message":m}))
                .collect::<Vec<_>>();
            let tail = entries.last().unwrap();
            super::host_tests::response(host.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"pass_id":format!("{seed}-{pass}"),"lineage_id":"L","appended":entries,"physical_tail":{"mid":tail["mid"],"ordinal":tail["ordinal"]}}})).await);
            for (n, m) in appended.iter().enumerate() {
                served_native.push(host_message(&host, m, prior + n as u64 + 1, prior).await);
            }
            raw.extend(appended);
            let current_request = request_for(&raw, search);
            let expected = transform::transform(
                full.store.get().unwrap(),
                &current_request,
                &context(&full_project, budget, temporal, pass as i64 + 2),
            )
            .unwrap();
            let mids = raw
                .iter()
                .map(|m| m["info"]["id"].as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>();
            let expected = scalars(&expected, &mids);
            let served_entries = served_native
                .iter()
                .enumerate()
                .map(|(n, m)| compact::status::StatusMessage {
                    mid: m["info"]["id"].as_str().unwrap().into(),
                    ordinal: n as u64 + 1,
                    message: m.clone(),
                })
                .collect::<Vec<_>>();
            let decoded = super::super::codec_opencode::decode_messages(&served_entries).unwrap();
            for message in decoded.messages {
                let actual = message
                    .ck
                    .content
                    .iter()
                    .enumerate()
                    .filter_map(|(i, b)| match &b.kind {
                        mc_store::CkKind::Text { text } => Some((i, text.clone())),
                        mc_store::CkKind::ToolResult { output, .. } => match &output.kind {
                            mc_store::CkOutputKind::Text { text } => Some((i, text.clone())),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                assert!(actual==expected[&message.mid],"seed={seed:x} pass={pass} mid={} actual prefixes={:?} expected prefixes={:?} actual suffixes={:?} expected suffixes={:?}",message.mid,actual.iter().map(|(_,s)|s.chars().take(100).collect::<String>()).collect::<Vec<_>>(),expected[&message.mid].iter().map(|(_,s)|s.chars().take(100).collect::<String>()).collect::<Vec<_>>(),actual.iter().map(|(_,s)|s.chars().rev().take(180).collect::<String>()).collect::<Vec<_>>(),expected[&message.mid].iter().map(|(_,s)|s.chars().rev().take(180).collect::<String>()).collect::<Vec<_>>());
                comparisons += 1;
            }
            if !queued && !calibrated {
                assert_eq!(
                    digest(&expected),
                    frozen[&seed.to_string()][pass],
                    "full engine changed after pure extraction: seed={seed:x} pass={pass}"
                );
            }
        }
    }
    println!("overlay parity: queued={queued}, calibrated={calibrated}, {} seeds {:?}, {} passes, {comparisons} per-message byte comparisons",SEEDS.len(),SEEDS,SEEDS.len()*PASSES);
}

#[tokio::test]
async fn randomized_and_adversarial_host_overlay_bytes_equal_full_engine_and_pre_extraction_corpus()
{
    drive_overlay_corpus(false, false).await;
}

#[tokio::test]
async fn queued_tool_and_sibling_text_releases_match_full_engine_grace_and_oldest_hints() {
    drive_overlay_corpus(true, false).await;
}

// This assertion deliberately stays red until M4's late-HARD view owns the
// temporal overlay. A covering range alone cannot repair a suppressed hook.
#[test]
fn late_hard_view_covers_new_users_and_renders_full_engine_temporal_marker() {
    use transform::compaction::{Answer, Preset, State, Status};
    let late_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let (late, late_project) = fixture(late_dir.path(), 0.0, true);
    let (full, full_project) = fixture(full_dir.path(), 0.0, true);
    let first = baseline();
    let second = message(
        "m2",
        "user",
        json!([{"id":"u-text","type":"text","text":"second"}]),
        2,
        false,
    );
    let mut state = State::new("late-hard".into(), Preset::Head);
    let mut status = Status {
        lineage_id: "L".into(),
        newest_ordinal: Some(1),
        previous_usage: None,
        request_tokens: 1000,
        context_window: 6_000_000,
        prefix_rebuilding: false,
        last_applied_version: None,
        last_not_applied: None,
    };
    transform::compaction::setup(
        late.store.get().unwrap(),
        &request(&[first.clone()], false),
        &context(&late_project, 0.0, true, 1),
        &status,
        &mut state,
    )
    .unwrap();
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &request(&[first.clone()], false),
            &context(&full_project, 0.0, true, 1),
        )
        .unwrap();
    }
    let mut full_request = request(&[first.clone(), second.clone()], false);
    full_request.render_config = "forced-hard".into();
    let expected = transform::transform(
        full.store.get().unwrap(),
        &full_request,
        &context(&full_project, 0.0, true, 2),
    )
    .unwrap();
    let expected = scalars(&expected, &BTreeSet::from(["m2".to_owned()]));
    assert!(
        expected["m2"][0].1.contains("<!-- +5m -->"),
        "full HARD positive control"
    );
    status.newest_ordinal = Some(2);
    status.prefix_rebuilding = true;
    let output = transform::compaction::step(
        late.store.get().unwrap(),
        &request(&[first, second], false),
        &context(&late_project, 0.0, true, 2),
        &status,
        &mut state,
    )
    .unwrap();
    let Answer::Replacement(view) = output.answer else {
        panic!("late HARD must produce a view")
    };
    assert!(view.range.to > 2, "view covers the newest tail");
    let value = view
        .replacement
        .iter()
        .find(|m| m.meta.harness_id.as_deref() == Some("m2"))
        .unwrap();
    let mc_store::CkKind::Text { text } = &value.content[0].kind else {
        panic!("user text")
    };
    assert!(
        text.contains("<!-- +5m -->"),
        "M4 late-HARD temporal overlay is missing from its covering view"
    );
}

#[tokio::test]
async fn admitted_pass_followed_by_hook_timeout_has_no_phantom_tag_or_cadence() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0}})).await);
    let abandoned = message(
        "a",
        "assistant",
        json!([{"id":"a-part","type":"tool","tool":"read","callID":"a-call","state":{"status":"completed","input":{},"output":"spent payload ".repeat(30000)}}]),
        1,
        false,
    );
    super::host_tests::sync_pass(&h, &[(1, abandoned)]).await;
    // The host deadline prevented a hook answer; only admission reached the module.
    let next = message(
        "b",
        "assistant",
        json!([{"id":"b-part","type":"tool","tool":"read","callID":"b-call","state":{"status":"completed","input":{},"output":"next"}}]),
        2,
        false,
    );
    super::host_tests::sync_pass(&h, &[(2, next.clone())]).await;
    let served = host_message(&h, &next, 2, 1).await;
    assert!(!served["parts"][0]["state"]["output"]
        .as_str()
        .unwrap()
        .contains("system-reminder"));
    let third = message(
        "u",
        "user",
        json!([{"id":"u-text","type":"text","text":"next"}]),
        3,
        false,
    );
    super::host_tests::sync_pass(&h, &[(3, third.clone())]).await;
    host_message(&h, &third, 3, 2).await;
    let tags = h.store.get().unwrap().load_tags_for_session("s").unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag_number, 2);
    assert_eq!(tags[0].block_id, "b#1");
    assert!(!h
        .store
        .get()
        .unwrap()
        .provider_answer_tag_known(&super::host_tests::key(&h).store_key(), 1)
        .unwrap());
}

#[tokio::test]
async fn pass_ingest_is_once_and_changed_hook_ingest_refuses_by_message_name() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::admit(&h, 7).await;
    let raw = message(
        "u",
        "user",
        json!([{"id":"text","type":"text","text":"one"}]),
        1,
        false,
    );
    super::host_tests::sync_pass(&h, &[(1, raw.clone())]).await;
    let mut changed = raw.clone();
    changed["parts"][0]["text"] = json!("different");
    let call = super::host_tests::hook("u", 1, "pre_user", &["different"], changed);
    assert!(
        matches!(super::host_tests::dispatch(&h,7,"transform.hook",call).await,HandlerOutcome::ErrorWithDetail {ref detail,..} if detail["field"]=="message")
    );
    let call = super::host_tests::hook("u", 1, "pre_user", &["one"], raw);
    super::host_tests::response(super::host_tests::dispatch(&h, 7, "transform.hook", call).await);
    assert_eq!(
        h.store
            .get()
            .unwrap()
            .load_provider_messages(&super::host_tests::key(&h).store_key(), "L")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn frozen_non_neutral_calibration_matches_full_engine_policy_corpus() {
    let calibration = crate::decision_calibration::DecisionCalibration::for_model(Some(
        "anthropic/claude-fable-5-1",
    ));
    assert!(calibration.seeded && calibration.tools_ratio != 1.0 && calibration.prose_ratio != 1.0);
    drive_overlay_corpus(false, true).await;
}

#[test]
fn frozen_reductions_coverage_and_calibration_reuse_the_engine_measurement() {
    let values=(1..=4).map(|n|message(&format!("t{n}"),"assistant",json!([{"id":format!("p{n}"),"type":"tool","callID":format!("c{n}"),"tool":"read","state":{"status":"completed","input":{},"output":"spent payload ".repeat(30000)}}]),n,false)).chain(std::iter::once(message("u","user",json!([{"id":"text","type":"text","text":"authored text"}]),5,false))).collect::<Vec<_>>();
    let req = request(&values, false);
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let tags = projection
        .blocks
        .iter()
        .filter_map(|b| {
            transform::taggable_source(b).map(|(kind, source)| McTagRow {
                tag_number: b.ordinal as i64,
                block_id: b.id.clone(),
                kind: kind.as_store_kind().into(),
                token_count: mc_tokenizer::estimate_tokens(&source) as i64,
                created_at_ms: 1,
                source_bytes: Arc::from([]),
            })
        })
        .collect::<Vec<_>>();
    let frozen = crate::decision_calibration::DecisionCalibration::freeze_for_model(Some(
        "anthropic/claude-fable-5-1",
    ));
    let calibration =
        crate::decision_calibration::DecisionCalibration::from_frozen(&frozen).unwrap();
    let window = crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
        &tags,
        16000,
        calibration.tools_ratio,
    );
    let mut core = mc_core::CoreState::default();
    core.frozen_units.push(mc_core::FrozenUnit {
        key: "red:t3#1".into(),
        kind: "red".into(),
        frozen_payload: "drop".into(),
        durability_class: mc_core::DurabilityClass::Lineage,
        reset_rule: String::new(),
    });
    let measured = crate::tail_hygiene::measure_tail_hygiene_with_pending_drops(
        &projection,
        &core,
        Some(2),
        &tags,
        &window.tag_numbers,
        &Default::default(),
        &Default::default(),
    );
    let expected = crate::tail_hygiene::refresh_tail_hygiene_baseline_calibrated(
        measured.clone(),
        true,
        None,
        1,
        crate::tail_hygiene::HygieneCalibration {
            units_version: 2,
            tools_ratio: calibration.tools_ratio,
            prose_ratio: calibration.prose_ratio,
        },
    )
    .baseline;
    let parts =
        transform::capture_provider_parts(&req, &projection, &core, &measured.parts, &tags, true);
    let meta = mc_store::ModuleMeta {
        coverage_ordinal: Some(2),
        decision_calibration: Some(frozen),
        protected_tokens_effective: Some(16000),
        tail_hygiene_baseline: Some(expected.clone()),
        ..Default::default()
    };
    let actual = transform::channel1_inputs_from_parts(
        &parts,
        &transform::provider_engine_settings(&meta),
        16000,
        &Default::default(),
        true,
    );
    assert_eq!(
        crate::tail_hygiene::effective_tail_hygiene(&actual.baseline),
        crate::tail_hygiene::effective_tail_hygiene(&expected)
    );
    assert_eq!(
        actual.tool_outputs,
        transform::reclaimable_tool_output_count(Some(&expected))
    );
    assert_eq!(
        actual.baseline.effective_token_buckets,
        expected.effective_token_buckets
    );
}

async fn alf_shaped_policy_fixture() -> (tempfile::TempDir, McHandler) {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0}})).await);
    let sample = message(
        "sample",
        "assistant",
        json!([{"id":"a","type":"text","text":"cached assistant text"},{"id":"r","type":"tool","tool":"read","callID":"r","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"b","type":"tool","tool":"bash","callID":"b","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"c","type":"tool","tool":"read","callID":"c","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"z","type":"text","text":"cached final text"}]),
        1,
        true,
    );
    let req = request(&[sample.clone()], false);
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let template = super::admission_policy_parts(&req, &projection);
    assert_eq!(template.len(), 9);
    let mut messages = Vec::new();
    let mut parts = Vec::new();
    for n in 1..=5560u64 {
        let mid = format!("cached-{n}");
        let mut native = sample.clone();
        native["info"]["id"] = json!(mid);
        messages.push(ProviderMessage {
            mid: mid.clone(),
            ordinal: n,
            message_bytes: serde_json::to_vec(&native).unwrap(),
        });
        for p in &template {
            let mut p = p.clone();
            p.mid = mid.clone();
            p.ordinal = n;
            p.block_id = p.block_id.replace("sample#", &format!("{mid}#"));
            p.measurement.key = p.measurement.key.replace("sample#", &format!("{mid}#"));
            p.arc_id = p.arc_id.map(|a| a.replace("sample#", &format!("{mid}#")));
            p.served = true;
            parts.push(p);
        }
    }
    let lineage = ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    };
    h.store
        .get()
        .unwrap()
        .admit_provider_pass(
            &super::host_tests::key(&h).store_key(),
            &lineage,
            &messages,
            &parts,
            &json!({"pass_id":"bootstrap","lineage_id":"L","appended_ids":[]}),
        )
        .unwrap();
    (dir, h)
}

#[tokio::test]
#[ignore = "manual correctness-stage walk measurement; performance/enablement gate remains closed"]
async fn measure_alf_sized_full_metadata_walk_per_hook_and_three_hook_pass() {
    let (_dir, h) = alf_shaped_policy_fixture().await;
    let mut samples = Vec::new();
    let mut passes = Vec::new();
    for pass in 0..2u64 {
        let raw = (0..3)
            .map(|slot| {
                let ordinal = 5561 + pass * 3 + slot;
                message(
                    &format!("measure-{ordinal}"),
                    "user",
                    json!([{"id":"text","type":"text","text":"new user"}]),
                    ordinal,
                    false,
                )
            })
            .collect::<Vec<_>>();
        super::host_tests::sync_pass(
            &h,
            &raw.iter()
                .enumerate()
                .map(|(i, m)| (5561 + pass * 3 + i as u64, m.clone()))
                .collect::<Vec<_>>(),
        )
        .await;
        let start = Instant::now();
        for (i, m) in raw.iter().enumerate() {
            let hook = Instant::now();
            host_message(&h, m, 5561 + pass * 3 + i as u64, 5560 + pass * 3).await;
            samples.push(hook.elapsed().as_secs_f64() * 1000.0);
        }
        passes.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!("ALF policy walk: parts=50040 hooks=6 per_hook_ms={samples:?} three_hook_pass_ms={passes:?}");
    assert_eq!(samples.len(), 6);
}

#[tokio::test]
#[ignore = "M3 stage-two bounded policy summaries required before A2/P1/P3 and host enablement"]
async fn bounded_policy_summary_does_not_return_the_entire_known_metadata_lineage() {
    let (_dir, h) = alf_shaped_policy_fixture().await;
    let store = h.store.get().unwrap();
    let key = super::host_tests::key(&h);
    let lineage = store
        .load_provider_lineage(&key.store_key(), "L")
        .unwrap()
        .unwrap();
    store
        .commit_provider_hook(
            &key.store_key(),
            ProviderHookRequest {
                lineage: &lineage,
                message: None,
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                assert!(
                    ctx.parts.len() <= 2048,
                    "bounded-summary gate: returned {} retained metadata parts",
                    ctx.parts.len()
                );
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

#[tokio::test]
async fn no_exact_plan_is_defer_even_if_a_preflight_candidate_claims_hard() {
    let hdir=tempfile::tempdir().unwrap();let fdir=tempfile::tempdir().unwrap();let (h,hproject)=fixture(hdir.path(),0.0,true);let (full,fproject)=fixture(fdir.path(),0.0,true);
    let plan=json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":plan})).await);
    for _ in 0..2 {transform::transform(h.store.get().unwrap(),&request(&[baseline()],false),&context(&hproject,0.0,true,1)).unwrap();transform::transform(full.store.get().unwrap(),&request(&[baseline()],false),&context(&fproject,0.0,true,1)).unwrap();}
    let raw=message("m2","user",json!([{"id":"text","type":"text","text":"second"}]),2,false);
    super::host_tests::response(h.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"pass_id":"no-plan","lineage_id":"L","appended":[{"mid":"m2","ordinal":2,"message":raw}],"physical_tail":{"mid":"m2","ordinal":2},"prefix_mutation_permitted":true,"preflight_candidate":"hard","skip_facts":{"hard":true}}})).await);
    let actual=host_message(&h,&raw,2,1).await;
    let expected=transform::transform(full.store.get().unwrap(),&request(&[baseline(),raw],false),&context(&fproject,0.0,true,2)).unwrap();
    let expected=scalars(&expected,&BTreeSet::from(["m2".into()]));
    assert!(!expected["m2"][0].1.contains("<!--"));
    assert_eq!(actual["parts"][0]["text"].as_str().unwrap(),expected["m2"][0].1);
}
