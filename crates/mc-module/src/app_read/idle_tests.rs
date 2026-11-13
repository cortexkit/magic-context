use super::*;
use crate::client::{Child, ClientError};
use crate::context_db::StoredCompartment;
use crate::module::Module;
use crate::pass::Settings;
use crate::routing::Router;
use cortexkit_role_compaction::{
    notice::{Conditions, NoticeAnswer, NoticeRequest},
    read::{ReadPage, ReadRequest},
    ride::{RideAnswer, RideRequest},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::{ModelRef, SetupAnswer, SetupRequest},
    view::{ApplyViewAnswer, ApplyViewRequest, Edit, View},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};
use mc_mock_runner::{
    model::Kind,
    runner::{CallError, Host, MovedIn, Provider, Runner, SessionConfig, UserEdit},
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct NoopProvider;
impl Provider for NoopProvider {
    async fn setup(&self, _: SetupRequest) -> Result<SetupAnswer, CallError> {
        Ok(SetupAnswer::Ready)
    }
    async fn notice(&self, _: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        unreachable!()
    }
    async fn ride(&self, _: RideRequest) -> Result<RideAnswer, CallError> {
        unreachable!()
    }
    async fn tool(&self, _: &str, _: &Value) -> Result<String, CallError> {
        unreachable!()
    }
    async fn pre_user(&self, _: &str, _: u64) -> Result<UserEdit, CallError> {
        unreachable!()
    }
}

#[derive(Clone)]
struct Client {
    host: Host,
    calls: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
}

impl RunnerClient for Client {
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode.load(Ordering::SeqCst) {
            2 => return std::future::pending().await,
            3 => return Err(ClientError::new("route unavailable")),
            _ => {}
        }
        let mut answer = self.host.applied_view();
        // The in-process mock has no daemon plan owner. Supply the owner that
        // the real runner includes with its applied-view response.
        answer.applied_by = answer.view.as_ref().map(|_| {
            if self.mode.load(Ordering::SeqCst) == 1 {
                "another-provider".into()
            } else {
                crate::MODULE_ID.into()
            }
        });
        if self.mode.load(Ordering::SeqCst) == 4 {
            if let Some(view) = answer.view.as_mut() {
                view.version += 1;
            }
        }
        Ok(answer)
    }
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        panic!("an idle head read must not load the transcript")
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        panic!("an idle head read must not publish a view")
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

fn cold_replica(fixture: &Fixture) -> Replica {
    let mut replica = super::super::tests::replica(None);
    replica.snapshots.clear();
    replica.store = Some(
        Connection::open_with_flags(
            fixture.dir.path().join("mode3.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap(),
    );
    replica.load();
    replica
}

#[tokio::test]
async fn idle_keep_expires_refetches_and_changed_runner_version_restarts_the_window() {
    let fixture = Fixture::new(true, false, true, "head").await;
    let mut replica = cold_replica(&fixture);
    let params = json!({"session":fixture.key,"view":7,"slot":"baseline","section":0});
    let answer = fixture.client.applied_view(&fixture.key).await.unwrap();
    replica
        .runner_head("context.head_section", &params, answer)
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            replica
                .kept_head(&fixture.key, "context.head_section", &params)
                .unwrap()
                .unwrap()["text"],
            fixture.text
        );
    }
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
    replica
        .idle_heads
        .borrow_mut()
        .get_mut(&fixture.key)
        .unwrap()
        .used -= std::time::Duration::from_secs(61);
    assert!(replica
        .kept_head(&fixture.key, "context.head_section", &params)
        .is_none());
    let answer = fixture.client.applied_view(&fixture.key).await.unwrap();
    replica
        .runner_head("context.head_section", &params, answer)
        .unwrap();
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 2);
    // A requested version missing from the cache must ask the runner rather
    // than reject a window that may have just observed a newer view.
    let newer = json!({"session":fixture.key,"view":8,"slot":"baseline","section":0});
    assert!(replica
        .kept_head(&fixture.key, "context.head_section", &newer)
        .is_none());
    fixture.client.mode.store(4, Ordering::SeqCst);
    let answer = fixture.client.applied_view(&fixture.key).await.unwrap();
    assert_eq!(
        replica
            .runner_head("context.head_section", &params, answer)
            .unwrap_err()
            .code,
        "head_changed"
    );
    assert_eq!(
        replica
            .kept_head(&fixture.key, "context.head_section", &newer)
            .unwrap()
            .unwrap()["view"],
        8
    );
}

#[tokio::test]
async fn idle_keep_is_lru_bounded_and_released_on_setup_and_forget() {
    let fixture = Fixture::new(true, false, true, "head").await;
    let mut replica = cold_replica(&fixture);
    let params = json!({"session":fixture.key});
    replica
        .runner_head(
            "context.head",
            &params,
            fixture.client.applied_view(&fixture.key).await.unwrap(),
        )
        .unwrap();
    let kept = replica
        .idle_heads
        .borrow_mut()
        .remove(&fixture.key)
        .unwrap();
    for n in 0..4 {
        let key = SessionRef::new("mock-runner", "mock", format!("extra-{n}"));
        replica.idle_heads.borrow_mut().insert(
            key,
            KeptHead {
                state: kept.state.clone(),
                breakdown: kept.breakdown.clone(),
                used: std::time::Instant::now() - std::time::Duration::from_secs(4 - n),
            },
        );
    }
    replica
        .runner_head(
            "context.head",
            &params,
            fixture.client.applied_view(&fixture.key).await.unwrap(),
        )
        .unwrap();
    assert_eq!(replica.idle_heads.borrow().len(), 4);
    assert!(!replica.idle_heads.borrow().contains_key(&SessionRef::new(
        "mock-runner",
        "mock",
        "extra-0"
    )));
    let snapshot = replica.snapshots.get(&fixture.key).unwrap().clone();
    let mut live = kept.state;
    let answer = fixture.client.applied_view(&fixture.key).await.unwrap();
    let mut view = answer.view.unwrap();
    view.version = 9;
    live.record(&view, None, "provider/model");
    replica.update(Update {
        key: fixture.key.clone(),
        header: Arc::new(Header {
            base: snapshot.base,
            newest: snapshot.newest,
            ready: snapshot.ready,
            meta: snapshot.meta,
            breakdown: snapshot.breakdown,
        }),
        rows: vec![],
        reset_from: None,
        prune_before: None,
        compartments: None,
        decisions: None,
        reverted: false,
        head: live,
    });
    assert!(!replica.idle_heads.borrow().contains_key(&fixture.key));
    let result = replica
        .runner_head(
            "context.head",
            &params,
            fixture.client.applied_view(&fixture.key).await.unwrap(),
        )
        .unwrap();
    assert_eq!(
        result["as_of"]["view"], 9,
        "Setup wins over an in-flight idle answer"
    );
    assert!(!replica.idle_heads.borrow().contains_key(&fixture.key));
    replica.heads.clear();
    replica
        .runner_head(
            "context.head",
            &params,
            fixture.client.applied_view(&fixture.key).await.unwrap(),
        )
        .unwrap();
    replica.forget_head(&fixture.key);
    assert!(!replica.idle_heads.borrow().contains_key(&fixture.key));
}

#[tokio::test]
async fn idle_legacy_baseline_does_not_claim_zero_summaries() {
    let fixture = Fixture::new(true, false, true, "head").await;
    let conn = Connection::open(fixture.dir.path().join("mode3.db")).unwrap();
    conn.execute(
        "UPDATE sessions SET state=json_set(state,'$.baseline.summary_items',json('[]'))",
        [],
    )
    .unwrap();
    let result = fixture.read().await.unwrap();
    assert!(result["messages"][0]["sections"][0].get("items").is_none());
    assert_eq!(fixture.section().await.unwrap()["text"], fixture.text);
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
    client: Client,
    key: SessionRef,
    dir: tempfile::TempDir,
    text: String,
}

impl Fixture {
    async fn new(has_view: bool, mismatch: bool, has_projection: bool, preset: &str) -> Self {
        Self::with_history(has_view, mismatch, has_projection, preset, true).await
    }

    async fn with_history(
        has_view: bool,
        mismatch: bool,
        has_projection: bool,
        preset: &str,
        has_history: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let key = SessionRef::new("mock-runner", "mock", "idle-head");
        let model = ModelRef::new("provider", "model");
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let summaries = if has_history {
            vec![StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 2,
                title: "Earlier work".into(),
                content: "The exact saved summary.".into(),
                importance: 90,
                ..Default::default()
            }]
        } else {
            Vec::new()
        };
        let inputs = crate::summary::head::Inputs {
            counter: crate::count::Counter::for_model(Some("provider/model")),
            summaries: &summaries,
            docs: "",
            rows: &[],
            classes: &std::collections::HashMap::new(),
            now_ms: 0,
            workspace: None,
            gone: &[],
            history_budget_tokens: 10000,
            history_local_budget_tokens: 10000,
            memory_budget_tokens: 1000,
            profile_budget_tokens: 1000,
        };
        let baseline = crate::summary::head::fold(&inputs, None);
        let (delta, baseline, _) = crate::summary::head::delta(&baseline, &inputs);
        let text = baseline.m0.clone();
        let view = View::seal(
            7,
            crate::summary::head::head_ops(&text, &delta, None)
                .into_iter()
                .map(|op| Edit::new(7, op))
                .collect(),
        );
        let baseline = if mismatch {
            crate::summary::head::Baseline {
                m0: "<session-history></session-history>".into(),
                ..Default::default()
            }
        } else {
            baseline
        };
        let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
        store
            .save(
                &key,
                &crate::store::Durable {
                    preset: Some(preset.into()),
                    compaction: Some((
                        crate::preset::features(preset).unwrap(),
                        Conditions::new(model.clone(), 100000, 1000, rules.clone()),
                    )),
                    version: 7,
                    newest_applied: 7,
                    baseline: Some(Arc::new(baseline)),
                    ..Default::default()
                },
            )
            .unwrap();
        if has_projection {
            let mut snapshot = crate::session::Session::app_sample_snapshot();
            snapshot.key = key.clone();
            store.save_app_snapshot(&snapshot).unwrap();
        }
        let config = SessionConfig {
            session: key.clone(),
            preset: preset.into(),
            model,
            context_window: 100000,
            output_reserve: 1000,
            rules,
            kind: Kind::OpenAi,
            cache_ttl_ms: 300000,
            system_tokens: 100,
            tag_checkpoint: 0,
            start_ms: 1000,
            project: None,
            model_latency_ms: 0,
            moved_in: has_view.then_some(MovedIn {
                messages: vec![],
                view,
            }),
            templates: vec![],
            accepts_images: None,
            view_anchor: true,
        };
        let runner = Runner::start(config, NoopProvider).await.unwrap();
        let client = Client {
            host: runner.host().clone(),
            calls: Arc::new(AtomicUsize::new(0)),
            mode: Arc::new(AtomicUsize::new(0)),
        };
        let module = Module::new(client.clone(), Settings::default(), None, Some(store));
        Self {
            module,
            client,
            key,
            dir,
            text,
        }
    }
    async fn read(&self) -> Result<Value, Refusal> {
        self.module
            .app_request("context.head", json!({"session":self.key}))
            .await
    }
    async fn section(&self) -> Result<Value, Refusal> {
        self.module
            .app_request(
                "context.head_section",
                json!({"session":self.key,"view":7,"slot":"baseline","section":0,"max_bytes":1024}),
            )
            .await
    }
    fn stored(&self) -> String {
        let conn = Connection::open_with_flags(
            self.dir.path().join("mode3.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.query_row("SELECT state FROM sessions", [], |row| row.get(0))
            .unwrap()
    }
}

#[tokio::test]
async fn idle_applied_head_and_two_section_reads_share_one_runner_answer() {
    let fixture = Fixture::new(true, false, true, "head").await;
    let stored = fixture.stored();
    for _ in 0..2 {
        let result = fixture.read().await.unwrap();
        assert_eq!(result["as_of"]["view"], 7);
        assert_eq!(result["as_of"]["applied"], true);
        assert_eq!(result["as_of"]["step_ref"], "m3");
        assert_eq!(fixture.section().await.unwrap()["text"], fixture.text);
        assert_eq!(
            result["messages"][0]["sections"][0]["items"][0]["compartment_id"],
            "1"
        );
    }
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.stored(), stored);
    assert_eq!(fixture.client.host.applied_version(), Some(7));
}

#[tokio::test]
async fn idle_adopted_head_from_a_different_fold_keeps_text_without_summary_items() {
    let fixture = Fixture::new(true, true, true, "head").await;
    let result = fixture.read().await.unwrap();
    assert_eq!(fixture.section().await.unwrap()["text"], fixture.text);
    assert!(result["messages"][0]["sections"][0].get("items").is_none());
}

#[tokio::test]
async fn idle_baseline_without_summaries_has_an_explicit_empty_attribution() {
    let fixture = Fixture::with_history(true, false, true, "head", false).await;
    let result = fixture.read().await.unwrap();
    assert_eq!(result["messages"][0]["sections"][0]["kind"], "history");
    assert_eq!(result["messages"][0]["sections"][0]["items"], json!([]));
    assert_eq!(fixture.section().await.unwrap()["text"], fixture.text);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn idle_no_view_covers_heads_workers_readers_and_missing_projections() {
    for preset in ["head", "worker", "reader"] {
        let fixture = Fixture::new(false, false, false, preset).await;
        let result = fixture.read().await.unwrap();
        assert_eq!(result["managed"], true);
        assert!(result["messages"].as_array().unwrap().is_empty());
        assert!(result["as_of"]["view"].is_null());
        assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn idle_foreign_view_and_unreachable_route_are_retryable() {
    let fixture = Fixture::new(true, false, true, "head").await;
    for mode in [1, 3] {
        fixture.client.mode.store(mode, Ordering::SeqCst);
        assert_eq!(fixture.read().await.unwrap_err(), head::not_ready());
    }
    let unknown = SessionRef::new("mock-runner", "mock", "absent");
    assert_eq!(
        fixture
            .module
            .app_request("context.head", json!({"session":unknown}))
            .await
            .unwrap_err()
            .code,
        "session_not_found"
    );
    assert_eq!(
        fixture.client.calls.load(Ordering::SeqCst),
        2,
        "unknown sessions never contact the runner"
    );
}

#[tokio::test(start_paused = true)]
async fn idle_silent_runner_stops_at_the_three_second_deadline() {
    let fixture = Fixture::new(true, false, true, "head").await;
    fixture.client.mode.store(2, Ordering::SeqCst);
    let started = tokio::time::Instant::now();
    let result = fixture.read().await;
    assert_eq!(result.unwrap_err(), head::not_ready());
    assert_eq!(started.elapsed(), RUNNER_HEAD_DEADLINE);
    assert_eq!(fixture.client.calls.load(Ordering::SeqCst), 1);
}
