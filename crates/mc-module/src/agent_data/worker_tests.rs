//! A worker whose session a move holds: what it holds, what it answers,
//! and what runs once the move lets the session go.

use super::*;
use crate::agent_data::journal::{Contents, Cut, Moving, MovingState, Released};
use crate::agent_data::{Journal, SESSION_MOVED, SESSION_MOVING};
use crate::client::{Child, ClientError};
use cortexkit_role_agent_data::step::Step;
use cortexkit_role_compaction::{
    notice::Conditions,
    part::{Part, PartBody},
    read::{Cursor, Entry, Head, ReadPage, ReadRequest, Role},
    ride::RideCause,
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};
use serde_json::json;

struct Client;

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(vec![], Head::new()))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::default())
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!()
    }
}

impl Router for Client {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!()
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {
        unreachable!()
    }
}

struct Fixture {
    module: Module<Client>,
    journal: Arc<Journal>,
    key: SessionRef,
    route: Route,
    conditions: Conditions,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let journal = Arc::new(Journal::in_memory());
        let module = Module::with_journal(
            Client,
            Settings::default(),
            None,
            Some(store),
            journal.clone(),
            false,
        );
        let key = SessionRef::new("runner", "mock", "head");
        let route = Route {
            session: key.clone(),
            project: None,
            workdir: None,
            agent_id: None,
        };
        Self {
            module,
            journal,
            key,
            route,
            conditions: Conditions::new(model(), 100_000, 1000, rules()),
            _dir: dir,
        }
    }

    fn setup(&self) -> Result<SetupAnswer, ModuleError> {
        self.module.setup(
            self.route.clone(),
            SetupRequest::new("head", model(), 100_000, 1000, rules(), vec![], 1),
        )
    }

    fn notice(&self, ordinal: u64) -> NoticeRequest {
        let mid = format!("m{ordinal}");
        let entry = Entry::new(
            ordinal,
            &mid,
            Role::Assistant,
            ordinal,
            vec![Part::new("p", PartBody::Text { text: mid.clone() })],
        );
        let mut notice = NoticeRequest::new(ordinal, self.conditions.clone())
            .with_newest(Cursor::new(ordinal, mid, entry.digest.clone()));
        notice.entries = vec![entry];
        notice
    }

    fn ride(&self) -> RideRequest {
        RideRequest::new(vec![RideCause::OverLimit], 1_000, self.conditions.clone())
    }

    fn hold(&self, state: MovingState) {
        let key = self.key.clone();
        self.journal
            .change(|contents| {
                contents.cuts.insert(
                    "cut-1".into(),
                    Cut {
                        step: Step::Prepared,
                        refs: None,
                        receipts: Default::default(),
                        snapshots: Default::default(),
                        undo_images: Default::default(),
                        activate_request: None,
                    },
                );
                contents
                    .session_mut(&key.runner, &key.harness, &key.session)
                    .moving = Some(Moving {
                    cut: "cut-1".into(),
                    state,
                });
            })
            .unwrap();
    }

    fn let_go(&self) {
        let key = self.key.clone();
        self.journal
            .change(|contents: &mut Contents| {
                contents
                    .session_mut(&key.runner, &key.harness, &key.session)
                    .moving = None;
            })
            .unwrap();
    }

    fn saved(&self) -> bool {
        self.module
            .inner
            .store
            .as_ref()
            .unwrap()
            .load(&self.key)
            .is_some()
    }

    /// Each message's state in the app projection, read past the gate.
    async fn states(&self) -> Result<Vec<String>, String> {
        self.module
            .inner
            .app_read
            .read(
                "context.states",
                json!({"session": self.key, "message_ids": ["m1", "m2"]}),
            )
            .await
            .map(|reply| {
                reply["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["state"].as_str().unwrap().to_owned())
                    .collect()
            })
            .map_err(|refusal| refusal.code)
    }
}

fn model() -> ModelRef {
    ModelRef::new("test", "model")
}

fn rules() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn moving(result: Result<impl std::fmt::Debug, ModuleError>) -> String {
    match result {
        Err(ModuleError::Gated(gated)) => {
            assert_eq!(gated.detail, Some(json!({"cut": "cut-1"})));
            gated.code.to_owned()
        }
        other => panic!("expected a gate refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_frozen_worker_holds_setup_and_notices_in_order_and_runs_them_when_let_go() {
    let f = Fixture::new();
    // Answered when queued, before the freeze. The worker has not run yet:
    // a test's runtime runs it only when the test awaits.
    assert_eq!(f.setup(), Ok(SetupAnswer::Ready));
    assert_eq!(
        f.module.notice(&f.key, f.notice(1)),
        Ok(NoticeAnswer::Received)
    );
    assert_eq!(
        f.module.notice(&f.key, f.notice(2)),
        Ok(NoticeAnswer::Received)
    );
    // A ride, a tool call and pre_user queued before the freeze too.
    let (ride, ride_answer) = oneshot::channel();
    f.module.send(&f.key, Job::Ride(f.ride(), ride)).unwrap();
    let (tool, tool_answer) = oneshot::channel();
    f.module
        .send(
            &f.key,
            Job::Tool {
                route: f.route.clone(),
                name: "ctx_note".into(),
                input: json!({"action": "read"}),
                reply: tool,
            },
        )
        .unwrap();
    let (pre_user, pre_user_answer) = oneshot::channel();
    f.module
        .send(
            &f.key,
            Job::PreUser {
                text: "hello".into(),
                now: 1,
                reply: pre_user,
            },
        )
        .unwrap();
    f.hold(MovingState::Frozen);

    // Idle runs while the session is held, so the barrier answers.
    f.module.idle(&f.key).await.unwrap();
    assert!(ride_answer.await.unwrap().is_none());
    assert_eq!(moving(tool_answer.await.unwrap()), SESSION_MOVING);
    assert_eq!(pre_user_answer.await.unwrap(), Addition::default());
    // The Setup and notices are held: no session was built, saved or
    // published.
    assert!(!f.saved());
    assert_eq!(f.states().await, Err("session_not_found".into()));
    // An app checkpoint runs as usual.
    let (flush, flushed) = oneshot::channel();
    f.module
        .send(&f.key, Job::AppCheckpoint { flush: Some(flush) })
        .unwrap();
    flushed.await.unwrap();
    // A wake while the move still holds the session runs nothing held.
    f.module.resume(&f.key);
    f.module.idle(&f.key).await.unwrap();
    assert!(!f.saved());

    f.let_go();
    f.module.resume(&f.key);
    f.module.idle(&f.key).await.unwrap();
    // The Setup ran first: a notice run before it would have found no
    // session and been dropped, leaving its message unknown.
    assert!(f.saved());
    assert_eq!(f.states().await, Ok(vec!["raw".into(), "raw".into()]));
}

#[tokio::test]
async fn every_surface_refuses_a_held_session_at_admission_and_serves_others() {
    let f = Fixture::new();
    assert_eq!(f.setup(), Ok(SetupAnswer::Ready));
    f.module.idle(&f.key).await.unwrap();
    for state in [
        MovingState::Frozen,
        MovingState::Staged,
        MovingState::Activating,
    ] {
        f.hold(state);
        assert_eq!(moving(f.setup()), SESSION_MOVING);
        assert_eq!(moving(f.module.notice(&f.key, f.notice(1))), SESSION_MOVING);
        assert_eq!(
            moving(f.module.ride(&f.key, f.ride()).await),
            SESSION_MOVING
        );
        assert_eq!(
            moving(f.module.tool(&f.route, "ctx_note", json!({})).await),
            SESSION_MOVING
        );
        assert_eq!(
            f.module.pre_user(&f.key, "remember this", 1).await,
            Addition::default()
        );
        let refused = f
            .module
            .app_request(
                "context.states",
                json!({"session": f.key, "message_ids": ["m1"]}),
            )
            .await
            .unwrap_err();
        assert_eq!(refused.code, SESSION_MOVING);
        assert_eq!(refused.detail, Some(json!({"cut": "cut-1"})));
        let refused = f
            .module
            .app_request(
                "context.search",
                json!({"query": "x", "scope": {"session": f.key}}),
            )
            .await
            .unwrap_err();
        assert_eq!(refused.code, SESSION_MOVING);
        let refused = match f
            .module
            .app_watch("caller".into(), json!({"sessions": [f.key]}))
            .await
        {
            Err(refused) => refused,
            Ok(_) => panic!("a watch naming a held session was admitted"),
        };
        assert_eq!(refused.code, SESSION_MOVING);
    }

    // Another session is served as before.
    let other = Route {
        session: SessionRef::new("runner", "mock", "other"),
        ..f.route.clone()
    };
    assert_eq!(
        f.module.setup(
            other.clone(),
            SetupRequest::new("head", model(), 100_000, 1000, rules(), vec![], 1),
        ),
        Ok(SetupAnswer::Ready)
    );
    f.module.idle(&other.session).await.unwrap();
    assert_eq!(
        f.module.notice(&other.session, f.notice(1)),
        Ok(NoticeAnswer::Received)
    );
    assert!(f.module.ride(&other.session, f.ride()).await.is_ok());

    // Released: the holder is named instead of the cut.
    let key = f.key.clone();
    f.journal
        .change(|contents| {
            let entry = contents.session_mut(&key.runner, &key.harness, &key.session);
            entry.moving = None;
            entry.released = Some(Released {
                cut: "cut-1".into(),
                holder: "mac-b".into(),
            });
        })
        .unwrap();
    match f.setup() {
        Err(ModuleError::Gated(gated)) => {
            assert_eq!(gated.code, SESSION_MOVED);
            assert_eq!(gated.detail, Some(json!({"holder": "mac-b"})));
        }
        other => panic!("expected session_moved, got {other:?}"),
    }
    let refused = f
        .module
        .app_request(
            "session_data.read",
            json!({"session": f.key, "section": "meta"}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, SESSION_MOVED);
    assert_eq!(refused.detail, Some(json!({"holder": "mac-b"})));
}

/// Run `body` with the log captured, and return what it logged.
fn logged(body: impl FnOnce()) -> String {
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, body);
    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    text
}

/// `busy`'s `historian_running` counts a run for its session until the
/// worker has handled the run's result. A result the worker holds because
/// a move holds the session keeps counting, so a move never starts while a
/// result is still to be written.
#[tokio::test]
async fn a_summarizer_run_counts_for_its_session_until_its_result_is_handled() {
    use crate::agent_data::Host;
    let f = Fixture::new();
    assert_eq!(f.setup(), Ok(SetupAnswer::Ready));
    f.module.idle(&f.key).await.unwrap();
    assert!(!f.module.historian_running(&f.key));
    f.hold(MovingState::Frozen);
    let counted = f.module.inner.runs.start(&f.key);
    f.module
        .send(
            &f.key,
            Job::SummaryFinished(Box::new(Err("the summarizer stopped".into())), counted),
        )
        .unwrap();
    f.module.idle(&f.key).await.unwrap();
    assert!(
        f.module.historian_running(&f.key),
        "a held result still counts"
    );
    assert!(!f
        .module
        .historian_running(&SessionRef::new("runner", "mock", "other")));
    f.let_go();
    f.module.resume(&f.key);
    f.module.idle(&f.key).await.unwrap();
    assert!(
        !f.module.historian_running(&f.key),
        "handled, it stops counting"
    );
    // A result that never reaches a worker stops counting as well.
    drop(f.module.inner.runs.start(&f.key));
    assert!(!f.module.historian_running(&f.key));
}

/// `busy` asks the session's worker whether a view it offered the runner is
/// still unconfirmed; the worker answers even while a move holds the
/// session, and a session with no worker here has nothing running.
#[tokio::test]
async fn the_sessions_worker_answers_busy_even_while_a_move_holds_it() {
    use crate::agent_data::{Host, Probe};
    use cortexkit_role_compaction::view::AppliedView;
    let f = Fixture::new();
    let budget = std::time::Duration::from_secs(5);
    assert_eq!(f.module.probe(&f.key, budget).await, Probe::NoWorker);
    // Setup offers the runner a view, which the runner took and has not
    // confirmed applying yet.
    assert_eq!(f.setup(), Ok(SetupAnswer::Ready));
    f.module.idle(&f.key).await.unwrap();
    let pending = f
        .module
        .inner
        .store
        .as_ref()
        .unwrap()
        .load(&f.key)
        .unwrap()
        .unconfirmed;
    let offered = pending.last().expect("Setup offered a view").view.clone();
    assert_eq!(
        f.module.probe(&f.key, budget).await,
        Probe::Answered {
            view_unconfirmed: true
        }
    );
    // The runner's next notice reports it applies that view.
    let mut notice = f.notice(1);
    notice.applied_view = Some(AppliedView::new(offered.version, offered.checksum.clone()));
    assert_eq!(f.module.notice(&f.key, notice), Ok(NoticeAnswer::Received));
    f.module.idle(&f.key).await.unwrap();
    assert_eq!(
        f.module.probe(&f.key, budget).await,
        Probe::Answered {
            view_unconfirmed: false
        }
    );
    f.hold(MovingState::Frozen);
    assert_eq!(
        f.module.probe(&f.key, budget).await,
        Probe::Answered {
            view_unconfirmed: false
        }
    );
}

/// Frozen, staged and released sessions written by a build with moves on
/// are still refused after a restart into a build with them off, and the
/// startup log names each one with its cut and what has to happen next.
#[tokio::test]
async fn moves_recorded_with_moves_on_stay_enforced_after_a_restart_with_them_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = crate::agent_data::journal::path(&dir.path().join("context.db"));
    let frozen = SessionRef::new("runner", "mock", "frozen");
    let staged = SessionRef::new("runner", "mock", "staged");
    let released = SessionRef::new("runner", "mock", "released");
    {
        let journal = Journal::load(path.clone());
        journal
            .change(|contents| {
                for (key, cut, state) in [
                    (&frozen, "cut-f", Some(MovingState::Frozen)),
                    (&staged, "cut-s", Some(MovingState::Staged)),
                    (&released, "cut-r", None),
                ] {
                    contents.cuts.insert(
                        cut.into(),
                        Cut {
                            step: if state.is_some() {
                                Step::Prepared
                            } else {
                                Step::Released
                            },
                            ..Cut::default()
                        },
                    );
                    let entry = contents.session_mut(&key.runner, &key.harness, &key.session);
                    match state {
                        Some(state) => {
                            entry.moving = Some(Moving {
                                cut: cut.into(),
                                state,
                            })
                        }
                        None => {
                            entry.released = Some(Released {
                                cut: cut.into(),
                                holder: "mac-b".into(),
                            })
                        }
                    }
                }
            })
            .unwrap();
    }
    // The restart, with moves off.
    let journal = Arc::new(Journal::load(path));
    let log = logged(|| journal.log_held(false));
    let lines: Vec<&str> = log.lines().collect();
    for (session, cut, remedy) in [
        (
            "runner/mock/frozen",
            "cut-f",
            "agent-data moves are off in this build, so a build with them on must abort or finish the move",
        ),
        (
            "runner/mock/staged",
            "cut-s",
            "agent-data moves are off in this build, so a build with them on must abort or finish the move",
        ),
        (
            "runner/mock/released",
            "cut-r",
            "only a move back to this machine serves it here again",
        ),
    ] {
        assert!(
            lines
                .iter()
                .any(|line| line.contains(session) && line.contains(cut) && line.contains(remedy)),
            "{session}: {log}"
        );
    }
    let with_moves_on = logged(|| journal.log_held(true));
    assert!(
        with_moves_on.contains("until Entorhinal aborts or finishes the move"),
        "{with_moves_on}"
    );
    let store = Store::open(&dir.path().join("mode3.db")).unwrap();
    let module = Module::with_journal(
        Client,
        Settings::default(),
        None,
        Some(store),
        journal,
        false,
    );
    assert!(!module.agent_data_enabled());
    let setup = |key: &SessionRef| {
        module.setup(
            Route {
                session: key.clone(),
                project: None,
                workdir: None,
                agent_id: None,
            },
            SetupRequest::new("head", model(), 100_000, 1000, rules(), vec![], 1),
        )
    };
    for (key, cut) in [(&frozen, "cut-f"), (&staged, "cut-s")] {
        match setup(key) {
            Err(ModuleError::Gated(gated)) => {
                assert_eq!(gated.code, SESSION_MOVING);
                assert_eq!(gated.detail, Some(json!({"cut": cut})));
            }
            other => panic!("{key:?}: expected session_moving, got {other:?}"),
        }
    }
    match setup(&released) {
        Err(ModuleError::Gated(gated)) => {
            assert_eq!(gated.code, SESSION_MOVED);
            assert_eq!(gated.detail, Some(json!({"holder": "mac-b"})));
        }
        other => panic!("expected session_moved, got {other:?}"),
    }
    // A session no move holds is served.
    assert_eq!(
        setup(&SessionRef::new("runner", "mock", "free")),
        Ok(SetupAnswer::Ready)
    );
}
