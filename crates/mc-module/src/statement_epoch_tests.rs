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
        model: &str,
    ) -> Result<RideAnswer, ModuleError> {
        self.module
            .ride(
                &self.key,
                RideRequest::new(Vec::new(), 1_000, ordered(epoch, stamp, model)),
            )
            .await
    }

    /// Queue a notice for the session's worker past the arrival check, as
    /// one that passed it just before a new Setup was recorded would be.
    fn queue_notice(&self, seq: u64, epoch: Option<&str>, stamp: Option<u64>, model: &str) {
        let request = NoticeRequest::new(seq, ordered(epoch, stamp, model));
        self.module.send(&self.key, Job::Notice(request)).unwrap();
    }

    /// Queue a ride for the session's worker past the arrival check, and
    /// wait for its answer.
    async fn queue_ride(&self, epoch: Option<&str>, stamp: Option<u64>, model: &str) {
        let request = RideRequest::new(Vec::new(), 1_000, ordered(epoch, stamp, model));
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.module
            .send(&self.key, Job::Ride(request, reply))
            .unwrap();
        let _ = answer.await;
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

/// Conditions naming `model`, marked with `epoch` and `stamp`.
fn ordered(epoch: Option<&str>, stamp: Option<u64>, model: &str) -> Conditions {
    let mut conditions = conditions(model);
    conditions.statement_epoch = epoch.map(str::to_owned);
    conditions.statement_seq = stamp;
    conditions
}

/// A live session whose statements carry the held epoch is never answered
/// `setup_required` because frames from another epoch arrive in between.
/// The foreign frames (another epoch, no epoch, a stamp without an epoch)
/// are dropped and answered on arrival, and dropped again when the same
/// frames reach the worker past that check. The live ones are taken. The
/// held epoch is untouched; so is the notice number, since the live notice
/// numbered 2 is still taken after foreign ones numbered 9 to 11 reached
/// the worker; and so is the stamp, since the live notice stamped 3 is
/// still taken after foreign ones stamped 99 and 100 did.
#[tokio::test]
async fn epoch_foreign_frames_leave_the_live_session_alone() {
    let f = Fixture::new();
    f.setup(Some(LIVE));
    assert_eq!(
        f.notice(1, Some(LIVE), Some(2), "first"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "first");
    let foreign = [
        (9, Some(OTHER), Some(99)),
        (10, None, None),
        (11, None, Some(100)),
    ];
    for (seq, epoch, stamp) in foreign {
        assert_eq!(
            f.notice(seq, epoch, stamp, "foreign"),
            NoticeAnswer::SetupRequired,
            "{epoch:?}, {stamp:?}"
        );
        let refused = f.ride(epoch, stamp, "foreign").await;
        assert!(
            matches!(refused, Err(ModuleError::UnknownSession)),
            "{epoch:?}, {stamp:?}: {refused:?}"
        );
    }
    // The same frames, queued for the worker past the arrival check.
    for (seq, epoch, stamp) in foreign {
        f.queue_notice(seq, epoch, stamp, "foreign");
        f.queue_ride(epoch, stamp, "foreign").await;
    }
    assert_eq!(f.taken_model().await, "first", "a foreign frame was taken");
    assert_eq!(
        f.notice(2, Some(LIVE), Some(3), "second"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "second");
    // A ride is taken too: its conditions are the ones held after it.
    assert!(f.ride(Some(LIVE), Some(3), "ridden").await.is_ok());
    assert_eq!(f.taken_model().await, "ridden");
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
        f.ride(Some(LIVE), Some(5), "stamped").await,
        Err(ModuleError::UnknownSession)
    ));
    assert!(f.ride(None, None, "unordered").await.is_ok());
    f.setup(Some(OTHER));
    assert_eq!(f.held_epoch(), Some(Some(OTHER.to_owned())));
    assert_eq!(
        f.notice(1, Some(OTHER), Some(1), "again"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "again");
}

/// After a ck-mc restart no session is set up, though a tool call can
/// already have started the session's worker. A notice is answered
/// `setup_required`, and a ride naming an epoch or a stamp is refused
/// `unknown_session`, so the runner sets the session up again; a ride
/// naming neither still reaches that worker, as before statement order
/// existed.
#[tokio::test]
async fn epoch_a_session_not_set_up_since_a_restart_asks_for_setup() {
    let f = Fixture::new();
    let route = Route {
        session: f.key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    // Any answer will do: the call starts the session's worker.
    let _ = f
        .module
        .tool(&route, "ctx_reduce", serde_json::json!({}))
        .await;
    assert!(f.module.inner.workers.lock().unwrap().contains_key(&f.key));
    assert_eq!(
        f.notice(1, Some(LIVE), Some(4), "model"),
        NoticeAnswer::SetupRequired
    );
    for (epoch, stamp) in [(Some(LIVE), Some(4)), (Some(LIVE), None), (None, Some(4))] {
        let refused = f.ride(epoch, stamp, "model").await;
        assert!(
            matches!(refused, Err(ModuleError::UnknownSession)),
            "{epoch:?}, {stamp:?}: {refused:?}"
        );
    }
    let unordered = f.ride(None, None, "model").await;
    assert!(unordered.is_ok(), "{unordered:?}");
}

/// A Setup records its epoch and queues its job under the lock a notice or
/// ride is checked and queued under, so no statement checked against the
/// epoch it replaces can be queued behind it, and of two Setups racing the
/// one queued last is the one recorded. While another thread holds that
/// lock, a Setup is not queued: the worker still holds the earlier Setup's
/// conditions. Once the lock is released, the Setup is queued and recorded
/// together, and the session's own notices under its epoch are taken.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn epoch_a_setup_is_recorded_and_queued_under_one_lock() {
    let f = Fixture::new();
    f.setup(Some("first"));
    assert_eq!(f.taken_model().await, "model");
    let module = f.module.clone();
    let route = Route {
        session: f.key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "second-model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    )
    .with_statement_order("second", 1, true)
    .unwrap();
    let saved_model = || {
        f.module
            .inner
            .store
            .as_ref()
            .unwrap()
            .load(&f.key)
            .and_then(|durable| durable.compaction)
            .map(|(_, conditions)| conditions.model.model)
    };
    let held = f.module.inner.set_up.lock().unwrap();
    let setup = std::thread::spawn(move || module.setup(route, request));
    // Long enough for the Setup's job to be handled, had it been queued.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        saved_model().as_deref(),
        Some("model"),
        "the Setup was queued while another thread held the lock"
    );
    drop(held);
    assert_eq!(setup.join().unwrap().unwrap(), SetupAnswer::Ready);
    assert_eq!(f.held_epoch(), Some(Some("second".to_owned())));
    assert_eq!(f.taken_model().await, "second-model");
    assert_eq!(
        f.notice(1, Some("second"), Some(2), "after"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "after");
}

/// The contract's vectors through `Module`: after the restore's Setup, a
/// notice and a ride of the replaced epoch are dropped and answered, and
/// the restored epoch's first notice, numbered 1, is taken.
#[tokio::test]
async fn epoch_the_contract_vectors_old_epoch_is_dropped_through_the_module() {
    fn params<T: serde::de::DeserializeOwned>(body: &str) -> T {
        let (_, params) = cortexkit_role_compaction::wire::decode(body.as_bytes()).unwrap();
        cortexkit_role_compaction::wire::params(params).unwrap()
    }
    let old_notice: NoticeRequest = params(include_str!(
        "../testdata/compaction-v2-statement-seq/notice-statement-seq-request.json"
    ));
    let old_ride: RideRequest = params(include_str!(
        "../testdata/compaction-v2-statement-seq/ride-statement-seq-request.json"
    ));
    let restored: SetupRequest = params(include_str!(
        "../testdata/compaction-v2-statement-seq/setup-statement-seq-restored-request.json"
    ));
    let first: NoticeRequest = params(include_str!(
        "../testdata/compaction-v2-statement-seq/notice-statement-seq-restored-request.json"
    ));
    let f = Fixture::new();
    f.setup(old_notice.conditions.statement_epoch.as_deref());
    f.setup(restored.statement_epoch.as_deref());
    assert_eq!(
        f.module.notice(&f.key, old_notice).unwrap(),
        NoticeAnswer::SetupRequired
    );
    assert!(matches!(
        f.module.ride(&f.key, old_ride).await,
        Err(ModuleError::UnknownSession)
    ));
    assert_eq!(
        f.module.notice(&f.key, first).unwrap(),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "example-model");
}

#[path = "statement_order_review2_tests.rs"]
mod statement_order_review2_tests;
