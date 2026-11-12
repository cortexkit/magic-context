use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_compaction::{
    notice::Conditions,
    part::{Part, PartBody},
    read::{Cursor, Entry, Head, ReadPage, ReadRequest, Role},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};
use serde_json::json;

#[derive(Default)]
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
    key: SessionRef,
    conditions: Conditions,
    _dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let module = Module::new(Client, Settings::default(), None, Some(store));
        let key = SessionRef::new("runner", "mock", "head");
        let model = ModelRef::new("test", "model");
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        module
            .setup(
                Route {
                    session: key.clone(),
                    project: None,
                    workdir: None,
                    agent_id: None,
                },
                SetupRequest::new(
                    "head",
                    model.clone(),
                    100_000,
                    1000,
                    rules.clone(),
                    vec![],
                    1,
                ),
            )
            .unwrap();
        module.idle(&key).await.unwrap();
        let f = Self {
            module,
            key,
            conditions: Conditions::new(model, 100_000, 1000, rules),
            _dir: dir,
        };
        assert_eq!(f.writes(), 1, "Setup saved the initial checkpoint");
        f
    }

    fn store(&self) -> &Store {
        self.module.inner.store.as_ref().unwrap()
    }

    fn writes(&self) -> u64 {
        self.store().take_app_writes().1
    }

    async fn change(&self, ordinal: u64) {
        let mid = format!("m{ordinal}");
        let entry = Entry::new(
            ordinal,
            &mid,
            Role::Assistant,
            ordinal,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: mid.clone().into(),
                },
            )],
        );
        let mut notice = NoticeRequest::new(ordinal, self.conditions.clone())
            .with_newest(Cursor::new(ordinal, mid, entry.digest.clone()));
        notice.entries = vec![entry];
        assert_eq!(
            self.module.notice(&self.key, notice),
            Ok(NoticeAnswer::Received)
        );
        self.module.idle(&self.key).await.unwrap();
    }

    async fn advance(&self, seconds: u64) {
        tokio::time::advance(Duration::from_secs(seconds)).await;
        // Let the timer enqueue its job before the foreground barrier. The
        // barrier itself does not save or refresh the app projection.
        tokio::task::yield_now().await;
        self.module.idle(&self.key).await.unwrap();
    }

    async fn assert_restarted_row(&self, mid: &str) {
        let app = crate::app_read::AppRead::new(Some(self.store().path.clone()), None);
        let reply = app
            .read(
                "context.states",
                json!({"session":self.key,"message_ids":[mid]}),
            )
            .await
            .unwrap();
        assert_eq!(reply["messages"][0]["state"], "raw", "{reply}");
    }
}

#[tokio::test(start_paused = true)]
async fn app_read_last_notice_is_saved_on_deadline_without_another_notice() {
    let f = Fixture::new().await;
    f.change(1).await;
    assert_eq!(f.writes(), 0);
    f.advance(59).await;
    assert_eq!(f.writes(), 0);
    f.advance(1).await;
    assert_eq!(f.writes(), 1);
    f.assert_restarted_row("m1").await;
}

#[tokio::test(start_paused = true)]
async fn app_read_many_changes_move_one_deadline_to_the_last_change() {
    let f = Fixture::new().await;
    for ordinal in 1..=10 {
        f.change(ordinal).await;
        if ordinal < 10 {
            f.advance(5).await;
        }
    }
    assert_eq!(f.writes(), 0);
    // The first timer fires at 60 s, but the last change was at 45 s.
    f.advance(15).await;
    assert_eq!(f.writes(), 0, "the old deadline must only re-arm");
    f.advance(44).await;
    assert_eq!(f.writes(), 0);
    f.advance(1).await;
    assert_eq!(f.writes(), 1);
    f.assert_restarted_row("m10").await;
    f.advance(120).await;
    assert_eq!(f.writes(), 0);
}

#[tokio::test(start_paused = true)]
async fn app_read_notice_checkpoint_cancels_deadline_and_late_job_writes_nothing() {
    let f = Fixture::new().await;
    f.advance(50).await;
    f.change(1).await;
    assert_eq!(f.writes(), 0);
    f.advance(10).await;
    f.change(2).await;
    assert_eq!(f.writes(), 1, "the notice checkpoint is due since Setup");
    f.module
        .send(&f.key, Job::AppCheckpoint { flush: None })
        .unwrap();
    f.module.idle(&f.key).await.unwrap();
    f.advance(120).await;
    assert_eq!(
        f.writes(),
        0,
        "neither the timer nor a stale job saves again"
    );
    f.assert_restarted_row("m2").await;
}

#[tokio::test(start_paused = true)]
async fn app_read_removed_session_cancels_pending_deadline() {
    let f = Fixture::new().await;
    f.change(1).await;
    f.module.inner.set_up.lock().unwrap().remove(&f.key);
    let worker = f
        .module
        .inner
        .workers
        .lock()
        .unwrap()
        .remove(&f.key)
        .unwrap();
    let weak = worker.downgrade();
    drop(worker);
    tokio::task::yield_now().await;
    assert!(weak.upgrade().is_none(), "timer must not retain the worker");
    tokio::time::advance(Duration::from_secs(120)).await;
    tokio::task::yield_now().await;
    assert_eq!(f.writes(), 0);
    let conn = rusqlite::Connection::open(&f.store().path).unwrap();
    let count: u64 = conn
        .query_row("SELECT count(*) FROM app_read_messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0, "removed session's pending row must not reappear");
}

#[tokio::test(start_paused = true)]
async fn app_read_failed_deadline_save_retains_rows_without_retry_spinning() {
    let f = Fixture::new().await;
    f.change(1).await;
    let conn = rusqlite::Connection::open(&f.store().path).unwrap();
    conn.execute_batch("CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON app_read_headers BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END;").unwrap();
    f.advance(60).await;
    assert_eq!(
        f.writes(),
        1,
        "one failed attempt, not an overdue timer loop"
    );
    f.advance(59).await;
    assert_eq!(f.writes(), 0);
    conn.execute_batch("DROP TRIGGER refuse_checkpoint;")
        .unwrap();
    f.advance(1).await;
    assert_eq!(f.writes(), 1);
    f.assert_restarted_row("m1").await;
}

#[tokio::test(start_paused = true)]
async fn app_read_shutdown_flush_saves_dirty_sessions_and_cancels_deadlines() {
    let f = Fixture::new().await;
    f.change(1).await;
    assert_eq!(f.writes(), 0);
    f.module.flush_app_snapshots().await;
    assert_eq!(f.writes(), 1, "shutdown does not wait for the deadline");
    f.assert_restarted_row("m1").await;
    f.advance(120).await;
    assert_eq!(f.writes(), 0);
    f.module.flush_app_snapshots().await;
    assert_eq!(
        f.writes(),
        0,
        "a clean session needs no shutdown checkpoint"
    );
}
