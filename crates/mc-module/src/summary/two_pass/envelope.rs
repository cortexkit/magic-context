//! Turn two's prompt and the strict parser for its reply, as the plugin's
//! `memory/turn-two-envelope.ts`.
//!
//! The reply schema is a prompt contract, not provider enforcement. The parser
//! never repairs JSON or extracts it from prose: anything that is not exactly
//! one JSON object of the expected shape is an envelope failure, and every
//! fact of that send is retried.

use crate::summary::prompts::{SummaryPrompts, WorkspaceRule};
use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::text::{lifecycle_text_hash, split_memory_clauses};

/// Every action the reply may name. `retire` and `promote_rule` are known
/// only so they can be dropped and logged without failing the whole reply.
const ACTIONS: [&str; 9] = [
    "new",
    "covered",
    "conflict",
    "edit",
    "merge",
    "replaces",
    "abstain",
    "retire",
    "promote_rule",
];

/// A clause the decision removes or replaces, with the evidence for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitedClause {
    pub memory_id: i64,
    pub clause: i64,
    /// The start ordinal of the fact's evidence block the excerpt is from.
    pub block: i64,
    pub excerpt: String,
}

/// A clause the decision adds, with the evidence for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddedClause {
    pub text: String,
    pub block: i64,
    pub excerpt: String,
}

/// One decision as the historian wrote it, after its own schema check.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Decision {
    pub fact_id: i64,
    /// Its position in the reply's `decisions`.
    pub ordinal: usize,
    pub action: String,
    /// Audit text only: it never authorizes or refuses anything.
    pub check: String,
    /// `covered`, `conflict`, `edit`, `replaces`, `retire`, `promote_rule`.
    pub target_id: Option<i64>,
    /// `covered`, `edit`, `replaces`: the target's revision the decision read.
    pub revision: Option<i64>,
    /// `merge`: every source with the revision the decision read.
    pub sources: Option<Vec<(i64, i64)>>,
    /// `merge`: the source that survives.
    pub survivor_id: Option<i64>,
    /// `covered`: the target's clause ordinals that state the fact.
    pub clauses: Option<Vec<i64>>,
    /// `new` only: an accepted decision not built yet, stored as `Decided: …`.
    pub decided: Option<bool>,
    /// `new` only: `project` or `workspace`, where the memory is stored. The
    /// workspace is taken only when the request named it.
    pub level: Option<String>,
    /// `new`, `edit`, `replaces`, `merge`: the calendar date (`YYYY-MM-DD`)
    /// the memory's own text says it stops holding. Such a memory is hidden
    /// after that day.
    pub expires: Option<String>,
    /// `covered`: an optional quote of the fact's evidence.
    pub excerpt: Option<String>,
    pub removed: Vec<CitedClause>,
    pub replaced: Vec<CitedClause>,
    /// `(memory id, clause)` pairs the revision keeps unchanged.
    pub kept: Vec<(i64, i64)>,
    pub added: Vec<AddedClause>,
    pub final_text: Option<String>,
}

/// A proposed importance for a queued agent memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub item: i64,
    pub importance: i64,
    pub proposed_class: String,
}

/// A fact's decision, or `Malformed` when it failed its own schema or two
/// decisions named the fact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Decision(Box<Decision>),
    Malformed,
}

/// Why a whole reply was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    LengthCapped,
    Unparseable,
    SchemaInvalid,
    ToolActivity,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LengthCapped => "length_capped",
            Self::Unparseable => "unparseable",
            Self::SchemaInvalid => "schema_invalid",
            Self::ToolActivity => "tool_activity",
        }
    }
}

/// A parsed reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// Decisions by fact id.
    pub decisions: BTreeMap<i64, Entry>,
    pub scores: Vec<Score>,
    /// False when the wrapper is valid but a decision or score was refused.
    pub schema_valid: bool,
}

/// `Decided: `, the prefix of a stored fact the historian marked as an
/// accepted decision not built yet.
pub const DECIDED_PREFIX: &str = "Decided: ";

/// The text a `new` decision stores: with `Decided: ` in front when the
/// decision says so and the text doesn't already start with it.
pub fn apply_decided_prefix(content: &str, decided: Option<bool>) -> String {
    if decided == Some(true) && !content.starts_with(DECIDED_PREFIX) {
        format!("{DECIDED_PREFIX}{content}")
    } else {
        content.to_owned()
    }
}

/// The year, month and day of a calendar date written `YYYY-MM-DD`.
pub fn calendar_date(text: &str) -> Option<(i64, u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| {
        bytes[range.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| text[range].parse::<u32>().ok())
            .flatten()
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (1..=days)
        .contains(&day)
        .then_some((i64::from(year), month, day))
}

fn is_calendar_date(text: &str) -> bool {
    calendar_date(text).is_some()
}

/// When the calendar day `date` ends on this machine: local midnight at the
/// start of the next day, in milliseconds since the epoch. A memory that ends
/// on `date` holds through that whole local day. The instant is fixed when the
/// memory is written, so a later change of time zone doesn't move it.
pub fn end_of_date_ms(date: &str) -> Option<i64> {
    use chrono::TimeZone;
    let (year, month, day) = calendar_date(date)?;
    let next = chrono::NaiveDate::from_ymd_opt(year as i32, month, day)?.succ_opt()?;
    let midnight = next.and_hms_opt(0, 0, 0)?;
    // Midnight can be skipped or repeated by a daylight-saving change; the
    // earliest instant that is that local time ends the day.
    let instant = match chrono::Local.from_local_datetime(&midnight) {
        chrono::LocalResult::Single(instant) => instant,
        chrono::LocalResult::Ambiguous(earliest, _) => earliest,
        chrono::LocalResult::None => chrono::Local
            .from_local_datetime(&(midnight + chrono::Duration::hours(1)))
            .earliest()?,
    };
    Some(instant.timestamp_millis())
}

/// JavaScript's `Number.isSafeInteger` on a JSON value: an integer, or a
/// float with no fraction, within ±(2^53 - 1).
fn safe_int(value: &Value) -> Option<i64> {
    const MAX: i64 = (1 << 53) - 1;
    let number = match value {
        Value::Number(number) => number,
        _ => return None,
    };
    if let Some(int) = number.as_i64() {
        return (-MAX..=MAX).contains(&int).then_some(int);
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float.abs() <= MAX as f64).then_some(float as i64)
}

fn int_field(record: &Map<String, Value>, key: &str) -> Option<i64> {
    record.get(key).and_then(safe_int)
}

fn cited_clauses(value: Option<&Value>) -> Option<Vec<CitedClause>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let entry = entry.as_object()?;
            Some(CitedClause {
                memory_id: int_field(entry, "memory_id")?,
                clause: int_field(entry, "clause")?,
                block: int_field(entry, "block")?,
                excerpt: entry.get("excerpt")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

fn added_clauses(value: Option<&Value>) -> Option<Vec<AddedClause>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let entry = entry.as_object()?;
            Some(AddedClause {
                text: entry.get("text")?.as_str()?.to_owned(),
                block: int_field(entry, "block")?,
                excerpt: entry.get("excerpt")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

/// One decision object, or `None` when it is malformed. A key that is
/// present with `null` counts as present, as in JavaScript's `in`, except
/// where the plugin tests for `undefined`.
fn parse_decision(raw: &Map<String, Value>, fact_id: i64, ordinal: usize) -> Option<Decision> {
    let action = raw.get("action")?.as_str()?;
    if !ACTIONS.contains(&action) {
        return None;
    }
    let check = raw.get("check")?.as_str()?.to_owned();
    // `decided` and `level` belong to `new` only.
    if action != "new" && (raw.contains_key("decided") || raw.contains_key("level")) {
        return None;
    }
    // `expires` belongs to the actions that write a memory's text, and must
    // be a real calendar date.
    let expires = match raw.get("expires") {
        None => None,
        Some(_) if !["new", "edit", "replaces", "merge"].contains(&action) => return None,
        Some(Value::String(date)) if is_calendar_date(date) => Some(date.clone()),
        Some(_) => return None,
    };
    let mut decision = Decision {
        fact_id,
        ordinal,
        action: action.to_owned(),
        check,
        expires,
        ..Decision::default()
    };
    match action {
        "new" => {
            match raw.get("decided") {
                None => {}
                Some(Value::Bool(decided)) => decision.decided = Some(*decided),
                Some(_) => return None,
            }
            match raw.get("level") {
                None => {}
                Some(Value::String(level)) if level == "project" || level == "workspace" => {
                    decision.level = Some(level.clone());
                }
                Some(_) => return None,
            }
            Some(decision)
        }
        "abstain" => Some(decision),
        "retire" | "promote_rule" | "conflict" => {
            decision.target_id = Some(int_field(raw, "target_id")?);
            Some(decision)
        }
        "covered" => {
            let target = int_field(raw, "target_id")?;
            let revision = int_field(raw, "revision")?;
            let clauses: Vec<i64> = raw
                .get("clauses")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<_>>()?;
            if clauses.is_empty() {
                return None;
            }
            match raw.get("excerpt") {
                None => {}
                Some(Value::String(excerpt)) => decision.excerpt = Some(excerpt.clone()),
                Some(_) => return None,
            }
            decision.target_id = Some(target);
            decision.revision = Some(revision);
            decision.clauses = Some(clauses);
            Some(decision)
        }
        _ => {
            // edit, replaces, merge
            decision.removed = cited_clauses(raw.get("removed"))?;
            decision.replaced = cited_clauses(raw.get("replaced"))?;
            decision.added = added_clauses(raw.get("added"))?;
            let kept = raw.get("kept")?.as_array()?;
            decision.final_text = Some(raw.get("final_text")?.as_str()?.to_owned());
            decision.kept = kept
                .iter()
                .map(|entry| {
                    let entry = entry.as_object()?;
                    Some((int_field(entry, "memory_id")?, int_field(entry, "clause")?))
                })
                .collect::<Option<_>>()?;
            if action == "merge" {
                let sources = raw.get("sources")?.as_array()?;
                let survivor = int_field(raw, "survivor_id")?;
                if sources.len() < 2 {
                    return None;
                }
                decision.sources = Some(
                    sources
                        .iter()
                        .map(|source| {
                            let source = source.as_object()?;
                            Some((int_field(source, "id")?, int_field(source, "revision")?))
                        })
                        .collect::<Option<_>>()?,
                );
                decision.survivor_id = Some(survivor);
                return Some(decision);
            }
            decision.target_id = Some(int_field(raw, "target_id")?);
            decision.revision = Some(int_field(raw, "revision")?);
            Some(decision)
        }
    }
}

/// Parse a turn-two reply. Tool activity, a length cap, text that is not one
/// JSON object, or an object without a `turn_two` result and a `decisions`
/// array refuse the whole reply. A decision that fails its own schema, or a
/// fact named twice, marks only that fact malformed.
pub fn parse(text: &str, length_capped: bool, tool_activity: bool) -> Result<Envelope, Refusal> {
    if tool_activity {
        return Err(Refusal::ToolActivity);
    }
    if length_capped {
        return Err(Refusal::LengthCapped);
    }
    let raw: Value = serde_json::from_str(text).map_err(|_| Refusal::Unparseable)?;
    let result = raw
        .as_object()
        .and_then(|raw| raw.get("result"))
        .and_then(Value::as_object)
        .filter(|result| result.get("step").and_then(Value::as_str) == Some("turn_two"))
        .ok_or(Refusal::SchemaInvalid)?;
    let decisions_raw = result
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or(Refusal::SchemaInvalid)?;
    let scores_raw = match result.get("scores") {
        None => &[][..],
        Some(Value::Array(scores)) => scores.as_slice(),
        Some(_) => return Err(Refusal::SchemaInvalid),
    };
    let mut schema_valid = true;
    let mut decisions = BTreeMap::new();
    for (ordinal, entry) in decisions_raw.iter().enumerate() {
        // A decision that names no fact can't be attributed: the fact it was
        // meant for is then missing, which is the same outcome.
        let Some((record, fact_id)) = entry
            .as_object()
            .and_then(|record| Some((record, int_field(record, "fact_id")?)))
        else {
            schema_valid = false;
            continue;
        };
        if let Some(earlier) = decisions.get_mut(&fact_id) {
            *earlier = Entry::Malformed;
            schema_valid = false;
            continue;
        }
        let decision = parse_decision(record, fact_id, ordinal);
        if decision
            .as_ref()
            .is_none_or(|decision| decision.action == "retire" || decision.action == "promote_rule")
        {
            schema_valid = false;
        }
        decisions.insert(
            fact_id,
            decision.map_or(Entry::Malformed, |decision| {
                Entry::Decision(Box::new(decision))
            }),
        );
    }
    // Scores keep their first-seen order; a repeated item drops both.
    let mut scores: Vec<Score> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for entry in scores_raw {
        let record = entry.as_object();
        let item = record.and_then(|record| int_field(record, "item"));
        if let Some(item) = item {
            if !seen.insert(item) {
                schema_valid = false;
                scores.retain(|score| score.item != item);
                continue;
            }
        }
        let valid = record.and_then(|record| {
            let importance =
                int_field(record, "importance").filter(|value| (1..=100).contains(value))?;
            let class = record
                .get("class")?
                .as_str()
                .filter(|class| (1..=64).contains(&class.encode_utf16().count()))?;
            Some(Score {
                item: item?,
                importance,
                proposed_class: class.to_owned(),
            })
        });
        match valid {
            Some(score) => scores.push(score),
            None => schema_valid = false,
        }
    }
    Ok(Envelope {
        decisions,
        scores,
        schema_valid,
    })
}

/// A source block as the prompt prints it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptBlock {
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub role: String,
    pub parts: Vec<String>,
}

/// A memory near a fact, with its revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Neighbour {
    pub id: i64,
    pub revision: i64,
    pub category: String,
    pub content: String,
    /// Stored for the project's workspace rather than for the project.
    pub workspace: bool,
}

/// One fact as the prompt shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptFact {
    pub fact_id: i64,
    pub category: String,
    pub content: String,
    pub source_session_id: String,
    pub anchor_known: bool,
    /// A fact of an earlier publication, sent again.
    pub backlog: bool,
    pub blocks: Vec<PromptBlock>,
    pub neighbours: Vec<Neighbour>,
}

/// A queued agent memory to score.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptItem {
    pub item: i64,
    pub memory_id: i64,
    pub content: String,
    pub excerpt: String,
}

/// Said when the size bound left facts or items out.
pub fn coverage_notice(facts: usize, items: usize) -> String {
    format!(
        "Coverage: this request is partial. {facts} pending fact(s) and {items} agent memory item(s) were left out to fit the request size. They remain eligible for a later run, but no later request is guaranteed; judge only what is listed here."
    )
}

/// Said when neighbours were found by words only.
pub const LEXICAL_ONLY_NOTICE: &str = "Neighbour retrieval was lexical-only for this request (no usable stored embeddings); a fact with no neighbour listed may still duplicate an existing memory.";

fn range(start: i64, end: i64) -> String {
    if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    }
}

fn render_neighbour(neighbour: &Neighbour) -> String {
    let clauses: Vec<String> = split_memory_clauses(&neighbour.content)
        .iter()
        .map(|clause| format!("  c{}: {}", clause.ordinal, clause.text))
        .collect();
    format!(
        "- #{} rev {} [{}]{}\n{}",
        neighbour.id,
        neighbour.revision,
        neighbour.category,
        if neighbour.workspace {
            " (workspace)"
        } else {
            ""
        },
        clauses.join("\n")
    )
}

/// The turn-two prompt. Shared evidence and memories are printed once, under
/// stable references; each fact lists the references it may use. Citations
/// are checked only against the fact's own blocks. Memories are never cut.
/// With `workspace`, the instruction carries the workspace rule.
pub fn build_prompt(
    prompts: &SummaryPrompts,
    facts: &[PromptFact],
    items: &[PromptItem],
    lexical_only: bool,
    deferred: (usize, usize),
    workspace: Option<&WorkspaceRule>,
) -> String {
    let ids: Vec<i64> = facts.iter().map(|fact| fact.fact_id).collect();
    let mut lines = vec![prompts.turn_two_in(&ids, workspace)];
    if lexical_only {
        lines.push(LEXICAL_ONLY_NOTICE.to_owned());
    }
    if deferred.0 > 0 || deferred.1 > 0 {
        lines.push(coverage_notice(deferred.0, deferred.1));
    }
    let mut sources: Vec<(String, String, &PromptBlock)> = Vec::new();
    let mut neighbours: Vec<(String, &Neighbour)> = Vec::new();
    for fact in facts {
        lines.push(String::new());
        lines.push(format!(
            "## Fact {}{} [{}] from session {}",
            fact.fact_id,
            if fact.backlog { " (backlog)" } else { "" },
            fact.category,
            fact.source_session_id
        ));
        lines.push(fact.content.clone());
        if !fact.anchor_known {
            lines.push("Source blocks: unknown (this fact cannot evidence an edit).".to_owned());
        }
        let refs: Vec<String> = fact
            .blocks
            .iter()
            .map(|block| {
                let key = serde_json::to_string(&(
                    &fact.source_session_id,
                    block.start_ordinal,
                    block.end_ordinal,
                    &block.role,
                    &block.parts,
                ))
                .expect("block serializes");
                let reference = format!("source:{}", lifecycle_text_hash(&key));
                if !sources.iter().any(|(known, ..)| *known == reference) {
                    sources.push((reference.clone(), fact.source_session_id.clone(), block));
                }
                reference
            })
            .collect();
        if !refs.is_empty() {
            lines.push(format!("Source block refs: {}", refs.join(", ")));
        }
        lines.push("Neighbour refs:".to_owned());
        if fact.neighbours.is_empty() {
            lines.push("- none retrieved".to_owned());
        }
        for neighbour in &fact.neighbours {
            let reference = format!("memory:{}@{}", neighbour.id, neighbour.revision);
            if !neighbours.iter().any(|(known, _)| *known == reference) {
                neighbours.push((reference.clone(), neighbour));
            }
            lines.push(reference);
        }
    }
    if !sources.is_empty() {
        lines.push(String::new());
        lines.push("## Shared source blocks".to_owned());
    }
    for (reference, session, block) in &sources {
        lines.push(String::new());
        lines.push(format!("### {reference} (session {session})"));
        lines.push(format!(
            "[{}] {}: {}",
            range(block.start_ordinal, block.end_ordinal),
            block.role,
            block.parts.join(" / ")
        ));
    }
    if !neighbours.is_empty() {
        lines.push(String::new());
        lines.push("## Shared neighbouring memories".to_owned());
    }
    for (reference, neighbour) in &neighbours {
        lines.push(String::new());
        lines.push(format!("### {reference}"));
        lines.push(render_neighbour(neighbour));
    }
    if !items.is_empty() {
        lines.push(String::new());
        lines.push("## Agent memories to score".to_owned());
        for item in items {
            lines.push(String::new());
            lines.push(format!(
                "### Item {} (memory #{})",
                item.item, item.memory_id
            ));
            lines.push(item.content.clone());
            lines.push("Excerpt:".to_owned());
            lines.push(item.excerpt.clone());
        }
    }
    lines.join("\n")
}

/// The share of the bound kept for backlog when older facts wait.
const BACKLOG_SHARE: f64 = 0.25;

/// What fits a prompt of `max_length` UTF-16 units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fitted {
    pub facts: Vec<PromptFact>,
    pub items: Vec<PromptItem>,
    /// Facts and items left out.
    pub deferred: (usize, usize),
    pub prompt: String,
}

fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Fit facts and items into `max_length` without cutting any of them. Fresh
/// facts get three quarters when backlog waits; backlog goes oldest first and
/// never skips an older fact; the oldest backlog fact is kept even when it
/// alone exceeds its share, since it can't be split and must not starve.
pub fn fit(
    prompts: &SummaryPrompts,
    facts: &[PromptFact],
    items: &[PromptItem],
    lexical_only: bool,
    max_length: usize,
    workspace: Option<&WorkspaceRule>,
) -> Fitted {
    let backlog: Vec<&PromptFact> = facts.iter().filter(|fact| fact.backlog).collect();
    let fresh: Vec<&PromptFact> = facts.iter().filter(|fact| !fact.backlog).collect();
    // Measured with the worst-case coverage notice, as the plugin does.
    let worst = (facts.len(), items.len());
    let render = |facts: &[PromptFact], items: &[PromptItem]| {
        length(&build_prompt(
            prompts,
            facts,
            items,
            lexical_only,
            worst,
            workspace,
        ))
    };
    let backlog_limit = (max_length as f64 * BACKLOG_SHARE).floor() as usize;
    let mut old: Vec<PromptFact> = Vec::new();
    for fact in &backlog {
        old.push((*fact).clone());
        if old.len() > 1 && render(&old, &[]) > backlog_limit {
            old.pop();
            break;
        }
    }
    let fresh_limit = if backlog.is_empty() {
        max_length
    } else {
        max_length - backlog_limit
    };
    let mut current: Vec<PromptFact> = Vec::new();
    for fact in &fresh {
        current.push((*fact).clone());
        let both: Vec<PromptFact> = current.iter().chain(&old).cloned().collect();
        if (!backlog.is_empty() || current.len() > 1)
            && (render(&current, &[]) > fresh_limit || render(&both, &[]) > max_length)
        {
            current.pop();
        }
    }
    for fact in backlog.iter().skip(old.len()) {
        old.push((*fact).clone());
        let both: Vec<PromptFact> = current.iter().chain(&old).cloned().collect();
        if render(&both, &[]) > max_length {
            old.pop();
            break;
        }
    }
    let chosen: Vec<PromptFact> = current.into_iter().chain(old).collect();
    let mut kept_items: Vec<PromptItem> = Vec::new();
    for item in items {
        kept_items.push(item.clone());
        if (!chosen.is_empty() || kept_items.len() > 1) && render(&chosen, &kept_items) > max_length
        {
            kept_items.pop();
        }
    }
    let deferred = (facts.len() - chosen.len(), items.len() - kept_items.len());
    let prompt = build_prompt(
        prompts,
        &chosen,
        &kept_items,
        lexical_only,
        deferred,
        workspace,
    );
    Fitted {
        facts: chosen,
        items: kept_items,
        deferred,
        prompt,
    }
}

#[cfg(test)]
#[path = "end_date_tests.rs"]
mod end_date_tests;
