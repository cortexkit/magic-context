//! `ctx_search`: one query over the session's earlier messages, the
//! project's and workspace-shared memories, git commits and primers, and the session's notes.
//! Argument rules, scoring, ordering and the reply follow the TypeScript
//! tool (`tools/ctx-search` and `features/magic-context/search.ts`), so an
//! agent reads the same in both.
//!
//! A search runs in steps: [`by_ids`] answers a query of memory ids without
//! embedding anything; otherwise the caller embeds the query once (when
//! [`needs_embedding`]), [`prepare`] scores every lane with it and, for a
//! rerank, also keeps the candidates [`rerank`] scores, and [`finish`]
//! writes the reply. The caller makes the reranker's call between
//! [`prepare`] and [`finish`], without holding the store.

pub(crate) mod background;
pub mod messages;
pub mod rerank;
pub mod sources;
pub mod text;

#[cfg(test)]
mod hint_tests;

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::Value;

use messages::{DateRange, MessageHit};
use sources::{ChunkHit, CommitHit, MemoryHit, NoteHit, PrimerHit};

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 25;
/// A query of at most this many id-shaped tokens looks memories up by id.
const ID_QUERY_MAX_TOKENS: usize = 5;
const MEMORY_BOOST: f64 = 1.3;
const MESSAGE_BOOST: f64 = 1.275;
const GIT_COMMIT_BOOST: f64 = 1.2;
const PRIMER_BOOST: f64 = 1.25;
const SOURCES: [&str; 5] = ["memory", "message", "git_commit", "primer", "note"];
/// Reciprocal-rank constant for fusing message and summary hits.
const RRF_K: f64 = 60.0;
/// How deep a reranked search reads the message lane for its candidates.
const RERANK_MESSAGE_DEPTH: usize = 75;

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
    /// Without summaries, visibility follows the applied part edits rather
    /// than a single history boundary.
    pub visible_messages: Option<BTreeSet<i64>>,
    /// The memory text the model's view shows in full, by memory id. A
    /// memory whose current text it shows is left out of the results.
    pub seen: &'a BTreeMap<i64, String>,
    pub memory_enabled: bool,
    pub git_commits_enabled: bool,
    /// Whether the project folder holds a git repository.
    pub git_repository: Option<bool>,
    /// The query's embedding, when the session has an embedding provider and
    /// the endpoint answered.
    pub semantic: Option<sources::Semantic<'a>>,
}

/// What a [`Scope`] names, owned, so a search can run on a blocking thread.
/// The query's embedding is kept apart and lent to [`OwnedScope::scope`].
#[derive(Clone, Debug)]
pub struct OwnedScope {
    pub harness: String,
    pub session: String,
    pub project: Option<String>,
    pub cutoff: i64,
    pub visible_messages: Option<BTreeSet<i64>>,
    pub seen: BTreeMap<i64, String>,
    pub memory_enabled: bool,
    pub git_commits_enabled: bool,
    pub git_repository: Option<bool>,
}

impl OwnedScope {
    /// A copy of everything `scope` names but its embedding.
    pub fn of(scope: &Scope) -> Self {
        Self {
            harness: scope.harness.to_owned(),
            session: scope.session.to_owned(),
            project: scope.project.map(str::to_owned),
            cutoff: scope.cutoff,
            visible_messages: scope.visible_messages.clone(),
            seen: scope.seen.clone(),
            memory_enabled: scope.memory_enabled,
            git_commits_enabled: scope.git_commits_enabled,
            git_repository: scope.git_repository,
        }
    }

    /// The scope this names, with `semantic` as its query embedding.
    pub fn scope<'a>(&'a self, semantic: Option<sources::Semantic<'a>>) -> Scope<'a> {
        Scope {
            harness: &self.harness,
            session: &self.session,
            project: self.project.as_deref(),
            cutoff: self.cutoff,
            visible_messages: self.visible_messages.clone(),
            seen: &self.seen,
            memory_enabled: self.memory_enabled,
            git_commits_enabled: self.git_commits_enabled,
            git_repository: self.git_repository,
            semantic,
        }
    }
}

/// One search result, from whichever lane found it.
#[derive(Clone, Debug, PartialEq)]
pub enum Hit {
    Memory(MemoryHit),
    Message(MessageHit),
    Chunk(ChunkHit),
    Commit(CommitHit),
    Primer(PrimerHit),
    Note(NoteHit),
}

impl Hit {
    pub fn score(&self) -> f64 {
        match self {
            Hit::Memory(hit) => hit.score,
            Hit::Message(hit) => hit.score,
            Hit::Chunk(hit) => hit.score,
            Hit::Commit(hit) => hit.score,
            Hit::Primer(hit) => hit.score,
            Hit::Note(hit) => hit.score,
        }
    }

    fn boosted(&self) -> f64 {
        self.score()
            * match self {
                Hit::Memory(_) => MEMORY_BOOST,
                Hit::Message(_) | Hit::Chunk(_) => MESSAGE_BOOST,
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
        (Hit::Chunk(left), Hit::Chunk(right)) => left.start.cmp(&right.start),
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
    visibility_from_view: bool,
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
            "[{index}] [memory] score={:.2} id={} category={}{} match={}\n{}",
            hit.score,
            hit.id,
            hit.category,
            hit.source_name
                .as_ref()
                .map(|name| format!(" source={name}"))
                .unwrap_or_default(),
            hit.match_type,
            hit.content
        ),
        Hit::Commit(hit) => format!(
            "[{index}] [git_commit] score={:.2} sha={} {} match={}\n{}",
            hit.score,
            hit.short_sha,
            age(hit.committed_at, now),
            hit.match_type,
            hit.content
        ),
        Hit::Primer(hit) => format!(
            "[{index}] [primer] score={:.2} id={} support={} match={}\n{}",
            hit.score, hit.id, hit.support, hit.match_type, hit.content
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
        Hit::Chunk(hit) => format!(
            "[{index}] [message] score={:.2} compartment_id={} range={}-{} match={} title={}\n{}",
            hit.score,
            hit.compartment_id,
            hit.start,
            hit.end,
            hit.match_type,
            hit.title,
            match &hit.snippet {
                Some(snippet) => format!("Snippet: {snippet}"),
                None => text::preview(&hit.title),
            }
        ),
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
            "Message history: {count} raw-message {} {} (already in your context).",
            if count == 1 {
                "match is"
            } else {
                "matches are"
            },
            if diagnostics.visibility_from_view {
                "visible in the applied view"
            } else {
                "newer than the last compartment boundary"
            }
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
        parts.push("Use ctx_expand(start, end) with the range from any message result above to read the conversation context.".into());
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
/// `None` when no id names a current memory in the workspace pool.
fn memories_by_id(
    conn: &Connection,
    project: &str,
    ids: &[i64],
    limit: usize,
    visible: &BTreeSet<i64>,
    dates: Option<DateRange>,
    diagnostics: &mut Diagnostics,
) -> Option<Vec<Hit>> {
    let memories = sources::workspace_memories(conn, project).unwrap_or_default();
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
            source_name: memory.source_name.clone(),
            category: memory.category.clone(),
            content: text::preview(&memory.content),
            hint_content: memory.content.clone(),
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

/// A call's arguments, checked.
struct Request<'a> {
    query: &'a str,
    dates: Option<DateRange>,
    tool_limit: usize,
    /// The sources asked for; `None` means all.
    requested: Option<Vec<String>>,
}

impl Request<'_> {
    fn active(&self, source: &str) -> bool {
        self.requested
            .as_ref()
            .is_none_or(|list| list.iter().any(|known| known == source))
    }
}

fn parse(input: &Value) -> Result<Request<'_>, String> {
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
    let requested = input
        .get("sources")
        .and_then(Value::as_array)
        .and_then(|list| {
            if list.is_empty() {
                return None;
            }
            let mut seen: Vec<String> = Vec::new();
            for source in list.iter().filter_map(Value::as_str) {
                if SOURCES.contains(&source) && !seen.iter().any(|known| known == source) {
                    seen.push(source.to_owned());
                }
            }
            Some(seen)
        });
    Ok(Request {
        query,
        dates,
        tool_limit,
        requested,
    })
}

/// The memories whose current text the head shows.
fn visible_memories(conn: &Connection, project: &str, scope: &Scope) -> BTreeSet<i64> {
    sources::workspace_memories(conn, project)
        .unwrap_or_default()
        .iter()
        .filter(|memory| scope.seen.get(&memory.id) == Some(&memory.content))
        .map(|memory| memory.id)
        .collect()
}

/// The answer to a query made only of memory ids, or `None` when the query
/// is not one or names no current memory; then the full search runs.
pub fn by_ids(conn: &Connection, scope: &Scope, input: &Value) -> Option<Result<String, String>> {
    let request = match parse(input) {
        Ok(request) => request,
        Err(error) => return Some(Err(error)),
    };
    if !scope.memory_enabled {
        return None;
    }
    let ids = id_query(request.query)?;
    let project = scope.project?;
    let visible = visible_memories(conn, project, scope);
    let mut diagnostics = Diagnostics::default();
    let limit = request.tool_limit.max(ids.len());
    let found = memories_by_id(
        conn,
        project,
        &ids,
        limit,
        &visible,
        request.dates,
        &mut diagnostics,
    );
    (found.is_some() || !diagnostics.suppressed_visible.is_empty()).then(|| {
        Ok(format_results(
            request.query,
            &found.unwrap_or_default(),
            scope.session,
            &diagnostics,
        ))
    })
}

/// Whether a lane the call runs scores by meaning, so the query is worth
/// embedding. Invalid arguments need none: [`run`] refuses them.
pub fn needs_embedding(input: &Value, memory_enabled: bool, git_commits_enabled: bool) -> bool {
    parse(input).is_ok_and(|request| {
        request.active("message")
            || (memory_enabled && (request.active("memory") || request.active("primer")))
            || (git_commits_enabled && request.active("git_commit"))
    })
}

/// Fuse the message lane with the summary lane by reciprocal rank, as the
/// plugin does: a message inside a summary's range adds its rank to that
/// summary and lends it its text as the snippet, instead of being listed on
/// its own. Fusion only orders and trims; each hit keeps its own score.
fn fuse_history(messages: Vec<MessageHit>, chunks: Vec<ChunkHit>, limit: usize) -> Vec<Hit> {
    if chunks.is_empty() {
        return messages.into_iter().map(Hit::Message).collect();
    }
    if messages.is_empty() {
        return chunks.into_iter().map(Hit::Chunk).collect();
    }
    struct Fused {
        hit: Hit,
        score: f64,
        tie: i64,
        snippet_score: f64,
    }
    let mut fused: Vec<(String, Fused)> = Vec::new();
    fn add(fused: &mut Vec<(String, Fused)>, key: String, hit: Hit, score: f64, tie: i64) -> usize {
        if let Some(at) = fused.iter().position(|(known, _)| *known == key) {
            fused[at].1.score += score;
            return at;
        }
        fused.push((
            key,
            Fused {
                hit,
                score,
                tie,
                snippet_score: -1.0,
            },
        ));
        fused.len() - 1
    }
    for (rank, chunk) in chunks.iter().enumerate() {
        add(
            &mut fused,
            format!("compartment:{}", chunk.compartment_id),
            Hit::Chunk(chunk.clone()),
            1.0 / (RRF_K + rank as f64),
            chunk.start,
        );
    }
    for (rank, message) in messages.into_iter().enumerate() {
        let contribution = 1.0 / (RRF_K + rank as f64);
        let containing = chunks
            .iter()
            .find(|chunk| message.number >= chunk.start && message.number <= chunk.end);
        let Some(chunk) = containing else {
            let (key, tie) = (format!("message:{}", message.message_id), message.number);
            add(&mut fused, key, Hit::Message(message), contribution, tie);
            continue;
        };
        let at = add(
            &mut fused,
            format!("compartment:{}", chunk.compartment_id),
            Hit::Chunk(chunk.clone()),
            contribution,
            chunk.start,
        );
        let entry = &mut fused[at].1;
        if message.score > entry.snippet_score {
            if let Hit::Chunk(hit) = &mut entry.hit {
                entry.snippet_score = message.score;
                hit.match_type = "hybrid";
                hit.snippet = Some(message.content);
            }
        }
    }
    let mut ranked: Vec<Fused> = fused.into_iter().map(|(_, entry)| entry).collect();
    ranked.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.tie.cmp(&right.tie))
    });
    ranked.truncate(limit);
    ranked.into_iter().map(|entry| entry.hit).collect()
}

/// Every lane the request asks for, scored, ranked and cut to the request's
/// limit. An explicit search also uses literal probes and a relaxed query
/// for messages, and counts live matches for the reply; an automatic one
/// does neither.
fn collect(
    conn: &Connection,
    coverage: &mut messages::Coverage,
    scope: &Scope,
    request: &Request,
    explicit: bool,
    diagnostics: &mut Diagnostics,
    mut lanes: Option<&mut rerank::Lanes>,
) -> Result<Vec<Hit>, String> {
    let (query, dates) = (request.query, request.dates);
    let active = |source: &str| request.active(source);
    let project = scope.project;
    let visible = project
        .map(|project| visible_memories(conn, project, scope))
        .unwrap_or_default();
    let limit = request.tool_limit.clamp(1, MAX_LIMIT);
    let tier = (limit * 3).max(DEFAULT_LIMIT);
    let probes = if explicit {
        text::literal_probes(query)
    } else {
        Vec::new()
    };
    let wanted = messages::Query {
        text: query,
        limit: tier,
        probes: &probes,
        dates,
        visible: scope.visible_messages.as_ref(),
    };
    if active("git_commit") && scope.git_repository == Some(false) {
        diagnostics.no_git_repository = true;
    }
    // A rerank fuses at least the plugin's lane depth from each source.
    let lane_tier = if lanes.is_some() {
        tier.max(rerank::LANE_LIMIT)
    } else {
        tier
    };
    let mut hits: Vec<Hit> = Vec::new();
    if let Some(project) = project.filter(|_| active("memory") && scope.memory_enabled) {
        let mut halves = lanes.is_some().then(sources::Halves::default);
        let (found, suppressed) = sources::search_memories(
            conn,
            project,
            query,
            tier,
            &visible,
            dates,
            scope.semantic,
            halves.as_mut(),
        );
        diagnostics.suppressed_visible = suppressed;
        hits.extend(found.into_iter().map(Hit::Memory));
        if let (Some(lanes), Some(halves)) = (lanes.as_deref_mut(), halves) {
            lanes.memory_fts = halves.words.into_iter().map(Hit::Memory).collect();
            lanes.memory_vector = halves.meaning.into_iter().map(Hit::Memory).collect();
        }
    }
    if let Some(project) = project.filter(|_| active("primer") && scope.memory_enabled) {
        let mut halves = lanes.is_some().then(sources::Halves::default);
        hits.extend(
            sources::search_primers(
                conn,
                project,
                query,
                tier,
                dates,
                scope.semantic,
                halves.as_mut(),
            )
            .into_iter()
            .map(Hit::Primer),
        );
        if let (Some(lanes), Some(halves)) = (lanes.as_deref_mut(), halves) {
            lanes.primer_fts = halves.words.into_iter().map(Hit::Primer).collect();
            lanes.primer_vector = halves.meaning.into_iter().map(Hit::Primer).collect();
        }
    }
    if active("message") {
        let reach = messages::reach(conn, coverage, scope.session, dates);
        if explicit {
            diagnostics.live_message_matches = messages::count_live_matches(
                conn,
                scope.session,
                query,
                scope.cutoff,
                dates,
                scope.visible_messages.as_ref(),
                reach,
            );
            diagnostics.visibility_from_view = scope.visible_messages.is_some();
        }
        // A rerank also reads the message lane deeper, as the plugin's
        // capture limit does, so the baseline's own ranking is unchanged.
        // Both depths come from the same reads.
        let depths: &[usize] = if lanes.is_some() {
            &[tier, RERANK_MESSAGE_DEPTH]
        } else {
            &[tier]
        };
        let mut depths = messages::search_at(
            conn,
            scope.session,
            &wanted,
            depths,
            scope.cutoff,
            explicit,
            reach,
        )
        .into_iter();
        let found = depths.next().unwrap_or_default();
        let deeper = depths.next().unwrap_or_default();
        let chunks = match (scope.semantic, project) {
            (Some(semantic), Some(project)) => sources::search_chunks(
                conn,
                scope.session,
                project,
                lane_tier,
                scope.cutoff,
                dates,
                semantic,
            ),
            _ => Vec::new(),
        };
        if let Some(lanes) = lanes.as_deref_mut() {
            lanes.message_fts = deeper
                .into_iter()
                .take(rerank::LANE_LIMIT)
                .map(Hit::Message)
                .collect();
            lanes.chunk_vector = chunks
                .iter()
                .take(rerank::LANE_LIMIT)
                .cloned()
                .map(Hit::Chunk)
                .collect();
        }
        hits.extend(fuse_history(found, chunks, tier));
    }
    if let Some(project) = project.filter(|_| active("git_commit") && scope.git_commits_enabled) {
        let mut halves = lanes.is_some().then(sources::Halves::default);
        hits.extend(
            sources::search_commits(
                conn,
                project,
                query,
                tier,
                dates,
                scope.semantic,
                halves.as_mut(),
            )
            .into_iter()
            .map(Hit::Commit),
        );
        if let (Some(lanes), Some(halves)) = (lanes.as_deref_mut(), halves) {
            lanes.git_fts = halves.words.into_iter().map(Hit::Commit).collect();
            lanes.git_vector = halves.meaning.into_iter().map(Hit::Commit).collect();
        }
    }
    if active("note") {
        let notes_wanted = messages::Query {
            limit: lane_tier,
            ..wanted
        };
        let found =
            sources::search_notes(conn, scope.harness, scope.session, project, &notes_wanted);
        if let Some(lanes) = lanes {
            lanes.notes = found
                .iter()
                .take(rerank::LANE_LIMIT)
                .cloned()
                .map(Hit::Note)
                .collect();
        }
        hits.extend(found.into_iter().map(Hit::Note));
    }
    hits.sort_by(compare);
    hits.truncate(limit);
    Ok(hits)
}

/// A `ctx_search` call scored but not yet answered: its results, and for a
/// rerank the fused candidates with their documents.
pub struct Prepared {
    query: String,
    hits: Vec<Hit>,
    pool: Vec<Hit>,
    texts: Vec<String>,
    limit: usize,
    diagnostics: Diagnostics,
}

impl Prepared {
    /// The trimmed query.
    pub fn query(&self) -> &str {
        &self.query
    }

    /// The documents a reranker scores, one per candidate; empty when this
    /// search is not reranked or found nothing to rerank.
    pub fn candidates(&self) -> &[String] {
        &self.texts
    }

    /// Replace the results with the candidates in `scores`' order, best
    /// first, cut to the search's limit.
    pub fn reorder(&mut self, scores: &[f64]) {
        if scores.len() == self.pool.len() && !self.pool.is_empty() {
            self.hits = rerank::order(std::mem::take(&mut self.pool), scores, self.limit);
        }
    }
}

/// Score one `ctx_search` call over every lane. With `pool`, a reranker
/// will score up to that many fused candidates (see [`rerank`]). `coverage`
/// belongs to `conn` (see [`messages::Coverage`]).
pub fn prepare(
    conn: &Connection,
    coverage: &mut messages::Coverage,
    scope: &Scope,
    input: &Value,
    pool: Option<usize>,
) -> Result<Prepared, String> {
    let request = parse(input)?;
    let mut diagnostics = Diagnostics::default();
    let mut lanes = pool.map(|_| rerank::Lanes::default());
    let hits = collect(
        conn,
        coverage,
        scope,
        &request,
        true,
        &mut diagnostics,
        lanes.as_mut(),
    )?;
    let candidates: Vec<Hit> = match (&lanes, pool) {
        (Some(lanes), Some(size)) => rerank::fuse(lanes).into_iter().take(size).collect(),
        _ => Vec::new(),
    };
    let texts = match scope.project {
        Some(project) if !candidates.is_empty() => {
            rerank::candidate_texts(conn, scope.session, project, &candidates)
        }
        _ => Vec::new(),
    };
    Ok(Prepared {
        query: request.query.to_owned(),
        hits,
        pool: candidates,
        texts,
        limit: request.tool_limit.clamp(1, MAX_LIMIT),
        diagnostics,
    })
}

/// Count the memories the reply returns as retrieved, and write the reply.
pub fn finish(conn: &mut Connection, scope: &Scope, prepared: Prepared) -> String {
    let Prepared {
        query,
        hits,
        diagnostics,
        ..
    } = prepared;
    let returned: Vec<i64> = hits
        .iter()
        .filter_map(|hit| match hit {
            Hit::Memory(memory) => Some(memory.id),
            _ => None,
        })
        .collect();
    if let Err(error) = sources::count_retrievals(conn, &returned) {
        tracing::warn!(
            "ck-mc: session {}: counting memory retrievals failed: {error}",
            scope.session
        );
    }
    format_results(&query, &hits, scope.session, &diagnostics)
}

/// Run one `ctx_search` call over every lane without a rerank; a query of
/// memory ids is answered by [`by_ids`] first.
pub fn run(conn: &mut Connection, scope: &Scope, input: &Value) -> Result<String, String> {
    let prepared = prepare(conn, &mut messages::Coverage::default(), scope, input, None)?;
    Ok(finish(conn, scope, prepared))
}

/// The sources an automatic hint searches: memories, messages and git
/// commits, as the plugin's auto-search does; primers and notes are left to
/// an explicit `ctx_search`.
pub const AUTO_SOURCES: [&str; 3] = ["memory", "message", "git_commit"];

/// The hits an automatic memory hint is built from, for a person's prompt:
/// the plugin's auto-search, ten results over [`AUTO_SOURCES`], no literal
/// probes, and retrievals not counted. Each comes with the relevance the
/// hint threshold applies to: word overlap with the prompt for hits found
/// by words, the hit's own score for hits found by meaning.
pub fn auto_hits(
    conn: &Connection,
    coverage: &mut messages::Coverage,
    scope: &Scope,
    prompt: &str,
) -> Vec<(Hit, f64)> {
    let request = Request {
        query: prompt,
        dates: None,
        tool_limit: DEFAULT_LIMIT,
        requested: Some(
            AUTO_SOURCES
                .iter()
                .map(|source| (*source).to_owned())
                .collect(),
        ),
    };
    let mut diagnostics = Diagnostics::default();
    collect(
        conn,
        coverage,
        scope,
        &request,
        false,
        &mut diagnostics,
        None,
    )
    .unwrap_or_default()
    .into_iter()
    .map(|hit| {
        let relevance = hint_relevance(&hit, prompt);
        (hit, relevance)
    })
    .collect()
}

fn hint_relevance(hit: &Hit, prompt: &str) -> f64 {
    let (content, by_words) = match hit {
        Hit::Memory(hit) => (hit.hint_content.as_str(), hit.match_type != "semantic"),
        Hit::Message(hit) => (hit.content.as_str(), true),
        Hit::Chunk(hit) => (hit.title.as_str(), false),
        Hit::Commit(hit) => (hit.content.as_str(), hit.match_type != "semantic"),
        Hit::Primer(hit) => (hit.content.as_str(), hit.match_type != "semantic"),
        Hit::Note(hit) => (hit.content.as_str(), true),
    };
    if text::clean_search_text(content).is_empty() {
        0.0
    } else if by_words {
        text::hint_keyword_relevance(prompt, content)
    } else {
        hit.score()
    }
}

/// The `<ctx-search-hint>` block for the hits that reach `threshold`, most
/// relevant first, at most three fragments of about 80 characters, each
/// compressed to its gist so it reads as a vague recall that invites a
/// `ctx_search` rather than an answer. `None` when nothing qualifies.
pub fn build_hint(hits: Vec<(Hit, f64)>, threshold: f64, prompt: &str, now: i64) -> Option<String> {
    const MAX_FRAGMENTS: usize = 3;
    const FRAGMENT_CHARS: usize = 80;
    const MAX_HINT_CHARS: usize = 800;
    let mut chosen: Vec<(Hit, f64)> = hits
        .into_iter()
        .filter(|(_, relevance)| *relevance >= threshold)
        .collect();
    // Stable, so fragments of equal relevance keep the search's order.
    chosen.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let ultra = |text: &str| {
        crate::caveman::compress(
            &text::clean_search_text(text),
            crate::caveman::CavemanLevel::Ultra,
        )
    };
    let lines: Vec<String> = chosen
        .iter()
        .take(MAX_FRAGMENTS)
        .map(|(hit, _)| match hit {
            Hit::Commit(hit) => {
                let subject = text::clean_search_text(hit.content.lines().next().unwrap_or(""));
                format!(
                    "commit {} {}: {}",
                    hit.short_sha,
                    age(hit.committed_at, now),
                    truncate(&subject, FRAGMENT_CHARS.saturating_sub(20).max(10))
                )
            }
            Hit::Message(hit) => truncate(
                &crate::caveman::compress(
                    &text::matched_snippet(&hit.content, prompt, FRAGMENT_CHARS),
                    crate::caveman::CavemanLevel::Ultra,
                ),
                FRAGMENT_CHARS,
            ),
            Hit::Chunk(hit) => truncate(&ultra(&hit.title), FRAGMENT_CHARS),
            Hit::Memory(hit) => truncate(&ultra(&hit.content), FRAGMENT_CHARS),
            Hit::Primer(hit) => truncate(&ultra(&hit.content), FRAGMENT_CHARS),
            Hit::Note(hit) => truncate(&ultra(&hit.content), FRAGMENT_CHARS),
        })
        .filter(|fragment| !fragment.is_empty())
        .map(|fragment| format!("- {fragment}"))
        .collect();
    if lines.is_empty() {
        return None;
    }
    let header = if lines.len() == 1 {
        "Your memory may contain 1 related fragment:".to_owned()
    } else {
        format!("Your memory may contain {} related fragments:", lines.len())
    };
    let footer = "If the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.";
    let body = std::iter::once(header)
        .chain(lines)
        .chain(std::iter::once(footer.to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let wrapped = format!("<ctx-search-hint>\n{body}\n</ctx-search-hint>");
    let length = text::utf16_len(&wrapped);
    if length <= MAX_HINT_CHARS {
        return Some(wrapped);
    }
    // Cut the body's tail, keeping the wrapper.
    let keep = text::utf16_len(&body).saturating_sub(length - MAX_HINT_CHARS + 1);
    let trimmed = text::utf16_prefix(&body, keep);
    Some(format!(
        "<ctx-search-hint>\n{}…\n</ctx-search-hint>",
        trimmed.trim_end()
    ))
}

/// Collapse whitespace and cut to `limit` UTF-16 units with an ellipsis.
fn truncate(text: &str, limit: usize) -> String {
    let normalized = text::collapse_whitespace(text);
    if text::utf16_len(&normalized) <= limit {
        return normalized;
    }
    format!(
        "{}…",
        text::utf16_prefix(&normalized, limit.saturating_sub(1)).trim_end()
    )
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
