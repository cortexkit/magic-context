//! A summary may name only commit hashes its own messages contain. A model
//! that names a hash from elsewhere (another stretch of the chunk, or one it
//! made up) would put a wrong commit in the history the model reads later.
//! A port of the plugin's `compartment-commit-hashes.ts`, applied as its
//! validator applies it (`compartment-runner-validation.ts`).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::Entry;
use regex::Regex;
use serde_json::Value;

use super::validate::ValidatedCompartment;

fn raw_hash() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b[0-9a-f]{7,40}\b").unwrap())
}

fn named_hash() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)`?\b([0-9a-f]{7,40})\b`?").unwrap())
}

fn hashes_in(text: &str, into: &mut BTreeSet<String>) {
    into.extend(
        raw_hash()
            .find_iter(text)
            .map(|found| found.as_str().to_lowercase()),
    );
}

fn hashes_in_value(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => hashes_in(text, into),
        Value::Array(items) => items.iter().for_each(|item| hashes_in_value(item, into)),
        Value::Object(fields) => fields.values().for_each(|item| hashes_in_value(item, into)),
        _ => {}
    }
}

/// Every hash-like token in each message's raw parts, by ordinal: text,
/// tool inputs and tool outputs, as the messages read in full hold them.
pub fn by_ordinal(entries: &[Entry]) -> BTreeMap<u64, BTreeSet<String>> {
    entries
        .iter()
        .map(|entry| {
            let mut hashes = BTreeSet::new();
            for part in crate::neutral::authored_parts(entry) {
                match &part.body {
                    PartBody::Text { text } => hashes_in(text, &mut hashes),
                    PartBody::Tool(tool) => {
                        hashes_in_value(&tool.input.parse(), &mut hashes);
                        if let Some(output) = &tool.output {
                            hashes_in(output, &mut hashes);
                        }
                    }
                    _ => {}
                }
            }
            (entry.ordinal, hashes)
        })
        .collect()
}

/// `text` without the hashes its messages do not support. A hash is
/// supported when one of them starts with it, so a short form of a full
/// hash stays. A token with no letter is a number, never a hash.
pub fn remove_unsupported(text: &str, supported: &BTreeSet<String>) -> String {
    named_hash()
        .replace_all(text, |capture: &regex::Captures<'_>| {
            let hash = capture[1].to_lowercase();
            if !hash.bytes().any(|byte| byte.is_ascii_alphabetic())
                || supported.iter().any(|source| source.starts_with(&hash))
            {
                capture[0].to_owned()
            } else {
                String::new()
            }
        })
        .into_owned()
}

/// Remove from each summary the hashes its own messages do not contain.
pub fn sanitize(
    compartments: &mut [ValidatedCompartment],
    hashes: &BTreeMap<u64, BTreeSet<String>>,
) {
    for compartment in compartments {
        let supported: BTreeSet<String> = hashes
            .range(compartment.start_message..=compartment.end_message)
            .flat_map(|(_, found)| found.iter().cloned())
            .collect();
        compartment.title = remove_unsupported(&compartment.title, &supported);
        compartment.content = remove_unsupported(&compartment.content, &supported);
        for tier in [
            &mut compartment.p1,
            &mut compartment.p2,
            &mut compartment.p3,
            &mut compartment.p4,
        ]
        .into_iter()
        .flatten()
        {
            *tier = remove_unsupported(tier, &supported);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hash a summary's own messages hold stays, in full or short form; a
    /// hash only another stretch holds goes; numbers are never touched.
    #[test]
    fn a_summary_keeps_only_its_own_commit_hashes() {
        let own = BTreeSet::from(["1a2b3c4d5e6f".to_owned()]);
        assert_eq!(
            remove_unsupported("Committed `1a2b3c4` and deadbee.", &own),
            "Committed `1a2b3c4` and ."
        );
        assert_eq!(
            remove_unsupported("Took 1234567 ms over 12345678 bytes.", &own),
            "Took 1234567 ms over 12345678 bytes."
        );
    }
}
