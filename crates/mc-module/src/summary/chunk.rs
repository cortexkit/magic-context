//! The text the summarizer reads: the runner's messages as numbered lines,
//! in the format the TypeScript plugin's chunk reader produces.
//!
//! A message's number is the runner's ordinal, which counts from 1. Consecutive messages
//! of the same role merge into one line: `[3-5] A: first / second`. An
//! assistant message with no text shows its tool calls instead
//! (`TC: read(src/a.rs)`), and such a line counts as tool-only, a range the
//! summarizer may skip. Reasoning is never shown.
//!
//! Reminders, notices and directives are noise: their numbers stay covered,
//! but their text is left out. The exception is a user's answer to a parked
//! question, which is the user's own decision and becomes a user line.

use std::sync::OnceLock;

use ck_contract_draft::part::PartBody;
use ck_contract_draft::read::{Entry, Role};
use regex::Regex;
use serde_json::Value;

use super::validate::{ChunkLine, HistorianChunk, MessageRange};

const MAX_COMMITS_PER_BLOCK: usize = 5;
const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";

/// What the summarizer is sent, and what its reply is checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// `Messages A-B:` followed by the lines.
    pub input: String,
    pub validation: HistorianChunk,
    pub token_estimate: u64,
    /// Messages past the chunk were left out to stay within the budget.
    pub has_more: bool,
}

struct Block {
    role: char,
    start: u64,
    end: u64,
    parts: Vec<String>,
    lines: Vec<ChunkLine>,
    commit_hashes: Vec<String>,
    tool_only: bool,
}

impl Block {
    fn format(&self) -> String {
        let range = if self.start == self.end {
            format!("[{}]", self.start)
        } else {
            format!("[{}-{}]", self.start, self.end)
        };
        let commits = if self.commit_hashes.is_empty() {
            String::new()
        } else {
            format!(" commits: {}", self.commit_hashes.join(", "))
        };
        format!("{range} {}:{commits} {}", self.role, self.parts.join(" / "))
    }
}

/// Build the chunk from `entries` (in full detail, oldest first), stopping
/// before a line would take the text past `token_budget` tokens. The first
/// line is always taken, so a chunk is never empty while messages remain.
/// Returns `None` when the entries hold nothing to summarize.
pub fn build(entries: &[Entry], token_budget: u64) -> Option<Chunk> {
    let mut lines: Vec<String> = Vec::new();
    let mut covered: Vec<ChunkLine> = Vec::new();
    let mut present = Vec::new();
    let mut tool_only: Vec<MessageRange> = Vec::new();
    let mut pending_noise: Vec<ChunkLine> = Vec::new();
    let mut current: Option<Block> = None;
    let mut total = 0;
    let mut stopped = false;

    // Appends the current block to the chunk; false when it does not fit.
    let flush = |block: Block,
                 lines: &mut Vec<String>,
                 covered: &mut Vec<ChunkLine>,
                 tool_only: &mut Vec<MessageRange>,
                 total: &mut u64|
     -> bool {
        let text = block.format();
        let tokens = mc_tokenizer::estimate_tokens(&text) as u64;
        if *total + tokens > token_budget && *total > 0 {
            return false;
        }
        *total += tokens;
        lines.push(text);
        covered.extend(block.lines);
        if block.tool_only {
            match tool_only.last_mut() {
                Some(last) if last.end + 1 == block.start => last.end = block.end,
                _ => tool_only.push(MessageRange {
                    start: block.start,
                    end: block.end,
                }),
            }
        }
        true
    };

    for entry in entries {
        // Ordinals count from 1, as standalone sessions number messages, so
        // a summary names messages by their ordinal.
        let number = entry.ordinal;
        let line = ChunkLine {
            ordinal: number,
            message_id: entry.mid.clone(),
            anchorable: true,
        };
        let Some((role, parts, commits, narrative)) = render_entry(entry) else {
            pending_noise.push(line);
            present.push(number);
            continue;
        };
        present.push(number);
        if let Some(block) = current.as_mut().filter(|block| block.role == role) {
            block.end = number;
            block.parts.extend(parts);
            block.lines.append(&mut pending_noise);
            block.lines.push(line);
            for hash in commits {
                if block.commit_hashes.len() < MAX_COMMITS_PER_BLOCK
                    && !block.commit_hashes.contains(&hash)
                {
                    block.commit_hashes.push(hash);
                }
            }
            block.tool_only &= !narrative;
            continue;
        }
        if let Some(block) = current.take() {
            if !flush(block, &mut lines, &mut covered, &mut tool_only, &mut total) {
                stopped = true;
                break;
            }
        }
        let mut block_lines = std::mem::take(&mut pending_noise);
        let start = block_lines.first().map_or(number, |first| first.ordinal);
        block_lines.push(line);
        current = Some(Block {
            role,
            start,
            end: number,
            parts,
            lines: block_lines,
            commit_hashes: commits,
            tool_only: !narrative,
        });
    }
    if let Some(block) = current.take() {
        if !flush(block, &mut lines, &mut covered, &mut tool_only, &mut total) {
            stopped = true;
        }
    }
    // Trailing noise is covered once a line before it was taken: it holds
    // nothing to summarize, and leaving it out would make the next chunk
    // start on it.
    if !stopped && !covered.is_empty() {
        covered.append(&mut pending_noise);
    }
    let first = covered.first()?;
    let last = covered.last()?;
    let (start, end) = (first.ordinal, last.ordinal);
    present.retain(|number| *number <= end);
    let text = lines.join("\n");
    Some(Chunk {
        input: format!("Messages {start}-{end}:\n\n{text}"),
        validation: HistorianChunk {
            start_index: start,
            end_index: end,
            lines: covered,
            present_ordinals: present,
            tool_only_ranges: tool_only,
            completed_tool_arcs: Vec::new(),
        },
        token_estimate: total,
        has_more: stopped,
    })
}

/// One message's role letter, line parts, commit hashes and whether it
/// carries narrative (text rather than only tool calls). `None` for noise.
fn render_entry(entry: &Entry) -> Option<(char, Vec<String>, Vec<String>, bool)> {
    let raw_texts: Vec<&str> = entry
        .parts
        .iter()
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    match entry.role {
        Role::User => {
            // A notice's own text is never the user's words, but an answer
            // notice carries the user's decision.
            let mut parts: Vec<String> = if entry.notice.is_some() {
                Vec::new()
            } else {
                raw_texts
                    .iter()
                    .map(|text| normalize(&clean_user_text(text)))
                    .filter(|text| !text.is_empty() && !text.starts_with(SYSTEM_DIRECTIVE_PREFIX))
                    .collect()
            };
            parts.extend(raw_texts.iter().flat_map(|text| ask_answer_lines(text)));
            (!parts.is_empty()).then(|| ('U', parts, Vec::new(), true))
        }
        Role::Assistant => {
            let texts: Vec<String> = raw_texts
                .iter()
                .map(|text| normalize(text))
                .filter(|text| !text.is_empty())
                .collect();
            if texts.is_empty() {
                let calls: Vec<String> = entry
                    .parts
                    .iter()
                    .filter_map(|part| match &part.body {
                        PartBody::Tool(tool) => Some(tool_summary(&tool.name, &tool.input)),
                        _ => None,
                    })
                    .collect();
                return (!calls.is_empty())
                    .then(|| ('A', vec![calls.join(" / ")], Vec::new(), false));
            }
            let (text, commits) = compact_text_for_summary(&texts.join(" / "));
            Some(('A', vec![text], commits, true))
        }
        // A turn-scoped system entry carries module text, never the user's or
        // the model's words, so the summarizer leaves it out.
        Role::System => None,
    }
}

/// `TC: <description>` when the call states one, else `TC: name(key arg)`.
fn tool_summary(name: &str, input: &Value) -> String {
    if let Some(description) = input
        .get("description")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        return format!("TC: {description}");
    }
    let key = ["filePath", "path", "pattern", "query"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str).map(truncate_arg))
        .or_else(|| {
            ["symbol", "module", "action"]
                .iter()
                .find_map(|key| input.get(*key).and_then(Value::as_str).map(str::to_owned))
        });
    match key {
        Some(key) => format!("TC: {name}({key})"),
        None => format!("TC: {name}"),
    }
}

/// At most 60 UTF-16 code units, then an ellipsis.
fn truncate_arg(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= 60 {
        return value.to_owned();
    }
    format!("{}…", crate::js_text::string_from_utf16_prefix(&units, 60))
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Strip reminder blocks and the OMO marker from a user's text.
fn clean_user_text(text: &str) -> String {
    system_reminder_regex()
        .replace_all(text, "")
        .replace(OMO_INTERNAL_INITIATOR_MARKER, "")
        .trim()
        .to_owned()
}

/// One `U (answered "<question>"): <answer>` line per answered parked
/// question in `text`, in order. The notice is matched exactly; anything
/// else stays out, so a changed template can cost the summarizer an answer
/// but never feed it reminder text.
fn ask_answer_lines(text: &str) -> Vec<String> {
    envelope_regex()
        .captures_iter(text)
        .filter_map(|capture| parse_ask_answer(capture.get(1).map_or("", |body| body.as_str())))
        .map(|(question, answer)| format!("U (answered \"{question}\"): {answer}"))
        .collect()
}

fn parse_ask_answer(body: &str) -> Option<(String, String)> {
    let body = body.replace("\r\n", "\n");
    let lines: Vec<&str> = body.split('\n').collect();
    let start = lines.iter().position(|line| !line.is_empty())?;
    let end = lines.iter().rposition(|line| !line.is_empty())?;
    let body = lines[start..=end].join("\n");
    if !answer_header_regex().is_match(&body) || body.contains("The user dismissed this question") {
        return None;
    }
    let framed = answer_trailer_regex().captures(&body)?;
    let content = framed.get(1).map_or("", |value| value.as_str());
    let (question, answer) = content
        .strip_prefix("The user answered your parked question ")
        .and_then(|rest| rest.split_once('.'))
        .and_then(|(ask_id, rest)| {
            (!ask_id.is_empty() && !ask_id.contains(' '))
                .then(|| rest.strip_prefix("\nQuestion: "))
                .flatten()
        })
        .or_else(|| content.strip_prefix("Question: "))
        .and_then(|rest| rest.split_once("\nAnswer: "))?;
    if question.trim().is_empty() || answer.trim().is_empty() {
        return None;
    }
    Some((question.to_owned(), answer.to_owned()))
}

/// Pull commit hashes out of assistant text. When the text talks about
/// committing, merging or rebasing, the hashes move to the line's `commits:`
/// list and leave the text.
fn compact_text_for_summary(text: &str) -> (String, Vec<String>) {
    let mut hashes = Vec::new();
    for capture in commit_hash_regex().captures_iter(text) {
        let Some(hash) = capture.get(1).map(|value| value.as_str().to_lowercase()) else {
            continue;
        };
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
        if hashes.len() >= MAX_COMMITS_PER_BLOCK {
            break;
        }
    }
    if hashes.is_empty() || !commit_verb_regex().is_match(text) {
        return (text.to_owned(), hashes);
    }
    let mut stripped = commit_hash_regex().replace_all(text, "").into_owned();
    for (pattern, replacement) in [
        (r"\(\s*\)", ""),
        (r"\s+,", ","),
        (r",\s*,+", ", "),
        (r"\s{2,}", " "),
        (r"\s+([,.;:])", "$1"),
    ] {
        stripped = Regex::new(pattern)
            .unwrap()
            .replace_all(&stripped, replacement)
            .into_owned();
    }
    let stripped = stripped.trim();
    let text = if stripped.is_empty() {
        text.to_owned()
    } else {
        stripped.to_owned()
    };
    (text, hashes)
}

fn system_reminder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<system-reminder>[\s\S]*?</system-reminder>").unwrap())
}

fn envelope_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<system-reminder>([\s\S]*?)</system-reminder>").unwrap())
}

fn answer_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^Inbox [^\n]* notice from user via user_answer \(user_answer\)").unwrap()
    })
}

fn answer_trailer_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\n([\s\S]*?)\nThis ask is now closed; no dismiss is needed\. Continue accordingly\.$",
        )
        .unwrap()
    })
}

/// ASCII word boundaries and case folding, as JavaScript's `\b` and `/i`
/// without the `u` flag in the TypeScript twin.
fn commit_hash_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)`?\b([0-9a-f]{7,12})\b`?").unwrap())
}

fn commit_verb_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i-u)\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b")
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ck_contract_draft::part::{OutputFormat, Part, Seal, ToolPart, ToolStatus};
    use ck_contract_draft::read::{entry_digest, NoticeOrigin};
    use serde_json::json;

    fn entry(ordinal: u64, role: Role, notice: bool, parts: Vec<PartBody>) -> Entry {
        let parts: Vec<Part> = parts
            .into_iter()
            .enumerate()
            .map(|(index, body)| Part::new(format!("p{ordinal}.{index}"), None, Seal::None, body))
            .collect();
        let notice = notice.then(|| NoticeOrigin {
            sender: "prefrontal".into(),
            template: None,
        });
        Entry {
            ordinal,
            mid: format!("m{ordinal}"),
            role,
            digest: entry_digest(role, notice.as_ref(), &parts),
            notice,
            written_at: 0,
            parts,
            usage: None,
            generated_under: None,
        }
    }

    fn text(text: &str) -> PartBody {
        PartBody::Text { text: text.into() }
    }

    fn tool(name: &str, input: Value) -> PartBody {
        PartBody::Tool(ToolPart {
            call_id: "c".into(),
            name: name.into(),
            input,
            provider_executed: false,
            status: ToolStatus::Completed,
            output: Some("done".into()),
            output_format: OutputFormat::Text,
            output_bytes: Some(4),
            attachments: Vec::new(),
            approval: None,
            delivered: Vec::new(),
        })
    }

    #[test]
    fn lines_merge_by_role_and_tool_only_messages_show_their_calls() {
        let answer = "<system-reminder>\nInbox 12:00 notice from user via user_answer (user_answer)\nThe user answered your parked question ask_1.\nQuestion: Ship it?\nAnswer: Yes\nThis ask is now closed; no dismiss is needed. Continue accordingly.\n</system-reminder>";
        let entries = vec![
            entry(1, Role::User, false, vec![text("Fix  the\nbug.")]),
            entry(
                2,
                Role::Assistant,
                false,
                vec![tool("read", json!({"filePath": "src/a.rs"}))],
            ),
            entry(
                3,
                Role::Assistant,
                false,
                vec![tool(
                    "bash",
                    json!({"command": "make", "description": "Build it"}),
                )],
            ),
            entry(
                4,
                Role::User,
                true,
                vec![text(
                    "<system-reminder>Context is 70% full.</system-reminder>",
                )],
            ),
            entry(
                5,
                Role::Assistant,
                false,
                vec![text("Committed abc1234 with the fix.")],
            ),
            entry(6, Role::User, true, vec![text(answer)]),
        ];
        let chunk = build(&entries, 10_000).unwrap();
        assert_eq!(
            chunk.input,
            "Messages 1-6:\n\n[1] U: Fix the bug.\n[2-5] A: commits: abc1234 TC: read(src/a.rs) / TC: Build it / Committed with the fix.\n[6] U: U (answered \"Ship it?\"): Yes"
        );
        let validation = &chunk.validation;
        assert_eq!((validation.start_index, validation.end_index), (1, 6));
        assert_eq!(validation.present_ordinals, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(
            validation
                .lines
                .iter()
                .map(|line| line.ordinal)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        // The reminder at 4 rides with the assistant line; the line has text,
        // so it is not tool-only.
        assert!(validation.tool_only_ranges.is_empty());
        assert!(!chunk.has_more);
    }

    #[test]
    fn a_line_past_the_budget_ends_the_chunk() {
        let entries = vec![
            entry(1, Role::User, false, vec![text("First.")]),
            entry(2, Role::Assistant, false, vec![text(&"word ".repeat(400))]),
        ];
        let chunk = build(&entries, 50).unwrap();
        assert_eq!(chunk.validation.end_index, 1);
        assert!(chunk.has_more);
        assert_eq!(chunk.validation.present_ordinals, vec![1]);
    }

    #[test]
    fn only_noise_builds_no_chunk() {
        let entries = vec![entry(
            1,
            Role::User,
            true,
            vec![text("<system-reminder>x</system-reminder>")],
        )];
        assert_eq!(build(&entries, 1_000), None);
    }
}
