//! Optional cache-safety tests of how an emptied Anthropic user message is
//! served at the end of a view's coverage. They change no provider policy and
//! run only with `MC_REVIEW_CARD=1`; until the behaviour is fixed they fail.
//!
//! A view covers the transcript through its newest message when it is
//! published, and the runner sends every later message after the view's
//! ranges as it is. `emptied_messages::shells` decides whether an emptied
//! Anthropic user message is removed or kept as a `[dropped]` shell from its
//! neighbours inside the view's ranges only.
use super::*;

fn review_card() -> bool {
    std::env::var("MC_REVIEW_CARD").is_ok_and(|value| value == "1")
}

fn adjacent_assistants(messages: &[Value]) -> Vec<usize> {
    messages
        .windows(2)
        .enumerate()
        .filter(|(_, two)| two.iter().all(|m| tool_arcs::role(m) == Some("assistant")))
        .map(|(index, _)| index)
        .collect()
}

/// Kept Anthropic messages `m0..` with part keys "0", "1", ... and the held
/// entries a frozen-edit capture reads.
fn anthropic(messages: &[Value]) -> (tool_arcs::KeptMessages, BTreeMap<u64, Arc<HeldEntry>>) {
    let mut kept = BTreeMap::new();
    let mut held = BTreeMap::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let count = parts(message).unwrap().len();
        let entry = ReadMessage::new(ordinal as u64, format!("m{ordinal}"), message.clone())
            .with_tags(
                (0..count)
                    .map(|part| tags::PartTag::untagged(part.to_string()))
                    .collect(),
            );
        kept.insert(
            ordinal as u64,
            tool_arcs::KeptMessage::new(codec::Codec::AnthropicMessages, &entry).unwrap(),
        );
        held.insert(
            ordinal as u64,
            Arc::new(HeldEntry::from_read(&entry).unwrap()),
        );
    }
    (kept, held)
}

/// What the runner sends: `ranges` over `messages`, then every message
/// after the view's coverage (`covered` messages) as it is.
fn sent(messages: &[Value], ranges: &[view::ViewRange], covered: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for range in ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                out.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
            }
            view::ViewRange::Keep { from, to, edits } => {
                for ordinal in *from..*to {
                    let mut message = messages[ordinal as usize].clone();
                    let mut after = Vec::new();
                    for (index, part) in parts(&message).unwrap().iter().enumerate() {
                        match edits
                            .iter()
                            .find(|edit| edit.ordinal == ordinal && edit.part == index.to_string())
                        {
                            None => after.push(part.clone()),
                            Some(edit) => {
                                if let Some(bytes) = &edit.bytes {
                                    after.push(serde_json::from_str(bytes).unwrap());
                                }
                            }
                        }
                    }
                    message["content"] = json!(after);
                    out.push(message);
                }
            }
            _ => panic!("unknown range"),
        }
    }
    out.extend(messages[covered..].iter().cloned());
    out
}

/// Witness: an emptied Anthropic user message at the end of a view's
/// coverage, after an assistant message, is removed because nothing follows
/// it inside the view (`emptied_messages::shells` reads only the view's
/// ranges). The answer that arrives next is an assistant message, so what
/// the runner sends under that acknowledged view has two adjacent assistants,
/// and the next view, which sees the answer inside its ranges, serves the
/// removed message as a `[dropped]` shell: bytes after the call's assistant
/// message change although the runner acknowledged the removal. Both
/// properties hold only if the first view already serves the shell.
#[test]
fn card_review_emptied_message_at_the_end_of_coverage_keeps_turns_alternating_and_bytes_stable() {
    if !review_card() {
        return;
    }
    let messages = vec![
        json!({"role":"user","content":"read a"}),
        json!({"role":"assistant","content":[
            {"type":"text","text":"reading"},
            {"type":"tool_use","id":"call1","name":"read","input":{"path":"a"}}]}),
        json!({"role":"user","content":[
            {"type":"tool_result","tool_use_id":"call1","content":"file a"}]}),
        json!({"role":"assistant","content":[{"type":"text","text":"done"}]}),
    ];
    let codec = codec::Codec::AnthropicMessages;
    let keep = |ordinal: u64, edits: Vec<view::PartEdit>| {
        view::ViewRange::keep_with_edits(ordinal, ordinal + 1, edits)
    };
    let drop =
        |ordinal: u64, part: &str| view::PartEdit::drop(ordinal, format!("m{ordinal}"), part);
    // The first view covers m0..=m2 and drops call1's whole arc.
    let (kept, held) = anthropic(&messages[..3]);
    let first = emptied_messages::shape(
        codec,
        &kept,
        &Default::default(),
        vec![
            keep(0, vec![]),
            keep(1, vec![drop(1, "1")]),
            keep(2, vec![drop(2, "0")]),
        ],
    );
    // The runner acknowledged it: its served edits, the removed message's
    // drops included, are frozen.
    let mut acknowledged = frozen_edits::FrozenEdits::default();
    for range in &first.ranges {
        if let view::ViewRange::Keep { edits, .. } = range {
            acknowledged.capture_edits(edits, &held).unwrap();
        }
    }
    acknowledged.capture_edits(&first.removed, &held).unwrap();
    // The answer m3 arrives after the view's coverage.
    let under_first = sent(&messages, &first.ranges, 3);
    let adjacent = adjacent_assistants(&under_first);
    // The next pass covers m0..=m3 with the same edits.
    let (kept, _) = anthropic(&messages);
    let next = emptied_messages::shape(
        codec,
        &kept,
        &acknowledged,
        vec![
            keep(0, vec![]),
            keep(1, vec![drop(1, "1")]),
            keep(2, vec![drop(2, "0")]),
            keep(3, vec![]),
        ],
    );
    let served_m2 = |ranges: &[view::ViewRange]| {
        ranges
            .iter()
            .find(|range| {
                range.to() == 3
                    && matches!(
                        range,
                        view::ViewRange::Replace { from: 2, .. }
                            | view::ViewRange::Keep { from: 2, .. }
                    )
            })
            .cloned()
    };
    assert!(
        adjacent.is_empty() && served_m2(&first.ranges) == served_m2(&next.ranges),
        "under the acknowledged first view the runner sends adjacent assistants at {adjacent:?}; m2 was served as {:?} and the next view serves it as {:?}",
        served_m2(&first.ranges),
        served_m2(&next.ranges)
    );
}
