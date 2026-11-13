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
    workers: Mutex<HashMap<SessionRef, mpsc::UnboundedSender<Job>>>,
    /// The sessions set up in this process, each with the statement epoch
    /// its newest Setup named (`None` when it named none). Every notice and
    /// ride is checked against it as it arrives, before it is queued (see
    /// the `statement_order` module). In memory only: after a restart every
    /// session is set up again.
    set_up: Mutex<HashMap<SessionRef, Option<String>>>,
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
        reply: oneshot::Sender<Result<String, ModuleError>>,
    },
    PreUser {
        text: String,
        now: u64,
        reply: oneshot::Sender<Addition>,
    },
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
        let config = Arc::new(config.into());
        let session_projects = Arc::new(Mutex::new(HashMap::new()));
        let context_read = crate::context_read::ContextRead::new(
            db.as_ref().map(|d| d.path.clone()),
            store.as_ref().map(|s| s.path.clone()),
            config.clone(),
            session_projects.clone(),
            journal.gate().clone(),
        );
        let app_read = crate::app_read::AppRead::new(
            store.as_ref().map(|s| s.path.clone()),
            db.as_ref().map(|d| d.path.clone()),
        );
        let client = Arc::new(client);
        let search = db
            .as_ref()
            .map(|db| crate::search::background::Background::new(client.clone(), db.path.clone()));
        let dreamer = db.as_ref().map(|_| {
            Arc::new(crate::dreamer::engine::Engine::new(
                format!("ck-mc:{}", std::process::id()),
                crate::dreamer::tasks(),
            ))
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
        });
        Self {
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
                summaries_running: Mutex::new(0),
                runs: Arc::default(),
                agent_data: crate::agent_data::Service::new(agent_data),
                session_projects,
                active_projects: Mutex::new(HashMap::new()),
                dreamer,
            }),
        }
    }

    /// App requests read an independent projection, never a session job.
    pub fn app_read(&self) -> &crate::app_read::AppRead {
        &self.inner.app_read
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

    /// An app read, refused for a session a move holds before the
    /// projection is asked.
    pub async fn app_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, cortexkit_role_compaction::wire::Refusal> {
        self.app_gate(&params)?;
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
    /// with no worker holds nothing.
    pub fn resume(&self, session: &SessionRef) {
        let _ = self.send(session, Job::Resume);
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
        // Everything the app reads show was built from the rows and views the
        // move took away or replaced. Until the session's next Setup, a read
        // of it is answered as for a session this process never saw.
        self.inner.app_read.forget_session(session, replaced);
        let worker = self
            .inner
            .workers
            .lock()
            .expect("worker map")
            .remove(session);
        if let Some(worker) = worker {
            let _ = worker.send(Job::Discard {
                cut: cut.to_owned(),
                replaced,
            });
        }
        self.inner
            .set_up
            .lock()
            .expect("setup sessions")
            .remove(session);
        self.inner
            .session_projects
            .lock()
            .expect("session projects")
            .retain(|key, _| {
                if replaced {
                    !(key.harness == session.harness && key.session == session.session)
                } else {
                    key != session
                }
            });
    }

    /// Context reads use a separate read-only worker so they cannot delay session work.
    pub fn context_read(&self) -> &crate::context_read::ContextRead {
        &self.inner.context_read
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
            workers
                .values()
                .filter_map(|worker| {
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
        }
        // The epoch is recorded and the Setup queued under one lock, the one
        // a notice or ride is checked and queued under. So no statement
        // checked against the epoch this Setup replaces is queued behind it,
        // and of two Setups racing, the one queued last is the one recorded.
        // The queue is unbounded, so sending never waits.
        let mut set_up = self.inner.set_up.lock().expect("setup sessions");
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            workers
                .entry(route.session.clone())
                .or_insert_with(|| self.spawn_worker(route.session.clone()))
                .clone()
        };
        let key = route.session.clone();
        let epoch = request.statement_epoch.clone();
        worker
            .send(Job::Setup(route, request, features))
            .map_err(|_| ModuleError::Stopped)?;
        set_up.insert(key, epoch);
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
                "ck-mc: session {}: dropped a {kind} from statement epoch {:?} (stamp {:?}): the session's Setup named epoch {:?}; asking the runner to set the session up again",
                session.session,
                conditions.statement_epoch,
                conditions.statement_seq,
                held
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
        let config = self.inner.config.catalog_config(project_root);
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
        self.admit(&route.session)?;
        let (reply, answer) = oneshot::channel();
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            workers
                .entry(route.session.clone())
                .or_insert_with(|| self.spawn_worker(route.session.clone()))
                .clone()
        };
        worker
            .send(Job::Tool {
                route: route.clone(),
                name: name.to_owned(),
                input,
                reply,
            })
            .map_err(|_| ModuleError::Stopped)?;
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

    /// Drain foreground work only. Background indexing is fenced separately
    /// when a test needs search results rather than an applied compaction view.
    pub async fn idle_foreground(&self, session: &SessionRef) -> Result<(), ModuleError> {
        loop {
            let (reply, answer) = oneshot::channel();
            self.send(session, Job::Idle(reply))?;
            answer.await.map_err(|_| ModuleError::Stopped)?;
            if *self.inner.summaries_running.lock().expect("summary count") == 0 {
                // A run that just ended queued its result before the count
                // dropped; one more round handles it.
                let (reply, answer) = oneshot::channel();
                self.send(session, Job::Idle(reply))?;
                return answer.await.map_err(|_| ModuleError::Stopped);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// One upkeep round: every project with a Setup or notice in the last
    /// hour, one after another. Returns each project's report.
    pub async fn run_upkeep(&self) -> Vec<(String, crate::upkeep::Report)> {
        let Some(db) = self.inner.db.clone() else {
            return Vec::new();
        };
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
            let settings = self.inner.config.resolve(Some(&root), "", 0);
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
                tracing::info!("ck-mc: upkeep for {id}: {report:?}");
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

    /// Run the dreamer once a minute, the first time after upkeep's quiet
    /// period. Each round learns the projects of the sessions set up in this
    /// process (with the memory profile a session of each resolved, or the
    /// bundled one) and starts the tasks that are due. The person's
    /// `dreamer.disable` stops new runs from the next round.
    pub fn spawn_dreamer(&self) {
        let (Some(db), Some(engine)) = (self.inner.db.clone(), self.inner.dreamer.clone()) else {
            return;
        };
        engine.start(&db, now_ms());
        let module = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(crate::upkeep::BOOT_QUIET).await;
            loop {
                if let Some(settings) = module.inner.config.dreamer() {
                    let now = now_ms();
                    for (project, root, session) in module.projects_with_a_session() {
                        let context = module
                            .inner
                            .store
                            .as_ref()
                            .and_then(|store| store.memory_context(&session));
                        match crate::memory_profile::prompt_profile(context.as_ref()) {
                            Ok(profile) => engine.see_project(&db, &project, &root, Arc::new(profile), &settings, now),
                            Err(refusal) => tracing::warn!("ck-mc: dreamer: {project}'s memory profile can't load: {refusal:?}"),
                        }
                    }
                    engine.tick(&db, &module.inner.client, &settings, now);
                }
                tokio::time::sleep(crate::dreamer::engine::TICK).await;
            }
        });
    }

    /// Each project with a session set up in this process, with its folder
    /// and one of its sessions (the first by key, so the choice is stable).
    fn projects_with_a_session(&self) -> Vec<(String, String, SessionRef)> {
        let sessions = self
            .inner
            .session_projects
            .lock()
            .expect("session projects");
        let mut projects: std::collections::BTreeMap<String, (String, SessionRef)> =
            std::collections::BTreeMap::new();
        for (session, project) in sessions.iter() {
            let entry = projects
                .entry(project.id.clone())
                .or_insert_with(|| (project.root.clone(), session.clone()));
            if (&session.runner, &session.harness, &session.session)
                < (&entry.1.runner, &entry.1.harness, &entry.1.session)
            {
                *entry = (project.root.clone(), session.clone());
            }
        }
        projects
            .into_iter()
            .map(|(id, (root, session))| (id, root, session))
            .collect()
    }

    /// Append new memories' sync records to Engram in the background.
    /// Without `context.db` nothing is ever queued.
    pub fn spawn_memory_sync(&self) {
        if self.inner.db.is_none() {
            return;
        }
        let module = self.clone();
        tokio::spawn(async move {
            let db = module.inner.db.as_ref().expect("checked above");
            crate::memory_sync::run(module.inner.client.as_ref(), db).await;
        });
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

    fn send(&self, session: &SessionRef, job: Job) -> Result<(), ModuleError> {
        let worker = self
            .inner
            .workers
            .lock()
            .expect("worker map")
            .get(session)
            .cloned()
            .ok_or(ModuleError::UnknownSession)?;
        worker.send(job).map_err(|_| ModuleError::Stopped)
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
        let key = request.key();
        let worker = self
            .inner
            .workers
            .lock()
            .expect("worker map")
            .get(&key)
            .cloned();
        let worker = worker.or_else(|| {
            if !matches!(&request, commands::Request::Run(_))
                || self
                    .inner
                    .store
                    .as_ref()
                    .and_then(|store| store.load(&key))
                    .is_none()
            {
                return None;
            }
            let mut workers = self.inner.workers.lock().expect("worker map");
            Some(
                workers
                    .entry(key.clone())
                    .or_insert_with(|| self.spawn_worker(key.clone()))
                    .clone(),
            )
        });
        let Some(worker) = worker else {
            return commands::execute(
                None,
                self.inner.client.as_ref(),
                &Settings::default(),
                request,
            )
            .await;
        };
        let (reply, answer) = oneshot::channel();
        worker
            .send(Job::Command { request, reply })
            .map_err(|_| commands::invalid("subject"))?;
        answer.await.map_err(|_| commands::invalid("subject"))?
    }

    fn spawn_worker(&self, key: SessionRef) -> mpsc::UnboundedSender<Job> {
        let (jobs, mut receiver) = mpsc::unbounded_channel::<Job>();
        let inner = Arc::clone(&self.inner);
        // Weak, so the worker's own handle never keeps it alive.
        let own = jobs.downgrade();
        tokio::spawn(async move {
            let held_key = key.clone();
            let _search_guard = inner
                .search
                .as_ref()
                .map(|search| search.session_guard(key));
            let mut session: Option<Session> = None;
            let mut saved: Option<crate::store::Durable> = None;
            let mut retry_save = false;
            // Jobs a move held, in the order they arrived, and the jobs to
            // run before the queue's next one once it no longer holds them.
            let mut held: VecDeque<Job> = VecDeque::new();
            let mut ready: VecDeque<Job> = VecDeque::new();
            loop {
                let job = match ready.pop_front() {
                    Some(job) => job,
                    None => match receiver.recv().await {
                        Some(job) => job,
                        None => break,
                    },
                };
                let job = match inner.journal.gate().check(&held_key) {
                    Err(gated) => match hold(job, &gated, &mut held, &held_key) {
                        Some(job) => job,
                        None => continue,
                    },
                    Ok(()) if !held.is_empty() => {
                        // The move let the session go: what it held runs
                        // first, in order, then this job and the rest.
                        tracing::info!(
                            "ck-mc: session {}/{}/{}: running {} jobs held during a move",
                            held_key.runner,
                            held_key.harness,
                            held_key.session,
                            held.len()
                        );
                        let rest = std::mem::take(&mut ready);
                        ready.extend(held.drain(..));
                        ready.push_back(job);
                        ready.extend(rest);
                        continue;
                    }
                    Ok(()) => job,
                };
                let settings: Settings = match (&job, &session) {
                    (
                        Job::Idle(_)
                        | Job::Busy(_)
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. },
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
                    (_, Some(session)) => {
                        let (root, model_key, usable) = session.config_inputs();
                        inner.config.resolve(root, &model_key, usable)
                    }
                    // The first tool call of a session that has no Setup: only
                    // the project's settings matter to its tools.
                    (Job::Tool { route, .. }, None) => route_settings(&inner.config, route, "", 0),
                    (_, None) => Settings::default(),
                };
                let settings = &settings;
                let publish_app = !matches!(
                    &job,
                    Job::Idle(_)
                        | Job::Busy(_)
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. }
                        | Job::PreUser { .. }
                        | Job::AppCheckpoint { .. }
                );
                let refresh_search = matches!(&job, Job::Setup(..) | Job::Notice(..));
                let app_checkpoint = matches!(&job, Job::Setup(..))
                    || (session.is_none() && matches!(&job, Job::Tool { .. }));
                if publish_app && session.is_none() {
                    // Hydrate before this worker can save a newer checkpoint;
                    // queued reads and deltas then share the same hydrated state.
                    inner.app_read.activate(&held_key).await;
                }
                match job {
                    Job::Resume => continue,
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
                            "ck-mc: session {}/{}/{} {what} by agent-data cut {cut}; discarding the {} Setup, notice and summary jobs held during the move",
                            held_key.runner,
                            held_key.harness,
                            held_key.session,
                            held.len()
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
                            ensure_memory_context(&inner, &route, existing).await;
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
                            ensure_memory_context(&inner, &route, &mut fresh).await;
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
                            if progressed {
                                if let Some(request) = session.pending_wrapup_summary(settings) {
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
                                    tracing::warn!("ck-mc: {error}");
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
                        reply,
                    } => {
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
                            }
                            session = Some(fresh);
                        }
                        let session = session.as_mut().expect("tool session");
                        let (root, model, usable) = session.config_inputs();
                        let settings = inner.config.resolve(root, &model, usable);
                        let config = inner.config.catalog_config(session.config_inputs().0);
                        let answer = if !session.serves_tool(&name, &config) {
                            Err(ModuleError::UnknownTool(name.clone()))
                        } else if name == "ctx_memory" && !settings.memory_enabled {
                            Err(ModuleError::Tool(
                                "Cross-session memory is disabled for this project.".into(),
                            ))
                        } else {
                            if name == "ctx_memory" {
                                ensure_memory_context(&inner, &route, session).await;
                            }
                            session
                                .tool(inner.client.as_ref(), &settings, &name, &input)
                                .await
                                .map_err(ModuleError::Tool)
                        };
                        let _ = reply.send(answer);
                    }
                    Job::PreUser { text, now, reply } => {
                        let answer = match &session {
                            Some(session) => session.pre_user(settings, &text, now).await,
                            None => Addition::default(),
                        };
                        let _ = reply.send(answer);
                    }
                    Job::Idle(reply) => {
                        if retry_save {
                            if let (Some(store), Some(session)) =
                                (&inner.store, session.as_ref().filter(|s| s.compacting()))
                            {
                                let durable = session.durable();
                                match store.save(session.key(), &durable) {
                                    Ok(()) => {
                                        saved = Some(durable);
                                        retry_save = false;
                                    }
                                    Err(error) => tracing::warn!("ck-mc: {error}"),
                                }
                            }
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
                                tracing::warn!("ck-mc: {error}");
                            }
                        }
                    }
                }
            }
        });
        jobs
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
        match self.send(session, Job::Busy(reply)) {
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
        match self.send(session, Job::Park { at, until }) {
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
        let _ = self.send(session, Job::Resume);
    }

    fn forget(&self, session: &SessionRef, cut: &str) {
        self.drop_session(session, cut, false);
    }

    fn reset(&self, session: &SessionRef, cut: &str) {
        self.drop_session(session, cut, true);
    }

    fn active(&self, session: &SessionRef) -> bool {
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
        Job::Setup(..) | Job::Notice(_) | Job::SummaryFinished(..) | Job::AccountWait(_) => {
            if held.is_empty() {
                tracing::info!(
                    "ck-mc: session {}/{}/{}: holding its Setup and notices while a move holds it ({}); they run if the move is aborted",
                    key.runner,
                    key.harness,
                    key.session,
                    gated.cut.as_deref().unwrap_or("journal unreadable")
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
            let _ = reply.send(Err(subc_protocol::ErrorBody::new(
                "unknown_subject",
                "Session is moving or unavailable.",
            )));
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
        Job::Idle(_)
        | Job::Busy(_)
        | Job::Resume
        | Job::Park { .. }
        | Job::Discard { .. }
        | Job::AppCheckpoint { .. } => Some(job),
    }
}

/// Whether a view the session offered the runner is still unconfirmed.
fn view_unconfirmed(session: Option<&Session>) -> bool {
    session
        .filter(|session| session.compacting())
        .is_some_and(|session| !session.durable().unconfirmed.is_empty())
}

/// Give `session` its memory context: the one stored for it,
/// or one read from Entorhinal now and stored for good. A session without a
/// folder has none, and its new memories stay unplaced.
async fn ensure_memory_context<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Inner<C>,
    route: &Route,
    session: &mut Session,
) {
    if session.has_memory_context() {
        return;
    }
    let Some(folder) = route.workdir.as_deref() else {
        return;
    };
    let stored = inner
        .store
        .as_ref()
        .and_then(|store| store.memory_context(&route.session));
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
        let result = run::run(inner.client.as_ref(), inner.db.as_deref(), &request).await;
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
            "ck-mc: session {}: turn two: {outcome:?}",
            job.owner.session
        );
        if let crate::summary::two_pass::turn_two::Outcome::AccountWait(wait) = outcome {
            if let Some(worker) = worker.upgrade() {
                let _ = worker.send(Job::AccountWait(wait));
            }
        }
        drop(counted);
        *inner.summaries_running.lock().expect("summary count") -= 1;
    });
}

fn route_settings(config: &Config, route: &Route, model_key: &str, usable: u64) -> Settings {
    config.resolve(
        route
            .project
            .as_ref()
            .map(|project| project.root.as_str())
            .or(route.workdir.as_deref()),
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
mod config_tests {
    use super::*;
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;

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
        let later = config.resolve(folder, &model, usable);
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
