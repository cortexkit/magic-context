//! What a part costs the model. Lanes use it to weigh what a drop frees; the
//! decision to execute uses the prompt size the provider reported, never
//! these.
//!
//! A runner that holds a part's content counts it with the model family's
//! tokenizer and sends the count with the part (compaction contract W4.11);
//! the index keeps only counts in the family the runner currently names.
//! Without a count, the cost is estimated from sizes at one token per four
//! bytes.

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
            let delivered: u64 = tool
                .delivered
                .iter()
                .map(|delivered| delivered.text_bytes)
                .sum();
            bytes(tool.name.len() as u64 + input + tool.output_bytes.unwrap_or(0) + delivered)
                + attachments(tool)
        }
        PartBody::File(file) => media(file),
        PartBody::Opaque(opaque) => bytes(opaque.size.unwrap_or(0)),
        // A part kind the contract may add later: its size is unknown.
        _ => 0,
    }
}

/// What a tool part's result costs: its output and attachments, without the
/// call. `part` is the tool part holding `tool`.
pub fn tool_result(part: &Part, tool: &ToolPart) -> u64 {
    match part.tokens {
        Some(PartTokens::Tool(counted)) => counted.output,
        _ => bytes(tool.output_bytes.unwrap_or(0)) + attachments(tool),
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
}
