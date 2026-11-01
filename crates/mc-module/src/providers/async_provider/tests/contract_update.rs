//! compaction-provider 0.7.2's account change, the async decision log, and
//! the reasoning shapes llm-runner 0.7.4's archive pruning serves.
use super::*;

const ACCOUNT: &str = "Route_1.a-b";

fn decision_lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

/// The decision line logged for notice `seq`.
fn notice_line(rig: &Rig, seq: u64) -> String {
    let marker = format!(" notice seq={seq} ");
    decision_lines(rig)
        .into_iter()
        .rfind(|line| line.contains(&marker))
        .unwrap_or_else(|| {
            panic!(
                "no decision line for notice {seq}: {:?}",
                decision_lines(rig)
            )
        })
}

/// Forty messages read at low usage, with three tool results queued for
/// dropping: cleanup a rebuild may land but a low-usage notice defers.
async fn rig_with_pending_cleanup(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    rig.queue(&[163, 166, 169]).await;
    rig
}

async fn ride_with(rig: &Rig, params: Value) -> Value {
    rig.op("compaction.ride", params).await
}

/// compaction-provider 0.7.2: a ride with cause `account_change` (the runner
/// picked a new account before the request) folds exactly as a
/// `model_change` ride does: one rebuild that also lands the pending cleanup,
/// with the same view and the same bytes. Its decision line names the cause
/// and never the account label.
#[tokio::test]
async fn account_change_ride_folds_exactly_like_model_change() {
    let model_dir = tempfile::tempdir().unwrap();
    let account_dir = tempfile::tempdir().unwrap();
    let model = rig_with_pending_cleanup(model_dir.path()).await;
    let account = rig_with_pending_cleanup(account_dir.path()).await;
    let model_answer = ride_with(
        &model,
        json!({"session_ref":model.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    let account_answer = ride_with(
        &account,
        json!({"session_ref":account.reference,"cause":"account_change","account":ACCOUNT,"deadline_ms":10_000}),
    )
    .await;
    assert_eq!(model_answer["answer"], "view", "{model_answer}");
    assert_eq!(account_answer["answer"], "view", "{account_answer}");
    let model_view: view::CompactionView = decode(&model_answer["view"]).unwrap();
    let account_view: view::CompactionView = decode(&account_answer["view"]).unwrap();
    assert_eq!(account_view.view_version, model_view.view_version);
    assert_eq!(account_view.ranges, model_view.ranges);
    assert_eq!(account.render(&account_view), model.render(&model_view));
    assert_eq!(account_answer["cache_ttl"], model_answer["cache_ttl"]);
    // The pending cleanup landed in that one rebuild.
    let dropped = |view: &view::CompactionView| {
        view.ranges.iter().any(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.iter().any(|edit| edit.ordinal == 21),
            view::ViewRange::Replace { from, to, .. } => *from <= 21 && 21 < *to,
            _ => false,
        })
    };
    assert!(
        dropped(&account_view),
        "the queued drop lands in the rebuild"
    );
    let line = decision_lines(&account)
        .into_iter()
        .find(|line| line.contains("ride cause="))
        .expect("the ride logs its decision");
    assert!(line.starts_with("async decision ride "), "{line}");
    assert!(line.contains("ride cause=account_change"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
    // The label is stored nowhere: the ride carries no fact ck-mc keeps.
    let store = account.h.store.get().unwrap();
    let raw = store
        .load_async_compaction(&account.reference)
        .unwrap()
        .unwrap();
    assert!(!raw.contains(ACCOUNT), "the ride's label is not stored");
}

/// compaction-provider 0.7.2: the account label is required on an
/// `account_change` ride and must be 1-64 bytes of `[A-Za-z0-9._-]`. A
/// missing or malformed one is refused naming the `account` member, and the
/// refusal never echoes the label.
#[tokio::test]
async fn account_change_ride_without_a_valid_account_is_refused_by_member() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    for account in [
        None,
        Some(""),
        Some("route/account"),
        Some(&*"a".repeat(65)),
    ] {
        let mut params =
            json!({"session_ref":rig.reference,"cause":"account_change","deadline_ms":10_000});
        if let Some(account) = account {
            params["account"] = json!(account);
        }
        match rig
            .h
            .dispatch_value(7, json!({"method":"compaction.ride","params":params}))
            .await
        {
            HandlerOutcome::ErrorWithDetail {
                code,
                detail,
                message,
            } => {
                assert_eq!(code, "invalid_params", "{account:?}");
                assert_eq!(detail, json!({"field":"account"}), "{account:?}");
                if let Some(label) = account.filter(|label| !label.is_empty()) {
                    assert!(!message.contains(label), "{message}");
                }
            }
            other => panic!("{account:?} was not refused: {other:?}"),
        }
    }
    assert_eq!(rig.newest(), None, "a refused ride rebuilds nothing");
}

#[tokio::test]
async fn service_tier_change_ride_folds_like_model_change() {
    let model_dir = tempfile::tempdir().unwrap();
    let tier_dir = tempfile::tempdir().unwrap();
    let model = rig_with_pending_cleanup(model_dir.path()).await;
    let tier = rig_with_pending_cleanup(tier_dir.path()).await;
    let model_answer = ride_with(
        &model,
        json!({"session_ref":model.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    let tier_answer = ride_with(&tier, json!({"session_ref":tier.reference,"cause":"service_tier_change","service_tier":"fast","deadline_ms":10_000})).await;
    assert_eq!(model_answer["answer"], "view", "{model_answer}");
    assert_eq!(tier_answer["answer"], "view", "{tier_answer}");
    let model_view: view::CompactionView = decode(&model_answer["view"]).unwrap();
    let tier_view: view::CompactionView = decode(&tier_answer["view"]).unwrap();
    assert_eq!(tier_view.ranges, model_view.ranges);
    assert_eq!(tier.render(&tier_view), model.render(&model_view));
    assert_eq!(tier_answer["cache_ttl"], model_answer["cache_ttl"]);
}

#[tokio::test]
async fn service_tier_change_without_tier_refuses_service_tier() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    let outcome = rig.h.dispatch_value(7, json!({"method":"compaction.ride","params":{"session_ref":rig.reference,"cause":"service_tier_change","deadline_ms":10_000}})).await;
    let HandlerOutcome::ErrorWithDetail { code, detail, .. } = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(code, "invalid_params");
    assert_eq!(detail, json!({"field":"service_tier"}));
    assert_eq!(rig.newest(), None);
}

/// compaction-provider 0.7.2: the `account_change:<account>` notice event
/// reports a switch the runner learned only after the new account's cache
/// was written. ck-mc records it with the notice and never rebuilds for it:
/// the pending cleanup a rebuild would land stays pending, and the decision
/// line names the event without its label.
#[tokio::test]
async fn account_change_notice_event_is_recorded_and_never_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    let pending = rig.pending_targets();
    assert!(!pending.is_empty());
    rig.notice_with(
        2,
        1_000,
        None,
        None,
        vec![notice::Event::AccountChange(ACCOUNT.into())],
    )
    .await;
    assert_eq!(rig.newest(), None, "the event never rebuilds");
    assert_eq!(rig.pending_targets(), pending, "nothing landed");
    let state = rig.state();
    assert_eq!(
        state.acknowledgements,
        vec![format!("account_change:{ACCOUNT}")],
        "the notice's event is recorded with the notice"
    );
    let line = notice_line(&rig, 2);
    assert!(line.starts_with("async decision defer "), "{line}");
    assert!(line.contains("events=[account_change]"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
}

/// compaction-provider 0.7.3: ck-mc reconciles its held copies with every
/// prune the runner reports (`pruned_reasoning`), so a new session's Setup
/// ready answer opts in with `accepts: ["pruned_reasoning"]`, and a repeat
/// Setup answers it unchanged.
#[tokio::test]
async fn setup_answer_opts_new_sessions_in_to_archive_pruning() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let answer: compact::setup::SetupAnswer = decode(&rig.state().initial).unwrap();
    assert_eq!(
        answer.accepts(),
        &[compact::setup::ACCEPTS_PRUNED_REASONING]
    );
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["request_id"] = json!("again");
    let again = rig.op("compaction.setup", request).await;
    assert_eq!(again["accepts"], json!(["pruned_reasoning"]), "{again}");
}

/// A finished summary at low usage publishes nothing; the next notice at
/// the execute threshold publishes it. Each notice logs one decision line
/// with the usage it saw, the threshold and that a summary is waiting.
#[tokio::test]
async fn finished_summary_waits_for_the_execute_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None);
    let first = notice_line(&rig, 1);
    assert!(first.contains("summary_waiting=false"), "{first}");
    // A summary completes: the historian publishes compartments. Unlike a
    // flush, that arms no soft refresh.
    let namespace = rig.state().namespace();
    rig.h
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &namespace,
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 20,
                end_message_id: "m20#0".into(),
                title: "history".into(),
                content: "the finished summary".into(),
                p1: Some("the finished summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    rig.notice(2, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    let low = notice_line(&rig, 2);
    assert!(low.starts_with("async decision defer "), "{low}");
    assert!(low.contains("usage=1.0%"), "{low}");
    assert!(low.contains("threshold=65.0%"), "{low}");
    assert!(low.contains("summary_waiting=true"), "{low}");
    rig.notice(3, 70_000, None).await;
    let version = rig.newest().expect("the execute threshold publishes it");
    let view = rig.get(version).await;
    let rendered = String::from_utf8(rig.render(&view)).unwrap();
    assert!(
        rendered.contains("the finished summary"),
        "the summary is in the view"
    );
    let high = notice_line(&rig, 3);
    assert!(high.starts_with("async decision execute "), "{high}");
    assert!(high.contains("usage=70.0%"), "{high}");
    assert!(high.contains("threshold=65.0%"), "{high}");
    assert!(high.contains("summary_waiting=true"), "{high}");
}

/// The decoded reasoning blocks of one message.
fn reasoning_blocks(codec: codec::Codec, message: Value) -> Vec<ck_wire::CkKind> {
    let decoded = codec
        .decode_message(&InboundMessage {
            ordinal: 1,
            mid: "m1".into(),
            message,
        })
        .unwrap_or_else(|error| panic!("{codec:?}: {error:?}"));
    decoded
        .ck
        .content
        .into_iter()
        .map(|block| block.kind)
        .filter(|kind| {
            matches!(
                kind,
                ck_wire::CkKind::Reasoning { .. } | ck_wire::CkKind::RedactedReasoning { .. }
            )
        })
        .collect()
}

/// Archive pruning empties reasoning to `text: ""` with no signature. That
/// shape decodes in all four native formats as empty reasoning, never a
/// refusal; owned-broca's pruned `redacted_reasoning` keeps its required
/// `data: ""` and its `provider_format`, and both owned-broca blocks go back
/// to the runner as its own bytes. The owned-broca samples are llm-runner
/// 0.7.9's published pruning vectors.
#[test]
fn empty_reasoning_decodes_in_all_four_formats() {
    let empty = ck_wire::CkKind::Reasoning {
        text: String::new(),
        signature: None,
    };
    let vectors: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("archive-prunes-reasoning.json").unwrap(),
    )
    .unwrap();
    let mut broca_blocks = 0;
    for case in vectors["cases"].as_array().unwrap() {
        let served = &case["served"];
        let expected = match served["type"].as_str().unwrap() {
            "reasoning" => empty.clone(),
            "redacted_reasoning" if served["data"] == "" => ck_wire::CkKind::RedactedReasoning {
                data: String::new(),
            },
            // The other pruning kinds are shapes owned-broca's schema does
            // not have (`text_with_state`, a generic `tool_call`).
            _ => continue,
        };
        let message = json!({"role":"assistant","content":[served]});
        assert_eq!(
            reasoning_blocks(codec::Codec::OwnedBroca, message.clone()),
            vec![expected]
        );
        let decoded = codec::Codec::OwnedBroca
            .decode_message(&InboundMessage {
                ordinal: 1,
                mid: "m1".into(),
                message: message.clone(),
            })
            .unwrap();
        assert_eq!(
            bytes(&codec::encode_message(&decoded.ck).unwrap()).unwrap(),
            bytes(&message).unwrap(),
            "{served}: goes back as the runner's bytes"
        );
        broca_blocks += 1;
    }
    assert_eq!(broca_blocks, 2, "the reasoning and redacted vectors ran");
    for (codec, message) in [
        (
            codec::Codec::AnthropicMessages,
            json!({"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"done"}]}),
        ),
        (
            codec::Codec::OpencodeAiSdk,
            json!({"info":{"id":"m1","role":"assistant","time":{"created":1}},"parts":[{"id":"p1r","type":"reasoning","text":""},{"id":"p1t","type":"text","text":"done"}]}),
        ),
        (
            codec::Codec::Pi,
            json!({"type":"message","id":"m1","parentId":"m0","timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"done"}]}}),
        ),
    ] {
        assert_eq!(
            reasoning_blocks(codec, message),
            vec![empty.clone()],
            "{codec:?}"
        );
    }
}

/// `summary_waiting` on a decision line, read in a fixed number of store
/// reads: false with no compartments, false when the newest compartment ends
/// at or below the coverage a published view has, and true when it ends past
/// it (or when nothing is covered yet).
#[tokio::test]
async fn summary_waiting_compares_the_newest_compartment_end_with_coverage() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    // Notice completion does not wait for the historian's background identity
    // and metadata writes. Let them finish so the coverage commits cannot race.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("initial notice's historian evaluation did not finish");
    let store = rig.h.store.get().unwrap();
    let namespace = rig.state().namespace();
    let waiting = || rig.h.decision_facts(&rig.state()).summary_waiting;
    let cover = |coverage: Option<u64>| {
        let loaded = store.load_meta(&namespace).unwrap();
        let mut meta = loaded.meta;
        meta.coverage_ordinal = coverage;
        store
            .commit_meta(&namespace, loaded.row_version, &meta)
            .unwrap();
    };
    assert_eq!(waiting(), Some(false), "no compartments");
    let compartment = |sequence: i64, start: i64, end: i64| mc_store::StoredCompartment {
        sequence,
        start_message: start,
        end_message: end,
        end_message_id: format!("m{end}#0"),
        title: "history".into(),
        content: format!("summary {sequence}"),
        p1: Some(format!("summary {sequence}")),
        importance: 50,
        ..Default::default()
    };
    store
        .replace_compartments(&namespace, &[compartment(1, 0, 10), compartment(2, 11, 20)])
        .unwrap();
    for (coverage, expected) in [
        (Some(20), false),
        (Some(25), false),
        (Some(19), true),
        (Some(10), true),
        (None, true),
    ] {
        cover(coverage);
        assert_eq!(waiting(), Some(expected), "coverage {coverage:?}");
    }
    for (end, coverage, expected) in [(20, Some(20), false), (21, Some(20), true), (0, None, true)]
    {
        assert_eq!(
            decision_log::summary_waiting(end, coverage),
            expected,
            "end {end} coverage {coverage:?}"
        );
    }
}
