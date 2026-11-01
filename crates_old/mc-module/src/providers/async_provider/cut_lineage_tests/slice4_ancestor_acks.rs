//! Native source facts never import an ancestor's view, summary, baseline or pass facts.
use super::*;

#[derive(Clone, Copy)]
enum ReintroducedSource {
    Same,
    DifferentDigest,
    DifferentIdentity,
    UnrecordedAncestor,
    ExplicitSelection,
    DeferredReceipt,
    OlderNotice,
    CompletedDuplicate,
}

async fn ancestor_reintroduced_source(case: ReintroducedSource) {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    pair.notice(&mut Rng(0xA11C), None).await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let original = pair.transcript.entries.lock().unwrap().clone();
    let old = state.entries[&111].read().unwrap();
    let old_digest = served_part_digest(&old, "0").unwrap();
    let version = store
        .reserve_async_compaction_version(&pair.reference, 0)
        .unwrap();
    let reduced = r#"{"type":"text","text":"ancestor reduced text"}"#;
    // This public native view and its provenance are created together, before
    // the fork. The edit is not accepted into the active baseline yet.
    let published = view::CompactionView::new(
        &pair.reference,
        version,
        "L",
        compact::lineage::MessageRef {
            ordinal: 119,
            mid: "m119".into(),
        },
        vec![view::ViewRange::keep_with_edits(
            0,
            120,
            vec![view::PartEdit::replace(111, "m111", "0", reduced)],
        )],
    );
    published.check().unwrap();
    let mut provenance = frozen_edits::FrozenEdits::default();
    provenance.capture(&published, &state.entries).unwrap();
    let mut engine = state.engine_with_baselines().unwrap();
    // An engine cache may have been rebased. Its range is not publication
    // ownership; a legacy cache without explicit ownership uses the public row.
    engine.last_produced.as_mut().unwrap().range.lineage_id = "rebased-engine-cache".into();
    store
        .save_async_compaction_view(
            &pair.reference,
            version,
            &serde_json::to_string(&published).unwrap(),
            &serde_json::to_string(engine.last_produced.as_ref().unwrap()).unwrap(),
        )
        .unwrap();
    state
        .retired_frozen
        .views
        .insert(version, Arc::new(provenance));
    state.retired_frozen.dirty = true;

    let through = 108;
    let digest = served_digest(&state.entries[&through].read().unwrap()).unwrap();
    assert_eq!(
        verified_descent(&state, &format!("L:{through}:{digest}")),
        Some(through)
    );
    if !matches!(case, ReintroducedSource::UnrecordedAncestor) {
        state
            .remember_verified_ack_descent(store, "child", "L", through)
            .unwrap();
    }
    state.truncate_entries(Some(through));
    state.lineage = Some("child".into());
    state.produced_view = None;
    state.applied_view = None;
    state.applied = None;
    if matches!(case, ReintroducedSource::ExplicitSelection) {
        state.ack_lineage_root = Some("child".into());
    }
    *pair.transcript.lineage.lock().unwrap() = "child".into();
    pair.transcript
        .entries
        .lock()
        .unwrap()
        .truncate(through as usize + 1);
    assert!(!state.entries.contains_key(&111));
    state.save(store, &[]).unwrap();
    let mut state = load(store, &pair.reference).unwrap().unwrap();

    // The acknowledgement arrives while this part is absent. Only recorded
    // ancestry may authorize keeping its source facts for a later reappearance.
    let mut notice = notice::AdvanceNotice::new(
        &pair.reference,
        2,
        "child",
        through,
        digest.clone(),
        1_000,
        "fixture",
    )
    .with_window(100_000)
    .with_applied_view_version(version)
    .with_events(vec![
        notice::Event::MarkerOutcome {
            outcome: notice::MarkerOutcome::Applied,
            cut_id: format!("v{version}"),
        },
        notice::Event::ViewCompanion {
            view_version: version,
            edit: "strip_signed_reasoning".into(),
        },
    ]);
    if matches!(case, ReintroducedSource::UnrecordedAncestor) {
        let mut headers = notice.to_headers();
        headers.insert("descends_from".into(), format!("L:{through}:{digest}"));
        notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
    }
    if matches!(
        case,
        ReintroducedSource::DeferredReceipt
            | ReintroducedSource::OlderNotice
            | ReintroducedSource::CompletedDuplicate
    ) {
        let newer_seq = if matches!(
            case,
            ReintroducedSource::OlderNotice | ReintroducedSource::CompletedDuplicate
        ) {
            5
        } else {
            3
        };
        let newer = notice::AdvanceNotice::new(
            &pair.reference,
            newer_seq,
            "child",
            through,
            digest.clone(),
            1_000,
            "fixture",
        )
        .with_window(100_000);
        state.seq = newer_seq;
        state.partial_read_seq = Some(newer_seq);
        if matches!(case, ReintroducedSource::CompletedDuplicate) {
            state.completed_seq = newer_seq;
            state.partial_read_seq = None;
            pair.resident
                .h
                .provider_store
                .async_runtime
                .policy_probe_enabled
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        state.conditions = Some(newer.to_headers());
        if matches!(case, ReintroducedSource::DeferredReceipt) {
            state.remember_notice_native_ack(store, &notice).unwrap();
            state.save(store, &[]).unwrap();
        } else {
            state.save(store, &[]).unwrap();
            pair.resident
                .h
                .provider_store
                .async_runtime
                .resident
                .lock()
                .unwrap()
                .forget(&pair.reference);
            let message = cortexkit_bus_trait::Message {
                subject: notice::event_subject(
                    "fixture",
                    "thalamus-harness",
                    notice::ADVANCED_EVENT,
                ),
                id: bus_id(&pair.reference, "advanced", notice.seq),
                digest: notice.digest().parse().unwrap(),
                headers: notice.to_headers(),
            };
            pair.resident
                .h
                .advance_compaction("fixture", &message)
                .await
                .unwrap();
        }
        state = load(store, &pair.reference).unwrap().unwrap();
        assert_eq!(state.seq, newer_seq);
        if matches!(case, ReintroducedSource::CompletedDuplicate) {
            assert_eq!(state.completed_seq, newer_seq);
            assert_eq!(state.partial_read_seq, None);
            assert_eq!(
                *pair
                    .resident
                    .h
                    .provider_store
                    .async_runtime
                    .policy_probe
                    .lock()
                    .unwrap(),
                Some((2, None, vec![]))
            );
        } else {
            assert!(state.completed_seq < newer_seq);
            assert_eq!(state.partial_read_seq, Some(newer_seq));
            assert_eq!(
                state.pending_native_acks.get(&version).map(String::as_str),
                Some("L")
            );
        }
        state.partial_read_seq = None;
        notice = newer;
    } else {
        state.seq = notice.seq;
    }
    state.adopt_notice_ack(store, &mut notice).unwrap();
    assert_eq!(state.applied, None);
    assert_eq!(notice.applied_view_version, None);
    assert!(notice.events.is_empty());
    assert!(!state.marker_outcomes.contains_key(&format!("v{version}")));
    let mut state = load(store, &pair.reference).unwrap().unwrap();

    let mut current = original;
    match case {
        ReintroducedSource::Same
        | ReintroducedSource::UnrecordedAncestor
        | ReintroducedSource::ExplicitSelection
        | ReintroducedSource::DeferredReceipt
        | ReintroducedSource::OlderNotice
        | ReintroducedSource::CompletedDuplicate => {}
        ReintroducedSource::DifferentDigest => current[111] = message(Profile::Broca, 111, 999_999),
        ReintroducedSource::DifferentIdentity => current[111].mid = "replacement-source".into(),
    }
    assert_eq!(
        serde_json::to_value(&current[..=through as usize]).unwrap(),
        serde_json::to_value(&pair.transcript.entries.lock().unwrap()[..=through as usize])
            .unwrap()
    );
    for entry in current.iter().skip(through as usize + 1) {
        state.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    state.reindex().unwrap();
    let now = state.entries[&111].read().unwrap();
    let now_digest = served_part_digest(&now, "0").unwrap();
    match case {
        ReintroducedSource::Same
        | ReintroducedSource::UnrecordedAncestor
        | ReintroducedSource::ExplicitSelection
        | ReintroducedSource::DeferredReceipt
        | ReintroducedSource::OlderNotice
        | ReintroducedSource::CompletedDuplicate => assert_eq!(old_digest, now_digest),
        ReintroducedSource::DifferentDigest => {
            assert_eq!(old.mid, now.mid);
            assert_ne!(old_digest, now_digest);
        }
        ReintroducedSource::DifferentIdentity => {
            assert_ne!(old.mid, now.mid);
            assert_eq!(old_digest, now_digest);
        }
    }
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let kept = current
        .iter()
        .map(|entry| {
            (
                entry.ordinal,
                tool_arcs::KeptMessage::new(codec, entry).unwrap(),
            )
        })
        .collect();
    let mut ranges = vec![view::ViewRange::keep_with_edits(0, 120, vec![])];
    state
        .frozen_edits
        .apply(&state.mid_index, &state.entries, &kept, &mut ranges)
        .unwrap();
    let edits = match &ranges[0] {
        view::ViewRange::Keep { edits, .. } => edits,
        _ => panic!("source test must keep the native messages"),
    };
    let carried = edits
        .iter()
        .find(|edit| edit.ordinal == 111 && edit.part == "0");
    match case {
        ReintroducedSource::Same
        | ReintroducedSource::DeferredReceipt
        | ReintroducedSource::OlderNotice
        | ReintroducedSource::CompletedDuplicate => {
            assert_eq!(carried.unwrap().bytes.as_deref(), Some(reduced))
        }
        _ => assert!(
            carried.is_none(),
            "a different source must not inherit the old edit"
        ),
    }
    *pair.transcript.entries.lock().unwrap() = current;
    let native = view::CompactionView::new(
        &pair.reference,
        version + 1,
        "child",
        compact::lineage::MessageRef {
            ordinal: 119,
            mid: "m119".into(),
        },
        ranges,
    );
    let model = String::from_utf8(pair.model_bytes(&native)).unwrap();
    match case {
        ReintroducedSource::Same
        | ReintroducedSource::DeferredReceipt
        | ReintroducedSource::OlderNotice
        | ReintroducedSource::CompletedDuplicate => {
            assert!(model.contains("ancestor reduced text"))
        }
        ReintroducedSource::DifferentDigest => {
            assert!(!model.contains("ancestor reduced text"));
            assert!(model.contains("answer 111.999999"));
        }
        ReintroducedSource::DifferentIdentity => assert!(!model.contains("ancestor reduced text")),
        ReintroducedSource::UnrecordedAncestor | ReintroducedSource::ExplicitSelection => {
            assert!(!model.contains("ancestor reduced text"));
            assert!(model.contains("answer 111.0"));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ancestor_ack_keeps_a_reappended_part_with_a_different_digest() {
    ancestor_reintroduced_source(ReintroducedSource::DifferentDigest).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ancestor_ack_replays_a_reappended_part_with_the_same_digest() {
    ancestor_reintroduced_source(ReintroducedSource::Same).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ancestor_ack_keeps_a_different_identity_at_the_same_ordinal() {
    ancestor_reintroduced_source(ReintroducedSource::DifferentIdentity).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f01_unrelated_ack_cannot_redact_an_identical_native_source() {
    ancestor_reintroduced_source(ReintroducedSource::UnrecordedAncestor).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_selection_clears_pending_ancestor_authority() {
    ancestor_reintroduced_source(ReintroducedSource::ExplicitSelection).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ancestor_ack_receipt_survives_a_newer_notice_without_an_ack() {
    ancestor_reintroduced_source(ReintroducedSource::DeferredReceipt).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn older_ack_notice_cannot_complete_a_newer_partial_read() {
    ancestor_reintroduced_source(ReintroducedSource::OlderNotice).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_ancestor_ack_supplies_no_foreign_policy_facts() {
    ancestor_reintroduced_source(ReintroducedSource::CompletedDuplicate).await;
}

async fn setup_predecessor_fixture() -> (Pair, String) {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(200);
    review_history(&mut pair, 155).await;
    pair.notice(&mut Rng(0x3895), None).await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let reduced = serde_json::to_string(&json!({
        "type":"tool_result", "tool_call_id":"call165", "is_error":false,
        "output":{"kind":"text","text":"[dropped]"}
    }))
    .unwrap();
    let engine = state.engine_with_baselines().unwrap();
    let engine_json = serde_json::to_string(engine.last_produced.as_ref().unwrap()).unwrap();
    let source_end = compact::lineage::MessageRef {
        ordinal: 199,
        mid: "m199".into(),
    };
    let native_version = store
        .reserve_async_compaction_version(&pair.reference, 7)
        .unwrap();
    assert_eq!(native_version, 8);
    let native = view::CompactionView::new(
        &pair.reference,
        native_version,
        "L",
        source_end.clone(),
        vec![view::ViewRange::keep_with_edits(
            0,
            200,
            vec![view::PartEdit::replace(166, "m166", "0", &reduced)],
        )],
    );
    native.check().unwrap();
    let mut provenance = frozen_edits::FrozenEdits::default();
    provenance.capture(&native, &state.entries).unwrap();
    state
        .retired_frozen
        .views
        .insert(native_version, Arc::new(provenance));
    state.retired_frozen.dirty = true;
    store
        .save_async_compaction_view(
            &pair.reference,
            native_version,
            &serde_json::to_string(&native).unwrap(),
            &engine_json,
        )
        .unwrap();
    let summary_version = store
        .reserve_async_compaction_version(&pair.reference, 12)
        .unwrap();
    assert_eq!(summary_version, 13);
    let summary = view::CompactionView::new(
        &pair.reference,
        summary_version,
        "L",
        source_end,
        vec![
            view::ViewRange::replace(
                0,
                164,
                r#"[{"type":"text","text":"abandoned summary from L"}]"#,
            ),
            view::ViewRange::keep_with_edits(
                164,
                200,
                vec![view::PartEdit::replace(166, "m166", "0", &reduced)],
            ),
        ],
    );
    summary.check().unwrap();
    let mut summary_sources = frozen_edits::FrozenEdits::default();
    summary_sources.capture(&summary, &state.entries).unwrap();
    state
        .retired_frozen
        .views
        .insert(summary_version, Arc::new(summary_sources));
    state.save(store, &[]).unwrap();
    store
        .save_async_compaction_view(
            &pair.reference,
            summary_version,
            &serde_json::to_string(&summary).unwrap(),
            &engine_json,
        )
        .unwrap();
    revert_transcript(&pair, 15, "undo-source", 9_000, 4);
    review_complete_turn(&pair);
    let request = setup_request(&pair, "undo-source", None, "setup-undo-source");
    let answer = pair.resident.dispatch(request).await;
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap()["answer"],
        "ready"
    );
    (pair, reduced)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_setup_late_ack_keeps_only_reappeared_native_sources() {
    let (mut pair, reduced) = setup_predecessor_fixture().await;
    assert_eq!(resident_notice_at(&mut pair, 1_000, Some(13)).await, "ok");
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(!state.entries.contains_key(&166));
    assert!(!state.frozen_edits.served("m166", "0", &reduced));
    assert!(
        state.pending_native_acks.is_empty(),
        "an absent source grants no dormant receipt"
    );
    pair.append(180);
    review_complete_turn(&pair);
    assert_eq!(resident_notice_at(&mut pair, 1_000, Some(8)).await, "ok");
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(state.frozen_edits.served("m166", "0", &reduced));
    assert_eq!(
        state.applied, None,
        "the predecessor view is not a baseline"
    );
    assert!(!state
        .conditions
        .as_ref()
        .unwrap()
        .contains_key("applied_view_version"));
    let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"surface_change","deadline_ms":10_000}});
    pair.resident.dispatch(request).await;
    let (_, view, model, _) = newest_view(&pair).unwrap();
    assert!(view.ranges.iter().any(|range| matches!(range, view::ViewRange::Keep { edits, .. } if edits.iter().any(|edit| edit.mid == "m166" && edit.part == "0" && edit.bytes.as_deref() == Some(reduced.as_str())))));
    assert!(!model.contains("abandoned summary from L"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_setup_late_summary_ack_cannot_restore_predecessor_history() {
    let (mut pair, _) = setup_predecessor_fixture().await;
    pair.append(180);
    review_complete_turn(&pair);
    assert_eq!(resident_notice_at(&mut pair, 1_000, Some(13)).await, "ok");
    let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"surface_change","deadline_ms":10_000}});
    pair.resident.dispatch(request).await;
    let (_, view, model, _) = newest_view(&pair).unwrap();
    assert_eq!(view.lineage_id, "undo-source");
    assert!(!model.contains("abandoned summary from L"));
    assert!(summaries_in(&model).iter().all(|through| *through <= 15));
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(state.applied, None);
    assert!(state
        .applied_view
        .as_ref()
        .is_none_or(|view| view.identity.1.lineage_id == "undo-source"));
    assert!(!state
        .conditions
        .as_ref()
        .unwrap()
        .contains_key("applied_view_version"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_setup_native_ack_survives_absent_source_without_header_repeat() {
    let (mut pair, reduced) = setup_predecessor_fixture().await;
    assert_eq!(resident_notice_at(&mut pair, 1_000, Some(13)).await, "ok");
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(!state.entries.contains_key(&166));
    assert!(!state.frozen_edits.served("m166", "0", &reduced));
    assert_eq!(
        state.native_setup_predecessor.as_ref().unwrap().ack_version,
        Some(13)
    );
    assert!(state.pending_native_acks.is_empty());
    pair.resident
        .h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .forget(&pair.reference);
    pair.append(180);
    review_complete_turn(&pair);
    assert_eq!(resident_notice_at(&mut pair, 1_000, None).await, "ok");
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(state.frozen_edits.served("m166", "0", &reduced));
    assert_eq!(state.applied, None);
    assert!(!state
        .conditions
        .as_ref()
        .unwrap()
        .contains_key("applied_view_version"));
    let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"surface_change","deadline_ms":10_000}});
    pair.resident.dispatch(request).await;
    let (version, view, _, _) = newest_view(&pair).unwrap();
    assert_eq!(view.lineage_id, "undo-source");
    assert_eq!(
        resident_notice_at(&mut pair, 1_000, Some(version)).await,
        "ok"
    );
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(
        state.native_setup_predecessor.as_ref().unwrap().ack_version,
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ride_native_ack_before_undo_remains_durable_when_sources_return() {
    review_session_inner(
        Profile::Broca,
        1_779_034_251,
        12,
        true,
        Some(vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
        true,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reverted_cut_setup_native_ack_remains_durable_when_sources_return() {
    review_session_inner(
        Profile::OpenCode,
        1_779_034_264,
        12,
        true,
        Some(vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
        true,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_native_ack_before_undo_remains_durable_when_sources_return() {
    review_session_inner(
        Profile::Anthropic,
        1_779_034_270,
        12,
        true,
        Some(vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
        true,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selected_cut_undo_facts_follow_sources_read_after_the_first_window() {
    review_session_inner(
        Profile::Pi,
        1_779_034_041,
        12,
        true,
        Some(vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
        true,
    )
    .await;
}
