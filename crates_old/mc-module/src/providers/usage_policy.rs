//! Usage and overflow policy for runner-lane compaction conversations.
//!
//! On the runner lane no Magic Context code runs inside the harness, so the
//! rules the TypeScript event handler applies to provider responses live here:
//!
//! - a context limit learned from a provider overflow error, and its removal
//!   once the provider accepts a larger request;
//! - clearing that limit and the emergency-recovery arm when the model changes;
//! - arming emergency recovery on an overflow and disarming it once a request
//!   fits well under the limit again;
//! - the last-response clock, which only a served (non-failed) response moves.
//!
//! Every rule is a pure function of the previous [`UsagePolicyState`] and one
//! [`UsageConditions`]. The conditions are the only per-step input: today the
//! caller builds them from the `compaction.step` request, and an asynchronous
//! advance notice carrying the same fields can build them later without any
//! change to the rules.
use super::*;
use crate::scheduler::{detect_overflow, ContextLimitProvenance};

/// The llm-runner run-error code for a request larger than the model's window.
/// A runner reports it as `previous_provider_code`, usually with no usage and
/// no limit, so it is an overflow even though no overflow text pattern matches.
pub(crate) const CONTEXT_OVERFLOW_CODE: &str = "context_overflow";

/// Emergency recovery disarms once the request about to be sent is below this
/// share of the limit, the same 80% margin the TypeScript transform uses.
const EMERGENCY_DISARM_PERCENT: u64 = 80;

/// Finish reasons that mean the provider did not serve the response. Kept in
/// step with `providerResponseFailed` in
/// `packages/plugin/src/shared/provider-response-completion.ts`; the shared
/// vectors in `testdata/runner-usage-policy-vectors.json` check both sides.
const FAILED_FINISH_REASONS: &[&str] = &[
    "error",
    "failed",
    "abort",
    "aborted",
    "interrupted",
    "cancelled",
    "canceled",
];

/// The provider's measurements for the previous request. Every member is
/// optional because a runner may omit measurements it does not have.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LastUsage {
    #[serde(default)]
    pub input: Option<u64>,
    #[serde(default)]
    pub cache_read: Option<u64>,
    #[serde(default)]
    pub cache_write: Option<u64>,
    #[serde(default)]
    pub output: Option<u64>,
    #[serde(default)]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

impl LastUsage {
    /// Read the wire's `previous_usage` object without filling missing members.
    #[cfg(test)]
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let number = |field: &str| object.get(field).and_then(Value::as_u64);
        Some(Self {
            input: number("input"),
            cache_read: number("cache_read"),
            cache_write: number("cache_write"),
            output: number("output"),
            completed_at: number("completed_at"),
            finish_reason: object
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// The prompt size the provider measured: fresh input plus cache reads and writes.
    pub fn prompt_tokens(&self) -> u64 {
        self.input
            .unwrap_or(0)
            .saturating_add(self.cache_read.unwrap_or(0))
            .saturating_add(self.cache_write.unwrap_or(0))
    }

    /// True when the reading carries any prompt tokens. A reading of all zeros
    /// is a response shell or a refused request, never a prompt size.
    pub fn has_prompt_tokens(&self) -> bool {
        self.prompt_tokens() > 0
    }
}

/// Everything the policy reads for one step.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UsageConditions {
    /// The runner's estimate of the request it is about to send.
    pub est_tokens: u64,
    /// The model's context window as the runner resolves it.
    pub window: u64,
    /// The model the step is for.
    pub model: String,
    /// The previous request's measurements, when the runner recorded any.
    #[serde(default)]
    pub last_usage: Option<LastUsage>,
    /// When the previous request ended in an error: its provider code, or the
    /// provider's error text when the runner has it.
    #[serde(default)]
    pub provider_error: Option<String>,
}

impl UsageConditions {
    /// Build the conditions from a `compaction.step` request's own fields.
    /// `window` is the already resolved window (the request's value, or the
    /// Setup's when the request omits it).
    #[cfg(test)]
    pub fn from_step_params(params: &Value, window: u64) -> Self {
        Self {
            est_tokens: params
                .pointer("/estimate/request_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            window,
            model: params
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            last_usage: params.get("previous_usage").and_then(LastUsage::from_value),
            provider_error: params
                .get("previous_provider_code")
                .and_then(Value::as_str)
                .filter(|code| !code.trim().is_empty())
                .map(str::to_string),
        }
    }

    fn finish_reason(&self) -> Option<&str> {
        self.last_usage
            .as_ref()
            .and_then(|usage| usage.finish_reason.as_deref())
    }

    fn completed_at(&self) -> u64 {
        self.last_usage
            .as_ref()
            .and_then(|usage| usage.completed_at)
            .unwrap_or(0)
    }
}

/// A limit a provider reported in an overflow error, for the model it reported it for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LearnedLimit {
    pub tokens: u64,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<ContextLimitProvenance>,
}

/// The durable policy state of one runner conversation, kept in its record.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UsagePolicyState {
    /// The model of the last step seen, so the next step can detect a switch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub learned_limit: Option<LearnedLimit>,
    #[serde(default)]
    pub emergency_recovery_armed: bool,
    /// Completion time of the newest response the provider served, in Unix ms.
    /// It never moves backwards.
    #[serde(default)]
    pub last_response_at_ms: u64,
    /// The newest non-zero prompt size the provider measured for this model.
    #[serde(default)]
    pub last_input_tokens: u64,
}

impl UsagePolicyState {
    /// The learned limit, when it belongs to `model`.
    pub fn limit_for(&self, model: &str) -> Option<u64> {
        self.learned_limit
            .as_ref()
            .filter(|limit| limit.model == model && limit.tokens > 0)
            .map(|limit| limit.tokens)
    }
}

/// What the step should use, derived from the conditions and the new state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UsageDecision {
    /// The window pressure is measured against: the runner's window, lowered
    /// to a limit learned for this model.
    pub effective_window: u64,
    /// False when the previous request's reading has no prompt tokens and must
    /// not replace the runner's estimate as the pressure reading.
    pub use_measured_usage: bool,
    pub model_switched: bool,
    pub overflow_detected: bool,
    /// Set when a successful request larger than the learned limit disproved it.
    pub learned_limit_cleared: bool,
    pub emergency_recovery_armed: bool,
    pub emergency_recovery_disarmed: bool,
}

/// True when a response's markers say the provider did not serve it. An error
/// takes precedence over any finish reason, completion time or usage.
pub(crate) fn response_failed(finish_reason: Option<&str>, has_error: bool) -> bool {
    if has_error {
        return true;
    }
    let finish = finish_reason.unwrap_or("").trim().to_lowercase();
    FAILED_FINISH_REASONS.contains(&finish.as_str())
}

/// True for a terminal response the provider served: not failed, and either
/// completed at a known time or ended with a finish reason.
pub(crate) fn successful_completion(
    completed_at: u64,
    finish_reason: Option<&str>,
    has_error: bool,
) -> bool {
    !response_failed(finish_reason, has_error)
        && (completed_at > 0 || finish_reason.is_some_and(|finish| !finish.trim().is_empty()))
}

/// The overflow reading of a provider error: whether it is an overflow, and
/// the limit it reports, when it reports a plausible one.
fn overflow_of(error: &str) -> Option<(Option<u64>, Option<ContextLimitProvenance>)> {
    let detection = detect_overflow(error);
    if detection.is_overflow {
        return Some((
            detection.reported_limit,
            detection.reported_limit_provenance,
        ));
    }
    (error.trim() == CONTEXT_OVERFLOW_CODE).then_some((None, None))
}

/// Advance the policy by one step.
///
/// `arm_recovery` is false for conversations that cannot run their own
/// recovery (subagent presets): an overflow there still teaches the limit but
/// never arms emergency recovery, as the TypeScript handler does for subagents.
pub(crate) fn advance(
    state: &UsagePolicyState,
    conditions: &UsageConditions,
    arm_recovery: bool,
) -> (UsagePolicyState, UsageDecision) {
    let model = conditions.model.as_str();
    let mut next = state.clone();

    // A limit and an emergency arm describe the model whose request
    // overflowed. On a switch both go, together with the old model's reading.
    let mut decision = UsageDecision {
        model_switched: state.model.as_deref().is_some_and(|prior| prior != model),
        ..UsageDecision::default()
    };
    if decision.model_switched {
        next.learned_limit = None;
        next.emergency_recovery_armed = false;
        next.last_input_tokens = 0;
    }
    next.model = Some(model.to_string());

    let has_error = conditions.provider_error.is_some();
    let failed = response_failed(conditions.finish_reason(), has_error);
    let usage = conditions.last_usage.as_ref();
    let has_tokens = usage.is_some_and(LastUsage::has_prompt_tokens);

    // The previous request's error belongs to the model that served it. On a
    // switch step that is the old model, so the error is not evidence about
    // the new one and is dropped with the old model's state.
    if let Some(error) = conditions
        .provider_error
        .as_deref()
        .filter(|_| !decision.model_switched)
    {
        if let Some((limit, provenance)) = overflow_of(error) {
            decision.overflow_detected = true;
            if let Some(tokens) = limit.filter(|tokens| *tokens > 0) {
                next.learned_limit = Some(LearnedLimit {
                    tokens,
                    model: model.to_string(),
                    provenance,
                });
            }
            if arm_recovery {
                next.emergency_recovery_armed = true;
            }
        }
    }

    // A provider that accepts a request larger than the learned limit has
    // disproved that limit, whatever the window says.
    if has_tokens && !failed {
        let tokens = usage.map_or(0, LastUsage::prompt_tokens);
        if next.limit_for(model).is_some_and(|limit| tokens > limit) {
            next.learned_limit = None;
            decision.learned_limit_cleared = true;
        }
    }

    // Only a served response moves the clock, and never backwards. A failed
    // or refused request proves nothing about the provider's cache. A served
    // response with no known completion time has no time to record.
    let completed_at = conditions.completed_at();
    if completed_at > 0
        && successful_completion(completed_at, conditions.finish_reason(), has_error)
    {
        next.last_response_at_ms = next.last_response_at_ms.max(completed_at);
    }

    // Record the measured prompt size. An all-zero reading is a shell or a
    // refused request and must not overwrite a real reading.
    if has_tokens {
        next.last_input_tokens = usage.map_or(0, LastUsage::prompt_tokens);
    }
    decision.use_measured_usage = usage.is_none() || has_tokens;

    let limit = next.limit_for(model);
    decision.effective_window = match limit {
        Some(limit) if conditions.window > 0 => conditions.window.min(limit),
        Some(limit) => limit,
        None => conditions.window,
    };

    // Disarm once the request about to be sent fits well under the limit. A
    // step that reports the overflow itself never disarms: its estimate is the
    // size of the request that just failed.
    if next.emergency_recovery_armed && !decision.overflow_detected {
        let reference = limit.unwrap_or(decision.effective_window);
        if conditions.est_tokens > 0
            && reference > 0
            && conditions.est_tokens.saturating_mul(100)
                < reference.saturating_mul(EMERGENCY_DISARM_PERCENT)
        {
            next.emergency_recovery_armed = false;
            decision.emergency_recovery_disarmed = true;
        }
    }
    decision.emergency_recovery_armed = next.emergency_recovery_armed;
    (next, decision)
}

#[cfg(test)]
#[path = "usage_policy_tests.rs"]
mod tests;
