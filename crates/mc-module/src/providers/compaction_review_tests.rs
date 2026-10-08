//! Independent M4 review: expectations come from the served-byte and acknowledgement
//! contracts, not from the fast-path predicate or the compaction wrapper itself.
use super::*;
use mc_store::provider_records::{
    ProviderAnswerTag, ProviderHookAnswer, ProviderHookRequest, ProviderHookWrite,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct NoRunnerReads(AtomicUsize);

#[async_trait]
impl session_resolver::ProviderRunner for NoRunnerReads {
    async fn call(
        &self,
        _: &Path,
        _: &str,
        _: &str,
        _: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("the admitted host lane must not call a runner");
    }
}

fn fixture(
    dir: &Path,
) -> (
    McHandler,
    SessionBinding,
    Arc<McStore>,
    Key,
    Arc<NoRunnerReads>,
) {
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("review-store.db").to_string_lossy().into_owned(),
        },
    };
    let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
    let runner = Arc::new(NoRunnerReads::default());
    let mut handler = McHandler::new();
    handler.store.set(store.clone()).ok().unwrap();
    handler.provider_runner = runner.clone();
    let binding = SessionBinding {
        project_root: dir.into(),
        harness: "opencode".into(),
        session: "s".into(),
        model_key: None,
        history_budget_tokens: 4000.0,
        config: McModuleConfig {
            inject_docs: false,
            memory_enabled: false,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            cache_ttl: "10m".into(),
            ..Default::default()
        },
    };
    let key = Key::new(&binding, "s", "opencode").unwrap();
    (handler, binding, store, key, runner)
}

fn setup_request() -> Value {
    json!({"session":"s","harness":"opencode","request_id":"setup","preset":"head",
        "params":{"serializer_profile":"opencode-aisdk","observation":"answer"},"composition":{},
        "model":"fixture","context_window":100000,"now":1,"lineage_id":"L"})
}

fn message(ordinal: u64) -> Value {
    json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{
        "info":{"id":format!("m{ordinal}"),"role":"user","time":{"created":1}},
        "parts":[{"id":format!("p{ordinal}"),"type":"text","text":format!("raw {ordinal}")}]}})
}

fn step(id: &str, entries: Vec<Value>, newest: u64) -> Value {
    json!({"session":"s","harness":"opencode","request_id":id,"lineage_id":"L","step_id":"st",
        "step_kind":"user_turn","model":"fixture","context_window":100000,
        "estimate":{"request_tokens":1000},"messages":entries,
        "newest":{"ordinal":newest,"mid":format!("m{newest}")},"now":2})
}

fn response(result: Result<Vec<u8>, HandlerOutcome>) -> Value {
    serde_json::from_slice(&result.expect("provider request must complete")).unwrap()
}

fn root() -> ProviderLineage {
    ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    }
}

fn pending_hook(store: &McStore, key: &Key, ordinal: u64) {
    let native = message(ordinal);
    let entry = ProviderMessage {
        ordinal,
        mid: format!("m{ordinal}"),
        message_bytes: serde_json::to_vec(&native["message"]).unwrap(),
    };
    store
        .commit_provider_hook(
            &key.store_key(),
            ProviderHookRequest {
                lineage: &root(),
                message: Some(&entry),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: ProviderSubject {
                                subject_mid: entry.mid.clone(),
                                hook: "pre_user".into(),
                                subject_part: "".into(),
                            },
                            ordinal,
                            ops_json: "[]".into(),
                            tags: vec![ProviderAnswerTag {
                                number: ctx.tag_high_water + 1,
                                block_id: format!("{}#0", entry.mid),
                                kind: "message".into(),
                                source: format!("raw {ordinal}"),
                                token_count: 2,
                                created_at_ms: 1,
                            }],
                        }),
                        counters: ctx.counters.clone(),
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

fn publication(store: &McStore, sequence: i64, ordinal: u64, content: &str) {
    let mut compartments = store.load_compartments("s").unwrap();
    compartments.push(mc_store::StoredCompartment {
        sequence,
        start_message: ordinal as i64,
        end_message: ordinal as i64,
        end_message_id: format!("m{ordinal}#0"),
        title: "history".into(),
        content: content.into(),
        p1: Some(content.into()),
        importance: 50,
        ..Default::default()
    });
    store.replace_compartments("s", &compartments).unwrap();
}

fn engine_request(tokens: u64) -> TransformRequest {
    let entries = [message(1), message(2), message(3)]
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect::<Vec<compact::status::StatusMessage>>();
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"transform",
        "session_id":"s","serializer_profile":"opencode-aisdk","messages":[],
        "model_key":"fixture","render_config":"full-request-fixture","tool_present":false,
        "auto_search_enabled":false,"usage":{"current_total_input_tokens":tokens,"context_limit_tokens":100000}})).unwrap();
    Codec::OpencodeAiSdk
        .prepare_request(&mut request, &entries)
        .unwrap();
    request
}

fn full_engine(store: &McStore, work: &Work, tokens: u64) -> transform::TransformWithProjection {
    let mut ctx = producer_context(work, "fixture", 100000, false);
    // A recent real response prevents the configured TTL from being a competing
    // cause. No idle override is used in this full-request oracle.
    ctx.observed_last_response_at_ms = Some(ctx.now_ms);
    transform::transform_with_projection(store, &engine_request(tokens), &ctx).unwrap()
}

#[tokio::test]
async fn final_history_gap_refuses_before_promote_and_burn() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, runner) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    pending_hook(&s, &k, 1);
    pending_hook(&s, &k, 3);
    let before = s.load_provider_hook_answers(&k.store_key()).unwrap();
    let mut gap = step("gap", vec![], 3);
    gap["served_through_ordinal"] = json!(3);
    gap["unserved_subjects"] = json!([{"subject_mid":"m1","hook":"pre_user"}]);
    let answer = response(h.provider_step(b, &gap).await);
    assert_eq!(answer["code"], "history_unreadable");
    assert_eq!(answer["detail"]["history_gap_from"], 2);
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    let after = s.load_provider_hook_answers(&k.store_key()).unwrap();
    assert_eq!(
        after.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
        before.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
        "a refused gap must leave both answers pending; tags={:?}, watermark={:?}",
        s.load_tags_for_session("s").unwrap(),
        s.load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap()
            .served_through_ordinal
    );
}

#[tokio::test]
async fn first_historian_publication_matches_the_real_full_request_engine() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    let work = h.provider_work(&s, b.clone(), k).unwrap();
    assert_eq!(full_engine(&s, &work, 1000).response.action, "HARD");
    assert_eq!(full_engine(&s, &work, 1000).response.action, "SOFT+");
    response(h.provider_setup(b.clone(), &setup_request()).await);
    // Complete bootstrap, then acknowledge its view before the publication.
    let mut boot = step("boot", vec![message(1), message(2), message(3)], 3);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let view = response(h.provider_step(b.clone(), &boot).await);
    let mut settled = step("settled", vec![], 3);
    settled["last_applied"] = view["compaction"].clone();
    assert_eq!(
        response(h.provider_step(b.clone(), &settled).await)["answer"],
        "noop"
    );
    publication(&s, 0, 1, "FIRST-PUBLISHED-HISTORY");
    // Observe the real legacy engine in a separate temporary namespace with the
    // same empty-bootstrap/publication sequence, not execute_host/compaction.run.
    let oracle_dir = tempfile::tempdir().unwrap();
    let (oracle_h, oracle_b, oracle_s, oracle_k, _) = fixture(oracle_dir.path());
    let oracle_work = oracle_h
        .provider_work(&oracle_s, oracle_b, oracle_k)
        .unwrap();
    full_engine(&oracle_s, &oracle_work, 1000);
    publication(&oracle_s, 0, 1, "FIRST-PUBLISHED-HISTORY");
    let expected = full_engine(&oracle_s, &oracle_work, 1000);
    assert_eq!(expected.response.action, "HARD");
    assert!(expected.response.prefix_bust_permitted);
    let actual = response(h.provider_step(b, &step("after-publish", vec![], 3)).await);
    assert_eq!(
        actual["answer"], "compaction_message",
        "full-request engine HARD-folded its first publication, but host returned {actual}"
    );
}

#[tokio::test]
async fn soft_plus_pipeline_switch_preserves_the_full_request_head_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    let work = h.provider_work(&s, b.clone(), k).unwrap();
    publication(&s, 0, 1, "BASELINE-HISTORY");
    assert_eq!(full_engine(&s, &work, 1000).response.action, "HARD");
    publication(&s, 1, 2, "DELTA-HISTORY");
    let refresh = full_engine(&s, &work, 75000);
    assert_eq!(
        refresh.response.action, "SOFT",
        "fixture must have a live m1 delta before switching"
    );
    let old = full_engine(&s, &work, 1000);
    assert_eq!(
        old.response.action, "SOFT+",
        "reason={:?}",
        old.response.materialize_reason
    );
    let expected = Codec::OpencodeAiSdk
        .encode_view(
            &transform::compaction::View {
                compaction_id: "oracle".into(),
                version: 1,
                range: transform::compaction::Range {
                    lineage_id: "L".into(),
                    from: 1,
                    to: 4,
                },
                replacement: old
                    .response
                    .ck_messages
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|m| (**m).clone())
                    .collect(),
            },
            &engine_request(1000),
            &super::super::codec_opencode::NativeRenderContext::from(&old),
        )
        .unwrap();
    response(h.provider_setup(b.clone(), &setup_request()).await);
    let mut switch = step("switch", vec![message(1), message(2), message(3)], 3);
    switch["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let actual = response(h.provider_step(b, &switch).await);
    assert_eq!(actual["answer"], "compaction_message");
    assert_eq!(
        actual["compaction"]["replacement"],
        serde_json::to_value(expected.replacement).unwrap(),
        "SOFT+ bootstrap must preserve the served baseline, not refold DELTA-HISTORY into m0"
    );
}

#[tokio::test]
async fn structural_rejected_view_cannot_be_acknowledged_on_a_later_pass() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    let mut boot = step("boot", vec![message(1)], 1);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let view = response(h.provider_step(b.clone(), &boot).await);
    let version = view["compaction"]["version"].as_u64().unwrap();
    let mut rejected = step("rejected", vec![], 1);
    rejected["last_not_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":version,"reason":"structural"});
    response(h.provider_step(b.clone(), &rejected).await);
    let row = s
        .load_provider_views(&k.store_key())
        .unwrap()
        .into_iter()
        .find(|r| r.version == version)
        .unwrap();
    let mut late_ack = step("late-ack", vec![], 1);
    late_ack["last_applied"] =
        json!({"compaction_id":view["compaction"]["compaction_id"],"version":version});
    let _result = h.provider_step(b, &late_ack).await;
    let later = s
        .load_provider_views(&k.store_key())
        .unwrap()
        .into_iter()
        .find(|r| r.version == version)
        .unwrap();
    assert_eq!([row.state.as_str(), later.state.as_str()], ["not_applied", "not_applied"],
        "a structural rejection must reach the terminal-state guard, and a later stale acknowledgement must not resurrect it");
}

#[tokio::test]
async fn acknowledgement_with_a_foreign_compaction_id_cannot_apply_a_view() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    let mut boot = step("boot", vec![message(1)], 1);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let view = response(h.provider_step(b.clone(), &boot).await);
    let version = view["compaction"]["version"].as_u64().unwrap();
    let mut ack = step("foreign-ack", vec![], 1);
    ack["last_applied"] = json!({"compaction_id":"foreign-conversation","version":version});
    let _result = h.provider_step(b, &ack).await;
    let row = s
        .load_provider_views(&k.store_key())
        .unwrap()
        .into_iter()
        .find(|r| r.version == version)
        .unwrap();
    assert_eq!(
        row.state, "produced",
        "the id/version acknowledgement pair must identify the held compaction"
    );
}

#[tokio::test]
async fn missing_cached_m1_repair_cannot_be_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    publication(&s, 0, 1, "BASELINE");
    pending_hook(&s, &k, 2);
    let mut boot = step("boot", vec![message(1), message(3)], 3);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    boot["served_through_ordinal"] = json!(3);
    let view = response(h.provider_step(b.clone(), &boot).await);
    let mut settled = step("settled", vec![], 3);
    settled["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
    response(h.provider_step(b.clone(), &settled).await);
    // The full engine explicitly supports repairing this legacy cached-head
    // shape. It is not an uninitialized namespace or forced-work meta flag.
    let mut legacy = s.load("s").unwrap();
    assert!(legacy.core.frozen_units.iter().any(|u| u.key == "m1"));
    legacy.core.frozen_units.retain(|u| u.key != "m1");
    s.commit("s", legacy.row_version, &legacy.core, &legacy.meta)
        .unwrap();
    s.queue_provider_drops(&k.store_key(), &[1]).unwrap();
    let params = step("repair", vec![], 3);
    let actual = response(h.provider_step(b.clone(), &params).await);
    let c = s
        .load_provider_conversation(&k.store_key())
        .unwrap()
        .unwrap();
    let mut setup: HostSetup = serde_json::from_str(c.setup_json.as_ref().unwrap()).unwrap();
    let normalized = status(
        &params,
        &Record {
            setup: Some(setup.setup.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let work = h.provider_work(&s, b, k.clone()).unwrap();
    let lineage = s
        .load_provider_lineage(&k.store_key(), "L")
        .unwrap()
        .unwrap();
    // Bypass only the predicate, preserving all host engine inputs. A predicate
    // table made from can_skip_engine's own booleans cannot catch this omission.
    let repaired = execute_host(&s, &work, &c, &mut setup, &normalized, &lineage).unwrap();
    assert!(
        repaired.is_some(),
        "the real engine must produce its missing-m1 repair"
    );
    assert_eq!(
        actual["answer"], "compaction_message",
        "host fast path hid a real cached_m1_missing HARD repair"
    );
}

#[tokio::test]
async fn pressure_flush_model_and_cold_match_the_real_engine_with_queued_drops_and_historian_veto()
{
    // This compares handler answers to engine execution on separately prepared
    // stores. Neither the expected answer nor the skip inputs are synthesized
    // from can_skip_engine, so it can detect an unsafe skip or an unsafe permit.
    for tokens in [74_999, 75_000, 84_999, 85_000] {
        for event in ["none", "flush", "model", "cold"] {
            for active in [false, true] {
                let actual_dir = tempfile::tempdir().unwrap();
                let oracle_dir = tempfile::tempdir().unwrap();
                let (h, mut b, s, k, _) = fixture(actual_dir.path());
                let (oh, mut ob, os, ok, _) = fixture(oracle_dir.path());
                b.config.execute_threshold_percentage = 75.0;
                ob.config.execute_threshold_percentage = 75.0;
                for (handler, binding, store, key) in [(&h, &b, &s, &k), (&oh, &ob, &os, &ok)] {
                    response(
                        handler
                            .provider_setup(binding.clone(), &setup_request())
                            .await,
                    );
                    publication(store, 0, 1, "BASELINE");
                    pending_hook(store, key, 2);
                    let mut boot = step("boot", vec![message(1), message(3)], 3);
                    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
                    boot["served_through_ordinal"] = json!(3);
                    let view = response(handler.provider_step(binding.clone(), &boot).await);
                    let mut settled = step("settled", vec![], 3);
                    settled["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
                    response(handler.provider_step(binding.clone(), &settled).await);
                    publication(store, 1, 2, "PUBLISHED-DELTA");
                    store.queue_provider_drops(&key.store_key(), &[1]).unwrap();
                    if event == "flush" {
                        store.arm_soft_refresh("s").unwrap();
                    }
                    if active {
                        let mut loaded = store.load("s").unwrap();
                        loaded.meta.historian.state = mc_store::HistorianPhase::AwaitingProducer;
                        store
                            .commit("s", loaded.row_version, &loaded.core, &loaded.meta)
                            .unwrap();
                    }
                }
                let mut params = step("evaluate", vec![], 3);
                params["estimate"]["request_tokens"] = json!(tokens);
                if event == "cold" {
                    params["prefix_rebuilding"] = json!({"reason":"cold"});
                }
                if event == "model" {
                    params["model"] = json!("new-model");
                }
                let actual = response(h.provider_step(b, &params).await);
                let c = os
                    .load_provider_conversation(&ok.store_key())
                    .unwrap()
                    .unwrap();
                let mut setup: HostSetup =
                    serde_json::from_str(c.setup_json.as_ref().unwrap()).unwrap();
                let normalized = status(
                    &params,
                    &Record {
                        setup: Some(setup.setup.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
                setup.setup.request.model = params["model"].as_str().unwrap().into();
                let work = oh.provider_work(&os, ob, ok.clone()).unwrap();
                let lineage = os
                    .load_provider_lineage(&ok.store_key(), "L")
                    .unwrap()
                    .unwrap();
                let expected =
                    execute_host(&os, &work, &c, &mut setup, &normalized, &lineage).unwrap();
                assert_eq!(
                    actual["answer"],
                    if expected.is_some() {
                        "compaction_message"
                    } else {
                        "noop"
                    },
                    "tokens={tokens}, event={event}, historian_active={active}"
                );
                if let Some(expected) = expected {
                    assert_eq!(
                        actual["compaction"]["replacement"],
                        serde_json::to_value(expected.wire.replacement).unwrap(),
                        "tokens={tokens}, event={event}, historian_active={active}"
                    );
                }
                assert_eq!(
                    s.load_provider_pending_drops(&k.store_key()).unwrap(),
                    os.load_provider_pending_drops(&ok.store_key()).unwrap()
                );
            }
        }
    }
}

#[tokio::test]
async fn module_ahead_descent_after_restart_burns_stranded_tags_without_rewriting_the_view() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    let mut boot = step("boot", vec![message(1)], 1);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let view = response(h.provider_step(b.clone(), &boot).await);
    let version = view["compaction"]["version"].as_u64().unwrap();
    let frozen = s
        .load_provider_views(&k.store_key())
        .unwrap()
        .into_iter()
        .find(|v| v.version == version)
        .unwrap()
        .replacement_json;
    pending_hook(&s, &k, 2);
    s.queue_provider_drops(&k.store_key(), &[1]).unwrap();
    // The host died before durably appending m2. A retry admits a different id
    // at that ordinal; refusal must not burn or promote the stranded answer.
    drop(h);
    drop(s);
    let (h, b, s, k, runner) = fixture(dir.path());
    let mut replacement = message(2);
    replacement["mid"] = json!("z");
    replacement["message"]["info"]["id"] = json!("z");
    let mut conflict = step("conflict", vec![replacement.clone()], 2);
    conflict["served_through_ordinal"] = json!(1);
    conflict["unserved_subjects"] = json!([{"subject_mid":"m2","hook":"pre_user"}]);
    assert!(matches!(h.provider_step(b.clone(), &conflict).await,
        Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) if code == "invalid_params" && detail["field"] == "messages"));
    assert_eq!(
        s.load_provider_hook_answers(&k.store_key()).unwrap()[0].state,
        "pending"
    );
    assert_eq!(s.load_provider_pending_drops(&k.store_key()).unwrap(), [1]);
    let mut descent = step("descent", vec![replacement], 2);
    descent["lineage_id"] = json!("child");
    descent["descends_from"] = json!({"lineage_id":"L","through_ordinal":1});
    descent["served_through_ordinal"] = json!(2);
    descent["last_applied"] =
        json!({"compaction_id":view["compaction"]["compaction_id"],"version":version});
    assert_eq!(
        response(h.provider_step(b.clone(), &descent).await)["answer"],
        "noop"
    );
    assert_eq!(
        s.load_provider_hook_answers(&k.store_key()).unwrap()[0].state,
        "burned"
    );
    assert!(s
        .load_provider_pending_drops(&k.store_key())
        .unwrap()
        .is_empty());
    assert!(s.load_tags_for_session("s").unwrap().is_empty());
    let held = s
        .load_provider_views(&k.store_key())
        .unwrap()
        .into_iter()
        .find(|v| v.version == version)
        .unwrap();
    assert_eq!(held.replacement_json, frozen);
    publication(&s, 0, 1, "AFTER-DESCENT-HISTORY");
    let mut cold = step("cold-child", vec![], 2);
    cold["lineage_id"] = json!("child");
    cold["served_through_ordinal"] = json!(2);
    cold["prefix_rebuilding"] = json!({"reason":"cold"});
    let rebuilt = response(h.provider_step(b, &cold).await);
    assert_eq!(rebuilt["answer"], "compaction_message");
    let raw = rebuilt["compaction"]["replacement"].as_array().unwrap();
    assert!(raw
        .iter()
        .any(|v| v.pointer("/info/id") == Some(&json!("z"))));
    assert!(!raw
        .iter()
        .any(|v| v.pointer("/info/id") == Some(&json!("m2"))));
    assert!(!rebuilt.to_string().contains("§1§"));
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn r3_nonfinal_bootstrap_with_hook_complete_history_waits_without_engine() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    for ordinal in 1..=3 {
        pending_hook(&s, &k, ordinal);
    }
    let before = s.load_meta("s").unwrap().row_version;
    let mut page = step("more-but-covered", vec![], 3);
    page["more"] = json!(true);
    page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let actual = response(h.provider_step(b, &page).await);
    assert_eq!(
        actual["answer"], "wait",
        "non-final bootstrap may not render a view: {actual}"
    );
    assert_eq!(s.load_meta("s").unwrap().row_version, before);
    assert!(s
        .load_provider_hook_answers(&k.store_key())
        .unwrap()
        .iter()
        .all(|a| a.state == "pending"));
}

#[tokio::test]
async fn r3_upgrade_identity_change_is_not_transport_adoption() {
    for host in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k, _) = fixture(dir.path());
        let w = h.provider_work(&s, b, k).unwrap();
        publication(&s, 0, 1, "BASE");
        let mut req = engine_request(1000);
        req.upgrade_state = "old-release".into();
        let mut ctx = producer_context(&w, "fixture", 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        transform::transform_with_projection(&s, &req, &ctx).unwrap();
        publication(&s, 1, 2, "DELTA");
        req.usage.as_mut().unwrap().current_total_input_tokens = 75000;
        assert_eq!(
            transform::transform_with_projection(&s, &req, &ctx)
                .unwrap()
                .response
                .action,
            "SOFT"
        );
        req.usage.as_mut().unwrap().current_total_input_tokens = 1000;
        req.upgrade_state = "new-release".into();
        if host {
            req.kind = "compaction.host".into();
        }
        let actual = transform::transform_with_projection(&s, &req, &ctx).unwrap();
        assert_eq!(
            actual.response.action, "HARD",
            "host={host}, upgrade is independent of pipeline adoption"
        );
        assert!(actual.response.prefix_bust_permitted);
    }
}

#[test]
fn r3_recomp_reset_summary_agrees_with_full_core() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    let w = h.provider_work(&s, b, k).unwrap();
    full_engine(&s, &w, 1000);
    let before = s.load("s").unwrap();
    assert!(!s
        .load_compaction_trigger_core("s")
        .unwrap()
        .unwrap()
        .frozen_units
        .is_empty());
    s.reset_session_for_recomp("s", before.row_version).unwrap();
    let summary = s.load_compaction_trigger_core("s").unwrap().unwrap();
    let actual = s.load("s").unwrap();
    assert!(actual.core.frozen_units.is_empty());
    assert!(!actual.meta.initialized);
    assert!(summary.boundary_id.is_empty());
    assert_eq!(
        summary
            .frozen_units
            .iter()
            .map(|u| &u.key)
            .collect::<Vec<_>>(),
        actual
            .core
            .frozen_units
            .iter()
            .map(|u| &u.key)
            .collect::<Vec<_>>(),
        "reset summary retains retired head keys"
    );
}

fn r3_native(
    output: &transform::TransformWithProjection,
    req: &TransformRequest,
    newest: u64,
) -> Value {
    let view = transform::compaction::View {
        compaction_id: "oracle".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 1,
            to: newest + 1,
        },
        replacement: output
            .response
            .ck_messages
            .as_ref()
            .unwrap()
            .iter()
            .map(|m| (**m).clone())
            .collect(),
    };
    json!(
        Codec::OpencodeAiSdk
            .encode_view(
                &view,
                req,
                &super::super::codec_opencode::NativeRenderContext::from(output)
            )
            .unwrap()
            .replacement
    )
}

async fn r3_old_render_epoch_comparison(pipeline_switch: bool) {
    let ad = tempfile::tempdir().unwrap();
    let od = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(ad.path());
    let (oh, ob, os, ok, _) = fixture(od.path());
    let w = h.provider_work(&s, b.clone(), k.clone()).unwrap();
    let ow = oh.provider_work(&os, ob, ok).unwrap();
    let mut old = Value::Null;
    for (ss, ww) in [(&s, &w), (&os, &ow)] {
        publication(ss, 0, 1, "BASE");
        full_engine(ss, ww, 1000);
        publication(ss, 1, 2, "DELTA");
        assert_eq!(full_engine(ss, ww, 75000).response.action, "SOFT");
        old = r3_native(&full_engine(ss, ww, 1000), &engine_request(1000), 3);
    }
    response(h.provider_setup(b.clone(), &setup_request()).await);
    let mut boot = step("boot", vec![message(1), message(2), message(3)], 3);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let v = response(h.provider_step(b.clone(), &boot).await);
    assert_eq!(v["compaction"]["replacement"], old);
    let mut settled = step("settled", vec![], 3);
    settled["last_applied"] = v["compaction"].clone();
    assert_eq!(
        response(h.provider_step(b.clone(), &settled).await)["answer"],
        "noop"
    );
    for ss in [&s, &os] {
        let mut state = ss.load_meta("s").unwrap();
        let current = format!("mre:4:mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH);
        assert!(state.meta.last_render_config.contains(&current));
        state.meta.last_render_config = state
            .meta
            .last_render_config
            .replace(&current, "mre:4:mre2");
        ss.commit_meta("s", state.row_version, &state.meta).unwrap();
    }
    let full = full_engine(&os, &ow, 1000);
    assert_eq!(full.response.action, "HARD");
    assert!(full.response.prefix_bust_permitted);
    let expected = r3_native(&full, &engine_request(1000), 3);
    assert_ne!(
        expected, old,
        "pending m1 delta must make the upgrade rebuild observable"
    );
    let mut pass = step("after-upgrade", vec![], 3);
    if pipeline_switch {
        pass["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    }
    let actual = response(h.provider_step(b, &pass).await);
    let served = if actual["answer"] == "compaction_message" {
        actual["compaction"]["replacement"].clone()
    } else {
        old
    };
    assert_eq!(served, expected, "pipeline_switch={pipeline_switch}, full engine HARD upgrade was swallowed; answer={actual}");
}

#[tokio::test]
async fn r3_upgrade_epoch_cannot_be_skipped_by_host_preflight() {
    r3_old_render_epoch_comparison(false).await;
}

#[tokio::test]
async fn r3_pipeline_switch_does_not_exempt_module_render_epoch() {
    r3_old_render_epoch_comparison(true).await;
}
