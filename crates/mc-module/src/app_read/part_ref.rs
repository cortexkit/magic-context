//! Transcript addresses refer to stored parts, not the subset a UI displays.
#![cfg_attr(not(test), expect(dead_code, reason = "consumed by app read dispatch"))]

use serde_json::{json, Value};

/// OpenCode suffixes count every stored part, including reasoning and step
/// markers. Legacy Pi suffixes count text blocks instead and must not be
/// presented as stored indexes until the tagger records that mapping.
pub(crate) fn standalone_part_ref(host: &str, tag_key: &str) -> Option<Value> {
    if host == "pi" {
        if let Some((_, suffix)) = tag_key.rsplit_once(":mc-text-v1:") {
            return Some(json!({"content_key":format!("mc-text-v1:{suffix}")}));
        }
    }
    let (file, suffix) = if let Some((_, suffix)) = tag_key.rsplit_once(":file") {
        (true, suffix)
    } else {
        (false, tag_key.rsplit_once(":p")?.1)
    };
    let index = suffix.parse::<u64>().ok()?;
    if host == "pi" && !file {
        Some(json!({"text_ordinal": index}))
    } else {
        Some(json!({"part_index": index}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_indexes_include_hidden_parts_and_pi_text_is_not_an_index() {
        for host in ["opencode", "opencode2"] {
            // Two hidden step/reasoning parts precede the visible text.
            assert_eq!(
                standalone_part_ref(host, "m:p2"),
                Some(json!({"part_index":2}))
            );
            assert_eq!(
                standalone_part_ref(host, "m:file3"),
                Some(json!({"part_index":3}))
            );
        }
        assert_eq!(
            standalone_part_ref("pi", "m:p1"),
            Some(json!({"text_ordinal":1}))
        );
        assert_eq!(standalone_part_ref("opencode", "m:pbad"), None);
    }
}
