//! When dreamer tasks run, and what one task run does.
//!
//! The engine learns a project when a session of it is set up, with the
//! memory profile that session resolved. Every task that profile declares,
//! and that the module implements, gets a schedule for the project; a task
//! of the person's own memories (the global review) gets one schedule for
//! the whole machine instead, and runs in the folder and with the profile of
//! a project that declares it. A task that runs once per workspace (the
//! workspace lift) gets no schedule: the engine starts it for a project
//! whose workspace holds two or more projects, and records the workspace it
//! completed for. Once a minute the engine starts every due task whose owner
//! it can run in this process. There is no cap of the engine's own on how
//! many run at once: provider limits come back from routing or the runner as
//! waits.
//!
//! One run takes its owner's lock (one writer per owner's memories at a
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
use crate::workspace_members::{Lookup, WorkspaceMembers};

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
#[derive(Clone)]
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
    /// Where the person's own tasks run ([`Task::global`]): the first project
    /// seen in this process whose profile declares one, by id, with its
    /// folder and profile. Those tasks read no project files, but a runner
    /// creates a child session only in a folder, and the profile supplies
    /// the task's prompts and categories. The choice changes only when that
    /// project is seen again with a profile that declares no such task.
    global: Mutex<Option<(String, Project)>>,
    /// The workspace each project seen in this process is in, by its memory
    /// context: what a task that runs once per workspace ([`Task::once`])
    /// runs for. A project in no workspace has no entry.
    workspaces: Mutex<HashMap<String, String>>,
    /// Owners with a run in progress in this process.
    running: Mutex<HashSet<OwnerKey>>,
}

impl Engine {
    pub fn new(holder: impl Into<String>, tasks: Vec<Box<dyn Task>>) -> Self {
        Self {
            holder: holder.into(),
            tasks,
            projects: Mutex::default(),
            global: Mutex::default(),
            workspaces: Mutex::default(),
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

    /// Whether `declaration` is a task of the person's own memories.
    fn is_global(&self, declaration: &Value) -> bool {
        self.task(declaration["kind"].as_str().unwrap_or_default())
            .is_some_and(|task| task.global())
    }

    /// Whether `declaration` is a task that runs once per project and
    /// workspace instead of on a schedule.
    fn is_once(&self, declaration: &Value) -> bool {
        self.task(declaration["kind"].as_str().unwrap_or_default())
            .is_some_and(|task| task.once())
    }

    /// Learn which workspace `project` is in, from its memory context: the
    /// workspace a task that runs once per workspace runs for. `None` for a
    /// project in no workspace.
    pub fn see_workspace(&self, project: &str, workspace: Option<&str>) {
        let mut workspaces = self.workspaces.lock().expect("dreamer workspaces");
        match workspace {
            Some(workspace) => {
                workspaces.insert(project.to_owned(), workspace.to_owned());
            }
            None => {
                workspaces.remove(project);
            }
        }
    }

    /// Learn `project` from a session set up for it, and schedule its tasks.
    /// A task of the person's own memories gets one schedule for the whole
    /// machine, however many projects declare it.
    pub fn see_project(
        &self,
        db: &ContextDb,
        project: &str,
        root: &str,
        profile: Arc<Profile>,
        settings: &Settings,
        now: i64,
    ) {
        let seen = Project {
            root: root.to_owned(),
            profile,
            settings: settings.clone(),
        };
        let unchanged = self
            .projects
            .lock()
            .expect("dreamer projects")
            .get(project)
            .is_some_and(|known| {
                known.root == seen.root
                    && known.profile.digest == seen.profile.digest
                    && known.settings == seen.settings
            });
        if unchanged {
            // The person's tasks may have lost the project they ran with
            // while this one stayed the same.
            self.offer_global(project, &seen);
            return;
        }
        let owner = OwnerKey::project(project);
        let global = OwnerKey::global();
        let scheduled = db.with_connection(|conn| {
            for declaration in self.declarations(&seen.profile) {
                // A task that runs once per workspace never gets a schedule,
                // whatever the settings say; the rounds start it instead.
                if self.is_once(declaration) {
                    continue;
                }
                let kind = declaration["kind"].as_str().unwrap_or_default();
                let task = declaration["id"].as_str().unwrap_or(kind);
                let owner = if self.is_global(declaration) {
                    &global
                } else {
                    &owner
                };
                store::ensure_schedule(conn, owner, task, &settings.schedule(kind), now)?;
            }
            Ok::<_, rusqlite::Error>(())
        });
        if let Err(error) = scheduled {
            tracing::warn!("ck-mc: dreamer: scheduling {project} failed: {error}");
            return;
        }
        tell(db, &owner);
        self.offer_global(project, &seen);
        self.projects
            .lock()
            .expect("dreamer projects")
            .insert(project.to_owned(), seen);
    }

    /// Let `project` carry the person's own tasks when none does yet, or
    /// update what it carries them with when it already does. A carrier
    /// whose profile no longer declares such a task gives them up.
    fn offer_global(&self, project: &str, seen: &Project) {
        let declares = self
            .declarations(&seen.profile)
            .into_iter()
            .any(|declaration| self.is_global(declaration));
        let mut carrier = self.global.lock().expect("dreamer global owner");
        if carrier
            .as_ref()
            .is_none_or(|(carries, _)| carries == project)
        {
            *carrier = declares.then(|| (project.to_owned(), seen.clone()));
        }
    }

    /// Start every due task whose owner this process can run: a project seen
    /// in this process, or the person's own memories once any project that
    /// declares their tasks has been seen. A due task of a project not seen
    /// since the process started stays due: it runs once one of its sessions
    /// is set up again.
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
            let carrier = match due.owner.level.as_str() {
                "project" => self
                    .projects
                    .lock()
                    .expect("dreamer projects")
                    .get(&due.owner.owner_id)
                    .cloned(),
                "global" => self
                    .global
                    .lock()
                    .expect("dreamer global owner")
                    .as_ref()
                    .map(|(_, project)| project.clone()),
                _ => None,
            };
            let Some(Project { root, profile, .. }) = carrier else {
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
        self.start_once(db, client, settings, now);
    }

    /// Start each task that runs once per workspace ([`Task::once`]) for
    /// every project seen in this process whose workspace it has not
    /// completed for yet, unless its last attempt is too recent to try
    /// again ([`once_retry_at`]) or a run of the project is in progress.
    /// Whether the workspace holds two or more projects is asked of
    /// Entorhinal in the started task, before anything is locked or
    /// recorded.
    fn start_once<C: RunnerClient + Router + Send + Sync + 'static>(
        self: &Arc<Self>,
        db: &Arc<ContextDb>,
        client: &Arc<C>,
        settings: &Settings,
        now: i64,
    ) {
        let candidates: Vec<(String, Project, String)> = {
            let projects = self.projects.lock().expect("dreamer projects");
            let workspaces = self.workspaces.lock().expect("dreamer workspaces");
            projects
                .iter()
                .filter_map(|(id, project)| {
                    Some((id.clone(), project.clone(), workspaces.get(id)?.clone()))
                })
                .collect()
        };
        for (project, seen, workspace) in candidates {
            let declarations: Vec<Value> = self
                .declarations(&seen.profile)
                .into_iter()
                .filter(|declaration| self.is_once(declaration))
                .cloned()
                .collect();
            let owner = OwnerKey::project(&project);
            for declaration in declarations {
                let task = declaration["id"].as_str().unwrap_or_default().to_owned();
                let record = db.with_connection(|conn| store::once_record(conn, &owner, &task));
                let record = match record {
                    Ok(record) => record,
                    Err(error) => {
                        tracing::warn!(
                            "ck-mc: dreamer: reading {task}'s record for {project} failed: {error}"
                        );
                        continue;
                    }
                };
                if once_retry_at(&record, &workspace).is_none_or(|at| at > now) {
                    continue;
                }
                if !self
                    .running
                    .lock()
                    .expect("dreamer runs")
                    .insert(owner.clone())
                {
                    continue;
                }
                let engine = Arc::clone(self);
                let (db, client, settings) = (Arc::clone(db), Arc::clone(client), settings.clone());
                let (project, seen, workspace, owner) = (
                    project.clone(),
                    seen.clone(),
                    workspace.clone(),
                    owner.clone(),
                );
                tokio::spawn(async move {
                    engine
                        .run_once(
                            &db,
                            &*client,
                            &settings,
                            &project,
                            &workspace,
                            &seen,
                            &declaration,
                        )
                        .await;
                    engine.running.lock().expect("dreamer runs").remove(&owner);
                });
                // One run per project at a time: another such task waits for
                // a later round.
                break;
            }
        }
    }

    /// Run once-per-workspace `declaration` for `project` in `workspace`,
    /// when Entorhinal lists two or more projects in that workspace, and
    /// record how it ended. Without that answer nothing is locked or
    /// recorded, so a later round asks again.
    #[allow(clippy::too_many_arguments)]
    async fn run_once<C: RunnerClient + Router>(
        &self,
        db: &ContextDb,
        client: &C,
        settings: &Settings,
        project: &str,
        workspace: &str,
        seen: &Project,
        declaration: &Value,
    ) {
        let members = match crate::workspace_members::workspace_members(client, workspace).await {
            Lookup::Members(members) if members.members.len() >= 2 => members,
            // A workspace of one project has nothing to lift into, and one
            // Entorhinal doesn't list or doesn't answer for is asked again on
            // a later round. None of them counts as done.
            Lookup::Members(_) | Lookup::Unknown | Lookup::NotAnswering => return,
        };
        let kind = declaration["kind"].as_str().unwrap_or_default();
        let task = declaration["id"].as_str().unwrap_or(kind);
        let owner = OwnerKey::project(project);
        let now = now_ms();
        match db.with_connection(|conn| {
            store::lock(conn, &owner, &self.holder, task, now, now + LOCK_MS)
        }) {
            Ok(true) => {}
            // Another writer holds the project's memories: a later round
            // tries again.
            Ok(false) => return,
            Err(error) => {
                tracing::warn!("ck-mc: dreamer: locking {project} for {task} failed: {error}");
                return;
            }
        }
        // Another process may have completed the task between this round's
        // check and the lock.
        let done = db
            .with_connection(|conn| store::once_record(conn, &owner, task))
            .map(|record| record.done_for.as_deref() == Some(workspace));
        if !matches!(done, Ok(false)) {
            if let Err(error) = db.with_connection(|conn| store::unlock(conn, &owner, &self.holder))
            {
                tracing::warn!("ck-mc: dreamer: releasing {project}'s lock failed: {error}");
            }
            return;
        }
        let due = store::Due {
            owner: owner.clone(),
            task: task.to_owned(),
            schedule: String::new(),
            next_due_at: now,
            failures: 0,
            watermark: None,
        };
        let (run, end) = match begin_run(db, &due, kind, &seen.profile) {
            Ok(run_id) => {
                tracing::info!(
                    "ck-mc: dreamer: run {run_id} {task} for {project} in workspace {workspace} started"
                );
                let end = self
                    .run_task(
                        db,
                        client,
                        settings,
                        &due,
                        kind,
                        declaration,
                        &seen.root,
                        &seen.profile,
                        run_id,
                        Some(&*members),
                    )
                    .await;
                (Some(run_id), end)
            }
            Err(error) => (
                None,
                RunEnd {
                    outcome: "failed".into(),
                    error: Some(error),
                    ..RunEnd::default()
                },
            ),
        };
        if end.applied > 0 {
            db.changed(crate::app_read::Change::Memories {
                level: "workspace".into(),
                owner: workspace.to_owned(),
            });
        }
        if let Err(error) = db.with_connection(|conn| {
            store::settle_once(conn, &owner, task, workspace, run, &end, now_ms())
        }) {
            tracing::warn!("ck-mc: dreamer: recording {task} for {project} failed: {error}");
        }
        if let Err(error) = db.with_connection(|conn| store::unlock(conn, &owner, &self.holder)) {
            tracing::warn!("ck-mc: dreamer: releasing {project}'s lock failed: {error}");
        }
        tell(db, &owner);
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
                    reason: format!("another writer holds {} memories", whose(&due.owner)),
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
        let end = match begin_run(db, &due, &kind, profile) {
            Ok(run_id) => {
                self.run_task(
                    db,
                    client,
                    settings,
                    &due,
                    &kind,
                    &declaration,
                    root,
                    profile,
                    run_id,
                    None,
                )
                .await
            }
            Err(error) => RunEnd {
                outcome: "failed".into(),
                error: Some(error),
                ..RunEnd::default()
            },
        };
        self.finish_due(db, &due, &end);
    }

    /// Settle a finished run's schedule as its outcome says, then release
    /// the owner's lock.
    fn finish_due(&self, db: &ContextDb, due: &store::Due, end: &RunEnd) {
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
        if let Err(error) = db.with_connection(|conn| {
            store::settle(conn, &due.owner, &due.task, &settled, None, now_ms())
        }) {
            tracing::warn!(
                "ck-mc: dreamer: settling {} for {} failed: {error}",
                due.task,
                due.owner.owner_id
            );
        }
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

    /// Why the person can't start `kind` for `project` now, or the profile's
    /// task id it would run with the project's schedule row. Reads only: the
    /// preview of a run-now asks this, and the run asks it again.
    pub fn run_now_check(
        &self,
        db: &ContextDb,
        project: &str,
        kind: &str,
        now: i64,
    ) -> Result<store::Due, RunNowRefused> {
        let (root, profile) = self
            .projects
            .lock()
            .expect("dreamer projects")
            .get(project)
            .map(|seen| (seen.root.clone(), Arc::clone(&seen.profile)))
            .ok_or(RunNowRefused::NotSeen)?;
        let declaration = profile.body["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|task| task["kind"].as_str() == Some(kind))
            .ok_or(RunNowRefused::NotDeclared)?;
        if !declaration["enabled"].as_bool().unwrap_or(true) {
            return Err(RunNowRefused::Disabled);
        }
        let task = declaration["id"].as_str().unwrap_or(kind);
        let owner = OwnerKey::project(project);
        let due = db
            .with_connection(|conn| store::schedule_of(conn, &owner, task))
            .map_err(|error| RunNowRefused::Store(error.to_string()))?
            .filter(|due| !due.schedule.trim().is_empty())
            .ok_or(RunNowRefused::NotScheduled)?;
        if let Some(missing) = missing_evidence(declaration, &root) {
            return Err(RunNowRefused::Evidence(missing));
        }
        let held = db
            .with_connection(|conn| store::lock_holder(conn, &owner, now))
            .map_err(|error| RunNowRefused::Store(error.to_string()))?;
        if held.is_some() || self.running.lock().expect("dreamer runs").contains(&owner) {
            return Err(RunNowRefused::Locked);
        }
        Ok(due)
    }

    /// Start `kind` for `project` now, for the person. It runs as a
    /// scheduled run does, takes the project's lock first, and settles the
    /// task's schedule when it ends, so it counts as the task's run. Returns
    /// the profile's task id and the run's id once the run is recorded; the
    /// rest of the run continues in the background.
    pub fn run_now<C: RunnerClient + Router + Send + Sync + 'static>(
        self: &Arc<Self>,
        db: &Arc<ContextDb>,
        client: &Arc<C>,
        settings: &Settings,
        project: &str,
        kind: &str,
    ) -> Result<(String, i64), RunNowRefused> {
        let now = now_ms();
        let due = self.run_now_check(db, project, kind, now)?;
        let (root, profile) = self
            .projects
            .lock()
            .expect("dreamer projects")
            .get(project)
            .map(|seen| (seen.root.clone(), Arc::clone(&seen.profile)))
            .ok_or(RunNowRefused::NotSeen)?;
        let declaration = self
            .declarations(&profile)
            .into_iter()
            .find(|declaration| declaration["id"].as_str() == Some(due.task.as_str()))
            .cloned()
            .ok_or(RunNowRefused::NotDeclared)?;
        if !self
            .running
            .lock()
            .expect("dreamer runs")
            .insert(due.owner.clone())
        {
            return Err(RunNowRefused::Locked);
        }
        let release = |engine: &Self| {
            engine
                .running
                .lock()
                .expect("dreamer runs")
                .remove(&due.owner);
        };
        match db.with_connection(|conn| {
            store::lock(
                conn,
                &due.owner,
                &self.holder,
                &due.task,
                now,
                now + LOCK_MS,
            )
        }) {
            Ok(true) => {}
            Ok(false) => {
                release(self);
                return Err(RunNowRefused::Locked);
            }
            Err(error) => {
                release(self);
                return Err(RunNowRefused::Store(error.to_string()));
            }
        }
        let run_id = match begin_run(db, &due, kind, &profile) {
            Ok(run_id) => run_id,
            Err(error) => {
                let _ = db.with_connection(|conn| store::unlock(conn, &due.owner, &self.holder));
                release(self);
                tell(db, &due.owner);
                return Err(RunNowRefused::Store(error));
            }
        };
        tracing::info!(
            "ck-mc: dreamer: run {run_id} {} for {project} started by the person",
            due.task
        );
        let task = due.task.clone();
        let engine = Arc::clone(self);
        let (db, client, settings, kind) = (
            Arc::clone(db),
            Arc::clone(client),
            settings.clone(),
            kind.to_owned(),
        );
        tokio::spawn(async move {
            let end = engine
                .run_task(
                    &db,
                    &*client,
                    &settings,
                    &due,
                    &kind,
                    &declaration,
                    &root,
                    &profile,
                    run_id,
                    None,
                )
                .await;
            engine.finish_due(&db, &due, &end);
            engine
                .running
                .lock()
                .expect("dreamer runs")
                .remove(&due.owner);
        });
        Ok((task, run_id))
    }

    /// Run one task to its end and record the end in its run's row.
    /// `workspace` is the owner's workspace for a task that runs once per
    /// workspace, and `None` for every other.
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
        run_id: i64,
        workspace: Option<&WorkspaceMembers>,
    ) -> RunEnd {
        let mut end = RunEnd::default();
        let (task, demand) = match (self.task(kind), demand(kind)) {
            (Some(task), Some(demand)) => (task, demand),
            _ => {
                end.outcome = "failed".into();
                end.error = Some(format!("no task kind {kind}"));
                if let Err(error) =
                    db.with_connection(|conn| store::finish_run(conn, run_id, &end, now_ms()))
                {
                    tracing::warn!("ck-mc: dreamer: recording run {run_id}'s end failed: {error}");
                }
                return end;
            }
        };
        let owner = if due.owner == OwnerKey::global() {
            Owner::Global
        } else {
            Owner::Project {
                id: due.owner.owner_id.clone(),
                root: root.to_owned(),
            }
        };
        let batches = {
            let context = TaskContext {
                db,
                owner: &owner,
                profile,
                declaration,
                workspace,
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
                end.error = Some(format!(
                    "{} lock passed to another writer",
                    whose(&due.owner)
                ));
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
                    if applied.applied > 0 {
                        use crate::app_read::Change;
                        let change = match due.owner.level.as_str() {
                            "project" => Some(Change::project_memories(&due.owner.owner_id)),
                            "global" => Some(Change::global_memories()),
                            _ => None,
                        };
                        if let Some(change) = change {
                            db.changed(change);
                        }
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
                    end.error = Some(format!(
                        "{} lock passed to another writer",
                        whose(&due.owner)
                    ));
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

/// Why a person's run-now can't start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunNowRefused {
    /// No session of the project has been set up in this process, so the
    /// engine doesn't know its folder or profile.
    NotSeen,
    /// The project's profile declares no task of this kind.
    NotDeclared,
    /// The profile switches the task off.
    Disabled,
    /// The task has no schedule for the project, or the settings switch it
    /// off.
    NotScheduled,
    /// A writer holds the project's lock, or a run of it is in progress.
    Locked,
    /// The task reads files this machine doesn't have for the project.
    Evidence(String),
    Store(String),
}

/// Record the start of a run that holds its owner's lock, and tell the
/// project's dreamer page it is running. Why recording failed otherwise.
fn begin_run(
    db: &ContextDb,
    due: &store::Due,
    kind: &str,
    profile: &Profile,
) -> Result<i64, String> {
    match db.with_connection(|conn| {
        store::start_run(conn, &due.owner, &due.task, kind, &profile.name, now_ms())
    }) {
        Ok(id) => {
            tell(db, &due.owner);
            Ok(id)
        }
        Err(error) => Err(format!("recording the run failed: {error}")),
    }
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

/// Whose memories `owner` names, in the messages a run records.
fn whose(owner: &OwnerKey) -> &'static str {
    if owner.level == "global" {
        "the person's"
    } else {
        "the project's"
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

/// How long a once-per-workspace task whose run did not complete waits
/// before a round tries it again: this long for each such run in a row, up
/// to [`ONCE_RETRY_MAX`].
const ONCE_RETRY: i64 = 60 * 60_000;
const ONCE_RETRY_MAX: i64 = 24 * 60 * 60_000;

/// When a once-per-workspace task with `record` may next run for
/// `workspace`; `None` once a run completed for that workspace.
fn once_retry_at(record: &store::OnceRecord, workspace: &str) -> Option<i64> {
    if record.done_for.as_deref() == Some(workspace) {
        return None;
    }
    match record.last_run_at {
        Some(last) if record.failures > 0 => {
            Some(last + (ONCE_RETRY * record.failures).min(ONCE_RETRY_MAX))
        }
        _ => Some(0),
    }
}

fn now_ms() -> i64 {
    crate::summary::run::now_ms()
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "engine_lift_tests.rs"]
mod lift_tests;
