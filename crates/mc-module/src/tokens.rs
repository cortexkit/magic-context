//! What a part costs the model. Lanes use it to weigh what a drop frees; the
//! decision to execute uses the prompt size the provider reported, never
//! these.
//!
//! A runner that holds a part's content counts it with the model family's
//! tokenizer and sends the count with the part (compaction contract W4.11);
//! the index keeps only part and ride counts in the family the runner
//! currently names.
//! Without a count, the cost is estimated from sizes at one token per four
//! bytes.
//! Rides are module-sent text delivered alongside a tool result; replacing
//! that result also removes its rides from the model's view.

use cortexkit_role_compaction::part::{AttachmentItem, FileMedia, Part, PartBody, ToolPart};
use cortexkit_role_compaction::tokens::PartTokens;

/// What an image costs, whatever its size.
pub const IMAGE_TOKENS: u64 = 1_000;

pub fn bytes(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

/// What a part costs as the model sees it: the runner's count when it sent
/// one, else an estimate. Reasoning is counted from its visible text only;
/// [`crate::lanes`] uses the step's reported count when it has one.
pub fn part(part: &Part) -> u64 {
    match (&part.body, part.tokens) {
        // The contract's W4.11 tool output count already includes delivered text.
        (PartBody::Tool(_), Some(PartTokens::Tool(counted))) => counted.input + counted.output,
        (PartBody::Text { .. } | PartBody::File(_), Some(PartTokens::Count(counted))) => {
            counted.count
        }
        _ => estimate(part),
    }
}

fn estimate(part: &Part) -> u64 {
    match &part.body {
        PartBody::Text { text } => bytes(text.len() as u64),
        PartBody::Reasoning { text_bytes, .. } => bytes(text_bytes.unwrap_or(0)),
        PartBody::Tool(tool) => {
            let input = serde_json::to_string(&tool.input).map_or(0, |input| input.len() as u64);
            bytes(tool.name.len() as u64 + input + tool.output_bytes.unwrap_or(0))
                + attachments(tool)
                + rides(tool)
        }
        PartBody::File(file) => media(file),
        PartBody::Opaque(opaque) => bytes(opaque.size.unwrap_or(0)),
        // A part kind the contract may add later: its size is unknown.
        _ => 0,
    }
}

/// What a summary removes from the model's view of a part: text and tool
/// calls. Tool results, reasoning and media leave the prompt through their
/// own lanes (age sweep, reasoning budget, answered images), so a summary
/// does not remove them.
pub fn removed_by_summary(part: &Part) -> u64 {
    match &part.body {
        PartBody::Text { .. } => self::part(part),
        PartBody::Tool(tool) => self::part(part).saturating_sub(tool_result(part, tool)),
        _ => 0,
    }
}

/// What a tool part's result costs: its output, attachments and delivered
/// module text, without the call. `part` is the tool part holding `tool`.
pub fn tool_result(part: &Part, tool: &ToolPart) -> u64 {
    match part.tokens {
        // W4.11 includes delivered text in this full-result count already.
        Some(PartTokens::Tool(counted)) => counted.output,
        _ => bytes(tool.output_bytes.unwrap_or(0)) + attachments(tool) + rides(tool),
    }
}

/// A tool part's output alone. When it is estimated, attachments are left
/// out: the newest tool outputs kept from automatic drops are weighed by
/// their output text, as the standalone plugin weighs them.
pub fn tool_output(part: &Part, tool: &ToolPart) -> u64 {
    match part.tokens {
        Some(PartTokens::Tool(counted)) => counted.output,
        _ => bytes(tool.output_bytes.unwrap_or(0)),
    }
}

fn rides(tool: &ToolPart) -> u64 {
    // Count clearing system-note rides like tool-result rides until measured
    // provider usage is available; then follow that measured usage.
    tool.delivered
        .iter()
        .map(|ride| {
            ride.tokens
                .map_or_else(|| bytes(ride.text_bytes), |tokens| tokens.count)
        })
        .sum()
}

fn attachments(tool: &ToolPart) -> u64 {
    tool.attachments
        .iter()
        .map(|attachment| match &attachment.item {
            AttachmentItem::File(file) => media(file),
            AttachmentItem::Opaque(opaque) => bytes(opaque.size.unwrap_or(0)),
            // An item kind the contract may add later: its size is unknown.
            _ => 0,
        })
        .sum()
}

/// An image costs a fixed amount, whatever its size; other media cost their
/// bytes.
fn media(file: &FileMedia) -> u64 {
    if file.is_image() {
        IMAGE_TOKENS
    } else {
        bytes(file.size.unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use cortexkit_role_compaction::part::Delivered;
    use cortexkit_role_compaction::read::{Entry, Role};
    use cortexkit_role_compaction::tokens::TokenCount;

    fn tool(counts: Option<PartTokens>) -> Part {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id": "p0", "kind": "tool", "call_id": "c1", "name": "read",
            "input": {"path": "src/main.rs"}, "status": "completed", "digest": "d",
            "output_bytes": 4000,
        }))
        .unwrap();
        part.tokens = counts;
        part
    }

    #[test]
    fn a_tool_part_uses_the_runners_input_and_output_counts() {
        let part = tool(Some(PartTokens::tool(12, 700)));
        let PartBody::Tool(body) = &part.body else {
            unreachable!()
        };
        assert_eq!(super::part(&part), 712);
        assert_eq!(tool_result(&part, body), 700);
        assert_eq!(tool_output(&part, body), 700);
        // Without counts, its sizes are estimated.
        let part = tool(None);
        let PartBody::Tool(body) = &part.body else {
            unreachable!()
        };
        assert_eq!(tool_result(&part, body), 1000);
        assert_eq!(tool_output(&part, body), 1000);
        // A count of the wrong shape for the part is not used.
        let part = tool(Some(PartTokens::count(5)));
        assert_eq!(super::part(&part), estimate(&part));
    }

    #[test]
    fn a_summary_removes_a_tool_call_but_not_its_result() {
        assert_eq!(
            removed_by_summary(&tool(Some(PartTokens::tool(12, 700)))),
            12
        );
        let part = tool(None);
        assert_eq!(removed_by_summary(&part), super::part(&part) - 1000);
        let text: Part = serde_json::from_value(serde_json::json!({
            "id": "p1", "kind": "text", "text": "twelve bytes", "digest": "d",
        }))
        .unwrap();
        assert_eq!(removed_by_summary(&text), 3);
    }

    fn with_rides(counts: Option<PartTokens>, rides: Vec<Delivered>) -> Part {
        let mut part = tool(counts);
        let PartBody::Tool(body) = &mut part.body else {
            unreachable!()
        };
        body.delivered = rides;
        part
    }

    fn result(part: &Part) -> u64 {
        let PartBody::Tool(body) = &part.body else {
            unreachable!()
        };
        tool_result(part, body)
    }

    #[test]
    fn a_counted_tool_result_already_includes_its_rides() {
        let part = with_rides(
            Some(PartTokens::tool(12, 700)),
            vec![Delivered::new("sender", "ride").with_tokens(TokenCount::new(9))],
        );
        assert_eq!(super::part(&part), 712);
        assert_eq!(result(&part), 700);
        assert_eq!(removed_by_summary(&part), 12);
    }

    #[test]
    fn an_estimated_tool_result_adds_counted_rides() {
        let part = with_rides(
            None,
            vec![Delivered::new("sender", "ride").with_tokens(TokenCount::new(9))],
        );
        assert_eq!(super::part(&part), 1016);
        assert_eq!(result(&part), 1009);
        assert_eq!(removed_by_summary(&part), 7);
    }

    #[test]
    fn an_estimated_tool_result_adds_each_rides_text_bytes() {
        let part = with_rides(
            None,
            serde_json::from_value(serde_json::json!([
                {"sender": "sender", "text_bytes": 17},
                {"sender": "sender", "text_bytes": 1}
            ]))
            .unwrap(),
        );
        assert_eq!(super::part(&part), 1013);
        assert_eq!(result(&part), 1006);
        assert_eq!(removed_by_summary(&part), 7);
    }

    #[test]
    fn cleared_rides_keep_the_same_conservative_weight_as_tool_result_rides() {
        for counts in [None, Some(PartTokens::tool(12, 700))] {
            for ride_count in [None, Some(TokenCount::new(9))] {
                let ride: Delivered = serde_json::from_value(serde_json::json!({
                    "sender": "sender", "text_bytes": 17,
                    "forms": ["turn_system_cleared"], "tokens": ride_count,
                }))
                .unwrap();
                assert_eq!(
                    serde_json::to_value(&ride).unwrap()["forms"],
                    serde_json::json!(["turn_system_cleared"])
                );
                let part = with_rides(counts, vec![ride]);
                let output = if counts.is_some() {
                    700
                } else if ride_count.is_some() {
                    1009
                } else {
                    1005
                };
                assert_eq!(result(&part), output);
                assert_eq!(
                    super::part(&part),
                    output + if counts.is_some() { 12 } else { 7 }
                );
                assert_eq!(
                    removed_by_summary(&part),
                    if counts.is_some() { 12 } else { 7 }
                );
            }
        }
    }

    #[test]
    fn ride_counts_in_another_family_are_estimated() {
        let part = with_rides(
            None,
            vec![Delivered::new("sender", "ride").with_tokens(TokenCount::new(9))],
        );
        let mut index = Index::default();
        index.extend_counted(
            [Entry::new(1, "m1", Role::Assistant, 0, vec![part])],
            Some("family-a"),
        );
        assert_eq!(result(&index.entries()[0].parts[0]), 1009);
        index.extend_counted([], Some("family-b"));
        let part = &index.entries()[0].parts[0];
        assert_eq!(super::part(part), 1008);
        assert_eq!(result(part), 1001);
    }

    #[test]
    fn ride_counts_without_a_family_are_estimated() {
        let part = with_rides(
            None,
            vec![Delivered::new("sender", "ride").with_tokens(TokenCount::new(9))],
        );
        let mut index = Index::default();
        index.extend([Entry::new(1, "m1", Role::Assistant, 0, vec![part])]);
        let part = &index.entries()[0].parts[0];
        assert_eq!(super::part(part), 1008);
        assert_eq!(result(part), 1001);
    }

    #[test]
    fn tool_output_stays_unchanged_when_rides_are_added_to_the_result() {
        for counts in [None, Some(PartTokens::tool(12, 700))] {
            let part = with_rides(counts, vec![Delivered::new("sender", "ride")]);
            let PartBody::Tool(body) = &part.body else {
                unreachable!()
            };
            let expected = if counts.is_some() { 700 } else { 1000 };
            assert_eq!(tool_output(&part, body), expected);
            assert_eq!(result(&part), if counts.is_some() { 700 } else { 1001 });
        }
    }
}
