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
    /// Entorhinal's answer, read again after a Setup, for the project and
    /// workspace the session's folder is in now
    /// ([`Session::follow_workspace`]).
    Workspace {
        project: Option<String>,
        workspace: Option<String>,
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
    /// The state last saved to `mode3.db`, so the next worker saves only a
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
            // A project's dreamer run embeds text with the provider the
            // person's settings configure for its folder, read when the run
            // starts.
            let settings = config.clone();
            Arc::new(
                crate::dreamer::engine::Engine::new(
                    format!("ck-mc:{}", std::process::id()),
                    crate::dreamer::tasks(),
                )
                .with_embedding(Arc::new(move |root: &str| {
                    settings.resolve(Some(root), "", 0).embedding
                })),
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
                legacy_wake: Arc::default(),
                docs_notices: std::sync::OnceLock::new(),
                attribution_events: std::sync::OnceLock::new(),
                session_folders: Mutex::new(HashMap::new()),
                entorhinal_watch: Arc::default(),
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
        // Everything the app reads show was built from the rows and views the
        // move took away or replaced. Until the session's next Setup, a read
        // of it is answered as for a session this process never saw.
        self.inner.app_read.forget_session(session, replaced);
        let slot = self
            .inner
            .workers
            .lock()
            .expect("worker map")
            .remove(session);
        // A quiet session has no worker: what it kept goes with its slot.
        if let Some(Slot::Running(worker)) = slot {
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
            .session_folders
            .lock()
            .expect("session folders")
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
        // The epoch is recorded and the Setup queued under one lock, the one
        // a notice or ride is checked and queued under. So no statement
        // checked against the epoch this Setup replaces is queued behind it,
        // and of two Setups racing, the one queued last is the one recorded.
        // The queue is unbounded, so sending never waits.
        let mut set_up = self.inner.set_up.lock().expect("setup sessions");
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
        {
            let key = &route.session;
            let mut workers = self.inner.workers.lock().expect("worker map");
            let slot = workers
                .entry(key.clone())
                .or_insert_with(|| self.spawn_worker(key.clone()));
            self.running(slot, key)
                .send(Job::Tool {
                    route: route.clone(),
                    name: name.to_owned(),
                    input,
                    reply,
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

    /// Follow Entorhinal's change markers on `bus`
    /// ([`crate::entorhinal_changes`]): each change reads every live
    /// session's workspace again and wakes a legacy project round.
    pub fn spawn_entorhinal_follow(&self, bus: Arc<crate::bus::Bus>) {
        let module = self.clone();
        let state = Arc::clone(&self.inner.entorhinal_watch);
        tokio::spawn(async move {
            crate::entorhinal_changes::run(bus, state, move || module.registry_changed()).await;
        });
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
                // A quiet session gets the answer too: it starts its worker
                // again, which takes the answer without reading the session.
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
                    engine.retain_projects(&settings);
                    for (project, root, session) in module.projects_with_a_session() {
                        if !settings.runs_for(&project) {
                            continue;
                        }
                        let context = module
                            .inner
                            .store
                            .as_ref()
                            .and_then(|store| store.memory_context(&session));
                        match crate::memory_profile::prompt_profile(context.as_ref()) {
                            Ok(profile) => engine.see_project(&db, &project, &root, Arc::new(profile), &settings, now),
                            Err(refusal) => tracing::warn!("ck-mc: dreamer: {project}'s memory profile can't load: {refusal:?}"),
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
    /// and its answer is kept in `mode3.db`, not in a session.
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
            let watch_run_end = || inner.client.run_ends().map(|ends| ends.watch(&held_key));
            let mut run_end = if subagent { watch_run_end() } else { None };
            let mut run_ended = false;
            loop {
                let job = match ready.pop_front() {
                    Some(job) => job,
                    None => {
                        // The quiet time counts from when the worker ran out
                        // of jobs, or from the run-end event if that came later.
                        let quiet_after = if run_ended {
                            QUIET_AFTER_RUN_END
                        } else {
                            QUIET_AFTER
                        };
                        let quiet_at = tokio::time::Instant::now() + quiet_after;
                        let ended = async {
                            match &run_end {
                                Some(watch) => watch.ended().await,
                                None => std::future::pending().await,
                            }
                        };
                        // Biased, so a job that is waiting always runs before
                        // the session is freed.
                        let waited = tokio::select! {
                            biased;
                            job = receiver.recv() => Ok(job),
                            () = tokio::time::sleep_until(quiet_at) => Err(NoJob::Quiet),
                            () = ended => Err(NoJob::RunEnded),
                        };
                        match waited {
                            Ok(Some(job)) => job,
                            Ok(None) => break,
                            Err(NoJob::RunEnded) => {
                                run_ended = true;
                                continue;
                            }
                            Err(NoJob::Quiet) => {
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
                        | Job::Resume
                        | Job::Park { .. }
                        | Job::Discard { .. }
                        | Job::AppCheckpoint { .. }
                        | Job::Workspace { .. }
                        | Job::PreUser { .. }
                );
                if let Some(quiet) = carry.take_if(|_| needs_session) {
                    session = Some(resume(&inner, &held_key, quiet).await);
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
                    // A quiet session answering `pre_user` as it was freed.
                    (_, None) => match &carry {
                        Some(carry) => {
                            let (root, model_key, usable) = carry.config_inputs();
                            inner.config.resolve(root, &model_key, usable)
                        }
                        None => Settings::default(),
                    },
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
                // A quiet session's workspace answer changes nothing the apps
                // show, so its projection is neither hydrated nor published.
                if publish_app && session.is_none() && carry.is_none() {
                    // Hydrate before this worker can save a newer checkpoint;
                    // queued reads and deltas then share the same hydrated state.
                    inner.app_read.activate(&held_key).await;
                }
                if let Job::Setup(_, _, features) = &job {
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
                            if progressed {
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
        | Job::SummaryFinished(..)
        | Job::AccountWait(_)
        | Job::Workspace { .. } => {
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

/// Why a worker stopped waiting for its next job without one.
enum NoJob {
    /// The session's quiet time passed.
    Quiet,
    /// The runner said the session's run ended.
    RunEnded,
}

/// What a worker that frees its session keeps besides the session, and
/// how long the session had no job, for the log.
struct Freed<'a> {
    saved: &'a Option<crate::store::Durable>,
    subagent: bool,
    quiet_for: Duration,
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
            "ck-mc: session {}: freed after {} s without a job; its next job reads it again",
            key.session,
            freed.quiet_for.as_secs()
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
        saved: freed.saved.clone(),
        subagent: freed.subagent,
    });
    if let Err(quiet) = give_up_place(inner, key, own, receiver, search_guard, ready, Some(quiet)) {
        *carry = quiet.map(|quiet| quiet.carry);
        return false;
    }
    tracing::info!(
        "ck-mc: session {}: freed after {} s without a job; its next job reads it again",
        key.session,
        freed.quiet_for.as_secs()
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
        "ck-mc: session {}: resumed after a quiet free in {} ms",
        key.session,
        started.elapsed().as_millis()
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

#[cfg(test)]
#[path = "quiet_session_tests.rs"]
mod quiet_session_tests;
