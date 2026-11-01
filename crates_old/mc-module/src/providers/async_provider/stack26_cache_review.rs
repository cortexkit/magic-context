//! Witnesses for defects found by a cache review of the async provider's
//! published views (tool pairing and dropped user text). They reproduce the
//! defects and do not change provider policy. Each is
//! ignored until its finding is fixed; run them with `--ignored`.
use super::*;

/// Differential seed 1008 (owned-broca): after a restore under a new lineage,
/// view 3 covered the newest message, a user message at ordinal 232, but
/// dropped its only part, and the replacement head that carried copies of the
/// other live messages did not carry its words. Broca's codec gave the engine's
/// messages no source ordinal, so no rendered message was matched to its
/// source and every live message was served only as a copy in the head; the
/// restored head then replaced those copies with older ones.
#[tokio::test]
async fn stack26_seed_1008_restore_keeps_newest_broca_user_message() {
    let pair = session_pair_with(Profile::Broca, 1008, 24, false).await;
    let review = pair.review.borrow();
    let dropped: Vec<_> = review
        .violations
        .iter()
        .filter(|violation| violation.starts_with("AUTHORED"))
        .collect();
    assert!(
        dropped.is_empty(),
        "{} views dropped live user text; first: {:?}; steps {:?}",
        dropped.len(),
        dropped.first(),
        pair.log
    );
}

/// Tool-call ids and tool-result ids in model-format messages (owned-broca,
/// Pi journal bodies, Anthropic Messages). OpenCode tool parts carry the call
/// and its output together, so they never split.
pub(super) fn tool_ids(messages: &[Value]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut calls = BTreeSet::new();
    let mut results = BTreeSet::new();
    for message in messages {
        let message = message.get("message").unwrap_or(message);
        if message["role"] == "toolResult" {
            if let Some(id) = message["toolCallId"].as_str() {
                results.insert(id.to_owned());
            }
        }
        for part in message["content"].as_array().into_iter().flatten() {
            let id = match part["type"].as_str() {
                Some("tool_use" | "toolCall") => part["id"].as_str(),
                Some("tool_call") => part["tool_call_id"].as_str(),
                Some("tool_result") => {
                    if let Some(id) = part
                        .get("tool_use_id")
                        .or_else(|| part.get("tool_call_id"))
                        .and_then(Value::as_str)
                    {
                        results.insert(id.to_owned());
                    }
                    None
                }
                _ => None,
            };
            if let Some(id) = id {
                calls.insert(id.to_owned());
            }
        }
    }
    (calls, results)
}

/// Run one differential session and return, for every published view, the
/// tool results it serves without their calls although the transcript holds
/// both. The runner must refuse such a view (`tool_pair_split`); a runner that
/// sent it would get an HTTP 400 from Anthropic for a `tool_result` that does
/// not follow its `tool_use`. Views the provider's own pairing check withheld
/// count as well: that check is a safety net, and a view built correctly
/// never reaches it.
async fn split_tool_pairs(profile: Profile, seed: u64) -> (Vec<String>, Vec<String>) {
    let (mut pair, mut rng) = session_start(profile, seed, false).await;
    let mut checked = BTreeSet::new();
    let mut splits = Vec::new();
    for _ in 0..24 {
        pair.step(&mut rng).await;
        let source: Vec<Value> = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|entry| entry.message.clone())
            .collect();
        let (source_calls, _) = tool_ids(&source);
        for (version, raw) in pair.resident.views(&pair.reference).0 {
            if !checked.insert(version) {
                continue;
            }
            let view: view::CompactionView = serde_json::from_str(&raw).unwrap();
            let served: Vec<Value> = serde_json::from_slice(&pair.model_bytes(&view)).unwrap();
            let (calls, results) = tool_ids(&served);
            let orphans: Vec<_> = results
                .difference(&calls)
                .filter(|id| source_calls.contains(*id))
                .collect();
            if !orphans.is_empty() {
                splits.push(format!(
                    "view {version} after {:?}: results without calls {orphans:?}",
                    pair.log.last()
                ));
            }
        }
    }
    splits.extend(
        tool_arcs::withheld::take(&pair.reference)
            .into_iter()
            .map(|split| format!("withheld by the pairing check: {split}")),
    );
    (splits, pair.log.clone())
}

/// Differential seed 1199 (anthropic-messages). An acknowledged view drops
/// both sides of call181's arc. A later permitted pass serves a `[dropped]`
/// placeholder for the result (message 182), and re-anchoring the
/// acknowledged edits (`FrozenEdits::apply`) part by part restored the drop of
/// the call part alone, so views 8 to 11 served the `tool_result` for call181
/// (and call209) without its `tool_use`. Re-anchoring now completes the drop
/// of the whole arc (`tool_arcs::complete_dropped_arcs`).
#[tokio::test]
async fn stack26_seed_1199_anthropic_views_keep_tool_results_with_their_calls() {
    let (splits, log) = split_tool_pairs(Profile::Anthropic, 1199).await;
    assert!(
        splits.is_empty(),
        "{} views split a tool pair; first: {:?}; steps {log:?}",
        splits.len(),
        splits.first()
    );
}

/// Differential seed 1070 (pi): from view 2 on, call201's arc is fully
/// dropped. Dropping every part of the `toolResult` message left it served
/// with empty content and its `toolCallId`, a message field a part edit cannot
/// remove, so the history kept a result whose call was gone. The view now
/// removes the whole message (`emptied_messages::shape`).
#[tokio::test]
async fn stack26_seed_1070_pi_views_keep_tool_results_with_their_calls() {
    let (splits, log) = split_tool_pairs(Profile::Pi, 1070).await;
    assert!(
        splits.is_empty(),
        "{} views split a tool pair; first: {:?}; steps {log:?}",
        splits.len(),
        splits.first()
    );
}

/// Differential seed 1199 (anthropic-messages): views 6 and 7 dropped
/// call181's arc whole and served the `tool_result`'s user message with
/// empty content, which Anthropic rejects with HTTP 400. The message is now
/// removed, or kept as a `[dropped]` shell where removing it would make two
/// assistant messages adjacent (`emptied_messages::shape`).
#[tokio::test]
async fn stack26_seed_1199_anthropic_views_serve_no_empty_or_adjacent_messages() {
    let pair = session_pair_with(Profile::Anthropic, 1199, 24, false).await;
    let review = pair.review.borrow();
    let invalid: Vec<_> = review
        .violations
        .iter()
        .filter(|violation| violation.starts_with("EMPTY") || violation.starts_with("ADJACENT"))
        .collect();
    assert!(
        review
            .counts
            .get("views_Anthropic")
            .is_some_and(|views| *views > 0),
        "the session publishes views: {:?}",
        review.counts
    );
    assert!(
        invalid.is_empty(),
        "{} invalid messages served; first: {:?}; steps {:?}",
        invalid.len(),
        invalid.first(),
        pair.log
    );
}
