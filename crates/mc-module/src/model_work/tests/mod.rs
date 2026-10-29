#[rustfmt::skip]
pub(crate) mod kit_fake;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cortexkit_role_routing::{
    errors::{NoRouteReason, PinUnavailableReason},
    select::{RouteRef, RunnerAuth, ToolsRequirement},
    wire,
};
use cortexkit_role_routing_conformance::{
    fixture, ConsumerConfig, Reply, RouteStamp, RoutingRoute, RoutingSubject,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use kit_fake::{Defects, FakeRoute, FakeSubject};

const PROVIDER: &str = "routing-provider";
const PROJECT: &str = "project-one";
const CONSUMER: &str = "mc_dream_verify";

#[derive(Clone)]
struct TestClock(Arc<Mutex<u64>>);

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        *self.0.lock().unwrap()
    }
}

impl TestClock {
    fn set(&self, now: u64) {
        *self.0.lock().unwrap() = now;
    }
}

#[derive(Default)]
struct Trace {
    events: Vec<String>,
    selects: Vec<Value>,
    answers: Vec<RoutedChoice>,
    reports: Vec<ReportRequest>,
    sends: Vec<RoutedChoice>,
}

#[derive(Debug, PartialEq, Eq)]
struct LoggedReport {
    provider: String,
    scope_key: String,
    decision_id: String,
}

impl From<&PendingReport> for LoggedReport {
    fn from(pending: &PendingReport) -> Self {
        Self {
            provider: pending.provider.clone(),
            scope_key: pending.scope_key.clone(),
            decision_id: pending.report.decision_id.clone(),
        }
    }
}

#[derive(Default)]
struct ReportLogRecords {
    unacknowledged: Vec<LoggedReport>,
    evicted: Vec<LoggedReport>,
}

struct RecordingReportLog(Arc<Mutex<ReportLogRecords>>);

impl ReportLog for RecordingReportLog {
    fn unacknowledged(&self, pending: &PendingReport) {
        self.0.lock().unwrap().unacknowledged.push(pending.into());
    }

    fn evicted(&self, pending: &PendingReport) {
        self.0.lock().unwrap().evicted.push(pending.into());
    }
}

struct TestRoute {
    route: FakeRoute,
    project: String,
    scope_key: String,
    trace: Arc<Mutex<Trace>>,
    report_failure: Mutex<Option<Refusal>>,
    report_hangs: bool,
    answer_auth: Option<RunnerAuth>,
    after_select: Option<(TestClock, u64)>,
}

fn decode<T: DeserializeOwned>(reply: Reply) -> Result<T, Refusal> {
    match reply {
        Reply::Response(text) => Ok(wire::read_reply(text.as_bytes()).unwrap()),
        Reply::Error(error) => {
            Err(serde_json::from_value(serde_json::to_value(error).unwrap()).unwrap())
        }
    }
}

impl ScopeRoute for TestRoute {
    fn scope_key(&self) -> &str {
        &self.scope_key
    }

    fn project_key(&self) -> &str {
        &self.project
    }

    async fn select(
        &self,
        provider: &str,
        request: &SelectParams,
    ) -> Result<RoutedChoice, Refusal> {
        assert_eq!(provider, PROVIDER);
        let params = serde_json::to_value(request).unwrap();
        {
            let mut trace = self.trace.lock().unwrap();
            trace.events.push("select".into());
            trace.selects.push(params.clone());
        }
        let mut answer: RoutedChoice =
            decode(self.route.request("route.select", &params).await.unwrap())?;
        // The kit does not model runner auth; emulate a provider that names a pool.
        answer.runner.auth = self.answer_auth.clone();
        self.trace.lock().unwrap().answers.push(answer.clone());
        if let Some((clock, now)) = &self.after_select {
            clock.set(*now);
        }
        Ok(answer)
    }

    async fn report(
        &self,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        assert_eq!(provider, PROVIDER);
        {
            let mut trace = self.trace.lock().unwrap();
            trace.events.push("report".into());
            trace.reports.push(request.clone());
        }
        if let Some(error) = self.report_failure.lock().unwrap().take() {
            return Err(error);
        }
        if self.report_hangs {
            return std::future::pending().await;
        }
        decode(
            self.route
                .request("route.report", &serde_json::to_value(request).unwrap())
                .await
                .unwrap(),
        )
    }
}

enum Behavior {
    Result(RunResult<String>),
    Pending,
}

struct TestRunner {
    results: Mutex<VecDeque<Behavior>>,
    trace: Arc<Mutex<Trace>>,
    clock: TestClock,
    advance_on_send: Option<u64>,
}

impl Runner<TestRoute> for TestRunner {
    type Output = String;

    async fn send(&self, scope: &TestRoute, choice: &RoutedChoice, _: u64) -> RunResult<String> {
        assert_eq!(scope.project_key(), PROJECT);
        {
            let mut trace = self.trace.lock().unwrap();
            trace.events.push("send".into());
            trace.sends.push(choice.clone());
        }
        if let Some(now) = self.advance_on_send {
            self.clock.set(now);
        }
        let behavior = self
            .results
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra send");
        match behavior {
            Behavior::Result(result) => result,
            Behavior::Pending => std::future::pending().await,
        }
    }

    async fn cancel(&self, _: &TestRoute, _: &RoutedChoice) {
        self.trace.lock().unwrap().events.push("cancel".into());
    }
}

struct Rig {
    subject: FakeSubject,
    route: TestRoute,
    clock: TestClock,
}

impl Rig {
    async fn new() -> Self {
        let subject = FakeSubject::new(Defects::default());
        subject
            .configure_catalog(&fixture::catalog())
            .await
            .unwrap();
        subject
            .configure_consumers(&[
                ConsumerConfig {
                    id: CONSUMER.into(),
                    priced_only: false,
                },
                ConsumerConfig {
                    id: "mc_summary".into(),
                    priced_only: false,
                },
            ])
            .await
            .unwrap();
        let route = subject
            .route(&RouteStamp::project("ck-mc", PROJECT))
            .await
            .unwrap();
        Self {
            subject,
            route: TestRoute {
                route,
                project: PROJECT.into(),
                scope_key: "daemon-scope-a".into(),
                trace: Arc::new(Mutex::new(Trace::default())),
                report_failure: Mutex::new(None),
                report_hangs: false,
                answer_auth: None,
                after_select: None,
            },
            clock: TestClock(Arc::new(Mutex::new(WallClock.now_ms()))),
        }
    }

    fn order(&self) -> WorkOrder<'_, TestRoute> {
        WorkOrder {
            scope_route: &self.route,
            work_id: "work-42".into(),
            consumer: CONSUMER.into(),
            requirements: Requirements::iq(50),
            pin: None,
            affinity: "stable-task-prefix".into(),
            concurrency_slots: None,
            deadline_ms: self.clock.now_ms() + 600_000,
            max_decisions: 3,
            hold_ok: None,
        }
    }

    fn runner(&self, results: Vec<RunResult<String>>) -> TestRunner {
        TestRunner {
            results: Mutex::new(results.into_iter().map(Behavior::Result).collect()),
            trace: self.route.trace.clone(),
            clock: self.clock.clone(),
            advance_on_send: None,
        }
    }
}

fn catalog() -> RoutingCatalog {
    RoutingCatalog {
        generation: 1,
        providers: vec![PROVIDER.into()],
    }
}

fn completed() -> RunResult<String> {
    RunResult::new(Outcome::Completed, Some("validated result".into()))
}

fn failed(code: &str) -> RunResult<String> {
    let mut result = RunResult::new(Outcome::Failed, None);
    result.runner_code = Some(code.into());
    result
}

#[test]
fn vendored_kit_fake_matches_published_source() {
    let source = include_str!("kit_fake.rs");
    let (_, body) = source.split_once("// BEGIN VENDORED BODY\n").unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(body.as_bytes())),
        "ef60939ceaff9be40af1a89bbf56f3a5bb1d5acaeea71527f2ab604db8e2db6f"
    );
}

#[tokio::test]
async fn selected_runner_model_auth_and_limits_are_used_exactly() {
    let mut rig = Rig::new().await;
    rig.route.answer_auth = Some(RunnerAuth {
        pool: Some("pool-one".into()),
        credential_id: Some("key-public-id".into()),
    });
    let mut order = rig.order();
    order.requirements.tools = Some(ToolsRequirement::Required);
    order.requirements.tool_capabilities = Some(vec![fixture::TAG_TWO.into()]);
    order.requirements.eq = Some(42);
    order.pin = Some("example-provider/model-b:careful".into());
    order.concurrency_slots = Some(vec![ConcurrencySlot {
        key: "dream-verify".into(),
        running: 0,
        limit: 1,
        queued: Some(0),
    }]);
    let runner = rig.runner(vec![completed()]);
    let done = Engine::new(rig.clock.clone())
        .run(&catalog(), &order, &runner)
        .await
        .unwrap();
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.events, ["select", "send", "report"]);
    assert_eq!(trace.sends, trace.answers);
    assert_eq!(trace.sends[0].runner.module, fixture::RUNNER_TWO);
    assert_eq!(
        trace.sends[0].runner.model.pin(),
        "example-provider/model-b:careful"
    );
    assert_eq!(trace.sends[0].runner.auth, rig.route.answer_auth);
    assert_eq!(
        (done.choice.context_window, done.choice.max_output_tokens),
        (128_000, 16_000)
    );
    assert_eq!(done.output, "validated result");
    assert_eq!(trace.selects[0]["requirements"]["eq"], 42);
    assert_eq!(
        trace.selects[0]["concurrency_slots"][0]["key"],
        "dream-verify"
    );
}

#[tokio::test]
async fn scope_is_only_on_route_never_in_select_body() {
    let rig = Rig::new().await;
    rig.subject
        .pin_for_project(PROJECT, CONSUMER, "example-provider/model-b")
        .await
        .unwrap();
    let mut order = rig.order();
    order.requirements.tools = Some(ToolsRequirement::None);
    let done = Engine::new(rig.clock.clone())
        .run(&catalog(), &order, &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert_eq!(
        done.choice.route,
        RouteRef::new("example-provider", "model-b")
    );
    let trace = rig.route.trace.lock().unwrap();
    let body = &trace.selects[0];
    assert_eq!(
        body,
        &json!({
            "consumer": "mc_dream_verify", "requirements": {"iq":50, "tools":"none"},
            "affinity":"stable-task-prefix", "correlation_id":"work-42"
        })
    );
    for forbidden in [
        "project",
        "project_id",
        "session",
        "session_id",
        "workdir",
        "scope",
        "runners",
    ] {
        assert!(
            body.get(forbidden).is_none(),
            "unexpected select member {forbidden}"
        );
    }
}

#[tokio::test]
async fn retry_excludes_every_failed_route() {
    let rig = Rig::new().await;
    let runner = rig.runner(vec![
        failed("runner_first_error"),
        failed("runner_second_error"),
        completed(),
    ]);
    let done = Engine::new(rig.clock.clone())
        .run(&catalog(), &rig.order(), &runner)
        .await
        .unwrap();
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 3);
    assert!(trace.selects[0].get("exclude").is_none());
    assert_eq!(
        trace.selects[1]["exclude"],
        json!(["example-provider/model-a"])
    );
    assert_eq!(
        trace.selects[2]["exclude"],
        json!(["example-provider/model-a", "example-provider/model-b"])
    );
    assert_eq!(trace.sends[1].route.model, "model-b");
    assert_eq!(trace.sends[2].route.model, "model-c");
    assert_eq!(
        trace
            .reports
            .iter()
            .map(|r| r.outcome.clone())
            .collect::<Vec<_>>(),
        vec![Outcome::Failed, Outcome::Failed, Outcome::Completed]
    );
    assert_eq!(done.attempts.len(), 3);
}

#[tokio::test]
async fn runner_refusal_is_reported_before_retry() {
    let rig = Rig::new().await;
    let mut refused = RunResult::new(Outcome::Refused, None);
    refused.runner_code = Some("runner_budget_refused_verbatim".into());
    refused.credential_id = Some("credential-73".into());
    refused.reset_at_ms = Some(rig.clock.now_ms() + 60_000);
    let runner = rig.runner(vec![refused, completed()]);
    let done = Engine::new(rig.clock.clone())
        .run(&catalog(), &rig.order(), &runner)
        .await
        .unwrap();
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(
        trace.events,
        ["select", "send", "report", "select", "send", "report"]
    );
    let report = &trace.reports[0];
    assert_eq!(report.outcome, Outcome::Refused);
    assert_eq!(
        report.runner_code.as_deref(),
        Some("runner_budget_refused_verbatim")
    );
    assert_eq!(report.credential_id.as_deref(), Some("credential-73"));
    assert_eq!(report.reset_at_ms, Some(rig.clock.now_ms() + 60_000));
    assert_eq!(done.attempts[0].report, *report);
    assert_eq!(trace.reports[1].outcome, Outcome::Completed);
}

#[tokio::test]
async fn timed_no_route_parks_until_reset_without_early_select() {
    let rig = Rig::new().await;
    let reset = rig.clock.now_ms() + 60_000;
    for model in fixture::catalog().models {
        rig.subject
            .cool_down(&model.route_key(), reset)
            .await
            .unwrap();
    }
    let runner = rig.runner(vec![completed()]);
    let mut engine = Engine::new(rig.clock.clone());
    let mut order = rig.order();
    let error = engine.run(&catalog(), &order, &runner).await.unwrap_err();
    assert_eq!(error.code, "mc_route_waiting");
    assert_eq!(error.reset_at_ms, Some(reset));
    assert_eq!(error.source.unwrap().code, RefusalCode::NoRoute);
    assert!(error.attempts.is_empty());
    // A different work id in the same project/consumer shares the park.
    order.work_id = "another-due-task".into();
    rig.clock.set(reset - 1);
    let error = engine.run(&catalog(), &order, &runner).await.unwrap_err();
    assert_eq!(error.code, "mc_route_waiting");
    {
        let trace = rig.route.trace.lock().unwrap();
        assert_eq!(trace.events, ["select"]);
        assert!(trace.sends.is_empty());
        assert!(trace.reports.is_empty());
    }
    // The kit uses wall time; release cooldowns as our injected clock reaches reset.
    for model in fixture::catalog().models {
        rig.subject.cool_down(&model.route_key(), 0).await.unwrap();
    }
    rig.clock.set(reset);
    engine.run(&catalog(), &order, &runner).await.unwrap();
    assert_eq!(rig.route.trace.lock().unwrap().selects.len(), 2);
}

#[tokio::test]
async fn untimed_no_route_preserves_source_and_allows_next_trigger() {
    let rig = Rig::new().await;
    let mut order = rig.order();
    order.requirements.iq = 100;
    let mut engine = Engine::new(rig.clock.clone());
    let runner = rig.runner(vec![]);
    for _ in 0..2 {
        let error = engine.run(&catalog(), &order, &runner).await.unwrap_err();
        assert_eq!(error.code, "mc_no_route");
        assert_eq!(error.reset_at_ms, None);
        assert_eq!(error.source.unwrap().code, RefusalCode::NoRoute);
    }
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 2);
    assert!(trace.sends.is_empty());
    assert!(trace.reports.is_empty());
}

#[tokio::test]
async fn misconfiguration_is_cached_until_catalog_generation_changes() {
    for unknown_consumer in [true, false] {
        let rig = Rig::new().await;
        let mut order = rig.order();
        let expected = if unknown_consumer {
            order.consumer = "mc_dream_not_registered".into();
            Refusal::unknown_consumer("mc_dream_not_registered")
        } else {
            order
                .requirements
                .unknown
                .insert("gpu_count".into(), json!(1));
            Refusal::invalid_requirements("gpu_count", "requirement is not defined by routing/v1")
        };
        let runner = rig.runner(vec![completed()]);
        let mut engine = Engine::new(rig.clock.clone());
        let first = engine.run(&catalog(), &order, &runner).await.unwrap_err();
        assert_eq!(first.code, "mc_route_misconfigured");
        let source = first.source.unwrap();
        assert_eq!(source.code, expected.code);
        assert_eq!(source.detail, expected.detail);
        let again = engine.run(&catalog(), &order, &runner).await.unwrap_err();
        assert_eq!(again.source, Some(source));
        assert_eq!(rig.route.trace.lock().unwrap().selects.len(), 1);
        rig.subject
            .configure_consumers(&[ConsumerConfig {
                id: order.consumer.clone(),
                priced_only: false,
            }])
            .await
            .unwrap();
        order.requirements.unknown.clear();
        let catalog = RoutingCatalog {
            generation: 2,
            ..catalog()
        };
        engine.run(&catalog, &order, &runner).await.unwrap();
        assert_eq!(rig.route.trace.lock().unwrap().selects.len(), 2);
    }
}

#[tokio::test]
async fn deadline_cancels_reports_timeout_and_stops() {
    let rig = Rig::new().await;
    let mut order = rig.order();
    order.deadline_ms = rig.clock.now_ms() + 10;
    let mut runner = rig.runner(vec![]);
    runner.results.lock().unwrap().push_back(Behavior::Pending);
    runner.advance_on_send = Some(order.deadline_ms);
    let error = Engine::new(rig.clock.clone())
        .run(&catalog(), &order, &runner)
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_run_timed_out");
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.events, ["select", "send", "cancel", "report"]);
    assert_eq!(trace.reports[0].outcome, Outcome::TimedOut);
    assert_eq!(error.attempts.len(), 1);
}

#[tokio::test]
async fn deadline_reached_during_select_reports_without_sending() {
    let mut rig = Rig::new().await;
    let deadline = rig.clock.now_ms() + 1_000;
    rig.route.after_select = Some((rig.clock.clone(), deadline));
    let mut order = rig.order();
    order.deadline_ms = deadline;
    let error = Engine::new(rig.clock.clone())
        .run(&catalog(), &order, &rig.runner(vec![]))
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_run_timed_out");
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.events, ["select", "report"]);
    assert_eq!(trace.reports[0].outcome, Outcome::TimedOut);
}

#[tokio::test]
async fn per_send_timeout_retries_once_when_work_deadline_allows() {
    let rig = Rig::new().await;
    let runner = rig.runner(vec![RunResult::new(Outcome::TimedOut, None), completed()]);
    Engine::new(rig.clock.clone())
        .run(&catalog(), &rig.order(), &runner)
        .await
        .unwrap();
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(
        trace.events,
        ["select", "send", "cancel", "report", "select", "send", "report"]
    );
    assert_eq!(trace.reports[0].outcome, Outcome::TimedOut);
    assert_eq!(
        trace.selects[1]["exclude"],
        json!(["example-provider/model-a"])
    );
}

#[tokio::test]
async fn repeated_send_timeouts_do_not_retry_more_than_once() {
    let rig = Rig::new().await;
    let runner = rig.runner(vec![
        RunResult::new(Outcome::TimedOut, None),
        RunResult::new(Outcome::TimedOut, None),
    ]);
    let error = Engine::new(rig.clock.clone())
        .run(&catalog(), &rig.order(), &runner)
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_run_timed_out");
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.sends.len(), 2);
    assert_eq!(trace.reports.len(), 2);
}

#[tokio::test]
async fn max_decisions_preserves_verbatim_runner_codes_for_caller() {
    let rig = Rig::new().await;
    let runner = rig.runner(vec![
        failed("runner_one"),
        failed("runner_two"),
        failed("new_code_verbatim"),
    ]);
    let error = Engine::new(rig.clock.clone())
        .run(&catalog(), &rig.order(), &runner)
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_route_exhausted");
    assert_eq!(error.attempts.len(), 3);
    assert_eq!(
        error.attempts[2].report.runner_code.as_deref(),
        Some("new_code_verbatim")
    );
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 3);
    assert_eq!(trace.reports.len(), 3);
}

#[tokio::test]
async fn unknown_outcome_ends_affinity_and_is_reported_unchanged() {
    let rig = Rig::new().await;
    let mut engine = Engine::new(rig.clock.clone());
    let mut order = rig.order();
    order.pin = Some("example-provider/model-b".into());
    let first = engine
        .run(&catalog(), &order, &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert_eq!(first.choice.route.model, "model-b");
    order.pin = None;
    order.max_decisions = 1;
    let unknown = Outcome::Other("future_terminal_state".into());
    assert!(unknown.is_failure());
    let error = engine
        .run(
            &catalog(),
            &order,
            &rig.runner(vec![RunResult::new(unknown.clone(), None)]),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_route_exhausted");
    assert_eq!(error.attempts[0].choice.route.model, "model-b");
    assert_eq!(error.attempts[0].report.outcome, unknown);
    let next = engine
        .run(&catalog(), &order, &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert_eq!(next.choice.route.model, "model-a");
}

#[tokio::test]
async fn no_provider_or_ambiguous_provider_sends_nothing_and_is_generation_cached() {
    let rig = Rig::new().await;
    let runner = rig.runner(vec![]);
    let mut engine = Engine::new(rig.clock.clone());
    let absent = RoutingCatalog {
        generation: 1,
        providers: vec![],
    };
    assert_eq!(
        engine
            .run(&absent, &rig.order(), &runner)
            .await
            .unwrap_err()
            .code,
        "routing_provider_missing"
    );
    assert_eq!(
        engine
            .run(&catalog(), &rig.order(), &runner)
            .await
            .unwrap_err()
            .code,
        "routing_provider_missing"
    );
    let ambiguous = RoutingCatalog {
        generation: 2,
        providers: vec!["one".into(), "two".into()],
    };
    let error = engine
        .run(&ambiguous, &rig.order(), &runner)
        .await
        .unwrap_err();
    assert_eq!(error.code, "routing_provider_ambiguous");
    assert_eq!(error.modules, ["one", "two"]);
    assert!(rig.route.trace.lock().unwrap().events.is_empty());
    let available = RoutingCatalog {
        generation: 3,
        ..catalog()
    };
    engine
        .run(&available, &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
}

#[tokio::test]
async fn pin_refusal_passes_through_without_local_model_fallback() {
    let rig = Rig::new().await;
    let mut order = rig.order();
    order.pin = Some("example-provider/missing-model".into());
    let error = Engine::new(rig.clock.clone())
        .run(&catalog(), &order, &rig.runner(vec![]))
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_route_refused");
    assert_eq!(
        error.source.as_deref(),
        Some(&Refusal::pin_unavailable(
            "example-provider/missing-model",
            PinUnavailableReason::UnknownModel,
            None
        ))
    );
    assert!(rig.route.trace.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn completed_output_survives_report_refusal_and_report_retries_next_run() {
    let rig = Rig::new().await;
    let source = Refusal::new(
        RefusalCode::Other("new_report_refusal".into()),
        "unchanged message",
    );
    *rig.route.report_failure.lock().unwrap() = Some(source.clone());
    let mut engine = Engine::new(rig.clock.clone());
    let done = engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert_eq!(done.output, "validated result");
    assert_eq!(engine.pending_reports.len(), 1);
    let pending = engine.pending_reports.front().unwrap();
    assert_eq!(pending.provider, PROVIDER);
    assert_eq!(pending.report, done.attempts[0].report);
    assert_eq!(pending.source, ReportFailure::Refused(source));
    assert_eq!(
        rig.route.trace.lock().unwrap().events,
        ["select", "send", "report"]
    );
    engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert!(engine.pending_reports.is_empty());
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(
        trace.events,
        ["select", "send", "report", "report", "select", "send", "report"]
    );
    assert_eq!(trace.reports[0], trace.reports[1]);
}

#[tokio::test]
async fn failed_output_report_refusal_still_reselects_with_exclusion() {
    let rig = Rig::new().await;
    *rig.route.report_failure.lock().unwrap() = Some(Refusal::unknown_decision());
    let mut engine = Engine::new(rig.clock.clone());
    let done = engine
        .run(
            &catalog(),
            &rig.order(),
            &rig.runner(vec![failed("send_failed"), completed()]),
        )
        .await
        .unwrap();
    assert_eq!(done.output, "validated result");
    assert_eq!(done.attempts.len(), 2);
    assert_eq!(
        done.attempts[0].report.runner_code.as_deref(),
        Some("send_failed")
    );
    assert_eq!(engine.pending_reports.len(), 1);
    assert_eq!(engine.pending_reports[0].report, done.attempts[0].report);
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(
        trace.events,
        ["select", "send", "report", "select", "send", "report"]
    );
    assert_eq!(
        trace.selects[1]["exclude"],
        json!(["example-provider/model-a"])
    );
    assert_eq!(trace.sends[1].route.model, "model-b");
}

#[tokio::test]
async fn pending_reports_retry_only_with_the_original_provider() {
    let rig = Rig::new().await;
    *rig.route.report_failure.lock().unwrap() = Some(Refusal::unknown_decision());
    let mut engine = Engine::new(rig.clock.clone());
    engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    let mut order = rig.order();
    order.max_decisions = 0;
    let other_provider = RoutingCatalog {
        generation: 2,
        providers: vec!["another-routing-provider".into()],
    };
    let error = engine
        .run(&other_provider, &order, &rig.runner(vec![]))
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_route_exhausted");
    assert_eq!(engine.pending_reports.len(), 1);
    assert_eq!(rig.route.trace.lock().unwrap().reports.len(), 1);
    let original_provider = RoutingCatalog {
        generation: 3,
        ..catalog()
    };
    engine
        .run(
            &original_provider,
            &rig.order(),
            &rig.runner(vec![completed()]),
        )
        .await
        .unwrap();
    assert!(engine.pending_reports.is_empty());
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.reports[0], trace.reports[1]);
}

#[tokio::test]
async fn pending_reports_retry_only_on_the_original_scope() {
    let rig = Rig::new().await;
    *rig.route.report_failure.lock().unwrap() = Some(Refusal::unknown_decision());
    let mut engine = Engine::new(rig.clock.clone());
    engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert_eq!(engine.pending_reports[0].scope_key, rig.route.scope_key());
    let other_scope = TestRoute {
        route: rig
            .subject
            .route(&RouteStamp::project("ck-mc-scope-b", PROJECT))
            .await
            .unwrap(),
        project: PROJECT.into(),
        scope_key: "daemon-scope-b".into(),
        trace: Arc::new(Mutex::new(Trace::default())),
        report_failure: Mutex::new(None),
        report_hangs: false,
        answer_auth: None,
        after_select: None,
    };
    assert_eq!(other_scope.project_key(), rig.route.project_key());
    assert_ne!(other_scope.scope_key(), rig.route.scope_key());
    let mut order = rig.order();
    order.scope_route = &other_scope;
    order.max_decisions = 0;
    let error = engine
        .run(&catalog(), &order, &rig.runner(vec![]))
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_route_exhausted");
    assert!(other_scope.trace.lock().unwrap().reports.is_empty());
    assert_eq!(engine.pending_reports.len(), 1);
    engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    assert!(engine.pending_reports.is_empty());
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.reports.len(), 3);
    assert_eq!(trace.reports[0], trace.reports[1]);
}

#[tokio::test(start_paused = true)]
async fn hung_report_preserves_completed_output_without_exceeding_work_deadline() {
    let mut rig = Rig::new().await;
    rig.route.report_hangs = true;
    let mut order = rig.order();
    let budget = Duration::from_millis(20);
    order.deadline_ms = rig.clock.now_ms() + budget.as_millis() as u64;
    let mut engine = Engine::new(rig.clock.clone());
    let runner = rig.runner(vec![completed()]);
    let start = tokio::time::Instant::now();
    let done = tokio::time::timeout(budget * 2, engine.run(&catalog(), &order, &runner))
        .await
        .expect("a hung report must not hold completed work")
        .unwrap();
    assert_eq!(done.output, "validated result");
    assert!(start.elapsed() <= budget);
    assert_eq!(engine.pending_reports.len(), 1);
    assert_eq!(engine.pending_reports[0].source, ReportFailure::TimedOut);
    assert_eq!(engine.pending_reports[0].report, done.attempts[0].report);
}

#[tokio::test(start_paused = true)]
async fn pending_report_replay_limits_calls_and_bounds_each_timeout() {
    let mut rig = Rig::new().await;
    rig.route.report_hangs = true;
    let mut engine = Engine::new(rig.clock.clone());
    for n in 0..PENDING_REPORT_CAP {
        engine.queue_report(
            PROVIDER,
            rig.route.scope_key(),
            ReportRequest::new(format!("pending-{n}"), Outcome::Completed),
            ReportFailure::TimedOut,
        );
    }
    let mut order = rig.order();
    order.max_decisions = 0;
    let runner = rig.runner(vec![]);
    let bound =
        Duration::from_millis(REPORT_TIMEOUT_MS * MAX_PENDING_REPORT_RETRIES_PER_RUN as u64);
    let start = tokio::time::Instant::now();
    let error = tokio::time::timeout(
        bound + Duration::from_millis(REPORT_TIMEOUT_MS),
        engine.run(&catalog(), &order, &runner),
    )
    .await
    .expect("pending reports must not monopolize a run")
    .unwrap_err();
    assert_eq!(error.code, "mc_route_exhausted");
    assert!(start.elapsed() <= bound);
    assert_eq!(
        rig.route.trace.lock().unwrap().reports.len(),
        MAX_PENDING_REPORT_RETRIES_PER_RUN
    );
    assert_eq!(engine.pending_reports.len(), PENDING_REPORT_CAP);
}

#[tokio::test]
async fn pending_report_failures_log_once_and_queue_evicts_oldest_at_capacity() {
    let logs = Arc::new(Mutex::new(ReportLogRecords::default()));
    let rig = Rig::new().await;
    let source = Refusal::unknown_decision();
    *rig.route.report_failure.lock().unwrap() = Some(source.clone());
    let mut engine = Engine::new(rig.clock.clone());
    engine.report_log = Box::new(RecordingReportLog(logs.clone()));
    let done = engine
        .run(&catalog(), &rig.order(), &rig.runner(vec![completed()]))
        .await
        .unwrap();
    let original = LoggedReport::from(engine.pending_reports.front().unwrap());
    assert_eq!(original.provider, PROVIDER);
    assert_eq!(original.scope_key, rig.route.scope_key());
    assert_eq!(original.decision_id, done.choice.decision_id);
    let mut order = rig.order();
    order.max_decisions = 0;
    for _ in 0..2 {
        *rig.route.report_failure.lock().unwrap() = Some(source.clone());
        let error = engine
            .run(&catalog(), &order, &rig.runner(vec![]))
            .await
            .unwrap_err();
        assert_eq!(error.code, "mc_route_exhausted");
    }
    engine.queue_report(
        PROVIDER,
        rig.route.scope_key(),
        done.attempts[0].report.clone(),
        ReportFailure::Refused(source.clone()),
    );
    assert_eq!(engine.pending_reports.len(), 1);
    let trace = rig.route.trace.lock().unwrap();
    assert_eq!(trace.reports.len(), 3);
    assert!(trace
        .reports
        .iter()
        .all(|report| report == &done.attempts[0].report));
    drop(trace);
    {
        let records = logs.lock().unwrap();
        assert_eq!(records.unacknowledged, [original]);
        assert!(records.evicted.is_empty());
    }
    for n in 1..=PENDING_REPORT_CAP {
        engine.queue_report(
            PROVIDER,
            rig.route.scope_key(),
            ReportRequest::new(format!("queued-{n}"), Outcome::Completed),
            ReportFailure::Refused(source.clone()),
        );
    }
    assert_eq!(engine.pending_reports.len(), PENDING_REPORT_CAP);
    assert_eq!(
        engine.pending_reports.front().unwrap().report.decision_id,
        "queued-1"
    );
    assert_eq!(
        engine.pending_reports.back().unwrap().report.decision_id,
        format!("queued-{PENDING_REPORT_CAP}")
    );
    let records = logs.lock().unwrap();
    assert_eq!(records.unacknowledged.len(), PENDING_REPORT_CAP + 1);
    assert_eq!(
        records.evicted,
        [LoggedReport {
            provider: PROVIDER.into(),
            scope_key: rig.route.scope_key().into(),
            decision_id: done.choice.decision_id,
        }]
    );
}

#[tokio::test]
async fn cancelled_run_is_reported_without_retry() {
    let rig = Rig::new().await;
    let error = Engine::new(rig.clock.clone())
        .run(
            &catalog(),
            &rig.order(),
            &rig.runner(vec![RunResult::new(Outcome::Cancelled, None)]),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "mc_run_cancelled");
    assert_eq!(error.attempts[0].report.outcome, Outcome::Cancelled);
    assert_eq!(rig.route.trace.lock().unwrap().sends.len(), 1);
}

#[tokio::test]
async fn usage_is_reported_and_invalid_completion_is_failed() {
    let rig = Rig::new().await;
    let mut invalid = RunResult::new(Outcome::Completed, None);
    invalid.usage = Some(Usage {
        input_tokens: 123,
        output_tokens: 45,
        cost_usd: Some(0.01),
    });
    let done = Engine::new(rig.clock.clone())
        .run(
            &catalog(),
            &rig.order(),
            &rig.runner(vec![invalid, completed()]),
        )
        .await
        .unwrap();
    assert_eq!(done.attempts[0].report.outcome, Outcome::Failed);
    assert_eq!(
        done.attempts[0].report.usage.as_ref().unwrap().input_tokens,
        123
    );
    assert!(done.attempts[0].report.runner_code.is_none());
}

#[tokio::test]
async fn published_kit_provider_checks_pass_for_vendored_fake() {
    // This release has provider checks only, not an engine/consumer-side suite.
    let report =
        cortexkit_role_routing_conformance::run_suite(&FakeSubject::new(Defects::default())).await;
    assert_eq!(report.checks.len(), 17);
    assert!(report.failing().is_empty(), "{}", report.render());
}

#[test]
fn unknown_refusal_with_reset_is_not_timed() {
    let source = Refusal::with(
        RefusalCode::Other("future_refusal".into()),
        "no timed meaning",
        &json!({"reset_at_ms":123}),
    );
    assert_eq!(source.wait_until_ms(), None);
    assert_eq!(
        Refusal::no_route(NoRouteReason::QuotaOrCooldown, Some(123)).wait_until_ms(),
        Some(123)
    );
}
