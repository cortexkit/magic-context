//! Read-only facts for the speech and media module, isolated from session work.

use crate::app_read::{error, invalid, object, string};
use crate::config::Config;
use crate::context_db::{ContextDb, StoredCompartment};
use crate::count::Counter;
use crate::route::Project;
use crate::summary::{head, render};
use cortexkit_role_compaction::wire::Refusal;
use cortexkit_role_compaction::{notice::Conditions, read::SessionRef};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub const ROLE: (&str, &str) = ("mc-context-read", "v1");
pub const OPS: [&str; 3] = ["context.memories", "context.summaries", "context.recent"];

/// How long a caller should wait before asking again about a session whose
/// state ck-mc keeps in mode3.db but whose project it hasn't learned since
/// starting. Such a session sends a new Setup on its next step after a ck-mc
/// restart, so the wait is usually shorter.
const PROJECT_PENDING_RETRY_MS: u64 = 30_000;

/// How long a caller should wait before asking again for a session's newest
/// messages while ck-mc is still reading its transcript from the runner.
const TRANSCRIPT_PENDING_RETRY_MS: u64 = 2_000;

/// The smallest budget `context.recent` takes: enough for any line's
/// shortest header and `… `, so a cut line always fits and a session with
/// messages never answers empty.
const RECENT_MIN_BUDGET: u64 = 256;

/// The most summaries `context.summaries` returns with `newest`.
const NEWEST_MAX: u64 = 16;

type Reply = Result<Value, Refusal>;
type Command = (Vec<u8>, oneshot::Sender<Routed>);
type Projects = Arc<Mutex<HashMap<SessionRef, Project>>>;

/// Answers `context.recent` from the session's worker, which the module owns.
pub(crate) type RecentHandler =
    Box<dyn Fn(Recent) -> Pin<Box<dyn Future<Output = Reply> + Send>> + Send + Sync>;

/// What the read thread makes of a request: an answer, or a
/// `context.recent` request it admitted, which the session's worker answers.
enum Routed {
    Reply(Reply),
    Recent(Recent),
}

/// An admitted `context.recent` request.
pub(crate) struct Recent {
    pub harness: String,
    pub session: String,
    pub budget: u64,
    /// The names of the runners mode3.db keeps this session's saved state
    /// under, sorted, for a session with no live worker; a refusal when
    /// mode3.db could not be read.
    pub saved: Result<Vec<String>, Refusal>,
}

#[derive(Clone)]
pub struct ContextRead {
    tx: mpsc::Sender<Command>,
    recent: Arc<OnceLock<RecentHandler>>,
    #[cfg(test)]
    reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl ContextRead {
    pub(crate) fn new(
        context: Option<PathBuf>,
        store: Option<PathBuf>,
        config: Arc<Config>,
        projects: Projects,
        gate: Arc<crate::agent_data::Gate>,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<Command>();
        std::thread::Builder::new()
            .name("mc-context-read".into())
            .spawn(move || {
                let reader = Reader {
                    context,
                    store,
                    config,
                    projects,
                    gate,
                };
                while let Ok((body, reply)) = rx.recv() {
                    let _ = reply.send(reader.route(&body));
                }
            })
            .expect("context read worker");
        Self {
            tx,
            recent: Default::default(),
            #[cfg(test)]
            reads: Default::default(),
        }
    }

    /// Name who answers `context.recent`; until then it is refused as
    /// unavailable. The module sets this once, when it is built.
    pub(crate) fn serve_recent(&self, handler: RecentHandler) {
        let _ = self.recent.set(handler);
    }

    pub(crate) async fn read(&self, body: &[u8]) -> Reply {
        #[cfg(test)]
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.tx
            .send((body.to_vec(), tx))
            .map_err(|_| unavailable())?;
        match rx.await.map_err(|_| unavailable())? {
            Routed::Reply(reply) => reply,
            Routed::Recent(recent) => match self.recent.get() {
                Some(answer) => answer(recent).await,
                None => Err(unavailable()),
            },
        }
    }

    #[cfg(test)]
    fn read_count(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod admission_tests;

#[cfg(test)]
mod recent_tests;

#[cfg(test)]
mod samples_tests;

#[cfg(test)]
mod tests;

struct Reader {
    context: Option<PathBuf>,
    store: Option<PathBuf>,
    config: Arc<Config>,
    projects: Projects,
    /// Sessions a move holds are refused before any store is read.
    gate: Arc<crate::agent_data::Gate>,
}

fn unavailable() -> Refusal {
    error("store_unavailable", "The context store is unavailable.")
}

/// The refusal for a session ck-mc keeps nothing of.
pub(crate) fn unknown_session() -> Refusal {
    error(
        "unknown_session",
        "The context store has no record of this session.",
    )
}

/// The refusal of `context.recent` while ck-mc is still reading the
/// session's transcript from its runner, after a Setup or a restore.
pub(crate) fn transcript_pending() -> Refusal {
    Refusal::new(
        "transient",
        "The session's transcript is still being read; retry later.",
        Some(json!({"class": "transient", "retry_after_ms": TRANSCRIPT_PENDING_RETRY_MS})),
    )
}

/// The start of every context read's answer: which tokenizer counted its
/// `tokens`, and whether that count is exact or an estimate.
pub(crate) fn counted_by(counter: Counter) -> Value {
    json!({"token_family": counter.family().map_or_else(|| "mc-estimator".to_owned(), |family| format!("{family:?}")), "exact": counter.family().is_some()})
}

fn open(path: &std::path::Path) -> Result<Connection, Refusal> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| unavailable())?;
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| unavailable())?;
    Ok(conn)
}

impl Reader {
    /// Answer a request here, or hand an admitted `context.recent` on to the
    /// session's worker, which holds the transcript it reads.
    fn route(&self, body: &[u8]) -> Routed {
        self.admit(body)
            .unwrap_or_else(|refusal| Routed::Reply(Err(refusal)))
    }

    #[cfg(test)]
    fn read(&self, body: &[u8]) -> Reply {
        match self.route(body) {
            Routed::Reply(reply) => reply,
            Routed::Recent(_) => Err(unavailable()),
        }
    }

    fn admit(&self, body: &[u8]) -> Result<Routed, Refusal> {
        if body.len() > 64 * 1024 {
            return Err(invalid("request"));
        }
        let request: Value = serde_json::from_slice(body).map_err(|_| invalid("request"))?;
        let envelope = object(&request, &["method", "params"])?;
        let method = string(envelope, "method")?;
        if method == "role.describe" {
            return Ok(Routed::Reply(Ok(
                json!({"majors": [{"version": "mc-context-read/v1", "ops": OPS, "stability": "alpha"}], "implementation_version": crate::version_line()}),
            )));
        }
        let allowed = match method {
            "context.memories" => &["session", "purpose", "budget_tokens"][..],
            "context.summaries" => &["session", "budget_tokens", "newest"][..],
            "context.recent" => &["session", "budget_tokens"][..],
            _ => return Err(error("unknown_method", "Unknown context read operation.")),
        };
        let p = object(envelope.get("params").unwrap_or(&Value::Null), allowed)?;
        let session = object(
            p.get("session").unwrap_or(&Value::Null),
            &["harness", "session"],
        )?;
        let harness = string(session, "harness")?;
        let session = string(session, "session")?;
        // A context read names no runner, and context.db keys a session's
        // rows by harness and session id, so any move of that session
        // refuses it.
        self.gate
            .check_any_runner(harness, session)
            .map_err(|gated| gated.refusal())?;
        let least = if method == "context.recent" {
            RECENT_MIN_BUDGET
        } else {
            1
        };
        let budget = p
            .get("budget_tokens")
            .and_then(Value::as_u64)
            .filter(|n| (least..=32768).contains(n))
            .ok_or_else(|| invalid("budget_tokens"))?;
        if method == "context.recent" {
            return Ok(Routed::Recent(Recent {
                harness: harness.to_owned(),
                session: session.to_owned(),
                budget,
                saved: self.saved_runners(harness, session),
            }));
        }
        let newest = match p.get("newest") {
            None => None,
            Some(newest) => Some(
                newest
                    .as_u64()
                    .filter(|n| (1..=NEWEST_MAX).contains(n))
                    .ok_or_else(|| invalid("newest"))?,
            ),
        };
        let purpose = if method == "context.memories" {
            let purpose = string(p, "purpose")?;
            if !["bias", "front"].contains(&purpose) {
                return Err(invalid("purpose"));
            }
            Some(purpose)
        } else {
            None
        };
        Ok(Routed::Reply(
            self.query(harness, session, purpose, budget, newest),
        ))
    }

    /// The runners mode3.db keeps the session's saved state under.
    fn saved_runners(&self, harness: &str, session: &str) -> Result<Vec<String>, Refusal> {
        let Some(path) = &self.store else {
            return Ok(Vec::new());
        };
        let conn = open(path)?;
        let mut statement = conn
            .prepare("SELECT runner FROM sessions WHERE harness=?1 AND session=?2 ORDER BY runner")
            .map_err(|_| unavailable())?;
        let runners = statement
            .query_map(params![harness, session], |row| row.get::<_, String>(0))
            .map_err(|_| unavailable())?
            .collect::<Result<Vec<_>, _>>();
        runners.map_err(|_| unavailable())
    }
}

struct Snapshot {
    project: Option<Project>,
    config_root: Option<String>,
    model: Option<String>,
    usable: u64,
    /// The project's and its workspace's memories the head may show; the
    /// user profile is not part of a bias pack.
    memories: Vec<crate::head_memories::Row>,
    summaries: Vec<StoredCompartment>,
}

fn known(conn: &Connection, harness: &str, session: &str) -> rusqlite::Result<bool> {
    let tables = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for table in tables {
        let columns: i64 = conn.query_row(
            "SELECT count(*) FROM pragma_table_info(?1) WHERE name IN ('harness','session_id')",
            [&table],
            |row| row.get(0),
        )?;
        if columns != 2 {
            continue;
        }
        let table = table.replace('"', "\"\"");
        let exists: bool = conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM \"{table}\" WHERE harness=?1 AND session_id=?2)"),
            params![harness, session],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The session's newest `count` summaries that have content, oldest first.
/// Only those rows are read: a long-lived head keeps thousands of summaries.
/// A row has content as [`render::DecayRenderCompartment::is_no_content`]
/// says, so rows that only advance coverage are skipped, as the history head
/// skips them.
fn newest_summaries(
    conn: &Connection,
    harness: &str,
    session: &str,
    count: u64,
) -> rusqlite::Result<Vec<StoredCompartment>> {
    let mut statement = conn.prepare(
        "SELECT sequence, start_message, end_message, COALESCE(start_message_id, ''),
                COALESCE(end_message_id, ''), title, content, p1, p2, p3, p4,
                importance, episode_type, legacy, created_at
           FROM compartments
          WHERE session_id = ?1 AND harness = ?2
            AND (title <> '' OR content <> '' OR COALESCE(p1, '') <> ''
                 OR COALESCE(p2, '') <> '' OR COALESCE(p3, '') <> '' OR COALESCE(p4, '') <> '')
          ORDER BY sequence DESC
          LIMIT ?3",
    )?;
    let mut rows = statement
        .query_map(params![session, harness, count], |row| {
            Ok(StoredCompartment {
                sequence: row.get(0)?,
                start_message: row.get(1)?,
                end_message: row.get(2)?,
                start_message_id: row.get(3)?,
                end_message_id: row.get(4)?,
                start_date: None,
                end_date: None,
                title: row.get(5)?,
                content: row.get(6)?,
                p1: row.get(7)?,
                p2: row.get(8)?,
                p3: row.get(9)?,
                p4: row.get(10)?,
                importance: row.get(11)?,
                episode_type: row.get(12)?,
                legacy: row.get(13)?,
                created_at: row.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.reverse();
    Ok(rows)
}

impl Reader {
    fn snapshot(
        &self,
        harness: &str,
        session: &str,
        purpose: Option<&str>,
        newest: Option<u64>,
    ) -> Result<(Snapshot, Duration), Refusal> {
        // Setup projects already live here. Copy under the lock, never across a database read.
        // After a restart, a session not yet set up has no live project and may return no memories.
        let live_project = self
            .projects
            .lock()
            .expect("session projects")
            .iter()
            .find(|(key, _)| key.harness == harness && key.session == session)
            .map(|(_, project)| project.clone());
        let mut conn = open(self.context.as_deref().ok_or_else(unavailable)?)?;
        let start = Instant::now();
        let tx = conn.transaction().map_err(|_| unavailable())?;
        if !known(&tx, harness, session).map_err(|_| unavailable())? {
            return Err(unknown_session());
        }
        let project: Option<String> = tx
            .query_row(
                "SELECT project_path FROM session_projects WHERE harness=?1 AND session_id=?2",
                params![harness, session],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?;
        let config_root = live_project.as_ref().map(|project| project.root.clone());
        let project = live_project.or_else(|| {
            project.filter(|id| !id.is_empty()).map(|id| Project {
                root: String::new(),
                id,
            })
        });
        let mut held = false;
        let mut workspace_id: Option<String> = None;
        let (mut model, mut usable): (Option<String>, u64) = tx.query_row(
            "SELECT COALESCE(NULLIF(last_observed_model_key,''),NULLIF(cached_m0_model_key,'')), MAX(0, CASE WHEN detected_context_limit > 0 THEN detected_context_limit ELSE last_usage_context_limit END) FROM session_meta WHERE harness=?1 AND session_id=?2",
            params![harness, session], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| unavailable())?.unwrap_or((None, 0));
        if let Some(path) = &self.store {
            let mut store = open(path)?;
            let store_tx = store.transaction().map_err(|_| unavailable())?;
            let mut statement = store_tx.prepare("SELECT json_extract(state,'$.compaction[1]') FROM sessions WHERE harness=?1 AND session=?2").map_err(|_| unavailable())?;
            let rows = statement
                .query_map(params![harness, session], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .map_err(|_| unavailable())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| unavailable())?;
            if rows.len() > 1 {
                return Err(unavailable());
            }
            if let Some(Some(text)) = rows.first() {
                let conditions: Conditions =
                    serde_json::from_str(text).map_err(|_| unavailable())?;
                model = Some(format!(
                    "{}/{}",
                    conditions.model.provider, conditions.model.model
                ));
                usable = crate::pass::usable_window(&conditions);
            }
            held = !rows.is_empty();
            drop(statement);
            // The session's workspace is Entorhinal's, from the memory
            // context its Setup recorded; its workspace memories follow it.
            let workspaces = store_tx
                .prepare("SELECT json_extract(context,'$.workspace_id') FROM memory_contexts WHERE harness=?1 AND session=?2")
                .and_then(|mut statement| {
                    statement
                        .query_map(params![harness, session], |row| row.get::<_, Option<String>>(0))?
                        .collect::<Result<Vec<_>, _>>()
                })
                .map_err(|_| unavailable())?;
            if workspaces.len() > 1 {
                return Err(unavailable());
            }
            workspace_id = workspaces.into_iter().next().flatten();
            store_tx.rollback().map_err(|_| unavailable())?;
        }
        // A session whose state ck-mc keeps in mode3.db learns its project only
        // from its Setup route, so after a restart, until that session's next
        // Setup, its project is unknown rather than absent. An empty list would read as final, and a caller
        // could cache a pack with no memories, so this answers "try later".
        if purpose == Some("bias") && held && project.is_none() {
            return Err(Refusal::new(
                "project_pending",
                "The session's project is not known yet; retry later.",
                Some(json!({"class": "transient", "retry_after_ms": PROJECT_PENDING_RETRY_MS})),
            ));
        }
        let mut snapshot = Snapshot {
            project,
            config_root,
            model,
            usable,
            memories: Vec::new(),
            summaries: Vec::new(),
        };
        match purpose {
            Some("bias") => {
                if let Some(project) = &snapshot.project {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |time| time.as_millis() as i64);
                    snapshot.memories = crate::head_memories::read_rows(
                        &tx,
                        Some(&project.id),
                        workspace_id.as_deref(),
                        now,
                    )
                    .map_err(|_| unavailable())?
                    .into_iter()
                    .filter(|row| row.level != "global")
                    .collect();
                }
            }
            Some("front") => {}
            None => {
                snapshot.summaries = match newest {
                    Some(count) => {
                        newest_summaries(&tx, harness, session, count).map_err(|_| unavailable())?
                    }
                    None => ContextDb::read_compartments(&tx, harness, session)
                        .map_err(|_| unavailable())?,
                }
            }
            _ => unreachable!("purpose validated before opening the store"),
        }
        tx.rollback().map_err(|_| unavailable())?;
        Ok((snapshot, start.elapsed()))
    }

    /// Memories are the ones the agent's head would choose within `budget`, by the head's
    /// own selection and block costs, including category tags and source labels; raw item
    /// token counts can therefore sum to less than the requested budget.
    /// Summaries use the recorded model context window, or age/importance decay without
    /// budget pressure when a plugin has never recorded a context limit.
    /// Plugin-only sessions have no directory, so project-file history percentage
    /// overrides cannot apply; user and model settings still do.
    ///
    /// With `newest`, summaries are not folded: the newest ones read are each
    /// shown at tier 1, the full text the history head gives a summary
    /// published since its baseline was last rebuilt.
    fn query(
        &self,
        harness: &str,
        session: &str,
        purpose: Option<&str>,
        budget: u64,
        newest: Option<u64>,
    ) -> Reply {
        let (snapshot, _) = self.snapshot(harness, session, purpose, newest)?;
        // Tokenizer initialization and all rendering happen after releasing both read transactions.
        let counter = Counter::for_model(snapshot.model.as_deref());
        let settings = self.config.resolve_for_project(
            snapshot.config_root.as_deref(),
            snapshot.project.as_ref().map(|project| project.id.as_str()),
            snapshot.model.as_deref().unwrap_or(""),
            snapshot.usable,
        );
        let mut answer = counted_by(counter);
        if let Some(purpose) = purpose {
            let memories = if purpose == "front" {
                // A voice front may receive only persona-marked memories. No such mark exists yet.
                Vec::new()
            } else if settings.memory_enabled && snapshot.project.is_some() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |time| time.as_millis() as i64);
                let chosen = crate::head_memories::choose(
                    &snapshot.memories,
                    &crate::head_memories::classes_for(None),
                    counter,
                    &crate::head_memories::budget(budget, 0),
                    now,
                );
                chosen
                    .ids
                    .iter()
                    .filter_map(|id| snapshot.memories.iter().find(|row| row.id == *id))
                    .collect()
            } else {
                Vec::new()
            };
            answer["memories"] = Value::Array(memories.into_iter().map(|row| {
                json!({"id": row.id, "category": row.tag, "text": row.content, "tokens": counter.count(&row.content)})
            }).collect());
        } else {
            // Each summary to show, newest first, with the tier it is shown at.
            let shown: Vec<(&StoredCompartment, u8)> = if newest.is_some() {
                snapshot.summaries.iter().rev().map(|s| (s, 1)).collect()
            } else {
                let history_budget =
                    (snapshot.usable as f64 * settings.execute_threshold_percentage / 100.0
                        * settings.history_budget_percentage) as u64;
                let inputs = head::Inputs {
                    counter,
                    summaries: &snapshot.summaries,
                    docs: "",
                    rows: &[],
                    classes: &HashMap::new(),
                    now_ms: 0,
                    gone: &[],
                    history_budget_tokens: history_budget,
                    history_local_budget_tokens: render::history_local_budget(
                        history_budget as f64,
                        snapshot.model.as_deref(),
                    ) as u64,
                    memory_budget_tokens: 0,
                    profile_budget_tokens: 0,
                };
                let baseline = head::fold(&inputs, None);
                baseline
                    .summary_items
                    .iter()
                    .rev()
                    .map(|item| {
                        let summary = snapshot
                            .summaries
                            .iter()
                            .find(|s| s.sequence.to_string() == item.compartment_id)
                            .expect("rendered summary");
                        (summary, item.tier)
                    })
                    .collect()
            };
            let mut used = 0;
            let mut summaries = Vec::new();
            for (summary, tier) in shown {
                let text = render::render_compartment_at_tier(
                    &render::DecayRenderCompartment::from(summary),
                    tier,
                );
                let tokens = counter.count(&text);
                if used + tokens > budget {
                    break;
                }
                used += tokens;
                summaries.push(json!({"id": summary.sequence.to_string(), "start": summary.start_message, "end": summary.end_message, "title": summary.title, "text": text, "tokens": tokens}));
            }
            answer["summaries"] = Value::Array(summaries);
        }
        Ok(answer)
    }
}
