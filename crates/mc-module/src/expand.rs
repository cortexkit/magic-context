//! `ctx_expand`: show again what the model no longer sees, read from the
//! runner in full. The argument rules, budget and output are the TypeScript
//! tool's (`packages/plugin/src/tools/ctx-expand`), so an agent reads the
//! same in both.
//!
//! A message number is the runner's ordinal, which counts from 1 like the
//! numbering summary headings and `ctx_search` hits use. A tag number names
//! one part of a message: a text block, a reasoning block, or a tool call
//! with its result.

use std::sync::OnceLock;

use cortexkit_role_compaction::part::{AttachmentItem, PartBody};
use cortexkit_role_compaction::read::{Entry, Role, SessionRef};
use regex::Regex;
use serde_json::Value;

use crate::client::RunnerClient;
use crate::reads;
use crate::summary::chunk;

/// The most a range answer shows, in tokens.
pub const TOKEN_BUDGET: u64 = 15_000;

const TAG_INPUT_ERROR: &str = "Error: tag must be one positive integer: 12, \"12\", \"§12§\", \"§12\", \"tag 12\", or \"[dropped §12§]\" (surrounding whitespace is allowed).";

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Tag(u64),
    Message(u64),
    Range { start: u64, end: u64, verbose: bool },
}

fn integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.fract() == 0.0)
            .map(|f| f as i64)
    })
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

/// `12`, `"12"`, `"§12§"`, `"§12"`, `"tag 12"` or `"[dropped §12§]"`.
fn parse_tag(value: &Value) -> Result<u64, String> {
    static FORMS: OnceLock<Regex> = OnceLock::new();
    let number = match value {
        Value::Number(_) => integer(Some(value)).filter(|n| *n > 0).map(|n| n as u64),
        Value::String(text) => FORMS
            .get_or_init(|| {
                Regex::new(r"^(?:([0-9]+)|§([0-9]+)§?|tag\s+([0-9]+)|\[dropped\s+§([0-9]+)§\])$")
                    .expect("tag forms")
            })
            .captures(text.trim())
            .and_then(|captures| {
                captures
                    .iter()
                    .skip(1)
                    .flatten()
                    .next()
                    .map(|m| m.as_str().to_owned())
            })
            .and_then(|digits| digits.parse::<u64>().ok())
            .filter(|n| *n > 0),
        _ => None,
    };
    number.ok_or_else(|| TAG_INPUT_ERROR.to_owned())
}

/// Which of the three forms a call asks for. Tools whose schema makes every
/// field required fill the unused ones with `0` or `false`; those fillers
/// never decide the form.
pub fn mode(input: &Value) -> Result<Mode, String> {
    let tag = input.get("tag");
    let is_filler_tag = matches!(tag, Some(Value::Number(n)) if n.as_i64() == Some(0))
        || matches!(tag, Some(Value::String(s)) if s.is_empty());
    let message_field = input.get("message");
    let start_field = input.get("start");
    if present(tag) && !(is_filler_tag && (message_field.is_some() || start_field.is_some())) {
        let tag = parse_tag(tag.expect("present"))?;
        let others = [message_field, start_field, input.get("end")];
        if others
            .iter()
            .any(|value| present(*value) && integer(*value) != Some(0))
        {
            return Err("Error: use tag alone, without message or start/end.".into());
        }
        return Ok(Mode::Tag(tag));
    }
    let message = integer(message_field);
    let start = integer(start_field);
    let end = integer(input.get("end"));
    let message_valid = message.is_some_and(|m| m >= 1);
    let range_valid = matches!((start, end), (Some(s), Some(e)) if s >= 1 && e >= s);
    let range_named = range_valid && !(start == Some(0) && end == Some(0));
    if message_valid && !range_named {
        return Ok(Mode::Message(message.expect("valid") as u64));
    }
    if present(message_field) && !message_valid && !range_named {
        return Err("Error: message must be a positive integer.".into());
    }
    if let (true, Some(start), Some(end)) = (range_valid, start, end) {
        return Ok(Mode::Range {
            start: start as u64,
            end: end as u64,
            verbose: input.get("verbose").and_then(Value::as_bool) == Some(true),
        });
    }
    Err("Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).".into())
}

fn role_label(entry: &Entry) -> String {
    if let Some(agent) = &entry.speaks_for {
        return format!(
            "R (agent: {})",
            agent.name.as_deref().unwrap_or(&agent.agent_id)
        );
    }
    match entry.role {
        Role::Assistant => "A (assistant)",
        Role::User => "U (user)",
        Role::System => "S (system)",
        _ => "? (other)",
    }
    .to_owned()
}

fn truncate(value: &str, max: usize) -> String {
    let text = value.trim();
    match text.char_indices().nth(max) {
        None => text.to_owned(),
        Some((cut, _)) => format!("{}…", &text[..cut]),
    }
}

/// The one argument that best says what a tool call was about.
fn key_arg(input: &Value) -> String {
    for key in [
        "filePath",
        "path",
        "pattern",
        "query",
        "symbol",
        "module",
        "action",
        "description",
    ] {
        if let Some(Value::String(value)) = input.get(key) {
            if !value.is_empty() {
                return truncate(value, 60);
            }
        }
    }
    String::new()
}

fn attachments_line(names: Vec<String>) -> Option<String> {
    (!names.is_empty()).then(|| {
        format!(
            "  attachments (not kept; ask the user to attach them again if needed): {}",
            names.join(", ")
        )
    })
}

/// One part in full. Reasoning is never shown.
fn render_part_full(body: &PartBody) -> Option<String> {
    match body {
        PartBody::Text { text } => (!text.trim().is_empty()).then(|| format!("  [text]\n{text}")),
        PartBody::Tool(tool) => {
            let mut lines = vec![format!("  [tool: {} #{}]", tool.name, tool.call_id)];
            if let Some(Value::String(title)) = tool.input.get("description") {
                if !title.trim().is_empty() {
                    lines.push(format!("  description: {}", title.trim()));
                }
            }
            lines.push(format!("  input: {}", tool.input.as_str()));
            match (&tool.output, crate::neutral::is_finished(&tool.status)) {
                (Some(output), _) => lines.push(format!("  output:\n{output}")),
                (None, false) => lines.push("  output: (still running)".into()),
                (None, true) => {}
            }
            lines.extend(attachments_line(
                tool.attachments()
                    .iter()
                    .map(|attachment| match &attachment.item {
                        AttachmentItem::File(file) => {
                            file.name.clone().unwrap_or_else(|| file.mime.clone())
                        }
                        AttachmentItem::Opaque(opaque) => opaque.provider_kind.clone(),
                        _ => "attachment".to_owned(),
                    })
                    .collect(),
            ));
            Some(lines.join("\n"))
        }
        PartBody::File(file) => Some(format!(
            "  [{}] {} (not kept; ask the user to attach it again if needed)",
            if file.is_image() { "image" } else { "file" },
            file.name.clone().unwrap_or_else(|| file.mime.clone())
        )),
        // Neither is text anyone wrote: reasoning is never shown, and a
        // provider's own item has no text to show.
        PartBody::Reasoning { .. } | PartBody::Opaque(_) => None,
        // Kinds the contract may add later are not shown.
        _ => None,
    }
}

/// One preview line per part, for the verbose range form.
fn render_part_preview(body: &PartBody, counter: crate::count::Counter) -> Option<String> {
    match body {
        PartBody::Text { text } => {
            let text = truncate(text, 200);
            (!text.is_empty()).then(|| format!("    • {text}"))
        }
        PartBody::Tool(tool) => {
            let arg = key_arg(&tool.input.parse());
            let head = if arg.is_empty() {
                tool.name.clone()
            } else {
                format!("{}({arg})", tool.name)
            };
            Some(match &tool.output {
                Some(output) => {
                    format!("    • tool {head} → output ~{} tok", counter.count(output))
                }
                None => format!("    • tool {head}"),
            })
        }
        PartBody::Reasoning { .. } => Some("    • [reasoning]".into()),
        PartBody::File(file) if file.is_image() => Some("    • [image]".into()),
        PartBody::File(_) => Some("    • [file]".into()),
        PartBody::Opaque(opaque) => Some(format!("    • [{}]", opaque.provider_kind)),
        // Kinds the contract may add later are not shown.
        _ => None,
    }
}

fn verbose_label(entry: &Entry) -> String {
    let only_results = entry.role == Role::User
        && !entry.parts.is_empty()
        && entry
            .parts
            .iter()
            .all(|part| matches!(&part.body, PartBody::Tool(tool) if tool.output.is_some()));
    if only_results {
        "tool results".into()
    } else {
        role_label(entry)
    }
}

/// Run a call. `last_summarized` is the number of the last message the
/// session's summaries cover: messages after it are still in view, so a
/// range never shows them again.
pub async fn run<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    limits: reads::Limits,
    input: &Value,
    last_summarized: Option<u64>,
    counter: crate::count::Counter,
) -> Result<String, String> {
    match mode(input)? {
        Mode::Tag(tag) => by_tag(client, session, limits, tag).await,
        Mode::Message(number) => by_message(client, session, limits, number).await,
        Mode::Range {
            start,
            end,
            verbose,
        } => {
            if let Some(last) = last_summarized {
                if start > last {
                    return Ok(format!(
                        "Range {start}-{end} is entirely within the live tail (after the last compacted message {last}); those messages are already visible in context."
                    ));
                }
            }
            let end_clamped = last_summarized.map_or(end, |last| end.min(last));
            if verbose {
                verbose_range(client, session, limits, start, end_clamped, counter).await
            } else {
                range(client, session, limits, start, end, end_clamped, counter).await
            }
        }
    }
}

async fn by_tag<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    limits: reads::Limits,
    tag: u64,
) -> Result<String, String> {
    let entries = reads::by_tags(client, session, vec![tag], limits).await?;
    let part = entries
        .iter()
        .flat_map(|entry| &entry.parts)
        .find(|part| part.tag == Some(tag));
    Ok(match part {
        None => format!(
            "no tag {tag} in this session; if {tag} came from a <session-history> heading or a ctx_search hit, it is an ordinal: use message={tag}"
        ),
        Some(part) => render_part_full(&part.body).unwrap_or_default(),
    })
}

async fn by_message<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    limits: reads::Limits,
    number: u64,
) -> Result<String, String> {
    // Ordinals count from 1, so a message's number is its ordinal.
    let entries = reads::full_range(client, session, number, number + 1, limits, |_| true).await?;
    let Some(entry) = entries.into_iter().find(|entry| entry.ordinal == number) else {
        return Ok(format!(
            "No message at ordinal {number} in this session's stored history — it was deleted (session prune/revert) or the ordinal is wrong, so it can't be recovered. Re-run the tool if you still need the data."
        ));
    };
    let rendered: Vec<String> = entry
        .parts
        .iter()
        .filter_map(|part| render_part_full(&part.body))
        .collect();
    let mut lines = vec![
        format!("[{number}] {} — full recovery:", role_label(&entry)),
        String::new(),
    ];
    if rendered.is_empty() {
        lines.push(
            "  (no recoverable content — message had only structural/reasoning parts)".into(),
        );
    } else {
        lines.extend(rendered);
    }
    Ok(lines.join("\n"))
}

async fn range<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    limits: reads::Limits,
    start: u64,
    asked_end: u64,
    end: u64,
    counter: crate::count::Counter,
) -> Result<String, String> {
    // The chunk stops at the budget; the read stops once it has read more
    // text than the budget could show.
    let byte_cap = TOKEN_BUDGET * 8;
    let entries = reads::full_range(client, session, start, end + 1, limits, |read| {
        read.iter().map(entry_bytes).sum::<u64>() > byte_cap
    })
    .await?;
    let Some(mut chunk) = chunk::build(&entries, TOKEN_BUDGET, counter) else {
        return Ok(format!(
            "No messages found in range {start}-{asked_end}. The range may be outside this session's history."
        ));
    };
    // Token counts do not bound UTF-8 bytes. Keep whole messages under the
    // wire budget, reserving space for the heading and continuation notice.
    let body_budget = cortexkit_role_tool_provider::result::MAX_MODEL_VISIBLE_BYTES - 512;
    if crate::tool_output::bytes(&chunk.input) > body_budget {
        let mut low = entries
            .iter()
            .position(|entry| {
                chunk::build(std::slice::from_ref(entry), TOKEN_BUDGET, counter).is_some()
            })
            .unwrap_or(0)
            + 1;
        let mut high = entries.len();
        while low < high {
            let mid = low + (high - low).div_ceil(2);
            if chunk::build(&entries[..mid], TOKEN_BUDGET, counter)
                .is_some_and(|candidate| crate::tool_output::bytes(&candidate.input) <= body_budget)
            {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        chunk = chunk::build(&entries[..low], TOKEN_BUDGET, counter).expect("recoverable prefix");
    }
    let shown_end = chunk.validation.end_index;
    let lines = chunk.input.split_once('\n').map_or("", |(_, rest)| rest);
    let mut out = vec![
        format!(
            "Messages {}-{shown_end} ({} messages, ~{} tokens):",
            chunk.validation.start_index,
            shown_end - chunk.validation.start_index + 1,
            chunk.token_estimate
        ),
        String::new(),
        crate::tool_output::within(lines.to_owned(), body_budget),
    ];
    if shown_end < end {
        out.push(String::new());
        out.push(format!(
            "Truncated at message {shown_end} (budget: ~{TOKEN_BUDGET} tokens or 65,536 bytes). Call again with start={} end={end} for more.",
            shown_end + 1
        ));
    }
    Ok(out.join("\n"))
}

async fn verbose_range<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    limits: reads::Limits,
    start: u64,
    end: u64,
    counter: crate::count::Counter,
) -> Result<String, String> {
    let byte_cap = TOKEN_BUDGET * 8;
    let entries = reads::full_range(client, session, start, end + 1, limits, |read| {
        read.iter().map(entry_bytes).sum::<u64>() > byte_cap
    })
    .await?;
    let mut blocks = Vec::new();
    let mut used = 0;
    let mut last = start - 1;
    let mut truncated = false;
    let body_budget = cortexkit_role_tool_provider::result::MAX_MODEL_VISIBLE_BYTES - 512;
    let mut bytes = 0;
    for entry in &entries {
        let number = entry.ordinal;
        let header = format!("[{number}] {}", verbose_label(entry));
        let parts: Vec<String> = entry
            .parts
            .iter()
            .filter_map(|part| render_part_preview(&part.body, counter))
            .collect();
        let block = if parts.is_empty() {
            header
        } else {
            format!("{header}\n{}", parts.join("\n"))
        };
        let cost = counter.count(&block);
        if (used + cost > TOKEN_BUDGET
            || bytes + crate::tool_output::bytes(&block) + 2 > body_budget)
            && !blocks.is_empty()
        {
            truncated = true;
            break;
        }
        used += cost;
        last = number;
        let block = crate::tool_output::within(block, body_budget);
        bytes += crate::tool_output::bytes(&block) + 2;
        blocks.push(block);
    }
    if blocks.is_empty() {
        return Ok(format!(
            "No messages found in range {start}-{end}. The range may be outside this session's history."
        ));
    }
    let mut out = vec![
        format!("Messages {start}-{last} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):"),
        String::new(),
        blocks.join("\n\n"),
    ];
    if truncated {
        out.push(String::new());
        out.push(format!(
            "Truncated at message {last} (budget: ~{TOKEN_BUDGET} tokens or 65,536 bytes). Call again with start={} end={end} verbose=true for more.",
            last + 1
        ));
    }
    Ok(out.join("\n"))
}

fn entry_bytes(entry: &Entry) -> u64 {
    entry
        .parts
        .iter()
        .map(|part| match &part.body {
            PartBody::Text { text } => text.len() as u64,
            PartBody::Tool(tool) => {
                tool.output.as_ref().map_or(0, |output| output.len() as u64) + 64
            }
            _ => 16,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    #[test]
    fn speaks_for_expansion_labels_the_agent_instead_of_the_person() {
        let mut entry = cortexkit_role_compaction::read::Entry::new(
            1,
            "relay",
            cortexkit_role_compaction::read::Role::User,
            0,
            vec![],
        );
        entry.speaks_for = Some(
            serde_json::from_value(serde_json::json!({"agent_id":"peer", "name":"Mason"})).unwrap(),
        );
        assert_eq!(super::role_label(&entry), "R (agent: Mason)");
        entry.speaks_for.as_mut().unwrap().name = None;
        assert_eq!(super::role_label(&entry), "R (agent: peer)");
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn the_three_forms_and_their_fillers() {
        assert_eq!(mode(&json!({"tag": "§12§"})), Ok(Mode::Tag(12)));
        assert_eq!(mode(&json!({"tag": "[dropped §7§]"})), Ok(Mode::Tag(7)));
        assert_eq!(mode(&json!({"tag": 0, "message": 5})), Ok(Mode::Message(5)));
        assert_eq!(
            mode(&json!({"message": 5, "start": 0, "end": 0})),
            Ok(Mode::Message(5))
        );
        assert_eq!(
            mode(&json!({"start": 3, "end": 9, "message": 0, "verbose": true})),
            Ok(Mode::Range {
                start: 3,
                end: 9,
                verbose: true
            })
        );
        assert!(mode(&json!({"tag": 12, "message": 3})).is_err());
        assert!(mode(&json!({"tag": "12 13"})).is_err());
        assert!(mode(&json!({"start": 9, "end": 3})).is_err());
        assert!(mode(&json!({"message": -1})).is_err());
    }
}
