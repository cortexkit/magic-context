//! The TypeScript event handler's usage and overflow cases
//! (`packages/plugin/src/hooks/magic-context/event-handler.test.ts`, and the
//! model-switch clears in `host-runner/bridge-host-facts.ts`), fed through
//! [`UsageConditions`] instead of OpenCode `message.updated` events.
use super::*;

const MODEL: &str = "test-provider/test-model";
const OVERFLOW_ERROR: &str =
    "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.";

fn usage(input: u64, cache_read: u64, completed_at: u64, finish: &str) -> LastUsage {
    LastUsage {
        input: Some(input),
        cache_read: Some(cache_read),
        cache_write: Some(0),
        output: Some(10),
        completed_at: Some(completed_at),
        finish_reason: Some(finish.into()),
    }
}

fn conditions(model: &str, last_usage: Option<LastUsage>, error: Option<&str>) -> UsageConditions {
    UsageConditions {
        est_tokens: 1_000,
        window: 200_000,
        model: model.into(),
        last_usage,
        provider_error: error.map(str::to_string),
    }
}

fn step(
    state: &UsagePolicyState,
    conditions: &UsageConditions,
) -> (UsagePolicyState, UsageDecision) {
    advance(state, conditions, true)
}

fn overflowed(model: &str) -> UsagePolicyState {
    step(
        &UsagePolicyState::default(),
        &conditions(model, None, Some(OVERFLOW_ERROR)),
    )
    .0
}

/// "tracks assistant token usage and updates lastResponseTime"
#[test]
fn tracks_usage_and_updates_the_last_response_clock() {
    let (state, decision) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, Some(usage(120_000, 15_000, 5_000, "stop")), None),
    );
    assert_eq!(state.last_input_tokens, 135_000);
    assert_eq!(state.last_response_at_ms, 5_000);
    assert!(decision.use_measured_usage);
    assert_eq!(decision.effective_window, 200_000);
}

/// "records cache-only provider usage as a real pressure sample"
#[test]
fn cache_only_usage_is_a_real_reading() {
    let mut reading = usage(0, 321, 7, "stop");
    reading.cache_write = Some(79);
    let (state, decision) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, Some(reading), None),
    );
    assert_eq!(state.last_input_tokens, 400);
    assert!(decision.use_measured_usage);
}

/// "ignores all-zero token events that would overwrite valid usage"
#[test]
fn all_zero_usage_never_overwrites_a_real_reading() {
    let prior = UsagePolicyState {
        model: Some(MODEL.into()),
        last_input_tokens: 124_000,
        ..Default::default()
    };
    let (state, decision) = step(&prior, &conditions(MODEL, Some(usage(0, 0, 0, "")), None));
    assert_eq!(state.last_input_tokens, 124_000);
    assert!(!decision.use_measured_usage);
}

/// "keeps last_response_time for tokenless assistant updates, including errors"
#[test]
fn shells_and_refused_requests_do_not_move_the_clock() {
    let prior = UsagePolicyState {
        model: Some(MODEL.into()),
        last_response_at_ms: 5_000,
        last_input_tokens: 40_000,
        ..Default::default()
    };
    let shell = LastUsage {
        input: Some(0),
        cache_read: Some(0),
        ..Default::default()
    };
    let (after_shell, _) = step(&prior, &conditions(MODEL, Some(shell), None));
    assert_eq!(after_shell.last_response_at_ms, 5_000);
    let refused = usage(0, 0, 9_000, "error");
    let (after_refusal, _) = step(
        &after_shell,
        &conditions(MODEL, Some(refused), Some("insufficient_quota")),
    );
    assert_eq!(after_refusal.last_response_at_ms, 5_000);
    assert_eq!(after_refusal.last_input_tokens, 40_000);
}

/// Ported from the TypeScript case "expires once after switching to
/// usage-less completed replies, but not on shells or failures": the
/// last-response clock moves for a served reply even without usage, but not
/// for a shell (a response that never completed) or a failed request.
#[test]
fn usage_less_completions_move_the_clock_but_shells_failures_and_late_readings_do_not() {
    let previous = 1_000;
    let now = previous + 2 * 3_600_000;
    let (mut state, _) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, Some(usage(1_000, 0, previous, "stop")), None),
    );
    for (reading, error) in [
        // A shell: created, never completed.
        (
            LastUsage {
                input: Some(0),
                ..Default::default()
            },
            None,
        ),
        (
            LastUsage {
                completed_at: Some(now),
                finish_reason: Some("error".into()),
                ..Default::default()
            },
            Some("APIError"),
        ),
        (
            LastUsage {
                completed_at: Some(now),
                finish_reason: Some("stop".into()),
                ..Default::default()
            },
            Some("MessageAbortedError"),
        ),
    ] {
        state = step(&state, &conditions(MODEL, Some(reading), error)).0;
    }
    assert_eq!(state.last_response_at_ms, previous);
    let served = LastUsage {
        completed_at: Some(now),
        finish_reason: Some("stop".into()),
        ..Default::default()
    };
    state = step(&state, &conditions(MODEL, Some(served), None)).0;
    assert_eq!(state.last_response_at_ms, now);
    assert_eq!(state.last_input_tokens, 1_000);
    state = step(
        &state,
        &conditions(MODEL, Some(usage(0, 0, now + 2_000, "stop")), None),
    )
    .0;
    assert_eq!(state.last_response_at_ms, now + 2_000);
    // A delayed reading of the first response must not move the clock back.
    state = step(
        &state,
        &conditions(MODEL, Some(usage(1_000, 0, previous, "stop")), None),
    )
    .0;
    assert_eq!(state.last_response_at_ms, now + 2_000);
}

/// "compaction ON: a provider overflow arms emergency recovery"
#[test]
fn provider_overflow_learns_the_limit_and_arms_recovery() {
    let (state, decision) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, None, Some(OVERFLOW_ERROR)),
    );
    assert!(decision.overflow_detected);
    assert!(state.emergency_recovery_armed);
    assert_eq!(state.limit_for(MODEL), Some(120_000));
    assert_eq!(decision.effective_window, 120_000);
}

/// "uses model identity carried by session.error instead of a prior session model"
#[test]
fn the_learned_limit_belongs_to_the_step_model() {
    let state = overflowed("current-provider/current-model");
    assert_eq!(
        state
            .learned_limit
            .as_ref()
            .map(|limit| limit.model.as_str()),
        Some("current-provider/current-model")
    );
    assert_eq!(state.limit_for("prior/model"), None);
}

/// "compaction OFF: overflow never arms recovery, but the provider limit is
/// still recorded" and the subagent overflow path.
#[test]
fn conversations_without_recovery_learn_the_limit_but_never_arm() {
    let (state, decision) = advance(
        &UsagePolicyState::default(),
        &conditions(MODEL, None, Some(OVERFLOW_ERROR)),
        false,
    );
    assert!(decision.overflow_detected);
    assert!(!state.emergency_recovery_armed);
    assert_eq!(state.limit_for(MODEL), Some(120_000));
}

/// "does not append reports for non-overflow errors": other errors change nothing.
#[test]
fn a_non_overflow_error_neither_learns_nor_arms() {
    let (state, decision) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, None, Some("connection timed out")),
    );
    assert!(!decision.overflow_detected);
    assert!(!state.emergency_recovery_armed);
    assert_eq!(state.learned_limit, None);
}

/// The llm-runner run-error code arrives without text or a limit.
#[test]
fn the_runner_overflow_code_arms_without_a_limit() {
    let (state, decision) = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, None, Some(CONTEXT_OVERFLOW_CODE)),
    );
    assert!(decision.overflow_detected);
    assert!(state.emergency_recovery_armed);
    assert_eq!(state.learned_limit, None);
    assert_eq!(decision.effective_window, 200_000);
}

/// "counts provider usage beyond a catalog window as pressure" and "clears a
/// stale unkeyed detected limit on the first successful event": an accepted
/// request larger than the learned limit disproves it.
#[test]
fn a_larger_accepted_request_clears_the_learned_limit() {
    let state = overflowed(MODEL);
    let (state, decision) = step(
        &state,
        &conditions(MODEL, Some(usage(148_241, 0, 9, "stop")), None),
    );
    assert!(decision.learned_limit_cleared);
    assert_eq!(state.learned_limit, None);
    assert_eq!(decision.effective_window, 200_000);
    // A later overflow learns the limit again for the same model.
    let (state, _) = step(&state, &conditions(MODEL, None, Some(OVERFLOW_ERROR)));
    assert_eq!(state.limit_for(MODEL), Some(120_000));
}

/// "keeps accepted ... inputs unscaled and excludes failed usage": a failed
/// request proves nothing about the limit.
#[test]
fn a_failed_request_above_the_limit_keeps_it() {
    let state = overflowed(MODEL);
    let (state, decision) = step(
        &state,
        &conditions(MODEL, Some(usage(150_000, 0, 9, "error")), None),
    );
    assert!(!decision.learned_limit_cleared);
    assert_eq!(state.limit_for(MODEL), Some(120_000));
}

/// "keeps one model's learned limit across its consecutive readings"
#[test]
fn readings_below_the_limit_keep_it() {
    let mut state = overflowed(MODEL);
    for input in [100_000, 80_000, 119_000] {
        let (next, decision) = step(
            &state,
            &conditions(MODEL, Some(usage(input, 0, 9, "stop")), None),
        );
        assert_eq!(next.limit_for(MODEL), Some(120_000));
        assert_eq!(decision.effective_window, 120_000);
        state = next;
    }
}

/// `bridge-host-facts.ts` clears usage, the learned limit and the emergency
/// arm when the model changes; "does not let another model's accepted
/// request raise this model's limit".
#[test]
fn model_switch_clears_learned_limit_and_emergency_recovery() {
    let state = overflowed("test-provider/model-a");
    assert!(state.emergency_recovery_armed);
    let (state, decision) = step(
        &state,
        &conditions(
            "test-provider/model-b",
            Some(usage(100_000, 0, 9, "stop")),
            None,
        ),
    );
    assert!(decision.model_switched);
    assert_eq!(state.learned_limit, None);
    assert!(!state.emergency_recovery_armed);
    assert_eq!(decision.effective_window, 200_000);
    assert_eq!(state.model.as_deref(), Some("test-provider/model-b"));
}

/// On a switch step the error came from the previous model's request, so it
/// teaches the new model nothing.
#[test]
fn an_overflow_reported_on_a_switch_step_is_dropped_with_the_old_model() {
    let state = UsagePolicyState {
        model: Some("test-provider/model-a".into()),
        ..Default::default()
    };
    let (state, decision) = step(
        &state,
        &conditions("test-provider/model-b", None, Some(OVERFLOW_ERROR)),
    );
    assert!(decision.model_switched);
    assert!(!decision.overflow_detected);
    assert_eq!(state.learned_limit, None);
    assert!(!state.emergency_recovery_armed);
}

/// The TypeScript transform disarms once the request about to be sent is
/// under 80% of the provider-reported limit, and never on the step that armed.
#[test]
fn emergency_recovery_disarms_under_eighty_percent_of_the_limit() {
    let mut armed_step = conditions(MODEL, None, Some(OVERFLOW_ERROR));
    armed_step.est_tokens = 50_000;
    let (state, decision) = step(&UsagePolicyState::default(), &armed_step);
    assert!(decision.emergency_recovery_armed);
    assert!(!decision.emergency_recovery_disarmed);

    let mut still_large = conditions(MODEL, None, None);
    still_large.est_tokens = 100_000;
    let (state, decision) = step(&state, &still_large);
    assert!(decision.emergency_recovery_armed);

    let mut fits = conditions(MODEL, None, None);
    fits.est_tokens = 90_000;
    let (state, decision) = step(&state, &fits);
    assert!(decision.emergency_recovery_disarmed);
    assert!(!state.emergency_recovery_armed);
    // The learned limit outlives the arm.
    assert_eq!(state.limit_for(MODEL), Some(120_000));
}

/// Without a reported limit the window is the reference.
#[test]
fn an_arm_without_a_limit_disarms_against_the_window() {
    let state = step(
        &UsagePolicyState::default(),
        &conditions(MODEL, None, Some(CONTEXT_OVERFLOW_CODE)),
    )
    .0;
    let mut large = conditions(MODEL, None, None);
    large.est_tokens = 170_000;
    let state = step(&state, &large).0;
    assert!(state.emergency_recovery_armed);
    let mut fits = conditions(MODEL, None, None);
    fits.est_tokens = 150_000;
    assert!(!step(&state, &fits).0.emergency_recovery_armed);
}

#[test]
fn conditions_read_the_step_request_without_filling_missing_measurements() {
    let params = json!({
        "model": MODEL,
        "estimate": {"request_tokens": 4_321},
        "previous_usage": {"input": 1, "cache_read": 70_000},
        "previous_provider_code": "context_overflow",
    });
    let conditions = UsageConditions::from_step_params(&params, 99);
    assert_eq!(
        conditions,
        UsageConditions {
            est_tokens: 4_321,
            window: 99,
            model: MODEL.into(),
            last_usage: Some(LastUsage {
                input: Some(1),
                cache_read: Some(70_000),
                ..Default::default()
            }),
            provider_error: Some(CONTEXT_OVERFLOW_CODE.into()),
        }
    );
}

/// The response classification shared with
/// `packages/plugin/src/shared/provider-response-completion.ts`; the Bun test
/// `packages/plugin/src/shared/runner-policy-fixtures.test.ts` checks the same file.
#[test]
fn response_classification_matches_the_shared_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../testdata/runner-usage-policy-vectors.json"
    ))
    .unwrap();
    let cases = vectors["response_completion"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let finish = case["finish"].as_str();
        let error = case["error"].as_bool().unwrap();
        let completed_at = case["completed_at"].as_u64().unwrap_or(0);
        assert_eq!(
            response_failed(finish, error),
            case["failed"].as_bool().unwrap(),
            "{case}"
        );
        assert_eq!(
            successful_completion(completed_at, finish, error),
            case["successful"].as_bool().unwrap(),
            "{case}"
        );
    }
}
