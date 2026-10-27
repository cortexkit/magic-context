//! Tail-reduction SELECTION — decides WHICH tail items to reduce and produces
//! their [`ReductionDecision`]s, which slice-3's mechanics freeze/replay/fold.
//!
//! This is the module-owned reduction producer. It is a PURE, DETERMINISTIC function over the flat, block-granular
//! typed tail (CK#1's `ContentKind` projected 1:1 per block into [`SelItem`]).
//! Determinism is the cache invariant: same (items, frozen_keys, ctx, cfg) → same
//! decisions → the slice-3 freeze/replay stays byte-identical.
//!
//! Faithful port of the OpenCode selectors: control-plane supersession, edit
//! supersession, duplicate-tool cleanup, emergency tiered drop, age-based two-pass,
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
//! - **arc-safe emission**: a tool reduction emits decisions for its ToolCall and
//!   paired ToolResult together. Reasoning is never rewritten, and a reasoning-bearing
//!   assistant with no other durable sibling makes the whole tool arc ineligible.
//! - **deterministic merge**: exactly one decision per target; `drop` beats
//!   `edit_marker`; stable output order.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::transform::{utf16_len, utf16_prefix, ReductionDecision};

// --- ported TS constants (exact; the differential golden is the arbiter) ---

/// Distinct recent message owners retained as continuation context.
const SUPERSESSION_RECENT_MESSAGE_WINDOW: usize = 20;
/// Zero-value meta tools whose every occurrence is droppable.
const ZERO_VALUE_META_TOOLS: &[&str] = &["bash_status", "bash_kill"];
/// Coordination tools that should not be surfaced as ctx_reduce guidance. This
/// does not change what the agent may explicitly drop or what smart-drop selects.
pub(crate) const RECLAIM_HINT_EXCLUDED_TOOLS: &[&str] = &[
    "ask",
    "bash_kill",
    "bash_status",
    "board",
    "task",
    "todoread",
    "todowrite",
    "work",
];
/// `ctx_note` actions that carry no lasting value (droppable when positively read).
const CTX_NOTE_ZERO_VALUE_ACTIONS: &[&str] = &["read", "dismiss"];
/// Mirrors the duplicate-safe tool list in the TypeScript twin:
/// `packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts`. Hosts hand over bare tool
/// names (OpenCode 1.18.30 stores `read`, `grep`, `glob`; Pi stores `read`, `grep`), so the bare
/// names are what match; the `mcp_` forms cover MCP servers that expose the same tools under that
/// prefix.
const DEDUP_SAFE_TOOLS: &[&str] = &[
    "grep",
    "read",
    "glob",
    "ast_grep_search",
    "lsp_diagnostics",
    "lsp_symbols",
    "lsp_find_references",
    "lsp_goto_definition",
    "lsp_prepare_rename",
    "mcp_grep",
    "mcp_read",
    "mcp_glob",
    "mcp_ast_grep_search",
    "mcp_lsp_diagnostics",
    "mcp_lsp_symbols",
    "mcp_lsp_find_references",
    "mcp_lsp_goto_definition",
    "mcp_lsp_prepare_rename",
];
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
pub(crate) const EDIT_INPUT_KEY_ORDER_MARKER: &str = "__cortexkit_edit_input_key_order_v1";
/// The clamp sentinel appended to a region-hinted diff value.
const TRUNCATION_SENTINEL: &str = "...[truncated]";

/// Reclaim target fraction: `fixedFloor + 0.30 × (ceiling − fixedFloor)`.
const TARGET_FRACTION: f64 = 0.30;
/// Newest `ceil(0.20 × n)` of each of T1/T2 are reserved (never evicted).
const TIER_RECENCY_RESERVE: f64 = 0.20;
/// Skip arcs too small to recover meaningful tokens during pressure-triggered reclamation.
pub(crate) const AGE_RECLAIM_MIN_TOKENS: usize = 250;
/// Minimum reclaim to justify an emergency cache bust (tokens).
const EMERGENCY_REARM_MIN_TOKENS: f64 = 2000.0;
/// The selected arcs must together reclaim at least this many tokens, or the pass is
/// skipped unless another mutation already prices it. The gap check above only proves
/// there is something to close. One live session spent an hour at 100% context dropping
/// one fresh tool result per pass, 28 to 149 tokens each against a ~9,200-token gap.
/// Mirrors the TS `EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS`.
const EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS: f64 = EMERGENCY_REARM_MIN_TOKENS;
/// Byte→token estimate for the emergency reclaim math (matches the TS nudge).
const TOKENS_PER_BYTE: f64 = 0.25;
/// T1 (keep longest): navigation/structure the agent re-uses.
const T1_TOOLS: &[&str] = &["read", "todowrite", "task", "aft_outline", "aft_zoom"];
/// T2 (medium): edit-class continuation context.
const T2_TOOLS: &[&str] = &["edit", "write", "apply_patch", "grep", "glob", "aft_search"];
/// Newest-window tool arcs keep a name-preserving call skeleton; older ones fully
/// reduce the call block. The skeleton-vs-full choice is frozen at freeze time.
pub(crate) const RECENT_TOOL_SKELETON_WINDOW: usize = 20;

/// The largest dropped-call input, measured by [`tool_input_string_bytes`], that keeps
/// its real arguments inside the newest-call window. Larger inputs are removed.
pub(crate) const SKELETON_REAL_INPUT_MAX_BYTES: usize = 1024;

/// Size of a tool call's input for the real-or-absent rule: the total UTF-8 byte
/// length of every string value, recursively through objects and arrays. Keys,
/// numbers, booleans and nulls do not count. Defined on string leaves so the
/// TypeScript, Pi and Rust lanes compute the same number from the same input
/// regardless of JSON serialization; `tests/fixtures/tool-input-string-bytes.json`
/// pins it across all three.
pub(crate) fn tool_input_string_bytes(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::String(text) => text.len(),
        serde_json::Value::Array(items) => items.iter().map(tool_input_string_bytes).sum(),
        serde_json::Value::Object(map) => map.values().map(tool_input_string_bytes).sum(),
        _ => 0,
    }
}

fn is_small_tool_input(value: &serde_json::Value) -> bool {
    tool_input_string_bytes(value) <= SKELETON_REAL_INPUT_MAX_BYTES
}

/// The reduction kind emitted per block. `drop` = `[dropped]` placeholder;
/// `skeleton_real` = the ToolCall kept exactly as the host sent it (real arguments),
/// its paired results reduced to the placeholder (newest window with a small input,
/// the call whose result ends the request, or reasoning adjacency);
/// `edit_marker` = filePath verbatim + region-hinted diff for a superseded edit.
///
/// The legacy `skeleton` kind (arguments replaced by `{"dropped": …}`) is no longer
/// selected. Frozen legacy units keep replaying until a HARD fold converts them
/// (see [`legacy_skeleton_conversions`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedKind {
    Drop,
    SkeletonReal,
    EditMarker,
}

impl RedKind {
    fn as_str(self) -> &'static str {
        match self {
            RedKind::Drop => "drop",
            RedKind::SkeletonReal => "skeleton_real",
            RedKind::EditMarker => "edit_marker",
        }
    }
}

/// The message role needed to reason about provider-side same-role merging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelMessageRole {
    Assistant,
    System,
    NonAssistant,
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
    /// Current representation's local-token count for emergency budgeting; it does not change age-based eligibility.
    pub served_token_count: Option<usize>,
    pub id: String,
    pub ordinal: u64,
    /// Provider-facing role of the owning message.
    pub message_role: SelMessageRole,
    pub kind: SelKind,
    /// True = the model's own SERVER-side tool (stays verbatim; never targeted).
    pub provider_executed: bool,
    /// Host-owned marker: automatic selection must preserve user decisions.
    pub user_answer: bool,
    /// Bytes this block contributes to reclaim accounting (output/content bytes).
    pub byte_size: usize,
    /// Persisted tag-token estimate for this block, when one exists.
    pub token_count: Option<usize>,
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
    /// Static token policy for this cache-busting selection pass; None retains legacy uncalibrated math.
    pub calibration: Option<crate::decision_calibration::DecisionCalibration>,
    pub pass_class: PassClass,
    /// Provider-reported current total input tokens from the request usage sample.
    pub current_total_input_tokens: f64,
    /// ceiling = contextLimit × executeThreshold%.
    pub ceiling_tokens: f64,
    /// Greatest tool-call ordinal whose result had three newer user turns or
    /// newer content totaling 25% of the usable window at an earlier rebuild (0 = none).
    /// Selection reads this saved boundary before the current pass advances it.
    pub last_execute_ordinal: u64,
    /// True only for a scheduler execute caused by a context-pressure threshold crossing.
    pub scheduler_pressure_execute: bool,
    /// Shared force-episode latch. The sample is diagnostic, not an equality gate:
    /// changing usage cannot grant another batch before exit or an independent bust.
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
    /// True when supersession can ride concrete work already scheduled for this pass.
    /// Unlike `pass_already_busting`, a held emergency latch alone does not set this.
    pub supersession_ride_available: bool,
    /// True only when a rebuild that is independent of the emergency itself (a fold, an
    /// m[1] or render-config change, a pending soft refresh) already rewrites the cached
    /// prefix on this pass. The force-band edge and the 95% backstop are permissions to
    /// rewrite, not rewrites that are already paid for, so they never set this. Only this
    /// flag waives the emergency minimum achievable reclaim.
    pub emergency_minimum_waived: bool,
    /// At the scheduler's >=95% backstop, the token window and tier reserve yield.
    pub emergency_window_yields: bool,
    /// Persisted token-window protection expressed as exact block ids.
    pub tag_window_protected_block_ids: HashSet<String>,
    /// Whole-message protection for mutation-exempt and lineage-anchor messages.
    pub exempt_message_protected_block_ids: HashSet<String>,
}

impl SelectionContext {
    fn block_is_protected(&self, block_id: &str) -> bool {
        (!self.emergency_window_yields && self.tag_window_protected_block_ids.contains(block_id))
            || self.exempt_message_protected_block_ids.contains(block_id)
    }
}

/// Which scheduler class this pass is — gates which selectors run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassClass {
    /// A normal execute+bust pass: control-plane / edit / two-pass / ctx_reduce run.
    Execute,
    /// A derived force-band pass: the emergency tiered drop runs (in addition).
    EmergencyForce,
    /// A defer pass: selection produces nothing new (mechanics replay frozen).
    Defer,
}

/// Effective per-project keep counts, read for each automatic selection.
#[derive(Debug, Clone)]
pub struct SelectionConfig {
    /// Deprecated caller input, ignored. Supersession always rides a rebuilding pass.
    pub smart_drops: bool,
    pub protected_tools: std::collections::BTreeMap<String, usize>,
}

pub(crate) fn default_protected_tools() -> std::collections::BTreeMap<String, usize> {
    [("todowrite".to_string(), 1), ("ctx_reduce".to_string(), 3)].into()
}

impl Default for SelectionConfig {
    fn default() -> Self {
        Self {
            smart_drops: false,
            protected_tools: default_protected_tools(),
        }
    }
}

/// A tool ARC grouped from the flat blocks: the selection unit. Each selector picks
/// arcs to reduce; the arc then expands to per-block decisions.
struct ToolArc {
    arc_id: String,
    /// Message that owns the ToolCall block; duplicate fingerprints are owner-qualified.
    owner_message_id: Option<String>,
    name: String,
    /// Original tool name, needed because the duplicate-safe set retains the `mcp_` prefix.
    dedup_name: String,
    /// Result position mirrors the order in which the TS tagger allocates tool tags.
    dedup_result_ordinal: u64,
    dedup_result_block_index: usize,
    /// The arc's age key = the ToolCall block's ordinal (or the min block ordinal).
    ordinal: u64,
    provider_executed: bool,
    input: serde_json::Value,
    /// FlatBlock ids of ToolCall blocks owned by this `(assistant mid, call id)` arc.
    /// Malformed providers can repeat a call id inside one assistant message; TS treats
    /// those blocks as one drop target, so Rust keeps one composite arc with many blocks.
    call_inputs: Vec<(String, serde_json::Value)>,
    call_bytes: usize,
    /// FlatBlock ids of paired ToolResult blocks (absent when a result has not arrived).
    result_ids: Vec<String>,
    result_bytes: usize,
    /// Persisted tag-token total; legacy arcs with no estimate remain reclaimable.
    reclaim_tokens: Option<usize>,
    /// True once ANY block of the arc is already frozen/reduced (arc is inactive).
    reduced: bool,
}

impl ToolArc {
    /// Bytes a full arc drop actually removes from the wire. Signed reasoning stays verbatim.
    fn reclaim_bytes(&self) -> usize {
        self.call_bytes + self.result_bytes
    }
}

/// Normalize a tool name for matching (lowercase, strip an `mcp_` prefix) — mirrors
/// the TS `normalizeToolName`, defensive for MCP-surfaced names.
pub(crate) fn normalize_tool_name(name: &str) -> String {
    let lower = name.to_lowercase();
    lower
        .strip_prefix("mcp_")
        .map(str::to_string)
        .unwrap_or(lower)
}

pub(crate) fn is_edit_tool(name: &str) -> bool {
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
            owner_message_id: None,
            name: String::new(),
            dedup_name: String::new(),
            dedup_result_ordinal: 0,
            dedup_result_block_index: 0,
            ordinal: u64::MAX,
            provider_executed: false,
            input: serde_json::Value::Null,
            call_inputs: Vec::new(),
            call_bytes: 0,
            result_ids: Vec::new(),
            result_bytes: 0,
            reclaim_tokens: None,
            reduced: false,
        });
        entry.ordinal = entry.ordinal.min(item.ordinal);
        if let Some(token_count) = item.token_count {
            entry.reclaim_tokens = Some(
                entry
                    .reclaim_tokens
                    .unwrap_or(0)
                    .saturating_add(token_count),
            );
        }
        // Legacy call-only reductions must not strand a still-live result.
        if matches!(item.kind, SelKind::ToolResult { .. }) && frozen.contains(&item.id) {
            entry.reduced = true;
        }
        match &item.kind {
            SelKind::ToolCall { name, input } => {
                entry.name = normalize_tool_name(name);
                entry.dedup_name = name.clone();
                if entry.call_inputs.is_empty() {
                    entry.input = input.clone();
                    entry.owner_message_id = item_message_id(item).map(str::to_owned);
                }
                entry.call_inputs.push((item.id.clone(), input.clone()));
                entry.call_bytes += item.byte_size;
                entry.provider_executed = item.provider_executed;
            }
            SelKind::ToolResult { tool_name } => {
                if entry.name.is_empty() {
                    entry.name = normalize_tool_name(tool_name);
                    entry.dedup_name = tool_name.clone();
                }
                let block_index = item
                    .id
                    .rsplit_once('#')
                    .and_then(|(_, index)| index.parse::<usize>().ok())
                    .unwrap_or(0);
                if (item.ordinal, block_index)
                    > (entry.dedup_result_ordinal, entry.dedup_result_block_index)
                {
                    entry.dedup_result_ordinal = item.ordinal;
                    entry.dedup_result_block_index = block_index;
                }
                entry.result_ids.push(item.id.clone());
                entry.result_bytes += item.byte_size;
                if item.provider_executed {
                    entry.provider_executed = true;
                }
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

#[derive(Default)]
struct ReasoningMessageShape {
    has_reasoning: bool,
    has_durable_non_tool_sibling: bool,
    tool_arc_ids: HashSet<String>,
}

fn item_message_id(item: &SelItem) -> Option<&str> {
    let (mid, index) = item.id.rsplit_once('#')?;
    index.parse::<usize>().ok().map(|_| mid)
}

struct AdjacencyMessageShape<'a> {
    mid: &'a str,
    ordinal: u64,
    role: SelMessageRole,
    has_reasoning: bool,
    items: Vec<&'a SelItem>,
}

impl AdjacencyMessageShape<'_> {
    fn fully_removed_by_arc(&self) -> Option<&str> {
        let arc_id = self.items.first()?.arc_id.as_deref()?;
        self.items
            .iter()
            .all(|item| {
                item.arc_id.as_deref() == Some(arc_id)
                    && matches!(
                        item.kind,
                        SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
                    )
            })
            .then_some(arc_id)
    }

    fn is_result_separator(&self) -> bool {
        self.role == SelMessageRole::NonAssistant
            && self
                .items
                .iter()
                .any(|item| matches!(item.kind, SelKind::ToolResult { .. }))
    }
}

/// Arc ids whose complete removal would erase a tool-result separator and expose
/// reasoning-bearing assistant content to a provider-side same-role merge.
fn reasoning_adjacency_collapse_arc_ids(items: &[SelItem]) -> HashSet<String> {
    let mut messages: HashMap<&str, AdjacencyMessageShape<'_>> = HashMap::new();
    for item in items {
        let Some(mid) = item_message_id(item) else {
            continue;
        };
        let message = messages
            .entry(mid)
            .or_insert_with(|| AdjacencyMessageShape {
                mid,
                ordinal: item.ordinal,
                role: item.message_role,
                has_reasoning: false,
                items: Vec::new(),
            });
        message.ordinal = message.ordinal.min(item.ordinal);
        message.has_reasoning |=
            matches!(item.kind, SelKind::Reasoning | SelKind::RedactedReasoning);
        message.items.push(item);
    }
    let mut messages = messages.into_values().collect::<Vec<_>>();
    messages.sort_by(|left, right| {
        left.ordinal
            .cmp(&right.ordinal)
            .then_with(|| left.mid.cmp(right.mid))
    });

    let mut removable_by_arc: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if let Some(arc_id) = message.fully_removed_by_arc() {
            removable_by_arc.entry(arc_id).or_default().push(index);
        }
    }

    removable_by_arc
        .into_iter()
        .filter_map(|(arc_id, indexes)| {
            let hazardous = indexes
                .chunk_by(|left, right| *right == *left + 1)
                .any(|run| {
                    let first = run[0];
                    let last = run[run.len() - 1];
                    let Some(left) = first.checked_sub(1).and_then(|index| messages.get(index))
                    else {
                        return false;
                    };
                    let Some(right) = messages.get(last + 1) else {
                        return false;
                    };
                    run.iter()
                        .any(|index| messages[*index].is_result_separator())
                        && left.role == SelMessageRole::Assistant
                        && right.role == SelMessageRole::Assistant
                        && (left.has_reasoning || right.has_reasoning)
                });
            hazardous.then(|| arc_id.to_string())
        })
        .collect()
}

/// Tool arcs in an assistant that consists only of native reasoning plus reducible tool blocks
/// are not reduction candidates. Reasoning cannot be rewritten, so changing every remaining
/// tool sibling would either strand a reasoning-only message or mutate a signed assistant turn.
pub(crate) fn reasoning_ineligible_arc_ids(items: &[SelItem]) -> HashSet<String> {
    let mut messages: HashMap<&str, ReasoningMessageShape> = HashMap::new();
    for item in items {
        let Some(mid) = item_message_id(item) else {
            continue;
        };
        let message = messages.entry(mid).or_default();
        match &item.kind {
            SelKind::Reasoning | SelKind::RedactedReasoning => message.has_reasoning = true,
            SelKind::ToolCall { .. } | SelKind::ToolResult { .. } if !item.provider_executed => {
                if let Some(arc_id) = &item.arc_id {
                    message.tool_arc_ids.insert(arc_id.clone());
                } else {
                    message.has_durable_non_tool_sibling = true;
                }
            }
            SelKind::ToolCall { .. } | SelKind::ToolResult { .. } => {
                message.has_durable_non_tool_sibling = true;
            }
            _ => message.has_durable_non_tool_sibling = true,
        }
    }

    messages
        .into_values()
        .filter(|message| message.has_reasoning && !message.has_durable_non_tool_sibling)
        .flat_map(|message| message.tool_arc_ids)
        .collect()
}

pub(crate) fn filter_reasoning_ineligible_decisions(
    items: &[SelItem],
    decisions: Vec<ReductionDecision>,
) -> Vec<ReductionDecision> {
    let ineligible_arcs = reasoning_ineligible_arc_ids(items);
    if ineligible_arcs.is_empty() {
        return decisions;
    }
    let arc_by_block_id: HashMap<&str, &str> = items
        .iter()
        .filter_map(|item| Some((item.id.as_str(), item.arc_id.as_deref()?)))
        .collect();
    decisions
        .into_iter()
        .filter(|decision| {
            arc_by_block_id
                .get(decision.target_id.as_str())
                .is_none_or(|arc_id| !ineligible_arcs.contains(*arc_id))
        })
        .collect()
}

// --- payload builders (PURE functions of the block's immutable bytes) ---

/// The provider-neutral reduced-content placeholder for a fully-dropped block. Selection
/// stays pure over immutable block bytes; the transform freeze path adds a durable tag
/// reference when the target already has a minted visible tag number.
const DROPPED_PLACEHOLDER: &str = "[dropped]";

/// Clamp a diff value to a region hint (edit_marker): first `EDIT_REGION_HINT_LEN`
/// UTF-16 units + the sentinel. Idempotent (already-hinted values pass through). Pure.
fn region_hint(value: &str) -> String {
    if value.ends_with(TRUNCATION_SENTINEL) {
        return value.to_string();
    }
    if utf16_len(value) > EDIT_REGION_HINT_LEN {
        format!(
            "{}{}",
            utf16_prefix(value, EDIT_REGION_HINT_LEN),
            TRUNCATION_SENTINEL
        )
    } else {
        value.to_string()
    }
}

/// Build the edit_marker payload for a superseded edit/write ToolCall: filePath-like
/// keys VERBATIM, diff keys clamped to a region hint, other keys untouched. Object
/// insertion order is retained because TypeScript mutates the original object in place;
/// that order survives the frozen payload's later parse and provider-wire render.
fn edit_marker_payload(input: &serde_json::Value) -> String {
    let mut obj = match input.as_object() {
        Some(o) => o.clone(),
        None => return DROPPED_PLACEHOLDER.to_string(),
    };
    let key_order = obj
        .remove(EDIT_INPUT_KEY_ORDER_MARKER)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
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
    if key_order.is_empty() {
        return serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default();
    }
    let mut seen = HashSet::new();
    let mut keys = key_order
        .into_iter()
        .filter(|key| obj.contains_key(key) && seen.insert(key.clone()))
        .collect::<Vec<_>>();
    keys.extend(
        obj.keys()
            .filter(|key| seen.insert((*key).clone()))
            .cloned(),
    );
    let fields = keys
        .into_iter()
        .filter_map(|key| {
            let value = obj.get(&key)?;
            Some(format!(
                "{}:{}",
                serde_json::to_string(&key).ok()?,
                serde_json::to_string(value).ok()?
            ))
        })
        .collect::<Vec<_>>();
    format!("{{{}}}", fields.join(","))
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
    /// Keep the call with its real arguments; only the results are reduced.
    SkeletonReal,
    /// Older than the window: fully drop the call block.
    FullDrop,
    /// TS duplicate-tool cleanup always fully drops older calls. It bypasses the ordinary
    /// recency skeleton window, but still demotes for reasoning-adjacency safety.
    DedupFullDrop,
    /// Edit-supersession: keep filePath + a region hint (regardless of window).
    EditMarker,
}

/// The legacy model-visible input of a frozen `skeleton` ToolCall shell. Only replayed
/// for units frozen before the real-or-absent rule, until a HARD fold converts them.
/// The tagged form is a pure function of the durable tag id; the renderer fills in
/// the tag from its durable overlay.
pub(crate) fn dropped_input_payload(tag_id: Option<i64>) -> String {
    let sentinel = tag_id.map_or_else(
        || DROPPED_PLACEHOLDER.to_string(),
        |tag_id| format!("[dropped §{tag_id}§]"),
    );
    canonical_json(&serde_json::json!({ "dropped": sentinel }))
}

/// When removing every arc in `removed_arcs` would leave the request's final message
/// without the content that makes it a valid request end, return the arc to keep (as a
/// real-argument skeleton) instead: the newest removed arc in that message.
///
/// The final message is the newest non-system message in `items`. An assistant final
/// message must keep at least one tool result (it is what closes the conversation with a
/// user turn); any other role must keep some non-reasoning block. Frozen blocks are not
/// counted as survivors, which can only keep an extra skeleton, never remove one.
/// Anthropic models without assistant prefill reject a request that ends on assistant
/// text, so this mirrors the TypeScript `wouldStrandConversationEnd` rule.
fn request_end_arc_to_keep(
    items: &[SelItem],
    removed_arcs: &HashSet<String>,
    frozen: &HashSet<String>,
) -> Option<String> {
    let end = items
        .iter()
        .filter(|item| item.message_role != SelMessageRole::System)
        .max_by_key(|item| item.ordinal)?;
    let end_mid = item_message_id(end)?;
    let end_role = end.message_role;
    let in_end = items
        .iter()
        .filter(|item| item_message_id(item) == Some(end_mid))
        .collect::<Vec<_>>();
    let removed_here = in_end
        .iter()
        .filter_map(|item| item.arc_id.as_deref())
        .filter(|arc_id| removed_arcs.contains(*arc_id))
        .collect::<BTreeSet<_>>();
    if removed_here.is_empty() {
        return None;
    }
    let survives = |item: &&&SelItem| {
        item.arc_id
            .as_deref()
            .is_none_or(|arc_id| !removed_arcs.contains(arc_id))
            && !frozen.contains(&item.id)
            && !matches!(item.kind, SelKind::Reasoning | SelKind::RedactedReasoning)
    };
    let strands = if end_role == SelMessageRole::Assistant {
        !in_end
            .iter()
            .filter(survives)
            .any(|item| matches!(item.kind, SelKind::ToolResult { .. }))
    } else {
        !in_end.iter().any(|item| survives(&item))
    };
    if !strands {
        return None;
    }
    in_end
        .iter()
        .filter(|item| {
            item.arc_id
                .as_deref()
                .is_some_and(|arc_id| removed_here.contains(arc_id))
        })
        .max_by(|left, right| {
            let index = |item: &SelItem| {
                item.id
                    .rsplit_once('#')
                    .and_then(|(_, index)| index.parse::<usize>().ok())
                    .unwrap_or(0)
            };
            index(left)
                .cmp(&index(right))
                .then_with(|| left.arc_id.cmp(&right.arc_id))
        })
        .and_then(|item| item.arc_id.clone())
}

/// Re-decide legacy `skeleton` call units (arguments replaced by the `{"dropped": …}`
/// marker) under the real-or-absent rule. Called ONLY while a HARD fold rebuilds the
/// frozen unit set, so the byte change rides that fold's cache bust; every other pass
/// keeps replaying the legacy bytes.
///
/// `legacy_call_ids` are the call block ids of the legacy units; `removed_call_ids` are
/// call blocks already reduced to `drop` in the same rebuild (they count as removed for
/// the request-end check). Returns the new kind per legacy call present in `items`:
/// `skeleton_real` for a small input, a reasoning-adjacent arc, or the call whose result
/// ends the request; `drop` otherwise. The legacy marker was only written inside the
/// newest-call window or where removal was unsafe, so each is re-decided as a window drop.
pub(crate) fn legacy_skeleton_conversions(
    items: &[SelItem],
    legacy_call_ids: &BTreeSet<String>,
    removed_call_ids: &HashSet<String>,
    frozen: &HashSet<String>,
) -> BTreeMap<String, &'static str> {
    let reasoning_adjacency = reasoning_adjacency_collapse_arc_ids(items);
    let mut kinds = BTreeMap::new();
    let mut candidates = HashSet::new();
    let mut removed_arcs = HashSet::new();
    for item in items {
        let (SelKind::ToolCall { input, .. }, Some(arc_id)) = (&item.kind, &item.arc_id) else {
            continue;
        };
        if removed_call_ids.contains(&item.id) {
            removed_arcs.insert(arc_id.clone());
        }
        if !legacy_call_ids.contains(&item.id) {
            continue;
        }
        if is_small_tool_input(input) || reasoning_adjacency.contains(arc_id) {
            kinds.insert(item.id.clone(), "skeleton_real");
        } else {
            kinds.insert(item.id.clone(), "drop");
            candidates.insert(arc_id.clone());
            removed_arcs.insert(arc_id.clone());
        }
    }
    // The request end may also be closed by frozen results the legacy arcs still carry;
    // those stop surviving once their call is removed, so do not count them.
    if let Some(keep) = request_end_arc_to_keep(items, &removed_arcs, frozen) {
        if candidates.contains(&keep) {
            for item in items {
                if item.arc_id.as_deref() == Some(keep.as_str())
                    && matches!(item.kind, SelKind::ToolCall { .. })
                    && kinds.contains_key(&item.id)
                {
                    kinds.insert(item.id.clone(), "skeleton_real");
                }
            }
        }
    }
    kinds
}

/// Expand a reduced arc into its per-block [`ReductionDecision`]s: the ToolCall block
/// takes the shape kind and paired ToolResults are dropped. Reasoning stays verbatim;
/// reasoning-only message shapes have already been excluded from the candidate pool.
/// Skips blocks that are already frozen (never re-decide) or absent.
fn expand_arc(
    arc: &ToolArc,
    shape: ArcShape,
    frozen: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    for (call_id, input) in &arc.call_inputs {
        if !frozen.contains(call_id) {
            let (kind, payload) = match shape {
                ArcShape::SkeletonReal => (RedKind::SkeletonReal, DROPPED_PLACEHOLDER.to_string()),
                ArcShape::FullDrop | ArcShape::DedupFullDrop => {
                    (RedKind::Drop, DROPPED_PLACEHOLDER.to_string())
                }
                ArcShape::EditMarker => (RedKind::EditMarker, edit_marker_payload(input)),
            };
            out.push(ReductionDecision {
                target_id: call_id.clone(),
                kind: kind.as_str().to_string(),
                payload,
            });
        }
    }
    for result_id in &arc.result_ids {
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

fn protected_tool_arc_ids(arcs: &[ToolArc], config: &SelectionConfig) -> HashSet<String> {
    let mut counts = default_protected_tools();
    for (name, count) in &config.protected_tools {
        counts.insert(normalize_tool_name(name), *count);
    }
    let mut newest_first: Vec<&ToolArc> = arcs
        .iter()
        .filter(|arc| !arc.reduced && !arc.result_ids.is_empty())
        .collect();
    // Tag allocation follows result position, including the block index when
    // parallel results share an owner ordinal. Lexical arc ids are not tag order.
    newest_first.sort_by(|left, right| {
        right
            .dedup_result_ordinal
            .cmp(&left.dedup_result_ordinal)
            .then_with(|| {
                right
                    .dedup_result_block_index
                    .cmp(&left.dedup_result_block_index)
            })
            .then_with(|| right.arc_id.cmp(&left.arc_id))
    });
    let mut protected = HashSet::new();
    for arc in newest_first {
        if let Some(count) = counts.get_mut(&arc.name) {
            if *count > 0 {
                protected.insert(arc.arc_id.clone());
                *count -= 1;
            }
        }
    }
    protected
}

/// Derive the continuation floor from the complete mutable tail. Blocks behind the
/// module's coverage boundary are already frozen and cannot be supersession candidates,
/// while every candidate and every newer owner remains in `items`.
fn recent_supersession_owner_message_ids(items: &[SelItem], arcs: &[ToolArc]) -> HashSet<String> {
    let owner_by_arc = arcs
        .iter()
        .filter_map(|arc| Some((arc.arc_id.as_str(), arc.owner_message_id.as_ref()?.as_str())))
        .collect::<HashMap<_, _>>();
    let mut latest_ordinal_by_owner = HashMap::<&str, u64>::new();
    for item in items {
        let owner = match item.arc_id.as_deref() {
            Some(arc_id) => owner_by_arc.get(arc_id).copied(),
            None => item_message_id(item),
        };
        let Some(owner) = owner else {
            continue;
        };
        latest_ordinal_by_owner
            .entry(owner)
            .and_modify(|ordinal| *ordinal = (*ordinal).max(item.ordinal))
            .or_insert(item.ordinal);
    }
    let mut newest_first = latest_ordinal_by_owner.into_iter().collect::<Vec<_>>();
    newest_first.sort_by(|(left_owner, left_ordinal), (right_owner, right_ordinal)| {
        right_ordinal
            .cmp(left_ordinal)
            .then_with(|| right_owner.cmp(left_owner))
    });
    newest_first
        .into_iter()
        .take(SUPERSESSION_RECENT_MESSAGE_WINDOW)
        .map(|(owner, _)| owner.to_string())
        .collect()
}

/// For active tool-call/result groups, drop older todowrite/ctx_reduce results
/// and zero-value metadata calls; drop ctx_note only for read/dismiss actions.
/// Keep a short path-and-diff marker for older edit/write calls to the same file.
/// Consider newest calls first and let the caller expand intents into block-level
/// changes. Exclude calls already summarized or not executed by the client.
fn select_supersession(
    arcs: &[&ToolArc],
    recent_message_ids: &HashSet<String>,
) -> HashMap<String, ArcIntent> {
    let mut intents: HashMap<String, ArcIntent> = HashMap::new();
    // Newest calls determine which results and file edits remain current.
    let mut newest_first: Vec<&&ToolArc> = arcs.iter().collect();
    newest_first.sort_by(|a, b| {
        b.ordinal
            .cmp(&a.ordinal)
            .then_with(|| b.arc_id.cmp(&a.arc_id))
    });

    let mut seen_file: HashSet<String> = HashSet::new();

    for arc in newest_first {
        let name = arc.name.as_str();
        // Keep the newest edit to each file; mark older edits for that file.
        if is_edit_tool(name) {
            if let Some(fp) = read_input_str(&arc.input, FILE_PATH_KEYS) {
                if seen_file.contains(&fp) {
                    if arc
                        .owner_message_id
                        .as_ref()
                        .is_some_and(|owner| !recent_message_ids.contains(owner))
                    {
                        intents
                            .entry(arc.arc_id.clone())
                            .or_insert(ArcIntent { edit_marker: true });
                    }
                } else {
                    seen_file.insert(fp); // newest edit to this file stays full
                }
            }
            // no resolvable filePath → skip (fail-safe); still fall through to name rules
        }
        // Older completed control and metadata results no longer carry current state.
        let is_drop_target =
            if name == "todowrite" || name == "ctx_reduce" || ZERO_VALUE_META_TOOLS.contains(&name)
            {
                true
            } else if name == "ctx_note" {
                read_input_str(&arc.input, &["action"])
                    .map(|a| CTX_NOTE_ZERO_VALUE_ACTIONS.contains(&a.as_str()))
                    .unwrap_or(false)
            } else {
                false
            };
        if is_drop_target
            && arc
                .owner_message_id
                .as_ref()
                .is_some_and(|owner| !recent_message_ids.contains(owner))
        {
            // If another rule also selects this arc, remove it rather than marking it.
            intents.insert(arc.arc_id.clone(), ArcIntent { edit_marker: false });
        }
    }
    intents
}

/// Select older completed duplicate calls from safe tools. The owner is in both the lookup key
/// and the fingerprint, so identical calls from distinct assistant messages stay distinct.
/// Arguments use `serde_json` serialization; a serialization failure skips that candidate.
/// Protected arcs join their group so a protected newest copy still anchors it, but are never
/// selected themselves; leaving them out kept one unprotected copy beside the protected one.
fn select_tool_dedup(arcs: &[&ToolArc], ctx: &SelectionContext) -> HashSet<String> {
    // Like the TS tag-side index, retain an owner-qualified lookup key separately
    // from the fingerprint bucket. The owner must also remain in the fingerprint value.
    let mut by_owner_arc: HashMap<(String, String), (&ToolArc, String)> = HashMap::new();
    for arc in arcs {
        if !DEDUP_SAFE_TOOLS.contains(&arc.dedup_name.as_str())
            || arc.owner_message_id.is_none()
            || arc.result_ids.is_empty()
        {
            continue;
        }
        let Some(args) = serde_json::to_string(&arc.input).ok() else {
            continue;
        };
        let owner_message_id = arc
            .owner_message_id
            .as_ref()
            .expect("owner checked above")
            .clone();
        let fingerprint = format!("{owner_message_id}:{}:{args}", arc.dedup_name);
        by_owner_arc.insert((owner_message_id, arc.arc_id.clone()), (*arc, fingerprint));
    }

    let mut groups: HashMap<String, Vec<&ToolArc>> = HashMap::new();
    for (_, (arc, fingerprint)) in by_owner_arc {
        groups.entry(fingerprint).or_default().push(arc);
    }
    groups
        .into_values()
        .flat_map(|mut group| {
            if group.len() <= 1 {
                return Vec::new();
            }
            group.sort_by(|left, right| {
                left.dedup_result_ordinal
                    .cmp(&right.dedup_result_ordinal)
                    .then_with(|| {
                        left.dedup_result_block_index
                            .cmp(&right.dedup_result_block_index)
                    })
                    .then_with(|| left.arc_id.cmp(&right.arc_id))
            });
            // Preserve the newest (highest tool-result position, then stable arc id).
            group.pop();
            group
                .into_iter()
                .filter(|arc| {
                    !arc.call_inputs
                        .iter()
                        .any(|(id, _)| ctx.block_is_protected(id))
                        && !arc.result_ids.iter().any(|id| ctx.block_is_protected(id))
                })
                .map(|arc| arc.arc_id.clone())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn reclaim_ride_available(ctx: &SelectionContext) -> bool {
    // The force band's own ride: an armed episode, or the absolute 95% arm whatever the
    // episode (TypeScript `rideSignals.force`).
    ctx.pass_already_busting
        || ctx.supersession_ride_available
        || (ctx.pass_class == PassClass::EmergencyForce
            && (!ctx.has_prior_drop || ctx.emergency_window_yields))
}

fn two_pass_batch_can_apply(ctx: &SelectionContext) -> bool {
    reclaim_ride_available(ctx)
}

/// A rebuild other than the emergency itself already rewrites the prefix on this pass:
/// an independent rebuild known before selection, or queued agent drops applying now.
/// Mirrors the TypeScript `emergencyRewriteAlreadyPriced`.
fn emergency_rewrite_already_priced(ctx: &SelectionContext, agent_drops_applied: bool) -> bool {
    ctx.emergency_minimum_waived || agent_drops_applied
}

/// The force episode already spent its one emergency batch, and nothing on this pass
/// re-arms it: not the absolute 95% arm, not a rewrite that is already paid for. A ride
/// that only permits mutation (a subagent execute pass) does not re-arm it. Mirrors the
/// TypeScript `emergencyEpisodeRearms` followed by `emergencyEpisodeLatched`.
fn emergency_episode_latched(ctx: &SelectionContext, agent_drops_applied: bool) -> bool {
    ctx.pass_class == PassClass::EmergencyForce
        && ctx.has_prior_drop
        && !ctx.emergency_window_yields
        && !emergency_rewrite_already_priced(ctx, agent_drops_applied)
}

/// Which automatic lanes may first-apply on this pass. Whether a lane then changes bytes
/// depends on it finding candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LaneGates {
    /// Queued `ctx_reduce` drops.
    pub agent_drops: bool,
    /// The force band's tiered emergency drop.
    pub emergency: bool,
    /// Duplicate-tool cleanup, the routine heuristic lane.
    pub dedup: bool,
    /// The two-pass age sweep.
    pub age_sweep: bool,
    /// Spent control-plane supersession and superseded-edit markers.
    pub supersession: bool,
}

/// The lane gates of the TypeScript postprocess phase, applied to this selection pass.
/// `agent_drops_applied` says whether queued drops first-apply on it.
/// - Queued drops need a pass that already rebuilds.
/// - At the force band the emergency selector owns tool reclaim: the age sweep and
///   supersession wait (`toolReclaimAdmitted`), and a spent episode keeps the emergency
///   drop and routine cleanup latched until a priced rewrite or the 95% arm re-arms it.
pub(crate) fn lane_gates(ctx: &SelectionContext, agent_drops_applied: bool) -> LaneGates {
    let ride = reclaim_ride_available(ctx);
    let force_band = ctx.pass_class == PassClass::EmergencyForce;
    let latched = emergency_episode_latched(ctx, agent_drops_applied);
    LaneGates {
        agent_drops: ctx.pass_already_busting,
        emergency: ride && force_band && !latched,
        dedup: ride && !latched,
        age_sweep: ride && !force_band,
        supersession: ride && !force_band,
    }
}

/// 1.4 Age-based two-pass: tool arcs whose age (ToolCall ordinal) is at/under the
/// last-execute watermark. Add-only (the watermark advances forward). Returns arc ids.
fn select_two_pass(
    arcs: &[&ToolArc],
    ctx: &SelectionContext,
    protected: &HashSet<String>,
    admitted: bool,
) -> HashSet<String> {
    if !admitted || ctx.last_execute_ordinal == 0 {
        return HashSet::new();
    }
    arcs.iter()
        .filter(|arc| !protected.contains(&arc.arc_id))
        .filter(|arc| arc.ordinal <= ctx.last_execute_ordinal)
        .filter(|arc| {
            arc.reclaim_tokens
                .is_none_or(|tokens| tokens >= AGE_RECLAIM_MIN_TOKENS)
        })
        .map(|arc| arc.arc_id.clone())
        .collect()
}

/// 1.5 ctx_reduce agent-drop: the caller-supplied marked ids (a control-plane side
/// input). These are already flat block ids; emitted directly as drops (arc-atomic
/// isn't needed — the agent marks specific blocks). Frozen/absent filtered by caller.
fn select_agent_drops(
    ctx: &SelectionContext,
    live_ids: &HashSet<String>,
    frozen: &HashSet<String>,
    protected_tools: &HashSet<String>,
    out: &mut Vec<ReductionDecision>,
) {
    for id in &ctx.agent_drop_ids {
        if frozen.contains(id)
            || !live_ids.contains(id)
            || ctx.block_is_protected(id)
            || protected_tools.contains(id)
        {
            continue;
        }
        // Queued drops consume permission; neither pressure nor another command creates it.
        if !ctx.pass_already_busting {
            continue;
        }
        out.push(ReductionDecision {
            target_id: id.clone(),
            kind: RedKind::Drop.as_str().to_string(),
            payload: DROPPED_PLACEHOLDER.to_string(),
        });
    }
}

/// True when a tool result is coordination state rather than useful reclaim guidance.
pub(crate) fn is_reclaim_hint_excluded_tool(name: &str) -> bool {
    let normalized = normalize_tool_name(name);
    normalized.starts_with("ctx_") || RECLAIM_HINT_EXCLUDED_TOOLS.contains(&normalized.as_str())
}

/// Tier of a tool for the emergency drop: T1 nav (keep longest), T2 edit·search, T3
/// misc (drop first). Mirrors the TS `resolveToolTier`.
pub(crate) fn resolve_tool_tier(name: &str) -> u8 {
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

/// Reconstruct the active floor-tag population. A tool arc is one tag in the TS planner, so its
/// call/result/reasoning bytes are aggregated before the per-tag token rounding is applied.
fn active_floor_tokens(
    items: &[SelItem],
    frozen_keys: &HashSet<String>,
    calibration: Option<crate::decision_calibration::DecisionCalibration>,
) -> f64 {
    if let Some(seed) = calibration {
        return items
            .iter()
            .filter(|item| {
                !frozen_keys.contains(&item.id)
                    && item.message_role != SelMessageRole::System
                    && !matches!(item.kind, SelKind::Opaque | SelKind::Media)
            })
            .map(|item| {
                let ratio = if matches!(
                    item.kind,
                    SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
                ) {
                    seed.tools_ratio
                } else {
                    seed.prose_ratio
                };
                item.served_token_count.or(item.token_count).unwrap_or(0) as f64 * ratio
            })
            .sum();
    }
    let mut tool_tag_bytes: HashMap<&str, usize> = HashMap::new();
    let mut tokens = 0.0;
    for item in items.iter().filter(|item| {
        !frozen_keys.contains(&item.id)
            && item.message_role != SelMessageRole::System
            && !matches!(item.kind, SelKind::Opaque)
    }) {
        if let Some(arc_id) = item.arc_id.as_deref() {
            tool_tag_bytes
                .entry(arc_id)
                .and_modify(|bytes| *bytes = bytes.saturating_add(item.byte_size))
                .or_insert(item.byte_size);
        } else {
            tokens += bytes_to_tokens(item.byte_size);
        }
    }
    tokens
        + tool_tag_bytes
            .into_values()
            .map(bytes_to_tokens)
            .sum::<f64>()
}

/// 1.3 Emergency tiered drop (derived force-band). Target headroom = fixedFloor + 0.30 ×
/// (ceiling − fixedFloor); walk T3→T2→T1 oldest-first, skipping the protected tail
/// and the newest-20% T1/T2 reserve, until reclaim met. The floor covers every active
/// live tag class, while candidates remain active tool arcs. Returns the arc ids to full-drop.
fn select_emergency(
    arcs: &[&ToolArc],
    protected: &HashSet<String>,
    ctx: &SelectionContext,
    all_active_floor_tokens: f64,
    reclaim_by_arc: &HashMap<String, f64>,
    assessment: &mut Option<mc_store::EmergencyDropAssessment>,
) -> HashSet<String> {
    // Guards mirror the TS planner: unknown ceiling/usage → no-op; idempotence latch.
    if !ctx.ceiling_tokens.is_finite() || ctx.ceiling_tokens <= 0.0 {
        return HashSet::new();
    }
    if !ctx.current_total_input_tokens.is_finite() || ctx.current_total_input_tokens <= 0.0 {
        return HashSet::new();
    }
    // The spent-episode latch is decided by `lane_gates` before this selector runs.

    let fixed_floor = (ctx.current_total_input_tokens - all_active_floor_tokens).max(0.0);
    let working_span = (ctx.ceiling_tokens - fixed_floor).max(0.0);
    let target = fixed_floor + TARGET_FRACTION * working_span;
    // TS rounds the scalar target reclaim before applying the re-arm floor. Keep the
    // comparison on that rounded value; comparing the raw float can fire for a
    // sub-threshold fractional remainder at the boundary.
    let reclaim_tokens = (ctx.current_total_input_tokens - target).round();
    let floor_above_ceiling = fixed_floor > ctx.ceiling_tokens;
    if floor_above_ceiling {
        tracing::info!(
            "mc-module: emergency drop: fixed floor ~{:.0} already exceeds ceiling {:.0}; tool drops cannot reach the target",
            fixed_floor,
            ctx.ceiling_tokens
        );
    }
    // Rewriting tools cannot fix oversized fixed overhead. Preserve results and
    // let final admission handle overflow, even if another mutation already
    // requires a cache rewrite.
    if floor_above_ceiling || reclaim_tokens <= EMERGENCY_REARM_MIN_TOKENS {
        *assessment = Some(mc_store::EmergencyDropAssessment {
            fixed_floor_tokens: fixed_floor,
            target_tokens: target,
            required_reclaim_tokens: reclaim_tokens.max(0.0),
            selected_reclaim_tokens: 0.0,
            candidate_tokens: 0.0,
            target_unreachable: reclaim_tokens > 0.0,
            floor_above_ceiling,
            skipped_below_minimum_reclaim: false,
        });
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
            let reserve_count = if ctx.emergency_window_yields {
                0
            } else {
                (TIER_RECENCY_RESERVE * nums.len() as f64).ceil() as usize
            };
            for arc in nums.iter().take(reserve_count) {
                reserved.insert(arc.arc_id.clone());
            }
        }
    }

    // Protect ctx_reduce exemplars without changing the target math. The fixed floor
    // above already derives from every active floor tag, so removing candidates changes
    // neither the floor nor target (panel-verified emergency interaction).

    // Build candidates per tier (persisted protected identities + reserve excluded).
    let mut by_tier: HashMap<u8, Vec<&&ToolArc>> = HashMap::new();
    for arc in arcs {
        if protected.contains(&arc.arc_id) {
            continue;
        }
        if arc
            .call_inputs
            .iter()
            .any(|(id, _)| ctx.block_is_protected(id))
            || arc.result_ids.iter().any(|id| ctx.block_is_protected(id))
        {
            continue;
        }
        let tier = resolve_tool_tier(&arc.name);
        if (tier == 1 || tier == 2) && reserved.contains(&arc.arc_id) {
            continue;
        }
        by_tier.entry(tier).or_default().push(arc);
    }

    // Summed in tier order: floating-point addition is not associative, so summing in
    // the hash map's per-process iteration order could give a different last bit for the
    // same candidates from one run to the next.
    let mut candidate_tiers = by_tier.keys().copied().collect::<Vec<_>>();
    candidate_tiers.sort_unstable();
    let candidate_tokens = candidate_tiers
        .iter()
        .flat_map(|tier| by_tier[tier].iter())
        .map(|arc| {
            reclaim_by_arc
                .get(&arc.arc_id)
                .copied()
                .unwrap_or_else(|| bytes_to_tokens(arc.reclaim_bytes()))
        })
        .sum::<f64>();
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
                reclaimed += reclaim_by_arc
                    .get(&arc.arc_id)
                    .copied()
                    .unwrap_or_else(|| bytes_to_tokens(arc.reclaim_bytes()));
                if reclaimed >= reclaim_tokens {
                    break 'outer;
                }
            }
        }
    }
    // Price the selection before committing it. Skipping leaves the pressure episode
    // armed, so the candidates can still ride a later rewrite.
    let skipped_below_minimum_reclaim = !selected.is_empty()
        && !ctx.emergency_minimum_waived
        && reclaimed < EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS;
    if skipped_below_minimum_reclaim {
        tracing::info!(
            "mc-module: emergency drop skipped: achievable reclaim ~{:.0} < {:.0} against gap {:.0} ({} arcs)",
            reclaimed,
            EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS,
            reclaim_tokens,
            selected.len()
        );
    }
    *assessment = Some(mc_store::EmergencyDropAssessment {
        fixed_floor_tokens: fixed_floor,
        target_tokens: target,
        required_reclaim_tokens: reclaim_tokens,
        selected_reclaim_tokens: if skipped_below_minimum_reclaim {
            0.0
        } else {
            reclaimed
        },
        candidate_tokens,
        target_unreachable: skipped_below_minimum_reclaim || reclaimed < reclaim_tokens,
        floor_above_ceiling,
        skipped_below_minimum_reclaim,
    });
    if skipped_below_minimum_reclaim {
        return HashSet::new();
    }
    selected
}

#[derive(Debug, Default)]
pub(crate) struct SelectionOutcome {
    pub protected_tool_block_ids: HashSet<String>,
    pub decisions: Vec<ReductionDecision>,
    pub emergency_drop_assessment: Option<mc_store::EmergencyDropAssessment>,
    /// The force episode had spent its emergency batch, and a rewrite that is already paid
    /// for re-armed it on this pass. The caller clears the persisted latch, as the
    /// TypeScript plugin clears its emergency sample, before recording any new batch.
    pub emergency_episode_rearmed: bool,
    /// The pressure pass was already busting, or was in the force band, so the age
    /// batch had an application opportunity. Empty opportunities still advance the
    /// watermark so future arcs can age into a later batch.
    pub two_pass_batch_can_apply: bool,
    /// Live superseded arcs counted at the existing selector call inside an open ride gate.
    /// `active_arcs` excludes any arc with a frozen member, so this depth can shrink between rides.
    /// Missing means the gate stayed shut and the selector did not run.
    pub eligible_supersession_count: Option<usize>,
    /// Eligible supersession arcs entirely removed by the newest-tag block window.
    pub supersession_withheld_by_tag_window_count: Option<usize>,
    /// Eligible supersession arcs entirely removed by a whole-message exemption.
    pub supersession_withheld_by_exempt_message_count: Option<usize>,
    /// Eligible supersession arcs represented in the final decision list after every filter.
    pub applied_supersession_count: Option<usize>,
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
    select_reductions_with_outcome(items, frozen_keys, ctx, cfg).decisions
}

/// Served-or-original token totals for one tool arc, as emergency reclaim
/// accounting sees them: every call and result block, and the call blocks alone
/// (a skeleton-kept call keeps its arguments, so only its results shrink).
struct ArcTokenTotals {
    call_and_result: f64,
    call: f64,
}

impl Default for ArcTokenTotals {
    /// Both totals start from the value `Iterator::sum` returns for an empty
    /// `f64` iterator, and blocks are added one at a time in item order. That
    /// is exactly the fold a per-arc `.sum()` over the same blocks performs, so
    /// the totals are bit-identical to summing each arc separately.
    fn default() -> Self {
        let empty = std::iter::empty::<f64>().sum::<f64>();
        Self {
            call_and_result: empty,
            call: empty,
        }
    }
}

/// Totals every arc's call and result tokens in one pass over `items`, so
/// emergency accounting does not rescan all items once per arc.
fn emergency_arc_token_totals(items: &[SelItem]) -> HashMap<&str, ArcTokenTotals> {
    let mut totals: HashMap<&str, ArcTokenTotals> = HashMap::new();
    for item in items {
        let Some(arc_id) = item.arc_id.as_deref() else {
            continue;
        };
        let is_call = matches!(item.kind, SelKind::ToolCall { .. });
        if !is_call && !matches!(item.kind, SelKind::ToolResult { .. }) {
            continue;
        }
        let tokens = item.served_token_count.or(item.token_count).unwrap_or(0) as f64;
        let arc = totals.entry(arc_id).or_default();
        arc.call_and_result += tokens;
        if is_call {
            arc.call += tokens;
        }
    }
    totals
}

/// Calibrated reclaim estimate per active arc for an emergency pass; empty when
/// the pass has no calibration seed.
fn emergency_reclaim_by_arc(
    items: &[SelItem],
    active_arcs: &[&ToolArc],
    ctx: &SelectionContext,
    reasoning_adjacency_collapse_arcs: &HashSet<String>,
) -> HashMap<String, f64> {
    let mut reclaim_by_arc = HashMap::new();
    let Some(seed) = ctx.calibration else {
        return reclaim_by_arc;
    };
    let recent: HashSet<_> = active_arcs
        .iter()
        .rev()
        .take(RECENT_TOOL_SKELETON_WINDOW)
        .map(|a| a.arc_id.as_str())
        .collect();
    let arc_tokens = emergency_arc_token_totals(items);
    let no_tokens = ArcTokenTotals::default();
    for arc in active_arcs {
        let totals = arc_tokens.get(arc.arc_id.as_str()).unwrap_or(&no_tokens);
        let before = totals.call_and_result;
        let skeleton = (!ctx.emergency_window_yields
            && recent.contains(arc.arc_id.as_str())
            && is_small_tool_input(&arc.input))
            || reasoning_adjacency_collapse_arcs.contains(&arc.arc_id);
        // A kept call keeps its real arguments, so its call blocks reclaim
        // nothing; only the results shrink to the placeholder. Include a
        // conservative tag-overlay allowance because tag ids are installed
        // by the renderer.
        let after = if skeleton {
            totals.call
                + (arc.result_ids.len() * (mc_tokenizer::estimate_tokens(DROPPED_PLACEHOLDER) + 32))
                    as f64
        } else {
            0.0
        };
        reclaim_by_arc.insert(
            arc.arc_id.clone(),
            (before - after).max(0.0) * seed.tools_ratio,
        );
    }
    reclaim_by_arc
}

pub(crate) fn select_reductions_with_outcome(
    items: &[SelItem],
    frozen_keys: &HashSet<String>,
    ctx: &SelectionContext,
    cfg: &SelectionConfig,
) -> SelectionOutcome {
    let arcs = group_arcs(items, frozen_keys);
    let protected_tools = protected_tool_arc_ids(&arcs, cfg);
    let protected_tool_block_ids = arcs
        .iter()
        .filter(|arc| protected_tools.contains(&arc.arc_id))
        .flat_map(|arc| {
            arc.call_inputs
                .iter()
                .map(|(id, _)| id.clone())
                .chain(arc.result_ids.iter().cloned())
        })
        .collect();
    if ctx.pass_class == PassClass::Defer {
        return SelectionOutcome {
            protected_tool_block_ids,
            ..SelectionOutcome::default()
        };
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
    let supersession_recent_message_ids = recent_supersession_owner_message_ids(items, &arcs);
    let incomplete_arc_ids = arcs
        .iter()
        .filter(|arc| arc.result_ids.is_empty())
        .map(|arc| arc.arc_id.as_str())
        .collect::<HashSet<_>>();
    let reasoning_ineligible_arcs = reasoning_ineligible_arc_ids(items);
    let user_answer_arcs: HashSet<&str> = items
        .iter()
        .filter(|item| item.user_answer)
        .filter_map(|item| item.arc_id.as_deref())
        .collect();
    let arc_by_block_id: HashMap<&str, &str> = items
        .iter()
        .filter_map(|item| Some((item.id.as_str(), item.arc_id.as_deref()?)))
        .collect();
    let arc_allows_reduction = |id: &str| {
        arc_by_block_id.get(id).is_none_or(|arc_id| {
            !incomplete_arc_ids.contains(*arc_id) && !reasoning_ineligible_arcs.contains(*arc_id)
        })
    };
    // Apply the same arc guards to queued drops as to automatic reductions, including the
    // whole-arc protection applied to the final decision list below, so this set is exactly
    // the queued drops that first-apply on this pass.
    let mut agent_decisions = Vec::new();
    select_agent_drops(
        ctx,
        &live_ids,
        frozen_keys,
        &protected_tool_block_ids,
        &mut agent_decisions,
    );
    agent_decisions.retain(|decision| arc_allows_reduction(&decision.target_id));
    let protected_arcs: HashSet<&str> = items
        .iter()
        .filter(|item| ctx.block_is_protected(&item.id))
        .filter_map(|item| item.arc_id.as_deref())
        .collect();
    agent_decisions.retain(|decision| {
        !arc_by_block_id
            .get(decision.target_id.as_str())
            .is_some_and(|arc_id| protected_arcs.contains(arc_id))
    });
    let gates = lane_gates(ctx, !agent_decisions.is_empty());
    let emergency_episode_rearmed = ctx.pass_class == PassClass::EmergencyForce
        && ctx.has_prior_drop
        && reclaim_ride_available(ctx)
        && emergency_rewrite_already_priced(ctx, !agent_decisions.is_empty());
    let two_pass_batch_can_apply = two_pass_batch_can_apply(ctx);
    let reasoning_adjacency_collapse_arcs = reasoning_adjacency_collapse_arc_ids(items);
    // A running call has no completed/errored result and is never reclaimable. This
    // matches the TypeScript targets' completion guard and prevents a selector from
    // rewriting tool input while the provider is still executing it.
    let active_arcs: Vec<&ToolArc> = arcs
        .iter()
        .filter(|a| {
            !a.reduced
                && !a.provider_executed
                && !user_answer_arcs.contains(a.arc_id.as_str())
                && !incomplete_arc_ids.contains(a.arc_id.as_str())
                && !reasoning_ineligible_arcs.contains(&a.arc_id)
        })
        .collect();
    let arc_by_id: HashMap<&str, &ToolArc> = active_arcs
        .iter()
        .map(|arc| (arc.arc_id.as_str(), *arc))
        .collect();

    // Per-arc reduction intents (arc_id → shape), assembled in TS precedence order.
    let mut arc_shapes: HashMap<String, ArcShape> = HashMap::new();
    // Dedup precedes age selection, as in the TS heuristic pass. An older duplicate
    // removed here must not also enter the two-pass age batch.
    let dedup_arc_ids = if gates.dedup {
        select_tool_dedup(&active_arcs, ctx)
            .into_iter()
            .filter(|id| !protected_tools.contains(id))
            .collect()
    } else {
        HashSet::new()
    };
    let arcs_after_dedup: Vec<&ToolArc> = active_arcs
        .iter()
        .copied()
        .filter(|arc| !dedup_arc_ids.contains(&arc.arc_id))
        .collect();
    let two_pass_arc_ids =
        select_two_pass(&arcs_after_dedup, ctx, &protected_tools, gates.age_sweep);
    let mut eligible_supersession_arc_ids = None;
    let mut emergency_drop_assessment = None;

    match ctx.pass_class {
        PassClass::EmergencyForce => {
            // Floor accounting and eviction candidates have different populations. Every
            // unfrozen tagged-content class contributes to the fixed-floor derivation, including
            // text, media, reasoning, and non-droppable tools; system-prefix and opaque metadata
            // remain outside that population. Only active client tool arcs can be selected below.
            let emergency_arc_ids = if gates.emergency {
                let all_active_floor_tokens =
                    active_floor_tokens(items, frozen_keys, ctx.calibration);
                let reclaim_by_arc = emergency_reclaim_by_arc(
                    items,
                    &active_arcs,
                    ctx,
                    &reasoning_adjacency_collapse_arcs,
                );
                select_emergency(
                    &active_arcs,
                    &protected_tools,
                    ctx,
                    all_active_floor_tokens,
                    &reclaim_by_arc,
                    &mut emergency_drop_assessment,
                )
            } else {
                HashSet::new()
            };
            // Routine cleanup shares the episode's one pressure rewrite. The age sweep and
            // supersession wait below the band (`lane_gates`), as in the TypeScript plugin,
            // where the emergency selector owns tool reclaim in the force band.
            for arc_id in &dedup_arc_ids {
                arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
            }
            for arc_id in &emergency_arc_ids {
                arc_shapes
                    .entry(arc_id.clone())
                    .or_insert(ArcShape::FullDrop);
            }
        }
        PassClass::Execute => {
            // Order = dedup (drop) → two-pass (drop) → control-plane (drop) → edit (edit_marker).
            // drop wins: a later edit_marker never overrides an assigned drop. The transform maps
            // ordinary scheduler Execute here only when classification identifies an independent
            // bust opportunity; an active background historian defers ordinary executes first.
            for arc_id in &dedup_arc_ids {
                arc_shapes.insert(arc_id.clone(), ArcShape::DedupFullDrop);
            }
            for arc_id in &two_pass_arc_ids {
                arc_shapes
                    .entry(arc_id.clone())
                    .or_insert(ArcShape::FullDrop);
            }
            // Supersession is deferred work: ordinary execute-band pressure and a held
            // emergency latch cannot authorize a rewrite. Concrete scheduled work or an
            // admitted two-pass batch lets the whole pending set ride the same bust.
            if gates.supersession {
                // Count the exact selector output before overlap precedence removes members.
                let mut intents =
                    select_supersession(&active_arcs, &supersession_recent_message_ids);
                intents.retain(|id, intent| {
                    !protected_tools.contains(id)
                        && (!intent.edit_marker
                            || arc_by_id[id.as_str()].ordinal <= ctx.last_execute_ordinal)
                });
                eligible_supersession_arc_ids =
                    Some(intents.keys().cloned().collect::<HashSet<_>>());
                for (arc_id, intent) in intents {
                    if arc_shapes.contains_key(&arc_id) {
                        continue; // already a drop (two-pass) → drop wins
                    }
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

    // The persisted token window supplements the structural newest-20 owner floor. Protect the
    // whole arc when either half is a member, avoiding partially superseded call/result pairs.
    let protected_supersession_arcs = |protected_block_ids: &HashSet<String>| {
        eligible_supersession_arc_ids.as_ref().map(|eligible| {
            eligible
                .iter()
                .filter(|arc_id| {
                    arc_by_id.get(arc_id.as_str()).is_some_and(|arc| {
                        arc.call_inputs
                            .iter()
                            .any(|(id, _)| protected_block_ids.contains(id))
                            || arc
                                .result_ids
                                .iter()
                                .any(|id| protected_block_ids.contains(id))
                    })
                })
                .cloned()
                .collect::<HashSet<_>>()
        })
    };
    let yielded_window = HashSet::new();
    let supersession_arcs_with_tag_window_protection =
        protected_supersession_arcs(if ctx.emergency_window_yields {
            &yielded_window
        } else {
            &ctx.tag_window_protected_block_ids
        });
    let supersession_arcs_with_exempt_message_protection =
        protected_supersession_arcs(&ctx.exempt_message_protected_block_ids);

    // Resolve fresh full-drop intents to a real-argument skeleton when recency (with a small
    // input) or removal safety requires a result shell; a large input in the window is
    // removed like an older one. Decided ONCE here (freeze-time): frozen_keys excludes
    // replayed arcs, so neither an aging window nor a newly detected adjacency can change
    // frozen bytes. EditMarker is window-independent.
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

    let mut resolved_shapes: Vec<(&ToolArc, ArcShape)> = Vec::new();
    for (arc_id, shape) in &arc_shapes {
        let Some(arc) = arc_by_id.get(arc_id.as_str()) else {
            continue;
        };
        if supersession_arcs_with_tag_window_protection
            .as_ref()
            .is_some_and(|protected| protected.contains(arc_id))
            || supersession_arcs_with_exempt_message_protection
                .as_ref()
                .is_some_and(|protected| protected.contains(arc_id))
        {
            continue;
        }
        let resolved = match shape {
            ArcShape::EditMarker => ArcShape::EditMarker,
            ArcShape::SkeletonReal => ArcShape::SkeletonReal,
            ArcShape::FullDrop
                if reasoning_adjacency_collapse_arcs.contains(arc_id)
                    || (skeleton_window.contains(arc_id) && is_small_tool_input(&arc.input)) =>
            {
                ArcShape::SkeletonReal
            }
            ArcShape::DedupFullDrop if reasoning_adjacency_collapse_arcs.contains(arc_id) => {
                ArcShape::SkeletonReal
            }
            ArcShape::FullDrop => ArcShape::FullDrop,
            ArcShape::DedupFullDrop => ArcShape::DedupFullDrop,
        };
        resolved_shapes.push((arc, resolved));
    }
    // Never remove the tool result the request ends with: keep that call with its real
    // arguments instead (see request_end_arc_to_keep).
    let removed_arcs = resolved_shapes
        .iter()
        .filter(|(_, shape)| matches!(shape, ArcShape::FullDrop | ArcShape::DedupFullDrop))
        .map(|(arc, _)| arc.arc_id.clone())
        .collect::<HashSet<_>>();
    let keep_request_end = request_end_arc_to_keep(items, &removed_arcs, frozen_keys);
    let mut out: Vec<ReductionDecision> = Vec::new();
    for (arc, shape) in resolved_shapes {
        let shape = if keep_request_end.as_deref() == Some(arc.arc_id.as_str()) {
            ArcShape::SkeletonReal
        } else {
            shape
        };
        expand_arc(arc, shape, frozen_keys, &mut out);
    }

    // ctx_reduce agent drops stay block-granular, but pass-through carriers are absent
    // from live_ids so Media and Opaque can never become reduction targets.
    select_agent_drops(
        ctx,
        &live_ids,
        frozen_keys,
        &protected_tool_block_ids,
        &mut out,
    );

    // Agent-directed ids can name either half of a tool arc, so apply the same whole-message
    // guard after their block-granular decisions have been added.
    out.retain(|decision| arc_allows_reduction(&decision.target_id));

    // Withhold the whole arc when either half is protected. Freezing only its call
    // would leave a live result paired with a reduced invocation on later passes.
    out.retain(|decision| {
        !ctx.block_is_protected(&decision.target_id)
            && !arc_by_block_id
                .get(decision.target_id.as_str())
                .is_some_and(|arc_id| protected_arcs.contains(arc_id))
    });

    // Deterministic merge: exactly one decision per target (drop > edit_marker >
    // skeleton), stable output order (by target_id).
    let decisions = dedupe_and_sort(out);
    let applied_supersession_arcs = eligible_supersession_arc_ids.as_ref().map(|eligible| {
        decisions
            .iter()
            .filter_map(|decision| arc_by_block_id.get(decision.target_id.as_str()).copied())
            .filter(|arc_id| eligible.contains(*arc_id))
            .map(str::to_string)
            .collect::<HashSet<_>>()
    });
    let withheld_count = |protected: &Option<HashSet<String>>| {
        protected
            .as_ref()
            .zip(applied_supersession_arcs.as_ref())
            .map(|(protected, applied)| protected.difference(applied).count())
    };
    SelectionOutcome {
        protected_tool_block_ids,
        decisions,
        emergency_drop_assessment,
        emergency_episode_rearmed,
        two_pass_batch_can_apply,
        eligible_supersession_count: eligible_supersession_arc_ids.as_ref().map(HashSet::len),
        supersession_withheld_by_tag_window_count: withheld_count(
            &supersession_arcs_with_tag_window_protection,
        ),
        supersession_withheld_by_exempt_message_count: withheld_count(
            &supersession_arcs_with_exempt_message_protection,
        ),
        applied_supersession_count: applied_supersession_arcs.as_ref().map(HashSet::len),
    }
}

/// Return blocks protected by the keep counts frozen when the reminder's tail
/// baseline was last rebuilt. Config changes take effect after a rebuilding pass
/// saves a new baseline.
pub(crate) fn protected_blocks_for_policy(
    items: &[SelItem],
    frozen: &HashSet<String>,
    counts: &std::collections::BTreeMap<String, usize>,
) -> HashSet<String> {
    let arcs = group_arcs(items, frozen);
    let protected = protected_tool_arc_ids(
        &arcs,
        &SelectionConfig {
            protected_tools: counts.clone(),
            ..SelectionConfig::default()
        },
    );
    arcs.iter()
        .filter(|arc| protected.contains(&arc.arc_id))
        .flat_map(|arc| {
            arc.call_inputs
                .iter()
                .map(|(id, _)| id.clone())
                .chain(arc.result_ids.iter().cloned())
        })
        .collect()
}

/// Collapse to one decision per target_id (drop beats edit_marker beats skeleton) and
/// sort by target_id for byte-deterministic output.
fn dedupe_and_sort(decisions: Vec<ReductionDecision>) -> Vec<ReductionDecision> {
    fn rank(kind: &str) -> u8 {
        match kind {
            "drop" => 3,
            "edit_marker" => 2,
            "skeleton" | "skeleton_real" => 1,
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
            user_answer: false,
            served_token_count: None,
            id: id.clone(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(id),
        }
    }

    fn tool_result(mid: &str, ordinal: u64, name: &str, bytes: usize) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: result_block_id(mid),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn reasoning(mid: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: reasoning_block_id(mid),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(call_block_id(mid)),
        }
    }

    fn reasoning_with_id(id: &str, arc_id: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(arc_id.to_string()),
        }
    }

    fn text_with_id(id: &str, ordinal: u64, bytes: usize) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: None,
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
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::ToolCall {
                name: name.to_string(),
                input,
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
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
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::ToolResult {
                tool_name: name.to_string(),
            },
            provider_executed: false,
            byte_size: bytes,
            token_count: None,
            arc_id: Some(arc_id.to_string()),
        }
    }

    #[test]
    fn contract_consumed_episode_emergency95_parity_golden() {
        let items = vec![
            tool_call("protected", 1, "bash", serde_json::json!({}), 100),
            tool_result("protected", 2, "bash", 160_000),
        ];
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 65_000.0;
        ctx.has_prior_drop = true;
        ctx.prior_input_sample = 85_000.0;
        ctx.tag_window_protected_block_ids
            .insert(result_block_id("protected"));
        assert!(
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default())
                .is_empty()
        );
        ctx.current_total_input_tokens = 96_000.0;
        ctx.emergency_window_yields = true;
        let decisions =
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            decisions
                .iter()
                .map(|d| d.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["protected#0", "protected#1"]
        );
    }

    /// A tool loop at >=95% pressure (the recency window yields): the newest tool
    /// call/result pair is what ends the provider request with a user turn. The
    /// emergency drop may reduce that pair only to a call skeleton plus a result
    /// placeholder; removing it would end the request on an assistant turn, which
    /// models without prefill support reject. The TypeScript OpenCode and Pi drop
    /// targets enforce the same rule.
    #[test]
    fn emergency_at_window_yield_keeps_the_newest_arc_as_a_skeleton() {
        let mut items = vec![text_with_id("prompt#0", 1, 100)];
        for n in 1..=8u64 {
            let mid = format!("c{n}");
            items.push(tool_call(
                &mid,
                n * 2,
                "bash",
                serde_json::json!({"command": "cat"}),
                100,
            ));
            items.push(tool_result(&mid, n * 2 + 1, "bash", 40_000));
        }
        // Pressure far past the ceiling so the tiered walk reaches every arc.
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 80_000.0;
        ctx.ceiling_tokens = 1_000.0;
        ctx.emergency_window_yields = true;
        let decisions =
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(!decisions.is_empty());
        let newest_call = decisions
            .iter()
            .find(|d| d.target_id == call_block_id("c8"))
            .expect("the newest arc is selected at window yield");
        assert_eq!(newest_call.kind, "skeleton_real");
        let newest_result = decisions
            .iter()
            .find(|d| d.target_id == result_block_id("c8"))
            .expect("the newest result is reduced in place");
        assert_eq!(newest_result.payload, DROPPED_PLACEHOLDER);
    }

    #[test]
    fn contract_legacy_call_only_reduction_does_not_strand_result() {
        let items = vec![
            tool_call("legacy", 1, "bash", serde_json::json!({}), 100),
            tool_result("legacy", 2, "bash", 160_000),
        ];
        let frozen = HashSet::from([call_block_id("legacy")]);
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 96_000.0;
        ctx.ceiling_tokens = 65_000.0;
        ctx.emergency_window_yields = true;
        let outcome = select_reductions(&items, &frozen, &ctx, &SelectionConfig::default());
        assert!(outcome
            .iter()
            .any(|d| d.target_id == result_block_id("legacy")));
        assert!(!outcome
            .iter()
            .any(|d| d.target_id == call_block_id("legacy")));
    }

    /// The candidate total is the same on every run for the same candidates, whatever
    /// order the per-tier map happens to iterate in.
    #[test]
    fn emergency_candidate_total_does_not_depend_on_map_iteration_order() {
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 142_021.0;
        ctx.ceiling_tokens = 116_900.0;
        ctx.emergency_window_yields = true;
        let mut items = vec![text_with_id("text", 1, 240_000)];
        let mut reclaim = HashMap::new();
        // One arc per tier, with amounts whose sum depends on the order they are added in.
        for (n, (name, tokens)) in [("read", 0.1), ("edit", 0.2), ("bash", 0.3)]
            .into_iter()
            .enumerate()
        {
            let mid = format!("tool-{n}");
            items.push(tool_call(
                &mid,
                n as u64 + 2,
                name,
                serde_json::json!({}),
                0,
            ));
            items.push(tool_result(&mid, n as u64 + 2, name, 8_000));
            reclaim.insert(call_block_id(&mid), tokens);
        }
        let arcs = group_arcs(&items, &HashSet::new());
        let arcs = arcs.iter().collect::<Vec<_>>();
        let totals = (0..64)
            .map(|_| {
                let mut assessment = None;
                select_emergency(
                    &arcs,
                    &HashSet::new(),
                    &ctx,
                    80_000.0,
                    &reclaim,
                    &mut assessment,
                );
                assessment.unwrap().candidate_tokens.to_bits()
            })
            .collect::<HashSet<_>>();
        assert_eq!(totals.len(), 1, "{totals:?}");
    }

    #[test]
    fn emergency_floor_walk_exhausts_candidates_or_reaches_target() {
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 142_021.0;
        ctx.ceiling_tokens = 116_900.0;
        let mut items = vec![text_with_id("text", 1, 240_000)];
        for n in 0..10 {
            let mid = format!("tool-{n}");
            items.push(tool_call(&mid, n + 2, "bash", serde_json::json!({}), 0));
            items.push(tool_result(&mid, n + 2, "bash", 8_000));
        }
        let arcs = group_arcs(&items, &HashSet::new());
        let arcs = arcs.iter().collect::<Vec<_>>();
        let mut assessment = None;
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            80_000.0,
            &HashMap::new(),
            &mut assessment,
        );
        let report = assessment.as_ref().unwrap();
        assert_eq!(selected.len(), 10);
        assert_eq!(report.fixed_floor_tokens, 62_021.0);
        assert!((report.target_tokens - 78_484.7).abs() < 0.01);
        assert_eq!(report.required_reclaim_tokens, 63_536.0);
        assert_eq!(report.selected_reclaim_tokens, 20_000.0);
        assert!(report.target_unreachable);
        ctx.tag_window_protected_block_ids
            .extend((1..10).map(|n| result_block_id(&format!("tool-{n}"))));
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            80_000.0,
            &HashMap::new(),
            &mut assessment,
        );
        let report = assessment.as_ref().unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(report.candidate_tokens, 2_000.0);
        assert!(report.target_unreachable);
        ctx.emergency_window_yields = true;
        ctx.current_total_input_tokens = 20_000.0;
        ctx.ceiling_tokens = 20_000.0;
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            20_000.0,
            &HashMap::new(),
            &mut assessment,
        );
        let report = assessment.as_ref().unwrap();
        assert_eq!(selected.len(), 7);
        assert_eq!(report.selected_reclaim_tokens, 14_000.0);
        assert!(!report.target_unreachable);
    }

    /// Isolate the small-selection price gate with a reachable fixed floor.
    /// Reaching 95% does not itself waive the minimum reclaim needed to justify
    /// a cache rewrite. Allow this small batch only when another mutation already
    /// requires that rewrite.
    #[test]
    fn emergency_skips_a_selection_below_the_minimum_achievable_reclaim() {
        let items = vec![
            text_with_id("conversation", 1, 36_204),
            tool_call("fresh", 2, "bash", serde_json::json!({}), 0),
            tool_result("fresh", 3, "bash", 596),
        ];
        let arcs = group_arcs(&items, &HashSet::new());
        let arcs = arcs.iter().collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 335_200.0;
        ctx.ceiling_tokens = 327_000.0;
        ctx.emergency_window_yields = true;
        ctx.pass_already_busting = true;
        let mut assessment = None;
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            9_200.0,
            &HashMap::new(),
            &mut assessment,
        );
        let report = assessment.as_ref().unwrap();
        assert!(selected.is_empty());
        assert!(report.skipped_below_minimum_reclaim);
        assert!(!report.floor_above_ceiling);
        assert_eq!(report.selected_reclaim_tokens, 0.0);

        ctx.emergency_minimum_waived = true;
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            9_200.0,
            &HashMap::new(),
            &mut assessment,
        );
        let report = assessment.as_ref().unwrap();
        assert_eq!(selected.len(), 1);
        assert!(!report.skipped_below_minimum_reclaim);
        assert!(!report.floor_above_ceiling);
    }

    #[test]
    fn issue_731_impossible_fixed_overhead_preserves_tool_results() {
        let items = vec![
            tool_call("read", 1, "read", serde_json::json!({}), 0),
            tool_result("read", 2, "read", 6_400),
            tool_call("bash", 3, "bash", serde_json::json!({}), 0),
            tool_result("bash", 4, "bash", 6_324),
        ];
        let arcs = group_arcs(&items, &HashSet::new());
        let arcs = arcs.iter().collect::<Vec<_>>();
        for yields in [false, true] {
            for waived in [false, true] {
                let mut ctx = base_ctx(PassClass::EmergencyForce);
                ctx.current_total_input_tokens = 144_520.0;
                ctx.ceiling_tokens = 93_938.0;
                ctx.emergency_window_yields = yields;
                ctx.emergency_minimum_waived = waived;
                ctx.pass_already_busting = true;
                let mut assessment = None;
                let selected = select_emergency(
                    &arcs,
                    &HashSet::new(),
                    &ctx,
                    3_181.0,
                    &HashMap::new(),
                    &mut assessment,
                );
                assert!(selected.is_empty());
                let report = assessment.unwrap();
                assert_eq!(report.fixed_floor_tokens, 141_339.0);
                assert!(report.floor_above_ceiling);
                assert!(report.target_unreachable);
                assert_eq!(report.selected_reclaim_tokens, 0.0);
            }
        }
    }

    #[test]
    fn issue_731_real_95_yields_when_reclaim_reaches_target() {
        let items = vec![
            tool_call("bash", 1, "bash", serde_json::json!({}), 0),
            tool_result("bash", 2, "bash", 40_000),
            tool_call("read", 3, "read", serde_json::json!({}), 0),
            tool_result("read", 4, "read", 40_000),
        ];
        let arcs = group_arcs(&items, &HashSet::new());
        let arcs = arcs.iter().collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 20_000.0;
        ctx.ceiling_tokens = 13_000.0;
        ctx.emergency_window_yields = true;
        ctx.tag_window_protected_block_ids = items.iter().map(|item| item.id.clone()).collect();
        let mut assessment = None;
        let selected = select_emergency(
            &arcs,
            &HashSet::new(),
            &ctx,
            20_000.0,
            &HashMap::new(),
            &mut assessment,
        );
        assert_eq!(selected.len(), 2);
        let report = assessment.unwrap();
        assert!(!report.target_unreachable);
        assert_eq!(report.required_reclaim_tokens, 16_100.0);
    }

    #[test]
    fn calibrated_emergency_uses_current_token_mass_not_original_bytes() {
        let mut items = Vec::new();
        for i in 1..=30 {
            let id = format!("c{i}");
            items.push(tool_call(&id, i, "bash", serde_json::json!({}), 40_000));
            items.push(tool_result(&id, i, "bash", 40_000));
        }
        for item in &mut items {
            item.token_count = Some(10);
        }
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.calibration = Some(crate::decision_calibration::DecisionCalibration::for_model(
            Some("anthropic/claude-fable-5-1"),
        ));
        ctx.current_total_input_tokens = 10_000.0;
        ctx.ceiling_tokens = 8_000.0;
        let result = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(result.decisions.is_empty());
    }

    /// The emergency reclaim estimate as it was computed before arc token totals
    /// were gathered in one pass: each arc rescanned every item. Kept only as
    /// the differential reference for the test below.
    fn rescanning_emergency_reclaim_by_arc(
        items: &[SelItem],
        active_arcs: &[&ToolArc],
        ctx: &SelectionContext,
        reasoning_adjacency_collapse_arcs: &HashSet<String>,
    ) -> HashMap<String, f64> {
        let mut reclaim_by_arc = HashMap::new();
        let seed = ctx.calibration.unwrap();
        let recent: HashSet<_> = active_arcs
            .iter()
            .rev()
            .take(RECENT_TOOL_SKELETON_WINDOW)
            .map(|a| a.arc_id.as_str())
            .collect();
        for arc in active_arcs {
            let before = items
                .iter()
                .filter(|item| {
                    item.arc_id.as_deref() == Some(arc.arc_id.as_str())
                        && matches!(
                            item.kind,
                            SelKind::ToolCall { .. } | SelKind::ToolResult { .. }
                        )
                })
                .map(|item| item.served_token_count.or(item.token_count).unwrap_or(0) as f64)
                .sum::<f64>();
            let skeleton = (!ctx.emergency_window_yields
                && recent.contains(arc.arc_id.as_str())
                && is_small_tool_input(&arc.input))
                || reasoning_adjacency_collapse_arcs.contains(&arc.arc_id);
            let after = if skeleton {
                let call_tokens = items
                    .iter()
                    .filter(|item| {
                        item.arc_id.as_deref() == Some(arc.arc_id.as_str())
                            && matches!(item.kind, SelKind::ToolCall { .. })
                    })
                    .map(|item| item.served_token_count.or(item.token_count).unwrap_or(0) as f64)
                    .sum::<f64>();
                call_tokens
                    + (arc.result_ids.len()
                        * (mc_tokenizer::estimate_tokens(DROPPED_PLACEHOLDER) + 32))
                        as f64
            } else {
                0.0
            };
            reclaim_by_arc.insert(
                arc.arc_id.clone(),
                (before - after).max(0.0) * seed.tools_ratio,
            );
        }
        reclaim_by_arc
    }

    /// One-pass arc totals must give bit-identical reclaim estimates to the
    /// per-arc rescan, and the full emergency selection built on them must pick
    /// the same reductions in the same order. The fixture mixes served and
    /// original counts, arcs with several calls and results, reasoning inside
    /// arcs, reasoning-adjacent arcs, small and large inputs, and arcs with no
    /// counted blocks.
    #[test]
    fn one_pass_emergency_totals_match_per_arc_rescan() {
        let mut items = Vec::new();
        let mut ordinal = 0;
        for i in 0..120usize {
            let arc = format!("arc{i}");
            let input = if i % 3 == 0 {
                serde_json::json!({ "command": "x".repeat(4_000) })
            } else {
                serde_json::json!({ "path": format!("f{i}") })
            };
            if i % 5 == 0 {
                ordinal += 1;
                items.push(reasoning_with_id(
                    &format!("r{i}"),
                    &arc,
                    ordinal as u64,
                    300,
                ));
            }
            for call in 0..(1 + i % 2) {
                ordinal += 1;
                let mut item = tool_call_with_ids(
                    &format!("{arc}c{call}"),
                    &arc,
                    ordinal as u64,
                    "bash",
                    input.clone(),
                    500,
                );
                item.token_count = (i % 7 != 0).then_some(40 + i * 3 + call);
                item.served_token_count = (i % 4 == 1).then_some(11 + i);
                items.push(item);
            }
            for result in 0..(1 + i % 3) {
                ordinal += 1;
                let mut item = tool_result_with_ids(
                    &format!("{arc}r{result}"),
                    &arc,
                    ordinal as u64,
                    "bash",
                    2_000,
                );
                item.token_count = Some(900 + i * 13 + result);
                item.served_token_count = (i % 6 == 2).then_some(7 + result);
                items.push(item);
            }
            if i % 10 == 0 {
                ordinal += 1;
                items.push(text_with_id(&format!("t{i}"), ordinal as u64, 1_000));
            }
        }
        let arcs = group_arcs(&items, &HashSet::new());
        let active_arcs: Vec<&ToolArc> = arcs.iter().collect();
        assert!(active_arcs.len() >= 100);
        let collapse = reasoning_adjacency_collapse_arc_ids(&items);
        for yields in [false, true] {
            let mut ctx = base_ctx(PassClass::EmergencyForce);
            ctx.calibration = Some(crate::decision_calibration::DecisionCalibration::for_model(
                Some("anthropic/claude-fable-5-1"),
            ));
            ctx.emergency_window_yields = yields;
            let current = emergency_reclaim_by_arc(&items, &active_arcs, &ctx, &collapse);
            let reference =
                rescanning_emergency_reclaim_by_arc(&items, &active_arcs, &ctx, &collapse);
            assert_eq!(current.len(), reference.len());
            for (arc_id, value) in &reference {
                assert_eq!(
                    current[arc_id].to_bits(),
                    value.to_bits(),
                    "{arc_id} yields={yields}"
                );
            }
            // The rest of the selector is unchanged, so identical estimates
            // mean identical selection; assert it produces work to compare.
            ctx.current_total_input_tokens = 400_000.0;
            ctx.ceiling_tokens = 200_000.0;
            let outcome = select_reductions_with_outcome(
                &items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default(),
            );
            assert!(!outcome.decisions.is_empty(), "yields={yields}");
        }
    }

    #[test]
    fn user_answers_survive_every_automatic_selector_but_allow_agent_drops() {
        let mut items = vec![
            tool_call("answer", 1, "todowrite", serde_json::json!({}), 100),
            tool_result("answer", 2, "todowrite", 32_000),
            tool_call("ordinary", 3, "todowrite", serde_json::json!({}), 100),
            tool_result("ordinary", 4, "todowrite", 16_000),
            tool_call("latest", 5, "todowrite", serde_json::json!({}), 100),
            tool_result("latest", 6, "todowrite", 16_000),
        ];
        items[1].user_answer = true;
        for pass in [PassClass::Execute, PassClass::EmergencyForce] {
            let mut ctx = base_ctx(pass);
            ctx.current_total_input_tokens = 16_000.0;
            ctx.ceiling_tokens = 12_000.0;
            ctx.last_execute_ordinal = 100;
            ctx.pass_already_busting = true;
            ctx.supersession_ride_available = true;
            let outcome = select_reductions_with_outcome(
                &items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default(),
            );
            assert!(!outcome.decisions.is_empty());
            assert!(outcome
                .decisions
                .iter()
                .all(|d| !d.target_id.starts_with("answer#")));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![result_block_id("answer")];
        ctx.pass_already_busting = true;
        let outcome = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(outcome
            .decisions
            .iter()
            .any(|d| d.target_id == result_block_id("answer")));
        assert!(select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &base_ctx(PassClass::Defer),
            &SelectionConfig::default()
        )
        .decisions
        .is_empty());
    }

    fn base_ctx(pass: PassClass) -> SelectionContext {
        SelectionContext {
            calibration: None,
            pass_class: pass,
            current_total_input_tokens: 0.0,
            ceiling_tokens: 0.0,
            last_execute_ordinal: 0,
            scheduler_pressure_execute: pass == PassClass::Execute,
            prior_input_sample: 0.0,
            has_prior_drop: false,
            agent_drop_ids: Vec::new(),
            agent_drop_command_ids: HashMap::new(),
            first_applied_agent_drop_ids: HashSet::new(),
            pass_already_busting: false,
            supersession_ride_available: false,
            emergency_minimum_waived: false,
            emergency_window_yields: false,
            tag_window_protected_block_ids: HashSet::new(),
            exempt_message_protected_block_ids: HashSet::new(),
        }
    }

    // Marker fixtures represent edits already distant at a previous rebuild.
    // Keep their known total below 250 tokens so marker payload and
    // protection assertions still exercise compression, not ordinary age drops.
    fn distant_edit_fixture(items: &mut [SelItem]) -> u64 {
        let mut bookmark = 0;
        for item in items {
            match &item.kind {
                SelKind::ToolCall { name, .. } if is_edit_tool(name) => {
                    bookmark = bookmark.max(item.ordinal);
                    item.token_count = Some(0);
                }
                SelKind::ToolResult { tool_name } if is_edit_tool(tool_name) => {
                    item.token_count = Some(100);
                }
                _ => {}
            }
        }
        bookmark
    }

    #[test]
    fn natural_bust_drains_a_single_command_remainder() {
        let items = vec![SelItem {
            user_answer: false,
            served_token_count: None,
            id: "drop".to_string(),
            ordinal: 1,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 128,
            token_count: None,
            arc_id: None,
        }];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec!["drop".to_string()];
        ctx.agent_drop_command_ids
            .insert("drop".to_string(), "command-1".to_string());
        ctx.first_applied_agent_drop_ids.insert("drop".to_string());
        ctx.current_total_input_tokens = 100.0;
        ctx.ceiling_tokens = 100.0;
        ctx.pass_already_busting = true;

        let selected =
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].target_id, "drop");

        ctx.current_total_input_tokens = 99.0;
        ctx.pass_already_busting = false;
        let held = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(held.is_empty());
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

    fn served_block_bytes(
        items: &[SelItem],
        decisions: &[ReductionDecision],
    ) -> std::collections::BTreeMap<String, Vec<u8>> {
        let reductions: HashMap<&str, &str> = decisions
            .iter()
            .map(|decision| (decision.target_id.as_str(), decision.payload.as_str()))
            .collect();
        items
            .iter()
            .map(|item| {
                let bytes = reductions.get(item.id.as_str()).map_or_else(
                    || vec![b'x'; item.byte_size],
                    |payload| payload.as_bytes().to_vec(),
                );
                (item.id.clone(), bytes)
            })
            .collect()
    }

    // --- the differential golden vs the 5 TS selectors ---

    #[derive(Deserialize)]
    struct ItemJson {
        id: String,
        ordinal: u64,
        kind: serde_json::Value,
        provider_executed: bool,
        byte_size: usize,
        token_count: Option<usize>,
        arc_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct CtxJson {
        pass_class: String,
        current_total_input_tokens: f64,
        ceiling_tokens: f64,
        protected_cutoff_ordinal: u64,
        last_execute_ordinal: u64,
        scheduler_pressure_execute: bool,
        #[serde(default)]
        pass_already_busting: bool,
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

    fn golden_ordinal_threshold_to_row_identities(
        items: &[SelItem],
        ordinal_threshold: u64,
    ) -> HashSet<String> {
        if ordinal_threshold == 0 {
            return HashSet::new();
        }
        items
            .iter()
            .filter(|item| item.ordinal > ordinal_threshold)
            .map(|item| item.id.clone())
            .collect()
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
            let mut items: Vec<SelItem> = case
                .items
                .iter()
                .map(|i| {
                    let kind = parse_kind(&i.kind);
                    let message_role = if matches!(
                        kind,
                        SelKind::ToolCall { .. } | SelKind::Reasoning | SelKind::RedactedReasoning
                    ) {
                        SelMessageRole::Assistant
                    } else {
                        SelMessageRole::NonAssistant
                    };
                    SelItem {
                        user_answer: false,
                        served_token_count: None,
                        id: i.id.clone(),
                        ordinal: i.ordinal,
                        message_role,
                        kind,
                        provider_executed: i.provider_executed,
                        byte_size: i.byte_size,
                        token_count: i.token_count,
                        arc_id: i.arc_id.clone(),
                    }
                })
                .collect();
            if case.smart_drops {
                let first_padding_ordinal = items
                    .iter()
                    .map(|item| item.ordinal)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);
                for n in 0..RECENT_TOOL_SKELETON_WINDOW {
                    items.push(text_with_id(
                        &format!("golden-tail-{n}#0"),
                        first_padding_ordinal + n as u64,
                        1,
                    ));
                }
            }
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
                calibration: None,
                pass_class: pass,
                current_total_input_tokens: case.ctx.current_total_input_tokens,
                ceiling_tokens: case.ctx.ceiling_tokens,
                last_execute_ordinal: case.ctx.last_execute_ordinal,
                scheduler_pressure_execute: case.ctx.scheduler_pressure_execute,
                prior_input_sample: case.ctx.prior_input_sample,
                has_prior_drop: case.ctx.has_prior_drop,
                agent_drop_ids: case.ctx.agent_drop_ids.clone(),
                agent_drop_command_ids: HashMap::new(),
                first_applied_agent_drop_ids: HashSet::new(),
                pass_already_busting: case.smart_drops || case.ctx.pass_already_busting,
                supersession_ride_available: case.smart_drops || case.ctx.pass_already_busting,
                emergency_minimum_waived: false,
                emergency_window_yields: false,
                tag_window_protected_block_ids: golden_ordinal_threshold_to_row_identities(
                    &items,
                    case.ctx.protected_cutoff_ordinal,
                ),
                exempt_message_protected_block_ids: HashSet::new(),
            };
            let cfg = SelectionConfig {
                smart_drops: case.smart_drops,
                ..SelectionConfig::default()
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

        for kind in ["drop", "skeleton_real", "edit_marker"] {
            assert!(
                seen_reduction_kinds.contains(kind),
                "selection golden stopped exercising reduction kind '{kind}'"
            );
        }
        assert!(saw_t1_tool, "selection golden stopped exercising T1 tools");
        assert!(saw_t2_tool, "selection golden stopped exercising T2 tools");
    }

    // --- CK-model unit tests (no TS equivalent) ---

    #[derive(Deserialize)]
    struct DroppedInputMarkerGoldenCase {
        label: String,
        tag_id: i64,
        // The legacy marker never depended on the call's input; the field stays so the
        // shared golden keeps parsing.
        #[allow(dead_code)]
        input: serde_json::Value,
        expected_frozen: serde_json::Value,
        expected_tagged: serde_json::Value,
    }

    #[test]
    fn dropped_input_marker_matches_typescript_golden() {
        let cases: Vec<DroppedInputMarkerGoldenCase> =
            serde_json::from_str(include_str!("../testdata/dropped-input-marker-golden.json"))
                .expect("parse dropped-input-marker-golden.json");
        assert!(!cases.is_empty(), "empty dropped-input marker golden");
        for case in cases {
            let frozen = dropped_input_payload(None);
            let tagged = dropped_input_payload(Some(case.tag_id));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&frozen).unwrap(),
                case.expected_frozen,
                "{} frozen",
                case.label
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&tagged).unwrap(),
                case.expected_tagged,
                "{} tagged",
                case.label
            );
        }
    }

    #[derive(Deserialize)]
    struct EditMarkerGoldenCase {
        label: String,
        input: serde_json::Value,
        expected: serde_json::Value,
        input_key_order: Vec<String>,
        expected_json: String,
    }

    #[test]
    fn edit_marker_payload_matches_typescript_golden() {
        let cases: Vec<EditMarkerGoldenCase> =
            serde_json::from_str(include_str!("../testdata/edit-marker-golden.json"))
                .expect("parse edit-marker-golden.json");
        assert!(!cases.is_empty(), "empty edit-marker golden");
        for case in cases {
            let mut input = case.input;
            input.as_object_mut().unwrap().insert(
                EDIT_INPUT_KEY_ORDER_MARKER.to_string(),
                serde_json::to_value(case.input_key_order).unwrap(),
            );
            let payload = edit_marker_payload(&input);
            let actual: serde_json::Value =
                serde_json::from_str(&payload).expect("Rust edit-marker payload must remain JSON");
            assert_eq!(actual, case.expected, "{}", case.label);
            assert_eq!(payload, case.expected_json, "{} key order", case.label);
        }
    }

    #[test]
    fn rejected_agent_drop_on_open_arc_cannot_price_automatic_age_reclaim() {
        let items = vec![
            tool_call("old", 1, "bash", serde_json::json!({}), 100),
            tool_result("old", 1, "bash", 4000),
            tool_call("open", 3, "bash", serde_json::json!({}), 100),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 1;
        ctx.agent_drop_ids = vec![call_block_id("open")];
        let result = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(result.decisions.is_empty());
        assert!(!result.two_pass_batch_can_apply);
    }

    #[test]
    fn age_reclaim_requires_a_ride_not_scheduler_pressure() {
        let mut result = tool_result("c1", 1, "bash", 2_000);
        result.token_count = Some(300);
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            result,
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 1;

        let level_only = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(level_only.decisions.is_empty());
        assert!(!level_only.two_pass_batch_can_apply);

        ctx.pass_already_busting = true;
        ctx.scheduler_pressure_execute = false;
        let ride_only = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(ride_only.decisions.len(), 2);
        assert!(ride_only.two_pass_batch_can_apply);

        ctx.scheduler_pressure_execute = true;
        let admitted = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(admitted.decisions.len(), 2);
        assert!(admitted.two_pass_batch_can_apply);
    }

    #[test]
    fn supersession_measurements_distinguish_protection_sources_and_final_application() {
        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
            tool_call(
                "c3",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"three"}),
                500,
            ),
            tool_result("c3", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }
        let config = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let mut protected = base_ctx(PassClass::Execute);
        protected.last_execute_ordinal = distant_edit_fixture(&mut items);
        protected.supersession_ride_available = true;
        protected
            .tag_window_protected_block_ids
            .extend([call_block_id("c1"), result_block_id("c1")]);
        protected
            .exempt_message_protected_block_ids
            .extend([call_block_id("c2"), result_block_id("c2")]);

        let withheld = select_reductions_with_outcome(&items, &HashSet::new(), &protected, &config);
        assert_eq!(withheld.eligible_supersession_count, Some(2));
        assert_eq!(withheld.supersession_withheld_by_tag_window_count, Some(1));
        assert_eq!(
            withheld.supersession_withheld_by_exempt_message_count,
            Some(1)
        );
        assert_eq!(withheld.applied_supersession_count, Some(0));
        assert!(withheld.decisions.is_empty());

        let mut tag_only = base_ctx(PassClass::Execute);
        tag_only.last_execute_ordinal = protected.last_execute_ordinal;
        tag_only.supersession_ride_available = true;
        tag_only
            .tag_window_protected_block_ids
            .extend([call_block_id("c1"), result_block_id("c1")]);
        let partially_withheld =
            select_reductions_with_outcome(&items, &HashSet::new(), &tag_only, &config);
        assert_eq!(
            partially_withheld.supersession_withheld_by_tag_window_count,
            Some(1)
        );
        assert_eq!(
            partially_withheld.supersession_withheld_by_exempt_message_count,
            Some(0)
        );
        assert_eq!(partially_withheld.applied_supersession_count, Some(1));

        let mut unprotected = base_ctx(PassClass::Execute);
        unprotected.last_execute_ordinal = protected.last_execute_ordinal;
        unprotected.supersession_ride_available = true;
        let applied =
            select_reductions_with_outcome(&items, &HashSet::new(), &unprotected, &config);
        assert_eq!(applied.eligible_supersession_count, Some(2));
        assert_eq!(applied.supersession_withheld_by_tag_window_count, Some(0));
        assert_eq!(
            applied.supersession_withheld_by_exempt_message_count,
            Some(0)
        );
        assert_eq!(applied.applied_supersession_count, Some(2));
    }

    /// Rewritten from `force_band_applies_waiting_two_pass_batch_without_a_ride`: the age sweep
    /// never first-applies in the force band (TypeScript `toolReclaimAdmitted`), though the
    /// pass still counts as an application opportunity that advances the distance bookmark.
    #[test]
    fn force_band_leaves_the_waiting_age_batch_alone() {
        let mut result = tool_result("c1", 1, "read", 2_000);
        result.token_count = Some(300);
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({"path":"a.txt"}), 50),
            result,
        ];
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.last_execute_ordinal = 1;
        ctx.scheduler_pressure_execute = true;
        assert!(!ctx.pass_already_busting);

        let outcome = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert!(outcome.decisions.is_empty());
        assert!(outcome.two_pass_batch_can_apply);

        ctx.pass_class = PassClass::Execute;
        ctx.pass_already_busting = true;
        let below_band = select_reductions_with_outcome(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(below_band.decisions.len(), 2);
    }

    /// Rewritten from `force_band_two_pass_batch_carries_pending_supersession`: below the
    /// force band the age batch carries pending supersession; in the band both wait.
    #[test]
    fn age_batch_carries_pending_supersession_only_below_the_force_band() {
        let mut aged_result = tool_result("aged", 1, "read", 2_000);
        aged_result.token_count = Some(300);
        let mut items = vec![
            tool_call("aged", 1, "read", serde_json::json!({"path":"old.txt"}), 50),
            aged_result,
            tool_call(
                "c1",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 2, "edit", 100),
            tool_call(
                "c2",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        ctx.scheduler_pressure_execute = true;
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        ctx.pass_already_busting = true;
        let config = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let in_band = select_reductions(&items, &HashSet::new(), &ctx, &config);
        assert!(in_band
            .iter()
            .all(|decision| decision.kind != "edit_marker"));

        ctx.pass_class = PassClass::Execute;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &config);
        assert_eq!(out.len(), 4);
        assert!(out.iter().any(|decision| decision.target_id == "aged#0"));
        assert!(out
            .iter()
            .any(|decision| { decision.target_id == "c1#0" && decision.kind == "edit_marker" }));
        assert!(out
            .iter()
            .all(|decision| !decision.target_id.starts_with("c2#")));
    }

    #[test]
    fn emergency_floor_counts_non_tool_live_text_and_reasoning() {
        let mut items = Vec::new();
        for index in 0..6 {
            let mid = format!("emergency-{index}");
            items.push(tool_call(
                &mid,
                index + 1,
                "bash",
                serde_json::json!({}),
                20_000,
            ));
            items.push(tool_result(&mid, index + 1, "bash", 20_000));
        }
        items.push(text_with_id("heavy-text#0", 7, 30_000));
        items.push(SelItem {
            user_answer: false,
            served_token_count: None,
            id: "heavy-reasoning#0".to_string(),
            ordinal: 8,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::Reasoning,
            provider_executed: false,
            byte_size: 10_000,
            token_count: None,
            arc_id: None,
        });
        items.push(SelItem {
            user_answer: false,
            served_token_count: None,
            id: "irreducible-system#0".to_string(),
            ordinal: 9,
            message_role: SelMessageRole::System,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 40_000,
            token_count: None,
            arc_id: None,
        });

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());

        assert_eq!(
            arc_decisions(&items, &out).len(),
            5,
            "the true live-tail floor includes active text/reasoning but not the system prefix: {out:?}"
        );
    }

    #[test]
    fn emergency_reclaim_does_not_count_retained_reasoning() {
        let mut items = Vec::new();
        for index in 0..4 {
            let mid = format!("reasoned-{index}");
            let ordinal = index + 1;
            items.push(reasoning(&mid, ordinal, 32_000));
            items.push(tool_call(
                &mid,
                ordinal,
                "bash",
                serde_json::json!({}),
                4_000,
            ));
            items.push(SelItem {
                user_answer: false,
                served_token_count: None,
                id: format!("{mid}#3"),
                ordinal,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 1,
                token_count: None,
                arc_id: None,
            });
            items.push(tool_result(&mid, ordinal, "bash", 4_000));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());

        assert_eq!(
            arc_decisions(&items, &out).len(),
            4,
            "reasoning stays on wire, so every available call/result arc is needed: {out:?}"
        );
    }

    /// Rewritten from `emergency_eviction_carries_pending_supersession`: in the force band the
    /// emergency selector owns tool reclaim, so supersession waits for a pass below the band,
    /// as the TypeScript `toolReclaimAdmitted` gate decides.
    #[test]
    fn emergency_eviction_leaves_pending_supersession_for_a_pass_below_the_band() {
        let mut items = vec![
            tool_call("emergency", 1, "bash", serde_json::json!({}), 160_000),
            tool_result("emergency", 1, "bash", 40_000),
            tool_call(
                "c1",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 2, "edit", 100),
            tool_call(
                "c2",
                3,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 3, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 4 + n as u64, 1));
        }

        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        ctx.current_total_input_tokens = 90_000.0;
        ctx.ceiling_tokens = 100_000.0;
        ctx.pass_already_busting = true;
        let config = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let out = select_reductions(&items, &HashSet::new(), &ctx, &config);

        assert_eq!(out.len(), 2);
        assert!(out
            .iter()
            .all(|decision| decision.target_id.starts_with("emergency#")));

        ctx.pass_class = PassClass::Execute;
        let below_band = select_reductions(&items, &HashSet::new(), &ctx, &config);
        assert!(below_band
            .iter()
            .any(|decision| { decision.target_id == "c1#0" && decision.kind == "edit_marker" }));
        assert!(below_band
            .iter()
            .all(|decision| !decision.target_id.starts_with("c2#")));
    }

    #[test]
    fn sustained_execute_band_accumulates_supersession_without_trickling() {
        const PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let mut next_ordinal = 2;

        for pass in 1..=PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("pass-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::Execute);
            ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
            ctx.scheduler_pressure_execute = true;
            assert!(
                select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty(),
                "66% execute-band pressure must not admit pass {pass} supersession"
            );

            ctx.pass_already_busting = true;
            ctx.supersession_ride_available = true;
            assert_eq!(
                select_reductions(&items, &HashSet::new(), &ctx, &cfg).len(),
                pass as usize * 2,
                "the pending superseded members must accumulate as a single batch"
            );
        }
    }

    #[test]
    fn independent_bust_applies_the_whole_aged_supersession_batch() {
        let mut items = Vec::new();
        for n in 1..=4u64 {
            items.push(tool_call(
                &format!("c{n}"),
                n,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{n}")}),
                500,
            ));
            items.push(tool_result(&format!("c{n}"), n, "edit", 100));
        }
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 5 + n as u64, 1));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        ctx.scheduler_pressure_execute = true;
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        assert_eq!(out.len(), 6, "all three superseded arcs must ride together");
        assert_eq!(
            out.iter()
                .filter(|decision| decision.kind == "edit_marker")
                .count(),
            3,
            "each superseded call becomes an edit marker"
        );
        assert!(out
            .iter()
            .all(|decision| !decision.target_id.starts_with("c4#")));
    }

    #[test]
    fn idle_force_band_defers_aged_supersession_without_changing_served_bytes() {
        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"two"}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
        ];
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 3 + n as u64, 1));
        }

        let cfg = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let previous =
            select_reductions(&items, &HashSet::new(), &base_ctx(PassClass::Execute), &cfg);
        assert!(previous.is_empty());
        let previous_served = served_block_bytes(&items, &previous);

        let mut emergency_ctx = base_ctx(PassClass::EmergencyForce);
        emergency_ctx.current_total_input_tokens = 90_000.0;
        emergency_ctx.ceiling_tokens = 100_000.0;
        emergency_ctx.has_prior_drop = true;
        let emergency = select_reductions(&items, &HashSet::new(), &emergency_ctx, &cfg);

        assert!(
            emergency.is_empty(),
            "an idle force band cannot create a bust"
        );
        assert_eq!(served_block_bytes(&items, &emergency), previous_served);
    }

    #[test]
    fn sustained_idle_force_band_holds_supersession_for_a_pass_below_the_band() {
        const IDLE_PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let mut next_ordinal = 2;
        let mut self_caused_busts = 0;

        for pass in 1..=IDLE_PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("pass-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::EmergencyForce);
            ctx.current_total_input_tokens = 90_000.0;
            ctx.ceiling_tokens = 100_000.0;
            ctx.has_prior_drop = true;
            if !select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty() {
                self_caused_busts += 1;
            }
        }

        assert_eq!(self_caused_busts, 0, "idle force passes must not trickle");

        items.push(tool_call(
            "emergency",
            next_ordinal,
            "bash",
            serde_json::json!({}),
            160_000,
        ));
        items.push(tool_result("emergency", next_ordinal, "bash", 40_000));
        let mut bust_ctx = base_ctx(PassClass::EmergencyForce);
        bust_ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        bust_ctx.current_total_input_tokens = 90_000.0;
        bust_ctx.ceiling_tokens = 100_000.0;
        bust_ctx.pass_already_busting = true;
        let bust = select_reductions(&items, &HashSet::new(), &bust_ctx, &cfg);
        assert!(bust
            .iter()
            .any(|decision| decision.target_id == "emergency#0"));
        // In the force band the emergency selector owns tool reclaim (TypeScript
        // `toolReclaimAdmitted`); the pending supersession batch waits for a rebuilding
        // pass below the band and then lands whole.
        assert!(bust.iter().all(|decision| decision.kind != "edit_marker"));
        bust_ctx.pass_class = PassClass::Execute;
        let below_band = select_reductions(&items, &HashSet::new(), &bust_ctx, &cfg);
        let markers: HashSet<&str> = below_band
            .iter()
            .filter(|decision| decision.kind == "edit_marker")
            .map(|decision| decision.target_id.as_str())
            .collect();

        assert_eq!(
            markers,
            HashSet::from(["c1#0", "c2#0", "c3#0"]),
            "the first rebuilding pass below the band carries the whole pending batch"
        );
        assert!(below_band
            .iter()
            .all(|decision| !decision.target_id.starts_with("c4#")));
    }

    #[test]
    fn latched_force_below_band_preserves_served_bytes_while_supersession_accumulates() {
        const LATCHED_PASSES: u64 = 3;

        let mut items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"one"}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
        ];
        let cfg = SelectionConfig {
            smart_drops: true,
            ..SelectionConfig::default()
        };
        let mut previous_served = served_block_bytes(&items, &[]);
        let mut next_ordinal = 2;
        let mut applied_reclaims = 0;

        for pass in 1..=LATCHED_PASSES {
            let edit_number = pass + 1;
            items.push(tool_call(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{edit_number}")}),
                500,
            ));
            items.push(tool_result(
                &format!("c{edit_number}"),
                next_ordinal,
                "edit",
                100,
            ));
            next_ordinal += 1;
            for message in 0..RECENT_TOOL_SKELETON_WINDOW {
                items.push(text_with_id(
                    &format!("latched-{pass}-tail-{message}#0"),
                    next_ordinal,
                    1,
                ));
                next_ordinal += 1;
            }

            let mut ctx = base_ctx(PassClass::EmergencyForce);
            ctx.current_total_input_tokens = 70_000.0;
            ctx.ceiling_tokens = 100_000.0;
            ctx.has_prior_drop = true;
            let reductions = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
            applied_reclaims += usize::from(!reductions.is_empty());
            let served = served_block_bytes(&items, &reductions);
            for (id, previous_bytes) in &previous_served {
                assert_eq!(
                    served.get(id),
                    Some(previous_bytes),
                    "latched pass {pass} changed previously served block {id}"
                );
            }
            previous_served = served;
        }

        assert_eq!(
            applied_reclaims, 0,
            "an armed but idle emergency latch must not authorize supersession"
        );
    }

    #[test]
    fn supersession_floors_compose_on_thirty_arc_fixture() {
        let mut items = Vec::new();
        for n in 1..=30u64 {
            let call_id = format!("c{n}");
            items.push(tool_call(
                &call_id,
                n,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{n}")}),
                500,
            ));
            items.push(tool_result(&call_id, n, "edit", 100));
        }

        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        // The owner-message floor retains c11..c30, while the active odd tool-tag
        // floor retains every odd arc. The two floors compose, so only the old even
        // arcs c2..c10 remain eligible. Protecting one result block must retain the
        // complete arc rather than partially rewriting the untagged call block.
        for n in (1..30u64).step_by(2) {
            ctx.tag_window_protected_block_ids
                .insert(result_block_id(&format!("c{n}")));
        }

        let decisions = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        let admitted = decisions
            .iter()
            .filter_map(|decision| decision.target_id.split('#').next())
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let expected = (2..=10u64)
            .step_by(2)
            .map(|n| format!("c{n}"))
            .collect::<HashSet<_>>();

        assert_eq!(admitted, expected);
        assert_eq!(decisions.len(), expected.len() * 2);
    }

    #[test]
    fn emergency_95_yields_window_and_reserve_but_retains_open_arcs_and_exemplars() {
        let mut items = Vec::new();
        for n in 1..=4 {
            let id = format!("c{n}");
            items.push(tool_call(&id, n, "read", serde_json::json!({}), 40_000));
            items.push(tool_result(&id, n, "read", 40_000));
        }
        items.push(tool_call("open", 5, "read", serde_json::json!({}), 40_000));
        for n in 6..=8 {
            let id = format!("c{n}");
            items.push(tool_call(
                &id,
                n,
                "ctx_reduce",
                serde_json::json!({}),
                40_000,
            ));
            items.push(tool_result(&id, n, "ctx_reduce", 40_000));
        }
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.current_total_input_tokens = 190_000.0;
        ctx.ceiling_tokens = 130_000.0;
        ctx.tag_window_protected_block_ids = items.iter().map(|item| item.id.clone()).collect();
        let cfg = SelectionConfig {
            smart_drops: false,
            ..SelectionConfig::default()
        };
        assert!(select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty());
        ctx.emergency_window_yields = true;
        let decisions = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
        let targets = decisions
            .iter()
            .map(|d| d.target_id.clone())
            .collect::<HashSet<_>>();
        for n in 1..=4 {
            assert!(
                targets.contains(&result_block_id(&format!("c{n}"))),
                "completed arc {n}, including newest reserve, must yield"
            );
        }
        assert!(!targets.contains(&call_block_id("open")));
        for n in 6..=8 {
            assert!(!targets.contains(&result_block_id(&format!("c{n}"))));
        }
    }

    #[test]
    fn supersession_preserves_newest_twenty_message_owners_without_tag_window_help() {
        let mut items = Vec::new();
        for n in 1..=30u64 {
            let call_id = format!("c{n}");
            items.push(tool_call(
                &call_id,
                n,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":format!("edit-{n}")}),
                500,
            ));
            items.push(tool_result(&call_id, n, "edit", 100));
        }

        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        let decisions = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        let admitted = decisions
            .iter()
            .filter_map(|decision| decision.target_id.split('#').next())
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let expected = (1..=10u64).map(|n| format!("c{n}")).collect::<HashSet<_>>();

        assert_eq!(admitted, expected);
        assert_eq!(decisions.len(), expected.len() * 2);
    }

    #[test]
    fn edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate() {
        let split_astral = format!("{}😀tail", "a".repeat(39));
        assert_eq!(
            region_hint(&split_astral),
            format!("{}{}", "a".repeat(39), TRUNCATION_SENTINEL)
        );

        let complete_astral = format!("{}😀tail", "a".repeat(38));
        assert_eq!(
            region_hint(&complete_astral),
            format!("{}😀{}", "a".repeat(38), TRUNCATION_SENTINEL)
        );
    }

    #[test]
    fn provider_executed_arc_never_targeted() {
        // A server-side tool arc must be skipped even under the two-pass watermark.
        let mut items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "web_search", serde_json::json!({}), 200),
            tool_result("c2", 2, "web_search", 200),
        ];
        let c2_arc = call_block_id("c2");
        for it in items.iter_mut() {
            if it.arc_id.as_deref() == Some(c2_arc.as_str()) {
                it.provider_executed = true;
            }
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2; // both arcs at/under watermark
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
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
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "bash", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash", 200),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        let frozen: HashSet<String> = [result_block_id("c1")].into_iter().collect();
        let out = select_reductions(&items, &frozen, &ctx, &SelectionConfig::default());
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
            tool_call("c1", 1, "bash", serde_json::json!({}), 200),
            tool_result("c1", 1, "bash", 200),
            tool_call("c2", 2, "bash", serde_json::json!({}), 200),
            tool_result("c2", 2, "bash", 200),
        ];
        let protected = result_block_id("c1");
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        ctx.agent_drop_ids = vec![protected.clone()];
        ctx.tag_window_protected_block_ids.insert(protected.clone());

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.iter().all(|decision| decision.target_id != protected));
        assert!(
            out.iter()
                .any(|decision| decision.target_id == result_block_id("c2")),
            "the unprotected automatic candidate must still be selected"
        );
    }

    #[test]
    fn reasoning_only_assistant_makes_the_whole_tool_arc_ineligible() {
        let target_arc = "assistant#1";
        let mut items = vec![
            reasoning_with_id("assistant#0", target_arc, 1, 100),
            tool_call_with_ids(
                target_arc,
                target_arc,
                1,
                "aft_outline",
                serde_json::json!({"target": ["src/model.rs"]}),
                50,
            ),
            tool_result_with_ids("tool-result#0", target_arc, 2, "aft_outline", 300),
        ];
        // Keep the target arc outside the newest-20 skeleton window so the control
        // would fully remove both tool carriers without the whole-message guard.
        for ordinal in 3..=22 {
            let arc = format!("new-{ordinal}#0");
            items.push(tool_call_with_ids(
                &arc,
                &arc,
                ordinal,
                "bash",
                serde_json::json!({}),
                50,
            ));
            items.push(tool_result_with_ids(
                &format!("new-result-{ordinal}#0"),
                &arc,
                ordinal,
                "bash",
                300,
            ));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22;
        ctx.pass_already_busting = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().all(|decision| {
                decision.target_id != target_arc && decision.target_id != "tool-result#0"
            }),
            "reasoning-bearing arc must remain byte-complete: {out:?}"
        );
        assert!(
            out.iter()
                .all(|decision| decision.target_id != "assistant#0"),
            "reasoning itself must never become a reduction target: {out:?}"
        );
        assert!(
            !out.is_empty(),
            "unrelated age-reclaim candidates must still reduce"
        );
    }

    #[test]
    fn reasoning_with_a_durable_text_sibling_reclaims_via_separator_skeleton() {
        let target_arc = "assistant#1";
        let mut items = vec![
            reasoning_with_id("assistant#0", target_arc, 1, 100),
            tool_call_with_ids(
                target_arc,
                target_arc,
                1,
                "aft_outline",
                serde_json::json!({"target": ["src/model.rs"]}),
                50,
            ),
            text_with_id("assistant#2", 1, 20),
            tool_result_with_ids("tool-result#0", target_arc, 2, "aft_outline", 300),
        ];
        for ordinal in 3..=22 {
            let arc = format!("new-{ordinal}#0");
            items.push(tool_call_with_ids(
                &arc,
                &arc,
                ordinal,
                "bash",
                serde_json::json!({}),
                50,
            ));
            items.push(tool_result_with_ids(
                &format!("new-result-{ordinal}#0"),
                &arc,
                ordinal,
                "bash",
                300,
            ));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22;
        ctx.pass_already_busting = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.iter().any(|decision| {
                decision.target_id == target_arc && decision.kind == "skeleton_real"
            }),
            "the durable text sibling keeps the arc reclaimable while its result separates reasoning-bearing assistants: {out:?}"
        );
        assert!(
            out.iter().any(|decision| {
                decision.target_id == "tool-result#0" && decision.kind == "drop"
            }),
            "skeleton mode must reclaim the result payload through the existing drop placeholder: {out:?}"
        );
    }

    #[test]
    fn age_eligible_reasoning_block_never_becomes_a_reduction_target() {
        // Historical reasoning cleanup has its own bust-frozen whole-block lane. Even when this
        // old arc is eligible for age reclaim and ctx_reduce names the exact reasoning id, the
        // selection contract must never emit signed reasoning in ReductionDecision targets.
        let items = vec![
            reasoning("c1", 1, 100),
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 100;
        ctx.scheduler_pressure_execute = true;
        ctx.pass_already_busting = true;
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
                "bash",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn1-tool#0", "turn1#0", 1, "bash", 300),
            tool_call_with_ids(
                "turn2#0",
                "turn2#0",
                2,
                "bash",
                serde_json::json!({"provider_call_id":"call_0"}),
                50,
            ),
            tool_result_with_ids("turn2-tool#0", "turn2#0", 2, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 2;
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
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
                "bash",
                serde_json::json!({"cmd": "x".repeat(20)}),
                50,
            ));
            items.push(tool_result(&format!("c{n}"), n, "bash", 200));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 22; // all arcs are drop candidates
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        let call_kind = |arc: &str| -> String {
            out.iter()
                .find(|d| d.target_id == call_block_id(arc))
                .map(|d| d.kind.clone())
                .unwrap_or_default()
        };
        assert_eq!(call_kind("c1"), "drop", "oldest arc full-drops the call");
        assert_eq!(call_kind("c2"), "drop", "2nd oldest full-drops");
        assert_eq!(
            call_kind("c22"),
            "skeleton_real",
            "newest keeps a real-argument skeleton call"
        );
        assert_eq!(
            call_kind("c3"),
            "skeleton_real",
            "inside the window with a small input → real-argument skeleton"
        );
    }

    #[derive(Deserialize)]
    struct ToolInputSizeFixture {
        max_small_bytes: usize,
        cases: Vec<ToolInputSizeCase>,
    }

    #[derive(Deserialize)]
    struct ToolInputSizeCase {
        name: String,
        input: serde_json::Value,
        expected_bytes: usize,
        expected_small: bool,
    }

    #[test]
    fn tool_input_string_bytes_matches_the_shared_cross_lane_fixture() {
        let fixture: ToolInputSizeFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/tool-input-string-bytes.json"
        ))
        .expect("parse tool-input-string-bytes.json");
        assert_eq!(fixture.max_small_bytes, SKELETON_REAL_INPUT_MAX_BYTES);
        assert!(!fixture.cases.is_empty());
        for case in fixture.cases {
            assert_eq!(
                tool_input_string_bytes(&case.input),
                case.expected_bytes,
                "{}",
                case.name
            );
            assert_eq!(
                is_small_tool_input(&case.input),
                case.expected_small,
                "{}",
                case.name
            );
        }
    }

    fn user_text(mid: &str, ordinal: u64) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: format!("{mid}#0"),
            ordinal,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 10,
            token_count: None,
            arc_id: None,
        }
    }

    fn two_pass_kinds(items: &[SelItem], last_ordinal: u64) -> HashMap<String, String> {
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = last_ordinal;
        ctx.pass_already_busting = true;
        select_reductions(items, &HashSet::new(), &ctx, &SelectionConfig::default())
            .into_iter()
            .map(|decision| (decision.target_id, decision.kind))
            .collect()
    }

    #[test]
    fn window_drop_keeps_real_arguments_at_1024_bytes_and_removes_at_1025() {
        let items = vec![
            tool_call(
                "at",
                1,
                "bash",
                serde_json::json!({ "content": "a".repeat(1024) }),
                1100,
            ),
            tool_result("at", 1, "bash", 5000),
            tool_call(
                "over",
                2,
                "bash",
                serde_json::json!({ "content": "a".repeat(1025) }),
                1100,
            ),
            tool_result("over", 2, "bash", 5000),
            user_text("next", 3),
        ];
        let kinds = two_pass_kinds(&items, 3);
        assert_eq!(
            kinds.get(&call_block_id("at")).map(String::as_str),
            Some("skeleton_real")
        );
        assert_eq!(
            kinds.get(&result_block_id("at")).map(String::as_str),
            Some("drop")
        );
        assert_eq!(
            kinds.get(&call_block_id("over")).map(String::as_str),
            Some("drop")
        );
        assert_eq!(
            kinds.get(&result_block_id("over")).map(String::as_str),
            Some("drop")
        );
    }

    #[test]
    fn window_drop_keeps_the_call_whose_result_ends_the_request() {
        let items = vec![
            user_text("start", 1),
            tool_call(
                "end",
                2,
                "write",
                serde_json::json!({ "content": "b".repeat(5000) }),
                5100,
            ),
            tool_result("end", 2, "write", 5000),
        ];
        let kinds = two_pass_kinds(&items, 2);
        assert_eq!(
            kinds.get(&call_block_id("end")).map(String::as_str),
            Some("skeleton_real"),
            "a large input is kept, with real arguments, when its result ends the request"
        );
        assert_eq!(
            kinds.get(&result_block_id("end")).map(String::as_str),
            Some("drop")
        );
    }

    #[test]
    fn legacy_skeletons_convert_to_real_or_absent() {
        let items = vec![
            user_text("start", 1),
            tool_call(
                "small",
                2,
                "bash",
                serde_json::json!({ "command": "ls -la" }),
                20,
            ),
            tool_result("small", 2, "bash", 500),
            tool_call(
                "large",
                3,
                "write",
                serde_json::json!({ "content": "c".repeat(2000) }),
                2100,
            ),
            tool_result("large", 3, "write", 500),
            tool_call(
                "end",
                4,
                "write",
                serde_json::json!({ "content": "d".repeat(2000) }),
                2100,
            ),
            tool_result("end", 4, "write", 500),
        ];
        let legacy = ["small", "large", "end"]
            .iter()
            .map(|mid| call_block_id(mid))
            .collect::<BTreeSet<_>>();
        let frozen = legacy
            .iter()
            .cloned()
            .chain(
                ["small", "large", "end"]
                    .iter()
                    .map(|mid| result_block_id(mid)),
            )
            .collect::<HashSet<_>>();
        let kinds = legacy_skeleton_conversions(&items, &legacy, &HashSet::new(), &frozen);
        assert_eq!(
            kinds.get(&call_block_id("small")).copied(),
            Some("skeleton_real")
        );
        assert_eq!(kinds.get(&call_block_id("large")).copied(), Some("drop"));
        assert_eq!(
            kinds.get(&call_block_id("end")).copied(),
            Some("skeleton_real"),
            "the request-ending call keeps real arguments"
        );
    }

    // Adversarial gate reproductions: request-end protection when the tool result
    // lives in a separate tool-role message, and when every block of an OpenCode
    // assistant message (text, call, result) carries the assistant role.
    fn adv_item(
        id: &str,
        ordinal: u64,
        role: SelMessageRole,
        kind: SelKind,
        arc: Option<&str>,
    ) -> SelItem {
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: role,
            kind,
            provider_executed: false,
            byte_size: 5000,
            token_count: None,
            arc_id: arc.map(str::to_string),
        }
    }

    fn adv_call(input: serde_json::Value) -> SelKind {
        SelKind::ToolCall {
            name: "write".to_string(),
            input,
        }
    }

    fn adv_result() -> SelKind {
        SelKind::ToolResult {
            tool_name: "write".to_string(),
        }
    }

    /// assistant `a` = [text, call(large)], tool-role `t` = [result]; the request ends
    /// on `t`. Removing the arc would leave assistant text as the request end.
    fn adv_separate_tool_message_items() -> Vec<SelItem> {
        let large = serde_json::json!({ "content": "z".repeat(5000) });
        vec![
            adv_item("u#0", 1, SelMessageRole::NonAssistant, SelKind::Text, None),
            adv_item("a#0", 2, SelMessageRole::Assistant, SelKind::Text, None),
            adv_item(
                "a#1",
                2,
                SelMessageRole::Assistant,
                adv_call(large),
                Some("a#1"),
            ),
            adv_item(
                "t#0",
                3,
                SelMessageRole::NonAssistant,
                adv_result(),
                Some("a#1"),
            ),
        ]
    }

    #[test]
    fn adv_request_end_in_separate_tool_role_message_keeps_real_arguments() {
        let items = adv_separate_tool_message_items();
        let kinds = two_pass_kinds(&items, 3);
        eprintln!("ADV_RUST_SEPARATE_TOOL_MSG new-drop kinds={kinds:?}");
        assert_eq!(kinds.get("a#1").map(String::as_str), Some("skeleton_real"));
        assert_eq!(kinds.get("t#0").map(String::as_str), Some("drop"));

        let legacy = BTreeSet::from(["a#1".to_string()]);
        let frozen = HashSet::from(["a#1".to_string(), "t#0".to_string()]);
        let converted = legacy_skeleton_conversions(&items, &legacy, &HashSet::new(), &frozen);
        eprintln!("ADV_RUST_SEPARATE_TOOL_MSG legacy conversion={converted:?}");
        assert_eq!(converted.get("a#1").copied(), Some("skeleton_real"));
    }

    #[test]
    fn adv_request_end_parallel_results_in_two_tool_role_messages() {
        // assistant a = [text, call1(large), call2(large)], t1 = [result1], t2 = [result2].
        let large = || serde_json::json!({ "content": "z".repeat(5000) });
        let items = vec![
            adv_item("u#0", 1, SelMessageRole::NonAssistant, SelKind::Text, None),
            adv_item("a#0", 2, SelMessageRole::Assistant, SelKind::Text, None),
            adv_item(
                "a#1",
                2,
                SelMessageRole::Assistant,
                adv_call(large()),
                Some("a#1"),
            ),
            adv_item(
                "a#2",
                2,
                SelMessageRole::Assistant,
                adv_call(large()),
                Some("a#2"),
            ),
            adv_item(
                "t1#0",
                3,
                SelMessageRole::NonAssistant,
                adv_result(),
                Some("a#1"),
            ),
            adv_item(
                "t2#0",
                4,
                SelMessageRole::NonAssistant,
                adv_result(),
                Some("a#2"),
            ),
        ];
        let kinds = two_pass_kinds(&items, 4);
        eprintln!("ADV_RUST_PARALLEL_TOOL_MSGS kinds={kinds:?}");
        // At least one result must survive at the request end.
        let kept = ["a#1", "a#2"]
            .iter()
            .filter(|id| kinds.get(**id).map(String::as_str) == Some("skeleton_real"))
            .count();
        assert!(kept >= 1, "{kinds:?}");
        assert_eq!(kinds.get("a#2").map(String::as_str), Some("skeleton_real"));
    }

    #[test]
    fn adv_request_end_opencode_single_assistant_message_all_blocks_assistant_role() {
        // The OpenCode projection: text, call and result blocks share one assistant
        // message and the assistant role. Removing the arc strands the assistant text.
        let large = serde_json::json!({ "content": "z".repeat(5000) });
        let items = vec![
            adv_item("u#0", 1, SelMessageRole::NonAssistant, SelKind::Text, None),
            adv_item("a#0", 2, SelMessageRole::Assistant, SelKind::Text, None),
            adv_item(
                "a#1",
                2,
                SelMessageRole::Assistant,
                adv_call(large),
                Some("a#1"),
            ),
            adv_item(
                "a#2",
                2,
                SelMessageRole::Assistant,
                adv_result(),
                Some("a#1"),
            ),
        ];
        let kinds = two_pass_kinds(&items, 2);
        eprintln!("ADV_RUST_OPENCODE_ASSISTANT_END kinds={kinds:?}");
        assert_eq!(kinds.get("a#1").map(String::as_str), Some("skeleton_real"));
    }

    #[test]
    fn adv_request_end_result_then_trailing_system_item() {
        // A trailing system block must not be taken as the request end.
        let large = serde_json::json!({ "content": "z".repeat(5000) });
        let items = vec![
            adv_item("u#0", 1, SelMessageRole::NonAssistant, SelKind::Text, None),
            adv_item("a#0", 2, SelMessageRole::Assistant, SelKind::Text, None),
            adv_item(
                "a#1",
                2,
                SelMessageRole::Assistant,
                adv_call(large),
                Some("a#1"),
            ),
            adv_item(
                "t#0",
                3,
                SelMessageRole::NonAssistant,
                adv_result(),
                Some("a#1"),
            ),
            adv_item("s#0", 4, SelMessageRole::System, SelKind::Text, None),
        ];
        let kinds = two_pass_kinds(&items, 4);
        eprintln!("ADV_RUST_TRAILING_SYSTEM kinds={kinds:?}");
        assert_eq!(kinds.get("a#1").map(String::as_str), Some("skeleton_real"));
    }
    #[test]
    fn drop_wins_over_edit_marker() {
        // c1 is an older edit to a.ts (edit_marker candidate) AND under the two-pass
        // watermark (drop candidate). Drop must win.
        let items = vec![
            tool_call(
                "c1",
                1,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"x".repeat(80)}),
                500,
            ),
            tool_result("c1", 1, "edit", 100),
            tool_call(
                "c2",
                2,
                "edit",
                serde_json::json!({"filePath":"a.ts","oldString":"y".repeat(80)}),
                500,
            ),
            tool_result("c2", 2, "edit", 100),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.last_execute_ordinal = 1; // c1 under watermark → two-pass drop
        ctx.pass_already_busting = true;
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        let c1_call = out
            .iter()
            .find(|d| d.target_id == call_block_id("c1"))
            .map(|d| d.kind.clone());
        // Drop wins: the arc is on the DROP path (skeleton in-window, or full-drop
        // older), NEVER edit_marker. With only 2 arcs c1 is in the skeleton window, so
        // the winning drop shapes to "skeleton_real" — a drop variant, not an edit_marker.
        assert!(
            matches!(c1_call.as_deref(), Some("drop") | Some("skeleton_real")),
            "drop beats edit_marker for c1 (got {c1_call:?})"
        );
        assert_ne!(
            c1_call.as_deref(),
            Some("edit_marker"),
            "edit_marker must NOT win"
        );
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
        // so c1 stays an edit_marker in BOTH (known sub-floor token mass prevents
        // a two-pass FullDrop that would change its shape). A payload fn that
        // accidentally read ctx would diverge here; a pure one cannot.
        let mut items = vec![
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
        for n in 0..RECENT_TOOL_SKELETON_WINDOW {
            items.push(text_with_id(&format!("tail-{n}#0"), 10 + n as u64, 1));
        }
        let edit_bookmark = distant_edit_fixture(&mut items);
        let c1_marker_payload = |ctx: &SelectionContext| -> Option<String> {
            let out = select_reductions(
                &items,
                &HashSet::new(),
                ctx,
                &SelectionConfig {
                    smart_drops: true,
                    ..SelectionConfig::default()
                },
            );
            out.iter()
                .find(|d| d.target_id == call_block_id("c1") && d.kind == "edit_marker")
                .map(|d| d.payload.clone())
        };

        // Context A: no agent drops, zero pressure fields.
        let mut ctx_a = base_ctx(PassClass::Execute);
        ctx_a.last_execute_ordinal = edit_bookmark;
        ctx_a.pass_already_busting = true;
        ctx_a.supersession_ride_available = true;
        // Context B: a genuinely different produced set — an unrelated agent drop (c9)
        // plus non-zero pressure/latch fields. The same prior bookmark and known
        // sub-floor mass keep c1 an edit_marker in both.
        let ctx_b = SelectionContext {
            calibration: None,
            last_execute_ordinal: edit_bookmark,
            agent_drop_ids: vec![result_block_id("c9")],
            current_total_input_tokens: 123_456.0,
            ceiling_tokens: 200_000.0,
            prior_input_sample: 99_000.0,
            has_prior_drop: true,
            pass_already_busting: true,
            supersession_ride_available: true,
            emergency_minimum_waived: false,
            ..base_ctx(PassClass::Execute)
        };

        // Non-vacuity guard: prove the two contexts genuinely produce DIFFERENT sets
        // (c9 is dropped in B via the agent-drop, absent in A), so the payload equality
        // below is a real invariance across a differing pass, not f(x)==f(x).
        let set_a = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_a,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        let set_b = select_reductions(
            &items,
            &HashSet::new(),
            &ctx_b,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
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
    fn execute_at_ceiling_cannot_originate_agent_drop() {
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({}), 50),
            tool_result("c1", 1, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.pass_already_busting = false;
        ctx.supersession_ride_available = false;
        ctx.ceiling_tokens = 65000.0;
        ctx.current_total_input_tokens = 65000.0;
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty(), "execute alone must hold queued drops");
    }

    #[test]
    fn agent_drop_ids_reduce_directly_on_priced_pass() {
        let items = vec![
            tool_call("c1", 1, "read", serde_json::json!({}), 50),
            tool_result("c1", 1, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        ctx.pass_already_busting = true;
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out
            .iter()
            .any(|d| d.target_id == result_block_id("c1") && d.kind == "drop"));
    }

    #[test]
    fn held_agent_drop_never_trickles_when_the_window_slides() {
        let items = vec![SelItem {
            user_answer: false,
            served_token_count: None,
            id: "held#0".to_string(),
            ordinal: 1,
            message_role: SelMessageRole::NonAssistant,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: 100,
            token_count: None,
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
    fn different_commands_wait_for_a_single_ride_opportunity() {
        let items = vec![
            SelItem {
                user_answer: false,
                served_token_count: None,
                id: "held#0".to_string(),
                ordinal: 1,
                message_role: SelMessageRole::NonAssistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
                arc_id: None,
            },
            SelItem {
                user_answer: false,
                served_token_count: None,
                id: "new#0".to_string(),
                ordinal: 2,
                message_role: SelMessageRole::NonAssistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
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
        assert!(out.is_empty());
        ctx.pass_already_busting = true;
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
                user_answer: false,
                served_token_count: None,
                id: format!("carrier#{index}"),
                ordinal: 1,
                message_role: SelMessageRole::NonAssistant,
                kind,
                provider_executed: false,
                byte_size: 100,
                token_count: None,
                arc_id: None,
            })
            .collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.agent_drop_ids = items.iter().map(|item| item.id.clone()).collect();
        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn duplicate_safe_tools_keep_the_newest_same_owner_full_drop() {
        let args = serde_json::json!({"line": 7, "path": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner#0", "owner#0", 1, "mcp_read", args.clone(), 50),
            tool_result_with_ids("older-result#0", "owner#0", 2, "mcp_read", 300),
            tool_call_with_ids(
                "owner#1",
                "owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs", "line": 7}),
                50,
            ),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .map(|decision| (decision.target_id.as_str(), decision.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("older-result#0", "drop"), ("owner#0", "drop")],
            "the older safe duplicate must fully drop while the newest call stays live: {out:?}"
        );
    }

    #[test]
    fn duplicate_safe_tools_never_merge_across_owner_messages() {
        let args = serde_json::json!({"path": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner-a#0", "owner-a#0", 1, "mcp_read", args.clone(), 50),
            tool_result_with_ids("result-a#0", "owner-a#0", 2, "mcp_read", 300),
            tool_call_with_ids("owner-b#0", "owner-b#0", 3, "mcp_read", args, 50),
            tool_result_with_ids("result-b#0", "owner-b#0", 4, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(
            out.is_empty(),
            "identical calls from distinct assistant owners are distinct invocations: {out:?}"
        );
    }

    #[test]
    fn duplicate_non_safe_tools_never_deduplicate() {
        // `bash` can return different output for identical arguments, so it never dedups.
        let args = serde_json::json!({"command": "date"});
        let items = vec![
            tool_call_with_ids("owner#0", "owner#0", 1, "bash", args.clone(), 50),
            tool_result_with_ids("older-result#0", "owner#0", 2, "bash", 300),
            tool_call_with_ids("owner#1", "owner#1", 1, "bash", args, 50),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(out.is_empty(), "non-safe tools must stay live: {out:?}");
    }

    #[test]
    fn duplicate_bare_host_read_names_deduplicate() {
        // OpenCode and Pi both hand over the bare `read` name, never `mcp_read`.
        let args = serde_json::json!({"filePath": "src/lib.rs"});
        let items = vec![
            tool_call_with_ids("owner#0", "owner#0", 1, "read", args.clone(), 50),
            tool_result_with_ids("older-result#0", "owner#0", 2, "read", 300),
            tool_call_with_ids("owner#1", "owner#1", 1, "read", args, 50),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .map(|decision| (decision.target_id.as_str(), decision.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("older-result#0", "drop"), ("owner#0", "drop")],
            "the older bare-name duplicate must fully drop: {out:?}"
        );
    }

    #[test]
    fn duplicate_safe_tools_keep_one_copy_when_the_newest_is_protected() {
        let args = serde_json::json!({"filePath": "src/lib.rs"});
        let mut items = Vec::new();
        for index in 0..3 {
            let call = format!("owner#{index}");
            let result = format!("result-{index}#0");
            items.push(tool_call_with_ids(
                &call,
                &call,
                1,
                "read",
                args.clone(),
                50,
            ));
            items.push(tool_result_with_ids(
                &result,
                &call,
                2 + index as u64,
                "read",
                300,
            ));
        }
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;
        ctx.tag_window_protected_block_ids =
            HashSet::from(["owner#2".to_string(), "result-2#0".to_string()]);

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        let mut targets = out
            .iter()
            .map(|decision| decision.target_id.as_str())
            .collect::<Vec<_>>();
        targets.sort_unstable();
        assert_eq!(
            targets,
            vec!["owner#0", "owner#1", "result-0#0", "result-1#0"],
            "both unprotected copies drop; only the protected newest stays: {out:?}"
        );
    }

    #[test]
    fn duplicate_safe_tools_skip_protected_and_open_arcs() {
        let protected_items = vec![
            tool_call_with_ids(
                "protected-owner#0",
                "protected-owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids(
                "protected-old-result#0",
                "protected-owner#0",
                1,
                "mcp_read",
                300,
            ),
            tool_call_with_ids(
                "protected-owner#1",
                "protected-owner#1",
                2,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids(
                "protected-new-result#0",
                "protected-owner#1",
                2,
                "mcp_read",
                300,
            ),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;
        ctx.tag_window_protected_block_ids = HashSet::from([
            "protected-owner#1".to_string(),
            "protected-new-result#0".to_string(),
        ]);
        let out = select_reductions(
            &protected_items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig::default(),
        );
        assert_eq!(
            out.iter()
                .map(|decision| decision.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["protected-old-result#0", "protected-owner#0"],
            "a protected newest duplicate anchors its group, so the unprotected older copy drops: {out:?}"
        );

        ctx.tag_window_protected_block_ids = HashSet::from([
            "protected-owner#0".to_string(),
            "protected-old-result#0".to_string(),
            "protected-owner#1".to_string(),
            "protected-new-result#0".to_string(),
        ]);
        assert!(
            select_reductions(
                &protected_items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default(),
            )
            .is_empty(),
            "a protected duplicate is never selected, even with a newer copy"
        );

        let open_items = vec![
            tool_call_with_ids(
                "open-owner#0",
                "open-owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_call_with_ids(
                "open-owner#1",
                "open-owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
        ];
        ctx.tag_window_protected_block_ids.clear();
        assert!(
            select_reductions(
                &open_items,
                &HashSet::new(),
                &ctx,
                &SelectionConfig::default()
            )
            .is_empty(),
            "open tool arcs never participate in duplicate selection"
        );
    }

    #[test]
    fn duplicate_safe_tools_require_an_independent_bust() {
        let items = vec![
            tool_call_with_ids(
                "owner#0",
                "owner#0",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids("older-result#0", "owner#0", 2, "mcp_read", 300),
            tool_call_with_ids(
                "owner#1",
                "owner#1",
                1,
                "mcp_read",
                serde_json::json!({"path": "src/lib.rs"}),
                50,
            ),
            tool_result_with_ids("newer-result#0", "owner#1", 3, "mcp_read", 300),
        ];
        let mut execute = base_ctx(PassClass::Execute);
        assert!(select_reductions(
            &items,
            &HashSet::new(),
            &execute,
            &SelectionConfig::default()
        )
        .is_empty());
        execute.pass_already_busting = true;
        let selected = select_reductions(
            &items,
            &HashSet::new(),
            &execute,
            &SelectionConfig::default(),
        );
        assert_eq!(selected.len(), 2);
        assert!(selected
            .iter()
            .any(|decision| decision.target_id == "owner#0"));
        assert!(selected
            .iter()
            .any(|decision| decision.target_id == "older-result#0"));

        let deferred = base_ctx(PassClass::Defer);
        assert!(
            select_reductions(
                &items,
                &HashSet::new(),
                &deferred,
                &SelectionConfig::default(),
            )
            .is_empty(),
            "defer replays frozen reductions and never first-applies deduplication"
        );
    }

    #[test]
    fn duplicate_full_drop_skeletonizes_for_reasoning_adjacency() {
        let args = serde_json::json!({"path": "src/lib.rs"});
        let items = vec![
            reasoning_with_id("left#0", "left#2", 1, 50),
            SelItem {
                user_answer: false,
                served_token_count: None,
                id: "left#1".to_string(),
                ordinal: 1,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 50,
                token_count: None,
                arc_id: None,
            },
            tool_call_with_ids("left#2", "left#2", 1, "mcp_read", args.clone(), 50),
            tool_call_with_ids("left#3", "left#3", 1, "mcp_read", args, 50),
            tool_result_with_ids("older-result#0", "left#2", 2, "mcp_read", 300),
            SelItem {
                user_answer: false,
                served_token_count: None,
                id: "right#0".to_string(),
                ordinal: 3,
                message_role: SelMessageRole::Assistant,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 50,
                token_count: None,
                arc_id: None,
            },
            tool_result_with_ids("newer-result#0", "left#3", 4, "mcp_read", 300),
        ];
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.supersession_ride_available = true;

        let out = select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert_eq!(
            out.iter()
                .find(|decision| decision.target_id == "left#2")
                .map(|decision| decision.kind.as_str()),
            Some("skeleton_real"),
            "the dedup full drop must take the same reasoning-adjacency safety demotion: {out:?}"
        );
        assert_eq!(
            out.iter()
                .find(|decision| decision.target_id == "older-result#0")
                .map(|decision| decision.kind.as_str()),
            Some("drop")
        );
    }

    #[test]
    fn defer_pass_produces_nothing() {
        let items = vec![
            tool_call("c1", 1, "bash", serde_json::json!({}), 50),
            tool_result("c1", 1, "bash", 300),
        ];
        let mut ctx = base_ctx(PassClass::Defer);
        ctx.last_execute_ordinal = 1;
        ctx.agent_drop_ids = vec![result_block_id("c1")];
        let out = select_reductions(
            &items,
            &HashSet::new(),
            &ctx,
            &SelectionConfig {
                smart_drops: true,
                ..SelectionConfig::default()
            },
        );
        assert!(out.is_empty(), "defer produces no reductions");
    }

    #[test]
    fn protected_tools_default_todowrite_survives_emergency_95() {
        let items = (1..=4)
            .flat_map(|n| {
                let id = format!("todo-{n}");
                [
                    tool_call(&id, n, "todowrite", serde_json::json!({}), 0),
                    tool_result(&id, n, "todowrite", 4000),
                ]
            })
            .collect::<Vec<_>>();
        let mut ctx = base_ctx(PassClass::EmergencyForce);
        ctx.emergency_window_yields = true;
        ctx.emergency_minimum_waived = true;
        ctx.current_total_input_tokens = 4000.0;
        ctx.ceiling_tokens = 1.0;
        let decisions =
            select_reductions(&items, &HashSet::new(), &ctx, &SelectionConfig::default());
        assert!(!decisions
            .iter()
            .any(|decision| decision.target_id.starts_with("todo-4#")));
        assert!(decisions
            .iter()
            .any(|decision| decision.target_id.starts_with("todo-3#")));
    }

    fn check_protected_tools_shared_selection_golden(lane: &str) {
        #[derive(serde::Deserialize)]
        struct Case {
            label: String,
            lane: String,
            protected_tools: std::collections::BTreeMap<String, usize>,
            tools: Vec<String>,
            expected: Vec<usize>,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/protected-tools.json")).unwrap();
        for case in cases.into_iter().filter(|case| case.lane == lane) {
            let mut items = Vec::new();
            for (i, name) in case.tools.iter().enumerate() {
                let call = format!("owner#{}", 2 * i);
                let result = format!("owner#{}", 2 * i + 1);
                items.push(tool_call_with_ids(
                    &call,
                    &call,
                    i as u64 + 1,
                    name,
                    serde_json::json!({"filePath":"same"}),
                    0,
                ));
                items.push(tool_result_with_ids(
                    &result,
                    &call,
                    i as u64 + 1,
                    name,
                    4000,
                ));
            }
            for n in 20..40 {
                items.push(user_text(&format!("recent-{n}"), n));
            }
            let mut ctx = base_ctx(if case.lane == "emergency" {
                PassClass::EmergencyForce
            } else {
                PassClass::Execute
            });
            ctx.last_execute_ordinal = if case.lane == "age" { 4 } else { 0 };
            if case.lane == "edit" {
                ctx.last_execute_ordinal = distant_edit_fixture(&mut items);
            }
            ctx.current_total_input_tokens = 4000.0;
            ctx.ceiling_tokens = 1.0;
            ctx.emergency_window_yields = true;
            ctx.emergency_minimum_waived = true;
            ctx.pass_already_busting = true;
            ctx.supersession_ride_available = true;
            let cfg = SelectionConfig {
                smart_drops: false,
                protected_tools: case.protected_tools,
            };
            let decisions = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
            let mut selected = decisions
                .iter()
                .filter_map(|decision| {
                    let index = decision
                        .target_id
                        .strip_prefix("owner#")?
                        .parse::<usize>()
                        .ok()?;
                    Some(index / 2 + 1)
                })
                .collect::<Vec<_>>();
            selected.sort_unstable();
            selected.dedup();
            assert_eq!(selected, case.expected, "{}", case.label);
        }
    }

    #[test]
    fn protected_tools_emergency_golden() {
        check_protected_tools_shared_selection_golden("emergency");
    }
    #[test]
    fn protected_tools_age_golden() {
        check_protected_tools_shared_selection_golden("age");
    }
    #[test]
    fn protected_tools_supersession_golden() {
        check_protected_tools_shared_selection_golden("supersession");
    }
    #[test]
    fn protected_tools_edit_golden() {
        check_protected_tools_shared_selection_golden("edit");
    }
    #[test]
    fn protected_tools_duplicate_golden() {
        check_protected_tools_shared_selection_golden("duplicate");
    }

    #[test]
    fn protected_tools_rotation_and_legacy_false_only_ride_a_rebuild() {
        let mut items = Vec::new();
        for n in 1..=4 {
            let id = format!("todo-{n}");
            items.push(tool_call(&id, n, "todowrite", serde_json::json!({}), 0));
            items.push(tool_result(&id, n, "todowrite", 4000));
        }
        for n in 20..40 {
            items.push(user_text(&format!("recent-{n}"), n));
        }
        let mut ctx = base_ctx(PassClass::Defer);
        let cfg = SelectionConfig::default(); // Legacy false has no effect.
        assert!(select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty());
        ctx.pass_class = PassClass::Execute;
        ctx.pass_already_busting = false;
        ctx.supersession_ride_available = false;
        assert!(select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty());
        ctx.pass_already_busting = true;
        ctx.supersession_ride_available = true;
        let decisions = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
        assert!(decisions
            .iter()
            .any(|decision| decision.target_id == "todo-3#1"));
        assert!(!decisions
            .iter()
            .any(|decision| decision.target_id == "todo-4#1"));
        let frozen = HashSet::from(["todo-4#1".to_string()]);
        let decisions = select_reductions(&items, &frozen, &ctx, &cfg);
        assert!(!decisions
            .iter()
            .any(|decision| decision.target_id == "todo-3#1"));
        // Agent-requested drops use the same keep count and stay queued until
        // a newer call displaces this result.
        ctx.agent_drop_ids = vec!["todo-3#1".to_string()];
        assert!(!select_reductions(&items, &frozen, &ctx, &cfg)
            .iter()
            .any(|decision| decision.target_id == "todo-3#1"));
    }

    #[test]
    fn protected_tool_agent_drop_shared_hold_rotation_golden() {
        #[derive(serde::Deserialize)]
        struct Case {
            label: String,
            tools: Vec<String>,
            protected_tools: std::collections::BTreeMap<String, usize>,
            drop: usize,
            new_tool: String,
            #[serde(default)]
            historian: bool,
            #[serde(default)]
            agent_self_stamp: bool,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/protected-tool-holds.json"))
                .unwrap();
        for case in cases {
            // The facade rejects an agent dropping its own ctx_reduce result. Drops queued
            // by historian publication reach this planner and still obey the keep counts.
            if case.agent_self_stamp {
                continue;
            }
            let mut items = Vec::new();
            for (i, name) in case.tools.iter().enumerate() {
                let id = format!("hold-{}", i + 1);
                items.push(tool_call(&id, i as u64 + 1, name, serde_json::json!({}), 0));
                items.push(tool_result(&id, i as u64 + 1, name, 100));
            }
            let target = format!("hold-{}#1", case.drop);
            let cfg = SelectionConfig {
                protected_tools: case.protected_tools,
                ..SelectionConfig::default()
            };
            let mut ctx = base_ctx(PassClass::Execute);
            ctx.pass_already_busting = true;
            ctx.emergency_window_yields = true;
            ctx.agent_drop_ids = vec![target.clone()];
            for _ in 0..2 {
                let selected = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
                assert!(
                    !selected.iter().any(|decision| decision.target_id == target),
                    "{} remains held",
                    case.label
                );
            }
            if case.historian {
                let covered_arc = format!("hold-{}#0", case.drop);
                items.retain(|item| item.arc_id.as_deref() != Some(covered_arc.as_str()));
                let after_trim =
                    select_reductions_with_outcome(&items, &HashSet::new(), &ctx, &cfg);
                assert!(!after_trim
                    .decisions
                    .iter()
                    .any(|decision| decision.target_id == target));
                assert!(after_trim.protected_tool_block_ids.contains("hold-1#1"));
                continue;
            }
            items.push(tool_call(
                "arriving",
                200,
                &case.new_tool,
                serde_json::json!({}),
                0,
            ));
            items.push(tool_result("arriving", 200, &case.new_tool, 100));
            ctx.pass_class = PassClass::Defer;
            assert!(select_reductions(&items, &HashSet::new(), &ctx, &cfg).is_empty());
            ctx.pass_class = PassClass::Execute;
            let selected = select_reductions(&items, &HashSet::new(), &ctx, &cfg);
            assert!(
                selected.iter().any(|decision| decision.target_id == target),
                "{} applies after rotation",
                case.label
            );
            let frozen = HashSet::from([target.clone()]);
            assert!(
                !select_reductions(&items, &frozen, &ctx, &cfg)
                    .iter()
                    .any(|decision| decision.target_id == target),
                "{} never resurrects",
                case.label
            );
        }
    }

    #[test]
    fn protected_tool_historian_queued_drop_holds_until_fold_trim() {
        let mut items = vec![
            tool_call("older", 1, "custom", serde_json::json!({}), 0),
            tool_result("older", 1, "custom", 100),
            tool_call("covered", 2, "custom", serde_json::json!({}), 0),
            tool_result("covered", 2, "custom", 100),
        ];
        let cfg = SelectionConfig {
            protected_tools: [("custom".to_string(), 1)].into(),
            ..SelectionConfig::default()
        };
        let mut ctx = base_ctx(PassClass::Execute);
        ctx.pass_already_busting = true;
        // Agent and historian drops use the same durable queue and protection
        // rules. A summarized result stops counting when a fold trims its source.
        ctx.agent_drop_ids = vec!["covered#1".to_string()];
        assert!(!select_reductions(&items, &HashSet::new(), &ctx, &cfg)
            .iter()
            .any(|decision| decision.target_id == "covered#1"));
        items.retain(|item| !item.id.starts_with("covered#"));
        let outcome = select_reductions_with_outcome(&items, &HashSet::new(), &ctx, &cfg);
        assert!(outcome.protected_tool_block_ids.contains("older#1"));
        assert!(!outcome
            .decisions
            .iter()
            .any(|decision| decision.target_id == "covered#1"));
    }
}
