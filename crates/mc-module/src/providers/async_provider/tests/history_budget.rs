//! A runner session's history head is sized as the TypeScript plugin sizes it:
//! window × execute threshold × `history_budget_percentage`.

use super::*;

#[test]
fn history_budget_follows_window_threshold_and_share() {
    let mut config = McModuleConfig::default();
    // TypeScript defaults: a 65% threshold and a 15% share.
    assert_eq!(
        super::super::async_history_budget_tokens(&config, 1_000_000, "anthropic/claude-opus-5-5"),
        97_500.0
    );
    config.execute_threshold_percentage = 75.0;
    config.history_budget_percentage = 0.2;
    assert_eq!(
        super::super::async_history_budget_tokens(&config, 1_000_000, "anthropic/claude-opus-5-5"),
        150_000.0
    );
}

#[test]
fn history_budget_without_a_window_uses_the_renderer_default() {
    assert_eq!(
        super::super::async_history_budget_tokens(&McModuleConfig::default(), 0, "m"),
        crate::memory_render::DEFAULT_HISTORY_BUDGET_TOKENS
    );
}

#[test]
fn runner_requests_carry_caveman_and_the_per_model_reasoning_budget() {
    let mut request: TransformRequest = decode(
        &json!({"v":2,"kind":"compaction.step","session_id":"n","messages":[],"render_config":"{}","model_key":"anthropic/claude-opus-5-5"}),
    )
    .unwrap();
    let mut config = McModuleConfig::default();
    super::super::apply_runner_transform_settings(
        &mut request,
        &config,
        "anthropic/claude-opus-5-5",
    );
    assert!(!request.caveman_enabled);
    assert_eq!(request.keep_reasoning_tokens_effective, Some(10_000));

    config.caveman.enabled = true;
    config.caveman.min_size = 321;
    config.keep_reasoning_tokens =
        Some(json!({"anthropic/claude-opus-5-5": 2_500, "default": 7_000}));
    super::super::apply_runner_transform_settings(
        &mut request,
        &config,
        "anthropic/claude-opus-5-5",
    );
    assert!(request.caveman_enabled);
    assert_eq!(request.caveman_min_chars, 321);
    assert_eq!(request.keep_reasoning_tokens_effective, Some(2_500));
    super::super::apply_runner_transform_settings(&mut request, &config, "openai/gpt-6.1-sol");
    assert_eq!(request.keep_reasoning_tokens_effective, Some(7_000));
}
