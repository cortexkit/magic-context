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

use std::collections::{HashMap, HashSet};
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
    client: Arc<C>,
    search: Option<crate::search::background::Background>,
    /// Where each session's settings come from. They are resolved again for
    /// every job, so a configuration edit applies from the session's next
    /// pass.
    config: Config,
    /// Where summaries are stored. Without it they live only in memory, which
    /// only tests want.
    db: Option<Arc<ContextDb>>,
    /// Where each session's own decisions survive a restart.
    store: Option<Arc<Store>>,
    workers: Mutex<HashMap<SessionRef, mpsc::UnboundedSender<Job>>>,
    set_up: Mutex<HashSet<SessionRef>>,
    /// Summarizer runs in progress, so [`Module::idle`] can wait for them.
    summaries_running: Mutex<usize>,
    /// Each session's project, from its Setup route's scope.
    session_projects: Mutex<HashMap<SessionRef, crate::route::Project>>,
    /// Projects with recent activity: folder and the last Setup or notice
    /// time, keyed by project id. Upkeep runs for these.
    active_projects: Mutex<HashMap<String, (String, i64)>>,
}

enum Job {
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
    /// Boxed: a summary result is much larger than any other job.
    SummaryFinished(Box<Result<Option<run::Summarized>, String>>),
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

    pub fn new(
        client: C,
        config: impl Into<Config>,
        db: Option<ContextDb>,
        store: Option<Store>,
    ) -> Self {
        let app_read = crate::app_read::AppRead::new(
            store.as_ref().map(|s| s.path.clone()),
            db.as_ref().map(|d| d.path.clone()),
        );
        let client = Arc::new(client);
        let search = db
            .as_ref()
            .map(|db| crate::search::background::Background::new(client.clone(), db.path.clone()));
        Self {
            inner: Arc::new(Inner {
                app_read,
                client,
                search,
                config: config.into(),
                db: db.map(Arc::new),
                store: store.map(Arc::new),
                workers: Mutex::new(HashMap::new()),
                set_up: Mutex::new(HashSet::new()),
                summaries_running: Mutex::new(0),
                session_projects: Mutex::new(HashMap::new()),
                active_projects: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// App requests read an independent projection, never a session job.
    pub fn app_read(&self) -> &crate::app_read::AppRead {
        &self.inner.app_read
    }

    /// Wait for eventual message search indexing, outside the session worker.
    pub async fn search_idle(&self, session: &SessionRef) -> Result<(), String> {
        match &self.inner.search {
            Some(search) => search.idle(session).await,
            None => Ok(()),
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
        let features = preset::features(&request.preset)
            .ok_or_else(|| ModuleError::UnknownPreset(request.preset.clone()))?;
        if let Some(project) = &route.project {
            self.inner
                .session_projects
                .lock()
                .expect("session projects")
                .insert(route.session.clone(), project.clone());
            self.touch(&route.session);
        }
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            workers
                .entry(route.session.clone())
                .or_insert_with(|| self.spawn_worker(route.session.clone()))
                .clone()
        };
        let key = route.session.clone();
        worker
            .send(Job::Setup(route, request, features))
            .map_err(|_| ModuleError::Stopped)?;
        self.inner
            .set_up
            .lock()
            .expect("setup sessions")
            .insert(key);
        Ok(SetupAnswer::Ready)
    }

    /// `compaction.notice`. Answers at once; the work runs afterwards. A
    /// session ck-mc does not know (it restarted since the runner's Setup)
    /// asks the runner to call Setup again.
    pub fn notice(
        &self,
        session: &SessionRef,
        request: NoticeRequest,
    ) -> Result<NoticeAnswer, ModuleError> {
        if !self
            .inner
            .set_up
            .lock()
            .expect("setup sessions")
            .contains(session)
        {
            return Ok(NoticeAnswer::SetupRequired);
        }
        match self.send(session, Job::Notice(request)) {
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
        let deadline = Duration::from_millis(request.deadline_ms);
        let (reply, answer) = oneshot::channel();
        self.send(session, Job::Ride(request, reply))?;
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
    /// misses the budget, adds nothing: the message is never held up.
    pub async fn pre_user(&self, session: &SessionRef, text: &str, now: u64) -> Addition {
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
            let owned = || {
                self.inner
                    .session_projects
                    .lock()
                    .expect("session projects")
                    .iter()
                    .filter(|(_, project)| project.id == id)
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

    fn spawn_worker(&self, key: SessionRef) -> mpsc::UnboundedSender<Job> {
        let (jobs, mut receiver) = mpsc::unbounded_channel::<Job>();
        let inner = Arc::clone(&self.inner);
        // Weak, so the worker's own handle never keeps it alive.
        let own = jobs.downgrade();
        tokio::spawn(async move {
            let _search_guard = inner
                .search
                .as_ref()
                .map(|search| search.session_guard(key));
            let mut session: Option<Session> = None;
            let mut saved: Option<crate::store::Durable> = None;
            while let Some(job) = receiver.recv().await {
                let settings: Settings = match (&job, &session) {
                    (Job::Idle(_), _) => Settings::default(),
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
                let publish_app = !matches!(&job, Job::Idle(_) | Job::PreUser { .. });
                let refresh_search = matches!(&job, Job::Setup(..) | Job::Notice(..));
                let app_checkpoint = matches!(&job, Job::Setup(..))
                    || (session.is_none() && matches!(&job, Job::Tool { .. }));
                match job {
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
                                start_summary(&inner, own.clone(), request);
                            }
                        }
                    }
                    Job::SummaryFinished(result) => {
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
                                start_turn_two(&inner, job);
                            }
                        }
                    }
                    Job::Ride(ride, reply) => {
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
                        let _ = reply.send(());
                        // A barrier changes no session state. The preceding
                        // job already persisted its changes before this one
                        // was received, so avoid cloning/saving them again.
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
                // A tools-only session has nothing to keep across a restart.
                if let (Some(store), Some(session)) = (
                    &inner.store,
                    session.as_ref().filter(|session| session.compacting()),
                ) {
                    let durable = session.durable();
                    if saved.as_ref() != Some(&durable) {
                        match store.save(session.key(), &durable) {
                            Ok(()) => saved = Some(durable),
                            Err(error) => tracing::warn!("ck-mc: {error}"),
                        }
                    }
                }
            }
        });
        jobs
    }
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
/// as a job.
fn start_summary<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    worker: mpsc::WeakUnboundedSender<Job>,
    request: run::Request,
) {
    *inner.summaries_running.lock().expect("summary count") += 1;
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let result = run::run(inner.client.as_ref(), inner.db.as_deref(), &request).await;
        if let Some(worker) = worker.upgrade() {
            let _ = worker.send(Job::SummaryFinished(Box::new(result)));
        }
        *inner.summaries_running.lock().expect("summary count") -= 1;
    });
}

/// Run the two-pass historian's second turn beside the session's worker.
/// It writes only memories and candidate rows, never the session's state,
/// so nothing comes back to the worker; [`Module::idle`] waits for it as for
/// a summary.
fn start_turn_two<C: RunnerClient + Router + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    job: crate::summary::two_pass::turn_two::Job,
) {
    let Some(db) = inner.db.clone() else {
        return;
    };
    *inner.summaries_running.lock().expect("summary count") += 1;
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let outcome =
            crate::summary::two_pass::turn_two::run(inner.client.as_ref(), &db, &job).await;
        tracing::info!(
            "ck-mc: session {}: turn two: {outcome:?}",
            job.owner.session
        );
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
