//! The transform op: the CK-in / CK-out cache-stability transform.
//!
//! Emits the rewritten array: `pass_output.ck_messages = [m0, m1] ++ tail`.
//! The covered sparse-but-ordered prefix is REPLACED by two frozen synthesized-region blocks
//! (m0 cumulative baseline, frozen between HARD folds; m1 volatile delta, re-rendered
//! on SOFT); the live tail (after the coverage watermark) is carried verbatim.
//!
//! mc-module OWNS the render/splice; mc-core stays the pure classifier and
//! cortexkit-cache-core stays "dumb" (freezes whatever rendered units it is handed).
//!
//! Cache discipline: render byte-complete units ONLY on bust passes; replay verbatim
//! on defer; a pure defer (boundary present, no delta) writes nothing. Two paired
//! poison-resistance invariants: synthetic items are stripped before any boundary /
//! coverage / tail computation (PRIMARY), and the `mc_*` id namespace is reserved
//! (BACKSTOP) so a synthetic block can never masquerade as the real boundary.

use crate::ck_wire;
use crate::compartment_coverage::{fold_m0_content_epoch, resolve_coverage, M0ContentEpoch};
use crate::healing::{self, quirk_residual, SerializerProfile};
use crate::injection::{advance_injection_from_meta, capture_todo_state_on_bust, InjectionOutcome};
use crate::m0_compose::compose_m0_from_store;
use crate::m1_compose::{compose_m1_from_store, m1_revision_signal, m1_revision_signal_parts};
use crate::memory_render::M1_PLACEHOLDER;
use crate::scheduler::{
    self, BoundaryBypass, ContextUsage, DeferredExecute, ExecuteThresholdConfig, LatchState,
    SchedulerConfig, SchedulerInputs, SessionMeta, TailState,
};
use crate::selection::{
    select_reductions, PassClass, SelItem, SelKind, SelectionConfig, SelectionContext,
};
use mc_core::{classify, CkItem, ClassifierInput, CoreState, FrozenUnit, PassInput, PassPlan};
use mc_store::{
    Channel1AppendRow, DeferredExecuteState, McStore, McStoreError, McTagRow, ModuleMeta,
    ModuleUsage, PendingAgentDrop, PendingRewriteState, StoredCompartment, TagMintInput,
    TemporalMarkInput, TemporalMarkRow, TransformCommit, TransformOverlayBatch,
    UserHintDecisionInput, UserHintRow, SHADOW_SESSION_PREFIX,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use crate::ck_wire::{
    duplicate_ids, project_messages, reduced_block, split_block_id, CkIngressMessage, CkWireBlock,
    CkWireError, CkWireMessage, FlatBlock, FlatProjection,
};

/// Max CAS retries before surfacing the conflict (the module is the single writer in
/// the daemon case, so this rarely loops; the shared-store case re-loads and re-steps).
const MAX_CAS_RETRIES: u32 = 8;

/// Reserved synthetic-block ids (never carried by a real conversation item).
#[cfg(test)]
const M0_ID: &str = "mc_m0";
/// The reserved id prefix: a non-synthetic item bearing it is a contract violation.
const RESERVED_ID_PREFIX: &str = "mc_";
const SYNTH_REGION_KIND: &str = "synthesized-region";
/// Frozen-unit key prefix for a tail reduction (a reduced tool output / superseded edit).
/// `red:<target_id>` — the target is the real tail item whose bytes are replaced.
const RED_KEY_PREFIX: &str = "red:";
/// Repeated pending/raw ↔ present interleaving should be impossible with correctly
/// separated upstream session keys. Five edges corresponds to three arm/clear cycles
/// when the initial arm is not counted as evidence of multiplexing by itself.
const PENDING_REWRITE_AMBIGUOUS_EDGE_THRESHOLD: u32 = 5;
const CHANNEL1_FLOOR_TOKENS: i64 = 10_000;
const CHANNEL1_REFIRE_FLOOR_TOKENS: i64 = 10_000;
const CHANNEL1_PRESSURE_FLOOR: f64 = 0.8;
const CHANNEL1_USABLE_FRACTION: f64 = 1.0 / 3.0;
const CHANNEL2_MIN_RECLAIMABLE: i64 = 10_000;
const CHANNEL2_USABLE_FRACTION: f64 = 1.0 / 3.0;
const TEMPORAL_AWARENESS_THRESHOLD_MS: i64 = 5 * 60 * 1_000;
const USER_HINT_QUERY_CHAR_CAP: usize = 500;
const USER_HINT_FRAGMENT_CHAR_CAP: usize = 100;
const USER_HINT_TOTAL_CHAR_CAP: usize = 600;
const USER_HINT_CANDIDATE_LIMIT: usize = 100;
const USER_HINT_TOKEN_CAP: usize = 24;
const USER_HINT_RESULT_LIMIT: usize = 3;
const USER_HINT_MIN_MATCHED_TOKENS: usize = 2;
const USER_HINT_NORMALIZED_SCORE_FLOOR: f64 = 0.35;
const DEFAULT_CLEAR_REASONING_AGE: u64 = 50;

#[cfg(test)]
thread_local! {
    static USER_HINT_LEXICAL_QUERY_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The m1 delta content + its byte-affecting digest. `revision` is a digest over ALL
/// byte-affecting m1 render inputs such that `render` is a pure function of what the
/// digest covers: if the rendered bytes would differ, `revision` differs. NEVER a
/// max-id counter (a same-id update changes bytes without raising a max id).
/// `revision == 0` is the placeholder (no delta).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct M1Content {
    pub revision: u64,
    pub body: String,
}

/// One tail-reduction decision: the target tail item and the byte-complete reduced
/// payload that replaces its bytes (`[dropped N]`, or a `filePath + region-hint +
/// [dropped N]` skeleton). The payload is captured at FREEZE and is authoritative
/// thereafter — never re-read for an already-frozen target (a moving recent-window
/// re-derive must not flip the bytes).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReductionDecision {
    pub target_id: String,
    #[serde(default)]
    pub kind: String,
    pub payload: String,
}

/// Legacy flat request item accepted only for backward compatibility with older
/// request fixtures. New callers send `messages` and receive bare CK messages.
#[derive(Debug, Clone, Deserialize)]
struct LegacyCkItemWire {
    pub id: String,
    pub ordinal: u64,
    pub bytes: String,
    #[serde(default)]
    pub synthetic: bool,
}

/// The project context the module composes m0/m1 FROM. Resolved once per request from the
/// authenticated route binding (never a request body field) and threaded into the
/// transform. Production ALWAYS supplies it; it carries the render inputs (budget,
/// expiry cutoff) so the frozen render decision preserves them and later passes replay identical bytes.
pub struct ProducerContext<'a> {
    /// The project identity the store reads key off (memories, mutation log, workspace).
    pub project_path: &'a str,
    /// The project directory on disk, for reading ARCHITECTURE.md / STRUCTURE.md.
    pub project_directory: &'a str,
    /// The history budget in tokens for this pass. Authority callers resolve it from the
    /// stable model limit and may refresh it after a config change; the route binding
    /// supplies a fallback for older callers. A cache-busting render pass freezes the selected value in m0.
    pub history_budget_tokens: f64,
    /// Whether memory tools and m0 memory rendering are enabled for this binding.
    pub memory_enabled: bool,
    /// The wall-clock now (ms) for THIS pass. Used only to SET `meta.expiry_cutoff_ms` on
    /// a HARD (the first materialization freezes it); every later pass reads the frozen
    /// meta value, never this, so expiry never drifts the bytes between passes.
    pub now_ms: i64,
    /// Execute threshold frozen at route bind for scheduler and selection headroom.
    pub execute_threshold_percentage: f64,
    /// Smart-drop selector gate frozen at route bind.
    pub smart_drops: bool,
    /// Cache TTL string from SessionMeta config; defaults to `5m`.
    pub cache_ttl: String,
    /// Provider/model key for threshold lookup. Per-model overrides are deferred, so
    /// production currently supplies None.
    pub model_key: Option<String>,
    /// In-process response observation. None disables TTL-hard even if durable metadata
    /// has an older sparse commit anchor.
    pub observed_last_response_at_ms: Option<i64>,
    /// Current `Today's date: ...` guidance line. The transform copies it only when
    /// this pass already rewrites cached context; updating wall-clock text during an
    /// otherwise stable pass would make the date itself a reason to rewrite again.
    pub guidance_date: Option<String>,
    #[cfg(test)]
    pub injected_reductions: Vec<ReductionDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeclaredTrim {
    pub flat_boundary_id: String,
    pub boundary_bare_message_id: String,
    pub boundary_absolute_ordinal: u64,
    pub next_absolute_ordinal: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TrimMismatch {
    pub predicate: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundaryState {
    LivePresent,
    DeclaredTrimValidated,
    Absent,
}

impl BoundaryState {
    fn is_present(&self) -> bool {
        matches!(self, Self::LivePresent | Self::DeclaredTrimValidated)
    }
}

/// A transform pass request. `boundary_present` is deliberately NOT a field: it is a
/// cache-correctness decision (replay-frozen vs reconcile) that the module computes
/// from its own durable state, never caller-supplied (a caller-supplied value would be
/// a poison surface — a crafted array could force a wrong replay or reconcile). The
/// wire carries full CK messages; the module flattens them at ingress and groups them
/// back to CK messages at egress.
#[derive(Debug, Clone, Serialize)]
pub struct TransformRequest {
    #[serde(default)]
    pub kind: String,
    #[serde(default = "default_wire_version")]
    pub v: u32,
    /// Required on the v2 wire. It is a plain string at the parse layer so a missing
    /// or unknown value can be reported with the typed contract error instead of serde's
    /// generic malformed-request path.
    pub serializer_profile: String,
    pub session_id: String,
    pub render_config: String,
    /// Canonical provider id used by the native serializer gate. Empty sentinels are
    /// safe only for the OpenCode Anthropic adapter, matching TS `modelAcceptsEmptyContent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Provider/model key retained for older plugin senders that predate the explicit
    /// provider field. The canonical `anthropic/...` prefix is the same provider gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
    /// Number of message ordinals kept as recent reasoning before the OpenCode
    /// native serve pass clears older assistant reasoning. This mirrors the TS
    /// `clear_reasoning_age` setting; the module uses absolute ordinals because
    /// its CK ingress does not carry TS tag numbers.
    #[serde(default = "default_clear_reasoning_age")]
    pub clear_reasoning_age: u64,
    /// Whether this request advertises the canonical reduction tool. Missing input is
    /// deliberately false so older callers stay on the dormant byte path.
    #[serde(default)]
    pub tool_present: bool,
    /// Ask the module to include an OpenCode-native rendering alongside canonical CK.
    /// Missing input is deliberately false so existing responses remain byte-identical.
    #[serde(default)]
    pub serve_native: bool,
    /// Optional OpenCode message-with-parts ingress used to retain provider-native fields
    /// while encoding a served response. CK-only callers may omit it; native serving still
    /// produces valid OpenCode messages, but cannot replay fields that were not supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_messages: Option<Vec<Value>>,
    /// Caller-owned identity for the full raw array. The module treats it as opaque and
    /// only echoes it on success-shaped responses so consumers can validate cached bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_array_fingerprint: Option<String>,
    pub messages: Vec<CkIngressMessage>,
    /// Future delta optimization. Parsed explicitly so a delta-shaped request is rejected
    /// with flow-control bytes rather than silently treated as an empty/full payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_delta: Option<Value>,
    #[serde(default)]
    pub usage: Option<ModuleUsage>,
    #[serde(default)]
    pub provider_error: Option<String>,
    /// Shadow-only evidence that the newest assistant tail is still streaming. When true,
    /// identity enforcement leaves that tail provisional until a later completed pass.
    #[serde(default)]
    pub mid_turn: bool,
    /// Proxy-observed completion time for the prior successful response on this exact
    /// conversation key. It is request evidence only and never enters render identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_response_completed_at_ms: Option<u64>,
    /// Proxy-observed wall-clock time at request INGRESS, before transform queueing.
    /// The G2 gap pairs this with `prev_response_completed_at_ms`: module-side now_ms
    /// runs after queue/blocking-arm latency (up to minutes under the emergency arms)
    /// and would inflate every gap by that delay. Request evidence only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_observed_at_ms: Option<u64>,
    /// History budget resolved by the harness from the stable context limit, threshold,
    /// and history-budget percentage. Authority transforms carry it per pass because a
    /// route can outlive a config reload; absent values use the bind-time fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_budget_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_trim: Option<DeclaredTrim>,
}

fn default_wire_version() -> u32 {
    2
}

fn default_clear_reasoning_age() -> u64 {
    DEFAULT_CLEAR_REASONING_AGE
}

#[derive(Deserialize)]
struct TransformRequestWire {
    #[serde(default)]
    kind: String,
    #[serde(default = "default_wire_version")]
    v: u32,
    #[serde(default)]
    serializer_profile: Option<String>,
    session_id: String,
    render_config: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_key: Option<String>,
    #[serde(default = "default_clear_reasoning_age")]
    clear_reasoning_age: u64,
    #[serde(default)]
    tool_present: bool,
    #[serde(default)]
    serve_native: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_messages: Option<Vec<Value>>,
    #[serde(default)]
    full_array_fingerprint: Option<String>,
    #[serde(default)]
    messages: Vec<CkIngressMessage>,
    #[serde(default)]
    items: Vec<LegacyCkItemWire>,
    #[serde(default)]
    tail_delta: Option<Value>,
    #[serde(default)]
    usage: Option<ModuleUsage>,
    #[serde(default)]
    provider_error: Option<String>,
    #[serde(default)]
    mid_turn: bool,
    #[serde(default)]
    prev_response_completed_at_ms: Option<u64>,
    #[serde(default)]
    request_observed_at_ms: Option<u64>,
    #[serde(default)]
    history_budget_tokens: Option<f64>,
    #[serde(default)]
    declared_trim: Option<DeclaredTrim>,
}

impl<'de> Deserialize<'de> for TransformRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = TransformRequestWire::deserialize(deserializer)?;
        let messages = if wire.messages.is_empty() && !wire.items.is_empty() {
            wire.items.into_iter().map(legacy_item_to_message).collect()
        } else {
            wire.messages
        };
        Ok(Self {
            kind: wire.kind,
            v: wire.v,
            serializer_profile: wire.serializer_profile.unwrap_or_default(),
            session_id: wire.session_id,
            render_config: wire.render_config,
            provider_id: wire.provider_id,
            model_key: wire.model_key,
            clear_reasoning_age: wire.clear_reasoning_age,
            tool_present: wire.tool_present,
            serve_native: wire.serve_native,
            native_messages: wire.native_messages,
            full_array_fingerprint: wire.full_array_fingerprint,
            messages,
            tail_delta: wire.tail_delta,
            usage: wire.usage,
            provider_error: wire.provider_error,
            mid_turn: wire.mid_turn,
            prev_response_completed_at_ms: wire.prev_response_completed_at_ms,
            request_observed_at_ms: wire.request_observed_at_ms,
            history_budget_tokens: wire.history_budget_tokens,
            declared_trim: wire.declared_trim,
        })
    }
}

fn legacy_item_to_message(item: LegacyCkItemWire) -> CkIngressMessage {
    CkIngressMessage {
        mid: item.id.clone(),
        ordinal: item.ordinal,
        ck: CkWireMessage::from_parts(
            "user",
            vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: item.bytes,
            })],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some(item.id),
                synthetic: item.synthetic,
                ..Default::default()
            },
        ),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransformStatus {
    Ok,
    NeedFullSync,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServedFrom {
    Transform,
    DaemonLkg,
}

/// The coherent request-local reduction surface state reported to the forwarding layer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceState {
    Inactive,
    Transition,
    Active,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Channel2NudgeDirective {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostDirectives {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel2_nudge: Option<Channel2NudgeDirective>,
}

/// A transform pass result. Diagnostics remain alongside the CK array, but the response
/// messages themselves are bare CK messages: no request-only `mid` or `ordinal` sidecar.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransformResponse {
    pub status: TransformStatus,
    pub served_from: ServedFrom,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_array_fingerprint: Option<String>,
    pub action: String,
    pub boundary_id: String,
    pub reconcile_pending: bool,
    pub version: u64,
    pub row_version: u64,
    pub surface_state: SurfaceState,
    pub committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub historian: Option<HistorianDiagnostics>,
    /// The actual output messages for this pass: synthetic m0 and m1 messages followed
    /// by the tail messages, all expressed as bare CK messages. `None` (field ABSENT on
    /// the wire) on a `need_full_sync` response: the consumer discriminates structurally
    /// on array presence, and an empty array would be a third ambiguous state between
    /// "transformed to nothing" and "re-send required". Every `ok` response carries
    /// `Some`, even when legitimately empty.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ck_messages: Option<Vec<CkWireMessage>>,
    /// OpenCode message-with-parts output, present only when the request opted into native
    /// serving and selected the `opencode-aisdk` serializer profile.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub native_messages: Option<Vec<Value>>,
    /// Host-delivery instructions are additive and profile-gated. The module does not
    /// persist delivery because the host owns the channel-2 lease and deduplication.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_directives: Option<HostDirectives>,
}

impl TransformResponse {
    /// The output array of an `ok`/passthrough response; empty for `need_full_sync`
    /// (whose wire form omits the field entirely).
    pub fn messages(&self) -> &[CkWireMessage] {
        self.ck_messages.as_deref().unwrap_or(&[])
    }

    pub fn need_full_sync(full_array_fingerprint: Option<String>) -> Self {
        Self {
            status: TransformStatus::NeedFullSync,
            served_from: ServedFrom::Transform,
            full_array_fingerprint,
            action: "NEED_FULL_SYNC".to_string(),
            boundary_id: String::new(),
            reconcile_pending: false,
            version: 0,
            row_version: 0,
            surface_state: SurfaceState::Inactive,
            committed: false,
            coverage_ordinal: None,
            historian: None,
            ck_messages: None,
            native_messages: None,
            host_directives: None,
        }
    }

    pub fn passthrough(
        ck_messages: Vec<CkWireMessage>,
        full_array_fingerprint: Option<String>,
    ) -> Self {
        Self {
            status: TransformStatus::Ok,
            served_from: ServedFrom::Transform,
            full_array_fingerprint,
            action: "PASSTHROUGH".to_string(),
            boundary_id: String::new(),
            reconcile_pending: false,
            version: 0,
            row_version: 0,
            surface_state: SurfaceState::Inactive,
            committed: false,
            coverage_ordinal: None,
            historian: None,
            ck_messages: Some(ck_messages),
            native_messages: None,
            host_directives: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistorianDiagnostics {
    pub fired: bool,
    pub reason: Option<String>,
    pub no_fire: Option<String>,
    pub state: String,
    /// Tail-size progress numbers from the trigger's boundary resolution, absent when the
    /// pass never reached boundary resolution (busy, load failure, no messages). Purely
    /// observational: lets a rig drive see eligible content approach the fire bar per pass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<HistorianTriggerProgress>,
    /// Detail of the most recent failed firing, from durable state. Present until a later
    /// firing establishes its producer run; supervised deployments have no stderr capture,
    /// so this is the only place the failure reason is visible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HistorianTriggerProgress {
    pub eligible_chunk_tokens: f64,
    pub tail_size_bar: f64,
    pub protected_tail_n_tokens: f64,
    pub protected_start_ordinal: u64,
}

pub struct TransformWithProjection {
    pub response: TransformResponse,
    pub projection: FlatProjection,
    pub scheduler_pass: scheduler::PassDecision,
    pub boundary_state: BoundaryState,
    pub trim_mismatch: Option<TrimMismatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaggableKind {
    Message,
    ToolResult,
}

impl TaggableKind {
    fn as_store_kind(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::ToolResult => "tool_result",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel1Level {
    Gentle,
    Firm,
    Urgent,
}

impl Channel1Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Gentle => "gentle",
            Self::Firm => "firm",
            Self::Urgent => "urgent",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Gentle => 1,
            Self::Firm => 2,
            Self::Urgent => 3,
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "gentle" => Some(Self::Gentle),
            "firm" => Some(Self::Firm),
            "urgent" => Some(Self::Urgent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct TagOverlayState {
    tag_by_block_id: BTreeMap<String, i64>,
    temporal_by_block_id: BTreeMap<String, String>,
    user_hint_by_block_id: BTreeMap<String, String>,
    channel1_by_block_id: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ActiveTagForNudge {
    tag_number: i64,
    kind: String,
    token_count: i64,
}

#[derive(Debug, Clone)]
struct Channel1Decision {
    fire: bool,
    level: Channel1Level,
    reclaimable_tokens: i64,
    next_last_nudge: i64,
    next_last_level: String,
}

#[derive(Debug, Default)]
struct PendingOverlayDecisions {
    max_seen_ordinal: Option<u64>,
    tag_mints: Vec<TagMintInput>,
    temporal_marks: Vec<TemporalMarkInput>,
    user_hint: Option<UserHintDecisionInput>,
    channel1_append: Option<Channel1AppendRow>,
}

struct OverlayComputation<'a, 'ctx> {
    store: &'a McStore,
    req: &'a TransformRequest,
    ctx: &'a ProducerContext<'ctx>,
    projection: &'a FlatProjection,
    core: &'a CoreState,
    tag_rows: &'a mut Vec<McTagRow>,
    temporal_rows: &'a mut Vec<TemporalMarkRow>,
    user_hint_rows: &'a mut Vec<UserHintRow>,
    overlay_frontier: Option<u64>,
    mutation_exempt_mid: Option<&'a str>,
}

impl PendingOverlayDecisions {
    fn is_empty(&self) -> bool {
        self.max_seen_ordinal.is_none()
            && self.tag_mints.is_empty()
            && self.temporal_marks.is_empty()
            && self.user_hint.is_none()
            && self.channel1_append.is_none()
    }
}

struct Channel1NudgeInputs<'a, 'ctx> {
    ctx: &'a ProducerContext<'ctx>,
    core: &'a CoreState,
    projection: &'a FlatProjection,
    tag_rows: &'a [McTagRow],
    channel1_appends: &'a [Channel1AppendRow],
    mutation_exempt_mid: Option<&'a str>,
    context_limit_tokens: f64,
    input_tokens: f64,
}

/// Transform errors. Each leaves the durable frozen-set UNCHANGED (the CAS simply does
/// not advance), so the next pass replays the last good state or busts cleanly; the
/// handler maps these to a clean Error frame rather than a partial/raw array.
#[derive(Debug)]
pub enum TransformError {
    Store(McStoreError),
    /// Live-source ordinals must be unique + strictly increasing.
    OrdinalViolation,
    /// A non-synthetic item used a reserved `mc_*` id.
    ReservedId,
    /// An unknown / corrupt frozen-set shape (never destructively cleared).
    UnknownShape(&'static str),
    /// The decider supplied a reduction for an already-frozen target with DIFFERENT
    /// bytes — a monotonicity-contract violation (a frozen reduction is immutable
    /// within an epoch). Fail loud instead of silently serving the stale frozen bytes.
    ReductionConflict,
    /// A stored coverage range overlaps, or the live array proves a present raw message
    /// would be trimmed without being covered by any compartment. Fail loud.
    CoverageGap(String),
    /// The lexical hint query failed before a durable decision could be written.
    Search(String),
    /// CK ingress rejected an unsupported or unpairable block before any partial projection.
    CkWire(CkWireError),
    /// Two flattened blocks produced the same `mid#block_index` id in one request.
    DuplicateBlockId(String),
    /// A live message's block-kind/fingerprint vector changed after first sight.
    IdentityDrift(String),
    /// A frozen synthetic todo pair could not be replayed at its stored tail anchor.
    SyntheticTodoAnchorMissing(String),
    /// A frozen reduction still names a live message, but that exact block disappeared.
    FrozenRedTargetVanish(String),
    /// A bust folded/advanced coverage from a compartment, but the anchor it minted (the
    /// last covered block's id) is empty or absent from the live input this pass. The
    /// anchor can then never be present, so reconcile can never clear and the pass loops
    /// as an unbounded phantom HARD. Fail loud: it signals an empty or wrong-vocabulary
    /// compartment end_message_id (the anchor must be a flat block id, `<mid>#<index>`).
    BoundaryNotPresent(String),
}

impl std::fmt::Display for TransformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransformError::Store(e) => write!(f, "store: {e}"),
            TransformError::OrdinalViolation => {
                write!(f, "live-source ordinals not strictly increasing")
            }
            TransformError::ReservedId => write!(f, "non-synthetic item used a reserved mc_* id"),
            TransformError::UnknownShape(m) => write!(f, "unknown frozen-set shape: {m}"),
            TransformError::ReductionConflict => write!(
                f,
                "decider re-supplied an already-frozen reduction target with different bytes"
            ),
            TransformError::CoverageGap(m) => write!(f, "{m}"),
            TransformError::Search(m) => write!(f, "search: {m}"),
            TransformError::CkWire(e) => write!(f, "ck wire: {e}"),
            TransformError::DuplicateBlockId(id) => write!(f, "duplicate flattened block id: {id}"),
            TransformError::IdentityDrift(mid) => {
                write!(f, "CK message block identity drift for mid {mid}")
            }
            TransformError::SyntheticTodoAnchorMissing(mid) => write!(
                f,
                "synthetic todo anchor mid {mid} is missing from the live tail"
            ),
            TransformError::FrozenRedTargetVanish(id) => {
                write!(
                    f,
                    "frozen reduction target vanished while its message is live: {id}"
                )
            }
            TransformError::BoundaryNotPresent(m) => {
                write!(f, "minted boundary not present: {m}")
            }
        }
    }
}
impl std::error::Error for TransformError {}

impl TransformError {
    /// These failures are deterministic for the same shadow payload. The sender can park a
    /// poisoned shadow lineage instead of retrying it forever; store and search failures remain
    /// retryable because their cause may be transient.
    pub fn is_deterministic_reject(&self) -> bool {
        !matches!(self, Self::Store(_) | Self::Search(_))
    }
}

impl From<CkWireError> for TransformError {
    fn from(e: CkWireError) -> Self {
        TransformError::CkWire(e)
    }
}

impl From<McStoreError> for TransformError {
    fn from(e: McStoreError) -> Self {
        TransformError::Store(e)
    }
}
impl From<crate::m0_compose::M0ComposeError> for TransformError {
    fn from(e: crate::m0_compose::M0ComposeError) -> Self {
        use crate::m0_compose::M0ComposeError;
        match e {
            M0ComposeError::Store(s) => TransformError::Store(s),
            M0ComposeError::CoverageGap(g) => TransformError::CoverageGap(g.to_string()),
        }
    }
}
impl From<crate::m1_compose::M1ComposeError> for TransformError {
    fn from(e: crate::m1_compose::M1ComposeError) -> Self {
        use crate::m1_compose::M1ComposeError;
        match e {
            M1ComposeError::Store(s) => TransformError::Store(s),
            M1ComposeError::CoverageGap(g) => TransformError::CoverageGap(g.to_string()),
        }
    }
}

/// Apply one transform pass, retrying the whole load→classify→step→commit cycle on a
/// CAS conflict (re-classification depends on the freshly-loaded state). `ctx` is the
/// resolved project producer context (m0/m1 are composed from its store reads). Tail
/// reductions are produced inside the pass from the scheduler-gated selector.
///
/// The real Claude token estimator ([`mc_tokenizer::estimate_tokens`]) is injected into
/// the m0 compose (the decay renderer's budget guard). It is reached ONLY on the
/// Hard/MigrateHard arm — never SOFT, defer, m1 compose, or the tail splice — so it can
/// only change bytes during an intentional HARD rematerialization; determinism (the same
/// text always counts identically, via the vendored+pinned vocab) is what preserves
/// byte-identical replay between HARDs.
pub fn transform(
    store: &McStore,
    req: &TransformRequest,
    ctx: &ProducerContext<'_>,
) -> Result<TransformResponse, TransformError> {
    transform_with_projection(store, req, ctx).map(|result| result.response)
}

pub fn transform_with_projection(
    store: &McStore,
    req: &TransformRequest,
    ctx: &ProducerContext<'_>,
) -> Result<TransformWithProjection, TransformError> {
    apply_once_with_estimator(store, req, ctx, mc_tokenizer::estimate_tokens)
}

/// The retry wrapper around [`apply_once`], parameterized by the token estimator so tests
/// can inject a panicking/counting one to prove the estimator is HARD-only (never called
/// on SOFT/defer). Production always passes [`mc_tokenizer::estimate_tokens`].
fn apply_once_with_estimator(
    store: &McStore,
    req: &TransformRequest,
    ctx: &ProducerContext<'_>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<TransformWithProjection, TransformError> {
    let mut attempt = 0;
    loop {
        match apply_once(store, req, ctx, estimate_tokens) {
            Err(TransformError::Store(McStoreError::CasConflict { .. }))
                if attempt < MAX_CAS_RETRIES =>
            {
                attempt += 1;
                continue;
            }
            other => return other,
        }
    }
}

fn apply_once(
    store: &McStore,
    req: &TransformRequest,
    ctx: &ProducerContext<'_>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<TransformWithProjection, TransformError> {
    // --- ingress: CK messages -> flat blocks, then strip synthetic before cache logic ---
    let projection = project_messages(&req.messages)?;
    if let Some(id) = duplicate_ids(&projection.blocks) {
        return Err(TransformError::DuplicateBlockId(id));
    }
    let live: Vec<&FlatBlock> = projection
        .blocks
        .iter()
        .filter(|i| !i.synthetic())
        .collect();
    for item in &live {
        if item.id().starts_with(RESERVED_ID_PREFIX) {
            return Err(TransformError::ReservedId);
        }
    }
    let mut prev: Option<u64> = None;
    for msg in req.messages.iter().filter(|m| !m.ck.meta.synthetic) {
        if let Some(p) = prev {
            if msg.ordinal <= p {
                return Err(TransformError::OrdinalViolation);
            }
        }
        prev = Some(msg.ordinal);
    }

    let serializer_profile = SerializerProfile::parse(&req.serializer_profile);
    let mutation_exempt_mid =
        latest_assistant_mutation_exempt_mid(&req.messages, serializer_profile, req.mid_turn);
    let cc_u1_active = crate::cc_u1_active(serializer_profile, req.tool_present);
    let tagging_surface_requested =
        crate::tagging_surface_active(serializer_profile, req.tool_present);
    let transform_snapshot = store.load_transform_snapshot(&req.session_id)?;
    let loaded = transform_snapshot.loaded;
    let overlay_frontier = transform_snapshot.overlay_frontier;
    // Legacy sessions stored the CC latch before the generic surface latch existed.
    // Treat that old true value as the generic latch so an upgrade does not repeat a fold.
    let persisted_tagging_surface_active =
        loaded.meta.tagging_surface_active || loaded.meta.cc_u1_active;
    let surface_transition = persisted_tagging_surface_active != tagging_surface_requested;
    let surface_state = if surface_transition {
        SurfaceState::Transition
    } else if tagging_surface_requested {
        SurfaceState::Active
    } else {
        SurfaceState::Inactive
    };

    // Every module-owned byte-affecting epoch is folded before activation decisions. The
    // tagger is active only after its non-zero epoch is present in the session's committed
    // render identity, so an established dormant session cannot acquire tags before the
    // coordinating cache-breaking HARD fold has committed.
    let memory_render_epoch = if crate::MEMORY_RENDER_FORMAT_EPOCH != 0 {
        format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH)
    } else {
        String::new()
    };
    let compartment_render_epoch = if crate::COMPARTMENT_RENDER_FORMAT_EPOCH != 0 {
        format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH)
    } else {
        String::new()
    };
    let profile_render_epoch = serializer_profile
        .map(crate::profile_render_epoch)
        .filter(|epoch| *epoch != 0)
        .map(|epoch| format!("mpe{epoch}"))
        .unwrap_or_default();
    let tagger_feature_epoch = match crate::tagger_feature_epoch(tagging_surface_requested) {
        0 => String::new(),
        epoch => format!("tfe{epoch}"),
    };
    let effective_render_config = fold_m0_content_epoch(
        &req.render_config,
        &M0ContentEpoch {
            workspace_fingerprint: store.workspace_fingerprint(ctx.project_path)?,
            upgrade_state: String::new(),
            memory_content_epoch: String::new(),
            memory_render_epoch,
            compartment_render_epoch,
            profile_render_epoch,
            tagger_feature_epoch: tagger_feature_epoch.clone(),
        },
    );
    let tagging_active = tagging_surface_requested && persisted_tagging_surface_active;
    // Previously stored overlay rows may still replay when boundary-lineage validation
    // later forces pass-through. Decisions from this request stay in memory until the
    // final cache-state compare-and-swap accepts the pass.
    // Tags are also the durable token-accounting source for host directives. Keeping them
    // available on non-CC profiles is render-neutral: overlay bytes remain gated by
    // `tagging_active`, while the OpenCode host can receive the same ceiling decision.
    let mut tag_rows = transform_snapshot.tags;
    let mut channel1_appends = if tagging_active {
        transform_snapshot.channel1_appends
    } else {
        Vec::new()
    };
    let mut user_hints = if tagging_active {
        transform_snapshot.user_hints
    } else {
        Vec::new()
    };
    let mut temporal_marks = if tagging_active {
        transform_snapshot.temporal_marks
    } else {
        Vec::new()
    };

    // Check whether the boundary is present in the live messages, or through a shadow
    // trim record that matches durable coverage and the first untrimmed message. A failed
    // trim record is treated as Absent so the existing reconciliation error paths still run.
    let (boundary_state, trim_mismatch) =
        resolve_boundary_state(store, req, &loaded.core, &loaded.meta, &live)?;
    let boundary_present = boundary_state.is_present();
    let boundary_token = if boundary_present {
        loaded.core.boundary_id.clone()
    } else {
        "-".to_string()
    };

    let mut has_compartments_cache: Option<bool> = None;
    let mut pending_rewrite_absent_shape = false;
    if !boundary_present {
        let needs_lineage_check = loaded.meta.pending_rewrite.is_some()
            || !loaded.core.boundary_id.is_empty()
            || loaded.meta.coverage_ordinal.is_some()
            || {
                let has_compartments = store.has_compartments(&req.session_id)?;
                has_compartments_cache = Some(has_compartments);
                has_compartments
            };
        if needs_lineage_check {
            let compartments = store.load_compartments(&req.session_id)?;
            let has_compartments = !compartments.is_empty();
            has_compartments_cache = Some(has_compartments);
            pending_rewrite_absent_shape = loaded.row_version.is_some()
                && has_durable_lineage(&loaded.core, &loaded.meta, has_compartments)
                && surviving_revert_prefix_seq(&compartments, &live) < 0;
        }
    }

    // A share-nothing boundary absence on a session with held lineage is not a valid
    // re-cut target. New conversations must arrive on a fresh upstream key; on an old
    // key this is either a missed lineage switch or foreign traffic. The destructive
    // truncate-all arm is eliminated, not gated: only a committed truncate may bump the
    // revert epoch, and this arm never owns a truncate. It records one durable alarm and
    // then serves raw bytes without touching identity, usage, scheduler, or core state.
    if pending_rewrite_absent_shape {
        let fingerprint = absent_shape_fingerprint(&live);
        if loaded.meta.pending_rewrite.is_some() {
            eprintln!(
                "mc-module: pending_rewrite raw pass-through for {} fingerprint {}",
                req.session_id, fingerprint
            );
            let passthrough_overlay = tagging_active.then(|| {
                tag_overlay_state(&tag_rows, &temporal_marks, &user_hints, &channel1_appends)
            });
            return Ok(pending_passthrough_result(
                projection,
                req,
                loaded.row_version.unwrap_or(0),
                false,
                trim_mismatch,
                passthrough_overlay.as_ref(),
                surface_state,
            ));
        }

        let core = loaded.core.clone();
        let mut meta = loaded.meta.clone();
        let mut trip_count = meta.pending_rewrite_trip_count;
        if trip_count > 0 {
            trip_count = trip_count.saturating_add(1);
        }
        let ambiguous = meta.pending_rewrite_ambiguous
            || trip_count >= PENDING_REWRITE_AMBIGUOUS_EDGE_THRESHOLD;
        meta.pending_rewrite = Some(PendingRewriteState {
            armed_at_ms: ctx.now_ms,
            absent_shape_fingerprint: fingerprint.clone(),
            absent_request_count: 1,
            last_present_at_ms: (meta.last_committed_pass_at_ms > 0)
                .then_some(meta.last_committed_pass_at_ms),
        });
        meta.pending_rewrite_trip_count = trip_count;
        meta.pending_rewrite_ambiguous = ambiguous;
        meta.pending_rewrite_last_failure = Some(pending_rewrite_detail(
            &req.session_id,
            &fingerprint,
            ambiguous,
        ));
        meta.last_committed_pass_at_ms = ctx.now_ms;
        let row_version = store.commit(&req.session_id, loaded.row_version, &core, &meta)?;
        eprintln!(
            "mc-module: armed pending_rewrite for {} fingerprint {} ambiguous={}",
            req.session_id, fingerprint, ambiguous
        );
        let passthrough_overlay = tagging_active
            .then(|| tag_overlay_state(&tag_rows, &temporal_marks, &user_hints, &channel1_appends));
        return Ok(pending_passthrough_result(
            projection,
            req,
            row_version,
            true,
            trim_mismatch,
            passthrough_overlay.as_ref(),
            surface_state,
        ));
    }

    let clear_pending_rewrite_on_present =
        loaded.meta.pending_rewrite.is_some() && boundary_present;

    let provisional_tail_mid = provisional_tail_mid(req);
    enforce_block_identity(
        &loaded.meta,
        &projection,
        &loaded.core,
        provisional_tail_mid,
    )?;
    let mut pending_overlays = PendingOverlayDecisions::default();
    if tagging_active
        && !loaded.core.reconcile_pending
        && (loaded.meta.pending_rewrite.is_none() || clear_pending_rewrite_on_present)
    {
        pending_overlays = compute_active_overlay_decisions(OverlayComputation {
            store,
            req,
            ctx,
            projection: &projection,
            core: &loaded.core,
            tag_rows: &mut tag_rows,
            temporal_rows: &mut temporal_marks,
            user_hint_rows: &mut user_hints,
            overlay_frontier,
            mutation_exempt_mid,
        })?;
    }
    let pending_agent_drops = store.load_pending_agent_drops(&req.session_id)?;

    // --- CHEAP per-pass classify signals (read EVERY pass; never the m0/m1 BODY) ---
    // The cheap m1-change digest (watermark triple). Computed every pass to gate SOFT vs
    // defer WITHOUT composing the body; the body composes only on the bust arm below.
    let m1_signal = m1_revision_signal_parts(store, ctx.project_path, &req.session_id)?;
    let mut current_m1_digest = m1_signal.revision;
    let effective_usage = effective_usage(req.usage.as_ref(), loaded.meta.last_usage.as_ref());
    let context_limit_tokens = effective_context_limit_tokens(&effective_usage);
    let usage_input_tokens = effective_usage.current_total_input_tokens as f64;
    let usage_percentage = if context_limit_tokens > 0.0 {
        usage_input_tokens / context_limit_tokens * 100.0
    } else {
        0.0
    };
    let mut scheduler_outcome = scheduler::decide(&SchedulerInputs {
        config: scheduler_config(ctx.execute_threshold_percentage),
        usage: ContextUsage {
            percentage: usage_percentage,
            input_tokens: usage_input_tokens,
        },
        session: SessionMeta {
            last_response_time_ms: ctx
                .observed_last_response_at_ms
                .map(|ts| ts.max(0) as u64)
                .unwrap_or(0),
            cache_ttl: ctx.cache_ttl.clone(),
        },
        now_ms: ctx.now_ms.max(0) as u64,
        model_key: ctx.model_key.clone(),
        context_limit: Some(context_limit_tokens),
        tail_state: tail_state_from_live(&live),
        deferred_execute: loaded
            .meta
            .deferred_execute_state
            .as_ref()
            .map(deferred_from_meta),
        boundary_bypass: BoundaryBypass {
            explicit_bust: loaded.meta.soft_refresh_pending,
            subagent: false,
        },
        drain_latch: latch_from_meta(&loaded.meta),
        overflow_error_text: req.provider_error.clone(),
    });
    // A flush requests work on the next pass, not a new m0 fold. Promote only a normal
    // defer to Execute; mandatory bootstrap, epoch, and pressure decisions retain priority.
    if loaded.meta.soft_refresh_pending && scheduler_outcome.pass == scheduler::PassDecision::Defer
    {
        scheduler_outcome.pass = scheduler::PassDecision::Execute;
        scheduler_outcome.deferred_execute = None;
    }
    // First-fold HARD trigger: a never-minted boundary (empty boundary_id) means no
    // compartment has ever folded into m0 (the fold is what mints the boundary). Once the
    // historian publishes the session's FIRST compartment, it cannot ride m1 as a SOFT
    // delta — a SOFT delta requires the boundary to be present so the new compartment can
    // splice onto it, and there is no boundary yet — so without this trigger it strands on
    // defer forever. Force a HARD to fold it and mint the first boundary. Uses a presence
    // check, NOT max_compartment_seq (which COALESCEs a missing MAX to 0, indistinguishable
    // from a real first compartment at sequence 0). Self-limiting: the fold mints a
    // non-empty boundary_id, so this is false on every subsequent pass and later publishes
    // correctly ride m1 as a SOFT delta once the boundary is present. The store query runs
    // only in this rare never-minted window (short-circuited by is_empty), never in steady
    // state where the boundary is present.
    let first_fold_due = if loaded.core.boundary_id.is_empty() {
        match has_compartments_cache {
            Some(value) => value,
            None => store.has_compartments(&req.session_id)?,
        }
    } else {
        false
    };
    let render_config_changed =
        loaded.meta.initialized && effective_render_config != loaded.meta.last_render_config;
    let reconcile_hard_due = loaded.core.reconcile_pending && !boundary_present;
    // If Claude-code coverage advances over system messages, force a HARD render so the
    // messages move into the m0 prefix before the byte-splice profile suppresses their
    // separate re-emission. The full compartment rows load only when the cheap max-seq
    // scalar says coverage may have changed since meta last recorded it.
    let compartment_seq_changed_since_meta = loaded.meta.initialized
        && m1_signal.max_compartment_seq != meta_coverage_compartment_seq(&loaded.meta);
    let system_absorb_hard_due = if serializer_profile
        == Some(SerializerProfile::ClaudeCodeAnthropic)
        && compartment_seq_changed_since_meta
    {
        let compartments = store.load_compartments(&req.session_id)?;
        let new_coverage = coverage_ordinal_from_compartments(&compartments)?;
        coverage_advance_covers_new_system(req, loaded.meta.coverage_ordinal, new_coverage)
    } else {
        false
    };
    let hard_fold_requested =
        first_fold_due || scheduler_outcome.idle_ttl_fired || system_absorb_hard_due;
    // These are the byte-changing reasons that are knowable before reduction selection:
    // render epochs, TTL, reconcile rematerialization, emergency arming, and coverage
    // folds. A reconcile flag with a returned boundary only clears state on a defer, so
    // it is not a ride opportunity. The selection layer adds a different command's first
    // application as a ride opportunity. Provider-side rejection and post-selection
    // output drift are not knowable here; omitting them can delay a held batch to the
    // next bust, but cannot create an extra bust.
    let emergency_arm_engaged = matches!(
        scheduler_outcome.pass,
        scheduler::PassDecision::Force85 | scheduler::PassDecision::Emergency95
    ) || scheduler_outcome.drain_latch.is_active();
    let pass_already_busting = !loaded.meta.initialized
        || render_config_changed
        || hard_fold_requested
        || reconcile_hard_due
        || emergency_arm_engaged;
    // Profile defaults remain conservative, while the request-local tool signal enables
    // full-array tail reclaim for an active tagging surface. A false request therefore
    // retains the exact pre-capability behavior without changing the global profile table.
    let tail_reclaim_enabled = serializer_profile
        .is_none_or(|profile| healing::tail_reclaim(profile) || tagging_surface_requested);
    let producer_gate = tail_reclaim_enabled
        && producer_gate(
            scheduler_outcome.pass,
            !loaded.meta.initialized
                || render_config_changed
                || reconcile_hard_due
                || hard_fold_requested,
        );
    let selection_class = if producer_gate {
        selection_pass_class(scheduler_outcome.pass)
    } else {
        PassClass::Defer
    };
    let tail_for_selection = tail_sel_items(&live, loaded.meta.coverage_ordinal);
    let mut protected_block_ids = if tagging_surface_requested {
        newest_active_tag_block_ids(
            &loaded.core,
            &loaded.meta,
            &projection,
            &tag_rows,
            mutation_exempt_mid,
        )
    } else {
        HashSet::new()
    };
    if let Some(mid) = mutation_exempt_mid {
        protected_block_ids.extend(
            projection
                .blocks
                .iter()
                .filter(|block| block.mid == mid)
                .map(|block| block.id.clone()),
        );
    }
    let selected_reductions = if producer_gate {
        let frozen = frozen_red_targets(&loaded.core);
        // No per-request gate here: producer_gate already requires
        // tail_reclaim_enabled, which is the profile default OR the request-local
        // surface. Gating again on the request-local surface alone would starve
        // the durable queue on profiles whose default is true (owned/Pi/OpenCode
        // legs drain unconditionally).
        let agent_drop_ids = pending_agent_drops
            .iter()
            .map(|drop| drop.target_id.clone())
            .collect::<Vec<_>>();
        let agent_drop_command_ids = pending_agent_drops
            .iter()
            .filter_map(|drop| {
                drop.command_id
                    .as_ref()
                    .map(|command_id| (drop.target_id.clone(), command_id.clone()))
            })
            .collect::<HashMap<_, _>>();
        let first_applied_agent_drop_ids = pending_agent_drops
            .iter()
            .filter(|drop| drop.command_first_applied_at_ms.is_some())
            .map(|drop| drop.target_id.clone())
            .collect::<HashSet<_>>();
        select_reductions(
            &tail_for_selection,
            &frozen,
            &SelectionContext {
                pass_class: selection_class,
                current_total_input_tokens: usage_input_tokens,
                ceiling_tokens: context_limit_tokens
                    * ctx.execute_threshold_percentage.clamp(1.0, 100.0)
                    / 100.0,
                protected_cutoff_ordinal: 0,
                prior_input_sample: loaded.meta.last_emergency_input_sample,
                has_prior_drop: loaded.meta.has_prior_emergency_drop,
                agent_drop_ids,
                agent_drop_command_ids,
                first_applied_agent_drop_ids,
                pass_already_busting,
                protected_block_ids: protected_block_ids.clone(),
            },
            &SelectionConfig {
                smart_drops: ctx.smart_drops,
            },
        )
    } else {
        Vec::new()
    };
    #[cfg(test)]
    let selected_reductions = if ctx.injected_reductions.is_empty() {
        selected_reductions
    } else {
        ctx.injected_reductions.clone()
    };
    // Fail-loud monotonicity guard, BEFORE classify and on EVERY pass: a frozen
    // reduction target re-supplied with different bytes breaks the immutable contract,
    // and the set-membership trigger would silently skip it (already frozen) and serve
    // the stale bytes — including on a defer. Error here instead.
    validate_reduction_monotonicity(&loaded.core, &selected_reductions)?;

    let reductions_pending_now = reductions_pending(
        &loaded.core,
        &selected_reductions,
        &live,
        loaded.meta.coverage_ordinal,
    );
    let plan = classify(&ClassifierInput {
        initialized: loaded.meta.initialized,
        is_legacy_baseline: is_legacy_baseline(&loaded.core),
        valid_m0m1_shape: valid_m0m1_shape(&loaded.core),
        render_config_changed,
        hard_fold_requested,
        boundary_present,
        reconcile_pending: loaded.core.reconcile_pending,
        m1_revision_changed: current_m1_digest != loaded.meta.m1_revision
            || loaded.meta.soft_refresh_pending,
        reductions_pending: reductions_pending_now,
    });

    let mut core = loaded.core.clone();
    let mut meta = loaded.meta.clone();
    let mut commit_expected = loaded.row_version;
    if clear_pending_rewrite_on_present {
        meta.pending_rewrite = None;
        meta.pending_rewrite_trip_count = meta.pending_rewrite_trip_count.saturating_add(1);
        if meta.pending_rewrite_trip_count >= PENDING_REWRITE_AMBIGUOUS_EDGE_THRESHOLD {
            meta.pending_rewrite_ambiguous = true;
            meta.pending_rewrite_last_failure = Some(pending_rewrite_detail(
                &req.session_id,
                "boundary_present_recovery",
                true,
            ));
            eprintln!(
                "mc-module: pending_rewrite ambiguous after boundary-present recovery for {}",
                req.session_id
            );
        } else if !meta.pending_rewrite_ambiguous {
            meta.pending_rewrite_last_failure = None;
        }
    }
    apply_ingress_meta(&mut meta, req, &projection, provisional_tail_mid);
    meta.cc_u1_active = cc_u1_active;
    meta.tagging_surface_active = tagging_surface_requested;
    if cc_u1_active {
        meta.last_serializer_profile = req.serializer_profile.clone();
    }
    apply_scheduler_meta(&mut meta, &scheduler_outcome);

    let is_bust_pass = matches!(
        plan,
        PassPlan::Hard | PassPlan::MigrateHard | PassPlan::Soft
    );
    if let Some(cutoff) = reasoning_clear_cutoff(
        req,
        serializer_profile,
        is_bust_pass,
        meta.reasoning_cleared_through_ordinal,
    ) {
        meta.reasoning_cleared_through_ordinal = meta.reasoning_cleared_through_ordinal.max(cutoff);
    }
    if loaded.meta.soft_refresh_pending && is_bust_pass {
        meta.soft_refresh_pending = false;
    }
    if is_bust_pass {
        if let Some(guidance_date) = ctx.guidance_date.as_ref() {
            meta.guidance_date = guidance_date.clone();
        }
    }
    let tail_for_capture = tail_for_selection.clone();
    if is_bust_pass && tail_reclaim_enabled {
        capture_todo_state_on_bust(&mut meta, &tail_for_capture, true);
    }

    let mut coverage_shrunk_on_bust = false;
    let mut commit_memory_revision = None;

    match plan {
        PassPlan::Reject(m) => return Err(TransformError::UnknownShape(m)),
        PassPlan::Hard | PassPlan::MigrateHard => {
            // EXPENSIVE bust-only: compose the m0 baseline from the store. now_ms freezes
            // the expiry cutoff into meta so every later in-epoch SOFT/defer reads the
            // SAME memory set (a memory expiring mid-epoch stays rendered until the next
            // HARD re-freezes the cutoff — the byte-stability tradeoff).
            let compartments_for_live_coverage = store.load_compartments(&req.session_id)?;
            let coverage_bounds =
                coverage_bounds_from_compartments(&compartments_for_live_coverage)?;
            let covered_system_messages = covered_system_messages_for_coverage(
                req,
                coverage_bounds.map(|(_, end)| end),
                coverage_bounds.map(|(start, _)| start),
                serializer_profile,
            );
            let mut comp = compose_m0_from_store(
                store,
                &crate::m0_compose::M0ComposeInputs {
                    session_id: &req.session_id,
                    project_path: ctx.project_path,
                    project_directory: ctx.project_directory,
                    now_ms: ctx.now_ms,
                    history_budget_tokens: ctx.history_budget_tokens,
                    covered_system_messages: &covered_system_messages,
                    memory_enabled: ctx.memory_enabled,
                },
                estimate_tokens,
            )?;

            // Live coverage guard: store-pure validation allows sparse coordinate
            // gaps because consumer producers can retire ordinal numbers permanently.
            // Once the live array is available, every present non-system block at or
            // below the coverage end must fall inside some compartment range; otherwise
            // build_output would trim unsummarized raw bytes from the tail.
            if let Some(stray) = first_uncovered_live_block(
                &compartments_for_live_coverage,
                &live,
                comp.coverage_ordinal,
            ) {
                return Err(TransformError::CoverageGap(format!(
                    "coverage gap: live item {} (ordinal {}) sits at or below coverage end {:?} \
                     but no compartment covers it; composing m0 would silently drop it from the tail",
                    stray.id(),
                    stray.ordinal(),
                    comp.coverage_ordinal
                )));
            }

            // Mint-absent guard: when this fold takes its anchor from a compartment
            // (coverage present), the minted boundary must be a block id that exists in
            // the live input THIS pass — the anchor is the last covered block, which the
            // producer always sends (trimming happens in our OUTPUT, and a producer-side
            // coverage trim keeps ordinals >= coverage_ordinal, so the boundary block
            // itself is never trimmed away). An empty or absent mint means either the
            // compartment's end_message_id is empty or in the wrong vocabulary (it must
            // be the flat block id `<mid>#<index>`, not a bare message id), or the store
            // still covers messages a revert removed and has not been re-cut. Committing
            // such an anchor makes presence impossible on every later pass, so reconcile
            // can never clear and every pass re-materializes — an unbounded phantom-HARD
            // loop serving summaries of content that may no longer exist. Fail loud
            // instead, on EVERY hard including a reconcile-rematerialize: a rematerialize
            // that cannot mint a presentable anchor has no path to clearing reconcile
            // either, and the loud error repeats until the store is re-cut. A revert that
            // clears the compartments entirely stays legitimate: coverage is then None
            // and the fold mints the reserved empty anchor without entering this guard.
            if comp.coverage_ordinal.is_some() {
                let minted = comp.boundary_id.as_str();
                if minted.is_empty()
                    || !boundary_available(
                        minted,
                        &live,
                        &boundary_state,
                        req.declared_trim.as_ref(),
                    )
                {
                    if loaded.core.reconcile_pending {
                        let compartments = store.load_compartments(&req.session_id)?;
                        let keep_through_seq = surviving_revert_prefix_seq(&compartments, &live);
                        let outcome = store.truncate_compartments_for_revert(
                            &req.session_id,
                            keep_through_seq,
                            commit_expected,
                        )?;
                        commit_expected = Some(outcome.row_version);
                        meta.revert_epoch = outcome.revert_epoch;
                        meta.last_recut = outcome.last_recut;
                        current_m1_digest =
                            m1_revision_signal(store, ctx.project_path, &req.session_id)?;
                        let recut_compartments = store.load_compartments(&req.session_id)?;
                        let recut_coverage_bounds =
                            coverage_bounds_from_compartments(&recut_compartments)?;
                        let recut_covered_system_messages = covered_system_messages_for_coverage(
                            req,
                            recut_coverage_bounds.map(|(_, end)| end),
                            recut_coverage_bounds.map(|(start, _)| start),
                            serializer_profile,
                        );
                        comp = compose_m0_from_store(
                            store,
                            &crate::m0_compose::M0ComposeInputs {
                                session_id: &req.session_id,
                                project_path: ctx.project_path,
                                project_directory: ctx.project_directory,
                                now_ms: ctx.now_ms,
                                history_budget_tokens: ctx.history_budget_tokens,
                                covered_system_messages: &recut_covered_system_messages,
                                memory_enabled: ctx.memory_enabled,
                            },
                            estimate_tokens,
                        )?;
                        if let Some(stray) = first_uncovered_live_block(
                            &recut_compartments,
                            &live,
                            comp.coverage_ordinal,
                        ) {
                            return Err(TransformError::CoverageGap(format!(
                                "coverage gap after re-cut: live item {} (ordinal {}) is below coverage end {:?} but uncovered",
                                stray.id(),
                                stray.ordinal(),
                                comp.coverage_ordinal
                            )));
                        }

                        if comp.coverage_ordinal.is_some() {
                            let reminted = comp.boundary_id.as_str();
                            if reminted.is_empty()
                                || !boundary_available(
                                    reminted,
                                    &live,
                                    &boundary_state,
                                    req.declared_trim.as_ref(),
                                )
                            {
                                return Err(TransformError::BoundaryNotPresent(format!(
                                    "re-cut kept compartments through sequence {keep_through_seq}, \
                                     but the fold still minted absent anchor {reminted:?}; \
                                     the publisher must write flat end_message_id block ids"
                                )));
                            }
                        }
                    } else {
                        return Err(TransformError::BoundaryNotPresent(format!(
                            "fold minted anchor {minted:?} from the folded compartment's \
                             end_message_id, but no live block carries that id; the anchor \
                             must be the flat block id (`<mid>#<index>`) of the last covered \
                             block; check the publisher's end_message_id"
                        )));
                    }
                }
            }

            // The reductions that SURVIVE the fold: m0 is now a compartment SUMMARY (not
            // covered raw bytes), so a reduction on a now-covered item simply drops with
            // it (no "fold reduced bytes into m0"); a target still in the new tail is kept;
            // a reverted-away target is an orphan. apply_units can't delete → rebuild.
            let effective = effective_reductions(&core, &selected_reductions);
            let survivors = surviving_red_units(&effective, &live, comp.coverage_ordinal);
            core.frozen_units.clear();
            core.pending_changes.clear();
            let mut rendered = vec![synth_region("m0", comp.m0_bytes), render_m1_placeholder()];
            rendered.extend(survivors);

            // A HARD re-composes m0 fully from the store, so the boundary ALWAYS reflects
            // the current coverage — set it unconditionally (empty when no compartments,
            // keeping boundary_id + coverage_ordinal consistent). The core only SETS on
            // Some, so mapping empty→None would leave a stale prior anchor alongside a
            // None coverage_ordinal — an inconsistent state.
            core.step(PassInput {
                proposed: Some(mc_core::Action::Hard),
                boundary_present: boundary_token,
                rendered_units: rendered,
                new_boundary_id: Some(comp.boundary_id.clone()),
                queued: Vec::new(),
                run_started: false,
            });
            meta.initialized = true;
            meta.last_render_config = effective_render_config;
            coverage_shrunk_on_bust =
                coverage_shrank(loaded.meta.coverage_ordinal, comp.coverage_ordinal);
            if coverage_shrunk_on_bust && tail_reclaim_enabled {
                let post_truncate_tail = tail_sel_items(&live, comp.coverage_ordinal);
                capture_todo_state_on_bust(&mut meta, &post_truncate_tail, true);
            }
            meta.coverage_ordinal = comp.coverage_ordinal;
            meta.coverage_start_ordinal = comp.first_covered_ordinal;
            meta.coverage_compartment_seq = Some(comp.folded_compartment_seq);
            meta.folded_compartment_seq = comp.folded_compartment_seq;
            commit_memory_revision = Some(comp.memory_revision.clone());
            meta.rendered_memory_ids = comp.rendered_memory_ids;
            meta.memory_mutation_cursor = comp.memory_mutation_cursor;
            meta.max_memory_id = comp.max_memory_id;
            meta.expiry_cutoff_ms = ctx.now_ms; // FROZEN here, atomic with the m0 bytes
                                                // The post-fold m1 baseline digest — NOT 0. After folding up to the current
                                                // watermarks, "no delta" == "watermarks unchanged since this digest"; setting
                                                // 0 would make the next pass's non-zero digest read as a phantom SOFT.
            meta.m1_revision = current_m1_digest;
        }
        PassPlan::Soft => {
            // EXPENSIVE bust-only: compose the m1 delta body from the store against the
            // watermarks the last HARD froze (incl. the FROZEN expiry cutoff). A
            // reduction-only SOFT recomposes byte-identical m1 (watermarks unchanged), so
            // the m1 unit stays stable; a new compartment extends coverage → advance the
            // boundary anchor in this same commit.
            let m1 = compose_m1_from_store(
                store,
                ctx.project_path,
                &req.session_id,
                &meta,
                meta.expiry_cutoff_ms,
            )?;
            let mut rendered = vec![render_m1_body(&m1.body)];
            rendered.extend(new_reduction_units(
                &core,
                &selected_reductions,
                &live,
                loaded.meta.coverage_ordinal,
            ));
            // A coverage-extending SOFT advances the boundary anchor (the bound core
            // primitive); a memory-only SOFT leaves it put (None).
            let new_boundary_id = m1.new_coverage.as_ref().map(|(id, _)| id.clone());
            if let Some((_, coverage_end)) = &m1.new_coverage {
                let compartments_for_live_coverage = store.load_compartments(&req.session_id)?;
                if let Some(stray) = first_uncovered_live_block(
                    &compartments_for_live_coverage,
                    &live,
                    Some(*coverage_end),
                ) {
                    return Err(TransformError::CoverageGap(format!(
                        "coverage gap: live item {} (ordinal {}) sits at or below coverage end {} \
                         but no compartment covers it; composing m1 would silently drop it from the tail",
                        stray.id(),
                        stray.ordinal(),
                        coverage_end
                    )));
                }
            }
            // Mint-absent guard, SOFT arm (same invariant as the fold's guard above): an
            // advanced anchor must exist in the live input this pass, or presence can
            // never hold afterward and the session decays into a reconcile-HARD loop. A
            // SOFT can only reach here with reconcile clear (the classifier routes a
            // pending reconcile to defer/HARD), so every advance is a fresh mint and the
            // check is unconditional.
            if let Some(id) = &new_boundary_id {
                if id.is_empty()
                    || !boundary_available(id, &live, &boundary_state, req.declared_trim.as_ref())
                {
                    return Err(TransformError::BoundaryNotPresent(format!(
                        "coverage-extending delta advanced the anchor to {id:?}, but no \
                         live block carries that id; the anchor must be the flat block id \
                         (`<mid>#<index>`) of the last covered block"
                    )));
                }
            }
            core.step(PassInput {
                proposed: Some(mc_core::Action::Soft),
                boundary_present: boundary_token,
                rendered_units: rendered,
                new_boundary_id,
                queued: Vec::new(),
                run_started: false,
            });
            // coverage_ordinal advances ATOMICALLY with the anchor (two views of one
            // coverage end — they must not desync).
            if let Some((_, ord)) = m1.new_coverage {
                meta.coverage_ordinal = Some(ord);
                meta.coverage_compartment_seq = Some(m1_signal.max_compartment_seq);
                // A coverage advance folds items out of the tail, so frozen red:*
                // units targeting them must go WITH the coverage. Only the HARD arm
                // rebuilds the frozen set (surviving_red_units); without this prune a
                // covered reduction would survive a coverage-extending SOFT as silent
                // bloat — and a later re-decide of that target with different bytes
                // would false-fire the monotonicity conflict guard.
                prune_covered_red_units(&mut core, &live, meta.coverage_ordinal);
            } else if compartment_seq_changed_since_meta {
                meta.coverage_compartment_seq = Some(m1_signal.max_compartment_seq);
            }
            meta.m1_revision = current_m1_digest;
        }
        PassPlan::Defer => {
            core.step(PassInput {
                proposed: Some(mc_core::Action::SoftPlus),
                boundary_present: boundary_token,
                ..Default::default()
            });
            if compartment_seq_changed_since_meta && current_m1_digest == loaded.meta.m1_revision {
                meta.coverage_compartment_seq = Some(m1_signal.max_compartment_seq);
            }
        }
    }

    if is_bust_pass && reductions_pending_now && selection_class == PassClass::EmergencyForce {
        meta.last_emergency_input_sample = usage_input_tokens;
        meta.has_prior_emergency_drop = true;
    }

    if tail_reclaim_enabled {
        advance_synthetic_todo(
            &mut meta,
            is_bust_pass,
            loaded.meta.coverage_ordinal,
            coverage_shrunk_on_bust,
            req,
        )?;
    }

    let result_action = action_str(&plan, &core);

    let mut tag_overlay = if tagging_active {
        tag_overlay_state(&tag_rows, &temporal_marks, &user_hints, &channel1_appends)
    } else {
        TagOverlayState::default()
    };
    if tagging_active {
        if let Some(row) = maybe_append_channel1_nudge(
            Channel1NudgeInputs {
                ctx,
                core: &core,
                projection: &projection,
                tag_rows: &tag_rows,
                channel1_appends: &channel1_appends,
                mutation_exempt_mid,
                context_limit_tokens,
                input_tokens: usage_input_tokens,
            },
            &mut meta,
        ) {
            tag_overlay
                .channel1_by_block_id
                .insert(row.block_id.clone(), row.reminder_text.clone());
            pending_overlays.channel1_append = Some(row.clone());
            channel1_appends.push(row);
        }
    }

    let ck_messages = build_output(
        &core,
        &meta,
        &projection,
        req,
        tagging_active.then_some(&tag_overlay),
        tail_reclaim_enabled,
        mutation_exempt_mid,
    )?;

    // Build the output before committing so a missing synthetic-todo anchor cannot
    // persist an unusable frozen pair. Pending rows are classified from the final plan:
    // live unfrozen targets remain durable, while applied or retired targets are consumed.
    let consumed_drop_ids = consumed_pending_drop_ids(
        &pending_agent_drops,
        &loaded.core,
        &core,
        &projection,
        meta.coverage_ordinal,
    );
    let first_applied_command_ids =
        first_applied_pending_command_ids(&pending_agent_drops, &loaded.core, &core);
    let state_changed = core != loaded.core || meta != loaded.meta;
    if state_changed {
        meta.last_committed_pass_at_ms = ctx.now_ms;
    }
    let commit_required =
        state_changed || !consumed_drop_ids.is_empty() || !pending_overlays.is_empty();
    let row_version = if commit_required {
        store.commit_transform(
            &req.session_id,
            TransformCommit {
                expected: commit_expected,
                core: &core,
                meta: &meta,
                consumed_drop_ids: &consumed_drop_ids,
                first_applied_command_ids: &first_applied_command_ids,
                memory_revision: commit_memory_revision.as_ref(),
                overlays: TransformOverlayBatch {
                    max_seen_ordinal: pending_overlays.max_seen_ordinal,
                    tag_mints: &pending_overlays.tag_mints,
                    temporal_marks: &pending_overlays.temporal_marks,
                    user_hint: pending_overlays.user_hint.as_ref(),
                    channel1_append: pending_overlays.channel1_append.as_ref(),
                    created_at_ms: ctx.now_ms,
                },
            },
        )?
    } else {
        loaded.row_version.unwrap_or(0)
    };
    let host_directives = channel2_directive(Channel2DirectiveInput {
        profile: serializer_profile,
        core: &core,
        meta: &meta,
        projection: &projection,
        tag_rows: &tag_rows,
        mutation_exempt_mid,
        context_limit_tokens,
        input_tokens: usage_input_tokens,
        execute_threshold_percentage: ctx.execute_threshold_percentage,
    });

    Ok(TransformWithProjection {
        projection,
        scheduler_pass: scheduler_outcome.pass,
        boundary_state,
        trim_mismatch,
        response: TransformResponse {
            status: TransformStatus::Ok,
            served_from: ServedFrom::Transform,
            full_array_fingerprint: req.full_array_fingerprint.clone(),
            action: result_action,
            boundary_id: core.boundary_id.clone(),
            reconcile_pending: core.reconcile_pending,
            version: core.version,
            row_version,
            surface_state,
            committed: commit_required,
            coverage_ordinal: meta.coverage_ordinal,
            historian: None,
            ck_messages: Some(ck_messages),
            native_messages: None,
            host_directives,
        },
    })
}

fn provisional_tail_mid(req: &TransformRequest) -> Option<&str> {
    if !req.mid_turn || !req.session_id.starts_with(SHADOW_SESSION_PREFIX) {
        return None;
    }
    req.messages
        .iter()
        .filter(|message| !message.ck.meta.synthetic && message.ck.role == "assistant")
        .max_by_key(|message| message.ordinal)
        .map(|message| message.mid.as_str())
}

fn enforce_block_identity(
    meta: &ModuleMeta,
    projection: &FlatProjection,
    core: &CoreState,
    provisional_tail_mid: Option<&str>,
) -> Result<(), TransformError> {
    for (mid, vector) in &projection.identity_by_mid {
        if provisional_tail_mid == Some(mid.as_str()) {
            continue;
        }
        if let Some(stored) = meta.block_identity_by_mid.get(mid) {
            if stored != vector {
                return Err(TransformError::IdentityDrift(mid.clone()));
            }
        }
    }

    let live_ids: BTreeSet<&str> = projection
        .blocks
        .iter()
        .filter(|block| !block.synthetic)
        .map(|block| block.id.as_str())
        .collect();
    let live_mids: BTreeSet<&str> = projection
        .identity_by_mid
        .keys()
        .map(String::as_str)
        .collect();
    for target in frozen_red_targets(core) {
        let Some((mid, _)) = split_block_id(&target) else {
            continue;
        };
        if provisional_tail_mid == Some(mid) {
            continue;
        }
        if live_mids.contains(mid) && !live_ids.contains(target.as_str()) {
            return Err(TransformError::FrozenRedTargetVanish(target));
        }
    }
    Ok(())
}

fn apply_ingress_meta(
    meta: &mut ModuleMeta,
    req: &TransformRequest,
    projection: &FlatProjection,
    provisional_tail_mid: Option<&str>,
) {
    if let Some(mid) = provisional_tail_mid {
        // Remove any stale pin for a tail that became streaming again. The next completed
        // pass must establish identity from the stable block vector, not from a partial form.
        meta.block_identity_by_mid.remove(mid);
    }
    for (mid, vector) in &projection.identity_by_mid {
        if provisional_tail_mid == Some(mid.as_str()) {
            continue;
        }
        meta.block_identity_by_mid
            .entry(mid.clone())
            .or_insert_with(|| vector.clone());
    }
    meta.newest_live_block_id = projection
        .blocks
        .iter()
        .filter(|block| !block.synthetic)
        .max_by_key(|block| block.ordinal)
        .map(|block| block.id.clone());
    if let Some(usage) = req.usage.as_ref().filter(|usage| usage.is_non_zero()) {
        meta.last_usage = Some(usage.clone());
    }
}

fn effective_usage(request: Option<&ModuleUsage>, persisted: Option<&ModuleUsage>) -> ModuleUsage {
    request
        .filter(|usage| usage.is_non_zero())
        .or(persisted)
        .cloned()
        .unwrap_or_default()
}

fn effective_context_limit_tokens(usage: &ModuleUsage) -> f64 {
    if usage.context_limit_tokens >= crate::scheduler::MIN_PLAUSIBLE_CONTEXT_LIMIT {
        usage.context_limit_tokens as f64
    } else {
        200_000.0
    }
}

fn scheduler_config(execute_threshold_percentage: f64) -> SchedulerConfig {
    SchedulerConfig {
        execute_threshold_percentage: ExecuteThresholdConfig::Percentage(
            execute_threshold_percentage,
        ),
        execute_threshold_tokens: None,
    }
}

fn producer_gate(pass: scheduler::PassDecision, hard_advisory: bool) -> bool {
    !matches!(pass, scheduler::PassDecision::Defer) || hard_advisory
}

fn selection_pass_class(pass: scheduler::PassDecision) -> PassClass {
    match pass {
        scheduler::PassDecision::Force85 | scheduler::PassDecision::Emergency95 => {
            PassClass::EmergencyForce
        }
        scheduler::PassDecision::Defer | scheduler::PassDecision::Execute => PassClass::Execute,
    }
}

fn deferred_from_meta(state: &DeferredExecuteState) -> DeferredExecute {
    DeferredExecute {
        reason: state.reason.clone(),
    }
}

fn deferred_to_meta(state: DeferredExecute) -> DeferredExecuteState {
    DeferredExecuteState {
        reason: state.reason,
    }
}

fn latch_from_meta(meta: &ModuleMeta) -> LatchState {
    LatchState {
        active_since_ms: meta
            .emergency_drain_active
            .then_some(meta.emergency_drain_entered_at_ms.max(0) as u64),
    }
}

fn apply_scheduler_meta(meta: &mut ModuleMeta, outcome: &scheduler::SchedulerOutcome) {
    meta.deferred_execute_state = if matches!(outcome.pass, scheduler::PassDecision::Defer) {
        outcome.deferred_execute.clone().map(deferred_to_meta)
    } else {
        None
    };
    meta.emergency_drain_active = outcome.drain_latch.active_since_ms.is_some();
    meta.emergency_drain_entered_at_ms = outcome
        .drain_latch
        .active_since_ms
        .map(|ts| ts as i64)
        .unwrap_or(0);
}

fn tail_state_from_live(live: &[&FlatBlock]) -> TailState {
    let Some(newest_assistant_ordinal) = live
        .iter()
        .filter(|block| block.role == "assistant")
        .map(|block| block.ordinal())
        .max()
    else {
        return TailState {
            mid_tool_use: false,
        };
    };
    let completed_arcs: HashSet<&str> = live
        .iter()
        .filter(|block| block.kind_tag == "tool_result" && !block.provider_executed)
        .filter_map(|block| block.arc_id.as_deref())
        .collect();
    let mid_tool_use = live.iter().any(|block| {
        block.role == "assistant"
            && block.ordinal() == newest_assistant_ordinal
            && block.kind_tag == "tool_call"
            && !block.provider_executed
            && block
                .arc_id
                .as_deref()
                .is_some_and(|arc| !completed_arcs.contains(arc))
    });
    TailState { mid_tool_use }
}

// --- shape predicates (mc-module reads the concrete frozen set; mc-core stays blind) ---

fn is_legacy_baseline(core: &CoreState) -> bool {
    core.frozen_units.len() == 1
        && core.frozen_units[0].key == "baseline"
        && core.pending_changes.is_empty()
}

/// A valid current shape: EXACTLY one `m0`, EXACTLY one `m1`, and zero-or-more `red:*`
/// tail-reduction units. An initialized state missing `m0`/`m1`, or carrying any other
/// key, is an unknown shape (rejected, never cleared). Tighter than "keys ⊆ {m0,m1,red}"
/// so a corrupt initialized state missing a region can't validate.
fn valid_m0m1_shape(core: &CoreState) -> bool {
    let m0 = core.frozen_units.iter().filter(|u| u.key == "m0").count();
    let m1 = core.frozen_units.iter().filter(|u| u.key == "m1").count();
    let rest_ok = core
        .frozen_units
        .iter()
        .all(|u| u.key == "m0" || u.key == "m1" || u.key.starts_with(RED_KEY_PREFIX));
    m0 == 1 && m1 == 1 && rest_ok
}

// --- reduction helpers (the tail-reducer mechanics) ---

/// Is `ordinal` in the live TAIL (strictly after the coverage watermark)? None coverage
/// = nothing folded yet = all live items are tail.
fn is_tail(ordinal: u64, coverage: Option<u64>) -> bool {
    coverage.is_none_or(|c| ordinal > c)
}

fn is_uncovered_leading_system(message: &CkIngressMessage, meta: &ModuleMeta) -> bool {
    if message.ck.role != "system" || meta.coverage_ordinal.is_none() {
        return false;
    }
    match meta.coverage_start_ordinal {
        Some(start) => message.ordinal < start,
        // Legacy metadata did not persist the first covered ordinal. Preserve the common
        // pinned system prompt at absolute ordinal 0 rather than risk dropping it.
        None => message.ordinal == 0,
    }
}

fn coverage_ordinal_from_compartments(
    compartments: &[StoredCompartment],
) -> Result<Option<u64>, TransformError> {
    coverage_bounds_from_compartments(compartments).map(|coverage| coverage.map(|(_, end)| end))
}

fn coverage_bounds_from_compartments(
    compartments: &[StoredCompartment],
) -> Result<Option<(u64, u64)>, TransformError> {
    resolve_coverage(compartments)
        .map(|coverage| coverage.map(|c| (c.first_covered_ordinal, c.coverage_end_ordinal)))
        .map_err(|gap| TransformError::CoverageGap(gap.to_string()))
}

fn meta_coverage_compartment_seq(meta: &ModuleMeta) -> i64 {
    meta.coverage_compartment_seq
        .unwrap_or(meta.folded_compartment_seq)
}

fn system_content_for_m0(message: &CkWireMessage) -> String {
    if message.content.len() == 1 {
        if let ck_wire::CkKind::Text { text } = &message.content[0].kind {
            return text.clone();
        }
    }
    serde_json::to_string(&message.content).unwrap_or_default()
}

fn covered_system_messages_for_coverage(
    req: &TransformRequest,
    coverage_ordinal: Option<u64>,
    coverage_start_ordinal: Option<u64>,
    profile: Option<SerializerProfile>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut covered = Vec::new();
    for message in req.messages.iter().filter(|message| {
        if message.ck.meta.synthetic
            || message.ck.role != "system"
            || is_tail(message.ordinal, coverage_ordinal)
        {
            return false;
        }
        if profile == Some(SerializerProfile::ClaudeCodeAnthropic) {
            return true;
        }
        coverage_start_ordinal.is_none_or(|start| message.ordinal >= start)
    }) {
        let content = system_content_for_m0(&message.ck);
        if seen.insert(content.clone()) {
            covered.push(content);
        }
    }
    covered
}

fn coverage_advance_covers_new_system(
    req: &TransformRequest,
    old_coverage: Option<u64>,
    new_coverage: Option<u64>,
) -> bool {
    if !coverage_advanced(old_coverage, new_coverage) {
        return false;
    }
    req.messages.iter().any(|message| {
        !message.ck.meta.synthetic
            && message.ck.role == "system"
            && is_tail(message.ordinal, old_coverage)
            && !is_tail(message.ordinal, new_coverage)
    })
}

/// The frozen payload for a target's reduction, if one is frozen.
fn frozen_red_payload<'a>(core: &'a CoreState, target: &str) -> Option<&'a str> {
    let key = format!("{RED_KEY_PREFIX}{target}");
    core.frozen_units
        .iter()
        .find(|u| u.key == key)
        .map(|u| u.frozen_payload.as_str())
}

/// Target ids that already carry a frozen `red:*` unit.
fn frozen_red_targets(core: &CoreState) -> std::collections::HashSet<String> {
    core.frozen_units
        .iter()
        .filter_map(|u| u.key.strip_prefix(RED_KEY_PREFIX).map(str::to_string))
        .collect()
}

/// Commands whose first application froze at least one previously unfrozen target.
fn first_applied_pending_command_ids(
    pending: &[PendingAgentDrop],
    loaded_core: &CoreState,
    final_core: &CoreState,
) -> Vec<String> {
    let frozen_before = frozen_red_targets(loaded_core);
    let frozen_after = frozen_red_targets(final_core);
    pending
        .iter()
        .filter_map(|drop| {
            let command_id = drop.command_id.as_ref()?;
            let applied = !drop.command_first_applied_at_ms.is_some()
                && !frozen_before.contains(&drop.target_id)
                && frozen_after.contains(&drop.target_id);
            applied.then(|| command_id.clone())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Return only queue rows whose target was frozen by this plan or is no longer a live,
/// unfrozen tail block. Every other row remains durable for a later eligible pass.
fn consumed_pending_drop_ids(
    pending: &[PendingAgentDrop],
    loaded_core: &CoreState,
    final_core: &CoreState,
    projection: &FlatProjection,
    final_coverage: Option<u64>,
) -> Vec<i64> {
    let frozen_before = frozen_red_targets(loaded_core);
    let frozen_after = frozen_red_targets(final_core);
    // Retirement must be PROVEN, not inferred from absence: the request array can be
    // a transient subset of the session (interactive side-requests), so a target
    // missing from this pass's projection may reappear on the next one. Consuming
    // its row on absence would silently lose an acknowledged drop. A block that is
    // PRESENT but at-or-under the coverage watermark is permanently retired
    // (coverage only advances), and an already-frozen target is satisfied — those
    // are the only non-applied rows safe to consume.
    let covered = projection
        .blocks
        .iter()
        .filter(|block| !block.synthetic && !is_tail(block.ordinal, final_coverage))
        .map(|block| block.id.as_str())
        .collect::<HashSet<_>>();
    // A drop aimed at a reasoning block is structurally unappliable (reasoning is
    // never a reduction target), proven from this pass's projection. Retiring the
    // row here keeps the queue from carrying it forever.
    let reasoning = projection
        .blocks
        .iter()
        .filter(|block| is_reasoning_block(&block.wire))
        .map(|block| block.id.as_str())
        .collect::<HashSet<_>>();

    pending
        .iter()
        .filter(|drop| {
            let applied =
                !frozen_before.contains(&drop.target_id) && frozen_after.contains(&drop.target_id);
            let obsolete = frozen_before.contains(&drop.target_id)
                || covered.contains(drop.target_id.as_str())
                || reasoning.contains(drop.target_id.as_str());
            applied || obsolete
        })
        .map(|drop| drop.id)
        .collect()
}

/// Build a `red:<target>` frozen unit (Lineage — it persists + replays byte-identical).
fn red_unit(target: &str, kind: &str, payload: &str) -> FrozenUnit {
    FrozenUnit {
        key: format!("{RED_KEY_PREFIX}{target}"),
        kind: kind.to_string(),
        frozen_payload: payload.to_string(),
        durability_class: mc_core::DurabilityClass::Lineage,
        reset_rule: String::new(),
    }
}

/// Fail-loud monotonicity guard (runs EVERY pass, before classify). If the selector
/// supplies a reduction whose target is ALREADY frozen with DIFFERENT bytes, that
/// breaks the immutable-once-frozen contract — and the set-membership trigger would
/// SILENTLY skip it (already in keys) and serve the stale frozen payload. Error instead.
fn validate_reduction_monotonicity(
    core: &CoreState,
    reductions: &[ReductionDecision],
) -> Result<(), TransformError> {
    for r in reductions {
        if let Some(frozen) = frozen_red_payload(core, &r.target_id) {
            if frozen != r.payload {
                return Err(TransformError::ReductionConflict);
            }
        }
    }
    Ok(())
}

/// Is there a NEW reduction to freeze: a selected reduction whose target is in the live
/// tail AND not yet frozen. Pure id set-membership — the SOFT trigger.
fn reductions_pending(
    core: &CoreState,
    reductions: &[ReductionDecision],
    live: &[&FlatBlock],
    coverage: Option<u64>,
) -> bool {
    let frozen = frozen_red_targets(core);
    let tail: std::collections::HashSet<&str> = live
        .iter()
        .filter(|i| is_tail(i.ordinal(), coverage))
        .map(|i| i.id())
        .collect();
    reductions
        .iter()
        .any(|r| tail.contains(r.target_id.as_str()) && !frozen.contains(&r.target_id))
}

/// The `red:*` units to freeze on a SOFT: each NEW selected reduction (target in the live
/// tail, not yet frozen), deduped by target, deterministic order.
fn new_reduction_units(
    core: &CoreState,
    reductions: &[ReductionDecision],
    live: &[&FlatBlock],
    coverage: Option<u64>,
) -> Vec<FrozenUnit> {
    let frozen = frozen_red_targets(core);
    let tail: std::collections::HashSet<&str> = live
        .iter()
        .filter(|i| is_tail(i.ordinal(), coverage))
        .map(|i| i.id())
        .collect();
    // Defense in depth behind the selector's own exclusion: refuse to mint a
    // frozen unit whose target is a reasoning block. A placeholder-rewritten
    // reasoning block loses its signature and can never re-encode for
    // Anthropic, permanently fencing the session to raw.
    let reasoning_targets: std::collections::HashSet<&str> = live
        .iter()
        .filter(|i| is_reasoning_block(&i.wire))
        .map(|i| i.id())
        .collect();
    let mut by_target: BTreeMap<String, FrozenUnit> = BTreeMap::new();
    for r in reductions {
        if reasoning_targets.contains(r.target_id.as_str()) {
            continue;
        }
        if tail.contains(r.target_id.as_str()) && !frozen.contains(&r.target_id) {
            by_target
                .entry(r.target_id.clone())
                .or_insert_with(|| red_unit(&r.target_id, &r.kind, &r.payload));
        }
    }
    by_target.into_values().collect()
}

/// The reductions in EFFECT this pass, snapshotted BEFORE any frozen-set mutation (the
/// HARD-fold snapshot): every frozen `red:*` (authoritative payload) ∪ every NEW selected
/// reduction (target not yet frozen). Keyed by target_id → (kind, payload), deterministic.
fn effective_reductions(
    core: &CoreState,
    reductions: &[ReductionDecision],
) -> BTreeMap<String, (String, String)> {
    let mut eff: BTreeMap<String, (String, String)> = BTreeMap::new();
    for u in &core.frozen_units {
        if let Some(target) = u.key.strip_prefix(RED_KEY_PREFIX) {
            eff.insert(
                target.to_string(),
                (u.kind.clone(), u.frozen_payload.clone()),
            );
        }
    }
    for r in reductions {
        eff.entry(r.target_id.clone())
            .or_insert_with(|| (r.kind.clone(), r.payload.clone()));
    }
    eff
}

/// Drop frozen `red:*` units whose target is now COVERED (ordinal at/below the new
/// coverage). Runs on a coverage-extending SOFT, where the tail shrinks but the frozen
/// set is otherwise kept: a reduction whose target left the tail can never be applied
/// again (`build_output` trims covered items first), so keeping it is pure bloat and a
/// false-conflict trap if the same target id is ever re-decided after a revert.
fn prune_covered_red_units(
    core: &mut mc_core::CoreState,
    live: &[&FlatBlock],
    new_coverage: Option<u64>,
) {
    let live_ord: BTreeMap<&str, u64> = live.iter().map(|i| (i.id(), i.ordinal())).collect();
    core.frozen_units.retain(|u| {
        let Some(target) = u.key.strip_prefix("red:") else {
            return true; // non-reduction units are coverage-independent
        };
        match live_ord.get(target) {
            Some(&ord) => is_tail(ord, new_coverage),
            // Target absent from the live array: leave it to the HARD-fold orphan GC,
            // which sees the authoritative post-revert array.
            None => true,
        }
    });
}

/// The `red:*` units that SURVIVE a HARD rebuild: a target that is COVERED (folded into
/// m0) is dropped; a target in the new TAIL is kept; a target ABSENT from the live array
/// (reverted away) is dropped as an orphan. So a unit survives iff its target is in the
/// live array AND still in the tail after the fold.
fn surviving_red_units(
    effective: &BTreeMap<String, (String, String)>,
    live: &[&FlatBlock],
    new_coverage: Option<u64>,
) -> Vec<FrozenUnit> {
    let live_ord: BTreeMap<&str, u64> = live.iter().map(|i| (i.id(), i.ordinal())).collect();
    effective
        .iter()
        .filter_map(
            |(target, (kind, payload))| match live_ord.get(target.as_str()) {
                Some(&ord) if is_tail(ord, new_coverage) => Some(red_unit(target, kind, payload)),
                _ => None,
            },
        )
        .collect()
}

// --- render helpers (the ONLY producers of frozen bytes) ---

/// The m1 placeholder unit (a HARD resets m1 to it; m1 is never fully empty).
fn render_m1_placeholder() -> FrozenUnit {
    synth_region("m1", M1_PLACEHOLDER.to_string())
}

/// The m1 delta unit from a composed body (an empty delta composes to the placeholder
/// body upstream, so this is a verbatim wrap).
fn render_m1_body(body: &str) -> FrozenUnit {
    synth_region("m1", body.to_string())
}

fn synth_region(key: &str, payload: String) -> FrozenUnit {
    FrozenUnit {
        key: key.to_string(),
        kind: SYNTH_REGION_KIND.to_string(),
        frozen_payload: payload,
        durability_class: mc_core::DurabilityClass::Lineage,
        reset_rule: String::new(),
    }
}

fn sel_item_from_flat(block: &FlatBlock) -> SelItem {
    let kind = match &block.wire.kind {
        ck_wire::CkKind::ToolCall { name, input, .. } => SelKind::ToolCall {
            name: name.clone(),
            input: input.clone(),
        },
        ck_wire::CkKind::ToolResult { tool_name, .. } => SelKind::ToolResult {
            tool_name: tool_name.clone(),
        },
        ck_wire::CkKind::Reasoning { .. } => SelKind::Reasoning,
        ck_wire::CkKind::Text { .. } => SelKind::Text,
        ck_wire::CkKind::RedactedReasoning { .. } => SelKind::RedactedReasoning,
        ck_wire::CkKind::Media(_) => SelKind::Media,
        ck_wire::CkKind::Opaque(_) => SelKind::Opaque,
    };
    SelItem {
        id: block.id.clone(),
        ordinal: block.ordinal,
        kind,
        provider_executed: block.provider_executed,
        byte_size: block.bytes.len(),
        arc_id: block.arc_id.clone(),
    }
}

fn tail_sel_items(live: &[&FlatBlock], coverage: Option<u64>) -> Vec<SelItem> {
    live.iter()
        .filter(|block| is_tail(block.ordinal(), coverage))
        .map(|block| sel_item_from_flat(block))
        .collect()
}

fn tail_end_mid(req: &TransformRequest, coverage: Option<u64>) -> Option<String> {
    req.messages
        .iter()
        .rfind(|msg| !msg.ck.meta.synthetic && is_tail(msg.ordinal, coverage))
        .map(|msg| msg.mid.clone())
}

fn tail_contains_mid(req: &TransformRequest, coverage: Option<u64>, mid: &str) -> bool {
    req.messages
        .iter()
        .any(|msg| !msg.ck.meta.synthetic && msg.mid == mid && is_tail(msg.ordinal, coverage))
}

fn coverage_advanced(old: Option<u64>, new: Option<u64>) -> bool {
    match (old, new) {
        (Some(old), Some(new)) => new > old,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn coverage_shrank(old: Option<u64>, new: Option<u64>) -> bool {
    match (old, new) {
        (Some(old), Some(new)) => new < old,
        (Some(_), None) => true,
        _ => false,
    }
}

fn stored_compartment_covers_ordinal(compartment: &StoredCompartment, ordinal: u64) -> bool {
    let start = compartment.start_message.max(0) as u64;
    let end = compartment.end_message.max(0) as u64;
    start <= ordinal && ordinal <= end
}

fn first_uncovered_live_block<'a>(
    compartments: &[StoredCompartment],
    live: &[&'a FlatBlock],
    coverage: Option<u64>,
) -> Option<&'a FlatBlock> {
    let coverage = coverage?;
    live.iter()
        .copied()
        .filter(|block| block.role != "system" && block.ordinal() <= coverage)
        .filter(|block| {
            !compartments
                .iter()
                .any(|compartment| stored_compartment_covers_ordinal(compartment, block.ordinal()))
        })
        .min_by_key(|block| block.ordinal())
}

fn boundary_available(
    id: &str,
    live: &[&FlatBlock],
    boundary_state: &BoundaryState,
    declared: Option<&DeclaredTrim>,
) -> bool {
    live.iter().any(|block| block.id() == id)
        || matches!(boundary_state, BoundaryState::DeclaredTrimValidated)
            && declared.is_some_and(|declared| declared.flat_boundary_id == id)
}

fn resolve_boundary_state(
    store: &McStore,
    req: &TransformRequest,
    core: &CoreState,
    meta: &ModuleMeta,
    live: &[&FlatBlock],
) -> Result<(BoundaryState, Option<TrimMismatch>), TransformError> {
    if !core.boundary_id.is_empty() && live.iter().any(|block| block.id() == core.boundary_id) {
        return Ok((BoundaryState::LivePresent, None));
    }

    let Some(declared) = req.declared_trim.as_ref() else {
        return Ok((BoundaryState::Absent, None));
    };

    if declared.flat_boundary_id != core.boundary_id {
        return Ok((
            BoundaryState::Absent,
            Some(trim_mismatch(
                "boundary_identity",
                format!(
                    "declared boundary {:?} did not match durable boundary {:?}",
                    declared.flat_boundary_id, core.boundary_id
                ),
            )),
        ));
    }

    if meta.coverage_ordinal != Some(declared.boundary_absolute_ordinal) {
        return Ok((
            BoundaryState::Absent,
            Some(trim_mismatch(
                "coverage_ordinal",
                format!(
                    "declared boundary ordinal {} did not match durable coverage {:?}",
                    declared.boundary_absolute_ordinal, meta.coverage_ordinal
                ),
            )),
        ));
    }

    let compartments = store.load_compartments(&req.session_id)?;
    let tail = compartments
        .iter()
        .max_by_key(|compartment| compartment.sequence);
    match tail {
        Some(tail)
            if tail.end_message_id == declared.flat_boundary_id
                && tail.end_message == declared.boundary_absolute_ordinal as i64
                && split_block_id(&tail.end_message_id)
                    .map(|(mid, _)| mid == declared.boundary_bare_message_id)
                    .unwrap_or(false) => {}
        Some(tail) => {
            return Ok((
                BoundaryState::Absent,
                Some(trim_mismatch(
                    "tail_compartment",
                    format!(
                        "tail compartment ended at id {:?} ordinal {}, not declared id {:?} bare {:?} ordinal {}",
                        tail.end_message_id,
                        tail.end_message,
                        declared.flat_boundary_id,
                        declared.boundary_bare_message_id,
                        declared.boundary_absolute_ordinal
                    ),
                )),
            ));
        }
        None => {
            return Ok((
                BoundaryState::Absent,
                Some(trim_mismatch(
                    "tail_compartment",
                    "declared trim had no durable tail compartment".to_string(),
                )),
            ));
        }
    }

    let first_live_non_system = req
        .messages
        .iter()
        .filter(|message| !message.ck.meta.synthetic && message.ck.role != "system")
        .map(|message| message.ordinal)
        .min();
    if first_live_non_system != Some(declared.next_absolute_ordinal) {
        return Ok((
            BoundaryState::Absent,
            Some(trim_mismatch(
                "continuity",
                format!(
                    "first non-system live ordinal {:?} did not match declared next ordinal {}",
                    first_live_non_system, declared.next_absolute_ordinal
                ),
            )),
        ));
    }

    Ok((BoundaryState::DeclaredTrimValidated, None))
}

fn trim_mismatch(predicate: &'static str, detail: String) -> TrimMismatch {
    TrimMismatch { predicate, detail }
}

fn surviving_revert_prefix_seq(compartments: &[StoredCompartment], live: &[&FlatBlock]) -> i64 {
    let live_ids: BTreeSet<&str> = live.iter().map(|block| block.id()).collect();
    compartments
        .iter()
        .take_while(|compartment| live_ids.contains(compartment.end_message_id.as_str()))
        .map(|compartment| compartment.sequence)
        .last()
        .unwrap_or(-1)
}

fn has_durable_lineage(core: &CoreState, meta: &ModuleMeta, has_compartments: bool) -> bool {
    has_compartments || !core.boundary_id.is_empty() || meta.coverage_ordinal.is_some()
}

fn absent_shape_fingerprint(live: &[&FlatBlock]) -> String {
    let mut hasher = Sha256::new();
    for block in live {
        hasher.update(block.id.as_bytes());
        hasher.update([0]);
        hasher.update(block.ordinal.to_le_bytes());
        hasher.update([0]);
        hasher.update(block.role.as_bytes());
        hasher.update([0]);
        hasher.update(block.kind_tag.as_bytes());
        hasher.update([0]);
        hasher.update(block.bytes.as_bytes());
        hasher.update([0xff]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn pending_rewrite_detail(session_id: &str, fingerprint: &str, ambiguous: bool) -> String {
    let state = if ambiguous {
        "ambiguous_pending_rewrite"
    } else {
        "pending_rewrite"
    };
    format!(
        "{state}: boundary-absent share-nothing array on session {session_id}; \
         absent_shape_fingerprint={fingerprint}; expected causes are an upstream \
         lineage-switch detection miss or foreign traffic on this session key; serving raw \
         pass-through and preserving the held lineage"
    )
}

fn pending_passthrough_result(
    projection: FlatProjection,
    req: &TransformRequest,
    row_version: u64,
    committed: bool,
    trim_mismatch: Option<TrimMismatch>,
    tag_overlay: Option<&TagOverlayState>,
    surface_state: SurfaceState,
) -> TransformWithProjection {
    let mutation_exempt_mid = latest_assistant_mutation_exempt_mid(
        &req.messages,
        SerializerProfile::parse(&req.serializer_profile),
        req.mid_turn,
    );
    let blocks_by_mid = projection_blocks_by_mid(&projection);
    let mut response = TransformResponse::passthrough(
        req.messages
            .iter()
            .map(|message| {
                let mut rendered = message.ck.clone();
                if let Some(blocks) = blocks_by_mid.get(message.mid.as_str()) {
                    apply_tag_overlay_to_message(
                        &mut rendered,
                        message,
                        blocks,
                        tag_overlay,
                        |_| false,
                        mutation_exempt_mid == Some(message.mid.as_str()),
                    );
                }
                rendered
            })
            .collect(),
        req.full_array_fingerprint.clone(),
    );
    response.row_version = row_version;
    response.surface_state = surface_state;
    response.committed = committed;
    TransformWithProjection {
        projection,
        scheduler_pass: scheduler::PassDecision::Defer,
        boundary_state: BoundaryState::Absent,
        trim_mismatch,
        response,
    }
}

fn anchor_folded_by_coverage(
    req: &TransformRequest,
    old_coverage: Option<u64>,
    new_coverage: Option<u64>,
    anchor_mid: &str,
) -> bool {
    coverage_advanced(old_coverage, new_coverage)
        && req.messages.iter().any(|msg| {
            !msg.ck.meta.synthetic
                && msg.mid == anchor_mid
                && is_tail(msg.ordinal, old_coverage)
                && !is_tail(msg.ordinal, new_coverage)
        })
}

fn advance_synthetic_todo(
    meta: &mut ModuleMeta,
    is_bust_pass: bool,
    old_coverage: Option<u64>,
    coverage_shrunk_on_bust: bool,
    req: &TransformRequest,
) -> Result<(), TransformError> {
    let existing = meta.synthetic_todo.clone();
    let outcome = advance_injection_from_meta(meta, existing.as_ref(), is_bust_pass);
    match outcome {
        InjectionOutcome::Replace(next) => {
            let anchor_mid = tail_end_mid(req, meta.coverage_ordinal);
            meta.synthetic_todo = Some((*next).freeze_at(anchor_mid));
        }
        InjectionOutcome::Clear => meta.synthetic_todo = None,
        InjectionOutcome::Keep => {
            if is_bust_pass {
                reanchor_kept_synthetic_todo_if_folded_or_shrunk(
                    meta,
                    old_coverage,
                    coverage_shrunk_on_bust,
                    req,
                )?;
            }
        }
        InjectionOutcome::None => {}
    }
    Ok(())
}

fn reanchor_kept_synthetic_todo_if_folded_or_shrunk(
    meta: &mut ModuleMeta,
    old_coverage: Option<u64>,
    coverage_shrunk_on_bust: bool,
    req: &TransformRequest,
) -> Result<(), TransformError> {
    let Some(pair) = meta.synthetic_todo.as_mut() else {
        return Ok(());
    };
    let Some(anchor_mid) = pair.anchor_mid.clone() else {
        return Ok(());
    };
    if tail_contains_mid(req, meta.coverage_ordinal, &anchor_mid) {
        return Ok(());
    }
    let folded_by_advance =
        anchor_folded_by_coverage(req, old_coverage, meta.coverage_ordinal, &anchor_mid);
    if !folded_by_advance && !coverage_shrunk_on_bust {
        return Err(TransformError::SyntheticTodoAnchorMissing(anchor_mid));
    }

    // A coverage-moving bust already changes the rendered bytes: advance folds the old
    // anchor into history, while shrink means the old anchor was in reverted-away tail. In
    // both cases an unchanged synthetic todo can move to the new tail end without turning
    // into an always-last floater on ordinary tail growth or defer passes.
    debug_assert!(folded_by_advance || coverage_shrunk_on_bust);
    pair.anchor_mid = tail_end_mid(req, meta.coverage_ordinal);
    Ok(())
}

fn push_synthetic_todo_pair(out: &mut Vec<CkWireMessage>, meta: &ModuleMeta) {
    if let Some(pair) = &meta.synthetic_todo {
        out.push(pair.assistant_msg.clone());
        out.push(pair.tool_msg.clone());
    }
}

fn tag_mint_inputs(
    projection: &FlatProjection,
    core: &CoreState,
    mutation_exempt_mid: Option<&str>,
) -> Vec<TagMintInput> {
    let frozen = frozen_red_targets(core);
    projection
        .blocks
        .iter()
        .filter(|block| !frozen.contains(&block.id))
        .filter(|block| mutation_exempt_mid != Some(block.mid.as_str()))
        .filter_map(|block| {
            let (kind, source) = taggable_source(block)?;
            Some(TagMintInput {
                block_id: block.id.clone(),
                kind: kind.as_store_kind().to_string(),
                token_count: mc_tokenizer::estimate_tokens(source) as i64,
                source_bytes: source.as_bytes().to_vec(),
            })
        })
        .collect()
}

/// Return exactly the span the overlay can prefix. Mint scope and overlay scope share
/// this predicate so every visible tag number has a renderable §N§ carrier.
fn taggable_source(block: &FlatBlock) -> Option<(TaggableKind, &str)> {
    if block.synthetic || block.role == "system" {
        return None;
    }
    match &block.wire.kind {
        ck_wire::CkKind::Text { text } if block.role == "user" || block.role == "assistant" => {
            Some((TaggableKind::Message, text))
        }
        ck_wire::CkKind::ToolResult { output, .. } => match &output.kind {
            ck_wire::CkOutputKind::Text { text } | ck_wire::CkOutputKind::ErrorText { text } => {
                Some((TaggableKind::ToolResult, text))
            }
            ck_wire::CkOutputKind::Content { blocks } => blocks.iter().find_map(|block| {
                if let ck_wire::ResultBlockKind::Text { text } = &block.kind {
                    Some((TaggableKind::ToolResult, text.as_str()))
                } else {
                    None
                }
            }),
            ck_wire::CkOutputKind::Json { .. }
            | ck_wire::CkOutputKind::ErrorJson { .. }
            | ck_wire::CkOutputKind::ExecutionDenied { .. } => None,
        },
        _ => None,
    }
}

fn taggable_kind(block: &FlatBlock) -> Option<TaggableKind> {
    taggable_source(block).map(|(kind, _)| kind)
}

/// Compute the newest protected tags as exact block ids over the current canonical tail.
/// Stored provenance must still match the live carrier before a row can occupy a slot.
fn newest_active_tag_block_ids(
    core: &CoreState,
    meta: &ModuleMeta,
    projection: &FlatProjection,
    tag_rows: &[McTagRow],
    mutation_exempt_mid: Option<&str>,
) -> HashSet<String> {
    const PROTECTED_TAG_COUNT: usize = 20;

    let block_by_id = projection
        .blocks
        .iter()
        .map(|block| (block.id.as_str(), block))
        .collect::<HashMap<_, _>>();
    let mut active = tag_rows
        .iter()
        .filter(|row| {
            let Some(block) = block_by_id.get(row.block_id.as_str()) else {
                return false;
            };
            if !is_tail(block.ordinal, meta.coverage_ordinal)
                || frozen_red_payload(core, block.id()).is_some()
                || mutation_exempt_mid == Some(block.mid.as_str())
            {
                return false;
            }
            let Some((kind, source)) = taggable_source(block) else {
                return false;
            };
            row.kind == kind.as_store_kind() && row.source_bytes == source.as_bytes()
        })
        .collect::<Vec<_>>();
    active.sort_by(|left, right| {
        right
            .tag_number
            .cmp(&left.tag_number)
            .then_with(|| right.block_id.cmp(&left.block_id))
    });
    active
        .into_iter()
        .take(PROTECTED_TAG_COUNT)
        .map(|row| row.block_id.clone())
        .collect()
}

fn tag_overlay_state(
    tag_rows: &[McTagRow],
    temporal_marks: &[TemporalMarkRow],
    user_hints: &[UserHintRow],
    appends: &[Channel1AppendRow],
) -> TagOverlayState {
    TagOverlayState {
        tag_by_block_id: tag_rows
            .iter()
            .map(|row| (row.block_id.clone(), row.tag_number))
            .collect(),
        temporal_by_block_id: temporal_marks
            .iter()
            .filter(|row| !row.marker_text.is_empty())
            .map(|row| (row.block_id.clone(), row.marker_text.clone()))
            .collect(),
        user_hint_by_block_id: user_hints
            .iter()
            .filter(|row| !row.hint_text.is_empty())
            .map(|row| (row.block_id.clone(), row.hint_text.clone()))
            .collect(),
        channel1_by_block_id: appends
            .iter()
            .map(|row| (row.block_id.clone(), row.reminder_text.clone()))
            .collect(),
    }
}

/// Format a mint-time delta as the deterministic prefix used by the active overlay.
pub fn temporal_gap_prefix(gap_ms: i64) -> Option<String> {
    if gap_ms < TEMPORAL_AWARENESS_THRESHOLD_MS {
        return None;
    }

    let seconds = gap_ms / 1_000;
    let marker = if seconds < 60 * 60 {
        format!("+{}m", seconds / 60)
    } else if seconds < 24 * 60 * 60 {
        let hours = seconds / (60 * 60);
        let minutes = (seconds - hours * 60 * 60) / 60;
        if minutes == 0 {
            format!("+{hours}h")
        } else {
            format!("+{hours}h {minutes}m")
        }
    } else if seconds < 7 * 24 * 60 * 60 {
        let days = seconds / (24 * 60 * 60);
        let hours = (seconds - days * 24 * 60 * 60) / (60 * 60);
        if hours == 0 {
            format!("+{days}d")
        } else {
            format!("+{days}d {hours}h")
        }
    } else {
        let weeks = seconds / (7 * 24 * 60 * 60);
        let days = (seconds - weeks * 7 * 24 * 60 * 60) / (24 * 60 * 60);
        if days == 0 {
            format!("+{weeks}w")
        } else {
            format!("+{weeks}w {days}d")
        }
    };
    Some(format!("<!-- {marker} -->\n"))
}

fn apply_tag_overlay_to_message(
    message: &mut CkWireMessage,
    ingress: &CkIngressMessage,
    blocks: &[&FlatBlock],
    overlay: Option<&TagOverlayState>,
    is_reduced: impl Fn(&FlatBlock) -> bool,
    mutation_exempt: bool,
) {
    if mutation_exempt {
        return;
    }
    let Some(overlay) = overlay else {
        return;
    };
    if ingress.ck.role == "system" || ingress.ck.meta.synthetic {
        return;
    }
    let mut modified = false;
    for block in blocks {
        if block.block_index >= message.content.len() {
            continue;
        }
        if !is_reduced(block) {
            let target = &mut message.content[block.block_index];
            let mut block_changed = false;
            if let Some(kind) = taggable_kind(block) {
                if let Some(tag_number) = overlay.tag_by_block_id.get(&block.id) {
                    block_changed |= apply_tag_prefix_to_block(
                        ingress.ck.role.as_str(),
                        target,
                        kind,
                        *tag_number,
                    );
                }
                // A boundary-lineage alarm forces raw pass-through, so only tags stored
                // before this request are available. Newly seen blocks wait for a normal
                // accepted pass rather than consuming tag numbers on rejected lineage.
            }
            if let Some(prefix) = overlay.temporal_by_block_id.get(&block.id) {
                block_changed |= prepend_temporal_to_block(target, prefix);
            }
            if let Some(hint) = overlay.user_hint_by_block_id.get(&block.id) {
                block_changed |= append_user_hint_to_block(target, hint);
            }
            if let Some(reminder) = overlay.channel1_by_block_id.get(&block.id) {
                block_changed |= append_channel1_to_block(target, reminder);
            }
            if block_changed {
                // Overlay edits mutate the typed kind in place, but Serialize
                // prefers a block's retained ingress bytes for lossless
                // pass-through: an uncleared block silently serializes its
                // pre-mutation form and the edit never reaches the wire. One
                // clear site covers every overlay mutator.
                target.mark_modified();
                modified = true;
            }
        }
    }
    if modified {
        message.mark_modified();
    }
}

fn apply_tag_prefix_to_block(
    role: &str,
    block: &mut CkWireBlock,
    kind: TaggableKind,
    tag_number: i64,
) -> bool {
    match (&mut block.kind, kind) {
        (ck_wire::CkKind::Text { text }, TaggableKind::Message)
            if role == "user" || role == "assistant" =>
        {
            // Models imitate the tag notation they see in history, sometimes at the
            // start of a later line in one assistant completion. Strip only line-leading
            // tokens outside code before applying the official tag; inline and prose
            // references remain authored content. Mint provenance still hashes the
            // verbatim ingress bytes.
            let base = if role == "assistant" {
                strip_leading_tag_imitations(text)
            } else {
                text.clone()
            };
            let next = prepend_tag(tag_number, &base);
            if *text != next {
                *text = next;
                return true;
            }
        }
        (ck_wire::CkKind::ToolResult { output, .. }, TaggableKind::ToolResult) => {
            return prepend_tag_to_tool_output(output, tag_number);
        }
        _ => {}
    }
    false
}

fn prepend_tag_to_tool_output(output: &mut ck_wire::CkToolOutput, tag_number: i64) -> bool {
    match &mut output.kind {
        ck_wire::CkOutputKind::Text { text } | ck_wire::CkOutputKind::ErrorText { text } => {
            let next = prepend_tag(tag_number, text);
            if *text != next {
                *text = next;
                return true;
            }
        }
        ck_wire::CkOutputKind::Content { blocks } => {
            for block in blocks {
                if let ck_wire::ResultBlockKind::Text { text } = &mut block.kind {
                    let next = prepend_tag(tag_number, text);
                    if *text != next {
                        *text = next;
                        return true;
                    }
                    return false;
                }
            }
        }
        ck_wire::CkOutputKind::Json { .. }
        | ck_wire::CkOutputKind::ErrorJson { .. }
        | ck_wire::CkOutputKind::ExecutionDenied { .. } => {}
    }
    false
}

fn prepend_temporal_to_block(block: &mut CkWireBlock, prefix: &str) -> bool {
    let ck_wire::CkKind::Text { text } = &mut block.kind else {
        return false;
    };
    if text.starts_with(prefix) {
        return false;
    }
    text.insert_str(0, prefix);
    true
}

fn append_user_hint_to_block(block: &mut CkWireBlock, hint: &str) -> bool {
    let ck_wire::CkKind::Text { text } = &mut block.kind else {
        return false;
    };
    if text.ends_with(hint) {
        return false;
    }
    text.push_str(hint);
    true
}

fn append_channel1_to_block(block: &mut CkWireBlock, reminder: &str) -> bool {
    match &mut block.kind {
        ck_wire::CkKind::ToolResult { output, .. } => append_channel1_to_output(output, reminder),
        _ => false,
    }
}

fn append_channel1_to_output(output: &mut ck_wire::CkToolOutput, reminder: &str) -> bool {
    match &mut output.kind {
        ck_wire::CkOutputKind::Text { text } | ck_wire::CkOutputKind::ErrorText { text } => {
            if !text.ends_with(reminder) {
                text.push_str(reminder);
                return true;
            }
        }
        ck_wire::CkOutputKind::Content { blocks } => {
            for block in blocks {
                if let ck_wire::ResultBlockKind::Text { text } = &mut block.kind {
                    if !text.ends_with(reminder) {
                        text.push_str(reminder);
                        return true;
                    }
                    return false;
                }
            }
        }
        ck_wire::CkOutputKind::Json { .. }
        | ck_wire::CkOutputKind::ErrorJson { .. }
        | ck_wire::CkOutputKind::ExecutionDenied { .. } => {}
    }
    false
}

fn tag_prefix(tag_number: i64) -> String {
    format!("§{tag_number}§ ")
}

fn prepend_tag(tag_number: i64, value: &str) -> String {
    let tagged = format!("{}{value}", tag_prefix(tag_number));
    debug_assert_eq!(strip_tag_prefix(&tagged, tag_number), value);
    tagged
}

/// Remove exactly the prefix added for this block's registered number. This is the
/// inverse of [`prepend_tag`]; it never trims source whitespace or interprets another
/// block's tag-like user content.
fn strip_tag_prefix(value: &str, tag_number: i64) -> &str {
    value.strip_prefix(&tag_prefix(tag_number)).unwrap_or(value)
}

/// Strip runs of well-formed `§N§` tokens at the start of any non-code line.
///
/// The observed imitation class is line-leading, so this conservative boundary avoids
/// rewriting genuine references such as `the tag §12§ was dropped`. Code fences and
/// inline-code lines stay verbatim, and a token must be followed by whitespace or ASCII
/// punctuation so malformed text is never partially consumed.
fn strip_leading_tag_imitations(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_fenced_code = false;
    let mut inline_code_delimiter = None;
    for line in value.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let fence = body.trim_start().starts_with("```");
        if in_fenced_code || fence {
            output.push_str(line);
            if fence {
                in_fenced_code = !in_fenced_code;
                inline_code_delimiter = None;
            }
            continue;
        }
        if inline_code_delimiter.is_some() {
            output.push_str(line);
            update_inline_code_delimiter(body, &mut inline_code_delimiter);
            continue;
        }

        let leading_whitespace = body.len() - body.trim_start_matches(char::is_whitespace).len();
        let mut rest = &body[leading_whitespace..];
        let mut stripped = false;
        while let Some(after_close) = well_formed_tag_suffix(rest) {
            stripped = true;
            rest = after_close.trim_start_matches(char::is_whitespace);
        }
        if stripped {
            output.push_str(rest);
            if line.ends_with('\n') && !rest.is_empty() {
                output.push('\n');
            }
        } else {
            output.push_str(line);
        }
        update_inline_code_delimiter(body, &mut inline_code_delimiter);
    }
    output
}

fn update_inline_code_delimiter(line: &str, delimiter: &mut Option<usize>) {
    let mut offset = 0usize;
    while offset < line.len() {
        let rest = &line[offset..];
        let Some(backtick_offset) = rest.find('`') else {
            break;
        };
        offset += backtick_offset;
        let run = line[offset..]
            .chars()
            .take_while(|character| *character == '`')
            .count();
        match delimiter {
            Some(expected) if *expected == run => *delimiter = None,
            None => *delimiter = Some(run),
            _ => {}
        }
        offset += run;
    }
}

fn well_formed_tag_suffix(value: &str) -> Option<&str> {
    let after_open = value.strip_prefix('\u{a7}')?;
    let digits = after_open.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let after_close = after_open[digits..].strip_prefix('\u{a7}')?;
    if after_close
        .chars()
        .next()
        .is_some_and(|next| !next.is_whitespace() && !next.is_ascii_punctuation())
    {
        return None;
    }
    Some(after_close)
}

fn is_entire_system_reminder_wrapped(text: &str) -> bool {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut depth = 0usize;
    let mut saw_wrapper = false;
    let mut offset = 0usize;
    while offset < text.len() {
        let rest = &text[offset..];
        if rest.starts_with(OPEN) {
            depth += 1;
            saw_wrapper = true;
            offset += OPEN.len();
        } else if rest.starts_with(CLOSE) {
            if depth == 0 {
                return false;
            }
            depth -= 1;
            offset += CLOSE.len();
        } else {
            let ch = rest.chars().next().expect("non-empty reminder remainder");
            if depth == 0 && !ch.is_whitespace() {
                return false;
            }
            offset += ch.len_utf8();
        }
    }
    saw_wrapper && depth == 0
}

fn is_system_reminder_transport_message(message: &CkIngressMessage) -> bool {
    if message.ck.role != "user" || message.ck.meta.synthetic || message.ck.content.is_empty() {
        return false;
    }
    // CK intentionally has no transport-origin field for this Claude Code shape. The
    // decoder preserves the reminder as an ordinary user text block, so the narrowest
    // safe discriminator is a message made entirely of balanced reminder wrappers.
    let mut saw_text = false;
    for block in &message.ck.content {
        let ck_wire::CkKind::Text { text } = &block.kind else {
            return false;
        };
        saw_text = true;
        if !is_entire_system_reminder_wrapped(text.trim()) {
            return false;
        }
    }
    saw_text
}

fn is_authored_user_message(message: &CkIngressMessage) -> bool {
    message.ck.role == "user"
        && !message.ck.meta.synthetic
        && message
            .ck
            .content
            .iter()
            .any(|block| matches!(&block.kind, ck_wire::CkKind::Text { .. }))
        && !is_system_reminder_transport_message(message)
}

fn eligible_authored_user_tail(req: &TransformRequest) -> Option<&CkIngressMessage> {
    // Tool results are transport messages even when a provider carries them with role=user.
    // Skip those carriers like synthetic and system messages, while an assistant tail still
    // closes the authored-user eligibility window.
    let tail = req.messages.iter().rev().find(|message| {
        !message.ck.meta.synthetic
            && message.ck.role != "system"
            && message.ck.role != "tool"
            && (message.ck.role != "user" || is_authored_user_message(message))
    })?;
    is_authored_user_message(tail).then_some(tail)
}

fn compute_active_overlay_decisions(
    input: OverlayComputation<'_, '_>,
) -> Result<PendingOverlayDecisions, TransformError> {
    let OverlayComputation {
        store,
        req,
        ctx,
        projection,
        core,
        tag_rows,
        temporal_rows,
        user_hint_rows,
        overlay_frontier: frontier,
        mutation_exempt_mid,
    } = input;
    let existing_tag_ids = tag_rows
        .iter()
        .map(|row| row.block_id.as_str())
        .collect::<HashSet<_>>();
    let tag_mints = tag_mint_inputs(projection, core, mutation_exempt_mid)
        .into_iter()
        .filter(|input| !existing_tag_ids.contains(input.block_id.as_str()))
        .collect::<Vec<_>>();
    let next_tag = tag_rows.iter().map(|row| row.tag_number).max().unwrap_or(0);
    for (offset, input) in tag_mints.iter().enumerate() {
        tag_rows.push(McTagRow {
            tag_number: next_tag + offset as i64 + 1,
            block_id: input.block_id.clone(),
            kind: input.kind.clone(),
            token_count: input.token_count.max(0),
            created_at_ms: ctx.now_ms,
            source_bytes: input.source_bytes.clone(),
        });
    }

    let mint_by_block = tag_rows
        .iter()
        .map(|row| (row.block_id.as_str(), row.created_at_ms))
        .collect::<HashMap<_, _>>();
    let mut decided_temporal = temporal_rows
        .iter()
        .map(|row| row.block_id.clone())
        .collect::<HashSet<_>>();
    let authored_tail = eligible_authored_user_tail(req);
    let mut previous_new_user_mint = None;
    let mut temporal_marks = Vec::new();
    for message in req.messages.iter().filter(|message| {
        !message.ck.meta.synthetic
            && message.ck.role != "system"
            && message.ck.role != "tool"
            && (message.ck.role != "user" || is_authored_user_message(message))
            && mutation_exempt_mid != Some(message.mid.as_str())
    }) {
        let is_new = frontier.is_none_or(|frontier| message.ordinal > frontier);
        if !is_authored_user_message(message) || !is_new {
            previous_new_user_mint = None;
            continue;
        }
        let Some((block_id, current_mint)) = projection
            .blocks
            .iter()
            .filter(|block| block.mid == message.mid)
            .find_map(|block| {
                matches!(&block.wire.kind, ck_wire::CkKind::Text { .. })
                    .then(|| {
                        mint_by_block
                            .get(block.id.as_str())
                            .copied()
                            .map(|created_at| (block.id.clone(), created_at))
                    })
                    .flatten()
            })
        else {
            previous_new_user_mint = None;
            continue;
        };
        if decided_temporal.contains(block_id.as_str()) {
            previous_new_user_mint = Some(current_mint);
            continue;
        }

        let marker_text = if authored_tail.is_some_and(|tail| tail.mid == message.mid) {
            // The gap pairs the proxy's INGRESS observation with its completion
            // observation. Module-side now_ms would add queue plus blocking-arm
            // latency to every gap, so a missing or invalid ingress time freezes
            // the no-marker decision rather than guessing from a later clock.
            let observed_now = u64::try_from(ctx.now_ms).unwrap_or(0);
            req.request_observed_at_ms
                .filter(|observed| *observed > 0 && *observed <= observed_now)
                .and_then(|observed| {
                    req.prev_response_completed_at_ms
                        .filter(|completed| *completed > 0 && *completed < observed)
                        .map(|completed| (observed, completed))
                })
                .and_then(|(observed, completed)| {
                    i64::try_from(observed - completed)
                        .ok()
                        .and_then(temporal_gap_prefix)
                })
                .unwrap_or_default()
        } else {
            // Multiple newly observed consecutive user messages have no provider response
            // boundary. Mint times are retained only for that rare between-users fallback.
            previous_new_user_mint
                .and_then(|previous| current_mint.checked_sub(previous))
                .and_then(temporal_gap_prefix)
                .unwrap_or_default()
        };
        temporal_marks.push(TemporalMarkInput {
            ordinal: message.ordinal,
            block_id: block_id.clone(),
            marker_text: marker_text.clone(),
        });
        temporal_rows.push(TemporalMarkRow {
            block_id: block_id.clone(),
            marker_text,
            created_at: ctx.now_ms,
        });
        decided_temporal.insert(block_id);
        previous_new_user_mint = Some(current_mint);
    }

    // Do not advance the frontier past a user whose temporal decision could not be
    // evaluated. A frozen reduction or another mint-ineligible shape must remain eligible
    // for a later pass instead of silently making its marker impossible to mint.
    let mut decided_frontier = frontier;
    for message in req
        .messages
        .iter()
        .filter(|message| is_authored_user_message(message))
    {
        if frontier.is_some_and(|current| message.ordinal <= current) {
            continue;
        }
        let Some(block_id) = projection.blocks.iter().find_map(|block| {
            (block.mid == message.mid && matches!(&block.wire.kind, ck_wire::CkKind::Text { .. }))
                .then_some(block.id.as_str())
        }) else {
            break;
        };
        if !decided_temporal.contains(block_id) {
            break;
        }
        decided_frontier = Some(message.ordinal);
    }
    let max_seen_ordinal =
        decided_frontier.filter(|ordinal| frontier.is_none_or(|current| *ordinal > current));

    let user_hint = authored_tail
        .filter(|message| frontier.is_none_or(|frontier| message.ordinal > frontier))
        .filter(|message| mutation_exempt_mid != Some(message.mid.as_str()))
        .and_then(|message| {
            let block = projection.blocks.iter().find(|block| {
                block.mid == message.mid
                    && block.role == "user"
                    && matches!(block.wire.kind, ck_wire::CkKind::Text { .. })
            })?;
            if user_hint_rows.iter().any(|row| row.block_id == block.id) {
                return None;
            }
            Some((message, block.id.clone()))
        })
        .map(|(message, block_id)| {
            let query = user_hint_query(message);
            let hint_text = if query.is_empty() {
                String::new()
            } else {
                let results = run_user_hint_lexical_search(
                    store,
                    ctx.project_path,
                    &req.session_id,
                    &query,
                    ctx.memory_enabled,
                )?;
                render_user_hint(&results).unwrap_or_default()
            };
            Ok::<_, TransformError>(UserHintDecisionInput {
                ordinal: message.ordinal,
                block_id,
                hint_text,
            })
        })
        .transpose()?;
    if let Some(hint) = &user_hint {
        user_hint_rows.push(UserHintRow {
            block_id: hint.block_id.clone(),
            hint_text: hint.hint_text.clone(),
            created_at: ctx.now_ms,
        });
    }

    Ok(PendingOverlayDecisions {
        max_seen_ordinal,
        tag_mints,
        temporal_marks,
        user_hint,
        channel1_append: None,
    })
}

fn lexical_tokens(text: &str) -> BTreeSet<String> {
    const STOPWORDS: &[&str] = &[
        "and", "are", "but", "for", "from", "have", "into", "not", "that", "the", "this", "use",
        "was", "with", "you", "your",
    ];
    // Unicode normalization is intentionally out of scope. Case folding and provider text
    // token boundaries are sufficient for this conservative, non-semantic hint gate.
    text.to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.chars().count() >= 3 && !STOPWORDS.contains(token))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(USER_HINT_TOKEN_CAP)
        .collect()
}

fn run_user_hint_lexical_search(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    include_memories: bool,
) -> Result<Vec<crate::memory_tool::MemorySearchResult>, TransformError> {
    #[cfg(test)]
    USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(count.get() + 1));

    struct Candidate {
        result: crate::memory_tool::MemorySearchResult,
        tokens: BTreeSet<String>,
        recency: i64,
    }

    let query_tokens = lexical_tokens(query);
    if query_tokens.len() < USER_HINT_MIN_MATCHED_TOKENS {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    if include_memories {
        for memory in
            store.load_visible_memory_candidates(project_path, USER_HINT_CANDIDATE_LIMIT)?
        {
            candidates.push(Candidate {
                tokens: lexical_tokens(&memory.content),
                recency: memory.updated_at,
                result: crate::memory_tool::MemorySearchResult {
                    source_kind: crate::memory_tool::MemorySearchSourceKind::Memory,
                    id: memory.id,
                    snippet: memory.content,
                    category: Some(memory.category),
                    sequence: None,
                    title: None,
                    note_status: None,
                    surface_condition: None,
                },
            });
        }
    }
    for compartment in store.load_compartment_candidates(session_id, USER_HINT_CANDIDATE_LIMIT)? {
        let body = [
            Some(compartment.title.as_str()),
            Some(compartment.content.as_str()),
            compartment.p1.as_deref(),
            compartment.p2.as_deref(),
            compartment.p3.as_deref(),
            compartment.p4.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        candidates.push(Candidate {
            tokens: lexical_tokens(&body),
            recency: compartment.created_at,
            result: crate::memory_tool::MemorySearchResult {
                source_kind: crate::memory_tool::MemorySearchSourceKind::CompartmentBody,
                id: compartment.sequence,
                snippet: body,
                category: None,
                sequence: Some(compartment.sequence),
                title: Some(compartment.title),
                note_status: None,
                surface_condition: None,
            },
        });
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut document_frequency = HashMap::new();
    for token in &query_tokens {
        let count = candidates
            .iter()
            .filter(|candidate| candidate.tokens.contains(token))
            .count();
        document_frequency.insert(token, count);
    }
    let pool_count = candidates.len();
    let pool_size = pool_count as f64;
    let total_query_weight = query_tokens
        .iter()
        .map(|token| {
            let frequency = *document_frequency.get(token).unwrap_or(&0) as f64;
            ((pool_size + 1.0) / (frequency + 1.0)).ln() + 1.0
        })
        .sum::<f64>();
    let mut scored = candidates
        .into_iter()
        .filter_map(|candidate| {
            let matched = query_tokens
                .iter()
                .filter(|token| candidate.tokens.contains(*token))
                .collect::<Vec<_>>();
            if matched.len() < USER_HINT_MIN_MATCHED_TOKENS
                || !matched.iter().any(|token| {
                    document_frequency
                        .get(*token)
                        .is_some_and(|frequency| frequency.saturating_mul(2) < pool_count)
                })
            {
                return None;
            }
            let score = matched
                .iter()
                .map(|token| {
                    let frequency = *document_frequency.get(*token).unwrap_or(&0) as f64;
                    ((pool_size + 1.0) / (frequency + 1.0)).ln() + 1.0
                })
                .sum::<f64>();
            let normalized = score / total_query_weight.max(f64::EPSILON);
            (normalized >= USER_HINT_NORMALIZED_SCORE_FLOOR).then_some((
                normalized,
                matched.len(),
                candidate.recency,
                candidate.result,
            ))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.3.id.cmp(&right.3.id))
    });
    Ok(scored
        .into_iter()
        .take(USER_HINT_RESULT_LIMIT)
        .map(|(_, _, _, result)| result)
        .collect())
}

fn user_hint_query(message: &CkIngressMessage) -> String {
    let raw = message
        .ck
        .content
        .iter()
        .filter_map(|block| match &block.kind {
            ck_wire::CkKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let without_reminders = strip_system_reminder_wrappers(&raw);
    let without_tags = strip_mc_tag_notation(&without_reminders);
    let normalized = without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = normalized.chars();
    let mut capped = chars
        .by_ref()
        .take(USER_HINT_QUERY_CHAR_CAP)
        .collect::<String>();
    if chars.next().is_some_and(|next| !next.is_whitespace())
        && capped
            .chars()
            .last()
            .is_some_and(|last| !last.is_whitespace())
    {
        if let Some(boundary) = capped.rfind(char::is_whitespace) {
            capped.truncate(boundary);
        } else {
            capped.clear();
        }
    }
    capped
}

fn strip_system_reminder_wrappers(text: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut output = String::new();
    let mut depth = 0usize;
    let mut offset = 0usize;
    while offset < text.len() {
        let rest = &text[offset..];
        if rest.starts_with(OPEN) {
            depth += 1;
            offset += OPEN.len();
        } else if rest.starts_with(CLOSE) {
            depth = depth.saturating_sub(1);
            offset += CLOSE.len();
        } else {
            let ch = rest.chars().next().expect("non-empty remainder");
            if depth == 0 {
                output.push(ch);
            }
            offset += ch.len_utf8();
        }
    }
    output
}

fn strip_mc_tag_notation(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after_open) = rest.strip_prefix('\u{a7}') {
            let digits = after_open.chars().take_while(char::is_ascii_digit).count();
            if digits > 0 {
                if let Some(after_close) = after_open[digits..].strip_prefix('\u{a7}') {
                    rest = after_close.trim_start_matches(char::is_whitespace);
                    continue;
                }
            }
        }
        let ch = rest.chars().next().expect("non-empty remainder");
        output.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    output
}

fn render_user_hint(results: &[crate::memory_tool::MemorySearchResult]) -> Option<String> {
    if results.is_empty() {
        return None;
    }
    let lines = results
        .iter()
        .take(USER_HINT_RESULT_LIMIT)
        .map(|result| {
            format!(
                "- {}",
                one_line_fragment(&result.snippet, USER_HINT_FRAGMENT_CHAR_CAP)
            )
        })
        .filter(|line| line.len() > 2)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let hint = format!(
        "\n\n<ctx-search-hint>\nYour memory may contain related fragments:\n{}\nIf relevant, run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>",
        lines.join("\n")
    );
    debug_assert!(hint.chars().count() <= USER_HINT_TOTAL_CHAR_CAP);
    Some(hint)
}

fn one_line_fragment(text: &str, limit: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= limit {
        return normalized;
    }
    let mut truncated = normalized
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>()
        .trim_end()
        .to_string();
    truncated.push('…');
    truncated
}

fn maybe_append_channel1_nudge(
    input: Channel1NudgeInputs<'_, '_>,
    meta: &mut ModuleMeta,
) -> Option<Channel1AppendRow> {
    let active_tags = active_tags_for_nudge(
        input.core,
        meta,
        input.projection,
        input.tag_rows,
        input.mutation_exempt_mid,
    );
    let live_tail_tokens = active_tags
        .iter()
        .map(|tag| tag.token_count.max(0))
        .sum::<i64>();
    let working_window_tokens = (input.context_limit_tokens
        * input.ctx.execute_threshold_percentage.clamp(1.0, 100.0)
        / 100.0)
        .round()
        .max(0.0) as i64;
    let reclaimable_tokens =
        reclaimable_older_than_working_window(&active_tags, working_window_tokens);
    let decision = decide_channel1(
        reclaimable_tokens,
        live_tail_tokens,
        working_window_tokens,
        input.context_limit_tokens,
        input.input_tokens,
        input.ctx.execute_threshold_percentage,
        meta,
    );
    meta.channel1_last_nudge_undropped = decision.next_last_nudge;
    meta.channel1_last_nudge_level = decision.next_last_level;
    let was_suppressed = meta.channel1_reduce_suppressed;
    meta.channel1_reduce_suppressed = false;
    if was_suppressed || !decision.fire {
        return None;
    }
    let existing_blocks = input
        .channel1_appends
        .iter()
        .map(|row| row.block_id.as_str())
        .collect::<HashSet<_>>();
    let block_id = newest_tool_result_for_channel1(
        input.core,
        meta,
        input.projection,
        &existing_blocks,
        input.mutation_exempt_mid,
    )?;
    let hint = oldest_reclaimable_hint(&active_tags, working_window_tokens);
    let reminder = build_channel1_reminder(decision.level, decision.reclaimable_tokens, &hint);
    Some(Channel1AppendRow {
        block_id,
        reminder_text: reminder,
        fired_at_ms: input.ctx.now_ms,
    })
}

fn active_tags_for_nudge(
    core: &CoreState,
    meta: &ModuleMeta,
    projection: &FlatProjection,
    tag_rows: &[McTagRow],
    mutation_exempt_mid: Option<&str>,
) -> Vec<ActiveTagForNudge> {
    let tag_by_block = tag_rows
        .iter()
        .map(|row| (row.block_id.as_str(), row))
        .collect::<BTreeMap<_, _>>();
    let mut out = Vec::new();
    for block in projection.blocks.iter().filter(|block| {
        taggable_kind(block).is_some()
            && is_tail(block.ordinal, meta.coverage_ordinal)
            && frozen_red_payload(core, block.id()).is_none()
            && mutation_exempt_mid != Some(block.mid.as_str())
    }) {
        if let Some(row) = tag_by_block.get(block.id.as_str()) {
            out.push(ActiveTagForNudge {
                tag_number: row.tag_number,
                kind: row.kind.clone(),
                token_count: row.token_count.max(0),
            });
        }
    }
    out.sort_by_key(|tag| tag.tag_number);
    out
}

/// Reuse the durable CC tag accounting when present, and derive the same accounting basis
/// from live CK text for profiles that historically did not mint overlay tags. The latter
/// keeps OpenCode host directives useful without enabling CC-only prompt overlays.
fn active_tags_for_channel2(
    core: &CoreState,
    meta: &ModuleMeta,
    projection: &FlatProjection,
    tag_rows: &[McTagRow],
    mutation_exempt_mid: Option<&str>,
) -> Vec<ActiveTagForNudge> {
    let stored = active_tags_for_nudge(core, meta, projection, tag_rows, mutation_exempt_mid);
    if !stored.is_empty() {
        return stored;
    }
    let mut next_tag = 1i64;
    let mut derived = Vec::new();
    for block in projection.blocks.iter().filter(|block| {
        !block.synthetic
            && is_tail(block.ordinal, meta.coverage_ordinal)
            && frozen_red_payload(core, block.id()).is_none()
            && mutation_exempt_mid != Some(block.mid.as_str())
    }) {
        let Some((kind, source)) = taggable_source(block) else {
            continue;
        };
        derived.push(ActiveTagForNudge {
            tag_number: next_tag,
            kind: kind.as_store_kind().to_string(),
            token_count: mc_tokenizer::estimate_tokens(source) as i64,
        });
        next_tag = next_tag.saturating_add(1);
    }
    derived
}

struct Channel2DirectiveInput<'a> {
    profile: Option<SerializerProfile>,
    core: &'a CoreState,
    meta: &'a ModuleMeta,
    projection: &'a FlatProjection,
    tag_rows: &'a [McTagRow],
    mutation_exempt_mid: Option<&'a str>,
    context_limit_tokens: f64,
    input_tokens: f64,
    execute_threshold_percentage: f64,
}

fn channel2_directive(input: Channel2DirectiveInput<'_>) -> Option<HostDirectives> {
    // OpenCode is the host-delivery leg. CC and owned serializers retain their historic
    // response shape; their host integrations own any channel-2 surface separately.
    if input.profile != Some(SerializerProfile::OpencodeAiSdk)
        || input.context_limit_tokens <= 0.0
        || input.execute_threshold_percentage <= 0.0
    {
        return None;
    }
    let working_window_tokens =
        (input.context_limit_tokens * input.execute_threshold_percentage.clamp(1.0, 100.0) / 100.0)
            .round()
            .max(0.0) as i64;
    let active_tags = active_tags_for_channel2(
        input.core,
        input.meta,
        input.projection,
        input.tag_rows,
        input.mutation_exempt_mid,
    );
    let (reclaimable_tokens, live_tail_tokens) = channel2_token_aggregate(&active_tags);
    let usable_tokens =
        (working_window_tokens as f64 - input.input_tokens + live_tail_tokens as f64).max(0.0);
    let due = reclaimable_tokens >= CHANNEL2_MIN_RECLAIMABLE
        && (usable_tokens == 0.0
            || reclaimable_tokens as f64 >= usable_tokens * CHANNEL2_USABLE_FRACTION);
    if !due {
        return None;
    }
    let hint = oldest_channel2_hint(&active_tags);
    Some(HostDirectives {
        channel2_nudge: Some(Channel2NudgeDirective {
            text: build_channel2_reminder(reclaimable_tokens, &hint),
        }),
    })
}

fn channel2_token_aggregate(active_tags: &[ActiveTagForNudge]) -> (i64, i64) {
    let protected_cutoff =
        (active_tags.len() > 20).then(|| active_tags[active_tags.len() - 20].tag_number);
    let reclaimable = active_tags
        .iter()
        .filter(|tag| tag.kind == "tool_result")
        .filter(|tag| protected_cutoff.is_none_or(|cutoff| tag.tag_number < cutoff))
        .map(|tag| tag.token_count.max(0))
        .sum();
    let live_tail = active_tags
        .iter()
        .filter(|tag| tag.kind != "tool_result")
        .map(|tag| tag.token_count.max(0))
        .sum();
    (reclaimable, live_tail)
}

fn oldest_channel2_hint(active_tags: &[ActiveTagForNudge]) -> Vec<(i64, String)> {
    let protected_cutoff =
        (active_tags.len() > 20).then(|| active_tags[active_tags.len() - 20].tag_number);
    active_tags
        .iter()
        .filter(|tag| tag.kind == "tool_result")
        .filter(|tag| protected_cutoff.is_none_or(|cutoff| tag.tag_number < cutoff))
        .filter(|tag| tag.token_count >= 100)
        .take(4)
        .map(|tag| (tag.tag_number, "tool".to_string()))
        .collect()
}

fn build_channel2_reminder(reclaimable_tokens: i64, hint: &[(i64, String)]) -> String {
    let amount = approx_thousands(reclaimable_tokens);
    let hint_text = format_reclaimable_hint(hint);
    format!(
        "<system-reminder>\nRoutine context housekeeping is near: a large span of this session will be comparted soon, and ~{amount} tokens of tool output remain unreduced. Drop spent outputs with ctx_reduce first so the archived span is the part that matters.{hint_text}\n</system-reminder>"
    )
}

fn reclaimable_older_than_working_window(
    active_tags: &[ActiveTagForNudge],
    working_window_tokens: i64,
) -> i64 {
    let mut protected = HashSet::new();
    let mut sum = 0i64;
    for tag in active_tags.iter().rev() {
        if sum >= working_window_tokens.max(0) {
            break;
        }
        protected.insert(tag.tag_number);
        sum += tag.token_count.max(0);
    }
    active_tags
        .iter()
        .filter(|tag| tag.kind != "tool_call" && !protected.contains(&tag.tag_number))
        .map(|tag| tag.token_count.max(0))
        .sum()
}

fn decide_channel1(
    reclaimable_tokens: i64,
    live_tail_tokens: i64,
    working_window_tokens: i64,
    context_limit_tokens: f64,
    input_tokens: f64,
    execute_threshold_percentage: f64,
    meta: &ModuleMeta,
) -> Channel1Decision {
    let reset_cycle = meta.channel1_reduce_suppressed
        || reclaimable_tokens < meta.channel1_last_nudge_undropped.max(0);
    let last_nudge = if reset_cycle {
        0
    } else {
        meta.channel1_last_nudge_undropped.max(0)
    };
    let last_level = if reset_cycle {
        None
    } else {
        Channel1Level::parse(&meta.channel1_last_nudge_level)
    };
    let last_level_string = |level: Option<Channel1Level>| {
        level
            .map(|level| level.as_str().to_string())
            .unwrap_or_default()
    };
    let quiet = |next_last_nudge: i64, next_last_level: String| Channel1Decision {
        fire: false,
        level: Channel1Level::Gentle,
        reclaimable_tokens,
        next_last_nudge,
        next_last_level,
    };
    if meta.channel1_reduce_suppressed {
        return quiet(0, String::new());
    }
    if reclaimable_tokens < CHANNEL1_FLOOR_TOKENS {
        return quiet(last_nudge, last_level_string(last_level));
    }
    let pressure = if context_limit_tokens > 0.0 && execute_threshold_percentage > 0.0 {
        ((input_tokens / context_limit_tokens) * 100.0 / execute_threshold_percentage)
            .clamp(0.0, 1.0)
    } else {
        0.0
    };
    if pressure < CHANNEL1_PRESSURE_FLOOR {
        return quiet(last_nudge, last_level_string(last_level));
    }
    let execute_threshold_tokens =
        context_limit_tokens * execute_threshold_percentage.clamp(1.0, 100.0) / 100.0;
    let usable_tokens =
        (execute_threshold_tokens - input_tokens + live_tail_tokens as f64).max(0.0);
    if usable_tokens > 0.0 && (reclaimable_tokens as f64) < usable_tokens * CHANNEL1_USABLE_FRACTION
    {
        return quiet(last_nudge, last_level_string(last_level));
    }
    let severity = if working_window_tokens > 0 {
        (reclaimable_tokens as f64 / working_window_tokens as f64).min(1.0)
    } else {
        1.0
    };
    let level = if severity >= 0.65 {
        Channel1Level::Urgent
    } else if severity >= 0.4 {
        Channel1Level::Firm
    } else {
        Channel1Level::Gentle
    };
    if let Some(last) = last_level {
        if level.rank() <= last.rank() {
            return quiet(last_nudge, last.as_str().to_string());
        }
    } else if reclaimable_tokens < last_nudge + channel1_refire_tokens(working_window_tokens) {
        return quiet(last_nudge, String::new());
    }
    Channel1Decision {
        fire: true,
        level,
        reclaimable_tokens,
        next_last_nudge: reclaimable_tokens,
        next_last_level: level.as_str().to_string(),
    }
}

fn channel1_refire_tokens(working_window_tokens: i64) -> i64 {
    let scaled = (0.05 * working_window_tokens.max(0) as f64).round() as i64;
    CHANNEL1_REFIRE_FLOOR_TOKENS.max(scaled)
}

fn newest_tool_result_for_channel1(
    core: &CoreState,
    meta: &ModuleMeta,
    projection: &FlatProjection,
    existing_blocks: &HashSet<&str>,
    mutation_exempt_mid: Option<&str>,
) -> Option<String> {
    projection
        .blocks
        .iter()
        .filter(|block| {
            block.kind_tag == "tool_result"
                && taggable_kind(block).is_some()
                && is_tail(block.ordinal, meta.coverage_ordinal)
                && frozen_red_payload(core, block.id()).is_none()
                && !existing_blocks.contains(block.id.as_str())
                && mutation_exempt_mid != Some(block.mid.as_str())
                && tool_result_can_carry_channel1(&block.wire)
        })
        .max_by_key(|block| (block.ordinal, block.block_index))
        .map(|block| block.id.clone())
}

fn tool_result_can_carry_channel1(block: &CkWireBlock) -> bool {
    match &block.kind {
        ck_wire::CkKind::ToolResult { output, .. } => match &output.kind {
            ck_wire::CkOutputKind::Text { .. } | ck_wire::CkOutputKind::ErrorText { .. } => true,
            ck_wire::CkOutputKind::Content { blocks } => blocks
                .iter()
                .any(|block| matches!(block.kind, ck_wire::ResultBlockKind::Text { .. })),
            ck_wire::CkOutputKind::Json { .. }
            | ck_wire::CkOutputKind::ErrorJson { .. }
            | ck_wire::CkOutputKind::ExecutionDenied { .. } => false,
        },
        _ => false,
    }
}

fn oldest_reclaimable_hint(
    active_tags: &[ActiveTagForNudge],
    working_window_tokens: i64,
) -> Vec<(i64, String)> {
    let mut protected = HashSet::new();
    let mut sum = 0i64;
    for tag in active_tags.iter().rev() {
        if sum >= working_window_tokens.max(0) {
            break;
        }
        protected.insert(tag.tag_number);
        sum += tag.token_count.max(0);
    }
    active_tags
        .iter()
        .filter(|tag| tag.kind == "tool_result" && !protected.contains(&tag.tag_number))
        .take(4)
        .map(|tag| (tag.tag_number, "tool".to_string()))
        .collect()
}

fn build_channel1_reminder(
    level: Channel1Level,
    reclaimable_tokens: i64,
    hint: &[(i64, String)],
) -> String {
    let amount = approx_thousands(reclaimable_tokens);
    let hint_text = format_reclaimable_hint(hint);
    let body = match level {
        Channel1Level::Gentle => format!(
            "You have ~{amount} tokens of tool output you have not reduced. When you are done with earlier outputs, dropping them with ctx_reduce keeps context lean."
        ),
        Channel1Level::Firm => format!(
            "~{amount} tokens of unreduced tool output has built up. At your next natural stopping point, consider dropping what you have already processed with ctx_reduce."
        ),
        Channel1Level::Urgent => format!(
            "~{amount} tokens of unreduced tool output remain, and a large span of this session will be comparted before long. Consider dropping spent outputs with ctx_reduce so the archived span is the part that matters."
        ),
    };
    format!("\n\n<system-reminder>\n{body}{hint_text}\n</system-reminder>")
}

fn approx_thousands(tokens: i64) -> String {
    format!("{}k", (tokens.max(0) as f64 / 1000.0).round() as i64)
}

fn format_reclaimable_hint(hint: &[(i64, String)]) -> String {
    if hint.is_empty() {
        return String::new();
    }
    let rendered = hint
        .iter()
        .map(|(tag, name)| format!("§{tag}§ {name}"))
        .collect::<Vec<_>>()
        .join(" · ");
    format!("\noldest reclaimable: {rendered}.")
}

// --- output splice: [m0, m1] ++ tail(by coverage_ordinal) ---

fn build_output(
    core: &CoreState,
    meta: &ModuleMeta,
    projection: &FlatProjection,
    req: &TransformRequest,
    tag_overlay: Option<&TagOverlayState>,
    synthetic_todo_enabled: bool,
    mutation_exempt_mid: Option<&str>,
) -> Result<Vec<CkWireMessage>, TransformError> {
    let mut out = Vec::with_capacity(4 + req.messages.len());
    if let Some(u) = core.frozen_units.iter().find(|u| u.key == "m0") {
        out.push(CkWireMessage::synthetic_user_text(u.frozen_payload.clone()));
    }
    if let Some(u) = core.frozen_units.iter().find(|u| u.key == "m1") {
        out.push(CkWireMessage::synthetic_user_text(u.frozen_payload.clone()));
    }

    let blocks_by_mid = projection_blocks_by_mid(projection);

    // A synthetic-todo pair with no message anchor (anchor_mid == None) was composed when
    // the tail was empty (every live message folded under coverage). It is frozen
    // immediately AFTER the m0/m1 head blocks pushed above and BEFORE the tail loop below
    // — emitting it HERE, not after that loop, is what keeps its position byte-stable:
    // later tail growth appends after it, so the [m0, m1, pair] prefix stays identical on
    // every subsequent defer pass. Emitting it after the loop would let the pair float to
    // the end of a growing tail, changing the bytes of a cached prefix on every turn — the
    // exact failure the position-freeze design prevents. (A None anchor also never
    // relocates on a bust: reanchor_kept_synthetic_todo_if_folded early-returns on None, so
    // the pair stays right after m0/m1 for its whole life until a Replace or Clear.)
    if synthetic_todo_enabled
        && meta
            .synthetic_todo
            .as_ref()
            .is_some_and(|pair| pair.anchor_mid.is_none())
    {
        push_synthetic_todo_pair(&mut out, meta);
    }

    // Covered system messages are stored in m0 during the HARD render for the current
    // coverage. The claude-code-anthropic profile epoch makes old sessions do that HARD
    // before this code stops emitting those messages separately, preventing old m0 bytes
    // that lack the block from losing the prompt content.

    let serializer_profile = SerializerProfile::parse(&req.serializer_profile);
    let mut inserted_synthetic_todo = false;
    // Tail messages are strictly after the coverage watermark. Full-array profiles also
    // keep pinned leading system prompts that sit before the first summarized ordinal.
    // The outer loop is the inbound message list, not the reduced-block map, so a live
    // tail message with zero content blocks still passes through instead of disappearing.
    for msg in req.messages.iter().filter(|m| !m.ck.meta.synthetic) {
        let keep_leading_system = serializer_profile
            != Some(SerializerProfile::ClaudeCodeAnthropic)
            && is_uncovered_leading_system(msg, meta);
        if !is_tail(msg.ordinal, meta.coverage_ordinal) && !keep_leading_system {
            continue;
        }
        let mutation_exempt = mutation_exempt_mid == Some(msg.mid.as_str());
        let rendered = if let Some(blocks) = blocks_by_mid.get(msg.mid.as_str()) {
            let reduced: BTreeMap<usize, &str> = if mutation_exempt {
                BTreeMap::new()
            } else {
                blocks
                    .iter()
                    // Render-time heal: if an immutable unit targets a reasoning block,
                    // ignore it and serve the block's original signed bytes. Applying
                    // the unit would produce an unsigned reasoning block that Anthropic
                    // rejects, which would permanently block the session. The unit
                    // remains frozen but becomes inert, and this behavior is deterministic.
                    .filter(|block| !is_reasoning_block(&block.wire))
                    .filter_map(|block| {
                        frozen_red_payload(core, block.id()).map(|p| (block.block_index, p))
                    })
                    .collect()
            };
            let mut rebuilt = msg.ck.clone();
            if !reduced.is_empty() {
                rebuilt.mark_modified();
                for block in blocks {
                    if let Some(payload) = reduced.get(&block.block_index) {
                        // Canonical frozen bytes never carry a tag number. The egress clone
                        // may add the target's live number, while legacy numbered payloads
                        // remain byte-identical because only exact `[dropped]` is overlaid.
                        let display_payload = (*payload == "[dropped]")
                            .then(|| {
                                tag_overlay
                                    .and_then(|overlay| overlay.tag_by_block_id.get(&block.id))
                                    .map(|tag_number| format!("[dropped §{tag_number}§]"))
                            })
                            .flatten();
                        rebuilt.content[block.block_index] = reduced_block(
                            &block.wire,
                            display_payload.as_deref().unwrap_or(payload),
                            block.file_path.as_deref(),
                        );
                    }
                }
            }
            if !mutation_exempt {
                apply_tag_overlay_to_message(
                    &mut rebuilt,
                    msg,
                    blocks,
                    tag_overlay,
                    |block| reduced.contains_key(&block.block_index),
                    false,
                );
            }
            rebuilt
        } else {
            let mut rebuilt = msg.ck.clone();
            apply_tag_overlay_to_message(
                &mut rebuilt,
                msg,
                &[],
                tag_overlay,
                |_| false,
                mutation_exempt,
            );
            rebuilt
        };
        out.push(rendered);

        if synthetic_todo_enabled
            && meta
                .synthetic_todo
                .as_ref()
                .and_then(|pair| pair.anchor_mid.as_deref())
                == Some(msg.mid.as_str())
        {
            push_synthetic_todo_pair(&mut out, meta);
            inserted_synthetic_todo = true;
        }
    }

    // A pair anchored to a real message must have been spliced inside the loop; if its
    // anchor is absent from the current tail we fail loud rather than silently relocate
    // (a bust folds the anchor via reanchor_kept_synthetic_todo_if_folded, so reaching
    // here means the anchor vanished on a defer = a revert/drift invariant violation).
    // The None-anchor case was already emitted before the loop, so it is not re-checked.
    if synthetic_todo_enabled {
        if let Some(pair) = &meta.synthetic_todo {
            if pair.anchor_mid.is_some() && !inserted_synthetic_todo {
                let mid = pair.anchor_mid.clone().unwrap_or_default();
                return Err(TransformError::SyntheticTodoAnchorMissing(mid));
            }
        }
    }
    if serializer_profile == Some(SerializerProfile::ClaudeCodeAnthropic) {
        let first_tail = out
            .iter()
            .position(|message| !message.meta.synthetic)
            .unwrap_or(out.len());
        debug_assert!(
            out[..first_tail]
                .iter()
                .all(|message| message.role != "system"),
            "claude-code-anthropic synthetic prefix must not contain system-role messages"
        );
    }
    if let Some(profile) = serializer_profile {
        apply_serializer_residuals_with_exemption(profile, &mut out, mutation_exempt_mid);
    }
    Ok(out)
}

#[cfg(test)]
fn apply_serializer_residuals(profile: SerializerProfile, messages: &mut [CkWireMessage]) -> usize {
    apply_serializer_residuals_with_exemption(profile, messages, None)
}

fn apply_serializer_residuals_with_exemption(
    profile: SerializerProfile,
    messages: &mut [CkWireMessage],
    mutation_exempt_mid: Option<&str>,
) -> usize {
    if quirk_residual(profile).strips_reasoning_from_merged_assistants {
        strip_reasoning_from_merged_assistants_with_exemption(messages, mutation_exempt_mid)
    } else {
        0
    }
}

fn strip_reasoning_from_merged_assistants_with_exemption(
    messages: &mut [CkWireMessage],
    mutation_exempt_mid: Option<&str>,
) -> usize {
    let mut stripped = 0;
    let mut prev_assistant = false;
    let mut kept_reasoning_in_run = false;

    for message in messages {
        if message.role != "assistant" {
            prev_assistant = false;
            kept_reasoning_in_run = false;
            continue;
        }
        let first_in_run = !prev_assistant;
        if mutation_exempt_mid == message.meta.harness_id.as_deref() && first_in_run {
            prev_assistant = true;
            continue;
        }

        if first_in_run {
            kept_reasoning_in_run = false;
        }

        let mut keep_index = None;
        if first_in_run && !kept_reasoning_in_run {
            for (idx, block) in message.content.iter().enumerate() {
                if is_reasoning_ignored_block(block) {
                    continue;
                }
                if is_reasoning_block(block) {
                    keep_index = Some(idx);
                }
                break;
            }
        }

        let mut modified = false;
        for (idx, block) in message.content.iter_mut().enumerate() {
            if !is_reasoning_block(block) {
                continue;
            }
            if Some(idx) == keep_index {
                kept_reasoning_in_run = true;
                continue;
            }
            *block = CkWireBlock::bare(ck_wire::CkKind::Text {
                text: String::new(),
            });
            stripped += 1;
            modified = true;
        }
        if modified {
            message.mark_modified();
        }
        prev_assistant = true;
    }

    stripped
}

fn is_reasoning_block(block: &CkWireBlock) -> bool {
    matches!(
        &block.kind,
        ck_wire::CkKind::Reasoning { .. } | ck_wire::CkKind::RedactedReasoning { .. }
    )
}

/// The TypeScript D2 contract for OpenCode clearing is:
///
/// * only assistant messages older than `clear_reasoning_age` are eligible;
/// * the age cutoff is measured from the newest absolute message tag. CK ingress
///   has no tag map, so this module uses its durable absolute message ordinals;
/// * a completed historical assistant is eligible even when it is the newest
///   assistant in the served tail. The old ingress exemption must not resurrect
///   reasoning that D2 cleared;
/// * an in-flight newest assistant is protected when `mid_turn` is true;
/// * canonical OpenCode Anthropic serialization receives an empty text sentinel,
///   not a rewritten signed reasoning block. The sentinel preserves part shape,
///   and the serializer removes it before provider dispatch;
/// * the cutoff is persisted in ModuleMeta and replayed on every later pass.
///
/// Anthropic verifies the latest assistant reasoning blocks against ingress bytes. Claude Code
/// keeps its verbatim-tail behavior. OpenCode keeps an ingress exemption only for a genuinely
/// live in-flight assistant; clearing has precedence for historical messages.
fn latest_assistant_mutation_exempt_mid(
    messages: &[CkIngressMessage],
    profile: Option<SerializerProfile>,
    mid_turn: bool,
) -> Option<&str> {
    if profile == Some(SerializerProfile::OpencodeAiSdk) && !mid_turn {
        return None;
    }
    if !matches!(
        profile,
        Some(SerializerProfile::ClaudeCodeAnthropic | SerializerProfile::OpencodeAiSdk)
    ) {
        return None;
    }
    messages
        .iter()
        .rev()
        .find(|message| !message.ck.meta.synthetic && message.ck.role == "assistant")
        .filter(|message| {
            message
                .ck
                .content
                .iter()
                .find(|block| !is_reasoning_ignored_block(block))
                .is_some_and(is_reasoning_block)
        })
        .map(|message| message.mid.as_str())
}

/// Match TS `modelAcceptsEmptyContent` for the OpenCode native request.
///
/// The explicit provider id is preferred. Older plugin senders already supplied a model key,
/// so `anthropic/...` is accepted as a compatibility fallback. Native OpenCode metadata is the
/// final fallback because it carries the same provider identity on assistant and user records.
pub(crate) fn request_accepts_empty_content(req: &TransformRequest) -> bool {
    if req.provider_id.as_deref() == Some("anthropic") {
        return true;
    }
    if req
        .model_key
        .as_deref()
        .and_then(|key| key.split_once('/').map(|(provider, _)| provider))
        == Some("anthropic")
    {
        return true;
    }
    let Some(native_messages) = req.native_messages.as_deref() else {
        return false;
    };
    native_messages.iter().rev().any(|message| {
        let info = message.get("info").unwrap_or(message);
        info.get("providerID").and_then(Value::as_str) == Some("anthropic")
            || info
                .get("model")
                .and_then(|model| model.get("providerID"))
                .and_then(Value::as_str)
                == Some("anthropic")
            || message.get("providerID").and_then(Value::as_str) == Some("anthropic")
    })
}

/// Compute the next durable D2 reasoning watermark on a cache-busting pass or the
/// one-time native bootstrap when no watermark exists yet.
///
/// TS computes `maxTag - clearReasoningAge` after heuristic execution. The module does not
/// receive TS tag numbers, but it does receive stable absolute message ordinals from the same
/// OpenCode database. Using those ordinals gives the same monotone age boundary and avoids
/// deriving a moving decision on defer passes. A watermark advances only when an eligible
/// assistant actually contains typed reasoning, matching TS's persisted-watermark behavior.
fn reasoning_clear_cutoff(
    req: &TransformRequest,
    profile: Option<SerializerProfile>,
    is_bust_pass: bool,
    persisted_watermark: u64,
) -> Option<u64> {
    if profile != Some(SerializerProfile::OpencodeAiSdk)
        || !request_accepts_empty_content(req)
        || !req.serve_native
        || (!is_bust_pass && persisted_watermark > 0)
        || req.mid_turn
    {
        return None;
    }

    let max_ordinal = req
        .messages
        .iter()
        .filter(|message| !message.ck.meta.synthetic)
        .map(|message| message.ordinal)
        .max()?;
    let cutoff = max_ordinal.saturating_sub(req.clear_reasoning_age);
    if cutoff == 0 {
        return None;
    }

    req.messages
        .iter()
        .filter(|message| {
            !message.ck.meta.synthetic
                && message.ck.role == "assistant"
                && message.ordinal <= cutoff
        })
        .any(|message| {
            message
                .ck
                .content
                .iter()
                .any(|block| matches!(&block.kind, ck_wire::CkKind::Reasoning { .. }))
        })
        .then_some(cutoff)
}

/// Apply the final OpenCode D2 replay to native message parts.
///
/// The CK transform deliberately leaves ingress reasoning available to identity and block
/// fingerprint checks. Native serving is the provider boundary, so this pass replaces only
/// eligible historical typed reasoning with empty typed-reasoning shells after the codec has
/// finished.
/// That ordering is important: the codec's latest-assistant ingress shortcut cannot reintroduce
/// a signed block after this function runs. The canonical OpenCode Anthropic adapter removes
/// these sentinels before dispatch, so no rewritten text or stale signature reaches Anthropic.
pub(crate) fn clear_served_native_reasoning(
    profile: SerializerProfile,
    provider_accepts_empty_content: bool,
    native_messages: &mut [Value],
    served_messages: &[CkWireMessage],
    ingress_messages: &[CkIngressMessage],
    watermark: u64,
    mid_turn: bool,
) -> usize {
    if profile != SerializerProfile::OpencodeAiSdk
        || !provider_accepts_empty_content
        || watermark == 0
    {
        return 0;
    }

    let served_ids = served_messages
        .iter()
        .filter(|message| !message.meta.synthetic && message.role == "assistant")
        .filter_map(|message| message.meta.harness_id.as_deref())
        .collect::<HashSet<_>>();
    if served_ids.is_empty() {
        return 0;
    }

    let mut ordinal_by_mid = HashMap::new();
    let mut newest_assistant_mid = None;
    let mut newest_assistant_ordinal = 0;
    for message in ingress_messages
        .iter()
        .filter(|message| !message.ck.meta.synthetic)
    {
        ordinal_by_mid.insert(message.mid.as_str(), message.ordinal);
        if message.ck.role == "assistant" && message.ordinal >= newest_assistant_ordinal {
            newest_assistant_ordinal = message.ordinal;
            newest_assistant_mid = Some(message.mid.as_str());
        }
    }

    let mut cleared = 0;
    for raw_message in native_messages {
        let info = raw_message.get("info").unwrap_or(raw_message);
        let Some(mid) = info
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| raw_message.get("id").and_then(Value::as_str))
        else {
            continue;
        };
        if !served_ids.contains(mid)
            || info.get("role").and_then(Value::as_str) != Some("assistant")
        {
            continue;
        }
        let Some(&ordinal) = ordinal_by_mid.get(mid) else {
            continue;
        };
        if ordinal > watermark || (mid_turn && newest_assistant_mid == Some(mid)) {
            continue;
        }

        let Some(parts) = raw_message.get_mut("parts").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts {
            let Some(part_type) = part.get("type").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(part_type, "reasoning" | "thinking")
                || (!part.get("thinking").is_some() && !part.get("text").is_some())
            {
                continue;
            }
            if is_empty_reasoning_sentinel(part) {
                continue;
            }
            *part = empty_reasoning_sentinel(part);
            cleared += 1;
        }
    }
    cleared
}

fn empty_reasoning_sentinel(part: &Value) -> Value {
    let mut sentinel = serde_json::Map::new();
    let Some(object) = part.as_object() else {
        return Value::Object(sentinel);
    };
    let part_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("reasoning");
    sentinel.insert("type".to_string(), Value::String(part_type.to_string()));
    if object.contains_key("thinking") && !object.contains_key("text") {
        sentinel.insert("thinking".to_string(), Value::String(String::new()));
    } else {
        sentinel.insert("text".to_string(), Value::String(String::new()));
    }
    Value::Object(sentinel)
}

fn is_empty_reasoning_sentinel(part: &Value) -> bool {
    let Some(object) = part.as_object() else {
        return false;
    };
    if object.len() != 2 || !object.contains_key("type") {
        return false;
    }
    object
        .get("text")
        .or_else(|| object.get("thinking"))
        .is_some_and(|value| value.as_str() == Some(""))
}

fn is_empty_text_block(block: &CkWireBlock) -> bool {
    matches!(&block.kind, ck_wire::CkKind::Text { text } if text.is_empty())
}

fn is_reasoning_ignored_block(block: &CkWireBlock) -> bool {
    if is_empty_text_block(block) {
        return true;
    }
    matches!(
        &block.kind,
        ck_wire::CkKind::Opaque(opaque)
            if matches!(
                opaque.kind.as_str(),
                "step-start"
                    | "step-finish"
                    | "snapshot"
                    | "patch"
                    | "agent"
                    | "retry"
                    | "subtask"
                    | "compaction"
            )
    )
}

fn projection_blocks_by_mid(projection: &FlatProjection) -> BTreeMap<&str, Vec<&FlatBlock>> {
    let mut by_mid: BTreeMap<&str, Vec<&FlatBlock>> = BTreeMap::new();
    for block in &projection.blocks {
        by_mid.entry(block.mid.as_str()).or_default().push(block);
    }
    by_mid
}

fn action_str(plan: &PassPlan, _core: &CoreState) -> String {
    match plan {
        PassPlan::Hard | PassPlan::MigrateHard => "HARD",
        PassPlan::Soft => "SOFT",
        PassPlan::Defer => "SOFT+",
        PassPlan::Reject(_) => "ERROR",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    use mc_store::{InsertMemoryInput, ModuleUsage, ShadowStateSyncRequest, StoredCompartment};

    #[test]
    fn effective_context_limit_falls_back_below_plausible_floor() {
        assert_eq!(
            effective_context_limit_tokens(&ModuleUsage {
                current_total_input_tokens: 1,
                context_limit_tokens: 500,
            }),
            200_000.0
        );
        assert_eq!(
            effective_context_limit_tokens(&ModuleUsage {
                current_total_input_tokens: 1,
                context_limit_tokens: 0,
            }),
            200_000.0
        );
        assert_eq!(
            effective_context_limit_tokens(&ModuleUsage {
                current_total_input_tokens: 1,
                context_limit_tokens: crate::scheduler::MIN_PLAUSIBLE_CONTEXT_LIMIT,
            }),
            crate::scheduler::MIN_PLAUSIBLE_CONTEXT_LIMIT as f64
        );
    }
    use serde_json::{json, Value};

    fn store(dir: &std::path::Path) -> McStore {
        McStore::open(&StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        })
        .unwrap()
    }

    fn run_active_surface_test<T>(f: impl FnOnce() -> T) -> T {
        f()
    }

    fn text_message(id: &str, text: &str) -> CkWireMessage {
        CkWireMessage::from_parts(
            "user",
            vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: text.to_string(),
            })],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some(id.to_string()),
                ..Default::default()
            },
        )
    }

    fn item(id: &str, ordinal: u64, bytes: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck: text_message(id, bytes),
        }
    }

    /// Build the omitted-wire and explicit-false forms of one request through the
    /// SAME wire deserialization path, differing only in tool_present presence.
    fn wire_pair_absent_and_explicit_false(
        base: TransformRequest,
    ) -> (TransformRequest, TransformRequest) {
        let mut explicit_value = serde_json::to_value(&base).unwrap();
        explicit_value
            .as_object_mut()
            .unwrap()
            .insert("tool_present".to_string(), serde_json::Value::Bool(false));
        let explicit: TransformRequest = serde_json::from_value(explicit_value).unwrap();
        let mut absent_value = serde_json::to_value(&base).unwrap();
        absent_value.as_object_mut().unwrap().remove("tool_present");
        let absent: TransformRequest = serde_json::from_value(absent_value).unwrap();
        (absent, explicit)
    }

    /// Build an ingress message THROUGH WIRE DESERIALIZATION, the way real traffic
    /// arrives. Deserialized messages retain `original` pass-through bytes on the
    /// message AND every block; typed-constructor fixtures (`from_parts`/`bare`)
    /// don't, which is exactly how an output-overlay bug can hide from a fixture
    /// while dropping bytes on the wire.
    fn wire_item(role: &str, id: &str, ordinal: u64, texts: &[&str]) -> CkIngressMessage {
        let content: Vec<Value> = texts
            .iter()
            .map(|text| json!({ "kind": { "type": "text", "text": text } }))
            .collect();
        let ck: CkWireMessage = serde_json::from_value(json!({
            "role": role,
            "content": content,
            "meta": { "harness_id": id },
        }))
        .unwrap();
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck,
        }
    }

    /// Mirror of the first live rig drive's beat shape: a CC session whose first
    /// user message carries several text blocks (system-reminder wrappers around
    /// the prompt), followed by an assistant reply and a fresh user turn, all
    /// built through wire deserialization so blocks retain pass-through bytes.
    /// The drive observed zero tag prefixes on the second active pass.
    #[test]
    fn rig_shape_second_active_pass_tags_wire_deserialized_tail() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mb = wire_item(
            "user",
            "ccm-0",
            0,
            &[
                "<system-reminder>\ncontext block\n</system-reminder>\n\n",
                "You are in a test drive. Reply with exactly: BEAT1-OK.",
                "<system-reminder>\nagents\n</system-reminder>",
                "<system-reminder>\nskills\n</system-reminder>\n",
                "You are in a test drive. Reply with exactly: BEAT1-OK.",
            ],
        );
        let beat1 = active_cc_req("rig", "cfg0", vec![mb.clone()]);
        let transition = run(&s, &beat1, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);

        let beat2 = active_cc_req(
            "rig",
            "cfg0",
            vec![
                mb,
                wire_item("assistant", "ccm-1", 1, &["BEAT1-OK"]),
                wire_item(
                    "user",
                    "ccm-2",
                    2,
                    &["Call the ctx_search tool exactly once."],
                ),
            ],
        );
        // The live drive paused ~434s between beats, so the second pass classified
        // HARD via the idle-TTL trigger (default cache_ttl 5m). The TTL predicate
        // needs an observed prior response time to arm; without it the pass stays
        // SOFT-class and this fixture would not cover the drive's actual shape.
        let mut ttl_ctx = pctx("git:proj", "/nonexistent-docs", 434_000);
        ttl_ctx.observed_last_response_at_ms = Some(1);
        ttl_ctx.injected_reductions = spine().to_vec();
        let second = transform(&s, &beat2, &ttl_ctx).unwrap();
        assert_eq!(
            second.action, "HARD",
            "idle-TTL fold must fire past cache_ttl"
        );
        assert_eq!(second.surface_state, SurfaceState::Active);
        let joined = serde_json::to_string(&second.ck_messages).unwrap();
        assert!(
            joined.contains("\u{a7}1\u{a7}"),
            "second active pass emitted no tag prefixes: {joined}"
        );
        assert!(
            joined.contains("\u{a7}7\u{a7}"),
            "new user turn missing its tag: {joined}"
        );
    }

    /// Wire-deserialized tool-result ingress message. `output_json` is the raw
    /// CkToolOutput JSON so each output variant (text / error_text / content) can
    /// be exercised with retained pass-through bytes on the block.
    fn wire_tool_result(id: &str, ordinal: u64, output_json: Value) -> CkIngressMessage {
        let ck: CkWireMessage = serde_json::from_value(json!({
            "role": "user",
            "content": [{ "kind": {
                "type": "tool_result",
                "id": format!("call_{id}"),
                "tool_name": "probe",
                "provider_executed": false,
                "output": output_json,
            }}],
            "meta": { "harness_id": id },
        }))
        .unwrap();
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck,
        }
    }

    /// Wire-deserialized assistant tool-call message pairing a later tool result.
    fn wire_tool_call(id: &str, ordinal: u64, call_id: &str) -> CkIngressMessage {
        let ck: CkWireMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": [{ "kind": {
                "type": "tool_call",
                "id": call_id,
                "name": "probe",
                "input": {},
            }}],
            "meta": { "harness_id": id },
        }))
        .unwrap();
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck,
        }
    }

    /// Drive one session to the second active pass (tags emitting) over the given
    /// tail and return the serialized output for byte-level assertions.
    fn second_active_pass_json(session: &str, messages: Vec<CkIngressMessage>) -> String {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let req = active_cc_req(session, "cfg0", messages);
        let transition = run(&s, &req, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        let second = run(&s, &req, &spine());
        assert_eq!(second.surface_state, SurfaceState::Active);
        serde_json::to_string(&second.ck_messages).unwrap()
    }

    /// Every tool-result output variant the overlay can prefix must survive
    /// serialization when the fixture arrives through wire deserialization
    /// (retained pass-through bytes on the block). Each case fails if the
    /// overlay stops clearing the mutated block's retained bytes.
    #[test]
    fn wire_tool_result_text_variant_tags_survive_serialization() {
        let joined = second_active_pass_json(
            "wire-tr-text",
            vec![
                wire_tool_call("a1", 1, "call_t1"),
                wire_tool_result(
                    "t1",
                    2,
                    json!({ "kind": { "type": "text", "text": "plain output" } }),
                ),
            ],
        );
        assert!(
            joined.contains("\u{a7}1\u{a7} plain output"),
            "text output lost its tag: {joined}"
        );
    }

    #[test]
    fn wire_tool_result_error_text_variant_tags_survive_serialization() {
        let joined = second_active_pass_json(
            "wire-tr-err",
            vec![
                wire_tool_call("a1", 1, "call_t1"),
                wire_tool_result(
                    "t1",
                    2,
                    json!({ "kind": { "type": "error_text", "text": "boom" } }),
                ),
            ],
        );
        assert!(
            joined.contains("\u{a7}1\u{a7} boom"),
            "error_text output lost its tag: {joined}"
        );
    }

    #[test]
    fn wire_tool_result_content_variant_tags_survive_serialization() {
        let joined = second_active_pass_json(
            "wire-tr-content",
            vec![
                wire_tool_call("a1", 1, "call_t1"),
                wire_tool_result(
                    "t1",
                    2,
                    json!({ "kind": { "type": "content", "blocks": [
                        { "kind": { "type": "text", "text": "nested text" } },
                    ]}}),
                ),
            ],
        );
        assert!(
            joined.contains("\u{a7}1\u{a7} nested text"),
            "content-variant output lost its tag: {joined}"
        );
    }

    #[test]
    fn wire_channel1_append_survives_serialization() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let messages = vec![
            wire_tool_call("a1", 1, "call_t1"),
            wire_tool_result(
                "t1",
                2,
                json!({ "kind": { "type": "text", "text": "tool output" } }),
            ),
        ];
        let req = active_cc_req("wire-ch1", "cfg0", messages);
        let transition = run(&s, &req, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        run(&s, &req, &spine());
        s.seed_channel1_append_for_test("wire-ch1", "t1#0", "reminder: reduce spent outputs", 5)
            .unwrap();
        // Ingress always carries the ORIGINAL bytes (tags exist only on the
        // provider wire; raw ingress bytes are identity), so the same request
        // replays and the append rides the shared overlay clear site.
        let third = run(&s, &req, &spine());
        let joined = serde_json::to_string(&third.ck_messages).unwrap();
        assert!(
            joined.contains("reminder: reduce spent outputs"),
            "channel-1 append lost on wire-deserialized block: {joined}"
        );
    }

    /// Mixed-message canary: a mutated block must canonicalize while its untouched
    /// sibling keeps its retained pass-through bytes VERBATIM, including unknown
    /// fields serde would drop, and message-level provenance survives.
    #[test]
    fn overlay_canonicalizes_only_the_mutated_block() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let ck: CkWireMessage = serde_json::from_value(json!({
            "role": "user",
            "content": [
                { "kind": { "type": "text", "text": "taggable prompt" } },
                { "kind": { "type": "opaque", "source": "provider", "kind": "server_tool",
                    "raw": { "some": "provider-native" } },
                  "sentinel_unknown_field": "must-survive-verbatim" },
            ],
            "provider_extras": { "anthropic": { "probe": "message-provenance" } },
            "meta": { "harness_id": "mixed-0" },
        }))
        .unwrap();
        let item = CkIngressMessage {
            mid: "mixed-0".to_string(),
            ordinal: 0,
            ck,
        };
        let req = active_cc_req("wire-mixed", "cfg0", vec![item]);
        let transition = run(&s, &req, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        let second = run(&s, &req, &spine());
        let joined = serde_json::to_string(&second.ck_messages).unwrap();
        assert!(
            joined.contains("\u{a7}1\u{a7} taggable prompt"),
            "mutated block missing its tag: {joined}"
        );
        assert!(
            joined.contains("sentinel_unknown_field"),
            "untouched sibling lost retained unknown field: {joined}"
        );
        assert!(
            joined.contains("must-survive-verbatim"),
            "untouched sibling bytes not verbatim: {joined}"
        );
        assert!(
            joined.contains("message-provenance"),
            "message provenance lost: {joined}"
        );
    }

    /// Models copy the tag notation they see in history onto their own replies.
    /// The overlay must strip those imitation prefixes on assistant text at any
    /// line start while preserving mid-prose references on ACTIVE passes. False
    /// passes serve the ingress bytes untouched.
    #[test]
    fn assistant_tag_imitation_prefixes_strip_on_active_passes_only() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let messages = vec![
            wire_item("user", "ccm-0", 0, &["say BEAT3-OK"]),
            wire_item(
                "assistant",
                "ccm-1",
                1,
                &["preamble\n§39§ §39§ BEAT3-OK\nI dropped §12§."],
            ),
        ];
        let req = active_cc_req("imitation", "cfg0", messages.clone());
        let transition = run(&s, &req, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        let second = run(&s, &req, &spine());
        let joined = serde_json::to_string(&second.ck_messages).unwrap();
        assert_eq!(
            tail_bytes(&second, "ccm-1"),
            "§2§ preamble\nBEAT3-OK\nI dropped §12§.",
            "line-leading imitations must strip, official tag applies, mid-prose reference survives: {joined}"
        );
        assert!(
            !joined.contains("\u{a7}39\u{a7}"),
            "model-authored leading prefixes must not reach the wire on active passes: {joined}"
        );

        // False pass on the same session: ingress bytes verbatim (no strip, no tags).
        let mut inactive = cc_req("imitation", "cfg0", messages);
        inactive.tool_present = false;
        let off = run(&s, &inactive, &spine());
        let joined_off = serde_json::to_string(&off.ck_messages).unwrap();
        assert!(
            joined_off.contains("\u{a7}39\u{a7} \u{a7}39\u{a7} BEAT3-OK"),
            "false passes must serve model-authored bytes verbatim: {joined_off}"
        );
    }

    /// The strip's inter-prefix separator class is full whitespace: models copy
    /// imitation prefixes separated by spaces, tabs, or newlines, and a leaked
    /// separator would put the imitation back on the wire behind the official
    /// tag. Malformed shapes and mid-prose references must stay verbatim.
    #[test]
    fn strip_leading_tag_imitations_covers_whitespace_and_preserves_malformed() {
        // Multi-prefix runs across every separator class strip completely.
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39\u{a7} \u{a7}40\u{a7} BEAT"),
            "BEAT"
        );
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39\u{a7}\t\u{a7}40\u{a7}\tBEAT"),
            "BEAT"
        );
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39\u{a7}\n\u{a7}40\u{a7}\nBEAT"),
            "BEAT"
        );
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39\u{a7} \n\t \u{a7}40\u{a7} BEAT"),
            "BEAT"
        );
        // Malformed leading shapes are NOT well-formed prefixes: verbatim.
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39 BEAT"),
            "\u{a7}39 BEAT"
        );
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}\u{a7} BEAT"),
            "\u{a7}\u{a7} BEAT"
        );
        // Mid-prose references stay: the strip is anchored to the head.
        assert_eq!(
            strip_leading_tag_imitations("I dropped \u{a7}12\u{a7} earlier"),
            "I dropped \u{a7}12\u{a7} earlier"
        );
        assert_eq!(
            strip_leading_tag_imitations("\u{a7}39\u{a7}BEAT"),
            "\u{a7}39\u{a7}BEAT",
            "a token without a separator is not an imitation"
        );
    }

    #[test]
    fn assistant_tag_imitations_strip_on_later_lines_but_not_code() {
        let value = "preamble\n\u{a7}22\u{a7} Delta\n`\u{a7}23\u{a7} inline`\n```rust\n\u{a7}24\u{a7} fenced\n```\n\u{a7}25\u{a7} Echo";
        assert_eq!(
            strip_leading_tag_imitations(value),
            "preamble\nDelta\n`\u{a7}23\u{a7} inline`\n```rust\n\u{a7}24\u{a7} fenced\n```\nEcho"
        );
    }

    fn two_block_item(id: &str, ordinal: u64, first: &str, second: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "user",
                vec![
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                        text: first.to_string(),
                    }),
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                        text: second.to_string(),
                    }),
                ],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta::default(),
            ),
        }
    }

    fn system_item(id: &str, ordinal: u64, bytes: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "system",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                    text: bytes.to_string(),
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta::default(),
            ),
        }
    }

    fn item_with_block_provider_extras(
        id: &str,
        ordinal: u64,
        bytes: &str,
        nonce: &str,
    ) -> CkIngressMessage {
        let mut provider = std::collections::BTreeMap::new();
        provider.insert("cache_control".to_string(), json!({ "nonce": nonce }));
        let mut extras = ck_wire::ProviderExtras::new();
        extras.insert("synthetic".to_string(), provider);
        CkIngressMessage {
            mid: id.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "user",
                vec![ck_wire::CkWireBlock::with_provider_extras(
                    ck_wire::CkKind::Text {
                        text: bytes.to_string(),
                    },
                    extras,
                )],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(id.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn post_submit_strip_block_provider_extras(
        mut messages: Vec<CkIngressMessage>,
    ) -> Vec<CkIngressMessage> {
        for message in &mut messages {
            for block in &mut message.ck.content {
                block.provider_extras.clear();
            }
        }
        messages
    }

    fn flat_id(mid: &str) -> String {
        format!("{mid}#0")
    }

    fn target_id(id: &str) -> String {
        if id.contains('#') {
            id.to_string()
        } else {
            flat_id(id)
        }
    }

    fn req(session: &str, cfg: &str, messages: Vec<CkIngressMessage>) -> TransformRequest {
        TransformRequest {
            kind: "transform".to_string(),
            v: 2,
            serializer_profile: "owned-llmrunner".to_string(),
            session_id: session.to_string(),
            render_config: cfg.to_string(),
            provider_id: None,
            model_key: None,
            clear_reasoning_age: DEFAULT_CLEAR_REASONING_AGE,
            tool_present: false,
            serve_native: false,
            native_messages: None,
            full_array_fingerprint: None,
            messages,
            tail_delta: None,
            usage: None,
            provider_error: None,
            mid_turn: false,
            prev_response_completed_at_ms: None,
            request_observed_at_ms: None,
            history_budget_tokens: None,
            declared_trim: None,
        }
    }

    fn spine() -> Vec<ReductionDecision> {
        Vec::new()
    }

    /// A store compartment covering raw ordinals `start..=end`, ending at message id
    /// `end_id`, rendered at P1 with body `p1`. The m0 baseline is composed from these.
    fn comp(seq: i64, start: i64, end: i64, end_id: &str, p1: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: target_id(end_id),
            title: format!("C{seq}"),
            content: p1.to_string(),
            p1: Some(p1.to_string()),
            importance: 50,
            ..Default::default()
        }
    }

    fn memory_input<'a>(
        project_path: &'a str,
        category: &'a str,
        content: &'a str,
        now_ms: i64,
    ) -> InsertMemoryInput<'a> {
        InsertMemoryInput {
            project_path,
            category,
            content,
            source_session_id: None,
            source_type: Some("tool"),
            importance: Some(70),
            expires_at: None,
            metadata_json: None,
            now_ms,
        }
    }

    /// A producer context over a throwaway project dir (no docs on disk → empty docs
    /// block). `now_ms` is FIXED per test (never wall-clock) so the frozen expiry cutoff
    /// is deterministic.
    fn pctx<'a>(project: &'a str, dir: &'a str, now_ms: i64) -> ProducerContext<'a> {
        ProducerContext {
            project_path: project,
            project_directory: dir,
            history_budget_tokens: 60_000.0,
            memory_enabled: true,
            now_ms,
            execute_threshold_percentage: 65.0,
            smart_drops: false,
            cache_ttl: "5m".to_string(),
            model_key: None,
            observed_last_response_at_ms: None,
            guidance_date: Some("Today's date: Thu Jan 01 1970".to_string()),
            injected_reductions: Vec::new(),
        }
    }

    fn smart_pctx<'a>() -> ProducerContext<'a> {
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.smart_drops = true;
        ctx
    }

    fn seed_unrelated_hint_candidates(store: &McStore) {
        for (id, content) in [
            (9_998, "unrelated fixture material"),
            (9_999, "separate archive subject"),
        ] {
            store
                .seed_memory(id, "git:proj", "CONSTRAINTS", content, 50)
                .unwrap();
        }
    }

    fn with_usage(
        mut request: TransformRequest,
        current_total_input_tokens: u64,
        context_limit_tokens: u64,
    ) -> TransformRequest {
        let min = crate::scheduler::MIN_PLAUSIBLE_CONTEXT_LIMIT;
        let (input, limit) = if context_limit_tokens >= min {
            (current_total_input_tokens, context_limit_tokens)
        } else if context_limit_tokens > 0 {
            // Shorthand fixtures (e.g. 70/100 for 70% usage): scale to a plausible limit
            // while preserving the implied percentage.
            let pct = current_total_input_tokens as f64 / context_limit_tokens as f64;
            let limit = 100_000u64;
            let input = (pct * limit as f64).round().max(1.0) as u64;
            (input, limit)
        } else {
            (current_total_input_tokens, min)
        };
        request.usage = Some(ModuleUsage {
            current_total_input_tokens: input,
            context_limit_tokens: limit,
        });
        request
    }

    fn todowrite_arc(mid: &str, call_ordinal: u64) -> Vec<CkIngressMessage> {
        vec![
            todowrite_call(mid, call_ordinal, json!([])),
            tool_result(
                &format!("{mid}_result"),
                call_ordinal + 1,
                &format!("call_{mid}"),
                "todo output",
            ),
        ]
    }

    /// Run a transform with a default producer context (project "git:proj", a nonexistent
    /// docs dir, now_ms=0). Most tests don't vary the context.
    fn run(s: &McStore, req: &TransformRequest, d: &[ReductionDecision]) -> TransformResponse {
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.injected_reductions = d.to_vec();
        transform(s, req, &ctx).unwrap()
    }

    fn synthetic_text(r: &TransformResponse, index: usize) -> &str {
        ck_wire::text_from_message(
            r.messages()
                .iter()
                .filter(|m| m.meta.synthetic)
                .nth(index)
                .unwrap(),
        )
        .unwrap()
    }

    fn m0_bytes(r: &TransformResponse) -> &str {
        synthetic_text(r, 0)
    }
    fn m1_bytes(r: &TransformResponse) -> &str {
        synthetic_text(r, 1)
    }
    fn tail_ids(r: &TransformResponse) -> Vec<&str> {
        r.messages()
            .iter()
            .filter(|m| !m.meta.synthetic)
            .map(|m| m.meta.harness_id.as_deref().unwrap_or(""))
            .collect()
    }

    fn ingress_from_ck(messages: Vec<CkWireMessage>) -> Vec<CkIngressMessage> {
        messages
            .into_iter()
            .enumerate()
            .map(|(i, ck)| CkIngressMessage {
                mid: format!("m{i}"),
                ordinal: i as u64 + 1,
                ck,
            })
            .collect()
    }

    fn assistant_tool_call(mid: &str, ordinal: u64, call_id: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolCall {
                    id: call_id.to_string(),
                    name: "read".to_string(),
                    input: json!({ "path": "a.txt" }),
                    provider_executed: false,
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn tool_result(mid: &str, ordinal: u64, call_id: &str, text: &str) -> CkIngressMessage {
        tool_result_with_output(
            mid,
            ordinal,
            call_id,
            ck_wire::CkOutputKind::Text {
                text: text.to_string(),
            },
        )
    }

    fn opaque_result_carrier(mid: &str, ordinal: u64, role: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Opaque(
                    ck_wire::OpaqueBlock {
                        source: json!({ "type": "tool_result" }),
                        kind: "tool_result".to_string(),
                        raw: json!({ "output": "transport" }),
                        arc: None,
                    },
                ))],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn tool_result_with_output(
        mid: &str,
        ordinal: u64,
        call_id: &str,
        output: ck_wire::CkOutputKind,
    ) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "tool",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolResult {
                    id: call_id.to_string(),
                    tool_name: "read".to_string(),
                    output: ck_wire::CkToolOutput::bare(output),
                    provider_executed: false,
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn todowrite_call(mid: &str, ordinal: u64, todos: Value) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolCall {
                    id: format!("call_{mid}"),
                    name: "todowrite".to_string(),
                    input: json!({ "todos": todos }),
                    provider_executed: false,
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn empty_message(mid: &str, ordinal: u64) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "user",
                Vec::new(),
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn message_index(r: &TransformResponse, harness_id: &str) -> usize {
        r.messages()
            .iter()
            .position(|m| !m.meta.synthetic && m.meta.harness_id.as_deref() == Some(harness_id))
            .unwrap_or_else(|| panic!("message {harness_id} not found"))
    }

    fn synthetic_todo_index(r: &TransformResponse) -> usize {
        r.messages()
            .iter()
            .position(|m| {
                m.meta.synthetic
                    && matches!(
                        m.content.first().map(|block| &block.kind),
                        Some(ck_wire::CkKind::ToolCall { name, .. }) if name == "todowrite"
                    )
            })
            .expect("synthetic todowrite assistant message not found")
    }

    fn synthetic_todo_call_id(r: &TransformResponse) -> String {
        let msg = &r.messages()[synthetic_todo_index(r)];
        match &msg.content[0].kind {
            ck_wire::CkKind::ToolCall { id, .. } => id.clone(),
            other => panic!("expected synthetic todowrite ToolCall, got {other:?}"),
        }
    }

    fn prefix_through_synthetic_todo(r: &TransformResponse) -> Vec<Vec<u8>> {
        let end = synthetic_todo_index(r) + 1;
        r.messages()[..=end]
            .iter()
            .map(|m| serde_json::to_vec(m).unwrap())
            .collect()
    }

    fn synthetic_todo_pair_bytes(r: &TransformResponse) -> (Vec<u8>, Vec<u8>) {
        let i = synthetic_todo_index(r);
        (
            serde_json::to_vec(&r.messages()[i]).unwrap(),
            serde_json::to_vec(&r.messages()[i + 1]).unwrap(),
        )
    }

    /// Cross-repo drift pin for the shared CK wire fixture. Three parties ride
    /// this exact byte shape (llm-runner produces it, this module parses it,
    /// the thalamus gateway produces it), and each repo vendors its own copy, so a
    /// one-sided regeneration would leave every repo locally green while the
    /// wire silently drifts. Each repo pins the fixture's sha256; a regen
    /// fails the pin everywhere until each consumer deliberately re-vendors
    /// and updates its constant. llm-runner owns the canonical fixture and
    /// announces the new sha when it legitimately changes.
    #[test]
    fn ck_wire_golden_bytes_match_cross_repo_pin() {
        use sha2::{Digest, Sha256};
        const GOLDEN_SHA256: &str =
            "e6143e10762f3f1b33a2a2bc32860e8fcd51dece00d7af67e7c2245c309db192";
        let bytes = include_bytes!("../testdata/ck_wire_golden.json");
        let actual = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(
            actual, GOLDEN_SHA256,
            "ck_wire_golden.json changed. If this is a deliberate re-vendor of the \
             canonical fixture, update GOLDEN_SHA256 to match; otherwise restore the \
             vendored bytes."
        );
    }

    #[test]
    fn ck_wire_golden_projects_to_flat_blocks() {
        let ck: Vec<CkWireMessage> =
            serde_json::from_str(include_str!("../testdata/ck_wire_golden.json")).unwrap();
        let projection = project_messages(&ingress_from_ck(ck)).unwrap();
        let actual = serde_json::to_value(&projection.blocks).unwrap();
        if std::env::var_os("MC_REGEN_PROJECTION_GOLDEN").is_some() {
            std::fs::write(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/testdata/ingress-projection-golden.json"
                ),
                serde_json::to_string_pretty(&actual).unwrap(),
            )
            .unwrap();
        }
        let expected: Value =
            serde_json::from_str(include_str!("../testdata/ingress-projection-golden.json"))
                .unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn arc_identity_is_session_injective_for_reused_tool_ids() {
        let messages = vec![
            assistant_tool_call("turn1_call", 1, "call_0"),
            tool_result("turn1_result", 2, "call_0", "one"),
            assistant_tool_call("turn2_call", 3, "call_0"),
            tool_result("turn2_result", 4, "call_0", "two"),
        ];
        let projection = project_messages(&messages).unwrap();
        let result_arcs: Vec<_> = projection
            .blocks
            .iter()
            .filter(|b| b.kind_tag == "tool_result")
            .map(|b| b.arc_id.as_deref().unwrap())
            .collect();
        assert_eq!(result_arcs, vec!["turn1_call#0", "turn2_call#0"]);
        assert_ne!(result_arcs[0], result_arcs[1]);
    }

    #[test]
    fn opaque_and_media_project_verbatim_across_passes() {
        // Opaque is a first-class carrier: it must project with verbatim bytes and
        // an "opaque" kind tag rather than rejecting provider-native blocks.
        let opaque = CkIngressMessage {
            mid: "opaque".to_string(),
            ordinal: 1,
            ck: CkWireMessage::from_parts(
                "user",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Opaque(
                    ck_wire::OpaqueBlock {
                        source: json!({ "source": "wire", "wire": "test" }),
                        kind: "native".to_string(),
                        raw: json!({ "x": 1 }),
                        arc: None,
                    },
                ))],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta::default(),
            ),
        };
        let projection = project_messages(&[opaque]).unwrap();
        assert_eq!(projection.blocks.len(), 1);
        let block = &projection.blocks[0];
        assert_eq!(block.kind_tag, "opaque");
        // Verbatim source bytes: the serialized block must round-trip the
        // source-tagged struct shape ({"source":"wire","wire":...}) untouched.
        assert!(block
            .bytes
            .contains("\"source\":{\"source\":\"wire\",\"wire\":\"test\"}"));

        let media = CkIngressMessage {
            mid: "media".to_string(),
            ordinal: 1,
            ck: CkWireMessage::from_parts(
                "user",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Media(
                    ck_wire::MediaBlock {
                        kind: ck_wire::MediaKind::Image,
                        media_type: "image/png".to_string(),
                        filename: None,
                        source: json!({ "source": "url", "url": "file://x" }),
                    },
                ))],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta::default(),
            ),
        };
        let media_wire = serde_json::to_value(&media.ck).unwrap();
        let media_projection = project_messages(std::slice::from_ref(&media)).unwrap();
        assert_eq!(media_projection.blocks[0].kind_tag, "media");
        assert!(media_projection.blocks[0].bytes.contains("file://x"));

        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let first = run(
            &store,
            &req("media-pass", "cfg", vec![media.clone()]),
            &spine(),
        );
        let second = run(&store, &req("media-pass", "cfg", vec![media]), &spine());
        for response in [&first, &second] {
            let replayed = response
                .messages()
                .iter()
                .find(|message| !message.meta.synthetic)
                .expect("live media message must pass through");
            assert_eq!(serde_json::to_value(replayed).unwrap(), media_wire);
        }
    }

    fn assistant_form(mid: &str, ordinal: u64, texts: &[&str]) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "assistant",
                texts
                    .iter()
                    .map(|text| {
                        ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                            text: (*text).to_string(),
                        })
                    })
                    .collect(),
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    #[test]
    fn shadow_mid_turn_tail_stays_provisional_and_reset_recovers_identity_drift() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let session = "shadow:identity-recovery";
        let partial = assistant_form("tail", 1, &["partial"]);
        let complete = assistant_form("tail", 1, &["partial", "completed"]);

        // This is the production failure shape when a streaming form is pinned first.
        let pinned = req(session, "cfg0", vec![partial.clone()]);
        transform(&store, &pinned, &pctx("git:proj", "/nonexistent-docs", 0)).unwrap();
        let drift = req(session, "cfg0", vec![complete.clone()]);
        assert!(matches!(
            transform(&store, &drift, &pctx("git:proj", "/nonexistent-docs", 1)),
            Err(TransformError::IdentityDrift(mid)) if mid == "tail"
        ));

        let reset = store.reset_shadow_session(session, session).unwrap();
        assert!(reset.shadow_seq == 0);
        assert!(store
            .load(session)
            .unwrap()
            .meta
            .block_identity_by_mid
            .is_empty());
        transform(&store, &drift, &pctx("git:proj", "/nonexistent-docs", 2)).unwrap();

        // The exemption is shadow-only; a non-shadow request remains byte-for-byte strict even
        // if an unexpected caller supplies the mid_turn field.
        let owned_session = "owned:identity-provisional";
        let mut owned_mid_turn = req(
            owned_session,
            "cfg0",
            vec![assistant_form("owned", 1, &["partial"])],
        );
        owned_mid_turn.mid_turn = true;
        transform(
            &store,
            &owned_mid_turn,
            &pctx("git:proj", "/nonexistent-docs", 3),
        )
        .unwrap();
        assert!(store
            .load(owned_session)
            .unwrap()
            .meta
            .block_identity_by_mid
            .contains_key("owned"));

        // Shadow sends carry mid_turn, so the same partial form is never pinned.
        let shadow_session = "shadow:identity-provisional";
        let mut provisional = req(shadow_session, "cfg0", vec![partial]);
        provisional.mid_turn = true;
        transform(
            &store,
            &provisional,
            &pctx("git:proj", "/nonexistent-docs", 3),
        )
        .unwrap();
        assert!(!store
            .load(shadow_session)
            .unwrap()
            .meta
            .block_identity_by_mid
            .contains_key("tail"));
        transform(
            &store,
            &req(shadow_session, "cfg0", vec![complete]),
            &pctx("git:proj", "/nonexistent-docs", 4),
        )
        .unwrap();
        assert_eq!(
            store
                .load(shadow_session)
                .unwrap()
                .meta
                .block_identity_by_mid
                .get("tail")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn enforcement_rejects_drift_duplicates_and_vanished_reduction_targets() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        run(&s, &req("ses", "cfg0", vec![item("a", 1, "one")]), &spine());
        let drift = transform(
            &s,
            &req("ses", "cfg0", vec![item("a", 1, "two")]),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(matches!(drift, TransformError::IdentityDrift(mid) if mid == "a"));

        let dup = transform(
            &s,
            &req(
                "dup",
                "cfg0",
                vec![item("same", 1, "x"), item("same", 2, "y")],
            ),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(matches!(dup, TransformError::DuplicateBlockId(id) if id == "same#0"));

        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let one_block = vec![item("live", 1, "only block")];
        let projection = project_messages(&one_block).unwrap();
        let core = CoreState {
            frozen_units: vec![
                synth_region("m0", "BASE".into()),
                synth_region("m1", M1_PLACEHOLDER.into()),
                red_unit("live#1", "drop", "[dropped 1]"),
            ],
            ..Default::default()
        };
        let meta = ModuleMeta {
            initialized: true,
            block_identity_by_mid: projection.identity_by_mid,
            ..Default::default()
        };
        s.commit("vanish", None, &core, &meta).unwrap();
        let vanished = transform(
            &s,
            &req("vanish", "cfg0", one_block),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(matches!(
            vanished,
            TransformError::FrozenRedTargetVanish(id) if id == "live#1"
        ));
    }

    #[test]
    fn usage_non_zero_wins_and_absent_or_zero_falls_back_to_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut first = req("usage", "cfg0", vec![item("a", 1, "x")]);
        first.usage = Some(ModuleUsage {
            current_total_input_tokens: 100,
            context_limit_tokens: 1000,
        });
        run(&s, &first, &spine());
        assert_eq!(
            s.load("usage").unwrap().meta.last_usage,
            Some(ModuleUsage {
                current_total_input_tokens: 100,
                context_limit_tokens: 1000,
            })
        );

        let mut lower = req("usage", "cfg0", vec![item("a", 1, "x")]);
        lower.usage = Some(ModuleUsage {
            current_total_input_tokens: 50,
            context_limit_tokens: 1000,
        });
        run(&s, &lower, &spine());
        assert_eq!(
            s.load("usage")
                .unwrap()
                .meta
                .last_usage
                .unwrap()
                .current_total_input_tokens,
            50,
            "a non-zero decrease is accepted instead of max-merged"
        );

        let absent = req("usage", "cfg0", vec![item("a", 1, "x")]);
        run(&s, &absent, &spine());
        assert_eq!(
            s.load("usage")
                .unwrap()
                .meta
                .last_usage
                .unwrap()
                .current_total_input_tokens,
            50,
            "absent usage keeps the persisted value for restart continuity"
        );

        let mut zero = req("usage", "cfg0", vec![item("a", 1, "x")]);
        zero.usage = Some(ModuleUsage {
            current_total_input_tokens: 0,
            context_limit_tokens: 0,
        });
        run(&s, &zero, &spine());
        assert_eq!(
            s.load("usage")
                .unwrap()
                .meta
                .last_usage
                .unwrap()
                .current_total_input_tokens,
            50,
            "all-zero usage also falls back to persisted"
        );
    }

    #[test]
    fn response_shape_is_bare_ck_messages_and_reduced_tool_result_stays_paired() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let messages = vec![
            assistant_tool_call("call", 1, "call_0"),
            tool_result("result", 2, "call_0", "large output"),
        ];
        let r = run(
            &s,
            &req("shape", "cfg0", messages),
            &with_reductions(vec![reduce("result#0", "drop", "[dropped 12]")]),
        );
        let value = serde_json::to_value(&r).unwrap();
        assert!(value.get("coverage_ordinal").is_none());
        let ck_messages = value["ck_messages"].as_array().unwrap();
        assert!(ck_messages.iter().all(|m| m.get("mid").is_none()));
        assert!(ck_messages.iter().all(|m| m.get("ordinal").is_none()));
        assert_eq!(ck_messages[0]["role"], "user");
        assert_eq!(ck_messages[0]["meta"]["synthetic"], true);
        assert_eq!(ck_messages[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(ck_messages[1]["meta"]["synthetic"], true);
        let reduced_tool = ck_messages.last().unwrap();
        assert_eq!(reduced_tool["content"][0]["kind"]["type"], "tool_result");
        assert_eq!(
            reduced_tool["content"][0]["kind"]["output"]["kind"]["text"],
            "[dropped 12]"
        );
    }

    #[test]
    fn unreduced_golden_messages_are_passed_through_by_identity() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let ck: Vec<CkWireMessage> =
            serde_json::from_str(include_str!("../testdata/ck_wire_golden.json")).unwrap();
        let inbound = ingress_from_ck(ck);
        let r = run(&s, &req("identity", "cfg0", inbound.clone()), &spine());
        let tail: Vec<_> = r.messages().iter().filter(|m| !m.meta.synthetic).collect();
        assert_eq!(tail.len(), inbound.len());
        for (input, output) in inbound.iter().zip(tail) {
            assert_eq!(
                serde_json::to_vec(&input.ck).unwrap(),
                serde_json::to_vec(output).unwrap(),
                "unreduced mid {} must be returned by identity",
                input.mid
            );
        }
    }

    #[test]
    fn pure_passthrough_defer_round_trips_tail_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let ck: Vec<CkWireMessage> =
            serde_json::from_str(include_str!("../testdata/ck_wire_golden.json")).unwrap();
        let inbound = ingress_from_ck(ck);
        s.replace_compartments("roundtrip", &[comp(1, 1, 1, "m0", "SUMMARY")])
            .unwrap();
        run(&s, &req("roundtrip", "cfg0", inbound.clone()), &spine());
        let r = run(&s, &req("roundtrip", "cfg0", inbound.clone()), &spine());
        assert_eq!(r.action, "SOFT+");
        assert!(!r.committed);
        // This fixture starts with a covered system message. It should move out of the
        // live message list and replay from frozen m0 while the remaining live messages
        // keep their original bytes.
        assert!(r.messages()[0].meta.synthetic);
        assert_eq!(
            covered_system_entries(m0_bytes(&r)),
            vec![system_content_for_m0(&inbound[0].ck)]
        );
        let tail: Vec<_> = r.messages().iter().filter(|m| !m.meta.synthetic).collect();
        assert_eq!(tail.len(), inbound.len() - 1);
        for (input, output) in inbound.iter().skip(1).zip(tail) {
            assert_eq!(
                serde_json::to_vec(&input.ck).unwrap(),
                serde_json::to_vec(output).unwrap()
            );
        }
    }

    #[test]
    fn agent_drop_ids_freeze_add_only_through_flat_ids() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let request = active_cc_req("agent-drop", "cfg0", vec![item("a", 1, "drop me")]);
        s.append_pending_agent_drops("agent-drop", &["a#0".to_string()], 1)
            .unwrap();
        let r = run(&s, &request, &spine());
        assert_eq!(tail_bytes(&r, "a"), "[dropped]");
        assert!(s
            .load("agent-drop")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:a#0"));
        assert!(s.load_pending_agent_drops("agent-drop").unwrap().is_empty());
        let again = run(&s, &request, &spine());
        assert_eq!(again.action, "SOFT+");
        assert_eq!(tail_bytes(&again, "a"), "[dropped]");
        s.append_pending_agent_drops("agent-drop", &["a#0".to_string()], 2)
            .unwrap();
        let mut hard_request = request.clone();
        hard_request.render_config = "cfg1".to_string();
        let hard = run(&s, &hard_request, &spine());
        assert_eq!(hard.action, "HARD");
        assert_eq!(tail_bytes(&hard, "a"), "[dropped]");
        assert!(s.load_pending_agent_drops("agent-drop").unwrap().is_empty());
    }

    #[test]
    fn producer_gate_runs_on_execute_force_and_hard_advisory_never_plain_defer() {
        let ctx = smart_pctx();

        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let mut messages = vec![item("a", 1, "raw")];
        messages.extend(todowrite_arc("old", 2));
        messages.extend(todowrite_arc("new", 4));
        let defer = transform(
            &s,
            &with_usage(req("ses", "cfg0", messages.clone()), 10, 100),
            &ctx,
        )
        .unwrap();
        assert_eq!(defer.action, "SOFT+");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .all(|unit| !unit.key.starts_with("red:old")));

        let execute = transform(
            &s,
            &with_usage(req("ses", "cfg0", messages.clone()), 70, 100),
            &ctx,
        )
        .unwrap();
        assert_eq!(execute.action, "SOFT");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:old#0"));

        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let huge = "x".repeat(50_000);
        let force_messages = vec![
            item("a", 1, "raw"),
            assistant_tool_call("force_old", 2, "force_old_call"),
            tool_result("force_old_result", 3, "force_old_call", &huge),
            assistant_tool_call("force_new", 4, "force_new_call"),
            tool_result("force_new_result", 5, "force_new_call", &huge),
        ];
        let force = transform(
            &s,
            &with_usage(req("ses", "cfg0", force_messages), 90_000, 100_000),
            &ctx,
        )
        .unwrap();
        assert_eq!(force.action, "SOFT");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:force_old#0"));

        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let mut hard_messages = vec![item("a", 1, "raw")];
        hard_messages.extend(todowrite_arc("hard_old", 2));
        hard_messages.extend(todowrite_arc("hard_new", 4));
        let hard = transform(
            &s,
            &with_usage(req("ses", "cfg1", hard_messages), 10, 100),
            &ctx,
        )
        .unwrap();
        assert_eq!(hard.action, "HARD");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:hard_old#0"));
    }

    #[test]
    fn coverage_filtered_pool_never_selects_covered_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let ctx = smart_pctx();
        let mut messages = todowrite_arc("a", 1);
        s.replace_compartments("ses", &[comp(1, 1, 2, "a_result", "SUMMARY")])
            .unwrap();
        let boot = transform(&s, &req("ses", "cfg0", messages.clone()), &ctx).unwrap();
        assert_eq!(boot.action, "HARD");
        messages.extend(todowrite_arc("tail_old", 3));
        messages.extend(todowrite_arc("tail_new", 5));
        let response =
            transform(&s, &with_usage(req("ses", "cfg0", messages), 70, 100), &ctx).unwrap();
        assert_eq!(response.action, "SOFT");
        let loaded = s.load("ses").unwrap();
        assert!(loaded
            .core
            .frozen_units
            .iter()
            .all(|unit| unit.key != "red:a#0"));
        assert!(loaded
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:tail_old#0"));
    }

    #[test]
    fn provider_executed_open_arc_does_not_defer_execute_selection() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let mut ctx = smart_pctx();
        ctx.observed_last_response_at_ms = Some(1);
        let mut messages = vec![item("a", 1, "raw")];
        messages.extend(todowrite_arc("old", 2));
        messages.extend(todowrite_arc("new", 4));
        messages.push(CkIngressMessage {
            mid: "server_tool".to_string(),
            ordinal: 6,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolCall {
                    id: "server_call".to_string(),
                    name: "web_search".to_string(),
                    input: json!({}),
                    provider_executed: true,
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some("server_tool".to_string()),
                    ..Default::default()
                },
            ),
        });
        let response =
            transform(&s, &with_usage(req("ses", "cfg0", messages), 70, 100), &ctx).unwrap();
        assert_eq!(response.action, "SOFT");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:old#0"));
    }

    #[test]
    fn ttl_hard_requires_in_process_observation_not_durable_anchor_alone() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let mut loaded = s.load("ses").unwrap();
        loaded.meta.last_committed_pass_at_ms = 1;
        s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();

        let mut ctx = pctx("git:proj", "/nonexistent-docs", 10 * 60 * 1000);
        ctx.cache_ttl = "5m".to_string();
        ctx.observed_last_response_at_ms = None;
        let no_observation =
            transform(&s, &req("ses", "cfg0", vec![item("a", 1, "raw")]), &ctx).unwrap();
        assert_eq!(no_observation.action, "SOFT+");
        assert!(!no_observation.committed);

        ctx.observed_last_response_at_ms = Some(1);
        let observed = transform(&s, &req("ses", "cfg0", vec![item("a", 1, "raw")]), &ctx).unwrap();
        assert_eq!(observed.action, "HARD");
    }

    #[test]
    fn reconcile_pending_ignores_legacy_reclaim_watermark() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let loaded = s.load("ses").unwrap();
        let mut core = loaded.core.clone();
        let mut meta = loaded.meta.clone();
        core.boundary_id = "missing#0".to_string();
        core.reconcile_pending = true;
        meta.last_execute_ordinal = 99;
        s.commit("ses", loaded.row_version, &core, &meta).unwrap();

        let messages = vec![
            item("a", 1, "raw"),
            assistant_tool_call("old", 2, "old_call"),
            tool_result("old_result", 3, "old_call", "old output"),
        ];
        let response = transform(
            &s,
            &with_usage(req("ses", "cfg0", messages), 70, 100),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap();
        assert_eq!(response.action, "HARD");
        assert!(s
            .load("ses")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .all(|unit| unit.key != "red:old#0"));
    }

    #[test]
    fn execute_with_zero_delta_is_defer_shaped_and_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let boot_req = with_usage(req("ses", "cfg0", vec![item("a", 1, "raw")]), 90, 100);
        let boot = run(&s, &boot_req, &spine());
        assert_eq!(boot.action, "HARD");
        let before = serde_json::to_vec(&boot.ck_messages).unwrap();
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.observed_last_response_at_ms = Some(0);
        let execute = transform(&s, &boot_req, &ctx).unwrap();
        // A zero-drop execute is byte-identical and does not revive the retired
        // positional reclaim watermark.
        assert_eq!(execute.action, "SOFT+");
        assert_eq!(serde_json::to_vec(&execute.ck_messages).unwrap(), before);
        let meta = s.load("ses").unwrap().meta;
        assert_eq!(meta.last_execute_ordinal, 0);
        // And the pass after it, with an unchanged tail, is a true no-write defer.
        let again = transform(&s, &boot_req, &ctx).unwrap();
        assert!(!again.committed);
        assert_eq!(serde_json::to_vec(&again.ck_messages).unwrap(), before);
    }

    #[test]
    fn legacy_reclaim_watermark_never_ages_arcs_into_a_later_execute() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // Seed one compartment covering ordinal 1 and fold it, then persist a
        // pre-removal watermark to model an upgraded session.
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let msgs = vec![
            item("a", 1, "covered head"),
            assistant_tool_call("m1", 2, "call_age"),
            tool_result("m2", 3, "call_age", "big tool output payload"),
            item("m9", 9, "newest user text"),
        ];
        let boot = run(&s, &req("ses", "cfg0", msgs.clone()), &spine());
        assert_eq!(boot.action, "HARD");
        let loaded = s.load("ses").unwrap();
        let mut meta = loaded.meta.clone();
        meta.last_execute_ordinal = 9;
        s.commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();

        // 70% usage is execute-class. Neither this pass nor the next may select
        // an unrequested tool from the inert legacy watermark.
        let exec_req = with_usage(req("ses", "cfg0", msgs.clone()), 70, 100);
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.observed_last_response_at_ms = Some(0);
        let _ = transform(&s, &exec_req, &ctx).unwrap();
        let after_first = s.load("ses").unwrap();
        assert!(
            after_first
                .core
                .frozen_units
                .iter()
                .all(|unit| !unit.key.starts_with("red:m1#") && !unit.key.starts_with("red:m2#")),
            "execute must not synthesize an unrequested drop"
        );
        assert_eq!(after_first.meta.last_execute_ordinal, 9);
        let _ = transform(&s, &exec_req, &ctx).unwrap();
        let after_second = s.load("ses").unwrap();
        assert!(
            after_second
                .core
                .frozen_units
                .iter()
                .all(|unit| !unit.key.starts_with("red:m1#") && !unit.key.starts_with("red:m2#")),
            "later execute must still preserve the unrequested tool"
        );
        assert_eq!(after_second.meta.last_execute_ordinal, 9);
    }

    #[test]
    fn pure_defer_with_scheduler_fields_present_keeps_row_version_stable() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let mut loaded = s.load("ses").unwrap();
        loaded.meta.deferred_execute_state = None;
        loaded.meta.emergency_drain_active = false;
        loaded.meta.emergency_drain_entered_at_ms = 0;
        loaded.meta.last_execute_ordinal = 2;
        loaded.meta.has_prior_emergency_drop = true;
        loaded.meta.last_emergency_input_sample = 50.0;
        s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        let row_before = s.load("ses").unwrap().row_version.unwrap();
        let response = transform(
            &s,
            &req("ses", "cfg0", vec![item("a", 1, "raw")]),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap();
        assert_eq!(response.action, "SOFT+");
        assert!(!response.committed);
        assert_eq!(s.load("ses").unwrap().row_version.unwrap(), row_before);
    }

    #[test]
    fn transform_request_parses_full_flat_wire_envelope() {
        let value = json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "owned-llmrunner",
            "session_id": "ses",
            "render_config": "cfg",
            "full_array_fingerprint": "fp-full-array",
            "messages": [{ "mid": "m", "ordinal": 7, "ck": text_message("m", "hello") }],
            "usage": { "current_total_input_tokens": 1, "context_limit_tokens": 2 },
            "history_budget_tokens": 42_000.0,
            "provider_error": "prompt is too long"
        });
        let parsed: TransformRequest = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.kind, "transform");
        assert_eq!(parsed.v, 2);
        assert_eq!(parsed.serializer_profile, "owned-llmrunner");
        assert_eq!(
            parsed.full_array_fingerprint.as_deref(),
            Some("fp-full-array")
        );
        assert_eq!(parsed.messages[0].mid, "m");
        assert_eq!(parsed.usage.unwrap().context_limit_tokens, 2);
        assert_eq!(parsed.history_budget_tokens, Some(42_000.0));
        assert_eq!(parsed.provider_error.as_deref(), Some("prompt is too long"));
    }

    #[test]
    fn transform_request_legacy_items_shim_parses_with_v2_profile() {
        let value = json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "owned-llmrunner",
            "session_id": "ses",
            "render_config": "cfg",
            "items": [{ "id": "legacy", "ordinal": 3, "bytes": "hello" }]
        });
        let parsed: TransformRequest = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.messages[0].mid, "legacy");
        assert_eq!(parsed.messages[0].ordinal, 3);
        assert_eq!(
            ck_wire::text_from_message(&parsed.messages[0].ck),
            Some("hello")
        );
        assert_eq!(parsed.serializer_profile, "owned-llmrunner");
    }

    #[test]
    fn v2_defer_replays_ck_messages_byte_identically_and_echoes_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = req("v2-defer", "cfg0", vec![item("a", 1, "raw")]);
        request.full_array_fingerprint = Some("fp-v2-defer".to_string());

        let first = run(&s, &request, &spine());
        let second = run(&s, &request, &spine());

        assert_eq!(first.status, TransformStatus::Ok);
        assert_eq!(first.served_from, ServedFrom::Transform);
        assert_eq!(first.full_array_fingerprint.as_deref(), Some("fp-v2-defer"));
        assert_eq!(second.action, "SOFT+");
        assert_eq!(
            second.full_array_fingerprint.as_deref(),
            Some("fp-v2-defer")
        );
        assert_eq!(
            serde_json::to_vec(&first.ck_messages).unwrap(),
            serde_json::to_vec(&second.ck_messages).unwrap(),
            "defer replay must keep the CK array byte-identical"
        );
    }

    #[test]
    fn reasoning_strip_residual_is_profile_gated_by_merge_coverage() {
        fn assistant(mid: &str, reasoning: &str, text: &str) -> CkWireMessage {
            CkWireMessage::from_parts(
                "assistant",
                vec![
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                        text: reasoning.to_string(),
                        signature: Some(format!("sig-{mid}")),
                    }),
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                        text: text.to_string(),
                    }),
                ],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            )
        }

        let base = vec![
            assistant("a1", "keep-first", "answer one"),
            assistant("a2", "strip-second", "answer two"),
        ];
        for profile in [
            SerializerProfile::OwnedLlmRunner,
            SerializerProfile::Pi,
            SerializerProfile::ClaudeCodeAnthropic,
        ] {
            let mut messages = base.clone();
            assert_eq!(apply_serializer_residuals(profile, &mut messages), 0);
            assert!(matches!(
                &messages[1].content[0].kind,
                ck_wire::CkKind::Reasoning { .. }
            ));
        }

        assert!(
            crate::healing::coverage(SerializerProfile::OpencodeAiSdk)
                .merges_consecutive_assistants
        );
        let mut messages = base;
        assert_eq!(
            apply_serializer_residuals(SerializerProfile::OpencodeAiSdk, &mut messages),
            1
        );
        assert!(matches!(
            &messages[0].content[0].kind,
            ck_wire::CkKind::Reasoning { .. }
        ));
        assert!(matches!(
            &messages[1].content[0].kind,
            ck_wire::CkKind::Text { text } if text.is_empty()
        ));
    }

    #[test]
    fn text_before_latest_reasoning_matches_ts_wire_shape() {
        let assistant = CkWireMessage::from_parts(
            "assistant",
            vec![
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::Opaque(ck_wire::OpaqueBlock {
                    source: serde_json::json!({"harness": "opencode"}),
                    kind: "step-start".to_string(),
                    raw: serde_json::json!({"type": "step-start"}),
                    arc: None,
                })),
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                    text: "§18240§ answer".to_string(),
                }),
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                    text: "signed thinking".to_string(),
                    signature: Some("sig".to_string()),
                }),
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolCall {
                    id: "call-1".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                    provider_executed: false,
                }),
            ],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some("msg_text_first".to_string()),
                ..Default::default()
            },
        );
        let ingress = vec![CkIngressMessage {
            mid: "msg_text_first".to_string(),
            ordinal: 1,
            ck: assistant.clone(),
        }];

        assert_eq!(
            latest_assistant_mutation_exempt_mid(
                &ingress,
                Some(SerializerProfile::OpencodeAiSdk),
                false,
            ),
            None
        );

        let mut served = vec![assistant];
        assert_eq!(
            apply_serializer_residuals(SerializerProfile::OpencodeAiSdk, &mut served),
            1
        );
        assert!(matches!(
            &served[0].content[1].kind,
            ck_wire::CkKind::Text { text } if text == "§18240§ answer"
        ));
        assert!(matches!(
            &served[0].content[2].kind,
            ck_wire::CkKind::Text { text } if text.is_empty()
        ));
    }

    #[test]
    fn latest_assistant_reasoning_is_exempt_from_opencode_healing() {
        fn assistant(mid: &str, reasoning: &str, text: &str) -> CkWireMessage {
            CkWireMessage::from_parts(
                "assistant",
                vec![
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                        text: reasoning.to_string(),
                        signature: Some(format!("sig-{mid}")),
                    }),
                    ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                        text: text.to_string(),
                    }),
                ],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            )
        }

        let base = vec![
            assistant("older", "older thinking", "older answer"),
            assistant("latest", "latest thinking", "latest answer"),
        ];
        let mut fail_first = base.clone();
        assert_eq!(
            apply_serializer_residuals(SerializerProfile::OpencodeAiSdk, &mut fail_first),
            1
        );
        assert_ne!(
            serde_json::to_vec(&fail_first[1]).unwrap(),
            serde_json::to_vec(&base[1]).unwrap(),
            "the consecutive-assistant residual mutates the latest reasoning block"
        );

        let mut served = base.clone();
        assert_eq!(
            apply_serializer_residuals_with_exemption(
                SerializerProfile::OpencodeAiSdk,
                &mut served,
                Some("latest"),
            ),
            1
        );
        assert!(matches!(
            &served[1].content[0].kind,
            ck_wire::CkKind::Text { text } if text.is_empty()
        ));

        let standalone = vec![
            assistant("older", "older thinking", "older answer"),
            CkWireMessage::from_parts(
                "user",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                    text: "new turn".to_string(),
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta::default(),
            ),
            assistant("latest", "latest thinking", "latest answer"),
        ];
        let mut standalone_served = standalone.clone();
        assert_eq!(
            apply_serializer_residuals_with_exemption(
                SerializerProfile::OpencodeAiSdk,
                &mut standalone_served,
                Some("latest"),
            ),
            0
        );
        assert_eq!(
            serde_json::to_vec(&standalone_served[2]).unwrap(),
            serde_json::to_vec(&standalone[2]).unwrap(),
            "a standalone latest assistant still uses the ingress exemption"
        );

        let ingress = base
            .iter()
            .enumerate()
            .map(|(index, ck)| CkIngressMessage {
                mid: ck.meta.harness_id.clone().unwrap(),
                ordinal: index as u64 + 1,
                ck: ck.clone(),
            })
            .collect::<Vec<_>>();
        let request = profile_req(
            SerializerProfile::OpencodeAiSdk,
            "latest-assistant-output",
            "cfg0",
            ingress,
        );
        let projection = project_messages(&request.messages).unwrap();
        let mut overlay = TagOverlayState::default();
        overlay.tag_by_block_id.insert("latest#1".to_string(), 7);
        let core = CoreState::default();
        let meta = ModuleMeta::default();
        let unprotected = build_output(
            &core,
            &meta,
            &projection,
            &request,
            Some(&overlay),
            false,
            None,
        )
        .unwrap();
        assert_ne!(
            serde_json::to_vec(&unprotected[1]).unwrap(),
            serde_json::to_vec(&request.messages[1].ck).unwrap(),
            "the overlay and healing fixture must differ before the exemption"
        );
        let protected = build_output(
            &core,
            &meta,
            &projection,
            &request,
            Some(&overlay),
            false,
            Some("latest"),
        )
        .unwrap();
        assert!(matches!(
            &protected[1].content[0].kind,
            ck_wire::CkKind::Text { text } if text.is_empty()
        ));
        assert_ne!(
            serde_json::to_vec(&protected[1]).unwrap(),
            serde_json::to_vec(&request.messages[1].ck).unwrap(),
            "a merged latest assistant must follow the serializer healing rule"
        );
    }

    #[test]
    fn opencode_d2_watermark_persists_and_defer_does_not_recompute_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let assistant = CkWireMessage::from_parts(
            "assistant",
            vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: "old thinking".to_string(),
                signature: Some("old signature".to_string()),
            })],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some("assistant".to_string()),
                ..Default::default()
            },
        );
        let user = CkWireMessage::from_parts(
            "user",
            vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: "new prompt".to_string(),
            })],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some("user".to_string()),
                ..Default::default()
            },
        );
        let mut request = req(
            "d2-watermark",
            "cfg0",
            vec![
                CkIngressMessage {
                    mid: "assistant".to_string(),
                    ordinal: 1,
                    ck: assistant,
                },
                CkIngressMessage {
                    mid: "user".to_string(),
                    ordinal: 10,
                    ck: user,
                },
            ],
        );
        request.serializer_profile = SerializerProfile::OpencodeAiSdk.wire_id().to_string();
        request.provider_id = Some("anthropic".to_string());
        request.serve_native = true;
        request.clear_reasoning_age = 5;

        let first = transform(&store, &request, &pctx("git:proj", "/nonexistent-docs", 0)).unwrap();
        assert_eq!(
            store
                .load("d2-watermark")
                .unwrap()
                .meta
                .reasoning_cleared_through_ordinal,
            5
        );
        assert!(first.committed);

        let second =
            transform(&store, &request, &pctx("git:proj", "/nonexistent-docs", 0)).unwrap();
        assert_eq!(second.action, "SOFT+");
        assert_eq!(
            store
                .load("d2-watermark")
                .unwrap()
                .meta
                .reasoning_cleared_through_ordinal,
            5,
            "defer must replay a persisted boundary instead of moving it"
        );
        assert!(!second.committed);
    }

    #[test]
    fn opencode_d2_clears_historical_reasoning_after_codec_and_replays_stably() {
        fn assistant(mid: &str) -> CkWireMessage {
            CkWireMessage::from_parts(
                "assistant",
                vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                    text: format!("thinking-{mid}"),
                    signature: Some(format!("signature-{mid}")),
                })],
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            )
        }

        let old = assistant("old");
        let latest = assistant("latest");
        let served = vec![old.clone(), latest.clone()];
        let ingress = vec![
            CkIngressMessage {
                mid: "old".to_string(),
                ordinal: 1,
                ck: old,
            },
            CkIngressMessage {
                mid: "latest".to_string(),
                ordinal: 60,
                ck: latest,
            },
        ];
        let mut native = vec![
            json!({
                "info": { "id": "old", "role": "assistant" },
                "parts": [{
                    "type": "reasoning",
                    "text": "thinking-old",
                    "metadata": { "signature": "signature-old" }
                }]
            }),
            json!({
                "info": { "id": "latest", "role": "assistant" },
                "parts": [{
                    "type": "reasoning",
                    "text": "thinking-latest",
                    "metadata": { "signature": "signature-latest" }
                }]
            }),
        ];

        assert_eq!(
            clear_served_native_reasoning(
                SerializerProfile::OpencodeAiSdk,
                true,
                &mut native,
                &served,
                &ingress,
                60,
                false,
            ),
            2,
            "a completed historical latest assistant is still age-eligible"
        );
        assert_eq!(
            native[0]["parts"][0],
            json!({ "type": "reasoning", "text": "" })
        );
        assert_eq!(
            native[1]["parts"][0],
            json!({ "type": "reasoning", "text": "" })
        );
        let first_pass = native.clone();
        assert_eq!(
            clear_served_native_reasoning(
                SerializerProfile::OpencodeAiSdk,
                true,
                &mut native,
                &served,
                &ingress,
                60,
                false,
            ),
            0
        );
        assert_eq!(native, first_pass, "defer replay must be byte-stable");

        let mut in_flight = vec![
            json!({
                "info": { "id": "old", "role": "assistant" },
                "parts": [{ "type": "reasoning", "text": "thinking-old" }]
            }),
            json!({
                "info": { "id": "latest", "role": "assistant" },
                "parts": [{ "type": "reasoning", "text": "thinking-latest" }]
            }),
        ];
        assert_eq!(
            clear_served_native_reasoning(
                SerializerProfile::OpencodeAiSdk,
                true,
                &mut in_flight,
                &served,
                &ingress,
                60,
                true,
            ),
            1
        );
        assert_eq!(in_flight[0]["parts"][0]["text"], "");
        assert_eq!(in_flight[1]["parts"][0]["text"], "thinking-latest");
    }

    #[test]
    fn reasoning_clearing_is_not_applicable_to_claude_or_owned_broca() {
        let message = CkWireMessage::from_parts(
            "assistant",
            vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: "signed thinking".to_string(),
                signature: Some("signature".to_string()),
            })],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some("assistant".to_string()),
                ..Default::default()
            },
        );
        let ingress = vec![CkIngressMessage {
            mid: "assistant".to_string(),
            ordinal: 1,
            ck: message.clone(),
        }];
        for profile in [
            SerializerProfile::ClaudeCodeAnthropic,
            SerializerProfile::OwnedBroca,
        ] {
            let mut native = vec![json!({
                "info": { "id": "assistant", "role": "assistant" },
                "parts": [{
                    "type": "reasoning",
                    "text": "signed thinking",
                    "metadata": { "signature": "signature" }
                }]
            })];
            assert_eq!(
                clear_served_native_reasoning(
                    profile,
                    false,
                    &mut native,
                    std::slice::from_ref(&message),
                    &ingress,
                    1,
                    false,
                ),
                0
            );
            assert_eq!(
                native[0]["parts"][0]["type"], "reasoning",
                "{profile:?} keeps verbatim-tail reasoning"
            );
        }
    }

    #[test]
    fn beat_five_replay_tail_strips_reasoning_from_merged_latest_assistant() {
        fn message(mid: &str, role: &str, reasoning: Option<&str>) -> CkWireMessage {
            let mut content = Vec::new();
            if let Some(text) = reasoning {
                content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                    text: text.to_string(),
                    signature: Some(format!("sig-{mid}")),
                }));
            }
            content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolCall {
                id: format!("call-{mid}"),
                name: "read".to_string(),
                input: serde_json::json!({}),
                provider_executed: false,
            }));
            content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::ToolResult {
                id: format!("call-{mid}"),
                tool_name: "read".to_string(),
                output: ck_wire::CkToolOutput::bare(ck_wire::CkOutputKind::Text {
                    text: "ok".to_string(),
                }),
                provider_executed: false,
            }));
            CkWireMessage::from_parts(
                role,
                content,
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            )
        }

        let mut served = (0..60)
            .map(|index| message(&format!("prefix-{index}"), "user", None))
            .collect::<Vec<_>>();
        served.push(message("tail-user", "user", None));
        served.push(message("tail-61", "assistant", Some("first")));
        served.push(message("tail-62", "assistant", Some("second")));
        served.push(message("tail-63", "assistant", Some("third")));
        served.push(message("tail-64", "assistant", Some("fourth")));
        served.push(message("tail-65", "assistant", Some("fifth")));
        served.push(message("tail-66", "assistant", Some("latest")));

        assert_eq!(served.len(), 67);
        assert_eq!(
            apply_serializer_residuals_with_exemption(
                SerializerProfile::OpencodeAiSdk,
                &mut served,
                Some("tail-66"),
            ),
            5
        );
        assert!(matches!(
            &served[61].content[0].kind,
            ck_wire::CkKind::Reasoning { .. }
        ));
        for message in &served[62..] {
            assert!(matches!(
                &message.content[0].kind,
                ck_wire::CkKind::Text { text } if text.is_empty()
            ));
        }
    }

    #[test]
    fn reasoning_strip_ignores_opencode_step_metadata_before_thinking() {
        let mut messages = vec![CkWireMessage::from_parts(
            "assistant",
            vec![
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::Opaque(ck_wire::OpaqueBlock {
                    source: serde_json::json!({"harness": "opencode"}),
                    kind: "step-start".to_string(),
                    raw: serde_json::json!({"type": "step-start"}),
                    arc: None,
                })),
                ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                    text: "signed thinking".to_string(),
                    signature: Some("sig".to_string()),
                }),
            ],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta {
                harness_id: Some("metadata-latest".to_string()),
                ..Default::default()
            },
        )];

        assert_eq!(
            apply_serializer_residuals_with_exemption(
                SerializerProfile::OpencodeAiSdk,
                &mut messages,
                None,
            ),
            0
        );
        assert!(matches!(
            &messages[0].content[1].kind,
            ck_wire::CkKind::Reasoning { .. }
        ));
    }

    // ===== Module-integration tests: STORE STATE in → compose+core bytes out.
    // The cache MECHANICS (defer-replay, the SOFT/HARD taxonomy, reduction freeze/replay)
    // are owned by cortexkit-cache-core's golden vectors + the live-daemon harness; these
    // tests prove the MC module's job: resolve → compose-from-store → wire-to-core. m0 is
    // a compartment SUMMARY composed from the store (NOT live bytes), so "cover ordinal N"
    // means a store compartment covering N, and the raw boundary message stays in the live
    // input (only absent from the OUTPUT tail). =====

    #[test]
    fn bootstrap_with_no_compartments_is_empty_baseline_whole_array_is_tail() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // no compartments → nothing summarized → empty boundary, the live array is all tail
        let r = run(
            &s,
            &req("ses", "cfg0", vec![item("a", 1, "<h>BASE</h>")]),
            &spine(),
        );
        assert_eq!(r.action, "HARD", "first pass materializes a baseline");
        assert_eq!(r.boundary_id, "", "no compartment → no coverage anchor");
        // m0 is the empty-history placeholder baseline (no docs/memories seeded)
        assert!(
            m0_bytes(&r).contains("<session-history></session-history>"),
            "{}",
            m0_bytes(&r)
        );
        assert_eq!(m1_bytes(&r), M1_PLACEHOLDER);
        assert_eq!(tail_ids(&r), vec!["a"], "uncovered live item is the tail");
        assert!(r.committed);
    }

    #[test]
    fn empty_store_bootstrap_then_defers_stably_without_hard_oscillation() {
        // A session with no compartments keeps boundary_id = "" for its whole
        // pre-first-compartment life. That empty id is the "no boundary ever minted"
        // sentinel, NOT a "boundary reverted away" signal, so repeated identical passes
        // after the bootstrap HARD must stay pure defers — never oscillate back into a
        // HARD by treating the vacuous boundary as reconcile-pending. (The bytes stay
        // identical either way, so this guards telemetry honesty + write churn, not a
        // prefix-cache bust.)
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let items = vec![item("a", 1, "<h>HELLO</h>"), item("b", 2, "world")];
        let first = run(&s, &req("ses", "cfg0", items.clone()), &spine());
        assert_eq!(first.action, "HARD", "first pass is the bootstrap HARD");
        let m0 = m0_bytes(&first).to_string();
        let m1 = m1_bytes(&first).to_string();

        for _ in 0..4 {
            let r = run(&s, &req("ses", "cfg0", items.clone()), &spine());
            assert_eq!(
                r.action, "SOFT+",
                "an unseeded-store defer must not oscillate back into a HARD"
            );
            assert_eq!(
                m0_bytes(&r),
                m0,
                "m0 must stay byte-identical across defers"
            );
            assert_eq!(
                m1_bytes(&r),
                m1,
                "m1 must stay byte-identical across defers"
            );
            assert_eq!(tail_ids(&r), vec!["a", "b"]);
        }
    }

    #[test]
    fn first_compartment_published_after_empty_bootstrap_hard_folds_and_mints_boundary() {
        // The production historian arc: a fresh session bootstraps EMPTY (boundary_id "" —
        // never minted), runs turns, THEN the historian publishes the session's FIRST
        // compartment mid-session. That publish cannot ride m1 as a SOFT delta (a SOFT delta
        // needs the boundary present so the compartment can splice onto it, and none exists
        // yet), so without the first-fold HARD trigger it would strand on defer forever. It
        // must instead HARD-fold and MINT the first boundary.
        //
        // The first compartment is at SEQUENCE 0 on purpose: max_compartment_seq COALESCEs a
        // missing MAX to 0 and folded_compartment_seq defaults to 0, so a seq-comparison
        // trigger (max > folded) reads 0 > 0 = false and silently misses exactly this case.
        // The presence-based guard (empty boundary + a compartment exists) catches it.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());

        // Pass 1: empty store, two live turns → bootstrap HARD, empty boundary, all tail.
        let live1 = vec![item("a", 1, "<h>first</h>"), item("t2", 2, "turn two")];
        let boot = run(&s, &req("ses", "cfg0", live1.clone()), &spine());
        assert_eq!(boot.action, "HARD", "bootstrap HARD");
        assert_eq!(boot.boundary_id, "", "boundary never minted yet");
        assert_eq!(tail_ids(&boot), vec!["a", "t2"]);

        // A defer before publish stays a pure defer (the empty-boundary no-oscillation path).
        let pre = run(&s, &req("ses", "cfg0", live1.clone()), &spine());
        assert_eq!(pre.action, "SOFT+", "no compartment yet → pure defer");

        // The historian publishes the FIRST compartment at SEQUENCE 0, covering ordinal 1
        // (raw message "a"). Same live array — "a" is still the raw covered message.
        s.replace_compartments("ses", &[comp(0, 1, 1, "a", "S0-FIRST")])
            .unwrap();
        let fold = run(&s, &req("ses", "cfg0", live1.clone()), &spine());
        assert_eq!(
            fold.action, "HARD",
            "first compartment after an empty bootstrap must HARD-fold, not strand on defer"
        );
        assert_eq!(
            fold.boundary_id, "a#0",
            "the fold MINTED the first boundary"
        );
        assert!(
            m0_bytes(&fold).contains("S0-FIRST"),
            "m0 now carries the folded summary: {}",
            m0_bytes(&fold)
        );
        assert_eq!(
            tail_ids(&fold),
            vec!["t2"],
            "covered ordinal 1 trimmed from tail"
        );

        // ONE-SHOT: with the boundary now minted, a defer stays a pure defer (NOT a repeated
        // HARD) — the guard is self-limiting.
        let defer = run(&s, &req("ses", "cfg0", live1), &spine());
        assert_eq!(
            defer.action, "SOFT+",
            "post-fold the boundary is present → defer, never a repeated first-fold HARD"
        );
        assert!(!defer.committed, "a settled defer does not write");

        // ONE-SHOT continued: a SECOND compartment publishes → it RIDES m1 as a SOFT delta
        // (valid now that the boundary exists to splice onto), NOT another first-fold HARD.
        s.replace_compartments(
            "ses",
            &[
                comp(0, 1, 1, "a", "S0-FIRST"),
                comp(1, 2, 2, "t2", "S1-SECOND"),
            ],
        )
        .unwrap();
        let second = run(
            &s,
            &req(
                "ses",
                "cfg0",
                vec![
                    item("a", 1, "<h>first</h>"),
                    item("t2", 2, "turn two"),
                    item("t3", 3, "turn three"),
                ],
            ),
            &spine(),
        );
        assert_eq!(
            second.action, "SOFT",
            "a subsequent publish rides m1 SOFT — the first-fold HARD fires exactly once"
        );
        assert_eq!(second.boundary_id, "t2#0", "the SOFT advanced the anchor");
        assert!(
            m1_bytes(&second).contains("S1-SECOND"),
            "{}",
            m1_bytes(&second)
        );
    }

    #[test]
    fn fold_minting_wrong_vocabulary_anchor_fails_loud_instead_of_looping() {
        // A compartment whose end_message_id is a BARE message id ("m1") instead of the
        // flat block id ("m1#0"). Presence checks live flat block ids, so a fold that
        // mints the bare id produces an anchor that can NEVER be present: the next pass
        // reads boundary-absent, sets reconcile, HARDs, re-mints the same bare id — an
        // unbounded phantom-HARD loop (each HARD byte-identical, so it is invisible to
        // the provider cache but burns a version bump + full recompose every pass). The
        // guard must fail the MINTING pass loudly instead.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "ses",
            &[StoredCompartment {
                sequence: 0,
                start_message: 1,
                end_message: 1,
                end_message_id: "m1".to_string(), // bare mid — wrong vocabulary
                title: "C0".to_string(),
                content: "S".to_string(),
                p1: Some("S".to_string()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let live = vec![item("m1", 1, "raw"), item("t2", 2, "tail")];
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let err = transform(&s, &req("ses", "cfg0", live.clone()), &ctx);
        match err {
            Err(TransformError::BoundaryNotPresent(_)) => {}
            other => panic!("expected BoundaryNotPresent, got {other:?}"),
        }
        // Nothing committed → the error stays visible on retry, never a silent loop.
        let retry = transform(&s, &req("ses", "cfg0", live), &ctx);
        assert!(matches!(retry, Err(TransformError::BoundaryNotPresent(_))));
    }

    #[test]
    fn fold_minting_empty_anchor_with_coverage_fails_loud() {
        // An empty end_message_id with real coverage would mint boundary_id="" — the
        // reserved no-boundary sentinel — while compartments exist. The first-fold
        // trigger (empty boundary + compartments present) would then re-fire a HARD on
        // every pass forever. The guard catches the empty mint at the source.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "ses",
            &[StoredCompartment {
                sequence: 0,
                start_message: 1,
                end_message: 1,
                end_message_id: String::new(), // empty — never presentable
                title: "C0".to_string(),
                content: "S".to_string(),
                p1: Some("S".to_string()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let live = vec![item("m1", 1, "raw")];
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let err = transform(&s, &req("ses", "cfg0", live), &ctx);
        assert!(matches!(err, Err(TransformError::BoundaryNotPresent(_))));
    }

    #[test]
    fn coverage_extending_soft_minting_absent_anchor_fails_loud() {
        // Same invariant on the OTHER mint site: a second compartment publishing with a
        // wrong-vocabulary end_message_id rides a coverage-extending SOFT — the advanced
        // anchor must exist in the live array or the session decays into the same
        // reconcile-HARD loop one pass later.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // Healthy first fold (flat vocabulary).
        s.replace_compartments("ses", &[comp(0, 1, 1, "a", "S0")])
            .unwrap();
        let live = vec![item("a", 1, "raw"), item("t2", 2, "turn two")];
        let boot = run(&s, &req("ses", "cfg0", live.clone()), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "a#0");

        // Second compartment publishes with a BARE end_message_id → the SOFT advance
        // must fail loud, not mint an unpresentable anchor.
        s.replace_compartments(
            "ses",
            &[
                comp(0, 1, 1, "a", "S0"),
                StoredCompartment {
                    sequence: 1,
                    start_message: 2,
                    end_message: 2,
                    end_message_id: "t2".to_string(), // bare mid — wrong vocabulary
                    title: "C1".to_string(),
                    content: "S1".to_string(),
                    p1: Some("S1".to_string()),
                    importance: 50,
                    ..Default::default()
                },
            ],
        )
        .unwrap();
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let err = transform(&s, &req("ses", "cfg0", live), &ctx);
        assert!(matches!(err, Err(TransformError::BoundaryNotPresent(_))));
    }

    #[test]
    fn reconcile_rematerialize_after_revert_is_not_blocked_by_the_mint_guard() {
        // A reconcile-rematerialize composes from the RE-CUT store (the historian re-cuts
        // compartments after a revert), so its minted anchor is presentable again and the
        // mint guard must not false-fire. Here the re-cut store keeps a compartment whose
        // anchor IS present in the post-revert live array (partial revert: the covered
        // head survived, only the tail past it reverted).
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "ses",
            &[comp(0, 1, 1, "a", "S0"), comp(1, 2, 2, "t2", "S1")],
        )
        .unwrap();
        let live_full = vec![
            item("a", 1, "raw"),
            item("t2", 2, "turn two"),
            item("t3", 3, "tail"),
        ];
        let boot = run(&s, &req("ses", "cfg0", live_full), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "t2#0");

        // Revert removes t2 (the boundary) and t3; the historian re-cuts to just C0.
        let live_reverted = vec![item("a", 1, "raw"), item("t4", 2, "new turn")];
        let revert = run(&s, &req("ses", "cfg0", live_reverted.clone()), &spine());
        assert_eq!(revert.action, "SOFT+", "revert never busts on sight");
        assert!(revert.reconcile_pending);

        s.replace_compartments("ses", &[comp(0, 1, 1, "a", "S0")])
            .unwrap();
        let remat = run(&s, &req("ses", "cfg0", live_reverted), &spine());
        assert_eq!(
            remat.action, "HARD",
            "reconcile rematerializes without tripping the mint guard"
        );
        assert_eq!(remat.boundary_id, "a#0", "re-minted from the re-cut store");
        assert!(!remat.reconcile_pending);
        assert_eq!(tail_ids(&remat), vec!["t4"]);
    }

    #[test]
    fn reconcile_rematerialize_with_unrecut_store_truncates_and_refolds_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 1, "a", "S0"), comp(2, 2, 2, "t2", "S1")],
        )
        .unwrap();
        let live_full = vec![
            item("a", 1, "raw"),
            item("t2", 2, "turn two"),
            item("t3", 3, "tail"),
        ];
        let boot = run(&s, &req("ses", "cfg0", live_full), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "t2#0");

        let live_reverted = vec![item("a", 1, "raw"), item("t4", 2, "new turn")];
        let revert = run(&s, &req("ses", "cfg0", live_reverted.clone()), &spine());
        assert_eq!(revert.action, "SOFT+", "revert never busts on sight");
        assert!(revert.reconcile_pending);
        let loaded = s.load("ses").unwrap();
        let mut meta = loaded.meta.clone();
        meta.last_execute_ordinal = 99;
        s.commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let before_recut = s.load("ses").unwrap().row_version.unwrap();

        let remat = run(&s, &req("ses", "cfg0", live_reverted.clone()), &spine());
        assert_eq!(remat.action, "HARD");
        assert_eq!(
            remat.boundary_id, "a#0",
            "the surviving prefix is re-minted"
        );
        assert_eq!(remat.coverage_ordinal, Some(1));
        assert!(!remat.reconcile_pending);
        assert_eq!(tail_ids(&remat), vec!["t4"]);
        let loaded = s.load("ses").unwrap();
        assert_eq!(loaded.meta.revert_epoch, 1);
        assert!(loaded
            .meta
            .last_recut
            .as_deref()
            .unwrap()
            .contains("dropped seq 2"));
        assert_eq!(loaded.meta.folded_compartment_seq, 1);
        assert_eq!(loaded.meta.last_execute_ordinal, 99);
        assert_eq!(loaded.row_version.unwrap(), before_recut + 2);
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);

        s.append_compartments("ses", &[comp(3, 2, 2, "t4", "S2")])
            .unwrap();
        let folded_again = run(&s, &req("ses", "cfg0", live_reverted), &spine());
        assert_eq!(folded_again.action, "SOFT");
        assert_eq!(folded_again.boundary_id, "t4#0");
        assert_eq!(folded_again.coverage_ordinal, Some(2));
        assert_eq!(tail_ids(&folded_again), Vec::<&str>::new());
    }

    #[test]
    fn reconcile_recut_nothing_survives_arms_pending_raw_without_truncate() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 2, "t2", "S0")])
            .unwrap();
        let live_full = vec![item("t2", 2, "turn two"), item("t3", 3, "tail")];
        let boot = run(&s, &req("ses", "cfg0", live_full), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "t2#0");
        let before_absent = s.load("ses").unwrap();
        let before_compartments = s.load_compartments("ses").unwrap();

        let live_absent = vec![item("t9", 9, "post-revert")];
        let armed = run(&s, &req("ses", "cfg0", live_absent.clone()), &spine());
        assert_eq!(armed.action, "PASSTHROUGH");
        assert!(armed.committed, "arming writes the one durable alarm row");
        assert!(!armed.reconcile_pending);
        assert_eq!(tail_ids(&armed), vec!["t9"]);
        let after_arm = s.load("ses").unwrap();
        assert_eq!(after_arm.core.boundary_id, before_absent.core.boundary_id);
        assert!(!after_arm.core.reconcile_pending);
        assert_eq!(after_arm.meta.revert_epoch, before_absent.meta.revert_epoch);
        assert_eq!(s.load_compartments("ses").unwrap(), before_compartments);
        assert!(after_arm.meta.pending_rewrite.is_some());
        assert!(after_arm
            .meta
            .pending_rewrite_last_failure
            .as_deref()
            .unwrap()
            .contains("upstream lineage-switch detection miss"));

        let row_after_arm = after_arm.row_version.unwrap();
        let repeat = run(&s, &req("ses", "cfg0", live_absent), &spine());
        assert_eq!(repeat.action, "PASSTHROUGH");
        assert!(!repeat.committed, "arm-once pending repeats are write-free");
        assert_eq!(repeat.row_version, row_after_arm);
        assert_eq!(tail_ids(&repeat), tail_ids(&armed));
        assert_eq!(s.load("ses").unwrap().row_version.unwrap(), row_after_arm);
        assert_eq!(s.load_compartments("ses").unwrap(), before_compartments);
    }

    #[test]
    fn fresh_key_share_nothing_bootstraps_without_pending() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let boot = run(
            &s,
            &req("fresh", "cfg0", vec![item("foreign", 9, "new session")]),
            &spine(),
        );
        assert_eq!(boot.action, "HARD");
        let loaded = s.load("fresh").unwrap();
        assert!(loaded.meta.pending_rewrite.is_none());
        assert!(loaded.row_version.is_some());
    }

    #[test]
    fn provider_extras_strip_canary_does_not_arm_pending_on_legitimate_extension() {
        // Coupling canary: MC's shape fingerprint uses flattened block bytes, while the
        // upstream lineage-switch detector keys only on role/kind. Per-turn-churning
        // provider fields must therefore be absent from both bases before MC sees the
        // array; changing either basis requires changing the other together.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "S0")])
            .unwrap();
        let initial = post_submit_strip_block_provider_extras(vec![
            item_with_block_provider_extras("a", 1, "raw", "first"),
            item_with_block_provider_extras("b", 2, "tail", "first"),
        ]);
        let boot = run(&s, &req("ses", "cfg0", initial), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "a#0");

        let extension = post_submit_strip_block_provider_extras(vec![
            item_with_block_provider_extras("a", 1, "raw", "changed"),
            item_with_block_provider_extras("b", 2, "tail", "changed"),
            item_with_block_provider_extras("c", 3, "extension", "changed"),
        ]);
        let pass = run(&s, &req("ses", "cfg0", extension), &spine());
        assert_eq!(pass.action, "SOFT+");
        assert_eq!(pass.boundary_id, "a#0");
        assert!(s.load("ses").unwrap().meta.pending_rewrite.is_none());
    }

    #[test]
    fn pending_rewrite_recovers_on_boundary_present_extension() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 2, "t2", "S0")])
            .unwrap();
        let live_present = vec![item("t2", 2, "turn two"), item("t3", 3, "tail")];
        let boot = run(&s, &req("ses", "cfg0", live_present.clone()), &spine());
        assert_eq!(boot.boundary_id, "t2#0");

        let absent = vec![item("foreign", 50, "other conversation")];
        let armed = run(&s, &req("ses", "cfg0", absent), &spine());
        assert_eq!(armed.action, "PASSTHROUGH");
        assert!(s.load("ses").unwrap().meta.pending_rewrite.is_some());

        let recovered_live = vec![
            item("t2", 2, "turn two"),
            item("t3", 3, "tail"),
            item("t4", 4, "extension"),
        ];
        let recovered = run(&s, &req("ses", "cfg0", recovered_live), &spine());
        assert_eq!(recovered.action, "SOFT+");
        assert_eq!(recovered.boundary_id, "t2#0");
        assert_eq!(tail_ids(&recovered), vec!["t3", "t4"]);
        let loaded = s.load("ses").unwrap();
        assert!(loaded.meta.pending_rewrite.is_none());
        assert!(!loaded.meta.pending_rewrite_ambiguous);
        assert_eq!(loaded.meta.revert_epoch, 0);
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn pending_rewrite_interleave_sets_ambiguous_without_truncating() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 2, "t2", "S0")])
            .unwrap();
        let present = vec![item("t2", 2, "turn two"), item("t3", 3, "tail")];
        let boot = run(&s, &req("ses", "cfg0", present.clone()), &spine());
        assert_eq!(boot.boundary_id, "t2#0");

        for cycle in 0..3 {
            let absent = vec![item(&format!("foreign{cycle}"), 50 + cycle, "other")];
            let raw = run(&s, &req("ses", "cfg0", absent), &spine());
            assert_eq!(raw.action, "PASSTHROUGH");
            let normal = run(&s, &req("ses", "cfg0", present.clone()), &spine());
            assert_eq!(normal.action, "SOFT+");
        }

        let loaded = s.load("ses").unwrap();
        assert!(loaded.meta.pending_rewrite.is_none());
        assert!(loaded.meta.pending_rewrite_ambiguous);
        assert!(loaded
            .meta
            .pending_rewrite_last_failure
            .as_deref()
            .unwrap()
            .contains("ambiguous_pending_rewrite"));
        assert_eq!(loaded.meta.revert_epoch, 0);
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn pending_rewrite_passes_isolate_ingress_meta_usage_and_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 2, "t2", "S0")])
            .unwrap();
        let boot = run(
            &s,
            &with_usage(
                req(
                    "ses",
                    "cfg0",
                    vec![item("t2", 2, "turn two"), item("t3", 3, "tail")],
                ),
                10,
                100,
            ),
            &spine(),
        );
        assert_eq!(boot.boundary_id, "t2#0");
        let before = s.load("ses").unwrap();

        let foreign_same_mid = vec![item("t3", 90, "foreign bytes with reused tail mid")];
        let armed = run(
            &s,
            &with_usage(req("ses", "cfg0", foreign_same_mid.clone()), 95, 100),
            &spine(),
        );
        assert_eq!(armed.action, "PASSTHROUGH");
        let after_arm = s.load("ses").unwrap();
        assert_eq!(
            after_arm.meta.block_identity_by_mid, before.meta.block_identity_by_mid,
            "foreign block identities are never adopted while arming pending"
        );
        assert_eq!(after_arm.meta.last_usage, before.meta.last_usage);
        assert_eq!(
            after_arm.core.reconcile_pending,
            before.core.reconcile_pending
        );

        let row_after_arm = after_arm.row_version.unwrap();
        let meta_after_arm = after_arm.meta.clone();
        let repeat = run(
            &s,
            &with_usage(req("ses", "cfg0", foreign_same_mid), 100, 100),
            &spine(),
        );
        assert_eq!(repeat.action, "PASSTHROUGH");
        let after_repeat = s.load("ses").unwrap();
        assert_eq!(after_repeat.row_version.unwrap(), row_after_arm);
        assert_eq!(after_repeat.meta, meta_after_arm);
        assert_eq!(
            after_repeat.core.reconcile_pending,
            before.core.reconcile_pending
        );
    }

    #[test]
    fn pending_rewrite_persists_across_store_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let s = store(dir.path());
            s.replace_compartments("ses", &[comp(1, 1, 2, "t2", "S0")])
                .unwrap();
            let boot = run(
                &s,
                &req(
                    "ses",
                    "cfg0",
                    vec![item("t2", 2, "turn two"), item("t3", 3, "tail")],
                ),
                &spine(),
            );
            assert_eq!(boot.boundary_id, "t2#0");
            let raw = run(
                &s,
                &req("ses", "cfg0", vec![item("foreign", 90, "other")]),
                &spine(),
            );
            assert_eq!(raw.action, "PASSTHROUGH");
            assert!(s.load("ses").unwrap().meta.pending_rewrite.is_some());
        }

        let s = store(dir.path());
        let before = s.load("ses").unwrap();
        assert!(before.meta.pending_rewrite.is_some());
        let row = before.row_version.unwrap();
        let raw = run(
            &s,
            &req("ses", "cfg0", vec![item("foreign", 90, "other")]),
            &spine(),
        );
        assert_eq!(raw.action, "PASSTHROUGH");
        assert!(!raw.committed);
        assert_eq!(s.load("ses").unwrap().row_version.unwrap(), row);
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn first_fold_error_leaves_state_unchanged_and_the_hard_retries_visibly() {
        // Fold-failure retry semantics: if the first-fold HARD fires and the fold itself
        // errors, the transform returns Err and commits NOTHING, so the persisted boundary
        // stays empty and the compartment stays present — meaning the next pass re-evaluates
        // the same guard, fires the HARD again, and surfaces the SAME error. A persistent
        // fold failure is therefore a stream of VISIBLE transform errors (fail-loud +
        // retry-by-construction), never a silent defer that buries a stranded compartment.
        //
        // The injected failure is a real fail-loud path: a compartment that leaves a LEADING
        // coverage gap (a live item ordinal-before the first covered ordinal) — compose
        // refuses to drop live context it cannot account for.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // Compartment covers ordinals 5..=5, but the live array has ordinal 1 before it → gap.
        s.replace_compartments("ses", &[comp(0, 5, 5, "m5", "S")])
            .unwrap();
        let live = vec![
            item("early", 1, "before coverage"),
            item("m5", 5, "covered"),
        ];

        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let first = transform(&s, &req("ses", "cfg0", live.clone()), &ctx);
        assert!(
            first.is_err(),
            "first-fold HARD hits the leading-gap fail-loud path"
        );
        // The failed pass wrote nothing → the guard re-fires and errors again (visible), it
        // does NOT silently fall through to a defer that strands the compartment.
        let retry = transform(&s, &req("ses", "cfg0", live), &ctx);
        assert!(
            retry.is_err(),
            "state unchanged after the failed fold → the HARD retries and stays visible"
        );
    }

    #[test]
    fn bootstrap_with_a_compartment_summarizes_it_and_trims_the_covered_tail() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // a compartment covers raw ordinals 1..=10, ending at message id "m10"
        s.replace_compartments("ses", &[comp(1, 1, 10, "m10", "SUMMARY-OF-1-10")])
            .unwrap();
        // the live array still carries the raw covered message m10 (ordinal 10) + a tail item
        let items = vec![item("m10", 10, "raw covered"), item("t11", 11, "tail")];
        let r = run(&s, &req("ses", "cfg0", items), &spine());
        assert_eq!(r.action, "HARD");
        assert_eq!(
            r.boundary_id, "m10#0",
            "anchor = the compartment's end message id"
        );
        // m0 is the decay-rendered SUMMARY, not the raw covered bytes
        assert!(
            m0_bytes(&r).contains("SUMMARY-OF-1-10"),
            "m0 is the summary: {}",
            m0_bytes(&r)
        );
        assert!(
            !m0_bytes(&r).contains("raw covered"),
            "m0 is NOT the raw bytes"
        );
        // the covered raw message (ordinal 10 <= coverage 10) is trimmed; only the tail remains
        assert_eq!(
            tail_ids(&r),
            vec!["t11"],
            "covered raw msg trimmed, tail kept"
        );
    }

    #[test]
    fn leading_coverage_gap_fails_loud_not_silent_drop() {
        // Regression: the first compartment starts at ordinal 10, but the live array still
        // carries raw messages at ordinals 1..9 (before the first compartment). Those are
        // covered by no compartment, yet they sit below coverage_ordinal. build_output
        // would silently trim those raw messages, so the live coverage guard must fail loud.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 10, 20, "m20", "S")])
            .unwrap();
        let items = vec![
            item("early", 1, "live before the first compartment"),
            item("m20", 20, "covered"),
            item("t21", 21, "tail"),
        ];
        let err = transform(
            &s,
            &req("ses", "cfg0", items),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(
            matches!(err, TransformError::CoverageGap(_)),
            "a leading gap must fail loud, not silently drop the early live item: {err:?}"
        );
    }

    #[test]
    fn interior_live_coverage_gap_fails_loud_not_silent_drop() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 2, "m2", "S1"), comp(2, 6, 7, "m7", "S2")],
        )
        .unwrap();
        let items = vec![
            item("m1", 1, "covered one"),
            item("m2", 2, "covered two"),
            item("m4", 4, "present but uncovered"),
            item("m6", 6, "covered six"),
            item("m7", 7, "covered seven"),
            item("t8", 8, "tail"),
        ];
        let err = transform(
            &s,
            &req("ses", "cfg0", items),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(matches!(err, TransformError::CoverageGap(_)));
        assert!(
            err.to_string().contains("m4"),
            "the uncovered live message should be named in the loud failure: {err:?}"
        );
    }

    #[test]
    fn leading_coverage_gap_exempts_pinned_system_message() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 2, "m2", "S")])
            .unwrap();
        let items = vec![
            system_item("sys0", 0, "identity lead"),
            item("m2", 2, "covered"),
            item("t3", 3, "tail"),
        ];
        let out = transform(
            &s,
            &req("ses", "cfg0", items),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap();
        assert_eq!(out.coverage_ordinal, Some(2));
    }

    #[test]
    fn leading_uncovered_system_passes_through_for_full_array_profiles() {
        for profile in [
            SerializerProfile::OwnedLlmRunner,
            SerializerProfile::Pi,
            SerializerProfile::OpencodeAiSdk,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let session = format!("lead-{}", profile.wire_id());
            s.replace_compartments(&session, &[comp(1, 1, 1, "m1", "SUMMARY")])
                .unwrap();
            let leading_system = system_item("sys0", 0, "identity lead");
            let r = run(
                &s,
                &profile_req(
                    profile,
                    &session,
                    "cfg0",
                    vec![
                        leading_system.clone(),
                        item("m1", 1, "covered"),
                        item("t2", 2, "tail"),
                    ],
                ),
                &spine(),
            );
            assert_eq!(r.action, "HARD");
            assert!(
                !m0_bytes(&r).contains("identity lead"),
                "{} must not absorb the uncovered leading system into m0",
                profile.wire_id()
            );
            let output_system = r
                .messages()
                .iter()
                .find(|message| message.role == "system")
                .unwrap_or_else(|| panic!("{} output lost the leading system", profile.wire_id()));
            assert_eq!(output_system, &leading_system.ck);
        }
    }

    #[test]
    fn growing_tail_defers_byte_stable_and_no_write() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // a compartment covers ordinal 1 (end id "m1msg"); the boundary stays present
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );

        let mut prev_m0: Option<String> = None;
        let mut prev_m1: Option<String> = None;
        for n in 2..=5u64 {
            let mut items = vec![item("m1msg", 1, "raw")];
            for k in 2..=n {
                items.push(item(&format!("t{k}"), k, &format!("tail{k}")));
            }
            let r = run(&s, &req("ses", "cfg0", items), &spine());
            assert_eq!(r.action, "SOFT+", "no delta → pure defer");
            assert!(
                r.committed,
                "first-seen tail mids persist identity vectors even on a defer"
            );
            if let Some(p) = &prev_m0 {
                assert_eq!(m0_bytes(&r), p, "m0 changed on defer");
            }
            if let Some(p) = &prev_m1 {
                assert_eq!(m1_bytes(&r), p, "m1 changed on defer");
            }
            // tail = the verbatim live items past coverage_ordinal=1 (the covered m1msg trimmed)
            let expected: Vec<String> = (2..=n).map(|k| format!("t{k}")).collect();
            assert_eq!(
                tail_ids(&r),
                expected.iter().map(|s| s.as_str()).collect::<Vec<_>>()
            );
            prev_m0 = Some(m0_bytes(&r).to_string());
            prev_m1 = Some(m1_bytes(&r).to_string());
        }
    }

    #[test]
    fn public_memory_update_rides_soft_not_hard() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let memory_id = s
            .insert_memory(memory_input("git:proj", "ARCHITECTURE", "original", 0))
            .unwrap();
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        let before = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(before.action, "HARD");

        s.update_memory_content("git:proj", memory_id, "corrected", 1)
            .unwrap();
        let soft = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(soft.action, "SOFT", "public update port should not HARD");
        assert_eq!(m0_bytes(&soft), m0_bytes(&before));
        assert!(
            m1_bytes(&soft).contains("<memory-updates>"),
            "{}",
            m1_bytes(&soft)
        );
        assert!(m1_bytes(&soft).contains("corrected"), "{}", m1_bytes(&soft));
    }

    #[test]
    fn public_memory_insert_rides_soft_not_hard() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        let before = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(before.action, "HARD");

        s.insert_memory(memory_input(
            "git:proj",
            "ARCHITECTURE",
            "a durable rule",
            1,
        ))
        .unwrap();
        let soft = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(soft.action, "SOFT", "public insert port should not HARD");
        assert_eq!(m0_bytes(&soft), m0_bytes(&before));
        assert!(
            m1_bytes(&soft).contains("<new-memories>"),
            "{}",
            m1_bytes(&soft)
        );
        assert!(
            m1_bytes(&soft).contains("a durable rule"),
            "{}",
            m1_bytes(&soft)
        );
    }

    #[test]
    fn new_memory_rides_m1_soft_and_m0_stays_frozen() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        let before = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(before.action, "HARD");

        // a NEW memory lands (id past the folded max) → the digest moves → a SOFT
        s.seed_memory(5, "git:proj", "ARCHITECTURE", "a durable rule", 70)
            .unwrap();
        let soft = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(soft.action, "SOFT", "a new store memory rides a SOFT");
        assert_eq!(
            m0_bytes(&soft),
            m0_bytes(&before),
            "m0 frozen across the SOFT"
        );
        assert!(
            m1_bytes(&soft).contains("<new-memories>"),
            "{}",
            m1_bytes(&soft)
        );
        assert!(m1_bytes(&soft).contains("a durable rule"));
        assert!(soft.committed);

        // defer after: the store is unchanged → digest stable → pure SOFT+ replay, no write
        let after = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(after.action, "SOFT+");
        assert!(!after.committed);
        assert_eq!(
            m1_bytes(&after),
            m1_bytes(&soft),
            "m1 replays byte-identical"
        );
        assert_eq!(m0_bytes(&after), m0_bytes(&before));
    }

    #[test]
    fn in_m0_memory_update_rides_m1_as_a_supersede_delta() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // a memory is in the m0 baseline (seeded before bootstrap → in the manifest)
        s.seed_memory(5, "git:proj", "ARCHITECTURE", "original", 70)
            .unwrap();
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        let before = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert!(
            m0_bytes(&before).contains("original"),
            "memory in m0 baseline"
        );

        // an in-session UPDATE to that in-m0 memory → a mutation-log row → digest moves → SOFT
        s.seed_mutation("git:proj", "update", 5, "corrected")
            .unwrap();
        let r = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(r.action, "SOFT", "an in-m0 memory mutation rides a SOFT");
        assert_eq!(
            m0_bytes(&r),
            m0_bytes(&before),
            "m0 frozen (the supersede rides m1)"
        );
        assert!(
            m1_bytes(&r).contains("corrected"),
            "memory-updates delta: {}",
            m1_bytes(&r)
        );
    }

    #[test]
    fn render_config_change_hard_folds_the_m1_delta_into_m0() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        // ride a new memory on m1
        s.seed_memory(5, "git:proj", "ARCHITECTURE", "folded rule", 70)
            .unwrap();
        let soft = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(soft.action, "SOFT");
        assert!(!m0_bytes(&soft).contains("folded rule"), "not in m0 yet");

        // a render_config (model/system) change → HARD: re-compose m0 from the store, which
        // now INCLUDES the memory, and reset m1 to the placeholder.
        let r = run(
            &s,
            &req("ses", "cfg1", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(r.action, "HARD");
        assert!(
            m0_bytes(&r).contains("folded rule"),
            "m1 delta folded into m0: {}",
            m0_bytes(&r)
        );
        assert_eq!(m1_bytes(&r), M1_PLACEHOLDER, "m1 reset to placeholder");
    }

    #[test]
    fn new_compartment_extends_coverage_on_soft_advancing_the_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // m0 folds C1 (covers 1..=10, end "m10")
        s.replace_compartments("ses", &[comp(1, 1, 10, "m10", "S1")])
            .unwrap();
        let boot = run(
            &s,
            &req(
                "ses",
                "cfg0",
                vec![item("m10", 10, "raw"), item("t11", 11, "tail")],
            ),
            &spine(),
        );
        assert_eq!(boot.boundary_id, "m10#0");
        assert_eq!(tail_ids(&boot), vec!["t11"]);

        // C2 (covers 11..=20, end "m20") publishes → it rides m1 at P1 AND extends coverage
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 10, "m10", "S1"), comp(2, 11, 20, "m20", "S2")],
        )
        .unwrap();
        let items = vec![
            item("m10", 10, "raw"),
            item("m20", 20, "raw2"),
            item("t21", 21, "tail"),
        ];
        let soft = run(&s, &req("ses", "cfg0", items.clone()), &spine());
        assert_eq!(soft.action, "SOFT", "a new compartment rides a SOFT");
        assert_eq!(
            soft.boundary_id, "m20#0",
            "the anchor ADVANCED on the SOFT (b0→b1)"
        );
        assert!(
            m1_bytes(&soft).contains("<new-compartments>"),
            "{}",
            m1_bytes(&soft)
        );
        assert!(m1_bytes(&soft).contains("S2") && !m1_bytes(&soft).contains("title=\"C1\""));
        // coverage advanced to 20 → raw m20 trimmed, only t21 remains
        assert_eq!(tail_ids(&soft), vec!["t21"]);

        // a defer at the new anchor replays byte-identical
        let defer = run(&s, &req("ses", "cfg0", items), &spine());
        assert_eq!(defer.action, "SOFT+");
        assert!(!defer.committed);
        assert_eq!(
            m1_bytes(&defer),
            m1_bytes(&soft),
            "m1 replays identical at b1"
        );
        assert_eq!(m0_bytes(&defer), m0_bytes(&soft));

        // A share-nothing boundary absence is not a safe re-cut target. It degrades to
        // raw pass-through and arms the pending-rewrite alarm without touching lineage.
        let revert = run(
            &s,
            &req("ses", "cfg0", vec![item("z", 30, "other")]),
            &spine(),
        );
        assert_eq!(revert.action, "PASSTHROUGH");
        assert!(!revert.reconcile_pending);
        assert!(s.load("ses").unwrap().meta.pending_rewrite.is_some());
    }

    #[test]
    fn coverage_extending_soft_prunes_covered_red_units() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // m0 folds C1 (covers 1..=10); t11/t12 are live tail items.
        s.replace_compartments("ses", &[comp(1, 1, 10, "m10", "S1")])
            .unwrap();
        let items_v1 = vec![
            item("m10", 10, "raw"),
            item("t11", 11, "tool output"),
            item("t12", 12, "tail"),
        ];
        run(&s, &req("ses", "cfg0", items_v1.clone()), &spine());

        // A SOFT freezes a reduction on t11 (still in the tail).
        let reduced = run(
            &s,
            &req("ses", "cfg0", items_v1.clone()),
            &with_reductions(vec![reduce("t11", "drop", "[dropped]")]),
        );
        assert_eq!(reduced.action, "SOFT");
        assert_eq!(tail_bytes(&reduced, "t11"), "[dropped]");

        // C2 publishes covering through t12 → the next SOFT extends coverage past
        // When the next compartment extends coverage past t11's ordinal, the frozen
        // reduction red:t11#0 must be removed in the same update. Its target message
        // is no longer in the tail, so retaining the reduction would waste space and
        // could create spurious conflicts if a later revert reuses the same message id
        // with different content.
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 10, "m10", "S1"), comp(2, 11, 12, "t12", "S2")],
        )
        .unwrap();
        let items_v2 = vec![
            item("m10", 10, "raw"),
            item("t11", 11, "tool output"),
            item("t12", 12, "tail"),
            item("t13", 13, "newest"),
        ];
        let folded = run(&s, &req("ses", "cfg0", items_v2.clone()), &spine());
        assert_eq!(folded.action, "SOFT", "new compartment rides a SOFT");
        assert_eq!(tail_ids(&folded), vec!["t13"], "coverage trimmed t11/t12");

        // The invariant (fail-loud form): after a coverage advance, no frozen red:*
        // unit may target a covered ordinal.
        let loaded = s.load("ses").unwrap();
        let core = loaded.core;
        let coverage = loaded.meta.coverage_ordinal.expect("coverage advanced");
        let covered_ordinals: std::collections::BTreeMap<String, u64> = items_v2
            .iter()
            .map(|i| (target_id(&i.mid), i.ordinal))
            .collect();
        for unit in &core.frozen_units {
            let Some(target) = unit.key.strip_prefix("red:") else {
                continue;
            };
            if let Some(&ord) = covered_ordinals.get(target) {
                assert!(
                    ord > coverage,
                    "frozen {} survived its target's coverage (ord {ord} <= coverage {coverage})",
                    unit.key
                );
            }
        }
        // And the pruned unit is gone specifically.
        assert!(
            core.frozen_units.iter().all(|u| u.key != "red:t11#0"),
            "red:t11#0 must be pruned by the coverage-extending SOFT"
        );

        // Defer replays byte-identical after the prune (the prune itself must not
        // perturb replay).
        let defer = run(&s, &req("ses", "cfg0", items_v2), &spine());
        assert_eq!(defer.action, "SOFT+");
        assert_eq!(m1_bytes(&defer), m1_bytes(&folded));
        assert_eq!(m0_bytes(&defer), m0_bytes(&folded));
    }

    #[test]
    fn frozen_expiry_cutoff_survives_a_wall_clock_advance_on_recompose() {
        // Resume-determinism guard for the frozen expiry cutoff: a memory live under the
        // FROZEN cutoff must keep rendering even when a later SOFT recomposes at a
        // wall-clock past its expiry (e.g. after a restart). A live-clock bug (using now_ms
        // instead of the frozen meta cutoff) drops it here and ONLY here — the non-vacuous
        // proof.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        // bootstrap at now_ms=500 → expiry cutoff FROZEN at 500. No memories folded yet.
        transform(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &pctx("git:proj", "/nonexistent-docs", 500),
        )
        .unwrap();

        // a NEW memory expiring at 1000: LIVE under cutoff 500, EXPIRED under wall-clock 2000.
        s.seed_expiring_memory(5, "git:proj", "ARCHITECTURE", "still valid", 70, 1000)
            .unwrap();

        // a SOFT recompose at wall-clock 2000 — the cutoff stays FROZEN at 500, so the
        // memory is live and renders. A bug using now_ms=2000 would expire + drop it.
        let soft = transform(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &pctx("git:proj", "/nonexistent-docs", 2000),
        )
        .unwrap();
        assert_eq!(soft.action, "SOFT");
        assert!(
            m1_bytes(&soft).contains("still valid"),
            "frozen cutoff (500) keeps the memory live at wall-clock 2000: {}",
            m1_bytes(&soft)
        );
    }

    #[test]
    fn workspace_membership_change_is_a_render_config_hard() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
            .unwrap();
        run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        // a steady defer (no change)
        let defer = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(defer.action, "SOFT+");

        // joining a workspace changes the deterministic workspace_fingerprint → the folded
        // render_config changes → a HARD (m0 is now composed over a different project set).
        s.seed_workspace_member("ws1", "git:proj", "[\"CONSTRAINTS\"]")
            .unwrap();
        let r = run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(r.action, "HARD", "a membership change re-materializes m0");
    }

    #[test]
    fn share_nothing_revert_arms_pending_instead_of_reconcile_rematerializing() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 10, "m10", "S1")])
            .unwrap();
        let before = run(
            &s,
            &req("ses", "cfg0", vec![item("m10", 10, "raw")]),
            &spine(),
        );
        assert_eq!(before.action, "HARD");
        assert_eq!(before.boundary_id, "m10#0");

        let raw = run(
            &s,
            &req("ses", "cfg0", vec![item("z", 50, "other")]),
            &spine(),
        );
        assert_eq!(raw.action, "PASSTHROUGH");
        assert!(!raw.reconcile_pending);
        assert_eq!(tail_ids(&raw), vec!["z"]);
        let loaded = s.load("ses").unwrap();
        assert_eq!(loaded.core.boundary_id, "m10#0");
        assert!(!loaded.core.reconcile_pending);
        assert!(loaded.meta.pending_rewrite.is_some());
        assert_eq!(loaded.meta.revert_epoch, 0);
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn legacy_baseline_migrates_to_clean_m0_m1() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // seed a legacy single-"baseline"-unit state directly, initialized
        let legacy_core = CoreState {
            version: 1,
            boundary_id: "a#0".into(),
            frozen_units: vec![synth_region("baseline", "OLD".into())],
            pending_changes: vec![],
            reconcile_pending: false,
        };
        let legacy_meta = ModuleMeta {
            initialized: true,
            last_render_config: "cfg0".into(),
            coverage_ordinal: Some(1),
            ..Default::default()
        };
        s.commit("ses", None, &legacy_core, &legacy_meta).unwrap();
        // a compartment so the migrated m0 has real summary content
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "FRESH-SUMMARY")])
            .unwrap();

        let r = run(&s, &req("ses", "cfg0", vec![item("a", 1, "NEW")]), &spine());
        assert_eq!(
            r.action, "HARD",
            "legacy shape migrates via clear-then-Hard"
        );
        // After a stored legacy baseline is cleared and rebuilt as the current m0/m1
        // shape, the response has no leftover baseline state: it contains exactly two
        // synthetic messages, and m0 was re-composed from store data.
        assert_eq!(r.messages().iter().filter(|m| m.meta.synthetic).count(), 2);
        assert!(
            m0_bytes(&r).contains("FRESH-SUMMARY"),
            "m0 re-composed: {}",
            m0_bytes(&r)
        );
        let reloaded = s.load("ses").unwrap();
        assert!(reloaded
            .core
            .frozen_units
            .iter()
            .all(|u| u.key == "m0" || u.key == "m1"));
    }

    #[test]
    fn unknown_shape_rejects_without_clearing() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let weird = CoreState {
            version: 1,
            boundary_id: "a#0".into(),
            frozen_units: vec![synth_region("junk", "??".into())],
            pending_changes: vec![],
            reconcile_pending: false,
        };
        let meta = ModuleMeta {
            initialized: true,
            last_render_config: "cfg0".into(),
            coverage_ordinal: Some(1),
            ..Default::default()
        };
        s.commit("ses", None, &weird, &meta).unwrap();
        let err = transform(
            &s,
            &req("ses", "cfg0", vec![item("a", 1, "X")]),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(matches!(err, TransformError::UnknownShape(_)));
        // durable state unchanged (the "junk" unit survives — not destructively cleared)
        let reloaded = s.load("ses").unwrap();
        assert_eq!(reloaded.core.frozen_units[0].key, "junk");
    }

    #[test]
    fn reserved_id_and_ordinal_violations_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let dc = pctx("git:proj", "/nonexistent-docs", 0);

        // a non-synthetic item with a reserved mc_* id (a pre-load ingress guard)
        let reserved = transform(&s, &req("ses", "cfg0", vec![item("mc_m0", 2, "x")]), &dc);
        assert!(matches!(reserved, Err(TransformError::ReservedId)));

        // non-monotonic ordinals
        let bad = transform(
            &s,
            &req("ses", "cfg0", vec![item("a", 5, "x"), item("b", 5, "y")]),
            &dc,
        );
        assert!(matches!(bad, Err(TransformError::OrdinalViolation)));
    }

    #[test]
    fn synthetic_ingress_is_stripped_before_boundary_and_tail() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "S")])
            .unwrap();
        run(
            &s,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        // feed our own synthetic m0 back in alongside the real array
        let mut stale = item(M0_ID, 0, "STALE");
        stale.ck.meta.synthetic = true;
        let items = vec![stale, item("m1msg", 1, "raw"), item("t2", 2, "tail2")];
        let r = run(&s, &req("ses", "cfg0", items), &spine());
        // boundary m1msg still found (synthetic stripped), tail filter uncorrupted
        assert_eq!(r.action, "SOFT+");
        assert_eq!(tail_ids(&r), vec!["t2"]);
    }

    #[test]
    fn zero_block_tail_message_passes_through() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("zero", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        run(
            &s,
            &req("zero", "cfg0", vec![item("a", 1, "raw")]),
            &spine(),
        );

        let empty = empty_message("empty", 2);
        let r = run(
            &s,
            &req("zero", "cfg0", vec![item("a", 1, "raw"), empty.clone()]),
            &spine(),
        );

        assert_eq!(r.action, "SOFT+");
        assert_eq!(tail_ids(&r), vec!["empty"]);
        let emitted = r
            .messages()
            .iter()
            .find(|m| !m.meta.synthetic && m.meta.harness_id.as_deref() == Some("empty"))
            .expect("empty tail message emitted");
        assert_eq!(
            serde_json::to_value(emitted).unwrap(),
            serde_json::to_value(&empty.ck).unwrap()
        );
    }

    #[test]
    fn synthetic_todo_compose_at_bust_freezes_position_across_defer_tail_growth() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("freeze", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let todos = json!([{ "content": "Plan", "status": "pending", "priority": "high" }]);
        let bust_items = vec![
            item("a", 1, "raw"),
            todowrite_call("todo", 2, todos.clone()),
        ];
        let bust = run(&s, &req("freeze", "cfg0", bust_items.clone()), &spine());

        assert_eq!(bust.action, "HARD");
        assert_eq!(
            synthetic_todo_index(&bust),
            message_index(&bust, "todo") + 1
        );
        let bust_prefix = prefix_through_synthetic_todo(&bust);

        let defer_items = vec![
            item("a", 1, "raw"),
            todowrite_call("todo", 2, todos),
            item("later1", 3, "new tail 1"),
            item("later2", 4, "new tail 2"),
        ];
        let defer = run(&s, &req("freeze", "cfg0", defer_items), &spine());

        assert_eq!(defer.action, "SOFT+");
        assert_eq!(
            synthetic_todo_index(&defer),
            message_index(&defer, "todo") + 1
        );
        assert!(message_index(&defer, "later1") > synthetic_todo_index(&defer) + 1);
        assert!(message_index(&defer, "later2") > synthetic_todo_index(&defer) + 1);
        assert_eq!(prefix_through_synthetic_todo(&defer), bust_prefix);
    }

    #[test]
    fn synthetic_todo_keep_on_bust_does_not_relocate() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("keep", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let todos = json!([{ "content": "Keep", "status": "pending", "priority": "high" }]);
        let first_items = vec![
            item("a", 1, "raw"),
            todowrite_call("todo", 2, todos.clone()),
        ];
        let first = run(&s, &req("keep", "cfg0", first_items), &spine());
        let first_pair = synthetic_todo_pair_bytes(&first);
        let first_prefix = prefix_through_synthetic_todo(&first);

        let second_items = vec![
            item("a", 1, "raw"),
            todowrite_call("todo", 2, todos),
            item("later", 3, "tail grew"),
        ];
        let second = run(&s, &req("keep", "cfg1", second_items), &spine());

        assert_eq!(second.action, "HARD");
        assert_eq!(
            synthetic_todo_index(&second),
            message_index(&second, "todo") + 1
        );
        assert!(message_index(&second, "later") > synthetic_todo_index(&second) + 1);
        assert_eq!(synthetic_todo_pair_bytes(&second), first_pair);
        assert_eq!(prefix_through_synthetic_todo(&second), first_prefix);
        assert_eq!(
            s.load("keep")
                .unwrap()
                .meta
                .synthetic_todo
                .as_ref()
                .and_then(|pair| pair.anchor_mid.as_deref()),
            Some("todo")
        );
    }

    #[test]
    fn synthetic_todo_keep_reanchors_when_coverage_advance_folds_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("keep-fold", &[comp(1, 1, 1, "a", "SUMMARY-1")])
            .unwrap();
        let todos = json!([{ "content": "Fold", "status": "pending", "priority": "high" }]);
        let first = run(
            &s,
            &req(
                "keep-fold",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos.clone()),
                ],
            ),
            &spine(),
        );
        let first_pair = synthetic_todo_pair_bytes(&first);
        let first_call_id = synthetic_todo_call_id(&first);

        s.replace_compartments(
            "keep-fold",
            &[
                comp(1, 1, 1, "a", "SUMMARY-1"),
                comp(2, 2, 2, "todo", "SUMMARY-2"),
            ],
        )
        .unwrap();
        let moved = run(
            &s,
            &req(
                "keep-fold",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos),
                    item("t3", 3, "new tail end"),
                ],
            ),
            &spine(),
        );

        assert_eq!(moved.action, "SOFT");
        assert_eq!(synthetic_todo_call_id(&moved), first_call_id);
        assert_eq!(synthetic_todo_pair_bytes(&moved), first_pair);
        assert_eq!(
            synthetic_todo_index(&moved),
            message_index(&moved, "t3") + 1
        );
        assert_eq!(
            s.load("keep-fold")
                .unwrap()
                .meta
                .synthetic_todo
                .as_ref()
                .and_then(|pair| pair.anchor_mid.as_deref()),
            Some("t3")
        );
    }

    #[test]
    fn crash_reentry_after_recut_uses_coverage_shrink_for_todo_reanchor() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("shrink", &[comp(1, 1, 1, "a", "SUMMARY-1")])
            .unwrap();
        let todos = json!([{ "content": "Shrink", "status": "pending", "priority": "high" }]);
        let first = run(
            &s,
            &req(
                "shrink",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos.clone()),
                ],
            ),
            &spine(),
        );
        let first_pair = synthetic_todo_pair_bytes(&first);
        let first_call_id = synthetic_todo_call_id(&first);

        let loaded = s.load("shrink").unwrap();
        s.replace_compartments(
            "shrink",
            &[
                comp(1, 1, 1, "a", "SUMMARY-1"),
                comp(2, 2, 2, "todo", "SUMMARY-2"),
                comp(3, 3, 3, "gone", "SUMMARY-3"),
            ],
        )
        .unwrap();
        let mut core = loaded.core;
        core.boundary_id = "gone#0".to_string();
        core.reconcile_pending = true;
        let mut meta = loaded.meta;
        meta.coverage_ordinal = Some(3);
        meta.folded_compartment_seq = 3;
        meta.synthetic_todo
            .as_mut()
            .expect("first bust freezes a synthetic todo")
            .anchor_mid = Some("gone".to_string());
        let rv = s
            .commit("shrink", loaded.row_version, &core, &meta)
            .unwrap();

        s.truncate_compartments_for_revert("shrink", 1, Some(rv))
            .unwrap();
        let recovered = run(
            &s,
            &req(
                "shrink",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos),
                    item("tail", 4, "new post-revert tail"),
                ],
            ),
            &spine(),
        );

        assert_eq!(recovered.action, "HARD");
        assert_eq!(recovered.boundary_id, "a#0");
        assert_eq!(synthetic_todo_call_id(&recovered), first_call_id);
        assert_eq!(synthetic_todo_pair_bytes(&recovered), first_pair);
        assert_eq!(
            s.load("shrink")
                .unwrap()
                .meta
                .synthetic_todo
                .as_ref()
                .and_then(|pair| pair.anchor_mid.as_deref()),
            Some("tail")
        );
    }

    #[test]
    fn synthetic_todo_defer_after_keep_reanchor_replays_at_new_position() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("keep-fold-defer", &[comp(1, 1, 1, "a", "SUMMARY-1")])
            .unwrap();
        let todos = json!([{ "content": "Fold defer", "status": "pending", "priority": "high" }]);
        run(
            &s,
            &req(
                "keep-fold-defer",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos.clone()),
                ],
            ),
            &spine(),
        );

        s.replace_compartments(
            "keep-fold-defer",
            &[
                comp(1, 1, 1, "a", "SUMMARY-1"),
                comp(2, 2, 2, "todo", "SUMMARY-2"),
            ],
        )
        .unwrap();
        let moved_items = vec![
            item("a", 1, "raw"),
            todowrite_call("todo", 2, todos),
            item("t3", 3, "new tail end"),
        ];
        let moved = run(
            &s,
            &req("keep-fold-defer", "cfg0", moved_items.clone()),
            &spine(),
        );
        let moved_prefix = prefix_through_synthetic_todo(&moved);

        let defer = run(&s, &req("keep-fold-defer", "cfg0", moved_items), &spine());

        assert_eq!(defer.action, "SOFT+");
        assert_eq!(
            synthetic_todo_index(&defer),
            message_index(&defer, "t3") + 1
        );
        assert_eq!(prefix_through_synthetic_todo(&defer), moved_prefix);
    }

    #[test]
    fn synthetic_todo_replace_relocates_to_new_tail_end() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("replace", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let first_todos = json!([{ "content": "Old", "status": "pending", "priority": "high" }]);
        let first = run(
            &s,
            &req(
                "replace",
                "cfg0",
                vec![item("a", 1, "raw"), todowrite_call("todo", 2, first_todos)],
            ),
            &spine(),
        );
        let first_call_id = synthetic_todo_call_id(&first);

        let changed_todos = json!([{ "content": "New", "status": "pending", "priority": "high" }]);
        let second = run(
            &s,
            &req(
                "replace",
                "cfg1",
                vec![
                    item("a", 1, "raw"),
                    item("later", 3, "tail before changed todo"),
                    todowrite_call("todo2", 4, changed_todos),
                ],
            ),
            &spine(),
        );

        assert_eq!(second.action, "HARD");
        assert_ne!(synthetic_todo_call_id(&second), first_call_id);
        assert_eq!(
            synthetic_todo_index(&second),
            message_index(&second, "todo2") + 1
        );
    }

    #[test]
    fn synthetic_todo_clear_removes_pair_for_terminal_state() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("clear", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let active = json!([{ "content": "Active", "status": "pending", "priority": "high" }]);
        run(
            &s,
            &req(
                "clear",
                "cfg0",
                vec![item("a", 1, "raw"), todowrite_call("todo", 2, active)],
            ),
            &spine(),
        );

        let terminal = json!([
            { "content": "Done", "status": "completed", "priority": "high" },
            { "content": "Cancelled", "status": "cancelled", "priority": "low" }
        ]);
        let cleared = run(
            &s,
            &req(
                "clear",
                "cfg1",
                vec![item("a", 1, "raw"), todowrite_call("done", 3, terminal)],
            ),
            &spine(),
        );

        assert_eq!(cleared.action, "HARD");
        assert!(cleared.messages().iter().all(|m| {
            !matches!(
                m.content.first().map(|block| &block.kind),
                Some(ck_wire::CkKind::ToolCall { name, .. }) if name == "todowrite"
            ) || !m.meta.synthetic
        }));
        assert!(s.load("clear").unwrap().meta.synthetic_todo.is_none());
    }

    #[test]
    fn synthetic_todo_aged_out_capture_composes_from_meta_on_bust() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("aged", &[comp(1, 1, 2, "todo", "SUMMARY")])
            .unwrap();
        let todos = json!([{ "content": "Persisted", "status": "pending", "priority": "high" }]);
        run(
            &s,
            &req(
                "aged",
                "cfg0",
                vec![item("a", 1, "raw"), todowrite_call("todo", 2, todos)],
            ),
            &spine(),
        );
        let loaded = s.load("aged").unwrap();
        let mut meta = loaded.meta;
        meta.synthetic_todo = None;
        meta.last_render_config = "force a hard".to_string();
        s.commit("aged", loaded.row_version, &loaded.core, &meta)
            .unwrap();

        let aged = run(
            &s,
            &req(
                "aged",
                "cfg1",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call(
                        "todo",
                        2,
                        json!([{ "content": "Persisted", "status": "pending", "priority": "high" }]),
                    ),
                ],
            ),
            &spine(),
        );

        assert_eq!(aged.action, "HARD");
        assert_eq!(tail_ids(&aged), Vec::<&str>::new());
        assert_eq!(
            synthetic_todo_index(&aged),
            2,
            "None anchor appends after m0/m1 when no real tail remains"
        );
        assert!(s.load("aged").unwrap().meta.synthetic_todo.is_some());
    }

    #[test]
    fn synthetic_todo_none_anchor_stays_before_grown_tail_on_defer() {
        // A pair frozen with anchor_mid = None (composed when the tail was empty) must be
        // pinned immediately after m0/m1, NOT floated to the end. A later defer that grows
        // the tail must leave the [m0, m1, pair] prefix byte-identical, with the new tail
        // message landing AFTER the pair — otherwise the None-anchor path reintroduces the
        // always-last floater the position-freeze exists to prevent.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("none-anchor", &[comp(1, 1, 2, "todo", "SUMMARY")])
            .unwrap();
        let todos = json!([{ "content": "Persisted", "status": "pending", "priority": "high" }]);
        run(
            &s,
            &req(
                "none-anchor",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos.clone()),
                ],
            ),
            &spine(),
        );
        // Force a HARD with an empty live tail so the composed pair freezes anchor_mid = None.
        let loaded = s.load("none-anchor").unwrap();
        let mut meta = loaded.meta;
        meta.synthetic_todo = None;
        meta.last_render_config = "force a hard".to_string();
        s.commit("none-anchor", loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let composed = run(
            &s,
            &req(
                "none-anchor",
                "cfg1",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos.clone()),
                ],
            ),
            &spine(),
        );
        assert_eq!(composed.action, "HARD");
        assert_eq!(tail_ids(&composed), Vec::<&str>::new());
        assert_eq!(synthetic_todo_index(&composed), 2);
        assert!(
            s.load("none-anchor")
                .unwrap()
                .meta
                .synthetic_todo
                .as_ref()
                .unwrap()
                .anchor_mid
                .is_none(),
            "the empty-tail compose must freeze anchor_mid = None"
        );
        let composed_prefix = prefix_through_synthetic_todo(&composed);

        // A defer that appends a new tail message (ordinal 3, above coverage 2).
        let defer = run(
            &s,
            &req(
                "none-anchor",
                "cfg1",
                vec![
                    item("a", 1, "raw"),
                    todowrite_call("todo", 2, todos),
                    item("t3", 3, "tail grew after the None-anchor compose"),
                ],
            ),
            &spine(),
        );

        assert_eq!(defer.action, "SOFT+");
        // The pair stays right after m0/m1; the new tail message lands AFTER it.
        assert_eq!(synthetic_todo_index(&defer), 2);
        assert!(message_index(&defer, "t3") > synthetic_todo_index(&defer));
        // The whole [m0, m1, pair] prefix is byte-identical to the compose pass.
        assert_eq!(prefix_through_synthetic_todo(&defer), composed_prefix);
    }

    #[test]
    fn synthetic_todo_defer_anchor_vanished_fails_loud() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("vanished", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let todos = json!([{ "content": "Anchor", "status": "pending", "priority": "high" }]);
        run(
            &s,
            &req(
                "vanished",
                "cfg0",
                vec![item("a", 1, "raw"), todowrite_call("todo", 2, todos)],
            ),
            &spine(),
        );
        let before = s.load("vanished").unwrap().row_version;

        let err = transform(
            &s,
            &req(
                "vanished",
                "cfg0",
                vec![item("a", 1, "raw"), item("later", 3, "tail without anchor")],
            ),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();

        assert!(matches!(err, TransformError::SyntheticTodoAnchorMissing(mid) if mid == "todo"));
        assert_eq!(s.load("vanished").unwrap().row_version, before);
    }

    #[test]
    fn restart_replays_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let bytes_m0;
        let bytes_m1;
        {
            let s = store(dir.path());
            s.replace_compartments("ses", &[comp(1, 1, 1, "m1msg", "SUMMARY")])
                .unwrap();
            run(
                &s,
                &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
                &spine(),
            );
            let r = run(
                &s,
                &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
                &spine(),
            );
            bytes_m0 = m0_bytes(&r).to_string();
            bytes_m1 = m1_bytes(&r).to_string();
        } // lease released
        let s2 = store(dir.path());
        let after = run(
            &s2,
            &req("ses", "cfg0", vec![item("m1msg", 1, "raw")]),
            &spine(),
        );
        assert_eq!(after.action, "SOFT+");
        assert!(!after.committed);
        assert_eq!(m0_bytes(&after), bytes_m0);
        assert_eq!(m1_bytes(&after), bytes_m1);
    }

    #[test]
    fn old_meta_json_without_new_fields_loads() {
        // serde(default) lets older meta JSON (written before m1_revision and the
        // two-watermark fields existed) deserialize cleanly — they all default.
        let json = r#"{"initialized":true,"last_render_config":"cfg0","coverage_ordinal":1}"#;
        let meta: ModuleMeta = serde_json::from_str(json).unwrap();
        assert_eq!(meta.m1_revision, 0);
        assert_eq!(meta.folded_compartment_seq, 0);
        assert_eq!(meta.coverage_start_ordinal, None);
        assert_eq!(meta.coverage_compartment_seq, None);
        assert_eq!(meta.expiry_cutoff_ms, 0);
        assert_eq!(meta.revert_epoch, 0);
        assert!(meta.last_recut.is_none());
        assert_eq!(meta.historian.expected_revert_epoch, 0);
        assert!(meta.synthetic_todo.is_none());
        assert!(!meta.cc_u1_active);
        assert!(meta.initialized);
    }

    // ===== slice 3: tail reducers =====

    fn reduce(target: &str, kind: &str, payload: &str) -> ReductionDecision {
        ReductionDecision {
            target_id: target_id(target),
            kind: kind.to_string(),
            payload: payload.to_string(),
        }
    }
    fn with_reductions(rs: Vec<ReductionDecision>) -> Vec<ReductionDecision> {
        rs
    }
    fn first_block_text(block: &ck_wire::CkWireBlock) -> Option<&str> {
        match &block.kind {
            ck_wire::CkKind::Text { text } => Some(text.as_str()),
            ck_wire::CkKind::ToolResult { output, .. } => match &output.kind {
                ck_wire::CkOutputKind::Text { text }
                | ck_wire::CkOutputKind::ErrorText { text } => Some(text.as_str()),
                ck_wire::CkOutputKind::Content { blocks } => blocks.iter().find_map(|block| {
                    if let ck_wire::ResultBlockKind::Text { text } = &block.kind {
                        Some(text.as_str())
                    } else {
                        None
                    }
                }),
                _ => None,
            },
            _ => None,
        }
    }
    /// The bytes of a tail item (non-synthetic) by id.
    fn tail_bytes<'a>(r: &'a TransformResponse, id: &str) -> &'a str {
        let msg = r
            .messages()
            .iter()
            .find(|m| !m.meta.synthetic && m.meta.harness_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("no tail item {id}"));
        first_block_text(msg.content.first().unwrap()).unwrap()
    }

    /// Bootstrap a session whose m0 covers ordinal 1 (compartment ends at id "a"), so the
    /// boundary "a" is present and tail items (ordinal ≥ 2) are reducible.
    fn bootstrap_covering_a(s: &McStore) {
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        run(s, &req("ses", "cfg0", vec![item("a", 1, "raw")]), &spine());
    }

    #[test]
    fn tagging_gate_off_preserves_unreduced_golden_messages() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let response = run(
            &s,
            &req("inert", "cfg0", vec![item("m1", 1, "hello")]),
            &spine(),
        );
        assert_eq!(tail_bytes(&response, "m1"), "hello");
        assert!(s.load_tags_for_session("inert").unwrap().is_empty());
    }

    #[test]
    fn opencode_tagging_surface_tags_tool_results_and_replays_byte_stably() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let messages = vec![
            wire_tool_call("call-1", 1, "call_result-1"),
            wire_tool_result(
                "result-1",
                2,
                json!({ "kind": { "type": "text", "text": "tool output" } }),
            ),
        ];
        let request = active_opencode_req("opencode-tags", "cfg0", messages);

        let transition = run(&s, &request, &spine());
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        assert!(!serde_json::to_string(transition.messages())
            .unwrap()
            .contains("§1§"));

        let active = run(&s, &request, &spine());
        assert_eq!(active.surface_state, SurfaceState::Active);
        let active_bytes = serde_json::to_vec(active.messages()).unwrap();
        assert!(serde_json::to_string(active.messages())
            .unwrap()
            .contains("§1§ tool output"));
        assert_eq!(s.load_tags_for_session("opencode-tags").unwrap().len(), 1);

        let replay = run(&s, &request, &spine());
        assert_eq!(serde_json::to_vec(replay.messages()).unwrap(), active_bytes);
    }

    #[test]
    fn opencode_tool_absent_keeps_overlay_bytes_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let request = opencode_req(
            "opencode-inactive",
            "cfg0",
            vec![item("m1", 1, "plain output")],
        );

        let first = run(&s, &request, &spine());
        let replay = run(&s, &request, &spine());
        assert_eq!(first.surface_state, SurfaceState::Inactive);
        assert_eq!(
            serde_json::to_vec(first.messages()).unwrap(),
            serde_json::to_vec(replay.messages()).unwrap()
        );
        assert!(!serde_json::to_string(first.messages())
            .unwrap()
            .contains("§1§"));
        assert!(s
            .load_tags_for_session("opencode-inactive")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn opencode_surface_flip_folds_once_before_rendering_tags() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request =
            opencode_req("opencode-flip", "cfg0", vec![item("m1", 1, "stable bytes")]);

        let before = run(&s, &request, &spine());
        let before_config = s.load("opencode-flip").unwrap().meta.last_render_config;
        assert_eq!(before.action, "HARD");
        assert!(!before_config.contains("tfe:"));

        request.tool_present = true;
        let transition = run(&s, &request, &spine());
        let transitioned_config = s.load("opencode-flip").unwrap().meta.last_render_config;
        assert_eq!(transition.action, "HARD");
        assert_ne!(transitioned_config, before_config);
        assert!(transitioned_config.contains("tfe:4:tfe3"));
        assert!(!serde_json::to_string(transition.messages())
            .unwrap()
            .contains("§1§"));

        let active = run(&s, &request, &spine());
        assert_ne!(active.action, "HARD");
        assert_eq!(
            s.load("opencode-flip").unwrap().meta.last_render_config,
            transitioned_config
        );
        assert!(serde_json::to_string(active.messages())
            .unwrap()
            .contains("§1§ stable bytes"));
    }

    #[test]
    fn tagger_flip_hards_before_committed_identity_can_render_tags() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = cc_req("flip", "cfg0", vec![item("m1", 1, "hello")]);

        let before_flip = run(&s, &request, &spine());
        assert_eq!(before_flip.action, "HARD");
        assert_eq!(tail_bytes(&before_flip, "m1"), "hello");
        assert!(!s
            .load("flip")
            .unwrap()
            .meta
            .last_render_config
            .contains("tfe:"));

        request.tool_present = true;
        let transition = run(&s, &request, &spine());
        assert_eq!(transition.action, "HARD");
        assert_eq!(tail_bytes(&transition, "m1"), "hello");
        assert!(s.load_tags_for_session("flip").unwrap().is_empty());
        assert!(s
            .load("flip")
            .unwrap()
            .meta
            .last_render_config
            .contains("tfe:4:tfe3"));

        let after_commit = run(&s, &request, &spine());
        assert_eq!(after_commit.action, "SOFT+");
        assert_eq!(tail_bytes(&after_commit, "m1"), "§1§ hello");
        assert_eq!(s.load_tags_for_session("flip").unwrap().len(), 1);
    }

    #[test]
    fn tag_prefix_strip_is_a_byte_exact_inverse() {
        let corpus = [
            "",
            "plain",
            "  leading whitespace",
            "\t\nline",
            "§7§ forged other tag",
            "§42§ genuine same-looking content",
            "é日🙂",
            "§not-a-tag§ x",
        ];
        for content in corpus {
            let tagged = prepend_tag(42, content);
            assert_eq!(strip_tag_prefix(&tagged, 42).as_bytes(), content.as_bytes());
            if !content.starts_with("§42§ ") {
                assert_eq!(strip_tag_prefix(content, 42).as_bytes(), content.as_bytes());
            }
        }
        assert_eq!(
            strip_tag_prefix("§7§ forged other tag", 42),
            "§7§ forged other tag"
        );
        assert_eq!(
            strip_tag_prefix("§42§ §42§ user content", 42),
            "§42§ user content",
            "only one registered prefix occurrence is removed"
        );
    }

    #[test]
    fn temporal_gap_format_matches_typescript_goldens() {
        let fixtures = [
            (0, None),
            (299_999, None),
            (300_000, Some("<!-- +5m -->\n")),
            (12 * 60 * 1_000, Some("<!-- +12m -->\n")),
            ((2 * 60 * 60 + 15 * 60) * 1_000, Some("<!-- +2h 15m -->\n")),
            (24 * 60 * 60 * 1_000, Some("<!-- +1d -->\n")),
            (
                (3 * 24 * 60 * 60 + 4 * 60 * 60) * 1_000,
                Some("<!-- +3d 4h -->\n"),
            ),
            (7 * 24 * 60 * 60 * 1_000, Some("<!-- +1w -->\n")),
            (
                (2 * 7 * 24 * 60 * 60 + 3 * 24 * 60 * 60) * 1_000,
                Some("<!-- +2w 3d -->\n"),
            ),
        ];
        for (gap_ms, expected) in fixtures {
            assert_eq!(temporal_gap_prefix(gap_ms).as_deref(), expected);
        }
    }

    #[test]
    fn temporal_gap_overlay_replays_and_false_window_is_verbatim() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let first_messages = vec![wire_item("user", "m1", 1, &["start"])];
            let first_request = active_cc_req("temporal", "cfg0", first_messages.clone());
            transform(
                &s,
                &first_request,
                &pctx("git:proj", "/nonexistent-docs", 1_000),
            )
            .unwrap();
            transform(
                &s,
                &first_request,
                &pctx("git:proj", "/nonexistent-docs", 1_000),
            )
            .unwrap();

            let mut with_assistant = first_messages;
            with_assistant.push(wire_item("assistant", "m2", 2, &["answer"]));
            let assistant_request = active_cc_req("temporal", "cfg0", with_assistant.clone());
            transform(
                &s,
                &assistant_request,
                &pctx("git:proj", "/nonexistent-docs", 10_000),
            )
            .unwrap();

            let mut complete = with_assistant;
            complete.push(wire_item("user", "m3", 3, &["question"]));
            let mut active = active_cc_req("temporal", "cfg0", complete.clone());
            active.prev_response_completed_at_ms = Some(10_000);
            // Ingress-time basis: the module clock runs 2h LATER than the proxy's
            // ingress observation (queue plus blocking-arm delay). A now-basis
            // implementation would render +2h here instead of +12m.
            active.request_observed_at_ms = Some(730_000);
            let first = transform(
                &s,
                &active,
                &pctx("git:proj", "/nonexistent-docs", 7_930_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&first, "m3"), "<!-- +12m -->\n§3§ question");
            active.prev_response_completed_at_ms = Some(800_000);
            let replay = transform(
                &s,
                &active,
                &pctx("git:proj", "/nonexistent-docs", 8_000_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&replay, "m3"), tail_bytes(&first, "m3"));

            let dormant = cc_req("temporal", "cfg0", complete);
            let false_window = transform(
                &s,
                &dormant,
                &pctx("git:proj", "/nonexistent-docs", 1_000_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&false_window, "m3"), "question");
        });
    }

    #[test]
    fn temporal_gap_trailing_role_system_reminder_keeps_authored_user_eligible() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let first = active_cc_req(
                "temporal-system-tail",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["start"])],
            );
            run(&s, &first, &spine());
            run(&s, &first, &spine());

            let mut request = active_cc_req(
                "temporal-system-tail",
                "cfg0",
                vec![
                    first.messages[0].clone(),
                    wire_item("assistant", "m2", 2, &["answer"]),
                    wire_item("user", "m3", 3, &["question"]),
                    system_item("reminder", 4, "transport reminder"),
                ],
            );
            request.prev_response_completed_at_ms = Some(10_000);
            request.request_observed_at_ms = Some(730_000);
            let response = transform(
                &s,
                &request,
                &pctx("git:proj", "/nonexistent-docs", 730_000),
            )
            .unwrap();
            assert_eq!(
                tail_bytes(&response, "m3"),
                "<!-- +12m -->\n§3§ question",
                "role=system reminders are skipped when resolving the authored tail"
            );
        });
    }

    #[test]
    fn temporal_gap_standalone_system_reminder_user_is_transport() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let first = active_cc_req(
                "temporal-user-reminder",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["start"])],
            );
            run(&s, &first, &spine());
            run(&s, &first, &spine());

            let mut request = active_cc_req(
                "temporal-user-reminder",
                "cfg0",
                vec![
                    first.messages[0].clone(),
                    wire_item("assistant", "m2", 2, &["answer"]),
                    wire_item("user", "m3", 3, &["question"]),
                    wire_item(
                        "user",
                        "reminder",
                        4,
                        &["<system-reminder>background work finished</system-reminder>"],
                    ),
                ],
            );
            request.prev_response_completed_at_ms = Some(10_000);
            request.request_observed_at_ms = Some(730_000);
            let response = transform(
                &s,
                &request,
                &pctx("git:proj", "/nonexistent-docs", 730_000),
            )
            .unwrap();
            assert_eq!(
                tail_bytes(&response, "m3"),
                "<!-- +12m -->\n§3§ question",
                "a standalone reminder-shaped user message is transport, not an authored tail"
            );
        });
    }

    #[test]
    fn temporal_gap_frontier_stays_before_a_mint_ineligible_user() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let request = active_cc_req(
                "temporal-frontier",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["question"])],
            );
            run(&s, &request, &spine());

            let loaded = s.load("temporal-frontier").unwrap();
            let mut core = loaded.core.clone();
            core.frozen_units
                .push(red_unit("m1#0", "drop", "[dropped]"));
            s.commit("temporal-frontier", loaded.row_version, &core, &loaded.meta)
                .unwrap();

            let mut gap_request = request.clone();
            gap_request.prev_response_completed_at_ms = Some(100_000);
            gap_request.request_observed_at_ms = Some(700_000);
            let skipped = transform(
                &s,
                &gap_request,
                &pctx("git:proj", "/nonexistent-docs", 700_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&skipped, "m1"), "[dropped]");
            assert!(s
                .load_temporal_marks("temporal-frontier")
                .unwrap()
                .is_empty());
            assert_eq!(s.overlay_watermark("temporal-frontier").unwrap(), None);

            let loaded = s.load("temporal-frontier").unwrap();
            let mut core = loaded.core.clone();
            core.frozen_units
                .retain(|unit| !unit.key.starts_with("red:"));
            s.commit("temporal-frontier", loaded.row_version, &core, &loaded.meta)
                .unwrap();
            let minted = transform(
                &s,
                &gap_request,
                &pctx("git:proj", "/nonexistent-docs", 700_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&minted, "m1"), "<!-- +10m -->\n§1§ question");
            assert_eq!(s.overlay_watermark("temporal-frontier").unwrap(), Some(1));
        });
    }

    #[test]
    fn sparse_temporal_decision_stays_frozen_when_an_older_ordinal_returns() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let first_messages = vec![wire_item("user", "m1", 1, &["start"])];
            let first_request = active_cc_req("temporal-sparse", "cfg0", first_messages.clone());
            run(&s, &first_request, &spine());
            run(&s, &first_request, &spine());

            let sparse = vec![
                first_messages[0].clone(),
                wire_item("user", "m3", 3, &["later"]),
            ];
            let sparse_request = active_cc_req("temporal-sparse", "cfg0", sparse.clone());
            let first = transform(
                &s,
                &sparse_request,
                &pctx("git:proj", "/nonexistent-docs", 721_000),
            )
            .unwrap();
            let frozen = tail_bytes(&first, "m3").to_string();
            assert_eq!(frozen, "§2§ later");

            let restored = active_cc_req(
                "temporal-sparse",
                "cfg0",
                vec![
                    sparse[0].clone(),
                    wire_item("assistant", "m2", 2, &["restored"]),
                    sparse[1].clone(),
                ],
            );
            let replay = transform(
                &s,
                &restored,
                &pctx("git:proj", "/nonexistent-docs", 1_500_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&replay, "m3").as_bytes(), frozen.as_bytes());
            assert!(s
                .load_temporal_marks("temporal-sparse")
                .unwrap()
                .iter()
                .all(|row| row.block_id != "m2#0"));

            let near = active_cc_req(
                "temporal-sparse",
                "cfg0",
                vec![
                    sparse[0].clone(),
                    restored.messages[1].clone(),
                    sparse[1].clone(),
                    wire_item("user", "m4", 4, &["nearby"]),
                ],
            );
            let near_response =
                transform(&s, &near, &pctx("git:proj", "/nonexistent-docs", 721_100)).unwrap();
            assert_eq!(tail_bytes(&near_response, "m4"), "§4§ nearby");
            let empty = s
                .load_temporal_marks("temporal-sparse")
                .unwrap()
                .into_iter()
                .find(|row| row.block_id == "m4#0")
                .expect("empty temporal decision");
            assert!(empty.marker_text.is_empty());

            let false_window = transform(
                &s,
                &cc_req("temporal-sparse", "cfg0", near.messages),
                &pctx("git:proj", "/nonexistent-docs", 2_000_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&false_window, "m3"), "later");
            assert_eq!(tail_bytes(&false_window, "m4"), "nearby");
        });
    }

    #[test]
    fn temporal_gap_midlife_activation_has_zero_gaps() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let messages = vec![
                wire_item("user", "m1", 1, &["old question"]),
                wire_item("assistant", "m2", 2, &["old answer"]),
                wire_item("user", "m3", 3, &["current question"]),
            ];
            let request = active_cc_req("temporal-midlife", "cfg0", messages);
            transform(
                &s,
                &request,
                &pctx("git:proj", "/nonexistent-docs", 600_000),
            )
            .unwrap();
            let active = transform(
                &s,
                &request,
                &pctx("git:proj", "/nonexistent-docs", 600_000),
            )
            .unwrap();
            assert_eq!(tail_bytes(&active, "m3"), "§3§ current question");
        });
    }

    #[test]
    fn temporal_gap_invalid_or_missing_observation_freezes_no_marker() {
        run_active_surface_test(|| {
            for (session, observed) in [
                ("temporal-absent", None),
                ("temporal-zero", Some(0)),
                ("temporal-equal", Some(600_000)),
                ("temporal-future", Some(600_001)),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let s = store(dir.path());
                let mut request = active_cc_req(
                    session,
                    "cfg0",
                    vec![wire_item("user", "m0", 0, &["question"])],
                );
                request.prev_response_completed_at_ms = observed;
                run(&s, &request, &spine());
                let response = transform(
                    &s,
                    &request,
                    &pctx("git:proj", "/nonexistent-docs", 600_000),
                )
                .unwrap();
                assert_eq!(tail_bytes(&response, "m0"), "§1§ question");
                assert_eq!(s.load_temporal_marks(session).unwrap()[0].marker_text, "");
            }
        });
    }

    #[test]
    fn v2_request_tolerates_absent_previous_response_completion() {
        let parsed: TransformRequest = serde_json::from_value(serde_json::json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "claude-code-anthropic",
            "session_id": "parse-gap",
            "render_config": "cfg",
            "messages": []
        }))
        .unwrap();
        assert_eq!(parsed.prev_response_completed_at_ms, None);
    }

    #[test]
    fn user_hint_query_strips_tags_reminders_and_caps_input() {
        let long_tail = "x".repeat(600);
        let message = wire_item(
            "user",
            "query",
            1,
            &[
                "§12§ keep <system-reminder>drop <system-reminder>nested</system-reminder> tail</system-reminder> words",
                &long_tail,
            ],
        );
        let query = user_hint_query(&message);
        assert_eq!(query, "keep words");
        assert!(!query.contains("§12§"));
        assert!(!query.contains("drop"));
        assert!(query.chars().count() < USER_HINT_QUERY_CHAR_CAP);
    }

    #[test]
    fn user_hint_is_computed_once_replayed_and_inactive_is_verbatim() {
        run_active_surface_test(|| {
            USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(0));
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "rust ownership uses borrowing safely",
                70,
            )
            .unwrap();
            seed_unrelated_hint_candidates(&s);
            let messages = vec![wire_item("user", "m1", 1, &["rust ownership"])];
            let request = active_cc_req("user-hint", "cfg0", messages.clone());
            run(&s, &request, &spine());
            let first = run(&s, &request, &spine());
            let expected_hint = "\n\n<ctx-search-hint>\nYour memory may contain related fragments:\n- rust ownership uses borrowing safely\nIf relevant, run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>";
            assert_eq!(
                tail_bytes(&first, "m1"),
                format!("§1§ rust ownership{expected_hint}")
            );
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 1);

            let replay = run(&s, &request, &spine());
            assert_eq!(tail_bytes(&replay, "m1"), tail_bytes(&first, "m1"));
            assert_eq!(
                USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get),
                1,
                "a durable row bypasses the lexical query on replay"
            );
            assert_eq!(s.load_user_hints("user-hint").unwrap().len(), 1);

            let dormant = cc_req("user-hint", "cfg0", messages);
            let false_window = run(&s, &dormant, &spine());
            assert_eq!(tail_bytes(&false_window, "m1"), "rust ownership");
        });
    }

    #[test]
    fn empty_user_hint_decision_skips_future_queries() {
        run_active_surface_test(|| {
            USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(0));
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let request = active_cc_req(
                "empty-user-hint",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["no matching fragment"])],
            );
            run(&s, &request, &spine());
            let first = run(&s, &request, &spine());
            assert_eq!(tail_bytes(&first, "m1"), "§1§ no matching fragment");
            let decisions = s.load_user_hints("empty-user-hint").unwrap();
            assert_eq!(decisions.len(), 1);
            assert!(decisions[0].hint_text.is_empty());
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 1);

            run(&s, &request, &spine());
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 1);
        });
    }

    #[test]
    fn buried_user_does_not_mint_a_hint_or_backfill_later() {
        run_active_surface_test(|| {
            USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(0));
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "newer prompt carries related durable context",
                70,
            )
            .unwrap();
            let both = vec![
                wire_item("user", "m1", 1, &["older prompt"]),
                wire_item("user", "m2", 2, &["newer prompt"]),
                wire_item("assistant", "m3", 3, &["trailing answer"]),
            ];
            let request = active_cc_req("hint-frontier", "cfg0", both);
            run(&s, &request, &spine());
            run(&s, &request, &spine());
            assert!(s.load_user_hints("hint-frontier").unwrap().is_empty());
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 0);
            assert_eq!(s.overlay_watermark("hint-frontier").unwrap(), Some(2));

            let older_only = active_cc_req(
                "hint-frontier",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["older prompt"])],
            );
            let response = run(&s, &older_only, &spine());
            assert_eq!(tail_bytes(&response, "m1"), "§1§ older prompt");
            assert!(s.load_user_hints("hint-frontier").unwrap().is_empty());
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 0);
        });
    }

    #[test]
    fn ordinal_zero_user_is_eligible_on_a_fresh_frontier() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "rust ownership uses borrowing safely",
                70,
            )
            .unwrap();
            seed_unrelated_hint_candidates(&s);
            let request = active_cc_req(
                "zero-frontier",
                "cfg0",
                vec![wire_item("user", "m0", 0, &["rust ownership"])],
            );
            run(&s, &request, &spine());
            let active = run(&s, &request, &spine());
            assert!(tail_bytes(&active, "m0").contains("<ctx-search-hint>"));
            assert_eq!(s.overlay_watermark("zero-frontier").unwrap(), Some(0));
            assert_eq!(
                s.load_user_hints("zero-frontier").unwrap()[0].block_id,
                "m0#0"
            );
        });
    }

    #[test]
    fn authored_tail_skips_tool_result_blocks_for_both_wire_roles() {
        let user = wire_item("user", "m1", 1, &["authored"]);
        let role_tool = active_cc_req(
            "tool-tail",
            "cfg0",
            vec![
                user.clone(),
                tool_result("result-tool", 2, "call", "output"),
            ],
        );
        assert_eq!(eligible_authored_user_tail(&role_tool).unwrap().mid, "m1");

        let role_user = active_cc_req(
            "user-result-tail",
            "cfg0",
            vec![
                user,
                wire_tool_result(
                    "result-user",
                    2,
                    json!({ "kind": { "type": "text", "text": "output" } }),
                ),
            ],
        );
        assert_eq!(eligible_authored_user_tail(&role_user).unwrap().mid, "m1");
        assert!(!is_authored_user_message(&role_user.messages[1]));
    }

    #[test]
    fn trailing_tool_role_transport_keeps_authored_user_eligible() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let store = store(dir.path());
            store
                .seed_memory(
                    1,
                    "git:proj",
                    "CONSTRAINTS",
                    "rust ownership uses borrowing safely",
                    70,
                )
                .unwrap();
            seed_unrelated_hint_candidates(&store);
            let request = active_cc_req(
                "tool-role-tail",
                "cfg0",
                vec![
                    wire_item("user", "m1", 1, &["rust ownership"]),
                    wire_item("tool", "result", 2, &["transport output"]),
                ],
            );
            run(&store, &request, &spine());
            let response = run(&store, &request, &spine());
            assert!(tail_bytes(&response, "m1").contains("<ctx-search-hint>"));
            assert_eq!(store.overlay_watermark("tool-role-tail").unwrap(), Some(1));
        });
    }

    #[test]
    fn user_role_result_carrier_neither_targets_overlays_nor_burns_frontier() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let store = store(dir.path());
            store
                .seed_memory(
                    1,
                    "git:proj",
                    "CONSTRAINTS",
                    "rust ownership uses borrowing safely",
                    70,
                )
                .unwrap();
            seed_unrelated_hint_candidates(&store);
            let mut request = active_cc_req(
                "user-result-tail",
                "cfg0",
                vec![
                    wire_item("user", "m1", 1, &["rust ownership"]),
                    opaque_result_carrier("result", 2, "user"),
                ],
            );
            request.prev_response_completed_at_ms = Some(1);
            run(&store, &request, &spine());
            let response = transform(
                &store,
                &request,
                &pctx("git:proj", "/nonexistent-docs", 700_000),
            )
            .unwrap();
            assert!(tail_bytes(&response, "m1").contains("<ctx-search-hint>"));
            assert_eq!(
                store.overlay_watermark("user-result-tail").unwrap(),
                Some(1)
            );
            assert_eq!(
                store
                    .load_temporal_marks("user-result-tail")
                    .unwrap()
                    .iter()
                    .map(|row| row.block_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["m1#0"]
            );
            let result = response
                .messages()
                .iter()
                .find(|message| message.meta.harness_id.as_deref() == Some("result"))
                .expect("result carrier remains in the tail");
            assert!(matches!(
                &result.content[0].kind,
                ck_wire::CkKind::Opaque(opaque) if opaque.raw == json!({ "output": "transport" })
            ));
        });
    }

    #[test]
    fn lexical_hint_scoring_requires_two_specific_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        for id in 1..=30 {
            let content = if id == 1 {
                "rust ownership borrowing safely across async tasks".to_string()
            } else if id == 2 {
                "quasar appears in an otherwise unrelated archive".to_string()
            } else {
                format!("fixture memory {id} about ordinary unrelated material")
            };
            s.seed_memory(id, "git:proj", "CONSTRAINTS", &content, 50)
                .unwrap();
        }

        let related =
            run_user_hint_lexical_search(&s, "git:proj", "lexical", "rust ownership", true)
                .unwrap();
        assert_eq!(related[0].id, 1);
        let unrelated =
            run_user_hint_lexical_search(&s, "git:proj", "lexical", "galaxy telescope", true)
                .unwrap();
        assert!(unrelated.is_empty());
        let one_common_token =
            run_user_hint_lexical_search(&s, "git:proj", "lexical", "quasar deployment", true)
                .unwrap();
        assert!(one_common_token.is_empty());
        let ubiquitous_tokens =
            run_user_hint_lexical_search(&s, "git:proj", "lexical", "fixture memory", true)
                .unwrap();
        assert!(
            ubiquitous_tokens.is_empty(),
            "matches need at least one token present in less than half the candidate pool"
        );
    }

    #[test]
    fn user_hint_query_drops_a_token_split_by_the_character_cap() {
        let complete_prefix = "word ".repeat(99);
        let split = format!("{complete_prefix}partialtoken suffix");
        let query = user_hint_query(&wire_item("user", "m1", 1, &[&split]));
        assert_eq!(query, complete_prefix.trim_end());
        assert!(!query.contains("parti"));
    }

    #[test]
    fn user_hint_targets_first_text_after_media() {
        run_active_surface_test(|| {
            USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(0));
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "media prompt has a remembered fragment",
                70,
            )
            .unwrap();
            seed_unrelated_hint_candidates(&s);
            let mut message = wire_item("user", "m1", 1, &["media prompt"]);
            message.ck.content.insert(
                0,
                CkWireBlock::bare(ck_wire::CkKind::Media(ck_wire::MediaBlock {
                    kind: ck_wire::MediaKind::Image,
                    media_type: "image/png".to_string(),
                    filename: None,
                    source: serde_json::json!({"type": "base64", "data": "AA=="}),
                })),
            );
            let request = active_cc_req("media-hint", "cfg0", vec![message]);
            run(&s, &request, &spine());
            let response = run(&s, &request, &spine());
            let rendered = response
                .messages()
                .iter()
                .find(|message| message.meta.harness_id.as_deref() == Some("m1"))
                .unwrap();
            let ck_wire::CkKind::Text { text } = &rendered.content[1].kind else {
                panic!("second block must remain text");
            };
            assert!(text.starts_with("§1§ media prompt"));
            assert!(text.contains("<ctx-search-hint>"));
            assert_eq!(s.load_user_hints("media-hint").unwrap()[0].block_id, "m1#1");
        });
    }

    #[test]
    fn pending_rewrite_passthrough_replays_only_existing_overlays() {
        run_active_surface_test(|| {
            USER_HINT_LEXICAL_QUERY_COUNT.with(|count| count.set(0));
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "foreign prompt has durable context",
                70,
            )
            .unwrap();
            s.seed_memory(
                2,
                "git:proj",
                "CONSTRAINTS",
                "unrelated fixture material",
                50,
            )
            .unwrap();
            s.replace_compartments("pending-hint", &[comp(1, 1, 2, "t2#0", "summary")])
                .unwrap();
            let present = active_cc_req(
                "pending-hint",
                "cfg0",
                vec![
                    wire_item("assistant", "t2", 2, &["covered"]),
                    wire_item("assistant", "t3", 3, &["tail"]),
                ],
            );
            run(&s, &present, &spine());
            run(&s, &present, &spine());
            let mut loaded = s.load("pending-hint").unwrap();
            loaded.meta.pending_rewrite = Some(PendingRewriteState {
                armed_at_ms: 1,
                absent_shape_fingerprint: "held".to_string(),
                absent_request_count: 1,
                last_present_at_ms: Some(1),
            });
            s.commit(
                "pending-hint",
                loaded.row_version,
                &loaded.core,
                &loaded.meta,
            )
            .unwrap();

            let absent = active_cc_req(
                "pending-hint",
                "cfg0",
                vec![wire_item("user", "foreign", 50, &["foreign prompt"])],
            );
            let response = run(&s, &absent, &spine());
            assert_eq!(response.action, "PASSTHROUGH");
            assert!(!tail_bytes(&response, "foreign").contains("<ctx-search-hint>"));
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 0);
            assert!(s.load_user_hints("pending-hint").unwrap().is_empty());
            assert_eq!(s.overlay_watermark("pending-hint").unwrap(), None);

            let accepted = active_cc_req(
                "pending-hint",
                "cfg0",
                vec![
                    present.messages[0].clone(),
                    present.messages[1].clone(),
                    wire_item("user", "foreign", 50, &["foreign prompt"]),
                ],
            );
            let active = run(&s, &accepted, &spine());
            assert!(tail_bytes(&active, "foreign").contains("<ctx-search-hint>"));
            assert_eq!(USER_HINT_LEXICAL_QUERY_COUNT.with(std::cell::Cell::get), 1);
            assert_eq!(
                s.load_user_hints("pending-hint").unwrap()[0].block_id,
                "foreign#0"
            );
        });
    }

    #[test]
    fn mint_scope_matches_overlay_scope_and_captures_exact_source() {
        run_active_surface_test(|| {
            let content_text = ck_wire::ResultBlock {
                kind: ck_wire::ResultBlockKind::Text {
                    text: "  content §9§".to_string(),
                },
                provider_extras: ck_wire::ProviderExtras::new(),
            };
            let messages = vec![
                item("m1", 1, "  user §7§"),
                assistant_tool_call("call1", 2, "c1"),
                tool_result("text", 3, "c1", "  text output"),
                assistant_tool_call("call2", 4, "c2"),
                tool_result_with_output(
                    "error-text",
                    5,
                    "c2",
                    ck_wire::CkOutputKind::ErrorText {
                        text: "error output".to_string(),
                    },
                ),
                assistant_tool_call("call3", 6, "c3"),
                tool_result_with_output(
                    "json",
                    7,
                    "c3",
                    ck_wire::CkOutputKind::Json {
                        value: json!({"x": 1}),
                    },
                ),
                assistant_tool_call("call4", 8, "c4"),
                tool_result_with_output(
                    "error-json",
                    9,
                    "c4",
                    ck_wire::CkOutputKind::ErrorJson {
                        value: json!({"x": 2}),
                    },
                ),
                assistant_tool_call("call5", 10, "c5"),
                tool_result_with_output(
                    "denied",
                    11,
                    "c5",
                    ck_wire::CkOutputKind::ExecutionDenied {
                        reason: Some("no".to_string()),
                    },
                ),
                assistant_tool_call("call6", 12, "c6"),
                tool_result_with_output(
                    "content",
                    13,
                    "c6",
                    ck_wire::CkOutputKind::Content {
                        blocks: vec![content_text],
                    },
                ),
                assistant_tool_call("call7", 14, "c7"),
                tool_result_with_output(
                    "empty-content",
                    15,
                    "c7",
                    ck_wire::CkOutputKind::Content { blocks: Vec::new() },
                ),
            ];
            let request = active_cc_req("scope", "cfg0", messages.clone());
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            run(&s, &request, &spine());
            let response = run(&s, &request, &spine());
            let rows = s.load_tags_for_session("scope").unwrap();
            assert_eq!(
                rows.iter()
                    .map(|row| row.block_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["m1#0", "text#0", "error-text#0", "content#0"]
            );
            let projection = project_messages(&messages).unwrap();
            for row in &rows {
                let block = projection
                    .blocks
                    .iter()
                    .find(|block| block.id == row.block_id)
                    .unwrap();
                let (_, source) = taggable_source(block).expect("minted tags must be overlayable");
                assert_eq!(row.source_bytes, source.as_bytes());
            }
            assert_eq!(tail_bytes(&response, "m1"), "§1§   user §7§");
            assert_eq!(tail_bytes(&response, "text"), "§2§   text output");
            assert_eq!(tail_bytes(&response, "error-text"), "§3§ error output");
            assert_eq!(tail_bytes(&response, "content"), "§4§   content §9§");
        });
    }

    #[test]
    fn tag_minting_is_deterministic_and_rejected_pass_is_speculative() {
        run_active_surface_test(|| {
            let messages = vec![
                item("m1", 1, "hello"),
                assistant_tool_call("call", 2, "c1"),
                tool_result("result", 3, "c1", "tool output"),
            ];
            let dir_a = tempfile::tempdir().unwrap();
            let store_a = store(dir_a.path());
            run(
                &store_a,
                &active_cc_req("mint", "cfg0", messages.clone()),
                &spine(),
            );
            assert!(store_a.load_tags_for_session("mint").unwrap().is_empty());
            run(
                &store_a,
                &active_cc_req("mint", "cfg0", messages.clone()),
                &spine(),
            );
            let first = store_a.load_tags_for_session("mint").unwrap();
            assert_eq!(
                first
                    .iter()
                    .map(|row| (row.tag_number, row.block_id.as_str(), row.kind.as_str()))
                    .collect::<Vec<_>>(),
                vec![(1, "m1#0", "message"), (2, "result#0", "tool_result")]
            );
            run(
                &store_a,
                &active_cc_req("mint", "cfg0", messages.clone()),
                &spine(),
            );
            assert_eq!(store_a.load_tags_for_session("mint").unwrap(), first);

            let dir_b = tempfile::tempdir().unwrap();
            let store_b = store(dir_b.path());
            run(
                &store_b,
                &active_cc_req("mint", "cfg0", messages.clone()),
                &spine(),
            );
            run(&store_b, &active_cc_req("mint", "cfg0", messages), &spine());
            assert_eq!(store_b.load_tags_for_session("mint").unwrap(), first);

            let dir_c = tempfile::tempdir().unwrap();
            let store_c = store(dir_c.path());
            let stable = active_cc_req("reject", "cfg0", vec![item("m1", 1, "old")]);
            run(&store_c, &stable, &spine());
            run(&store_c, &stable, &spine());
            let err = transform(
                &store_c,
                &active_cc_req(
                    "reject",
                    "cfg0",
                    vec![item("m1", 1, "changed identity"), item("m2", 2, "new")],
                ),
                &pctx("git:proj", "/nonexistent-docs", 0),
            )
            .unwrap_err();
            assert!(matches!(err, TransformError::IdentityDrift(_)));
            let tags = store_c.load_tags_for_session("reject").unwrap();
            assert_eq!(
                tags.iter()
                    .map(|row| row.block_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["m1#0"]
            );
        });
    }

    #[test]
    fn boundary_rejection_leaves_all_overlay_decisions_uncommitted() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.seed_memory(
                1,
                "git:proj",
                "CONSTRAINTS",
                "rust ownership durable context",
                70,
            )
            .unwrap();
            s.seed_memory(
                2,
                "git:proj",
                "CONSTRAINTS",
                "unrelated fixture material",
                50,
            )
            .unwrap();
            let baseline = active_cc_req(
                "overlay-reject",
                "cfg0",
                vec![wire_item("user", "m1", 1, &["baseline prompt"])],
            );
            run(&s, &baseline, &spine());
            run(&s, &baseline, &spine());
            let tags_before = s.load_tags_for_session("overlay-reject").unwrap();
            let hints_before = s.load_user_hints("overlay-reject").unwrap();
            let temporal_before = s.load_temporal_marks("overlay-reject").unwrap();
            let channel1_before = s.load_channel1_appends("overlay-reject").unwrap();
            let frontier_before = s.overlay_watermark("overlay-reject").unwrap();

            s.replace_compartments(
                "overlay-reject",
                &[comp(1, 3, 3, "m3#0", "only the last message")],
            )
            .unwrap();
            let mut rejected = active_cc_req(
                "overlay-reject",
                "cfg0",
                vec![
                    baseline.messages[0].clone(),
                    wire_item("assistant", "m2", 2, &["answer"]),
                    wire_item("user", "m3", 3, &["rust ownership"]),
                ],
            );
            rejected.prev_response_completed_at_ms = Some(1);
            let error = transform(
                &s,
                &rejected,
                &pctx("git:proj", "/nonexistent-docs", 700_000),
            )
            .unwrap_err();
            assert!(matches!(error, TransformError::CoverageGap(_)));
            assert_eq!(
                s.load_tags_for_session("overlay-reject").unwrap(),
                tags_before
            );
            assert_eq!(s.load_user_hints("overlay-reject").unwrap(), hints_before);
            assert_eq!(
                s.load_temporal_marks("overlay-reject").unwrap(),
                temporal_before
            );
            assert_eq!(
                s.overlay_watermark("overlay-reject").unwrap(),
                frontier_before
            );
            assert_eq!(
                s.load_channel1_appends("overlay-reject").unwrap(),
                channel1_before
            );

            s.replace_compartments("overlay-reject", &[comp(1, 1, 3, "m3#0", "complete range")])
                .unwrap();
            transform(
                &s,
                &rejected,
                &pctx("git:proj", "/nonexistent-docs", 700_000),
            )
            .unwrap();
            assert!(s
                .load_user_hints("overlay-reject")
                .unwrap()
                .iter()
                .any(|row| row.block_id == "m3#0" && !row.hint_text.is_empty()));
            assert_eq!(s.overlay_watermark("overlay-reject").unwrap(), Some(3));
            assert!(s
                .load_temporal_marks("overlay-reject")
                .unwrap()
                .iter()
                .any(|row| row.block_id == "m3#0"));
        });
    }

    #[test]
    fn tag_overlay_replays_stably_and_new_tail_gets_next_number() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let first_req = active_cc_req("stable", "cfg0", vec![item("m1", 1, "alpha")]);
            let transition = run(&s, &first_req, &spine());
            assert_eq!(tail_bytes(&transition, "m1"), "alpha");
            let first = run(&s, &first_req, &spine());
            let replay = run(&s, &first_req, &spine());
            assert_eq!(tail_bytes(&first, "m1"), "§1§ alpha");
            assert_eq!(tail_bytes(&first, "m1"), tail_bytes(&replay, "m1"));

            let extended = run(
                &s,
                &active_cc_req(
                    "stable",
                    "cfg0",
                    vec![item("m1", 1, "alpha"), item("m2", 2, "beta")],
                ),
                &spine(),
            );
            assert_eq!(tail_bytes(&extended, "m1"), "§1§ alpha");
            assert_eq!(tail_bytes(&extended, "m2"), "§2§ beta");
        });
    }

    #[test]
    fn reduced_block_renders_placeholder_without_tag_prefix() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            s.replace_compartments("drop-tag", &[comp(1, 1, 1, "a", "SUMMARY")])
                .unwrap();
            let request = active_cc_req(
                "drop-tag",
                "cfg0",
                vec![
                    item("a", 1, "covered"),
                    item("m1", 2, "drop me"),
                    item("m2", 3, "keep me"),
                ],
            );
            run(&s, &request, &spine());
            let active = run(&s, &request, &spine());
            assert_eq!(tail_bytes(&active, "m1"), "§2§ drop me");
            let reductions = with_reductions(vec![reduce("m1#0", "drop", "[dropped]")]);
            let response = run(&s, &request, &reductions);
            assert_eq!(response.action, "SOFT");
            assert_eq!(tail_bytes(&response, "m1"), "[dropped §2§]");
            assert_eq!(tail_bytes(&response, "m2"), "§3§ keep me");
        });
    }

    #[test]
    fn channel1_nudge_replays_and_suppresses_refire() {
        run_active_surface_test(|| {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let huge = "word ".repeat(20_000);
            let messages = vec![
                assistant_tool_call("call1", 1, "c1"),
                tool_result("result1", 2, "c1", &huge),
                assistant_tool_call("call2", 3, "c2"),
                tool_result("result2", 4, "c2", &huge),
            ];
            let request = with_usage(active_cc_req("nudge", "cfg0", messages.clone()), 900, 1024);
            run(&s, &request, &spine());
            let first = run(&s, &request, &spine());
            let first_result = tail_bytes(&first, "result2").to_string();
            assert!(first_result.contains("<system-reminder>"));
            assert_eq!(s.load_channel1_appends("nudge").unwrap().len(), 1);

            let replay = run(&s, &request, &spine());
            assert_eq!(tail_bytes(&replay, "result2"), first_result);
            assert_eq!(s.load_channel1_appends("nudge").unwrap().len(), 1);

            let mut loaded = s.load("nudge").unwrap();
            loaded.meta.channel1_reduce_suppressed = true;
            s.commit("nudge", loaded.row_version, &loaded.core, &loaded.meta)
                .unwrap();
            let mut extended_messages = messages;
            extended_messages.push(assistant_tool_call("call3", 5, "c3"));
            extended_messages.push(tool_result("result3", 6, "c3", &huge));
            let suppressed = run(
                &s,
                &with_usage(active_cc_req("nudge", "cfg0", extended_messages), 900, 1024),
                &spine(),
            );
            assert!(tail_bytes(&suppressed, "result2").contains("<system-reminder>"));
            assert!(!tail_bytes(&suppressed, "result3").contains("<system-reminder>"));
            assert_eq!(s.load_channel1_appends("nudge").unwrap().len(), 1);
        });
    }

    #[test]
    fn subc_reversibility_false_pass_has_no_tag_bytes_in_any_durable_input() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .replace_compartments("false-bytes", &[comp(1, 1, 1, "a", "summary")])
            .unwrap();
        let request = cc_req(
            "false-bytes",
            "cfg0",
            vec![item("a", 1, "covered"), item("b", 2, "live")],
        );

        let response = run(&store, &request, &spine());
        let loaded = store.load("false-bytes").unwrap();
        let compartments = store.load_compartments("false-bytes").unwrap();
        assert!(!compartments.is_empty());
        for durable_or_output in [
            serde_json::to_string(&request).unwrap(),
            serde_json::to_string(&response).unwrap(),
            serde_json::to_string(&loaded.core).unwrap(),
            serde_json::to_string(&loaded.meta).unwrap(),
            format!("{compartments:?}"),
        ] {
            assert!(!durable_or_output.contains('§'), "{durable_or_output}");
        }
        assert!(store
            .load_tags_for_session("false-bytes")
            .unwrap()
            .is_empty());
        assert_eq!(response.surface_state, SurfaceState::Inactive);
    }

    #[test]
    fn subc_reversibility_surface_flip_coordinates_exactly_one_hard() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let messages = vec![item("m1", 1, "hello")];
        let mut inactive = cc_req("surface-flip", "profile␟tf0␟gno-reduce", messages.clone());
        let initial = run(&store, &inactive, &spine());
        assert_eq!(initial.action, "HARD");
        assert_eq!(initial.surface_state, SurfaceState::Inactive);

        let active = active_cc_req("surface-flip", "profile␟tf1␟gfull", messages.clone());
        let on_transition = run(&store, &active, &spine());
        assert_eq!(on_transition.action, "HARD");
        assert_eq!(on_transition.surface_state, SurfaceState::Transition);
        let on_config = store.load("surface-flip").unwrap().meta.last_render_config;
        assert!(on_config.contains("tf1"));
        assert!(on_config.contains("gfull"));
        assert!(on_config.contains("tfe:4:tfe3"));
        let on_steady = run(&store, &active, &spine());
        assert_ne!(on_steady.action, "HARD");
        assert_eq!(on_steady.surface_state, SurfaceState::Active);

        inactive.render_config = "profile␟tf0␟gno-reduce".to_string();
        let off_transition = run(&store, &inactive, &spine());
        assert_eq!(off_transition.action, "HARD");
        assert_eq!(off_transition.surface_state, SurfaceState::Transition);
        let off_config = store.load("surface-flip").unwrap().meta.last_render_config;
        assert!(off_config.contains("tf0"));
        assert!(off_config.contains("gno-reduce"));
        assert!(!off_config.contains("tfe:"));
        let off_steady = run(&store, &inactive, &spine());
        assert_ne!(off_steady.action, "HARD");
        assert_eq!(off_steady.surface_state, SurfaceState::Inactive);

        assert!(active.tool_present && !inactive.tool_present);
    }

    #[test]
    fn subc_reversibility_pending_drop_survives_an_entire_false_window() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let messages = (1..=30)
            .map(|ordinal| item(&format!("m{ordinal}"), ordinal, "old live content"))
            .collect::<Vec<_>>();
        let mut inactive = cc_req("false-window", "cfg0", messages.clone());
        run(&store, &inactive, &spine());
        store
            .append_pending_agent_drops("false-window", &["m1#0".to_string()], 1)
            .unwrap();

        for pass in 1..=4 {
            inactive.render_config = format!("cfg{pass}");
            let response = run(&store, &with_usage(inactive.clone(), 99, 100), &spine());
            assert_eq!(response.action, "HARD");
            assert_eq!(
                frozen_red_payload(&store.load("false-window").unwrap().core, "m1#0"),
                None
            );
            assert_eq!(
                store
                    .load_pending_agent_drops("false-window")
                    .unwrap()
                    .len(),
                1
            );
        }

        let active = active_cc_req("false-window", &inactive.render_config, messages);
        let applied = run(&store, &active, &spine());
        assert_eq!(applied.action, "HARD");
        assert_eq!(
            frozen_red_payload(&store.load("false-window").unwrap().core, "m1#0"),
            Some("[dropped]")
        );
        assert!(store
            .load_pending_agent_drops("false-window")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn subc_reversibility_true_reduction_stays_canonical_after_false_flip() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .replace_compartments("canonical-flip", &[comp(1, 1, 1, "a", "summary")])
            .unwrap();
        let active = active_cc_req(
            "canonical-flip",
            "cfg0",
            vec![item("a", 1, "covered"), item("m1", 2, "drop me")],
        );
        run(&store, &active, &spine());
        run(&store, &active, &spine());
        let reduced = run(&store, &active, &[reduce("m1#0", "drop", "[dropped]")]);
        assert_eq!(tail_bytes(&reduced, "m1"), "[dropped §2§]");
        assert_eq!(
            frozen_red_payload(&store.load("canonical-flip").unwrap().core, "m1#0"),
            Some("[dropped]")
        );

        let inactive = cc_req(
            "canonical-flip",
            "cfg0",
            vec![item("a", 1, "covered"), item("m1", 2, "drop me")],
        );
        let transition = run(&store, &inactive, &spine());
        assert_eq!(transition.action, "HARD");
        assert_eq!(transition.surface_state, SurfaceState::Transition);
        assert_eq!(tail_bytes(&transition, "m1"), "[dropped]");
        let loaded = store.load("canonical-flip").unwrap();
        assert_eq!(frozen_red_payload(&loaded.core, "m1#0"), Some("[dropped]"));
        assert!(loaded
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:m1#0"));
    }

    #[test]
    fn held_agent_remainder_keeps_full_rendered_output_byte_stable() {
        let dir = tempfile::tempdir().unwrap();
        let initial_store = store(dir.path());
        let messages = vec![
            item("covered", 0, "covered"),
            item("first", 1, "first"),
            item("held", 2, "held"),
        ];
        initial_store
            .replace_compartments("held-output", &[comp(1, 0, 0, "covered", "summary")])
            .unwrap();
        let stable_request = active_cc_req("held-output", "cfg0", messages.clone());
        run(&initial_store, &stable_request, &spine());
        let baseline = run(&initial_store, &stable_request, &spine());
        let baseline_bytes = serde_json::to_vec(&baseline.ck_messages).unwrap();

        initial_store
            .append_pending_agent_drops_with_command(
                "held-output",
                Some("command-a"),
                &["first#0".to_string(), "held#0".to_string()],
                1,
            )
            .unwrap();
        let pending = initial_store
            .load_pending_agent_drops("held-output")
            .unwrap();
        let loaded = initial_store.load("held-output").unwrap();
        let command_ids = vec!["command-a".to_string()];
        initial_store
            .commit_transform(
                "held-output",
                TransformCommit {
                    expected: loaded.row_version,
                    core: &loaded.core,
                    meta: &loaded.meta,
                    consumed_drop_ids: &[pending[0].id],
                    first_applied_command_ids: &command_ids,
                    memory_revision: None,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap();
        drop(initial_store);
        let store_after_restart = store(dir.path());

        for pass in 0..3 {
            let response = run(
                &store_after_restart,
                &with_usage(stable_request.clone(), 70, 100),
                &spine(),
            );
            assert_eq!(
                serde_json::to_vec(&response.ck_messages).unwrap(),
                baseline_bytes,
                "held work must not rewrite the full rendered array on stable pass {pass}"
            );
            assert!(
                frozen_red_payload(
                    &store_after_restart.load("held-output").unwrap().core,
                    "held#0",
                )
                .is_none(),
                "a held remainder must remain unfrozen until a ride opportunity"
            );
        }
    }

    #[test]
    fn another_command_rides_held_remainder_in_one_full_array_bust() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut messages = vec![
            item("covered", 0, "covered"),
            item("a-held", 1, "a held"),
            item("b-first", 2, "b first"),
            item("a-first", 3, "a first"),
        ];
        store
            .replace_compartments("ride-output", &[comp(1, 0, 0, "covered", "summary")])
            .unwrap();
        messages.extend((4..=22).map(|ordinal| {
            item(
                &format!("filler-{ordinal}"),
                ordinal,
                &format!("filler {ordinal}"),
            )
        }));
        let stable_request = active_cc_req("ride-output", "cfg0", messages.clone());
        run(&store, &stable_request, &spine());
        let baseline = run(&store, &stable_request, &spine());
        let baseline_bytes = serde_json::to_vec(&baseline.ck_messages).unwrap();

        store
            .append_pending_agent_drops_with_command(
                "ride-output",
                Some("command-a"),
                &["a-first#0".to_string(), "a-held#0".to_string()],
                1,
            )
            .unwrap();
        let pending_a = store.load_pending_agent_drops("ride-output").unwrap();
        let loaded = store.load("ride-output").unwrap();
        let command_a = vec!["command-a".to_string()];
        store
            .commit_transform(
                "ride-output",
                TransformCommit {
                    expected: loaded.row_version,
                    core: &loaded.core,
                    meta: &loaded.meta,
                    consumed_drop_ids: &[pending_a[0].id],
                    first_applied_command_ids: &command_a,
                    memory_revision: None,
                    overlays: TransformOverlayBatch::default(),
                },
            )
            .unwrap();
        store
            .append_pending_agent_drops_with_command(
                "ride-output",
                Some("command-b"),
                &["b-first#0".to_string()],
                2,
            )
            .unwrap();

        let ride = run(
            &store,
            &with_usage(stable_request.clone(), 70, 100),
            &spine(),
        );
        assert_eq!(ride.action, "SOFT", "ride response: {ride:?}");
        let ride_bytes = serde_json::to_vec(&ride.ck_messages).unwrap();
        assert_ne!(
            ride_bytes, baseline_bytes,
            "the ride pass must be the one bust"
        );
        let frozen = store.load("ride-output").unwrap().core;
        assert!(frozen_red_payload(&frozen, "a-held#0").is_some());
        assert!(frozen_red_payload(&frozen, "b-first#0").is_some());

        let replay = run(&store, &with_usage(stable_request, 70, 100), &spine());
        let replay_bytes = serde_json::to_vec(&replay.ck_messages).unwrap();
        assert_eq!(replay_bytes, ride_bytes);
        let distinct_byte_changing_passes = [baseline_bytes, ride_bytes, replay_bytes]
            .windows(2)
            .filter(|pair| pair[0] != pair[1])
            .count();
        assert!(
            distinct_byte_changing_passes <= 2,
            "two commands may cause at most two self-caused busts"
        );
    }

    #[test]
    fn newest_tag_block_set_isolates_protected_and_applied_pending_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // The protected set is the newest 20 ACTIVE tags as exact block ids.
        // This fixture is built so every cheaper implementation class fails at
        // the rank-20 boundary itself, not just at the extremes:
        //   - ACTIVE numbers have holes: m23#0 is stale-provenance and three
        //     "ghost" rows hold the TOP numbers (26-28) for blocks absent from
        //     the array, so any numeric-threshold cutoff (from the active max
        //     or the global max) lands on the wrong rows.
        //   - Ordinal 24 carries TWO tagged blocks (m24#0, m24#1), so
        //     one-block-per-ordinal counting shifts the boundary by one.
        // Active numbers: {1..22, 24, 25} (24 rows). Newest 20 by number:
        // {5..22, 24, 25} — the boundary pair is number 5 (rank 20, protected)
        // vs number 4 (rank 21, applied), and both carry pending drops.
        let mut messages = (1..=24)
            .map(|ordinal| item(&format!("m{ordinal}"), ordinal, &format!("text {ordinal}")))
            .collect::<Vec<_>>();
        messages[23] = two_block_item("m24", 24, "text 24", "attachment 24");

        let mut tags = (1..=24)
            .map(|ordinal| TagMintInput {
                block_id: format!("m{ordinal}#0"),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: if ordinal == 23 {
                    // Stale provenance: stored bytes no longer match the live
                    // carrier, so this row must not occupy a protected slot.
                    b"text from a previous life".to_vec()
                } else {
                    format!("text {ordinal}").into_bytes()
                },
            })
            .collect::<Vec<_>>();
        tags.push(TagMintInput {
            block_id: "m24#1".to_string(),
            kind: "message".to_string(),
            token_count: 1,
            source_bytes: b"attachment 24".to_vec(),
        });
        for ghost in 1..=3 {
            tags.push(TagMintInput {
                block_id: format!("ghost{ghost}#0"),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: b"ghost".to_vec(),
            });
        }
        store.seed_tags_for_test("protected", &tags, 1).unwrap();
        store
            .append_pending_agent_drops_with_command(
                "protected",
                Some("range-command"),
                &["m4#0".to_string(), "m5#0".to_string(), "m24#1".to_string()],
                99,
            )
            .unwrap();

        let response = run(
            &store,
            &active_cc_req("protected", "cfg0", messages),
            &spine(),
        );
        assert_eq!(response.action, "HARD");
        let loaded = store.load("protected").unwrap();
        // Rank 21 (number 4) is just outside the protected set: applied.
        assert_eq!(frozen_red_payload(&loaded.core, "m4#0"), Some("[dropped]"));
        // Rank 20 (number 5) is the last protected slot: retained. Under a
        // threshold cutoff (active-max 25 - 20, or global-max 28 - 20) or
        // one-per-ordinal counting this row loses protection and applies.
        assert_eq!(frozen_red_payload(&loaded.core, "m5#0"), None);
        // The second block on ordinal 24 is itself active and protected; an
        // implementation that counts one block per ordinal applies this drop.
        assert_eq!(frozen_red_payload(&loaded.core, "m24#1"), None);
        let mut retained = store
            .load_pending_agent_drops("protected")
            .unwrap()
            .into_iter()
            .map(|row| row.target_id)
            .collect::<Vec<_>>();
        retained.sort();
        assert_eq!(retained, vec!["m24#1".to_string(), "m5#0".to_string()]);
        let pending = store.load_pending_agent_drops("protected").unwrap();
        assert!(pending.iter().all(|row| {
            row.command_id.as_deref() == Some("range-command")
                && row.command_first_applied_at_ms.is_some()
        }));
        let replay = store
            .append_pending_agent_drops_with_command(
                "protected",
                Some("range-command"),
                &["m5#0".to_string(), "m24#1".to_string()],
                100,
            )
            .unwrap();
        assert_eq!(replay.queued, 0);
        assert!(replay.duplicate);
        assert_eq!(
            store.load_pending_agent_drops("protected").unwrap(),
            pending
        );
    }

    #[test]
    fn frozen_row_does_not_consume_a_protection_slot() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // 21 tagged live blocks, numbers 1..21. m21#0 is frozen by an earlier
        // active pass, so the ACTIVE set is exactly m1..m20 — all 20 fit the
        // protected window and the oldest row's pending drop must be retained.
        // If frozen rows still consumed slots, m21 would take one, m1 would
        // fall to rank 21, and its drop would apply.
        let messages = (1..=21)
            .map(|ordinal| item(&format!("m{ordinal}"), ordinal, &format!("text {ordinal}")))
            .collect::<Vec<_>>();
        let tags = (1..=21)
            .map(|ordinal| TagMintInput {
                block_id: format!("m{ordinal}#0"),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: format!("text {ordinal}").into_bytes(),
            })
            .collect::<Vec<_>>();
        store.seed_tags_for_test("slot-free", &tags, 1).unwrap();

        // Pass 1 bootstraps, then the freeze is seeded directly in durable state
        // (selection itself refuses to reduce a protected newest tag, so a
        // pre-existing freeze — e.g. from an earlier phase with more tags — is
        // the realistic way a high-ranked block arrives already frozen).
        let request = active_cc_req("slot-free", "cfg0", messages);
        run(&store, &request, &spine());
        let seeded = store.load("slot-free").unwrap();
        let mut core = seeded.core.clone();
        core.frozen_units
            .push(red_unit("m21#0", "drop", "[dropped]"));
        store
            .commit("slot-free", seeded.row_version, &core, &seeded.meta)
            .unwrap();
        assert_eq!(
            frozen_red_payload(&store.load("slot-free").unwrap().core, "m21#0"),
            Some("[dropped]"),
            "precondition: m21#0 frozen before the tested pass"
        );

        // Pass 2 (tested): a render-config change forces a producing HARD so the
        // pending row is genuinely selected against the protected set — a defer
        // pass would retain it regardless and prove nothing.
        store
            .append_pending_agent_drops("slot-free", &["m1#0".to_string()], 99)
            .unwrap();
        let producing = active_cc_req(
            "slot-free",
            "cfg1",
            (1..=21)
                .map(|ordinal| item(&format!("m{ordinal}"), ordinal, &format!("text {ordinal}")))
                .collect::<Vec<_>>(),
        );
        let tested = run(&store, &producing, &spine());
        assert_eq!(tested.action, "HARD", "tested pass must produce");
        let loaded = store.load("slot-free").unwrap();
        assert_eq!(frozen_red_payload(&loaded.core, "m1#0"), None);
        let pending = store.load_pending_agent_drops("slot-free").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].target_id, "m1#0");
    }

    #[test]
    fn newest_tag_block_set_excludes_stale_provenance_from_slots() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // Exactly 21 tagged live blocks. The NEWEST row (m21#0) has stale
        // provenance. Under exact semantics it cannot hold a slot, so the
        // protected 20 are m20..m1 and a pending drop on m1#0 (rank 21 by
        // number, rank 20 among ACTIVE rows) is PROTECTED. An implementation
        // that skips the provenance re-check frees m1#0 and applies the drop.
        let messages = (1..=21)
            .map(|ordinal| item(&format!("m{ordinal}"), ordinal, &format!("text {ordinal}")))
            .collect::<Vec<_>>();
        let tags = (1..=21)
            .map(|ordinal| TagMintInput {
                block_id: format!("m{ordinal}#0"),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: if ordinal == 21 {
                    b"stale bytes".to_vec()
                } else {
                    format!("text {ordinal}").into_bytes()
                },
            })
            .collect::<Vec<_>>();
        store.seed_tags_for_test("stale-slot", &tags, 1).unwrap();
        store
            .append_pending_agent_drops("stale-slot", &["m1#0".to_string()], 2)
            .unwrap();

        let response = run(
            &store,
            &active_cc_req("stale-slot", "cfg0", messages),
            &spine(),
        );
        assert_eq!(response.action, "HARD");
        let loaded = store.load("stale-slot").unwrap();
        assert_eq!(frozen_red_payload(&loaded.core, "m1#0"), None);
        let pending = store.load_pending_agent_drops("stale-slot").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].target_id, "m1#0");
    }

    #[test]
    fn dormant_forced_hard_retains_pending_then_active_hard_applies_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let messages = vec![item("a", 1, "drop me")];
        let inactive = cc_req("dormant-hard", "cfg0", messages.clone());
        run(&store, &inactive, &spine());
        store
            .append_pending_agent_drops("dormant-hard", &["a#0".to_string()], 1)
            .unwrap();
        let forced = cc_req("dormant-hard", "cfg1", messages.clone());
        let dormant = run(&store, &forced, &spine());
        assert_eq!(dormant.action, "HARD");
        assert_eq!(
            frozen_red_payload(&store.load("dormant-hard").unwrap().core, "a#0"),
            None
        );
        assert_eq!(
            store
                .load_pending_agent_drops("dormant-hard")
                .unwrap()
                .len(),
            1
        );

        let active = run(
            &store,
            &active_cc_req("dormant-hard", "cfg1", messages),
            &spine(),
        );
        assert_eq!(active.action, "HARD");
        assert_eq!(
            frozen_red_payload(&store.load("dormant-hard").unwrap().core, "a#0"),
            Some("[dropped]")
        );
        assert!(store
            .load_pending_agent_drops("dormant-hard")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn obsolete_pending_row_commits_consumption_without_core_or_meta_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // "gone" is PRESENT in the array but covered by the compartment boundary:
        // provably retired (coverage only advances), so its pending row is
        // consumable even though nothing else about the pass changes state.
        store
            .replace_compartments("consume-only", &[comp(1, 1, 1, "gone", "summary")])
            .unwrap();
        let request = cc_req(
            "consume-only",
            "cfg0",
            vec![item("gone", 1, "folded away"), item("live", 2, "hello")],
        );
        run(&store, &request, &spine());
        store
            .append_pending_agent_drops("consume-only", &["gone#0".to_string()], 1)
            .unwrap();
        let before = store.load("consume-only").unwrap();

        let response = run(&store, &request, &spine());
        let after = store.load("consume-only").unwrap();
        assert_eq!(response.action, "SOFT+");
        assert!(response.committed);
        assert_eq!(after.core, before.core);
        assert_eq!(after.meta, before.meta);
        assert_eq!(
            after.row_version,
            before.row_version.map(|version| version + 1)
        );
        assert!(store
            .load_pending_agent_drops("consume-only")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn absent_target_pending_row_survives_subset_pass() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let full = active_cc_req(
            "subset-safety",
            "cfg0",
            vec![item("a", 1, "first"), item("m9", 9, "drop me")],
        );
        run(&store, &full, &spine());
        store
            .append_pending_agent_drops("subset-safety", &["m9#0".to_string()], 1)
            .unwrap();

        // An interactive side-request arrives as a SUBSET of the session: the
        // pending target is absent from this pass entirely. Absence proves
        // nothing (the full array returns next pass), so the row must survive.
        let subset = active_cc_req("subset-safety", "cfg0", vec![item("a", 1, "first")]);
        run(&store, &subset, &spine());
        let survived = store.load_pending_agent_drops("subset-safety").unwrap();
        assert_eq!(survived.len(), 1, "absent-target row must not be consumed");
        assert_eq!(survived[0].target_id, "m9#0");

        // The full array returns: the target is live-tail again and its row is
        // still queued for the next producing pass (drop application itself is
        // covered by the dormant/active drain tests).
        run(&store, &full, &spine());
        let requeued = store.load_pending_agent_drops("subset-safety").unwrap();
        assert_eq!(requeued.len(), 1);
        assert_eq!(requeued[0].target_id, "m9#0");
    }

    #[test]
    fn owned_profile_drains_pending_drops_without_request_surface() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // Owned-leg consumers never send the reduction-surface field; their
        // profile default alone must keep the durable queue draining.
        let request = req(
            "owned-drain",
            "cfg0",
            vec![item("a", 1, "first"), item("m2", 2, "drop me")],
        );
        run(&store, &request, &spine());
        store
            .append_pending_agent_drops("owned-drain", &["m2#0".to_string()], 1)
            .unwrap();

        let producing = req(
            "owned-drain",
            "cfg1",
            vec![item("a", 1, "first"), item("m2", 2, "drop me")],
        );
        let response = run(&store, &producing, &spine());
        assert_eq!(tail_bytes(&response, "m2"), "[dropped]");
        assert!(
            store
                .load_pending_agent_drops("owned-drain")
                .unwrap()
                .is_empty(),
            "profile-default tail reclaim must drain the queue"
        );
    }

    #[test]
    fn mixed_legacy_numbered_and_new_canonical_freezes_replay_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .replace_compartments("mixed-freezes", &[comp(1, 1, 1, "a", "summary")])
            .unwrap();
        let request = active_cc_req(
            "mixed-freezes",
            "cfg0",
            vec![
                item("a", 1, "covered"),
                item("m1", 2, "legacy"),
                item("m2", 3, "new"),
            ],
        );
        run(&store, &request, &spine());
        run(&store, &request, &spine());

        let mut loaded = store.load("mixed-freezes").unwrap();
        loaded
            .core
            .frozen_units
            .push(red_unit("m1#0", "drop", "[dropped §7§]"));
        store
            .commit(
                "mixed-freezes",
                loaded.row_version,
                &loaded.core,
                &loaded.meta,
            )
            .unwrap();

        let response = run(&store, &request, &[reduce("m2#0", "drop", "[dropped]")]);
        assert_eq!(tail_bytes(&response, "m1"), "[dropped §7§]");
        assert_eq!(tail_bytes(&response, "m2"), "[dropped §3§]");
        let durable = store.load("mixed-freezes").unwrap().core;
        assert_eq!(frozen_red_payload(&durable, "m1#0"), Some("[dropped §7§]"));
        assert_eq!(frozen_red_payload(&durable, "m2#0"), Some("[dropped]"));
    }

    #[test]
    fn absent_tool_matches_explicit_false_across_profile_pass_matrix() {
        for profile in [
            SerializerProfile::ClaudeCodeAnthropic,
            SerializerProfile::OwnedBroca,
            SerializerProfile::Pi,
            SerializerProfile::OpencodeAiSdk,
        ] {
            let left_dir = tempfile::tempdir().unwrap();
            let right_dir = tempfile::tempdir().unwrap();
            let left = store(left_dir.path());
            let right = store(right_dir.path());
            let initial = vec![comp(1, 1, 1, "a", "first")];
            left.replace_compartments("identity", &initial).unwrap();
            right.replace_compartments("identity", &initial).unwrap();
            let messages = vec![
                item("a", 1, "one"),
                item("b", 2, "two"),
                item("c", 3, "three"),
            ];
            // Both arms must deserialize from the wire (a direct struct skips the
            // original-value retention that wire requests carry), but they must be
            // constructed INDEPENDENTLY: the explicit arm's JSON carries a literal
            // tool_present:false, the absent arm's JSON omits the key entirely.
            // Cloning the deserialized absent request instead would inherit
            // whatever default serde applied, making the comparison tautological
            // under a wrong default.
            let (absent, explicit) = wire_pair_absent_and_explicit_false(profile_req(
                profile,
                "identity",
                "cfg0",
                messages.clone(),
            ));

            for expected_action in ["HARD", "SOFT+"] {
                let left_response = run(&left, &absent, &spine());
                let right_response = run(&right, &explicit, &spine());
                assert_eq!(left_response.action, expected_action, "{profile:?}");
                assert_eq!(
                    serde_json::to_value(left_response).unwrap(),
                    serde_json::to_value(right_response).unwrap(),
                    "{profile:?}"
                );
            }

            let extended = vec![comp(1, 1, 1, "a", "first"), comp(2, 2, 2, "b", "second")];
            left.replace_compartments("identity", &extended).unwrap();
            right.replace_compartments("identity", &extended).unwrap();
            let left_soft = run(&left, &absent, &spine());
            let right_soft = run(&right, &explicit, &spine());
            assert_eq!(left_soft.action, "SOFT", "{profile:?}");
            assert_eq!(
                serde_json::to_value(left_soft).unwrap(),
                serde_json::to_value(right_soft).unwrap(),
                "{profile:?}"
            );

            // Rebuild BOTH arms independently for the fold leg too: mutating one
            // and cloning the other would reintroduce the shared-default hazard.
            let (absent, explicit_fold) = wire_pair_absent_and_explicit_false(profile_req(
                profile,
                "identity",
                "cfg1",
                messages.clone(),
            ));
            let left_fold = run(&left, &absent, &spine());
            let right_fold = run(&right, &explicit_fold, &spine());
            assert_eq!(left_fold.action, "HARD", "{profile:?}");
            assert_eq!(
                serde_json::to_value(left_fold).unwrap(),
                serde_json::to_value(right_fold).unwrap(),
                "{profile:?}"
            );
            assert_eq!(
                left.load("identity").unwrap().core,
                right.load("identity").unwrap().core
            );
            assert_eq!(
                left.load("identity").unwrap().meta,
                right.load("identity").unwrap().meta
            );
        }
    }

    #[test]
    fn reduction_freezes_on_bust_replays_on_defer() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        // a new reduction on tail item t2 → SOFT, frozen → [dropped 1]
        let items = vec![item("a", 1, "raw"), item("t2", 2, "BIGOUTPUT")];
        let d = with_reductions(vec![reduce("t2", "drop", "[dropped 1]")]);
        let soft = run(&s, &req("ses", "cfg0", items.clone()), &d);
        assert_eq!(soft.action, "SOFT", "a new reduction rides a SOFT");
        assert_eq!(
            tail_bytes(&soft, "t2"),
            "[dropped 1]",
            "t2 reduced in place"
        );
        assert_eq!(
            tail_ids(&soft),
            vec!["t2"],
            "covered 'a' trimmed, only t2 in tail"
        );

        for _ in 0..3 {
            let after = run(&s, &req("ses", "cfg0", items.clone()), &d);
            assert_eq!(after.action, "SOFT+", "no new reduction → pure defer");
            assert!(!after.committed, "pure defer must not write");
            assert_eq!(tail_bytes(&after, "t2"), "[dropped 1]");
        }
    }

    #[test]
    fn frozen_reduction_never_first_applied_on_defer() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        let d = with_reductions(vec![reduce("t2", "strip", "[dropped 99999]")]);
        run(
            &s,
            &req(
                "ses",
                "cfg0",
                vec![item("a", 1, "raw"), item("t2", 2, "OUT")],
            ),
            &d,
        );

        // the tail grows; the SAME reduction set re-supplied each pass → pure defer, the
        // frozen [dropped 99999] replays verbatim, never first-applied on a defer.
        for n in 3..=6u64 {
            let mut items = vec![item("a", 1, "raw"), item("t2", 2, "OUT")];
            for k in 3..=n {
                items.push(item(&format!("t{k}"), k, &format!("new{k}")));
            }
            let r = run(&s, &req("ses", "cfg0", items), &d);
            assert_eq!(
                r.action, "SOFT+",
                "an aged-but-unchanged reduction set defers"
            );
            assert!(
                r.committed,
                "first-seen tail mids persist identity vectors even on a defer"
            );
            assert_eq!(
                tail_bytes(&r, "t2"),
                "[dropped 99999]",
                "frozen strip replays"
            );
        }
    }

    #[test]
    fn skeleton_byte_complete_across_moving_window() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        let skel = "edit packages/app/x.ts | @@ -10,6 +10,8 @@ [dropped 1]";
        let d1 = with_reductions(vec![reduce("edit1", "edit_marker", skel)]);
        let items1 = vec![item("a", 1, "raw"), item("edit1", 2, "FULL-DIFF-BYTES")];
        let frozen = run(&s, &req("ses", "cfg0", items1), &d1);
        assert_eq!(tail_bytes(&frozen, "edit1"), skel);

        // a newer edit lands; edit1 must replay its FROZEN payload verbatim (a re-derive
        // of the region-hint from current content would flip its bytes).
        let skel2 = "edit packages/app/y.ts | @@ -1,2 +1,3 @@ [dropped 2]";
        let d2 = with_reductions(vec![
            reduce("edit1", "edit_marker", skel),
            reduce("edit2", "edit_marker", skel2),
        ]);
        let items2 = vec![
            item("a", 1, "raw"),
            item("edit1", 2, "FULL-DIFF-BYTES"),
            item("edit2", 3, "ANOTHER-FULL-DIFF"),
        ];
        let moved = run(&s, &req("ses", "cfg0", items2), &d2);
        assert_eq!(moved.action, "SOFT", "the new edit2 reduction rides a SOFT");
        assert_eq!(tail_bytes(&moved, "edit1"), skel, "older skeleton verbatim");
        assert_eq!(tail_bytes(&moved, "edit2"), skel2, "new skeleton frozen");
    }

    #[test]
    fn fold_gcs_a_reduction_whose_item_becomes_covered() {
        // The new-model equivalent of "fold carries reduced bytes into m0": m0 is now a
        // SUMMARY (never reduced raw bytes), so when a HARD's coverage crosses a reduced
        // tail item, that item is represented by the compartment summary and its red:* unit
        // is GC'd — no stale [dropped] leak, no double-count.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        // freeze a drop on tail item t2 (ordinal 2)
        let d = with_reductions(vec![reduce("t2", "drop", "[dropped 1]")]);
        run(
            &s,
            &req(
                "ses",
                "cfg0",
                vec![item("a", 1, "raw"), item("t2", 2, "HUGE")],
            ),
            &d,
        );

        // a compartment now covers ordinal 2 (t2 is summarized); a HARD (render_config
        // change) re-composes m0 over both compartments — coverage advances to 2, so
        // A compartment now covers ordinal 2, summarizing t2. A later HARD pass
        // re-composes m0 and removes red:t2#0 because its ordinal is now covered.
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 1, "a", "S1"), comp(2, 2, 2, "t2", "S2")],
        )
        .unwrap();
        let r = run(
            &s,
            &req(
                "ses",
                "cfg1",
                vec![item("a", 1, "raw"), item("t2", 2, "HUGE")],
            ),
            &d,
        );
        assert_eq!(r.action, "HARD");
        assert_eq!(r.boundary_id, "t2#0", "anchor = last compartment end id");
        assert!(
            m0_bytes(&r).contains("S2"),
            "m0 is the summary, not [dropped 1]: {}",
            m0_bytes(&r)
        );
        assert!(
            !m0_bytes(&r).contains("[dropped 1]"),
            "m0 never carries reduced bytes"
        );
        let reloaded = s.load("ses").unwrap();
        assert!(
            !reloaded
                .core
                .frozen_units
                .iter()
                .any(|u| u.key == "red:t2#0"),
            "covered reduction GC'd"
        );
        assert!(tail_ids(&r).is_empty(), "both items covered, tail empty");
    }

    #[test]
    fn coalesced_memory_delta_and_reduction_one_soft() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        // both a store m1 delta (a new memory) AND a new reduction on one pass → ONE SOFT
        s.seed_memory(5, "git:proj", "ARCHITECTURE", "a rule", 70)
            .unwrap();
        let d = with_reductions(vec![reduce("t2", "drop", "[dropped 1]")]);
        let items = vec![item("a", 1, "raw"), item("t2", 2, "OUT")];
        let r = run(&s, &req("ses", "cfg0", items.clone()), &d);
        assert_eq!(r.action, "SOFT");
        assert!(
            m1_bytes(&r).contains("a rule"),
            "m1 delta rendered: {}",
            m1_bytes(&r)
        );
        assert_eq!(
            tail_bytes(&r, "t2"),
            "[dropped 1]",
            "reduction frozen, same SOFT"
        );

        // defer after: both replay byte-identical, no second bust
        let after = run(&s, &req("ses", "cfg0", items), &d);
        assert_eq!(after.action, "SOFT+");
        assert!(!after.committed);
        assert_eq!(m1_bytes(&after), m1_bytes(&r));
        assert_eq!(tail_bytes(&after, "t2"), "[dropped 1]");
    }

    #[test]
    fn reverted_orphan_reduction_gcd_on_surviving_prefix_reconcile_hard() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "S1"), comp(2, 2, 2, "b", "S2")])
            .unwrap();
        let live = vec![
            item("a", 1, "raw a"),
            item("b", 2, "raw b"),
            item("t3", 3, "OUT"),
        ];
        let boot = run(&s, &req("ses", "cfg0", live.clone()), &spine());
        assert_eq!(boot.action, "HARD");
        assert_eq!(boot.boundary_id, "b#0");

        // Freeze a drop on t3. The later revert keeps compartment a, so this exercises
        // the surviving-prefix re-cut path rather than the share-nothing raw alarm.
        let d = with_reductions(vec![reduce("t3", "drop", "[dropped 1]")]);
        let soft = run(&s, &req("ses", "cfg0", live), &d);
        assert_eq!(soft.action, "SOFT");
        assert_eq!(tail_bytes(&soft, "t3"), "[dropped 1]");

        let reverted = vec![item("a", 1, "raw a"), item("z", 9, "other")];
        let revert = run(&s, &req("ses", "cfg0", reverted.clone()), &spine());
        assert_eq!(revert.action, "SOFT+");
        assert!(revert.reconcile_pending);

        let remat = run(&s, &req("ses", "cfg0", reverted), &spine());
        assert_eq!(remat.action, "HARD");
        assert_eq!(remat.boundary_id, "a#0");
        assert!(
            !m0_bytes(&remat).contains("[dropped 1]"),
            "no orphaned reduction in m0"
        );
        let reloaded = s.load("ses").unwrap();
        assert_eq!(s.load_compartments("ses").unwrap().len(), 1);
        assert!(
            !reloaded
                .core
                .frozen_units
                .iter()
                .any(|u| u.key == "red:t3#0"),
            "orphan red:t3#0 GC'd"
        );
    }

    #[test]
    fn monotonicity_violation_fails_loud() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        // freeze t2 → [dropped 1]
        let d = with_reductions(vec![reduce("t2", "drop", "[dropped 1]")]);
        let items = vec![item("a", 1, "raw"), item("t2", 2, "OUT")];
        run(&s, &req("ses", "cfg0", items.clone()), &d);

        // re-supply t2 with DIFFERENT bytes (a contract violation) → fail loud, not a
        // silent skip-and-serve-stale. Tested on a defer (the silent-miss surface).
        let bad = with_reductions(vec![reduce("t2", "drop", "[dropped DIFFERENT]")]);
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.injected_reductions = bad;
        let err = transform(&s, &req("ses", "cfg0", items), &ctx).unwrap_err();
        assert!(matches!(err, TransformError::ReductionConflict));
    }

    #[test]
    fn interleaved_reduction_keeps_surrounding_tail_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);

        // a reduction sits BETWEEN live tail items; the surrounding items stay verbatim
        // and stable across a defer (the contiguous-prefix cache holds per-item).
        let d = with_reductions(vec![reduce("t3", "drop", "[dropped 1]")]);
        let items = vec![
            item("a", 1, "raw"),
            item("t2", 2, "before"),
            item("t3", 3, "REDUCED-AWAY"),
            item("t4", 4, "after"),
        ];
        let soft = run(&s, &req("ses", "cfg0", items.clone()), &d);
        assert_eq!(soft.action, "SOFT");
        assert_eq!(
            tail_ids(&soft),
            vec!["t2", "t3", "t4"],
            "order + ids preserved"
        );
        assert_eq!(tail_bytes(&soft, "t2"), "before");
        assert_eq!(tail_bytes(&soft, "t3"), "[dropped 1]");
        assert_eq!(tail_bytes(&soft, "t4"), "after");

        let after = run(&s, &req("ses", "cfg0", items), &d);
        assert_eq!(after.action, "SOFT+");
        assert_eq!(tail_bytes(&after, "t2"), "before");
        assert_eq!(tail_bytes(&after, "t3"), "[dropped 1]");
        assert_eq!(tail_bytes(&after, "t4"), "after");
    }

    #[test]
    fn shape_tighten_rejects_missing_m1_but_allows_red() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let dc = pctx("git:proj", "/nonexistent-docs", 0);
        // an initialized state with m0 + a red:* but NO m1 → unknown shape, reject
        let bad = CoreState {
            version: 1,
            boundary_id: "a#0".into(),
            frozen_units: vec![
                synth_region("m0", "BASE".into()),
                red_unit("t2#0", "drop", "[dropped 1]"),
            ],
            pending_changes: vec![],
            reconcile_pending: false,
        };
        let meta = ModuleMeta {
            initialized: true,
            last_render_config: "cfg0".into(),
            coverage_ordinal: Some(1),
            ..Default::default()
        };
        s.commit("ses", None, &bad, &meta).unwrap();
        let err = transform(&s, &req("ses", "cfg0", vec![item("a", 1, "BASE")]), &dc).unwrap_err();
        assert!(
            matches!(err, TransformError::UnknownShape(_)),
            "missing m1 rejects"
        );

        // a valid m0 + m1 + red:* state classifies normally (does NOT reject). Use the
        // effective render_config (with the empty-workspace fingerprint folded) and the
        // matching post-HARD m1 digest so the steady-state pass is a clean SOFT+ (no
        // phantom delta from a mismatched digest).
        let good = CoreState {
            version: 1,
            boundary_id: "a#0".into(),
            frozen_units: vec![
                synth_region("m0", "BASE".into()),
                synth_region("m1", M1_PLACEHOLDER.into()),
                red_unit("t2#0", "drop", "[dropped 1]"),
            ],
            pending_changes: vec![],
            reconcile_pending: false,
        };
        let good_cfg = fold_m0_content_epoch(
            "cfg0",
            &M0ContentEpoch {
                workspace_fingerprint: s.workspace_fingerprint("git:proj").unwrap(),
                upgrade_state: String::new(),
                memory_content_epoch: String::new(),
                memory_render_epoch: format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
                compartment_render_epoch: format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
                profile_render_epoch: String::new(),
                tagger_feature_epoch: String::new(),
            },
        );
        let good_meta = ModuleMeta {
            initialized: true,
            last_render_config: good_cfg,
            coverage_ordinal: Some(1),
            m1_revision: m1_revision_signal(&s, "git:proj", "ses2").unwrap(),
            ..Default::default()
        };
        s.commit("ses2", None, &good, &good_meta).unwrap();
        let ok = transform(&s, &req("ses2", "cfg0", vec![item("a", 1, "BASE")]), &dc).unwrap();
        assert_eq!(ok.action, "SOFT+", "m0+m1+red is a valid shape");
    }

    #[test]
    fn token_estimator_is_hard_only_never_called_on_soft_or_defer() {
        // The load-bearing cache claim behind wiring the real BPE estimator: it is
        // reachable ONLY on the HARD m0 compose (the decay budget guard), never on a
        // SOFT (m1 composes at fixed tier 1) or a defer (frozen replay). If it were
        // ever called on a non-HARD pass, activating a real (non-zero) estimator could
        // change bytes on a pass that must replay byte-identically. Prove it with a
        // call-counting estimator: the counter must be >0 after a HARD and EXACTLY 0
        // after a SOFT and a defer.
        use std::cell::Cell;
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let calls = Cell::new(0usize);
        let counting = |text: &str| -> usize {
            calls.set(calls.get() + 1);
            mc_tokenizer::estimate_tokens(text)
        };
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);

        // HARD bootstrap: m0 folds C1, so compose_m0_from_store runs the decay renderer
        // whose budget guard evaluates the estimator at least once (non-empty pool).
        s.replace_compartments("ses", &[comp(1, 1, 10, "m10", "S1")])
            .unwrap();
        let boot = apply_once_with_estimator(
            &s,
            &req(
                "ses",
                "cfg0",
                vec![item("m10", 10, "raw"), item("t11", 11, "tail")],
            ),
            &ctx,
            counting,
        )
        .unwrap();
        assert_eq!(boot.response.action, "HARD");
        assert!(
            calls.get() > 0,
            "the HARD m0 compose must exercise the estimator (budget guard)"
        );

        // SOFT: a second compartment rides m1 at fixed tier 1 (no decay budget guard).
        s.replace_compartments(
            "ses",
            &[comp(1, 1, 10, "m10", "S1"), comp(2, 11, 20, "m20", "S2")],
        )
        .unwrap();
        calls.set(0);
        let soft_items = vec![
            item("m10", 10, "raw"),
            item("m20", 20, "raw2"),
            item("t21", 21, "tail"),
        ];
        let soft =
            apply_once_with_estimator(&s, &req("ses", "cfg0", soft_items.clone()), &ctx, counting)
                .unwrap();
        assert_eq!(soft.response.action, "SOFT");
        assert_eq!(
            calls.get(),
            0,
            "a SOFT composes m1 without the m0 decay budget guard → estimator must NOT be called"
        );

        // defer: replays frozen m0/m1, composes nothing.
        calls.set(0);
        let defer =
            apply_once_with_estimator(&s, &req("ses", "cfg0", soft_items), &ctx, counting).unwrap();
        assert_eq!(defer.response.action, "SOFT+");
        assert_eq!(
            calls.get(),
            0,
            "a defer replays frozen m0/m1 → estimator must NOT be called"
        );
    }
    fn profile_req(
        profile: SerializerProfile,
        session: &str,
        cfg: &str,
        messages: Vec<CkIngressMessage>,
    ) -> TransformRequest {
        let mut r = req(session, cfg, messages);
        r.serializer_profile = profile.wire_id().to_string();
        r
    }

    fn cc_req(session: &str, cfg: &str, messages: Vec<CkIngressMessage>) -> TransformRequest {
        profile_req(
            SerializerProfile::ClaudeCodeAnthropic,
            session,
            cfg,
            messages,
        )
    }

    fn active_cc_req(
        session: &str,
        cfg: &str,
        messages: Vec<CkIngressMessage>,
    ) -> TransformRequest {
        let mut request = cc_req(session, cfg, messages);
        request.tool_present = true;
        request
    }

    fn opencode_req(session: &str, cfg: &str, messages: Vec<CkIngressMessage>) -> TransformRequest {
        profile_req(SerializerProfile::OpencodeAiSdk, session, cfg, messages)
    }

    fn active_opencode_req(
        session: &str,
        cfg: &str,
        messages: Vec<CkIngressMessage>,
    ) -> TransformRequest {
        let mut request = opencode_req(session, cfg, messages);
        request.tool_present = true;
        request
    }

    fn effective_render_config_with_epochs(
        store: &McStore,
        cfg: &str,
        memory_render_epoch: String,
        compartment_render_epoch: String,
        profile_render_epoch: String,
        tagger_feature_epoch: String,
    ) -> String {
        fold_m0_content_epoch(
            cfg,
            &M0ContentEpoch {
                workspace_fingerprint: store.workspace_fingerprint("git:proj").unwrap(),
                upgrade_state: String::new(),
                memory_content_epoch: String::new(),
                memory_render_epoch,
                compartment_render_epoch,
                profile_render_epoch,
                tagger_feature_epoch,
            },
        )
    }

    fn global_epoch_effective_render_config(store: &McStore, cfg: &str) -> String {
        effective_render_config_with_epochs(
            store,
            cfg,
            format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
            format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
            String::new(),
            String::new(),
        )
    }

    /// The byte-splice consumer keeps tail bytes verbatim, so the module must not
    /// mutate the tail for its profile under ANY pass class: mutations it froze
    /// would never reach the real context (phantom reclaim). Drives execute-class
    /// and emergency-class passes over reclaim-eligible content and asserts the
    /// output tail is byte-identical to the input on every pass.
    #[test]
    fn verbatim_tail_profile_never_mutates_tail_bytes_on_any_pass_class() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1", "SUMMARY")])
            .unwrap();

        let tail = vec![
            item("m1", 1, "covered raw"),
            assistant_tool_call("m2", 2, "call_old"),
            tool_result("m3", 3, "call_old", "big old tool output marked for drop"),
            todowrite_call(
                "m4",
                4,
                serde_json::json!([{ "content": "x", "status": "done" }]),
            ),
            item("m9", 9, "newest user text"),
        ];
        // A queued agent drop targeting the old tool result: appendable always,
        // consumable never (for this profile).
        s.append_pending_agent_drops("ses", &["m3#0".to_string()], 1)
            .unwrap();

        let expected_tail: Vec<Vec<u8>> = tail[1..]
            .iter()
            .map(|m| serde_json::to_vec(&m.ck).unwrap())
            .collect();

        // Bootstrap fold (HARD), then execute-class (70%) and emergency-class (96%)
        // passes: each must leave tail bytes untouched and consume nothing.
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        for (usage, limit) in [(1u64, 100u64), (70, 100), (96, 100)] {
            let r = transform(
                &s,
                &with_usage(cc_req("ses", "cfg0", tail.clone()), usage, limit),
                &ctx,
            )
            .unwrap();
            let out_tail: Vec<Vec<u8>> = r
                .messages()
                .iter()
                .filter(|m| !m.meta.synthetic)
                .map(|m| serde_json::to_vec(m).unwrap())
                .collect();
            assert_eq!(
                out_tail, expected_tail,
                "tail bytes must be verbatim at usage {usage}%"
            );
        }

        let loaded = s.load("ses").unwrap();
        assert!(
            loaded
                .core
                .frozen_units
                .iter()
                .all(|u| !u.key.starts_with("red:")),
            "no reduction may freeze under a verbatim-tail profile"
        );
        assert!(
            loaded.meta.synthetic_todo.is_none(),
            "no synthetic todo may be captured under a verbatim-tail profile"
        );
        assert_eq!(
            s.load_pending_agent_drops("ses").unwrap().len(),
            1,
            "queued agent drops stay durable (append accepted, drain gated)"
        );
        // The FOLD is not a tail mutation: the prefix compacted normally.
        assert!(loaded.core.frozen_units.iter().any(|u| u.key == "m0"));
    }

    /// A leading system message is exempt from coverage continuity checks: the chunk
    /// builder never summarizes system content, so a pinned prompt before the first
    /// chunk is not a live-coverage gap.
    fn declared_trim_fixture() -> (
        tempfile::TempDir,
        McStore,
        TransformRequest,
        ProducerContext<'static>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let core = CoreState {
            version: 1,
            boundary_id: "b#0".to_string(),
            reconcile_pending: false,
            frozen_units: vec![
                synth_region("m0", "m0".to_string()),
                synth_region("m1", M1_PLACEHOLDER.to_string()),
            ],
            pending_changes: Vec::new(),
        };
        let meta = ModuleMeta {
            initialized: true,
            last_render_config: fold_m0_content_epoch(
                "cfg",
                &M0ContentEpoch {
                    workspace_fingerprint: String::new(),
                    upgrade_state: String::new(),
                    memory_content_epoch: String::new(),
                    memory_render_epoch: format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
                    compartment_render_epoch: format!(
                        "cre{}",
                        crate::COMPARTMENT_RENDER_FORMAT_EPOCH
                    ),
                    profile_render_epoch: String::new(),
                    tagger_feature_epoch: String::new(),
                },
            ),
            coverage_ordinal: Some(0),
            folded_compartment_seq: 0,
            m1_revision: m1_revision_signal(&store, "git:proj", "decl").unwrap(),
            ..Default::default()
        };
        store.commit("decl", None, &core, &meta).unwrap();
        store
            .replace_compartments("decl", &[comp(0, 0, 0, "b", "summary")])
            .unwrap();
        let mut request = req("decl", "cfg", vec![item("c", 1, "tail")]);
        request.declared_trim = Some(DeclaredTrim {
            flat_boundary_id: "b#0".to_string(),
            boundary_bare_message_id: "b".to_string(),
            boundary_absolute_ordinal: 0,
            next_absolute_ordinal: 1,
        });
        (
            dir,
            store,
            request,
            pctx("git:proj", "/nonexistent-docs", 0),
        )
    }

    #[test]
    fn seeded_boundary_validates_declared_trim_before_the_first_shadow_fold() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let compartments = vec![StoredCompartment {
            sequence: 4,
            start_message: 1,
            end_message: 2,
            start_message_id: "a#0".to_string(),
            end_message_id: "b#0".to_string(),
            title: "seeded".to_string(),
            content: "seeded summary".to_string(),
            p1: Some("seeded summary".to_string()),
            importance: 50,
            ..Default::default()
        }];
        store
            .apply_shadow_state_sync(ShadowStateSyncRequest {
                session_id: "seeded-trim",
                shadow_project_path: "git:proj",
                shadow_generation: 0,
                expected_shadow_seq: 0,
                seed_boundary_id: Some("b#0"),
                compartments: &compartments,
                memories: &[],
                memory_mutations: &[],
                user_profile: &[],
                workspace: None,
                last_todo_state: None,
                acked_watermarks: Value::Null,
            })
            .unwrap();
        let seeded = store.load("seeded-trim").unwrap();
        assert_eq!(seeded.core.boundary_id, "b#0");
        assert_eq!(seeded.meta.coverage_ordinal, Some(2));
        assert_eq!(seeded.meta.coverage_start_ordinal, Some(1));
        assert_eq!(seeded.meta.coverage_compartment_seq, Some(4));
        assert_eq!(seeded.meta.folded_compartment_seq, 4);

        let mut request = req("seeded-trim", "cfg", vec![item("c", 3, "live tail")]);
        request.declared_trim = Some(DeclaredTrim {
            flat_boundary_id: "b#0".to_string(),
            boundary_bare_message_id: "b".to_string(),
            boundary_absolute_ordinal: 2,
            next_absolute_ordinal: 3,
        });
        let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 1);
        let first = transform_with_projection(&store, &request, &ctx).unwrap();
        assert_eq!(first.boundary_state, BoundaryState::DeclaredTrimValidated);
        assert_eq!(first.trim_mismatch, None);
        assert!(!store.load("seeded-trim").unwrap().meta.shadow_quarantined);

        let second = transform_with_projection(&store, &request, &ctx).unwrap();
        assert_eq!(second.boundary_state, BoundaryState::DeclaredTrimValidated);
        assert_eq!(first.response.ck_messages, second.response.ck_messages);
    }

    #[test]
    fn declared_trim_validates_absent_boundary_and_preserves_defer_path() {
        let (_dir, store, request, ctx) = declared_trim_fixture();
        let result = transform_with_projection(&store, &request, &ctx).unwrap();
        assert_eq!(result.boundary_state, BoundaryState::DeclaredTrimValidated);
        assert!(result.trim_mismatch.is_none());
        assert_eq!(result.response.action, "SOFT+");
        assert_eq!(store.load("decl").unwrap().meta.pending_rewrite, None);
    }

    #[test]
    fn declared_trim_predicate_failures_are_absent_with_trim_mismatch() {
        type TrimCase = (
            &'static str,
            Box<dyn FnOnce(&mut TransformRequest, &McStore)>,
        );
        let cases: Vec<TrimCase> = vec![
            (
                "boundary_identity",
                Box::new(|request, _| {
                    request.declared_trim.as_mut().unwrap().flat_boundary_id =
                        "wrong#0".to_string();
                }),
            ),
            (
                "coverage_ordinal",
                Box::new(|request, _| {
                    request
                        .declared_trim
                        .as_mut()
                        .unwrap()
                        .boundary_absolute_ordinal = 99;
                }),
            ),
            (
                "tail_compartment",
                Box::new(|_, store| {
                    store
                        .replace_compartments("decl", &[comp(0, 0, 0, "other", "summary")])
                        .unwrap();
                }),
            ),
            (
                "continuity",
                Box::new(|request, _| {
                    request
                        .declared_trim
                        .as_mut()
                        .unwrap()
                        .next_absolute_ordinal = 2;
                }),
            ),
        ];
        for (predicate, mutate) in cases {
            let (_dir, store, mut request, ctx) = declared_trim_fixture();
            mutate(&mut request, &store);
            let result = transform_with_projection(&store, &request, &ctx).unwrap();
            assert_eq!(result.boundary_state, BoundaryState::Absent, "{predicate}");
            assert_eq!(
                result.trim_mismatch.as_ref().map(|m| m.predicate),
                Some(predicate),
                "{predicate}"
            );
        }
    }

    #[test]
    fn declared_trim_continuity_exempts_covered_system_head() {
        let (_dir, store, mut request, ctx) = declared_trim_fixture();
        request
            .messages
            .insert(0, system_item("sys", 0, "covered system"));
        let result = transform_with_projection(&store, &request, &ctx).unwrap();
        assert_eq!(result.boundary_state, BoundaryState::DeclaredTrimValidated);
        assert!(result.trim_mismatch.is_none());
    }

    #[test]
    fn declared_trim_allows_minted_absent_anchor_only_when_validated() {
        let (_dir, store, mut request, ctx) = declared_trim_fixture();
        let mut loaded = store.load("decl").unwrap();
        loaded.meta.last_render_config = "old".to_string();
        store
            .commit("decl", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        request.render_config = "new".to_string();
        let result = transform_with_projection(&store, &request, &ctx).unwrap();
        assert_eq!(result.response.action, "HARD");
        assert_eq!(result.boundary_state, BoundaryState::DeclaredTrimValidated);

        let (_dir, store, mut invalid, ctx) = declared_trim_fixture();
        let mut loaded = store.load("decl").unwrap();
        loaded.meta.last_render_config = "old".to_string();
        store
            .commit("decl", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        invalid.render_config = "new".to_string();
        invalid
            .declared_trim
            .as_mut()
            .unwrap()
            .next_absolute_ordinal = 2;
        let invalid_result = transform_with_projection(&store, &invalid, &ctx).unwrap();
        assert_eq!(invalid_result.boundary_state, BoundaryState::Absent);
        assert_eq!(
            invalid_result.trim_mismatch.as_ref().map(|m| m.predicate),
            Some("continuity")
        );
    }

    fn covered_system_entries(m0: &str) -> Vec<String> {
        const OPEN: &str = "<covered-system-message>";
        const CLOSE: &str = "</covered-system-message>";
        let mut entries = Vec::new();
        let mut rest = m0;
        while let Some(open_index) = rest.find(OPEN) {
            let after_open = &rest[open_index + OPEN.len()..];
            let close_index = after_open.find(CLOSE).expect("covered system close tag");
            entries.push(after_open[..close_index].to_string());
            rest = &after_open[close_index + CLOSE.len()..];
        }
        entries
    }

    fn assert_no_system_before_tail_system(response: &TransformResponse, tail_text: &str) {
        let messages = response.messages();
        let tail_index = messages
            .iter()
            .position(|message| {
                message.role == "system" && ck_wire::text_from_message(message) == Some(tail_text)
            })
            .expect("tail system survives in output");
        assert!(
            messages[..tail_index]
                .iter()
                .all(|message| message.role != "system"),
            "covered systems must not appear in the synthetic prefix: {messages:#?}"
        );
    }

    #[test]
    fn covered_system_fold_output_matches_byte_golden() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 0, 3, "m3", "SUMMARY")])
            .unwrap();
        let tail_system = system_item("sys4", 4, "tail identity");
        let items = vec![
            system_item("sys0", 0, "identity alpha"),
            system_item("sys1", 1, "identity beta"),
            system_item("sys2", 2, "identity alpha"),
            item("m3", 3, "covered"),
            tail_system.clone(),
            item("t5", 5, "tail"),
        ];

        let r = run(&s, &cc_req("ses", "cfg0", items), &spine());
        assert_eq!(r.action, "HARD");
        let expected: Value = serde_json::from_str(include_str!(
            "../testdata/covered-system-transform-golden.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(r.messages()).unwrap(), expected);
        assert_eq!(
            covered_system_entries(m0_bytes(&r)),
            vec!["identity alpha".to_string(), "identity beta".to_string()]
        );
        assert_no_system_before_tail_system(&r, "tail identity");
        let tail_index = r
            .messages()
            .iter()
            .position(|message| {
                message.role == "system"
                    && ck_wire::text_from_message(message) == Some("tail identity")
            })
            .unwrap();
        assert_eq!(&r.messages()[tail_index], &tail_system.ck);
    }

    #[test]
    fn covered_systems_absorb_into_m0_and_tail_system_survives() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 3, 3, "m3", "SUMMARY")])
            .unwrap();
        let tail_system = system_item("sys4", 4, "tail identity");
        let items = vec![
            system_item("sys0", 0, "identity alpha"),
            system_item("sys1", 1, "identity beta"),
            system_item("sys2", 2, "identity alpha"),
            item("m3", 3, "covered"),
            tail_system.clone(),
            item("t5", 5, "tail"),
        ];

        let r = run(&s, &cc_req("ses", "cfg0", items.clone()), &spine());
        assert_eq!(r.action, "HARD");
        assert_eq!(r.coverage_ordinal, Some(3));
        assert_eq!(
            covered_system_entries(m0_bytes(&r)),
            vec!["identity alpha".to_string(), "identity beta".to_string()],
            "m0 carries deduplicated covered systems in first-ordinal order"
        );
        assert_no_system_before_tail_system(&r, "tail identity");
        let messages = r.messages();
        let tail_index = messages
            .iter()
            .position(|message| {
                message.role == "system"
                    && ck_wire::text_from_message(message) == Some("tail identity")
            })
            .unwrap();
        assert_eq!(&messages[tail_index], &tail_system.ck);

        let defer_one = run(&s, &cc_req("ses", "cfg0", items.clone()), &spine());
        let defer_two = run(&s, &cc_req("ses", "cfg0", items), &spine());
        assert_eq!(defer_one.action, "SOFT+");
        assert_eq!(defer_two.action, "SOFT+");
        assert_eq!(
            serde_json::to_vec(&defer_one.ck_messages).unwrap(),
            serde_json::to_vec(&r.ck_messages).unwrap(),
            "first defer replays the frozen m0 block byte-identically"
        );
        assert_eq!(
            serde_json::to_vec(&defer_two.ck_messages).unwrap(),
            serde_json::to_vec(&defer_one.ck_messages).unwrap(),
            "second defer is byte-identical to the first defer"
        );
    }

    #[test]
    fn empty_covered_system_set_omits_the_block() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1", "SUMMARY")])
            .unwrap();
        let r = run(
            &s,
            &cc_req(
                "ses",
                "cfg0",
                vec![item("m1", 1, "covered"), item("t2", 2, "tail")],
            ),
            &spine(),
        );
        assert_eq!(r.action, "HARD");
        assert!(
            !m0_bytes(&r).contains("<covered-system-messages>"),
            "empty covered system set must not render empty block bytes: {}",
            m0_bytes(&r)
        );
    }

    #[test]
    fn coverage_advance_over_system_promotes_to_hard_and_rederives_m0_block() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 3, 3, "m3", "S1")])
            .unwrap();
        let items = vec![
            system_item("sys0", 0, "identity alpha"),
            system_item("sys1", 1, "identity beta"),
            system_item("sys2", 2, "identity alpha"),
            item("m3", 3, "covered one"),
            system_item("sys4", 4, "identity gamma"),
            item("m5", 5, "covered two"),
            system_item("sys6", 6, "tail identity"),
        ];
        let first = run(&s, &cc_req("ses", "cfg0", items.clone()), &spine());
        assert_eq!(
            covered_system_entries(m0_bytes(&first)),
            vec!["identity alpha".to_string(), "identity beta".to_string()]
        );

        s.replace_compartments(
            "ses",
            &[comp(1, 3, 3, "m3", "S1"), comp(2, 4, 5, "m5", "S2")],
        )
        .unwrap();
        let advanced = run(&s, &cc_req("ses", "cfg0", items), &spine());
        assert_eq!(
            advanced.action, "HARD",
            "coverage advance over a system message must recompose m0, not ride m1"
        );
        assert_eq!(advanced.coverage_ordinal, Some(5));
        assert_eq!(
            covered_system_entries(m0_bytes(&advanced)),
            vec![
                "identity alpha".to_string(),
                "identity beta".to_string(),
                "identity gamma".to_string(),
            ],
            "new m0 re-derives the larger covered-system set while preserving prior order"
        );
        assert_no_system_before_tail_system(&advanced, "tail identity");
    }

    #[test]
    fn covered_system_content_drift_fails_identity_guard() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1", "SUMMARY")])
            .unwrap();
        let original = vec![
            system_item("sys0", 0, "identity alpha"),
            item("m1", 1, "covered"),
            item("t2", 2, "tail"),
        ];
        let first = run(&s, &cc_req("ses", "cfg0", original), &spine());
        assert_eq!(first.action, "HARD");

        let drift = transform(
            &s,
            &cc_req(
                "ses",
                "cfg0",
                vec![
                    system_item("sys0", 0, "identity beta"),
                    item("m1", 1, "covered"),
                    item("t2", 2, "tail"),
                ],
            ),
            &pctx("git:proj", "/nonexistent-docs", 0),
        )
        .unwrap_err();
        assert!(
            matches!(drift, TransformError::IdentityDrift(ref mid) if mid == "sys0"),
            "covered system content drift must fail via IdentityDrift, got {drift:?}"
        );
    }

    #[test]
    fn staged_epoch_bump_takes_exactly_one_hard_when_client_config_frozen() {
        assert_eq!(crate::TAGGER_FEATURE_EPOCH, 3);
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let r1 = "pe1/tf1/gfull";
        let messages = vec![wire_item("user", "m1", 1, &["stable bytes"])];
        let request = active_cc_req("staged-tfe", r1, messages);

        run(&s, &request, &spine());
        run(&s, &request, &spine());
        let mut loaded = s.load("staged-tfe").unwrap();
        loaded.meta.last_render_config = effective_render_config_with_epochs(
            &s,
            r1,
            format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
            format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
            format!(
                "mpe{}",
                crate::profile_render_epoch(SerializerProfile::ClaudeCodeAnthropic)
            ),
            "tfe2".to_string(),
        );
        s.commit("staged-tfe", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();

        // The consumer base string stays frozen while the module epoch moves. Epoch pins
        // are status assertions, not extra wire tokens; changing both identities would
        // coordinate two folds instead of the one fold owned by the module upgrade.
        let pass_a = run(&s, &request, &spine());
        assert_eq!(pass_a.action, "HARD");
        let expected_tfe3 = effective_render_config_with_epochs(
            &s,
            r1,
            format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
            format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
            format!(
                "mpe{}",
                crate::profile_render_epoch(SerializerProfile::ClaudeCodeAnthropic)
            ),
            "tfe3".to_string(),
        );
        assert_eq!(
            s.load("staged-tfe").unwrap().meta.last_render_config,
            expected_tfe3
        );

        let pass_b = run(&s, &request, &spine());
        assert_ne!(pass_b.action, "HARD");
        assert_eq!(
            serde_json::to_vec(pass_a.messages()).unwrap(),
            serde_json::to_vec(pass_b.messages()).unwrap()
        );

        let r2_request = active_cc_req("staged-tfe", "pe1/tf2/gfull", request.messages.clone());
        let pass_c = run(&s, &r2_request, &spine());
        assert_eq!(
            pass_c.action, "HARD",
            "the opaque client base is independently identity-bearing"
        );
    }

    #[test]
    fn inactive_surface_omits_tagger_epoch_and_keeps_render_identity() {
        assert_eq!(crate::tagger_feature_epoch(false), 0);
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let request = cc_req(
            "inactive-tfe",
            "pe1/tf1/gfull",
            vec![wire_item("user", "m1", 1, &["raw bytes"])],
        );
        let first = run(&s, &request, &spine());
        let first_config = s.load("inactive-tfe").unwrap().meta.last_render_config;
        assert!(!first_config.contains("tfe:"));

        let replay = run(&s, &request, &spine());
        assert_ne!(replay.action, "HARD");
        assert_eq!(
            s.load("inactive-tfe").unwrap().meta.last_render_config,
            first_config
        );
        assert_eq!(
            serde_json::to_vec(first.messages()).unwrap(),
            serde_json::to_vec(replay.messages()).unwrap()
        );
        assert_eq!(tail_bytes(&replay, "m1"), "raw bytes");
    }

    #[test]
    fn profile_epoch_fold_hards_epoch_zero_cc_state_once() {
        assert_eq!(crate::PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC, 1);
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "m1", "SUMMARY")])
            .unwrap();
        let messages = vec![
            system_item("sys0", 0, "identity alpha"),
            item("m1", 1, "covered"),
            item("t2", 2, "tail"),
        ];
        let current = cc_req("ses", "cfg0", messages.clone());
        let first = run(&s, &current, &spine());
        assert_eq!(first.action, "HARD");

        let mut loaded = s.load("ses").unwrap();
        // Keep the shared memory-render epoch current so this fixture isolates
        // the claude-code profile epoch transition.
        loaded.meta.last_render_config = global_epoch_effective_render_config(&s, "cfg0");
        loaded
            .core
            .frozen_units
            .iter_mut()
            .find(|unit| unit.key == "m0")
            .unwrap()
            .frozen_payload = "OLD-M0-WITHOUT-COVERED-SYSTEMS".to_string();
        s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();

        let transitioned = run(&s, &current, &spine());
        assert_eq!(
            transitioned.action, "HARD",
            "module-side profile epoch folding must hard once even when the caller's cfg is static"
        );
        assert!(
            m0_bytes(&transitioned).contains("<covered-system-message>identity alpha"),
            "the transition fold must recompose m0 with the covered-system block: {}",
            m0_bytes(&transitioned)
        );
        assert!(!m0_bytes(&transitioned).contains("OLD-M0"));

        let one_shot = run(&s, &current, &spine());
        assert_eq!(
            one_shot.action, "SOFT+",
            "after last_render_config records mpe1, the profile fold must not loop"
        );
    }

    #[test]
    fn global_memory_render_epoch_hards_all_profiles_once_then_stabilizes() {
        assert_eq!(crate::MEMORY_RENDER_FORMAT_EPOCH, 2);
        for profile in [
            SerializerProfile::OwnedLlmRunner,
            SerializerProfile::Pi,
            SerializerProfile::OpencodeAiSdk,
            SerializerProfile::ClaudeCodeAnthropic,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let session = format!("ses-{}", profile.wire_id());
            s.replace_compartments(&session, &[comp(1, 1, 1, "m1", "SUMMARY")])
                .unwrap();
            let request = profile_req(
                profile,
                &session,
                "cfg0",
                vec![item("m1", 1, "covered"), item("t2", 2, "tail")],
            );
            let first = run(&s, &request, &spine());
            assert_eq!(first.action, "HARD");

            let mut loaded = s.load(&session).unwrap();
            let profile_epoch = crate::profile_render_epoch(profile);
            let profile_epoch_component = if profile_epoch == 0 {
                String::new()
            } else {
                format!("mpe{profile_epoch}")
            };
            let current_cfg = effective_render_config_with_epochs(
                &s,
                "cfg0",
                format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
                format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
                profile_epoch_component.clone(),
                String::new(),
            );
            assert_eq!(loaded.meta.last_render_config, current_cfg);
            assert!(
                current_cfg.contains(&format!("mre:4:mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH))
            );

            loaded.meta.last_render_config = effective_render_config_with_epochs(
                &s,
                "cfg0",
                String::new(),
                format!("cre{}", crate::COMPARTMENT_RENDER_FORMAT_EPOCH),
                profile_epoch_component,
                String::new(),
            );
            loaded
                .core
                .frozen_units
                .iter_mut()
                .find(|unit| unit.key == "m0")
                .unwrap()
                .frozen_payload = "OLD-PROJECT-MEMORY-FORMAT".to_string();
            s.commit(&session, loaded.row_version, &loaded.core, &loaded.meta)
                .unwrap();

            let transitioned = run(&s, &request, &spine());
            assert_eq!(
                transitioned.action,
                "HARD",
                "{} must fold the shared memory render epoch",
                profile.wire_id()
            );
            assert!(!m0_bytes(&transitioned).contains("OLD-PROJECT-MEMORY-FORMAT"));

            let steady = run(&s, &request, &spine());
            assert_eq!(
                steady.action,
                "SOFT+",
                "{} must not loop the memory render fold",
                profile.wire_id()
            );
            assert!(!steady.committed);
        }
    }

    #[test]
    fn compartment_render_epoch_hards_all_profiles_once_then_stabilizes() {
        assert_eq!(crate::COMPARTMENT_RENDER_FORMAT_EPOCH, 2);
        for profile in [
            SerializerProfile::OwnedLlmRunner,
            SerializerProfile::Pi,
            SerializerProfile::OpencodeAiSdk,
            SerializerProfile::ClaudeCodeAnthropic,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let session = format!("cre-session-{}", profile.wire_id());
            s.replace_compartments(&session, &[comp(1, 1, 1, "m1", "SUMMARY")])
                .unwrap();
            let request = profile_req(
                profile,
                &session,
                "cfg0",
                vec![item("m1", 1, "covered"), item("t2", 2, "tail")],
            );
            assert_eq!(run(&s, &request, &spine()).action, "HARD");

            let mut loaded = s.load(&session).unwrap();
            let profile_epoch = crate::profile_render_epoch(profile);
            let profile_epoch_component = if profile_epoch == 0 {
                String::new()
            } else {
                format!("mpe{profile_epoch}")
            };
            assert!(loaded.meta.last_render_config.contains("cre:4:cre2"));
            loaded.meta.last_render_config = effective_render_config_with_epochs(
                &s,
                "cfg0",
                format!("mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH),
                String::new(),
                profile_epoch_component,
                String::new(),
            );
            loaded
                .core
                .frozen_units
                .iter_mut()
                .find(|unit| unit.key == "m0")
                .unwrap()
                .frozen_payload =
                "<session-history><compartment title=\"old\" /></session-history>".to_string();
            s.commit(&session, loaded.row_version, &loaded.core, &loaded.meta)
                .unwrap();

            let transitioned = run(&s, &request, &spine());
            assert_eq!(
                transitioned.action,
                "HARD",
                "{} must fold the shared compartment render epoch",
                profile.wire_id()
            );
            assert!(m0_bytes(&transitioned).contains("## 1-1 · C1"));
            assert!(!m0_bytes(&transitioned).contains("<compartment"));

            let steady = run(&s, &request, &spine());
            assert_eq!(
                steady.action,
                "SOFT+",
                "{} must not loop the compartment render fold",
                profile.wire_id()
            );
            assert!(!steady.committed);
        }
    }

    #[test]
    fn reasoning_blocks_are_never_reduction_targets_and_poisoned_units_heal() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());

        fn reasoning_item(mid: &str, ordinal: u64) -> CkIngressMessage {
            CkIngressMessage {
                mid: mid.to_string(),
                ordinal,
                ck: CkWireMessage::from_parts(
                    "assistant",
                    vec![
                        ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                            text: format!("signed thinking {mid}"),
                            signature: Some(format!("sig-{mid}")),
                        }),
                        ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                            text: format!("answer {mid}"),
                        }),
                    ],
                    None,
                    ck_wire::ProviderExtras::new(),
                    ck_wire::HarnessMeta {
                        harness_id: Some(mid.to_string()),
                        ..Default::default()
                    },
                ),
            }
        }

        let messages = vec![
            item("u1", 1, "question"),
            reasoning_item("a1", 2),
            item("u2", 3, "live tail"),
        ];

        // An agent drop aimed at the reasoning block must not freeze, and its
        // pending row must retire as structurally unappliable.
        let active = active_cc_req("reason-guard", "cfg0", messages.clone());
        run(&s, &active, &spine());
        s.append_pending_agent_drops("reason-guard", &["a1#0".to_string()], 1)
            .unwrap();
        let busted = active_cc_req("reason-guard", "cfg1", messages.clone());
        let consumed = run(&s, &busted, &spine());
        assert_eq!(consumed.action, "HARD");
        let loaded = s.load("reason-guard").unwrap();
        assert!(
            !frozen_red_targets(&loaded.core).contains("a1#0"),
            "reasoning target must never freeze"
        );
        assert!(
            s.load_pending_agent_drops("reason-guard")
                .unwrap()
                .is_empty(),
            "structurally unappliable drop must retire from the queue"
        );
        let joined = serde_json::to_string(&consumed.ck_messages).unwrap();
        assert!(joined.contains("signed thinking a1"), "{joined}");
        assert!(joined.contains("sig-a1"), "{joined}");

        // A historically poisoned unit (minted by an older binary) heals at
        // render: the block serves verbatim signed bytes on every pass while the
        // unit stays frozen and inert.
        let mut poisoned = s.load("reason-guard").unwrap();
        poisoned
            .core
            .frozen_units
            .push(red_unit("a1#0", "drop", "[dropped]"));
        s.commit_transform(
            "reason-guard",
            TransformCommit {
                expected: poisoned.row_version,
                core: &poisoned.core,
                meta: &poisoned.meta,
                consumed_drop_ids: &[],
                first_applied_command_ids: &[],
                memory_revision: None,
                overlays: TransformOverlayBatch::default(),
            },
        )
        .unwrap();
        for _ in 0..2 {
            let pass = run(&s, &busted, &spine());
            let bytes = serde_json::to_string(&pass.ck_messages).unwrap();
            assert!(bytes.contains("signed thinking a1"), "{bytes}");
            assert!(bytes.contains("sig-a1"), "{bytes}");
            assert!(!bytes.contains("[dropped]"), "{bytes}");
        }
        assert!(
            frozen_red_targets(&s.load("reason-guard").unwrap().core).contains("a1#0"),
            "the poisoned unit stays frozen (monotonicity untouched), only inert"
        );
    }

    #[test]
    fn rig_repro_consumed_drops_render_bare_on_false_pass() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        // Active window: enough tagged blocks that the two oldest fall outside the
        // newest-20 protection set, so their drops actually consume.
        let messages: Vec<CkIngressMessage> = (1..=25)
            .map(|n| {
                item(
                    Box::leak(format!("u{n}").into_boxed_str()),
                    n,
                    "droppable content",
                )
            })
            .collect();
        let active = active_cc_req("rig-b", "cfg0", messages.clone());
        let warm = run(&s, &active, &spine());
        assert_eq!(warm.action, "HARD");
        s.append_pending_agent_drops("rig-b", &["u1#0".to_string(), "u2#0".to_string()], 1)
            .unwrap();
        // Drops drain only on bust-gated passes; a config change forces the HARD
        // that consumes them, mirroring how the rig's drops were consumed.
        let active_busted = active_cc_req("rig-b", "cfg1", messages.clone());
        let consumed = run(&s, &active_busted, &spine());
        assert_eq!(consumed.action, "HARD");
        // While active the numbered egress overlay is expected.
        let active_joined = serde_json::to_string(&consumed.ck_messages).unwrap();
        assert!(active_joined.contains("[dropped \u{a7}"), "{active_joined}");
        // Frozen bytes stay canonical bare.
        let frozen = s.load("rig-b").unwrap().core.frozen_units;
        for unit in frozen.iter() {
            assert!(
                !unit.frozen_payload.contains('\u{a7}'),
                "{}",
                unit.frozen_payload
            );
        }
        // False pass: hide the tool. Placeholders persist but must render BARE.
        let mut hidden = cc_req("rig-b", "cfg1", messages);
        hidden.tool_present = false;
        let transition = run(&s, &hidden, &spine());
        let false_joined = serde_json::to_string(&transition.ck_messages).unwrap();
        assert!(false_joined.contains("[dropped]"), "{false_joined}");
        assert!(!false_joined.contains('\u{a7}'), "{false_joined}");
        let steady = run(&s, &hidden, &spine());
        let steady_joined = serde_json::to_string(&steady.ck_messages).unwrap();
        assert!(!steady_joined.contains('\u{a7}'), "{steady_joined}");
    }
}
