//! ck-mc against the mock runner, in process. The mock runner and its mock
//! model providers enforce what real ones do (prompt caching, signed
//! reasoning, the window), so a scenario fails here the way it would fail on
//! a real runner. The wire suite (`wire.rs`) runs them through a real subc
//! daemon, the module bus that routes calls between module processes; here each notice is handled before the runner's next step, which
//! keeps the assertions exact.

use std::sync::{Arc, Mutex};

use cortexkit_role_compaction::notice::{NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::ride::{RideAnswer, RideCause, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{CallError, Host, Provider, Runner, SessionConfig, UserEdit};
use mc_mock_runner::script::{Step, ToolCall, Turn};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::lanes::placeholder;
use mc_module::module::{Module, ModuleError};
use mc_module::pass::Settings;
use mc_module::route::{Project as RouteProject, Route};
use mc_module::routing::{RouteError, Router};
use mc_module::store::Store;
use serde_json::{json, Value};

#[path = "support/lifecycle_scenarios.rs"]
mod lifecycle_scenarios;

/// ck-mc's calls back into the mock runner. The runner exists only after its
/// Setup call, so the host is attached right after it starts.
/// A catch-up read: the ordinal it read after, and how many entries it got.
type ReadLog = Arc<Mutex<Vec<(Option<u64>, usize)>>>;

#[derive(Clone, Default)]
struct HostClient {
    host: Arc<Mutex<Option<Host>>>,
    /// Every catch-up read ck-mc made (compact detail).
    reads: ReadLog,
    /// The stand-in routing provider's log: every select's request and every
    /// report.
    routing: Arc<Mutex<RoutingLog>>,
    /// How many of the next views handed over the runner refuses, as a
    /// runner whose state moved on would.
    refuse_views: Arc<Mutex<u32>>,
    /// The version of every view handed over, refused or not.
    offered: Arc<Mutex<Vec<u64>>>,
    /// The checksum of every view handed over, by version, the latest kept.
    offered_checksums: Arc<Mutex<std::collections::BTreeMap<u64, Vec<String>>>>,
    /// The project folder of every summarizer child send, for its scope.
    child_scopes: Arc<Mutex<Vec<Option<String>>>>,
    /// What the stand-in Entorhinal answers `context.project` with (the
    /// reply's `result`); without one it does not answer.
    entorhinal: Arc<Mutex<Option<Value>>>,
    /// Every Entorhinal read ck-mc made: its method and folder or agent.
    entorhinal_reads: Arc<Mutex<Vec<(String, String)>>>,
    /// When set, each view handed over first copies ck-mc's store from this
    /// folder to `store-at-<version>.db` there: the store as a crash right
    /// after the hand-over would leave it.
    snapshot_store: Arc<Mutex<Option<std::path::PathBuf>>>,
    pause_reads: Arc<Mutex<Option<Arc<tokio::sync::Semaphore>>>>,
    read_started: Arc<tokio::sync::Notify>,
    pause_children: Arc<Mutex<Option<Arc<tokio::sync::Semaphore>>>>,
    child_started: Arc<tokio::sync::Notify>,
}

/// What ck-mc asked the stand-in routing provider, and what it answers.
#[derive(Default)]
struct RoutingLog {
    selects: Vec<cortexkit_role_routing::select::SelectRequest>,
    reports: Vec<cortexkit_role_routing::report::ReportRequest>,
    /// Route keys it answers in turn; the session's model when empty.
    routes: Vec<String>,
    /// Answer every select with `no_route`.
    no_route: bool,
}

impl HostClient {
    fn host(&self) -> Result<Host, ClientError> {
        self.host
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ClientError("runner not attached".into()))
    }
}

/// A stand-in for the routing provider. It answers the session's own model,
/// or the next of `routes`, with a 400k-token window: the sessions here have
/// small windows to reach the thresholds in a few steps, and the summarizer's
/// prompt needs a real one.
impl Router for HostClient {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let mut log = self.routing.lock().unwrap();
        log.selects.push(request.clone());
        if log.no_route {
            return Err(RouteError {
                code: "no_route".into(),
                message: "nothing fits".into(),
            });
        }
        let excluded = request.exclude.clone().unwrap_or_default();
        let key = if log.routes.is_empty() {
            "test/test-model".to_owned()
        } else {
            match log.routes.iter().find(|key| !excluded.contains(key)) {
                Some(key) => key.clone(),
                None => {
                    return Err(RouteError {
                        code: "no_route".into(),
                        message: "every route excluded".into(),
                    })
                }
            }
        };
        let (provider, model) = key.split_once('/').unwrap();
        let route = RouteRef::new(provider, model);
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        let decision = format!("d{}", log.selects.len());
        Ok(SelectAnswer::new(
            decision,
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }

    async fn report(&self, request: ReportRequest) {
        self.routing.lock().unwrap().reports.push(request);
    }
}

/// A request as the runner decodes it from its JSON.
fn through_wire<T: serde::Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    serde_json::from_value(serde_json::to_value(value).expect("requests serialize"))
        .expect("the runner decodes what ck-mc sends")
}

/// An llm-runner answer as ck-mc reads it: wrapped as `{"result": …}`.
fn read_wrapped<T: serde::Serialize, A: serde::de::DeserializeOwned>(
    answer: &T,
) -> Result<A, ClientError> {
    let body = cortexkit_role_llm_runner::wire::reply_body(answer).expect("answers serialize");
    cortexkit_role_llm_runner::wire::read_reply(&body)
        .map_err(|error| ClientError(format!("{error:?}")))
}

impl RunnerClient for HostClient {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let pause = self.pause_reads.lock().unwrap().clone();
        if let Some(pause) = pause {
            self.read_started.notify_one();
            pause.acquire().await.unwrap().forget();
        }
        let page = self
            .host()?
            .read(&request)
            .map_err(|refusal| ClientError(format!("{refusal:?}")))?;
        if let (
            cortexkit_role_compaction::read::Detail::Compact,
            cortexkit_role_compaction::read::Select::After { after_ordinal, .. },
        ) = (&request.detail, &request.select)
        {
            self.reads
                .lock()
                .unwrap()
                .push((*after_ordinal, page.entries.len()));
        }
        Ok(page)
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.offered.lock().unwrap().push(request.view.version);
        self.offered_checksums
            .lock()
            .unwrap()
            .entry(request.view.version)
            .or_default()
            .push(request.view.checksum.clone());
        if let Some(dir) = self.snapshot_store.lock().unwrap().clone() {
            let snapshot = dir.join(format!("store-at-{}.db", request.view.version));
            let _ = std::fs::remove_file(&snapshot);
            rusqlite::Connection::open(dir.join("mode3.db"))
                .unwrap()
                .execute("VACUUM INTO ?1", [snapshot.to_string_lossy()])
                .unwrap();
        }
        {
            let mut refuse = self.refuse_views.lock().unwrap();
            if *refuse > 0 {
                *refuse -= 1;
                return Ok(ApplyViewAnswer::Refused {
                    refusal: cortexkit_role_compaction::view::ViewRefusal::BadSince,
                });
            }
        }
        Ok(self.host()?.apply_view(request))
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(self.host()?.applied_view())
    }

    // Sends and runs go through their wire form, as llm-runner carries
    // them, so the scenarios check the shapes ck-mc sends and reads: the run
    // parameters beside llm-runner's fields, and answers wrapped as
    // `{"result": …}`.
    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        let request: SendRequest = through_wire(&request);
        let reply = self
            .host()?
            .send(&session.session, request)
            .map_err(|refusal| ClientError(format!("{refusal:?}")))?;
        read_wrapped(&reply)
    }

    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.child_scopes
            .lock()
            .unwrap()
            .push(child.project_root.clone());
        self.send(&child.session, request).await
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        let pause = self.pause_children.lock().unwrap().clone();
        if let Some(pause) = pause {
            self.child_started.notify_one();
            pause.acquire().await.unwrap().forget();
        }
        let request: RunResultRequest = through_wire(&request);
        let result = self
            .host()?
            .run_result(&request)
            .ok_or_else(|| ClientError(format!("unknown run {}", request.run_id)))?;
        read_wrapped(&result)
    }

    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, mc_module::client::EntorhinalRefusal>> {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let method = request["method"].as_str().unwrap().to_owned();
        let subject = request["params"]["folder"]
            .as_str()
            .or(request["params"]["agent_id"].as_str())
            .unwrap_or_default()
            .to_owned();
        self.entorhinal_reads
            .lock()
            .unwrap()
            .push((method.clone(), subject));
        let result = self.entorhinal.lock().unwrap().clone()?;
        (method == "context.project")
            .then(|| Ok(serde_json::to_vec(&json!({"result": result})).unwrap()))
    }
}

/// ck-mc in process, as the runner's routes for one session reach it: every
/// call concerns `route`, which a real transport takes from the route.
struct InProcess {
    module: Mutex<Module<HostClient>>,
    route: Route,
    client: HostClient,
    settings: Settings,
    /// A scratch folder for the stores, when the scenario keeps them.
    stores: Option<std::path::PathBuf>,
    /// Whether a person's messages go through ck-mc's `pre_user`. Off for
    /// scenarios about other things, whose transcripts it would change.
    pre_user: bool,
    /// Crash after a keep call is saved but before its next notice.
    restart_after_keep: Mutex<bool>,
}

impl InProcess {
    fn module(&self) -> Module<HostClient> {
        self.module.lock().unwrap().clone()
    }

    fn new_module(
        client: HostClient,
        settings: Settings,
        stores: Option<&std::path::Path>,
    ) -> Module<HostClient> {
        let (db, store) = match stores {
            Some(dir) => {
                let db_path = dir.join("context.db");
                let db = if db_path.exists() {
                    ContextDb::open(&db_path).unwrap()
                } else {
                    ContextDb::create_for_tests(&db_path).unwrap()
                };
                (Some(db), Some(Store::open(&dir.join("mode3.db")).unwrap()))
            }
            None => (None, None),
        };
        Module::new(client, settings, db, store)
    }

    /// ck-mc restarts: a new process with the same stores, and no sessions
    /// until runners call Setup again.
    fn restart(&self) {
        self.restart_with(self.settings.clone());
    }

    /// Restart ck-mc on the stores in `dir` instead of its own, as after a
    /// crash that left them as they are there.
    fn restart_from(&self, dir: &std::path::Path) {
        *self.module.lock().unwrap() =
            Self::new_module(self.client.clone(), self.settings.clone(), Some(dir));
    }

    /// Restart ck-mc with different settings, as after a config edit.
    fn restart_with(&self, settings: Settings) {
        *self.module.lock().unwrap() =
            Self::new_module(self.client.clone(), settings, self.stores.as_deref());
    }
}

fn call_error(error: ModuleError) -> CallError {
    use cortexkit_role_compaction::wire::codes;
    match error {
        ModuleError::Tool(text) => CallError::new(text),
        ModuleError::UnknownPreset(preset) => CallError::refused(codes::UNKNOWN_PRESET, preset),
        ModuleError::UnknownSession => CallError::refused(codes::UNKNOWN_SESSION, "no Setup"),
        other => CallError::new(format!("{other:?}")),
    }
}

impl Provider for InProcess {
    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.module()
            .setup(self.route.clone(), request)
            .map_err(call_error)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        let session = &self.route.session;
        let module = self.module();
        let answer = module.notice(session, request).map_err(call_error)?;
        if answer == NoticeAnswer::Received {
            module.idle(session).await.map_err(call_error)?;
        }
        Ok(answer)
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.module()
            .ride(&self.route.session, request)
            .await
            .map_err(call_error)
    }

    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        let answer = self
            .module()
            .tool(&self.route, name, input.clone())
            .await
            .map_err(call_error);
        let restart =
            name == "ctx_keep" && std::mem::take(&mut *self.restart_after_keep.lock().unwrap());
        if restart {
            self.module()
                .idle(&self.route.session)
                .await
                .map_err(call_error)?;
            self.restart();
        }
        answer
    }

    async fn pre_user(&self, text: &str, now: u64) -> Result<UserEdit, CallError> {
        if !self.pre_user {
            return Ok(UserEdit::default());
        }
        let answer = self.module().pre_user(&self.route.session, text, now).await;
        Ok(UserEdit {
            prepend: answer.prepend,
            append: answer.append,
        })
    }
}

fn free() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn bound() -> ProviderRules {
    ProviderRules::new(SignedParts::Bound, EditCost::Suffix)
}

/// A session whose usable window is 39,000 tokens, so the execute threshold
/// (65%) sits at 25,350. A head's is 99,000 tokens (threshold 64,350): the
/// summarizer reads at most a quarter of the usable window per run, and at
/// least 6,000 tokens before it runs early, so a head needs room for turns
/// whose tool output fits that range ([`turn`]).
fn config(preset: &str, kind: Kind, rules: ProviderRules) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: preset.into(),
        model: ModelRef::new("test", "test-model"),
        context_window: if preset == "head" { 100_000 } else { 40_000 },
        output_reserve: 1_000,
        rules,
        kind,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        // The plan admits ck-mc's reminder templates, as core composes it.
        templates: mc_module::nudges::templates(),
    }
}

async fn start(config: SessionConfig) -> Runner<InProcess> {
    start_with(config, Settings::default()).await
}

async fn start_with(config: SessionConfig, settings: Settings) -> Runner<InProcess> {
    start_full(config, settings, None).await
}

/// A scenario whose ck-mc keeps its stores in `stores`, so it can restart.
async fn start_full(
    config: SessionConfig,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
) -> Runner<InProcess> {
    start_runner(config, settings, stores, false).await
}

async fn start_runner(
    config: SessionConfig,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
    pre_user: bool,
) -> Runner<InProcess> {
    start_runner_with(config, settings, stores, pre_user, |_| {}).await
}

/// As [`start_runner`], with the route ck-mc sees changed by `adjust`, for
/// scopes a mock session config cannot describe.
async fn start_runner_with(
    config: SessionConfig,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
    pre_user: bool,
    adjust: impl FnOnce(&mut Route),
) -> Runner<InProcess> {
    start_with_client(
        HostClient::default(),
        config,
        settings,
        stores,
        pre_user,
        adjust,
    )
    .await
}

/// As [`start_runner_with`], with a client the scenario set up first, for
/// stand-ins ck-mc reads at Setup.
async fn start_with_client(
    client: HostClient,
    config: SessionConfig,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
    pre_user: bool,
    adjust: impl FnOnce(&mut Route),
) -> Runner<InProcess> {
    let mut route = Route {
        session: config.session.clone(),
        project: config.project.as_ref().map(|project| RouteProject {
            id: project.id.clone(),
            root: project.root.clone(),
        }),
        workdir: config.project.as_ref().map(|project| project.root.clone()),
        agent_id: None,
    };
    adjust(&mut route);
    let provider = InProcess {
        route,
        module: Mutex::new(InProcess::new_module(
            client.clone(),
            settings.clone(),
            stores.as_deref(),
        )),
        client,
        settings,
        stores,
        pre_user,
        restart_after_keep: Mutex::new(false),
    };
    let runner = Runner::start(config, provider).await.unwrap();
    *runner.provider().client.host.lock().unwrap() = Some(runner.host().clone());
    runner
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

/// A step that reads a file: some reasoning, a sentence (one tag), and a
/// `read` call whose result is about 7,000 tokens (one tag). Four such
/// results take a session past its execute threshold.
fn read_file(reasoning: u64) -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(reasoning),
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(28_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn reduce(spec: &str) -> Step {
    Step::Model(Turn {
        text: Some("Those reads are done.".into()),
        tools: vec![ToolCall::ok("ctx_reduce", json!({"drop": spec}), "")],
        output_tokens: 10,
        ..Turn::default()
    })
}

fn answer() -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        output_tokens: 5,
        ..Turn::default()
    })
}

/// The start of the text the model sees for the part numbered `tag`, cut
/// short so a failed comparison stays readable.
fn seen(host: &Host, tag: u64) -> Option<String> {
    host.rendered().iter().find_map(|message| {
        message
            .parts
            .iter()
            .find(|part| part.tag == Some(tag))
            .and_then(|part| message.wire_text(part))
            .map(|text| text.chars().take(60).collect())
    })
}

fn assert_clean(runner: &Runner<InProcess>) {
    let report = &runner.report;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    assert!(
        report.view_refusals.is_empty(),
        "{:?}",
        report.view_refusals
    );
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
}

#[tokio::test]
async fn a_worker_lands_its_queued_drops_on_the_first_execute_pass() {
    // Tags: the task is 1; each read step adds a sentence and a call (2/3,
    // 4/5, 6/7, 8/9); the ctx_reduce step is 10/11.
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            read_file(50),
            reduce("3,5"),
            read_file(50),
            read_file(50),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let host = runner.host();
    // Recent calls with small inputs keep their arguments; only the result
    // becomes the placeholder, with no tag prefix in front of it.
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));
    assert_eq!(seen(host, 5).as_deref(), Some(placeholder(5).as_str()));
    assert_eq!(host.applied_version(), Some(1));

    // One view, so one rewrite: the first request under it reads less than
    // its predecessor sent, and the next one reads all of the first again.
    let requests = &runner.report.requests;
    let first = requests
        .iter()
        .position(|record| record.view == Some(1))
        .unwrap();
    assert!(requests[first].usage.cache_read_tokens < requests[first - 1].usage.prompt_tokens);
    assert!(requests[first].usage.prompt_tokens < requests[first - 1].usage.prompt_tokens);
    assert_eq!(
        requests[first + 1].usage.cache_read_tokens,
        requests[first].usage.prompt_tokens
    );
}

/// Read steps whose sentences (tags 2 and 4) the model then asks to drop.
fn reads_then_drop_sentences() -> Vec<Step> {
    vec![
        user("Review the module."),
        read_file(50),
        read_file(50),
        reduce("2,4"),
        read_file(50),
        read_file(50),
        answer(),
        answer(),
        answer(),
    ]
}

#[tokio::test]
async fn a_refused_view_keeps_its_queued_drops_for_the_next_and_its_version_is_not_reused() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    *runner.provider().client.refuse_views.lock().unwrap() = 1;
    runner.play(&reads_then_drop_sentences()).await;
    assert_clean(&runner);
    let offered = runner.provider().client.offered.lock().unwrap().clone();
    // The refused view was version 1; the next is 2, never 1 again.
    assert_eq!(offered[..2], [1, 2], "{offered:?}");
    let host = runner.host();
    assert_eq!(host.applied_version(), Some(*offered.last().unwrap()));
    // The drops the refused view carried landed with the next one.
    assert_eq!(seen(host, 2).as_deref(), Some(placeholder(2).as_str()));
    assert_eq!(seen(host, 4).as_deref(), Some(placeholder(4).as_str()));
}

/// A view the runner takes and then refuses at its step boundary is undone
/// in ck-mc too (spec 4, WK3 and NT3). Here the runner refuses every view
/// that drops tag 2. Kept as applied, the refused view's drop would be
/// carried into every later view and refused with it, so no view would ever
/// land again. Undone, its drops are queued again, forgotten after a second
/// refusal (spec 2, QD7), and a later drop lands.
#[tokio::test]
async fn a_view_refused_at_the_step_boundary_is_undone_so_later_views_land() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner.host().refuse_tag_at_boundary(2);
    runner.play(&reads_then_drop_sentences()).await;
    runner
        .play(&[read_file(50), answer(), answer(), answer()])
        .await;
    let refusals = runner.report.view_refusals.len();
    assert!(refusals >= 1, "the runner never refused a view");
    let host = runner.host();
    assert!(host.applied_version().is_some(), "no view ever landed");
    assert_eq!(seen(host, 2).as_deref(), Some("§2§ Reading the next file."));
}

#[tokio::test]
async fn a_queued_drop_two_refused_views_carried_is_forgotten() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    *runner.provider().client.refuse_views.lock().unwrap() = 2;
    runner.play(&reads_then_drop_sentences()).await;
    runner.play(&[read_file(50), answer(), answer()]).await;
    assert_clean(&runner);
    let host = runner.host();
    // A view after the two refused ones landed, without the drops.
    let offered = runner.provider().client.offered.lock().unwrap().clone();
    assert!(offered.len() >= 3, "{offered:?}");
    assert_eq!(host.applied_version(), offered.last().copied());
    assert_eq!(seen(host, 2).as_deref(), Some("§2§ Reading the next file."));
    assert_eq!(seen(host, 4).as_deref(), Some("§4§ Reading the next file."));
}

#[tokio::test]
async fn an_execute_pass_with_nothing_to_drop_publishes_no_view() {
    // A worker whose task alone (about 28,000 tokens, which a worker never
    // drops) puts it over the execute threshold: every pass may rebuild, but
    // no lane has work, so the cache is never rewritten.
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    let task = format!("Review this. {}", "w".repeat(112_000));
    runner
        .play(&[user(&task), answer(), answer(), answer(), answer()])
        .await;
    assert_clean(&runner);
    assert_eq!(runner.host().applied_version(), None);
    assert!(runner.provider().client.offered.lock().unwrap().is_empty());
    let requests = &runner.report.requests;
    assert!(
        requests[1].usage.prompt_tokens.unwrap() > 25_350,
        "{requests:?}"
    );
    for pair in requests.windows(2) {
        assert_eq!(pair[1].usage.cache_read_tokens, pair[0].usage.prompt_tokens);
    }
}

#[tokio::test]
async fn nothing_lands_below_the_threshold_and_a_worker_never_drops_its_task() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            reduce("1,3"),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    // Below the threshold: queued, not applied, so every request extends the
    // previous one.
    assert_eq!(runner.host().applied_version(), None);
    let requests = &runner.report.requests;
    for pair in requests.windows(2) {
        assert_eq!(pair[1].usage.cache_read_tokens, pair[0].usage.prompt_tokens);
    }

    // Over the threshold the call lands, but the task stays.
    runner
        .play(&[
            read_file(50),
            read_file(50),
            read_file(50),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    assert_eq!(runner.host().applied_version(), Some(1));
    assert_eq!(
        seen(runner.host(), 1).as_deref(),
        Some("§1§ Review the module.")
    );
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
}

#[tokio::test]
async fn drops_before_signed_reasoning_take_the_later_reasoning_with_them() {
    let mut runner = start(config("worker", Kind::Anthropic, bound())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            read_file(50),
            reduce("3"),
            read_file(50),
            read_file(50),
            answer(),
            answer(),
        ])
        .await;
    // The mock provider checks signatures on its own: a view that kept a
    // reasoning part after the dropped read would fail here.
    assert_clean(&runner);
    assert_eq!(runner.host().applied_version(), Some(1));
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
    let reasoning_left = runner
        .host()
        .rendered()
        .iter()
        .flat_map(|message| &message.parts)
        .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
        .count();
    let reasoning_written = runner
        .host()
        .entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
        .count();
    assert!(reasoning_left < reasoning_written);
}

#[tokio::test]
async fn a_cache_loss_lands_queued_drops_below_the_threshold() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    // Three newer reads take the dropped output out of the protected tail;
    // a requested drop inside it would wait (`pendingDropVeto`).
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            reduce("3"),
            read_file(50),
            read_file(50),
            read_file(50),
            Step::Wait { ms: 300_001 },
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let rides = &runner.report.rides;
    assert_eq!(rides.len(), 1);
    assert_eq!(rides[0].causes, [RideCause::CacheExpired]);
    assert!(rides[0].got_view);
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
    // The ride's request rewrote the expired cache anyway; the next one reads
    // all of it.
    let requests = &runner.report.requests;
    let last = requests.len() - 1;
    assert_eq!(
        requests[last].usage.cache_read_tokens,
        requests[last - 1].usage.prompt_tokens
    );
}

/// Reasoning parts the model sees, and how many the transcript holds.
fn reasoning_seen(host: &Host) -> (usize, usize) {
    let count = |parts: &mut dyn Iterator<Item = &cortexkit_role_compaction::part::Part>| {
        parts
            .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
            .count()
    };
    let rendered = host.rendered();
    let seen = count(&mut rendered.iter().flat_map(|message| message.parts.iter()));
    let entries = host.entries();
    let written = count(&mut entries.iter().flat_map(|entry| entry.parts.iter()));
    (seen, written)
}

#[tokio::test]
async fn the_age_sweep_drops_an_output_only_after_it_was_far_behind_on_an_earlier_rebuild() {
    // Reads at tags 3, 5, 7 and 9, each about 7,000 tokens. The request
    // after the fourth read (the fifth request) is the first over the
    // threshold. The pass after it sees 3 and 5 far behind (more than a
    // quarter of the usable window, 9,750 tokens, of newer content) and only
    // records that; the pass after the sixth request drops them, so the
    // seventh request is the first under a view. Reasoning is too small to
    // matter here.
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            read_file(50),
            read_file(50),
            read_file(50),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let requests = &runner.report.requests;
    let first_under_view = requests.iter().position(|record| record.view.is_some());
    assert_eq!(first_under_view, Some(6));
    assert_eq!(requests[6].view, Some(1));
    let host = runner.host();
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));
    assert_eq!(seen(host, 5).as_deref(), Some(placeholder(5).as_str()));
    assert!(seen(host, 7).unwrap().starts_with("§7§ xxx"));
    assert!(seen(host, 9).unwrap().starts_with("§9§ xxx"));
}

#[tokio::test]
async fn reasoning_beyond_the_budget_goes_on_the_first_execute_pass() {
    for (kind, rules) in [(Kind::OpenAi, free()), (Kind::Anthropic, bound())] {
        let settings = Settings {
            keep_reasoning_tokens: 1_000,
            ..Settings::default()
        };
        let mut runner = start_with(config("worker", kind, rules), settings).await;
        runner
            .play(&[
                user("Review the module."),
                read_file(400),
                read_file(400),
                read_file(400),
                read_file(400),
                answer(),
                answer(),
            ])
            .await;
        // The mock providers check every request: under signed reasoning, a
        // view that left a gap before kept reasoning would fail here.
        assert_clean(&runner);
        assert_eq!(runner.host().applied_version(), Some(1), "{kind:?}");
        // The newest reasoning (400) plus the next older (400) fit 1,000; the
        // rest went, as the oldest run.
        assert_eq!(reasoning_seen(runner.host()), (2, 4), "{kind:?}");
    }
}

#[tokio::test]
async fn heavy_signed_thinking_holds_the_view_until_usage_passes_threshold_plus_ten() {
    // Each read step reasons 2,000 tokens, more than the 1,500 that make a
    // step heavy, and adds about 9,000 tokens. The fifth request (about 71%
    // of the usable window) is the first over the 65% threshold, and the
    // sixth is still under the cap of 75%: both passes are held. The seventh
    // (about 94%) releases the hold, so the eighth request is the first
    // under a view. Without the hold the sixth would be.
    let mut runner = start(config("worker", Kind::Anthropic, bound())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(2_000),
            reduce("3"),
            read_file(2_000),
            read_file(2_000),
            answer(),
            read_file(2_000),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let requests = &runner.report.requests;
    let first_under_view = requests.iter().position(|record| record.view.is_some());
    assert_eq!(first_under_view, Some(7));
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
}

/// The arguments the model sees for the tool part numbered `tag`.
fn seen_input(host: &Host, tag: u64) -> Option<Value> {
    host.rendered().iter().find_map(|message| {
        message
            .parts
            .iter()
            .find(|part| part.tag == Some(tag))
            .and_then(|part| match &part.body {
                PartBody::Tool(tool) => Some(tool.input.clone()),
                _ => None,
            })
    })
}

fn step(text: &str, tools: Vec<ToolCall>) -> Step {
    Step::Model(Turn {
        text: Some(text.into()),
        tools,
        output_tokens: 10,
        ..Turn::default()
    })
}

#[tokio::test]
async fn routine_heuristics_land_with_the_first_views() {
    let edit = |old: &str, new: &str| {
        ToolCall::ok(
            "edit",
            json!({"filePath": "c.rs", "oldString": old.repeat(100), "newString": new.repeat(100)}),
            "Edit applied.",
        )
    };
    let lookup = || ToolCall::ok("read", json!({"path": "b.rs"}), "fn b() {}");
    let todo = |n: u64| ToolCall::ok("todowrite", json!({"todos": [n]}), "Todos updated.");
    let mut steps = vec![
        user("Review the module."),
        // Tags 2, 3, 4: the same lookup twice in one message.
        step("Looking twice.", vec![lookup(), lookup()]),
        // Tags 5, 6 and 7, 8: two todo updates; only the newest is kept.
        step("Planning.", vec![todo(1)]),
        step("Replanning.", vec![todo(2)]),
        // Tags 9, 10: a note read.
        step(
            "Checking notes.",
            vec![ToolCall::ok(
                "ctx_note",
                json!({"action": "read"}),
                "No notes.",
            )],
        ),
        // Tags 11, 12 and 13, 14: two edits of the same file.
        step("Editing.", vec![edit("a", "b")]),
        step("Editing again.", vec![edit("c", "d")]),
    ];
    // Push all of that out of the newest 20 owning messages.
    steps.extend((0..22).map(|_| answer()));
    steps.extend([read_file(50), read_file(50), read_file(50), read_file(50)]);
    steps.extend([answer(), answer(), answer()]);
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner.play(&steps).await;
    assert_clean(&runner);
    let host = runner.host();

    // The older duplicate goes whole; the newer stays.
    assert_eq!(seen(host, 3), None);
    assert!(seen(host, 4).unwrap().starts_with("§4§ fn b()"));
    // Spent control-plane outputs: the older todo update and the note read.
    assert_eq!(seen(host, 6).as_deref(), Some(placeholder(6).as_str()));
    assert!(seen(host, 8).unwrap().starts_with("§8§ Todos updated."));
    assert_eq!(seen(host, 10).as_deref(), Some(placeholder(10).as_str()));
    // The older edit keeps its path and the start of each diff.
    assert_eq!(seen(host, 12).as_deref(), Some(placeholder(12).as_str()));
    let marked = seen_input(host, 12).unwrap();
    assert_eq!(marked["filePath"], json!("c.rs"));
    assert_eq!(
        marked["oldString"],
        json!(format!("{}...[truncated]", "a".repeat(40)))
    );
    assert_eq!(
        marked["newString"],
        json!(format!("{}...[truncated]", "b".repeat(40)))
    );
    // The newest edit of the file stays whole.
    assert_eq!(
        seen_input(host, 14).unwrap()["oldString"],
        json!("c".repeat(100))
    );
}

#[tokio::test]
async fn injected_text_leaves_older_messages_and_the_rest_of_each_message_stays() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Review the module."),
            answer(),
            // Tag 3: nothing but an injected reminder.
            user("<system-reminder>Plan mode is active.</system-reminder>"),
            answer(),
            // Tag 5: the user's words with a reminder after them.
            user("Use staging.\n<system-reminder>Output was truncated.</system-reminder>"),
            answer(),
            read_file(50),
            read_file(50),
            read_file(50),
            read_file(50),
            // Tag 15, in the protected tail: left as it is.
            user("Next.\n<system-reminder>Keep going.</system-reminder>"),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let host = runner.host();
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));
    assert_eq!(seen(host, 5).as_deref(), Some("§5§ Use staging."));
    assert!(seen(host, 15).unwrap().contains("<system-reminder>"));
    assert!(seen(host, 1).unwrap().starts_with("§1§ Review the module."));
}

#[tokio::test]
async fn answered_images_go_once_newer_content_is_dropped() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Look at the screen."),
            // Tags 2 and 3: a screenshot, answered at tag 4.
            step(
                "Taking a screenshot.",
                vec![ToolCall::ok("screenshot", json!({}), "Screenshot taken.").with_images(1)],
            ),
            answer(),
            // Tag 5 with a pasted image, answered at tag 6.
            Step::UserWithImages {
                text: "Here is the error.".into(),
                images: 1,
            },
            answer(),
            // Dropping tag 6 makes everything up to it old enough.
            step(
                "Dropping.",
                vec![ToolCall::ok("ctx_reduce", json!({"drop": "6"}), "")],
            ),
            read_file(50),
            read_file(50),
            read_file(50),
            read_file(50),
        ])
        .await;
    // Stop at the first view, before the age sweep takes the screenshot's
    // result whole.
    for _ in 0..5 {
        if runner.host().applied_version().is_some() {
            break;
        }
        runner.play(&[answer()]).await;
    }
    assert_clean(&runner);
    let host = runner.host();
    let rendered = host.rendered();
    let part_with = |tag: u64| {
        rendered
            .iter()
            .flat_map(|message| message.parts.iter())
            .find(|part| part.tag == Some(tag))
            .cloned()
            .unwrap()
    };
    // The screenshot's text stays, with a line for the removed image.
    assert_eq!(
        seen(host, 3).as_deref(),
        Some("§3§ Screenshot taken.\n[image stripped]")
    );
    let PartBody::Tool(tool) = part_with(3).body else {
        panic!("tag 3 is a tool part");
    };
    assert!(tool.attachments.is_empty(), "{:?}", tool.attachments);
    // The pasted image becomes a line of text after the person's words.
    let pasted = rendered
        .iter()
        .find(|message| message.parts.iter().any(|part| part.tag == Some(5)))
        .unwrap();
    assert!(
        pasted
            .parts
            .iter()
            .all(|part| !matches!(part.body, PartBody::File(_))),
        "{:?}",
        pasted.parts
    );
    assert!(pasted.parts.iter().any(|part| part.body
        == PartBody::Text {
            text: "[image stripped]".into()
        }));
    // A result that only lost its images can still be dropped whole later.
    runner.play(&[answer(), answer(), answer()]).await;
    assert_clean(&runner);
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
}

/// A step that runs a shell command whose output is `tokens` tokens.
fn shell(tokens: usize) -> Step {
    step(
        "Running it.",
        vec![ToolCall::ok(
            "bash",
            json!({"command": "make"}),
            "y".repeat(tokens * 4),
        )],
    )
}

fn high_threshold() -> Settings {
    Settings {
        execute_threshold_percentage: 80.0,
        ..Settings::default()
    }
}

#[tokio::test]
async fn the_force_band_drops_old_tool_output_down_toward_the_target() {
    // With the threshold at 80%, the first pass that may rebuild is already
    // in the force band (85%, about 94% here). Shell outputs at tags 3, 5, 7
    // and 9 are 9,000 tokens each; 5, 7 and 9 are the newest three calls,
    // which the protected tail keeps, so the emergency drop takes 3.
    let mut runner = start_with(config("worker", Kind::OpenAi, free()), high_threshold()).await;
    runner
        .play(&[
            user("Build it."),
            shell(9_000),
            shell(9_000),
            shell(9_000),
            shell(9_000),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let requests = &runner.report.requests;
    assert_eq!(
        requests.iter().position(|record| record.view.is_some()),
        Some(5)
    );
    assert_eq!(requests.last().unwrap().view, Some(1));
    let host = runner.host();
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));
    assert!(seen(host, 5).unwrap().starts_with("§5§ yyy"));
}

#[tokio::test]
async fn the_force_band_takes_one_emergency_batch_per_stay() {
    // The task (27,500 tokens, never dropped) keeps the session in the force
    // band (85%, 33,150 here) after the first batch. Shell outputs: 3 and 5
    // are 2,500 tokens, 7, 9 and 11 are 1,700. No output is ever far behind
    // (newer content stays under a quarter of the window), so only the
    // emergency drop takes any.
    let task = format!("Build it. {}", "w".repeat(110_000));
    let mut runner = start_with(config("worker", Kind::OpenAi, free()), high_threshold()).await;
    runner
        .play(&[
            user(&task),
            shell(2_500),
            shell(2_500),
            shell(1_700),
            shell(1_700),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    // Once 9 joins the protected tail (9 and 7 hold its 3,120 tokens, 5
    // makes three calls), 3 is outside it, and the batch takes it.
    let host = runner.host();
    assert_eq!(host.applied_version(), Some(1));
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));

    // Output 11 pushes 5 out of the tail while usage is still in the band.
    // The batch already landed during this stay, so 5 stays.
    runner.play(&[shell(1_700), answer(), answer()]).await;
    assert_clean(&runner);
    let host = runner.host();
    let last = runner.report.requests.last().unwrap();
    assert!(last.usage.prompt_tokens.unwrap() >= 33_150, "{last:?}");
    assert_eq!(host.applied_version(), Some(1));
    assert!(seen(host, 5).unwrap().starts_with("§5§ yyy"));
}

#[tokio::test]
async fn a_request_over_the_limit_gets_a_view_where_the_protections_yield() {
    // The fifth request would not fit (about 39,600 tokens against 39,000),
    // so the runner rides with over_limit before sending it. The emergency
    // drop then takes the protected tail too, oldest first, and dropped calls
    // go whole, except the newest, whose result ends the transcript.
    let mut runner = start_with(config("worker", Kind::OpenAi, free()), high_threshold()).await;
    runner
        .play(&[
            user("Build it."),
            shell(9_000),
            shell(9_000),
            shell(9_000),
            shell(12_000),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let rides = &runner.report.rides;
    assert_eq!(rides.len(), 1);
    assert_eq!(rides[0].causes, [RideCause::OverLimit]);
    assert!(rides[0].got_view);
    let host = runner.host();
    for tag in [3, 5, 7] {
        assert_eq!(seen(host, tag), None, "{tag}");
    }
    assert_eq!(seen(host, 9).as_deref(), Some(placeholder(9).as_str()));
}

/// A step where the model writes a long reply of about `tokens` tokens.
fn long_reply(tokens: usize) -> Step {
    Step::Model(Turn {
        text: Some("z".repeat(tokens * 4)),
        output_tokens: tokens as u64,
        ..Turn::default()
    })
}

#[tokio::test]
async fn a_worker_that_cannot_free_enough_is_asked_for_ctx_keep_and_keeps_only_what_it_names() {
    // Four long replies of about 7,000 tokens each (tags 2 to 5) take the
    // worker over its threshold. Replies are the model's own words, which no
    // lane drops, so the pass frees nothing and the worker is asked to call
    // ctx_keep (the notice takes tag 7). It keeps the reply at tag 3. The
    // view then keeps the task, tag 3, and the ctx_keep message (tags 8 and
    // 9) with what follows; the protected tail starts at the ctx_keep call,
    // the only tool call.
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner
        .play(&[
            user("Review the module."),
            long_reply(7_000),
            long_reply(7_000),
            long_reply(7_000),
            long_reply(7_000),
            answer(),
            step(
                "Keeping what matters.",
                vec![ToolCall::ok(
                    "ctx_keep",
                    json!({"tags": "3", "note": "Drafted the review; next: tighten it."}),
                    "",
                )],
            ),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let host = runner.host();
    let asked = host
        .entries()
        .iter()
        // A template send from magic-context, so a notice and never the
        // person's own message.
        .filter(|entry| {
            entry.notice.as_ref().is_some_and(|notice| {
                notice.sender == "magic-context"
                    && notice.template.as_deref() == Some("mc.ctx_keep.v1")
            }) && entry.parts.iter().any(|part| {
                matches!(&part.body, PartBody::Text { text } if text.contains("Call ctx_keep now"))
            })
        })
        .count();
    assert_eq!(asked, 1);
    assert!(seen(host, 1).unwrap().starts_with("§1§ Review"));
    for tag in [2, 4, 5, 6, 7] {
        assert_eq!(
            seen(host, tag).as_deref(),
            Some(placeholder(tag).as_str()),
            "{tag}"
        );
    }
    assert!(seen(host, 3).unwrap().starts_with("§3§ zzz"));
    assert!(seen(host, 9).unwrap().contains("Keeping §3§"));
}

/// The user's prompt and two file reads: one turn of a head session.
/// A head's turn: a prompt, two reads of about 12,000 tokens each, and an
/// answer. Three turns take a head past its execute threshold.
fn turn(prompt: &str) -> Vec<Step> {
    vec![user(prompt), large_read(), large_read(), answer()]
}

fn large_read() -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(50),
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(48_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

#[tokio::test]
async fn a_head_summarizes_older_turns_and_shows_them_in_place_of_the_messages() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let host = runner.host();

    // The summarizer ran in its own child session, never in the transcript.
    let runs = host.child_runs();
    assert!(!runs.is_empty(), "no summarizer run");
    assert!(runs[0].prompt.contains("<new_messages>"));
    assert!(host
        .entries()
        .iter()
        .all(|entry| entry.parts.iter().all(|part| match &part.body {
            PartBody::Text { text } => !text.contains("<compartment"),
            _ => true,
        })));

    // Over the threshold, one view shows the summaries at the start in place
    // of the messages they cover, and the newest prompt stays as it is.
    let rendered = host.rendered();
    let texts: Vec<String> = rendered
        .iter()
        .take(2)
        .map(|message| {
            message
                .parts
                .iter()
                .filter_map(|part| message.wire_text(part))
                .collect()
        })
        .collect();
    assert!(texts[0].starts_with("<session-history>"), "{:?}", texts[0]);
    assert!(
        texts[1].starts_with("<session-history-since>"),
        "{:?}",
        texts[1]
    );
    let first_kept = rendered
        .iter()
        .find_map(|message| match &message.source {
            cortexkit_compaction_view::render::Source::Entry { ordinal, .. } => Some(*ordinal),
            _ => None,
        })
        .unwrap();
    assert!(first_kept > 0, "nothing was cut");
    assert!(rendered
        .iter()
        .any(|message| message.parts.iter().any(|part| message
            .wire_text(part)
            .is_some_and(|text| text.contains("And c.rs.")))));

    // Every request between views extends the one before it.
    let requests = &runner.report.requests;
    for pair in requests.windows(2) {
        if pair[0].view == pair[1].view {
            assert_eq!(pair[1].usage.cache_read_tokens, pair[0].usage.prompt_tokens);
        }
    }
}

/// The texts of the two history messages at the start, as the model sees them.
fn head_texts(host: &Host) -> (String, String) {
    let rendered = host.rendered();
    let text = |index: usize| -> String {
        let message = &rendered[index];
        message
            .parts
            .iter()
            .filter_map(|part| message.wire_text(part))
            .collect()
    };
    (text(0), text(1))
}

#[tokio::test]
async fn caveman_compresses_older_long_text_by_age_when_turned_on() {
    let settings = Settings {
        caveman: Some(mc_module::pass::Caveman {
            min_chars: 100,
            english_word_rules: true,
        }),
        ..Settings::default()
    };
    let long = |n: usize| {
        format!(
            "Message {n}: I really just think that the very simple approach is actually quite good, and we should basically go with it because it is the clearest option."
        )
    };
    let mut runner = start_with(config("head", Kind::OpenAi, free()), settings).await;
    let mut steps = Vec::new();
    // Ten person messages and ten replies: twenty eligible text parts, tags
    // 1 to 20, oldest first.
    for n in 0..10 {
        steps.push(user(&long(2 * n + 1)));
        steps.push(Step::Model(Turn {
            text: Some(long(2 * n + 2)),
            output_tokens: 40,
            ..Turn::default()
        }));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    // Below the threshold nothing is compressed.
    let first: String = format!("\u{a7}1\u{a7} {}", long(1))
        .chars()
        .take(60)
        .collect();
    assert_eq!(seen(runner.host(), 1), Some(first));
    // A lost cache rewrites the prefix anyway; the lanes ride it.
    runner
        .play(&[Step::Wait { ms: 400_000 }, user("Next."), answer()])
        .await;
    assert_clean(&runner);
    let shown = |tag: u64| {
        runner
            .host()
            .rendered()
            .iter()
            .flat_map(|message| message.parts.clone())
            .find(|part| part.tag == Some(tag))
            .and_then(|part| match part.body {
                PartBody::Text { text } => Some(text),
                _ => None,
            })
            .unwrap()
    };
    use mc_module::caveman::{compress, CavemanLevel};
    // The oldest fifth goes to ultra, the next to full, the next to lite.
    assert_eq!(
        shown(1),
        format!("§1§ {}", compress(&long(1), CavemanLevel::Ultra))
    );
    assert_eq!(
        shown(5),
        format!("§5§ {}", compress(&long(5), CavemanLevel::Full))
    );
    assert_eq!(
        shown(9),
        format!("§9§ {}", compress(&long(9), CavemanLevel::Lite))
    );
    // The newest 40% stays as written.
    assert_eq!(shown(13), long(13));
    assert_ne!(shown(1), format!("§1§ {}", long(1)));
}

/// A responder that answers like the scripted summarizer, except for runs
/// whose child name ends with `failing`: those get `reply`.
fn summarizer_failing(
    failing: &'static str,
    reply: mc_mock_runner::child::Reply,
) -> mc_mock_runner::child::Responder {
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    std::sync::Arc::new(move |settings, prompt| {
        if settings.child.ends_with(failing) {
            reply.clone()
        } else {
            summarizer(settings, prompt)
        }
    })
}

#[tokio::test]
async fn large_tool_output_alone_does_not_start_a_summary_at_low_usage() {
    // Two turns of four 4,000-token shell outputs, then a short exchange:
    // about a third of the usable window. The first turn's 16,000 raw tokens
    // lie outside the protected tail and past the size trigger (15,000), but
    // the lines the summarizer would read are a few short tool-call lines, so
    // nothing runs.
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    for prompt in ["Build it.", "Build it again."] {
        let mut steps = vec![user(prompt)];
        steps.extend((0..4).map(|_| shell(4_000)));
        steps.push(answer());
        runner.play(&steps).await;
    }
    runner.play(&[user("Thanks."), answer()]).await;
    assert_clean(&runner);
    let last = runner.report.requests.last().unwrap();
    assert!(last.usage.prompt_tokens.unwrap() < 40_000, "{last:?}");
    assert!(runner.host().child_runs().is_empty());
}

#[tokio::test]
async fn an_invalid_summary_gets_one_repair_run_that_sees_the_error() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    runner.host().set_responder(summarizer_failing(
        ":first",
        mc_mock_runner::child::Reply {
            text: "<output>not a summary</output>".into(),
            finish: Some("stop".into()),
            error: None,
        },
    ));
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let runs = runner.host().child_runs();
    let repair = runs
        .iter()
        .find(|run| run.child.ends_with(":repair"))
        .expect("a repair run");
    assert!(repair
        .prompt
        .contains("Your previous XML response was invalid and cannot be persisted."));
    assert!(repair.prompt.contains("<output>not a summary</output>"));
    // Each attempt has a child of its own.
    let children: std::collections::BTreeSet<String> =
        runs.iter().map(|run| run.child.clone()).collect();
    assert_eq!(children.len(), runs.len());
    // The repaired summaries are shown.
    let (m0, m1) = head_texts(runner.host());
    assert!(
        m0.contains("<session-history>\n") || m1.contains("<new-compartments>"),
        "{m0}\n{m1}"
    );
}

#[tokio::test]
async fn one_long_turn_at_the_threshold_is_summarized_past_its_prompt_once() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    // One prompt, then a long run of tool steps: everything after the prompt
    // is the current turn, which the summarizer may not read below the force
    // band, except for one run past the prompt at the execute threshold.
    runner.play(&[user("Refactor the whole crate.")]).await;
    let usable = 99_000.0;
    let mut usage_at_first_run = None;
    for _ in 0..24 {
        runner.play(&[read_file(50)]).await;
        if usage_at_first_run.is_none() && !runner.host().child_runs().is_empty() {
            let last = runner.report.requests.last().unwrap();
            usage_at_first_run =
                Some(last.usage.prompt_tokens.unwrap_or(0) as f64 / usable * 100.0);
        }
    }
    assert_clean(&runner);
    let usage = usage_at_first_run.expect("no summarizer run");
    // It ran at the threshold, not only once the force band let it past the
    // prompt.
    assert!((65.0..85.0).contains(&usage), "first run at {usage:.1}%");
    let runs = runner.host().child_runs();
    assert!(runs[0].prompt.contains("Refactor the whole crate."));
}

/// The one-pass summarizer: `historian.turn_two` off, so facts become
/// memories when the summary is stored.
fn one_pass() -> Settings {
    Settings {
        turn_two: false,
        ..Settings::default()
    }
}

#[tokio::test]
async fn facts_a_summary_finds_become_project_memories_with_it() {
    let dir = scratch("facts");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    // Give it the hash a fact with the same text has.
    let seen_before: i64 = {
        let conn = rusqlite::Connection::open(dir.join("context.db")).unwrap();
        conn.execute(
            "UPDATE memories SET normalized_hash = ?1 WHERE id = 1",
            [mc_module::memory_writes::normalized_hash(
                "Ask before pushing.",
            )],
        )
        .unwrap();
        conn.query_row("SELECT seen_count FROM memories WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, one_pass(), Some(dir.clone())).await;
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner
        .host()
        .set_responder(std::sync::Arc::new(move |settings, prompt| {
            let mut reply = summarizer(settings, prompt);
            reply.text = reply.text.replace(
                "</output>",
                "<facts><PROJECT_RULES>\n* Releases need two reviewers.\n* Ask before pushing.\n</PROJECT_RULES></facts>\n</output>",
            );
            reply
        }));
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    // Every summarizer child was sent under the project's folder, where a
    // real runner creates it.
    let folders = runner
        .provider()
        .client
        .child_scopes
        .lock()
        .unwrap()
        .clone();
    assert!(!folders.is_empty());
    let root = dir.to_string_lossy().into_owned();
    assert!(
        folders
            .iter()
            .all(|folder| folder.as_deref() == Some(root.as_str())),
        "{folders:?}"
    );
    // The summarizer saw the project's memories, to leave known facts out.
    let runs = runner.host().child_runs();
    assert!(runs[0].prompt.contains("Ask before pushing."));
    // The new fact became a memory; the known one only counted as seen again.
    let conn = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let rows: Vec<(String, String, i64)> = conn
        .prepare("SELECT content, source_type, seen_count FROM memories WHERE project_path = 'pj-test' ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[1].0, "Releases need two reviewers.");
    assert_eq!(rows[1].1, "historian");
    assert_eq!(rows[0].2, seen_before + 1, "{rows:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The two-pass historian, which runs by default: the first turn sees no
/// memory block and anchors its facts to the lines that state them; the
/// facts become candidates, not memories; a second turn in the same child
/// conversation then decides each against the project's memories. A `new`
/// fact becomes a memory with undo history, and a `covered` one only keeps
/// its mapping to the memory that already states it.
#[tokio::test]
async fn the_two_pass_historian_reconciles_its_facts_with_memory_in_a_second_turn() {
    let dir = scratch("two-pass");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    let seen_before: i64 = rusqlite::Connection::open(dir.join("context.db"))
        .unwrap()
        .query_row("SELECT seen_count FROM memories WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner
        .host()
        .set_responder(std::sync::Arc::new(move |settings, prompt| {
            use mc_mock_runner::child as mock;
            let mut reply = summarizer(settings, prompt);
            if prompt.contains(mock::TURN_TWO_FACT) {
                let decisions: Vec<String> = mock::facts_of(prompt)
                    .into_iter()
                    .map(|(id, text)| {
                        if text == "Ask before pushing." {
                            let revision: String = prompt
                                .split_once("memory:1@")
                                .map(|(_, rest)| rest.chars().take_while(char::is_ascii_digit).collect())
                                .unwrap_or_default();
                            format!(r#"{{"fact_id":{id},"action":"covered","target_id":1,"revision":{revision},"clauses":[1],"check":"memory 1 states it"}}"#)
                        } else {
                            format!(r#"{{"fact_id":{id},"action":"new","check":"no memory states it"}}"#)
                        }
                    })
                    .collect();
                reply.text = mock::turn_two_reply(&decisions);
            } else if prompt.contains(mock::TURN_ONE_FORMAT) {
                let xml = mock::summarize(prompt).replace(
                    "</output>",
                    "<facts><PROJECT_RULES>\n* [at_compartment=1 messages=1] Releases need two reviewers.\n* [at_compartment=1 messages=1] Ask before pushing.\n</PROJECT_RULES></facts>\n</output>",
                );
                reply.text = mock::turn_one_reply(&xml);
            }
            reply
        }));
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let runs = runner.host().child_runs();
    let first = runs
        .iter()
        .find(|run| run.prompt.contains("<new_messages>"))
        .expect("a first turn");
    // The first turn compares nothing with memory: it gets no memory block
    // and asks for anchored facts in a JSON envelope.
    assert!(
        !first.prompt.contains("Ask before pushing."),
        "{}",
        first.prompt
    );
    assert!(first.prompt.contains("at_compartment"));
    assert!(first
        .prompt
        .contains(mc_mock_runner::child::TURN_ONE_FORMAT));
    // The second turn continues the first turn's child conversation.
    let second = runs
        .iter()
        .find(|run| run.prompt.contains(mc_mock_runner::child::TURN_TWO_FACT))
        .expect("a second turn");
    assert_eq!(second.child, first.child);
    assert_eq!(second.settings.system, first.settings.system);
    let conn = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let facts: Vec<(String, String, Option<String>)> = conn
        .prepare("SELECT content, state || ':' || COALESCE(reason, ''), mapping_json FROM memory_pending_facts ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(facts.len(), 2, "{facts:?}");
    assert_eq!(facts[0].0, "Releases need two reviewers.");
    assert_eq!(facts[0].1, "applied:inserted", "{facts:?}");
    assert_eq!(facts[1].1, "covered:covered", "{facts:?}");
    assert!(
        facts[1]
            .2
            .as_deref()
            .is_some_and(|mapping| mapping.contains("\"memoryId\":1")),
        "{facts:?}"
    );
    let memories: Vec<(String, String, i64)> = conn
        .prepare("SELECT content, COALESCE(source_type, ''), seen_count FROM memories WHERE project_path = 'pj-test' ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(memories.len(), 2, "{memories:?}");
    assert_eq!(memories[1].0, "Releases need two reviewers.");
    assert_eq!(memories[1].1, "historian");
    // `covered` changes no memory.
    assert_eq!(memories[0].2, seen_before, "{memories:?}");
    let history: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_history WHERE after_text = 'Releases need two reviewers.'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history, 1);
    let stages: Vec<(String, String)> = conn
        .prepare("SELECT stage, state FROM memory_stage_attempts ORDER BY rowid")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        stages.contains(&("turn_one".into(), "published".into())),
        "{stages:?}"
    );
    assert!(
        stages.contains(&("turn_two".into(), "resolved".into())),
        "{stages:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn routing_picks_the_summarizer_and_a_failed_model_falls_back_to_another() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    runner.provider().client.routing.lock().unwrap().routes =
        vec!["broken/model".into(), "good/model".into()];
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner
        .host()
        .set_responder(std::sync::Arc::new(move |settings, prompt| {
            if settings.model.provider == "broken" {
                mc_mock_runner::child::Reply {
                    error: Some("400 Bad Request: this model cannot".into()),
                    ..Default::default()
                }
            } else {
                summarizer(settings, prompt)
            }
        }));
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let log = runner.provider().client.routing.lock().unwrap();
    // Summaries are picked as `mc_summary` on the session's own runner, and
    // the second select leaves the failed model out.
    assert!(log.selects.len() >= 2, "{} selects", log.selects.len());
    assert_eq!(log.selects[0].consumer, "mc_summary");
    assert_eq!(log.selects[0].runners, Some(vec!["mock-runner".to_owned()]));
    assert_eq!(
        log.selects[1].exclude,
        Some(vec!["broken/model".to_owned()])
    );
    // Each decision's outcome went back to routing.
    let outcomes: Vec<String> = log
        .reports
        .iter()
        .map(|report| {
            serde_json::to_value(&report.outcome)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(&outcomes[..2], ["failed", "completed"], "{outcomes:?}");
    drop(log);
    // The runs carried the decision their model was picked under.
    let runs = runner.host().child_runs();
    let good = runs
        .iter()
        .map(|run| &run.settings)
        .find(|run| run.model.provider == "good")
        .expect("no run on the fallback model");
    assert_eq!(good.route_decision_id.as_deref(), Some("d2"));
    let (m0, m1) = head_texts(runner.host());
    assert!(
        m0.contains("<session-history>\n") || m1.contains("<new-compartments>"),
        "{m0}\n{m1}"
    );
}

#[tokio::test]
async fn with_no_route_no_summary_runs_and_ck_mc_picks_no_model_itself() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    runner.provider().client.routing.lock().unwrap().no_route = true;
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    assert!(!runner
        .provider()
        .client
        .routing
        .lock()
        .unwrap()
        .selects
        .is_empty());
    assert!(runner.host().child_runs().is_empty());
}

#[tokio::test]
async fn a_transient_provider_error_retries_the_summary_after_a_pause() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    runner.host().set_responder(summarizer_failing(
        ":first",
        mc_mock_runner::child::Reply {
            error: Some("503 Service Unavailable: overloaded".into()),
            ..Default::default()
        },
    ));
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    // The retry waits two to three seconds before it runs.
    for _ in 0..40 {
        if runner
            .host()
            .child_runs()
            .iter()
            .any(|run| run.child.ends_with(":retry1"))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    runner.play(&[user("Go on."), answer()]).await;
    assert_clean(&runner);
    let runs = runner.host().child_runs();
    assert!(
        runs.iter().any(|run| run.child.ends_with(":first:retry1")),
        "{:?}",
        runs.iter().map(|run| run.child.clone()).collect::<Vec<_>>()
    );
    let (m0, m1) = head_texts(runner.host());
    assert!(
        m0.contains("<session-history>\n") || m1.contains("<new-compartments>"),
        "{m0}\n{m1}"
    );
}

#[tokio::test]
async fn a_lost_cache_folds_the_newer_summaries_into_the_baseline() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    let mut steps = Vec::new();
    for prompt in [
        "Look at a.rs.",
        "Now b.rs.",
        "And c.rs.",
        "Then d.rs.",
        "Last e.rs.",
    ] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let (_, m1) = head_texts(runner.host());
    assert!(
        m1.contains("<new-compartments>"),
        "no newer summary before the fold: {m1}"
    );

    // The cache expires; the ride before the next request folds m[1] into m[0].
    runner
        .play(&[Step::Wait { ms: 400_000 }, user("Next.")])
        .await;
    runner.play(&[answer()]).await;
    assert_clean(&runner);
    let ride = runner.report.rides.last().unwrap();
    assert_eq!(ride.causes, [RideCause::CacheExpired]);
    assert!(ride.got_view);
    let (m0, m1) = head_texts(runner.host());
    assert!(
        m1.starts_with("<session-history-since>(no new content"),
        "{m1}"
    );
    let newest = runner.host().child_runs().len();
    assert!(newest > 0);
    assert!(m0.contains("<session-history>\n"), "{m0}");
}

#[tokio::test]
async fn a_revert_into_summarized_history_forgets_those_summaries() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    // A few quiet steps under the view, so the revert comes below the
    // threshold, where no execute pass would rebuild the head.
    runner.play(&[answer(), answer()]).await;
    let last = runner.report.requests.last().unwrap();
    assert!(
        last.usage.prompt_tokens.unwrap() < 64_350,
        "{:?}",
        last.usage.prompt_tokens
    );

    // The summaries of everything after the first message.
    let (m0, m1) = head_texts(runner.host());
    let head = format!("{m0}\n{m1}");
    let undone: Vec<String> = head
        .lines()
        .filter(|line| line.starts_with("## ") && !line.starts_with("## 1-1 "))
        .map(str::to_owned)
        .collect();
    assert!(!undone.is_empty(), "{head}");

    // Undo back to the second message. The next step already shows a head
    // without the summaries of what was undone, at low usage.
    runner
        .play(&[
            Step::Revert { ordinal: 2 },
            user("Start over."),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let (m0, m1) = head_texts(runner.host());
    let head = format!("{m0}\n{m1}");
    for line in &undone {
        assert!(
            !head.contains(line.as_str()),
            "a reverted summary is still shown: {line}\n{head}"
        );
    }
}

/// A fresh scratch folder for one scenario's stores.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ck-mc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn a_restarted_ck_mc_keeps_queued_drops_and_the_view_the_runner_applies() {
    let dir = scratch("restart-worker");
    let mut runner = start_full(
        config("worker", Kind::OpenAi, free()),
        Settings::default(),
        Some(dir.clone()),
    )
    .await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            read_file(50),
            reduce("3,5"),
        ])
        .await;
    assert_eq!(runner.host().applied_version(), None);

    // ck-mc restarts. The runner's next notice is answered "Setup required";
    // it calls Setup and sends the notice again.
    runner.provider().restart();
    runner
        .play(&[read_file(50), read_file(50), answer(), answer()])
        .await;
    assert_clean(&runner);
    // The drops queued before the restart landed on the first execute pass.
    let host = runner.host();
    assert_eq!(seen(host, 3).as_deref(), Some(placeholder(3).as_str()));
    assert_eq!(seen(host, 5).as_deref(), Some(placeholder(5).as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// ck-mc crashes right after handing over the view that cuts summarized
/// history, before the end of the job saves its state. The state saved before
/// the hand-over names that view, so after the restart ck-mc keeps the same
/// `m[0]` and reads only from the cut (spec 4, DS2 and ST2).
#[tokio::test]
async fn a_crash_right_after_handing_over_a_view_keeps_its_cut_and_baseline() {
    let dir = scratch("crash-after-view");
    let mut runner = start_full(
        config("head", Kind::OpenAi, free()),
        Settings::default(),
        Some(dir.clone()),
    )
    .await;
    *runner.provider().client.snapshot_store.lock().unwrap() = Some(dir.clone());
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    *runner.provider().client.snapshot_store.lock().unwrap() = None;
    let (m0_before, _) = head_texts(runner.host());
    // The last view handed over; the runner may not have applied it yet.
    let handed = *runner
        .provider()
        .client
        .offered
        .lock()
        .unwrap()
        .last()
        .expect("a view was handed over");
    let cut = runner
        .host()
        .entries()
        .iter()
        .find(|entry| {
            runner.host().applied_view().view.is_some_and(|view| {
                view.edits.iter().any(|edit| {
                    matches!(&edit.op, cortexkit_role_compaction::view::EditOp::Cut { through } if *through == entry.mid)
                })
            })
        })
        .expect("the head cuts the summarized messages")
        .ordinal;

    // The store, as the view left ck-mc, already names it: whatever happens
    // to the call, a restarted ck-mc knows the runner may hold it.
    let saved: String = rusqlite::Connection::open(dir.join(format!("store-at-{handed}.db")))
        .unwrap()
        .query_row("SELECT state FROM sessions", [], |row| row.get(0))
        .unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["version"], handed, "{saved}");
    assert_eq!(
        saved["unconfirmed"]
            .as_array()
            .and_then(|list| list.last())
            .map(|pending| pending["view"]["version"].clone()),
        Some(json!(handed)),
        "{saved}"
    );
    // The crash: a new ck-mc on the store as it was when that view left.
    let crashed = scratch("crash-after-view-restore");
    std::fs::copy(
        dir.join(format!("store-at-{handed}.db")),
        crashed.join("mode3.db"),
    )
    .unwrap();
    std::fs::copy(dir.join("context.db"), crashed.join("context.db")).unwrap();
    runner.provider().client.reads.lock().unwrap().clear();
    runner.provider().client.offered.lock().unwrap().clear();
    runner.provider().restart_from(&crashed);
    let mut steps = Vec::new();
    for prompt in ["Then d.rs.", "Last e.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let (m0_after, _) = head_texts(runner.host());
    assert_eq!(
        m0_before, m0_after,
        "m[0] was rendered again after the crash"
    );
    // ck-mc knew the runner might hold that view: it offered that same view
    // again at most, and never a different view under its version or an
    // older one.
    let offered = runner.provider().client.offered.lock().unwrap().clone();
    assert!(
        offered.iter().all(|version| *version >= handed),
        "view {handed} was handed over before the crash; offered after it: {offered:?}"
    );
    let checksums = runner.provider().client.offered_checksums.lock().unwrap()[&handed].clone();
    assert!(
        checksums.iter().all(|checksum| *checksum == checksums[0]),
        "a different view {handed} after the crash: {checksums:?}"
    );
    let reads = runner.provider().client.reads.lock().unwrap().clone();
    assert!(!reads.is_empty());
    for (after, _) in &reads {
        assert!(
            after.unwrap_or(0) + 1 >= cut,
            "a read from before the cut {cut}: {reads:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&crashed);
}

#[tokio::test]
async fn a_restarted_ck_mc_keeps_the_history_baseline() {
    let dir = scratch("restart-head");
    let mut runner = start_full(
        config("head", Kind::OpenAi, free()),
        Settings::default(),
        Some(dir.clone()),
    )
    .await;
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let (m0_before, _) = head_texts(runner.host());
    let views_before = runner.host().applied_version();
    let cut = runner
        .host()
        .entries()
        .iter()
        .position(|entry| {
            runner.host().applied_view().view.is_some_and(|view| {
                view.edits.iter().any(|edit| {
                    matches!(&edit.op, cortexkit_role_compaction::view::EditOp::Cut { through } if *through == entry.mid)
                })
            })
        })
        .expect("the head cuts the summarized messages") as u64;
    runner.provider().client.reads.lock().unwrap().clear();

    // After a restart, more turns: m[0] is not rendered again, and each
    // request between views still extends the one before it.
    runner.provider().restart();
    let mut steps = Vec::new();
    for prompt in ["Then d.rs.", "Last e.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let (m0_after, _) = head_texts(runner.host());
    assert!(
        runner.host().applied_version() > views_before,
        "no view after the restart"
    );
    assert_eq!(
        m0_before, m0_after,
        "m[0] was rendered again after the restart"
    );
    let requests = &runner.report.requests;
    for pair in requests.windows(2) {
        if pair[0].view == pair[1].view {
            assert_eq!(pair[1].usage.cache_read_tokens, pair[0].usage.prompt_tokens);
        }
    }
    // The restarted ck-mc read the transcript from a cut message on (the
    // applied view's, or a newer one the runner already took), never from
    // the start: what the summaries replace needs no index.
    let reads = runner.provider().client.reads.lock().unwrap().clone();
    assert!(!reads.is_empty(), "the restart read nothing");
    assert!(
        reads.iter().all(|(after, _)| *after >= cut.checked_sub(1)),
        "{reads:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Store a project memory the way a standalone plugin would.
fn insert_memory(dir: &std::path::Path, id: i64, content: &str) {
    let connection = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    connection
        .execute(
            "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance,
                                   first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'pj-test', 'PROJECT_RULES', ?2, ?3, 80, 1, 1, 1, 1)",
            rusqlite::params![id, content, format!("hash-{id}")],
        )
        .unwrap();
}

#[tokio::test]
async fn switching_memory_off_folds_m0_at_once_without_memories() {
    let dir = scratch("memory-off");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    runner.play(&[user("Hello."), answer()]).await;
    let (m0, _) = head_texts(runner.host());
    assert!(m0.contains("Ask before pushing."), "{m0}");
    let views_before = runner.report.requests.last().unwrap().view;

    // The user switches memory off. Below the threshold no lane has work,
    // yet m[0] is rendered again on the next pass, without the memory.
    runner.provider().restart_with(Settings {
        memory_enabled: false,
        ..Settings::default()
    });
    runner.play(&[user("Go on."), answer()]).await;
    assert_clean(&runner);
    let (m0, m1) = head_texts(runner.host());
    assert!(!m0.contains("Ask before pushing."), "{m0}");
    assert!(!m1.contains("Ask before pushing."), "{m1}");
    assert_ne!(runner.report.requests.last().unwrap().view, views_before);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_head_shows_its_docs_and_memories_first_and_every_later_memory_change_in_m1() {
    let dir = scratch("head-memories");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    std::fs::write(
        dir.join("ARCHITECTURE.md"),
        "# Architecture\n\nOne crate.\n",
    )
    .unwrap();
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    runner.play(&[user("Hello."), answer()]).await;
    assert_clean(&runner);
    // The first request already carried the head, so it was the only write.
    assert_eq!(runner.report.requests[0].view, Some(1));
    let (m0, m1) = head_texts(runner.host());
    assert!(m0.starts_with("<project-docs>"), "{m0}");
    assert!(m0.contains("One crate."), "{m0}");
    assert!(m0.contains("#1: Ask before pushing."), "{m0}");
    assert!(
        m1.starts_with("<session-history-since>(no new content"),
        "{m1}"
    );

    // Another writer adds memory 2 and changes memory 1 mid-session: the
    // next pass that builds a view states both in m[1], and m[0] stays as
    // it was.
    insert_memory(&dir, 2, "Never force-push.");
    rusqlite::Connection::open(dir.join("context.db"))
        .unwrap()
        .execute(
            "UPDATE memories SET content = 'Ask before every push.' WHERE id = 1",
            [],
        )
        .unwrap();
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let (m0_later, m1) = head_texts(runner.host());
    assert!(
        m1.contains(
            "<updated id=\"1\" category=\"PROJECT_RULES\">Ask before every push.</updated>"
        ),
        "{m1}"
    );
    assert!(
        m1.contains("<added id=\"2\" category=\"PROJECT_RULES\">Never force-push.</added>"),
        "{m1}"
    );
    assert!(!m0_later.contains("Never force-push."), "{m0_later}");

    // A lost cache folds both into m[0].
    runner
        .play(&[Step::Wait { ms: 400_000 }, user("Next."), answer()])
        .await;
    assert_clean(&runner);
    let (m0, m1) = head_texts(runner.host());
    assert!(m0.contains("#2: Never force-push."), "{m0}");
    assert!(!m1.contains("memory-updates"), "{m1}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The answers to every `ctx_expand` call, oldest first.
fn expand_outputs(host: &Host) -> Vec<String> {
    host.entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Tool(tool) if tool.name == "ctx_expand" => tool.output.clone(),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn ctx_expand_shows_summarized_messages_and_parts_again() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let first_read = runner
        .host()
        .entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .find_map(|part| match &part.body {
            PartBody::Tool(tool) if tool.name == "read" => part.tag,
            _ => None,
        })
        .unwrap();
    let expand = |input: Value| {
        Step::Model(Turn {
            text: Some("Checking.".into()),
            tools: vec![ToolCall::ok("ctx_expand", input, "")],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    runner
        .play(&[
            expand(json!({"message": 1})),
            expand(json!({"start": 1, "end": 3})),
            expand(json!({"start": 1, "end": 2, "verbose": true})),
            expand(json!({"tag": format!("§{first_read}§")})),
            expand(json!({"start": 1000, "end": 1001})),
            expand(json!({"tag": 999_999})),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let outputs = expand_outputs(runner.host());
    assert_eq!(outputs.len(), 6, "{outputs:?}");
    assert!(
        outputs[0].starts_with("[1] U (user) — full recovery:")
            && outputs[0].contains("Look at a.rs."),
        "{}",
        outputs[0]
    );
    assert!(
        outputs[1].starts_with("Messages 1-") && outputs[1].contains("] U: Look at a.rs."),
        "{}",
        outputs[1]
    );
    assert!(
        outputs[2].contains("(verbose)") && outputs[2].contains("• tool read(a.rs)"),
        "{}",
        outputs[2]
    );
    assert!(
        outputs[3].starts_with("  [tool: read #") && outputs[3].contains(&"x".repeat(100)),
        "{}",
        &outputs[3][..outputs[3].len().min(200)]
    );
    assert!(outputs[4].contains("live tail"), "{}", outputs[4]);
    assert!(outputs[5].starts_with("no tag 999999"), "{}", outputs[5]);
}

/// The answers to every call of a `ctx_*` tool, oldest first.
fn tool_outputs(host: &Host, name: &str) -> Vec<String> {
    host.entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Tool(tool) if tool.name == name => tool.output.clone(),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn ctx_note_finds_the_notes_a_standalone_session_wrote_and_keeps_new_ones() {
    let dir = scratch("notes");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    // A note the session wrote before it moved, keyed by harness and host
    // session id.
    rusqlite::Connection::open(dir.join("context.db"))
        .unwrap()
        .execute(
            "INSERT INTO notes (type, status, content, session_id, harness, created_at, updated_at)
             VALUES ('session', 'active', 'Check the release\nbefore Friday', 's1', 'mock', 1, 1)",
            [],
        )
        .unwrap();
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    let note = |input: Value| {
        Step::Model(Turn {
            text: Some("Noting.".into()),
            tools: vec![ToolCall::ok("ctx_note", input, "")],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    runner
        .play(&[
            user("Hello."),
            note(json!({"action": "read", "note_ids": []})),
            note(json!({"action": "write", "content": "Fix the flaky test", "note_ids": []})),
            note(json!({"action": "dismiss", "note_ids": [1]})),
            note(json!({"action": "read", "note_ids": [2]})),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let outputs = tool_outputs(runner.host(), "ctx_note");
    assert_eq!(outputs.len(), 4, "{outputs:?}");
    assert!(
        outputs[0].starts_with("## Notes\n\n#1 · ") && outputs[0].contains("Check the release"),
        "{}",
        outputs[0]
    );
    assert!(
        outputs[1].starts_with("Saved session note #2. 2 active, oldest "),
        "{}",
        outputs[1]
    );
    assert_eq!(outputs[2], "Note #1 dismissed.");
    assert!(
        outputs[3]
            .starts_with("## Notes by ID\n\n- **#2** · 0m · active: Fix the flaky test ↳ @msg "),
        "{}",
        outputs[3]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn ctx_memory_saves_updates_and_archives_with_history_and_m1_shows_where_each_memory_ended() {
    let dir = scratch("memory-tool");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    let memory = |input: Value| {
        Step::Model(Turn {
            text: Some("Remembering.".into()),
            tools: vec![ToolCall::ok("ctx_memory", input, "")],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    let mut steps = vec![
        user("Hello."),
        memory(
            json!({"action": "write", "category": "NAMING", "content": "Crates use kebab-case.", "ids": []}),
        ),
        memory(
            json!({"action": "write", "category": "NAMING", "content": "crates use   KEBAB-case.", "ids": []}),
        ),
        memory(
            json!({"action": "update", "ids": [1], "content": "Ask before every push.", "category": "PROJECT_RULES"}),
        ),
        memory(json!({"action": "archive", "ids": [1], "reason": "now a hook"})),
        memory(json!({"action": "update", "ids": [1], "content": "x"})),
        memory(json!({"action": "get", "ids": [2, 999]})),
    ];
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    // The third turn's summary lands with the view of the pass after it.
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let outputs = tool_outputs(runner.host(), "ctx_memory");
    assert_eq!(outputs[0], "Saved memory [ID: 2] in NAMING.");
    assert_eq!(
        outputs[1],
        "Memory already exists [ID: 2] in NAMING (seen count incremented)."
    );
    assert_eq!(outputs[2], "Updated memory [ID: 1] in PROJECT_RULES.");
    assert_eq!(outputs[3], "Archived memory [ID: 1] (now a hook).");
    assert!(
        outputs[4].contains("archived or superseded"),
        "{}",
        outputs[4]
    );
    assert!(
        outputs[5].starts_with("Found 1 active memory:")
            && outputs[5].contains("id 999: not found"),
        "{}",
        outputs[5]
    );

    // m[1] states where each memory ended up: memory 1 was updated and
    // then archived before the next view, so it shows as removed.
    let (_, m1) = head_texts(runner.host());
    assert!(
        m1.contains("<added id=\"2\" category=\"NAMING\">Crates use kebab-case.</added>"),
        "{m1}"
    );
    assert!(m1.contains("<removed id=\"1\"/>"), "{m1}");
    assert!(!m1.contains("<updated id=\"1\""), "{m1}");

    // The rows the standalone plugin reads are there.
    let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let count = |sql: &str| -> i64 { db.query_row(sql, [], |row| row.get(0)).unwrap() };
    assert_eq!(count("SELECT revision FROM memories WHERE id = 1"), 3);
    assert_eq!(
        count("SELECT COUNT(*) FROM memory_history WHERE memory_id = 1"),
        2
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM memory_mutation_log WHERE target_memory_id = 1"),
        2
    );
    assert_eq!(count("SELECT COUNT(*) FROM memory_journal"), 4);
    assert_eq!(count("SELECT seen_count FROM memories WHERE id = 2"), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A session's memory context is read from Entorhinal once, at its first
/// Setup, and kept across a ck-mc restart; every memory the session saves is
/// recorded at its project's level with the profile and category id it was
/// written under (spec 3c, ML1 and ML2).
#[tokio::test]
async fn saved_memories_record_their_project_level_from_a_context_read_once() {
    let dir = scratch("memory-levels");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let root = dir.to_string_lossy().into_owned();
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: root.clone(),
    });
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut result = records[0]["reply"]["result"].clone();
    // No domain: the bundled software profile.
    result["domain"] = Value::Null;
    let client = HostClient::default();
    *client.entorhinal.lock().unwrap() = Some(result);
    let mut runner = start_with_client(
        client.clone(),
        config,
        Settings::default(),
        Some(dir.clone()),
        false,
        |route| route.agent_id = Some("agent-1".into()),
    )
    .await;
    let memory = |content: &str| {
        Step::Model(Turn {
            text: Some("Remembering.".into()),
            tools: vec![ToolCall::ok(
                "ctx_memory",
                json!({"action": "write", "category": "NAMING", "content": content, "ids": []}),
                "",
            )],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    runner
        .play(&[user("Hello."), memory("Crates use kebab-case."), answer()])
        .await;
    runner.provider().restart();
    runner
        .play(&[user("Again."), memory("Modules use snake_case."), answer()])
        .await;
    assert_clean(&runner);
    assert_eq!(
        *client.entorhinal_reads.lock().unwrap(),
        [
            ("context.project".to_owned(), root),
            ("context.session".to_owned(), "agent-1".to_owned()),
        ],
        "one context read, kept across the restart"
    );
    let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let placements: Vec<(String, String, String, String, String)> = db
        .prepare(
            "SELECT m.content, p.level, p.owner_id, p.origin_profile_name, p.origin_category
             FROM memory_placement p JOIN memories m ON m.id = p.memory_id ORDER BY m.id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let placed = |content: &str| {
        (
            content.to_owned(),
            "project".to_owned(),
            "served-project".to_owned(),
            "@cortexkit/memory-swe".to_owned(),
            "swe:naming".to_owned(),
        )
    };
    assert_eq!(
        placements,
        [
            placed("Crates use kebab-case."),
            placed("Modules use snake_case.")
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn ctx_search_finds_summarized_messages_notes_and_hidden_memories_but_not_what_the_model_sees(
) {
    let dir = scratch("search-tool");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Crates use kebab-case naming.");
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    let call = |name: &str, input: Value| {
        Step::Model(Turn {
            text: Some("Looking.".into()),
            tools: vec![ToolCall::ok(name, input, "")],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    let mut steps = Vec::new();
    for prompt in [
        "Investigate the zebra parser crash.",
        "Now b.rs.",
        "And c.rs.",
    ] {
        steps.extend(turn(prompt));
    }
    steps.extend([
        call(
            "ctx_note",
            json!({"action": "write", "content": "The zebra fixture lives in testdata.", "note_ids": []}),
        ),
        user("Is the zebra parser fixed yet?"),
        call("ctx_search", json!({"query": "zebra parser"})),
        call("ctx_search", json!({"query": "kebab naming"})),
        call("ctx_search", json!({"query": "#1"})),
        call("ctx_search", json!({"query": "zebra fixture", "sources": ["note"]})),
        call("ctx_search", json!({"query": "zebra", "from": "2020-02-30"})),
        answer(),
    ]);
    runner.play(&steps).await;
    assert_clean(&runner);
    let outputs = tool_outputs(runner.host(), "ctx_search");
    assert_eq!(outputs.len(), 5, "{outputs:?}");

    // The summarized prompt is found, and so is the note; the newest prompt,
    // which the model still sees, is only counted.
    assert!(
        outputs[0].starts_with("Found 2 results for \"zebra parser\""),
        "{}",
        outputs[0]
    );
    assert!(
        outputs[0].contains("[note] score=")
            && outputs[0].contains("Git commits: no git repository"),
        "{}",
        outputs[0]
    );
    assert!(
        outputs[0].contains("[message] score=1.00 ordinal=1 range=1-4 role=user")
            && outputs[0].contains("Investigate the zebra parser crash."),
        "{}",
        outputs[0]
    );
    assert!(
        outputs[0].contains(
            "Message history: 1 raw-message match is newer than the last compartment boundary"
        ),
        "{}",
        outputs[0]
    );

    // The memory the head shows is found but not repeated, by text or by id.
    for output in &outputs[1..3] {
        assert!(output.starts_with("No hidden results found"), "{output}");
        assert!(
            output.contains("Memories: 1 match found, all already visible in your project-memory block (ids 1)."),
            "{output}"
        );
    }

    assert!(
        outputs[3].starts_with("Found 1 result")
            && outputs[3].contains("[note] score=")
            && outputs[3].contains("The zebra fixture lives in testdata."),
        "{}",
        outputs[3]
    );
    assert_eq!(
        outputs[4],
        "Error: Invalid 'from' date; use YYYY-MM-DD or a full ISO datetime."
    );

    // The summarized prompt is in the shared index under its message number.
    let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let indexed: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM message_history_fts WHERE session_id = 's1' AND message_ordinal = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A stand-in embedding endpoint. Every query embeds to one of two
/// directions, chosen by whether it mentions versions, and every request is
/// counted.
async fn embedding_endpoint() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let counter = Arc::clone(&counter);
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request).to_lowercase();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let vector = if String::from_utf8_lossy(&request).contains("version") {
                    "[1.0, 0.0]"
                } else {
                    "[0.0, 1.0]"
                };
                let body = format!(
                    "{{\"model\":\"mock-embed\",\"data\":[{{\"index\":0,\"embedding\":{vector}}}]}}"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://{address}/v1"), calls)
}

fn vector_blob(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

#[tokio::test]
async fn ctx_search_finds_commits_and_memories_by_meaning_with_one_embedding_per_search() {
    let dir = scratch("search-meaning");
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let (endpoint, calls) = embedding_endpoint().await;
    let provider = mc_module::embedding::Provider::from_tiers(
        &json!({"embedding": {
            "provider": "openai-compatible",
            "endpoint": endpoint,
            "model": "mock-embed"
        }}),
        &json!({}),
        std::path::Path::new("/"),
    )
    .unwrap();
    let model_id = provider.model_id();
    let chunk_model_id = provider.chunk_model_id();
    // None of these shares a word with the query; only their vectors match it.
    insert_memory(&dir, 2, "Builds verify with the gate script.");
    {
        let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
        db.execute(
            "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?1, 'pj-test', 'aaaaaaa', 'Pin the lockfile before bisecting', 'a', 1, 1)",
            rusqlite::params!["a".repeat(40)],
        )
        .unwrap();
        db.execute(
            "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) VALUES (?1, ?2, ?3, 1)",
            rusqlite::params!["a".repeat(40), vector_blob(&[1.0, 0.0]), model_id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (2, ?1, ?2)",
            rusqlite::params![vector_blob(&[1.0, 0.0]), model_id],
        )
        .unwrap();
        // A summary of messages the session no longer holds raw, with one
        // stored chunk vector.
        db.execute(
            "INSERT INTO compartments (id, session_id, sequence, start_message, end_message, title,
                                       content, p1, created_at, harness)
             VALUES (7, 's1', 0, 50, 60, 'Tracked down a flaky lockfile check', 'Body.', 'Body.', 1, 'mock')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness,
                 window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
             VALUES (7, 's1', 'pj-test', 'mock', 0, 50, 60, 'h', ?1, 2, ?2, 1)",
            rusqlite::params![chunk_model_id, vector_blob(&[1.0, 0.0])],
        )
        .unwrap();
    }
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let settings = Settings {
        git_commits_enabled: true,
        embedding: Some(provider),
        ..Settings::default()
    };
    let mut runner = start_full(config, settings, Some(dir.clone())).await;
    let call = |input: Value| {
        Step::Model(Turn {
            text: Some("Looking.".into()),
            tools: vec![ToolCall::ok("ctx_search", input, "")],
            output_tokens: 5,
            ..Turn::default()
        })
    };
    let mut steps = turn("Start.");
    steps.extend([
        call(json!({"query": "dependency version mismatch", "sources": ["git_commit"]})),
        call(json!({"query": "dependency version mismatch", "sources": ["memory"]})),
        call(json!({"query": "unrelated words", "sources": ["git_commit"]})),
        call(json!({"query": "dependency version mismatch", "sources": ["message"]})),
        answer(),
    ]);
    runner.play(&steps).await;
    assert_clean(&runner);
    let outputs = tool_outputs(runner.host(), "ctx_search");
    assert_eq!(outputs.len(), 4, "{outputs:?}");
    assert!(
        outputs[0].contains("[git_commit] score=0.80 sha=aaaaaaa")
            && outputs[0].contains("match=semantic")
            && outputs[0].contains("Pin the lockfile before bisecting"),
        "{}",
        outputs[0]
    );
    // The memory is found by meaning, and left out because the head shows it.
    assert!(
        outputs[1].contains(
            "Memories: 1 match found, all already visible in your project-memory block (ids 2)."
        ),
        "{}",
        outputs[1]
    );
    assert!(outputs[2].starts_with("No results found"), "{}", outputs[2]);
    // The summary is found through its chunk vector.
    assert!(
        outputs[3].contains(
            "[message] score=0.80 compartment_id=7 range=50-60 match=semantic title=Tracked down a flaky lockfile check"
        ),
        "{}",
        outputs[3]
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 4);
    let _ = std::fs::remove_dir_all(&dir);
}

fn user_texts(host: &Host) -> Vec<String> {
    host.entries()
        .iter()
        .filter(|entry| {
            entry.role == cortexkit_role_compaction::read::Role::User && entry.notice.is_none()
        })
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_persons_message_gets_the_time_since_the_last_one_and_a_hint_of_related_memory() {
    let dir = scratch("pre-user");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    {
        let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
        db.execute(
            "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?1, 'pj-test', 'aaaaaaa', 'Fix zebra parser crash on empty input', 'a', 1, 1)",
            rusqlite::params!["a".repeat(40)],
        )
        .unwrap();
    }
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let settings = Settings {
        git_commits_enabled: true,
        ..Settings::default()
    };
    let mut runner = start_runner(config, settings, Some(dir.clone()), true).await;
    let mut steps = turn("Start.");
    steps.extend([
        Step::Wait { ms: 6 * 60_000 },
        // Without an embedding provider a hint comes from full-text matches,
        // which need every word of the prompt.
        user("Fix zebra parser crash on empty input"),
        answer(),
        user("ok"),
        answer(),
    ]);
    runner.play(&steps).await;
    assert_clean(&runner);
    let texts = user_texts(runner.host());
    assert_eq!(texts.len(), 3, "{texts:?}");
    // The first message follows nothing, and the third follows quickly.
    assert_eq!(texts[0], "Start.");
    assert_eq!(texts[2], "ok");
    // The second comes six minutes after the reply before it, and a commit
    // matches it.
    assert_eq!(
        texts[1],
        "<!-- +6m -->\nFix zebra parser crash on empty input\n\n<ctx-search-hint>\n\
         Your memory may contain 1 related fragment:\n\
         - commit aaaaaaa today: Fix zebra parser crash on empty input\n\
         If the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n\
         </ctx-search-hint>"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_reduce_reminder_rides_the_next_tool_result_once_and_a_reduce_quiets_it() {
    // A large window, so piling up results never reaches the execute
    // threshold: only the reminders act. Each read adds about 7,000 tokens;
    // the newest three are protected. After nine, 6 of 9 results are spent:
    // U/T is about 0.67, the urgent band.
    let mut config = config("worker", Kind::OpenAi, free());
    config.context_window = 400_000;
    let mut runner = start(config).await;
    let mut steps = vec![user("Survey the repository.")];
    steps.extend((0..10).map(|_| read_file(50)));
    steps.push(Step::Model(Turn {
        text: Some("Dropping what I read.".into()),
        tools: vec![ToolCall::ok("ctx_reduce", json!({"drop": "3-13"}), "")],
        output_tokens: 5,
        ..Turn::default()
    }));
    steps.extend((0..3).map(|_| read_file(50)));
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    // A reminder rides a tool result in the tool part's delivered list,
    // after the result, never inside the tool's own output.
    let delivered: Vec<Vec<String>> = runner
        .host()
        .entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Tool(tool) if tool.name == "read" => Some(
                tool.delivered
                    .iter()
                    .map(|delivered| delivered.text.clone().unwrap_or_default())
                    .collect(),
            ),
            _ => None,
        })
        .collect();
    let carrying: Vec<usize> = delivered
        .iter()
        .enumerate()
        .filter(|(_, texts)| !texts.is_empty())
        .map(|(at, _)| at)
        .collect();
    // Decided once the ninth result arrived, carried by the tenth, and not
    // again: neither more reads within the band nor the reads after the
    // reduce grow enough.
    assert_eq!(carrying, vec![9], "{carrying:?}");
    assert!(tool_outputs(runner.host(), "read")
        .iter()
        .all(|output| !output.contains("<system-reminder>")));
    let reminder = &delivered[9][0];
    assert!(
        reminder.starts_with(
            "<system-reminder>\n6 spent tool outputs (~42k tokens) are still unstamped. \
             Call ctx_reduce now, before your next tool call, on every output you've already used.\n\
             oldest reclaimable: §3§ · §5§ · §7§ · §9§.\n</system-reminder>"
        ),
        "{reminder}"
    );
    // It was a plan template send, so the runner knows it for a notice and
    // never as something the person typed.
    let templates: Vec<Option<String>> = runner
        .host()
        .entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Tool(tool) => tool.delivered.first().map(|item| item.template.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        templates,
        [Some("mc.ctx_reduce.urgent.many.h4.v1".to_owned())]
    );
}

/// A runner that never answers any call about the session named `stuck`,
/// and answers the others with an empty transcript.
#[derive(Clone)]
struct StuckClient;

impl StuckClient {
    async fn answer<T>(session: &SessionRef, value: T) -> Result<T, ClientError> {
        if session.session == "stuck" {
            std::future::pending::<()>().await;
        }
        Ok(value)
    }
}

/// It has no routing provider: its sessions never summarize.
impl Router for StuckClient {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        Err(RouteError {
            code: "routing_unavailable".into(),
            message: "no routing here".into(),
        })
    }

    async fn report(&self, _: ReportRequest) {}
}

impl RunnerClient for StuckClient {
    async fn read(&self, session: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        let page = ReadPage::new(Vec::new(), cortexkit_role_compaction::read::Head::new());
        Self::answer(session, page).await
    }

    async fn apply_view(
        &self,
        session: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Self::answer(session, ApplyViewAnswer::Accepted).await
    }

    async fn applied_view(&self, session: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Self::answer(session, AppliedViewAnswer::new()).await
    }

    async fn send(&self, session: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Self::answer(session, SendReply::new("pending")).await
    }

    async fn send_child(&self, child: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Self::answer(&child.session, SendReply::new("pending")).await
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        std::future::pending::<()>().await;
        Err(ClientError(format!("no run {}", request.run_id)))
    }
}

#[tokio::test]
async fn a_session_whose_runner_never_answers_holds_up_no_other_session() {
    let module = Module::new(StuckClient, Settings::default(), None, None);
    let session = |name: &str| SessionRef::new("mock-runner", "mock", name);
    let model = ModelRef::new("test", "test-model");
    let cursor = cortexkit_role_compaction::read::Cursor::new(1, "m0", "d");
    let route = |name: &str| Route {
        session: session(name),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let setup = |newest: Option<cortexkit_role_compaction::read::Cursor>| {
        let mut request = SetupRequest::new(
            "worker",
            model.clone(),
            40_000,
            4_000,
            free(),
            Vec::new(),
            0,
        );
        request.newest = newest;
        request
    };
    // The stuck session's Setup has a transcript to read, and that read
    // never returns: its worker waits for good.
    module
        .setup(route("stuck"), setup(Some(cursor.clone())))
        .unwrap();
    module.setup(route("free"), setup(None)).unwrap();
    let conditions =
        cortexkit_role_compaction::notice::Conditions::new(model.clone(), 40_000, 4_000, free())
            .with_last_prompt_tokens(1_000);
    let notice = || NoticeRequest::new(1, conditions.clone()).with_newest(cursor.clone());
    // A notice is acknowledged at once even for the stuck session; its
    // work waits behind the read.
    assert_eq!(
        module.notice(&session("stuck"), notice()),
        Ok(NoticeAnswer::Received)
    );
    assert_eq!(
        module.notice(&session("free"), notice()),
        Ok(NoticeAnswer::Received)
    );
    let limit = std::time::Duration::from_secs(5);
    tokio::time::timeout(limit, module.idle(&session("free")))
        .await
        .expect("the free session finished its notice")
        .unwrap();
    // A ride on the stuck session answers within its deadline, with nothing.
    let ride = RideRequest::new(vec![RideCause::CacheExpired], 200, conditions);
    let answer = tokio::time::timeout(limit, module.ride(&session("stuck"), ride))
        .await
        .expect("the ride kept its deadline")
        .unwrap();
    assert_eq!(answer, RideAnswer::Nothing);
    // And the free session still answers tools while the stuck one waits.
    let reply = tokio::time::timeout(
        limit,
        module.tool(&route("free"), "ctx_reduce", json!({"drop": "1"})),
    )
    .await
    .expect("the free session answered its tool call");
    assert!(reply.is_err(), "{reply:?}");
}

#[tokio::test]
async fn the_summarizer_reads_at_most_its_quota_per_ten_minutes() {
    // Twelve turns of conversation in one burst: the summarizer has more to
    // read than one ten-minute window allows, so it stops until the window
    // ends, then runs again.
    let mut session = config("head", Kind::OpenAi, free());
    session.cache_ttl_ms = 24 * 3_600_000;
    let mut runner = start(session).await;
    let burst_turn = |prompt: &str| {
        vec![
            user(prompt),
            long_reply(4_000),
            user("Go on."),
            long_reply(4_000),
        ]
    };
    let mut steps = Vec::new();
    for turn_number in 0..12 {
        steps.extend(burst_turn(&format!("Look at file {turn_number}.")));
    }
    runner.play(&steps).await;
    let in_burst = runner.host().child_runs().len();
    runner.play(&burst_turn("And another.")).await;
    let still = runner.host().child_runs().len();
    runner.play(&[Step::Wait { ms: 11 * 60_000 }]).await;
    runner.play(&burst_turn("After a pause.")).await;
    let after = runner.host().child_runs().len();
    assert_clean(&runner);
    assert!(in_burst >= 1, "{in_burst}");
    assert_eq!(still, in_burst);
    assert!(after > still, "{still} -> {after}");
}

#[tokio::test]
async fn a_long_head_session_keeps_ck_mcs_index_window_sized() {
    // Forty turns of four messages each (about 8,000 tokens of conversation,
    // which no automatic lane drops), a quarter of an hour apart, so the
    // summarizer's ten-minute drain quota keeps up. Summaries land with the
    // next rebuild, once usage reaches the threshold every eight turns or
    // so, and each cuts the messages they cover. After a restart, ck-mc reads
    // only what the model still sees, however long the session has run.
    let dir = scratch("long-head");
    let mut session = config("head", Kind::OpenAi, free());
    session.cache_ttl_ms = 24 * 3_600_000;
    let mut runner = start_full(session, Settings::default(), Some(dir.clone())).await;
    let small_turn = |prompt: &str| {
        vec![
            user(prompt),
            long_reply(4_000),
            user("Go on."),
            long_reply(4_000),
        ]
    };
    let mut steps = Vec::new();
    for turn_number in 0..40 {
        steps.extend(small_turn(&format!("Look at file {turn_number}.")));
        steps.push(Step::Wait { ms: 15 * 60_000 });
    }
    runner.play(&steps).await;
    assert_clean(&runner);
    let total = runner.host().entries().len();
    assert!(total >= 160, "{total}");
    runner.provider().client.reads.lock().unwrap().clear();
    runner.provider().restart();
    runner.play(&small_turn("One more.")).await;
    assert_clean(&runner);
    let read: usize = runner
        .provider()
        .client
        .reads
        .lock()
        .unwrap()
        .iter()
        .map(|(_, entries)| entries)
        .sum();
    assert!(read > 0 && read <= 48, "read {read} of {total} entries");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A summary the standalone plugin stored for session `session`, covering
/// the host's messages `start..=end` (1-based numbers) whose ids are given.
fn insert_summary(
    dir: &std::path::Path,
    session: &str,
    sequence: i64,
    (start, start_id): (i64, &str),
    (end, end_id): (i64, &str),
    title: &str,
) {
    let connection = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    connection
        .execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                                       start_message_id, end_message_id, title, content, p1,
                                       created_at, harness)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 1, 'mock')",
            rusqlite::params![
                session,
                sequence,
                start,
                end,
                start_id,
                end_id,
                title,
                format!("{title}: what happened.")
            ],
        )
        .unwrap();
}

#[tokio::test]
async fn a_fully_summarized_standalone_session_moves_in_with_its_history_and_numbers() {
    use mc_module::move_in::{move_in, MoveRequest};
    let dir = scratch("move-in");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    // The standalone plugin summarized all six messages, and its highest
    // tag number was 42.
    insert_summary(
        &dir,
        "s1",
        0,
        (1, "msg00001"),
        (4, "msg00004"),
        "Set up the parser",
    );
    insert_summary(
        &dir,
        "s1",
        1,
        (5, "msg00005"),
        (6, "msg00006"),
        "Fixed the crash",
    );
    {
        let db = rusqlite::Connection::open(dir.join("context.db")).unwrap();
        db.execute(
            "INSERT INTO tags (session_id, message_id, type, tag_number, harness)
             VALUES ('s1', 'msg00006', 'message', 42, 'mock')",
            [],
        )
        .unwrap();
    }
    // Another session whose summaries stop two messages short.
    insert_summary(&dir, "s2", 0, (1, "msg00001"), (4, "msg00004"), "Started");
    let project = mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    };
    let mut session_config = config("head", Kind::OpenAi, free());
    session_config.project = Some(project.clone());
    let request = |session: &str| MoveRequest {
        session: SessionRef::new(
            session_config.session.runner.clone(),
            session_config.session.harness.clone(),
            session,
        ),
        preset: "head".into(),
        project: Some(RouteProject {
            id: project.id.clone(),
            root: project.root.clone(),
        }),
        model: session_config.model.clone(),
        context_window: session_config.context_window,
        output_reserve: session_config.output_reserve,
        rules: free(),
        newest: cortexkit_role_compaction::read::Cursor::new(6, "msg00006", "d"),
        now: 1,
    };
    let config_source = mc_module::config::Config::from(Settings::default());
    let open = || {
        (
            ContextDb::open(&dir.join("context.db")).unwrap(),
            Store::open(&dir.join("mode3.db")).unwrap(),
        )
    };
    let (db, store) = open();
    let refused = move_in(db, &store, &config_source, &request("s2")).unwrap_err();
    assert!(refused.starts_with("session_not_summarized:"), "{refused}");
    let (db, store) = open();
    let moved = move_in(db, &store, &config_source, &request("s1")).unwrap();
    assert_eq!(moved.tag_checkpoint, 42);
    drop(store);
    let (db, store) = open();
    let again = move_in(db, &store, &config_source, &request("s1")).unwrap_err();
    assert!(again.starts_with("session_already_moved:"), "{again}");
    drop(store);

    // The runner's move left the old messages and installed the view; the
    // session goes on from there.
    session_config.tag_checkpoint = moved.tag_checkpoint;
    session_config.moved_in = Some(mc_mock_runner::runner::MovedIn {
        messages: (1..=6)
            .map(|n| {
                let role = if n % 2 == 1 {
                    cortexkit_role_compaction::read::Role::User
                } else {
                    cortexkit_role_compaction::read::Role::Assistant
                };
                (role, format!("Old message {n}."))
            })
            .collect(),
        view: moved.view.clone(),
    });
    let mut runner = start_full(session_config, Settings::default(), Some(dir.clone())).await;
    runner
        .play(&[user("Where were we?"), answer(), user("Go on."), answer()])
        .await;
    assert_clean(&runner);
    let host = runner.host();
    // The model sees the summaries and the memory, none of the old
    // messages, and numbers continuing above 42.
    let (m0, _) = head_texts(host);
    assert!(
        m0.contains("Set up the parser") && m0.contains("Fixed the crash"),
        "{m0}"
    );
    assert!(m0.contains("Ask before pushing."), "{m0}");
    let rendered: String = host
        .rendered()
        .iter()
        .flat_map(|message| &message.parts)
        .map(|part| format!("{part:?}"))
        .collect();
    assert!(!rendered.contains("Old message"), "{rendered}");
    let first = seen(host, 43).unwrap_or_default();
    assert!(first.contains("Where were we?"), "{first}");
    // No rebuild: the first request writes the cache once with the moved
    // view, and the next one reads all of it.
    assert_eq!(host.applied_version(), Some(moved.view.version));
    let requests = &runner.report.requests;
    assert_eq!(
        requests[1].usage.cache_read_tokens,
        requests[0].usage.prompt_tokens
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_session_with_no_setup_gets_its_tools_but_none_that_act_on_a_transcript() {
    // A runner may offer Magic Context's tools to a head it does not have
    // Magic Context compact. That session never has a Setup; its tools still
    // work, on the project the route names.
    let dir = scratch("tools-only");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let module = Module::new(
        StuckClient,
        Settings::default(),
        Some(ContextDb::open(&dir.join("context.db")).unwrap()),
        None,
    );
    let route = Route {
        session: SessionRef::new("mock-runner", "mock", "plain"),
        project: Some(RouteProject {
            id: "pj-test".into(),
            root: dir.to_string_lossy().into_owned(),
        }),
        workdir: Some(dir.to_string_lossy().into_owned()),
        agent_id: None,
    };
    let saved = module
        .tool(
            &route,
            "ctx_note",
            json!({"action": "write", "content": "Ship the fix", "note_ids": []}),
        )
        .await
        .unwrap();
    assert!(saved.starts_with("Saved session note #1."), "{saved}");
    let remembered = module
        .tool(
            &route,
            "ctx_memory",
            json!({"action": "write", "category": "NAMING", "content": "Crates use kebab-case.", "ids": []}),
        )
        .await
        .unwrap();
    assert_eq!(remembered, "Saved memory [ID: 1] in NAMING.");
    let found = module
        .tool(&route, "ctx_search", json!({"query": "kebab-case"}))
        .await
        .unwrap();
    assert!(found.contains("Crates use kebab-case."), "{found}");
    for tool in ["ctx_reduce", "ctx_expand", "ctx_keep"] {
        let refused = module
            .tool(&route, tool, json!({"drop": "1"}))
            .await
            .unwrap_err();
        assert_eq!(
            refused,
            ModuleError::Tool(format!(
                "{tool} works only in a session Magic Context compacts."
            ))
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A session's project gets upkeep: once its Setup and notices name the
/// project, an upkeep round indexes the project's commits into the store the
/// plugin shares; a project no session used gets none.
#[tokio::test]
async fn a_sessions_project_gets_its_commits_indexed() {
    let dir = scratch("upkeep");
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["commit", "-q", "--allow-empty", "-m", "Add the parser"],
        vec!["commit", "-q", "--allow-empty", "-m", "Fix the parser"],
    ] {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(["-c", "commit.gpgsign=false"])
            .args(&args)
            .current_dir(&repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    let settings = Settings {
        git_commits_enabled: true,
        ..Settings::default()
    };
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-upkeep".into(),
        root: repo.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, settings, Some(dir.clone())).await;
    runner.play(&turn("Look at the parser.")).await;
    assert_clean(&runner);
    let reports = runner.provider().module().run_upkeep().await;
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!(reports[0].0, "pj-upkeep");
    assert!(
        matches!(
            reports[0].1.sweep,
            Some(mc_module::upkeep::Sweep::Indexed { inserted: 2, .. })
        ),
        "{reports:?}"
    );
    let conn = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM git_commits WHERE project_path = 'pj-upkeep'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Core may stamp a session's scope with a folder but no project id. ck-mc
/// then serves it with no project: its summaries still run, in child
/// sessions under that folder, while project memories stay out of the head
/// and the summarizer's prompt, and the project gets no upkeep.
#[tokio::test]
async fn a_folder_without_a_project_id_still_summarizes_under_that_folder() {
    let dir = scratch("folder-only");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(&dir, 1, "Ask before pushing.");
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_runner_with(
        config,
        Settings::default(),
        Some(dir.clone()),
        false,
        |route| {
            route.project = None;
        },
    )
    .await;
    runner
        .host()
        .set_responder(mc_mock_runner::child::scripted_summarizer());
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let folders = runner
        .provider()
        .client
        .child_scopes
        .lock()
        .unwrap()
        .clone();
    assert!(!folders.is_empty(), "no summary ran");
    let root = dir.to_string_lossy().into_owned();
    assert!(
        folders
            .iter()
            .all(|folder| folder.as_deref() == Some(root.as_str())),
        "{folders:?}"
    );
    let runs = runner.host().child_runs();
    assert!(!runs[0].prompt.contains("Ask before pushing."));
    assert!(runner.provider().module().run_upkeep().await.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A runner with an empty transcript and a stand-in Synapse that scores a
/// candidate 10 when its document mentions "Zebra" and 0 otherwise. It logs
/// every Synapse method called.
#[derive(Clone, Default)]
struct SynapseClient {
    calls: Arc<Mutex<Vec<String>>>,
}

impl Router for SynapseClient {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        Err(RouteError {
            code: "routing_unavailable".into(),
            message: "no routing here".into(),
        })
    }

    async fn report(&self, _: ReportRequest) {}
}

impl RunnerClient for SynapseClient {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(
            Vec::new(),
            cortexkit_role_compaction::read::Head::new(),
        ))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::new())
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        Err(ClientError(format!("no run {}", request.run_id)))
    }

    async fn synapse_call(
        &self,
        _: &SessionRef,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.calls.lock().unwrap().push(method.to_owned());
        let fingerprint = "a".repeat(64);
        match method {
            "models.list" => Ok(json!({"result": {"table_epoch": 1, "models": [{
                "model_id": mc_module::search::rerank::MODEL,
                "certified": true,
                "fingerprints": [fingerprint],
            }]}})),
            "rerank.score" => {
                let scores: Vec<f64> = params["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|text| {
                        if text.as_str().unwrap().contains("Zebra") {
                            10.0
                        } else {
                            0.0
                        }
                    })
                    .collect();
                Ok(
                    json!({"result": {"fingerprint": fingerprint, "table_epoch": 1, "scores": scores}}),
                )
            }
            _ => Err("unknown_method".into()),
        }
    }
}

/// An explicit search whose query reads as prose answers in the reranker's
/// order; with rerank off the same search keeps the ordinary ranking, and a
/// search for an identifier never asks Synapse.
#[tokio::test]
async fn a_prose_search_answers_in_the_rerankers_order() {
    let dir = scratch("rerank");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_memory(
        &dir,
        1,
        "The parser handles quoted text in the parser module.",
    );
    insert_memory(&dir, 2, "Zebra: quotes stay as written.");
    let root = dir.to_string_lossy().into_owned();
    let route = Route {
        session: SessionRef::new("mock-runner", "mock", "rerank"),
        project: Some(RouteProject {
            id: "pj-test".into(),
            root: root.clone(),
        }),
        workdir: Some(root),
        agent_id: None,
    };
    let query = json!({"query": "how does the parser treat quoted text"});
    let position = |text: &str, needle: &str| text.find(needle).unwrap_or(usize::MAX);
    // Rerank off: the ordinary ranking puts the closer word match first.
    let plain = Module::new(
        SynapseClient::default(),
        Settings {
            rerank: mc_module::search::rerank::Reranker::Off,
            ..Settings::default()
        },
        Some(ContextDb::open(&dir.join("context.db")).unwrap()),
        None,
    );
    let ordinary = plain
        .tool(&route, "ctx_search", query.clone())
        .await
        .unwrap();
    assert!(
        position(&ordinary, "The parser handles") < position(&ordinary, "Zebra"),
        "{ordinary}"
    );
    // Reranked: Synapse's order wins.
    let client = SynapseClient::default();
    let module = Module::new(
        client.clone(),
        Settings::default(),
        Some(ContextDb::open(&dir.join("context.db")).unwrap()),
        None,
    );
    let reranked = module.tool(&route, "ctx_search", query).await.unwrap();
    assert!(
        position(&reranked, "Zebra") < position(&reranked, "The parser handles"),
        "{reranked}"
    );
    assert_eq!(
        *client.calls.lock().unwrap(),
        ["models.list", "rerank.score"]
    );
    client.calls.lock().unwrap().clear();
    module
        .tool(&route, "ctx_search", json!({"query": "parser_module"}))
        .await
        .unwrap();
    assert!(client.calls.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
