//! A project-history scope for frozen lab databases. Ordinary search still
//! reads only its own session and hides messages already in the model's view.

use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{messages, rerank, sources, text, Hit};

// Bound the relevance ranking before sorting by date so newest stays about the subject.
const NEWEST_RANK_LIMIT: usize = 30;

pub(crate) fn memory_search(
    conn: &Connection,
    project: &str,
    input: &Value,
    semantic: Option<sources::Semantic<'_>>,
) -> Result<String, String> {
    let query = checked_query("memory_search", input, &[])?;
    let limit = limit(input, 10, 20);
    let mut by_id = conn
        .prepare_cached(
            "SELECT id, category, status = 'archived', created_at, importance, content
           FROM memories WHERE level = 'project' AND owner_id = ?1 AND id = ?2
            AND (status = 'archived' OR (status IN ('active','permanent')
                 AND (expires_at IS NULL OR expires_at > ?3)))",
        )
        .map_err(show)?;
    let now = crate::memory_writes::now_ms();
    let mut lookup = |id| {
        by_id
            .query_row(params![project, id, now], Memory::read)
            .optional()
            .map_err(show)
    };
    if let Some(ids) = super::id_query(query) {
        let mut hits = Vec::new();
        for id in ids {
            hits.extend(lookup(id)?);
        }
        if !hits.is_empty() {
            hits.sort_by_key(|hit| hit.archived);
            hits.truncate(limit);
            return Ok(render_memories(hits, query));
        }
    }

    let owners = sources::MemoryOwners {
        project: Some(project),
        workspace: None,
    };
    let (active, _) = sources::search_memories(
        conn,
        owners,
        query,
        limit,
        &BTreeSet::new(),
        None,
        semantic,
        None,
    );
    let mut hits = Vec::new();
    for hit in active {
        hits.extend(lookup(hit.id)?);
    }
    let remaining = limit - hits.len();
    if remaining > 0 {
        hits.extend(archived_matches(conn, project, query, remaining)?);
    }
    Ok(render_memories(hits, query))
}

struct Memory {
    id: i64,
    category: String,
    archived: bool,
    created: i64,
    importance: Option<i64>,
    content: String,
}

impl Memory {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            category: row.get(1)?,
            archived: row.get(2)?,
            created: row.get(3)?,
            importance: row.get(4)?,
            content: row.get(5)?,
        })
    }
}

fn archived_matches(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<Memory>, String> {
    // Archiving can remove embeddings, but the full-text index retains the
    // retired text. Keep its full-text ranking behind the current memories.
    let mut statement = conn.prepare_cached(
        "SELECT m.id, m.category, 1, m.created_at, m.importance, m.content
           FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
          WHERE m.level = 'project' AND m.owner_id = ?1 AND m.status = 'archived' AND memories_fts MATCH ?2
          ORDER BY bm25(memories_fts), m.updated_at DESC, m.id ASC LIMIT ?3",
    ).map_err(show)?;
    let mut read = |fts: String| {
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        let rows = statement.query_map(params![project, fts, limit as i64], Memory::read)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    };
    let strict = read(text::sanitize_fts_query(query)).map_err(show)?;
    if strict.is_empty() {
        read(text::relaxed_fts_query(query)).map_err(show)
    } else {
        Ok(strict)
    }
}

fn render_memories(hits: Vec<Memory>, query: &str) -> String {
    if hits.is_empty() {
        return format!("No results for {query:?}.");
    }
    hits.into_iter().enumerate().map(|(index, hit)| {
        let status = if hit.archived { "archived" } else { "active" };
        let importance = hit.importance.map_or_else(|| "unset".into(), |n| n.to_string());
        let date = format_date(Some(hit.created));
        let content = hit.content.char_indices().nth(600).map_or_else(
            || hit.content.clone(),
            |(end, _)| format!("{}…", &hit.content[..end]),
        );
        format!("[{}] [memory] id={} category={} status={status} date={date} importance={importance}\n{content}",
            index + 1, hit.id, hit.category)
    }).collect::<Vec<_>>().join("\n\n")
}

fn checked_query<'a>(tool: &str, input: &'a Value, extra: &[&str]) -> Result<&'a str, String> {
    let object = input
        .as_object()
        .ok_or_else(|| format!("{tool} expects an object"))?;
    if let Some(key) = object
        .keys()
        .find(|key| !matches!(key.as_str(), "query" | "limit") && !extra.contains(&key.as_str()))
    {
        return Err(format!("{tool} does not accept {key:?}"));
    }
    input["query"]
        .as_str()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .ok_or_else(|| "Error: 'query' is required.".into())
}

fn limit(input: &Value, default: usize, max: usize) -> usize {
    input["limit"]
        .as_f64()
        .filter(|limit| limit.is_finite() && *limit != 0.0)
        .map_or(default, |limit| (limit as usize).clamp(1, max))
}

pub(crate) struct History {
    project: String,
    sessions: Vec<HistorySession>,
    skipped_session_ids: usize,
    coverage: Mutex<messages::Coverage>,
}

struct HistorySession {
    id: String,
    ambiguous: bool,
    times: IndexedTimes,
}

impl HistorySession {
    fn load(conn: &Connection, project: &str, id: String) -> Result<Self, String> {
        let ambiguous = raw_is_ambiguous(conn, project, &id)?;
        // Two hosts (OpenCode and Pi, say) can each have a session with this
        // ID. The message-time map is keyed by session ID alone, so it cannot
        // say which host's message a timestamp belongs to.
        let times = if ambiguous {
            IndexedTimes::default()
        } else {
            IndexedTimes::load(conn, &id)?
        };
        Ok(Self {
            id,
            ambiguous,
            times,
        })
    }
}

impl History {
    pub(crate) fn load(
        conn: &Connection,
        project: &str,
        selected: Option<&[String]>,
    ) -> Result<Self, String> {
        let mut query = conn
            .prepare(
                "SELECT session_id, COUNT(DISTINCT harness) FROM session_projects
                  WHERE project_path = ?1 GROUP BY session_id",
            )
            .map_err(show)?;
        let all = query
            .query_map([project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(show)?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()
            .map_err(show)?;
        let mut sessions: Vec<_> = match selected {
            Some(selected) => {
                if let Some(unknown) = selected.iter().find(|id| !all.contains_key(*id)) {
                    return Err(format!(
                        "history session {unknown:?} does not belong to project {project:?}"
                    ));
                }
                selected
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            }
            None => all.keys().cloned().collect(),
        };
        // A history hit is cited by its session id and a position in that
        // session, with no harness in it. When two harnesses in this project
        // share one session id, such a citation is ambiguous, so the id is
        // left out of the search and counted.
        let selected_count = sessions.len();
        sessions.retain(|id| all[id] == 1);
        let skipped_session_ids = selected_count - sessions.len();
        let sessions = sessions
            .into_iter()
            .map(|id| HistorySession::load(conn, project, id))
            .collect::<Result<_, _>>()?;
        let mut coverage = messages::Coverage::default();
        // Message search first screens the index for rows that have no entry
        // in the row-id map, which costs a pass over the whole index. The
        // store copy never changes, so do that pass once and reuse its
        // result for every later query of this run.
        coverage.for_snapshot(0);
        Ok(Self {
            project: project.to_owned(),
            skipped_session_ids,
            sessions,
            coverage: Mutex::new(coverage),
        })
    }

    pub(crate) fn skipped_session_ids(&self) -> usize {
        self.skipped_session_ids
    }

    #[cfg(test)]
    pub(crate) fn search(
        &self,
        conn: &Connection,
        input: &Value,
        semantic: Option<sources::Semantic<'_>>,
    ) -> Result<String, String> {
        self.prepare(conn, input, semantic, None, false)
            .map(PreparedHistory::render)
    }

    pub(crate) fn prepare(
        &self,
        conn: &Connection,
        input: &Value,
        semantic: Option<sources::Semantic<'_>>,
        rerank_pool: Option<usize>,
        summaries_only: bool,
    ) -> Result<PreparedHistory, String> {
        let query = checked_query(
            "history_search",
            input,
            &["from", "to", "include_agent", "order"],
        )?;
        let newest = match input.get("order") {
            None => false,
            Some(order) => match order.as_str() {
                Some("relevance") => false,
                Some("newest") => true,
                _ => return Err("history_search order must be relevance or newest".into()),
            },
        };
        let dates = super::date_range(input)?;
        let rerank_pool = rerank_pool.filter(|_| !newest);
        let multiplier = limit(input, 1, 3);
        let limit = 4 * multiplier;
        let depth = (limit * 3).max(super::DEFAULT_LIMIT);
        let depth = if newest {
            depth.max(NEWEST_RANK_LIMIT)
        } else if rerank_pool.is_some() {
            depth.max(rerank::LANE_LIMIT)
        } else {
            depth
        };
        let summary_query = SummaryQuery {
            query,
            limit: depth,
            dates,
            semantic,
            newest,
        };
        let include_agent = input["include_agent"].as_bool().unwrap_or(false);
        let project = &self.project;
        let mut people = Vec::new();
        let mut agents = Vec::new();
        let mut summaries = Vec::new();
        let mut skipped = self.skipped_session_ids;
        let mut coverage = self.coverage.lock().expect("lab history coverage");
        let probes = text::literal_probes(query);
        for session in &self.sessions {
            if session.ambiguous {
                skipped += 1;
            } else if !summaries_only {
                let reach = messages::reach(conn, &mut coverage, &session.id, dates);
                let raw = messages::Query {
                    text: query,
                    limit: depth,
                    probes: &probes,
                    dates,
                    visible: None,
                };
                people.extend(raw_hits(
                    conn,
                    session,
                    &raw,
                    &reach,
                    messages::LabRole::Person,
                )?);
                if include_agent {
                    agents.extend(raw_hits(
                        conn,
                        session,
                        &raw,
                        &reach,
                        messages::LabRole::Agent,
                    )?);
                }
            }
            summaries.extend(summary_hits(conn, project, session, &summary_query)?);
        }
        drop(coverage);
        rank_across_sessions(&mut summaries, newest);
        rank_across_sessions(&mut people, newest);
        rank_across_sessions(&mut agents, newest);
        let commit_limit = 3 * multiplier;
        let mut halves = rerank_pool.is_some().then(sources::Halves::default);
        let mut commits = if summaries_only {
            Vec::new()
        } else {
            sources::ranked_commits(
                conn,
                project,
                query,
                depth,
                dates,
                semantic,
                halves.as_mut(),
            )
        };
        if newest {
            newest_first(&mut summaries, |hit| hit.date.last_day());
            newest_first(&mut people, |hit| hit.date.end());
            newest_first(&mut agents, |hit| hit.date.end());
            newest_first(&mut commits, |hit| hit.committed_at);
        }
        let keep = |page: usize| page.max(rerank_pool.unwrap_or(0));
        summaries.truncate(keep(limit));
        people.truncate(keep(limit));
        agents.truncate(keep(limit));
        commits.truncate(keep(commit_limit));
        for hit in &mut summaries {
            if let Hit::Chunk(chunk) = &mut hit.hit {
                if chunk.snippet.is_none() {
                    let body = summary_body(conn, chunk.compartment_id)?;
                    let snippet = text::matched_snippet(&body, query, 400);
                    chunk.snippet = Some(if snippet.is_empty() {
                        char_prefix(&body, 400).0.to_owned()
                    } else {
                        snippet
                    });
                }
            }
        }
        let mut groups = vec![Group::new("Summaries", limit, summaries)];
        if !summaries_only {
            groups.push(Group::new("The person's messages", limit, people));
            groups.push(Group::new(
                "Commits",
                commit_limit,
                commits.into_iter().map(Evidence::commit).collect(),
            ));
            if let Some(halves) = halves {
                groups[2].rerank_candidates = rerank::fuse(&rerank::Lanes {
                    git_fts: halves.words.into_iter().map(Hit::Commit).collect(),
                    git_vector: halves.meaning.into_iter().map(Hit::Commit).collect(),
                    ..Default::default()
                })
                .into_iter()
                .map(|hit| match hit {
                    Hit::Commit(hit) => Evidence::commit(hit),
                    _ => unreachable!("only commits were fused"),
                })
                .collect();
            }
            if include_agent {
                groups.push(Group::new("Agent messages", limit, agents));
            }
        }
        if let Some(pool) = rerank_pool {
            for group in &mut groups {
                if group.rerank_candidates.is_empty() {
                    group.rerank_candidates = group.hits.iter().take(pool).cloned().collect();
                } else {
                    group.rerank_candidates.truncate(pool);
                }
                group.documents = group
                    .rerank_candidates
                    .iter()
                    .map(|hit| {
                        let session = hit.session.as_deref().unwrap_or("");
                        if let Hit::Chunk(chunk) = &hit.hit {
                            let location = format!(
                                "compartment {} {session} @{}-{}",
                                chunk.compartment_id, chunk.start, chunk.end
                            );
                            let body = summary_body(conn, chunk.compartment_id)?;
                            Ok(rerank::candidate_text(&location, &chunk.title, &body))
                        } else {
                            Ok(rerank::candidate_texts(
                                conn,
                                session,
                                project,
                                std::slice::from_ref(&hit.hit),
                            )
                            .pop()
                            .expect("one hit yields one document"))
                        }
                    })
                    .collect::<Result<_, String>>()?;
            }
        }
        Ok(PreparedHistory { skipped, groups })
    }
}

pub(crate) struct PreparedHistory {
    skipped: usize,
    pub(crate) groups: Vec<Group>,
}

impl PreparedHistory {
    pub(crate) fn render(self) -> String {
        let mut groups = Vec::new();
        if self.skipped != 0 {
            groups.push(format!("{} sessions skipped: ambiguous id", self.skipped));
        }
        let now = crate::memory_writes::now_ms();
        for group in self.groups {
            groups.push(render_group(
                group.title,
                group.hits.into_iter().take(group.limit),
                now,
            ));
        }
        groups.join("\n\n")
    }

    pub(crate) fn render_two_summaries(mut self) -> String {
        self.groups[0].limit = 2;
        self.render()
    }
}

pub(crate) struct Group {
    title: &'static str,
    limit: usize,
    hits: Vec<Evidence>,
    rerank_candidates: Vec<Evidence>,
    pub(crate) documents: Vec<String>,
}

impl Group {
    fn new(title: &'static str, limit: usize, hits: Vec<Evidence>) -> Self {
        Self {
            title,
            limit,
            hits,
            rerank_candidates: Vec::new(),
            documents: Vec::new(),
        }
    }

    pub(crate) fn reorder(&mut self, scores: &[f64]) {
        if scores.len() != self.rerank_candidates.len() || scores.is_empty() {
            return;
        }
        let mut ranked: Vec<_> = scores
            .iter()
            .copied()
            .zip(std::mem::take(&mut self.rerank_candidates))
            .collect();
        // Equal scores retain the candidates' existing order. A small configured pool only
        // reorders its candidates, never removes the group's other results.
        ranked.sort_by(|(left, _), (right, _)| right.partial_cmp(left).unwrap_or(Ordering::Equal));
        let keys: BTreeSet<_> = ranked.iter().map(|(_, hit)| hit.identity()).collect();
        self.hits.retain(|hit| !keys.contains(&hit.identity()));
        self.hits
            .splice(..0, ranked.into_iter().map(|(_, hit)| hit));
    }
}

fn newest_first<T, D: Ord>(hits: &mut Vec<T>, date: impl Fn(&T) -> D) {
    hits.truncate(NEWEST_RANK_LIMIT);
    // Stable sorting keeps the existing rank order for equal dates.
    hits.sort_by_key(|hit| Reverse(date(hit)));
}

fn raw_is_ambiguous(conn: &Connection, project: &str, session: &str) -> Result<bool, String> {
    // Raw message indexes cannot separate harnesses. Inspect the indexed
    // records for this id once per frozen copy, even when a second harness has
    // its own evidence but has not been entered in the project map.
    conn.query_row(
        "WITH mapped AS (SELECT harness FROM session_projects WHERE session_id=?1 AND project_path=?2)
         SELECT EXISTS(SELECT 1 FROM session_projects WHERE session_id=?1 AND project_path<>?2)
             OR EXISTS(SELECT 1 FROM compartments WHERE session_id=?1 AND harness NOT IN mapped)
             OR EXISTS(SELECT 1 FROM message_history_index WHERE session_id=?1 AND harness NOT IN mapped)
             OR EXISTS(SELECT 1 FROM message_history_source WHERE session_id=?1 AND harness NOT IN mapped)",
        params![session, project], |row| row.get(0),
    ).map_err(show)
}

fn raw_hits(
    conn: &Connection,
    session: &HistorySession,
    query: &messages::Query<'_>,
    reach: &messages::Reach,
    role: messages::LabRole,
) -> Result<Vec<Evidence>, String> {
    let list = messages::search_at_with_role(
        conn,
        &session.id,
        query,
        &[query.limit],
        i64::MAX,
        true,
        reach,
        Some(role),
    )
    .pop()
    .unwrap_or_default();
    let mut times = conn.prepare_cached("SELECT m.message_time_ms FROM message_fts_rowid_map m
        JOIN message_history_fts f ON f.rowid = m.fts_rowid
        WHERE m.session_id = ?1 AND m.message_ordinal = ?2 AND f.session_id = ?1 AND f.message_id = ?3").map_err(show)?;
    list.into_iter()
        .enumerate()
        .map(|(rank, hit)| {
            Ok(Evidence {
                date: EvidenceDate::Instant(
                    times
                        .query_row(params![session.id, hit.number, hit.message_id], |row| {
                            row.get(0)
                        })
                        .optional()
                        .map_err(show)?
                        .flatten(),
                ),
                order: hit.number,
                rank: contribution(rank),
                session: Some(session.id.clone()),
                hit: Hit::Message(hit),
            })
        })
        .collect()
}
#[derive(Clone, Copy)]
struct SummaryRange {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

impl SummaryRange {
    fn render(self) -> String {
        let start = self.start.date_naive();
        let end = self.end.date_naive();
        if start == end {
            start.to_string()
        } else {
            format!("{start}..{end}")
        }
    }
}

#[derive(Default)]
struct IndexedTimes(Vec<(i64, DateTime<Utc>)>);

impl IndexedTimes {
    fn load(conn: &Connection, session: &str) -> Result<Self, String> {
        // The frozen store never changes during the run. Read the usable times
        // once, in ordinal order, for all later summary searches in this session.
        let mut statement = conn
            .prepare_cached(
                "SELECT message_ordinal, message_time_ms FROM message_fts_rowid_map
                  WHERE session_id = ?1 AND message_time_ms > 0 ORDER BY message_ordinal",
            )
            .map_err(show)?;
        let mut rows = statement.query([session]).map_err(show)?;
        let mut times = Vec::new();
        while let Some(row) = rows.next().map_err(show)? {
            if let Some(time) = DateTime::from_timestamp_millis(row.get(1).map_err(show)?) {
                times.push((row.get(0).map_err(show)?, time));
            }
        }
        Ok(Self(times))
    }

    fn inside(&self, start: i64, end: i64) -> (usize, &[(i64, DateTime<Utc>)]) {
        let first = self.0.partition_point(|(ordinal, _)| *ordinal < start);
        let rest = &self.0[first..];
        let inside = rest.partition_point(|(ordinal, _)| *ordinal <= end);
        (first, &rest[..inside])
    }

    fn range(&self, start: i64, end: i64) -> Option<SummaryRange> {
        let (first, inside) = self.inside(start, end);
        if let (Some(first), Some(last)) = (inside.first(), inside.last()) {
            return Some(SummaryRange {
                start: first.1,
                end: last.1,
            });
        }
        // A gap in the text index still belongs to the session's timeline.
        // Prefer the last timed message before it; use the next one if the gap
        // starts before any indexed time.
        let (_, time) = *self.0.get(first.saturating_sub(1))?;
        Some(SummaryRange {
            start: time,
            end: time,
        })
    }

    fn matches(&self, start: i64, end: i64, bounds: Option<messages::DateRange>) -> bool {
        bounds.is_none_or(|bounds| {
            self.range(start, end).is_some_and(|range| {
                range.start.timestamp_millis() <= bounds.to
                    && range.end.timestamp_millis() >= bounds.from
            })
        })
    }
}

pub(crate) struct Timeline {
    session: String,
    summaries: Vec<Summary>,
}

pub(crate) struct Summary {
    id: i64,
    start: i64,
    end: i64,
    title: String,
    days: Option<SummaryRange>,
    message_times: Option<(i64, i64)>,
}

impl Timeline {
    /// The summaries of one session, for a reference a memory or a search hit
    /// gives. A reference names a session and message numbers but not the host
    /// program (OpenCode, Pi, a runner) the session ran under, and two hosts
    /// can use the same session id. When the project has that id under more
    /// than one host, nothing is returned: reading one host's history for
    /// another's reference would be a wrong answer that looks right.
    pub(crate) fn load(
        conn: &Connection,
        project: &str,
        session: &str,
    ) -> Result<Option<Self>, String> {
        Self::load_mapped(conn, project, session, true)
    }

    fn load_mapped(
        conn: &Connection,
        project: &str,
        session: &str,
        for_origin: bool,
    ) -> Result<Option<Self>, String> {
        let mapped: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT harness) FROM session_projects
              WHERE project_path = ?1 AND session_id = ?2",
                params![project, session],
                |row| row.get(0),
            )
            .map_err(show)?;
        if mapped != 1 {
            return Ok(None);
        }
        let ambiguous = raw_is_ambiguous(conn, project, session)?;
        if ambiguous && for_origin {
            return Ok(None);
        }
        let times = if ambiguous {
            IndexedTimes::default()
        } else {
            IndexedTimes::load(conn, session)?
        };
        let mut statement = conn
            .prepare_cached(
                "SELECT c.id, c.start_message, c.end_message, c.title FROM compartments c
              JOIN session_projects p ON p.session_id = c.session_id AND p.harness = c.harness
              WHERE c.session_id = ?1 AND p.project_path = ?2
              ORDER BY c.start_message, c.end_message, c.id",
            )
            .map_err(show)?;
        let summaries = statement
            .query_map(params![session, project], |row| {
                let (start, end) = (row.get(1)?, row.get(2)?);
                let (_, inside) = times.inside(start, end);
                let message_times = inside.iter().map(|(_, time)| time.timestamp_millis()).fold(
                    None::<(i64, i64)>,
                    |range, time| {
                        Some(range.map_or((time, time), |(first, last)| {
                            (first.min(time), last.max(time))
                        }))
                    },
                );
                Ok(Summary {
                    id: row.get(0)?,
                    start,
                    end,
                    title: row.get(3)?,
                    days: times.range(start, end),
                    message_times,
                })
            })
            .map_err(show)?
            .collect::<rusqlite::Result<_>>()
            .map_err(show)?;
        Ok(Some(Self {
            session: session.to_owned(),
            summaries,
        }))
    }

    pub(crate) fn origin(&self, spans: &[(i64, i64)], created: i64) -> Option<Origin> {
        let valid = || {
            spans
                .iter()
                .copied()
                .filter(|&(start, end)| start >= 0 && end >= start)
        };
        let covers = |start, end| {
            self.summaries
                .iter()
                .find(|s| s.start <= start && end <= s.end)
        };
        let all = valid()
            .map(|(start, _)| start)
            .min()
            .zip(valid().map(|(_, end)| end).max());
        let (summary, later) =
            if let Some(summary) = all.and_then(|(start, end)| covers(start, end)) {
                (summary, false)
            } else if let Some(summary) = valid().find_map(|(start, end)| covers(start, end)) {
                (summary, true)
            } else if let Some(summary) = self.summaries.iter().find(|s| {
                s.message_times
                    .is_some_and(|(start, end)| start <= created && created <= end)
            }) {
                (summary, false)
            } else {
                let earlier = self
                    .summaries
                    .iter()
                    .filter_map(|s| {
                        let (_, end) = s.message_times?;
                        (end < created).then_some((end, s))
                    })
                    .max_by_key(|&(end, s)| (end, s.start, s.id))?
                    .1;
                (earlier, false)
            };
        Some(Origin {
            id: summary.id,
            label: summary.label(&self.session),
            later,
        })
    }
}

pub(crate) struct Origin {
    id: i64,
    label: String,
    later: bool,
}

impl Origin {
    pub(crate) fn label(&self) -> String {
        format!(
            "{}{}",
            self.label,
            if self.later { " and later" } else { "" }
        )
    }

    pub(crate) fn render(&self, conn: &Connection) -> Result<String, String> {
        let body = summary_body(conn, self.id)?;
        let (body, cut) = char_prefix(&body, 4_000);
        Ok(format!(
            "{}\n{body}{}",
            self.label(),
            if cut {
                "\n[origin text cut at 4,000 characters; use history_read for the rest]"
            } else {
                ""
            }
        ))
    }
}

impl Summary {
    fn reference(&self, session: &str) -> String {
        format!("{session}:{}-{}", self.start, self.end)
    }

    fn label(&self, session: &str) -> String {
        let days = self
            .days
            .map_or_else(|| "unknown".to_owned(), SummaryRange::render);
        format!(
            "ref={} date={days} title={}",
            self.reference(session),
            self.title.replace(['\r', '\n'], " ")
        )
    }

    fn dates_match(&self, dates: messages::DateRange) -> bool {
        self.days.is_some_and(|range| {
            range.start.timestamp_millis() <= dates.to && range.end.timestamp_millis() >= dates.from
        })
    }
}

fn summary_body(conn: &Connection, id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT COALESCE(NULLIF(p1, ''), content) FROM compartments WHERE id = ?1",
        [id],
        |row| row.get(0),
    )
    .map_err(show)
}

fn char_prefix(text: &str, limit: usize) -> (&str, bool) {
    match text.char_indices().nth(limit) {
        Some((end, _)) => (&text[..end], true),
        None => (text, false),
    }
}

pub(crate) fn history_read(
    conn: &Connection,
    project: &str,
    input: &Value,
) -> Result<String, String> {
    const SHAPE: &str =
        "history_read needs a ref (optionally with offset), or session, from and to";
    let object = input.as_object().ok_or(SHAPE)?;
    let (session, exact, offset, dates) = if let Some(reference) = object.get("ref") {
        if object.keys().any(|key| key != "ref" && key != "offset") {
            return Err(SHAPE.into());
        }
        let parse_ref = || {
            let (session, range) = reference.as_str()?.rsplit_once(':')?;
            let (start, end) = range.split_once('-')?;
            let (start, end) = (start.parse::<i64>().ok()?, end.parse::<i64>().ok()?);
            (!session.is_empty() && start >= 0 && start <= end).then_some((session, (start, end)))
        };
        let (session, range) =
            parse_ref().ok_or("history_read ref must be <session>:<start>-<end>")?;
        let offset = match object.get("offset") {
            None => 0,
            Some(value) => value
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or("history_read offset must be a non-negative integer")?,
        };
        (session, Some(range), offset, None)
    } else {
        if object.len() != 3 || !input["from"].is_string() || !input["to"].is_string() {
            return Err(SHAPE.into());
        }
        let session = input["session"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(SHAPE)?;
        (session, None, 0, super::date_range(input)?)
    };
    let timeline = Timeline::load_mapped(conn, project, session, false)?.ok_or_else(|| {
        format!("history_read session {session:?} does not belong to this project with an unambiguous id")
    })?;
    let matches = timeline
        .summaries
        .iter()
        .filter(|s| {
            exact.is_none_or(|range| (s.start, s.end) == range)
                && dates.is_none_or(|range| s.dates_match(range))
        })
        .collect::<Vec<_>>();
    if exact.is_some() && matches.len() > 1 {
        return Err("history_read ref matches multiple stored summaries".into());
    }
    render_read(conn, session, &matches, offset)
}

fn render_read(
    conn: &Connection,
    session: &str,
    matches: &[&Summary],
    offset: usize,
) -> Result<String, String> {
    const CAP: usize = 16_000;
    let more = |shown: usize| {
        matches.get(shown).map_or_else(String::new, |next| {
            format!(
                "\n\n{} more summaries match. Next: history_read {}",
                matches.len() - shown,
                serde_json::json!({"ref":next.reference(session)})
            )
        })
    };
    let mut answer = String::new();
    for (index, summary) in matches.iter().take(3).enumerate() {
        let header = format!(
            "{}{}\n",
            if index == 0 { "" } else { "\n\n" },
            summary.label(session)
        );
        let body = summary_body(conn, summary.id)?;
        let start = if offset == 0 {
            0
        } else {
            body.char_indices()
                .nth(offset)
                .ok_or("history_read offset is past the end of the summary")?
                .0
        };
        let body = &body[start..];
        let tail = more(index + 1);
        let room = CAP
            .saturating_sub(answer.chars().count() + header.chars().count() + tail.chars().count());
        let (_, too_long) = char_prefix(body, room);
        if !too_long && room != 0 {
            answer.push_str(&header);
            answer.push_str(body);
        } else if index != 0 {
            answer.push_str(&more(index));
            return Ok(answer);
        } else {
            let next = |at| {
                format!(
                    "\n\nContinue this summary: history_read {}",
                    serde_json::json!({"ref":summary.reference(session), "offset":at})
                )
            };
            let room = room.saturating_sub(next(offset.saturating_add(CAP)).chars().count());
            if room == 0 {
                return Err("history_read reference or title is too long to fit".into());
            }
            let (prefix, _) = char_prefix(body, room);
            let cut = prefix
                .char_indices()
                .rev()
                .take(200)
                .find_map(|(i, c)| matches!(c, '\n' | '.' | '!' | '?').then_some(i + c.len_utf8()))
                .unwrap_or(prefix.len());
            let prefix = &prefix[..cut];
            return Ok(format!(
                "{header}{prefix}{}{tail}",
                next(offset + prefix.chars().count())
            ));
        }
    }
    if answer.is_empty() {
        Ok("No summaries match.".into())
    } else {
        answer.push_str(&more(matches.len().min(3)));
        Ok(answer)
    }
}

struct SummaryQuery<'a> {
    query: &'a str,
    limit: usize,
    dates: Option<messages::DateRange>,
    semantic: Option<sources::Semantic<'a>>,
    newest: bool,
}

fn summary_hits(
    conn: &Connection,
    project: &str,
    session: &HistorySession,
    query: &SummaryQuery<'_>,
) -> Result<Vec<Evidence>, String> {
    let SummaryQuery {
        query,
        limit,
        dates,
        semantic,
        newest,
    } = *query;
    if dates.is_some() && session.times.0.is_empty() {
        return Ok(Vec::new());
    }
    // Both candidate lists are capped per session. A same-score summary must
    // survive that cut before the project-wide ranking can consider its date.
    let by_date = |a: &sources::ChunkHit, b: &sources::ChunkHit| {
        let last_day = |hit: &sources::ChunkHit| {
            EvidenceDate::Range(session.times.range(hit.start, hit.end)).last_day()
        };
        last_day(b).cmp(&last_day(a))
    };
    let tie = newest.then_some(&by_date as sources::ChunkTie<'_>);
    let (words, excluded) = lexical_summaries(conn, project, session, query, limit, dates, tie)?;
    let meaning = semantic.map_or_else(Vec::new, |semantic| {
        // The shared search would require exact boundary times. Filter by the
        // lab's ranges instead, allowing one extra slot per excluded summary.
        sources::search_chunks_in_project(
            conn,
            &session.id,
            project,
            limit + excluded,
            None,
            semantic,
            tie,
        )
        .into_iter()
        .filter(|hit| session.times.matches(hit.start, hit.end, dates))
        .take(limit)
        .collect()
    });
    let mut fused = BTreeMap::<_, (sources::ChunkHit, f64)>::new();
    for lane in [meaning, words] {
        for (rank, hit) in lane.into_iter().enumerate() {
            let weight = contribution(rank);
            let slot = fused.entry(hit.compartment_id);
            match slot {
                std::collections::btree_map::Entry::Occupied(mut slot) => {
                    let (prior, score) = slot.get_mut();
                    *score += weight;
                    prior.snippet = hit.snippet;
                    prior.match_type = "lexical+semantic";
                }
                std::collections::btree_map::Entry::Vacant(slot) => {
                    slot.insert((hit, weight));
                }
            }
        }
    }
    Ok(fused
        .into_values()
        .map(|(hit, rank)| Evidence {
            date: EvidenceDate::Range(session.times.range(hit.start, hit.end)),
            order: hit.start,
            rank,
            hit: Hit::Chunk(hit),
            session: Some(session.id.clone()),
        })
        .collect())
}

fn lexical_summaries(
    conn: &Connection,
    project: &str,
    session: &HistorySession,
    query: &str,
    limit: usize,
    dates: Option<messages::DateRange>,
    tie: Option<sources::ChunkTie<'_>>,
) -> Result<(Vec<sources::ChunkHit>, usize), String> {
    // Compartments have an index by session and are much fewer than raw
    // messages. Stream only the selected session's summaries, keeping top hits.
    let mut statement = conn
        .prepare_cached(
            "SELECT c.id, c.title, c.start_message, c.end_message, c.content, c.p1
               FROM compartments c
               JOIN session_projects p ON p.session_id = c.session_id AND p.harness = c.harness
              WHERE c.session_id = ?1 AND p.project_path = ?2",
        )
        .map_err(show)?;
    let mut rows = statement
        .query(params![session.id, project])
        .map_err(show)?;
    let mut hits: Vec<sources::ChunkHit> = Vec::new();
    let mut excluded = 0;
    while let Some(row) = rows.next().map_err(show)? {
        let (start, end) = (row.get(2).map_err(show)?, row.get(3).map_err(show)?);
        if !session.times.matches(start, end, dates) {
            excluded += 1;
            continue;
        }
        let title: String = row.get(1).map_err(show)?;
        let content: String = row.get(4).map_err(show)?;
        let detail: Option<String> = row.get(5).map_err(show)?;
        let (score, matched) = [
            title.as_str(),
            content.as_str(),
            detail.as_deref().unwrap_or(""),
        ]
        .into_iter()
        .map(|candidate| (text::keyword_relevance(query, candidate), candidate))
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .expect("summary text");
        if score <= 0.0 {
            continue;
        }
        let snippet = Some(text::matched_snippet(matched, query, 400));
        hits.push(sources::ChunkHit {
            compartment_id: row.get(0).map_err(show)?,
            title,
            start,
            end,
            window: (start, end),
            score,
            match_type: "lexical",
            snippet,
        });
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| tie.map_or(Ordering::Equal, |tie| tie(a, b)))
                .then(a.start.cmp(&b.start))
                .then(a.compartment_id.cmp(&b.compartment_id))
        });
        hits.truncate(limit);
    }
    Ok((hits, excluded))
}

#[derive(Clone)]
struct Evidence {
    hit: Hit,
    session: Option<String>,
    date: EvidenceDate,
    order: i64,
    rank: f64,
}

#[derive(Clone, Copy)]
enum EvidenceDate {
    Instant(Option<i64>),
    Range(Option<SummaryRange>),
}

impl EvidenceDate {
    fn last_day(&self) -> Option<chrono::NaiveDate> {
        match self {
            Self::Range(range) => range.map(|range| range.end.date_naive()),
            Self::Instant(at) => at
                .and_then(DateTime::from_timestamp_millis)
                .map(|at| at.date_naive()),
        }
    }

    fn end(&self) -> Option<i64> {
        match self {
            Self::Instant(at) => *at,
            Self::Range(range) => range.map(|range| range.end.timestamp_millis()),
        }
    }
}

impl Evidence {
    fn commit(hit: sources::CommitHit) -> Self {
        Self {
            date: EvidenceDate::Instant(Some(hit.committed_at)),
            hit: Hit::Commit(hit),
            session: None,
            order: 0,
            rank: 0.0,
        }
    }

    fn identity(&self) -> (Option<String>, String) {
        let key = match &self.hit {
            Hit::Message(hit) => format!("message:{}", hit.number),
            _ => rerank::key(&self.hit),
        };
        (self.session.clone(), key)
    }

    fn render(self, index: usize, now: i64) -> String {
        let session = self.session.as_deref().unwrap_or("");
        let reference = match &self.hit {
            Hit::Commit(hit) => format!(" ref={}", hit.sha),
            Hit::Message(hit) => {
                format!(" session={session} ref={session}:{}", hit.number)
            }
            Hit::Chunk(hit) => {
                format!(" session={session} ref={session}:{}-{}", hit.start, hit.end)
            }
            _ => unreachable!("only history sources were collected"),
        };
        let date = match self.date {
            EvidenceDate::Instant(at) => format_date(at),
            EvidenceDate::Range(range) => {
                range.map_or_else(|| "unknown".to_owned(), SummaryRange::render)
            }
        };
        let block = super::format_hit(&self.hit, index, session, now);
        let (head, text) = block.split_once('\n').unwrap_or((&block, ""));
        format!("{head} date={date}{reference}\n{text}")
    }
}

fn contribution(rank: usize) -> f64 {
    1.0 / (super::RRF_K + rank as f64)
}

fn rank_across_sessions(hits: &mut Vec<Evidence>, newest: bool) {
    hits.sort_by(|a, b| b.rank.total_cmp(&a.rank)
        .then_with(|| {
            if newest {
                if matches!(&a.hit, Hit::Chunk(_)) {
                    b.date.last_day().cmp(&a.date.last_day())
                } else {
                    b.date.end().cmp(&a.date.end())
                }
            } else { Ordering::Equal }
        })
        // A meaning hit wins a tie with a word-only hit at the same rank.
        .then_with(|| {
            let semantic = |hit: &Evidence| matches!(&hit.hit, Hit::Chunk(chunk) if chunk.match_type != "lexical");
            semantic(b).cmp(&semantic(a))
        })
        .then_with(|| a.order.cmp(&b.order))
        .then_with(|| a.session.cmp(&b.session)));
    let mut seen = BTreeSet::new();
    hits.retain(|hit| seen.insert(hit.identity()));
}

fn render_group(title: &str, hits: impl Iterator<Item = Evidence>, now: i64) -> String {
    let blocks: Vec<_> = hits
        .enumerate()
        .map(|(n, hit)| hit.render(n + 1, now))
        .collect();
    if blocks.is_empty() {
        format!("## {title}\nnone")
    } else {
        format!("## {title}\n{}", blocks.join("\n\n"))
    }
}

fn format_date(at: Option<i64>) -> String {
    at.and_then(chrono::DateTime::from_timestamp_millis)
        .map_or_else(|| "unknown".into(), |date| date.to_rfc3339())
}

fn show(error: rusqlite::Error) -> String {
    format!("searching frozen store: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_prefers_recent_summaries_at_both_score_cutoffs() {
        let start = DateTime::parse_from_rfc3339("2026-10-25T01:00:00Z")
            .unwrap()
            .timestamp_millis();
        let vector = [1.0, 0.0];
        for split_sessions in [false, true] {
            let conn = crate::context_db::ContextDb::fresh_in_memory();
            for n in 1..=40 {
                let session = if split_sessions {
                    format!("session-{n:02}")
                } else {
                    "one-session".into()
                };
                if split_sessions || n == 1 {
                    conn.execute(
                        "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                         VALUES (?1, 'mock', 'p', 1)",
                        [&session],
                    )
                    .unwrap();
                }
                conn.execute(
                    "INSERT INTO compartments (id, session_id, harness, sequence, start_message, end_message, title, content, created_at)
                     VALUES (?1, ?2, 'mock', ?1, ?1, ?1, 'Monthly review', 'reviewterm', 1)",
                    params![n, session],
                ).unwrap();
                conn.execute(
                    "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                     VALUES (?1, ?2, ?2, ?3)",
                    params![session, n, start + (n - 1) * 30 / 39 * 86_400_000],
                ).unwrap();
                conn.execute(
                    "INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness,
                         window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                     VALUES (?1, ?2, 'p', 'mock', 0, ?1, ?1, 'hash', 'model', 2, ?3, 1)",
                    params![n, session, crate::embedding::encode(&vector)],
                ).unwrap();
            }
            let history = History::load(&conn, "p", None).unwrap();
            let semantic = sources::Semantic {
                vector: &vector,
                model_id: "model",
                chunk_model_id: "model",
            };
            for (query, semantic, kind) in [
                ("reviewterm", None, "lexical"),
                ("anotherterm", Some(semantic), "semantic"),
            ] {
                let search = |order| {
                    history.search(
                    &conn,
                    &serde_json::json!({"query":query,"from":"2026-10-25","to":"2026-11-24","order":order}),
                    semantic,
                ).unwrap()
                };
                let ids = |answer: &str| {
                    answer
                        .lines()
                        .filter_map(|line| {
                            let (_, fields) = line.split_once("score=0.80 compartment_id=")?;
                            assert!(line.contains(&format!("match={kind}")), "{line}");
                            Some(
                                fields
                                    .split_whitespace()
                                    .next()
                                    .unwrap()
                                    .parse::<i64>()
                                    .unwrap(),
                            )
                        })
                        .collect::<Vec<_>>()
                };
                let relevant = search("relevance");
                let newest = search("newest");
                assert_eq!(ids(&relevant), [1, 2, 3, 4], "{relevant}");
                assert_eq!(ids(&newest), [40, 39, 38, 37], "{newest}");
                println!(
                    "split_sessions={split_sessions} {kind}: relevance {:?}; newest {:?}",
                    ids(&relevant),
                    ids(&newest)
                );
            }
        }
    }

    #[test]
    fn summary_dates_filter_semantic_hits_before_the_result_limit() {
        let conn = crate::context_db::ContextDb::fresh_in_memory();
        conn.execute(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('s', 'mock', 'p', 1)",
            [],
        )
        .unwrap();
        let vector = [1.0, 0.0];
        for sequence in 1..=5 {
            let start = sequence * 3;
            let end = start + 2;
            conn.execute(
                "INSERT INTO compartments (id, session_id, harness, sequence, start_message, end_message, title, content, created_at)
                 VALUES (?1, 's', 'mock', ?1, ?2, ?3, 'Routine debugging', 'Summary.', 2000000000000)",
                params![sequence, start, end],
            ).unwrap();
            conn.execute(
                "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                 VALUES ('s', ?1, ?1, ?2)",
                params![start + 1, if sequence <= 4 { 1000 } else { 86_401_000 }],
            ).unwrap();
            conn.execute(
                "INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness,
                     window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                 VALUES (?1, 's', 'p', 'mock', 0, ?2, ?3, 'hash', 'model', 2, ?4, 1)",
                params![sequence, start, end, crate::embedding::encode(&vector)],
            ).unwrap();
        }
        let history = History::load(&conn, "p", None).unwrap();
        let semantic = sources::Semantic {
            vector: &vector,
            model_id: "model",
            chunk_model_id: "model",
        };
        let expected = [1, 2, 3, 4].map(|id| sources::ChunkHit {
            compartment_id: id,
            title: "Routine debugging".into(),
            start: id * 3,
            end: id * 3 + 2,
            window: (id * 3, id * 3 + 2),
            score: 0.8,
            match_type: "semantic",
            snippet: None,
        });
        assert_eq!(
            sources::search_chunks(&conn, "s", "p", 4, i64::MAX, None, semantic),
            expected,
            "ordinary summary search must still prefer lower ordinals on a score tie"
        );
        assert_eq!(
            sources::search_chunks_in_project(&conn, "s", "p", 4, None, semantic, None),
            expected,
            "lab summary search with no date tie-break must also keep its original rank"
        );
        let answer = history
            .search(
                &conn,
                &serde_json::json!({"query":"unrelatedterm", "from":"1970-01-02"}),
                Some(semantic),
            )
            .unwrap();
        assert_eq!(answer.matches("compartment_id=").count(), 1, "{answer}");
        assert!(answer.contains("match=semantic"), "{answer}");
        assert!(
            answer.contains("date=1970-01-02 session=s ref=s:15-17"),
            "{answer}"
        );
    }

    #[test]
    fn raw_history_can_find_an_unmapped_legacy_index_row_without_a_date_bound() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::context_db::ContextDb::create_for_tests(&temp.path().join("context.db"))
            .unwrap();
        db.with_connection(|conn| {
            conn.execute_batch(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                     VALUES ('legacy', 'opencode', 'p', 1);
                 INSERT INTO message_history_index (session_id, harness, last_indexed_ordinal, updated_at)
                     VALUES ('legacy', 'opencode', 9, 1);
                 INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                     VALUES ('legacy', 9, 'legacy-id', 'user', 'unmappedterm legacy text');",
            ).unwrap();
            let history = History::load(conn, "p", None).unwrap();
            let undated = history.search(conn, &serde_json::json!({"query":"unmappedterm"}), None).unwrap();
            assert!(undated.contains("date=unknown session=legacy ref=legacy:9"), "{undated}");
            let dated = history.search(conn, &serde_json::json!({"query":"unmappedterm", "from":"1970-01-01"}), None).unwrap();
            assert!(dated.contains("## The person's messages\nnone"), "{dated}");
        });
    }
}
