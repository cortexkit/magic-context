//! Token estimates for parts, from their sizes. Lanes use them to weigh what
//! a drop frees; the decision to execute uses the prompt size the provider
//! reported, never these.
//!
//! The estimate is one token per four bytes. The standalone plugin uses a
//! real tokenizer with per-model ratios; bringing that in is what makes the
//! weights match a real model, and it only changes this file.

use ck_contract_draft::part::{Part, PartBody};

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
            bytes(tool.name.len() as u64 + input + tool.output_bytes.unwrap_or(0))
                + IMAGE_TOKENS * tool.attachments.len() as u64
        }
        PartBody::Image(_) => IMAGE_TOKENS,
        PartBody::File(media) => bytes(media.size.unwrap_or(0)),
    }
}
