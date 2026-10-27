//! Lexical search replies over the same retrieval lanes used by agents.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "wired by the app read dispatcher")
)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::HashMap,
    time::{Duration, Instant},
};
use subc_client_rs::HandlerOutcome;

use crate::parity_contract::*;
use crate::retrieval::{
    hybrid::{DateBounds, MemoryFtsHit, SearchMemory},
    note_ranking::{self, NoteHit, NoteRow, NoteStatus, NoteType},
};
use crate::retrieval_store::{LexicalRead, ReadContext, RetrievalStore};

use super::{
    agent_ids, envelope,
    locator::{self, SessionRef},
};

const SOURCES: [&str; 5] = ["memory", "message", "git_commit", "primer", "note"];
const OPEN: char = '\u{e000}';
const CLOSE: char = '\u{e001}';

const SESSION_PROJECT: &str =
    "SELECT project_path FROM session_projects WHERE session_id=?1 AND harness=?2";
const PROJECT_SESSIONS: &str = "SELECT session_id,harness FROM session_projects WHERE project_path=?1 ORDER BY session_id,harness";
const PROJECT_MEMORY: &str = "SELECT id FROM memories WHERE project_path=?1 LIMIT 1";
const RANGES: &str = "SELECT id,sequence,start_message,end_message FROM compartments WHERE session_id=?1 ORDER BY sequence";
const MEMORY: &str = "SELECT m.id,m.category,m.content,m.updated_at,bm25(memories_fts),highlight(memories_fts,0,char(57344),char(57345)) FROM memories_fts JOIN memories m ON m.id=memories_fts.rowid WHERE memories_fts MATCH ?1 AND m.project_path=?2 AND m.status IN ('active','permanent') AND (m.expires_at IS NULL OR m.expires_at>?3) AND (?4 IS NULL OR m.updated_at>=?4) AND (?5 IS NULL OR m.updated_at<=?5) ORDER BY bm25(memories_fts),m.updated_at DESC,m.id LIMIT ?6";
const MESSAGE: &str = "SELECT f.rowid,f.message_id,f.message_ordinal,f.role,f.content,m.message_time_ms,highlight(message_history_fts,4,char(57344),char(57345)),f.session_id FROM message_history_fts f JOIN message_fts_rowid_map m ON m.session_id=f.session_id AND m.fts_rowid=f.rowid WHERE f.session_id IN (SELECT value FROM json_each(?1)) AND message_history_fts MATCH ?2 AND (?3 IS NULL OR m.message_time_ms>=?3) AND (?4 IS NULL OR m.message_time_ms<=?4) ORDER BY bm25(message_history_fts),f.message_ordinal,f.rowid LIMIT ?5";
const NOTES: &str = "SELECT id,status,content,updated_at,anchor_ordinal FROM notes WHERE session_id=?1 AND type='session' AND status='active' AND (?2 IS NULL OR updated_at>=?2) AND (?3 IS NULL OR updated_at<=?3) ORDER BY updated_at DESC,id";
const COMMIT: &str = "SELECT g.committed_at,highlight(git_commits_fts,2,char(57344),char(57345)) FROM git_commits_fts JOIN git_commits g ON g.sha=git_commits_fts.sha WHERE git_commits_fts MATCH ?1 AND g.sha=?2 AND g.project_path=?3 LIMIT 1";
const COMMIT_ROW: &str =
    "SELECT committed_at,message FROM git_commits WHERE sha=?1 AND project_path=?2";

#[derive(Clone)]
struct Target {
    key: String,
    session: SessionRef,
    project_source: &'static str,
}

struct Metadata {
    target: Option<Target>,
    message_id: Option<String>,
    ordinal: Option<i64>,
    role: Option<String>,
    at: Option<i64>,
    marked: String,
    reference: Value,
}

struct Snapshot<'a> {
    context: &'a Connection,
    params: &'a Params,
    targets: Vec<Target>,
    project: Option<String>,
    now: i64,
    started: Instant,
    metadata: RefCell<HashMap<String, Metadata>>,
    memory_ranks: RefCell<Vec<MemoryFtsHit>>,
}

impl ReadContext for Snapshot<'_> {
    fn context_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        if self.started.elapsed() >= Duration::from_millis(250) {
            return Err("search deadline".into());
        }
        read(self.context).map_err(|e| e.to_string())
    }
    fn lexical(&self) -> Option<&dyn LexicalRead> {
        Some(self)
    }
}

fn available<T>(result: Result<T, String>) -> CapabilityResult<T> {
    match result {
        Ok(value) => CapabilityResult::Available { value },
        Err(message) => CapabilityResult::Unavailable {
            reason: CapabilityReason {
                code: "search_source_unavailable".into(),
                message,
            },
        },
    }
}

fn read_before_deadline<T>(
    snapshot: &Snapshot<'_>,
    read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<Option<T>, HandlerOutcome> {
    match snapshot.context_read(read) {
        Ok(value) => Ok(Some(value)),
        Err(_) if snapshot.started.elapsed() >= Duration::from_millis(250) => Ok(None),
        Err(error) => Err(locator::store_error(error)),
    }
}

impl LexicalRead for Snapshot<'_> {
    fn limit(&self) -> usize {
        self.params.limit * 4
    }
    fn git_page_limit(&self) -> usize {
        self.params.limit
    }

    fn memories(
        &self,
        _scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>> {
        available(self.context_read(|conn| {
            let Some(project) = &self.project else {
                return Ok(Vec::new());
            };
            let query = crate::retrieval_store::fts_query(&self.params.query);
            let mut statement = conn.prepare(MEMORY)?;
            let mut memories = Vec::new();
            let mut rows = statement.query(params![
                query,
                project,
                self.now,
                dates.from_ms,
                dates.to_ms,
                self.limit()
            ])?;
            while let Some(r) = rows.next()? {
                let id: i64 = r.get(0)?;
                let category: String = r.get(1)?;
                let content: String = r.get(2)?;
                let at = r.get(3)?;
                self.memory_ranks.borrow_mut().push(MemoryFtsHit {
                    memory_id: id,
                    bm25: r.get(4)?,
                });
                self.metadata.borrow_mut().insert(
                    format!("memory:{id}"),
                    Metadata {
                        target: None,
                        message_id: None,
                        ordinal: None,
                        role: None,
                        at: Some(at),
                        marked: r.get(5)?,
                        reference: json!({"memory_id":id,"category":category}),
                    },
                );
                memories.push(SearchMemory {
                    id,
                    category,
                    content,
                    created_at_ms: at,
                    source_name: None,
                });
            }
            Ok(memories)
        }))
    }

    fn memory_fts(&self) -> CapabilityResult<Vec<MemoryFtsHit>> {
        CapabilityResult::Available {
            value: self.memory_ranks.borrow().clone(),
        }
    }

    fn messages(
        &self,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<mc_store::archive_index::FtsRow>> {
        available(self.context_read(|conn| {
            let query = format!(
                "content : ({})",
                crate::retrieval_store::fts_query(&self.params.query)
            );
            let targets = self
                .targets
                .iter()
                .map(|t| (t.key.as_str(), t))
                .collect::<HashMap<_, _>>();
            let sessions =
                serde_json::to_string(&self.targets.iter().map(|t| &t.key).collect::<Vec<_>>())
                    .unwrap();
            let mut found = Vec::new();
            let mut statement = conn.prepare(MESSAGE)?;
            let mut rows = statement.query(params![
                sessions,
                query,
                dates.from_ms,
                dates.to_ms,
                self.limit()
            ])?;
            while let Some(r) = rows.next()? {
                let id = r.get::<_, i64>(0)?.to_string();
                let ordinal = r.get(2)?;
                let role: String = r.get(3)?;
                let session: String = r.get(7)?;
                let target = targets[session.as_str()];
                self.metadata.borrow_mut().insert(
                    format!("message:{id}"),
                    Metadata {
                        target: Some(target.clone()),
                        message_id: Some(r.get(1)?),
                        ordinal: Some(ordinal),
                        role: Some(role.clone()),
                        at: r.get(5)?,
                        marked: r.get(6)?,
                        reference: Value::Null,
                    },
                );
                found.push(mc_store::archive_index::FtsRow {
                    id,
                    ordinal,
                    role,
                    content: r.get(4)?,
                    created_at_ms: r.get(5)?,
                });
            }
            Ok(found)
        }))
    }

    fn notes(
        &self,
        scope: &StoreScope,
        request: &RetrievalRequest,
        probes: &[String],
        limit: usize,
    ) -> CapabilityResult<(Vec<NoteHit>, Vec<NoteRow>)> {
        available(self.context_read(|conn| {
            let mut notes = Vec::new();
            let mut hits = Vec::new();
            for target in &self.targets {
                let mut statement = conn.prepare(NOTES)?;
                let rows = statement
                    .query_map(
                        params![target.key, request.start_at_ms, request.end_at_ms_inclusive],
                        |r| {
                            Ok(NoteRow {
                                id: r.get(0)?,
                                note_type: NoteType::Session,
                                status: NoteStatus::Active,
                                content: r.get(2)?,
                                session_id: Some(target.key.clone()),
                                project_path: Some(scope.project.0.clone()),
                                surface_condition: None,
                                ready_reason: None,
                                created_at: r.get(3)?,
                                anchor_ordinal: r.get(4)?,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                hits.extend(note_ranking::rank_notes(
                    &rows,
                    &target.key,
                    &scope.project.0,
                    &request.query,
                    probes,
                    DateBounds {
                        from_ms: request.start_at_ms,
                        to_ms: request.end_at_ms_inclusive,
                    },
                    limit.min(self.limit()),
                ));
                for row in &rows {
                    self.metadata.borrow_mut().insert(
                        format!("note:{}", row.id),
                        Metadata {
                            target: Some(target.clone()),
                            message_id: None,
                            ordinal: row.anchor_ordinal,
                            role: None,
                            at: Some(row.created_at),
                            marked: literal_highlight(&row.content, &request.query),
                            reference: json!({"note_id":row.id}),
                        },
                    );
                }
                notes.extend(rows);
            }
            hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.note_id.cmp(&b.note_id)));
            hits.truncate(self.limit());
            Ok((hits, notes))
        }))
    }
}

#[derive(Debug)]
struct Params {
    query: String,
    scope: Scope,
    sources: Vec<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: usize,
    cursor: Option<String>,
}

#[derive(Debug, Serialize)]
enum Scope {
    Session(SessionRef),
    Project(String),
}

impl Params {
    fn parse(value: &Value) -> Result<Self, HandlerOutcome> {
        let p = envelope::object(value, "params")?;
        envelope::refuse_unknown(
            p,
            &[
                "query", "scope", "sources", "from_ms", "to_ms", "limit", "cursor",
            ],
            "params",
        )?;
        let query = p
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| envelope::invalid_field("params.query", "type", None))?
            .trim()
            .to_owned();
        if query.is_empty() || query.len() > 1024 || query.contains('\0') {
            return Err(envelope::invalid_field("params.query", "range", Some(1024)));
        }
        let scope = envelope::object(p.get("scope").unwrap_or(&Value::Null), "params.scope")?;
        envelope::refuse_unknown(scope, &["session", "project"], "params.scope")?;
        if scope.len() != 1 {
            return Err(envelope::invalid_field("params.scope", "exclusive", None));
        }
        let scope = if let Some(session) = scope.get("session") {
            Scope::Session(SessionRef::parse(session, "params.scope.session")?)
        } else {
            let project = scope["project"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
                .ok_or_else(|| {
                    envelope::invalid_field("params.scope.project", "range", Some(4096))
                })?;
            Scope::Project(project.into())
        };
        let mut sources = match p.get("sources") {
            None => Vec::new(),
            Some(Value::Array(a)) => a
                .iter()
                .map(|s| {
                    s.as_str()
                        .filter(|s| SOURCES.contains(s))
                        .map(String::from)
                        .ok_or_else(|| envelope::invalid_field("params.sources", "value", None))
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(envelope::invalid_field("params.sources", "type", None)),
        };
        if sources.is_empty() {
            sources = SOURCES.iter().map(|s| s.to_string()).collect();
        }
        sources.sort();
        sources.dedup();
        let date = |key: &str| match p.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_i64()
                .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
                .map(Some)
                .ok_or_else(|| envelope::invalid_field(&format!("params.{key}"), "range", None)),
        };
        let (from, to) = (date("from_ms")?, date("to_ms")?);
        if matches!((from, to), (Some(a), Some(b)) if a > b) {
            return Err(envelope::invalid_field("params.from_ms", "order", None));
        }
        let limit = match p.get("limit") {
            None => 10,
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=25).contains(n))
                .ok_or_else(|| envelope::invalid_field("params.limit", "range", Some(25)))?
                as usize,
        };
        let cursor = match p.get("cursor") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or_else(|| envelope::invalid_field("params.cursor", "range", Some(512)))?
                    .into(),
            ),
        };
        Ok(Self {
            query,
            scope,
            sources,
            from,
            to,
            limit,
            cursor,
        })
    }

    fn digest(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    self.query,
                    self.scope,
                    self.sources,
                    self.from,
                    self.to,
                    self.limit
                ]))
                .unwrap()
            )
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    digest: String,
    offset: usize,
    page: usize,
    issued: i64,
}

impl Cursor {
    fn read(params: &Params, now: i64) -> Result<Self, HandlerOutcome> {
        let Some(encoded) = &params.cursor else {
            return Ok(Self {
                digest: params.digest(),
                offset: 0,
                page: 0,
                issued: now,
            });
        };
        let bad = || {
            locator::refusal(
                "cursor_invalid",
                "The search cursor is invalid.",
                Value::Null,
            )
        };
        let cursor: Self =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_| bad())?)
                .map_err(|_| bad())?;
        if cursor.offset > 100 || cursor.page >= 4 || cursor.issued > now {
            return Err(bad());
        }
        if now.saturating_sub(cursor.issued) > 120_000 {
            return Err(locator::refusal(
                "cursor_expired",
                "The search cursor expired.",
                Value::Null,
            ));
        }
        if cursor.digest != params.digest() {
            return Err(locator::refusal(
                "cursor_mismatch",
                "The search filters changed.",
                Value::Null,
            ));
        }
        Ok(cursor)
    }
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).unwrap())
    }
}

/// Strip FTS markers before choosing a byte-bounded window around the first token.
fn snippet(highlighted: &str) -> (String, Vec<[usize; 2]>) {
    let mut text = String::new();
    let mut ranges = Vec::new();
    let mut start = None;
    for c in highlighted.chars() {
        match c {
            OPEN => start = Some(text.len()),
            CLOSE => {
                if let Some(begin) = start.take() {
                    ranges.push([begin, text.len()]);
                }
            }
            _ => text.push(c),
        }
    }
    let first = ranges.first().map_or(0, |r| r[0]);
    let mut left = first.saturating_sub(96);
    while !text.is_char_boundary(left) {
        left += 1;
    }
    let prefix = if left == 0 { "" } else { "…" };
    let mut right = (left + 320 - prefix.len()).min(text.len());
    let suffix = if right < text.len() { "…" } else { "" };
    right = right.saturating_sub(suffix.len());
    while !text.is_char_boundary(right) {
        right -= 1;
    }
    let ranges = ranges
        .into_iter()
        .filter(|r| r[0] >= left && r[1] <= right)
        .map(|r| [r[0] - left + prefix.len(), r[1] - left + prefix.len()])
        .collect();
    (format!("{prefix}{}{suffix}", &text[left..right]), ranges)
}

fn literal_highlight(text: &str, query: &str) -> String {
    // Regex's Unicode case folding keeps match offsets in the original string.
    let terms = query
        .split_whitespace()
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join("|");
    let regex = regex::RegexBuilder::new(&terms)
        .case_insensitive(true)
        .build()
        .expect("escaped terms");
    regex
        .replace_all(text, |c: &regex::Captures<'_>| {
            format!("{OPEN}{}{CLOSE}", &c[0])
        })
        .into_owned()
}

/// Connections may already belong to a wider caller-owned snapshot.
#[cfg_attr(test, expect(dead_code, reason = "dispatcher integration is separate"))]
pub(crate) fn search(
    context: &Connection,
    store: &Connection,
    _caller: &super::admission::AppCaller,
    params: &Value,
) -> HandlerOutcome {
    match run_search(context, store, params) {
        Ok(outcome) | Err(outcome) => outcome,
    }
}

fn target(
    context: &Connection,
    store: &Connection,
    reference: &SessionRef,
    source: &'static str,
) -> Result<Target, HandlerOutcome> {
    let located = locator::locate(context, store, reference)?;
    Ok(Target {
        key: located.context_session_id().into(),
        session: located.session,
        project_source: source,
    })
}

struct Deadline {
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Deadline {
    fn new(context: &Connection, store: &Connection) -> Self {
        let context = context.get_interrupt_handle();
        let store = store.get_interrupt_handle();
        let (stop, wait) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            if wait.recv_timeout(Duration::from_millis(250))
                == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            {
                context.interrupt();
                store.interrupt();
            }
        });
        Self {
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}

impl Drop for Deadline {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run_search(
    context: &Connection,
    store: &Connection,
    value: &Value,
) -> Result<HandlerOutcome, HandlerOutcome> {
    let params = Params::parse(value)?;
    let now = chrono::Utc::now().timestamp_millis();
    let cursor = Cursor::read(&params, now)?;
    let _context_tx = context
        .is_autocommit()
        .then(|| context.unchecked_transaction())
        .transpose()
        .map_err(locator::store_error)?;
    let _store_tx = store
        .is_autocommit()
        .then(|| store.unchecked_transaction())
        .transpose()
        .map_err(locator::store_error)?;
    let started = Instant::now();
    let _deadline = Deadline::new(context, store);
    let mut omitted = 0usize;
    let (project, targets) = match &params.scope {
        Scope::Session(reference) => {
            let t = target(context, store, reference, "session_projects")?;
            let project = context
                .query_row(
                    SESSION_PROJECT,
                    params![reference.session, reference.harness],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(locator::store_error)?;
            (project, vec![t])
        }
        Scope::Project(project) => {
            let rows = context
                .prepare(PROJECT_SESSIONS)
                .map_err(locator::store_error)?
                .query_map([project], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(locator::store_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(locator::store_error)?;
            if rows.is_empty()
                && context
                    .query_row(PROJECT_MEMORY, [project], |r| r.get::<_, i64>(0))
                    .optional()
                    .map_err(locator::store_error)?
                    .is_none()
            {
                return Err(locator::refusal(
                    "project_not_found",
                    "No stored project matches the identity.",
                    Value::Null,
                ));
            }
            let mut targets = Vec::new();
            for (session, harness) in rows {
                let candidates = store
                    .prepare(locator::ASYNC_LOOKUP)
                    .map_err(locator::store_error)?
                    .query_map(params![session, harness], |r| r.get::<_, String>(1))
                    .map_err(locator::store_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(locator::store_error)?;
                let runner = candidates
                    .first()
                    .and_then(|s| serde_json::from_str::<locator::AsyncHeader>(s).ok())
                    .map(|h| h.runner_module)
                    .unwrap_or_else(|| harness.clone());
                let reference = SessionRef {
                    runner,
                    harness,
                    session,
                };
                match target(context, store, &reference, "session_projects") {
                    Ok(t) => targets.push(t),
                    Err(_) => omitted += 1,
                }
            }
            (Some(project.clone()), targets)
        }
    };
    let snapshot = Snapshot {
        context,
        params: &params,
        targets,
        project: project.clone(),
        now,
        started,
        metadata: RefCell::new(HashMap::new()),
        memory_ranks: RefCell::new(Vec::new()),
    };
    let scope = StoreScope {
        project: ProjectId(project.clone().unwrap_or_default()),
        session: SessionId(
            snapshot
                .targets
                .first()
                .map(|t| t.key.clone())
                .unwrap_or_default(),
        ),
        generation: Generation(0),
    };
    let request = RetrievalRequest {
        query: params.query.clone(),
        intent: RetrievalIntent::Auto,
        limit: params.limit as u32,
        start_at_ms: params.from,
        end_at_ms_inclusive: params.to,
        ordinal_cutoff: None,
        visible_memory_ids: Vec::new(),
        embedding: None,
    };
    let sources = params
        .sources
        .iter()
        .filter_map(|s| match s.as_str() {
            "message" => Some(RetrievalSource::RawMessage),
            "note" => Some(RetrievalSource::Note),
            "memory" if project.is_some() => Some(RetrievalSource::Memory),
            "git_commit" if project.is_some() => Some(RetrievalSource::GitCommit),
            "primer" if project.is_some() => Some(RetrievalSource::Primer),
            _ => None,
        })
        .collect::<Vec<_>>();
    let prepared = crate::retrieval_store::search::collect(
        &RetrievalStore {
            store: &snapshot,
            now_ms: now,
        },
        &scope,
        &request,
        &sources,
        None,
    );
    let source_status = params
        .sources
        .iter()
        .map(|source| {
            let lane = if source == "message" {
                "raw_message"
            } else {
                source.as_str()
            };
            let status = match prepared.availability.get(lane) {
                Some(Availability::Available) | Some(Availability::Degraded { .. }) => "ok",
                _ => "unavailable",
            };
            (source.clone(), json!(status))
        })
        .collect::<serde_json::Map<_, _>>();
    let mut ranges = HashMap::<String, Vec<(i64, i64, i64)>>::new();
    let mut hits = Vec::new();
    for candidate in prepared.baseline {
        if started.elapsed() >= Duration::from_millis(250) {
            break;
        }
        let hit = candidate.hit;
        let source = match hit.source {
            RetrievalSource::RawMessage => "message",
            RetrievalSource::Memory => "memory",
            RetrievalSource::GitCommit => "git_commit",
            RetrievalSource::Note => "note",
            _ => continue,
        };
        let key = format!("{source}:{}", hit.source_id);
        let mut metadata = snapshot.metadata.borrow_mut();
        if source == "git_commit" {
            let Some(row) = read_before_deadline(&snapshot, |context| {
                let row = context
                    .query_row(
                        COMMIT,
                        params![
                            mc_store::git_archive::fts::sanitize_fts_query(&params.query),
                            hit.source_id,
                            scope.project.0
                        ],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?;
                Ok(match row {
                    Some(row) => Some(row),
                    None => context
                        .query_row(COMMIT_ROW, params![hit.source_id, scope.project.0], |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                literal_highlight(&r.get::<_, String>(1)?, &params.query),
                            ))
                        })
                        .optional()?,
                })
            })?
            else {
                break;
            };
            if let Some((at, marked)) = row {
                metadata.insert(
                    key.clone(),
                    Metadata {
                        target: None,
                        message_id: None,
                        ordinal: None,
                        role: None,
                        at: Some(at),
                        marked,
                        reference: json!({"sha":hit.source_id}),
                    },
                );
            }
        }
        let Some(meta) = metadata.get(&key) else {
            continue;
        };
        let mut compartment = None;
        if source == "message" {
            if let (Some(t), Some(ordinal)) = (&meta.target, meta.ordinal) {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    ranges.entry(t.key.clone())
                {
                    // The planned idx_compartments_session_end(session_id, end_message)
                    // index will bound the range lookup. Until that index is available,
                    // read only range columns once through the session-prefix index.
                    let Some(rows) = read_before_deadline(&snapshot, |context| {
                        let mut statement = context.prepare(RANGES)?;
                        let rows = statement
                            .query_map([&t.key], |r| Ok((r.get(0)?, r.get(2)?, r.get(3)?)))?
                            .collect::<rusqlite::Result<Vec<_>>>();
                        rows
                    })?
                    else {
                        break;
                    };
                    entry.insert(rows);
                }
                compartment = ranges[&t.key]
                    .iter()
                    .find(|(_, start, end)| ordinal >= *start && ordinal <= *end)
                    .map(|(id, _, _)| id.to_string());
            }
        }
        let (snippet, match_ranges) = snippet(&meta.marked);
        hits.push(json!({"source":source,"session":meta.target.as_ref().map(|t| &t.session),"project":project,"project_source":if project.is_some() { json!(meta.target.as_ref().map(|t| t.project_source).unwrap_or("session_projects")) } else { Value::Null },"agent_id":null,"agent_resolution":agent_ids::RESOLUTION,"message_id":meta.message_id,"ordinal":meta.ordinal,"role":meta.role,"at_ms":meta.at,"compartment_id":compartment,"snippet":snippet,"match_ranges":match_ranges,"score":hit.score,"ref":meta.reference}));
    }
    let total = hits.len();
    let mut page = Vec::new();
    let mut bytes = 0;
    let mut complete = started.elapsed() < Duration::from_millis(250);
    for hit in hits.into_iter().skip(cursor.offset).take(params.limit) {
        bytes += serde_json::to_vec(&hit).unwrap().len();
        if bytes > envelope::ROW_BUDGET {
            complete = false;
            break;
        }
        page.push(hit);
    }
    let more = total > cursor.offset + page.len();
    let next = (more && cursor.page < 3 && cursor.offset + page.len() < 100).then(|| {
        Cursor {
            digest: cursor.digest,
            offset: cursor.offset + page.len(),
            page: cursor.page + 1,
            issued: cursor.issued,
        }
        .encode()
    });
    Ok(envelope::reply("context.search", now, json!({"complete":complete,"agent_resolution":agent_ids::RESOLUTION,"source_status":source_status,"diagnostics":{"omitted_sessions":omitted,"project_resolution":if project.is_some() { json!({"status":"ok"}) } else { json!({"status":"unavailable","reason":"project_identity_not_recorded","lanes":["memory","git_commit","primer"]}) }},"hits":page,"next_cursor":next}).as_object().unwrap().clone()))
}

#[cfg(test)]
pub(crate) fn search_for_test(
    context: &Connection,
    store: &Connection,
    params: &Value,
) -> HandlerOutcome {
    match run_search(context, store, params) {
        Ok(outcome) | Err(outcome) => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    fn fixture() -> TestStores {
        let db = TestStores::new();
        db.standalone("s", "pi");
        db.context_sql("INSERT INTO session_projects VALUES('s','pi','git:project',1)");
        db
    }

    fn message(db: &TestStores, session: &str, ordinal: i64, at: i64, content: &str) {
        let session = session.replace('\'', "''");
        let content = content.replace('\'', "''");
        db.context_sql(&format!("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('{session}',{ordinal},'m{ordinal}','assistant','{content}')"));
        let row = db.context.last_insert_rowid();
        db.context_sql(&format!(
            "INSERT INTO message_fts_rowid_map VALUES('{session}',{ordinal},{row},{at})"
        ));
    }

    fn request(query: &str) -> Value {
        json!({"query":query,"scope":{"session":{"runner":"pi","harness":"pi","session":"s"}},"sources":["message"]})
    }

    fn reply(db: &TestStores, params: &Value) -> Value {
        match run_search(&db.context, &db.store, params) {
            Ok(HandlerOutcome::Response(bytes)) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("unexpected search result: {other:?}"),
        }
    }

    fn code(result: Result<HandlerOutcome, HandlerOutcome>) -> String {
        match result {
            Err(HandlerOutcome::ErrorWithDetail { code, .. }) => code,
            other => panic!("expected refusal: {other:?}"),
        }
    }

    #[test]
    fn search_multibyte_match_ranges_are_utf8_bytes() {
        let db = fixture();
        message(&db, "s", 1, 10, "前缀 🚀 hello 中文 running");
        for (query, expected) in [("hello", "hello"), ("中文", "中文"), ("runs", "running")] {
            let body = reply(&db, &request(query));
            let hit = &body["hits"][0];
            let text = hit["snippet"].as_str().unwrap();
            let ranges = hit["match_ranges"].as_array().unwrap();
            assert_eq!(ranges.len(), 1, "{body}");
            let (start, end) = (
                ranges[0][0].as_u64().unwrap() as usize,
                ranges[0][1].as_u64().unwrap() as usize,
            );
            assert!(
                text.is_char_boundary(start) && text.is_char_boundary(end),
                "{body}"
            );
            assert_eq!(&text[start..end], expected);
        }
        let marked = format!(
            "{} {OPEN}hello{CLOSE} {}",
            "界🚀".repeat(90),
            "末尾".repeat(90)
        );
        let (text, ranges) = snippet(&marked);
        assert!(text.len() <= 320);
        assert_eq!(&text[ranges[0][0]..ranges[0][1]], "hello");
    }

    #[test]
    fn summarized_hits_have_compartment_and_client_join_fields() {
        let db = fixture();
        db.compartment("s");
        for ordinal in 1..=3 {
            message(&db, "s", ordinal, 10, "needle");
        }
        let body = reply(&db, &request("needle"));
        for hit in body["hits"].as_array().unwrap() {
            assert_eq!(hit["agent_id"], Value::Null);
            assert_eq!(hit["agent_resolution"], "client");
            assert_eq!(hit["session"], request("")["scope"]["session"]);
            assert_eq!(hit["project"], "git:project");
            let ordinal = hit["ordinal"].as_i64().unwrap();
            assert_eq!(
                hit["compartment_id"],
                if ordinal <= 2 {
                    json!("1")
                } else {
                    Value::Null
                }
            );
        }
        assert_eq!(body["agent_resolution"], "client");
    }

    #[test]
    fn search_date_bounds_are_inclusive() {
        let db = fixture();
        for at in [9, 10, 20, 21] {
            message(&db, "s", at, at, "needle");
        }
        let mut p = request("needle");
        p["from_ms"] = json!(10);
        p["to_ms"] = json!(20);
        let body = reply(&db, &p);
        assert_eq!(
            body["hits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h["at_ms"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
    }

    #[test]
    fn project_sources_use_updated_dates_and_exclude_smart_notes() {
        let db = fixture();
        for (id, at) in [(1, 9), (2, 10), (3, 20), (4, 21)] {
            db.context_sql(&format!("INSERT INTO memories(id,project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES({id},'git:project','CONSTRAINTS','needle memory','h{id}',1,1,{at},1)"));
            db.context_sql(&format!("INSERT INTO notes(id,content,session_id,project_path,created_at,updated_at) VALUES({id},'needle note','s','git:project',1,{at})"));
        }
        db.context_sql("INSERT INTO notes(type,status,content,session_id,project_path,created_at,updated_at) VALUES('smart','ready','needle smart','s','git:project',10,10)");
        let body = reply(
            &db,
            &json!({"query":"needle","scope":{"project":"git:project"},"sources":["memory","note"],"from_ms":10,"to_ms":20,"limit":25}),
        );
        let hits = body["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 4, "{body}");
        for source in ["memory", "note"] {
            let mut times = hits
                .iter()
                .filter(|h| h["source"] == source)
                .map(|h| h["at_ms"].as_i64().unwrap())
                .collect::<Vec<_>>();
            times.sort();
            assert_eq!(times, vec![10, 20]);
        }
        assert!(hits
            .iter()
            .all(|h| !h["snippet"].as_str().unwrap().contains("smart")));
        for hit in hits {
            assert_eq!(hit["agent_resolution"], "client");
            assert!(hit["agent_id"].is_null());
            assert_eq!(hit["project"], "git:project");
        }
    }

    #[test]
    fn git_lane_page_limit_keeps_shared_candidate_fetch_bounded() {
        let db = fixture();
        for i in 0..120 {
            let sha = format!("sha{i:03}");
            db.context_sql(&format!("INSERT INTO git_commits VALUES('{sha}','git:project','{sha}','needle commit',NULL,10,10)"));
            db.context_sql(&format!("INSERT INTO git_commits_fts(sha,project_path,message) VALUES('{sha}','git:project','needle commit')"));
        }
        // Pin the shared lane's internal fetch rule as well as the option passed
        // to it: the public result is truncated and cannot reveal overfetch.
        let shared = include_str!("../../../mc-store/src/git_archive/fts.rs");
        assert!(shared.contains("let fetch_limit = (i64::from(options.limit) * 3).max(30);"));
        for limit in [1, 5, 10, 25] {
            let p = Params::parse(
                &json!({"query":"needle","scope":{"project":"git:project"},"limit":limit}),
            )
            .unwrap();
            let snapshot = Snapshot {
                context: &db.context,
                params: &p,
                targets: Vec::new(),
                project: Some("git:project".into()),
                now: 10,
                started: Instant::now(),
                metadata: RefCell::new(HashMap::new()),
                memory_ranks: RefCell::new(Vec::new()),
            };
            let request = RetrievalRequest {
                query: "needle".into(),
                intent: RetrievalIntent::Auto,
                limit: limit as u32,
                start_at_ms: Some(10),
                end_at_ms_inclusive: Some(10),
                ordinal_cutoff: None,
                visible_memory_ids: Vec::new(),
                embedding: None,
            };
            let scope = StoreScope {
                project: ProjectId("git:project".into()),
                session: SessionId("s".into()),
                generation: Generation(0),
            };
            let adapter = RetrievalStore {
                store: &snapshot,
                now_ms: 10,
            };
            let CapabilityResult::Available { value: result } =
                adapter.git_commits(&scope, &request, None, limit * 4)
            else {
                panic!("git lane unavailable")
            };
            assert_eq!(
                result.hits.len(),
                limit,
                "git lane must receive the page limit, not the cursor window"
            );
            assert!((3 * result.hits.len()).max(30) <= (4 * limit).max(30));
            let body = reply(
                &db,
                &json!({"query":"needle","scope":{"project":"git:project"},"sources":["git_commit"],"limit":limit,"from_ms":10,"to_ms":10}),
            );
            assert_eq!(body["hits"].as_array().unwrap().len(), limit);
            assert_eq!(body["hits"][0]["at_ms"], 10);
            assert!(body["hits"][0]["session"].is_null());
        }
    }

    #[test]
    fn compartment_search_fifty_hits_two_thousand_ranges_latency() {
        let db = fixture();
        db.context_sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness) SELECT 's',i,i,i,'title','summary',10,'pi' FROM n");
        for i in 1..=50 {
            message(&db, "s", i, 10, "needle");
        }
        let mut durations = Vec::new();
        for iteration in 0..22 {
            let mut p = request("needle");
            p["limit"] = json!(25);
            let start = Instant::now();
            let a = reply(&db, &p);
            p["cursor"] = a["next_cursor"].clone();
            let b = reply(&db, &p);
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(
                a["hits"].as_array().unwrap().len() + b["hits"].as_array().unwrap().len(),
                50
            );
            assert!(a["hits"]
                .as_array()
                .unwrap()
                .iter()
                .chain(b["hits"].as_array().unwrap())
                .all(|h| h["compartment_id"].is_string()));
            if iteration > 0 {
                durations.push(elapsed);
            }
        }
        durations.sort_by(f64::total_cmp);
        println!(
            "50 hits / 2000 compartments / two 25-hit pages / 21 samples: p50={:.3}ms p90={:.3}ms",
            durations[10], durations[18]
        );
    }

    #[test]
    fn cursor_refuses_changed_filters_and_limits_four_pages() {
        let db = fixture();
        for i in 1..=60 {
            message(&db, "s", i, i, "needle");
        }
        let mut p = request("needle");
        p["limit"] = json!(10);
        let first = reply(&db, &p);
        let cursor = first["next_cursor"].clone();
        assert!(cursor.is_string());
        for (name, value) in [
            ("query", json!("other")),
            ("sources", json!(["note"])),
            ("from_ms", json!(1)),
            ("to_ms", json!(60)),
            ("limit", json!(5)),
            ("scope", json!({"project":"git:project"})),
        ] {
            let mut changed = p.clone();
            changed["cursor"] = cursor.clone();
            changed[name] = value;
            assert_eq!(
                code(run_search(&db.context, &db.store, &changed)),
                "cursor_mismatch"
            );
        }
        let mut ids = Vec::new();
        for page in 0..4 {
            let body = reply(&db, &p);
            ids.extend(
                body["hits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| h["message_id"].as_str().unwrap().to_owned()),
            );
            p["cursor"] = body["next_cursor"].clone();
            assert_eq!(p["cursor"].is_null(), page == 3);
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 40);
        p["cursor"] = json!("invalid");
        assert_eq!(
            code(run_search(&db.context, &db.store, &p)),
            "cursor_invalid"
        );
        let parsed = Params::parse(&request("needle")).unwrap();
        let expired = Cursor {
            digest: parsed.digest(),
            offset: 1,
            page: 1,
            issued: 1,
        }
        .encode();
        assert!(
            matches!(Cursor::read(&Params {cursor:Some(expired), ..parsed},120_002), Err(HandlerOutcome::ErrorWithDetail { code, .. }) if code == "cursor_expired")
        );
    }

    #[test]
    fn search_rejects_nested_unknown_keys_and_bad_params() {
        let db = fixture();
        for path in ["params.scope.surprise", "params.scope.session.surprise"] {
            let mut p = request("needle");
            if path.contains("session.surprise") {
                p["scope"]["session"]["surprise"] = json!(1);
            } else {
                p["scope"]["surprise"] = json!(1);
            }
            match run_search(&db.context, &db.store, &p) {
                Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) => {
                    assert_eq!(code, "invalid_params");
                    assert_eq!(detail["field"], path);
                }
                other => panic!("{other:?}"),
            }
        }
        for (key, value) in [
            ("limit", json!(26)),
            ("sources", json!(["fact"])),
            ("query", json!(" ")),
            ("from_ms", json!(true)),
        ] {
            let mut p = request("needle");
            p[key] = value;
            assert_eq!(
                code(run_search(&db.context, &db.store, &p)),
                "invalid_params"
            );
        }
    }

    #[test]
    fn project_search_omits_unverified_session_membership() {
        let db = fixture();
        message(&db, "s", 1, 10, "needle");
        db.context_sql("INSERT INTO session_projects VALUES('forged','pi','git:project',1)");
        message(&db, "forged", 2, 10, "needle");
        let body = reply(
            &db,
            &json!({"query":"needle","scope":{"project":"git:project"},"sources":["message"]}),
        );
        assert_eq!(body["hits"].as_array().unwrap().len(), 1);
        assert_eq!(body["diagnostics"]["omitted_sessions"], 1);
        db.standalone("second", "pi");
        for i in 2..=50 {
            message(&db, "s", i, 10, "needle");
        }
        for i in 1..=50 {
            message(&db, "second", i, 10, "needle");
        }
        let p = Params::parse(&request("needle")).unwrap();
        let targets = ["s", "second"]
            .into_iter()
            .map(|session| {
                target(
                    &db.context,
                    &db.store,
                    &SessionRef {
                        runner: "pi".into(),
                        harness: "pi".into(),
                        session: session.into(),
                    },
                    "session_projects",
                )
                .unwrap()
            })
            .collect();
        let snapshot = Snapshot {
            context: &db.context,
            params: &p,
            targets,
            project: Some("git:project".into()),
            now: 10,
            started: Instant::now(),
            metadata: RefCell::new(HashMap::new()),
            memory_ranks: RefCell::new(Vec::new()),
        };
        let CapabilityResult::Available { value: rows } = snapshot.messages(DateBounds::default())
        else {
            panic!("message lane unavailable")
        };
        assert_eq!(rows.len(), 40);
        assert_eq!(
            snapshot.metadata.borrow().len(),
            40,
            "the candidate cap is global, not per session"
        );
    }

    #[test]
    fn mode3_without_project_membership_still_searches_session() {
        let db = fixture();
        let namespace = db.async_session("runner", "pi", "async", 0, false);
        message(&db, &namespace, 2, 10, "needle");
        let p = json!({"query":"needle","scope":{"session":{"runner":"runner","harness":"pi","session":"async"}}});
        let body = reply(&db, &p);
        assert_eq!(body["hits"].as_array().unwrap().len(), 1);
        assert_eq!(body["hits"][0]["session"]["session"], "async");
        assert_eq!(body["hits"][0]["project"], Value::Null);
        assert_eq!(
            body["diagnostics"]["project_resolution"]["reason"],
            "project_identity_not_recorded"
        );
        for source in ["memory", "git_commit", "primer"] {
            assert_eq!(body["source_status"][source], "unavailable");
        }
        let project = reply(
            &db,
            &json!({"query":"needle","scope":{"project":"git:project"},"sources":["message"]}),
        );
        assert!(project["hits"].as_array().unwrap().is_empty());
        db.context_sql("INSERT INTO session_projects VALUES('async','pi','git:project',1)");
        let body = reply(&db, &p);
        assert_eq!(body["hits"][0]["project"], "git:project");
    }

    #[test]
    fn search_never_resolves_project_identities() {
        let source = include_str!("search.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "ProjectIdentityResolver",
            "EntorhinalResolver",
            "resolve_for_session",
            "route_project",
        ] {
            assert!(
                !source.contains(forbidden),
                "search must not invoke {forbidden}"
            );
        }
    }

    #[test]
    fn expired_budget_stops_new_reads_without_a_refusal() {
        let db = fixture();
        let params = Params::parse(&request("needle")).unwrap();
        let snapshot = Snapshot {
            context: &db.context,
            params: &params,
            targets: Vec::new(),
            project: None,
            now: 10,
            started: Instant::now() - Duration::from_millis(251),
            metadata: RefCell::new(HashMap::new()),
            memory_ranks: RefCell::new(Vec::new()),
        };
        let called = std::cell::Cell::new(false);
        let value = read_before_deadline(&snapshot, |_| {
            called.set(true);
            Ok(7)
        })
        .unwrap();
        assert_eq!(value, None);
        assert!(!called.get());
    }

    #[test]
    fn all_search_queries_are_index_driven() {
        let db = fixture();
        for (sql, args) in [
            (SESSION_PROJECT, vec![&"s" as &dyn rusqlite::ToSql, &"pi"]),
            (PROJECT_MEMORY, vec![&"git:project"]),
            (RANGES, vec![&"s"]),
            (COMMIT_ROW, vec![&"sha", &"git:project"]),
        ] {
            TestStores::indexed(&db.context, sql, &args);
        }
        for (sql, args) in [
            (
                PROJECT_SESSIONS,
                vec![&"git:project" as &dyn rusqlite::ToSql],
            ),
            (
                NOTES,
                vec![&"s", &Option::<i64>::None, &Option::<i64>::None],
            ),
        ] {
            let details = db
                .context
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map(args.as_slice(), |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(
                details
                    .iter()
                    .any(|p| p.contains("SEARCH") && p.contains("USING INDEX")),
                "{details:?}"
            );
            assert!(!details.iter().any(|p| p.contains("SCAN")), "{details:?}");
        }
        // SQLite labels FTS MATCH access as a virtual-table SCAN even when it uses
        // the full-text index. Its M (MATCH) constraint proves indexed matching.
        for (sql, args) in [
            (
                MEMORY,
                vec![
                    &"needle" as &dyn rusqlite::ToSql,
                    &"git:project",
                    &10,
                    &Option::<i64>::None,
                    &Option::<i64>::None,
                    &40,
                ],
            ),
            (
                MESSAGE,
                vec![
                    &"[\"s\"]",
                    &"needle",
                    &Option::<i64>::None,
                    &Option::<i64>::None,
                    &40,
                ],
            ),
            (COMMIT, vec![&"needle", &"sha", &"git:project"]),
            ("SELECT c.sha,c.project_path,c.short_sha,c.message,c.author,c.committed_at,c.indexed_at FROM git_commits_fts INNER JOIN git_commits c ON c.sha=git_commits_fts.sha WHERE c.project_path=?1 AND c.committed_at BETWEEN ?3 AND ?4 AND git_commits_fts MATCH ?2 ORDER BY bm25(git_commits_fts) LIMIT ?5",vec![&"git:project",&"needle",&0,&20,&30]),
            ("SELECT c.sha,c.project_path,c.short_sha,c.message,c.author,c.committed_at,c.indexed_at FROM git_commits_fts INNER JOIN git_commits c ON c.sha=git_commits_fts.sha WHERE c.project_path=?1 AND git_commits_fts MATCH ?2 ORDER BY bm25(git_commits_fts) LIMIT ?5",vec![&"git:project",&"needle",&0,&20,&30]),
        ] {
            let details = db
                .context
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map(args.as_slice(), |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(
                details
                    .iter()
                    .any(|p| p.contains("VIRTUAL TABLE INDEX") && p.contains('M')),
                "{details:?}"
            );
            assert!(
                details
                    .iter()
                    .all(|p| !p.contains("SCAN") || p.contains("VIRTUAL TABLE INDEX")),
                "{details:?}"
            );
            assert!(details.iter().any(|p| p.contains("SEARCH")), "{details:?}");
        }
        for dated in [false, true] {
            let bounds = if dated {
                "AND c.committed_at BETWEEN ?3 AND ?4"
            } else {
                ""
            };
            let sql=format!("SELECT c.sha,c.project_path,c.short_sha,c.message,c.author,c.committed_at,c.indexed_at FROM git_commits c WHERE c.project_path=?1 {bounds} AND lower(c.message) LIKE '%'||lower(?2)||'%' ESCAPE '\\' ORDER BY c.committed_at DESC LIMIT ?5");
            TestStores::indexed(
                &db.context,
                &sql,
                &[&"git:project", &"needle", &0, &20, &30],
            );
        }
    }
}
