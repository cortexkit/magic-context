//! Provider-level witnesses for the cache-preserving resync contract.
use super::*;
use crate::providers::async_provider::resync_replay::Replay;

fn native_request_bytes(rig: &Rig, view: &view::CompactionView) -> Vec<u8> {
    assert_eq!(independent_digest(view), view.digest);
    let render_tags = rig.state().setup.composition.get("render_tags") == Some(&json!(true));
    let entries = rig.runner.entries.lock().unwrap();
    let render = |entry: &ReadMessage, edits: &[view::PartEdit]| {
        let mut message = entry.message.clone();
        let mut content = Vec::new();
        for (index, source) in entry.message["content"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let tag = entry.tags.get(index);
            let edit = edits.iter().find(|edit| {
                edit.ordinal == entry.ordinal && tag.is_some_and(|tag| edit.part == tag.part)
            });
            if edit.is_some_and(|edit| edit.drop) {
                continue;
            }
            let part = if let Some(bytes) = edit.and_then(|edit| edit.bytes.as_ref()) {
                serde_json::from_str(bytes).unwrap()
            } else {
                let mut part = source.clone();
                if let Some(tag) = tag.and_then(|tag| tag.tag.as_ref()).filter(|_| render_tags) {
                    for pointer in ["/text", "/output/text"] {
                        if let Some(text) =
                            part.pointer_mut(pointer).filter(|text| text.is_string())
                        {
                            *text = json!(format!("{tag} {}", text.as_str().unwrap()));
                            break;
                        }
                    }
                }
                part
            };
            content.push(part);
        }
        message["content"] = json!(content);
        message
    };
    let mut messages = Vec::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                messages.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap())
            }
            view::ViewRange::Keep { from, to, edits } => messages.extend(
                entries
                    .iter()
                    .filter(|entry| (*from..*to).contains(&entry.ordinal))
                    .map(|entry| render(entry, edits)),
            ),
            _ => panic!("unknown range"),
        }
    }
    messages.extend(
        entries
            .iter()
            .filter(|entry| entry.ordinal > view.covers_through.ordinal)
            .map(|entry| render(entry, &[])),
    );
    serde_json::to_vec(&messages).unwrap()
}

async fn mismatch(rig: &Rig, seq: u64) {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let mut native = last.message.clone();
    native["review_notice_only"] = json!(true);
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        rig.runner.lineage.lock().unwrap().clone(),
        last.ordinal,
        contract::digest::content_digest(&native),
        8_000,
        "fixture",
    )
    .with_window(100_000);
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };
    rig.h
        .advance_compaction_once("fixture", &message)
        .await
        .unwrap();
    assert!(rig.state().resync);
    assert!(rig
        .state()
        .resync_sources
        .as_ref()
        .unwrap()
        .replay
        .is_some());
}

fn assert_request_eq(actual: &[u8], expected: &[u8], reason: &str) {
    assert_eq!(
        crate::sha256_hex(actual),
        crate::sha256_hex(expected),
        "{reason}; request bytes actual={} expected={}",
        actual.len(),
        expected.len()
    );
}

#[tokio::test]
async fn acknowledged_drops_survive_identical_resync_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let served = rig.ride("ceiling").await.unwrap();
    rig.notice(3, 8_000, Some(served.view_version)).await;
    assert!(rig.pending_targets().is_empty());
    let expected = native_request_bytes(&rig, &served);
    mismatch(&rig, 4).await;
    rig.notice(5, 8_000, Some(served.view_version)).await;
    let reissued = rig.get(rig.newest().unwrap()).await;
    assert!(reissued.view_version > served.view_version);
    assert_request_eq(
        &native_request_bytes(&rig, &reissued),
        &expected,
        "acknowledged drops and the history head must remain byte-identical",
    );
}

#[tokio::test]
async fn unacknowledged_drops_do_not_land_on_identical_resync() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let served = rig.get(applied).await;
    let expected = native_request_bytes(&rig, &served);
    let unapplied = rig.ride("ceiling").await.unwrap().view_version;
    assert!(unapplied > applied);
    assert!(rig.pending_targets().is_empty());
    assert_ne!(
        native_request_bytes(&rig, &rig.get(unapplied).await),
        expected
    );
    assert_eq!(rig.state().applied, Some(applied));
    mismatch(&rig, 4).await;
    rig.notice(5, 8_000, Some(applied)).await;
    let reissued = rig.get(rig.newest().unwrap()).await;
    assert!(reissued.view_version > unapplied);
    let decision = last_decision(&rig);
    assert!(decision.starts_with("async decision defer "), "{decision}");
    assert!(!decision.contains("+rebuild"), "{decision}");
    eprintln!("unacknowledged replay decision: {decision}");
    assert_request_eq(
        &native_request_bytes(&rig, &reissued),
        &expected,
        "an unacknowledged reduction must not become serving state on a defer",
    );
}

#[tokio::test]
async fn replay_fingerprints_reject_old_position_changes() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let state = rig.state();
    let replay = Replay::capture(&state).unwrap().unwrap();
    assert!(replay.matches(&state).unwrap());
    let original = state.entries.get(&15).unwrap().read().unwrap();
    for field in [
        "part",
        "tags",
        "mid",
        "digest",
        "part_digests",
        "role",
        "written_at",
    ] {
        let mut changed = rig.state();
        let mut entry = original.clone();
        match field {
            "part" => entry.message["content"][0]["text"] = json!("edited"),
            "tags" => entry.tags[0].tag = Some("§99999§".into()),
            "mid" => entry.mid = "reassigned".into(),
            "digest" => entry.digest = Some(crate::sha256_hex(b"changed")),
            "part_digests" => {
                entry.part_digests.as_mut().unwrap()[0].digest = crate::sha256_hex(b"changed")
            }
            "role" => entry.role = Some("user".into()),
            "written_at" => entry.written_at = Some(7),
            _ => unreachable!(),
        }
        changed
            .entries
            .insert(15, Arc::new(HeldEntry::from_read(&entry).unwrap()));
        assert!(
            !replay.matches(&changed).unwrap(),
            "changed {field} replayed"
        );
    }
    let mut changed = rig.state();
    changed.truncate_entries(Some(14));
    assert!(!replay.matches(&changed).unwrap(), "truncation replayed");
    let mut changed = rig.state();
    changed.lineage_first_ordinal = 1;
    assert!(
        !replay.matches(&changed).unwrap(),
        "first ordinal change replayed"
    );
    let mut changed = rig.state();
    changed.truncate_entries(Some(14));
    for n in 15..40 {
        let mut entry = state.entries.get(&n).unwrap().read().unwrap();
        if n == 15 {
            entry.mid = "replacement-after-revert".into();
        }
        changed
            .entries
            .insert(n, Arc::new(HeldEntry::from_read(&entry).unwrap()));
    }
    assert_eq!(changed.entries.len(), state.entries.len());
    assert!(
        !replay.matches(&changed).unwrap(),
        "same-count revert/reappend replayed"
    );
}

#[tokio::test]
async fn replay_fingerprint_rejects_a_numeric_representation_edit() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let mut state = rig.state();
    let mut before = state.entries.get(&1).unwrap().read().unwrap();
    before.message["content"][0]["input"]["count"] = json!(1);
    before.digest = None;
    before.part_digests = None;
    let before = serve_descriptors(&before);
    state
        .entries
        .insert(1, Arc::new(HeldEntry::from_read(&before).unwrap()));
    let replay = Replay::capture(&state).unwrap().unwrap();
    let mut after = before.clone();
    after.message["content"][0]["input"]["count"] = json!(1.0);
    after.digest = None;
    after.part_digests = None;
    let after = serve_descriptors(&after);
    assert!(!stable_entry(&before, &after));
    assert_ne!(
        serde_json::to_vec(&before.message).unwrap(),
        serde_json::to_vec(&after.message).unwrap()
    );
    assert_eq!(before.digest, after.digest);
    assert_eq!(before.part_digests, after.part_digests);
    state
        .entries
        .insert(1, Arc::new(HeldEntry::from_read(&after).unwrap()));
    assert!(
        !replay.matches(&state).unwrap(),
        "different served number bytes must not pass the private equality proof"
    );
}

#[tokio::test]
async fn serialized_replay_size_on_large_session() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let mut state = rig.state();
    let mut engine = state.engine_with_baselines().unwrap();
    let produced = engine.last_produced.as_mut().unwrap();
    // Ten thousand 1 KiB messages stand for a long, mostly uncompacted tail.
    produced.replacement = (0..10_000)
        .map(|_| ck_wire::CkWireMessage::synthetic_user_text("x".repeat(1024)))
        .collect();
    engine.last_applied = engine.last_produced.clone();
    state.adopt_engine(engine).unwrap();
    let before = serde_json::to_vec(&state).unwrap().len();
    let replay = Replay::capture(&state).unwrap().unwrap();
    let snapshot_bytes = serde_json::to_vec(&replay).unwrap().len();
    eprintln!("review replay size: ordinary_record={before} replay_snapshot={snapshot_bytes} messages=10000 text_bytes_per_message=1024");
    assert!(
        snapshot_bytes > 20_000_000,
        "both full engine views are serialized inline"
    );
}

#[tokio::test]
#[ignore = "large-session size measurement; run explicitly"]
async fn serialized_record_size_with_one_thousand_provider_messages() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = (0..1_000)
        .map(|n| {
            entry(
                n,
                if n % 2 == 0 { "user" } else { "assistant" },
                json!({"type":"text","text":format!("message {n}: {}", "x".repeat(1024))}),
                "large-run",
            )
        })
        .collect();
    rig.history(4, "frozen head for a large live tail");
    rig.notice(1, 8_000, None).await;
    let applied = rig.newest().unwrap();
    rig.notice(2, 8_000, Some(applied)).await;
    let mut state = rig.state();
    let before = serde_json::to_vec(&state).unwrap().len();
    state.reset_for_notice(rig.h.store.get().unwrap()).unwrap();
    let after = serde_json::to_vec(&state).unwrap().len();
    let replay = state
        .resync_sources
        .as_ref()
        .unwrap()
        .replay
        .as_ref()
        .unwrap();
    let replay_bytes = serde_json::to_vec(replay).unwrap().len();
    eprintln!("review real provider record: messages=1000 text_bytes_per_message=1024 ordinary_record={before} captured_record={after} replay_snapshot={replay_bytes}");
    assert!(
        after > before + 1_000_000,
        "the record now embeds both full view payloads"
    );
}

#[tokio::test]
async fn held_work_and_appends_survive_durable_replay_boundaries() {
    for boundary in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let (rig, applied) = held_drops(dir.path()).await;
        let pending = rig.pending_targets();
        let served = rig.get(applied).await;
        mismatch(&rig, 3).await;
        rig.runner.entries.lock().unwrap().push(entry(
            40,
            "user",
            json!({"type":"text","text":"appended prompt"}),
            "next-run",
        ));
        let expected = native_request_bytes(&rig, &served);
        let store = rig.h.store.get().unwrap();
        if boundary > 0 {
            let mut state = load(store, &rig.reference).unwrap().unwrap();
            rig.h
                .read_async(&mut state, 0, Duration::from_secs(10))
                .await
                .unwrap();
            state.resync = false;
            state.reindex().unwrap();
            state
                .restore_sources(store, codec::Codec::OwnedBroca)
                .unwrap();
            assert!(state.resync_replay_pending);
            if boundary > 1 {
                let rows = state.unsaved_tag_rows(codec::Codec::OwnedBroca).unwrap();
                state.save(store, &rows).unwrap();
            }
            if boundary > 2 {
                rig.h
                    .publish_async(0, &mut state, codec::Codec::OwnedBroca, false)
                    .unwrap()
                    .expect("insert reissued view before losing the working record");
            }
            // Discard the unsaved working record, as a process exit would.
            drop(state);
        }
        rig.h.resident_cache().forget(&rig.reference);
        rig.notice(4, 8_000, Some(applied)).await;
        let reissued = rig.get(rig.newest().unwrap()).await;
        assert!(reissued.view_version > applied, "boundary {boundary}");
        assert_eq!(rig.pending_targets(), pending, "boundary {boundary}");
        assert_request_eq(
            &native_request_bytes(&rig, &reissued),
            &expected,
            &format!("recovery at durable boundary {boundary}"),
        );
        assert!(!rig.state().resync_replay_pending);
    }
}

#[tokio::test]
async fn replay_pending_survives_open_tool_error_until_result_notice() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let served = rig.get(applied).await;
    let pending = rig.pending_targets();
    mismatch(&rig, 3).await;
    rig.runner.entries.lock().unwrap().push(entry(
        40,
        "assistant",
        json!({"type":"tool_call","tool_call_id":"open","tool_name":"read","input":{}}),
        "next-run",
    ));
    rig.notice(4, 8_000, Some(applied)).await;
    assert!(rig.state().resync_replay_pending);
    assert!(rig.state().engine_failed);
    assert!(
        rig.newest().is_none(),
        "reset cleared the publication map, and no reissue succeeded yet"
    );
    assert_eq!(
        rig.get(applied).await.digest,
        served.digest,
        "the old public view remains available"
    );
    rig.runner.entries.lock().unwrap().push(entry(41, "tool",
        json!({"type":"tool_result","tool_call_id":"open","output":{"kind":"text","text":"result"},"is_error":false}), "next-run"));
    let expected = native_request_bytes(&rig, &served);
    rig.notice(5, 8_000, Some(applied)).await;
    let reissued = rig.get(rig.newest().unwrap()).await;
    assert!(reissued.view_version > applied);
    assert_eq!(rig.pending_targets(), pending);
    assert_request_eq(
        &native_request_bytes(&rig, &reissued),
        &expected,
        "the tool result retries the reissue, not the held drops",
    );
    assert!(!rig.state().resync_replay_pending);
}

#[tokio::test]
async fn genuine_ride_consumes_pending_reissue_and_can_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    mismatch(&rig, 3).await;
    assert!(
        rig.ride("ceiling").await.is_none(),
        "rides refuse while resyncing"
    );
    let store = rig.h.store.get().unwrap();
    let mut state = load(store, &rig.reference).unwrap().unwrap();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
    assert!(state.resync_replay_pending);
    rig.h.checkin(state);
    let rebuilt = rig
        .ride("ceiling")
        .await
        .expect("genuine rebuild permission");
    assert!(rebuilt.view_version > applied);
    assert!(rig.pending_targets().is_empty());
    assert!(!rig.state().resync_replay_pending);
}

#[tokio::test]
async fn racing_notices_preserve_the_same_served_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let expected = native_request_bytes(&rig, &rig.get(applied).await);
    let pending = rig.pending_targets();
    mismatch(&rig, 3).await;
    tokio::join!(
        rig.notice(4, 8_000, Some(applied)),
        rig.notice(5, 8_000, Some(applied))
    );
    assert_eq!(rig.pending_targets(), pending);
    assert_request_eq(
        &native_request_bytes(&rig, &rig.get(rig.newest().unwrap()).await),
        &expected,
        "serialized concurrent notices preserve the old prefix",
    );
    assert!(!rig.state().resync_replay_pending);
}

#[tokio::test]
#[ignore = "requires MC_REVIEW_RECORD_PATH for the previous-reader job"]
async fn export_records_for_exact_previous_reader() {
    let path = std::env::var_os("MC_REVIEW_RECORD_PATH").expect("fixture destination");
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    mismatch(&rig, 3).await;
    let captured = serde_json::to_value(rig.state()).unwrap();
    assert!(captured["resync_sources"]["replay"].is_object());
    let store = rig.h.store.get().unwrap();
    let mut state = load(store, &rig.reference).unwrap().unwrap();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
    let pending = serde_json::to_value(&state).unwrap();
    assert_eq!(pending["resync_replay_pending"], true);
    std::fs::write(
        path,
        serde_json::to_vec(&json!([captured, pending])).unwrap(),
    )
    .unwrap();
}
