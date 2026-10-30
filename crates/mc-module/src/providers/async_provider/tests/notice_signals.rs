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
