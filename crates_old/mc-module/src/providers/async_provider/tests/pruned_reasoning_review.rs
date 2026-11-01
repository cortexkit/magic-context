//! Independent cache review of ck-mc's support for runner archive pruning
//! (llm-runner 0.7.12 §9.14 / §9.14.1, compaction-provider 0.7.5 §4, §5.2
//! and §7) and of the change that completes a notice arriving through an
//! open tool call.
//!
//! Two kinds of test live here. The evidence tests assert behaviour the
//! async provider already has. The tests named `finding_*` assert behaviour
//! it lacks as of commit f838379b: each one fails there, and its comment
//! says why.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::{
    self as prune_rules, kinds, PrunedPartAt,
};

const PROFILE: &str = "opencode-aisdk";

/// A `pruned_reasoning` page row for part `part` of message `ordinal`,
/// carrying the write-time digest of `original`.
fn row(ordinal: u64, part: &str, kind: &str, original: &Value) -> Value {
    json!({
        "mid": format!("m{ordinal}"),
        "part": part,
        "kind": kind,
        "bytes": serde_jcs::to_vec(original).unwrap().len() as u64,
        "sha256": contract::digest::content_digest(original),
    })
}

/// Message `n` in the shape `Rig::fill` writes it.
fn fill_entry(n: u64) -> ReadMessage {
    let part = if !n.is_multiple_of(5) && n % 5 < 4 {
        json!({"id":format!("p{n}"),"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("file{n}")},"output":"exact spent output ".repeat(500)}})
    } else {
        json!({"id":format!("p{n}"),"type":"text","text":format!("message {n} ")+&"durable words ".repeat(16)})
    };
    ReadMessage::new(
        n,
        format!("m{n}"),
        json!({"info":{"id":format!("m{n}"),"role":if n.is_multiple_of(5){"user"}else{"assistant"},"time":{"created":1}},"parts":[part]}),
    )
    .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 100 + n * 3))])
}

/// Give OpenCode message `ordinal` a signed reasoning part before its one
/// tagged part. Returns the original reasoning part and the message as the
/// runner serves it after a `reasoning` prune (llm-runner's own rule).
fn with_reasoning(rig: &Rig, ordinal: u64) -> (Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries.iter_mut().find(|e| e.ordinal == ordinal).unwrap();
    let reasoning = json!({"id":format!("p{ordinal}r"),"type":"reasoning","text":format!("weighing step {ordinal}"),"metadata":{"anthropic":{"signature":format!("invented-signature-{ordinal}")}}});
    let part = entry.message["parts"][0].clone();
    entry.message["parts"] = json!([reasoning.clone(), part]);
    let tag = entry.tags[0].tag.clone().unwrap();
    entry.tags = vec![
        tags::PartTag::untagged("0"),
        tags::PartTag::tagged("1", tag),
    ];
    let mut pruned = entry.message.clone();
    pruned["parts"][0] = prune_rules::prune_part_in(PROFILE, kinds::REASONING, &reasoning).unwrap();
    (reasoning, pruned)
}

/// Give OpenCode tool message `ordinal` a Gemini call thought signature in
/// its part metadata, and a tagged text part after the call, so the message
/// stays when the call is dropped. Returns the original tool part and the message as the runner serves it
/// after a `signature` prune (llm-runner's own rule).
fn with_call_signature(rig: &Rig, ordinal: u64) -> (Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries.iter_mut().find(|e| e.ordinal == ordinal).unwrap();
    assert_eq!(entry.message["parts"][0]["type"], "tool");
    entry.message["parts"][0]["metadata"] =
        json!({"google":{"thoughtSignature":format!("invented-call-signature-{ordinal}")}});
    entry.message["parts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":format!("p{ordinal}t"),"type":"text","text":format!("read file {ordinal} ")+&"careful words ".repeat(8)}));
    entry.tags.push(tags::PartTag::tagged(
        "1",
        format!("§{}§", 100 + ordinal * 3 + 1),
    ));
    let original = entry.message["parts"][0].clone();
    let mut pruned = entry.message.clone();
    pruned["parts"][0] = prune_rules::prune_part_in(PROFILE, kinds::SIGNATURE, &original).unwrap();
    (original, pruned)
}

/// Give OpenCode text message `ordinal` a Gemini thought signature in its
/// part metadata. Dropping its text re-serializes the whole part in an edit.
/// Returns the original text part and the message as the runner serves it
/// after a `signature` prune (llm-runner's own rule).
fn with_text_signature(rig: &Rig, ordinal: u64) -> (Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries.iter_mut().find(|e| e.ordinal == ordinal).unwrap();
    assert_eq!(entry.message["parts"][0]["type"], "text");
    entry.message["parts"][0]["metadata"] =
        json!({"google":{"thoughtSignature":format!("invented-text-signature-{ordinal}")}});
    let original = entry.message["parts"][0].clone();
    let mut pruned = entry.message.clone();
    pruned["parts"][0] = prune_rules::prune_part_in(PROFILE, kinds::SIGNATURE, &original).unwrap();
    (original, pruned)
}

/// The Setup a runner calls after a prune: the session's own Setup carrying
/// the head's prune state.
fn setup_after_prune_request(rig: &Rig) -> Value {
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["request_id"] = json!("setup-after-prune");
    request["reasoning_pruned"] = serde_json::to_value(rig.runner.prune_state().unwrap()).unwrap();
    request
}

fn decision_lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

/// Every byte string a view sends in place of the runner's own bytes.
fn sent_bytes(view: &view::CompactionView) -> Vec<String> {
    let mut sent = Vec::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => sent.push(bytes.clone()),
            view::ViewRange::Keep { edits, .. } => {
                sent.extend(edits.iter().filter_map(|edit| edit.bytes.clone()))
            }
            _ => {}
        }
    }
    sent
}

/// Ride `cause` and return its view, if the pass published one. A ride that
/// finds the conversation busy answers `nothing` without running a pass
/// (and logs no decision); it is asked again, as a runner would on its next
/// request.
async fn ride_settled(rig: &Rig, cause: &str) -> Option<view::CompactionView> {
    for _ in 0..50 {
        let logged = decision_lines(rig).len();
        let answer = rig.ride(cause).await;
        if answer.is_some() || decision_lines(rig).len() > logged {
            return answer;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("ride {cause} never ran a pass")
}

/// `ride_settled`, failing with the decision log when nothing is published.
async fn ride_or_explain(rig: &Rig, cause: &str) -> view::CompactionView {
    match ride_settled(rig, cause).await {
        Some(view) => view,
        None => panic!(
            "ride {cause} published nothing; state: resync={} pending={} failed={} newest={:?}\n{:#?}",
            rig.state().resync,
            rig.state().pruned_rebuild_pending,
            rig.state().engine_failed,
            rig.newest(),
            decision_lines(rig)
        ),
    }
}

/// Publish notice `seq` and report whether it completed within ten seconds,
/// instead of panicking as `Rig::notice` does.
async fn try_notice_with(
    rig: &Rig,
    seq: u64,
    size: u64,
    applied: Option<u64>,
    events: Vec<notice::Event>,
) -> bool {
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
    if !events.is_empty() {
        notice = notice.with_events(events);
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

/// Messages whose reasoning part (part "0") the runner prunes with
/// `reasoning`.
const REASONED: [u64; 3] = [9, 19, 29];
/// The tool message whose Gemini call signature the runner prunes with
/// `signature`; its output is dropped before the prune, so a view edits it.
const SIGNED_CALL: u64 = 21;
/// The text message whose Gemini thought signature the runner prunes with
/// `signature`; its text is dropped before the prune, so an acknowledged
/// edit re-serializes the signed part.
const SIGNED_TEXT: u64 = 24;
/// The highest ordinal any prune here touches.
const THROUGH: u64 = 29;

/// Forty messages with signed reasoning on `REASONED`, a signed call on
/// `SIGNED_CALL` and signed text on `SIGNED_TEXT`. Returns, per pruned message, its ordinal, the prune kind,
/// the original part and the message as the runner serves it pruned.
fn prepare(rig: &Rig) -> Vec<(u64, &'static str, Value, Value)> {
    rig.fill(40);
    let mut prunes = Vec::new();
    for ordinal in REASONED {
        let (original, pruned) = with_reasoning(rig, ordinal);
        prunes.push((ordinal, kinds::REASONING, original, pruned));
    }
    let (original, pruned) = with_call_signature(rig, SIGNED_CALL);
    prunes.push((SIGNED_CALL, kinds::SIGNATURE, original, pruned));
    let (original, pruned) = with_text_signature(rig, SIGNED_TEXT);
    prunes.push((SIGNED_TEXT, kinds::SIGNATURE, original, pruned));
    prunes
}

/// A view as compared across the two sessions: everything but its version
/// and the digest that covers the version.
fn comparable(view: &view::CompactionView) -> Value {
    let mut value = serde_json::to_value(view).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("view_version");
    object.remove("digest");
    value
}

/// Check one view of the pruned session against llm-runner's reference for
/// restored content (`restored_by_edit_in`, `restored_part_in`) over the
/// runner's prune record, and by hand against every pruned string.
fn assert_restores_nothing(view: &view::CompactionView, record: &[PrunedPartAt], when: &str) {
    for (index, range) in view.ranges.iter().enumerate() {
        match range {
            view::ViewRange::Keep { edits, .. } => {
                for edit in edits {
                    let Some(bytes) = &edit.bytes else { continue };
                    let part: Value = serde_json::from_str(bytes).unwrap();
                    let restored = prune_rules::restored_by_edit_in(
                        PROFILE,
                        record,
                        edit.ordinal,
                        &edit.part,
                        &part,
                    )
                    .unwrap();
                    assert!(
                        restored.is_none(),
                        "{when}: edit restores {restored:?}: {bytes}"
                    );
                }
            }
            view::ViewRange::Replace { from, to, bytes } => {
                let messages: Value = serde_json::from_str(bytes).unwrap();
                let start = if index == 0 { 0 } else { *from };
                let restored =
                    prune_rules::restored_part_in(PROFILE, record, start..*to, &messages).unwrap();
                assert!(restored.is_none(), "{when}: replace restores {restored:?}");
            }
            _ => {}
        }
    }
    for bytes in sent_bytes(view) {
        for pruned in [
            "weighing step",
            "invented-signature",
            "invented-call-signature",
        ] {
            assert!(
                !bytes.contains(pruned),
                "{when}: {pruned:?} sent back: {bytes}"
            );
        }
    }
}

/// A session reconciled after a prune keeps compacting exactly like a
/// session that read the pruned transcript from the start. Two sessions run the
/// same notices, rides and drops in lockstep:
///
/// - the pruned session holds the original transcript through three engine
///   passes (rides, each acknowledged by a notice), then the runner prunes
///   three reasoning parts, one Gemini call signature and one Gemini text
///   signature at rest, calls the post-prune Setup and rides `ttl_expired`
///   before its first request;
/// - the control session is served the pruned bytes from its first read,
///   and is never pruned.
///
/// From the ride on, through twelve more turns (a new message, a drop, a
/// notice and a ride each), the pruned session never refuses a re-read,
/// never resets, never fails an engine pass, never reads a held copy again,
/// rebuilds only where the control session rebuilds (the ride is the
/// prune's one rebuild), decides exactly as the control session decides,
/// and serves exactly the view the control session serves: full processing
/// over the pruned transcript. No view published after the prune sends back
/// anything the prune removed, by llm-runner's reference and by hand (the
/// acknowledged edit dropping the signed text goes out with the pruned,
/// empty provider entry). The Setup's re-read stays at or below
/// `through_ordinal` and happens once for the generation.
///
/// Usage stays low throughout, so no historian job runs in the background:
/// its timing would make the two sessions' execute passes differ for
/// reasons unrelated to pruning.
#[tokio::test]
async fn a_session_keeps_compacting_after_a_prune_exactly_as_one_read_pruned() {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let pruned_rig = Rig::new(dir_a.path()).await;
    let control = Rig::new(dir_b.path()).await;
    let prunes = prepare(&pruned_rig);
    let control_prunes = prepare(&control);
    {
        let mut entries = control.runner.entries.lock().unwrap();
        for (ordinal, _, _, served) in &control_prunes {
            entries[*ordinal as usize].message = served.clone();
        }
    }
    let rigs = [&pruned_rig, &control];

    // Three engine passes over the original bytes (the control session's
    // are already pruned), each acknowledged by the next notice. Usage stays
    // low so no historian job runs in the background and both sessions
    // decide on the same inputs.
    for rig in rigs {
        rig.notice(1, 1_000, None).await;
        for (seq, (drop, cause)) in [
            (163, "model_change"),
            (172, "ttl_expired"),
            (169, "model_change"),
        ]
        .into_iter()
        .enumerate()
        {
            rig.queue(&[drop]).await;
            ride_settled(rig, cause).await;
            rig.notice(2 + seq as u64, 1_000, rig.newest()).await;
        }
    }
    assert_eq!(pruned_rig.newest(), control.newest());
    let before = pruned_rig.state();
    assert!(before.reasoning_pruned_generation().is_none());

    // The runner prunes at rest and calls the post-prune Setup.
    for (ordinal, kind, original, served) in &prunes {
        pruned_rig.runner.prune(
            *ordinal,
            served.clone(),
            vec![row(*ordinal, "0", kind, original)],
        );
    }
    let seen = pruned_rig.runner.prune_state().unwrap();
    assert_eq!((seen.generation, seen.through_ordinal), (5, THROUGH));
    let record = prunes
        .iter()
        .map(|(ordinal, kind, _, _)| PrunedPartAt::new(*ordinal, "0", *kind))
        .collect::<Vec<_>>();
    pruned_rig.runner.reads.lock().unwrap().clear();
    let answer = pruned_rig
        .op("compaction.setup", setup_after_prune_request(&pruned_rig))
        .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let reads = pruned_rig.runner.reads.lock().unwrap().clone();
    assert!(!reads.is_empty(), "the Setup re-reads the held copies");
    for params in &reads {
        let from = params["from_ordinal"].as_u64().unwrap();
        let limit = params["limit"].as_u64().unwrap();
        assert!(
            from + limit <= THROUGH + 1,
            "a re-read past through_ordinal: {params}"
        );
    }
    for (ordinal, _, _, served) in &prunes {
        assert_eq!(
            &pruned_rig.state().entries[ordinal].read().unwrap().message,
            served
        );
    }
    pruned_rig.runner.reads.lock().unwrap().clear();
    let again = pruned_rig
        .op("compaction.setup", setup_after_prune_request(&pruned_rig))
        .await;
    assert_eq!(again["answer"], "ready");
    assert!(
        pruned_rig.runner.reads.lock().unwrap().is_empty(),
        "a second Setup with the same generation re-reads nothing"
    );

    // The runner's cache expired while the session was archived: it rides
    // before its first request. The ride is the prune's one rebuild.
    let before_prune = pruned_rig.newest().unwrap();
    for rig in rigs {
        rig.queue(&[166]).await;
        ride_settled(rig, "ttl_expired").await;
    }
    assert!(
        !pruned_rig.state().pruned_rebuild_pending,
        "the ride took the rebuild"
    );
    // The pruned session's applied view still holds edits built from the
    // original bytes, so its rebuild publishes the same view over the
    // reconciled copies; the control session's applied view already is that
    // view, so its ride publishes nothing. From here on the two serve the
    // same view, the pruned session one version ahead.
    let offset = pruned_rig.newest().unwrap() - control.newest().unwrap();
    assert!(offset <= 1, "offset {offset}");
    assert_eq!(
        comparable(&pruned_rig.get(pruned_rig.newest().unwrap()).await),
        comparable(&control.get(control.newest().unwrap()).await),
        "after the ride the pruned session serves what full processing over the pruned transcript serves"
    );
    let decided = (
        decision_lines(&pruned_rig).len(),
        decision_lines(&control).len(),
    );

    // Twelve more turns: a new message, a drop on nine of them, the notice
    // acknowledging the newest view, and a ride.
    let drops = [26u64, 27, 28, 31, 32, 33, 36, 37, 38];
    let mut checked_views = BTreeSet::new();
    let mut text_edit_checked = false;
    for turn in 0..12u64 {
        let seq = 5 + turn;
        for rig in rigs {
            rig.runner
                .entries
                .lock()
                .unwrap()
                .push(fill_entry(40 + turn));
            if let Some(ordinal) = drops.get(turn as usize) {
                rig.queue(&[100 + ordinal * 3]).await;
            }
            let applied = rig.newest();
            rig.notice(seq, 1_000, applied).await;
            ride_settled(
                rig,
                if turn % 2 == 0 {
                    "ttl_expired"
                } else {
                    "model_change"
                },
            )
            .await;
        }
        assert_eq!(
            pruned_rig.newest().unwrap(),
            control.newest().unwrap() + offset,
            "turn {turn}: the two sessions published different numbers of views"
        );
        assert_eq!(
            comparable(&pruned_rig.get(pruned_rig.newest().unwrap()).await),
            comparable(&control.get(control.newest().unwrap()).await),
            "turn {turn}: the pruned session serves something other than full processing over the pruned transcript"
        );
        // Every view published since the prune restores nothing the prune
        // removed. (Views from before the prune stay immutable and are not
        // re-checked.)
        for version in (before_prune + 1)..=pruned_rig.newest().unwrap() {
            if !checked_views.insert(version) {
                continue;
            }
            let view = pruned_rig.get(version).await;
            assert_restores_nothing(&view, &record, &format!("turn {turn} view {version}"));
            // By hand: the signed text's dropped text goes out with the
            // pruned (empty) provider entry and the drop placeholder.
            if let Some(edit) = view
                .ranges
                .iter()
                .flat_map(|range| match range {
                    view::ViewRange::Keep { edits, .. } => edits.clone(),
                    _ => Vec::new(),
                })
                .find(|edit| edit.ordinal == SIGNED_TEXT && edit.bytes.is_some())
            {
                let bytes = edit.bytes.as_deref().unwrap();
                let part: Value = serde_json::from_str(bytes).unwrap();
                assert_eq!(part["metadata"], json!({"google":{}}), "{part}");
                assert!(bytes.contains(&format!("[dropped §{}§]", 100 + SIGNED_TEXT * 3)));
                text_edit_checked = true;
            }
        }
        let state = pruned_rig.state();
        assert!(!state.engine_failed && state.failure.is_none() && !state.resync);
        assert_eq!(
            state.generation, before.generation,
            "turn {turn}: the record was reset"
        );
        assert_eq!(state.lineage, before.lineage);
        assert_eq!(state.reasoning_pruned_generation(), Some(5));
        assert!(!state.pruned_rebuild_pending && state.pruned_readopt.is_empty());
        assert!(
            pruned_rig
                .runner
                .read_starts()
                .iter()
                .all(|start| *start >= 39),
            "turn {turn}: a held copy was read again: {:?}",
            pruned_rig.runner.read_starts()
        );
    }
    assert!(
        checked_views.len() >= 3,
        "too few views published after the prune to compare: {checked_views:?}"
    );
    assert!(
        text_edit_checked,
        "no view after the prune edits the signed text: {}",
        serde_json::to_string(&pruned_rig.get(pruned_rig.newest().unwrap()).await.ranges)
            .unwrap()
            .replace("exact spent output ", "")
    );
    assert_eq!(
        decision_lines(&pruned_rig)[decided.0..],
        decision_lines(&control)[decided.1..],
        "after the ride the pruned session decided differently from the control session"
    );

    // Exactly the control session's rebuilds: the prune added none of its own.
    let rebuilds = |rig: &Rig| {
        decision_lines(rig)
            .iter()
            .filter(|line| line.contains("+rebuild") || line.contains("+pruned_reasoning_rebuild"))
            .count()
    };
    assert_eq!(
        rebuilds(&pruned_rig),
        rebuilds(&control),
        "{:#?}",
        decision_lines(&pruned_rig)
    );
    assert!(!decision_lines(&pruned_rig)
        .iter()
        .any(|line| line.contains("+pruned_reasoning_rebuild")));
    // A restart loads nothing that could rebuild again.
    let raw = pruned_rig
        .h
        .store
        .get()
        .unwrap()
        .load_async_compaction(&pruned_rig.reference)
        .unwrap()
        .unwrap();
    assert!(!raw.contains("pruned_rebuild_pending") && !raw.contains("pruned_readopt"));
}

/// Forty messages, message 39 with signed reasoning, a view the runner
/// applied (`applied`) and a later view published but never applied before
/// the session went idle (`unapplied`).
async fn idle_with_an_unapplied_view(dir: &Path) -> (Rig, Value, Value, u64, u64) {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    let (reasoning, pruned) = with_reasoning(&rig, 39);
    rig.notice(1, 1_000, None).await;
    rig.queue(&[163, 166, 169]).await;
    let applied = ride_or_explain(&rig, "model_change").await.view_version;
    rig.notice(2, 1_000, Some(applied)).await;
    // A last view, published by a ride whose request never ran: the
    // session went idle before the runner applied it.
    rig.queue(&[172]).await;
    let unapplied = ride_or_explain(&rig, "model_change").await.view_version;
    assert!(unapplied > applied);
    (rig, reasoning, pruned, applied, unapplied)
}

/// Finding: a refusal of a view older than the prune's rebuild forces a
/// second rebuild.
///
/// The session was idle with a published view the runner had not applied
/// yet. The runner prunes, calls the post-prune Setup, and starts its run:
/// it fetches the pending view, finds it carries the pre-prune signature and
/// refuses it (`pruned_reasoning_restored`), then rides `ttl_expired` because
/// its cache expired while the session was archived. The ride is the
/// prune's one rebuild, built from reconciled copies, and the runner applies
/// it. The first notice of the run reports the refusal of the old view,
/// with the prune generation unchanged.
///
/// That refusal says nothing new: the generation is the one ck-mc
/// reconciled, the refused view is older than the ride's, and the ride's
/// view is applied. On f838379b the notice path sets
/// `pruned_rebuild_pending` for any `pruned_reasoning_restored` refusal
/// (async_provider.rs, `refused_restore`), so this notice runs a second
/// rebuild and publishes a view that rewrites the prompt cache the ride's
/// request just wrote, a second cache rewrite for one prune.
#[tokio::test]
async fn finding_a_stale_refusal_after_the_rebuild_does_not_rebuild_again() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, reasoning, pruned, _, unapplied) = idle_with_an_unapplied_view(dir.path()).await;
    rig.runner
        .prune(39, pruned, vec![row(39, "0", kinds::REASONING, &reasoning)]);
    let answer = rig
        .op("compaction.setup", setup_after_prune_request(&rig))
        .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let ride = ride_or_explain(&rig, "ttl_expired").await;
    assert!(ride.view_version > unapplied);
    assert!(
        !rig.state().pruned_rebuild_pending,
        "the ride took the rebuild"
    );
    // The response the request produced queues one more drop: a rebuild
    // would land it, a notice at this usage defers it.
    rig.queue(&[175]).await;
    assert!(
        try_notice_with(
            &rig,
            4,
            1_000,
            Some(ride.view_version),
            vec![notice::Event::ViewRefused {
                view_version: unapplied,
                reason: notice::refusal_reasons::PRUNED_REASONING_RESTORED.into(),
            }],
        )
        .await,
        "notice 4 completes"
    );
    assert_eq!(
        rig.newest(),
        Some(ride.view_version),
        "a refusal of the view the ride superseded rebuilt a second time: {:#?}",
        decision_lines(&rig)
    );
}

/// Finding: a post-prune Setup whose re-read runs out of time still answers
/// `ready`, and the run's first ride then sends back a pruned signature.
///
/// compaction-provider §4 lets a provider reconcile at Setup alone because
/// the post-prune Setup comes before any other call for the run; a failed
/// Setup ends the run and the runner calls Setup again with the same
/// `reasoning_pruned`. On f838379b `reconcile_at_setup` ignores
/// `Reconciled::Incomplete`: it answers `ready` with the generation not
/// recorded and the later held copies not re-read. The run's ride is built
/// from those copies, and because no generation was recorded yet
/// (`reasoning_pruned` is `None`), `repair_restoring_edits` and
/// `replacement_restores_pruned` check nothing. The ride's edit dropping
/// message 29's text re-serializes the part with its pruned Gemini thought
/// signature.
///
/// The re-read is cut short here by a slow runner and a 100 ms read budget;
/// in production the budget is ten seconds, which a re-read of a long
/// archived session through `through_ordinal` can exceed.
#[tokio::test]
async fn finding_an_incomplete_setup_reconcile_never_lets_a_view_send_pruned_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let (original, pruned) = with_text_signature(&rig, 29);
    rig.notice(1, 1_000, None).await;
    rig.queue(&[100 + 29 * 3]).await;
    rig.runner
        .prune(29, pruned, vec![row(29, "0", kinds::SIGNATURE, &original)]);
    // A slow runner: six messages a page, 50 ms a page, 100 ms to read.
    rig.runner
        .page_size
        .store(6, std::sync::atomic::Ordering::Relaxed);
    rig.runner
        .read_delay_ms
        .store(50, std::sync::atomic::Ordering::Relaxed);
    *rig.h
        .provider_store
        .async_runtime
        .notice_read_budget
        .lock()
        .unwrap() = Some(Duration::from_millis(100));
    let first = rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.setup","params":setup_after_prune_request(&rig)}),
        )
        .await;
    let reconciled = rig.state().reasoning_pruned_generation();
    // The runner is fast again; a Setup that failed is called again, as the
    // contract has the runner do.
    rig.runner
        .read_delay_ms
        .store(0, std::sync::atomic::Ordering::Relaxed);
    *rig.h
        .provider_store
        .async_runtime
        .notice_read_budget
        .lock()
        .unwrap() = None;
    let first_ready = matches!(&first, HandlerOutcome::Response(bytes)
        if serde_json::from_slice::<Value>(bytes).unwrap()["answer"] == "ready");
    if !first_ready {
        let answer = rig
            .op("compaction.setup", setup_after_prune_request(&rig))
            .await;
        assert_eq!(answer["answer"], "ready", "{answer}");
    }
    // The run resumes on another model: its first call is a ride.
    let ride = ride_or_explain(&rig, "model_change").await;
    let edit = ride
        .ranges
        .iter()
        .flat_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.clone(),
            _ => Vec::new(),
        })
        .find(|edit| edit.ordinal == 29 && edit.bytes.is_some())
        .unwrap_or_else(|| {
            panic!(
                "the ride drops message 29's text: first Setup ready={first_ready}, reconciled {reconciled:?}, ranges {}\n{:#?}",
                serde_json::to_string(&ride.ranges).unwrap().replace("exact spent output ", ""),
                decision_lines(&rig)
            )
        });
    let record = [PrunedPartAt::new(29, "0", kinds::SIGNATURE)];
    let part: Value = serde_json::from_str(edit.bytes.as_deref().unwrap()).unwrap();
    assert!(
        prune_rules::restored_by_edit_in(PROFILE, &record, 29, "0", &part)
            .unwrap()
            .is_none(),
        "the first Setup answered ready={first_ready} with generation {reconciled:?} \
         reconciled, and the ride sent the pruned signature back: {part}"
    );
}

/// Every variant of `value` with one change a prune could make: one object
/// member removed, or one string emptied, anywhere, including inside a
/// string that holds a JSON object.
fn one_change_variants(value: &Value) -> Vec<Value> {
    let mut variants = Vec::new();
    match value {
        Value::Object(members) => {
            for (key, member) in members {
                let mut removed = members.clone();
                removed.remove(key);
                variants.push(Value::Object(removed));
                for changed in one_change_variants(member) {
                    let mut with = members.clone();
                    with.insert(key.clone(), changed);
                    variants.push(Value::Object(with));
                }
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                for changed in one_change_variants(item) {
                    let mut with = items.clone();
                    with[index] = changed;
                    variants.push(Value::Array(with));
                }
            }
        }
        Value::String(text) if !text.is_empty() => {
            variants.push(Value::String(String::new()));
            if let Ok(inner @ Value::Object(_)) = serde_json::from_str::<Value>(text) {
                for changed in one_change_variants(&inner) {
                    variants.push(Value::String(changed.to_string()));
                }
            }
        }
        _ => {}
    }
    variants
}

/// Whether a re-read serving `served` in place of `original`, its one part
/// listed as pruned with `kind`, is accepted as a pruning.
fn accepted(profile: &str, kind: &str, original: &Value, served: &Value) -> bool {
    let message_in = |part: &Value| match profile {
        "opencode-aisdk" => {
            json!({"info":{"id":"m1","role":"assistant","time":{"created":1}},"parts":[part]})
        }
        "pi" => {
            json!({"type":"message","id":"m1","parentId":"m0","timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"assistant","content":[part]}})
        }
        _ => json!({"role":"assistant","content":[part]}),
    };
    let held = ReadMessage::new(1, "m1", message_in(original))
        .with_tags(vec![tags::PartTag::untagged("m1#0")]);
    let fresh = ReadMessage::new(1, "m1", message_in(served))
        .with_tags(vec![tags::PartTag::untagged("m1#0")]);
    pruned_reasoning::accepts(
        profile,
        &held,
        &fresh,
        &[serde_json::from_value(row(1, "m1#0", kind, original)).unwrap()],
    )
}

/// Finding: the per-kind payload check accepts pruned parts llm-runner's
/// rule never produces.
///
/// llm-runner 0.7.12 publishes the rule itself (`prune_part_in`): "the
/// bytes a runner stores in place of a pruned part". For every prune in its
/// per-profile vectors, this test serves the part as the rule leaves it and
/// every one-change variant of it and of the original (a member removed or
/// a string emptied), and requires `accepts` to take exactly the rule's
/// bytes. On f838379b `pruned_as` accepts any set of removals and emptied
/// strings each of which, put back alone, makes the part carry the kind's
/// content again. One removal of a whole subtree passes that test however
/// much else the subtree held, and a removal that only hides content from
/// the classifier passes too. Among the variants it accepts:
///
/// - `owned-broca` `signature` on `text_with_state`: `provider_state.format`
///   emptied or removed while `data` still holds the thought signature;
/// - `owned-broca` `opaque_reasoning` on `redacted_reasoning`: `data`
///   emptied whole, where the rule removes only `encrypted_content` from the
///   item JSON and keeps its readable summary;
/// - `opencode-aisdk` `opaque_reasoning` with OpenRouter details: the whole
///   `metadata` removed, readable `reasoning.text` and `reasoning.summary`
///   details included;
/// - `anthropic-messages` `reasoning`: the thinking block with `signature`
///   removed, where the rule empties it to `""`.
#[test]
fn finding_a_pruned_part_is_accepted_only_as_the_rule_prunes_it() {
    let vectors: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("reasoning-pruned-profiles.json").unwrap(),
    )
    .unwrap();
    let mut over_accepted = Vec::new();
    let mut checked = 0;
    for profile in vectors["profiles"].as_array().unwrap() {
        let name = profile["profile"].as_str().unwrap();
        for case in profile["prunes"].as_array().unwrap() {
            let kind = case["kind"].as_str().unwrap();
            let original = &case["original"];
            let rule = prune_rules::prune_part_in(name, kind, original).unwrap();
            assert!(
                accepted(name, kind, original, &rule),
                "{name} {}: the rule's own bytes are accepted",
                case["name"]
            );
            let mut variants = one_change_variants(original);
            variants.extend(one_change_variants(&rule));
            for served in variants {
                checked += 1;
                if served != rule && accepted(name, kind, original, &served) {
                    over_accepted.push(format!(
                        "{name} {} ({kind}): original {original} rule {rule} accepted {served}",
                        case["name"]
                    ));
                }
            }
        }
    }
    assert!(checked > 100, "{checked}");
    assert!(
        over_accepted.is_empty(),
        "{} served parts accepted that the prune rule does not produce:\n{}",
        over_accepted.len(),
        over_accepted.join("\n")
    );
}

/// Finding: a tool call that never gets a result, in the middle of the
/// transcript, is reported as "waiting for a tool result".
///
/// Commit e64a48ea08 completes a notice whose engine pass fails with
/// "compaction range ends inside a tool arc", logging
/// `waiting_for_tool_result`, so the result's own notice runs the pass. The
/// match is on the error text alone (`waiting_for_tool_result` in
/// async_provider.rs). The engine raises that error for any call without a
/// result anywhere in the lineage (`working_range` in transform.rs), not
/// only for the newest message. Here message 1's `tool_use` was never
/// answered (the user wrote message 2 instead) and the transcript goes on
/// for ten more messages. No later write can close that arc, yet a
/// notice now completes as a quiet defer that claims a result is coming,
/// where before it failed (`previous_engine_pass_failed`, a transient
/// error the runner sees). The session never compacts again and nothing
/// says why.
#[tokio::test]
async fn finding_an_unanswered_call_mid_transcript_is_not_waiting_for_a_result() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let mut transcript = anthropic_transcript(12);
    transcript[2] = ReadMessage::new(
        2,
        "m2",
        json!({"role":"user","content":"never mind, stop that and summarise instead"}),
    )
    .with_tags(vec![tags::PartTag::tagged(
        "0",
        format!("§{}§", anthropic_tag(2, 0)),
    )]);
    *rig.runner.entries.lock().unwrap() = transcript;
    let last = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    assert_eq!(last["role"], "assistant");
    assert!(
        last["content"][0]["type"] == "text",
        "the transcript ends in a plain answer: {last}"
    );
    let completed = try_notice_with(&rig, 1, 90_000, None, Vec::new()).await;
    let line = decision_lines(&rig)
        .into_iter()
        .rfind(|line| line.contains(" notice seq=1 "))
        .unwrap_or_default();
    assert!(
        !(completed && line.contains("why=waiting_for_tool_result")),
        "a call that can never be answered is reported as a result on its way: {line}"
    );
}

/// A notice through an open tool call after a prune
/// keeps the prune's rebuild pending and publishes nothing; the result's
/// notice runs that one rebuild, and the notice after it does not rebuild
/// again.
#[tokio::test]
async fn a_notice_through_an_open_call_after_a_prune_keeps_the_one_rebuild_for_the_result() {
    const ANTHROPIC: &str = "anthropic-messages";
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":ANTHROPIC}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(40);
    rig.notice(1, 1_000, None).await;
    rig.queue(&[anthropic_tag(2, 0)]).await;
    let applied = ride_or_explain(&rig, "model_change").await.view_version;
    rig.notice(2, 1_000, Some(applied)).await;
    // The runner prunes message 1's signed thinking at rest.
    let message = rig.runner.entries.lock().unwrap()[1].message.clone();
    let thinking = message["content"][0].clone();
    let mut served = message.clone();
    served["content"][0] =
        prune_rules::prune_part_in(ANTHROPIC, kinds::REASONING, &thinking).unwrap();
    rig.runner
        .prune(1, served, vec![row(1, "0", kinds::REASONING, &thinking)]);
    let answer = rig
        .op("compaction.setup", setup_after_prune_request(&rig))
        .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(rig.state().pruned_rebuild_pending);
    // The run writes an assistant turn ending in `tool_use`.
    let extend = |count: u64| {
        let pruned = rig.runner.entries.lock().unwrap()[1].clone();
        let mut entries = anthropic_transcript(count);
        entries[1] = pruned;
        *rig.runner.entries.lock().unwrap() = entries;
    };
    extend(42);
    rig.notice(3, 1_000, Some(applied)).await;
    let state = rig.state();
    assert_eq!(
        rig.newest(),
        Some(applied),
        "nothing published through the open arc"
    );
    assert!(
        state.pruned_rebuild_pending,
        "the rebuild waits for the result"
    );
    assert!(decision_lines(&rig).last().is_some_and(
        |line| line.contains("notice seq=3") && line.contains("why=waiting_for_tool_result")
    ));
    // The result is written: its notice runs the one rebuild.
    extend(43);
    rig.queue(&[anthropic_tag(6, 0)]).await;
    rig.notice(4, 1_000, Some(applied)).await;
    let rebuilt = rig.newest().unwrap();
    assert!(rebuilt > applied, "{:#?}", decision_lines(&rig));
    let state = rig.state();
    assert!(!state.pruned_rebuild_pending && !state.engine_failed);
    // The next notice, with more cleanup queued, does not rebuild again.
    rig.queue(&[anthropic_tag(10, 0)]).await;
    rig.notice(5, 1_000, Some(rebuilt)).await;
    assert_eq!(rig.newest(), Some(rebuilt), "{:#?}", decision_lines(&rig));
    let rebuilds = decision_lines(&rig)
        .iter()
        .filter(|line| line.contains("+pruned_reasoning_rebuild"))
        .count();
    assert_eq!(rebuilds, 1, "{:#?}", decision_lines(&rig));
}
