//! A project-history scope for frozen lab databases. Ordinary search still
//! reads only its own session and hides messages already in the model's view.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{messages, sources, text, Hit, Request, Scope, DEFAULT_LIMIT, MAX_LIMIT};

pub(crate) struct History {
    sessions: Vec<String>,
    scan: Mutex<Scan>,
}

struct Scan {
    coverage: messages::Coverage,
    ambiguous: BTreeMap<String, bool>,
}

impl History {
    pub(crate) fn load(
        conn: &Connection,
        project: &str,
        selected: Option<&[String]>,
    ) -> Result<Self, String> {
        let mut query = conn
            .prepare(
                "SELECT DISTINCT p.session_id FROM session_projects p
              WHERE p.project_path = ?1
              ORDER BY p.session_id",
            )
            .map_err(show)?;
        let all = query
            .query_map([project], |row| row.get::<_, String>(0))
            .map_err(show)?
            .collect::<rusqlite::Result<BTreeSet<_>>>()
            .map_err(show)?;
        let sessions = match selected {
            Some(selected) => {
                if let Some(unknown) = selected.iter().find(|id| !all.contains(*id)) {
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
            None => all.into_iter().collect(),
        };
        let mut coverage = messages::Coverage::default();
        // The backing connection is immutable. Reuse the check for rows that
        // lack a map entry, rather than rescreening the frozen index every query.
        coverage.for_snapshot(0);
        Ok(Self {
            sessions,
            scan: Mutex::new(Scan {
                coverage,
                ambiguous: BTreeMap::new(),
            }),
        })
    }

    pub(crate) fn search(
        &self,
        conn: &Connection,
        project: &str,
        input: &Value,
        semantic: Option<sources::Semantic<'_>>,
    ) -> Result<String, String> {
        let request = super::parse(input)?;
        let ceiling = request.tool_limit.clamp(1, MAX_LIMIT);
        let depth = (ceiling * 3).max(DEFAULT_LIMIT);
        let scope = Scope {
            harness: "magic-context",
            session: "",
            project: Some(project),
            workspace: None,
            cutoff: i64::MAX,
            visible_messages: None,
            seen: &BTreeMap::new(),
            memory_enabled: true,
            git_commits_enabled: true,
            git_repository: Some(true),
            semantic,
        };
        let mut diagnostics = super::Diagnostics::default();
        if request.active("memory") {
            if let Some(ids) = super::id_query(request.query) {
                if let Some(hits) = super::memories_by_id(
                    conn,
                    scope.memory_owners(),
                    &ids,
                    ceiling.max(ids.len()),
                    &BTreeSet::new(),
                    request.dates,
                    &mut diagnostics,
                ) {
                    return render(
                        conn,
                        request.query,
                        hits.into_iter().map(|hit| (hit, None)),
                        project,
                    );
                }
            }
        }
        let mut scan = self.scan.lock().expect("lab history coverage");
        let owner_request = Request {
            requested: Some(
                ["memory", "git_commit"]
                    .into_iter()
                    .filter(|source| request.active(source))
                    .map(str::to_owned)
                    .collect(),
            ),
            ..request
        };
        let hits = super::collect(
            conn,
            &mut scan.coverage,
            &scope,
            &owner_request,
            true,
            &mut diagnostics,
            None,
            &mut crate::tool_timing::Stamps::default(),
        )?;
        let mut ranked: Vec<(Hit, Option<&str>)> =
            hits.into_iter().map(|hit| (hit, None)).collect();
        let mut skipped = 0;
        if request.active("message") {
            let probes = text::literal_probes(request.query);
            let query = messages::Query {
                text: request.query,
                limit: depth,
                probes: &probes,
                dates: request.dates,
                visible: None,
            };
            for session in &self.sessions {
                let ambiguous = match scan.ambiguous.get(session) {
                    Some(ambiguous) => *ambiguous,
                    None => {
                        let ambiguous = raw_is_ambiguous(conn, project, session)?;
                        scan.ambiguous.insert(session.clone(), ambiguous);
                        ambiguous
                    }
                };
                let raw = if ambiguous {
                    skipped += 1;
                    Vec::new()
                } else {
                    let reach = messages::reach(conn, &mut scan.coverage, session, request.dates);
                    messages::search_at(conn, session, &query, &[depth], i64::MAX, true, &reach)
                        .pop()
                        .unwrap_or_default()
                };
                let mut summaries = lexical_summaries(conn, project, session, &query)?;
                if let Some(semantic) = semantic {
                    let semantic = sources::search_chunks_in_project(
                        conn,
                        session,
                        project,
                        depth,
                        request.dates,
                        semantic,
                    );
                    for hit in semantic {
                        if let Some(prior) = summaries
                            .iter_mut()
                            .find(|prior| prior.compartment_id == hit.compartment_id)
                        {
                            prior.score = prior.score.max(hit.score);
                            prior.match_type = "lexical+semantic";
                        } else {
                            summaries.push(hit);
                        }
                    }
                }
                summaries.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.start.cmp(&b.start)));
                ranked.extend(
                    super::fuse_history(raw, summaries, depth)
                        .into_iter()
                        .map(|hit| (hit, Some(session.as_str()))),
                );
                ranked.sort_by(|a, b| super::compare(&a.0, &b.0).then(a.1.cmp(&b.1)));
                ranked.truncate(depth);
            }
        }
        ranked.sort_by(|a, b| super::compare(&a.0, &b.0).then(a.1.cmp(&b.1)));
        ranked.truncate(ceiling);
        let reply = render(conn, request.query, ranked, project)?;
        if skipped == 0 {
            Ok(reply)
        } else {
            Ok(format!(
                "{skipped} sessions skipped: ambiguous id\n\n{reply}"
            ))
        }
    }
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

fn lexical_summaries(
    conn: &Connection,
    project: &str,
    session: &str,
    query: &messages::Query<'_>,
) -> Result<Vec<sources::ChunkHit>, String> {
    // Compartments have an index by session and are much fewer than raw
    // messages. Stream only the selected session's summaries, keeping top hits.
    let mut statement = conn
        .prepare_cached(
            "SELECT c.id, c.title, c.start_message, c.end_message, c.content, c.p1
               FROM compartments c
               JOIN session_projects p ON p.session_id = c.session_id AND p.harness = c.harness
              WHERE c.session_id = ?1 AND p.project_path = ?2 AND c.created_at BETWEEN ?3 AND ?4",
        )
        .map_err(show)?;
    let (from, to) = query
        .dates
        .map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    let mut rows = statement
        .query(params![session, project, from, to])
        .map_err(show)?;
    let mut hits: Vec<sources::ChunkHit> = Vec::new();
    while let Some(row) = rows.next().map_err(show)? {
        let title: String = row.get(1).map_err(show)?;
        let content: String = row.get(4).map_err(show)?;
        let detail: Option<String> = row.get(5).map_err(show)?;
        let (score, matched) = [
            title.as_str(),
            content.as_str(),
            detail.as_deref().unwrap_or(""),
        ]
        .into_iter()
        .map(|candidate| (text::keyword_relevance(query.text, candidate), candidate))
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .expect("summary text");
        if score <= 0.0 {
            continue;
        }
        let snippet = Some(text::matched_snippet(matched, query.text, 400));
        let (start, end) = (row.get(2).map_err(show)?, row.get(3).map_err(show)?);
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
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.start.cmp(&b.start)));
        hits.truncate(query.limit);
    }
    Ok(hits)
}

fn render<'a>(
    conn: &Connection,
    query: &str,
    hits: impl IntoIterator<Item = (Hit, Option<&'a str>)>,
    project: &str,
) -> Result<String, String> {
    let mut blocks = Vec::new();
    let now = crate::memory_writes::now_ms();
    for (index, (hit, session)) in hits.into_iter().enumerate() {
        let mut reference = String::new();
        let date = match &hit {
            Hit::Memory(hit) => conn
                .query_row(
                    "SELECT created_at FROM memories WHERE id = ?1 AND owner_id = ?2",
                    params![hit.id, project],
                    |row| row.get(0),
                )
                .optional()
                .map_err(show)?,
            Hit::Commit(hit) => Some(hit.committed_at),
            Hit::Message(hit) => {
                let id = session.expect("message has a session");
                reference = format!(" session={id} ref={id}:{}", hit.number);
                conn.query_row("SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id = ?1 AND message_ordinal = ?2",
                    params![id, hit.number], |row| row.get::<_, Option<i64>>(0)).optional().map_err(show)?.flatten()
            }
            Hit::Chunk(hit) => {
                let id = session.expect("summary has a session");
                reference = format!(" session={id} ref={id}:{}-{}", hit.start, hit.end);
                conn.query_row(
                    "SELECT created_at FROM compartments WHERE id = ?1 AND session_id = ?2",
                    params![hit.compartment_id, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(show)?
            }
            _ => unreachable!("only lab sources were collected"),
        };
        let date = date
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map_or_else(|| "unknown".into(), |date| date.to_rfc3339());
        let block = super::format_hit(&hit, index + 1, session.unwrap_or(""), now);
        let (head, text) = block.split_once('\n').unwrap_or((&block, ""));
        blocks.push(format!("{head} date={date}{reference}\n{text}"));
    }
    if blocks.is_empty() {
        return Ok(format!("No results for {query:?}."));
    }
    Ok(blocks.join("\n\n"))
}

fn show(error: rusqlite::Error) -> String {
    format!("searching frozen history: {error}")
}
