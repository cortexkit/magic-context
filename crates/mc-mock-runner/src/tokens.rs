//! How the mock model providers count tokens. It only has to be deterministic
//! and roughly proportional to size, like a real tokenizer: a compaction
//! provider has its own estimator and calibrates it against the prompt sizes
//! the providers report, which is what these counts become.

use ck_contract_draft::part::{Part, PartBody};
use ck_contract_draft::view::RenderedMessage;

/// Tokens for an image, whatever its size.
pub const IMAGE_TOKENS: u64 = 1_000;

/// Tokens for a piece of text: one per four bytes, rounded up.
pub fn text_tokens(text: &str) -> u64 {
    bytes_tokens(text.len() as u64)
}

pub fn bytes_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

/// Tokens a full part costs in a request. Reasoning costs what the model
/// reported when it produced it, which the caller supplies, because encrypted
/// reasoning has no text to count.
pub fn part_tokens(part: &Part, reasoning_tokens: impl Fn(&str) -> u64) -> u64 {
    match &part.body {
        PartBody::Text { text } => text_tokens(text),
        PartBody::Reasoning { .. } => reasoning_tokens(&part.id),
        PartBody::Tool(tool) => {
            let input = serde_json::to_string(&tool.input).expect("tool input serializes");
            let output = tool.output.as_deref().map_or(0, text_tokens);
            let attachments: u64 = tool
                .attachments
                .iter()
                .map(|attachment| media_tokens(&attachment.media.mime, attachment.media.size))
                .sum();
            text_tokens(&tool.name) + text_tokens(&input) + output + attachments
        }
        PartBody::Image(media) | PartBody::File(media) => media_tokens(&media.mime, media.size),
    }
}

fn media_tokens(mime: &str, size: Option<u64>) -> u64 {
    if mime.starts_with("image/") {
        IMAGE_TOKENS
    } else {
        bytes_tokens(size.unwrap_or(0))
    }
}

/// Tokens for a whole rendered message list.
pub fn messages_tokens(
    messages: &[RenderedMessage],
    reasoning_tokens: impl Fn(&str) -> u64 + Copy,
) -> u64 {
    messages
        .iter()
        .flat_map(|message| &message.parts)
        .map(|part| part_tokens(part, reasoning_tokens))
        .sum()
}
