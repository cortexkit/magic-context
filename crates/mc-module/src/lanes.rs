//! Lanes: the kinds of reduction a view can carry. Each lane looks at the
//! index and returns the edits it wants; a pass with permission to rebuild
//! collects every lane's edits into one view.

use std::collections::BTreeSet;

use ck_contract_draft::part::{PartBody, ToolStatus};
use ck_contract_draft::view::EditOp;
use serde_json::{json, Value};

use crate::index::Index;

/// Among the newest this many tool calls, a dropped call with a small input
/// keeps its real arguments and only its result is replaced. Older calls are
/// removed whole. Models copy any synthetic argument they see into new calls,
/// so a call's arguments are either real or absent, never a stand-in.
pub const RECENT_TOOL_WINDOW: usize = 20;

/// The largest input, in UTF-8 bytes of its string values, that a recent
/// dropped call keeps.
pub const SMALL_INPUT_MAX_BYTES: u64 = 1024;

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

/// The edits for the parts the model asked to drop (`ctx_reduce`), and which
/// queued parts those edits cover. A part not in the index any more is left
/// out of both; a tool call still running stays queued.
pub fn queued_drops(
    index: &Index,
    queued: &BTreeSet<(String, String)>,
) -> (Vec<EditOp>, Vec<(String, String)>) {
    let recent: BTreeSet<u64> = index
        .newest_tool_tags(RECENT_TOOL_WINDOW)
        .into_iter()
        .collect();
    let newest_mid = index.entries().last().map(|entry| entry.mid.as_str());
    let mut ops = Vec::new();
    let mut covered = Vec::new();
    for (mid, part_id) in queued {
        let Some((entry, part)) = index.find(mid, part_id) else {
            continue;
        };
        let Some(tag) = part.tag else {
            continue;
        };
        let replace = |field: &str, value: Value| EditOp::Replace {
            mid: mid.clone(),
            part: part_id.clone(),
            field: field.into(),
            value,
            expect: part.digest.clone(),
        };
        match &part.body {
            PartBody::Text { .. } => ops.push(replace("text", json!(placeholder(tag)))),
            PartBody::Tool(tool) if tool.status == ToolStatus::Running => continue,
            PartBody::Tool(tool) => {
                let input = Value::Object(tool.input.clone());
                // A call whose result ends the transcript must stay a call:
                // the request would otherwise end on the call's message
                // without its result.
                let keep_call = Some(entry.mid.as_str()) == newest_mid
                    || (recent.contains(&tag)
                        && input_string_bytes(&input) <= SMALL_INPUT_MAX_BYTES);
                if keep_call {
                    ops.push(replace("output", json!(placeholder(tag))));
                    if !tool.attachments.is_empty() {
                        ops.push(replace("attachments", json!([])));
                    }
                } else {
                    ops.push(EditOp::Drop {
                        mid: mid.clone(),
                        part: Some(part_id.clone()),
                    });
                }
            }
            PartBody::Reasoning { .. } | PartBody::Image(_) | PartBody::File(_) => continue,
        }
        covered.push((mid.clone(), part_id.clone()));
    }
    (ops, covered)
}
