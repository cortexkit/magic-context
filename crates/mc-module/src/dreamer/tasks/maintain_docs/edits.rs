//! The docs-upkeep task's answer, and the checks every change of it passes
//! before it is kept.
//!
//! The answer is one JSON array of section changes,
//! `{file, action, heading, text, reason}`, as the task's output frame asks.
//! A section is a heading line (`#` to `######`, outside code fences) and
//! everything under it until the next heading of the same or a higher level,
//! or the end of the file. Each change is checked on
//! its own, against both documents as the changes kept before it left them,
//! and is dropped with its reason when a check fails; the rest are kept and
//! applied in their order. The checks:
//!
//! - `file` is `ARCHITECTURE.md` or `STRUCTURE.md`, `action` is `replace`,
//!   `remove` or `add`, `heading` is one heading line, and `reason` one line;
//! - `replace` and `remove` name a heading the file holds exactly once, and
//!   `add` one it doesn't hold;
//! - the `text` of `replace` and `add` is one section that starts with its
//!   heading line, and holds no date;
//! - protected regions are preserved byte for byte and in order
//!   ([`super::protected`]), even when a change targets a parent section;
//! - the documents stay within their budget: when the kept changes make them
//!   larger than the budget (or larger than they are, when they already
//!   exceed it), the latest changes that make them larger are dropped first.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::protected;
use crate::docs_proposals::{DroppedChange, SectionChange, DOCUMENTS};

/// The actions a change may take.
const ACTIONS: [&str; 3] = ["replace", "remove", "add"];

/// The JSON array of an answer: the whole reply, or the first code fence's
/// content, or the reply from its first `[` to its last `]`. A reply with no
/// array is refused; an empty array is an answer.
pub(crate) fn parse_answer(reply: &str) -> Result<Vec<Value>, String> {
    let fenced = reply.find("```").and_then(|open| {
        let after = &reply[open + 3..];
        let body = after
            .find('\n')
            .filter(|end| !after[..*end].contains('['))
            .map_or(after, |end| &after[end + 1..]);
        body.find("```").map(|close| &body[..close])
    });
    let brackets = match (reply.find('['), reply.rfind(']')) {
        (Some(start), Some(end)) if start <= end => Some(&reply[start..=end]),
        _ => None,
    };
    [Some(reply), fenced, brackets]
        .into_iter()
        .flatten()
        .find_map(|text| match serde_json::from_str::<Value>(text.trim()) {
            Ok(Value::Array(changes)) => Some(changes),
            _ => None,
        })
        .ok_or_else(|| "the reply holds no JSON array of section changes".into())
}

/// One section of a document: its heading line and its line range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Section {
    pub heading: String,
    pub start: usize,
    pub end: usize,
}

fn heading_line() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^#{1,6} \S").expect("the heading pattern compiles"))
}

fn fence_line() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\s*(```|~~~)").expect("the fence pattern compiles"))
}

/// The sections of `text`, in heading order, including nested sections.
/// A heading inside a code fence opens none. Lines before the first heading
/// belong to no section.
pub(crate) fn sections(text: &str) -> Vec<Section> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut found: Vec<Section> = Vec::new();
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut fenced = false;
    for (at, line) in lines.iter().enumerate() {
        if fence_line().is_match(line) {
            fenced = !fenced;
        }
        if !fenced && heading_line().is_match(line) {
            let level = line.bytes().take_while(|byte| *byte == b'#').count();
            // A new heading closes its peers and their descendants, but not
            // its parents, whose edits must include the nested text.
            while let Some(&(index, open_level)) = open.last() {
                if open_level < level {
                    break;
                }
                found[index].end = at;
                open.pop();
            }
            open.push((found.len(), level));
            found.push(Section {
                heading: line.trim_end_matches('\r').to_owned(),
                start: at,
                end: lines.len(),
            });
        }
    }
    found
}

/// A change as the model wrote it, its fields read as text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Proposed {
    pub file: String,
    pub action: String,
    pub heading: String,
    pub text: String,
    pub reason: String,
}

impl Proposed {
    /// The change at `value`, or `None` when it isn't an object.
    pub(crate) fn of(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let field = |name: &str| {
            object
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Some(Self {
            file: field("file").trim().to_owned(),
            action: field("action").trim().to_owned(),
            heading: field("heading").trim().to_owned(),
            text: field("text"),
            reason: field("reason").trim().to_owned(),
        })
    }

    fn dropped(&self, reason: impl Into<String>) -> DroppedChange {
        DroppedChange {
            file: self.file.clone(),
            action: self.action.clone(),
            heading: self.heading.clone(),
            reason: reason.into(),
        }
    }
}

/// One document's text while the changes are applied; `None` while it
/// doesn't exist.
type Texts = [Option<String>; 2];

/// What checking an answer kept and dropped, and the documents it leads to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Checked {
    pub kept: Vec<SectionChange>,
    pub dropped: Vec<DroppedChange>,
    /// Each document once the kept changes are applied, in [`DOCUMENTS`]
    /// order.
    pub results: Texts,
    /// The documents' tokens together, before and after.
    pub tokens_before: u64,
    pub tokens_after: u64,
}

/// The documents' tokens together, by `count`.
fn tokens(texts: &Texts, count: &dyn Fn(&str) -> u64) -> u64 {
    texts.iter().flatten().map(|text| count(text)).sum()
}

/// `text` with its trailing blank lines removed and one newline at its end,
/// when it had any text.
fn ended(text: &str) -> String {
    let body = text.trim_end_matches(['\n', '\r', ' ', '\t']);
    if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n")
    }
}

/// Apply one change to `text` (a document's current text, empty when it
/// doesn't exist) once its own checks passed.
fn applied(text: &str, change: &Proposed, section: Option<&Section>) -> String {
    let new_section = change.text.trim_end_matches(['\n', '\r', ' ', '\t']);
    match (change.action.as_str(), section) {
        ("add", _) => {
            let body = text.trim_end_matches(['\n', '\r', ' ', '\t']);
            if body.is_empty() {
                format!("{new_section}\n")
            } else {
                format!("{body}\n\n{new_section}\n")
            }
        }
        (_, Some(section)) => {
            let mut lines: Vec<&str> = text.split('\n').collect();
            // A rewritten section keeps the blank lines that set it apart
            // from the next one; a removed section takes them with it.
            let mut content_end = section.end;
            while content_end > section.start + 1 && lines[content_end - 1].trim().is_empty() {
                content_end -= 1;
            }
            if change.action == "remove" {
                lines.drain(section.start..section.end);
            } else {
                lines.splice(section.start..content_end, new_section.split('\n'));
            }
            ended(&lines.join("\n"))
        }
        _ => text.to_owned(),
    }
}

/// Why `change` can't apply to `texts`, given the changes kept before it, or
/// the section it names and the document it leads to.
fn check(
    change: &Proposed,
    texts: &Texts,
    kept: &[SectionChange],
) -> Result<(usize, String), String> {
    let Some(index) = DOCUMENTS.iter().position(|name| *name == change.file) else {
        return Err("the file is neither ARCHITECTURE.md nor STRUCTURE.md".into());
    };
    if !ACTIONS.contains(&change.action.as_str()) {
        return Err("the action is neither replace, remove nor add".into());
    }
    if change.heading.contains('\n') || !heading_line().is_match(&change.heading) {
        return Err("the heading is not one markdown heading line".into());
    }
    if change.reason.is_empty() || change.reason.contains('\n') {
        return Err("the change gives no one-line reason".into());
    }
    if kept
        .iter()
        .any(|earlier| earlier.file == change.file && earlier.heading == change.heading)
    {
        return Err("an earlier change already changes this section".into());
    }
    let text = texts[index].as_deref().unwrap_or_default();
    let found: Vec<Section> = sections(text)
        .into_iter()
        .filter(|section| section.heading == change.heading)
        .collect();
    let section = match (change.action.as_str(), found.len()) {
        ("add", 0) => None,
        ("add", _) => return Err("the file already has a section with this heading".into()),
        (_, 1) => Some(&found[0]),
        (_, 0) => return Err("the file has no section with this heading".into()),
        (_, count) => {
            return Err(format!(
                "the heading appears {count} times in the file, so the section is ambiguous"
            ))
        }
    };
    if change.action != "remove" {
        let first_line = change.text.split('\n').next().unwrap_or_default();
        if first_line.trim_end() != change.heading {
            return Err("the text doesn't start with its heading line".into());
        }
        let first_section_covers_text = sections(&change.text)
            .first()
            .is_some_and(|section| section.end == change.text.split('\n').count());
        if !first_section_covers_text {
            return Err("the text holds more than one section".into());
        }
        if let Some(date) =
            crate::dreamer::tasks::reflect_events::learnings::date_pattern().find(&change.text)
        {
            return Err(format!("the text holds a date ({})", date.as_str()));
        }
    }
    let after = applied(text, change, section);
    if after == text {
        return Err("the change leaves the section as it is".into());
    }
    if !protected::kept(text, &after) {
        return Err(if change.action == "remove" {
            "the removed section holds a protected region".into()
        } else {
            "the change alters a protected region".into()
        });
    }
    Ok((index, after))
}

/// One pass of the checks over an answer.
struct Pass {
    kept: Vec<SectionChange>,
    /// Each dropped change with its position in the answer.
    dropped: Vec<(usize, DroppedChange)>,
    texts: Texts,
    /// Each kept change's position in the answer, with how many tokens it
    /// added to the documents (negative when it shrank them).
    grown: Vec<(usize, i64)>,
}

/// Check every change of `answer` against the documents `base` (each
/// `None` when it doesn't exist), skipping the ones in `withheld`, and
/// apply the rest in order.
fn check_all(
    answer: &[Proposed],
    base: &Texts,
    withheld: &std::collections::BTreeMap<usize, String>,
    count: &dyn Fn(&str) -> u64,
) -> Pass {
    let mut texts = base.clone();
    let mut kept: Vec<SectionChange> = Vec::new();
    let mut dropped = Vec::new();
    let mut grown = Vec::new();
    for (position, change) in answer.iter().enumerate() {
        if let Some(reason) = withheld.get(&position) {
            dropped.push((position, change.dropped(reason.clone())));
            continue;
        }
        match check(change, &texts, &kept) {
            Ok((index, after)) => {
                let before = texts[index].as_deref().map_or(0, count);
                let added = count(&after) as i64 - before as i64;
                texts[index] = (!after.is_empty() || texts[index].is_some()).then_some(after);
                kept.push(SectionChange {
                    file: change.file.clone(),
                    action: change.action.clone(),
                    heading: change.heading.clone(),
                    text: change.text.clone(),
                    reason: change.reason.clone(),
                });
                grown.push((position, added));
            }
            Err(reason) => dropped.push((position, change.dropped(reason))),
        }
    }
    Pass {
        kept,
        dropped,
        texts,
        grown,
    }
}

/// Check `answer` (the parsed array) against `base`, within `budget` tokens
/// counted by `count`.
pub(crate) fn check_answer(
    answer: &[Value],
    base: &Texts,
    budget: u64,
    count: &dyn Fn(&str) -> u64,
) -> Checked {
    let proposed: Vec<Proposed> = answer
        .iter()
        .map(|value| Proposed::of(value).unwrap_or_default())
        .collect();
    let mut withheld = std::collections::BTreeMap::new();
    for (position, value) in answer.iter().enumerate() {
        if !value.is_object() {
            withheld.insert(position, "the change is not a JSON object".to_owned());
        }
    }
    let tokens_before = tokens(base, count);
    // Documents already over the budget may keep their size, or shrink.
    let limit = budget.max(tokens_before);
    loop {
        let Pass {
            kept,
            dropped,
            texts: results,
            grown,
        } = check_all(&proposed, base, &withheld, count);
        let tokens_after = tokens(&results, count);
        let latest_growth = grown.iter().rev().find(|(_, added)| *added > 0);
        match latest_growth {
            Some((position, _)) if tokens_after > limit => {
                let reason = if tokens_before > budget {
                    format!(
                        "the documents would hold {tokens_after} tokens, more than the {tokens_before} they hold now, which is already over their budget of {budget}"
                    )
                } else {
                    format!(
                        "the documents would hold {tokens_after} tokens, over their budget of {budget}"
                    )
                };
                withheld.insert(*position, reason);
            }
            _ => {
                let mut dropped = dropped;
                dropped.sort_by_key(|(position, _)| *position);
                return Checked {
                    kept,
                    dropped: dropped.into_iter().map(|(_, change)| change).collect(),
                    results,
                    tokens_before,
                    tokens_after,
                };
            }
        }
    }
}

#[cfg(test)]
#[path = "edits_tests.rs"]
mod tests;
