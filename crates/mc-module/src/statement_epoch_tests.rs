//! Statement epochs, checked as a notice or ride arrives: a statement from
//! another Setup's epoch, with mismatched presence, or with a stamp but no
//! epoch is dropped whole and advances nothing. A dropped notice is
//! answered `setup_required` and a dropped ride refused `unknown_session`,
//! while the session's own statements go on being taken.

use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_compaction::{
    notice::Conditions,
    read::{Head, ReadPage, ReadRequest},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};

/// A runner whose transcript is empty and which takes every view.
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
        unreachable!("an empty transcript gets no reminder")
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!("a worker preset runs no summarizer")
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!("a worker preset runs no summarizer")
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

const LIVE: &str = "live-epoch";
const OTHER: &str = "replaced-epoch";

struct Fixture {
    module: Module<Client>,
    key: SessionRef,
    _dir: tempfile::TempDir,
}

fn conditions(model: &str) -> Conditions {
    Conditions::new(
        ModelRef::new("test", model),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
    )
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let module = Module::new(Client, Settings::default(), None, Some(store));
        Self {
            module,
            key: SessionRef::new("runner", "mock", "worker"),
            _dir: dir,
        }
    }

    /// Set the session up under `epoch` (none when `None`), stamped 1.
    fn setup(&self, epoch: Option<&str>) {
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let mut request = SetupRequest::new(
            "worker",
            ModelRef::new("test", "model"),
            100_000,
            1000,
            rules,
            vec![],
            1,
        );
        if let Some(epoch) = epoch {
            request = request.with_statement_order(epoch, 1, true).unwrap();
        }
        let route = Route {
            session: self.key.clone(),
            project: None,
            workdir: None,
            agent_id: None,
        };
        assert_eq!(
            self.module.setup(route, request).unwrap(),
            SetupAnswer::Ready
        );
    }

    fn notice(
        &self,
        seq: u64,
        epoch: Option<&str>,
        stamp: Option<u64>,
        model: &str,
    ) -> NoticeAnswer {
        let mut conditions = conditions(model);
        conditions.statement_epoch = epoch.map(str::to_owned);
        conditions.statement_seq = stamp;
        self.module
            .notice(&self.key, NoticeRequest::new(seq, conditions))
            .unwrap()
    }

    async fn ride(
        &self,
        epoch: Option<&str>,
        stamp: Option<u64>,
    ) -> Result<RideAnswer, ModuleError> {
        let mut conditions = conditions("model");
        conditions.statement_epoch = epoch.map(str::to_owned);
        conditions.statement_seq = stamp;
        self.module
            .ride(&self.key, RideRequest::new(Vec::new(), 1_000, conditions))
            .await
    }

    /// The model of the conditions the session last took, as saved.
    async fn taken_model(&self) -> String {
        self.module.idle(&self.key).await.unwrap();
        let durable = self.module.inner.store.as_ref().unwrap().load(&self.key);
        durable
            .and_then(|durable| durable.compaction)
            .map(|(_, conditions)| conditions.model.model)
            .expect("the session's conditions are saved")
    }

    fn held_epoch(&self) -> Option<Option<String>> {
        self.module
            .inner
            .set_up
            .lock()
            .unwrap()
            .get(&self.key)
            .cloned()
    }
}

/// A live session whose statements carry the held epoch is never answered
/// `setup_required` because frames from another epoch arrive in between.
/// The foreign frames (another epoch, no epoch, a stamp without an epoch)
/// are dropped and answered; the live ones are taken. The held epoch is
/// untouched; so is the notice number, since the live notice numbered 2
/// is still taken after a foreign one numbered 9; and so is the stamp,
/// since the live notice stamped 3 is still taken after a foreign one
/// stamped 99.
#[tokio::test]
async fn epoch_foreign_frames_leave_the_live_session_alone() {
    let f = Fixture::new();
    f.setup(Some(LIVE));
    assert_eq!(
        f.notice(1, Some(LIVE), Some(2), "first"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "first");
    for (seq, epoch, stamp) in [
        (9, Some(OTHER), Some(99)),
        (10, None, None),
        (11, None, Some(100)),
    ] {
        assert_eq!(
            f.notice(seq, epoch, stamp, "foreign"),
            NoticeAnswer::SetupRequired,
            "{epoch:?}, {stamp:?}"
        );
    }
    for (epoch, stamp) in [(Some(OTHER), Some(99)), (None, None), (None, Some(100))] {
        let refused = f.ride(epoch, stamp).await;
        assert!(
            matches!(refused, Err(ModuleError::UnknownSession)),
            "{epoch:?}, {stamp:?}: {refused:?}"
        );
    }
    assert_eq!(f.taken_model().await, "first", "a foreign frame was taken");
    assert_eq!(
        f.notice(2, Some(LIVE), Some(3), "second"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "second");
    assert!(f.ride(Some(LIVE), Some(3)).await.is_ok());
    assert_eq!(f.held_epoch(), Some(Some(LIVE.to_owned())));
}

/// A Setup with neither epoch nor stamp clears the held epoch: statements
/// without either are taken in arrival order, and one naming an epoch is
/// dropped. A later Setup naming an epoch holds that one.
#[tokio::test]
async fn epoch_a_setup_without_one_clears_it() {
    let f = Fixture::new();
    f.setup(Some(LIVE));
    f.setup(None);
    assert_eq!(f.held_epoch(), Some(None));
    assert_eq!(f.notice(1, None, None, "unordered"), NoticeAnswer::Received);
    assert_eq!(f.taken_model().await, "unordered");
    assert_eq!(
        f.notice(2, Some(LIVE), Some(5), "stamped"),
        NoticeAnswer::SetupRequired
    );
    assert!(matches!(
        f.ride(Some(LIVE), Some(5)).await,
        Err(ModuleError::UnknownSession)
    ));
    assert!(f.ride(None, None).await.is_ok());
    f.setup(Some(OTHER));
    assert_eq!(f.held_epoch(), Some(Some(OTHER.to_owned())));
    assert_eq!(
        f.notice(1, Some(OTHER), Some(1), "again"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "again");
}

/// After a ck-mc restart no session is set up: a notice is answered
/// `setup_required` and a ride naming an epoch is refused
/// `unknown_session`, so the runner sets the session up again.
#[tokio::test]
async fn epoch_a_session_not_set_up_since_a_restart_asks_for_setup() {
    let f = Fixture::new();
    assert_eq!(
        f.notice(1, Some(LIVE), Some(4), "model"),
        NoticeAnswer::SetupRequired
    );
    assert!(matches!(
        f.ride(Some(LIVE), Some(4)).await,
        Err(ModuleError::UnknownSession)
    ));
    assert!(matches!(
        f.ride(None, None).await,
        Err(ModuleError::UnknownSession)
    ));
}
