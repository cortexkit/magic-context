//! Real Broca reader bodies and typed variants for each wait owner.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::awaits::{AwaitMessage, AwaitMessageFrom, RunAwaits};
use cortexkit_role_llm_runner::run::RunStatus;
use cortexkit_role_llm_runner::send::SendReply;
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use std::collections::VecDeque;
use std::sync::Mutex;

const AWAITS: &str = "run-awaits-1112";
const CODES: &str = "run-provider-code-1113";

fn sample<T: serde::de::DeserializeOwned>(set: &str, name: &str) -> T {
    let path = format!("{}/testdata/{set}/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path)
}

struct Runner {
    base: account_wait_send_tests::Client,
    results: Mutex<VecDeque<RunResult>>,
    status: Option<RunStatus>,
    cancels: bool,
    cancelled: Mutex<usize>,
    sends: Mutex<usize>,
    reports: Mutex<Vec<Outcome>>,
}

impl Runner {
    fn ended(result: RunResult) -> Self {
        Self {
            base: account_wait_send_tests::Client::new(
                account_wait_send_tests::Answer::RunEndsFinal,
            ),
            results: Mutex::new(VecDeque::from([result])),
            status: None,
            cancels: true,
            cancelled: Mutex::new(0),
            sends: Mutex::new(0),
            reports: Mutex::new(Vec::new()),
        }
    }

    fn waiting(status: RunStatus) -> Self {
        // Broca's nonterminal result does not carry awaits. Only status can
        // distinguish these waits, including an active held-tool run.
        let mut result = RunResult::new("r1", status.state.clone());
        result.reason = status.reason.clone().map(String::from);
        result.error = status.error.clone();
        Self {
            status: Some(status),
            ..Self::ended(result)
        }
    }
}

impl RunnerClient for Runner {
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
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        *self.sends.lock().unwrap() += 1;
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("r1".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let mut results = self.results.lock().unwrap();
        if results.len() > 1 {
            Ok(results.pop_front().unwrap())
        } else {
            Ok(results.front().unwrap().clone())
        }
    }
    async fn child_status(&self, _: &Child, _: RunStatusRequest) -> Result<RunStatus, ClientError> {
        assert!(
            *self.cancelled.lock().unwrap() < *self.sends.lock().unwrap(),
            "status must precede cancellation of this send's run"
        );
        self.status
            .clone()
            .ok_or_else(|| ClientError::new("no status"))
    }
    async fn cancel_child_run(&self, _: &Child, _: &str) -> Result<bool, ClientError> {
        if self.cancels {
            *self.cancelled.lock().unwrap() += 1;
        }
        Ok(self.cancels)
    }
}

impl Router for Runner {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        self.base.select(request).await
    }
    async fn report(&self, request: ReportRequest) {
        self.reports.lock().unwrap().push(request.outcome);
    }
}

fn child() -> Child {
    Child {
        session: SessionRef::new("runner", "pi", "summary"),
        project_root: None,
    }
}

async fn send_error(client: &Runner, send: SendKind) -> SummaryError {
    let model = ModelRef::new("test", "model");
    let how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(2),
        continuation: true,
        creates_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        plan: None,
        send,
    };
    match send_and_wait(client, &child(), "send", "prompt", &how, &mut None).await {
        Err(error) => error,
        Ok(_) => panic!("expected no summary reply"),
    }
}

fn wait(error: SummaryError) -> AccountWait {
    match error {
        SummaryError::AccountWait(wait) => wait,
        error => panic!("the wait counted as a failure: {error:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_person_status_never_counts_a_summary_failure() {
    for state in [states::PAUSED, states::ACTIVE] {
        for cancels in [true, false] {
            let mut status: RunStatus = sample(AWAITS, "auth-required.after.run.status.json");
            status.state = state.into();
            let client = Runner {
                cancels,
                ..Runner::waiting(status)
            };
            let started = tokio::time::Instant::now();
            let refusal = wait(
                run(&client, None, &account_wait_send_tests::job())
                    .await
                    .unwrap_err(),
            );
            assert_eq!(tokio::time::Instant::now() - started, RUN_TIMEOUT);
            assert_eq!(
                refusal.until_ms,
                refusal.at_ms + super::super::account_wait::DEFAULT_WAIT_MS
            );
            assert_eq!(*client.sends.lock().unwrap(), 1, "no retries or fallbacks");
            assert_eq!(*client.reports.lock().unwrap(), vec![Outcome::Cancelled]);
            assert_eq!(*client.cancelled.lock().unwrap(), usize::from(cancels));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_person_status_accepts_the_normalized_provider_code() {
    let status = sample(CODES, "auth-required-codeless.store.after.run.status.json");
    let refusal = wait(send_error(&Runner::waiting(status), SendKind::FactCheck).await);
    assert_eq!(refusal.code, "auth_required");
    assert_eq!(
        refusal.until_ms,
        refusal.at_ms + super::super::account_wait::DEFAULT_WAIT_MS
    );
}

#[tokio::test(start_paused = true)]
async fn run_awaits_person_result_never_counts_a_summary_failure() {
    for cancels in [true, false] {
        let mut result: RunResult = sample(AWAITS, "terminal-sign-in.after.run.result.json");
        // A person's sign-in has no time, even if a runner supplies old hints.
        result.awaits.as_mut().unwrap().next_ms = Some(u64::MAX);
        result.error.as_mut().unwrap().retry_after_secs = Some(1.0);
        let client = Runner {
            cancels,
            ..Runner::ended(result)
        };
        let started = tokio::time::Instant::now();
        let refusal = wait(
            run(&client, None, &account_wait_send_tests::job())
                .await
                .unwrap_err(),
        );
        assert_eq!(
            tokio::time::Instant::now(),
            started,
            "ended runs wait at once"
        );
        assert_eq!(
            refusal.until_ms,
            refusal.at_ms + super::super::account_wait::DEFAULT_WAIT_MS
        );
        assert_eq!(*client.sends.lock().unwrap(), 1);
        assert_eq!(*client.reports.lock().unwrap(), vec![Outcome::Cancelled]);
        assert_eq!(*client.cancelled.lock().unwrap(), usize::from(cancels));
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_person_nonterminal_result_survives_a_status_read_failure() {
    for state in [states::PAUSED, states::ACTIVE] {
        let mut run: RunResult = sample(AWAITS, "terminal-sign-in.after.run.result.json");
        run.state = state.into();
        let client = Runner::ended(run);
        let refusal = wait(send_error(&client, SendKind::TurnOne).await);
        assert_eq!(
            refusal.until_ms,
            refusal.at_ms + super::super::account_wait::DEFAULT_WAIT_MS
        );
        assert_eq!(*client.cancelled.lock().unwrap(), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_nobody_status_keeps_the_timeout() {
    for state in [states::PAUSED, states::ACTIVE] {
        let mut status: RunStatus =
            sample(CODES, "terminal-unknown-code.store.after.run.status.json");
        status.state = state.into();
        let client = Runner::waiting(status);
        let started = tokio::time::Instant::now();
        assert_eq!(
            send_error(&client, SendKind::TurnOne).await,
            SummaryError::Failed("the run did not finish in time".into())
        );
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_secs(2)
        );
        assert_eq!(
            *client.cancelled.lock().unwrap(),
            usize::from(state == states::PAUSED)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_nobody_result_keeps_the_provider_failure() {
    for (set, name) in [
        (AWAITS, "terminal-final.after.run.result.json"),
        (CODES, "terminal-unknown-code.store.after.run.result.json"),
    ] {
        let client = Runner::ended(sample(set, name));
        assert!(matches!(
            send_error(&client, SendKind::TurnOne).await,
            SummaryError::Failed(_)
        ));
        assert_eq!(*client.cancelled.lock().unwrap(), 0);
    }
}

fn caller_account() -> RunResult {
    let mut run: RunResult = sample(AWAITS, "terminal-account.after.run.result.json");
    let error = run.error.as_mut().unwrap();
    error.retry_after_secs = Some(120.0);
    error.resets_at_ms = Some((now_ms() + 2_400_000) as u64);
    run.awaits.as_mut().unwrap().next_ms = Some((now_ms() + 600_000) as u64);
    run
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_status_next_precedes_resume_error_and_reset() {
    for state in [states::PAUSED, states::ACTIVE] {
        let run = caller_account();
        let next = run.awaits.as_ref().unwrap().next_ms.unwrap();
        let mut status = RunStatus::new(state).with_awaits(run.awaits.unwrap());
        status.error = run.error;
        status.resume_not_before_ms = Some((now_ms() + 1_200_000) as u64);
        let client = Runner::waiting(status);
        let refusal = wait(send_error(&client, SendKind::TurnOne).await);
        assert_eq!(refusal.until_ms, next as i64);
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_status_without_next_keeps_the_resume_floor() {
    let mut run = caller_account();
    run.awaits.as_mut().unwrap().next_ms = None;
    let resume = (now_ms() + 1_200_000) as u64;
    let mut status = RunStatus::new(states::PAUSED).with_awaits(run.awaits.unwrap());
    status.error = run.error;
    status.resume_not_before_ms = Some(resume);
    let refusal = wait(send_error(&Runner::waiting(status), SendKind::TurnOne).await);
    assert_eq!(refusal.until_ms, resume as i64);
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_result_next_precedes_error_hints_and_keeps_caps() {
    use super::super::account_wait::{MAX_WAIT_MS, MIN_WAIT_MS};
    for next in [0, (now_ms() + 600_000) as u64, u64::MAX] {
        let mut run = caller_account();
        run.awaits.as_mut().unwrap().next_ms = Some(next);
        let client = Runner::ended(run);
        let refusal = wait(send_error(&client, SendKind::TurnOne).await);
        let expected = i64::try_from(next)
            .unwrap_or(i64::MAX)
            .clamp(refusal.at_ms + MIN_WAIT_MS, refusal.at_ms + MAX_WAIT_MS);
        assert_eq!(refusal.until_ms, expected);
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_runner_status_waits_to_the_existing_deadline() {
    for (name, account) in [
        ("held.after.run.status.json", false),
        ("account-limit.after.run.status.json", true),
    ] {
        let mut status: RunStatus = sample(AWAITS, name);
        let resume = (now_ms() + 600_000) as u64;
        if account {
            status.resume_not_before_ms = Some(resume);
            status.awaits.as_mut().unwrap().next_ms = Some(resume);
        }
        let client = Runner::waiting(status);
        let started = tokio::time::Instant::now();
        let error = send_error(&client, SendKind::TurnOne).await;
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_secs(2)
        );
        if account {
            assert_eq!(wait(error).until_ms, resume as i64);
        } else {
            assert!(matches!(error, SummaryError::Failed(_)));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_runner_result_waits_then_uses_existing_ending_rules() {
    // Runners declaring the run_awaits contract capability cannot put a
    // runner-owned wait on a terminal error. The defensive reader path still
    // must not cut the caller's deadline short when such a body arrives.
    let mut run: RunResult = sample(AWAITS, "terminal-final.after.run.result.json");
    run.awaits.as_mut().unwrap().party = AwaitParty::Runner;
    let client = Runner::ended(run);
    let started = tokio::time::Instant::now();
    assert!(matches!(
        send_error(&client, SendKind::TurnOne).await,
        SummaryError::Failed(_)
    ));
    assert_eq!(
        tokio::time::Instant::now() - started,
        Duration::from_secs(2)
    );
}

#[tokio::test(start_paused = true)]
async fn run_awaits_unknown_status_and_absent_status_keep_legacy_behavior() {
    for state in [states::PAUSED, states::ACTIVE] {
        for unknown in [true, false] {
            let mut status: RunStatus =
                sample(CODES, "auth-required-codeless.legacy.after.run.status.json");
            status.state = state.into();
            if unknown {
                let mut awaits = RunAwaits::new(AwaitParty::Unknown("future_party".into()), 1);
                awaits.next_ms = Some(u64::MAX);
                awaits.message = Some(AwaitMessage::new(
                    "Sign in to continue",
                    AwaitMessageFrom::Runner,
                ));
                status.awaits = Some(awaits);
            }
            let client = Runner::waiting(status);
            assert_eq!(
                send_error(&client, SendKind::TurnOne).await,
                SummaryError::Failed("the run did not finish in time".into())
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_unknown_result_and_absent_result_keep_legacy_behavior() {
    for unknown in [true, false] {
        let mut run = caller_account();
        run.awaits = unknown.then(|| {
            let mut awaits = RunAwaits::new(AwaitParty::Unknown("future_party".into()), 1);
            awaits.next_ms = Some(u64::MAX);
            awaits
        });
        let client = Runner::ended(run);
        let refusal = wait(send_error(&client, SendKind::TurnOne).await);
        assert_eq!(refusal.until_ms, refusal.at_ms + 120_000);
    }
}

fn transient(next: Option<u64>) -> RunResult {
    let mut run: RunResult = sample(CODES, "transient-codeless.store.after.run.result.json");
    run.awaits.as_mut().unwrap().next_ms = next;
    run
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_transient_direct_calls_wait_only_with_next_ms() {
    for send in [SendKind::TurnTwo, SendKind::FactCheck] {
        let next = (now_ms() + 600_000) as u64;
        let client = Runner::ended(transient(Some(next)));
        let refusal = wait(send_error(&client, send).await);
        assert_eq!(refusal.until_ms, next as i64);
        assert_eq!(refusal.send, send);
        let client = Runner::ended(transient(None));
        assert!(matches!(
            send_error(&client, send).await,
            SummaryError::Failed(_)
        ));
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_transient_status_keeps_a_named_wait_at_the_deadline() {
    for state in [states::PAUSED, states::ACTIVE] {
        let next = (now_ms() + 600_000) as u64;
        let run = transient(Some(next));
        let mut status = RunStatus::new(state).with_awaits(run.awaits.unwrap());
        status.error = run.error;
        assert_eq!(
            wait(send_error(&Runner::waiting(status), SendKind::TurnOne).await).until_ms,
            next as i64
        );
    }
}

async fn attempt_on(
    client: &Runner,
    deadline: tokio::time::Instant,
) -> Result<(String, Child), SummaryError> {
    let target = Target {
        model: ModelRef::new("test", "model"),
        decision_id: "decision".into(),
        output_tokens: 1000,
    };
    let call_on = Call {
        prompts: &crate::summary::prompts::SummaryPrompts::bundled(),
        target: &target,
        child_harness: "pi",
        window: fit::Window {
            counter: crate::count::Counter::for_model(None),
            context_window: 400_000,
        },
        deadline,
        system: "system",
    };
    attempt(
        client,
        &account_wait_send_tests::job(),
        "summary",
        "prompt",
        &call_on,
        &mut None,
    )
    .await
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_transient_retry_honors_next_and_existing_backoff() {
    for floor_ms in [0, 10_000] {
        let client = Runner::ended(transient(Some((now_ms() + floor_ms) as u64)));
        let mut completed = RunResult::new("r1", states::COMPLETED);
        completed.final_message = Some(cortexkit_role_llm_runner::run::FinalMessage {
            ordinal: 1,
            mid: "answer".into(),
            text: "summary".into(),
        });
        client.results.lock().unwrap().push_back(completed);
        let started = tokio::time::Instant::now();
        let (text, _) = attempt_on(&client, started + Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(text, "summary");
        let elapsed = tokio::time::Instant::now() - started;
        if floor_ms == 0 {
            assert!((Duration::from_secs(2)..Duration::from_secs(3)).contains(&elapsed));
        } else {
            assert!((Duration::from_millis(9_900)..=Duration::from_secs(10)).contains(&elapsed));
        }
        assert_eq!(*client.sends.lock().unwrap(), 2);
    }
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_transient_past_the_run_deadline_is_not_an_attempt() {
    let next = (now_ms() + 600_000) as u64;
    let client = Runner::ended(transient(Some(next)));
    let started = tokio::time::Instant::now();
    let refusal = wait(
        attempt_on(&client, started + Duration::from_secs(2))
            .await
            .unwrap_err(),
    );
    assert_eq!(refusal.until_ms, next as i64);
    assert_eq!(
        tokio::time::Instant::now(),
        started,
        "do not sleep towards an unusable floor"
    );
    assert_eq!(*client.sends.lock().unwrap(), 1);
}

#[tokio::test(start_paused = true)]
async fn run_awaits_caller_transient_next_keeps_the_existing_retry_count() {
    let client = Runner::ended(transient(Some(0)));
    let error = attempt_on(
        &client,
        tokio::time::Instant::now() + Duration::from_secs(60),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, SummaryError::Failed(_)));
    assert_eq!(*client.sends.lock().unwrap(), 1 + MAX_RETRIES);
}

#[test]
fn run_awaits_real_bodies_match_their_published_hashes() {
    use sha2::{Digest, Sha256};
    for set in [AWAITS, CODES] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join(set);
        for line in std::fs::read_to_string(root.join("SHA256SUMS"))
            .unwrap()
            .lines()
        {
            let (expected, name) = line.split_once("  ").unwrap();
            let bytes = std::fs::read(root.join(name)).unwrap();
            if name.ends_with("run.status.json") {
                let _: RunStatus = serde_json::from_slice(&bytes).unwrap();
            } else {
                let _: RunResult = serde_json::from_slice(&bytes).unwrap();
            }
            assert_eq!(
                format!("{:x}", Sha256::digest(bytes)),
                expected,
                "{set}/{name}"
            );
        }
    }
}
