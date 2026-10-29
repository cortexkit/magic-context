//! The Rust dreamer's tick and manual entry for one project.
//!
//! A run starts on a background worker (`background::dreamer_tick` or
//! `background::manual_dream`), which resolves the trusted config once for the
//! whole run. From that one snapshot the run computes the published list
//! (`ownership::publish`) for the project and dispatches only those tasks: a
//! project whose user switched Rust off gets nothing. A Broca run uses the
//! configured Broca runner. A project last seen on a runner-lane conversation (a
//! route the daemon stamped with that conversation's runner module) sends its
//! children to that runner, under that session, through the same llm-runner
//! carrier as Broca.
//!
//! When this build can register a dream project scope, a run instead takes the
//! routed path (`routed`): every child is placed by routing under the run's own
//! project scope, with no conversation and no parent session. Which path a
//! project takes is `routed::choose_path`.
//!
//! Projects to tick are remembered in memory (the route a project was last
//! seen on) and in the scheduler database's `dream_targets` table, so a restart
//! keeps ticking every project served within [`PERSISTED_TARGET_TTL_MS`].
//!
//! Before planning, each task's Rust schedule adopts the TypeScript scheduler's
//! progress, and after the run the TypeScript row adopts Rust's (see
//! `mc_store::dream_schedule_bridge`), so a flip of ownership inside one cron
//! period neither repeats nor skips a run. The dispatcher repeats both steps
//! while it holds the shared domain lease (adopt before claiming, publish before
//! releasing), which is what keeps a TypeScript dreamer that never asks ck-mc
//! for its published list from running the same slot; the publish after the run
//! here only repeats that write.

use super::broca_carrier::BrocaToolRoute;
use super::broca_port::SubcBroca;
use super::context::{Cancellation, Clock};
use super::dispatcher::{DispatchOutcome, Dispatcher};
use super::executor::{BrocaPorts, DreamExecutor, NoBroca, Transport};
use super::ownership::{self, OwnershipInput, Wiring};
use super::routed::carrier::RoutedParks;
use super::routed::registry::OPERATIONAL_TASKS;
use super::routed::wire::{DreamWire, ProductionWire, WireRefusal};
use super::routed::{choose_path, DreamPath};
use crate::background::{self, ConfigInput};
use crate::config_parity::{ConfigResolveRequest, CoreConfigResolver};
use crate::dream_runner::resolve_task_models;
use crate::historian_runner::{uses_session_runner, HistorianRunnerKind};
use crate::route_targets::{RouteTargetConfig, SessionRunnerRoute};
use mc_store::dream_scheduler::schedules::{TaskConfig, TaskName};
use mc_store::dream_scheduler::targets::DreamTargetRow;
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::{
    CapabilityResult, Generation, ProjectId, SessionId, StoreScope,
};
use mc_store::McStore;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// How often the timer looks for due dream tasks; the TypeScript timer's
/// cadence is 15 minutes, and a cron slot is never finer than a minute.
pub const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// A project not seen on any dream route for this long is no longer ticked.
pub const TARGET_TTL_MS: i64 = 60 * 60_000;
/// A project in `dream_targets` not served for this long stops being ticked and
/// its row is deleted. Three days covers a weekend away from a project, so its
/// nightly dreams keep running, while a deleted or abandoned project stops
/// within days rather than lingering.
pub const PERSISTED_TARGET_TTL_MS: i64 = 3 * 24 * 60 * 60_000;
/// How often one project's sighting is written to `dream_targets`. Every
/// served turn sees the project; a row a few minutes old ticks just as well.
const PERSIST_EVERY_MS: i64 = 5 * 60_000;
/// The store session of a routed run's schedule claims. A routed run has no
/// conversation; the scheduler still needs a non-empty session to fence its
/// leases, and this name is that fence, never a parent session.
pub const ROUTED_STORE_SESSION: &str = "mc-dream-project";
/// Entorhinal had no registered project for the folder right before the run,
/// so the run was skipped.
pub const PROJECT_UNRESOLVED: &str = "mc_dream_project_unresolved";
/// The longest one task may run before the dispatcher aborts it.
pub const TASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

static ROUTED_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct RoutedRunPermit;

impl RoutedRunPermit {
    fn acquire() -> Option<Self> {
        let mut running = ROUTED_RUNS.load(Ordering::Acquire);
        loop {
            if running >= 2 {
                return None;
            }
            match ROUTED_RUNS.compare_exchange_weak(
                running,
                running + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self),
                Err(current) => running = current,
            }
        }
    }
}

impl Drop for RoutedRunPermit {
    fn drop(&mut self) {
        ROUTED_RUNS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The route a project was last seen on: where its child sessions run and which
/// conversation's runner the dispatcher should use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamTarget {
    pub directory: PathBuf,
    pub session: String,
    pub harness: String,
    pub seen_at_ms: i64,
    /// The runner of the conversation this route belongs to, when it is a runner
    /// lane; its session is [`Self::session`].
    pub session_runner: Option<SessionRunnerRoute>,
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

/// Process-wide state of the Rust dreamer.
pub struct DreamRuns {
    targets: Mutex<HashMap<String, DreamTarget>>,
    in_flight: Arc<Mutex<HashSet<String>>>,
    timer: AtomicBool,
    /// The connection to the configured runner module, when this process declares a
    /// background-completion route to one. Without it no Broca run is possible.
    broca: Option<(PathBuf, RouteTargetConfig)>,
    /// The daemon connection, which is all a runner-lane conversation's own runner
    /// needs: its route target comes from the conversation, not from configuration.
    connection_file: Option<PathBuf>,
    resolver: OnceLock<Arc<dyn CoreConfigResolver>>,
    clock: OnceLock<Arc<dyn Clock>>,
    /// How routed runs reach Entorhinal, the daemon, routing and runners.
    wire: OnceLock<Arc<dyn DreamWire>>,
    /// Routing's timed refusals, per project and consumer, across runs.
    parks: Arc<RoutedParks>,
    /// When each project's sighting was last written to `dream_targets`.
    persisted: Mutex<HashMap<String, i64>>,
}

impl DreamRuns {
    pub fn new(connection_file: Option<PathBuf>, route_targets: &RouteTargetConfig) -> Self {
        Self {
            targets: Mutex::default(),
            in_flight: Arc::default(),
            timer: AtomicBool::new(false),
            broca: connection_file
                .clone()
                .filter(|_| SubcBroca::target(route_targets).is_some())
                .map(|file| (file, route_targets.clone())),
            connection_file,
            resolver: OnceLock::new(),
            clock: OnceLock::new(),
            wire: OnceLock::new(),
            parks: Arc::default(),
            persisted: Mutex::default(),
        }
    }

    /// Whether a Broca transport for dream children is wired in this process.
    pub fn broca_wired(&self) -> bool {
        self.broca.is_some()
    }

    /// Whether dream children can be sent to the runner that owns their parent
    /// session (only a daemon connection is needed for that).
    pub fn session_runner_wired(&self) -> bool {
        self.connection_file.is_some()
    }

    /// Remember where `project` was last seen.
    pub fn record(&self, project: &str, target: DreamTarget) {
        if let Ok(mut targets) = self.targets.lock() {
            targets.insert(project.to_owned(), target);
        }
    }

    fn target(&self, project: &str) -> Option<DreamTarget> {
        self.targets.lock().ok()?.get(project).cloned()
    }

    #[cfg(test)]
    pub(crate) fn target_for_test(&self, project: &str) -> Option<DreamTarget> {
        self.target(project)
    }

    fn fresh_projects(&self, now_ms: i64) -> Vec<String> {
        self.targets
            .lock()
            .map(|targets| {
                targets
                    .iter()
                    .filter(|(_, t)| now_ms.saturating_sub(t.seen_at_ms) < TARGET_TTL_MS)
                    .map(|(project, _)| project.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Replace the config resolver for a hermetic test; production resolves the
    /// trusted user and project config from the environment.
    pub fn use_resolver(&self, resolver: Arc<dyn CoreConfigResolver>) {
        let _ = self.resolver.set(resolver);
    }

    /// Replace the clock for a hermetic test.
    pub fn use_clock(&self, clock: Arc<dyn Clock>) {
        let _ = self.clock.set(clock);
    }

    fn resolver(&self) -> Arc<dyn CoreConfigResolver> {
        self.resolver
            .get_or_init(|| {
                Arc::new(crate::config_parity::TrustedConfigResolver::from_environment())
            })
            .clone()
    }

    fn clock(&self) -> Arc<dyn Clock> {
        self.clock.get_or_init(|| Arc::new(SystemClock)).clone()
    }

    /// Replace the routed wire for a hermetic test; production uses
    /// [`ProductionWire`].
    pub fn use_wire(&self, wire: Arc<dyn DreamWire>) {
        let _ = self.wire.set(wire);
    }

    fn wire(&self) -> Arc<dyn DreamWire> {
        self.wire
            .get_or_init(|| {
                Arc::new(ProductionWire::new(
                    self.connection_file.clone().unwrap_or_default(),
                    crate::DEFAULT_MODULE_ID.into(),
                ))
            })
            .clone()
    }
}

/// The scheduler database of `store`'s dream runs, opened active. Only callers
/// that already know the Rust dreamer is switched on use it.
pub(crate) fn open_scheduler(store: &McStore) -> Result<SqliteDreamScheduler, String> {
    let root = store
        .data_dir()
        .ok_or("dream data directory unavailable")?
        .join("dream");
    mc_store::private_permissions::ensure_directory(&root, true).map_err(|e| e.to_string())?;
    SqliteDreamScheduler::open(root.join("scheduler.db"), true).map_err(|e| format!("{e:?}"))
}

fn persisted_target(store: &McStore, project: &str) -> Option<DreamTargetRow> {
    open_scheduler(store).ok()?.target(project).ok().flatten()
}

/// What one run did, task by task. Empty when nothing was published or due.
pub type RunReport = Vec<(TaskName, DispatchOutcome)>;

/// A requested manual run of one task, under a durable command id.
#[derive(Debug, Clone)]
pub struct ManualRun {
    pub task: TaskName,
    pub command_id: String,
}

/// The shared handles a run needs, cloned out of the handler so the timer and
/// the worker threads outlive no borrow.
#[derive(Clone)]
pub struct DreamHandles {
    pub store: Arc<OnceLock<Arc<McStore>>>,
    pub broca_routes: Arc<BrocaToolRoute>,
    pub runs: Arc<DreamRuns>,
    pub wiring: Wiring,
    pub module_id: String,
}

/// Removes a project from the in-flight set when its worker ends, however it ends.
struct InFlight {
    set: Arc<Mutex<HashSet<String>>>,
    project: String,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.project);
        }
    }
}

/// A started run: the worker resolves config, then reports what it dispatched.
pub type Job = std::thread::JoinHandle<Result<Option<Result<RunReport, String>>, String>>;

impl DreamHandles {
    /// Start one run for `project` on a background worker: the scheduled tick, or
    /// with `manual` one forced task on the manual entry. Returns `None` when the
    /// project was never seen (neither on a dream route nor in `dream_targets`),
    /// its store is not open, or a run for it is already in flight.
    pub fn start(&self, project: &str, manual: Option<ManualRun>) -> Option<Job> {
        let store = self.store.get()?.clone();
        // Without a project-scope route, children still use the conversation's
        // session runner or the configured Broca transport.
        let legacy = self.runs.target(project).map(|target| {
            (
                target.directory,
                target.session,
                target.harness,
                target.session_runner,
            )
        });
        let wire = self.runs.wire();
        let mut support = wire.scope_support();
        let workdir = if support.is_ok() {
            let folder = persisted_target(&store, project)
                .map(|row| PathBuf::from(row.workdir))
                .or_else(|| legacy.as_ref().map(|(directory, ..)| directory.clone()));
            if let Some(folder) = &folder {
                support = wire.scope_support_for(folder);
            }
            folder
        } else {
            None
        };
        match choose_path(support, legacy.is_some()) {
            Ok(DreamPath::Legacy) => self.start_legacy(store, project, legacy?, manual),
            Ok(DreamPath::Routed) => {
                // A routed run needs only the project's folder: the persisted
                // sighting, or the route it was last seen on in this process.
                self.start_routed(store, project, workdir?, manual)
            }
            Err(refusal) => {
                let row = persisted_target(&store, project)?;
                self.start_refused(project, PathBuf::from(row.workdir), refusal, manual)
            }
        }
    }

    fn in_flight(&self, project: &str) -> Option<InFlight> {
        let mut in_flight = self.runs.in_flight.lock().ok()?;
        if !in_flight.insert(project.to_owned()) {
            return None;
        }
        Some(InFlight {
            set: self.runs.in_flight.clone(),
            project: project.to_owned(),
        })
    }

    fn config_input(&self, directory: &Path) -> ConfigInput {
        ConfigInput {
            resolver: self.runs.resolver(),
            request: ConfigResolveRequest {
                user_config_path: String::new(),
                project_root: directory.to_string_lossy().into_owned(),
                generation: Generation(0),
            },
        }
    }

    fn spawn(
        input: ConfigInput,
        manual: bool,
        work: impl FnOnce(background::Unit) -> Result<RunReport, String> + Send + 'static,
    ) -> Option<Job> {
        let job = if manual {
            background::manual_dream(input, work)
        } else {
            background::dreamer_tick(input, work)
        };
        job.ok()
    }

    #[allow(clippy::type_complexity)]
    fn start_legacy(
        &self,
        store: Arc<McStore>,
        project: &str,
        (directory, session, harness, session_runner): (
            PathBuf,
            String,
            String,
            Option<SessionRunnerRoute>,
        ),
        manual: Option<ManualRun>,
    ) -> Option<Job> {
        let guard = self.in_flight(project)?;
        let input = self.config_input(&directory);
        let handles = self.clone();
        let project = project.to_owned();
        let manual_entry = manual.is_some();
        let work = move |unit: background::Unit| {
            let _guard = guard;
            let captured = unit.captured_dream_config(harness.clone(), directory.clone());
            let run = Run {
                handles: &handles,
                store,
                project: &project,
                session: &session,
                harness: &harness,
                session_runner: session_runner.as_ref(),
            };
            run.execute(captured, manual)
        };
        Self::spawn(input, manual_entry, work)
    }

    fn start_routed(
        &self,
        store: Arc<McStore>,
        project: &str,
        workdir: PathBuf,
        manual: Option<ManualRun>,
    ) -> Option<Job> {
        let permit = RoutedRunPermit::acquire()?;
        let guard = self.in_flight(project)?;
        let input = self.config_input(&workdir);
        let handles = self.clone();
        let project = project.to_owned();
        let manual_entry = manual.is_some();
        let work = move |unit: background::Unit| {
            let _permit = permit;
            let _guard = guard;
            // A routed run has no conversation, so no harness block of the
            // dreamer config applies; schedules are read harness-free anyway.
            let captured = unit.captured_dream_config(String::new(), workdir);
            RoutedRun {
                handles: &handles,
                store,
                project: &project,
            }
            .execute(captured, manual)
        };
        Self::spawn(input, manual_entry, work)
    }

    /// A project only the routed path could carry, while this build cannot
    /// register its scope: the run sends nothing and reports its tasks refused
    /// by the scope refusal's name (every registered task for a scheduled tick,
    /// the requested task for a manual run).
    fn start_refused(
        &self,
        project: &str,
        workdir: PathBuf,
        refusal: WireRefusal,
        manual: Option<ManualRun>,
    ) -> Option<Job> {
        let guard = self.in_flight(project)?;
        let input = self.config_input(&workdir);
        let manual_entry = manual.is_some();
        let work = move |_: background::Unit| {
            let _guard = guard;
            let tasks = manual.map_or_else(|| OPERATIONAL_TASKS.to_vec(), |m| vec![m.task]);
            Ok(tasks
                .into_iter()
                .map(|task| (task, DispatchOutcome::Refused(refusal.code.clone())))
                .collect())
        };
        Self::spawn(input, manual_entry, work)
    }

    /// Remember that `project` was served in `directory`, durably, so a restart
    /// keeps ticking it. Throttled per project to [`PERSIST_EVERY_MS`]. Only
    /// called while the Rust dreamer is switched on.
    pub(crate) fn persist_target(&self, project: &str, directory: &Path) {
        let now = crate::now_ms();
        {
            let Ok(mut persisted) = self.runs.persisted.lock() else {
                return;
            };
            if persisted
                .get(project)
                .is_some_and(|at| now.saturating_sub(*at) < PERSIST_EVERY_MS)
            {
                return;
            }
            persisted.insert(project.to_owned(), now);
        }
        let Some(store) = self.store.get() else {
            return;
        };
        let row = DreamTargetRow {
            project: project.to_owned(),
            workdir: directory.to_string_lossy().into_owned(),
            project_id: None,
            seen_at: now,
        };
        if let Err(error) = open_scheduler(store)
            .and_then(|scheduler| scheduler.record_target(&row).map_err(|e| format!("{e:?}")))
        {
            tracing::warn!(project, error, "could not record the dream target");
        }
    }

    /// Every project the timer should tick now: those seen in this process within
    /// [`TARGET_TTL_MS`], and those in `dream_targets` within
    /// [`PERSISTED_TARGET_TTL_MS`] (older rows are deleted here).
    pub fn due_projects(&self) -> Vec<String> {
        let now = self.runs.clock().now_ms();
        let mut projects = self.runs.fresh_projects(now);
        if let Some(store) = self.store.get() {
            // Sightings are written with the wall clock, so they age by it too.
            let persisted = open_scheduler(store)
                .and_then(|scheduler| {
                    scheduler
                        .live_targets(crate::now_ms(), PERSISTED_TARGET_TTL_MS)
                        .map_err(|e| format!("{e:?}"))
                })
                .unwrap_or_default();
            for row in persisted {
                if !projects.contains(&row.project) {
                    projects.push(row.project);
                }
            }
        }
        projects
    }

    /// One timer tick: start a run for every due project. The workers run
    /// detached; their outcomes land in the schedule rows.
    pub fn tick_once(&self) -> Vec<Job> {
        self.due_projects()
            .iter()
            .filter_map(|project| self.start(project, None))
            .collect()
    }

    /// Start the process timer once, on the current tokio runtime.
    pub fn ensure_timer(&self) {
        if self.runs.timer.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.runs.timer.store(false, Ordering::Release);
            return;
        };
        let handles = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                // Each worker runs detached; its outcome is in the schedule rows.
                drop(handles.tick_once());
            }
        });
    }
}

struct Run<'a> {
    handles: &'a DreamHandles,
    store: Arc<McStore>,
    project: &'a str,
    session: &'a str,
    harness: &'a str,
    session_runner: Option<&'a SessionRunnerRoute>,
}

impl Run<'_> {
    fn execute(
        &self,
        captured: Arc<super::context::CapturedConfig>,
        manual: Option<ManualRun>,
    ) -> Result<RunReport, String> {
        // An explicit `broca` keeps a runner lane on the configured Broca module;
        // `host` or no choice means the conversation's own runner.
        let session_runner = self
            .session_runner
            .filter(|_| uses_session_runner(captured.route.dreamer_runner_for(self.harness)));
        let published = ownership::publish_on(
            &OwnershipInput {
                config: &captured.route,
                settings: Some(&captured.effective),
                harness: self.harness,
                wiring: &self.handles.wiring,
            },
            session_runner.map(|_| self.handles.runs.session_runner_wired()),
        );
        if published.published.is_empty() {
            return Ok(Vec::new());
        }
        let root = self
            .store
            .data_dir()
            .ok_or("dream data directory unavailable")?
            .join("dream");
        mc_store::private_permissions::ensure_directory(&root, true).map_err(|e| e.to_string())?;
        let scheduler = Arc::new(
            SqliteDreamScheduler::open(root.join("scheduler.db"), captured.activated)
                .map_err(|e| format!("{e:?}"))?,
        );
        let scope = StoreScope {
            project: ProjectId(self.project.to_owned()),
            session: SessionId(self.session.to_owned()),
            generation: Generation(1),
        };
        let configs: Vec<TaskConfig> = published
            .published
            .iter()
            .map(|task| self.task_config(*task, &captured.effective))
            .collect::<Result<_, String>>()?;
        for config in &configs {
            if let Ok(Some(legacy)) = self.store.legacy_task_schedule(self.project, config.task) {
                let _ = scheduler.adopt_legacy(&scope, config, &legacy);
            }
        }
        let report = match (session_runner, published.runner.kind) {
            (Some(route), _) => {
                let Some(connection_file) = &self.handles.runs.connection_file else {
                    return Ok(Vec::new());
                };
                let transport = Transport::Broca {
                    ports: SubcBroca {
                        connection_file: connection_file.clone(),
                        route_targets: RouteTargetConfig::default(),
                        project_root: captured.directory.clone(),
                        harness: self.harness.to_owned(),
                        session_runner: Some(route.clone()),
                    },
                    routes: self.handles.broca_routes.clone(),
                    module_id: self.handles.module_id.clone(),
                };
                self.dispatch(
                    transport,
                    &scheduler,
                    &scope,
                    &captured,
                    &configs,
                    &published.published,
                    manual,
                )
            }
            // Off a runner lane, the host runner has no carrier: `ownership::publish`
            // withholds every task for it, so a run never gets here.
            (None, HistorianRunnerKind::Host) => return Ok(Vec::new()),
            (None, HistorianRunnerKind::Broca) => {
                let Some((connection_file, route_targets)) = &self.handles.runs.broca else {
                    return Ok(Vec::new());
                };
                let transport = Transport::Broca {
                    ports: SubcBroca {
                        connection_file: connection_file.clone(),
                        route_targets: route_targets.clone(),
                        project_root: captured.directory.clone(),
                        harness: self.harness.to_owned(),
                        session_runner: None,
                    },
                    routes: self.handles.broca_routes.clone(),
                    module_id: self.handles.module_id.clone(),
                };
                self.dispatch(
                    transport,
                    &scheduler,
                    &scope,
                    &captured,
                    &configs,
                    &published.published,
                    manual,
                )
            }
        };
        for config in &configs {
            if let CapabilityResult::Available { value: Some(state) } =
                scheduler.schedule(&scope, config.task)
            {
                let _ = self
                    .store
                    .publish_task_schedule(self.project, config.task, &state);
            }
        }
        Ok(report)
    }

    fn task_config(
        &self,
        task: TaskName,
        settings: &serde_json::Value,
    ) -> Result<TaskConfig, String> {
        task_config(&self.store, self.project, self.harness, task, settings)
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch<B: BrocaPorts>(
        &self,
        transport: Transport<B>,
        scheduler: &Arc<SqliteDreamScheduler>,
        scope: &StoreScope,
        captured: &Arc<super::context::CapturedConfig>,
        configs: &[TaskConfig],
        published: &[TaskName],
        manual: Option<ManualRun>,
    ) -> RunReport {
        let dispatcher = Dispatcher {
            store: self.store.clone(),
            scheduler: scheduler.clone(),
            scope: scope.clone(),
            config: captured.clone(),
            clock: self.handles.runs.clock(),
            executor: DreamExecutor::new(
                self.store.clone(),
                scheduler.clone(),
                transport,
                published,
                &self.handles.wiring.tasks,
            )
            .with_project_context(
                Arc::new(crate::memory_context::MemoryContextReader::new(
                    self.handles.runs.connection_file.clone(),
                    subc_protocol::BindIdentity::new(
                        captured.directory.clone(),
                        self.harness,
                        self.session,
                    ),
                )),
                captured.directory.clone(),
                self.harness,
            ),
        };
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Vec::new();
        };
        runtime.block_on(drive(
            dispatcher,
            configs,
            captured.route.memory_enabled,
            manual,
        ))
    }
}

fn task_config(
    store: &McStore,
    project: &str,
    harness: &str,
    task: TaskName,
    settings: &serde_json::Value,
) -> Result<TaskConfig, String> {
    let legacy = store
        .legacy_task_schedule(project, task)
        .map_err(|e| e.to_string())?;
    Ok(TaskConfig {
        task,
        schedule: resolve_task_models(settings, harness, task.as_str())
            .schedule
            .unwrap_or_default(),
        has_input: true,
        legacy_last_run_at: legacy.and_then(|l| l.last_run_at),
    })
}

/// Run the manual task, or every due task, through `dispatcher`.
async fn drive<E: super::dispatcher::TaskExecutor>(
    mut dispatcher: Dispatcher<E>,
    configs: &[TaskConfig],
    memory_enabled: bool,
    manual: Option<ManualRun>,
) -> RunReport {
    match manual {
        Some(manual) => {
            let Some(config) = configs.iter().find(|c| c.task == manual.task) else {
                return vec![(manual.task, DispatchOutcome::Unavailable)];
            };
            let outcome = dispatcher
                .manual(
                    config,
                    &manual.command_id,
                    TASK_TIMEOUT,
                    Cancellation::default(),
                )
                .await;
            vec![(manual.task, outcome)]
        }
        None => dispatcher
            .tick(configs, memory_enabled, TASK_TIMEOUT)
            .await
            .unwrap_or_default(),
    }
}

/// One routed run of a project: every registered task, placed by routing under
/// the run's own project scope, with no conversation behind it.
struct RoutedRun<'a> {
    handles: &'a DreamHandles,
    store: Arc<McStore>,
    project: &'a str,
}

impl RoutedRun<'_> {
    fn execute(
        &self,
        captured: Arc<super::context::CapturedConfig>,
        manual: Option<ManualRun>,
    ) -> Result<RunReport, String> {
        let root = self
            .store
            .data_dir()
            .ok_or("dream data directory unavailable")?
            .join("dream");
        mc_store::private_permissions::ensure_directory(&root, true).map_err(|e| e.to_string())?;
        let scheduler = Arc::new(
            SqliteDreamScheduler::open(root.join("scheduler.db"), captured.activated)
                .map_err(|e| format!("{e:?}"))?,
        );
        let scope = StoreScope {
            project: ProjectId(self.project.to_owned()),
            session: SessionId(ROUTED_STORE_SESSION.to_owned()),
            generation: Generation(1),
        };
        let configs: Vec<TaskConfig> = OPERATIONAL_TASKS
            .iter()
            .map(|task| task_config(&self.store, self.project, "", *task, &captured.effective))
            .collect::<Result<_, String>>()?;
        for config in &configs {
            if let Ok(Some(legacy)) = self.store.legacy_task_schedule(self.project, config.task) {
                let _ = scheduler.adopt_legacy(&scope, config, &legacy);
            }
        }
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Ok(Vec::new());
        };
        let wire = self.handles.runs.wire();
        let report = runtime.block_on(async {
            // The project id is Entorhinal's answer for this folder right now,
            // never the id a previous run stored.
            let Some(project_id) = wire.lookup_project(&captured.directory).await else {
                let tasks =
                    manual.map_or_else(|| OPERATIONAL_TASKS.to_vec(), |m| vec![m.task]);
                return tasks
                    .into_iter()
                    .map(|task| (task, DispatchOutcome::Refused(PROJECT_UNRESOLVED.into())))
                    .collect();
            };
            match scheduler.set_target_project_id(self.project, project_id.as_str()) {
                Ok(Some(previous)) if previous != project_id.as_str() => {
                    crate::project_identity::log_once(
                        format!("dream-target-project:{}:{}", self.project, project_id.as_str()),
                        &format!(
                            "Entorhinal now answers {} for dream target {} (was {previous}); using the new answer",
                            project_id.as_str(),
                            self.project
                        ),
                    );
                }
                _ => {}
            }
            let dispatcher = Dispatcher {
                store: self.store.clone(),
                scheduler: scheduler.clone(),
                scope: scope.clone(),
                config: captured.clone(),
                clock: self.handles.runs.clock(),
                executor: DreamExecutor::new(
                    self.store.clone(),
                    scheduler.clone(),
                    Transport::<NoBroca>::Routed {
                        wire: wire.clone(),
                        routes: self.handles.broca_routes.clone(),
                        module_id: self.handles.module_id.clone(),
                        project_id,
                        parks: self.handles.runs.parks.clone(),
                    },
                    OPERATIONAL_TASKS,
                    OPERATIONAL_TASKS,
                ).with_project_context(Arc::new(crate::memory_context::MemoryContextReader::new(
                    self.handles.runs.connection_file.clone(),
                    subc_protocol::BindIdentity::new(captured.directory.clone(), "magic-context", ROUTED_STORE_SESSION),
                )), captured.directory.clone(), ""),
            };
            drive(
                dispatcher,
                &configs,
                captured.route.memory_enabled,
                manual,
            )
            .await
        });
        for config in &configs {
            if let CapabilityResult::Available { value: Some(state) } =
                scheduler.schedule(&scope, config.task)
            {
                let _ = self
                    .store
                    .publish_task_schedule(self.project, config.task, &state);
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;

    #[test]
    fn routed_runs_share_two_process_slots_and_return_them() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "dream_dispatch::tick::concurrency_tests::isolated_routed_run_slots",
            ])
            .env("MC_RUN_CAP_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn isolated_routed_run_slots() {
        if std::env::var_os("MC_RUN_CAP_CHILD").is_none() {
            return;
        }
        let first = RoutedRunPermit::acquire().unwrap();
        let second = RoutedRunPermit::acquire().unwrap();
        assert!(RoutedRunPermit::acquire().is_none());
        drop(first);
        let next = RoutedRunPermit::acquire().unwrap();
        assert!(RoutedRunPermit::acquire().is_none());
        drop((second, next));
        assert_eq!(ROUTED_RUNS.load(Ordering::Acquire), 0);
    }
}
