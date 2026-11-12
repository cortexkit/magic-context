//! Reply-only shaping: stored transcripts, memories and notes stay unchanged.

use cortexkit_role_tool_provider::result::{
    legacy_model_visible_bytes, ContentPart, ToolResult, MAX_MODEL_VISIBLE_BYTES,
};

/// ck-mc also serves consumers without a negotiated result format. Account
/// for the legacy JSON envelope and escaping as well as the decoded text.
pub(crate) fn bytes(text: &str) -> usize {
    let mut result = ToolResult::new(vec![ContentPart::text(text)]);
    result.is_error = Some(true);
    legacy_model_visible_bytes(&serde_json::to_value(result).expect("tool result serializes"))
}

/// Keep the beginning and conclusion of an oversized item. The marker is
/// budgeted before choosing UTF-8 boundaries, so wrappers never push a reply
/// past the contract's model-visible byte limit.
pub(crate) fn within(text: String, limit: usize) -> String {
    if bytes(&text) <= limit {
        return text;
    }
    let mut low = 0;
    let mut high = text.len().min(limit);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if bytes(&cut_middle(&text, mid)) <= limit {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    cut_middle(&text, low)
}

fn cut_middle(text: &str, limit: usize) -> String {
    let marker_budget = format!(
        "\n[… {} bytes omitted here; the original is stored unchanged …]\n",
        usize::MAX
    )
    .len();
    let kept = limit.saturating_sub(marker_budget);
    let mut head = kept * 3 / 4;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - (kept - head);
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    let omitted = tail - head;
    format!(
        "{}\n[… {omitted} bytes omitted here; the original is stored unchanged …]\n{}",
        &text[..head],
        &text[tail..]
    )
}

pub(crate) fn bounded(text: String) -> String {
    within(text, MAX_MODEL_VISIBLE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_tool_provider::result::{model_visible_bytes, ContentPart, ToolResult};

    #[test]
    fn single_item_keeps_both_utf8_ends_and_counts_the_omitted_bytes() {
        let original = format!("BEGIN{}END", "🦀界".repeat(30_000));
        assert!(original.len() > 200_000);
        let shaped = bounded(original.clone());
        let (head, rest) = shaped.split_once("\n[… ").unwrap();
        let (count, rest) = rest.split_once(" bytes omitted here; ").unwrap();
        let (_, tail) = rest.split_once(" …]\n").unwrap();
        assert!(original.starts_with(head));
        assert!(original.ends_with(tail));
        assert_eq!(
            count.parse::<usize>().unwrap(),
            original.len() - head.len() - tail.len()
        );
        assert!(head.len().abs_diff(tail.len() * 3) < 16);
        let result = ToolResult::new(vec![ContentPart::text(shaped)]);
        let bytes = model_visible_bytes(&result);
        assert!(bytes <= MAX_MODEL_VISIBLE_BYTES, "{bytes}");
    }

    #[test]
    fn exact_boundary_is_unchanged() {
        let text = "a".repeat(MAX_MODEL_VISIBLE_BYTES - bytes(""));
        assert_eq!(bounded(text.clone()), text);
        assert!(bounded(format!("{text}b")).len() <= MAX_MODEL_VISIBLE_BYTES);
    }

    #[test]
    fn legacy_envelope_includes_json_escaping() {
        let text = "\0\n\"\\".repeat(20_000);
        let shaped = bounded(text);
        assert!(bytes(&shaped) <= MAX_MODEL_VISIBLE_BYTES);
        assert!(shaped.contains("bytes omitted here"));
    }
}
