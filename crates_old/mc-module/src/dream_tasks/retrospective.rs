//! Retrospective and global user-review planning over recorded host inputs.
//! Batches describe writes, not a second executor: the integration commits them
//! under the captured task lease, together with the schedule watermark.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

fn regex(pattern: &str) -> Regex {
    // JavaScript word boundaries and digit classes are ASCII even when the
    // surrounding learning contains Unicode. Rust's defaults are Unicode-aware.
    let pattern = pattern
        .replace(r"\b", r"(?-u:\b)")
        .replace(r"\d", "[0-9]")
        .replace(r"\W", "[^A-Za-z0-9_]");
    Regex::new(&pattern).unwrap()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GateVerdict {
    pub hit: bool,
    pub ordinals: Vec<usize>,
}

pub fn parse_gate(text: &str) -> GateVerdict {
    fn verdict(text: &str) -> GateVerdict {
        let ordinals: Vec<_> = regex(r"[0-9]+")
            .find_iter(text)
            .filter_map(|m| m.as_str().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .collect();
        GateVerdict {
            hit: !ordinals.is_empty(),
            ordinals,
        }
    }
    for line in text.lines().map(|s| s.trim().to_lowercase()) {
        if regex(r"^n(o)?\b").is_match(&line) {
            return GateVerdict {
                hit: false,
                ordinals: Vec::new(),
            };
        }
        if regex(r"^y(es)?\s*:").is_match(&line) {
            return verdict(line.split_once(':').unwrap().1);
        }
    }
    regex(r"\by(?:es)?\s*:\s*([\d,\s]+)")
        .captures(&text.to_lowercase())
        .map_or(
            GateVerdict {
                hit: false,
                ordinals: Vec::new(),
            },
            |c| verdict(c.get(1).unwrap().as_str()),
        )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Learning {
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub content: String,
}

fn unescape_xml(text: &str) -> String {
    regex(r"&(amp|apos|quot|lt|gt);")
        .replace_all(text, |c: &regex::Captures<'_>| match &c[1] {
            "amp" => "&",
            "apos" => "'",
            "quot" => "\"",
            "lt" => "<",
            "gt" => ">",
            _ => unreachable!(),
        })
        .into_owned()
}

pub fn parse_learnings(text: &str) -> Vec<Learning> {
    let block_re = regex(r"(?is)<learnings\b[^>]*>(.*?)</learnings>");
    let Some(block) = block_re.captures(text) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for capture in regex(r"(?is)<learning\b([^>]*)>(.*?)</learning>").captures_iter(&block[1]) {
        let mut attrs = BTreeMap::new();
        for attr in regex(r#"([a-zA-Z_:-]+)\s*=\s*"([^"]*)""#).captures_iter(&capture[1]) {
            attrs.insert(attr[1].to_string(), unescape_xml(&attr[2]));
        }
        let route = attrs.get("route").map(String::as_str).unwrap_or("");
        if route != "memory" && route != "observation" {
            continue;
        }
        let content = unescape_xml(capture[2].trim())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if content.is_empty() {
            continue;
        }
        let category = if route == "memory" {
            let Some(category) = attrs.get("category") else {
                continue;
            };
            if ![
                "PROJECT_RULES",
                "ARCHITECTURE",
                "CONSTRAINTS",
                "CONFIG_VALUES",
                "NAMING",
            ]
            .contains(&category.as_str())
            {
                continue;
            }
            Some(category.clone())
        } else {
            None
        };
        result.push(Learning {
            route: route.into(),
            category,
            content,
        });
    }
    result
}

fn words(text: &str) -> Vec<String> {
    regex(r"[^\p{L}\p{N}\s]")
        .replace_all(&text.to_lowercase(), " ")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

pub fn high_source_overlap(content: &str, sources: &[String]) -> bool {
    let mut learning = words(content);
    learning.truncate(200);
    let cap = 7.min(3.max(learning.len().div_ceil(2)));
    if learning.len() < cap {
        return false;
    }
    let grams: HashSet<_> = learning.windows(cap).collect();
    sources
        .iter()
        .any(|s| words(s).windows(cap).any(|w| grams.contains(w)))
}

pub fn reject_learning(content: &str, sources: &[String]) -> Option<&'static str> {
    if regex(r#"["“”][^"“”]{4,}["“"]|'[^']{4,}'"#).is_match(content) {
        return Some("raw_quote");
    }
    if regex(r"(?i)\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}/\d{1,2}/20\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b").is_match(content) { return Some("date"); }
    if regex(r"(?i)\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using)|(?:no|wrong|again|stop)(?:\W+\b(?:no|wrong|again|stop)\b)+)\b|[!?]{3,}").is_match(content) { return Some("frustration_marker"); }
    if high_source_overlap(content, sources) {
        return Some("source_overlap");
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub session_id: String,
    pub ordinal: usize,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub ts: i64,
}

/// Exact system-plus-user text for detecting user corrections or frustration.
/// Tool rows count toward message numbering, but their text is not sent to this
/// first, inexpensive model check.
pub fn gate_request(messages: &[Message]) -> String {
    let lines = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "user")
        .map(|(i, m)| format!("{}: {}", i + 1, m.text))
        .collect::<Vec<_>>()
        .join("\n");
    format!("You are a conservative friction detector for a coding agent. You read recent user message lines and decide whether the user was correcting, re-explaining to, or frustrated with the assistant. Output exactly one line and nothing else.\nDecide whether these user lines show the user correcting, re-explaining to, or expressing frustration at the ASSISTANT's behavior — a moment a future assistant should learn from.\n\nFire (y) when the user: corrects a mistake the assistant made, repeats an instruction the assistant didn't follow, tells the assistant to stop or revert an unwanted action, or shows frustration at repeated assistant behavior.\nDo NOT fire (n) for: a normal request or question; the user changing their own mind or fixing their own earlier message (\"actually, use X instead — my mistake\"); reporting a bug/error/test failure to investigate; a calm one-off \"do X instead\". The words \"no\", \"not\", \"error\", \"fail\", \"wrong\" inside an otherwise-normal sentence are not friction.\n\nReturn exactly one line: \"n\", or \"y: <line numbers>\". Be conservative.\n\n{lines}")
}

/// Recorded messages newer than the content watermark, plus prior user lines
/// for context across a run boundary. The provider limits each read to 80 source
/// messages and overlap to 12 user lines; it supplies `truncated` explicitly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRead {
    pub project_path: String,
    pub session_id: String,
    pub updated_at: Option<i64>,
    pub oldest_pending_ts: Option<i64>,
    pub messages: Vec<Message>,
    pub truncated: bool,
    pub overlap: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    pub watermark_ms: i64,
    pub recency_cutoff_ms: Option<i64>,
    pub max_messages: usize,
    pub max_sessions: usize,
    pub usable_input_tokens: Option<usize>,
    pub indexed_oldest: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            watermark_ms: 0,
            recency_cutoff_ms: None,
            max_messages: 240,
            max_sessions: 20,
            usable_input_tokens: None,
            indexed_oldest: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanWindow {
    pub messages: Vec<Message>,
    pub max_scanned_ts: i64,
    pub prompt_tokens: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_input_limit_tokens: Option<usize>,
    pub budget_truncated: bool,
}

fn clamp_message(mut message: Message) -> Message {
    const MARKER: &str = "\n[… middle of user message truncated by Magic Context …]\n";
    if message.role == "user" && message.text.encode_utf16().count() > 8000 {
        let kept = 8000 - MARKER.encode_utf16().count();
        let head = super::primers::utf16_prefix(&message.text, kept.div_ceil(2));
        let units: Vec<_> = message.text.encode_utf16().collect();
        let tail = String::from_utf16_lossy(&units[units.len() - kept / 2..]);
        message.text = format!("{head}{MARKER}{tail}");
    }
    message
}

/// Admit oldest messages first and return a watermark that cannot skip unread
/// messages. The background task's provider performs at most 20 reads, each
/// capped at 80 source messages, plus up to 12 prior user lines per session.
/// `estimate` measures the complete model request, including static instructions.
pub fn scan_window(
    project: &str,
    sessions: &[SessionRead],
    options: &ScanOptions,
    estimate: impl Fn(&[Message]) -> usize,
) -> ScanWindow {
    let cutoff = options.recency_cutoff_ms.unwrap_or(i64::MIN);
    let since = options.watermark_ms.max(cutoff.saturating_sub(1));
    let limit = options
        .usable_input_tokens
        .filter(|v| *v > 0)
        .map(|v| (v as f64 * 0.97).floor() as usize)
        .filter(|v| *v > 0);
    let eligible: Vec<_> = sessions
        .iter()
        .filter(|s| s.project_path == project && s.updated_at.unwrap_or(i64::MAX) > since)
        .collect();
    let mut ordered: Vec<_> = eligible
        .iter()
        .copied()
        .filter(|s| !options.indexed_oldest || s.oldest_pending_ts.is_some())
        .collect();
    ordered.sort_by_key(|s| {
        if options.indexed_oldest {
            s.oldest_pending_ts.unwrap_or(i64::MAX)
        } else {
            s.updated_at.unwrap_or(i64::MAX)
        }
    });
    let selected: Vec<_> = ordered
        .iter()
        .take(options.max_sessions.max(1))
        .copied()
        .collect();
    let excluded = ordered.get(options.max_sessions.max(1));
    let mut frontier = selected
        .iter()
        .filter(|s| s.truncated)
        .filter_map(|s| s.messages.last())
        .map(|m| m.ts.saturating_sub(1))
        .min()
        .unwrap_or(i64::MAX);
    let mut all: Vec<_> = selected
        .iter()
        .flat_map(|s| &s.messages)
        .filter(|m| m.ts >= cutoff)
        .cloned()
        .map(clamp_message)
        .collect();
    all.sort_by_key(|m| (m.ts, m.ordinal));
    let count = all.len().min(options.max_messages);
    let mut kept = Vec::new();
    let mut budget_truncated = false;
    for row in all.iter().take(count) {
        kept.push(row.clone());
        if limit.is_some_and(|v| estimate(&kept) > v) {
            kept.pop();
            budget_truncated = true;
            break;
        }
    }
    if let Some(dropped) = all.get(kept.len()) {
        frontier = frontier.min(dropped.ts.saturating_sub(1));
    }
    if let Some(excluded) = excluded {
        if let Some(ts) = if options.indexed_oldest {
            excluded.oldest_pending_ts
        } else {
            excluded.updated_at
        } {
            frontier = frontier.min(ts.saturating_sub(1));
        }
    }
    let mut max_scanned_ts = since;
    if options.indexed_oldest && selected.iter().all(|s| s.messages.is_empty()) {
        max_scanned_ts = eligible
            .iter()
            .map(|s| s.updated_at.unwrap_or(since))
            .max()
            .unwrap_or(since)
            .max(since);
    }
    for row in &kept {
        max_scanned_ts = max_scanned_ts.max(row.ts);
    }
    max_scanned_ts = since.max(max_scanned_ts.min(frontier));
    let key = |m: &Message| {
        format!(
            "{}\0{}\0{}\0{}",
            m.session_id,
            m.ts,
            m.role,
            m.tool_name.as_deref().unwrap_or("")
        )
    };
    let mut seen = HashSet::new();
    let kept_sessions: HashSet<_> = kept.iter().map(|m| m.session_id.clone()).collect();
    kept.retain(|m| seen.insert(key(m)));
    if options.watermark_ms > 0 && options.watermark_ms >= cutoff {
        let mut overlap: Vec<_> = selected
            .iter()
            .filter(|s| kept_sessions.contains(&s.session_id))
            .flat_map(|s| &s.overlap)
            .filter(|m| m.ts >= cutoff)
            .cloned()
            .map(clamp_message)
            .collect();
        overlap.sort_by_key(|m| (m.ts, m.ordinal));
        for row in overlap {
            if !seen.insert(key(&row)) {
                continue;
            }
            let mut merged = kept.clone();
            merged.push(row.clone());
            merged.sort_by_key(|m| (m.ts, m.ordinal));
            if limit.is_none_or(|v| estimate(&merged) <= v) {
                kept = merged;
            } else {
                seen.remove(&key(&row));
            }
        }
    }
    kept.sort_by_key(|m| (m.ts, m.ordinal));
    ScanWindow {
        prompt_tokens: estimate(&kept),
        messages: kept,
        max_scanned_ts,
        prompt_input_limit_tokens: limit,
        budget_truncated,
    }
}

pub fn window_key(flagged: &[&Message]) -> String {
    let mut anchors: Vec<_> = flagged
        .iter()
        .map(|m| format!("{}:{}", m.session_id, m.ts))
        .collect();
    anchors.sort();
    format!("{:x}", Sha256::digest(anchors.join("|").as_bytes()))[..32].into()
}

pub fn friction_window(messages: &[Message], flagged: &[usize]) -> String {
    messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let ordinal = i + 1;
            if !flagged.iter().any(|f| f.abs_diff(ordinal) <= 2) {
                return None;
            }
            let role = match m.role.as_str() {
                "assistant" => "A",
                "tool" => "tool",
                _ => "U",
            };
            let tool = m
                .tool_name
                .as_ref()
                .map_or(String::new(), |t| format!(" {t}"));
            let suffix = if flagged.contains(&ordinal) {
                "  [friction]"
            } else {
                ""
            };
            Some(format!(
                "{ordinal}. ({}) {role}{tool}: {}{suffix}",
                m.session_id, m.text
            ))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub memory_written: usize,
    pub observations_inserted: usize,
    pub observations_dropped: usize,
    pub rejected: Vec<RejectedLearning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RejectedLearning {
    pub content: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWrite {
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub source_session_id: String,
    pub source_type: String,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationWrite {
    pub content: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetrospectiveBatch {
    pub project_path: String,
    pub lease_key: String,
    pub retrospective_watermark_ms: i64,
    pub processed_window_key: Option<String>,
    /// Timestamp for the processed-window marker and observation rows. New
    /// observations have null compartment bounds; the source session is explicit.
    pub write_time_ms: i64,
    /// Apply through the background-only `mc.memory` writer, which records
    /// history and queues embeddings. Do not use direct inserts, TypeScript
    /// writers or the served `ctx_memory` tool for these commands.
    pub memory_writes: Vec<MemoryWrite>,
    pub observations: Vec<ObservationWrite>,
    pub result: ApplyResult,
}

/// A successful gate with only overlap hits still advances the scanned content
/// watermark. A model/transport failure must not call this planner at all.
#[allow(clippy::too_many_arguments)]
pub fn plan_retrospective(
    project: &str,
    lease_key: &str,
    now: i64,
    watermark: i64,
    max_scanned_ts: i64,
    messages: &[Message],
    gate_text: &str,
    deepen_text: &str,
    collection_enabled: bool,
    processed_windows: &HashSet<String>,
    existing_memories: &HashSet<(String, String)>,
) -> RetrospectiveBatch {
    let mut batch = RetrospectiveBatch {
        project_path: project.into(),
        lease_key: lease_key.into(),
        retrospective_watermark_ms: max_scanned_ts,
        processed_window_key: None,
        write_time_ms: now,
        memory_writes: Vec::new(),
        observations: Vec::new(),
        result: ApplyResult::default(),
    };
    let gate = parse_gate(gate_text);
    let flagged: Vec<_> = messages
        .iter()
        .enumerate()
        .filter(|(i, m)| {
            m.role == "user" && !m.text.trim().is_empty() && gate.ordinals.contains(&(i + 1))
        })
        .map(|(_, m)| m)
        .collect();
    if !gate.hit || !flagged.iter().any(|m| m.ts > watermark) {
        return batch;
    }
    let key = window_key(&flagged);
    if processed_windows.contains(&key) {
        return batch;
    }
    batch.processed_window_key = Some(key);
    let source_session = &flagged[0].session_id;
    let sources: Vec<_> = messages
        .iter()
        .filter(|m| m.role == "user" && !m.text.trim().is_empty())
        .map(|m| m.text.clone())
        .collect();
    let mut seen = HashSet::new();
    let mut existing = existing_memories.clone();
    for learning in parse_learnings(deepen_text) {
        if !seen.insert(format!(
            "{}:{}:{}",
            learning.route,
            learning.category.as_deref().unwrap_or(""),
            learning.content
        )) {
            continue;
        }
        if let Some(reason) = reject_learning(&learning.content, &sources) {
            batch.result.rejected.push(RejectedLearning {
                content: learning.content,
                reason: reason.into(),
            });
        } else if learning.route == "memory" {
            let category = learning.category.unwrap();
            let hash = mc_store::compute_normalized_memory_hash(&learning.content);
            if !existing.insert((category.clone(), hash)) {
                continue;
            }
            batch.memory_writes.push(MemoryWrite {
                project_path: project.into(),
                category,
                content: learning.content,
                source_session_id: source_session.clone(),
                source_type: "dreamer".into(),
                metadata_json: "{\"source\":\"retrospective\"}".into(),
            });
            batch.result.memory_written += 1;
        } else if collection_enabled {
            batch.observations.push(ObservationWrite {
                content: learning.content,
                session_id: source_session.clone(),
            });
        } else {
            batch.result.observations_dropped += 1;
        }
    }
    batch.result.observations_inserted = batch.observations.len();
    batch
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserCandidate {
    pub id: i64,
    pub content: String,
    pub session_id: String,
    pub created_at: i64,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub promoted: usize,
    pub merged: usize,
    pub dismissed: usize,
    pub candidates_consumed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserPromotion {
    pub content: String,
    pub candidate_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdate {
    pub memory_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserProvenance {
    pub candidate_id: i64,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreparation {
    pub domain: String,
    pub lease_key: String,
    pub pruned_candidate_ids: Vec<i64>,
    pub should_review: bool,
}

/// Delete expired candidates before requesting a verdict so they are removed
/// even when no model call is made or the later review fails.
pub fn prepare_user_review(
    lease_key: &str,
    now: i64,
    threshold: usize,
    candidates: &[UserCandidate],
) -> ReviewPreparation {
    let pruned_candidate_ids: Vec<_> = candidates
        .iter()
        .filter(|c| c.created_at < now - 30 * super::primers::DAY_MS)
        .map(|c| c.id)
        .collect();
    ReviewPreparation {
        domain: "user-memories".into(),
        lease_key: lease_key.into(),
        should_review: candidates.len() - pruned_candidate_ids.len() >= threshold,
        pruned_candidate_ids,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBatch {
    /// User profile review is global, not a project-memory write.
    pub domain: String,
    pub lease_key: String,
    /// Promotions insert active rows with promoted/created/updated times equal
    /// to this value; updates and dismissals set updated_at to the same value.
    pub write_time_ms: i64,
    /// Capture candidate provenance before consuming candidates so their source
    /// information remains available after the candidate rows are deleted.
    pub candidate_provenance: Vec<UserProvenance>,
    pub pruned_candidate_ids: Vec<i64>,
    pub promotions: Vec<UserPromotion>,
    pub updates: Vec<UserUpdate>,
    pub dismissals: Vec<i64>,
    pub consume_candidate_ids: Vec<i64>,
    /// Increment the user-profile data version only. Never invalidate an already
    /// cached foreground prompt; these writes appear on its next natural rebuild.
    pub bump_user_profile_version: bool,
    pub result: ReviewResult,
}

pub fn plan_user_review(
    lease_key: &str,
    now: i64,
    threshold: usize,
    candidates: &[UserCandidate],
    text: &str,
) -> Result<ReviewBatch, String> {
    let mut batch = ReviewBatch {
        domain: "user-memories".into(),
        lease_key: lease_key.into(),
        write_time_ms: now,
        candidate_provenance: Vec::new(),
        pruned_candidate_ids: Vec::new(),
        promotions: Vec::new(),
        updates: Vec::new(),
        dismissals: Vec::new(),
        consume_candidate_ids: Vec::new(),
        bump_user_profile_version: false,
        result: ReviewResult::default(),
    };
    let preparation = prepare_user_review(lease_key, now, threshold, candidates);
    batch.pruned_candidate_ids = preparation.pruned_candidate_ids;
    if !preparation.should_review {
        return Ok(batch);
    }
    if text.is_empty() {
        return Err("User memory review returned no output.".into());
    }
    let json = super::primers::answer_json(text).ok_or("User memory review returned no JSON.")?;
    let parsed: Value =
        serde_json::from_str(json).map_err(|_| "User memory review returned invalid JSON.")?;
    if parsed.is_null() {
        return Err("User memory review returned null JSON.".into());
    }
    fn array(parsed: &Value, key: &str) -> Result<Vec<Value>, String> {
        match parsed.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(a)) => Ok(a.clone()),
            _ => Err(format!("{key} must be an array")),
        }
    }
    fn content(value: &Value) -> Result<&str, String> {
        if value.is_null() {
            return Err("review item must not be null".into());
        }
        match value.get("content") {
            None | Some(Value::Null) => Ok(""),
            Some(Value::String(text)) => Ok(text.trim()),
            _ => Err("review content must be a string".into()),
        }
    }
    let promotions = array(&parsed, "promote")?;
    let updates = array(&parsed, "update_existing")?;
    let dismissals = array(&parsed, "dismiss_existing")?;
    if dismissals.iter().any(Value::is_null) {
        return Err("review dismissal must not be null".into());
    }
    let mut consumed: Vec<i64> = array(&parsed, "consume_candidate_ids")?
        .iter()
        .filter_map(Value::as_i64)
        .collect();
    for promotion in promotions {
        let content = content(&promotion)?;
        if content.is_empty() {
            continue;
        }
        let ids: Vec<_> = array(&promotion, "candidate_ids")?
            .iter()
            .filter_map(Value::as_i64)
            .collect();
        consumed.extend(&ids);
        batch.promotions.push(UserPromotion {
            content: content.into(),
            candidate_ids: ids,
        });
    }
    for update in updates {
        let content = content(&update)?;
        let id = update.get("memory_id").and_then(Value::as_i64).unwrap_or(0);
        if id == 0 || content.is_empty() {
            continue;
        }
        batch.updates.push(UserUpdate {
            memory_id: id,
            content: content.into(),
        });
        consumed.extend(
            array(&update, "candidate_ids")?
                .iter()
                .filter_map(Value::as_i64),
        );
    }
    batch.dismissals = dismissals
        .iter()
        .filter_map(|d| d.get("memory_id").and_then(Value::as_i64))
        .filter(|id| *id != 0)
        .collect();
    let mut seen = HashSet::new();
    batch.consume_candidate_ids = consumed.into_iter().filter(|id| seen.insert(*id)).collect();
    batch.bump_user_profile_version =
        !batch.promotions.is_empty() || !batch.updates.is_empty() || !batch.dismissals.is_empty();
    let mut sources: Vec<_> = candidates
        .iter()
        .filter(|c| !batch.pruned_candidate_ids.contains(&c.id))
        .collect();
    sources.sort_by_key(|c| c.id);
    batch.candidate_provenance = sources
        .into_iter()
        .map(|c| UserProvenance {
            candidate_id: c.id,
            session_id: c.session_id.clone(),
            source_compartment_start: c.source_compartment_start,
            source_compartment_end: c.source_compartment_end,
        })
        .collect();
    batch.result = ReviewResult {
        promoted: batch.promotions.len(),
        merged: batch.updates.len(),
        dismissed: batch.dismissals.len(),
        candidates_consumed: batch.consume_candidate_ids.len(),
    };
    Ok(batch)
}

/// Return task state for a successful retry's watermark commit, removing
/// `retrospectiveOverflow` (the shrinking input budget after provider-size
/// refusals). Preserve all unrelated task state.
pub fn completed_task_state(state: &Value, watermark: i64) -> Option<Value> {
    active_overflow(state, watermark)?;
    let mut root = state.as_object()?.clone();
    root.remove("retrospectiveOverflow");
    Some(Value::Object(root))
}

fn active_overflow(state: &Value, watermark: i64) -> Option<&Value> {
    state.get("retrospectiveOverflow").filter(|o| {
        o.get("watermarkMs").and_then(Value::as_i64) == Some(watermark)
            && ["failures", "nextUsableInputTokens", "abandonAfterMs"]
                .iter()
                .all(|key| o.get(key).is_some_and(Value::is_number))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverflowPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrospective_watermark_ms: Option<i64>,
    pub task_state: Value,
}

pub fn plan_overflow(
    state: &Value,
    watermark: i64,
    scanned: i64,
    usable_input: usize,
) -> OverflowPatch {
    let active = active_overflow(state, watermark);
    let failures = active
        .and_then(|o| o.get("failures"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    let abandon_after = active
        .and_then(|o| o.get("abandonAfterMs"))
        .and_then(Value::as_i64)
        .unwrap_or(watermark)
        .max(scanned);
    let mut root = state.as_object().cloned().unwrap_or_default();
    let retrospective_watermark_ms = if failures >= 2 {
        root.remove("retrospectiveOverflow");
        Some(abandon_after)
    } else {
        root.insert(
            "retrospectiveOverflow".into(),
            json!({"watermarkMs":watermark,"failures":failures,
            "nextUsableInputTokens":512.max(usable_input / 2),"abandonAfterMs":abandon_after}),
        );
        None
    };
    OverflowPatch {
        retrospective_watermark_ms,
        task_state: Value::Object(root),
    }
}

pub fn orphan_stale_ms(timeouts_minutes: &[Option<u64>]) -> u64 {
    let timeout = timeouts_minutes
        .iter()
        .map(|v| v.unwrap_or(20).max(1))
        .max()
        .unwrap_or(20)
        .max(20);
    (60 * 60_000).max(timeout * 60_000 * 3 + 15 * 60_000)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalChild {
    pub id: String,
    pub directory: String,
    pub title: String,
    pub time_created: i64,
    pub time_archived: Option<i64>,
}

/// Select only stale internal children from the captured project directory.
/// Deletion is best-effort at the carrier boundary; never delete a live retained
/// child when keep-subagents is enabled, even for privacy-sensitive tasks.
pub fn orphan_deletions(
    children: &[InternalChild],
    directory: &str,
    now: i64,
    privacy_stale_ms: i64,
    historian_stale_ms: i64,
    keep_subagents: bool,
) -> Vec<String> {
    let privacy = [
        "retrospective",
        "user-memories",
        "curate",
        "maintain-docs",
        "refresh-primers",
        "map-memories",
        "verify",
        "classify",
        "compress-cues",
    ];
    let mut rows: Vec<_> = children
        .iter()
        .filter(|c| {
            if c.directory != directory {
                return false;
            }
            let sensitive = privacy
                .iter()
                .any(|task| c.title == format!("magic-context-dream-{task}"))
                || c.title.starts_with("magic-context-smart-note-compile-")
                || c.title.starts_with("magic-context-smart-note-confirm-");
            if sensitive {
                return (!keep_subagents || c.time_archived.is_some())
                    && c.time_created < now - privacy_stale_ms;
            }
            !keep_subagents
                && [
                    "magic-context-compartment",
                    "magic-context-memory-migration",
                ]
                .contains(&c.title.as_str())
                && c.time_created < now - historian_stale_ms
        })
        .collect();
    rows.sort_by_key(|c| c.time_created);
    rows.truncate(200);
    rows.into_iter().map(|c| c.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected decisions and write arguments come from the TypeScript dreamer
    // implementation at git revision 282d9c08bce4, using a fixed clock and temporary
    // inputs. Both fixture runs use a character-count estimator; production passes
    // the child model's tokenizer through the same explicit estimator parameter.
    const NOW: i64 = 17_280_000_000;
    const LEARNINGS: &str = r#"<learnings><learning route="memory" category="PROJECT_RULES"> Prefer bounded transactions &amp; retries </learning><learning route="observation">Expects independent verification</learning><learning route="memory" category="PROJECT_RULES">Prefer bounded transactions &amp; retries</learning><learning route="memory" category="USER_PREFERENCES">wrong category</learning><learning route="observation">No no stop!!!</learning><learning route="memory" category="NAMING">Use the name &amp;lt;rule&amp;gt;</learning></learnings>"#;

    fn message(session: &str, ts: i64) -> Message {
        Message {
            session_id: session.into(),
            ordinal: ts as usize,
            role: "user".into(),
            text: "line".into(),
            tool_name: None,
            ts,
        }
    }

    fn session(id: &str, times: &[i64]) -> SessionRead {
        SessionRead {
            project_path: "/p".into(),
            session_id: id.into(),
            updated_at: Some(100),
            oldest_pending_ts: times.first().copied(),
            messages: times.iter().map(|ts| message(id, *ts)).collect(),
            truncated: false,
            overlap: Vec::new(),
        }
    }

    fn window_messages() -> Vec<Message> {
        serde_json::from_value(json!([
            {"sessionId":"s1","ordinal":8,"role":"user","text":"old correction","ts":10},
            {"sessionId":"s1","ordinal":9,"role":"tool","text":"read src/a","toolName":"read","ts":20},
            {"sessionId":"s1","ordinal":10,"role":"user","text":"Please repair the broken route now","ts":30}
        ])).unwrap()
    }

    #[test]
    fn friction_gate_and_stable_window_match_ts() {
        for (text, expected) in [
            ("n", json!({"hit":false,"ordinals":[]})),
            ("No: 2026", json!({"hit":false,"ordinals":[]})),
            (
                "yes, user mentioned 4\ny: 3, 7",
                json!({"hit":true,"ordinals":[3,7]}),
            ),
            (
                "prose 2026\nyes: 2, 0, 2",
                json!({"hit":true,"ordinals":[2,2]}),
            ),
            ("prose y: 5, 6 end", json!({"hit":true,"ordinals":[5,6]})),
            ("yes", json!({"hit":false,"ordinals":[]})),
            ("unparseable 25", json!({"hit":false,"ordinals":[]})),
        ] {
            assert_eq!(serde_json::to_value(parse_gate(text)).unwrap(), expected);
        }
        let messages = window_messages();
        assert_eq!(
            window_key(&[&messages[0], &messages[2]]),
            "2f5cb4c0efd1fd7188af65706fcb1a09"
        );
        assert_eq!(
            window_key(&[&messages[2], &messages[0]]),
            "2f5cb4c0efd1fd7188af65706fcb1a09"
        );
        assert_eq!(friction_window(&messages,&[1,3]),"1. (s1) U: old correction  [friction]\n2. (s1) tool read: read src/a\n3. (s1) U: Please repair the broken route now  [friction]");
    }

    #[test]
    fn learning_privacy_rejections_match_ts() {
        for (content, expected) in [
            ("Keep \"quoted words\" forever", Some("raw_quote")),
            ("On Jan 2, 2026 do things", Some("date")),
            ("Stop using that API", Some("frustration_marker")),
            ("依赖2026-1-2", Some("date")),
            ("请stop doing this", Some("frustration_marker")),
            ("Good", None),
            ("Distill the invariant rather than copy user anger", None),
        ] {
            assert_eq!(reject_learning(content, &[]), expected);
        }
        assert_eq!(
            reject_learning("abc def ghi", &["ABC! def ghi".into()]),
            Some("source_overlap")
        );
        assert_eq!(
            reject_learning(
                "Prefer safe bounded write transactions across every task",
                &[format!(
                    "{}safe bounded write transactions across every task",
                    "x ".repeat(1000)
                )]
            ),
            Some("source_overlap")
        );
        assert!(
            parse_learnings("<learning route=\"observation\">missing manifest</learning>")
                .is_empty()
        );
        let parsed = serde_json::to_value(parse_learnings(LEARNINGS)).unwrap();
        assert_eq!(
            parsed,
            json!([
                {"route":"memory","category":"PROJECT_RULES","content":"Prefer bounded transactions & retries"},
                {"route":"observation","content":"Expects independent verification"},
                {"route":"memory","category":"PROJECT_RULES","content":"Prefer bounded transactions & retries"},
                {"route":"observation","content":"No no stop!!!"},
                {"route":"memory","category":"NAMING","content":"Use the name &lt;rule&gt;"}
            ])
        );
    }

    #[test]
    fn retrospective_write_batch_and_idempotence_match_ts() {
        let messages = window_messages();
        for enabled in [true, false] {
            let batch = plan_retrospective(
                "/p",
                "project:/p",
                NOW,
                15,
                30,
                &messages,
                "y: 1, 3",
                LEARNINGS,
                enabled,
                &HashSet::new(),
                &HashSet::new(),
            );
            let expected = json!({"projectPath":"/p","leaseKey":"project:/p","writeTimeMs":NOW,"retrospectiveWatermarkMs":30,
                "processedWindowKey":"2f5cb4c0efd1fd7188af65706fcb1a09",
                "memoryWrites":[
                    {"projectPath":"/p","category":"PROJECT_RULES","content":"Prefer bounded transactions & retries","sourceSessionId":"s1","sourceType":"dreamer","metadataJson":"{\"source\":\"retrospective\"}"},
                    {"projectPath":"/p","category":"NAMING","content":"Use the name &lt;rule&gt;","sourceSessionId":"s1","sourceType":"dreamer","metadataJson":"{\"source\":\"retrospective\"}"}
                ],"observations":if enabled {json!([{"content":"Expects independent verification","sessionId":"s1"}])}else{json!([])},
                "result":{"memoryWritten":2,"observationsInserted":usize::from(enabled),"observationsDropped":usize::from(!enabled),"rejected":[{"content":"No no stop!!!","reason":"frustration_marker"}]}});
            assert_eq!(
                serde_json::to_vec(&serde_json::to_value(batch).unwrap()).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
        }
        for gate in ["n", "y: 1", "unparseable 25"] {
            let b = plan_retrospective(
                "/p",
                "project:/p",
                NOW,
                15,
                30,
                &messages,
                gate,
                LEARNINGS,
                true,
                &HashSet::new(),
                &HashSet::new(),
            );
            assert_eq!(b.retrospective_watermark_ms, 30);
            assert!(b.processed_window_key.is_none());
            assert!(b.memory_writes.is_empty());
            assert!(b.observations.is_empty());
        }
        let processed = HashSet::from(["2f5cb4c0efd1fd7188af65706fcb1a09".into()]);
        let b = plan_retrospective(
            "/p",
            "project:/p",
            NOW,
            15,
            30,
            &messages,
            "y: 1, 3",
            LEARNINGS,
            true,
            &processed,
            &HashSet::new(),
        );
        assert!(b.processed_window_key.is_none());
        assert!(b.memory_writes.is_empty());
        let existing = HashSet::from([(
            "PROJECT_RULES".into(),
            "3b5fd4cfe9003ee194e76d0a995ba1e9".into(),
        )]);
        let b = plan_retrospective(
            "/p",
            "project:/p",
            NOW,
            15,
            30,
            &messages,
            "y: 1, 3",
            LEARNINGS,
            true,
            &HashSet::new(),
            &existing,
        );
        assert_eq!(b.result.memory_written, 1);
        assert_eq!(b.memory_writes[0].category, "NAMING");
    }

    fn estimate(messages: &[Message]) -> usize {
        gate_request(messages).encode_utf16().count()
    }

    fn assert_scan(
        sessions: Vec<SessionRead>,
        options: ScanOptions,
        kept: &[(&str, i64)],
        watermark: i64,
        tokens: usize,
        truncated: bool,
    ) {
        let expected = ScanWindow {
            messages: kept.iter().map(|(s, ts)| message(s, *ts)).collect(),
            max_scanned_ts: watermark,
            prompt_tokens: tokens,
            prompt_input_limit_tokens: options.usable_input_tokens.map(|_| 1074),
            budget_truncated: truncated,
        };
        let actual = scan_window("/p", &sessions, &options, estimate);
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn scan_saturation_and_excluded_session_frontiers_match_ts() {
        let options = ScanOptions {
            indexed_oldest: true,
            ..Default::default()
        };
        let mut a = session("s1", &[10, 20]);
        a.truncated = true;
        assert_scan(
            vec![a, session("s2", &[15, 30])],
            options.clone(),
            &[("s1", 10), ("s2", 15), ("s1", 20), ("s2", 30)],
            19,
            1090,
            false,
        );
        assert_scan(
            vec![session("s1", &[10, 100]), session("s2", &[20])],
            ScanOptions {
                max_sessions: 1,
                ..options
            },
            &[("s1", 10), ("s1", 100)],
            19,
            1074,
            false,
        );
    }

    #[test]
    fn scan_budget_overlap_count_and_recency_match_ts() {
        let options = ScanOptions {
            watermark_ms: 10,
            indexed_oldest: true,
            ..Default::default()
        };
        let mut a = session("s1", &[20, 30, 40]);
        a.overlap = vec![message("s1", 5)];
        assert_scan(
            vec![a],
            ScanOptions {
                max_messages: 2,
                ..options.clone()
            },
            &[("s1", 5), ("s1", 20), ("s1", 30)],
            30,
            1082,
            false,
        );
        assert_scan(
            vec![session("s1", &[20, 30, 40])],
            ScanOptions {
                watermark_ms: 0,
                usable_input_tokens: Some(1108),
                ..options.clone()
            },
            &[("s1", 20), ("s1", 30)],
            30,
            1074,
            true,
        );
        assert_scan(
            vec![session("s1", &[20, 21, 30])],
            ScanOptions {
                recency_cutoff_ms: Some(21),
                ..options.clone()
            },
            &[("s1", 21), ("s1", 30)],
            30,
            1074,
            false,
        );
        let mut idle = session("s1", &[]);
        idle.updated_at = Some(50);
        assert_scan(vec![idle], options, &[], 50, 1059, false);
    }

    #[test]
    fn scan_user_atom_head_tail_clamp_matches_ts() {
        let mut a = session("s1", &[20]);
        a.messages[0].text = format!("{}{}", "a".repeat(5000), "b".repeat(5000));
        let window = scan_window("/p", &[a], &ScanOptions::default(), estimate);
        assert_eq!(
            window.messages[0].text,
            format!(
                "{}\n[… middle of user message truncated by Magic Context …]\n{}",
                "a".repeat(3972),
                "b".repeat(3971)
            )
        );
        assert_eq!(window.max_scanned_ts, 20);
    }

    fn user_candidates() -> Vec<UserCandidate> {
        (1..=3)
            .map(|id| UserCandidate {
                id,
                content: "trait".into(),
                session_id: format!("s{id}"),
                created_at: NOW,
                source_compartment_start: Some(1),
                source_compartment_end: Some(3),
            })
            .collect()
    }

    #[test]
    fn review_consumption_version_and_writes_match_ts() {
        let text = r#"{"promote":[{"content":" Prefers concise reviews ","candidate_ids":[1,2,2]},{"content":" "}],"update_existing":[{"memory_id":5,"content":" Expects tests ","candidate_ids":[3]},{"memory_id":0,"content":"ignored","candidate_ids":[4]}],"dismiss_existing":[{"memory_id":9}],"consume_candidate_ids":[2,7]}"#;
        let batch = plan_user_review("user-memories", NOW, 3, &user_candidates(), text).unwrap();
        let expected = json!({"domain":"user-memories","leaseKey":"user-memories","writeTimeMs":NOW,"prunedCandidateIds":[],
            "candidateProvenance":[{"candidate_id":1,"session_id":"s1","source_compartment_start":1,"source_compartment_end":3},{"candidate_id":2,"session_id":"s2","source_compartment_start":1,"source_compartment_end":3},{"candidate_id":3,"session_id":"s3","source_compartment_start":1,"source_compartment_end":3}],
            "promotions":[{"content":"Prefers concise reviews","candidateIds":[1,2,2]}],"updates":[{"memoryId":5,"content":"Expects tests"}],"dismissals":[9],"consumeCandidateIds":[2,7,1,3],"bumpUserProfileVersion":true,
            "result":{"promoted":1,"merged":1,"dismissed":1,"candidatesConsumed":4}});
        assert_eq!(
            serde_json::to_vec(&serde_json::to_value(batch).unwrap()).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        let batch = plan_user_review(
            "user-memories",
            NOW,
            3,
            &user_candidates(),
            r#"{"consume_candidate_ids":[1,1,8]}"#,
        )
        .unwrap();
        assert_eq!(batch.consume_candidate_ids, vec![1, 8]);
        assert!(!batch.bump_user_profile_version);
        assert_eq!(batch.result.candidates_consumed, 2);
    }

    #[test]
    fn review_decay_threshold_and_truncated_output_match_ts() {
        let mut candidates = user_candidates();
        candidates[0].created_at = NOW - 30 * super::super::primers::DAY_MS - 1;
        let batch = plan_user_review("user-memories", NOW, 3, &candidates, "").unwrap();
        assert_eq!(batch.pruned_candidate_ids, vec![1]);
        assert_eq!(batch.result, ReviewResult::default());
        let preparation = prepare_user_review("user-memories", NOW, 2, &candidates);
        assert_eq!(preparation.pruned_candidate_ids, vec![1]);
        assert!(preparation.should_review);
        assert_eq!(
            plan_user_review(
                "user-memories",
                NOW,
                3,
                &user_candidates(),
                r#"{"promote":["#
            )
            .unwrap_err(),
            "User memory review returned no JSON."
        );
        assert_eq!(
            plan_user_review(
                "user-memories",
                NOW,
                3,
                &user_candidates(),
                "```json\n{not json}\n```"
            )
            .unwrap_err(),
            "User memory review returned invalid JSON."
        );
        assert!(plan_user_review(
            "user-memories",
            NOW,
            3,
            &user_candidates(),
            r#"{"promote":[{"content":7,"candidate_ids":[1]}],"consume_candidate_ids":[1]}"#
        )
        .is_err());
    }

    #[test]
    fn overflow_retry_and_abandon_keep_unrelated_state() {
        let patch = plan_overflow(&json!({"other":true}), 10, 30, 2048);
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({"taskState":{"other":true,"retrospectiveOverflow":{"watermarkMs":10,"failures":1,"nextUsableInputTokens":1024,"abandonAfterMs":30}}})
        );
        let second = plan_overflow(&patch.task_state, 10, 20, 1024);
        assert_eq!(
            serde_json::to_value(second).unwrap(),
            json!({"retrospectiveWatermarkMs":30,"taskState":{"other":true}})
        );
        assert_eq!(
            completed_task_state(&patch.task_state, 10),
            Some(json!({"other":true}))
        );
        assert_eq!(completed_task_state(&patch.task_state, 11), None);
        assert_eq!(
            completed_task_state(&json!({"retrospectiveOverflow":{"watermarkMs":10}}), 10),
            None
        );
    }

    #[test]
    fn orphan_age_privacy_retention_and_project_match_ts() {
        for (minutes, expected) in [
            (vec![], 4_500_000),
            (vec![Some(1)], 4_500_000),
            (vec![Some(20)], 4_500_000),
            (vec![Some(30)], 6_300_000),
            (vec![None, Some(40)], 8_100_000),
        ] {
            assert_eq!(orphan_stale_ms(&minutes), expected);
        }
        let mut children = Vec::new();
        for (id, directory, title, time_created, time_archived) in [
            ("active", "/p", "magic-context-dream-retrospective", 1, None),
            (
                "archived",
                "/p",
                "magic-context-dream-user-memories",
                2,
                Some(10),
            ),
            (
                "recent",
                "/p",
                "magic-context-dream-retrospective",
                99,
                Some(100),
            ),
            (
                "foreign",
                "/other",
                "magic-context-dream-retrospective",
                1,
                Some(2),
            ),
            ("ordinary", "/p", "ordinary", 1, Some(2)),
            ("historian", "/p", "magic-context-compartment", 3, None),
            (
                "smart",
                "/p",
                "magic-context-smart-note-compile-a",
                4,
                Some(5),
            ),
        ] {
            children.push(InternalChild {
                id: id.into(),
                directory: directory.into(),
                title: title.into(),
                time_created,
                time_archived,
            });
        }
        assert_eq!(
            orphan_deletions(&children, "/p", 100, 10, 20, true),
            vec!["archived", "smart"]
        );
        assert_eq!(
            orphan_deletions(&children, "/p", 100, 10, 20, false),
            vec!["active", "archived", "historian", "smart"]
        );
    }
}
