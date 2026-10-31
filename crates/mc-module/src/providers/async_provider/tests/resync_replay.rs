//! A completed run's notice can disagree with the caller-facing read digest.
//! Revalidating the same source prefix must not spend the model's prompt cache.
use super::*;

mod cache_recovery;
mod focused_review;
mod independent_review;

fn entry(n: u64, role: &str, content: Value, run: &str) -> ReadMessage {
    let mut entry = ReadMessage::new(n, format!("m{n}"), json!({"role":role,"content":[content]}))
        .with_tags(vec![tags::PartTag::tagged(
            format!("m{n}#0"),
            format!("§{}§", 100 + n * 3),
        )]);
    if role == "assistant" {
        entry.message["origin"] = json!({"provider_module_id":"openai","model_id":"gpt-test"});
    }
    entry.run = Some(
        serde_json::from_value(json!({
            "run_id":run,"episode":run,"final":n == 39
        }))
        .unwrap(),
    );
    entry
}

async fn source_rig(dir: &Path) -> Rig {
    let rig = Rig::open(
        dir,
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = (0..40).map(|n| {
        let (role, content) = match n % 4 {
            0 => ("user", json!({"type":"text","text":format!("request {n}")})),
            1 => ("assistant", json!({"type":"tool_call","tool_call_id":format!("c{n}"),"tool_name":"read","input":{"path":"f"}})),
            2 => ("tool", json!({"type":"tool_result","tool_call_id":format!("c{}",n-1),"output":{"kind":"text","text":"spent tool output ".repeat(500)},"is_error":false})),
            _ => ("assistant", json!({"type":"text","text":"final text"})),
        };
        entry(n, role, content, "old-run")
    }).collect();
    rig
}

async fn held_drops(dir: &Path) -> (Rig, u64) {
    let rig = source_rig(dir).await;
    rig.history(4, "published work from the previous run");
    rig.notice(1, 8_000, None).await;
    let baseline = rig
        .newest()
        .expect("history publication establishes a served view");
    rig.notice(2, 8_000, Some(baseline)).await;
    rig.queue(&[118, 130, 142]).await;
    (rig, baseline)
}

async fn closing_mismatch(rig: &Rig) {
    // Model the runner's native notice-anchor hash, while descriptor reads
    // expose the same stateful block as plain text.
    let mut native = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    native["content"][0] = json!({"type":"text_with_state","text":"final text",
        "provider_state":{"format":"open_ai_responses_chatgpt","data":"opaque"}});
    let digest = contract::digest::content_digest(&native);
    eprintln!(
        "source-derived notice input={} digest={digest}",
        String::from_utf8(serde_jcs::to_vec(&native).unwrap()).unwrap()
    );
    let inline = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    eprintln!(
        "source-derived descriptor input={} digest={}",
        String::from_utf8(serde_jcs::to_vec(&inline).unwrap()).unwrap(),
        contract::digest::content_digest(&inline)
    );
    assert_ne!(
        digest,
        contract::digest::content_digest(
            &rig.runner.entries.lock().unwrap().last().unwrap().message
        )
    );
    let notice = notice::AdvanceNotice::new(&rig.reference, 3, "L", 39, digest, 8_000, "fixture")
        .with_window(100_000);
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", 3),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };
    rig.h
        .advance_compaction_once("fixture", &message)
        .await
        .unwrap();
    assert!(
        rig.state().resync,
        "the mismatching notice still requires a full resync"
    );
    assert!(rig.state().resync_sources.is_some());
}

fn request_bytes(rig: &Rig, view: &view::CompactionView) -> Vec<u8> {
    let entries = rig.runner.entries.lock().unwrap();
    let mut messages = Vec::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                messages.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
            }
            view::ViewRange::Keep { from, to, edits } => {
                for entry in entries
                    .iter()
                    .filter(|entry| (*from..*to).contains(&entry.ordinal))
                {
                    let mut message = entry.message.clone();
                    let mut content = Vec::new();
                    for (part, tag) in message["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .zip(&entry.tags)
                    {
                        match edits
                            .iter()
                            .find(|edit| edit.ordinal == entry.ordinal && edit.part == tag.part)
                        {
                            Some(edit) if edit.drop => {}
                            Some(edit) => content
                                .push(serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap()),
                            None => content.push(part.clone()),
                        }
                    }
                    message["content"] = json!(content);
                    messages.push(message);
                }
            }
            _ => panic!("unknown range"),
        }
    }
    messages.extend(
        entries
            .iter()
            .filter(|entry| entry.ordinal > view.covers_through.ordinal)
            .map(|entry| entry.message.clone()),
    );
    serde_json::to_vec(&messages).unwrap()
}

fn last_decision(rig: &Rig) -> String {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn broca_new_run_after_identical_resync_defers_held_drops_at_eight_percent() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let pending = rig.pending_targets();
    let generation = rig.state().generation;
    let old_view = rig.get(baseline).await;
    let store = rig.h.store.get().unwrap();
    let namespace = rig.state().namespace();
    let mut serving = store.load(&namespace).unwrap();
    serving.meta.historian.firing_seq = 99;
    store
        .commit(
            &namespace,
            serving.row_version,
            &serving.core,
            &serving.meta,
        )
        .unwrap();
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap().push(entry(
        40,
        "user",
        json!({"type":"text","text":"next inbox prompt"}),
        "new-run",
    ));
    let expected = request_bytes(&rig, &old_view);
    rig.runner.reads.lock().unwrap().clear();
    rig.notice(4, 8_000, Some(baseline)).await;
    let version = rig.newest().expect("resync must reissue a view");
    assert!(
        version > baseline,
        "the contract still requires a higher version"
    );
    assert_eq!(
        rig.pending_targets(),
        pending,
        "resync alone must not land held drops"
    );
    assert!(
        rig.state().generation > generation,
        "resync still invalidates in-flight work"
    );
    assert!(
        store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .historian
            .firing_seq
            < 99,
        "serving-state replay must not transfer historian claim state"
    );
    assert_eq!(
        request_bytes(&rig, &rig.get(version).await),
        expected,
        "the next request keeps the exact served prefix and appends only the new prompt"
    );
    assert_eq!(rig.runner.read_starts()[0], 0, "the full resync still runs");
    let decision = last_decision(&rig);
    assert!(decision.starts_with("async decision defer "), "{decision}");
    assert!(decision.contains("usage=8.0%"), "{decision}");
    assert!(!decision.contains("+rebuild"), "{decision}");
    rig.notice(5, 8_000, Some(version)).await;
    assert_eq!(
        rig.newest(),
        Some(version),
        "an ordinary notice does not reissue again"
    );
    assert_eq!(rig.pending_targets(), pending);
}

#[tokio::test]
async fn changed_source_resync_still_rebuilds_and_lands_held_drops() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let generation = rig.state().generation;
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap()[15].message["content"][0]["text"] =
        json!("rewritten source");
    rig.notice(4, 8_000, Some(baseline)).await;
    assert!(rig.state().generation > generation);
    assert!(rig.newest().unwrap() > baseline);
    assert!(
        rig.pending_targets().is_empty(),
        "a changed prefix remains a rebuild"
    );
    let decision = last_decision(&rig);
    assert!(
        decision.starts_with("async decision execute "),
        "{decision}"
    );
    assert!(decision.contains("+rebuild"), "{decision}");
}

#[tokio::test]
async fn genuine_lineage_change_revalidates_and_rebuilds_once() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let generation = rig.state().generation;
    *rig.runner.lineage.lock().unwrap() = "new-lineage".into();
    rig.notice(3, 8_000, None).await;
    let version = rig.newest().unwrap();
    assert!(version > baseline);
    assert!(rig.state().generation > generation);
    assert_eq!(rig.state().last_transferred_drops, 3);
    assert!(rig.pending_targets().is_empty());
    assert!(last_decision(&rig).contains("+rebuild"));
    rig.queue(&[154]).await;
    let pending = rig.pending_targets();
    rig.notice(4, 8_000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
    assert_eq!(rig.pending_targets(), pending);
    assert!(last_decision(&rig).starts_with("async decision defer "));
}

#[tokio::test]
async fn unapplied_work_waits_for_a_real_rebuild_after_reissue() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let expected = request_bytes(&rig, &rig.get(applied).await);
    let unapplied = rig.ride("ceiling").await.unwrap();
    assert_ne!(request_bytes(&rig, &unapplied), expected);
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, Some(applied)).await;
    let reissued = rig.newest().unwrap();
    assert_eq!(request_bytes(&rig, &rig.get(reissued).await), expected);
    assert!(last_decision(&rig).starts_with("async decision defer "));
    let rebuilt = rig
        .ride("ceiling")
        .await
        .expect("a real rebuild can carry held produced work");
    assert!(rebuilt.view_version > reissued);
    assert_ne!(request_bytes(&rig, &rebuilt), expected);
    assert!(last_decision(&rig).contains("+rebuild"));
}

#[tokio::test]
async fn an_acknowledgement_received_during_resync_selects_the_applied_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let produced = rig.ride("ceiling").await.unwrap();
    let expected = request_bytes(&rig, &produced);
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, Some(produced.view_version)).await;
    let reissued = rig.newest().unwrap();
    assert!(reissued > produced.view_version);
    assert_eq!(request_bytes(&rig, &rig.get(reissued).await), expected);
    assert!(last_decision(&rig).starts_with("async decision defer "));
    assert!(!last_decision(&rig).contains("+rebuild"));
}

#[tokio::test]
async fn setup_only_reissue_preserves_the_initial_rendering_and_raw_appends() {
    let dir = tempfile::tempdir().unwrap();
    let rig = source_rig(dir.path()).await;
    rig.notice(1, 8_000, None).await;
    assert!(rig.newest().is_none());
    let initial = rig.state().initial["initial"].clone();
    assert_eq!(initial["range"], json!({"from":0,"to":0}));
    rig.queue(&[118, 130, 142]).await;
    let pending = rig.pending_targets();
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap().push(entry(
        40,
        "user",
        json!({"type":"text","text":"next prompt"}),
        "next-run",
    ));
    let mut expected: Vec<Value> = decode(&initial["replacement"]).unwrap();
    expected.extend(
        rig.runner
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|entry| entry.message.clone()),
    );
    rig.notice(4, 8_000, None).await;
    let reissued = rig
        .get(rig.newest().expect("resync publishes its first view"))
        .await;
    assert_eq!(
        request_bytes(&rig, &reissued),
        serde_json::to_vec(&expected).unwrap()
    );
    assert_eq!(rig.pending_targets(), pending);
    assert!(last_decision(&rig).starts_with("async decision defer "));
}

#[tokio::test]
async fn a_saved_reissue_is_not_skipped_for_an_already_completed_notice() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let expected = request_bytes(&rig, &rig.get(applied).await);
    let unapplied = rig.ride("ceiling").await.unwrap().view_version;
    closing_mismatch(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = load(store, &rig.reference).unwrap().unwrap();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
    assert!(state.resync_replay_pending);
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        4,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        8_000,
        "fixture",
    )
    .with_window(100_000)
    .with_applied_view_version(applied);
    state.conditions = Some(notice.to_headers());
    state.seq = 4;
    state.completed_seq = 4;
    state.save(store, &[]).unwrap();
    rig.h.resident_cache().forget(&rig.reference);
    rig.notice(4, 8_000, Some(applied)).await;
    let reissued = rig.newest().unwrap();
    assert!(
        reissued > unapplied,
        "completion must not swallow an owed reissue"
    );
    assert_eq!(request_bytes(&rig, &rig.get(reissued).await), expected);
    assert!(!rig.state().resync_replay_pending);
    assert!(last_decision(&rig).starts_with("async decision defer "));
}

#[tokio::test]
async fn a_late_acknowledgement_supersedes_a_stale_transport_reissue() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let produced = rig.ride("ceiling").await.unwrap();
    let expected = request_bytes(&rig, &produced);
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, Some(applied)).await;
    let old_reissue = rig.newest().unwrap();
    rig.notice(5, 8_000, Some(produced.view_version)).await;
    let reissued = rig.newest().unwrap();
    assert!(reissued > old_reissue);
    assert_eq!(request_bytes(&rig, &rig.get(reissued).await), expected);
    assert!(last_decision(&rig).starts_with("async decision defer "));
    assert!(!last_decision(&rig).contains("+rebuild"));
}

#[tokio::test]
async fn an_omitted_acknowledgement_does_not_reissue_setup_over_an_acknowledged_view() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let expected = request_bytes(&rig, &rig.get(applied).await);
    let pending = rig.pending_targets();
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, None).await;
    let reissued = rig.newest().unwrap();
    assert!(reissued > applied);
    assert_eq!(request_bytes(&rig, &rig.get(reissued).await), expected);
    assert_eq!(rig.pending_targets(), pending);
    assert!(last_decision(&rig).starts_with("async decision defer "));
}

async fn direct_matching_notice(rig: &Rig, seq: u64, applied: Option<u64>, lineage: &str) {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let mut notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        lineage,
        last.ordinal,
        contract::digest::content_digest(&last.message),
        8_000,
        "fixture",
    )
    .with_window(100_000);
    if let Some(applied) = applied {
        notice = notice.with_applied_view_version(applied);
    }
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };
    rig.h.advance_compaction("fixture", &message).await.unwrap();
}

#[tokio::test]
async fn an_announced_legacy_applied_snapshot_refuses_once_and_recovers_once() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = held_drops(dir.path()).await;
    let applied = rig.ride("ceiling").await.unwrap().view_version;
    assert_eq!(
        applied, 2,
        "the legacy fixture's applied row is version two"
    );
    rig.notice(3, 8_000, Some(applied)).await;
    let store = rig.h.store.get().unwrap();
    let before = rig.state();
    let generation = before.generation;
    let core_version = store.load(&before.namespace()).unwrap().row_version;
    let mut request = before.setup.clone();
    // Views live in the per-session layout; the inspection connection exposes
    // them under their legacy table names.
    let conn = crate::providers::async_provider::inspection_sql(dir.path().join("store.db"));
    // The layout's INSTEAD OF trigger reports no changed rows, so read the
    // row back to prove the update landed.
    conn.execute("UPDATE mc_async_compaction_views SET engine_json=NULL,announced=1 WHERE session_ref=?1 AND version=?2",
        rusqlite::params![rig.reference, applied]).unwrap();
    let (engine, announced): (Option<String>, i64) = conn
        .query_row(
            "SELECT engine_json, announced FROM mc_async_compaction_views WHERE session_ref=?1 AND version=?2",
            rusqlite::params![rig.reference, applied],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (engine, announced),
        (None, 1),
        "the legacy snapshot row is in place"
    );
    rig.h.resident_cache().forget(&rig.reference);
    for seq in 4..=6 {
        direct_matching_notice(&rig, seq, Some(applied), "L").await;
    }
    let blocked = rig.state();
    assert_eq!(blocked.snapshot_unavailable, Some(applied));
    assert!(blocked.snapshot_warning_logged);
    assert!(!blocked.snapshot_recovery_used);
    assert_eq!(blocked.generation, generation);
    assert_eq!(
        store.load(&blocked.namespace()).unwrap().row_version,
        core_version,
        "blocked notices do not rerun or rebuild the engine"
    );
    let binding = rig.h.async_binding(&blocked);
    let refusal = rig
        .h
        .async_ride(
            &binding,
            &json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000}),
        )
        .await
        .unwrap_err();
    let HandlerOutcome::Error { code, message } = refusal else {
        panic!("{refusal:?}");
    };
    assert_eq!(code, "applied_snapshot_unavailable");
    assert!(message.contains("snapshot is unavailable"));
    assert!(message.contains("compaction.setup"));
    request.request_id = "same-lineage-retry".into();
    let refused = rig
        .op("compaction.setup", serde_json::to_value(&request).unwrap())
        .await;
    assert_eq!(refused["answer"], "refuse");
    assert_eq!(refused["code"], "applied_snapshot_unavailable");
    assert_eq!(rig.state().generation, generation);

    *rig.runner.lineage.lock().unwrap() = "snapshot-recovered".into();
    request.lineage_id = Some("snapshot-recovered".into());
    request.request_id = "snapshot-recovery".into();
    let passes_before = resident::counters::read().engine_passes;
    let ready = rig
        .op("compaction.setup", serde_json::to_value(&request).unwrap())
        .await;
    assert_eq!(ready["answer"], "ready", "{ready}");
    let recovered = rig.state();
    assert!(
        recovered.generation > generation,
        "cut stages may already reserve intervening generations"
    );
    assert_eq!(
        resident::counters::read().engine_passes - passes_before,
        1,
        "fresh Setup runs one recovery engine pass"
    );
    assert!(recovered.snapshot_recovery_used);
    assert!(recovered.snapshot_warning_logged);
    assert!(recovered.snapshot_unavailable.is_none());
    let recovered_core = store.load(&recovered.namespace()).unwrap().row_version;
    for _ in 0..3 {
        assert_eq!(
            rig.op("compaction.setup", serde_json::to_value(&request).unwrap())
                .await["answer"],
            "ready"
        );
    }
    assert_eq!(rig.state().generation, recovered.generation);
    assert_eq!(
        resident::counters::read().engine_passes - passes_before,
        1,
        "repeated Setup does not rerun recovery"
    );
    assert_eq!(
        store.load(&recovered.namespace()).unwrap().row_version,
        recovered_core
    );
    rig.notice(7, 8_000, None).await;
    let version = rig.newest();
    rig.notice(8, 8_000, None).await;
    assert_eq!(
        rig.newest(),
        version,
        "ordinary notices do not repeat recovery"
    );
    direct_matching_notice(&rig, 5, Some(applied), "L").await;
    assert_eq!(
        rig.state().generation,
        recovered.generation,
        "stale pre-recovery notices cannot restart recovery"
    );

    let mut state = rig.state();
    state.resync_replay_pending = true;
    let current =
        crate::providers::async_provider::resync_replay::reissue_applied(store, &mut state, false)
            .unwrap()
            .expect("a transport alias provides a current snapshot for the second corruption");
    state.save(store, &[]).unwrap();
    rig.h.checkin(state);
    rig.notice(9, 8_000, Some(current.view_version)).await;
    conn.execute("UPDATE mc_async_compaction_views SET engine_json=NULL,announced=1 WHERE session_ref=?1 AND version=?2",
        rusqlite::params![rig.reference, current.view_version]).unwrap();
    rig.h.resident_cache().forget(&rig.reference);
    direct_matching_notice(&rig, 10, Some(current.view_version), "snapshot-recovered").await;
    request.lineage_id = Some("would-loop".into());
    request.request_id = "second-recovery".into();
    let refused = rig
        .op("compaction.setup", serde_json::to_value(&request).unwrap())
        .await;
    assert_eq!(refused["code"], "applied_snapshot_unavailable");
    assert!(refused["reason"].as_str().unwrap().contains("already used"));
    assert_eq!(rig.state().generation, recovered.generation);
}
