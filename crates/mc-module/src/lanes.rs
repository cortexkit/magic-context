//! Lanes: the kinds of reduction a view can carry. Each lane names the parts
//! it wants gone; [`drop_ops`] turns those parts into edits, so every lane
//! drops a part the same way. A pass with permission to rebuild runs every
//! lane and publishes their edits as one view.
//!
//! The rules follow the TypeScript transform, which is the reference for
//! what Magic Context removes and when.

use std::collections::{BTreeMap, BTreeSet};

use ck_contract_draft::part::{Part, PartBody, Sealing, ToolPart, ToolStatus};
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
                }
                | EditOp::Replace { mid, part, .. } => {
                    edited.parts.insert((mid.clone(), part.clone()));
                }
                EditOp::Drop { mid, part: None } => {
                    edited.messages.insert(mid.clone());
                }
                EditOp::Insert { .. } | EditOp::Cut { .. } => {}
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

/// How a lane wants a tool part dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// A recent call with a small input keeps its arguments and only its
    /// result is replaced; any other call goes with its result. Text becomes
    /// the placeholder, reasoning goes.
    Default,
    /// The call goes with its result, however recent. Used where the call
    /// itself is redundant (a duplicate of a newer identical call).
    Whole,
    /// An edit superseded by a newer edit of the same file: the call stays,
    /// with its file path and only the start of each long diff argument, and
    /// its result is replaced.
    EditMarker,
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
    let newest_mid = index.entries().last().map(|entry| entry.mid.as_str());
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
                let small_recent =
                    recent.contains(&tag) && input_string_bytes(&input) <= SMALL_INPUT_MAX_BYTES;
                // A call whose result ends the transcript stays a call: the
                // request would otherwise end on the call's message without
                // its result.
                let ends_transcript = Some(entry.mid.as_str()) == newest_mid;
                let keep_call = match shape {
                    Shape::Default => ends_transcript || small_recent,
                    Shape::Whole => ends_transcript,
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
                if shape == Shape::EditMarker {
                    for (name, value) in &tool.input {
                        if let Some(marked) = edit_marker(name, value) {
                            ops.push(replace(&format!("input.{name}"), json!(marked)));
                        }
                    }
                }
            }
            PartBody::Image(_) | PartBody::File(_) => continue,
        }
        covered.push(key.clone());
    }
    (ops, covered)
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
pub fn age_sweep(context: &Context, bookmark: u64) -> Vec<(PartKey, Shape)> {
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
            parts.push((key, Shape::Default));
        }
    }
    parts
}

/// Reasoning a step costs when nothing better is known: encrypted or signed
/// reasoning with no reported count and no visible text.
pub const UNKNOWN_REASONING_STEP_TOKENS: u64 = 1_000;

/// What one assistant entry's reasoning costs, counting all of its reasoning.
pub fn step_reasoning_tokens(entry: &Entry) -> u64 {
    let reasoning: Vec<&Part> = entry
        .parts
        .iter()
        .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
        .collect();
    if reasoning.is_empty() {
        return 0;
    }
    reasoning_cost(entry, &reasoning)
}

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
pub fn reasoning_over_budget(context: &Context, budget: u64) -> Vec<(PartKey, Shape)> {
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
            (PartBody::Tool(tool), Some(tag)) => {
                Some((tag, tokens::bytes(tool.output_bytes.unwrap_or(0))))
            }
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
        if in_tail(part, cutoff) {
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
    let candidates: Vec<(&Entry, &Part, u8)> = tool_parts(context)
        .filter(|(entry, part, tool)| {
            tool.status != ToolStatus::Running
                && part.tag.is_some()
                && !context.edited.covers(&entry.mid, &part.id)
                && !protected.contains(&(entry.mid.clone(), part.id.clone()))
                && (emergency.over_limit || !in_tail(part, cutoff))
        })
        .map(|(entry, part, tool)| (entry, part, emergency_tier(&tool.name)))
        .collect();
    let mut reserved = BTreeSet::new();
    if !emergency.over_limit {
        for tier in [1, 2] {
            let newest: Vec<u64> = candidates
                .iter()
                .rev()
                .filter(|(_, _, candidate)| *candidate == tier)
                .filter_map(|(_, part, _)| part.tag)
                .collect();
            let keep = (EMERGENCY_TIER_RESERVE * newest.len() as f64).ceil() as usize;
            reserved.extend(newest.into_iter().take(keep));
        }
    }
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
            reclaimed += tokens::part(part);
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
/// the `ctx_keep` call, except the session's first message when it keeps it,
/// the parts the model asked to keep, and the protected tail. The call's
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
        if position == 0 && context.keep_first_message {
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
    use ck_contract_draft::read::entry_digest;

    fn entry(ordinal: u64, role: Role, parts: Vec<Part>) -> Entry {
        Entry {
            ordinal,
            mid: format!("m{ordinal}"),
            role,
            notice: None,
            written_at: 0,
            digest: entry_digest(role, None, &parts),
            parts,
            usage: None,
            generated_under: None,
        }
    }

    fn read(tag: u64, output_bytes: u64) -> Part {
        Part::new(
            format!("p{tag}"),
            Some(tag),
            PartBody::Tool(ToolPart {
                call_id: format!("c{tag}"),
                name: "read".into(),
                input: json!({"path": "b.rs"}).as_object().unwrap().clone(),
                status: ToolStatus::Completed,
                output: None,
                output_bytes: Some(output_bytes),
                attachments: Vec::new(),
            }),
        )
    }

    /// Two identical reads in one message (tags 2 and 3), then reads of
    /// 4,000 bytes (1,000 tokens) at tags 4, 5 and 6.
    fn index() -> Index {
        let text = |tag: u64| {
            Part::new(
                format!("p{tag}"),
                Some(tag),
                PartBody::Text { text: "Go.".into() },
            )
        };
        let mut index = Index::default();
        index.extend([
            entry(0, Role::User, vec![text(1)]),
            entry(1, Role::Assistant, vec![read(2, 40), read(3, 40)]),
            entry(2, Role::Assistant, vec![read(4, 4_000)]),
            entry(3, Role::Assistant, vec![read(5, 4_000)]),
            entry(4, Role::Assistant, vec![read(6, 4_000)]),
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

        let duplicate = vec![(("m1".to_owned(), "p2".to_owned()), Shape::Whole)];
        assert_eq!(duplicate_lookups(&context, Some(4)), duplicate);
        assert_eq!(duplicate_lookups(&context, Some(2)), []);
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
