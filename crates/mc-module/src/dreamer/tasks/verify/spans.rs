//! The lines a confirmation cites, as a `verified` verdict's `cites` names
//! them (`path:start-end` spans separated by `;`), and the evidence the
//! module keeps from them.
//!
//! The module reads the cited lines itself, from git at the commit its batch
//! checked, never from the reply. A confirmation that passes its checks
//! ([`super::confirm`]) keeps each span's path, its line range at that
//! commit and its text in the memory's metadata, under
//! [`STORED_KEY`], together with that commit and the confirmation's time. A
//! later confirmation replaces them. When the memory's files change, a later
//! `verify` run looks for each stored text in its file again (anywhere, so
//! moved lines still match) before any model is asked.
//!
//! A confirmation counts only with its spans: one recorded without them
//! (every confirmation before cited lines were required, the 0.49 plugin's
//! included) or whose spans belong to an earlier confirmation counts as
//! never made.

use serde_json::{json, Value};

/// At most this many spans in one confirmation.
pub(crate) const MAX_SPANS: usize = 16;
/// At most this many lines in one span: a span says which lines state the
/// claim, not which file holds them.
pub(crate) const MAX_SPAN_LINES: usize = 150;
/// The metadata key that holds a confirmation's evidence.
pub(crate) const STORED_KEY: &str = "dreamerVerifiedSpans";

/// One span a reply cites: lines `start` to `end` of `path`, counted from 1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub path: String,
    pub start: usize,
    pub end: usize,
}

/// Read a `cites` attribute. `Err` says why it can't be used: no span, an
/// entry that is not `path:start-end` (or `path:line`), more than
/// [`MAX_SPANS`] spans, or a span over [`MAX_SPAN_LINES`] lines.
pub(crate) fn parse_cites(raw: &str) -> Result<Vec<Span>, String> {
    let mut spans = Vec::new();
    for entry in raw.split(';').map(str::trim).filter(|entry| !entry.is_empty()) {
        let malformed = || format!("cites entry {entry:?} is not path:start-end");
        let (path, range) = entry.rsplit_once(':').ok_or_else(malformed)?;
        let path = path.trim();
        let number = |text: &str| text.trim().parse::<usize>().ok();
        let (start, end) = match range.split_once(['-', '–']) {
            Some((start, end)) => (number(start), number(end)),
            None => (number(range), number(range)),
        };
        let (Some(start), Some(end)) = (start, end) else {
            return Err(malformed());
        };
        if path.is_empty() || start == 0 || end < start {
            return Err(malformed());
        }
        if end - start + 1 > MAX_SPAN_LINES {
            return Err(format!("a cite covers more than {MAX_SPAN_LINES} lines"));
        }
        spans.push(Span {
            path: path.to_owned(),
            start,
            end,
        });
    }
    if spans.is_empty() {
        return Err("cites names no lines".into());
    }
    if spans.len() > MAX_SPANS {
        return Err(format!("cites names more than {MAX_SPANS} spans"));
    }
    Ok(spans)
}

/// One cited span as the module read it at a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cited {
    /// The file's path from the repository's top.
    pub path: String,
    pub start: usize,
    pub end: usize,
    /// Its lines, joined by `\n`.
    pub text: String,
}

impl Cited {
    /// `path:start-end`, as a reply cites it.
    pub(crate) fn label(&self) -> String {
        format!("{}:{}-{}", self.path, self.start, self.end)
    }
}

/// The evidence a confirmation rests on: the commit it read and the spans
/// it cited there, with the `derive` that computed any number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Confirmation {
    pub commit: String,
    pub spans: Vec<Cited>,
    pub derive: Option<String>,
}

impl Confirmation {
    /// The evidence as stored under [`STORED_KEY`], for a confirmation made
    /// at `verified_at`.
    pub(crate) fn json(&self, verified_at: i64) -> Value {
        let mut stored = json!({
            "verifiedAt": verified_at,
            "commit": self.commit,
            "spans": self.spans.iter().map(|span| json!({
                "path": span.path,
                "start": span.start,
                "end": span.end,
                "text": span.text,
            })).collect::<Vec<_>>(),
        });
        if let Some(derive) = &self.derive {
            stored["derive"] = json!(derive);
        }
        stored
    }

    /// The evidence `metadata` keeps for the confirmation made at
    /// `verified_at`; `None` when it keeps none, keeps it for another
    /// confirmation, or keeps it malformed.
    pub(crate) fn stored(metadata: &Value, verified_at: i64) -> Option<Self> {
        let stored = &metadata[STORED_KEY];
        if verified_at <= 0 || stored["verifiedAt"].as_i64() != Some(verified_at) {
            return None;
        }
        let commit = stored["commit"]
            .as_str()
            .filter(|commit| crate::dreamer::checkout::is_commit(commit))?;
        let spans = stored["spans"]
            .as_array()?
            .iter()
            .map(|span| {
                let line = |key: &str| {
                    span[key]
                        .as_u64()
                        .and_then(|line| usize::try_from(line).ok())
                };
                Some(Cited {
                    path: span["path"].as_str()?.to_owned(),
                    start: line("start")?,
                    end: line("end")?,
                    text: span["text"].as_str()?.to_owned(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        if spans.is_empty() {
            return None;
        }
        Some(Self {
            commit: commit.to_owned(),
            spans,
            derive: stored["derive"].as_str().map(str::to_owned),
        })
    }
}

/// Whether the memory whose metadata is `metadata_json` was last confirmed
/// with cited lines: it keeps evidence for the confirmation its
/// `dreamerVerifiedAt` stamp records. A confirmation without them counts as
/// never made wherever the module shows whether a memory is verified.
pub(crate) fn cites_its_confirmation(metadata_json: Option<&str>) -> bool {
    let Some(metadata) = metadata_json.and_then(|text| serde_json::from_str::<Value>(text).ok())
    else {
        return false;
    };
    metadata["dreamerVerifiedAt"]
        .as_i64()
        .is_some_and(|at| Confirmation::stored(&metadata, at).is_some())
}

/// Lines `start` to `end` of `file`, counted from 1 and joined by `\n`;
/// `Err` holds how many lines the file has when it has fewer than `end`.
pub(crate) fn lines_of(file: &str, start: usize, end: usize) -> Result<String, usize> {
    let lines: Vec<&str> = file.lines().collect();
    if start == 0 || end > lines.len() || end < start {
        return Err(lines.len());
    }
    Ok(lines[start - 1..end].join("\n"))
}

/// Where `file` holds the lines of `text` in a row, as the first and last
/// line of the first such place, counted from 1. Lines are compared without
/// trailing whitespace, so the same code moved elsewhere in the file still
/// matches.
pub(crate) fn find_lines(file: &str, text: &str) -> Option<(usize, usize)> {
    let wanted: Vec<&str> = text.lines().map(str::trim_end).collect();
    if wanted.is_empty() {
        return None;
    }
    let lines: Vec<&str> = file.lines().map(str::trim_end).collect();
    lines
        .windows(wanted.len())
        .position(|window| window == wanted.as_slice())
        .map(|at| (at + 1, at + wanted.len()))
}

#[cfg(test)]
#[path = "spans_tests.rs"]
mod tests;
