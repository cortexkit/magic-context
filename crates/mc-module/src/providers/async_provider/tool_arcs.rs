//! Tool calls and their results as one unit in published views.
//!
//! A model provider rejects a history in which a tool result has no call
//! before it (Anthropic answers HTTP 400), and a runner that follows the
//! compaction contract refuses such a view as `tool_pair_split`. A view edits
//! single parts, but the two sides of a tool arc live in different messages:
//! the call is a part of an assistant message, and the result is a part of a
//! later message (Anthropic, owned-broca) or a whole Pi `toolResult` message
//! whose call id is a message field. Decisions taken part by part (the
//! engine's rendering, re-anchored acknowledged edits) are therefore
//! reconciled per arc here before a view is published, and a view that still
//! separates an arc is never published.
//!
//! OpenCode tool parts carry the call and its output together, so they have
//! no arcs to reconcile.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Call,
    Result,
}

/// One side of a tool arc inside one message: the tool call id it names and
/// the indexes of the message parts that carry it.
#[derive(Clone, Debug)]
struct ArcSide {
    id: String,
    side: Side,
    parts: Vec<usize>,
}

/// What publication needs to know about one transcript message a view keeps:
/// its id, role and part keys in order, and the tool-arc sides it carries.
#[derive(Clone, Debug)]
pub(super) struct KeptMessage {
    codec: codec::Codec,
    pub(super) mid: String,
    pub(super) parts: Vec<String>,
    /// The message's role in the runner's schema (`role`, OpenCode's
    /// `info.role`, or the role of a Pi journal entry's `message`).
    pub(super) role: Option<String>,
    /// An Anthropic message whose content is one string, not a block array:
    /// its one part is that string.
    pub(super) string_content: bool,
    sides: Vec<ArcSide>,
    /// A Pi `toolResult` message. Its call id is a message field, so the
    /// message still names its call when every part is dropped; only removing
    /// the whole message removes the result.
    tool_result_message: bool,
    /// Fallbacks and reasoning that must survive together in a kept message.
    pub(super) fallback_protected: Vec<String>,
    /// Removing an earlier part would shift a retained fallback's position.
    pub(super) fallback_prefix: Vec<String>,
}

/// Kept transcript messages of one view by ordinal.
pub(super) type KeptMessages = BTreeMap<u64, KeptMessage>;

impl KeptMessage {
    pub(super) fn new(codec: codec::Codec, entry: &ReadMessage) -> Result<Self, HandlerOutcome> {
        Self::from_message(
            codec,
            &entry.mid,
            &entry.message,
            entry.tags.iter().map(|row| row.part.clone()).collect(),
        )
    }

    pub(super) fn from_message(
        codec: codec::Codec,
        mid: &str,
        message: &Value,
        parts: Vec<String>,
    ) -> Result<Self, HandlerOutcome> {
        let native = super::parts(message)?;
        let (sides, tool_result_message) = sides(codec, message, &native);
        let fallback = (codec == codec::Codec::OwnedBroca)
            .then(|| {
                native
                    .iter()
                    .rposition(|part| part["type"] == "provider_fallback")
            })
            .flatten();
        let fallback_protected = native
            .iter()
            .enumerate()
            .filter_map(|(index, part)| {
                (fallback.is_some()
                    && matches!(
                        part["type"].as_str(),
                        Some("provider_fallback" | "reasoning" | "redacted_reasoning")
                    ))
                .then(|| parts.get(index).cloned())
                .flatten()
            })
            .collect();
        let fallback_prefix = fallback.map_or_else(Vec::new, |last| {
            parts.iter().take(last + 1).cloned().collect()
        });
        Ok(Self {
            codec,
            mid: mid.to_owned(),
            parts,
            role: role(message).map(str::to_owned),
            string_content: message.get("content").is_some_and(Value::is_string),
            sides,
            tool_result_message,
            fallback_protected,
            fallback_prefix,
        })
    }
}

/// The role of a message in any of the runners' schemas.
pub(super) fn role(message: &Value) -> Option<&str> {
    message
        .get("role")
        .or_else(|| message.pointer("/info/role"))
        .or_else(|| message.pointer("/message/role"))
        .and_then(Value::as_str)
}

/// The tool-arc sides of one native message, and whether it is a Pi
/// `toolResult` message.
fn sides(codec: codec::Codec, message: &Value, native: &[Value]) -> (Vec<ArcSide>, bool) {
    if codec == codec::Codec::OpencodeAiSdk {
        return (Vec::new(), false);
    }
    // A Pi journal entry wraps the model message in `message`.
    let body = message
        .get("message")
        .filter(|body| body.is_object())
        .unwrap_or(message);
    if body.get("role").and_then(Value::as_str) == Some("toolResult") {
        let side = body
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(|id| ArcSide {
                id: id.to_owned(),
                side: Side::Result,
                parts: (0..native.len()).collect(),
            });
        return (side.into_iter().collect(), true);
    }
    let mut sides = Vec::new();
    for (index, part) in native.iter().enumerate() {
        let (side, id) = match part.get("type").and_then(Value::as_str) {
            Some("tool_use") => (Side::Call, part.get("id")),
            Some("toolCall") => (Side::Call, part.get("id").or_else(|| part.get("callId"))),
            Some("tool_call") => (Side::Call, part.get("tool_call_id")),
            Some("tool_result") => (
                Side::Result,
                part.get("tool_use_id").or_else(|| part.get("tool_call_id")),
            ),
            _ => continue,
        };
        if let Some(id) = id.and_then(Value::as_str) {
            sides.push(ArcSide {
                id: id.to_owned(),
                side,
                parts: vec![index],
            });
        }
    }
    (sides, false)
}

/// One tool arc among the kept messages: `(ordinal, index into that message's
/// sides)` of its calls and of its results.
#[derive(Default)]
struct ToolArc {
    calls: Vec<(u64, usize)>,
    results: Vec<(u64, usize)>,
}

/// Pair calls and results in transcript order. A result belongs to the newest
/// earlier call with its id, so an id a provider reuses in a later turn starts
/// a new arc instead of joining an old one. Calls with one id in one message
/// form one arc, as the engine treats them.
fn arcs(kept: &KeptMessages) -> Vec<ToolArc> {
    let mut arcs: Vec<ToolArc> = Vec::new();
    let mut open: HashMap<&str, usize> = HashMap::new();
    for (ordinal, message) in kept {
        for (index, side) in message.sides.iter().enumerate() {
            let current = open.get(side.id.as_str()).copied();
            let arc = match (side.side, current) {
                (Side::Call, Some(arc))
                    if arcs[arc].results.is_empty()
                        && arcs[arc].calls.iter().all(|(at, _)| at == ordinal) =>
                {
                    arc
                }
                (Side::Result, Some(arc)) => arc,
                _ => {
                    arcs.push(ToolArc::default());
                    open.insert(&side.id, arcs.len() - 1);
                    arcs.len() - 1
                }
            };
            let at = (*ordinal, index);
            match side.side {
                Side::Call => arcs[arc].calls.push(at),
                Side::Result => arcs[arc].results.push(at),
            }
        }
    }
    arcs
}

/// Every Keep edit by `(ordinal, part key)`.
pub(super) fn edits_by_part(ranges: &[view::ViewRange]) -> HashMap<(u64, &str), &view::PartEdit> {
    let mut by_part = HashMap::new();
    for range in ranges {
        if let view::ViewRange::Keep { edits, .. } = range {
            for edit in edits {
                by_part.insert((edit.ordinal, edit.part.as_str()), edit);
            }
        }
    }
    by_part
}

/// True when every part carrying this side is dropped. A side without parts
/// (a Pi `toolResult` with empty content) is never dropped by part edits.
fn side_dropped(
    kept: &KeptMessages,
    (ordinal, index): (u64, usize),
    edits: &HashMap<(u64, &str), &view::PartEdit>,
) -> bool {
    let message = &kept[&ordinal];
    let side = &message.sides[index];
    !side.parts.is_empty()
        && side.parts.iter().all(|part| {
            message.parts.get(*part).is_some_and(|key| {
                edits
                    .get(&(ordinal, key.as_str()))
                    .is_some_and(|edit| edit.drop)
            })
        })
}

/// Make each tool arc fully dropped when any of its sides is dropped.
///
/// Rule: a drop of either side of an arc, whether the engine's or an
/// acknowledged edit re-anchored by `FrozenEdits::apply`, drops the whole arc.
/// Re-anchoring fills each part the new pass left unedited from the view the
/// runner acknowledged; when that view dropped the arc and the new pass serves
/// a placeholder for the result, part-wise filling would serve the
/// placeholder result without its call. Completing the drop instead serves
/// exactly what the acknowledged view served for the arc, so no served
/// reduction is undone and the bytes stay what the runner already holds. The
/// other resolution, serving the call again, would restore content an
/// acknowledged view removed.
///
/// A drop added for a part the range did not edit yet goes at the end of the
/// range's edits; the caller puts them in part order afterwards (`sort_edits`).
pub(super) fn complete_dropped_arcs(kept: &KeptMessages, ranges: &mut [view::ViewRange]) {
    let mut drops: BTreeMap<u64, BTreeSet<usize>> = BTreeMap::new();
    {
        let edits = edits_by_part(ranges);
        for arc in arcs(kept) {
            if arc.calls.is_empty() || arc.results.is_empty() {
                continue;
            }
            let sides: Vec<_> = arc.calls.iter().chain(&arc.results).copied().collect();
            let dropped = sides
                .iter()
                .filter(|side| side_dropped(kept, **side, &edits))
                .count();
            if dropped == 0 || dropped == sides.len() {
                continue;
            }
            for (ordinal, index) in sides {
                drops
                    .entry(ordinal)
                    .or_default()
                    .extend(kept[&ordinal].sides[index].parts.iter().copied());
            }
        }
    }
    if drops.is_empty() {
        return;
    }
    for range in ranges {
        let view::ViewRange::Keep { from, to, edits } = range else {
            continue;
        };
        for (ordinal, parts) in drops.range(*from..*to) {
            let message = &kept[ordinal];
            for part in parts {
                let Some(key) = message.parts.get(*part) else {
                    continue;
                };
                let drop = view::PartEdit::drop(*ordinal, &message.mid, key);
                match edits
                    .iter_mut()
                    .find(|edit| edit.ordinal == *ordinal && edit.part == *key)
                {
                    Some(edit) => *edit = drop,
                    None => edits.push(drop),
                }
            }
        }
    }
}

/// Keep an acknowledged native replacement and the source sides it still
/// depends on. Dropping its companion would otherwise force arc completion to
/// replace the acknowledged bytes with a drop or a different message shell.
pub(super) fn preserve_acknowledged_arcs(
    kept: &KeptMessages,
    acknowledged: &BTreeMap<u64, Vec<view::PartEdit>>,
    ranges: &mut [view::ViewRange],
) {
    let mut protected: BTreeMap<u64, BTreeSet<&str>> = BTreeMap::new();
    let edits = edits_by_part(ranges);
    for arc in arcs(kept) {
        let sides = arc.calls.iter().chain(&arc.results);
        if !sides.clone().any(|side| side_dropped(kept, *side, &edits)) {
            continue;
        }
        let has_frozen_side = sides.clone().any(|(ordinal, index)| {
            let message = &kept[ordinal];
            let side = &message.sides[*index];
            acknowledged.get(ordinal).is_some_and(|edits| {
                edits.iter().any(|edit| {
                    !edit.drop
                        && side.parts.iter().any(|index| {
                            message
                                .parts
                                .get(*index)
                                .is_some_and(|part| part == &edit.part)
                        })
                        && (message.tool_result_message
                            || replacement_keeps_side(message.codec, edit, side))
                })
            })
        });
        if !has_frozen_side {
            continue;
        }
        for (ordinal, index) in sides {
            let message = &kept[ordinal];
            for part in &message.sides[*index].parts {
                if let Some(part) = message.parts.get(*part) {
                    protected.entry(*ordinal).or_default().insert(part);
                }
            }
        }
    }
    for range in ranges {
        let view::ViewRange::Keep { from, to, edits } = range else {
            continue;
        };
        for (ordinal, parts) in protected.range(*from..*to) {
            edits.retain(|edit| edit.ordinal != *ordinal || !parts.contains(edit.part.as_str()));
            if let Some(saved) = acknowledged.get(ordinal) {
                edits.extend(
                    saved
                        .iter()
                        .filter(|edit| parts.contains(edit.part.as_str()))
                        .cloned(),
                );
            }
        }
    }
}

fn replacement_keeps_side(codec: codec::Codec, edit: &view::PartEdit, side: &ArcSide) -> bool {
    let Some(bytes) = &edit.bytes else {
        return false;
    };
    let Ok(part) = serde_json::from_str::<Value>(bytes) else {
        return false;
    };
    let shell = json!({ "content": [part] });
    sides(codec, &shell, std::slice::from_ref(&shell["content"][0]))
        .0
        .iter()
        .any(|after| after.id == side.id && after.side == side.side)
}

/// Sort one keep range's edits as the contract requires: by ordinal, then by
/// the part's position in its message (the order of the message's part keys).
/// Part keys are opaque strings, so their string order is not the part order:
/// with keys `"0"` to `"11"`, `"10"` sorts before `"2"`. An edit whose key
/// the kept message does not list sorts first within its message, by key;
/// publication never builds such an edit.
pub(super) fn sort_edits(kept: &KeptMessages, edits: &mut [view::PartEdit]) {
    edits.sort_by_cached_key(|edit| {
        let position = kept
            .get(&edit.ordinal)
            .and_then(|message| message.parts.iter().position(|part| *part == edit.part));
        (edit.ordinal, position, edit.part.clone())
    });
}

/// The Pi `toolResult` messages a view must remove whole because their arc
/// is dropped (`emptied_messages::shape` removes them).
///
/// Part edits cannot remove the `toolCallId` a Pi `toolResult` carries on the
/// message, so dropping every part would still serve a result for a dropped
/// call. Standalone Pi serves no message at all for a fully dropped arc (the
/// Pi codec emits no `toolResult` without its result block), and a view
/// expresses that as a replace range of the one message by no messages. A
/// `toolResult` with no parts is removed when every call of its arc is
/// dropped.
///
/// The removal is derived from the call's drop on every pass. Frozen-edit
/// capture records the call's drop from the keep range, and
/// `complete_dropped_arcs` drops the result's parts again from it, so a later
/// pass serves the same bytes even after the engine forgot the reduction.
pub(super) fn dropped_tool_results(
    kept: &KeptMessages,
    edits: &HashMap<(u64, &str), &view::PartEdit>,
) -> BTreeSet<u64> {
    let mut removed = BTreeSet::new();
    for arc in arcs(kept) {
        let calls_dropped = !arc.calls.is_empty()
            && arc
                .calls
                .iter()
                .all(|call| side_dropped(kept, *call, edits));
        for (ordinal, index) in &arc.results {
            let message = &kept[ordinal];
            if !message.tool_result_message {
                continue;
            }
            let empty = message.sides[*index].parts.is_empty();
            if (empty && calls_dropped) || (!empty && side_dropped(kept, (*ordinal, *index), edits))
            {
                removed.insert(*ordinal);
            }
        }
    }
    removed
}

/// The tool arcs of the kept messages that `ranges` serve on one side only.
///
/// An arc counts when the kept transcript holds both its call and its result;
/// a result whose call the transcript itself lacks is not the view's to fix.
/// A side also counts as served when a replace range (a history head) serves
/// a message carrying it.
pub(super) fn split_pairs(
    codec: codec::Codec,
    kept: &KeptMessages,
    ranges: &[view::ViewRange],
) -> Vec<String> {
    let edits = edits_by_part(ranges);
    let mut kept_ordinals = BTreeSet::new();
    let mut replaced_calls = BTreeSet::new();
    let mut replaced_results = BTreeSet::new();
    for range in ranges {
        match range {
            view::ViewRange::Keep { from, to, .. } => {
                kept_ordinals.extend(kept.range(*from..*to).map(|(ordinal, _)| *ordinal));
            }
            view::ViewRange::Replace { bytes, .. } => {
                let messages: Vec<Value> = serde_json::from_str(bytes).unwrap_or_default();
                for message in &messages {
                    let Ok(native) = super::parts(message) else {
                        continue;
                    };
                    for side in sides(codec, message, &native).0 {
                        match side.side {
                            Side::Call => replaced_calls.insert(side.id),
                            Side::Result => replaced_results.insert(side.id),
                        };
                    }
                }
            }
            _ => {}
        }
    }
    let served = |(ordinal, index): (u64, usize)| -> bool {
        if !kept_ordinals.contains(&ordinal) {
            return false;
        }
        let message = &kept[&ordinal];
        let side = &message.sides[index];
        if message.tool_result_message {
            return true;
        }
        side.parts.iter().any(|part| {
            let Some(key) = message.parts.get(*part) else {
                return false;
            };
            match edits.get(&(ordinal, key.as_str())) {
                None => true,
                Some(edit) if edit.drop => false,
                Some(edit) => {
                    // A replacement still serves this side only if it still
                    // names the same call id on the same side.
                    replacement_keeps_side(codec, edit, side)
                }
            }
        })
    };
    let mut splits = Vec::new();
    for arc in arcs(kept) {
        let (Some(call), Some(result)) = (arc.calls.first(), arc.results.first()) else {
            continue;
        };
        let id = &kept[&call.0].sides[call.1].id;
        let call_served = arc.calls.iter().any(|side| served(*side)) || replaced_calls.contains(id);
        let result_served =
            arc.results.iter().any(|side| served(*side)) || replaced_results.contains(id);
        if call_served != result_served {
            let (present, absent) = if call_served {
                ("call", "result")
            } else {
                ("result", "call")
            };
            splits.push(format!(
                "{id}: {present} served without its {absent} (call {}, result {})",
                kept[&call.0].mid, kept[&result.0].mid
            ));
        }
    }
    splits
}

/// The splits the pairing check found in views it withheld, by session
/// reference, so tests can report a split view the provider built even though
/// the check kept it from being published.
#[cfg(test)]
pub(super) mod withheld {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    static WITHHELD: Mutex<BTreeMap<String, Vec<String>>> = Mutex::new(BTreeMap::new());

    pub(crate) fn record(reference: &str, splits: &[String]) {
        WITHHELD
            .lock()
            .unwrap()
            .entry(reference.to_owned())
            .or_default()
            .extend(splits.iter().cloned());
    }

    pub(crate) fn take(reference: &str) -> Vec<String> {
        WITHHELD
            .lock()
            .unwrap()
            .remove(reference)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kept_of(codec: codec::Codec, messages: &[Value]) -> KeptMessages {
        messages
            .iter()
            .enumerate()
            .map(|(ordinal, message)| {
                let count = super::super::parts(message).unwrap().len();
                let keys = (0..count).map(|part| part.to_string()).collect();
                let message =
                    KeptMessage::from_message(codec, &format!("m{ordinal}"), message, keys)
                        .unwrap();
                (ordinal as u64, message)
            })
            .collect()
    }

    fn keep(ordinal: u64, edits: Vec<view::PartEdit>) -> view::ViewRange {
        view::ViewRange::keep_with_edits(ordinal, ordinal + 1, edits)
    }

    /// The ranges after `emptied_messages::shape` for Pi, with nothing
    /// acknowledged.
    fn remove_emptied(kept: &KeptMessages, ranges: Vec<view::ViewRange>) -> Vec<view::ViewRange> {
        super::super::emptied_messages::shape(codec::Codec::Pi, kept, &Default::default(), ranges)
            .ranges
    }

    fn drop(ordinal: u64, part: usize) -> view::PartEdit {
        view::PartEdit::drop(ordinal, format!("m{ordinal}"), part.to_string())
    }

    fn anthropic() -> Vec<Value> {
        vec![
            json!({"role":"assistant","content":[
                {"type":"text","text":"reading"},
                {"type":"tool_use","id":"call1","name":"read","input":{"path":"a"}}]}),
            json!({"role":"user","content":[
                {"type":"tool_result","tool_use_id":"call1","content":"file a"}]}),
        ]
    }

    fn pi() -> Vec<Value> {
        vec![
            json!({"id":"m0","type":"message","message":{"role":"assistant","content":[
                {"type":"text","text":"reading"},
                {"type":"toolCall","id":"call1","name":"read","arguments":{"path":"a"}}]}}),
            json!({"id":"m1","type":"message","message":{"role":"toolResult",
                "toolCallId":"call1","toolName":"read","isError":false,
                "content":[{"type":"text","text":"file a"}]}}),
        ]
    }

    fn view_of(ranges: Vec<view::ViewRange>) -> view::CompactionView {
        let to = ranges.last().unwrap().to();
        view::CompactionView::new(
            "00000000000000000000000000000000",
            1,
            "L",
            compact::lineage::MessageRef {
                ordinal: to - 1,
                mid: format!("m{}", to - 1),
            },
            ranges,
        )
    }

    #[test]
    fn pairing_check_refuses_a_view_that_serves_a_result_without_its_call() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let split = view_of(vec![keep(0, vec![drop(0, 1)]), keep(1, vec![])]);
        let refused = checked_async_view(split, codec::Codec::AnthropicMessages, &kept)
            .unwrap()
            .expect_err("a view serving call1's result without its call is split");
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert!(
            refused[0].starts_with("call1: result served"),
            "{refused:?}"
        );
        // The other direction: the call stays and its result is dropped.
        let split = view_of(vec![keep(0, vec![]), keep(1, vec![drop(1, 0)])]);
        assert!(
            checked_async_view(split, codec::Codec::AnthropicMessages, &kept)
                .unwrap()
                .is_err()
        );
        // Both sides dropped, or both served, is a whole arc.
        let whole = view_of(vec![keep(0, vec![drop(0, 1)]), keep(1, vec![drop(1, 0)])]);
        assert!(
            checked_async_view(whole, codec::Codec::AnthropicMessages, &kept)
                .unwrap()
                .is_ok()
        );
        let intact = view_of(vec![keep(0, vec![]), keep(1, vec![])]);
        assert!(
            checked_async_view(intact, codec::Codec::AnthropicMessages, &kept)
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn pairing_check_counts_a_placeholder_result_and_a_head_copy_as_served() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let placeholder = view::PartEdit::replace(
            1,
            "m1",
            "0",
            r#"{"content":"[dropped]","tool_use_id":"call1","type":"tool_result"}"#,
        );
        let split = view_of(vec![
            keep(0, vec![drop(0, 1)]),
            keep(1, vec![placeholder.clone()]),
        ]);
        assert!(split_pairs(codec::Codec::AnthropicMessages, &kept, &split.ranges).len() == 1);
        let paired = view_of(vec![keep(0, vec![]), keep(1, vec![placeholder])]);
        assert!(split_pairs(codec::Codec::AnthropicMessages, &kept, &paired.ranges).is_empty());
        // A history head that carries the call serves it.
        let head = serde_json::to_string(&[anthropic()[0].clone()]).unwrap();
        let ranges = vec![view::ViewRange::replace(0, 1, head), keep(1, vec![])];
        assert!(split_pairs(codec::Codec::AnthropicMessages, &kept, &ranges).is_empty());
    }

    #[test]
    fn pi_pairing_check_sees_the_result_message_with_every_part_dropped() {
        let kept = kept_of(codec::Codec::Pi, &pi());
        let emptied = view_of(vec![keep(0, vec![drop(0, 1)]), keep(1, vec![drop(1, 0)])]);
        assert_eq!(
            split_pairs(codec::Codec::Pi, &kept, &emptied.ranges).len(),
            1,
            "an emptied toolResult still names call1"
        );
        let removed = view_of(vec![
            keep(0, vec![drop(0, 1)]),
            view::ViewRange::replace(1, 2, "[]"),
        ]);
        assert!(split_pairs(codec::Codec::Pi, &kept, &removed.ranges).is_empty());
    }

    #[test]
    fn a_dropped_side_drops_the_whole_arc() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let placeholder = view::PartEdit::replace(
            1,
            "m1",
            "0",
            r#"{"content":"[dropped]","tool_use_id":"call1","type":"tool_result"}"#,
        );
        let mut ranges = vec![
            keep(0, vec![drop(0, 1)]),
            keep(1, vec![placeholder.clone()]),
        ];
        complete_dropped_arcs(&kept, &mut ranges);
        assert_eq!(
            ranges,
            vec![keep(0, vec![drop(0, 1)]), keep(1, vec![drop(1, 0)])]
        );
        // A placeholder pair with no dropped side stays as it is.
        let mut ranges = vec![keep(0, vec![]), keep(1, vec![placeholder.clone()])];
        complete_dropped_arcs(&kept, &mut ranges);
        assert_eq!(ranges, vec![keep(0, vec![]), keep(1, vec![placeholder])]);
    }

    #[test]
    fn an_acknowledged_native_result_prevents_a_new_partial_arc_drop() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let placeholder = view::PartEdit::replace(
            1,
            "m1",
            "0",
            r#"{"content":"[dropped]","tool_use_id":"call1","type":"tool_result"}"#,
        );
        let acknowledged = BTreeMap::from([(1, vec![placeholder.clone()])]);
        let mut ranges = vec![
            keep(0, vec![drop(0, 1)]),
            keep(1, vec![placeholder.clone()]),
        ];
        preserve_acknowledged_arcs(&kept, &acknowledged, &mut ranges);
        complete_dropped_arcs(&kept, &mut ranges);
        assert_eq!(ranges, vec![keep(0, vec![]), keep(1, vec![placeholder])]);
        assert!(split_pairs(codec::Codec::AnthropicMessages, &kept, &ranges).is_empty());
    }

    #[test]
    fn an_acknowledged_text_shell_does_not_preserve_its_old_tool_call() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let shell = view::PartEdit::replace(1, "m1", "0", r#"{"type":"text","text":"[dropped]"}"#);
        let acknowledged = BTreeMap::from([(1, vec![shell.clone()])]);
        let mut ranges = vec![keep(0, vec![drop(0, 1)]), keep(1, vec![shell.clone()])];
        preserve_acknowledged_arcs(&kept, &acknowledged, &mut ranges);
        assert_eq!(
            ranges,
            vec![keep(0, vec![drop(0, 1)]), keep(1, vec![shell])]
        );
    }

    #[test]
    fn a_new_native_call_redaction_can_coexist_with_an_acknowledged_result() {
        let kept = kept_of(codec::Codec::AnthropicMessages, &anthropic());
        let result = view::PartEdit::replace(
            1,
            "m1",
            "0",
            r#"{"content":"[dropped]","tool_use_id":"call1","type":"tool_result"}"#,
        );
        let call = view::PartEdit::replace(
            0,
            "m0",
            "1",
            r#"{"type":"tool_use","id":"call1","name":"read","input":{"path":"[dropped]"}}"#,
        );
        let acknowledged = BTreeMap::from([(1, vec![result.clone()])]);
        let expected = vec![keep(0, vec![call]), keep(1, vec![result])];
        let mut ranges = expected.clone();
        preserve_acknowledged_arcs(&kept, &acknowledged, &mut ranges);
        assert_eq!(ranges, expected);
    }

    #[test]
    fn a_reused_call_id_pairs_with_its_own_turn() {
        let mut messages = anthropic();
        messages.extend(anthropic());
        let kept = kept_of(codec::Codec::AnthropicMessages, &messages);
        // The first turn is dropped whole; the second turn reuses call1.
        let mut ranges = vec![
            keep(0, vec![drop(0, 1)]),
            keep(1, vec![drop(1, 0)]),
            keep(2, vec![]),
            keep(3, vec![]),
        ];
        let before = ranges.clone();
        complete_dropped_arcs(&kept, &mut ranges);
        assert_eq!(ranges, before);
        assert!(split_pairs(codec::Codec::AnthropicMessages, &kept, &ranges).is_empty());
    }

    #[test]
    fn a_fully_dropped_pi_result_message_is_removed_whole() {
        let kept = kept_of(codec::Codec::Pi, &pi());
        let ranges = remove_emptied(
            &kept,
            vec![keep(0, vec![drop(0, 1)]), keep(1, vec![drop(1, 0)])],
        );
        assert_eq!(
            ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                view::ViewRange::replace(1, 2, "[]")
            ]
        );
        // Inside a longer keep range, the range is split around the message.
        let mut messages = pi();
        messages
            .push(json!({"id":"m2","type":"message","message":{"role":"user","content":[{"type":"text","text":"next"}]}}));
        let kept = kept_of(codec::Codec::Pi, &messages);
        let ranges = remove_emptied(
            &kept,
            vec![view::ViewRange::keep_with_edits(
                0,
                3,
                vec![drop(0, 1), drop(1, 0)],
            )],
        );
        assert_eq!(
            ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                view::ViewRange::replace(1, 2, "[]"),
                view::ViewRange::keep(2, 3),
            ]
        );
        assert!(split_pairs(codec::Codec::Pi, &kept, &ranges).is_empty());
    }

    #[test]
    fn a_pi_result_without_its_call_dropped_is_kept() {
        let kept = kept_of(codec::Codec::Pi, &pi());
        let placeholder =
            view::PartEdit::replace(1, "m1", "0", r#"{"type":"text","text":"[dropped]"}"#);
        let ranges = vec![keep(0, vec![]), keep(1, vec![placeholder])];
        assert_eq!(remove_emptied(&kept, ranges.clone()), ranges);
    }
}
