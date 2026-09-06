//! Scheduler/decide: the pass-class producer (execute/defer/force/block), the
//! idle-TTL fire, the mid-turn deferred-execute transition, the emergency-drain
//! latch, and provider context-overflow detection. Pure state-transition
//! functions; durable state enters as parameters and exits in return values.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::selection::PassClass;

/// Default execute threshold percentage used when config has no usable value.
pub const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 65.0;
/// Maximum execute threshold percentage; higher values leave too little headroom.
pub const MAX_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 90.0;
/// Lowest context-usage percentage that may force materialization.
pub const MIN_FORCE_MATERIALIZE_PERCENTAGE: f64 = 85.0;
/// Context-usage percentage that enters the block-and-drain emergency band.
pub const EMERGENCY_PERCENTAGE: f64 = 95.0;
/// Default cache idle TTL used when the configured TTL string is invalid.
pub const DEFAULT_CACHE_TTL_MS: u64 = 5 * 60 * 1000;
/// Percentage points below the execute threshold required to clear the latch.
pub const EMERGENCY_DRAIN_EXIT_MARGIN: f64 = 10.0;
/// Exit percentage used when the execute threshold is missing or unusable.
pub const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE: f64 = 55.0;
/// Duration after a drain failure during which latch bypass is suppressed.
pub const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS: u64 = 60_000;
/// Maximum duration the emergency drain latch can remain active without re-entry.
pub const EMERGENCY_DRAIN_MAX_LATCH_MS: u64 = 30 * 60 * 1000;
/// Smallest provider-reported context limit accepted as plausible.
pub const MIN_PLAUSIBLE_CONTEXT_LIMIT: u64 = 1024;
/// Largest provider-reported context limit accepted as plausible.
pub const MAX_PLAUSIBLE_CONTEXT_LIMIT: u64 = 10_000_000;

const OVERFLOW_PATTERN_SOURCES: &[&str] = &[
    r"prompt is too long",
    r"input is too long for requested model",
    r"exceeds the context window",
    r"input token count.*exceeds the maximum",
    r"maximum prompt length is \d+",
    r"reduce the length of the messages",
    r"maximum context length is \d+ tokens",
    r"maximum model length is \d+",
    r"exceeds the limit of \d+",
    r"exceeds the available context size",
    r"greater than the context length",
    r"context window exceeds limit",
    r"exceeded model token limit",
    r"context[_ ]length[_ ]exceeded",
    r"request entity too large",
    r"context length is only \d+ tokens",
    r"input length.*exceeds.*context length",
    r"prompt too long; exceeded (?:max )?context length",
    r"too large for model with \d+ maximum context length",
    r"model_context_window_exceeded",
    r"context size has been exceeded",
];

const LIMIT_EXTRACTION_PATTERN_SOURCES: &[(&str, ContextLimitProvenance)] = &[
    (
        r"maximum prompt length is (\d+)",
        ContextLimitProvenance::PromptOnly,
    ),
    (
        r"maximum context length is (\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"maximum model length is (\d+)",
        ContextLimitProvenance::Combined,
    ),
    (
        r"context length is only (\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"exceeds the limit of (\d+)",
        ContextLimitProvenance::Unknown,
    ),
    (
        r"too large for model with (\d+) maximum context length",
        ContextLimitProvenance::Combined,
    ),
    (
        r"context size.*(\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"exceeds? the context length of (\d+)",
        ContextLimitProvenance::Combined,
    ),
    (
        r">\s*(\d+)\s*(?:tokens?\s*)?(?:maximum|max|limit)\b",
        ContextLimitProvenance::PromptOnly,
    ),
    (
        r"max(?:imum)?.*context.*?(\d+)",
        ContextLimitProvenance::Unknown,
    ),
];

/// A parse error for cache idle TTL strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheTtlParseError;

/// Percentage threshold config: one value for every model, or per-model values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecuteThresholdConfig {
    /// A single percentage used for all models.
    Percentage(f64),
    /// A map keyed by model id plus an optional `default` entry.
    ByModel(BTreeMap<String, f64>),
}

/// Tokens threshold config keyed by model id plus an optional `default` entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExecuteThresholdTokensConfig {
    /// Token thresholds. The `default` key is used when no model-specific key matches.
    pub values: BTreeMap<String, f64>,
}

/// Scheduler config used by the decision logic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerConfig {
    /// Percentage threshold config, capped by [`MAX_EXECUTE_THRESHOLD_PERCENTAGE`].
    pub execute_threshold_percentage: ExecuteThresholdConfig,
    /// Optional absolute-token threshold config; wins when a context limit is known.
    pub execute_threshold_tokens: Option<ExecuteThresholdTokensConfig>,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            execute_threshold_percentage: ExecuteThresholdConfig::Percentage(
                DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            ),
            execute_threshold_tokens: None,
        }
    }
}

/// Provider-reported context pressure for the current pass.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextUsage {
    /// Provider-reported context fill percentage against the soft scheduling window.
    pub percentage: f64,
    /// Provider-reported input tokens for this pass.
    pub input_tokens: f64,
    /// Context fill percentage against the provider's absolute hard wall. Older callers omit
    /// this value and retain the historical single-denominator behavior.
    #[serde(default)]
    pub hard_wall_percentage: Option<f64>,
}

/// Durable timing metadata needed for scheduler and idle-TTL predicates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    /// Unix milliseconds for the last completed provider response; `0` means none yet.
    pub last_response_time_ms: u64,
    /// Cache idle TTL string such as `5m`, `30s`, `2h`, or a bare millisecond count.
    pub cache_ttl: String,
}

/// Base scheduler decision before pressure bands and boundary deferral.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseDecision {
    /// Do not execute cache-busting work on this pass.
    Defer,
    /// Execute cache-busting work on this pass.
    Execute,
}

/// Escalation thresholds derived from the effective execute threshold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EscalationBands {
    /// Dynamic force-materialization and emergency-drop threshold.
    pub force_materialize_percentage: f64,
    /// Absolute provider-wall threshold; intentionally never derived from config.
    pub emergency_percentage: f64,
}

/// Derive every sub-95 escalation site from the effective execute threshold.
pub fn escalation_bands(effective_threshold_percentage: f64) -> EscalationBands {
    let threshold = if effective_threshold_percentage.is_finite() {
        effective_threshold_percentage.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
    } else {
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE
    };
    EscalationBands {
        force_materialize_percentage: MIN_FORCE_MATERIALIZE_PERCENTAGE.max(threshold + 2.0),
        emergency_percentage: EMERGENCY_PERCENTAGE,
    }
}

/// Pressure band derived from provider-reported context usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    /// Below the force-materialization threshold.
    Normal,
    /// At or above the derived force band, materialize and bypass mid-turn deferral.
    Force85,
    /// At or above 95%, block and drain in the emergency band.
    Emergency95,
}

/// Final pass decision returned by the scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PassDecision {
    /// Do not run a new cache-busting pass.
    Defer,
    /// Run a normal cache-busting pass.
    Execute,
    /// Force materialization at or above the derived escalation band.
    Force85,
    /// Emergency block-and-drain pass at or above 95% usage.
    Emergency95,
}

impl PassDecision {
    fn is_force_or_emergency(self) -> bool {
        matches!(self, PassDecision::Force85 | PassDecision::Emergency95)
    }

    /// Stable pass-band label persisted with accepted pass telemetry.
    pub const fn as_str(self) -> &'static str {
        match self {
            PassDecision::Defer => "Defer",
            PassDecision::Execute => "Execute",
            PassDecision::Force85 => "Force85",
            PassDecision::Emergency95 => "Emergency95",
        }
    }

    /// Canonical execute/defer class shared with TypeScript transform telemetry.
    pub const fn canonical_decision(self) -> &'static str {
        match self {
            PassDecision::Defer => "defer",
            PassDecision::Execute | PassDecision::Force85 | PassDecision::Emergency95 => "execute",
        }
    }
}

/// Why a final defer decision did not execute scheduled work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerDeferReason {
    SchedulerDefer,
    MidTurnBoundary,
}

impl SchedulerDeferReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SchedulerDefer => "scheduler_defer",
            Self::MidTurnBoundary => "mid_turn_boundary",
        }
    }
}

/// Live-tail state computed by the caller from typed content blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TailState {
    /// True when the newest assistant span has a tool call without its paired result.
    pub mid_tool_use: bool,
}

/// Reasons that bypass mid-turn deferral for an execute decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BoundaryBypass {
    /// True when the user explicitly requested a cache bust.
    pub explicit_bust: bool,
    /// True for subagent sessions, whose cache work must not wait on the parent session's tail state.
    pub subagent: bool,
}

impl BoundaryBypass {
    fn is_active(self) -> bool {
        self.explicit_bust || self.subagent
    }
}

/// Durable intent that an execute pass was deferred until the current tool call is resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredExecute {
    /// Stable reason for the deferred intent.
    pub reason: String,
}

impl DeferredExecute {
    /// Create the canonical pending execute intent recorded by mid-turn deferral.
    pub fn pending_execute() -> Self {
        Self {
            reason: "execute-none".to_string(),
        }
    }
}

/// Emergency drain latch state persisted by the caller between passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LatchState {
    /// Unix milliseconds when the latch armed; `None` means inactive.
    pub active_since_ms: Option<u64>,
}

impl LatchState {
    /// Return true when the emergency drain latch is currently active.
    pub fn is_active(self) -> bool {
        self.active_since_ms.is_some()
    }
}

/// Provenance of a numeric limit extracted from a provider overflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextLimitProvenance {
    /// The provider already reported its accepted input/prompt ceiling.
    PromptOnly,
    /// The provider reported a combined input-plus-output context window.
    Combined,
    /// The message does not identify which accounting convention it uses.
    Unknown,
}

/// A plausible provider-reported limit with its accounting provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportedContextLimit {
    /// Numeric token ceiling.
    pub value: u64,
    /// Accounting convention attached to the extraction pattern.
    pub provenance: ContextLimitProvenance,
}

/// Provider context-overflow detection result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverflowDetection {
    /// True when the error text matches a known context-overflow shape.
    pub is_overflow: bool,
    /// Reported provider context limit in tokens, when one is extractable and plausible.
    pub reported_limit: Option<u64>,
    /// Accounting convention for `reported_limit`, when a limit was extracted.
    pub reported_limit_provenance: Option<ContextLimitProvenance>,
    /// Source text of the first overflow regex that matched, for diagnostics.
    pub matched_pattern: Option<String>,
}

/// Inputs for the composed scheduler decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerInputs {
    /// Scheduler threshold config.
    pub config: SchedulerConfig,
    /// Provider-reported context pressure.
    pub usage: ContextUsage,
    /// Durable session timing metadata.
    pub session: SessionMeta,
    /// Current time in Unix milliseconds, supplied by the caller for determinism.
    pub now_ms: u64,
    /// Optional provider/model key for per-model threshold lookup.
    pub model_key: Option<String>,
    /// Optional explicit model context limit in tokens.
    pub context_limit: Option<f64>,
    /// Live-tail state used by mid-turn deferral.
    pub tail_state: TailState,
    /// Existing deferred execute intent, if a prior execute pass was postponed.
    pub deferred_execute: Option<DeferredExecute>,
    /// Non-pressure bypasses for mid-turn deferral.
    pub boundary_bypass: BoundaryBypass,
    /// Current emergency drain latch state.
    pub drain_latch: LatchState,
    /// Optional provider error text to scan for context overflow.
    pub overflow_error_text: Option<String>,
    /// Durable provider-overflow recovery arm from the host. It upgrades a would-be
    /// defer to the emergency path even when local usage is below the reported limit.
    pub emergency_recovery_armed: bool,
}

/// Composed scheduler output returned to the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchedulerOutcome {
    /// Execute/defer/force/emergency pass class.
    pub pass: PassDecision,
    /// True only when this pass executes because the configured usage threshold was crossed.
    pub pressure_execute: bool,
    /// True when the hard idle-TTL predicate fired and should be materialized.
    pub idle_ttl_fired: bool,
    /// Updated emergency drain latch state for the caller to persist.
    pub drain_latch: LatchState,
    /// Updated deferred execute intent for the caller to persist.
    pub deferred_execute: Option<DeferredExecute>,
    /// Canonical reason for a final defer, matching TypeScript boundary diagnostics.
    pub defer_reason: Option<SchedulerDeferReason>,
    /// Detected provider context limit in tokens, when overflow text reports one.
    pub detected_limit: Option<u64>,
    /// Accounting convention attached to `detected_limit`.
    pub detected_limit_provenance: Option<ContextLimitProvenance>,
}

struct CompiledPattern {
    source: &'static str,
    regex: Regex,
}

struct CompiledLimitPattern {
    regex: Regex,
    provenance: ContextLimitProvenance,
}

/// Parse a cache idle TTL string into milliseconds.
pub fn parse_cache_ttl(ttl: &str) -> Result<u64, CacheTtlParseError> {
    let normalized = ttl.trim();
    if normalized.eq_ignore_ascii_case("never") {
        return Ok(u64::MAX);
    }
    let (number, multiplier) =
        if !normalized.is_empty() && normalized.chars().all(|c| c.is_ascii_digit()) {
            (normalized, 1.0)
        } else {
            let Some(unit) = normalized.chars().last() else {
                return Err(CacheTtlParseError);
            };
            let number = &normalized[..normalized.len().saturating_sub(unit.len_utf8())];
            let multiplier = match unit {
                's' => 1_000.0,
                'm' => 60.0 * 1_000.0,
                'h' => 60.0 * 60.0 * 1_000.0,
                _ => return Err(CacheTtlParseError),
            };
            (number, multiplier)
        };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(CacheTtlParseError);
    }
    // JavaScript's Number() accepts the syntactically valid digit sequence and yields
    // Infinity on overflow. Saturating to u64::MAX preserves that value's practical
    // scheduler behavior (no finite elapsed time can exceed it) instead of rejecting it.
    let milliseconds = number.parse::<f64>().map_err(|_| CacheTtlParseError)? * multiplier;
    Ok(
        if !milliseconds.is_finite() || milliseconds >= u64::MAX as f64 {
            u64::MAX
        } else {
            milliseconds as u64
        },
    )
}

/// Return the scheduler's strict idle predicate (`elapsed > ttl`).
pub fn ttl_execute_fired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}

/// Return the hard cache-expiry idle predicate (`last_response_time > 0 && elapsed > ttl`).
/// The scheduler and TypeScript both defer at the exact TTL boundary.
pub fn ttl_hard_expired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    last_response_time_ms > 0 && now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}

/// Resolve the effective execute threshold percentage for a model and context limit.
pub fn resolve_execute_threshold(
    config: &ExecuteThresholdConfig,
    model_key: Option<&str>,
    fallback: f64,
    tokens_config: Option<&ExecuteThresholdTokensConfig>,
    context_limit: Option<f64>,
) -> f64 {
    if let (Some(tokens), Some(limit)) = (tokens_config, context_limit) {
        if is_finite_positive(limit) {
            if let Some((token_value, _matched_key)) = resolve_tokens_match(tokens, model_key) {
                if is_finite_positive(token_value) {
                    let cap = limit * (MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100.0);
                    let effective_tokens = token_value.min(cap);
                    let percentage = (effective_tokens / limit) * 100.0;
                    return percentage.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE);
                }
            }
        }
    }

    let mut resolved = match config {
        ExecuteThresholdConfig::Percentage(value) => *value,
        ExecuteThresholdConfig::ByModel(values) => {
            resolve_percentage_match(values, model_key).unwrap_or(fallback)
        }
    };

    if !resolved.is_finite() || resolved < 0.0 {
        resolved = fallback;
    }
    resolved.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
}

/// Compute the base scheduler execute/defer decision before pressure bands.
pub fn should_execute(
    config: &SchedulerConfig,
    session: &SessionMeta,
    usage: &ContextUsage,
    now_ms: u64,
    model_key: Option<&str>,
    context_limit: Option<f64>,
) -> BaseDecision {
    if usage.percentage == 0.0 && session.last_response_time_ms == 0 {
        return BaseDecision::Defer;
    }

    let effective_context_limit = context_limit.or_else(|| {
        if usage.percentage > 0.0 && usage.input_tokens > 0.0 {
            Some(usage.input_tokens / (usage.percentage / 100.0))
        } else {
            None
        }
    });
    let threshold = resolve_execute_threshold(
        &config.execute_threshold_percentage,
        model_key,
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        config.execute_threshold_tokens.as_ref(),
        effective_context_limit,
    );
    if usage.percentage >= threshold {
        return BaseDecision::Execute;
    }

    let ttl_ms = scheduler_ttl_ms(&session.cache_ttl);
    if ttl_execute_fired(now_ms, session.last_response_time_ms, ttl_ms) {
        BaseDecision::Execute
    } else {
        BaseDecision::Defer
    }
}

/// Derive the pressure band when soft scheduling and the absolute wall share a denominator.
pub fn derive_band(usage_percentage: f64, effective_threshold_percentage: f64) -> Band {
    derive_band_with_hard_wall(
        usage_percentage,
        usage_percentage,
        effective_threshold_percentage,
    )
}

/// Derive the pressure band while keeping execute/force geometry independent from the provider
/// wall. Only the absolute 95% arm reads `hard_wall_percentage`; the force arm remains soft-based.
pub fn derive_band_with_hard_wall(
    usage_percentage: f64,
    hard_wall_percentage: f64,
    effective_threshold_percentage: f64,
) -> Band {
    let bands = escalation_bands(effective_threshold_percentage);
    if hard_wall_percentage >= bands.emergency_percentage {
        Band::Emergency95
    } else if usage_percentage >= bands.force_materialize_percentage {
        Band::Force85
    } else {
        Band::Normal
    }
}

/// Apply the mid-turn boundary deferral transition to a pass decision.
pub fn apply_boundary_deferral(
    decision: PassDecision,
    tail_state: TailState,
    pending: Option<DeferredExecute>,
    bypass: BoundaryBypass,
) -> (PassDecision, Option<DeferredExecute>) {
    if decision == PassDecision::Defer {
        return (PassDecision::Defer, pending);
    }
    if decision.is_force_or_emergency() || bypass.is_active() {
        return (decision, pending);
    }
    if tail_state.mid_tool_use {
        return (
            PassDecision::Defer,
            Some(pending.unwrap_or_else(DeferredExecute::pending_execute)),
        );
    }
    (decision, pending)
}

/// Clear a deferred execute intent after the scheduled work succeeds.
pub fn drain_deferred_after_work(
    pending: Option<DeferredExecute>,
    work_succeeded: bool,
) -> Option<DeferredExecute> {
    if work_succeeded {
        None
    } else {
        pending
    }
}

/// Resolve the usage percentage below which the emergency drain latch clears.
pub fn emergency_drain_exit_threshold(execute_threshold_percentage: f64) -> f64 {
    if !execute_threshold_percentage.is_finite() || execute_threshold_percentage <= 0.0 {
        return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE;
    }
    (execute_threshold_percentage - EMERGENCY_DRAIN_EXIT_MARGIN).max(0.0)
}

/// Advance the emergency drain latch using only current usage and wall-clock input.
pub fn advance_drain_latch(
    state: LatchState,
    usage_percentage: f64,
    execute_threshold_percentage: f64,
    now_ms: u64,
) -> LatchState {
    if usage_percentage
        >= escalation_bands(execute_threshold_percentage).force_materialize_percentage
    {
        return LatchState {
            active_since_ms: state.active_since_ms.or(Some(now_ms)),
        };
    }

    let Some(active_since_ms) = state.active_since_ms else {
        return state;
    };
    let expired = now_ms.saturating_sub(active_since_ms) > EMERGENCY_DRAIN_MAX_LATCH_MS;
    let below_exit =
        usage_percentage < emergency_drain_exit_threshold(execute_threshold_percentage);
    if below_exit || expired {
        LatchState {
            active_since_ms: None,
        }
    } else {
        state
    }
}

/// Return true when an active drain latch may bypass normal scheduling constraints.
pub fn drain_bypass_allowed(latch: LatchState, failure_at_ms: u64, now_ms: u64) -> bool {
    if !latch.is_active() {
        return false;
    }
    !(failure_at_ms > 0
        && now_ms.saturating_sub(failure_at_ms) < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS)
}

/// Extract an error message from common JSON error shapes.
pub fn extract_error_message(error: &serde_json::Value) -> String {
    match error {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(obj) => {
            if let Some(message) = obj
                .get("error")
                .and_then(serde_json::Value::as_object)
                .and_then(|nested| nested.get("message"))
                .and_then(serde_json::Value::as_str)
            {
                if !message.is_empty() {
                    return message.to_string();
                }
            }
            if let Some(message) = obj.get("message").and_then(serde_json::Value::as_str) {
                return message.to_string();
            }
            if let Some(body) = obj.get("responseBody").and_then(serde_json::Value::as_str) {
                return body.to_string();
            }
            serde_json::to_string(error).unwrap_or_else(|_| error.to_string())
        }
        _ => error.to_string(),
    }
}

/// Detect provider context overflow from raw error text.
pub fn detect_overflow(error_text: &str) -> OverflowDetection {
    if error_text.is_empty() {
        return OverflowDetection {
            is_overflow: false,
            reported_limit: None,
            reported_limit_provenance: None,
            matched_pattern: None,
        };
    }

    let has_status_413 =
        status_413_regex().is_match(error_text) && status_413_context_regex().is_match(error_text);
    let matched = overflow_patterns()
        .iter()
        .find(|pattern| pattern.regex.is_match(error_text));

    if matched.is_none() && !has_status_413 {
        return OverflowDetection {
            is_overflow: false,
            reported_limit: None,
            reported_limit_provenance: None,
            matched_pattern: None,
        };
    }

    let reported = parse_reported_limit(error_text);
    OverflowDetection {
        is_overflow: true,
        reported_limit: reported.map(|limit| limit.value),
        reported_limit_provenance: reported.map(|limit| limit.provenance),
        matched_pattern: matched.map(|pattern| pattern.source.to_string()),
    }
}

/// Detect provider context overflow from a JSON-shaped error value.
pub fn detect_overflow_value(error: &serde_json::Value) -> OverflowDetection {
    let message = extract_error_message(error);
    detect_overflow(&message)
}

/// Extract a plausible reported provider context limit from an error message.
pub fn parse_reported_limit(message: &str) -> Option<ReportedContextLimit> {
    if message.is_empty() {
        return None;
    }
    for pattern in limit_patterns() {
        let Some(captures) = pattern.regex.captures(message) else {
            continue;
        };
        let Some(raw) = captures.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Ok(value) = raw.parse::<u64>() else {
            continue;
        };
        if (MIN_PLAUSIBLE_CONTEXT_LIMIT..=MAX_PLAUSIBLE_CONTEXT_LIMIT).contains(&value) {
            return Some(ReportedContextLimit {
                value,
                provenance: pattern.provenance,
            });
        }
    }
    None
}

/// Compose scheduler, pressure, boundary, latch, and overflow transitions.
pub fn decide(inputs: &SchedulerInputs) -> SchedulerOutcome {
    let effective_context_limit = inputs.context_limit.or_else(|| {
        if inputs.usage.percentage > 0.0 && inputs.usage.input_tokens > 0.0 {
            Some(inputs.usage.input_tokens / (inputs.usage.percentage / 100.0))
        } else {
            None
        }
    });
    let threshold = resolve_execute_threshold(
        &inputs.config.execute_threshold_percentage,
        inputs.model_key.as_deref(),
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        inputs.config.execute_threshold_tokens.as_ref(),
        effective_context_limit,
    );

    let ttl_ms = scheduler_ttl_ms(&inputs.session.cache_ttl);
    let idle_ttl_fired =
        ttl_hard_expired(inputs.now_ms, inputs.session.last_response_time_ms, ttl_ms);
    let base = should_execute(
        &inputs.config,
        &inputs.session,
        &inputs.usage,
        inputs.now_ms,
        inputs.model_key.as_deref(),
        inputs.context_limit,
    );
    let pressure_execute_requested =
        inputs.usage.percentage > 0.0 && inputs.usage.percentage >= threshold;
    let mut pass =
        if base == BaseDecision::Execute || idle_ttl_fired || inputs.deferred_execute.is_some() {
            PassDecision::Execute
        } else {
            PassDecision::Defer
        };

    // The soft percentage still owns execute, force, and drain. The optional hard percentage is
    // isolated to the absolute wall, so absent geometry and coinciding geometry preserve the old
    // decision bytes while split geometry cannot move ordinary scheduling thresholds.
    pass = match derive_band_with_hard_wall(
        inputs.usage.percentage,
        inputs
            .usage
            .hard_wall_percentage
            .unwrap_or(inputs.usage.percentage),
        threshold,
    ) {
        Band::Emergency95 => PassDecision::Emergency95,
        Band::Force85 => PassDecision::Force85,
        Band::Normal => pass,
    };
    // A provider already rejected this session's wire shape. A low local usage
    // reading cannot safely defer recovery, so mirror the ≥95% emergency path.
    if inputs.emergency_recovery_armed && pass == PassDecision::Defer {
        pass = PassDecision::Emergency95;
    }

    let pass_before_boundary = pass;
    let (pass, deferred_execute) = apply_boundary_deferral(
        pass,
        inputs.tail_state,
        inputs.deferred_execute.clone(),
        inputs.boundary_bypass,
    );
    let defer_reason = match (pass_before_boundary, pass) {
        (PassDecision::Defer, PassDecision::Defer) => Some(SchedulerDeferReason::SchedulerDefer),
        (_, PassDecision::Defer) => Some(SchedulerDeferReason::MidTurnBoundary),
        _ => None,
    };
    let pressure_execute = pressure_execute_requested && pass != PassDecision::Defer;
    let drain_latch = advance_drain_latch(
        inputs.drain_latch,
        inputs.usage.percentage,
        threshold,
        inputs.now_ms,
    );
    let overflow_detection = inputs
        .overflow_error_text
        .as_deref()
        .map(detect_overflow)
        .filter(|detection| detection.is_overflow);
    let detected_limit = overflow_detection
        .as_ref()
        .and_then(|detection| detection.reported_limit);
    let detected_limit_provenance = overflow_detection
        .as_ref()
        .and_then(|detection| detection.reported_limit_provenance);

    SchedulerOutcome {
        pass,
        pressure_execute,
        idle_ttl_fired,
        drain_latch,
        deferred_execute,
        defer_reason,
        detected_limit,
        detected_limit_provenance,
    }
}

/// Convert a scheduler pass decision into the selection module's pass class.
pub fn to_selection_pass_class(pass: PassDecision) -> PassClass {
    match pass {
        PassDecision::Defer => PassClass::Defer,
        PassDecision::Execute => PassClass::Execute,
        PassDecision::Force85 | PassDecision::Emergency95 => PassClass::EmergencyForce,
    }
}

fn scheduler_ttl_ms(cache_ttl: &str) -> u64 {
    parse_cache_ttl(cache_ttl).unwrap_or(DEFAULT_CACHE_TTL_MS)
}

fn is_finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn resolve_percentage_match(
    values: &BTreeMap<String, f64>,
    model_key: Option<&str>,
) -> Option<f64> {
    if let Some(model_key) = model_key {
        for candidate in model_key_lookup_order(model_key) {
            if let Some(value) = values.get(&candidate) {
                return Some(*value);
            }
        }
    }
    values.get("default").copied()
}

fn resolve_tokens_match(
    tokens: &ExecuteThresholdTokensConfig,
    model_key: Option<&str>,
) -> Option<(f64, String)> {
    if let Some(model_key) = model_key {
        for candidate in model_key_lookup_order(model_key) {
            if let Some(value) = tokens.values.get(&candidate) {
                return Some((*value, candidate));
            }
        }
    }
    tokens
        .values
        .get("default")
        .map(|value| (*value, "default".to_string()))
}

pub(crate) fn model_key_lookup_order(model_key: &str) -> Vec<String> {
    let slash = model_key.find('/');
    let provider = slash.map_or("", |idx| &model_key[..idx]);
    // Try the provider name used by shared configuration before its compatibility aliases,
    // and try the full model name before a bare or dash-stripped name.
    let canonical_provider = match provider {
        "openai-codex" => "openai",
        "google-antigravity" => "google",
        "opencode-zen" => "opencode",
        other => other,
    };
    let native_provider = match canonical_provider {
        "openai" => "openai-codex",
        "google" => "google-antigravity",
        "opencode" => "opencode-zen",
        other => other,
    };
    let mut providers = Vec::new();
    for candidate in [canonical_provider, provider, native_provider] {
        if !candidate.is_empty() && !providers.contains(&candidate) {
            providers.push(candidate);
        }
    }
    let mut model_id = slash.map_or(model_key, |idx| &model_key[idx + 1..]);
    let mut keys = Vec::new();

    while !model_id.is_empty() {
        for provider in &providers {
            keys.push(format!("{provider}/{model_id}"));
        }
        keys.push(model_id.to_string());
        let Some(last_dash) = model_id.rfind('-') else {
            break;
        };
        if last_dash == 0 {
            break;
        }
        model_id = &model_id[..last_dash];
    }
    keys
}

fn compile_case_insensitive(source: &'static str) -> Regex {
    RegexBuilder::new(source)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|err| panic!("invalid regex {source:?}: {err}"))
}

fn overflow_patterns() -> &'static [CompiledPattern] {
    static PATTERNS: OnceLock<Vec<CompiledPattern>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            OVERFLOW_PATTERN_SOURCES
                .iter()
                .map(|source| CompiledPattern {
                    source,
                    regex: compile_case_insensitive(source),
                })
                .collect()
        })
        .as_slice()
}

fn limit_patterns() -> &'static [CompiledLimitPattern] {
    static PATTERNS: OnceLock<Vec<CompiledLimitPattern>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            LIMIT_EXTRACTION_PATTERN_SOURCES
                .iter()
                .map(|(source, provenance)| CompiledLimitPattern {
                    regex: compile_case_insensitive(source),
                    provenance: *provenance,
                })
                .collect()
        })
        .as_slice()
}

fn status_413_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b413\b").expect("valid 413 regex"))
}

fn status_413_context_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile_case_insensitive(r"(entity|payload|context|prompt)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Golden {
        constants: GoldenConstants,
        parse_ttl_cases: Vec<ParseTtlCase>,
        threshold_cases: Vec<ThresholdCase>,
        should_execute_cases: Vec<ShouldExecuteCase>,
        ttl_predicate_cases: Vec<TtlPredicateCase>,
        overflow_cases: Vec<OverflowCase>,
        limit_cases: Vec<LimitCase>,
    }

    #[derive(Deserialize)]
    struct GoldenConstants {
        default_execute_threshold_percentage: f64,
        max_execute_threshold_percentage: f64,
        force_materialize_percentage: f64,
        emergency_percentage: f64,
        default_cache_ttl_ms: u64,
        one_second_ms: u64,
        one_minute_ms: u64,
        one_hour_ms: u64,
        bare_numeric_ms: u64,
        emergency_drain_enter_percentage: f64,
        emergency_drain_exit_margin: f64,
        emergency_drain_fallback_exit_percentage: f64,
        emergency_drain_failure_backoff_ms: u64,
        emergency_drain_max_latch_ms: u64,
        min_plausible_context_limit: u64,
        max_plausible_context_limit: u64,
        overflow_pattern_sources: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ParseTtlCase {
        label: String,
        ttl: String,
        expected_ms: Option<u64>,
    }

    #[derive(Deserialize)]
    struct ThresholdCase {
        label: String,
        percentage_config: ExecuteThresholdConfig,
        tokens_config: Option<ExecuteThresholdTokensConfig>,
        model_key: Option<String>,
        fallback: f64,
        context_limit: Option<f64>,
        expected: f64,
    }

    #[derive(Deserialize)]
    struct ShouldExecuteCase {
        label: String,
        config: SchedulerConfig,
        session: SessionMeta,
        usage: ContextUsage,
        now_ms: u64,
        model_key: Option<String>,
        context_limit: Option<f64>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct TtlPredicateCase {
        label: String,
        now_ms: u64,
        last_response_time_ms: u64,
        ttl_ms: u64,
        expected_execute_fired: bool,
        expected_hard_expired: bool,
    }

    #[derive(Deserialize)]
    struct OverflowCase {
        label: String,
        input: serde_json::Value,
        expected_message: String,
        expected: OverflowExpected,
    }

    #[derive(Deserialize)]
    struct OverflowExpected {
        is_overflow: bool,
        reported_limit: Option<u64>,
        reported_limit_provenance: Option<ContextLimitProvenance>,
        matched_pattern: Option<String>,
    }

    #[derive(Deserialize)]
    struct LimitCase {
        label: String,
        message: String,
        expected: Option<ReportedContextLimit>,
    }

    fn assert_close(got: f64, expected: f64, label: &str) {
        assert!(
            (got - expected).abs() < 1e-9,
            "{label}: got {got}, expected {expected}"
        );
    }

    fn base_inputs() -> SchedulerInputs {
        SchedulerInputs {
            config: SchedulerConfig::default(),
            usage: ContextUsage {
                percentage: 10.0,
                input_tokens: 10_000.0,
                hard_wall_percentage: None,
            },
            session: SessionMeta {
                last_response_time_ms: 1_000,
                cache_ttl: "5m".to_string(),
            },
            now_ms: 2_000,
            model_key: None,
            context_limit: None,
            tail_state: TailState::default(),
            deferred_execute: None,
            boundary_bypass: BoundaryBypass::default(),
            drain_latch: LatchState::default(),
            overflow_error_text: None,
            emergency_recovery_armed: false,
        }
    }

    #[test]
    fn scheduler_golden_matches_production_behaviour() {
        let raw = include_str!("../testdata/scheduler-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse scheduler-golden.json");

        assert_close(
            DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            golden.constants.default_execute_threshold_percentage,
            "default execute threshold",
        );
        assert_close(
            MAX_EXECUTE_THRESHOLD_PERCENTAGE,
            golden.constants.max_execute_threshold_percentage,
            "max execute threshold",
        );
        assert_close(
            escalation_bands(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE).force_materialize_percentage,
            golden.constants.force_materialize_percentage,
            "force materialize percentage",
        );
        assert_close(
            EMERGENCY_PERCENTAGE,
            golden.constants.emergency_percentage,
            "emergency percentage",
        );
        assert_eq!(DEFAULT_CACHE_TTL_MS, golden.constants.default_cache_ttl_ms);
        assert_eq!(1000, golden.constants.one_second_ms);
        assert_eq!(60_000, golden.constants.one_minute_ms);
        assert_eq!(3_600_000, golden.constants.one_hour_ms);
        assert_eq!(1234, golden.constants.bare_numeric_ms);
        assert_close(
            escalation_bands(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE).force_materialize_percentage,
            golden.constants.emergency_drain_enter_percentage,
            "emergency drain enter",
        );
        assert_close(
            EMERGENCY_DRAIN_EXIT_MARGIN,
            golden.constants.emergency_drain_exit_margin,
            "emergency drain exit margin",
        );
        assert_close(
            EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE,
            golden.constants.emergency_drain_fallback_exit_percentage,
            "emergency drain fallback exit",
        );
        assert_eq!(
            EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
            golden.constants.emergency_drain_failure_backoff_ms
        );
        assert_eq!(
            EMERGENCY_DRAIN_MAX_LATCH_MS,
            golden.constants.emergency_drain_max_latch_ms
        );
        assert_eq!(
            MIN_PLAUSIBLE_CONTEXT_LIMIT,
            golden.constants.min_plausible_context_limit
        );
        assert_eq!(
            MAX_PLAUSIBLE_CONTEXT_LIMIT,
            golden.constants.max_plausible_context_limit
        );
        assert_eq!(
            OVERFLOW_PATTERN_SOURCES,
            golden
                .constants
                .overflow_pattern_sources
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
        );

        for case in golden.parse_ttl_cases {
            let got = parse_cache_ttl(&case.ttl).ok();
            assert_eq!(got, case.expected_ms, "parse ttl {}", case.label);
        }

        for case in golden.threshold_cases {
            let got = resolve_execute_threshold(
                &case.percentage_config,
                case.model_key.as_deref(),
                case.fallback,
                case.tokens_config.as_ref(),
                case.context_limit,
            );
            assert_close(got, case.expected, &case.label);
        }

        for case in golden.should_execute_cases {
            let got = should_execute(
                &case.config,
                &case.session,
                &case.usage,
                case.now_ms,
                case.model_key.as_deref(),
                case.context_limit,
            );
            let expected = match case.expected.as_str() {
                "execute" => BaseDecision::Execute,
                "defer" => BaseDecision::Defer,
                other => panic!("unknown expected decision {other:?}"),
            };
            assert_eq!(got, expected, "should execute {}", case.label);
        }

        for case in golden.ttl_predicate_cases {
            assert_eq!(
                ttl_execute_fired(case.now_ms, case.last_response_time_ms, case.ttl_ms),
                case.expected_execute_fired,
                "scheduler ttl predicate {}",
                case.label
            );
            assert_eq!(
                ttl_hard_expired(case.now_ms, case.last_response_time_ms, case.ttl_ms),
                case.expected_hard_expired,
                "hard ttl predicate {}",
                case.label
            );
        }

        for case in golden.overflow_cases {
            let message = extract_error_message(&case.input);
            assert_eq!(message, case.expected_message, "extract {}", case.label);
            let got = detect_overflow_value(&case.input);
            assert_eq!(
                got.is_overflow, case.expected.is_overflow,
                "overflow flag {}",
                case.label
            );
            assert_eq!(
                got.reported_limit, case.expected.reported_limit,
                "reported limit {}",
                case.label
            );
            assert_eq!(
                got.reported_limit_provenance, case.expected.reported_limit_provenance,
                "reported limit provenance {}",
                case.label
            );
            assert_eq!(
                got.matched_pattern, case.expected.matched_pattern,
                "matched pattern {}",
                case.label
            );
        }

        for case in golden.limit_cases {
            assert_eq!(
                parse_reported_limit(&case.message),
                case.expected,
                "parse reported limit {}",
                case.label
            );
        }
    }

    #[test]
    fn band_boundaries_are_non_vacuous() {
        assert_eq!(derive_band(84.9, 65.0), Band::Normal);
        assert_eq!(derive_band(85.0, 65.0), Band::Force85);
        assert_eq!(derive_band(94.9, 90.0), Band::Force85);
        assert_eq!(derive_band(95.0, 90.0), Band::Emergency95);
    }

    #[test]
    fn split_geometry_keeps_force_soft_and_moves_only_the_absolute_wall() {
        assert_eq!(
            derive_band_with_hard_wall(96.0, 73.2, 65.0),
            Band::Force85,
            "soft pressure may force materialization before the provider wall"
        );
        assert_eq!(
            derive_band_with_hard_wall(96.0, 95.0, 65.0),
            Band::Emergency95
        );
    }

    #[test]
    fn absent_and_coinciding_hard_geometry_produce_identical_decision_bytes() {
        let absent = base_inputs();
        let mut coinciding = absent.clone();
        coinciding.usage.hard_wall_percentage = Some(coinciding.usage.percentage);

        let absent_bytes = serde_json::to_vec(&decide(&absent)).unwrap();
        let coinciding_bytes = serde_json::to_vec(&decide(&coinciding)).unwrap();
        assert_eq!(absent_bytes, coinciding_bytes);
    }

    #[test]
    fn escalation_bands_stay_ordered_above_execute_and_below_emergency() {
        for (threshold, expected_force) in [(65.0, 85.0), (80.0, 85.0), (88.0, 90.0), (90.0, 92.0)]
        {
            let bands = escalation_bands(threshold);
            assert_eq!(bands.force_materialize_percentage, expected_force);
            assert!(threshold < bands.force_materialize_percentage);
            assert!(bands.force_materialize_percentage >= 85.0);
            assert!(bands.force_materialize_percentage < 95.0);
            assert_eq!(bands.emergency_percentage, 95.0);
        }
    }

    #[test]
    fn pre_raise_thresholds_keep_the_exact_85_percent_force_band() {
        assert_eq!(escalation_bands(65.0).force_materialize_percentage, 85.0);
        assert_eq!(escalation_bands(80.0).force_materialize_percentage, 85.0);
    }

    #[test]
    fn durable_overflow_arm_upgrades_only_a_would_be_defer_to_emergency() {
        let mut inputs = base_inputs();
        inputs.emergency_recovery_armed = true;
        let forced = decide(&inputs);
        assert_eq!(forced.pass, PassDecision::Emergency95);

        inputs.usage.percentage = 70.0;
        inputs.usage.input_tokens = 70_000.0;
        let natural_execute = decide(&inputs);
        assert_eq!(natural_execute.pass, PassDecision::Execute);
    }

    #[test]
    fn boundary_deferral_records_retries_and_respects_bypasses() {
        let tail = TailState { mid_tool_use: true };
        let (decision, pending) =
            apply_boundary_deferral(PassDecision::Execute, tail, None, BoundaryBypass::default());
        assert_eq!(decision, PassDecision::Defer);
        assert!(pending.is_some(), "mid-tool execute must record an intent");

        let (decision, pending) = apply_boundary_deferral(
            PassDecision::Execute,
            TailState {
                mid_tool_use: false,
            },
            pending,
            BoundaryBypass::default(),
        );
        assert_eq!(decision, PassDecision::Execute);
        let pending = drain_deferred_after_work(pending, true);
        assert!(pending.is_none(), "successful work drains the retry intent");

        let (decision, pending) =
            apply_boundary_deferral(PassDecision::Force85, tail, None, BoundaryBypass::default());
        assert_eq!(decision, PassDecision::Force85);
        assert!(pending.is_none(), "force passes bypass mid-turn deferral");

        let (decision, pending) = apply_boundary_deferral(
            PassDecision::Execute,
            tail,
            None,
            BoundaryBypass {
                explicit_bust: false,
                subagent: true,
            },
        );
        assert_eq!(decision, PassDecision::Execute);
        assert!(
            pending.is_none(),
            "subagent passes bypass mid-turn deferral"
        );

        let failed = drain_deferred_after_work(Some(DeferredExecute::pending_execute()), false);
        assert!(failed.is_some(), "failed work keeps the retry intent");
    }

    #[test]
    fn canonical_defer_classes_preserve_the_typescript_reason_vocabulary() {
        let mut genuine_defer = base_inputs();
        genuine_defer.tail_state.mid_tool_use = true;
        let genuine = decide(&genuine_defer);
        assert_eq!(genuine.pass.canonical_decision(), "defer");
        assert_eq!(
            genuine.defer_reason,
            Some(SchedulerDeferReason::SchedulerDefer)
        );

        let mut boundary_downgrade = base_inputs();
        boundary_downgrade.usage.percentage = 70.0;
        boundary_downgrade.tail_state.mid_tool_use = true;
        let downgraded = decide(&boundary_downgrade);
        assert_eq!(downgraded.pass.canonical_decision(), "defer");
        assert_eq!(
            downgraded.defer_reason,
            Some(SchedulerDeferReason::MidTurnBoundary)
        );
    }

    #[test]
    fn latch_lifecycle_and_failure_backoff_are_distinct() {
        let t = 1_000_000;
        let entered = advance_drain_latch(LatchState::default(), 95.0, 65.0, t);
        assert_eq!(entered.active_since_ms, Some(t));

        let held = advance_drain_latch(entered, 90.0, 65.0, t + 1_000);
        assert_eq!(held, entered, "90% is above the 55% exit threshold");

        let exited = advance_drain_latch(held, 54.9, 65.0, t + 2_000);
        assert_eq!(exited.active_since_ms, None);

        let expired =
            advance_drain_latch(entered, 84.0, 65.0, t + EMERGENCY_DRAIN_MAX_LATCH_MS + 1);
        assert_eq!(expired.active_since_ms, None);

        let below_raised_band = advance_drain_latch(LatchState::default(), 91.0, 90.0, t);
        assert_eq!(below_raised_band.active_since_ms, None);
        let at_raised_band = advance_drain_latch(LatchState::default(), 92.0, 90.0, t);
        assert_eq!(at_raised_band.active_since_ms, Some(t));

        let failure_at = t + 10;
        assert!(
            !drain_bypass_allowed(entered, failure_at, t + 20),
            "recent failure suppresses only the bypass"
        );
        assert_eq!(
            advance_drain_latch(entered, 90.0, 65.0, t + 20),
            entered,
            "failure backoff must not deactivate the latch"
        );
        assert!(
            drain_bypass_allowed(
                entered,
                failure_at,
                failure_at + EMERGENCY_DRAIN_FAILURE_BACKOFF_MS
            ),
            "bypass resumes at the backoff boundary"
        );
    }

    #[test]
    fn raised_threshold_ladder_arms_holds_and_exits_at_typescript_boundaries() {
        let t = 2_000_000;
        for threshold in 84..=90 {
            let threshold = f64::from(threshold);
            let force = threshold + 2.0;
            assert_eq!(
                escalation_bands(threshold).force_materialize_percentage,
                force
            );

            let below = advance_drain_latch(LatchState::default(), force - 1.0, threshold, t);
            assert_eq!(below.active_since_ms, None, "threshold {threshold}");

            let entered = advance_drain_latch(below, force, threshold, t + 1);
            assert_eq!(
                entered.active_since_ms,
                Some(t + 1),
                "threshold {threshold}"
            );

            let held = advance_drain_latch(entered, force - 1.0, threshold, t + 2);
            assert_eq!(held, entered, "threshold {threshold}");

            let exited = advance_drain_latch(held, threshold - 10.1, threshold, t + 3);
            assert_eq!(exited.active_since_ms, None, "threshold {threshold}");
        }
    }

    #[test]
    fn inherited_drain_at_63_percent_holds_without_forcing_execute() {
        let mut inputs = base_inputs();
        inputs.drain_latch = LatchState {
            active_since_ms: Some(1_000),
        };
        inputs.context_limit = Some(100_000.0);
        for (percentage, expected_pass, expected_active) in [
            (63.0, PassDecision::Defer, true),
            (65.0, PassDecision::Execute, true),
            (55.0, PassDecision::Defer, true),
            (54.9, PassDecision::Defer, false),
        ] {
            inputs.usage.percentage = percentage;
            inputs.usage.input_tokens = percentage * 1_000.0;
            let outcome = decide(&inputs);
            assert_eq!(outcome.pass, expected_pass, "usage {percentage}");
            assert_eq!(
                outcome.drain_latch.is_active(),
                expected_active,
                "usage {percentage}"
            );
            let unlatched = decide(&SchedulerInputs {
                drain_latch: LatchState::default(),
                ..inputs.clone()
            });
            assert_eq!(
                outcome.pass, unlatched.pass,
                "latch must not choose the pass"
            );
        }
    }

    #[test]
    fn decide_is_deterministic_for_identical_inputs() {
        let mut inputs = base_inputs();
        inputs.usage.percentage = 86.0;
        inputs.overflow_error_text =
            Some("This model's maximum context length is 128000 tokens".to_string());
        let first = decide(&inputs);
        let second = decide(&inputs);
        assert_eq!(first, second);
    }

    #[test]
    fn hard_idle_ttl_forces_execute_but_fresh_session_stays_deferred() {
        let mut inputs = base_inputs();
        inputs.session.last_response_time_ms = 1_000;
        inputs.session.cache_ttl = "5m".to_string();
        inputs.now_ms = 1_000 + DEFAULT_CACHE_TTL_MS + 1;
        let boundary = decide(&inputs);
        assert!(boundary.idle_ttl_fired);
        assert_eq!(boundary.pass, PassDecision::Execute);
        assert!(!boundary.pressure_execute);

        inputs.usage.percentage = 0.0;
        inputs.usage.input_tokens = 0.0;
        inputs.session.last_response_time_ms = 0;
        inputs.now_ms = DEFAULT_CACHE_TTL_MS + 1;
        let fresh = decide(&inputs);
        assert!(!fresh.idle_ttl_fired);
        assert_eq!(fresh.pass, PassDecision::Defer);
    }

    #[test]
    fn pending_execute_retries_after_tail_closes() {
        let mut inputs = base_inputs();
        inputs.deferred_execute = Some(DeferredExecute::pending_execute());
        inputs.tail_state.mid_tool_use = false;
        let outcome = decide(&inputs);
        assert_eq!(outcome.pass, PassDecision::Execute);
        assert!(outcome.deferred_execute.is_some());
        assert!(drain_deferred_after_work(outcome.deferred_execute, true).is_none());
    }

    #[test]
    fn pass_decision_maps_to_selection_vocabulary() {
        assert_eq!(
            to_selection_pass_class(PassDecision::Defer),
            PassClass::Defer
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Execute),
            PassClass::Execute
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Force85),
            PassClass::EmergencyForce
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Emergency95),
            PassClass::EmergencyForce
        );
    }

    #[test]
    fn parse_cache_ttl_never_returns_u64_max() {
        assert_eq!(parse_cache_ttl("never"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("NEVER"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl(" never "), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("Never"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("5m"), Ok(300_000));
        assert_eq!(parse_cache_ttl("bad-format"), Err(CacheTtlParseError));
    }

    #[test]
    fn never_ttl_predicates_are_always_false() {
        // Scheduler: elapsed > u64::MAX is never true.
        assert!(!ttl_execute_fired(u64::MAX, 0, u64::MAX));
        assert!(!ttl_execute_fired(1_000_000, 0, u64::MAX));
        // Hard: elapsed >= u64::MAX is never true.
        assert!(!ttl_hard_expired(u64::MAX, 1, u64::MAX));
        assert!(!ttl_hard_expired(1_000_000, 1, u64::MAX));
    }

    #[test]
    fn never_ttl_scheduler_stays_deferred() {
        let mut inputs = base_inputs();
        // 10-day-old last response, well past any normal TTL
        inputs.session.last_response_time_ms = 1_000;
        inputs.session.cache_ttl = "never".to_string();
        inputs.now_ms = 1_000 + 10 * 24 * 60 * 60 * 1000;
        // Below threshold, so TTL is the only path to execute
        inputs.usage.percentage = 50.0;
        let outcome = decide(&inputs);
        assert!(!outcome.idle_ttl_fired);
        assert_eq!(outcome.pass, PassDecision::Defer);
    }
}
