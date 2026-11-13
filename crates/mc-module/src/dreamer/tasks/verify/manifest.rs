//! The `<verify>` manifest a verify batch's reply ends with: one verdict per
//! memory, read the way the 0.49.x Rust module kept in `crates_old/` read it
//! (`mc-module/src/dream_tasks/verify.rs`), plus the `missing` attribute an
//! archive may carry.
//!
//! Only the reply's final message reaches the task, so the manifest must be
//! complete there: a reply without the closing `</verify>` is refused, never
//! read as far as it goes. An id the batch didn't send is dropped before the
//! other checks; an id given twice refuses the reply; and a reply that
//! decides fewer than half the batch's memories is refused, so a model that
//! stopped early is replaced by the next one.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;

/// What a reply decides for one memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Verified,
    Update,
    Archive,
    Skip,
}

impl Decision {
    /// The action a task must declare to make this decision.
    pub(crate) fn action(self) -> &'static str {
        match self {
            Self::Verified => "mark-verified",
            Self::Update => "update",
            Self::Archive => "archive",
            Self::Skip => "skip",
        }
    }
}

/// One verdict as the reply writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub id: i64,
    pub decision: Decision,
    /// The files the model checked the memory against, as written.
    pub files: Vec<String>,
    /// An update's new text.
    pub content: String,
    pub reason: String,
    /// An update that shortens the memory on purpose.
    pub consolidation: bool,
    /// An archive's path or code name that is gone from the checkout.
    pub missing: Option<String>,
}

/// The value of attribute `name` in `attributes`, as written.
fn attribute(attributes: &str, name: &str) -> Option<String> {
    Regex::new(&format!(r#"\b{name}\s*=\s*"([^"]*)""#))
        .expect("a fixed verify-manifest pattern")
        .captures(attributes)
        .map(|found| found[1].to_owned())
}

/// Trim as JavaScript's `String.prototype.trim` does, which the plugin's
/// parser used: whitespace and the byte-order mark, but not U+0085.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}')
}

/// Read a reply's `<verify>` manifest for a batch that sent `expected`.
pub(crate) fn parse_manifest(text: &str, expected: &[i64]) -> Result<Vec<Verdict>, String> {
    static ROOT: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    static ENTRIES: OnceLock<Vec<(Decision, Regex)>> = OnceLock::new();
    let root =
        ROOT.get_or_init(|| Regex::new(r"(?is)<verify\b[^>]*>(.*?)</verify>").expect("root"));
    let id_prefix = ID.get_or_init(|| Regex::new(r"^[\s\x{feff}]*([+-]?[0-9]+)").expect("id"));
    let entries = ENTRIES.get_or_init(|| {
        [
            (Decision::Verified, "verified"),
            (Decision::Update, "update"),
            (Decision::Archive, "archive"),
            (Decision::Skip, "skip"),
        ]
        .into_iter()
        .map(|(decision, tag)| {
            let pattern = if decision == Decision::Update {
                r"(?s)<update\b([^>]*?)(?:/>|>(.*?)</update>)".to_owned()
            } else {
                format!(r"<{tag}\b([^>]*)/?>")
            };
            (decision, Regex::new(&pattern).expect("entry"))
        })
        .collect()
    });
    let body = root
        .captures(text)
        .ok_or("verify manifest missing complete root element")?;
    let expected: BTreeSet<i64> = expected.iter().copied().collect();
    let mut verdicts = Vec::new();
    let mut recognized = 0;
    let mut seen = BTreeSet::new();
    for (decision, pattern) in entries {
        for entry in pattern.captures_iter(&body[1]) {
            // An integer prefix with an optional sign; trailing text is
            // ignored, as the plugin's `parseInt` ignored it.
            let raw = attribute(&entry[1], "id").unwrap_or_default();
            let id = id_prefix
                .captures(&raw)
                .and_then(|found| found[1].parse::<i64>().ok())
                .ok_or("verify manifest entry missing numeric id")?;
            recognized += 1;
            if !expected.contains(&id) {
                continue;
            }
            if !seen.insert(id) {
                return Err(format!("verify manifest contains duplicate id {id}"));
            }
            verdicts.push(Verdict {
                id,
                decision: *decision,
                files: attribute(&entry[1], "files")
                    .unwrap_or_default()
                    .split(',')
                    .map(js_trim)
                    .filter(|file| !file.is_empty())
                    .map(str::to_owned)
                    .collect(),
                content: entry
                    .get(2)
                    .map_or("", |content| js_trim(content.as_str()))
                    .to_owned(),
                reason: attribute(&entry[1], "reason").unwrap_or_default(),
                consolidation: attribute(&entry[1], "consolidation")
                    .is_some_and(|value| value.to_lowercase() == "true"),
                missing: (*decision == Decision::Archive)
                    .then(|| attribute(&entry[1], "missing"))
                    .flatten()
                    .map(|value| js_trim(&value).to_owned())
                    .filter(|value| !value.is_empty()),
            });
        }
    }
    if !expected.is_empty() && recognized == 0 {
        return Err("verify manifest parsed zero entries".into());
    }
    if verdicts.len() * 2 < expected.len() {
        return Err("verify manifest covers fewer than half the batch ids".into());
    }
    Ok(verdicts)
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
