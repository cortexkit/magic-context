//! A session with no job for a while is freed: its worker stops, and the
//! apps' replica lets its snapshot go. Its next job starts a worker again,
//! which resumes the session before the job runs ([`Session::quiet_carry`],
//! [`Session::resume_quiet`]).

use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_compaction::{
    notice::Conditions,
    part::{Part, PartBody},
    read::{Cursor, Entry, Head, ReadPage, ReadRequest, Role, Select},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};
use serde_json::json;

/// A runner with one transcript, which takes every view it is handed and
/// reports applying the one a test names.
#[derive(Default)]
struct Client {
    entries: Mutex<Vec<Entry>>,
    applied: Mutex<Option<View>>,
    offered: Mutex<Vec<View>>,
    reads: Mutex<usize>,
    ends: crate::run_ends::RunEnds,
    /// How long each transcript read takes, standing for the pages a long
    /// transcript costs a real runner to serve.
    read_delay: Mutex<Duration>,
    /// Transcript reads fail, as when the runner went away.
    fail_reads: Mutex<bool>,
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        *self.reads.lock().unwrap() += 1;
        if *self.fail_reads.lock().unwrap() {
            return Err(ClientError::new("connection lost"));
        }
        let delay = *self.read_delay.lock().unwrap();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let entries = self.entries.lock().unwrap();
        let mut head = Head::new();
        head.newest = entries.last().map(cursor);
        let selected = entries
            .iter()
            .filter(|entry| match &request.select {
                Select::After { after_ordinal, .. } => entry.ordinal > after_ordinal.unwrap_or(0),
                Select::Mids { mids } => mids.contains(&entry.mid),
                _ => false,
            })
            .cloned()
            .collect();
        Ok(ReadPage::new(selected, head))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.offered.lock().unwrap().push(request.view);
        Ok(ApplyViewAnswer::Accepted)
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.applied.lock().unwrap().clone();
        answer.applied_by = answer.view.as_ref().map(|_| crate::MODULE_ID.to_owned());
        Ok(answer)
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no summarizer in these tests"))
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no child"))
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no child"))
    }
    fn run_ends(&self) -> Option<&crate::run_ends::RunEnds> {
        Some(&self.ends)
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

fn text(ordinal: u64, mid: &str) -> Entry {
    let part = Part::new(
        "p",
        PartBody::Text {
            text: format!("message {mid}").into(),
        },
    )
    .with_tag(ordinal);
    Entry::new(ordinal, mid, Role::User, ordinal, vec![part])
}

/// A module with both stores, and one session set up on `preset` under a
/// statement epoch, with four messages. With `hold`, a summarizer run counts
/// as in flight for the session from before its Setup, so it is never freed.
///
/// The tests run on tokio's paused clock, which jumps to the next timer
/// whenever every task waits, also while a task waits on the apps' replica
/// or the search index, which run on threads of their own. So a session
/// without `hold` may be freed, and resumed, at any such wait; the tests
/// assert only what holds either way. Waits on the session's own worker
/// (`idle_foreground`) keep a task runnable and the clock still.
struct Fixture {
    module: Module<Client>,
    route: Route,
    setup: SetupRequest,
    conditions: Conditions,
    _hold: Option<crate::agent_data::busy::RunGuard>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    async fn new(preset: &str, hold: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let module = Module::new(
            Client::default(),
            Settings::default(),
            Some(db),
            Some(store),
        );
        let route = Route {
            session: SessionRef::new("runner", "mock", "s1"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let model = ModelRef::new("test", "model");
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let entries: Vec<_> = ["a", "b", "c", "d"]
            .iter()
            .zip(1..)
            .map(|(mid, ordinal)| text(ordinal, mid))
            .collect();
        let mut setup = SetupRequest::new(
            preset,
            model.clone(),
            100_000,
            1000,
            rules.clone(),
            vec![],
            1,
        );
        setup.newest = entries.last().map(cursor);
        setup.statement_epoch = Some("epoch".into());
        setup.statement_seq = Some(1);
        *module.inner.client.entries.lock().unwrap() = entries;
        let hold = hold.then(|| module.inner.runs.start(&route.session));
        module.setup(route.clone(), setup.clone()).unwrap();
        module.idle_foreground(&route.session).await.unwrap();
        let mut conditions = Conditions::new(model, 100_000, 1000, rules);
        conditions.statement_epoch = Some("epoch".into());
        Self {
            module,
            route,
            setup,
            conditions,
            _hold: hold,
            _dir: dir,
        }
    }

    fn key(&self) -> &SessionRef {
        &self.route.session
    }

    fn client(&self) -> &Client {
        &self.module.inner.client
    }

    fn quiet(&self) -> bool {
        matches!(
            self.module.inner.workers.lock().unwrap().get(self.key()),
            Some(Slot::Quiet(_))
        )
    }

    /// Notice `seq`, stamped `seq + 1`, reporting the runner's applied view
    /// and `tokens` as the newest prompt size, with `entry` new if given.
    async fn notice(&self, seq: u64, entry: Option<Entry>, tokens: Option<u64>) {
        if let Some(entry) = &entry {
            self.client().entries.lock().unwrap().push(entry.clone());
        }
        let mut conditions = self.conditions.clone();
        conditions.statement_seq = Some(seq + 1);
        conditions.last_prompt_tokens = tokens;
        let mut notice = NoticeRequest::new(seq, conditions);
        notice.newest = self.client().entries.lock().unwrap().last().map(cursor);
        notice.entries = entry.into_iter().collect();
        notice.applied_view = self
            .client()
            .applied
            .lock()
            .unwrap()
            .as_ref()
            .map(View::applied);
        assert_eq!(
            self.module.notice(self.key(), notice),
            Ok(NoticeAnswer::Received)
        );
        self.module.idle_foreground(self.key()).await.unwrap();
    }

    /// The model drops `tag`, and a notice at the execute threshold, the
    /// newest prompt `tokens` long, hands a view over that the runner then
    /// applies.
    async fn drop_tag(&self, tag: u64, seq: u64, tokens: u64) {
        self.module
            .tool(&self.route, "ctx_reduce", json!({"drop": tag.to_string()}))
            .await
            .unwrap();
        let views = self.client().offered.lock().unwrap().len();
        self.notice(seq, None, Some(tokens)).await;
        assert_eq!(
            self.client().offered.lock().unwrap().len(),
            views + 1,
            "the execute pass hands a view over"
        );
        let offered = self.client().offered.lock().unwrap().last().cloned();
        *self.client().applied.lock().unwrap() = offered;
        self.notice(seq + 1, None, Some(10_000)).await;
    }

    /// Let the search index catch up and the app checkpoint's timer run,
    /// then the session's quiet time pass.
    async fn wait_quiet_time(&self) {
        self.module.search_idle(self.key()).await.unwrap();
        tokio::time::advance(Duration::from_secs(61)).await;
        settle().await;
        tokio::time::advance(QUIET_AFTER).await;
        settle().await;
    }

    /// Finish the search and app checkpoint work before measuring a quiet
    /// period, so neither can delay freeing or reset its timer.
    async fn drain_quiet_prerequisites(&self) {
        self.notice(1, None, None).await;
        self.module.search_idle(self.key()).await.unwrap();
        self.module.flush_app_snapshots().await;
    }

    /// What the apps read of the session, without the times each answer
    /// stamps when it is made.
    async fn app_reads(&self) -> Vec<Value> {
        let key = self.key();
        let mut reads = Vec::new();
        for (method, params) in [
            ("session_data.read", json!({"session":key,"section":"meta"})),
            (
                "session_data.read",
                json!({"session":key,"section":"token_breakdown"}),
            ),
            (
                "context.states",
                json!({"session":key,"message_ids":["a","b","c","d","e","f"]}),
            ),
        ] {
            let mut read = self.module.app_request(method, params).await.unwrap();
            timeless(&mut read);
            reads.push(read);
        }
        reads
    }

    /// The state saved to `mode3.db`, without wall-clock times: those of
    /// `*_ms` members, and the time each part's tag was stamped.
    fn saved(&self) -> Value {
        let store = self.module.inner.store.as_ref().unwrap();
        let mut saved = serde_json::to_value(store.load(self.key()).unwrap()).unwrap();
        timeless(&mut saved);
        for stamp in saved["app"]["stamps"].as_array_mut().unwrap() {
            stamp.as_array_mut().unwrap().truncate(1);
        }
        saved
    }
}

/// Let woken tasks run on the paused test clock.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

/// The paused runtime runs earlier timers before advancing to this one.
async fn wait_past_quiet_deadline(quiet_for: Duration) {
    tokio::time::timeout(
        quiet_for + Duration::from_secs(1),
        std::future::pending::<()>(),
    )
    .await
    .unwrap_err();
}

/// Remove every member that holds a wall-clock time (`*_ms`): two modules
/// handle the same job a few milliseconds apart.
fn timeless(value: &mut Value) {
    match value {
        Value::Object(members) => {
            members.retain(|name, _| !name.ends_with("_ms"));
            members.values_mut().for_each(timeless);
        }
        Value::Array(items) => items.iter_mut().for_each(timeless),
        _ => {}
    }
}

#[tokio::test(start_paused = true)]
async fn quiet_a_freed_session_answers_its_next_jobs_as_one_never_freed() {
    let kept = Fixture::new("worker", true).await;
    let freed = Fixture::new("worker", false).await;
    for f in [&kept, &freed] {
        f.drop_tag(2, 1, 70_000).await;
    }
    let before = freed.app_reads().await;
    for f in [&kept, &freed] {
        f.wait_quiet_time().await;
    }
    assert!(!kept.quiet(), "a session with a run in flight was freed");
    assert!(
        freed.quiet(),
        "a session without a job for its quiet time stays"
    );
    assert_eq!(
        freed.app_reads().await,
        before,
        "the apps read a freed session as before"
    );

    let now = 30 * 60_000;
    let mut answers = Vec::new();
    for f in [&kept, &freed] {
        let hint = f
            .module
            .pre_user(f.key(), "Carry on with the parser fix", now)
            .await;
        f.notice(3, Some(text(5, "e")), Some(10_000)).await;
        // Sent again, the same notice is not run twice.
        f.notice(3, None, Some(10_000)).await;
        f.drop_tag(3, 4, 72_000).await;
        f.notice(6, Some(text(6, "f")), Some(10_000)).await;
        let reads = f.app_reads().await;
        let views = f.client().offered.lock().unwrap().clone();
        answers.push((hint, views, f.saved(), reads));
    }
    assert!(!kept.quiet(), "a session with a run in flight was freed");
    assert_eq!(answers[0].0, answers[1].0, "pre_user");
    assert_eq!(answers[0].1, answers[1].1, "views handed over");
    assert_eq!(answers[0].2, answers[1].2, "saved state");
    assert_eq!(answers[0].3, answers[1].3, "app reads");
}

#[tokio::test(start_paused = true)]
async fn quiet_an_expired_carry_restores_the_same_view_bytes_on_setup() {
    let kept = Fixture::new("worker", true).await;
    let expired = Fixture::new("worker", false).await;
    for f in [&kept, &expired] {
        f.drop_tag(2, 1, 70_000).await;
    }
    let saved = expired.saved();
    expired.wait_quiet_time().await;
    assert!(expired.quiet());
    expired.module.spawn_quiet_carry_sweep();
    settle().await;
    tokio::time::advance(Duration::from_secs(2 * 60 * 60)).await;
    settle().await;
    assert!(!expired
        .module
        .inner
        .workers
        .lock()
        .unwrap()
        .contains_key(expired.key()));
    assert_eq!(
        expired.saved(),
        saved,
        "eviction leaves the checkpoint alone"
    );

    let reads = *expired.client().reads.lock().unwrap();
    for f in [&kept, &expired] {
        let mut setup = f.setup.clone();
        setup.statement_seq = Some(4);
        f.module.setup(f.route.clone(), setup).unwrap();
        f.module.idle_foreground(f.key()).await.unwrap();
        f.drop_tag(3, 4, 72_000).await;
    }
    assert!(*expired.client().reads.lock().unwrap() > reads);
    let views = |f: &Fixture| serde_json::to_vec(&*f.client().offered.lock().unwrap()).unwrap();
    assert_eq!(views(&expired), views(&kept));
}

#[tokio::test(start_paused = true)]
async fn quiet_a_busy_session_is_never_freed() {
    let f = Fixture::new("worker", false).await;
    // A view the runner took but has not reported applying.
    f.module
        .tool(&f.route, "ctx_reduce", json!({"drop": "2"}))
        .await
        .unwrap();
    f.notice(1, None, Some(70_000)).await;
    assert_eq!(f.client().offered.lock().unwrap().len(), 1);
    f.wait_quiet_time().await;
    assert!(!f.quiet(), "a session with an unconfirmed view was freed");

    // The runner applies it, but a summarizer run is in flight.
    *f.client().applied.lock().unwrap() = f.client().offered.lock().unwrap().last().cloned();
    f.notice(2, None, Some(10_000)).await;
    let in_flight = f.module.inner.runs.start(f.key());
    f.wait_quiet_time().await;
    assert!(!f.quiet(), "a session with a run in flight was freed");

    drop(in_flight);
    tokio::time::advance(QUIET_AFTER).await;
    settle().await;
    assert!(
        f.quiet(),
        "a session with nothing in flight stays in memory"
    );
}

#[tokio::test(start_paused = true)]
async fn quiet_a_notice_sent_as_the_quiet_time_ends_runs_once_on_the_worker() {
    let f = Fixture::new("worker", false).await;
    f.notice(1, Some(text(5, "e")), None).await;
    tokio::time::advance(Duration::from_secs(61)).await;
    settle().await;
    // The quiet time ends with a notice queued: a worker runs it, the one
    // that was waiting or one started again.
    tokio::time::advance(QUIET_AFTER).await;
    f.notice(2, Some(text(6, "f")), None).await;
    settle().await;
    assert!(!f.quiet(), "the notice's worker freed the session");
    let states = f.app_reads().await.pop().unwrap();
    assert_eq!(states["messages"][5]["message_id"], "f", "{states}");

    // A job that arrives while the worker frees its session stays with that
    // worker, which reads the session again before running it.
    f.wait_quiet_time().await;
    let Some(Slot::Quiet(quiet)) = f.module.inner.workers.lock().unwrap().remove(f.key()) else {
        panic!("the session went quiet");
    };
    let (jobs, mut receiver) = mpsc::unbounded_channel();
    f.module
        .inner
        .workers
        .lock()
        .unwrap()
        .insert(f.key().clone(), Slot::Running(jobs.clone()));
    let (reply, _answer) = oneshot::channel();
    jobs.send(Job::Idle(reply)).unwrap();
    let mut carry = Some(quiet.carry);
    let mut ready = VecDeque::new();
    let freed = |carry: &mut Option<crate::session::QuietCarry>,
                 receiver: &mut mpsc::UnboundedReceiver<Job>,
                 ready: &mut VecDeque<Job>| {
        free_quiet(
            &f.module.inner,
            f.key(),
            &jobs.downgrade(),
            receiver,
            &mut None,
            carry,
            &mut None,
            Freed {
                saved: &quiet.saved,
                subagent: quiet.subagent,
                quiet_for: QUIET_AFTER,
                idle_since: tokio::time::Instant::now(),
            },
            ready,
        )
    };
    assert!(!freed(&mut carry, &mut receiver, &mut ready));
    assert!(matches!(ready.pop_front(), Some(Job::Idle(_))));
    assert!(carry.is_some(), "the worker keeps the session for the job");
    assert!(!f.quiet());
    // With nothing queued, it gives its place up.
    assert!(freed(&mut carry, &mut receiver, &mut ready));
    assert!(f.quiet());
}

/// The runner reports that the session's run ended, then a minute passes
/// after the session's last job; whether the session is quiet then.
async fn quiet_a_minute_after_the_run_ended(f: &Fixture) -> bool {
    f.drain_quiet_prerequisites().await;
    // A job that starts the worker again if the paused clock freed the
    // session while the search index was waited for. A `pre_user` answered
    // from a freed session reads the session again right after it: wait for
    // that, so the minute counts from the worker's last job.
    f.module.pre_user(f.key(), "next", 0).await;
    f.module.idle_foreground(f.key()).await.unwrap();
    assert!(!f.quiet());
    let woke = f
        .client()
        .ends
        .wake(None, &crate::agent_data::source::session_ref(f.key()));
    assert_eq!(
        woke,
        if f.setup.preset == "worker" {
            crate::run_ends::Woke::Waits(1)
        } else {
            crate::run_ends::Woke::Nobody
        }
    );
    // Wait for the worker to handle the queued run-end job before measuring.
    f.module.idle_foreground(f.key()).await.unwrap();
    wait_past_quiet_deadline(QUIET_AFTER_RUN_END).await;
    f.quiet()
}

#[tokio::test(start_paused = true)]
async fn quiet_a_worker_session_is_freed_a_minute_after_its_run_ended() {
    let f = Fixture::new("worker", false).await;
    assert!(
        quiet_a_minute_after_the_run_ended(&f).await,
        "a worker whose run ended stays in memory"
    );
    // Its next notice is taken as from the Setup it had.
    f.notice(2, Some(text(5, "e")), None).await;
    assert!(!f.quiet());
    let states = f.app_reads().await.pop().unwrap();
    assert_eq!(states["messages"][4]["message_id"], "e", "{states}");
}

#[path = "quiet_worker_review_tests.rs"]
mod quiet_worker_review_tests;

#[tokio::test(start_paused = true)]
async fn quiet_a_head_session_waits_its_whole_quiet_time_after_its_run_ended() {
    let f = Fixture::new("head", false).await;
    assert!(
        !quiet_a_minute_after_the_run_ended(&f).await,
        "a head was freed before its quiet time"
    );
}

/// A `pre_user` answered from a freed session's carry is followed by the
/// runner's next request: the worker resumes the session right after
/// answering, so that request doesn't wait for the resume. Seen here through
/// the summaries, which the resume reads from `context.db`: made unreadable
/// after the hook, they stop the next tool call only if the session was
/// still to be resumed.
#[tokio::test(start_paused = true)]
async fn quiet_a_pre_user_answered_while_freed_resumes_the_session_at_once() {
    let f = Fixture::new("worker", false).await;
    f.wait_quiet_time().await;
    assert!(f.quiet(), "the session went quiet");
    let reads = *f.client().reads.lock().unwrap();
    f.module
        .pre_user(f.key(), "Carry on with the parser fix", 30 * 60_000)
        .await;
    f.module.idle_foreground(f.key()).await.unwrap();
    assert!(!f.quiet(), "the hook's worker runs the session");
    let hide = |hidden: bool| {
        let sql = if hidden {
            "ALTER TABLE compartments RENAME TO compartments_hidden"
        } else {
            "ALTER TABLE compartments_hidden RENAME TO compartments"
        };
        let db = f.module.inner.db.as_ref().unwrap();
        db.with_connection(|conn| conn.execute_batch(sql)).unwrap();
    };
    hide(true);
    let answer = f
        .module
        .tool(&f.route, "ctx_reduce", json!({"drop": "2"}))
        .await;
    hide(false);
    assert!(
        answer.is_ok(),
        "the session was not resumed after the hook: {answer:?}"
    );
    assert_eq!(
        *f.client().reads.lock().unwrap(),
        reads,
        "resuming reads nothing from the runner"
    );
}
