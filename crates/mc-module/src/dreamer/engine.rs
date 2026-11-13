//! When dreamer tasks run, and what one task run does.
//!
//! The engine learns a project when a session of it is set up, with the
//! memory profile that session resolved. Every task that profile declares,
//! and that the module implements, gets a schedule for the project. Once a
//! minute the engine starts every due task whose project it has seen in this
//! process. There is no cap of the engine's own on how many run at once:
//! provider limits come back from routing or the runner as waits.
//!
//! One run takes the project's lock (one writer per project's memories at a
//! time), asks the task for its batches, and sends each to a model
//! ([`super::run`]). Each accepted reply is applied in its own transaction,
//! with the lock checked in that same transaction, so a run that lost its
//! lock writes nothing more. A run that used its token budget stops before
//! its next batch; what it already applied stays.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

use super::run::{self, TaskError, TaskReply, TaskRun};
use super::store::{self, OwnerKey, RunEnd, Settled};
use super::task::{Batch, Owner, Task, TaskContext};
use crate::client::RunnerClient;
use crate::context_db::ContextDb;
use crate::memory_profile::Profile;
use crate::routing::{Router, DREAM_DEMANDS};

/// How long a lock lasts without renewal: longer than one batch may take,
/// so a live run always renews it before it lapses.
const LOCK_MS: i64 = run::RUN_TIMEOUT.as_millis() as i64 + 5 * 60_000;

/// How often the engine looks for due tasks. A schedule names minutes, so a
/// task starts within a minute of its slot.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// What the engine reads from the person's settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    /// Each task kind's schedule, `""` for one switched off. A kind not
    /// listed runs on its default schedule.
    pub schedules: HashMap<String, String>,
    /// The most input and output tokens one run may spend.
    pub budget_tokens: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schedules: HashMap::new(),
            budget_tokens: DEFAULT_BUDGET_TOKENS,
        }
    }
}

/// The 0.49 dreamer's per-task token budget, kept so a run costs no more
/// than it did.
pub const DEFAULT_BUDGET_TOKENS: u64 = 2_500_000;

/// Each kind's default schedule, the same as the 0.49 dreamer's, so a person
/// who never set one sees the same times.
pub fn default_schedule(kind: &str) -> &'static str {
    match kind {
        "map-memories" => "0 2 * * *",
        "verify" => "0 3 * * *",
        "verify-broad" | "curate" => "0 4 * * 0",
        "compress-cues" => "0 4 * * *",
        "classify-memories" => "0 6 * * *",
        "reflect-events" => "0 5 * * *",
        "review-user-memories" | "promote-primers" | "refresh-primers" => "0 3 * * *",
        _ => "",
    }
}

impl Settings {
    fn schedule(&self, kind: &str) -> String {
        self.schedules
            .get(kind)
            .cloned()
            .unwrap_or_else(|| default_schedule(kind).to_owned())
    }
}

/// A project seen in this process: where its files are, and the profile its
/// tasks come from.
struct Project {
    root: String,
    profile: Arc<Profile>,
    /// The settings its schedules were made under. Seeing the project again
    /// with the same root, profile and settings changes nothing.
    settings: Settings,
}

/// The dreamer of one module process.
pub struct Engine {
    /// Names this process in the locks it holds.
    holder: String,
    tasks: Vec<Box<dyn Task>>,
    projects: Mutex<HashMap<String, Project>>,
    /// Owners with a run in progress in this process.
    running: Mutex<HashSet<OwnerKey>>,
}

impl Engine {
    pub fn new(holder: impl Into<String>, tasks: Vec<Box<dyn Task>>) -> Self {
        Self {
            holder: holder.into(),
            tasks,
            projects: Mutex::default(),
            running: Mutex::default(),
        }
    }

    /// Close the runs a stopped process left open. Called once at start.
    pub fn start(&self, db: &ContextDb, now: i64) {
        match db.with_connection(|conn| store::close_interrupted(conn, now)) {
            Ok(0) => {}
            Ok(closed) => tracing::info!(
                "ck-mc: dreamer: {closed} run(s) left open by a stopped process marked interrupted"
            ),
            Err(error) => {
                tracing::warn!("ck-mc: dreamer: closing interrupted runs failed: {error}")
            }
        }
    }

    /// The task declarations `profile` makes that this engine runs: enabled,
    /// of a kind it implements and has a routing demand for.
    fn declarations<'p>(&self, profile: &'p Profile) -> Vec<&'p Value> {
        profile.body["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|task| task["enabled"].as_bool().unwrap_or(true))
            .filter(|task| {
                let kind = task["kind"].as_str().unwrap_or_default();
                self.task(kind).is_some() && demand(kind).is_some()
            })
            .collect()
    }

    /// The kind of `task` and whether the profile enables it, as the
    /// profile this process last saw `project` with declares it. `None` for
    /// a project not seen in this process, or a task its profile doesn't
    /// declare.
    pub fn declared(&self, project: &str, task: &str) -> Option<(String, bool)> {
        let projects = self.projects.lock().expect("dreamer projects");
        let profile = &projects.get(project)?.profile;
        profile.body["tasks"]
            .as_array()?
            .iter()
            .find(|declaration| {
                declaration["id"].as_str().or(declaration["kind"].as_str()) == Some(task)
            })
            .map(|declaration| {
                (
                    declaration["kind"].as_str().unwrap_or_default().to_owned(),
                    declaration["enabled"].as_bool().unwrap_or(true),
                )
            })
    }

    fn task(&self, kind: &str) -> Option<&dyn Task> {
        self.tasks
            .iter()
            .find(|task| task.kind() == kind)
            .map(Box::as_ref)
    }

    /// Learn `project` from a session set up for it, and schedule its tasks.
    pub fn see_project(
        &self,
        db: &ContextDb,
        project: &str,
        root: &str,
        profile: Arc<Profile>,
        settings: &Settings,
        now: i64,
    ) {
        let unchanged = self
            .projects
            .lock()
            .expect("dreamer projects")
            .get(project)
            .is_some_and(|seen| {
                seen.root == root
                    && seen.profile.digest == profile.digest
                    && seen.settings == *settings
            });
        if unchanged {
            return;
        }
        let owner = OwnerKey::project(project);
        let scheduled = db.with_connection(|conn| {
            for declaration in self.declarations(&profile) {
                let kind = declaration["kind"].as_str().unwrap_or_default();
                let task = declaration["id"].as_str().unwrap_or(kind);
                store::ensure_schedule(conn, &owner, task, &settings.schedule(kind), now)?;
            }
            Ok::<_, rusqlite::Error>(())
        });
        if let Err(error) = scheduled {
            tracing::warn!("ck-mc: dreamer: scheduling {project} failed: {error}");
            return;
        }
        tell(db, &owner);
        self.projects.lock().expect("dreamer projects").insert(
            project.to_owned(),
            Project {
                root: root.to_owned(),
                profile,
                settings: settings.clone(),
            },
        );
    }

    /// Start every due task whose project this process has seen. A due task
    /// of a project not seen since the process started stays due: it runs
    /// once one of its sessions is set up again.
    pub fn tick<C: RunnerClient + Router + Send + Sync + 'static>(
        self: &Arc<Self>,
        db: &Arc<ContextDb>,
        client: &Arc<C>,
        settings: &Settings,
        now: i64,
    ) {
        let due = match db.with_connection(|conn| store::due(conn, now)) {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!("ck-mc: dreamer: reading due tasks failed: {error}");
                return;
            }
        };
        for due in due {
            if due.owner.level != "project" {
                continue;
            }
            let Some((root, profile)) = self
                .projects
                .lock()
                .expect("dreamer projects")
                .get(&due.owner.owner_id)
                .map(|project| (project.root.clone(), Arc::clone(&project.profile)))
            else {
                continue;
            };
            if !self
                .running
                .lock()
                .expect("dreamer runs")
                .insert(due.owner.clone())
            {
                continue;
            }
            let engine = Arc::clone(self);
            let (db, client, settings) = (Arc::clone(db), Arc::clone(client), settings.clone());
            tokio::spawn(async move {
                let owner = due.owner.clone();
                engine
                    .run_due(&db, &*client, &settings, due, &root, &profile)
                    .await;
                engine.running.lock().expect("dreamer runs").remove(&owner);
            });
        }
    }

    /// Run one due task to its end and settle its schedule.
    async fn run_due<C: RunnerClient + Router>(
        &self,
        db: &ContextDb,
        client: &C,
        settings: &Settings,
        due: store::Due,
        root: &str,
        profile: &Profile,
    ) {
        let settle = |settled: Settled| {
            if let Err(error) = db.with_connection(|conn| {
                store::settle(conn, &due.owner, &due.task, &settled, None, now_ms())
            }) {
                tracing::warn!(
                    "ck-mc: dreamer: settling {} for {} failed: {error}",
                    due.task,
                    due.owner.owner_id
                );
            }
            tell(db, &due.owner);
        };
        let Some(declaration) = self
            .declarations(profile)
            .into_iter()
            .find(|declaration| declaration["id"].as_str() == Some(due.task.as_str()))
            .cloned()
        else {
            settle(Settled::Skipped {
                reason: format!("the project's profile no longer declares {}", due.task),
            });
            return;
        };
        let kind = declaration["kind"].as_str().unwrap_or_default().to_owned();
        if let Some(missing) = missing_evidence(&declaration, root) {
            settle(Settled::Skipped { reason: missing });
            return;
        }
        let locked = db.with_connection(|conn| {
            store::lock(
                conn,
                &due.owner,
                &self.holder,
                &due.task,
                now_ms(),
                now_ms() + LOCK_MS,
            )
        });
        match locked {
            Ok(true) => {}
            Ok(false) => {
                settle(Settled::Skipped {
                    reason: "another writer holds the project's memories".into(),
                });
                return;
            }
            Err(error) => {
                settle(Settled::Failed {
                    error: format!("locking the project failed: {error}"),
                });
                return;
            }
        }
        let end = self
            .run_task(
                db,
                client,
                settings,
                &due,
                &kind,
                &declaration,
                root,
                profile,
            )
            .await;
        let settled = match end.outcome.as_str() {
            "failed" | "lock_lost" => Settled::Failed {
                error: end.error.clone().unwrap_or_default(),
            },
            "waiting" => Settled::Waiting {
                until: end
                    .batches
                    .last()
                    .and_then(|batch| batch["wait_until"].as_i64())
                    .unwrap_or_else(|| now_ms() + 5 * 60_000),
                reason: end.error.clone().unwrap_or_default(),
            },
            "applied" => Settled::Ran { status: "applied" },
            "budget_stopped" => Settled::Ran {
                status: "budget_stopped",
            },
            _ => Settled::Ran {
                status: "nothing_to_do",
            },
        };
        settle(settled);
        if let Err(error) = db.with_connection(|conn| store::unlock(conn, &due.owner, &self.holder))
        {
            tracing::warn!(
                "ck-mc: dreamer: releasing {}'s lock failed: {error}",
                due.owner.owner_id
            );
        }
        // The schedule moves on before the lock is released, so no other
        // process starts the same slot again; the page hears of both.
        tell(db, &due.owner);
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_task<C: RunnerClient + Router>(
        &self,
        db: &ContextDb,
        client: &C,
        settings: &Settings,
        due: &store::Due,
        kind: &str,
        declaration: &Value,
        root: &str,
        profile: &Profile,
    ) -> RunEnd {
        let mut end = RunEnd::default();
        let Some(task) = self.task(kind) else {
            end.outcome = "failed".into();
            end.error = Some(format!("no task kind {kind}"));
            return end;
        };
        let demand = demand(kind).expect("declarations name only kinds with a demand");
        let owner = Owner::Project {
            id: due.owner.owner_id.clone(),
            root: root.to_owned(),
        };
        let run_id = match db.with_connection(|conn| {
            store::start_run(conn, &due.owner, &due.task, kind, &profile.name, now_ms())
        }) {
            Ok(id) => id,
            Err(error) => {
                end.outcome = "failed".into();
                end.error = Some(format!("recording the run failed: {error}"));
                return end;
            }
        };
        // The lock is held and the run recorded: the project's dreamer page
        // shows it running.
        tell(db, &due.owner);
        let batches = {
            let context = TaskContext {
                db,
                owner: &owner,
                profile,
                declaration,
            };
            task.batches(&context)
        };
        match batches {
            Ok(batches) if batches.is_empty() => end.outcome = "nothing_to_do".into(),
            Ok(batches) => {
                self.send_batches(
                    db, client, settings, due, demand, run_id, root, batches, &mut end,
                )
                .await
            }
            Err(error) => {
                end.outcome = "failed".into();
                end.failure_class = Some("input".into());
                end.error = Some(error);
            }
        }
        tracing::info!(
            "ck-mc: dreamer: run {run_id} {} for {}: {} ({} of {} proposals applied, {} batches, {} tokens)",
            due.task,
            due.owner.owner_id,
            end.outcome,
            end.applied,
            end.proposed,
            end.batches.len(),
            end.input_tokens + end.output_tokens
        );
        if let Err(error) =
            db.with_connection(|conn| store::finish_run(conn, run_id, &end, now_ms()))
        {
            tracing::warn!("ck-mc: dreamer: recording run {run_id}'s end failed: {error}");
        }
        end
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_batches<C: RunnerClient + Router>(
        &self,
        db: &ContextDb,
        client: &C,
        settings: &Settings,
        due: &store::Due,
        demand: &'static crate::routing::DreamDemand,
        run_id: i64,
        root: &str,
        batches: Vec<Box<dyn Batch>>,
        end: &mut RunEnd,
    ) {
        let name = run_id.to_string();
        end.outcome = "nothing_to_do".into();
        for (index, batch) in batches.iter().enumerate() {
            if end.input_tokens + end.output_tokens >= settings.budget_tokens {
                end.outcome = "budget_stopped".into();
                end.error = Some(format!(
                    "used {} of {} tokens; {} of {} batches left unsent",
                    end.input_tokens + end.output_tokens,
                    settings.budget_tokens,
                    batches.len() - index,
                    batches.len()
                ));
                return;
            }
            // The lock must still be ours before a model is paid for.
            let renewed = db.with_connection(|conn| {
                store::renew(conn, &due.owner, &self.holder, now_ms() + LOCK_MS)
            });
            if !matches!(renewed, Ok(true)) {
                end.outcome = "lock_lost".into();
                end.error = Some("the project's lock passed to another writer".into());
                return;
            }
            let job = TaskRun {
                demand,
                run_id: &format!("{name}.{index}"),
                project_root: root,
            };
            let reply = match run::run(client, &job, batch.as_ref()).await {
                Ok(reply) => reply,
                Err(TaskError::AccountWait(wait)) => {
                    end.outcome = "waiting".into();
                    end.error = Some(wait.code.clone());
                    end.batches
                        .push(json!({"wait_until": wait.until_ms, "code": wait.code}));
                    return;
                }
                Err(TaskError::Failed(error)) => {
                    end.outcome = "failed".into();
                    end.failure_class = Some("model".into());
                    end.error = Some(error);
                    return;
                }
            };
            record_batch(end, &reply);
            match apply(db, &due.owner, &self.holder, batch.as_ref(), &reply, run_id) {
                Ok(Some(applied)) => {
                    if applied.applied > 0 && due.owner.level == "project" {
                        db.changed(crate::app_read::Change::project_memories(
                            &due.owner.owner_id,
                        ));
                    }
                    end.proposed += applied.proposed;
                    end.applied += applied.applied;
                    end.dropped.extend(applied.dropped);
                    if end.applied > 0 {
                        end.outcome = "applied".into();
                    }
                }
                Ok(None) => {
                    end.outcome = "lock_lost".into();
                    end.error = Some("the project's lock passed to another writer".into());
                    return;
                }
                Err(error) => {
                    end.outcome = "failed".into();
                    end.failure_class = Some("apply".into());
                    end.error = Some(error);
                    return;
                }
            }
        }
    }
}

/// Apply one accepted reply in its own transaction, after checking in that
/// transaction that this process still holds the owner's lock. `None` when
/// it doesn't: nothing is written.
fn apply(
    db: &ContextDb,
    owner: &OwnerKey,
    holder: &str,
    batch: &dyn Batch,
    reply: &TaskReply,
    run_id: i64,
) -> Result<Option<super::task::Applied>, String> {
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        if !store::renew(&tx, owner, holder, now_ms() + LOCK_MS)
            .map_err(|error| error.to_string())?
        {
            return Ok(None);
        }
        let applied = batch.apply(&tx, reply, run_id)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(Some(applied))
    })
}

fn record_batch(end: &mut RunEnd, reply: &TaskReply) {
    // `prompt_tokens` is the whole prompt: uncached input, cache reads and
    // cache writes.
    let (input, output) = reply.usage.as_ref().map_or((0, 0), |usage| {
        (
            usage.prompt_tokens.unwrap_or(0),
            usage.output_tokens.unwrap_or(0),
        )
    });
    end.input_tokens += input;
    end.output_tokens += output;
    end.batches.push(json!({
        "model": format!("{}/{}", reply.model.provider, reply.model.model),
        "runner": reply.runner,
        "child": reply.child,
        "input_tokens": input,
        "output_tokens": output,
    }));
}

/// Tell the app reads that `owner`'s schedules, lock or runs changed. Only
/// projects have a dreamer page.
fn tell(db: &ContextDb, owner: &OwnerKey) {
    if owner.level == "project" {
        db.changed(crate::app_read::Change::Dreamer {
            project: owner.owner_id.clone(),
        });
    }
}

fn demand(kind: &str) -> Option<&'static crate::routing::DreamDemand> {
    DREAM_DEMANDS.iter().find(|demand| demand.kind == kind)
}

/// Why a task can't run on this machine: it reads the project's files and
/// the folder is gone, or it reads git history and the folder has none.
fn missing_evidence(declaration: &Value, root: &str) -> Option<String> {
    let reads: Vec<&str> = declaration["reads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let root = Path::new(root);
    if reads.contains(&"repo-files") && !root.is_dir() {
        return Some(format!(
            "the project folder {} is not on this machine",
            root.display()
        ));
    }
    if reads.contains(&"git") && !root.join(".git").exists() {
        return Some(format!(
            "the project folder {} has no git history",
            root.display()
        ));
    }
    None
}

fn now_ms() -> i64 {
    crate::summary::run::now_ms()
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
