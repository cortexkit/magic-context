//! Independent cache review of the contract update that brought
//! compaction-provider 0.7.2's `account_change` and llm-runner's archive
//! pruning (pruned-reasoning re-reads) to the async provider.
//!
//! Each test here states the behaviour the cache rules require. Each fails
//! on commit 0ea4f2dd, the commit that added `account_change` rides and
//! pruned-reasoning re-reads; each test's comment says why.
//!
//! Ported to compaction-provider 0.7.3 unchanged in intent: the fake runner
//! now reports each prune as llm-runner's prune state does (a generation on
//! `session.head`, on pages and on every notice), so `serve_pruned` raises
//! the generation and `try_notice` carries it.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::kinds;

const ACCOUNT: &str = "Route_1.a-b";

/// The newest held message of the fixture. A notice re-reads only the newest
/// held entry (`State::read_from`), so this is the one message whose pruning
/// ck-mc can notice.
const PRUNED_ORDINAL: u64 = 39;

/// Give message 39 a reasoning part before its tagged text part, as an
/// assistant message with thinking has. Returns the original reasoning part,
/// the original text part and the message as served after the runner prunes
/// its reasoning at rest.
fn reasoning_fixture(rig: &Rig) -> (Value, Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries
        .iter_mut()
        .find(|entry| entry.ordinal == PRUNED_ORDINAL)
        .unwrap();
    let reasoning = json!({"id":"p39r","type":"reasoning","text":"weighing which file to read next","metadata":{"anthropic":{"signature":"invented-signature-39"}}});
    let text = entry.message["parts"][0].clone();
    entry.message["parts"] = json!([reasoning.clone(), text.clone()]);
    entry.tags = vec![
        tags::PartTag::untagged("0"),
        tags::PartTag::tagged("1", format!("§{}§", 100 + PRUNED_ORDINAL * 3)),
    ];
    let mut pruned = entry.message.clone();
    // As llm-runner's rule writes the pruned part.
    pruned["parts"][0] = cortexkit_role_llm_runner::archive_prunes_reasoning::prune_part_in(
        "opencode-aisdk",
        kinds::REASONING,
        &reasoning,
    )
    .unwrap();
    (reasoning, text, pruned)
}

/// Serve message 39 as `served`, listing part `part` in the page's
/// `pruned_reasoning` as `kind` with the write-time digest of `original`,
/// and raise the runner's prune generation.
fn serve_pruned(rig: &Rig, served: Value, part: &str, kind: &str, original: &Value) {
    rig.runner.prune(
        PRUNED_ORDINAL,
        served,
        vec![json!({
            "mid": format!("m{PRUNED_ORDINAL}"),
            "part": part,
            "kind": kind,
            "bytes": serde_jcs::to_vec(original).unwrap().len() as u64,
            "sha256": contract::digest::content_digest(original),
        })],
    );
}

/// Forty messages read at low usage, message 39 with reasoning, and three
/// tool results queued for dropping: cleanup a rebuild lands and a
/// low-usage notice defers.
async fn pruning_rig(dir: &Path) -> (Rig, Value, Value, Value) {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    let (reasoning, text, pruned) = reasoning_fixture(&rig);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    rig.queue(&[163, 166, 169]).await;
    (rig, reasoning, text, pruned)
}

/// Publish notice `seq` as `Rig::notice` does, but report whether it
/// completed within ten seconds instead of panicking.
async fn try_notice(rig: &Rig, seq: u64, size: u64, applied: Option<u64>) -> bool {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let mut notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        rig.runner.lineage.lock().unwrap().clone(),
        last.ordinal,
        contract::digest::content_digest(&last.message),
        size,
        "fixture",
    )
    .with_window(100_000);
    if let Some(version) = applied {
        notice = notice.with_applied_view_version(version);
    }
    if let Some(state) = rig.runner.prune_state() {
        notice = notice.with_reasoning_pruned(state);
    }
    let headers = notice.to_headers();
    let _ = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", seq),
            notice.digest().parse().unwrap(),
            headers,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !(rig.state().completed_seq >= seq
            && rig
                .h
                .provider_store
                .async_runtime
                .completed_notice
                .load(std::sync::atomic::Ordering::Relaxed)
                >= seq)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

fn replaces(view: &view::CompactionView, ordinal: u64) -> bool {
    view.ranges.iter().any(|range| {
        matches!(range, view::ViewRange::Replace { from, to, .. } if *from <= ordinal && ordinal < *to)
    })
}

/// The engine-side facts a block identity drift is judged on, for failure
/// messages: the coverage ordinal, the boundary and the frozen units naming
/// message 39.
fn drift_facts(rig: &Rig) -> String {
    let loaded = rig
        .h
        .store
        .get()
        .unwrap()
        .load(&rig.state().namespace())
        .unwrap();
    let units = loaded
        .core
        .frozen_units
        .iter()
        .map(|unit| unit.key.clone())
        .filter(|key| key.contains(&format!("m{PRUNED_ORDINAL}")))
        .collect::<Vec<_>>();
    format!(
        "coverage_ordinal={:?} boundary={:?} units_on_m39={units:?}",
        loaded.meta.coverage_ordinal, loaded.core.boundary_id
    )
}

/// Run one engine pass outside any notice and return its error, if any. The
/// record is not checked back in or saved.
fn engine_pass_error(rig: &Rig) -> Option<HandlerOutcome> {
    let mut probe = rig
        .h
        .checkout(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .unwrap();
    let codec = codec::Codec::from_params(&Value::Object(probe.setup.params.clone())).unwrap();
    rig.h.publish_async(0, &mut probe, codec, false).err()
}

/// The runner writes message `ordinal`, a user message in the fill's shape.
fn append_user_message(rig: &Rig, ordinal: u64) {
    rig.runner.entries.lock().unwrap().push(
        ReadMessage::new(
            ordinal,
            format!("m{ordinal}"),
            json!({"info":{"id":format!("m{ordinal}"),"role":"user","time":{"created":1}},"parts":[{"id":format!("p{ordinal}"),"type":"text","text":format!("message {ordinal} ")+&"durable words ".repeat(16)}]}),
        )
        .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 100 + ordinal * 3))]),
    );
}

/// A session whose last view already covers its newest message (the usual
/// state of a session that was active and then archived) has that message's
/// reasoning pruned at rest. The next notice re-reads the message, accepts
/// the pruned copy and must go on: one rebuild, and later notices and rides
/// keep working.
///
/// As of commit 0ea4f2dd the accepted copy changes the message's block
/// identity under the engine, which recorded the original identity when the
/// view was built. The forced rebuild fails with "CK message block identity
/// drift for mid m39" (a transient error, so `engine_failed` and
/// `pruned_rebuild_pending` both stay set), and so does every later engine
/// pass: later notices never complete and rides fail. Before this change
/// the same re-read was refused and the session re-read from scratch, which
/// recovered.
#[tokio::test]
async fn pruned_reread_of_a_covered_message_keeps_the_session_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, reasoning, _, pruned) = pruning_rig(dir.path()).await;
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
        )
        .await;
    assert_eq!(answer["answer"], "view", "{answer}");
    let view: view::CompactionView = decode(&answer["view"]).unwrap();
    assert_eq!(view.covers_through.ordinal, PRUNED_ORDINAL);
    assert!(
        !replaces(&view, PRUNED_ORDINAL),
        "message 39 goes out as the runner's own bytes"
    );
    assert!(
        try_notice(&rig, 2, 1_000, Some(view.view_version)).await,
        "the view is acknowledged"
    );
    let facts = drift_facts(&rig);
    serve_pruned(&rig, pruned, "0", kinds::REASONING, &reasoning);
    let resumed = try_notice(&rig, 3, 1_000, Some(view.view_version)).await;
    append_user_message(&rig, 40);
    let later = try_notice(&rig, 4, 1_000, Some(view.view_version)).await;
    let ride = rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.ride","params":{"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}}),
        )
        .await;
    let state = rig.state();
    let (engine_failed, pending) = (state.engine_failed, state.pruned_rebuild_pending);
    assert!(
        resumed && later && !engine_failed && matches!(ride, HandlerOutcome::Response(_)),
        "the session stopped publishing after a pruned re-read: notice 3 completed={resumed}, \
         notice 4 completed={later}, engine_failed={engine_failed}, pruned_rebuild_pending={pending}, \
         ride={ride:?}, engine pass error={:?}, before pruning {facts}",
        engine_pass_error(&rig),
    );
}

/// An archived session resumes. The runner pruned message 39's reasoning at
/// rest, then picks a new account before the first request and rides
/// `account_change`: that ride is the one cache-loss rebuild, and it lands
/// the pending cleanup. Message 39 is in no Replace range, so the runner
/// renders its own (pruned) bytes for it and the request writes the new
/// account's cache over exactly what it sent.
///
/// The notice that follows re-reads message 39 and accepts the pruned copy.
/// Nothing about the runner's cache changed since the ride: it was written
/// after the pruning, with the pruned bytes. A second rebuild here only lands
/// the cleanup the response queued and rewrites a cache that is already
/// warm, which the control session (no pruning) shows a notice at this usage
/// does not do.
///
/// As of commit 0ea4f2dd `pruned_rebuild_pending` turns that notice into a
/// rebuild unconditionally. Today that rebuild fails first (see
/// `pruned_reread_of_a_covered_message_keeps_the_session_publishing`), so
/// this test stops at the notice not completing; once that is fixed it
/// checks that the notice publishes no second view.
#[tokio::test]
async fn pruned_reread_after_an_account_change_ride_does_not_rebuild_again() {
    let dir = tempfile::tempdir().unwrap();
    let control_dir = tempfile::tempdir().unwrap();
    let (rig, reasoning, _, pruned) = pruning_rig(dir.path()).await;
    let (control, _, _, _) = pruning_rig(control_dir.path()).await;
    serve_pruned(&rig, pruned, "0", kinds::REASONING, &reasoning);
    let mut ridden = Vec::new();
    for side in [&rig, &control] {
        let answer = side
            .op(
                "compaction.ride",
                json!({"session_ref":side.reference,"cause":"account_change","account":ACCOUNT,"deadline_ms":10_000}),
            )
            .await;
        assert_eq!(answer["answer"], "view", "{answer}");
        let view: view::CompactionView = decode(&answer["view"]).unwrap();
        assert!(
            !replaces(&view, PRUNED_ORDINAL),
            "message 39 goes out as the runner's own bytes"
        );
        assert_eq!(side.newest(), Some(view.view_version));
        ridden.push(view.view_version);
        // The response the request produced queues one more drop.
        side.queue(&[178]).await;
        assert!(
            try_notice(side, 2, 1_000, Some(view.view_version)).await,
            "notice 2 did not complete on the {} side",
            if std::ptr::eq(side, &rig) {
                "pruned"
            } else {
                "control"
            }
        );
    }
    assert_eq!(
        control.newest(),
        Some(ridden[1]),
        "without pruning the notice after the ride defers"
    );
    assert_eq!(
        rig.newest(),
        Some(ridden[0]),
        "the ride already rebuilt after the pruning; the notice must not rebuild a second time"
    );
}

#[tokio::test]
async fn chain_reset_lands_cleanup_like_ttl_and_does_not_rebuild_again_after_pruning() {
    let ttl_dir = tempfile::tempdir().unwrap();
    let reset_dir = tempfile::tempdir().unwrap();
    let (ttl, ttl_reasoning, _, ttl_pruned) = pruning_rig(ttl_dir.path()).await;
    let (reset, reset_reasoning, _, reset_pruned) = pruning_rig(reset_dir.path()).await;
    serve_pruned(&ttl, ttl_pruned, "0", kinds::REASONING, &ttl_reasoning);
    serve_pruned(
        &reset,
        reset_pruned,
        "0",
        kinds::REASONING,
        &reset_reasoning,
    );
    let ttl_view = ttl.ride("ttl_expired").await.expect("TTL cache-loss ride");
    let reset_view = reset
        .ride("chain_reset")
        .await
        .expect("predictable full-resend ride");
    assert_eq!(reset_view.ranges, ttl_view.ranges);
    assert_eq!(reset.render(&reset_view), ttl.render(&ttl_view));
    assert_eq!(reset.state().cache_ttl(), ttl.state().cache_ttl());
    for (rig, view) in [(&ttl, ttl_view), (&reset, reset_view)] {
        assert!(
            rig.pending_targets().is_empty(),
            "the ride must land queued cleanup"
        );
        // The response to the full resend queues new cleanup while its cache is warm.
        rig.queue(&[178]).await;
        let pending = rig.pending_targets();
        assert!(try_notice(rig, 2, 1_000, Some(view.view_version)).await);
        assert_eq!(
            rig.newest(),
            Some(view.view_version),
            "prune reconciliation must not cause a second rebuild"
        );
        assert_eq!(rig.pending_targets(), pending);
        assert!(try_notice(rig, 3, 1_000, Some(view.view_version)).await);
        assert_eq!(
            rig.newest(),
            Some(view.view_version),
            "quiet notices must keep the cache warm"
        );
        assert_eq!(rig.pending_targets(), pending);
    }
    let lines = reset
        .h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.contains("+rebuild"))
            .count(),
        1,
        "{lines:#?}"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("ride cause=chain_reset")),
        "{lines:#?}"
    );
}

/// The `signature` kind removes a signature from a non-reasoning part; the
/// llm-runner contract (§9.14.1) keeps that part's text byte-identical and
/// says "a `signature`-kind text part keeps its number and its exact text".
/// A re-read listing the tagged text part of message 39 as `signature`, with
/// its write-time digest, but serving rewritten text is therefore not a
/// pruning and must be refused as a changed transcript.
///
/// As of commit 0ea4f2dd `pruned_reread::accepts` checks only that a listed
/// part keeps its index and type, so it accepts the rewritten text into the
/// held copy and the stored row.
#[tokio::test]
async fn pruned_signature_listing_cannot_rewrite_tagged_text() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _, text, _) = pruning_rig(dir.path()).await;
    let mut served = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .iter()
        .find(|entry| entry.ordinal == PRUNED_ORDINAL)
        .unwrap()
        .message
        .clone();
    served["parts"][1]["text"] = json!("text the model never wrote");
    serve_pruned(&rig, served, "1", kinds::SIGNATURE, &text);
    let mut state = rig.state();
    let from = state.read_from();
    let read = rig
        .h
        .read_async_resumable(&mut state, from, Duration::from_secs(5))
        .await;
    match read {
        Err(HandlerOutcome::Error { message, .. }) => {
            assert_eq!(message, "async entry changed on re-read")
        }
        other => panic!(
            "a rewritten text part was accepted as pruning: {:?}; pruned_rebuild_pending={}",
            other.map(|_| ()),
            state.pruned_rebuild_pending
        ),
    }
}
