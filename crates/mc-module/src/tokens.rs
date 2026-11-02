//! Token estimates for parts, from their sizes. Lanes use them to weigh what
//! a drop frees; the decision to execute uses the prompt size the provider
//! reported, never these.
//!
//! The estimate is one token per four bytes. The standalone plugin uses a
//! real tokenizer with per-model ratios; bringing that in is what makes the
//! weights match a real model, and it only changes this file.

use cortexkit_role_compaction::part::{AttachmentItem, FileMedia, Part, PartBody, ToolPart};

/// What an image costs, whatever its size.
pub const IMAGE_TOKENS: u64 = 1_000;

pub fn bytes(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

/// What a part costs as the model sees it. Reasoning is counted from its
/// visible text only; [`crate::lanes`] uses the provider's reported count
/// when it has one.
pub fn part(part: &Part) -> u64 {
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
/// call.
pub fn tool_result(tool: &ToolPart) -> u64 {
    bytes(tool.output_bytes.unwrap_or(0)) + attachments(tool)
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
