//! Witness tests from an audit of ck-mc before go-live. Each test FAILS on
//! the code it was written against and says, in its comments, what correct
//! behaviour would make it pass. They drive ck-mc in process against the mock
//! runner (`mc-mock-runner`), with a trimmed copy of the harness in
//! `tests/scenarios.rs`: that harness's helpers are private to its own test
//! crate, so they cannot be imported from here.

use std::sync::{Arc, Mutex};

use cortexkit_role_compaction::notice::{Conditions, NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Cursor, ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
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
use mc_module::lanes::placeholder;
use mc_module::module::{Module, ModuleError};
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::routing::{RouteError, Router};
use serde_json::{json, Value};

/// ck-mc's calls back into the mock runner, as in `tests/scenarios.rs`.
#[derive(Clone, Default)]
struct HostClient {
    host: Arc<Mutex<Option<Host>>>,
    /// The version of every view ck-mc handed over with `session.apply_view`.
    offered: Arc<Mutex<Vec<u64>>>,
}

impl HostClient {
    fn host(&self) -> Result<Host, ClientError> {
        self.host
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ClientError::new("runner not attached"))
    }
}

/// A stand-in routing provider: always the session's own test model, with a
/// window large enough for a summarizer prompt.
impl Router for HostClient {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let route = RouteRef::new("test", "test-model");
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        Ok(SelectAnswer::new(
            "d1".to_owned(),
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }

    async fn report(&self, _: ReportRequest) {}
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
        .map_err(|error| ClientError::new(format!("{error:?}")))
}

impl RunnerClient for HostClient {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        self.host()?
            .read(&request)
            .map_err(|refusal| ClientError::new(format!("{refusal:?}")))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.offered.lock().unwrap().push(request.view.version);
        Ok(self.host()?.apply_view(request))
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(self.host()?.applied_view())
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        let request: SendRequest = through_wire(&request);
        let reply = self
            .host()?
            .send(&session.session, request)
            .map_err(|refusal| ClientError::new(format!("{refusal:?}")))?;
        read_wrapped(&reply)
    }

    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.send(&child.session, request).await
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        let request: RunResultRequest = through_wire(&request);
        let result = self
            .host()?
            .run_result(&request)
            .ok_or_else(|| ClientError::new(format!("unknown run {}", request.run_id)))?;
        read_wrapped(&result)
    }
}

/// ck-mc in process, reached on one session's routes. Each notice is handled
/// before the runner's next step, which keeps the assertions exact.
struct InProcess {
    module: Module<HostClient>,
    route: Route,
    client: HostClient,
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
        self.module
            .setup(self.route.clone(), request)
            .map_err(call_error)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        let session = &self.route.session;
        let answer = self.module.notice(session, request).map_err(call_error)?;
        if answer == NoticeAnswer::Received {
            self.module.idle(session).await.map_err(call_error)?;
        }
        Ok(answer)
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.module
            .ride(&self.route.session, request)
            .await
            .map_err(call_error)
    }

    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        self.module
            .tool(&self.route, name, input.clone())
            .await
            .map_err(call_error)
    }

    async fn pre_user(&self, _: &str, _: u64) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

fn free() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

/// The scenario suite's session: a worker's usable window is 39,000 tokens
/// (execute threshold 25,350), a head's 99,000 (threshold 64,350).
fn config(preset: &str) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: preset.into(),
        model: ModelRef::new("test", "test-model"),
        context_window: if preset == "head" { 100_000 } else { 40_000 },
        output_reserve: 1_000,
        rules: free(),
        kind: Kind::OpenAi,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        templates: mc_module::nudges::templates(),
        accepts_images: None,
    }
}

async fn start(config: SessionConfig) -> Runner<InProcess> {
    let client = HostClient::default();
    let route = Route {
        session: config.session.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let provider = InProcess {
        module: Module::new(client.clone(), Settings::default(), None, None),
        route,
        client,
    };
    let runner = Runner::start(config, provider).await.unwrap();
    *runner.provider().client.host.lock().unwrap() = Some(runner.host().clone());
    runner
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

/// Some reasoning, a sentence (one tag) and a `read` whose result is about
/// 7,000 tokens (one tag).
fn read_file() -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(50),
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

fn model_calls(name: &str, input: Value) -> Step {
    Step::Model(Turn {
        text: Some("Next.".into()),
        tools: vec![ToolCall::ok(name, input, "")],
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

/// The start of the text the model sees for the part numbered `tag`.
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

/// A head's history head is folded (`m[0]` rendered again) when the settings
/// `m[0]` depends on change (`session.rs` `head_shape_changed`). The history
/// budget in that shape is computed from the usable window the runner
/// reports on every notice, and any difference counts. So a notice whose
/// window merely grew, with no ride and the cache warm, marks the head
/// stale, and a stale head gives the pass rebuild permission whatever the
/// usage: every lane with work lands below the execute threshold.
///
/// The TypeScript reference compares the configured budget policy, not the
/// live window ("Catalog refreshes and accepted-input measurements can change
/// the available window without a user config edit, so they must not
/// invalidate the cached m[0] prefix", `event-resolvers.ts`
/// `historyBudgetPolicyIdentity`), and folds on a numeric budget change only
/// when it shrinks by more than max(64 tokens, 1%)
/// (`compartment-render-epoch.ts` `renderedBudgetShrinkReason`: "growth
/// never triggers").
///
/// Passes when a window that grows (or changes within the tolerance) neither
/// folds `m[0]` nor gives a pass below the threshold rebuild permission: no
/// view is handed over and the queued drop of tag 3 keeps waiting.
#[tokio::test]
async fn a_head_whose_reported_window_grows_publishes_no_view_below_the_threshold() {
    let mut runner = start(config("head")).await;
    // Tags: task 1; reads 2/3 and 4/5; the ctx_reduce step 6/7; reads 8/9,
    // 10/11 and 12/13, which take tag 3 out of the protected tail.
    runner
        .play(&[
            user("Review the module."),
            read_file(),
            read_file(),
            model_calls("ctx_reduce", json!({"drop": "3"})),
            read_file(),
            read_file(),
            read_file(),
            answer(),
        ])
        .await;
    let host = runner.host().clone();
    let last = runner.report.requests.last().unwrap().clone();
    let prompt = last.usage.prompt_tokens.unwrap();
    // Well below the head's execute threshold (64,350 of 99,000).
    assert!(prompt < 50_000, "prompt {prompt}");
    // The drop is queued, not applied.
    assert_eq!(
        seen(&host, 3)
            .as_deref()
            .map(|text| text.starts_with("§3§")),
        Some(true)
    );
    let offered_before = runner.provider().client.offered.lock().unwrap().len();

    // The runner's next notice reports a larger window for the same model
    // (a catalog refresh, or a configured limit raised). Nothing else
    // changed, and the prompt cache is still warm, so the runner sent no
    // ride (its `compaction.ride` call before a request that rewrites the
    // cache anyway, which would give ck-mc free rebuild permission).
    let newest = host
        .entries()
        .last()
        .map(|entry| Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone()));
    let mut conditions =
        Conditions::new(ModelRef::new("test", "test-model"), 120_000, 1_000, free());
    conditions.last_prompt_tokens = Some(prompt);
    let mut notice = NoticeRequest::new(10_000, conditions);
    notice.newest = newest;
    notice.applied_view = host.applied_view().view.map(|view| view.applied());
    let provider = runner.provider();
    assert_eq!(
        provider.module.notice(&provider.route.session, notice),
        Ok(NoticeAnswer::Received)
    );
    provider.module.idle(&provider.route.session).await.unwrap();

    let offered = provider.client.offered.lock().unwrap().clone();
    assert_eq!(
        offered.len(),
        offered_before,
        "a window that grew at {:.0}% usage made ck-mc hand over view(s) {:?}",
        prompt as f64 / 1190.0,
        &offered[offered_before..]
    );
}

/// `ctx_keep` records what to keep, and the next notice builds the view that
/// keeps only that, the first message and the protected tail (spec 2 KP3:
/// "everything else goes ... It lands whatever the usage"). But when none of
/// the listed tags can be kept (not found, or each over the cap), the
/// recorded list is empty, and the next notice's `forget_missing` removes an
/// empty keep list before the keep is built (`session.rs` `forget_missing`:
/// `if kept.is_empty() { self.pending_keep = None }`). No view is built,
/// while the tool told the model "Keeping only your task and the newest
/// items. ... Everything else before this call is removed before your next
/// step." The model carries on believing its context was freed.
///
/// Passes when such a keep still lands: the next notice hands over a view
/// that drops what precedes the protected tail, here the first read's result
/// (tag 3) and the sentence before it (tag 2).
#[tokio::test]
async fn a_keep_that_names_no_keepable_tag_still_clears_the_context() {
    let mut runner = start(config("worker")).await;
    // Tags: task 1; reads 2/3, 4/5 and 6/7; the ctx_keep step 8/9. The
    // protected tail starts at tag 5 (the newest three tool calls).
    runner
        .play(&[
            user("Review the module."),
            read_file(),
            read_file(),
            read_file(),
            model_calls(
                "ctx_keep",
                json!({"tags": "999", "note": "Reviewed a.rs three times; next, write the report."}),
            ),
            answer(),
            answer(),
        ])
        .await;
    let report = &runner.report;
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    let host = runner.host();
    // The keep was accepted: its answer says what the next step will see.
    let keep_answer = host
        .entries()
        .iter()
        .flat_map(|entry| entry.parts.clone())
        .find_map(|part| match part.body {
            PartBody::Tool(tool) if tool.name == "ctx_keep" => tool.output,
            _ => None,
        })
        .expect("the ctx_keep call has a result");
    assert!(
        keep_answer.starts_with("Keeping only your task and the newest items."),
        "{keep_answer}"
    );
    let offered = runner.provider().client.offered.lock().unwrap().clone();
    assert!(
        !offered.is_empty() && host.applied_version().is_some(),
        "the keep was dropped: no view was handed over (offered {offered:?}), so tag 3 \
         still shows as {:?}",
        seen(host, 3)
    );
    assert_ne!(seen(host, 2).as_deref(), Some("§2§ Reading the next file."));
    assert!(
        seen(host, 3).is_none() || seen(host, 3).as_deref() == Some(placeholder(3).as_str()),
        "{:?}",
        seen(host, 3)
    );
}
