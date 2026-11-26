//! Reader coverage for sends whose words never ran, and queued sends that
//! remain deliverable while a different turn ends.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{FinalMessage, RunError};
use cortexkit_role_llm_runner::send::{SendReply, REASON_HOST_REFUSED, REASON_WITHDRAWN};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use std::collections::VecDeque;
use std::sync::Mutex;

pub(crate) struct Client {
    base: account_wait_send_tests::Client,
    replies: Mutex<VecDeque<SendReply>>,
    pub(crate) lose_first_ack: bool,
    pub(crate) confirms_cancel: bool,
    pub(crate) reports_usage: bool,
    results: Mutex<VecDeque<RunResult>>,
    pub(crate) sends: Mutex<Vec<(Child, SendRequest)>>,
    reads: Mutex<Vec<String>>,
    reports: Mutex<Vec<Outcome>>,
    pub(crate) report_bodies: Mutex<Vec<Value>>,
}

impl Client {
    pub(crate) fn new(replies: Vec<SendReply>, results: Vec<RunResult>) -> Self {
        assert!(!replies.is_empty());
        Self {
            base: account_wait_send_tests::Client::new(account_wait_send_tests::Answer::RefuseSend),
            replies: Mutex::new(replies.into()),
            lose_first_ack: false,
            confirms_cancel: false,
            reports_usage: false,
            results: Mutex::new(results.into()),
            sends: Mutex::new(Vec::new()),
            reads: Mutex::new(Vec::new()),
            reports: Mutex::new(Vec::new()),
            report_bodies: Mutex::new(Vec::new()),
        }
    }
}

impl RunnerClient for Client {
    async fn child_cache_policy(&self, _: &Child) -> bool {
        true
    }
    async fn child_session_class(&self, _: &Child) -> bool {
        true
    }
    async fn child_session_retention(
        &self,
        _: &Child,
    ) -> Option<crate::runner_capabilities::SessionRetention> {
        Some(crate::runner_capabilities::SessionRetention { max_days: Some(7) })
    }
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.base.read(session, request).await
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
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        let first = {
            let mut sends = self.sends.lock().unwrap();
            sends.push((child.clone(), request));
            sends.len() == 1
        };
        if first && self.lose_first_ack {
            return Err(ClientError::unanswered(
                "timeout receiving session.send reply",
            ));
        }
        let mut replies = self.replies.lock().unwrap();
        Ok(if replies.len() == 1 {
            replies[0].clone()
        } else {
            replies.pop_front().unwrap()
        })
    }
    async fn cancel_child_run(&self, _: &Child, _: &str) -> Result<bool, ClientError> {
        Ok(self.confirms_cancel)
    }
    async fn report_child_usage(&self, request: ReportRequest) {
        self.report(request).await;
    }
    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        self.reads.lock().unwrap().push(request.run_id.clone());
        let result = {
            let mut results = self.results.lock().unwrap();
            if self.confirms_cancel && results.len() == 1 {
                results.front().cloned()
            } else {
                results.pop_front()
            }
        };
        if let Some(mut result) = result {
            result.run_id = request.run_id;
            return Ok(result);
        }
        let sends = self.sends.lock().unwrap();
        let prompt = sends.last().unwrap().1.prompt.as_deref().unwrap();
        let mut result = RunResult::new(request.run_id, states::COMPLETED);
        if self.reports_usage {
            let mut usage = cortexkit_role_llm_runner::run::RunUsage::new();
            usage.input_tokens = Some(100);
            usage.cached_input_tokens = Some(20);
            usage.output_tokens = Some(10);
            result.usage = Some(usage);
        }
        result.final_message = Some(FinalMessage {
            ordinal: 1,
            mid: "answer".into(),
            text: mc_mock_runner::child::turn_one_reply(&mc_mock_runner::child::summarize(prompt)),
        });
        Ok(result)
    }
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        self.base.select(request).await
    }
    async fn report(&self, request: ReportRequest) {
        self.reports.lock().unwrap().push(request.outcome.clone());
        self.report_bodies
            .lock()
            .unwrap()
            .push(serde_json::to_value(request).unwrap());
    }
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../testdata/llm-runner-0.8.54/send.json")).unwrap()
}

pub(crate) fn not_delivered() -> Vec<SendReply> {
    let mut replies: Vec<SendReply> = vectors()["replies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["reply"]["state"] == send_states::NOT_DELIVERED)
        .map(|case| serde_json::from_value(case["reply"].clone()).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    replies.push(
        SendReply::new(send_states::NOT_DELIVERED)
            .with_reason(REASON_WITHDRAWN)
            .with_run_id("withdrawn-run"),
    );
    replies
}

pub(crate) fn handover(cause: &str) -> RunResult {
    RunResult::new("run", states::ERROR).with_error(
        RunError::new(
            cortexkit_role_llm_runner::errors::run_error_classes::HANDOVER_FAILED,
            "prompt hand-over failed",
            cortexkit_role_llm_runner::errors::provider_codes::PROVIDER_ERROR,
        )
        .with_cause(cause),
    )
}

pub(crate) fn active() -> SendReply {
    SendReply::new(states::ACTIVE).with_run_id("run")
}

fn child() -> Child {
    Child {
        session: SessionRef::new("runner", "pi", "summary-child"),
        project_root: None,
    }
}

async fn direct(client: &Client, send: SendKind) -> Result<Reply, SummaryError> {
    let model = ModelRef::new("provider", "model");
    send_and_wait(
        client,
        &child(),
        "first",
        "prompt",
        &Model {
            model: &model,
            decision_id: "decision",
            output_tokens: 1_000,
            system: "system",
            deadline: tokio::time::Instant::now() + Duration::from_secs(60),
            continuation: send != SendKind::TurnOne,
            creates_child: send != SendKind::TurnTwo,
            attribution: None,
            keep_child: false,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
            send,
            plan: None,
        },
        &mut None,
    )
    .await
}

#[test]
fn never_ran_published_vector_bytes_match_the_pinned_hash() {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("../../testdata/llm-runner-0.8.54/send.json");
    let hash = format!("{:x}", Sha256::digest(bytes));
    assert_eq!(
        hash,
        "6aaf7d7ff28f0f12589a47e630c281537f1afceb5a0681aa6e9b0bb235240cc9"
    );
    assert_eq!(
        include_str!("../../testdata/llm-runner-0.8.54/SHA256SUMS"),
        format!("{hash}  send.json\n")
    );
}

#[tokio::test(start_paused = true)]
async fn never_ran_not_delivered_reasons_resend_once_with_a_new_id() {
    for reply in not_delivered() {
        for send in [SendKind::TurnOne, SendKind::TurnTwo, SendKind::FactCheck] {
            let client = Client::new(vec![reply.clone(), active()], vec![]);
            let before = tokio::time::Instant::now();
            direct(&client, send).await.unwrap();
            assert!(before.elapsed() >= Duration::from_secs(2));
            let sends = client.sends.lock().unwrap();
            assert_eq!(sends.len(), 2);
            assert_ne!(sends[0].1.send_id, sends[1].1.send_id);
            assert_eq!(sends[0].0.session, sends[1].0.session);
            let mut expected = sends[0].1.clone();
            expected.send_id = sends[1].1.send_id.clone();
            expected.session_class = None;
            expected.cache = None;
            expected.retention_policy = None;
            expected.plan = None;
            expected.runner_params.remove("tools");
            assert!(sends[1].1.session_class.is_none());
            assert!(sends[1].1.cache.is_none());
            assert!(sends[1].1.retention_policy.is_none());
            assert!(sends[1].1.plan.is_none());
            assert!(!sends[1].1.runner_params.contains_key("tools"));
            assert_eq!(
                serde_json::to_value(&sends[1].1).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
            assert_eq!(
                *client.reads.lock().unwrap(),
                ["run"],
                "never follow the retired run"
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn never_ran_planned_retained_child_resends_without_creation_fields() {
    let client = Client::new(vec![not_delivered().remove(0), active()], vec![]);
    let model = ModelRef::new("provider", "model");
    let plan = PlanRun {
        plan: json!({"items": [{"kind": "system", "text": "reader system"}]})
            .as_object()
            .unwrap()
            .clone(),
        max_steps: 4,
    };
    let how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1_000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(60),
        continuation: false,
        creates_child: true,
        attribution: None,
        keep_child: true,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        send: SendKind::Dream,
        plan: Some(&plan),
    };
    send_and_wait(&client, &child(), "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].1.plan, Some(plan.plan));
    assert_eq!(
        serde_json::to_value(sends[0].1.retention_policy.as_ref().unwrap()).unwrap(),
        json!({"keep": {"days": 7}, "archive_after_days": 0, "backup": false, "request_dumps": false})
    );
    assert_eq!(sends[0].1.session_class.as_deref(), Some("dream"));
    assert_eq!(sends[1].1.plan, None);
    assert_eq!(sends[1].1.retention_policy, None);
    assert_eq!(sends[1].1.session_class, None);
    assert_eq!(sends[1].1.cache, None);
    assert!(!sends[1].1.runner_params.contains_key("tools"));
    assert!(!sends[1].1.runner_params.contains_key("system"));
    assert_eq!(sends[1].1.runner_params["stop_when"]["max_steps"], 4);
    assert_eq!(sends[1].0.session, sends[0].0.session);
    assert_eq!(sends[1].1.prompt, sends[0].1.prompt);
    assert_ne!(sends[1].1.send_id, sends[0].1.send_id);
}

#[tokio::test(start_paused = true)]
async fn never_ran_not_delivered_exhaustion_is_cancelled_not_failed() {
    for reply in not_delivered() {
        let client = Client::new(vec![reply], vec![]);
        let error = run(&client, None, &account_wait_send_tests::job())
            .await
            .err()
            .unwrap();
        let SummaryError::NeverRan(wait) = error else {
            panic!("not a never-run wait: {error:?}")
        };
        assert_eq!(wait.code, send_states::NOT_DELIVERED);
        assert!((6_000..=8_000).contains(&(wait.until_ms - wait.at_ms)));
        assert_eq!(client.sends.lock().unwrap().len(), 2);
        assert!(client.reads.lock().unwrap().is_empty());
        assert_eq!(*client.reports.lock().unwrap(), [Outcome::Cancelled]);
    }
}

#[tokio::test(start_paused = true)]
async fn never_ran_handover_causes_are_typed_waits_and_logged_once() {
    for cause in [
        "host_unreachable",
        "nothing_written",
        "no_stdin",
        "host_exited",
        "future_cause",
    ] {
        for send in [SendKind::TurnOne, SendKind::TurnTwo, SendKind::FactCheck] {
            let client = Client::new(vec![active()], vec![handover(cause)]);
            let (result, log) = crate::test_log::logged_async(direct(&client, send)).await;
            let error = result.err().unwrap();
            let SummaryError::NeverRan(wait) = error else {
                panic!("not a never-run wait: {error:?}")
            };
            assert_eq!(wait.code, "handover_failed");
            assert_eq!(wait.send, send);
            assert!((6_000..=8_000).contains(&(wait.until_ms - wait.at_ms)));
            assert_eq!(log.lines().count(), 1, "{log}");
            assert!(
                log.contains("INFO") && log.contains(&format!("cause={cause}")),
                "{log}"
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn never_ran_handover_retries_use_transient_backoff_and_fresh_children() {
    let client = Client::new(vec![active()], vec![handover("nothing_written")]);
    let start = tokio::time::Instant::now();
    let result = run(&client, None, &account_wait_send_tests::job())
        .await
        .unwrap();
    assert!(result.is_some());
    assert!((Duration::from_secs(2)..=Duration::from_secs(3)).contains(&start.elapsed()));
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 2);
    assert_ne!(sends[0].0.session, sends[1].0.session);
    assert_ne!(sends[0].1.send_id, sends[1].1.send_id);
    assert_eq!(sends[0].1.route_decision_id, sends[1].1.route_decision_id);
    assert_eq!(*client.reports.lock().unwrap(), [Outcome::Completed]);
}

#[tokio::test(start_paused = true)]
async fn audit_fallback_never_ran_cannot_erase_a_paid_failure() {
    let bad = RunResult::new("run", states::ERROR).with_error(RunError::new(
        "provider",
        "first model failed",
        "provider_error",
    ));
    let mut results = vec![bad];
    results.extend(vec![handover("nothing_written"); 3]);
    let client = Client::new(vec![active()], results);
    let error = run(&client, None, &account_wait_send_tests::job())
        .await
        .err()
        .unwrap();
    assert_eq!(
        *client.reports.lock().unwrap(),
        [Outcome::Failed, Outcome::Cancelled]
    );
    assert!(
        matches!(&error, SummaryError::Failed(reason) if reason.contains("first model failed")),
        "{error:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn never_ran_handover_exhaustion_is_cancelled_without_fallback() {
    let client = Client::new(vec![active()], vec![handover("no_stdin"); 3]);
    let start = tokio::time::Instant::now();
    let error = run(&client, None, &account_wait_send_tests::job())
        .await
        .err()
        .unwrap();
    assert!(matches!(error, SummaryError::NeverRan(_)), "{error:?}");
    assert!((Duration::from_secs(8)..=Duration::from_secs(11)).contains(&start.elapsed()));
    assert_eq!(client.sends.lock().unwrap().len(), 3);
    assert_eq!(*client.reports.lock().unwrap(), [Outcome::Cancelled]);
}

#[tokio::test(start_paused = true)]
async fn lost_turn_one_ack_reattaches_to_the_same_child_and_send() {
    let client = Client {
        lose_first_ack: true,
        ..Client::new(vec![active()], vec![])
    };
    assert!(run(&client, None, &account_wait_send_tests::job())
        .await
        .unwrap()
        .is_some());
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].0, sends[1].0);
    assert_eq!(sends[0].1.send_id, sends[1].1.send_id);
    assert_eq!(*client.reports.lock().unwrap(), [Outcome::Completed]);
}

#[tokio::test(start_paused = true)]
async fn host_refusal_does_not_fall_back_to_another_model() {
    for (replies, results) in [
        (
            vec![
                SendReply::new(send_states::NOT_DELIVERED).with_reason(REASON_HOST_REFUSED),
                active(),
            ],
            vec![],
        ),
        (
            vec![active()],
            vec![
                RunResult::new("run", states::ERROR).with_error(RunError::new(
                    "host_refused",
                    "the host refused the prompt",
                    "provider_error",
                )),
            ],
        ),
    ] {
        let client = Client::new(replies, results);
        assert!(matches!(
            run(&client, None, &account_wait_send_tests::job()).await,
            Err(SummaryError::Failed(_))
        ));
        assert_eq!(client.sends.lock().unwrap().len(), 1);
        assert_eq!(*client.reports.lock().unwrap(), [Outcome::Cancelled]);
    }
}

#[tokio::test(start_paused = true)]
async fn a_same_route_retry_wait_does_not_erase_a_paid_attempt() {
    let mut usage = cortexkit_role_llm_runner::run::RunUsage::new();
    usage.input_tokens = Some(10_000);
    let mut failed = RunResult::new("run", states::ERROR).with_error(RunError::new(
        "provider",
        "503 overloaded",
        "provider_error",
    ));
    failed.usage = Some(usage);
    let wait = account_wait_send_tests::refused_run(
        "5_queued_account_limit_exhausted.new.run_status.json",
    );
    let reset = now_ms() + 600_000;
    let mut client = Client::new(vec![active()], vec![failed, wait]);
    // Routing has no alternate. If it had one, that model could finish the
    // summary; this test covers the wait after the paid retry failed.
    client.base = client.base.with_route_refusal_after(
        1,
        routing::RouteError {
            code: "no_route".into(),
            message: "all routes are on cooldown".into(),
            detail: Some(serde_json::json!({"reason": "quota_or_cooldown", "reset_at_ms": reset})),
        },
    );
    let error = run(&client, None, &account_wait_send_tests::job())
        .await
        .unwrap_err();
    assert_eq!(client.sends.lock().unwrap().len(), 2);
    assert!(error.to_string().contains("503 overloaded"), "{error:?}");
    assert_eq!(*client.reports.lock().unwrap(), [Outcome::Failed]);
    assert!(matches!(&error, SummaryError::PaidThenWait { wait, .. } if wait.until_ms == reset));
    let selects = client.base.requests.lock().unwrap();
    assert_eq!(selects.len(), 2);
    assert_eq!(selects[0], selects[1]);
    let reports = client.report_bodies.lock().unwrap();
    assert_eq!(reports[0]["decision_id"], "decision-1");
    assert_eq!(reports[0]["usage"]["input_tokens"], 10_000);
}

#[tokio::test(start_paused = true)]
async fn never_ran_host_refused_is_a_counted_failure_and_never_resent() {
    // The send itself: refused by the host, retired by the runner.
    for send in [SendKind::TurnOne, SendKind::TurnTwo, SendKind::FactCheck] {
        let reply = SendReply::new(send_states::NOT_DELIVERED)
            .with_reason(REASON_HOST_REFUSED)
            .with_run_id("refused-run");
        let client = Client::new(vec![reply, active()], vec![]);
        let result = direct(&client, send).await;
        assert!(matches!(result, Err(SummaryError::Failed(_))));
        assert_eq!(client.sends.lock().unwrap().len(), 1, "never resent");
        assert!(client.reads.lock().unwrap().is_empty(), "never followed");
    }
    // The run a queued send started, ended by the same refusal.
    for (cause, code) in [
        ("host_configuration_invalid", "provider_error"),
        ("host_policy_refused", "host_policy_refused"),
    ] {
        let client = Client::new(
            vec![active()],
            vec![RunResult::new("run", states::ERROR).with_error(
                RunError::new("host_refused", "the host refused the prompt", code)
                    .with_cause(cause),
            )],
        );
        let result = direct(&client, SendKind::TurnOne).await;
        assert!(matches!(result, Err(SummaryError::Failed(_))));
        assert_eq!(client.sends.lock().unwrap().len(), 1, "never resent");
    }
}

#[tokio::test(start_paused = true)]
async fn never_ran_unknown_outcomes_and_other_error_classes_are_not_resent() {
    for class in ["host_relaunch_failed", "future_error"] {
        let client = Client::new(
            vec![active()],
            vec![RunResult::new("run", states::ERROR).with_error(
                RunError::new(class, "prompt hand-over failed", "provider_error")
                    .with_cause("host_unreachable"),
            )],
        );
        let (result, log) = crate::test_log::logged_async(direct(&client, SendKind::TurnOne)).await;
        assert!(matches!(result, Err(SummaryError::Failed(_))));
        assert!(log.is_empty(), "{log}");
        assert_eq!(client.sends.lock().unwrap().len(), 1);
    }
    let client = Client::new(vec![SendReply::new("future_state")], vec![]);
    assert!(matches!(
        direct(&client, SendKind::TurnOne).await,
        Err(SummaryError::Failed(_))
    ));
    assert_eq!(client.sends.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn never_ran_queued_send_and_its_pending_run_are_waited_not_resent() {
    let replies = vectors()["replies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["reply"]["state"] == send_states::PENDING)
        .map(|case| serde_json::from_value::<SendReply>(case["reply"].clone()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    // An interrupt or cancellation ends only the earlier turn. The
    // queued receipt remains pending, first without and then with its id.
    let client = Client::new(
        vec![replies[0].clone(), replies[0].clone(), replies[1].clone()],
        vec![RunResult::new("run-8", send_states::PENDING); 2],
    );
    direct(&client, SendKind::TurnTwo).await.unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 3);
    for (_, request) in sends.iter().skip(1) {
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::to_value(&sends[0].1).unwrap()
        );
    }
    assert_eq!(*client.reads.lock().unwrap(), ["run-8", "run-8", "run-8"]);
}

#[tokio::test(start_paused = true)]
async fn never_ran_queued_pending_keeps_the_overall_deadline() {
    let client = Client::new(
        vec![SendReply::new(send_states::PENDING).with_submission_id("queued")],
        vec![],
    );
    let start = tokio::time::Instant::now();
    let error = direct(&client, SendKind::TurnTwo).await.err().unwrap();
    assert_eq!(
        error,
        SummaryError::Uncertain("the run did not finish in time".into())
    );
    assert_eq!(start.elapsed(), Duration::from_secs(60));
    assert!(client.reads.lock().unwrap().is_empty());
    assert!(client
        .sends
        .lock()
        .unwrap()
        .iter()
        .all(|(_, send)| send.send_id == "first"));
}

#[tokio::test(start_paused = true)]
async fn never_ran_queued_send_can_finish_between_receipt_polls() {
    let file = vectors();
    let pending = file["replies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| {
            case["reply"]["state"] == send_states::PENDING && case["reply"].get("run_id").is_none()
        })
        .unwrap();
    let finished = file["replies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["reply"]["state"] == send_states::FINISHED)
        .unwrap();
    let client = Client::new(
        vec![
            serde_json::from_value(pending["reply"].clone()).unwrap(),
            serde_json::from_value(finished["reply"].clone()).unwrap(),
        ],
        vec![],
    );
    direct(&client, SendKind::TurnTwo).await.unwrap();
    assert_eq!(*client.reads.lock().unwrap(), ["run-7"]);
    assert_eq!(client.sends.lock().unwrap().len(), 2);
}

/// THALAMUS's Agent Runner samples for a prompt it proved it never handed to
/// a host (`send-not-delivered-v1`), kept byte for byte with their sums.
mod thalamus_not_delivered {
    use super::*;
    use cortexkit_role_llm_runner::run::RunStatus;

    const SAMPLES: [(&str, &[u8]); 7] = [
        (
            "01-send-reply-pending.json",
            include_bytes!("../../testdata/send-not-delivered-v1/01-send-reply-pending.json"),
        ),
        (
            "02-send-status-not-delivered-handover-failed.json",
            include_bytes!(
                "../../testdata/send-not-delivered-v1/02-send-status-not-delivered-handover-failed.json"
            ),
        ),
        (
            "03-send-resend-same-id-not-delivered.json",
            include_bytes!(
                "../../testdata/send-not-delivered-v1/03-send-resend-same-id-not-delivered.json"
            ),
        ),
        (
            "04-run-status-handover-failed.json",
            include_bytes!("../../testdata/send-not-delivered-v1/04-run-status-handover-failed.json"),
        ),
        (
            "05-run-result-handover-failed.json",
            include_bytes!("../../testdata/send-not-delivered-v1/05-run-result-handover-failed.json"),
        ),
        (
            "06-run-ended-event-handover-failed.json",
            include_bytes!(
                "../../testdata/send-not-delivered-v1/06-run-ended-event-handover-failed.json"
            ),
        ),
        (
            "07-send-status-not-delivered-withdrawn.json",
            include_bytes!(
                "../../testdata/send-not-delivered-v1/07-send-status-not-delivered-withdrawn.json"
            ),
        ),
    ];

    fn sample<T: serde::de::DeserializeOwned>(index: usize) -> T {
        serde_json::from_slice(SAMPLES[index].1).unwrap()
    }

    #[test]
    fn the_samples_match_their_sums() {
        use sha2::{Digest, Sha256};
        let sums = include_str!("../../testdata/send-not-delivered-v1/SHA256SUMS");
        for (name, bytes) in SAMPLES {
            let line = format!("{:x}  {name}", Sha256::digest(bytes));
            assert!(sums.lines().any(|sum| sum == line), "{name}");
        }
    }

    /// An inline `pending` without a run id is replayed under the same id;
    /// a `not_delivered` hand-over failure is sent once more under a new id;
    /// a second one ends the summary as a send that never ran.
    #[tokio::test(start_paused = true)]
    async fn pending_then_not_delivered_twice_never_ran() {
        let client = Client::new(vec![sample(0), sample(1), sample(2)], vec![]);
        let error = direct(&client, SendKind::TurnOne).await.err().unwrap();
        let SummaryError::NeverRan(wait) = error else {
            panic!("not a never-run wait: {error:?}")
        };
        assert_eq!(wait.code, send_states::NOT_DELIVERED);
        let sends = client.sends.lock().unwrap();
        let ids: Vec<&str> = sends
            .iter()
            .map(|(_, request)| request.send_id.as_str())
            .collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(
            ids[0], ids[1],
            "the pending send is replayed under its own id"
        );
        assert_ne!(
            ids[1], ids[2],
            "a not_delivered send is resent under a new id"
        );
        assert!(client.reads.lock().unwrap().is_empty());
    }

    /// The `withdrawn` reason proves non-delivery like any other.
    #[tokio::test(start_paused = true)]
    async fn withdrawn_is_resent_once() {
        let client = Client::new(vec![sample(6), active()], vec![]);
        direct(&client, SendKind::TurnTwo).await.unwrap();
        assert_eq!(client.sends.lock().unwrap().len(), 2);
    }

    /// A run that ends `handover_failed` never ran; its status reads the same.
    #[tokio::test(start_paused = true)]
    async fn a_run_ended_handover_failed_never_ran() {
        let status: RunStatus = sample(3);
        let class = status.error.as_ref().map(|error| error.class.as_str());
        assert_eq!(class, Some("handover_failed"));
        let result: RunResult = sample(4);
        let started = SendReply::new(states::ACTIVE).with_run_id(result.run_id.clone());
        let client = Client::new(vec![started], vec![result]);
        let error = direct(&client, SendKind::FactCheck).await.err().unwrap();
        let SummaryError::NeverRan(wait) = error else {
            panic!("not a never-run wait: {error:?}")
        };
        assert_eq!(wait.code, "handover_failed");
    }
}

/// THALAMUS's Agent Runner samples from the change that answers a
/// run-starting send as soon as it is stored: `pending` with the run's id,
/// before the prompt reaches the host (`send-answers-early-v1`,
/// `send-unknown-v2`, `send-not-delivered-v2`), kept byte for byte with their
/// sums. Such a `pending` is neither delivery nor a run already under way: the
/// summary follows the named run to its end, and a hand-over that fails still
/// ends it as a send that never ran.
mod thalamus_send_answers_early {
    use super::*;
    use cortexkit_role_llm_runner::run::RunStatus;

    macro_rules! samples {
        ($dir:literal: $($name:literal),+ $(,)?) => {
            [$(($name, include_bytes!(concat!("../../testdata/", $dir, "/", $name)) as &[u8])),+]
        };
    }

    const EARLY: [(&str, &[u8]); 3] = samples!("send-answers-early-v1":
        "01-opencode2-send-reply.json",
        "02-pi-send-reply.json",
        "03-claude-code-send-reply.json",
    );
    const UNKNOWN: [(&str, &[u8]); 8] = samples!("send-unknown-v2":
        "01-head-send-reply.json",
        "02-head-send-status-unknown.json",
        "03-head-send-resend-same-id.json",
        "04-steer-send-reply.json",
        "05-steer-send-status-unknown.json",
        "06-steer-send-resend-same-id.json",
        "07-head-send-status-pending.json",
        "08-head-send-status-delivered.json",
    );
    const NOT_DELIVERED: [(&str, &[u8]); 7] = samples!("send-not-delivered-v2":
        "01-send-reply-pending.json",
        "02-send-status-not-delivered-handover-failed.json",
        "03-send-resend-same-id-not-delivered.json",
        "04-run-status-handover-failed.json",
        "05-run-result-handover-failed.json",
        "06-run-ended-event-handover-failed.json",
        "07-send-status-not-delivered-withdrawn.json",
    );

    fn reply(sample: (&str, &[u8])) -> SendReply {
        serde_json::from_slice(sample.1).unwrap_or_else(|error| panic!("{}: {error}", sample.0))
    }

    #[test]
    fn the_samples_match_their_sums() {
        use sha2::{Digest, Sha256};
        type Set<'a> = (&'a [(&'a str, &'a [u8])], &'a str);
        let sets: [Set; 3] = [
            (
                &EARLY,
                include_str!("../../testdata/send-answers-early-v1/SHA256SUMS"),
            ),
            (
                &UNKNOWN,
                include_str!("../../testdata/send-unknown-v2/SHA256SUMS"),
            ),
            (
                &NOT_DELIVERED,
                include_str!("../../testdata/send-not-delivered-v2/SHA256SUMS"),
            ),
        ];
        for (samples, sums) in sets {
            for (name, bytes) in samples {
                let line = format!("{:x}  {name}", Sha256::digest(bytes));
                assert!(sums.lines().any(|sum| sum == line), "{name}");
            }
        }
    }

    /// A first reply of `pending` that names its run, from every host, is
    /// followed as that run: one send, never replayed or resent, and the
    /// summary reads the named run's result.
    #[tokio::test(start_paused = true)]
    async fn a_pending_reply_with_a_run_id_is_followed_as_that_run() {
        for sample in [EARLY[0], EARLY[1], EARLY[2], UNKNOWN[0], NOT_DELIVERED[0]] {
            let early = reply(sample);
            assert_eq!(early.state, send_states::PENDING, "{}", sample.0);
            let run_id = early.run_id.clone().unwrap();
            let client = Client::new(vec![early], vec![]);
            direct(&client, SendKind::TurnOne)
                .await
                .unwrap_or_else(|error| panic!("{}: {error:?}", sample.0));
            assert_eq!(client.sends.lock().unwrap().len(), 1, "{}", sample.0);
            assert_eq!(*client.reads.lock().unwrap(), [run_id], "{}", sample.0);
        }
    }

    /// The run a `pending` reply named ends `handover_failed` when its prompt
    /// never reached the host: the summary never ran, and is not a failure.
    #[tokio::test(start_paused = true)]
    async fn a_named_run_whose_handover_failed_never_ran() {
        let status: RunStatus = serde_json::from_slice(NOT_DELIVERED[3].1).unwrap();
        assert_eq!(status.error.unwrap().class, "handover_failed");
        let result: RunResult = serde_json::from_slice(NOT_DELIVERED[4].1).unwrap();
        let client = Client::new(vec![reply(NOT_DELIVERED[0])], vec![result]);
        let error = direct(&client, SendKind::TurnOne).await.err().unwrap();
        let SummaryError::NeverRan(wait) = error else {
            panic!("not a never-run wait: {error:?}")
        };
        assert_eq!(wait.code, "handover_failed");
        assert_eq!(client.sends.lock().unwrap().len(), 1);
    }

    /// A `not_delivered` answer that names the run it recorded proves the
    /// prompt never ran: the send goes once more under a new id, and the
    /// retired run is never followed.
    #[tokio::test(start_paused = true)]
    async fn a_not_delivered_answer_naming_its_run_is_resent_once() {
        for sample in [NOT_DELIVERED[1], NOT_DELIVERED[2], NOT_DELIVERED[6]] {
            let client = Client::new(vec![reply(sample), active()], vec![]);
            direct(&client, SendKind::TurnOne)
                .await
                .unwrap_or_else(|error| panic!("{}: {error:?}", sample.0));
            let sends = client.sends.lock().unwrap();
            assert_eq!(sends.len(), 2, "{}", sample.0);
            assert_ne!(sends[0].1.send_id, sends[1].1.send_id, "{}", sample.0);
            assert_eq!(*client.reads.lock().unwrap(), ["run"], "{}", sample.0);
        }
    }

    /// An answer whose delivery is unknown, or a replayed id's stored receipt,
    /// is followed as the run it names. A `pending` without a run id is
    /// replayed under the same id until the runner names one.
    #[tokio::test(start_paused = true)]
    async fn unknown_delivery_follows_the_named_run() {
        for sample in &UNKNOWN[1..6] {
            let named = reply(*sample);
            let run_id = named.run_id.clone().unwrap();
            let client = Client::new(vec![named], vec![]);
            direct(&client, SendKind::TurnOne)
                .await
                .unwrap_or_else(|error| panic!("{}: {error:?}", sample.0));
            assert_eq!(*client.reads.lock().unwrap(), [run_id], "{}", sample.0);
        }
        let client = Client::new(vec![reply(UNKNOWN[6]), reply(UNKNOWN[7])], vec![]);
        direct(&client, SendKind::TurnOne).await.unwrap();
        let sends = client.sends.lock().unwrap();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0].1.send_id, sends[1].1.send_id);
        assert_eq!(
            *client.reads.lock().unwrap(),
            ["run_b373e590c9cb0c2c2645ebee"]
        );
    }
}
