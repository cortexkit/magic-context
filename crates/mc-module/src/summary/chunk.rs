//! The text the summarizer reads: the runner's messages as numbered lines,
//! in the format the TypeScript plugin's chunk reader produces.
//!
//! A message's number is the runner's ordinal, which counts from 1. Consecutive messages
//! of the same role merge into one line: `[3-5] A: first / second`. An
//! assistant message with no text shows its tool calls instead
//! (`TC: read(src/a.rs)`), and such a line counts as tool-only, a range the
//! summarizer may skip. Reasoning is never shown.
//!
//! A whole `<system-reminder>` message whose body starts with `Inbox:`
//! becomes source-labelled relay lines, never user lines.
//! Other reminders, notices and directives keep their message ordinals but stay hidden, except
//! a user's reply to an explicit ask for a decision, which carries that decision.

mod relayed_wake;

use std::sync::OnceLock;

use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Entry, Role};
use regex::Regex;
use serde_json::Value;

use super::validate::{ChunkLine, HistorianChunk, MessageRange};

pub(super) const MAX_COMMITS_PER_BLOCK: usize = 5;
const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

/// What the summarizer is sent, and what its reply is checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// `Messages A-B:` followed by the lines.
    pub input: String,
    pub validation: HistorianChunk,
    pub token_estimate: u64,
    /// Messages past the chunk were left out to stay within the budget.
    pub has_more: bool,
    /// Stretches of work that ended in commits: an assistant line with
    /// commit hashes that follows a line of another role, or opens the chunk
    /// (`read-session-chunk.ts`, `commitClusters`).
    pub commit_clusters: u64,
    /// Messages the chunk's lines cover, noise included.
    pub messages: usize,
    /// Each printed line, in order: what a fact's anchor may cite.
    pub printed_blocks: Vec<PrintedBlock>,
}

/// One `[N]`/`[N-M]` line of the chunk as the summarizer reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrintedBlock {
    /// `U`, `A`, or `R` for source-labelled relays, never user evidence.
    pub role: String,
    pub start: u64,
    pub end: u64,
    /// The line's message texts, in order.
    pub parts: Vec<String>,
    /// The byte offset in [`Chunk::input`] where the line ends, so a cut of the
    /// input shows which lines the summarizer saw whole.
    pub text_end: usize,
}

/// How messages become lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lines {
    /// Consecutive messages of one role share a line, and assistant text is
    /// compacted: the ordinary summarizer's chunk.
    Merged,
    /// Every message is a line of its own, and its text is kept as written,
    /// commit hashes in place: the two-pass historian's first turn, whose
    /// facts cite lines as evidence (`singleMessageLines` in the plugin's
    /// `read-session-chunk.ts`).
    PerMessage,
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
    fn header(&self) -> String {
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
        format!("{range} {}:{commits} ", self.role)
    }

    fn format(&self) -> String {
        if self.role == 'R' {
            return self
                .parts
                .iter()
                .map(|part| format!("[{}] {part}", self.end))
                .collect::<Vec<_>>()
                .join("\n");
        }
        format!("{}{}", self.header(), self.parts.join(" / "))
    }
}

/// Build the chunk from `entries` (in full detail, oldest first), stopping
/// before a line would take the text past `token_budget` tokens. The first
/// line is always taken, so a chunk is never empty while messages remain.
/// Returns `None` when the entries hold nothing to summarize.
pub fn build(
    entries: &[Entry],
    token_budget: u64,
    counter: crate::count::Counter,
) -> Option<Chunk> {
    build_with(entries, token_budget, Lines::Merged, counter)
}

/// [`build`], with lines formed as `mode` says.
pub fn build_with(
    entries: &[Entry],
    token_budget: u64,
    mode: Lines,
    counter: crate::count::Counter,
) -> Option<Chunk> {
    build_counted(entries, token_budget, mode, |_, text| counter.count(text))
}

/// The trigger revisits held history on notices. For models with an exact
/// tokenizer, message counts are cached by digest, attribution and tokenizer
/// family, so a growing assistant turn never re-tokenizes its old text.
/// Headers and separators are added separately: token merges at
/// message joins may differ slightly, which is sufficient for a trigger decision.
/// Estimated models retain their merged-line counts for compatibility.
#[derive(Clone, Default, Debug)]
pub struct CountCache {
    family: Option<Option<cortexkit_tokens::Family>>,
    counts: std::collections::HashMap<(u64, u64, Vec<String>), u64>,
    entry_counts: std::collections::HashMap<(u64, String), Option<u64>>,
    headers: std::collections::HashMap<String, u64>,
    separator: Option<u64>,
    recent_headers: std::collections::VecDeque<(String, u64)>,
    #[cfg(test)]
    pub misses: usize,
    #[cfg(test)]
    pub header_misses: usize,
}

impl CountCache {
    pub(super) fn set_family(&mut self, counter: crate::count::Counter) {
        if self.family != Some(counter.family()) {
            self.counts.clear();
            self.entry_counts.clear();
            self.headers.clear();
            self.separator = None;
            self.recent_headers.clear();
            self.family = Some(counter.family());
        }
    }
    pub(super) fn separator(&mut self, counter: crate::count::Counter) -> u64 {
        *self.separator.get_or_insert_with(|| counter.count(" / "))
    }
    pub fn build(
        &mut self,
        entries: &[Entry],
        budget: u64,
        counter: crate::count::Counter,
    ) -> Option<Chunk> {
        let _timing = crate::notice_cost_timing::span("trigger.count_cache");
        if self.family != Some(counter.family()) {
            self.counts.clear();
            self.entry_counts.clear();
            self.headers.clear();
            self.separator = None;
            self.family = Some(counter.family());
        }
        // Retain only the current scan's lines, so cuts and changing entries
        // cannot leave an ever-growing cache behind in a long session.
        let mut retained = std::collections::HashMap::new();
        let mut retained_entries = std::collections::HashMap::new();
        let mut retained_headers = std::collections::HashMap::new();
        let separator = counter
            .family()
            .map(|_| *self.separator.get_or_insert_with(|| counter.count(" / ")));
        let chunk = build_counted(entries, budget, Lines::Merged, |block, text| {
            let low = entries.partition_point(|entry| entry.ordinal < block.start);
            let high = entries.partition_point(|entry| entry.ordinal <= block.end);
            if let Some(separator) = separator {
                let mut members = 0u64;
                let header = block.header();
                let mut tokens = self.headers.remove(&header).unwrap_or_else(|| {
                    #[cfg(test)]
                    {
                        self.header_misses += 1;
                    }
                    counter.count(&header)
                });
                retained_headers.insert(header, tokens);
                for entry in &entries[low..high] {
                    let key = (entry.ordinal, count_identity(entry));
                    let count = self.entry_counts.remove(&key).unwrap_or_else(|| {
                        render_entry(entry, false).map(|(_, parts, _, _)| {
                            #[cfg(test)]
                            {
                                self.misses += 1;
                            }
                            counter.count(&parts.join(" / "))
                        })
                    });
                    if let Some(count) = count {
                        tokens += count;
                        members += 1;
                    }
                    retained_entries.insert(key, count);
                }
                return tokens + members.saturating_sub(1) * separator;
            }
            let key = (
                block.start,
                block.end,
                entries[low..high].iter().map(count_identity).collect(),
            );
            let count = self.counts.remove(&key).unwrap_or_else(|| {
                #[cfg(test)]
                {
                    self.misses += 1;
                }
                counter.count(text)
            });
            retained.insert(key, count);
            count
        });
        self.counts = retained;
        self.entry_counts = retained_entries;
        self.headers = retained_headers;
        chunk
    }
}

pub(super) fn count_header(
    role: char,
    start: u64,
    end: u64,
    hashes: &[&str],
    counter: crate::count::Counter,
    counts: &mut CountCache,
) -> u64 {
    let block = Block {
        role,
        start,
        end,
        parts: Vec::new(),
        lines: Vec::new(),
        commit_hashes: hashes.iter().map(|hash| (*hash).to_owned()).collect(),
        tool_only: false,
    };
    let header = block.header();
    if let Some((_, count)) = counts
        .recent_headers
        .iter()
        .find(|(held, _)| held == &header)
    {
        return *count;
    }
    #[cfg(test)]
    {
        counts.header_misses += 1;
    }
    let count = counter.count(&header);
    if counts.recent_headers.len() == 8 {
        counts.recent_headers.pop_front();
    }
    counts.recent_headers.push_back((header, count));
    count
}

/// Speaker and host facts change summary text but are outside the wire digest.
/// Include them in the local token-count cache's identity to avoid stale counts.
fn count_identity(entry: &Entry) -> String {
    let mut identity = entry.digest.to_string();
    if let Some(agent) = &entry.speaks_for {
        identity.push_str(&serde_json::to_string(agent).expect("agent attribution serializes"));
    }
    if !entry.host_parts.is_empty() {
        identity.push_str(&serde_json::to_string(&entry.host_parts).expect("host facts serialize"));
    }
    identity
}

fn build_counted(
    entries: &[Entry],
    token_budget: u64,
    mode: Lines,
    mut count: impl FnMut(&Block, &str) -> u64,
) -> Option<Chunk> {
    let _timing = crate::notice_cost_timing::span("trigger.build_chunk");
    let per_message = mode == Lines::PerMessage;
    let mut lines: Vec<String> = Vec::new();
    let mut printed: Vec<(char, u64, u64, Vec<String>)> = Vec::new();
    let mut covered: Vec<ChunkLine> = Vec::new();
    let mut present = Vec::new();
    let mut tool_only: Vec<MessageRange> = Vec::new();
    let mut pending_noise: Vec<ChunkLine> = Vec::new();
    let mut current: Option<Block> = None;
    let mut total = 0;
    let mut stopped = false;
    let mut clusters = 0;
    let mut last_role: Option<char> = None;

    // Appends the current block to the chunk; false when it does not fit.
    let mut flush = |block: Block,
                     lines: &mut Vec<String>,
                     printed: &mut Vec<(char, u64, u64, Vec<String>)>,
                     covered: &mut Vec<ChunkLine>,
                     tool_only: &mut Vec<MessageRange>,
                     total: &mut u64,
                     clusters: &mut u64,
                     last_role: &mut Option<char>|
     -> bool {
        let text = block.format();
        let tokens = count(&block, &text);
        if *total + tokens > token_budget && *total > 0 {
            return false;
        }
        *total += tokens;
        if block.role == 'A' && !block.commit_hashes.is_empty() && *last_role != Some('A') {
            *clusters += 1;
        }
        *last_role = Some(block.role);
        lines.push(text);
        printed.push((block.role, block.start, block.end, block.parts.clone()));
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
        let Some((role, mut parts, commits, narrative)) = render_entry(entry, per_message) else {
            present.push(number);
            match current.as_mut().filter(|_| per_message) {
                // A line of its own keeps the hidden messages after it in
                // its range, as the plugin's reader does.
                Some(block) => {
                    block.end = number;
                    block.lines.push(line);
                }
                None => pending_noise.push(line),
            }
            continue;
        };
        present.push(number);
        if per_message && role != 'R' {
            // A message's text is one part, so evidence may quote across its
            // text parts as it reads on the line.
            parts = vec![parts.join(" / ")];
        }
        if let Some(block) = current
            .as_mut()
            .filter(|block| !per_message && role != 'R' && block.role == role)
        {
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
            if !flush(
                block,
                &mut lines,
                &mut printed,
                &mut covered,
                &mut tool_only,
                &mut total,
                &mut clusters,
                &mut last_role,
            ) {
                stopped = true;
                break;
            }
        }
        let mut block_lines = std::mem::take(&mut pending_noise);
        let start = if role == 'R' {
            number
        } else {
            block_lines.first().map_or(number, |first| first.ordinal)
        };
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
        // A relay's labels all name this message, not adjacent hidden ordinals.
        if role == 'R'
            && !flush(
                current.take().expect("just opened relay block"),
                &mut lines,
                &mut printed,
                &mut covered,
                &mut tool_only,
                &mut total,
                &mut clusters,
                &mut last_role,
            )
        {
            stopped = true;
            break;
        }
    }
    if let Some(block) = current.take() {
        if !flush(
            block,
            &mut lines,
            &mut printed,
            &mut covered,
            &mut tool_only,
            &mut total,
            &mut clusters,
            &mut last_role,
        ) {
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
    // Coverage keeps every ordinal, but host bookkeeping is not a conversation
    // message for the proactive summary threshold.
    let messages = covered.len()
        - entries
            .iter()
            .filter(|entry| {
                entry.ordinal >= start
                    && entry.ordinal <= end
                    && crate::neutral::is_host_only(entry)
            })
            .count();
    present.retain(|number| *number <= end);
    let text = lines.join("\n");
    let header = format!("Messages {start}-{end}:\n\n");
    let mut offset = header.len();
    let printed_blocks: Vec<PrintedBlock> = printed
        .into_iter()
        .zip(&lines)
        .enumerate()
        .map(|(index, ((role, start, end, parts), line))| {
            offset += line.len() + usize::from(index > 0);
            PrintedBlock {
                role: role.to_string(),
                start,
                end,
                parts,
                text_end: offset,
            }
        })
        .collect();
    let hidden_ordinals = present
        .iter()
        .copied()
        .filter(|ordinal| {
            !printed_blocks
                .iter()
                .any(|block| block.start <= *ordinal && *ordinal <= block.end)
        })
        .collect();
    Some(Chunk {
        input: format!("{header}{text}"),
        validation: HistorianChunk {
            start_index: start,
            end_index: end,
            lines: covered,
            present_ordinals: present,
            hidden_ordinals,
            tool_only_ranges: tool_only,
            completed_tool_arcs: Vec::new(),
        },
        token_estimate: total,
        has_more: stopped,
        commit_clusters: clusters,
        messages,
        printed_blocks,
    })
}

/// The printed blocks of `chunk` whose whole line reached the summarizer in
/// `sent`, which may be [`Chunk::input`] cut to fit the model's window: a line
/// past the cut was not seen, so an anchor naming it can't be evidence
/// (`blocksSentToHistorian` in the plugin's `turn-one-publication.ts`).
pub fn blocks_sent<'a>(chunk: &'a Chunk, sent: &str) -> Vec<&'a PrintedBlock> {
    let common = chunk
        .input
        .bytes()
        .zip(sent.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    chunk
        .printed_blocks
        .iter()
        .filter(|block| block.text_end <= common)
        .collect()
}

/// One message's role letter, line parts, commit hashes and whether it
/// carries narrative (text rather than only tool calls). `None` for noise.
pub(super) fn render_entry(
    entry: &Entry,
    verbatim: bool,
) -> Option<(char, Vec<String>, Vec<String>, bool)> {
    let _timing = crate::notice_cost_timing::span("trigger.render_entry");
    let raw_texts: Vec<&str> = crate::neutral::authored_parts(entry)
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    match entry.role {
        Role::User => {
            let whole_text = raw_texts.join("\n");
            if is_relayed_wake(&whole_text) {
                let parts = relayed_wake::lines(&whole_text);
                return (!parts.is_empty()).then(|| ('R', parts, Vec::new(), true));
            }
            if let Some(agent) = &entry.speaks_for {
                let text = normalize(&whole_text);
                if text.is_empty() {
                    return None;
                }
                // One bounded line preserves the carried words without treating
                // them as the person's decision.
                let line = format!(
                    "Message from {}: {text}",
                    agent.name.as_deref().unwrap_or("another agent")
                );
                return Some((
                    'R',
                    vec![line.chars().take(1_500).collect()],
                    Vec::new(),
                    true,
                ));
            }
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
                let calls: Vec<String> = crate::neutral::authored_parts(entry)
                    .filter_map(|part| match &part.body {
                        PartBody::Tool(tool) => Some(tool_summary(&tool.name, &tool.input.parse())),
                        _ => None,
                    })
                    .collect();
                return (!calls.is_empty())
                    .then(|| ('A', vec![calls.join(" / ")], Vec::new(), false));
            }
            let joined = texts.join(" / ");
            let (compacted, commits) = compact_text_for_summary(&joined);
            // Evidence keeps the hashes in place; the line's prefix still
            // lists them.
            let text = if verbatim { joined } else { compacted };
            Some(('A', vec![text], commits, true))
        }
        // A turn-scoped system entry carries module text, never the user's or
        // the model's words, so the summarizer leaves it out, as it does an
        // entry whose role ck-mc doesn't know.
        _ => None,
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
        })
        // A shell call's command, on one line: the summarizer never sees tool
        // output, so without it the call says nothing about the work.
        .or_else(|| {
            input
                .get("command")
                .and_then(Value::as_str)
                .map(|command| truncate_units(&normalize(command), COMMAND_ARG_MAX_UNITS))
                .filter(|command| !command.is_empty())
        });
    match key {
        Some(key) => format!("TC: {name}({key})"),
        None => format!("TC: {name}"),
    }
}

/// Longest command a `TC:` line keeps, in UTF-16 units like the plugin's
/// `extractKeyArg`. A shell command often opens with `cd <absolute path> &&`,
/// which alone can fill the 60 units other key arguments keep.
const COMMAND_ARG_MAX_UNITS: usize = 200;

/// At most 60 UTF-16 code units, then an ellipsis.
fn truncate_arg(value: &str) -> String {
    truncate_units(value, 60)
}

/// At most `max` UTF-16 code units, then an ellipsis.
fn truncate_units(value: &str, max: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= max {
        return value.to_owned();
    }
    format!("{}…", crate::js_text::string_from_utf16_prefix(&units, max))
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Strip injected regions (reminder blocks, directives, and the
/// `<!-- OMO_INTERNAL_INITIATOR -->` comment oh-my-opencode adds to prompts
/// it sends itself) from a user's text. A message the user sent while the
/// agent ran, which older OpenCode wrapped in a reminder, is the user's own
/// words and stays ([`crate::injection::strip`]).
fn clean_user_text(text: &str) -> String {
    crate::injection::strip(text)
        .unwrap_or_else(|| text.trim().to_owned())
        .trim()
        .to_owned()
}

/// The summarizer's newest-prompt check uses this same envelope boundary.
/// `crate::injection::strip` removes through the first closing reminder tag,
/// so nested reminders can otherwise leave relay text looking like a user prompt.
pub(super) fn is_relayed_wake(text: &str) -> bool {
    relayed_wake::is_wake(text)
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
    use cortexkit_role_compaction::part::{Part, ToolPart, ToolStatus};
    use cortexkit_role_compaction::read::NoticeOrigin;
    use serde_json::json;

    fn entry(ordinal: u64, role: Role, notice: bool, parts: Vec<PartBody>) -> Entry {
        let parts: Vec<Part> = parts
            .into_iter()
            .enumerate()
            .map(|(index, body)| Part::new(format!("p{ordinal}.{index}"), body))
            .collect();
        let entry = Entry::new(ordinal, format!("m{ordinal}"), role, 0, parts);
        if notice {
            entry.with_notice(NoticeOrigin::new("prefrontal"))
        } else {
            entry
        }
    }

    fn text(text: &str) -> PartBody {
        PartBody::Text { text: text.into() }
    }

    #[test]
    fn speaks_for_backfill_refreshes_scan_counts_without_a_digest_change() {
        for model in [None, Some("anthropic/claude-opus-5-5")] {
            let counter = crate::count::Counter::for_model(model);
            assert_eq!(counter.family().is_some(), model.is_some());
            let mut cache = CountCache::default();
            let mut relay = entry(1, Role::User, false, vec![text("Read the retry contract.")]);
            let digest = relay.digest.clone();
            cache
                .build(std::slice::from_ref(&relay), 10_000, counter)
                .unwrap();
            let misses = cache.misses;
            relay.speaks_for = Some(
                serde_json::from_value(json!({"agent_id":"lead-agent", "name":"Alfonso"})).unwrap(),
            );
            let actual = cache
                .build(std::slice::from_ref(&relay), 10_000, counter)
                .unwrap();
            assert_eq!(relay.digest, digest);
            assert_eq!(cache.misses, misses + 1);
            let fresh = CountCache::default()
                .build(std::slice::from_ref(&relay), 10_000, counter)
                .unwrap();
            assert_eq!(actual, fresh);
        }
    }

    #[test]
    fn speaks_for_vectors_label_one_bounded_line_never_user_evidence() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../testdata/agent-relays.json")).unwrap();
        for vector in vectors.as_array().unwrap() {
            for notice in [false, true] {
                let mut relay = entry(
                    1,
                    Role::User,
                    notice,
                    vec![text(vector["text"].as_str().unwrap())],
                );
                relay.speaks_for =
                    Some(serde_json::from_value(vector["speaks_for"].clone()).unwrap());
                for mode in [Lines::Merged, Lines::PerMessage] {
                    let chunk = build_with(
                        std::slice::from_ref(&relay),
                        100_000,
                        mode,
                        crate::count::Counter::for_model(None),
                    )
                    .unwrap();
                    assert_eq!(
                        chunk.input,
                        format!("Messages 1-1:\n\n[1] {}", vector["line"].as_str().unwrap()),
                        "{}",
                        vector["name"]
                    );
                    assert!(!chunk.input.contains("U:"));
                }
            }
        }
        let mut long = entry(1, Role::User, false, vec![text(&"é".repeat(2_000))]);
        long.speaks_for = Some(serde_json::from_value(json!({"agent_id":"lead-agent"})).unwrap());
        let (role, lines, _, _) = render_entry(&long, true).unwrap();
        assert_eq!(role, 'R');
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].chars().count(), 1_500);
    }

    #[test]
    fn relayed_wake_vectors_retain_attribution_without_creating_user_evidence() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../testdata/relayed-wakes.json")).unwrap();
        let expand = |value: &str| {
            let mut value = value.to_owned();
            for (key, replacement) in vectors["replacements"].as_object().unwrap() {
                value = value.replace(
                    &format!("{{{{{key}}}}}"),
                    &replacement["text"]
                        .as_str()
                        .unwrap()
                        .repeat(replacement["count"].as_u64().unwrap() as usize),
                );
            }
            value
        };
        for vector in vectors["cases"].as_array().unwrap() {
            let raw = expand(vector["text"].as_str().unwrap());
            let expected: Vec<String> = vector["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| expand(line.as_str().unwrap()))
                .collect();
            assert_eq!(relayed_wake::lines(&raw), expected, "{}", vector["name"]);
            for notice in [false, true] {
                if notice && vector["userText"].is_string() {
                    continue;
                }
                for mode in [Lines::Merged, Lines::PerMessage] {
                    let wake = entry(1, Role::User, notice, vec![text(&raw)]);
                    let chunk = build_with(
                        std::slice::from_ref(&wake),
                        100_000,
                        mode,
                        crate::count::Counter::for_model(None),
                    );
                    if let Some(user_text) = vector["userText"].as_str() {
                        assert_eq!(
                            chunk.unwrap().input,
                            format!("Messages 1-1:\n\n[1] U: {user_text}")
                        );
                    } else {
                        assert!(!super::super::trigger::is_meaningful_user(&wake));
                        let mut attributed = wake.clone();
                        attributed.speaks_for = Some(
                            serde_json::from_value(json!({"agent_id":"peer", "name":"Mason"}))
                                .unwrap(),
                        );
                        if is_relayed_wake(&raw) {
                            assert_eq!(
                                render_entry(&attributed, false),
                                render_entry(&wake, false)
                            );
                        }
                        if expected.is_empty() {
                            assert!(chunk.is_none(), "{}", vector["name"]);
                        } else {
                            let chunk = chunk.unwrap();
                            assert_eq!(
                                chunk.input,
                                format!(
                                    "Messages 1-1:\n\n{}",
                                    expected
                                        .iter()
                                        .map(|line| format!("[1] {line}"))
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                )
                            );
                            assert!(chunk.printed_blocks.iter().all(|block| block.role == "R"));
                            assert!(chunk.validation.tool_only_ranges.is_empty());
                        }
                    }
                    if expected.is_empty() {
                        continue;
                    }
                    let followed = build_with(
                        &[
                            wake,
                            entry(
                                2,
                                Role::User,
                                false,
                                vec![text("The real user's decision.")],
                            ),
                        ],
                        100_000,
                        mode,
                        crate::count::Counter::for_model(None),
                    )
                    .unwrap();
                    assert!(followed
                        .input
                        .ends_with("\n[2] U: The real user's decision."));
                    assert_eq!(
                        followed
                            .printed_blocks
                            .iter()
                            .filter(|block| block.role == "U")
                            .flat_map(|block| &block.parts)
                            .collect::<Vec<_>>(),
                        vec!["The real user's decision."]
                    );
                    let surrounded = build_with(
                        &[
                            entry(1, Role::System, false, vec![text("hidden before")]),
                            entry(2, Role::User, notice, vec![text(&raw)]),
                            entry(3, Role::System, false, vec![text("hidden after")]),
                        ],
                        100_000,
                        mode,
                        crate::count::Counter::for_model(None),
                    )
                    .unwrap();
                    assert_eq!(
                        surrounded.input,
                        format!(
                            "Messages 1-3:\n\n{}",
                            expected
                                .iter()
                                .map(|line| format!("[2] {line}"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        )
                    );
                    assert_eq!(
                        (
                            surrounded.printed_blocks[0].start,
                            surrounded.printed_blocks[0].end
                        ),
                        (2, 2)
                    );
                    assert_eq!(surrounded.messages, 3);
                }
            }
        }
    }

    /// A message the user sent while the agent ran, which older OpenCode
    /// wrapped in a reminder, reaches the summarizer; a plain reminder does
    /// not.
    #[test]
    fn the_users_wrapped_message_reaches_the_summarizer() {
        let wrapped = "<system-reminder>\nThe user sent the following message:\nDo not deploy to production.\n\nPlease address this message and continue with your tasks.\n</system-reminder>";
        let entries = [
            entry(1, Role::User, false, vec![text("Start the release.")]),
            entry(2, Role::User, false, vec![text(wrapped)]),
            entry(
                3,
                Role::User,
                false,
                vec![text(
                    "<system-reminder>Spent output.</system-reminder> Go on.",
                )],
            ),
        ];
        let chunk =
            build(&entries, 10_000, crate::count::Counter::for_model(None)).expect("a chunk");
        assert!(
            chunk.input.contains("Do not deploy to production."),
            "{}",
            chunk.input
        );
        assert!(!chunk.input.contains("Spent output."), "{}", chunk.input);
        assert!(chunk.input.contains("Go on."), "{}", chunk.input);
    }

    fn tool(name: &str, input: Value) -> PartBody {
        PartBody::Tool(
            ToolPart::new("c", name, input, ToolStatus::Completed)
                .with_output("done")
                .with_output_bytes(4),
        )
    }

    /// Per-message lines: no merging, hidden messages stay in the range of the
    /// line before them, assistant text keeps its commit hashes in place, and
    /// each printed block knows where its line ends in the input.
    #[test]
    fn per_message_lines_print_each_message_and_record_where_it_ends() {
        let entries = [
            entry(1, Role::User, false, vec![text("Ship it."), text("Today.")]),
            entry(2, Role::User, false, vec![text("And tag it.")]),
            entry(3, Role::User, true, vec![text("a notice")]),
            entry(
                4,
                Role::Assistant,
                false,
                vec![text("Committed abc1234def as the fix.")],
            ),
        ];
        let chunk = build_with(
            &entries,
            10_000,
            Lines::PerMessage,
            crate::count::Counter::for_model(None),
        )
        .expect("a chunk");
        let lines: Vec<&str> = chunk.input.lines().skip(2).collect();
        assert_eq!(
            lines,
            [
                "[1] U: Ship it. / Today.",
                "[2-3] U: And tag it.",
                "[4] A: commits: abc1234def Committed abc1234def as the fix.",
            ]
        );
        let blocks: Vec<(u64, u64, &[String])> = chunk
            .printed_blocks
            .iter()
            .map(|block| (block.start, block.end, block.parts.as_slice()))
            .collect();
        assert_eq!(blocks[0], (1, 1, &["Ship it. / Today.".to_string()][..]));
        assert_eq!(blocks[1].0..=blocks[1].1, 2..=3);
        for (block, line) in chunk.printed_blocks.iter().zip(&lines) {
            assert!(chunk.input[..block.text_end].ends_with(line), "{line}");
        }
        // A cut inside the last line leaves the first two as evidence.
        let cut = &chunk.input[..chunk.printed_blocks[2].text_end - 3];
        let sent: Vec<u64> = blocks_sent(&chunk, cut)
            .iter()
            .map(|block| block.start)
            .collect();
        assert_eq!(sent, [1, 2]);
        // Merged lines are unchanged: a hidden message opens the next line,
        // and assistant text loses its hash.
        let merged =
            build(&entries, 10_000, crate::count::Counter::for_model(None)).expect("a chunk");
        assert!(
            merged.input.ends_with(
                "[1-2] U: Ship it. / Today. / And tag it.\n[3-4] A: commits: abc1234def Committed as the fix."
            ),
            "{}",
            merged.input
        );
    }

    /// A shell call with no description keeps its command, on one line and
    /// cut at 200 UTF-16 units, as the plugin's `extractKeyArg` does. A stated
    /// description still wins, and a blank command adds nothing.
    #[test]
    fn shell_calls_without_a_description_keep_their_command() {
        assert_eq!(
            tool_summary("shell", &json!({"command": "git status\n  --short"})),
            "TC: shell(git status --short)"
        );
        assert_eq!(
            tool_summary("bash", &json!({"command": "a".repeat(201)})),
            format!("TC: bash({}…)", "a".repeat(200))
        );
        assert_eq!(
            tool_summary(
                "bash",
                &json!({"command": "make", "description": "Build it"})
            ),
            "TC: Build it"
        );
        assert_eq!(
            tool_summary("bash", &json!({"command": " \n "})),
            "TC: bash"
        );
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
        let chunk = build(&entries, 10_000, crate::count::Counter::for_model(None)).unwrap();
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
    fn each_stretch_of_work_that_ends_in_commits_counts_once() {
        let entries = vec![
            entry(1, Role::User, false, vec![text("Fix the parser.")]),
            entry(
                2,
                Role::Assistant,
                false,
                vec![text("Committed abc1234 with the fix.")],
            ),
            // A second assistant message in the same stretch adds no cluster.
            entry(
                3,
                Role::Assistant,
                false,
                vec![text("Merged def5678 into main.")],
            ),
            entry(4, Role::User, false, vec![text("Now the lexer.")]),
            entry(
                5,
                Role::Assistant,
                false,
                vec![text("Committed 0abc123 for the lexer.")],
            ),
            entry(6, Role::User, false, vec![text("And the docs.")]),
            entry(
                7,
                Role::Assistant,
                false,
                vec![text("Updated the docs, nothing to commit.")],
            ),
            entry(8, Role::User, false, vec![text("Then tests.")]),
            entry(
                9,
                Role::Assistant,
                false,
                vec![text("Committed 9fedcba with the tests.")],
            ),
        ];
        let chunk = build(&entries, 10_000, crate::count::Counter::for_model(None)).unwrap();
        assert_eq!(chunk.commit_clusters, 3, "{}", chunk.input);
        assert_eq!(chunk.messages, 9);
    }

    #[test]
    fn a_line_past_the_budget_ends_the_chunk() {
        let entries = vec![
            entry(1, Role::User, false, vec![text("First.")]),
            entry(2, Role::Assistant, false, vec![text(&"word ".repeat(400))]),
        ];
        let chunk = build(&entries, 50, crate::count::Counter::for_model(None)).unwrap();
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
        assert_eq!(
            build(&entries, 1_000, crate::count::Counter::for_model(None)),
            None
        );
    }
    #[test]
    fn scan_counts_follow_entry_digests_and_counter_families() {
        let exact = crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5"));
        let old = crate::count::Counter::for_model(Some("test/model"));
        let mut cache = CountCache::default();
        let mut entries = vec![
            entry(1, Role::User, false, vec![text("Inspect src/session.rs")]),
            entry(
                2,
                Role::Assistant,
                false,
                vec![text("Read the notice handler.")],
            ),
        ];
        for counter in [exact, old] {
            let expected = cache.build(&entries, 10_000, counter);
            let sent = build(&entries, 10_000, counter);
            assert_eq!(
                expected.as_ref().unwrap().input,
                sent.as_ref().unwrap().input
            );
            if counter.family().is_none() {
                assert_eq!(expected, sent, "estimated scans keep their merged counts");
            } else {
                assert_eq!(
                    expected.as_ref().unwrap().token_estimate,
                    exact.count("[1] U: ")
                        + exact.count("Inspect src/session.rs")
                        + exact.count("[2] A: ")
                        + exact.count("Read the notice handler.")
                );
            }
            let misses = cache.misses;
            assert_eq!(cache.build(&entries, 10_000, counter), expected);
            assert_eq!(cache.misses, misses);
        }
        let before = cache.misses;
        cache.build(&entries, 10_000, exact);
        assert_eq!(
            cache.misses,
            before + 2,
            "a different vocabulary invalidates both entry counts"
        );
        entries[1] = entry(
            2,
            Role::Assistant,
            false,
            vec![text("Changed exact-family content.")],
        );
        let before = cache.misses;
        cache.build(&entries, 10_000, exact);
        assert_eq!(
            cache.misses,
            before + 1,
            "a changed digest invalidates only its entry"
        );
        cache.build(&entries[1..], 10_000, exact);
        assert_eq!(cache.entry_counts.len(), 1);
        cache.build(&entries, 10_000, old);
        entries[1] = entry(
            2,
            Role::Assistant,
            false,
            vec![text("The tool result changed; recheck the boundary.")],
        );
        let misses = cache.misses;
        assert_eq!(
            cache.build(&entries, 10_000, old),
            build(&entries, 10_000, old)
        );
        assert_eq!(cache.misses, misses + 1);
        cache.build(&entries[1..], 10_000, old);
        assert_eq!(
            cache.counts.len(),
            1,
            "pruned entries leave no cached counts"
        );
    }
}
