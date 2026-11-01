//! ck-mc against the mock runner, in process. The mock runner and its mock
//! model providers enforce what real ones do (prompt caching, signed
//! reasoning, the window), so a scenario fails here the way it would fail on
//! a real runner. The wire suite (`wire.rs`) runs them through a real subc
//! daemon, the module bus that routes calls between module processes; here each notice is handled before the runner's next step, which
//! keeps the assertions exact.

use std::sync::{Arc, Mutex};

use ck_contract_draft::notice::{NoticeAnswer, NoticeRequest};
use ck_contract_draft::part::PartBody;
use ck_contract_draft::read::{ReadPage, ReadRequest, SessionRef};
use ck_contract_draft::ride::{RideAnswer, RideCause, RideRequest};
use ck_contract_draft::rules::{EditCost, ProviderRules, SignedReasoning};
use ck_contract_draft::setup::{ModelRef, SetupAnswer, SetupRequest};
use ck_contract_draft::view::{
    View, ViewCurrentAnswer, ViewCurrentRequest, ViewGetRequest, ViewPublishAnswer,
    ViewPublishRequest,
};
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{CallError, Host, Provider, Runner, SessionConfig, UserEdit};
use mc_mock_runner::script::{Step, ToolCall, Turn};
use mc_module::client::{ClientError, RunnerClient};
use mc_module::lanes::placeholder;
use mc_module::module::{Module, ModuleError};
use mc_module::pass::Settings;
use serde_json::{json, Value};

/// ck-mc's calls back into the mock runner. The runner exists only after its
/// Setup call, so the host is attached right after it starts.
#[derive(Clone, Default)]
struct HostClient(Arc<Mutex<Option<Host>>>);

impl HostClient {
    fn host(&self) -> Result<Host, ClientError> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ClientError("runner not attached".into()))
    }
}

impl RunnerClient for HostClient {
    async fn read(&self, request: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(self.host()?.read(&request))
    }

    async fn publish(&self, request: ViewPublishRequest) -> Result<ViewPublishAnswer, ClientError> {
        Ok(self.host()?.publish(request))
    }

    async fn current(&self, _: ViewCurrentRequest) -> Result<ViewCurrentAnswer, ClientError> {
        Ok(self.host()?.current())
    }
}

struct InProcess {
    module: Module<HostClient>,
    client: HostClient,
}

fn call_error(error: ModuleError) -> CallError {
    match error {
        ModuleError::Tool(text) => CallError(text),
        other => CallError(format!("{other:?}")),
    }
}

impl Provider for InProcess {
    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.module.setup(request).map_err(call_error)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        let session = request.session.clone();
        let answer = self.module.notice(request).map_err(call_error)?;
        self.module.idle(&session).await.map_err(call_error)?;
        Ok(answer)
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.module.ride(request).await.map_err(call_error)
    }

    async fn view_get(&self, request: ViewGetRequest) -> Result<View, CallError> {
        self.module.view_get(request).await.map_err(call_error)
    }

    async fn tool(
        &self,
        session: &SessionRef,
        name: &str,
        input: &Value,
    ) -> Result<String, CallError> {
        self.module
            .tool(session, name, input.clone())
            .await
            .map_err(call_error)
    }

    async fn pre_user(&self, _: &SessionRef, _: &str) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

const FREE: ProviderRules = ProviderRules {
    signed_reasoning: SignedReasoning::None,
    history_edit_cost: EditCost::Suffix,
};

const BOUND: ProviderRules = ProviderRules {
    signed_reasoning: SignedReasoning::Bound,
    history_edit_cost: EditCost::Suffix,
};

/// A session whose usable window is 39,000 tokens, so the execute threshold
/// (65%) sits at 25,350.
fn config(preset: &str, kind: Kind, rules: ProviderRules) -> SessionConfig {
    SessionConfig {
        session: SessionRef {
            runner: "mock-runner".into(),
            harness: "mock".into(),
            session: "s1".into(),
        },
        preset: preset.into(),
        model: ModelRef {
            provider: "test".into(),
            model: "test-model".into(),
            variant: None,
            service_tier: None,
        },
        context_window: 40_000,
        output_reserve: 1_000,
        rules,
        kind,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        start_ms: 1_000_000,
        model_latency_ms: 0,
    }
}

async fn start(config: SessionConfig) -> Runner<InProcess> {
    start_with(config, Settings::default()).await
}

async fn start_with(config: SessionConfig, settings: Settings) -> Runner<InProcess> {
    let client = HostClient::default();
    let provider = InProcess {
        module: Module::new(client.clone(), settings),
        client,
    };
    let runner = Runner::start(config, provider).await.unwrap();
    *runner.provider().client.0.lock().unwrap() = Some(runner.host().clone());
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
    let mut runner = start(config("worker", Kind::OpenAi, FREE)).await;
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

#[tokio::test]
async fn nothing_lands_below_the_threshold_and_a_worker_never_drops_its_task() {
    let mut runner = start(config("worker", Kind::OpenAi, FREE)).await;
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
    let mut runner = start(config("worker", Kind::Anthropic, BOUND)).await;
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
    let mut runner = start(config("worker", Kind::OpenAi, FREE)).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            reduce("3"),
            Step::Wait { ms: 300_001 },
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    let rides = &runner.report.rides;
    assert_eq!(rides.len(), 1);
    assert_eq!(rides[0].cause, RideCause::CacheExpired);
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
    let count = |parts: &mut dyn Iterator<Item = &ck_contract_draft::part::Part>| {
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
    let mut runner = start(config("worker", Kind::OpenAi, FREE)).await;
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
    for (kind, rules) in [(Kind::OpenAi, FREE), (Kind::Anthropic, BOUND)] {
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
