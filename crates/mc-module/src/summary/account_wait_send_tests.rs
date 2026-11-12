//! A summarizer send the runner holds back until an account has room, at
//! the send and as the error a run ends with: the run ends waiting, without
//! retries, other models or a failure.

use super::*;
use crate::client::ClientError;
use crate::routing::RouteError;
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, ReadRequest, Role};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunStatus, RunStatusRequest};
use cortexkit_role_llm_runner::send::SendReply;
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use std::sync::Mutex;

fn sample(name: &str) -> Value {
    let path = format!(
        "{}/testdata/account-wait-0.8.41/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path)
}

/// A sample `session.send` refusal as the transport hands it over: the
/// error body's code, message and detail.
pub(crate) fn refused_send(name: &str) -> ClientError {
    let body = sample(name);
    let mut error = ClientError::refused(
        body["code"].as_str().unwrap(),
        body["message"].as_str().unwrap(),
    );
    error.detail = body.get("detail").cloned();
    error
}

/// The run a queued send would have started, ended by the refusal at its
/// own admission: a sample `run.status` answer.
pub(crate) fn refused_run(name: &str) -> RunResult {
    let status: RunStatus =
        serde_json::from_value(sample(name)["result"].clone()).expect("a run.status answer");
    let mut result = RunResult::new("run", status.state);
    result.error = status.error;
    result
}

/// How the stand-in runner answers a summarizer send.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    /// Refuses the send itself: an account wait of 120 s (sample 1 of
    /// `testdata/account-wait-0.8.41/`).
    RefuseSend,
    /// Starts a run that ends with an account wait of 120 s (sample 5, the limit).
    RunEndsRefused,
    /// Refuses the send for good: `account_selection_final` (sample 4).
    RefuseSendFinal,
    /// Starts a run that ends refused for good (sample 5, final).
    RunEndsFinal,
    /// Starts a run the runner keeps paused for an account limit, with the
    /// limit's run error from sample 5 beside the pause.
    PausedForAccount,
}

impl Answer {
    fn send_refusal(self) -> Option<ClientError> {
        match self {
            Self::RefuseSend => Some(refused_send(
                "1_account_limit_exhausted_retry_and_reset.new.plan.json",
            )),
            Self::RefuseSendFinal => Some(refused_send(
                "4_account_selection_final_no_hint.new.plan.json",
            )),
            Self::RunEndsRefused | Self::RunEndsFinal | Self::PausedForAccount => None,
        }
    }

    fn run_end(self) -> RunResult {
        if self == Self::PausedForAccount {
            let mut paused = RunResult::new("run", states::PAUSED);
            paused.reason = Some("account_limit".into());
            paused.error = Self::RunEndsRefused.run_end().error;
            return paused;
        }
        refused_run(if self == Self::RunEndsFinal {
            "5_queued_account_selection_final.new.run_status.json"
        } else {
            "5_queued_account_limit_exhausted.new.run_status.json"
        })
    }
}

pub(crate) struct Client {
    answer: Answer,
    route_refusal: Option<RouteError>,
    pub(crate) sends: Mutex<usize>,
    selects: Mutex<usize>,
    reports: Mutex<Vec<Outcome>>,
}

impl Client {
    pub(crate) fn new(answer: Answer) -> Self {
        Self {
            answer,
            route_refusal: None,
            sends: Mutex::new(0),
            selects: Mutex::new(0),
            reports: Mutex::new(Vec::new()),
        }
    }
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        let entries = (1..=4)
            .map(|ordinal| {
                let mut part = Part::new(
                    "p",
                    PartBody::Text {
                        text: format!("message {ordinal} about the build"),
                    },
                );
                part.tag = Some(ordinal);
                Entry::new(
                    ordinal,
                    format!("m{ordinal}"),
                    if ordinal % 2 == 1 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    ordinal,
                    vec![part],
                )
            })
            .collect();
        Ok(ReadPage::new(entries, Head::new()))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        *self.sends.lock().unwrap() += 1;
        if let Some(refusal) = self.answer.send_refusal() {
            return Err(refusal);
        }
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Ok(self.answer.run_end())
    }
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let mut selects = self.selects.lock().unwrap();
        *selects += 1;
        if let Some(error) = &self.route_refusal {
            return Err(error.clone());
        }
        let route = RouteRef::new("test", format!("model-{selects}"));
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        Ok(SelectAnswer::new(
            format!("decision-{selects}"),
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }

    async fn report(&self, request: ReportRequest) {
        self.reports.lock().unwrap().push(request.outcome);
    }
}

fn job() -> Request {
    Request {
        limits: crate::reads::Limits::default(),
        session: SessionRef::new("runner", "pi", "head"),
        child_harness: None,
        from: 1,
        until: 5,
        summaries: Vec::new(),
        project_root: Some("/project".into()),
        project: None,
        language: None,
        memories: Vec::new(),
        memory_enabled: false,
        auto_promote: false,
        emergency: false,
        two_pass: false,
    }
}

fn how(model: &ModelRef) -> Model<'_> {
    Model {
        model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(5),
        continuation: true,
        creates_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        send: SendKind::TurnTwo,
    }
}

fn child() -> Child {
    Child {
        session: SessionRef::new("runner", "pi", "head:mc-summary:1-4:decision"),
        project_root: Some("/project".into()),
    }
}

/// The wait the sample names: 120 s after the refusal arrived.
fn assert_waits_120_s(error: SummaryError, before: i64, send: SendKind) {
    let SummaryError::AccountWait(wait) = error else {
        panic!("not an account wait: {error:?}");
    };
    let after = crate::summary::account_wait::now_ms();
    assert_eq!(wait.code, "account_limit_exhausted");
    assert_eq!(wait.send, send);
    assert!(
        (before + 120_000..=after + 120_000).contains(&wait.until_ms),
        "{wait:?}"
    );
}

#[tokio::test]
async fn account_wait_a_refused_send_is_a_wait_not_a_failure() {
    let client = Client::new(Answer::RefuseSend);
    let model = ModelRef::new("provider", "model");
    let before = crate::summary::account_wait::now_ms();
    let error = refusal_of(
        send_and_wait(&client, &child(), "send", "prompt", &how(&model), &mut None).await,
    );
    assert_waits_120_s(error, before, SendKind::TurnTwo);
}

#[tokio::test]
async fn account_wait_a_run_ended_by_the_refusal_is_a_wait_not_a_failure() {
    let client = Client::new(Answer::RunEndsRefused);
    let model = ModelRef::new("provider", "model");
    let before = crate::summary::account_wait::now_ms();
    let error = refusal_of(
        send_and_wait(&client, &child(), "send", "prompt", &how(&model), &mut None).await,
    );
    assert_waits_120_s(error, before, SendKind::TurnTwo);
}

/// A whole run that meets the wait ends at once: no retry, no other model,
/// and routing hears no failure of the route.
#[tokio::test]
async fn account_wait_a_summary_run_ends_waiting_on_its_first_send() {
    for answer in [Answer::RefuseSend, Answer::RunEndsRefused] {
        let client = Client::new(answer);
        let before = crate::summary::account_wait::now_ms();
        let error = run(&client, None, &job()).await.expect_err("no summary");
        assert_waits_120_s(error, before, SendKind::TurnOne);
        assert_eq!(*client.sends.lock().unwrap(), 1);
        assert_eq!(*client.selects.lock().unwrap(), 1);
        assert_eq!(*client.reports.lock().unwrap(), vec![Outcome::Cancelled]);
    }
}

/// `account_selection_final` is no wait: waiting cannot change it. It keeps
/// the handling every other refusal has: the run fails on this model and
/// the next models routing picks are tried.
#[tokio::test]
async fn account_wait_a_final_selection_refusal_fails_as_before() {
    for answer in [Answer::RefuseSendFinal, Answer::RunEndsFinal] {
        let client = Client::new(answer);
        let model = ModelRef::new("provider", "model");
        let error = refusal_of(
            send_and_wait(&client, &child(), "send", "prompt", &how(&model), &mut None).await,
        );
        assert!(matches!(error, SummaryError::Failed(_)), "{error:?}");
        let client = Client::new(answer);
        let error = run(&client, None, &job()).await.expect_err("no summary");
        assert!(matches!(error, SummaryError::Failed(_)), "{error:?}");
        assert_eq!(*client.selects.lock().unwrap(), 1 + MAX_FALLBACKS);
        assert_eq!(
            *client.reports.lock().unwrap(),
            vec![Outcome::Failed; 1 + MAX_FALLBACKS]
        );
    }
}

/// The error a send ended with; a reply fails the test.
fn refusal_of(result: Result<Reply, SummaryError>) -> SummaryError {
    match result {
        Ok(reply) => panic!("the send was answered: {}", reply.text),
        Err(error) => error,
    }
}

/// A runner whose summarizer run stays paused, with `error` as the pause's
/// run error, and which serves `run.cancel` when `cancels` is set.
struct PausedRunner {
    cancels: bool,
    reason: Option<&'static str>,
    error: Option<cortexkit_role_llm_runner::run::RunError>,
    resume_not_before_ms: Option<u64>,
    status_fails: bool,
    status_reads: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<String>>,
}

impl PausedRunner {
    fn new(reason: Option<&'static str>) -> Self {
        Self {
            cancels: true,
            reason,
            error: None,
            resume_not_before_ms: None,
            status_fails: false,
            status_reads: Mutex::new(Vec::new()),
            cancelled: Mutex::new(Vec::new()),
        }
    }
}

impl RunnerClient for PausedRunner {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let mut paused = RunResult::new("run", states::PAUSED);
        paused.reason = self.reason.map(str::to_owned);
        paused.error = self.error.clone();
        Ok(paused)
    }
    async fn child_status(
        &self,
        _: &Child,
        request: RunStatusRequest,
    ) -> Result<RunStatus, ClientError> {
        assert!(
            self.cancelled.lock().unwrap().is_empty(),
            "read before cancel"
        );
        self.status_reads
            .lock()
            .unwrap()
            .push(request.run_id.unwrap());
        if self.status_fails {
            return Err(ClientError::new("status read failed"));
        }
        let mut status = RunStatus::new(states::PAUSED);
        status.resume_not_before_ms = self.resume_not_before_ms;
        Ok(status)
    }
    async fn cancel_child_run(&self, _: &Child, run_id: &str) -> Result<bool, ClientError> {
        if !self.cancels {
            return Ok(false);
        }
        self.cancelled.lock().unwrap().push(run_id.to_owned());
        Ok(true)
    }
}

/// A run still paused when its time runs out, with no run error that names
/// an account wait (this one waits for a sign-in), ends as the timeout an
/// active run would, and is cancelled first where the runner serves
/// `run.cancel`.
#[tokio::test]
async fn account_wait_a_run_still_paused_at_its_deadline_times_out_and_is_cancelled() {
    for cancels in [true, false] {
        let client = PausedRunner {
            cancels,
            ..PausedRunner::new(Some("auth_required"))
        };
        let model = ModelRef::new("provider", "model");
        let mut how = how(&model);
        how.deadline = tokio::time::Instant::now() + Duration::from_millis(700);
        let error =
            refusal_of(send_and_wait(&client, &child(), "send", "prompt", &how, &mut None).await);
        assert_eq!(
            error,
            SummaryError::Failed("the run did not finish in time".into())
        );
        let expected: Vec<String> = if cancels { vec!["run".into()] } else { vec![] };
        assert_eq!(*client.cancelled.lock().unwrap(), expected);
        assert!(client.status_reads.lock().unwrap().is_empty());
    }
}

/// A run a runner paused for an account limit reports the limit's run error
/// beside the pause. Still paused at its deadline, the call ends as that
/// account wait, not as a timeout, and the run is cancelled first.
#[tokio::test]
async fn account_wait_a_run_paused_for_an_account_at_its_deadline_is_a_wait() {
    let client = PausedRunner {
        error: Answer::RunEndsRefused.run_end().error,
        ..PausedRunner::new(Some("account_limit"))
    };
    let model = ModelRef::new("provider", "model");
    let mut how = how(&model);
    how.send = SendKind::TurnOne;
    how.deadline = tokio::time::Instant::now() + Duration::from_millis(700);
    let before = crate::summary::account_wait::now_ms();
    let error =
        refusal_of(send_and_wait(&client, &child(), "send", "prompt", &how, &mut None).await);
    assert_waits_120_s(error, before, SendKind::TurnOne);
    assert_eq!(*client.cancelled.lock().unwrap(), vec!["run".to_owned()]);
}

async fn pause_at_deadline(client: &PausedRunner) -> AccountWait {
    let error = wait_for(
        client,
        &child(),
        "run",
        tokio::time::Instant::now() + Duration::from_millis(10),
        SendKind::TurnOne,
    )
    .await
    .expect_err("the run stays paused");
    let SummaryError::AccountWait(wait) = error else {
        panic!("the pause counted as a failure: {error:?}");
    };
    assert_eq!(*client.status_reads.lock().unwrap(), vec!["run"]);
    assert_eq!(*client.cancelled.lock().unwrap(), vec!["run"]);
    wait
}

#[tokio::test]
async fn account_pause_0842_reason_and_resume_time_override_the_error_hints() {
    let resume = super::super::account_wait::now_ms() + 20 * 60_000;
    let client = PausedRunner {
        error: Answer::RunEndsRefused.run_end().error,
        resume_not_before_ms: Some(resume as u64),
        ..PausedRunner::new(Some("account_limit"))
    };
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.until_ms, resume);
    assert_eq!(wait.send, SendKind::TurnOne);
}

#[tokio::test]
async fn account_pause_0842_reason_alone_waits_without_a_run_error() {
    let client = PausedRunner::new(Some("account_limit"));
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.until_ms, wait.at_ms + 5 * 60_000);
}

#[tokio::test]
async fn account_pause_0842_reason_without_resume_uses_error_timing_then_default() {
    use cortexkit_role_llm_runner::run::RunError;
    for (error, expected) in [
        (Answer::RunEndsRefused.run_end().error, 120_000),
        (
            Some(
                RunError::new("transient", "limit", "new_provider_code")
                    .with_resets_at_ms((super::super::account_wait::now_ms() + 600_000) as u64),
            ),
            0,
        ),
    ] {
        let reset = error.as_ref().and_then(|error| error.resets_at_ms);
        let client = PausedRunner {
            error,
            ..PausedRunner::new(Some("account_limit"))
        };
        let wait = pause_at_deadline(&client).await;
        if expected == 0 {
            assert_eq!(wait.until_ms, reset.unwrap() as i64);
        } else {
            assert_eq!(wait.until_ms, wait.at_ms + expected);
        }
    }
}

#[tokio::test]
async fn account_pause_0842_status_failure_keeps_the_account_wait_and_error_timing() {
    let mut error =
        cortexkit_role_llm_runner::run::RunError::new("transient", "limit", "new_provider_code");
    error.retry_after_secs = Some(120.0);
    let client = PausedRunner {
        status_fails: true,
        error: Some(error),
        ..PausedRunner::new(Some("account_limit"))
    };
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.until_ms, wait.at_ms + 120_000);
}

#[tokio::test]
async fn account_pause_0842_resume_floor_is_bounded_to_one_minute_and_six_hours() {
    let now = super::super::account_wait::now_ms();
    for (resume, expected) in [
        (now - 60_000, 60_000),
        (now + 10 * 3_600_000, 6 * 3_600_000),
    ] {
        let client = PausedRunner {
            resume_not_before_ms: Some(resume as u64),
            ..PausedRunner::new(Some("account_limit"))
        };
        let wait = pause_at_deadline(&client).await;
        assert_eq!(wait.until_ms, wait.at_ms + expected);
    }
}

#[tokio::test]
async fn account_pause_0842_older_provider_code_only_body_keeps_its_wait() {
    let client = PausedRunner {
        error: Answer::RunEndsRefused.run_end().error,
        ..PausedRunner::new(None)
    };
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.until_ms, wait.at_ms + 120_000);
}

#[cfg(test)]
#[path = "routing_wait_tests.rs"]
mod routing_wait_tests;
