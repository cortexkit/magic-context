//! The account-selection refusals Broca's serve path answers with under
//! llm-runner 0.8.41 (`testdata/account-wait-0.8.41/`), read the way ck-mc
//! reads a refused send and a run that ended `error`.

use super::*;
use cortexkit_role_llm_runner::run::{states, RunStatus};

const NOW: i64 = 1_800_000_000_000;

fn body(name: &str) -> Value {
    let path = format!(
        "{}/testdata/account-wait-0.8.41/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path)
}

/// A refused send's error body, as the transport hands ck-mc its outer code
/// and detail.
fn refusal(name: &str) -> Option<AccountWait> {
    let body = body(name);
    AccountWait::of_refusal(
        body["code"].as_str().unwrap(),
        body.get("detail"),
        SendKind::TurnOne,
        NOW,
    )
}

/// The error of the run a queued send would have started, refused at its
/// own admission.
fn queued(code: &str) -> RunError {
    let name = format!("5_queued_{code}.new");
    assert_eq!(
        body(&format!("{name}.session_send.json"))["result"]["state"],
        "pending"
    );
    let finished = &body(&format!("{name}.session_send_status.json"))["result"];
    assert_eq!(
        (finished["state"].as_str(), finished["reason"].as_str()),
        (Some("finished"), Some("error"))
    );
    let status: RunStatus =
        serde_json::from_value(body(&format!("{name}.run_status.json"))["result"].clone())
            .expect("a run.status answer");
    assert_eq!(status.state, states::ERROR);
    status.error.expect("the run's error")
}

#[test]
fn account_wait_vectors_send_refusals_wait_from_the_relative_hint_first() {
    // Both hints: the contract puts the relative one first, so the far reset
    // in 2100 does not stretch the wait.
    let wait = refusal("1_account_limit_exhausted_retry_and_reset.new.plan.json").unwrap();
    assert_eq!(wait.code, "account_limit_exhausted");
    assert_eq!(wait.until_ms, NOW + 120_000);
    let wait = refusal("2_account_limit_exhausted_reset_only.new.plan.json").unwrap();
    assert_eq!(wait.until_ms, NOW + 90_000);
    let wait = refusal("3_account_selection_refused_retry.new.plan.json").unwrap();
    assert_eq!(wait.code, "account_selection_refused");
    assert_eq!(
        wait.until_ms,
        NOW + MIN_WAIT_MS,
        "a 30 s hint waits the minimum"
    );
}

#[test]
fn account_wait_vectors_final_selection_refusals_are_no_wait() {
    // A permanent routing code, and one the runner does not know, which
    // carries a retry hint that must not make it a wait.
    assert_eq!(
        refusal("4_account_selection_final_no_hint.new.plan.json"),
        None
    );
    let unknown = body("7_unknown_code_final.new.plan.json");
    assert_eq!(unknown["detail"]["retry_after_s"], 60);
    assert_eq!(refusal("7_unknown_code_final.new.plan.json"), None);
    assert_eq!(
        AccountWait::of_run_error(&queued("account_selection_final"), SendKind::TurnTwo, NOW),
        None
    );
}

#[test]
fn account_wait_vectors_a_queued_send_refused_at_admission_waits_from_its_run_error() {
    // The send was accepted (`pending`); the refusal is on the run it would
    // have started, under `provider_code`.
    let wait =
        AccountWait::of_run_error(&queued("account_limit_exhausted"), SendKind::TurnTwo, NOW)
            .unwrap();
    assert_eq!(
        wait,
        AccountWait {
            code: "account_limit_exhausted".into(),
            until_ms: NOW + 120_000,
            at_ms: NOW,
            send: SendKind::TurnTwo,
        }
    );
    let wait = AccountWait::of_run_error(
        &queued("account_selection_refused"),
        SendKind::FactCheck,
        NOW,
    )
    .unwrap();
    assert_eq!(wait.code, "account_selection_refused");
    assert_eq!(
        wait.until_ms,
        NOW + MIN_WAIT_MS,
        "a 30 s hint waits the minimum"
    );
}

#[test]
fn account_wait_vectors_a_wait_without_timing_lasts_five_minutes() {
    let untimed = RunError::new(
        "transient",
        "no account free",
        errors::ACCOUNT_SELECTION_REFUSED,
    );
    let wait = AccountWait::of_run_error(&untimed, SendKind::TurnOne, NOW).unwrap();
    assert_eq!(wait.until_ms, NOW + DEFAULT_WAIT_MS);
}

#[test]
fn account_wait_vectors_only_the_outer_code_names_a_wait() {
    // The same detail under any other outer code is no account wait, and a
    // run error whose provider code is another limit is not one either.
    let detail = body("1_account_limit_exhausted_retry_and_reset.new.plan.json")["detail"].clone();
    assert_eq!(
        AccountWait::of_refusal("transient", Some(&detail), SendKind::TurnOne, NOW),
        None
    );
    let billing = RunError::new("permanent", "billing", "billing_exhausted");
    assert_eq!(
        AccountWait::of_run_error(&billing, SendKind::TurnOne, NOW),
        None
    );
}

#[test]
fn account_wait_vectors_waits_are_capped_at_six_hours() {
    // A weekly reset days away.
    let weekly = RunError::new("transient", "weekly limit", "account_limit_exhausted")
        .with_resets_at_ms((NOW + 3 * 24 * 60 * 60 * 1000) as u64);
    let wait = AccountWait::of_run_error(&weekly, SendKind::TurnOne, NOW).unwrap();
    assert_eq!(wait.until_ms, NOW + MAX_WAIT_MS);
}

/// A hint of zero, a hint under a minute, or a reset already past still
/// waits a minute: otherwise every notice would ask the same accounts again.
#[test]
fn account_wait_vectors_a_wait_lasts_at_least_a_minute() {
    assert_eq!(until(NOW, Some(0.0), None), NOW + MIN_WAIT_MS);
    assert_eq!(until(NOW, Some(1.5), None), NOW + MIN_WAIT_MS);
    assert_eq!(
        until(NOW, None, Some((NOW - 1_000) as u64)),
        NOW + MIN_WAIT_MS
    );
    assert_eq!(until(NOW, Some(61.0), None), NOW + 61_000);
}

/// A refused send's detail is read by name, in that body's own spelling:
/// `retry_after_secs`, or the whole seconds of `retry_after_s` without it.
/// Case 3 names no reset, so a misspelled read would fall to the five-minute
/// default.
#[test]
fn account_wait_vectors_a_refused_send_reads_its_own_retry_spelling() {
    let body = body("3_account_selection_refused_retry.new.plan.json");
    for kept in ["retry_after_secs", "retry_after_s"] {
        let mut detail = body["detail"].clone();
        let dropped = if kept == "retry_after_s" {
            "retry_after_secs"
        } else {
            "retry_after_s"
        };
        detail.as_object_mut().unwrap().remove(dropped);
        let wait = AccountWait::of_refusal(
            body["code"].as_str().unwrap(),
            Some(&detail),
            SendKind::TurnOne,
            NOW,
        )
        .unwrap();
        assert_eq!(wait.until_ms, NOW + MIN_WAIT_MS, "only {kept}");
    }
}

/// A run error is read through the pinned crate's typed `RunError`, whose
/// member is `retry_after_secs`; routing's `retry_after_s` is not a run-error
/// member. Case 5's body names both a 120 s hint and a reset in 2100, so
/// reading the hint under the wrong name would wait for the six-hour cap.
#[test]
fn account_wait_vectors_a_run_error_reads_retry_after_secs() {
    let raw = body("5_queued_account_limit_exhausted.new.run_status.json");
    let error = &raw["result"]["error"];
    assert_eq!(error["retry_after_secs"], 120.0);
    assert!(error.get("retry_after_s").is_none());
    let typed = queued("account_limit_exhausted");
    assert_eq!(typed.retry_after_secs, Some(120.0));
    let wait = AccountWait::of_run_error(&typed, SendKind::TurnOne, NOW).unwrap();
    assert_eq!(wait.until_ms, NOW + 120_000);
}

/// A run's error that a runner's account move left behind
/// (`testdata/account-move-1112-r2/`), decoded as a summary child's
/// `run.result` answer is: the reply body through the crate's `read_reply`
/// into the typed `RunResult`.
fn account_move(name: &str) -> RunError {
    let path = format!(
        "{}/testdata/account-move-1112-r2/{name}.run.result.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let answer: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect(&path)).expect(&path);
    let reply = serde_json::to_vec(&serde_json::json!({ "result": answer })).unwrap();
    let result: cortexkit_role_llm_runner::run::RunResult =
        cortexkit_role_llm_runner::wire::read_reply(&reply).expect(&path);
    assert_eq!(result.state, states::ERROR, "{name}");
    result.error.expect(&path)
}

/// Every account-move body is an account wait, timed by the contract members
/// alone: `retry_after_secs` before `resets_at_ms`. `account_continue` and
/// its `until_ms` are diagnostics ck-mc never reads, so the bodies that add
/// it wait exactly as the one without it.
#[test]
fn account_wait_vectors_account_move_errors_wait_by_the_contract_members() {
    const RESET: i64 = 1_900_000_000_000;
    let wait = |name: &str, now: i64| {
        AccountWait::of_run_error(&account_move(name), SendKind::TurnOne, now)
            .unwrap_or_else(|| panic!("{name} is no account wait"))
            .until_ms
    };
    // The routing hint wins over the walled account's own reset.
    assert_eq!(wait("after-hold-with-until", NOW), NOW + 3_600_000);
    assert_eq!(
        wait("after-hold-with-until", RESET - 60_000),
        RESET - 60_000 + 3_600_000
    );
    for name in ["before", "after-refusal", "after-hold-without-until"] {
        // The reset is years after NOW, so the wait is the six-hour cap.
        assert_eq!(wait(name, NOW), NOW + MAX_WAIT_MS, "{name}");
        // A minute before the reset the cap does not bind: the wait ends at
        // exactly `resets_at_ms`, the member that was read.
        assert_eq!(wait(name, RESET - 60_000), RESET, "{name}");
        assert_eq!(wait(name, NOW), wait("before", NOW), "{name}");
    }
}
