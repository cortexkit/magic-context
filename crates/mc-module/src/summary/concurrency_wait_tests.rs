//! Routing's full capacity (`concurrency_full`): every eligible account on
//! every adequate route is already running as many runs as its cap allows.
//! Whether routing refuses the select, the runner refuses the send or ends
//! the run with it, or the runner pauses a started run for it, the summary
//! waits until the time routing named, and nothing counts as failed.

use super::*;
use crate::summary::account_wait::{now_ms, DEFAULT_WAIT_MS};
use serde_json::json;

/// Routing's refusal when every slot is taken, with its reset when given.
fn full(reset: Option<i64>) -> RouteError {
    let mut detail = json!({"reason": "concurrency_full"});
    if let Some(reset) = reset {
        detail["reset_at_ms"] = json!(reset);
    }
    RouteError {
        code: "no_route".into(),
        message: "every account on every adequate route is at its cap".into(),
        detail: Some(detail),
    }
}

/// The wait a summary run ended with; any other ending fails the test.
fn waited(error: SummaryError) -> AccountWait {
    match error {
        SummaryError::AccountWait(wait) => wait,
        SummaryError::Failed(error) => panic!("full capacity counted as a failure: {error}"),
    }
}

#[tokio::test]
async fn concurrency_full_select_waits_until_routing_s_reset_without_starting_a_run() {
    let reset = now_ms() + 10 * 60_000;
    let client = Client::new(Answer::RunEndsFinal).with_route_refusal_after(0, full(Some(reset)));
    let wait = waited(
        run(&client, None, &job())
            .await
            .expect_err("routing refused"),
    );
    assert_eq!(wait.until_ms, reset);
    assert_eq!(wait.code, "no_route:concurrency_full");
    assert_eq!(wait.send, SendKind::TurnOne);
    assert_eq!(*client.selects.lock().unwrap(), 1);
    assert_eq!(*client.sends.lock().unwrap(), 0);
    assert!(client.reports.lock().unwrap().is_empty());
}

/// Routing always names a time for full capacity, but a refusal without one
/// still means wait: summaries wait the default five minutes.
#[tokio::test]
async fn concurrency_full_select_without_a_reset_waits_the_default_five_minutes() {
    let client = Client::new(Answer::RunEndsFinal).with_route_refusal_after(0, full(None));
    let wait = waited(
        run(&client, None, &job())
            .await
            .expect_err("routing refused"),
    );
    assert_eq!(wait.until_ms, wait.at_ms + DEFAULT_WAIT_MS);
    assert_eq!(wait.code, "no_route:concurrency_full");
    assert_eq!(*client.sends.lock().unwrap(), 0);
    assert!(client.reports.lock().unwrap().is_empty());
}

/// A runner's `concurrency_full`, refusing the send or ending the run it
/// queued, is a wait (`errors::is_wait`) until routing's reset: one send, no
/// retry or other model, and routing hears the decision cancelled.
#[tokio::test]
async fn concurrency_full_from_the_runner_waits_until_its_reset() {
    let reset = now_ms() + 10 * 60_000;
    for answer in [
        Answer::RefuseSendCapacity(reset),
        Answer::RunEndsCapacity(reset),
    ] {
        let client = Client::new(answer);
        let wait = waited(run(&client, None, &job()).await.expect_err("no summary"));
        assert_eq!(wait.code, "concurrency_full");
        assert_eq!(wait.until_ms, reset);
        assert_eq!(wait.send, SendKind::TurnOne);
        assert_eq!(*client.sends.lock().unwrap(), 1);
        assert_eq!(*client.selects.lock().unwrap(), 1);
        assert_eq!(*client.reports.lock().unwrap(), vec![Outcome::Cancelled]);
    }
}

/// A run the runner paused for full capacity, still paused when the call's
/// time runs out, ends as a wait under that reason: until the runner's
/// resume time, or the default wait without one.
#[tokio::test]
async fn concurrency_full_a_run_paused_for_capacity_at_its_deadline_is_a_wait() {
    let resume = now_ms() + 20 * 60_000;
    let client = PausedRunner {
        resume_not_before_ms: Some(resume as u64),
        ..PausedRunner::new(Some("concurrency_full"))
    };
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.code, "concurrency_full");
    assert_eq!(wait.until_ms, resume);

    let client = PausedRunner::new(Some("concurrency_full"));
    let wait = pause_at_deadline(&client).await;
    assert_eq!(wait.code, "concurrency_full");
    assert_eq!(wait.until_ms, wait.at_ms + DEFAULT_WAIT_MS);
}
