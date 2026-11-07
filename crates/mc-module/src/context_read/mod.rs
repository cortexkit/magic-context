//! Read-only facts for the speech and media module, isolated from session work.

use crate::app_read::{error, invalid, object, string};
use crate::config::Config;
use crate::context_db::{ContextDb, StoredCompartment, StoredMemory};
use crate::count::Counter;
use crate::route::Project;
use crate::summary::{head, render};
use crate::workspace::Workspace;
use cortexkit_role_compaction::wire::Refusal;
use cortexkit_role_compaction::{notice::Conditions, read::SessionRef};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub const ROLE: (&str, &str) = ("mc-context-read", "v1");
pub const OPS: [&str; 2] = ["context.memories", "context.summaries"];

/// How long a caller should wait before asking again for a held head whose
/// project ck-mc hasn't learned yet. A head sets up again on its next step
/// after a ck-mc restart, so this is usually shorter.
const PROJECT_PENDING_RETRY_MS: u64 = 30_000;

type Reply = Result<Value, Refusal>;
type Command = (Vec<u8>, oneshot::Sender<Reply>);
type Projects = Arc<Mutex<HashMap<SessionRef, Project>>>;

#[derive(Clone)]
pub struct ContextRead {
    tx: mpsc::Sender<Command>,
    #[cfg(test)]
    reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl ContextRead {
    pub(crate) fn new(
        context: Option<PathBuf>,
        store: Option<PathBuf>,
        config: Arc<Config>,
        projects: Projects,
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
                };
                while let Ok((body, reply)) = rx.recv() {
                    let _ = reply.send(reader.read(&body));
                }
            })
            .expect("context read worker");
        Self {
            tx,
            #[cfg(test)]
            reads: Default::default(),
        }
    }

    pub(crate) async fn read(&self, body: &[u8]) -> Reply {
        #[cfg(test)]
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.tx
            .send((body.to_vec(), tx))
            .map_err(|_| unavailable())?;
        rx.await.map_err(|_| unavailable())?
    }

    #[cfg(test)]
    fn read_count(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod admission_tests;

#[cfg(test)]
mod tests;

struct Reader {
    context: Option<PathBuf>,
    store: Option<PathBuf>,
    config: Arc<Config>,
    projects: Projects,
}

fn unavailable() -> Refusal {
    error("store_unavailable", "The context store is unavailable.")
}

fn open(path: &std::path::Path) -> Result<Connection, Refusal> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| unavailable())?;
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| unavailable())?;
    Ok(conn)
}

impl Reader {
    fn read(&self, body: &[u8]) -> Reply {
        if body.len() > 64 * 1024 {
            return Err(invalid("request"));
        }
        let request: Value = serde_json::from_slice(body).map_err(|_| invalid("request"))?;
        let envelope = object(&request, &["method", "params"])?;
        let method = string(envelope, "method")?;
        if method == "role.describe" {
            return Ok(
                json!({"majors": [{"version": "mc-context-read/v1", "ops": OPS, "stability": "alpha"}], "implementation_version": crate::version_line()}),
            );
        }
        let allowed = match method {
            "context.memories" => &["session", "purpose", "budget_tokens"][..],
            "context.summaries" => &["session", "budget_tokens"][..],
            _ => return Err(error("unknown_method", "Unknown context read operation.")),
        };
        let p = object(envelope.get("params").unwrap_or(&Value::Null), allowed)?;
        let session = object(
            p.get("session").unwrap_or(&Value::Null),
            &["harness", "session"],
        )?;
        let harness = string(session, "harness")?;
        let session = string(session, "session")?;
        let budget = p
            .get("budget_tokens")
            .and_then(Value::as_u64)
            .filter(|n| (1..=32768).contains(n))
            .ok_or_else(|| invalid("budget_tokens"))?;
        let purpose = if method == "context.memories" {
            let purpose = string(p, "purpose")?;
            if !["bias", "front"].contains(&purpose) {
                return Err(invalid("purpose"));
            }
            Some(purpose)
        } else {
            None
        };
        self.query(harness, session, purpose, budget)
    }
}

struct Snapshot {
    project: Option<Project>,
    config_root: Option<String>,
    model: Option<String>,
    usable: u64,
    workspace: Option<Workspace>,
    memories: Vec<StoredMemory>,
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

impl Reader {
    fn snapshot(
        &self,
        harness: &str,
        session: &str,
        purpose: Option<&str>,
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
            return Err(error(
                "unknown_session",
                "The context store has no record of this session.",
            ));
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
            store_tx.rollback().map_err(|_| unavailable())?;
        }
        // A head ck-mc holds learns its project only from its Setup route, so
        // after a restart, until that head's next Setup, its project is unknown
        // rather than absent. An empty list would read as final, and a caller
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
            workspace: None,
            memories: Vec::new(),
            summaries: Vec::new(),
        };
        match purpose {
            Some("bias") => {
                if let Some(project) = &snapshot.project {
                    let workspace =
                        Workspace::resolve(&tx, &project.id).map_err(|_| unavailable())?;
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |time| time.as_millis() as i64);
                    snapshot.memories = workspace
                        .memories(&tx, now, true)
                        .map_err(|_| unavailable())?;
                    snapshot.workspace = Some(workspace);
                }
            }
            Some("front") => {}
            None => {
                snapshot.summaries = ContextDb::read_compartments(&tx, harness, session)
                    .map_err(|_| unavailable())?
            }
            _ => unreachable!("purpose validated before opening the store"),
        }
        tx.rollback().map_err(|_| unavailable())?;
        Ok((snapshot, start.elapsed()))
    }

    /// Memories use the agent's project-memory block costs, including category and source labels;
    /// raw item token counts can therefore sum to less than the requested budget.
    /// Summaries use the recorded model context window, or age/importance decay without
    /// budget pressure when a plugin has never recorded a context limit.
    /// Plugin-only sessions have no directory, so project-file history percentage
    /// overrides cannot apply; user and model settings still do.
    fn query(&self, harness: &str, session: &str, purpose: Option<&str>, budget: u64) -> Reply {
        let (snapshot, _) = self.snapshot(harness, session, purpose)?;
        // Tokenizer initialization and all rendering happen after releasing both read transactions.
        let counter = Counter::for_model(snapshot.model.as_deref());
        let settings = self.config.resolve(
            snapshot.config_root.as_deref(),
            snapshot.model.as_deref().unwrap_or(""),
            snapshot.usable,
        );
        let mut answer = json!({"token_family": counter.family().map_or_else(|| "mc-estimator".to_owned(), |family| format!("{family:?}")), "exact": counter.family().is_some()});
        if let Some(purpose) = purpose {
            let memories = if purpose == "front" {
                // A voice front may receive only persona-marked memories. No such mark exists yet.
                Vec::new()
            } else if settings.memory_enabled {
                snapshot
                    .workspace
                    .as_ref()
                    .map(|workspace| {
                        crate::memory::trim_workspace_to_budget(
                            snapshot.memories,
                            budget,
                            workspace,
                            counter,
                        )
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            answer["memories"] = Value::Array(memories.into_iter().map(|memory| {
                let mut item = json!({"id": memory.id, "category": memory.category, "text": memory.content, "tokens": counter.count(&memory.content)});
                if let Some(workspace) = &snapshot.workspace {
                    if let Some(member) = workspace.member(&memory.project_path).filter(|member| *member != workspace.own) {
                        item["project"] = json!(workspace.source_name(&memory.project_path).unwrap_or(member));
                    }
                }
                item
            }).collect());
        } else {
            let history_budget = (snapshot.usable as f64 * settings.execute_threshold_percentage
                / 100.0
                * settings.history_budget_percentage) as u64;
            let inputs = head::Inputs {
                counter,
                summaries: &snapshot.summaries,
                docs: "",
                profile: &[],
                profile_max_id: 0,
                memories: &[],
                workspace: None,
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
            let mut used = 0;
            let mut summaries = Vec::new();
            for item in baseline.summary_items.iter().rev() {
                let summary = &snapshot
                    .summaries
                    .iter()
                    .find(|s| s.sequence.to_string() == item.compartment_id)
                    .expect("rendered summary");
                let text = render::render_compartment_at_tier(
                    &render::DecayRenderCompartment::from(*summary),
                    item.tier,
                );
                let tokens = counter.count(&text);
                if used + tokens > budget {
                    break;
                }
                used += tokens;
                summaries.push(json!({"id": item.compartment_id, "start": summary.start_message, "end": summary.end_message, "title": summary.title, "text": text, "tokens": tokens}));
            }
            answer["summaries"] = Value::Array(summaries);
        }
        Ok(answer)
    }
}
