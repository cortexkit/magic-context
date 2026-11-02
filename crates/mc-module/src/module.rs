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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ck_contract_draft::notice::{NoticeAnswer, NoticeRequest};
use ck_contract_draft::read::SessionRef;
use ck_contract_draft::ride::{RideAnswer, RideRequest};
use ck_contract_draft::setup::{SetupAnswer, SetupRequest};
use ck_contract_draft::view::View;
use ck_contract_draft::wire::PreUserAnswer;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::client::RunnerClient;
use crate::config::Config;
use crate::context_db::ContextDb;
use crate::pass::Settings;
use crate::preset;
use crate::route::Route;
use crate::session::Session;
use crate::store::Store;
use crate::summary::run;
use crate::summary::validate::ValidatedChunk;

/// How long a runner waits for `transform.pre_user` before storing the
/// message as it is.
pub const PRE_USER_BUDGET: Duration = Duration::from_millis(1_500);

/// A call ck-mc refuses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleError {
    /// The preset names nothing Magic Context knows.
    UnknownPreset(String),
    /// A call for a session that never had a Setup.
    UnknownSession,
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
    client: C,
    /// Where each session's settings come from. They are resolved again for
    /// every job, so a configuration edit applies from the session's next
    /// pass.
    config: Config,
    /// Where summaries are stored. Without it they live only in memory, which
    /// only tests want.
    db: Option<Arc<ContextDb>>,
    /// Where each session's own decisions survive a restart.
    store: Option<Store>,
    workers: Mutex<HashMap<SessionRef, mpsc::UnboundedSender<Job>>>,
    /// Summarizer runs in progress, so [`Module::idle`] can wait for them.
    summaries_running: Mutex<usize>,
}

enum Job {
    Setup(Route, SetupRequest, preset::Features),
    Notice(NoticeRequest),
    Ride(RideRequest, oneshot::Sender<Option<View>>),
    Tool {
        name: String,
        input: Value,
        reply: oneshot::Sender<Result<String, String>>,
    },
    PreUser {
        text: String,
        now: u64,
        reply: oneshot::Sender<PreUserAnswer>,
    },
    Idle(oneshot::Sender<()>),
    SummaryFinished(Result<Option<ValidatedChunk>, String>),
}

impl<C: RunnerClient + Send + Sync + 'static> Module<C> {
    pub fn new(
        client: C,
        config: impl Into<Config>,
        db: Option<ContextDb>,
        store: Option<Store>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                client,
                config: config.into(),
                db: db.map(Arc::new),
                store,
                workers: Mutex::new(HashMap::new()),
                summaries_running: Mutex::new(0),
            }),
        }
    }

    /// `compaction.setup` for the session `route` is bound to. Answers at
    /// once; the session reads its transcript afterwards, on its worker.
    pub fn setup(&self, route: Route, request: SetupRequest) -> Result<SetupAnswer, ModuleError> {
        let features = preset::features(&request.preset)
            .ok_or_else(|| ModuleError::UnknownPreset(request.preset.clone()))?;
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            workers
                .entry(route.session.clone())
                .or_insert_with(|| self.spawn_worker())
                .clone()
        };
        worker
            .send(Job::Setup(route, request, features))
            .map_err(|_| ModuleError::Stopped)?;
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
        match self.send(session, Job::Notice(request)) {
            Ok(()) => Ok(NoticeAnswer::Received),
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

    /// A `ctx_*` tool call from a session's model.
    pub async fn tool(
        &self,
        session: &SessionRef,
        name: &str,
        input: Value,
    ) -> Result<String, ModuleError> {
        let (reply, answer) = oneshot::channel();
        self.send(
            session,
            Job::Tool {
                name: name.to_owned(),
                input,
                reply,
            },
        )?;
        answer
            .await
            .map_err(|_| ModuleError::Stopped)?
            .map_err(ModuleError::Tool)
    }

    /// `transform.pre_user`: what to add to a person's message, within
    /// [`PRE_USER_BUDGET`]. A session ck-mc does not know, or an answer that
    /// misses the budget, adds nothing: the message is never held up.
    pub async fn pre_user(&self, session: &SessionRef, text: &str, now: u64) -> PreUserAnswer {
        let (reply, answer) = oneshot::channel();
        let job = Job::PreUser {
            text: text.to_owned(),
            now,
            reply,
        };
        if self.send(session, job).is_err() {
            return PreUserAnswer::default();
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

    fn spawn_worker(&self) -> mpsc::UnboundedSender<Job> {
        let (jobs, mut receiver) = mpsc::unbounded_channel::<Job>();
        let inner = Arc::clone(&self.inner);
        // Weak, so the worker's own handle never keeps it alive.
        let own = jobs.downgrade();
        tokio::spawn(async move {
            let mut session: Option<Session> = None;
            let mut saved: Option<crate::store::Durable> = None;
            while let Some(job) = receiver.recv().await {
                let settings: Settings = match (&job, &session) {
                    (Job::Idle(_), _) => Settings::default(),
                    (Job::Setup(route, request, _), _) => inner.config.resolve(
                        route.project.as_ref().map(|project| project.root.as_str()),
                        &format!("{}/{}", request.model.provider, request.model.model),
                        request
                            .context_window
                            .saturating_sub(request.output_reserve),
                    ),
                    (_, Some(session)) => {
                        let (root, model_key, usable) = session.config_inputs();
                        inner.config.resolve(root, &model_key, usable)
                    }
                    (_, None) => Settings::default(),
                };
                let settings = &settings;
                match job {
                    Job::Setup(route, request, features) => match &mut session {
                        Some(existing) => {
                            existing
                                .setup(&inner.client, settings, &route, &request, features)
                                .await
                        }
                        None => {
                            let mut fresh =
                                Session::new(&route, &request, features, inner.db.clone());
                            fresh.load_summaries();
                            if let Some(durable) = inner
                                .store
                                .as_ref()
                                .and_then(|store| store.load(&route.session))
                            {
                                fresh.restore(durable);
                            }
                            fresh
                                .setup(&inner.client, settings, &route, &request, features)
                                .await;
                            session = Some(fresh);
                        }
                    },
                    Job::Notice(notice) => {
                        if let Some(session) = &mut session {
                            if let Some(request) =
                                session.notice(&inner.client, settings, notice).await
                            {
                                start_summary(&inner, own.clone(), request);
                            }
                        }
                    }
                    Job::SummaryFinished(result) => {
                        if let Some(session) = &mut session {
                            session
                                .summary_finished(&inner.client, settings, result, now_ms())
                                .await;
                        }
                    }
                    Job::Ride(ride, reply) => {
                        let view = session
                            .as_mut()
                            .and_then(|session| session.ride(settings, &ride));
                        let _ = reply.send(view);
                    }
                    Job::Tool { name, input, reply } => {
                        let answer = match &mut session {
                            Some(session) => {
                                session.tool(&inner.client, settings, &name, &input).await
                            }
                            None => Err("the session has not started".into()),
                        };
                        let _ = reply.send(answer);
                    }
                    Job::PreUser { text, now, reply } => {
                        let answer = match &session {
                            Some(session) => session.pre_user(settings, &text, now).await,
                            None => PreUserAnswer::default(),
                        };
                        let _ = reply.send(answer);
                        continue;
                    }
                    Job::Idle(reply) => {
                        let _ = reply.send(());
                        continue;
                    }
                }
                if let (Some(store), Some(session)) = (&inner.store, &session) {
                    let durable = session.durable();
                    if saved.as_ref() != Some(&durable) {
                        store.save(session.key(), &durable);
                        saved = Some(durable);
                    }
                }
            }
        });
        jobs
    }
}

/// Run the summarizer beside the session's worker, and hand its result back
/// as a job.
fn start_summary<C: RunnerClient + Send + Sync + 'static>(
    inner: &Arc<Inner<C>>,
    worker: mpsc::WeakUnboundedSender<Job>,
    request: run::Request,
) {
    *inner.summaries_running.lock().expect("summary count") += 1;
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let result = run::run(&inner.client, &request).await;
        if let Some(worker) = worker.upgrade() {
            let _ = worker.send(Job::SummaryFinished(result));
        }
        *inner.summaries_running.lock().expect("summary count") -= 1;
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
