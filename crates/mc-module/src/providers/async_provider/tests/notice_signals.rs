//! Optional compaction-provider notice signals: digest-preserving reads, no new pricing policy.
use super::*;

#[test]
fn history_edit_cost_and_chain_reset_match_published_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/testdata/compaction-provider-v1/notice-signals-0.7.9.json"
    )))
    .unwrap();
    let cases = vectors["history_edit_cost"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let mut headers: BTreeMap<String, String> =
            serde_json::from_value(case["headers"].clone()).unwrap();
        let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
        assert_eq!(notice.to_headers(), headers, "{}", case["name"]);
        assert_eq!(notice.digest(), case["digest"], "{}", case["name"]);
        assert_eq!(notice::notice_digest(&headers), case["digest"]);
        assert_eq!(notice.message_id(), case["message_id"]);
        headers.remove("history_edit_cost");
        assert_eq!(
            notice::notice_digest(&headers),
            case["without_header_digest"]
        );
    }
    let rides = vectors["chain_reset"].as_array().unwrap();
    assert_eq!(rides.len(), 2);
    for case in rides {
        let request: ride::RideRequest = serde_json::from_value(case["params"].clone()).unwrap();
        assert_eq!(request.check(), Ok(()), "{}", case["name"]);
        assert!(!matches!(request.cause, ride::RideCause::Unknown(_)));
        assert_eq!(request.cause.as_str(), "chain_reset");
        assert_eq!(serde_json::to_value(request).unwrap(), case["params"]);
    }
}

#[test]
fn notice_digest_is_backward_compatible_only_when_new_header_is_absent() {
    use sha2::{Digest, Sha256};

    // The 0.7.6 and 0.7.8 readers frame only these fourteen headers. Keeping
    // their list independent of today's list exposes mixed-version mismatches.
    const LEGACY_HEADERS: &[&str] = &[
        "applied_view_version",
        "descends_from",
        "est_tokens",
        "events",
        "first_ordinal",
        "last_usage",
        "lineage_id",
        "model",
        "reasoning_pruned",
        "seq",
        "session_ref",
        "through_digest",
        "through_ordinal",
        "window",
    ];
    let vectors: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/testdata/compaction-provider-v1/notice-signals-0.7.9.json"
    )))
    .unwrap();
    for case in vectors["history_edit_cost"].as_array().unwrap() {
        let headers: BTreeMap<String, String> =
            serde_json::from_value(case["headers"].clone()).unwrap();
        let mut hash = Sha256::new();
        let mut frame = |value: &[u8]| {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        };
        frame(b"ck.compaction.advanced.v1");
        for name in LEGACY_HEADERS {
            if let Some(value) = headers.get(*name) {
                frame(name.as_bytes());
                frame(value.as_bytes());
            }
        }
        let legacy = format!("{:x}", hash.finalize());
        assert_eq!(
            legacy,
            "68933bae4689968a07316d16c364e9f90d8528f525cf49474fcdc4305bcb51ff"
        );
        let current = notice::notice_digest(&headers);
        assert_eq!(current, case["digest"]);
        assert_eq!(
            legacy == current,
            !headers.contains_key("history_edit_cost"),
            "{}",
            case["name"]
        );
    }
}

fn lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

fn message(rig: &Rig, seq: u64, size: u64, cost: Option<&str>) -> cortexkit_bus_trait::Message {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        rig.runner.lineage.lock().unwrap().clone(),
        last.ordinal,
        contract::digest::content_digest(&last.message),
        size,
        "fixture",
    )
    .with_window(100_000);
    let mut headers = notice.to_headers();
    if let Some(cost) = cost {
        headers.insert("history_edit_cost".into(), cost.into());
    }
    cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice::notice_digest(&headers).parse().unwrap(),
        headers,
    }
}

#[tokio::test]
async fn history_edit_cost_is_stored_and_logged_without_changing_policy() {
    let mut control = None;
    for cost in [
        None,
        Some("suffix"),
        Some("full_resend"),
        Some("future_cost"),
        Some("future\nforged_line"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new(dir.path()).await;
        rig.fill(40);
        rig.notice(1, 1_000, None).await;
        rig.queue(&[163, 166, 169]).await;
        let pending = rig.pending_targets();
        let notice = message(&rig, 2, 1_000, cost);
        if cost.is_some() {
            let mut wrong = notice.clone();
            let mut omitted = notice.headers.clone();
            omitted.remove("history_edit_cost");
            wrong.digest = notice::notice_digest(&omitted).parse().unwrap();
            assert!(
                rig.h.advance_compaction("fixture", &wrong).await.is_err(),
                "the old digest must be refused"
            );
            assert_eq!(
                rig.state().seq,
                1,
                "bad claim checks must not advance the cursor"
            );
        }
        rig.h.advance_compaction("fixture", &notice).await.unwrap();
        assert_eq!(rig.newest(), None, "{cost:?}: low usage still defers");
        assert_eq!(
            rig.pending_targets(),
            pending,
            "{cost:?}: no cleanup rebuild"
        );
        // Rig::state loads the saved record, not the resident engine.
        let saved = rig.state();
        assert_eq!(
            saved
                .conditions
                .as_ref()
                .unwrap()
                .get("history_edit_cost")
                .map(String::as_str),
            cost
        );
        assert_eq!(
            notice::AdvanceNotice::from_headers(saved.conditions.as_ref().unwrap())
                .unwrap()
                .to_headers(),
            notice.headers
        );
        let decisions = lines(&rig);
        let matching: Vec<_> = decisions
            .iter()
            .filter(|line| line.contains(" notice seq=2 "))
            .collect();
        assert_eq!(matching.len(), 1);
        assert!(
            matching[0].contains(&format!("history_edit_cost={:?}", cost.unwrap_or("absent"))),
            "{}",
            matching[0]
        );
        assert!(
            !matching[0].contains('\n'),
            "unknown hints must not forge log lines"
        );
        rig.h
            .advance_compaction("fixture", &message(&rig, 3, 70_000, cost))
            .await
            .unwrap();
        let version = rig
            .newest()
            .expect("today's execute threshold still publishes cleanup");
        let view = rig.get(version).await;
        let result = (view.ranges.clone(), rig.render(&view));
        if let Some(control) = &control {
            assert_eq!(
                &result, control,
                "{cost:?}: pricing hint must not change the view"
            );
        } else {
            control = Some(result);
        }
        rig.h
            .advance_compaction("fixture", &message(&rig, 4, 1_000, None))
            .await
            .unwrap();
        assert!(
            !rig.state()
                .conditions
                .unwrap()
                .contains_key("history_edit_cost"),
            "an omitted hint must clear the previous hint"
        );
        assert!(lines(&rig)
            .iter()
            .any(|line| line.contains(" notice seq=4 history_edit_cost=\"absent\"")));
    }
}

async fn held_summary_and_drops(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.queue(&[163, 166, 169]).await;
    rig.h
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &rig.state().namespace(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 20,
                end_message_id: "m20#0".into(),
                title: "history".into(),
                content: "held finished summary".into(),
                p1: Some("held finished summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    rig
}

#[tokio::test]
async fn no_ride_or_unknown_cause_leaves_summary_and_drops_held() {
    let dir = tempfile::tempdir().unwrap();
    let rig = held_summary_and_drops(dir.path()).await;
    let pending = rig.pending_targets();

    for (seq, cost) in [
        None,
        Some("full_resend"),
        Some("chain_reset"),
        Some("future_cost"),
    ]
    .into_iter()
    .enumerate()
    {
        rig.h
            .advance_compaction("fixture", &message(&rig, seq as u64 + 2, 1_000, cost))
            .await
            .unwrap();
        assert_eq!(
            rig.newest(),
            None,
            "a pricing hint is not a reset: {cost:?}"
        );
        assert_eq!(rig.pending_targets(), pending);
    }
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"future_chain_reset","deadline_ms":10_000}),
        )
        .await;
    assert_eq!(answer["answer"], "nothing");
    assert_eq!(rig.newest(), None);
    assert_eq!(rig.pending_targets(), pending);
}

#[tokio::test]
async fn chain_reset_from_another_runner_is_refused_without_landing_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let rig = held_summary_and_drops(dir.path()).await;
    let pending = rig.pending_targets();
    rig.bind_provider(8, "broca", "runner", "s");
    match rig
        .h
        .dispatch_value(
            8,
            json!({"method":"compaction.ride","params":{
                "session_ref":rig.reference,"cause":"chain_reset","deadline_ms":10_000
            }}),
        )
        .await
    {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_params");
            assert_eq!(detail, json!({"field":"session_ref"}));
        }
        other => panic!("a foreign runner must not reset this session: {other:?}"),
    }
    assert_eq!(rig.newest(), None);
    assert_eq!(rig.pending_targets(), pending);
}

#[tokio::test]
async fn chain_reset_and_ttl_drain_held_summary_and_drops_then_replay_identically() {
    let mut control = None;
    for cause in ["ttl_expired", "chain_reset"] {
        let dir = tempfile::tempdir().unwrap();
        let rig = held_summary_and_drops(dir.path()).await;
        rig.notice(2, 1_000, None).await;
        assert_eq!(rig.newest(), None, "the finished summary must be held");
        let view = rig.ride(cause).await.expect("cache-loss rewrite view");
        let bytes = rig.render(&view);
        assert!(String::from_utf8_lossy(&bytes).contains("held finished summary"));
        assert!(rig.pending_targets().is_empty());
        let landed = (view.ranges.clone(), bytes.clone());
        if let Some(control) = &control {
            assert_eq!(&landed, control);
        } else {
            control = Some(landed);
        }

        rig.queue(&[178]).await;
        let pending = rig.pending_targets();
        rig.notice(3, 1_000, Some(view.view_version)).await;
        assert_eq!(rig.newest(), Some(view.view_version));
        assert_eq!(rig.pending_targets(), pending);
        let replay = rig.get(view.view_version).await;
        assert_eq!(
            serde_json::to_vec(&replay).unwrap(),
            serde_json::to_vec(&view).unwrap()
        );
        assert_eq!(rig.render(&replay), bytes);
        assert_eq!(
            lines(&rig)
                .iter()
                .filter(|line| line.contains("+rebuild"))
                .count(),
            1
        );
    }
}

/// compaction-provider 0.7.12: a service tier is part of the provider's cache
/// key, so a `service_tier_change` ride lands held work in one rebuild exactly
/// like a TTL expiry. A ride without its tier is refused by that member.
#[tokio::test]
async fn service_tier_change_rides_like_a_ttl_expiry() {
    let control = {
        let dir = tempfile::tempdir().unwrap();
        let rig = held_summary_and_drops(dir.path()).await;
        rig.notice(2, 1_000, None).await;
        let view = rig.ride("ttl_expired").await.expect("ttl rewrite view");
        (view.ranges.clone(), rig.render(&view))
    };
    let dir = tempfile::tempdir().unwrap();
    let rig = held_summary_and_drops(dir.path()).await;
    rig.notice(2, 1_000, None).await;
    let pending = rig.pending_targets();
    match rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.ride","params":{
                "session_ref":rig.reference,"cause":"service_tier_change","deadline_ms":10_000
            }}),
        )
        .await
    {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_params");
            assert_eq!(detail["field"], "service_tier");
        }
        other => panic!("a tier change without its tier must be refused: {other:?}"),
    }
    assert_eq!(rig.newest(), None);
    assert_eq!(rig.pending_targets(), pending);

    let answer = rig
        .op(
            "compaction.ride",
            json!({
                "session_ref":rig.reference,"cause":"service_tier_change",
                "service_tier":"fast","deadline_ms":10_000
            }),
        )
        .await;
    assert_eq!(answer["answer"], "view", "{answer}");
    let view: view::CompactionView = decode(&answer["view"]).unwrap();
    assert!(rig.pending_targets().is_empty());
    assert_eq!((view.ranges.clone(), rig.render(&view)), control);
}
