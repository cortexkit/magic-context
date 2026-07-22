//! Tail-reduction SELECTION — decides WHICH tail items to reduce and produces
//! their [`ReductionDecision`]s, which slice-3's mechanics freeze/replay/fold.
//!
//! This is the module-owned reduction producer. It is a PURE, DETERMINISTIC function over the flat, block-granular
//! typed tail (CK#1's `ContentKind` projected 1:1 per block into [`SelItem`]).
//! Determinism is the cache invariant: same (items, frozen_keys, ctx, cfg) → same
//! decisions → the slice-3 freeze/replay stays byte-identical.
//!
//! Faithful port of the four OpenCode selectors (differential-golden'd vs the TS
//! source): control-plane supersession, edit supersession, emergency tiered drop,
//! and ctx_reduce agent-drop.
//!
//! Cache-critical invariants (enforced structurally here):
//! - **frozen_keys HARD FILTER**: a CK item stays LIVE with original bytes after
//!   reduction (unlike a TS dropped tag, which leaves the active set), so every
//!   selector MUST exclude already-frozen ids up front or it would re-target them.
//! - **provider_executed filter**: the selectors touch only CLIENT-executed harness
//!   tools; server-side model tools (provider_executed=true) and Opaque blocks stay
//!   verbatim.
//! - **payload purity**: every payload is a pure function of (id, immutable block
//!   bytes) with ZERO pass-varying state, so a frozen target can never be re-emitted
//!   with different bytes.
//! - **arc-atomic emission**: a tool reduction emits decisions for the whole arc
//!   (ToolCall + paired ToolResult + adjacent Reasoning) together, never split.
//! - **deterministic merge**: exactly one decision per target; `drop` beats
//!   `edit_marker`; stable output order.

use std::collections::{HashMap, HashSet};

use crate::transform::ReductionDecision;

// --- ported TS constants (exact; the differential golden is the arbiter) ---

/// `todowrite`: keep the newest 1 (the live plan is the newest todo state).
const TODOWRITE_KEEP: usize = 1;
/// `ctx_reduce`: keep the newest 5 (preserves the visible reduce rhythm).
const CTX_REDUCE_KEEP: usize = 5;
/// Zero-value meta tools whose every occurrence is droppable.
const ZERO_VALUE_META_TOOLS: &[&str] = &["bash_status", "bash_kill"];
/// `ctx_note` actions that carry no lasting value (droppable when positively read).
const CTX_NOTE_ZERO_VALUE_ACTIONS: &[&str] = &["read", "dismiss"];
/// Tools whose superseded older calls compress to an edit_marker.
const EDIT_TOOLS: &[&str] = &["edit", "write"];
/// filePath-like input keys, preserved verbatim in an edit_marker.
const FILE_PATH_KEYS: &[&str] = &["filePath", "file_path", "path"];
/// Diff-bearing input keys, clamped to a region hint in an edit_marker.
const DIFF_KEYS: &[&str] = &[
    "oldString",
    "newString",
    "content",
    "old_string",
    "new_string",
];
/// Region-hint length: enough to identify the edited section, cheap to keep.
const EDIT_REGION_HINT_LEN: usize = 40;
/// The clamp sentinel appended to a region-hinted diff value.
const TRUNCATION_SENTINEL: &str = "...[truncated]";

/// Reclaim target fraction: `fixedFloor + 0.30 × (ceiling − fixedFloor)`.
const TARGET_FRACTION: f64 = 0.30;
/// Newest `ceil(0.20 × n)` of each of T1/T2 are reserved (never evicted).
const TIER_RECENCY_RESERVE: f64 = 0.20;
/// Minimum reclaim to justify an emergency cache bust (tokens).
const EMERGENCY_REARM_MIN_TOKENS: f64 = 2000.0;
/// Byte→token estimate for the emergency reclaim math (matches the TS nudge).
const TOKENS_PER_BYTE: f64 = 0.25;
/// T1 (keep longest): navigation/structure the agent re-uses.
const T1_TOOLS: &[&str] = &["read", "todowrite", "task", "aft_outline", "aft_zoom"];
/// T2 (medium): edit-class continuation context.
const T2_TOOLS: &[&str] = &["edit", "write", "apply_patch", "grep", "glob", "aft_search"];
/// Newest-window tool arcs keep a name-preserving call skeleton; older ones fully
/// reduce the call block. The skeleton-vs-full choice is frozen at freeze time.
const RECENT_TOOL_SKELETON_WINDOW: usize = 20;

/// The reduction kind emitted per block. `drop` = `[dropped]` placeholder;
/// `skeleton` = a name-preserving ToolCall shell (newest window, pairing context);
/// `edit_marker` = filePath verbatim + region-hinted diff for a superseded edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedKind {
    Drop,
    Skeleton,
    EditMarker,
}

impl RedKind {
    fn as_str(self) -> &'static str {
        match self {
            RedKind::Drop => "drop",
            RedKind::Skeleton => "skeleton",
            RedKind::EditMarker => "edit_marker",
        }
    }
}

/// The typed content-kind projection selection branches on — CK#1 `ContentKind`
/// reduced to exactly the fields the five selectors read.
#[derive(Debug, Clone)]
pub enum SelKind {
    ToolCall {
        name: String,
        /// The ToolCall.input (filePath / action / diff keys live here).
        input: serde_json::Value,
    },
    ToolResult {
        tool_name: String,
    },
    Reasoning,
    Text,
    RedactedReasoning,
    Media,
    Opaque,
}

/// A flat, block-granular reducible item, one per content block from the provider. The
/// `id` is this module's stable reduction identifier in `mid#block_index` form for every
/// block, including tool calls and tool results. This struct adds the typed fields that
/// the selection logic needs on top of the raw incoming item.
#[derive(Debug, Clone)]
pub struct SelItem {
    pub id: String,
    pub ordinal: u64,
    pub kind: SelKind,
    /// True = the model's own SERVER-side tool (stays verbatim; never targeted).
    pub provider_executed: bool,
    /// Bytes this block contributes to reclaim accounting (output/content bytes).
    pub byte_size: usize,
    /// The arc this block belongs to, for arc-atomic emission: every block in a tool
    /// arc carries the paired ToolCall block's `mid#block_index`; non-arc blocks carry
    /// `None`. The raw provider tool-call id is only a pairing hint at ingress and is
    /// never an identity key here.
    pub arc_id: Option<String>,
}

/// Pass-level inputs that ride the transform request run-config (NOT CK item
/// fields). See spec §5 for the sourcing buckets (derive / durable / config /
/// caller-owned). For the isolated build these are supplied directly.
#[derive(Debug, Clone)]
pub struct SelectionContext {
    pub pass_class: PassClass,
    /// Provider-reported current total input tokens from the request usage sample.
    pub current_total_input_tokens: f64,
    /// ceiling = contextLimit × executeThreshold%.
    pub ceiling_tokens: f64,
    /// The protected-recent window: items with `ordinal > protected_cutoff_ordinal`
    /// are never emergency-evicted (0 = protect nothing).
    pub protected_cutoff_ordinal: u64,
    /// Emergency idempotence latch: the input-token reading at the prior emergency
    /// drop (0 if never), and whether any emergency drop has happened.
    pub prior_input_sample: f64,
    pub has_prior_drop: bool,
    /// Agent-marked drop ids (the ctx_reduce §N§ signal), a caller-owned side input.
    /// Canonical flat ids of the marked blocks.
    pub agent_drop_ids: Vec<String>,
    /// Agent-drop command ownership, keyed by canonical block id. Missing entries are
    /// legacy rows queued without a command id.
    pub agent_drop_command_ids: HashMap<String, String>,
    /// Agent-drop ids whose command already made its first application. The marker is
    /// durable at command scope, but selection needs the per-id projection.
    pub first_applied_agent_drop_ids: HashSet<String>,
    /// True when a byte-changing pass is already known before reduction selection.
    /// Selection may also discover a different command's first application as a ride.
    pub pass_already_busting: bool,
    /// Dynamic newest-tag protection expressed as exact block ids. This applies to
    /// automatic selectors and agent-marked drops alike.
    pub protected_block_ids: HashSet<String>,
}

/// Which scheduler class this pass is — gates which selectors run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassClass {
    /// A normal execute+bust pass: control-plane / edit / ctx_reduce run.
    Execute,
    /// A ≥85% force pass: the emergency tiered drop runs (in addition).
    EmergencyForce,
    /// A defer pass: selection produces nothing new (mechanics replay frozen).
    Defer,
}

/// Config knobs (frozen at bind, like the budget): the smart-drops gate and the
/// keep/reserve/hint parameters. Defaults mirror the TS constants (smart_drops off).
#[derive(Debug, Clone, Default)]
pub struct SelectionConfig {
    /// Gates the smart-drops selectors (control-plane + edit supersession).
    pub smart_drops: bool,
}

/// A tool ARC grouped from the flat blocks: the selection unit. Each selector picks
/// arcs to reduce; the arc then expands to per-block decisions.
struct ToolArc {
    arc_id: String,
    name: String,
    /// The arc's age key = the ToolCall block's ordinal (or the min block ordinal).
    ordinal: u64,
    provider_executed: bool,
    input: serde_json::Value,
    /// FlatBlock id of the ToolCall block (`mid#block_index`).
    call_id: Option<String>,
    call_bytes: usize,
    /// FlatBlock id of the paired ToolResult block (absent if the result hasn't arrived).
    result_id: Option<String>,
    result_bytes: usize,
    /// Adjacent Reasoning block ids dropped with the arc, + their bytes.
    reasoning_ids: Vec<String>,
    reasoning_bytes: usize,
    /// True once ANY block of the arc is already frozen/reduced (arc is inactive).
    reduced: bool,
}

impl ToolArc {
    /// Total bytes a full arc drop reclaims: call + result + adjacent reasoning.
    fn reclaim_bytes(&self) -> usize {
        self.call_bytes + self.result_bytes + self.reasoning_bytes
    }
}

/// Normalize a tool name for matching (lowercase, strip an `mcp_` prefix) — mirrors
/// the TS `normalizeToolName`, defensive for MCP-surfaced names.
fn normalize_tool_name(name: &str) -> String {
    let lower = name.to_lowercase();
    lower
        .strip_prefix("mcp_")
        .map(str::to_string)
        .unwrap_or(lower)
}

fn is_edit_tool(name: &str) -> bool {
    EDIT_TOOLS.contains(&name)
}

/// Read a string field from a ToolCall input object by any of the given keys.
fn read_input_str(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let obj = input.as_object()?;
    for key in keys {
        if let Some(serde_json::Value::String(s)) = obj.get(*key) {
            return Some(s.clone());
        }
    }
    None
}

/// Group the flat blocks into tool arcs (by `arc_id`), collecting the call/result
/// bytes and adjacent reasoning. Non-tool, non-arc blocks are ignored here (they
/// are not reduction targets for the tool selectors; ctx_reduce targets ids directly).
fn group_arcs(items: &[SelItem], frozen: &HashSet<String>) -> Vec<ToolArc> {
    let mut arcs: HashMap<String, ToolArc> = HashMap::new();
    // Deterministic arc order = first-appearance order (by min ordinal), applied at
    // the end via a sort. Build the map first.
    for item in items {
        let Some(arc_id) = item.arc_id.clone() else {
            continue;
        };
        let entry = arcs.entry(arc_id.clone()).or_insert_with(|| ToolArc {
            arc_id: arc_id.clone(),
            name: String::new(),
            ordinal: u64::MAX,
            provider_executed: false,
            input: serde_json::Value::Null,
            call_id: None,
            call_bytes: 0,
            result_id: None,
            result_bytes: 0,
            reasoning_ids: Vec::new(),
            reasoning_bytes: 0,
            reduced: false,
        });
        entry.ordinal = entry.ordinal.min(item.ordinal);
        if frozen.contains(&item.id) {
            entry.reduced = true;
        }
        match &item.kind {
            SelKind::ToolCall { name, input } => {
                entry.name = normalize_tool_name(name);
                entry.input = input.clone();
                entry.call_id = Some(item.id.clone());
                entry.call_bytes = item.byte_size;
                entry.provider_executed = item.provider_executed;
            }
            SelKind::ToolResult { tool_name } => {
                if entry.name.is_empty() {
                    entry.name = normalize_tool_name(tool_name);
                }
                entry.result_id = Some(item.id.clone());
                entry.result_bytes = item.byte_size;
                if item.provider_executed {
                    entry.provider_executed = true;
                }
            }
            SelKind::Reasoning => {
                entry.reasoning_ids.push(item.id.clone());
                entry.reasoning_bytes += item.byte_size;
            }
            _ => {}
        }
    }
    let mut out: Vec<ToolArc> = arcs.into_values().collect();
    out.sort_by(|a, b| {
        a.ordinal
            .cmp(&b.ordinal)
            .then_with(|| a.arc_id.cmp(&b.arc_id))
    });
    out
}

// --- payload builders (PURE functions of the block's immutable bytes) ---

/// The provider-neutral reduced-content placeholder for a fully-dropped block. Selection
/// stays pure over immutable block bytes; the transform freeze path adds a durable tag
/// reference when the target already has a minted visible tag number.
const DROPPED_PLACEHOLDER: &str = "[dropped]";

/// Slice without splitting a UTF-8 char boundary (mirrors the TS safeSlice, which
/// guards surrogate pairs; Rust slicing must land on a char boundary).
fn safe_prefix(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Clamp a diff value to a region hint (edit_marker): first `EDIT_REGION_HINT_LEN`
/// chars + the sentinel. Idempotent (already-hinted values pass through). Pure.
fn region_hint(value: &str) -> String {
    if value.ends_with(TRUNCATION_SENTINEL) {
        return value.to_string();
    }
    if value.chars().count() > EDIT_REGION_HINT_LEN {
        // char-count semantics mirror the TS `value.length` on the BMP; use a
        // char-boundary-safe byte prefix sized to EDIT_REGION_HINT_LEN chars.
        let byte_len: usize = value
            .char_indices()
            .nth(EDIT_REGION_HINT_LEN)
            .map(|(i, _)| i)
            .unwrap_or(value.len());
        format!("{}{}", safe_prefix(value, byte_len), TRUNCATION_SENTINEL)
    } else {
        value.to_string()
    }
}

/// Build the edit_marker payload for a superseded edit/write ToolCall: filePath-like
/// keys VERBATIM, diff keys clamped to a region hint, other keys untouched. Emitted as
/// a canonical (sorted-key) JSON string so it is deterministic + pure. Mirrors the TS
/// `applyEditMarkerToInput`.
fn edit_marker_payload(input: &serde_json::Value) -> String {
    let mut obj = match input.as_object() {
        Some(o) => o.clone(),
        None => return DROPPED_PLACEHOLDER.to_string(),
    };
    for (key, value) in obj.iter_mut() {
        if FILE_PATH_KEYS.contains(&key.as_str()) {
            continue;
        }
        if !DIFF_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let serde_json::Value::String(s) = value {
            *value = serde_json::Value::String(region_hint(s));
        }
    }
    canonical_json(&serde_json::Value::Object(obj))
}

/// Serialize a JSON value with sorted object keys (deterministic bytes across passes).
fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical_json(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

// --- the reduction plan an arc/selector contributes, before window-shaping ---

/// A per-arc reduction intent from the tool selectors, before the skeleton-window
/// shape is applied. `edit_marker` distinguishes the edit-supersession intent (which
/// keeps the ToolCall as a region-hinted marker) from a plain drop.
struct ArcIntent {
    edit_marker: bool,
}

/// Selection modes an arc's ToolCall block can freeze into.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ArcShape {
    /// In the newest skeleton window: keep a name-preserving call skeleton.
    Skeleton,
    /// Older than the window: fully drop the call block.
    FullDrop,
    /// Edit-supersession: keep filePath + a region hint (regardless of window).
    EditMarker,
}

/// Clamp every ToolCall input value to a short skeleton hint (mirrors the TS
/// `truncate()` 5-char arg clamp), canonical-serialized. Pure fn of the input.
fn skeleton_payload(input: &serde_json::Value) -> String {
    const SKELETON_ARG_LEN: usize = 5;
    let mut obj = match input.as_object() {
        Some(o) => o.clone(),
        None => return DROPPED_PLACEHOLDER.to_string(),
    };
    for value in obj.values_mut() {
        if let serde_json::Value::String(s) = value {
            if s.chars().count() > SKELETON_ARG_LEN {
                let byte_len = s
                    .char_indices()
                    .nth(SKELETON_ARG_LEN)
                    .map(|(i, _)| i)
                    .unwrap_or(s.len());
                *value = serde_json::Value::String(format!(
                    "{}{}",
                    safe_prefix(s, byte_len),
                    TRUNCATION_SENTINEL
                ));
            }
        }
    }
    canonical_json(&serde_json::Value::Object(obj))
}

/// Expand a reduced arc into its per-block [`ReductionDecision`]s (arc-atomic): the
/// ToolCall block takes the shape kind; the ToolResult and adjacent Reasoning blocks
/// are dropped. Skips blocks that are already frozen (never re-decide) or absent.
fn expand_arc(
    arc: &ToolArc,
    shape: ArcShape,
    frozen: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    if let Some(call_id) = &arc.call_id {
        if !frozen.contains(call_id) {
            let (kind, payload) = match shape {
                ArcShape::Skeleton => (RedKind::Skeleton, skeleton_payload(&arc.input)),
                ArcShape::FullDrop => (RedKind::Drop, DROPPED_PLACEHOLDER.to_string()),
                ArcShape::EditMarker => (RedKind::EditMarker, edit_marker_payload(&arc.input)),
            };
            out.push(ReductionDecision {
                target_id: call_id.clone(),
                kind: kind.as_str().to_string(),
                payload,
            });
        }
    }
    if let Some(result_id) = &arc.result_id {
        if !frozen.contains(result_id) {
            out.push(ReductionDecision {
                target_id: result_id.clone(),
                kind: RedKind::Drop.as_str().to_string(),
                payload: DROPPED_PLACEHOLDER.to_string(),
            });
        }
    }
    // Reasoning blocks are NEVER reduction targets: signed thinking is
    // provider-verified content, and a placeholder-rewritten reasoning block can
    // never re-encode for Anthropic (the signature is gone), which permanently
    // fences the session to raw. The arc's reasoning stays verbatim; reclaim
    // comes from the call/result blocks only.
}

// --- the five selectors: each returns the ARC-IDs (or block-ids) it targets ---

/// 1.1 Control-plane supersession + 1.2 edit supersession (the smart_drops selectors).
/// Newest-arc-first, per tool name: todowrite keep-1, ctx_reduce keep-5, zero-value
/// meta drop-all, ctx_note drop-on-zero-value-action; edit/write older-per-file →
/// edit_marker. Returns per-arc intents so the caller expands + shapes them. Active
/// (non-reduced, client-executed) arcs only.
fn select_supersession(arcs: &[&ToolArc]) -> HashMap<String, ArcIntent> {
    let mut intents: HashMap<String, ArcIntent> = HashMap::new();
    // Newest-arc-first for keep-N and newest-per-file semantics.
    let mut newest_first: Vec<&&ToolArc> = arcs.iter().collect();
    newest_first.sort_by(|a, b| {
        b.ordinal
            .cmp(&a.ordinal)
            .then_with(|| b.arc_id.cmp(&a.arc_id))
    });

    let mut todowrite_seen = 0usize;
    let mut ctx_reduce_seen = 0usize;
    let mut seen_file: HashSet<String> = HashSet::new();

    for arc in newest_first {
        let name = arc.name.as_str();
        // Edit supersession first (1.2): older-per-file → edit_marker.
        if is_edit_tool(name) {
            if let Some(fp) = read_input_str(&arc.input, FILE_PATH_KEYS) {
                if seen_file.contains(&fp) {
                    intents
                        .entry(arc.arc_id.clone())
                        .or_insert(ArcIntent { edit_marker: true });
                } else {
                    seen_file.insert(fp); // newest edit to this file stays full
                }
            }
            // no resolvable filePath → skip (fail-safe); still fall through to name rules
        }
        // Control-plane supersession (1.1).
        let is_drop_target = if name == "todowrite" {
            todowrite_seen += 1;
            todowrite_seen > TODOWRITE_KEEP
        } else if name == "ctx_reduce" {
            ctx_reduce_seen += 1;
            ctx_reduce_seen > CTX_REDUCE_KEEP
        } else if ZERO_VALUE_META_TOOLS.contains(&name) {
            true
        } else if name == "ctx_note" {
            read_input_str(&arc.input, &["action"])
                .map(|a| CTX_NOTE_ZERO_VALUE_ACTIONS.contains(&a.as_str()))
                .unwrap_or(false)
        } else {
            false
        };
        if is_drop_target {
            // A full drop supersedes an edit_marker for the same arc (drop wins).
            intents.insert(arc.arc_id.clone(), ArcIntent { edit_marker: false });
        }
    }
    intents
}

/// 1.4 ctx_reduce agent-drop: the caller-supplied marked ids (a control-plane side
/// input). These are already flat block ids; emitted directly as drops (arc-atomic
/// isn't needed — the agent marks specific blocks). Frozen/absent filtered by caller.
fn select_agent_drops(
    ctx: &SelectionContext,
    live_ids: &HashSet<String>,
    frozen: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    for id in &ctx.agent_drop_ids {
        if frozen.contains(id) || !live_ids.contains(id) || ctx.protected_block_ids.contains(id) {
            continue;
        }
        let first_applied = ctx.first_applied_agent_drop_ids.contains(id);
        let can_ride = ctx.pass_already_busting
            || (first_applied
                && ctx.agent_drop_ids.iter().any(|other| {
                    other != id
                        && !ctx.first_applied_agent_drop_ids.contains(other)
                        && live_ids.contains(other)
                        && !frozen.contains(other)
                        && !ctx.protected_block_ids.contains(other)
                        && ctx.agent_drop_command_ids.get(other)
                            != ctx.agent_drop_command_ids.get(id)
                }));
        if first_applied && !can_ride {
            continue;
        }
        out.push(ReductionDecision {
            target_id: id.clone(),
            kind: RedKind::Drop.as_str().to_string(),
            payload: DROPPED_PLACEHOLDER.to_string(),
        });
    }
}

/// Tier of a tool for the emergency drop: T1 nav (keep longest), T2 edit·search, T3
/// misc (drop first). Mirrors the TS `resolveToolTier`.
fn resolve_tool_tier(name: &str) -> u8 {
    let n = normalize_tool_name(name);
    if T1_TOOLS.contains(&n.as_str()) {
        1
    } else if T2_TOOLS.contains(&n.as_str()) {
        2
    } else {
        3
    }
}

fn bytes_to_tokens(bytes: usize) -> f64 {
    (bytes as f64 * TOKENS_PER_BYTE).round()
}

/// 1.3 Emergency tiered drop (≥85% force). Target headroom = fixedFloor + 0.30 ×
/// (ceiling − fixedFloor); walk T3→T2→T1 oldest-first, skipping the protected tail
/// and the newest-20% T1/T2 reserve, until reclaim met. Frozen arcs are INACTIVE
/// (excluded from candidates, reserve, and the floor/reclaim accounting). Returns the
/// arc ids to full-drop.
fn select_emergency(
    arcs: &[&ToolArc],
    ctx: &SelectionContext,
    all_active_reclaim_tokens: f64,
) -> HashSet<String> {
    // Guards mirror the TS planner: unknown ceiling/usage → no-op; idempotence latch.
    if !ctx.ceiling_tokens.is_finite() || ctx.ceiling_tokens <= 0.0 {
        return HashSet::new();
    }
    if !ctx.current_total_input_tokens.is_finite() || ctx.current_total_input_tokens <= 0.0 {
        return HashSet::new();
    }
    if ctx.has_prior_drop && ctx.current_total_input_tokens == ctx.prior_input_sample {
        return HashSet::new();
    }

    let fixed_floor = (ctx.current_total_input_tokens - all_active_reclaim_tokens).max(0.0);
    let working_span = (ctx.ceiling_tokens - fixed_floor).max(0.0);
    let target = fixed_floor + TARGET_FRACTION * working_span;
    let reclaim_tokens = ctx.current_total_input_tokens - target;
    if reclaim_tokens <= EMERGENCY_REARM_MIN_TOKENS {
        return HashSet::new();
    }

    // Per-tier recency reserve (T1, T2 only): the newest ceil(20%) active arcs.
    let mut tier_active: HashMap<u8, Vec<&&ToolArc>> = HashMap::new();
    for arc in arcs {
        let tier = resolve_tool_tier(&arc.name);
        if tier == 1 || tier == 2 {
            tier_active.entry(tier).or_default().push(arc);
        }
    }
    let mut reserved: HashSet<String> = HashSet::new();
    for tier in [1u8, 2u8] {
        if let Some(nums) = tier_active.get_mut(&tier) {
            nums.sort_by(|a, b| {
                b.ordinal
                    .cmp(&a.ordinal)
                    .then_with(|| b.arc_id.cmp(&a.arc_id))
            });
            let reserve_count = (TIER_RECENCY_RESERVE * nums.len() as f64).ceil() as usize;
            for arc in nums.iter().take(reserve_count) {
                reserved.insert(arc.arc_id.clone());
            }
        }
    }

    // Build candidates per tier (protected tail + reserve excluded).
    let mut by_tier: HashMap<u8, Vec<&&ToolArc>> = HashMap::new();
    for arc in arcs {
        if arc.ordinal > ctx.protected_cutoff_ordinal && ctx.protected_cutoff_ordinal > 0 {
            continue; // global protected tail
        }
        let tier = resolve_tool_tier(&arc.name);
        if (tier == 1 || tier == 2) && reserved.contains(&arc.arc_id) {
            continue;
        }
        by_tier.entry(tier).or_default().push(arc);
    }

    // Walk T3 → T2 → T1, oldest-first within tier, until reclaim met.
    let mut selected: HashSet<String> = HashSet::new();
    let mut reclaimed = 0.0f64;
    'outer: for tier in [3u8, 2u8, 1u8] {
        if let Some(group) = by_tier.get_mut(&tier) {
            group.sort_by(|a, b| {
                a.ordinal
                    .cmp(&b.ordinal)
                    .then_with(|| a.arc_id.cmp(&b.arc_id))
            });
            for arc in group.iter() {
                selected.insert(arc.arc_id.clone());
                reclaimed += bytes_to_tokens(arc.reclaim_bytes());
                if reclaimed >= reclaim_tokens {
                    break 'outer;
                }
            }
        }
    }
    selected
}

/// Produce the full reduction-decision set for this pass. PURE + deterministic (see
/// the module-level docs for the invariants). Empty on a defer pass (the mechanics
/// replay the already-frozen set).
pub fn select_reductions(
    items: &[SelItem],
    frozen_keys: &HashSet<String>,
    ctx: &SelectionContext,
    cfg: &SelectionConfig,
) -> Vec<ReductionDecision> {
    if ctx.pass_class == PassClass::Defer {
        return Vec::new();
    }

    let live_ids: HashSet<String> = items
        .iter()
        .filter(|item| {
            // Media/Opaque are pass-through carriers; Reasoning is signed
            // provider-verified content whose rewrite can never re-encode.
            // None of the three may ever become a reduction target, including
            // via agent-directed ctx_reduce ids.
            !matches!(
                item.kind,
                SelKind::Media | SelKind::Opaque | SelKind::Reasoning | SelKind::RedactedReasoning
            )
        })
        .map(|item| item.id.clone())
        .collect();
    let arcs = group_arcs(items, frozen_keys);

    // The COMPOSED candidate pool: active (non-reduced), client-executed arcs only.
    // frozen_keys is applied per-block at emit time (expand_arc skips frozen ids); an
    // arc is "reduced/inactive" once ANY of its blocks is frozen — excluded here so it
    // never re-enters candidate/reserve/reclaim accounting.
    let active_arcs: Vec<&ToolArc> = arcs
        .iter()
        .filter(|a| !a.reduced && !a.provider_executed)
        .collect();

    // Per-arc reduction intents (arc_id → shape), assembled in TS precedence order.
    let mut arc_shapes: HashMap<String, ArcShape> = HashMap::new();

    match ctx.pass_class {
        PassClass::EmergencyForce => {
            // Emergency OWNS the pass (mutually exclusive with the execute selectors).
            // fixedFloor accounting sums ALL active arcs' reclaimable tokens.
            let all_active_reclaim: f64 = active_arcs
                .iter()
                .map(|a| bytes_to_tokens(a.reclaim_bytes()))
                .sum();
            for arc_id in select_emergency(&active_arcs, ctx, all_active_reclaim) {
                arc_shapes.insert(arc_id, ArcShape::FullDrop);
            }
        }
        PassClass::Execute => {
            if cfg.smart_drops {
                let intents = select_supersession(&active_arcs);
                for (arc_id, intent) in intents {
                    arc_shapes.insert(
                        arc_id,
                        if intent.edit_marker {
                            ArcShape::EditMarker
                        } else {
                            ArcShape::FullDrop
                        },
                    );
                }
            }
        }
        PassClass::Defer => unreachable!("defer returned early"),
    }

    // Resolve the skeleton-window shape: a FullDrop arc inside the newest-window keeps
    // a call SKELETON (pairing context) instead. Decided ONCE here (freeze-time) — the
    // shape freezes with the payload; an arc aging past the window later is NOT
    // re-decided (frozen_keys excludes it). EditMarker is window-independent.
    let mut newest_arcs: Vec<&&ToolArc> = active_arcs.iter().collect();
    newest_arcs.sort_by(|a, b| {
        b.ordinal
            .cmp(&a.ordinal)
            .then_with(|| b.arc_id.cmp(&a.arc_id))
    });
    let skeleton_window: HashSet<String> = newest_arcs
        .iter()
        .take(RECENT_TOOL_SKELETON_WINDOW)
        .map(|a| a.arc_id.clone())
        .collect();

    let arc_by_id: HashMap<&str, &ToolArc> = active_arcs
        .iter()
        .map(|a| (a.arc_id.as_str(), *a))
        .collect();

    let mut out: Vec<ReductionDecision> = Vec::new();
    for (arc_id, shape) in &arc_shapes {
        let Some(arc) = arc_by_id.get(arc_id.as_str()) else {
            continue;
        };
        let resolved = match shape {
            ArcShape::EditMarker => ArcShape::EditMarker,
            ArcShape::FullDrop | ArcShape::Skeleton => {
                if skeleton_window.contains(arc_id) {
                    ArcShape::Skeleton
                } else {
                    ArcShape::FullDrop
                }
            }
        };
        expand_arc(arc, resolved, frozen_keys, &mut out);
    }

    // ctx_reduce agent drops stay block-granular, but pass-through carriers are absent
    // from live_ids so Media and Opaque can never become reduction targets.
    select_agent_drops(ctx, &live_ids, frozen_keys, &mut out);

    // Protection is block-specific, not an ordinal cutoff: remove protected targets from
    // both automatic arc decisions and agent-directed decisions before the stable merge.
    out.retain(|decision| !ctx.protected_block_ids.contains(&decision.target_id));

    // Deterministic merge: exactly one decision per target (drop > edit_marker >
    // skeleton), stable output order (by target_id).
    dedupe_and_sort(out)
}

/// Collapse to one decision per target_id (drop beats edit_marker beats skeleton) and
/// sort by target_id for byte-deterministic output.
fn dedupe_and_sort(decisions: Vec<ReductionDecision>) -> Vec<ReductionDecision> {
    fn rank(kind: &str) -> u8 {
        match kind {
            "drop" => 3,
            "edit_marker" => 2,
            "skeleton" => 1,
            _ => 0,
        }
    }
    let mut best: HashMap<String, ReductionDecision> = HashMap::new();
    for d in decisions {
        match best.get(&d.target_id) {
            Some(existing) if rank(&existing.kind) >= rank(&d.kind) => {}
            _ => {
                best.insert(d.target_id.clone(), d);
            }
        }
    }
    let mut out: Vec<ReductionDecision> = best.into_values().collect();
    out.sort_by(|a, b| a.target_id.cmp(&b.target_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    // --- helpers to build a flat CK tail ---

    fn call_block_id(mid: &str) -> String {
        format!("{mid}#0")
    }

    fn result_block_id(mid: &str) -> String {
        format!("{mid}#1")
    }

    fn reasoning_block_id(mid: &str) -> String {
        format!("{mid}#2")
    }

    fn tool_call(
        mid: &str,
        ordinal: u64,
        name: &str,
        input: serde_json::Value,
        bytes: usize,
    ) -> SelItem {
        let id = call_block_id(mid);
        SelItem {
            id: id.clone(),
            ordinal,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            arc_id: Some(id),
        }
    }

    fn tool_result(mid: &str, ordinal: u64, name: &str, bytes: usize) -> SelItem {
        SelItem {
            id: result_block_id(mid),
            ordinal,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn reasoning(mid: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            id: reasoning_block_id(mid),
            ordinal,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: bytes,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn tool_call_with_ids(
        id: &str,
        arc_id: &str,
        ordinal: u64,
        name: &str,
        input: serde_json::Value,
        bytes: usize,
    ) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn tool_result_with_ids(
        id: &str,
        arc_id: &str,
        ordinal: u64,
        name: &str,
        bytes: usize,
    ) -> SelItem {
        SelItem {
            id: id.to_string(),
            ordinal,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn base_ctx(pass: PassClass) -> SelectionContext {
        SelectionContext {
            pass_class: pass,
            current_total_input_tokens: 0.0,
            ceiling_tokens: 0.0,
            protected_cutoff_ordinal: 0,
            prior_input_sample: 0.0,
            has_prior_drop: false,
            agent_drop_ids: Vec::new(),
            agent_drop_command_ids: HashMap::new(),
            first_applied_agent_drop_ids: HashSet::new(),
            pass_already_busting: false,
            protected_block_ids: HashSet::new(),
        }
    }

    /// Project per-block decisions back to arc-level {arc_id -> "drop"|"edit_marker"}
    /// (matching the TS selector output). A skeleton call OR full-drop call → "drop"
    /// at the arc level (the TS selector doesn't distinguish the CK skeleton window);
    /// an edit_marker call → "edit_marker".
    fn arc_decisions(
        items: &[SelItem],
        out: &[ReductionDecision],
    ) -> std::collections::BTreeMap<String, String> {
        let id_to_arc_and_kind: HashMap<&str, (&str, bool)> = items
            .iter()
            .filter_map(|i| {
                i.arc_id.as_deref().map(|a| {
                    (
                        i.id.as_str(),
                        (a, matches!(&i.kind, SelKind::ToolCall { .. })),
                    )
                })
            })
            .collect();
        let mut m = std::collections::BTreeMap::new();
        for d in out {
            let Some((arc, is_call)) = id_to_arc_and_kind.get(d.target_id.as_str()) else {
                continue;
            };
            // The arc's decision is defined by its CALL block's kind.
            if *is_call {
                let arc_kind = match d.kind.as_str() {
                    "edit_marker" => "edit_marker",
                    _ => "drop", // skeleton or drop → arc-level "drop"
                };
                m.insert(arc.to_string(), arc_kind.to_string());
            } else {
                m.entry(arc.to_string())
                    .or_insert_with(|| "drop".to_string());
            }
        }
        m
    }

    // --- the differential golden vs the 5 TS selectors ---

    #[derive(Deserialize)]
    struct ItemJson {
        id: String,
        ordinal: u64,
        kind: serde_json::Value,
        provider_executed: bool,
        byte_size: usize,
        arc_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct CtxJson {
        pass_class: String,
        current_total_input_tokens: f64,
        ceiling_tokens: f64,
        protected_cutoff_ordinal: u64,
        prior_input_sample: f64,
        has_prior_drop: bool,
        agent_drop_ids: Vec<String>,
    }
    #[derive(Deserialize)]
    struct GoldenCase {
        label: String,
        items: Vec<ItemJson>,
        ctx: CtxJson,
        smart_drops: bool,
        frozen: Vec<String>,
        expected: std::collections::BTreeMap<String, String>,
    }

    fn parse_kind(v: &serde_json::Value) -> SelKind {
        if let Some(s) = v.as_str() {
            return match s {
                "Reasoning" => SelKind::Reasoning,
                "Text" => SelKind::Text,
                "RedactedReasoning" => SelKind::RedactedReasoning,
                "Media" => SelKind::Media,
                _ => SelKind::Opaque,
            };
        }
        if let Some(obj) = v.as_object() {
            if let Some(tc) = obj.get("ToolCall") {
                return SelKind::ToolCall {
                    name: tc
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input: tc.get("input").cloned().unwrap_or(serde_json::Value::Null),
                };
            }
            if let Some(tr) = obj.get("ToolResult") {
                return SelKind::ToolResult {
                    tool_name: tr
                        .get("tool_name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                };
            }
        }
        SelKind::Opaque
    }

    #[test]
    fn selection_golden_matches_ts_selectors() {
        let raw = include_str!("../testdata/selection-golden.json");
        let cases: Vec<GoldenCase> =
            serde_json::from_str(raw).expect("parse selection-golden.json");
        assert!(!cases.is_empty(), "empty selection golden");
        let mut seen_reduction_kinds = HashSet::new();
        let mut saw_t1_tool = false;
        let mut saw_t2_tool = false;

        for case in &cases {
            let items: Vec<SelItem> = case
                .items
                .iter()
                .map(|i| SelItem {
                    id: i.id.clone(),
                    ordinal: i.ordinal,
                    kind: parse_kind(&i.kind),
                    provider_executed: i.provider_executed,
                    byte_size: i.byte_size,
                    arc_id: i.arc_id.clone(),
                })
                .collect();
            let call_ids: HashSet<&str> = items
                .iter()
                .filter(|i| matches!(&i.kind, SelKind::ToolCall { .. }))
                .map(|i| i.id.as_str())
                .collect();
            for item in &items {
                assert!(
                    !item.id.ends_with("#call")
                        && !item.id.ends_with("#result")
                        && !item.id.ends_with("#reasoning"),
                    "golden item '{}' still uses the pre-FlatBlock tool suffix vocabulary",
                    item.id
                );
                if let SelKind::ToolCall { name, .. } = &item.kind {
                    let tier = resolve_tool_tier(name);
                    saw_t1_tool |= tier == 1;
                    saw_t2_tool |= tier == 2;
                }
            }
            for arc in case.expected.keys() {
                assert!(
                    call_ids.contains(arc.as_str()),
                    "case '{}' expected arc '{}' is not the ToolCall FlatBlock id",
                    case.label,
                    arc
                );
            }
            let pass = match case.ctx.pass_class.as_str() {
                "EmergencyForce" => PassClass::EmergencyForce,
                "Defer" => PassClass::Defer,
                _ => PassClass::Execute,
            };
            let ctx = SelectionContext {
                pass_class: pass,
                current_total_input_tokens: case.ctx.current_total_input_tokens,
                ceiling_tokens: case.ctx.ceiling_tokens,
                protected_cutoff_ordinal: case.ctx.protected_cutoff_ordinal,
                prior_input_sample: case.ctx.prior_input_sample,
                has_prior_drop: case.ctx.has_prior_drop,
                agent_drop_ids: case.ctx.agent_drop_ids.clone(),
                agent_drop_command_ids: HashMap::new(),
                first_applied_agent_drop_ids: HashSet::new(),
                pass_already_busting: false,
                protected_block_ids: HashSet::new(),
            };
            let cfg = SelectionConfig {
                smart_drops: case.smart_drops,
            };
            let frozen: HashSet<String> = case.frozen.iter().cloned().collect();
            let out = select_reductions(&items, &frozen, &ctx, &cfg);
            seen_reduction_kinds.extend(out.iter().map(|d| d.kind.clone()));
            let got = arc_decisions(&items, &out);
            assert_eq!(
                got, case.expected,
                "arc-decision mismatch in case '{}'",
                case.label
            );
        }

        for kind in ["drop", "skeleton", "edit_marker"] {
            assert!(
                seen_reduction_kinds.contains(kind),
                "selection golden stopped exercising reduction kind '{kind}'"
            );
        }
        assert!(saw_t1_tool, "selection golden stopped exercising T1 tools");
        assert!(saw_t2_tool, "selection golden stopped exercising T2 tools");
    }

    // --- CK-model unit tests (no TS equivalent) ---

    #[test]
    fn provider_executed_arc_never_targeted() {
        // A server-side tool arc must be skipped by automatic smart-drops.
        let mut items = vec![
            tool_call("c1", 1, "bash_status", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash_status", 200),
            tool_call("c2", 2, "bash_status", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash_status", 200),
        ];
        let c2_arc = call_block_id("c2");
        for it in items.iter_mut() {
            if it.arc_id.as_deref() == Some(c2_arc.as_str()) {
                it.provider_executed = true;
            }
        }
        let ctx = base_ctx(PassClass::Execute);
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let arcs = arc_decisions(&items, &out);
        assert_eq!(
            arcs.get(&call_block_id("c1")).map(String::as_str),
            Some("drop")
        );
        assert!(
            !arcs.contains_key(&c2_arc),
            "provider_executed arc must be skipped"
        );
    }

    #[test]
    fn frozen_arc_blocks_never_re_emitted() {
        // c1's result already frozen → the arc is inactive; no decision for ANY c1 block.
        let items = vec![
            tool_call("c1", 1, "bash_status", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash_status", 200),
            tool_call("c2", 2, "bash_status", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash_status", 200),
        ];
        let ctx = base_ctx(PassClass::Execute);
        let frozen: HashSet<String> = [result_block_id("c1")].into_iter().collect();
        let out = select_reductions(
            &items,
            &frozen,
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        assert!(
            out.iter().all(|d| !d.target_id.starts_with("c1")),
            "no c1 block may be re-emitted once the arc is frozen: {out:?}"
        );
        assert!(
            out.iter().any(|d| d.target_id.starts_with("c2")),
            "c2 should still reduce"
        );
    }

    #[test]
    fn dynamic_block_protection_filters_automatic_and_agent_drop_decisions() {
        let items = vec![
            tool_call("c1", 1, "bash_status", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash_status", 200),
            tool_call("c2", 2, "bash_status", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash_status", 200),
        ];
        let protected = result_block_id("c1");
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![protected.clone()];
        ctx.protected_block_ids.insert(protected.clone());

        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        assert!(out.iter().all(|decision| decision.target_id != protected));
        assert!(
            out.iter()
                .any(|decision| decision.target_id == result_block_id("c2")),
            "the unprotected automatic candidate must still be selected"
        );
    }

    #[test]
    fn arc_atomic_emission_targets_call_and_result_never_reasoning() {
        // A dropped arc emits decisions for the call and result. The adjacent
        // reasoning block stays verbatim: rewriting signed thinking discards the
        // signature and the block can never re-encode for Anthropic, which
        // permanently fences the session to raw serving.
        let items = vec![
            reasoning("c1", 1, 100),
            tool_call("c1", 1, "bash_status", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash_status", 300),
        ];
        let ctx = base_ctx(PassClass::Execute);
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let ids: HashSet<&str> = out.iter().map(|d| d.target_id.as_str()).collect();
        assert!(
            ids.contains(call_block_id("c1").as_str())
                && ids.contains(result_block_id("c1").as_str()),
            "{ids:?}"
        );
        assert!(
            !ids.contains(reasoning_block_id("c1").as_str()),
            "reasoning must never be a reduction target: {ids:?}"
        );
    }

    #[test]
    fn agent_drop_on_reasoning_block_is_refused() {
        // ctx_reduce ids aimed at reasoning blocks are filtered at the live-ids
        // boundary, same as Media/Opaque pass-through carriers.
        let items = vec![
            reasoning("c1", 1, 100),
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![reasoning_block_id("c1")];
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().all(|d| d.target_id != reasoning_block_id("c1")),
            "{out:?}"
        );
    }

    #[test]
    fn reused_provider_call_id_does_not_merge_cross_turn_arcs() {
        // Some providers reuse bare tool-call ids such as "call_0" across turns. The
        // grouping key is the session-injective ToolCall FlatBlock id, so two turns with
        // the same provider id still reduce as two independent arcs.
        let items = vec![
            tool_call_with_ids(
                "turn1#0",
                "turn1#0",
                1,
                "bash_status",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn1-tool#0", "turn1#0", 1, "bash_status", 300),
            tool_call_with_ids(
                "turn2#0",
                "turn2#0",
                2,
                "bash_status",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn2-tool#0", "turn2#0", 2, "bash_status", 300),
        ];
        let ctx = base_ctx(PassClass::Execute);
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let arcs = arc_decisions(&items, &out);
        assert_eq!(arcs.get("turn1#0").map(String::as_str), Some("drop"));
        assert_eq!(arcs.get("turn2#0").map(String::as_str), Some("drop"));

        let ids: HashSet<&str> = out.iter().map(|d| d.target_id.as_str()).collect();
        assert!(
            ids.contains("turn1#0") && ids.contains("turn1-tool#0"),
            "{ids:?}"
        );
        assert!(
            ids.contains("turn2#0") && ids.contains("turn2-tool#0"),
            "{ids:?}"
        );
    }

    #[test]
    fn skeleton_window_keeps_call_shell_older_full_drops() {
        // 22 arcs; the newest 20 keep a skeleton call, the oldest 2 full-drop.
        let mut items = Vec::new();
        for n in 1..=22u64 {
            items.push(tool_call(
                &format!("c{n}"),
                n,
                "bash_status",
                serde_json::json!({"cmd": "x".repeat(20)}),
                50,
            ));
            items.push(tool_result(&format!("c{n}"), n, "bash_status", 200));
        }
        let ctx = base_ctx(PassClass::Execute);
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        let call_kind = |arc: &str| -> String {
            out.iter()
                .find(|d| d.target_id == call_block_id(arc))
                .map(|d| d.kind.clone())
                .unwrap_or_default()
        };
        assert_eq!(call_kind("c1"), "drop", "oldest arc full-drops the call");
        assert_eq!(call_kind("c2"), "drop", "2nd oldest full-drops");
        assert_eq!(call_kind("c22"), "skeleton", "newest keeps a skeleton call");
        assert_eq!(call_kind("c3"), "skeleton", "inside the window → skeleton");
    }

    #[test]
    fn payload_purity_independent_of_pressure() {
        // The cache-critical monotonicity pin: a payload = f(id, immutable block bytes)
        // with ZERO pass-varying state, so a frozen target can never be re-emitted with
        // different bytes. Prove it EMPIRICALLY by holding c1 an edit_marker in TWO
        // genuinely different contexts and asserting a byte-identical payload.
        //
        // c1/c2/c3 are all edits to a.ts; c3 (newest) stays full, c1+c2 are older →
        // edit_marker candidates. Context B varies agent_drop_ids (drops UNRELATED c9,
        // so the produced set genuinely differs) plus the pressure/latch fields, chosen
        // so c1 stays an edit_marker in BOTH. A payload fn that accidentally read
        // ctx would diverge here; a pure one cannot.
        let items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"z".repeat(80)}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"w".repeat(80)}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
            tool_call(
                "c3",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","content":"q".repeat(80)}),
                500,
            ),
            tool_result("c3", 3, "edit", 100),
            tool_call("c9", 9, "read", serde_json::json!({}), 50),
            tool_result("c9", 9, "read", 300),
        ];
        let c1_marker_payload = |ctx: &SelectionContext| -> Option<String> {
            let out = select_reductions(
                &items,
                &HashSet::new(),
                ctx,
                &SelectionConfig { smart_drops: true },
            );
            out.iter()
                .find(|d| d.target_id == call_block_id("c1") && d.kind == "edit_marker")
                .map(|d| d.payload.clone())
        };

        // Context A: no agent drops, zero pressure fields.
        let ctx_a = base_ctx(PassClass::Execute);
        // Context B: a genuinely different produced set — an unrelated agent drop (c9)
        // plus non-zero pressure/latch fields.
        let ctx_b = SelectionContext {
            agent_drop_ids: vec![result_block_id("c9")],
            current_total_input_tokens: 123_456.0,
            ceiling_tokens: 200_000.0,
            protected_cutoff_ordinal: 2,
            prior_input_sample: 99_000.0,
            has_prior_drop: true,
            ..base_ctx(PassClass::Execute)
        };

        // Non-vacuity guard: prove the two contexts genuinely produce DIFFERENT sets
        // (c9 is dropped in B via the agent-drop, absent in A), so the payload equality
        // below is a real invariance across a differing pass, not f(x)==f(x).
        let set_a = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_a,
            &SelectionConfig { smart_drops: true },
        );
        let set_b = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_b,
            &SelectionConfig { smart_drops: true },
        );
        assert!(
            !set_a.iter().any(|d| d.target_id == result_block_id("c9")),
            "context A must NOT drop c9"
        );
        assert!(
            set_b.iter().any(|d| d.target_id == result_block_id("c9")),
            "context B MUST drop c9 (the sets genuinely differ)"
        );

        let pa = c1_marker_payload(&ctx_a);
        let pb = c1_marker_payload(&ctx_b);
        assert!(pa.is_some(), "c1 must be an edit_marker in context A");
        assert!(pb.is_some(), "c1 must be an edit_marker in context B");
        assert_eq!(
            pa, pb,
            "edit_marker payload must NOT vary with the differing context"
        );
        // And it equals the direct pure-fn output over the immutable input bytes.
        assert_eq!(
            pa.as_deref(),
            Some(
                edit_marker_payload(
                    &serde_json::json!({"filePath":"a.ts","oldString":"z".repeat(80)})
                )
                .as_str()
            ),
            "payload must be exactly the pure fn of the block's input bytes"
        );
    }

    #[test]
    fn agent_drop_ids_reduce_directly() {
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({}), 50),
            tool_result("c1", 1, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out
            .iter()
            .any(|d| d.target_id == result_block_id("c1") && d.kind == "drop"));
    }

    #[test]
    fn held_agent_drop_never_trickles_when_the_window_slides() {
        let items = vec![SelItem {
            id: "held#0".to_string(),
            ordinal: 1,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 100,
            arc_id: None,
        }];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["held#0".to_string()];
        ctx.agent_drop_command_ids
            .insert("held#0".to_string(), "command-a".to_string());
        ctx.first_applied_agent_drop_ids
            .insert("held#0".to_string());
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.is_empty(),
            "a held row cannot create a stable-pass bust"
        );
    }

    #[test]
    fn different_command_first_application_is_a_single_ride_opportunity() {
        let items = vec![
            SelItem {
                id: "held#0".to_string(),
                ordinal: 1,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                arc_id: None,
            },
            SelItem {
                id: "new#0".to_string(),
                ordinal: 2,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                arc_id: None,
            },
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["held#0".to_string(), "new#0".to_string()];
        ctx.agent_drop_command_ids
            .insert("held#0".to_string(), "command-a".to_string());
        ctx.agent_drop_command_ids
            .insert("new#0".to_string(), "command-b".to_string());
        ctx.first_applied_agent_drop_ids
            .insert("held#0".to_string());
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .map(|decision| decision.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["held#0", "new#0"]
        );
    }

    #[test]
    fn pass_through_carriers_are_never_reduction_targets() {
        let items = [SelKind::Media, SelKind::Opaque]
            .into_iter()
            .enumerate()
            .map(|(index, kind)| SelItem {
                id: format!("carrier#{index}"),
                ordinal: 1,
                kind,
                provider_executed: false,
                byte_size: 100,
                arc_id: None,
            })
            .collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = items.iter().map(|item| item.id.clone()).collect();
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn defer_pass_produces_nothing() {
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Defer);
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig { smart_drops: true },
        );
        assert!(out.is_empty(), "defer produces no reductions");
    }
}
