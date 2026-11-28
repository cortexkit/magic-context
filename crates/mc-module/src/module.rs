//! The module: routes each call to its session's worker. Every session has
//! one worker task that handles its jobs strictly in order (Setup, notices,
//! rides, tool calls), so a session's state is never touched by two jobs at
//! once, and one session waiting on its runner never holds up another.
//!
//! Notices are acknowledged before their work runs, so a runner never waits
//! on ck-mc to send its next request. Rides and tool calls wait for their
//! answer, within the deadline the runner gave.
//!
//! A summarizer run is the one piece of a session's work that runs beside
//! its worker: it can take minutes, and the session keeps answering rides
//! meanwhile. Its result comes back as a job of its own.
//!
//! Project upkeep (memory and commit vectors, commit indexing; see
//! [`crate::upkeep`]) runs on a timer of its own, for every project a
//! session used in the last hour, one project at a time.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_compaction::notice::{NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
use cortexkit_role_compaction::setup::{SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::View;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::client::RunnerClient;
use crate::config::Config;
use crate::context_db::ContextDb;
pub use crate::dreamer::runtime::build as build_dreamer_runtime;
use crate::entorhinal_changes;
pub use crate::entorhinal_changes::MarkerTask;
use crate::pass::Settings;
use crate::pre_user::Addition;
use crate::preset;
use crate::route::Route;
use crate::routing::Router;
use crate::session::Session;
use crate::store::Store;
use crate::summary::run;

/// How long a runner waits for the `pre_user` hook before storing the
/// message as it is: the budget ck-mc declares for it.
pub const PRE_USER_BUDGET: Duration = Duration::from_millis(1_500);

/// A call ck-mc refuses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleError {
    /// The preset names nothing Magic Context knows.
    UnknownPreset(String),
    /// A call for a session that never had a Setup.
    UnknownSession,
    /// The session's catalog does not serve this tool.
    UnknownTool(String),
    /// The session's worker stopped.
    Stopped,
    /// A tool call failed; the text is for the model.
    Tool(String),
    /// A move holds the session ([`crate::agent_data`]).
    Gated(crate::agent_data::Gated),
}

pub struct Module<C> {
    inner: Arc<Inner<C>>,
}

impl<C> Clone for Module<C> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

struct Inner<C> {
    app_read: crate::app_read::AppRead,
    context_read: crate::context_read::ContextRead,
    client: Arc<C>,
    search: Option<crate::search::background::Background>,
    /// Where each session's settings come from. They are resolved again for
    /// every job, so a configuration edit applies from the session's next
    /// pass.
    config: Arc<Config>,
    /// Where summaries are stored. Without it they live only in memory, which
    /// only tests want.
    db: Option<Arc<ContextDb>>,
    /// Where each session's own decisions survive a restart.
    store: Option<Arc<Store>>,
    /// Which sessions a move holds. Checked before a job is queued or a
    /// worker created, and again when a worker takes a job off its queue.
    journal: Arc<crate::agent_data::Journal>,
    /// Each session's worker, or what its worker kept of the session once
    /// the session went quiet ([`Slot`]). Jobs are sent under this lock, and
    /// a worker gives its place up only under it, with its queue empty, so
    /// no job ever reaches a worker that stopped.
    workers: Mutex<HashMap<SessionRef, Slot>>,
    /// The sessions set up in this process, each with the statement epoch
    /// its newest Setup named (`None` when it named none). Every notice and
    /// ride is checked against it as it arrives, before it is queued (see
    /// the `statement_order` module). In memory only: after a restart every
    /// session is set up again.
    set_up: Mutex<HashMap<SessionRef, Option<String>>>,
    setup_count: AtomicUsize,
    /// Summarizer runs in progress, so [`Module::idle`] can wait for them.
    summaries_running: Mutex<usize>,
    /// The same work counted per session, for a move's `busy`.
    runs: Arc<crate::agent_data::busy::Runs>,
    /// The `agent-data` service, when this build serves moves.
    agent_data: crate::agent_data::Service,
    /// Each session's project, from its Setup route's scope.
    session_projects: Arc<Mutex<HashMap<SessionRef, crate::route::Project>>>,
    /// Projects with recent activity: folder and the last Setup or notice
    /// time, keyed by project id. Upkeep runs for these.
    active_projects: Mutex<HashMap<String, (String, i64)>>,
    /// The dreamer, which runs scheduled memory tasks for the projects this
    /// process has sessions of. `None` without `context.db`.
    dreamer: Option<Arc<crate::dreamer::engine::Engine>>,
    labs: Arc<crate::dreamer::lab::Registry>,
    dreamer_enabled: AtomicBool,
    #[cfg(feature = "memory-replica")]
    replica_health: std::sync::OnceLock<Arc<crate::replica::health::Health>>,
    /// Wakes the rounds that move a 0.49 store's project rows when a Setup
    /// names a project id this process hasn't seen.
    legacy_wake: Arc<crate::legacy_projects::Wake>,
    /// The publisher of the docs-upkeep proposals' bus notices, once the
    /// process set one ([`Module::publish_docs_notices_with`]).
    docs_notices: std::sync::OnceLock<Arc<crate::bus::DocsNotices>>,
    /// The publisher of the attribution facts' bus events, once the process
    /// set one ([`Module::publish_attribution_with`]).
    attribution_events: std::sync::OnceLock<Arc<crate::bus::AttributionEvents>>,
    /// Each set-up session's folder, which its workspace is read for again
    /// when Entorhinal's registry changes ([`Module::spawn_entorhinal_follow`]).
    session_folders: Mutex<HashMap<SessionRef, String>>,
    /// Whether the watch on Entorhinal's change markers is up.
    entorhinal_watch: Arc<crate::entorhinal_changes::WatchState>,
}

enum Job {
    Command {
        request: crate::user_commands::Request,
        reply: oneshot::Sender<Result<Value, subc_protocol::ErrorBody>>,
    },
    Setup(Route, SetupRequest, preset::Features),
    Notice(NoticeRequest),
    Ride(RideRequest, oneshot::Sender<Option<View>>),
    Tool {
        route: Route,
        name: String,
        input: Value,
        /// The call carries the tool-provider role's `fork_id`: a quick
        /// question a runner forked off the session, which must change
        /// nothing anyone can observe ([`Session::tool_timed`]).
        fork: bool,
        reply: oneshot::Sender<Result<String, ModuleError>>,
        /// The call's stamps from its arrival on, logged when it is slow.
        /// Boxed: the stamps are much larger than any other job's fields.
        timing: Box<crate::tool_timing::ToolTiming>,
    },
    PreUser {
        text: String,
        now: u64,
        reply: oneshot::Sender<Addition>,
    },
    RunEnded,
    Idle(oneshot::Sender<()>),
    /// A move's `busy`: answers whether a view offered to the runner is
    /// still unconfirmed. Changes nothing.
    Busy(oneshot::Sender<bool>),
    /// Run the jobs held while a move held the session, once it no longer
    /// does. Changes nothing by itself.
    Resume,
    /// A move's `prepare`: report whether a view offered to the runner is
    /// still unconfirmed, then take no further job until `until` resolves,
    /// so nothing of the session runs while the move freezes and reads it.
    Park {
        at: oneshot::Sender<bool>,
        until: oneshot::Receiver<()>,
    },
    /// The session was released to another machine by this cut, or its rows
    /// were replaced with another machine's copy (`replaced`): drop the jobs
    /// held during the move, with a log line, and stop the worker.
    Discard {
        cut: String,
        replaced: bool,
    },
    /// A timer queues a checkpoint job without owning the session or writing to storage.
    AppCheckpoint {
        flush: Option<oneshot::Sender<()>>,
    },
    /// Boxed: a summary result is much larger than any other job. The guard
    /// keeps the run counted for the session until the worker has handled
    /// the result.
    SummaryFinished(
        Box<Result<Option<run::Summarized>, run::SummaryError>>,
        crate::agent_data::busy::RunGuard,
    ),
    /// A second turn met the runner's account wait: the session's summaries
    /// wait for the time it named, as after a first turn that met it.
    AccountWait(crate::summary::account_wait::AccountWait),
    /// Entorhinal's answer, read again after a Setup, for the project and
    /// workspace the session's folder is in now
    /// ([`Session::follow_workspace`]).
    Workspace {
        project: Option<String>,
        workspace: Option<String>,
    },
    /// `context.recent`: the session's newest messages as the summarizer's
    /// lines, within `budget` tokens ([`Session::recent`]). A read: it
    /// changes no session state and is neither saved nor published. A worker
    /// with no session restores it first, as a tool call's does.
    Recent {
        budget: u64,
        reply: oneshot::Sender<Result<Value, cortexkit_role_compaction::wire::Refusal>>,
    },
}

/// How long a session's worker waits without a job before it frees the
/// session ([`Session::quiet_carry`]). Its next job resumes it first, from
/// what the carry kept and what the stores hold.
const QUIET_AFTER: Duration = Duration::from_secs(10 * 60);
/// The same wait, once the runner reported that the run of a session
/// without a summarizer (a worker or reader) ended: such a session rarely
/// has another job after its run.
const QUIET_AFTER_RUN_END: Duration = Duration::from_secs(60);
/// After this long without a job, a quiet session keeps only its durable state.
const QUIET_CARRY_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const QUIET_CARRY_SWEEP: Duration = Duration::from_secs(30);

/// A session's place in the module.
enum Slot {
    /// A worker runs the session's jobs.
    Running(mpsc::UnboundedSender<Job>),
    /// The session went quiet and its worker stopped; the next job starts a
    /// worker again with what it kept.
    Quiet(Box<Quiet>),
}

/// What a worker keeps of the session it freed.
struct Quiet {
    carry: crate::session::QuietCarry,
    idle_since: tokio::time::Instant,
    /// The state last saved to `sessions.db`, so the next worker saves only a
    /// change.
    saved: Option<crate::store::Durable>,
    /// The session has no summarizer, so its worker follows the runner's
    /// run-end events ([`QUIET_AFTER_RUN_END`]).
    subagent: bool,
}

impl<C: RunnerClient + Router + Send + Sync + 'static> Module<C> {
    /// Drain opt-in context.db lock measurements for a scenario.
    #[cfg(feature = "context-db-timing")]
    pub fn take_context_lock_samples(&self) -> Vec<crate::context_db::timing::Sample> {
        self.inner
            .db
            .as_ref()
            .map(|db| db.take_lock_samples())
            .unwrap_or_default()
    }

    /// A module whose move journal lives in memory and holds nothing, and
    /// that serves no moves.
    pub fn new(
        client: C,
        config: impl Into<Config>,
        db: Option<ContextDb>,
        store: Option<Store>,
    ) -> Self {
        Self::with_journal(
            client,
            config,
            db,
            store,
            Arc::new(crate::agent_data::Journal::in_memory()),
            false,
        )
    }

    /// A module that serves no session a move in `journal` holds. The
    /// journal is read before this is called, so its gate holds from the
    /// first request on, whether or not `agent_data` is set. `agent_data`
    /// says whether this module serves moves ([`crate::agent_data::switch`]).
    pub fn with_journal(
        client: C,
        config: impl Into<Config>,
        db: Option<ContextDb>,
        store: Option<Store>,
        journal: Arc<crate::agent_data::Journal>,
        agent_data: bool,
    ) -> Self {
        let client = Arc::new(client);
        // Every embedding provider these settings resolve to calls Synapse
        // through this client, and the lane each one uses is chosen once for
        // the process ([`crate::embedding::synapse`]).
        let mut config: Config = config.into();
        config.link_synapse(&crate::embedding::synapse::Link::over(Arc::clone(&client)));
        let config = Arc::new(config);
        let session_projects = Arc::new(Mutex::new(HashMap::new()));
        let context_read = crate::context_read::ContextRead::new(
            db.as_ref().map(|d| d.path.clone()),
            store.as_ref().map(|s| s.path.clone()),
            config.clone(),
            session_projects.clone(),
            journal.gate().clone(),
        );
        let app_read = crate::app_read::AppRead::with_message_index(
            store.as_ref().map(|s| s.path.clone()),
            db.as_ref().map(|d| d.path.clone()),
            db.as_ref().map(|d| d.message_index.clone()),
        );
        let search = db.as_ref().map(|db| {
            crate::search::background::Background::new(
                client.clone(),
                db.path.clone(),
                db.message_index.clone(),
            )
        });
        let dreamer = db.as_ref().map(|_| {
            // A project's dreamer run embeds text with the provider the
            // person's settings configure for its folder, read when the run
            // starts, and acts only under its owner's role lease, which it
            // asks Entorhinal for through the module's client.
            let settings = config.clone();
            let mural_settings = config.clone();
            Arc::new(
                crate::dreamer::engine::Engine::new(
                    format!("ck-mc:{}", std::process::id()),
                    crate::dreamer::tasks(),
                )
                .with_embedding(Arc::new(move |root: &str| {
                    settings.resolve(Some(root), "", 0).embedding
                }))
                .with_mural_enabled(Arc::new(move |root, project| {
                    mural_settings
                        .resolve_for_project(Some(root), Some(project), "", 0)
                        .mural_enabled
                }))
                .with_leases(client.role_leases()),
            )
        });
        // The app reads hear of every change the module's writers make to
        // the rows they show, and read the settings and the dreamer's task
        // declarations from the module.
        if let Some(db) = &db {
            db.notify(app_read.notifier());
        }
        app_read.attach(crate::app_read::sessions::Attachment {
            config: config.clone(),
            dreamer: dreamer.clone(),
            gate: journal.gate().clone(),
        });
        let dreamer_enabled = dreamer.is_some() && config.initial_dreamer_enabled();
        let module = Self {
            inner: Arc::new(Inner {
                app_read,
                context_read,
                client,
                search,
                config,
                db: db.map(Arc::new),
                store: store.map(Arc::new),
                journal,
                workers: Mutex::new(HashMap::new()),
                set_up: Mutex::new(HashMap::new()),
                setup_count: AtomicUsize::new(0),
                summaries_running: Mutex::new(0),
                runs: Arc::default(),
                agent_data: crate::agent_data::Service::new(agent_data),
                session_projects,
                active_projects: Mutex::new(HashMap::new()),
                dreamer,
                labs: Arc::default(),
                dreamer_enabled: AtomicBool::new(dreamer_enabled),
                #[cfg(feature = "memory-replica")]
                replica_health: std::sync::OnceLock::new(),
                legacy_wake: Arc::default(),
                docs_notices: std::sync::OnceLock::new(),
                attribution_events: std::sync::OnceLock::new(),
                session_folders: Mutex::new(HashMap::new()),
                entorhinal_watch: Arc::default(),
            }),
        };
        // `context.recent` reads a session's transcript index, which only
        // its worker holds. Weak, so the read service, which the module
        // owns, never keeps the module alive.
        let own = Arc::downgrade(&module.inner);
        module
            .inner
            .context_read
            .serve_recent(Box::new(move |recent| {
                let inner = own.upgrade();
                Box::pin(async move {
                    match inner {
                        Some(inner) => Module { inner }.recent(recent).await,
                        None => Err(crate::context_read::transcript_pending()),
                    }
                })
            }));
        module
    }

    pub(crate) fn health(&self, bus_connected: bool) -> subc_client_rs::HealthReport {
        crate::health::Health {
            context_open: self.inner.db.is_some(),
            sessions_open: self.inner.store.is_some(),
            session_count: self.inner.setup_count.load(Ordering::Relaxed),
            dreamer_enabled: self.inner.dreamer_enabled.load(Ordering::Relaxed),
            bus_connected,
            settings_source: self.inner.config.settings_source(),
            #[cfg(feature = "memory-replica")]
            replica: self.inner.replica_health.get().cloned(),
        }
        .report()
    }

    /// App requests read an independent projection, never a session job.
    pub fn app_read(&self) -> &crate::app_read::AppRead {
        &self.inner.app_read
    }

    /// Observe the app reader closing its store connections after its last sender drops.
    /// The returned receiver does not keep the module or reader alive.
    /// If the reader has already exited, the receiver is immediately disconnected.
    #[doc(hidden)]
    pub fn observe_app_reader_exit(&self) -> std::sync::mpsc::Receiver<()> {
        self.inner.app_read.observe_exit()
    }

    /// The move journal and its gate.
    pub fn journal(&self) -> &Arc<crate::agent_data::Journal> {
        &self.inner.journal
    }

    /// Whether this module serves moves: its manifest declares the
    /// `agent-data` service and its requests are served.
    pub fn agent_data_enabled(&self) -> bool {
        self.inner.agent_data.enabled()
    }

    /// Where the module's settings come from.
    #[cfg(feature = "managed-settings")]
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// One `agent-data` request from `caller`, the principal the daemon
    /// stamped on its route, answered with the reply's bytes or the
    /// contract's refusal.
    pub async fn agent_data(
        &self,
        caller: &str,
        body: &[u8],
    ) -> Result<Vec<u8>, cortexkit_role_agent_data::errors::ErrorBody> {
        self.inner.agent_data.handle(self, caller, body).await
    }

    /// The module's `context.db`, when it has one.
    pub(crate) fn store_db(&self) -> Option<&ContextDb> {
        self.inner.db.as_deref()
    }

    /// An app read, refused for a session a move holds before the
    /// projection is asked.
    pub async fn app_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, cortexkit_role_compaction::wire::Refusal> {
        self.app_gate(&params)?;
        if method == crate::app_read::docs::METHOD {
            // A proposal read stores the status the documents show, so it is
            // answered from the writable store, not the read-only replica.
            let known = match params.get("project").and_then(Value::as_str) {
                Some(project) => self.inner.app_read.knows_project(project).await,
                None => false,
            };
            return crate::app_read::docs::read(self.inner.db.as_deref(), known, &params);
        }
        if !matches!(method, "context.head" | "context.head_section") {
            return self.inner.app_read.read(method, params).await;
        }
        let result = self.inner.app_read.read(method, params.clone()).await;
        match result {
            Err(refusal) if refusal.code == "head_not_ready" => {
                crate::app_read::idle::fetch(
                    &self.inner.app_read,
                    self.inner.client.as_ref(),
                    method,
                    params,
                )
                .await
            }
            result => result,
        }
    }

    /// An app watch, refused when it names a session a move holds.
    pub async fn app_watch(
        &self,
        caller: String,
        params: Value,
    ) -> Result<crate::app_read::Subscription, cortexkit_role_compaction::wire::Refusal> {
        self.app_gate(&params)?;
        self.inner.app_read.watch(caller, params).await
    }

    /// Check every session an app request names: `session` for the session
    /// reads, `scope.session` for a search, `sessions` for a watch. A
    /// malformed name is left for the projection to refuse with its own
    /// error. App reads serve rows every runner of a session shares, so any
    /// entry with the session's harness and id refuses them.
    fn app_gate(&self, params: &Value) -> Result<(), cortexkit_role_compaction::wire::Refusal> {
        let gate = self.inner.journal.gate();
        let named = [
            params.get("session"),
            params.get("scope").and_then(|scope| scope.get("session")),
        ];
        let listed = params
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for session in named.into_iter().flatten().chain(listed) {
            let (Some(harness), Some(id)) = (
                session.get("harness").and_then(Value::as_str),
                session.get("session").and_then(Value::as_str),
            ) else {
                continue;
            };
            gate.check_any_runner(harness, id)
                .map_err(|gated| gated.refusal())?;
        }
        Ok(())
    }

    /// Refuse a session a move holds, before any job is queued for it.
    fn admit(&self, session: &SessionRef) -> Result<(), ModuleError> {
        self.inner
            .journal
            .gate()
            .check(session)
            .map_err(ModuleError::Gated)
    }

    /// Run the jobs the session's worker held while a move held the
    /// session. Jobs stay held while the move still holds it; a session
    /// with no worker, or a quiet one, holds nothing.
    pub fn resume(&self, session: &SessionRef) {
        let _ = self.send_running(session, Job::Resume);
    }

    /// Finish, in the background, every install of a move the journal
    /// records as started ([`crate::agent_data::Service::recover`]). It
    /// runs at every start, whether or not this build serves moves.
    pub fn spawn_move_recovery(&self) {
        let module = self.clone();
        tokio::spawn(async move { module.inner.agent_data.recover(&module).await });
    }

    /// Drop what this process keeps for a session a move took over: its
    /// worker, which discards the jobs it held, its Setup, its cached
    /// project, and what the app reads hold for it (its projection, message
    /// index and captured request heads). For a session whose rows were
    /// `replaced` by an install, the cached project and the app reads'
    /// projection of the session under any runner go too: context and app
    /// reads match a session by harness and id, and both would otherwise
    /// answer from the rows the install replaced.
    fn drop_session(&self, session: &SessionRef, cut: &str, replaced: bool) {
        let mut set_up = self.inner.set_up.lock().expect("setup sessions");
        let mut workers = self.inner.workers.lock().expect("worker map");
        // Everything the app reads show was built from the rows and views the
        // move took away or replaced. Until the session's next Setup, a read
        // of it is answered as for a session this process never saw.
        self.inner.app_read.forget_session(session, replaced);
        let slot = workers.remove(session);
        Self::forget_setup(&self.inner, &mut set_up, session, replaced);
        drop(workers);
        drop(set_up);
        // A quiet session has no worker: what it kept goes with its slot.
        if let Some(Slot::Running(worker)) = slot {
            let _ = worker.send(Job::Discard {
                cut: cut.to_owned(),
                replaced,
            });
        }
    }

    /// Forget a session's Setup data when it is dropped or moved away, or
    /// when the transcript and view kept while idle (its quiet carry) expire.
    /// Hold the Setup and worker locks so this cannot clear anything a newer
    /// Setup just registered.
    fn forget_setup(
        inner: &Inner<C>,
        set_up: &mut HashMap<SessionRef, Option<String>>,
        session: &SessionRef,
        replaced: bool,
    ) {
        set_up.remove(session);
        inner.setup_count.store(set_up.len(), Ordering::Relaxed);
        inner
            .session_folders
            .lock()
            .expect("session folders")
            .remove(session);
        let mut projects = inner.session_projects.lock().expect("session projects");
        if replaced {
            projects.retain(|key, _| {
                !(key.harness == session.harness && key.session == session.session)
            });
        } else {
            projects.remove(session);
        }
    }

    /// Context reads use a separate read-only worker so they cannot delay session work.
    pub fn context_read(&self) -> &crate::context_read::ContextRead {
        &self.inner.context_read
    }

    /// `context.recent`, once the context read service admitted it, asked of
    /// the session's worker: only the worker holds the session's transcript
    /// index. The request names no runner, so a live worker of the harness
    /// and session answers, the first by runner name when several do. When
    /// no worker is live but sessions.db holds the session's saved state, a
    /// worker is started for it, as for a command run, and the read restores
    /// the session from that state.
    async fn recent(
        &self,
        recent: crate::context_read::Recent,
    ) -> Result<Value, cortexkit_role_compaction::wire::Refusal> {
        // A quiet session's slot counts as live: sending to it resumes the
        // session from what it kept, as for any other job.
        let live = self
            .inner
            .workers
            .lock()
            .expect("worker map")
            .keys()
            .filter(|key| key.harness == recent.harness && key.session == recent.session)
            .min_by(|a, b| a.runner.cmp(&b.runner))
            .cloned();
        let key = match live {
            Some(key) => key,
            None => self
                .inner
                .context_read
                .saved_runners(&recent)
                .await?
                .into_iter()
                .map(|runner| SessionRef::new(runner, &recent.harness, &recent.session))
                .find(|key| {
                    self.inner
                        .store
                        .as_ref()
                        .is_some_and(|store| store.load(key).is_some())
                })
                .ok_or_else(crate::context_read::unknown_session)?,
        };
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            let slot = workers
                .entry(key.clone())
                .or_insert_with(|| self.spawn_worker(key.clone()));
            self.running(slot, &key)
        };
        let (reply, answer) = oneshot::channel();
        // A worker that stops before answering was released by a move; the
        // caller's next read finds the session gone or held.
        worker
            .send(Job::Recent {
                budget: recent.budget,
                reply,
            })
            .map_err(|_| crate::context_read::transcript_pending())?;
        answer
            .await
            .map_err(|_| crate::context_read::transcript_pending())?
    }

    /// Wait for eventual message search indexing, outside the session worker.
    pub async fn search_idle(&self, session: &SessionRef) -> Result<(), String> {
        match &self.inner.search {
            Some(search) => search.idle(session).await,
            None => Ok(()),
        }
    }

    /// Best-effort checkpointing after the serving connection ends. Queue all
    /// sessions first, so one busy runner cannot keep the others from flushing.
    pub async fn flush_app_snapshots(&self) {
        let answers: Vec<_> = {
            let workers = self.inner.workers.lock().expect("worker map");
            // A quiet session saved everything before its worker stopped.
            workers
                .values()
                .filter_map(|slot| {
                    let Slot::Running(worker) = slot else {
                        return None;
                    };
                    let (reply, answer) = oneshot::channel();
                    worker
                        .send(Job::AppCheckpoint { flush: Some(reply) })
                        .ok()
                        .map(|()| answer)
                })
                .collect()
        };
        // The daemon may force an exit after its drain budget. A stuck session
        // must not extend process shutdown; signal termination has no flush hook.
        if tokio::time::timeout(Duration::from_secs(2), async {
            for answer in answers {
                let _ = answer.await;
            }
        })
        .await
        .is_err()
        {
            tracing::warn!("ck-mc: timed out flushing app checkpoints on shutdown");
        }
    }

    #[cfg(feature = "notice-cost-timing")]
    pub fn pause_search_measurement(&self, paused: bool) {
        if let Some(search) = &self.inner.search {
            search.pause(paused);
        }
    }

    /// `compaction.setup` for the session `route` is bound to. Answers at
    /// once; the session reads its transcript afterwards, on its worker.
    pub fn setup(&self, route: Route, request: SetupRequest) -> Result<SetupAnswer, ModuleError> {
        self.admit(&route.session)?;
        let features = preset::features(&request.preset)
            .ok_or_else(|| ModuleError::UnknownPreset(request.preset.clone()))?;
        self.inner.client.runner_setup(&route.session.runner);
        // Record the epoch and queue Setup under the lock that checks and
        // queues runner notices and `compaction.ride` requests for a view.
        // The same lock protects forgetting Setup data when a session is
        // dropped or moved away, or its idle transcript and view expire.
        // Register the new project and folder under that lock too.
        let mut set_up = self.inner.set_up.lock().expect("setup sessions");
        if let Some(project) = &route.project {
            self.inner
                .session_projects
                .lock()
                .expect("session projects")
                .insert(route.session.clone(), project.clone());
            self.inner
                .app_read
                .session_seen(&route.session, project, &request.preset);
            self.touch(&route.session);
            self.inner.legacy_wake.saw(&project.id);
        }
        if let Some(folder) = &route.workdir {
            self.inner
                .session_folders
                .lock()
                .expect("session folders")
                .insert(route.session.clone(), folder.clone());
        }
        let key = route.session.clone();
        let epoch = request.statement_epoch.clone();
        {
            let mut workers = self.inner.workers.lock().expect("worker map");
            let slot = workers
                .entry(key.clone())
                .or_insert_with(|| self.spawn_worker(key.clone()));
            self.running(slot, &key)
                .send(Job::Setup(route, request, features))
                .map_err(|_| ModuleError::Stopped)?;
        }
        set_up.insert(key, epoch);
        self.inner
            .setup_count
            .store(set_up.len(), Ordering::Relaxed);
        Ok(SetupAnswer::Ready)
    }

    /// Whether a notice or ride (`kind`) with `conditions` belongs to the
    /// statement epoch of the session's newest Setup, as `set_up` records
    /// it, checked as the statement arrives, before anything else (see the
    /// `statement_order` module). `None` when the session was not set up in
    /// this process. A statement that does not belong is logged here, once.
    /// The caller holds the `set_up` lock and keeps holding it while it
    /// queues an admitted statement.
    fn epoch_verdict(
        set_up: &HashMap<SessionRef, Option<String>>,
        session: &SessionRef,
        kind: &str,
        conditions: &cortexkit_role_compaction::notice::Conditions,
    ) -> Option<bool> {
        let held = set_up.get(session)?;
        let admitted = crate::session::epoch_admits(held.as_deref(), conditions);
        if !admitted {
            tracing::info!(
                session = %session.session,
                %kind,
                statement_epoch = ?conditions.statement_epoch,
                statement_seq = ?conditions.statement_seq,
                setup_epoch = ?held,
                "ck-mc: session: dropped a statement from a different epoch; asking the runner to set the session up again"
            );
        }
        Some(admitted)
    }

    /// [`Self::epoch_verdict`] under its own lock, for tests that check a
    /// statement and queue it in two steps.
    #[cfg(test)]
    fn statement_admitted(
        &self,
        session: &SessionRef,
        kind: &str,
        conditions: &cortexkit_role_compaction::notice::Conditions,
    ) -> Option<bool> {
        let set_up = self.inner.set_up.lock().expect("setup sessions");
        Self::epoch_verdict(&set_up, session, kind, conditions)
    }

    /// `compaction.notice`. Answers at once; the work runs afterwards. A
    /// session ck-mc does not know (it restarted since the runner's Setup)
    /// asks the runner to call Setup again.
    pub fn notice(
        &self,
        session: &SessionRef,
        request: NoticeRequest,
    ) -> Result<NoticeAnswer, ModuleError> {
        self.admit(session)?;
        // The epoch comes first: a notice from another Setup's epoch is
        // dropped before it can advance anything, its notice number
        // included. A session not set up in this process asks for Setup too.
        // Checked and queued under the lock a Setup is recorded and queued
        // under (see `setup`).
        let set_up = self.inner.set_up.lock().expect("setup sessions");
        match Self::epoch_verdict(&set_up, session, "notice", &request.conditions) {
            Some(true) => {}
            None | Some(false) => return Ok(NoticeAnswer::SetupRequired),
        }
        let sent = self.send(session, Job::Notice(request));
        drop(set_up);
        match sent {
            Ok(()) => {
                self.touch(session);
                Ok(NoticeAnswer::Received)
            }
            Err(ModuleError::UnknownSession) => Ok(NoticeAnswer::SetupRequired),
            Err(error) => Err(error),
        }
    }

    /// `compaction.ride`: a view for the coming request, or nothing, within
    /// the runner's deadline. A ride that misses its deadline answers
    /// nothing; the runner then sends with the view it has.
    pub async fn ride(
        &self,
        session: &SessionRef,
        request: RideRequest,
    ) -> Result<RideAnswer, ModuleError> {
        self.admit(session)?;
        let deadline = Duration::from_millis(request.deadline_ms);
        let (reply, answer) = oneshot::channel();
        {
            // A ride from another Setup's epoch is refused as for a session
            // ck-mc does not hold, which makes a live runner set it up
            // again. For a session not set up in this process, a ride
            // naming an epoch or a stamp is refused the same way; one naming
            // neither goes to the session's worker, if there is one, as it
            // always did. Checked and queued under the lock a Setup is
            // recorded and queued under (see `setup`), released before the
            // answer is awaited.
            let unordered = request.conditions.statement_epoch.is_none()
                && request.conditions.statement_seq.is_none();
            let set_up = self.inner.set_up.lock().expect("setup sessions");
            match Self::epoch_verdict(&set_up, session, "ride", &request.conditions) {
                Some(true) => {}
                None if unordered => {}
                None | Some(false) => return Err(ModuleError::UnknownSession),
            }
            self.send(session, Job::Ride(request, reply))?;
        }
        match tokio::time::timeout(deadline, answer).await {
            Ok(Ok(Some(view))) => Ok(RideAnswer::View { view }),
            Ok(Ok(None)) | Err(_) => Ok(RideAnswer::Nothing),
            Ok(Err(_)) => Err(ModuleError::Stopped),
        }
    }

    /// The `tool.catalog` answer for a plan item, as RFC 8785 canonical
    /// JSON: the tools a preset gets and their guidance text, from the
    /// project's configuration when the route's scope names a project, else
    /// the user's alone. It depends on no session, so it never waits on one.
    pub fn catalog(
        &self,
        project_root: Option<&str>,
        arguments: &Value,
    ) -> Result<Vec<u8>, crate::catalog::CatalogError> {
        self.catalog_for_project(project_root, None, arguments)
    }

    pub(crate) fn catalog_for_project(
        &self,
        project_root: Option<&str>,
        project_id: Option<&str>,
        arguments: &Value,
    ) -> Result<Vec<u8>, crate::catalog::CatalogError> {
        let config = self
            .inner
            .config
            .catalog_for_project(project_root, project_id);
        crate::catalog::catalog_answer_bytes(arguments, &config)
    }

    /// A `ctx_*` tool call from a session's model, on the session's tool
    /// route. A session that never had a Setup is one Magic Context only
    /// serves tools to ([`Session::tools_only`]); its first call starts its
    /// worker.
    pub async fn tool(
        &self,
        route: &Route,
        name: &str,
        input: Value,
    ) -> Result<String, ModuleError> {
        self.tool_at(route, name, input, false, std::time::Instant::now())
            .await
    }

    /// [`Module::tool`] for a call the transport received at `arrived`. A
    /// `ctx_search` or `ctx_memory` call that took
    /// [`crate::tool_timing::SLOW`] or longer from then is logged with the
    /// time each of its steps took, the wait for the session's worker
    /// included ([`crate::tool_timing`]). `fork` marks a call carrying the
    /// tool-provider role's `fork_id`, which the transport admits only for
    /// the tools the catalog marks read-only.
    pub async fn tool_at(
        &self,
        route: &Route,
        name: &str,
        input: Value,
        fork: bool,
        arrived: std::time::Instant,
    ) -> Result<String, ModuleError> {
        self.admit(&route.session)?;
        let (reply, answer) = oneshot::channel();
        {
            let key = &route.session;
            let mut workers = self.inner.workers.lock().expect("worker map");
            let slot = workers
                .entry(key.clone())
                .or_insert_with(|| self.spawn_worker(key.clone()));
            let worker = self.running(slot, key);
            let mut timing = Box::new(crate::tool_timing::ToolTiming::new(arrived));
            timing.mark("route");
            worker
                .send(Job::Tool {
                    route: route.clone(),
                    name: name.to_owned(),
                    input,
                    fork,
                    reply,
                    timing,
                })
                .map_err(|_| ModuleError::Stopped)?;
        }
        answer.await.map_err(|_| ModuleError::Stopped)?
    }

    /// The `pre_user` hook: what to add to a person's message, within
    /// [`PRE_USER_BUDGET`]. A session ck-mc does not know, or an answer that
    /// misses the budget, adds nothing: the message is never held up. The
    /// hook cannot refuse, so a session a move holds gets nothing added.
    pub async fn pre_user(&self, session: &SessionRef, text: &str, now: u64) -> Addition {
        if self.admit(session).is_err() {
            return Addition::default();
        }
        let (reply, answer) = oneshot::channel();
        let job = Job::PreUser {
            text: text.to_owned(),
            now,
            reply,
        };
        if self.send(session, job).is_err() {
            return Addition::default();
        }
        tokio::time::timeout(PRE_USER_BUDGET, answer)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    }

    /// Wait until the session's worker has handled every job sent before,
    /// and every summarizer run has ended and been handled. Tests use it to
    /// make a run deterministic, the way a real runner's model time gives
    /// ck-mc time to finish.
    pub async fn idle(&self, session: &SessionRef) -> Result<(), ModuleError> {
        self.idle_foreground(session).await?;
        self.search_idle(session).await.map_err(ModuleError::Tool)
    }

    #[cfg(test)]
    pub(crate) async fn historian_idle(&self) -> Option<Result<(), String>> {
        self.inner.search.as_ref().unwrap().historian_idle().await
    }

    /// Drain foreground work only. Background indexing is fenced separately
    /// when a test needs search results rather than an applied compaction view.
    pub async fn idle_foreground(&self, session: &SessionRef) -> Result<(), ModuleError> {
        loop {
            self.barrier(session)?
                .await
                .map_err(|_| ModuleError::Stopped)?;
            if *self.inner.summaries_running.lock().expect("summary count") == 0 {
                // A run that just ended queued its result before the count
                // dropped; one more round handles it.
                return self
                    .barrier(session)?
                    .await
                    .map_err(|_| ModuleError::Stopped);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// One upkeep round: workspace embedding, then each project with a Setup
    /// or notice in the last hour. Returns only the project reports.
    pub async fn run_upkeep(&self) -> Vec<(String, crate::upkeep::Report)> {
        let Some(db) = self.inner.db.clone() else {
            return Vec::new();
        };
        // Workspace facts can outlive every session in their source project.
        // Use only the user's settings; a project overlay can tune its own
        // embedding requests, but must not apply to other projects' facts.
        let user = self.inner.config.resolve(None, "", 0);
        let workspace_embedded = crate::upkeep::run_workspace(&db, &user).await;
        if workspace_embedded > 0 {
            tracing::info!(
                embedded_count = %workspace_embedded,
                "ck-mc: upkeep embedded workspace memories"
            );
        }
        let now = now_ms();
        let projects: Vec<(String, String)> = {
            let mut active = self.inner.active_projects.lock().expect("active projects");
            active.retain(|_, (_, seen)| now - *seen <= crate::upkeep::PROJECT_TTL_MS);
            let mut projects: Vec<_> = active
                .iter()
                .map(|(id, (root, _))| (id.clone(), root.clone()))
                .collect();
            projects.sort();
            projects
        };
        let mut reports = Vec::new();
        for (id, root) in projects {
            // Upkeep reads no per-model setting, so no model is named.
            let settings = self
                .inner
                .config
                .resolve_for_project(Some(&root), Some(&id), "", 0);
            let plan = crate::upkeep::Plan::from_settings(&settings);
            // Only sessions registered in this process belong to this upkeep
            // scope. After a restart their persisted summaries wait until the
            // session registers again; a harness name alone never proves ownership.
            // A session a move holds is skipped: its rows are being moved.
            let owned = || {
                self.inner
                    .session_projects
                    .lock()
                    .expect("session projects")
                    .iter()
                    .filter(|(key, project)| {
                        project.id == id
                            && self
                                .inner
                                .journal
                                .gate()
                                .check_any_runner(&key.harness, &key.session)
                                .is_ok()
                    })
                    .map(|(key, _)| (key.harness.clone(), key.session.clone()))
                    .collect()
            };
            let report = crate::upkeep::run_project_scoped(
                &db,
                &id,
                Path::new(&root),
                &plan,
                &now_ms,
                &owned,
            )
            .await;
            if report != crate::upkeep::Report::default() {
                tracing::info!(project = %id, ?report, "ck-mc: upkeep finished for a project");
            }
            reports.push((id, report));
        }
        reports
    }

    /// Run upkeep every [`crate::upkeep::INTERVAL`], the first time after a
    /// short quiet period. Without `context.db` there is nothing to keep up.
    pub fn spawn_upkeep(&self) {
        if self.inner.db.is_none() {
            return;
        }
        let module = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(crate::upkeep::BOOT_QUIET).await;
            loop {
                module.run_upkeep().await;
                tokio::time::sleep(crate::upkeep::INTERVAL).await;
            }
        });
    }

    /// Drop the in-memory state kept for quiet sessions (their transcript
    /// index and last view) once it has gone unused too long, even when no
    /// new operation arrives to trigger the check.
    pub fn spawn_quiet_carry_sweep(&self) {
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(QUIET_CARRY_SWEEP).await;
                let Some(inner) = inner.upgrade() else { break };
                Self::expire_quiet(&inner, tokio::time::Instant::now());
            }
        });
    }

    fn expire_quiet(inner: &Inner<C>, now: tokio::time::Instant) {
        let expired = {
            let mut set_up = inner.set_up.lock().expect("setup sessions");
            let mut workers = inner.workers.lock().expect("worker map");
            let keys: Vec<_> = workers
                .iter()
                .filter_map(|(key, slot)| match slot {
                    Slot::Quiet(quiet)
                        if now.duration_since(quiet.idle_since) >= QUIET_CARRY_TTL =>
                    {
                        Some(key.clone())
                    }
                    _ => None,
                })
                .collect();
            keys.into_iter()
                .map(|key| {
                    let slot = workers.remove(&key).expect("expired worker");
                    Self::forget_setup(inner, &mut set_up, &key, false);
                    (key, slot)
                })
                .collect::<Vec<_>>()
        };
        // Drop the transcript and view outside the worker lock.
        for (key, slot) in expired {
            let Slot::Quiet(quiet) = slot else {
                unreachable!("only parked carries expire")
            };
            tracing::info!(
                runner = %key.runner,
                harness = %key.harness,
                session = %key.session,
                idle_secs = %now.duration_since(quiet.idle_since).as_secs(),
                "ck-mc: session: dropped its quiet carry after being idle without a job"
            );
        }
    }

    /// Publish the docs-upkeep proposals' bus notices through `notices` in
    /// the dreamer's rounds ([`crate::bus`]). Only the first call takes
    /// effect; a module without one publishes none.
    pub fn publish_docs_notices_with(&self, notices: crate::bus::DocsNotices) {
        let _ = self.inner.docs_notices.set(Arc::new(notices));
    }

    /// Publish the attribution facts' bus events through `events`: right
    /// after each commit that stores a fact, and every unsent one again in
    /// the dreamer's rounds ([`crate::attribution`]). Only the first call
    /// takes effect. Without `context.db` there are no facts to publish.
    pub fn publish_attribution_with(&self, events: crate::bus::AttributionEvents) {
        let events = Arc::new(events);
        if self
            .inner
            .attribution_events
            .set(Arc::clone(&events))
            .is_err()
        {
            return;
        }
        let Some(db) = self.inner.db.clone() else {
            return;
        };
        let wake = Arc::new(tokio::sync::Notify::new());
        db.wake_on_attribution_facts(Arc::clone(&wake));
        tokio::spawn(crate::bus::run_attribution_events(events, db, wake));
    }

    /// Wake other modules on `bus` after each committed change to memories a
    /// session's head can show ([`crate::memory_changed`]). Without
    /// `context.db` nothing changes.
    pub fn spawn_memory_wakes(&self, bus: Arc<crate::bus::Bus>) {
        let Some(db) = self.inner.db.clone() else {
            return;
        };
        let wakes = Arc::new(crate::memory_changed::MemoryWakes::default());
        let publisher = crate::memory_changed::publisher_for(&db, bus, &wakes);
        tokio::spawn(crate::memory_changed::run(publisher, db, wakes));
    }

    /// Share memories with the user's other computers through the hub, in
    /// a build with the `memory-replica` feature ([`crate::replica::live`]):
    /// the hub connection comes from ck-bus over `consumer`, and the box id
    /// from `bus`. `None` in a build without the feature, or without
    /// `context.db`; stop the task with the module.
    pub fn spawn_replica(
        &self,
        consumer: crate::transport::SharedConsumer,
        bus: Arc<crate::bus::Bus>,
    ) -> Option<crate::replica::live::ReplicaTask> {
        let db = self.inner.db.clone()?;
        let task = crate::replica::live::start(db, consumer, bus)?;
        #[cfg(feature = "memory-replica")]
        let _ = self.inner.replica_health.set(Arc::clone(&task.health));
        Some(task)
    }

    /// Follow Entorhinal's change markers on `bus`
    /// ([`crate::entorhinal_changes`]): each change reads every live
    /// session's workspace again and wakes a legacy project round.
    /// Keep the returned handle until shutdown to keep following the registry.
    pub fn spawn_entorhinal_follow(&self, bus: Arc<crate::bus::Bus>) -> MarkerTask {
        let module = self.clone();
        let state = Arc::clone(&self.inner.entorhinal_watch);
        entorhinal_changes::spawn_marker(bus, state, entorhinal_changes::KEY, move || {
            module.registry_changed();
        })
    }

    /// Whether the watch on Entorhinal's change markers is up.
    #[cfg(test)]
    pub(crate) fn entorhinal_watch_up(&self) -> bool {
        self.inner.entorhinal_watch.is_up()
    }

    /// The module's `context.db`, for tests that watch its writers.
    #[cfg(test)]
    pub(crate) fn context_store(&self) -> Option<&Arc<ContextDb>> {
        self.inner.db.as_ref()
    }

    /// Entorhinal's registry changed: a session's project may be in another
    /// workspace now, and a 0.49 folder may belong to a project now. Each
    /// set-up session's folder is read again, once per folder, and a legacy
    /// project round is woken.
    pub(crate) fn registry_changed(&self) {
        self.inner.legacy_wake.registry_changed();
        let folders = self
            .inner
            .session_folders
            .lock()
            .expect("session folders")
            .clone();
        let mut by_folder: std::collections::BTreeMap<String, Folder> =
            std::collections::BTreeMap::new();
        {
            let workers = self.inner.workers.lock().expect("worker map");
            for (session, folder) in folders {
                // Only sessions with a live worker are read again here. A
                // quiet session reads its folder's workspace when its worker
                // starts again, so it gets the new registry without being
                // woken now.
                if !workers.contains_key(&session) {
                    continue;
                }
                by_folder
                    .entry(folder)
                    .or_insert_with(|| (session.clone(), Vec::new()))
                    .1
                    .push(session);
            }
        }
        read_workspaces(&self.inner, by_folder.into_iter().collect());
    }

    /// Run the dreamer once a minute, the first time after upkeep's quiet
    /// period. Each round learns the projects of the sessions set up in this
    /// process (with the memory profile a session of each resolved, or the
    /// bundled one, and the workspace its memory context names) and starts
    /// the tasks that are due. The person's `dreamer.disable` stops new runs
    /// from the next round.
    pub async fn spawn_dreamer(
        &self,
        runtime: &tokio::runtime::Handle,
    ) -> Result<(), tokio::task::JoinError> {
        let (Some(db), Some(engine)) = (self.inner.db.clone(), self.inner.dreamer.clone()) else {
            return Ok(());
        };
        engine.bind_runtime(runtime);
        let (start_engine, start_db) = (engine.clone(), db.clone());
        // Recover interrupted runs before any request can start another one.
        engine
            .spawn(async move { start_engine.start(&start_db, now_ms()) })
            .await?;
        let module = self.clone();
        let round_engine = engine.clone();
        engine.spawn(async move {
            let engine = round_engine;
            tokio::time::sleep(crate::upkeep::BOOT_QUIET).await;
            loop {
                let settings = module.inner.config.dreamer();
                module
                    .inner
                    .dreamer_enabled
                    .store(settings.is_some(), Ordering::Relaxed);
                if let Some(settings) = settings {
                    let now = now_ms();
                    engine.retain_projects(&settings);
                    // Finding each project's folder runs git, so it runs off
                    // the async threads.
                    let projects = {
                        let module = module.clone();
                        tokio::task::spawn_blocking(move || module.projects_with_a_session())
                            .await
                            .expect("finding the dreamer's project folders")
                    };
                    for (project, root, session) in projects {
                        if !settings.runs_for(&project) {
                            continue;
                        }
                        let context = module
                            .inner
                            .store
                            .as_ref()
                            .and_then(|store| store.memory_context(&session));
                        match crate::memory_profile::prompt_profile(context.as_ref()) {
                            Ok(profile) => engine.see_project(
                                &db,
                                &project,
                                &root,
                                Arc::new(profile),
                                &settings,
                                now,
                            ),
                            Err(refusal) => tracing::warn!(
                                %project,
                                ?refusal,
                                "ck-mc: dreamer: the project's memory profile could not load"
                            ),
                        }
                        engine.see_workspace(
                            &project,
                            context
                                .as_ref()
                                .and_then(|context| context.workspace_id.as_deref()),
                        );
                    }
                    engine.tick(&db, &module.inner.client, &settings, now);
                }
                // Unsent proposal notices are retried every round, also
                // after the person switched the dreamer off.
                if let Some(notices) = module.inner.docs_notices.get() {
                    notices.publish(&db).await;
                }
                // So are unsent attribution facts' events: the wake after a
                // fact's commit finds the bus down, or a fact was stored
                // before a restart.
                if let Some(events) = module.inner.attribution_events.get() {
                    events.publish(&db).await;
                }
                tokio::time::sleep(crate::dreamer::engine::TICK).await;
            }
        });
        Ok(())
    }

    /// Each project with a session set up in this process, with the folder
    /// its dreamer tasks run in and one of its sessions (the first by key,
    /// so the choice is stable). The folder is chosen again on every call
    /// from the folders of all the project's sessions
    /// ([`crate::dreamer::branches::project_folder`]): the main checkout of
    /// their repository, rather than the folder of whichever session comes
    /// first, which may be an agent's task checkout deleted since. Each call
    /// runs git once per distinct folder.
    fn projects_with_a_session(&self) -> Vec<(String, String, SessionRef)> {
        let mut projects: std::collections::BTreeMap<String, Vec<(SessionRef, String)>> =
            std::collections::BTreeMap::new();
        for (session, project) in self
            .inner
            .session_projects
            .lock()
            .expect("session projects")
            .iter()
        {
            projects
                .entry(project.id.clone())
                .or_default()
                .push((session.clone(), project.root.clone()));
        }
        projects
            .into_iter()
            .filter_map(|(id, mut sessions)| {
                sessions.sort_by(|(a, _), (b, _)| {
                    (&a.runner, &a.harness, &a.session).cmp(&(&b.runner, &b.harness, &b.session))
                });
                let mut roots: Vec<String> = Vec::new();
                for (_, root) in &sessions {
                    if !roots.contains(root) {
                        roots.push(root.clone());
                    }
                }
                let folder = crate::dreamer::branches::project_folder(&roots)?;
                let (session, _) = sessions.into_iter().next()?;
                Some((id, folder, session))
            })
            .collect()
    }

    /// Move the project rows a 0.49 plugin left under its own keys to the
    /// project ids Entorhinal assigns, in the background
    /// ([`crate::legacy_projects`]). Without `context.db` there are none.
    pub fn spawn_legacy_projects(&self) {
        let Some(db) = self.inner.db.clone() else {
            return;
        };
        let client = Arc::clone(&self.inner.client);
        let wake = Arc::clone(&self.inner.legacy_wake);
        tokio::spawn(async move {
            crate::legacy_projects::run(client.as_ref(), db, wake).await;
        });
    }

    /// What wakes the legacy project rounds, for the tests.
    #[cfg(test)]
    pub(crate) fn legacy_wake(&self) -> &Arc<crate::legacy_projects::Wake> {
        &self.inner.legacy_wake
    }

    /// Mark the session's project active now.
    fn touch(&self, session: &SessionRef) {
        let project = self
            .inner
            .session_projects
            .lock()
            .expect("session projects")
            .get(session)
            .cloned();
        if let Some(project) = project {
            self.inner
                .active_projects
                .lock()
                .expect("active projects")
                .insert(project.id, (project.root, now_ms()));
        }
    }

    /// Queue `job` on the session's worker, starting it again when the
    /// session went quiet.
    fn send(&self, session: &SessionRef, job: Job) -> Result<(), ModuleError> {
        let mut workers = self.inner.workers.lock().expect("worker map");
        let slot = workers
            .get_mut(session)
            .ok_or(ModuleError::UnknownSession)?;
        self.running(slot, session)
            .send(job)
            .map_err(|_| ModuleError::Stopped)
    }

    /// Queue `job` only on a worker that runs: a quiet session has nothing in
    /// flight to ask about, wait for or let go of, and is answered as one
    /// with no worker.
    fn send_running(&self, session: &SessionRef, job: Job) -> Result<(), ModuleError> {
        match self.inner.workers.lock().expect("worker map").get(session) {
            Some(Slot::Running(worker)) => worker.send(job).map_err(|_| ModuleError::Stopped),
            Some(Slot::Quiet(_)) | None => Err(ModuleError::UnknownSession),
        }
    }

    /// A barrier on the session's worker, answered once it handled every job
    /// queued before. A quiet session's worker stopped with its queue empty,
    /// so its barrier is passed at once.
    fn barrier(&self, session: &SessionRef) -> Result<oneshot::Receiver<()>, ModuleError> {
        let (reply, answer) = oneshot::channel();
        match self.inner.workers.lock().expect("worker map").get(session) {
            Some(Slot::Running(worker)) => worker
                .send(Job::Idle(reply))
                .map_err(|_| ModuleError::Stopped)?,
            Some(Slot::Quiet(_)) => {
                let _ = reply.send(());
            }
            None => return Err(ModuleError::UnknownSession),
        }
        Ok(answer)
    }

    /// The sender of the worker in `slot`, `key`'s, started again from what
    /// it kept when the session went quiet. Called under the `workers` lock.
    fn running(&self, slot: &mut Slot, key: &SessionRef) -> mpsc::UnboundedSender<Job> {
        if let Slot::Running(worker) = slot {
            return worker.clone();
        }
        let (jobs, receiver) = mpsc::unbounded_channel();
        let Slot::Quiet(quiet) = std::mem::replace(slot, Slot::Running(jobs.clone())) else {
            unreachable!("a running slot returned above");
        };
        self.run_worker(key.clone(), &jobs, receiver, Some(*quiet));
        jobs
    }

    pub(crate) fn lab_child(&self, route: &Route) -> Option<Arc<crate::dreamer::lab::Lab>> {
        self.inner.labs.get(route)
    }

    pub(crate) async fn lab_command(&self, body: &[u8]) -> Result<Value, subc_protocol::ErrorBody> {
        let path = crate::user_commands::dreamer::lab_path(body)?;
        let (Some(live), Some(engine)) = (&self.inner.db, &self.inner.dreamer) else {
            return Err(subc_protocol::ErrorBody::new(
                "unavailable",
                "the dreamer runtime is unavailable",
            ));
        };
        let start = crate::dreamer::lab::Start::load(&path, &live.path, self.inner.labs.clone())
            .await
            .map_err(|error| subc_protocol::ErrorBody::new("invalid_params", error))?;
        let config = self.inner.config.clone();
        let reply = serde_json::json!({"outcome": "started", "out_dir": start.out_dir()});
        engine.spawn(start.execute_with(
            self.inner.client.clone(),
            self.inner.labs.clone(),
            live.clone(),
            move |root, project| {
                let settings = config.resolve_for_project(root.to_str(), Some(project), "", 0);
                (settings.embedding, settings.rerank)
            },
        ));
        Ok(reply)
    }

    pub(crate) async fn command_request(
        &self,
        principal: &subc_protocol::Principal,
        body: &[u8],
    ) -> Result<Value, subc_protocol::ErrorBody> {
        let result = self.command_request_inner(principal, body).await;
        crate::user_commands::audit(body, &result);
        result
    }

    async fn command_request_inner(
        &self,
        principal: &subc_protocol::Principal,
        body: &[u8],
    ) -> Result<Value, subc_protocol::ErrorBody> {
        use crate::user_commands as commands;
        cortexkit_role_user_commands::check_admission(principal, false, false)?;
        let Some(request) = commands::decode(body)? else {
            return serde_json::to_value(commands::describe())
                .map_err(|_| commands::invalid("reply"));
        };
        let Some(key) = request.key() else {
            return self.owner_command(request).await;
        };
        // A Run restores, from its saved state, a session no worker holds;
        // other commands answer such a session as one ck-mc doesn't hold.
        // A session a move holds is never restored: its worker would only
        // refuse the command, and would then keep the session counted as
        // running in this process until the move ends.
        let restores = matches!(&request, commands::Request::Run(_))
            && !self
                .inner
                .workers
                .lock()
                .expect("worker map")
                .contains_key(&key)
            && self
                .inner
                .store
                .as_ref()
                .and_then(|store| store.load(&key))
                .is_some();
        if restores && self.admit(&key).is_err() {
            return Err(session_moving_command());
        }
        let (reply, answer) = oneshot::channel();
        let unsent = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            if restores {
                workers
                    .entry(key.clone())
                    .or_insert_with(|| self.spawn_worker(key.clone()));
            }
            match workers.get_mut(&key) {
                Some(slot) => {
                    self.running(slot, &key)
                        .send(Job::Command { request, reply })
                        .map_err(|_| commands::invalid("subject"))?;
                    None
                }
                None => Some(request),
            }
        };
        if let Some(request) = unsent {
            return commands::execute(
                None,
                self.inner.client.as_ref(),
                &Settings::default(),
                request,
            )
            .await;
        }
        answer.await.map_err(|_| commands::invalid("subject"))?
    }

    /// The module's dreamer, for tests that show it a project.
    #[cfg(test)]
    pub(crate) fn dreamer_engine(&self) -> Option<&Arc<crate::dreamer::engine::Engine>> {
        self.inner.dreamer.as_ref()
    }

    /// A command on memories, observations, the dreamer or notes. It runs on
    /// the calling task: each is a few short transactions on `context.db`,
    /// and its answer is kept in `sessions.db`, not in a session.
    async fn owner_command(
        &self,
        request: crate::user_commands::Request,
    ) -> Result<Value, subc_protocol::ErrorBody> {
        use crate::user_commands::{self as commands, owner, Request};
        let subject = match &request {
            Request::Preview(request) => &request.subject,
            Request::Run(request) => &request.subject,
        };
        let project_known = match subject {
            cortexkit_role_user_commands::Subject::Project { project_id } => {
                self.inner.app_read.knows_project(project_id).await
            }
            _ => true,
        };
        let context = owner::Context {
            db: self.inner.db.as_ref(),
            store: self.inner.store.as_deref(),
            dreamer: self.inner.dreamer.as_ref(),
            dreamer_settings: self.inner.config.dreamer(),
            client: &self.inner.client,
            project_known,
            gate: Some(self.inner.journal.gate().as_ref()),
        };
        match request {
            Request::Preview(request) => {
                let preview = owner::preview(&context, &request)?;
                preview.check().map_err(|e| e.refusal())?;
                serde_json::to_value(preview).map_err(|_| commands::invalid("reply"))
            }
            Request::Run(request) => {
                let reply = owner::run(&context, &request)?;
                reply.check().map_err(|e| e.refusal())?;
                serde_json::to_value(reply).map_err(|_| commands::invalid("reply"))
            }
        }
    }

    /// A new session's place: a worker that has no session yet.
    fn spawn_worker(&self, key: SessionRef) -> Slot {
        let (jobs, receiver) = mpsc::unbounded_channel::<Job>();
        self.run_worker(key, &jobs, receiver, None);
        Slot::Running(jobs)
    }

    /// Run `key`'s jobs from `receiver` on a task of their own, picking the
    /// session up from what its last worker kept (`quiet`) if it went quiet.
    /// After [`QUIET_AFTER`] without a job the worker frees the session and
    /// stops ([`free_quiet`]); a job that needs the session resumes what was
    /// freed before it runs ([`Session::resume_quiet`]).
    fn run_worker(
        &self,
        key: SessionRef,
        jobs: &mpsc::UnboundedSender<Job>,
        mut receiver: mpsc::UnboundedReceiver<Job>,
        quiet: Option<Quiet>,
    ) {
        let inner = Arc::clone(&self.inner);
        // Weak, so the worker's own handle never keeps it alive.
        let own = jobs.downgrade();
        tokio::spawn(async move {
            let held_key = key.clone();
            let mut search_guard = inner
                .search
                .as_ref()
                .map(|search| search.session_guard(key));
            let mut session: Option<Session> = None;
            let mut recent_restore_pending = false;
            let (mut carry, mut saved, mut subagent) = match quiet {
                Some(quiet) => (Some(quiet.carry), quiet.saved, quiet.subagent),
                None => (None, None, false),
            };
            let mut retry_save = false;
            // Jobs a move held, in the order they arrived, and the jobs to
            // run before the queue's next one once it no longer holds them.
            let mut held: VecDeque<Job> = VecDeque::new();
            let mut ready: VecDeque<Job> = VecDeque::new();
            // Setups and notices that wait for summaries a resume could not
            // read again, in the order they arrived.
            let mut unread: VecDeque<Job> = VecDeque::new();
            // A session without a summarizer is freed sooner once the runner
            // says its run ended.
            let watch_run_end = || {
                inner.client.run_ends().map(|ends| {
                    let own = own.clone();
                    ends.on_end(&held_key, move || {
                        if let Some(jobs) = own.upgrade() {
                            let _ = jobs.send(Job::RunEnded);
                        }
                    })
                })
            };
            let mut run_end = if subagent { watch_run_end() } else { None };
            let mut run_ended = false;
            // When each recent job started, so a slow tool call can name the
            // jobs it waited behind.
            let mut jobs_run = crate::tool_timing::WorkerJobs::default();
            let mut idle_since = None;
            loop {
                let job = match ready.pop_front() {
                    Some(job) => job,
                    None => {
                        let now = tokio::time::Instant::now();
                        let idle_at = *idle_since.get_or_insert(now);
                        // The quiet time counts from when the worker ran out
                        // of jobs, or from the run-end event if that came later.
                        let quiet_after = if run_ended {
                            QUIET_AFTER_RUN_END
                        } else {
                            QUIET_AFTER
                        };
                        let quiet_at = now + quiet_after;
                        // Biased, so a job that is waiting always runs before
                        // the session is freed.
                        tokio::select! {
                            biased;
                            job = receiver.recv() => match job {
                                Some(job) => job,
                                None => break,
                            },
                            () = tokio::time::sleep_until(quiet_at) => {
                                if retry_save && held.is_empty() && unread.is_empty() {
                                    retry_save = !retry_checkpoint(inner.store.as_deref(), session.as_ref(), &mut saved);
                                }
                                let freed = held.is_empty()
                                    && unread.is_empty()
                                    && !retry_save
                                    && free_quiet(
                                        &inner,
                                        &held_key,
                                        &own,
                                        &mut receiver,
                                        &mut session,
                                        &mut carry,
                                        &mut search_guard,
                                        Freed {
                                            saved: &saved,
                                            subagent,
                                            quiet_for: quiet_after,
                                            idle_since: idle_at,
                                        },
                                        &mut ready,
                                    );
                                if freed {
                                    break;
                                }
                                // Not now: try again after another quiet time.
                                continue;
                            }
                        }
                    }
                };
                let mut job = job;
                if !matches!(job, Job::RunEnded) {
                    idle_since = None;
                }
                let taken = std::time::Instant::now();
                jobs_run.started(job_kind(&job), taken);
                if let Job::Tool { timing, .. } = &mut job {
                    timing.mark_at("queue", taken);
                }
                let mut job = match inner.journal.gate().check(&held_key) {
                    Err(gated) => match hold(job, &gated, &mut held, &held_key) {
                        Some(job) => job,
                        None => continue,
                    },
                    Ok(()) if !held.is_empty() => {
                        // The move let the session go: what it held runs
                        // first, in order, then this job and the rest.
                        tracing::info!(
                            runner = %held_key.runner,
                            harness = %held_key.harness,
                            session = %held_key.session,
                            job_count = %held.len(),
                            "ck-mc: session: running jobs held during a move"
                        );
                        let rest = std::mem::take(&mut ready);
                        ready.extend(held.drain(..));
                        ready.push_back(job);
                        ready.extend(rest);
                        continue;
                    }
                    Ok(()) => job,
                };
                // The session's own activity after its run ended: it is in use
                // again, and waits its whole quiet time.
                if matches!(
                    &job,
                    Job::Setup(..)
                        | Job::Notice(_)
                        | Job::Ride(..)
                        | Job::Tool { .. }
                        | Job::PreUser { .. }
                        | Job::Command { .. }
                ) {
                    run_ended = false;
                }
                // A quiet session is resumed before a job that works on it.
                // The jobs that only ask about work in flight, and a
                // workspace answer, need nothing of it; the carry answers
                // `pre_user` as the resumed session would.
                let needs_session = !matches!(
                    &job,
                    Job::Idle(_)
                        | Job::Busy(_)
                        | Job::RunEnded
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. }
                        | Job::AppCheckpoint { .. }
                        | Job::Workspace { .. }
                        | Job::PreUser { .. }
                );
                if let Some(quiet) = carry.take_if(|_| needs_session) {
                    session = Some(resume(&inner, &held_key, quiet).await);
                    if let Job::Tool { timing, .. } = &mut job {
                        timing.mark("resume");
                    }
                }
                // Nothing runs on summaries a resume could not read again:
                // each such job tries the read first. Setups and notices wait
                // for it, in order; then they run before this job.
                let on_summaries = matches!(
                    &job,
                    Job::Setup(..)
                        | Job::Notice(_)
                        | Job::Ride(..)
                        | Job::Tool { .. }
                        | Job::Command { .. }
                        | Job::SummaryFinished(..)
                        | Job::AccountWait(_)
                );
                if on_summaries {
                    if session
                        .as_mut()
                        .is_some_and(|session| !session.summaries_ready())
                    {
                        hold_unread(job, &mut unread);
                        continue;
                    }
                    if !unread.is_empty() {
                        let rest = std::mem::take(&mut ready);
                        ready.extend(unread.drain(..));
                        ready.push_back(job);
                        ready.extend(rest);
                        continue;
                    }
                }
                let settings: Settings = match (&job, &session) {
                    (
                        Job::Idle(_)
                        | Job::Busy(_)
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. }
                        | Job::Recent { .. },
                        _,
                    ) => Settings::default(),
                    (Job::Setup(route, request, _), _) => route_settings(
                        &inner.config,
                        route,
                        &format!("{}/{}", request.model.provider, request.model.model),
                        request
                            .context_window
                            .saturating_sub(request.output_reserve),
                    ),
                    (job, Some(session)) => {
                        let incoming = match job {
                            Job::Notice(notice) => Some(&notice.conditions),
                            Job::Ride(ride, _) => Some(&ride.conditions),
                            _ => None,
                        };
                        let (root, model_key, usable) = session.config_inputs_for(incoming);
                        let project = session.config_project_id();
                        inner
                            .config
                            .resolve_for_project(root, project, &model_key, usable)
                    }
                    // The first tool call of a session that has no Setup: only
                    // the project's settings matter to its tools.
                    (Job::Tool { route, .. }, None) => route_settings(&inner.config, route, "", 0),
                    // A quiet session answering `pre_user` as it was freed.
                    (_, None) => match &carry {
                        Some(carry) => {
                            let (root, model_key, usable) = carry.config_inputs();
                            let project = carry.config_project_id();
                            inner
                                .config
                                .resolve_for_project(root, project, &model_key, usable)
                        }
                        None => Settings::default(),
                    },
                };
                let settings = &settings;
                if on_summaries && !matches!(&job, Job::SummaryFinished(..)) {
                    if let Some(session) = &mut session {
                        if let Some(continuation) = session
                            .retry_summary_publication(inner.client.as_ref(), now_ms())
                            .await
                        {
                            if let Some(job) = session.turn_two_job(settings, continuation) {
                                start_turn_two(&inner, own.clone(), job, &held_key);
                            }
                        }
                    }
                }
                let publish_app = !matches!(
                    &job,
                    Job::Idle(_)
                        | Job::Busy(_)
                        | Job::RunEnded
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. }
                        | Job::PreUser { .. }
                        | Job::AppCheckpoint { .. }
                        | Job::Recent { .. }
                );
                let refresh_search = matches!(&job, Job::Setup(..) | Job::Notice(..));
                let app_checkpoint = matches!(&job, Job::Setup(..))
                    || (session.is_none() && matches!(&job, Job::Tool { .. }));
                // A quiet session's workspace answer changes nothing the apps
                // show, so its projection is neither hydrated nor published.
                if publish_app && session.is_none() && carry.is_none() {
                    // Hydrate before this worker can save a newer checkpoint;
                    // queued reads and deltas then share the same hydrated state.
                    inner.app_read.activate(&held_key).await;
                    if let Job::Tool { timing, .. } = &mut job {
                        timing.mark("activate");
                    }
                }
                if let Job::Setup(_, _, features) = &job {
                    recent_restore_pending = false;
                    // Each Setup names the preset again.
                    subagent = !features.summarizer;
                    if !subagent {
                        run_end = None;
                        run_ended = false;
                    } else if run_end.is_none() {
                        run_end = watch_run_end();
                    }
                }
                match job {
                    Job::Resume => continue,
                    Job::RunEnded => {
                        // A later session job clears this flag, even if both
                        // jobs were queued while the worker was blocked.
                        run_ended = subagent;
                        continue;
                    }
                    Job::Command { request, reply } => {
                        if session.is_none() {
                            if let Some(durable) =
                                inner.store.as_ref().and_then(|store| store.load(&held_key))
                            {
                                let route = Route {
                                    session: held_key.clone(),
                                    project: None,
                                    workdir: None,
                                    agent_id: None,
                                };
                                let mut restored = Session::tools_only(&route, inner.db.clone());
                                restored.set_store(inner.store.clone());
                                restored.load_summaries();
                                restored.restore(durable);
                                session = Some(restored);
                            }
                        }
                        let read_only =
                            matches!(&request, crate::user_commands::Request::Preview(_));
                        let starts_wrapup = match &request {
                            crate::user_commands::Request::Run(request)
                                if request.id == "wrapup" =>
                            {
                                session
                                    .as_ref()
                                    .is_some_and(|s| !s.command_recorded(&request.request_id))
                            }
                            _ => false,
                        };
                        let result = crate::user_commands::execute(
                            session.as_mut(),
                            inner.client.as_ref(),
                            settings,
                            request,
                        )
                        .await;
                        let starts_wrapup = starts_wrapup
                            && result.as_ref().is_ok_and(|r| {
                                r.get("outcome").and_then(Value::as_str) == Some("scheduled")
                            });
                        let _ = reply.send(result);
                        if read_only {
                            continue;
                        }
                        if starts_wrapup {
                            if let Some(request) = session
                                .as_mut()
                                .and_then(|s| s.pending_wrapup_summary(settings))
                            {
                                start_summary(&inner, own.clone(), request, &held_key);
                            }
                        }
                    }
                    Job::Busy(reply) => {
                        let _ = reply.send(view_unconfirmed(session.as_ref()));
                        // A question changes nothing, so nothing is saved
                        // or published after it.
                        continue;
                    }
                    Job::Park { at, until } => {
                        // Wait only for a `prepare` still waiting for us; one
                        // that gave up dropped its end of `until` too.
                        if at.send(view_unconfirmed(session.as_ref())).is_ok() {
                            let _ = until.await;
                        }
                        continue;
                    }
                    Job::Discard { cut, replaced } => {
                        let what = if replaced {
                            "had its rows replaced with another machine's copy"
                        } else {
                            "was released to another machine"
                        };
                        tracing::info!(
                            runner = %held_key.runner,
                            harness = %held_key.harness,
                            session = %held_key.session,
                            state = %what,
                            %cut,
                            job_count = %held.len(),
                            "ck-mc: session: discarding Setup, notice and summary jobs held during an agent-data move"
                        );
                        break;
                    }
                    Job::AppCheckpoint { flush } => {
                        if let Some(session) = &mut session {
                            session.app_checkpoint_if_due(flush.is_some());
                        }
                        if let Some(reply) = flush {
                            let _ = reply.send(());
                        }
                    }
                    Job::Setup(route, request, features) => match &mut session {
                        // A session that so far only called tools starts
                        // afresh below, like any new one.
                        Some(existing) if existing.compacting() => {
                            if !ensure_memory_context(&inner, &route, existing).await {
                                read_workspace_again(&inner, &route);
                            }
                            existing
                                .setup(inner.client.as_ref(), settings, &route, &request, features)
                                .await
                        }
                        _ => {
                            let mut fresh =
                                Session::new(&route, &request, features, inner.db.clone());
                            fresh.set_store(inner.store.clone());
                            fresh.load_summaries();
                            if let Some(durable) = inner
                                .store
                                .as_ref()
                                .and_then(|store| store.load(&route.session))
                            {
                                fresh.restore(durable);
                            }
                            if !ensure_memory_context(&inner, &route, &mut fresh).await {
                                read_workspace_again(&inner, &route);
                            }
                            fresh
                                .setup(inner.client.as_ref(), settings, &route, &request, features)
                                .await;
                            session = Some(fresh);
                        }
                    },
                    Job::Notice(notice) => {
                        if let Some(session) = &mut session {
                            if let Some(request) = session
                                .notice(inner.client.as_ref(), settings, notice)
                                .await
                            {
                                start_summary(&inner, own.clone(), request, &held_key);
                            }
                        }
                    }
                    Job::SummaryFinished(result, counted) => {
                        let progressed = matches!(&*result, Ok(Some(_)));
                        if let Some(session) = &mut session {
                            let continuation = session
                                .summary_finished(
                                    inner.client.as_ref(),
                                    settings,
                                    *result,
                                    now_ms(),
                                )
                                .await;
                            if let Some(job) = continuation.and_then(|continuation| {
                                session.turn_two_job(settings, continuation)
                            }) {
                                start_turn_two(&inner, own.clone(), job, &held_key);
                            }
                            // A run that made progress is followed at once by
                            // the next one a numbers floor or a wrap-up still
                            // needs, not by the session's next notice.
                            if progressed && !session.has_pending_publication() {
                                if let Some(request) = session
                                    .pending_numbers_summary(settings)
                                    .or_else(|| session.pending_wrapup_summary(settings))
                                {
                                    start_summary(&inner, own.clone(), request, &held_key);
                                }
                            }
                        }
                        // The run stops counting only now that its result is
                        // handled and any second turn it started counts for
                        // itself.
                        drop(counted);
                    }
                    Job::AccountWait(wait) => {
                        if let Some(session) = &mut session {
                            session.account_refused(wait);
                        }
                    }
                    Job::Workspace { project, workspace } => {
                        if let Some(session) = &mut session {
                            session.follow_workspace(project.as_deref(), workspace);
                        } else if let Some(carry) = &mut carry {
                            carry.follow_workspace(project.as_deref(), workspace);
                        }
                    }
                    Job::Ride(ride, reply) => {
                        // A held session checks its summaries again first,
                        // and once they pass reads the transcript here.
                        if let Some(session) = session.as_mut() {
                            session.before_ride(inner.client.as_ref(), &ride).await;
                        }
                        // Past its deadline the runner already sends without
                        // a view: build none.
                        let mut view = if reply.is_closed() {
                            None
                        } else {
                            session
                                .as_mut()
                                .and_then(|session| session.ride(settings, &ride))
                        };
                        // Saved before the answer leaves, as for a pushed
                        // view: the runner may hold it from here on.
                        let mut save_failed = false;
                        if let (Some(store), Some(session), Some(_)) =
                            (&inner.store, session.as_ref(), view.as_ref())
                        {
                            let durable = session.durable();
                            match store.save(session.key(), &durable) {
                                Ok(()) => saved = Some(durable),
                                Err(error) => {
                                    tracing::warn!(
                                        %error,
                                        "ck-mc: session: saving durable state after a worker job failed"
                                    );
                                    save_failed = true;
                                }
                            }
                        }
                        if save_failed {
                            if let (Some(session), Some(view)) = (session.as_mut(), view.take()) {
                                session.ride_undelivered(view.version);
                            }
                        }
                        let delivered_version = view.as_ref().map(|v| v.version);
                        if let Err(Some(view)) = reply.send(view) {
                            if let Some(session) = session.as_mut() {
                                session.ride_undelivered(view.version);
                            }
                        } else if let (Some(session), Some(version)) =
                            (session.as_mut(), delivered_version)
                        {
                            session.app_view_status(version, "accepted");
                        }
                    }
                    Job::Tool {
                        route,
                        name,
                        input,
                        fork,
                        reply,
                        mut timing,
                    } => {
                        timing.mark("settings");
                        if session.is_none() {
                            let mut fresh = Session::tools_only(&route, inner.db.clone());
                            fresh.set_store(inner.store.clone());
                            if let Some(durable) = inner
                                .store
                                .as_ref()
                                .and_then(|store| store.load(&route.session))
                            {
                                // Summaries first: restoring checks the saved
                                // state against them.
                                fresh.load_summaries();
                                fresh.restore(durable);
                                fresh.restore_for_tools(inner.client.as_ref()).await;
                                timing.mark("restore");
                            }
                            session = Some(fresh);
                        }
                        let session = session.as_mut().expect("tool session");
                        let (root, model, usable) = session.config_inputs();
                        let project = session.config_project_id();
                        let settings = inner
                            .config
                            .resolve_for_project(root, project, &model, usable);
                        let config = inner.config.catalog_for_tool_call(root, project);
                        timing.mark("config");
                        let answer = if !session.serves_tool(&name, &config) {
                            Err(ModuleError::UnknownTool(name.clone()))
                        } else if name == "ctx_memory" && !settings.memory_enabled {
                            Err(ModuleError::Tool(
                                "Cross-session memory is disabled for this project.".into(),
                            ))
                        } else {
                            if name == "ctx_memory" {
                                ensure_memory_context(&inner, &route, session).await;
                                timing.mark("memory_context");
                            }
                            session
                                .tool_timed(
                                    inner.client.as_ref(),
                                    &settings,
                                    &name,
                                    &input,
                                    fork,
                                    &mut timing,
                                )
                                .await
                                .map_err(ModuleError::Tool)
                        };
                        let _ = reply.send(answer);
                        // After the answer has left, so writing the line
                        // never delays it.
                        if matches!(name.as_str(), "ctx_search" | "ctx_memory") {
                            timing.log(&name, &held_key, &input, &jobs_run);
                        }
                    }
                    Job::PreUser { text, now, reply } => {
                        let answer = match (&session, &carry) {
                            (Some(session), _) => session.pre_user(settings, &text, now).await,
                            (None, Some(carry)) => carry.pre_user(settings, &text, now).await,
                            (None, None) => Addition::default(),
                        };
                        let _ = reply.send(answer);
                        // A person's message is followed by the runner's next
                        // request: resume the freed session now, while the
                        // model works, rather than making that request wait
                        // for the resume.
                        if let Some(quiet) = carry.take() {
                            session = Some(resume(&inner, &held_key, quiet).await);
                        }
                    }
                    Job::Recent { budget, reply } => {
                        if session.is_none() {
                            if let Some(durable) =
                                inner.store.as_ref().and_then(|store| store.load(&held_key))
                            {
                                // Restored as for a tool call that arrives
                                // before the runner's first notice: one read
                                // of the transcript from the cut on (the first
                                // message the runner still sends).
                                inner.app_read.activate(&held_key).await;
                                let route = Route {
                                    session: held_key.clone(),
                                    project: None,
                                    workdir: None,
                                    agent_id: None,
                                };
                                let mut restored = Session::tools_only(&route, inner.db.clone());
                                restored.set_store(inner.store.clone());
                                restored.load_summaries();
                                restored.restore(durable);
                                session = Some(restored);
                                recent_restore_pending = true;
                            }
                        }
                        let answer = match &mut session {
                            Some(session) => {
                                if recent_restore_pending {
                                    recent_restore_pending =
                                        !session.ensure_recent_index(inner.client.as_ref()).await;
                                }
                                session.recent(budget)
                            }
                            None => Err(crate::context_read::unknown_session()),
                        };
                        let _ = reply.send(answer);
                        // A read: nothing to publish or save.
                        continue;
                    }
                    Job::Idle(reply) => {
                        if retry_save {
                            retry_save = !retry_checkpoint(
                                inner.store.as_deref(),
                                session.as_ref(),
                                &mut saved,
                            );
                        }
                        let _ = reply.send(());
                        // A barrier changes no session state. The preceding
                        // job already persisted its changes unless a failed
                        // write above needs retrying. Successful barriers need
                        // no extra snapshot or save.
                        continue;
                    }
                }
                if let Some(session) = session.as_mut().filter(|_| publish_app) {
                    session.publish_app(&inner.app_read, app_checkpoint);
                    if refresh_search && session.search_enabled() {
                        if let Some(search) = &inner.search {
                            let key = session.key().clone();
                            search.mark(&key, session.search_mark());
                        }
                    }
                }
                if let Some(session) = &mut session {
                    if let Some(deadline) = session.app_snapshot_deadline() {
                        let own = own.clone();
                        let timer = tokio::spawn(async move {
                            tokio::time::sleep_until(deadline).await;
                            if let Some(worker) = own.upgrade() {
                                let _ = worker.send(Job::AppCheckpoint { flush: None });
                            }
                        });
                        session.app_arm_snapshot(timer.abort_handle());
                    }
                }
                // A tools-only session has nothing to keep across a restart.
                if let (Some(store), Some(session)) = (
                    &inner.store,
                    session.as_ref().filter(|session| session.compacting()),
                ) {
                    let durable = session.durable();
                    if saved.as_ref() != Some(&durable) {
                        match store.save(session.key(), &durable) {
                            Ok(()) => {
                                saved = Some(durable);
                                retry_save = false;
                            }
                            Err(error) => {
                                retry_save = true;
                                tracing::warn!(
                                    %error,
                                    "ck-mc: session: retrying a durable state save failed"
                                );
                            }
                        }
                    }
                }
            }
        });
    }
}

/// Retry a failed end-of-job write before releasing the live session.
fn retry_checkpoint(
    store: Option<&Store>,
    session: Option<&Session>,
    saved: &mut Option<crate::store::Durable>,
) -> bool {
    let (Some(store), Some(session)) = (store, session.filter(|s| s.compacting())) else {
        return false;
    };
    let durable = session.durable();
    match store.save(session.key(), &durable) {
        Ok(()) => {
            *saved = Some(durable);
            true
        }
        Err(error) => {
            tracing::warn!(%error, "ck-mc: session: saving durable state failed");
            false
        }
    }
}

/// The module as the `agent-data` service's host: its journal, its
/// sessions' workers and summarizer work, its `context.db`, and the
/// daemon's catalog and Entorhinal through its client.
impl<C: RunnerClient + Router + Send + Sync + 'static> crate::agent_data::Host for Module<C> {
    fn journal(&self) -> &crate::agent_data::Journal {
        &self.inner.journal
    }

    fn historian_running(&self, session: &SessionRef) -> bool {
        self.inner.runs.running(session)
    }

    async fn probe(&self, session: &SessionRef, budget: Duration) -> crate::agent_data::Probe {
        use crate::agent_data::Probe;
        let (reply, answer) = oneshot::channel();
        match self.send_running(session, Job::Busy(reply)) {
            Err(ModuleError::UnknownSession) => return Probe::NoWorker,
            // A worker that stopped cannot say what it was doing.
            Err(_) => return Probe::NoAnswer,
            Ok(()) => {}
        }
        match tokio::time::timeout(budget, answer).await {
            Ok(Ok(view_unconfirmed)) => Probe::Answered { view_unconfirmed },
            Ok(Err(_)) | Err(_) => Probe::NoAnswer,
        }
    }

    fn context_db(&self) -> Option<std::path::PathBuf> {
        self.inner.db.as_ref().map(|db| db.path.clone())
    }

    async fn ready_participants(&self, capability: &str) -> Result<Vec<String>, String> {
        self.inner.client.ready_participants(capability).await
    }

    async fn entorhinal(
        &self,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, crate::client::EntorhinalRefusal>> {
        self.inner
            .client
            .entorhinal_call(&crate::agent_data::resolve::lookup_identity(), body)
            .await
    }

    async fn park(&self, session: &SessionRef, budget: Duration) -> crate::agent_data::Park {
        use crate::agent_data::{Park, Parked};
        let (at, reached) = oneshot::channel();
        let (release, until) = oneshot::channel();
        match self.send_running(session, Job::Park { at, until }) {
            Err(ModuleError::UnknownSession) => return Park::NoWorker,
            Err(_) => return Park::NoAnswer,
            Ok(()) => {}
        }
        match tokio::time::timeout(budget, reached).await {
            Ok(Ok(view_unconfirmed)) => Park::Parked(Parked {
                view_unconfirmed,
                release,
            }),
            Ok(Err(_)) | Err(_) => Park::NoAnswer,
        }
    }

    fn resume(&self, session: &SessionRef) {
        let _ = self.send_running(session, Job::Resume);
    }

    fn forget(&self, session: &SessionRef, cut: &str) {
        self.drop_session(session, cut, false);
    }

    fn reset(&self, session: &SessionRef, cut: &str) {
        self.drop_session(session, cut, true);
    }

    fn active(&self, session: &SessionRef) -> bool {
        // A quiet session still runs here: its next job starts its worker
        // again.
        self.inner
            .workers
            .lock()
            .expect("worker map")
            .contains_key(session)
    }

    fn state_rows(&self, session: &SessionRef) -> Result<Value, String> {
        match &self.inner.store {
            Some(store) => store.session_rows(session),
            None => Ok(Value::Object(Default::default())),
        }
    }

    fn clear_state(&self, session: &SessionRef) -> Result<(), String> {
        match &self.inner.store {
            Some(store) => store.clear_session(session),
            None => Ok(()),
        }
    }

    async fn door(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, crate::client::DoorRefusal> {
        self.inner.client.door_call(method, params, deadline).await
    }

    fn stream(&self) -> String {
        self.inner.client.door_stream()
    }
}

/// What a worker does with a job it takes off its queue while a move holds
/// its session. Setup and notices were answered when they were queued, so
/// the runner believes ck-mc holds what they carry: they are held, in order,
/// and run if the move is aborted. A summary result is held with them, so it
/// never writes rows the move is reading. A ride gets no view, a tool call
/// the move's refusal, and `pre_user` nothing. `Some` hands back a job that
/// runs as usual: a barrier, a checkpoint of the app projection, or a wake.
fn hold(
    job: Job,
    gated: &crate::agent_data::Gated,
    held: &mut VecDeque<Job>,
    key: &SessionRef,
) -> Option<Job> {
    match job {
        Job::Setup(..)
        | Job::Notice(_)
        | Job::RunEnded
        | Job::SummaryFinished(..)
        | Job::AccountWait(_)
        | Job::Workspace { .. } => {
            if held.is_empty() {
                tracing::info!(
                    runner = %key.runner,
                    harness = %key.harness,
                    session = %key.session,
                    cut = %gated.cut.as_deref().unwrap_or("journal unreadable"),
                    "ck-mc: session: holding its Setup and notices while a move holds it; they run if the move is aborted"
                );
            }
            held.push_back(job);
            None
        }
        Job::Ride(_, reply) => {
            let _ = reply.send(None);
            None
        }
        Job::Command { reply, .. } => {
            let _ = reply.send(Err(session_moving_command()));
            None
        }
        Job::Tool { reply, .. } => {
            let _ = reply.send(Err(ModuleError::Gated(gated.clone())));
            None
        }
        Job::PreUser { reply, .. } => {
            let _ = reply.send(Addition::default());
            None
        }
        Job::Recent { reply, .. } => {
            let _ = reply.send(Err(gated.refusal()));
            None
        }
        Job::Idle(_)
        | Job::Busy(_)
        | Job::Resume
        | Job::Park { .. }
        | Job::Discard { .. }
        | Job::AppCheckpoint { .. } => Some(job),
    }
}

/// The answer to a session command while a move holds the session.
fn session_moving_command() -> subc_protocol::ErrorBody {
    subc_protocol::ErrorBody::new("unknown_subject", "Session is moving or unavailable.")
}

/// A job's kind, as a slow tool call's log line names the jobs it waited
/// behind ([`crate::tool_timing`]); a tool call by its tool's name.
fn job_kind(job: &Job) -> &'static str {
    match job {
        Job::Command { .. } => "command",
        Job::Setup(..) => "setup",
        Job::Notice(_) => "notice",
        Job::Ride(..) => "ride",
        Job::Tool { name, .. } => match name.as_str() {
            "ctx_search" => "tool:ctx_search",
            "ctx_memory" => "tool:ctx_memory",
            "ctx_note" => "tool:ctx_note",
            "ctx_expand" => "tool:ctx_expand",
            "ctx_reduce" => "tool:ctx_reduce",
            "ctx_keep" => "tool:ctx_keep",
            _ => "tool",
        },
        Job::PreUser { .. } => "pre_user",
        Job::RunEnded => "run_ended",
        Job::Idle(_) => "idle",
        Job::Busy(_) => "busy",
        Job::Resume => "resume",
        Job::Park { .. } => "park",
        Job::Discard { .. } => "discard",
        Job::AppCheckpoint { .. } => "app_checkpoint",
        Job::SummaryFinished(..) => "summary_finished",
        Job::AccountWait(_) => "account_wait",
        Job::Workspace { .. } => "workspace",
        Job::Recent { .. } => "recent",
    }
}

/// Whether a view the session offered the runner is still unconfirmed.
fn view_unconfirmed(session: Option<&Session>) -> bool {
    session
        .filter(|session| session.compacting())
        .is_some_and(|session| !session.durable().unconfirmed.is_empty())
}

/// What a worker that frees its session keeps besides the session, and
/// how long the session had no job, for the log.
struct Freed<'a> {
    saved: &'a Option<crate::store::Durable>,
    subagent: bool,
    quiet_for: Duration,
    idle_since: tokio::time::Instant,
}

/// Free the session of a worker whose queue stayed empty for its quiet
/// time, and give the worker's place in the map to what is kept of it
/// ([`Quiet`]), so the next job starts a worker again with that. A session
/// that only called tools keeps nothing, and leaves the map as it was before
/// its first call. True when the worker may stop now.
///
/// False while the session can't be freed: a move or a summarizer run holds
/// it, its state, its apps' rows or its search index are not saved yet, or
/// there is no store to read its summaries and decisions again from. False
/// also when a job arrived meanwhile: the job is then in `ready`, and the
/// session, freed already, is resumed before the job runs.
#[allow(clippy::too_many_arguments)]
fn free_quiet<'a, C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &'a Inner<C>,
    key: &SessionRef,
    own: &mpsc::WeakUnboundedSender<Job>,
    receiver: &mut mpsc::UnboundedReceiver<Job>,
    session: &mut Option<Session>,
    carry: &mut Option<crate::session::QuietCarry>,
    search_guard: &mut Option<crate::search::background::SessionGuard<'a>>,
    freed: Freed<'_>,
    ready: &mut VecDeque<Job>,
) -> bool {
    use futures_util::FutureExt;
    if inner.store.is_none()
        || inner.db.is_none()
        || inner.journal.gate().check(key).is_err()
        || inner.runs.running(key)
    {
        return false;
    }
    // A worker that stops drops its search guard, and the search index then
    // forgets the session, with any messages it has not indexed yet: free
    // the session only once the index is idle.
    let searched = inner
        .search
        .as_ref()
        .is_none_or(|search| matches!(search.idle(key).now_or_never(), Some(Ok(()))));
    if !searched {
        return false;
    }
    if session.as_ref().is_some_and(|live| !live.compacting()) {
        // A session that only called tools keeps nothing: its next call
        // starts a fresh one, as its first call did.
        let live = session.as_mut().expect("a session that only called tools");
        live.app_checkpoint_if_due(true);
        if live.app_snapshot_deadline().is_some()
            || give_up_place(inner, key, own, receiver, search_guard, ready, None).is_err()
        {
            return false;
        }
        *session = None;
        tracing::info!(
            session = %key.session,
            idle_secs = %freed.quiet_for.as_secs(),
            "ck-mc: session: freed after being idle without a job; its next job reads it again"
        );
        return true;
    }
    if let Some(live) = session.take() {
        // The next worker reads the session's state from the store.
        let kept = if freed.saved.as_ref() == Some(&live.durable()) {
            Box::new(live).quiet_carry()
        } else {
            Err(Box::new(live))
        };
        match kept {
            Ok(kept) => *carry = Some(kept),
            Err(live) => {
                *session = Some(*live);
                return false;
            }
        }
    }
    let Some(kept) = carry.take() else {
        return false;
    };
    let quiet = Box::new(Quiet {
        carry: kept,
        idle_since: freed.idle_since,
        saved: freed.saved.clone(),
        subagent: freed.subagent,
    });
    if let Err(quiet) = give_up_place(inner, key, own, receiver, search_guard, ready, Some(quiet)) {
        *carry = quiet.map(|quiet| quiet.carry);
        return false;
    }
    tracing::info!(
        session = %key.session,
        idle_secs = %freed.quiet_for.as_secs(),
        "ck-mc: session: freed after being idle without a job; its next job reads it again"
    );
    true
}

/// Give a worker's place in the map up to what is kept of its session
/// (`quiet`), or leave the session no place at all (`None`): under the map's
/// lock, only while the worker's queue is empty and the place is still the
/// worker's. Otherwise `quiet` comes back, and a job that arrived meanwhile
/// is in `ready`.
fn give_up_place<'a, C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &'a Inner<C>,
    key: &SessionRef,
    own: &mpsc::WeakUnboundedSender<Job>,
    receiver: &mut mpsc::UnboundedReceiver<Job>,
    search_guard: &mut Option<crate::search::background::SessionGuard<'a>>,
    ready: &mut VecDeque<Job>,
    quiet: Option<Box<Quiet>>,
) -> Result<(), Option<Box<Quiet>>> {
    let mut set_up = quiet
        .is_none()
        .then(|| inner.set_up.lock().expect("setup sessions"));
    let mut workers = inner.workers.lock().expect("worker map");
    if let Ok(job) = receiver.try_recv() {
        ready.push_back(job);
        return Err(quiet);
    }
    let ours = |worker: &mpsc::UnboundedSender<Job>| {
        own.upgrade().is_some_and(|own| own.same_channel(worker))
    };
    if !workers
        .get(key)
        .is_some_and(|slot| matches!(slot, Slot::Running(worker) if ours(worker)))
    {
        // A move dropped the session, and its Discard is on the way.
        return Err(quiet);
    }
    // Under the lock, so the next worker's search work and projection come
    // after this worker's guard and release.
    *search_guard = None;
    match quiet {
        Some(quiet) => {
            workers.insert(key.clone(), Slot::Quiet(quiet));
        }
        None => {
            workers.remove(key);
            Module::<C>::forget_setup(
                inner,
                set_up.as_deref_mut().expect("setup sessions"),
                key,
                false,
            );
        }
    }
    inner.app_read.release(key);
    Ok(())
}

/// Resume a quiet session's carry for the job that needs it
/// ([`Session::resume_quiet`]).
async fn resume<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Inner<C>,
    key: &SessionRef,
    carry: crate::session::QuietCarry,
) -> Session {
    // Hydrate the apps' projection first, as for a new worker.
    inner.app_read.activate(key).await;
    let started = std::time::Instant::now();
    let session = Session::resume_quiet(carry);
    tracing::info!(
        session = %key.session,
        elapsed_ms = %started.elapsed().as_millis(),
        "ck-mc: session: resumed after a quiet free"
    );
    session
}

/// What a worker does with a job that needs a session whose summaries a
/// resume could not read again ([`Session::summaries_ready`]). A Setup or
/// notice waits in `unread`, in order, for the read to succeed, as do a
/// summarizer run's result and an account wait. A ride gets no view, and a
/// tool call or a person's command is refused for now.
fn hold_unread(job: Job, unread: &mut VecDeque<Job>) {
    match job {
        Job::Setup(..) | Job::Notice(_) | Job::SummaryFinished(..) | Job::AccountWait(_) => {
            unread.push_back(job);
        }
        Job::Ride(_, reply) => {
            let _ = reply.send(None);
        }
        Job::Tool { reply, .. } => {
            let _ = reply.send(Err(ModuleError::Tool(
                "Magic Context can't read this session's history right now; try again shortly."
                    .into(),
            )));
        }
        Job::Command { reply, .. } => {
            let _ = reply.send(Err(subc_protocol::ErrorBody::new(
                "store_unavailable",
                "The session's history can't be read right now; try again shortly.",
            )));
        }
        // Jobs that need no summaries run as usual and never come here.
        job => unread.push_back(job),
    }
}

/// Read again, off the Setup's path, which workspace the session's project
/// is in now, and hand the answer to the session's worker. A head runs for
/// months while its project may move to another workspace; one Entorhinal
/// read per Setup is how it notices.
fn read_workspace_again<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    route: &Route,
) {
    let Some(folder) = route.workdir.clone() else {
        return;
    };
    let session = route.session.clone();
    read_workspaces(inner, vec![(folder, (session.clone(), vec![session]))]);
}

/// A folder's sessions: the one whose route Entorhinal is asked under, and
/// all of them.
type Folder = (SessionRef, Vec<SessionRef>);

/// Read again, in the background, which project and workspace each folder is
/// in now: one Entorhinal read per folder, in turn, asked under the named
/// session's route. Each answer goes to the workers of that folder's
/// sessions, started again for a session that went quiet meanwhile; a
/// folder Entorhinal doesn't answer for changes nothing.
fn read_workspaces<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    folders: Vec<(String, Folder)>,
) {
    if folders.is_empty() {
        return;
    }
    let module = Module {
        inner: Arc::clone(inner),
    };
    tokio::spawn(async move {
        for (folder, (session, sessions)) in folders {
            let Some((project, workspace)) = crate::memory_context::read_workspace(
                module.inner.client.as_ref(),
                &session,
                &folder,
            )
            .await
            else {
                continue;
            };
            for session in sessions {
                // A session a move dropped since has no worker to tell.
                let _ = module.send(
                    &session,
                    Job::Workspace {
                        project: project.clone(),
                        workspace: workspace.clone(),
                    },
                );
            }
        }
    });
}

/// Give `session` its memory context: the one stored for it,
/// or one read from Entorhinal now and stored for good. A session without a
/// folder has none, and its new memories stay unplaced. Returns whether it
/// read Entorhinal just now, so the caller doesn't read the workspace again.
async fn ensure_memory_context<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Inner<C>,
    route: &Route,
    session: &mut Session,
) -> bool {
    if session.has_memory_context() {
        return false;
    }
    let Some(folder) = route.workdir.as_deref() else {
        return false;
    };
    let stored = inner
        .store
        .as_ref()
        .and_then(|store| store.memory_context(&route.session));
    let read_now = stored.is_none();
    let context = match stored {
        Some(context) => context,
        None => {
            let read = crate::memory_context::read(
                inner.client.as_ref(),
                &route.session,
                folder,
                route.agent_id.as_deref(),
            )
            .await;
            match &inner.store {
                Some(store) => store.keep_memory_context(&route.session, read),
                None => read,
            }
        }
    };
    session.set_memory_context(context);
    read_now
}

/// Run the summarizer beside the session's worker, and hand its result back
/// as a job. The run counts for `session` until its result is handled.
fn start_summary<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    worker: mpsc::WeakUnboundedSender<Job>,
    request: run::Request,
    session: &SessionRef,
) {
    *inner.summaries_running.lock().expect("summary count") += 1;
    let counted = inner.runs.start(session);
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let telemetry = inner.search.as_ref().map(|writer| {
            crate::summary::telemetry::Record::start(
                writer.historian_writer(),
                request.session.clone(),
                request.trigger,
            )
        });
        let result = run::run_tracked(
            inner.client.as_ref(),
            inner.db.as_deref(),
            &request,
            telemetry,
        )
        .await;
        if let Some(worker) = worker.upgrade() {
            let _ = worker.send(Job::SummaryFinished(Box::new(result), counted));
        }
        *inner.summaries_running.lock().expect("summary count") -= 1;
    });
}

/// Run the two-pass historian's second turn beside the session's worker.
/// It writes only memories and candidate rows, never the session's state,
/// so nothing comes back to the worker but an account wait it met;
/// [`Module::idle`] waits for it as for a summary, and it counts for
/// `session` until it ends.
fn start_turn_two<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    worker: mpsc::WeakUnboundedSender<Job>,
    job: crate::summary::two_pass::turn_two::Job,
    session: &SessionRef,
) {
    let Some(db) = inner.db.clone() else {
        return;
    };
    *inner.summaries_running.lock().expect("summary count") += 1;
    let counted = inner.runs.start(session);
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let outcome =
            crate::summary::two_pass::turn_two::run(inner.client.as_ref(), &db, &job).await;
        // Turn two reserves and settles the project's candidate facts and
        // writes its memories; one notice after it covers all of them.
        db.changed(crate::app_read::Change::project_memories(&job.project));
        tracing::info!(
            session = %job.owner.session,
            ?outcome,
            "ck-mc: session: turn two finished"
        );
        if let crate::summary::two_pass::turn_two::Outcome::AccountWait(wait) = outcome {
            if let Some(worker) = worker.upgrade() {
                let _ = worker.send(Job::AccountWait(wait));
            }
        }
        // Queue telemetry before tests or maintenance can observe that this turn has ended.
        drop(job);
        drop(counted);
        *inner.summaries_running.lock().expect("summary count") -= 1;
    });
}

fn route_settings(config: &Config, route: &Route, model_key: &str, usable: u64) -> Settings {
    config.resolve_for_project(
        route
            .project
            .as_ref()
            .map(|project| project.root.as_str())
            .or(route.workdir.as_deref()),
        route.project.as_ref().map(|project| project.id.as_str()),
        model_key,
        usable,
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

#[cfg(test)]
#[path = "module_health_tests.rs"]
mod health_tests;

#[cfg(test)]
#[path = "app_read/deadline_tests.rs"]
mod app_snapshot_tests;

#[cfg(test)]
#[path = "agent_data/worker_tests.rs"]
mod agent_data_worker_tests;

#[cfg(test)]
#[path = "agent_data/source_tests.rs"]
mod agent_data_source_tests;

#[cfg(test)]
#[path = "agent_data/receiver_tests.rs"]
mod agent_data_receiver_tests;

#[cfg(test)]
#[path = "agent_data/runner_tests.rs"]
mod agent_data_runner_tests;

#[cfg(test)]
#[path = "statement_epoch_tests.rs"]
mod statement_epoch_tests;

#[cfg(test)]
#[path = "module_dreamer_tests.rs"]
mod dreamer_folder_tests;

#[cfg(test)]
mod config_tests {
    use super::*;
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;

    #[cfg(feature = "managed-settings")]
    #[test]
    fn managed_setup_in_an_unregistered_folder_uses_only_the_user_view() {
        use subc_client_rs::config::{ConfigLayer, ConfigLayerSnapshot, ConfigStatus, ConfigView};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join(".cortexkit")).unwrap();
        std::fs::write(
            root.join(".cortexkit/magic-context.jsonc"),
            r#"{"execute_threshold_percentage":90}"#,
        )
        .unwrap();
        let loader =
            crate::config::Loader::with_user_path(root.join("user.jsonc")).managed_offline(root);
        let user = serde_json::json!({"execute_threshold_percentage":{"default":70}});
        loader
            .config_apply(&ConfigView::new(
                1,
                user.clone(),
                Default::default(),
                vec![],
                ConfigStatus::Active,
            ))
            .unwrap();
        let mut project = ConfigView::new(
            0,
            user,
            Default::default(),
            vec![ConfigLayerSnapshot::file(
                crate::MODULE_ID,
                ConfigLayer::Project,
                root.join(".cortexkit/magic-context.jsonc")
                    .to_string_lossy(),
                Some(br#"{"execute_threshold_percentage":{"default":85}}"#.to_vec()),
            )],
            ConfigStatus::Unstamped,
        );
        project.project_id = Some("pj-registered".to_owned());
        loader.config_apply(&project).unwrap();
        let config = Config::Files(loader);
        let mut route = Route {
            session: SessionRef::new("runner", "test", "folder-config"),
            project: None,
            workdir: Some(root.to_string_lossy().into_owned()),
            agent_id: None,
        };
        assert_eq!(
            route_settings(&config, &route, "test/model", 100_000).execute_threshold_percentage,
            70.0
        );
        route.project = Some(crate::route::Project {
            id: "pj-registered".to_owned(),
            root: root.to_string_lossy().into_owned(),
        });
        assert_eq!(
            route_settings(&config, &route, "test/model", 100_000).execute_threshold_percentage,
            85.0
        );
    }

    #[test]
    fn folder_only_setup_and_first_tool_match_later_passes() {
        let root = std::env::temp_dir().join(format!("ck-mc-folder-config-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".cortexkit")).unwrap();
        std::fs::write(root.join("user.jsonc"), "{}").unwrap();
        std::fs::write(root.join(".cortexkit/magic-context.jsonc"), r#"{"execute_threshold_percentage":85,"history_budget_percentage":0.2,"memory":{"injection_budget_tokens":5000}}"#).unwrap();
        let config = Config::Files(crate::config::Loader::with_user_path(
            root.join("user.jsonc"),
        ));
        let route = Route {
            session: SessionRef::new("runner", "test", "folder-config"),
            project: None,
            workdir: Some(root.to_string_lossy().into_owned()),
            agent_id: None,
        };
        let request = SetupRequest::new(
            "config-test",
            ModelRef::new("test", "model"),
            200_000,
            32_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            0,
        );
        let session = Session::new(&route, &request, preset::Features::NONE, None);
        let (folder, model, usable) = session.config_inputs();
        let later = config.resolve_for_project(folder, session.config_project_id(), &model, usable);
        let setup = route_settings(&config, &route, &model, usable);
        let first_tool = route_settings(&config, &route, "", 0);
        assert_eq!(later.execute_threshold_percentage, 85.0);
        assert_eq!(
            setup.execute_threshold_percentage,
            later.execute_threshold_percentage
        );
        assert_eq!(
            setup.history_budget_percentage,
            later.history_budget_percentage
        );
        assert_eq!(first_tool.memory_budget_tokens, later.memory_budget_tokens);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path = "quiet_session_tests.rs"]
mod quiet_session_tests;
