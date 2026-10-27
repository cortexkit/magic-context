//! compaction-provider 0.7.4 / llm-runner 0.7.11 archive pruning: ck-mc
//! reconciles its held copies when the runner's prune generation changes,
//! keeps its engine working across the identity change, rebuilds once, and
//! never sends back what the runner pruned.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::{kinds, PrunedPartAt};

fn decision_lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

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

/// Give OpenCode message `ordinal` a signed reasoning part before its one
/// tagged part, as an assistant message with thinking has. Returns the
/// original reasoning part and the message as the runner serves it after
/// pruning that reasoning at rest.
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
    pruned["parts"][0] = json!({"id":format!("p{ordinal}r"),"type":"reasoning","text":""});
    (reasoning, pruned)
}

/// Prune the reasoning `with_reasoning` gave message `ordinal`.
fn prune_reasoning(rig: &Rig, ordinal: u64, reasoning: &Value, pruned: Value) {
    rig.runner.prune(
        ordinal,
        pruned,
        vec![row(ordinal, "0", kinds::REASONING, reasoning)],
    );
}

/// The Setup a runner calls after a prune, before any other call for its
/// next run: the session's own Setup carrying the head's prune state.
async fn setup_after_prune(rig: &Rig) -> Value {
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["request_id"] = json!("setup-after-prune");
    request["reasoning_pruned"] = serde_json::to_value(rig.runner.prune_state().unwrap()).unwrap();
    rig.op("compaction.setup", request).await
}

fn held(rig: &Rig, ordinal: u64) -> Value {
    rig.state().entries[&ordinal].read().unwrap().message
}

fn units_on(rig: &Rig, mid: &str) -> Vec<String> {
    let loaded = rig
        .h
        .store
        .get()
        .unwrap()
        .load(&rig.state().namespace())
        .unwrap();
    loaded
        .core
        .frozen_units
        .iter()
        .map(|unit| unit.key.clone())
        .filter(|key| key.ends_with(&format!(":{mid}")) || key.contains(&format!("{mid}#")))
        .collect()
}

fn identity_of(rig: &Rig, mid: &str) -> Option<String> {
    let loaded = rig
        .h
        .store
        .get()
        .unwrap()
        .load(&rig.state().namespace())
        .unwrap();
    loaded
        .meta
        .block_identity_by_mid
        .get(mid)
        .map(|vector| serde_json::to_string(vector).unwrap())
}

async fn ride_view(rig: &Rig, params: Value) -> view::CompactionView {
    let answer = rig.op("compaction.ride", params).await;
    assert_eq!(answer["answer"], "view", "{answer}");
    decode(&answer["view"]).unwrap()
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

/// A new prune generation re-reads the held copies from the lowest held
/// ordinal through the prune's `through_ordinal`, replaces the pruned ones,
/// records the generation, and reads nothing held again for the same
/// generation. A session that was never pruned stores none of it.
#[tokio::test]
async fn a_new_prune_generation_rereads_held_copies_through_the_prune_once() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let (reasoning_9, pruned_9) = with_reasoning(&rig, 9);
    let (reasoning_19, pruned_19) = with_reasoning(&rig, 19);
    let (_, unpruned_34) = with_reasoning(&rig, 34);
    rig.notice(1, 1_000, None).await;
    let raw = rig
        .h
        .store
        .get()
        .unwrap()
        .load_async_compaction(&rig.reference)
        .unwrap()
        .unwrap();
    for member in [
        "reasoning_pruned",
        "pruned_readopt",
        "pruned_rebuild_pending",
        "rode_since_notice",
    ] {
        assert!(!raw.contains(member), "never pruned: no {member} in {raw}");
    }
    let original_34 = held(&rig, 34);
    assert_ne!(original_34, unpruned_34);
    prune_reasoning(&rig, 9, &reasoning_9, pruned_9.clone());
    let state = rig.runner.prune(
        19,
        pruned_19.clone(),
        vec![row(19, "0", kinds::REASONING, &reasoning_19)],
    );
    assert_eq!((state.generation, state.through_ordinal), (2, 19));
    rig.runner.reads.lock().unwrap().clear();

    let answer = setup_after_prune(&rig).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["accepts"], json!(["pruned_reasoning"]));
    let starts = rig.runner.read_starts();
    assert_eq!(
        starts.first(),
        Some(&0),
        "from the lowest held ordinal: {starts:?}"
    );
    assert!(
        rig.runner
            .reads
            .lock()
            .unwrap()
            .iter()
            .all(|params| params["from_ordinal"].as_u64().unwrap()
                + params["limit"].as_u64().unwrap()
                <= 20),
        "never past through_ordinal: {:?}",
        rig.runner.reads.lock().unwrap()
    );
    assert_eq!(held(&rig, 9), pruned_9, "the pruned copy is held");
    assert_eq!(held(&rig, 19), pruned_19);
    assert_eq!(
        held(&rig, 34),
        original_34,
        "past through_ordinal: untouched"
    );
    let state = rig.state();
    assert_eq!(state.reasoning_pruned_generation(), Some(2));
    assert_eq!(
        state.pruned_readopt,
        BTreeSet::from(["m19".to_owned(), "m9".to_owned()])
    );
    assert!(state.pruned_rebuild_pending);

    rig.runner.reads.lock().unwrap().clear();
    let again = setup_after_prune(&rig).await;
    assert_eq!(again["answer"], "ready");
    assert!(
        rig.runner.reads.lock().unwrap().is_empty(),
        "the same generation is reconciled once"
    );
    rig.notice(2, 1_000, None).await;
    assert_eq!(
        rig.runner.read_starts(),
        vec![39],
        "a notice with the same generation reads only from the newest held entry"
    );
}

/// A post-prune Setup whose re-read runs out of time fails with a transient
/// error, so the runner makes no other call for the run and calls Setup
/// again; no view can be built from copies the prune changed. The retried
/// Setup continues the re-read where the first stopped, without reading the
/// copies already reconciled for the same generation, and answers `ready`
/// once the generation is reconciled.
#[tokio::test]
async fn an_incomplete_setup_reconcile_fails_and_the_retry_continues_it() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let (reasoning, pruned) = with_reasoning(&rig, 29);
    rig.notice(1, 1_000, None).await;
    prune_reasoning(&rig, 29, &reasoning, pruned.clone());
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
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["request_id"] = json!("setup-after-prune");
    request["reasoning_pruned"] = serde_json::to_value(rig.runner.prune_state().unwrap()).unwrap();
    let first = rig
        .h
        .dispatch_value(7, json!({"method":"compaction.setup","params":request}))
        .await;
    assert!(
        matches!(&first, HandlerOutcome::Error { code, .. } if code == "transient"),
        "an unfinished re-read fails the Setup: {first:?}"
    );
    let state = rig.state();
    assert_eq!(state.reasoning_pruned_generation(), None);
    let stopped = state
        .pruned_reconcile_cursor
        .expect("where the re-read stopped");
    assert_eq!(stopped.generation, 1);
    assert!(
        stopped.next_ordinal > 0 && stopped.next_ordinal <= 29,
        "{stopped:?}"
    );
    // The runner calls Setup again, faster this time.
    rig.runner
        .read_delay_ms
        .store(0, std::sync::atomic::Ordering::Relaxed);
    *rig.h
        .provider_store
        .async_runtime
        .notice_read_budget
        .lock()
        .unwrap() = None;
    rig.runner.reads.lock().unwrap().clear();
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let starts = rig.runner.read_starts();
    assert_eq!(starts.first(), Some(&stopped.next_ordinal), "{starts:?}");
    assert!(
        starts.iter().all(|start| *start >= stopped.next_ordinal),
        "the copies already reconciled are not read again: {starts:?}"
    );
    let state = rig.state();
    assert_eq!(state.reasoning_pruned_generation(), Some(1));
    assert_eq!(state.pruned_reconcile_cursor, None);
    assert_eq!(held(&rig, 29), pruned);
}

/// A reconciliation never reads below the cut. Copies held from
/// below it stay as they are; the ones above it are reconciled.
#[tokio::test]
async fn reconciling_never_reads_below_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let (reasoning_9, pruned_9) = with_reasoning(&rig, 9);
    let (reasoning_24, pruned_24) = with_reasoning(&rig, 24);
    rig.notice(1, 1_000, None).await;
    prune_reasoning(&rig, 9, &reasoning_9, pruned_9);
    let seen = rig.runner.prune(
        24,
        pruned_24.clone(),
        vec![row(24, "0", kinds::REASONING, &reasoning_24)],
    );
    let mut state = rig.state();
    state.cut_first_ordinal = Some(20);
    let original_9 = state.entries[&9].read().unwrap().message;
    rig.runner.reads.lock().unwrap().clear();
    let outcome = rig
        .h
        .reconcile_pruned_reasoning(&mut state, seen, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(matches!(outcome, pruned_reasoning::Reconciled::Complete));
    let starts = rig.runner.read_starts();
    assert_eq!(starts.first(), Some(&20), "{starts:?}");
    assert!(starts.iter().all(|start| *start >= 20), "{starts:?}");
    assert_eq!(state.entries[&9].read().unwrap().message, original_9);
    assert_eq!(state.entries[&24].read().unwrap().message, pruned_24);
}

fn part_of(message: &Value, index: usize) -> Value {
    message["parts"][index].clone()
}

fn read_message(ordinal: u64, message: Value, tags: Vec<tags::PartTag>) -> ReadMessage {
    ReadMessage::new(ordinal, format!("m{ordinal}"), message).with_tags(tags)
}

/// The message `part` sits alone in, in serializer profile `profile`'s
/// container.
fn message_in(profile: &str, part: Value) -> Value {
    match profile {
        "opencode-aisdk" => {
            json!({"info":{"id":"m1","role":"assistant","time":{"created":1}},"parts":[part]})
        }
        "pi" => {
            json!({"type":"message","id":"m1","parentId":"m0","timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"assistant","content":[part]}})
        }
        _ => json!({"role":"assistant","content":[part]}),
    }
}

/// Whether a re-read serving `served` in place of `original`, its one part
/// listed as pruned with `kind`, is accepted as a pruning.
fn accepted(profile: &str, kind: &str, original: &Value, served: &Value) -> bool {
    let held = read_message(
        1,
        message_in(profile, original.clone()),
        vec![tags::PartTag::untagged("m1#0")],
    );
    let fresh = read_message(
        1,
        message_in(profile, served.clone()),
        vec![tags::PartTag::untagged("m1#0")],
    );
    let row = row(1, "m1#0", kind, original);
    pruned_reasoning::accepts(
        profile,
        &held,
        &fresh,
        &[serde_json::from_value(row).unwrap()],
    )
}

/// A listed part is accepted only in the way its kind
/// allows in the session's serializer profile (llm-runner §9.14.1,
/// per-profile table). Every prune llm-runner 0.7.11 publishes for each
/// profile is accepted. A change the kind does not make is refused: text
/// rewritten or emptied under `signature`, readable reasoning touched under
/// `opaque_reasoning`, a kind the profile cannot carry or this crate does
/// not define, a member the profile's table does not list as a signature,
/// item state that is not a signature, and any unlisted change.
#[test]
fn a_listed_part_is_accepted_only_as_its_kind_prunes_it() {
    let vectors: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("reasoning-pruned-profiles.json").unwrap(),
    )
    .unwrap();
    let mut accepted_cases = 0;
    for profile in vectors["profiles"].as_array().unwrap() {
        let name = profile["profile"].as_str().unwrap();
        for case in profile["prunes"].as_array().unwrap() {
            assert!(
                accepted(
                    name,
                    case["kind"].as_str().unwrap(),
                    &case["original"],
                    &case["served"]
                ),
                "{name} {}: a published prune is accepted",
                case["name"]
            );
            assert!(
                !accepted(name, "future_kind", &case["original"], &case["served"]),
                "{name} {}: an undefined kind is not trusted",
                case["name"]
            );
            accepted_cases += 1;
        }
    }
    assert!(accepted_cases >= 30, "{accepted_cases}");
    let refused = [
        // owned-broca
        (
            "owned-broca",
            kinds::OPAQUE_REASONING,
            json!({"type":"reasoning","text":"thinking it over","signature":"sig"}),
            json!({"type":"reasoning","text":""}),
            "opaque_reasoning keeps the text",
        ),
        (
            "owned-broca",
            kinds::SIGNATURE,
            json!({"type":"tool_call","tool_call_id":"c","tool_name":"open","input":{"door":1},"thought_signature":"sig"}),
            json!({"type":"tool_call","tool_call_id":"c","tool_name":"open","input":{"door":2}}),
            "call arguments changed",
        ),
        (
            "owned-broca",
            kinds::SIGNATURE,
            json!({"type":"text_with_state","text":"noted","provider_state":{"format":"gemini","data":"{\"thoughtSignature\":\"sig\"}"}}),
            json!({"type":"text_with_state","text":"","provider_state":{"format":"gemini","data":""}}),
            "text emptied",
        ),
        (
            "owned-broca",
            kinds::SIGNATURE,
            json!({"type":"text_with_state","text":"noted","provider_state":{"format":"open_ai_responses","data":"{\"id\":\"msg\",\"phase\":\"final_answer\"}"}}),
            json!({"type":"text_with_state","text":"noted","provider_state":{"format":"open_ai_responses","data":""}}),
            "Responses item state is no signature",
        ),
        (
            "owned-broca",
            kinds::REASONING,
            json!({"type":"text","text":"the answer"}),
            json!({"type":"text","text":""}),
            "reasoning kind on a text part",
        ),
        // anthropic-messages
        (
            "anthropic-messages",
            kinds::SIGNATURE,
            json!({"type":"thinking","thinking":"plan","signature":"sig"}),
            json!({"type":"thinking","thinking":"plan","signature":""}),
            "anthropic-messages carries no signature kind",
        ),
        (
            "anthropic-messages",
            kinds::OPAQUE_REASONING,
            json!({"type":"thinking","thinking":"plan","signature":"sig"}),
            json!({"type":"thinking","thinking":"","signature":""}),
            "opaque_reasoning keeps the thinking text",
        ),
        // opencode-aisdk
        (
            "opencode-aisdk",
            kinds::SIGNATURE,
            json!({"id":"t","type":"text","text":"the answer","metadata":{"google":{"thoughtSignature":"sig"}}}),
            json!({"id":"t","type":"text","text":"text the model never wrote","metadata":{"google":{}}}),
            "text rewritten",
        ),
        (
            "opencode-aisdk",
            kinds::SIGNATURE,
            json!({"id":"t","type":"text","text":"the answer","metadata":{"openai":{"signature":"sig"}}}),
            json!({"id":"t","type":"text","text":"the answer","metadata":{"openai":{}}}),
            "an entry the table does not list",
        ),
        (
            "opencode-aisdk",
            kinds::OPAQUE_REASONING,
            json!({"id":"r","type":"reasoning","text":"summary","metadata":{"openai":{"itemId":"rs","reasoningEncryptedContent":"cipher"}}}),
            json!({"id":"r","type":"reasoning","text":"","metadata":{"openai":{"itemId":"rs"}}}),
            "opaque_reasoning keeps the summary text",
        ),
        // pi
        (
            "pi",
            kinds::SIGNATURE,
            json!({"type":"text","text":"closing","textSignature":"{\"v\":1,\"id\":\"msg\",\"phase\":\"final_answer\"}"}),
            json!({"type":"text","text":"closing"}),
            "Responses text item state is no signature",
        ),
    ];
    for (profile, kind, original, served, why) in refused {
        assert!(
            !accepted(profile, kind, &original, &served),
            "{profile}: {why}"
        );
    }
    // Witness shape: an unlisted part changed beside a listed pruning.
    let original = json!({"type":"reasoning","text":"thinking","signature":"sig"});
    let held = read_message(
        1,
        json!({"role":"assistant","content":[original.clone(),{"type":"text","text":"answer"}]}),
        vec![
            tags::PartTag::untagged("m1#0"),
            tags::PartTag::untagged("m1#1"),
        ],
    );
    let fresh = read_message(
        1,
        json!({"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"changed"}]}),
        vec![
            tags::PartTag::untagged("m1#0"),
            tags::PartTag::untagged("m1#1"),
        ],
    );
    let listed: cortexkit_role_llm_runner::archive_prunes_reasoning::PrunedReasoning =
        serde_json::from_value(row(1, "m1#0", kinds::REASONING, &original)).unwrap();
    assert!(!pruned_reasoning::accepts(
        "owned-broca",
        &held,
        &fresh,
        std::slice::from_ref(&listed)
    ));
    let mut wrong_digest = listed.clone();
    wrong_digest.sha256 = "0".repeat(64);
    let pruned_only = read_message(
        1,
        json!({"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"answer"}]}),
        vec![
            tags::PartTag::untagged("m1#0"),
            tags::PartTag::untagged("m1#1"),
        ],
    );
    assert!(pruned_reasoning::accepts(
        "owned-broca",
        &held,
        &pruned_only,
        std::slice::from_ref(&listed)
    ));
    assert!(!pruned_reasoning::accepts(
        "owned-broca",
        &held,
        &pruned_only,
        &[wrong_digest]
    ));
}

/// Forty messages, message 39 with signed reasoning, a view built by the
/// engine over it and acknowledged, so the engine holds frozen decisions on
/// message 39 and its block identity before the prune.
async fn engine_ran_over_39(dir: &Path) -> (Rig, Value, Value, view::CompactionView) {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    let (reasoning, pruned) = with_reasoning(&rig, 39);
    rig.notice(1, 1_000, None).await;
    rig.queue(&[163, 166, 169]).await;
    let view = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    assert_eq!(view.covers_through.ordinal, 39);
    rig.notice(2, 1_000, Some(view.view_version)).await;
    assert!(
        !units_on(&rig, "m39").is_empty(),
        "the engine froze a decision on message 39 before the prune"
    );
    assert!(identity_of(&rig, "m39").is_some());
    (rig, reasoning, pruned, view)
}

/// After the post-prune Setup reconciles a
/// message the engine already froze decisions for, the engine adopts its new
/// block identity on the next pass, which runs once as a rebuild; later
/// notices and rides keep working, and the frozen decisions stay.
#[tokio::test]
async fn a_reconciled_message_with_frozen_decisions_keeps_the_engine_working() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, reasoning, pruned, ridden) = engine_ran_over_39(dir.path()).await;
    let units = units_on(&rig, "m39");
    let before = identity_of(&rig, "m39");
    prune_reasoning(&rig, 39, &reasoning, pruned);
    assert_eq!(setup_after_prune(&rig).await["answer"], "ready");
    rig.queue(&[178]).await;
    rig.notice(3, 1_000, Some(ridden.view_version)).await;
    let state = rig.state();
    assert!(!state.engine_failed, "the pass after the prune succeeded");
    assert!(state.pruned_readopt.is_empty() && !state.pruned_rebuild_pending);
    let rebuilt = rig.newest().unwrap();
    assert!(rebuilt > ridden.view_version, "the prune rebuilt once");
    assert!(
        decision_lines(&rig)
            .iter()
            .any(|line| line.contains("notice seq=3") && line.contains("+pruned_reasoning_rebuild")),
        "{:?}",
        decision_lines(&rig)
    );
    assert_ne!(
        identity_of(&rig, "m39"),
        before,
        "the new identity is adopted"
    );
    assert_eq!(units_on(&rig, "m39"), units, "the frozen decisions stay");
    rig.queue(&[175]).await;
    rig.notice(4, 1_000, Some(rebuilt)).await;
    assert_eq!(rig.newest(), Some(rebuilt), "no second rebuild");
    assert!(!rig.state().engine_failed);
    let ride = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}),
    )
    .await;
    assert!(ride.view_version > rebuilt, "a later ride still rebuilds");
}

/// Setup first: the post-prune Setup reconciles, the
/// runner then rides `ttl_expired` before its first request. The ride is
/// the one rebuild; the notice that follows publishes nothing new.
#[tokio::test]
async fn a_ride_after_the_post_prune_setup_is_the_one_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, reasoning, pruned, ridden) = engine_ran_over_39(dir.path()).await;
    prune_reasoning(&rig, 39, &reasoning, pruned);
    assert_eq!(setup_after_prune(&rig).await["answer"], "ready");
    assert!(rig.state().pruned_rebuild_pending);
    let ride = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}),
    )
    .await;
    assert!(ride.view_version > ridden.view_version);
    assert!(
        !rig.state().pruned_rebuild_pending,
        "the ride took the rebuild"
    );
    rig.queue(&[178]).await;
    rig.notice(3, 1_000, Some(ride.view_version)).await;
    assert_eq!(
        rig.newest(),
        Some(ride.view_version),
        "the notice after the ride does not rebuild a second time"
    );
    assert!(!rig.state().engine_failed);
}

/// Ride first: the runner rides `account_change`
/// before ck-mc learned of the prune; the notice that follows reconciles
/// and does not rebuild again. Without the ride, the same notice rebuilds.
#[tokio::test]
async fn a_prune_learned_after_a_rewrite_ride_does_not_rebuild_again() {
    for ridden_first in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (rig, reasoning, pruned, applied) = engine_ran_over_39(dir.path()).await;
        prune_reasoning(&rig, 39, &reasoning, pruned);
        let current = if ridden_first {
            ride_view(
                &rig,
                json!({"session_ref":rig.reference,"cause":"account_change","account":"Route_1.a-b","deadline_ms":10_000}),
            )
            .await
            .view_version
        } else {
            applied.view_version
        };
        rig.queue(&[178]).await;
        rig.notice(3, 1_000, Some(current)).await;
        let state = rig.state();
        assert_eq!(state.reasoning_pruned_generation(), Some(1));
        assert!(!state.engine_failed);
        if ridden_first {
            assert_eq!(
                rig.newest(),
                Some(current),
                "no second rebuild after the ride"
            );
        } else {
            assert!(rig.newest() > Some(current), "the prune's one rebuild");
        }
    }
}

/// Give OpenCode message `ordinal` (a tool part) a call thought signature,
/// as Gemini's provider metadata holds it. Returns the original tool part
/// and the message as served after a `signature` prune.
fn with_call_signature(rig: &Rig, ordinal: u64) -> (Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries.iter_mut().find(|e| e.ordinal == ordinal).unwrap();
    assert_eq!(entry.message["parts"][0]["type"], "tool");
    entry.message["parts"][0]["metadata"] =
        json!({"google":{"thoughtSignature":format!("invented-call-signature-{ordinal}")}});
    let original = part_of(&entry.message, 0);
    let mut pruned = entry.message.clone();
    pruned["parts"][0]["metadata"] = json!({"google":{}});
    (original, pruned)
}

/// An edit that trims a tool output re-encodes the whole OpenCode
/// tool part, call included. After a `signature` prune of that part, no
/// view sends the call's thought signature back: neither the edit built
/// from the reconciled copy nor the edit acknowledged before the prune.
#[tokio::test]
async fn a_trimmed_tool_output_never_resends_a_pruned_call_signature() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let (original, pruned) = with_call_signature(&rig, 21);
    let signature = "invented-call-signature-21";
    rig.notice(1, 1_000, None).await;
    rig.history(20, "history before the reduction");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    // An execute pass keeps the call as a skeleton and trims its output to
    // the dropped placeholder: one edit re-encoding the whole tool part.
    rig.queue(&[163]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let view = rig.get(rig.newest().unwrap()).await;
    let edit_on_21 = |view: &view::CompactionView| {
        view.ranges
            .iter()
            .filter_map(|range| match range {
                view::ViewRange::Keep { edits, .. } => edits
                    .iter()
                    .find(|edit| edit.ordinal == 21 && edit.bytes.is_some())
                    .cloned(),
                _ => None,
            })
            .next()
    };
    let place_of_21 = |view: &view::CompactionView| {
        format!(
            "{:?}",
            view.ranges.iter().find(|r| match r {
                view::ViewRange::Keep { from, to, .. }
                | view::ViewRange::Replace { from, to, .. } => *from <= 21 && 21 < *to,
                _ => false,
            })
        )
    };
    let before = edit_on_21(&view)
        .unwrap_or_else(|| panic!("the output is trimmed: {}", place_of_21(&view)));
    let bytes = before.bytes.as_deref().unwrap();
    assert!(
        bytes.contains(signature) && bytes.contains("[dropped §163§]"),
        "the edit trims the output and re-encodes the call with its signature: {before:?}"
    );
    // The runner applies it: the edit is now acknowledged native bytes.
    rig.notice(4, 1_000, Some(view.view_version)).await;
    rig.runner
        .prune(21, pruned, vec![row(21, "0", kinds::SIGNATURE, &original)]);
    assert_eq!(setup_after_prune(&rig).await["answer"], "ready");
    // More cleanup for the next rebuild to land, so it publishes a view:
    // the engine's own view of message 21 did not change (the call's
    // signature lives in the part's metadata, which the engine does not
    // carry), so without new work it would keep the applied view.
    rig.queue(&[178]).await;
    let after = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}),
    )
    .await;
    for bytes in sent_bytes(&after) {
        assert!(
            !bytes.contains(signature),
            "pruned signature sent back: {bytes}"
        );
    }
    let trimmed = edit_on_21(&after)
        .unwrap_or_else(|| panic!("the output stays trimmed: {}", place_of_21(&after)));
    let part: Value = serde_json::from_str(trimmed.bytes.as_deref().unwrap()).unwrap();
    assert_eq!(part["metadata"], json!({"google":{}}), "{part}");
    assert!(
        trimmed
            .bytes
            .as_deref()
            .unwrap()
            .contains("[dropped §163§]"),
        "{part}"
    );
}

/// A `signature` prune of an OpenCode text part the view edits:
/// the edited text never carries the pruned signature back.
#[tokio::test]
async fn an_edited_text_part_never_resends_a_pruned_text_signature() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    let signature = "invented-text-signature-24";
    let (original, pruned) = {
        let mut entries = rig.runner.entries.lock().unwrap();
        let entry = entries.iter_mut().find(|e| e.ordinal == 24).unwrap();
        assert_eq!(entry.message["parts"][0]["type"], "text");
        // A Gemini text part's thought signature, as OpenCode copies the
        // provider metadata into `part.metadata`.
        entry.message["parts"][0]["metadata"] = json!({"google":{"thoughtSignature":signature}});
        let original = part_of(&entry.message, 0);
        let mut pruned = entry.message.clone();
        pruned["parts"][0]["metadata"] = json!({"google":{}});
        (original, pruned)
    };
    rig.notice(1, 1_000, None).await;
    rig.queue(&[172]).await;
    let view = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    let edits_on_24 = |view: &view::CompactionView| {
        view.ranges
            .iter()
            .flat_map(|range| match range {
                view::ViewRange::Keep { edits, .. } => edits.clone(),
                _ => Vec::new(),
            })
            .filter(|edit| edit.ordinal == 24)
            .collect::<Vec<_>>()
    };
    let before = edits_on_24(&view);
    assert!(
        before
            .iter()
            .any(|edit| edit.bytes.as_deref().is_some_and(|b| b.contains(signature))),
        "the text edit re-encodes the part with its signature: {before:?}"
    );
    rig.notice(2, 1_000, Some(view.view_version)).await;
    rig.runner
        .prune(24, pruned, vec![row(24, "0", kinds::SIGNATURE, &original)]);
    assert_eq!(setup_after_prune(&rig).await["answer"], "ready");
    let after = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}),
    )
    .await;
    for bytes in sent_bytes(&after) {
        assert!(
            !bytes.contains(signature),
            "pruned signature sent back: {bytes}"
        );
    }
    assert!(
        edits_on_24(&after).iter().any(|edit| edit.bytes.is_some()),
        "the text stays edited"
    );
}

/// A session set up before ck-mc accepted pruning answers a repeat
/// Setup without `accepts`, as it always did; only a post-prune Setup the
/// contract allows (which reconciles) names the permission.
#[tokio::test]
async fn an_existing_session_is_opted_in_only_by_a_post_prune_setup() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let mut state = rig
        .h
        .checkout(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .unwrap();
    state.withdraw_pruning_permission().unwrap();
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    rig.h.checkin(state);
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["request_id"] = json!("again");
    let again = rig.op("compaction.setup", request).await;
    assert!(again.get("accepts").is_none(), "{again}");
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let (reasoning, pruned) = with_reasoning(&rig, 39);
    prune_reasoning(&rig, 39, &reasoning, pruned);
    let after = setup_after_prune(&rig).await;
    assert_eq!(after["accepts"], json!(["pruned_reasoning"]), "{after}");
}

/// An owned-broca transcript: user prompts at even ordinals, assistant
/// answers at odd ones with signed reasoning, tagged text and a tool call
/// with a thought signature, each answered by a tagged tool result in the
/// next user message.
fn broca_fill(rig: &Rig, count: u64) {
    *rig.runner.entries.lock().unwrap() = (0..count)
        .map(|n| {
            let tag = |k: u64| format!("§{}§", 100 + n * 3 + k);
            if n % 2 == 1 {
                ReadMessage::new(
                    n,
                    format!("m{n}"),
                    json!({"role":"assistant","content":[
                        {"type":"reasoning","text":format!("private thought {n}"),"signature":format!("invented-signature-{n}")},
                        {"type":"text","text":format!("answer {n} ")+&"durable words ".repeat(16)},
                        {"type":"tool_call","tool_call_id":format!("call-{n}"),"tool_name":"read","input":{"path":format!("file{n}")},"thought_signature":format!("invented-call-signature-{n}")}
                    ]}),
                )
                .with_tags(vec![
                    tags::PartTag::untagged("0"),
                    tags::PartTag::tagged("1", tag(0)),
                    tags::PartTag::untagged("2"),
                ])
            } else if n == 0 {
                ReadMessage::new(
                    n,
                    format!("m{n}"),
                    json!({"role":"user","content":[{"type":"text","text":"start "}]}),
                )
                .with_tags(vec![tags::PartTag::tagged("0", tag(0))])
            } else {
                ReadMessage::new(
                    n,
                    format!("m{n}"),
                    json!({"role":"user","content":[
                        {"type":"tool_result","tool_call_id":format!("call-{}", n - 1),"output":{"kind":"text","text":"exact spent output ".repeat(500)},"is_error":false},
                        {"type":"text","text":format!("question {n}")}
                    ]}),
                )
                .with_tags(vec![
                    tags::PartTag::tagged("0", tag(1)),
                    tags::PartTag::tagged("1", tag(2)),
                ])
            }
        })
        .collect();
}

/// The published probe's checks, over the owned-broca shapes ck-mc's codec
/// reads (`held_copies_follow_reasoning_pruned` runs separately, on its own
/// transcripts; see `held_copies_probe`): after
/// a prune of reasoning and call signatures and the post-prune Setup, every
/// held ordinal through the prune was read again, every view passes the
/// published `CompactionView::restored_pruned_part_in`, and a notice with the
/// same generation re-reads nothing held.
#[tokio::test]
async fn owned_broca_views_pass_the_published_restore_check_after_a_prune() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(dir.path(), "thalamus-harness", "opencode", json!({})).await;
    broca_fill(&rig, 21);
    rig.notice(1, 1_000, None).await;
    // Drop the answer text of message 13: an edit with bytes in a message
    // the prune will touch.
    rig.queue(&[100 + 13 * 3]).await;
    let first = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    rig.notice(2, 1_000, Some(first.view_version)).await;
    let mut parts = Vec::new();
    let entries = rig.runner.entries.lock().unwrap().clone();
    for entry in entries
        .iter()
        .filter(|e| e.ordinal % 2 == 1 && e.ordinal <= 15)
    {
        let mut served = entry.message.clone();
        served["content"][0] = json!({"type":"reasoning","text":""});
        served["content"][2]
            .as_object_mut()
            .unwrap()
            .remove("thought_signature");
        rig.runner.prune(
            entry.ordinal,
            served,
            vec![
                row(
                    entry.ordinal,
                    "0",
                    kinds::REASONING,
                    &entry.message["content"][0],
                ),
                row(
                    entry.ordinal,
                    "2",
                    kinds::SIGNATURE,
                    &entry.message["content"][2],
                ),
            ],
        );
        parts.push(PrunedPartAt::new(entry.ordinal, "0", kinds::REASONING));
        parts.push(PrunedPartAt::new(entry.ordinal, "2", kinds::SIGNATURE));
    }
    let through = rig.runner.prune_state().unwrap().through_ordinal;
    rig.runner.reads.lock().unwrap().clear();
    assert_eq!(setup_after_prune(&rig).await["answer"], "ready");
    let reread = rig
        .runner
        .reads
        .lock()
        .unwrap()
        .iter()
        .flat_map(|params| {
            let from = params["from_ordinal"].as_u64().unwrap();
            from..from + params["limit"].as_u64().unwrap().min(7)
        })
        .collect::<BTreeSet<_>>();
    for ordinal in 0..=through {
        assert!(
            reread.contains(&ordinal),
            "held ordinal {ordinal} was not re-read"
        );
    }
    let after = ride_view(
        &rig,
        json!({"session_ref":rig.reference,"cause":"ttl_expired","deadline_ms":10_000}),
    )
    .await;
    let checked = after.ranges.iter().any(|range| match range {
        view::ViewRange::Keep { edits, .. } => edits
            .iter()
            .any(|e| e.bytes.is_some() && parts.iter().any(|p| p.ordinal == e.ordinal)),
        view::ViewRange::Replace { from, to, .. } => {
            parts.iter().any(|p| (*from..*to).contains(&p.ordinal))
        }
        _ => false,
    });
    assert!(
        checked,
        "the view edits or replaces a pruned message: {after:?}"
    );
    assert_eq!(
        after.restored_pruned_part_in("owned-broca", &parts, 0),
        Ok(None)
    );
    rig.runner.reads.lock().unwrap().clear();
    rig.notice(3, 1_000, Some(after.view_version)).await;
    assert!(
        rig.runner
            .read_starts()
            .iter()
            .all(|start| *start > through),
        "no held ordinal re-read for the same generation: {:?}",
        rig.runner.read_starts()
    );
    assert_eq!(rig.newest(), Some(after.view_version));
}
