//! Broca's capacity refusal bodies as seen by the shared child-run reader.

use super::*;
use crate::summary::account_wait::{MAX_WAIT_MS, MIN_WAIT_MS};
use cortexkit_role_llm_runner::run::RunReason;
use cortexkit_role_llm_runner::wire::read_reply;
use serde::de::DeserializeOwned;

const CAPTURE_PAUSE_MS: i64 = 1_795_635_654_113;
const CAPTURE_WAKE_MS: i64 = 1_795_635_774_113;
const CAPTURE_CALLER_NEXT_MS: i64 = 1_796_240_574_113;

fn reply<T: DeserializeOwned>(name: &str) -> T {
    let path = format!(
        "{}/testdata/capacity-refusal-1125b/{name}",
        env!("CARGO_MANIFEST_DIR"),
    );
    read_reply(&std::fs::read(&path).expect(&path)).expect(&path)
}

fn without_alternate_route(mut client: Runner) -> Runner {
    // Keep the original wait visible after proving that routing was asked
    // again. A refusal with a new reset would supersede the original time.
    client.base = client.base.with_route_refusal_after(
        1,
        routing::RouteError {
            code: "no_route".into(),
            message: "no alternate route".into(),
            detail: None,
        },
    );
    client
}

async fn summary_wait(client: &Runner, code: &str, selects: usize) -> AccountWait {
    let refusal = wait(
        run(client, None, &account_wait_send_tests::job())
            .await
            .expect_err("the summary did not finish"),
    );
    assert_eq!(refusal.code, code);
    assert_eq!(*client.selects.lock().unwrap(), selects);
    assert_eq!(*client.reports.lock().unwrap(), [Outcome::Cancelled]);
    refusal
}

fn assert_absolute_floor(refusal: &AccountWait, hint_ms: i64) {
    assert_eq!(
        refusal.until_ms,
        hint_ms.clamp(refusal.at_ms + MIN_WAIT_MS, refusal.at_ms + MAX_WAIT_MS),
    );
}

#[tokio::test(start_paused = true)]
async fn direct_admission_refusal_reselects_then_waits_one_minute() {
    let error = crate::transport::send_refusal_from_wire_for_test(include_bytes!(
        "../../testdata/capacity-refusal-1125b/admission-direct.session.send.json"
    ));
    assert_eq!(
        error.detail.as_ref().unwrap()["routing_detail"]["reason"],
        "concurrency_full"
    );
    let client = without_alternate_route(Runner::ended(RunResult::new("r1", states::ACTIVE)));
    client.send_answers.lock().unwrap().push_back(Err(error));
    let refusal = summary_wait(&client, "account_selection_refused", 2).await;
    assert_eq!(refusal.until_ms, refusal.at_ms + 60_000);
    assert_eq!(*client.sends.lock().unwrap(), 1);
    assert_eq!(*client.reads.lock().unwrap(), 0);
    assert_eq!(*client.cancelled.lock().unwrap(), 0);
}

#[tokio::test(start_paused = true)]
async fn ordered_admission_pending_replays_the_same_send_until_named() {
    let pending: SendReply = reply("admission-ordered.session.send.json");
    assert_eq!(pending.state, send_states::PENDING);
    assert_eq!(
        pending.submission_id.as_deref(),
        Some("sub-run-sid-vsDCMgsVSiMIfw2VM4iAq")
    );
    assert!(pending.run_id.is_none());
    let client = Runner::ended(
        RunResult::new("r1", states::ERROR).with_error(RunError::new(
            "transient",
            "routing refused the run",
            "account_selection_refused",
        )),
    );
    client.send_answers.lock().unwrap().push_back(Ok(pending));
    let start = tokio::time::Instant::now();
    let refusal = wait(send_error(&client, SendKind::TurnOne).await);
    assert!(start.elapsed() > Duration::ZERO);
    assert_eq!(refusal.code, "account_selection_refused");
    assert_eq!(*client.sent_ids.lock().unwrap(), ["send", "send"]);
    assert_eq!(*client.polled_ids.lock().unwrap(), ["r1"]);
    assert!(client.withdrawn.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ordered_admission_finished_shape_follows_the_named_run() {
    // The child-run reader does not call session.send_status. The receipt has
    // a SendReply shape; when replaying session.send gives a finished receipt,
    // the named run's result determines the outcome.
    let finished: SendReply = reply("admission-ordered.session.send_status.json");
    assert_eq!(finished.state, send_states::FINISHED);
    assert_eq!(finished.reason.as_deref(), Some("error"));
    let id = finished.run_id.clone().expect("a run-shaped refusal id");
    let result = RunResult::new(&id, states::ERROR).with_error(
        RunError::new(
            "transient",
            "routing refused the run",
            "account_selection_refused",
        )
        .with_retry_after_secs(30.0),
    );
    let client = without_alternate_route(Runner::ended(result));
    client.send_answers.lock().unwrap().push_back(Ok(finished));
    let refusal = summary_wait(&client, "account_selection_refused", 2).await;
    assert_eq!(refusal.until_ms, refusal.at_ms + 60_000);
    assert_eq!(*client.sends.lock().unwrap(), 1);
    assert_eq!(*client.polled_ids.lock().unwrap(), [id]);
    assert_eq!(*client.cancelled.lock().unwrap(), 0);
}

#[tokio::test(start_paused = true)]
async fn ordered_admission_status_alone_cannot_replace_a_missing_result() {
    let status: RunStatus = reply("admission-ordered.run.status.json");
    assert_eq!(status.state, states::ERROR);
    assert_eq!(status.usage.as_ref().unwrap().steps, 0);
    assert!(status.awaits.is_none());

    // No admission run.result was captured. The same error in a result is a
    // wait, but status supplies no caller-owned wait for cleanup to adopt.
    let result_shaped = without_alternate_route(Runner::waiting(status.clone()));
    let refusal = summary_wait(&result_shaped, "account_selection_refused", 2).await;
    assert_eq!(refusal.until_ms, refusal.at_ms + 60_000);
    assert_eq!(*result_shaped.cancelled.lock().unwrap(), 0);

    let status_only = Runner {
        status: Some(status),
        failed_reads: usize::MAX,
        ..Runner::ended(RunResult::new("r1", states::ACTIVE))
    };
    let failure = run(&status_only, None, &account_wait_send_tests::job())
        .await
        .unwrap_err();
    assert!(matches!(failure, SummaryError::Failed(message) if message.contains(TIMED_OUT)));
    assert_eq!(*status_only.reports.lock().unwrap(), [Outcome::Failed]);
    assert_eq!(*status_only.cancelled.lock().unwrap(), 0);
}

#[tokio::test(start_paused = true)]
async fn paused_continuation_cancels_now_and_reselects_as_an_account_limit() {
    let status: RunStatus = reply("continuation-paused.run.status.json");
    assert_eq!(status.state, states::PAUSED);
    assert_eq!(status.reason, Some(RunReason::AccountLimit));
    let awaits = status.awaits.as_ref().unwrap();
    assert_eq!(awaits.party, AwaitParty::Runner);
    assert_eq!(awaits.next_ms, Some(CAPTURE_WAKE_MS as u64));
    let resume = status.resume_not_before_ms;
    assert_eq!(resume, Some(CAPTURE_WAKE_MS as u64));
    assert_eq!(status.usage.as_ref().unwrap().steps, 0);

    // As on older Broca runs, the result stub carries the pause and provider
    // error; only the captured status carries the runner-owned wake.
    let client = without_alternate_route(Runner::waiting(status));
    let start = tokio::time::Instant::now();
    let refusal = summary_wait(&client, "account_limit_exhausted", 2).await;
    assert_eq!(start.elapsed(), Duration::ZERO);
    assert_eq!(*client.cancelled.lock().unwrap(), 1);
    assert_eq!(*client.reads.lock().unwrap(), 1);
    assert_absolute_floor(&refusal, CAPTURE_WAKE_MS);
    let results = client.results.lock().unwrap();
    let fixed = AccountWait::of_paused_run(
        results.front().unwrap(),
        resume,
        SendKind::TurnOne,
        CAPTURE_PAUSE_MS,
    )
    .unwrap();
    assert_eq!(fixed.until_ms, CAPTURE_WAKE_MS);
}

#[tokio::test(start_paused = true)]
async fn terminal_continuation_status_supplies_the_caller_floor_at_cleanup() {
    let status: RunStatus = reply("continuation.run.status.json");
    assert_eq!(status.state, states::ERROR);
    assert_eq!(status.usage.as_ref().unwrap().steps, 0);
    let awaits = status.awaits.as_ref().unwrap();
    assert_eq!(awaits.party, AwaitParty::Caller);
    assert_eq!(awaits.next_ms, Some(CAPTURE_CALLER_NEXT_MS as u64));

    let client = Runner {
        status: Some(status),
        ..Runner::ended(RunResult::new("r1", states::ACTIVE))
    };
    let start = tokio::time::Instant::now();
    let refusal = summary_wait(&client, "account_limit_exhausted", 1).await;
    assert_eq!(start.elapsed(), RUN_TIMEOUT);
    assert!(*client.reads.lock().unwrap() > 1);
    assert_eq!(*client.cancelled.lock().unwrap(), 0);
    assert_absolute_floor(&refusal, CAPTURE_CALLER_NEXT_MS);
}

#[tokio::test(start_paused = true)]
async fn terminal_continuation_result_reselects_then_uses_the_caller_floor() {
    let result: RunResult = reply("continuation.run.result.json");
    assert_eq!(result.state, states::ERROR);
    assert_eq!(result.usage.as_ref().unwrap().steps, 0);
    assert!(result.final_message.is_none());

    // At capture the caller's hint is seven days away. Near that hint, it
    // still wins over the provider's relative delay and distant reset.
    let at_capture =
        AccountWait::of_ended_run(&result, SendKind::TurnOne, CAPTURE_WAKE_MS).unwrap();
    assert_eq!(at_capture.until_ms, CAPTURE_WAKE_MS + 6 * 60 * 60 * 1_000);
    let near_floor =
        AccountWait::of_ended_run(&result, SendKind::TurnOne, CAPTURE_CALLER_NEXT_MS - 120_000)
            .unwrap();
    assert_eq!(near_floor.until_ms, CAPTURE_CALLER_NEXT_MS);

    let id = result.run_id.clone();
    let mut send_reply = SendReply::new(states::ACTIVE);
    send_reply.run_id = Some(id.clone());
    let client = without_alternate_route(Runner::ended(result));
    client
        .send_answers
        .lock()
        .unwrap()
        .push_back(Ok(send_reply));
    let start = tokio::time::Instant::now();
    let refusal = summary_wait(&client, "account_limit_exhausted", 2).await;
    assert_eq!(start.elapsed(), Duration::ZERO);
    assert_eq!(*client.polled_ids.lock().unwrap(), [id]);
    assert_eq!(*client.cancelled.lock().unwrap(), 0);
    assert_absolute_floor(&refusal, CAPTURE_CALLER_NEXT_MS);
}
