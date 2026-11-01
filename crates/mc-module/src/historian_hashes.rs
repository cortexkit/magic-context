use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::Value;

fn hash_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)`?\b([0-9a-f]{7,40})\b`?").unwrap())
}

/// Read hashes before formatting merges messages or truncates tool results.
pub(crate) fn raw_commit_hashes(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => hash_regex()
            .captures_iter(text)
            .map(|capture| capture[1].to_ascii_lowercase())
            .collect(),
        Value::Array(values) => values.iter().flat_map(raw_commit_hashes).collect(),
        Value::Object(values) => values.values().flat_map(raw_commit_hashes).collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn remove_unsupported_hashes(text: &str, supported: &HashSet<&str>) -> String {
    hash_regex()
        .replace_all(text, |capture: &Captures<'_>| {
            let hash = capture[1].to_ascii_lowercase();
            // Decimal-only tokens are numbers, even when they resemble short hashes.
            let has_hex_letter = hash.bytes().any(|byte| matches!(byte, b'a'..=b'f'));
            if !has_hex_letter || supported.iter().any(|source| source.starts_with(&hash)) {
                capture[0].to_string()
            } else {
                String::new()
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_summary_numbers_survive_while_mixed_hashes_are_range_checked() {
        let summary = "1000000 tokens at 1720000000000; `1234567` bytes; unsupported `a1b2c3d`; supported `D3714D6`.";
        assert_eq!(
            remove_unsupported_hashes(summary, &HashSet::from(["d3714d6a9b"])),
            "1000000 tokens at 1720000000000; `1234567` bytes; unsupported ; supported `D3714D6`."
        );
    }
}
