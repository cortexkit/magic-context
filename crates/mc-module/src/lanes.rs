//! Lanes: the kinds of reduction a view can carry. Each lane names the parts
//! it wants gone; [`drop_ops`] turns those parts into edits, so every lane
//! drops a part the same way. A pass with permission to rebuild runs every
//! lane and publishes their edits as one view.
//!
//! The rules follow the TypeScript transform, which is the reference for
//! what Magic Context removes and when.

use std::collections::{BTreeMap, BTreeSet};

use cortexkit_role_compaction::part::{
    AttachmentItem, FileMedia, Part, PartBody, Seal, ToolPart, ToolStatus, Transport,
};
use cortexkit_role_compaction::read::{Entry, Role};
use cortexkit_role_compaction::view::{EditOp, View};
use serde_json::{json, Value};

use crate::index::Index;
use crate::injection::{self, Stripped};
use crate::neutral::{is_finished, is_known};
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
///
/// An edit either reduces a part for good (a drop, a placeholder, text in an
/// image's place) or only trims it and leaves the rest in place (stripped
/// injections, a tool result without its answered images). A trimmed part can
/// still be dropped later, as in the plugin, where such a part stays active;
/// the drop's edits then replace the trimming ones.
#[derive(Default)]
pub struct Edited {
    parts: BTreeSet<PartKey>,
    trimmed: BTreeSet<PartKey>,
    messages: BTreeSet<String>,
}

impl Edited {
    /// What `view` changes, plus every message at or before `cut`, the
    /// ordinal a summary is about to cover.
    pub fn of(view: Option<&View>, index: &Index, cut: Option<u64>) -> Self {
        let mut edited = Self::default();
        let mut cut = cut;
        for edit in view.map(|view| view.edits.as_slice()).unwrap_or_default() {
            if let EditOp::Cut { through } = &edit.op {
                let ordinal = index
                    .entries()
                    .iter()
                    .find(|entry| &entry.mid == through)
                    .map(|entry| entry.ordinal);
                cut = cut.max(ordinal);
            }
        }
        if let Some(cut) = cut {
            edited.messages.extend(
                index
                    .entries()
                    .iter()
                    .take_while(|entry| entry.ordinal <= cut)
                    .map(|entry| entry.mid.clone()),
            );
        }
        for edit in view.map(|view| view.edits.as_slice()).unwrap_or_default() {
            match &edit.op {
                EditOp::Drop {
                    mid,
                    part: Some(part),
                } => {
                    edited.parts.insert((mid.clone(), part.clone()));
                }
                EditOp::Replace {
                    mid,
                    part,
                    field,
                    value,
                    ..
                } => {
                    let key = (mid.clone(), part.clone());
                    if reduces_for_good(index, &key, field, value) {
                        edited.parts.insert(key);
                    } else {
                        edited.trimmed.insert(key);
                    }
                }
                EditOp::Drop { mid, part: None } => {
                    edited.messages.insert(mid.clone());
                }
                // Inserts, the cut, and ops ck-mc never builds touch no part.
                _ => {}
            }
        }
        edited.trimmed.retain(|key| !edited.parts.contains(key));
        edited
    }

    /// The part is reduced for good, so no lane changes it again.
    pub fn covers(&self, mid: &str, part: &str) -> bool {
        self.messages.contains(mid) || self.parts.contains(&(mid.to_owned(), part.to_owned()))
    }

    /// The view changes the part in any way, trimming included.
    pub fn touches(&self, mid: &str, part: &str) -> bool {
        self.covers(mid, part) || self.trimmed.contains(&(mid.to_owned(), part.to_owned()))
    }

    /// The highest tag number among the parts the view reduces for good,
    /// whole messages and the messages a cut covers included.
    pub fn watermark(&self, index: &Index) -> u64 {
        let parts = self
            .parts
            .iter()
            .filter_map(|(mid, part)| index.find(mid, part))
            .filter_map(|(_, part)| part.tag);
        let messages = index
            .entries()
            .iter()
            .filter(|entry| self.messages.contains(&entry.mid))
            .flat_map(|entry| entry.parts.iter().filter_map(|part| part.tag));
        parts.chain(messages).max().unwrap_or(0)
    }
}

/// The highest tag number among the parts `ops` reduce for good.
pub fn ops_watermark(index: &Index, ops: &[EditOp]) -> u64 {
    ops.iter()
        .filter_map(|op| match op {
            EditOp::Drop {
                mid,
                part: Some(part),
            } => index.find(mid, part).and_then(|(_, part)| part.tag),
            EditOp::Replace {
                mid,
                part,
                field,
                value,
                ..
            } => {
                let key = (mid.clone(), part.clone());
                reduces_for_good(index, &key, field, value)
                    .then(|| index.find(mid, part).and_then(|(_, part)| part.tag))
                    .flatten()
            }
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

/// Whether a replace reduces its part for good: a text or tool output
/// becoming the part's placeholder, or text in a file's place. Any other
/// replace only trims (a stripped injection, a result without its images) or
/// comes with such a placeholder (a dropped result's attachments, an edit
/// marker's shortened arguments).
fn reduces_for_good(index: &Index, key: &PartKey, field: &str, value: &Value) -> bool {
    let Some((_, part)) = index.find(&key.0, &key.1) else {
        return true;
    };
    match (&part.body, field) {
        (PartBody::File(_), "text") => true,
        (PartBody::Text { .. }, "text") | (PartBody::Tool(_), "output") => {
            part.tag.map(placeholder).as_deref() == value.as_str()
        }
        (PartBody::Tool(_), _) => false,
        _ => true,
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

/// How a lane wants a tool part dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// A recent call with a small input keeps its arguments and only its
    /// result is replaced; any other call goes with its result. Text becomes
    /// the placeholder, reasoning goes.
    Default,
    /// [`Shape::Default`] for a part the model named with `ctx_reduce`. The
    /// model's own request is not held back by `protected_tools`, which only
    /// protects against automatic lanes (the plugin's `pendingDropVeto`).
    Requested,
    /// The call goes with its result, however recent. Used where the call
    /// itself is redundant (a duplicate of a newer identical call).
    Whole,
    /// An edit superseded by a newer edit of the same file: the call stays,
    /// with its file path and only the start of each long diff argument, and
    /// its result is replaced.
    EditMarker,
    /// A text part loses its injected text ([`crate::injection`]) and keeps
    /// the rest; one that held nothing else becomes its placeholder.
    StripInjection,
}

/// The edits that drop `parts`, and which of them those edits cover. A part
/// requested twice keeps the shape of its first request. A part already
/// changed by the latest view counts as covered and gets no new edit. A part
/// that cannot go yet (a running tool call, a protected result) is left out
/// of both, so a queued drop of it waits.
pub fn drop_ops(context: &Context, parts: &[(PartKey, Shape)]) -> (Vec<EditOp>, Vec<PartKey>) {
    let index = context.index;
    let recent: BTreeSet<u64> = index
        .newest_tool_tags(RECENT_TOOL_WINDOW)
        .into_iter()
        .collect();
    let protected = protected_tool_parts(index, context.protected_tools);
    let newest_mid = transcript_end_mid(index);
    let first_mid = index.entries().first().map(|entry| entry.mid.as_str());
    let mut shapes: BTreeMap<&PartKey, Shape> = BTreeMap::new();
    for (key, shape) in parts {
        shapes.entry(key).or_insert(*shape);
    }
    let mut ops = Vec::new();
    let mut covered = Vec::new();
    for (key, shape) in shapes {
        let (mid, part_id) = key;
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
        // A part kind, or an entry role, ck-mc doesn't know is carried
        // unchanged (compaction contract W1.5).
        if !is_known(entry, part) {
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
        // A sealed part (signed or encrypted) can be dropped but never
        // replaced (compaction contract PR5): it goes whole, or not at all.
        let sealed = !part.seal.is_none();
        // The message the request ends on keeps at least one part (compaction
        // contract rule PR6), or the request would end on an older message.
        // With a tool call, its last call staying is enough, and the tool
        // branch below keeps it. Without one, none of its parts is dropped
        // while it is the end; a text part may still become its placeholder.
        // A queued drop of such a part waits for a newer message.
        let final_turn_without_call = Some(entry.mid.as_str()) == newest_mid
            && !entry
                .parts
                .iter()
                .any(|candidate| matches!(candidate.body, PartBody::Tool(_)));
        match &part.body {
            PartBody::Text { .. } if sealed => match (part.tag, shape) {
                // Stripping an injection keeps the rest of the text, which
                // only a replacement could do.
                (Some(_), Shape::StripInjection) | (None, _) => continue,
                (Some(_), _) if final_turn_without_call => continue,
                (Some(_), _) => ops.push(drop()),
            },
            PartBody::Text { text } => match (part.tag, shape) {
                (Some(tag), Shape::StripInjection) => match injection::strip_part(tag, text) {
                    Some(Stripped::Empty) => ops.push(replace("text", json!(placeholder(tag)))),
                    Some(Stripped::Text(kept)) => ops.push(replace("text", json!(kept))),
                    None => continue,
                },
                (Some(tag), _) => ops.push(replace("text", json!(placeholder(tag)))),
                (None, _) => continue,
            },
            PartBody::Reasoning { .. } if final_turn_without_call => continue,
            PartBody::Reasoning { .. } => ops.push(drop()),
            PartBody::Tool(tool) => {
                if !is_finished(&tool.status)
                    || (shape != Shape::Requested && protected.contains(key))
                {
                    continue;
                }
                let Some(tag) = part.tag else {
                    continue;
                };
                let small_recent = recent.contains(&tag)
                    && input_string_bytes(&tool.input) <= SMALL_INPUT_MAX_BYTES;
                let ends = ends_transcript(entry, part, newest_mid);
                if sealed {
                    // Its output can't be replaced; removing the call that
                    // ends the transcript would end the request on it.
                    if ends {
                        continue;
                    }
                    ops.push(drop());
                    covered.push(key.clone());
                    continue;
                }
                let keep_call = match shape {
                    Shape::Default | Shape::Requested | Shape::StripInjection => {
                        ends || small_recent
                    }
                    Shape::Whole => ends,
                    Shape::EditMarker => true,
                };
                if !keep_call {
                    ops.push(drop());
                    covered.push(key.clone());
                    continue;
                }
                ops.push(replace("output", json!(placeholder(tag))));
                if !tool.attachments.is_empty() {
                    ops.push(replace("attachments", json!([])));
                }
                if let (Shape::EditMarker, Some(arguments)) = (shape, tool.input.as_object()) {
                    for (name, value) in arguments {
                        if let Some(marked) = edit_marker(name, value) {
                            ops.push(replace(&format!("input.{name}"), json!(marked)));
                        }
                    }
                }
            }
            // A file or a known opaque part goes only when a lane wants it
            // gone whole (`ctx_keep`); an opaque part can only be dropped.
            PartBody::File(_) | PartBody::Opaque(_)
                if shape == Shape::Whole && !final_turn_without_call =>
            {
                ops.push(drop())
            }
            // Other files, opaque parts and kinds ck-mc doesn't know: no lane
            // here edits them.
            _ => continue,
        }
        covered.push(key.clone());
    }
    (ops, covered)
}

/// The entry the request ends on: the newest entry that has parts. An entry
/// with no parts renders no message, and the transcript may end with several:
/// a step the runner has opened but not yet filled, or a dead step. Measured
/// from the very last entry instead, the call whose result really ends the
/// request loses its protection, and dropping it whole leaves the request
/// ending on an assistant message, which providers refuse.
fn transcript_end_mid(index: &Index) -> Option<&str> {
    index
        .entries()
        .iter()
        .rev()
        .find(|entry| !entry.parts.is_empty())
        .map(|entry| entry.mid.as_str())
}

/// Whether a tool part's result ends the transcript: the last tool part of
/// the entry the request ends on ([`transcript_end_mid`]). Removing that call
/// whole would end the request on its message without the result, so it
/// stays a call; earlier calls of the same message may go whole.
fn ends_transcript(entry: &Entry, part: &Part, newest_mid: Option<&str>) -> bool {
    Some(entry.mid.as_str()) == newest_mid
        && entry
            .parts
            .iter()
            .rev()
            .find(|candidate| matches!(candidate.body, PartBody::Tool(_)))
            .is_some_and(|last| last.id == part.id)
}

/// What dropping a tool part with [`Shape::Default`] wins back: its output
/// and attachments when the call stays (a recent small-input call, or one
/// that ends the transcript), the whole part when it goes. The plugin weighs
/// age-sweep and emergency candidates the same way (`reclaimableTokens`).
pub fn reclaimable_tokens(context: &Context, entry: &Entry, part: &Part) -> u64 {
    let PartBody::Tool(tool) = &part.body else {
        return tokens::part(part);
    };
    let newest_mid = transcript_end_mid(context.index);
    let small_recent = part.tag.is_some_and(|tag| {
        context
            .index
            .newest_tool_tags(RECENT_TOOL_WINDOW)
            .contains(&tag)
            && input_string_bytes(&tool.input) <= SMALL_INPUT_MAX_BYTES
    });
    if small_recent || ends_transcript(entry, part, newest_mid) {
        tokens::tool_result(part, tool)
    } else {
        tokens::part(part)
    }
}

/// Whether a part sits in the protected tail.
pub fn in_protected_tail(context: &Context, key: &PartKey, cutoff: Option<u64>) -> bool {
    context
        .index
        .find(&key.0, &key.1)
        .is_some_and(|(_, part)| in_tail(part, cutoff))
}

/// Diff arguments of an edit call longer than this keep only their start.
pub const EDIT_REGION_HINT_LEN: usize = 40;

/// What a shortened diff argument ends with. Also marks one as already
/// shortened.
const TRUNCATION_SENTINEL: &str = "...[truncated]";

/// The edit-marker form of one argument of an edit call: diff arguments
/// (`oldString`, `newString`, `content` and their snake-case forms) longer
/// than 40 UTF-16 code units keep their first 40, without splitting a
/// surrogate pair, plus a truncation sentinel. `None` for an argument that
/// stays as it is, which includes every file path.
pub fn edit_marker(name: &str, value: &Value) -> Option<String> {
    const DIFF_KEYS: [&str; 5] = [
        "oldString",
        "newString",
        "content",
        "old_string",
        "new_string",
    ];
    let Value::String(text) = value else {
        return None;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    if !DIFF_KEYS.contains(&name)
        || units.len() <= EDIT_REGION_HINT_LEN
        || text.ends_with(TRUNCATION_SENTINEL)
    {
        return None;
    }
    let mut end = EDIT_REGION_HINT_LEN;
    if (0xD800..=0xDBFF).contains(&units[end - 1]) {
        end -= 1;
    }
    Some(format!(
        "{}{TRUNCATION_SENTINEL}",
        String::from_utf16_lossy(&units[..end])
    ))
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
pub(crate) fn starts_user_turn(entry: &Entry) -> bool {
    entry.role == Role::User
        && entry.notice.is_none()
        && entry.parts.iter().any(|part| match &part.body {
            PartBody::Text { text } => !text.trim().is_empty(),
            PartBody::File(_) => true,
            _ => false,
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
/// Tool outputs at or below the bookmark, outside the protected tail. The
/// plugin applies its age reclaim through the same protected-tail veto as
/// every other drop (`pendingDropVeto`), so an output that is far behind by
/// user turns but still among the newest calls stays.
pub fn age_sweep(context: &Context, bookmark: u64, cutoff: Option<u64>) -> Vec<(PartKey, Shape)> {
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
                || in_tail(part, cutoff)
                || context.edited.covers(&entry.mid, &part.id)
                || protected.contains(&key)
                || reclaimable_tokens(context, entry, part) < AGE_SWEEP_MIN_TOKENS
            {
                continue;
            }
            parts.push((key, Shape::Default));
        }
    }
    parts
}

/// Reasoning a step costs when nothing better is known: encrypted or signed
/// reasoning with no reported count and no visible text.
pub const UNKNOWN_REASONING_STEP_TOKENS: u64 = 1_000;

/// How much reasoning one assistant step produced, counting all of its
/// reasoning, with the step's own reported count first. The pass uses it to
/// hold back a rebuild right after heavy reasoning on models whose signed
/// thinking a rebuild would invalidate (`pass.rs`), so it measures how hard
/// the model just thought, not what sending the reasoning again costs.
pub fn step_reasoning_tokens(entry: &Entry) -> u64 {
    let reasoning: Vec<&Part> = entry
        .parts
        .iter()
        .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
        .collect();
    if reasoning.is_empty() {
        return 0;
    }
    generated_cost(entry)
        .or_else(|| entry.reasoning_tokens.map(|counted| counted.count))
        .unwrap_or_else(|| visible_cost(&reasoning))
}

/// What one assistant entry's reasoning costs in the requests that send it
/// again, which is what clearing it frees: the runner's count (measured, or
/// its estimate), else the count the provider reported for the step, else
/// the visible text, else a fixed estimate for reasoning that has no visible
/// text. A runner count of zero stands: reasoning the provider doesn't send
/// again costs nothing.
pub(crate) fn reasoning_cost(entry: &Entry, reasoning: &[&Part]) -> u64 {
    reasoning_measure(entry, reasoning).0
}

/// Keep app attribution and clearing on the same replay-cost precedence.
pub(crate) fn reasoning_measure(entry: &Entry, reasoning: &[&Part]) -> (u64, &'static str) {
    if let Some(counted) = entry.reasoning_tokens {
        (counted.count, "runner")
    } else if let Some(reported) = generated_cost(entry) {
        (reported, "reported")
    } else {
        (visible_cost(reasoning), "estimate")
    }
}

/// The step's reported reasoning count, when the provider gave a non-zero one.
fn generated_cost(entry: &Entry) -> Option<u64> {
    entry
        .usage
        .and_then(|usage| usage.reasoning_tokens)
        .filter(|reported| *reported > 0)
}

/// An estimate from the reasoning's visible text, or a fixed amount for
/// reasoning with none.
fn visible_cost(reasoning: &[&Part]) -> u64 {
    let mut visible = 0;
    let mut opaque = false;
    for part in reasoning {
        if let PartBody::Reasoning { text_bytes, .. } = &part.body {
            visible += tokens::bytes(text_bytes.unwrap_or(0));
            opaque |= text_bytes.unwrap_or(0) == 0 && part.seal != Seal::None;
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
/// `budget`, and drop the reasoning of every older one. As in the plugin
/// (`reasoning-budget.ts`), some entries are charged first and never
/// cleared: the newest assistant, the newest one with reasoning, and, on an
/// Anthropic model, every assistant of the current turn. What goes is always
/// an oldest contiguous run, which every provider accepts, signed reasoning
/// included.
pub fn reasoning_over_budget(
    context: &Context,
    budget: u64,
    anthropic: bool,
) -> Vec<(PartKey, Shape)> {
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
    if assistants.is_empty() {
        return Vec::new();
    }
    let entries = context.index.entries();
    let position_of = |entry: &Entry| entries.iter().position(|e| e.mid == entry.mid);
    // The first assistant that is exempt; every later one is too.
    let mut exempt_from = assistants.len() - 1;
    if let Some(latest) = assistants.iter().rposition(|(entry, _)| {
        entry
            .parts
            .iter()
            .any(|part| matches!(part.body, PartBody::Reasoning { .. }))
    }) {
        exempt_from = exempt_from.min(latest);
    }
    if anthropic {
        if let Some(turn) = crate::pass::current_turn_start(entries) {
            if let Some(first) = assistants
                .iter()
                .position(|(entry, _)| position_of(entry).is_some_and(|at| at >= turn))
            {
                exempt_from = exempt_from.min(first);
            }
        }
    }
    let (older, exempt) = assistants.split_at(exempt_from);
    // An exempt step whose reasoning an earlier view already removed (a
    // signed-part companion drop, say) costs nothing, as in the plugin
    // (`alreadyRemoved`).
    let mut kept: u64 = exempt
        .iter()
        .filter(|(_, reasoning)| !reasoning.is_empty())
        .map(|(entry, reasoning)| reasoning_cost(entry, reasoning))
        .sum();
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
                .map(|part| ((entry.mid.clone(), part.id.clone()), Shape::Default))
        })
        .collect()
}

/// The protected tail's default size for a usable window: 5% of it, at
/// least 8% capped at 16,000 tokens, and never more than 64,000.
pub fn default_protected_tokens(usable_window: u64) -> u64 {
    let usable = usable_window as f64;
    let lower = (0.08 * usable).round().min(16_000.0);
    let target = (0.05 * usable).round();
    target.max(lower).min(64_000.0) as u64
}

/// The protected tail, as the lowest protected tag number: walking tool
/// outputs newest first until they add up to `floor` tokens, and never fewer
/// than the newest three tool calls. Parts tagged at or above it are left
/// alone by the routine heuristics. `None` when the session has no tool
/// calls, which protects nothing.
pub fn protected_cutoff(context: &Context, floor: u64) -> Option<u64> {
    let tools: Vec<(u64, u64)> = context
        .index
        .entries()
        .iter()
        .rev()
        .flat_map(|entry| entry.parts.iter().rev())
        .filter_map(|part| match (&part.body, part.tag) {
            (PartBody::Tool(tool), Some(tag)) => Some((tag, tokens::tool_output(part, tool))),
            _ => None,
        })
        .collect();
    let mut mass = 0;
    let mut mass_cutoff = None;
    for (tag, tokens) in &tools {
        mass += tokens;
        mass_cutoff = Some(*tag);
        if mass >= floor {
            break;
        }
    }
    let newest_three = tools.iter().take(3).next_back().map(|(tag, _)| *tag);
    match (mass_cutoff, newest_three) {
        (Some(mass), Some(three)) => Some(mass.min(three)),
        (cutoff, three) => cutoff.or(three),
    }
}

fn in_tail(part: &Part, cutoff: Option<u64>) -> bool {
    match (part.tag, cutoff) {
        (Some(tag), Some(cutoff)) => tag >= cutoff,
        _ => false,
    }
}

/// Every tool part with the entry that holds it, oldest first.
fn tool_parts<'a>(
    context: &'a Context,
) -> impl Iterator<Item = (&'a Entry, &'a Part, &'a ToolPart)> + 'a {
    context.index.entries().iter().flat_map(|entry| {
        entry.parts.iter().filter_map(move |part| match &part.body {
            PartBody::Tool(tool) => Some((entry, part, tool)),
            _ => None,
        })
    })
}

/// Lookup tools whose identical repeated calls return the same thing.
const DEDUP_TOOLS: [&str; 9] = [
    "grep",
    "read",
    "glob",
    "ast_grep_search",
    "lsp_diagnostics",
    "lsp_symbols",
    "lsp_find_references",
    "lsp_goto_definition",
    "lsp_prepare_rename",
];

/// Duplicate lookups: calls of the same lookup tool with the same arguments
/// within one assistant message. The newest stays; older ones go whole,
/// outside the protected tail.
pub fn duplicate_lookups(context: &Context, cutoff: Option<u64>) -> Vec<(PartKey, Shape)> {
    let mut newest: BTreeMap<(String, String, String), u64> = BTreeMap::new();
    let mut calls = Vec::new();
    for (entry, part, tool) in tool_parts(context) {
        let name = tool.name.strip_prefix("mcp_").unwrap_or(&tool.name);
        let (true, Some(tag)) = (DEDUP_TOOLS.contains(&name), part.tag) else {
            continue;
        };
        let input = serde_json::to_string(&tool.input).unwrap_or_default();
        let key = (entry.mid.clone(), tool.name.clone(), input);
        let held = newest.entry(key.clone()).or_insert(tag);
        *held = (*held).max(tag);
        calls.push((key, tag, entry, part));
    }
    calls
        .into_iter()
        .filter(|(key, tag, _, part)| newest[key] != *tag && !in_tail(part, cutoff))
        .map(|(_, _, entry, part)| ((entry.mid.clone(), part.id.clone()), Shape::Whole))
        .collect()
}

/// Injected text: numbered text parts outside the protected tail that hold a
/// harness or plugin injection ([`crate::injection`]), in any message the
/// model sees, as in the plugin's heuristic cleanup.
pub fn injected_text(context: &Context, cutoff: Option<u64>) -> Vec<(PartKey, Shape)> {
    context
        .index
        .entries()
        .iter()
        // A notice is already a distinct instruction from the runner, not
        // injected framing inside a person's prompt. Keep it actionable.
        .filter(|entry| entry.notice.is_none())
        .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
        .filter(|(entry, part)| {
            !in_tail(part, cutoff) && !context.edited.touches(&entry.mid, &part.id)
        })
        .filter(|(_, part)| match (&part.body, part.tag) {
            (PartBody::Text { text }, Some(tag)) => injection::strip_part(tag, text).is_some(),
            _ => false,
        })
        .map(|(entry, part)| ((entry.mid.clone(), part.id.clone()), Shape::StripInjection))
        .collect()
}

/// How far each compressed text part is compressed, and with which word
/// rules, so a part only ever deepens and a change of `language` rewrites
/// every compressed part once.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CavemanState {
    /// Message id, part id and depth: 1 lite, 2 full, 3 ultra.
    pub depths: Vec<(String, String, u8)>,
    /// The word rules the compressed parts were written with.
    pub english_word_rules: Option<bool>,
}

impl CavemanState {
    fn depth(&self, key: &PartKey) -> u8 {
        self.depths
            .iter()
            .find(|(mid, part, _)| *mid == key.0 && *part == key.1)
            .map_or(0, |(_, _, depth)| *depth)
    }

    /// Forget parts the index no longer holds.
    pub fn retain_present(&mut self, index: &Index) {
        self.depths
            .retain(|(mid, part, _)| index.find(mid, part).is_some());
    }
}

/// The depth a text part should have by its place among the eligible parts,
/// oldest first: the oldest 20% ultra, the next 20% full, the next 20% lite,
/// the newest 40% untouched (`computeTargetDepth` in `caveman-cleanup.ts`).
pub fn caveman_target_depth(position: usize, total: usize) -> u8 {
    if total == 0 {
        return 0;
    }
    let fraction = position as f64 / total as f64;
    if fraction < 0.2 {
        3
    } else if fraction < 0.4 {
        2
    } else if fraction < 0.6 {
        1
    } else {
        0
    }
}

/// The caveman lane, as the plugin's `applyCavemanCleanup`: numbered text
/// parts outside the protected tail, not dropped, whose text is at least
/// `min_chars` bytes, are compressed by age ([`caveman_target_depth`]), only
/// ever deeper, always from their original text (after stripping injected
/// regions, as the plugin's stored source is). A compressed part keeps its
/// prefix and can still be dropped. When the word rules changed, every
/// compressed part is rewritten at its depth.
///
/// Returns each part's new text and the state to keep once the view is
/// taken. A part whose compressed text equals what it already shows gets its
/// depth and no text.
pub fn caveman(
    context: &Context,
    settings: &crate::pass::Caveman,
    state: &CavemanState,
    cutoff: Option<u64>,
    skip: &[PartKey],
) -> (Vec<(PartKey, String)>, CavemanState) {
    let rewrite_all = state
        .english_word_rules
        .is_some_and(|english| english != settings.english_word_rules);
    let mut eligible: Vec<(u64, PartKey, &str, String)> = context
        .index
        .entries()
        .iter()
        .filter(|entry| entry.role != Role::System)
        .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
        .filter_map(|(entry, part)| {
            let (PartBody::Text { text }, Some(tag)) = (&part.body, part.tag) else {
                return None;
            };
            let key = (entry.mid.clone(), part.id.clone());
            // A role or part kind ck-mc doesn't know is carried unchanged
            // (compaction contract W1.5), as in every other lane.
            if !is_known(entry, part)
                || in_tail(part, cutoff)
                || context.edited.covers(&entry.mid, &part.id)
                || skip.contains(&key)
            {
                return None;
            }
            let source = injection::stripped_source(tag, text).unwrap_or_else(|| text.clone());
            (source.len() as u64 >= settings.min_chars).then_some((tag, key, text.as_str(), source))
        })
        .collect();
    eligible.sort_by_key(|(tag, ..)| *tag);
    let total = eligible.len();
    let mut next = CavemanState {
        depths: Vec::new(),
        english_word_rules: Some(settings.english_word_rules),
    };
    let mut texts = Vec::new();
    for (position, (tag, key, text, source)) in eligible.into_iter().enumerate() {
        let current = state.depth(&key);
        let target = caveman_target_depth(position, total);
        let depth = if target > current {
            target
        } else if current > 0 && rewrite_all {
            current
        } else {
            if current > 0 {
                next.depths.push((key.0, key.1, current));
            }
            continue;
        };
        let level = match depth {
            1 => crate::caveman::CavemanLevel::Lite,
            2 => crate::caveman::CavemanLevel::Full,
            _ => crate::caveman::CavemanLevel::Ultra,
        };
        let compressed = crate::caveman::compress_with(&source, level, settings.english_word_rules);
        if compressed.is_empty() {
            if current > 0 {
                next.depths.push((key.0, key.1, current));
            }
            continue;
        }
        let shown = format!("§{tag}§ {compressed}");
        if shown != format!("§{tag}§ {text}") {
            texts.push((key.clone(), shown));
        }
        next.depths.push((key.0, key.1, depth));
    }
    (texts, next)
}

/// The text an answered image becomes.
pub const IMAGE_STRIPPED: &str = "[image stripped]";

/// An image whose bytes go with every request, as the plugin counts one
/// (`isProcessedImagePart`): inline, with a data URL longer than 200
/// characters.
pub fn is_inline_image(media: &FileMedia) -> bool {
    let data_url_prefix = format!("data:{};base64,", media.mime).len() as u64;
    media.mime.starts_with("image/")
        && media.transport == Transport::Inline
        && media
            .size
            .is_none_or(|bytes| bytes.div_ceil(3) * 4 + data_url_prefix > 200)
}

fn image_attachments(tool: &ToolPart) -> usize {
    tool.attachments
        .iter()
        .filter(|attachment| matches!(&attachment.item, AttachmentItem::File(media) if is_inline_image(media)))
        .count()
}

/// Finished tool results with an inline image attachment that no view has
/// changed yet: the answered-images lane rewrites their output, so it needs
/// their output text, which the index does not hold.
pub fn image_results(index: &Index, edited: &Edited) -> Vec<PartKey> {
    index
        .entries()
        .iter()
        .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
        .filter(|(entry, part)| match &part.body {
            PartBody::Tool(tool) => {
                tool.status == ToolStatus::Completed
                    && !tool.provider_executed
                    && part.seal == Seal::None
                    && image_attachments(tool) > 0
                    && !edited.touches(&entry.mid, &part.id)
            }
            _ => false,
        })
        .map(|(entry, part)| (entry.mid.clone(), part.id.clone()))
        .collect()
}

/// What the answered-images lane goes by.
pub struct Images<'a> {
    /// The output text of the tool results [`image_results`] names, as far
    /// as ck-mc has read it. A result whose text is missing waits.
    pub outputs: &'a BTreeMap<PartKey, String>,
    /// The highest tag number any view or this pass reduces for good.
    pub watermark: u64,
    pub cutoff: Option<u64>,
    /// A request that would not fit: the protected tail yields.
    pub over_limit: bool,
    /// Parts this pass already changes.
    pub skip: &'a [PartKey],
}

/// Answered images, as in the plugin (`stripProcessedImages` with
/// `createProcessedImageEligibility`): an inline image in a person's message
/// or a tool result goes once a later assistant message has answered it and
/// content at least as new as its message has been dropped (its message's
/// highest tag, or the next tagged message's, is at or below the watermark),
/// outside the protected tail. An image in a person's message becomes
/// `[image stripped]`. A tool result keeps its text and other attachments,
/// with one `[image stripped]` line per removed image. Protected tool results
/// and the first message of a session that keeps it stay.
pub fn answered_images(context: &Context, images: &Images) -> (Vec<EditOp>, Vec<PartKey>) {
    let entries = context.index.entries();
    if images.watermark == 0 {
        return (Vec::new(), Vec::new());
    }
    let protected = protected_tool_parts(context.index, context.protected_tools);
    // Each message's age: its own highest tag, or the next tagged message's.
    let mut ages = vec![None; entries.len()];
    let mut next = None;
    for (position, entry) in entries.iter().enumerate().rev() {
        if let Some(own) = entry.parts.iter().filter_map(|part| part.tag).max() {
            next = Some(own);
        }
        ages[position] = next;
    }
    let mut answered = false;
    let mut ops = Vec::new();
    let mut changed = Vec::new();
    for (position, entry) in entries.iter().enumerate().rev() {
        let was_answered = answered;
        if entry.role == Role::Assistant {
            answered = true;
        }
        let Some(age) = ages[position] else {
            continue;
        };
        let eligible = was_answered
            && age <= images.watermark
            && (images.over_limit || images.cutoff.is_none_or(|cutoff| age < cutoff))
            && !(context.keep_first_message && position == 0);
        if !eligible || !matches!(entry.role, Role::User | Role::Assistant) {
            continue;
        }
        for part in &entry.parts {
            let key = (entry.mid.clone(), part.id.clone());
            if part.seal != Seal::None
                || context.edited.touches(&entry.mid, &part.id)
                || images.skip.contains(&key)
            {
                continue;
            }
            let replace = |field: &str, value: Value| EditOp::Replace {
                mid: entry.mid.clone(),
                part: part.id.clone(),
                field: field.into(),
                value,
                expect: part.digest.clone(),
            };
            match &part.body {
                PartBody::File(media) if entry.role == Role::User && is_inline_image(media) => {
                    ops.push(replace("text", json!(IMAGE_STRIPPED)));
                    changed.push(key);
                }
                PartBody::Tool(tool)
                    if entry.role == Role::Assistant
                        && tool.status == ToolStatus::Completed
                        && !tool.provider_executed
                        && !protected.contains(&key) =>
                {
                    let removed = image_attachments(tool);
                    let (Some(tag), Some(output), true) =
                        (part.tag, images.outputs.get(&key), removed > 0)
                    else {
                        continue;
                    };
                    let kept: Vec<&str> = tool
                        .attachments
                        .iter()
                        .filter(|attachment| !matches!(&attachment.item, AttachmentItem::File(media) if is_inline_image(media)))
                        .map(|attachment| attachment.id.as_str())
                        .collect();
                    let lines: Vec<&str> = std::iter::once(output.as_str())
                        .chain(std::iter::repeat_n(IMAGE_STRIPPED, removed))
                        .filter(|line| !line.is_empty())
                        .collect();
                    // A replaced output is final, so it carries its prefix.
                    ops.push(replace(
                        "output",
                        json!(format!("§{tag}§ {}", lines.join("\n"))),
                    ));
                    ops.push(replace("attachments", json!(kept)));
                    changed.push(key);
                }
                _ => {}
            }
        }
    }
    (ops, changed)
}

/// The newest messages that own tagged parts: tool calls among them may still
/// guide what the model does next, so supersession leaves them alone.
pub const SUPERSESSION_RECENT_MESSAGE_WINDOW: usize = 20;

fn recent_owner_messages<'a>(context: &'a Context) -> BTreeSet<&'a str> {
    context
        .index
        .entries()
        .iter()
        .rev()
        .filter(|entry| entry.parts.iter().any(|part| part.tag.is_some()))
        .take(SUPERSESSION_RECENT_MESSAGE_WINDOW)
        .map(|entry| entry.mid.as_str())
        .collect()
}

/// Spent control-plane outputs: results that are worthless once the call
/// ran (`todowrite`, `ctx_reduce`, `bash_status`, `bash_kill`, and `ctx_note`
/// reads and dismissals), whatever their age, outside the newest 20 owning
/// messages and the protected tail.
pub fn spent_control_plane(context: &Context, cutoff: Option<u64>) -> Vec<(PartKey, Shape)> {
    let recent = recent_owner_messages(context);
    tool_parts(context)
        .filter(|(entry, part, tool)| {
            let spent = match normalize_tool_name(&tool.name).as_str() {
                "todowrite" | "ctx_reduce" | "bash_status" | "bash_kill" => true,
                // Writes and updates carry intent; only reads and dismissals
                // are spent. An unreadable action is not spent.
                "ctx_note" => matches!(
                    tool.input.get("action").and_then(Value::as_str),
                    Some("read" | "dismiss")
                ),
                _ => false,
            };
            spent && !recent.contains(entry.mid.as_str()) && !in_tail(part, cutoff)
        })
        .map(|(entry, part, _)| ((entry.mid.clone(), part.id.clone()), Shape::Default))
        .collect()
}

/// Superseded edits: among `edit` and `write` calls on the same file, the
/// newest stays whole. An older one becomes an edit marker once it is at or
/// below the age sweep's bookmark (it was far behind on an earlier rebuild),
/// outside the newest 20 owning messages and the protected tail. A call
/// without a readable file path is never superseded.
pub fn superseded_edits(
    context: &Context,
    cutoff: Option<u64>,
    bookmark: u64,
) -> Vec<(PartKey, Shape)> {
    let recent = recent_owner_messages(context);
    let mut seen_files = BTreeSet::new();
    let mut parts = Vec::new();
    let edits: Vec<_> = tool_parts(context)
        .filter(|(_, _, tool)| tool.name == "edit" || tool.name == "write")
        .collect();
    for (entry, part, tool) in edits.into_iter().rev() {
        // An edit an earlier view dropped is gone from the model's view, so
        // it does not make an older edit of the same file superseded.
        if in_tail(part, cutoff) || context.edited.covers(&entry.mid, &part.id) {
            continue;
        }
        let Some(path) = ["filePath", "file_path", "path"].iter().find_map(|key| {
            tool.input
                .get(*key)
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
        }) else {
            continue;
        };
        if seen_files.insert(path.to_owned()) {
            continue;
        }
        if part.tag.is_some_and(|tag| tag <= bookmark) && !recent.contains(entry.mid.as_str()) {
            parts.push(((entry.mid.clone(), part.id.clone()), Shape::EditMarker));
        }
    }
    parts
}

/// The emergency drop reclaims down to the fixed part of the prompt plus
/// this share of the room up to the ceiling.
pub const EMERGENCY_TARGET_FRACTION: f64 = 0.3;

/// The newest share of read-type and edit-type outputs the emergency drop
/// keeps as continuation context, below the runner's limit.
pub const EMERGENCY_TIER_RESERVE: f64 = 0.2;

/// The emergency drop does nothing for less than this, unless the pass
/// rewrites anyway: a rewrite of the whole cached prefix is not worth it.
pub const EMERGENCY_MIN_TOKENS: u64 = 2_000;

/// How the emergency drop orders tools: tier 3 goes first, tier 1 last.
pub fn emergency_tier(name: &str) -> u8 {
    match normalize_tool_name(name).as_str() {
        "read" | "todowrite" | "task" | "aft_outline" | "aft_zoom" => 1,
        "edit" | "write" | "apply_patch" | "grep" | "glob" | "aft_search" => 2,
        _ => 3,
    }
}

/// What the emergency drop knows about the pass.
pub struct Emergency {
    /// The prompt size it reclaims from: the newest reported prompt, or the
    /// runner's estimate of the request it is about to send.
    pub prompt_tokens: u64,
    /// The usable window times the execute threshold.
    pub ceiling_tokens: u64,
    /// The runner said the next request would not fit: the protected tail and
    /// the tier reserve yield, and dropped calls go whole. Protected tools
    /// still stay.
    pub over_limit: bool,
    /// Another lane already rewrites the prompt on this pass, so even a small
    /// reclaim is worth taking.
    pub priced: bool,
}

/// The tiered emergency drop, from the force band on: tool outputs go,
/// tier 3 first, oldest first within a tier, until the prompt is down to the
/// fixed part plus 30% of the room up to the ceiling. The fixed part is what
/// the prompt holds besides the transcript (system prompt, tools), measured as
/// the reported prompt minus the transcript's estimate.
pub fn emergency_drop(
    context: &Context,
    cutoff: Option<u64>,
    emergency: &Emergency,
) -> Vec<(PartKey, Shape)> {
    if emergency.prompt_tokens == 0 || emergency.ceiling_tokens == 0 {
        return Vec::new();
    }
    let transcript: u64 = context
        .index
        .entries()
        .iter()
        .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
        .filter(|(entry, part)| !context.edited.covers(&entry.mid, &part.id))
        .map(|(_, part)| tokens::part(part))
        .sum();
    let fixed = emergency.prompt_tokens.saturating_sub(transcript) as f64;
    let ceiling = emergency.ceiling_tokens as f64;
    if fixed > ceiling {
        // Dropping tool output cannot reach the target.
        return Vec::new();
    }
    let target = fixed + EMERGENCY_TARGET_FRACTION * (ceiling - fixed);
    let reclaim = (emergency.prompt_tokens as f64 - target).round();
    if reclaim <= EMERGENCY_MIN_TOKENS as f64 {
        return Vec::new();
    }
    let protected = protected_tool_parts(context.index, context.protected_tools);
    // Every output that could go, tail included: the tier reserve is taken
    // over these, as the plugin does, so it mostly overlaps the tail.
    let droppable: Vec<(&Entry, &Part, u8)> = tool_parts(context)
        .filter(|(entry, part, tool)| {
            is_finished(&tool.status)
                && part.tag.is_some()
                && !context.edited.covers(&entry.mid, &part.id)
        })
        .map(|(entry, part, tool)| (entry, part, emergency_tier(&tool.name)))
        .collect();
    let mut reserved = BTreeSet::new();
    if !emergency.over_limit {
        for tier in [1, 2] {
            let newest: Vec<u64> = droppable
                .iter()
                .rev()
                .filter(|(_, _, candidate)| *candidate == tier)
                .filter_map(|(_, part, _)| part.tag)
                .collect();
            let keep = (EMERGENCY_TIER_RESERVE * newest.len() as f64).ceil() as usize;
            reserved.extend(newest.into_iter().take(keep));
        }
    }
    let candidates: Vec<&(&Entry, &Part, u8)> = droppable
        .iter()
        .filter(|(entry, part, _)| {
            !protected.contains(&(entry.mid.clone(), part.id.clone()))
                && (emergency.over_limit || !in_tail(part, cutoff))
        })
        .collect();
    let shape = if emergency.over_limit {
        Shape::Whole
    } else {
        Shape::Default
    };
    let mut selected = Vec::new();
    let mut reclaimed = 0;
    'tiers: for tier in [3, 2, 1] {
        for (entry, part, _) in candidates
            .iter()
            .filter(|(_, _, candidate)| *candidate == tier)
        {
            if part.tag.is_some_and(|tag| reserved.contains(&tag)) {
                continue;
            }
            selected.push(((entry.mid.clone(), part.id.clone()), shape));
            reclaimed += if emergency.over_limit {
                tokens::part(part)
            } else {
                reclaimable_tokens(context, entry, part)
            };
            if reclaimed as f64 >= reclaim {
                break 'tiers;
            }
        }
    }
    if !emergency.priced && reclaimed < EMERGENCY_MIN_TOKENS {
        return Vec::new();
    }
    selected
}

/// The parts a `ctx_keep` view drops: everything before the message holding
/// the `ctx_keep` call, except messages from the person, the session's first
/// message when it keeps it, the selected parts, and the protected tail. The call's
/// message and everything after it stay, so the model sees its own note.
pub fn keep_drops(
    context: &Context,
    kept: &BTreeSet<PartKey>,
    cutoff: Option<u64>,
) -> Vec<(PartKey, Shape)> {
    let entries = context.index.entries();
    let Some(call_at) = entries.iter().rposition(|entry| {
        entry
            .parts
            .iter()
            .any(|part| matches!(&part.body, PartBody::Tool(tool) if tool.name == "ctx_keep"))
    }) else {
        return Vec::new();
    };
    let mut drops = Vec::new();
    for (position, entry) in entries[..call_at].iter().enumerate() {
        if (position == 0 && context.keep_first_message)
            || (entry.role == Role::User && entry.notice.is_none())
        {
            continue;
        }
        for part in &entry.parts {
            let key = (entry.mid.clone(), part.id.clone());
            if kept.contains(&key) || in_tail(part, cutoff) {
                continue;
            }
            drops.push((key, Shape::Whole));
        }
    }
    drops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::neutral::part;

    fn entry(ordinal: u64, role: Role, parts: Vec<Part>) -> Entry {
        Entry::new(ordinal, format!("m{ordinal}"), role, 0, parts)
    }

    fn read(tag: u64, output_bytes: u64) -> Part {
        part(
            format!("p{tag}"),
            Some(tag),
            Seal::None,
            PartBody::Tool(
                ToolPart::new(
                    format!("c{tag}"),
                    "read",
                    json!({"path": "b.rs"}),
                    ToolStatus::Completed,
                )
                .with_output_bytes(output_bytes),
            ),
        )
    }

    /// Two identical reads in one message (tags 2 and 3), then reads of
    /// 4,000 bytes (1,000 tokens) at tags 4, 5 and 6.
    fn index() -> Index {
        let text = |tag: u64| {
            part(
                format!("p{tag}"),
                Some(tag),
                Seal::None,
                PartBody::Text { text: "Go.".into() },
            )
        };
        let mut index = Index::default();
        index.extend([
            entry(1, Role::User, vec![text(1)]),
            entry(2, Role::Assistant, vec![read(2, 40), read(3, 40)]),
            entry(3, Role::Assistant, vec![read(4, 4_000)]),
            entry(4, Role::Assistant, vec![read(5, 4_000)]),
            entry(5, Role::Assistant, vec![read(6, 4_000)]),
        ]);
        index
    }

    #[test]
    fn the_protected_tail_covers_the_floor_and_at_least_three_calls_and_the_heuristics_respect_it()
    {
        let index = index();
        let edited = Edited::default();
        let protected_tools = BTreeMap::new();
        let context = Context {
            index: &index,
            edited: &edited,
            protected_tools: &protected_tools,
            keep_first_message: false,
        };
        // The newest three calls (6, 5, 4) hold 3,000 tokens.
        assert_eq!(protected_cutoff(&context, 1), Some(4));
        assert_eq!(protected_cutoff(&context, 3_000), Some(4));
        assert_eq!(protected_cutoff(&context, 3_001), Some(3));
        assert_eq!(protected_cutoff(&context, 100_000), Some(2));

        let duplicate = vec![(("m2".to_owned(), "p2".to_owned()), Shape::Whole)];
        assert_eq!(duplicate_lookups(&context, Some(4)), duplicate);
        assert_eq!(duplicate_lookups(&context, Some(2)), []);
    }

    fn context<'a>(
        index: &'a Index,
        edited: &'a Edited,
        protected_tools: &'a BTreeMap<String, u64>,
    ) -> Context<'a> {
        Context {
            index,
            edited,
            protected_tools,
            keep_first_message: false,
        }
    }

    fn key(mid: &str, part: &str) -> PartKey {
        (mid.to_owned(), part.to_owned())
    }

    #[test]
    fn the_age_sweep_skips_small_outputs_and_the_newest_results_of_protected_tools() {
        let index = index();
        let edited = Edited::default();
        let none = BTreeMap::new();
        // The outputs numbered 2 and 3 (`m2/p2`, `m3/p3` above) are 10 tokens
        // each, under the 250-token floor.
        let swept: Vec<PartKey> = age_sweep(&context(&index, &edited, &none), 6, None)
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(swept, [key("m3", "p4"), key("m4", "p5"), key("m5", "p6")]);

        // The newest `read` result is protected: no lane drops it, not the
        // age sweep and not a drop another lane asks for.
        let one_read = BTreeMap::from([("read".to_owned(), 1)]);
        let protected = context(&index, &edited, &one_read);
        let swept: Vec<PartKey> = age_sweep(&protected, 6, None)
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(swept, [key("m3", "p4"), key("m4", "p5")]);
        let (ops, covered) = drop_ops(&protected, &[(key("m5", "p6"), Shape::Whole)]);
        assert!(ops.is_empty() && covered.is_empty(), "{ops:?}");
        // The model's own `ctx_reduce` of it still lands: protected tools
        // only hold back automatic lanes.
        let (ops, covered) = drop_ops(&protected, &[(key("m5", "p6"), Shape::Requested)]);
        assert_eq!(covered, [key("m5", "p6")], "{ops:?}");
    }

    fn reasoning(id: &str, text_bytes: u64) -> Part {
        part(
            id.to_owned(),
            None,
            Seal::None,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(text_bytes),
            },
        )
    }

    /// On an Anthropic model, every assistant of the current turn keeps its
    /// reasoning, as in the plugin; elsewhere only the newest one is exempt.
    #[test]
    fn reasoning_of_the_current_anthropic_turn_is_never_cleared() {
        let say = |tag: u64| {
            part(
                format!("p{tag}"),
                Some(tag),
                Seal::None,
                PartBody::Text { text: "Go.".into() },
            )
        };
        let mut index = Index::default();
        // One person turn, then three steps of 6,000 reasoning tokens each.
        index.extend([
            entry(1, Role::User, vec![say(1)]),
            entry(2, Role::Assistant, vec![reasoning("r2", 24_000)]),
            entry(3, Role::Assistant, vec![reasoning("r3", 24_000)]),
            entry(4, Role::Assistant, vec![reasoning("r4", 24_000)]),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let context = context(&index, &edited, &none);
        assert!(reasoning_over_budget(&context, 10_000, true).is_empty());
        let cleared: Vec<PartKey> = reasoning_over_budget(&context, 10_000, false)
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(cleared, [key("m2", "r2"), key("m3", "r3")]);
    }

    /// The reasoning budget weighs reasoning by what sending it again costs,
    /// the runner's count first; the heavy-reasoning measure weighs how much
    /// the step produced, the provider's reported count first.
    #[test]
    fn the_budget_uses_the_replay_count_and_the_hold_the_generated_one() {
        let mut step = entry(1, Role::Assistant, vec![reasoning("r1", 400)]);
        // Visible text alone: 100 for both.
        assert_eq!(step_reasoning_tokens(&step), 100);
        assert_eq!(reasoning_cost(&step, &[&step.parts[0].clone()]), 100);
        step.usage = Some(
            cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(2_000),
        );
        step.reasoning_tokens = Some(cortexkit_role_compaction::tokens::ReasoningTokens::new(
            0, true,
        ));
        let parts = [&step.parts[0].clone()];
        assert_eq!(step_reasoning_tokens(&step), 2_000);
        assert_eq!(reasoning_cost(&step, &parts), 0);
        step.reasoning_tokens = Some(cortexkit_role_compaction::tokens::ReasoningTokens::new(
            1_800, false,
        ));
        assert_eq!(reasoning_cost(&step, &parts), 1_800);
    }

    #[test]
    fn reasoning_replay_measure_preserves_all_fallbacks() {
        let mut step = entry(1, Role::Assistant, vec![reasoning("r1", 400)]);
        let check = |step: &Entry, cost, source| {
            let parts = step.parts.iter().collect::<Vec<_>>();
            assert_eq!(reasoning_cost(step, &parts), cost);
            assert_eq!(reasoning_measure(step, &parts), (cost, source));
        };
        check(&step, 100, "estimate");
        step.usage = Some(
            cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(2_000),
        );
        check(&step, 2_000, "reported");
        step.reasoning_tokens = Some(cortexkit_role_compaction::tokens::ReasoningTokens::new(
            1_800, false,
        ));
        check(&step, 1_800, "runner");
        step.reasoning_tokens = Some(cortexkit_role_compaction::tokens::ReasoningTokens::new(
            0, true,
        ));
        check(&step, 0, "runner");
        step.reasoning_tokens = None;
        step.usage = Some(cortexkit_role_compaction::read::StepUsage::default());
        step.parts[0] = reasoning("r1", 0);
        step.parts[0].seal = Seal::Encrypted;
        check(&step, 1_000, "estimate");
        step.parts[0].seal = Seal::None;
        check(&step, 0, "estimate");
    }

    /// An exempt step whose reasoning is already gone (here the steps of the
    /// current Anthropic turn, which report reasoning but hold none) costs
    /// nothing against the budget, so older reasoning that fits stays.
    #[test]
    fn exempt_steps_without_reasoning_left_cost_nothing() {
        let say = |id: &str, tag: u64| {
            part(
                id.to_owned(),
                Some(tag),
                Seal::None,
                PartBody::Text { text: "Go.".into() },
            )
        };
        let reported = |mut step: Entry| {
            step.usage = Some(
                cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(6_000),
            );
            step
        };
        // 8,000 and 2,000 tokens of older reasoning (the newer of them is the
        // newest reasoning left, so exempt), then a turn whose two steps
        // report 6,000 each but hold none. Only the 2,000 counts as kept, so
        // the 8,000 fits the 10,000 budget.
        let mut index = Index::default();
        index.extend([
            entry(1, Role::Assistant, vec![reasoning("r1", 32_000)]),
            entry(2, Role::Assistant, vec![reasoning("r2", 8_000)]),
            entry(3, Role::User, vec![say("p3", 3)]),
            reported(entry(4, Role::Assistant, vec![say("p4", 4)])),
            reported(entry(5, Role::Assistant, vec![say("p5", 5)])),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        assert!(reasoning_over_budget(&context(&index, &edited, &none), 10_000, true).is_empty());
    }

    /// When the newest assistant has no reasoning, the newest one that has
    /// keeps it.
    #[test]
    fn the_newest_reasoning_is_kept_when_the_newest_step_has_none() {
        let mut index = Index::default();
        index.extend([
            entry(1, Role::Assistant, vec![reasoning("r1", 4_000)]),
            entry(2, Role::Assistant, vec![reasoning("r2", 48_000)]),
            entry(3, Role::Assistant, vec![read(3, 40)]),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let cleared: Vec<PartKey> =
            reasoning_over_budget(&context(&index, &edited, &none), 10_000, false)
                .into_iter()
                .map(|(key, _)| key)
                .collect();
        assert_eq!(cleared, [key("m1", "r1")]);
    }

    /// The age sweep weighs what a drop wins back: for a recent call with a
    /// small input, only its output.
    #[test]
    fn the_age_sweep_weighs_only_the_output_of_a_call_that_stays() {
        let mut big_input = read(2, 400);
        if let PartBody::Tool(tool) = &mut big_input.body {
            tool.input = json!({"path": "b.rs", "pattern": "x".repeat(900)});
        }
        let mut index = Index::default();
        index.extend([
            entry(1, Role::Assistant, vec![big_input]),
            entry(2, Role::Assistant, vec![read(3, 40)]),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        // 100 output tokens, under the floor, though the whole part is over.
        assert!(age_sweep(&context(&index, &edited, &none), 3, None).is_empty());
    }

    /// An edit an earlier view dropped does not make the edit before it of
    /// the same file superseded.
    #[test]
    fn a_dropped_edit_does_not_supersede_an_older_one() {
        let edit = |tag: u64| {
            part(
                format!("p{tag}"),
                Some(tag),
                Seal::None,
                PartBody::Tool(
                    ToolPart::new(
                        format!("c{tag}"),
                        "edit",
                        json!({"filePath": "c.rs", "oldString": "a", "newString": "b"}),
                        ToolStatus::Completed,
                    )
                    .with_output_bytes(40),
                ),
            )
        };
        let mut index = Index::default();
        index.extend([
            entry(1, Role::Assistant, vec![edit(1)]),
            entry(2, Role::Assistant, vec![edit(2)]),
            entry(3, Role::Assistant, vec![edit(3)]),
        ]);
        // Newer messages take the edits out of the newest 20.
        index.extend((4..=24).map(|n| entry(n, Role::Assistant, vec![read(n, 40)])));
        let none = BTreeMap::new();
        let nothing = Edited::default();
        let marked: Vec<PartKey> = superseded_edits(&context(&index, &nothing, &none), None, 3)
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(marked, [key("m2", "p2"), key("m1", "p1")]);
        let mut dropped = Edited::default();
        dropped.parts.insert(key("m3", "p3"));
        let marked: Vec<PartKey> = superseded_edits(&context(&index, &dropped, &none), None, 3)
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(marked, [key("m1", "p1")]);
    }

    /// Of two calls in the newest message, only the last one ends the
    /// transcript and stays a call; the earlier one goes whole.
    #[test]
    fn only_the_last_call_of_the_newest_message_stays_a_call() {
        let mut a = read(2, 40);
        if let PartBody::Tool(tool) = &mut a.body {
            tool.input = json!({"path": "b.rs", "pattern": "x".repeat(2_000)});
        }
        let mut index = Index::default();
        index.extend([entry(1, Role::Assistant, vec![a, read(3, 40)])]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let context = context(&index, &edited, &none);
        let (ops, _) = drop_ops(
            &context,
            &[
                (key("m1", "p2"), Shape::Default),
                (key("m1", "p3"), Shape::Default),
            ],
        );
        assert!(ops.contains(&EditOp::Drop {
            mid: "m1".into(),
            part: Some("p2".into())
        }));
        assert!(!ops.contains(&EditOp::Drop {
            mid: "m1".into(),
            part: Some("p3".into())
        }));
    }

    /// Entries with no parts after the last call, such as a step the runner
    /// opened before asking for a view, don't move the end of the request:
    /// that call still stays a call, even in a lane that drops whole.
    /// The message the request ends on, when it has no tool call, keeps all
    /// its parts: dropping its last one would end the request on an older
    /// message. Its drop waits until a newer message arrives.
    #[test]
    fn the_message_the_request_ends_on_keeps_a_part_until_a_newer_one_arrives() {
        let thought = || {
            part(
                "r",
                Some(2),
                Seal::None,
                PartBody::Reasoning {
                    text: Some("thinking".into()),
                    text_bytes: Some(8),
                },
            )
        };
        let user = |ordinal: u64| {
            entry(
                ordinal,
                Role::User,
                vec![part(
                    "t",
                    Some(ordinal * 10),
                    Seal::None,
                    PartBody::Text { text: "Go.".into() },
                )],
            )
        };
        let mut index = Index::default();
        index.extend([user(1), entry(2, Role::Assistant, vec![thought()])]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let request = [(key("m2", "r"), Shape::Requested)];
        let (ops, covered) = drop_ops(&context(&index, &edited, &none), &request);
        assert!(ops.is_empty(), "{ops:?}");
        assert!(covered.is_empty(), "the drop must wait, not be forgotten");

        index.extend([user(3)]);
        let (ops, covered) = drop_ops(&context(&index, &edited, &none), &request);
        assert_eq!(
            ops,
            [EditOp::Drop {
                mid: "m2".into(),
                part: Some("r".into())
            }]
        );
        assert_eq!(covered, [key("m2", "r")]);
    }

    #[test]
    fn empty_entries_after_the_last_call_keep_it_a_call() {
        // A large input, so the call isn't kept as a small recent one either.
        let mut call = read(2, 4_000);
        if let PartBody::Tool(tool) = &mut call.body {
            tool.input = json!({"path": "b.rs", "pattern": "x".repeat(2_000)});
        }
        let mut index = Index::default();
        index.extend([
            entry(1, Role::Assistant, vec![call]),
            entry(2, Role::Assistant, vec![]),
            entry(3, Role::Assistant, vec![]),
        ]);
        assert_eq!(index.entries().len(), 3, "the empty entries are held");
        let edited = Edited::default();
        let none = BTreeMap::new();
        let context = context(&index, &edited, &none);
        for shape in [Shape::Default, Shape::Whole] {
            let (ops, _) = drop_ops(&context, &[(key("m1", "p2"), shape)]);
            assert!(
                !ops.contains(&EditOp::Drop {
                    mid: "m1".into(),
                    part: Some("p2".into())
                }),
                "{shape:?} dropped the call that ends the request"
            );
            assert!(
                ops.iter()
                    .any(|op| matches!(op, EditOp::Replace { field, .. } if field == "output")),
                "{shape:?} should replace the call's output instead"
            );
        }
    }

    /// Values the contract may add later are carried unchanged (compaction contract W1.5): a tool
    /// call whose status ck-mc doesn't know counts as running, and no lane
    /// edits a part of a kind, or in an entry of a role, it doesn't know.
    #[test]
    fn parts_ck_mc_does_not_know_are_never_edited() {
        let mut queued = read(2, 4_000);
        if let PartBody::Tool(tool) = &mut queued.body {
            tool.status = ToolStatus::Unknown("queued".into());
        }
        let hologram = part(
            "p3",
            None,
            Seal::None,
            PartBody::Unknown {
                name: "hologram".into(),
                fields: serde_json::Map::new(),
            },
        );
        let developer_text = part(
            "p4",
            Some(4),
            Seal::None,
            PartBody::Text {
                text: "Use tabs.".into(),
            },
        );
        let mut index = Index::default();
        index.extend([
            entry(
                1,
                Role::User,
                vec![part(
                    "p1",
                    Some(1),
                    Seal::None,
                    PartBody::Text { text: "Go.".into() },
                )],
            ),
            entry(2, Role::Assistant, vec![queued, hologram]),
            entry(3, Role::Unknown("developer".into()), vec![developer_text]),
            entry(
                4,
                Role::User,
                vec![part(
                    "p5",
                    Some(5),
                    Seal::None,
                    PartBody::Text {
                        text: "Next.".into(),
                    },
                )],
            ),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let context = context(&index, &edited, &none);
        let (ops, covered) = drop_ops(
            &context,
            &[
                (key("m2", "p2"), Shape::Default),
                (key("m2", "p3"), Shape::Default),
                (key("m3", "p4"), Shape::Default),
            ],
        );
        assert!(ops.is_empty() && covered.is_empty(), "{ops:?}");
    }

    #[test]
    fn a_running_tool_call_is_not_dropped_and_its_drop_waits() {
        let mut running = read(2, 4_000);
        if let PartBody::Tool(tool) = &mut running.body {
            tool.status = ToolStatus::Running;
            tool.output_bytes = None;
        }
        let mut index = Index::default();
        index.extend([
            entry(1, Role::User, vec![]),
            entry(2, Role::Assistant, vec![running]),
        ]);
        let edited = Edited::default();
        let none = BTreeMap::new();
        let (ops, covered) = drop_ops(
            &context(&index, &edited, &none),
            &[(key("m2", "p2"), Shape::Default)],
        );
        // Not covered, so a queued drop of it stays queued.
        assert!(ops.is_empty() && covered.is_empty(), "{ops:?}");
    }

    #[test]
    fn a_part_two_lanes_want_keeps_the_first_lanes_shape() {
        // The call `m3/p4` (numbered 4) is recent, has a small input and is
        // not at the end: a default drop keeps the call with a placeholder
        // result, a whole drop removes it.
        let index = index();
        let edited = Edited::default();
        let none = BTreeMap::new();
        let context = context(&index, &edited, &none);
        let part = key("m3", "p4");
        let (ops, _) = drop_ops(
            &context,
            &[(part.clone(), Shape::Default), (part.clone(), Shape::Whole)],
        );
        assert!(
            matches!(ops.as_slice(), [EditOp::Replace { field, .. }] if field == "output"),
            "{ops:?}"
        );
        let (ops, _) = drop_ops(
            &context,
            &[(part.clone(), Shape::Whole), (part, Shape::Default)],
        );
        assert!(
            matches!(ops.as_slice(), [EditOp::Drop { part: Some(_), .. }]),
            "{ops:?}"
        );
    }

    #[test]
    fn the_protected_tail_default_follows_the_standalone_table() {
        for (usable, expected) in [
            (100_000, 8_000),
            (200_000, 16_000),
            (372_000, 18_600),
            (872_000, 43_600),
            (1_000_000, 50_000),
            (2_000_000, 64_000),
        ] {
            assert_eq!(default_protected_tokens(usable), expected, "{usable}");
        }
    }

    #[test]
    fn an_edit_marker_keeps_paths_and_the_start_of_long_diffs() {
        let long = "x".repeat(41);
        assert_eq!(
            edit_marker("oldString", &json!(long)).unwrap(),
            format!("{}...[truncated]", "x".repeat(40))
        );
        assert_eq!(edit_marker("oldString", &json!("x".repeat(40))), None);
        assert_eq!(edit_marker("filePath", &json!(long)), None);
        assert_eq!(
            edit_marker("content", &json!(format!("{long}...[truncated]"))),
            None
        );
        // 39 units, then an emoji that is two UTF-16 units: the cut steps back
        // rather than split it.
        let emoji = format!("{}😀tail", "x".repeat(39));
        assert_eq!(
            edit_marker("newString", &json!(emoji)).unwrap(),
            format!("{}...[truncated]", "x".repeat(39))
        );
    }
}
