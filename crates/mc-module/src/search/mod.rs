//! `ctx_search`: one query over the session's earlier messages, the
//! project's memories, git commits and primers, and the session's notes.
//! Argument rules, scoring, ordering and the reply follow the TypeScript
//! tool (`tools/ctx-search` and `features/magic-context/search.ts`), so an
//! agent reads the same in both.
//!
//! Not here yet: semantic scores (query embeddings), summary-chunk search,
//! reranking, and memories a workspace shares from other projects.

pub mod messages;
pub mod sources;
pub mod text;

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::Value;

use messages::{DateRange, MessageHit};
use sources::{CommitHit, MemoryHit, NoteHit, PrimerHit};

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 25;
/// A query of at most this many id-shaped tokens looks memories up by id.
const ID_QUERY_MAX_TOKENS: usize = 5;
const MEMORY_BOOST: f64 = 1.3;
const MESSAGE_BOOST: f64 = 1.275;
const GIT_COMMIT_BOOST: f64 = 1.2;
const PRIMER_BOOST: f64 = 1.25;
const SOURCES: [&str; 5] = ["memory", "message", "git_commit", "primer", "note"];

/// What a search may read for one session.
pub struct Scope<'a> {
    pub harness: &'a str,
    pub session: &'a str,
    /// The project whose memories, commits and primers are searched; `None`
    /// when the session has no project.
    pub project: Option<&'a str>,
    /// Messages after this number are in the model's view already and are
    /// not returned.
    pub cutoff: i64,
    /// The memory text the model's view shows in full, by memory id. A
    /// memory whose current text it shows is left out of the results.
    pub seen: &'a BTreeMap<i64, String>,
    pub memory_enabled: bool,
    pub git_commits_enabled: bool,
    /// Whether the project folder holds a git repository.
    pub git_repository: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
enum Hit {
    Memory(MemoryHit),
    Message(MessageHit),
    Commit(CommitHit),
    Primer(PrimerHit),
    Note(NoteHit),
}

impl Hit {
    fn score(&self) -> f64 {
        match self {
            Hit::Memory(hit) => hit.score,
            Hit::Message(hit) => hit.score,
            Hit::Commit(hit) => hit.score,
            Hit::Primer(hit) => hit.score,
            Hit::Note(hit) => hit.score,
        }
    }

    fn boosted(&self) -> f64 {
        self.score()
            * match self {
                Hit::Memory(_) => MEMORY_BOOST,
                Hit::Message(_) => MESSAGE_BOOST,
                Hit::Commit(_) => GIT_COMMIT_BOOST,
                Hit::Primer(_) => PRIMER_BOOST,
                Hit::Note(_) => 1.0,
            }
    }
}

/// Best boosted score first; ties within one source in that source's order.
fn compare(left: &Hit, right: &Hit) -> std::cmp::Ordering {
    use std::cmp::Ordering::Equal;
    let by_score = right
        .boosted()
        .partial_cmp(&left.boosted())
        .unwrap_or(Equal);
    if by_score != Equal {
        return by_score;
    }
    match (left, right) {
        (Hit::Memory(left), Hit::Memory(right)) => left.id.cmp(&right.id),
        (Hit::Message(left), Hit::Message(right)) => left.number.cmp(&right.number),
        (Hit::Commit(left), Hit::Commit(right)) => right.committed_at.cmp(&left.committed_at),
        (Hit::Primer(left), Hit::Primer(right)) => right
            .support
            .cmp(&left.support)
            .then(left.id.cmp(&right.id)),
        (Hit::Note(left), Hit::Note(right)) => right
            .created_at
            .cmp(&left.created_at)
            .then(left.id.cmp(&right.id)),
        _ => Equal,
    }
}

#[derive(Default)]
struct Diagnostics {
    suppressed_visible: Vec<i64>,
    live_message_matches: u64,
    no_git_repository: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// A `from` or `to` bound: `YYYY-MM-DD` (the whole UTC day) or a full ISO
/// datetime with a zone.
fn parse_date(value: &str, field: &str) -> Result<i64, String> {
    let invalid =
        || format!("Error: Invalid '{field}' date; use YYYY-MM-DD or a full ISO datetime.");
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = trimmed.get(range)?;
        slice
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| slice.parse().ok())?
    };
    let date = (bytes.len() >= 10 && bytes[4] == b'-' && bytes[7] == b'-')
        .then(|| Some((digits(0..4)?, digits(5..7)?, digits(8..10)?)))
        .flatten();
    let Some((year, month, day)) = date else {
        return Err(invalid());
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(invalid());
    }
    let start = days_from_civil(year, month, day) * 86_400_000;
    if bytes.len() == 10 {
        return Ok(if field == "to" {
            start + 86_400_000 - 1
        } else {
            start
        });
    }
    // A full datetime: `THH:MM[:SS[.fff]]` then `Z` or `±HH:MM`.
    let rest = &trimmed[10..];
    let Some(time) = rest.strip_prefix('T') else {
        return Err(invalid());
    };
    let (clock, offset_ms) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else if time.len() > 6 && matches!(time.as_bytes()[time.len() - 6], b'+' | b'-') {
        let (clock, zone) = time.split_at(time.len() - 6);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let hours: i64 = zone[1..3].parse().map_err(|_| invalid())?;
        let minutes: i64 = zone[4..6].parse().map_err(|_| invalid())?;
        if &zone[3..4] != ":" {
            return Err(invalid());
        }
        (clock, sign * (hours * 3_600_000 + minutes * 60_000))
    } else {
        return Err(invalid());
    };
    let mut fields = clock.splitn(3, ':');
    let hours: i64 = fields
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    let minutes: i64 = fields
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    let seconds: f64 = fields
        .next()
        .map_or(Ok(0.0), |v| v.parse())
        .map_err(|_| invalid())?;
    if hours > 23 || minutes > 59 || !(0.0..60.0).contains(&seconds) {
        return Err(invalid());
    }
    Ok(start + hours * 3_600_000 + minutes * 60_000 + (seconds * 1000.0) as i64 - offset_ms)
}

fn date_range(input: &Value) -> Result<Option<DateRange>, String> {
    let from = input.get("from").and_then(Value::as_str);
    let to = input.get("to").and_then(Value::as_str);
    if from.is_none() && to.is_none() {
        return Ok(None);
    }
    let from = from.map(|value| parse_date(value, "from")).transpose()?;
    let to = to.map(|value| parse_date(value, "to")).transpose()?;
    if let (Some(from), Some(to)) = (from, to) {
        if from > to {
            return Err("Error: Invalid date range; 'from' must be on or before 'to'.".into());
        }
    }
    Ok(Some(DateRange {
        from: from.unwrap_or(i64::MIN),
        to: to.unwrap_or(i64::MAX),
    }))
}

/// A query that is only memory ids: one to five tokens of digits, each
/// optionally after `#`.
fn id_query(query: &str) -> Option<Vec<i64>> {
    let tokens: Vec<&str> = query
        .split(|ch: char| ch.is_whitespace() || ch == ',')
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() || tokens.len() > ID_QUERY_MAX_TOKENS {
        return None;
    }
    tokens
        .iter()
        .map(|token| {
            let digits = token.strip_prefix('#').unwrap_or(token);
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            digits.parse::<i64>().ok().filter(|id| *id > 0)
        })
        .collect()
}

fn age(at: i64, now: i64) -> String {
    let elapsed = now - at;
    if elapsed < 0 {
        return "future".into();
    }
    let days = elapsed / 86_400_000;
    match days {
        0 => "today".into(),
        1 => "1d ago".into(),
        2..=29 => format!("{days}d ago"),
        _ if days / 30 == 1 => "1mo ago".into(),
        _ if days / 30 < 12 => format!("{}mo ago", days / 30),
        _ if days / 365 == 1 => "1y ago".into(),
        _ => format!("{}y ago", days / 365),
    }
}

fn format_hit(hit: &Hit, index: usize, session: &str, now: i64) -> String {
    match hit {
        Hit::Memory(hit) => format!(
            "[{index}] [memory] score={:.2} id={} category={} match={}\n{}",
            hit.score, hit.id, hit.category, hit.match_type, hit.content
        ),
        Hit::Commit(hit) => format!(
            "[{index}] [git_commit] score={:.2} sha={} {} match=fts\n{}",
            hit.score,
            hit.short_sha,
            age(hit.committed_at, now),
            hit.content
        ),
        Hit::Primer(hit) => format!(
            "[{index}] [primer] score={:.2} id={} support={} match=fts\n{}",
            hit.score, hit.id, hit.support, hit.content
        ),
        Hit::Note(hit) => {
            let anchor = match (hit.anchor_ordinal, hit.session_id.as_deref()) {
                (Some(anchor), Some(owner)) if owner == session => format!(" @msg {anchor}"),
                _ => String::new(),
            };
            format!(
                "[{index}] [note] score={:.2} id=#{} status={} {}{anchor}\n{}",
                hit.score,
                hit.id,
                hit.status,
                age(hit.created_at, now),
                hit.content
            )
        }
        Hit::Message(hit) => format!(
            "[{index}] [message] score={:.2} ordinal={} range={}-{} role={}\n{}",
            hit.score,
            hit.number,
            (hit.number - 3).max(1),
            hit.number + 3,
            hit.role,
            hit.content
        ),
    }
}

fn diagnostic_lines(hits: &[Hit], diagnostics: &Diagnostics) -> Vec<String> {
    let mut lines = Vec::new();
    let visible = &diagnostics.suppressed_visible;
    if !visible.is_empty() {
        let count = visible.len();
        let noun = if count == 1 { "match" } else { "matches" };
        let ids = visible
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        if hits.iter().any(|hit| matches!(hit, Hit::Memory(_))) {
            lines.push(format!(
                "Memories: {count} additional {noun} suppressed because {} already visible in your project-memory block (ids {ids}).",
                if count == 1 { "it is" } else { "they are" }
            ));
        } else {
            lines.push(format!(
                "Memories: {count} {noun} found, all already visible in your project-memory block (ids {ids})."
            ));
        }
    }
    if diagnostics.live_message_matches > 0 {
        let count = diagnostics.live_message_matches;
        lines.push(format!(
            "Message history: {count} raw-message {} newer than the last compartment boundary (already in your context).",
            if count == 1 { "match is" } else { "matches are" }
        ));
    }
    if diagnostics.no_git_repository {
        lines.push(
            "Git commits: no git repository — commit search unavailable for this project.".into(),
        );
    }
    lines
}

fn format_results(query: &str, hits: &[Hit], session: &str, diagnostics: &Diagnostics) -> String {
    let lines = diagnostic_lines(hits, diagnostics);
    if hits.is_empty() {
        if !lines.is_empty() {
            return format!(
                "No hidden results found for \"{query}\".\n\n{}",
                lines.join("\n")
            );
        }
        return format!(
            "No results found for \"{query}\" across notes, memories, primers, git commits, or message history."
        );
    }
    let now = now_ms();
    let mut parts: Vec<String> = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| format_hit(hit, index + 1, session, now))
        .collect();
    if !lines.is_empty() {
        parts.push(lines.join("\n"));
    }
    if hits.iter().any(|hit| matches!(hit, Hit::Message(_))) {
        parts.push("Use ctx_expand(start, end) with the range from any message result above to read the conversation context. If the host no longer holds those messages, ctx_expand returns indexed text from the search archive only, with no surrounding messages or tool output.".into());
    }
    if hits.iter().any(|hit| {
        matches!(hit, Hit::Note(note) if note.anchor_ordinal.is_some() && note.session_id.as_deref() == Some(session))
    }) {
        parts.push("Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.".into());
    }
    format!(
        "Found {} result{} for \"{query}\":\n\n{}",
        hits.len(),
        if hits.len() == 1 { "" } else { "s" },
        parts.join("\n\n")
    )
}

/// Memories by id, in the order asked, leaving out ones the model sees.
/// `None` when no id names a current memory of the project.
fn memories_by_id(
    conn: &Connection,
    project: &str,
    ids: &[i64],
    limit: usize,
    visible: &BTreeSet<i64>,
    dates: Option<DateRange>,
    diagnostics: &mut Diagnostics,
) -> Option<Vec<Hit>> {
    let memories = sources::project_memories(conn, project).unwrap_or_default();
    let mut hits = Vec::new();
    let mut suppressed = BTreeSet::new();
    for id in ids {
        let Some(memory) = memories.iter().find(|memory| {
            memory.id == *id && dates.is_none_or(|dates| dates.contains(memory.created_at))
        }) else {
            continue;
        };
        if visible.contains(id) {
            suppressed.insert(*id);
            continue;
        }
        let rank = hits.len();
        hits.push(Hit::Memory(MemoryHit {
            id: memory.id,
            category: memory.category.clone(),
            content: text::preview(&memory.content),
            score: 1.0 - rank as f64 * 0.01,
            match_type: "fts",
        }));
        if hits.len() >= limit {
            break;
        }
    }
    diagnostics.suppressed_visible = suppressed.into_iter().collect();
    (!hits.is_empty()).then_some(hits)
}

/// Run one `ctx_search` call.
pub fn run(conn: &mut Connection, scope: &Scope, input: &Value) -> Result<String, String> {
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if query.is_empty() {
        return Err("Error: 'query' is required.".into());
    }
    let dates = date_range(input)?;
    let tool_limit = match input.get("limit").and_then(Value::as_f64) {
        Some(limit) if limit.is_finite() && limit != 0.0 => (limit.floor() as i64).max(1) as usize,
        _ => DEFAULT_LIMIT,
    };
    let requested: Option<Vec<String>> =
        input
            .get("sources")
            .and_then(Value::as_array)
            .and_then(|list| {
                if list.is_empty() {
                    return None;
                }
                let mut seen = Vec::new();
                for source in list.iter().filter_map(Value::as_str) {
                    if SOURCES.contains(&source)
                        && !seen.iter().any(|known: &String| known == source)
                    {
                        seen.push(source.to_owned());
                    }
                }
                Some(seen)
            });
    let active = |source: &str| {
        requested
            .as_ref()
            .is_none_or(|list| list.iter().any(|known| known == source))
    };
    let Some(project) = scope.project else {
        return Err(
            "Error: Could not resolve project identity for search: the session has no project."
                .into(),
        );
    };
    let visible: BTreeSet<i64> = sources::project_memories(conn, project)
        .unwrap_or_default()
        .iter()
        .filter(|memory| scope.seen.get(&memory.id) == Some(&memory.content))
        .map(|memory| memory.id)
        .collect();
    let mut diagnostics = Diagnostics::default();
    if scope.memory_enabled {
        if let Some(ids) = id_query(query) {
            let limit = tool_limit.max(ids.len());
            let found = memories_by_id(
                conn,
                project,
                &ids,
                limit,
                &visible,
                dates,
                &mut diagnostics,
            );
            if found.is_some() || !diagnostics.suppressed_visible.is_empty() {
                return Ok(format_results(
                    query,
                    &found.unwrap_or_default(),
                    scope.session,
                    &diagnostics,
                ));
            }
        }
    }
    let limit = tool_limit.clamp(1, MAX_LIMIT);
    let tier = (limit * 3).max(DEFAULT_LIMIT);
    let probes = text::literal_probes(query);
    let wanted = messages::Query {
        text: query,
        limit: tier,
        probes: &probes,
        dates,
    };
    if active("git_commit") && scope.git_repository == Some(false) {
        diagnostics.no_git_repository = true;
    }
    let mut hits: Vec<Hit> = Vec::new();
    if active("memory") && scope.memory_enabled {
        let (found, suppressed) =
            sources::search_memories(conn, project, query, tier, &visible, dates);
        diagnostics.suppressed_visible = suppressed;
        hits.extend(found.into_iter().map(Hit::Memory));
    }
    if active("primer") && scope.memory_enabled {
        hits.extend(
            sources::search_primers(conn, project, query, tier, dates)
                .into_iter()
                .map(Hit::Primer),
        );
    }
    if active("message") {
        diagnostics.live_message_matches =
            messages::count_live_matches(conn, scope.session, query, scope.cutoff, dates);
        hits.extend(
            messages::search(conn, scope.session, &wanted, scope.cutoff, true)
                .into_iter()
                .map(Hit::Message),
        );
    }
    if active("git_commit") && scope.git_commits_enabled {
        hits.extend(
            sources::search_commits(conn, project, query, tier, dates)
                .into_iter()
                .map(Hit::Commit),
        );
    }
    if active("note") {
        hits.extend(
            sources::search_notes(conn, scope.harness, scope.session, project, &wanted)
                .into_iter()
                .map(Hit::Note),
        );
    }
    hits.sort_by(compare);
    hits.truncate(limit);
    let returned: Vec<i64> = hits
        .iter()
        .filter_map(|hit| match hit {
            Hit::Memory(memory) => Some(memory.id),
            _ => None,
        })
        .collect();
    if let Err(error) = sources::count_retrievals(conn, &returned) {
        eprintln!(
            "ck-mc: session {}: counting memory retrievals failed: {error}",
            scope.session
        );
    }
    Ok(format_results(query, &hits, scope.session, &diagnostics))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_take_whole_days_or_full_datetimes() {
        assert_eq!(parse_date("2026-10-01", "from"), Ok(1_790_812_800_000));
        assert_eq!(parse_date("2026-10-01", "to"), Ok(1_790_899_199_999));
        assert_eq!(
            parse_date("2026-10-01T02:00:00+02:00", "from"),
            Ok(1_790_812_800_000)
        );
        assert!(parse_date("2026-02-30", "from").is_err());
        assert!(parse_date("2026-10-01T02:00:00", "from").is_err());
        assert!(
            date_range(&serde_json::json!({"from": "2026-10-02", "to": "2026-10-01"})).is_err()
        );
    }

    #[test]
    fn id_queries_are_only_ids() {
        assert_eq!(id_query("#12, 34"), Some(vec![12, 34]));
        assert_eq!(id_query("fix bug 1234"), None);
        assert_eq!(id_query("1 2 3 4 5 6"), None);
        assert_eq!(id_query("#"), None);
    }
}
