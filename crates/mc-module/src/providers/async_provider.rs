//! Runner-owned tags and durable, off-request compaction views.
use super::codec::{InboundMessage, OutboundMessage};
use super::*;
use compact::{self as contract, ceiling::CeilingPolicy, notice, ride, view};
use cortexkit_bus_trait::{ContentDigest, DurableOwner, Stream, StreamCursor};
use cortexkit_role_llm_runner::{read::ReadMessage, tags};
use serde::Deserialize;
mod contract_policy;
mod cut_runtime;
mod cut_seed;
#[cfg(test)]
mod differential_tests;
mod emptied_messages;
mod frozen_edits;
mod full_array_floor;
mod held_entries;
mod historian_tail;
mod history_expand;
mod moved_session;
pub(crate) mod offline_first_pass;
pub(crate) mod reminder_echoes;
mod resident;
#[cfg(test)]
mod scaling_tests;
#[cfg(test)]
mod tests;
mod tool_arcs;
mod user_commands;
pub(super) mod wrapup;
use moved_session::CheckpointSource;
use resident::{EngineView, HeldEntry};
#[cfg(test)]
use scaling_tests::reminder_work;

/// The shared session reference for a bare runner module id, harness and
/// session, derived without `Key` so tests check the provider's keys against
/// the shared function. Named apart from the crate's `session_ref` so a call
/// still passing the old `(harness, folder, session)` strings cannot compile.
#[cfg(test)]
fn runner_session_ref(runner: &str, harness: &str, session: &str) -> String {
    cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
        runner,
        harness,
        session,
    })
}

/// Bound Setup's wait to the existing five-second issuer-call or NATS-connect
/// timeout; the retrying attach continues in the background, and no global lock
/// is held while Setup awaits it.
const ASYNC_BUS_SETUP_WAIT: Duration = Duration::from_secs(5);

fn bus_id(reference: &str, kind: &str, sequence: u64) -> String {
    format!("{reference}:{kind}:{sequence}")
}

fn log_session_model_fallback(
    namespace: &str,
    configured: &super::historian_config::ConfiguredHistorian,
) {
    if !configured.session_model_fallback {
        return;
    }
    let Some(model) = configured.model_chain.last() else {
        return;
    };
    static WARNED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    if WARNED
        .get_or_init(Default::default)
        .lock()
        .expect("session model fallback log")
        .insert(namespace.to_owned())
    {
        tracing::warn!(
            session = namespace,
            model,
            "historian_session_model_fallback"
        );
    }
}

#[async_trait]
trait Publisher: Send + Sync {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome>;
}

struct Bus<S> {
    stream: Arc<S>,
    account: String,
}

struct RoutedRunner<'a> {
    runner: &'a dyn session_resolver::ProviderRunner,
    route: crate::route_targets::SessionRunnerRoute,
    identity: session_resolver::RunnerBindIdentity,
}
#[async_trait]
impl session_resolver::ProviderRunner for RoutedRunner<'_> {
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if route != &self.route || identity != &self.identity {
            return Err(SessionResolveError::InvalidResponse(
                "session runner route identity mismatch".into(),
            ));
        }
        self.call(
            &identity.project_root,
            &identity.session,
            method,
            params,
            budget,
        )
        .await
    }

    async fn call(
        &self,
        project: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if session != self.route.parent_session()
            || session != self.identity.session
            || project != self.identity.project_root.as_path()
        {
            return Err(SessionResolveError::InvalidResponse(
                "session runner route mismatch".into(),
            ));
        }
        self.runner
            .call_for_identity(&self.route, &self.identity, method, params, budget)
            .await
    }
}

#[async_trait]
impl<S: Stream + 'static> Publisher for Bus<S> {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome> {
        let receipt = self
            .stream
            .publish(
                &notice::event_subject(&self.account, DEFAULT_MODULE_ID, notice::VIEW_READY_EVENT),
                &bus_id(&ready.session_ref, "view_ready", ready.view_version),
                ready.digest.parse::<ContentDigest>().map_err(transient)?,
                ready.to_headers(),
            )
            .await
            .map_err(transient)?;
        let _ = receipt.duplicate();
        Ok(())
    }
}

/// How far one budgeted transcript read got.
enum ReadProgress {
    Complete,
    /// The runner answered the read with its page for a session it never
    /// wrote: empty, with no `lineage_id` and no next page (llm-runner §4.2).
    /// There is nothing to read until the runner writes the session.
    NeverWritten,
    /// Every page read was valid, but the budget ran out before the runner's
    /// last page; `next` is the first ordinal not read.
    Incomplete {
        next: u64,
    },
}

#[derive(Default)]
pub(crate) struct Runtime {
    #[cfg(test)]
    policy_probe_enabled: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    policy_probe: Mutex<Option<PolicyProbe>>,
    #[cfg(test)]
    completed_notice: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    historian_evaluations: std::sync::atomic::AtomicU64,
    /// Historian evaluations spawned and not yet finished, so a test can wait
    /// for the background work a notice started.
    #[cfg(test)]
    historian_inflight: Arc<std::sync::atomic::AtomicU64>,
    pub(crate) connection_file: Mutex<Option<PathBuf>>,
    pub(crate) bootstrapped: OnceLock<()>,
    /// The bus link's named state, which a `bus_not_ready` refusal reports.
    pub(crate) bus_link: Arc<super::async_bus::LinkStatus>,
    publisher: Mutex<Option<Arc<dyn Publisher>>>,
    unconfigured_logged: OnceLock<()>,
    /// Conversations kept in memory between operations; see `resident`.
    pub(crate) resident: Mutex<resident::ResidentCache>,
    /// A test's notice read budget instead of the production one.
    #[cfg(test)]
    pub(crate) notice_read_budget: Mutex<Option<Duration>>,
    /// Test reference that projects every held transcript row whenever normal
    /// notice policy runs the engine; it still computes skip eligibility itself.
    #[cfg(test)]
    pub(crate) full_input_only: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(crate) record_notice_decisions: std::sync::atomic::AtomicBool,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AsyncRecord {
    #[serde(default, skip_serializing_if = "user_commands::Ledger::is_empty")]
    commands: user_commands::Ledger,
    #[serde(default)]
    historian_cadence: Option<HistorianCadence>,
    #[serde(default)]
    historian_pending: bool,
    #[serde(default)]
    restored_no_new_content: bool,
    #[serde(default)]
    resync_sources: Option<ResyncSources>,
    #[serde(default)]
    restored_head: Option<RestoredHead>,
    /// Set for a session the offline move brought over from the standalone
    /// OpenCode 1 plugin; see `moved_session`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    standalone_move: Option<moved_session::StandaloneMove>,
    /// Set for a Claude Code conversation ck-mc served on the full-array
    /// route before; see `full_array_floor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_array_floor: Option<full_array_floor::FullArrayFloor>,
    /// The named outcome of the last transcript read when it was not an
    /// ordinary page: `never_written` (see `ReadProgress::NeverWritten`).
    /// Shown by `ctx-status`; cleared by the next read that names a lineage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) read_outcome: Option<String>,
    /// The notice whose transcript read ran out of budget and is continued on
    /// its retry; see `read_async_resumable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    partial_read_seq: Option<u64>,
    /// A protocol error met while advancing this conversation; see
    /// `record_protocol_failure`. Absent while the conversation is healthy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<AsyncFailure>,
    /// The last engine pass for this conversation failed. Its next notice
    /// runs the engine again rather than skipping it, as a notice did before
    /// passes could be skipped: an engine refusal can depend on state a
    /// skipped pass would not look at.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    engine_failed: bool,
    #[serde(default)]
    last_discarded_drops: usize,
    #[serde(default)]
    last_transferred_drops: usize,
    /// Runner tag → part address for every held entry. Stored per entry in
    /// `mc_async_compaction_entries.index_json`, not in this record.
    #[serde(skip)]
    tag_index: BTreeMap<String, PartAddress>,
    /// Reuse hint facts while their frozen section, coverage and protected IDs agree.
    #[serde(skip)]
    reminder_hint_state: Option<ReminderHintState>,
    #[serde(default)]
    pub(crate) usage_policy: Option<super::usage_policy::UsagePolicyState>,
    #[serde(default)]
    pub(crate) todo_scan: Option<super::runner_todo::TodoScan>,
    #[serde(default)]
    pub(crate) runner_route: Option<Value>,
    #[serde(default)]
    pub(crate) dream_target: Option<Value>,
    #[serde(default)]
    pub(crate) reminder_cadence: Option<crate::runner_reminders::ReminderState>,
    #[serde(default)]
    reminder_echoes: reminder_echoes::ReminderEchoes,
    /// Acknowledged native reductions survive engine generation resets. Stored in
    /// a separate baseline row so quiet notices never rewrite their payloads.
    #[serde(skip)]
    frozen_edits: frozen_edits::FrozenEdits,
    #[serde(default)]
    frozen_edits_version: Option<u64>,
    #[serde(skip)]
    retired_frozen: frozen_edits::RetiredViews,
    /// Generation of the tail-hygiene baseline the reminder cadence last saw.
    /// The cadence is stored without the baseline itself: the baseline has one
    /// measurement per tail part (it grows with the session), every reminder
    /// pass replaces it from the engine's current one, and only its generation
    /// is compared across notices.
    #[serde(default)]
    reminder_baseline_generation: Option<u64>,
    key: Key,
    /// The reverse-call identity recorded at Setup. Its `project_root` is the
    /// folder of the route that delivered Setup: route metadata for config,
    /// docs and project memories, never part of the conversation's key.
    runner_identity: session_resolver::RunnerBindIdentity,
    runner_module: String,
    setup: compact::setup::SetupRequest,
    initial: Value,
    #[serde(default)]
    cache_policy: contract_policy::CachePolicy,
    /// Only the engine's fixed-size counters are in this record; its produced
    /// and applied baselines are named by `engine_baselines`.
    #[serde(with = "engine_header")]
    engine: transform::compaction::State,
    #[serde(default)]
    engine_baselines: EngineBaselines,
    /// Certificate recording which earlier source input the last permitted
    /// rebuild covered. Produced and applied views remain separate; a runner
    /// acknowledgement never advances this certificate.
    #[serde(default, deserialize_with = "deserialize_logical_prefix")]
    logical_prefix: Option<Arc<transform::compaction::LogicalPrefix>>,
    #[serde(default)]
    prefix_input_proof: Option<held_entries::InputProof>,
    /// Engine forms of this generation's retained published views, stored
    /// beside each view in `mc_async_compaction_views.engine_json`.
    #[serde(skip)]
    published_engine: BTreeMap<u64, EngineView>,
    /// The engine's produced and applied baselines, kept serialized. While a
    /// record is at rest `engine.last_produced` and `engine.last_applied` are
    /// `None`; `engine_with_baselines` parses these for an engine pass and
    /// `adopt_engine` takes the pass's result back.
    #[serde(skip)]
    produced_view: Option<EngineView>,
    #[serde(skip)]
    applied_view: Option<EngineView>,
    lineage: Option<String>,
    /// Explicit selection starts a new acknowledgement-ancestry root. Verified
    /// source descents may extend it; acknowledgement headers never do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ack_lineage_root: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    ack_selection_pending: bool,
    /// Source-only receipts survive partial reads until the actual lineage can
    /// qualify them. The owner comes from the stored public view, not the ack.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pending_native_acks: BTreeMap<u64, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_setup_predecessor: Option<SetupNativePredecessor>,
    /// The held transcript, stored one row per ordinal in
    /// `mc_async_compaction_entries`.
    #[serde(skip)]
    entries: held_entries::HeldEntries,
    /// Source identity lookup rebuilt from entry headers, never decoded history.
    #[serde(skip)]
    mid_index: BTreeMap<String, u64>,
    /// Running totals over the held entries' decoded facts; see
    /// `fold_entries`.
    #[serde(skip)]
    aggregates: resident::Aggregates,
    /// Bytes held by the entries through the given ordinal, so the resident
    /// size is updated by what each operation added.
    #[serde(skip)]
    entry_bytes: (Option<u64>, usize),
    /// The engine's cache state as last fully loaded for the reminder pass;
    /// see `engine_cache_state`.
    #[serde(skip)]
    cache_state: Option<resident::CachedEngineState>,
    #[serde(skip)]
    journal: Journal,
    seq: u64,
    completed_seq: u64,
    applied: Option<u64>,
    acknowledgements: Vec<String>,
    marker_outcomes: BTreeMap<String, String>,
    conditions: Option<BTreeMap<String, String>>,
    resync: bool,
    generation: u64,
    /// Set on a record `ck-mc offline first-pass` prepared, until the first
    /// live notice adopts or discards it; see `offline_first_pass`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offline_first_pass: Option<offline_first_pass::OfflineFirstPass>,
    /// The record format; see `cut_seed::RECORD_VERSION`. Absent on records
    /// written before cut seeds existed.
    #[serde(default)]
    record_version: u32,
    /// The first ordinal of a lineage that begins at a cut. Its compact prefix
    /// facts are stored in the `cut:<first ordinal>` slot. Archived window seeds
    /// are stored separately and loaded when a lineage selects their cut;
    /// quiet notices rewrite neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cut_first_ordinal: Option<u64>,
    /// What the conversation keeps of the transcript below its cut.
    #[serde(skip)]
    cut_seed: Option<Arc<cut_seed::CutSeed>>,
    #[serde(default)]
    lineage_first_ordinal: u64,
    /// Recent descriptors only. Older cut seeds remain in dedicated baseline
    /// rows and are point-loaded when a lineage selects their cut.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "cut_runtime::deserialize_cut_cache"
    )]
    published_cuts: BTreeMap<String, cut_runtime::PublishedCut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired_cut_stages: Vec<String>,
    #[serde(skip)]
    pending_cut_seeds: BTreeMap<String, cut_seed::CutSeed>,
    #[serde(skip)]
    pending_cut_metadata: BTreeMap<String, cut_runtime::PublishedCut>,
    #[serde(skip)]
    retired_cut_baselines: Vec<String>,
    /// Reclamation follows the replacement commit and can retry after a crash.
    /// Ordinary record loads never traverse the archive graph.
    #[serde(default)]
    cut_history_gc_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_parent_history: Option<cut_runtime::ParentHistory>,
    #[serde(default)]
    pending_undo_edits: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cut_signature: Option<crate::tail_hygiene::signature::SignaturePrefix>,
}

fn deserialize_logical_prefix<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Arc<transform::compaction::LogicalPrefix>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    // Prefix data is a disposable index. Unreadable cache data must recover
    // from entry rows rather than making the entire conversation unreadable.
    Ok(serde_json::from_value(value).ok().map(Arc::new))
}
type State = AsyncRecord;

#[cfg(test)]
type PolicyProbe = (u64, Option<u64>, Vec<String>);

#[derive(Serialize, Deserialize)]
struct SetupNativePredecessor {
    lineage: String,
    replaced_by: String,
    #[serde(default)]
    ack_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ack_version: Option<u64>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct VerifiedAckDescent {
    lineage: String,
    parent: String,
    root: String,
    through: u64,
}

fn ack_descent_slot(lineage: &str) -> String {
    format!(
        "verified-lineage:{}",
        contract::digest::content_digest(&json!(lineage))
    )
}

fn log_foreign_ack_once(reference: &str, version: u64) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if LOGGED
        .get_or_init(Default::default)
        .lock()
        .expect("foreign ack log")
        .insert(reference.to_owned())
    {
        tracing::warn!(
            session_ref = reference,
            version,
            "ignoring acknowledgement without a verified current compaction lineage"
        );
    }
}

/// The error code of an engine refusal that retrying the same input cannot
/// clear: the conversation's state or transcript breaks the engine's
/// protocol. A notice that meets one is retried at most
/// `MAX_PROTOCOL_ATTEMPTS` times in a row, then the conversation fails.
const PROTOCOL_ERROR: &str = "compaction_protocol";
const MAX_PROTOCOL_ATTEMPTS: u32 = 3;
/// The error code a ride answers for a failed conversation. The contract
/// reads a ride `ERROR` as `nothing`, so the runner keeps its current view
/// while the failure stays readable in the answer.
const FAILED_ERROR: &str = "compaction_failed";

/// A conversation's protocol failure, stored in its record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct AsyncFailure {
    /// `retrying` until the attempt bound, then `failed`: notices are then
    /// acknowledged without work and rides refused with `compaction_failed`,
    /// until the runner moves the conversation to a new lineage.
    pub state: FailureState,
    pub code: String,
    pub reason: String,
    /// The notice whose processing failed last.
    pub seq: u64,
    /// Consecutive failed attempts.
    pub attempts: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailureState {
    Retrying,
    Failed,
}

impl AsyncRecord {
    fn failed(&self) -> bool {
        self.failure
            .as_ref()
            .is_some_and(|failure| failure.state == FailureState::Failed)
    }
}

/// Classify an engine error. A range that ends inside a tool arc clears once
/// the runner writes the tool's result, so it stays retryable; every other
/// lineage or ordinal refusal is a protocol error.
fn engine_error(failure: transform::TransformError) -> HandlerOutcome {
    match &failure {
        transform::TransformError::LineageProtocol(reason)
            if reason.contains("ends inside a tool arc") =>
        {
            transient(failure)
        }
        transform::TransformError::LineageProtocol(_)
        | transform::TransformError::OrdinalViolation => error(PROTOCOL_ERROR, failure),
        _ => transient(failure),
    }
}

fn waiting_for_tool_result(failure: &HandlerOutcome) -> bool {
    matches!(failure, HandlerOutcome::Error { code, message }
        if code == "transient"
            && message == "lineage protocol error: compaction range ends inside a tool arc")
}

/// Where an engine baseline (`last_produced` / `last_applied`) is stored.
/// A baseline that is one of the retained published views is only named by
/// version, so acknowledging a view never copies the whole transcript again.
#[derive(Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
enum Baseline {
    #[default]
    Absent,
    Published(u64),
    Stored,
}

#[derive(Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
struct EngineBaselines {
    produced: Baseline,
    applied: Baseline,
}

/// Identity of an engine view. Within one generation the engine allocates
/// each view a fresh version, and a view only changes in place when a fork
/// descent rewrites its range, so version, range and length identify it
/// without comparing every message.
type ViewIdentity = (u64, transform::compaction::Range, usize);

fn view_identity(view: &transform::compaction::View) -> ViewIdentity {
    (view.version, view.range.clone(), view.replacement.len())
}

/// What the store already holds for this record, so a save writes only the
/// difference. Not persisted; rebuilt by every full load.
#[derive(Default)]
struct Journal {
    /// False for a record read without its rows (a read-only check); saving
    /// such a record would erase its transcript, so it is refused.
    complete: bool,
    /// Highest held ordinal already stored.
    persisted_through: Option<u64>,
    /// Highest held ordinal already in `tag_index`.
    indexed_through: Option<u64>,
    /// Stored entries to delete on the next save: after this ordinal, or all
    /// of them for `Some(None)`.
    truncate: Option<Option<u64>>,
    /// The published views' engine forms belong to a discarded generation.
    clear_published: bool,
    /// Messages a cut removed: their rows in the namespace's tag table go
    /// on the next save, because the next lineage may show their numbers on
    /// other parts.
    forget_tags_of: Vec<String>,
    /// Stored entries below this ordinal go on the next save (a cut).
    truncate_below: Option<u64>,
    /// The cut seed changed and is written on the next save.
    cut_seed_dirty: bool,
    /// Identities of the baselines as last stored.
    produced: Option<ViewIdentity>,
    applied: Option<ViewIdentity>,
    /// The small record exactly as last saved or loaded. A resident record is
    /// reused only while the store still holds this JSON.
    saved_json: Option<String>,
}

impl Journal {
    fn new_record() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }
}

/// Serialize only the engine's fixed-size fields; its baselines are stored
/// separately (see `EngineBaselines`).
mod engine_header {
    use super::transform::compaction::{Preset, State};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Serialize, Deserialize)]
    struct Header {
        compaction_id: String,
        preset: Preset,
        version_high_water: u64,
        rebuild_epoch: u64,
    }

    pub(super) fn serialize<S: Serializer>(
        engine: &State,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        Header {
            compaction_id: engine.compaction_id.clone(),
            preset: engine.preset,
            version_high_water: engine.version_high_water,
            rebuild_epoch: engine.rebuild_epoch,
        }
        .serialize(serializer)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<State, D::Error> {
        let header = Header::deserialize(deserializer)?;
        Ok(State {
            compaction_id: header.compaction_id,
            preset: header.preset,
            version_high_water: header.version_high_water,
            rebuild_epoch: header.rebuild_epoch,
            last_produced: None,
            last_applied: None,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct PartAddress {
    ordinal: u64,
    mid: String,
    part: String,
    digest: String,
}

#[derive(Serialize, Deserialize)]
struct SourceMessage {
    mid: String,
    digest: String,
}
#[derive(Serialize, Deserialize)]
struct HistorySource {
    compartment: mc_store::StoredCompartment,
    messages: Vec<SourceMessage>,
}
#[derive(Serialize, Deserialize)]
struct DropSource {
    mid: String,
    part: String,
    digest: String,
    queued_at_ms: i64,
}
#[derive(Serialize, Deserialize)]
struct ResyncSources {
    namespace: String,
    #[serde(default)]
    lineage: Option<String>,
    #[serde(default)]
    from_start: bool,
    history: Vec<HistorySource>,
    drops: Vec<DropSource>,
    queued_count: usize,
    head: Option<HistoryHeadSource>,
    #[serde(default)]
    messages: Vec<SourceMessage>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct HistorianCadence {
    user: Option<String>,
    tools: u64,
    model: String,
    settings: String,
}

#[derive(Serialize, Deserialize)]
struct HistoryHeadSource {
    bytes: String,
    messages: Vec<SourceMessage>,
    /// An opaque cut head may have no held source rows. Its proof is the
    /// retained cut, not an empty digest list; undoing that cut invalidates it.
    #[serde(default)]
    required_cut: Option<(u64, String, String)>,
}
#[derive(Serialize, Deserialize)]
struct RestoredHead {
    bytes: String,
    to: u64,
}

fn verified_descent(state: &State, header: &str) -> Option<u64> {
    let mut fields = header.rsplitn(3, ':');
    let digest = fields.next()?;
    let through = fields.next()?.parse::<u64>().ok()?;
    let lineage = fields.next()?;
    if through < state.lineage_first_ordinal.saturating_sub(1) {
        return None;
    }
    if state.lineage.as_deref() != Some(lineage) {
        return None;
    }
    let entry = state.entries.get(&through)?.read().ok()?;
    (served_digest(&entry).ok()? == digest).then_some(through)
}

/// A failed call to the session's runner. A reply in the wrong envelope is a
/// contract violation counted as a protocol error (and so recorded on the
/// conversation, logged and shown by `ctx-status`), never a transient retry.
fn runner_error(failure: SessionResolveError) -> HandlerOutcome {
    match failure {
        SessionResolveError::ReplyShape(_) => error(PROTOCOL_ERROR, failure.to_string()),
        other => transient(other),
    }
}

/// The named outcome of a read the runner answered with its page for a
/// session it never wrote.
const NEVER_WRITTEN: &str = "never_written";
/// The protocol-error reason prefix for any other page without a lineage.
const LINEAGELESS_PAGE: &str = "lineageless_page";

/// A `session.read` page with no `lineage_id`. The contract allows exactly
/// one: a session the runner never wrote answers an empty page with no
/// lineage and no next page (llm-runner §4.2). Any other page without a
/// lineage, including that page for a session ck-mc already holds messages
/// of, is a contract violation refused by name.
fn lineageless_page(state: &State, page: &Value) -> Result<ReadProgress, HandlerOutcome> {
    let messages = page.get("messages").and_then(Value::as_array);
    let count = messages.map_or(0, Vec::len);
    let keys = page
        .as_object()
        .map(|page| page.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let never_written = messages.is_some_and(Vec::is_empty)
        && page.get("next_from_ordinal").is_none_or(Value::is_null)
        && state.entries.is_empty();
    log_read_identity_once(state, Some((&keys, count, never_written)));
    if never_written {
        return Ok(ReadProgress::NeverWritten);
    }
    Err(error(
        PROTOCOL_ERROR,
        format!(
            "{LINEAGELESS_PAGE}: a page without a lineage must be empty, with no next page, \
             and only for a session never written; got keys {keys:?}, {count} messages, \
             {} held",
            state.entries.len()
        ),
    ))
}

/// Log, once per conversation, the identity ck-mc's reads use (the project,
/// harness and session from `runner_identity`), and, once per conversation
/// and outcome, a page without a lineage with its top-level keys and message
/// count. One line then shows a read whose identity names no session the
/// runner wrote.
fn log_read_identity_once(state: &State, lineageless: Option<(&[String], usize, bool)>) {
    static LOGGED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let reference = state.reference();
    let key = match lineageless {
        None => format!("{reference}:identity"),
        Some((_, _, true)) => format!("{reference}:{NEVER_WRITTEN}"),
        Some((_, _, false)) => format!("{reference}:{LINEAGELESS_PAGE}"),
    };
    if !LOGGED
        .get_or_init(Default::default)
        .lock()
        .expect("read identity log")
        .insert(key)
    {
        return;
    }
    let identity = state.runner_identity();
    let fields = format!(
        "session_ref={reference} project={} harness={} session={}",
        identity.project_root.to_string_lossy(),
        identity.harness,
        identity.session
    );
    let line = match lineageless {
        None => format!("async_read_identity {fields}"),
        Some((keys, messages, never_written)) => format!(
            "async_read_lineageless_page {fields} page_keys={keys:?} messages={messages} outcome={}",
            if never_written { NEVER_WRITTEN } else { LINEAGELESS_PAGE }
        ),
    };
    if lineageless.is_some() {
        tracing::warn!("{line}");
    } else {
        tracing::info!("{line}");
    }
    #[cfg(test)]
    READ_LOG.with(|log| log.borrow_mut().push(line));
}

// The read-identity lines this thread logged, for tests.
#[cfg(test)]
thread_local! {
    static READ_LOG: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The protocol-error reason prefix for a descriptors-mode read whose message
/// lacks the runner's content digests.
const SERVED_DIGEST_MISSING: &str = "served_digest_missing";

fn missing_served_digest(entry: &ReadMessage, reason: impl std::fmt::Display) -> HandlerOutcome {
    error(
        PROTOCOL_ERROR,
        format!(
            "{SERVED_DIGEST_MISSING}: message {} at ordinal {}: {reason}",
            entry.mid, entry.ordinal
        ),
    )
}

/// Check a newly read message carries the runner's content identity:
/// a message `digest` and one `part_digests` row per top-level part of the
/// message under the session's serializer profile, keyed exactly as its tag
/// rows are and in the same order. The rule is llm-runner's own
/// provider-side check, `ReadMessage::check_descriptor_rows`. A runner that
/// serves none in descriptors mode is refused by name; ck-mc never hashes a
/// descriptor in its place.
fn check_served_identity(entry: &ReadMessage, codec: codec::Codec) -> Result<(), HandlerOutcome> {
    entry
        .check_descriptor_rows(codec.wire_id())
        .map_err(|reason| missing_served_digest(entry, reason))
}

/// The runner's content digest of a held message (compaction-provider §5).
///
/// A message read in descriptors mode carries it (checked when it was
/// read). A message held from before ck-mc read in descriptors mode was read
/// inline, so its stored body is the full inline message the digest is
/// defined over; only such a body, one holding no ref, is hashed here.
fn served_digest(entry: &ReadMessage) -> Result<String, HandlerOutcome> {
    match &entry.digest {
        Some(digest) => Ok(digest.clone()),
        None => inline_digest(entry, &entry.message),
    }
}

/// The runner's content digest of the part keyed `part` in a held message,
/// from its `part_digests` row; for a message held from an inline read, the
/// digest of that part's inline body (see [`served_digest`]).
fn served_part_digest(entry: &ReadMessage, part: &str) -> Result<String, HandlerOutcome> {
    if let Some(rows) = &entry.part_digests {
        return rows
            .iter()
            .find(|row| row.part == part)
            .map(|row| row.digest.clone())
            .ok_or_else(|| missing_served_digest(entry, format!("no digest for part {part}")));
    }
    let index = entry
        .tags
        .iter()
        .position(|row| row.part == part)
        .ok_or_else(|| missing_served_digest(entry, format!("no part {part}")))?;
    let native = parts(&entry.message)?;
    let body = native
        .get(index)
        .ok_or_else(|| missing_served_digest(entry, format!("no body for part {part}")))?;
    inline_digest(entry, body)
}

fn inline_digest(entry: &ReadMessage, body: &Value) -> Result<String, HandlerOutcome> {
    if crate::descriptors::holds_descriptor(body) {
        return Err(missing_served_digest(
            entry,
            "a described message has no served digest",
        ));
    }
    Ok(contract::digest::content_digest(body))
}

/// The stored records of the conversations a tool or flush call's route names.
///
/// A route attested to a session runner names its conversations by that
/// runner and the bound session, whatever folder spelling the route carries.
/// A route with no attested runner, such as a Claude Code MCP facade, names
/// a conversation by its session, admitted only when the route's folder is
/// exactly the folder of the route that delivered Setup. That folder filters
/// such routes; it is never part of the conversation's key.
pub(super) fn route_records(
    store: &McStore,
    binding: &SessionBinding,
) -> Result<Vec<String>, HandlerOutcome> {
    if let Some(runner) = records::attested_runner(binding)
        .filter(|module| crate::route_targets::SESSION_RUNNER_MODULE_IDS.contains(module))
    {
        return store
            .async_compaction_for_session(runner, &binding.session)
            .map_err(transient);
    }
    #[derive(Deserialize)]
    struct SetupRoute {
        runner_identity: session_resolver::RunnerBindIdentity,
    }
    let mut admitted = Vec::new();
    for raw in store
        .async_compaction_records_for_session(&binding.session)
        .map_err(transient)?
    {
        let route: SetupRoute = serde_json::from_str(&raw).map_err(transient)?;
        if route.runner_identity.project_root.as_os_str() == binding.project_root.as_os_str() {
            admitted.push(raw);
        }
    }
    Ok(admitted)
}

impl State {
    fn remember_verified_ack_descent(
        &mut self,
        store: &McStore,
        lineage: &str,
        parent: &str,
        through: u64,
    ) -> Result<(), HandlerOutcome> {
        let root = self
            .ack_lineage_root
            .get_or_insert_with(|| parent.to_owned())
            .clone();
        let record = VerifiedAckDescent {
            lineage: lineage.to_owned(),
            parent: parent.to_owned(),
            root,
            through,
        };
        let slot = ack_descent_slot(lineage);
        if let Some(raw) = store
            .load_async_compaction_baseline(&self.reference(), &slot)
            .map_err(transient)?
        {
            if serde_json::from_str::<VerifiedAckDescent>(&raw)
                .ok()
                .as_ref()
                != Some(&record)
            {
                // Reused or damaged lineage identities cannot grant ancestry.
                self.ack_lineage_root = Some(lineage.to_owned());
            }
            return Ok(());
        }
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let header = serde_json::to_string(self).map_err(transient)?;
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &header);
        save.immutable_baseline(slot, serde_json::to_string(&record).map_err(transient)?);
        save.commit().map_err(transient)?;
        Ok(())
    }

    fn recorded_ack_ancestor(
        &self,
        store: &McStore,
        ancestor: &str,
    ) -> Result<bool, HandlerOutcome> {
        let (Some(current), Some(root)) = (&self.lineage, &self.ack_lineage_root) else {
            return Ok(false);
        };
        let mut cursor = current.clone();
        let mut visited = HashSet::new();
        while cursor != *root && visited.insert(cursor.clone()) {
            let Some(raw) = store
                .load_async_compaction_baseline(&self.reference(), &ack_descent_slot(&cursor))
                .map_err(transient)?
            else {
                return Ok(false);
            };
            let Ok(record) = serde_json::from_str::<VerifiedAckDescent>(&raw) else {
                return Ok(false);
            };
            if record.lineage != cursor || record.root != *root {
                return Ok(false);
            }
            if record.parent == ancestor {
                return Ok(true);
            }
            cursor = record.parent;
        }
        Ok(false)
    }

    fn record_restored_ack_descent(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(current) = self.lineage.clone() else {
            return Ok(());
        };
        let Some(sources) = &self.resync_sources else {
            return Ok(());
        };
        if sources.lineage.as_deref() == Some(current.as_str())
            || self.ack_lineage_root.as_deref() == Some(current.as_str())
        {
            return Ok(());
        }
        // A lost-state restore can omit descends_from. Certify it independently
        // of acknowledgements only when the entire previously held transcript
        // prefix, starting at zero, is still present with identical identities.
        let complete = self.ack_lineage_root.is_some()
            && sources.from_start
            && self.lineage_first_ordinal == 0
            && !sources.messages.is_empty()
            && sources
                .messages
                .iter()
                .enumerate()
                .all(|(ordinal, source)| {
                    self.entries
                        .get(&(ordinal as u64))
                        .filter(|entry| entry.mid == source.mid)
                        .and_then(|entry| entry.read().ok())
                        .and_then(|entry| served_digest(&entry).ok())
                        .as_deref()
                        == Some(source.digest.as_str())
                });
        if complete {
            if let Some(parent) = sources.lineage.clone() {
                let through = sources.messages.len() as u64 - 1;
                self.remember_verified_ack_descent(store, &current, &parent, through)?;
                return Ok(());
            }
        }
        self.ack_lineage_root = Some(current);
        Ok(())
    }

    fn applied_lineage(
        &self,
        store: &McStore,
        version: u64,
    ) -> Result<Option<String>, HandlerOutcome> {
        // Public ownership is separate from a rebased engine range/counter.
        // Older cache rows without that metadata fall back to the public view.
        if let Some(lineage) = self
            .published_engine
            .get(&version)
            .and_then(|view| view.publication_lineage.as_ref())
        {
            return Ok(Some(lineage.clone()));
        }
        store
            .load_async_compaction_view(&self.reference(), version)
            .map_err(transient)?
            .map(|raw| {
                serde_json::from_str::<view::CompactionView>(&raw)
                    .map(|view| view.lineage_id)
                    .map_err(transient)
            })
            .transpose()
    }

    fn normalize_notice_ack(
        &self,
        store: &McStore,
        notice: &mut notice::AdvanceNotice,
    ) -> Result<(), HandlerOutcome> {
        let acknowledged_lineage = notice
            .applied_view_version
            .map(|version| self.applied_lineage(store, version))
            .transpose()?
            .flatten();
        let foreign_ack = if notice.applied_view_version.is_some() {
            self.lineage.is_none() || acknowledged_lineage.as_deref() != self.lineage.as_deref()
        } else {
            false
        };
        if foreign_ack {
            let recorded_ancestor = acknowledged_lineage
                .as_deref()
                .map(|lineage| self.recorded_ack_ancestor(store, lineage))
                .transpose()?
                .unwrap_or(false);
            // resolve_native_acks qualifies native source evidence separately.
            // Foreign publications supply no view, summary, baseline or pass
            // facts. Unrelated acknowledgements are ignored rather than retried.
            if !recorded_ancestor
                && !acknowledged_lineage
                    .as_deref()
                    .is_some_and(|owner| self.is_native_setup_predecessor(owner))
            {
                log_foreign_ack_once(
                    &self.reference(),
                    notice
                        .applied_view_version
                        .expect("foreign acknowledgement"),
                );
            }
            let rejected = notice
                .applied_view_version
                .expect("foreign acknowledgement");
            notice.events.retain(|event| match event {
                // Do not reassign the rejected applied_view_version's marker
                // or companion facts to the current-lineage baseline.
                notice::Event::MarkerOutcome { .. } => false,
                notice::Event::ViewDeferred { view_version, .. }
                | notice::Event::ViewRefused { view_version, .. }
                | notice::Event::ViewCompanion { view_version, .. } => *view_version != rejected,
                _ => true,
            });
            notice.applied_view_version = match self.applied {
                Some(version)
                    if self.lineage.is_some()
                        && self.applied_lineage(store, version)?.as_deref()
                            == self.lineage.as_deref() =>
                {
                    Some(version)
                }
                _ => None,
            };
        }
        Ok(())
    }

    fn adopt_notice_ack(
        &mut self,
        store: &McStore,
        notice: &mut notice::AdvanceNotice,
    ) -> Result<(), HandlerOutcome> {
        self.remember_notice_native_ack(store, notice)?;
        self.resolve_native_acks(store)?;
        self.normalize_notice_ack(store, notice)?;
        if let Some(version) = notice.applied_view_version.filter(|version| {
            self.frozen_edits_version != Some(*version)
                && !notice.events.iter().any(|event| {
                    matches!(event,
                    notice::Event::ViewDeferred { view_version, .. }
                    | notice::Event::ViewRefused { view_version, .. } if view_version == version)
                })
        }) {
            self.capture_frozen_version(store, version)?;
            self.frozen_edits_version = Some(version);
        }
        self.applied = notice.applied_view_version;
        // Repeated acknowledgements do not rewrite an unchanged baseline.
        if let Some(applied) = self
            .applied
            .and_then(|version| self.published_engine.get(&version))
            .filter(|view| Some(&view.identity.1.lineage_id) == self.lineage.as_ref())
            .filter(|view| {
                self.applied_view.as_ref().map(|held| &held.identity) != Some(&view.identity)
            })
        {
            self.applied_view = Some(applied.clone());
        }
        self.acknowledgements = notice.events.iter().map(notice::Event::token).collect();
        for token in &self.acknowledgements {
            if let Some(outcome) = token.strip_prefix("marker_outcome:") {
                if let Some((result, cut)) = outcome.split_once(':') {
                    self.marker_outcomes.insert(cut.into(), result.into());
                }
            }
        }
        self.conditions = Some(notice.to_headers());
        // Accepted wire facts must survive even if the next engine pass fails.
        self.save(store, &[])
    }

    fn runner_identity(&self) -> session_resolver::RunnerBindIdentity {
        self.runner_identity.clone()
    }

    /// The project folder of the route that delivered Setup, for config, docs
    /// and project memories. Never part of the conversation's key.
    fn project(&self) -> &Path {
        &self.runner_identity.project_root
    }

    fn runner(&self) -> Result<crate::route_targets::SessionRunnerRoute, HandlerOutcome> {
        crate::route_targets::SessionRunnerRoute::for_principal(
            Some(&subc_protocol::Principal::Reserved {
                module_id: self.runner_module.clone(),
            }),
            &self.key.session,
        )
        .ok_or_else(|| invalid_field("runner", "unsupported session runner principal"))
    }
    fn reference(&self) -> String {
        self.key.reference()
    }
    fn namespace(&self) -> String {
        format!("{}:async:{}", self.key.engine_key(), self.generation)
    }

    /// Persist the entries of a read the budget cut short, with their tag
    /// rows, so a retry continues after them. Sources restored after a resync
    /// and a moved session's import are bound only once the read completes.
    fn save_partial_read(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        self.reindex()?;
        let rows = self.unsaved_tag_rows(codec)?;
        self.save(store, &rows)
    }

    /// Validate and persist a completed transcript read while its provider
    /// serial is held, before returning the record to the resident cache.
    fn ingest_read(&mut self, store: &McStore, codec: codec::Codec) -> Result<(), HandlerOutcome> {
        self.reindex()?;
        self.restore_sources(store, codec)?;
        self.restore_undo_edits(store)?;
        self.bind_standalone_move(store, codec)?;
        let rows = self.unsaved_tag_rows(codec)?;
        self.save(store, &rows)
    }

    /// Persist this record in one transaction: the small record plus only
    /// what changed since it was loaded or last saved (new held entries, a
    /// transcript cut, changed baselines, view retention). `tag_rows` are the
    /// runner tag rows of the newly held entries; see `unsaved_tag_rows`.
    fn save(
        &mut self,
        store: &McStore,
        tag_rows: &[mc_store::McTagRow],
    ) -> Result<(), HandlerOutcome> {
        #[cfg(test)]
        let _timer = scaling_tests::save_meter::start(&self.reference());
        if !self.journal.complete {
            return Err(transient("async record was loaded without its transcript"));
        }
        self.reindex()?;
        let mut baselines = Vec::new();
        let produced = self.place_baseline(
            self.produced_view.as_ref(),
            self.journal.produced.as_ref(),
            self.engine_baselines.produced,
        );
        if let Some((mode, write)) = produced {
            self.engine_baselines.produced = mode;
            baselines.extend(write.map(|view| ("produced", view)));
        }
        let applied = self.place_baseline(
            self.applied_view.as_ref(),
            self.journal.applied.as_ref(),
            self.engine_baselines.applied,
        );
        if let Some((mode, write)) = applied {
            self.engine_baselines.applied = mode;
            baselines.extend(write.map(|view| ("applied", view)));
        }
        // Keep the applied version, everything newer (not yet acknowledged)
        // and any version an engine baseline names; the store also keeps the
        // newest version.
        let retain_from = self.applied.map(|applied| {
            [
                self.engine_baselines.produced,
                self.engine_baselines.applied,
            ]
            .into_iter()
            .filter_map(|baseline| match baseline {
                Baseline::Published(version) => Some(version),
                _ => None,
            })
            .fold(applied, u64::min)
        });
        let retain_from = retain_from.map(|floor| {
            self.native_setup_predecessor
                .as_ref()
                .and_then(|prior| prior.ack_version)
                .map_or(floor, |version| floor.min(version))
        });
        if let Some(floor) = retain_from {
            let floor = self
                .pending_native_acks
                .first_key_value()
                .map_or(floor, |(version, _)| floor.min(*version));
            self.retired_frozen.retain_from(floor);
        }
        let mut appended = Vec::new();
        for (ordinal, entry) in self.unsaved_entries() {
            appended.push((
                *ordinal,
                entry.raw().to_owned(),
                self.entry_index(*ordinal)?,
            ));
        }
        let namespace = self.namespace();
        self.prepare_cut_metadata(store)?;
        if self.journal.cut_seed_dirty {
            self.cut_history_gc_pending = true;
            if let Some(seed) = self.cut_seed.as_mut() {
                let seed = Arc::make_mut(seed);
                if seed.recovery_history_ref.is_none() && !seed.recovery_history.is_empty() {
                    let summary_end = seed.summary_end();
                    let history = std::mem::take(&mut seed.recovery_history);
                    seed.set_recovery_history(
                        history,
                        store
                            .compartment_history_identity(&namespace)
                            .map_err(transient)?,
                        summary_end,
                    )?;
                }
            }
        }
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let state = serde_json::to_string(self).map_err(transient)?;
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &state);
        save.retain_cut_facts(self.cut_first_ordinal);
        save.tags(&namespace, tag_rows);
        save.forget_tags_of(self.journal.forget_tags_of.clone());
        if let Some(through) = self.journal.truncate {
            save.truncate_entries(through);
        }
        if let Some(first) = self.journal.truncate_below {
            save.truncate_below(first);
        }
        if let (true, Some(seed)) = (self.journal.cut_seed_dirty, &self.cut_seed) {
            for (slot, raw) in &seed.pending_history_objects {
                save.immutable_baseline(slot, raw.clone());
            }
            save.baseline(
                cut_seed::CutSeed::slot(seed.first_ordinal),
                Some(serde_json::to_string(seed.as_ref()).map_err(transient)?),
            );
        }
        for (first, seed) in &self.pending_cut_seeds {
            for (slot, raw) in &seed.pending_history_objects {
                save.immutable_baseline(slot, raw.clone());
            }
            save.baseline(
                format!("published-cut:{first}"),
                Some(serde_json::to_string(seed).map_err(transient)?),
            );
            save.baseline(
                format!("published-cut-root:{first}"),
                Some(serde_json::to_string(&seed.history_root()).map_err(transient)?),
            );
        }
        for (first, cut) in &self.pending_cut_metadata {
            save.baseline(
                format!("published-cut-meta:{first}"),
                Some(serde_json::to_string(cut).map_err(transient)?),
            );
            save.baseline(
                format!("published-cut-candidate:{first}"),
                Some(cut.candidate_json()?),
            );
        }
        for slot in &self.retired_cut_baselines {
            save.baseline(slot, None);
        }
        if !self.pending_cut_seeds.is_empty() {
            save.baseline("pending-cut-stage", None);
        }
        for (ordinal, entry, index) in appended {
            save.append_entry(ordinal, entry, index);
        }
        for (slot, view) in baselines {
            save.baseline(slot, view.map(|json| json.to_string()));
        }
        if self.frozen_edits.dirty {
            save.baseline("frozen_edits", Some(self.frozen_edits.json()?));
        }
        if self.retired_frozen.dirty {
            save.baseline("retired_native_edits", Some(self.retired_frozen.json()?));
        }
        if self.journal.clear_published {
            save.clear_engine_views();
        }
        if let Some(floor) = retain_from {
            save.retain_views_from(floor);
        }
        if let Err(error) = save.commit() {
            // The in-memory journal no longer describes the store; a retry
            // must reload rather than save a wrong difference.
            self.journal.complete = false;
            return Err(transient(error));
        }
        self.cleanup_retired_cut_stages(store)?;
        if self.cut_history_gc_pending && !self.pending_cut_seeds.is_empty() {
            // Archive GC cannot make an otherwise usable conversation fail.
            // Keep its durable retry flag if marking finds corrupt history.
            if let Err(error) = self.gc_cut_history(store) {
                tracing::warn!(?error, "cut history reclamation deferred");
            }
        }
        self.journal.truncate = None;
        self.journal.truncate_below = None;
        self.journal.cut_seed_dirty = false;
        self.pending_cut_seeds.clear();
        self.pending_cut_metadata.clear();
        self.retired_cut_baselines.clear();
        if let Some(seed) = &mut self.cut_seed {
            Arc::make_mut(seed).pending_history_objects.clear();
        }
        self.journal.forget_tags_of.clear();
        self.frozen_edits.dirty = false;
        self.retired_frozen.dirty = false;
        self.journal.clear_published = false;
        self.journal.persisted_through = self.entries.last_key_value().map(|(n, _)| *n);
        self.journal.produced = self
            .produced_view
            .as_ref()
            .map(|view| view.identity.clone());
        self.journal.applied = self.applied_view.as_ref().map(|view| view.identity.clone());
        self.journal.saved_json = Some(state);
        if let Some(floor) = retain_from {
            let newest = self.published_engine.last_key_value().map(|(n, _)| *n);
            self.published_engine
                .retain(|version, _| *version >= floor || Some(*version) == newest);
        }
        Ok(())
    }

    /// Held entries not yet stored.
    fn unsaved_entries(&self) -> impl Iterator<Item = (&u64, &Arc<HeldEntry>)> {
        let from = self
            .journal
            .persisted_through
            .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        self.entries.range((from, std::ops::Bound::Unbounded))
    }

    /// Runner tag rows for the held entries not yet stored. Rows of stored
    /// entries are already in the namespace's tag table.
    fn unsaved_tag_rows(
        &self,
        codec: codec::Codec,
    ) -> Result<Vec<mc_store::McTagRow>, HandlerOutcome> {
        tag_rows_for(self.unsaved_entries().map(|(_, entry)| entry), codec)
    }

    /// The stored tag addresses of one entry: `[tag, part key, part digest]`
    /// for each tagged part, taken from the index `reindex` built.
    fn entry_index(&self, ordinal: u64) -> Result<String, HandlerOutcome> {
        let entry = self
            .entries
            .get(&ordinal)
            .ok_or_else(|| transient("async entry missing"))?
            .read()?;
        let mut index = Vec::new();
        for row in &entry.tags {
            if let Some(tag) = &row.tag {
                let address = self
                    .tag_index
                    .get(tag)
                    .filter(|address| address.ordinal == entry.ordinal)
                    .ok_or_else(|| transient("async entry saved before it was indexed"))?;
                index.push([tag.as_str(), row.part.as_str(), address.digest.as_str()]);
            }
        }
        serde_json::to_string(&index).map_err(transient)
    }

    /// Decide how a baseline is stored. `None` when it is unchanged since the
    /// last save; otherwise its new placement and, for the baselines table,
    /// the row to write (`Some(json)`) or delete (`None`).
    #[allow(clippy::type_complexity)]
    fn place_baseline(
        &self,
        view: Option<&EngineView>,
        stored: Option<&ViewIdentity>,
        previous: Baseline,
    ) -> Option<(Baseline, Option<Option<Arc<str>>>)> {
        let identity = view.map(|view| &view.identity);
        if identity == stored {
            return None;
        }
        let stale_row = (previous == Baseline::Stored).then_some(None);
        let Some(view) = view else {
            return Some((Baseline::Absent, stale_row));
        };
        let published = self
            .published_engine
            .iter()
            .rev()
            .find(|(_, published)| Some(&published.identity) == identity)
            .map(|(version, _)| *version);
        Some(match published {
            Some(version) => (Baseline::Published(version), stale_row),
            None => (Baseline::Stored, Some(Some(Arc::clone(&view.json)))),
        })
    }

    /// Take the first lineage the runner names after a Setup that carried
    /// none. Setup's initial view was built for no lineage; the first
    /// lineage is its first assignment, not a change, so the view's range
    /// takes it on. A held conversation already bound to a lineage, or one
    /// a resync emptied, has nothing to rebind.
    fn adopt_first_lineage(&mut self, lineage: &str) -> Result<(), HandlerOutcome> {
        if self.ack_selection_pending {
            self.ack_lineage_root = Some(lineage.to_owned());
            self.ack_selection_pending = false;
        }
        let unbound = |view: &Option<EngineView>| {
            view.as_ref()
                .is_some_and(|view| view.identity.1.lineage_id.is_empty())
        };
        if !unbound(&self.produced_view) && !unbound(&self.applied_view) {
            return Ok(());
        }
        let mut engine = self.engine_with_baselines()?;
        for view in [&mut engine.last_produced, &mut engine.last_applied]
            .into_iter()
            .flatten()
        {
            if view.range.lineage_id.is_empty() {
                view.range.lineage_id = lineage.into();
            }
        }
        self.adopt_engine(engine)
    }

    /// The engine state with its baselines parsed, for one engine pass or a
    /// descent. Hand the result back with `adopt_engine`.
    fn engine_with_baselines(&self) -> Result<transform::compaction::State, HandlerOutcome> {
        let mut engine = self.engine.clone();
        engine.last_produced = self
            .produced_view
            .as_ref()
            .map(EngineView::view)
            .transpose()?;
        engine.last_applied = self
            .applied_view
            .as_ref()
            .map(EngineView::view)
            .transpose()?;
        Ok(engine)
    }

    /// Take back an engine state from `engine_with_baselines`. A baseline
    /// whose identity is unchanged keeps its serialized form: within one
    /// generation the engine only replaces a baseline with a view of another
    /// version, and a descent changes the range, so an equal identity means
    /// equal content (the same rule the save journal relies on).
    fn adopt_engine(
        &mut self,
        mut engine: transform::compaction::State,
    ) -> Result<(), HandlerOutcome> {
        fn adopt(
            held: &mut Option<EngineView>,
            view: Option<transform::compaction::View>,
            published: &BTreeMap<u64, EngineView>,
        ) -> Result<(), HandlerOutcome> {
            let Some(view) = view else {
                *held = None;
                return Ok(());
            };
            let identity = view_identity(&view);
            if held.as_ref().is_some_and(|held| held.identity == identity) {
                return Ok(());
            }
            *held = Some(
                match published.values().rev().find(|p| p.identity == identity) {
                    Some(published) => published.clone(),
                    None => EngineView::of(&view)?,
                },
            );
            Ok(())
        }
        adopt(
            &mut self.produced_view,
            engine.last_produced.take(),
            &self.published_engine,
        )?;
        match engine.last_applied.take() {
            // Setup's initial view is both the produced and the applied
            // engine baseline: keep one serialized copy for the two.
            Some(applied)
                if self
                    .produced_view
                    .as_ref()
                    .is_some_and(|produced| produced.identity == view_identity(&applied))
                    && self
                        .applied_view
                        .as_ref()
                        .is_none_or(|held| held.identity != view_identity(&applied)) =>
            {
                self.applied_view = self.produced_view.clone();
            }
            applied => adopt(&mut self.applied_view, applied, &self.published_engine)?,
        }
        self.engine = engine;
        Ok(())
    }

    /// Drop held entries after `through`, or all of them for `None`, with
    /// their tag addresses; the next save deletes the stored rows.
    fn truncate_entries(&mut self, through: Option<u64>) {
        self.cut_signature = None;
        self.logical_prefix = None;
        self.mid_index
            .retain(|_, ordinal| through.is_some_and(|end| *ordinal <= end));
        self.reminder_echoes.truncate(through);
        match through {
            Some(through) => {
                self.journal.forget_tags_of.extend(
                    self.entries
                        .range((
                            std::ops::Bound::Excluded(through),
                            std::ops::Bound::Unbounded,
                        ))
                        .map(|(_, entry)| entry.mid.clone()),
                );
                self.entries.retain(|ordinal, _| *ordinal <= through);
                self.tag_index
                    .retain(|_, address| address.ordinal <= through);
            }
            None => {
                self.entries.clear();
                self.tag_index.clear();
            }
        }
        // A cut is rare (a fork descent or a resync): the next notice folds
        // the remaining entries again from the first, on top of what a cut
        // seed stands for.
        self.aggregates = self.base_aggregates();
        self.entry_bytes = (None, 0);
        let journal = &mut self.journal;
        journal.truncate = Some(match (journal.truncate, through) {
            (Some(None), _) | (_, None) => None,
            (Some(Some(held)), Some(through)) => Some(held.min(through)),
            (None, Some(through)) => Some(through),
        });
        let cut = |held: Option<u64>| through.and_then(|through| held.map(|n| n.min(through)));
        journal.persisted_through = cut(journal.persisted_through);
        journal.indexed_through = cut(journal.indexed_through);
    }

    /// Decode, once each, the held entries not yet folded into the running
    /// totals, plus any entries a todo scan still needs (all of them when the
    /// scan restarts for a new lineage). Returns the decoded entries in
    /// ordinal order: exactly those after the earlier of the two cursors.
    fn fold_entries(
        &mut self,
        codec: codec::Codec,
        todo_through: Option<Option<u64>>,
    ) -> Result<Vec<ck_wire::CkIngressMessage>, HandlerOutcome> {
        // The facts cover the held entries contiguously from the first one,
        // through `aggregates.through`.
        let folded = self.aggregates.through;
        let from = match todo_through {
            Some(todo) => match (folded, todo) {
                (Some(folded), Some(todo)) => Some(folded.min(todo)),
                _ => None,
            },
            None => folded,
        };
        let range = from.map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        let mut decoded = Vec::new();
        for (ordinal, entry) in self.entries.range((range, std::ops::Bound::Unbounded)) {
            let mut message = decoded_entry(codec, &entry.inbound()?)?;
            self.reminder_echoes.annotate(&mut message);
            if folded.is_none_or(|folded| *ordinal > folded) {
                let tool_results = message
                    .ck
                    .content
                    .iter()
                    .filter(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
                    .count() as u64;
                let facts = resident::EntryFacts {
                    real_user: self.reminder_echoes.authored(&message),
                    tool_results,
                };
                self.aggregates.add(*ordinal, &entry.mid, facts, &message);
            }
            decoded.push(message);
        }
        Ok(decoded)
    }

    /// Bytes this record keeps alive while resident. Entries are counted
    /// from where the last count stopped; tag addresses are estimated per tag.
    fn retained_bytes(&mut self) -> usize {
        let (through, mut entries) = self.entry_bytes;
        let from = match through {
            Some(through) if self.entries.contains_key(&through) => {
                std::ops::Bound::Excluded(through)
            }
            _ => {
                entries = 0;
                std::ops::Bound::Unbounded
            }
        };
        entries += self
            .entries
            .range((from, std::ops::Bound::Unbounded))
            .map(|(_, entry)| entry.retained_bytes())
            .sum::<usize>();
        self.entry_bytes = (self.entries.last_key_value().map(|(n, _)| *n), entries);
        let mut views = Vec::new();
        let mut bytes = std::mem::size_of::<Self>();
        // Reminder provenance is durable JSON as well as live structs.
        bytes += self.reminder_echoes.retained_bytes() * 2;
        bytes += self.frozen_edits.retained_bytes;
        bytes += self
            .retired_frozen
            .views
            .values()
            .map(|edits| edits.retained_bytes + 96)
            .sum::<usize>();
        bytes += self
            .reminder_cadence
            .as_ref()
            .map_or(0, |cadence| cadence.ledger.retained_bytes() * 2);
        for view in self
            .published_engine
            .values()
            .chain(&self.produced_view)
            .chain(&self.applied_view)
        {
            if !views.iter().any(|seen| Arc::ptr_eq(seen, &view.json)) {
                bytes += view.json.len() + 64;
                bytes += view
                    .frozen_edits
                    .as_ref()
                    .map_or(0, |edits| edits.retained_bytes);
                views.push(Arc::clone(&view.json));
            }
        }
        // A tag address: map node, tag, mid, part key and a 64-byte digest.
        const TAG_ADDRESS: usize = 288;
        let cache_state = self.cache_state.as_ref().map_or(0, |cached| cached.bytes);
        bytes
            + entries
            + self.tag_index.len() * TAG_ADDRESS
            + self.mid_index.len() * 96
            + cache_state
            + self
                .logical_prefix
                .as_ref()
                .map_or(0, |prefix| prefix.retained_bytes())
            + self
                .journal
                .saved_json
                .as_ref()
                .map_or(0, |json| json.len())
            + self.aggregates.historian_input.retained_bytes()
            + self
                .cut_seed
                .as_ref()
                .map_or(0, |seed| seed.retained_bytes())
            + self
                .reminder_hint_state
                .as_ref()
                .map_or(0, |cached| cached.bytes)
    }

    fn capture_frozen_version(
        &mut self,
        store: &McStore,
        version: u64,
    ) -> Result<(), HandlerOutcome> {
        if let Some(edits) = self.frozen_version_sources(store, version)? {
            self.frozen_edits.merge(&edits);
        }
        Ok(())
    }

    fn frozen_version_sources(
        &self,
        store: &McStore,
        version: u64,
    ) -> Result<Option<Arc<frozen_edits::FrozenEdits>>, HandlerOutcome> {
        if let Some(edits) = self
            .published_engine
            .get(&version)
            .and_then(|view| view.frozen_edits.as_ref())
            .or_else(|| self.retired_frozen.views.get(&version))
        {
            return Ok(Some(Arc::clone(edits)));
        } else if let Some(raw) = store
            .load_async_compaction_view(&self.reference(), version)
            .map_err(transient)?
        {
            // Legacy views have no publication provenance. Only held rows from
            // that same lineage can supply their original source identities.
            let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
            if Some(&view.lineage_id) == self.lineage.as_ref() {
                let mut edits = frozen_edits::FrozenEdits::default();
                edits.capture(&view, &self.entries)?;
                return Ok(Some(Arc::new(edits)));
            }
        }
        Ok(None)
    }

    fn remember_frozen_version(
        &mut self,
        store: &McStore,
        version: u64,
    ) -> Result<(), HandlerOutcome> {
        if !self.retired_frozen.views.contains_key(&version) {
            if let Some(edits) = self.frozen_version_sources(store, version)? {
                // This is publication evidence, not an accepted acknowledgement.
                // Cache it through reset/partial reads. resolve_native_acks checks
                // publication ownership and stored ancestry after paging completes.
                self.retired_frozen.views.insert(version, edits);
                self.retired_frozen.dirty = true;
            }
        }
        Ok(())
    }

    fn remember_notice_native_ack(
        &mut self,
        store: &McStore,
        notice: &notice::AdvanceNotice,
    ) -> Result<(), HandlerOutcome> {
        if let Some(version) = notice.applied_view_version.filter(|version| {
            self.native_setup_predecessor.is_some()
                && !notice.events.iter().any(|event| {
                    matches!(event,
                    notice::Event::ViewDeferred { view_version, .. }
                    | notice::Event::ViewRefused { view_version, .. } if view_version == version)
                })
        }) {
            let owner = self.applied_lineage(store, version)?;
            let predecessor = owner
                .as_deref()
                .is_some_and(|owner| self.is_native_setup_predecessor(owner));
            let current = self.lineage.is_some() && owner == self.lineage;
            if let Some(prior) = self
                .native_setup_predecessor
                .as_mut()
                .filter(|prior| (predecessor || current) && notice.seq >= prior.ack_seq)
            {
                prior.ack_seq = notice.seq;
                prior.ack_version = predecessor.then_some(version);
            }
        }
        if let Some(version) = notice.applied_view_version.filter(|version| {
            self.frozen_edits_version != Some(*version)
                && !notice.events.iter().any(|event| {
                    matches!(event,
                    notice::Event::ViewDeferred { view_version, .. }
                    | notice::Event::ViewRefused { view_version, .. } if view_version == version)
                })
        }) {
            self.remember_frozen_version(store, version)?;
            if self.retired_frozen.views.contains_key(&version) {
                if let Some(owner) = self.applied_lineage(store, version)? {
                    self.pending_native_acks.entry(version).or_insert(owner);
                }
            }
        }
        Ok(())
    }

    fn is_native_setup_predecessor(&self, owner: &str) -> bool {
        self.native_setup_predecessor.as_ref().is_some_and(|prior| {
            prior.lineage == owner && self.lineage.as_deref() == Some(prior.replaced_by.as_str())
        })
    }

    fn resolve_native_acks(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(current) = &self.lineage else {
            return Ok(());
        };
        let mut resolved = Vec::new();
        for (version, owner) in &self.pending_native_acks {
            if owner == current || self.recorded_ack_ancestor(store, owner)? {
                let edits = self
                    .frozen_version_sources(store, *version)?
                    .ok_or_else(|| transient("native acknowledgement provenance missing"))?;
                // These are acknowledged source facts, including temporarily
                // absent parts. Replay checks the current identity and digest;
                // no ancestor view, summary or pass facts are adopted here.
                self.frozen_edits.merge(&edits);
            } else if !self.is_native_setup_predecessor(owner) {
                log_foreign_ack_once(&self.reference(), *version);
            }
            resolved.push(*version);
        }
        for version in resolved {
            self.pending_native_acks.remove(&version);
        }
        if let Some(version) = self
            .native_setup_predecessor
            .as_ref()
            .filter(|prior| self.is_native_setup_predecessor(&prior.lineage))
            .and_then(|prior| prior.ack_version)
        {
            // Contract §§5.1–5.2 makes applied_view_version a durable ACK:
            // the next view is built against what the runner renders now.
            // Remember only that public version when its sources are absent;
            // no native fact transfers until an exact source is present. A
            // later notice need not repeat the ACK when those sources return.
            // Only the directly replaced lineage qualifies; its summaries,
            // coverage, baselines and pass facts remain forbidden.
            let matched = self
                .frozen_version_sources(store, version)?
                .map(|edits| edits.matching_sources(&self.mid_index, &self.entries))
                .transpose()?
                .unwrap_or_default();
            if matched.retained_bytes == 0 {
                log_foreign_ack_once(&self.reference(), version);
            }
            self.frozen_edits.merge(&matched);
        }
        Ok(())
    }

    fn reset(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        self.capture_resync_sources(store)?;
        self.finish_reset(store)
    }

    fn capture_resync_sources(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        if self.resync_sources.is_none() {
            let namespace = self.namespace();
            // A resync is rare; it reads every held message once for its digest.
            let digests = self
                .entries
                .iter()
                .map(|(ordinal, entry)| Ok((*ordinal, served_digest(&entry.read()?)?)))
                .collect::<Result<BTreeMap<u64, String>, HandlerOutcome>>()?;
            let source = |ordinal: &u64, entry: &Arc<HeldEntry>| SourceMessage {
                mid: entry.mid.clone(),
                digest: digests[ordinal].clone(),
            };
            store
                .resume_pending_context_write(&namespace)
                .map_err(transient)?;
            let history = store
                .load_compartments(&namespace)
                .map_err(transient)?
                .into_iter()
                .map(|compartment| {
                    let start = (compartment.start_message.max(0) as u64).max(
                        self.entries
                            .first_key_value()
                            .map_or(0, |(ordinal, _)| *ordinal),
                    );
                    let end = compartment.end_message.max(0) as u64;
                    let messages = if start <= end && self.entries.contains_key(&end) {
                        self.entries
                            .range(start..=end)
                            .map(|(ordinal, entry)| source(ordinal, entry))
                            .collect()
                    } else {
                        Vec::new()
                    };
                    HistorySource {
                        compartment,
                        messages,
                    }
                })
                .collect();
            let codec = codec::Codec::from_params(&Value::Object(self.setup.params.clone()))?;
            let rows = tag_rows(self, codec)?;
            let queued = store
                .load_pending_agent_drops(&namespace)
                .map_err(transient)?;
            let drops = queued
                .iter()
                .filter_map(|drop| {
                    let row = rows.iter().find(|row| row.block_id == drop.target_id)?;
                    let tag = tags::format_tag(u64::try_from(row.tag_number).ok()?)?;
                    let address = self.tag_index.get(&tag)?;
                    Some(DropSource {
                        mid: address.mid.clone(),
                        part: address.part.clone(),
                        digest: address.digest.clone(),
                        queued_at_ms: drop.queued_at_ms,
                    })
                })
                .collect();
            let applied = self
                .applied
                .map(|version| {
                    store
                        .load_async_compaction_view(&self.reference(), version)
                        .map_err(transient)
                })
                .transpose()?
                .flatten()
                .map(|raw| serde_json::from_str::<view::CompactionView>(&raw).map_err(transient))
                .transpose()?;
            if let Some(version) = self.applied {
                self.capture_frozen_version(store, version)?;
            }
            // A restart-point cut may split one history head into several
            // leading replacements. The history head's source proof covers the whole
            // replaced span, not only the first range fragment.
            let head = applied.and_then(|view| {
                let view::ViewRange::Replace { from, .. } = view.ranges.first()? else {
                    return None;
                };
                if *from != self.lineage_first_ordinal {
                    return None;
                }
                let leading = view
                    .ranges
                    .iter()
                    .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
                    .collect::<Vec<_>>();
                let to = leading.last()?.to();
                if to > *from && !self.entries.contains_key(&(to - 1)) {
                    return None;
                }
                let mut messages = Vec::<Value>::new();
                for range in leading {
                    if let view::ViewRange::Replace { bytes, .. } = range {
                        messages.extend(serde_json::from_str::<Vec<Value>>(bytes).ok()?);
                    }
                }
                Some(HistoryHeadSource {
                    bytes: serde_json::to_string(&messages).ok()?,
                    messages: self
                        .entries
                        .range(..to)
                        .map(|(ordinal, entry)| source(ordinal, entry))
                        .collect(),
                    required_cut: self.cut_seed.as_ref().map(|seed| {
                        (
                            seed.first_ordinal,
                            seed.cut_mid.clone(),
                            seed.cut_digest.clone(),
                        )
                    }),
                })
            });
            self.resync_sources = Some(ResyncSources {
                namespace,
                lineage: self.lineage.clone(),
                from_start: self.lineage_first_ordinal == 0
                    && self
                        .entries
                        .first_key_value()
                        .is_some_and(|(ordinal, _)| *ordinal == 0),
                history,
                drops,
                queued_count: queued.len(),
                head,
                messages: self
                    .entries
                    .iter()
                    .map(|(ordinal, entry)| source(ordinal, entry))
                    .collect(),
            });
        }
        Ok(())
    }

    fn finish_reset(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        self.resync = true;
        self.partial_read_seq = None;
        // The held entries an offline proof described are gone with the reset.
        self.offline_first_pass = None;
        // A runner that lost its state continues under a new lineage
        // (contract §5.3), which reaches here as a resync: the conversation
        // starts over, so an earlier protocol failure no longer applies.
        self.failure = None;
        self.restored_no_new_content = false;
        self.restored_head = None;
        // A rebuilt window no longer proves that a parent's later summaries
        // describe this lineage. Recover its certified cut history instead.
        self.pending_parent_history = None;
        self.truncate_entries(None);
        self.todo_scan = None;
        self.lineage = None;
        self.generation = self.next_generation()?;
        self.engine = transform::compaction::State::new(self.reference(), self.engine.preset);
        self.produced_view = None;
        self.applied_view = None;
        for (version, view) in &self.published_engine {
            if let Some(edits) = &view.frozen_edits {
                self.retired_frozen
                    .views
                    .insert(*version, Arc::clone(edits));
                self.retired_frozen.dirty = true;
            }
        }
        self.published_engine.clear();
        self.journal.clear_published = true;
        self.save(store, &[])?;
        store
            .retire_unannounced_async_views(&self.reference())
            .map_err(transient)?;
        Ok(())
    }
}

/// A `ready` Setup answer carrying a moved session's Setup checkpoint
/// (compaction-provider §4): on every answer for that session, unchanged, and
/// on none for a session that was never moved. Records stored before the
/// checkpoint had its own member kept it as two top-level members; those are
/// not part of the published answer and are dropped.
fn with_checkpoint(answer: Value, checkpoint: Option<contract::setup::SetupCheckpoint>) -> Value {
    let decoded: compact::setup::SetupAnswer =
        serde_json::from_value(answer.clone()).expect("stored Setup answer decodes");
    let mut built = compact::setup::SetupAnswer::ready(
        decoded.request_id(),
        decoded.initial().expect("ready answer").clone(),
    );
    if let Some(ceiling) = decoded.ceiling() {
        built = built.with_ceiling(ceiling.clone());
    }
    if let Some(ttl) = decoded.cache_ttl() {
        built = built.with_cache_ttl(ttl.clone());
    }
    if let Some(wait) = decoded.ride_wait_ms() {
        built = built.with_ride_wait_ms(wait);
    }
    if let Some(checkpoint) = checkpoint {
        built = built.with_checkpoint(checkpoint);
    }
    let mut result = serde_json::to_value(built).expect("Setup answer serializes");
    if let Some(profile) = answer.get("serializer_profile") {
        result["serializer_profile"] = profile.clone();
    }
    result
}

/// Load a conversation with its held transcript, tag index and engine
/// baselines: everything a notice, ride or save needs.
fn load(store: &McStore, reference: &str) -> Result<Option<State>, HandlerOutcome> {
    #[cfg(test)]
    let _timer = scaling_tests::save_meter::start_kind(reference, "load");
    let Some(rows) = store
        .load_async_compaction_rows(reference)
        .map_err(transient)?
    else {
        return Ok(None);
    };
    let mut state: State = serde_json::from_str(&rows.state).map_err(transient)?;
    for (ordinal, entry, index) in rows.entries {
        let entry = HeldEntry::from_stored(entry)?;
        #[cfg(test)]
        let entry = entry.counted_as(reference.to_owned());
        state.mid_index.entry(entry.mid.clone()).or_insert(ordinal);
        let index: Vec<[String; 3]> = serde_json::from_str(&index).map_err(transient)?;
        for [tag, part, digest] in index {
            state.tag_index.insert(
                tag,
                PartAddress {
                    ordinal,
                    mid: entry.mid.clone(),
                    part,
                    digest,
                },
            );
        }
        state.entries.insert(ordinal, Arc::new(entry));
    }
    for (version, engine) in rows.engine_views {
        state
            .published_engine
            .insert(version, EngineView::parse(engine)?);
    }
    let mut stored = rows
        .baselines
        .into_iter()
        .collect::<BTreeMap<String, String>>();
    let mut resolve = |slot: &str, baseline: Baseline| match baseline {
        Baseline::Absent => Ok(None),
        Baseline::Published(version) => state
            .published_engine
            .get(&version)
            .cloned()
            .map(Some)
            .ok_or_else(|| transient("async engine baseline view missing")),
        Baseline::Stored => stored
            .remove(slot)
            .map(EngineView::parse)
            .transpose()?
            .map(Some)
            .ok_or_else(|| transient("async engine baseline row missing")),
    };
    let produced = resolve("produced", state.engine_baselines.produced)?;
    let applied = resolve("applied", state.engine_baselines.applied)?;
    if let Some(json) = stored.remove("frozen_edits") {
        state.frozen_edits = frozen_edits::FrozenEdits::from_json(&json)?;
    }
    if let Some(json) = stored.remove("retired_native_edits") {
        state.retired_frozen = frozen_edits::RetiredViews::from_json(&json)?;
    }
    if let Some(first) = state.cut_first_ordinal {
        let json = store
            .load_async_compaction_baseline(&state.reference(), &cut_seed::CutSeed::slot(first))
            .map_err(transient)?
            .ok_or_else(|| transient("async cut seed row missing"))?;
        state.cut_seed = Some(Arc::new(serde_json::from_str(&json).map_err(transient)?));
        state.aggregates = state.base_aggregates();
    }
    state.produced_view = produced;
    state.applied_view = applied;
    if let Some(prefix) = &state.logical_prefix {
        state.entries.proof_before(prefix.tail_from);
    }
    let through = state.entries.last_key_value().map(|(n, _)| *n);
    state.journal = Journal {
        complete: true,
        persisted_through: through,
        indexed_through: through,
        truncate: None,
        truncate_below: None,
        cut_seed_dirty: false,
        clear_published: false,
        forget_tags_of: Vec::new(),
        produced: state
            .produced_view
            .as_ref()
            .map(|view| view.identity.clone()),
        applied: state
            .applied_view
            .as_ref()
            .map(|view| view.identity.clone()),
        saved_json: Some(rows.state),
    };
    Ok(Some(state))
}

/// Load only the small record, for checks that never save: ownership,
/// resync and lineage. Saving the result is refused.
fn load_head(store: &McStore, reference: &str) -> Result<Option<State>, HandlerOutcome> {
    store
        .load_async_compaction(reference)
        .map_err(transient)?
        .map(|raw| serde_json::from_str(&raw).map_err(transient))
        .transpose()
}

/// Check a view before it is published. A malformed view is an error. A view
/// that separates a tool call from its result in the runner's format yields
/// the inner `Err`, describing each separated arc, and the caller withholds
/// it: a runner would refuse it as `tool_pair_split`, and a model provider
/// would reject the history.
fn checked_async_view(
    view: view::CompactionView,
    codec: codec::Codec,
    kept: &tool_arcs::KeptMessages,
) -> Result<Result<view::CompactionView, Vec<String>>, HandlerOutcome> {
    view.check().map_err(|error| {
        #[cfg(test)]
        if std::env::var_os("MC_CUT_DIFF_DETAIL").is_some() {
            eprintln!(
                "VIEW CHECK {} cut={:?} through={:?} ranges={:?}",
                error.name(),
                view.cut,
                view.covers_through,
                view.ranges
                    .iter()
                    .map(|range| (range.from(), range.to()))
                    .collect::<Vec<_>>()
            );
        }
        transient(error.name())
    })?;
    let splits = tool_arcs::split_pairs(codec, kept, &view.ranges);
    if !splits.is_empty() {
        return Ok(Err(splits));
    }
    Ok(Ok(view))
}

struct OverflowFact {
    reported_limit_tokens: Option<u64>,
}

fn ride_overflow(request: &ride::RideRequest) -> Option<OverflowFact> {
    request.ceiling_overflow().map(|overflow| OverflowFact {
        reported_limit_tokens: overflow.reported_limit_tokens,
    })
}

fn apply_ride_overflow(state: &mut State, fact: OverflowFact) {
    let policy = state.usage_policy.get_or_insert_with(Default::default);
    let model = state
        .conditions
        .as_ref()
        .and_then(|headers| headers.get("model"))
        .unwrap_or(&state.setup.model)
        .clone();
    policy.model = Some(model.clone());
    if let Some(tokens) = fact.reported_limit_tokens.filter(|tokens| *tokens > 0) {
        policy.learned_limit = Some(super::usage_policy::LearnedLimit {
            tokens,
            model,
            provenance: Some(crate::scheduler::ContextLimitProvenance::Unknown),
        });
    }
    if state.engine.preset == transform::compaction::Preset::Head {
        policy.emergency_recovery_armed = true;
    }
}

impl McHandler {
    /// Attach only to the durable provisioned by ck-bus. No local consumer or
    /// unauthenticated NATS fallback is created when bootstrap is unavailable.
    pub async fn start_compaction_bus<S: Stream + 'static>(
        self: Arc<Self>,
        stream: Arc<S>,
        account: String,
    ) -> Result<tokio::task::JoinHandle<()>, String> {
        let names =
            cortexkit_bus_naming::AccountNames::derive(&account).map_err(|e| e.to_string())?;
        let _ = names;
        let mut cursor = stream
            .consumer(DurableOwner::Module(DEFAULT_MODULE_ID))
            .await
            .map_err(|e| e.to_string())?;
        *self
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .expect("async publisher") = Some(Arc::new(Bus {
            stream,
            account: account.clone(),
        }));
        Ok(tokio::spawn(async move {
            loop {
                if let Err(error) = self.announce_async_views().await {
                    tracing::warn!(?error, "async compaction announcement retry");
                }
                let delivery = match cursor.next().await {
                    Ok(Some(delivery)) => delivery,
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!(%error,"async compaction bus read failed");
                        break;
                    }
                };
                let result = self.advance_compaction(&account, &delivery.message).await;
                #[cfg(test)]
                if result.is_ok() {
                    let seq = delivery
                        .message
                        .headers
                        .get("seq")
                        .and_then(|seq| seq.parse().ok())
                        .unwrap_or(0);
                    self.provider_store
                        .async_runtime
                        .completed_notice
                        .fetch_max(seq, std::sync::atomic::Ordering::Relaxed);
                }
                let settled = match result {
                    Ok(()) => cursor.ack().await,
                    Err(ref error) if waiting_for_tool_result(error) => {
                        // llm-runner §11.1 and compaction-provider §5 require a
                        // durable advance notice after each committed write,
                        // including a tool result. Acknowledge this delivery
                        // while waiting for that result instead of polling.
                        // If its notice is lost, a later notice re-reads the
                        // pending tool call and result.
                        cursor.ack().await
                    }
                    Err(HandlerOutcome::ErrorWithDetail { ref code, .. })
                        if code == "invalid_params" =>
                    {
                        cursor.term(Some("malformed_compaction_notice")).await
                    }
                    Err(error) => {
                        tracing::warn!(?error, "async compaction ingest retry");
                        cursor.nak(Duration::from_secs(1)).await
                    }
                };
                if let Err(error) = settled {
                    tracing::warn!(%error,"async compaction acknowledgement failed");
                    break;
                }
            }
            self.provider_store
                .async_runtime
                .publisher
                .lock()
                .expect("async publisher")
                .take();
        }))
    }

    pub(super) async fn async_setup(
        &self,
        channel: u16,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        // Setup can hold both the old and new lineage records during recovery.
        // Keep that future off the caller's stack, including on small runtimes.
        Box::pin(self.async_setup_inner(channel, binding, params)).await
    }

    async fn async_setup_inner(
        &self,
        channel: u16,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: compact::setup::SetupRequest = decode(params)?;
        let bound_session = binding.session.as_str();
        // The session handle is an opaque caller-chosen string (compaction-provider
        // contract §1 and §4): compare, key and bind it as exact bytes, never trimmed, so
        // the conversation key, its runner route and its reverse-call identity all
        // name the one session the runner reported.
        if !bound_session.is_empty() && bound_session != request.session {
            return Err(HandlerOutcome::ErrorWithDetail {
                code: "setup_identity_mismatch".into(),
                message: "Setup session does not match the bound route session".into(),
                detail: json!({
                    "route_identity": {
                        "project_root": binding.project_root,
                        "harness": binding.harness,
                        "session": binding.session,
                    },
                    "setup_identity": {
                        "project_root": binding.project_root,
                        "harness": request.harness,
                        "session": request.session,
                    },
                }),
            });
        }
        let mut key = Key::new(binding, &request.session, &request.harness)?;
        key.session.clone_from(&request.session);
        let _serial = self.provider_serial.lock_for(&key).await;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let runtime = &self.provider_store.async_runtime;
        let publisher_ready = || runtime.publisher.lock().expect("async publisher").is_some();
        if !publisher_ready() {
            runtime.bus_link.wait_for_attach(ASYNC_BUS_SETUP_WAIT).await;
        }
        if !publisher_ready() {
            self.provider_store
                .async_runtime
                .unconfigured_logged
                .get_or_init(|| tracing::warn!("async compaction bus not configured"));
            let reason = format!(
                "Async compaction bus not ready ({})",
                self.provider_store.async_runtime.bus_link.describe()
            );
            return bytes(
                &compact::setup::SetupAnswer::refuse(
                    &request.request_id,
                    compact::errors::RefuseCode::from_code("provider_busy"),
                    reason,
                )
                .with_provider_code("bus_not_ready"),
            );
        }
        // Checked before an existing record is answered: a session the standalone
        // plugin still owns must never be served, whatever ck-mc holds for it.
        let standalone_move = match moved_session::setup_fence(
            store,
            &request.harness,
            &request.session,
            &request.request_id,
        )? {
            moved_session::Fence::Fresh => None,
            moved_session::Fence::Moved(record) => Some(record),
            moved_session::Fence::Refuse(answer) => return bytes(&answer),
        };
        let reference = key.reference();
        let existing = load_head(store, &reference)?;
        let unsafe_existing = existing
            .as_ref()
            .map(|state| state.active_seed_is_unsafe(store))
            .transpose()?
            .unwrap_or(false);
        if request.descends_from.is_some() {
            return self
                .setup_cut_descent(binding, &request, existing, store)
                .await;
        }
        if let Some(old) = existing
            .as_ref()
            .filter(|old| old.lineage != request.lineage_id || unsafe_existing)
        {
            self.authorize_async(binding, old)?;
            let generation = old.next_generation()?;
            let history = store
                .load_compartments(&old.namespace())
                .map_err(transient)?;
            let mut state =
                self.new_async_record(channel, binding, &request, key, None, generation)?;
            state.cache_policy = old.cache_policy.clone();
            state.published_cuts = old.published_cuts.clone();
            state.retired_cut_stages = old.retired_cut_stages.clone();
            state.cut_history_gc_pending =
                old.cut_history_gc_pending || old.cut_first_ordinal.is_some();
            state.trim_published_cut_cache();
            store
                .replace_compartments(&state.namespace(), &history)
                .map_err(transient)?;
            self.ensure_lineage_window(&mut state, Duration::from_secs(10))
                .await?;
            if state.cut_seed.is_none() {
                // A lineage starting at zero can undo summarized messages. Keep
                // only history whose original sources survive the next read.
                let mut prior = load(store, &reference)?
                    .ok_or_else(|| transient("async session disappeared"))?;
                prior.capture_resync_sources(store)?;
                state.resync_sources = prior.resync_sources.take();
                state.frozen_edits.merge(&prior.frozen_edits);
                for version in prior.published_engine.keys().copied().collect::<Vec<_>>() {
                    prior.remember_frozen_version(store, version)?;
                }
                state.retired_frozen = prior.retired_frozen;
                state.retired_frozen.dirty = true;
                if !unsafe_existing {
                    state.native_setup_predecessor = prior
                        .lineage
                        .zip(request.lineage_id.clone())
                        .map(|(lineage, replaced_by)| SetupNativePredecessor {
                            lineage,
                            replaced_by,
                            ack_seq: 0,
                            ack_version: None,
                        });
                }
                for archive in store.load_async_undo_edits(&reference).map_err(transient)? {
                    state
                        .frozen_edits
                        .merge(&frozen_edits::FrozenEdits::from_json(&archive)?);
                }
                store
                    .replace_compartments(&state.namespace(), &[])
                    .map_err(transient)?;
            }
            state.journal.truncate = Some(None);
            state.save(store, &[])?;
            self.provider_store
                .async_runtime
                .resident
                .lock()
                .expect("async resident cache")
                .forget(&reference);
            return bytes(&state.initial);
        }
        // A record the offline first pass prepared is kept only for the exact
        // Setup it was prepared under; any other Setup discards it and sets the
        // conversation up fresh in the next generation.
        let mut discarded = existing.as_ref().and_then(|state| {
            offline_first_pass::setup_mismatch(state, binding, &request)
                .map(|reason| (state.generation, reason))
        });
        // It is also kept only for the runner `role.describe` it was prepared
        // against. The answer read here serves the moved session's checkpoint
        // check below as well, so this Setup asks the runner once.
        let mut live_describe = None;
        if let Some(state) = existing
            .as_ref()
            .filter(|state| discarded.is_none() && state.offline_first_pass.is_some())
        {
            let describe = self
                .runner_describe(&state.runner()?, &state.runner_identity())
                .await?;
            discarded = offline_first_pass::describe_mismatch(state, &describe)
                .map(|reason| (state.generation, reason));
            live_describe = Some(describe);
        }
        // A record discarded for a fresh generation keeps the floor it stored.
        let stored_floor = existing
            .as_ref()
            .and_then(|state| state.full_array_floor.clone());
        if let Some(state) = existing.filter(|_| discarded.is_none()) {
            self.authorize_async(binding, &state)?;
            let project = self.historian_lane_project(channel, binding, store)?;
            self.record_session_runner_dream_target(
                &project,
                state.project(),
                &state.key.harness,
                state.runner()?,
            );
            if state.setup.params != request.params
                || state.setup.composition != request.composition
                || state.setup.preset != request.preset
            {
                return Err(invalid_field("params", "async setup plan is frozen"));
            }
            let checkpoint = state
                .standalone_move
                .as_ref()
                .map(moved_session::StandaloneMove::checkpoint)
                .or_else(|| {
                    standalone_move.as_ref().map(|record| {
                        contract::setup::SetupCheckpoint::new(record.tag_checkpoint, &record.cut)
                    })
                });
            // A conversation set up with a full-array floor answers the floor
            // it stored; the full-array state is never read again.
            let (checkpoint, why) = match (checkpoint, &state.full_array_floor) {
                (Some(checkpoint), _) => (Some(checkpoint), CheckpointSource::StandaloneMove),
                (None, Some(floor)) => (Some(floor.checkpoint()), CheckpointSource::FullArray),
                (None, None) => (None, CheckpointSource::StandaloneMove),
            };
            if let Some(refusal) = self
                .refuse_checkpoint_unsupported(
                    checkpoint.as_ref(),
                    why,
                    &state.runner()?,
                    &state.runner_identity(),
                    &request.request_id,
                    live_describe,
                )
                .await?
            {
                return bytes(&refusal);
            }
            let mut answer = state.initial;
            answer["request_id"] = json!(request.request_id);
            return bytes(&with_checkpoint(answer, checkpoint));
        }
        let checkpoint = standalone_move.as_ref().map(|record| {
            contract::setup::SetupCheckpoint::new(record.tag_checkpoint, &record.cut)
        });
        // A Claude Code conversation ck-mc served on the full-array route
        // numbers its parts above every number that route allocated for it.
        // Read once, here, and stored with the record.
        let full_array_floor = match (&checkpoint, stored_floor) {
            (Some(_), _) => None,
            (None, Some(floor)) => Some(floor),
            (None, None) => match full_array_floor::setup_floor(
                store,
                &request.harness,
                &request.session,
                &request.request_id,
            ) {
                full_array_floor::Floor::None => None,
                full_array_floor::Floor::Carried(floor) => Some(floor),
                full_array_floor::Floor::Refuse(answer) => return bytes(&answer),
            },
        };
        let (checkpoint, why) = match (checkpoint, &full_array_floor) {
            (Some(checkpoint), _) => (Some(checkpoint), CheckpointSource::StandaloneMove),
            (None, Some(floor)) => (Some(floor.checkpoint()), CheckpointSource::FullArray),
            (None, None) => (None, CheckpointSource::StandaloneMove),
        };
        if let Some(checkpoint) = &checkpoint {
            // Refused before anything is stored, so a later Setup from a
            // runner that declares the group sets the session up afresh.
            let route = crate::route_targets::SessionRunnerRoute::for_principal(
                binding.principal.as_ref(),
                &request.session,
            )
            .ok_or_else(|| invalid_field("runner", "unsupported session runner principal"))?;
            let identity = session_resolver::RunnerBindIdentity {
                project_root: binding.project_root.clone(),
                harness: request.harness.clone(),
                session: request.session.clone(),
            };
            if let Some(refusal) = self
                .refuse_checkpoint_unsupported(
                    Some(checkpoint),
                    why,
                    &route,
                    &identity,
                    &request.request_id,
                    live_describe,
                )
                .await?
            {
                return bytes(&refusal);
            }
        }
        let generation = match discarded {
            Some((generation, reason)) => {
                offline_first_pass::log_discard(&reference, reason);
                generation
                    .checked_add(1)
                    .ok_or_else(|| transient("async generation exhausted"))?
            }
            None => 0,
        };
        let mut state =
            self.new_async_record(channel, binding, &request, key, standalone_move, generation)?;
        state.full_array_floor = full_array_floor;
        if discarded.is_some() {
            state.forget_discarded_rows();
        }
        // A conversation set up again under the same reference must never
        // reuse a resident copy of an earlier one.
        self.provider_store
            .async_runtime
            .resident
            .lock()
            .expect("async resident cache")
            .forget(&reference);
        state.save(store, &[])?;
        if discarded.is_some() {
            store
                .retire_unannounced_async_views(&reference)
                .map_err(transient)?;
        }
        bytes(&with_checkpoint(state.initial.clone(), checkpoint))
    }

    /// A new conversation record for `request`, with Setup's engine pass run
    /// and its initial answer built; not yet saved. `generation` is 0 for a
    /// first Setup and the next generation when an offline-prepared record is
    /// discarded, so the fresh record starts in an empty engine namespace.
    fn new_async_record(
        &self,
        channel: u16,
        binding: &SessionBinding,
        request: &compact::setup::SetupRequest,
        key: Key,
        standalone_move: Option<crate::offline_move::MoveRecord>,
        generation: u64,
    ) -> Result<State, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let reference = key.reference();
        let runner_module = key.runner.clone();
        let codec = codec::Codec::from_params(&Value::Object(request.params.clone()))?;
        let chosen = preset(request.preset.as_deref())?;
        let mut engine = transform::compaction::State::new(reference.clone(), chosen);
        let mut state = State {
            commands: Default::default(),
            historian_cadence: None,
            historian_pending: false,
            restored_no_new_content: false,
            resync_sources: None,
            restored_head: None,
            standalone_move: standalone_move.map(moved_session::StandaloneMove::from_record),
            full_array_floor: None,
            read_outcome: None,
            partial_read_seq: None,
            failure: None,
            engine_failed: false,
            last_discarded_drops: 0,
            last_transferred_drops: 0,
            tag_index: BTreeMap::new(),
            engine_baselines: EngineBaselines::default(),
            logical_prefix: None,
            prefix_input_proof: None,
            journal: Journal::new_record(),
            usage_policy: None,
            todo_scan: None,
            runner_route: None,
            dream_target: None,
            reminder_cadence: None,
            reminder_hint_state: None,
            reminder_echoes: Default::default(),
            frozen_edits: Default::default(),
            frozen_edits_version: None,
            retired_frozen: Default::default(),
            reminder_baseline_generation: None,
            key,
            runner_identity: session_resolver::RunnerBindIdentity {
                project_root: binding.project_root.clone(),
                harness: request.harness.clone(),
                session: request.session.clone(),
            },
            runner_module,
            setup: request.clone(),
            initial: Value::Null,
            cache_policy: contract_policy::CachePolicy::freeze(
                &self.effective_config(&binding.project_root),
            ),
            engine: engine.clone(),
            published_engine: BTreeMap::new(),
            produced_view: None,
            applied_view: None,
            lineage: request.lineage_id.clone(),
            ack_lineage_root: request.lineage_id.clone(),
            ack_selection_pending: request.lineage_id.is_none(),
            pending_native_acks: BTreeMap::new(),
            native_setup_predecessor: None,
            entries: Default::default(),
            mid_index: BTreeMap::new(),
            aggregates: Default::default(),
            entry_bytes: Default::default(),
            cache_state: None,
            seq: 0,
            completed_seq: 0,
            applied: None,
            acknowledgements: vec![],
            marker_outcomes: BTreeMap::new(),
            conditions: None,
            resync: false,
            generation,
            offline_first_pass: None,
            record_version: cut_seed::RECORD_VERSION,
            cut_first_ordinal: None,
            cut_seed: None,
            lineage_first_ordinal: 0,
            published_cuts: BTreeMap::new(),
            retired_cut_stages: Vec::new(),
            pending_cut_seeds: BTreeMap::new(),
            pending_cut_metadata: BTreeMap::new(),
            retired_cut_baselines: Vec::new(),
            cut_history_gc_pending: false,
            pending_parent_history: None,
            pending_undo_edits: false,
            cut_signature: None,
        };
        let route = state.runner()?;
        state.runner_route =
            Some(json!({"module_id":route.module_id(),"parent_session":route.parent_session()}));
        let project = self.historian_lane_project(channel, binding, store)?;
        state.dream_target = Some(
            json!({"project":project,"directory":state.project(),"harness":state.key.harness,"route":state.runner_route}),
        );
        self.record_session_runner_dream_target(
            &project,
            state.project(),
            &state.key.harness,
            route,
        );
        let status = transform::compaction::Status {
            lineage_id: state.lineage.clone().unwrap_or_default(),
            newest_ordinal: None,
            previous_usage: None,
            request_tokens: 0,
            context_window: request.context_window.ok_or_else(|| {
                invalid_field("context_window", "async setup needs a context window")
            })?,
            prefix_rebuilding: false,
            pipeline_switch: false,
            last_applied_version: None,
            last_not_applied: None,
        };
        let (_template, output) =
            self.async_engine(channel, binding, &state, codec, &status, &mut engine)?;
        let transform::compaction::Answer::Replacement(initial) = &output.answer else {
            return Err(transient("async setup returned no initial view"));
        };
        let wire = rendered_view(
            codec,
            initial,
            &state,
            self.async_input_oracle() || state.logical_prefix.is_none(),
        )?;
        state.adopt_engine(engine)?;
        // `serializer_profile` is a ck-mc extension member: the profile this
        // Setup accepted, so the runner can confirm ck-mc reads its schema.
        let mut answer = compact::setup::SetupAnswer::ready(
            &request.request_id,
            decode(&serde_json::to_value(wire).map_err(transient)?)?,
        )
        .with_ceiling(CeilingPolicy::new(0.95, 300_000).with_on_overflow())
        .with_cache_ttl(state.cache_policy.resolve(&request.model));
        if let Some(cap) = request.ride_wait_max_ms {
            if cap == 0 {
                return Err(invalid_field("ride_wait_max_ms", "must be positive"));
            }
            answer = answer.with_ride_wait_ms(10_000.min(cap));
        }
        state.initial = serde_json::to_value(answer).map_err(transient)?;
        state.initial["serializer_profile"] = json!(codec.wire_id());
        Ok(state)
    }

    /// The session runner's `role.describe` answer.
    async fn runner_describe(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
    ) -> Result<Value, HandlerOutcome> {
        self.provider_runner
            .call_for_identity(
                route,
                identity,
                "role.describe",
                json!({}),
                Duration::from_millis(1_500),
            )
            .await
            .map_err(runner_error)
    }

    /// For a session with a Setup checkpoint (`checkpoint` present: moved from
    /// standalone, or carrying a full-array floor, as `why` says), the terminal
    /// `tag_checkpoint_unsupported` refusal when its runner does not declare
    /// llm-runner's `tag_checkpoint` group, read from the runner's own
    /// `role.describe` (`fetched` when this Setup already read it); `None`
    /// when Setup may answer.
    async fn refuse_checkpoint_unsupported(
        &self,
        checkpoint: Option<&contract::setup::SetupCheckpoint>,
        why: CheckpointSource,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        request_id: &str,
        fetched: Option<Value>,
    ) -> Result<Option<Value>, HandlerOutcome> {
        if checkpoint.is_none() {
            return Ok(None);
        }
        let reply = match fetched {
            Some(reply) => reply,
            None => self.runner_describe(route, identity).await?,
        };
        let describe = cortexkit_role_llm_runner::describe::check_describe(&reply)
            .map_err(|problems| transient(format!("runner role.describe: {problems:?}")))?;
        Ok(
            (!describe.declares(cortexkit_role_llm_runner::capabilities::TAG_CHECKPOINT))
                .then(|| moved_session::tag_checkpoint_refusal(request_id, why)),
        )
    }

    fn async_engine(
        &self,
        channel: u16,
        binding: &SessionBinding,
        state: &State,
        codec: codec::Codec,
        status: &transform::compaction::Status,
        engine: &mut transform::compaction::State,
    ) -> Result<(TransformRequest, transform::compaction::Output), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        if state.active_seed_is_unsafe(store)? {
            return Err(error(
                "unsafe_cut_seed",
                "the stored head requires a fresh full lineage",
            ));
        }
        let model = state
            .conditions
            .as_ref()
            .and_then(|n| n.get("model"))
            .map(String::as_str)
            .unwrap_or(&state.setup.model);
        let mut template: TransformRequest = decode(
            &json!({"v":2,"kind":"compaction.step","session_id":state.namespace(),"messages":[],"render_config":serde_json::to_string(&state.setup.params).map_err(transient)?,"model_key":model,"tool_present":false,"auto_search_enabled":false}),
        )?;
        template.source_lineage_first_ordinal = Some(state.lineage_first_ordinal);
        #[cfg(test)]
        resident::counters::engine_pass();
        // The oracle deliberately never consults prefix selection or its proof.
        let mut prefix = if self.async_input_oracle() {
            None
        } else if let Some(prefix) = &state.logical_prefix {
            let loaded = store
                .load_logical_transform_snapshot(&state.namespace(), &[])
                .map_err(transient)?
                .loaded;
            let compartments = store
                .load_compartments(&state.namespace())
                .map_err(transient)?;
            prefix
                .matches(&status.lineage_id, state.generation, &loaded, &compartments)
                .then_some(())
                .filter(|_| {
                    state
                        .entries
                        .matches(state.prefix_input_proof.as_ref(), prefix.tail_from)
                })
                .filter(|_| state.lineage_from() == prefix.from)
                .filter(|_| {
                    prefix.context_sources.iter().all(|(ordinal, source)| {
                        source.ordinal == *ordinal
                            && (state
                                .entries
                                .get(ordinal)
                                .is_some_and(|entry| entry.mid == source.mid)
                                || state.cut_seed.as_ref().is_some_and(|seed| {
                                    seed.context_sources
                                        .get(ordinal)
                                        .is_some_and(|held| held.mid == source.mid)
                                }))
                    })
                })
                .map(|_| prefix.clone())
        } else {
            None
        };
        #[cfg(test)]
        if std::env::var_os("MC_CUT_TRACE").is_some() && prefix.is_none() {
            if let Some(held) = &state.logical_prefix {
                let loaded = store
                    .load_logical_transform_snapshot(&state.namespace(), &[])
                    .map_err(transient)?
                    .loaded;
                let compartments = store
                    .load_compartments(&state.namespace())
                    .map_err(transient)?;
                eprintln!(
                    "TRACE certificate refused: matches={} proof={} (held {:?} expected {:?}) from={}/{}",
                    held.matches(&status.lineage_id, state.generation, &loaded, &compartments),
                    state.entries.matches(state.prefix_input_proof.as_ref(), held.tail_from),
                    state.entries.proof_before_peek(),
                    state.prefix_input_proof,
                    state.lineage_from(),
                    held.from
                );
            }
        }
        // A conversation that begins at a cut has no rows below it to fall
        // back on: without a matching certificate, its cut seed stands for
        // them.
        let seeded_prefix = |state: &State| -> Result<_, HandlerOutcome> {
            state
                .cut_seed
                .as_ref()
                .map(|seed| {
                    let epoch = store
                        .load_meta(&state.namespace())
                        .map_err(transient)?
                        .meta
                        .revert_epoch;
                    Ok(Arc::new(seed.prefix(
                        &status.lineage_id,
                        state.generation,
                        epoch,
                    )))
                })
                .transpose()
        };
        if prefix.is_none() {
            prefix = seeded_prefix(state)?;
        }
        let mut membership_unavailable = false;
        if let Some(prefix) = &mut prefix {
            let prefix = Arc::make_mut(prefix);
            for pending in store
                .load_pending_agent_drops(&state.namespace())
                .map_err(transient)?
            {
                if let Some((mid, _)) = ck_wire::split_block_id(&pending.target_id) {
                    if let Some(ordinal) =
                        state.mid_index.get(mid).filter(|n| **n < prefix.tail_from)
                    {
                        if let Some(entry) = state.entries.get(ordinal) {
                            if !prefix.prove_membership(&decoded_entry(codec, &entry.inbound()?)?) {
                                membership_unavailable = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if membership_unavailable {
            prefix = seeded_prefix(state)?;
        }
        let messages = if let Some(prefix) = &prefix {
            let mut messages = prefix.context_sources.values().cloned().collect::<Vec<_>>();
            messages.extend(inbound_messages(
                state
                    .entries
                    .range(prefix.tail_from..)
                    .map(|(_, entry)| entry),
            )?);
            messages
        } else {
            inbound_messages(state.entries.values())?
        };
        #[cfg(test)]
        scaling_tests::view_work::engine(&state.reference(), messages.len());
        // Positions count from the lineage's first ordinal, also in a
        // lineage that begins at a cut (Pi derives fallback tool ids from them).
        let source_from = state.lineage_from();
        state.reminder_echoes.prepare_with(
            codec,
            &mut template,
            &messages,
            false,
            |request, entries| codec.prepare_request_from(request, entries, source_from),
        )?;
        template.logical_prefix = prefix;
        template.runner_owned_reminders = true;
        template.native_reminder_strip_pending =
            state.reminder_cadence.as_ref().is_some_and(|cadence| {
                state
                    .reminder_echoes
                    .pending(&cadence.ledger, now_ms().max(0) as u64)
            });
        template.native_tail_section = true;
        #[cfg(test)]
        if self
            .provider_store
            .async_runtime
            .full_input_only
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let expected = state
                .entries
                .iter()
                .map(|(ordinal, entry)| (*ordinal, entry.mid.clone()))
                .collect::<Vec<_>>();
            let actual = template
                .messages
                .iter()
                .map(|message| (message.ordinal, message.mid.clone()))
                .collect::<Vec<_>>();
            assert!(
                expected.is_empty()
                    || (expected[0].0 == 0
                        && expected.windows(2).all(|pair| pair[0].0 + 1 == pair[1].0)),
                "the full-input fixture must retain the original contiguous transcript"
            );
            assert_eq!(
                actual, expected,
                "full-input oracle must project every original source identity in order"
            );
            cut_seed::pass_trace::record(
                Arc::as_ptr(store) as usize,
                format!(
                    "full_input rows={} first={:?} last={:?} identities_digest={}",
                    expected.len(),
                    expected.first(),
                    expected.last(),
                    crate::sha256_hex(&serde_json::to_vec(&actual).unwrap())
                ),
            );
        }
        if let Some(policy) = &state.usage_policy {
            template.emergency_recovery_armed = policy.emergency_recovery_armed;
            if let Some(limit) = policy.limit_for(model) {
                template.detected_context_limit = limit;
                template.detected_context_limit_model_key = Some(model.into());
            }
        }
        let work = self.provider_work(channel, store, binding.clone(), state.key.clone())?;
        let engine_model = template
            .model_key
            .clone()
            .unwrap_or_else(|| state.setup.model.clone());
        let mut context =
            compaction::producer_context(&work, &engine_model, status.context_window, false);
        context.cache_ttl = "never".into();
        // On this lane the runner owns the model provider's companion edit:
        // views never remove the signed reasoning they invalidate.
        let signed = transform::compaction::SignedReasoning::RunnerCompanion;
        let previous_engine = engine.clone();
        #[cfg(test)]
        if self
            .provider_store
            .async_runtime
            .record_notice_decisions
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            cut_seed::pass_trace::record(
                Arc::as_ptr(store) as usize,
                format!(
                    "engine_input rows={} ordinals={:?}",
                    template.messages.len(),
                    template
                        .messages
                        .iter()
                        .map(|message| message.ordinal)
                        .collect::<Vec<_>>()
                ),
            );
        }
        template.declared_trim = template
            .logical_prefix
            .as_ref()
            .and_then(|prefix| prefix.declared_cut_trim());
        let output = if engine.last_applied.is_none() {
            transform::compaction::setup_with(store, &template, &context, status, engine, signed)
        } else {
            transform::compaction::step_with(store, &template, &context, status, engine, signed)
        };
        let output = match output {
            Ok(output) => output,
            Err(_)
                if template
                    .logical_prefix
                    .as_ref()
                    .is_some_and(|prefix| !prefix.is_cut()) =>
            {
                // If a prefix-based pass fails, retry with every held inbound
                // message (behind the cut seed, for a conversation that
                // begins at a cut); do not guess at the omitted source bytes.
                *engine = previous_engine;
                let fallback = seeded_prefix(state)?;
                let mut messages = fallback
                    .as_ref()
                    .map(|prefix| prefix.context_sources.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                messages.extend(inbound_messages(state.entries.values())?);
                #[cfg(test)]
                scaling_tests::view_work::engine(&state.reference(), messages.len());
                state.reminder_echoes.prepare_with(
                    codec,
                    &mut template,
                    &messages,
                    false,
                    |request, entries| codec.prepare_request_from(request, entries, source_from),
                )?;
                template.logical_prefix = fallback;
                template.declared_trim = template
                    .logical_prefix
                    .as_ref()
                    .and_then(|prefix| prefix.declared_cut_trim());
                if engine.last_applied.is_none() {
                    transform::compaction::setup_with(
                        store, &template, &context, status, engine, signed,
                    )
                } else {
                    transform::compaction::step_with(
                        store, &template, &context, status, engine, signed,
                    )
                }
                .map_err(engine_error)?
            }
            Err(error) => return Err(engine_error(error)),
        };
        Ok((template, output))
    }
}

fn parts(message: &Value) -> Result<std::borrow::Cow<'_, [Value]>, HandlerOutcome> {
    // An Anthropic message may carry its content as one string instead of a
    // block array; the runner exposes that string as the message's one part.
    if let Some(text @ Value::String(_)) = message.get("content") {
        if message.get("parts").is_none() {
            return Ok(std::borrow::Cow::Owned(vec![text.clone()]));
        }
    }
    message
        .get("parts")
        .or_else(|| message.get("content"))
        .or_else(|| message.pointer("/message/content"))
        .and_then(Value::as_array)
        .map(|parts| std::borrow::Cow::Borrowed(parts.as_slice()))
        .ok_or_else(|| invalid_field("message", "codec must expose an ordered parts array"))
}

/// Whole runner messages for `entries`, for a pass over the transcript.
fn inbound_messages<'a>(
    entries: impl Iterator<Item = &'a Arc<HeldEntry>>,
) -> Result<Vec<InboundMessage>, HandlerOutcome> {
    entries.map(|entry| entry.inbound()).collect()
}

fn decoded_entry(
    codec: codec::Codec,
    entry: &InboundMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    #[cfg(test)]
    resident::counters::decoded(1);
    let exposed;
    let entry = match crate::descriptors::expose(&entry.message) {
        Some(message) => {
            exposed = InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message,
            };
            &exposed
        }
        None => entry,
    };
    codec
        .decode_entries(std::slice::from_ref(entry))?
        .pop()
        .ok_or_else(|| error("history_unreadable", "runner entry has no model message"))
}

fn rendered_view(
    codec: codec::Codec,
    view: &transform::compaction::View,
    state: &State,
    full_lineage: bool,
) -> Result<OutboundMessage, HandlerOutcome> {
    let entries = if full_lineage {
        inbound_messages(state.entries.values())?
    } else {
        // Only output sources need native sidecars. Synthetic head frames have
        // no source, and covered sources cannot affect tail-native rendering.
        let ordinals = view
            .replacement
            .iter()
            .filter(|m| !m.meta.synthetic)
            .filter_map(|m| m.meta.ordinal)
            .collect::<BTreeSet<_>>();
        inbound_messages(
            ordinals
                .iter()
                .filter_map(|ordinal| state.entries.get(ordinal)),
        )?
    };
    #[cfg(test)]
    scaling_tests::view_work::renderer(&state.reference(), entries.len());
    match codec.render_view(view, &state.key.session, &entries) {
        Ok(output) => Ok(output),
        Err(_) if !full_lineage => {
            tracing::debug!(session_ref=%state.reference(), reason="native_render_context", "rendering with full-lineage sources");
            let entries = inbound_messages(state.entries.values())?;
            #[cfg(test)]
            scaling_tests::view_work::renderer(&state.reference(), entries.len());
            codec.render_view(view, &state.key.session, &entries)
        }
        Err(error) => Err(error),
    }
}

fn compact_prefix_hygiene(
    store: &McStore,
    state: &State,
    prefix: &transform::compaction::LogicalPrefix,
    loaded: &mut mc_store::LoadedState,
) -> Result<(), mc_store::McStoreError> {
    let mut retried = false;
    loop {
        match compact_prefix_hygiene_once(store, state, prefix, loaded) {
            Err(error @ mc_store::McStoreError::CasConflict { .. }) => {
                // Historian decision metadata is written outside the provider
                // lock. Rebase cleanup on that write, never overwrite it or
                // discard a certificate whose coverage is still valid.
                *loaded = store
                    .load_logical_transform_snapshot(&state.namespace(), &[])?
                    .loaded;
                let compartments = store.load_compartments(&state.namespace())?;
                if !prefix.matches(
                    state.lineage.as_deref().unwrap_or_default(),
                    state.generation,
                    loaded,
                    &compartments,
                ) {
                    return Err(error);
                }
                if retried {
                    // Pruning zero-token parts is optional. Bound retries so
                    // metadata churn cannot stall a ride or force a full render.
                    tracing::debug!(session_ref=%state.reference(), reason="prefix_hygiene_contention", "deferring prefix hygiene cleanup");
                    return Ok(());
                }
                retried = true;
            }
            result => return result,
        }
    }
}

fn compact_prefix_hygiene_once(
    store: &McStore,
    state: &State,
    prefix: &transform::compaction::LogicalPrefix,
    loaded: &mut mc_store::LoadedState,
) -> Result<(), mc_store::McStoreError> {
    let Some(baseline) = &mut loaded.meta.tail_hygiene_baseline else {
        return Ok(());
    };
    // Covered excluded parts contribute no token mass. Their source membership
    // is certified by the prefix, so keep only context and uncovered parts,
    // without changing the frozen totals, generation, or reminder cadence.
    baseline.baseline_parts.retain(|part| {
        if part.kind != mc_store::TailHygienePartKind::Excluded
            || part.tokens != 0
            || part.u_tokens != 0
        {
            return true;
        }
        let block = part.key.split('\0').next().unwrap_or(&part.key);
        let Some((mid, _)) = ck_wire::split_block_id(block) else {
            return true;
        };
        state.mid_index.get(mid).is_none_or(|ordinal| {
            *ordinal >= prefix.tail_from || prefix.context_ordinals.contains(ordinal)
        })
    });
    // The version check also validates the certificate's metadata snapshot.
    // Keep it when the baseline is already canonical: concurrent historian
    // metadata may be rebased, but a concurrent revert must invalidate reuse.
    #[cfg(test)]
    scaling_tests::hygiene_interleaving::run(&state.reference());
    store.commit_logical_transform_with_provider_policy(
        &state.namespace(),
        mc_store::TransformCommit {
            expected: loaded.row_version,
            core: &loaded.core,
            meta: &loaded.meta,
            sections: mc_store::SectionsCommit {
                base: loaded.sections.as_ref(),
                meta_only_steps: 0,
                frozen_clear: mc_store::FrozenClear::Explicit,
            },
            consumed_drop_ids: &[],
            first_applied_command_ids: &[],
            memory_revision: None,
            compartment_max_seq: None,
            project_root: None,
            first_divergence: None,
            scheduler_observation: None,
            scheduler_request_observed_at_ms: None,
            scheduler_full_array_fingerprint: None,
            scheduler_eligible_supersession_count: None,
            scheduler_withheld_by_tag_window: None,
            scheduler_withheld_by_exempt_message: None,
            scheduler_applied_supersession_count: None,
            scheduler_applied_reductions: false,
            overlays: mc_store::TransformOverlayBatch::default(),
        },
        None,
    )?;
    Ok(())
}

/// The `ctx_reduce` detail for tags from below the conversation's cut.
fn ctx_reduce_summarized_details(summarized: &[u64]) -> String {
    if summarized.is_empty() {
        return String::new();
    }
    format!(
        "tags {} already in the history summary, nothing to drop",
        format_plain_tag_numbers(summarized)
    )
}

/// The part as the runner renders it to the model under `render_tags`: a
/// numbered part's text gets its `§N§ ` prefix (`tags::render_part`), so a
/// rendered part the engine left alone compares equal to it.
fn render_part(part: &Value, tag: Option<&str>, render: bool) -> Value {
    let mut part = part.clone();
    if !render {
        return part;
    }
    let number = tag.and_then(tags::parse_tag);
    let render_text = |text: &str| tags::render_part(tags::PartKind::ToolResultText, number, text);
    if let Value::String(text) = &part {
        return json!(render_text(text));
    }
    // An Anthropic `tool_result` may carry its output as a plain `content` string.
    let anthropic_result = (part["type"] == "tool_result").then_some("/content");
    for pointer in ["/text", "/state/output", "/state/error", "/output/text"]
        .into_iter()
        .chain(anthropic_result)
    {
        if let Some(value) = part.pointer_mut(pointer).filter(|v| v.is_string()) {
            *value = json!(render_text(value.as_str().unwrap()));
            break;
        }
    }
    part
}

fn stable_entry(left: &ReadMessage, right: &ReadMessage) -> bool {
    left.ordinal == right.ordinal
        && left.mid == right.mid
        && left.message == right.message
        && left.digest == right.digest
        && left.part_digests == right.part_digests
        && left.tags == right.tags
        && left.role == right.role
        && left.written_at == right.written_at
        && left.delivered_as == right.delivered_as
}

fn tag_rows(state: &State, codec: codec::Codec) -> Result<Vec<mc_store::McTagRow>, HandlerOutcome> {
    tag_rows_for(state.entries.values(), codec)
}

/// The runner tag row of `number`, as `tag_rows` would list it, reading only
/// the entry that holds the tag. Every held entry was decoded and checked by
/// `tag_rows_for` when it was first stored, so no other entry can change the
/// answer.
fn tag_row(
    state: &State,
    codec: codec::Codec,
    number: u64,
) -> Result<Option<mc_store::McTagRow>, HandlerOutcome> {
    let Some(address) = tags::format_tag(number).and_then(|tag| state.tag_index.get(&tag)) else {
        return Ok(None);
    };
    let Some(entry) = state.entries.get(&address.ordinal) else {
        return Ok(None);
    };
    Ok(tag_rows_for(std::iter::once(entry), codec)?
        .into_iter()
        .find(|row| u64::try_from(row.tag_number).ok() == Some(number)))
}

/// Tag rows for `entries`. A tag reused within them is refused here; reuse
/// against already held entries is refused by `reindex`.
fn tag_rows_for<'a>(
    entries: impl Iterator<Item = &'a Arc<HeldEntry>>,
    codec: codec::Codec,
) -> Result<Vec<mc_store::McTagRow>, HandlerOutcome> {
    let mut rows = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in entries {
        let entry = entry.read()?;
        let native = parts(&entry.message)?;
        if native.len() != entry.tags.len() {
            return Err(invalid_field(
                "tags",
                "runner must expose one tag row per part",
            ));
        }
        let decoded = decoded_entry(
            codec,
            &InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            },
        )?;
        for (index, block) in decoded.ck.content.iter().enumerate() {
            let native_index = block
                .provider_extras
                .get("_cortexkit_codec")
                .and_then(|e| e.get("nativeIndex"))
                .and_then(Value::as_u64)
                .unwrap_or(index as u64) as usize;
            let Some(row) = entry.tags.get(native_index) else {
                return Err(invalid_field(
                    "tags",
                    "codec part index outside runner tags",
                ));
            };
            let Some(tag) = row.tag.as_deref() else {
                continue;
            };
            let number = tags::parse_tag(tag)
                .ok_or_else(|| invalid_field("tags", "malformed runner tag"))?;
            let (kind, text) = match &block.kind {
                ck_wire::CkKind::Text { text } => {
                    ("message", std::borrow::Cow::Borrowed(text.as_str()))
                }
                ck_wire::CkKind::ToolResult { output, .. } => match &output.kind {
                    ck_wire::CkOutputKind::Text { text }
                    | ck_wire::CkOutputKind::ErrorText { text } => {
                        ("tool_result", std::borrow::Cow::Borrowed(text.as_str()))
                    }
                    // A tool result holding only images is numbered too
                    // (llm-runner §9.6), so `ctx_reduce` can reach a screenshot.
                    ck_wire::CkOutputKind::Json { value }
                    | ck_wire::CkOutputKind::ErrorJson { value } => (
                        "tool_result",
                        std::borrow::Cow::Owned(serde_json::to_string(value).map_err(transient)?),
                    ),
                    _ => continue,
                },
                _ => continue,
            };
            if !seen.insert(number) {
                return Err(invalid_field("tags", "runner reused a tag"));
            }
            rows.push(mc_store::McTagRow {
                tag_number: i64::try_from(number).map_err(invalid)?,
                block_id: format!("{}#{index}", entry.mid),
                kind: kind.into(),
                // A described payload counts as the payload it stands for.
                token_count: crate::descriptors::block_tokens(&block.kind)
                    .unwrap_or_else(|| mc_tokenizer::estimate_tokens(&text))
                    as i64,
                created_at_ms: now_ms(),
                source_bytes: text.as_bytes().into(),
            });
        }
    }
    Ok(rows)
}

/// Build the view's ranges, and collect the transcript messages its keep ranges
/// hold for the tool-arc checks that follow, so those checks parse no message
/// again.
fn ranges(
    state: &State,
    codec: codec::Codec,
    wire: &OutboundMessage,
    engine: &transform::compaction::View,
    history_through: Option<u64>,
) -> Result<(Vec<view::ViewRange>, tool_arcs::KeptMessages), HandlerOutcome> {
    let end = state
        .entries
        .last_key_value()
        .ok_or_else(|| transient("empty async view"))?
        .0
        .checked_add(1)
        .ok_or_else(|| invalid("ordinal exhausted"))?;
    let mut ranges = Vec::new();
    let mut kept = tool_arcs::KeptMessages::new();
    let mut synthetic = Vec::new();
    let mut next = state.lineage_first_ordinal;
    let history_end = history_through
        .map_or(0, |through| through.saturating_add(1))
        .max(
            state
                .entries
                .first_key_value()
                .map_or(0, |(ordinal, _)| *ordinal),
        );
    let render = state
        .setup
        .composition
        .get("render_tags")
        .and_then(Value::as_bool)
        == Some(true);
    // The first held entry with each mid, as an ordinal-order search finds it.
    let mut by_mid = HashMap::new();
    if state.logical_prefix.is_none() {
        // Recovery and the full-lineage oracle use the original source index,
        // independently of the optimized view's ordinal-based source selection.
        for (ordinal, entry) in &state.entries {
            by_mid.entry(entry.mid.as_str()).or_insert(*ordinal);
        }
    } else {
        for ordinal in engine
            .replacement
            .iter()
            .filter(|m| !m.meta.synthetic)
            .filter_map(|m| m.meta.ordinal)
        {
            let Some(entry) = state.entries.get(&ordinal) else {
                continue;
            };
            by_mid.entry(entry.mid.as_str()).or_insert(ordinal);
        }
    }
    for (position, message) in wire.replacement.iter().enumerate() {
        let mid = message
            .pointer("/info/id")
            .or_else(|| message.get("id"))
            .and_then(Value::as_str);
        let original = if let Some(mid) = mid {
            by_mid.get(mid).and_then(|n| state.entries.get(n))
        } else {
            engine
                .replacement
                .get(position)
                .filter(|m| !m.meta.synthetic)
                .and_then(|m| m.meta.ordinal)
                .and_then(|n| state.entries.get(&n))
        };
        let Some(original) = original else {
            // Messages ck-mc authors (a head, a fold of covered messages) are
            // sent as written, so a ref inside one never reaches the model.
            synthetic.push(crate::descriptors::without_refs(message));
            continue;
        };
        let original = original.read()?;
        if original.ordinal < next {
            return Err(transient("async render reordered transcript"));
        }
        if original.ordinal > next || !synthetic.is_empty() {
            append_view_gap(
                state,
                codec,
                &mut ranges,
                &mut kept,
                &mut synthetic,
                &mut next,
                original.ordinal,
                history_end,
            )?;
        }
        let before = parts(&original.message)?;
        let after = parts(message)?;
        // Which runner part each rendered part came from, for schemas whose
        // parts have no ids: a removed part then shifts the rest left, so
        // position alone would pair a kept part with its neighbour's bytes.
        let origins = engine
            .replacement
            .get(position)
            .and_then(|ck| codec.part_origins(ck, message));
        let mut edits = Vec::new();
        for (index, (part, row)) in before.iter().zip(&original.tags).enumerate() {
            // A part the runner described reached the engine as its stand-in
            // (`crate::descriptors::expose`); rendering that stand-in back is
            // the part unchanged.
            let exposed = crate::descriptors::expose(part);
            let seen = exposed.as_ref().unwrap_or(part);
            let expected = render_part(seen, row.tag.as_deref(), render);
            let changed = if let Some(origins) = &origins {
                origins
                    .iter()
                    .position(|origin| *origin == Some(index))
                    .and_then(|at| after.get(at))
            } else if let Some(id) = part.get("id").and_then(Value::as_str) {
                after
                    .iter()
                    .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
            } else {
                after.get(index)
            };
            match changed {
                None => edits.push(view::PartEdit::drop(
                    original.ordinal,
                    &original.mid,
                    &row.part,
                )),
                // An edit that still holds a ref or ck-mc's stand-in for one is
                // not sent, and the part stays as written: otherwise the model
                // would get ck-mc's placeholder in place of the runner's payload.
                Some(value)
                    if value != &expected
                        && value != part
                        && value != seen
                        && !crate::descriptors::holds_stand_in(value) =>
                {
                    edits.push(view::PartEdit::replace(
                        original.ordinal,
                        &original.mid,
                        &row.part,
                        serde_json::to_string(value).map_err(transient)?,
                    ))
                }
                _ => {}
            }
        }
        ranges.push(view::ViewRange::keep_with_edits(
            original.ordinal,
            original.ordinal + 1,
            edits,
        ));
        next = original.ordinal + 1;
        kept.insert(
            original.ordinal,
            tool_arcs::KeptMessage::new(codec, &original)?,
        );
    }
    if next < end || !synthetic.is_empty() {
        append_view_gap(
            state,
            codec,
            &mut ranges,
            &mut kept,
            &mut synthetic,
            &mut next,
            end,
            history_end,
        )?;
    }
    Ok((ranges, kept))
}

#[allow(clippy::too_many_arguments)]
fn append_view_gap(
    state: &State,
    codec: codec::Codec,
    ranges: &mut Vec<view::ViewRange>,
    kept: &mut tool_arcs::KeptMessages,
    synthetic: &mut Vec<Value>,
    next: &mut u64,
    to: u64,
    history_end: u64,
) -> Result<(), HandlerOutcome> {
    let prefix = ranges.is_empty() && *next == 0;
    let replacement_to = if prefix {
        to.min(history_end)
    } else if !synthetic.is_empty() {
        to
    } else {
        *next
    };
    if replacement_to > *next || !synthetic.is_empty() {
        ranges.push(view::ViewRange::replace(
            *next,
            replacement_to,
            serde_json::to_string(synthetic).map_err(transient)?,
        ));
        synthetic.clear();
        *next = replacement_to;
    }
    for (ordinal, entry) in state.entries.range(*next..to) {
        let entry = entry.read()?;
        let edits = entry
            .tags
            .iter()
            .map(|part| view::PartEdit::drop(*ordinal, &entry.mid, &part.part))
            .collect();
        ranges.push(view::ViewRange::keep_with_edits(
            *ordinal,
            *ordinal + 1,
            edits,
        ));
        kept.insert(*ordinal, tool_arcs::KeptMessage::new(codec, &entry)?);
    }
    *next = to;
    Ok(())
}

#[derive(Clone)]
struct ReminderHintState {
    namespace: String,
    frozen_identity: Option<String>,
    coverage_ordinal: Option<u64>,
    protected: BTreeSet<String>,
    frozen: HashSet<String>,
    bytes: usize,
}

impl ReminderHintState {
    fn of(
        namespace: String,
        loaded: &mc_store::LoadedState,
        frozen_identity: Option<String>,
    ) -> Self {
        let protected = loaded.meta.protected_tool_block_ids.clone();
        let frozen = loaded
            .core
            .frozen_units
            .iter()
            .filter_map(|unit| unit.key.strip_prefix("red:").map(str::to_owned))
            .collect::<HashSet<_>>();
        let bytes = namespace.len()
            + frozen_identity.as_ref().map_or(0, String::len)
            + protected
                .iter()
                .chain(&frozen)
                .map(|id| id.len() + 64)
                .sum::<usize>();
        Self {
            namespace,
            frozen_identity,
            coverage_ordinal: loaded.meta.coverage_ordinal,
            protected,
            frozen,
            bytes,
        }
    }
}

fn load_reminder_hint_state<'a>(
    store: &McStore,
    namespace: &str,
    full: Option<&Arc<mc_store::LoadedState>>,
    cached: &'a mut Option<ReminderHintState>,
) -> Result<&'a ReminderHintState, String> {
    let (small, identity) = store
        .load_meta_with_frozen_identity(namespace)
        .map_err(|e| e.to_string())?;
    let unchanged = identity.is_some()
        && cached.as_ref().is_some_and(|cached| {
            cached.namespace == namespace
                && cached.frozen_identity == identity
                && cached.coverage_ordinal == small.meta.coverage_ordinal
                && cached.protected == small.meta.protected_tool_block_ids
        });
    if !unchanged {
        let loaded = match full {
            Some(loaded) if loaded.row_version == small.row_version => Arc::clone(loaded),
            _ => Arc::new(store.load(namespace).map_err(|e| e.to_string())?),
        };
        // A concurrent writer can change the section after the header read. Do
        // not bless that snapshot with an identity belonging to an older row.
        let identity = (loaded.row_version == small.row_version)
            .then_some(identity)
            .flatten();
        *cached = Some(ReminderHintState::of(
            namespace.to_owned(),
            &loaded,
            identity,
        ));
    }
    Ok(cached.as_ref().expect("hint state loaded"))
}

/// Only a newest suffix is needed to establish the persisted protection cutoff.
/// If the floor cannot be established, retain the canonical full-read fallback.
fn reminder_protection(
    store: &McStore,
    namespace: &str,
    floor: u64,
) -> Result<crate::protection_window::ProtectionWindow, HandlerOutcome> {
    const PAGE: usize = 32;
    let mut rows = Vec::new();
    let mut through = i64::MAX;
    let mut mass = 0u64;
    loop {
        let page = store
            .load_newest_tool_tags(namespace, through, PAGE)
            .map_err(transient)?;
        #[cfg(test)]
        reminder_work::loaded(page.len());
        mass = page.iter().fold(mass, |sum, row| {
            sum.saturating_add(crate::protection_window::row_mass(row))
        });
        let count = page.len();
        let next = page.last().and_then(|row| row.tag_number.checked_sub(1));
        rows.extend(page);
        // Persisted tag numbers are unique, so each row is a complete tie group.
        if rows.len() >= 3 && mass >= floor {
            break;
        }
        if count < PAGE || next.is_none() {
            rows = store.load_tags_for_session(namespace).map_err(transient)?;
            #[cfg(test)]
            reminder_work::loaded(rows.len());
            break;
        }
        through = next.expect("a full page has a predecessor");
    }
    Ok(crate::protection_window::ProtectionWindow::from_persisted_rows(&rows, floor))
}

/// A reminder hint for the part the current lineage's read numbered
/// `number`: the reminder names the part by its host identity, and the
/// number only renders the text ck-mc expects the runner to deliver.
fn hint_part(state: &State, number: i64) -> Option<crate::runner_reminders::HintPart> {
    let number = u64::try_from(number).ok()?;
    let address = state.tag_index.get(&tags::format_tag(number)?)?;
    Some(crate::runner_reminders::HintPart::new(
        number,
        &address.mid,
        &address.part,
    ))
}

/// Hint membership needs live block identity and tool names, not tool-arc projection.
/// Decode only uncovered entries; covered invocations need not be reconstructed for
/// a tool result whose call crossed the coverage boundary.
fn async_reminder_hints(
    store: &McStore,
    state: &State,
    codec: codec::Codec,
    loaded: &ReminderHintState,
    config: &McModuleConfig,
    window: u64,
) -> Result<crate::runner_reminders::ReminderHints, HandlerOutcome> {
    let namespace = state.namespace();
    let from = loaded
        .coverage_ordinal
        .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
    let messages = state
        .entries
        .range((from, std::ops::Bound::Unbounded))
        .map(|(_, entry)| decoded_entry(codec, &entry.inbound()?))
        .collect::<Result<Vec<_>, _>>()?;
    let mut names = BTreeMap::new();
    for message in &messages {
        if loaded
            .coverage_ordinal
            .is_some_and(|end| message.ordinal <= end)
            || message.ck.meta.synthetic
            || message.ck.role == "system"
        {
            continue;
        }
        for (index, block) in message.ck.content.iter().enumerate() {
            use ck_wire::{CkKind, CkOutputKind, ResultBlockKind};
            let name = match &block.kind {
                CkKind::ToolResult {
                    tool_name, output, ..
                } => {
                    let taggable = match &output.kind {
                        CkOutputKind::Text { .. } | CkOutputKind::ErrorText { .. } => true,
                        CkOutputKind::Content { blocks }
                        | CkOutputKind::ErrorContent { blocks } => blocks
                            .iter()
                            .any(|block| matches!(block.kind, ResultBlockKind::Text { .. })),
                        _ => false,
                    };
                    if !taggable {
                        continue;
                    }
                    tool_name.as_str()
                }
                CkKind::Text { text }
                    if message.ck.role == "user"
                        || (message.ck.role == "assistant" && !text.trim().is_empty()) =>
                {
                    ""
                }
                _ => continue,
            };
            let id = ck_wire::block_id(&message.mid, index);
            if !loaded.protected.contains(&id) && !loaded.frozen.contains(&id) {
                names.insert(id, name);
            }
        }
    }
    let blocks = names.keys().map(String::as_str).collect::<Vec<_>>();
    let rows = store
        .load_tags_for_blocks(&namespace, &blocks)
        .map_err(transient)?;
    #[cfg(test)]
    reminder_work::loaded(rows.len());
    let active = rows
        .iter()
        .filter(|row| row.kind == "tool_result")
        .map(|row| transform::ActiveTagForNudge {
            tag_number: row.tag_number,
            kind: row.kind.clone(),
            token_count: row.token_count.max(0),
            tool_name: names[&row.block_id].to_owned(),
        })
        .collect::<Vec<_>>();
    if active.is_empty() {
        return Ok(crate::runner_reminders::ReminderHints::default());
    }
    let protection = reminder_protection(
        store,
        &namespace,
        config.resolve_protected_tokens(window).floor,
    )?;
    let pending = store
        .load_pending_agent_drops(&namespace)
        .map_err(transient)?;
    let queued_ids = pending
        .iter()
        .map(|drop| drop.target_id.as_str())
        .collect::<HashSet<_>>();
    let queued = rows
        .iter()
        .filter(|row| queued_ids.contains(row.block_id.as_str()))
        .map(|row| row.tag_number)
        .collect::<HashSet<_>>();
    Ok(crate::runner_reminders::ReminderHints {
        oldest_reclaimable: transform::oldest_reclaimable_hint(
            &active,
            &protection.cutoff,
            &queued,
        )
        .into_iter()
        .filter_map(|(number, _)| hint_part(state, number))
        .collect(),
        channel2: transform::oldest_channel2_hint(&active, &protection.cutoff, &queued)
            .into_iter()
            .filter_map(|(number, _)| hint_part(state, number))
            .collect(),
    })
}

/// The tag hints a reduce reminder names: the oldest reclaimable tool outputs
/// in the unsummarized tail, and the separate pressure-reminder (channel 2)
/// selection of unqueued tool outputs of at least 100 tokens. Reads every held
/// message and every tag row, so it runs only when a reminder is sent.
#[cfg(test)]
fn async_reminder_hints_oracle(
    store: &McStore,
    state: &State,
    codec: codec::Codec,
    loaded: &mc_store::LoadedState,
    config: &McModuleConfig,
    window: u64,
) -> Result<crate::runner_reminders::ReminderHints, HandlerOutcome> {
    let namespace = state.namespace();
    let rows = store.load_tags_for_session(&namespace).map_err(transient)?;
    reminder_work::loaded(rows.len());
    let entries = inbound_messages(state.entries.values())?;
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
        "session_id":namespace,"messages":[],"render_config":"async-reminder-hints"}))?;
    state
        .reminder_echoes
        .prepare(codec, &mut request, &entries, false)?;
    let projection = ck_wire::project_messages(&request.messages).map_err(transient)?;
    let mut active =
        transform::active_tags_for_nudge(&loaded.core, &loaded.meta, &projection, &rows, None);
    active.retain(|tag| {
        rows.iter()
            .find(|row| row.tag_number == tag.tag_number)
            .is_some_and(|row| !loaded.meta.protected_tool_block_ids.contains(&row.block_id))
    });
    let protection = crate::protection_window::ProtectionWindow::from_persisted_rows(
        &rows,
        config.resolve_protected_tokens(window).floor,
    );
    let pending = store
        .load_pending_agent_drops(&namespace)
        .map_err(transient)?;
    let queued = rows
        .iter()
        .filter(|row| pending.iter().any(|drop| drop.target_id == row.block_id))
        .map(|row| row.tag_number)
        .collect::<HashSet<_>>();
    Ok(crate::runner_reminders::ReminderHints {
        oldest_reclaimable: transform::oldest_reclaimable_hint(
            &active,
            &protection.cutoff,
            &queued,
        )
        .into_iter()
        .filter_map(|(number, _)| hint_part(state, number))
        .collect(),
        channel2: transform::oldest_channel2_hint(&active, &protection.cutoff, &queued)
            .into_iter()
            .filter_map(|(number, _)| hint_part(state, number))
            .collect(),
    })
}

impl McHandler {
    async fn announce_async_views(&self) -> Result<(), HandlerOutcome> {
        let Some(store) = self.store.get() else {
            return Ok(());
        };
        let publisher = self
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .expect("async publisher")
            .clone()
            .ok_or_else(|| transient("bus not configured"))?;
        for (reference, version, raw) in
            store.pending_async_compaction_views().map_err(transient)?
        {
            let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
            let Some(state) = load_head(store, &reference)? else {
                continue;
            };
            let invalid_cut = if let Some(cut) = &view.cut {
                state
                    .published_cut_for(store, cut.through_ordinal + 1, &view.lineage_id)?
                    .is_none_or(|held| {
                        held.version != version
                            || held
                                .covered_through
                                .is_none_or(|end| end > cut.through_ordinal)
                    })
            } else {
                false
            };
            if state.resync
                || state.offline_first_pass.is_some()
                || state.lineage.as_deref() != Some(&view.lineage_id)
                || invalid_cut
            {
                continue;
            }
            publisher
                .publish(&notice::ViewReady::for_view(&view))
                .await?;
            store
                .mark_async_compaction_announced(&reference, version)
                .map_err(transient)?;
        }
        Ok(())
    }

    /// Advance a conversation on one notice. A protocol error is counted on
    /// the conversation and retried a bounded number of times; see
    /// `record_protocol_failure`.
    pub(super) async fn advance_compaction(
        &self,
        account: &str,
        message: &cortexkit_bus_trait::Message,
    ) -> Result<(), HandlerOutcome> {
        match Box::pin(self.advance_compaction_once(account, message)).await {
            Err(HandlerOutcome::Error {
                code,
                message: reason,
            }) if code == PROTOCOL_ERROR => self.record_protocol_failure(message, &reason).await,
            other => other,
        }
    }

    /// Count a protocol error against the conversation a notice names. Below
    /// the bound the notice is retried (a transient error); at the bound the
    /// conversation enters the `failed` state, readable in its record and in
    /// every ride answer, and the notice is acknowledged.
    async fn record_protocol_failure(
        &self,
        message: &cortexkit_bus_trait::Message,
        reason: &str,
    ) -> Result<(), HandlerOutcome> {
        let notice = notice::AdvanceNotice::from_headers(&message.headers)
            .map_err(|e| invalid_field("notice", e.name()))?;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(head) = load_head(store, &notice.session_ref)? else {
            return Ok(());
        };
        let _serial = self.provider_serial.lock_for(&head.key).await;
        let Some(mut state) = self.checkout(store, &notice.session_ref)? else {
            return Ok(());
        };
        let failure = state.failure.get_or_insert_with(|| AsyncFailure {
            state: FailureState::Retrying,
            code: PROTOCOL_ERROR.into(),
            reason: String::new(),
            seq: notice.seq,
            attempts: 0,
        });
        failure.attempts = failure.attempts.saturating_add(1);
        failure.reason = reason.into();
        failure.seq = notice.seq;
        let failed = failure.attempts >= MAX_PROTOCOL_ATTEMPTS;
        if failed {
            failure.state = FailureState::Failed;
            tracing::error!(session_ref=%notice.session_ref, code=PROTOCOL_ERROR, reason, attempts=failure.attempts, "async compaction conversation failed");
        }
        state.save(store, &[])?;
        self.checkin(state);
        if failed {
            Ok(())
        } else {
            Err(transient(format!("{PROTOCOL_ERROR}: {reason}")))
        }
    }

    async fn advance_compaction_once(
        &self,
        account: &str,
        message: &cortexkit_bus_trait::Message,
    ) -> Result<(), HandlerOutcome> {
        let mut notice = notice::AdvanceNotice::from_headers(&message.headers)
            .map_err(|e| invalid_field("notice", e.name()))?;
        if bus_id(&notice.session_ref, "advanced", notice.seq) != message.id
            || notice.digest() != message.digest.to_string()
        {
            return Err(invalid_field("notice", "claim check digest or id mismatch"));
        }
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load_head(store, &notice.session_ref)? else {
            return Ok(());
        };
        if message.subject
            != notice::event_subject(account, &state.runner_module, notice::ADVANCED_EVENT)
        {
            return Err(invalid_field(
                "subject",
                "notice not from the session runner",
            ));
        }
        let _serial = self.provider_serial.lock_for(&state.key).await;
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:checkout");
        state = self
            .checkout(store, &notice.session_ref)?
            .ok_or_else(|| transient("async session disappeared"))?;
        if state.active_seed_is_unsafe(store)? {
            return Err(error(
                "unsafe_cut_seed",
                "the stored head requires a fresh full lineage",
            ));
        }
        if notice
            .first_ordinal
            .is_some_and(|first| first > state.lineage_first_ordinal)
        {
            let Some(descent) = &notice.descends_from else {
                return Err(error(
                    "unknown_cut",
                    "a cut notice must name its published parent",
                ));
            };
            let mut request = state.setup.clone();
            request.lineage_id = Some(notice.lineage_id.clone());
            request.descends_from = Some(compact::lineage::DescendsFrom::new(
                &descent.lineage_id,
                descent.through_ordinal,
            ));
            let binding = self.async_binding(&state);
            self.checkin(state);
            let answer: Value = serde_json::from_slice(
                &self
                    .setup_cut_descent(
                        &binding,
                        &request,
                        load_head(store, &notice.session_ref)?,
                        store,
                    )
                    .await?,
            )
            .map_err(transient)?;
            if answer["answer"] != "ready" {
                return Err(error("unknown_cut", "the notice names an unknown cut"));
            }
            state = self
                .checkout(store, &notice.session_ref)?
                .ok_or_else(|| transient("async session disappeared"))?;
        }
        #[cfg(test)]
        drop(phase);
        // A record from before cut seeds existed is rebuilt, not migrated.
        cut_seed::discard_older_record(&mut state, store)?;
        // A record the offline first pass prepared is checked against what the
        // runner serves now, once, before anything else: it is either adopted
        // whole or discarded for a fresh record.
        if state.offline_first_pass.is_some() {
            // Boxed: this one-time check reads the whole transcript, and an
            // inline future of that size would grow every notice's future.
            state =
                Box::pin(self.settle_offline_first_pass(state, store, &message.headers)).await?;
        }
        // A retry of the notice whose read the budget cut short continues that
        // read. The lineage held then was taken from the runner's own pages
        // during this notice, so the notice's older lineage header does not move
        // it; a lineage change the runner makes meanwhile still fails the next
        // page and resets the read.
        let resuming = state.partial_read_seq == Some(notice.seq);
        let moves_lineage = !resuming
            && message
                .headers
                .get("lineage_id")
                .is_some_and(|new| state.lineage.as_ref().is_some_and(|old| old != new));
        if state.failed() && !moves_lineage {
            // A failed conversation does no work until the runner moves it
            // to a new lineage; the notice is acknowledged.
            self.checkin(state);
            return Ok(());
        }
        let duplicate = notice.seq <= state.seq;
        state.remember_notice_native_ack(store, &notice)?;
        if notice.seq < state.seq && state.completed_seq < state.seq {
            // An older retry cannot complete a newer notice's partial read.
            // Preserve its source receipt without replacing the newer facts.
            state.save(store, &[])?;
            self.checkin(state);
            return Ok(());
        }
        let mut descended = false;
        if let Some(lineage) = message
            .headers
            .get("lineage_id")
            .filter(|_| !resuming)
            .filter(|new| state.lineage.as_ref().is_some_and(|old| old != *new))
        {
            let through = if let Some(header) = message.headers.get("descends_from") {
                if let Some(through) = verified_descent(&state, header) {
                    Some(through)
                } else {
                    Box::pin(self.verify_unseen_descent(
                        &state,
                        lineage,
                        header,
                        self.notice_read_budget(),
                    ))
                    .await?
                }
            } else {
                None
            };
            if let Some(through) = through {
                let parent = state.lineage.clone().expect("held lineage");
                state.remember_verified_ack_descent(store, lineage, &parent, through)?;
                // A fork can cut away source identities needed by a later restore.
                // Capture acknowledged edits before dropping those held entries.
                if let Some(version) = state.applied {
                    state.capture_frozen_version(store, version)?;
                }
                state.truncate_entries(Some(through));
                let mut engine = state.engine_with_baselines()?;
                engine
                    .descend(lineage, &parent, through)
                    .map_err(engine_error)?;
                engine.last_applied = None;
                state.adopt_engine(engine)?;
                state.lineage = Some(lineage.clone());
                state.failure = None;
                let mut retained = store
                    .load_compartments(&state.namespace())
                    .map_err(transient)?
                    .into_iter()
                    .filter(|row| row.end_message <= through as i64)
                    .collect::<Vec<_>>();
                state.repair_cut_history(store, &mut retained, Some(through))?;
                store
                    .replace_compartments(&state.namespace(), &retained)
                    .map_err(transient)?;
                // A cut lineage must rebuild from its surviving window when
                // forked rows reuse ids with different block identities. A
                // full lineage keeps the engine's verified-prefix descent.
                if state.lineage_first_ordinal > 0 {
                    state.reset(store)?;
                }
                descended = true;
            } else {
                state.reset(store)?;
                // An unverifiable lineage change cannot inherit the old cut.
                state.cut_seed = None;
                state.cut_first_ordinal = None;
                state.lineage_first_ordinal = 0;
                state.save(store, &[])?;
            }
        }
        if !duplicate {
            state.seq = notice.seq;
            state.conditions = Some(notice.to_headers());
        }
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut resynced = state.resync || descended;
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:read");
        for attempt in 0..2 {
            let from = state.read_from();
            let read = self
                .read_async_resumable(&mut state, from, self.notice_read_budget())
                .await;
            if let Ok(ReadProgress::Incomplete { next }) = read {
                // The budget ran out while every page was still valid. Keep
                // what was read so the retried notice continues from it; a
                // first read of a long session takes several attempts.
                state.partial_read_seq = Some(notice.seq);
                state.save_partial_read(store, codec)?;
                let held_through = state.entries.last_key_value().map(|(n, _)| *n);
                tracing::info!(session_ref=%notice.session_ref, ?held_through, next, "async read incomplete; the retry resumes from the held entries");
                self.checkin(state);
                return Err(transient(format!(
                    "async read incomplete; resuming from ordinal {next}"
                )));
            }
            if let Ok(ReadProgress::NeverWritten) = read {
                // Not a failure to retry: the runner has written nothing for
                // this session. The notice is acknowledged; the next notice or
                // Setup reads again.
                tracing::info!(session_ref=%notice.session_ref, outcome=NEVER_WRITTEN, "async read: the runner has never written this session");
                state.read_outcome = Some(NEVER_WRITTEN.into());
                state.partial_read_seq = None;
                state.save(store, &[])?;
                self.checkin(state);
                return Ok(());
            }
            let read = read.map(|_| ());
            let verified = read.is_ok()
                && state
                    .entries
                    .get(&notice.through_ordinal)
                    .map(|entry| entry.read())
                    .transpose()?
                    .map(|entry| served_digest(&entry))
                    .transpose()?
                    .is_some_and(|digest| digest == notice.through_digest);
            if verified {
                state.partial_read_seq = None;
                state.resync = false;
                state.reminder_echoes.finish_resync();
                break;
            }
            state.reset(store)?;
            state.save(store, &[])?;
            resynced = true;
            if attempt == 1 {
                read?;
                tracing::warn!(session_ref=%notice.session_ref,"async digest mismatch; waiting for a matching notice");
                return Ok(());
            }
        }
        #[cfg(test)]
        drop(phase);
        state.record_restored_ack_descent(store)?;
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:index");
        state.ingest_read(store, codec)?;
        if state.completed_seq < notice.seq || resuming {
            // Reset clears the read lineage, and ingestion normalizes served
            // source parts. Validate acknowledgements only after both recover.
            state.adopt_notice_ack(store, &mut notice)?;
        } else {
            state.normalize_notice_ack(store, &mut notice)?;
            if !state.pending_native_acks.is_empty() {
                state.resolve_native_acks(store)?;
                state.save(store, &[])?;
            }
        }
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:policy");
        #[cfg(test)]
        if self
            .provider_store
            .async_runtime
            .policy_probe_enabled
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            *self
                .provider_store
                .async_runtime
                .policy_probe
                .lock()
                .unwrap() = Some((
                notice.seq,
                notice.applied_view_version,
                notice.events.iter().map(notice::Event::token).collect(),
            ));
        }
        self.advance_async_policy(&mut state, &notice, codec)?;
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:publish");
        let pending_before = store
            .load_pending_agent_drops(&state.namespace())
            .map_err(transient)?
            .len();
        #[cfg(test)]
        let skip_phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:skip");
        let run_engine = (state.completed_seq < notice.seq || resynced)
            && (resynced || !self.async_engine_can_skip(&state, &notice)?);
        #[cfg(test)]
        if self
            .provider_store
            .async_runtime
            .record_notice_decisions
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            cut_seed::notice_trace::record(Arc::as_ptr(store) as usize, notice.seq, run_engine);
        }
        #[cfg(test)]
        drop(skip_phase);
        if run_engine {
            if let Err(error) = self.publish_async(0, &mut state, codec, resynced) {
                drop(state);
                self.mark_engine_failed(store, &notice.session_ref)?;
                return Err(error);
            }
            state.engine_failed = false;
        }
        state.completed_seq = state.seq;
        let drops_applied = store
            .load_pending_agent_drops(&state.namespace())
            .map_err(transient)?
            .len()
            < pending_before;
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:reminders");
        self.advance_async_reminders(&mut state, &notice, codec, drops_applied)
            .await?;
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:cadence");
        let historian_due = self.advance_async_historian_cadence(&mut state, codec)?;
        // This notice went through: earlier protocol errors were transient
        // after all.
        state.failure = None;
        state.save(store, &[])?;
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:historian");
        if historian_due {
            self.schedule_async_historian(&state)?;
        }
        #[cfg(test)]
        drop(phase);
        #[cfg(test)]
        let phase = scaling_tests::save_meter::start_kind(&notice.session_ref, "phase:checkin");
        self.checkin(state);
        drop(_serial);
        #[cfg(test)]
        drop(phase);
        self.announce_async_views().await
    }

    /// The time one notice may spend reading the transcript. A read that
    /// does not finish in it is kept and continued on the notice's retry.
    fn notice_read_budget(&self) -> Duration {
        #[cfg(test)]
        if let Some(budget) = *self
            .provider_store
            .async_runtime
            .notice_read_budget
            .lock()
            .expect("notice read budget")
        {
            return budget;
        }
        Duration::from_secs(10)
    }

    async fn read_async(
        &self,
        state: &mut State,
        from: u64,
        budget: Duration,
    ) -> Result<(), HandlerOutcome> {
        match self.read_async_resumable(state, from, budget).await? {
            // A session the runner never wrote has nothing to catch up on.
            ReadProgress::Complete | ReadProgress::NeverWritten => Ok(()),
            ReadProgress::Incomplete { .. } => {
                Err(transient("async paging did not advance within deadline"))
            }
        }
    }

    /// Read the transcript from `from` until the runner has no next page, or
    /// until `budget` runs out between two valid pages. Every held entry is
    /// still checked; only the budget makes a read `Incomplete`, never a page
    /// the runner refused or one that contradicts what is held.
    async fn read_async_resumable(
        &self,
        state: &mut State,
        mut from: u64,
        budget: Duration,
    ) -> Result<ReadProgress, HandlerOutcome> {
        let started = Instant::now();
        let deadline = started + budget;
        self.ensure_lineage_window(state, budget).await?;
        from = from.max(state.cut_first_ordinal.unwrap_or(0));
        // Stop before a page that the remaining budget could cut short: a page
        // call cut by its timeout is a failed read, not a resumable one.
        let mut slowest_page = Duration::ZERO;
        let mut pages = 0u64;
        loop {
            let page_started = Instant::now();
            if pages > 0 && deadline.saturating_duration_since(page_started) <= slowest_page {
                return Ok(ReadProgress::Incomplete { next: from });
            }
            // Descriptors mode (compaction-provider §3): payloads arrive as refs
            // and every message carries the runner's own content digests.
            let mut params =
                json!({"from_ordinal":from,"max_bytes":1_048_576,"media":"descriptors"});
            if let Some(lineage) = &state.lineage {
                params["lineage_id"] = json!(lineage);
            }
            let page = self
                .provider_runner
                .call_for_identity(
                    &state.runner()?,
                    &state.runner_identity(),
                    "session.read",
                    params,
                    deadline.saturating_duration_since(Instant::now()),
                )
                .await
                .map_err(runner_error)?;
            log_read_identity_once(state, None);
            let Some(lineage) = page["lineage_id"].as_str() else {
                return lineageless_page(state, &page);
            };
            state.read_outcome = None;
            if state.lineage.as_deref().is_some_and(|held| held != lineage) {
                return Err(transient("async lineage changed"));
            }
            if state.lineage.is_none() {
                state.adopt_first_lineage(lineage)?;
            }
            state.lineage = Some(lineage.into());
            let entries: Vec<ReadMessage> = decode(&page["messages"])?;
            if entries.is_empty()
                && state
                    .entries
                    .last_key_value()
                    .is_some_and(|(last, _)| *last >= from)
            {
                return Err(transient("async transcript shortened"));
            }
            let mut expected = if state.entries.is_empty() && from == 0 {
                entries.first().map_or(0, |entry| entry.ordinal.min(1))
            } else {
                from
            };
            for entry in entries {
                if entry.ordinal != expected {
                    return Err(transient("async transcript gap"));
                }
                expected = expected
                    .checked_add(1)
                    .ok_or_else(|| invalid("ordinal exhausted"))?;
                if let Some(held) = state.entries.get(&entry.ordinal) {
                    if !stable_entry(&held.read()?, &entry) {
                        return Err(transient("async entry changed on re-read"));
                    }
                } else {
                    let codec =
                        codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
                    check_served_identity(&entry, codec)?;
                    if let Some(cadence) = &mut state.reminder_cadence {
                        state.reminder_echoes.ingest(
                            &entry,
                            codec,
                            &mut cadence.ledger,
                            now_ms().max(0) as u64,
                        )?;
                    }
                    let held = HeldEntry::from_read(&entry)?;
                    #[cfg(test)]
                    let held = held.counted_as(state.reference());
                    state.entries.insert(entry.ordinal, Arc::new(held));
                    // Undo can reintroduce an archived source after the first
                    // post-Setup read. Look up the newly held window again so
                    // an acknowledged drop cannot disappear on a later page.
                    state.pending_undo_edits |=
                        state.cut_first_ordinal.is_some() || state.setup.descends_from.is_some();
                }
            }
            let Some(next) = page["next_from_ordinal"].as_u64() else {
                break;
            };
            if next != expected || next <= from {
                return Err(transient("async paging did not advance"));
            }
            pages += 1;
            slowest_page = slowest_page.max(page_started.elapsed());
            from = next;
            if Instant::now() >= deadline {
                return Ok(ReadProgress::Incomplete { next });
            }
        }
        Ok(ReadProgress::Complete)
    }

    async fn advance_async_reminders(
        &self,
        state: &mut State,
        notice: &notice::AdvanceNotice,
        codec: codec::Codec,
        drops_applied: bool,
    ) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let namespace = state.namespace();
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&notice.session_ref, "rem:base");
        let base = self.reminder_base(store, state)?;
        #[cfg(test)]
        drop(meter);
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&notice.session_ref, "rem:last");
        let config = self.effective_config(state.project());
        // Only the newest one or two entries are read here. The running
        // totals cover the rest; the tag hints, which need the uncovered tail,
        // are computed only if a reminder is actually sent.
        let mut newest = state.entries.values().rev();
        let last_entry = newest.next().map(|entry| entry.read()).transpose()?;
        let prior_entry = newest.next().map(|entry| entry.read()).transpose()?;
        let last = last_entry
            .as_ref()
            .map(|entry| {
                decoded_entry(
                    codec,
                    &InboundMessage {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        message: entry.message.clone(),
                    },
                )
            })
            .transpose()?;
        let carries_result = |message: &ck_wire::CkIngressMessage| {
            message
                .ck
                .content
                .iter()
                .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
        };
        let carrier = match last.as_ref().filter(|message| carries_result(message)) {
            Some(message) => {
                // The last message's tag rows: the runner's rows are named
                // `mid#index` for each decoded block, and this lane mints no
                // others, so these are all the rows of that message.
                let blocks = (0..message.ck.content.len())
                    .map(|index| format!("{}#{index}", message.mid))
                    .collect::<Vec<_>>();
                let blocks = blocks.iter().map(String::as_str).collect::<Vec<_>>();
                let prefix = format!("{}#", message.mid);
                store
                    .load_tags_for_blocks(&namespace, &blocks)
                    .map_err(transient)?
                    .iter()
                    .rev()
                    .find(|row| {
                        row.kind == "tool_result"
                            && row.block_id.starts_with(&prefix)
                            && row.token_count > 0
                    })
                    .and_then(|row| u64::try_from(row.tag_number).ok())
            }
            None => None,
        };
        #[cfg(test)]
        drop(meter);
        let user = last
            .as_ref()
            .filter(|message| state.reminder_echoes.authored(message));
        let users = state.aggregates.real_users;
        let written = last_entry.as_ref().and_then(|entry| entry.written_at);
        let prior = prior_entry.as_ref().and_then(|entry| entry.written_at);
        let gap_ms = written
            .zip(prior)
            .and_then(|(written, prior)| i64::try_from(written).ok().zip(i64::try_from(prior).ok()))
            .map(|(written, prior)| written.saturating_sub(prior));
        let loaded_generation = base.baseline.as_ref().map(|b| b.baseline_generation);
        let prior_generation = if state.reminder_cadence.is_some() {
            state.reminder_baseline_generation
        } else {
            loaded_generation
        };
        let mut cadence = match state.reminder_cadence.take() {
            Some(cadence) => cadence,
            None => {
                let mut cadence = crate::runner_reminders::ReminderState::default();
                cadence.meta = base
                    .full
                    .as_ref()
                    .expect("a first reminder pass loads the full state")
                    .meta
                    .clone();
                cadence
            }
        };
        let window = notice.window.or(state.setup.context_window).unwrap_or(0);
        let hint_state = Mutex::new(state.reminder_hint_state.take());
        #[cfg(test)]
        let oracle = self.async_oracle() || std::env::var_os("MC_ASYNC_REMINDER_ORACLE").is_some();
        let held: &State = state;
        let full = base.full.clone();
        let hints = || {
            #[cfg(test)]
            if oracle {
                let loaded = match &full {
                    Some(loaded) => Arc::clone(loaded),
                    None => Arc::new(store.load(&held.namespace()).map_err(|e| e.to_string())?),
                };
                return async_reminder_hints_oracle(store, held, codec, &loaded, &config, window)
                    .map_err(|error| format!("{error:?}"));
            }
            let mut cached = hint_state.lock().unwrap_or_else(|p| p.into_inner());
            let loaded =
                load_reminder_hint_state(store, &held.namespace(), full.as_ref(), &mut cached)?;
            async_reminder_hints(store, held, codec, loaded, &config, window)
                .map_err(|error| format!("{error:?}"))
        };
        let conditions = crate::runner_reminders::ReminderConditions {
            notice_id: &bus_id(&held.reference(), "advanced", notice.seq),
            now_ms: now_ms().max(0) as u64,
            real_user_turn_count: users,
            baseline: base.baseline.as_deref(),
            newest_tool_tag: carrier,
            hints: &hints,
            drops_applied,
            baseline_refreshed: prior_generation != loaded_generation,
            hard_fold_coverage_advanced: base.coverage_ordinal > cadence.meta.coverage_ordinal,
            user_message_id: user.map(|message| message.mid.as_str()),
            temporal_enabled: config.temporal_awareness,
            gap_ms,
            ready_search_hint: None,
        };
        let runner_identity = held.runner_identity();
        let runner = RoutedRunner {
            runner: self.provider_runner.as_ref(),
            route: held.runner()?,
            identity: runner_identity.clone(),
        };
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&notice.session_ref, "rem:send");
        #[cfg(test)]
        let outcome = if oracle {
            crate::runner_reminders::send_due_reminders_oracle(
                &runner,
                &runner_identity.project_root,
                &runner_identity.session,
                &mut cadence,
                &conditions,
            )
            .await
        } else {
            crate::runner_reminders::send_due_reminders(
                &runner,
                &runner_identity.project_root,
                &runner_identity.session,
                &mut cadence,
                &conditions,
            )
            .await
        };
        #[cfg(not(test))]
        let outcome = crate::runner_reminders::send_due_reminders(
            &runner,
            &runner_identity.project_root,
            &runner_identity.session,
            &mut cadence,
            &conditions,
        )
        .await;
        #[cfg(test)]
        drop(meter);
        state.reminder_hint_state = hint_state.into_inner().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = outcome.hints_failed {
            return Err(transient(error));
        }
        cadence.meta.coverage_ordinal = base.coverage_ordinal;
        state.reminder_baseline_generation = cadence
            .meta
            .tail_hygiene_baseline
            .take()
            .map(|b| b.baseline_generation);
        state.reminder_cadence = Some(cadence);
        for error in outcome.errors {
            tracing::warn!(%error,"async reminder send unavailable");
        }
        Ok(())
    }

    /// What the reminder pass reads from the engine's cache state: the tail
    /// hygiene baseline and the coverage ordinal. The baseline holds one
    /// measurement per tail part, so the resident record keeps the last one
    /// decoded and reuses it while its stored identity (see
    /// `McStore::load_meta_with_tail_identity`) is unchanged; the coverage
    /// comes from the small row. The first pass of a generation loads the
    /// whole state, because it copies the whole meta into the reminder
    /// cadence.
    fn reminder_base(
        &self,
        store: &McStore,
        state: &mut State,
    ) -> Result<resident::ReminderBase, HandlerOutcome> {
        let namespace = state.namespace();
        let full = |loaded: mc_store::LoadedState| resident::ReminderBase {
            baseline: loaded.meta.tail_hygiene_baseline.clone().map(Arc::new),
            coverage_ordinal: loaded.meta.coverage_ordinal,
            full: Some(Arc::new(loaded)),
        };
        #[cfg(test)]
        if self.async_oracle() {
            return Ok(full(store.load(&namespace).map_err(transient)?));
        }
        let (small, identity) = store
            .load_meta_with_tail_identity(&namespace)
            .map_err(transient)?;
        if state.reminder_cadence.is_some() {
            if let Some(cached) = state.cache_state.as_ref().filter(|cached| {
                cached.namespace == namespace && Some(&cached.identity) == identity.as_ref()
            }) {
                return Ok(resident::ReminderBase {
                    baseline: cached.baseline.clone(),
                    coverage_ordinal: small.meta.coverage_ordinal,
                    full: None,
                });
            }
        }
        #[cfg(test)]
        let _phase =
            scaling_tests::save_meter::start_kind(&state.reference(), "phase:cache_state_load");
        let base = full(store.load(&namespace).map_err(transient)?);
        // Cache only a baseline read at the identity just seen; a write in
        // between makes the next pass load again.
        let (_, again) = store
            .load_meta_with_tail_identity(&namespace)
            .map_err(transient)?;
        state.cache_state = identity
            .filter(|identity| again.as_ref() == Some(identity))
            .map(|identity| resident::CachedEngineState {
                namespace,
                identity,
                bytes: base.baseline.as_ref().map_or(0, |baseline| {
                    // Parsed structures take more than their JSON.
                    serde_json::to_vec(&**baseline).map_or(0, |bytes| bytes.len() * 2)
                }),
                baseline: base.baseline.clone(),
            });
        Ok(base)
    }

    fn async_binding(&self, state: &State) -> SessionBinding {
        let identity = state.runner_identity();
        SessionBinding {
            principal: Some(subc_protocol::Principal::Reserved {
                module_id: state.runner_module.clone(),
            }),
            scope: None,
            project_root: identity.project_root.clone(),
            harness: identity.harness,
            session: identity.session,
            model_key: None,
            config: self.effective_config(&identity.project_root).clone(),
            history_budget_tokens: 4_000.0,
        }
    }

    fn publish_async(
        &self,
        channel: u16,
        state: &mut State,
        codec: codec::Codec,
        ride: bool,
    ) -> Result<Option<view::CompactionView>, HandlerOutcome> {
        if state.resync || state.entries.is_empty() {
            return Ok(None);
        }
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        state.cleanup_pending_cut_stage(store)?;
        state.forward_parent_history(store)?;
        state.restore_undo_edits(store)?;
        let mut history = store
            .load_compartments(&state.namespace())
            .map_err(transient)?;
        let before = history
            .iter()
            .map(|c| (c.sequence, c.start_message, c.end_message))
            .collect::<Vec<_>>();
        state.repair_cut_history(store, &mut history, None)?;
        if before
            != history
                .iter()
                .map(|c| (c.sequence, c.start_message, c.end_message))
                .collect::<Vec<_>>()
        {
            store
                .replace_compartments(&state.namespace(), &history)
                .map_err(transient)?;
        }
        let headers = state
            .conditions
            .as_ref()
            .ok_or_else(|| transient("no async conditions"))?;
        let notice =
            notice::AdvanceNotice::from_headers(headers).map_err(|e| transient(e.name()))?;
        let binding = self.async_binding(state);
        let status = transform::compaction::Status {
            lineage_id: state.lineage.clone().unwrap_or_default(),
            newest_ordinal: state.entries.last_key_value().map(|(n, _)| *n),
            previous_usage: None,
            request_tokens: notice.est_tokens,
            context_window: state
                .usage_policy
                .as_ref()
                .and_then(|policy| policy.limit_for(&notice.model))
                .or(notice.window.or(state.setup.context_window))
                .ok_or_else(|| invalid("window unknown"))?,
            prefix_rebuilding: ride,
            pipeline_switch: false,
            last_applied_version: None,
            last_not_applied: None,
        };
        let mut engine = state.engine_with_baselines()?;
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&state.reference(), "pub:engine");

        let (template, output) =
            self.async_engine(channel, &binding, state, codec, &status, &mut engine)?;

        #[cfg(test)]
        cut_seed::pass_trace::record(
            Arc::as_ptr(store) as usize,
            format!(
                "action={} reason={:?} prefix={:?} cut_prefix={} messages={} first={:?}",
                output.engine.response.action,
                output.engine.response.materialize_reason,
                template
                    .logical_prefix
                    .as_ref()
                    .map(|prefix| prefix.tail_from),
                template
                    .logical_prefix
                    .as_ref()
                    .is_some_and(|prefix| prefix.is_cut()),
                template.messages.len(),
                template.messages.first().map(|message| message.ordinal)
            ),
        );
        #[cfg(test)]
        drop(meter);
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&state.reference(), "pub:certify");
        if output.prefix_bust_permitted
            && !self.async_oracle()
            && engine.preset == transform::compaction::Preset::Head
        {
            let mut snapshot = store
                .load_logical_transform_snapshot(&state.namespace(), &[])
                .map_err(transient)?;
            let compartments = store
                .load_compartments(&state.namespace())
                .map_err(transient)?;
            let mut prefix = transform::compaction::LogicalPrefix::certify(
                store,
                &template,
                &output.engine.projection,
                &snapshot.loaded,
                &compartments,
                &status.lineage_id,
                state.generation,
            );
            if let Some(prefix) = &mut prefix {
                let mut sources: BTreeMap<u64, InboundMessage> = inbound_messages(
                    prefix
                        .context_ordinals
                        .iter()
                        .filter_map(|ordinal| state.entries.get(ordinal)),
                )?
                .into_iter()
                .map(|source| (source.ordinal, source))
                .collect();
                // Context sources below a cut are kept by its seed.
                if let Some(seed) = &state.cut_seed {
                    for ordinal in &prefix.context_ordinals {
                        if let Some(source) = seed.context_sources.get(ordinal) {
                            sources.entry(*ordinal).or_insert_with(|| source.clone());
                        }
                    }
                }
                prefix.context_sources = sources;
            }
            if let Some(candidate) = &prefix {
                if let Err(error) =
                    compact_prefix_hygiene(store, state, candidate, &mut snapshot.loaded)
                {
                    tracing::debug!(session_ref=%state.reference(), %error, reason="prefix_hygiene_snapshot", "using full-lineage recovery input");
                    prefix = None;
                }
            }
            state.logical_prefix = prefix.map(Arc::new);
            state.prefix_input_proof = state
                .logical_prefix
                .as_ref()
                .map(|prefix| state.entries.proof_before(prefix.tail_from));
        }
        let transform::compaction::Answer::Replacement(mut candidate) = output.answer else {
            state.adopt_engine(engine)?;
            return Ok(None);
        };
        if !ride && !output.prefix_bust_permitted {
            state.adopt_engine(engine)?;
            return Ok(None);
        }
        #[cfg(test)]
        drop(meter);
        #[cfg(test)]
        let meter = scaling_tests::save_meter::start_kind(&state.reference(), "pub:render");
        let wire = if self.async_input_oracle() || state.logical_prefix.is_none() {
            rendered_view(codec, &candidate, state, true)?
        } else if template.logical_prefix.is_none() {
            // This pass read every held message, but `certify` above has just
            // proven its covered prefix. Render from the view's own source
            // messages only, as Setup does once a certificate exists: covered
            // sources cannot change tail-native rendering, and a subset the
            // codec cannot render falls back to the whole lineage inside
            // `rendered_view`. Rendering through `template` here would copy and
            // walk every held message again.
            rendered_view(codec, &candidate, state, false)?
        } else {
            #[cfg(test)]
            scaling_tests::view_work::renderer(&state.reference(), template.messages.len());
            match codec.render_prepared_view(&candidate, &state.key.session, &template) {
                Ok(wire) => wire,
                Err(_) => rendered_view(codec, &candidate, state, true)?,
            }
        };
        let coverage = store
            .load_meta(&state.namespace())
            .map_err(transient)?
            .meta
            .coverage_ordinal;
        #[cfg(test)]
        drop(meter);
        #[cfg(test)]
        let _meter = scaling_tests::save_meter::start_kind(&state.reference(), "pub:ranges");
        let (mut ranges, kept) = ranges(state, codec, &wire, &candidate, coverage)?;
        state
            .frozen_edits
            .apply(&state.mid_index, &state.entries, &kept, &mut ranges)?;
        if let Some(cadence) = &state.reminder_cadence {
            state.reminder_echoes.apply(
                &cadence.ledger,
                now_ms().max(0) as u64,
                &state.entries,
                &kept,
                &mut ranges,
            )?;
        }
        let restored_head = state.restored_head.take();
        if let Some(head) = &restored_head {
            let head_end = ranges
                .iter()
                .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
                .last()
                .map(view::ViewRange::to);
            if let Some(view::ViewRange::Replace { bytes, .. }) =
                ranges.first_mut().filter(|_| head_end == Some(head.to))
            {
                *bytes = head.bytes.clone();
                for range in ranges
                    .iter_mut()
                    .skip(1)
                    .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
                {
                    if let view::ViewRange::Replace { bytes, .. } = range {
                        *bytes = "[]".into();
                    }
                }
                let messages: Vec<Value> = serde_json::from_str(&head.bytes).map_err(transient)?;
                let mut decoded = Vec::new();
                for (index, mut message) in messages.into_iter().enumerate() {
                    let mid = message
                        .pointer("/info/id")
                        .or_else(|| message.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("restored-head-{index}"));
                    if message.get("info").is_some_and(Value::is_object)
                        && message.pointer("/info/id").is_none()
                    {
                        // Synthetic heads have no transcript id. This id is only
                        // temporary decoder input; the published bytes stay unchanged.
                        message["info"]["id"] = json!(mid);
                    }
                    let mut entry = decoded_entry(
                        codec,
                        &InboundMessage {
                            ordinal: 0,
                            mid,
                            message,
                        },
                    )?;
                    entry.ck.meta.synthetic = true;
                    entry.ck.meta.ordinal = None;
                    decoded.push(entry.ck);
                }
                let prefix = candidate
                    .replacement
                    .iter()
                    .take_while(|message| message.meta.synthetic)
                    .count();
                candidate.replacement.splice(..prefix, decoded);
                engine.last_produced = Some(candidate.clone());
                if engine
                    .last_applied
                    .as_ref()
                    .is_some_and(|view| view.version == candidate.version)
                {
                    engine.last_applied = Some(candidate.clone());
                }
            }
        }
        // The cut covers the leading replace ranges the history head made, not
        // a removed message that may follow them.
        state.fold_entries(codec, None)?;
        let cut_first = coverage
            .and_then(|through| through.checked_add(1))
            .filter(|first| *first > state.lineage_first_ordinal);
        if let Some(first) = cut_first {
            if let Some(signature) = crate::tail_hygiene::signature::SignaturePrefix::capture(
                first,
                template
                    .logical_prefix
                    .as_ref()
                    .and_then(|prefix| prefix.signature_prefix.as_ref()),
                &output.engine.projection,
            ) {
                state.cut_signature = Some(signature);
            }
        }
        let shaped = emptied_messages::shape(codec, &kept, &state.frozen_edits, ranges);
        let mut ranges = shaped.ranges;
        if let Some(first) = cut_first {
            // Empty window replacements can coalesce with the history head
            // during shaping. Keep the cut at an explicit range boundary.
            cut_runtime::split_head_at(&mut ranges, first);
        }
        let version = store
            .reserve_async_compaction_version(&state.reference(), state.applied.unwrap_or(0))
            .map_err(transient)?;
        let (last_ordinal, last) = state.entries.last_key_value().expect("nonempty transcript");
        let mut view = view::CompactionView::new(
            state.reference(),
            version,
            state.lineage.as_deref().unwrap_or_default(),
            compact::lineage::MessageRef {
                ordinal: *last_ordinal,
                mid: last.mid.clone(),
            },
            ranges,
        )
        .with_cache_ttl(state.cache_ttl());
        if let Some(first) = cut_first {
            view = view.with_cut(view::ViewCut::new(format!("v{version}"), first - 1));
        }
        if view.cut.is_some() && view.check().is_err_and(|error| error.name() == "cut") {
            // A native arc may keep a covered source row live. That view is
            // still useful, but it cannot remove the row with a cut yet.
            #[cfg(test)]
            cut_runtime::measurements::deferred(store, "cut_view_shape");
            view.cut = None;
            view.digest = view.compute_digest();
        }
        let mut view = match checked_async_view(view, codec, &kept)? {
            Ok(view) => view,
            Err(splits) => {
                // Defence in depth: publish nothing on this pass, exactly as
                // when the engine does not permit a rebuild, and keep a
                // restored head for the next permitted pass.
                tracing::warn!(session_ref=%state.reference(), version, splits=?splits, reason="tool_pair_split", "async view withheld: it would separate a tool call from its result");
                #[cfg(test)]
                tool_arcs::withheld::record(&state.reference(), &splits);
                state.restored_head = restored_head;
                state.adopt_engine(engine)?;
                return Ok(None);
            }
        };
        // Bind edits to the source as it existed at publication. A delayed
        // acknowledgement may arrive after the runner has rewritten those mids.
        let mut frozen_edits = frozen_edits::FrozenEdits::default();
        frozen_edits.capture(&view, &state.entries)?;
        frozen_edits.capture_edits(&shaped.removed, &state.entries)?;
        frozen_edits.stamp_version(version);
        #[derive(Serialize)]
        struct PublishedEngine<'a> {
            #[serde(flatten)]
            view: &'a transform::compaction::View,
            native_frozen_edits: &'a frozen_edits::FrozenEdits,
            history_through: Option<u64>,
            publication_lineage: &'a str,
        }
        let engine_json: Arc<str> = serde_json::to_string(&PublishedEngine {
            view: &candidate,
            native_frozen_edits: &frozen_edits,
            history_through: coverage,
            publication_lineage: &view.lineage_id,
        })
        .map_err(transient)?
        .into();
        store
            .save_async_compaction_view(
                &state.reference(),
                version,
                &serde_json::to_string(&view).map_err(transient)?,
                &engine_json,
            )
            .map_err(transient)?;
        state.published_engine.insert(
            version,
            EngineView::with_json(&candidate, Arc::clone(&engine_json))
                .with_frozen_edits(frozen_edits)
                .with_publication_lineage(view.lineage_id.clone()),
        );
        // The produced baseline is this published view; adopting after the
        // insert shares its serialized form instead of serializing it again.
        state.adopt_engine(engine)?;
        if let Some(first) = cut_first.filter(|_| view.cut.is_some()) {
            state.keep_published_cut(store, codec, first, &view)?;
            if state
                .published_cuts
                .get(&cut_runtime::cut_key(first, &view.lineage_id))
                .is_none_or(|cut| cut.version != version)
            {
                // A bounded prelude or another cut guard may defer the marker.
                // The unannounced view still publishes; only the cut is removed.
                view.cut = None;
                view.digest = view.compute_digest();
                store
                    .revise_unannounced_async_compaction_view(
                        &state.reference(),
                        version,
                        &serde_json::to_string(&view).map_err(transient)?,
                    )
                    .map_err(transient)?;
            }
        }
        Ok(Some(view))
    }

    pub(super) async fn async_view_get(
        &self,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: view::ViewGetRequest = decode(params)?;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(state) = load_head(store, &request.session_ref)? else {
            return bytes(
                &json!({"answer":"refuse","code":"unknown_session","reason":"Unknown async conversation"}),
            );
        };
        self.authorize_async(binding, &state)?;
        if state.active_seed_is_unsafe(store)? {
            return bytes(
                &json!({"answer":"refuse","code":"unsafe_cut_seed","reason":"Set up a fresh full lineage before reading views."}),
            );
        }
        match store
            .load_async_compaction_view(&request.session_ref, request.view_version)
            .map_err(transient)?
        {
            Some(raw) => {
                let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
                bytes(&view::ViewGetAnswer::view(view))
            }
            None => bytes(
                &json!({"answer":"refuse","code":"unknown_version","reason":"Unknown immutable view version"}),
            ),
        }
    }

    fn authorize_async(
        &self,
        binding: &SessionBinding,
        state: &State,
    ) -> Result<(), HandlerOutcome> {
        // Only the attested runner owns the conversation; the route's folder
        // spelling is metadata and may differ from the one Setup arrived on.
        if records::attested_runner(binding) != Some(state.key.runner.as_str()) {
            return Err(invalid_field(
                "session_ref",
                "async conversation is owned by another runner",
            ));
        }
        Ok(())
    }

    pub(super) async fn async_ride(
        &self,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: ride::RideRequest = decode(params)?;
        request
            .check()
            .map_err(|e| invalid_field("deadline_ms", e.name()))?;
        if matches!(request.cause, ride::RideCause::Unknown(_)) {
            return bytes(&ride::RideAnswer::nothing());
        }
        let started = Instant::now();
        let budget = Duration::from_millis(request.deadline_ms);
        let fallback_ttl = self
            .store
            .get()
            .map(|store| load_head(store, &request.session_ref))
            .transpose()?
            .flatten()
            .map(|state| state.cache_ttl());
        let work = async {
            let store = self
                .store
                .get()
                .ok_or_else(|| transient("store unavailable"))?;
            let Some(mut state) = load_head(store, &request.session_ref)? else {
                return bytes(&ride::RideAnswer::nothing());
            };
            self.authorize_async(binding, &state)?;
            if let Some(failure) = state.failure.as_ref().filter(|_| state.failed()) {
                return Err(HandlerOutcome::ErrorWithDetail {
                    code: FAILED_ERROR.into(),
                    message: format!("async compaction failed: {}", failure.reason),
                    detail: serde_json::to_value(failure).map_err(transient)?,
                });
            }
            let _serial = if matches!(request.cause, ride::RideCause::Ceiling) {
                self.provider_serial.lock_for(&state.key).await
            } else {
                let Ok(guard) = self.provider_serial.try_lock_for(&state.key) else {
                    return bytes(&ride::RideAnswer::nothing().with_cache_ttl(state.cache_ttl()));
                };
                guard
            };
            state = self
                .checkout(store, &request.session_ref)?
                .ok_or_else(|| transient("async session disappeared"))?;
            // An offline-prepared record serves nothing until a notice has
            // checked it against the runner's transcript.
            if state.resync || state.offline_first_pass.is_some() {
                let answer = ride::RideAnswer::nothing().with_cache_ttl(state.cache_ttl());
                self.checkin(state);
                return bytes(&answer);
            }
            let from = state.read_from();
            if matches!(request.cause, ride::RideCause::Ceiling)
                && self
                    .read_async(&mut state, from, budget.saturating_sub(started.elapsed()))
                    .await
                    .is_err()
            {
                state.reset(store)?;
                state.save(store, &[])?;
                return bytes(&ride::RideAnswer::nothing());
            }
            let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
            if matches!(request.cause, ride::RideCause::Ceiling) {
                if let Some(fact) = ride_overflow(&request) {
                    apply_ride_overflow(&mut state, fact);
                }
            }
            state.reindex()?;
            let rows = state.unsaved_tag_rows(codec)?;
            state.save(store, &rows)?;
            let worker = self.provider_historian_worker();
            let cache_ttl = state.cache_ttl();
            let store = Arc::clone(store);
            let reference = request.session_ref.clone();
            let view = tokio::task::spawn_blocking(move || {
                let _serial = _serial;
                let view = match worker.publish_async(0, &mut state, codec, true) {
                    Ok(view) => view,
                    Err(error) => {
                        drop(state);
                        worker.mark_engine_failed(&store, &reference)?;
                        return Err(error);
                    }
                };
                state.engine_failed = false;
                state.save(&store, &[])?;
                worker.checkin(state);
                Ok::<_, HandlerOutcome>(view)
            })
            .await
            .map_err(transient)??;
            self.announce_async_views().await?;
            match view {
                Some(view) => bytes(&ride::RideAnswer::view(view).with_cache_ttl(cache_ttl)),
                None => bytes(&ride::RideAnswer::nothing().with_cache_ttl(cache_ttl)),
            }
        };
        tokio::time::timeout(budget, work)
            .await
            .unwrap_or_else(|_| {
                bytes(&match fallback_ttl {
                    Some(ttl) => ride::RideAnswer::nothing().with_cache_ttl(ttl),
                    None => ride::RideAnswer::nothing(),
                })
            })
    }
}

impl McHandler {
    pub(super) async fn async_reduce(
        &self,
        binding: &SessionBinding,
        requested: &[u64],
    ) -> Result<HandlerOutcome, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = route_records(store, binding)?;
        if rows.len() != 1 {
            return Err(session_unresolved_error());
        }
        let state: State = serde_json::from_str(&rows[0]).map_err(transient)?;
        let _serial = self.provider_serial.lock_for(&state.key).await;
        let mut state = self
            .checkout(store, &state.reference())?
            .ok_or_else(|| transient("async session disappeared"))?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let resolve = |state: &State| -> Result<_, HandlerOutcome> {
            let mut targets = Vec::new();
            let mut unknown = Vec::new();
            for number in requested {
                #[cfg(test)]
                let row = if self.async_oracle() {
                    tag_rows(state, codec)?
                        .into_iter()
                        .find(|row| u64::try_from(row.tag_number).ok() == Some(*number))
                } else {
                    tag_row(state, codec, *number)?
                };
                #[cfg(not(test))]
                let row = tag_row(state, codec, *number)?;
                match row {
                    Some(row) => targets.push(row.block_id),
                    None => unknown.push(*number),
                }
            }
            Ok((targets, unknown))
        };
        let (mut targets, mut unknown) = resolve(&state)?;
        // A tag from below the conversation's cut is already in the history
        // summary: its content is out of the model's context, so there is
        // nothing to drop and nothing is queued.
        let summarized = state.cut_seed.as_ref().map_or_else(Vec::new, |seed| {
            unknown
                .iter()
                .copied()
                .filter(|number| seed.tagged_below(*number))
                .collect::<Vec<_>>()
        });
        unknown.retain(|number| !summarized.contains(number));
        let mut catch_up_failed = false;
        if !unknown.is_empty() {
            // A tag can reach the model before its change notice reaches us.
            // Re-read the inclusive tail under the same serial as notices so
            // the cursor, lineage checks and persisted indexes move together.
            let from = state.read_from();
            let budget = Duration::from_secs(2);
            catch_up_failed = state.resync
                || !matches!(
                    tokio::time::timeout(budget, self.read_async(&mut state, from, budget)).await,
                    Ok(Ok(()))
                )
                || state.ingest_read(store, codec).is_err();
            if !catch_up_failed {
                (targets, unknown) = resolve(&state)?;
                unknown.retain(|number| !summarized.contains(number));
            }
        }
        let namespace = state.namespace();
        if !catch_up_failed {
            self.checkin(state);
        }
        // A failed read may have added an incomplete page. Discard that
        // resident copy; the next notice or tool call reloads the saved cursor.
        let details = if catch_up_failed {
            format!(
                "Retry ctx_reduce for tags {}: transcript catch-up could not complete; these tags could not be checked yet.",
                format_plain_tag_numbers(&unknown)
            )
        } else {
            [
                ctx_reduce_ack_details(&unknown),
                ctx_reduce_summarized_details(&summarized),
            ]
            .into_iter()
            .filter(|detail| !detail.is_empty())
            .collect::<Vec<_>>()
            .join("; ")
        };
        if targets.is_empty() && unknown.is_empty() && !summarized.is_empty() && !catch_up_failed {
            return Ok(mcp_text_result(
                format!(
                    "Nothing to drop: tags {} are already in the history summary.",
                    format_plain_tag_numbers(&summarized)
                ),
                false,
            ));
        }
        if targets.is_empty() {
            return Ok(tool_error_result(if catch_up_failed {
                details
            } else {
                format!("Refused: no valid tags to queue. {details}")
            }));
        }
        store
            .append_pending_agent_drops_with_command(&namespace, None, &targets, now_ms(), false)
            .map_err(transient)?;
        Ok(mcp_text_result(
            format!("{} {}", ctx_reduce_reply(targets.len(), 0), details),
            false,
        ))
    }
}

struct AsyncHistoryFence {
    reference: String,
    generation: u64,
    key: Key,
    serial: Arc<ProviderSerial>,
}

impl AsyncHistoryFence {
    /// The caller holds the conversation serial through source preparation.
    fn prepare_input(
        &self,
        store: &McStore,
        window: historian_tail::InputWindow,
        codec: codec::Codec,
        parsed: &mut TransformRequest,
        echoes: &reminder_echoes::ReminderEchoes,
        prelude: Option<&cut_seed::HistorianPrelude>,
    ) -> Result<ck_wire::FlatProjection, HandlerOutcome> {
        let head = load_head(store, &self.reference)?
            .ok_or_else(|| transient("async conversation disappeared"))?;
        if head.generation != self.generation || head.resync {
            return Err(transient("async historian lineage changed"));
        }
        let projection = historian_tail::prepare_cut_input(
            store,
            &self.reference,
            window,
            codec,
            parsed,
            echoes,
            prelude,
        )?;
        let version = store
            .load_meta(&parsed.session_id)
            .map_err(transient)?
            .row_version
            .ok_or_else(|| transient("async historian cache state missing"))?;
        // Notices can skip the transform that normally records identities.
        // Fill the whole held window before preparation: runner-limit refitting
        // can expand selection. Existing vectors belong to the publication fence.
        store
            .commit_missing_block_identities(
                &parsed.session_id,
                version,
                &projection.identity_by_mid,
            )
            .map_err(transient)?;
        Ok(projection)
    }
}

/// How long a history publication waits for the conversation lock. Notices,
/// `late_results` polls and `ctx_reduce` hold that lock briefly; a summary that
/// took minutes to produce must not be thrown away because one of them was
/// running at the moment it landed.
const ASYNC_PUBLICATION_LOCK_WAIT: Duration = Duration::from_secs(30);

/// What [`AsyncHistoryFence::admit`] obtained for the publication that follows.
enum AsyncPublicationAdmission {
    Held {
        _guard: tokio::sync::OwnedMutexGuard<()>,
    },
    LockBusy,
}

impl crate::historian::HistorianPublicationFence for AsyncHistoryFence {
    fn publish(
        &self,
        store: &McStore,
        request: mc_store::HistorianPublishRequest<'_>,
    ) -> Result<mc_store::HistorianPublishResult, mc_store::HistorianPublishError> {
        crate::historian::HistorianPublicationFence::publish_admitted(self, store, request, None)
    }

    fn admit(
        &self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<crate::historian::PublicationAdmission>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async move {
            let admission = match tokio::time::timeout(
                ASYNC_PUBLICATION_LOCK_WAIT,
                self.serial.lock_for(&self.key),
            )
            .await
            {
                Ok(guard) => AsyncPublicationAdmission::Held { _guard: guard },
                Err(_) => AsyncPublicationAdmission::LockBusy,
            };
            Some(Box::new(admission) as crate::historian::PublicationAdmission)
        })
    }

    fn publish_admitted(
        &self,
        store: &McStore,
        request: mc_store::HistorianPublishRequest<'_>,
        admission: Option<&crate::historian::PublicationAdmission>,
    ) -> Result<mc_store::HistorianPublishResult, mc_store::HistorianPublishError> {
        // Reasons stay short: the person sees them inside a status line that is
        // cut at 120 characters.
        let reject = |reason: String| mc_store::HistorianPublishError::FenceRejected { reason };
        // The lock keeps a notice from resetting or forking the conversation
        // between the check below and the write.
        let _serial = match admission.and_then(|admission| admission.downcast_ref()) {
            Some(AsyncPublicationAdmission::Held { .. }) => None,
            Some(AsyncPublicationAdmission::LockBusy) => {
                return Err(reject(format!(
                    "conversation lock held over {}s",
                    ASYNC_PUBLICATION_LOCK_WAIT.as_secs()
                )));
            }
            // A caller that could not wait asynchronously gets one attempt.
            None => Some(
                self.serial
                    .try_lock_for(&self.key)
                    .map_err(|_| reject("conversation lock busy".into()))?,
            ),
        };
        let state = load_head(store, &self.reference)
            .map_err(|error| reject(format!("conversation unreadable: {error:?}")))?
            .ok_or_else(|| reject("conversation disappeared".into()))?;
        if state.generation != self.generation {
            return Err(reject(format!(
                "lineage changed (generation {} to {})",
                self.generation, state.generation
            )));
        }
        if state.resync {
            return Err(reject("conversation is resyncing".into()));
        }
        store.publish_historian_chunk(request)
    }
}

impl McHandler {
    fn schedule_async_historian(&self, state: &State) -> Result<(), HandlerOutcome> {
        if state.engine.preset != transform::compaction::Preset::Head {
            return Ok(());
        }
        if self
            .wrapup_sessions
            .lock()
            .expect("wrapup sessions mutex")
            .contains_key(&state.namespace())
        {
            return Ok(());
        }
        #[cfg(test)]
        self.provider_store
            .async_runtime
            .historian_evaluations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let binding = self.async_binding(state);
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut parsed = self.async_historian_request(state)?;
        // Use ModuleMeta's baseline coverage: a newly stored compartment may
        // not have been folded into that baseline yet. Start early enough to
        // pair tool results after coverage with their original tool calls.
        let (coverage, from) = historian_tail::applied_window(
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?,
            &state.namespace(),
            &state.aggregates.historian_input,
        )?;
        let through = state.entries.last_key_value().map(|(ordinal, _)| *ordinal);
        if through.is_some_and(|through| state.journal.persisted_through != Some(through)) {
            return Err(transient(
                "async historian scheduled before its entries were stored",
            ));
        }
        let store = Arc::clone(
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?,
        );
        let worker = self.provider_historian_worker();
        let fence = Arc::new(AsyncHistoryFence {
            reference: state.reference(),
            generation: state.generation,
            key: state.key.clone(),
            serial: Arc::clone(&self.provider_serial),
        });
        let reference = state.reference();
        let namespace = state.namespace();
        let session_model = state.setup.model.clone();
        let key = state.key.clone();
        let generation = state.generation;
        let cadence = state.historian_cadence.clone();
        let settings = self.historian_settings_loader()(state.project());
        let harness = state.key.harness.clone();
        let reminder_echoes = state.reminder_echoes.clone();
        let historian_seed = state.cut_seed.clone();
        #[cfg(test)]
        let inflight = {
            struct Inflight(Arc<std::sync::atomic::AtomicU64>);
            impl Drop for Inflight {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            let counter = Arc::clone(&self.provider_store.async_runtime.historian_inflight);
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Inflight(counter)
        };
        tokio::spawn(async move {
            #[cfg(test)]
            let _inflight = inflight;
            let configured = super::historian_config::resolve_with_model_catalog(
                &settings,
                &harness,
                Some(&session_model),
                &binding.project_root,
                &worker.historian_model_catalog,
            )
            .await;
            log_session_model_fallback(&namespace, &configured);
            parsed.historian_model_limits = configured.model_limits;
            let prepare = worker.clone();
            let serial = worker.provider_serial.lock_for(&key).await;
            let result = tokio::task::spawn_blocking(move || {
                let _serial = serial;
                let projection = fence.prepare_input(
                    &store,
                    from.through(through),
                    codec,
                    &mut parsed,
                    &reminder_echoes,
                    historian_seed
                        .as_ref()
                        .and_then(|seed| seed.historian_prelude.as_ref()),
                )?;
                let mut timings = HistorianTriggerTimings::default();
                Ok::<_, HandlerOutcome>(prepare.prepare_historian_fire(
                    store,
                    &parsed,
                    &binding,
                    &binding.project_root.to_string_lossy(),
                    &projection,
                    HistorianPrepareContext {
                        rust_background_enabled: None,
                        now: now_ms(),
                        publication_fence: Some(fence),
                        tag_snapshot: None,
                        async_coverage: Some(coverage),
                        reclaim_ride_available: false,
                        runner_lane: true,
                        timings: &mut timings,
                    },
                ))
            })
            .await;
            match result {
                Ok(Ok(PreparedHistorianAction::FireReady(prepared))) => {
                    if let Err(error) = worker
                        .finish_async_historian_evaluation(&reference, generation, &cadence)
                        .await
                    {
                        tracing::warn!(?error, "async historian cadence save failed");
                    }
                    let completion = worker.live_historian_completion_wait(&namespace);
                    worker.spawn_historian_firing(prepared.task);
                    if let Some(completion) = completion {
                        completion.await;
                    }
                    if let Err(error) = worker.publish_async_wake(&reference).await {
                        tracing::warn!(?error, "async historian view publication failed");
                    }
                }
                Ok(Ok(PreparedHistorianAction::Busy { completion, .. })) => {
                    completion.await;
                    if let Some(store) = worker.store.get() {
                        if let Ok(Some(head)) = load_head(store, &reference) {
                            if head.historian_pending {
                                let _serial = worker.provider_serial.lock_for(&head.key).await;
                                if let Ok(Some(state)) = worker.checkout(store, &reference) {
                                    if state.historian_pending {
                                        let _ = worker.schedule_async_historian(&state);
                                    }
                                    worker.checkin(state);
                                }
                            }
                        }
                    }
                }
                Ok(Ok(PreparedHistorianAction::Complete(_))) => {
                    if let Err(error) = worker
                        .finish_async_historian_evaluation(&reference, generation, &cadence)
                        .await
                    {
                        tracing::warn!(?error, "async historian cadence save failed");
                    }
                }
                Ok(Err(error)) => tracing::warn!(?error, "async historian evaluation failed"),
                Err(error) => tracing::warn!(%error, "async historian worker failed"),
            }
        });
        Ok(())
    }

    fn async_historian_request(&self, state: &State) -> Result<TransformRequest, HandlerOutcome> {
        let mut request = self.async_historian_fields(state);
        request["v"] = json!(2);
        request["kind"] = json!("compaction.async");
        request["session_id"] = json!(state.namespace());
        request["render_config"] = json!("async-provider");
        request["messages"] = json!([]);
        let notice = state
            .conditions
            .as_ref()
            .map(notice::AdvanceNotice::from_headers)
            .transpose()
            .map_err(|e| transient(e.name()))?;
        request["model_key"] = json!(notice
            .as_ref()
            .map(|n| n.model.as_str())
            .unwrap_or(&state.setup.model));
        if let Some(notice) = &notice {
            request["usage"] = serde_json::to_value(mc_store::ModuleUsage {
                current_total_input_tokens: notice.est_tokens,
                context_limit_tokens: notice.window.or(state.setup.context_window).unwrap_or(0),
                ..Default::default()
            })
            .map_err(transient)?;
        }
        decode(&request)
    }

    fn async_historian_fields(&self, state: &State) -> Value {
        let settings = self.historian_settings_loader()(state.project());
        Value::Object(
            super::historian_config::resolve_for_session(
                &settings,
                &state.key.harness,
                Some(&state.setup.model),
            )
            .request_fields(),
        )
    }
}

impl McHandler {
    fn advance_async_policy(
        &self,
        state: &mut State,
        notice: &notice::AdvanceNotice,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let conditions = super::usage_policy::UsageConditions {
            est_tokens: notice.est_tokens,
            window: notice.window.or(state.setup.context_window).unwrap_or(0),
            model: notice.model.clone(),
            last_usage: notice
                .last_usage
                .as_ref()
                .map(|usage| super::usage_policy::LastUsage {
                    input: Some(usage.input),
                    cache_read: Some(usage.cache_read),
                    cache_write: Some(usage.cache_write),
                    output: Some(usage.output),
                    completed_at: None,
                    finish_reason: None,
                }),
            provider_error: None,
        };
        let (policy, _) = super::usage_policy::advance(
            &state.usage_policy.clone().unwrap_or_default(),
            &conditions,
            state.engine.preset == transform::compaction::Preset::Head,
        );
        state.usage_policy = Some(policy);
        let mut scan = state.todo_scan.clone().unwrap_or_default();
        let lineage = state.lineage.clone().unwrap_or_default();
        // The scan skips messages at or before its cursor, so it needs only
        // the newer ones; a scan for another lineage restarts from the first.
        let todo_through = if scan.lineage == lineage {
            scan.through
        } else {
            // Replaying a fork must not keep a todo owned by a removed row.
            // Start with the immutable pre-cut snapshot, then scan the window.
            let store = self
                .store
                .get()
                .ok_or_else(|| transient("store unavailable"))?;
            let loaded = store.load_meta(&state.namespace()).map_err(transient)?;
            let mut meta = loaded.meta;
            let seed = if state
                .entries
                .first_key_value()
                .is_some_and(|(n, _)| *n == 0)
            {
                None
            } else {
                state.recovery_seed(store)?
            };
            let todo = seed.as_ref().and_then(|seed| seed.todo.as_ref());
            meta.last_todo_state = todo.map(|todo| todo.state_json.clone());
            meta.last_todo_state_owner_message_id = todo.map(|todo| todo.owner_message_id.clone());
            meta.last_todo_state_hash = todo.map(|todo| todo.state_hash.clone());
            store
                .commit_meta(&state.namespace(), loaded.row_version, &meta)
                .map_err(transient)?;
            None
        };
        let messages = state.fold_entries(codec, Some(todo_through))?;
        if let Some(todo) = scan.advance(&lineage, &messages) {
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?
                .set_todo_state(
                    &state.namespace(),
                    &todo.state_json,
                    &todo.owner_message_id,
                    &todo.state_hash,
                )
                .map_err(transient)?;
        }
        state.todo_scan = Some(scan);
        Ok(())
    }
}

impl AsyncRecord {
    /// Validate and index the held entries not yet in `tag_index`. Held
    /// entries never change, so each is validated and digested once; a tag
    /// already held by an earlier entry is refused as reuse.
    fn reindex(&mut self) -> Result<(), HandlerOutcome> {
        let from = self
            .journal
            .indexed_through
            .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        let mut index = BTreeMap::new();
        for entry in self
            .entries
            .range((from, std::ops::Bound::Unbounded))
            .map(|(_, entry)| entry)
        {
            let entry = entry.read()?;
            self.mid_index
                .entry(entry.mid.clone())
                .or_insert(entry.ordinal);
            let native = parts(&entry.message)?;
            if native.len() != entry.tags.len() {
                return Err(invalid_field(
                    "tags",
                    "one row per exposed part is required",
                ));
            }
            let mut keys = BTreeSet::new();
            for row in &entry.tags {
                if row.part.is_empty() || row.part.len() > 256 || !keys.insert(&row.part) {
                    return Err(invalid_field(
                        "tags",
                        "part keys must be distinct, nonempty and at most 256 bytes",
                    ));
                }
                if let Some(tag) = &row.tag {
                    if tags::parse_tag(tag).is_none() {
                        return Err(invalid_field("tags", "malformed runner tag"));
                    }
                    let address = PartAddress {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        part: row.part.clone(),
                        digest: served_part_digest(&entry, &row.part)?,
                    };
                    if self.tag_index.contains_key(tag)
                        || index.insert(tag.clone(), address).is_some()
                    {
                        return Err(invalid_field("tags", "runner reused a tag"));
                    }
                }
            }
        }
        self.tag_index.extend(index);
        if let Some((last, _)) = self.entries.last_key_value() {
            self.journal.indexed_through = Some(*last);
        }
        Ok(())
    }
}

impl McHandler {
    fn resident_cache(&self) -> std::sync::MutexGuard<'_, resident::ResidentCache> {
        self.provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether this handler runs the full-recompute path: every operation
    /// rebuilds the conversation from rows, every notice runs the engine and
    /// every aggregate is a full scan. Tests compare it against the resident
    /// path.
    #[cfg(test)]
    pub(super) fn async_oracle(&self) -> bool {
        self.resident_cache().oracle
    }

    #[cfg(not(test))]
    fn async_oracle(&self) -> bool {
        false
    }

    fn async_input_oracle(&self) -> bool {
        #[cfg(test)]
        if self
            .provider_store
            .async_runtime
            .full_input_only
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return true;
        }
        self.async_oracle()
    }

    /// Take a conversation for one operation. Call only under its provider
    /// lock. The resident copy is used when the store still holds exactly the
    /// record it was saved or loaded with; otherwise it is rebuilt from rows.
    /// Hand it back with `checkin` after the operation's last save.
    fn checkout(&self, store: &McStore, reference: &str) -> Result<Option<State>, HandlerOutcome> {
        let Some(stored) = store.load_async_compaction(reference).map_err(transient)? else {
            self.resident_cache().forget(reference);
            return Ok(None);
        };
        if let Some(state) = self.resident_cache().take(reference, &stored) {
            return Ok(Some(state));
        }
        load(store, reference)
    }

    /// Record on the stored conversation that its engine pass failed, from
    /// the stored record: the operation's own copy is part-way through and
    /// is discarded. Call only under the conversation's provider lock.
    fn mark_engine_failed(&self, store: &McStore, reference: &str) -> Result<(), HandlerOutcome> {
        let Some(mut state) = self.checkout(store, reference)? else {
            return Ok(());
        };
        if !state.engine_failed {
            state.engine_failed = true;
            state.save(store, &[])?;
        }
        self.checkin(state);
        Ok(())
    }

    /// Keep a conversation resident after an operation whose last save
    /// succeeded (or that changed nothing).
    fn checkin(&self, state: State) {
        self.resident_cache().put(state);
    }

    /// Skip only when neither prefix work nor durable command bookkeeping
    /// needs an engine pass. A no-op can still retire an already-satisfied drop.
    fn async_engine_can_skip(
        &self,
        state: &State,
        notice: &notice::AdvanceNotice,
    ) -> Result<bool, HandlerOutcome> {
        #[cfg(test)]
        if self.async_oracle() {
            return Ok(false);
        }
        if state.resync || state.entries.is_empty() {
            return Ok(true);
        }
        if state.pending_parent_history.is_some() {
            return Ok(false);
        }
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let namespace = state.namespace();
        let window = state
            .usage_policy
            .as_ref()
            .and_then(|policy| policy.limit_for(&notice.model))
            .or(notice.window.or(state.setup.context_window))
            .ok_or_else(|| invalid("window unknown"))?;
        let model = state
            .conditions
            .as_ref()
            .and_then(|headers| headers.get("model"))
            .map(String::as_str)
            .unwrap_or(&state.setup.model);
        let meta = store.load_meta(&namespace).map_err(transient)?.meta;
        let binding = self.async_binding(state);
        let config = &binding.config;
        let usage = notice.est_tokens as f64 * 100.0 / window.max(1) as f64;
        let policy = state.usage_policy.as_ref();
        let blockers = [
            (
                usage >= config.resolve_execute_threshold(Some(model)).percentage,
                "execute_threshold",
            ),
            (usage >= 85.0, "force_band"),
            (usage >= 95.0 || meta.emergency_drain_active, "emergency"),
            (
                policy.is_some_and(|policy| policy.emergency_recovery_armed),
                "emergency_recovery_armed",
            ),
            (!meta.initialized, "uninitialized"),
            (meta.soft_refresh_pending, "soft_refresh_pending"),
            (meta.pending_rewrite.is_some(), "pending_rewrite"),
            (
                meta.bootstrap_seed_fold_pending,
                "bootstrap_seed_fold_pending",
            ),
            (
                meta.deferred_execute_state.is_some(),
                "deferred_execute_state",
            ),
            (
                meta.pending_compaction_marker.is_some(),
                "pending_compaction_marker",
            ),
            (
                meta.boundary_divergence_pending_count > 0,
                "boundary_divergence",
            ),
            (
                !meta.reasoning_clear_initialized,
                "reasoning_clear_uninitialized",
            ),
            (meta.last_model_key != model, "model_changed"),
            (state.engine_failed, "previous_engine_pass_failed"),
            (state.restored_head.is_some(), "restored_head"),
            (
                state.engine.preset != transform::compaction::Preset::Head,
                "subagent_preset",
            ),
            // The engine refuses a range that cuts a tool arc; run it so the
            // notice fails the same way.
            (
                state.aggregates.through != state.entries.last_key_value().map(|(n, _)| *n),
                "unfolded_entries",
            ),
            (
                !state.aggregates.open_calls.is_empty() || state.aggregates.orphan_result,
                "open_tool_arc",
            ),
        ];
        #[cfg(test)]
        let _facts_phase =
            scaling_tests::save_meter::start_kind(&state.reference(), "phase:skip_meta");
        if let Some((_, reason)) = blockers.iter().find(|(blocks, _)| *blocks) {
            #[cfg(test)]
            resident::counters::engine_reason(reason);
            let _ = reason;
            return Ok(false);
        }
        let pending = store
            .load_pending_agent_drops(&namespace)
            .map_err(transient)?;
        if !pending.is_empty() {
            let covered = pending.iter().any(|drop| {
                ck_wire::split_block_id(&drop.target_id)
                    .and_then(|(mid, _)| state.mid_index.get(mid))
                    .is_some_and(|ordinal| meta.coverage_ordinal.is_some_and(|end| *ordinal <= end))
            });
            let targets = pending
                .iter()
                .map(|drop| drop.target_id.as_str())
                .collect::<std::collections::HashSet<_>>();
            // The trigger's shape summary names unit classes, not target ids.
            // Retirement requires the validated frozen target keys themselves.
            let frozen = !covered
                && store
                    .load_logical_transform_snapshot(&namespace, &[])
                    .map_err(transient)?
                    .loaded
                    .core
                    .frozen_units
                    .iter()
                    .any(|unit| {
                        unit.key
                            .strip_prefix("red:")
                            .is_some_and(|target| targets.contains(target))
                    });
            // Retirement changes the durable command queue even when no view
            // can publish. Leaving a covered/satisfied command queued can
            // incorrectly apply it after a later coverage rewind or restore.
            if covered || frozen {
                #[cfg(test)]
                resident::counters::engine_reason("retire_satisfied_drop");
                return Ok(false);
            }
        }
        // Build the producer context exactly as `async_engine` does for its
        // engine pass, so the preflight sees the inputs the pass would.
        let work = self.provider_work(0, store, binding.clone(), state.key.clone())?;
        let mut context = compaction::producer_context(&work, model, window, false);
        context.cache_ttl = "never".into();
        let facts = transform::compaction::skip_facts_with(
            store, &namespace, &context, model, window, true,
        )
        .map_err(transient)?;
        let skip = facts
            .as_ref()
            .is_some_and(transform::compaction::can_skip_classified);
        #[cfg(test)]
        if skip {
            resident::counters::engine_pass_skipped();
        }
        #[cfg(test)]
        if !skip {
            let units = store
                .load_compaction_trigger_core(&namespace)
                .ok()
                .flatten()
                .map(|core| {
                    core.frozen_units
                        .iter()
                        .map(|unit| unit.key.split(':').next().unwrap_or_default().to_owned())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();
            resident::counters::engine_reason(&format!(
                "classifier {facts:?} units={units:?} protected={:?} seed={} rewrite={}",
                meta.protected_tokens_effective,
                meta.bootstrap_seed_fold_pending,
                meta.pending_rewrite.is_some()
            ));
        }
        Ok(skip)
    }

    async fn publish_async_wake(&self, reference: &str) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load_head(store, reference)? else {
            return Ok(());
        };
        let _serial = self.provider_serial.lock_for(&state.key).await;
        state = self
            .checkout(store, reference)?
            .ok_or_else(|| transient("async session disappeared"))?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        self.publish_async(0, &mut state, codec, false)?;
        state.save(store, &[])?;
        self.checkin(state);
        drop(_serial);
        self.announce_async_views().await
    }

    pub(crate) fn flush_async_compaction(
        &self,
        binding: &SessionBinding,
    ) -> Option<HandlerOutcome> {
        if binding.harness != session_resolver::RUNNER_BIND_HARNESS {
            return None;
        }
        let store = self.store.get()?;
        let rows = match route_records(store, binding) {
            Ok(rows) => rows,
            Err(error) => return Some(error),
        };
        if rows.is_empty() {
            return None;
        }
        if rows.len() != 1 {
            return Some(session_unresolved_error());
        }
        let state: State = match serde_json::from_str(&rows[0]) {
            Ok(state) => state,
            Err(error) => return Some(transient(error)),
        };
        match store.arm_soft_refresh(&state.namespace()) {
            Ok(armed) => {
                let worker = self.provider_historian_worker();
                let reference = state.reference();
                tokio::spawn(async move {
                    if let Err(error) = worker.publish_async_wake(&reference).await {
                        tracing::warn!(?error, "async flush view publication failed");
                    }
                });
                Some(respond(json!({"ok":true,"armed":armed})))
            }
            Err(error) => Some(transient(error)),
        }
    }
}

impl McHandler {
    pub(crate) fn async_compaction_namespace(
        &self,
        binding: &SessionBinding,
        allow_resync: bool,
    ) -> Result<Option<String>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = route_records(store, binding)?;
        match rows.as_slice() {
            [] => Ok(None),
            [raw] => {
                let state: State = serde_json::from_str(raw).map_err(transient)?;
                if state.resync && !allow_resync {
                    return Err(transient("async transcript resync in progress"));
                }
                Ok(Some(state.namespace()))
            }
            _ => Err(session_unresolved_error()),
        }
    }
}

impl AsyncRecord {
    fn restore_sources(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let Some(source) = &self.resync_sources else {
            return Ok(());
        };
        // Restoring sources after a resync is rare; it reads every held
        // message once.
        let held = self
            .entries
            .values()
            .map(|entry| entry.read())
            .collect::<Result<Vec<_>, _>>()?;
        let by_mid = held
            .iter()
            .map(|entry| (entry.mid.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut retained = Vec::new();
        let mut sequences = Vec::new();
        for history in &source.history {
            if self
                .cut_first_ordinal
                .is_some_and(|first| history.compartment.end_message < first as i64)
            {
                retained.push(history.compartment.clone());
                sequences.push((history.compartment.sequence, history.compartment.sequence));
                continue;
            }
            let mapped = history
                .messages
                .iter()
                .map(|old| {
                    by_mid
                        .get(old.mid.as_str())
                        .copied()
                        .filter(|entry| served_digest(entry).is_ok_and(|d| d == old.digest))
                })
                .collect::<Option<Vec<_>>>();
            let Some(mapped) = mapped.filter(|mapped| {
                !mapped.is_empty()
                    && mapped
                        .windows(2)
                        .all(|pair| pair[0].ordinal.checked_add(1) == Some(pair[1].ordinal))
            }) else {
                break;
            };
            let mut compartment = history.compartment.clone();
            let first = mapped.first().unwrap();
            let last = mapped.last().unwrap();
            if retained.is_empty()
                && self
                    .entries
                    .first_key_value()
                    .is_some_and(|(_, entry)| entry.mid != first.mid)
            {
                break;
            }
            if retained
                .last()
                .is_some_and(|prior: &mc_store::StoredCompartment| {
                    prior.end_message.checked_add(1) != Some(first.ordinal as i64)
                })
            {
                break;
            }
            compartment.start_message = if self.cut_seed.is_some() {
                compartment.start_message.min(first.ordinal as i64)
            } else {
                first.ordinal as i64
            };
            compartment.end_message = last.ordinal as i64;
            // The proof maps by message identity and checks its whole digest.
            // Keep the original boundary spelling too: changing `mid` to
            // `mid#0` would manufacture a history revision on the next write.
            sequences.push((history.compartment.sequence, compartment.sequence));
            retained.push(compartment);
        }
        self.repair_cut_history(store, &mut retained, None)?;
        let namespace = self.namespace();
        store
            .replace_compartments(&namespace, &retained)
            .map_err(transient)?;
        if let Some(seed) = self.recovery_seed(store)? {
            // Keep the covered boundary available even when an incomplete
            // tool arc makes the first engine pass wait for another message.
            let mut bootstrap = seed.as_ref().clone();
            bootstrap.window = Default::default();
            if let Some(last) = retained.last() {
                bootstrap.boundary_id = last.end_message_id.clone();
                bootstrap.compartment_seq = last.sequence;
            }
            self.initialize_cut_namespace(store, &bootstrap)?;
        }
        let copied = store
            .copy_async_history_artifacts(&source.namespace, &namespace, &sequences)
            .map_err(transient)?;
        let rows = tag_rows(self, codec)?;
        let mut transferred = 0;
        for drop in &source.drops {
            let matched = self.tag_index.iter().find(|(_, address)| {
                address.mid == drop.mid
                    && address.part == drop.part
                    && address.digest == drop.digest
            });
            let Some((tag, _)) = matched else {
                continue;
            };
            let Some(number) = tags::parse_tag(tag) else {
                continue;
            };
            let Some(row) = rows
                .iter()
                .find(|row| u64::try_from(row.tag_number).ok() == Some(number))
            else {
                continue;
            };
            store
                .append_pending_agent_drops(
                    &namespace,
                    std::slice::from_ref(&row.block_id),
                    drop.queued_at_ms,
                )
                .map_err(transient)?;
            transferred += 1;
        }
        store
            .clear_async_compaction_drops(&source.namespace)
            .map_err(transient)?;
        if let Some(head) = &source.head {
            let cut_supported = head
                .required_cut
                .as_ref()
                .is_none_or(|(first, mid, digest)| {
                    self.cut_seed.as_ref().is_some_and(|seed| {
                        seed.first_ordinal == *first
                            && seed.cut_mid == *mid
                            && seed.cut_digest == *digest
                    })
                });
            let mapped = head
                .messages
                .iter()
                .map(|old| {
                    by_mid
                        .get(old.mid.as_str())
                        .copied()
                        .filter(|entry| served_digest(entry).is_ok_and(|d| d == old.digest))
                })
                .collect::<Option<Vec<_>>>();
            if let Some(mapped) = mapped.filter(|mapped| {
                cut_supported
                    && (!mapped.is_empty() || head.required_cut.is_some())
                    && mapped
                        .windows(2)
                        .all(|pair| pair[0].ordinal.checked_add(1) == Some(pair[1].ordinal))
                    && mapped.first().is_none_or(|first| {
                        self.entries
                            .first_key_value()
                            .is_some_and(|(_, entry)| entry.mid == first.mid)
                    })
            }) {
                let to = mapped
                    .last()
                    .map(|entry| entry.ordinal + 1)
                    .unwrap_or_else(|| {
                        self.entries
                            .first_key_value()
                            .map_or(0, |(ordinal, _)| *ordinal)
                    });
                self.restored_head = Some(RestoredHead {
                    bytes: head.bytes.clone(),
                    to,
                });
            }
        }
        self.last_discarded_drops = source.queued_count.saturating_sub(transferred);
        self.last_transferred_drops = transferred;
        let old_messages = source
            .messages
            .iter()
            .map(|message| (message.mid.as_str(), message.digest.as_str()))
            .collect::<BTreeMap<_, _>>();
        self.restored_no_new_content = retained.len() == source.history.len()
            && held.iter().all(|entry| {
                old_messages
                    .get(entry.mid.as_str())
                    .is_some_and(|digest| served_digest(entry).is_ok_and(|d| *digest == d))
            });
        if !self.restored_no_new_content {
            self.historian_pending = true;
        }
        tracing::info!(session_ref=%self.reference(),history_compartments=retained.len(),copied_chunk_embeddings=copied,transferred_drops=transferred,discarded_drops=self.last_discarded_drops,"async lineage sources revalidated");
        self.resync_sources = None;
        Ok(())
    }
}

impl McHandler {
    fn advance_async_historian_cadence(
        &self,
        state: &mut State,
        codec: codec::Codec,
    ) -> Result<bool, HandlerOutcome> {
        if state.engine.preset != transform::compaction::Preset::Head {
            return Ok(false);
        }
        // Every held entry is folded into the running totals by the policy
        // step that precedes this one.
        state.fold_entries(codec, None)?;
        let user = state
            .aggregates
            .last_user
            .as_ref()
            .map(|(_, mid)| mid.clone());
        let tools = state.aggregates.tool_results;
        let facts = HistorianCadence {
            user,
            tools,
            model: state
                .conditions
                .as_ref()
                .and_then(|headers| headers.get("model"))
                .unwrap_or(&state.setup.model)
                .clone(),
            settings: sha256_hex(
                &serde_jcs::to_vec(&self.async_historian_fields(state)).map_err(transient)?,
            ),
        };
        if state.restored_no_new_content
            && state
                .historian_cadence
                .as_ref()
                .is_some_and(|prior| prior.model == facts.model && prior.settings == facts.settings)
        {
            state.historian_cadence = Some(facts);
            state.historian_pending = false;
            state.restored_no_new_content = false;
            return Ok(false);
        }
        state.restored_no_new_content = false;
        let due = state.historian_pending
            || state.historian_cadence.as_ref().is_none_or(|prior| {
                prior.user != facts.user
                    || prior.model != facts.model
                    || prior.settings != facts.settings
                    || facts.tools >= prior.tools.saturating_add(25)
            });
        if due {
            state.historian_cadence = Some(facts);
            state.historian_pending = true;
        }
        Ok(due)
    }

    async fn finish_async_historian_evaluation(
        &self,
        reference: &str,
        generation: u64,
        cadence: &Option<HistorianCadence>,
    ) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load_head(store, reference)? else {
            return Ok(());
        };
        let _serial = self.provider_serial.lock_for(&state.key).await;
        state = self
            .checkout(store, reference)?
            .ok_or_else(|| transient("async session disappeared"))?;
        if state.generation == generation && &state.historian_cadence == cadence {
            state.historian_pending = false;
            state.save(store, &[])?;
        }
        self.checkin(state);
        Ok(())
    }
}

/// What a runner serves for `entry` in descriptors mode, for the test runners
/// ck-mc reads: the runner's content digests over the full inline message and
/// each part, and every byte-backed image or file and every text over
/// `PART_INLINE_MAX` replaced by a ref in place (llm-runner §4.2), selected by
/// the crate's own `read::descriptors::describe`.
#[cfg(test)]
pub(crate) fn serve_descriptors(entry: &ReadMessage) -> ReadMessage {
    use base64::Engine as _;
    use cortexkit_role_llm_runner::read::descriptors::{
        describe, PartDigest, Payload, Reference, DESCRIPTOR_MESSAGE_MAX, PART_INLINE_MAX,
    };
    fn pointer_of(base: &str, key: &str) -> String {
        format!("{base}/{}", key.replace('~', "~0").replace('/', "~1"))
    }
    fn media(value: &Value) -> Option<(String, String)> {
        let source = value.get("source");
        if let Some(source) =
            source.filter(|source| source.get("type").and_then(Value::as_str) == Some("base64"))
        {
            return Some((
                source.get("media_type")?.as_str()?.into(),
                source.get("data")?.as_str()?.into(),
            ));
        }
        if value.get("type").and_then(Value::as_str) == Some("file") {
            let url = value.get("url")?.as_str()?;
            let (header, data) = url.strip_prefix("data:")?.split_once(',')?;
            return Some((header.strip_suffix(";base64")?.into(), data.into()));
        }
        if value.get("type").and_then(Value::as_str) == Some("image") {
            return Some((
                value.get("mimeType")?.as_str()?.into(),
                value.get("data")?.as_str()?.into(),
            ));
        }
        None
    }
    fn collect(
        value: &Value,
        pointer: &str,
        tops: &BTreeMap<String, String>,
        payloads: &mut Vec<Payload>,
    ) {
        let part = tops.get(pointer).cloned();
        if let Some((mime, data)) = media(value) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .expect("test media is base64");
            let kind = if mime.starts_with("image/") {
                "image"
            } else if mime == "application/pdf" {
                "pdf"
            } else {
                "file"
            };
            let dimensions = (kind == "image")
                .then(|| crate::image_tokens::base64_image_dimensions(&mime, &data))
                .flatten();
            payloads.push(Payload {
                pointer: pointer.into(),
                reference: Reference::media(part, kind, mime, &bytes, dimensions),
                required: true,
            });
            return;
        }
        match value {
            Value::String(text) if text.len() > PART_INLINE_MAX => payloads.push(Payload {
                pointer: pointer.into(),
                reference: Reference::text(part, text),
                required: false,
            }),
            Value::Object(map) => {
                for (key, child) in map {
                    collect(child, &pointer_of(pointer, key), tops, payloads);
                }
            }
            Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    collect(
                        child,
                        &pointer_of(pointer, &index.to_string()),
                        tops,
                        payloads,
                    );
                }
            }
            _ => {}
        }
    }
    let mut served = entry.clone();
    served.digest = Some(contract::digest::content_digest(&entry.message));
    let Ok(native) = parts(&entry.message) else {
        return served;
    };
    served.part_digests = Some(
        entry
            .tags
            .iter()
            .zip(native.iter())
            .map(|(row, part)| PartDigest::new(&row.part, part))
            .collect(),
    );
    let base = if entry.message.get("parts").is_some() {
        "/parts"
    } else if entry.message.get("content").is_some() {
        "/content"
    } else {
        "/message/content"
    };
    let tops = if entry.message.pointer(base).is_some_and(Value::is_string) {
        BTreeMap::from_iter(
            entry
                .tags
                .first()
                .map(|row| (base.to_owned(), row.part.clone())),
        )
    } else {
        entry
            .tags
            .iter()
            .enumerate()
            .map(|(index, row)| (format!("{base}/{index}"), row.part.clone()))
            .collect()
    };
    let mut payloads = Vec::new();
    collect(&entry.message, "", &tops, &mut payloads);
    if payloads.is_empty() {
        return served;
    }
    let mut envelope = served.clone();
    envelope.message = Value::Null;
    let budget = DESCRIPTOR_MESSAGE_MAX - serde_json::to_vec(&envelope).unwrap().len();
    served.message = describe(&entry.message, &payloads, budget).expect("describable test message");
    served
}
