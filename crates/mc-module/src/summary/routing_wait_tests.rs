//! Refusals before a summary has a route use the same account-wait result
//! as a runner refusal, without creating a child or spending a model attempt.

use super::*;
use crate::summary::account_wait::{MAX_ROUTING_WAIT_MS, MIN_WAIT_MS};
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;

fn refusal(detail: Value) -> RouteError {
    RouteError {
        code: "no_route".into(),
        message: "no eligible route".into(),
        detail: Some(detail),
    }
}

fn wait(detail: Value) -> Option<AccountWait> {
    AccountWait::of_routing(&refusal(detail), SendKind::TurnOne, NOW)
}

#[tokio::test]
async fn routing_account_wait_timed_all_inadequate_starts_no_run_or_attempt() {
    let reset = super::super::super::account_wait::now_ms() + 20 * 60_000;
    let mut client = Client::new(Answer::RefuseSendFinal);
    client.route_refusal = Some(refusal(json!({
        "reason": "all_inadequate", "reset_at_ms": reset
    })));
    let error = run(&client, None, &job())
        .await
        .expect_err("routing refused");
    let SummaryError::AccountWait(wait) = error else {
        panic!("a timed refusal counted as a failure: {error:?}");
    };
    assert_eq!(wait.until_ms, reset);
    assert_eq!(wait.code, "no_route:all_inadequate");
    assert_eq!(wait.send, SendKind::TurnOne);
    assert_eq!(*client.selects.lock().unwrap(), 1);
    assert_eq!(*client.sends.lock().unwrap(), 0);
    assert!(client.reports.lock().unwrap().is_empty());
}

#[tokio::test]
async fn routing_account_wait_fallback_refusal_keeps_the_failed_route_outcome() {
    let client = Client::new(Answer::RunEndsFinal).with_route_refusal_after(
        1,
        refusal(json!({"reason": "all_inadequate", "reset_at_ms": NOW})),
    );
    let error = run(&client, None, &job())
        .await
        .expect_err("the first route failed");
    let SummaryError::Failed(message) = error else {
        panic!("a fallback refusal hid the route failure: {error:?}");
    };
    assert_eq!(
        message,
        format!(
            "the run ended error: {} (child head:mc-summary:1-4:decision-1:turn-one)",
            Answer::RunEndsFinal.run_end().error.unwrap().message
        )
    );
    assert_eq!(*client.selects.lock().unwrap(), 2);
    assert_eq!(*client.sends.lock().unwrap(), 1);
    assert_eq!(*client.reports.lock().unwrap(), vec![Outcome::Failed]);
}

#[tokio::test]
async fn routing_account_wait_untimed_all_inadequate_and_permanent_reasons_still_fail() {
    for reason in [
        "all_inadequate",
        "no_available_model",
        "missing_capability",
        "unknown_reason",
    ] {
        let mut client = Client::new(Answer::RefuseSendFinal);
        client.route_refusal = Some(refusal(json!({"reason": reason})));
        let error = run(&client, None, &job())
            .await
            .expect_err("routing refused");
        assert!(
            matches!(error, SummaryError::Failed(_)),
            "{reason}: {error:?}"
        );
        assert_eq!(*client.selects.lock().unwrap(), 1);
        assert_eq!(*client.sends.lock().unwrap(), 0);
        assert!(client.reports.lock().unwrap().is_empty());
    }
}

#[test]
fn routing_account_wait_temporary_reasons_without_a_time_wait_five_minutes() {
    for reason in ["quota_or_cooldown", "accounts_blocked"] {
        let wait = wait(json!({"reason": reason})).expect(reason);
        assert_eq!(wait.until_ms, NOW + 5 * 60_000);
        assert_eq!(wait.code, format!("no_route:{reason}"));
    }
}

#[test]
fn routing_account_wait_any_stated_reset_wins_regardless_of_reason() {
    for reason in ["all_inadequate", "unknown_reason", "missing_capability"] {
        let wait = wait(json!({"reason": reason, "reset_at_ms": NOW + 20 * 60_000})).unwrap();
        assert_eq!(wait.until_ms, NOW + 20 * 60_000);
    }
}

#[test]
fn routing_account_wait_bounds_are_one_minute_and_one_hour_not_six_hours() {
    for (reset, expected) in [
        (NOW - 1_000, NOW + MIN_WAIT_MS),
        (NOW + 10 * 24 * 3_600_000, NOW + MAX_ROUTING_WAIT_MS),
    ] {
        assert_eq!(
            wait(json!({"reset_at_ms": reset})).unwrap().until_ms,
            expected
        );
    }
}

#[test]
fn routing_account_wait_malformed_detail_fields_are_independently_absent() {
    for detail in [
        Value::Null,
        json!([]),
        json!({"reason": 1, "reset_at_ms": "later"}),
    ] {
        assert_eq!(wait(detail), None);
    }
    assert_eq!(
        wait(json!({"reason": 1, "reset_at_ms": NOW + 120_000}))
            .unwrap()
            .until_ms,
        NOW + 120_000
    );
    assert_eq!(
        wait(json!({"reason": "quota_or_cooldown", "reset_at_ms": "later"}))
            .unwrap()
            .until_ms,
        NOW + 5 * 60_000
    );
    for reset in [json!(-1), json!(1.5), Value::Null] {
        assert_eq!(
            wait(json!({"reason": "all_inadequate", "reset_at_ms": reset})),
            None
        );
    }
}
