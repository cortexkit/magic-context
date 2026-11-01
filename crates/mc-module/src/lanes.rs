//! Lanes: the kinds of reduction a view can carry. Each lane names the parts
//! it wants gone; [`drop_ops`] turns those parts into edits, so every lane
//! drops a part the same way. A pass with permission to rebuild runs every
//! lane and publishes their edits as one view.
//!
//! The rules follow the TypeScript transform, which is the reference for
//! what Magic Context removes and when.

use std::collections::{BTreeMap, BTreeSet};

use ck_contract_draft::part::{Part, PartBody, Sealing, ToolStatus};
use ck_contract_draft::read::{Entry, Role};
use ck_contract_draft::view::{EditOp, View};
use serde_json::{json, Value};

use crate::index::Index;
use crate::tokens;

/// A part, by message id and part id.
pub type PartKey = (String, String);

/// Among the newest this many tool calls, a dropped call with a small input
/// keeps its real arguments and only its result is replaced. Older calls are
/// removed whole. Models copy any synthetic argument they see into new calls,
/// so a call's arguments are either real or absent, never a stand-in.
pub const RECENT_TOOL_WINDOW: usize = 20;

/// The largest input, in UTF-8 bytes of its string values, that a recent
/// dropped call keeps.
pub const SMALL_INPUT_MAX_BYTES: u64 = 1024;

/// A tool output is "far behind", and the age sweep may drop it, once three
/// newer user turns exist after it.
pub const FAR_BEHIND_USER_TURNS: u64 = 3;

/// ... or once newer content worth this share of the usable window exists.
pub const FAR_BEHIND_WINDOW_FRACTION: f64 = 0.25;

/// The age sweep leaves outputs smaller than this alone: dropping a status
/// line frees nothing worth a rewrite.
pub const AGE_SWEEP_MIN_TOKENS: u64 = 250;

/// The text a dropped part becomes: one placeholder, a function of the tag
/// number alone, so it is byte-identical every time it is rendered.
pub fn placeholder(tag: u64) -> String {
    format!("[dropped §{tag}§]")
}

/// Bytes of every string value in a tool input, recursively. Keys, numbers,
/// booleans and nulls do not count, so the size does not depend on how a host
/// serializes JSON.
pub fn input_string_bytes(value: &Value) -> u64 {
    match value {
        Value::String(text) => text.len() as u64,
        Value::Array(items) => items.iter().map(input_string_bytes).sum(),
        Value::Object(fields) => fields.values().map(input_string_bytes).sum(),
        Value::Null | Value::Bool(_) | Value::Number(_) => 0,
    }
}

/// What the latest view already changes, so lanes leave those parts alone
/// and keep the shape an earlier view gave them.
#[derive(Default)]
pub struct Edited {
    parts: BTreeSet<PartKey>,
    messages: BTreeSet<String>,
}

impl Edited {
    pub fn of(view: Option<&View>) -> Self {
        let mut edited = Self::default();
        for edit in view.map(|view| view.edits.as_slice()).unwrap_or_default() {
            match &edit.op {
                EditOp::Drop {
                    mid,
                    part: Some(part),
                }
                | EditOp::Replace { mid, part, .. } => {
                    edited.parts.insert((mid.clone(), part.clone()));
                }
                EditOp::Drop { mid, part: None } => {
                    edited.messages.insert(mid.clone());
                }
                EditOp::Insert { .. } => {}
            }
        }
        edited
    }

    pub fn covers(&self, mid: &str, part: &str) -> bool {
        self.messages.contains(mid) || self.parts.contains(&(mid.to_owned(), part.to_owned()))
    }
}

/// What lanes need to know about the session besides its index.
pub struct Context<'a> {
    pub index: &'a Index,
    pub edited: &'a Edited,
    /// Tool results each tool keeps, newest first: the newest `n` results of
    /// a tool named here are never dropped by any lane.
    pub protected_tools: &'a BTreeMap<String, u64>,
    /// The session's first message is its task and is never dropped.
    pub keep_first_message: bool,
}

/// The edits that drop `parts`, and which of them those edits cover. A part
/// already changed by the latest view counts as covered and gets no new
/// edit. A part that cannot go yet (a running tool call, a protected result)
/// is left out of both, so a queued drop of it waits.
pub fn drop_ops<'a>(
    context: &Context,
    parts: impl IntoIterator<Item = &'a PartKey>,
) -> (Vec<EditOp>, Vec<PartKey>) {
    let index = context.index;
    let recent: BTreeSet<u64> = index
        .newest_tool_tags(RECENT_TOOL_WINDOW)
        .into_iter()
        .collect();
    let protected = protected_tool_parts(index, context.protected_tools);
    let newest_mid = index.entries().last().map(|entry| entry.mid.as_str());
    let first_mid = index.entries().first().map(|entry| entry.mid.as_str());
    let mut ops = Vec::new();
    let mut covered = Vec::new();
    for key @ (mid, part_id) in parts.into_iter().collect::<BTreeSet<_>>() {
        if context.edited.covers(mid, part_id) {
            covered.push(key.clone());
            continue;
        }
        let Some((entry, part)) = index.find(mid, part_id) else {
            continue;
        };
        if context.keep_first_message && Some(entry.mid.as_str()) == first_mid {
            continue;
        }
        let replace = |field: &str, value: Value| EditOp::Replace {
            mid: mid.clone(),
            part: part_id.clone(),
            field: field.into(),
            value,
            expect: part.digest.clone(),
        };
        let drop = || EditOp::Drop {
            mid: mid.clone(),
            part: Some(part_id.clone()),
        };
        match &part.body {
            PartBody::Text { .. } => match part.tag {
                Some(tag) => ops.push(replace("text", json!(placeholder(tag)))),
                None => continue,
            },
            PartBody::Reasoning { .. } => ops.push(drop()),
            PartBody::Tool(tool) => {
                if tool.status == ToolStatus::Running || protected.contains(key) {
                    continue;
                }
                let Some(tag) = part.tag else {
                    continue;
                };
                let input = Value::Object(tool.input.clone());
                // A call whose result ends the transcript stays a call: the
                // request would otherwise end on the call's message without
                // its result.
                let keep_call = Some(entry.mid.as_str()) == newest_mid
                    || (recent.contains(&tag)
                        && input_string_bytes(&input) <= SMALL_INPUT_MAX_BYTES);
                if keep_call {
                    ops.push(replace("output", json!(placeholder(tag))));
                    if !tool.attachments.is_empty() {
                        ops.push(replace("attachments", json!([])));
                    }
                } else {
                    ops.push(drop());
                }
            }
            PartBody::Image(_) | PartBody::File(_) => continue,
        }
        covered.push(key.clone());
    }
    (ops, covered)
}

/// The newest results of each protected tool, by part.
pub fn protected_tool_parts(index: &Index, counts: &BTreeMap<String, u64>) -> BTreeSet<PartKey> {
    let mut left: BTreeMap<String, u64> = counts.clone();
    let mut protected = BTreeSet::new();
    for entry in index.entries().iter().rev() {
        for part in entry.parts.iter().rev() {
            let PartBody::Tool(tool) = &part.body else {
                continue;
            };
            let name = normalize_tool_name(&tool.name);
            if let Some(count) = left.get_mut(&name) {
                if *count > 0 {
                    *count -= 1;
                    protected.insert((entry.mid.clone(), part.id.clone()));
                }
            }
        }
    }
    protected
}

/// Tool names compare without case and without an `mcp_` prefix.
pub fn normalize_tool_name(name: &str) -> String {
    let lower = name.to_lowercase();
    lower
        .strip_prefix("mcp_")
        .map(str::to_owned)
        .unwrap_or(lower)
}

/// Whether an entry starts a user turn: a message the user wrote, not a
/// notice a module or the runner delivered.
fn starts_user_turn(entry: &Entry) -> bool {
    entry.role == Role::User
        && entry.notice.is_none()
        && entry.parts.iter().any(|part| match &part.body {
            PartBody::Text { text } => !text.trim().is_empty(),
            PartBody::Image(_) | PartBody::File(_) => true,
            PartBody::Reasoning { .. } | PartBody::Tool(_) => false,
        })
}

/// The highest tag number below which every tool output is far behind: three
/// newer user turns, or a quarter of the usable window of newer content.
///
/// The age sweep drops against the bookmark the previous rebuild recorded,
/// then records this one. A free rebuild is not evidence the model has moved
/// on, so an output has to stay far behind across two rebuilds before it
/// goes.
pub fn far_behind_bookmark(context: &Context, usable_window: u64) -> u64 {
    let token_distance = if usable_window > 0 {
        usable_window as f64 * FAR_BEHIND_WINDOW_FRACTION
    } else {
        f64::INFINITY
    };
    let mut newer_turns = 0;
    let mut newer_tokens = 0u64;
    let mut far = Vec::new();
    let mut first_young = u64::MAX;
    for entry in context.index.entries().iter().rev() {
        for part in entry.parts.iter().rev() {
            if let (PartBody::Tool(_), Some(tag)) = (&part.body, part.tag) {
                if newer_turns >= FAR_BEHIND_USER_TURNS || newer_tokens as f64 >= token_distance {
                    far.push(tag);
                } else {
                    first_young = first_young.min(tag);
                }
            }
            if !context.edited.covers(&entry.mid, &part.id) {
                newer_tokens += tokens::part(part);
            }
        }
        if starts_user_turn(entry) {
            newer_turns += 1;
        }
    }
    // Tags follow call order, not the order results arrive: a younger output
    // with a lower tag holds every tag above it.
    far.into_iter()
        .filter(|tag| *tag < first_young)
        .max()
        .unwrap_or(0)
}

/// The age sweep: tool outputs at or below `bookmark` (recorded by the
/// previous rebuild), worth dropping, and not protected.
pub fn age_sweep(context: &Context, bookmark: u64) -> Vec<PartKey> {
    if bookmark == 0 {
        return Vec::new();
    }
    let protected = protected_tool_parts(context.index, context.protected_tools);
    let mut parts = Vec::new();
    for entry in context.index.entries() {
        for part in &entry.parts {
            let (PartBody::Tool(_), Some(tag)) = (&part.body, part.tag) else {
                continue;
            };
            let key = (entry.mid.clone(), part.id.clone());
            if tag > bookmark
                || context.edited.covers(&entry.mid, &part.id)
                || protected.contains(&key)
                || tokens::part(part) < AGE_SWEEP_MIN_TOKENS
            {
                continue;
            }
            parts.push(key);
        }
    }
    parts
}

/// Reasoning a step costs when nothing better is known: encrypted or signed
/// reasoning with no reported count and no visible text.
pub const UNKNOWN_REASONING_STEP_TOKENS: u64 = 1_000;

/// What one assistant entry's reasoning costs: the count the provider
/// reported, else the visible text, else a fixed estimate for reasoning that
/// has no visible text.
fn reasoning_cost(entry: &Entry, reasoning: &[&Part]) -> u64 {
    if let Some(reported) = entry.usage.and_then(|usage| usage.reasoning_tokens) {
        if reported > 0 {
            return reported;
        }
    }
    let mut visible = 0;
    let mut opaque = false;
    for part in reasoning {
        if let PartBody::Reasoning {
            text_bytes,
            sealing,
            ..
        } = &part.body
        {
            visible += tokens::bytes(text_bytes.unwrap_or(0));
            opaque |= text_bytes.unwrap_or(0) == 0 && *sealing != Sealing::None;
        }
    }
    if visible > 0 {
        visible
    } else if opaque {
        UNKNOWN_REASONING_STEP_TOKENS
    } else {
        0
    }
}

/// Reasoning clearing: keep the newest assistant entries whose reasoning fits
/// `budget`, and drop the reasoning of every older one. The newest assistant
/// entry always keeps its reasoning and is charged first. What goes is always
/// an oldest contiguous run, which every provider accepts, signed reasoning
/// included.
pub fn reasoning_over_budget(context: &Context, budget: u64) -> Vec<PartKey> {
    let assistants: Vec<(&Entry, Vec<&Part>)> = context
        .index
        .entries()
        .iter()
        .filter(|entry| entry.role == Role::Assistant)
        .map(|entry| {
            let reasoning = entry
                .parts
                .iter()
                .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
                .filter(|part| !context.edited.covers(&entry.mid, &part.id))
                .collect();
            (entry, reasoning)
        })
        .collect();
    let Some(((newest, newest_reasoning), older)) = assistants.split_last() else {
        return Vec::new();
    };
    let mut kept = reasoning_cost(newest, newest_reasoning);
    let mut cut = None;
    for (position, (entry, reasoning)) in older.iter().enumerate().rev() {
        if reasoning.is_empty() {
            continue;
        }
        let cost = reasoning_cost(entry, reasoning);
        if kept + cost > budget {
            cut = Some(position);
            break;
        }
        kept += cost;
    }
    let Some(cut) = cut else {
        return Vec::new();
    };
    older[..=cut]
        .iter()
        .flat_map(|(entry, reasoning)| {
            reasoning
                .iter()
                .map(|part| (entry.mid.clone(), part.id.clone()))
        })
        .collect()
}
