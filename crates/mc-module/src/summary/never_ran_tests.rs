//! Reader coverage for sends whose words never ran, and queued sends that
//! remain deliverable while a different turn ends.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{FinalMessage, RunError};
use cortexkit_role_llm_runner::send::{SendReply, REASON_WITHDRAWN};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use std::collections::VecDeque;
use std::sync::Mutex;

pub(crate) struct Client {
    base: account_wait_send_tests::Client,
    replies: Mutex<VecDeque<SendReply>>,
    results: Mutex<VecDeque<RunResult>>,
    pub(crate) sends: Mutex<Vec<(Child, SendRequest)>>,
    reads: Mutex<Vec<String>>,
    reports: Mutex<Vec<Outcome>>,
}

impl Client {
    pub(crate) fn new(replies: Vec<SendReply>, results: Vec<RunResult>) -> Self {
        assert!(!replies.is_empty());
        Self {
            base: account_wait_send_tests::Client::new(account_wait_send_tests::Answer::RefuseSend),
            replies: Mutex::new(replies.into()),
            results: Mutex::new(results.into()),
            sends: Mutex::new(Vec::new()),
            reads: Mutex::new(Vec::new()),
            reports: Mutex::new(Vec::new()),
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
        self.sends.lock().unwrap().push((child.clone(), request));
        let mut replies = self.replies.lock().unwrap();
        Ok(if replies.len() == 1 {
            replies[0].clone()
        } else {
            replies.pop_front().unwrap()
        })
    }
    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        self.reads.lock().unwrap().push(request.run_id.clone());
        if let Some(mut result) = self.results.lock().unwrap().pop_front() {
            result.run_id = request.run_id;
            return Ok(result);
        }
        let sends = self.sends.lock().unwrap();
        let prompt = sends.last().unwrap().1.prompt.as_deref().unwrap();
        let mut result = RunResult::new(request.run_id, states::COMPLETED);
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
        self.reports.lock().unwrap().push(request.outcome);
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
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
            send,
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
            expected.runner_params.remove("tools");
            assert!(sends[1].1.session_class.is_none());
            assert!(sends[1].1.cache.is_none());
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
                log.contains("INFO") && log.contains(&format!("cause {cause}")),
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
        SummaryError::Failed("the run did not finish in time".into())
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
