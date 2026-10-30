//! Protected-tail boundary + compartment trigger: WHERE the compactable/
//! protected split sits and WHETHER a historian run should fire, decided purely
//! from the in-memory tail. Historian execution lives elsewhere; this is the
//! deterministic decision layer.
//!
//! All token measurement in this unit is a pure function of caller-provided
//! message/block bytes and caller-provided context. There is no I/O, wall clock,
//! store access, or ambient cache state here: the same inputs always produce the
//! same boundary and trigger decision.

use std::collections::{BTreeMap, HashMap};
use std::ops::Range;
use std::sync::{Arc, OnceLock};

use mc_tokenizer::estimate_tokens;
use regex::Regex;
use serde_json::Value;

use crate::historian::HistorianNoFireCause;
use crate::scheduler::escalation_bands;
use crate::selection::SelKind;
mod async_cache;
pub(crate) use async_cache::AsyncTriggerCache;

// --- Constants for protected-tail sizing and trigger thresholds. ---

const ALPHA: f64 = 0.3;
const FLOOR_RATIO: f64 = 0.08;
const FLOOR_MIN: f64 = 2_000.0;
const FLOOR_MAX: f64 = 12_000.0;
const ABS_CAP: f64 = 96_000.0;
const MAX_USABLE_RATIO: f64 = 0.4;
const RESERVED_HEADROOM_MIN: f64 = 1_000.0;
const RESERVED_HEADROOM_RATIO: f64 = 0.02;
const NON_EMERGENCY_MAX_CAP: f64 = 250_000.0;
const FORCE80_MAX_CAP: f64 = 500_000.0;
const FORCE95_MAX_CAP: f64 = 750_000.0;
const NORMAL_HYSTERESIS_TOKENS: f64 = 256.0;
const MIN_FORCE_ELIGIBLE_TOKENS_CAP: f64 = 1_000.0;

const TRIGGER_BUDGET_PERCENTAGE: f64 = 0.05;
const TRIGGER_BUDGET_MIN: f64 = 5_000.0;
const TRIGGER_BUDGET_MAX: f64 = 50_000.0;
const PROACTIVE_TRIGGER_OFFSET_PERCENTAGE: f64 = 2.0;
const POST_DROP_TARGET_RATIO: f64 = 0.75;
const MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE: f64 = 6_000.0;
const MIN_PROACTIVE_TAIL_MESSAGE_COUNT: usize = 12;
const DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER: usize = 3;
const TAIL_SIZE_TRIGGER_MULTIPLIER: f64 = 3.0;
const FORCE80_CAP_TIER_PERCENTAGE: f64 = 80.0;
const BLOCK_UNTIL_DONE_PERCENTAGE: f64 = 95.0;
const MAX_COMMITS_PER_BLOCK: usize = 5;

const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";

/// Message role used by boundary and trigger decisions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// A user-authored message.
    User,
    /// An assistant-authored message.
    Assistant,
    /// A system-authored message.
    System,
    /// Any provider-specific role not otherwise known to the module.
    Other(String),
}

impl Role {
    /// Convert a provider role string to the narrow role vocabulary this unit reads.
    pub fn from_provider(value: &str) -> Self {
        match value {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            "system" => Role::System,
            other => Role::Other(other.to_string()),
        }
    }

    /// Return the provider role spelling used when formatting messages into historian `U:`/`A:`/`TC:` chunks.
    pub fn as_str(&self) -> &str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Other(value) => value.as_str(),
        }
    }
}

/// One original pre-reduction content block inside a [`BoundaryMsg`].
#[derive(Debug, Clone)]
pub struct BoundaryBlock {
    /// Stable block id (follows the same id convention used by the sibling selection module).
    pub id: String,
    /// Block ordinal within the flat tail. Message-level algorithms use the parent
    /// message ordinal; this remains available for callers that preserve block order.
    pub ordinal: u64,
    /// Typed content kind (`SelKind`, shared with the selection module for cross-module consistency).
    pub kind: SelKind,
    /// True for provider/server-executed tool blocks; these cannot start an in-flight tool-call arc.
    pub provider_executed: bool,
    /// Original byte length supplied by the caller for diagnostics.
    pub byte_size: usize,
    /// Tool arc id for calls/results/reasoning that belong to the same invocation.
    pub arc_id: Option<String>,
    /// Original pre-reduction block bytes as UTF-8 text, shared with the flat projection.
    ///
    /// Boundary and trigger token measurement always uses this value, never a
    /// rendered reduction placeholder. Sharing the projection's allocation keeps
    /// trigger evaluation from cloning every raw block on every pass.
    pub original: Arc<str>,
    /// Token count for `original`, computed once while constructing this pass's boundary input.
    /// Keeping it beside the source lets projected-drop and boundary walks share the same exact
    /// measurement instead of running byte-BPE repeatedly over an unchanged multi-megabyte tail.
    pub original_token_count: usize,
    /// Optional rendered form after reduction. It is deliberately ignored by every
    /// decision function and exists only to make the raw-byte invariant testable.
    pub rendered: Option<String>,
    /// Mirrors OpenCode text parts marked `ignored`; ignored user text does not
    /// contribute to the live-prompt floor, which keeps the current user prompt protected.
    pub ignored: bool,
}

/// Message-grouped boundary input.
#[derive(Debug, Clone)]
pub struct BoundaryMsg {
    /// Absolute raw-session ordinal for the message.
    pub message_ordinal: u64,
    /// Provider message id. Used only for diagnostics; boundary and trigger logic do not read it.
    pub message_id: String,
    /// Provider message role.
    pub role: Role,
    /// Original blocks that belong to this message.
    pub blocks: Vec<BoundaryBlock>,
}

/// Inputs for resolving the protected-tail boundary.
#[derive(Debug, Clone)]
pub struct BoundaryContext {
    /// Static class ratios for this decision; original block/cache counts stay raw.
    pub calibration: Option<crate::decision_calibration::DecisionCalibration>,
    /// Main model context limit in tokens.
    pub context_limit: f64,
    /// Execute threshold percentage used to derive usable context.
    pub execute_threshold_percentage: f64,
    /// Current input usage percentage.
    pub usage_percentage: f64,
    /// Current input token count; fractional inputs are rounded to the nearest token.
    pub usage_input_tokens: f64,
    /// Last raw message ordinal already published in a compartment, or `None` before
    /// the first compartment. Ordinal 0 can be a real published end.
    pub last_compartment_end_ordinal: Option<u64>,
    /// Previous boundary ordinal from an earlier calculation; retained so that floor can be reapplied.
    pub prior_boundary_ordinal: u64,
    /// Whether the floor based on `prior_boundary_ordinal` is currently active.
    pub migration_floor_active: bool,
    /// Optional emergency shrink scale (`0.5` at force-band pressure, `0.25` at 95% pressure).
    pub emergency_tail_scale: Option<f64>,
    /// Optional pre-derived trigger budget; when omitted, [`derive_trigger_budget`] is used.
    pub trigger_budget: Option<f64>,
    /// True when folding is the only reclaim path and the live tail is forwarded verbatim.
    pub fold_is_only_reclaim: bool,
}

impl Default for BoundaryContext {
    fn default() -> Self {
        Self {
            calibration: None,
            context_limit: 128_000.0,
            execute_threshold_percentage: 65.0,
            usage_percentage: 0.0,
            usage_input_tokens: 0.0,
            last_compartment_end_ordinal: None,
            prior_boundary_ordinal: 1,
            migration_floor_active: false,
            emergency_tail_scale: None,
            trigger_budget: None,
            fold_is_only_reclaim: false,
        }
    }
}

/// Token target details for the protected-tail window.
#[derive(Debug, Clone, PartialEq)]
pub struct ProtectedTailTokenTarget {
    /// Usable context tokens: `context_limit × execute_threshold%`.
    pub usable: f64,
    /// Unfloored usage-sensitive target.
    pub raw_n: f64,
    /// Floor before the ceiling clamp.
    pub floor_n: f64,
    /// Ceiling after absolute, usable-ratio, and headroom clamps.
    pub ceiling_n: f64,
    /// Floor after it is capped by the ceiling.
    pub effective_floor: f64,
    /// Final unscaled target.
    pub n: f64,
    /// Reserved headroom kept out of the protected tail.
    pub headroom: f64,
    /// Trigger budget used by the headroom calculation.
    pub trigger_budget: f64,
    /// Fixed/ratio reserve before it is combined with the trigger budget.
    pub reserve: f64,
}

/// Result of resolving the compactable/protected split.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryResolution {
    /// First protected raw-message ordinal; messages before this are eligible head.
    pub protected_start_ordinal: u64,
    /// Half-open compactable range, from `last_compartment_end + 1` up to the head cap.
    pub eligible_head: Range<u64>,
    /// Scaled protected-tail token target used to walk backward from the newest message.
    pub n_tokens: f64,
    /// True when normal, non-emergency pressure kept the newest non-ignored user prompt protected.
    pub floored_by_live_prompt: bool,
    /// True when a recent open tool invocation fenced the boundary or head.
    pub fenced_by_open_arc: bool,
    /// True raw tokens in `offset..protected_start_ordinal`.
    pub true_raw_eligible_tokens: f64,
    /// True when the per-run cap had to include one atomic message/arc larger than the cap.
    pub oversize_atomic_unit: bool,
    /// Absolute raw-message count observed in the input.
    pub raw_message_count: u64,
    /// Diagnostic reason for the primary boundary placement.
    pub boundary_reason: String,
}

/// A manual wrapup cut and the raw-tail accounting used to report its outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct WrapupBoundaryResolution {
    pub boundary: BoundaryResolution,
    /// Number of raw messages of any role above the latest compartment.
    pub raw_messages_above_last_compartment: usize,
    /// First ordinal retained in the verbatim tail after safety snapping.
    pub target_protected_start_ordinal: u64,
}

/// Chunked tail measurement in the historian's `U:`/`A:`/`TC:` block format.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkEstimate {
    /// Actual tokens in emitted formatted blocks, without budget saturation.
    pub tokens: f64,
    /// True only when a real formatted block could not fit the scan budget.
    /// Trailing filtered rows do not count as remaining narratable content.
    pub has_more: bool,
    /// Formatted block strings produced by the chunk-formatting step and then tokenized.
    pub formatted_blocks: Vec<String>,
    /// Token count per formatted block before any saturation.
    pub block_tokens: Vec<f64>,
    /// Number of raw messages represented in formatted blocks.
    pub message_count: usize,
    /// Number of assistant commit clusters in the formatted prefix.
    pub commit_cluster_count: usize,
}

/// Inputs for checking whether the historian should fire.
#[derive(Debug, Clone)]
pub struct TriggerContext {
    /// Boundary context used for the primary protected-tail resolution.
    pub boundary: BoundaryContext,
    /// True when a historian/compartment run is already active.
    pub compartment_in_progress: bool,
    /// Projected post-drop usage percentage supplied by the caller, if available.
    pub projected_post_drop_percentage: Option<f64>,
    /// True if this pass already has a cache-busting event that can apply pending drops;
    /// a history publication that has not yet occurred does not qualify.
    pub reclaim_ride_available: bool,
    /// Whether commit clusters may trigger a run.
    pub commit_cluster_trigger_enabled: bool,
    /// Minimum assistant commit clusters required for the commit trigger.
    pub min_commit_clusters: usize,
}

impl Default for TriggerContext {
    fn default() -> Self {
        Self {
            boundary: BoundaryContext::default(),
            compartment_in_progress: false,
            projected_post_drop_percentage: None,
            reclaim_ride_available: false,
            commit_cluster_trigger_enabled: true,
            min_commit_clusters: DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER,
        }
    }
}

/// Reason a trigger decision fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerReason {
    /// Context pressure reached the projected-headroom threshold and drops are not enough.
    ProjectedHeadroom,
    /// Context pressure reached the threshold-derived force band.
    ForceBand,
    /// Enough assistant commit clusters accumulated in the eligible head.
    CommitClusters,
    /// Enough TC-chunked tail eligible for historian summarization accumulated.
    TailSize,
}

impl TriggerReason {
    /// Wire spelling used for serialized trigger results.
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerReason::ProjectedHeadroom => "projected_headroom",
            TriggerReason::ForceBand => "force_band",
            TriggerReason::CommitClusters => "commit_clusters",
            TriggerReason::TailSize => "tail_size",
        }
    }
}

/// Pure trigger result.
#[derive(Debug, Clone, PartialEq)]
pub struct TriggerDecision {
    /// True when the historian should fire.
    pub fire: bool,
    /// Fire reason, absent when `fire` is false.
    pub reason: Option<TriggerReason>,
    /// Concrete refusal cause, absent when `fire` is true.
    pub no_fire_cause: Option<HistorianNoFireCause>,
    /// Last raw-message ordinal the run may consume, always before the protected tail.
    pub consume_through_ordinal: Option<u64>,
    /// The exact boundary snapshot that produced a fire decision. The assembler consumes
    /// this object directly so the trigger and chunk snapshot cannot resolve different ranges.
    pub boundary: Option<BoundaryResolution>,
    /// Progress toward the tail_size bar, present whenever a boundary was resolved (fire or
    /// not). Diagnostics-only: rendering it must never influence the decision itself.
    pub progress: Option<TriggerProgress>,
}

/// Why the trigger did or did not fire, in numbers. Surfaced through the transform
/// response's historian diagnostics so a stalled rig drive is diagnosable per pass
/// (eligible content vs the bar, and how much tail the protected boundary is holding back).
#[derive(Debug, Clone, PartialEq)]
pub struct TriggerProgress {
    /// First ordinal in the eligible head measured by this evaluation.
    pub eligible_start_ordinal: u64,
    /// TC-chunked tokens in the eligible head (what tail_size compares against the bar).
    pub eligible_chunk_tokens: f64,
    /// The tail_size fire bar (trigger_budget x multiplier).
    pub tail_size_bar: f64,
    /// Protected-tail token target N; shrinks as usage grows.
    pub n_tokens: f64,
    /// First protected ordinal (eligible head ends here).
    pub protected_start_ordinal: u64,
}

/// Derive the size-trigger budget from context size and execute threshold.
pub fn derive_trigger_budget(context_limit: f64, execute_threshold_percentage: f64) -> f64 {
    if !context_limit.is_finite() || context_limit <= 0.0 {
        return TRIGGER_BUDGET_MIN;
    }
    let threshold_fraction = execute_threshold_percentage.max(0.0) / 100.0;
    let usable = context_limit * threshold_fraction;
    let derived = (usable * TRIGGER_BUDGET_PERCENTAGE).round();
    derived.clamp(TRIGGER_BUDGET_MIN, TRIGGER_BUDGET_MAX)
}

fn first_live_message_ordinal(messages: &[BoundaryMsg]) -> Option<u64> {
    messages.iter().map(|message| message.message_ordinal).min()
}

fn compartment_offset(
    last_compartment_end_ordinal: Option<u64>,
    messages: &[BoundaryMsg],
) -> Option<u64> {
    last_compartment_end_ordinal
        .map(|end| end.saturating_add(1))
        .or_else(|| first_live_message_ordinal(messages))
}

/// Derive the protected-tail token target before optional emergency scaling.
pub fn derive_protected_tail_token_target(ctx: &BoundaryContext) -> ProtectedTailTokenTarget {
    let safe_context_limit = if ctx.context_limit.is_finite() && ctx.context_limit > 0.0 {
        ctx.context_limit
    } else {
        128_000.0
    };
    let safe_threshold = if ctx.execute_threshold_percentage.is_finite() {
        ctx.execute_threshold_percentage.max(0.0)
    } else {
        65.0
    };
    let usable = ((safe_context_limit * safe_threshold) / 100.0)
        .round()
        .max(1.0);
    let usage = clamp_percentage(ctx.usage_percentage);
    let trigger_budget = ctx
        .trigger_budget
        .unwrap_or_else(|| derive_trigger_budget(safe_context_limit, safe_threshold));
    let reserve = RESERVED_HEADROOM_MIN.max((usable * RESERVED_HEADROOM_RATIO).round());
    let raw_n = (usable * ALPHA * (1.0 - usage / 100.0)).round();
    let floor_n = FLOOR_MAX.min(FLOOR_MIN.max((usable * FLOOR_RATIO).round()));
    let headroom = (trigger_budget + reserve).min((usable * 0.5).floor());
    let ceiling_n = 1.0_f64.max(
        ABS_CAP
            .min((usable * MAX_USABLE_RATIO).floor())
            .min(usable - headroom),
    );
    let effective_floor = floor_n.min(ceiling_n);
    let n = ceiling_n.min(effective_floor.max(raw_n));
    ProtectedTailTokenTarget {
        usable,
        raw_n,
        floor_n,
        ceiling_n,
        effective_floor,
        n,
        headroom,
        trigger_budget,
        reserve,
    }
}

/// Resolve the protected-tail boundary from original pre-reduction message bytes.
///
/// The token walk intentionally ignores [`BoundaryBlock::rendered`]. Dropped or
/// skeletonized render placeholders are compose-time presentation; the durable raw
/// session still contains the original bytes, and those are the bytes the historian
/// would summarize if the trigger fired.
pub fn resolve_protected_tail_boundary(
    messages: &[BoundaryMsg],
    ctx: &BoundaryContext,
) -> BoundaryResolution {
    let index = TokenIndex::calibrated(messages, ctx.calibration);
    resolve_protected_tail_boundary_with_index(messages, ctx, &index)
}

fn resolve_protected_tail_boundary_with_index(
    messages: &[BoundaryMsg],
    ctx: &BoundaryContext,
    index: &TokenIndex,
) -> BoundaryResolution {
    let arcs = build_tool_arcs(messages);
    resolve_protected_tail_boundary_prepared(messages, ctx, index, &arcs)
}

fn resolve_protected_tail_boundary_prepared(
    messages: &[BoundaryMsg],
    ctx: &BoundaryContext,
    index: &TokenIndex,
    arcs: &[ToolArc],
) -> BoundaryResolution {
    let raw_message_count = index.raw_message_count;
    let offset = compartment_offset(ctx.last_compartment_end_ordinal, messages).unwrap_or(1);
    let usage_percentage = clamp_percentage(ctx.usage_percentage);
    let usage_input_tokens = ctx.usage_input_tokens.max(0.0).round();

    if raw_message_count == 0 {
        return BoundaryResolution {
            protected_start_ordinal: 1,
            eligible_head: offset..offset,
            n_tokens: 0.0,
            floored_by_live_prompt: false,
            fenced_by_open_arc: false,
            true_raw_eligible_tokens: 0.0,
            oversize_atomic_unit: false,
            raw_message_count,
            boundary_reason: format!("empty-session:{usage_input_tokens:.0}"),
        };
    }

    let target = derive_protected_tail_token_target(ctx);
    let scaled_n = ctx
        .emergency_tail_scale
        .map(|scale| (target.n * scale).floor().max(1.0))
        .unwrap_or(target.n);
    let mut boundary = index.find_suffix_start_for_tokens(scaled_n);
    let recent_open_arc_cutoff = boundary;
    let mut boundary_reason = if boundary == index.first_ordinal {
        "whole-session-smaller-than-tail".to_string()
    } else {
        "size-walk".to_string()
    };

    let token_at_boundary = index.token_for_ordinal(boundary);
    if boundary < index.terminal_ordinal
        && token_at_boundary > (2.0 * scaled_n).max(64_000.0)
        && boundary < index.last_ordinal
    {
        boundary += 1;
        boundary_reason = "huge-message-exception".to_string();
    }

    let first_fence = fence_boundary_for_tool_arcs(boundary, arcs, offset, recent_open_arc_cutoff);
    let mut fenced_by_open_arc = first_fence.open_arc;
    boundary = first_fence.boundary;

    let snapped = semantic_snap_boundary(messages, index, boundary, scaled_n, offset);
    if snapped != boundary {
        boundary_reason = "semantic-snap".to_string();
    }
    let second_fence = fence_boundary_for_tool_arcs(snapped, arcs, offset, recent_open_arc_cutoff);
    fenced_by_open_arc |= second_fence.open_arc;
    boundary = second_fence.boundary;

    let mut runtime_floor = offset;
    if ctx.migration_floor_active {
        runtime_floor = runtime_floor.max(ctx.prior_boundary_ordinal);
    }
    let mut protected_tail_start = boundary.max(runtime_floor);

    let mut floored_by_live_prompt = false;
    let force_materialization_percentage =
        escalation_bands(ctx.execute_threshold_percentage).force_materialize_percentage;
    if ctx.emergency_tail_scale.is_none() && usage_percentage < force_materialization_percentage {
        if let Some(last_meaningful_user) = messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User && has_meaningful_user_text(&message.blocks))
            .map(|message| message.message_ordinal)
        {
            if last_meaningful_user >= offset && protected_tail_start > last_meaningful_user {
                protected_tail_start = last_meaningful_user;
                floored_by_live_prompt = true;
            }
        }
    }

    if protected_tail_start > offset
        && index.range_tokens(offset, protected_tail_start) <= NORMAL_HYSTERESIS_TOKENS
    {
        protected_tail_start = offset;
    }
    protected_tail_start = index.clamp_ordinal(protected_tail_start);

    if ctx.fold_is_only_reclaim && raw_message_count > 0 {
        // On verbatim-tail profiles, folding is the only reclaim path, while the newest message
        // is still forwarded in full. Keep the newest message and its tool pair out of the
        // fold so the live turn cannot become a durable compartment boundary.
        let newest_floor = newest_message_protected_floor(arcs, index);
        protected_tail_start = protected_tail_start.min(newest_floor).max(offset);
        protected_tail_start = index.clamp_ordinal(protected_tail_start);
    }

    // Runtime floors, semantic snapping, and the newest-message guard can each move a previously
    // safe candidate. Pairing is the final boundary invariant, so re-fence after all of them.
    protected_tail_start =
        fence_boundary_for_completed_tool_arcs(protected_tail_start, arcs, offset);

    let per_run_cap = select_per_run_cap(
        usage_percentage,
        scaled_n,
        ctx.context_limit,
        ctx.execute_threshold_percentage,
    );
    let head = apply_head_cap(HeadCapArgs {
        index,
        protected_tail_start,
        offset,
        arcs,
        cap_tokens: per_run_cap,
        recent_open_arc_cutoff,
    });
    fenced_by_open_arc |= head.fenced_by_open_arc;

    BoundaryResolution {
        protected_start_ordinal: protected_tail_start,
        eligible_head: offset..head.eligible_end_ordinal,
        n_tokens: scaled_n,
        floored_by_live_prompt,
        fenced_by_open_arc,
        true_raw_eligible_tokens: index.range_tokens(offset, protected_tail_start),
        oversize_atomic_unit: head.oversize_atomic_unit,
        raw_message_count,
        boundary_reason,
    }
}

/// Resolve the fixed keep watermark for an explicit session wrapup.
///
/// The watermark counts messages of every role. Safety adjustments may move it earlier,
/// retaining more than `keep`, but never later. This keeps tool invocations atomic and
/// leaves the newest message, including its complete tool arc, in the verbatim tail.
///
/// `context_limit` and `execute_threshold_percentage` are the session's resolved
/// geometry. They feed the same trigger-budget derivation the normal boundary uses, so
/// the user-boundary snap window scales with the actual model window and effective
/// threshold instead of a synthetic constant.
pub fn resolve_wrapup_boundary(
    messages: &[BoundaryMsg],
    last_compartment_end_ordinal: Option<u64>,
    keep: usize,
    context_limit: f64,
    execute_threshold_percentage: f64,
) -> WrapupBoundaryResolution {
    let index = TokenIndex::new(messages);
    let raw_message_count = index.raw_message_count;
    let offset = compartment_offset(last_compartment_end_ordinal, messages).unwrap_or(1);
    let mut live_ordinals = messages
        .iter()
        .map(|message| message.message_ordinal)
        .filter(|ordinal| *ordinal >= offset)
        .collect::<Vec<_>>();
    live_ordinals.sort_unstable();
    live_ordinals.dedup();
    let raw_messages_above_last_compartment = live_ordinals.len();
    let keep = keep.max(1);
    if live_ordinals.is_empty() {
        return WrapupBoundaryResolution {
            boundary: BoundaryResolution {
                protected_start_ordinal: offset,
                eligible_head: offset..offset,
                n_tokens: keep as f64,
                floored_by_live_prompt: false,
                fenced_by_open_arc: false,
                true_raw_eligible_tokens: 0.0,
                oversize_atomic_unit: false,
                raw_message_count,
                boundary_reason: "manual-wrapup-empty".to_string(),
            },
            raw_messages_above_last_compartment: 0,
            target_protected_start_ordinal: offset,
        };
    }

    let mut boundary_reason = if live_ordinals.len() <= keep {
        "manual-wrapup-within-keep"
    } else {
        "manual-wrapup-keep-watermark"
    }
    .to_string();
    let mut protected_tail_start = if live_ordinals.len() <= keep {
        offset
    } else {
        live_ordinals[live_ordinals.len() - keep]
    };

    if live_ordinals.len() > keep {
        let arcs = build_tool_arcs(messages);
        let fenced = fence_wrapup_boundary_for_tool_arcs(protected_tail_start, &arcs, offset);
        if fenced != protected_tail_start {
            boundary_reason = "manual-wrapup-tool-arc".to_string();
        }
        protected_tail_start = fenced;

        let trigger_budget = derive_trigger_budget(context_limit, execute_threshold_percentage);
        let snapped = snap_wrapup_boundary_to_user(
            messages,
            &index,
            protected_tail_start,
            offset,
            trigger_budget,
        );
        if snapped != protected_tail_start {
            boundary_reason = "manual-wrapup-user-snap".to_string();
        }
        protected_tail_start = snapped;

        let refenced = fence_wrapup_boundary_for_tool_arcs(protected_tail_start, &arcs, offset);
        if refenced != protected_tail_start {
            boundary_reason = "manual-wrapup-tool-arc".to_string();
        }
        protected_tail_start = refenced;

        // A keep value of one still cannot make the latest tool result's invocation
        // eligible. The normal verbatim-tail guard defines the same protected floor.
        protected_tail_start =
            protected_tail_start.min(newest_message_protected_floor(&arcs, &index));
    }

    protected_tail_start = protected_tail_start.max(offset);
    protected_tail_start = index.clamp_ordinal(protected_tail_start);
    WrapupBoundaryResolution {
        boundary: BoundaryResolution {
            protected_start_ordinal: protected_tail_start,
            eligible_head: offset..protected_tail_start,
            n_tokens: keep as f64,
            floored_by_live_prompt: false,
            fenced_by_open_arc: false,
            true_raw_eligible_tokens: index.range_tokens(offset, protected_tail_start),
            oversize_atomic_unit: false,
            raw_message_count,
            boundary_reason,
        },
        raw_messages_above_last_compartment,
        target_protected_start_ordinal: protected_tail_start,
    }
}

/// Measure TC-chunked content for a message range.
pub fn chunked_message_estimate(
    messages: &[BoundaryMsg],
    start_ordinal: u64,
    eligible_end_ordinal: Option<u64>,
    budget_stop: f64,
) -> ChunkEstimate {
    let mut token_estimator = estimate_tokens;
    chunked_message_estimate_with_estimator(
        messages,
        start_ordinal,
        eligible_end_ordinal,
        budget_stop,
        &mut token_estimator,
    )
}

fn chunked_message_estimate_with_estimator(
    messages: &[BoundaryMsg],
    start_ordinal: u64,
    eligible_end_ordinal: Option<u64>,
    budget_stop: f64,
    token_estimator: &mut dyn FnMut(&str) -> usize,
) -> ChunkEstimate {
    let mut ordered = messages.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|message| message.message_ordinal);
    let mut completed_components: Vec<CompletedComponent> = Vec::new();
    for arc in build_tool_arcs(messages) {
        let Some(end) = arc.res_ordinal else {
            continue;
        };
        if let Some(component) = completed_components.last_mut() {
            if arc.inv_ordinal <= component.end {
                component.end = component.end.max(end);
                continue;
            }
        }
        completed_components.push(CompletedComponent {
            start: arc.inv_ordinal,
            end,
        });
    }
    let mut builder = ChunkBuilder::new(budget_stop, token_estimator, completed_components);

    for message in &ordered {
        if eligible_end_ordinal.is_some_and(|end| message.message_ordinal >= end) {
            break;
        }
        if message.message_ordinal < start_ordinal {
            continue;
        }
        if !builder.accepts_ordinal(message.message_ordinal) {
            builder.stopped_early = true;
            break;
        }
        if !builder.push_message(message) {
            break;
        }
        builder.pin_component_when_formatted_budget_crosses(message.message_ordinal);
    }
    builder.finish()
}

/// Check whether a compartment/historian run should fire from the in-memory tail.
///
/// This performs the authoritative scan of the provided messages. No persistent
/// metadata pre-filter is present here: a pre-filter can only skip work, while
/// this pure unit already has the in-memory tail needed for the full decision.
pub fn check_compartment_trigger(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
) -> TriggerDecision {
    if ctx.compartment_in_progress {
        return no_fire(HistorianNoFireCause::HistorianAlreadyInProgress);
    }
    let index = TokenIndex::calibrated(messages, ctx.boundary.calibration);
    let mut token_estimator = estimate_tokens;
    check_compartment_trigger_with_index(messages, ctx, &index, &mut token_estimator)
}

pub(crate) fn check_compartment_trigger_with_token_estimator(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
    token_estimator: &mut dyn FnMut(&str) -> usize,
) -> TriggerDecision {
    if ctx.compartment_in_progress {
        return no_fire(HistorianNoFireCause::HistorianAlreadyInProgress);
    }
    let index = TokenIndex::calibrated(messages, ctx.boundary.calibration);
    check_compartment_trigger_with_index(messages, ctx, &index, token_estimator)
}

/// A historian suffix retains projection restart context at/before applied
/// coverage. Tokens before the eligibility floor cannot contribute to a chunk:
/// when the size walk exhausts this suffix, the runtime floor wins instead.
/// Keep that logical floor even when system-only rows have been filtered out.
pub(crate) fn check_compartment_trigger_tail_with_token_estimator(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
    token_estimator: &mut dyn FnMut(&str) -> usize,
) -> TriggerDecision {
    let mut index = TokenIndex::calibrated(messages, ctx.boundary.calibration);
    if let Some(covered) = ctx.boundary.last_compartment_end_ordinal {
        index.first_ordinal = index.first_ordinal.min(covered.saturating_add(1));
    }
    check_compartment_trigger_with_index(messages, ctx, &index, token_estimator)
}

#[cfg(test)]
pub(crate) fn check_compartment_trigger_retokenized_reference(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
) -> TriggerDecision {
    if ctx.compartment_in_progress {
        return no_fire(HistorianNoFireCause::HistorianAlreadyInProgress);
    }
    let index = TokenIndex::new_retokenized(messages);
    let mut token_estimator = estimate_tokens;
    check_compartment_trigger_with_index(messages, ctx, &index, &mut token_estimator)
}

fn check_compartment_trigger_with_index(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
    index: &TokenIndex,
    token_estimator: &mut dyn FnMut(&str) -> usize,
) -> TriggerDecision {
    check_compartment_trigger_prepared(messages, ctx, index, token_estimator, None, None)
}

fn check_compartment_trigger_prepared(
    messages: &[BoundaryMsg],
    ctx: &TriggerContext,
    index: &TokenIndex,
    token_estimator: &mut dyn FnMut(&str) -> usize,
    arcs: Option<&[ToolArc]>,
    chunks: Option<&async_cache::ChunkCache>,
) -> TriggerDecision {
    let trigger_budget = ctx.boundary.trigger_budget.unwrap_or_else(|| {
        derive_trigger_budget(
            ctx.boundary.context_limit,
            ctx.boundary.execute_threshold_percentage,
        )
    });
    let offset =
        compartment_offset(ctx.boundary.last_compartment_end_ordinal, messages).unwrap_or(1);
    let has_live_at_or_after_offset = index.raw_message_count > 0 && index.last_ordinal >= offset;
    if !has_live_at_or_after_offset {
        return no_fire(HistorianNoFireCause::NoLiveMessageAtOrAfterOffset);
    }

    let mut primary_ctx = ctx.boundary.clone();
    primary_ctx.trigger_budget = Some(trigger_budget);
    primary_ctx.emergency_tail_scale = None;
    let boundary = if let Some(arcs) = arcs {
        resolve_protected_tail_boundary_prepared(messages, &primary_ctx, index, arcs)
    } else {
        resolve_protected_tail_boundary_with_index(messages, &primary_ctx, index)
    };
    let has_protected_eligible_head =
        boundary.eligible_head.start < boundary.protected_start_ordinal;

    let source_ratio = ctx
        .boundary
        .calibration
        .map_or(1.0, |s| s.prose_ratio.max(s.tools_ratio));
    let scan_budget = (MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE
        .max(trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER)
        / source_ratio)
        .floor();
    let mut chunk = if has_protected_eligible_head {
        chunks
            .and_then(|cache| {
                cache.estimate(
                    messages,
                    boundary.eligible_head.start,
                    Some(boundary.protected_start_ordinal),
                    scan_budget,
                    token_estimator,
                )
            })
            .unwrap_or_else(|| {
                chunked_message_estimate_with_estimator(
                    messages,
                    boundary.eligible_head.start,
                    Some(boundary.protected_start_ordinal),
                    scan_budget,
                    token_estimator,
                )
            })
    } else {
        ChunkEstimate {
            tokens: 0.0,
            has_more: false,
            formatted_blocks: Vec::new(),
            block_tokens: Vec::new(),
            message_count: 0,
            commit_cluster_count: 0,
        }
    };
    chunk.tokens = (chunk.tokens * source_ratio).ceil();
    let progress = TriggerProgress {
        eligible_start_ordinal: boundary.eligible_head.start,
        eligible_chunk_tokens: chunk.tokens,
        tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER,
        n_tokens: boundary.n_tokens,
        protected_start_ordinal: boundary.protected_start_ordinal,
    };
    let is_meaningful = chunk.has_more
        || boundary.true_raw_eligible_tokens >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE
        || chunk.tokens >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE
        || chunk.message_count >= MIN_PROACTIVE_TAIL_MESSAGE_COUNT;
    let relative_post_drop_target =
        ctx.boundary.execute_threshold_percentage * POST_DROP_TARGET_RATIO;

    let force_materialization_percentage =
        escalation_bands(ctx.boundary.execute_threshold_percentage).force_materialize_percentage;
    if ctx.boundary.usage_percentage >= force_materialization_percentage {
        if ctx.reclaim_ride_available
            && ctx
                .projected_post_drop_percentage
                .is_some_and(|pct| pct <= relative_post_drop_target)
        {
            return no_fire_with_progress(
                HistorianNoFireCause::ProjectedPostDropSatisfied,
                progress,
            );
        }
        if has_runnable_compartment_window(
            &boundary,
            ctx.boundary.usage_percentage,
            ctx.boundary.execute_threshold_percentage,
            None,
        ) {
            return fire_with_progress(TriggerReason::ForceBand, &boundary, progress);
        }
        let scale = if ctx.boundary.usage_percentage >= BLOCK_UNTIL_DONE_PERCENTAGE {
            0.25
        } else {
            0.5
        };
        let mut scaled_ctx = primary_ctx;
        scaled_ctx.emergency_tail_scale = Some(scale);
        let scaled_boundary = if let Some(arcs) = arcs {
            resolve_protected_tail_boundary_prepared(messages, &scaled_ctx, index, arcs)
        } else {
            resolve_protected_tail_boundary_with_index(messages, &scaled_ctx, index)
        };
        if has_runnable_compartment_window(
            &scaled_boundary,
            ctx.boundary.usage_percentage,
            ctx.boundary.execute_threshold_percentage,
            Some(scale),
        ) {
            return fire_with_progress(TriggerReason::ForceBand, &scaled_boundary, progress);
        }
        return no_fire_with_progress(HistorianNoFireCause::ProtectedTailWindowEmpty, progress);
    }

    if ctx.commit_cluster_trigger_enabled
        && chunk.commit_cluster_count >= ctx.min_commit_clusters
        && chunk.tokens >= trigger_budget
    {
        return fire_with_progress(TriggerReason::CommitClusters, &boundary, progress.clone());
    }

    if chunk.tokens >= trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER
        || (chunk.has_more && chunk.tokens > 0.0)
    {
        return fire_with_progress(TriggerReason::TailSize, &boundary, progress);
    }

    let proactive_trigger_percentage =
        get_proactive_compartment_trigger_percentage(ctx.boundary.execute_threshold_percentage);
    if ctx.boundary.usage_percentage < proactive_trigger_percentage {
        return no_fire_with_progress(HistorianNoFireCause::BelowProactiveFloor, progress);
    }

    if ctx.reclaim_ride_available
        && ctx
            .projected_post_drop_percentage
            .is_some_and(|pct| pct <= relative_post_drop_target)
    {
        return no_fire_with_progress(HistorianNoFireCause::ProjectedPostDropSatisfied, progress);
    }

    if !has_protected_eligible_head {
        return no_fire_with_progress(HistorianNoFireCause::ProtectedTailWindowEmpty, progress);
    }
    if !is_meaningful {
        return no_fire_with_progress(HistorianNoFireCause::BelowMinimumEligibleContent, progress);
    }

    fire_with_progress(TriggerReason::ProjectedHeadroom, &boundary, progress)
}

fn no_fire(cause: HistorianNoFireCause) -> TriggerDecision {
    TriggerDecision {
        fire: false,
        reason: None,
        no_fire_cause: Some(cause),
        consume_through_ordinal: None,
        boundary: None,
        progress: None,
    }
}

fn no_fire_with_progress(
    cause: HistorianNoFireCause,
    progress: TriggerProgress,
) -> TriggerDecision {
    TriggerDecision {
        progress: Some(progress),
        ..no_fire(cause)
    }
}

fn fire(reason: TriggerReason, boundary: &BoundaryResolution) -> TriggerDecision {
    let consume_through_ordinal = if boundary.eligible_head.end > boundary.eligible_head.start {
        Some(boundary.eligible_head.end - 1)
    } else {
        None
    };
    TriggerDecision {
        fire: true,
        reason: Some(reason),
        no_fire_cause: None,
        consume_through_ordinal,
        boundary: Some(boundary.clone()),
        progress: None,
    }
}

fn fire_with_progress(
    reason: TriggerReason,
    boundary: &BoundaryResolution,
    progress: TriggerProgress,
) -> TriggerDecision {
    TriggerDecision {
        progress: Some(progress),
        ..fire(reason, boundary)
    }
}

fn clamp_percentage(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn get_proactive_compartment_trigger_percentage(execute_threshold_percentage: f64) -> f64 {
    (execute_threshold_percentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE).max(0.0)
}

fn derive_min_force_eligible_tokens(scaled_n: f64) -> f64 {
    MIN_FORCE_ELIGIBLE_TOKENS_CAP.min((scaled_n / 8.0).floor().max(1.0))
}

fn non_emergency_per_run_cap(usable: f64, n: f64) -> f64 {
    NON_EMERGENCY_MAX_CAP.min((2.0 * n).max((0.25 * usable).round().min(100_000.0)))
}

fn force80_per_run_cap(usable: f64, n: f64) -> f64 {
    FORCE80_MAX_CAP.min((3.0 * n).max((0.35 * usable).round().min(150_000.0)))
}

fn force95_per_run_cap(usable: f64, n: f64) -> f64 {
    FORCE95_MAX_CAP.min((4.0 * n).max((0.5 * usable).round().min(250_000.0)))
}

fn select_per_run_cap(
    usage_percentage: f64,
    n: f64,
    context_limit: f64,
    execute_threshold_percentage: f64,
) -> f64 {
    let usable = ((context_limit * execute_threshold_percentage) / 100.0)
        .round()
        .max(1.0);
    if usage_percentage >= BLOCK_UNTIL_DONE_PERCENTAGE {
        force95_per_run_cap(usable, n)
    // Capacity sizing deliberately retains its historical 80% tier. For execute
    // thresholds from 84% through 90%, this cap no longer coincides with the
    // derived force-band transition.
    } else if usage_percentage >= FORCE80_CAP_TIER_PERCENTAGE {
        force80_per_run_cap(usable, n)
    } else {
        non_emergency_per_run_cap(usable, n)
    }
}

fn has_runnable_compartment_window(
    boundary: &BoundaryResolution,
    usage_percentage: f64,
    execute_threshold_percentage: f64,
    emergency_tail_scale: Option<f64>,
) -> bool {
    if boundary.eligible_head.start >= boundary.protected_start_ordinal {
        return false;
    }
    let force_materialization_percentage =
        escalation_bands(execute_threshold_percentage).force_materialize_percentage;
    if usage_percentage >= force_materialization_percentage || emergency_tail_scale.is_some() {
        boundary.true_raw_eligible_tokens >= derive_min_force_eligible_tokens(boundary.n_tokens)
            || boundary.eligible_head.end > boundary.eligible_head.start
    } else {
        boundary.eligible_head.end > boundary.eligible_head.start
    }
}

#[derive(Debug)]
struct TokenIndex {
    raw_message_count: u64,
    first_ordinal: u64,
    last_ordinal: u64,
    terminal_ordinal: u64,
    ordinals: Vec<u64>,
    prefix: Vec<f64>,
    tokens_by_ordinal: HashMap<u64, f64>,
}

impl TokenIndex {
    fn new(messages: &[BoundaryMsg]) -> Self {
        Self::from_block_tokens(messages, |block| block.original_token_count as f64)
    }

    fn calibrated(
        messages: &[BoundaryMsg],
        seed: Option<crate::decision_calibration::DecisionCalibration>,
    ) -> Self {
        let Some(seed) = seed else {
            return Self::new(messages);
        };
        Self::from_block_tokens(messages, |block| {
            let ratio = match block.kind {
                SelKind::ToolCall { .. } | SelKind::ToolResult { .. } => seed.tools_ratio,
                SelKind::Media => 1.0,
                _ => seed.prose_ratio,
            };
            block.original_token_count as f64 * ratio
        })
    }

    #[cfg(test)]
    fn new_retokenized(messages: &[BoundaryMsg]) -> Self {
        Self::from_block_tokens(messages, |block| estimate_tokens(&block.original) as f64)
    }

    fn from_block_tokens(
        messages: &[BoundaryMsg],
        mut block_tokens: impl FnMut(&BoundaryBlock) -> f64,
    ) -> Self {
        #[cfg(test)]
        TOKEN_INDEX_ROWS.with(|count| count.set(count.get() + messages.len()));
        let mut totals_by_ordinal = BTreeMap::new();
        for message in messages {
            let total = message.blocks.iter().map(&mut block_tokens).sum::<f64>();
            *totals_by_ordinal
                .entry(message.message_ordinal)
                .or_insert(0.0) += total;
        }

        let ordinals: Vec<u64> = totals_by_ordinal.keys().copied().collect();
        let first_ordinal = ordinals.first().copied().unwrap_or(1);
        let last_ordinal = ordinals.last().copied().unwrap_or(0);
        let terminal_ordinal = ordinals
            .last()
            .map(|ordinal| ordinal.saturating_add(1))
            .unwrap_or(1);
        let mut prefix = Vec::with_capacity(ordinals.len() + 1);
        prefix.push(0.0);
        let mut tokens_by_ordinal = HashMap::new();
        for ordinal in &ordinals {
            let total = totals_by_ordinal.get(ordinal).copied().unwrap_or(0.0);
            tokens_by_ordinal.insert(*ordinal, total);
            let previous = prefix.last().copied().unwrap_or(0.0);
            prefix.push(previous + total);
        }

        Self {
            raw_message_count: ordinals.len() as u64,
            first_ordinal,
            last_ordinal,
            terminal_ordinal,
            ordinals,
            prefix,
            tokens_by_ordinal,
        }
    }

    fn token_for_ordinal(&self, ordinal: u64) -> f64 {
        self.tokens_by_ordinal.get(&ordinal).copied().unwrap_or(0.0)
    }

    fn total_tokens(&self) -> f64 {
        self.prefix.last().copied().unwrap_or(0.0)
    }

    fn lower_bound(&self, ordinal: u64) -> usize {
        self.ordinals
            .partition_point(|candidate| *candidate < ordinal)
    }

    fn exclusive_end_for_prefix_index(&self, index: usize) -> u64 {
        if index == 0 {
            self.first_ordinal
        } else {
            self.ordinals[index - 1].saturating_add(1)
        }
    }

    fn clamp_ordinal(&self, ordinal: u64) -> u64 {
        if self.ordinals.is_empty() {
            return ordinal;
        }
        ordinal.max(self.first_ordinal).min(self.terminal_ordinal)
    }

    fn suffix_tokens_from_ordinal(&self, ordinal: u64) -> f64 {
        if self.ordinals.is_empty() {
            return 0.0;
        }
        if ordinal <= self.first_ordinal {
            return self.total_tokens();
        }
        if ordinal >= self.terminal_ordinal {
            return 0.0;
        }
        let start_index = self.lower_bound(ordinal);
        self.total_tokens() - self.prefix[start_index]
    }

    fn range_tokens(&self, start_inclusive: u64, end_exclusive: u64) -> f64 {
        if self.ordinals.is_empty() || end_exclusive <= start_inclusive {
            return 0.0;
        }
        let start = start_inclusive.max(self.first_ordinal);
        let end = end_exclusive.max(start).min(self.terminal_ordinal);
        if end <= start {
            return 0.0;
        }
        let start_index = self.lower_bound(start);
        let end_index = self.lower_bound(end);
        if end_index <= start_index {
            return 0.0;
        }
        self.prefix[end_index] - self.prefix[start_index]
    }

    fn find_suffix_start_for_tokens(&self, tokens: f64) -> u64 {
        if self.ordinals.is_empty() {
            return 1;
        }
        if !tokens.is_finite() || tokens <= 0.0 {
            return self.terminal_ordinal;
        }
        let target = tokens.floor().max(0.0);
        let total = self.total_tokens();
        if total < target {
            return self.first_ordinal;
        }
        let cut = total - target;
        let mut lo = 0_usize;
        let mut hi = self.prefix.len() - 1;
        let mut best = 0_usize;
        while lo <= hi {
            let mid = (lo + hi) >> 1;
            if self.prefix[mid] <= cut {
                best = mid;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        self.ordinals
            .get(best)
            .copied()
            .unwrap_or(self.terminal_ordinal)
    }

    fn find_head_end_for_cap(
        &self,
        start_inclusive: u64,
        end_exclusive: u64,
        cap_tokens: f64,
    ) -> u64 {
        if self.ordinals.is_empty() {
            return start_inclusive;
        }
        let start = start_inclusive
            .max(self.first_ordinal)
            .min(self.terminal_ordinal);
        let end = end_exclusive.max(start).min(self.terminal_ordinal);
        if !cap_tokens.is_finite() || cap_tokens <= 0.0 {
            return start;
        }
        let start_index = self.lower_bound(start);
        let end_index = self.lower_bound(end);
        if start_index >= end_index {
            return start;
        }
        let start_prefix = self.prefix[start_index];
        let cut = start_prefix + cap_tokens.floor();
        let mut lo = start_index;
        let mut hi = end_index;
        let mut best_index = start_index;
        while lo <= hi {
            let mid = (lo + hi) >> 1;
            if self.prefix[mid] <= cut {
                best_index = mid;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        if best_index == start_index {
            return self.ordinals[start_index].saturating_add(1).min(end);
        }
        self.exclusive_end_for_prefix_index(best_index).min(end)
    }
}

#[cfg(test)]
thread_local! {
    pub(crate) static TOKEN_INDEX_ROWS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Debug, Clone)]
struct ToolArc {
    inv_ordinal: u64,
    res_ordinal: Option<u64>,
}

/// True when a tail beginning at `boundary` would retain a completed result without its call.
/// Every boundary rule uses this predicate so signed-reasoning protection and ordinary tool
/// pairing cannot disagree about whether an arc is whole.
pub(crate) fn completed_tool_arc_crosses_boundary(
    inv_ordinal: u64,
    res_ordinal: u64,
    boundary: u64,
) -> bool {
    inv_ordinal < boundary && boundary <= res_ordinal
}

fn build_tool_arcs(messages: &[BoundaryMsg]) -> Vec<ToolArc> {
    #[derive(Default)]
    struct PartialArc {
        inv: Vec<u64>,
        res: Vec<u64>,
    }

    let mut partial: BTreeMap<String, PartialArc> = BTreeMap::new();
    for message in messages {
        for block in &message.blocks {
            if block.provider_executed {
                continue;
            }
            let Some(arc_id) = &block.arc_id else {
                continue;
            };
            let entry = partial.entry(arc_id.clone()).or_default();
            match &block.kind {
                SelKind::ToolCall { .. } => entry.inv.push(message.message_ordinal),
                SelKind::ToolResult { .. } => entry.res.push(message.message_ordinal),
                _ => {}
            }
        }
    }

    let mut arcs = Vec::new();
    for (_arc_id, mut entry) in partial {
        entry.inv.sort_unstable();
        entry.res.sort_unstable();
        for inv in entry.inv {
            let res_pos = entry.res.iter().position(|res| *res >= inv);
            let res_ordinal = res_pos.map(|idx| entry.res.remove(idx));
            arcs.push(ToolArc {
                inv_ordinal: inv,
                res_ordinal,
            });
        }
    }
    arcs.sort_by(|a, b| {
        a.inv_ordinal.cmp(&b.inv_ordinal).then_with(|| {
            a.res_ordinal
                .unwrap_or(u64::MAX)
                .cmp(&b.res_ordinal.unwrap_or(u64::MAX))
        })
    });
    arcs
}

/// Return the earliest ordinal that must stay in the protected tail so the newest message and its
/// whole tool arc are never folded into a compartment.
fn newest_message_protected_floor(arcs: &[ToolArc], index: &TokenIndex) -> u64 {
    let last = index.last_ordinal;
    arcs.iter()
        .filter(|arc| arc.inv_ordinal == last || arc.res_ordinal == Some(last))
        .map(|arc| arc.inv_ordinal)
        .min()
        .unwrap_or(last)
}

#[derive(Debug, Clone, Copy)]
struct FenceResult {
    boundary: u64,
    open_arc: bool,
}

fn fence_boundary_for_completed_tool_arcs(candidate: u64, arcs: &[ToolArc], floor: u64) -> u64 {
    let completed = arcs
        .iter()
        .filter_map(|arc| arc.res_ordinal.map(|result| (arc.inv_ordinal, result)))
        .collect::<Vec<_>>();
    let mut component = completed
        .iter()
        .copied()
        .filter(|(invocation, result)| {
            completed_tool_arc_crosses_boundary(*invocation, *result, candidate)
        })
        .collect::<Vec<_>>();
    if component.is_empty() {
        return candidate;
    }

    // Overlapping arcs form one atomic interval: moving to either edge of only the first arc could
    // cut a neighbor. Expand the whole component before choosing its safe side.
    for _ in 0..=completed.len() {
        let min_invocation = component
            .iter()
            .map(|(invocation, _)| *invocation)
            .min()
            .unwrap_or(candidate);
        let max_result = component
            .iter()
            .map(|(_, result)| *result)
            .max()
            .unwrap_or(candidate);
        let previous_len = component.len();
        for arc in &completed {
            if arc.0 <= max_result && arc.1 >= min_invocation && !component.contains(arc) {
                component.push(*arc);
            }
        }
        if component.len() == previous_len {
            break;
        }
    }

    let min_invocation = component
        .iter()
        .map(|(invocation, _)| *invocation)
        .min()
        .unwrap_or(candidate);
    let max_result = component
        .iter()
        .map(|(_, result)| *result)
        .max()
        .unwrap_or(candidate);
    if min_invocation < floor {
        // An invocation below the publication floor is already summarized. Moving backward cannot
        // reunite that pair, so close the entire overlapping component forward instead.
        max_result.saturating_add(1)
    } else {
        min_invocation
    }
}

fn fence_boundary_for_tool_arcs(
    candidate: u64,
    arcs: &[ToolArc],
    publication_floor_ordinal: u64,
    recent_open_arc_cutoff: u64,
) -> FenceResult {
    let mut boundary =
        fence_boundary_for_completed_tool_arcs(candidate, arcs, publication_floor_ordinal);
    let mut open_arc = false;
    for arc in arcs {
        if arc.res_ordinal.is_some() || arc.inv_ordinal < recent_open_arc_cutoff {
            continue;
        }
        if (arc.inv_ordinal >= publication_floor_ordinal && arc.inv_ordinal < boundary)
            || arc.inv_ordinal >= boundary
        {
            boundary = arc.inv_ordinal;
            open_arc = true;
            break;
        }
    }
    // An open-arc adjustment can move the cut into an overlapping completed arc. Reapply the
    // same whole-arc predicate to the final candidate rather than trusting iteration order.
    boundary = fence_boundary_for_completed_tool_arcs(boundary, arcs, publication_floor_ordinal);
    FenceResult { boundary, open_arc }
}

fn fence_wrapup_boundary_for_tool_arcs(candidate: u64, arcs: &[ToolArc], offset: u64) -> u64 {
    let mut boundary = candidate;
    for _ in 0..=arcs.len() {
        let mut next = boundary;
        for arc in arcs {
            let Some(result) = arc.res_ordinal else {
                // Interrupted invocations older than the watermark cannot pin every later
                // wrapup. Open invocations already in the retained tail need no adjustment.
                continue;
            };
            if arc.inv_ordinal >= offset && arc.inv_ordinal < next && next <= result {
                next = arc.inv_ordinal;
            }
        }
        if next == boundary {
            break;
        }
        boundary = next;
    }
    boundary
}

fn snap_wrapup_boundary_to_user(
    messages: &[BoundaryMsg],
    index: &TokenIndex,
    candidate: u64,
    offset: u64,
    trigger_budget: f64,
) -> u64 {
    if candidate <= offset {
        return candidate;
    }
    let snap_token_limit = trigger_budget.clamp(2_000.0, 48_000.0);
    let mut ordered = messages.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|message| std::cmp::Reverse(message.message_ordinal));
    for message in ordered {
        if message.message_ordinal > candidate || message.message_ordinal < offset {
            continue;
        }
        if message.role != Role::User || !has_meaningful_user_text(&message.blocks) {
            continue;
        }
        return if index.range_tokens(message.message_ordinal, candidate) <= snap_token_limit {
            message.message_ordinal
        } else {
            candidate
        };
    }
    candidate
}

fn semantic_snap_boundary(
    messages: &[BoundaryMsg],
    index: &TokenIndex,
    candidate: u64,
    scaled_n: f64,
    publication_floor_ordinal: u64,
) -> u64 {
    let mut ordered: Vec<&BoundaryMsg> = messages.iter().collect();
    ordered.sort_by_key(|message| message.message_ordinal);
    let mut snapped = candidate;
    for message in &ordered {
        if message.message_ordinal > candidate {
            break;
        }
        if message.message_ordinal < publication_floor_ordinal {
            continue;
        }
        if !is_semantic_boundary_candidate(message) {
            continue;
        }
        snapped = message.message_ordinal;
    }
    if snapped == candidate {
        return candidate;
    }
    let extra_tokens =
        index.suffix_tokens_from_ordinal(snapped) - index.suffix_tokens_from_ordinal(candidate);
    if extra_tokens > (1.5 * scaled_n).round().min(48_000.0) {
        return candidate;
    }
    let snapped_is_huge_user = ordered.iter().any(|message| {
        message.message_ordinal == snapped
            && message.role == Role::User
            && index.token_for_ordinal(snapped) > (2.0 * scaled_n).max(64_000.0)
    });
    if snapped_is_huge_user {
        return candidate;
    }
    snapped
}

fn is_semantic_boundary_candidate(message: &BoundaryMsg) -> bool {
    if message.role == Role::User && has_meaningful_user_text(&message.blocks) {
        return true;
    }
    message.blocks.iter().any(|block| {
        matches!(
            block.kind,
            SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
        )
    })
}

#[derive(Debug)]
struct HeadCapArgs<'a> {
    index: &'a TokenIndex,
    protected_tail_start: u64,
    offset: u64,
    arcs: &'a [ToolArc],
    cap_tokens: f64,
    recent_open_arc_cutoff: u64,
}

#[derive(Debug, Clone, Copy)]
struct HeadCapResult {
    eligible_end_ordinal: u64,
    oversize_atomic_unit: bool,
    fenced_by_open_arc: bool,
}

fn apply_head_cap(args: HeadCapArgs<'_>) -> HeadCapResult {
    if args.offset >= args.protected_tail_start {
        return HeadCapResult {
            eligible_end_ordinal: args.offset,
            oversize_atomic_unit: false,
            fenced_by_open_arc: false,
        };
    }
    let mut end =
        args.index
            .find_head_end_for_cap(args.offset, args.protected_tail_start, args.cap_tokens);
    let mut oversize_atomic_unit =
        end == args.offset + 1 && args.index.token_for_ordinal(args.offset) > args.cap_tokens;
    let mut completed_fence = fence_boundary_for_completed_tool_arcs(end, args.arcs, args.offset);
    // Keep a leading completed component whole when the cap cuts through it.
    // The protected-tail bound, open-arc clamp, and final re-fence still apply.
    if completed_fence <= args.offset && end > args.offset {
        let after_first =
            fence_boundary_for_completed_tool_arcs(end, args.arcs, args.offset.saturating_add(1));
        if after_first <= args.protected_tail_start {
            completed_fence = after_first;
        }
    }
    if completed_fence > end {
        end = completed_fence.min(args.protected_tail_start);
        if args.index.range_tokens(args.offset, end) > args.cap_tokens {
            oversize_atomic_unit = true;
        }
    } else {
        end = completed_fence;
    }
    let mut fenced_by_open_arc = false;
    for arc in args.arcs {
        if arc.res_ordinal.is_some() {
            continue;
        }
        if arc.inv_ordinal >= args.recent_open_arc_cutoff
            && arc.inv_ordinal >= args.offset
            && arc.inv_ordinal < end
        {
            end = end.min(arc.inv_ordinal);
            fenced_by_open_arc = true;
        }
    }
    end = fence_boundary_for_completed_tool_arcs(end, args.arcs, args.offset);
    if end <= args.offset && args.offset < args.protected_tail_start {
        return HeadCapResult {
            eligible_end_ordinal: args.offset,
            oversize_atomic_unit,
            fenced_by_open_arc,
        };
    }
    HeadCapResult {
        eligible_end_ordinal: end.min(args.protected_tail_start),
        oversize_atomic_unit,
        fenced_by_open_arc,
    }
}

#[derive(Debug, Clone)]
struct ChunkBlock {
    role: String,
    start_ordinal: u64,
    end_ordinal: u64,
    parts: Vec<String>,
    meta: Vec<(u64, String)>,
    commit_hashes: Vec<String>,
    is_tool_only: bool,
}

#[derive(Debug, Clone, Copy)]
struct CompletedComponent {
    start: u64,
    end: u64,
}

struct ChunkBuilder<'a> {
    budget_stop: f64,
    token_estimator: &'a mut dyn FnMut(&str) -> usize,
    total_tokens: f64,
    messages_processed: usize,
    current_block: Option<ChunkBlock>,
    pending_noise_meta: Vec<(u64, String)>,
    formatted_blocks: Vec<String>,
    block_tokens: Vec<f64>,
    commit_cluster_count: usize,
    last_flushed_role: String,
    stopped_early: bool,
    completed_components: Vec<CompletedComponent>,
    admitted_oversize_component_end: Option<u64>,
    current_block_approx_tokens: f64,
    last_appended_part_tokens: f64,
    formatted_budget_crossed: bool,
    captured_blocks: Option<Vec<ChunkBlock>>,
}

impl<'a> ChunkBuilder<'a> {
    fn new(
        budget_stop: f64,
        token_estimator: &'a mut dyn FnMut(&str) -> usize,
        completed_components: Vec<CompletedComponent>,
    ) -> Self {
        Self {
            budget_stop,
            token_estimator,
            total_tokens: 0.0,
            messages_processed: 0,
            current_block: None,
            pending_noise_meta: Vec::new(),
            formatted_blocks: Vec::new(),
            block_tokens: Vec::new(),
            commit_cluster_count: 0,
            last_flushed_role: String::new(),
            stopped_early: false,
            completed_components,
            admitted_oversize_component_end: None,
            current_block_approx_tokens: 0.0,
            last_appended_part_tokens: 0.0,
            formatted_budget_crossed: false,
            captured_blocks: None,
        }
    }

    fn accepts_ordinal(&self, ordinal: u64) -> bool {
        self.admitted_oversize_component_end
            .is_none_or(|end| ordinal <= end)
    }

    fn pin_component_when_formatted_budget_crosses(&mut self, ordinal: u64) {
        if self.admitted_oversize_component_end.is_some() || self.formatted_budget_crossed {
            return;
        }
        let Some(block) = self.current_block.as_ref() else {
            return;
        };
        self.current_block_approx_tokens += self.last_appended_part_tokens;
        if self.total_tokens + self.current_block_approx_tokens + 64.0 <= self.budget_stop {
            return;
        }
        let preview_tokens =
            self.total_tokens + (self.token_estimator)(&format_block(block)) as f64;
        if preview_tokens <= self.budget_stop {
            return;
        }
        self.formatted_budget_crossed = true;
        self.admitted_oversize_component_end = self
            .completed_components
            .iter()
            .find(|component| component.start <= ordinal && component.end >= ordinal)
            .map(|component| component.end);
    }

    fn push_message(&mut self, message: &BoundaryMsg) -> bool {
        self.last_appended_part_tokens = 0.0;
        let meta = (message.message_ordinal, message.message_id.clone());
        if message.role == Role::User && !has_meaningful_user_text(&message.blocks) {
            let tc_summaries = extract_tool_call_summaries(&message.blocks);
            if tc_summaries.is_empty() {
                self.pending_noise_meta.push(meta);
                return true;
            }
            let tc_text = tc_summaries.join(" / ");
            let tc_tokens = (self.token_estimator)(&tc_text) as f64;
            if let Some(current) = self
                .current_block
                .as_mut()
                .filter(|block| block.role == "A")
            {
                current.end_ordinal = message.message_ordinal;
                self.last_appended_part_tokens =
                    tc_tokens + if current.parts.is_empty() { 0.0 } else { 1.0 };
                current.parts.push(tc_text);
                current.meta.append(&mut self.pending_noise_meta);
                current.meta.push(meta);
                return true;
            }
            if !self.flush_current_block() {
                return false;
            }
            let start = self
                .pending_noise_meta
                .first()
                .map(|(ordinal, _)| *ordinal)
                .unwrap_or(message.message_ordinal);
            let mut meta_list = std::mem::take(&mut self.pending_noise_meta);
            meta_list.push(meta);
            self.last_appended_part_tokens = tc_tokens;
            self.current_block = Some(ChunkBlock {
                role: "A".to_string(),
                start_ordinal: start,
                end_ordinal: message.message_ordinal,
                parts: vec![tc_text],
                meta: meta_list,
                commit_hashes: Vec::new(),
                is_tool_only: true,
            });
            return true;
        }

        let role = compact_role(message.role.as_str());
        let text_parts = text_parts(message);
        let tool_summaries = if text_parts.is_empty() {
            extract_tool_call_summaries(&message.blocks)
        } else {
            Vec::new()
        };
        let mut all_parts = text_parts.clone();
        all_parts.extend(tool_summaries);
        let compacted = compact_text_for_summary(&all_parts.join(" / "), message.role.as_str());
        let text = compacted.text;
        if text.is_empty() {
            self.pending_noise_meta.push(meta);
            return true;
        }
        let msg_has_narrative = !text_parts.is_empty();
        let text_tokens = (self.token_estimator)(&text) as f64;
        if let Some(current) = self
            .current_block
            .as_mut()
            .filter(|block| block.role == role)
        {
            current.end_ordinal = message.message_ordinal;
            self.last_appended_part_tokens =
                text_tokens + if current.parts.is_empty() { 0.0 } else { 1.0 };
            current.parts.push(text);
            current.meta.append(&mut self.pending_noise_meta);
            current.meta.push(meta);
            current.commit_hashes =
                merge_commit_hashes(&current.commit_hashes, &compacted.commit_hashes);
            if msg_has_narrative {
                current.is_tool_only = false;
            }
            return true;
        }

        if !self.flush_current_block() {
            return false;
        }
        let start = self
            .pending_noise_meta
            .first()
            .map(|(ordinal, _)| *ordinal)
            .unwrap_or(message.message_ordinal);
        let mut meta_list = std::mem::take(&mut self.pending_noise_meta);
        meta_list.push(meta);
        self.last_appended_part_tokens = text_tokens;
        self.current_block = Some(ChunkBlock {
            role,
            start_ordinal: start,
            end_ordinal: message.message_ordinal,
            parts: vec![text],
            meta: meta_list,
            commit_hashes: compacted.commit_hashes,
            is_tool_only: !msg_has_narrative,
        });
        true
    }

    fn flush_current_block(&mut self) -> bool {
        let Some(current_block) = self.current_block.take() else {
            return true;
        };
        let block_text = format_block(&current_block);
        let block_tokens = (self.token_estimator)(&block_text) as f64;
        if self.total_tokens + block_tokens > self.budget_stop && self.total_tokens > 0.0 {
            self.current_block = Some(current_block);
            self.stopped_early = true;
            return false;
        }
        if current_block.role == "A"
            && !current_block.commit_hashes.is_empty()
            && self.last_flushed_role != "A"
        {
            self.commit_cluster_count += 1;
        }
        self.last_flushed_role.clone_from(&current_block.role);
        if let Some(blocks) = &mut self.captured_blocks {
            blocks.push(current_block.clone());
        }
        self.messages_processed += current_block.meta.len();
        self.formatted_blocks.push(block_text);
        self.block_tokens.push(block_tokens);
        self.total_tokens += block_tokens;
        self.current_block_approx_tokens = 0.0;
        true
    }

    fn finish(mut self) -> ChunkEstimate {
        let _ = self.flush_current_block();
        // Only a rejected formatted block proves the scan ran out of budget.
        // The final raw ordinal may belong to filtered tool results, ignored text,
        // or reasoning; comparing it with the last emitted ordinal invents content.
        let has_more = self.stopped_early;
        let tokens = self.total_tokens;
        ChunkEstimate {
            tokens,
            has_more,
            formatted_blocks: self.formatted_blocks,
            block_tokens: self.block_tokens,
            message_count: self.messages_processed,
            commit_cluster_count: self.commit_cluster_count,
        }
    }
}

#[derive(Debug, Clone)]
struct CompactedText {
    text: String,
    commit_hashes: Vec<String>,
}

fn has_meaningful_user_text(blocks: &[BoundaryBlock]) -> bool {
    blocks.iter().any(|block| {
        if block.ignored || !matches!(block.kind, SelKind::Text) {
            return false;
        }
        let cleaned = clean_user_text(&block.original);
        !cleaned.trim().is_empty() && !is_system_directive(&cleaned)
    })
}

fn text_parts(message: &BoundaryMsg) -> Vec<String> {
    message
        .blocks
        .iter()
        .filter_map(|block| {
            if block.ignored || !matches!(block.kind, SelKind::Text) {
                return None;
            }
            let text = block.original.trim();
            if text.is_empty() {
                return None;
            }
            let cleaned = if message.role == Role::User {
                clean_user_text(text)
            } else {
                text.to_string()
            };
            let normalized = normalize_text(&cleaned);
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        })
        .collect()
}

fn extract_tool_call_summaries(blocks: &[BoundaryBlock]) -> Vec<String> {
    let mut summaries = Vec::new();
    for block in blocks {
        let SelKind::ToolCall { name, input } = &block.kind else {
            continue;
        };
        if let Some(description) = input
            .get("description")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            summaries.push(format!("TC: {description}"));
            continue;
        }
        let key_arg = extract_key_arg(input);
        if let Some(key_arg) = key_arg {
            summaries.push(format!("TC: {name}({key_arg})"));
        } else {
            summaries.push(format!("TC: {name}"));
        }
    }
    summaries
}

fn extract_key_arg(input: &Value) -> Option<String> {
    let object = input.as_object()?;
    for key in ["filePath", "path", "pattern", "query"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            return Some(truncate_arg(value));
        }
    }
    for key in ["symbol", "module", "action"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            return Some(value.to_string());
        }
    }
    None
}

fn truncate_arg(value: &str) -> String {
    truncate_utf16(value, 60)
}

/// The TypeScript lane's `value.length <= max ? value : value.slice(0, max) + "…"`, which
/// counts UTF-16 code units: a character outside the Basic Multilingual Plane (most
/// emoji) counts as two. Where that slice would end between the two halves of such a
/// character, JavaScript keeps a lone high surrogate, which a Rust string cannot hold;
/// the whole character is left out instead, so the text is one unit shorter there.
pub(crate) fn truncate_utf16(value: &str, max_units: usize) -> String {
    if value.encode_utf16().count() <= max_units {
        return value.to_string();
    }
    let mut units = 0;
    let mut out = String::new();
    for ch in value.chars() {
        units += ch.len_utf16();
        if units > max_units {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn clean_user_text(text: &str) -> String {
    let without_reminders = system_reminder_regex().replace_all(text, "");
    without_reminders
        .replace(OMO_INTERNAL_INITIATOR_MARKER, "")
        .trim()
        .to_string()
}

fn is_system_directive(text: &str) -> bool {
    text.trim_start().starts_with(SYSTEM_DIRECTIVE_PREFIX)
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compact_role(role: &str) -> String {
    match role {
        "assistant" => "A".to_string(),
        "user" => "U".to_string(),
        _ => role
            .chars()
            .next()
            .map(|ch| ch.to_uppercase().collect::<String>())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "M".to_string()),
    }
}

fn format_block(block: &ChunkBlock) -> String {
    let range = if block.start_ordinal == block.end_ordinal {
        format!("[{}]", block.start_ordinal)
    } else {
        format!("[{}-{}]", block.start_ordinal, block.end_ordinal)
    };
    let commit_suffix = if block.commit_hashes.is_empty() {
        String::new()
    } else {
        format!(" commits: {}", block.commit_hashes.join(", "))
    };
    format!(
        "{} {}:{} {}",
        range,
        block.role,
        commit_suffix,
        block.parts.join(" / ")
    )
}

fn extract_commit_hashes(text: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    for capture in commit_hash_extract_regex().captures_iter(text) {
        let Some(hash) = capture.get(1).map(|value| value.as_str().to_lowercase()) else {
            continue;
        };
        if hashes.contains(&hash) {
            continue;
        }
        hashes.push(hash);
        if hashes.len() >= MAX_COMMITS_PER_BLOCK {
            break;
        }
    }
    hashes
}

fn compact_text_for_summary(text: &str, role: &str) -> CompactedText {
    let commit_hashes = if role == "assistant" {
        extract_commit_hashes(text)
    } else {
        Vec::new()
    };
    if commit_hashes.is_empty() || !commit_verb_regex().is_match(text) {
        return CompactedText {
            text: text.to_string(),
            commit_hashes,
        };
    }
    let without_hashes = commit_hash_extract_regex().replace_all(text, "");
    let without_hashes = empty_parens_regex().replace_all(&without_hashes, "");
    let without_hashes = space_before_comma_regex().replace_all(&without_hashes, ",");
    let without_hashes = repeated_comma_regex().replace_all(&without_hashes, ", ");
    let without_hashes = repeated_space_regex().replace_all(&without_hashes, " ");
    let without_hashes = space_before_punct_regex().replace_all(&without_hashes, "$1");
    let trimmed = without_hashes.trim();
    CompactedText {
        text: if trimmed.is_empty() {
            text.to_string()
        } else {
            trimmed.to_string()
        },
        commit_hashes,
    }
}

fn merge_commit_hashes(existing: &[String], next: &[String]) -> Vec<String> {
    if next.is_empty() {
        return existing.to_vec();
    }
    let mut merged = existing.to_vec();
    for hash in next {
        if merged.contains(hash) {
            continue;
        }
        merged.push(hash.clone());
        if merged.len() >= MAX_COMMITS_PER_BLOCK {
            break;
        }
    }
    merged
}

fn system_reminder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<system-reminder>[\s\S]*?</system-reminder>").unwrap())
}

fn commit_hash_extract_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // ASCII word boundaries and ASCII case folding, as in the TypeScript twin
    // (shared/commit-detection.ts): JavaScript's `\b` and `/i` without the `u` flag.
    // With Unicode boundaries a hash right after a letter such as `é` was not found.
    RE.get_or_init(|| Regex::new(r"(?i-u)`?\b([0-9a-f]{7,12})\b`?").unwrap())
}

fn commit_verb_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            // ASCII boundaries and case folding, as in the TypeScript twin; Unicode `(?i)`
            // would also fold U+017F to "s" and the Kelvin sign to "k".
            r"(?i-u)\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b",
        )
        .unwrap()
    })
}

fn empty_parens_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\s*\)").unwrap())
}

fn space_before_comma_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+,").unwrap())
}

fn repeated_comma_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r",\s*,+").unwrap())
}

fn repeated_space_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s{2,}").unwrap())
}

fn space_before_punct_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+([,.;:])").unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// The TypeScript lane's commit patterns use JavaScript's ASCII `\b`: a hash or a
    /// commit verb next to a non-ASCII letter still counts, and these are its answers.
    #[test]
    fn commit_patterns_use_ascii_word_boundaries_like_the_typescript_lane() {
        assert_eq!(
            extract_commit_hashes("committed é1a2b3c4d"),
            vec!["1a2b3c4d".to_string()]
        );
        assert_eq!(
            extract_commit_hashes("see 1a2b3c4dé"),
            vec!["1a2b3c4d".to_string()]
        );
        assert!(commit_verb_regex().is_match("ücommitted 1a2b3c4d"));
        // ASCII letters and digits still join a word, so these are not hashes or verbs.
        assert!(extract_commit_hashes("x1a2b3c4d").is_empty());
        assert!(!commit_verb_regex().is_match("recommitted"));
    }

    /// The TypeScript lane truncates a key argument at 60 UTF-16 code units, so 40 emoji
    /// (80 units) are cut to 30.
    #[test]
    fn key_arguments_are_truncated_in_utf16_units_like_the_typescript_lane() {
        let emoji = "😀".repeat(40);
        assert_eq!(truncate_arg(&emoji), format!("{}…", "😀".repeat(30)));
        let ascii = "a".repeat(60);
        assert_eq!(truncate_arg(&ascii), ascii);
        assert_eq!(
            truncate_arg(&"a".repeat(61)),
            format!("{}…", "a".repeat(60))
        );
        // A cut that would split a surrogate pair leaves the whole character out.
        let odd = format!("a{}", "😀".repeat(40));
        assert_eq!(truncate_arg(&odd), format!("a{}…", "😀".repeat(29)));
    }

    /// Commit detection uses ASCII word boundaries and ASCII case folding, as JavaScript's
    /// non-Unicode `\b` and `/i` do in the TypeScript twin.
    #[test]
    fn commit_detection_uses_ascii_boundaries_like_typescript() {
        assert_eq!(
            extract_commit_hashes("committed \u{e9}1a2b3c4d"),
            vec!["1a2b3c4d".to_string()]
        );
        assert!(!commit_verb_regex().is_match("reba\u{17f}ed 1a2b3c4d"));
        assert!(!commit_verb_regex().is_match("cherry-pic\u{212a} 1a2b3c4d"));
        assert!(commit_verb_regex().is_match("Rebased 1a2b3c4d"));
    }

    #[derive(Deserialize)]
    struct GoldenRoot {
        constants: BTreeMap<String, f64>,
        chunk_cases: Vec<ChunkCase>,
        boundary_cases: Vec<BoundaryCase>,
        trigger_cases: Vec<TriggerCase>,
        completed_arc_fence_cases: Vec<CompletedArcFenceCase>,
    }

    #[derive(Deserialize)]
    struct ChunkCase {
        label: String,
        messages: Vec<MessageJson>,
        budget_stop: f64,
        expected: ChunkExpected,
    }

    #[derive(Deserialize)]
    struct ChunkExpected {
        formatted_blocks: Vec<String>,
        block_tokens: Vec<f64>,
        tokens: f64,
        has_more: bool,
        message_count: usize,
        commit_cluster_count: usize,
    }

    #[derive(Deserialize)]
    struct BoundaryCase {
        label: String,
        messages: Vec<MessageJson>,
        ctx: BoundaryCtxJson,
        expected: BoundaryExpected,
    }

    #[derive(Deserialize)]
    struct BoundaryExpected {
        protected_start_ordinal: u64,
        eligible_head_start: u64,
        eligible_head_end: u64,
        n_tokens: f64,
        floored_by_live_prompt: bool,
        fenced_by_open_arc: bool,
        true_raw_eligible_tokens: f64,
        oversize_atomic_unit: bool,
    }

    #[derive(Deserialize)]
    struct CompletedArcFenceCase {
        label: String,
        candidate: u64,
        publication_floor_ordinal: u64,
        arcs: Vec<CompletedArcJson>,
        expected: u64,
    }

    #[derive(Deserialize)]
    struct CompletedArcJson {
        #[serde(rename = "invOrdinal")]
        inv_ordinal: u64,
        #[serde(rename = "resOrdinal")]
        res_ordinal: Option<u64>,
    }

    #[derive(Deserialize)]
    struct TriggerCase {
        label: String,
        messages: Vec<MessageJson>,
        ctx: TriggerCtxJson,
        expected: TriggerExpected,
    }

    #[derive(Deserialize)]
    struct TriggerExpected {
        fire: bool,
        reason: Option<String>,
        consume_through_ordinal: Option<u64>,
    }

    #[derive(Deserialize)]
    struct TriggerCtxJson {
        boundary: BoundaryCtxJson,
        compartment_in_progress: bool,
        projected_post_drop_percentage: Option<f64>,
        commit_cluster_trigger_enabled: bool,
        min_commit_clusters: usize,
    }

    #[derive(Deserialize)]
    struct BoundaryCtxJson {
        context_limit: f64,
        execute_threshold_percentage: f64,
        usage_percentage: f64,
        usage_input_tokens: f64,
        last_compartment_end_ordinal: Option<u64>,
        prior_boundary_ordinal: u64,
        migration_floor_active: bool,
        emergency_tail_scale: Option<f64>,
        trigger_budget: Option<f64>,
    }

    #[derive(Deserialize)]
    struct MessageJson {
        message_ordinal: u64,
        message_id: String,
        role: String,
        blocks: Vec<BlockJson>,
    }

    #[derive(Deserialize)]
    struct BlockJson {
        id: String,
        ordinal: u64,
        kind: Value,
        provider_executed: bool,
        byte_size: usize,
        arc_id: Option<String>,
        original: String,
        rendered: Option<String>,
        ignored: Option<bool>,
    }

    fn parse_kind(value: &Value) -> SelKind {
        if let Some(s) = value.as_str() {
            return match s {
                "Reasoning" => SelKind::Reasoning,
                "Text" => SelKind::Text,
                "RedactedReasoning" => SelKind::RedactedReasoning,
                "Media" => SelKind::Media,
                _ => SelKind::Opaque,
            };
        }
        if let Some(obj) = value.as_object() {
            if let Some(tc) = obj.get("ToolCall") {
                return SelKind::ToolCall {
                    name: tc
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    input: tc.get("input").cloned().unwrap_or(Value::Null),
                };
            }
            if let Some(tr) = obj.get("ToolResult") {
                return SelKind::ToolResult {
                    tool_name: tr
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                };
            }
        }
        SelKind::Opaque
    }

    fn messages(json: &[MessageJson]) -> Vec<BoundaryMsg> {
        json.iter()
            .map(|message| BoundaryMsg {
                message_ordinal: message.message_ordinal,
                message_id: message.message_id.clone(),
                role: Role::from_provider(&message.role),
                blocks: message
                    .blocks
                    .iter()
                    .map(|block| BoundaryBlock {
                        id: block.id.clone(),
                        ordinal: block.ordinal,
                        kind: parse_kind(&block.kind),
                        provider_executed: block.provider_executed,
                        byte_size: block.byte_size,
                        arc_id: block.arc_id.clone(),
                        original: Arc::from(block.original.clone()),
                        original_token_count: estimate_tokens(&block.original),
                        rendered: block.rendered.clone(),
                        ignored: block.ignored.unwrap_or(false),
                    })
                    .collect(),
            })
            .collect()
    }

    fn boundary_ctx(json: &BoundaryCtxJson) -> BoundaryContext {
        BoundaryContext {
            calibration: None,
            context_limit: json.context_limit,
            execute_threshold_percentage: json.execute_threshold_percentage,
            usage_percentage: json.usage_percentage,
            usage_input_tokens: json.usage_input_tokens,
            last_compartment_end_ordinal: json.last_compartment_end_ordinal,
            prior_boundary_ordinal: json.prior_boundary_ordinal,
            migration_floor_active: json.migration_floor_active,
            emergency_tail_scale: json.emergency_tail_scale,
            trigger_budget: json.trigger_budget,
            fold_is_only_reclaim: false,
        }
    }

    fn golden() -> GoldenRoot {
        serde_json::from_str(include_str!("../testdata/boundary-golden.json"))
            .expect("parse boundary-golden.json")
    }

    fn assert_const(constants: &BTreeMap<String, f64>, name: &str, value: f64) {
        let got = constants
            .get(name)
            .unwrap_or_else(|| panic!("missing constant {name}"));
        assert!(
            (got - value).abs() < f64::EPSILON,
            "constant {name} drifted: TS={got} Rust={value}"
        );
    }

    #[test]
    fn issue_424_head_cap_matches_typescript_differential_cases() {
        #[derive(Deserialize)]
        struct FixtureSet {
            _comment: String,
            cases: Vec<Case>,
        }
        #[derive(Deserialize)]
        struct Case {
            label: String,
            tokens: Vec<usize>,
            offset: u64,
            protected_tail_start: u64,
            cap_tokens: f64,
            recent_open_arc_cutoff: u64,
            arcs: Vec<CaseArc>,
            expected_end: u64,
            expected_oversize: bool,
        }
        #[derive(Deserialize)]
        struct CaseArc {
            #[serde(rename = "invOrdinal")]
            inv_ordinal: u64,
            #[serde(rename = "resOrdinal")]
            res_ordinal: Option<u64>,
            result_shape: Option<String>,
        }

        let fixture_set: FixtureSet =
            serde_json::from_str(include_str!("../testdata/issue-424-head-cap.json"))
                .expect("head-cap differential cases");
        for case in fixture_set.cases {
            let mut messages = case
                .tokens
                .iter()
                .enumerate()
                .map(|(i, tokens)| {
                    let mut message = text_msg(i as u64 + 1, Role::Assistant, "fixture");
                    message.blocks[0].original_token_count = *tokens;
                    message
                })
                .collect::<Vec<_>>();
            for (arc_index, arc) in case.arcs.iter().enumerate() {
                let arc_id = format!("fixture-call-{arc_index}");
                let call_original: Arc<str> = Arc::from(
                    serde_json::json!({
                        "type": "tool",
                        "callID": arc_id,
                        "state": { "input": { "fixture": true } }
                    })
                    .to_string(),
                );
                messages
                    .iter_mut()
                    .find(|message| message.message_ordinal == arc.inv_ordinal)
                    .expect("fixture invocation ordinal")
                    .blocks
                    .push(BoundaryBlock {
                        id: format!("fixture-call-block-{arc_index}"),
                        ordinal: 10_000 + arc_index as u64 * 2,
                        kind: SelKind::ToolCall {
                            name: "fixture".to_string(),
                            input: serde_json::json!({ "fixture": true }),
                        },
                        provider_executed: false,
                        byte_size: call_original.len(),
                        arc_id: Some(arc_id.clone()),
                        original: call_original,
                        original_token_count: 0,
                        rendered: None,
                        ignored: false,
                    });
                let Some(result_ordinal) = arc.res_ordinal else {
                    continue;
                };
                let result_original: Arc<str> = Arc::from(
                    match arc.result_shape.as_deref() {
                        Some("error") => serde_json::json!({
                            "type": "tool",
                            "callID": arc_id,
                            "state": { "status": "error", "error": "fixture error" }
                        }),
                        Some("empty") => serde_json::json!({
                            "type": "tool",
                            "callID": arc_id,
                            "state": { "status": "completed", "output": "" }
                        }),
                        _ => serde_json::json!({
                            "type": "tool",
                            "callID": arc_id,
                            "state": { "status": "completed", "output": "fixture" }
                        }),
                    }
                    .to_string(),
                );
                messages
                    .iter_mut()
                    .find(|message| message.message_ordinal == result_ordinal)
                    .expect("fixture result ordinal")
                    .blocks
                    .push(BoundaryBlock {
                        id: format!("fixture-result-block-{arc_index}"),
                        ordinal: 10_001 + arc_index as u64 * 2,
                        kind: SelKind::ToolResult {
                            tool_name: "fixture".to_string(),
                        },
                        provider_executed: false,
                        byte_size: result_original.len(),
                        arc_id: Some(arc_id),
                        original: result_original,
                        original_token_count: 0,
                        rendered: None,
                        ignored: false,
                    });
            }
            let index = TokenIndex::new(&messages);
            let arcs = build_tool_arcs(&messages);
            let actual_arcs = arcs
                .iter()
                .map(|arc| (arc.inv_ordinal, arc.res_ordinal))
                .collect::<Vec<_>>();
            let expected_arcs = case
                .arcs
                .iter()
                .map(|arc| (arc.inv_ordinal, arc.res_ordinal))
                .collect::<Vec<_>>();
            assert_eq!(actual_arcs, expected_arcs, "{} ingress arcs", case.label);
            let head = apply_head_cap(HeadCapArgs {
                index: &index,
                offset: case.offset,
                protected_tail_start: case.protected_tail_start,
                arcs: &arcs,
                cap_tokens: case.cap_tokens,
                recent_open_arc_cutoff: case.recent_open_arc_cutoff,
            });
            assert_eq!(
                head.eligible_end_ordinal, case.expected_end,
                "{}",
                case.label
            );
            assert_eq!(
                head.oversize_atomic_unit, case.expected_oversize,
                "{}",
                case.label
            );
            for arc in &arcs {
                if let Some(result) = arc.res_ordinal {
                    assert!(
                        !completed_tool_arc_crosses_boundary(
                            arc.inv_ordinal,
                            result,
                            head.eligible_end_ordinal
                        ),
                        "{}",
                        case.label
                    );
                }
            }
        }
    }

    #[test]
    fn completed_arc_fence_matches_typescript_golden() {
        for case in golden().completed_arc_fence_cases {
            let arcs = case
                .arcs
                .into_iter()
                .map(|arc| ToolArc {
                    inv_ordinal: arc.inv_ordinal,
                    res_ordinal: arc.res_ordinal,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                fence_boundary_for_completed_tool_arcs(
                    case.candidate,
                    &arcs,
                    case.publication_floor_ordinal,
                ),
                case.expected,
                "{}",
                case.label
            );
        }
    }

    #[test]
    fn boundary_constants_match_ts_sources() {
        let constants = golden().constants;
        assert_const(&constants, "ALPHA", ALPHA);
        assert_const(&constants, "FLOOR_RATIO", FLOOR_RATIO);
        assert_const(&constants, "FLOOR_MIN", FLOOR_MIN);
        assert_const(&constants, "FLOOR_MAX", FLOOR_MAX);
        assert_const(&constants, "ABS_CAP", ABS_CAP);
        assert_const(&constants, "MAX_USABLE_RATIO", MAX_USABLE_RATIO);
        assert_const(&constants, "RESERVED_HEADROOM_MIN", RESERVED_HEADROOM_MIN);
        assert_const(
            &constants,
            "RESERVED_HEADROOM_RATIO",
            RESERVED_HEADROOM_RATIO,
        );
        assert_const(&constants, "NON_EMERGENCY_MAX_CAP", NON_EMERGENCY_MAX_CAP);
        assert_const(&constants, "FORCE80_MAX_CAP", FORCE80_MAX_CAP);
        assert_const(&constants, "FORCE95_MAX_CAP", FORCE95_MAX_CAP);
        assert_const(
            &constants,
            "NORMAL_HYSTERESIS_TOKENS",
            NORMAL_HYSTERESIS_TOKENS,
        );
        assert_const(
            &constants,
            "MIN_FORCE_ELIGIBLE_TOKENS_CAP",
            MIN_FORCE_ELIGIBLE_TOKENS_CAP,
        );
        assert_const(
            &constants,
            "TRIGGER_BUDGET_PERCENTAGE",
            TRIGGER_BUDGET_PERCENTAGE,
        );
        assert_const(&constants, "TRIGGER_BUDGET_MIN", TRIGGER_BUDGET_MIN);
        assert_const(&constants, "TRIGGER_BUDGET_MAX", TRIGGER_BUDGET_MAX);
        assert_const(
            &constants,
            "PROACTIVE_TRIGGER_OFFSET_PERCENTAGE",
            PROACTIVE_TRIGGER_OFFSET_PERCENTAGE,
        );
        assert_const(&constants, "POST_DROP_TARGET_RATIO", POST_DROP_TARGET_RATIO);
        assert_const(
            &constants,
            "MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE",
            MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE,
        );
        assert_const(
            &constants,
            "MIN_PROACTIVE_TAIL_MESSAGE_COUNT",
            MIN_PROACTIVE_TAIL_MESSAGE_COUNT as f64,
        );
        assert_const(
            &constants,
            "DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER",
            DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER as f64,
        );
        assert_const(
            &constants,
            "TAIL_SIZE_TRIGGER_MULTIPLIER",
            TAIL_SIZE_TRIGGER_MULTIPLIER,
        );
        assert_const(
            &constants,
            "BLOCK_UNTIL_DONE_PERCENTAGE",
            BLOCK_UNTIL_DONE_PERCENTAGE,
        );
        assert_const(
            &constants,
            "MAX_COMMITS_PER_BLOCK",
            MAX_COMMITS_PER_BLOCK as f64,
        );
    }

    #[test]
    fn chunk_golden_matches_ts_formatting() {
        for case in golden().chunk_cases {
            let msgs = messages(&case.messages);
            let estimate = chunked_message_estimate(&msgs, 1, None, case.budget_stop);
            assert_eq!(
                estimate.formatted_blocks, case.expected.formatted_blocks,
                "formatted block mismatch in {}",
                case.label
            );
            assert_eq!(
                estimate.block_tokens, case.expected.block_tokens,
                "block tokens in {}",
                case.label
            );
            assert_eq!(
                estimate.tokens, case.expected.tokens,
                "tokens in {}",
                case.label
            );
            assert_eq!(
                estimate.has_more, case.expected.has_more,
                "has_more in {}",
                case.label
            );
            assert_eq!(
                estimate.message_count, case.expected.message_count,
                "message_count in {}",
                case.label
            );
            assert_eq!(
                estimate.commit_cluster_count, case.expected.commit_cluster_count,
                "commit clusters in {}",
                case.label
            );
        }
    }

    #[test]
    fn boundary_golden_matches_ts_resolution() {
        for case in golden().boundary_cases {
            let msgs = messages(&case.messages);
            let got = resolve_protected_tail_boundary(&msgs, &boundary_ctx(&case.ctx));
            assert_eq!(
                got.protected_start_ordinal, case.expected.protected_start_ordinal,
                "protected start in {}",
                case.label
            );
            assert_eq!(
                got.eligible_head.start, case.expected.eligible_head_start,
                "eligible start in {}",
                case.label
            );
            assert_eq!(
                got.eligible_head.end, case.expected.eligible_head_end,
                "eligible end in {}",
                case.label
            );
            assert_eq!(got.n_tokens, case.expected.n_tokens, "N in {}", case.label);
            assert_eq!(
                got.floored_by_live_prompt, case.expected.floored_by_live_prompt,
                "live floor in {}",
                case.label
            );
            assert_eq!(
                got.fenced_by_open_arc, case.expected.fenced_by_open_arc,
                "open fence in {}",
                case.label
            );
            assert_eq!(
                got.true_raw_eligible_tokens, case.expected.true_raw_eligible_tokens,
                "true raw eligible in {}",
                case.label
            );
            assert_eq!(
                got.oversize_atomic_unit, case.expected.oversize_atomic_unit,
                "oversize in {}",
                case.label
            );
        }
    }

    #[test]
    fn trigger_golden_matches_ts_decision_core() {
        for case in golden().trigger_cases {
            let msgs = messages(&case.messages);
            let ctx = TriggerContext {
                boundary: boundary_ctx(&case.ctx.boundary),
                compartment_in_progress: case.ctx.compartment_in_progress,
                projected_post_drop_percentage: case.ctx.projected_post_drop_percentage,
                reclaim_ride_available: true,
                commit_cluster_trigger_enabled: case.ctx.commit_cluster_trigger_enabled,
                min_commit_clusters: case.ctx.min_commit_clusters,
            };
            let got = check_compartment_trigger(&msgs, &ctx);
            assert_eq!(got.fire, case.expected.fire, "fire in {}", case.label);
            assert_eq!(
                got.reason.map(TriggerReason::as_str).map(str::to_string),
                case.expected.reason,
                "reason in {}",
                case.label
            );
            assert_eq!(
                got.consume_through_ordinal, case.expected.consume_through_ordinal,
                "consume through in {}",
                case.label
            );
        }
    }

    fn text_msg(ord: u64, role: Role, text: &str) -> BoundaryMsg {
        BoundaryMsg {
            message_ordinal: ord,
            message_id: format!("m-{ord}"),
            role,
            blocks: vec![BoundaryBlock {
                id: format!("m-{ord}#text"),
                ordinal: ord,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: text.len(),
                arc_id: None,
                original: Arc::from(text),
                original_token_count: estimate_tokens(text),
                rendered: None,
                ignored: false,
            }],
        }
    }

    fn tool_call_msg(ord: u64, arc_id: &str) -> BoundaryMsg {
        BoundaryMsg {
            message_ordinal: ord,
            message_id: format!("m-{ord}"),
            role: Role::Assistant,
            blocks: vec![BoundaryBlock {
                id: format!("{arc_id}#call"),
                ordinal: ord,
                kind: SelKind::ToolCall {
                    name: "bash".to_string(),
                    input: serde_json::json!({"description":"run build"}),
                },
                provider_executed: false,
                byte_size: 32,
                arc_id: Some(arc_id.to_string()),
                original: Arc::from("{\"description\":\"run build\"}"),
                original_token_count: estimate_tokens("{\"description\":\"run build\"}"),
                rendered: None,
                ignored: false,
            }],
        }
    }

    fn reasoning_tool_call_msg(ord: u64, arc_id: &str) -> BoundaryMsg {
        let mut message = tool_call_msg(ord, arc_id);
        message.blocks.insert(
            0,
            BoundaryBlock {
                id: format!("{arc_id}#reasoning"),
                ordinal: ord,
                kind: SelKind::Reasoning,
                provider_executed: false,
                byte_size: 16,
                arc_id: Some(arc_id.to_string()),
                original: Arc::from("signed reasoning"),
                original_token_count: estimate_tokens("signed reasoning"),
                rendered: None,
                ignored: false,
            },
        );
        message
    }

    fn tool_result_msg(ord: u64, arc_id: &str, text: &str) -> BoundaryMsg {
        BoundaryMsg {
            message_ordinal: ord,
            message_id: format!("m-{ord}"),
            role: Role::User,
            blocks: vec![BoundaryBlock {
                id: format!("{arc_id}#result"),
                ordinal: ord,
                kind: SelKind::ToolResult {
                    tool_name: "bash".to_string(),
                },
                provider_executed: false,
                byte_size: text.len(),
                arc_id: Some(arc_id.to_string()),
                original: Arc::from(text),
                original_token_count: estimate_tokens(text),
                rendered: None,
                ignored: false,
            }],
        }
    }

    fn completed_newest_tool_arc_tail() -> Vec<BoundaryMsg> {
        vec![
            text_msg(1, Role::Assistant, &"head ".repeat(600)),
            tool_call_msg(2, "arc-newest"),
            tool_result_msg(3, "arc-newest", &"tool result ".repeat(2_500)),
        ]
    }

    /// Synthetic sensitivity fixture, not a replay of a captured provider session.
    /// Each admission is assumed to publish successfully before the next step; the
    /// pure trigger has no mid-turn input, so publication coalescing cannot help it.
    #[test]
    fn twenty_step_tool_cadence_without_mid_turn_coalescing() {
        assert_eq!(derive_trigger_budget(167_000.0, 65.0), 5_428.0);
        assert_eq!(derive_trigger_budget(872_000.0, 75.0), 32_700.0);
        let output = "build output line with useful diagnostic details\n".repeat(500);
        for (label, limit, threshold) in [
            ("CC-T65", 167_000.0, 65.0),
            ("CC-T75", 167_000.0, 75.0),
            ("OC-T75", 872_000.0, 75.0),
        ] {
            println!("{label}: boundary.context_limit={limit}, threshold={threshold}, pre_clamp={}, rounded_clamped={}, tail_bar={}", limit * threshold / 100.0 * 0.05, derive_trigger_budget(limit, threshold), derive_trigger_budget(limit, threshold) * 3.0);
            for policy in [
                "HOLD-mid_turn-false",
                "rewrite-at-most-4x",
                "raw-since-publish-20k",
                "budget-min-10k",
            ] {
                let mut messages = Vec::new();
                let mut ctx = TriggerContext {
                    boundary: BoundaryContext {
                        calibration: None,
                        context_limit: limit,
                        execute_threshold_percentage: threshold,
                        usage_percentage: 75.0,
                        usage_input_tokens: limit * 0.75,
                        ..BoundaryContext::default()
                    },
                    ..TriggerContext::default()
                };
                if policy == "budget-min-10k" {
                    ctx.boundary.trigger_budget =
                        Some(derive_trigger_budget(limit, threshold).max(10_000.0));
                }
                let mut publications = Vec::new();
                let mut total_rewrite = 0;
                let mut total_raw = 0;
                println!("geometry,step,reason,start,end,messages,raw_tokens,tc_tokens,m1_tokens,tail_tokens,rewrite_tokens,rewrite_per_raw");
                for step in 1..=20 {
                    // The 2/4/6/8-message cycle models one to four complete tool arcs.
                    for _ in 0..((step - 1) % 4 + 1) {
                        let ordinal = messages.len() as u64 + 1;
                        let arc = format!("arc-{ordinal}");
                        messages.push(tool_call_msg(ordinal, &arc));
                        messages.push(tool_result_msg(ordinal + 1, &arc, &output));
                    }
                    let decision = check_compartment_trigger(&messages, &ctx);
                    if !decision.fire {
                        continue;
                    }
                    let boundary = decision.boundary.as_ref().unwrap();
                    let start = boundary.eligible_head.start;
                    let end = decision.consume_through_ordinal.unwrap();
                    assert!(end < boundary.protected_start_ordinal);
                    assert!(ctx
                        .boundary
                        .last_compartment_end_ordinal
                        .is_none_or(|last| start > last));
                    let raw: usize = messages
                        .iter()
                        .filter(|m| (start..=end).contains(&m.message_ordinal))
                        .flat_map(|m| &m.blocks)
                        .map(|b| b.original_token_count)
                        .sum();
                    let chunk =
                        chunked_message_estimate(&messages, start, Some(end + 1), 100_000.0);
                    let formatted_tokens: f64 = chunk.block_tokens.iter().sum();
                    assert!(formatted_tokens < derive_trigger_budget(limit, threshold));
                    // Price a hypothetical next-wire rewrite, not provider billing:
                    // fixed 8k prefix before m1, initial 2k m1, 256 tokens per summary,
                    // and constant 75% pre-publication usage with no other reducers.
                    let m1 = 2_000 + 256 * (publications.len() + 1);
                    let rewrite = (limit * 0.75) as usize - 8_000 - raw + 256;
                    let tail = rewrite - m1;
                    let force = ctx.boundary.usage_percentage
                        >= escalation_bands(threshold).force_materialize_percentage;
                    let admitted = force
                        || match policy {
                            "rewrite-at-most-4x" => rewrite <= 4 * raw,
                            "raw-since-publish-20k" => raw >= 20_000,
                            _ => true,
                        };
                    if !admitted {
                        continue;
                    }
                    total_rewrite += rewrite;
                    total_raw += raw;
                    println!("{label}/{policy},{step},{},{start},{end},{},{raw},{formatted_tokens},{m1},{tail},{rewrite},{:.2}", decision.reason.unwrap().as_str(), end - start + 1, rewrite as f64 / raw as f64);
                    publications.push((step, start, end));
                    ctx.boundary.last_compartment_end_ordinal = Some(end);
                }
                println!("{label}/{policy}: {} assumed publications over 20 steps: {publications:?}; total_raw={total_raw}, total_rewrite={total_rewrite}", publications.len());
                let expected = match (label, policy) {
                    ("OC-T75", "rewrite-at-most-4x") => 0,
                    ("OC-T75", "raw-since-publish-20k") => 6,
                    ("OC-T75", _) => 11,
                    (_, "rewrite-at-most-4x") => 7,
                    (_, "raw-since-publish-20k") => 8,
                    _ => 14,
                };
                assert_eq!(publications.len(), expected, "{label}/{policy}");
            }
        }
    }

    /// Opt-in replay of private captures; only aggregate measurements are printed.
    /// The capture directory stays outside version control because it contains user content.
    #[test]
    #[ignore = "requires CADENCE_REPLAY_DIR with private transform captures"]
    fn captured_tool_cadence_measurements() {
        let root = std::path::PathBuf::from(std::env::var("CADENCE_REPLAY_DIR").unwrap());
        let load = |path: &str| -> Value {
            serde_json::from_slice(&std::fs::read(root.join(path)).unwrap()).unwrap()
        };
        let manifest = load("manifest.json");
        let selected = manifest["selected_publications"].as_array().unwrap();
        let mut prior_coverage = None;
        let mut count = 0;
        for exchange in manifest["exchanges"].as_array().unwrap() {
            let paths = exchange["transform_files"].as_array().unwrap();
            let request = load(paths[0].as_str().unwrap());
            let response = load(paths[2].as_str().unwrap());
            let parsed: crate::transform::TransformRequest =
                serde_json::from_value(request.clone()).unwrap();
            let coverage = response["coverage_ordinal"].as_u64().unwrap();
            if selected.contains(&exchange["exchange"]) {
                count += 1;
                let start = prior_coverage.unwrap() + 1;
                let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
                let cached = crate::boundary_messages(
                    &parsed,
                    &projection,
                    &std::sync::Mutex::new(crate::BoundaryTokenCache::new(16 * 1024 * 1024)),
                );
                let (limit, input, percentage) =
                    crate::usage_numbers(parsed.usage.as_ref(), parsed.geometry.as_ref());
                let chunk = crate::historian_chunk::build_historian_chunk(
                    &parsed.messages,
                    &projection.blocks,
                    start,
                    100_000,
                    coverage + 1,
                );
                let raw: usize = cached
                    .messages
                    .iter()
                    .filter(|m| (start..=coverage).contains(&m.message_ordinal))
                    .flat_map(|m| &m.blocks)
                    .map(|b| b.original_token_count)
                    .sum();
                let raw_bytes: usize = cached
                    .messages
                    .iter()
                    .filter(|m| (start..=coverage).contains(&m.message_ordinal))
                    .flat_map(|m| &m.blocks)
                    .map(|b| b.byte_size)
                    .sum();
                let output = response["ck_messages"].as_array().unwrap();
                let m1_index = output
                    .iter()
                    .position(|m| {
                        m["content"].as_array().unwrap().iter().any(|b| {
                            b["kind"]["text"]
                                .as_str()
                                .is_some_and(|s| s.contains("<session-history-since>"))
                        })
                    })
                    .unwrap();
                let texts = |message: &Value| -> String {
                    message["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| {
                            b["kind"]["text"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| serde_json::to_string(&b["kind"]).unwrap())
                        })
                        .collect::<Vec<_>>()
                        .join("")
                };
                let m1 = texts(&output[m1_index]);
                let tail = output[m1_index + 1..]
                    .iter()
                    .map(texts)
                    .collect::<Vec<_>>()
                    .join("");
                let rewrite_tokens = estimate_tokens(&m1) + estimate_tokens(&tail);
                let native = load(&format!("captures/{}-fwd-body", exchange["exchange"]));
                let native_messages = native["messages"].as_array().unwrap();
                let native_m1 = serde_json::to_string(&native_messages[m1_index]).unwrap();
                assert!(native_m1.contains("<session-history-since>"));
                let native_tail: Vec<String> = native_messages[m1_index + 1..]
                    .iter()
                    .map(|m| serde_json::to_string(m).unwrap())
                    .collect();
                let native_tokens = estimate_tokens(&native_m1)
                    + native_tail
                        .iter()
                        .map(|m| estimate_tokens(m))
                        .sum::<usize>();
                println!("NATIVE exchange={} m1_bytes={} tail_bytes={} rewrite_tokens={native_tokens} ratio={:.2}",exchange["exchange"],native_m1.len(),native_tail.iter().map(String::len).sum::<usize>(),native_tokens as f64 / raw as f64);
                println!("CAPTURE exchange={} range={start}-{coverage} raw_tokens={raw} raw_bytes={raw_bytes} assembly_tokens={} m1_bytes={} tail_bytes={} rewrite_tokens={rewrite_tokens} rewrite_per_raw={:.2} context_limit={limit} usable_soft={} usable_hard={} input={input} pct={percentage:.3} host_threshold={} logged_progress={}", exchange["exchange"], chunk.token_estimate, m1.len(), tail.len(), rewrite_tokens as f64 / raw as f64, request["geometry"]["usable_soft"],request["geometry"]["usable_hard"],request["effective_execute_threshold"],response["historian"]["progress"]);
                for threshold in [65.0, 75.0] {
                    let ctx = TriggerContext {
                        boundary: BoundaryContext {
                            calibration: None,
                            context_limit: limit,
                            execute_threshold_percentage: threshold,
                            usage_percentage: percentage,
                            usage_input_tokens: input,
                            last_compartment_end_ordinal: Some(start - 1),
                            prior_boundary_ordinal: start - 1,
                            migration_floor_active: true,
                            ..BoundaryContext::default()
                        },
                        ..TriggerContext::default()
                    };
                    let decision = check_compartment_trigger(&cached.messages, &ctx);
                    if exchange["exchange"] == 12978 && threshold == 65.0 {
                        assert!(
                            !decision.fire,
                            "captured 12978 must not fire on trailing filtered noise"
                        );
                        assert_eq!(
                            decision.no_fire_cause,
                            Some(HistorianNoFireCause::BelowMinimumEligibleContent)
                        );
                    }
                    let boundary = resolve_protected_tail_boundary(&cached.messages, &ctx.boundary);
                    let measured = chunked_message_estimate(
                        &cached.messages,
                        start,
                        Some(boundary.protected_start_ordinal),
                        derive_trigger_budget(limit, threshold) * 3.0,
                    );
                    println!("REPLAY exchange={} T={threshold} fire={} reason={:?} protected={} raw_eligible={} formatted_tokens={} reported_tokens={} has_more={}",exchange["exchange"],decision.fire, decision.reason,boundary.protected_start_ordinal,boundary.true_raw_eligible_tokens,measured.block_tokens.iter().sum::<f64>(),measured.tokens,measured.has_more);
                }
                assert!(coverage >= start);
                assert!(raw > 0);
            }
            prior_coverage = Some(coverage);
        }
        assert_eq!(count, 6);
    }

    #[test]
    fn queued_drops_without_a_ride_do_not_suppress_a_runnable_historian() {
        let messages = (1..=11)
            .map(|ordinal| text_msg(ordinal, Role::User, &"eligible narrative ".repeat(500)))
            .collect::<Vec<_>>();
        let ctx = TriggerContext {
            boundary: BoundaryContext {
                context_limit: 20_000.0,
                execute_threshold_percentage: 63.0,
                usage_percentage: 61.0,
                usage_input_tokens: 12_200.0,
                ..ctx_for_tests()
            },
            projected_post_drop_percentage: Some(30.0),
            commit_cluster_trigger_enabled: false,
            ..TriggerContext::default()
        };
        let first = check_compartment_trigger(&messages, &ctx);
        assert_eq!(first.reason, Some(TriggerReason::ProjectedHeadroom));
        let with_ride = TriggerContext {
            reclaim_ride_available: true,
            ..ctx.clone()
        };
        assert_eq!(
            check_compartment_trigger(&messages, &with_ride).no_fire_cause,
            Some(HistorianNoFireCause::ProjectedPostDropSatisfied)
        );
        let force = TriggerContext {
            boundary: BoundaryContext {
                usage_percentage: 85.0,
                usage_input_tokens: 17_000.0,
                ..ctx.boundary
            },
            reclaim_ride_available: false,
            ..ctx
        };
        assert_eq!(
            check_compartment_trigger(&messages, &force).reason,
            Some(TriggerReason::ForceBand)
        );
        assert_eq!(
            check_compartment_trigger(
                &messages,
                &TriggerContext {
                    reclaim_ride_available: true,
                    ..force
                }
            )
            .no_fire_cause,
            Some(HistorianNoFireCause::ProjectedPostDropSatisfied)
        );
    }

    #[test]
    fn trailing_filtered_rows_do_not_inflate_chunk_progress() {
        for kind in ["tool-result", "ignored", "reasoning", "all-noise"] {
            let mut tail = vec![
                tool_call_msg(1, "arc"),
                tool_result_msg(2, "arc", "small output"),
            ];
            match kind {
                "ignored" => {
                    tail[1] = text_msg(2, Role::User, "ignored content");
                    tail[1].blocks[0].ignored = true;
                }
                "reasoning" => {
                    tail[1] = text_msg(2, Role::Assistant, "private reasoning");
                    tail[1].blocks[0].kind = SelKind::Reasoning;
                }
                "all-noise" => tail[0].blocks[0].ignored = true,
                _ => {}
            }
            let chunk = chunked_message_estimate(&tail, 1, Some(3), 16_284.0);
            assert!(
                !chunk.has_more,
                "{kind}: exhausted formatted content is not a budget stop"
            );
            assert_eq!(
                chunk.tokens,
                chunk.block_tokens.iter().sum::<f64>(),
                "{kind}"
            );
            assert!(chunk.tokens < 100.0, "{kind}");
        }
    }

    #[test]
    fn thin_filtered_tail_refuses_without_blocking_pressure_folds() {
        let tail = vec![
            tool_call_msg(1, "arc"),
            tool_result_msg(2, "arc", &"output ".repeat(1_200)),
            text_msg(3, Role::Assistant, &"protected ".repeat(20_000)),
        ];
        for fold_only in [false, true] {
            let mut ctx = TriggerContext {
                boundary: BoundaryContext {
                    calibration: None,
                    context_limit: 167_000.0,
                    execute_threshold_percentage: 65.0,
                    usage_percentage: 75.0,
                    usage_input_tokens: 125_250.0,
                    fold_is_only_reclaim: fold_only,
                    prior_boundary_ordinal: 3,
                    migration_floor_active: true,
                    ..BoundaryContext::default()
                },
                ..TriggerContext::default()
            };
            let decision = check_compartment_trigger(&tail, &ctx);
            assert!(!decision.fire);
            assert_eq!(
                decision.no_fire_cause.unwrap().canonical_cause(),
                "below_min_chunk"
            );
            for pressure in [85.0, 95.0] {
                ctx.boundary.usage_percentage = pressure;
                ctx.boundary.usage_input_tokens = 167_000.0 * pressure / 100.0;
                let forced = check_compartment_trigger(&tail, &ctx);
                assert_eq!(forced.reason, Some(TriggerReason::ForceBand));
            }
        }
    }

    #[test]
    fn real_formatted_budget_stop_preserves_measured_progress() {
        let tail = vec![
            text_msg(1, Role::User, "small"),
            text_msg(2, Role::Assistant, &"substance ".repeat(100)),
        ];
        let chunk = chunked_message_estimate(&tail, 1, Some(3), 50.0);
        assert!(chunk.has_more);
        assert_eq!(chunk.tokens, chunk.block_tokens.iter().sum::<f64>());
        assert!(chunk.tokens < 50.0);
    }

    fn ctx_for_tests() -> BoundaryContext {
        BoundaryContext {
            calibration: None,
            context_limit: 20_000.0,
            execute_threshold_percentage: 50.0,
            usage_percentage: 81.0,
            usage_input_tokens: 8_100.0,
            last_compartment_end_ordinal: None,
            prior_boundary_ordinal: 1,
            migration_floor_active: false,
            emergency_tail_scale: None,
            trigger_budget: None,
            fold_is_only_reclaim: false,
        }
    }

    fn fold_only_pressure_ctx() -> BoundaryContext {
        let mut ctx = ctx_for_tests();
        ctx.context_limit = 80_000.0;
        ctx.usage_percentage = 97.0;
        ctx.usage_input_tokens = 77_600.0;
        ctx.fold_is_only_reclaim = true;
        ctx
    }

    #[test]
    fn no_fire_cause_taxonomy_discriminates_trigger_decision_sites() {
        let in_flight = TriggerContext {
            compartment_in_progress: true,
            ..TriggerContext::default()
        };
        let in_flight_decision = check_compartment_trigger(&[], &in_flight);
        assert_eq!(
            in_flight_decision.no_fire_cause,
            Some(HistorianNoFireCause::HistorianAlreadyInProgress)
        );
        assert_eq!(
            in_flight_decision.no_fire_cause.unwrap().canonical_cause(),
            "in_flight"
        );

        let no_new = check_compartment_trigger(&[], &TriggerContext::default());
        assert_eq!(
            no_new.no_fire_cause,
            Some(HistorianNoFireCause::NoLiveMessageAtOrAfterOffset)
        );
        assert_eq!(
            no_new.no_fire_cause.unwrap().canonical_cause(),
            "no_new_raw_history"
        );

        let redundancy = TriggerContext {
            boundary: ctx_for_tests(),
            projected_post_drop_percentage: Some(20.0),
            reclaim_ride_available: true,
            ..TriggerContext::default()
        };
        let redundancy_decision = check_compartment_trigger(
            &[text_msg(1, Role::Assistant, "queued drops cover this tail")],
            &redundancy,
        );
        assert_eq!(
            redundancy_decision.no_fire_cause,
            Some(HistorianNoFireCause::ProjectedPostDropSatisfied)
        );
        assert_eq!(
            redundancy_decision.no_fire_cause.unwrap().canonical_cause(),
            "redundancy_skip"
        );

        let protected = TriggerContext {
            boundary: ctx_for_tests(),
            ..TriggerContext::default()
        };
        let protected_decision = check_compartment_trigger(
            &[text_msg(1, Role::Assistant, "only protected live tail")],
            &protected,
        );
        assert_eq!(
            protected_decision.no_fire_cause,
            Some(HistorianNoFireCause::ProtectedTailWindowEmpty)
        );
        assert_eq!(
            protected_decision.no_fire_cause.unwrap().canonical_cause(),
            "protected_tail"
        );

        let below_floor = check_compartment_trigger(
            &[text_msg(1, Role::Assistant, "small low-pressure tail")],
            &TriggerContext::default(),
        );
        assert_eq!(
            below_floor.no_fire_cause,
            Some(HistorianNoFireCause::BelowProactiveFloor)
        );
        assert_eq!(
            below_floor.no_fire_cause.unwrap().canonical_cause(),
            "below_proactive_floor"
        );

        let mut below_minimum = TriggerContext::default();
        below_minimum.boundary.usage_percentage = 64.0;
        below_minimum.boundary.usage_input_tokens = 81_920.0;
        let thin_head = vec![
            text_msg(1, Role::Assistant, &"thin head ".repeat(1_000)),
            text_msg(2, Role::Assistant, &"protected suffix ".repeat(10_000)),
        ];
        let below_minimum_decision = check_compartment_trigger(&thin_head, &below_minimum);
        assert_eq!(
            below_minimum_decision.no_fire_cause,
            Some(HistorianNoFireCause::BelowMinimumEligibleContent)
        );
        assert_eq!(
            below_minimum_decision
                .no_fire_cause
                .unwrap()
                .canonical_cause(),
            "below_min_chunk"
        );

        let typescript_only_preflight_causes = [
            (
                HistorianNoFireCause::CheapGateBelowTriggerBudget,
                "cheap_skip",
            ),
            (
                HistorianNoFireCause::RawTailInspectionFailed,
                "raw_history_unavailable",
            ),
            (HistorianNoFireCause::DrainBudgetSpent, "drain_budget"),
            (
                HistorianNoFireCause::MissingBoundarySnapshot,
                "missing_boundary_snapshot",
            ),
            (
                HistorianNoFireCause::StaleBoundarySnapshot,
                "stale_boundary_snapshot",
            ),
            (HistorianNoFireCause::EmptyFilteredChunk, "below_min_chunk"),
            (
                HistorianNoFireCause::InvalidChunkCoverage,
                "invalid_chunk_coverage",
            ),
        ];
        for (cause, canonical) in typescript_only_preflight_causes {
            assert_eq!(cause.canonical_cause(), canonical);
        }
    }

    #[test]
    fn reasoning_bearing_completed_arc_fences_a_straddling_boundary_backward() {
        let messages = vec![
            reasoning_tool_call_msg(2, "reasoning-arc"),
            tool_result_msg(3, "reasoning-arc", "tool result"),
        ];
        let arcs = build_tool_arcs(&messages);

        let fenced = fence_boundary_for_tool_arcs(3, &arcs, 1, 1);

        assert_eq!(
            fenced.boundary, 2,
            "the fold must exclude the whole reasoning-bearing invocation instead of cutting its arc"
        );
    }

    #[test]
    fn backward_reasoning_fence_closes_forward_when_the_invocation_is_already_covered() {
        let messages = vec![
            reasoning_tool_call_msg(123, "covered-arc"),
            tool_result_msg(124, "covered-arc", "tool result"),
        ];
        let arcs = build_tool_arcs(&messages);
        let publication_floor = 124;

        let pre_deploy_boundary = arcs.iter().fold(124, |boundary, arc| {
            arc.res_ordinal.map_or(boundary, |result| {
                if completed_tool_arc_crosses_boundary(arc.inv_ordinal, result, boundary) {
                    result.saturating_add(1)
                } else {
                    boundary
                }
            })
        });
        let deployed_backward_then_floor = arcs
            .iter()
            .fold(124, |boundary, arc| {
                arc.res_ordinal.map_or(boundary, |result| {
                    if completed_tool_arc_crosses_boundary(arc.inv_ordinal, result, boundary) {
                        arc.inv_ordinal
                    } else {
                        boundary
                    }
                })
            })
            .max(publication_floor);
        let repaired = fence_boundary_for_tool_arcs(124, &arcs, publication_floor, 124);

        assert_eq!(pre_deploy_boundary, 125);
        assert_eq!(
            deployed_backward_then_floor, 124,
            "the deployed backward fence plus the publication floor split the completed arc"
        );
        assert_eq!(
            repaired.boundary, 125,
            "an already-covered invocation can only be reunited by folding its result forward"
        );
    }

    #[test]
    fn eligible_end_beyond_the_result_is_unchanged_by_the_backward_fence() {
        let messages = vec![
            reasoning_tool_call_msg(123, "covered-arc"),
            tool_result_msg(124, "covered-arc", "tool result"),
        ];
        let arcs = build_tool_arcs(&messages);
        // A chunk through ordinal 128 has exclusive eligible end 129, so the 123-124 arc is
        // wholly inside the head and neither the forward nor backward fence moves its boundary.
        let candidate = 129;
        let pre_deploy = arcs.iter().fold(candidate, |boundary, arc| {
            arc.res_ordinal.map_or(boundary, |result| {
                if completed_tool_arc_crosses_boundary(arc.inv_ordinal, result, boundary) {
                    result.saturating_add(1)
                } else {
                    boundary
                }
            })
        });
        let deployed_backward = arcs.iter().fold(candidate, |boundary, arc| {
            arc.res_ordinal.map_or(boundary, |result| {
                if completed_tool_arc_crosses_boundary(arc.inv_ordinal, result, boundary) {
                    arc.inv_ordinal
                } else {
                    boundary
                }
            })
        });

        assert_eq!(pre_deploy, candidate);
        assert_eq!(deployed_backward, candidate);
        assert_eq!(
            fence_boundary_for_tool_arcs(candidate, &arcs, 98, candidate).boundary,
            candidate
        );
    }

    #[test]
    fn ordinary_completed_arc_fences_a_straddling_boundary_backward() {
        let messages = vec![
            tool_call_msg(2, "ordinary-arc"),
            tool_result_msg(3, "ordinary-arc", "tool result"),
        ];
        let arcs = build_tool_arcs(&messages);

        let fenced = fence_boundary_for_tool_arcs(3, &arcs, 1, 1);

        assert_eq!(
            fenced.boundary, 2,
            "ordinary completed arcs must obey the same whole-arc rule as reasoning-bearing arcs"
        );
    }

    #[test]
    fn backward_reasoning_fence_cannot_split_a_neighboring_ordinary_arc() {
        let messages = vec![
            tool_call_msg(122, "ordinary-arc"),
            reasoning_tool_call_msg(123, "reasoning-arc"),
            tool_result_msg(124, "ordinary-arc", "ordinary result"),
            tool_result_msg(125, "reasoning-arc", "reasoning result"),
        ];
        let arcs = build_tool_arcs(&messages);

        let fenced = fence_boundary_for_tool_arcs(125, &arcs, 1, 1);

        assert_eq!(fenced.boundary, 122);
        assert!(arcs
            .iter()
            .filter_map(|arc| arc.res_ordinal.map(|result| (arc.inv_ordinal, result)))
            .all(|(invocation, result)| {
                !completed_tool_arc_crosses_boundary(invocation, result, fenced.boundary)
            }));
    }

    #[test]
    fn completed_arc_rule_keeps_newest_tool_result_out_of_eligible_head() {
        let tail = completed_newest_tool_arc_tail();
        let terminal_ordinal = 4;
        let newest_ordinal = 3;
        let mut pre_guard_ctx = fold_only_pressure_ctx();
        pre_guard_ctx.fold_is_only_reclaim = false;
        let pre_guard = resolve_protected_tail_boundary(&tail, &pre_guard_ctx);
        assert_eq!(pre_guard.protected_start_ordinal, 2);
        assert_eq!(pre_guard.eligible_head.end, 2);

        let boundary = resolve_protected_tail_boundary(&tail, &fold_only_pressure_ctx());

        assert!(boundary.eligible_head.end < terminal_ordinal);
        assert!(boundary.eligible_head.end <= boundary.protected_start_ordinal);
        assert!(
            boundary.protected_start_ordinal <= newest_ordinal && newest_ordinal < terminal_ordinal,
            "newest message must stay in the protected tail"
        );
    }

    #[test]
    fn fold_only_guard_protects_whole_newest_tool_arc() {
        let tail = vec![
            text_msg(1, Role::Assistant, &"first ".repeat(500)),
            text_msg(2, Role::Assistant, "between before tool"),
            tool_call_msg(3, "arc-newest"),
            text_msg(
                4,
                Role::Assistant,
                "assistant text while the tool is active",
            ),
            tool_result_msg(5, "arc-newest", &"tool result ".repeat(2_500)),
        ];
        let boundary = resolve_protected_tail_boundary(&tail, &fold_only_pressure_ctx());

        assert_eq!(boundary.protected_start_ordinal, 3);
        assert!(
            boundary.eligible_head.end <= 3,
            "eligible head must not split the newest tool arc"
        );
        assert!(!(3 < boundary.eligible_head.end && boundary.eligible_head.end <= 5));
    }

    #[test]
    fn fold_only_guard_still_folds_large_plain_head() {
        let tail = vec![
            text_msg(1, Role::Assistant, &"x ".repeat(200_000)),
            text_msg(2, Role::Assistant, &"newest plain message ".repeat(3_000)),
        ];
        let mut ctx = ctx_for_tests();
        ctx.usage_percentage = 97.0;
        ctx.usage_input_tokens = 19_400.0;
        ctx.fold_is_only_reclaim = true;

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);

        assert_eq!(boundary.protected_start_ordinal, 2);
        assert_eq!(boundary.eligible_head, 1..2);
        assert!(
            boundary.true_raw_eligible_tokens > 100_000.0,
            "large head should remain eligible for folding"
        );
    }

    #[test]
    fn completed_arc_pairing_is_on_without_fold_only_guard() {
        let tail = completed_newest_tool_arc_tail();
        let mut ctx = fold_only_pressure_ctx();
        ctx.fold_is_only_reclaim = false;

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);

        assert_eq!(boundary.protected_start_ordinal, 2);
        assert_eq!(boundary.eligible_head.end, 2);
    }

    #[test]
    fn fold_only_guard_applies_during_emergency_tail_scaling() {
        let tail = completed_newest_tool_arc_tail();
        let mut ctx = fold_only_pressure_ctx();
        ctx.emergency_tail_scale = Some(0.25);

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);
        let terminal_ordinal = 4;
        let newest_ordinal = 3;

        assert_eq!(boundary.protected_start_ordinal, 2);
        assert!(boundary.eligible_head.end <= 2);
        assert!(
            boundary.protected_start_ordinal <= newest_ordinal && newest_ordinal < terminal_ordinal
        );
    }

    #[test]
    fn fold_only_guard_protects_multi_result_newest_arc() {
        // Documents the real CC wire shape (verified across 57 prod captures): parallel tool calls
        // are ONE assistant message of N tool_use blocks paired to ONE user message of N tool_result
        // blocks. build_tool_arcs yields N arcs all sharing inv=assistant_ord, res=user_ord, so the
        // newest (user tool_result) message's protected floor = the shared invocation ordinal, and
        // the whole 2-wide multi-result arc stays in the verbatim tail.
        let head = text_msg(1, Role::Assistant, &"head ".repeat(60_000));
        let multi_call = BoundaryMsg {
            message_ordinal: 2,
            message_id: "m-2".to_string(),
            role: Role::Assistant,
            blocks: ["arc-a", "arc-b", "arc-c"]
                .iter()
                .map(|arc| BoundaryBlock {
                    id: format!("{arc}#call"),
                    ordinal: 2,
                    kind: SelKind::ToolCall {
                        name: "bash".to_string(),
                        input: serde_json::json!({"description": "x"}),
                    },
                    provider_executed: false,
                    byte_size: 16,
                    arc_id: Some((*arc).to_string()),
                    original: Arc::from("{}"),
                    original_token_count: estimate_tokens("{}"),
                    rendered: None,
                    ignored: false,
                })
                .collect(),
        };
        let multi_result = BoundaryMsg {
            message_ordinal: 3,
            message_id: "m-3".to_string(),
            role: Role::User,
            blocks: ["arc-a", "arc-b", "arc-c"]
                .iter()
                .map(|arc| BoundaryBlock {
                    id: format!("{arc}#result"),
                    ordinal: 3,
                    kind: SelKind::ToolResult {
                        tool_name: "bash".to_string(),
                    },
                    provider_executed: false,
                    byte_size: 21_000,
                    arc_id: Some((*arc).to_string()),
                    original: Arc::from("result ".repeat(3_000)),
                    original_token_count: estimate_tokens(&"result ".repeat(3_000)),
                    rendered: None,
                    ignored: false,
                })
                .collect(),
        };
        let tail = vec![head, multi_call, multi_result];
        let mut ctx = ctx_for_tests();
        ctx.usage_percentage = 97.0;
        ctx.usage_input_tokens = 19_400.0;
        ctx.fold_is_only_reclaim = true;

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);

        assert_eq!(
            boundary.protected_start_ordinal, 2,
            "whole multi-result arc (inv=2, res=3) must be protected from its shared invocation"
        );
        assert_eq!(
            boundary.eligible_head,
            1..2,
            "only the head before the arc folds"
        );
    }

    #[test]
    fn fold_only_guard_folds_large_head_before_deep_newest_arc() {
        // AIPROXY over-protection edge: the newest message is a tool_result whose invocation is
        // several ordinals back, with large messages INSIDE the arc, and a large head precedes the
        // arc. The whole newest arc [2..=5] must stay protected tail (never split), but the large
        // head before the arc invocation must STILL fold — the guard only ever lowers
        // protected_tail_start to the newest arc's invocation, never into the head.
        let tail = vec![
            text_msg(1, Role::Assistant, &"head ".repeat(60_000)),
            tool_call_msg(2, "arc-deep"),
            text_msg(3, Role::Assistant, &"mid arc chatter ".repeat(2_000)),
            text_msg(4, Role::Assistant, &"more arc chatter ".repeat(2_000)),
            tool_result_msg(5, "arc-deep", &"tool result ".repeat(2_500)),
        ];
        let mut ctx = ctx_for_tests();
        ctx.usage_percentage = 97.0;
        ctx.usage_input_tokens = 19_400.0;
        ctx.fold_is_only_reclaim = true;

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);

        assert_eq!(
            boundary.protected_start_ordinal, 2,
            "whole newest arc must be protected from its invocation ordinal"
        );
        assert_eq!(
            boundary.eligible_head,
            1..2,
            "only the head before the newest arc is eligible"
        );
        assert!(
            boundary.true_raw_eligible_tokens > 50_000.0,
            "large head before the deep newest arc must still fold, got {}",
            boundary.true_raw_eligible_tokens
        );
    }

    #[test]
    fn wrapup_counts_every_role_and_keeps_the_newest_messages() {
        let tail = vec![
            text_msg(1, Role::User, "one"),
            text_msg(2, Role::Assistant, "two"),
            text_msg(3, Role::System, "three"),
            text_msg(4, Role::User, "four"),
            text_msg(5, Role::Assistant, "five"),
        ];

        let plan = resolve_wrapup_boundary(&tail, None, 2, 128_000.0, 65.0);

        assert_eq!(plan.raw_messages_above_last_compartment, 5);
        assert_eq!(plan.target_protected_start_ordinal, 4);
        assert_eq!(plan.boundary.eligible_head, 1..4);
    }

    #[test]
    fn wrapup_moves_the_keep_watermark_before_a_straddling_tool_arc() {
        let tail = vec![
            text_msg(1, Role::Assistant, "head"),
            tool_call_msg(2, "arc"),
            text_msg(3, Role::Assistant, "working"),
            tool_result_msg(4, "arc", "done"),
            text_msg(5, Role::Assistant, "newest"),
        ];

        let plan = resolve_wrapup_boundary(&tail, None, 2, 128_000.0, 65.0);

        assert_eq!(plan.target_protected_start_ordinal, 2);
        assert_eq!(plan.boundary.eligible_head, 1..2);
        assert_eq!(plan.boundary.boundary_reason, "manual-wrapup-tool-arc");
    }

    #[test]
    fn wrapup_terminal_guard_retains_the_newest_messages_complete_arc() {
        let tail = vec![
            text_msg(1, Role::Assistant, "head"),
            text_msg(2, Role::Assistant, "middle"),
            tool_call_msg(3, "latest"),
            text_msg(4, Role::Assistant, "working"),
            tool_result_msg(5, "latest", "done"),
        ];

        let plan = resolve_wrapup_boundary(&tail, None, 1, 128_000.0, 65.0);

        assert_eq!(plan.target_protected_start_ordinal, 3);
        assert_eq!(plan.boundary.eligible_head, 1..3);
    }

    #[test]
    fn wrapup_coverage_beyond_cached_terminal_returns_offset_anchored_empty_range() {
        let tail = vec![
            text_msg(1, Role::User, "one"),
            text_msg(2, Role::Assistant, "two"),
            text_msg(3, Role::Assistant, "three"),
        ];

        let plan = resolve_wrapup_boundary(&tail, Some(10), 2, 128_000.0, 65.0);

        assert_eq!(plan.raw_messages_above_last_compartment, 0);
        assert_eq!(plan.target_protected_start_ordinal, 11);
        assert_eq!(plan.boundary.protected_start_ordinal, 11);
        assert_eq!(plan.boundary.eligible_head, 11..11);
        assert_eq!(plan.boundary.boundary_reason, "manual-wrapup-empty");
        assert_eq!(plan.boundary.true_raw_eligible_tokens, 0.0);
    }

    #[test]
    fn wrapup_user_snap_window_scales_with_session_geometry() {
        // The keep-watermark candidate lands on ordinal 5; a meaningful user message
        // sits about 10k tokens before it (ordinals 3..5). With a 1M x 65% geometry
        // the derived trigger budget is about 32.5k, so the snap window reaches the
        // user message and retains it. With a 128k x 65% geometry the budget floors
        // at 5k, the snap cannot reach the user message, and the later candidate is
        // kept — the same divergence the TypeScript resolver avoids by passing the
        // session's real context limit and threshold.
        let tail = vec![
            text_msg(1, Role::User, "start the session"),
            text_msg(2, Role::Assistant, &"preamble filler ".repeat(4_000)),
            text_msg(3, Role::User, "now the real request"),
            text_msg(4, Role::Assistant, &"followup filler ".repeat(2_500)),
            text_msg(5, Role::Assistant, "interim note"),
            text_msg(6, Role::User, "latest prompt"),
        ];

        let wide = resolve_wrapup_boundary(&tail, None, 2, 1_000_000.0, 65.0);
        assert_eq!(
            wide.target_protected_start_ordinal, 3,
            "a 1M window's trigger budget must reach the user message: {wide:?}"
        );
        assert_eq!(wide.boundary.eligible_head, 1..3);
        assert_eq!(wide.boundary.boundary_reason, "manual-wrapup-user-snap");

        let narrow = resolve_wrapup_boundary(&tail, None, 2, 128_000.0, 65.0);
        assert_eq!(
            narrow.target_protected_start_ordinal, 5,
            "a 128k window's floored budget must not reach the user message: {narrow:?}"
        );
        assert_eq!(narrow.boundary.eligible_head, 1..5);
    }

    #[test]
    fn boundary_determinism_same_tail_same_resolution() {
        let tail = vec![
            text_msg(1, Role::User, "start"),
            text_msg(2, Role::Assistant, &"alpha ".repeat(900)),
            text_msg(3, Role::Assistant, &"beta ".repeat(900)),
        ];
        let ctx = ctx_for_tests();
        let first = resolve_protected_tail_boundary(&tail, &ctx);
        let second = resolve_protected_tail_boundary(&tail, &ctx);
        assert_eq!(first, second);
    }

    #[test]
    fn adding_newer_items_never_moves_protected_start_below_anchor() {
        let mut tail = vec![
            text_msg(1, Role::User, "published"),
            text_msg(2, Role::Assistant, &"old ".repeat(800)),
        ];
        let mut ctx = ctx_for_tests();
        ctx.last_compartment_end_ordinal = Some(1);
        let before = resolve_protected_tail_boundary(&tail, &ctx);
        tail.push(text_msg(3, Role::Assistant, &"new ".repeat(1200)));
        let after = resolve_protected_tail_boundary(&tail, &ctx);
        assert!(before.protected_start_ordinal >= 2);
        assert!(after.protected_start_ordinal >= 2);
    }

    #[test]
    fn open_arc_staleness_flips_when_newer_growth_pushes_it_older_than_size_walk() {
        let mut recent_tail = vec![
            text_msg(1, Role::User, &"begin ".repeat(400)),
            tool_call_msg(2, "arc-open"),
            text_msg(3, Role::Assistant, &"small ".repeat(100)),
        ];
        let mut ctx = ctx_for_tests();
        ctx.emergency_tail_scale = Some(0.25);
        let recent = resolve_protected_tail_boundary(&recent_tail, &ctx);
        assert!(recent.fenced_by_open_arc, "recent open arc should fence");
        assert_eq!(recent.protected_start_ordinal, 2);

        for ord in 4..14 {
            recent_tail.push(text_msg(ord, Role::Assistant, &"growth ".repeat(800)));
        }
        let stale = resolve_protected_tail_boundary(&recent_tail, &ctx);
        assert!(
            stale.protected_start_ordinal > 2,
            "new growth should push the size-walk start after the abandoned open arc"
        );
        assert!(
            !stale.fenced_by_open_arc,
            "stale open arc must be compactable"
        );
    }

    #[test]
    fn trigger_never_consumes_the_protected_tail() {
        let tail = vec![
            text_msg(1, Role::User, "begin"),
            text_msg(2, Role::Assistant, &"alpha beta gamma ".repeat(4_000)),
            text_msg(3, Role::User, "next task"),
            text_msg(4, Role::Assistant, &"delta epsilon ".repeat(4_000)),
        ];
        let mut trigger = TriggerContext::default();
        trigger.boundary.context_limit = 20_000.0;
        trigger.boundary.execute_threshold_percentage = 50.0;
        trigger.boundary.usage_percentage = 81.0;
        let boundary = resolve_protected_tail_boundary(&tail, &trigger.boundary);
        let decision = check_compartment_trigger(&tail, &trigger);
        if let Some(consume) = decision.consume_through_ordinal {
            assert!(consume < boundary.protected_start_ordinal);
        }
    }

    #[test]
    fn consecutive_completed_arcs_stop_after_the_component_crossing_the_budget() {
        let mut messages = Vec::new();
        for index in 0..8u64 {
            let arc_id = format!("chain-{index}");
            messages.push(tool_call_msg(index * 2 + 1, &arc_id));
            messages.push(tool_result_msg(index * 2 + 2, &arc_id, "result"));
        }
        let prefix = chunked_message_estimate(&messages, 1, Some(7), f64::MAX);
        let estimate = chunked_message_estimate(&messages, 1, None, (prefix.tokens - 1.0).max(1.0));
        assert_eq!(estimate.formatted_blocks, prefix.formatted_blocks);
        assert!(estimate.has_more);
        assert!(estimate.message_count < messages.len());
    }

    #[test]
    fn oversized_first_block_preserves_real_budget_stop() {
        let tail = vec![
            text_msg(1, Role::User, &"one ".repeat(200)),
            text_msg(2, Role::Assistant, &"two ".repeat(200)),
            text_msg(3, Role::User, &"three ".repeat(200)),
        ];
        let estimate = chunked_message_estimate(&tail, 1, None, 50.0);
        assert!(estimate.has_more);
        assert!(estimate.tokens >= 50.0);
    }

    #[test]
    fn zero_based_trigger_counts_ordinal_zero_content() {
        let tail = (0..=5)
            .map(|ord| text_msg(ord, Role::Assistant, &"zero based content ".repeat(4_000)))
            .collect::<Vec<_>>();
        let mut trigger = TriggerContext::default();
        trigger.boundary.context_limit = 20_000.0;
        trigger.boundary.execute_threshold_percentage = 50.0;
        trigger.boundary.usage_percentage = 81.0;

        let decision = check_compartment_trigger(&tail, &trigger);

        assert!(
            decision.fire,
            "ordinal-0 content contributes to the trigger"
        );
        let boundary = decision.boundary.expect("fire carries boundary");
        assert_eq!(boundary.eligible_head.start, 0);
        assert!(boundary.true_raw_eligible_tokens > 0.0);
    }

    #[test]
    fn compartment_ending_at_ordinal_zero_starts_next_window_at_one() {
        let tail = (0..=5)
            .map(|ord| text_msg(ord, Role::Assistant, &"published floor ".repeat(1_000)))
            .collect::<Vec<_>>();
        let mut ctx = ctx_for_tests();
        ctx.last_compartment_end_ordinal = Some(0);
        ctx.trigger_budget = Some(1_000.0);

        let boundary = resolve_protected_tail_boundary(&tail, &ctx);
        let chunk = chunked_message_estimate(
            &tail,
            boundary.eligible_head.start,
            Some(boundary.protected_start_ordinal),
            10_000.0,
        );

        assert_eq!(boundary.eligible_head.start, 1);
        assert!(!chunk
            .formatted_blocks
            .iter()
            .any(|block| block.contains("[0]")));
    }

    #[test]
    fn boundary_measures_original_bytes_not_rendered_reduction_placeholders() {
        let original = "raw tool output ".repeat(400);
        let mut reduced = text_msg(1, Role::Assistant, &original);
        reduced.blocks[0].rendered = Some("[dropped]".to_string());
        let unreduced = text_msg(1, Role::Assistant, &original);
        let ctx = ctx_for_tests();
        let a = resolve_protected_tail_boundary(&[reduced], &ctx);
        let b = resolve_protected_tail_boundary(&[unreduced], &ctx);
        assert_eq!(a.true_raw_eligible_tokens, b.true_raw_eligible_tokens);
        assert_eq!(a.protected_start_ordinal, b.protected_start_ordinal);
    }
}
