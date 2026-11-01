//! Kept messages a view leaves with no parts.
//!
//! A view edits single parts, so a message whose every part is dropped would
//! still be sent, with empty content: an engine pass that removed the message
//! (a fully dropped tool arc, say) reaches the view as a drop of each of its
//! parts. Model providers reject that shape; Anthropic answers HTTP 400 for a
//! message with empty content. Standalone Magic Context sends no message at
//! all there: the Rust transform omits a projected transcript message left
//! with no content (`transform.rs`, the `present` test where served messages
//! are built), the Pi codec emits no `toolResult` without its result block,
//! and the OpenCode plugin omits a message left with no parts when the
//! payload goes back to the host. A view does the same with a replace range
//! of the one message by no messages (`[]`).
//!
//! Anthropic alone also needs user and assistant turns to alternate: two
//! adjacent assistant messages are invalid there, and the Claude Code
//! gateway refuses them. Removing a user message between two assistants
//! would create that, so such a message keeps its shell with one `[dropped]`
//! text part instead, the shape the OpenCode plugin serves for a dropped
//! user message for the same reason. Once a runner acknowledged that shell,
//! later views keep serving it, so a neighbour's later removal does not
//! change bytes already served for this message.
use super::*;

/// The part a kept Anthropic user message is served with when all its parts
/// are dropped and removing it would join two assistant messages: one text
/// block, or one string for a message whose content is a string.
const DROPPED_SHELL: &str = r#"{"type":"text","text":"[dropped]"}"#;
const DROPPED_SHELL_STRING: &str = r#""[dropped]""#;

/// The view ranges after removing emptied messages, and the drops those
/// messages had, which publication captures as served edits.
pub(super) struct Shaped {
    pub(super) ranges: Vec<view::ViewRange>,
    pub(super) removed: Vec<view::PartEdit>,
}

/// One message of the served history, in order.
enum Slot<'a> {
    Served(Option<String>),
    Emptied(u64, &'a tool_arcs::KeptMessage),
}

/// The edit that turns the first part of an emptied Anthropic user message
/// into the `[dropped]` shell.
fn shell_edit(ordinal: u64, message: &tool_arcs::KeptMessage) -> Option<view::PartEdit> {
    let part = message.parts.first()?;
    let bytes = if message.string_content {
        DROPPED_SHELL_STRING
    } else {
        DROPPED_SHELL
    };
    Some(view::PartEdit::replace(ordinal, &message.mid, part, bytes))
}

/// Remove every kept message whose parts the view all drops, and every Pi
/// `toolResult` whose arc it drops (`tool_arcs::dropped_tool_results`).
/// For Anthropic, keep a user message as a `[dropped]` shell instead when its
/// removal would make two assistant messages adjacent, or when a view the
/// runner acknowledged (`acknowledged`) already served that shell.
pub(super) fn shape(
    codec: codec::Codec,
    kept: &tool_arcs::KeptMessages,
    acknowledged: &frozen_edits::FrozenEdits,
    ranges: Vec<view::ViewRange>,
) -> Shaped {
    let (removed, shells) = {
        let edits = tool_arcs::edits_by_part(&ranges);
        let mut emptied = tool_arcs::dropped_tool_results(kept, &edits);
        for range in &ranges {
            let view::ViewRange::Keep { from, to, .. } = range else {
                continue;
            };
            for (ordinal, message) in kept.range(*from..*to) {
                if !message.parts.is_empty()
                    && message.parts.iter().all(|part| {
                        edits
                            .get(&(*ordinal, part.as_str()))
                            .is_some_and(|edit| edit.drop)
                    })
                {
                    emptied.insert(*ordinal);
                }
            }
        }
        let shells = if codec == codec::Codec::AnthropicMessages {
            shells(kept, acknowledged, &ranges, &emptied)
        } else {
            BTreeMap::new()
        };
        emptied.retain(|ordinal| !shells.contains_key(ordinal));
        (emptied, shells)
    };
    if removed.is_empty() && shells.is_empty() {
        return Shaped {
            ranges,
            removed: Vec::new(),
        };
    }
    let mut out = Vec::with_capacity(ranges.len() + removed.len() * 2);
    let mut dropped = Vec::new();
    for range in ranges {
        let view::ViewRange::Keep {
            from,
            to,
            mut edits,
        } = range
        else {
            out.push(range);
            continue;
        };
        for edit in &mut edits {
            if let Some(shell) = shells
                .get(&edit.ordinal)
                .filter(|shell| shell.part == edit.part)
            {
                *edit = shell.clone();
            }
        }
        let mut start = from;
        for ordinal in removed.range(from..to).copied() {
            if start < ordinal {
                out.push(view::ViewRange::keep_with_edits(
                    start,
                    ordinal,
                    edits_in(&edits, start, ordinal),
                ));
            }
            out.push(view::ViewRange::replace(ordinal, ordinal + 1, "[]"));
            dropped.extend(edits_in(&edits, ordinal, ordinal + 1));
            start = ordinal + 1;
        }
        if start < to {
            out.push(view::ViewRange::keep_with_edits(
                start,
                to,
                edits_in(&edits, start, to),
            ));
        }
    }
    Shaped {
        ranges: out,
        removed: dropped,
    }
}

/// The emptied Anthropic user messages to serve as `[dropped]` shells, with
/// the edit of the first part that makes each one.
///
/// The served history is walked in order, deciding each emptied message as
/// it is reached: a user message whose nearest served neighbours on both
/// sides are assistants becomes a shell, and so does one an acknowledged view
/// already served as a shell. Every other emptied message is removed. A
/// later emptied message sees the earlier ones as decided, so of several
/// emptied user messages between two assistants only the first is kept.
fn shells(
    kept: &tool_arcs::KeptMessages,
    acknowledged: &frozen_edits::FrozenEdits,
    ranges: &[view::ViewRange],
    emptied: &BTreeSet<u64>,
) -> BTreeMap<u64, view::PartEdit> {
    let mut history = Vec::new();
    for range in ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                let messages: Vec<Value> = serde_json::from_str(bytes).unwrap_or_default();
                history.extend(
                    messages
                        .iter()
                        .map(|message| Slot::Served(tool_arcs::role(message).map(str::to_owned))),
                );
            }
            view::ViewRange::Keep { from, to, .. } => {
                for (ordinal, message) in kept.range(*from..*to) {
                    history.push(if emptied.contains(ordinal) {
                        Slot::Emptied(*ordinal, message)
                    } else {
                        Slot::Served(message.role.clone())
                    });
                }
            }
            _ => {}
        }
    }
    let mut shells = BTreeMap::new();
    let mut previous: Option<String> = None;
    for (index, slot) in history.iter().enumerate() {
        let (ordinal, message) = match slot {
            Slot::Served(role) => {
                previous = role.clone();
                continue;
            }
            Slot::Emptied(ordinal, message) => (*ordinal, *message),
        };
        if message.role.as_deref() != Some("user") {
            continue;
        }
        let Some(shell) = shell_edit(ordinal, message) else {
            continue;
        };
        let next = history[index + 1..].iter().find_map(|slot| match slot {
            Slot::Served(role) => Some(role.as_deref()),
            Slot::Emptied(..) => None,
        });
        let served = acknowledged.served(
            &message.mid,
            &shell.part,
            shell.bytes.as_deref().unwrap_or_default(),
        );
        if served || (is_assistant(previous.as_deref()) && next.is_some_and(is_assistant)) {
            shells.insert(ordinal, shell);
            previous = Some("user".to_owned());
        }
    }
    shells
}

fn is_assistant(role: Option<&str>) -> bool {
    role == Some("assistant")
}

fn edits_in(edits: &[view::PartEdit], from: u64, to: u64) -> Vec<view::PartEdit> {
    edits
        .iter()
        .filter(|edit| edit.ordinal >= from && edit.ordinal < to)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kept messages with part keys "0", "1", ... and mids "m0", "m1", ....
    fn kept_of(codec: codec::Codec, messages: &[Value]) -> tool_arcs::KeptMessages {
        messages
            .iter()
            .enumerate()
            .map(|(ordinal, message)| {
                let count = parts(message).unwrap().len();
                let keys = (0..count).map(|part| part.to_string()).collect();
                let message = tool_arcs::KeptMessage::from_message(
                    codec,
                    &format!("m{ordinal}"),
                    message,
                    keys,
                )
                .unwrap();
                (ordinal as u64, message)
            })
            .collect()
    }

    fn keep(ordinal: u64, edits: Vec<view::PartEdit>) -> view::ViewRange {
        view::ViewRange::keep_with_edits(ordinal, ordinal + 1, edits)
    }

    fn drop(ordinal: u64, part: usize) -> view::PartEdit {
        view::PartEdit::drop(ordinal, format!("m{ordinal}"), part.to_string())
    }

    fn shell(ordinal: u64) -> view::PartEdit {
        view::PartEdit::replace(ordinal, format!("m{ordinal}"), "0", DROPPED_SHELL)
    }

    /// The history a runner sends for `ranges` over `messages`, in the
    /// messages' own schema (`content`, OpenCode `parts`, or the `content`
    /// of a Pi journal entry's `message`).
    fn served(messages: &[Value], ranges: &[view::ViewRange]) -> Vec<Value> {
        let mut out = Vec::new();
        for range in ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    out.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
                }
                view::ViewRange::Keep { from, to, edits } => {
                    for ordinal in *from..*to {
                        let mut message = messages[ordinal as usize].clone();
                        let before = parts(&message).unwrap().into_owned();
                        let mut after = Vec::new();
                        for (index, part) in before.into_iter().enumerate() {
                            match edits.iter().find(|edit| {
                                edit.ordinal == ordinal && edit.part == index.to_string()
                            }) {
                                None => after.push(part),
                                Some(edit) if edit.drop => {}
                                Some(edit) => after.push(
                                    serde_json::from_str(edit.bytes.as_deref().unwrap()).unwrap(),
                                ),
                            }
                        }
                        if message.get("parts").is_some() {
                            message["parts"] = json!(after);
                        } else if message.get("message").is_some() {
                            message["message"]["content"] = json!(after);
                        } else {
                            message["content"] = json!(after);
                        }
                        out.push(message);
                    }
                }
                _ => panic!("unknown range"),
            }
        }
        out
    }

    /// No served message has empty content, and no two assistant messages
    /// are adjacent.
    fn assert_valid(history: &[Value]) {
        for message in history {
            let body = message.get("message").unwrap_or(message);
            let content = message.get("parts").or_else(|| body.get("content"));
            assert!(
                content
                    .and_then(Value::as_array)
                    .is_none_or(|parts| !parts.is_empty()),
                "a message with empty content is served: {message}"
            );
        }
        for pair in history.windows(2) {
            assert!(
                !(tool_arcs::role(&pair[0]) == Some("assistant")
                    && tool_arcs::role(&pair[1]) == Some("assistant")),
                "two assistant messages are adjacent: {pair:?}"
            );
        }
    }

    fn anthropic_turn(after: Value) -> Vec<Value> {
        vec![
            json!({"role":"assistant","content":[
                {"type":"text","text":"reading"},
                {"type":"tool_use","id":"call1","name":"read","input":{"path":"a"}}]}),
            json!({"role":"user","content":[
                {"type":"tool_result","tool_use_id":"call1","content":"file a"}]}),
            after,
        ]
    }

    fn whole_arc_drop() -> Vec<view::ViewRange> {
        vec![
            keep(0, vec![drop(0, 1)]),
            keep(1, vec![drop(1, 0)]),
            keep(2, vec![]),
        ]
    }

    #[test]
    fn an_emptied_anthropic_tool_result_message_is_removed() {
        let messages =
            anthropic_turn(json!({"role":"user","content":[{"type":"text","text":"next"}]}));
        let codec = codec::Codec::AnthropicMessages;
        let kept = kept_of(codec, &messages);
        let shaped = shape(codec, &kept, &Default::default(), whole_arc_drop());
        assert_eq!(
            shaped.ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                view::ViewRange::replace(1, 2, "[]"),
                keep(2, vec![]),
            ]
        );
        assert_eq!(shaped.removed, vec![drop(1, 0)]);
        assert_valid(&served(&messages, &shaped.ranges));
        assert!(tool_arcs::split_pairs(codec, &kept, &shaped.ranges).is_empty());
    }

    #[test]
    fn an_emptied_anthropic_user_message_between_assistants_keeps_a_dropped_shell() {
        let messages =
            anthropic_turn(json!({"role":"assistant","content":[{"type":"text","text":"done"}]}));
        let codec = codec::Codec::AnthropicMessages;
        let kept = kept_of(codec, &messages);
        let shaped = shape(codec, &kept, &Default::default(), whole_arc_drop());
        assert_eq!(
            shaped.ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                keep(1, vec![shell(1)]),
                keep(2, vec![]),
            ]
        );
        assert!(shaped.removed.is_empty());
        assert_valid(&served(&messages, &shaped.ranges));
        assert!(tool_arcs::split_pairs(codec, &kept, &shaped.ranges).is_empty());
        // An emptied assistant message is removed: that joins no assistants.
        let shaped = shape(
            codec,
            &kept,
            &Default::default(),
            vec![
                keep(0, vec![drop(0, 0), drop(0, 1)]),
                keep(1, vec![drop(1, 0)]),
                keep(2, vec![]),
            ],
        );
        assert_eq!(
            shaped.ranges,
            vec![
                view::ViewRange::replace(0, 1, "[]"),
                view::ViewRange::replace(1, 2, "[]"),
                keep(2, vec![]),
            ]
        );
        assert_valid(&served(&messages, &shaped.ranges));
    }

    /// A shell an acknowledged view served stays a shell when its removal
    /// would no longer join two assistants, so its served bytes do not change.
    #[test]
    fn a_dropped_shell_the_runner_acknowledged_stays() {
        let messages =
            anthropic_turn(json!({"role":"user","content":[{"type":"text","text":"next"}]}));
        let codec = codec::Codec::AnthropicMessages;
        let kept = kept_of(codec, &messages);
        let entry = ReadMessage::new(1, "m1", messages[1].clone())
            .with_tags(vec![tags::PartTag::untagged("0")]);
        let entries = BTreeMap::from([(1, Arc::new(HeldEntry::from_read(&entry).unwrap()))]);
        let mut acknowledged = frozen_edits::FrozenEdits::default();
        acknowledged.capture_edits(&[shell(1)], &entries).unwrap();
        let shaped = shape(codec, &kept, &acknowledged, whole_arc_drop());
        assert_eq!(
            shaped.ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                keep(1, vec![shell(1)]),
                keep(2, vec![]),
            ]
        );
        assert_valid(&served(&messages, &shaped.ranges));
    }

    #[test]
    fn an_emptied_broca_tool_message_is_removed() {
        let messages = vec![
            json!({"role":"assistant","content":[
                {"type":"text","text":"reading"},
                {"type":"tool_call","tool_call_id":"call1","tool_name":"read","input":{}}]}),
            json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"call1",
                "output":{"kind":"text","text":"file a"},"is_error":false}]}),
            json!({"role":"user","content":[{"type":"text","text":"next"}]}),
        ];
        let codec = codec::Codec::OwnedBroca;
        let kept = kept_of(codec, &messages);
        let shaped = shape(codec, &kept, &Default::default(), whole_arc_drop());
        assert_eq!(
            shaped.ranges,
            vec![
                keep(0, vec![drop(0, 1)]),
                view::ViewRange::replace(1, 2, "[]"),
                keep(2, vec![]),
            ]
        );
        assert_valid(&served(&messages, &shaped.ranges));
        assert!(tool_arcs::split_pairs(codec, &kept, &shaped.ranges).is_empty());
    }

    #[test]
    fn an_emptied_pi_user_message_is_removed() {
        let entry = |id: &str, body: Value| json!({"type":"message","id":id,"message":body});
        let messages = vec![
            entry(
                "m0",
                json!({"role":"user","content":[{"type":"text","text":"pasted log"}]}),
            ),
            entry(
                "m1",
                json!({"role":"assistant","content":[{"type":"text","text":"ok"}]}),
            ),
        ];
        let codec = codec::Codec::Pi;
        let kept = kept_of(codec, &messages);
        let shaped = shape(
            codec,
            &kept,
            &Default::default(),
            vec![keep(0, vec![drop(0, 0)]), keep(1, vec![])],
        );
        assert_eq!(
            shaped.ranges,
            vec![view::ViewRange::replace(0, 1, "[]"), keep(1, vec![])]
        );
        assert_eq!(shaped.removed, vec![drop(0, 0)]);
        assert_valid(&served(&messages, &shaped.ranges));
    }

    #[test]
    fn an_emptied_opencode_message_is_removed() {
        let messages = vec![
            json!({"info":{"id":"m0","role":"user"},"parts":[{"id":"p0","type":"text","text":"go"}]}),
            json!({"info":{"id":"m1","role":"assistant"},"parts":[
                {"id":"p1","type":"tool","tool":"read","callID":"call1",
                 "state":{"status":"completed","input":{},"output":"file a"}}]}),
            json!({"info":{"id":"m2","role":"user"},"parts":[{"id":"p2","type":"text","text":"next"}]}),
        ];
        let codec = codec::Codec::OpencodeAiSdk;
        let kept = kept_of(codec, &messages);
        let shaped = shape(
            codec,
            &kept,
            &Default::default(),
            vec![keep(0, vec![]), keep(1, vec![drop(1, 0)]), keep(2, vec![])],
        );
        assert_eq!(
            shaped.ranges,
            vec![
                keep(0, vec![]),
                view::ViewRange::replace(1, 2, "[]"),
                keep(2, vec![]),
            ]
        );
        assert_valid(&served(&messages, &shaped.ranges));
    }

    /// The shell of a string-content user message is a string part.
    #[test]
    fn a_string_content_shell_is_a_string() {
        let messages = vec![
            json!({"role":"assistant","content":[{"type":"text","text":"a"}]}),
            json!({"role":"user","content":"pasted log"}),
            json!({"role":"assistant","content":[{"type":"text","text":"b"}]}),
        ];
        let codec = codec::Codec::AnthropicMessages;
        let kept = kept_of(codec, &messages);
        let shaped = shape(
            codec,
            &kept,
            &Default::default(),
            vec![keep(0, vec![]), keep(1, vec![drop(1, 0)]), keep(2, vec![])],
        );
        assert_eq!(
            shaped.ranges[1],
            keep(
                1,
                vec![view::PartEdit::replace(1, "m1", "0", DROPPED_SHELL_STRING)]
            )
        );
    }
}
