//! The module: routes each call to its session's worker. Every session has
//! one worker task that handles its jobs strictly in order (Setup, notices,
//! rides, tool calls), so a session's state is never touched by two jobs at
//! once, and one session waiting on its runner never holds up another.
//!
//! Notices are acknowledged before their work runs, so a runner never waits
//! on ck-mc to send its next request. Rides and tool calls wait for their
//! answer, within the deadline the runner gave.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ck_contract_draft::notice::{NoticeAnswer, NoticeRequest};
use ck_contract_draft::read::SessionRef;
use ck_contract_draft::ride::{RideAnswer, RideRequest};
use ck_contract_draft::setup::{SetupAnswer, SetupRequest};
use ck_contract_draft::view::{View, ViewDelivery, ViewGetRequest};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::client::RunnerClient;
use crate::pass::Settings;
use crate::preset;
use crate::session::Session;

/// A call ck-mc refuses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleError {
    /// The preset names nothing Magic Context knows.
    UnknownPreset(String),
    /// A call for a session that never had a Setup.
    UnknownSession,
    /// The view asked for is not ck-mc's current one.
    UnknownView,
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
    settings: Settings,
    workers: Mutex<HashMap<SessionRef, mpsc::UnboundedSender<Job>>>,
}

enum Job {
    Setup(SetupRequest, preset::Features),
    Notice(NoticeRequest),
    Ride(RideRequest, oneshot::Sender<Option<View>>),
    Tool {
        name: String,
        input: Value,
        reply: oneshot::Sender<Result<String, String>>,
    },
    ViewGet(u64, oneshot::Sender<Option<View>>),
    Idle(oneshot::Sender<()>),
}

impl<C: RunnerClient> Module<C> {
    pub fn new(client: C, settings: Settings) -> Self {
        Self {
            inner: Arc::new(Inner {
                client,
                settings,
                workers: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// `compaction.setup`. Answers at once; the session reads its transcript
    /// afterwards, on its worker.
    pub fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, ModuleError> {
        let features = preset::features(&request.preset)
            .ok_or_else(|| ModuleError::UnknownPreset(request.preset.clone()))?;
        let worker = {
            let mut workers = self.inner.workers.lock().expect("worker map");
            workers
                .entry(request.session.clone())
                .or_insert_with(|| self.spawn_worker())
                .clone()
        };
        worker
            .send(Job::Setup(request, features))
            .map_err(|_| ModuleError::Stopped)?;
        Ok(SetupAnswer::Ready)
    }

    /// `compaction.notice`. Answers at once; the work runs afterwards.
    pub fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, ModuleError> {
        self.send(&request.session.clone(), Job::Notice(request))?;
        Ok(NoticeAnswer::Received)
    }

    /// `compaction.ride`: a view for the coming request, or nothing, within
    /// the runner's deadline. A ride that misses its deadline answers
    /// nothing; the runner then sends with the view it has.
    pub async fn ride(&self, request: RideRequest) -> Result<RideAnswer, ModuleError> {
        let deadline = Duration::from_millis(request.deadline_ms);
        let (reply, answer) = oneshot::channel();
        self.send(&request.session.clone(), Job::Ride(request, reply))?;
        match tokio::time::timeout(deadline, answer).await {
            Ok(Ok(Some(view))) => Ok(RideAnswer::View {
                delivery: ViewDelivery::Inline { view },
            }),
            Ok(Ok(None)) | Err(_) => Ok(RideAnswer::Nothing),
            Ok(Err(_)) => Err(ModuleError::Stopped),
        }
    }

    /// `view.get`.
    pub async fn view_get(&self, request: ViewGetRequest) -> Result<View, ModuleError> {
        let (reply, answer) = oneshot::channel();
        self.send(&request.session, Job::ViewGet(request.version, reply))?;
        answer
            .await
            .map_err(|_| ModuleError::Stopped)?
            .ok_or(ModuleError::UnknownView)
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

    /// Wait until the session's worker has handled every job sent before.
    /// Tests use it to make a run deterministic, the way a real runner's
    /// model time gives ck-mc time to finish.
    pub async fn idle(&self, session: &SessionRef) -> Result<(), ModuleError> {
        let (reply, answer) = oneshot::channel();
        self.send(session, Job::Idle(reply))?;
        answer.await.map_err(|_| ModuleError::Stopped)
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
        tokio::spawn(async move {
            let mut session: Option<Session> = None;
            while let Some(job) = receiver.recv().await {
                match job {
                    Job::Setup(request, features) => match &mut session {
                        Some(existing) => existing.setup(&inner.client, &request, features).await,
                        None => {
                            let mut fresh = Session::new(&request, features);
                            fresh.setup(&inner.client, &request, features).await;
                            session = Some(fresh);
                        }
                    },
                    Job::Notice(notice) => {
                        if let Some(session) = &mut session {
                            session.notice(&inner.client, &inner.settings, notice).await;
                        }
                    }
                    Job::Ride(ride, reply) => {
                        let view = session.as_mut().and_then(|session| session.ride(&ride));
                        let _ = reply.send(view);
                    }
                    Job::Tool { name, input, reply } => {
                        let answer = match &mut session {
                            Some(session) => session.tool(&name, &input),
                            None => Err("the session has not started".into()),
                        };
                        let _ = reply.send(answer);
                    }
                    Job::ViewGet(version, reply) => {
                        let _ =
                            reply.send(session.as_ref().and_then(|session| session.view(version)));
                    }
                    Job::Idle(reply) => {
                        let _ = reply.send(());
                    }
                }
            }
        });
        jobs
    }
}
