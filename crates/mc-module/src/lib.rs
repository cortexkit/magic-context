//! The Magic Context subc module.
//!
//! Harness-agnostic cache-stability transform: receives already-decoded CK items,
//! classifies the pass, drives `cortexkit-cache-core` through `mc-core`, and
//! persists per-session state in the single-writer `mc-store`. Served over the subc
//! wire via `subc-client-rs`'s `serve` (provider role).
//!
//! Lifecycle (handled by `serve`): read `--subc <connection-file>`, authenticate,
//! send HELLO{manifest}, await HELLO_ACK. [`McHandler::on_hello_ack`] is the storage
//! seam — it resolves the descriptor (from `ack.storage`, else a local dev path) and
//! opens the store EXACTLY ONCE (single-writer lease held for the module lifetime).
//!
//! Slice-1 scope: the cache-stability spine. `handle` answers `transform` (the
//! CK-in/CK-out pass: classify → cache-core step → conditional commit), `health`
//! (proves the store opened), and echoes otherwise.

#![forbid(unsafe_code)]

// These clocks exist only in the opt-in, in-process profiling test. Production
// builds keep the original timers and contain no additional clock reads.
macro_rules! profile_start {
    ($timer:ident, $stage:literal) => {
        #[cfg(test)]
        let $timer = crate::per_pass_profile::start($stage);
    };
}
macro_rules! profile_end {
    ($timer:ident) => {
        #[cfg(test)]
        crate::per_pass_profile::finish($timer);
    };
}
#[cfg(test)]
mod per_pass_profile;
#[cfg(test)]
mod private_permissions_source_test;

pub mod agent_data;
mod agent_fragments;
mod app_read;
#[cfg(test)]
mod app_read_test_store;
pub mod boundary;
pub mod caveman;
mod child_retention;
pub mod ck_wire;
pub mod classify;
pub mod codec;
pub mod compartment_coverage;
pub mod config;
mod dream_claim;
pub mod dream_dispatch;
pub mod dream_tasks;
mod memory_actions;

/// Names reserved for scoped, non-tool management requests. These are not facade
/// tools: adding them to the model-visible catalog would invalidate cached prefixes.
pub mod non_served_contract {
    pub const UI_METHODS: &[&str] = &[
        "mc.ui_capabilities",
        "mc.read_sidebar",
        "mc.read_status",
        "mc.read_embed",
        "mc.read_compartment_count",
        "mc.read_todos",
        "mc.recomp_preview",
        "mc.recomp_start",
        "mc.rescore",
        "mc.wrapup",
        "mc.flush",
        "mc.dream",
        "mc.embed",
        "mc.job_read",
        "mc.job_cancel",
        "mc.ui_events",
        "mc.notice_currentness",
    ];
    pub const RETRIEVAL_METHOD: &str = "mc.retrieval";
    pub const MEMORY_METHOD: &str = "mc.memory";

    /// Resolve the project from the session attached to the admitted channel,
    /// using `route_project_identity`, never from request project/directory fields.
    /// All other reserved methods are restricted to that channel's session.
    pub const PROJECT_METHODS: &[&str] = &[
        "mc.ui_capabilities",
        "mc.read_sidebar",
        "mc.read_status",
        "mc.read_embed",
        "mc.rescore",
        "mc.dream",
        "mc.embed",
        RETRIEVAL_METHOD,
        MEMORY_METHOD,
    ];
    pub const UI_READ_METHODS: &[&str] = &[
        "mc.ui_capabilities",
        "mc.read_sidebar",
        "mc.read_status",
        "mc.read_embed",
        "mc.read_compartment_count",
        "mc.read_todos",
    ];

    /// `HandlerOutcome::Error` has two wire fields. Its `message` is the exact
    /// refused method name, not prose, so clients can identify the unsupported route.
    pub const ROUTE_REFUSAL_CODE: &str = "route_not_ported";
    pub const ROUTE_NAME_FIELD: &str = "message";
    /// Keys are Rust `RetrievalSource` ids. In particular `raw_message` and
    /// `compartment` are separate keys, unlike the TS request source `message`.
    pub const RETRIEVAL_AVAILABILITY_FIELD: &str = "source_availability";

    /// Missing handles and busy/locked reads share this unknown-state envelope.
    /// Unknown values must never be displayed as successful, authoritative zeros.
    pub fn partial_state_body() -> serde_json::Value {
        serde_json::json!({
            "v": 1, "ok": false, "state": "partial", "reason": "store_unavailable",
            "authority": "unknown", "data": null,
        })
    }
}
pub mod config_parity;
mod content_language;
pub mod decay_render;
pub mod decision_calibration;
mod digest;
pub mod divergence;
mod dream_runner;
pub mod entorhinal_resolve;
/// Explicit background entries. None is called by a served transform or tool.
/// Config resolution and all adapter work happen on the worker, not its caller.
pub mod background {
    use crate::config_parity::{ConfigResolveRequest, CoreConfig, CoreConfigResolver};
    pub use crate::dream_runner::{
        CarrierError, ChildRequest, Completion, DreamCarrier, DreamRequest, DreamRole, RunResult,
    };
    pub use crate::historian_numerical_drain::{
        DrainMeta, DrainReservation, DrainReserveResult, DrainStore, ReserveRequest,
    };
    use mc_store::parity_schema_manifest::CapabilityResult;
    use std::sync::Arc;
    use std::thread::JoinHandle;

    pub struct ConfigInput {
        pub resolver: Arc<dyn CoreConfigResolver>,
        pub request: ConfigResolveRequest,
    }

    /// Only an off-thread entry can construct a unit containing resolved config
    /// and activation. Nested operations keep that activation value across toggles.
    pub struct Unit {
        config: CoreConfig,
        activated: bool,
    }

    fn spawn<T: Send + 'static>(
        name: &str,
        input: ConfigInput,
        work: impl FnOnce(Unit) -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<Result<Option<T>, String>>> {
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let config = match input.resolver.resolve(&input.request) {
                    CapabilityResult::Available { value } => value,
                    CapabilityResult::Degraded { reason, .. }
                    | CapabilityResult::Unavailable { reason } => return Err(reason.code),
                };
                let activated = config.effective.rust_background_enabled();
                if !activated {
                    return Ok(None);
                }
                Ok(Some(work(Unit { config, activated })))
            })
    }

    // The orchestration callback is trusted engine code or a hermetic fixture,
    // never an RPC payload. Each tick and manual run captures config independently;
    // no serving path calls these entries.
    pub fn dreamer_tick<T: Send + 'static>(
        input: ConfigInput,
        dispatch: impl FnOnce(Unit) -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<Result<Option<T>, String>>> {
        spawn("mc-dreamer-tick", input, dispatch)
    }

    pub fn manual_dream<T: Send + 'static>(
        input: ConfigInput,
        dispatch: impl FnOnce(Unit) -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<Result<Option<T>, String>>> {
        spawn("mc-manual-dream", input, dispatch)
    }

    pub fn historian_drain<T: Send + 'static>(
        input: ConfigInput,
        drain: impl FnOnce(Unit) -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<Result<Option<T>, String>>> {
        spawn("mc-historian-drain", input, drain)
    }

    pub fn embedding_drain<T: Send + 'static>(
        input: ConfigInput,
        drain: impl FnOnce(Unit) -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<Result<Option<T>, String>>> {
        spawn("mc-embedding-drain", input, drain)
    }

    impl Unit {
        pub fn captured_dream_config(
            &self,
            harness: String,
            directory: std::path::PathBuf,
        ) -> Arc<crate::dream_dispatch::context::CapturedConfig> {
            Arc::new(crate::dream_dispatch::context::CapturedConfig {
                activated: self.activated,
                route: self.config.effective.clone(),
                effective: self.config.settings.clone(),
                harness,
                directory,
            })
        }

        pub fn run_dream_task<T>(
            &self,
            request: &DreamRequest<'_>,
            carrier: &mut impl DreamCarrier,
            validate: impl FnMut(&Completion) -> Result<T, String>,
        ) -> RunResult<T> {
            // Each worker owns its runtime; no model future blocks the serving runtime.
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("background runtime")
                .block_on(crate::dream_runner::run_dream_task(
                    self.activated,
                    &self.config.effective,
                    &self.config.settings,
                    request,
                    carrier,
                    validate,
                ))
        }

        pub fn reserve_historian<S: DrainStore>(
            &self,
            store: &S,
            request: ReserveRequest<'_>,
        ) -> Result<Option<DrainReserveResult>, S::Error> {
            crate::historian_numerical_drain::reserve_protected_tail_drain_tokens(
                store,
                self.activated,
                request,
            )
        }

        pub fn refund_historian<S: DrainStore>(
            &self,
            store: &S,
            reservation: &DrainReservation,
        ) -> Result<(), S::Error> {
            crate::historian_numerical_drain::rollback_protected_tail_drain_reservation(
                store,
                self.activated,
                Some(reservation),
            )
        }

        pub fn publish_historian(
            &self,
            store: &mc_store::McStore,
            mut request: mc_store::HistorianPublishRequest<'_>,
        ) -> Result<mc_store::HistorianPublishResult, mc_store::HistorianPublishError> {
            request.rust_background_enabled = self.activated;
            store.publish_historian_chunk(request)
        }

        #[allow(clippy::too_many_arguments)]
        pub fn drain_embeddings(
            &self,
            db: &mut rusqlite::Connection,
            chunks: &dyn mc_store::retrieval_vectors::store::ChunkCatalog,
            provider: &mut dyn mc_store::retrieval_vectors::drain::EmbeddingProvider,
            registration: &mc_store::retrieval_vectors::drain::Registration,
            limit: usize,
            now: i64,
            completed_at: impl FnOnce() -> i64,
        ) -> Result<
            Option<mc_store::retrieval_vectors::drain::FinishOutcome>,
            mc_store::retrieval_vectors::drain::DrainError,
        > {
            mc_store::retrieval_vectors::queue::drain_once(
                self.activated,
                db,
                chunks,
                provider,
                registration,
                limit,
                now,
                completed_at,
            )
        }
    }
}
mod descriptors;
pub mod healing;
pub mod historian;
pub mod historian_chunk;
mod historian_numerical_drain;
pub mod historian_producer;
pub mod historian_prompt;
pub mod historian_recovery;
pub mod historian_runner;
pub mod historian_stage;
pub mod historian_tool_template;
pub mod historian_validate;
pub mod host_store;
mod image_tokens;
pub mod injection;
pub mod m0_compose;
pub mod m1_compose;
pub mod memory_render;
pub mod memory_tool;
mod memory_verification;
pub mod offline_first_pass;
pub mod offline_move;
mod ops_facade;
pub mod parity_contract;
pub mod project_docs;
pub mod project_identity;
pub mod prompt_surface;
pub mod protection_window;
pub mod providers;
mod recomp_staging;
mod reply_pages;
mod retained_size;
pub mod retrieval;
mod retrieval_store;
mod runner_follow;
pub mod runner_limits;
mod transport_handler;
pub use transport_handler::McTransportHandler;
pub mod edit_admission;
pub mod engram_catalog;
mod reclaim_distance;
pub mod route_targets;
pub mod runner_choices;
pub mod runner_reminders;
pub mod scheduler;
pub mod selection;
pub mod session_resolver;
pub mod single_store_migrate;
pub mod single_store_reads;
pub mod single_store_repair;
mod stable_hash;
mod subagent_invocations_read;
mod tail_hygiene;
mod tool_catalog;
pub mod transform;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use cortexkit_lease::LeaseError;
use cortexkit_store::StoreError;
use cortexkit_store_types::{sqlite_store_path, Isolation, StorageBackend, StorageDescriptor};
use mc_store::memory_lifecycle::applier::{AdmissionOperation, AdmissionRequest};
use mc_store::single_store_schema::{
    SINGLE_STORE_MIGRATION_REQUIRED_REASON, SINGLE_STORE_MIGRATION_REQUIRED_SENTENCE,
    SINGLE_STORE_STATE_SPLIT_REASON,
};
#[cfg(test)]
use mc_store::InsertMemoryInput;
use mc_store::{
    canonical_root, FacadeMemoryMutationError, FacadeMutationOutcome, HistorianChunkRange,
    HistorianDecision, HistorianPhase, HistorianRecentDecision, MappingUpdate, McStore,
    McStoreError, NoteCasOutcome, NoteDismissOutcome, NoteInput, PendingAgentDrop,
    StoredChunkTranscript, StoredCompartment, StoredNote, TodoStateSetOutcome,
    LATEST_MIGRATION_VERSION, STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
};
#[cfg(test)]
use mc_store::{NoteEvaluationInput, NoteWriteInput};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use subc_client_rs::{
    async_trait, build_provenance, HandlerOutcome, HealthReport, HealthStatus, ModuleHandler,
    RequestCtx, RouteBindRequest, RouteHandle,
};

use boundary::{BoundaryBlock, BoundaryContext, BoundaryMsg, Role, TriggerContext};
use classify::{
    child_session_id, has_manifest_envelope, next_attempt_nonce, parse_host_classify_completion,
    CLASSIFY_AWAIT_TIMEOUT, CLASSIFY_MAX_OUTPUT_TOKENS, CLASSIFY_RECOVERY_TIMEOUT,
    CLASSIFY_SYSTEM_PROMPT, CLASSIFY_TASK, CLASSIFY_TEMPERATURE, HOST_COMPLETION_REQUIRED,
    MAX_CLASSIFY_PROMPT_BYTES,
};
use config::{derive_historian_chunk_tokens, ConfigCache, McModuleConfig};
use healing::{tail_reclaim, SerializerProfile};
use historian::{
    reattach_historian_producer, run_historian_firing_with_model_cache, HistorianNoFireCause,
    HistorianProducerDriver, HistorianRunnerRefusalCache,
};
use historian_chunk::{
    assemble_historian_firing, AssembleHistorianFiringOutcome, AssembledHistorianFiring,
    HistorianAssemblerConfig,
};
use historian_producer::{HistorianProducer, HistorianProducerConfig, HistorianProducerError};
use historian_runner::HistorianRunnerKind;
use prompt_surface::{PromptSurfacePreset, PromptSurfaceSelection};
use route_targets::{route_targets, RouteTargetConfig, SessionRunnerRoute};
use scheduler::MIN_PLAUSIBLE_CONTEXT_LIMIT;
use selection::SelKind;
#[cfg(test)]
use session_resolver::ResolvedSession;
use session_resolver::{
    MissingSessionResolver, RealSessionResolver, SessionResolveError, SessionResolver,
};
#[cfg(test)]
use subc_protocol::manifest::ExecutionMode;
use subc_protocol::{
    manifest::{Concurrency, ConsumerRole, IdentityScope, ModuleManifest, ProviderRole, TrustTier},
    ModuleHelloAckBody, PROTOCOL_VERSION,
};
#[cfg(test)]
use transform::ReductionDecision;

#[cfg(test)]
pub mod test_support;

#[cfg(test)]
mod differential_goldens;
use transform::{HistorianDiagnostics, SerializedOutputCache, TransformRequest};

/// The per-route binding: the project, harness, session-slot value, and fallback render
/// budget frozen at bind. Transform routes carry the durable session in `session`. Facade
/// routes have two identity modes: the OpenCode Rust route binds its durable session directly,
/// while the Claude Code wrapper binds an instance token that must be resolved before touching
/// the store. The project is NEVER taken from a per-pass request field — a crafted request could
/// spoof it to read another project's memories — so it lives here, keyed by the route channel
/// the daemon controls.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionBinding {
    /// Identity stamped by the daemon at bind, never supplied by an RPC body.
    pub principal: Option<subc_protocol::Principal>,
    /// Daemon-stamped scope owner and authorization, copied from the owner's scope.sync record at bind.
    pub scope: Option<subc_protocol::scope::ScopeStamp>,
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
    pub model_key: Option<String>,
    pub config: McModuleConfig,
    /// The fallback history budget (tokens) frozen at bind. A transform request may carry
    /// a newer harness-resolved value because config can change while the route remains open.
    pub history_budget_tokens: f64,
}

fn runner_bind_identity(binding: &SessionBinding) -> session_resolver::RunnerBindIdentity {
    session_resolver::RunnerBindIdentity {
        project_root: binding.project_root.clone(),
        harness: binding.harness.clone(),
        session: binding.session.clone(),
    }
}

/// Why a transform request can't be served: the route isn't bound, or the request's
/// session doesn't match the channel's bound session. Both fail LOUD — never default to
/// a project (a default would be a cross-project read of another project's store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingError {
    /// No `on_bind` for this channel (or it was torn down). Reject the transform.
    Unbound,
    /// The request's session_id doesn't match the channel's bound session — a poison
    /// cross-check (the channel is the daemon-controlled identity; the request's session
    /// must agree with it).
    SessionMismatch,
}

/// Canonical module id (overridable via `SUBC_MODULE_ID_ENV` at boot).
pub const DEFAULT_MODULE_ID: &str = "magic-context";

const TRANSFORM_HEALTH_LANE: &str = "transform";
// Emergency historian work continues in its spawned task, but a transform may wait only long
// enough to finish before the caller's transport deadline. Sharing one budget across the busy
// join and inline-refire arms prevents their individual deadlines from stacking.
const TRANSFORM_WEDGE_THRESHOLD_MS: u64 = 30_000;
const STORE_OPEN_IDLE: u8 = 0;
const STORE_OPENING: u8 = 1;
const STORE_OPEN_WAITING: u8 = 2;
const STORE_OPENED: u8 = 3;
const STORE_LEASE_WAIT_WINDOW: Duration = Duration::from_secs(60);
const STORE_LEASE_INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const STORE_LEASE_MAX_BACKOFF: Duration = Duration::from_secs(1);
// How long a request may block on a store open that is still in flight before it refuses. A
// request already blocks up to SESSION_RESOLVE_DEADLINE (2s, session_resolver.rs) resolving its
// session before it ever reads the store, so a wait well inside that stays within the deadline
// this lane already tolerates. One local database open is far quicker than that, so the budget
// sits at the low end: long enough that a fast open never refuses a first call, short enough that
// a wedged open still answers. The lease window (up to a minute) is never waited on here.
const STORE_OPENING_REQUEST_WAIT: Duration = Duration::from_millis(500);
// The user-facing sentence for a context service that cannot answer right now, mirroring the
// MC-C10 entry of the plugin's user-facing failure catalog. Anything a user reads instead of a
// tool result uses this text; engine detail belongs in the error code and the logs.
const CONTEXT_SERVICE_UNAVAILABLE_MESSAGE: &str =
    "Magic Context is temporarily unavailable. Retry in a moment. (MC-C10)";

#[derive(Clone, Copy)]
struct StoreOpenPolicy {
    wait_window: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    request_wait: Duration,
}

impl Default for StoreOpenPolicy {
    fn default() -> Self {
        Self {
            wait_window: STORE_LEASE_WAIT_WINDOW,
            initial_backoff: STORE_LEASE_INITIAL_BACKOFF,
            max_backoff: STORE_LEASE_MAX_BACKOFF,
            request_wait: STORE_OPENING_REQUEST_WAIT,
        }
    }
}

/// Where the descriptor being opened came from. A refusal names it because the two origins mean
/// different investigations: a daemon-assigned path is a storage-seam problem, while a dev
/// fallback means this process resolved a path on its own and can therefore collide with another
/// incarnation that resolved the very same one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DescriptorOrigin {
    DaemonAck,
    DevFallback,
}

impl DescriptorOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::DaemonAck => "daemon_ack",
            Self::DevFallback => "dev_fallback",
        }
    }
}

/// The descriptor label a refusal or health report may carry. A storage location is sensitive
/// (the sqlite path contains a home directory, a postgres DSN contains a credential), so only the
/// file name plus a short hash of its directory survives: enough to tell two rigs' stores apart,
/// never enough to disclose where either lives.
fn redacted_descriptor_label(descriptor: &StorageDescriptor) -> String {
    match &descriptor.backend {
        StorageBackend::Sqlite { path } => {
            let path = Path::new(path);
            let file = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unnamed");
            let directory = path.parent().and_then(Path::to_str).unwrap_or("");
            let digest = sha256_hex(directory.as_bytes());
            format!("sqlite:{file}@{}", &digest[..12])
        }
        StorageBackend::Postgres { database, .. } => format!("postgres:{database}"),
    }
}

/// The descriptor of the open attempt in progress (or the last one that ran).
#[derive(Clone, Debug)]
struct StoreOpenAttempt {
    label: String,
    origin: DescriptorOrigin,
}

/// The reason code a failed open carries when nothing more specific applies: the open failed for
/// one of the many ordinary reasons a database open can fail, and the sentence beside it is the
/// only description there is. Named arms exist only where a reader has to act differently.
const STORE_OPEN_FAILURE_REASON_GENERIC: &str = "open_error";

/// The stable reason code for an open that failed for a reason worth naming, or the generic code
/// when there is none. Keeping this in one place means the health lane, the refusal message and
/// the log line cannot drift into naming the same failure three different ways.
fn store_open_failure_reason_code(error: &McStoreError) -> &'static str {
    match error {
        McStoreError::SingleStoreMigrationRequired { .. } => SINGLE_STORE_MIGRATION_REQUIRED_REASON,
        McStoreError::SingleStoreStateSplit { .. } => SINGLE_STORE_STATE_SPLIT_REASON,
        McStoreError::StoreAheadOfBinary { .. } => STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
        _ => STORE_OPEN_FAILURE_REASON_GENERIC,
    }
}

/// The two schema versions of a store that a newer ck-mc already migrated past this binary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StoreAheadVersions {
    /// The highest migration version recorded in `store.db`.
    db_version: u32,
    /// The highest migration version this binary carries.
    binary_max: u32,
}

impl StoreAheadVersions {
    fn of(error: &McStoreError) -> Option<Self> {
        match error {
            McStoreError::StoreAheadOfBinary {
                db_version,
                binary_max,
            } => Some(Self {
                db_version: *db_version,
                binary_max: *binary_max,
            }),
            _ => None,
        }
    }

    /// The machine-readable detail every error frame for this refusal carries, so an adapter can
    /// name both versions without parsing a sentence.
    fn detail(self) -> Value {
        json!({
            "reason_code": STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
            "db_version": self.db_version,
            "binary_max": self.binary_max,
        })
    }

    /// The sentence a user reads. It mirrors the plugin's MC-C13 rendering so a facade tool and
    /// a refused turn say the same thing, and it names no path or other engine internal.
    fn user_message(self) -> String {
        format!(
            "Magic Context refused to start: its store (store.db) is at schema v{} but this ck-mc build only knows up to v{}. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)",
            self.db_version, self.binary_max
        )
    }
}

/// Why a store open ended for good. Recorded BEFORE the phase returns to idle so a request that
/// observes an idle phase always finds the reason, instead of falling through to the
/// "nothing was ever attempted" arm and blaming a missing ack that did arrive.
#[derive(Clone, Debug)]
struct StoreOpenFailure {
    /// The stable token a reader matches on.
    reason_code: String,
    /// Present when the open was refused because the store is ahead of this binary. Kept
    /// structured so every refusal can carry both versions rather than only a sentence.
    store_ahead: Option<StoreAheadVersions>,
    /// The human sentence, which may name paths, elapsed times and driver text.
    reason: String,
    origin: &'static str,
    descriptor: String,
    at_ms: u64,
}

/// Why a request found no open store handle.
///
/// The handle is a single `Option`, so its emptiness on its own cannot say which of these holds —
/// and they need opposite responses: retry in a moment, wait for another process to exit, look up
/// why the open failed, or find out why no ack arrived. One shared code and message would be
/// wrong in nearly every case, so the seam reports the state it actually observed.
#[derive(Clone, Debug, PartialEq, Eq)]
enum StoreRefusal {
    /// No HELLO_ACK has arrived, so no open has ever been attempted.
    NeverAcked,
    /// An open is in flight and this request already spent its wait budget.
    Opening { elapsed_ms: u64 },
    /// Another live process holds the single-writer lease; the open keeps retrying until its
    /// window runs out.
    LeaseWait {
        elapsed_ms: u64,
        wait_window_ms: u64,
        descriptor: String,
    },
    /// The open ended and is not retried, so every later request refuses the same way until the
    /// module restarts.
    Failed {
        reason_code: String,
        reason: String,
        origin: &'static str,
        descriptor: String,
    },
    /// The store was migrated by a newer ck-mc than this one. Terminal like `Failed`, but with
    /// its own code: the fix is a different binary or a coordinated restore of both databases,
    /// and an adapter has to be able to tell the user exactly that.
    StoreAhead {
        versions: StoreAheadVersions,
        origin: &'static str,
        descriptor: String,
    },
    /// The store has not been through the one-time single-store migration, or it and
    /// `context.db` disagree about it. Terminal: the fix is `magic-context doctor
    /// single-store migrate` (or restoring both files from its backup), never a retry.
    SingleStore {
        code: &'static str,
        reason: String,
        origin: &'static str,
        descriptor: String,
    },
}

/// The single-store refusal code a failure reason names, if it is one.
fn single_store_refusal_code(reason_code: &str) -> Option<&'static str> {
    [
        SINGLE_STORE_MIGRATION_REQUIRED_REASON,
        SINGLE_STORE_STATE_SPLIT_REASON,
    ]
    .into_iter()
    .find(|code| *code == reason_code)
}

impl StoreRefusal {
    fn code(&self) -> &'static str {
        match self {
            Self::NeverAcked => "store_unavailable",
            Self::Opening { .. } => "store_opening",
            Self::LeaseWait { .. } => "store_lease_wait",
            Self::Failed { reason_code, .. } if reason_code == "context_db_missing" => {
                "context_db_missing"
            }
            Self::Failed { .. } => "store_open_failed",
            Self::StoreAhead { .. } => STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
            Self::SingleStore { code, .. } => code,
        }
    }

    /// Whether an identical request sent later can succeed without anyone intervening.
    fn retryable(&self) -> bool {
        !matches!(
            self,
            Self::Failed { .. } | Self::StoreAhead { .. } | Self::SingleStore { .. }
        )
    }

    fn message(&self) -> String {
        let disposition = if self.retryable() {
            "retryable"
        } else {
            "terminal"
        };
        match self {
            Self::NeverAcked => format!(
                "storage is not open: no HELLO_ACK has arrived on this connection, so no open has been attempted yet ({disposition})"
            ),
            Self::Opening { elapsed_ms } => format!(
                "storage open is still in flight: elapsed_ms={elapsed_ms} ({disposition})"
            ),
            Self::LeaseWait {
                elapsed_ms,
                wait_window_ms,
                descriptor,
            } => format!(
                "storage single-writer lease is held by another live process: elapsed_ms={elapsed_ms} wait_window_ms={wait_window_ms} descriptor={descriptor} ({disposition})"
            ),
            Self::Failed {
                reason_code,
                reason,
                origin,
                descriptor,
            } => format!(
                "storage open failed and is not retried before restart: reason_code={reason_code} reason={reason} descriptor_origin={origin} descriptor={descriptor} ({disposition})"
            ),
            Self::StoreAhead {
                versions,
                origin,
                descriptor,
            } => format!(
                "storage open refused and is not retried before restart: reason_code={STORE_AHEAD_OF_BINARY_REFUSAL_REASON} db_version={} binary_max={} reason={} descriptor_origin={origin} descriptor={descriptor} ({disposition})",
                versions.db_version,
                versions.binary_max,
                mc_store::store_ahead_of_binary_remediation(versions.db_version, versions.binary_max)
            ),
            Self::SingleStore {
                code,
                reason,
                origin,
                descriptor,
            } => format!(
                "storage open refused and is not retried before restart: reason_code={code} reason={reason} descriptor_origin={origin} descriptor={descriptor} ({disposition})"
            ),
        }
    }

    /// The refusal as an error frame for an internal lane (transform, status, sync, authority),
    /// whose reader is an operator or a log.
    fn into_outcome(self) -> HandlerOutcome {
        if let Self::SingleStore { code, .. } = &self {
            return HandlerOutcome::ErrorWithDetail {
                code: code.to_string(),
                message: self.message(),
                detail: json!({
                    "reason_code": code,
                    "user_message": SINGLE_STORE_MIGRATION_REQUIRED_SENTENCE,
                }),
            };
        }
        if let Self::StoreAhead { versions, .. } = &self {
            let detail = versions.detail();
            return HandlerOutcome::ErrorWithDetail {
                code: self.code().to_string(),
                message: self.message(),
                detail,
            };
        }
        HandlerOutcome::Error {
            code: self.code().to_string(),
            message: self.message(),
        }
    }

    /// The refusal as an error frame for a facade tool, whose message reaches the user. The text
    /// stays the user-facing sentence — engine internals (paths, lease state, open errors) must
    /// never surface in tool output — while the error code still names which refusal this is, for
    /// logs. A store that is ahead of this binary gets its own sentence: "retry in a moment" would
    /// be wrong advice, because no retry fixes it.
    fn into_facade_outcome(self) -> HandlerOutcome {
        if self.code() == "context_db_missing" {
            return HandlerOutcome::Error {
                code: self.code().to_string(),
                message: "Magic Context has no context.db. Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc.".to_string(),
            };
        }
        if let Self::SingleStore { code, .. } = &self {
            return HandlerOutcome::ErrorWithDetail {
                code: code.to_string(),
                message: SINGLE_STORE_MIGRATION_REQUIRED_SENTENCE.to_string(),
                detail: json!({ "reason_code": code }),
            };
        }
        if let Self::StoreAhead { versions, .. } = &self {
            return HandlerOutcome::ErrorWithDetail {
                code: self.code().to_string(),
                message: versions.user_message(),
                detail: versions.detail(),
            };
        }
        HandlerOutcome::Error {
            code: self.code().to_string(),
            message: CONTEXT_SERVICE_UNAVAILABLE_MESSAGE.to_string(),
        }
    }
}

struct StoreOpenCoordinator {
    phase: AtomicU8,
    phase_changed: Notify,
    opening_started_at_ms: AtomicU64,
    wait_started_at_ms: AtomicU64,
    cancelled: AtomicBool,
    cancel: Notify,
    active_waiters: AtomicU64,
    waiter_completed: Notify,
    waiter_starts: AtomicU64,
    policy: Mutex<StoreOpenPolicy>,
    attempt: Mutex<Option<StoreOpenAttempt>>,
    failure: Mutex<Option<StoreOpenFailure>>,
    /// A deterministic startup barrier for exercising the real route/open race.
    #[cfg(test)]
    open_gate: Mutex<Option<Arc<Notify>>>,
}

impl StoreOpenCoordinator {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(STORE_OPEN_IDLE),
            phase_changed: Notify::new(),
            opening_started_at_ms: AtomicU64::new(0),
            wait_started_at_ms: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            cancel: Notify::new(),
            active_waiters: AtomicU64::new(0),
            waiter_completed: Notify::new(),
            waiter_starts: AtomicU64::new(0),
            policy: Mutex::new(StoreOpenPolicy::default()),
            attempt: Mutex::new(None),
            failure: Mutex::new(None),
            #[cfg(test)]
            open_gate: Mutex::new(None),
        }
    }

    /// Publish a phase and wake the requests waiting on an in-flight open. Every phase write goes
    /// through here so a waiter can never sleep through the transition it is waiting for.
    fn set_phase(&self, phase: u8) {
        self.phase.store(phase, Ordering::Release);
        self.phase_changed.notify_waiters();
    }

    /// Note which descriptor this attempt opens, and drop any reason left by an earlier attempt so
    /// a fresh open is never reported as the old failure.
    fn begin_attempt(&self, descriptor: &StorageDescriptor, origin: DescriptorOrigin, now_ms: u64) {
        *self.attempt.lock().expect("store open attempt mutex") = Some(StoreOpenAttempt {
            label: redacted_descriptor_label(descriptor),
            origin,
        });
        *self.failure.lock().expect("store open failure mutex") = None;
        self.opening_started_at_ms.store(now_ms, Ordering::Relaxed);
    }

    fn attempt_snapshot(&self) -> Option<StoreOpenAttempt> {
        self.attempt
            .lock()
            .expect("store open attempt mutex")
            .clone()
    }

    fn failure_snapshot(&self) -> Option<StoreOpenFailure> {
        self.failure
            .lock()
            .expect("store open failure mutex")
            .clone()
    }

    /// Record why the open ended, then release the phase. The order matters: a request that sees
    /// the idle phase must already be able to read the reason.
    fn fail_and_idle(&self, reason_code: &str, reason: String, now_ms: u64) {
        self.record_failure_and_idle(reason_code, reason, None, now_ms);
    }

    /// `fail_and_idle` for an open that ended with a store error, keeping the typed parts of the
    /// error (its reason code and, for a store-ahead refusal, both versions).
    fn fail_with_error_and_idle(&self, error: &McStoreError, now_ms: u64) {
        self.record_failure_and_idle(
            store_open_failure_reason_code(error),
            error.to_string(),
            StoreAheadVersions::of(error),
            now_ms,
        );
    }

    fn record_failure_and_idle(
        &self,
        reason_code: &str,
        reason: String,
        store_ahead: Option<StoreAheadVersions>,
        now_ms: u64,
    ) {
        let attempt = self.attempt_snapshot();
        *self.failure.lock().expect("store open failure mutex") = Some(StoreOpenFailure {
            reason_code: reason_code.to_string(),
            store_ahead,
            reason,
            origin: attempt
                .as_ref()
                .map_or("unknown", |attempt| attempt.origin.as_str()),
            descriptor: attempt.map_or_else(|| "unknown".to_string(), |attempt| attempt.label),
            at_ms: now_ms,
        });
        self.set_phase(STORE_OPEN_IDLE);
    }

    /// The one place that turns "no store handle" into an answer, so every seam refuses with the
    /// state that actually holds.
    fn refusal(&self, now_ms: u64) -> StoreRefusal {
        let elapsed_since = |at_ms: u64| {
            if at_ms == 0 {
                0
            } else {
                now_ms.saturating_sub(at_ms)
            }
        };
        match self.phase.load(Ordering::Acquire) {
            // The handle is published before the phase flips to opened, so an opened phase with an
            // empty handle exists only in the instant between those two writes: still in flight.
            STORE_OPENING | STORE_OPENED => StoreRefusal::Opening {
                elapsed_ms: elapsed_since(self.opening_started_at_ms.load(Ordering::Relaxed)),
            },
            STORE_OPEN_WAITING => StoreRefusal::LeaseWait {
                elapsed_ms: elapsed_since(self.wait_started_at_ms.load(Ordering::Relaxed)),
                wait_window_ms: self
                    .policy
                    .lock()
                    .expect("store open policy mutex")
                    .wait_window
                    .as_millis() as u64,
                descriptor: self
                    .attempt_snapshot()
                    .map_or_else(|| "unknown".to_string(), |attempt| attempt.label),
            },
            _ => match self.failure_snapshot() {
                Some(StoreOpenFailure {
                    store_ahead: Some(versions),
                    origin,
                    descriptor,
                    ..
                }) => StoreRefusal::StoreAhead {
                    versions,
                    origin,
                    descriptor,
                },
                Some(failure) if single_store_refusal_code(&failure.reason_code).is_some() => {
                    StoreRefusal::SingleStore {
                        code: single_store_refusal_code(&failure.reason_code)
                            .expect("checked by the guard"),
                        reason: failure.reason,
                        origin: failure.origin,
                        descriptor: failure.descriptor,
                    }
                }
                Some(failure) => StoreRefusal::Failed {
                    reason_code: failure.reason_code,
                    reason: failure.reason,
                    origin: failure.origin,
                    descriptor: failure.descriptor,
                },
                // Idle with nothing ever attempted is the only genuinely never-acked state.
                None if self.waiter_starts.load(Ordering::Relaxed) == 0 => StoreRefusal::NeverAcked,
                // An attempt ran but left no reason. Unreachable by construction (every exit from
                // the open records one), and reported as a failed open rather than as a missing
                // ack so a bookkeeping gap can never masquerade as "the daemon never acked".
                None => StoreRefusal::Failed {
                    reason_code: STORE_OPEN_FAILURE_REASON_GENERIC.to_string(),
                    reason: "store open ended without recording a reason".to_string(),
                    origin: self
                        .attempt_snapshot()
                        .map_or("unknown", |attempt| attempt.origin.as_str()),
                    descriptor: self
                        .attempt_snapshot()
                        .map_or_else(|| "unknown".to_string(), |attempt| attempt.label),
                },
            },
        }
    }

    /// The refusal for a store that is ahead of this binary, or that still needs the
    /// single-store migration, once the open has ended that way. `None` in every other state,
    /// including while an open is still in flight.
    fn store_ahead_refusal(&self) -> Option<StoreRefusal> {
        if self.phase.load(Ordering::Acquire) != STORE_OPEN_IDLE {
            return None;
        }
        let failure = self.failure_snapshot()?;
        if let Some(code) = single_store_refusal_code(&failure.reason_code) {
            return Some(StoreRefusal::SingleStore {
                code,
                reason: failure.reason,
                origin: failure.origin,
                descriptor: failure.descriptor,
            });
        }
        let versions = failure.store_ahead?;
        Some(StoreRefusal::StoreAhead {
            versions,
            origin: failure.origin,
            descriptor: failure.descriptor,
        })
    }

    fn waiting_report(&self, now_ms: u64) -> Option<HealthReport> {
        if self.phase.load(Ordering::Acquire) != STORE_OPEN_WAITING {
            return None;
        }
        let started_at_ms = self.wait_started_at_ms.load(Ordering::Relaxed);
        let elapsed_ms = now_ms.saturating_sub(started_at_ms);
        Some(HealthReport {
            status: HealthStatus::Degraded,
            detail: Some(format!(
                "waiting on storage lease, held by prior incarnation, {:.2}s elapsed",
                elapsed_ms as f64 / 1_000.0
            )),
            metrics: Some(json!({
                "lane": TRANSFORM_HEALTH_LANE,
                "storage_state": "waiting_for_lease",
                "storage_lease_wait_elapsed_ms": elapsed_ms,
            })),
        })
    }

    /// A terminally failed open is reported on the health lane as well, so `ck module status`
    /// discriminates it too and the reason is not confined to this process's stderr.
    fn failed_report(&self) -> Option<HealthReport> {
        if self.phase.load(Ordering::Acquire) != STORE_OPEN_IDLE {
            return None;
        }
        let failure = self.failure_snapshot()?;
        if let Some(versions) = failure.store_ahead {
            return Some(HealthReport {
                status: HealthStatus::Failing,
                detail: Some(format!(
                    "storage open refused: {STORE_AHEAD_OF_BINARY_REFUSAL_REASON}: db_version={} binary_max={}: {} (descriptor {} from {}); every request refuses with {STORE_AHEAD_OF_BINARY_REFUSAL_REASON} until the module restarts on a matching store",
                    versions.db_version,
                    versions.binary_max,
                    mc_store::store_ahead_of_binary_remediation(
                        versions.db_version,
                        versions.binary_max
                    ),
                    failure.descriptor,
                    failure.origin
                )),
                metrics: Some(json!({
                    "lane": TRANSFORM_HEALTH_LANE,
                    "storage_state": "open_refused_store_ahead",
                    "storage_open_failure_reason_code": failure.reason_code,
                    "storage_open_failure_reason": failure.reason,
                    "store_db_version": versions.db_version,
                    "binary_max_store_version": versions.binary_max,
                    "storage_descriptor": failure.descriptor,
                    "storage_descriptor_origin": failure.origin,
                    "storage_open_failed_at_ms": failure.at_ms,
                })),
            });
        }
        if let Some(code) = single_store_refusal_code(&failure.reason_code) {
            return Some(HealthReport {
                status: HealthStatus::Failing,
                detail: Some(format!(
                    "storage open refused: {code}: {} (descriptor {} from {}); every request except echo refuses with {code} until the store is migrated and the module restarts",
                    failure.reason, failure.descriptor, failure.origin
                )),
                metrics: Some(json!({
                    "lane": TRANSFORM_HEALTH_LANE,
                    "storage_state": "open_refused_unmigrated",
                    "storage_open_failure_reason_code": failure.reason_code,
                    "storage_open_failure_reason": failure.reason,
                    "storage_descriptor": failure.descriptor,
                    "storage_descriptor_origin": failure.origin,
                    "storage_open_failed_at_ms": failure.at_ms,
                })),
            });
        }
        Some(HealthReport {
            status: HealthStatus::Failing,
            detail: Some(format!(
                "storage open failed and is not retried: {} ({}) (descriptor {} from {}); requests refuse with store_open_failed until the module restarts",
                failure.reason_code, failure.reason, failure.descriptor, failure.origin
            )),
            metrics: Some(json!({
                "lane": TRANSFORM_HEALTH_LANE,
                "storage_state": "open_failed",
                "storage_open_failure_reason_code": failure.reason_code,
                "storage_open_failure_reason": failure.reason,
                "storage_descriptor": failure.descriptor,
                "storage_descriptor_origin": failure.origin,
                "storage_open_failed_at_ms": failure.at_ms,
            })),
        })
    }

    fn finish_waiter(&self) {
        self.active_waiters.fetch_sub(1, Ordering::AcqRel);
        self.waiter_completed.notify_waiters();
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.cancel.notify_waiters();
    }
}

struct StoreOpenWaiterGuard {
    coordinator: Arc<StoreOpenCoordinator>,
}

impl Drop for StoreOpenWaiterGuard {
    fn drop(&mut self) {
        self.coordinator.finish_waiter();
    }
}

fn jittered_store_open_delay(base: Duration, cap: Duration, attempt: usize) -> Duration {
    const JITTER_PERCENT: [u128; 4] = [100, 108, 116, 104];
    let nanos = base
        .as_nanos()
        .saturating_mul(JITTER_PERCENT[attempt % JITTER_PERCENT.len()])
        / 100;
    Duration::from_nanos(nanos.min(cap.as_nanos()).min(u64::MAX as u128) as u64)
}

fn store_open_error_is_live_lease(error: &McStoreError) -> bool {
    matches!(
        error,
        McStoreError::Store(StoreError::Lease(LeaseError::Held { .. }))
    )
}

struct DispatchHealth {
    last_dispatch_started_at_ms: AtomicU64,
    last_dispatch_completed_at_ms: AtomicU64,
    in_flight_count: AtomicU64,
    oldest_queued_at_ms: AtomicU64,
    consecutive_error_count: AtomicU64,
    last_historian_outcome: OnceLock<Mutex<Option<String>>>,
    historian_recent_decisions_count: AtomicU64,
}

impl DispatchHealth {
    const fn new() -> Self {
        Self {
            last_dispatch_started_at_ms: AtomicU64::new(0),
            last_dispatch_completed_at_ms: AtomicU64::new(0),
            in_flight_count: AtomicU64::new(0),
            oldest_queued_at_ms: AtomicU64::new(0),
            consecutive_error_count: AtomicU64::new(0),
            last_historian_outcome: OnceLock::new(),
            historian_recent_decisions_count: AtomicU64::new(0),
        }
    }

    fn record_historian_outcome(&self, outcome: String, recent_decisions_count: usize) {
        *self
            .last_historian_outcome
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(outcome);
        self.historian_recent_decisions_count
            .store(recent_decisions_count as u64, Ordering::Relaxed);
    }

    fn report(&self, now_ms: u64) -> HealthReport {
        let started = self.last_dispatch_started_at_ms.load(Ordering::Relaxed);
        let completed = self.last_dispatch_completed_at_ms.load(Ordering::Relaxed);
        let in_flight = self.in_flight_count.load(Ordering::Relaxed);
        let oldest_queued = self.oldest_queued_at_ms.load(Ordering::Relaxed);
        let consecutive_errors = self.consecutive_error_count.load(Ordering::Relaxed);
        let historian_recent_decisions_count = self
            .historian_recent_decisions_count
            .load(Ordering::Relaxed);
        let last_historian_outcome = self
            .last_historian_outcome
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let completion_lag_ms = started.saturating_sub(completed);
        let heartbeat_age_ms = if started == 0 {
            0
        } else if completed == 0 {
            now_ms.saturating_sub(started)
        } else {
            now_ms.saturating_sub(completed)
        };
        let heartbeat_stale = if in_flight > 0 {
            heartbeat_age_ms > TRANSFORM_WEDGE_THRESHOLD_MS
        } else {
            completion_lag_ms > TRANSFORM_WEDGE_THRESHOLD_MS
        };
        let oldest_queued_age_ms =
            (oldest_queued != 0).then(|| now_ms.saturating_sub(oldest_queued));
        let queue_stale =
            oldest_queued_age_ms.is_some_and(|age| age > TRANSFORM_WEDGE_THRESHOLD_MS);
        let stale = heartbeat_stale || queue_stale;
        let stale_age_ms = if queue_stale {
            oldest_queued_age_ms.unwrap_or(0)
        } else if heartbeat_stale {
            heartbeat_age_ms.max(completion_lag_ms)
        } else {
            0
        };
        let status = if stale {
            HealthStatus::Degraded
        } else {
            HealthStatus::Ok
        };
        let state = if stale { "stuck" } else { "advancing" };
        let mut detail = if stale {
            if queue_stale && !heartbeat_stale {
                format!(
                    "{TRANSFORM_HEALTH_LANE} lane stuck: queue stale; oldest queued item is {stale_age_ms}ms old; in-flight={in_flight}; consecutive errors={consecutive_errors}"
                )
            } else {
                format!(
                    "{TRANSFORM_HEALTH_LANE} lane stuck: heartbeat stale by {stale_age_ms}ms; in-flight={in_flight}; consecutive errors={consecutive_errors}"
                )
            }
        } else if consecutive_errors > 0 {
            format!(
                "{TRANSFORM_HEALTH_LANE} lane advancing but erroring; in-flight={in_flight}; consecutive errors={consecutive_errors}"
            )
        } else if in_flight == 0 {
            format!("{TRANSFORM_HEALTH_LANE} lane advancing; idle; in-flight=0")
        } else {
            format!("{TRANSFORM_HEALTH_LANE} lane advancing; in-flight={in_flight}")
        };
        if let Some(historian) = last_historian_outcome.as_deref() {
            detail.push_str("; last historian: ");
            detail.push_str(historian);
        }
        HealthReport {
            status,
            detail: Some(detail),
            metrics: Some(json!({
                "lane": TRANSFORM_HEALTH_LANE,
                "state": state,
                "stuck": stale,
                "last_dispatch_started_at_ms": started,
                "last_dispatch_completed_at_ms": completed,
                "in_flight_count": in_flight,
                "consecutive_error_count": consecutive_errors,
                "completion_lag_ms": completion_lag_ms,
                "heartbeat_age_ms": heartbeat_age_ms,
                "heartbeat_stale": heartbeat_stale,
                "oldest_queued_age_ms": oldest_queued_age_ms,
                "queue_stale": queue_stale,
                "stale": stale,
                "stale_age_ms": stale_age_ms,
                "last_historian_outcome": last_historian_outcome,
                "historian_recent_decisions_count": historian_recent_decisions_count,
            })),
        }
    }
}

/// Publish the compile-time byte epochs even while storage is opening or failed.
fn with_pinned_epochs_health(mut report: HealthReport) -> HealthReport {
    let metrics = report.metrics.get_or_insert_with(|| json!({}));
    let metrics = metrics.as_object_mut().expect("health metrics object");
    metrics.insert(
        "profile_epoch_claude_code_anthropic".into(),
        json!(PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC),
    );
    metrics.insert("tagger_feature_epoch".into(), json!(TAGGER_FEATURE_EPOCH));
    metrics.insert(
        "memory_render_format_epoch".into(),
        json!(MEMORY_RENDER_FORMAT_EPOCH),
    );
    metrics.insert(
        "compartment_render_format_epoch".into(),
        json!(COMPARTMENT_RENDER_FORMAT_EPOCH),
    );
    metrics.insert(
        "build_sha".into(),
        json!(option_env!("MC_BUILD_SHA")
            .map(str::trim)
            .filter(|sha| !sha.is_empty())),
    );
    report
}

#[cfg(test)]
#[test]
fn health_exposes_pinned_epochs_and_build_sha() {
    let report = with_pinned_epochs_health(DISPATCH_HEALTH.report(0));
    let metrics = report.metrics.unwrap();
    assert_eq!(
        metrics["profile_epoch_claude_code_anthropic"],
        json!(PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC)
    );
    assert_eq!(metrics["tagger_feature_epoch"], json!(TAGGER_FEATURE_EPOCH));
    assert_eq!(
        metrics["memory_render_format_epoch"],
        json!(MEMORY_RENDER_FORMAT_EPOCH)
    );
    assert_eq!(
        metrics["compartment_render_format_epoch"],
        json!(COMPARTMENT_RENDER_FORMAT_EPOCH)
    );
    assert_eq!(
        metrics["build_sha"],
        json!(option_env!("MC_BUILD_SHA")
            .map(str::trim)
            .filter(|sha| !sha.is_empty()))
    );
}

static DISPATCH_HEALTH: DispatchHealth = DispatchHealth::new();

/// Render-config epoch members, co-owned with the byte-splice consumer (thalamus gateway).
/// Consumers fold these into the opaque render_config string they populate per
/// request; the module compares render_config as opaque bytes against durable state
/// and forces a HARD fold on any change. Bumping an epoch here is therefore the
/// coordinated-deploy mechanism for byte-affecting behavior flips: every in-flight
/// session folds once on the same lineage instead of straddling the feature boundary.
/// Consumers read these at attach via the status op and refuse to serve on mismatch
/// with their hardcoded fallbacks, so a diverged epoch map cannot silently skip the
/// safety fold.
/// Bumps when the shared project-memory render changes. Epoch 1 is the compact,
/// category-grouped `#id: fact` format; epoch 3 applies reinforcement recency when
/// an importance band exceeds the render budget. Applies to every serializer profile.
pub const MEMORY_RENDER_FORMAT_EPOCH: u32 = 3;
/// Bumps when the shared compartment render changes. Epoch 1 replaces rendered
/// `<compartment>` elements with markdown headings in m0 and m1; epoch 2 sanitizes
/// historian-authored titles before placing them inside the session-history wrapper.
pub const COMPARTMENT_RENDER_FORMAT_EPOCH: u32 = 2;
/// Bumps for provider-visible byte changes local to the claude-code-anthropic profile,
/// without invalidating other profiles. Epoch 1 includes covered system messages in m0 instead of sending them as
/// separate system-role messages. Epoch 2 flips the profile to full-array tail reclaim
/// (the Thalamus peer retired the byte-splice at U0), so tool-absent sessions gain the
/// age/pressure tail reclaim they never had; the bump forces one self-coordinated HARD
/// fold on the first pass under the new binary, per the epoch contract above. Epoch 3 tags
/// completed assistant text on first sight even when protected from other mutations.
pub const PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC: u32 = 3;
/// Bumps for provider-visible byte changes local to OpenCode's AI SDK codec. Epoch 1
/// promotes valid text attachments from opaque to text and demotes malformed media-shaped
/// attachments to opaque so their retained ingress representation is replayed verbatim. Epoch 2
/// prevents a tag first discovered after serve from appearing until an independent bust.
pub const PROFILE_EPOCH_OPENCODE_AI_SDK: u32 = 2;
/// Bumps for provider-visible byte changes local to Pi's codec. Epoch 1 demotes malformed
/// text, image, and file result children to opaque so their retained ingress representation
/// is replayed verbatim.
pub const PROFILE_EPOCH_PI: u32 = 1;
/// Bumps for tagger-wide provider-visible byte changes across active tagging surfaces.
/// Profile-local changes belong in that profile's render epoch instead, so unchanged
/// profiles do not pay a collateral HARD. Epoch 3 freezes temporal-marker decisions in
/// durable rows. Epoch 4 is global on purpose: every profile's skeleton input bytes change
/// from clamped real arguments to the inert dropped marker. Every bump requires a
/// cache-breaking fold; inactive requests omit this component and retain their identity.
pub const TAGGER_FEATURE_EPOCH: u32 = 4;

/// The module-owned rendered-prefix format epoch for a serializer profile.
///
/// Profile-local rendered-byte epochs slot in here so the module folds them into
/// its effective render_config even when a consumer sends a static base render_config.
pub const fn profile_render_epoch(profile: SerializerProfile) -> u32 {
    match profile {
        SerializerProfile::ClaudeCodeAnthropic => PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC,
        SerializerProfile::OpencodeAiSdk => PROFILE_EPOCH_OPENCODE_AI_SDK,
        SerializerProfile::Pi => PROFILE_EPOCH_PI,
        SerializerProfile::OwnedLlmRunner | SerializerProfile::OwnedBroca => 0,
    }
}

/// Normalize the request-local Claude Code surface signal once. This remains limited to
/// Claude Code mechanics such as the Thalamus acknowledgement contract and guidance variant.
pub const fn cc_u1_active(profile: Option<SerializerProfile>, tool_present: bool) -> bool {
    matches!(profile, Some(SerializerProfile::ClaudeCodeAnthropic)) && tool_present
}

/// Return whether the provider-visible tagging and reduction overlay may be enabled.
/// OpenCode and Broca-hosted sessions use the same overlay when their tool array
/// exposes ctx_reduce.
pub const fn tagging_surface_active(
    profile: Option<SerializerProfile>,
    tool_present: bool,
) -> bool {
    matches!(
        profile,
        Some(
            SerializerProfile::ClaudeCodeAnthropic
                | SerializerProfile::OpencodeAiSdk
                | SerializerProfile::OwnedBroca
        )
    ) && tool_present
}

/// The tagger component of the effective render identity. A false request contributes
/// no component, preserving the render identity used before the capability existed.
pub const fn tagger_feature_epoch(tagging_surface_active: bool) -> u32 {
    if tagging_surface_active {
        TAGGER_FEATURE_EPOCH
    } else {
        0
    }
}

/// Storage namespace for the cache-state domain.
const STORAGE_NAMESPACE: &str = "mc_cache";
/// Matches the default OpenCode protected tag window. The Claude Code facade has no
/// request-local transform config, so acknowledgement validation uses the durable tag
/// ordering with the same default recency window as an omitted transform field.
/// Mirrors packages/plugin/src/config/schema/magic-context.ts commit_cluster_trigger.enabled default.
const DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED: bool = true;
/// Mirrors packages/plugin/src/config/schema/magic-context.ts commit_cluster_trigger.min_clusters default.
const DEFAULT_MIN_COMMIT_CLUSTERS: usize = 3;
/// TypeScript evaluates every nonempty eligible chunk after trigger checks. Rust keeps
/// this minimum at zero so it does not impose an additional minimum-token requirement.
const DEFAULT_HISTORIAN_MIN_CHUNK_TOKENS: usize = 0;
/// Maximum number of newly published compartments returned by one status page.
/// After a historian abandon, suppress refires for this long so a persistently
/// failing model does not burn a full summarization pass on every transform.
const HISTORIAN_FAILURE_BACKOFF_MS: i64 = historian::HISTORIAN_FAILURE_BACKOFF_MS;
const SESSION_UNRESOLVED_MESSAGE: &str = "session unresolved; launch Claude Code through the CortexKit wrapper so ctx_* can bind to this conversation";
/// OpenCode's Rust-mode tool route binds the real harness session, unlike the Claude Code
/// wrapper route whose binding is an instance-token namespace.
const OPENCODE_HARNESS: &str = "opencode";
const SUBC_FRAME_BODY_HEADROOM_BYTES: usize = 16 * 1024 * 1024;
const BOUNDARY_TOKEN_CACHE_BUDGET_BYTES: usize = 16 * 1024 * 1024;
const WRAPUP_REQUEST_MARGIN: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize)]
struct ModuleCompartmentWire {
    sequence: i64,
    start_message: i64,
    end_message: i64,
    #[serde(default)]
    start_message_id: String,
    #[serde(default)]
    end_message_id: String,
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    end_date: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    p1: Option<String>,
    #[serde(default)]
    p2: Option<String>,
    #[serde(default)]
    p3: Option<String>,
    #[serde(default)]
    p4: Option<String>,
    #[serde(default = "default_importance")]
    importance: i32,
    #[serde(default)]
    episode_type: Option<String>,
    #[serde(default)]
    legacy: i32,
    #[serde(default)]
    created_at: i64,
}

fn default_importance() -> i32 {
    50
}

struct FacadeScope {
    /// MC project identity for module-store reads and writes.
    memory_project_path: String,
    /// Daemon-bound filesystem path retained only for route-vocabulary enforcement.
    route_project_root: String,
    conversation_key: String,
    /// The conversation is an asynchronous compaction conversation, so its
    /// history tools take the async lane.
    async_conversation: bool,
    memory_enabled: bool,
    /// Why memory is paused for this route, when its project identity is unavailable.
    memory_paused: Option<String>,
}

/// The project a route's history is keyed by. See [`McHandler::route_project`].
#[derive(Clone)]
struct RouteProject {
    key: String,
    /// The reason memory features are paused, when the route has no project identity.
    memory_paused: Option<String>,
}

/// Identity state belongs to a channel, not a session or directory: a fresh binding
/// may adopt a newer host decision without changing an already-served prefix.
#[derive(Default)]
struct BindingProject {
    initial: Option<Result<String, project_identity::ProjectIdentityError>>,
    served: Option<RouteProject>,
    mismatch_logged: bool,
}

impl RouteProject {
    fn resolved(key: String) -> Self {
        Self {
            key,
            memory_paused: None,
        }
    }
}

impl From<ModuleCompartmentWire> for StoredCompartment {
    fn from(value: ModuleCompartmentWire) -> Self {
        StoredCompartment {
            sequence: value.sequence,
            start_message: value.start_message,
            end_message: value.end_message,
            start_message_id: value.start_message_id,
            end_message_id: value.end_message_id,
            start_date: value.start_date,
            end_date: value.end_date,
            title: value.title,
            content: value.content,
            p1: value.p1,
            p2: value.p2,
            p3: value.p3,
            p4: value.p4,
            importance: value.importance,
            episode_type: value.episode_type,
            legacy: value.legacy,
            created_at: value.created_at,
        }
    }
}

impl TransformRequest {
    /// Prefer the request's host-resolved threshold. `None` specifically means an older host did
    /// not send the field, so the caller's trusted config remains the compatibility fallback.
    fn execute_threshold_or(&self, fallback: f64) -> f64 {
        self.effective_execute_threshold.unwrap_or(fallback)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundaryTokenCacheEntry {
    byte_size: usize,
    content_hash: [u8; 32],
    token_count: usize,
}

#[derive(Debug, Clone, Default)]
struct BoundaryTokenCacheSnapshot {
    entries: Arc<HashMap<String, BoundaryTokenCacheEntry>>,
    entry_updates: HashMap<String, BoundaryTokenCacheEntry>,
    formatted_tokens: Arc<HashMap<[u8; 32], usize>>,
    formatted_token_updates: HashMap<[u8; 32], usize>,
    active_ids: Option<HashSet<String>>,
    hits: usize,
    misses: usize,
}

impl BoundaryTokenCacheSnapshot {
    fn token_count(&mut self, block_id: &str, bytes: &str, content_hash: &[u8; 32]) -> usize {
        // Block ids survive replay and same-length content edits are valid for live-tail blocks,
        // so length alone cannot prove that a cached token count still describes these bytes.
        // The projection computes this digest once and retains it on the block, avoiding a second
        // full payload hash when the token cache entry is still valid.
        if let Some(entry) = self
            .entry_updates
            .get(block_id)
            .or_else(|| self.entries.get(block_id))
        {
            if entry.byte_size == bytes.len() && entry.content_hash == *content_hash {
                self.hits = self.hits.saturating_add(1);
                return entry.token_count;
            }
        }
        let token_count = mc_tokenizer::estimate_tokens(bytes);
        self.misses = self.misses.saturating_add(1);
        self.entry_updates.insert(
            block_id.to_string(),
            BoundaryTokenCacheEntry {
                byte_size: bytes.len(),
                content_hash: *content_hash,
                token_count,
            },
        );
        token_count
    }

    fn formatted_token_count(&mut self, bytes: &str) -> usize {
        let content_hash: [u8; 32] = Sha256::digest(bytes.as_bytes()).into();
        if let Some(token_count) = self
            .formatted_token_updates
            .get(&content_hash)
            .or_else(|| self.formatted_tokens.get(&content_hash))
        {
            return *token_count;
        }
        let token_count = mc_tokenizer::estimate_tokens(bytes);
        self.formatted_token_updates
            .insert(content_hash, token_count);
        token_count
    }

    fn retain_projection(&mut self, projection: &crate::ck_wire::FlatProjection) {
        let active_count = projection
            .blocks
            .iter()
            .filter(|block| !block.synthetic)
            .count();
        let added_ids = self
            .entry_updates
            .keys()
            .filter(|block_id| !self.entries.contains_key(block_id.as_str()))
            .count();
        if self.entries.len().saturating_add(added_ids) <= active_count {
            return;
        }
        self.active_ids = Some(
            projection
                .blocks
                .iter()
                .filter(|block| !block.synthetic)
                .map(|block| block.id.clone())
                .collect(),
        );
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        boundary_token_maps_retained_bytes(
            self.entries.iter().chain(self.entry_updates.iter()),
            self.formatted_tokens.len() + self.formatted_token_updates.len(),
        )
    }

    fn materialize(
        self,
    ) -> (
        HashMap<String, BoundaryTokenCacheEntry>,
        HashMap<[u8; 32], usize>,
    ) {
        let mut entries =
            Arc::try_unwrap(self.entries).unwrap_or_else(|entries| (*entries).clone());
        entries.extend(self.entry_updates);
        if let Some(active_ids) = self.active_ids {
            entries.retain(|block_id, _| active_ids.contains(block_id));
        }
        let mut formatted_tokens = Arc::try_unwrap(self.formatted_tokens)
            .unwrap_or_else(|formatted_tokens| (*formatted_tokens).clone());
        formatted_tokens.extend(self.formatted_token_updates);
        (entries, formatted_tokens)
    }
}

fn boundary_token_maps_retained_bytes<'a>(
    entries: impl Iterator<Item = (&'a String, &'a BoundaryTokenCacheEntry)>,
    formatted_token_count: usize,
) -> usize {
    let source_bytes = entries
        // Include a conservative per-entry allowance for the HashMap bucket and owned key.
        .map(|(block_id, _)| block_id.len() + std::mem::size_of::<BoundaryTokenCacheEntry>() + 64)
        .sum::<usize>();
    source_bytes
        + formatted_token_count
            * (std::mem::size_of::<[u8; 32]>() + std::mem::size_of::<usize>() + 64)
}

#[derive(Debug)]
struct BoundaryTokenCacheSession {
    retained_bytes: usize,
    entries: Arc<HashMap<String, BoundaryTokenCacheEntry>>,
    formatted_tokens: Arc<HashMap<[u8; 32], usize>>,
}

#[derive(Debug)]
struct BoundaryTokenCache {
    sessions: HashMap<String, BoundaryTokenCacheSession>,
    lru: VecDeque<String>,
    retained_bytes: usize,
    max_retained_bytes: usize,
}

impl BoundaryTokenCache {
    fn new(max_retained_bytes: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            lru: VecDeque::new(),
            retained_bytes: 0,
            max_retained_bytes,
        }
    }

    fn prime_from_persisted_tags(&mut self, session_id: &str, tags: &[mc_store::McTagRow]) {
        if self.sessions.contains_key(session_id) || tags.is_empty() {
            return;
        }
        let entries = tags
            .iter()
            .filter_map(|tag| {
                usize::try_from(tag.token_count).ok().map(|token_count| {
                    (
                        tag.block_id.clone(),
                        BoundaryTokenCacheEntry {
                            byte_size: tag.source_bytes.len(),
                            content_hash: Sha256::digest(&tag.source_bytes).into(),
                            token_count,
                        },
                    )
                })
            })
            .collect::<HashMap<_, _>>();
        let retained_bytes = boundary_token_maps_retained_bytes(entries.iter(), 0);
        if entries.is_empty() || retained_bytes > self.max_retained_bytes {
            return;
        }
        self.retained_bytes = self.retained_bytes.saturating_add(retained_bytes);
        self.sessions.insert(
            session_id.to_string(),
            BoundaryTokenCacheSession {
                retained_bytes,
                entries: Arc::new(entries),
                formatted_tokens: Arc::default(),
            },
        );
        self.lru.push_back(session_id.to_string());
        while self.retained_bytes > self.max_retained_bytes {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(session) = self.sessions.remove(&oldest) {
                self.retained_bytes = self.retained_bytes.saturating_sub(session.retained_bytes);
            }
        }
    }

    fn remove(&mut self, session_id: &str) {
        if let Some(session) = self.sessions.remove(session_id) {
            self.retained_bytes = self.retained_bytes.saturating_sub(session.retained_bytes);
        }
        self.lru.retain(|candidate| candidate != session_id);
    }

    fn snapshot(&mut self, session_id: &str) -> BoundaryTokenCacheSnapshot {
        let (entries, formatted_tokens) = self
            .sessions
            .get(session_id)
            .map(|session| {
                (
                    Arc::clone(&session.entries),
                    Arc::clone(&session.formatted_tokens),
                )
            })
            .unwrap_or_default();
        if !entries.is_empty() || !formatted_tokens.is_empty() {
            self.lru.retain(|candidate| candidate != session_id);
            self.lru.push_back(session_id.to_string());
        }
        BoundaryTokenCacheSnapshot {
            entries,
            formatted_tokens,
            ..BoundaryTokenCacheSnapshot::default()
        }
    }

    fn replace(&mut self, session_id: &str, snapshot: BoundaryTokenCacheSnapshot) {
        // Drop the session's Arc owners before materializing. On the ordinary single-flight path,
        // Arc::try_unwrap then applies only the suffix updates instead of cloning every cached key.
        self.remove(session_id);
        let (entries, formatted_tokens) = snapshot.materialize();
        let retained_bytes =
            boundary_token_maps_retained_bytes(entries.iter(), formatted_tokens.len());
        if (entries.is_empty() && formatted_tokens.is_empty())
            || retained_bytes > self.max_retained_bytes
        {
            return;
        }
        self.retained_bytes = self.retained_bytes.saturating_add(retained_bytes);
        self.sessions.insert(
            session_id.to_string(),
            BoundaryTokenCacheSession {
                retained_bytes,
                entries: Arc::new(entries),
                formatted_tokens: Arc::new(formatted_tokens),
            },
        );
        self.lru.push_back(session_id.to_string());
        while self.retained_bytes > self.max_retained_bytes {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(session) = self.sessions.remove(&oldest) {
                self.retained_bytes = self.retained_bytes.saturating_sub(session.retained_bytes);
            }
        }
    }
}

#[derive(Clone)]
struct RuntimeStoreError {
    code: String,
    message: String,
    at_ms: i64,
}

/// The module handler. Holds the single store handle (opened once in `on_hello_ack`)
/// and the per-route session bindings (route channel → {project, session}).
pub struct McHandler {
    agent_data: Option<agent_data::AgentDataService>,
    app_channels: Mutex<HashMap<u16, app_read::admission::AppCaller>>,
    move_visibility: Arc<agent_data::MoveVisibility>,
    registered_module_id: String,
    store: Arc<OnceLock<Arc<McStore>>>,
    log_directory: Option<PathBuf>,
    store_open: Arc<StoreOpenCoordinator>,
    producer_factory: Arc<dyn HistorianProducerFactory>,
    session_resolver: Arc<dyn SessionResolver>,
    retrieval_reranker: Option<Arc<dyn retrieval::hybrid::RerankClient>>,
    config: Arc<Mutex<ConfigCache>>,
    historian_runner_refusals: Arc<HistorianRunnerRefusalCache>,
    /// Live Broca dream children, keyed by the Broca session each one runs in.
    /// A memory tool the runner dispatches on such a session reaches the task's
    /// router only through this record, never the foreground facade.
    broca_dream_tools: Arc<dream_dispatch::broca_carrier::BrocaToolRoute>,
    /// The Rust dreamer's projects, timer and transports; see `dream_dispatch::tick`.
    dream_runs: Arc<dream_dispatch::tick::DreamRuns>,
    /// Which runner each session's most recent historian and dreamer completion
    /// used in this process, and why. Read by the status and health surfaces.
    runner_choices: Arc<Mutex<runner_choices::RunnerChoiceLog>>,
    /// Project identities of route roots whose session the host has not recorded.
    project_identities: Arc<project_identity::ProjectIdentityResolver>,
    entorhinal: entorhinal_resolve::EntorhinalResolver,
    binding_projects: Mutex<HashMap<u16, BindingProject>>,
    active_project_roots: Mutex<HashMap<String, PathBuf>>,
    /// Route roots inside a git checkout whose identity git could not give, with the
    /// reason. Their history keeps being served, but every memory feature is paused until
    /// a later request resolves the identity (see [`McHandler::route_project`]).
    memory_paused_routes: Arc<Mutex<HashMap<PathBuf, String>>>,
    /// Tests bind routes to paths that do not exist and key their rows by that path, so
    /// the resolver is used only when a test asks for it.
    #[cfg(test)]
    resolve_project_identity_for_test: AtomicBool,
    #[cfg(test)]
    fixed_config: Option<McModuleConfig>,
    #[cfg(test)]
    fixed_dream_settings: Option<Value>,
    /// Trusted settings the provider historian resolves its models from when no host
    /// sent a chain. Tests never read the environment's config; unset means `{}`.
    #[cfg(test)]
    fixed_historian_settings: Option<Value>,
    /// Replaces the production executor wiring in fixtures, so publication can be
    /// exercised for tasks this build does not yet run.
    #[cfg(test)]
    dream_wiring: Option<dream_dispatch::ownership::Wiring>,
    reattaching_sessions: Arc<Mutex<HashSet<String>>>,
    live_historian_sessions: Arc<Mutex<HashMap<String, LiveHistorianSession>>>,
    wrapup_sessions: Arc<Mutex<HashMap<String, LiveWrapupSession>>>,
    recomp_sessions: Arc<Mutex<HashSet<String>>>,
    serialized_outputs: Mutex<SerializedOutputCache>,
    boundary_tokens: Arc<Mutex<BoundaryTokenCache>>,
    guidance_dates: Mutex<HashMap<String, String>>,
    prompt_surface_epochs: Mutex<HashMap<String, PromptSurfaceSelection>>,
    /// Route channels whose consumer declared it speaks `tool-provider/v1` at bind
    /// (`role_versions`). Only those get the role's refusal codes; every other route
    /// keeps the legacy facade errors byte for byte.
    tool_provider_v1_channels: Mutex<HashSet<u16>>,
    /// The last full catalog fetched with a composition for each bound session.
    /// Preflight and digest probes cannot overwrite the session's admitted tools.
    frozen_tool_catalogs: Mutex<HashMap<(PathBuf, String), tool_catalog::FrozenCatalog>>,
    provider_store: Arc<providers::Storage>,
    provider_serial: Arc<providers::ProviderSerial>,
    provider_runner: Arc<dyn session_resolver::ProviderRunner>,
    historian_model_catalog: Arc<providers::HistorianModelCatalog>,
    provider_historian_worker: OnceLock<Arc<McHandler>>,
    provider_historian_budget: Arc<providers::historian_budget::Budget>,
    provider_historian_evaluations: Arc<Mutex<HashSet<String>>>,
    #[cfg(test)]
    provider_historian_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    #[cfg(test)]
    provider_historian_ingest_pause: Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
    #[cfg(test)]
    provider_historian_scan_rows: Arc<AtomicU64>,
    #[cfg(test)]
    guidance_now_ms: Mutex<Option<i64>>,
    #[cfg(test)]
    reduction_injection: Mutex<HashMap<String, Vec<ReductionDecision>>>,
    #[cfg(test)]
    wrapup_operation_budget: Mutex<Option<Duration>>,
    #[cfg(test)]
    unknown_module_retry_delay: Mutex<Option<Duration>>,
    #[cfg(test)]
    status_snapshot_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    classification_before_apply_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    connect_failure_commit_hook: ConnectFailureCommitHook,
    /// Route channel → its session binding. Populated at `on_bind`, removed at
    /// `on_route_gone`. The SDK validates the route handle's epoch before dispatching a
    /// request, so a channel key cannot resolve a stale route. A `Mutex<HashMap>` (not a
    /// lock-free map) is appropriate because writes are rare (once per route open/close)
    /// and reads are one cheap lookup per transform.
    bindings: Mutex<HashMap<u16, SessionBinding>>,
    threshold_logged_routes: Mutex<HashSet<u16>>,
    /// Validated transform channel → (session, route root). The root is part of provenance;
    /// a cache row for the same session cannot authenticate a facade opened on another root.
    transform_route_channels: Mutex<HashMap<u16, (String, PathBuf)>>,
    /// Roots previously observed on a validated transform for each session. This survives route
    /// teardown so durable cache state remains usable only along an authenticated route lineage.
    transform_session_roots: Mutex<HashMap<String, HashSet<PathBuf>>>,
    /// Module-minted zero-tool dreamer sessions. Prefixes are diagnostics only;
    /// only registered ids may bypass transform after route validation.
    active_dreamer_runs: Arc<Mutex<HashSet<String>>>,
    /// Back-compat facade callers may omit the host tool-call id. Warn once per resolved session
    /// while the transport shim is upgraded, without rejecting the mutation.
    missing_facade_command_id_sessions: Mutex<HashSet<String>>,
    runtime_store_errors: Mutex<HashMap<String, RuntimeStoreError>>,
}

#[async_trait]
pub trait HistorianProducerFactory: Send + Sync {
    async fn connect(
        &self,
        project_root: &Path,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError>;

    /// Connect a producer to the runner route selected for this conversation. Each run
    /// uses a child session; `identity` supplies the conversation's project root and
    /// Setup harness for binding that child. A factory that cannot reach the runner
    /// must refuse rather than use the configured runner.
    async fn connect_session_runner(
        &self,
        _identity: &session_resolver::RunnerBindIdentity,
        route: &SessionRunnerRoute,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        Err(HistorianProducerError::Subc(
            historian_producer::ProducerErrorBody::untagged(
                "session_runner_unavailable",
                format!(
                    "no session runner transport for module {}",
                    route.module_id()
                ),
            ),
        ))
    }
}

/// The route a runner-lane conversation's background model calls take, or `None`
/// for a conversation that keeps the configured runner (it is not on a runner lane,
/// or the user explicitly configured `broca`). See
/// [`SessionRunnerRoute::for_background_call`].
pub(crate) fn session_runner_route(
    binding: &SessionBinding,
    resolved: historian_runner::ResolvedRunner,
) -> Option<SessionRunnerRoute> {
    SessionRunnerRoute::for_background_call(binding.principal.as_ref(), &binding.session, resolved)
}

struct RealHistorianProducerFactory {
    connection_file: PathBuf,
    route_targets: RouteTargetConfig,
}

fn session_runner_historian_config(
    connection_file: PathBuf,
    route_targets: RouteTargetConfig,
    identity: &session_resolver::RunnerBindIdentity,
) -> HistorianProducerConfig {
    HistorianProducerConfig {
        handshake_timeout: Duration::from_secs(2),
        route_targets,
        ..HistorianProducerConfig::new(
            connection_file,
            identity.project_root.clone(),
            identity.harness.clone(),
        )
    }
}

#[async_trait]
impl HistorianProducerFactory for RealHistorianProducerFactory {
    async fn connect(
        &self,
        project_root: &Path,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        Ok(Box::new(
            HistorianProducer::connect(HistorianProducerConfig {
                handshake_timeout: Duration::from_secs(2),
                route_targets: self.route_targets.clone(),
                ..HistorianProducerConfig::new(
                    self.connection_file.clone(),
                    project_root,
                    "opencode",
                )
            })
            .await?,
        ))
    }

    async fn connect_session_runner(
        &self,
        identity: &session_resolver::RunnerBindIdentity,
        route: &SessionRunnerRoute,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        Ok(Box::new(
            HistorianProducer::connect_to_session_runner(
                session_runner_historian_config(
                    self.connection_file.clone(),
                    self.route_targets.clone(),
                    identity,
                ),
                route.clone(),
            )
            .await?,
        ))
    }
}

struct MissingProducerFactory;

struct DreamerRunGuard {
    registry: Arc<Mutex<HashSet<String>>>,
    session_id: String,
}

impl Drop for DreamerRunGuard {
    fn drop(&mut self) {
        self.registry
            .lock()
            .expect("dreamer registry mutex")
            .remove(&self.session_id);
    }
}

struct StringSetGuard {
    sessions: Arc<Mutex<HashSet<String>>>,
    session_id: String,
}

impl Drop for StringSetGuard {
    fn drop(&mut self) {
        self.sessions
            .lock()
            .expect("session set mutex")
            .remove(&self.session_id);
    }
}

type LiveHistorianCompletionWait = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Clone)]
struct LiveHistorianSession {
    token: Arc<()>,
    completion: Arc<Notify>,
}

struct SessionSetGuard {
    sessions: Arc<Mutex<HashMap<String, LiveHistorianSession>>>,
    session_id: String,
    token: Arc<()>,
    completion: Arc<Notify>,
}

impl Drop for SessionSetGuard {
    fn drop(&mut self) {
        let mut sessions = self.sessions.lock().expect("session set mutex");
        self.completion.notify_waiters();
        let matches_current = sessions
            .get(&self.session_id)
            .is_some_and(|live| Arc::ptr_eq(&live.token, &self.token));
        if matches_current {
            sessions.remove(&self.session_id);
        }
    }
}

enum LiveHistorianSessionClaim {
    Acquired(SessionSetGuard),
    Busy(LiveHistorianCompletionWait),
}

struct PreparedHistorianFiring {
    task: HistorianFiringTask,
}

fn historian_no_fire_detail(
    kind: &str,
    cause: HistorianNoFireCause,
    extra: Option<&str>,
) -> String {
    let suffix = extra
        .filter(|value| !value.is_empty())
        .map(|value| format!(",{value}"))
        .unwrap_or_default();
    format!(
        "{kind}{{raw_cause={},canonical_cause={}{suffix}}}",
        cause.raw_cause(),
        cause.canonical_cause(),
    )
}

struct NoFireDiagnosticsInput<'a> {
    no_fire: String,
    detail_kind: &'a str,
    cause: HistorianNoFireCause,
    extra: Option<&'a str>,
    reason: Option<String>,
    state: String,
    progress: Option<transform::HistorianTriggerProgress>,
    last_failure: Option<String>,
}

fn historian_no_fire_diagnostics(input: NoFireDiagnosticsInput<'_>) -> HistorianDiagnostics {
    let NoFireDiagnosticsInput {
        no_fire,
        detail_kind,
        cause,
        extra,
        reason,
        state,
        progress,
        last_failure,
    } = input;
    HistorianDiagnostics {
        fired: false,
        reason,
        no_fire: Some(no_fire),
        no_fire_detail: Some(historian_no_fire_detail(detail_kind, cause, extra)),
        canonical_cause: Some(cause.canonical_cause().to_string()),
        state,
        progress,
        last_failure,
    }
}

enum PreparedHistorianAction {
    Complete(HistorianDiagnostics),
    Busy {
        completion: LiveHistorianCompletionWait,
    },
    FireReady(Box<PreparedHistorianFiring>),
}

#[derive(Clone)]
struct HistorianDecisionContext {
    at_ms: i64,
    request_observed_at_ms: i64,
    pressure_pct: u16,
    drain_latch: bool,
    chunk_range: Option<HistorianChunkRange>,
    eligible_tokens: Option<u64>,
    bar_tokens: Option<u64>,
}

impl HistorianDecisionContext {
    fn from_request(
        parsed: &TransformRequest,
        meta: &mc_store::ModuleMeta,
        now: i64,
        pressure: f64,
    ) -> Self {
        Self {
            at_ms: now,
            request_observed_at_ms: parsed
                .request_observed_at_ms
                .and_then(|observed| i64::try_from(observed).ok())
                .unwrap_or(now),
            pressure_pct: quantize_pressure_pct(pressure),
            drain_latch: meta.emergency_drain_active,
            chunk_range: None,
            eligible_tokens: None,
            bar_tokens: None,
        }
    }

    fn recent_decision(
        &self,
        decision: HistorianDecision,
        cause: String,
        progress: Option<&transform::HistorianTriggerProgress>,
    ) -> HistorianRecentDecision {
        HistorianRecentDecision {
            at_ms: self.at_ms,
            request_observed_at_ms: self.request_observed_at_ms,
            decision,
            cause,
            eligible_tokens: self.eligible_tokens.unwrap_or_else(|| {
                progress.map_or(0, |progress| {
                    quantize_tokens(progress.eligible_chunk_tokens)
                })
            }),
            bar_tokens: self.bar_tokens.unwrap_or_else(|| {
                progress.map_or(0, |progress| quantize_tokens(progress.tail_size_bar))
            }),
            pressure_pct: self.pressure_pct,
            drain_latch: self.drain_latch,
            chunk_range: self.chunk_range.clone(),
            producer_model: None,
            completed_at_ms: None,
            apply_row_version: None,
        }
    }
}

fn quantize_tokens(tokens: f64) -> u64 {
    if tokens.is_finite() && tokens > 0.0 {
        tokens.round().min(u64::MAX as f64) as u64
    } else {
        0
    }
}

fn quantize_pressure_pct(pressure: f64) -> u16 {
    if pressure.is_finite() && pressure > 0.0 {
        pressure.round().min(u16::MAX as f64) as u16
    } else {
        0
    }
}

fn historian_trigger_rule(reason: boundary::TriggerReason) -> &'static str {
    match reason {
        boundary::TriggerReason::TailSize => "tail_size",
        boundary::TriggerReason::ProjectedHeadroom => "pressure",
        boundary::TriggerReason::CommitClusters => "commit_cluster",
        boundary::TriggerReason::ForceBand => "emergency",
    }
}

struct HistorianPrepareContext<'a> {
    /// A drain/provider supplies its start-time value; ordinary callers capture here.
    rust_background_enabled: Option<bool>,
    now: i64,
    publication_fence: Option<Arc<dyn historian::HistorianPublicationFence>>,
    /// An async evaluation's captured applied coverage, including an empty prefix.
    /// Other lanes continue resolving their coverage from the stored compartments.
    async_coverage: Option<Option<u64>>,
    reclaim_ride_available: bool,
    /// Whether the conversation is on a runner lane: its firings and restart
    /// reattach run on its own runner. Only the provider (runner-lane) path sets it.
    runner_lane: bool,
    timings: &'a mut HistorianTriggerTimings,
}

struct ReattachPublicationGuards {
    rust_background_enabled: bool,
    log_fence: Option<Arc<dyn historian::HistorianPublicationFence>>,
    session_runner: Option<SessionRunnerRoute>,
}

#[derive(Default)]
struct HistorianTriggerTimings {
    elapsed_ms: f64,
    boundary_build_ms: f64,
    trigger_eval_ms: f64,
    cache_store_ms: f64,
    token_cache_hits: usize,
    tokenized_blocks: usize,
}

struct HistorianTriggerTimer<'a> {
    started_at: Instant,
    timings: &'a mut HistorianTriggerTimings,
}

impl Drop for HistorianTriggerTimer<'_> {
    fn drop(&mut self) {
        self.timings.elapsed_ms += self.started_at.elapsed().as_secs_f64() * 1_000.0;
    }
}

struct WrapupPrepareContext {
    now: i64,
    project_path: String,
    allow_unknown_module_retry: bool,
    publication_fence: Option<Arc<dyn historian::HistorianPublicationFence>>,
}

#[derive(Clone)]
struct LiveWrapupSession {
    token: Arc<()>,
    rounds: usize,
}

struct WrapupSessionGuard {
    sessions: Arc<Mutex<HashMap<String, LiveWrapupSession>>>,
    session_id: String,
    token: Arc<()>,
}

impl Drop for WrapupSessionGuard {
    fn drop(&mut self) {
        let mut sessions = self.sessions.lock().expect("wrapup sessions mutex");
        let matches_current = sessions
            .get(&self.session_id)
            .is_some_and(|session| Arc::ptr_eq(&session.token, &self.token));
        if matches_current {
            sessions.remove(&self.session_id);
        }
    }
}

enum PreparedWrapupAction {
    FilteredNoiseSkipped,
    Busy(LiveHistorianCompletionWait),
    Nothing(String),
    FireReady(Box<HistorianFiringTask>),
    Failed(String),
}

#[derive(Debug)]
enum WrapupFiringError {
    Retryable(String),
    UnknownModule(String),
    Terminal { detail: String },
}

const TERMINAL_WRAPUP_FAILURE_PREFIX: &str = "mc-terminal-wrapup-failure:";

/// Wrapup refusal when the session's request carries no historian model chain: a
/// defect in whatever built the request, since every caller is expected to send one.
const WRAPUP_MODEL_CHAIN_MISSING: &str = "the session's transform carried no historian model chain";

fn terminal_wrapup_failure_fields(summary: &str) -> Option<(String, String, String)> {
    let encoded = summary.strip_prefix(TERMINAL_WRAPUP_FAILURE_PREFIX)?;
    let value: Value = serde_json::from_str(encoded).ok()?;
    Some((
        value.get("reason")?.as_str()?.to_string(),
        value.get("summary")?.as_str()?.to_string(),
        value.get("detail")?.as_str()?.to_string(),
    ))
}

type ConnectFailureCommitHook = Arc<Mutex<Option<Box<dyn FnMut() + Send>>>>;

type HistorianRunnerRefit = Box<
    dyn FnOnce(
            &McStore,
            runner_limits::RunnerLimits,
        ) -> Result<AssembledHistorianFiring, HistorianProducerError>
        + Send,
>;

fn historian_runner_refit(
    mut config: HistorianAssemblerConfig,
    messages: &[ck_wire::CkIngressMessage],
    projection: &ck_wire::FlatProjection,
    now: i64,
    provider: bool,
    wrapup: bool,
) -> HistorianRunnerRefit {
    let messages = messages.to_vec();
    let identities = projection.identity_by_mid.clone();
    let live: Vec<_> = projection
        .blocks
        .iter()
        .filter(|block| !block.synthetic)
        .cloned()
        .collect();
    Box::new(move |store, limits| {
        limits.historian_chain(&config.session_id, &mut config.model_chain)?;
        limits.fit_limits(
            &config.model_chain,
            &mut config.model_limits,
            config.historian_context_limit_tokens,
            config.max_output_tokens,
        )?;
        let assembler = if provider {
            historian_chunk::assemble_provider_historian_firing
        } else {
            assemble_historian_firing
        };
        match assembler(store, &messages, &live, &identities, config, now) {
            Ok(AssembleHistorianFiringOutcome::Fire(mut firing)) => {
                if wrapup {
                    firing.validate_options.force_keep_last_compartment = !firing.chunk.has_more;
                }
                Ok(*firing)
            }
            Ok(AssembleHistorianFiringOutcome::NoFire(reason)) => Err(runner_limits::refusal(
                format!("historian_runner_fit_refused: {reason:?}"),
            )),
            Err(error) => Err(runner_limits::refusal(format!(
                "historian_runner_fit_failed: {error}"
            ))),
        }
    })
}

struct HistorianFiringTask {
    rust_background_enabled: bool,
    store: Arc<McStore>,
    session_id: String,
    /// The route's harness label, stamped on rows the single-store writers produce.
    harness: String,
    language: Option<String>,
    historian_temperature: Option<f64>,
    historian_await_timeout: Duration,
    project_path: String,
    project_root: PathBuf,
    project_slug: String,
    firing: AssembledHistorianFiring,
    /// Rebuild from the same source snapshot only if runner discovery changes
    /// model eligibility or the output reserve. Discovery stays off the transform path.
    runner_refit: Option<HistorianRunnerRefit>,
    /// Which side runs the completion for this firing, resolved from config at
    /// the moment the firing was prepared so a config edit mid-run cannot move a
    /// firing already in flight to a different lane.
    runner: HistorianRunnerKind,
    /// Set for a runner-lane conversation: the completion runs on the
    /// conversation's own runner over llm-runner, never on the claim queue and
    /// never on the configured runner, whatever `runner` says.
    session_runner: Option<SessionRunnerRoute>,
    runner_identity: session_resolver::RunnerBindIdentity,
    model_chain_generation: u64,
    runner_refusal_cache: Arc<HistorianRunnerRefusalCache>,
    live_guard: SessionSetGuard,
    connect_failure_commit_hook: ConnectFailureCommitHook,
    publication_fence: Option<Arc<dyn historian::HistorianPublicationFence>>,
    provider_completion: Option<providers::RunCompletion>,
}

#[async_trait]
impl HistorianProducerFactory for MissingProducerFactory {
    async fn connect(
        &self,
        _project_root: &Path,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        Err(HistorianProducerError::NoEndpoint {
            path: PathBuf::from("<missing --subc>"),
        })
    }
}

fn retrieval_values<T: Default>(
    result: parity_contract::CapabilityResult<T>,
    source: &str,
    availability: &mut std::collections::BTreeMap<String, parity_contract::Availability>,
) -> T {
    use parity_contract::{Availability, CapabilityResult};
    let status = result.availability();
    if !availability
        .get(source)
        .is_some_and(|s| matches!(s, Availability::Unavailable { .. }))
    {
        availability.insert(source.into(), status);
    }
    match result {
        CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => value,
        CapabilityResult::Unavailable { .. } => T::default(),
    }
}

fn retrieval_key(candidate: &retrieval::hybrid::SearchCandidate) -> String {
    format!("{:?}:{}", candidate.hit.source, candidate.hit.source_id)
}

fn retrieval_candidate(
    source: parity_contract::RetrievalSource,
    source_id: String,
    ordinal: Option<u64>,
    text: String,
    score: f64,
    scope: &parity_contract::StoreScope,
) -> retrieval::hybrid::SearchCandidate {
    use parity_contract::*;
    retrieval::hybrid::SearchCandidate {
        hit: RetrievalHit {
            source,
            source_id: source_id.clone(),
            provenance: Provenance {
                origin: InputOrigin::Core,
                source_id,
                source_revision: "snapshot".into(),
                content_hash: ContentHash(format!(
                    "{:x}",
                    <sha2::Sha256 as sha2::Digest>::digest(text.as_bytes())
                )),
                generation: scope.generation,
                observed_at_ms: 0,
            },
            ordinal: ordinal.map(|value| MessageOrdinal {
                value,
                base: OrdinalBase::One,
            }),
            score,
            text,
        },
        compartment_range: None,
    }
}

/// Combine message and compartment ranks using reciprocal-rank fusion.
/// Covered messages add evidence to their compartment instead of appearing twice.
/// This produces fallback search results, not the larger pool sent to the reranker.
fn retrieval_merge_messages(
    messages: Vec<retrieval::hybrid::SearchCandidate>,
    compartments: Vec<retrieval::hybrid::SearchCandidate>,
    limit: usize,
) -> Vec<retrieval::hybrid::SearchCandidate> {
    if compartments.is_empty() {
        return messages;
    }
    if messages.is_empty() {
        return compartments;
    }
    let mut fused = compartments
        .iter()
        .enumerate()
        .map(|(rank, c)| (c.clone(), 1.0 / (60 + rank) as f64))
        .collect::<Vec<_>>();
    for (rank, message) in messages.into_iter().enumerate() {
        let containing = message.hit.ordinal.and_then(|o| {
            compartments.iter().find(|c| {
                c.compartment_range
                    .is_some_and(|(start, end)| o.value >= start && o.value <= end)
            })
        });
        let candidate = containing.unwrap_or(&message);
        if let Some(row) = fused
            .iter_mut()
            .find(|(c, _)| retrieval_key(c) == retrieval_key(candidate))
        {
            row.1 += 1.0 / (60 + rank) as f64;
        } else {
            fused.push((candidate.clone(), 1.0 / (60 + rank) as f64));
        }
    }
    fused.sort_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa).then(
            a.hit
                .ordinal
                .map(|o| o.value)
                .cmp(&b.hit.ordinal.map(|o| o.value)),
        )
    });
    fused.truncate(limit);
    let count = fused.len();
    fused
        .into_iter()
        .enumerate()
        .map(|(rank, (mut c, _))| {
            c.hit.score = 1.0 - rank as f64 / count as f64;
            c
        })
        .collect()
}

impl McHandler {
    pub fn new() -> Self {
        Self::new_with_connection_file(None)
    }

    /// Transcript access shared by compaction engines using the runner route.
    pub fn provider_runner(&self) -> &dyn session_resolver::ProviderRunner {
        self.provider_runner.as_ref()
    }

    pub fn new_with_connection_file(connection_file: Option<PathBuf>) -> Self {
        Self::new_with_connection_file_and_route_targets(
            connection_file,
            RouteTargetConfig::default(),
        )
    }

    pub fn new_with_connection_file_and_route_targets(
        connection_file: Option<PathBuf>,
        route_targets: RouteTargetConfig,
    ) -> Self {
        Self::new_with_connection_file_route_targets_and_module_id(
            connection_file,
            route_targets,
            DEFAULT_MODULE_ID.into(),
        )
    }

    pub fn new_with_connection_file_route_targets_and_module_id(
        connection_file: Option<PathBuf>,
        route_targets: RouteTargetConfig,
        module_id: String,
    ) -> Self {
        let dream_runs = Arc::new(dream_dispatch::tick::DreamRuns::new(
            connection_file.clone(),
            &route_targets,
        ));
        let retrieval_reranker = connection_file.as_ref().map(|path| {
            Arc::new(retrieval_store::RerankTransport {
                connection_file: path.clone(),
                target: route_targets
                    .target(route_targets::RegisteredRoute::SynapseRerank)
                    .expect("rerank route is registered"),
            }) as Arc<dyn retrieval::hybrid::RerankClient>
        });
        let producer_factory: Arc<dyn HistorianProducerFactory> = match connection_file.clone() {
            Some(path) => Arc::new(RealHistorianProducerFactory {
                connection_file: path,
                route_targets: route_targets.clone(),
            }),
            None => Arc::new(MissingProducerFactory),
        };
        let entorhinal = entorhinal_resolve::EntorhinalResolver::new(connection_file.clone());
        let session_resolver: Arc<dyn SessionResolver> = match connection_file {
            Some(ref path) => Arc::new(RealSessionResolver::new_with_route_targets(
                path.clone(),
                route_targets.clone(),
            )),
            None => Arc::new(MissingSessionResolver),
        };
        let move_visibility = Arc::new(agent_data::MoveVisibility::default());
        let agent_data = agent_data::ENABLED.then(|| {
            agent_data::AgentDataService::new(
                connection_file.clone(),
                module_id.clone(),
                Arc::clone(&move_visibility),
            )
        });
        let bus_connection_file = connection_file.clone();
        let provider_runner: Arc<dyn session_resolver::ProviderRunner> =
            match connection_file.as_ref() {
                Some(path) => Arc::new(session_resolver::RealProviderRunner::new(
                    path.clone(),
                    route_targets.clone(),
                )),
                None => Arc::new(session_resolver::MissingProviderRunner),
            };
        let historian_model_catalog =
            providers::HistorianModelCatalog::new(connection_file.clone(), route_targets);
        let store = Arc::new(OnceLock::new());
        let provider_store = Arc::new(providers::Storage::new(Arc::clone(&store)));
        *provider_store
            .async_runtime
            .connection_file
            .lock()
            .expect("bus connection file") = bus_connection_file;
        McHandler {
            agent_data,
            app_channels: Mutex::default(),
            move_visibility,
            registered_module_id: module_id,
            store,
            log_directory: None,
            store_open: Arc::new(StoreOpenCoordinator::new()),
            producer_factory,
            session_resolver,
            retrieval_reranker,
            config: Arc::new(Mutex::new(ConfigCache::default())),
            historian_runner_refusals: Arc::new(HistorianRunnerRefusalCache::default()),
            broca_dream_tools: Arc::new(dream_dispatch::broca_carrier::BrocaToolRoute::default()),
            dream_runs,
            runner_choices: Arc::new(Mutex::new(runner_choices::RunnerChoiceLog::default())),
            project_identities: Arc::new(project_identity::ProjectIdentityResolver::new()),
            entorhinal,
            binding_projects: Mutex::default(),
            active_project_roots: Mutex::default(),
            memory_paused_routes: Arc::default(),
            #[cfg(test)]
            resolve_project_identity_for_test: AtomicBool::new(false),
            #[cfg(test)]
            fixed_config: None,
            #[cfg(test)]
            fixed_dream_settings: None,
            #[cfg(test)]
            fixed_historian_settings: None,
            #[cfg(test)]
            dream_wiring: None,
            reattaching_sessions: Arc::new(Mutex::new(HashSet::new())),
            live_historian_sessions: Arc::new(Mutex::new(HashMap::new())),
            wrapup_sessions: Arc::new(Mutex::new(HashMap::new())),
            recomp_sessions: Arc::new(Mutex::new(HashSet::new())),
            serialized_outputs: Mutex::new(SerializedOutputCache::default()),
            boundary_tokens: Arc::new(Mutex::new(BoundaryTokenCache::new(
                BOUNDARY_TOKEN_CACHE_BUDGET_BYTES,
            ))),
            guidance_dates: Mutex::new(HashMap::new()),
            prompt_surface_epochs: Mutex::new(HashMap::new()),
            tool_provider_v1_channels: Mutex::new(HashSet::new()),
            frozen_tool_catalogs: Mutex::new(HashMap::new()),
            provider_store,
            provider_serial: Arc::new(providers::ProviderSerial::default()),
            provider_runner,
            historian_model_catalog,
            provider_historian_worker: OnceLock::new(),
            provider_historian_budget: providers::historian_budget::Budget::process(),
            provider_historian_evaluations: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            provider_historian_gate: Mutex::new(None),
            #[cfg(test)]
            provider_historian_ingest_pause: Mutex::new(None),
            #[cfg(test)]
            provider_historian_scan_rows: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            guidance_now_ms: Mutex::new(None),
            #[cfg(test)]
            reduction_injection: Mutex::new(HashMap::new()),
            #[cfg(test)]
            wrapup_operation_budget: Mutex::new(None),
            #[cfg(test)]
            unknown_module_retry_delay: Mutex::new(None),
            #[cfg(test)]
            status_snapshot_hook: Mutex::new(None),
            #[cfg(test)]
            classification_before_apply_hook: Mutex::new(None),
            connect_failure_commit_hook: Arc::new(Mutex::new(None)),
            bindings: Mutex::new(HashMap::new()),
            threshold_logged_routes: Mutex::new(HashSet::new()),
            transform_route_channels: Mutex::new(HashMap::new()),
            transform_session_roots: Mutex::new(HashMap::new()),
            active_dreamer_runs: Arc::new(Mutex::new(HashSet::new())),
            missing_facade_command_id_sessions: Mutex::new(HashSet::new()),
            runtime_store_errors: Mutex::new(HashMap::new()),
        }
    }

    /// Keep the logger's resolved directory so the HELLO_ACK store path can be checked
    /// against it; a mismatch would split module logs from the store's data directory.
    pub fn with_log_directory(mut self, directory: PathBuf) -> Self {
        self.log_directory = Some(directory);
        self
    }

    fn begin_store_open(&self, descriptor: StorageDescriptor, origin: DescriptorOrigin) {
        if self.store.get().is_some()
            || self
                .store_open
                .phase
                .compare_exchange(
                    STORE_OPEN_IDLE,
                    STORE_OPENING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
        {
            return;
        }

        self.store_open
            .begin_attempt(&descriptor, origin, now_ms().max(0) as u64);
        self.store_open.phase_changed.notify_waiters();
        self.store_open
            .active_waiters
            .fetch_add(1, Ordering::AcqRel);
        self.store_open
            .waiter_starts
            .fetch_add(1, Ordering::Relaxed);
        let store = Arc::clone(&self.store);
        let coordinator = Arc::clone(&self.store_open);
        let prime_serving_wal = true;
        tokio::spawn(async move {
            let _guard = StoreOpenWaiterGuard {
                coordinator: Arc::clone(&coordinator),
            };
            Self::run_store_open(store, coordinator, descriptor, prime_serving_wal).await;
        });
    }

    async fn run_store_open(
        store_slot: Arc<OnceLock<Arc<McStore>>>,
        coordinator: Arc<StoreOpenCoordinator>,
        descriptor: StorageDescriptor,
        prime_serving_wal: bool,
    ) {
        #[cfg(test)]
        {
            let gate = coordinator
                .open_gate
                .lock()
                .expect("store open test gate")
                .clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
        }
        let policy = *coordinator.policy.lock().expect("store open policy mutex");
        let mut last_lease_error = match Self::open_store_once(&descriptor, prime_serving_wal).await
        {
            Ok(opened) => {
                if coordinator.cancelled.load(Ordering::Acquire) {
                    coordinator.fail_and_idle(
                        STORE_OPEN_FAILURE_REASON_GENERIC,
                        "store open cancelled during shutdown".to_string(),
                        now_ms().max(0) as u64,
                    );
                    return;
                }
                let _ = store_slot.set(Arc::new(opened));
                coordinator.set_phase(STORE_OPENED);
                return;
            }
            Err(error) if store_open_error_is_live_lease(&error) => error,
            Err(error) => {
                tracing::error!("mc-module: store open failed: {error}");
                coordinator.fail_with_error_and_idle(&error, now_ms().max(0) as u64);
                return;
            }
        };

        let started = Instant::now();
        coordinator
            .wait_started_at_ms
            .store(now_ms().max(0) as u64, Ordering::Relaxed);
        coordinator.set_phase(STORE_OPEN_WAITING);
        tracing::warn!(
            "mc-module: storage lease held; waiting up to {}s for predecessor exit",
            STORE_LEASE_WAIT_WINDOW.as_secs()
        );

        let mut backoff = policy.initial_backoff;
        let mut attempt = 0usize;
        loop {
            let elapsed = started.elapsed();
            if coordinator.cancelled.load(Ordering::Acquire) {
                Self::abandon_lease_wait_on_shutdown(&coordinator, elapsed);
                return;
            }
            if elapsed >= policy.wait_window {
                tracing::error!(
                    "mc-module: storage lease wait expired after {:.2}s; store open failed: {last_lease_error}",
                    elapsed.as_secs_f64()
                );
                coordinator.fail_and_idle(
                    STORE_OPEN_FAILURE_REASON_GENERIC,
                    format!(
                        "storage lease wait expired after {:.2}s: {last_lease_error}",
                        elapsed.as_secs_f64()
                    ),
                    now_ms().max(0) as u64,
                );
                return;
            }

            let delay = jittered_store_open_delay(backoff, policy.max_backoff, attempt)
                .min(policy.wait_window.saturating_sub(elapsed));
            tokio::select! {
                _ = coordinator.cancel.notified() => {
                    Self::abandon_lease_wait_on_shutdown(&coordinator, started.elapsed());
                    return;
                }
                _ = tokio::time::sleep(delay) => {}
            }
            if coordinator.cancelled.load(Ordering::Acquire) {
                Self::abandon_lease_wait_on_shutdown(&coordinator, started.elapsed());
                return;
            }
            if started.elapsed() >= policy.wait_window {
                continue;
            }

            match Self::open_store_once(&descriptor, prime_serving_wal).await {
                Ok(opened) => {
                    if coordinator.cancelled.load(Ordering::Acquire) {
                        Self::abandon_lease_wait_on_shutdown(&coordinator, started.elapsed());
                        return;
                    }
                    let _ = store_slot.set(Arc::new(opened));
                    coordinator.set_phase(STORE_OPENED);
                    tracing::info!(
                        "mc-module: storage lease released; store opened after {:.2}s",
                        started.elapsed().as_secs_f64()
                    );
                    return;
                }
                Err(error) if store_open_error_is_live_lease(&error) => {
                    last_lease_error = error;
                    backoff = backoff.saturating_mul(2).min(policy.max_backoff);
                    attempt = attempt.saturating_add(1);
                }
                Err(error) => {
                    tracing::error!(
                        "mc-module: storage lease wait ended after {:.2}s; store open failed: {error}",
                        started.elapsed().as_secs_f64()
                    );
                    coordinator.fail_with_error_and_idle(&error, now_ms().max(0) as u64);
                    return;
                }
            }
        }
    }

    /// A shutdown ends the open for good as far as any later request is concerned, so it records a
    /// reason like any other terminal exit rather than leaving the idle phase unexplained.
    fn abandon_lease_wait_on_shutdown(coordinator: &StoreOpenCoordinator, elapsed: Duration) {
        tracing::info!(
            "mc-module: storage lease wait cancelled during shutdown after {:.2}s",
            elapsed.as_secs_f64()
        );
        coordinator.fail_and_idle(
            STORE_OPEN_FAILURE_REASON_GENERIC,
            format!(
                "storage lease wait cancelled during shutdown after {:.2}s",
                elapsed.as_secs_f64()
            ),
            now_ms().max(0) as u64,
        );
    }

    /// The refusal for a lane that does not wait for an in-flight open, rendered for an operator:
    /// the synchronous seams, plus the host-driven lanes (sync, mirror, authority, note delivery)
    /// whose caller retries on its own schedule. Transform and the facade tools wait instead.
    fn store_refusal(&self) -> HandlerOutcome {
        self.store_open
            .refusal(now_ms().max(0) as u64)
            .into_outcome()
    }

    /// The refusal for a synchronous facade seam, rendered for the user.
    fn facade_store_refusal(&self) -> HandlerOutcome {
        self.store_open
            .refusal(now_ms().max(0) as u64)
            .into_facade_outcome()
    }

    /// The store handle for a request lane, waiting out a bounded budget when an open is still in
    /// flight. An empty handle during the open is a startup race, not a failure: a first request
    /// that a few hundred milliseconds would have served should not be refused. The lease wait is
    /// deliberately excluded — it runs up to `STORE_LEASE_WAIT_WINDOW`, far beyond any request's
    /// deadline, so that arm refuses at once with its own retryable code.
    async fn store_for_request(&self) -> Result<Arc<McStore>, StoreRefusal> {
        if let Some(store) = self.store.get() {
            return Ok(Arc::clone(store));
        }
        let deadline = Instant::now()
            + self
                .store_open
                .policy
                .lock()
                .expect("store open policy mutex")
                .request_wait;
        while self.store_open.phase.load(Ordering::Acquire) == STORE_OPENING {
            // Arm the wakeup before re-reading the handle, so an open that lands between the two
            // cannot be missed and leave this request asleep for the whole budget.
            let phase_changed = self.store_open.phase_changed.notified();
            if let Some(store) = self.store.get() {
                return Ok(Arc::clone(store));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero()
                || tokio::time::timeout(remaining, phase_changed)
                    .await
                    .is_err()
            {
                break;
            }
        }
        match self.store.get() {
            Some(store) => Ok(Arc::clone(store)),
            None => Err(self.store_open.refusal(now_ms().max(0) as u64)),
        }
    }

    /// Open `store.db`, then attach `context.db`, where every domain row lives. The pair is
    /// served only when both record the same single-store migration; otherwise the open
    /// fails with the refusal that names why, before any request is served.
    async fn open_store_once(
        descriptor: &StorageDescriptor,
        prime_serving_wal: bool,
    ) -> Result<McStore, McStoreError> {
        let descriptor = descriptor.clone();
        let enforce_private_permissions = crate::config::private_storage_permissions_enabled();
        let open = move || {
            let store =
                McStore::open_with_private_permissions(&descriptor, enforce_private_permissions)?;
            let store_path = match &descriptor.backend {
                StorageBackend::Sqlite { path } => Some(PathBuf::from(path)),
                StorageBackend::Postgres { .. } => None,
            };
            let context_path = single_store_reads::context_db_path_for(store_path.as_deref());
            single_store_reads::attach_with_private_permissions(
                &store,
                &context_path,
                enforce_private_permissions,
            )?;
            if prime_serving_wal {
                store.prime_wal_for_serving()?;
            }
            Ok(store)
        };
        match tokio::task::spawn_blocking(open).await {
            Ok(result) => result,
            Err(error) => panic!("store open worker failed: {error}"),
        }
    }

    #[cfg(test)]
    fn set_store_open_policy_for_test(&self, policy: StoreOpenPolicy) {
        *self
            .store_open
            .policy
            .lock()
            .expect("store open policy mutex") = policy;
    }

    #[cfg(test)]
    #[allow(dead_code)]
    fn with_producer_factory(factory: Arc<dyn HistorianProducerFactory>) -> Self {
        Self::with_producer_factory_and_config(
            factory,
            McModuleConfig {
                rust_background_enabled: false,
                cache_ttl_by_model: std::collections::BTreeMap::new(),
                catalog: crate::config::CatalogConfigInputs::default(),
                historian_temperature: None,
                historian_expand_tools: Default::default(),
                historian_runner: None,
                dreamer_runner: None,
                language: None,
                execute_threshold_percentage: 65.0,
                execute_threshold_user_config: None,
                execute_threshold_user_configured: false,
                execute_threshold_project_config: None,
                protected_tokens_user: None,
                protected_tokens_project: None,
                keep_reasoning_tokens: None,
                compaction_enabled: true,
                signed_thinking_hold: config::SignedThinkingHold::Off,
                smart_notes_enabled: true,
                memory_enabled: true,
                auto_search: crate::config::AutoSearchConfig::default(),
                caveman: crate::config::CavemanConfig::default(),
                auto_promote: true,
                user_memory_collection_enabled: false,
                user_observations_requested: true,
                historian_context_limit_tokens: 128_000,
                historian_context_limit_known: false,
                memory_budget_tokens: 4_000.0,
                user_profile_budget_tokens: 4_000.0,
                inject_docs: true,
                temporal_awareness: true,
                prompt_surface_guidance_override: None,
                smart_drops: false,
                protected_tools: crate::selection::default_protected_tools(),
                cache_ttl: "5m".to_string(),
            },
        )
    }

    #[cfg(test)]
    fn with_producer_factory_and_config(
        factory: Arc<dyn HistorianProducerFactory>,
        config: McModuleConfig,
    ) -> Self {
        Self::with_producer_factory_config_resolver(
            factory,
            config,
            Arc::new(MissingSessionResolver),
        )
    }

    #[cfg(test)]
    fn with_producer_factory_config_resolver(
        factory: Arc<dyn HistorianProducerFactory>,
        config: McModuleConfig,
        session_resolver: Arc<dyn SessionResolver>,
    ) -> Self {
        let store = Arc::new(OnceLock::new());
        let provider_store = Arc::new(providers::Storage::new(Arc::clone(&store)));
        let move_visibility = Arc::new(agent_data::MoveVisibility::default());
        let agent_data = agent_data::ENABLED.then(|| {
            agent_data::AgentDataService::new(
                None,
                DEFAULT_MODULE_ID.into(),
                Arc::clone(&move_visibility),
            )
        });
        McHandler {
            agent_data,
            move_visibility,
            registered_module_id: DEFAULT_MODULE_ID.into(),
            app_channels: Mutex::default(),
            store,
            log_directory: None,
            store_open: Arc::new(StoreOpenCoordinator::new()),
            producer_factory: factory,
            session_resolver,
            retrieval_reranker: None,
            config: Arc::new(Mutex::new(ConfigCache::default())),
            historian_runner_refusals: Arc::new(HistorianRunnerRefusalCache::default()),
            broca_dream_tools: Arc::new(dream_dispatch::broca_carrier::BrocaToolRoute::default()),
            dream_runs: Arc::new(dream_dispatch::tick::DreamRuns::new(
                None,
                &RouteTargetConfig::default(),
            )),
            runner_choices: Arc::new(Mutex::new(runner_choices::RunnerChoiceLog::default())),
            project_identities: Arc::new(project_identity::ProjectIdentityResolver::new()),
            entorhinal: entorhinal_resolve::EntorhinalResolver::new(None),
            binding_projects: Mutex::default(),
            active_project_roots: Mutex::default(),
            memory_paused_routes: Arc::default(),
            #[cfg(test)]
            resolve_project_identity_for_test: AtomicBool::new(false),
            fixed_config: Some(config),
            fixed_dream_settings: None,
            fixed_historian_settings: None,
            dream_wiring: None,
            reattaching_sessions: Arc::new(Mutex::new(HashSet::new())),
            live_historian_sessions: Arc::new(Mutex::new(HashMap::new())),
            wrapup_sessions: Arc::new(Mutex::new(HashMap::new())),
            recomp_sessions: Arc::new(Mutex::new(HashSet::new())),
            serialized_outputs: Mutex::new(SerializedOutputCache::default()),
            boundary_tokens: Arc::new(Mutex::new(BoundaryTokenCache::new(
                BOUNDARY_TOKEN_CACHE_BUDGET_BYTES,
            ))),
            guidance_dates: Mutex::new(HashMap::new()),
            prompt_surface_epochs: Mutex::new(HashMap::new()),
            tool_provider_v1_channels: Mutex::new(HashSet::new()),
            frozen_tool_catalogs: Mutex::new(HashMap::new()),
            provider_store,
            provider_serial: Arc::new(providers::ProviderSerial::default()),
            provider_runner: Arc::new(session_resolver::MissingProviderRunner),
            historian_model_catalog: providers::HistorianModelCatalog::new(
                None,
                RouteTargetConfig::default(),
            ),
            provider_historian_worker: OnceLock::new(),
            provider_historian_budget: providers::historian_budget::Budget::process(),
            provider_historian_evaluations: Arc::new(Mutex::new(HashSet::new())),
            provider_historian_gate: Mutex::new(None),
            #[cfg(test)]
            provider_historian_ingest_pause: Mutex::new(None),
            provider_historian_scan_rows: Arc::new(AtomicU64::new(0)),
            guidance_now_ms: Mutex::new(None),
            reduction_injection: Mutex::new(HashMap::new()),
            wrapup_operation_budget: Mutex::new(None),
            unknown_module_retry_delay: Mutex::new(None),
            status_snapshot_hook: Mutex::new(None),
            classification_before_apply_hook: Mutex::new(None),
            connect_failure_commit_hook: Arc::new(Mutex::new(None)),
            bindings: Mutex::new(HashMap::new()),
            threshold_logged_routes: Mutex::new(HashSet::new()),
            transform_route_channels: Mutex::new(HashMap::new()),
            transform_session_roots: Mutex::new(HashMap::new()),
            active_dreamer_runs: Arc::new(Mutex::new(HashSet::new())),
            missing_facade_command_id_sessions: Mutex::new(HashSet::new()),
            runtime_store_errors: Mutex::new(HashMap::new()),
        }
    }

    /// Record the route's session binding (called from `on_bind`). Last write wins for a
    /// reused channel — the daemon won't reuse a channel without a `route.gone` first, so
    /// this only overwrites a stale entry that somehow survived (defensive).
    fn bind_route(&self, channel: u16, binding: SessionBinding) {
        self.binding_projects
            .lock()
            .expect("binding project mutex")
            .insert(channel, BindingProject::default());
        self.threshold_logged_routes
            .lock()
            .expect("threshold log mutex")
            .remove(&channel);
        self.transform_route_channels
            .lock()
            .expect("transform route channels mutex")
            .remove(&channel);
        let replacement = {
            let mut bindings = self.bindings.lock().expect("bindings mutex");
            let previous = bindings.insert(channel, binding);
            previous.and_then(|previous| {
                let still_bound = bindings
                    .values()
                    .any(|candidate| candidate.session == previous.session);
                (!still_bound).then_some(previous)
            })
        };
        let replacement_session = replacement.map(|previous| previous.session);
        if let Some(session_id) = replacement_session {
            self.active_project_roots
                .lock()
                .expect("active project roots mutex")
                .remove(&session_id);
            self.frozen_tool_catalogs
                .lock()
                .expect("frozen catalog mutex")
                .retain(|(_, session), _| session != &session_id);
            self.serialized_outputs
                .lock()
                .expect("serialized output cache mutex")
                .remove(&session_id);
            self.boundary_tokens
                .lock()
                .expect("boundary token cache mutex")
                .remove(&session_id);
            self.prompt_surface_epochs
                .lock()
                .expect("prompt surface epoch mutex")
                .remove(&session_id);
        }
    }

    /// Remove a route and evict process-local session state after its final binding closes.
    fn unbind_route(&self, channel: u16) {
        self.binding_projects
            .lock()
            .expect("binding project mutex")
            .remove(&channel);
        self.threshold_logged_routes
            .lock()
            .expect("threshold log mutex")
            .remove(&channel);
        self.tool_provider_v1_channels
            .lock()
            .expect("tool-provider channels mutex")
            .remove(&channel);
        self.transform_route_channels
            .lock()
            .expect("transform route channels mutex")
            .remove(&channel);
        let last_session_route = {
            let mut bindings = self.bindings.lock().expect("bindings mutex");
            let removed = bindings.remove(&channel);
            removed.as_ref().and_then(|binding| {
                let still_bound = bindings
                    .values()
                    .any(|candidate| candidate.session == binding.session);
                (!still_bound).then_some(binding.session.clone())
            })
        };
        if let Some(session) = last_session_route {
            self.active_project_roots
                .lock()
                .expect("active project roots mutex")
                .remove(&session);
            self.frozen_tool_catalogs
                .lock()
                .expect("frozen catalog mutex")
                .retain(|(_, key_session), _| key_session != &session);
            if session.starts_with("mc-dreamer:") {
                self.unregister_dreamer_run(&session);
            }
            self.runtime_store_errors
                .lock()
                .expect("runtime store errors mutex")
                .remove(&session);
            self.serialized_outputs
                .lock()
                .expect("serialized output cache mutex")
                .remove(&session);
            self.boundary_tokens
                .lock()
                .expect("boundary token cache mutex")
                .remove(&session);
            self.prompt_surface_epochs
                .lock()
                .expect("prompt surface epoch mutex")
                .remove(&session);
            self.evict_session_lineage_caches(&session);
        }
    }

    /// Retention bound for the per-session lineage caches `transform_session_roots` and
    /// `guidance_dates`: an entry lives only while the session has a bound route, and is
    /// evicted when its last route closes (`unbind_route`). `session.delete` also evicts the
    /// guidance date, and the root entry when no route is still bound. Without this both
    /// maps grow with every session the process has ever served.
    ///
    /// Evicting cannot change served bytes for a returning session, because each map is a
    /// process-local copy of something the store already holds, and the rebuild is the same
    /// one a module restart performs:
    /// - `transform_session_roots` caches the durable `mc_transform_session_roots` proof.
    ///   `module_knows_transform_session` re-reads that row (plus the cache-state row) on a
    ///   miss and re-caches it, and a new transform on the session re-inserts its root.
    /// - `guidance_dates` holds a date line only until it is persisted in the session's
    ///   `ModuleMeta::guidance_date` (or the first committed transform). A persisted date is
    ///   always read from the store first, so only a session with no durable row loses its
    ///   in-memory line, exactly as it would across a restart.
    fn evict_session_lineage_caches(&self, session_id: &str) {
        self.transform_session_roots
            .lock()
            .expect("transform session roots mutex")
            .remove(session_id);
        self.guidance_dates
            .lock()
            .expect("guidance date mutex")
            .remove(session_id);
    }

    /// Resolve the binding for a transform request on `channel`, FAIL-LOUD: the channel
    /// must be bound AND its bound session must match the request's `session_id`. Returns
    /// the full binding (project_root + frozen budget) the caller keys its store reads off,
    /// never a default. The resolve-or-reject is enforced from the start, and it changes no
    /// transform output — a correctly-bound request resolves and proceeds identically.
    fn resolve_binding(
        &self,
        channel: u16,
        request_session: &str,
    ) -> Result<SessionBinding, BindingError> {
        let map = self.bindings.lock().expect("bindings mutex");
        let binding = map.get(&channel).ok_or(BindingError::Unbound)?;
        if binding.session != request_session {
            return Err(BindingError::SessionMismatch);
        }
        Ok(binding.clone())
    }

    /// Return the channel binding without comparing a request session. OpenCode Rust facade
    /// routes bind a real session id, while Claude Code facade routes bind an instance token;
    /// `resolve_facade_scope` applies the corresponding identity mode before touching the store.
    fn facade_binding(&self, channel: u16) -> Result<SessionBinding, BindingError> {
        self.bindings
            .lock()
            .expect("bindings mutex")
            .get(&channel)
            .cloned()
            .ok_or(BindingError::Unbound)
    }

    fn module_knows_transform_session(&self, session_id: &str, project_root: &Path) -> bool {
        let canonical_project_root = canonical_root(project_root);
        let root_observed = self
            .transform_session_roots
            .lock()
            .expect("transform session roots mutex")
            .get(session_id)
            .is_some_and(|roots| {
                roots
                    .iter()
                    .any(|root| canonical_root(root) == canonical_project_root)
            });
        if !root_observed {
            let Some(store) = self.store.get() else {
                return false;
            };
            let durable_root_observed = canonical_project_root.to_str().is_some_and(|root| {
                store
                    .knows_transform_session_root(session_id, root)
                    .unwrap_or(false)
            });
            if !durable_root_observed || !store.has_cache_state(session_id).unwrap_or(false) {
                return false;
            }
            // Cache the durable proof after a process restart. The row pairs the canonical root
            // with the accepted transform commit, so a genuinely different root cannot authorize
            // the same session.
            self.transform_session_roots
                .lock()
                .expect("transform session roots mutex")
                .entry(session_id.to_string())
                .or_default()
                .insert(canonical_project_root.clone());
            return true;
        }
        if self
            .store
            .get()
            .is_some_and(|store| store.has_cache_state(session_id).unwrap_or(false))
        {
            return true;
        }
        self.transform_route_channels
            .lock()
            .expect("transform route channels mutex")
            .values()
            .any(|(session, root)| {
                session == session_id && canonical_root(root) == canonical_project_root
            })
    }

    /// The project identity a bound route's rows are keyed by in `context.db`: the one the
    /// host recorded for the session, or else the identity of the route root computed the
    /// way the host computes it. A root with no computable identity refuses by name rather
    /// than reading under a key nobody writes.
    ///
    /// This is the strict form for memory features (memory writes, classification,
    /// dreamer runs): a route whose identity git cannot currently give refuses with
    /// `git_identity_unavailable`. Paths that serve history use [`Self::route_project`].
    fn route_project_identity(
        &self,
        channel: u16,
        store: &McStore,
        binding: &SessionBinding,
    ) -> Result<String, HandlerOutcome> {
        let route = self.route_project(channel, store, binding)?;
        match route.memory_paused {
            None => Ok(route.key),
            Some(reason) => Err(HandlerOutcome::Error {
                code: "git_identity_unavailable".to_string(),
                message: reason,
            }),
        }
    }

    /// The project key a route's history is served under, and whether its memory is
    /// paused.
    ///
    /// When git fails inside the route's checkout and no earlier `git:` identity is known,
    /// the project has no identity the host would agree on. Keying it by its directory
    /// hash would file its memories in a pool no host reads, so instead the route keeps
    /// its transform (compaction, m0/m1 history) under a key that names no project, with
    /// every memory feature paused: no memory block, no memory search, no fact promotion,
    /// no memory writes and no dreamer runs. The reason is logged once per route root, and
    /// each fallback request retries git, so the route recovers as soon as git does. Home,
    /// missing and non-directory paths still refuse outright, as do failed metadata reads.
    fn route_project(
        &self,
        channel: u16,
        store: &McStore,
        binding: &SessionBinding,
    ) -> Result<RouteProject, HandlerOutcome> {
        let mut projects = self.binding_projects.lock().expect("binding project mutex");
        let project = projects.entry(channel).or_default();
        let moved = self
            .active_project_roots
            .lock()
            .expect("active project roots mutex")
            .insert(binding.session.clone(), binding.project_root.clone())
            .is_some_and(|previous| previous != binding.project_root);
        if moved {
            // Hosts reuse an open channel when returning to a directory. A move
            // starts a new prefix decision even though that channel stayed open.
            project.served = None;
            project.mismatch_logged = false;
            if let Ok(directory) = self
                .project_identities
                .eligible_directory(&binding.project_root)
            {
                if let Some(pin) = self
                    .project_identities
                    .pinned_identity(&directory)
                    .or_else(|| self.project_identities.common_dir_pin(&directory))
                {
                    project.initial = Some(Ok(pin));
                }
            }
            tracing::info!(session = %binding.session, root = %binding.project_root.display(), "mc-module: project directory moved; refreshing route identity without resolve");
        }
        let row = store
            .session_project_identity(&binding.session)
            .map_err(|error| HandlerOutcome::Error {
                code: "store_load_failed".to_string(),
                message: error.to_string(),
            })?;
        let candidate = match row {
            Some(identity) => RouteProject::resolved(identity),
            None => self.binding_fallback_project(store, binding, project)?,
        };
        if let Some(served) = &project.served {
            if served.key != candidate.key
                && (project_identity::is_project_pin(&served.key)
                    || project_identity::is_project_pin(&candidate.key))
            {
                if !project.mismatch_logged {
                    tracing::warn!(
                        session = %binding.session,
                        channel,
                        served = %served.key,
                        observed = %candidate.key,
                        "mc-module: ignoring changed project identity until a new route binding"
                    );
                    project.mismatch_logged = true;
                }
                return Ok(served.clone());
            }
        }
        project.served = Some(candidate.clone());
        Ok(candidate)
    }

    fn binding_fallback_project(
        &self,
        _store: &McStore,
        binding: &SessionBinding,
        project: &BindingProject,
    ) -> Result<RouteProject, HandlerOutcome> {
        #[cfg(test)]
        if !self
            .resolve_project_identity_for_test
            .load(Ordering::Relaxed)
        {
            let root = binding.project_root.to_string_lossy().to_string();
            return Ok(RouteProject::resolved(
                _store.route_identity_for_test(&root).unwrap_or(root),
            ));
        }
        let outcome = match &project.initial {
            Some(Ok(identity)) if !identity.starts_with("dir:") => Ok(identity.clone()),
            Some(Err(error))
                if !matches!(
                    error,
                    project_identity::ProjectIdentityError::GitUnavailable { .. }
                ) =>
            {
                Err(error.clone())
            }
            initial => {
                let outcome = self.project_identities.resolve(&binding.project_root);
                // Revalidation may discover git, but a pin gained after bind belongs to
                // the next binding, never to this binding's fallback decision.
                if outcome
                    .as_ref()
                    .is_ok_and(|id| project_identity::is_project_pin(id))
                {
                    if let Some(served) = &project.served {
                        return Ok(served.clone());
                    }
                    initial.clone().unwrap_or(outcome)
                } else {
                    outcome
                }
            }
        };
        let mut paused = self
            .memory_paused_routes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match outcome {
            Ok(identity) => {
                if paused.remove(&binding.project_root).is_some() {
                    tracing::info!(
                        "mc-module: project identity for {} resolved to {identity}; memory features resumed",
                        binding.project_root.display()
                    );
                }
                Ok(RouteProject::resolved(identity))
            }
            Err(error @ project_identity::ProjectIdentityError::GitUnavailable { .. }) => {
                let reason = error.to_string();
                if paused
                    .insert(binding.project_root.clone(), reason.clone())
                    .is_none()
                {
                    tracing::warn!("mc-module: memory features paused: {reason}");
                }
                Ok(RouteProject {
                    key: project_identity::unavailable_project_key(&binding.project_root),
                    memory_paused: Some(reason),
                })
            }
            Err(error) => Err(HandlerOutcome::Error {
                code: error.code().to_string(),
                message: error.to_string(),
            }),
        }
    }

    fn effective_config(&self, project_root: &Path) -> McModuleConfig {
        #[cfg(test)]
        if let Some(config) = &self.fixed_config {
            let mut config = config.clone();
            self.pause_memory_if_unresolved(project_root, &mut config);
            return config;
        }
        let mut config = self
            .config
            .lock()
            .expect("config mutex")
            .effective_for_project(project_root);
        self.pause_memory_if_unresolved(project_root, &mut config);
        config
    }

    pub fn with_startup_smart_notes_enabled(self, enabled: bool) -> Self {
        self.config
            .lock()
            .expect("config mutex")
            .freeze_smart_notes_enabled(enabled);
        self
    }

    /// Turn memory off in `config` while the route root's identity is unavailable, so the
    /// historian paths that read the configuration neither promote facts nor search
    /// memories into a project nobody can find again.
    fn pause_memory_if_unresolved(&self, project_root: &Path, config: &mut McModuleConfig) {
        if self
            .memory_paused_routes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(project_root)
        {
            config.memory_enabled = false;
        }
    }

    /// Resolve the historian runner for a firing, record it for the status and
    /// health surfaces, and return the runner the firing must use.
    fn record_historian_runner(
        &self,
        session_id: &str,
        config: &McModuleConfig,
        harness: &str,
    ) -> HistorianRunnerKind {
        let resolved = config.historian_runner_for(harness);
        self.runner_choices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(
                runner_choices::RunnerRole::Historian,
                session_id,
                runner_choices::RunnerChoice::new(resolved, harness),
            );
        resolved.kind
    }

    /// Add which runner each recent session used, and why, to the health report
    /// that `ck health` renders. Only a short in-memory lock is taken.
    fn augment_runner_choice_health(&self, mut report: HealthReport) -> HealthReport {
        let (rows, summary) = {
            let log = self
                .runner_choices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (log.health_rows(), log.health_summary())
        };
        if let Some(metrics) = report.metrics.as_mut().and_then(Value::as_object_mut) {
            metrics.insert("runner_choices".to_string(), Value::Array(rows));
        }
        if let Some(summary) = summary {
            report.detail = Some(match report.detail {
                Some(detail) => format!("{detail}; {summary}"),
                None => summary,
            });
        }
        report
    }

    fn guidance_now_ms(&self) -> i64 {
        #[cfg(test)]
        if let Some(now) = *self.guidance_now_ms.lock().expect("guidance clock mutex") {
            return now;
        }
        now_ms()
    }

    fn guidance_date_line(&self) -> String {
        self.guidance_date_line_for_ms(self.guidance_now_ms())
    }

    fn guidance_date_line_for_ms(&self, ms: i64) -> String {
        let date = Local
            .timestamp_millis_opt(ms)
            .single()
            .unwrap_or_else(Local::now)
            .format("%a %b %d %Y");
        format!("Today's date: {date}")
    }

    #[cfg(test)]
    #[allow(dead_code)]
    fn set_guidance_now_ms_for_test(&self, now_ms: i64) {
        *self.guidance_now_ms.lock().expect("guidance clock mutex") = Some(now_ms);
    }

    #[cfg(test)]
    #[allow(dead_code)]
    fn inject_reductions_for_test(&self, session_id: &str, reductions: Vec<ReductionDecision>) {
        self.reduction_injection
            .lock()
            .expect("reduction injection mutex")
            .insert(session_id.to_string(), reductions);
    }

    fn live_historian_completion_wait(
        &self,
        session_id: &str,
    ) -> Option<LiveHistorianCompletionWait> {
        let live = self
            .live_historian_sessions
            .lock()
            .expect("live historian mutex");
        live.get(session_id).map(|entry| {
            Box::pin(entry.completion.clone().notified_owned()) as LiveHistorianCompletionWait
        })
    }

    fn try_claim_live_historian_session(&self, session_id: &str) -> LiveHistorianSessionClaim {
        let mut live = self
            .live_historian_sessions
            .lock()
            .expect("live historian mutex");
        if let Some(entry) = live.get(session_id) {
            return LiveHistorianSessionClaim::Busy(Box::pin(
                entry.completion.clone().notified_owned(),
            ));
        }
        let token = Arc::new(());
        let completion = Arc::new(Notify::new());
        live.insert(
            session_id.to_string(),
            LiveHistorianSession {
                token: Arc::clone(&token),
                completion: Arc::clone(&completion),
            },
        );
        LiveHistorianSessionClaim::Acquired(SessionSetGuard {
            sessions: Arc::clone(&self.live_historian_sessions),
            session_id: session_id.to_string(),
            token,
            completion,
        })
    }

    fn try_claim_recomp_session(&self, session_id: &str) -> Result<StringSetGuard, ()> {
        let mut sessions = self.recomp_sessions.lock().expect("recomp sessions mutex");
        if !sessions.insert(session_id.to_string()) {
            return Err(());
        }
        Ok(StringSetGuard {
            sessions: Arc::clone(&self.recomp_sessions),
            session_id: session_id.to_string(),
        })
    }

    fn try_claim_wrapup_session(&self, session_id: &str) -> Result<WrapupSessionGuard, usize> {
        let mut sessions = self.wrapup_sessions.lock().expect("wrapup sessions mutex");
        if let Some(session) = sessions.get(session_id) {
            return Err(session.rounds);
        }
        let token = Arc::new(());
        sessions.insert(
            session_id.to_string(),
            LiveWrapupSession {
                token: Arc::clone(&token),
                rounds: 0,
            },
        );
        Ok(WrapupSessionGuard {
            sessions: Arc::clone(&self.wrapup_sessions),
            session_id: session_id.to_string(),
            token,
        })
    }

    fn maybe_spawn_reattach(
        &self,
        store: Arc<McStore>,
        parsed: &TransformRequest,
        guards: ReattachPublicationGuards,
        binding: &SessionBinding,
        projection: &crate::ck_wire::FlatProjection,
        now: i64,
    ) -> Option<&'static str> {
        let ReattachPublicationGuards {
            rust_background_enabled,
            log_fence: log_publication_fence,
            session_runner,
        } = guards;
        let project_path = binding.project_root.to_string_lossy().to_string();
        let harness = binding.harness.clone();
        let runner_identity = runner_bind_identity(binding);
        let config = self.effective_config(&binding.project_root);
        let Ok(loaded) = store.load_meta(&parsed.session_id) else {
            return Some("recovery_load_failed");
        };
        let phase = loaded.meta.historian.state.clone();
        if phase == HistorianPhase::Idle {
            return Some("recovered");
        }
        if self
            .live_historian_sessions
            .lock()
            .expect("live historian mutex")
            .contains_key(&parsed.session_id)
        {
            return None;
        }
        let mut latch = self.reattaching_sessions.lock().expect("reattach mutex");
        if !latch.insert(parsed.session_id.clone()) {
            return Some(match phase {
                HistorianPhase::AwaitingProducer => "reattaching",
                HistorianPhase::Firing
                | HistorianPhase::Reclaiming
                | HistorianPhase::Validating
                | HistorianPhase::Publishing => "recovering",
                HistorianPhase::Idle => "recovered",
            });
        }
        drop(latch);

        let session_id = parsed.session_id.clone();
        let latch = Arc::clone(&self.reattaching_sessions);
        let guard = StringSetGuard {
            sessions: Arc::clone(&latch),
            session_id: session_id.clone(),
        };

        match phase {
            HistorianPhase::AwaitingProducer => {
                let publication_fence = log_publication_fence.clone();
                let factory = Arc::clone(&self.producer_factory);
                let project_root = PathBuf::from(&project_path);
                let live: Vec<_> = projection
                    .blocks
                    .iter()
                    .filter(|b| !b.synthetic)
                    .cloned()
                    .collect();
                let Some(range) = loaded.meta.historian.chunk_range.clone() else {
                    drop(guard);
                    return Some("recovering");
                };
                let chunk = historian_chunk::build_historian_chunk_with_expansions(
                    parsed.messages.as_slice(),
                    &live,
                    range.from_ordinal,
                    derive_historian_chunk_tokens(config.historian_context_limit_tokens),
                    range.to_ordinal.saturating_add(1),
                    &config.historian_expand_tools,
                );
                let prior_compartments = match if log_publication_fence.is_some() {
                    store
                        .load_historian_assembly_index(&session_id)
                        .map(|index| index.snapshot.compartments)
                } else {
                    store.load_compartments(&session_id)
                } {
                    Ok(cs) => cs
                        .iter()
                        .map(historian_chunk::stored_range)
                        .collect::<Vec<_>>(),
                    Err(_) => Vec::new(),
                };
                let raw_chunk_messages = serde_json::to_string(
                    &parsed
                        .messages
                        .iter()
                        .filter(|message| {
                            !message.ck.meta.synthetic
                                && message.ordinal >= chunk.chunk.start_index
                                && message.ordinal <= chunk.chunk.end_index
                        })
                        .collect::<Vec<_>>(),
                )
                .unwrap_or_else(|_| "[]".to_string());
                let boundary_dates = historian_chunk::native_boundary_dates(&parsed.messages);
                let fingerprint_items: Vec<_> =
                    chunk.snapshot.iter().map(|item| item.as_item()).collect();
                let observed = historian::compute_chunk_fingerprint(&fingerprint_items);
                // The same resolution and clamp a fresh attempt applies to the host's
                // per-request timeout.
                let reattach_await_timeout =
                    historian::historian_await_timeout(parsed.historian_timeout_ms);
                tokio::spawn(async move {
                    let _guard = guard;
                    let result = async {
                        let action = historian::handle_restart_load(
                            &store,
                            &session_id,
                            now + HISTORIAN_FAILURE_BACKOFF_MS,
                        )?;
                        match action {
                            historian::RestartAction::Done => {
                                return Ok(historian::HistorianReattachOutcome::Done);
                            }
                            historian::RestartAction::AbandonedAndRefireEligible { firing_seq } => {
                                return Ok(historian::HistorianReattachOutcome::RefireEligible {
                                    firing_seq,
                                });
                            }
                            historian::RestartAction::ReattachProducer { .. } => {}
                        }
                        // A run started on the conversation's own runner is
                        // followed there; its run id means nothing to any other.
                        let mut producer = match &session_runner {
                            Some(route) => {
                                factory
                                    .connect_session_runner(&runner_identity, route)
                                    .await?
                            }
                            None => factory.connect(&project_root).await?,
                        };
                        reattach_historian_producer(
                            &mut *producer,
                            historian::HistorianReattachRequest {
                                rust_background_enabled,
                                store: &store,
                                session_id: &session_id,
                                project_path: &project_path,
                                harness: &harness,
                                observed_chunk_fingerprint: &observed,
                                validation_chunk: &chunk.chunk,
                                chunk_transcript: &chunk.text,
                                raw_chunk_messages: &raw_chunk_messages,
                                boundary_dates: &boundary_dates,
                                prior_compartments: &prior_compartments,
                                validate_options: historian_validate::ValidateOptions {
                                    sequence_offset: prior_compartments.len() as u64 + 1,
                                    in_emergency: false,
                                    memory_enabled: config.memory_enabled,
                                    auto_promote: config.auto_promote,
                                    user_memory_collection_enabled: config
                                        .user_memory_collection_enabled,
                                    force_keep_last_compartment: false,
                                },
                                publication_floor_ordinal: range.to_ordinal,
                                await_timeout: reattach_await_timeout,
                                now_ms: now,
                                failure_backoff_at_ms: now + HISTORIAN_FAILURE_BACKOFF_MS,
                                completion_now_ms: now_ms,
                                publication_fence: publication_fence
                                    .as_deref()
                                    .map(|f| f as &dyn historian::HistorianPublicationFence),
                            },
                        )
                        .await
                    }
                    .await;
                    if let Err(e) = result {
                        tracing::error!(
                            "mc-module: historian reattach failed for {session_id}: {e}"
                        );
                    }
                });
                Some("reattaching")
            }
            // An interrupted producer run holds the session's single-flight slot
            // with no task left to drive it. Releasing it here costs one
            // re-assembled chunk on the next trigger and never loses durable
            // output; the publish path re-reads the stored compartments.
            HistorianPhase::Firing
            | HistorianPhase::Reclaiming
            | HistorianPhase::Validating
            | HistorianPhase::Publishing => {
                tokio::spawn(async move {
                    let _guard = guard;
                    let _log_fence = log_publication_fence;
                    if let Err(e) = historian::handle_restart_load(
                        &store,
                        &session_id,
                        now + HISTORIAN_FAILURE_BACKOFF_MS,
                    ) {
                        tracing::error!(
                            "mc-module: historian restart recovery failed for {session_id}: {e}"
                        );
                    }
                });
                Some("recovering")
            }
            HistorianPhase::Idle => Some("recovered"),
        }
    }

    fn prepare_historian_fire(
        &self,
        store: Arc<McStore>,
        parsed: &TransformRequest,
        binding: &SessionBinding,
        project_path: &str,
        projection: &crate::ck_wire::FlatProjection,
        prepare: HistorianPrepareContext<'_>,
    ) -> PreparedHistorianAction {
        profile_start!(_perf_trigger, "trigger_ms");
        let HistorianPrepareContext {
            rust_background_enabled,
            now,
            publication_fence,
            async_coverage,
            reclaim_ride_available,
            runner_lane,
            timings,
        } = prepare;
        let trigger_timer = HistorianTriggerTimer {
            started_at: Instant::now(),
            timings,
        };
        // Historian bookkeeping reads and writes meta scalars only, so it loads the small row:
        // a full load would decode every frozen unit for a decision that never looks at them.
        let loaded = match store.load_meta(&parsed.session_id) {
            Ok(loaded) => loaded,
            Err(e) => {
                return PreparedHistorianAction::Complete(historian_no_fire_diagnostics(
                    NoFireDiagnosticsInput {
                        no_fire: format!("state_load_failed:{e}"),
                        detail_kind: "state_load_failed",
                        cause: HistorianNoFireCause::StateLoadFailed,
                        extra: None,
                        reason: None,
                        state: "unknown".to_string(),
                        progress: None,
                        last_failure: None,
                    },
                ));
            }
        };
        let state = loaded.meta.historian.state.as_str().to_string();
        let last_failure = loaded.meta.historian.last_failure.clone();
        let (context_limit, input_tokens, usage_percentage) =
            usage_numbers(parsed.usage.as_ref(), parsed.geometry.as_ref());
        let mut decision_context =
            HistorianDecisionContext::from_request(parsed, &loaded.meta, now, usage_percentage);
        if loaded.meta.pending_rewrite.is_some() {
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "pending_rewrite".into(),
                detail_kind: "pending_rewrite",
                cause: HistorianNoFireCause::PendingRewrite,
                extra: None,
                reason: None,
                state,
                progress: None,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        if let Some(completion) = self.live_historian_completion_wait(&parsed.session_id) {
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "busy".into(),
                detail_kind: "busy",
                cause: HistorianNoFireCause::LiveHistorianClaimBusy,
                extra: None,
                reason: None,
                state,
                progress: None,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Busy { completion };
        }
        let cfg = self.effective_config(&binding.project_root);
        let rust_background_enabled =
            rust_background_enabled.unwrap_or_else(|| cfg.rust_background_enabled());
        let session_runner = runner_lane
            .then(|| session_runner_route(binding, cfg.historian_runner_for(&binding.harness)))
            .flatten();
        if loaded.meta.historian.state != HistorianPhase::Idle {
            let no_fire = self
                .maybe_spawn_reattach(
                    Arc::clone(&store),
                    parsed,
                    ReattachPublicationGuards {
                        rust_background_enabled,
                        log_fence: publication_fence.clone(),
                        session_runner: session_runner.clone(),
                    },
                    binding,
                    projection,
                    now,
                )
                .unwrap_or("busy");
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: no_fire.to_string(),
                detail_kind: "restart_recovery",
                cause: HistorianNoFireCause::RestartRecoveryInProgress,
                extra: None,
                reason: None,
                state,
                progress: None,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        let boundary_build_started_at = Instant::now();
        profile_start!(perf_boundary, "trigger_boundary_build");
        profile_start!(_perf_fallback, "rt19_fallback_tag_load");
        let tags = if async_coverage.is_some() {
            let blocks = projection
                .blocks
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>();
            store.load_tags_for_blocks(&parsed.session_id, &blocks)
        } else {
            store.load_tags_for_session(&parsed.session_id)
        };
        if let Ok(tags) = tags {
            // Malformed-lineage and compaction-off paths return before normal tag hydration.
            // Preserve their fail-open tokenization behavior rather than treating absence as empty.
            self.boundary_tokens
                .lock()
                .expect("boundary token cache mutex")
                .prime_from_persisted_tags(&parsed.session_id, &tags);
        }
        let CachedBoundaryMessages {
            messages: boundary_messages,
            token_cache_hits,
            tokenized_blocks,
            mut token_cache_snapshot,
        } = boundary_messages(parsed, projection, &self.boundary_tokens);
        trigger_timer.timings.boundary_build_ms +=
            boundary_build_started_at.elapsed().as_secs_f64() * 1_000.0;
        profile_end!(perf_boundary);
        trigger_timer.timings.token_cache_hits = trigger_timer
            .timings
            .token_cache_hits
            .saturating_add(token_cache_hits);
        trigger_timer.timings.tokenized_blocks = trigger_timer
            .timings
            .tokenized_blocks
            .saturating_add(tokenized_blocks);
        let compartment_end_result = if async_coverage.is_none() {
            store.max_compartment_end_ordinal(&parsed.session_id)
        } else {
            Ok(0)
        };
        let last_compartment_end_ordinal = if let Some(coverage) = async_coverage {
            coverage
        } else {
            match compartment_end_result {
                Ok(ordinal) if ordinal > 0 => Some(ordinal as u64),
                Ok(_) | Err(_) if loaded.meta.ordinal_continuation_base.is_some() => {
                    let detail = "continued_ordinal_offset_missing";
                    tracing::info!(
                        "mc-module: aborting historian trigger for {}: {detail}",
                        parsed.session_id
                    );
                    let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                        no_fire: detail.into(),
                        detail_kind: detail,
                        cause: HistorianNoFireCause::ContinuedOrdinalOffsetMissing,
                        extra: None,
                        reason: None,
                        state,
                        progress: None,
                        last_failure,
                    });
                    self.record_no_fire(
                        &store,
                        &parsed.session_id,
                        &loaded,
                        &diagnostics,
                        &decision_context,
                    );
                    return PreparedHistorianAction::Complete(diagnostics);
                }
                Ok(_) | Err(_) => None,
            }
        };
        let serializer_profile = SerializerProfile::parse(&parsed.serializer_profile)
            .expect("serializer_profile validated upstream");
        let fold_is_only_reclaim = !tail_reclaim(serializer_profile);
        let pending_drops = if async_coverage.is_some() && !reclaim_ride_available {
            Vec::new()
        } else {
            store
                .load_pending_agent_drops(&parsed.session_id)
                .unwrap_or_default()
        };
        // The projection reads frozen `red:` units only when agent drops are pending, which is
        // rare; only then is the frozen list loaded.
        let pending_frozen_units = if pending_drops.is_empty() {
            Vec::new()
        } else {
            store
                .load(&parsed.session_id)
                .map(|state| state.core.frozen_units)
                .unwrap_or_default()
        };
        let projected_post_drop_percentage = projected_post_drop_percentage(
            &boundary_messages,
            &pending_drops,
            &pending_frozen_units,
            input_tokens,
            context_limit,
        );
        let trigger_eval_started_at = Instant::now();
        profile_start!(perf_eval, "trigger_eval");
        let trigger = {
            let mut formatted_token_estimator =
                |bytes: &str| token_cache_snapshot.formatted_token_count(bytes);
            let check = if async_coverage.is_some() {
                boundary::check_compartment_trigger_tail_with_token_estimator
            } else {
                boundary::check_compartment_trigger_with_token_estimator
            };
            check(
                &boundary_messages,
                &TriggerContext {
                    boundary: BoundaryContext {
                        calibration: Some(
                            loaded
                                .meta
                                .decision_calibration
                                .as_ref()
                                .and_then(decision_calibration::DecisionCalibration::from_frozen)
                                .unwrap_or_else(decision_calibration::DecisionCalibration::neutral),
                        ),
                        context_limit,
                        // Historian preparation reloads module config independently, but a host-
                        // resolved request threshold is still authoritative for this pass.
                        execute_threshold_percentage: parsed.execute_threshold_or(
                            cfg.resolve_execute_threshold(parsed.model_key.as_deref())
                                .percentage,
                        ),
                        usage_percentage,
                        usage_input_tokens: input_tokens,
                        last_compartment_end_ordinal,
                        prior_boundary_ordinal: last_compartment_end_ordinal.unwrap_or(0),
                        migration_floor_active: last_compartment_end_ordinal.unwrap_or(0) > 0,
                        emergency_tail_scale: None,
                        trigger_budget: None,
                        fold_is_only_reclaim,
                    },
                    projected_post_drop_percentage,
                    reclaim_ride_available,
                    compartment_in_progress: loaded.meta.historian.state != HistorianPhase::Idle,
                    commit_cluster_trigger_enabled: DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED,
                    min_commit_clusters: DEFAULT_MIN_COMMIT_CLUSTERS,
                },
                &mut formatted_token_estimator,
            )
        };
        trigger_timer.timings.trigger_eval_ms +=
            trigger_eval_started_at.elapsed().as_secs_f64() * 1_000.0;
        profile_end!(perf_eval);
        let cache_store_started_at = Instant::now();
        profile_start!(perf_trigger_store, "trigger_cache_store");
        self.boundary_tokens
            .lock()
            .expect("boundary token cache mutex")
            .replace(&parsed.session_id, token_cache_snapshot);
        trigger_timer.timings.cache_store_ms +=
            cache_store_started_at.elapsed().as_secs_f64() * 1_000.0;
        profile_end!(perf_trigger_store);
        decision_context.chunk_range = trigger.progress.as_ref().and_then(|progress| {
            (progress.protected_start_ordinal > progress.eligible_start_ordinal).then(|| {
                HistorianChunkRange {
                    from_ordinal: progress.eligible_start_ordinal,
                    to_ordinal: progress.protected_start_ordinal - 1,
                }
            })
        });
        let progress = trigger
            .progress
            .as_ref()
            .map(|p| transform::HistorianTriggerProgress {
                eligible_chunk_tokens: p.eligible_chunk_tokens,
                tail_size_bar: p.tail_size_bar,
                protected_tail_n_tokens: p.n_tokens,
                protected_start_ordinal: p.protected_start_ordinal,
            });
        if !trigger.fire {
            let cause = trigger
                .no_fire_cause
                .expect("a false historian trigger carries its concrete cause");
            // Quantized measurements keep the durable change gate effective while the raw and
            // canonical causes make each refusal branch independently diagnosable.
            let extra = trigger.progress.as_ref().map(|p| {
                format!(
                    "eligible~{}k,bar~{}k,protected_n~{}k,ctx_limit={}",
                    (p.eligible_chunk_tokens / 1000.0).round(),
                    (p.tail_size_bar / 1000.0).round(),
                    (p.n_tokens / 1000.0).round(),
                    context_limit,
                )
            });
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "trigger_false".into(),
                detail_kind: "trigger_false",
                cause,
                extra: extra.as_deref(),
                reason: None,
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        let trigger_rule = trigger
            .reason
            .expect("a true historian trigger carries its firing rule");
        let trigger_reason = Some(trigger_rule.as_str().to_string());
        // The host is the only resolver of the historian's model chain and sends it with
        // every transform. A request without one is refused by name rather than filled
        // in from this module's own reading of the config file.
        let Some(model_chain) = parsed.historian_model_chain.as_deref() else {
            tracing::warn!(
                "mc-module: historian for {} not fired: the transform request carried no historian_model_chain",
                parsed.session_id
            );
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "model_chain_missing".into(),
                detail_kind: "model_chain_missing",
                cause: HistorianNoFireCause::ModelChainMissing,
                extra: None,
                reason: trigger_reason,
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        };
        let model_chain_generation = self.historian_runner_refusals.activate_chain(model_chain);
        if model_chain.is_empty() {
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "no_models".into(),
                detail_kind: "no_models",
                cause: HistorianNoFireCause::NoModels,
                extra: None,
                reason: trigger_reason,
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        if self
            .historian_runner_refusals
            .all_models_durably_refused(model_chain_generation, model_chain)
        {
            let failures = self
                .historian_runner_refusals
                .cached_durable_refusals(model_chain_generation, model_chain);
            let detail = historian::runner_refusal_detail(&failures, true);
            let stage = failures
                .last()
                .map(|(_, refusal)| refusal.stage)
                .expect("a fully refused non-empty chain has a refusal");
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "runner_refusal_chain_exhausted".into(),
                detail_kind: "runner_refusal",
                cause: HistorianNoFireCause::from_runner_refusal_stage(stage),
                extra: Some(&detail),
                reason: trigger_reason,
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        let Some(boundary) = trigger.boundary.clone() else {
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: "missing_boundary".into(),
                detail_kind: "missing_boundary",
                cause: HistorianNoFireCause::MissingBoundary,
                extra: None,
                reason: None,
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        };
        if loaded
            .meta
            .historian
            .failure_backoff_at_ms
            .is_some_and(|backoff_at_ms| now < backoff_at_ms)
        {
            let failure_detail = last_failure.clone();
            let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                no_fire: if last_failure
                    .as_deref()
                    .is_some_and(|detail| detail.contains("chain_exhausted"))
                {
                    "chain_exhausted"
                } else {
                    "backoff"
                }
                .into(),
                detail_kind: "backoff",
                cause: if let Some(stage) = last_failure
                    .as_deref()
                    .and_then(historian::runner_refusal_stage_from_detail)
                {
                    HistorianNoFireCause::from_runner_refusal_stage(stage)
                } else if last_failure
                    .as_deref()
                    .is_some_and(|detail| detail.contains("chain_exhausted"))
                {
                    HistorianNoFireCause::ChainExhausted
                } else if last_failure
                    .as_deref()
                    .is_some_and(|detail| detail.starts_with("validate rejected:"))
                {
                    HistorianNoFireCause::ValidationRejected
                } else {
                    HistorianNoFireCause::FailureBackoff
                },
                extra: failure_detail.as_deref(),
                reason: failure_detail.clone().or(trigger_reason),
                state,
                progress,
                last_failure,
            });
            self.record_no_fire(
                &store,
                &parsed.session_id,
                &loaded,
                &diagnostics,
                &decision_context,
            );
            return PreparedHistorianAction::Complete(diagnostics);
        }
        let live: Vec<_> = projection
            .blocks
            .iter()
            .filter(|block| !block.synthetic)
            .cloned()
            .collect();
        let project_slug = project_slug(&binding.project_root);
        let assembler = if publication_fence.is_some() {
            historian_chunk::assemble_provider_historian_firing
        } else {
            assemble_historian_firing
        };
        let assembler_config = HistorianAssemblerConfig {
            expand_tools: cfg.historian_expand_tools.clone(),
            session_id: parsed.session_id.clone(),
            project_path: project_path.to_string(),
            project_slug: project_slug.clone(),
            model_chain: model_chain.to_vec(),
            model_limits: parsed.historian_model_limits.clone(),
            model_variants: parsed.historian_model_variants.clone(),
            token_budget: derive_historian_chunk_tokens(cfg.historian_context_limit_tokens),
            historian_context_limit_tokens: cfg
                .historian_context_limit_known
                .then_some(cfg.historian_context_limit_tokens),
            max_output_tokens: parsed
                .historian_max_output_tokens
                .unwrap_or(historian_producer::HISTORIAN_MAX_OUTPUT_TOKENS),
            boundary,
            memory_enabled: cfg.memory_enabled,
            auto_promote: cfg.auto_promote,
            user_memory_collection_enabled: cfg.user_memory_collection_enabled,
            user_observations_requested: cfg.user_observations_requested,
            extraction_free: false,
            in_emergency: parsed.emergency_recovery_armed,
            force_keep_last_compartment: false,
            fold_is_only_reclaim,
            failure_backoff_at_ms: now + HISTORIAN_FAILURE_BACKOFF_MS,
            min_chunk_tokens: DEFAULT_HISTORIAN_MIN_CHUNK_TOKENS,
        };
        let runner_refit = (session_runner.is_some()
            || cfg.historian_runner_for(&binding.harness).kind == HistorianRunnerKind::Broca)
            .then(|| {
                historian_runner_refit(
                    assembler_config.clone(),
                    &parsed.messages,
                    projection,
                    now,
                    publication_fence.is_some(),
                    false,
                )
            });
        let assemble = assembler(
            &store,
            &parsed.messages,
            &live,
            &projection.identity_by_mid,
            assembler_config,
            now,
        );
        let mut firing = match assemble {
            Ok(AssembleHistorianFiringOutcome::Fire(firing)) => *firing,
            Ok(AssembleHistorianFiringOutcome::NoFire(reason)) => {
                let raw_no_fire = format!("assemble:{reason:?}");
                let raw_detail = format!("detail={reason:?}");
                let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                    no_fire: raw_no_fire,
                    detail_kind: "assemble",
                    cause: reason.cause(),
                    extra: Some(&raw_detail),
                    reason: trigger_reason,
                    state,
                    progress,
                    last_failure,
                });
                let mut no_fire_context = decision_context.clone();
                if let historian_chunk::HistorianNoFireReason::BelowBudget {
                    token_estimate,
                    minimum,
                } = reason
                {
                    no_fire_context.eligible_tokens = Some(token_estimate as u64);
                    no_fire_context.bar_tokens = Some(minimum as u64);
                }
                self.record_no_fire(
                    &store,
                    &parsed.session_id,
                    &loaded,
                    &diagnostics,
                    &no_fire_context,
                );
                return PreparedHistorianAction::Complete(diagnostics);
            }
            Err(e) => {
                let raw_no_fire = format!("assemble_failed:{e}");
                let raw_detail = format!("error={e}");
                let diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                    no_fire: raw_no_fire,
                    detail_kind: "assemble_failed",
                    cause: HistorianNoFireCause::AssemblyFailed,
                    extra: Some(&raw_detail),
                    reason: trigger_reason,
                    state,
                    progress,
                    last_failure,
                });
                self.record_no_fire(
                    &store,
                    &parsed.session_id,
                    &loaded,
                    &diagnostics,
                    &decision_context,
                );
                return PreparedHistorianAction::Complete(diagnostics);
            }
        };
        let diagnostics = HistorianDiagnostics {
            fired: true,
            reason: trigger_reason,
            no_fire: None,
            no_fire_detail: None,
            canonical_cause: None,
            state: state.clone(),
            progress: progress.clone(),
            last_failure: last_failure.clone(),
        };
        let live_guard = match self.try_claim_live_historian_session(&parsed.session_id) {
            LiveHistorianSessionClaim::Acquired(live_guard) => live_guard,
            LiveHistorianSessionClaim::Busy(completion) => {
                let busy_diagnostics = historian_no_fire_diagnostics(NoFireDiagnosticsInput {
                    no_fire: "busy".into(),
                    detail_kind: "busy",
                    cause: HistorianNoFireCause::LiveHistorianClaimBusy,
                    extra: None,
                    reason: diagnostics.reason,
                    state,
                    progress,
                    last_failure,
                });
                self.record_no_fire(
                    &store,
                    &parsed.session_id,
                    &loaded,
                    &busy_diagnostics,
                    &decision_context,
                );
                return PreparedHistorianAction::Busy { completion };
            }
        };
        decision_context.chunk_range = Some(HistorianChunkRange {
            from_ordinal: firing.from_ordinal,
            to_ordinal: firing.to_ordinal,
        });
        let mut fire_decision = decision_context.recent_decision(
            HistorianDecision::Fired,
            format!("trigger_true:{}", historian_trigger_rule(trigger_rule)),
            diagnostics.progress.as_ref(),
        );
        fire_decision.producer_model = model_chain.first().cloned();
        self.record_fire_decision(&store, &parsed.session_id, &loaded, &fire_decision);
        firing.recent_decision = Some(fire_decision);
        PreparedHistorianAction::FireReady(Box::new(PreparedHistorianFiring {
            task: HistorianFiringTask {
                rust_background_enabled,
                store,
                session_id: parsed.session_id.clone(),
                harness: binding.harness.clone(),
                language: cfg.language.clone(),
                historian_temperature: cfg.historian_temperature,
                historian_await_timeout: historian::historian_await_timeout(
                    parsed.historian_timeout_ms,
                ),
                project_path: project_path.to_string(),
                project_root: binding.project_root.clone(),
                project_slug,
                firing,
                runner_refit,
                runner: self.record_historian_runner(&parsed.session_id, &cfg, &binding.harness),
                session_runner,
                runner_identity: runner_bind_identity(binding),
                model_chain_generation,
                runner_refusal_cache: Arc::clone(&self.historian_runner_refusals),
                live_guard,
                connect_failure_commit_hook: Arc::clone(&self.connect_failure_commit_hook),
                // Organic pressure firings assemble and publish in one continuous drive
                // while the live-session guard is held. They do not depend on a cached raw
                // snapshot, so a transform-snapshot generation fence would reject valid work.
                publication_fence,
                provider_completion: None,
            },
        }))
    }

    fn prepare_wrapup_fire(
        &self,
        store: Arc<McStore>,
        parsed: &TransformRequest,
        binding: &SessionBinding,
        projection: &crate::ck_wire::FlatProjection,
        boundary: &boundary::BoundaryResolution,
        context: WrapupPrepareContext,
    ) -> PreparedWrapupAction {
        let WrapupPrepareContext {
            now,
            project_path,
            allow_unknown_module_retry,
            publication_fence,
        } = context;
        let loaded = match store.load(&parsed.session_id) {
            Ok(loaded) => loaded,
            Err(error) => {
                return PreparedWrapupAction::Failed(format!("state load failed: {error}"));
            }
        };
        if loaded.meta.pending_rewrite.is_some() {
            return PreparedWrapupAction::Failed("a boundary rewrite is pending".to_string());
        }
        if let Some(completion) = self.live_historian_completion_wait(&parsed.session_id) {
            return PreparedWrapupAction::Busy(completion);
        }
        if loaded.meta.historian.state != HistorianPhase::Idle {
            return PreparedWrapupAction::Failed(format!(
                "historian recovery is required from {}",
                loaded.meta.historian.state.as_str()
            ));
        }
        if !allow_unknown_module_retry {
            if let Some(until) = loaded.meta.historian.failure_backoff_at_ms {
                if until > now {
                    return PreparedWrapupAction::Failed(format!(
                        "historian failure backoff active for {} ms",
                        until.saturating_sub(now)
                    ));
                }
            }
        }

        let cfg = self.effective_config(&binding.project_root);
        // Wrapup runs on the host's chain from the session's last transform, the same
        // chain the autonomous historian uses; the module has no chain of its own.
        let Some(model_chain) = parsed.historian_model_chain.clone() else {
            tracing::warn!(
                "mc-module: wrapup for {} refused: the session's transform carried no historian_model_chain",
                parsed.session_id
            );
            return PreparedWrapupAction::Failed(WRAPUP_MODEL_CHAIN_MISSING.to_string());
        };
        let model_chain_generation = self.historian_runner_refusals.activate_chain(&model_chain);
        if model_chain.is_empty() {
            return PreparedWrapupAction::Failed("no historian models are configured".to_string());
        }
        if self
            .historian_runner_refusals
            .all_models_durably_refused(model_chain_generation, &model_chain)
        {
            let failures = self
                .historian_runner_refusals
                .cached_durable_refusals(model_chain_generation, &model_chain);
            return PreparedWrapupAction::Failed(historian::runner_refusal_detail(&failures, true));
        }
        let live = projection
            .blocks
            .iter()
            .filter(|block| !block.synthetic)
            .cloned()
            .collect::<Vec<_>>();
        let project_slug = project_slug(&binding.project_root);
        let language = cfg.language.clone();
        let assembler_config = HistorianAssemblerConfig {
            expand_tools: cfg.historian_expand_tools.clone(),
            session_id: parsed.session_id.clone(),
            project_path: project_path.clone(),
            project_slug: project_slug.clone(),
            model_chain,
            model_limits: parsed.historian_model_limits.clone(),
            model_variants: parsed.historian_model_variants.clone(),
            token_budget: derive_historian_chunk_tokens(cfg.historian_context_limit_tokens),
            historian_context_limit_tokens: cfg
                .historian_context_limit_known
                .then_some(cfg.historian_context_limit_tokens),
            max_output_tokens: parsed
                .historian_max_output_tokens
                .unwrap_or(historian_producer::HISTORIAN_MAX_OUTPUT_TOKENS),
            boundary: boundary.clone(),
            memory_enabled: cfg.memory_enabled,
            auto_promote: cfg.auto_promote,
            user_memory_collection_enabled: cfg.user_memory_collection_enabled,
            user_observations_requested: cfg.user_observations_requested,
            extraction_free: false,
            in_emergency: false,
            force_keep_last_compartment: false,
            // Explicit wrapup is the only reclaim mechanism on this surface, so a
            // small final chunk must not be rejected by the substance floor.
            fold_is_only_reclaim: true,
            failure_backoff_at_ms: now + HISTORIAN_FAILURE_BACKOFF_MS,
            min_chunk_tokens: DEFAULT_HISTORIAN_MIN_CHUNK_TOKENS,
        };
        let session_runner = publication_fence
            .is_some()
            .then(|| session_runner_route(binding, cfg.historian_runner_for(&binding.harness)))
            .flatten();
        let runner_refit = (session_runner.is_some()
            || cfg.historian_runner_for(&binding.harness).kind == HistorianRunnerKind::Broca)
            .then(|| {
                historian_runner_refit(
                    assembler_config.clone(),
                    &parsed.messages,
                    projection,
                    now,
                    publication_fence.is_some(),
                    true,
                )
            });
        let assembler = if publication_fence.is_some() {
            historian_chunk::assemble_provider_historian_firing
        } else {
            assemble_historian_firing
        };
        let assemble = assembler(
            &store,
            &parsed.messages,
            &live,
            &projection.identity_by_mid,
            assembler_config,
            now,
        );
        let firing = match assemble {
            Ok(AssembleHistorianFiringOutcome::Fire(firing)) => {
                let mut firing = *firing;
                // Only the final wrapup chunk has no lookahead; intermediate chunks still
                // need discard-last healing so the next round can re-read their tail.
                firing.validate_options.force_keep_last_compartment = !firing.chunk.has_more;
                firing
            }
            Ok(AssembleHistorianFiringOutcome::NoFire(
                historian_chunk::HistorianNoFireReason::FilteredNoiseSkipped { .. },
            )) => {
                return PreparedWrapupAction::FilteredNoiseSkipped;
            }
            Ok(AssembleHistorianFiringOutcome::NoFire(reason)) => {
                return PreparedWrapupAction::Nothing(format!("{reason:?}"));
            }
            Err(error) => return PreparedWrapupAction::Failed(format!("assembly failed: {error}")),
        };
        let live_guard = match self.try_claim_live_historian_session(&parsed.session_id) {
            LiveHistorianSessionClaim::Acquired(guard) => guard,
            LiveHistorianSessionClaim::Busy(completion) => {
                return PreparedWrapupAction::Busy(completion);
            }
        };
        PreparedWrapupAction::FireReady(Box::new(HistorianFiringTask {
            rust_background_enabled: binding.config.rust_background_enabled(),
            store,
            session_id: parsed.session_id.clone(),
            harness: binding.harness.clone(),
            language,
            historian_temperature: binding.config.historian_temperature,
            // The host's per-attempt timeout, as the autonomous historian uses: the wrapup
            // request's own when it carries one, else the session's last transform's.
            historian_await_timeout: historian::historian_await_timeout(
                parsed.historian_timeout_ms,
            ),
            project_path,
            project_root: binding.project_root.clone(),
            project_slug,
            firing,
            runner_refit,
            runner: self.record_historian_runner(
                &parsed.session_id,
                &binding.config,
                &binding.harness,
            ),
            // Keep the conversation's runner route; use its Setup-derived project root,
            // harness, and session when binding child routes.
            session_runner,
            runner_identity: runner_bind_identity(binding),
            model_chain_generation,
            runner_refusal_cache: Arc::clone(&self.historian_runner_refusals),
            live_guard,
            connect_failure_commit_hook: Arc::clone(&self.connect_failure_commit_hook),
            publication_fence,
            provider_completion: None,
        }))
    }

    /// Persist a trigger-true decision before handing the firing to an asynchronous worker.
    /// The state transition fills in the producer model without appending the same decision again.
    fn record_fire_decision(
        &self,
        store: &McStore,
        session_id: &str,
        loaded: &mc_store::MetaSnapshot,
        decision: &HistorianRecentDecision,
    ) {
        let mut meta = loaded.meta.clone();
        meta.historian.record_recent_decision(decision.clone());
        if store
            .commit_meta(session_id, loaded.row_version, &meta)
            .is_ok()
        {
            DISPATCH_HEALTH.historian_recent_decisions_count.store(
                meta.historian.recent_decisions.len() as u64,
                Ordering::Relaxed,
            );
        }
    }

    /// Persist skip evidence without changing the transform result. Equivalent quantized
    /// no-fire observations leave the row untouched; a CAS loser simply yields to the newer pass.
    fn record_no_fire(
        &self,
        store: &McStore,
        session_id: &str,
        loaded: &mc_store::MetaSnapshot,
        diagnostics: &HistorianDiagnostics,
        context: &HistorianDecisionContext,
    ) {
        let reason = diagnostics
            .no_fire_detail
            .as_deref()
            .expect("no-fire diagnostics carry durable detail");
        let cause = diagnostics
            .canonical_cause
            .clone()
            .expect("no-fire diagnostics carry a canonical cause");
        let mut meta = loaded.meta.clone();
        let decision_changed = meta
            .historian
            .record_recent_decision(context.recent_decision(
                HistorianDecision::NoFire,
                cause,
                diagnostics.progress.as_ref(),
            ));
        if !decision_changed && meta.historian.last_no_fire.as_deref() == Some(reason) {
            return;
        }
        meta.historian.last_no_fire = Some(reason.to_string());
        if store
            .commit_meta(session_id, loaded.row_version, &meta)
            .is_ok()
        {
            DISPATCH_HEALTH.historian_recent_decisions_count.store(
                meta.historian.recent_decisions.len() as u64,
                Ordering::Relaxed,
            );
        }
    }

    async fn execute_historian_firing_task(
        factory: Arc<dyn HistorianProducerFactory>,
        task: HistorianFiringTask,
    ) -> Result<historian::HistorianDriveOutcome, historian::HistorianDriveError> {
        let HistorianFiringTask {
            rust_background_enabled,
            store,
            session_id,
            harness,
            language,
            historian_temperature,
            historian_await_timeout,
            project_path,
            project_slug,
            project_root,
            mut firing,
            runner_refit,
            runner,
            session_runner,
            runner_identity,
            model_chain_generation,
            runner_refusal_cache,
            live_guard,
            connect_failure_commit_hook,
            publication_fence,
            provider_completion,
        } = task;
        let _guard = live_guard;
        tracing::info!(
            "mc-module: historian firing for {session_id}: await_timeout_ms={} attempt_budget_ms={} firing_budget_ms={}",
            historian_await_timeout.as_millis(),
            historian::completion_wait_budget(historian_await_timeout).as_millis(),
            historian::firing_completion_wait_budget(
                historian_await_timeout,
                firing.model_chain.len()
            )
            .as_millis()
        );
        let failure_started_at_ms = firing.now_ms;
        let configured_failure_backoff_at_ms = firing.failure_backoff_at_ms;
        if runner == HistorianRunnerKind::Host && session_runner.is_none() {
            // A firing for the host runner with no session runner has nowhere to go:
            // the `historian.pending|claim|heartbeat|complete` routes are retired, so
            // no claimant can pick up a queued run and it would wait until its
            // deadline. Return the `historian_host_claim_retired` refusal instead of
            // queuing work nobody can claim.
            return Err(runner_limits::refusal(
                "historian_host_claim_retired: the host runner has no claimant in mode 3; run on the session runner instead".to_string(),
            )
            .into());
        }
        let connected = match &session_runner {
            Some(route) => {
                factory
                    .connect_session_runner(&runner_identity, route)
                    .await
            }
            None => factory.connect(&project_root).await,
        };
        let connected = match connected {
            Ok(mut producer) => {
                let prepared = async {
                    let state = store.load_meta(&session_id).map_err(|error| {
                        runner_limits::refusal(format!("historian_runner_discovery: {error}"))
                    })?;
                    let child = historian::historian_producer_session_id(
                        &project_slug,
                        &session_id,
                        state.meta.historian.firing_seq.saturating_add(1),
                    );
                    if let Some(limits) = producer.session_runner_limits(&child).await? {
                        limits.require_historian()?;
                        let skips_zen = firing.model_chain.iter().any(|model| runner_limits::is_zen_model(model));
                        if !limits.max_output_tokens || skips_zen {
                            let refit = runner_refit.ok_or_else(|| {
                                runner_limits::refusal("historian_runner_fit_unavailable".into())
                            })?;
                            let recent_decision = firing.recent_decision.clone();
                            firing = refit(&store, limits)?;
                            firing.recent_decision = recent_decision;
                        }
                    } else if session_runner.is_some() {
                        return Err(runner_limits::refusal("historian_runner_missing_groups: no_tools,max_steps (describe unavailable)".into()));
                    }
                    Ok::<(), HistorianProducerError>(())
                }
                .await;
                match prepared {
                    Ok(()) => Ok(producer),
                    Err(error) => {
                        producer.close().await;
                        Err(error)
                    }
                }
            }
            other => other,
        };
        let result = match connected {
            Ok(mut producer) => {
                let mut request = firing.as_fire_request(
                    &store,
                    &session_id,
                    &project_path,
                    &harness,
                    &project_slug,
                    language.as_deref(),
                );
                request.temperature = historian_temperature;
                request.rust_background_enabled = rust_background_enabled;
                request.await_timeout = historian_await_timeout;
                request.publication_fence = publication_fence.as_deref();
                run_historian_firing_with_model_cache(
                    &mut *producer,
                    request,
                    Some(runner_refusal_cache.as_ref()),
                    model_chain_generation,
                )
                .await
            }
            Err(err) => {
                let failure_backoff_at_ms = historian::completion_failure_backoff_at_ms(
                    failure_started_at_ms,
                    configured_failure_backoff_at_ms,
                    now_ms(),
                );
                let backoff_error = record_historian_connect_failure(
                    &store,
                    &session_id,
                    failure_backoff_at_ms,
                    &format!("producer connect: {err}"),
                    &connect_failure_commit_hook,
                )
                .err()
                .map(Box::new);
                Err(historian::HistorianDriveError::ProducerConnect {
                    source: Box::new(err),
                    backoff_error,
                })
            }
        };
        if let Ok(loaded) = store.load(&session_id) {
            DISPATCH_HEALTH.record_historian_outcome(
                historian_status_summary(&loaded.meta.historian),
                loaded.meta.historian.recent_decisions.len(),
            );
        }
        if let Some(completion) = provider_completion {
            completion.record(&store, &session_id, &result);
        }
        result
    }

    fn wrapup_operation_budget(&self) -> Duration {
        #[cfg(test)]
        if let Some(budget) = *self
            .wrapup_operation_budget
            .lock()
            .expect("wrapup operation budget mutex")
        {
            return budget;
        }
        historian::MAX_WRAPUP_REQUEST_BUDGET
            .checked_sub(WRAPUP_REQUEST_MARGIN)
            .unwrap_or(Duration::ZERO)
    }

    fn unknown_module_retry_delay(&self) -> Duration {
        #[cfg(test)]
        if let Some(delay) = *self
            .unknown_module_retry_delay
            .lock()
            .expect("unknown module retry delay mutex")
        {
            return delay;
        }
        Duration::from_secs(30)
    }

    fn remaining_wrapup_budget(deadline: Instant) -> Option<Duration> {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
    }

    async fn run_wrapup_firing(
        &self,
        task: HistorianFiringTask,
        deadline: Instant,
    ) -> Result<historian::HistorianDriveOutcome, WrapupFiringError> {
        let Some(remaining) = Self::remaining_wrapup_budget(deadline) else {
            return Err(WrapupFiringError::Retryable(
                "wrapup request budget expired before historian round".to_string(),
            ));
        };
        let wait = historian::wrapup_round_wait_budget(
            task.historian_await_timeout,
            task.firing.model_chain.len(),
            remaining,
        );
        let factory = Arc::clone(&self.producer_factory);
        let handle = tokio::spawn(Self::execute_historian_firing_task(factory, task));
        match tokio::time::timeout(wait, handle).await {
            Ok(Ok(Ok(outcome))) => Ok(outcome),
            Ok(Ok(Err(error))) => {
                if matches!(&error, historian::HistorianDriveError::NoModels) {
                    return Err(WrapupFiringError::Terminal {
                        detail: error.to_string(),
                    });
                }
                if matches!(
                    &error,
                    historian::HistorianDriveError::Producer(error)
                        if error.is_unknown_module()
                ) || matches!(
                    &error,
                    historian::HistorianDriveError::ProducerConnect { source, .. }
                        if source.is_unknown_module()
                ) {
                    return Err(WrapupFiringError::UnknownModule(error.to_string()));
                }
                Err(WrapupFiringError::Retryable(error.to_string()))
            }
            Ok(Err(error)) => Err(WrapupFiringError::Retryable(format!(
                "historian task failed: {error}"
            ))),
            Err(_) if Instant::now() >= deadline => Err(WrapupFiringError::Retryable(
                "wrapup request budget expired during historian round".to_string(),
            )),
            Err(_) => Err(WrapupFiringError::Retryable(
                "historian round timed out after 600 seconds".to_string(),
            )),
        }
    }

    /// How long a join may wait for an already-running firing it did not start. The
    /// firing may walk its whole model chain (a timed-out attempt moves on to the next
    /// model), so the join allows one per-attempt budget per model rather than one
    /// attempt in total. The joiner does not know which timeout the running firing was
    /// started with, so it takes the larger of the host-supplied and default
    /// per-attempt timeouts; the chain length is the host's, the only chain there is.
    fn active_firing_join_budget(
        host_model_chain: Option<&[String]>,
        host_timeout_ms: Option<u64>,
    ) -> Duration {
        let host_chain_len = host_model_chain.map_or(0, <[String]>::len);
        let timeout = historian::historian_await_timeout(host_timeout_ms)
            .max(historian::historian_await_timeout(None));
        historian::firing_completion_wait_budget(timeout, host_chain_len)
    }

    async fn await_wrapup_historian_completion(
        &self,
        completion: LiveHistorianCompletionWait,
        deadline: Instant,
        join_budget: Duration,
    ) -> Result<(), String> {
        let Some(remaining) = Self::remaining_wrapup_budget(deadline) else {
            return Err("wrapup request budget expired before joining historian".to_string());
        };
        let wait = join_budget.min(remaining);
        match tokio::time::timeout(wait, completion).await {
            Ok(()) => Ok(()),
            Err(_) if Instant::now() >= deadline => {
                Err("wrapup request budget expired while joining historian".to_string())
            }
            Err(_) => Err("timed out while joining the active historian run".to_string()),
        }
    }

    fn spawn_historian_firing(&self, task: HistorianFiringTask) {
        let factory = Arc::clone(&self.producer_factory);
        tokio::spawn(async move {
            let session_id = task.session_id.clone();
            let result = Self::execute_historian_firing_task(factory, task).await;
            match result {
                Ok(outcome) => {
                    tracing::info!(
                        "mc-module: historian firing finished for {session_id}: {outcome:?}"
                    )
                }
                Err(e) => {
                    tracing::error!("mc-module: historian firing failed for {session_id}: {e}")
                }
            }
        });
    }

    fn management_binding(
        &self,
        channel: u16,
        request: &Value,
        operation: &str,
    ) -> Result<(String, SessionBinding), HandlerOutcome> {
        if request.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(HandlerOutcome::Error {
                code: "bad_request".to_string(),
                message: format!("{operation} requires v=1"),
            });
        }
        let Some(session_id) = request.get("session_id").and_then(Value::as_str) else {
            return Err(HandlerOutcome::Error {
                code: "bad_request".to_string(),
                message: format!("{operation} requires session_id"),
            });
        };
        if session_id.trim().is_empty() {
            return Err(HandlerOutcome::Error {
                code: "bad_request".to_string(),
                message: format!("{operation} requires a nonempty session_id"),
            });
        }
        let binding = match self.resolve_binding(channel, session_id) {
            Ok(binding) => binding,
            Err(BindingError::Unbound) => {
                return Err(HandlerOutcome::Error {
                    code: "route_unbound".to_string(),
                    message: format!("{operation} on a channel with no session binding"),
                });
            }
            Err(BindingError::SessionMismatch) => {
                return Err(HandlerOutcome::Error {
                    code: "session_mismatch".to_string(),
                    message: "request session_id does not match the channel's bound session"
                        .to_string(),
                });
            }
        };
        Ok((session_id.to_string(), binding))
    }

    async fn handle_retrieval(&self, channel: u16, envelope: &Value) -> HandlerOutcome {
        use parity_contract::*;
        use retrieval::hybrid::*;
        let (_, binding) =
            match self.management_binding(channel, envelope, non_served_contract::RETRIEVAL_METHOD)
            {
                Ok(value) => value,
                Err(outcome) => return outcome,
            };
        let Some(store) = self.store.get() else {
            return HandlerOutcome::Error {
                code: "store_refusal".into(),
                message: "mc.retrieval requires a store".into(),
            };
        };
        let project = match self.route_project_identity(channel, store, &binding) {
            Ok(project) => project,
            Err(outcome) => return outcome,
        };
        let scope = StoreScope {
            project: ProjectId(project),
            session: SessionId(binding.session.clone()),
            generation: Generation(0),
        };
        let bad_request = |message: &str| HandlerOutcome::Error {
            code: "bad_request".into(),
            message: message.into(),
        };
        let op = envelope
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("search");
        if op == "expand" {
            use retrieval::hybrid::expand;
            let Ok(source) = serde_json::from_value::<RetrievalSource>(envelope["source"].clone())
            else {
                return bad_request("mc.retrieval expand requires a Rust source id");
            };
            if !matches!(
                source,
                RetrievalSource::RawMessage | RetrievalSource::Compartment
            ) {
                return HandlerOutcome::Error {
                    code: "expand_unsupported_source".into(),
                    message: envelope["source"].as_str().unwrap_or_default().into(),
                };
            }
            // Keep recorded object-key order: parsing tool inputs through Value would
            // sort their keys and change the TypeScript recovery text.
            let Some(pages_json) = envelope["pages_json"].as_str() else {
                return bad_request("mc.retrieval expand requires pages_json");
            };
            let Ok(pages) = serde_json::from_str::<Vec<Vec<expand::RawMessage>>>(pages_json) else {
                return bad_request("mc.retrieval expand requires recorded raw-message pages");
            };
            if source == RetrievalSource::RawMessage {
                let Some(ordinal) = envelope["ordinal"].as_i64() else {
                    return bad_request("expand requires ordinal");
                };
                return respond(
                    json!({"v":1,"text":expand::render_message_by_ordinal(&pages, ordinal)}),
                );
            }
            let (Some(start), Some(end), Some(budget)) = (
                envelope["start"].as_i64(),
                envelope["end"].as_i64(),
                envelope["token_budget"].as_u64(),
            ) else {
                return bad_request("compartment expand requires start, end and token_budget");
            };
            let overrides = match envelope.get("overrides") {
                Some(value) => {
                    match serde_json::from_value::<expand::ToolExpansionMap>(value.clone()) {
                        Ok(value) => value,
                        Err(_) => return bad_request("invalid expand preview overrides"),
                    }
                }
                None => Default::default(),
            };
            let rendered = expand::render_verbose_range(
                &pages,
                start,
                end,
                budget.min(usize::MAX as u64) as usize,
                &overrides,
            );
            return respond(
                json!({"v":1,"text":rendered.text,"lastOrdinal":rendered.last_ordinal,"truncated":rendered.truncated}),
            );
        }
        if !matches!(op, "search" | "auto_hint") {
            return bad_request("unknown mc.retrieval operation");
        }
        let Ok(mut request) =
            serde_json::from_value::<RetrievalRequest>(envelope["request"].clone())
        else {
            return bad_request("mc.retrieval requires a RetrievalRequest");
        };
        let Ok(sources) =
            serde_json::from_value::<Vec<RetrievalSource>>(envelope["sources"].clone())
        else {
            return bad_request("mc.retrieval requires Rust source ids");
        };
        if request
            .ordinal_cutoff
            .is_some_and(|o| o.base != OrdinalBase::One || o.value > i64::MAX as u64)
            || matches!((request.start_at_ms, request.end_at_ms_inclusive), (Some(a), Some(b)) if a > b)
        {
            return bad_request("invalid retrieval bounds");
        }
        if op == "auto_hint" {
            request.intent = RetrievalIntent::Auto;
        }
        request.query = trim_query(&request.query).to_owned();
        let adapter = retrieval_store::RetrievalStore {
            store,
            now_ms: chrono::Utc::now().timestamp_millis(),
        };
        let vector = serde_json::from_value::<Vec<f32>>(envelope["query_vector"].clone()).ok();
        let prepared = retrieval_store::search::collect(
            &adapter,
            &scope,
            &request,
            &sources,
            vector.as_deref(),
        );
        let identity = RerankIdentity::new(
            binding.project_root.to_string_lossy().into_owned(),
            binding.session.clone(),
        );
        respond(
            retrieval_store::search::finish(
                prepared,
                &request,
                identity,
                self.retrieval_reranker.as_deref(),
                envelope["capture_lanes"] == true,
            )
            .await,
        )
    }

    fn handle_non_served_method(
        &self,
        channel: u16,
        request: &Value,
        method: &str,
    ) -> HandlerOutcome {
        if non_served_contract::UI_METHODS.contains(&method) {
            return self.handle_ops_facade(channel, request, method);
        }
        let (_, binding) = match self.management_binding(channel, request, method) {
            Ok(value) => value,
            Err(outcome) => return outcome,
        };
        let store = self.store.get();
        if non_served_contract::UI_READ_METHODS.contains(&method) && store.is_none() {
            return respond(non_served_contract::partial_state_body());
        }
        if non_served_contract::PROJECT_METHODS.contains(&method) {
            if let Some(store) = store {
                if let Err(outcome) = self.route_project_identity(channel, store, &binding) {
                    return outcome;
                }
            }
        }
        if method == "mc.dream" {
            return self.dream_control_entry(&binding, request);
        }
        non_served_route_refusal(method)
    }

    // The manual dream controller is deliberately separate from dreamer.run_task.
    // Until a scheduler owns this entry, it starts no host or Rust work.
    fn dream_control_entry(&self, _binding: &SessionBinding, _request: &Value) -> HandlerOutcome {
        non_served_route_refusal("mc.dream")
    }

    fn handle_todo_state_set_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, _binding) =
            match self.management_binding(channel, request, "todo_state.set") {
                Ok(scope) => scope,
                Err(outcome) => return outcome,
            };
        let Some(state_json) = request.get("state_json").and_then(Value::as_str) else {
            return invalid_params_error("todo_state.set requires state_json");
        };
        if state_json.len() > MAX_FACADE_FRAME_BYTES {
            return invalid_params_error("state_json exceeds the 1 MiB limit");
        }
        let Some(owner_message_id) = request.get("owner_message_id").and_then(Value::as_str) else {
            return invalid_params_error("todo_state.set requires owner_message_id");
        };
        if owner_message_id.is_empty() || owner_message_id.len() > 128 {
            return invalid_params_error("owner_message_id must contain 1..=128 bytes");
        }
        let Some(normalized) = crate::injection::normalize_todo_state_json(state_json) else {
            return invalid_params_error("state_json must be a JSON todo array");
        };
        let state_hash = sha256_hex(normalized.as_bytes());
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        match store.set_todo_state(&session_id, &normalized, owner_message_id, &state_hash) {
            Ok(TodoStateSetOutcome::Updated { .. }) | Ok(TodoStateSetOutcome::Noop) => {
                respond(json!({ "ok": true }))
            }
            Err(error) => HandlerOutcome::Error {
                code: "store_write_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    fn handle_session_flush_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, binding) = match self.management_binding(channel, request, "session.flush")
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        if let Some(outcome) = self.flush_async_compaction(&binding) {
            return outcome;
        }
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        match store.arm_soft_refresh(&session_id) {
            Ok(armed) => respond(json!({ "ok": true, "armed": armed })),
            Err(error) => HandlerOutcome::Error {
                code: "store_write_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    fn handle_session_recomp_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, _binding) =
            match self.management_binding(channel, request, "session.recomp") {
                Ok(scope) => scope,
                Err(outcome) => return outcome,
            };
        let Some(command_id) = request.get("command_id").and_then(Value::as_str) else {
            return invalid_params_error("session.recomp requires command_id");
        };
        if command_id.is_empty() || command_id.len() > 128 {
            return invalid_params_error("command_id must contain 1..=128 bytes");
        }
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        match store.load_recomp_command(&session_id, command_id) {
            Ok(Some(row)) => {
                return respond(json!({
                    "ok": true,
                    "disposition": row.disposition,
                }));
            }
            Ok(None) => {}
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: error.to_string(),
                };
            }
        }
        let _guard = match self.try_claim_recomp_session(&session_id) {
            Ok(guard) => guard,
            Err(()) => {
                return respond(json!({
                    "ok": true,
                    "disposition": "already_in_progress",
                }));
            }
        };

        let loaded = match store.load(&session_id) {
            Ok(loaded) => loaded,
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        let has_compartments = match store.has_compartments(&session_id) {
            Ok(has_compartments) => has_compartments,
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        let never_minted = !has_compartments && loaded.core.boundary_id.trim().is_empty();
        if never_minted {
            return match store.record_recomp_command(
                &session_id,
                command_id,
                "nothing_to_do",
                now_ms(),
            ) {
                Ok(row) => respond(json!({
                    "ok": true,
                    "disposition": row.disposition,
                })),
                Err(error) => HandlerOutcome::Error {
                    code: "store_write_failed".to_string(),
                    message: error.to_string(),
                },
            };
        }

        let _reset = match store.reset_session_for_recomp(&session_id, loaded.row_version) {
            Ok(reset) => reset,
            Err(error @ McStoreError::CasConflict { .. }) => {
                // A transform may have committed between the status reads and the reset.
                // The recomp latch remains held; ask the caller to retry rather than
                // claiming a reset that did not use the observed cache version.
                return HandlerOutcome::Error {
                    code: "store_conflict".to_string(),
                    message: error.to_string(),
                };
            }
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_write_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        self.serialized_outputs
            .lock()
            .expect("serialized output cache mutex")
            .remove(&session_id);
        self.boundary_tokens
            .lock()
            .expect("boundary token cache mutex")
            .remove(&session_id);
        match store.record_recomp_command(&session_id, command_id, "started", now_ms()) {
            Ok(row) => respond(json!({
                "ok": true,
                "disposition": row.disposition,
            })),
            Err(error) => HandlerOutcome::Error {
                code: "store_write_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    fn runtime_store_error_value(&self, session_id: &str) -> Value {
        self.runtime_store_errors
            .lock()
            .expect("runtime store errors mutex")
            .get(session_id)
            .map(|error| {
                json!({
                    "code": error.code,
                    "message": error.message,
                    "at_ms": error.at_ms,
                })
            })
            .unwrap_or(Value::Null)
    }

    fn handle_session_delete_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, binding) =
            match self.management_binding(channel, request, "session.delete") {
                Ok(scope) => scope,
                Err(outcome) => return outcome,
            };
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        match store.delete_session(&session_id, &binding.project_root.to_string_lossy()) {
            Ok(deleted_rows) => {
                self.runtime_store_errors
                    .lock()
                    .expect("runtime store errors mutex")
                    .remove(&session_id);
                self.reattaching_sessions
                    .lock()
                    .expect("reattaching sessions mutex")
                    .remove(&session_id);
                self.wrapup_sessions
                    .lock()
                    .expect("wrapup sessions mutex")
                    .remove(&session_id);
                self.recomp_sessions
                    .lock()
                    .expect("recomp sessions mutex")
                    .remove(&session_id);
                // The delete removed the durable rows the lineage caches mirror. While a route
                // is still bound, its in-memory root is the only lineage proof left for facade
                // calls on that route, so it stays until `unbind_route` evicts it.
                let still_bound = self
                    .bindings
                    .lock()
                    .expect("bindings mutex")
                    .values()
                    .any(|candidate| candidate.session == session_id);
                if still_bound {
                    self.guidance_dates
                        .lock()
                        .expect("guidance date mutex")
                        .remove(&session_id);
                } else {
                    self.evict_session_lineage_caches(&session_id);
                }
                respond(json!({ "ok": true, "deleted_rows": deleted_rows }))
            }
            Err(error) => HandlerOutcome::Error {
                code: "store_write_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    /// The project key a bound channel's runs are queued under: the same project identity
    /// the transform resolved when it queued them.
    fn historian_lane_project(
        &self,
        channel: u16,
        binding: &SessionBinding,
        store: &McStore,
    ) -> Result<String, HandlerOutcome> {
        // The same key the transform queued the run under, also while memory is paused.
        self.route_project(channel, store, binding)
            .map(|route| route.key)
    }

    /// `subagent_invocations.read {query, ...}`: the subagent failure sentinel
    /// flow's read of `subagent_invocations`, served on the management surface.
    /// The reply is the management envelope `{result: {rows, more}}`. See
    /// [`subagent_invocations_read`] for the queries and their bounds.
    fn handle_subagent_invocations_read(&self, channel: u16, request: &Value) -> HandlerOutcome {
        // The caller is judged from the daemon's bind stamp, before any argument is read.
        let admitted = match self.bindings.lock().expect("route bindings").get(&channel) {
            Some(binding) => subagent_invocations_read::authorize_caller(
                binding.principal.as_ref(),
                binding.scope.as_ref(),
            ),
            None => Err(format!(
                "{} on a channel with no binding",
                subagent_invocations_read::METHOD
            )),
        };
        if let Err(message) = admitted {
            return HandlerOutcome::Error {
                code: "caller_forbidden".to_string(),
                message,
            };
        }
        let query =
            match subagent_invocations_read::parse(request.get("params").unwrap_or(&Value::Null)) {
                Ok(query) => query,
                Err(message) => return invalid_params_error(message),
            };
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        // The query-only context reader: the op never writes.
        match store.with_context_read(|conn| subagent_invocations_read::run(conn, &query)) {
            Ok(result) => respond(json!({ "result": result })),
            Err(error) => HandlerOutcome::Error {
                code: "store_load_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    fn handle_session_status_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, binding) =
            match self.management_binding(channel, request, "session.status") {
                Ok(scope) => scope,
                Err(outcome) => return outcome,
            };
        let store = match self.store.get() {
            Some(store) => store,
            None => return self.store_refusal(),
        };
        let sample_wrapup_latch = || {
            self.wrapup_sessions
                .lock()
                .expect("wrapup sessions mutex")
                .get(&session_id)
                .map(|session| (Arc::as_ptr(&session.token) as usize, session.rounds))
        };
        let latch_before = sample_wrapup_latch();
        let mut snapshot = match store.load_session_status_snapshot(&session_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        #[cfg(test)]
        if let Some(hook) = self
            .status_snapshot_hook
            .lock()
            .expect("status snapshot hook mutex")
            .take()
        {
            hook();
        }
        let mut wrapup_latch = sample_wrapup_latch();
        if latch_before != wrapup_latch {
            // Holding the latch mutex across SQLite I/O would block wrapup progress. A single
            // bounded re-read instead places the durable snapshot after the observed latch edge.
            snapshot = match store.load_session_status_snapshot(&session_id) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    return HandlerOutcome::Error {
                        code: "store_load_failed".to_string(),
                        message: error.to_string(),
                    };
                }
            };
            wrapup_latch = sample_wrapup_latch();
        }
        let loaded = snapshot.loaded;
        let compartment_count = snapshot.compartment_count;
        let pending_drop_count = snapshot.pending_drop_count;
        let tag_count = snapshot.tag_count;
        let pass_trace = snapshot.pass_trace;
        let coverage = loaded
            .meta
            .coverage_ordinal
            .map(|ordinal| ordinal.to_string())
            .unwrap_or_else(|| "none".to_string());
        let boundary = if loaded.core.boundary_id.trim().is_empty() {
            "absent"
        } else {
            "present"
        };
        let surface = if loaded.meta.tagging_surface_active || loaded.meta.cc_u1_active {
            "active"
        } else {
            "inactive"
        };
        let descent_counters = &loaded.meta.lineage_descent_counters;
        let descent_pending_build_skew = descent_counters.pending_build_skew;
        let descent_pending_no_responses = descent_counters.pending_no_responses;
        let historian = historian_status_summary(&loaded.meta.historian);
        let consecutive_publish_failures = loaded.meta.historian.consecutive_publish_failures;
        let publish_health = if consecutive_publish_failures >= 3 {
            format!("publish health degraded: {consecutive_publish_failures} consecutive failures")
        } else {
            format!("publish failures: {consecutive_publish_failures}")
        };
        // When the Rust module is active, it manages the frozen m0 in its own store
        // instead of the harness SQLite cache. Report the exact session-history slice so
        // status attribution does not estimate size by summing all raw-history p1 rows.
        let compartment_tokens = loaded
            .core
            .frozen_units
            .iter()
            .find(|unit| unit.key == "m0")
            .and_then(|unit| {
                decay_render::extract_m0_block(&unit.frozen_payload, "session-history")
            })
            .map(|block| mc_tokenizer::estimate_tokens(&block))
            .unwrap_or(0);
        let newest_pass_at = pass_trace
            .as_ref()
            .map(|trace| {
                trace
                    .last_received_at_ms
                    .max(trace.last_completed_at_ms)
                    .max(trace.last_reject_at_ms.unwrap_or(0))
            })
            .unwrap_or(0)
            .max(loaded.meta.last_committed_pass_at_ms);
        let short_session = session_id.chars().take(12).collect::<String>();
        let age = format_traffic_age(newest_pass_at, now_ms());
        // Status can outlive the caller's current lineage. Naming the subject and its
        // durable traffic age makes a stale read visible instead of silently ambiguous.
        // Structured fields accompany the prose so reconciliation code can determine
        // completion without parsing the summary or issuing another operation: a retained
        // delivered-command record includes its coverage, row version, and current wrapup state.
        let m1_signal = match crate::m1_compose::m1_revision_signal_parts_for_pass(
            store,
            &binding.project_root.to_string_lossy(),
            &binding.project_root.to_string_lossy(),
            &session_id,
            loaded.meta.user_profile_version,
            !loaded.meta.memory_disabled,
            now_ms(),
        ) {
            Ok(signal) => Some(signal),
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        let pending_m1_delta = loaded.meta.initialized
            && m1_signal.as_ref().is_some_and(|signal| {
                signal.revision != signal.equivalent_applied_revision(loaded.meta.m1_revision)
            });
        let pending_m1_age_ms = pending_m1_delta
            .then(|| now_ms().saturating_sub(loaded.meta.m1_pending_since_ms.unwrap_or(now_ms())));
        let tail_hygiene = loaded.meta.tail_hygiene_baseline.as_ref().map(|baseline| {
            let (u, t) = crate::tail_hygiene::effective_tail_hygiene(baseline);
            json!({
                "u": u,
                "t": t,
                "severity": (u as f64 / t.max(1) as f64).clamp(0.0, 1.0),
                "evaluable": baseline.evaluable && !baseline.generation_invalidated,
                "generation_invalidated": baseline.generation_invalidated,
                "baseline_generation": baseline.baseline_generation,
                "computed_at_ms": baseline.computed_at_ms,
                "reclaimable_tool_output_count": crate::transform::reclaimable_tool_output_count(Some(baseline)),
            })
        });
        let raw_passthrough = raw_passthrough_status(&loaded);
        let raw_passthrough_summary = if raw_passthrough.is_null() {
            String::new()
        } else {
            format!(
                ", serving raw: retained boundary {} absent from the live array",
                loaded.core.boundary_id
            )
        };
        let summary = sanitize_status_text(
            &format!(
                "session {short_session} (last active {age}): {} {}, coverage ordinal {coverage}, boundary {boundary}{raw_passthrough_summary}, {} pending {} ({} unserved, {} provider drops applied), {} {}, pending m1 delta {}, last historian: {historian}, {publish_health}, surface {surface}",
                compartment_count,
                plural_word(compartment_count, "compartment"),
                pending_drop_count,
                plural_word(pending_drop_count, "drop"),
                snapshot.provider_unserved_drop_count,
                snapshot.provider_applied_drop_count,
                tag_count,
                plural_word(tag_count, "tag"),
                pending_m1_age_ms
                    .map(|age| format!("true age_ms={age}"))
                    .unwrap_or_else(|| "false".to_string()),
            ),
            500,
        );
        let wrapup_active = wrapup_latch.map(|(_, rounds)| rounds);
        // Which runner this session's completions used and why. A session with no
        // completion in this process yet reports what its route resolves to now.
        let (historian_runner_status, dreamer_runner_status) = {
            let config = self.effective_config(&binding.project_root);
            let log = self
                .runner_choices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let status = |role, resolved| match log.get(role, &session_id) {
                Some(choice) => choice.to_value("last_completion"),
                None => runner_choices::RunnerChoice::new(resolved, &binding.harness)
                    .to_value("resolved_for_route"),
            };
            (
                status(
                    runner_choices::RunnerRole::Historian,
                    config.historian_runner_for(&binding.harness),
                ),
                status(
                    runner_choices::RunnerRole::Dreamer,
                    config.dreamer_runner_for(&binding.harness),
                ),
            )
        };
        let response = json!({
            "ok": true,
            "summary": summary,
            "wrapup_active": wrapup_active.is_some(),
            "wrapup_rounds": wrapup_active,
            "coverage_ordinal": loaded.meta.coverage_ordinal,
            "row_version": loaded.row_version,
            "boundary_present": !loaded.core.boundary_id.trim().is_empty(),
            "compartment_count": compartment_count,
            "compartment_tokens": compartment_tokens,
            "pending_drop_count": pending_drop_count,
            "provider_queued_drop_count": snapshot.provider_queued_drop_count,
            "provider_unserved_drop_count": snapshot.provider_unserved_drop_count,
            "provider_applied_drop_count": snapshot.provider_applied_drop_count,
            "tag_count": tag_count,
            "pending_m1_delta": pending_m1_delta,
            "pending_m1_age_ms": pending_m1_age_ms,
            "raw_passthrough": raw_passthrough,
            "historian": {
                "consecutive_publish_failures": consecutive_publish_failures,
                "publish_health_degraded": consecutive_publish_failures >= 3,
                "last_outcome": historian,
                "last_failure": &loaded.meta.historian.last_failure,
                "last_no_fire": &loaded.meta.historian.last_no_fire,
                "refusal_stage": loaded.meta.historian.last_failure.as_deref()
                    .or(loaded.meta.historian.last_no_fire.as_deref())
                    .and_then(historian::runner_refusal_stage_from_detail)
                    .map(|stage| stage.as_str()),
                "canonical_cause": loaded.meta.historian.last_failure.as_deref()
                    .or(loaded.meta.historian.last_no_fire.as_deref())
                    .and_then(historian::runner_refusal_stage_from_detail)
                    .map(|stage| stage.canonical_cause()),
                "recent_decisions": &loaded.meta.historian.recent_decisions,
                "runner": historian_runner_status,
            },
            "dreamer": {
                "runner": dreamer_runner_status,
            },
            // Keep the current-pass attribution separate from the explicitly historical
            // `last_divergence` field so stable status reads cannot imply a fresh bust.
            "pass_trace": pass_trace,
            "runtime_store_error": self.runtime_store_error_value(&session_id),
            "single_store": store.context_domain_status(),
            "publish_timing": store.load_publish_timing(&session_id).ok().flatten(),
            "tail_identity_re_adopt_count": loaded.meta.tail_identity_re_adopt_count,
            "fake_compaction": {
                "compaction_seen": descent_counters.compaction_seen,
                "compaction_answered": descent_counters.compaction_answered,
                "fork_arm": descent_counters.fork_arm,
                "descent_pending": {
                    "build_skew": descent_pending_build_skew,
                    "no_responses": descent_pending_no_responses,
                },
                "dispositions": {
                    "descended": descent_counters.descended,
                    "unknown_ancestor": descent_counters.unknown_ancestor,
                    "already_bootstrapped": descent_counters.already_bootstrapped,
                    "not_compaction_shape": descent_counters.not_compaction_shape,
                    "observed_flag_missing_shape_present": descent_counters.observed_flag_missing_shape_present,
                    "cycle_detected": descent_counters.cycle_detected,
                },
                "last_disposition": loaded.meta.lineage_descent_disposition,
                "descent_completed": loaded.meta.descent_completed,
            },
            "epochs": {
                "memory_render_epoch": MEMORY_RENDER_FORMAT_EPOCH,
                "compartment_render_epoch": COMPARTMENT_RENDER_FORMAT_EPOCH,
                "profile_epoch": PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC,
                "tagger_epoch": TAGGER_FEATURE_EPOCH,
            },
            "usage": {
                "current_total_input_tokens": loaded.meta.last_usage.as_ref().map_or(0, |usage| usage.current_total_input_tokens),
                "context_limit_tokens": loaded.meta.last_usage.as_ref().map_or(0, |usage| usage.context_limit_tokens),
            },
            "tail_hygiene": tail_hygiene,
        });
        respond(response)
    }

    fn replayed_wrapup_response(row: mc_store::WrapupCommandRow) -> HandlerOutcome {
        if row.disposition == "failed" {
            if let Some((reason, summary, detail)) = terminal_wrapup_failure_fields(&row.summary) {
                return respond(json!({
                    "ok": false,
                    "disposition": "failed",
                    "rounds": row.rounds,
                    "summary": summary,
                    "reason": reason,
                    "detail": detail,
                    "replayed": true,
                }));
            }
        }
        respond(json!({
            "ok": row.disposition != "failed",
            "disposition": row.disposition,
            "rounds": row.rounds,
            "summary": row.summary,
            "replayed": true,
        }))
    }

    async fn handle_session_wrapup_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (session_id, _binding) =
            match self.management_binding(channel, request, "session.wrapup") {
                Ok(scope) => scope,
                Err(outcome) => return outcome,
            };
        let command_id = match request.get("command_id") {
            None => None,
            Some(value) => match value.as_str() {
                // Empty ids are rejected so every retrying caller cannot collide on one
                // shared durable ledger key.
                Some(command_id) if !command_id.is_empty() && command_id.len() <= 128 => {
                    Some(command_id)
                }
                _ => return HandlerOutcome::Error {
                    code: "bad_request".to_string(),
                    message:
                        "session.wrapup command_id must be a nonempty string of at most 128 bytes"
                            .to_string(),
                },
            },
        };
        let store = match self.store.get() {
            Some(store) => Arc::clone(store),
            None => return self.store_refusal(),
        };
        if let Some(command_id) = command_id {
            match store.load_wrapup_command(&session_id, command_id) {
                // Rows written by the current terminal-failure path carry a marker in their
                // summary, while older failed rows remain eligible for a successful retry.
                Ok(Some(row))
                    if row.disposition == "failed"
                        && terminal_wrapup_failure_fields(&row.summary).is_none() => {}
                Ok(Some(row)) => return Self::replayed_wrapup_response(row),
                Ok(None) => {}
                Err(error) => {
                    return HandlerOutcome::Error {
                        code: "store_load_failed".to_string(),
                        message: error.to_string(),
                    };
                }
            }
        }
        // An old-lane wrapup drove the historian over the request the last `transform`
        // pass left behind. That route is retired, so no such request can exist and a
        // retry could never succeed: answer by name instead of a retryable refusal.
        // Runner sessions wrap up through their own `/ctx-wrapup` command.
        retired_route("session.wrapup")
    }

    fn freeze_prompt_surface_selection(
        &self,
        session_id: &str,
        requested: PromptSurfaceSelection,
    ) -> PromptSurfaceSelection {
        let mut epochs = self
            .prompt_surface_epochs
            .lock()
            .expect("prompt surface epoch mutex");
        if let Some(frozen) = epochs.get(session_id) {
            if frozen.model_key == requested.model_key
                && prompt_surface::selection_freeze_identity(frozen)
                    == prompt_surface::selection_freeze_identity(&requested)
            {
                return frozen.clone();
            }
        }
        epochs.insert(session_id.to_string(), requested.clone());
        requested
    }

    fn prompt_surface_selection_from_value(
        &self,
        request: &Value,
    ) -> Result<PromptSurfaceSelection, HandlerOutcome> {
        let preset = match request
            .get("preset")
            .or_else(|| request.get("prompt_surface_preset"))
        {
            None | Some(Value::Null) => PromptSurfacePreset::Full,
            Some(Value::String(value)) if value == "full" => PromptSurfacePreset::Full,
            Some(Value::String(value)) if value == "light" => PromptSurfacePreset::Light,
            _ => {
                return Err(invalid_params_error(
                    "prompt_surface preset must be \"full\" or \"light\"",
                ));
            }
        };
        let model_key = request
            .get("prompt_surface_model_key")
            .or_else(|| request.get("model_key"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let config_identity = match request
            .get("prompt_surface_config_identity")
            .or_else(|| request.get("config_identity"))
        {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.trim().to_string(),
            _ => {
                return Err(invalid_params_error(
                    "prompt_surface config identity must be a string",
                ));
            }
        };
        let descriptions = request
            .get("tool_descriptions")
            .or_else(|| request.get("prompt_surface_tool_descriptions"));
        let mut tool_descriptions = BTreeMap::new();
        if let Some(value) = descriptions.filter(|value| !value.is_null()) {
            let Some(object) = value.as_object() else {
                return Err(invalid_params_error(
                    "prompt_surface tool_descriptions must be an object",
                ));
            };
            for (tool_id, description) in object {
                if !prompt_surface::is_known_tool_id(tool_id) {
                    prompt_surface::warn_ignored_unknown_tool_description(tool_id);
                    continue;
                }
                let Some(description) = description.as_str() else {
                    return Err(invalid_params_error(format!(
                        "prompt_surface tool_descriptions.{tool_id} must be a string"
                    )));
                };
                if description.trim().is_empty() {
                    return Err(invalid_params_error(format!(
                        "prompt_surface tool_descriptions.{tool_id} must not be empty"
                    )));
                }
                tool_descriptions.insert(tool_id.clone(), description.to_string());
            }
        }
        let guidance_override = match request
            .get("guidance_override")
            .or_else(|| request.get("prompt_surface_guidance_override"))
        {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
            Some(Value::String(_)) => None,
            _ => {
                return Err(invalid_params_error(
                    "prompt_surface guidance_override must be a string",
                ));
            }
        };
        Ok(PromptSurfaceSelection {
            model_key,
            config_identity,
            preset,
            guidance_override,
            tool_descriptions,
        })
    }

    fn handle_prompt_surface_manifest_value(
        &self,
        channel: u16,
        request: &Value,
    ) -> HandlerOutcome {
        let Some(session_id) = request.get("session_id").and_then(Value::as_str) else {
            return invalid_params_error("manifest.get requires session_id");
        };
        let binding = match self.resolve_binding(channel, session_id) {
            Ok(binding) => binding,
            Err(error) => {
                return match error {
                    BindingError::Unbound => HandlerOutcome::Error {
                        code: "route_unbound".to_string(),
                        message: "manifest.get on a channel with no session binding".to_string(),
                    },
                    BindingError::SessionMismatch => HandlerOutcome::Error {
                        code: "session_mismatch".to_string(),
                        message: "request session_id does not match the channel's bound session"
                            .to_string(),
                    },
                };
            }
        };
        let mut requested = match self.prompt_surface_selection_from_value(request) {
            Ok(selection) => selection,
            Err(error) => return error,
        };
        if requested.guidance_override.is_none() {
            requested.guidance_override = binding.config.prompt_surface_guidance_override;
        }
        let selection = self.freeze_prompt_surface_selection(session_id, requested);
        let mut tools = prompt_surface::session_tools(&selection);
        if !binding.config.smart_notes_enabled {
            prompt_surface::disable_smart_notes_in_tools(&mut tools, selection.preset);
        }
        respond(json!({
            "ok": true,
            "preset": selection.preset.as_str(),
            "served_preset": if prompt_surface::tool_manifest_falls_back(selection.preset) {
                "full"
            } else {
                selection.preset.as_str()
            },
            "preset_fallback": prompt_surface::tool_manifest_falls_back(selection.preset),
            "fallback_notice": prompt_surface::tool_manifest_falls_back(selection.preset)
                .then_some(prompt_surface::LIGHT_FALLBACK_NOTICE),
            "content_epoch": if binding.config.smart_notes_enabled {
                prompt_surface::manifest_content_epoch(&selection)
            } else { sha256_hex(&serde_json::to_vec(&tools).unwrap_or_default()) },
            "tools": tools,
        }))
    }

    fn handle_guidance_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let store = match self.store.get() {
            Some(store) => Arc::clone(store),
            None => return self.store_refusal(),
        };
        let Some(session_id) = request.get("session_id").and_then(Value::as_str) else {
            return HandlerOutcome::Error {
                code: "bad_request".to_string(),
                message: "guidance.get requires session_id".to_string(),
            };
        };
        let binding = match self.resolve_binding(channel, session_id) {
            Ok(binding) => binding,
            Err(error) => {
                return match error {
                    BindingError::Unbound => HandlerOutcome::Error {
                        code: "route_unbound".to_string(),
                        message: "guidance.get on a channel with no session binding".to_string(),
                    },
                    BindingError::SessionMismatch => HandlerOutcome::Error {
                        code: "session_mismatch".to_string(),
                        message: "request session_id does not match the channel's bound session"
                            .to_string(),
                    },
                };
            }
        };

        let tool_present = match request.get("tool_present") {
            None => false,
            Some(value) => match value.as_bool() {
                Some(value) => value,
                None => {
                    return HandlerOutcome::Error {
                        code: "bad_request".to_string(),
                        message: "guidance.get tool_present must be a boolean".to_string(),
                    };
                }
            },
        };
        let profile = match request.get("serializer_profile").and_then(Value::as_str) {
            None => Some(SerializerProfile::ClaudeCodeAnthropic),
            Some(value) => match SerializerProfile::parse(value) {
                Some(profile) => Some(profile),
                None => return unknown_serializer_profile_error(),
            },
        };
        let mut requested_selection = match self.prompt_surface_selection_from_value(request) {
            Ok(selection) => selection,
            Err(error) => return error,
        };
        if requested_selection.guidance_override.is_none() {
            requested_selection.guidance_override =
                binding.config.prompt_surface_guidance_override.clone();
        }
        let selection = self.freeze_prompt_surface_selection(session_id, requested_selection);
        // Claude Code keys the reduce-capable variant on its acknowledgement contract. A
        // Broca session gets it whenever its tool array includes ctx_reduce, because the
        // transform tags that session's messages. OpenCode builds its own guidance.
        let active = binding.config.compaction_enabled
            && (cc_u1_active(profile, tool_present)
                || (matches!(profile, Some(SerializerProfile::OwnedBroca)) && tool_present));
        let expected_variant = if active { "full" } else { "no_reduce" };
        if let Some(variant) = request.get("variant").and_then(Value::as_str) {
            if variant != expected_variant {
                return HandlerOutcome::Error {
                    code: "bad_request".to_string(),
                    message: format!(
                        "guidance variant {variant:?} contradicts tool_present={tool_present}"
                    ),
                };
            }
        }
        let date_line = match self.guidance_date_for_session(&store, session_id) {
            Ok(date) => date,
            Err(error) => {
                return HandlerOutcome::Error {
                    code: "store_write_failed".to_string(),
                    message: error.to_string(),
                };
            }
        };
        let mut config = binding.config.clone();
        if let Some(language) = request.get("language").and_then(Value::as_str) {
            config.language = Some(language.to_string());
        }
        let subagent = match request.get("subagent") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return invalid_params_error("guidance.get subagent must be a boolean"),
        };
        let text = prompt_surface::compose_guidance(&selection, &config, subagent, active);
        let text_for_bytes = text.as_str();
        let bytes = guidance_bytes_for(text_for_bytes, &date_line);
        respond(json!({
            "ok": true,
            "bytes": bytes,
            "hash": sha256_hex(bytes.as_bytes()),
            // The date line changes every day, so content_hash excludes it. Include the
            // selected preset so a future missing-asset fallback cannot reuse the full hash.
            "content_hash": prompt_surface::guidance_content_hash(text_for_bytes, selection.preset),
            "preset": selection.preset.as_str(),
            "served_preset": selection.preset.as_str(),
            "preset_fallback": false,
            "fallback_notice": Value::Null,
            "manifest_content_epoch": prompt_surface::manifest_content_epoch(&selection),
            "manifest_preset_fallback": prompt_surface::tool_manifest_falls_back(selection.preset),
            "tool_manifest": prompt_surface::session_tools_for_config(&selection, &config),
        }))
    }

    fn guidance_date_for_session(
        &self,
        store: &McStore,
        session_id: &str,
    ) -> Result<String, mc_store::McStoreError> {
        for _ in 0..2 {
            let loaded = store.load_meta(session_id)?;
            if !loaded.meta.guidance_date.is_empty() {
                self.guidance_dates
                    .lock()
                    .expect("guidance date mutex")
                    .remove(session_id);
                return Ok(loaded.meta.guidance_date);
            }
            let date_line = self
                .guidance_dates
                .lock()
                .expect("guidance date mutex")
                .entry(session_id.to_string())
                .or_insert_with(|| self.guidance_date_line())
                .clone();
            let Some(expected) = loaded.row_version else {
                return Ok(date_line);
            };
            let mut meta = loaded.meta.clone();
            meta.guidance_date.clone_from(&date_line);
            match store.commit_meta(session_id, Some(expected), &meta) {
                Ok(_) => return Ok(date_line),
                Err(mc_store::McStoreError::CasConflict { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(self
            .guidance_dates
            .lock()
            .expect("guidance date mutex")
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| self.guidance_date_line()))
    }

    fn memory_holder_metrics(&self) -> Value {
        let (serialized_bytes, serialized_count) = self
            .serialized_outputs
            .lock()
            .expect("serialized output cache mutex")
            .metrics();
        let (tag_baseline_bytes, tag_baseline_count) = transform::tag_baseline_cache_metrics();
        let (boundary_bytes, boundary_count) = {
            let cache = self
                .boundary_tokens
                .lock()
                .expect("boundary token cache mutex");
            (cache.retained_bytes, cache.sessions.len())
        };

        // Every byte/count field uses zero when that accounting domain is empty.
        json!({
            "serialized_output": {
                "charged_bytes": serialized_bytes,
                "entry_count": serialized_count,
            },
            "tag_baseline": {
                "charged_bytes": tag_baseline_bytes,
                "entry_count": tag_baseline_count,
            },
            "boundary_token": {
                "charged_bytes": boundary_bytes,
                "entry_count": boundary_count,
            },
        })
    }

    fn handle_status_value(&self, request: &Value) -> HandlerOutcome {
        let store = match self.store.get() {
            Some(store) => Arc::clone(store),
            None => return self.store_refusal(),
        };
        let Some(session_id) = request.get("session_id").and_then(Value::as_str) else {
            return match store.load("__health__") {
                Ok(state) => respond(json!({
                    "ok": true,
                    "store_open": true,
                    "initialized": state.meta.initialized,
                    "row_version": state.row_version,
                    "epochs": {
                        "memory_render_epoch": MEMORY_RENDER_FORMAT_EPOCH,
                        "compartment_render_epoch": COMPARTMENT_RENDER_FORMAT_EPOCH,
                        "profile_epoch": PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC,
                        "tagger_epoch": TAGGER_FEATURE_EPOCH,
                    },
                    "storage_versions": storage_versions_block(&store),
                    "memory_holders": self.memory_holder_metrics(),
                    "async_bus": self.async_bus_health(),
                })),
                Err(e) => HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: e.to_string(),
                },
            };
        };
        let loaded = match store.load(session_id) {
            Ok(loaded) => loaded,
            Err(e) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: e.to_string(),
                };
            }
        };
        let pass_trace = match store.load_pass_trace(session_id) {
            Ok(pass_trace) => pass_trace,
            Err(e) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: e.to_string(),
                };
            }
        };
        let side_channel_status = match store.historian_side_channel_status(session_id) {
            Ok(status) => status,
            Err(e) => {
                return HandlerOutcome::Error {
                    code: "store_load_failed".to_string(),
                    message: e.to_string(),
                };
            }
        };
        let mut historian = json!(&loaded.meta.historian);
        let historian_fields = historian
            .as_object_mut()
            .expect("historian status serializes as an object");
        historian_fields.insert(
            "side_channel_pending_count".to_string(),
            json!(side_channel_status.pending_count),
        );
        historian_fields.insert(
            "side_channel_last_failure".to_string(),
            json!(side_channel_status.last_failure),
        );
        respond(json!({
            "ok": true,
            "store_open": true,
            "session_id": session_id,
            "initialized": loaded.meta.initialized,
            "row_version": loaded.row_version,
            "historian": historian,
            "publication_floor_ordinal": loaded.meta.publication_floor_ordinal,
            "raw_passthrough": raw_passthrough_status(&loaded),
            "tail_identity_re_adopt_count": loaded.meta.tail_identity_re_adopt_count,
            "pass_trace": pass_trace,
            "runtime_store_error": self.runtime_store_error_value(session_id),
            "epochs": {
                "memory_render_epoch": MEMORY_RENDER_FORMAT_EPOCH,
                "compartment_render_epoch": COMPARTMENT_RENDER_FORMAT_EPOCH,
                "profile_epoch": PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC,
                "tagger_epoch": TAGGER_FEATURE_EPOCH,
            },
            "storage_versions": storage_versions_block(&store),
            "async_bus": self.async_bus_health(),
        }))
    }

    fn register_dreamer_run(&self, session_id: &str) -> DreamerRunGuard {
        self.active_dreamer_runs
            .lock()
            .expect("dreamer registry mutex")
            .insert(session_id.to_string());
        DreamerRunGuard {
            registry: Arc::clone(&self.active_dreamer_runs),
            session_id: session_id.to_string(),
        }
    }

    #[cfg(test)]
    fn dreamer_run_registered(&self, session_id: &str) -> bool {
        self.active_dreamer_runs
            .lock()
            .expect("dreamer registry mutex")
            .contains(session_id)
    }

    fn unregister_dreamer_run(&self, session_id: &str) {
        self.active_dreamer_runs
            .lock()
            .expect("dreamer registry mutex")
            .remove(session_id);
    }

    fn dream_task_settings(&self, project_root: &Path) -> Result<Value, HandlerOutcome> {
        #[cfg(test)]
        if let Some(settings) = &self.fixed_dream_settings {
            return Ok(settings.clone());
        }
        use config_parity::CoreConfigResolver;
        use mc_store::parity_schema_manifest::CapabilityResult;
        match config_parity::TrustedConfigResolver::from_environment().resolve(
            &config_parity::ConfigResolveRequest {
                user_config_path: String::new(),
                project_root: project_root.to_string_lossy().into_owned(),
                generation: mc_store::parity_schema_manifest::Generation(0),
            },
        ) {
            CapabilityResult::Available { value } => Ok(value.settings),
            CapabilityResult::Degraded { reason, .. }
            | CapabilityResult::Unavailable { reason } => Err(HandlerOutcome::Error {
                code: "unavailable_capability".into(),
                message: format!("dreamer config unavailable: {}", reason.code),
            }),
        }
    }

    async fn handle_dreamer_run_task(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (ledger_session, binding) =
            match self.management_binding(channel, request, "dreamer.run_task") {
                Ok(value) => value,
                Err(outcome) => return outcome,
            };
        if !binding.config.memory_enabled {
            return HandlerOutcome::Error {
                code: "memory_disabled".to_string(),
                message: "project memory is disabled; dreamer tasks cannot run".to_string(),
            };
        }
        let Some(store) = self.store.get().cloned() else {
            return self.store_refusal();
        };
        let Some(task) = request.get("task").and_then(Value::as_str) else {
            return invalid_params_error("dreamer.run_task requires task");
        };
        let config = self.effective_config(&binding.project_root);
        let activated = config.rust_background_enabled();
        let canonical = mc_store::dream_scheduler::schedules::CANONICAL_TASKS
            .into_iter()
            .find(|name| name.as_str() == task);
        // A plugin route still runs every task Rust has not published, exactly as
        // with the switch off; only a published task belongs to the Rust scheduler.
        if activated && dream_claim::plugin_lane(&binding) {
            if canonical.is_some_and(|name| self.dream_task_published(channel, &binding, name)) {
                return HandlerOutcome::Error {
                    code: "rust_scheduler_owns_task".into(),
                    message: format!("Rust scheduler owns dreamer task {task:?}"),
                };
            }
        } else if activated {
            let available = canonical.is_some()
                && (config.smart_notes_enabled || task != "evaluate-smart-notes");
            if !available {
                return invalid_params_error(format!("unknown dreamer task {task:?}"));
            }
            let settings = match self.dream_task_settings(&binding.project_root) {
                Ok(settings) => settings,
                Err(outcome) => return outcome,
            };
            let enabled = settings["dreamer"]["tasks"][task]["schedule"]
                .as_str()
                .is_some_and(|schedule| !schedule.trim().is_empty());
            if !enabled {
                return invalid_params_error(format!("unknown dreamer task {task:?}"));
            }
            // Ownership comes only from the published list; request fields and
            // config alone cannot claim a task for Rust.
            if canonical.is_some_and(|name| self.dream_task_published(channel, &binding, name)) {
                return HandlerOutcome::Error {
                    code: "rust_scheduler_owns_task".into(),
                    message: format!("Rust scheduler owns dreamer task {task:?}"),
                };
            }
            return HandlerOutcome::Error {
                code: "unavailable_capability".into(),
                message: format!("Rust implementation unavailable for dreamer task {task:?}"),
            };
        }
        if task != CLASSIFY_TASK {
            // Enumerating the task here is a capability boundary: callers cannot use this
            // route to select an arbitrary system prompt, model, or tool-enabled run.
            return invalid_params_error(format!("unknown dreamer task {task:?}"));
        }
        let Some(command_id) = request.get("command_id").and_then(Value::as_str) else {
            return invalid_params_error("dreamer.run_task requires command_id");
        };
        if command_id.trim().is_empty() || command_id.len() > 256 {
            return invalid_params_error("dreamer.run_task command_id must be 1-256 bytes");
        }
        // Classification writes land in context.db under the route's project identity.
        // An `authority_generation` sent by an older host is accepted and ignored.
        let authority_project = match self.route_project_identity(channel, &store, &binding) {
            Ok(project) => project,
            Err(outcome) => return outcome,
        };
        let Some(payload) = request.get("payload").and_then(Value::as_object) else {
            return invalid_params_error("dreamer.run_task requires an object payload");
        };
        let Some(prompt_body) = payload.get("prompt_body").and_then(Value::as_str) else {
            return invalid_params_error("classify payload requires prompt_body");
        };
        if prompt_body.len() > MAX_CLASSIFY_PROMPT_BYTES {
            return HandlerOutcome::Error {
                code: "payload_too_large".to_string(),
                message: format!("classify prompt_body exceeds {MAX_CLASSIFY_PROMPT_BYTES} bytes"),
            };
        }
        if payload.get("items").and_then(Value::as_array).is_none() {
            return invalid_params_error("classify payload requires items");
        }

        if let Ok(Some(recorded)) = store.load_dream_task_command(&ledger_session, command_id) {
            return replay_dream_task_response(&recorded.response_json);
        }

        let requested_model_chain = match request.get("model_chain") {
            None => None,
            Some(Value::Array(entries)) if entries.len() <= 16 => {
                let mut models = Vec::with_capacity(entries.len());
                for entry in entries {
                    let Some(model) = entry.as_str() else {
                        return invalid_params_error(
                            "dreamer.run_task model_chain entries must be strings",
                        );
                    };
                    if model.trim().is_empty() || model.len() > 256 {
                        return invalid_params_error(
                            "dreamer.run_task model_chain entries must be 1-256 bytes",
                        );
                    }
                    if !models.iter().any(|existing| existing == model) {
                        models.push(model.to_string());
                    }
                }
                Some(models)
            }
            Some(Value::Array(_)) => {
                return invalid_params_error(
                    "dreamer.run_task model_chain supports at most 16 entries",
                );
            }
            Some(_) => {
                return invalid_params_error("dreamer.run_task model_chain must be an array");
            }
        };
        // The host resolves each dreamer task's model chain and sends it; the module
        // keeps no chain of its own to fall back to.
        let Some(model_chain) = requested_model_chain.as_deref() else {
            tracing::warn!(
                "mc-module: dreamer.run_task {task} refused: the request carried no model_chain"
            );
            return HandlerOutcome::Error {
                code: "model_chain_missing".to_string(),
                message: "dreamer.run_task requires the host-resolved model_chain".to_string(),
            };
        };
        // Optional `model_variants` maps a chain model to its host-configured variant
        // (for example an OpenCode reasoning variant), sent to the runner as
        // `model.variant`. Older hosts omit it and their sends keep naming no variant.
        let model_variants: BTreeMap<String, String> = match request.get("model_variants") {
            None | Some(Value::Null) => BTreeMap::new(),
            Some(Value::Object(entries)) => {
                let mut variants = BTreeMap::new();
                for (model, variant) in entries {
                    let Some(variant) = variant.as_str() else {
                        return invalid_params_error(
                            "dreamer.run_task model_variants values must be strings",
                        );
                    };
                    if variant.trim().is_empty() || variant.len() > 256 {
                        return invalid_params_error(
                            "dreamer.run_task model_variants values must be 1-256 bytes",
                        );
                    }
                    variants.insert(model.clone(), variant.to_string());
                }
                variants
            }
            Some(_) => {
                return invalid_params_error("dreamer.run_task model_variants must be an object");
            }
        };
        let classify_system_prompt = historian_prompt::with_content_language_directive(
            CLASSIFY_SYSTEM_PROMPT,
            binding.config.language.as_deref(),
            historian_prompt::ContentLanguageDirectiveOptions::default(),
        );
        let host_completion = match request.get("host_completion") {
            None | Some(Value::Null) => None,
            Some(value) => match parse_host_classify_completion(value) {
                Ok(completion) => Some(completion),
                Err(message) => return invalid_params_error(message),
            },
        };
        // Under the host runner this module has no completion runner to attempt the
        // chain on. The request is answered with what the host needs to run the
        // completion itself, and the host sends the text back on a second request.
        // Nothing is recorded in the command ledger, so that second request under
        // the same command id is not answered from a replay of this one.
        let dreamer_runner = self
            .effective_config(&binding.project_root)
            .dreamer_runner_for(&binding.harness);
        self.runner_choices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(
                runner_choices::RunnerRole::Dreamer,
                &ledger_session,
                runner_choices::RunnerChoice::new(dreamer_runner, &binding.harness),
            );
        // A runner-lane route runs the completion on its own runner, so it is never
        // asked to run and resend it as a host completion.
        let session_runner = session_runner_route(&binding, dreamer_runner);
        let runner_identity = runner_bind_identity(&binding);
        if host_completion.is_none()
            && dreamer_runner.kind == HistorianRunnerKind::Host
            && session_runner.is_none()
        {
            tracing::info!(
                "mc-module: classify runner=host ({}): the host runs the completion for command {command_id}",
                dreamer_runner.source.describe()
            );
            return respond(json!({
                "ok": false,
                "code": HOST_COMPLETION_REQUIRED,
                "message": "the dreamer runner is host: run the classify completion on the host and resend it as host_completion",
                "system_prompt": classify_system_prompt.as_ref(),
                "max_output_tokens": CLASSIFY_MAX_OUTPUT_TOKENS,
                "temperature": CLASSIFY_TEMPERATURE,
            }));
        }
        let mut attempts = 0usize;
        // Every attempt's failure is kept. Overwriting one slot reported whichever model
        // happened to be last and threw away the cause of the run that actually broke.
        let mut attempt_errors: Vec<String> = Vec::new();
        let mut output = None;
        let runner = if host_completion.is_some() {
            "host"
        } else {
            "module"
        };
        if let Some(completion) = host_completion {
            attempts = 1;
            let outcome = if has_manifest_envelope(&completion.text) {
                "manifest"
            } else {
                "no_manifest"
            };
            tracing::info!(
                "mc-module: classify attempt=1 model={} session=host outcome={outcome}",
                completion.model
            );
            if outcome == "manifest" {
                output = Some((
                    completion.model,
                    historian_producer::ProducerOutput {
                        text: completion.text,
                        length_capped: completion.length_capped,
                        usage: completion.usage,
                    },
                    "host".to_string(),
                ));
            } else {
                attempt_errors.push(format!(
                    "{}: classify host completion returned no classify manifest envelope",
                    completion.model
                ));
            }
        }
        // The chain is walked here only when this module ran the completion itself.
        let producer_models: &[String] = if runner == "host" { &[] } else { model_chain };
        for model in producer_models {
            attempts += 1;
            // Each attempt gets its OWN provider session. An attempt can end while its run
            // is still active (a parked run, or one abandoned at the await deadline), and a
            // send into a session that still holds an active run is queued behind it rather
            // than started -- which the classifier cannot drain.
            let child_session =
                child_session_id(&authority_project, command_id, next_attempt_nonce(now_ms()));
            let _dreamer_run_guard = self.register_dreamer_run(&child_session);
            let mut record_attempt = |outcome: &str, detail: String| {
                tracing::info!(
                    "mc-module: classify attempt={attempts} model={model} session={child_session} outcome={outcome}{}",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    }
                );
                if !detail.is_empty() {
                    attempt_errors.push(format!("{model}: {detail}"));
                }
            };
            let connected = match &session_runner {
                Some(route) => {
                    self.producer_factory
                        .connect_session_runner(&runner_identity, route)
                        .await
                }
                None => self.producer_factory.connect(&binding.project_root).await,
            };
            let mut producer = match connected {
                Ok(producer) => producer,
                Err(error) => {
                    record_attempt("connect_failed", error.to_string());
                    continue;
                }
            };
            let started = producer
                .start_with_generation(
                    &child_session,
                    classify_system_prompt.as_ref(),
                    prompt_body,
                    model,
                    model_variants.get(model).map(String::as_str),
                    CLASSIFY_MAX_OUTPUT_TOKENS,
                    CLASSIFY_TEMPERATURE,
                )
                .await;
            let attempt_output = match started {
                Ok(handle) => match producer
                    .await_output_with_timeout(&handle.run_id, CLASSIFY_AWAIT_TIMEOUT)
                    .await
                {
                    Ok(result) => Ok(result),
                    Err(HistorianProducerError::TimedOut) => {
                        producer
                            .redrain_output_with_timeout(&handle.run_id, CLASSIFY_RECOVERY_TIMEOUT)
                            .await
                    }
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            match attempt_output {
                Ok(result) if has_manifest_envelope(&result.text) => {
                    // The module checks only for the task-specific envelope. Even if the
                    // output limit truncated a result, this layer accepts it when the
                    // envelope remains; the host parser rejects malformed contents.
                    record_attempt("manifest", String::new());
                    output = Some((model.clone(), result, child_session.clone()));
                    // The result is consumed: release the child (on a runner declaring
                    // `session_retention`), then close routes; without a release, cleanup
                    // reports unsupported runner deletion. The classify result is
                    // independent of snapshot retention.
                    producer.release_child("dream", &ledger_session).await;
                    let _ = producer.purge_session(&child_session).await;
                    break;
                }
                Ok(_) => record_attempt(
                    "no_manifest",
                    "classify producer returned no classify manifest envelope".to_string(),
                ),
                Err(error) => record_attempt("failed", error.to_string()),
            }
            // This attempt is over and its child is never read again.
            producer.release_child("dream", &ledger_session).await;
            let _ = producer.purge_session(&child_session).await;
        }
        if output.is_none() {
            let failure = if attempt_errors.is_empty() {
                "classify producer has no usable model".to_string()
            } else {
                attempt_errors.join("; ")
            };
            let response = json!({
                "ok": false,
                "code": "dreamer_run_failed",
                "message": failure,
            });
            let _ = store.record_dream_task_command(
                &ledger_session,
                command_id,
                &response.to_string(),
                now_ms(),
            );
            return HandlerOutcome::Error {
                code: "dreamer_run_failed".to_string(),
                message: failure,
            };
        }
        let (model, result, child_session) = output.expect("classifier output set");
        let tokens = historian_producer::producer_token_log(
            result.usage,
            Some(CLASSIFY_MAX_OUTPUT_TOKENS),
            result.length_capped,
        );
        tracing::info!(
            response_chars = result.text.chars().count(),
            tokens = %tokens,
            "dreamer classify response received"
        );
        if result.length_capped {
            tracing::warn!(tokens = %tokens, "dreamer classify output hit the length cap");
        }
        let mut response = json!({
            "ok": true,
            "manifest_text": result.text,
            "truncated": result.length_capped,
            "diagnostics": {
                "task": CLASSIFY_TASK,
                "model": model,
                "attempts": attempts,
                "child_session_id": child_session,
                "temperature": CLASSIFY_TEMPERATURE,
                "max_output_tokens": CLASSIFY_MAX_OUTPUT_TOKENS,
                "await_timeout_ms": CLASSIFY_AWAIT_TIMEOUT.as_millis(),
                "recovery_timeout_ms": CLASSIFY_RECOVERY_TIMEOUT.as_millis(),
            }
        });
        if runner == "host" {
            response["diagnostics"]["runner"] = json!("host");
        }
        // The runner's token spend for the successful attempt, so the host can record
        // it on its invocation row. Omitted when the runner reported none; hosts that
        // predate the field ignore it.
        if let Some(usage) = result.usage {
            response["usage"] = json!({
                "input": usage.input,
                "output": usage.output,
                "cache_read": usage.cache_read,
                "cache_write": usage.cache_write,
            });
        }
        match store.record_dream_task_command(
            &ledger_session,
            command_id,
            &response.to_string(),
            now_ms(),
        ) {
            Ok(recorded) => replay_dream_task_response(&recorded.response_json),
            Err(error) => HandlerOutcome::Error {
                code: "dreamer_ledger_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    async fn handle_memory_set_classification(
        &self,
        channel: u16,
        request: &Value,
    ) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["rows"]) else {
            return invalid_params_error("memory.set_classification requires arguments");
        };
        let Some(memory_project) = non_empty_string_arg(&args, "memory_project") else {
            return invalid_params_error("memory.set_classification requires memory_project");
        };
        if let Err(outcome) = self.bind_facade_route_for_write(channel, &args, "memories") {
            return outcome;
        }
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let route_root = binding.project_root.to_string_lossy().to_string();
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let route_project = match self.route_project_identity(channel, store, &binding) {
            Ok(project) => project,
            Err(outcome) => return outcome,
        };
        if route_project != memory_project {
            return HandlerOutcome::Error {
                code: "facade_project_vocabulary_mismatch".to_string(),
                message: format!(
                    "classification route is owned by {route_project}, not {memory_project}"
                ),
            };
        }
        let Some(rows) = args.get("rows").and_then(Value::as_array) else {
            return invalid_params_error("memory.set_classification requires rows");
        };
        let mut updates = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(row) = row.as_object() else {
                return invalid_params_error("classification rows must be objects");
            };
            let Some(memory_id) = row.get("memory_id").and_then(Value::as_i64) else {
                return invalid_params_error("classification row requires memory_id");
            };
            let Some(hash) = row.get("content_hash_at_prompt").and_then(Value::as_str) else {
                return invalid_params_error("classification row requires content_hash_at_prompt");
            };
            updates.push(mc_store::ClassificationUpdate {
                memory_id,
                content_hash_at_prompt: hash.to_string(),
                importance: row
                    .get("importance")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32),
                scope: row
                    .get("scope")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                shareable: row.get("shareable").and_then(Value::as_bool),
            });
        }
        #[cfg(test)]
        if let Some(hook) = self
            .classification_before_apply_hook
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            hook();
        }
        match store.with_facade_mutation(&route_root, "memories", || {
            store.set_memory_classification(memory_project, &updates, now_ms())
        }) {
            Ok(result) => respond(json!({
                "accepted": result.accepted,
                "rejected": result.rejected.iter().map(|row| json!({ "memory_id": row.memory_id, "reason": row.reason })).collect::<Vec<_>>(),
            })),
            Err(error) => HandlerOutcome::Error {
                code: "classification_apply_failed".to_string(),
                message: error.to_string(),
            },
        }
    }

    async fn handle_memory_set_mural_cue(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["rows"]) else {
            return invalid_params_error("memory.set_mural_cue requires arguments");
        };
        let Some(memory_project) = non_empty_string_arg(&args, "memory_project") else {
            return invalid_params_error("memory.set_mural_cue requires memory_project");
        };
        if let Err(outcome) = self.bind_facade_route_for_write(channel, &args, "memories") {
            return outcome;
        }
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let route_root = binding.project_root.to_string_lossy().to_string();
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let command_id = args
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(command_id) = command_id {
            if let Some(replayed) =
                replayed_memory_apply_command(store, &binding.session, "set_mural_cue", command_id)
            {
                return replayed;
            }
        }
        let Some(rows) = args.get("rows").and_then(Value::as_array) else {
            return invalid_params_error("memory.set_mural_cue requires rows");
        };
        let mut updates = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(row) = row.as_object() else {
                return invalid_params_error("mural cue rows must be objects");
            };
            let Some(memory_id) = row.get("memory_id").and_then(Value::as_i64) else {
                return invalid_params_error("mural cue row requires memory_id");
            };
            let Some(hash) = row.get("content_hash_at_prompt").and_then(Value::as_str) else {
                return invalid_params_error("mural cue row requires content_hash_at_prompt");
            };
            let Some(rejection_count) = row.get("rejection_count").and_then(Value::as_i64) else {
                return invalid_params_error("mural cue row requires rejection_count");
            };
            let cue = match row.get("cue") {
                Some(Value::Null) | None => None,
                Some(Value::String(cue)) => Some(cue.to_string()),
                Some(_) => {
                    return invalid_params_error("mural cue row cue must be a string or null");
                }
            };
            updates.push(mc_store::MuralCueUpdate {
                memory_id,
                content_hash_at_prompt: hash.to_string(),
                cue,
                rejection_count,
            });
        }
        let now = now_ms();
        dream_apply_command_outcome(
            store.with_facade_command(
                &route_root,
                memory_project,
                "memories",
                &binding.session,
                "memory",
                "set_mural_cue",
                command_id,
                |tx| {
                    let result = tx.set_memory_mural_cue(memory_project, &updates, now)?;
                    serde_json::to_vec(&json!({
                        "ok": true,
                        "accepted": result.accepted,
                        "rejected": result.rejected.iter().map(|row| json!({
                            "memory_id": row.memory_id,
                            "reason": row.reason,
                        })).collect::<Vec<_>>(),
                    }))
                    .map_err(|error| error.to_string())
                },
            ),
            "mural_cue_apply_failed",
        )
    }

    /// The dreamer's expiry sweep for a module-owned project: an automated archive that the
    /// store rechecks against each row's declared expiry and writes with undo history and no
    /// mutation-log row (see `expire_memories_tx`). It is not the agent `ctx_memory` archive.
    async fn handle_memory_expire(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["ids"]) else {
            return invalid_params_error("memory.expire requires arguments");
        };
        let Some(memory_project) = non_empty_string_arg(&args, "memory_project") else {
            return invalid_params_error("memory.expire requires memory_project");
        };
        if let Err(outcome) = self.bind_facade_route_for_write(channel, &args, "memories") {
            return outcome;
        }
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let route_root = binding.project_root.to_string_lossy().to_string();
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let command_id = args
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(command_id) = command_id {
            if let Some(replayed) =
                replayed_memory_apply_command(store, &binding.session, "expire", command_id)
            {
                return replayed;
            }
        }
        let Some(ids) = args.get("ids").and_then(Value::as_array) else {
            return invalid_params_error("memory.expire requires ids");
        };
        let Some(ids) = ids.iter().map(Value::as_i64).collect::<Option<Vec<_>>>() else {
            return invalid_params_error("memory.expire ids must be integers");
        };
        let now = now_ms();
        dream_apply_command_outcome(
            store.with_facade_command(
                &route_root,
                memory_project,
                "memories",
                &binding.session,
                "memory",
                "expire",
                command_id,
                |tx| {
                    let result = tx.expire_memories(memory_project, &ids, now)?;
                    serde_json::to_vec(&json!({
                        "ok": true,
                        "accepted": result.accepted,
                        "rejected": result.rejected.iter().map(|row| json!({
                            "memory_id": row.memory_id,
                            "reason": row.reason,
                        })).collect::<Vec<_>>(),
                    }))
                    .map_err(|error| error.to_string())
                },
            ),
            "expiry_apply_failed",
        )
    }

    async fn handle_memory_set_verification(
        &self,
        channel: u16,
        request: &Value,
    ) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["rows"]) else {
            return invalid_params_error("memory.set_verification requires arguments");
        };
        let Some(memory_project) = non_empty_string_arg(&args, "memory_project") else {
            return invalid_params_error("memory.set_verification requires memory_project");
        };
        if let Err(outcome) = self.bind_facade_route_for_write(channel, &args, "memories") {
            return outcome;
        }
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let route_root = binding.project_root.to_string_lossy().to_string();
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let command_id = args
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let Some(rows) = args.get("rows").and_then(Value::as_array) else {
            return invalid_params_error("memory.set_verification requires rows");
        };
        let updates = match memory_verification::validate_rows(&Value::Array(rows.clone())) {
            Ok(updates) => updates,
            Err(error) => return invalid_params_error(&error),
        };
        match memory_verification::apply(
            store,
            memory_project,
            &route_root,
            &binding.session,
            command_id,
            &updates,
            now_ms(),
        ) {
            Ok(response) => HandlerOutcome::Response(response),
            Err(error) => HandlerOutcome::Error {
                code: "verification_apply_failed".into(),
                message: error,
            },
        }
    }

    async fn handle_memory_set_mapping(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["rows"]) else {
            return invalid_params_error("memory.set_mapping requires arguments");
        };
        let Some(memory_project) = non_empty_string_arg(&args, "memory_project") else {
            return invalid_params_error("memory.set_mapping requires memory_project");
        };
        if let Err(outcome) = self.bind_facade_route_for_write(channel, &args, "memories") {
            return outcome;
        }
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let route_root = binding.project_root.to_string_lossy().to_string();
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let command_id = args
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(command_id) = command_id {
            if let Some(replayed) =
                replayed_memory_apply_command(store, &binding.session, "set_mapping", command_id)
            {
                return replayed;
            }
        }
        let Some(rows) = args.get("rows").and_then(Value::as_array) else {
            return invalid_params_error("memory.set_mapping requires rows");
        };
        let mut updates = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(row) = row.as_object() else {
                return invalid_params_error("mapping rows must be objects");
            };
            let Some(memory_id) = row.get("memory_id").and_then(Value::as_i64) else {
                return invalid_params_error("mapping row requires memory_id");
            };
            let Some(hash) = row.get("content_hash_at_prompt").and_then(Value::as_str) else {
                return invalid_params_error("mapping row requires content_hash_at_prompt");
            };
            let mapped_files = match row.get("mapped_files") {
                Some(Value::Null) | None => None,
                Some(Value::Array(files)) => Some(
                    files
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                ),
                _ => return invalid_params_error("mapped_files must be an array or null"),
            };
            let mapping_origin = match row.get("mapping_origin") {
                None => "mapper".to_string(),
                Some(Value::String(origin))
                    if matches!(origin.as_str(), "mapper" | "host_rejected_fallback") =>
                {
                    origin.to_string()
                }
                _ => {
                    return invalid_params_error(
                        "mapping_origin must be mapper or host_rejected_fallback",
                    )
                }
            };
            updates.push(MappingUpdate {
                memory_id,
                content_hash_at_prompt: hash.to_string(),
                mapped_files,
                mapping_origin,
            });
        }
        let now = now_ms();
        dream_apply_command_outcome(
            store.with_facade_command(
                &route_root,
                memory_project,
                "memories",
                &binding.session,
                "memory",
                "set_mapping",
                command_id,
                |tx| {
                    let result = tx.set_memory_mapping(memory_project, &updates, now)?;
                    serde_json::to_vec(&json!({
                        "ok": true,
                        "accepted": result.accepted,
                        "rejected": result.rejected.iter().map(|row| json!({
                            "memory_id": row.memory_id,
                            "reason": row.reason,
                        })).collect::<Vec<_>>(),
                    }))
                    .map_err(|error| error.to_string())
                },
            ),
            "mapping_apply_failed",
        )
    }

    async fn handle_facade_value(&self, channel: u16, request: Value) -> HandlerOutcome {
        let Some(name) = request.get("name").and_then(Value::as_str) else {
            return unrecognized_request_error(&request);
        };
        if matches!(
            name,
            "user_command.invoke" | "late_results" | "late_results.ack"
        ) {
            return self.handle_user_command_op(channel, name, &request).await;
        }
        if let Err(outcome) = self.check_catalog_call(channel, name, &request) {
            return outcome;
        }
        match name {
            "memory.set_classification" => {
                self.handle_memory_set_classification(channel, &request)
                    .await
            }
            "memory.set_mural_cue" => self.handle_memory_set_mural_cue(channel, &request).await,
            "memory.expire" => self.handle_memory_expire(channel, &request).await,
            "memory.set_verification" => {
                self.handle_memory_set_verification(channel, &request).await
            }
            "memory.set_mapping" => self.handle_memory_set_mapping(channel, &request).await,
            "ctx_memory" => {
                self.handle_ctx_memory_facade(channel, &request, false)
                    .await
            }
            "memory.history" | "memory.restore.preview" | "memory.restore" | "memory.edit" => {
                self.handle_memory_history_facade(channel, name, &request)
                    .await
            }
            "memory.curate" => self.handle_memory_curate_facade(channel, &request).await,
            "ctx_search" => self.handle_ctx_search_facade(channel, &request).await,
            "ctx_expand" => self.handle_ctx_expand_facade(channel, &request).await,
            "ctx_reduce" => self.handle_ctx_reduce_facade(channel, &request).await,
            "ctx_note" => self.handle_ctx_note_facade(channel, &request).await,
            // The tool-provider/v1 role ops. They answer on every route, so a caller
            // reaches them by name on Magic Context's tool route whether or not it
            // declared the role at bind.
            cortexkit_role_tool_provider::ops::TOOL_CATALOG => {
                self.handle_tool_catalog_value(channel, &request).await
            }
            cortexkit_role_tool_provider::ops::ROLE_DESCRIBE => providers::describe(),
            // A consumer that declared tool-provider/v1 gets the role's refusal for a
            // name Magic Context does not serve; every other route keeps the legacy
            // error code it has always had.
            _ if self.speaks_tool_provider_v1(channel) => {
                let body = cortexkit_role_tool_provider::errors::unknown_tool(name);
                HandlerOutcome::ErrorWithDetail {
                    code: body.code,
                    message: body.message,
                    detail: body.detail.unwrap_or(Value::Null),
                }
            }
            _ => unrecognized_request_error(&request),
        }
    }

    /// `tool.catalog`: the catalog and guidance text for the request's plan item,
    /// resolved against the configuration of the project the route is bound to.
    async fn handle_tool_catalog_value(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Ok(binding) = self.facade_binding(channel) else {
            return HandlerOutcome::Error {
                code: "route_unbound".to_string(),
                message: "tool.catalog on a channel with no route binding".to_string(),
            };
        };
        let config = tool_catalog::CatalogConfig::from_module_config(&binding.config);
        let arguments = request.get("arguments").unwrap_or(&Value::Null);
        match tool_catalog::catalog_answer_bytes(arguments, &config) {
            Ok(bytes) => {
                if arguments.get("composition").is_some_and(Value::is_object)
                    && arguments.get("digest_only") != Some(&Value::Bool(true))
                {
                    // These bytes were just produced by the catalog, not supplied
                    // by a caller. Retain only the facts needed to admit calls.
                    let answer: Value = serde_json::from_slice(&bytes).expect("catalog JSON");
                    let tools = answer["tools"]
                        .as_array()
                        .expect("catalog tools")
                        .iter()
                        .map(|tool| {
                            tool["name"]
                                .as_str()
                                .expect("catalog tool name")
                                .to_string()
                        })
                        .collect::<std::collections::BTreeSet<String>>();
                    let catalog = providers::Catalog {
                        compacting: tool_catalog::compacts_session(arguments)
                            .expect("validated composition"),
                        tools: tools.clone(),
                    };
                    // HELLO_ACK starts the coordinator's open asynchronously. A
                    // bound plan-fetch route can get here before it completes,
                    // without any transform ever having run. Wait through that
                    // existing startup path, but keep discovery storage-independent.
                    let persisted = match self.store_for_request().await {
                        Ok(_) => self.provider_store.save_catalog(&binding, &catalog),
                        Err(refusal) => Err(refusal.into_outcome()),
                    };
                    match persisted {
                        Ok(()) => self.provider_store.clear_catalog_failure(&binding),
                        Err(error) => self.provider_store.record_catalog_failure(&binding, &error),
                    }
                    self.frozen_tool_catalogs
                        .lock()
                        .expect("frozen catalog mutex")
                        .insert(
                            (binding.project_root, binding.session),
                            tool_catalog::FrozenCatalog {
                                compacting: tool_catalog::compacts_session(arguments)
                                    .expect("validated composition"),
                                tools,
                            },
                        );
                }
                HandlerOutcome::Response(bytes)
            }
            Err(error) => error.into_outcome(),
        }
    }

    /// Apply role-catalog admission only when a call carries a preset or the
    /// session has fetched a frozen catalog. Legacy plugin and Claude Code MCP
    /// calls do neither; declaring the role's version alone cannot move them
    /// onto a different tool set or disable their transform-backed reduction.
    fn check_catalog_call(
        &self,
        channel: u16,
        name: &str,
        request: &Value,
    ) -> Result<(), HandlerOutcome> {
        if !name.starts_with("ctx_") {
            return Ok(());
        }
        let preset = match request.get("preset") {
            Some(Value::String(name)) => {
                Some(tool_catalog::Preset::parse(name).ok_or_else(|| {
                    tool_catalog::CatalogError::unserved_preset(name).into_outcome()
                })?)
            }
            Some(_) => {
                return Err(tool_catalog::CatalogError::Invalid {
                    field: "preset".to_string(),
                    message: "preset must be a string".to_string(),
                }
                .into_outcome())
            }
            None => None,
        };
        let frozen = self.facade_binding(channel).ok().and_then(|binding| {
            self.frozen_tool_catalogs
                .lock()
                .expect("frozen catalog mutex")
                .get(&(binding.project_root, binding.session))
                .cloned()
        });
        let frozen = match self.facade_binding(channel) {
            Ok(binding) if binding.harness == session_resolver::RUNNER_BIND_HARNESS => self
                .provider_store
                .catalog(&binding)?
                .map(|catalog| tool_catalog::FrozenCatalog {
                    compacting: catalog.compacting,
                    tools: catalog.tools,
                })
                .or(frozen),
            _ => frozen,
        };
        if preset.is_none() && frozen.is_none() {
            return Ok(());
        }
        let compacting = frozen.as_ref().is_some_and(|catalog| catalog.compacting);
        let served = preset
            .unwrap_or(tool_catalog::Preset::Head)
            .serves(name, compacting)
            && frozen
                .as_ref()
                .is_none_or(|catalog| catalog.tools.contains(name));
        if !served {
            let body = cortexkit_role_tool_provider::errors::unknown_tool(name);
            return Err(HandlerOutcome::ErrorWithDetail {
                code: body.code,
                message: body.message,
                detail: body.detail.unwrap_or(Value::Null),
            });
        }
        Ok(())
    }

    /// Remember whether the route's consumer declared it speaks `tool-provider/v1`.
    fn record_route_role_versions(
        &self,
        channel: u16,
        role_versions: Option<&BTreeMap<String, String>>,
    ) {
        let speaks_v1 = role_versions
            .and_then(|versions| versions.get(cortexkit_role_tool_provider::ROLE))
            .is_some_and(|version| version == cortexkit_role_tool_provider::VERSION);
        let mut channels = self
            .tool_provider_v1_channels
            .lock()
            .expect("tool-provider channels mutex");
        if speaks_v1 {
            channels.insert(channel);
        } else {
            channels.remove(&channel);
        }
    }

    fn speaks_tool_provider_v1(&self, channel: u16) -> bool {
        self.tool_provider_v1_channels
            .lock()
            .expect("tool-provider channels mutex")
            .contains(&channel)
    }

    fn log_missing_facade_command_id(&self, session_id: &str, tool: &str, action: &str) {
        let mut sessions = self
            .missing_facade_command_id_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.insert(session_id.to_string()) {
            tracing::debug!(
                "mc-module: {tool} {action} facade mutation omitted command_id for session {session_id}; accepting for transport compatibility"
            );
        }
    }

    /// Refuse a write whose `memory_project` names a project other than the route's own
    /// identity. A write that names none writes under the route's identity.
    fn bind_facade_route_for_write(
        &self,
        channel: u16,
        arguments: &Map<String, Value>,
        domain: &str,
    ) -> Result<(), HandlerOutcome> {
        let Some(requested_project) = non_empty_string_arg(arguments, "memory_project") else {
            return Ok(());
        };
        let binding = self
            .facade_binding(channel)
            .map_err(|_| session_unresolved_error())?;
        let Some(store) = self.store.get() else {
            return Err(self.facade_store_refusal());
        };
        let identity = self.route_project_identity(channel, store, &binding)?;
        if identity != requested_project {
            tracing::warn!(
                "mc-module: {domain} write for {requested_project} on a route whose project is {identity}"
            );
            return Err(HandlerOutcome::Error {
                code: "facade_project_vocabulary_mismatch".to_string(),
                message: capability_refusal_message(domain).to_string(),
            });
        }
        Ok(())
    }

    async fn resolve_facade_scope(
        &self,
        channel: u16,
        arguments: Option<&Map<String, Value>>,
        authority_domain: &str,
        _bind_for_write: bool,
        allow_async_resync: bool,
    ) -> Result<FacadeScope, HandlerOutcome> {
        let binding = self
            .facade_binding(channel)
            .map_err(|_| session_unresolved_error())?;
        let bound_session = binding.session.trim();
        if bound_session.is_empty() {
            return Err(session_unresolved_error());
        }

        let route_project_root = binding.project_root.to_string_lossy().to_string();
        let requested_project =
            arguments.and_then(|arguments| non_empty_string_arg(arguments, "memory_project"));
        // Both OpenCode entry points use server-observed transform state as the session proof.
        // Wrapper labels and authority routes alone are insufficient: either could otherwise
        // rebind a known project to a second root without a host session lookup.
        let opencode_harness =
            binding.harness == OPENCODE_HARNESS || binding.harness == "opencode2";
        let transform_session_known =
            self.module_knows_transform_session(bound_session, &binding.project_root);
        // The bind's (project_root, session) names an asynchronous compaction
        // conversation whatever harness the bind declares: an MCP facade binds
        // a runner's conversation by its session alone. More than one match
        // refuses rather than guessing; none keeps the harness's own path.
        let async_key = if binding.harness == session_resolver::RUNNER_BIND_HARNESS
            || self.store.get().is_some()
        {
            self.async_compaction_namespace(&binding, allow_async_resync)?
        } else {
            None
        };
        let async_conversation = async_key.is_some();
        let conversation_key = if let Some(key) = async_key {
            key
        } else if binding.harness == session_resolver::RUNNER_BIND_HARNESS {
            return Err(session_unresolved_error());
        } else if opencode_harness && transform_session_known {
            bound_session.to_string()
        } else {
            match self
                .session_resolver
                .resolve_session(&binding.project_root, &binding.harness, bound_session)
                .await
            {
                Ok(Some(resolved)) => resolved.session_id,
                Ok(None) => return Err(session_unresolved_error()),
                Err(SessionResolveError::Timeout) => {
                    return Err(HandlerOutcome::Error {
                        code: "session_resolve_timeout".to_string(),
                        message: "session.resolve timed out after 2s".to_string(),
                    });
                }
                Err(error) => {
                    return Err(HandlerOutcome::Error {
                        code: "session_resolve_failed".to_string(),
                        message: error.to_string(),
                    });
                }
            }
        };

        // The project is resolved only once the session is proven, so an unproven caller is
        // told that before anything about projects or the store.
        // History tools (ctx_reduce, ctx_expand) keep working while the route's identity is
        // unavailable; memory tools read `memory_paused` and refuse by name.
        let route = match self.store.get() {
            Some(store) => self.route_project(channel, store, &binding)?,
            None => return Err(self.facade_store_refusal()),
        };
        let memory_paused = route.memory_paused;
        let memory_project_path = route.key;
        if requested_project.is_some_and(|requested| requested != memory_project_path) {
            tracing::warn!(
                "mc-module: {authority_domain} route {route_project_root} project mismatch: expected {memory_project_path}, received {}",
                requested_project.unwrap_or_default()
            );
            return Err(HandlerOutcome::Error {
                code: "facade_project_vocabulary_mismatch".to_string(),
                message: capability_refusal_message(authority_domain).to_string(),
            });
        }

        Ok(FacadeScope {
            memory_project_path,
            route_project_root,
            conversation_key,
            async_conversation,
            memory_enabled: binding.config.memory_enabled && memory_paused.is_none(),
            memory_paused,
        })
    }

    async fn handle_ctx_reduce_facade(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["drop"]) else {
            return invalid_params_error("ctx_reduce arguments must be an object");
        };
        let Some(raw_drop) = non_empty_string_arg(&args, "drop") else {
            return tool_error_result(
                r#"Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}."#.to_string(),
            );
        };
        let requested = match parse_tag_range_string(raw_drop) {
            Ok(requested) => requested,
            // The parser is the delivery-side canonicalizer. Surface its exact rejection so
            // acknowledgement and asynchronous delivery cannot disagree about range syntax.
            Err(error) => {
                return tool_error_result(format!("Error: Invalid range syntax. {error}"));
            }
        };
        let facade_scope = match self
            // Reduction reports unchecked tags as retryable during resync;
            // other facade tools still refuse until the transcript is ready.
            .resolve_facade_scope(channel, Some(&args), "memories", false, true)
            .await
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        if facade_scope.async_conversation {
            return self.handle_provider_reduce(channel, &requested).await;
        }
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        let session_id = facade_scope.conversation_key.as_str();
        let tags = match store.load_tags_for_session(session_id) {
            Ok(tags) => tags,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        let pending = match store.load_pending_agent_drops(session_id) {
            Ok(pending) => pending,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        let by_number = tags
            .iter()
            .map(|tag| (tag.tag_number as u64, tag))
            .collect::<HashMap<_, _>>();
        let pending_ids = pending
            .iter()
            .map(|drop| drop.target_id.as_str())
            .collect::<HashSet<_>>();
        let unknown = requested
            .iter()
            .copied()
            .filter(|number| !by_number.contains_key(number))
            .collect::<Vec<_>>();
        let already_queued = requested
            .iter()
            .copied()
            .filter(|number| {
                by_number
                    .get(number)
                    .is_some_and(|tag| pending_ids.contains(tag.block_id.as_str()))
            })
            .collect::<Vec<_>>();
        let queueable = requested
            .iter()
            .copied()
            .filter(|number| {
                by_number
                    .get(number)
                    .is_some_and(|tag| !pending_ids.contains(tag.block_id.as_str()))
            })
            .collect::<Vec<_>>();
        if queueable.is_empty() {
            if unknown.is_empty() && !already_queued.is_empty() {
                return mcp_text_result(ctx_reduce_reply(already_queued.len(), 0), false);
            }
            let reason = ctx_reduce_ack_details(&unknown);
            return tool_error_result(format!(
                "Refused: no valid tags to queue. {}",
                if reason.is_empty() {
                    "No requested tags are available for delivery.".to_string()
                } else {
                    reason
                }
            ));
        }

        let stamped_count = queueable.len() + already_queued.len();
        let validation_detail = ctx_reduce_ack_details(&unknown);
        // This acknowledgement validates the durable tag state but deliberately does not
        // mutate it. The response observer owns asynchronous delivery on this facade.
        let mut reply = ctx_reduce_reply(stamped_count, 0);
        if !validation_detail.is_empty() {
            if !reply.is_empty() {
                reply.push(' ');
            }
            reply.push_str(&validation_detail);
            reply.push('.');
        }
        mcp_text_result(reply, false)
    }

    async fn handle_memory_history_facade(
        &self,
        channel: u16,
        method: &str,
        request: &Value,
    ) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["projectPath"]) else {
            return invalid_params_error("memory request must be an object");
        };
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        // External editors have no served session. The authenticated connection fixes
        // their project directory and identity; the write transaction checks again
        // whether this process may still change that project's memories.
        let route = match self.route_project(channel, &store, &binding) {
            Ok(route) => route,
            Err(outcome) => return outcome,
        };
        let params = Value::Object(args.clone());
        let writing = matches!(method, "memory.edit" | "memory.restore");
        if writing && mc_store::memory_history::validate_write_request(method, &params).is_err() {
            return invalid_params_error("invalid_request");
        }
        if args.get("projectPath").and_then(Value::as_str) != Some(route.key.as_str())
            || route.memory_paused.is_some()
            || !binding.config.memory_enabled
        {
            return if writing {
                respond(
                    json!({ "structuredContent":mc_store::memory_history::refused_write(&params,"authority_unavailable"), "isError":false }),
                )
            } else {
                tool_error_result("Memory authority is unavailable for this project.")
            };
        }
        match store.memory_history_rpc(method, &params, now_ms()) {
            Ok(payload) => respond(json!({ "structuredContent": payload, "isError": false })),
            Err(error) => tool_error_result(error.to_string()),
        }
    }

    async fn handle_memory_curate_facade(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let outcome = self.handle_ctx_memory_facade(channel, request, true).await;
        let HandlerOutcome::Response(bytes) = &outcome else {
            return outcome;
        };
        let Ok(Value::Object(mut body)) = serde_json::from_slice::<Value>(bytes) else {
            return outcome;
        };
        if body.contains_key("structuredContent") {
            return outcome;
        }
        // Existing scope and transaction refusals keep their human explanation, but
        // must also report failure through the machine-readable curation contract.
        let code = if body.get("isError") == Some(&Value::Bool(true)) {
            "mutation_refused"
        } else {
            "invalid_receipt"
        };
        body.insert("isError".into(), Value::Bool(true));
        body.insert(
            "structuredContent".into(),
            serde_json::to_value(MemoryCurateResult::refused(code))
                .expect("curate receipt is serializable"),
        );
        respond(Value::Object(body))
    }

    async fn handle_ctx_memory_facade(
        &self,
        channel: u16,
        request: &Value,
        automated: bool,
    ) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["action"]) else {
            return invalid_params_error("ctx_memory arguments must be an object");
        };
        let args = &args;
        let Some(action) = string_arg(args, "action") else {
            return invalid_params_error("ctx_memory requires an action");
        };
        if let Err(error) = validate_memory_id_arguments(args, action)
            .and_then(|_| validate_string_cap(args, "content", MAX_MEMORY_CONTENT_BYTES))
            .and_then(|_| validate_string_cap(args, "reason", MAX_SHORT_FIELD_BYTES))
        {
            return tool_error_result(format!("Error: {error}."));
        }
        let is_mutation = matches!(action, "write" | "update" | "archive" | "merge");
        if automated && !matches!(action, "update" | "archive" | "merge") {
            return invalid_params_error("memory.curate requires update, archive or merge");
        }
        let expected_revisions: Vec<(i64, i64)> = if automated {
            let Some(targets) = args.get("expected_revisions").and_then(Value::as_array) else {
                return invalid_params_error("memory.curate requires expected_revisions");
            };
            let Some(targets) = targets
                .iter()
                .map(|target| {
                    Some((
                        target.get("id")?.as_i64()?,
                        target.get("revision")?.as_i64()?,
                    ))
                })
                .collect::<Option<Vec<_>>>()
            else {
                return invalid_params_error("invalid expected_revisions");
            };
            if targets.iter().map(|(id, _)| *id).collect::<Vec<_>>() != memory_ids(args, action) {
                return invalid_params_error("expected_revisions must name every target");
            }
            targets
        } else {
            Vec::new()
        };
        let facade_scope = match self
            .resolve_facade_scope(channel, Some(args), "memories", is_mutation, false)
            .await
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        if let Some(reason) = &facade_scope.memory_paused {
            return tool_error_result(format!(
                "Error: memory is paused for this project (git_identity_unavailable): {reason}"
            ));
        }
        if !facade_scope.memory_enabled {
            return tool_error_result("Error: memory is disabled for this project.".to_string());
        }
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        let memory_project = facade_scope.memory_project_path.as_str();
        let conversation_key = facade_scope.conversation_key.as_str();
        // Every memory id the module renders and accepts is a context.db id. A host that
        // still sends the retired host-id lane is refused rather than silently misread.
        if let Err(error) = refuse_retired_memory_id_lane(args) {
            return invalid_params_error(error);
        }
        let request_context = MemoryFacadeRequestContext;
        let command_id = if is_mutation {
            match command_id_from_facade_request(request, args) {
                Ok(command_id) => command_id,
                Err(error) => return tool_error_result(format!("Error: {error}.")),
            }
        } else {
            None
        };
        if is_mutation && command_id.is_none() {
            self.log_missing_facade_command_id(conversation_key, "ctx_memory", action);
        }
        let shown_projection = store.load(conversation_key).ok().and_then(|loaded| {
            let projection = loaded.meta.memory_projection?;
            let m0 = loaded
                .core
                .frozen_units
                .iter()
                .find(|unit| unit.key == "m0")?;
            projection
                .matches_m0(&m0.frozen_payload)
                .then_some(projection)
        });
        let fragment_key = command_id.clone().unwrap_or_else(|| {
            mc_store::memory_lifecycle::applier::fresh_decision_key("ctx-memory-fragment", now_ms())
        });

        match action {
            "write" => {
                let Some(category) = non_empty_string_arg(args, "category") else {
                    return tool_error_result(
                        "Error: 'category' is required when action is 'write'.",
                    );
                };
                if !MEMORY_CATEGORIES.contains(&category) {
                    return tool_error_result(format!(
                        "Error: category must be one of {}.",
                        MEMORY_CATEGORIES.join(", ")
                    ));
                }
                let Some(content) = non_empty_string_arg(args, "content") else {
                    return tool_error_result(
                        "Error: 'content' is required when action is 'write'.",
                    );
                };
                facade_command_outcome(store.with_facade_command(
                    facade_scope.route_project_root.as_str(),
                    memory_project,
                    "memories",
                    conversation_key,
                    if automated {
                        "memory.curate"
                    } else {
                        "ctx_memory"
                    },
                    action,
                    command_id.as_deref(),
                    |tx| {
                        // A save is the applier's `agent_save`. A retried command reuses its
                        // decision key, so it replays the recorded receipt instead of
                        // counting the memory as seen twice.
                        let saved_at = now_ms();
                        let key = match command_id.as_deref() {
                            Some(command_id) => {
                                format!("ctx_memory:write:{conversation_key}:{command_id}")
                            }
                            None => mc_store::memory_lifecycle::applier::fresh_decision_key(
                                "ctx_memory:write",
                                saved_at,
                            ),
                        };
                        let mut admission = AdmissionRequest::new(
                            &key,
                            AdmissionOperation::AgentSave,
                            memory_project,
                            category,
                            content,
                            saved_at,
                        );
                        admission.importance = Some(50);
                        admission.source_session_id = Some(conversation_key);
                        let receipt = tx.admit_memory(&admission).map_err(|error| {
                            request_context
                                .render_mutation_error(FacadeMemoryMutationError::Storage(error))
                        })?;
                        let Some(id) = receipt.applied_memory_id() else {
                            // Nothing was written; the receipt records why, as the host's
                            // own save reports it.
                            return mcp_memory_result(
                                format!("{}: memory was not saved.", receipt.reason),
                                false,
                                json!({
                                    "action": "write",
                                    "saved": false,
                                    "reason": receipt.reason,
                                    "category": category,
                                }),
                            );
                        };
                        let saved = tx.memory_for_fragment(id)?;
                        if !shown_projection
                            .as_ref()
                            .is_some_and(|shown| shown.shows_text(id, &saved.content))
                        {
                            tx.record_agent_fragment(
                                conversation_key,
                                memory_project,
                                &fragment_key,
                                &[id],
                                Some(id),
                                &[mc_store::memory_projection::text_line(
                                    "added",
                                    id,
                                    &saved.category,
                                    &saved.content,
                                )],
                                &[mc_store::memory_projection::VisibleText {
                                    id,
                                    text: saved.content,
                                }],
                                saved_at,
                            )?;
                        }
                        let text = format!("Saved memory [ID: {id}] in {category}.");
                        mcp_memory_result(
                            text,
                            false,
                            json!({ "action": "write", "module_id": id, "category": category }),
                        )
                    },
                ))
            }
            "update" => {
                let category = match memory_tool::validate_update_category(non_empty_string_arg(
                    args, "category",
                )) {
                    Ok(category) => category,
                    Err(error) => return tool_error_result(format!("Error: {error}.")),
                };
                let Some(id) = single_memory_id(args, "update") else {
                    return tool_error_result(
                        "Error: provide exactly one memory id when action is 'update'.",
                    );
                };
                let Some(content) = non_empty_string_arg(args, "content") else {
                    return tool_error_result(
                        "Error: 'content' is required when action is 'update'.",
                    );
                };
                facade_command_outcome(store.with_facade_command(
                    facade_scope.route_project_root.as_str(),
                    memory_project,
                    "memories",
                    conversation_key,
                    if automated {
                        "memory.curate"
                    } else {
                        "ctx_memory"
                    },
                    action,
                    command_id.as_deref(),
                    |agent_tx| {
                        let automated_tx = agent_tx.automated();
                        let tx = if automated { &automated_tx } else { agent_tx };
                        if automated {
                            tx.check_memory_revisions(&expected_revisions)?;
                        }
                        let memory = tx
                            .update_memory_content(memory_project, id, content, category, now_ms())
                            .map_err(|error| request_context.render_mutation_error(error))?;
                        let rendered_id = memory.id;
                        tx.record_agent_fragment(
                            conversation_key,
                            memory_project,
                            &fragment_key,
                            &[memory.id],
                            Some(memory.id),
                            &[mc_store::memory_projection::text_line(
                                "updated",
                                memory.id,
                                &memory.category,
                                &memory.content,
                            )],
                            &[mc_store::memory_projection::VisibleText {
                                id: memory.id,
                                text: memory.content.clone(),
                            }],
                            now_ms(),
                        )?;
                        let text =
                            format!("Updated memory [ID: {rendered_id}] in {}.", memory.category);
                        if automated {
                            mcp_curate_result(
                                text,
                                MemoryCurateResult::applied(rendered_id, vec![]),
                            )
                        } else {
                            facade_text_response(text, false)
                        }
                    },
                ))
            }
            "archive" => {
                let ids = memory_ids(args, "archive");
                if ids.is_empty() {
                    return tool_error_result(
                        "Error: provide at least one memory id when action is 'archive'.",
                    );
                }
                let reason = non_empty_string_arg(args, "reason");
                facade_command_outcome(store.with_facade_command(
                    facade_scope.route_project_root.as_str(),
                    memory_project,
                    "memories",
                    conversation_key,
                    if automated {
                        "memory.curate"
                    } else {
                        "ctx_memory"
                    },
                    action,
                    command_id.as_deref(),
                    |agent_tx| {
                        let automated_tx = agent_tx.automated();
                        let tx = if automated { &automated_tx } else { agent_tx };
                        if automated {
                            tx.check_memory_revisions(&expected_revisions)?;
                        }
                        let archived = tx
                            .archive_memories(memory_project, &ids, reason, now_ms())
                            .map_err(|error| request_context.render_mutation_error(error))?;
                        if automated {
                            if let Some(successor_id) =
                                args.get("superseded_by").and_then(Value::as_i64)
                            {
                                tx.set_curate_successor(&archived, successor_id)?;
                            }
                        }
                        if archived.is_empty() {
                            let text = "No active memories needed archiving.".to_string();
                            if automated {
                                mcp_curate_result(text, MemoryCurateResult::refused("not_active"))
                            } else {
                                facade_text_response(text, false)
                            }
                        } else {
                            tx.record_agent_fragment(
                                conversation_key,
                                memory_project,
                                &fragment_key,
                                &archived,
                                None,
                                &archived
                                    .iter()
                                    .map(|id| format!("  <removed id=\"{id}\"/>"))
                                    .collect::<Vec<_>>(),
                                &[],
                                now_ms(),
                            )?;
                            let rendered_ids = archived;
                            let text =
                                format!("Archived memory IDs [{}].", join_i64s(&rendered_ids));
                            if automated {
                                mcp_curate_result(
                                    text,
                                    MemoryCurateResult::applied(rendered_ids[0], vec![]),
                                )
                            } else {
                                facade_text_response(text, false)
                            }
                        }
                    },
                ))
            }
            "merge" => {
                let category = match memory_tool::validate_update_category(non_empty_string_arg(
                    args, "category",
                )) {
                    Ok(category) => category,
                    Err(error) => return tool_error_result(format!("Error: {error}.")),
                };
                let Some(ids) = merge_ids(args) else {
                    return tool_error_result(
                        "Error: provide target_id plus source_ids, or at least two ids when action is 'merge'.",
                    );
                };
                let Some(content) = non_empty_string_arg(args, "content") else {
                    return tool_error_result(
                        "Error: 'content' is required when action is 'merge'.",
                    );
                };
                facade_command_outcome(
                    store.with_facade_command(
                        facade_scope.route_project_root.as_str(),
                        memory_project,
                        "memories",
                        conversation_key,
                        if automated { "memory.curate" } else { "ctx_memory" },
                        action,
                        command_id.as_deref(),
                        |agent_tx| {
                            let automated_tx = agent_tx.automated();
                            let tx = if automated { &automated_tx } else { agent_tx };
                            if automated { tx.check_memory_revisions(&expected_revisions)?; }
                            let (mut memory, superseded_ids) = tx
                                .merge_memories_canonical(
                                    memory_project,
                                    &ids,
                                    content,
                                    Some(conversation_key),
                                    now_ms(),
                                )
                                .map_err(|error| request_context.render_mutation_error(error))?;
                            if category.is_some_and(|category| category != memory.category) {
                                memory = tx
                                    .update_memory_content(
                                        memory_project,
                                        memory.id,
                                        content,
                                        category,
                                        now_ms(),
                                    )
                                    .map_err(|error| request_context.render_mutation_error(error))?;
                            }
                            let rendered_inputs = ids.clone();
                            let mut lines = superseded_ids.iter().map(|id| format!("  <superseded id=\"{id}\" by=\"{}\"/>",memory.id)).collect::<Vec<_>>();
                            let shown = shown_projection.as_ref().is_some_and(|shown| shown.shows_text(memory.id,&memory.content));
                            let visible = if shown { Vec::new() } else {
                                lines.push(mc_store::memory_projection::text_line(if ids.contains(&memory.id) { "updated" } else { "added" },memory.id,&memory.category,&memory.content));
                                vec![mc_store::memory_projection::VisibleText { id:memory.id,text:memory.content.clone() }]
                            };
                            let mut fragment_ids = superseded_ids.clone(); fragment_ids.push(memory.id);
                            tx.record_agent_fragment(conversation_key,memory_project,&fragment_key,&fragment_ids,Some(memory.id),&lines,&visible,now_ms())?;
                            let rendered_superseded = superseded_ids.clone();
                            let text = {
                                format!(
                                    "Merged memories [{}] into canonical memory [ID: {}] in {}; superseded [{}].",
                                    join_i64s(&rendered_inputs),
                                    memory.id,
                                    memory.category,
                                    join_i64s(&rendered_superseded)
                                )
                            };
                            if automated { return mcp_curate_result(text, MemoryCurateResult::applied(memory.id, superseded_ids)); }
                            mcp_memory_result(
                                text,
                                false,
                                json!({
                                    "action": "merge",
                                    "canonical_module_id": memory.id,
                                    "superseded_module_ids": superseded_ids,
                                    "category": memory.category,
                                }),
                            )
                        },
                    ),
                )
            }
            "list" => {
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
                    .unwrap_or(20)
                    .clamp(1, 100) as usize;
                let category = non_empty_string_arg(args, "category");
                match store.load_active_memories(memory_project, now_ms()) {
                    Ok(memories) => {
                        let rows = memories
                            .into_iter()
                            .filter(|memory| category.is_none_or(|value| memory.category == value))
                            .take(limit)
                            .collect::<Vec<_>>();
                        if rows.is_empty() {
                            return mcp_text_result("No active memories found.".to_string(), false);
                        }
                        let body = rows
                            .iter()
                            .map(|memory| {
                                let prefix = format!("Memory [ID: {}]", memory.id);
                                format!(
                                    "{prefix} in {} (status: {}): {}",
                                    memory.category,
                                    memory.status,
                                    memory
                                        .content
                                        .split_whitespace()
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        // `get` returns rows of any status; claim "active" only when every row is.
                        let all_active = rows.iter().all(|memory| memory.status == "active");
                        mcp_text_result(
                            format!(
                                "Found {} {}{}:\n\n{body}",
                                rows.len(),
                                if all_active { "active " } else { "" },
                                if rows.len() == 1 {
                                    "memory"
                                } else {
                                    "memories"
                                }
                            ),
                            false,
                        )
                    }
                    Err(error) => tool_error_result(format!(
                        "Error: {}",
                        request_context.render_store_error(error)
                    )),
                }
            }
            "get" => {
                let ids = memory_ids(args, "get");
                match memory_tool::get_memories(&store, memory_project, &ids) {
                    Ok(memories) => {
                        let by_id = memories
                            .into_iter()
                            .map(|memory| (memory.id, memory))
                            .collect::<std::collections::HashMap<_, _>>();
                        let lines = ids
                            .iter()
                            .map(|id| {
                                let rendered_id = *id;
                                match by_id.get(id) {
                                    Some(memory) => format!(
                                        "Memory [ID: {rendered_id}] in {} (status: {}): {}",
                                        memory.category, memory.status, memory.content
                                    ),
                                    None => format!(
                                        "id {rendered_id}: not found or not visible from this project"
                                    ),
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        mcp_text_result(lines, false)
                    }
                    Err(error) => tool_error_result(format!(
                        "Error: {}",
                        request_context.render_tool_error(error)
                    )),
                }
            }
            _ => tool_error_result("Error: Unknown ctx_memory action.".to_string()),
        }
    }

    async fn handle_ctx_search_facade(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["query"]) else {
            return invalid_params_error("ctx_search arguments must be an object");
        };
        let args = &args;
        let Some(query) = non_empty_string_arg(args, "query") else {
            return tool_error_result("Error: 'query' is required for ctx_search.");
        };
        if let Err(error) = validate_string_cap(args, "query", MAX_QUERY_BYTES) {
            return tool_error_result(format!("Error: {error}."));
        }
        let limit = usize_arg(args, "limit")
            .filter(|value| *value > 0)
            .unwrap_or(10)
            .clamp(1, 25);
        let from_ms = match parse_search_date_bound(args, "from", false) {
            Ok(value) => value,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        let to_ms = match parse_search_date_bound(args, "to", true) {
            Ok(value) => value,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        if matches!((from_ms, to_ms), (Some(from), Some(to)) if from > to) {
            return tool_error_result(
                "Error: Invalid date range; 'from' must be on or before 'to'.".to_string(),
            );
        }
        let sources = facade_search_sources(args);
        let facade_scope = match self
            .resolve_facade_scope(channel, Some(args), "memories", false, false)
            .await
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        let memory_project = facade_scope.memory_project_path.as_str();
        let conversation_key = facade_scope.conversation_key.as_str();
        let include_memories = facade_scope.memory_enabled && sources.memory;
        let workspace_membership = match store.resolve_workspace_membership(memory_project) {
            Ok(membership) => membership,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        let visible_memory_ids = store
            .fully_visible_memory_ids(conversation_key)
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();

        if include_memories {
            if let Some(ids) = parse_search_memory_ids(query) {
                match memory_tool::resolve_memory_ids_for_search_with_diagnostics(
                    &store,
                    memory_project,
                    &ids,
                    limit.max(ids.len()),
                    &visible_memory_ids,
                    from_ms,
                    to_ms,
                ) {
                    Ok(outcome)
                        if outcome.results.is_some()
                            || !outcome.diagnostics.suppressed_visible_memory_ids.is_empty() =>
                    {
                        return mcp_text_result(
                            render_facade_search_results(
                                query,
                                outcome.results.as_deref().unwrap_or_default(),
                                &outcome.diagnostics,
                                conversation_key,
                                workspace_membership.as_ref(),
                            ),
                            false,
                        )
                    }
                    Ok(_) => {}
                    Err(error) => return tool_error_result(format!("Error: {error}")),
                }
            }
        }

        match memory_tool::search_available_corpora_for_session_with_diagnostics(
            &store,
            memory_project,
            conversation_key,
            query,
            memory_tool::MemorySearchOptions {
                limit,
                include_memories,
                include_messages: sources.message,
                include_notes: sources.note,
                excluded_memory_ids: &visible_memory_ids,
                from_ms,
                to_ms,
            },
        ) {
            Ok(outcome) => mcp_text_result(
                render_facade_search_results(
                    query,
                    &outcome.results,
                    &outcome.diagnostics,
                    conversation_key,
                    workspace_membership.as_ref(),
                ),
                false,
            ),
            Err(error) => tool_error_result(format!("Error: {error}")),
        }
    }

    async fn handle_ctx_expand_facade(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["tag", "message", "start"]) else {
            return invalid_params_error("ctx_expand arguments must be an object");
        };
        let args = &args;
        let facade_scope = match self
            .resolve_facade_scope(channel, Some(args), "memories", false, false)
            .await
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        let session_id = facade_scope.conversation_key.as_str();
        let expand_mode = match resolve_ctx_expand_mode(args) {
            Ok(mode) => mode,
            Err(error) => return tool_error_result(error),
        };
        if let CtxExpandMode::Tag(number) = expand_mode {
            let tags = match store.load_tags_for_session(session_id) {
                Ok(tags) => tags,
                Err(error) => return tool_error_result(format!("Error: {error}")),
            };
            let Some(tag) = tags.iter().find(|tag| tag.tag_number == number) else {
                return mcp_text_result(format!("no tag {number} in this session; if {number} came from a <session-history> heading or a ctx_search hit, it is an ordinal: use message={number}"), false);
            };
            let transcripts = match store.load_chunk_transcripts_for_range(session_id, 0, i64::MAX)
            {
                Ok(rows) => rows,
                Err(error) => return tool_error_result(format!("Error: {error}")),
            };
            let messages = durable_expand_messages(&transcripts);
            return mcp_text_result(render_tag_expand(tag, &messages), false);
        }
        if let CtxExpandMode::Message(message) = expand_mode {
            return match store.load_chunk_transcript_for_message(session_id, message) {
                Ok(Some(row)) => {
                    if let Some(raw_message) = durable_expand_messages(std::slice::from_ref(&row))
                        .into_iter()
                        .find(|candidate| i64::try_from(candidate.ordinal).ok() == Some(message))
                    {
                        mcp_text_result(render_cached_message_expand(&raw_message), false)
                    } else {
                        mcp_text_result(render_message_expand(row, message), false)
                    }
                }
                Ok(None) => mcp_text_result(
                    format!(
                        "Message {message} is no longer recoverable from persisted chunk transcripts. The span was evicted or was compacted before transcript capture."
                    ),
                    false,
                ),
                Err(error) => tool_error_result(format!("Error: {error}")),
            };
        }
        let CtxExpandMode::Range {
            start,
            end,
            verbose,
        } = expand_mode
        else {
            return tool_error_result(
                "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end).",
            );
        };
        let last_compacted_ordinal = match store.last_compacted_ordinal(session_id) {
            Ok(ordinal) => ordinal,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        if last_compacted_ordinal < start {
            return mcp_text_result(
                format!(
                    "No compacted compartments found in range {start}-{end}. The range may be live tail, outside this session's history, or compacted before transcript capture."
                ),
                false,
            );
        }
        let bounded_end = end
            .min(last_compacted_ordinal)
            .min(start.saturating_add(CTX_EXPAND_MAX_ORDINAL_SPAN - 1));
        let compartments = match store.load_compartments_for_range(
            session_id,
            start,
            bounded_end,
            CTX_EXPAND_MAX_ROWS,
        ) {
            Ok(compartments) => compartments,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        let transcripts = match store.load_chunk_transcripts_for_range_bounded(
            session_id,
            start,
            bounded_end,
            CTX_EXPAND_MAX_ROWS,
        ) {
            Ok(transcripts) => transcripts,
            Err(error) => return tool_error_result(format!("Error: {error}")),
        };
        if let Ok(binding) = self.facade_binding(channel) {
            match self
                .async_history_expand(&binding, session_id, &compartments, start, bounded_end)
                .await
            {
                Ok(Some(messages)) => {
                    return mcp_text_result(
                        if verbose {
                            render_verbose_expand_result(
                                start,
                                bounded_end,
                                render_verbose_range_expand(&messages, start, bounded_end),
                            )
                        } else {
                            render_durable_range_expand(start, bounded_end, &messages)
                        },
                        false,
                    );
                }
                Ok(None) => {}
                Err(outcome) => return outcome,
            }
        }
        if verbose {
            let durable_messages = durable_expand_messages(&transcripts);
            let rendered = (!durable_messages.is_empty())
                .then_some(durable_messages)
                .map(|messages| render_verbose_range_expand(&messages, start, bounded_end))
                .filter(|result| !result.text.is_empty())
                .map(|result| render_verbose_expand_result(start, bounded_end, result))
                .unwrap_or_else(|| {
                    render_verbose_transcript_range_expand(start, bounded_end, &transcripts)
                });
            return mcp_text_result(rendered, false);
        }
        mcp_text_result(
            render_range_expand(start, bounded_end, &compartments, &transcripts),
            false,
        )
    }

    async fn handle_ctx_note_facade(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let Some(args) = facade_arguments(request, &["action", "content"]) else {
            return invalid_params_error("ctx_note arguments must be an object");
        };
        let args = &args;
        if args.get("surface_condition").is_some() {
            if let Some(binding) = self.bindings.lock().expect("bindings mutex").get(&channel) {
                if !binding.config.smart_notes_enabled {
                    return tool_error_result(
                        "Error: Smart notes are disabled; surface_condition is unavailable.",
                    );
                }
            }
        }
        if let Err(error) = validate_string_cap(args, "content", MAX_NOTE_CONTENT_BYTES)
            .and_then(|_| validate_string_cap(args, "surface_condition", MAX_SHORT_FIELD_BYTES))
            .and_then(|_| validate_string_cap(args, "compiled_provider", MAX_SHORT_FIELD_BYTES))
            .and_then(|_| validate_string_cap(args, "compiled_config", MAX_NOTE_CONTENT_BYTES))
            .and_then(|_| validate_string_cap(args, "compile_status", MAX_SHORT_FIELD_BYTES))
        {
            return tool_error_result(format!("Error: {error}."));
        }
        let action = string_arg(args, "action")
            .or_else(|| non_empty_string_arg(args, "content").map(|_| "write"))
            .unwrap_or("read");
        // `note_ids` is the only id field on both the model-facing schema and
        // the TS adapter's wire. The schema marks it required, so providers that
        // send only required arguments always carry it: `write` ignores it, and
        // an empty list on `read` is the plain listing read, the same as leaving
        // it out. A non-empty list on `read` and `dismiss` takes one to fifty
        // IDs, while `update` addresses exactly one note.
        let plain_read = action == "read"
            && args
                .get("note_ids")
                .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty));
        let note_ids = match action {
            "update" | "dismiss" | "read" if !plain_read => {
                let max = if action == "update" { 1 } else { 50 };
                let error = if action == "update" {
                    "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'."
                } else if action == "read" {
                    "Error: 'note_ids' must contain 1 to 50 positive integer ids when action is 'read'."
                } else {
                    "Error: 'note_ids' must contain 1 to 50 positive integer ids when action is 'dismiss'."
                };
                let Some(values) = args.get("note_ids").and_then(Value::as_array) else {
                    return tool_error_result(error);
                };
                if !(1..=max).contains(&values.len()) {
                    return tool_error_result(error);
                }
                let mut parsed = Vec::with_capacity(values.len());
                for value in values {
                    let Some(note_id) = value.as_i64().filter(|id| *id > 0) else {
                        return tool_error_result(error);
                    };
                    parsed.push(note_id);
                }
                Some(parsed)
            }
            _ => None,
        };
        // Every note id is a context.db id; a host still translating ids is refused.
        if let Err(error) = refuse_retired_note_id_lane(args) {
            return invalid_params_error(error);
        }
        let is_mutation = matches!(action, "write" | "update" | "dismiss");
        let facade_scope = match self
            .resolve_facade_scope(channel, Some(args), "notes", is_mutation, false)
            .await
        {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let store = match self.store_for_request().await {
            Ok(store) => store,
            Err(refusal) => return refusal.into_facade_outcome(),
        };
        let project = facade_scope.memory_project_path.as_str();
        let session = facade_scope.conversation_key.as_str();
        let filter = string_arg(args, "filter");
        let now = now_ms();
        let command_id = if is_mutation {
            match command_id_from_facade_request(request, args) {
                Ok(command_id) => command_id,
                Err(error) => return tool_error_result(format!("Error: {error}.")),
            }
        } else {
            None
        };
        if is_mutation && command_id.is_none() {
            self.log_missing_facade_command_id(session, "ctx_note", action);
        }

        match action {
            "write" => {
                let Some(content) = non_empty_string_arg(args, "content") else {
                    return tool_error_result(
                        "Error: 'content' is required when action is 'write'.",
                    );
                };
                let anchor = store
                    .load(session)
                    .ok()
                    .and_then(|loaded| loaded.meta.newest_live_block_id);
                // Smart notes need a host-side evaluator, which only the retired
                // `state_sync` route could declare, so a condition is always refused.
                if string_arg(args, "surface_condition")
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return tool_error_result(
                        "Conditional notes are not available in the current mode. Save a regular note without a condition. (MC-C08)",
                    );
                }
                facade_command_outcome(store.with_facade_command(
                    facade_scope.route_project_root.as_str(),
                    project,
                    "notes",
                    session,
                    "ctx_note",
                    action,
                    command_id.as_deref(),
                    |tx| {
                        let note = tx
                            .insert_note(NoteInput {
                                project_path: project,
                                route_project_root: Some(facade_scope.route_project_root.as_str()),
                                session_id: session,
                                content,
                                surface_condition: None,
                                anchor_block_id: anchor.as_deref(),
                                now_ms: now,
                            })
                            .map_err(|error| error.to_string())?;
                        let tray = tx
                            .active_session_note_tray(project, session)
                            .map_err(|error| error.to_string())?;
                        note_write_response(format_write_reply(note.id, tray, now), note.id)
                    },
                ))
            }
            "read" => {
                if let Some(requested) = note_ids.as_deref() {
                    let mut notes = Vec::with_capacity(requested.len());
                    for note_id in requested {
                        let row = match store.get_note_by_id(project, session, *note_id) {
                            Ok(Some(note)) => {
                                NoteByIdRow::Found(Box::new(present_note_status(note)))
                            }
                            Ok(None) => NoteByIdRow::Missing,
                            Err(error) => return tool_error_result(format!("Error: {error}")),
                        };
                        notes.push((*note_id, row));
                    }
                    return mcp_text_result(
                        finish_read_reply(render_notes_by_id(notes, now)),
                        false,
                    );
                }
                let limit = usize_arg(args, "limit").unwrap_or(25).clamp(1, 100);
                let offset = usize_arg(args, "offset").unwrap_or(0);
                // The default view is the tray: active session notes plus the
                // smart notes that are ready or still parked. An explicit filter
                // applies the same statuses to both types.
                let (session_statuses, smart_statuses): (Vec<&str>, Vec<&str>) = match filter {
                    // `surfacing`/`surfaced` are legacy delivery states the agent
                    // sees as `ready` (see `present_note_status`).
                    None => (
                        vec!["active"],
                        vec!["ready", "surfacing", "surfaced", "pending"],
                    ),
                    Some("active") => (vec!["active"], vec!["active"]),
                    Some("pending") => (vec!["pending"], vec!["pending"]),
                    Some("ready") => (vec!["ready"], vec!["ready", "surfacing", "surfaced"]),
                    Some("dismissed") => (vec!["dismissed"], vec!["dismissed"]),
                    Some("all") => {
                        let all = vec![
                            "active",
                            "pending",
                            "ready",
                            "surfacing",
                            "surfaced",
                            "dismissed",
                        ];
                        (all.clone(), all)
                    }
                    Some(_) => return tool_error_result(
                        "Error: filter must be one of all, active, pending, ready, or dismissed."
                            .to_string(),
                    ),
                };
                let notes = match store.read_glance_notes(
                    project,
                    session,
                    &session_statuses,
                    &smart_statuses,
                ) {
                    Ok(notes) => notes.into_iter().map(present_note_status).collect(),
                    Err(error) => return tool_error_result(format!("Error: {error}")),
                };
                mcp_text_result(
                    finish_read_reply(render_glance(notes, limit, offset, now)),
                    false,
                )
            }
            "update" => {
                let note_id = note_ids
                    .as_deref()
                    .and_then(|ids| ids.first().copied())
                    .unwrap_or(0);
                let module_note_id = note_id;
                let content = string_arg(args, "content");
                let condition = string_arg(args, "surface_condition")
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                if content.is_none() && condition.is_none() {
                    return tool_error_result(
                        "Error: Provide 'content' and/or 'surface_condition' to update."
                            .to_string(),
                    );
                }
                let current = match store.get_note_by_id(project, session, module_note_id) {
                    Ok(note) => note.filter(|note| {
                        matches!(
                            note.status.as_str(),
                            "active" | "pending" | "ready" | "surfacing" | "surfaced"
                        )
                    }),
                    Err(error) => return tool_error_result(format!("Error: {error}")),
                };
                let Some(current) = current else {
                    return tool_error_result(format!(
                        "Error: Note #{note_id} not found in your session/project or has no compatible fields to update."
                    ));
                };
                if condition.is_some() && current.type_name != "smart" {
                    return tool_error_result("Error: Only a note created with a condition can have one. Write a new note with surface_condition, and dismiss this one.");
                }
                // No route can declare a smart-note evaluator any more (see the write arm).
                if condition.is_some() {
                    return tool_error_result("Conditional notes are not available in the current mode. Save a regular note without a condition. (MC-C08)");
                }
                facade_command_outcome(
                    store.with_facade_command(
                        facade_scope.route_project_root.as_str(),
                        project,
                        "notes",
                        session,
                        "ctx_note",
                        action,
                        command_id.as_deref(),
                        |tx| {
                            match tx
                                .update_note_cas(
                                    project,
                                    module_note_id,
                                    &current.status,
                                    current.status_version,
                                    content,
                                    condition.map(Some),
                                    string_arg(args, "compiled_provider"),
                                    string_arg(args, "compiled_config"),
                                    i64_arg(args, "compiled_at"),
                                    string_arg(args, "compile_status"),
                                    now,
                                )
                                .map_err(|error| error.to_string())?
                            {
                                NoteCasOutcome::Applied(note) => facade_text_response(
                                    format!("Updated note #{note_id}: {}", note.content),
                                    false,
                                ),
                                NoteCasOutcome::Conflict { .. } => Ok(facade_text_response(
                                    format!(
                                        "Error: Note #{note_id} changed concurrently; retry with a fresh read."
                                    ),
                                    true,
                                )?),
                            }
                        },
                    ),
                )
            }
            "dismiss" => {
                let resolution = string_arg(args, "content");
                let requested = note_ids.as_deref().unwrap_or(&[]);
                if requested.len() > 1 {
                    let module_note_ids = requested.to_vec();
                    return facade_command_outcome(store.with_facade_command(
                        facade_scope.route_project_root.as_str(),
                        project,
                        "notes",
                        session,
                        "ctx_note",
                        action,
                        command_id.as_deref(),
                        |tx| {
                            let outcomes = tx
                                .dismiss_notes(project, session, &module_note_ids, resolution, now)
                                .map_err(|error| error.to_string())?;
                            let mut dismissed_count = 0usize;
                            let mut details = Vec::with_capacity(outcomes.len());
                            for (note_id, outcome) in &outcomes {
                                if *outcome == NoteDismissOutcome::Dismissed {
                                    dismissed_count += 1;
                                }
                                details.push(format!(
                                    "- Note #{note_id}: {}",
                                    note_dismiss_outcome_text(*outcome)
                                ));
                            }
                            facade_text_response(
                                format!(
                                    "Dismissed {dismissed_count} of {} notes.\n{}",
                                    outcomes.len(),
                                    details.join("\n")
                                ),
                                false,
                            )
                        },
                    ));
                }
                let note_id = requested.first().copied().unwrap_or(0);
                let module_note_id = note_id;
                facade_command_outcome(
                    store.with_facade_command(
                        facade_scope.route_project_root.as_str(),
                        project,
                        "notes",
                        session,
                        "ctx_note",
                        action,
                        command_id.as_deref(),
                        |tx| {
                            let dismissed = tx
                                .dismiss_note(project, session, module_note_id, resolution, now)
                                .map_err(|error| error.to_string())?;
                            match dismissed {
                                Some(_) => facade_text_response(
                                    format!("Note #{note_id} dismissed."),
                                    false,
                                ),
                                None => facade_text_response(
                                    format!(
                                        "Error: Note #{note_id} not found in your session/project or already dismissed."
                                    ),
                                    true,
                                ),
                            }
                        },
                    ),
                )
            }
            _ => tool_error_result("Error: Unknown ctx_note action.".to_string()),
        }
    }
}

impl Drop for McHandler {
    fn drop(&mut self) {
        self.store_open.cancel();
    }
}

impl Default for McHandler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ModuleHandler for McHandler {
    /// The storage seam: HELLO_ACK carries the resolved descriptor (or none in
    /// standalone dev). Start the store open ONCE here — never at construction, because
    /// the path isn't known until the ACK lands. Opening runs off the request lane so a
    /// predecessor's live single-writer lease cannot block transform dispatch.
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        let (descriptor, origin) = resolve_descriptor_with_origin(ack.storage.as_ref());
        if let StorageBackend::Sqlite { path } = &descriptor.backend {
            let configured = match &self.agent_data {
                Some(service) => service.configure(Path::new(path)),
                None => self.move_visibility.configure_readonly(Path::new(path)),
            };
            if let Err(error) = configured {
                tracing::error!(message=%error.message, "MC move journal could not be opened");
            }
        }
        if let Some(log_directory) = &self.log_directory {
            warn_if_log_directory_differs(&descriptor, log_directory);
        }
        self.begin_store_open(descriptor, origin);
        self.start_async_compaction_background();
    }

    /// Return a liveness snapshot without touching the store or dispatch lane.
    /// The SDK invokes this on its separate channel-0 health task; bus status is
    /// copied under short-lived in-memory locks.
    async fn health(&self) -> HealthReport {
        let now = now_ms().max(0) as u64;
        let report = if let Some(waiting) = self.store_open.waiting_report(now) {
            waiting
        } else if let Some(failed) = self.store_open.failed_report() {
            failed
        } else {
            self.augment_runner_choice_health(DISPATCH_HEALTH.report(now))
        };
        let mut report = with_pinned_epochs_health(report);
        report
            .metrics
            .as_mut()
            .and_then(Value::as_object_mut)
            .expect("health metrics object")
            .insert("async_bus".into(), self.async_bus_health());
        report
    }

    /// Record the route's {project_root, session} so the transform path can resolve the
    /// project from the daemon-controlled channel (never a per-pass request field). Accept
    /// session routes. The independent app service authorizes its caller first.
    async fn on_bind(&self, req: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.app_channels
            .lock()
            .expect("app channels")
            .remove(&req.handle.channel);
        if let Some(service) = &self.agent_data {
            service
                .channels
                .lock()
                .expect("agent data channels")
                .remove(&req.handle.channel);
        }
        if matches!(&req.target, subc_protocol::RouteTarget::InternalService { service_id, .. } if service_id == app_read::SERVICE_ID)
        {
            let allow_direct = !matches!(req.principal, Some(subc_protocol::Principal::Direct))
                || config::user_app_read_allow_direct();
            return match app_read::admission::admit(req, &self.registered_module_id, allow_direct) {
                Ok(caller) => {
                    self.unbind_route(req.handle.channel);
                    self.app_channels
                        .lock()
                        .expect("app channels")
                        .insert(req.handle.channel, caller);
                    subc_client_rs::BindDecision::accept()
                }
                Err(refusal) => refusal,
            };
        }
        if let subc_protocol::RouteTarget::InternalService {
            module_id,
            service_id,
        } = &req.target
        {
            if service_id == cortexkit_role_agent_data::SERVICE_ID {
                let Some(service) = &self.agent_data else {
                    return subc_client_rs::BindDecision::reject(
                        "unavailable",
                        "agent-data service is disabled",
                    );
                };
                if module_id != &self.registered_module_id {
                    tracing::error!(target=%module_id, registered=%self.registered_module_id, "MC agent-data target differs from its registered identity");
                    return subc_client_rs::BindDecision::reject(
                        "agent_data_target_mismatch",
                        "agent-data target differs from the registered module",
                    );
                }
                if !matches!(&req.principal, Some(subc_protocol::Principal::Reserved { module_id }) if module_id == "entorhinal")
                {
                    return subc_client_rs::BindDecision::reject(
                        "caller_forbidden",
                        "only reserved:entorhinal may bind agent-data",
                    );
                }
                service
                    .channels
                    .lock()
                    .expect("agent data channels")
                    .insert(req.handle.channel);
            }
        }
        let config = self.effective_config(&req.identity.project_root);
        // Hosts record their project identity before opening the route. Without
        // that row, resolve through Entorhinal once the store can check managed projects.
        let host_identity = self.store.get().and_then(|store| {
            store
                .session_project_identity(&req.identity.session)
                .ok()
                .flatten()
        });
        let initial = match host_identity {
            Some(identity) => Ok(identity),
            None => {
                if let Some(store) = self.store.get() {
                    self.entorhinal
                        .resolve_for_session(
                            &self.project_identities,
                            &req.identity.project_root,
                            &req.identity.harness,
                            &req.identity.session,
                            Some(store.as_ref()),
                        )
                        .await
                } else {
                    // Without an open store we cannot read context.db's authority_managed
                    // marker, which prevents identity merges until the single-store migration.
                    // Keep the existing identity rather than authorizing a new pin.
                    project_identity::log_once(
                        format!("entorhinal-authority-unavailable:{}", req.identity.project_root.display()),
                        "Keeping project identity; authority check unavailable until the store opens",
                    );
                    self.project_identities.resolve(&req.identity.project_root)
                }
            }
        };
        self.bind_route(
            req.handle.channel,
            SessionBinding {
                principal: req.principal.clone(),
                scope: req.scope.clone(),
                project_root: req.identity.project_root.clone(),
                harness: req.identity.harness.clone(),
                session: req.identity.session.clone(),
                model_key: None,
                config,
                // Use the default until a request supplies the history budget
                // computed by the harness for that pass.
                history_budget_tokens: memory_render::DEFAULT_HISTORY_BUDGET_TOKENS,
            },
        );
        self.binding_projects
            .lock()
            .expect("binding project mutex")
            .get_mut(&req.handle.channel)
            .expect("newly bound route")
            .initial = Some(initial);
        self.record_route_role_versions(req.handle.channel, req.role_versions.as_ref());
        if let Ok(binding) = self.facade_binding(req.handle.channel) {
            if let Some(service) = &self.agent_data {
                if let Err(error) = service.observe(&binding) {
                    self.unbind_route(req.handle.channel);
                    return subc_client_rs::BindDecision::reject("unavailable", error.message);
                }
            }
        }
        subc_client_rs::BindDecision::accept()
    }

    /// Drop the route's binding on teardown so a reused channel can't resolve a stale
    /// project and the map doesn't leak.
    async fn on_route_gone(&self, handle: &RouteHandle) {
        self.app_channels
            .lock()
            .expect("app channels")
            .remove(&handle.channel);
        if let Some(service) = &self.agent_data {
            service
                .channels
                .lock()
                .expect("agent data channels")
                .remove(&handle.channel);
        }
        self.unbind_route(handle.channel);
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        self.handle_channel(ctx.route_handle().channel, body).await
    }
}

impl McHandler {
    async fn handle_channel(&self, channel: u16, body: Vec<u8>) -> HandlerOutcome {
        let app_caller = self
            .app_channels
            .lock()
            .expect("app channels")
            .get(&channel)
            .cloned();
        if let Some(caller) = app_caller {
            let allow_direct = !caller.is_direct() || config::user_app_read_allow_direct();
            let context = app_read::AppReadContext::from_parts(
                self.store.get().cloned(),
                Arc::clone(&self.config),
                {
                    let roots = self
                        .active_project_roots
                        .lock()
                        .expect("active project roots");
                    let mut paths: Vec<_> = roots.values().cloned().collect();
                    paths.sort();
                    paths.dedup();
                    paths
                },
                now_ms(),
            );
            return app_read::handle(&caller, allow_direct, &body, &context);
        }
        // A flow-scoped route never takes the agent-data lane: it falls through to
        // the dispatcher, whose flow fence admits only the flow ops.
        if !self.flow_scoped(channel)
            && self.agent_data.as_ref().is_some_and(|service| {
                service
                    .channels
                    .lock()
                    .expect("agent data channels")
                    .contains(&channel)
            })
        {
            let admitted = self.bindings.lock().expect("route bindings").get(&channel).is_some_and(|binding|
                matches!(&binding.principal, Some(subc_protocol::Principal::Reserved { module_id }) if module_id == "entorhinal"));
            if !admitted {
                return HandlerOutcome::Error {
                    code: "caller_forbidden".into(),
                    message: "only reserved:entorhinal may move MC data".into(),
                };
            }
            if body.len() > 3 * 1024 * 1024 {
                return HandlerOutcome::Error {
                    code: "invalid_request".into(),
                    message: "agent-data request exceeds its frame budget".into(),
                };
            }
            let request = match serde_json::from_slice::<Value>(&body) {
                Ok(request) => request,
                Err(_) => {
                    return HandlerOutcome::Error {
                        code: "invalid_request".into(),
                        message: "agent-data request is not JSON".into(),
                    }
                }
            };
            return self
                .agent_data
                .as_ref()
                .expect("admitted move service")
                .handle(
                    self,
                    channel,
                    request.get("method").and_then(Value::as_str).unwrap_or(""),
                    request.get("params").unwrap_or(&Value::Null),
                )
                .await;
        }
        if let Err(outcome) = enforce_request_byte_cap(&body) {
            return outcome;
        }
        let request = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
        if request
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| app_read::APP_READ_METHODS.contains(&method))
        {
            return HandlerOutcome::Error {
                code: if self
                    .bindings
                    .lock()
                    .expect("route bindings")
                    .contains_key(&channel)
                {
                    "app_caller_forbidden"
                } else {
                    "route_unbound"
                }
                .into(),
                message: "App read methods require a bound mc-app-read channel.".into(),
            };
        }
        self.dispatch_request(channel, request).await
    }
}

/// The only methods a flow-scoped route may call. Declaring `flow-scopes/v1`
/// promises the daemon that ck-mc never treats a flow as its owner agent for
/// approvals, writes or grants; admitting a flow route to a fixed list of
/// read-only ops keeps that true whatever the other lanes' own checks do. A new
/// flow op joins this list deliberately.
const FLOW_ROUTE_METHODS: &[&str] = &[subagent_invocations_read::METHOD];

impl McHandler {
    /// Whether the daemon bound `channel` under a flow's scope (`flow_id` in the stamp).
    fn flow_scoped(&self, channel: u16) -> bool {
        self.bindings
            .lock()
            .expect("route bindings")
            .get(&channel)
            .and_then(|binding| binding.scope.as_ref())
            .is_some_and(|scope| scope.attributes.flow_id.is_some())
    }

    /// Refuses, before any dispatch, every request on a flow-scoped route except
    /// a [`FLOW_ROUTE_METHODS`] call in the `{"method": ...}` shape. Tool-call
    /// shapes (`{"name", "arguments"}`) carry no method and are refused too.
    fn flow_route_refusal(&self, channel: u16, request: &Value) -> Option<HandlerOutcome> {
        if !self.flow_scoped(channel) {
            return None;
        }
        let method = request.get("method").and_then(Value::as_str);
        if method.is_some_and(|method| FLOW_ROUTE_METHODS.contains(&method)) {
            return None;
        }
        let named = method
            .or_else(|| request.get("name").and_then(Value::as_str))
            .or_else(|| request.get("kind").and_then(Value::as_str))
            .unwrap_or("(no method)");
        Some(HandlerOutcome::Error {
            code: "flow_route_not_admitted".to_string(),
            message: format!(
                "a flow-scoped route may call only {FLOW_ROUTE_METHODS:?}, not `{named}`"
            ),
        })
    }

    /// Route a parsed request body to its handler. Split from `handle()` so the
    /// routing arms are unit-testable (`RequestCtx` cannot be constructed
    /// outside the transport).
    #[cfg(test)]
    async fn dispatch_value(&self, channel: u16, request: Value) -> HandlerOutcome {
        self.dispatch_request(channel, request).await
    }

    async fn dispatch_request(&self, channel: u16, request: Value) -> HandlerOutcome {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .or_else(|| request.get("kind").and_then(Value::as_str));
        if let Some(refusal) = self.flow_route_refusal(channel, &request) {
            return refusal;
        }
        // Retired routes answer by name before any store, provider or move check.
        if let Some(method) = method.filter(|method| RETIRED_TRANSFORM_ROUTES.contains(method)) {
            return retired_route(method);
        }
        if let Some(method) = method.filter(|method| method.starts_with("agent_data.")) {
            let Some(service) = &self.agent_data else {
                return HandlerOutcome::Error {
                    code: "unavailable".into(),
                    message: "agent-data service is disabled".into(),
                };
            };
            return service
                .handle(
                    self,
                    channel,
                    method,
                    request.get("params").unwrap_or(&Value::Null),
                )
                .await;
        }
        let _move_pass = match self
            .move_visibility
            .request_pass(self, channel, &request, method)
        {
            Ok(pass) => pass,
            Err(refusal) => return refusal,
        };
        // Authenticate these non-tool routes before store-open or provider checks.
        // Their executors will replace the named refusals without retargeting served paths.
        match method {
            Some("mc.ui_capabilities") => {
                return self.handle_non_served_method(channel, &request, "mc.ui_capabilities")
            }
            Some("mc.read_sidebar") => {
                return self.handle_non_served_method(channel, &request, "mc.read_sidebar")
            }
            Some("mc.read_status") => {
                return self.handle_non_served_method(channel, &request, "mc.read_status")
            }
            Some("mc.read_embed") => {
                return self.handle_non_served_method(channel, &request, "mc.read_embed")
            }
            Some("mc.read_compartment_count") => {
                return self.handle_non_served_method(
                    channel,
                    &request,
                    "mc.read_compartment_count",
                )
            }
            Some("mc.read_todos") => {
                return self.handle_non_served_method(channel, &request, "mc.read_todos")
            }
            Some("mc.recomp_preview") => {
                return self.handle_non_served_method(channel, &request, "mc.recomp_preview")
            }
            Some("mc.recomp_start") => {
                return self.handle_non_served_method(channel, &request, "mc.recomp_start")
            }
            Some("mc.rescore") => {
                return self.handle_non_served_method(channel, &request, "mc.rescore")
            }
            Some("mc.wrapup") => {
                return self.handle_non_served_method(channel, &request, "mc.wrapup")
            }
            Some("mc.flush") => {
                return self.handle_non_served_method(channel, &request, "mc.flush")
            }
            Some("mc.dream") => {
                return self.handle_non_served_method(channel, &request, "mc.dream")
            }
            Some("mc.embed") => {
                return self.handle_non_served_method(channel, &request, "mc.embed")
            }
            Some("mc.job_read") => {
                return self.handle_non_served_method(channel, &request, "mc.job_read")
            }
            Some("mc.job_cancel") => {
                return self.handle_non_served_method(channel, &request, "mc.job_cancel")
            }
            Some("mc.ui_events") => {
                return self.handle_non_served_method(channel, &request, "mc.ui_events")
            }
            Some("mc.notice_currentness") => {
                return self.handle_non_served_method(channel, &request, "mc.notice_currentness")
            }
            Some("mc.retrieval") => return self.handle_retrieval(channel, &request).await,
            Some("mc.memory") => {
                return self.handle_non_served_method(channel, &request, "mc.memory")
            }
            _ => {}
        }
        // A route bound to a Broca dream child's session serves only that child's
        // admitted task tools (plus read-only discovery), whatever the request says.
        if let Some(outcome) = self.broca_dream_route(channel, method, &request) {
            return outcome;
        }
        let catalog_request = method.is_none()
            && request.get("name").and_then(Value::as_str) == Some("tool.catalog")
            && request.get("arguments").is_some();
        // A store that a newer ck-mc migrated past this binary refuses every request by name,
        // whatever its lane. Most lanes would refuse anyway because no store handle exists, but
        // Catalog discovery is the exception: its bytes derive from config, not
        // rows. It reports a failed persistence attempt only to later stateful
        // provider calls; a plan fetch must not turn into a storage refusal.
        if method != Some("echo") && !catalog_request {
            if let Some(refusal) = self.store_open.store_ahead_refusal() {
                let facade = method.is_none()
                    && request.get("name").is_some()
                    && request.get("arguments").is_some();
                return if facade {
                    refusal.into_facade_outcome()
                } else {
                    refusal.into_outcome()
                };
            }
        }
        if let Some(method) = method {
            return match method {
                "role.describe" => providers::describe(),
                "compaction.setup" | "view.get" | "compaction.ride" => {
                    self.handle_provider_value(
                        channel,
                        method,
                        request.get("params").unwrap_or(&Value::Null),
                    )
                    .await
                }
                // Proves the store opened end-to-end and, when a session_id is supplied,
                // returns the session's stored trace state directly from the module.
                "health" | "status" | "diagnostics" => self.handle_status_value(&request),
                "guidance.get" => self.handle_guidance_value(channel, &request),
                "manifest.get" => self.handle_prompt_surface_manifest_value(channel, &request),
                "dreamer.run_task" => self.handle_dreamer_run_task(channel, &request).await,
                "dream.ownership" => self.handle_dream_ownership(channel, &request),
                "dream.run" => self.handle_dream_run(channel, &request),
                subagent_invocations_read::METHOD => {
                    self.handle_subagent_invocations_read(channel, &request)
                }
                "todo_state.set" => self.handle_todo_state_set_value(channel, &request),
                "session.flush" => self.handle_session_flush_value(channel, &request),
                "session.recomp" => self.handle_session_recomp_value(channel, &request),
                "session.status" => self.handle_session_status_value(channel, &request),
                "session.delete" => self.handle_session_delete_value(channel, &request),
                "session.wrapup" => self.handle_session_wrapup_value(channel, &request).await,
                // Explicit wire-debugging echo. Opt-in only: echoing every
                // unrecognized body would silently swallow misrouted requests
                // (a caller can "succeed" against an echo while testing nothing),
                // so unknown shapes fail loud below instead.
                "echo" => respond(json!({ "ok": true, "echo": request })),
                _ => unrecognized_request_error(&request),
            };
        }
        if request.get("name").is_some() && request.get("arguments").is_some() {
            let outcome = self.handle_facade_value(channel, request).await;
            return outcome;
        }
        unrecognized_request_error(&request)
    }
}

/// Routes of the old host-driven Rust mode. ck-mc now manages a session only
/// through a runner's async compaction calls (`compaction.setup`, `view.get`,
/// `compaction.ride`), so these answer `transform_route_retired` by name instead
/// of falling through to the unknown-request error. A host still sending one gets
/// a code it can recognise and fall back on.
pub const RETIRED_TRANSFORM_ROUTES: &[&str] = &[
    "transform",
    "state_sync",
    "state_import",
    "agent_drops.append",
    "note.evaluate",
    "dream.child.pending",
    "dream.child.claim",
    "dream.child.heartbeat",
    "dream.child.opened",
    "dream.child.event",
    "dream.child.tool",
    "dream.child.cleanup",
    "dream.child.unavailable",
    "historian.pending",
    "historian.claim",
    "historian.heartbeat",
    "historian.complete",
];

/// The error code a retired route answers with.
pub const RETIRED_ROUTE_CODE: &str = "transform_route_retired";

/// The refusal for a retired route; `message` is the exact method name.
fn retired_route(method: &str) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: RETIRED_ROUTE_CODE.to_string(),
        message: method.to_string(),
    }
}

fn non_served_route_refusal(method: &str) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: non_served_contract::ROUTE_REFUSAL_CODE.to_string(),
        message: method.to_string(),
    }
}

/// Classify a request that matched no known `method`/`kind`. Two distinct
/// errors so a misroute is diagnosable from the error code alone:
/// - `{name, arguments}` without `method`/`kind` is the shape of an MCP
///   tools/call envelope. Only ctx_memory and ctx_search are accepted on that
///   surface; unsupported names keep a distinct error so a policy or routing
///   mistake is diagnosable from the code alone.
/// - Anything else names the discriminator fields we looked for and the
///   top-level keys we actually got.
fn unrecognized_request_error(request: &Value) -> HandlerOutcome {
    let has_mcp_shape = request.get("name").is_some() && request.get("arguments").is_some();
    if has_mcp_shape {
        return HandlerOutcome::Error {
            code: "facade_envelope_not_supported".to_string(),
            message: "MCP tools/call envelope ({name, arguments}) names a tool this module \
                      does not route on the facade; other module commands use flat bodies \
                      with a top-level `kind` field"
                .to_string(),
        };
    }
    let got_keys = match request.as_object() {
        Some(map) => {
            let keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.join(", ")
        }
        None => format!("non-object JSON ({})", json_type_name(request)),
    };
    HandlerOutcome::Error {
        code: "unrecognized_request_shape".to_string(),
        message: format!(
            "no `method` or `kind` field matched a known request; got top-level keys: [{got_keys}]"
        ),
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The wall-clock now in ms. Used ONLY to set the frozen expiry cutoff on a HARD (the
/// first materialization freezes it into meta); every later pass reads the frozen value,
/// never this, so expiry never drifts the rendered bytes between passes.
fn now_ms() -> i64 {
    #[cfg(test)]
    if let Some(now) = tests::per_pass_fixed_now_ms() {
        return now;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn unknown_serializer_profile_error() -> HandlerOutcome {
    HandlerOutcome::Error {
        code: "unknown_serializer_profile".to_string(),
        message: "missing or unknown serializer_profile".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn attach_native_messages_with_tags(
    response: &mut transform::TransformResponse,
    request: &TransformRequest,
    reasoning_clear_units: &[mc_core::FrozenUnit],
    tag_numbers: &BTreeMap<String, u64>,
    mutation_exempt_mid: Option<&str>,
    lineage_anchor_mid: Option<&str>,
    transition_consumed: bool,
) {
    if !request.serve_native {
        return;
    }
    let native_messages = encode_full_native_messages(
        response,
        request,
        reasoning_clear_units,
        tag_numbers,
        mutation_exempt_mid,
        lineage_anchor_mid,
        transition_consumed,
    );
    response.native_messages = Some(native_messages.into_iter().map(Arc::new).collect());
}

fn encode_full_native_messages(
    response: &transform::TransformResponse,
    request: &TransformRequest,
    reasoning_clear_units: &[mc_core::FrozenUnit],
    tag_numbers: &BTreeMap<String, u64>,
    mutation_exempt_mid: Option<&str>,
    lineage_anchor_mid: Option<&str>,
    transition_consumed: bool,
) -> Vec<Value> {
    let served = response.messages();
    let native_reasoning_keep_mids = &response.native_reasoning_keep_mids;
    profile_start!(perf_decode, "native_reference_decode");
    let sidecar = request
        .native_fold_sidecar
        .as_ref()
        .map(|sidecar| (**sidecar).clone())
        .unwrap_or_else(|| {
            request
                .native_messages
                .as_deref()
                .map(|native| {
                    codec::opencode::decode_opencode_with_sidecar_and_base(
                        native,
                        None,
                        request
                            .native_fold_prefix
                            .as_ref()
                            .map_or(0, |prefix| prefix.messages as u64),
                    )
                })
                .map(|decoded| decoded.sidecar)
                .unwrap_or_else(|| codec::DecodeSidecar::new("opencode"))
        });
    profile_end!(perf_decode);
    profile_start!(perf_prepare, "native_reference_prepare");
    let served_messages = served
        .iter()
        .map(|message| message.deref().clone())
        .collect::<Vec<_>>();
    // Raw newest-vector replay protects live signed thinking, not a cleared
    // response. Cleared mids must retain the served tagged/sentinel layout.
    let cleared_mids = transform::reasoning_native_clear_mids(reasoning_clear_units);
    let mutation_exempt_mids = [mutation_exempt_mid, lineage_anchor_mid]
        .into_iter()
        .flatten()
        .filter(|mid| !cleared_mids.contains(mid))
        .collect::<Vec<_>>();
    let reasoning_exempt_mid =
        transform::latest_assistant_reasoning_mutation_exempt_mid(&request.messages)
            .filter(|mid| !cleared_mids.contains(mid));
    profile_end!(perf_prepare);
    profile_start!(perf_encode, "native_reference_encode");
    let mut native_messages =
        codec::opencode::encode_opencode_with_transition_state_and_reasoning_exemption(
            &served_messages,
            &sidecar,
            Some(&request.session_id),
            &mutation_exempt_mids,
            reasoning_exempt_mid,
            transition_consumed,
        );
    profile_end!(perf_encode);
    profile_start!(_perf_reasoning, "native_reference_reasoning");
    if let Some(profile) = SerializerProfile::parse(&request.serializer_profile) {
        transform::clear_served_native_reasoning_with_tags(
            profile,
            transform::request_accepts_empty_content(request),
            &mut native_messages,
            &served_messages,
            &request.messages,
            reasoning_clear_units,
            request.mid_turn,
            tag_numbers,
        );
    }
    replay_native_reasoning_keeps(&mut native_messages, &sidecar, native_reasoning_keep_mids);
    native_messages
}

fn replay_native_reasoning_keeps(
    messages: &mut [Value],
    sidecar: &codec::DecodeSidecar,
    keep_mids: &[String],
) {
    for message in messages {
        let Some(mid) = message["info"]["id"].as_str() else {
            continue;
        };
        if !keep_mids.iter().any(|keep| keep == mid) {
            continue;
        }
        if let Some(meta) = sidecar.messages.get(mid) {
            if let Some(parts) = meta.raw.get("parts") {
                message["parts"] = parts.clone();
            }
        }
    }
}

fn replay_dream_task_response(response_json: &str) -> HandlerOutcome {
    let Ok(response) = serde_json::from_str::<Value>(response_json) else {
        return HandlerOutcome::Error {
            code: "dreamer_ledger_corrupt".to_string(),
            message: "recorded dreamer response is not valid JSON".to_string(),
        };
    };
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return HandlerOutcome::Error {
            code: response
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("dreamer_run_failed")
                .to_string(),
            message: response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("dreamer task failed")
                .to_string(),
        };
    }
    respond(response)
}

// SAFETY: Deliberate fault injection for the joint CC rig drive — see the `drive-fault`
// feature note in Cargo.toml for why this ships in the binary at all.
//
// Why it exists: mismatch, raw-only fence, and timeout recovery paths require faults at
// the module boundary that normal traffic cannot trigger deterministically. The drive
// needs this module to malform a response or stall a transform before execution; the
// protocol peer correctly carries no fault scaffolding, so the injection lives here.
//
// Why it is safe: this whole block is compiled ONLY under `--features drive-fault`. A
// default deploy build has no corruption path at all — that structural absence is the
// dormancy proof, so there is no runtime-reachable arm a stray env var could trigger.
// Even under the feature the arm is inert unless MC_DRIVE_FAULT selects it. Faults are
// scoped to the transform request/response path; facade tools and status/wrapup ops do
// not route through these gates.
//
// Additionally, the fault self-disarms after MC_DRIVE_FAULT_COUNT firings (default 1)
// via a fetch_update claim on DRIVE_FAULT_REMAINING. This prevents the fault from
// corrupting a recovery pass in the fence+recover drive arc — the only other disarm
// would be a restart, which injects a variable the arc must not contain. Total WARN
// lines in logs will equal exactly N, so miscounts are visible.
//
// Maintenance rule: never add another fault arm without the same absence-proof note in
// Cargo.toml and the fault-shape tests that pin the existing arms.
#[cfg(feature = "drive-fault")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriveFault {
    FingerprintSkew,
    OmitCkMessages,
    Channel2Arm,
    TransformTimeout,
}

/// Map the raw MC_DRIVE_FAULT value to a fault arm. Pure (no env access) so the
/// selection logic is unit-testable without mutating process-global env or the
/// process-wide OnceLock below. Any unrecognized value — or no value — maps to None,
/// which leaves the response untouched.
#[cfg(feature = "drive-fault")]
fn parse_drive_fault(raw: Option<&str>) -> Option<DriveFault> {
    match raw {
        Some("fingerprint_skew") => Some(DriveFault::FingerprintSkew),
        Some("omit_ck_messages") => Some(DriveFault::OmitCkMessages),
        Some("channel2_arm") => Some(DriveFault::Channel2Arm),
        Some("transform_timeout") => Some(DriveFault::TransformTimeout),
        _ => None,
    }
}

/// Parse MC_DRIVE_FAULT_COUNT: how many transform responses may fire the fault before
/// the mechanism self-disarms. Pure (no env access) so unit-testable without touching
/// process-global env or the process-wide OnceLock/AtomicUsize below.
///
/// Defaults to 1 when unset, empty, or unparseable. A value of 0 is treated as
/// unset (defaults to 1) since 0 would mean "never fire" which is indistinguishable
/// from not setting MC_DRIVE_FAULT at all.
#[cfg(feature = "drive-fault")]
fn parse_drive_fault_count(raw: Option<&str>) -> usize {
    match raw.and_then(|s| s.parse::<usize>().ok()) {
        Some(n) if n > 0 => n,
        _ => 1,
    }
}

/// Remaining fault-firings before the mechanism self-disarms permanently.
/// Initialized alongside the arm selection in `drive_fault()`.
#[cfg(feature = "drive-fault")]
static DRIVE_FAULT_REMAINING: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// The active fault arm, read from MC_DRIVE_FAULT once per process (first call wins via
/// OnceLock — no per-request getenv on the transform hot path). Also initializes
/// DRIVE_FAULT_REMAINING from MC_DRIVE_FAULT_COUNT so the count is set before any
/// respond_transform call can read it.
#[cfg(feature = "drive-fault")]
fn drive_fault() -> Option<DriveFault> {
    use std::sync::OnceLock;
    static FAULT: OnceLock<Option<DriveFault>> = OnceLock::new();
    *FAULT.get_or_init(|| {
        let fault = parse_drive_fault(std::env::var("MC_DRIVE_FAULT").ok().as_deref());
        // Initialize the remaining fault count alongside the arm selection.
        // This runs exactly once per process (OnceLock), so DRIVE_FAULT_REMAINING
        // is set before any request or response fault can read it.
        let count = parse_drive_fault_count(std::env::var("MC_DRIVE_FAULT_COUNT").ok().as_deref());
        DRIVE_FAULT_REMAINING.store(count, std::sync::atomic::Ordering::Relaxed);
        fault
    })
}

#[cfg(feature = "drive-fault")]
fn claim_drive_fault() -> bool {
    use std::sync::atomic::Ordering;
    matches!(
        DRIVE_FAULT_REMAINING.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1)),
        Ok(previous) if previous > 0
    )
}

#[cfg(feature = "drive-fault")]
async fn maybe_apply_transform_timeout_fault() -> bool {
    if drive_fault() != Some(DriveFault::TransformTimeout) || !claim_drive_fault() {
        return false;
    }
    let delay_ms = std::env::var("MC_DRIVE_FAULT_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(16_000);
    tracing::warn!(
        "mc-module: WARN MC_DRIVE_FAULT=transform_timeout active — stalling transform request by {delay_ms} ms for drive"
    );
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    true
}

/// Corrupt a transform response per the selected fault arm and log one loud WARN per
/// fired fault so a forgotten MC_DRIVE_FAULT is impossible to miss in rig logs.
#[cfg(feature = "drive-fault")]
fn apply_drive_fault(response: &mut transform::TransformResponse, fault: DriveFault) {
    match fault {
        DriveFault::FingerprintSkew => {
            // Echo a perturbed fingerprint so it fails any equality check against the
            // submitted value. A response with no fingerprint still gets a non-empty
            // sentinel so the echo cannot match a submitted empty/absent value.
            let perturbed = match response.full_array_fingerprint.take() {
                Some(fingerprint) => format!("{fingerprint}_skew"),
                None => "_skew".to_string(),
            };
            response.full_array_fingerprint = Some(perturbed);
            tracing::error!(
                "mc-module: WARN MC_DRIVE_FAULT=fingerprint_skew active — response deliberately corrupted for drive"
            );
        }
        DriveFault::OmitCkMessages => {
            // Drop ck_messages so it serializes ABSENT (the same skip_serializing_if arm
            // need_full_sync uses) while keeping the ok status: a success-shaped response
            // with the array field missing.
            response.ck_messages = None;
            tracing::error!(
                "mc-module: WARN MC_DRIVE_FAULT=omit_ck_messages active — response deliberately corrupted for drive"
            );
        }
        DriveFault::Channel2Arm => {
            // Force a channel-2 directive onto the response regardless of pressure so
            // the DELIVERY contract (same-pass append → echo → delivered-mark →
            // frozen re-serve on a refused pass) can be driven end-to-end without
            // faking a large reclaimable tail. The pressure math upstream is covered
            // by unit tests; a drive container cannot honestly reach the condition
            // (its harness compacts real tail bytes away faster than a drive
            // accumulates them), so earning the directive there would require a
            // conversation shape no real session has.
            response.channel2_directive = Some(transform::Channel2Directive {
                text: "Context pressure is high. Review older tool outputs and reduce what you no longer need.".to_string(),
                directive_id: "drive-fault-channel2".to_string(),
                armed_at_ms: 0,
            });
            tracing::info!(
                "mc-module: WARN MC_DRIVE_FAULT=channel2_arm active — directive force-armed for drive"
            );
        }
        DriveFault::TransformTimeout => {
            unreachable!("transform-timeout faults are consumed before transform execution")
        }
    }
}

fn respond(value: Value) -> HandlerOutcome {
    match serde_json::to_vec(&value) {
        Ok(bytes) => HandlerOutcome::Response(bytes),
        Err(e) => HandlerOutcome::Error {
            code: "encode_failed".to_string(),
            message: e.to_string(),
        },
    }
}

fn guidance_bytes_for(text: &str, date_line: &str) -> String {
    format!("{text}\n{date_line}")
}

#[cfg(test)]
fn primary_language_directive(language: &str) -> Option<String> {
    let name = crate::content_language::resolve_language_name(Some(language))?;
    Some(format!(
        "Use {name} for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim."
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn mcp_text_result(text: String, is_error: bool) -> HandlerOutcome {
    respond(json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    }))
}

#[derive(serde::Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum MemoryCurateState {
    Applied,
    Refused,
}

#[derive(serde::Serialize)]
struct MemoryCurateResult {
    state: MemoryCurateState,
    memory_id: Option<i64>,
    superseded_ids: Vec<i64>,
    error_code: Option<String>,
}

impl MemoryCurateResult {
    fn applied(memory_id: i64, superseded_ids: Vec<i64>) -> Self {
        Self {
            state: MemoryCurateState::Applied,
            memory_id: Some(memory_id),
            superseded_ids,
            error_code: None,
        }
    }
    fn refused(code: &str) -> Self {
        Self {
            state: MemoryCurateState::Refused,
            memory_id: None,
            superseded_ids: vec![],
            error_code: Some(code.into()),
        }
    }
}

fn mcp_curate_result(text: String, receipt: MemoryCurateResult) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({
        "content": [{ "type": "text", "text": text }],
        "isError": receipt.state == MemoryCurateState::Refused,
        "structuredContent": receipt,
    }))
    .map_err(|error| error.to_string())
}

fn mcp_memory_result(text: String, is_error: bool, operation: Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
        "memory_operation": operation,
    }))
    .map_err(|error| error.to_string())
}

fn tool_error_result(message: impl Into<String>) -> HandlerOutcome {
    mcp_text_result(message.into(), true)
}

fn session_unresolved_error() -> HandlerOutcome {
    HandlerOutcome::Error {
        code: "session_unresolved".to_string(),
        message: SESSION_UNRESOLVED_MESSAGE.to_string(),
    }
}

fn capability_refusal_message(domain: &str) -> &'static str {
    match domain {
        "memories" => {
            "Memory writes are paused while the engine syncs. Retry in a moment. (MC-C01)"
        }
        "notes" => "Note changes are paused while the engine syncs. Retry in a moment. (MC-C03)",
        _ => CONTEXT_SERVICE_UNAVAILABLE_MESSAGE,
    }
}

fn invalid_params_error(message: impl Into<String>) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: "invalid_params".to_string(),
        message: message.into(),
    }
}

const MAX_FACADE_FRAME_BYTES: usize =
    subc_protocol::MAX_FRAME_BODY_LEN as usize - SUBC_FRAME_BODY_HEADROOM_BYTES;
/// Plugins size transform pages to the facade cap and the transport then appends a
/// few capability bytes (`accept_reply_pages`), so a full page can arrive slightly
/// over it. Transform-class frames get a 64 KiB allowance, still far inside the
/// 16 MiB headroom below the real subc frame limit; agent tool calls keep the cap.
const TRANSFORM_FRAME_ALLOWANCE_BYTES: usize = 64 * 1024;
const MAX_TRANSFORM_FRAME_BYTES: usize = MAX_FACADE_FRAME_BYTES + TRANSFORM_FRAME_ALLOWANCE_BYTES;

/// Minimal probe deserialized from an oversized body ONLY to pick the right byte
/// cap. serde ignores every other field, so this stays cheap relative to a full
/// Value parse of a multi-MiB array.
#[derive(Deserialize)]
struct RequestMethodProbe {
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    transform_page_index: Option<u64>,
    #[serde(default)]
    transform_page_total: Option<u64>,
    #[serde(default)]
    transform_page_id: Option<String>,
}

impl RequestMethodProbe {
    fn is_transform_class(&self) -> bool {
        let named = |value: &Option<String>, name: &str| value.as_deref() == Some(name);
        named(&self.kind, "transform")
            // Non-final transform pages carry the page envelope but not `kind`,
            // which travels with the scalar fields on the final page.
            || self.transform_page_id.is_some()
            // The retired `state_sync` route sent multi-MiB rows too. The wider cap
            // lets such a request reach its `transform_route_retired` answer by name.
            || named(&self.method, "state_sync")
    }
}

/// The facade byte budget exists for agent tool calls. Transform-class requests
/// carried a session's full message array (multi-MiB on large sessions); their
/// routes are retired, but they keep the wider cap so a stale host still gets the
/// named retirement answer rather than a size refusal. Method sniffing on raw bytes avoids
/// parsing multi-MiB JSON just to reject it.
fn enforce_request_byte_cap(body: &[u8]) -> Result<(), HandlerOutcome> {
    if body.len() <= MAX_FACADE_FRAME_BYTES {
        return Ok(());
    }
    let probe = serde_json::from_slice::<RequestMethodProbe>(body).ok();
    // Record only envelope metadata, never message or tool content. A late
    // transport field can overrun a page by just a few bytes; log the actual
    // received length and zero-based index to distinguish that from assembly.
    tracing::warn!(
        "mc-request-byte-cap refused bytes={} cap={} method={:?} kind={:?} session={:?} page_index={:?} page_total={:?}",
        body.len(), MAX_FACADE_FRAME_BYTES,
        probe.as_ref().and_then(|p| p.method.as_deref()),
        probe.as_ref().and_then(|p| p.kind.as_deref()),
        probe.as_ref().and_then(|p| p.session_id.as_deref()),
        probe.as_ref().and_then(|p| p.transform_page_index),
        probe.as_ref().and_then(|p| p.transform_page_total),
    );
    let transform_class = probe.is_some_and(|probe| probe.is_transform_class());
    if transform_class {
        if body.len() <= MAX_TRANSFORM_FRAME_BYTES {
            return Ok(());
        }
        return Err(invalid_params_error(
            "request body exceeds the 48 MiB transform limit",
        ));
    }
    Err(invalid_params_error(
        "request body exceeds the 48 MiB limit",
    ))
}
const MAX_AGENT_DROPS_COMMAND_ID_BYTES: usize = 128;
const MAX_MEMORY_CONTENT_BYTES: usize = 64 * 1024;
const MAX_NOTE_CONTENT_BYTES: usize = 64 * 1024;
const MAX_SHORT_FIELD_BYTES: usize = 4 * 1024;
const MAX_QUERY_BYTES: usize = 1024;
const MAX_MEMORY_IDS: usize = 100;
const CTX_EXPAND_BYTE_BUDGET: usize = 15_000 * 4;
const CTX_EXPAND_MAX_ORDINAL_SPAN: i64 = 10_000;
const CTX_EXPAND_MAX_ROWS: usize = 64;
const CTX_EXPAND_TRUNCATION_MARKER: &str = "\n\n[truncated at the ~15,000-token ctx_expand budget]";
/// Accepted write categories — the canonical V2 taxonomy, single-sourced from the
/// renderer's category order so the facade and the render path never disagree.
use crate::memory_render::MEMORY_CATEGORY_ORDER as MEMORY_CATEGORIES;

fn validate_string_cap(
    args: &Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<(), String> {
    if let Some(value) = args.get(key).and_then(Value::as_str) {
        if value.len() > max_bytes {
            return Err(format!("'{key}' exceeds the {max_bytes}-byte limit"));
        }
    }
    Ok(())
}

fn validate_memory_id_arguments(args: &Map<String, Value>, action: &str) -> Result<(), String> {
    // Validate only the identifier arguments used by the selected action. Some
    // callers populate every declared identifier field with placeholder values;
    // checking or combining unused fields could fail a valid call or select the
    // wrong record.
    let ids_len = args.get("ids").and_then(Value::as_array).map(Vec::len);
    let (scalar_keys, array_keys): (&[&str], &[&str]) = match action {
        "update" | "archive" | "get" if args.contains_key("ids") => (&[], &["ids"]),
        "update" | "archive" | "get" => (&["id"], &[]),
        "merge" if ids_len.is_some_and(|len| len >= 2) => (&[], &["ids"]),
        "merge" if args.contains_key("target_id") || args.contains_key("source_ids") => {
            (&["target_id"], &["source_ids"])
        }
        "merge" => (&["id"], &["ids"]),
        // write/list do not address memories; id-shaped placeholders are inert.
        _ => return Ok(()),
    };

    for key in scalar_keys {
        if let Some(value) = args.get(*key) {
            if value.as_i64().is_none_or(|id| id <= 0) {
                return Err(format!("'{key}' must be a positive 64-bit integer"));
            }
        }
    }
    for key in array_keys {
        if let Some(value) = args.get(*key) {
            let Some(values) = value.as_array() else {
                return Err(format!(
                    "'{key}' must be an array of positive 64-bit integers"
                ));
            };
            if values.len() > MAX_MEMORY_IDS {
                return Err(format!("'{key}' exceeds the {MAX_MEMORY_IDS}-item limit"));
            }
            if values
                .iter()
                .any(|value| value.as_i64().is_none_or(|id| id <= 0))
            {
                return Err(format!(
                    "'{key}' must contain only positive 64-bit integers"
                ));
            }
        }
    }
    if scalar_keys.contains(&"target_id") && array_keys.contains(&"source_ids") {
        if let (Some(target), Some(sources)) = (
            args.get("target_id").and_then(Value::as_i64),
            args.get("source_ids").and_then(Value::as_array),
        ) {
            if sources.iter().any(|source| source.as_i64() == Some(target)) {
                return Err("merge target must not appear in source_ids".to_string());
            }
        }
    }
    Ok(())
}

/// Recover the intended argument object when a model repeats the reduced-call
/// envelope it saw in context. Only unwrap when no real primary field is present,
/// so explicit tool arguments always take precedence.
fn facade_arguments(request: &Value, primary_fields: &[&str]) -> Option<Map<String, Value>> {
    let arguments = request.get("arguments")?.as_object()?;
    if primary_fields
        .iter()
        .any(|field| arguments.contains_key(*field))
        || arguments.get("reduced") != Some(&Value::Bool(true))
    {
        return Some(arguments.clone());
    }
    let Some(summary) = arguments.get("summary").and_then(Value::as_str) else {
        return Some(arguments.clone());
    };
    match serde_json::from_str::<Value>(summary) {
        Ok(Value::Object(unwrapped)) => Some(unwrapped),
        _ => Some(arguments.clone()),
    }
}

fn string_arg<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn non_empty_string_arg<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    string_arg(args, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn i64_arg(args: &Map<String, Value>, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn usize_arg(args: &Map<String, Value>, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn parse_search_date_bound(
    args: &Map<String, Value>,
    key: &str,
    end_of_day: bool,
) -> Result<Option<i64>, String> {
    let milliseconds_key = format!("{key}_ms");
    if let Some(value) = args.get(&milliseconds_key) {
        return value
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("Invalid '{milliseconds_key}' timestamp."));
    }
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    let Some(value) = value.as_str() else {
        return Err(format!(
            "Invalid '{key}' date; use YYYY-MM-DD or a full ISO datetime."
        ));
    };
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let start = date
            .and_hms_opt(0, 0, 0)
            .expect("midnight is valid")
            .and_utc()
            .timestamp_millis();
        return Ok(Some(if end_of_day {
            start + 24 * 60 * 60 * 1000 - 1
        } else {
            start
        }));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|date| Some(date.with_timezone(&Utc).timestamp_millis()))
        .map_err(|_| format!("Invalid '{key}' date; use YYYY-MM-DD or a full ISO datetime."))
}

#[derive(Debug, Clone, Copy)]
enum CtxExpandMode {
    Tag(i64),
    Message(i64),
    Range { start: i64, end: i64, verbose: bool },
}

fn resolve_ctx_expand_mode(args: &Map<String, Value>) -> Result<CtxExpandMode, String> {
    if let Some(value) = args.get("tag").filter(|value| !value.is_null()) {
        let filler = (value == &json!(0) || value == &json!(""))
            && (args.contains_key("message") || args.contains_key("start"));
        if !filler {
            let tag = normalize_tag_input(value)?;
            if ["message", "start", "end"].iter().any(|key| {
                args.get(*key)
                    .is_some_and(|value| !value.is_null() && value != &json!(0))
            }) {
                return Err("Error: use tag alone, without message or start/end.".to_string());
            }
            return Ok(CtxExpandMode::Tag(tag));
        }
    }
    let message = i64_arg(args, "message");
    let start = i64_arg(args, "start");
    let end = i64_arg(args, "end");
    let message_present = args.get("message").is_some();
    let message_valid = message.filter(|value| *value >= 0);
    let range_valid = match (start, end) {
        (Some(start), Some(end)) if start >= 0 && end >= start => Some((start, end)),
        _ => None,
    };
    let filler_pair = matches!((start, end), (Some(0), Some(0)));
    let range_named = range_valid.filter(|_| !filler_pair);

    if let Some(message) = message_valid {
        if range_named.is_none() {
            return Ok(CtxExpandMode::Message(message));
        }
    }
    if message_present && message_valid.is_none() && range_named.is_none() {
        return Err("Error: message must be a non-negative integer.".to_string());
    }
    if let Some((start, end)) = range_valid {
        return Ok(CtxExpandMode::Range {
            start,
            end,
            verbose: args.get("verbose").and_then(Value::as_bool) == Some(true),
        });
    }
    Err(
        "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end)."
            .to_string(),
    )
}

#[derive(Debug, Clone, Copy)]
struct FacadeSearchSources {
    memory: bool,
    message: bool,
    note: bool,
}

fn facade_search_sources(args: &Map<String, Value>) -> FacadeSearchSources {
    let Some(values) = args.get("sources") else {
        return FacadeSearchSources {
            memory: true,
            message: true,
            note: true,
        };
    };
    let Some(values) = values.as_array() else {
        return FacadeSearchSources {
            memory: true,
            message: true,
            note: true,
        };
    };
    if values.is_empty() {
        return FacadeSearchSources {
            memory: true,
            message: true,
            note: true,
        };
    }
    FacadeSearchSources {
        memory: values.iter().any(|value| value.as_str() == Some("memory")),
        message: values.iter().any(|value| value.as_str() == Some("message")),
        note: values.iter().any(|value| value.as_str() == Some("note")),
    }
}

fn parse_search_memory_ids(query: &str) -> Option<Vec<i64>> {
    const MAX_IDS: usize = 5;
    let tokens = query.trim().split(',').map(str::trim).collect::<Vec<_>>();
    if tokens.is_empty() || tokens.len() > MAX_IDS {
        return None;
    }
    let mut ids = Vec::with_capacity(tokens.len());
    for token in tokens {
        let digits = token.strip_prefix('#').unwrap_or(token);
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let id = digits.parse::<i64>().ok().filter(|id| *id > 0)?;
        ids.push(id);
    }
    Some(ids)
}

fn format_search_age(created_at_ms: i64) -> String {
    let now_ms = now_ms();
    if created_at_ms > now_ms {
        return "future".to_string();
    }
    let age_ms = now_ms - created_at_ms;
    let days = age_ms / (24 * 60 * 60 * 1_000);
    if days <= 0 {
        return "today".to_string();
    }
    if days == 1 {
        return "1d ago".to_string();
    }
    if days < 30 {
        return format!("{days}d ago");
    }
    let months = days / 30;
    if months == 1 {
        return "1mo ago".to_string();
    }
    if months < 12 {
        return format!("{months}mo ago");
    }
    let years = days / 365;
    if years == 1 {
        "1y ago".to_string()
    } else {
        format!("{years}y ago")
    }
}

fn render_facade_search_results(
    query: &str,
    results: &[memory_tool::MemorySearchResult],
    diagnostics: &memory_tool::MemorySearchDiagnostics,
    current_session_id: &str,
    workspace_membership: Option<&mc_store::WorkspaceMembership>,
) -> String {
    let visible_ids = &diagnostics.suppressed_visible_memory_ids;
    if results.is_empty() {
        if !visible_ids.is_empty() {
            let count = visible_ids.len();
            let noun = if count == 1 { "match" } else { "matches" };
            return format!(
                "No hidden results found for \"{query}\".\n\nMemories: {count} {noun} found, all already visible in your project-memory block (ids {}).",
                join_i64s(visible_ids)
            );
        }
        return format!(
            "No results found for \"{query}\" across notes, memories, primers, git commits, or message history."
        );
    }

    let mut body = Vec::with_capacity(results.len() + 3);
    for (index, result) in results.iter().enumerate() {
        let score = result.score_hundredths as f64 / 100.0;
        let rendered = match result.source_kind {
            memory_tool::MemorySearchSourceKind::Memory => {
                let source = workspace_membership
                    .and_then(|membership| {
                        result
                            .source_project_path
                            .as_deref()
                            .filter(|path| *path != membership.own_identity)
                            .and_then(|path| membership.display_name_by_path.get(path))
                    })
                    .map(|name| format!(" source={name}"))
                    .unwrap_or_default();
                format!(
                    "[{}] [memory] score={score:.2} id={} category={}{} match=fts\n{}",
                    index + 1,
                    result.id,
                    result.category.as_deref().unwrap_or("uncategorized"),
                    source,
                    result.snippet,
                )
            }
            memory_tool::MemorySearchSourceKind::CompartmentTitle
            | memory_tool::MemorySearchSourceKind::CompartmentBody => format!(
                "[{}] [message] score={score:.2} compartment_id={} range={}-{} match=fts title={}\nSnippet: {}",
                index + 1,
                result.id,
                result.start_ordinal.unwrap_or_default(),
                result.end_ordinal.unwrap_or_default(),
                result.title.as_deref().unwrap_or(""),
                result.snippet,
            ),
            memory_tool::MemorySearchSourceKind::Note => {
                let anchor = match (result.note_anchor_ordinal, result.note_session_id.as_deref()) {
                    (Some(ordinal), Some(session_id)) if session_id == current_session_id => {
                        format!(" @msg {ordinal}")
                    }
                    _ => String::new(),
                };
                format!(
                    "[{}] [note] score={score:.2} id=#{} status={} {}{anchor}\n{}",
                    index + 1,
                    result.id,
                    result.note_status.as_deref().unwrap_or("active"),
                    format_search_age(result.note_created_at_ms.unwrap_or_default()),
                    result.snippet,
                )
            }
        };
        body.push(rendered);
    }
    if !visible_ids.is_empty() {
        let count = visible_ids.len();
        let noun = if count == 1 { "match" } else { "matches" };
        let pronoun = if count == 1 { "it is" } else { "they are" };
        body.push(format!(
            "Memories: {count} additional {noun} suppressed because {pronoun} already visible in your project-memory block (ids {}).",
            join_i64s(visible_ids)
        ));
    }
    if results.iter().any(|result| {
        matches!(
            result.source_kind,
            memory_tool::MemorySearchSourceKind::CompartmentTitle
                | memory_tool::MemorySearchSourceKind::CompartmentBody
        )
    }) {
        body.push(
            "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context."
                .to_string(),
        );
    }
    if results.iter().any(|result| {
        result.source_kind == memory_tool::MemorySearchSourceKind::Note
            && result.note_anchor_ordinal.is_some()
            && result.note_session_id.as_deref() == Some(current_session_id)
    }) {
        body.push(
            "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context."
                .to_string(),
        );
    }
    format!(
        "Found {} result{} for \"{query}\":\n\n{}",
        results.len(),
        if results.len() == 1 { "" } else { "s" },
        body.join("\n\n")
    )
}

fn truncate_expand_output(mut output: String) -> String {
    if output.len() <= CTX_EXPAND_BYTE_BUDGET {
        return output;
    }
    let mut boundary = CTX_EXPAND_BYTE_BUDGET.saturating_sub(CTX_EXPAND_TRUNCATION_MARKER.len());
    while !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    output.push_str(CTX_EXPAND_TRUNCATION_MARKER);
    output
}

fn append_expand_piece(output: &mut String, piece: &str) -> bool {
    if output.len().saturating_add(piece.len()) <= CTX_EXPAND_BYTE_BUDGET {
        output.push_str(piece);
        return true;
    }
    let available = CTX_EXPAND_BYTE_BUDGET.saturating_sub(
        output
            .len()
            .saturating_add(CTX_EXPAND_TRUNCATION_MARKER.len()),
    );
    let mut boundary = piece.len().min(available);
    while !piece.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.push_str(&piece[..boundary]);
    output.push_str(CTX_EXPAND_TRUNCATION_MARKER);
    false
}

fn append_expand_line(output: &mut String, line: &str) -> bool {
    append_expand_piece(output, line) && append_expand_piece(output, "\n")
}

fn render_message_expand(row: StoredChunkTranscript, message: i64) -> String {
    let mut lines = vec![
        format!(
            "Message {message} is covered by compartment {} ({}-{}).",
            row.compartment_seq, row.start_ordinal, row.end_ordinal
        ),
        "This Claude Code leg can recover the historian chunk-builder view, not full raw messages; tool calls may be summarized and long text may have been truncated before summarization.".to_string(),
        String::new(),
        format!(
            "### Compartment {} ({}-{})",
            row.compartment_seq, row.start_ordinal, row.end_ordinal
        ),
    ];
    lines.push(row.transcript.unwrap_or_else(|| {
        "[no longer recoverable: transcript bytes could not be decompressed]".to_string()
    }));
    truncate_expand_output(lines.join("\n"))
}

fn expand_recovery_tool_title<'a>(
    message: &'a ck_wire::CkIngressMessage,
    call_id: &str,
) -> Option<&'a str> {
    message
        .ck
        .provider_extras
        .get("opencode")?
        .get("ctx_expand_tool_titles")?
        .as_object()?
        .get(call_id)?
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
}

fn paired_expand_tool<'a>(
    call: &'a ck_wire::CkWireBlock,
    result: Option<&'a ck_wire::CkWireBlock>,
) -> Option<(&'a str, &'a str, &'a Value, &'a ck_wire::CkToolOutput)> {
    let ck_wire::CkKind::ToolCall {
        id, name, input, ..
    } = &call.kind
    else {
        return None;
    };
    let ck_wire::CkKind::ToolResult {
        id: result_id,
        output,
        ..
    } = &result?.kind
    else {
        return None;
    };
    (id == result_id).then_some((name.as_str(), id.as_str(), input, output))
}

fn expand_file_label(filename: Option<&str>) -> String {
    filename.map_or_else(|| "  [file]".to_string(), |name| format!("  [file] {name}"))
}

fn render_cached_expand_part(part: &ck_wire::CkWireBlock) -> Option<String> {
    match &part.kind {
        ck_wire::CkKind::Text { text } if !text.trim().is_empty() => {
            Some(format!("  [text]\n{text}"))
        }
        ck_wire::CkKind::ToolCall {
            id, name, input, ..
        } => Some(format!("  [tool: {name} #{id}]\n  input: {input}")),
        ck_wire::CkKind::ToolResult {
            id,
            tool_name,
            output,
            ..
        } => Some(format!(
            "  [tool: {tool_name} #{id}]\n  output:\n{}",
            expand_tool_output_text(output)
        )),
        ck_wire::CkKind::Media(media) => Some(expand_file_label(media.filename.as_deref())),
        ck_wire::CkKind::Opaque(opaque) if opaque.kind == "file" => Some(expand_file_label(
            opaque
                .raw
                .get("filename")
                .or_else(|| opaque.raw.get("url"))
                .and_then(Value::as_str),
        )),
        ck_wire::CkKind::Text { .. }
        | ck_wire::CkKind::Reasoning { .. }
        | ck_wire::CkKind::RedactedReasoning { .. }
        | ck_wire::CkKind::Opaque(_) => None,
    }
}

fn ctx_reduce_ack_details(unknown: &[u64]) -> String {
    let mut details = Vec::new();
    if !unknown.is_empty() {
        details.push(format!(
            "tags {} not found",
            format_plain_tag_numbers(unknown)
        ));
    }
    details.join("; ")
}

/// Render one CK message reconstructed from a durable chunk transcript's raw-message
/// payload. When that payload is missing or undecodable, `ctx_expand` falls back to the
/// compacted transcript text instead.
fn render_cached_message_expand(message: &ck_wire::CkIngressMessage) -> String {
    let role = match message.ck.role.as_str() {
        "assistant" => "A (assistant)",
        "user" => "U (user)",
        role => role,
    };
    let mut parts = Vec::new();
    let mut index = 0;
    while let Some(part) = message.ck.content.get(index) {
        if let Some((name, id, input, output)) =
            paired_expand_tool(part, message.ck.content.get(index + 1))
        {
            let mut rendered = format!("  [tool: {name} #{id}]");
            if let Some(title) = expand_recovery_tool_title(message, id) {
                rendered.push_str(&format!("\n  description: {title}"));
            }
            rendered.push_str(&format!(
                "\n  input: {input}\n  output:\n{}",
                expand_tool_output_text(output)
            ));
            parts.push(rendered);
            index += 2;
            continue;
        }
        if let Some(rendered) = render_cached_expand_part(part) {
            parts.push(rendered);
        }
        index += 1;
    }
    let mut lines = vec![
        format!("[{}] {role} — full recovery:", message.ordinal),
        String::new(),
    ];
    if parts.is_empty() {
        lines.push(
            "  (no recoverable content — message had only structural/reasoning parts)".to_string(),
        );
    } else {
        lines.extend(parts);
    }
    lines.join("\n")
}

fn ctx_reduce_reply(stamped_count: usize, self_stamp_count: usize) -> String {
    let mut parts = Vec::new();
    if stamped_count > 0 {
        parts.push(format!(
            "{stamped_count} tag{} stamped.",
            if stamped_count == 1 { "" } else { "s" }
        ));
    }
    if self_stamp_count > 0 {
        parts.push(if self_stamp_count == 1 {
            "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.".to_owned()
        } else {
            format!("{self_stamp_count} were ctx_reduce calls; leave those alone, they are cleaned up automatically.")
        });
    }
    parts.join(" ")
}

fn format_plain_tag_numbers(numbers: &[u64]) -> String {
    numbers
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn render_range_expand(
    start: i64,
    end: i64,
    compartments: &[StoredCompartment],
    transcripts: &[StoredChunkTranscript],
) -> String {
    let mut matching = compartments
        .iter()
        .filter(|comp| comp.end_message >= start && comp.start_message <= end)
        .collect::<Vec<_>>();
    matching.sort_by_key(|comp| comp.sequence);
    if matching.is_empty() {
        return format!(
            "No compacted compartments found in range {start}-{end}. The range may be live tail, outside this session's history, or compacted before transcript capture."
        );
    }

    let durable_messages = durable_expand_messages(transcripts);
    if !durable_messages.is_empty() {
        return render_durable_range_expand(start, end, &durable_messages);
    }

    let mut output = format!("Messages {start}-{end} from persisted historian chunk transcripts:");
    for compartment in matching {
        if !append_expand_piece(&mut output, "\n\n")
            || !append_expand_line(
                &mut output,
                &format!(
                    "### Compartment {} ({}-{})",
                    compartment.sequence, compartment.start_message, compartment.end_message
                ),
            )
        {
            break;
        }
        let transcript = transcripts
            .iter()
            .find(|row| row.compartment_seq == compartment.sequence)
            .and_then(|row| row.transcript.as_deref())
            .map(|transcript| slice_expand_transcript(transcript, start, end))
            .filter(|transcript| !transcript.is_empty())
            .unwrap_or(
                "[no longer recoverable: this compartment transcript was evicted, was not recorded, or only covered ordinals outside the requested range]".to_string(),
            );
        if !append_expand_piece(&mut output, &transcript) {
            break;
        }
    }
    truncate_expand_output(output)
}

/// Decode original messages copied into every durable transcript row. A historian publish can
/// produce several compartments, so ordinal de-duplication restores one chronological message
/// sequence for range, verbose, and full-message recovery.
fn durable_expand_messages(
    transcripts: &[StoredChunkTranscript],
) -> Vec<ck_wire::CkIngressMessage> {
    let mut messages = BTreeMap::new();
    for transcript in transcripts {
        let Some(raw_messages) = transcript.raw_messages_json.as_deref() else {
            continue;
        };
        let Ok(raw_messages) = serde_json::from_str::<Vec<ck_wire::CkIngressMessage>>(raw_messages)
        else {
            continue;
        };
        for message in raw_messages {
            let Ok(ordinal) = i64::try_from(message.ordinal) else {
                continue;
            };
            if ordinal >= transcript.start_ordinal && ordinal <= transcript.end_ordinal {
                messages.entry(message.ordinal).or_insert(message);
            }
        }
    }
    messages.into_values().collect()
}

fn render_durable_range_expand(
    start: i64,
    end: i64,
    messages: &[ck_wire::CkIngressMessage],
) -> String {
    let messages = messages
        .iter()
        .filter(|message| {
            let ordinal = i64::try_from(message.ordinal).unwrap_or(i64::MAX);
            ordinal >= start && ordinal <= end
        })
        .collect::<Vec<_>>();
    let Some(first) = messages.first() else {
        return format!(
            "No messages found in range {start}-{end}. The range may be outside this session's persisted historian transcripts."
        );
    };
    let last = messages.last().expect("nonempty checked above");
    let mut output = format!(
        "Messages {}-{} from persisted raw message history:",
        first.ordinal, last.ordinal
    );
    for message in messages {
        if !append_expand_piece(&mut output, "\n\n")
            || !append_expand_piece(&mut output, &render_durable_range_message(message))
        {
            break;
        }
    }
    truncate_expand_output(output)
}

fn render_durable_range_message(message: &ck_wire::CkIngressMessage) -> String {
    let role = match message.ck.role.as_str() {
        "assistant" => "A",
        "user" => "U",
        role => role,
    };
    let parts = message
        .ck
        .content
        .iter()
        .filter_map(render_durable_range_part)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        format!("[{}] {role}:", message.ordinal)
    } else {
        format!("[{}] {role}: {}", message.ordinal, parts.join(" / "))
    }
}

fn render_durable_range_part(part: &ck_wire::CkWireBlock) -> Option<String> {
    match &part.kind {
        ck_wire::CkKind::Text { text } => {
            (!text.trim().is_empty()).then(|| text.trim().to_string())
        }
        ck_wire::CkKind::ToolCall { name, input, .. } => {
            let argument = verbose_expand_key_argument(input);
            Some(if argument.is_empty() {
                format!("TC: {name}")
            } else {
                format!("TC: {name}({argument})")
            })
        }
        ck_wire::CkKind::ToolResult {
            tool_name, output, ..
        } => Some(format!(
            "TR: {tool_name} → output ~{} tok",
            mc_tokenizer::estimate_tokens(&expand_tool_output_text(output))
        )),
        ck_wire::CkKind::Media(_) => Some("[media]".to_string()),
        ck_wire::CkKind::Reasoning { .. }
        | ck_wire::CkKind::RedactedReasoning { .. }
        | ck_wire::CkKind::Opaque(_) => None,
    }
}

fn slice_expand_transcript(transcript: &str, start: i64, end: i64) -> String {
    transcript
        .lines()
        .filter_map(|line| {
            let (span, _) = line.strip_prefix('[')?.split_once("] ")?;
            let (span_start, span_end) = parse_expand_ordinal_span(span)?;
            let clipped_start = span_start.max(start);
            let clipped_end = span_end.min(end);
            (clipped_start <= clipped_end).then(|| {
                if clipped_start == span_start && clipped_end == span_end {
                    line.to_string()
                } else if clipped_start == clipped_end {
                    format!(
                        "[{clipped_start}] [historian transcript coalesced across ordinals {span_start}-{span_end}; exact raw payload unavailable]"
                    )
                } else {
                    format!(
                        "[{clipped_start}-{clipped_end}] [historian transcript coalesced across ordinals {span_start}-{span_end}; exact raw payload unavailable]"
                    )
                }
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const CTX_EXPAND_VERBOSE_TOKEN_BUDGET: usize = 15_000;
const CTX_EXPAND_VERBOSE_TEXT_PREVIEW_CHARS: usize = 200;
const CTX_EXPAND_VERBOSE_REASONING_PREVIEW_CHARS: usize = 120;
const CTX_EXPAND_VERBOSE_ARGUMENT_PREVIEW_CHARS: usize = 60;

struct VerboseRangeExpand {
    text: String,
    last_ordinal: i64,
    truncated: bool,
}

/// Render each raw CK message separately, retaining only bounded previews. The in-process
/// snapshot and durable historian payload carry the same pre-reduction parts, including tool
/// outputs; the default range view remains condensed while verbose exposes those previews.
fn render_verbose_range_expand(
    messages: &[ck_wire::CkIngressMessage],
    start: i64,
    end: i64,
) -> VerboseRangeExpand {
    render_verbose_range_expand_with_budget(messages, start, end, CTX_EXPAND_VERBOSE_TOKEN_BUDGET)
}

fn render_verbose_range_expand_with_budget(
    messages: &[ck_wire::CkIngressMessage],
    start: i64,
    end: i64,
    token_budget: usize,
) -> VerboseRangeExpand {
    let mut output = Vec::new();
    let mut used_tokens = 0;
    let mut last_ordinal = start.saturating_sub(1);
    let mut truncated = false;
    for message in messages.iter().filter(|message| {
        let ordinal = i64::try_from(message.ordinal).unwrap_or(i64::MAX);
        ordinal >= start && ordinal <= end
    }) {
        let block = render_verbose_expand_message(message);
        let block_tokens = mc_tokenizer::estimate_tokens(&block);
        if used_tokens + block_tokens > token_budget && !output.is_empty() {
            truncated = true;
            break;
        }
        used_tokens += block_tokens;
        last_ordinal = i64::try_from(message.ordinal).unwrap_or(i64::MAX);
        output.push(block);
    }
    VerboseRangeExpand {
        text: output.join("\n\n"),
        last_ordinal,
        truncated,
    }
}

fn render_verbose_expand_result(start: i64, end: i64, result: VerboseRangeExpand) -> String {
    let mut output = format!(
        "Messages {start}-{} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):\n\n{}",
        result.last_ordinal, result.text
    );
    if result.truncated {
        output.push_str(&format!(
            "\n\nTruncated at message {} (budget: ~{CTX_EXPAND_VERBOSE_TOKEN_BUDGET} tokens). Call again with start={} end={end} verbose=true for more.",
            result.last_ordinal,
            result.last_ordinal.saturating_add(1),
        ));
    }
    output
}

fn render_verbose_expand_message(message: &ck_wire::CkIngressMessage) -> String {
    let role = if matches!(message.ck.role.as_str(), "user" | "tool")
        && !message.ck.content.is_empty()
        && message
            .ck
            .content
            .iter()
            .all(|part| matches!(part.kind, ck_wire::CkKind::ToolResult { .. }))
    {
        "tool results"
    } else {
        match message.ck.role.as_str() {
            "assistant" => "A (assistant)",
            "user" => "U (user)",
            role => role,
        }
    };
    let mut previews = Vec::new();
    let mut index = 0;
    while let Some(part) = message.ck.content.get(index) {
        if let Some((name, _id, input, output)) =
            paired_expand_tool(part, message.ck.content.get(index + 1))
        {
            let argument = verbose_expand_key_argument(input);
            let head = if argument.is_empty() {
                name.to_string()
            } else {
                format!("{name}({argument})")
            };
            previews.push(format!(
                "    • tool {head} → output ~{} tok",
                mc_tokenizer::estimate_tokens(&expand_tool_output_text(output))
            ));
            index += 2;
            continue;
        }
        if let Some(rendered) = render_verbose_expand_part(part) {
            previews.push(rendered);
        }
        index += 1;
    }
    if previews.is_empty() {
        format!("[{}] {role}", message.ordinal)
    } else {
        format!("[{}] {role}\n{}", message.ordinal, previews.join("\n"))
    }
}

fn render_verbose_expand_part(part: &ck_wire::CkWireBlock) -> Option<String> {
    match &part.kind {
        ck_wire::CkKind::Text { text } => {
            let preview = truncate_expand_preview(text, CTX_EXPAND_VERBOSE_TEXT_PREVIEW_CHARS);
            (!preview.is_empty()).then(|| format!("    • {preview}"))
        }
        ck_wire::CkKind::ToolCall { name, input, .. } => {
            let argument = verbose_expand_key_argument(input);
            let head = if argument.is_empty() {
                name.to_string()
            } else {
                format!("{name}({argument})")
            };
            Some(format!("    • tool {head}"))
        }
        ck_wire::CkKind::ToolResult {
            tool_name, output, ..
        } => Some(format!(
            "    • tool {tool_name} → output ~{} tok",
            mc_tokenizer::estimate_tokens(&expand_tool_output_text(output))
        )),
        ck_wire::CkKind::Reasoning { text, .. } => Some(format!(
            "    • [reasoning] {}",
            truncate_expand_preview(text, CTX_EXPAND_VERBOSE_REASONING_PREVIEW_CHARS)
        )),
        ck_wire::CkKind::Media(_) => Some("    • [file]".to_string()),
        ck_wire::CkKind::RedactedReasoning { .. } => Some("    • [redacted_reasoning]".to_string()),
        ck_wire::CkKind::Opaque(opaque)
            if opaque.kind == "step-start" || opaque.kind == "step-finish" =>
        {
            None
        }
        ck_wire::CkKind::Opaque(opaque) => Some(format!("    • [{}]", opaque.kind)),
    }
}

fn verbose_expand_key_argument(input: &Value) -> String {
    let Some(input) = input.as_object() else {
        return String::new();
    };
    for key in [
        "filePath",
        "path",
        "pattern",
        "query",
        "symbol",
        "module",
        "action",
        "description",
    ] {
        if let Some(value) = input
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return truncate_expand_preview(value, CTX_EXPAND_VERBOSE_ARGUMENT_PREVIEW_CHARS);
        }
    }
    String::new()
}

fn expand_tool_output_text(output: &ck_wire::CkToolOutput) -> String {
    match &output.kind {
        ck_wire::CkOutputKind::Text { text } | ck_wire::CkOutputKind::ErrorText { text } => {
            text.clone()
        }
        ck_wire::CkOutputKind::Json { value } | ck_wire::CkOutputKind::ErrorJson { value } => {
            value.to_string()
        }
        ck_wire::CkOutputKind::ExecutionDenied { reason } => reason.clone().unwrap_or_default(),
        ck_wire::CkOutputKind::Content { blocks }
        | ck_wire::CkOutputKind::ErrorContent { blocks } => {
            serde_json::to_string(blocks).unwrap_or_default()
        }
    }
}

/// The durable fallback predates raw CK snapshot retention. It cannot reconstruct every
/// part or tool-output size, but it keeps historical transcript recovery available after
/// a module restart or cache eviction.
fn render_verbose_transcript_range_expand(
    start: i64,
    end: i64,
    transcripts: &[StoredChunkTranscript],
) -> String {
    let mut entries = Vec::new();
    for transcript in transcripts {
        let Some(transcript) = transcript.transcript.as_deref() else {
            continue;
        };
        for line in transcript.lines() {
            let Some((span, role_and_content)) = line
                .strip_prefix('[')
                .and_then(|line| line.split_once("] "))
            else {
                continue;
            };
            let Some((role, content)) = role_and_content.split_once(": ") else {
                continue;
            };
            let Some((span_start, span_end)) = parse_expand_ordinal_span(span) else {
                continue;
            };
            for ordinal in span_start.max(start)..=span_end.min(end) {
                entries.push((ordinal, role, content, span_start, span_end));
            }
        }
    }
    entries.sort_by_key(|(ordinal, ..)| *ordinal);
    entries.dedup_by_key(|(ordinal, ..)| *ordinal);
    if entries.is_empty() {
        return format!(
            "No messages found in range {start}-{end}. The range may be outside this session's persisted historian transcripts."
        );
    }

    let last_ordinal = entries
        .last()
        .map(|(ordinal, ..)| *ordinal)
        .unwrap_or(start);
    let mut output = format!(
        "Messages {start}-{last_ordinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):"
    );
    for (ordinal, role, content, span_start, span_end) in entries {
        let label = match role {
            "U" => "U (user)",
            "A" => "A (assistant)",
            _ => role,
        };
        let mut preview = truncate_expand_preview(content, CTX_EXPAND_VERBOSE_TEXT_PREVIEW_CHARS);
        if span_start != span_end {
            preview = format!("[historian span {span_start}-{span_end}] {preview}");
        }
        let part = if let Some(tool) = preview.strip_prefix("TC: ") {
            format!("    • tool {tool}")
        } else {
            format!("    • {preview}")
        };
        if !append_expand_piece(&mut output, "\n\n")
            || !append_expand_line(&mut output, &format!("[{ordinal}] {label}"))
            || !append_expand_piece(&mut output, &part)
        {
            break;
        }
    }
    truncate_expand_output(output)
}

fn parse_expand_ordinal_span(span: &str) -> Option<(i64, i64)> {
    let (start, end) = match span.split_once('-') {
        Some((start, end)) => (start.parse().ok()?, end.parse().ok()?),
        None => {
            let ordinal = span.parse().ok()?;
            (ordinal, ordinal)
        }
    };
    (start >= 0 && end >= start).then_some((start, end))
}

/// Mirrors TypeScript's `trim().slice(0, max)` preview rule in UTF-16 units.
fn truncate_expand_preview(value: &str, max_units: usize) -> String {
    let value = value.trim();
    let units = value.encode_utf16().collect::<Vec<_>>();
    if units.len() <= max_units {
        return value.to_string();
    }
    format!("{}…", String::from_utf16_lossy(&units[..max_units]))
}

/// Title clip for a glance row. Mirrors `GLANCE_TITLE_MAX` in
/// `packages/plugin/src/tools/ctx-note/render.ts`.
const GLANCE_TITLE_MAX: usize = 80;
/// A note untouched for this long is marked stale in the glance.
const STALE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The reply for a read that has nothing to show.
const EMPTY_READ_REPLY: &str = "## Notes\n\nNo session notes or smart notes.";

/// The timestamp a note's age is measured from: its last update, or its
/// creation when it has never been updated.
fn note_touched_at(note: &StoredNote) -> i64 {
    if note.updated_at_ms > 0 {
        note.updated_at_ms
    } else {
        note.created_at_ms
    }
}

/// Compact age: `5m`, `3h`, `2d`, `6w`.
fn format_note_age(touched_at: i64, now_ms: i64) -> String {
    let elapsed = (now_ms - touched_at).max(0);
    let minutes = elapsed / 60_000;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = elapsed / 3_600_000;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = elapsed / 86_400_000;
    if days < 7 {
        return format!("{days}d");
    }
    format!("{}w", days / 7)
}

/// First line of the note content, clipped to `max` characters with `…`.
/// Counts Unicode scalar values, matching the TypeScript renderer's
/// `[...firstLine]` spread.
fn clip_note_title(content: &str, max: usize) -> String {
    let first_line = content.lines().next().unwrap_or("").trim();
    let characters = first_line.chars().collect::<Vec<_>>();
    if characters.len() <= max {
        return first_line.to_string();
    }
    format!("{}…", characters[..max].iter().collect::<String>())
}

/// The status vocabulary the agent sees. `surfacing`/`surfaced` are module
/// delivery states from an earlier design; the host read model already shows them
/// as `ready`, and so must every ctx_note reply, or the reminder and the reply
/// would disagree about the same note.
fn present_note_status(mut note: StoredNote) -> StoredNote {
    if matches!(note.status.as_str(), "surfacing" | "surfaced") {
        note.status = "ready".to_string();
    }
    note
}

/// Refuse the retired host note-id lane. Every note id is a `context.db` id now.
fn refuse_retired_note_id_lane(args: &Map<String, Value>) -> Result<(), String> {
    match string_arg(args, "note_id_lane") {
        None | Some("module") => {}
        Some(_) => {
            return Err(
                "note_id_lane is retired: note ids are context.db ids; send them as is".to_string(),
            )
        }
    }
    for retired in ["note_id_map", "pending_note_ids"] {
        if args.get(retired).is_some() {
            return Err(format!(
                "{retired} is retired: note ids are context.db ids; send them as is"
            ));
        }
    }
    Ok(())
}

/// One glance row: `#id · age · title`, plus `· <status>` for anything that is
/// not active and `· stale` when the note has not been touched for 30 days.
fn format_glance_row(note: &StoredNote, now_ms: i64) -> String {
    let touched_at = note_touched_at(note);
    let mut markers: Vec<&str> = Vec::new();
    if note.status != "active" {
        markers.push(note.status.as_str());
    }
    let parked;
    if note.type_name == "smart"
        && note.status == "pending"
        && note.check_status.as_deref() == Some("parked")
    {
        parked = format!(
            "parked: {}",
            note.ready_reason
                .as_deref()
                .unwrap_or("Condition can't be checked")
        );
        markers.push(parked.as_str());
    }
    if now_ms - touched_at >= STALE_AFTER_MS {
        markers.push("stale");
    }
    let suffix = if markers.is_empty() {
        String::new()
    } else {
        format!(" · {}", markers.join(" · "))
    };
    format!(
        "#{} · {} · {}{}",
        note.id,
        format_note_age(touched_at, now_ms),
        clip_note_title(&note.content, GLANCE_TITLE_MAX),
        suffix
    )
}

/// Glance order: ready smart notes first, then pending smart notes, then every
/// other status — each group newest first.
fn order_glance_notes(mut notes: Vec<StoredNote>) -> Vec<StoredNote> {
    notes.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(right.id.cmp(&left.id))
    });
    let mut ready = Vec::new();
    let mut pending = Vec::new();
    let mut rest = Vec::new();
    for note in notes {
        match note.status.as_str() {
            "ready" => ready.push(note),
            "pending" => pending.push(note),
            _ => rest.push(note),
        }
    }
    ready.extend(pending);
    ready.extend(rest);
    ready
}

/// The whole glance: one row per note, then the one-line paging footer.
fn render_glance(notes: Vec<StoredNote>, limit: usize, offset: usize, now_ms: i64) -> String {
    let ordered = order_glance_notes(notes);
    let total = ordered.len();
    let page = ordered
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    if page.is_empty() {
        return EMPTY_READ_REPLY.to_string();
    }
    let rows = page
        .iter()
        .map(|note| format_glance_row(note, now_ms))
        .collect::<Vec<_>>()
        .join("\n");
    let remaining = total.saturating_sub(offset.saturating_add(page.len()));
    let footer = if remaining > 0 {
        format!(
            "\n\nShowing {} of {total} — {remaining} older: ctx_note(action=\"read\", offset={})",
            page.len(),
            offset.saturating_add(page.len())
        )
    } else {
        String::new()
    };
    format!("## Notes\n\n{rows}{footer}")
}

/// Full body for one note in the bodies-by-id view: `#id`, age, status, the
/// content, and the `↳ @msg N` anchor when the note carries one. Smart notes
/// also carry the condition that parked them.
fn format_note_body(note: &StoredNote, now_ms: i64) -> String {
    let touched_at = note_touched_at(note);
    let anchor = note
        .anchor_ordinal
        .map(|ordinal| format!(" ↳ @msg {ordinal}"))
        .unwrap_or_default();
    let head = format!(
        "- **#{}** · {} · {}: {}{}",
        note.id,
        format_note_age(touched_at, now_ms),
        note.status,
        note.content,
        anchor
    );
    if note.type_name != "smart" {
        return head;
    }
    let condition = if note.status == "ready" {
        note.ready_reason
            .as_deref()
            .or(note.surface_condition.as_deref())
            .unwrap_or("Condition satisfied")
    } else {
        note.surface_condition
            .as_deref()
            .unwrap_or("No condition recorded")
    };
    let failure = if note.status == "pending" {
        note.ready_reason
            .as_deref()
            .filter(|reason| reason.starts_with("Condition can't be checked:"))
            .map(|reason| format!("\n  {reason}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    format!(
        "{head}\n  {}: {condition}{failure}",
        if note.status == "ready" {
            "Condition met"
        } else {
            "Condition"
        }
    )
}

/// One requested id in the bodies-by-id view.
enum NoteByIdRow {
    Found(Box<StoredNote>),
    /// Unknown, or owned by someone else: one text for both.
    Missing,
}

/// Bodies-by-id view. Ids that are unknown or owned by someone else render the
/// same `not_found` line, so the reply never discloses whether an inaccessible
/// note exists. `note_id` is the id the caller asked for, in the caller's id space.
fn render_notes_by_id(notes: Vec<(i64, NoteByIdRow)>, now_ms: i64) -> String {
    format!(
        "## Notes by ID\n\n{}",
        notes
            .into_iter()
            .map(|(note_id, row)| match row {
                NoteByIdRow::Found(note) => format_note_body(&note, now_ms),
                NoteByIdRow::Missing => format!("- Note #{note_id}: not_found"),
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    )
}

/// The anchor hint and dismiss footer every read reply ends with. The hint is
/// only shown when at least one note carries an anchor, so notes written before
/// anchoring don't advertise a capability their output doesn't show. Mirrors
/// the TypeScript renderer's read tail.
fn finish_read_reply(body: String) -> String {
    if body == EMPTY_READ_REPLY {
        return body;
    }
    let anchor_hint = if body.contains("↳ @msg ") {
        "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
    } else {
        ""
    };
    format!(
        "{body}{anchor_hint}\n\nTo dismiss a stale note: ctx_note(action=\"dismiss\", note_ids=[N])"
    )
}

/// The write reply: the saved-note line plus the tray line, so the writer sees
/// the backlog at the moment they add to it.
fn format_write_reply(note_id: i64, tray: (usize, Option<i64>), now_ms: i64) -> String {
    let base = format!("Saved session note #{note_id}.");
    match tray {
        (count, Some(oldest)) if count > 0 => {
            format!(
                "{base} {count} active, oldest {}.",
                format_note_age(oldest, now_ms)
            )
        }
        _ => base,
    }
}

// The facade never panics on agent input; an absent or malformed id stays a typed tool error.
fn single_memory_id(args: &Map<String, Value>, action: &str) -> Option<i64> {
    let ids = memory_ids(args, action);
    ids.first().copied().filter(|_| ids.len() == 1)
}

fn memory_ids(args: &Map<String, Value>, action: &str) -> Vec<i64> {
    if matches!(action, "update" | "archive" | "get") {
        if let Some(values) = args.get("ids").and_then(Value::as_array) {
            return dedup_i64s(values.iter().filter_map(Value::as_i64).collect());
        }
    }

    let mut ids = Vec::new();
    if let Some(id) = i64_arg(args, "id") {
        ids.push(id);
    }
    if let Some(values) = args.get("ids").and_then(Value::as_array) {
        ids.extend(values.iter().filter_map(Value::as_i64));
    }
    dedup_i64s(ids)
}

fn merge_ids(args: &Map<String, Value>) -> Option<Vec<i64>> {
    if let Some(ids) = args
        .get("ids")
        .and_then(Value::as_array)
        .filter(|ids| ids.len() >= 2)
    {
        let ids = dedup_i64s(ids.iter().filter_map(Value::as_i64).collect());
        return (ids.len() >= 2).then_some(ids);
    }

    let ids = if let Some(target_id) = i64_arg(args, "target_id") {
        let mut ids = vec![target_id];
        ids.extend(
            args.get("source_ids")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(Value::as_i64),
        );
        dedup_i64s(ids)
    } else {
        memory_ids(args, "merge")
    };
    (ids.len() >= 2).then_some(ids)
}

fn dedup_i64s(ids: Vec<i64>) -> Vec<i64> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn join_i64s(ids: &[i64]) -> String {
    ids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Renders facade errors for the agent. Every id is a `context.db` id, rendered as is.
struct MemoryFacadeRequestContext;

impl MemoryFacadeRequestContext {
    fn rendered_id(&self, id: i64) -> Option<i64> {
        Some(id)
    }

    fn render_mutation_error(&self, error: FacadeMemoryMutationError) -> String {
        match error {
            FacadeMemoryMutationError::Storage(error) => error,
            FacadeMemoryMutationError::Unavailable { id } => self.rendered_id(id).map_or_else(
                || "memory was not found".to_string(),
                |id| format!("memory {id} was not found"),
            ),
            FacadeMemoryMutationError::DuplicateContent { id } => self.rendered_id(id).map_or_else(
                || "memory content already exists".to_string(),
                |id| format!("memory content already exists as ID {id}"),
            ),
            FacadeMemoryMutationError::InvalidMerge => "memories could not be merged".to_string(),
        }
    }

    fn render_store_error(&self, error: McStoreError) -> String {
        match error {
            McStoreError::MemoryDuplicateContent { id } => self.rendered_id(id).map_or_else(
                || "memory content already exists".to_string(),
                |id| format!("memory content already exists as ID {id}"),
            ),
            error => error.to_string(),
        }
    }

    fn render_tool_error(&self, error: memory_tool::MemoryToolError) -> String {
        match error {
            memory_tool::MemoryToolError::Store(error) => {
                format!("store: {}", self.render_store_error(error))
            }
            memory_tool::MemoryToolError::DuplicateSourceId { id } => {
                self.rendered_id(id).map_or_else(
                    || "duplicate source memory id".to_string(),
                    |id| format!("duplicate source memory id {id}"),
                )
            }
            memory_tool::MemoryToolError::NotFound { id } => self.rendered_id(id).map_or_else(
                || "memory was not found".to_string(),
                |id| format!("memory {id} was not found"),
            ),
            memory_tool::MemoryToolError::Inactive { id, status } => {
                self.rendered_id(id).map_or_else(
                    || format!("memory is not mutable in status {status}"),
                    |id| format!("memory {id} is not mutable in status {status}"),
                )
            }
            memory_tool::MemoryToolError::Superseded { id, superseded_by } => {
                let id = self.rendered_id(id);
                let superseded_by = self.rendered_id(superseded_by);
                match (id, superseded_by) {
                    (Some(id), Some(superseded_by)) => {
                        format!("memory {id} was superseded by {superseded_by}")
                    }
                    (Some(id), None) => format!("memory {id} was superseded"),
                    _ => "memory was superseded".to_string(),
                }
            }
            error => error.to_string(),
        }
    }
}

/// Refuse the retired host-id lane. Every id is a `context.db` id now, so a host that
/// still translates would address the wrong memory.
fn refuse_retired_memory_id_lane(args: &Map<String, Value>) -> Result<(), String> {
    match string_arg(args, "memory_id_lane") {
        None | Some("module") => {}
        Some(_) => {
            return Err(
                "memory_id_lane is retired: memory ids are context.db ids; send them as is"
                    .to_string(),
            )
        }
    }
    if args.get("host_ids").is_some() {
        return Err(
            "host_ids is retired: memory ids are context.db ids; send them as is".to_string(),
        );
    }
    Ok(())
}

fn parse_tag_range_string(input: &str) -> Result<Vec<u64>, String> {
    const MAX_RANGE_ELEMENTS: u64 = 1000;
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Range string must not be empty".to_string());
    }
    let mut numbers = BTreeSet::new();
    for segment in trimmed.split(',') {
        let part = segment.trim();
        if part.contains('-') {
            let Some((start_raw, end_raw)) = part.split_once('-') else {
                return Err(format!("Invalid range \"{part}\""));
            };
            let start = parse_tag_integer(start_raw.trim())?;
            let end = parse_tag_integer(end_raw.trim())?;
            if start > end {
                return Err(format!(
                    "Invalid range \"{part}\": start ({start}) must be <= end ({end})"
                ));
            }
            // Endpoints are positive and i64-bounded, but keep the size calculation
            // checked so malformed facade input can never wrap before the allocation guard.
            let range_size = end
                .checked_sub(start)
                .and_then(|difference| difference.checked_add(1))
                .ok_or_else(|| format!("Invalid range \"{part}\": size overflow"))?;
            if range_size > MAX_RANGE_ELEMENTS {
                return Err(format!(
                    "Range \"{part}\" exceeds maximum size of {MAX_RANGE_ELEMENTS} elements (got {range_size})"
                ));
            }
            for value in start..=end {
                numbers.insert(value);
            }
        } else {
            numbers.insert(parse_tag_integer(part)?);
        }
    }
    if numbers.len() as u64 > MAX_RANGE_ELEMENTS {
        return Err(format!(
            "Total range size exceeds maximum of {MAX_RANGE_ELEMENTS} elements (got {})",
            numbers.len()
        ));
    }
    Ok(numbers.into_iter().collect())
}

fn parse_tag_integer(raw: &str) -> Result<u64, String> {
    let raw = normalize_tag_text(raw);
    if raw.is_empty() || !raw.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(format!("Invalid integer: \"{raw}\""));
    }
    let value = raw
        .parse::<u64>()
        .map_err(|_| format!("Invalid integer: \"{raw}\""))?;
    if value == 0 || value > i64::MAX as u64 {
        return Err(format!(
            "Invalid integer: \"{raw}\" (tag numbers must be between 1 and {})",
            i64::MAX
        ));
    }
    Ok(value)
}

/// Read the host's tool-use identity from either the facade envelope or its argument object.
/// Older THALAMUS callers omit every field, so absence remains an accepted compatibility path.
fn command_id_from_facade_request(
    request: &Value,
    args: &Map<String, Value>,
) -> Result<Option<String>, String> {
    const FIELDS: [&str; 7] = [
        "command_id",
        "tool_use_id",
        "tool_call_id",
        "toolCallId",
        "call_id",
        "callId",
        "callID",
    ];
    let raw = FIELDS
        .iter()
        .find_map(|field| request.get(*field).and_then(Value::as_str))
        .or_else(|| {
            FIELDS
                .iter()
                .find_map(|field| args.get(*field).and_then(Value::as_str))
        });
    let Some(raw) = raw else {
        return Ok(None);
    };
    let command_id = raw.trim();
    if command_id.is_empty() {
        return Err("'command_id' must be a nonempty string".to_string());
    }
    if command_id.len() > MAX_AGENT_DROPS_COMMAND_ID_BYTES {
        return Err(format!(
            "'command_id' exceeds the {MAX_AGENT_DROPS_COMMAND_ID_BYTES}-byte limit"
        ));
    }
    Ok(Some(command_id.to_string()))
}

/// A ctx_note write reply plus the module row it created, so a host that shows
/// its agent host ids can fill in the id once its mirror has assigned one.
fn note_write_response(text: String, module_id: i64) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
        "note_operation": { "action": "write", "module_id": module_id },
    }))
    .map_err(|error| error.to_string())
}

fn facade_text_response(text: impl Into<String>, is_error: bool) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": is_error,
    }))
    .map_err(|error| error.to_string())
}

fn replayed_memory_apply_command(
    store: &McStore,
    session_id: &str,
    action: &str,
    command_id: &str,
) -> Option<HandlerOutcome> {
    if let Ok(Some(response)) =
        store.facade_mutation_ledger_response(session_id, "memory", action, command_id)
    {
        return Some(HandlerOutcome::Response(response));
    }
    store
        .load_dream_task_command(session_id, command_id)
        .ok()
        .flatten()
        .map(|recorded| replay_dream_task_response(&recorded.response_json))
}

fn dream_apply_command_outcome(
    result: Result<FacadeMutationOutcome, McStoreError>,
    failure_code: &str,
) -> HandlerOutcome {
    match result {
        Ok(FacadeMutationOutcome::Applied(bytes) | FacadeMutationOutcome::Duplicate(bytes)) => {
            HandlerOutcome::Response(bytes)
        }
        Err(error) => HandlerOutcome::Error {
            code: failure_code.to_string(),
            message: error.to_string(),
        },
    }
}

fn facade_command_outcome(result: Result<FacadeMutationOutcome, McStoreError>) -> HandlerOutcome {
    match result {
        Ok(FacadeMutationOutcome::Applied(bytes)) => HandlerOutcome::Response(bytes),
        Ok(FacadeMutationOutcome::Duplicate(bytes)) => {
            let Ok(mut envelope) = serde_json::from_slice::<Value>(&bytes) else {
                return HandlerOutcome::Response(bytes);
            };
            if let Some(object) = envelope.as_object_mut() {
                object.insert("replayed".to_string(), Value::Bool(true));
                return respond(envelope);
            }
            HandlerOutcome::Response(bytes)
        }
        Err(error) => tool_error_result(format!("Error: {error}")),
    }
}

fn plural_word(count: usize, singular: &'static str) -> String {
    if count == 1 {
        singular.to_string()
    } else {
        format!("{singular}s")
    }
}

fn note_dismiss_outcome_text(outcome: NoteDismissOutcome) -> &'static str {
    match outcome {
        NoteDismissOutcome::Dismissed => "dismissed",
        NoteDismissOutcome::NotFound => "not_found",
        NoteDismissOutcome::NotOwned => "not_found",
        NoteDismissOutcome::AlreadyDismissed => "already_dismissed",
    }
}

fn format_traffic_age(observed_at_ms: i64, now: i64) -> String {
    if observed_at_ms <= 0 {
        return "unknown".to_string();
    }
    let elapsed_seconds = now.saturating_sub(observed_at_ms).max(0) / 1_000;
    if elapsed_seconds < 60 {
        format!("{elapsed_seconds}s ago")
    } else if elapsed_seconds < 60 * 60 {
        format!("{}m ago", elapsed_seconds / 60)
    } else if elapsed_seconds < 24 * 60 * 60 {
        format!("{}h ago", elapsed_seconds / (60 * 60))
    } else {
        format!("{}d ago", elapsed_seconds / (24 * 60 * 60))
    }
}

fn sanitize_status_text(text: &str, limit: usize) -> String {
    let controls_removed = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    controls_removed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn compact_status_detail(detail: &str) -> String {
    sanitize_status_text(detail, 120)
}

/// Storage-version probe block for the status envelope. Answers "which schema is the
/// store at, which ceiling does this binary carry" in one stable shape so fleet
/// probes stop re-deriving it from raw SQL.
///
/// The module never opens or attaches the host's context.db — the TypeScript plugin
/// owns that file exclusively — so `context_db_schema_version` is null on this
/// surface and the plugin's RPC/doctor surface reports the live value instead. The
/// module store version is read live from the store's migration table; the ceiling
/// is the newest mc-store migration this binary ships.
fn storage_versions_block(store: &McStore) -> Value {
    json!({
        "context_db_schema_version": null,
        "module_store_schema_version": store.module_store_schema_version().ok(),
        "binary_supported_version": LATEST_MIGRATION_VERSION,
    })
}

/// Describe a session that the transform is serving as raw pass-through because its
/// materialized boundary is no longer in the live array (an armed `pending_rewrite`). Every
/// pass in that state skips m0/m1, drops, and folding, so status and health must say so
/// instead of looking like a normally transforming session. Returns `null` otherwise.
fn raw_passthrough_status(loaded: &mc_store::LoadedState) -> Value {
    let Some(pending) = loaded.meta.pending_rewrite.as_ref() else {
        return Value::Null;
    };
    json!({
        "reason": "retained_boundary_absent",
        "retained_boundary_id": &loaded.core.boundary_id,
        "coverage_ordinal": loaded.meta.coverage_ordinal,
        "armed_at_ms": pending.armed_at_ms,
        "last_present_at_ms": pending.last_present_at_ms,
        "absent_request_count": pending.absent_request_count,
    })
}

fn historian_status_summary(state: &mc_store::HistorianDurableState) -> String {
    if state.state != HistorianPhase::Idle {
        return format!("fire seq {} {}", state.firing_seq, state.state.as_str());
    }
    if let Some(reason) = state.last_no_fire.as_deref() {
        return if historian::runner_refusal_stage_from_detail(reason).is_some() {
            format!("no fire: {reason}")
        } else {
            format!("no fire: {}", compact_status_detail(reason))
        };
    }
    if let Some(reason) = state.last_failure.as_deref() {
        if let Some(detail) = reason.strip_prefix(historian::RUNNER_REFUSAL_PUBLISHED_PREFIX) {
            return format!("published seq {}; {detail}", state.firing_seq);
        }
        if reason.starts_with(historian::RUNNER_REFUSAL_CHAIN_EXHAUSTED_PREFIX) {
            return format!("failed seq {}: {reason}", state.firing_seq);
        }
        return format!("failure: {}", compact_status_detail(reason));
    }
    if state.firing_seq > 0 {
        return format!("published seq {}", state.firing_seq);
    }
    "none".to_string()
}

fn wrapup_has_remaining_messages(
    messages: &[crate::ck_wire::CkIngressMessage],
    last_compartment_end: Option<u64>,
    protected_start: u64,
) -> bool {
    messages.iter().any(|message| {
        !message.ck.meta.synthetic
            && message.ordinal < protected_start
            && last_compartment_end.is_none_or(|end| message.ordinal > end)
    })
}

fn wrapup_boundary_messages(
    parsed: &TransformRequest,
    projection: &crate::ck_wire::FlatProjection,
    token_cache: &Mutex<BoundaryTokenCache>,
) -> CachedBoundaryMessages {
    cached_boundary_messages(parsed, projection, token_cache, true)
}

fn boundary_messages(
    parsed: &TransformRequest,
    projection: &crate::ck_wire::FlatProjection,
    token_cache: &Mutex<BoundaryTokenCache>,
) -> CachedBoundaryMessages {
    cached_boundary_messages(parsed, projection, token_cache, false)
}

struct CachedBoundaryMessages {
    messages: Vec<BoundaryMsg>,
    token_cache_hits: usize,
    tokenized_blocks: usize,
    token_cache_snapshot: BoundaryTokenCacheSnapshot,
}

fn cached_boundary_messages(
    parsed: &TransformRequest,
    projection: &crate::ck_wire::FlatProjection,
    token_cache: &Mutex<BoundaryTokenCache>,
    include_system: bool,
) -> CachedBoundaryMessages {
    let mut cache_snapshot = token_cache
        .lock()
        .expect("boundary token cache mutex")
        .snapshot(&parsed.session_id);
    // project_messages appends each message's blocks in one pass, so blocks for a message id are
    // contiguous. A borrowed range map avoids rescanning the whole projection for every message.
    let mut block_ranges = HashMap::<&str, std::ops::Range<usize>>::new();
    for (index, block) in projection.blocks.iter().enumerate() {
        block_ranges
            .entry(block.mid.as_str())
            .and_modify(|range| range.end = index + 1)
            .or_insert(index..index + 1);
    }
    let messages = parsed
        .messages
        .iter()
        .filter(|message| {
            !message.ck.meta.synthetic && (include_system || message.ck.role != "system")
        })
        .map(|message| BoundaryMsg {
            message_ordinal: message.ordinal,
            message_id: message.mid.clone(),
            role: Role::from_provider(&message.ck.role),
            blocks: block_ranges
                .get(message.mid.as_str())
                .into_iter()
                .flat_map(|range| projection.blocks[range.clone()].iter())
                .filter(|block| block.mid == message.mid && !block.synthetic)
                .map(|block| BoundaryBlock {
                    id: block.id.clone(),
                    ordinal: block.ordinal,
                    kind: sel_kind_for_flat(block),
                    provider_executed: block.provider_executed,
                    byte_size: block.bytes.len(),
                    arc_id: block.arc_id.clone(),
                    original_token_count: boundary_block_tokens(block, &mut cache_snapshot),
                    original: Arc::clone(&block.bytes),
                    rendered: None,
                    ignored: false,
                })
                .collect(),
        })
        .collect();
    cache_snapshot.retain_projection(projection);
    let token_cache_hits = cache_snapshot.hits;
    let tokenized_blocks = cache_snapshot.misses;
    CachedBoundaryMessages {
        messages,
        token_cache_hits,
        tokenized_blocks,
        token_cache_snapshot: cache_snapshot,
    }
}

/// Token count the trigger's boundary accounting uses for one block. An image carrier counts at
/// its provider cost from its pixel dimensions (the rule the TypeScript final-wire estimator
/// uses), never by text-tokenizing its base64 bytes, which both overstated it by orders of
/// magnitude and cost a full tokenizer pass over the payload. Every other block, including
/// non-image media and opaque parts, keeps its cached text-token count.
fn boundary_block_tokens(
    block: &crate::ck_wire::FlatBlock,
    cache_snapshot: &mut BoundaryTokenCacheSnapshot,
) -> usize {
    if let crate::ck_wire::CkKind::Media(media) = &block.wire_shape().kind {
        if let Some(tokens) = crate::image_tokens::media_image_tokens(media) {
            return tokens;
        }
    }
    cache_snapshot.token_count(&block.id, &block.bytes, &block.content_hash)
}

fn sel_kind_for_flat(block: &crate::ck_wire::FlatBlock) -> SelKind {
    match block.kind_tag.as_str() {
        "tool_call" => SelKind::ToolCall {
            name: block.name.clone().unwrap_or_default(),
            input: block.tool_input.as_deref().cloned().unwrap_or(Value::Null),
        },
        "tool_result" => SelKind::ToolResult {
            tool_name: block.name.clone().unwrap_or_default(),
        },
        "reasoning" => SelKind::Reasoning,
        "redacted_reasoning" => SelKind::RedactedReasoning,
        "media" => SelKind::Media,
        "opaque" => SelKind::Opaque,
        _ => SelKind::Text,
    }
}

fn usage_numbers(
    usage: Option<&mc_store::ModuleUsage>,
    geometry: Option<&crate::transform::TransformGeometry>,
) -> (f64, f64, f64) {
    let input = usage
        .map(|u| u.current_total_input_tokens as f64)
        .unwrap_or(0.0);
    // Fallback order mirrors transform.rs effective_context_limit_tokens — the
    // historian trigger and the scheduler bands must resolve the same
    // denominator from the same inputs (a first-pass request carries geometry
    // but no usage, and two independent 200k fallbacks here and in
    // transform.rs diverged the two paths on exactly that pass).
    let limit = usage
        .map(|u| u.context_limit_tokens as f64)
        .filter(|limit| *limit >= MIN_PLAUSIBLE_CONTEXT_LIMIT as f64)
        .filter(|limit| {
            geometry.is_none_or(|geometry| {
                geometry.absolute_wall < MIN_PLAUSIBLE_CONTEXT_LIMIT
                    || *limit <= geometry.absolute_wall as f64
            })
        })
        .or_else(|| {
            geometry
                .map(|geometry| geometry.usable_soft as f64)
                .filter(|soft| *soft >= MIN_PLAUSIBLE_CONTEXT_LIMIT as f64)
        })
        .unwrap_or(200_000.0);
    let pct = if limit > 0.0 {
        input / limit * 100.0
    } else {
        0.0
    };
    (limit, input, pct)
}

/// Estimate pressure after the currently queued agent drops apply. The queue stores flat
/// block ids while frozen reductions store replacement bytes, so using only raw input bytes
/// would overstate reclaim after a prior reduction and leave the 75%-relative suppression
/// gate ineffective.
fn projected_post_drop_percentage(
    messages: &[BoundaryMsg],
    pending_drops: &[PendingAgentDrop],
    frozen_units: &[mc_core::FrozenUnit],
    input_tokens: f64,
    context_limit: f64,
) -> Option<f64> {
    if context_limit <= 0.0 {
        return None;
    }
    if pending_drops.is_empty() {
        return Some(input_tokens.max(0.0) / context_limit * 100.0);
    }

    let frozen_sizes = frozen_units
        .iter()
        .filter_map(|unit| {
            unit.key.strip_prefix("red:").map(|target| {
                (
                    target.to_string(),
                    mc_tokenizer::estimate_tokens(&unit.frozen_payload),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let mut current_sizes = HashMap::<String, f64>::new();
    for message in messages {
        for block in &message.blocks {
            current_sizes.insert(
                block.id.clone(),
                frozen_sizes
                    .get(&block.id)
                    .copied()
                    .map(|tokens| tokens as f64)
                    .unwrap_or(block.original_token_count as f64),
            );
        }
    }
    // A frozen unit can outlive the exact input block during a provider replay. Include its
    // replacement size so a pending queue row still has an honest denominator.
    for (target, tokens) in &frozen_sizes {
        current_sizes
            .entry(target.clone())
            .or_insert(*tokens as f64);
    }
    let active_tokens: f64 = current_sizes.values().sum();
    if active_tokens <= 0.0 {
        return None;
    }
    let pending_ids = pending_drops
        .iter()
        .map(|drop| drop.target_id.as_str())
        .collect::<HashSet<_>>();
    let pending_tokens: f64 = pending_ids
        .into_iter()
        .filter_map(|target| current_sizes.get(target))
        .copied()
        .sum();
    let drop_ratio = (pending_tokens / active_tokens).clamp(0.0, 1.0);
    let projected_input = (input_tokens * (1.0 - drop_ratio)).max(0.0);
    Some(projected_input / context_limit * 100.0)
}

fn project_slug(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("project")
        .to_string()
}

fn record_historian_connect_failure(
    store: &McStore,
    session_id: &str,
    failure_backoff_at_ms: i64,
    detail: &str,
    before_commit: &ConnectFailureCommitHook,
) -> Result<(), McStoreError> {
    for attempt in 0..2 {
        let loaded = store.load_meta(session_id)?;
        let mut meta = loaded.meta.clone();
        if meta.historian.state == HistorianPhase::Idle {
            // Connection failures happen before the historian transitions out of Idle, but
            // they still need the same durable cooldown as failures after preparation.
            meta.historian.last_failure = Some(detail.to_string());
            meta.historian.failure_backoff_at_ms = Some(failure_backoff_at_ms);
        } else {
            meta.historian = historian::abandon_with_detail(
                &meta.historian,
                failure_backoff_at_ms,
                Some(detail.to_string()),
            );
        }
        if let Some(hook) = before_commit
            .lock()
            .expect("connect failure commit hook mutex")
            .as_mut()
        {
            hook();
        }
        match store.commit_meta(session_id, loaded.row_version, &meta) {
            Ok(_) => return Ok(()),
            Err(McStoreError::CasConflict { .. }) if attempt == 0 => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!("the connect-failure CAS loop returns from both attempts")
}

/// Resolve the storage descriptor: prefer the daemon-provided `ack.storage`, else
/// fall back to a local dev path (standalone / no managed storage configured).
pub fn resolve_descriptor(storage: Option<&Value>) -> StorageDescriptor {
    resolve_descriptor_with_origin(storage).0
}

/// The same resolution, plus which of the two sources answered. A refusal or health report names
/// the origin because a dev fallback is exactly how two incarnations end up resolving one path and
/// fighting over its single-writer lease.
fn resolve_descriptor_with_origin(
    storage: Option<&Value>,
) -> (StorageDescriptor, DescriptorOrigin) {
    if let Some(value) = storage {
        if let Ok(descriptor) = serde_json::from_value::<StorageDescriptor>(value.clone()) {
            return (descriptor, DescriptorOrigin::DaemonAck);
        }
    }
    (dev_descriptor(), DescriptorOrigin::DevFallback)
}

fn log_directory_mismatch(descriptor: &StorageDescriptor, logs_dir: &Path) -> Option<PathBuf> {
    let StorageBackend::Sqlite { path } = &descriptor.backend else {
        return None;
    };
    let data_dir = Path::new(path).parent()?;
    (data_dir != logs_dir.parent()?).then(|| data_dir.to_path_buf())
}

fn log_directory_disagreement(descriptor: &StorageDescriptor, logs_dir: &Path) -> Option<String> {
    let data_dir = log_directory_mismatch(descriptor, logs_dir)?;
    Some(format!(
        "mc-module: HELLO storage data dir {} differs from logger data dir {}",
        data_dir.display(),
        logs_dir.parent()?.display()
    ))
}

fn warn_if_log_directory_differs(descriptor: &StorageDescriptor, logs_dir: &Path) {
    if let Some(message) = log_directory_disagreement(descriptor, logs_dir) {
        tracing::warn!("{message}");
    }
}

#[cfg(test)]
mod fleet_logging_tests {
    use super::*;

    #[test]
    fn hello_storage_disagreement_is_detected_without_rederiving_logger_path() {
        let descriptor = dev_descriptor_at("/tmp/mc-hello-data");
        let store_dir = Path::new(match &descriptor.backend {
            StorageBackend::Sqlite { path } => path,
            _ => panic!("dev descriptor must be sqlite"),
        })
        .parent()
        .unwrap();
        assert_eq!(
            log_directory_mismatch(&descriptor, &store_dir.join("logs")),
            None
        );
        assert_eq!(
            log_directory_mismatch(&descriptor, Path::new("/tmp/other/logs")),
            Some(store_dir.to_path_buf())
        );
        let warning = log_directory_disagreement(&descriptor, Path::new("/tmp/other/logs"))
            .expect("mismatch must produce a warning");
        assert!(warning.contains(&store_dir.display().to_string()));
        assert!(warning.contains("/tmp/other"));
    }
}

fn dev_descriptor() -> StorageDescriptor {
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let home = config::user_home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(".local")
                .join("share")
                .to_string_lossy()
                .into_owned()
        });
    dev_descriptor_at(&data_home)
}

/// The store descriptor the module uses for a given data-home — the SAME path computation
/// the running module performs from `XDG_DATA_HOME`. Exposed so the acceptance harness can
/// seed the very store the spawned module will open (under its single-writer lease).
pub fn dev_descriptor_at(data_home: &str) -> StorageDescriptor {
    StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.to_string(),
        storage_namespace: STORAGE_NAMESPACE.to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: sqlite_store_path(data_home, DEFAULT_MODULE_ID),
        },
    }
}

/// Supported schema ceilings baked into this build, without opening either database.
/// The context ceiling is extracted from the same plugin source that enforces it at open.
pub fn supported_fences_line() -> String {
    let source = include_str!("../../../packages/plugin/src/features/magic-context/storage-db.ts");
    let context = source
        .split_once("export const LATEST_SUPPORTED_VERSION = ")
        .and_then(|(_, tail)| tail.split_once(';'))
        .and_then(|(value, _)| value.trim().parse::<u32>().ok())
        .expect("plugin context.db fence must be a numeric literal");
    format!("context.db={context} store.db={LATEST_MIGRATION_VERSION}")
}

/// The single-line `--version` self-report: `ck-mc <crate version> (<build sha>)`.
/// The build sha is the same compile-time `MC_BUILD_SHA` that stamps manifest
/// provenance, so a release train tag whose id is a prefix of that sha
/// (`ck-mc-alpha.<short sha>`) can be checked against the placed binary by
/// substring — the fleet's placement-acceptance contract. A bare `cargo build`
/// prints the crate version alone rather than a fabricated sha.
pub fn version_line() -> String {
    match option_env!("MC_BUILD_SHA")
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
    {
        Some(sha) => format!("ck-mc {} ({sha})", env!("CARGO_PKG_VERSION")),
        None => format!("ck-mc {}", env!("CARGO_PKG_VERSION")),
    }
}

/// The module manifest registered at HELLO. The startup manifest owns stable tool IDs and schemas;
/// bound sessions obtain preset-selected description text through `manifest.get`.
pub fn manifest(module_id: &str) -> ModuleManifest {
    manifest_with_route_targets(module_id, &RouteTargetConfig::default())
}

pub fn manifest_with_route_targets(
    module_id: &str,
    resolved_routes: &RouteTargetConfig,
) -> ModuleManifest {
    manifest_with_route_targets_and_smart_notes(module_id, resolved_routes, true)
}

/// The ctx tool facades resolve a bind's `(project_root, session)` to an
/// asynchronous compaction conversation whatever harness the bind names, so
/// an MCP facade may bind a runner's conversation by its session alone.
pub const MCP_CONVERSATION_BINDING_V1: &str = "mcp-conversation-binding/v1";

pub fn manifest_with_route_targets_and_smart_notes(
    module_id: &str,
    resolved_routes: &RouteTargetConfig,
    smart_notes_enabled: bool,
) -> ModuleManifest {
    let mut tools = prompt_surface::module_tools(&PromptSurfaceSelection::default());
    if !smart_notes_enabled {
        prompt_surface::disable_smart_notes_in_tools(&mut tools, PromptSurfacePreset::Full);
    }
    // Use the builder because ModuleManifest can acquire new optional fields.
    // Keep the existing model tools separate from the opt-in internal move service.
    // Leave ModuleManifest.bindings unset: it can request separate stores per
    // project, whereas MC uses one machine-wide store with project-keyed rows.
    let mut capabilities = vec![
        cortexkit_role_compaction_provider::PROVIDES.to_string(),
        MCP_CONVERSATION_BINDING_V1.to_string(),
        // basal reaches `subagent_invocations.read` over the calling flow's own
        // scoped route, which the daemon opens only to a module declaring this.
        // The promise it makes (a flow is never treated as its owner agent) is
        // kept by the dispatcher's flow fence and the op's caller check.
        subc_protocol::scope::FLOW_SCOPES_CAPABILITY.to_string(),
    ];
    let mut provides = vec![
        ProviderRole::ToolProvider {
            tools,
            identity_scope: vec![IdentityScope::Project, IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
            emits_push: false,
            sub_supervises: false,
        },
        subagent_invocations_read::management_role(),
        ProviderRole::InternalService {
            service_id: app_read::SERVICE_ID.into(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: app_read::APP_READ_METHODS
                .iter()
                .map(|method| method.to_string())
                .collect(),
        },
    ];
    if agent_data::ENABLED {
        capabilities.push(cortexkit_role_agent_data::PROVIDES.to_string());
        provides.push(ProviderRole::InternalService {
            service_id: cortexkit_role_agent_data::SERVICE_ID.to_string(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: cortexkit_role_agent_data::REQUIRED_OPS
                .iter()
                .map(|op| op.to_string())
                .collect(),
        });
    }
    ModuleManifest::builder(module_id.to_string(), env!("CARGO_PKG_VERSION").to_string())
    .trust_tier(Some(TrustTier::FirstParty))
    .protocol_ver(PROTOCOL_VERSION)
    // The provider majors are protocol capabilities, not model-facing tools.
    // Runner groups are discovered through role.describe, never required here.
    .capabilities(Some(subc_protocol::manifest::CapabilityDeclarations {
        provides: capabilities,
        requires: vec![],
        must_never_reach: vec![],
    }))
    // Introduced by subc-protocol 0.14: optional self-signal manifest registry.
    // The historian firing and the classify task both spend provider quota through
    // the runner route, so they are declared from the same resolved route registry
    // that fills `consumes` below. Under a host-runner configuration the list is
    // empty, and Some(vec![]) is kept over None per the falsy-value discrimination
    // rule: it declares "examined, none to register", while None would read as
    // "never examined".
    .self_signals(Some(route_targets::self_signals(resolved_routes)))
    // Introduced by subc-protocol 0.13: build provenance for the deploy ladder.
    // The git sha is stamped by the release build command (MC_BUILD_SHA env at
    // compile time); a bare `cargo build` leaves it absent rather than wrong.
    // The daemon renders these in module status, which gives deploy
    // verification a queryable build identity instead of binary archaeology.
    // build_provenance is the subc-protocol library call (re-exported through
    // subc-client-rs); it normalizes sentinel/empty values to field omission.
    // Provenance is a deploy marker, not a load-bearing capability: a
    // non-canonical stamp (subc-protocol 0.17 requires full lowercase 40-hex;
    // short `rev-parse --short` stamps fail its form check) must degrade to
    // omission, never panic the module at boot. Deploy verification greps for
    // the marker and fails loudly on absence, which is the correct failure
    // surface for a malformed stamp.
    .provenance(match build_provenance(option_env!("MC_BUILD_SHA"), None, None) {
        Ok(provenance) => Some(provenance.with_launch_nonce_source(subc_client_rs::launch_nonce_source())),
        Err(err) => {
            tracing::warn!("mc-module: MC_BUILD_SHA rejected by provenance form check, omitting deploy marker: {err}");
            None
        }
    })
    .provides(provides)
    .consumes(vec![ConsumerRole::ServiceClient {
        // ServiceClient is a route declaration, not a capability requirement. The provider
        // runner may be absent: only an incoming provider call needs its callback/read route.
        of: route_targets(resolved_routes),
    }])
    .build()
}

#[cfg(test)]
mod tests {
    include!("tests/tool_attachment_memory_review.rs");
    include!("tests/subagent_invocations_read.rs");
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use crate::boundary::{BoundaryBlock, BoundaryContext, BoundaryMsg, Role, TriggerContext};
    use crate::ck_wire::{
        CkIngressMessage, CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage,
        HarnessMeta, ProviderExtras,
    };
    use historian_producer::{ProducerOutput, RunHandle, RunState};
    use mc_core::CoreState;
    use mc_store::{
        HistorianChunkRange, HistorianDurableState, ModuleMeta, ModuleUsage, PendingAgentDrop,
        StoredCompartment, TagMintInput,
    };
    use tokio::sync::Notify;

    #[test]
    fn session_runner_historian_child_config_uses_setup_root_and_harness() {
        let identity = session_resolver::RunnerBindIdentity {
            project_root: PathBuf::from("/canonical/project"),
            harness: "broca".into(),
            session: "conversation".into(),
        };

        let config = session_runner_historian_config(
            PathBuf::from("/connection.json"),
            RouteTargetConfig::default(),
            &identity,
        );

        assert_eq!(config.project_root, identity.project_root);
        assert_eq!(config.harness, identity.harness);
    }

    // Adversarial gate over the host-runner slice and the single-store marker
    // slice merged together. Kept in its own files so the sequences it executes
    // read as one argument instead of being scattered through this module.
    mod broca_0_7_samples;
    mod broca_contract;
    mod guidance_get_golden;
    mod per_pass_cost;
    mod perf_audit_wire;
    mod tool_outage_1027;
    // Only the profiling harness can construct the scoped override. Differential
    // predicates can read it without exposing a switch to other test suites.
    pub(crate) fn per_pass_differentials_disabled() -> bool {
        per_pass_cost::differentials_disabled()
    }
    pub(crate) fn per_pass_fixed_now_ms() -> Option<i64> {
        per_pass_cost::fixed_now_ms()
    }
    /// Fix `now_ms()` on this thread until the guard drops, for tests that
    /// compare committed state from two runs.
    pub(crate) fn fixed_clock() -> impl Drop {
        per_pass_cost::fixed_clock()
    }
    mod catalog_startup;
    mod tool_catalog;
    mod tool_catalog_conformance;
    // The per-harness default runner, driven through real passes.
    mod default_runner;
    mod retrieval_parity;
    // Prompt and response pairs for a scripted historian in model-less rigs.
    mod scripted_historian_pairs;

    mod i4_roots {
        use super::*;
        use crate::background::{self, ConfigInput, DreamCarrier, DreamRequest, DreamRole};
        use crate::config_parity::{
            ConfigResolveRequest, CoreConfig, CoreConfigResolver, ProtectedTokenTiers, TrustFlags,
        };
        use mc_store::dream_scheduler::schedules::CANONICAL_TASKS;
        use mc_store::parity_schema_manifest::{Availability, CapabilityResult, Generation};

        struct ConfigFixture {
            on: AtomicBool,
            reads: AtomicUsize,
        }

        impl CoreConfigResolver for ConfigFixture {
            fn availability(&self) -> Availability {
                Availability::Available
            }

            fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                let mut effective = default_test_config();
                effective.rust_background_enabled = self.on.load(Ordering::SeqCst);
                effective.historian_runner = Some(HistorianRunnerKind::Host);
                effective.dreamer_runner = Some(HistorianRunnerKind::Broca);
                CapabilityResult::Available {
                    value: CoreConfig {
                        effective,
                        generation: Generation(1),
                        settings: json!({"dreamer":{"opencode":{"model":"fixture/primary",
                            "fallback_models":["fixture/fallback"]}}}),
                        warnings: Vec::new(),
                        trust: TrustFlags::default(),
                        protected_token_tiers: ProtectedTokenTiers::default(),
                    },
                }
            }
        }

        fn input(on: bool) -> (Arc<ConfigFixture>, ConfigInput) {
            let resolver = Arc::new(ConfigFixture {
                on: AtomicBool::new(on),
                reads: AtomicUsize::new(0),
            });
            let input = ConfigInput {
                resolver: resolver.clone(),
                request: ConfigResolveRequest {
                    user_config_path: String::new(),
                    project_root: "/recorded/project".into(),
                    generation: Generation(1),
                },
            };
            (resolver, input)
        }

        #[test]
        fn off_roots_do_not_start_any_work() {
            for root in [
                background::dreamer_tick,
                background::manual_dream,
                background::historian_drain,
                background::embedding_drain,
            ] {
                let (config, input) = input(false);
                let result = root(input, |_: background::Unit| -> () {
                    panic!("disabled background root started work")
                })
                .unwrap()
                .join()
                .unwrap()
                .unwrap();
                assert_eq!(result, None);
                assert_eq!(config.reads.load(Ordering::SeqCst), 1);
            }
        }

        #[derive(Default)]
        struct Carrier {
            calls: Vec<&'static str>,
            models: Vec<String>,
        }

        impl DreamCarrier for Carrier {
            async fn open(
                &mut self,
                request: &background::ChildRequest,
            ) -> Result<String, background::CarrierError> {
                self.calls.push("open");
                assert_eq!(request.runner.kind, HistorianRunnerKind::Broca);
                assert_eq!(request.temperature, None);
                assert_eq!(request.directory, Path::new("/recorded/project"));
                self.models
                    .push(request.model.as_ref().unwrap().model.clone());
                Ok(format!("child-{}", self.models.len()))
            }

            async fn complete(
                &mut self,
                _: &str,
                _: &background::ChildRequest,
            ) -> Result<background::Completion, background::CarrierError> {
                self.calls.push("complete");
                Ok(background::Completion {
                    text: if self.models.len() == 1 {
                        "bad"
                    } else {
                        "accepted"
                    }
                    .into(),
                    ..Default::default()
                })
            }

            async fn close(
                &mut self,
                _: &str,
                settled: bool,
            ) -> Result<(), background::CarrierError> {
                self.calls.push(if settled { "settled" } else { "aborted" });
                Ok(())
            }
        }

        #[test]
        fn dream_roots_capture_once_and_resolve_every_role_off_thread() {
            let caller = std::thread::current().id();
            for manual in [false, true] {
                let (config, input) = input(true);
                let toggle = config.clone();
                let run = move |unit: background::Unit| {
                    assert_ne!(std::thread::current().id(), caller);
                    toggle.on.store(false, Ordering::SeqCst);
                    for role in [
                        DreamRole::Classifier,
                        DreamRole::MemoryMapper,
                        DreamRole::Curate,
                        DreamRole::Docs,
                        DreamRole::Reviewer,
                        DreamRole::PrimerInvestigator,
                        DreamRole::Retrospective,
                    ] {
                        let mut carrier = Carrier::default();
                        let result = unit.run_dream_task(
                            &DreamRequest {
                                task: "classify-memories",
                                role,
                                harness: "opencode",
                                parent_session_id: "ses",
                                directory: Path::new("/recorded/project"),
                                system: "recorded system",
                                prompt: "recorded input",
                                timeout: Duration::from_secs(1),
                                token_budget: Some(100),
                                allow_empty: false,
                            },
                            &mut carrier,
                            |output| {
                                (output.text == "accepted")
                                    .then_some(output.text.clone())
                                    .ok_or_else(|| "invalid draft".into())
                            },
                        );
                        assert_eq!(result.result.unwrap(), "accepted");
                        assert_eq!(carrier.models, ["fixture/primary", "fixture/fallback"]);
                        assert_eq!(
                            carrier.calls,
                            ["open", "complete", "aborted", "open", "complete", "settled"]
                        );
                    }
                };
                let job = if manual {
                    background::manual_dream(input, run)
                } else {
                    background::dreamer_tick(input, run)
                };
                assert_eq!(job.unwrap().join().unwrap().unwrap(), Some(()));
                assert_eq!(config.reads.load(Ordering::SeqCst), 1);
            }
        }

        #[test]
        fn runner_routes_use_the_canonical_host_set_and_dreamer_precedence() {
            let mut config = default_test_config();
            config.historian_runner = None;
            config.dreamer_runner = None;
            for harness in crate::historian_runner::HOST_RUNNER_HARNESSES {
                assert_eq!(
                    config.dreamer_runner_for(harness).kind,
                    HistorianRunnerKind::Host
                );
            }
            for harness in ["", "unknown", "broca"] {
                assert_eq!(
                    config.dreamer_runner_for(harness).kind,
                    HistorianRunnerKind::Broca
                );
            }
            config.historian_runner = Some(HistorianRunnerKind::Host);
            assert_eq!(
                config.dreamer_runner_for("").kind,
                HistorianRunnerKind::Host
            );
            config.dreamer_runner = Some(HistorianRunnerKind::Broca);
            assert_eq!(
                config.dreamer_runner_for("pi").kind,
                HistorianRunnerKind::Broca
            );
            config.historian_runner = None;
            assert_eq!(
                config.dreamer_runner_for("pi").kind,
                HistorianRunnerKind::Broca
            );
        }

        fn code(outcome: HandlerOutcome) -> String {
            match outcome {
                HandlerOutcome::Error { code, .. } => code,
                other => panic!("expected refusal, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn canonical_dream_task_matrix_preserves_off_and_refuses_enabled_tasks() {
            let ts = include_str!(
                "../../../packages/plugin/src/features/magic-context/dreamer/task-registry.ts"
            );
            let registry = ts
                .split("export const CANONICAL_DREAM_TASKS = [")
                .nth(1)
                .unwrap()
                .split("] as const")
                .next()
                .unwrap();
            let ts_names: Vec<_> = registry
                .lines()
                .filter_map(|line| line.trim().strip_prefix('"')?.split('"').next())
                .collect();
            assert_eq!(
                CANONICAL_TASKS.map(|task| task.as_str()).as_slice(),
                ts_names
            );
            let mut config = default_test_config();
            config.rust_background_enabled = true;
            config.smart_notes_enabled = true;
            let producer = Arc::new(ProducerState::default());
            // A project whose user configured a wired Broca runner that admits file
            // reads: publication then depends only on which tasks are wired.
            config.dreamer_runner = Some(HistorianRunnerKind::Broca);
            let (mut handler, store, _dir, _project) =
                handler_with_store(producer.clone(), config.clone());
            handler.fixed_config = Some(config.clone());
            let mut settings =
                json!({"dreamer":{"tasks":{},"mc-module-test":{"model":"provider/model"}}});
            for task in CANONICAL_TASKS {
                settings["dreamer"]["tasks"][task.as_str()] = json!({"schedule":"0 3 * * *"});
            }
            handler.fixed_dream_settings = Some(settings.clone());
            for (channel, request, expected) in [
                (
                    7,
                    json!({"session_id":"ses","task":"curate"}),
                    "bad_request",
                ),
                (7, json!({"v":1,"task":"curate"}), "bad_request"),
                (
                    8,
                    json!({"v":1,"session_id":"ses","task":"curate"}),
                    "route_unbound",
                ),
                (
                    7,
                    json!({"v":1,"session_id":"foreign","task":"curate"}),
                    "session_mismatch",
                ),
                (7, json!({"v":1,"session_id":"ses"}), "invalid_params"),
                (
                    7,
                    json!({"v":1,"session_id":"ses","task":"unknown"}),
                    "invalid_params",
                ),
            ] {
                assert_eq!(
                    code(handler.handle_dreamer_run_task(channel, &request).await),
                    expected
                );
            }
            // Ownership is the published list: a wired task with a Rust host and a
            // capable runner is owned; a task with no Rust host (compress-cues,
            // maintain-docs, evaluate-smart-notes) never is, even when wired.
            for implemented in [false, true] {
                for task in CANONICAL_TASKS {
                    handler.dream_wiring = Some(dream_dispatch::ownership::Wiring {
                        tasks: if implemented { vec![task] } else { Vec::new() },
                        broca: true,
                        broca_file_read: true,
                    });
                    let request = json!({"v":1,"session_id":"ses","task":task.as_str(),
                        "implemented":true,"model_chain":false,"payload":false,"command_id":false});
                    assert_eq!(
                        code(handler.handle_dreamer_run_task(7, &request).await),
                        if implemented && dream_dispatch::ownership::task_roles(task).is_some() {
                            "rust_scheduler_owns_task"
                        } else {
                            "unavailable_capability"
                        },
                        "{}",
                        task.as_str()
                    );
                }
            }
            config.smart_notes_enabled = false;
            handler.fixed_config = Some(config.clone());
            handler.dream_wiring = Some(dream_dispatch::ownership::Wiring {
                tasks: vec![mc_store::dream_scheduler::schedules::TaskName::EvaluateSmartNotes],
                broca: false,
                broca_file_read: false,
            });
            assert_eq!(
                code(
                    handler
                        .handle_dreamer_run_task(
                            7,
                            &json!({"v":1,"session_id":"ses","task":"evaluate-smart-notes"})
                        )
                        .await
                ),
                "invalid_params"
            );
            handler.dream_wiring = None;
            config.smart_notes_enabled = true;
            handler.fixed_config = Some(config.clone());
            for task in CANONICAL_TASKS {
                let mut disabled = settings.clone();
                disabled["dreamer"]["tasks"][task.as_str()]["schedule"] = json!("  ");
                handler.fixed_dream_settings = Some(disabled);
                assert_eq!(
                    code(
                        handler
                            .handle_dreamer_run_task(
                                7,
                                &json!({"v":1,"session_id":"ses","task":task.as_str()})
                            )
                            .await
                    ),
                    "invalid_params"
                );
            }
            handler.fixed_dream_settings = Some(settings);
            config.rust_background_enabled = false;
            handler.fixed_config = Some(config);
            for task in CANONICAL_TASKS {
                assert_eq!(
                    code(
                        handler
                            .handle_dreamer_run_task(
                                7,
                                &json!({"v":1,"session_id":"ses","task":task.as_str(),
                    "command_id":"matrix","payload":{"prompt_body":"recorded","items":[]}})
                            )
                            .await
                    ),
                    if task.as_str() == CLASSIFY_TASK {
                        "model_chain_missing"
                    } else {
                        "invalid_params"
                    }
                );
            }
            assert!(store
                .load_dream_task_command("ses", "matrix")
                .unwrap()
                .is_none());
            assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
        }

        struct VectorQueue;
        impl crate::memory_actions::MemoryEmbeddingQueue for VectorQueue {
            fn enqueue_tx(
                &self,
                tx: &rusqlite::Transaction<'_>,
                effect: &crate::memory_actions::EmbeddingEffect,
            ) -> rusqlite::Result<()> {
                let record = serde_json::from_value(serde_json::to_value(effect).unwrap()).unwrap();
                mc_store::retrieval_vectors::queue::enqueue_tx(tx, &record)
            }
        }

        fn memory_write(tx: &rusqlite::Transaction<'_>, project: &str) -> rusqlite::Result<String> {
            use crate::memory_actions::*;
            MemoryActions::default().execute_tx(
                tx,
                &VectorQueue,
                &MemoryActionContext {
                    project_path: project,
                    session_id: "ses",
                    harness: "opencode",
                    role: MemoryRole::Dreamer,
                    workspace_members: &[],
                    shared_categories: &[],
                    curate_category: Some("CONSTRAINTS"),
                    memory_enabled: true,
                    now_ms: 100,
                    decision_key: "recorded-memory-task",
                },
                &serde_json::from_value(json!({"action":"write", "content":"Background memory fact", "category":"CONSTRAINTS"})).unwrap(),
            )
        }

        fn scalar(db: &rusqlite::Connection, sql: &str) -> i64 {
            db.query_row(sql, [], |row| row.get(0)).unwrap()
        }

        struct NoChunks;
        impl mc_store::retrieval_vectors::store::ChunkCatalog for NoChunks {
            fn pending(
                &self,
                _: &rusqlite::Connection,
                _: &str,
                _: &str,
                _: usize,
            ) -> rusqlite::Result<Vec<mc_store::retrieval_vectors::store::Passage>> {
                Ok(Vec::new())
            }
            fn current(
                &self,
                _: &rusqlite::Connection,
                _: &mc_store::retrieval_vectors::store::Passage,
            ) -> rusqlite::Result<bool> {
                panic!("memory-only drain requested chunks")
            }
        }

        struct Embedder(Arc<AtomicUsize>);
        impl mc_store::retrieval_vectors::drain::EmbeddingProvider for Embedder {
            fn embed(
                &mut self,
                _: &mc_store::retrieval_vectors::drain::Registration,
                passages: &[mc_store::retrieval_vectors::store::Passage],
            ) -> Result<Vec<Vec<f32>>, String> {
                self.0.fetch_add(passages.len(), Ordering::SeqCst);
                Ok(vec![vec![0.25, 0.75]; passages.len()])
            }
        }

        #[test]
        fn embedding_root_drains_a_real_memory_action_only_when_on() {
            use mc_store::retrieval_vectors::drain::{FinishOutcome, Registration};
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fixture.db");
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                &include_str!("../../mc-store/testdata/context_schema/schema.sql")
                    .replace(":applied_at", "1"),
            )
            .unwrap();
            let (_, task_input) = input(true);
            let task_path = path.clone();
            background::manual_dream(task_input, move |unit| {
                let mut carrier = Carrier::default();
                unit.run_dream_task(
                    &DreamRequest {
                        task: "curate",
                        role: DreamRole::Curate,
                        harness: "opencode",
                        parent_session_id: "ses",
                        directory: Path::new("/recorded/project"),
                        system: "recorded memory-task system",
                        prompt: "recorded memory-task input",
                        timeout: Duration::from_secs(1),
                        token_budget: Some(100),
                        allow_empty: false,
                    },
                    &mut carrier,
                    |output| {
                        (output.text == "accepted")
                            .then_some(())
                            .ok_or_else(|| "invalid result".into())
                    },
                )
                .result
                .unwrap();
                let mut db = rusqlite::Connection::open(task_path).unwrap();
                let tx = db.transaction().unwrap();
                assert_eq!(
                    memory_write(&tx, "git:identity").unwrap(),
                    "Saved memory [ID: 1] in CONSTRAINTS."
                );
                tx.commit().unwrap();
            })
            .unwrap()
            .join()
            .unwrap()
            .unwrap()
            .unwrap();
            let registration = Registration {
                project: "git:identity".into(),
                model_id: "fixture".into(),
                chunk_model_id: "fixture:raw".into(),
                fingerprint: "fixture-fingerprint".into(),
                table_epoch: 1,
                dimensions: 2,
                generation: 1,
            };
            db.execute("INSERT INTO embedding_registrations(project_path,model_id,chunk_model_id,fingerprint,table_epoch,dims,generation) VALUES(?1,?2,?3,?4,1,2,1)", rusqlite::params![registration.project,registration.model_id,registration.chunk_model_id,registration.fingerprint]).unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            for on in [false, true] {
                let (config, input) = input(on);
                let toggle = config.clone();
                let path = path.clone();
                let registration = registration.clone();
                let mut provider = Embedder(calls.clone());
                let result = background::embedding_drain(input, move |unit| {
                    toggle.on.store(false, Ordering::SeqCst);
                    let mut db = rusqlite::Connection::open(path).unwrap();
                    unit.drain_embeddings(
                        &mut db,
                        &NoChunks,
                        &mut provider,
                        &registration,
                        1,
                        100,
                        || 101,
                    )
                    .unwrap()
                })
                .unwrap()
                .join()
                .unwrap()
                .unwrap();
                if on {
                    assert!(matches!(
                        result,
                        Some(Some(FinishOutcome::Published { accepted: 1, .. }))
                    ));
                    assert_eq!(calls.load(Ordering::SeqCst), 1);
                    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 1);
                } else {
                    assert_eq!(result, None);
                    assert_eq!(calls.load(Ordering::SeqCst), 0);
                    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 0);
                }
                assert_eq!(config.reads.load(Ordering::SeqCst), 1);
                assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memories"), 1);
                assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_journal"), 1);
                assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_history"), 0);
                assert_eq!(scalar(&db, "SELECT COUNT(*) FROM authority_managed"), 0);
                assert_eq!(
                    scalar(&db, "SELECT COUNT(*) FROM authority_repair_pending"),
                    0
                );
                assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_pending_facts WHERE reason='authority_elsewhere'"), 0);
            }
        }

        #[derive(Default)]
        struct DrainAccounting(Mutex<background::DrainMeta>);
        impl background::DrainStore for DrainAccounting {
            type Error = ();
            fn with_immediate_transaction<T>(
                &self,
                _: &str,
                apply: impl FnOnce(&mut background::DrainMeta) -> T,
            ) -> Result<T, ()> {
                Ok(apply(&mut self.0.lock().unwrap()))
            }
        }

        #[test]
        fn historian_root_keeps_reservation_and_refund_under_its_capture() {
            let (config, input) = input(true);
            let toggle = config.clone();
            let result = background::historian_drain(input, move |unit| {
                toggle.on.store(false, Ordering::SeqCst);
                let accounting = DrainAccounting::default();
                let reserved = unit
                    .reserve_historian(
                        &accounting,
                        background::ReserveRequest {
                            session_id: "ses",
                            run_id: "run",
                            true_raw_tokens: 30.0,
                            usage_percentage: 70.0,
                            usable: 100_000.0,
                            per_run_cap: 50_000.0,
                            execute_threshold_percentage: 65.0,
                            now: 100,
                        },
                    )
                    .unwrap()
                    .unwrap();
                assert_eq!(reserved.reserved_tokens, 30.0);
                assert_eq!(
                    accounting.0.lock().unwrap().protected_tail_drain_tokens,
                    30.0
                );
                unit.refund_historian(&accounting, reserved.reservation.as_ref().unwrap())
                    .unwrap();
                assert_eq!(
                    accounting.0.lock().unwrap().protected_tail_drain_tokens,
                    0.0
                );
            })
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
            assert_eq!(result, Some(()));
            assert_eq!(config.reads.load(Ordering::SeqCst), 1);
        }
    }

    fn owner_prep_methods() -> impl Iterator<Item = &'static str> {
        non_served_contract::UI_METHODS.iter().copied().chain([
            non_served_contract::RETRIEVAL_METHOD,
            non_served_contract::MEMORY_METHOD,
        ])
    }

    #[tokio::test]
    async fn owner_prep_each_arm_authorizes_before_read_write_replay_or_job_lookup() {
        assert_eq!(owner_prep_methods().count(), 19);
        assert_eq!(
            owner_prep_methods()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            19
        );
        let (handler, store, _dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        store.set_route_identity_for_test(project.to_str().unwrap(), "git:bound-project");
        ops_facade::attest_ui_fixture(&handler, Some(&store), "git:bound-project");
        store
            .replace_compartments("ses", &[stored_comp(1, 1, 1, "m1", "owned")])
            .unwrap();
        store
            .replace_compartments("foreign", &[stored_comp(2, 1, 1, "m2", "private")])
            .unwrap();
        let changes = || {
            store
                .with_context_conn_for_test(|tx| {
                    tx.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                })
                .unwrap()
        };
        let before = changes();
        for method in owner_prep_methods() {
            for (channel, request, expected) in [
                (
                    7,
                    json!({"method":method,"session_id":"ses"}),
                    "bad_request",
                ),
                (
                    7,
                    json!({"method":method,"v":2,"session_id":"ses"}),
                    "bad_request",
                ),
                (7, json!({"method":method,"v":1}), "bad_request"),
                (
                    7,
                    json!({"method":method,"v":1,"session_id":""}),
                    "bad_request",
                ),
                (
                    7,
                    json!({"method":method,"v":1,"session_id":"  "}),
                    "bad_request",
                ),
                (
                    8,
                    json!({"method":method,"v":1,"session_id":"ses"}),
                    "route_unbound",
                ),
                (
                    7,
                    json!({"method":method,"v":1,"session_id":"foreign"}),
                    "session_mismatch",
                ),
            ] {
                match handler.dispatch_value(channel, request).await {
                    HandlerOutcome::Error { code, .. } => assert_eq!(code, expected, "{method}"),
                    _ => panic!("{method} must refuse {expected} without returning data"),
                }
            }
        }
        assert_eq!(
            changes(),
            before,
            "refused arms must write nothing in any table"
        );
    }

    #[tokio::test]
    async fn owner_prep_authorized_arms_refuse_by_exact_route_without_effects() {
        let recorded = [
            "mc.ui_capabilities",
            "mc.read_sidebar",
            "mc.read_status",
            "mc.read_embed",
            "mc.read_compartment_count",
            "mc.read_todos",
            "mc.recomp_preview",
            "mc.recomp_start",
            "mc.rescore",
            "mc.wrapup",
            "mc.flush",
            "mc.dream",
            "mc.embed",
            "mc.job_read",
            "mc.job_cancel",
            "mc.ui_events",
            "mc.notice_currentness",
            "mc.retrieval",
            "mc.memory",
        ];
        assert_eq!(owner_prep_methods().collect::<Vec<_>>(), recorded);
        let partition = ops_facade::IMPLEMENTED
            .iter()
            .chain(ops_facade::UNPORTED)
            .copied()
            .chain([
                non_served_contract::RETRIEVAL_METHOD,
                non_served_contract::MEMORY_METHOD,
            ])
            .collect::<Vec<_>>();
        assert_eq!(partition.len(), recorded.len());
        assert_eq!(
            partition
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>(),
            recorded.into_iter().collect()
        );
        let (handler, store, _dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        store.set_route_identity_for_test(project.to_str().unwrap(), "git:bound-project");
        ops_facade::attest_ui_fixture(&handler, Some(&store), "git:bound-project");
        let before = store.load("ses").unwrap().row_version;
        for method in ops_facade::UNPORTED
            .iter()
            .copied()
            .chain([non_served_contract::MEMORY_METHOD])
        {
            match handler
                .dispatch_value(
                    7,
                    json!({
                        "method":method,"v":1,"session_id":"ses", "project":"git:foreign-project",
                        "directory":"/foreign", "command_id":"same-command", "job_id":"foreign-job",
                        "acked_position":0,
                    }),
                )
                .await
            {
                HandlerOutcome::Error { code, message } => {
                    assert_eq!(code, "route_not_ported", "{method}");
                    assert_eq!(message, method);
                }
                _ => panic!("{method} must not claim an executor is implemented"),
            }
        }
        assert_eq!(store.load("ses").unwrap().row_version, before);
        assert_eq!(non_served_contract::ROUTE_NAME_FIELD, "message");
        assert_eq!(
            non_served_contract::RETRIEVAL_AVAILABILITY_FIELD,
            "source_availability"
        );
    }

    #[tokio::test]
    async fn owner_prep_store_absence_is_partial_only_after_authorization() {
        let handler = McHandler::new();
        let dir = tempfile::tempdir().unwrap();
        handler.bind_route(7, binding(dir.path().to_str().unwrap(), "ses"));
        ops_facade::attest_ui_fixture(&handler, None, "git:bound-project");
        for method in non_served_contract::UI_READ_METHODS {
            let request = json!({"method":method,"v":1,"session_id":"ses"});
            assert_eq!(
                error_code(handler.dispatch_value(8, request.clone()).await),
                "route_unbound"
            );
            let body = call_dispatch_request(&handler, request).await;
            assert_eq!(
                body,
                json!({
                    "v":1,"ok":false,"state":"partial","reason":"store_unavailable",
                    "authority":"unknown","data":null,
                }),
                "{method}"
            );
        }
    }

    #[tokio::test]
    async fn owner_prep_project_scope_uses_bound_identity_not_request_fields() {
        let (handler, _store, _dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        ops_facade::attest_ui_fixture(&handler, None, "git:bound-project");
        std::fs::write(project.join(".git"), "gitdir: /nonexistent/for/this/test\n").unwrap();
        handler
            .resolve_project_identity_for_test
            .store(true, Ordering::Relaxed);
        // The throwaway checkout has a broken Git identity. A caller-supplied
        // project must not rescue it or authorize another project's rows.
        for method in non_served_contract::PROJECT_METHODS {
            let outcome = handler
                .dispatch_value(
                    7,
                    json!({
                        "method":method,"v":1,"session_id":"ses",
                        "project":"git:forged", "project_path":"git:forged", "directory":"/forged",
                    }),
                )
                .await;
            assert_eq!(error_code(outcome), "git_identity_unavailable", "{method}");
        }
    }

    #[test]
    fn search_date_bounds_are_utc_inclusive_and_reject_invalid_values() {
        let date_args = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "from": "2026-09-22",
            "to": "2026-09-22"
        }))
        .unwrap();
        assert_eq!(
            parse_search_date_bound(&date_args, "from", false).unwrap(),
            Some(1_790_035_200_000)
        );
        assert_eq!(
            parse_search_date_bound(&date_args, "to", true).unwrap(),
            Some(1_790_121_599_999)
        );
        let invalid = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "from": "2026-02-30"
        }))
        .unwrap();
        assert!(parse_search_date_bound(&invalid, "from", false).is_err());
    }

    #[test]
    fn manifest_consumes_follow_the_resolved_runner_target() {
        let custom = manifest_with_route_targets(
            "magic-context",
            &RouteTargetConfig::runner_module("custom-runner"),
        );
        assert_eq!(
            custom.consumes,
            vec![ConsumerRole::ServiceClient {
                of: route_targets::expected_routes_for_tests("custom-runner"),
            }]
        );

        let hosted =
            manifest_with_route_targets("magic-context", &RouteTargetConfig::host_runner());
        assert_eq!(
            hosted.consumes,
            vec![ConsumerRole::ServiceClient {
                of: route_targets::expected_routes_for_tests("broca"),
            }]
        );
        // Self-signals drop out with the background-completion target, but the field stays declared
        // ("examined, none").
        assert_eq!(hosted.self_signals, Some(vec![]));
        assert_eq!(
            custom.self_signals,
            Some(route_targets::self_signals(
                &RouteTargetConfig::runner_module("custom-runner")
            ))
        );
        assert_eq!(custom.self_signals.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn usage_numbers_rejects_implausible_context_limit() {
        let tiny = ModuleUsage {
            current_total_input_tokens: 50_000,
            context_limit_tokens: 500,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let (limit, _, pct) = usage_numbers(Some(&tiny), None);
        let boundary_golden: Value =
            serde_json::from_str(include_str!("../testdata/boundary-golden.json")).unwrap();
        assert_eq!(
            limit,
            boundary_golden["default_context_limit"].as_f64().unwrap()
        );
        assert!((pct - 25.0).abs() < 0.01, "pct={pct}");

        let ok = ModuleUsage {
            current_total_input_tokens: 133_000,
            context_limit_tokens: 167_000,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let (limit, _, pct) = usage_numbers(Some(&ok), None);
        assert_eq!(limit, 167_000.0);
        assert!((pct - 79.64).abs() < 0.1, "pct={pct}");

        let one_m = ModuleUsage {
            current_total_input_tokens: 800_000,
            context_limit_tokens: 1_000_000,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let (limit, _, pct) = usage_numbers(Some(&one_m), None);
        assert_eq!(limit, 1_000_000.0);
        assert!((pct - 80.0).abs() < 0.01, "pct={pct}");

        let poisoned = ModuleUsage {
            current_total_input_tokens: 285_310,
            context_limit_tokens: 593_717,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let geometry = crate::transform::TransformGeometry {
            usable_soft: 204_000,
            usable_hard: 204_000,
            absolute_wall: 272_000,
            derivation: "provider-observed".to_string(),
        };
        let proof_above_emergency_wall = ModuleUsage {
            current_total_input_tokens: 255_834,
            context_limit_tokens: 255_834,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let (limit, _, _) = usage_numbers(Some(&proof_above_emergency_wall), Some(&geometry));
        assert_eq!(limit, 255_834.0);

        let (limit, _, pct) = usage_numbers(Some(&poisoned), Some(&geometry));
        assert_eq!(limit, 204_000.0);
        assert!((pct - (285_310.0 / 204_000.0 * 100.0)).abs() < 0.01);
    }

    #[test]
    fn usage_numbers_first_pass_prefers_geometry_soft_over_the_constant() {
        // First pass: geometry present, usage absent. The historian trigger
        // must resolve the same denominator the scheduler bands resolve
        // (transform.rs effective_context_limit_tokens) — a second private
        // 200k fallback here made the two paths diverge on exactly this pass,
        // observed live as identical trigger bars across a 167k/30k override
        // pair (Thalamus consumption drive, arm 3).
        let geometry = crate::transform::TransformGeometry {
            usable_soft: 167_000,
            usable_hard: 200_000,
            absolute_wall: 200_000,
            derivation: "drive".to_string(),
        };
        let (limit, _, _) = usage_numbers(None, Some(&geometry));
        assert_eq!(limit, 167_000.0);

        // Usage present still wins over geometry.
        let present = ModuleUsage {
            current_total_input_tokens: 1,
            context_limit_tokens: 150_000,
            final_wire_input_tokens: 0,
            final_wire_trusted: false,
        };
        let (limit, _, _) = usage_numbers(Some(&present), Some(&geometry));
        assert_eq!(limit, 150_000.0);

        // Implausible geometry soft falls through to the constant.
        let implausible = crate::transform::TransformGeometry {
            usable_soft: 12,
            usable_hard: 200_000,
            absolute_wall: 200_000,
            derivation: String::new(),
        };
        let (limit, _, _) = usage_numbers(None, Some(&implausible));
        assert_eq!(limit, 200_000.0);
    }

    fn trigger_ingress_fixture(
        message_count: usize,
        payload_bytes: usize,
    ) -> Vec<CkIngressMessage> {
        (0..message_count)
            .map(|index| {
                let text = format!("message {index}: {}", "x".repeat(payload_bytes));
                ck_with_role(
                    &format!("m-{index}"),
                    index as u64 + 1,
                    if index % 2 == 0 { "user" } else { "assistant" },
                    &text,
                )
            })
            .collect()
    }

    fn trigger_messages_fixture(message_count: usize, payload_bytes: usize) -> Vec<BoundaryMsg> {
        (0..message_count)
            .map(|index| {
                let original = format!("message {index}: {}", "x".repeat(payload_bytes));
                BoundaryMsg {
                    message_ordinal: index as u64 + 1,
                    message_id: format!("m-{index}"),
                    role: if index % 2 == 0 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    blocks: vec![BoundaryBlock {
                        id: format!("m-{index}#0"),
                        ordinal: index as u64 + 1,
                        kind: SelKind::Text,
                        provider_executed: false,
                        byte_size: original.len(),
                        arc_id: None,
                        original_token_count: mc_tokenizer::estimate_tokens(&original),
                        original: Arc::from(original),
                        rendered: None,
                        ignored: false,
                    }],
                }
            })
            .collect()
    }

    fn projected_post_drop_percentage_retokenized_reference(
        messages: &[BoundaryMsg],
        pending_drops: &[PendingAgentDrop],
        frozen_units: &[mc_core::FrozenUnit],
        input_tokens: f64,
        context_limit: f64,
    ) -> Option<f64> {
        if context_limit <= 0.0 {
            return None;
        }
        let frozen_sizes = frozen_units
            .iter()
            .filter_map(|unit| {
                unit.key.strip_prefix("red:").map(|target| {
                    (
                        target.to_string(),
                        mc_tokenizer::estimate_tokens(&unit.frozen_payload),
                    )
                })
            })
            .collect::<HashMap<_, _>>();
        let mut current_sizes = HashMap::<String, f64>::new();
        for message in messages {
            for block in &message.blocks {
                let raw = mc_tokenizer::estimate_tokens(&block.original) as f64;
                current_sizes.insert(
                    block.id.clone(),
                    frozen_sizes
                        .get(&block.id)
                        .copied()
                        .map(|tokens| tokens as f64)
                        .unwrap_or(raw),
                );
            }
        }
        for (target, tokens) in &frozen_sizes {
            current_sizes
                .entry(target.clone())
                .or_insert(*tokens as f64);
        }
        let active_tokens: f64 = current_sizes.values().sum();
        if active_tokens <= 0.0 {
            return None;
        }
        let pending_ids = pending_drops
            .iter()
            .map(|drop| drop.target_id.as_str())
            .collect::<HashSet<_>>();
        let pending_tokens: f64 = pending_ids
            .into_iter()
            .filter_map(|target| current_sizes.get(target))
            .copied()
            .sum();
        let drop_ratio = (pending_tokens / active_tokens).clamp(0.0, 1.0);
        let projected_input = (input_tokens * (1.0 - drop_ratio)).max(0.0);
        Some(projected_input / context_limit * 100.0)
    }

    fn pending_drop(target_id: &str) -> PendingAgentDrop {
        PendingAgentDrop {
            id: 1,
            target_id: target_id.to_string(),
            queued_at_ms: 0,
            command_id: None,
            command_first_applied_at_ms: None,
        }
    }

    fn frozen_drop(target_id: &str) -> mc_core::FrozenUnit {
        mc_core::FrozenUnit {
            key: format!("red:{target_id}"),
            kind: "drop".to_string(),
            frozen_payload: "[dropped]".to_string(),
            durability_class: mc_core::DurabilityClass::Lineage,
            reset_rule: String::new(),
        }
    }

    #[test]
    fn boundary_token_cache_primes_cold_entries_from_durable_tag_tokens() {
        let bytes = b"durable tagged block".to_vec();
        let mut cache = BoundaryTokenCache::new(1024 * 1024);
        cache.prime_from_persisted_tags(
            "session",
            &[mc_store::McTagRow {
                tag_number: 1,
                block_id: "m1#0".to_string(),
                kind: "text".to_string(),
                token_count: 37,
                created_at_ms: 1,
                source_bytes: bytes.clone().into(),
            }],
        );
        let mut snapshot = cache.snapshot("session");
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        assert_eq!(
            snapshot.token_count("m1#0", "durable tagged block", &digest),
            37
        );
        assert_eq!(snapshot.hits, 1);
        assert_eq!(snapshot.misses, 0);
    }

    #[test]
    fn boundary_token_cache_hash_fences_same_length_edits_and_evicts_lru() {
        let mut cache = BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES);
        let mut cold = cache.snapshot("ses-a");
        let cold_bytes = "aaaaaaaa";
        let cold_hash: [u8; 32] = Sha256::digest(cold_bytes.as_bytes()).into();
        let cold_tokens = cold.token_count("m-1#0", cold_bytes, &cold_hash);
        assert_eq!((cold.hits, cold.misses), (0, 1));
        cache.replace("ses-a", cold);

        let mut edited = cache.snapshot("ses-a");
        let edited_bytes = "a b c d ";
        let edited_hash: [u8; 32] = Sha256::digest(edited_bytes.as_bytes()).into();
        let edited_tokens = edited.token_count("m-1#0", edited_bytes, &edited_hash);
        assert_ne!(
            cold_tokens, edited_tokens,
            "fixture must change token count"
        );
        assert_eq!(edited_tokens, mc_tokenizer::estimate_tokens("a b c d "));
        assert_eq!(
            (edited.hits, edited.misses),
            (0, 1),
            "equal byte length cannot reuse a changed block"
        );
        cache.replace("ses-a", edited);

        let mut warm = cache.snapshot("ses-a");
        warm.token_count("m-1#0", edited_bytes, &edited_hash);
        assert_eq!((warm.hits, warm.misses), (1, 0));
        let one_session_bytes = warm.retained_bytes();
        let formatted = "[1] U:  a b c d";
        let formatted_tokens = warm.formatted_token_count(formatted);
        assert_eq!(formatted_tokens, mc_tokenizer::estimate_tokens(formatted));
        assert_eq!(warm.formatted_token_count(formatted), formatted_tokens);
        assert_eq!(
            warm.formatted_tokens.len() + warm.formatted_token_updates.len(),
            1
        );

        let mut bounded = BoundaryTokenCache::new(one_session_bytes);
        let mut first = bounded.snapshot("first");
        let first_bytes = "first";
        let first_hash: [u8; 32] = Sha256::digest(first_bytes.as_bytes()).into();
        first.token_count("m-1#0", first_bytes, &first_hash);
        bounded.replace("first", first);
        let mut second = bounded.snapshot("second");
        let second_bytes = "other";
        let second_hash: [u8; 32] = Sha256::digest(second_bytes.as_bytes()).into();
        second.token_count("m-2#0", second_bytes, &second_hash);
        bounded.replace("second", second);
        assert!(!bounded.sessions.contains_key("first"));
        assert!(bounded.sessions.contains_key("second"));
    }

    /// An image carrier in the trigger's boundary accounting is counted from its pixel
    /// dimensions and never reaches the text tokenizer, however large its payload or however
    /// many carriers there are; the text beside it still tokenizes once per block.
    #[test]
    fn trigger_boundary_image_carrier_tokenization_cost_is_bounded() {
        use crate::ck_wire::{
            CkIngressMessage, CkKind, CkWireBlock, CkWireMessage, HarnessMeta, MediaBlock,
            MediaKind, ProviderExtras,
        };
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/image-token-parity.json")).unwrap();
        let png = cases
            .iter()
            .find(|case| case["name"] == "png-1920x1080")
            .unwrap();
        let (_, header_payload) = png["url"].as_str().unwrap().split_once(',').unwrap();
        let expected = png["tokens"].as_u64().unwrap() as usize;
        for (carriers, payload_bytes) in [(1usize, 64usize), (64, 65_536)] {
            // A real header followed by filler, so the payload grows but the image does not.
            let data = format!(
                "{header_payload}{}",
                "A".repeat(payload_bytes.saturating_sub(header_payload.len()))
            );
            let messages = (0..carriers)
                .map(|index| CkIngressMessage {
                    mid: format!("carrier-{index}"),
                    ordinal: index as u64 + 1,
                    ck: CkWireMessage::from_parts(
                        "user",
                        vec![
                            CkWireBlock::bare(CkKind::Text {
                                text: format!("caption {index}"),
                            }),
                            CkWireBlock::bare(CkKind::Media(MediaBlock {
                                kind: MediaKind::Image,
                                media_type: "image/png".to_string(),
                                filename: None,
                                source: json!({ "type": "data_base64", "data": data }),
                            })),
                        ],
                        None,
                        ProviderExtras::new(),
                        HarnessMeta::default(),
                    ),
                })
                .collect::<Vec<_>>();
            let request = transform_request(messages, 140_000, 200_000);
            let projection = crate::ck_wire::project_messages(&request.messages).unwrap();
            let token_cache =
                Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
            let built = boundary_messages(&request, &projection, &token_cache);
            assert_eq!(
                built.tokenized_blocks, carriers,
                "only the captions reach the tokenizer ({carriers} carriers of {payload_bytes} bytes)"
            );
            for message in &built.messages {
                let image = message
                    .blocks
                    .iter()
                    .find(|block| matches!(block.kind, SelKind::Media))
                    .unwrap();
                assert_eq!(image.original_token_count, expected);
            }
        }
    }

    #[test]
    fn historian_trigger_token_reuse_matches_retokenized_production_shape() {
        let cold_request = transform_request(trigger_ingress_fixture(1_400, 24), 140_000, 200_000);
        let cold_projection = crate::ck_wire::project_messages(&cold_request.messages).unwrap();
        let warm_request = transform_request(trigger_ingress_fixture(1_401, 24), 140_000, 200_000);
        let warm_projection = crate::ck_wire::project_messages(&warm_request.messages).unwrap();
        let token_cache = Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
        let cold = boundary_messages(&cold_request, &cold_projection, &token_cache);
        assert_eq!(cold.tokenized_blocks, 1_400);
        token_cache
            .lock()
            .unwrap()
            .replace(&cold_request.session_id, cold.token_cache_snapshot);
        let warm = boundary_messages(&warm_request, &warm_projection, &token_cache);
        assert_eq!(
            warm.tokenized_blocks, 1,
            "only the appended block retokenizes"
        );

        for (pass, messages) in [("cold", cold.messages), ("warm", warm.messages)] {
            let cases = [
                ("empty", Vec::new(), Vec::new()),
                ("pending", vec![pending_drop("m-100#0")], Vec::new()),
                (
                    "frozen",
                    vec![pending_drop("m-100#0")],
                    vec![frozen_drop("m-100#0"), frozen_drop("retired#0")],
                ),
            ];
            for (case, pending, frozen) in cases {
                let reference_projection = projected_post_drop_percentage_retokenized_reference(
                    &messages, &pending, &frozen, 140_000.0, 200_000.0,
                );
                let optimized_projection = projected_post_drop_percentage(
                    &messages, &pending, &frozen, 140_000.0, 200_000.0,
                );
                assert_eq!(
                    optimized_projection, reference_projection,
                    "projection: {pass}/{case}"
                );

                let context = TriggerContext {
                    boundary: BoundaryContext {
                        calibration: None,
                        context_limit: 200_000.0,
                        execute_threshold_percentage: 65.0,
                        usage_percentage: 70.0,
                        usage_input_tokens: 140_000.0,
                        last_compartment_end_ordinal: None,
                        prior_boundary_ordinal: 0,
                        migration_floor_active: false,
                        emergency_tail_scale: None,
                        trigger_budget: Some(4_000.0),
                        fold_is_only_reclaim: false,
                    },
                    projected_post_drop_percentage: optimized_projection,
                    reclaim_ride_available: true,
                    compartment_in_progress: false,
                    commit_cluster_trigger_enabled: true,
                    min_commit_clusters: 2,
                };
                let mut reference_context = context.clone();
                reference_context.projected_post_drop_percentage = reference_projection;
                assert_eq!(
                    boundary::check_compartment_trigger(&messages, &context),
                    boundary::check_compartment_trigger_retokenized_reference(
                        &messages,
                        &reference_context,
                    ),
                    "trigger decision and progress: {pass}/{case}",
                );
            }
        }
    }

    #[test]
    fn historian_trigger_cache_engages_at_astro_message_count() {
        const MESSAGE_COUNT: usize = 4_667;
        let cold_request =
            transform_request(trigger_ingress_fixture(MESSAGE_COUNT, 24), 140_000, 200_000);
        let cold_projection = crate::ck_wire::project_messages(&cold_request.messages).unwrap();
        let token_cache = Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
        let cold_started_at = Instant::now();
        let cold = boundary_messages(&cold_request, &cold_projection, &token_cache);
        let cold_ms = cold_started_at.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(cold.tokenized_blocks, MESSAGE_COUNT);
        token_cache
            .lock()
            .unwrap()
            .replace(&cold_request.session_id, cold.token_cache_snapshot);

        let warm_started_at = Instant::now();
        let warm = boundary_messages(&cold_request, &cold_projection, &token_cache);
        let warm_ms = warm_started_at.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            warm.tokenized_blocks, 0,
            "steady ASTRO-scale pass must reuse the session-keyed trigger cache"
        );
        eprintln!(
            "trigger-cache-astro n={MESSAGE_COUNT} blocks={} cold_ms={cold_ms:.1} warm_ms={warm_ms:.1} warm_tokenized={}",
            cold_projection.blocks.len(),
            warm.tokenized_blocks,
        );
    }

    #[test]
    #[ignore = "run manually to compare production-sized historian trigger cost"]
    fn historian_trigger_token_reuse_benchmark() {
        let reference_cold = trigger_messages_fixture(1_400, 2_048);
        let reference_warm = trigger_messages_fixture(1_401, 2_048);
        let cold_request =
            transform_request(trigger_ingress_fixture(1_400, 2_048), 100_000, 200_000);
        let cold_projection = crate::ck_wire::project_messages(&cold_request.messages).unwrap();
        let warm_request =
            transform_request(trigger_ingress_fixture(1_401, 2_048), 100_000, 200_000);
        let warm_projection = crate::ck_wire::project_messages(&warm_request.messages).unwrap();
        let context = TriggerContext {
            boundary: BoundaryContext {
                calibration: None,
                context_limit: 200_000.0,
                execute_threshold_percentage: 65.0,
                usage_percentage: 50.0,
                usage_input_tokens: 100_000.0,
                last_compartment_end_ordinal: None,
                prior_boundary_ordinal: 0,
                migration_floor_active: false,
                emergency_tail_scale: None,
                trigger_budget: None,
                fold_is_only_reclaim: false,
            },
            projected_post_drop_percentage: Some(50.0),
            reclaim_ride_available: true,
            compartment_in_progress: false,
            commit_cluster_trigger_enabled: true,
            min_commit_clusters: 2,
        };
        let mut before_cold = Vec::new();
        let mut before_warm = Vec::new();
        let mut after_cold = Vec::new();
        let mut after_warm = Vec::new();
        let mut warm_boundary_build = Vec::new();
        let mut warm_trigger_scan = Vec::new();
        for _ in 0..3 {
            for (template, samples) in [
                (&reference_cold, &mut before_cold),
                (&reference_warm, &mut before_warm),
            ] {
                let started_at = Instant::now();
                let messages = template.clone();
                let projected = projected_post_drop_percentage_retokenized_reference(
                    &messages,
                    &[],
                    &[],
                    100_000.0,
                    200_000.0,
                );
                let mut reference_context = context.clone();
                reference_context.projected_post_drop_percentage = projected;
                std::hint::black_box(boundary::check_compartment_trigger_retokenized_reference(
                    std::hint::black_box(&messages),
                    std::hint::black_box(&reference_context),
                ));
                samples.push(started_at.elapsed().as_secs_f64() * 1_000.0);
            }

            let token_cache =
                Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
            let started_at = Instant::now();
            let mut cold = boundary_messages(&cold_request, &cold_projection, &token_cache);
            assert_eq!(cold.tokenized_blocks, 1_400);
            let projected =
                projected_post_drop_percentage(&cold.messages, &[], &[], 100_000.0, 200_000.0);
            let mut optimized_context = context.clone();
            optimized_context.projected_post_drop_percentage = projected;
            {
                let mut cold_token_estimator =
                    |bytes: &str| cold.token_cache_snapshot.formatted_token_count(bytes);
                std::hint::black_box(boundary::check_compartment_trigger_with_token_estimator(
                    std::hint::black_box(&cold.messages),
                    std::hint::black_box(&optimized_context),
                    &mut cold_token_estimator,
                ));
            }
            token_cache
                .lock()
                .unwrap()
                .replace(&cold_request.session_id, cold.token_cache_snapshot);
            after_cold.push(started_at.elapsed().as_secs_f64() * 1_000.0);

            let started_at = Instant::now();
            let mut warm = boundary_messages(&warm_request, &warm_projection, &token_cache);
            warm_boundary_build.push(started_at.elapsed().as_secs_f64() * 1_000.0);
            assert_eq!(warm.tokenized_blocks, 1);
            let projected =
                projected_post_drop_percentage(&warm.messages, &[], &[], 100_000.0, 200_000.0);
            optimized_context.projected_post_drop_percentage = projected;
            let trigger_started_at = Instant::now();
            {
                let mut warm_token_estimator =
                    |bytes: &str| warm.token_cache_snapshot.formatted_token_count(bytes);
                std::hint::black_box(boundary::check_compartment_trigger_with_token_estimator(
                    std::hint::black_box(&warm.messages),
                    std::hint::black_box(&optimized_context),
                    &mut warm_token_estimator,
                ));
            }
            warm_trigger_scan.push(trigger_started_at.elapsed().as_secs_f64() * 1_000.0);
            token_cache
                .lock()
                .unwrap()
                .replace(&warm_request.session_id, warm.token_cache_snapshot);
            after_warm.push(started_at.elapsed().as_secs_f64() * 1_000.0);
        }
        before_cold.sort_by(f64::total_cmp);
        before_warm.sort_by(f64::total_cmp);
        after_cold.sort_by(f64::total_cmp);
        after_warm.sort_by(f64::total_cmp);
        warm_boundary_build.sort_by(f64::total_cmp);
        warm_trigger_scan.sort_by(f64::total_cmp);
        eprintln!(
            "historian-trigger messages=1400 payload_bytes=2048 before_cold_ms={:.1} \
             before_warm_append_ms={:.1} after_cold_ms={:.1} after_warm_append_ms={:.1} \
             warm_boundary_ms={:.1} warm_scan_ms={:.1}",
            before_cold[1],
            before_warm[1],
            after_cold[1],
            after_warm[1],
            warm_boundary_build[1],
            warm_trigger_scan[1],
        );
        assert!(
            after_warm[1] < after_cold[1],
            "after_cold={after_cold:?} after_warm={after_warm:?}"
        );
        assert!(
            after_warm[1] < 150.0,
            "warm trigger target missed: after_warm={after_warm:?}"
        );
    }

    #[test]
    fn projected_post_drop_pressure_uses_pending_blocks_and_frozen_replacements() {
        let messages = vec![BoundaryMsg {
            message_ordinal: 1,
            message_id: "m1".to_string(),
            role: Role::User,
            blocks: vec![BoundaryBlock {
                id: "drop#0".to_string(),
                ordinal: 0,
                kind: SelKind::Text,
                provider_executed: false,
                byte_size: 400,
                arc_id: None,
                original: Arc::from("x".repeat(400)),
                original_token_count: mc_tokenizer::estimate_tokens(&"x".repeat(400)),
                rendered: None,
                ignored: false,
            }],
        }];
        let pending = vec![PendingAgentDrop {
            id: 1,
            target_id: "drop#0".to_string(),
            queued_at_ms: 0,
            command_id: None,
            command_first_applied_at_ms: None,
        }];
        let frozen = [mc_core::FrozenUnit {
            key: "red:drop#0".to_string(),
            kind: "drop".to_string(),
            frozen_payload: "[dropped]".to_string(),
            durability_class: mc_core::DurabilityClass::Lineage,
            reset_rule: String::new(),
        }];
        let projected =
            projected_post_drop_percentage(&messages, &pending, &frozen, 60_000.0, 100_000.0)
                .expect("live blocks provide a denominator");
        assert!(projected.abs() < f64::EPSILON, "projected={projected}");
    }

    #[test]
    fn trigger_suppresses_fire_when_projected_drops_hit_relative_target() {
        let block = |id: &str, text: &str| BoundaryBlock {
            id: id.to_string(),
            ordinal: 0,
            kind: SelKind::Text,
            provider_executed: false,
            byte_size: text.len(),
            arc_id: None,
            original: Arc::from(text),
            original_token_count: mc_tokenizer::estimate_tokens(text),
            rendered: None,
            ignored: false,
        };
        let mut messages = Vec::new();
        for ordinal in 1..=5 {
            messages.push(BoundaryMsg {
                message_ordinal: ordinal,
                message_id: format!("assistant-{ordinal}"),
                role: Role::Assistant,
                blocks: vec![block(
                    &format!("assistant-{ordinal}#0"),
                    &"alpha beta gamma delta epsilon ".repeat(400),
                )],
            });
        }
        messages.push(BoundaryMsg {
            message_ordinal: 6,
            message_id: "user-6".to_string(),
            role: Role::User,
            blocks: vec![block("user-6#0", "keep this prompt")],
        });
        let boundary = BoundaryContext {
            calibration: None,
            context_limit: 1_000.0,
            execute_threshold_percentage: 65.0,
            usage_percentage: 70.0,
            usage_input_tokens: 700.0,
            last_compartment_end_ordinal: None,
            prior_boundary_ordinal: 0,
            migration_floor_active: false,
            emergency_tail_scale: None,
            trigger_budget: Some(10_000.0),
            fold_is_only_reclaim: false,
        };
        let mut context = TriggerContext {
            boundary,
            projected_post_drop_percentage: None,
            reclaim_ride_available: true,
            compartment_in_progress: false,
            commit_cluster_trigger_enabled: false,
            min_commit_clusters: 2,
        };
        let initial = boundary::check_compartment_trigger(&messages, &context);
        assert!(initial.fire, "initial trigger decision: {initial:?}");
        context.projected_post_drop_percentage = Some(48.75);
        let projected = boundary::check_compartment_trigger(&messages, &context);
        assert!(!projected.fire, "projected trigger decision: {projected:?}");
    }

    #[test]
    fn profile_render_epoch_is_profile_specific_and_zero_for_unchanged_profiles() {
        assert_eq!(MEMORY_RENDER_FORMAT_EPOCH, 3);
        assert_eq!(PROFILE_EPOCH_OPENCODE_AI_SDK, 2);
        assert_eq!(
            profile_render_epoch(SerializerProfile::ClaudeCodeAnthropic),
            PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC
        );
        assert_eq!(profile_render_epoch(SerializerProfile::OwnedLlmRunner), 0);
        assert_eq!(profile_render_epoch(SerializerProfile::OwnedBroca), 0);
        assert_eq!(
            profile_render_epoch(SerializerProfile::Pi),
            PROFILE_EPOCH_PI
        );
        assert_eq!(
            profile_render_epoch(SerializerProfile::OpencodeAiSdk),
            PROFILE_EPOCH_OPENCODE_AI_SDK
        );
    }

    #[test]
    fn dev_descriptor_used_when_ack_has_no_storage() {
        let d = resolve_descriptor(None);
        assert_eq!(d.module_id, DEFAULT_MODULE_ID);
        assert_eq!(d.storage_namespace, STORAGE_NAMESPACE);
        match d.backend {
            StorageBackend::Sqlite { path } => assert!(path.ends_with("store.db")),
            other => panic!("expected sqlite backend, got {other:?}"),
        }
    }

    #[test]
    fn ack_storage_is_preferred_when_present() {
        let provided = StorageDescriptor {
            module_id: "magic-context".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: "/managed/path/store.db".to_string(),
            },
        };
        let value = serde_json::to_value(&provided).unwrap();
        let resolved = resolve_descriptor(Some(&value));
        match resolved.backend {
            StorageBackend::Sqlite { path } => assert_eq!(path, "/managed/path/store.db"),
            other => panic!("expected sqlite backend, got {other:?}"),
        }
    }

    fn short_store_open_policy(wait_window: Duration) -> StoreOpenPolicy {
        StoreOpenPolicy {
            wait_window,
            initial_backoff: Duration::from_millis(10),
            max_backoff: Duration::from_millis(20),
            request_wait: STORE_OPENING_REQUEST_WAIT,
        }
    }

    async fn wait_for_store_open_phase(handler: &McHandler, phase: u8) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while handler.store_open.phase.load(Ordering::Acquire) != phase {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("store open phase should advance");
    }

    /// The handle is a bare `Option`, so its emptiness cannot say WHICH state holds. These two
    /// states need opposite operator actions (wait for the other process to exit vs. find out why
    /// no ack arrived), so one shared code would be useless in both.
    #[test]
    fn missing_context_db_facade_refusal_names_provisioning_command() {
        let refusal = StoreRefusal::Failed {
            reason_code: "context_db_missing".to_string(),
            reason: "no context.db".to_string(),
            origin: "test",
            descriptor: "scratch".to_string(),
        };
        assert_eq!(refusal.code(), "context_db_missing");
        match refusal.into_facade_outcome() {
            HandlerOutcome::Error { code, message } => {
                assert_eq!(code, "context_db_missing");
                assert!(message.contains("npx @cortexkit/magic-context doctor store init"));
            }
            _ => panic!("expected a user-facing missing-store refusal"),
        }
    }

    /// `ck module status` reads the health lane, so an open that failed terminally has to be
    /// visible there too — otherwise the only record of the reason is this process's stderr.
    #[tokio::test]
    async fn health_reports_the_terminal_store_open_failure_reason() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(60)));

        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_IDLE).await;
        let report = <McHandler as ModuleHandler>::health(&handler).await;

        assert_eq!(report.status, HealthStatus::Failing);
        let detail = report
            .detail
            .expect("a failed open must carry a health detail");
        assert!(detail.contains("storage open failed"), "{detail}");
        assert!(detail.contains("lease"), "{detail}");
        let metrics = report
            .metrics
            .expect("a failed open must carry health metrics");
        assert_eq!(metrics["storage_state"], "open_failed");
        assert_eq!(metrics["storage_descriptor_origin"], "dev_fallback");
        assert!(
            metrics["storage_open_failure_reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("lease")),
            "{metrics}"
        );
    }

    /// An open that failed for an ordinary reason must NOT borrow the single-store name, or the
    /// named reason stops distinguishing anything.
    #[tokio::test]
    async fn an_ordinary_failed_open_carries_the_generic_reason_code() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(60)));

        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_WAITING).await;
        wait_for_store_open_phase(&handler, STORE_OPEN_IDLE).await;

        let report = <McHandler as ModuleHandler>::health(&handler).await;
        let metrics = report
            .metrics
            .expect("a failed open must carry health metrics");
        assert_eq!(
            metrics["storage_open_failure_reason_code"],
            STORE_OPEN_FAILURE_REASON_GENERIC
        );
    }

    #[tokio::test]
    async fn double_store_open_during_lease_wait_has_one_waiter() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(500)));

        handler.begin_store_open(descriptor.clone(), DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_WAITING).await;
        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        tokio::time::sleep(Duration::from_millis(30)).await;

        assert_eq!(handler.store_open.waiter_starts.load(Ordering::Relaxed), 1);
        assert_eq!(handler.store_open.active_waiters.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn shutdown_cancels_store_lease_wait_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_secs(5)));
        let coordinator = Arc::clone(&handler.store_open);

        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_WAITING).await;
        drop(handler);
        tokio::time::timeout(Duration::from_millis(200), async {
            while coordinator.active_waiters.load(Ordering::Acquire) != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("store lease waiter should stop on handler shutdown");
    }

    #[tokio::test]
    async fn lease_wait_health_detail_advances_elapsed_time() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(500)));

        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_WAITING).await;
        let first = <McHandler as ModuleHandler>::health(&handler).await;
        tokio::time::sleep(Duration::from_millis(35)).await;
        let second = <McHandler as ModuleHandler>::health(&handler).await;

        assert_eq!(first.status, HealthStatus::Degraded);
        assert_eq!(second.status, HealthStatus::Degraded);
        let first_detail = first.detail.unwrap();
        let second_detail = second.detail.unwrap();
        assert!(first_detail.starts_with("waiting on storage lease, held by prior incarnation, "));
        assert!(second_detail.ends_with("s elapsed"));
        assert_ne!(first_detail, second_detail);
        assert!(
            second.metrics.unwrap()["storage_lease_wait_elapsed_ms"].as_u64()
                > first.metrics.unwrap()["storage_lease_wait_elapsed_ms"].as_u64()
        );
    }

    #[test]
    fn store_lease_wait_defaults_to_sixty_seconds() {
        assert_eq!(
            StoreOpenPolicy::default().wait_window,
            Duration::from_secs(60)
        );
    }

    #[test]
    fn supported_fences_report_plugin_and_store_ceilings() {
        let line = supported_fences_line();
        assert_eq!(
            line,
            format!(
                "context.db={} store.db={LATEST_MIGRATION_VERSION}",
                mc_store::move_inventory::CONTEXT_SCHEMA_VERSION
            )
        );
    }

    #[test]
    fn version_line_carries_the_build_sha_when_stamped() {
        let line = version_line();
        let expected_prefix = format!("ck-mc {}", env!("CARGO_PKG_VERSION"));
        assert!(line.starts_with(&expected_prefix), "got {line}");
        match option_env!("MC_BUILD_SHA") {
            Some(sha) if !sha.trim().is_empty() => {
                assert_eq!(line, format!("{expected_prefix} ({})", sha.trim()));
                // A train tag id is a short prefix of the full sha; acceptance
                // checks the tag id as a substring of this line.
                assert!(line.contains(&sha.trim()[..8.min(sha.trim().len())]));
            }
            _ => assert_eq!(line, expected_prefix),
        }
    }

    #[test]
    fn manifest_declares_module_id_and_storage() {
        let m = manifest("magic-context");
        assert_eq!(m.module_id, "magic-context");
        assert_eq!(m.module_version, env!("CARGO_PKG_VERSION"));
        // Both optional 0.19 fields are pinned in their TRUE direction on the struct AND on
        // the serialized HELLO (a field can be set and still skipped at serialization):
        // first-party is a fact, so it is present; no expressible storage scope is true of a
        // machine-shared store, so bindings is absent.
        assert_eq!(m.trust_tier, Some(TrustTier::FirstParty));
        assert_eq!(
            m.bindings, None,
            "bindings must stay absent: the store is machine-scoped"
        );
        let wire = serde_json::to_value(&m).expect("manifest serializes");
        assert_eq!(wire["trust_tier"], serde_json::json!("first_party"));
        assert!(
            wire.get("bindings").is_none() || wire["bindings"].is_null(),
            "bindings must not appear on the wire"
        );
        assert_eq!(m.protocol_ver, PROTOCOL_VERSION);
        // The default runner route spends provider quota for the historian and the
        // classify task, so both are declared.
        assert_eq!(
            m.self_signals
                .as_ref()
                .expect("self_signals must be declared, not omitted")
                .iter()
                .map(|signal| signal.name.as_str())
                .collect::<Vec<_>>(),
            ["historian_firing", "dreamer_classify"]
        );
        assert_eq!(
            wire["self_signals"][0]["domain"],
            serde_json::json!("provider-usage")
        );
        // Provenance is stamped by the subc-protocol build_provenance helper.
        // The wire_crate_version is always present (a compile-time constant of
        // the linked subc-protocol crate); build_git_sha is present only when
        // MC_BUILD_SHA was set at compile time.
        let provenance = m
            .provenance
            .as_ref()
            .expect("manifest must carry provenance");
        assert_eq!(
            provenance.wire_crate_version.as_deref(),
            Some(subc_protocol::SUBC_PROTOCOL_CRATE_VERSION)
        );
        assert_eq!(
            provenance.build_git_sha.as_deref(),
            option_env!("MC_BUILD_SHA"),
            "build_git_sha must mirror the compile-time MC_BUILD_SHA exactly"
        );
        assert_eq!(
            m.consumes,
            vec![ConsumerRole::ServiceClient {
                of: route_targets::expected_routes_for_tests("broca")
            }]
        );
        let mut expected_capabilities = vec![
            "compaction-provider/v1".to_string(),
            "mcp-conversation-binding/v1".to_string(),
            "flow-scopes/v1".to_string(),
        ];
        if agent_data::ENABLED {
            expected_capabilities.push(cortexkit_role_agent_data::PROVIDES.to_string());
        }
        assert_eq!(
            m.capabilities.as_ref().map(|c| &c.provides),
            Some(&expected_capabilities),
            "capability list is pinned"
        );
        let ProviderRole::ToolProvider { tools, .. } = &m.provides[0] else {
            panic!("magic-context must expose a tool provider role");
        };
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "transform",
                "ctx_reduce",
                "ctx_memory",
                "ctx_expand",
                "ctx_search",
                "ctx_note",
            ],
            "the default startup manifest keeps its legacy byte order"
        );
        let by_name = tools
            .iter()
            .map(|tool| (tool.name.as_str(), tool))
            .collect::<HashMap<_, _>>();
        for name in ["ctx_memory", "ctx_search"] {
            let tool = by_name
                .get(name)
                .unwrap_or_else(|| panic!("missing tool {name}"));
            assert_eq!(
                tool.name, name,
                "mcp.jsonc overrides use the bare tool name"
            );
            assert_eq!(tool.schema["type"], "object");
            assert!(tool.schema["properties"].is_object());
            assert!(tool.description.as_deref().is_some_and(|text| {
                !text.contains("CortexKit") && !text.contains("transform") && !text.contains('§')
            }));
        }
        assert_eq!(
            by_name["ctx_memory"].execution_mode,
            ExecutionMode::Mutating
        );
        assert_eq!(by_name["ctx_search"].execution_mode, ExecutionMode::Pure);
    }

    fn binding(root: &str, session: &str) -> SessionBinding {
        binding_with_harness(root, "mc-module-test", session)
    }

    mod binding_projects {
        use super::*;
        use subc_control::{ClientControlRequest, ClientControlResponse};
        use subc_protocol::{Flags, Frame, FrameType, Priority};
        use subc_transport::{
            authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic,
            write_frame, ConnectionInfo, Endpoint, SCHEMA_VERSION,
        };

        struct FakeEntorhinal {
            connection_file: PathBuf,
            calls: Arc<AtomicUsize>,
            reply_at: Arc<Mutex<Option<tokio::time::Instant>>>,
            task: tokio::task::JoinHandle<()>,
            _temp: tempfile::TempDir,
        }

        impl Drop for FakeEntorhinal {
            fn drop(&mut self) {
                self.task.abort();
            }
        }

        impl FakeEntorhinal {
            async fn start(reply: Option<Value>, reply_at: Option<tokio::time::Instant>) -> Self {
                Self::start_mode(reply, reply_at, false, false).await
            }

            async fn start_mode(
                reply: Option<Value>,
                reply_at: Option<tokio::time::Instant>,
                never_reply: bool,
                sleep_for_reply: bool,
            ) -> Self {
                let base = std::env::temp_dir().join("magic-context/pj-pin-async");
                std::fs::create_dir_all(&base).unwrap();
                let temp = tempfile::tempdir_in(base).unwrap();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let key = generate_key().unwrap();
                let daemon_id = generate_daemon_id().unwrap();
                let connection_file = temp.path().join("connection.json");
                write_atomic(
                    &connection_file,
                    &ConnectionInfo {
                        schema: SCHEMA_VERSION,
                        wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                        endpoints: vec![Endpoint {
                            host: address.ip().to_string(),
                            port: address.port(),
                        }],
                        key: key.clone(),
                        daemon_id,
                        pid: std::process::id(),
                        daemon_ver: "fake".into(),
                    },
                )
                .unwrap();
                let calls = Arc::new(AtomicUsize::new(0));
                let observed = calls.clone();
                let reply_at = Arc::new(Mutex::new(reply_at));
                let pending_reply_at = reply_at.clone();
                let task = tokio::spawn(async move {
                    while let Ok((mut stream, _)) = listener.accept().await {
                        authenticate_server(
                            &mut stream,
                            &key,
                            &daemon_id,
                            "fake",
                            Duration::from_secs(2),
                        )
                        .await
                        .unwrap();
                        while let Ok(Some(frame)) = read_frame(&mut stream).await {
                            if frame.header.ty != FrameType::Request {
                                continue;
                            }
                            let (ty, body) = if frame.header.channel == 0 {
                                let control: ClientControlRequest =
                                    serde_json::from_slice(&frame.body).unwrap();
                                let ClientControlRequest::RouteOpen { target, .. } = control else {
                                    continue;
                                };
                                assert_eq!(target, entorhinal_resolve::route_target());
                                (
                                    FrameType::Response,
                                    serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                        route_channel: 10,
                                        route_epoch: 1,
                                    })
                                    .unwrap(),
                                )
                            } else {
                                let request: Value = serde_json::from_slice(&frame.body).unwrap();
                                assert_eq!(request["method"], "resolve");
                                observed.fetch_add(1, Ordering::SeqCst);
                                if never_reply {
                                    std::future::pending::<()>().await;
                                }
                                let at = *pending_reply_at.lock().unwrap();
                                if let Some(at) = at {
                                    // Use an absolute instant so connect and route-open
                                    // consume the same budget as the reply wait.
                                    if sleep_for_reply {
                                        tokio::time::sleep_until(at).await;
                                    } else {
                                        while tokio::time::Instant::now() < at {
                                            tokio::task::yield_now().await;
                                        }
                                    }
                                }
                                match &reply {
                                    Some(reply) => (FrameType::Response, serde_json::to_vec(reply).unwrap()),
                                    None => (FrameType::Error, serde_json::to_vec(&json!({"code":"unknown_module", "message":"absent", "detail":null})).unwrap()),
                                }
                            };
                            let response = Frame::build(
                                ty,
                                Flags::new(false, Priority::Interactive, false),
                                frame.header.channel,
                                frame.header.epoch,
                                frame.header.corr,
                                body,
                            )
                            .unwrap();
                            if write_frame(&mut stream, &response).await.is_err() {
                                break;
                            }
                        }
                    }
                });
                Self {
                    connection_file,
                    calls,
                    reply_at,
                    task,
                    _temp: temp,
                }
            }
        }

        fn fixture() -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
            let (mut handler, store, temp, project) = handler_with_store_and_resolver(
                Arc::new(ProducerState::default()),
                default_test_config(),
                Arc::new(MissingSessionResolver),
            );
            handler.project_identities =
                Arc::new(project_identity::ProjectIdentityResolver::with_sidecar_dir(
                    temp.path().join("sidecars"),
                ));
            handler
                .resolve_project_identity_for_test
                .store(true, Ordering::Relaxed);
            (
                handler,
                store,
                temp,
                std::fs::canonicalize(project).unwrap(),
            )
        }

        fn root_reply(project: &Path) -> Value {
            let vectors: Value = serde_json::from_str(include_str!(
                "../../../test-vectors/project-resolve-v1/resolve.json"
            ))
            .unwrap();
            let mut reply = vectors[0]["reply"].clone();
            reply["result"]["canonicalRoot"] = json!(project);
            reply
        }

        async fn bind(handler: &McHandler, project: &Path, channel: u16) {
            let identity = serde_json::from_value(json!({
                "project_root": project, "harness": "opencode", "session": "ses"
            }))
            .unwrap();
            let request = RouteBindRequest::new(
                RouteHandle::detached(channel, 1),
                RouteTargetConfig::runner_module("magic-context")
                    .target(route_targets::RegisteredRoute::HistorianRunner)
                    .unwrap(),
                identity,
            );
            let _decision = handler.on_bind(&request).await;
            assert!(handler.bindings.lock().unwrap().contains_key(&channel));
        }

        fn row(store: &McStore, identity: &str) {
            store.with_context_conn_for_test(|db| {
                db.execute("INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES ('ses', 'opencode', ?1, 1) ON CONFLICT(session_id, harness) DO UPDATE SET project_path = excluded.project_path, updated_at = updated_at + 1", [identity])
            }).unwrap();
        }

        fn served(handler: &McHandler, store: &McStore, channel: u16) -> String {
            let binding = handler.facade_binding(channel).unwrap();
            handler
                .route_project(channel, store, &binding)
                .unwrap_or_else(|_| panic!("project resolution failed"))
                .key
        }

        #[tokio::test]
        async fn host_row_at_bind_skips_resolve_and_first_request_reads_latest_row() {
            let (mut handler, store, _temp, project) = fixture();
            let fake = FakeEntorhinal::start(Some(root_reply(&project)), None).await;
            handler.entorhinal =
                entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
            row(&store, "pj-A");
            bind(&handler, &project, 7).await;
            row(&store, "pj-B");
            assert_eq!(served(&handler, &store, 7), "pj-B");
            assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn no_host_row_resolves_at_bind_and_requests_keep_the_decision() {
            let (mut handler, store, temp, project) = fixture();
            let reply = root_reply(&project);
            let expected = reply["result"]["projectId"].as_str().unwrap().to_string();
            let fake = FakeEntorhinal::start(Some(reply), None).await;
            handler.entorhinal =
                entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
            bind(&handler, &project, 7).await;
            assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
            // Removing the pin distinguishes the stored decision from a fresh
            // directory lookup that would otherwise return the same identity.
            handler.project_identities.flush_pins();
            std::fs::remove_dir_all(temp.path().join("sidecars")).unwrap();
            for _ in 0..3 {
                assert_eq!(served(&handler, &store, 7), expected);
            }
            assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
            for changed in ["git:changed", "pj-changed"] {
                row(&store, changed);
                assert_eq!(served(&handler, &store, 7), expected);
            }
        }

        #[cfg(unix)]
        #[test]
        fn on_bind_latency_distribution_isolated() {
            let base = std::env::temp_dir().join("magic-context/pj-pin-async");
            std::fs::create_dir_all(&base).unwrap();
            let root = tempfile::tempdir_in(base).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::binding_projects::on_bind_latency_host",
                    "--ignored",
                    "--nocapture",
                ])
                .env("MC_BIND_LATENCY_ROOT", root.path())
                .env("HOME", root.path().join("home"))
                .env("XDG_DATA_HOME", root.path())
                .env("XDG_CONFIG_HOME", root.path().join("config"))
                .env("XDG_STATE_HOME", root.path().join("state"))
                .env("XDG_RUNTIME_DIR", root.path().join("run"))
                .env("MAGIC_CONTEXT_STORAGE_DIR", root.path().join("storage"))
                .env("MAGIC_CONTEXT_TEST_DATA_DIR", root.path())
                .env("OPENCODE_DB", root.path().join("opencode.db"))
                .output()
                .unwrap();
            println!("{}", String::from_utf8_lossy(&output.stdout));
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("BIND_LATENCY never n=50"));
        }

        #[tokio::test]
        async fn on_bind_slow_pin_writer_latency_distribution() {
            use mc_store::private_permissions::write_file_atomic;
            use project_identity::pin_writer::PinWriter;

            for delay_ms in [0, 1_000] {
                let base = std::env::temp_dir().join("magic-context/pj-pin-async");
                std::fs::create_dir_all(&base).unwrap();
                let temp = tempfile::tempdir_in(base).unwrap();
                let store = Arc::new(
                    McStore::open_for_test(&dev_descriptor_at(temp.path().to_str().unwrap()))
                        .unwrap(),
                );
                let mut handler = McHandler::with_producer_factory_config_resolver(
                    Arc::new(TestProducerFactory {
                        state: Arc::new(ProducerState::default()),
                    }),
                    default_test_config(),
                    Arc::new(MissingSessionResolver),
                );
                handler.store.set(store.clone()).ok().unwrap();
                handler
                    .resolve_project_identity_for_test
                    .store(true, Ordering::Relaxed);
                let (started_send, started_recv) = std::sync::mpsc::channel();
                let writes = Arc::new(AtomicUsize::new(0));
                let observed = writes.clone();
                let writer = PinWriter::new(Arc::new(move |path, bytes, private| {
                    let _ = started_send.send(());
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    observed.fetch_add(1, Ordering::SeqCst);
                    write_file_atomic(path, bytes, private)
                }));
                handler.project_identities =
                    Arc::new(project_identity::ProjectIdentityResolver::with_pin_writer(
                        temp.path().join("sidecars"),
                        writer.clone(),
                    ));
                let mut samples = Vec::new();
                for iteration in 0..50 {
                    let project = temp.path().join(format!("pin-{delay_ms}-{iteration}"));
                    std::fs::create_dir(&project).unwrap();
                    let fake = FakeEntorhinal::start(Some(root_reply(&project)), None).await;
                    handler.entorhinal = entorhinal_resolve::EntorhinalResolver::new(Some(
                        fake.connection_file.clone(),
                    ));
                    assert!(store.session_project_identity("ses").unwrap().is_none());
                    let started = std::time::Instant::now();
                    bind(&handler, &project, 7).await;
                    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
                    samples.push(elapsed);
                    assert!(
                        elapsed < 500.0,
                        "bind waited for pin writer ({delay_ms} ms): {elapsed:.3} ms"
                    );
                    assert_eq!(served(&handler, &store, 7), "pj-resolve-root");
                    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
                }
                samples.sort_by(f64::total_cmp);
                println!(
                    "PIN_BIND_LATENCY writer_delay_ms={delay_ms} n=50 p50_ms={:.3} p99_ms={:.3}",
                    samples[24], samples[49]
                );
                started_recv.recv_timeout(Duration::from_secs(2)).unwrap();
                // A bounded shutdown may abandon queued work, but cannot cancel
                // the atomic write already running. Keep its temporary root alive.
                writer.shutdown(Duration::from_millis(250));
                assert!(writer.flush(Duration::from_secs(2)));
                assert!(
                    writes.load(Ordering::SeqCst) > 0,
                    "injected writer never ran"
                );
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        #[ignore = "spawned by on_bind_latency_distribution_isolated with a throwaway root"]
        async fn on_bind_latency_host() {
            let root = PathBuf::from(
                std::env::var_os("MC_BIND_LATENCY_ROOT").expect("isolated host only"),
            );
            let store = Arc::new(
                McStore::open_for_test(&dev_descriptor_at(root.to_str().unwrap())).unwrap(),
            );
            let descriptors = std::process::Command::new("lsof")
                .args(["-p", &std::process::id().to_string(), "-Fn"])
                .output()
                .unwrap();
            assert!(descriptors.status.success());
            let descriptors = String::from_utf8(descriptors.stdout).unwrap();
            let databases: Vec<_> = descriptors
                .lines()
                .filter(|line| line.starts_with('n') && line.contains(".db"))
                .collect();
            assert!(!databases.is_empty());
            for database in &databases {
                assert!(Path::new(&database[1..]).starts_with(&root), "{database}");
            }
            println!("lsof -p {}: {databases:?}", std::process::id());
            for mode in ["immediate", "near-deadline", "never"] {
                let mut samples = Vec::new();
                for iteration in 0..50 {
                    let project = root.join(format!("{mode}-{iteration}"));
                    std::fs::create_dir(&project).unwrap();
                    let project = std::fs::canonicalize(project).unwrap();
                    let mut handler = McHandler::with_producer_factory_config_resolver(
                        Arc::new(TestProducerFactory {
                            state: Arc::new(ProducerState::default()),
                        }),
                        default_test_config(),
                        Arc::new(MissingSessionResolver),
                    );
                    handler.store.set(store.clone()).ok().unwrap();
                    handler.project_identities =
                        Arc::new(project_identity::ProjectIdentityResolver::with_sidecar_dir(
                            root.join(format!("sidecars-{mode}-{iteration}")),
                        ));
                    handler
                        .resolve_project_identity_for_test
                        .store(true, Ordering::Relaxed);
                    let reply = root_reply(&project);
                    let expected = reply["result"]["projectId"].as_str().unwrap().to_string();
                    let fake =
                        FakeEntorhinal::start_mode(Some(reply), None, mode == "never", true).await;
                    handler.entorhinal = entorhinal_resolve::EntorhinalResolver::new(Some(
                        fake.connection_file.clone(),
                    ));
                    assert!(store.session_project_identity("ses").unwrap().is_none());
                    let started = tokio::time::Instant::now();
                    let started_unix_us = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_micros();
                    // A near-deadline peer answers 50 ms inside the resolve deadline. A
                    // 5 ms margin let a loaded runner deliver the answer after the deadline,
                    // where the bind correctly falls back to the directory identity.
                    let near_deadline_ms = entorhinal_resolve::ENTORHINAL_RESOLVE_DEADLINE_MS - 50;
                    if mode == "near-deadline" {
                        *fake.reply_at.lock().unwrap() =
                            Some(started + Duration::from_millis(near_deadline_ms));
                    }
                    let bind_future = bind(&handler, &project, 7);
                    if mode == "never" {
                        tokio::time::timeout(Duration::from_secs(1), bind_future)
                            .await
                            .expect("bind failed to return after resolve timeout");
                    } else {
                        bind_future.await;
                    }
                    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                    if elapsed > 600.0 {
                        println!("BIND_LATENCY_SLOW {mode} iteration={iteration} started_unix_us={started_unix_us} elapsed_ms={elapsed:.3}");
                    }
                    if mode == "near-deadline" {
                        assert!(
                            elapsed >= near_deadline_ms as f64,
                            "near-deadline peer answered early: {elapsed}"
                        );
                    }
                    samples.push(elapsed);
                    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
                    // The network deadline does not include background persistence.
                    if mode == "never" {
                        assert!(
                            elapsed < 1_000.0,
                            "bind failed to return after resolve timeout: {elapsed}"
                        );
                        assert!(handler
                            .project_identities
                            .pinned_identity(&project)
                            .is_none());
                        assert!(served(&handler, &store, 7).starts_with("dir:"));
                    } else {
                        assert_eq!(
                            handler
                                .project_identities
                                .pinned_identity(&project)
                                .as_deref(),
                            Some(expected.as_str()),
                            "{mode} iteration {iteration}: answered bind did not pin after {elapsed:.3} ms"
                        );
                        assert_eq!(served(&handler, &store, 7), expected);
                        assert!(elapsed < 10_000.0, "bind failed to return: {elapsed}");
                    }
                    handler.project_identities.flush_pins();
                }
                samples.sort_by(f64::total_cmp);
                println!(
                    "BIND_LATENCY {mode} n=50 p50_ms={:.3} p99_ms={:.3} over_500ms={}",
                    samples[24],
                    samples[49],
                    samples.iter().filter(|ms| **ms > 500.0).count()
                );
            }
        }

        #[tokio::test]
        async fn authority_managed_defers_populated_projects_until_row_removal() {
            use tracing::instrument::WithSubscriber;
            use tracing_subscriber::prelude::*;

            for git in [false, true] {
                let (mut handler, store, temp, project) = fixture();
                if git {
                    for args in [
                        vec!["init", "--quiet"],
                        vec![
                            "-c",
                            "user.name=Fixture",
                            "-c",
                            "user.email=fixture@example.test",
                            "commit",
                            "--quiet",
                            "--allow-empty",
                            "-m",
                            "fixture",
                        ],
                    ] {
                        let output = std::process::Command::new("git")
                            .current_dir(&project)
                            .args(args)
                            .output()
                            .unwrap();
                        assert!(output.status.success(), "{output:?}");
                    }
                }
                let fallback = handler.project_identities.resolve(&project).unwrap();
                assert!(fallback.starts_with(if git { "git:" } else { "dir:" }));
                store
                    .seed_memory(1, &fallback, "CONSTRAINTS", "managed project fact", 50)
                    .unwrap();
                store.with_context_conn_for_test(|db| {
                    db.execute_batch("CREATE TABLE IF NOT EXISTS authority_managed (project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL)")?;
                    db.execute("INSERT INTO authority_managed VALUES (?1, 'fixture', 1)", [&fallback])
                }).unwrap();
                let reply = root_reply(&project);
                let expected = reply["result"]["projectId"].as_str().unwrap().to_string();
                let fake = FakeEntorhinal::start(Some(reply), None).await;
                handler.entorhinal =
                    entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
                let logs = tempfile::tempdir().unwrap();
                let mut config = cortexkit_log::Config::in_dir("magic-context", logs.path());
                config.spec = Some("warn".into());
                let (layer, log) = cortexkit_log::layer(config).unwrap();
                bind(&handler, &project, 7)
                    .with_subscriber(tracing_subscriber::registry().with(layer))
                    .await;
                for _ in 0..3 {
                    assert_eq!(served(&handler, &store, 7), fallback);
                }
                assert!(handler
                    .project_identities
                    .pinned_identity(&project)
                    .is_none());
                let lines = std::fs::read_to_string(log.path()).unwrap();
                assert_eq!(
                    lines
                        .matches("Keeping Rust-managed project identity")
                        .count(),
                    1
                );
                assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
                store
                    .with_context_conn_for_test(|db| {
                        let rows: i64 = db.query_row(
                            "SELECT COUNT(*) FROM memories WHERE project_path = ?1",
                            [&fallback],
                            |row| row.get(0),
                        )?;
                        assert_eq!(rows, 1);
                        // The offline single-store migration clears this marker, not session start.
                        db.execute_batch("DELETE FROM authority_managed")
                    })
                    .unwrap();
                bind(&handler, &project, 8).await;
                assert_eq!(served(&handler, &store, 8), expected);
                assert_eq!(served(&handler, &store, 7), fallback);
                assert_eq!(
                    handler.project_identities.pinned_identity(&project),
                    Some(expected)
                );
                assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
                handler.project_identities.flush_pins();
                assert!(temp.path().join("sidecars").exists());
            }
        }

        #[tokio::test]
        async fn authority_missing_table_or_row_allows_registered_pins() {
            for has_table in [false, true] {
                let (mut handler, store, _temp, project) = fixture();
                store.with_context_conn_for_test(|db| {
                    db.execute_batch("DROP TABLE IF EXISTS authority_managed")?;
                    if has_table {
                        db.execute_batch("CREATE TABLE authority_managed (project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL);
                            INSERT INTO authority_managed VALUES ('git:other', 'fixture', 1)")?;
                    }
                    Ok(())
                }).unwrap();
                let reply = root_reply(&project);
                let expected = reply["result"]["projectId"].as_str().unwrap().to_string();
                let fake = FakeEntorhinal::start(Some(reply), None).await;
                handler.entorhinal =
                    entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
                bind(&handler, &project, 7).await;
                assert_eq!(served(&handler, &store, 7), expected);
                assert_eq!(
                    handler.project_identities.pinned_identity(&project),
                    Some(expected)
                );
                assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
            }
        }

        #[tokio::test]
        async fn authority_query_failure_keeps_fallback_without_pinning() {
            let (mut handler, store, _temp, project) = fixture();
            let fallback = handler.project_identities.resolve(&project).unwrap();
            store
                .with_context_conn_for_test(|db| {
                    db.execute_batch(
                        "DROP TABLE IF EXISTS authority_managed;
                    CREATE TABLE authority_managed (wrong_column TEXT)",
                    )
                })
                .unwrap();
            let fake = FakeEntorhinal::start(Some(root_reply(&project)), None).await;
            handler.entorhinal =
                entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
            bind(&handler, &project, 7).await;
            assert_eq!(served(&handler, &store, 7), fallback);
            assert!(handler
                .project_identities
                .pinned_identity(&project)
                .is_none());
            assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn authority_unavailable_store_keeps_fallback_without_pinning() {
            let (mut handler, store, _temp, project) = fixture();
            let fallback = handler.project_identities.resolve(&project).unwrap();
            handler.store = Arc::new(OnceLock::new());
            let fake = FakeEntorhinal::start(Some(root_reply(&project)), None).await;
            handler.entorhinal =
                entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
            bind(&handler, &project, 7).await;
            assert_eq!(served(&handler, &store, 7), fallback);
            assert!(handler
                .project_identities
                .pinned_identity(&project)
                .is_none());
            assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn served_pj_and_fallback_bindings_reject_pj_transitions_until_rebind() {
            use tracing_subscriber::prelude::*;
            for own_decision in [false, true] {
                for (before, after) in [("pj-A", "git:B"), ("pj-A", "pj-B"), ("git:A", "pj-B")] {
                    let (handler, store, _temp, project) = fixture();
                    if !own_decision {
                        row(&store, before);
                    }
                    bind(&handler, &project, 7).await;
                    if own_decision {
                        handler
                            .binding_projects
                            .lock()
                            .unwrap()
                            .get_mut(&7)
                            .unwrap()
                            .initial = Some(Ok(before.into()));
                    }
                    assert_eq!(served(&handler, &store, 7), before);
                    row(&store, after);
                    let logs = tempfile::tempdir().unwrap();
                    let mut config = cortexkit_log::Config::in_dir("magic-context", logs.path());
                    config.spec = Some("warn".into());
                    let (layer, log) = cortexkit_log::layer(config).unwrap();
                    tracing::subscriber::with_default(
                        tracing_subscriber::registry().with(layer),
                        || {
                            for _ in 0..3 {
                                assert_eq!(served(&handler, &store, 7), before);
                            }
                        },
                    );
                    let lines = std::fs::read_to_string(log.path()).unwrap();
                    assert_eq!(
                        lines.matches("ignoring changed project identity").count(),
                        1
                    );
                    assert!(handler.binding_projects.lock().unwrap()[&7].mismatch_logged);
                    bind(&handler, &project, 8).await;
                    assert_eq!(served(&handler, &store, 8), after);
                }
            }
        }

        #[tokio::test]
        async fn absent_entorhinal_keeps_per_request_standalone_rows() {
            let (mut handler, store, _temp, project) = fixture();
            let fake = FakeEntorhinal::start(None, None).await;
            handler.entorhinal =
                entorhinal_resolve::EntorhinalResolver::new(Some(fake.connection_file.clone()));
            bind(&handler, &project, 7).await;
            assert!(served(&handler, &store, 7).starts_with("dir:"));
            row(&store, "dir:A");
            assert_eq!(served(&handler, &store, 7), "dir:A");
            row(&store, "git:A");
            assert_eq!(served(&handler, &store, 7), "git:A");
            row(&store, "git:B");
            assert_eq!(served(&handler, &store, 7), "git:B");
            assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
            assert!(!handler.binding_projects.lock().unwrap()[&7].mismatch_logged);
        }

        fn git_commit(project: &Path) -> String {
            for args in [
                vec!["init", "-q"],
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "initial",
                ],
            ] {
                assert!(std::process::Command::new("git")
                    .args(args)
                    .current_dir(project)
                    .status()
                    .unwrap()
                    .success());
            }
            let output = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(project)
                .output()
                .unwrap();
            assert!(output.status.success());
            format!("git:{}", String::from_utf8(output.stdout).unwrap().trim())
        }

        #[tokio::test]
        async fn own_fallback_does_not_adopt_a_later_pj_row() {
            for git in [false, true] {
                let (handler, store, _temp, project) = fixture();
                let expected = if git {
                    git_commit(&project)
                } else {
                    project_identity::directory_fallback(&project)
                };
                bind(&handler, &project, 7).await;
                assert_eq!(served(&handler, &store, 7), expected);
                row(&store, "pj-new");
                assert_eq!(served(&handler, &store, 7), expected);
                bind(&handler, &project, 8).await;
                assert_eq!(served(&handler, &store, 8), "pj-new");
            }
        }

        #[tokio::test]
        async fn fallback_dir_revalidates_and_paused_git_retries_without_entorhinal() {
            for broken_git in [false, true] {
                let (mut handler, store, temp, project) = fixture();
                if broken_git {
                    std::fs::write(project.join(".git"), "gitdir: /nonexistent/bind-test\n")
                        .unwrap();
                }
                bind(&handler, &project, 7).await;
                let binding = handler.facade_binding(7).unwrap();
                let before = handler
                    .route_project(7, &store, &binding)
                    .unwrap_or_else(|_| panic!("fallback failed"));
                assert_eq!(before.memory_paused.is_some(), broken_git);
                if broken_git {
                    std::fs::remove_file(project.join(".git")).unwrap();
                    // Replacing the resolver drops its cached git failure, simulating
                    // expiry of the five-minute git retry window without a long wait.
                    handler.project_identities =
                        Arc::new(project_identity::ProjectIdentityResolver::with_sidecar_dir(
                            temp.path().join("sidecars"),
                        ));
                } else {
                    assert!(before.key.starts_with("dir:"));
                }
                let expected = git_commit(&project);
                assert_eq!(served(&handler, &store, 7), expected);
                assert!(!handler
                    .memory_paused_routes
                    .lock()
                    .unwrap()
                    .contains_key(&project));
                handler
                    .project_identities
                    .pin_live_answer(&project, "pj-later", Some(&project));
                assert_eq!(served(&handler, &store, 7), expected);
            }
        }

        #[tokio::test]
        async fn move_between_pins_uses_new_binding_and_return_refreshes_row() {
            let (handler, store, temp, project) = fixture();
            let other = temp.path().join("other");
            std::fs::create_dir(&other).unwrap();
            handler
                .project_identities
                .pin_live_answer(&project, "pj-A", Some(&project));
            handler
                .project_identities
                .pin_live_answer(&other, "pj-B", Some(&other));
            row(&store, "pj-A");
            bind(&handler, &project, 7).await;
            assert_eq!(served(&handler, &store, 7), "pj-A");
            row(&store, "pj-B");
            bind(&handler, &other, 8).await;
            assert_eq!(served(&handler, &store, 8), "pj-B");
            row(&store, "pj-A");
            assert_eq!(served(&handler, &store, 7), "pj-A");
            handler.unbind_route(7);
            assert!(!handler.binding_projects.lock().unwrap().contains_key(&7));
        }

        #[tokio::test]
        async fn returning_to_open_binding_adopts_a_pin_gained_while_away() {
            let (handler, store, temp, project) = fixture();
            bind(&handler, &project, 7).await;
            assert!(served(&handler, &store, 7).starts_with("dir:"));
            let other = temp.path().join("other");
            std::fs::create_dir(&other).unwrap();
            row(&store, "pj-B");
            bind(&handler, &other, 8).await;
            assert_eq!(served(&handler, &store, 8), "pj-B");
            handler
                .project_identities
                .pin_live_answer(&project, "pj-A", Some(&project));
            row(&store, "pj-A");
            assert_eq!(served(&handler, &store, 7), "pj-A");
        }
    }

    fn binding_with_harness(root: &str, harness: &str, session: &str) -> SessionBinding {
        SessionBinding {
            principal: None,
            scope: None,
            project_root: PathBuf::from(root),
            harness: harness.to_string(),
            session: session.to_string(),
            model_key: None,
            config: default_test_config(),
            history_budget_tokens: memory_render::DEFAULT_HISTORY_BUDGET_TOKENS,
        }
    }

    // Diagnostic driver: replays captured module-request JSONs from a dump directory
    // (MC_REPLAY_DIR) through the real dispatch path against a fresh store, printing
    // per-capture outcome and wall time. No-op unless MC_REPLAY_DIR is set.
    //
    // The run doubles as cache-stability evidence for byte-splice consumers moving to
    // full-array apply: the same capture sequence is driven through TWO independent
    // fresh stores and each pass's serialized output is byte-compared across runs
    // (same input + same durable-state lineage must produce identical bytes), and
    // within a run each non-busting pass's output prefix must reproduce the previous
    // pass's output prefix byte-identically (the property the provider prompt cache
    // keys on).
    #[tokio::test]
    async fn replay_module_request_dump() {
        let Ok(dir) = std::env::var("MC_REPLAY_DIR") else {
            return;
        };
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with("-module-req.json"))
            })
            .collect();
        files.sort();

        async fn drive_run(files: &[PathBuf]) -> Vec<(String, String, Option<Value>, u128)> {
            let state = Arc::new(ProducerState::default());
            // Build the handler manually (instead of handler_with_store) so an optional
            // production-store snapshot (MC_REPLAY_STORE=<sqlite3 .backup output>) can be
            // copied into place BEFORE the store opens — the store takes a single-writer
            // lease at open, so a post-open swap is impossible.
            let dir = tempfile::tempdir().unwrap();
            let data_home = dir.path().join("data");
            std::fs::create_dir_all(&data_home).unwrap();
            if let Ok(seed) = std::env::var("MC_REPLAY_STORE") {
                let StorageBackend::Sqlite { path: target } =
                    dev_descriptor_at(data_home.to_str().unwrap()).backend
                else {
                    panic!("replay seed requires the sqlite dev descriptor");
                };
                std::fs::create_dir_all(std::path::Path::new(&target).parent().unwrap()).unwrap();
                std::fs::copy(&seed, &target).unwrap();
            }
            let store = Arc::new(
                McStore::open_for_test(&dev_descriptor_at(data_home.to_str().unwrap())).unwrap(),
            );
            let handler = McHandler::with_producer_factory_config_resolver(
                Arc::new(TestProducerFactory { state }),
                default_test_config(),
                Arc::new(MissingSessionResolver),
            );
            handler.store.set(Arc::clone(&store)).ok().unwrap();
            let project = dir.path().join("project");
            std::fs::create_dir_all(&project).unwrap();
            let _dir = dir;
            let mut channels: HashMap<String, u16> = HashMap::new();
            let mut next_channel: u16 = 9;
            let mut outcomes = Vec::new();
            for path in files {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                let raw = std::fs::read_to_string(path).unwrap();
                let value: Value = serde_json::from_str(&raw).unwrap();
                let session = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .unwrap_or("replay-session")
                    .to_string();
                let channel = *channels.entry(session.clone()).or_insert_with(|| {
                    let ch = next_channel;
                    next_channel += 1;
                    handler.bind_route(ch, binding(project.to_str().unwrap(), &session));
                    ch
                });
                let started = std::time::Instant::now();
                let outcome = handler.dispatch_value(channel, value.clone()).await;
                let ms = started.elapsed().as_millis();
                match outcome {
                    HandlerOutcome::Response(bytes) => {
                        // Optional: dump the raw TransformResponse bytes per pass so a
                        // consumer (e.g. the gateway plan_outcome harness) can consume the
                        // module's EXACT returned bytes (MC_REPLAY_OUT_DIR=<dir>).
                        if let Ok(out_dir) = std::env::var("MC_REPLAY_OUT_DIR") {
                            let _ = std::fs::create_dir_all(&out_dir);
                            let _ = std::fs::write(
                                std::path::Path::new(&out_dir)
                                    .join(format!("{name}.response.json")),
                                &bytes,
                            );
                        }
                        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                        let action = parsed
                            .get("action")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        outcomes.push((name, action, Some(parsed), ms));
                    }
                    HandlerOutcome::Error { code, message } => {
                        println!("[replay] {name} ERROR code={code} ms={ms} message={message}");
                        outcomes.push((name, format!("ERROR:{code}"), None, ms));
                    }
                    other => {
                        println!("[replay] {name} OTHER {other:?} ms={ms}");
                        outcomes.push((name, "OTHER".to_string(), None, ms));
                    }
                }
            }
            outcomes
        }

        let run_a = drive_run(&files).await;
        let run_b = drive_run(&files).await;

        let mut determinism_ok = 0usize;
        let mut determinism_bad = Vec::new();
        for (a, b) in run_a.iter().zip(run_b.iter()) {
            let bytes_a = a.3;
            let _ = bytes_a;
            match (&a.2, &b.2) {
                (Some(va), Some(vb)) => {
                    let sa = serde_json::to_string(va.get("ck_messages").unwrap_or(&Value::Null))
                        .unwrap();
                    let sb = serde_json::to_string(vb.get("ck_messages").unwrap_or(&Value::Null))
                        .unwrap();
                    if sa == sb {
                        determinism_ok += 1;
                    } else {
                        determinism_bad.push(a.0.clone());
                    }
                }
                _ => determinism_bad.push(a.0.clone()),
            }
        }

        // Prefix stability within run A: on non-busting passes, the previous output's
        // message sequence must reappear byte-identically as a prefix of this output.
        let mut prefix_ok = 0usize;
        let mut prefix_bad = Vec::new();
        for w in run_a.windows(2) {
            let (prev, cur) = (&w[0], &w[1]);
            let (Some(pv), Some(cv)) = (&prev.2, &cur.2) else {
                continue;
            };
            if cur.1 != "SOFT+" {
                continue;
            }
            let pm = pv
                .get("ck_messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let cm = cv
                .get("ck_messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // The previous pass's synthetic tail anchors (e.g. todo pair) may relocate
            // relative to NEW tail messages; compare the non-synthetic sequence.
            let strip = |arr: &[Value]| -> Vec<String> {
                arr.iter()
                    .filter(|m| {
                        !m.get("ck")
                            .and_then(|c| c.get("meta"))
                            .and_then(|m| m.get("synthetic"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    })
                    .map(|m| serde_json::to_string(m).unwrap())
                    .collect()
            };
            let ps = strip(&pm);
            let cs = strip(&cm);
            if cs.len() >= ps.len() && cs[..ps.len()] == ps[..] {
                prefix_ok += 1;
            } else {
                let diverge = ps
                    .iter()
                    .zip(cs.iter())
                    .position(|(x, y)| x != y)
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "len".to_string());
                prefix_bad.push(format!("{}@{}", cur.0, diverge));
            }
        }

        for (name, action, parsed, ms) in &run_a {
            let n_out = parsed
                .as_ref()
                .and_then(|p| p.get("ck_messages"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            println!("[replay] {name} action={action} out_msgs={n_out} ms={ms}");
        }
        println!(
            "[replay] DETERMINISM cross-run: {determinism_ok}/{} identical, divergent: {:?}",
            run_a.len(),
            determinism_bad
        );
        println!(
            "[replay] PREFIX-STABILITY (SOFT+ passes): {prefix_ok} stable, divergent: {:?}",
            prefix_bad
        );
    }

    #[derive(Clone)]
    enum FakeResolve {
        Hit(String),
        None,
        Timeout,
    }

    #[derive(Default)]
    struct FakeSessionResolver {
        responses: Mutex<HashMap<String, FakeResolve>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeSessionResolver {
        fn with(pairs: &[(&str, FakeResolve)]) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(
                    pairs
                        .iter()
                        .map(|(token, response)| ((*token).to_string(), response.clone()))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            })
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("resolver calls mutex").clone()
        }
    }

    #[async_trait]
    impl SessionResolver for FakeSessionResolver {
        async fn resolve_session(
            &self,
            _project_root: &Path,
            _harness: &str,
            instance_token: &str,
        ) -> Result<Option<ResolvedSession>, SessionResolveError> {
            self.calls
                .lock()
                .expect("resolver calls mutex")
                .push(instance_token.to_string());
            match self
                .responses
                .lock()
                .expect("resolver responses mutex")
                .get(instance_token)
                .cloned()
                .unwrap_or(FakeResolve::None)
            {
                FakeResolve::Hit(session_id) => Ok(Some(ResolvedSession {
                    session_id,
                    last_traffic_ms: 123,
                })),
                FakeResolve::None => Ok(None),
                FakeResolve::Timeout => Err(SessionResolveError::Timeout),
            }
        }
    }

    /// Resolve just the project_root (the binding's identity) for the resolve assertions.
    fn resolved_root(h: &McHandler, channel: u16, session: &str) -> Result<PathBuf, BindingError> {
        h.resolve_binding(channel, session).map(|b| b.project_root)
    }

    #[test]
    fn route_binding_bind_resolve_unbind() {
        let h = McHandler::new();
        h.bind_route(7, binding("/repo/proj", "ses_a"));

        // resolve succeeds when the channel is bound AND the session matches
        assert_eq!(
            resolved_root(&h, 7, "ses_a").unwrap(),
            PathBuf::from("/repo/proj")
        );

        // a teardown removes the binding → a later resolve fails loud (no stale project)
        h.unbind_route(7);
        assert_eq!(resolved_root(&h, 7, "ses_a"), Err(BindingError::Unbound));
    }

    #[test]
    fn resolve_fails_loud_unbound_and_on_session_mismatch() {
        let h = McHandler::new();
        // never bound → Unbound (NEVER a default project, which would be a cross-project read)
        assert_eq!(resolved_root(&h, 3, "ses_x"), Err(BindingError::Unbound));

        h.bind_route(3, binding("/repo/own", "ses_own"));
        // bound, but a request claiming a DIFFERENT session on this channel → SessionMismatch
        assert_eq!(
            resolved_root(&h, 3, "ses_other"),
            Err(BindingError::SessionMismatch)
        );
        // the matching session still resolves
        assert_eq!(
            resolved_root(&h, 3, "ses_own").unwrap(),
            PathBuf::from("/repo/own")
        );
    }

    #[test]
    fn rebind_overwrites_stale_channel_entry() {
        let h = McHandler::new();
        h.bind_route(5, binding("/a", "s1"));
        // a reused channel re-binds to a new session → last write wins (no stale leak)
        h.bind_route(5, binding("/b", "s2"));
        assert_eq!(resolved_root(&h, 5, "s2").unwrap(), PathBuf::from("/b"));
        assert_eq!(
            resolved_root(&h, 5, "s1"),
            Err(BindingError::SessionMismatch)
        );
    }

    #[test]
    fn request_byte_cap_uses_the_subc_frame_budget_for_every_request_class() {
        let pad = |method: &str, key: &str, bytes: usize| {
            format!(
                "{{\"{key}\":\"{method}\",\"pad\":\"{}\"}}",
                "x".repeat(bytes)
            )
            .into_bytes()
        };
        assert!(enforce_request_byte_cap(b"{}").is_ok());
        let two_mib = 2 * 1024 * 1024;
        assert!(enforce_request_byte_cap(&pad("transform", "kind", two_mib)).is_ok());
        assert!(enforce_request_byte_cap(&pad("state_sync", "method", two_mib)).is_ok());
        assert!(enforce_request_byte_cap(&pad("ctx_memory", "method", two_mib)).is_ok());
        assert!(enforce_request_byte_cap(&vec![b'x'; two_mib]).is_ok());
        assert!(
            enforce_request_byte_cap(&pad("transform", "kind", MAX_TRANSFORM_FRAME_BYTES)).is_err()
        );
        // A full transform page plus the transport's late capability field is
        // admitted, including a non-final page that only carries the page envelope.
        let just_over_facade = MAX_FACADE_FRAME_BYTES + 32;
        assert!(enforce_request_byte_cap(&pad("transform", "kind", just_over_facade)).is_ok());
        assert!(
            enforce_request_byte_cap(&pad("abc", "transform_page_id", just_over_facade)).is_ok()
        );
        assert!(enforce_request_byte_cap(&pad("ctx_memory", "method", just_over_facade)).is_err());
        assert!(
            enforce_request_byte_cap(&pad("transform", "method", MAX_FACADE_FRAME_BYTES)).is_err()
        );
        assert!(
            enforce_request_byte_cap(&pad("ctx_memory", "name", MAX_FACADE_FRAME_BYTES)).is_err()
        );
    }

    #[path = "background_run_limits.rs"]
    mod background_run_limits;

    #[derive(Default)]
    struct ProducerState {
        runner_limits: Mutex<Option<runner_limits::RunnerLimits>>,
        connects: AtomicUsize,
        session_runner_connects: AtomicUsize,
        starts: AtomicUsize,
        start_errors: Mutex<VecDeque<Result<RunHandle, HistorianProducerError>>>,
        binds: AtomicUsize,
        statuses: AtomicUsize,
        await_outputs: AtomicUsize,
        await_timeouts: Mutex<Vec<Duration>>,
        block_output: std::sync::atomic::AtomicBool,
        notify: Notify,
        connect_errors: Mutex<VecDeque<HistorianProducerError>>,
        await_results: Mutex<VecDeque<Result<ProducerOutput, HistorianProducerError>>>,
        outputs: Mutex<VecDeque<String>>,
        next_fact: Mutex<Option<String>>,
        fact_each_run: Mutex<Option<String>>,
        prompts: Mutex<Vec<String>>,
        systems: Mutex<Vec<String>>,
        models: Mutex<Vec<String>>,
        /// The `model.variant` each variant-carrying start named, in attempt order.
        variants: Mutex<Vec<Option<String>>>,
        /// The provider session each start ran under, in attempt order.
        sessions: Mutex<Vec<String>>,
        on_await_output: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    struct TestProducerFactory {
        state: Arc<ProducerState>,
    }

    #[async_trait]
    impl HistorianProducerFactory for TestProducerFactory {
        async fn connect(
            &self,
            _project_root: &Path,
        ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
            self.state.connects.fetch_add(1, Ordering::SeqCst);
            if let Some(err) = self
                .state
                .connect_errors
                .lock()
                .expect("connect errors mutex")
                .pop_front()
            {
                return Err(err);
            }
            Ok(Box::new(TestProducer {
                state: Arc::clone(&self.state),
            }))
        }

        async fn connect_session_runner(
            &self,
            identity: &session_resolver::RunnerBindIdentity,
            _route: &SessionRunnerRoute,
        ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
            self.state
                .session_runner_connects
                .fetch_add(1, Ordering::SeqCst);
            self.connect(&identity.project_root).await
        }
    }

    struct TestProducer {
        state: Arc<ProducerState>,
    }

    #[async_trait]
    impl HistorianProducerDriver for TestProducer {
        async fn session_runner_limits(
            &mut self,
            _child: &str,
        ) -> Result<Option<runner_limits::RunnerLimits>, HistorianProducerError> {
            Ok(*self.state.runner_limits.lock().unwrap())
        }
        async fn bind_session(&mut self, _session_id: &str) -> Result<(), HistorianProducerError> {
            self.state.binds.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn start_with_temperature(
            &mut self,
            session_id: &str,
            system: &str,
            prompt: &str,
            model: &str,
            variant: Option<&str>,
            _temperature: Option<f64>,
        ) -> Result<RunHandle, HistorianProducerError> {
            self.state
                .variants
                .lock()
                .expect("variants mutex")
                .push(variant.map(str::to_string));
            self.start(session_id, system, prompt, model).await
        }

        async fn start_with_generation(
            &mut self,
            session_id: &str,
            system: &str,
            prompt: &str,
            model: &str,
            variant: Option<&str>,
            _max_output_tokens: u32,
            _temperature: f64,
        ) -> Result<RunHandle, HistorianProducerError> {
            self.state
                .variants
                .lock()
                .expect("variants mutex")
                .push(variant.map(str::to_string));
            self.start(session_id, system, prompt, model).await
        }

        async fn start(
            &mut self,
            session_id: &str,
            system: &str,
            prompt: &str,
            model: &str,
        ) -> Result<RunHandle, HistorianProducerError> {
            let n = self.state.starts.fetch_add(1, Ordering::SeqCst) + 1;
            self.state
                .sessions
                .lock()
                .expect("sessions mutex")
                .push(session_id.to_string());
            self.state
                .prompts
                .lock()
                .expect("prompts mutex")
                .push(prompt.to_string());
            self.state
                .systems
                .lock()
                .expect("systems mutex")
                .push(system.to_string());
            self.state
                .models
                .lock()
                .expect("models mutex")
                .push(model.to_string());
            if let Some(result) = self
                .state
                .start_errors
                .lock()
                .expect("start errors mutex")
                .pop_front()
            {
                return result;
            }
            let one_shot_fact = self.state.next_fact.lock().expect("next fact mutex").take();
            let repeated_fact = self
                .state
                .fact_each_run
                .lock()
                .expect("fact each run mutex")
                .clone();
            let output = match one_shot_fact.or_else(|| {
                repeated_fact.map(|prefix| {
                    let (start, end) = prompt_ordinal_range(prompt).unwrap_or((1, 3));
                    format!("{prefix} {start}-{end}")
                })
            }) {
                Some(fact) => {
                    let (start, end) = prompt_ordinal_range(prompt).unwrap_or((1, 3));
                    historian_output_with_fact(start, end, &fact)
                }
                None => historian_output_for_prompt(prompt),
            };
            self.state
                .outputs
                .lock()
                .expect("outputs mutex")
                .push_back(output);
            Ok(RunHandle {
                run_id: format!("run-{n}"),
            })
        }

        async fn await_output_with_timeout(
            &mut self,
            run_id: &str,
            timeout: Duration,
        ) -> Result<ProducerOutput, HistorianProducerError> {
            self.state
                .await_timeouts
                .lock()
                .expect("await timeouts mutex")
                .push(timeout);
            self.await_output(run_id).await
        }

        async fn await_output(
            &mut self,
            _run_id: &str,
        ) -> Result<ProducerOutput, HistorianProducerError> {
            self.state.await_outputs.fetch_add(1, Ordering::SeqCst);
            if let Some(hook) = self
                .state
                .on_await_output
                .lock()
                .expect("await-output hook mutex")
                .take()
            {
                hook();
            }
            while self.state.block_output.load(Ordering::SeqCst) {
                self.state.notify.notified().await;
            }
            if let Some(result) = self
                .state
                .await_results
                .lock()
                .expect("await results mutex")
                .pop_front()
            {
                return result;
            }
            let text = self
                .state
                .outputs
                .lock()
                .expect("outputs mutex")
                .pop_front()
                .unwrap_or_else(|| historian_output(1, 3, "reattached summary"));
            Ok(ProducerOutput {
                text,
                length_capped: false,
                usage: None,
            })
        }

        async fn status(&mut self, _run_id: &str) -> Result<RunState, HistorianProducerError> {
            self.state.statuses.fetch_add(1, Ordering::SeqCst);
            Ok(RunState::Active)
        }

        async fn cancel(&mut self, _run_id: &str) -> Result<(), HistorianProducerError> {
            Ok(())
        }

        async fn close(&mut self) {}
    }

    fn handler_with_store(
        state: Arc<ProducerState>,
        config: McModuleConfig,
    ) -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
        handler_with_store_and_resolver(state, config, Arc::new(MissingSessionResolver))
    }

    fn handler_with_store_and_resolver(
        state: Arc<ProducerState>,
        config: McModuleConfig,
        resolver: Arc<dyn SessionResolver>,
    ) -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let store = Arc::new(
            McStore::open_for_test(&dev_descriptor_at(data_home.to_str().unwrap())).unwrap(),
        );
        let handler = McHandler::with_producer_factory_config_resolver(
            Arc::new(TestProducerFactory { state }),
            config,
            resolver,
        );
        handler.store.set(Arc::clone(&store)).ok().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        handler.bind_route(7, binding(project.to_str().unwrap(), "ses"));
        (handler, store, dir, project)
    }

    #[test]
    fn wire_execute_threshold_overrides_config_and_absence_preserves_fallback_both_directions() {
        fn decision(wire_threshold: Option<f64>, config_threshold: f64) -> scheduler::BaseDecision {
            let mut request = json!({
                "kind": "transform",
                "v": 2,
                "serializer_profile": "owned-llmrunner",
                "session_id": "threshold-wire",
                "render_config": "cfg",
                "messages": []
            });
            if let Some(threshold) = wire_threshold {
                request["effective_execute_threshold"] = json!(threshold);
            }
            let parsed: TransformRequest = serde_json::from_value(request).unwrap();
            scheduler::should_execute(
                &scheduler::SchedulerConfig {
                    execute_threshold_percentage: scheduler::ExecuteThresholdConfig::Percentage(
                        parsed.execute_threshold_or(config_threshold),
                    ),
                    execute_threshold_tokens: None,
                },
                &scheduler::SessionMeta {
                    last_response_time_ms: 100,
                    cache_ttl: "5m".to_string(),
                },
                &scheduler::ContextUsage {
                    percentage: 60.0,
                    input_tokens: 60_000.0,
                    hard_wall_percentage: None,
                },
                100,
                None,
                Some(100_000.0),
            )
        }

        assert_eq!(decision(Some(50.0), 70.0), scheduler::BaseDecision::Execute);
        assert_eq!(decision(None, 70.0), scheduler::BaseDecision::Defer);
        assert_eq!(decision(Some(70.0), 50.0), scheduler::BaseDecision::Defer);
        assert_eq!(decision(None, 50.0), scheduler::BaseDecision::Execute);
    }

    fn typescript_legacy_guidance(key: &str) -> String {
        let reference: Value = serde_json::from_str(include_str!(
            "../testdata/tool_surfaces/legacy-guidance-reference.json"
        ))
        .unwrap();
        reference[key]
            .as_str()
            .expect("TypeScript guidance reference")
            .to_string()
    }

    fn default_test_config() -> McModuleConfig {
        McModuleConfig {
            rust_background_enabled: false,
            cache_ttl_by_model: std::collections::BTreeMap::new(),
            catalog: crate::config::CatalogConfigInputs::default(),
            historian_temperature: None,
            historian_expand_tools: Default::default(),
            historian_runner: None,
            dreamer_runner: None,
            language: None,
            execute_threshold_percentage: 65.0,
            execute_threshold_user_config: None,
            execute_threshold_user_configured: false,
            execute_threshold_project_config: None,
            protected_tokens_user: None,
            protected_tokens_project: None,
            keep_reasoning_tokens: None,
            compaction_enabled: true,
            signed_thinking_hold: config::SignedThinkingHold::Off,
            smart_notes_enabled: true,
            memory_enabled: true,
            auto_search: crate::config::AutoSearchConfig::default(),
            caveman: crate::config::CavemanConfig::default(),
            auto_promote: true,
            user_memory_collection_enabled: false,
            user_observations_requested: true,
            historian_context_limit_tokens: 200_000,
            historian_context_limit_known: true,
            memory_budget_tokens: 4_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            prompt_surface_guidance_override: None,
            smart_drops: false,
            protected_tools: crate::selection::default_protected_tools(),
            cache_ttl: "5m".to_string(),
        }
    }

    fn ck_with_role(mid: &str, ordinal: u64, role: &str, text: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                vec![CkWireBlock::bare(CkKind::Text { text: text.into() })],
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn ck(mid: &str, ordinal: u64, text: &str) -> CkIngressMessage {
        ck_with_role(mid, ordinal, "user", text)
    }

    fn tool_result(mid: &str, ordinal: u64, text: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "tool",
                vec![CkWireBlock::bare(CkKind::ToolResult {
                    id: mid
                        .strip_prefix("result-")
                        .map(|suffix| format!("call-{suffix}"))
                        .unwrap_or_else(|| format!("call-{mid}")),
                    tool_name: "bash".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: text.to_string(),
                    }),
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }

    fn stored_comp(seq: i64, start: i64, end: i64, end_mid: &str, p1: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: format!("{end_mid}#0"),
            title: format!("C{seq}"),
            content: p1.to_string(),
            p1: Some(p1.to_string()),
            importance: 50,
            ..Default::default()
        }
    }

    fn request_with_usage(
        messages: Vec<CkIngressMessage>,
        current_total_input_tokens: u64,
        context_limit_tokens: u64,
    ) -> Value {
        json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "owned-llmrunner",
            "session_id": "ses",
            "render_config": "cfg0",
            "usage": ModuleUsage {
                current_total_input_tokens,
                context_limit_tokens,
                ..ModuleUsage::default()
            },
            "messages": messages,
            // The host sends its resolved historian chain with every transform.
            "historian_model_chain": [TEST_HISTORIAN_MODEL],
        })
    }

    const TEST_HISTORIAN_MODEL: &str = "test/model";

    pub(super) fn request(messages: Vec<CkIngressMessage>) -> Value {
        request_with_usage(messages, 45_000, 50_000)
    }

    fn transform_request(
        messages: Vec<CkIngressMessage>,
        current_total_input_tokens: u64,
        context_limit_tokens: u64,
    ) -> TransformRequest {
        serde_json::from_value(request_with_usage(
            messages,
            current_total_input_tokens,
            context_limit_tokens,
        ))
        .unwrap()
    }

    async fn call_dispatch_request(handler: &McHandler, request: Value) -> Value {
        call_dispatch_request_on_channel(handler, 7, request).await
    }

    async fn call_dispatch_request_on_channel(
        handler: &McHandler,
        channel: u16,
        request: Value,
    ) -> Value {
        match handler.dispatch_value(channel, request).await {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("unexpected handler outcome: {other:?}"),
        }
    }

    fn error_frame(outcome: HandlerOutcome) -> (String, String) {
        match outcome {
            HandlerOutcome::Error { code, message } => (code, message),
            other => panic!("expected error outcome, got {other:?}"),
        }
    }

    fn error_code(outcome: HandlerOutcome) -> String {
        error_frame(outcome).0
    }

    async fn call_facade(handler: &McHandler, name: &str, arguments: Value) -> HandlerOutcome {
        call_facade_on_channel(handler, 7, name, arguments).await
    }

    async fn call_facade_on_channel(
        handler: &McHandler,
        channel: u16,
        name: &str,
        arguments: Value,
    ) -> HandlerOutcome {
        handler
            .dispatch_value(channel, json!({ "name": name, "arguments": arguments }))
            .await
    }

    fn tool_body(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("expected tool response, got {other:?}"),
        }
    }

    fn tool_is_error(outcome: HandlerOutcome) -> bool {
        tool_body(outcome)["isError"].as_bool().unwrap_or(false)
    }

    fn tool_text(outcome: HandlerOutcome) -> String {
        tool_body(outcome)["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn insert_memory(
        store: &McStore,
        project: &str,
        category: &str,
        content: &str,
        now: i64,
    ) -> i64 {
        store
            .insert_memory(InsertMemoryInput {
                project_path: project,
                route_project_root: None,
                category,
                content,
                source_session_id: Some(project),
                source_type: Some("test"),
                importance: Some(50),
                expires_at: None,
                metadata_json: None,
                now_ms: now,
            })
            .unwrap()
    }

    /// Key a route root by a project identity, the way a host-recorded session project
    /// keys it in production. The other arguments are kept so the call sites read as the
    /// project, route and domain they set up.
    fn activate_module_authority(
        store: &McStore,
        _context_store_uuid: &str,
        identity: &str,
        route_project_root: &str,
        _domain: &str,
    ) {
        store.set_route_identity_for_test(route_project_root, identity);
    }

    fn seed_workspace(store: &McStore, own: &str, foreign: &str) {
        store
            .seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
    }

    #[test]
    fn transform_health_idle_is_ok_and_empty_queue_is_explicit_null() {
        let health = DispatchHealth::new();
        let report = health.report(10_000);
        assert_eq!(report.status, HealthStatus::Ok);
        let metrics = report.metrics.unwrap();
        assert_eq!(metrics["in_flight_count"], json!(0));
        assert_eq!(metrics["oldest_queued_age_ms"], Value::Null);
    }

    #[test]
    fn module_health_line_surfaces_last_historian_runner_refusal() {
        let health = DispatchHealth::new();
        let outcome = "published seq 2; historian refusal stage=credential provider=opencode model=opencode/model-a received=\"open_failed: no apikey credential for provider 'opencode'\"";
        health.record_historian_outcome(outcome.to_string(), 4);

        let report = health.report(10_000);
        assert!(report.detail.as_deref().is_some_and(|detail| {
            detail.contains("last historian: published seq 2")
                && detail.contains("stage=credential provider=opencode")
        }));
        let metrics = report.metrics.unwrap();
        assert_eq!(metrics["last_historian_outcome"], json!(outcome));
        assert_eq!(metrics["historian_recent_decisions_count"], json!(4));
    }

    #[test]
    fn transform_health_reports_oldest_queue_age_as_a_structured_metric() {
        let health = DispatchHealth::new();
        health.oldest_queued_at_ms.store(100, Ordering::Relaxed);
        let report = health.report(250);
        let metrics = report.metrics.unwrap();
        assert_eq!(metrics["oldest_queued_age_ms"], json!(150));
        assert_eq!(metrics["queue_stale"], json!(false));
    }

    #[test]
    fn transform_health_wedge_reports_lane_and_structured_staleness() {
        let health = DispatchHealth::new();
        health
            .last_dispatch_started_at_ms
            .store(200_000, Ordering::Relaxed);
        health
            .last_dispatch_completed_at_ms
            .store(50_000, Ordering::Relaxed);
        health.in_flight_count.store(1, Ordering::Relaxed);

        let report = health.report(200_001);
        assert_eq!(report.status, HealthStatus::Degraded);
        assert!(report
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("transform lane")));
        let metrics = report.metrics.unwrap();
        assert_eq!(metrics["heartbeat_stale"], json!(true));
        assert_eq!(metrics["in_flight_count"], json!(1));
        assert_eq!(metrics["completion_lag_ms"], json!(150_000));
        assert_eq!(metrics["state"], json!("stuck"));
        assert_eq!(metrics["stuck"], json!(true));
    }

    #[test]
    fn transform_health_stuck_bound_is_typed_and_constant_fenced() {
        assert_eq!(TRANSFORM_WEDGE_THRESHOLD_MS, 30_000);
        let health = DispatchHealth::new();
        health
            .last_dispatch_started_at_ms
            .store(1, Ordering::Relaxed);
        health.in_flight_count.store(1, Ordering::Relaxed);

        let within_bound = health.report(30_001);
        assert_eq!(within_bound.status, HealthStatus::Ok);
        let within_metrics = within_bound.metrics.unwrap();
        assert_eq!(within_metrics["state"], json!("advancing"));
        assert_eq!(within_metrics["stuck"], json!(false));

        let past_bound = health.report(30_002);
        assert_eq!(past_bound.status, HealthStatus::Degraded);
        assert!(past_bound
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("lane stuck")));
        let stuck_metrics = past_bound.metrics.unwrap();
        assert_eq!(stuck_metrics["state"], json!("stuck"));
        assert_eq!(stuck_metrics["stuck"], json!(true));
    }

    // (the same gate as the corruption path itself); a default build has neither the arm
    // nor these tests. They exercise `apply_drive_fault`/`parse_drive_fault` directly
    // rather than setting MC_DRIVE_FAULT, so they never touch process-global env or the
    // process-wide OnceLock and stay deterministic alongside the rest of the suite.
    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_parse_maps_arms_and_ignores_unknown() {
        assert_eq!(
            parse_drive_fault(Some("fingerprint_skew")),
            Some(DriveFault::FingerprintSkew)
        );
        assert_eq!(
            parse_drive_fault(Some("omit_ck_messages")),
            Some(DriveFault::OmitCkMessages)
        );
        assert_eq!(
            parse_drive_fault(Some("transform_timeout")),
            Some(DriveFault::TransformTimeout)
        );
        // Unset, empty, and unrecognized values all leave the response untouched.
        assert_eq!(parse_drive_fault(None), None);
        assert_eq!(parse_drive_fault(Some("")), None);
        assert_eq!(parse_drive_fault(Some("anything_else")), None);
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_fingerprint_skew_perturbs_echoed_fingerprint() {
        let submitted = "abc123".to_string();
        let mut response = transform::TransformResponse::passthrough(
            vec![ck("fp-skew", 1, "hello").ck],
            Some(submitted.clone()),
        );
        apply_drive_fault(&mut response, DriveFault::FingerprintSkew);
        // The echoed fingerprint must fail an equality check against the submitted value,
        // while the response otherwise stays success-shaped (ok status, array present).
        let echoed = response
            .full_array_fingerprint
            .clone()
            .expect("fingerprint still echoed after skew");
        assert_ne!(echoed, submitted);
        assert_eq!(response.status, transform::TransformStatus::Ok);
        assert!(response.ck_messages.is_some());
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_omit_ck_messages_absents_field_on_ok_status() {
        let mut response = transform::TransformResponse::passthrough(
            vec![ck("omit-ck", 1, "hello").ck],
            Some("fingerprint".to_string()),
        );
        assert!(
            response.ck_messages.is_some(),
            "passthrough response carries ck_messages before the fault"
        );
        apply_drive_fault(&mut response, DriveFault::OmitCkMessages);
        // Success-shaped (ok status retained) but with the ck_messages field ABSENT on the
        // wire — the same skip_serializing_if arm need_full_sync uses.
        assert_eq!(response.status, transform::TransformStatus::Ok);
        assert!(response.ck_messages.is_none());
        let value = serde_json::to_value(&response).unwrap();
        assert!(
            value.get("ck_messages").is_none(),
            "ck_messages must be absent from the serialized response"
        );
        assert_eq!(value["status"], json!("ok"));
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_count_parse_defaults_to_one() {
        // Unset, empty, unparseable, and zero all default to 1.
        assert_eq!(parse_drive_fault_count(None), 1);
        assert_eq!(parse_drive_fault_count(Some("")), 1);
        assert_eq!(parse_drive_fault_count(Some("not_a_number")), 1);
        assert_eq!(parse_drive_fault_count(Some("0")), 1);
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_count_parse_accepts_positive_values() {
        assert_eq!(parse_drive_fault_count(Some("1")), 1);
        assert_eq!(parse_drive_fault_count(Some("3")), 3);
        assert_eq!(parse_drive_fault_count(Some("100")), 100);
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_count_one_fires_once_then_clean() {
        // Simulate count=1: claim one firing, then verify subsequent claims are no-ops.
        // We test the claim logic directly by manipulating DRIVE_FAULT_REMAINING and
        // checking the fetch_update guard condition.
        DRIVE_FAULT_REMAINING.store(1, std::sync::atomic::Ordering::Relaxed);

        // First claim: should fire (Ok(1) with prev=1 > 0).
        let result = DRIVE_FAULT_REMAINING.fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |n| n.checked_sub(1),
        );
        assert_eq!(result, Ok(1), "first claim should fire (prev=1)");
        assert_eq!(
            DRIVE_FAULT_REMAINING.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "count exhausted after one claim"
        );

        // Second claim: should NOT fire (Err(0) — checked_sub returns None).
        let result = DRIVE_FAULT_REMAINING.fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |n| n.checked_sub(1),
        );
        assert_eq!(result, Err(0), "second claim should be clean (no firing)");
        // Must not underflow: stays at 0.
        assert_eq!(
            DRIVE_FAULT_REMAINING.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "count must not underflow past 0"
        );
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_count_three_fires_exactly_three_then_clean() {
        DRIVE_FAULT_REMAINING.store(3, std::sync::atomic::Ordering::Relaxed);

        for i in 1..=3 {
            let result = DRIVE_FAULT_REMAINING.fetch_update(
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
                |n| n.checked_sub(1),
            );
            // fetch_update returns Ok(prev) where prev is the value BEFORE the update.
            // With count=3, calls return Ok(3), Ok(2), Ok(1) — all > 0.
            assert!(
                result.is_ok() && result.unwrap() > 0,
                "claim {i} should fire (result={result:?})"
            );
        }

        // Fourth claim: exhausted.
        let result = DRIVE_FAULT_REMAINING.fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |n| n.checked_sub(1),
        );
        assert_eq!(result, Err(0), "fourth claim should be clean");
        assert_eq!(
            DRIVE_FAULT_REMAINING.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "count must not underflow past 0"
        );
    }

    #[test]
    #[cfg(feature = "drive-fault")]
    fn drive_fault_count_concurrent_claim_safety() {
        // Simulate N concurrent claims by iterating a loop that mimics the atomic claim
        // pattern. With N=5 and 7 claims, exactly 5 should succeed (Ok(prev) with prev > 0)
        // and 2 should be clean (Err(0)). This validates the checked_sub semantics without
        // requiring real threads.
        DRIVE_FAULT_REMAINING.store(5, std::sync::atomic::Ordering::Relaxed);

        let mut fired = 0usize;
        let mut clean = 0usize;
        for _ in 0..7 {
            match DRIVE_FAULT_REMAINING.fetch_update(
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
                |n| n.checked_sub(1),
            ) {
                Ok(prev) if prev > 0 => fired += 1,
                _ => clean += 1,
            }
        }

        assert_eq!(fired, 5, "exactly 5 claims should fire");
        assert_eq!(clean, 2, "remaining 2 claims should be clean");
        assert_eq!(
            DRIVE_FAULT_REMAINING.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "count must not underflow past 0"
        );
    }

    #[test]
    #[ignore = "manual 2k-message hot-path timing fixture"]
    fn historian_tag_and_state_snapshot_hot_path_benchmark() {
        const MESSAGE_COUNT: usize = 2_048;
        const SAMPLES: usize = 7;
        let producer = Arc::new(ProducerState::default());
        let (_handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let messages = (1..=MESSAGE_COUNT)
            .map(|ordinal| {
                ck(
                    &format!("m{ordinal}"),
                    ordinal as u64,
                    &format!("source-{ordinal}"),
                )
            })
            .collect::<Vec<_>>();
        let parsed = transform_request(messages, 1_000, 200_000);
        let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
        let tags = (1..=MESSAGE_COUNT)
            .map(|ordinal| TagMintInput {
                block_id: format!("m{ordinal}#0"),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: format!("source-{ordinal}").into_bytes(),
            })
            .collect::<Vec<_>>();
        store.seed_tags_for_test("ses", &tags, 1).unwrap();
        let shared_tags = Arc::new(store.load_tags_for_session("ses").unwrap());
        let legacy_cache = Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
        let shared_cache = Mutex::new(BoundaryTokenCache::new(BOUNDARY_TOKEN_CACHE_BUDGET_BYTES));
        for cache in [&legacy_cache, &shared_cache] {
            cache
                .lock()
                .unwrap()
                .prime_from_persisted_tags("ses", shared_tags.as_slice());
            let warmed = boundary_messages(&parsed, &projection, cache);
            cache
                .lock()
                .unwrap()
                .replace("ses", warmed.token_cache_snapshot);
        }

        for _ in 0..SAMPLES {
            let started_at = Instant::now();
            let legacy_tags = store.load_tags_for_session("ses").unwrap();
            legacy_cache
                .lock()
                .unwrap()
                .prime_from_persisted_tags("ses", &legacy_tags);
            let legacy = boundary_messages(&parsed, &projection, &legacy_cache);
            legacy_cache
                .lock()
                .unwrap()
                .replace("ses", legacy.token_cache_snapshot);
            std::hint::black_box(legacy.messages.len());
            eprintln!(
                "mc-pass-timing session=r12-before trigger_boundary_build={:.3}",
                started_at.elapsed().as_secs_f64() * 1_000.0
            );

            let started_at = Instant::now();
            shared_cache
                .lock()
                .unwrap()
                .prime_from_persisted_tags("ses", shared_tags.as_slice());
            let shared = boundary_messages(&parsed, &projection, &shared_cache);
            shared_cache
                .lock()
                .unwrap()
                .replace("ses", shared.token_cache_snapshot);
            std::hint::black_box(shared.messages.len());
            eprintln!(
                "mc-pass-timing session=r12-after trigger_boundary_build={:.3}",
                started_at.elapsed().as_secs_f64() * 1_000.0
            );
        }

        for _ in 0..SAMPLES {
            let started_at = Instant::now();
            std::hint::black_box(store.load("ses").unwrap());
            std::hint::black_box(store.load("ses").unwrap());
            eprintln!(
                "mc-pass-timing session=r07-before handler_state_snapshot={:.3}",
                started_at.elapsed().as_secs_f64() * 1_000.0
            );

            let started_at = Instant::now();
            let snapshot = store.load("ses").unwrap();
            std::hint::black_box((&snapshot, &snapshot));
            eprintln!(
                "mc-pass-timing session=r07-after handler_state_snapshot={:.3}",
                started_at.elapsed().as_secs_f64() * 1_000.0
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn guidance_variant_no_reduce_omits_reduce_and_hashes_differ() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        let full = call_dispatch_request(
            &handler,
            json!({ "kind": "guidance.get", "session_id": "ses", "tool_present": true }),
        )
        .await;
        let trimmed = call_dispatch_request(
            &handler,
            json!({ "kind": "guidance.get", "session_id": "ses", "variant": "no_reduce" }),
        )
        .await;
        let full_bytes = full["bytes"].as_str().unwrap();
        let trimmed_bytes = trimmed["bytes"].as_str().unwrap();
        assert!(full_bytes.contains("ctx_reduce"));
        assert!(!trimmed_bytes.contains("ctx_reduce"));
        assert!(!trimmed_bytes.contains("\u{a7}")); // no tag-sigil references
        assert!(trimmed_bytes.contains("ctx_memory"));
        assert!(trimmed_bytes.contains("ctx_expand"));
        assert_ne!(full["content_hash"], trimmed["content_hash"]);
        // Both variants share the session's frozen date line.
        let date = full_bytes.lines().last().unwrap();
        assert_eq!(date, trimmed_bytes.lines().last().unwrap());
        let unknown = handler
            .dispatch_value(
                7,
                json!({ "kind": "guidance.get", "session_id": "ses", "variant": "bogus" }),
            )
            .await;
        assert_eq!(error_code(unknown), "bad_request");
        let contradictory = handler
            .dispatch_value(
                7,
                json!({
                    "kind": "guidance.get",
                    "session_id": "ses",
                    "tool_present": false,
                    "variant": "full"
                }),
            )
            .await;
        assert_eq!(error_code(contradictory), "bad_request");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn guidance_uses_user_path_text_resolved_before_route_bind() {
        let producer = Arc::new(ProducerState::default());
        let config_dir = tempfile::tempdir().unwrap();
        let user_config_path = config_dir.path().join("magic-context.jsonc");
        std::fs::write(
            config_dir.path().join("cc-guidance.md"),
            "## Magic Context\n\nTrusted route guidance.",
        )
        .unwrap();
        std::fs::write(
            &user_config_path,
            r#"{
                "prompt_surface": {
                    "guidance_override_path": "cc-guidance.md"
                }
            }"#,
        )
        .unwrap();
        let mut config_cache = ConfigCache::default();
        let config = config_cache.effective_for_paths(&user_config_path, config_dir.path());
        let (handler, _store, _dir, project) = handler_with_store(producer, config.clone());
        let mut route = binding(project.to_str().unwrap(), "ses");
        route.config = config;
        handler.bind_route(7, route);
        handler.guidance_dates.lock().unwrap().insert(
            "ses".to_string(),
            "Today's date: Fri Jan 01 2016".to_string(),
        );

        let guidance = call_dispatch_request(
            &handler,
            json!({
                "kind": "guidance.get",
                "session_id": "ses",
                "tool_present": true,
            }),
        )
        .await;

        let reference = typescript_legacy_guidance("user_path_override");
        assert_eq!(
            guidance["bytes"],
            json!(format!("{reference}\nToday's date: Fri Jan 01 2016"))
        );
        assert_eq!(
            guidance["content_hash"],
            json!(sha256_hex(reference.as_bytes()))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn guidance_presets_cover_both_authored_light_variants() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        for (offset, tool_present) in [false, true].into_iter().enumerate() {
            let base_channel = 20 + (offset as u16 * 3);
            let variant = if tool_present { "full" } else { "no_reduce" };
            let sessions = [
                format!("preset-omitted-{offset}"),
                format!("preset-full-{offset}"),
                format!("preset-light-{offset}"),
            ];
            for (index, session) in sessions.iter().enumerate() {
                handler.bind_route(
                    base_channel + index as u16,
                    binding("/tmp/project", session),
                );
                handler
                    .guidance_dates
                    .lock()
                    .unwrap()
                    .insert(session.clone(), "Today's date: Fri Jan 01 2016".to_string());
            }
            let omitted = call_dispatch_request_on_channel(
                &handler,
                base_channel,
                json!({
                    "kind": "guidance.get",
                    "session_id": sessions[0],
                    "serializer_profile": "claude-code-anthropic",
                    "tool_present": tool_present,
                    "variant": variant,
                }),
            )
            .await;
            let explicit_full = call_dispatch_request_on_channel(
                &handler,
                base_channel + 1,
                json!({
                    "kind": "guidance.get",
                    "session_id": sessions[1],
                    "serializer_profile": "claude-code-anthropic",
                    "tool_present": tool_present,
                    "variant": variant,
                    "preset": "full",
                }),
            )
            .await;
            let light = call_dispatch_request_on_channel(
                &handler,
                base_channel + 2,
                json!({
                    "kind": "guidance.get",
                    "session_id": sessions[2],
                    "serializer_profile": "claude-code-anthropic",
                    "tool_present": tool_present,
                    "variant": variant,
                    "preset": "light",
                }),
            )
            .await;

            assert_eq!(omitted["bytes"], explicit_full["bytes"]);
            assert_ne!(omitted["bytes"], light["bytes"]);
            assert_eq!(omitted["hash"], explicit_full["hash"]);
            assert_ne!(omitted["hash"], light["hash"]);
            assert_eq!(omitted["content_hash"], explicit_full["content_hash"]);
            assert_ne!(omitted["content_hash"], light["content_hash"]);
            assert_eq!(omitted["preset_fallback"], false);
            assert_eq!(light["preset_fallback"], false);
            assert_eq!(light["served_preset"], "light");
            assert_eq!(light["fallback_notice"], Value::Null);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mixed_known_and_unknown_descriptions_apply_known_and_only_warn_for_unknown() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());

        let manifest = call_dispatch_request(
            &handler,
            json!({
                "kind": "manifest.get",
                "session_id": "ses",
                "config_identity": "mixed-descriptions",
                "tool_descriptions": {
                    "ctx_search": "Known search override.",
                    "ctx_typo": "Unknown override."
                }
            }),
        )
        .await;
        assert_eq!(manifest["tools"][3]["name"], json!("ctx_search"));
        assert_eq!(
            manifest["tools"][3]["description"],
            json!("Known search override.")
        );
        assert!(manifest["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["name"] != json!("ctx_typo")));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_manifest_freezes_per_model_and_config_epoch_and_keeps_ids_and_schemas_stable()
    {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        handler.bind_route(30, binding("/tmp/project", "manifest-ses"));
        let first = call_dispatch_request_on_channel(
            &handler,
            30,
            json!({
                "kind": "manifest.get",
                "session_id": "manifest-ses",
                "model_key": "provider/model-a",
                "config_identity": "config-a",
                "preset": "light",
                "tool_descriptions": { "ctx_search": "Search override A." },
            }),
        )
        .await;
        assert_eq!(first["served_preset"], "light");
        assert_eq!(first["preset_fallback"], false);
        assert_eq!(first["fallback_notice"], Value::Null);
        let frozen = call_dispatch_request_on_channel(
            &handler,
            30,
            json!({
                "kind": "manifest.get",
                "session_id": "manifest-ses",
                "model_key": "provider/model-a",
                "config_identity": "config-a",
                "preset": "full",
                "tool_descriptions": { "ctx_search": "Ignored mid-epoch override." },
            }),
        )
        .await;
        assert_eq!(
            frozen, first,
            "defer-equivalent reads must use frozen materialization"
        );

        let transitioned = call_dispatch_request_on_channel(
            &handler,
            30,
            json!({
                "kind": "manifest.get",
                "session_id": "manifest-ses",
                "model_key": "provider/model-a",
                "config_identity": "config-b",
                "preset": "full",
                "tool_descriptions": { "ctx_search": "Search override B." },
            }),
        )
        .await;
        assert_ne!(transitioned["content_epoch"], first["content_epoch"]);
        assert_eq!(transitioned["preset"], "full");
        assert_eq!(transitioned["preset_fallback"], false);
        assert_eq!(
            transitioned["tools"][3]["description"],
            "Search override B."
        );

        fn without_descriptions(mut value: Value) -> Value {
            match &mut value {
                Value::Object(fields) => {
                    fields.remove("description");
                    for child in fields.values_mut() {
                        *child = without_descriptions(child.take());
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        *child = without_descriptions(child.take());
                    }
                }
                _ => {}
            }
            value
        }

        let expected_tools = prompt_surface::session_tools(&PromptSurfaceSelection::default());
        for response in [&first, &transitioned] {
            let response_tools = serde_json::from_value::<Vec<subc_protocol::manifest::Tool>>(
                response["tools"].clone(),
            )
            .unwrap();
            assert_eq!(response_tools.len(), expected_tools.len());
            for (actual, expected) in response_tools.iter().zip(&expected_tools) {
                assert_eq!(actual.name, expected.name);
                assert_eq!(
                    without_descriptions(actual.schema.clone()),
                    without_descriptions(expected.schema.clone())
                );
                assert_eq!(actual.execution_mode, expected.execution_mode);
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn config_reload_reselects_guidance_and_manifest_together_then_stays_frozen() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        let session = "prompt-config-reload";
        handler.bind_route(31, binding("/tmp/project", session));
        handler.guidance_dates.lock().unwrap().insert(
            session.to_string(),
            "Today's date: Fri Jan 01 2016".to_string(),
        );

        let guidance_light = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "guidance.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-light",
                "preset": "light",
                "tool_present": true,
            }),
        )
        .await;
        let manifest_light = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "manifest.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-light",
                "preset": "light",
            }),
        )
        .await;
        assert_eq!(guidance_light["preset"], json!("light"));
        assert_eq!(manifest_light["preset"], json!("light"));
        assert_eq!(
            guidance_light["manifest_content_epoch"],
            manifest_light["content_epoch"]
        );

        let guidance_stable = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "guidance.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-light",
                "preset": "full",
                "tool_present": true,
            }),
        )
        .await;
        let manifest_stable = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "manifest.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-light",
                "preset": "full",
            }),
        )
        .await;
        assert_eq!(guidance_stable, guidance_light);
        assert_eq!(manifest_stable, manifest_light);

        let guidance_full = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "guidance.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-full",
                "preset": "full",
                "tool_present": true,
            }),
        )
        .await;
        let manifest_full = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "manifest.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-full",
                "preset": "full",
            }),
        )
        .await;
        assert_eq!(guidance_full["preset"], json!("full"));
        assert_eq!(manifest_full["preset"], json!("full"));
        assert_ne!(guidance_full["bytes"], guidance_light["bytes"]);
        assert_ne!(
            manifest_full["content_epoch"],
            manifest_light["content_epoch"]
        );
        assert_eq!(
            guidance_full["manifest_content_epoch"],
            manifest_full["content_epoch"]
        );

        let guidance_full_repeat = call_dispatch_request_on_channel(
            &handler,
            31,
            json!({
                "kind": "guidance.get",
                "session_id": session,
                "model_key": "provider/model",
                "config_identity": "config-full",
                "preset": "light",
                "tool_present": true,
            }),
        )
        .await;
        assert_eq!(guidance_full_repeat, guidance_full);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn guidance_language_directive_is_present_in_both_serializer_variants() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        for request in [
            json!({
                "kind": "guidance.get",
                "session_id": "ses",
                "serializer_profile": "claude-code-anthropic",
                "tool_present": true,
                "language": "tr",
            }),
            json!({
                "kind": "guidance.get",
                "session_id": "ses",
                "serializer_profile": "opencode-aisdk",
                "language": "tr",
            }),
        ] {
            let response = call_dispatch_request(&handler, request).await;
            let bytes = response["bytes"].as_str().unwrap();
            assert!(bytes.contains("Use Turkish (Türkçe) for your natural-language replies"));
            assert_eq!(response["hash"], json!(sha256_hex(bytes.as_bytes())));
        }
    }

    #[test]
    fn ctx_note_schema_declares_one_id_field() {
        let properties = prompt_surface::session_tools(&PromptSurfaceSelection::default())
            .into_iter()
            .find(|tool| tool.name == "ctx_note")
            .unwrap()
            .schema["properties"]
            .clone();
        // A second scalar id field is what made required-all tool surfaces fail
        // every call with filler in both (issue 460).
        assert!(properties.get("note_id").is_none());
        assert_eq!(
            properties["note_ids"],
            json!({
                "type": "array",
                "maxItems": 50,
                "items": { "type": "integer", "minimum": 1, "maximum": 9007199254740991_i64 },
                "description": "Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list."
            })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn opencode_facade_uses_bound_session_without_session_resolver() {
        let resolver = FakeSessionResolver::with(&[]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver.clone(),
        );
        let project_root = project.to_str().unwrap();
        handler.bind_route(
            7,
            binding_with_harness(project_root, OPENCODE_HARNESS, "opencode-session"),
        );
        handler.transform_route_channels.lock().unwrap().insert(
            7,
            ("opencode-session".to_string(), canonical_root(project_root)),
        );
        handler
            .transform_session_roots
            .lock()
            .unwrap()
            .entry("opencode-session".to_string())
            .or_default()
            .insert(canonical_root(project_root));

        let memory = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "write",
                "category": "CONSTRAINTS",
                "content": "OpenCode route identity is durable",
                "memory_project": project_root,
            }),
        )
        .await;
        assert!(!tool_is_error(memory));

        let note = call_facade(
            &handler,
            "ctx_note",
            json!({
                "action": "write",
                "content": "OpenCode route identity is durable",
                "memory_project": project_root,
            }),
        )
        .await;
        assert!(!tool_is_error(note));
        assert!(resolver.calls().is_empty());
        assert_eq!(
            store
                .search_notes_like(project_root, "opencode-session", "route identity")
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claimed_opencode_harness_cannot_bypass_resolution_for_unknown_session() {
        let resolver = FakeSessionResolver::with(&[("wrapper-instance", FakeResolve::None)]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver.clone(),
        );
        handler.bind_route(
            7,
            binding_with_harness(
                project.to_str().unwrap(),
                OPENCODE_HARNESS,
                "wrapper-instance",
            ),
        );

        let outcome = call_facade(
            &handler,
            "ctx_note",
            json!({ "action": "write", "content": "must not be token keyed" }),
        )
        .await;
        assert_eq!(error_code(outcome), "session_unresolved");
        assert_eq!(resolver.calls(), vec!["wrapper-instance"]);
        assert!(store
            .search_notes_like(project.to_str().unwrap(), "wrapper-instance", "token keyed")
            .unwrap()
            .is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claude_code_facade_resolves_instance_token_before_store_access() {
        let resolver = FakeSessionResolver::with(&[(
            "claude-instance-token",
            FakeResolve::Hit("claude-conversation".to_string()),
        )]);
        let (handler, store, _dir, _project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver.clone(),
        );
        handler.bind_route(
            7,
            binding_with_harness("/repo", "claude-code", "claude-instance-token"),
        );

        let note = call_facade(
            &handler,
            "ctx_note",
            json!({
                "action": "write",
                "content": "Claude Code keeps resolver semantics",
            }),
        )
        .await;
        assert!(!tool_is_error(note));
        assert_eq!(resolver.calls(), vec!["claude-instance-token"]);
        assert_eq!(
            store
                .search_notes_like("/repo", "claude-conversation", "resolver semantics")
                .unwrap()
                .len(),
            1
        );
    }

    /// Insert one session note with an explicit timestamp so the glance's age
    /// and stale markers are deterministic.
    fn insert_session_note_at(store: &McStore, content: &str, now_ms: i64) -> i64 {
        store
            .insert_note(NoteInput {
                project_path: "/repo",
                route_project_root: None,
                session_id: "session",
                content,
                surface_condition: None,
                anchor_block_id: None,
                now_ms,
            })
            .unwrap()
            .id
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_glance_pages_with_a_one_line_footer() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        let now = now_ms();
        for index in 0..30 {
            insert_session_note_at(&store, &format!("note {index}"), now - index * 60_000);
        }

        let first = tool_text(call_facade(&handler, "ctx_note", json!({"action": "read"})).await);
        assert!(first.contains("#1 · 0m · note 0"));
        assert!(first.contains("#25 · 24m · note 24"));
        assert!(!first.contains("note 25\n"));
        assert!(first.contains("Showing 25 of 30 — 5 older: ctx_note(action=\"read\", offset=25)"));

        let second = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "offset": 25}),
            )
            .await,
        );
        assert!(second.contains("note 25"));
        assert!(second.contains("note 29"));
        assert!(!second.contains("older: ctx_note"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_bodies_by_id_keep_the_given_order_and_hide_foreign_ids() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        let now = now_ms();
        insert_session_note_at(&store, "first body", now);
        insert_session_note_at(&store, "second body", now);
        store
            .insert_note(NoteInput {
                project_path: "/repo",
                route_project_root: None,
                session_id: "other-session",
                content: "foreign body",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: now,
            })
            .unwrap();

        let bodies = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "note_ids": [2, 1, 3, 999]}),
            )
            .await,
        );

        assert_eq!(
            bodies,
            "## Notes by ID\n\n\
             - **#2** · 0m · active: second body\n\n\
             - **#1** · 0m · active: first body\n\n\
             - Note #3: not_found\n\n\
             - Note #999: not_found\n\n\
             To dismiss a stale note: ctx_note(action=\"dismiss\", note_ids=[N])"
        );
        assert!(!bodies.contains("foreign body"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_glance_walks_past_the_single_page_clamp() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        // The note reads clamp one page to 1000 rows; a queue past that must
        // still report its true total, or the footer count would disagree with
        // the TypeScript legs (which read the whole set).
        let now = now_ms();
        for index in 0..1005 {
            insert_session_note_at(&store, &format!("note {index}"), now - index * 60_000);
        }

        let glance = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "limit": 1, "offset": 1003}),
            )
            .await,
        );

        assert!(glance.contains("#1004 · 16h · note 1003"));
        assert!(glance.contains("Showing 1 of 1005 — 1 older"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_write_reply_reports_the_active_tray() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        let now = now_ms();
        insert_session_note_at(&store, "older tray item", now - 2 * 24 * 60 * 60 * 1000);

        let reply = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "write", "content": "new tray item"}),
            )
            .await,
        );

        assert_eq!(reply, "Saved session note #2. 2 active, oldest 2d.");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_uses_context_ids_and_refuses_the_retired_id_lane_fields() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));
        insert_session_note_at(&store, "module lane note", now_ms());
        let write = tool_body(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "write", "content": "second"}),
            )
            .await,
        );
        assert_eq!(
            write["content"][0]["text"],
            "Saved session note #2. 2 active, oldest 0m."
        );
        let refused = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "read", "note_ids": [1], "note_id_map": [[1, 1]]}),
        )
        .await;
        assert_eq!(error_code(refused), "invalid_params");
        let host_lane = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "read", "note_ids": [1], "note_id_lane": "host"}),
        )
        .await;
        assert_eq!(error_code(host_lane), "invalid_params");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_routes_each_envelope_class_to_a_distinct_arm() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());

        // A flat body with kind="transform" names a retired route and is refused by name.
        let transform = handler
            .dispatch_value(7, request(vec![ck("m1", 1, "hello")]))
            .await;
        assert!(
            matches!(&transform, HandlerOutcome::Error { code, message }
                if code == RETIRED_ROUTE_CODE && message == "transform"),
            "{transform:?}"
        );

        // Explicit echo: opt-in debugging arm still works when asked for by name.
        let echo = handler
            .dispatch_value(7, json!({ "kind": "echo", "probe": 42 }))
            .await;
        let echo_body: Value = match echo {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("echo should respond, got {other:?}"),
        };
        assert_eq!(echo_body["ok"], json!(true));
        assert_eq!(echo_body["echo"]["probe"], json!(42));

        // MCP tools/call envelope ({name, arguments}, no method/kind): a
        // DISTINCT error so a facade misroute is diagnosable from the code.
        let facade = handler
            .dispatch_value(
                7,
                json!({ "name": "ctx_unknown", "arguments": { "drop": "1-3" } }),
            )
            .await;
        assert_eq!(error_code(facade), "facade_envelope_not_supported");

        // Anything else: fail loud, never a silent echo. The message names the
        // keys that were present so a misrouted request is diagnosable.
        let garbage = handler
            .dispatch_value(7, json!({ "foo": 1, "bar": 2 }))
            .await;
        match garbage {
            HandlerOutcome::Error { code, message } => {
                assert_eq!(code, "unrecognized_request_shape");
                assert!(message.contains("foo"), "message names got keys: {message}");
            }
            other => panic!("expected error outcome, got {other:?}"),
        }

        // Non-object bodies get the same loud failure with the JSON type named.
        let non_object = handler.dispatch_value(7, json!("just a string")).await;
        match non_object {
            HandlerOutcome::Error { code, message } => {
                assert_eq!(code, "unrecognized_request_shape");
                assert!(message.contains("string"), "message names type: {message}");
            }
            other => panic!("expected error outcome, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_session_resolve_errors_are_typed() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[
            ("missing-map", FakeResolve::None),
            ("slow-map", FakeResolve::Timeout),
        ]);
        let (handler, _store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver.clone());

        handler.bind_route(7, binding_with_harness("/repo", "claude-code", ""));
        let no_token = call_facade(
            &handler,
            "ctx_search",
            json!({ "query": "anything", "limit": 1 }),
        )
        .await;
        match no_token {
            HandlerOutcome::Error { code, message } => {
                assert_eq!(code, "session_unresolved");
                assert_eq!(message, SESSION_UNRESOLVED_MESSAGE);
            }
            other => panic!("expected unresolved error, got {other:?}"),
        }
        assert_eq!(resolver.calls(), Vec::<String>::new());

        handler.bind_route(
            7,
            binding_with_harness("/repo", "claude-code", "missing-map"),
        );
        let none = call_facade(
            &handler,
            "ctx_search",
            json!({ "query": "anything", "limit": 1 }),
        )
        .await;
        assert_eq!(error_code(none), "session_unresolved");

        handler.bind_route(7, binding_with_harness("/repo", "claude-code", "slow-map"));
        let timeout = call_facade(
            &handler,
            "ctx_search",
            json!({ "query": "anything", "limit": 1 }),
        )
        .await;
        assert_eq!(error_code(timeout), "session_resolve_timeout");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_multi_instance_shares_memory_pool_and_splits_compartment_scope() {
        let producer = Arc::new(ProducerState::default());
        let project_root = "/same/repo";
        let key_a = "pm_a5ee3bf8/session-A/epoch-1";
        let key_b = "pm_a5ee3bf8/session-B/epoch-1";
        let resolver = FakeSessionResolver::with(&[
            ("token-a", FakeResolve::Hit(key_a.to_string())),
            ("token-b", FakeResolve::Hit(key_b.to_string())),
        ]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding(project_root, "token-a"));
        handler.bind_route(8, binding(project_root, "token-b"));
        store
            .replace_compartments(
                key_a,
                &[stored_comp(1, 1, 10, "a10", "alpha-compartment-only")],
            )
            .unwrap();
        store
            .replace_compartments(
                key_b,
                &[stored_comp(1, 1, 10, "b10", "beta-compartment-only")],
            )
            .unwrap();

        let a = call_facade_on_channel(
            &handler,
            7,
            "ctx_memory",
            json!({ "action": "write", "category": "CONSTRAINTS", "content": "shared project fact" }),
        )
        .await;
        assert!(!tool_is_error(a));
        let b_search = tool_text(
            call_facade_on_channel(
                &handler,
                8,
                "ctx_search",
                json!({ "query": "shared project fact", "limit": 5 }),
            )
            .await,
        );
        assert!(b_search.contains("[memory]"), "{b_search}");

        let b = call_facade_on_channel(
            &handler,
            8,
            "ctx_memory",
            json!({ "action": "write", "category": "CONSTRAINTS", "content": "second shared fact" }),
        )
        .await;
        assert!(!tool_is_error(b));

        let project_rows = store.load_active_memories(project_root, now_ms()).unwrap();
        assert_eq!(project_rows.len(), 2);
        assert!(project_rows
            .iter()
            .any(|memory| memory.content == "shared project fact"));
        assert!(project_rows
            .iter()
            .any(|memory| memory.content == "second shared fact"));
        let first = store.get_memory_full(project_rows[0].id).unwrap().unwrap();
        assert_eq!(first.source_session_id.as_deref(), Some(key_a));
        assert!(store
            .load_active_memories(key_a, now_ms())
            .unwrap()
            .is_empty());
        assert!(store
            .load_active_memories(key_b, now_ms())
            .unwrap()
            .is_empty());

        let a_comp = tool_text(
            call_facade_on_channel(
                &handler,
                7,
                "ctx_search",
                json!({ "query": "alpha-compartment-only", "limit": 5 }),
            )
            .await,
        );
        assert!(a_comp.contains("[message]"), "{a_comp}");
        let a_cannot_see_b = tool_text(
            call_facade_on_channel(
                &handler,
                7,
                "ctx_search",
                json!({ "query": "beta-compartment-only", "limit": 5 }),
            )
            .await,
        );
        assert_eq!(
            a_cannot_see_b,
            "No results found for \"beta-compartment-only\" across notes, memories, primers, git commits, or message history."
        );
        let b_comp = tool_text(
            call_facade_on_channel(
                &handler,
                8,
                "ctx_search",
                json!({ "query": "beta-compartment-only", "limit": 5 }),
            )
            .await,
        );
        assert!(b_comp.contains("[message]"), "{b_comp}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_flat_envelope_precedence_keeps_kind_arm_and_gates_ctx_reduce_name() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[(
            "token",
            FakeResolve::Hit("composite-session".to_string()),
        )]);
        let (handler, _store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        let echo = handler
            .dispatch_value(
                7,
                json!({ "kind": "echo", "name": "ctx_memory", "arguments": { "action": "write" } }),
            )
            .await;
        let echo_body = tool_body(echo);
        assert_eq!(echo_body["ok"], json!(true));
        assert_eq!(echo_body["echo"]["kind"], "echo");

        let reduce = tool_text(call_facade(&handler, "ctx_reduce", json!({ "drop": "1-3" })).await);
        assert!(reduce.contains("Refused: no valid tags to queue"));
        assert!(reduce.contains("tags 1, 2, 3 not found"));
    }

    #[test]
    fn ctx_reduce_range_parser_rejects_unbounded_and_oversized_ranges() {
        assert!(parse_tag_range_string("0-18446744073709551615").is_err());
        assert!(parse_tag_range_string("5-3").is_err());
        assert_eq!(parse_tag_range_string("3-5,8").unwrap(), vec![3, 4, 5, 8]);
        assert!(parse_tag_range_string("1-1001").is_err());
    }

    #[test]
    fn facade_arguments_preserve_decorated_reduced_fields() {
        let request = json!({
            "arguments": {
                "drop": "1-5",
                "reduced": true,
                "summary": "{\"drop\":\"1-5\"}",
                "stray": "kept"
            }
        });
        let arguments = facade_arguments(&request, &["drop"]).expect("arguments object");
        assert_eq!(arguments["drop"], json!("1-5"));
        assert_eq!(arguments["reduced"], json!(true));
        assert_eq!(arguments["summary"], json!("{\"drop\":\"1-5\"}"));
        assert_eq!(arguments["stray"], json!("kept"));
    }

    #[test]
    fn ctx_expand_verbose_range_separates_messages_and_previews_raw_parts() {
        let output = "line1\nline2\nline3";
        let messages = vec![
            CkIngressMessage {
                mid: "m10".to_string(),
                ordinal: 10,
                ck: CkWireMessage::from_parts(
                    "assistant",
                    vec![
                        CkWireBlock::bare(CkKind::Text {
                            text: "x".repeat(201),
                        }),
                        CkWireBlock::bare(CkKind::ToolCall {
                            id: "read:1".to_string(),
                            name: "read".to_string(),
                            input: json!({ "filePath": "config.ts" }),
                            provider_executed: false,
                        }),
                    ],
                    None,
                    ProviderExtras::new(),
                    HarnessMeta::default(),
                ),
            },
            CkIngressMessage {
                mid: "m11".to_string(),
                ordinal: 11,
                ck: CkWireMessage::from_parts(
                    "user",
                    vec![CkWireBlock::bare(CkKind::ToolResult {
                        id: "read:1".to_string(),
                        tool_name: "read".to_string(),
                        output: CkToolOutput::bare(CkOutputKind::Text {
                            text: output.to_string(),
                        }),
                        provider_executed: false,
                    })],
                    None,
                    ProviderExtras::new(),
                    HarnessMeta::default(),
                ),
            },
        ];

        let rendered = render_verbose_range_expand(&messages, 10, 11);
        assert!(rendered.text.contains("[10] A (assistant)"));
        assert!(rendered.text.contains("[11] tool results"));
        assert!(rendered
            .text
            .contains(&format!("    • {}…", "x".repeat(200))));
        assert!(rendered.text.contains("    • tool read(config.ts)"));
        assert!(rendered.text.contains(&format!(
            "    • tool read → output ~{} tok",
            mc_tokenizer::estimate_tokens(output)
        )));
        assert_eq!(rendered.last_ordinal, 11);
        assert!(!rendered.truncated);

        let first = render_verbose_expand_message(&messages[0]);
        let bounded = render_verbose_range_expand_with_budget(
            &messages,
            10,
            11,
            mc_tokenizer::estimate_tokens(&first),
        );
        assert_eq!(bounded.last_ordinal, 10);
        assert!(bounded.truncated);
        assert!(!bounded.text.contains("[11] U (user)"));
    }

    #[test]
    fn ctx_reduce_reply_matches_shared_cases() {
        #[derive(serde::Deserialize)]
        struct Case {
            label: String,
            stamped: usize,
            self_stamps: usize,
            expected: String,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../packages/plugin/src/tools/ctx-reduce/reply-cases.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                ctx_reduce_reply(case.stamped, case.self_stamps),
                case.expected,
                "{}",
                case.label
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_tools_hide_engine_internals_when_storage_is_unavailable() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let handler = McHandler::with_producer_factory_config_resolver(
            Arc::new(TestProducerFactory { state: producer }),
            default_test_config(),
            resolver,
        );
        handler.bind_route(8, binding("/path/that/does/not/exist", "ses"));

        let requests = [
            ("ctx_reduce", json!({ "drop": "1" })),
            ("ctx_memory", json!({ "action": "get", "ids": [1] })),
            ("ctx_search", json!({ "query": "architecture" })),
            ("ctx_expand", json!({ "message": 0 })),
            ("ctx_note", json!({ "action": "read" })),
        ];
        for (name, arguments) in requests {
            let (_, message) =
                error_frame(call_facade_on_channel(&handler, 8, name, arguments).await);
            assert_eq!(
                message, "Magic Context is temporarily unavailable. Retry in a moment. (MC-C10)",
                "{name}"
            );
            let lowered = message.to_ascii_lowercase();
            for forbidden in [
                "authority",
                "module",
                "drain",
                "facade",
                "changefeed",
                "mc-store",
                "harness",
            ] {
                assert!(!lowered.contains(forbidden), "{name}: {message}");
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_ctx_reduce_resolves_the_session_before_validating_tags() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[("unresolvable", FakeResolve::None)]);
        let handler = McHandler::with_producer_factory_config_resolver(
            Arc::new(TestProducerFactory { state: producer }),
            default_test_config(),
            resolver.clone(),
        );
        handler.bind_route(8, binding("/path/that/does/not/exist", "unresolvable"));

        let response =
            call_facade_on_channel(&handler, 8, "ctx_reduce", json!({ "drop": "1" })).await;
        assert_eq!(error_code(response), "session_unresolved");
        assert_eq!(resolver.calls(), vec!["unresolvable"]);
        assert!(
            handler.store.get().is_none(),
            "an unresolved session must not open storage to validate tags"
        );
    }

    #[test]
    // Advertised schemas now byte-match TypeScript's closed objects
    // (additionalProperties: false). Execution remains tolerant of unrelated keys;
    // the dispatch regression below protects that separate compatibility contract.
    fn ctx_manifest_matches_closed_typescript_fields_without_reduction_placeholders() {
        let manifest = manifest("magic-context");
        let ProviderRole::ToolProvider { tools, .. } = &manifest.provides[0] else {
            panic!("tool provider manifest entry");
        };
        let by_name = tools
            .iter()
            .map(|tool| (tool.name.as_str(), tool))
            .collect::<HashMap<_, _>>();
        let expected_fields = [
            ("ctx_reduce", vec!["drop"]),
            (
                "ctx_memory",
                vec!["action", "category", "content", "ids", "reason"],
            ),
            (
                "ctx_search",
                vec!["query", "limit", "from", "to", "sources"],
            ),
            (
                "ctx_expand",
                vec!["start", "end", "verbose", "message", "tag"],
            ),
            (
                "ctx_note",
                vec![
                    "action",
                    "content",
                    "note_ids",
                    "limit",
                    "offset",
                    "filter",
                    "surface_condition",
                ],
            ),
        ];

        // The Claude Code gateway authorizes ctx_reduce by exact schema match;
        // changing this canonical closed shape disables tagging there. Compatibility
        // with imitated call arguments lives in the execution unwrap. Advertised
        // objects remain closed independently of that runtime tolerance.
        assert_eq!(
            by_name["ctx_reduce"].schema,
            json!({
                "type": "object",
                "properties": {
                    "drop": {
                        "type": "string",
                        "description": "Tag IDs to drop: \"3-5\", \"1,2,9\", \"1-5,8,12-15\"."
                    }
                },
                "required": ["drop"],
                "additionalProperties": false
            }),
            "ctx_reduce advertised schema must stay byte-canonical (authorizer contract)"
        );

        assert_eq!(
            by_name["ctx_expand"].schema["properties"]["verbose"]["type"],
            json!("boolean"),
            "ctx_expand must advertise verbose range previews"
        );

        for (name, expected) in expected_fields {
            let tool = by_name
                .get(name)
                .unwrap_or_else(|| panic!("missing {name} manifest entry"));
            assert_eq!(
                tool.schema.get("additionalProperties"),
                Some(&json!(false)),
                "{name} advertised schema must match TypeScript"
            );
            let properties = tool.schema["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{name} schema properties"));
            let mut actual = properties.keys().map(String::as_str).collect::<Vec<_>>();
            actual.sort_unstable();
            let mut expected = expected;
            expected.sort_unstable();
            assert_eq!(actual, expected, "{name} advertised fields changed");
            assert!(!properties.contains_key("reduced"));
            assert!(!properties.contains_key("summary"));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn closed_advertisement_keeps_execution_tolerant_and_required_refusals_unchanged() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, _store, _dir, _project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let valid = tool_body(call_facade(&handler, "ctx_note", json!({"action":"read"})).await);
        assert_eq!(valid["isError"], json!(false));
        let with_extra = tool_body(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action":"read", "stray":{"ignored":true}}),
            )
            .await,
        );
        assert_eq!(
            with_extra, valid,
            "closed advertisement does not add runtime key validation"
        );
        for (name, arguments, refusal) in [
            (
                "ctx_reduce",
                json!({}),
                r#"Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}."#,
            ),
            (
                "ctx_reduce",
                json!({"drop":false}),
                r#"Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}."#,
            ),
            (
                "ctx_search",
                json!({}),
                "Error: 'query' is required for ctx_search.",
            ),
            (
                "ctx_search",
                json!({"query":false}),
                "Error: 'query' is required for ctx_search.",
            ),
        ] {
            let rejected = tool_body(call_facade(&handler, name, arguments.clone()).await);
            assert_eq!(rejected["isError"], json!(true));
            assert_eq!(rejected["content"][0]["text"], json!(refusal));
            let mut extra = arguments;
            extra["stray"] = json!({"ignored":true});
            let extra_rejected = tool_body(call_facade(&handler, name, extra).await);
            assert_eq!(
                extra_rejected, rejected,
                "{name} required-field refusal changed with an extra key"
            );
        }
    }

    #[test]
    fn expand_output_is_bounded_to_the_typescript_token_budget() {
        let output = truncate_expand_output("x".repeat(CTX_EXPAND_BYTE_BUDGET * 2));
        assert!(output.len() <= CTX_EXPAND_BYTE_BUDGET + 64);
        assert!(output.contains("~15,000-token ctx_expand budget"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_never_panics_on_malformed_memory_arguments() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[(
            "token",
            FakeResolve::Hit("opaque-own-conversation".to_string()),
        )]);
        let (handler, _store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));

        let malformed = [
            json!({ "action": "update", "content": "edited" }),
            json!({ "action": "update", "ids": [], "content": "edited" }),
            json!({ "action": "update", "ids": ["x"], "content": "edited" }),
            json!({ "action": "update", "id": -1, "content": "edited" }),
            json!({ "action": "update", "id": u64::MAX, "content": "edited" }),
            json!({ "action": "archive" }),
            json!({ "action": "archive", "ids": [] }),
            json!({ "action": "archive", "ids": ["x"] }),
            json!({ "action": "archive", "id": -1 }),
            json!({ "action": "archive", "id": u64::MAX }),
            json!({ "action": "merge", "content": "merged" }),
            json!({ "action": "merge", "ids": [], "content": "merged" }),
            json!({ "action": "merge", "ids": ["x"], "content": "merged" }),
            json!({ "action": "merge", "ids": [-1, -2], "content": "merged" }),
            json!({ "action": "merge", "ids": [u64::MAX, 1], "content": "merged" }),
        ];

        for arguments in malformed {
            let outcome = call_facade(&handler, "ctx_memory", arguments.clone()).await;
            assert!(
                tool_is_error(outcome),
                "malformed arguments must return a typed tool error: {arguments}"
            );
        }
        let oversized = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "write",
                "category": "CONSTRAINTS",
                "content": "x".repeat(MAX_MEMORY_CONTENT_BYTES + 1),
            }),
        )
        .await;
        assert!(tool_is_error(oversized));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_unwraps_imitated_reduced_arguments_without_overriding_real_values() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));
        let id = insert_memory(&store, "/repo", "CONSTRAINTS", "Run focused tests.", 1);

        let plain = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "get", "ids": [id] }),
            )
            .await,
        );
        let imitated = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "reduced": true,
                    "summary": json!({ "action": "get", "ids": [id] }).to_string(),
                }),
            )
            .await,
        );
        let real_arguments = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "get",
                    "ids": [id],
                    "reduced": true,
                    "summary": json!({ "action": "archive", "ids": [id] }).to_string(),
                }),
            )
            .await,
        );
        let malformed = error_frame(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "reduced": true, "summary": "not JSON" }),
            )
            .await,
        );
        let plain_missing = error_frame(call_facade(&handler, "ctx_memory", json!({})).await);
        let reduce_plain =
            tool_text(call_facade(&handler, "ctx_reduce", json!({ "drop": "1" })).await);
        let reduce_imitated = tool_text(
            call_facade(
                &handler,
                "ctx_reduce",
                json!({
                    "reduced": true,
                    "summary": json!({ "drop": "1" }).to_string(),
                }),
            )
            .await,
        );

        assert_eq!(imitated, plain);
        assert_eq!(real_arguments, plain);
        assert_eq!(store.get_memory_full(id).unwrap().unwrap().status, "active");
        assert_eq!(malformed, plain_missing);
        assert_eq!(reduce_imitated, reduce_plain);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claude_code_memory_lane_keeps_module_ids_byte_for_byte() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let project = project.to_str().unwrap();
        handler.bind_route(7, binding_with_harness(project, "claude-code", "token"));
        assert_eq!(
            insert_memory(&store, project, "CONSTRAINTS", "claude row", 1),
            1
        );

        let get = call_facade(
            &handler,
            "ctx_memory",
            json!({ "action": "get", "ids": [1] }),
        )
        .await;
        assert_eq!(
            tool_text(get),
            "Memory [ID: 1] in CONSTRAINTS (status: active): claude row"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn memory_facade_update_honors_category_and_rejects_invalid_or_duplicate_targets() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));
        let recategorized = insert_memory(&store, "/repo", "CONFIG_VALUES", "old config", 1);
        let omitted = insert_memory(&store, "/repo", "NAMING", "old name", 1);
        let duplicate = insert_memory(&store, "/repo", "CONSTRAINTS", "same value", 1);
        let duplicate_target = insert_memory(&store, "/repo", "ARCHITECTURE", "different value", 1);

        let updated = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "update",
                "id": recategorized,
                "category": "CONSTRAINTS",
                "content": "new constraint"
            }),
        )
        .await;
        assert!(!tool_is_error(updated.clone()));
        assert_eq!(
            tool_text(updated),
            format!("Updated memory [ID: {recategorized}] in CONSTRAINTS.")
        );
        let updated_row = store.get_memory_full(recategorized).unwrap().unwrap();
        assert_eq!(updated_row.category, "CONSTRAINTS");
        assert_eq!(updated_row.content, "new constraint");
        let mutation = store
            .memory_mutations_for_render(&["/repo".to_string()], 0, &[recategorized])
            .unwrap();
        assert_eq!(
            mutation.last().unwrap().category.as_deref(),
            Some("CONSTRAINTS")
        );

        let preserved = call_facade(
            &handler,
            "ctx_memory",
            json!({ "action": "update", "id": omitted, "content": "new name" }),
        )
        .await;
        assert!(!tool_is_error(preserved));
        assert_eq!(
            store.get_memory_full(omitted).unwrap().unwrap().category,
            "NAMING"
        );

        let invalid = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "update",
                "id": omitted,
                "category": "NOT_A_CATEGORY",
                "content": "invalid update"
            }),
        )
        .await;
        assert!(tool_is_error(invalid.clone()));
        assert_eq!(
            tool_text(invalid),
            "Error: category must be one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING."
        );
        assert_eq!(
            store.get_memory_full(omitted).unwrap().unwrap().content,
            "new name"
        );

        let duplicate_error = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "update",
                "id": duplicate_target,
                "category": "CONSTRAINTS",
                "content": "same value"
            }),
        )
        .await;
        assert!(tool_is_error(duplicate_error.clone()));
        let duplicate_text = tool_text(duplicate_error);
        assert!(
            duplicate_text.contains(&format!("memory content already exists as ID {duplicate}")),
            "{duplicate_text}"
        );
        assert!(!duplicate_text.contains("UNIQUE constraint failed"));
        let duplicate_target = store.get_memory_full(duplicate_target).unwrap().unwrap();
        assert_eq!(duplicate_target.category, "ARCHITECTURE");
        assert_eq!(duplicate_target.content, "different value");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_mutation_commands_replay_each_memory_and_note_action_without_advancing_state() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/route/facade-ledger", "token"));
        let project = "/route/facade-ledger";

        async fn call_and_replay(
            handler: &McHandler,
            store: &McStore,
            name: &str,
            action: &str,
            command_id: &str,
            arguments: Value,
        ) {
            let first = call_facade(handler, name, arguments.clone()).await;
            let first_bytes = match first {
                HandlerOutcome::Response(bytes) => bytes,
                other => panic!("first {name}/{action} failed: {other:?}"),
            };
            let mut retry_arguments = arguments;
            retry_arguments["command_id"] = json!(command_id);
            let retry = call_facade(handler, name, retry_arguments).await;
            let retry_body = tool_body(retry);
            let mut original_body: Value = serde_json::from_slice(&first_bytes).unwrap();
            assert_eq!(
                store
                    .facade_mutation_ledger_response("session", name, action, command_id)
                    .unwrap(),
                Some(first_bytes),
                "ledger must retain the exact first response for {name}/{action}"
            );
            original_body["replayed"] = Value::Bool(true);
            assert_eq!(retry_body, original_body);
        }

        call_and_replay(
            &handler,
            &store,
            "ctx_memory",
            "write",
            "memory-write",
            json!({
                "action": "write",
                "category": "CONSTRAINTS",
                "content": "first",
                "command_id": "memory-write"
            }),
        )
        .await;
        let memory_revision_after_write =
            crate::m1_compose::m1_revision_signal(&store, project, "session").unwrap();
        call_and_replay(
            &handler,
            &store,
            "ctx_memory",
            "update",
            "memory-update",
            json!({
                "action": "update",
                "ids": [1],
                "content": "updated",
                "command_id": "memory-update"
            }),
        )
        .await;
        let memory_revision_after_update =
            crate::m1_compose::m1_revision_signal(&store, project, "session").unwrap();
        // A busting SOFT renders no memory rows, so memory edits never move the m1 revision.
        assert_eq!(memory_revision_after_update, memory_revision_after_write);
        call_and_replay(
            &handler,
            &store,
            "ctx_memory",
            "archive",
            "memory-archive",
            json!({
                "action": "archive",
                "ids": [1],
                "command_id": "memory-archive"
            }),
        )
        .await;
        let memory_revision_after_archive =
            crate::m1_compose::m1_revision_signal(&store, project, "session").unwrap();
        assert_eq!(memory_revision_after_archive, memory_revision_after_update);
        let fragments = store.load_agent_fragments("session", 0).unwrap();
        assert_eq!(
            fragments.len(),
            3,
            "each canonical operation and its retry commit one fragment"
        );
        assert_eq!(
            fragments[0].lines,
            vec!["  <added id=\"1\" category=\"CONSTRAINTS\">first</added>"]
        );
        assert_eq!(
            fragments[1].lines,
            vec!["  <updated id=\"1\" category=\"CONSTRAINTS\">updated</updated>"]
        );
        assert_eq!(fragments[2].lines, vec!["  <removed id=\"1\"/>"]);

        call_and_replay(
            &handler,
            &store,
            "ctx_note",
            "write",
            "note-write",
            json!({
                "action": "write",
                "content": "remember this",
                "command_id": "note-write"
            }),
        )
        .await;
        let note_revision_after_write = store.max_note_status_version(project).unwrap();
        call_and_replay(
            &handler,
            &store,
            "ctx_note",
            "update",
            "note-update",
            json!({
                "action": "update",
                "note_ids": [1],
                "content": "updated note",
                "command_id": "note-update"
            }),
        )
        .await;
        let note_revision_after_update = store.max_note_status_version(project).unwrap();
        // The note revision is its updated_at, which only moves forward.
        assert!(note_revision_after_update > note_revision_after_write);
        call_and_replay(
            &handler,
            &store,
            "ctx_note",
            "dismiss",
            "note-dismiss",
            json!({
                "action": "dismiss",
                "note_ids": [1],
                "command_id": "note-dismiss"
            }),
        )
        .await;
        let note_revision_after_dismiss = store.max_note_status_version(project).unwrap();
        assert!(note_revision_after_dismiss > note_revision_after_update);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn classification_facade_hash_fences_rows_and_keeps_m1_revision_stable() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_project_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_project_root, "token"));
        activate_module_authority(
            &store,
            "context",
            "git:classify",
            route_project_root,
            "memories",
        );
        let fresh_id = insert_memory(
            &store,
            "git:classify",
            "PROJECT_RULES",
            "fresh classification",
            1,
        );
        let stale_id = insert_memory(
            &store,
            "git:classify",
            "PROJECT_RULES",
            "stale classification",
            1,
        );
        let fresh_hash = store
            .get_memory_full(fresh_id)
            .unwrap()
            .unwrap()
            .normalized_hash;
        let generation = 1u64;
        let before =
            crate::m1_compose::m1_revision_signal(&store, "git:classify", "session").unwrap();
        let outcome = call_facade(
            &handler,
            "memory.set_classification",
            json!({
                "memory_project": "git:classify",
                "context_store_uuid": "context",
                "authority_generation": generation,
                "rows": [
                    {
                        "memory_id": fresh_id,
                        "content_hash_at_prompt": fresh_hash,
                        "importance": 91,
                        "scope": "project",
                        "shareable": true
                    },
                    {
                        "memory_id": stale_id,
                        "content_hash_at_prompt": "stale-hash",
                        "importance": 1,
                        "scope": "project",
                        "shareable": true
                    }
                ]
            }),
        )
        .await;
        let response = match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("classification facade failed: {other:?}"),
        };
        assert_eq!(response["accepted"], json!([fresh_id]));
        assert_eq!(response["rejected"][0]["reason"], "stale");
        assert_eq!(
            store.get_memory_full(fresh_id).unwrap().unwrap().importance,
            Some(91)
        );
        let after =
            crate::m1_compose::m1_revision_signal(&store, "git:classify", "session").unwrap();
        assert_eq!(before, after, "classification metadata must not change m1");
    }

    /// The dreamer's expiry sweep for a module-owned project is an automated archive: the
    /// store rechecks each row's declared expiry, archives it with undo history and writes no
    /// mutation-log row (the TypeScript local path writes the same records). A row whose
    /// expiry has not passed is refused and left live.
    #[tokio::test(flavor = "current_thread")]
    async fn module_routed_expiry_writes_history_and_no_mutation_log() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_root = project.to_str().unwrap();
        let identity = "git:r4-expiry";
        handler.bind_route(7, binding(route_root, "token"));
        activate_module_authority(&store, "context", identity, route_root, "memories");
        let expired = insert_memory(&store, identity, "CONSTRAINTS", "expired rule", 1);
        let live = insert_memory(&store, identity, "CONSTRAINTS", "still valid rule", 1);
        store
            .with_context_conn_for_test(|tx| {
                tx.execute(
                    "UPDATE memories SET expires_at = 1 WHERE id = ?1",
                    [expired],
                )?;
                tx.execute(
                    "UPDATE memories SET expires_at = 9999999999999 WHERE id = ?1",
                    [live],
                )
            })
            .unwrap();
        let outcome = call_facade(
            &handler,
            "memory.expire",
            json!({
                "memory_project": identity, "ids": [expired, live],
                "context_store_uuid": "context", "authority_generation": 1, "command_id": "r4-expire"
            }),
        )
        .await;
        let body = match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("expiry facade failed: {other:?}"),
        };
        assert_eq!(body["accepted"], json!([expired]));
        assert_eq!(body["rejected"][0]["reason"], json!("not_expired"));
        assert_eq!(
            store.get_memory_full(expired).unwrap().unwrap().status,
            "archived"
        );
        assert_eq!(
            store.get_memory_full(live).unwrap().unwrap().status,
            "active"
        );
        let counts: (i64, i64) = store
            .with_context_conn_for_test(|tx| {
                tx.query_row(
                    "SELECT (SELECT COUNT(*) FROM memory_mutation_log WHERE target_memory_id = ?1),
                            (SELECT COUNT(*) FROM memory_history WHERE memory_id = ?1)",
                    [expired],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(
            counts,
            (0, 1),
            "expiry needs undo history, not a prompt mutation signal"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn module_curate_facade_applies_update_merge_archive_without_agent_fragments() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_root = project.to_str().unwrap();
        let identity = "git:curate-direct";
        handler.bind_route(7, binding(route_root, "token"));
        activate_module_authority(&store, "context", identity, route_root, "memories");
        let first = insert_memory(&store, identity, "CONSTRAINTS", "cache_ttl=5m", 1);
        let second = insert_memory(&store, identity, "CONSTRAINTS", "cache_ttl=10m", 1);
        let update = json!({ "memory_project": identity, "context_store_uuid": "context", "authority_generation": 1, "command_id": "curate-update", "action": "update", "ids": [first], "expected_revisions": [{"id": first, "revision": 1}], "content": "cache_ttl=15m" });
        let applied = tool_body(call_facade(&handler, "memory.curate", update.clone()).await);
        assert!(applied["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Updated memory"));
        assert_eq!(
            applied["structuredContent"],
            json!({"state": "applied", "memory_id": first, "superseded_ids": [], "error_code": null})
        );
        let replay = tool_body(call_facade(&handler, "memory.curate", update).await);
        assert_eq!(replay["structuredContent"], applied["structuredContent"]);
        assert_eq!(
            store.get_memory_full(first).unwrap().unwrap().content,
            "cache_ttl=15m"
        );
        let merged = tool_body(call_facade(&handler, "memory.curate", json!({ "memory_project": identity, "context_store_uuid": "context", "authority_generation": 1, "command_id": "curate-merge", "action": "merge", "ids": [first, second], "expected_revisions": [{"id": first, "revision": 2}, {"id": second, "revision": 1}], "content": "cache_ttl=20m" })).await);
        assert!(
            merged["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("Merged memories"),
            "{merged}"
        );
        assert_eq!(
            store.get_memory_full(first).unwrap().unwrap().status,
            "archived"
        );
        let canonical: (i64, i64) = store
            .with_context_conn_for_test(|conn| {
                conn.query_row(
                    "SELECT id,revision FROM memories WHERE content='cache_ttl=20m'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(
            merged["structuredContent"],
            json!({"state": "applied", "memory_id": canonical.0, "superseded_ids": [first, second], "error_code": null})
        );
        let archive = tool_body(call_facade(&handler, "memory.curate", json!({ "memory_project": identity, "context_store_uuid": "context", "authority_generation": 1, "command_id": "curate-archive", "action": "archive", "ids": [canonical.0], "expected_revisions": [{"id": canonical.0, "revision": canonical.1}], "reason": "obsolete" })).await);
        assert!(
            archive["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("Archived memory"),
            "{archive}"
        );
        assert_eq!(
            archive["structuredContent"],
            json!({"state": "applied", "memory_id": canonical.0, "superseded_ids": [], "error_code": null})
        );
        assert_eq!(
            store.get_memory_full(canonical.0).unwrap().unwrap().status,
            "archived"
        );
        let inactive = tool_body(call_facade(&handler, "memory.curate", json!({ "memory_project": identity, "context_store_uuid": "context", "authority_generation": 1, "command_id": "curate-inactive", "action": "archive", "ids": [canonical.0], "expected_revisions": [{"id": canonical.0, "revision": canonical.1 + 1}] })).await);
        assert_eq!(
            inactive["structuredContent"],
            json!({"state": "refused", "memory_id": null, "superseded_ids": [], "error_code": "not_active"})
        );
        store
            .with_context_conn_for_test(|conn| {
                for table in [
                    "memory_mutation_log",
                    "memory_agent_fragments",
                    "memory_tool_proposals",
                ] {
                    assert_eq!(
                        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                            .get::<_, i64>(0))?,
                        0,
                        "{table}"
                    );
                }
                assert_eq!(
                    conn.query_row(
                        "SELECT COUNT(*) FROM memory_history WHERE memory_id=?1",
                        [first],
                        |row| row.get::<_, i64>(0)
                    )?,
                    2
                );
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn noprop_curate_stale_cas_refuses_each_action_and_changes_nothing() {
        if std::env::var("MC_NOPROP_REVIEW").as_deref() != Ok("1") {
            return;
        }
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let root = project.to_str().unwrap();
        let identity = "git:noprop-cas";
        handler.bind_route(7, binding(root, "token"));
        activate_module_authority(&store, "context", identity, root, "memories");
        let first = insert_memory(&store, identity, "CONSTRAINTS", "Original first.", 1);
        let second = insert_memory(&store, identity, "CONSTRAINTS", "Original second.", 1);
        for action in ["update", "archive", "merge"] {
            let ids = if action == "merge" {
                vec![first, second]
            } else {
                vec![first]
            };
            let expected: Vec<Value> = ids
                .iter()
                .map(|id| json!({"id": id, "revision": if *id == first { 0 } else { 1 }}))
                .collect();
            let body = tool_body(call_facade(&handler, "memory.curate", json!({
                "memory_project": identity, "command_id": format!("stale-{action}"),
                "action": action, "ids": ids, "expected_revisions": expected, "content": "Replacement.",
            })).await);
            assert_eq!(body["isError"], true, "{action}: {body}");
            assert_eq!(
                body["structuredContent"],
                json!({"state": "refused", "memory_id": null, "superseded_ids": [], "error_code": "mutation_refused"}),
                "{action}: {body}"
            );
            assert!(
                body["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("stale_revision"),
                "{action}: {body}"
            );
        }
        let foreign = insert_memory(&store, "git:foreign", "CONSTRAINTS", "Foreign source.", 1);
        store.with_context_conn_for_test(|conn| {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS authority_managed(project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL)")?;
            conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?1,'review',1)", [identity])?;
            Ok(())
        }).unwrap();
        let refused = tool_body(call_facade(&handler, "memory.curate", json!({
            "memory_project": identity, "command_id": "mixed-authority", "action": "merge",
            "ids": [first, foreign], "expected_revisions": [{"id": first, "revision": 1}, {"id": foreign, "revision": 1}],
            "content": "Merged foreign source.",
        })).await);
        assert_eq!(refused["isError"], true, "{refused}");
        assert_eq!(
            store.get_memory_full(foreign).unwrap().unwrap().status,
            "active"
        );
        assert_eq!(
            store.get_memory_full(first).unwrap().unwrap().content,
            "Original first."
        );
        assert_eq!(
            store.get_memory_full(second).unwrap().unwrap().status,
            "active"
        );
        store
            .with_context_conn_for_test(|conn| {
                for table in [
                    "memory_history",
                    "memory_mutation_log",
                    "memory_agent_fragments",
                    "memory_tool_proposals",
                ] {
                    assert_eq!(
                        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                            .get::<_, i64>(0))?,
                        0,
                        "{table}"
                    );
                }
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn verification_and_mapping_facades_are_fenced_hash_guarded_and_idempotent() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let descriptor = dev_descriptor_at(_dir.path().join("data").to_str().unwrap());
        let StorageBackend::Sqlite { path } = descriptor.backend else {
            panic!("SQLite fixture required")
        };
        let context_path = Path::new(&path).parent().unwrap().join("context.db");
        store.install_context_domain(Arc::new(
            single_store_reads::ModuleContextDomain::open(&context_path).unwrap(),
        ));
        let route_root = project.to_str().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .current_dir(&project)
                .env_remove("GIT_CONFIG_COUNT")
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "--quiet"]);
        std::fs::write(project.join("source.rs"), "source").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Tests",
            "-c",
            "user.email=tests@example.com",
            "commit",
            "--quiet",
            "-m",
            "Source",
        ]);
        let checked_head = git(&["rev-parse", "HEAD"]);
        let identity = "git:dreamer-applies";
        handler.bind_route(7, binding(route_root, "token"));
        activate_module_authority(&store, "context", identity, route_root, "memories");
        let verified_id = insert_memory(&store, identity, "CONSTRAINTS", "verified", 1);
        let updated_id = insert_memory(&store, identity, "CONSTRAINTS", "updated", 1);
        let archived_id = insert_memory(&store, identity, "CONSTRAINTS", "archived", 1);
        let foreign_id = insert_memory(&store, "git:other", "CONSTRAINTS", "foreign", 1);
        let generation = 1u64;
        let hash = |id: i64| store.get_memory_full(id).unwrap().unwrap().normalized_hash;
        let before_verified =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        let verified = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "command_id": "verify-once", "rows": [
                {"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head},
                {"memory_id": updated_id, "content_hash_at_prompt": "stale", "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head},
                {"memory_id": 999999, "content_hash_at_prompt": "missing", "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head},
                {"memory_id": foreign_id, "content_hash_at_prompt": hash(foreign_id), "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head}
            ]
        })).await;
        let verified_body = match verified {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("verification facade failed: {other:?}"),
        };
        assert_eq!(verified_body["accepted"], json!([verified_id]));
        assert_eq!(verified_body["results"][0]["result"], "confirmed");
        assert_eq!(verified_body["results"][0]["files"], json!(["src/lib.rs"]));
        assert_eq!(verified_body["results"][0]["checked_commit"], checked_head);
        assert_eq!(verified_body["rejected"].as_array().unwrap().len(), 3);
        let after_verified =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        assert_eq!(
            before_verified, after_verified,
            "verification stamps are cache-neutral"
        );
        let replay = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "command_id": "verify-once", "rows": [{"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head}]
        })).await;
        let replay_body = match replay {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("verification replay failed: {other:?}"),
        };
        assert_eq!(
            replay_body, verified_body,
            "command replay must return the stored terminal response"
        );

        let before_update =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        let update = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": updated_id, "content_hash_at_prompt": hash(updated_id), "verification_status": "update", "expected_revision": 1, "files": ["src/new.rs"], "checked_commit": checked_head, "updated_content": "updated by verifier"}]
        })).await;
        let update_body = match update {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("update facade failed: {other:?}"),
        };
        let after_update =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        assert_eq!(update_body["accepted"], json!([updated_id]));
        assert_eq!(update_body["results"][0]["result"], "updated");
        // Automated verify corrections use the shared memory mutation applier to
        // retain prior content for undo without appending live prompt updates.
        assert_eq!(
            after_update, before_update,
            "an automated content update must not move the m1 mutation signal"
        );
        let (history, log_rows, revision): (i64, i64, i64) = store
            .with_context_conn_for_test(|tx| {
                tx.query_row(
                    "SELECT
                        (SELECT COUNT(*) FROM memory_history WHERE memory_id = ?1 AND after_text = 'updated by verifier'),
                        (SELECT COUNT(*) FROM memory_mutation_log WHERE target_memory_id = ?1),
                        (SELECT revision FROM memories WHERE id = ?1)",
                    [updated_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!((history, log_rows, revision), (1, 0, 2));
        assert_eq!(
            store.get_memory_full(updated_id).unwrap().unwrap().content,
            "updated by verifier"
        );

        // Matching another memory's text is a duplicate refusal, not authority to merge the two rows.
        let duplicate = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [
                {"memory_id": archived_id, "content_hash_at_prompt": hash(archived_id), "verification_status": "update", "expected_revision": 1, "files": ["src/new.rs"], "checked_commit": checked_head, "updated_content": "updated by verifier"},
                {"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "verification_status": "verified", "expected_revision": 1, "files": ["./src/lib.rs", "src/lib.rs"], "checked_commit": checked_head}
            ]
        })).await;
        let duplicate_body = match duplicate {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("duplicate update facade failed: {other:?}"),
        };
        assert_eq!(duplicate_body["accepted"], json!([verified_id]));
        assert_eq!(
            duplicate_body["rejected"],
            json!([{"memory_id": archived_id, "reason": format!("duplicate_of:{updated_id}")}])
        );
        assert_eq!(
            store.get_memory_full(archived_id).unwrap().unwrap().content,
            "archived"
        );

        let before_archive =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        let archive = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": archived_id, "content_hash_at_prompt": hash(archived_id), "verification_status": "archive", "expected_revision": 1, "files": ["src/lib.rs"], "checked_commit": checked_head, "archive_reason": "obsolete"}]
        })).await;
        assert!(matches!(archive, HandlerOutcome::Response(_)));
        let after_archive =
            crate::m1_compose::m1_revision_signal(&store, identity, "session").unwrap();
        // The archive is durable immediately. Cached prompt bytes retain the memory
        // until an independently authorized full history rebuild adopts the edit.
        assert_eq!(
            after_archive, before_archive,
            "a verify archive must not move the m1 mutation signal"
        );
        assert_eq!(
            store.get_memory_full(archived_id).unwrap().unwrap().status,
            "archived"
        );
        let proposals: Vec<(String, String, String)> = store
            .with_context_conn_for_test(|tx| {
                let mut statement = tx.prepare(
                    "SELECT writer, operation, target_ids_json FROM memory_tool_proposals",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>();
                rows
            })
            .unwrap();
        assert!(proposals.is_empty());

        let stamped = store.get_memory_full(verified_id).unwrap().unwrap();
        assert_eq!(stamped.verification_status, "verified");
        assert!(stamped.verified_at.unwrap() > 0);
        store.with_context_conn_for_test(|tx| {
            let result: (String, String, String) = tx.query_row("SELECT verify_result,verify_files_json,verify_commit FROM memories WHERE id=?1", [verified_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            assert_eq!(result, ("confirmed".into(), "[\"src/lib.rs\"]".into(), checked_head.clone()));
            tx.execute("UPDATE memories SET revision=2 WHERE id=?1", [verified_id])?;
            Ok(())
        }).unwrap();
        let stale = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "verification_status": "verified", "expected_revision": 1, "files": ["src/new.rs"], "checked_commit": checked_head}]
        })).await;
        let HandlerOutcome::Response(stale) = stale else {
            panic!("stale check failed")
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&stale).unwrap()["results"][0]["result"],
            "stale"
        );
        assert_eq!(
            store
                .get_memory_full(verified_id)
                .unwrap()
                .unwrap()
                .verified_at,
            stamped.verified_at
        );
        store
            .with_context_conn_for_test(|tx| {
                tx.execute("UPDATE memories SET revision=1 WHERE id=?1", [verified_id])
            })
            .unwrap();

        let skipped_id = insert_memory(&store, identity, "CONSTRAINTS", "skip claim", 1);
        let unmapped_id = insert_memory(&store, identity, "CONSTRAINTS", "unmapped claim", 1);
        let failed_id = insert_memory(&store, identity, "CONSTRAINTS", "failed claim", 1);
        let outcomes = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [
                {"memory_id": skipped_id, "content_hash_at_prompt": hash(skipped_id), "verification_status": "skipped", "expected_revision": 1, "files": ["src/lib.rs"], "checked_commit": checked_head},
                {"memory_id": unmapped_id, "content_hash_at_prompt": hash(unmapped_id), "verification_status": "verified", "expected_revision": 1, "files": [], "checked_commit": checked_head},
                {"memory_id": failed_id, "content_hash_at_prompt": hash(failed_id), "verification_status": "verified", "expected_revision": 1, "files": ["src/lib.rs"], "checked_commit": "b".repeat(40)}
            ]
        })).await;
        let HandlerOutcome::Response(outcomes) = outcomes else {
            panic!("outcome accounting failed")
        };
        let outcomes: Value = serde_json::from_slice(&outcomes).unwrap();
        assert_eq!(
            outcomes["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|result| result["result"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["skipped", "unmapped", "failed"]
        );
        for id in [skipped_id, unmapped_id, failed_id] {
            assert_eq!(
                store.get_memory_full(id).unwrap().unwrap().verified_at,
                None
            );
        }

        let unbacked_update = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "verification_status": "update", "expected_revision": 1, "updated_content": "corrected without local files", "files": [], "checked_commit": checked_head}]
        })).await;
        let HandlerOutcome::Response(unbacked_update) = unbacked_update else {
            panic!("unmapped update failed")
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&unbacked_update).unwrap()["results"][0]["result"],
            "unmapped"
        );
        assert_eq!(
            store
                .get_memory_full(verified_id)
                .unwrap()
                .unwrap()
                .verified_at,
            None
        );
        assert_eq!(
            store
                .get_memory_full(verified_id)
                .unwrap()
                .unwrap()
                .verification_status,
            "unverified"
        );
        let invalid_update = call_facade(&handler, "memory.set_verification", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": unmapped_id, "content_hash_at_prompt": hash(unmapped_id), "verification_status": "update", "expected_revision": 1, "updated_content": "", "files": ["src/lib.rs"], "checked_commit": checked_head}]
        })).await;
        let HandlerOutcome::Response(invalid_update) = invalid_update else {
            panic!("invalid update accounting failed")
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&invalid_update).unwrap()["results"][0]["result"],
            "refused"
        );
        assert_eq!(
            store
                .get_memory_full(unmapped_id)
                .unwrap()
                .unwrap()
                .verified_at,
            None
        );
        assert_eq!(
            store.get_memory_full(unmapped_id).unwrap().unwrap().content,
            "unmapped claim"
        );

        let mapping = call_facade(&handler, "memory.set_mapping", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "command_id": "mapping-once", "rows": [{"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "mapped_files": ["src/lib.rs", "src/lib.rs"]}]
        })).await;
        assert!(matches!(mapping, HandlerOutcome::Response(_)));
        let mapping_replay = call_facade(&handler, "memory.set_mapping", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "command_id": "mapping-once", "rows": [{"memory_id": verified_id, "content_hash_at_prompt": "stale", "mapped_files": null}]
        })).await;
        assert!(
            matches!(mapping_replay, HandlerOutcome::Response(_)),
            "mapping command replay must be idempotent"
        );
        let mapped_files = |store: &McStore| -> Vec<(String, String)> {
            store
                .with_context_conn_for_test(|tx| {
                    let mut statement = tx.prepare(
                        "SELECT file_path, COALESCE(mapping_origin, '') FROM memory_verifications
                          WHERE memory_id = ?1 ORDER BY file_path",
                    )?;
                    let rows = statement
                        .query_map([verified_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(rows)
                })
                .unwrap()
        };
        assert_eq!(
            mapped_files(&store)
                .into_iter()
                .map(|(file, _)| file)
                .collect::<Vec<_>>(),
            vec!["src/lib.rs".to_string()]
        );
        let fallback_mapping = call_facade(&handler, "memory.set_mapping", json!({
            "memory_project": identity, "context_store_uuid": "context", "authority_generation": generation,
            "rows": [{"memory_id": verified_id, "content_hash_at_prompt": hash(verified_id), "mapped_files": null, "mapping_origin": "host_rejected_fallback"}]
        })).await;
        assert!(matches!(fallback_mapping, HandlerOutcome::Response(_)));
        // No files is recorded the way the host's mapper records it: one sentinel row
        // with an empty path.
        assert_eq!(
            mapped_files(&store),
            vec![(String::new(), "host_rejected_fallback".to_string())]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dreamer_run_task_uses_profile_resolved_chain_and_advances_after_outage_text() {
        let producer = Arc::new(ProducerState::default());
        producer
            .await_results
            .lock()
            .expect("await results mutex")
            .extend([
                Ok(ProducerOutput {
                    text: "All Antigravity endpoints failed".to_string(),
                    length_capped: false,
                    usage: None,
                }),
                Ok(ProducerOutput {
                    text: "<classify></classify>".to_string(),
                    length_capped: false,
                    usage: None,
                }),
            ]);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        let mut route_binding = binding(route_root, "ses");
        route_binding.config.language = Some("tr".to_string());
        handler.bind_route(7, route_binding);
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;

        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "model-chain-command",
                    "authority_generation": generation,
                    "model_chain": ["test/profile-bad-model", "test/profile-good-model"],
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        let response = match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("dreamer run failed: {other:?}"),
        };

        assert_eq!(producer.starts.load(Ordering::SeqCst), 2);
        assert_eq!(response["manifest_text"], json!("<classify></classify>"));
        assert_eq!(
            producer.models.lock().expect("models mutex").as_slice(),
            ["test/profile-bad-model", "test/profile-good-model"]
        );
        assert_eq!(
            response["diagnostics"]["model"],
            json!("test/profile-good-model")
        );
        assert_eq!(response["diagnostics"]["attempts"], json!(2));
        let systems = producer.systems.lock().expect("systems mutex");
        assert_eq!(systems.len(), 2);
        assert!(systems
            .iter()
            .all(|system| system
                .contains("Write human-readable prose you author in: Turkish (Türkçe).")));
    }

    /// Each classify attempt sends its own model's host-configured variant, and an
    /// attempt whose model has no entry sends none: a fallback must not inherit the
    /// primary's reasoning variant.
    #[tokio::test(flavor = "current_thread")]
    async fn dreamer_run_task_sends_each_attempt_its_own_model_variant() {
        let producer = Arc::new(ProducerState::default());
        producer
            .await_results
            .lock()
            .expect("await results mutex")
            .extend([
                Ok(ProducerOutput {
                    text: "no manifest".to_string(),
                    length_capped: false,
                    usage: None,
                }),
                Ok(ProducerOutput {
                    text: "<classify></classify>".to_string(),
                    length_capped: false,
                    usage: None,
                }),
            ]);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");

        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "variant-command",
                    "model_chain": ["test/primary", "test/fallback"],
                    "model_variants": { "test/primary": "high" },
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        assert!(
            matches!(outcome, HandlerOutcome::Response(_)),
            "dreamer run failed: {outcome:?}"
        );
        assert_eq!(
            producer.models.lock().expect("models mutex").as_slice(),
            ["test/primary", "test/fallback"]
        );
        assert_eq!(
            producer.variants.lock().expect("variants mutex").as_slice(),
            [Some("high".to_string()), None]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dreamer_run_task_rejects_a_non_string_model_variant() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "bad-variant-command",
                    "model_chain": ["test/primary"],
                    "model_variants": { "test/primary": 3 },
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        match outcome {
            HandlerOutcome::Error { message, .. } => assert!(
                message.contains("model_variants values must be strings"),
                "{message}"
            ),
            other => panic!("expected invalid params, got {other:?}"),
        }
        assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
    }

    /// The classify response carries the runner's token spend so the host can record it
    /// on the invocation row, and omits the field when the runner reported none.
    #[tokio::test(flavor = "current_thread")]
    async fn dreamer_run_task_response_carries_producer_usage() {
        for usage in [
            Some(crate::historian_producer::ProducerUsage {
                input: 14_039,
                output: 6_125,
                cache_read: 12,
                cache_write: 3,
            }),
            None,
        ] {
            let producer = Arc::new(ProducerState::default());
            producer
                .await_results
                .lock()
                .expect("await results mutex")
                .push_back(Ok(ProducerOutput {
                    text: "<classify></classify>".to_string(),
                    length_capped: false,
                    usage,
                }));
            let (handler, store, _dir, project) =
                handler_with_store(Arc::clone(&producer), default_test_config());
            let route_root = project.to_str().unwrap();
            handler.bind_route(7, binding(route_root, "ses"));
            activate_module_authority(&store, "context", "git:identity", route_root, "memories");
            let generation = 1u64;
            let outcome = handler
                .handle_dreamer_run_task(
                    7,
                    &json!({
                        "v": 1,
                        "session_id": "ses",
                        "task": CLASSIFY_TASK,
                        "command_id": "usage-command",
                        "authority_generation": generation,
                        "model_chain": ["test/classifier"],
                        "payload": { "prompt_body": "classify", "items": [] },
                    }),
                )
                .await;
            let response = match outcome {
                HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
                other => panic!("dreamer run failed: {other:?}"),
            };
            assert_eq!(response["diagnostics"]["model"], json!("test/classifier"));
            match usage {
                Some(_) => assert_eq!(
                    response["usage"],
                    json!({ "input": 14_039, "output": 6_125, "cache_read": 12, "cache_write": 3 })
                ),
                None => assert!(response.get("usage").is_none(), "{response}"),
            }
        }
    }

    /// dreamer.run_task without `model_chain` is refused by name before any producer
    /// run; the module no longer falls back to a chain read from disk.
    #[tokio::test(flavor = "current_thread")]
    async fn dreamer_run_task_without_model_chain_is_refused_by_name() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;
        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "no-chain",
                    "authority_generation": generation,
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        match outcome {
            HandlerOutcome::Error { code, .. } => assert_eq!(code, "model_chain_missing"),
            other => panic!("expected a named refusal: {other:?}"),
        }
        assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn classify_fallback_attempts_never_share_a_provider_session() {
        // A parked run does not end: it keeps holding its provider session. A second
        // attempt sent into that same session would be queued behind it instead of
        // started, and a queued classify run is one nothing here can ever read.
        let producer = Arc::new(ProducerState::default());
        producer
            .await_results
            .lock()
            .expect("await results mutex")
            .extend([
                Err(HistorianProducerError::RunPaused {
                    run_id: "run-parked".to_string(),
                    reason: Some("awaiting re-auth".to_string()),
                    classification: None,
                    class_field_present: false,
                }),
                Ok(ProducerOutput {
                    text: "<classify></classify>".to_string(),
                    length_capped: false,
                    usage: None,
                }),
            ]);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;

        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "parked-then-fallback",
                    "authority_generation": generation,
                    "model_chain": ["test/first", "test/second"],
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        assert!(
            matches!(outcome, HandlerOutcome::Response(_)),
            "the fallback attempt must produce a manifest: {outcome:?}"
        );

        let sessions = producer.sessions.lock().expect("sessions mutex").clone();
        assert_eq!(sessions.len(), 2, "{sessions:?}");
        assert_ne!(
            sessions[0], sessions[1],
            "the fallback attempt reused the parked attempt's provider session"
        );
        assert!(sessions
            .iter()
            .all(|session| session.starts_with("mc-dreamer:classify:")));
    }

    /// Under `historian.runner = "host"` the module has no completion runner, so a
    /// classify request is answered with the prompt the host must run, and the host's
    /// completion sent back on a second request is checked and recorded like the
    /// module's own runner output. The module's producer is never started.
    #[tokio::test(flavor = "current_thread")]
    async fn classify_under_the_host_runner_runs_on_the_host_and_never_on_a_module_route() {
        let producer = Arc::new(ProducerState::default());
        let mut config = default_test_config();
        config.historian_runner = Some(HistorianRunnerKind::Host);
        let (handler, store, _dir, project) = handler_with_store(Arc::clone(&producer), config);
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;
        let request = |completion: Option<Value>| {
            let mut body = json!({
                "v": 1,
                "session_id": "ses",
                "task": CLASSIFY_TASK,
                "command_id": "host-runner-classify",
                "authority_generation": generation,
                "model_chain": ["test/first"],
                "payload": { "prompt_body": "classify", "items": [] },
            });
            if let Some(completion) = completion {
                body["host_completion"] = completion;
            }
            body
        };
        let decode = |outcome: HandlerOutcome| match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("expected a response: {other:?}"),
        };

        let asked = decode(handler.handle_dreamer_run_task(7, &request(None)).await);
        assert_eq!(asked["ok"], json!(false));
        assert_eq!(asked["code"], json!(HOST_COMPLETION_REQUIRED));
        assert!(asked["system_prompt"]
            .as_str()
            .unwrap()
            .starts_with("You are a memory classifier"));

        let answered = decode(
            handler
                .handle_dreamer_run_task(
                    7,
                    &request(Some(json!({
                        "text": "<classify></classify>",
                        "model": "test/first",
                        "usage": { "input": 10, "output": 2 },
                    }))),
                )
                .await,
        );
        assert_eq!(answered["ok"], json!(true));
        assert_eq!(answered["manifest_text"], json!("<classify></classify>"));
        assert_eq!(answered["diagnostics"]["runner"], json!("host"));
        assert_eq!(answered["diagnostics"]["model"], json!("test/first"));
        assert_eq!(answered["usage"]["input"], json!(10));
        assert_eq!(producer.starts.load(Ordering::SeqCst), 0);

        let mut bad = request(Some(
            json!({ "text": "no manifest", "model": "test/first" }),
        ));
        bad["command_id"] = json!("host-runner-classify-bad");
        match handler.handle_dreamer_run_task(7, &bad).await {
            HandlerOutcome::Error { code, message } => {
                assert_eq!(code, "dreamer_run_failed");
                assert!(
                    message.contains("no classify manifest envelope"),
                    "{message}"
                );
            }
            other => panic!("expected a refusal: {other:?}"),
        }
        assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn classify_primary_that_times_out_with_no_answer_advances_to_the_fallback() {
        // A model that stops answering times out on its await and again on the
        // recovery read. The module walks its own chain, so the next model must
        // still get a turn rather than the whole classify run failing.
        let producer = Arc::new(ProducerState::default());
        producer
            .await_results
            .lock()
            .expect("await results mutex")
            .extend([
                Err(HistorianProducerError::TimedOut),
                Err(HistorianProducerError::TimedOut),
                Ok(ProducerOutput {
                    text: "<classify></classify>".to_string(),
                    length_capped: false,
                    usage: None,
                }),
            ]);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");

        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "timed-out-then-fallback",
                    "model_chain": ["test/first", "test/second"],
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        let response = match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("the fallback attempt must produce a manifest: {other:?}"),
        };

        assert_eq!(
            producer.models.lock().expect("models mutex").as_slice(),
            ["test/first", "test/second"]
        );
        assert_eq!(response["diagnostics"]["model"], json!("test/second"));
        assert_eq!(response["diagnostics"]["attempts"], json!(2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn classify_failure_names_every_attempt_not_only_the_last() {
        let producer = Arc::new(ProducerState::default());
        producer
            .await_results
            .lock()
            .expect("await results mutex")
            .extend([
                Err(HistorianProducerError::RunPaused {
                    run_id: "run-parked".to_string(),
                    reason: Some("awaiting re-auth".to_string()),
                    classification: None,
                    class_field_present: false,
                }),
                Err(HistorianProducerError::SendQueued {
                    submission_id: "sub-1".to_string(),
                    retracted: true,
                }),
            ]);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "ses"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;

        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "all-attempts-fail",
                    "authority_generation": generation,
                    "model_chain": ["test/first", "test/second"],
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        let message = match outcome {
            HandlerOutcome::Error { message, .. } => message,
            other => panic!("expected a failed classify run: {other:?}"),
        };
        assert!(
            message.contains("test/first") && message.contains("awaiting re-auth"),
            "the first attempt's cause must survive: {message}"
        );
        assert!(
            message.contains("test/second"),
            "the later attempt must still be reported: {message}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn module_authority_facade_write_uses_identity_not_route_path() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_project_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_project_root, "token"));
        activate_module_authority(
            &store,
            "context",
            "git:identity",
            route_project_root,
            "memories",
        );

        let outcome = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "write",
                "category": "CONSTRAINTS",
                "content": "identity scoped",
                "memory_project": "git:identity",
            }),
        )
        .await;
        assert!(!tool_is_error(outcome));
        assert_eq!(
            store.get_memory_full(1).unwrap().unwrap().project_path,
            "git:identity"
        );
        assert!(store
            .load_active_memories(route_project_root, 10)
            .unwrap()
            .is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn module_authority_rejects_mismatched_facade_project_vocabulary() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_project_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_project_root, "token"));
        activate_module_authority(
            &store,
            "context",
            "git:identity",
            route_project_root,
            "memories",
        );

        let (code, message) = error_frame(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "write",
                    "category": "CONSTRAINTS",
                    "content": "must fail",
                    "memory_project": route_project_root,
                }),
            )
            .await,
        );
        assert_eq!(code, "facade_project_vocabulary_mismatch");
        assert_eq!(
            message,
            "Memory writes are paused while the engine syncs. Retry in a moment. (MC-C01)"
        );
        assert!(!message.contains("git:identity"));
        assert!(!message.contains(route_project_root));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_without_authority_keeps_path_scoped_writes() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let route_project_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_project_root, "token"));

        let outcome = call_facade(
            &handler,
            "ctx_memory",
            json!({
                "action": "write",
                "category": "CONSTRAINTS",
                "content": "path scoped",
            }),
        )
        .await;
        assert!(!tool_is_error(outcome));
        assert_eq!(
            store.get_memory_full(1).unwrap().unwrap().project_path,
            route_project_root
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_search_keeps_claude_code_module_visible_memory_ids() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[("token", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let project = project.to_str().unwrap();
        handler.bind_route(7, binding_with_harness(project, "claude-code", "token"));

        let visible = insert_memory(&store, project, "CONSTRAINTS", "needle visible", 10);
        let hidden = insert_memory(&store, project, "CONSTRAINTS", "needle hidden", 20);
        seed_shown_memory_pair(&store, "ses", project, visible);

        let results = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": "needle", "sources": ["memory"]}),
            )
            .await,
        );
        assert!(
            !results.contains(&format!("[memory] score=1.00 id={visible} ")),
            "{results}"
        );
        assert!(
            results.contains(&format!("[memory] score=1.00 id={hidden} ")),
            "{results}"
        );
    }

    fn seed_shown_memory_pair(store: &McStore, session: &str, project: &str, id: i64) {
        let snapshot = store.load_memory_render_snapshot(project, None, 0).unwrap();
        let selected = snapshot
            .memories
            .iter()
            .filter(|memory| memory.id == id)
            .cloned()
            .collect::<Vec<_>>();
        let text = crate::memory_render::render_memory_block(
            &selected,
            "project-memory",
            &Default::default(),
        );
        let mut projection =
            mc_store::memory_projection::AppliedProjection::hard(&snapshot, &selected, &[]);
        projection.bind_m0(&text);
        let core = CoreState {
            frozen_units: vec![mc_core::FrozenUnit {
                key: "m0".into(),
                kind: "synth-region".into(),
                frozen_payload: text,
                durability_class: mc_core::DurabilityClass::Lineage,
                reset_rule: String::new(),
            }],
            ..Default::default()
        };
        store
            .commit(
                session,
                None,
                &core,
                &ModuleMeta {
                    rendered_memory_ids: vec![id],
                    memory_projection: Some(projection),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn memory_disabled_rejects_mutation_and_excludes_memory_search() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[("token", FakeResolve::Hit("ses".to_string()))]);
        let mut config = default_test_config();
        config.memory_enabled = false;
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, config, resolver);
        let mut disabled_binding = binding("/repo", "token");
        disabled_binding.config.memory_enabled = false;
        handler.bind_route(7, disabled_binding);
        insert_memory(&store, "/repo", "CONSTRAINTS", "hidden needle", 1);

        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({"action": "write", "category": "CONSTRAINTS", "content": "blocked"}),
            )
            .await
        ));
        let results =
            tool_text(call_facade(&handler, "ctx_search", json!({"query": "needle"})).await);
        assert!(!results.contains("[memory]"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn facade_security_guards_run_through_public_handler_path() {
        let producer = Arc::new(ProducerState::default());
        let own = "/repo";
        let foreign = "opaque-foreign-key";
        let resolver = FakeSessionResolver::with(&[(
            "token",
            FakeResolve::Hit("opaque-own-conversation".to_string()),
        )]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding(own, "token"));
        seed_workspace(&store, own, foreign);

        let foreign_private_update =
            insert_memory(&store, foreign, "PREFERENCES", "private update", 1);
        let foreign_private_archive =
            insert_memory(&store, foreign, "PREFERENCES", "private archive", 1);
        let foreign_private_merge =
            insert_memory(&store, foreign, "PREFERENCES", "private merge", 1);
        let own_private = insert_memory(&store, own, "PREFERENCES", "own private", 1);

        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "update", "id": foreign_private_update, "content": "edited" }),
            )
            .await
        ));
        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "archive", "ids": [foreign_private_archive] }),
            )
            .await
        ));
        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "merge", "ids": [foreign_private_merge, own_private], "content": "merged" }),
            )
            .await
        ));

        let shared_update = insert_memory(&store, foreign, "CONSTRAINTS", "shared update", 1);
        let shared_archive = insert_memory(&store, foreign, "CONSTRAINTS", "shared archive", 1);
        let shared_target = insert_memory(&store, foreign, "CONSTRAINTS", "shared target", 1);
        let shared_source = insert_memory(&store, foreign, "CONSTRAINTS", "shared source", 1);

        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "update", "id": shared_update, "content": "shared edited" }),
            )
            .await
        ));
        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "archive", "ids": [shared_archive] }),
            )
            .await
        ));
        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "merge", "ids": [shared_target, shared_source], "content": "shared merged" }),
            )
            .await
        ));
        assert_eq!(
            store
                .get_memory_full(shared_source)
                .unwrap()
                .unwrap()
                .superseded_by_memory_id,
            None
        );

        let cross_target = insert_memory(&store, own, "CONSTRAINTS", "constraint", 1);
        let cross_source = insert_memory(&store, own, "PREFERENCES", "preference", 1);
        assert!(tool_is_error(
            call_facade(
                &handler,
                "ctx_memory",
                json!({ "action": "merge", "ids": [cross_target, cross_source], "content": "bad merge" }),
            )
            .await
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_reports_storage_versions_with_live_store_version() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let live_version = store.module_store_schema_version().unwrap();

        let decode = |outcome: HandlerOutcome| match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("expected status response, got {other:?}"),
        };

        // Both the health probe (no session_id) and the per-session status carry the
        // block, so a fleet probe gets the same shape whichever way it calls status.
        let health = decode(handler.handle_status_value(&json!({ "kind": "status" })));
        let session =
            decode(handler.handle_status_value(&json!({ "kind": "status", "session_id": "ses" })));
        for status in [&health, &session] {
            assert_eq!(status.get("async_bus"), Some(&Value::Null));
            let versions = &status["storage_versions"];
            // The module does not read the host's context.db; the TS surface owns it.
            assert!(versions["context_db_schema_version"].is_null());
            assert_eq!(versions["module_store_schema_version"], json!(live_version));
            assert_eq!(
                versions["binary_supported_version"],
                json!(mc_store::LATEST_MIGRATION_VERSION)
            );
            // A freshly opened store is fully migrated, so the live version and the
            // binary's shipped ceiling agree.
            assert_eq!(
                versions["module_store_schema_version"],
                versions["binary_supported_version"]
            );
        }
    }

    fn wrapup_messages(count: u64, words_per_message: usize) -> Vec<CkIngressMessage> {
        (1..=count)
            .map(|ordinal| {
                ck_with_role(
                    &format!("m{ordinal}"),
                    ordinal,
                    if ordinal % 2 == 0 {
                        "assistant"
                    } else {
                        "user"
                    },
                    &format!("message {ordinal} {}", "word ".repeat(words_per_message)),
                )
            })
            .collect()
    }

    pub(super) fn historian_output_for_prompt(prompt: &str) -> String {
        let (start, end) = prompt_ordinal_range(prompt).unwrap_or((1, 3));
        historian_output(start, end, "autonomous summary")
    }

    fn historian_output(start: u64, end: u64, p1: &str) -> String {
        format!(
            r#"<output><compartments><compartment start="{start}" end="{end}" title="autonomous arc" episode_type="feature" importance="60"><p1>{p1}</p1><p2>short summary</p2><p3>arc</p3><p4 /></compartment></compartments><meta><messages_processed>{start}-{end}</messages_processed><unprocessed_from>{}</unprocessed_from></meta></output>"#,
            end + 1
        )
    }

    fn historian_output_with_fact(start: u64, end: u64, fact: &str) -> String {
        format!(
            r#"<output><compartments><compartment start="{start}" end="{end}" title="autonomous arc" episode_type="feature" importance="60"><p1>autonomous summary</p1><p2>short summary</p2><p3>arc</p3><p4 /></compartment></compartments><facts><PROJECT_RULES>* {fact}</PROJECT_RULES></facts><meta><messages_processed>{start}-{end}</messages_processed><unprocessed_from>{}</unprocessed_from></meta></output>"#,
            end + 1
        )
    }

    fn prompt_ordinal_range(prompt: &str) -> Option<(u64, u64)> {
        let mut ordinals = Vec::new();
        let bytes = prompt.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'[' {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + 1 {
                    if let Ok(value) = prompt[i + 1..j].parse::<u64>() {
                        ordinals.push(value);
                    }
                    if j < bytes.len() && bytes[j] == b'-' {
                        let mut k = j + 1;
                        while k < bytes.len() && bytes[k].is_ascii_digit() {
                            k += 1;
                        }
                        if k > j + 1 {
                            if let Ok(value) = prompt[j + 1..k].parse::<u64>() {
                                ordinals.push(value);
                            }
                        }
                    }
                }
            }
            i += 1;
        }
        Some((*ordinals.iter().min()?, *ordinals.iter().max()?))
    }

    /// Wall-clock budget for test waits on spawned-task progress. Iteration-bounded
    /// yield loops flake under parallel test load: 200 bare yields are microseconds,
    /// and a spawned task that loses the CPU race for that window fails the wait even
    /// though it completes fine. Time-bounded polling makes the wait load-immune.
    const TEST_WAIT_BUDGET: Duration = Duration::from_secs(10);
    const TEST_WAIT_POLL: Duration = Duration::from_millis(2);

    async fn wait_for_count(value: &AtomicUsize, expected: usize) {
        let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
        while std::time::Instant::now() < deadline {
            if value.load(Ordering::SeqCst) >= expected {
                return;
            }
            tokio::time::sleep(TEST_WAIT_POLL).await;
        }
        panic!("counter did not reach {expected}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn management_drop_alias_routes_are_rejected() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        for alias in ["ctx_reduce", "append_agent_drops"] {
            let outcome = handler
                .dispatch_value(
                    7,
                    json!({
                        "method": alias,
                        "session_id": "ses",
                        "drop": "1",
                        "command_id": "command"
                    }),
                )
                .await;
            assert_eq!(error_code(outcome), "unrecognized_request_shape", "{alias}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runner_transcript_todo_matches_the_todo_state_set_anchor() {
        // A runner sends no todo_state.set; ck-mc reads the todowrite call and
        // its result from the transcript. The stored state, and the synthetic
        // todo pair built from it, must equal what todo_state.set produces.
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/runner-todo-transcript.json")).unwrap();
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let set = &fixture["todo_state_set"];
        let request = json!({
            "method": "todo_state.set",
            "v": 1,
            "session_id": "ses",
            "state_json": serde_json::to_string(&set["todos"]).unwrap(),
            "owner_message_id": set["owner_message_id"],
        });
        assert_eq!(
            call_dispatch_request(&handler, request).await,
            json!({ "ok": true })
        );

        let transcript: Vec<crate::providers::codec::InboundMessage> =
            serde_json::from_value(fixture["transcript"].clone()).unwrap();
        let mut scan = crate::providers::runner_todo::TodoScan::default();
        let derived = crate::providers::runner_todo::scan_status_messages(
            &mut scan,
            fixture["lineage_id"].as_str().unwrap(),
            &transcript,
        )
        .unwrap()
        .expect("the transcript holds a successful todowrite");
        store
            .set_todo_state(
                "ses-derived",
                &derived.state_json,
                &derived.owner_message_id,
                &derived.state_hash,
            )
            .unwrap();

        let reported = store.load("ses").unwrap().meta;
        let derived_meta = store.load("ses-derived").unwrap().meta;
        assert_eq!(
            reported.last_todo_state.as_deref(),
            fixture["expected_state_json"].as_str()
        );
        assert_eq!(derived_meta.last_todo_state, reported.last_todo_state);
        assert_eq!(
            derived_meta.last_todo_state_hash,
            reported.last_todo_state_hash
        );
        assert_eq!(
            derived_meta.last_todo_state_owner_message_id,
            reported.last_todo_state_owner_message_id
        );
        let anchor =
            |meta: &mc_store::ModuleMeta| match crate::injection::advance_injection_from_meta(
                meta, None, true, None,
            ) {
                crate::injection::InjectionOutcome::Replace(pair) => {
                    pair.freeze_at(meta.last_todo_state_owner_message_id.clone())
                }
                other => panic!("expected a synthetic todo pair, got {other:?}"),
            };
        assert_eq!(anchor(&derived_meta), anchor(&reported));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn management_todo_flush_and_recomp_contracts_are_replay_safe() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let todo = json!({
            "method": "todo_state.set",
            "v": 1,
            "session_id": "ses",
            "state_json": "[{\"content\":\"ship module\",\"status\":\"in_progress\",\"priority\":\"high\"}]",
            "owner_message_id": "m1",
        });
        assert_eq!(
            call_dispatch_request(&handler, todo.clone()).await,
            json!({ "ok": true })
        );
        let first = store.load("ses").unwrap();
        assert_eq!(
            first.meta.last_todo_state_owner_message_id.as_deref(),
            Some("m1")
        );
        assert!(first.meta.last_todo_state_hash.is_some());
        let first_version = first.row_version;
        assert_eq!(
            call_dispatch_request(&handler, todo).await,
            json!({ "ok": true })
        );
        assert_eq!(store.load("ses").unwrap().row_version, first_version);

        let flush = call_dispatch_request(
            &handler,
            json!({ "method": "session.flush", "v": 1, "session_id": "ses" }),
        )
        .await;
        assert_eq!(flush, json!({ "ok": true, "armed": true }));
        let flushed = store.load("ses").unwrap();
        assert!(flushed.meta.soft_refresh_pending);

        let recomp = call_dispatch_request(
            &handler,
            json!({
                "method": "session.recomp",
                "v": 1,
                "session_id": "ses",
                "command_id": "recomp-1",
            }),
        )
        .await;
        assert_eq!(
            recomp,
            json!({ "ok": true, "disposition": "nothing_to_do" })
        );
        let replay = call_dispatch_request(
            &handler,
            json!({
                "method": "session.recomp",
                "v": 1,
                "session_id": "ses",
                "command_id": "recomp-1",
            }),
        )
        .await;
        assert_eq!(replay, recomp);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_recomp_resets_cache_boundary_and_replays_started() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        store
            .replace_compartments("ses", &[stored_comp(1, 1, 5, "m5", "seed")])
            .unwrap();
        let before = store.load("ses").unwrap();
        let mut core = before.core.clone();
        core.boundary_id = "m5#0".to_string();
        let mut meta = before.meta.clone();
        meta.initialized = true;
        meta.coverage_ordinal = Some(5);
        store
            .commit("ses", before.row_version, &core, &meta)
            .unwrap();
        let before_reset = store.load("ses").unwrap();

        let first = call_dispatch_request(
            &handler,
            json!({
                "method": "session.recomp",
                "v": 1,
                "session_id": "ses",
                "command_id": "recomp-reset",
            }),
        )
        .await;
        assert_eq!(first, json!({ "ok": true, "disposition": "started" }));
        let after = store.load("ses").unwrap();
        assert!(store.load_compartments("ses").unwrap().is_empty());
        assert!(after.core.boundary_id.is_empty());
        assert!(!after.meta.initialized);
        assert!(after.meta.coverage_ordinal.is_none());
        assert_eq!(after.meta.revert_epoch, before_reset.meta.revert_epoch + 1);
        assert_eq!(
            after.row_version,
            Some(before_reset.row_version.unwrap() + 1)
        );

        let replay = call_dispatch_request(
            &handler,
            json!({
                "method": "session.recomp",
                "v": 1,
                "session_id": "ses",
                "command_id": "recomp-reset",
            }),
        )
        .await;
        assert_eq!(replay, first);
        assert_eq!(store.load("ses").unwrap().row_version, after.row_version);
    }

    #[test]
    fn session_status_rejects_unbound_and_mismatched_routes() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());
        let request = json!({ "method": "session.status", "v": 1, "session_id": "ses" });

        assert_eq!(
            error_code(handler.handle_session_status_value(8, &request)),
            "route_unbound"
        );
        let mismatch = json!({
            "method": "session.status",
            "v": 1,
            "session_id": "other",
        });
        assert_eq!(
            error_code(handler.handle_session_status_value(7, &mismatch)),
            "session_mismatch"
        );
    }

    #[test]
    fn session_status_summarizes_seeded_store_with_identity_and_durable_age() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) = handler_with_store(producer, default_test_config());
        let session_id = "ccm-8518e338-extra";
        handler.bind_route(7, binding(project.to_str().unwrap(), session_id));
        store
            .replace_compartments(
                session_id,
                &[
                    stored_comp(1, 1, 5, "m5", "first"),
                    stored_comp(2, 6, 10, "m10", "second"),
                ],
            )
            .unwrap();
        let loaded = store.load(session_id).unwrap();
        let mut core = loaded.core.clone();
        core.boundary_id = "m10#0".to_string();
        let mut meta = loaded.meta.clone();
        meta.coverage_ordinal = Some(10);
        meta.cc_u1_active = true;
        meta.initialized = true;
        meta.m1_revision = 1;
        meta.last_committed_pass_at_ms = now_ms() - 125_000;
        meta.historian.firing_seq = 3;
        store
            .commit(session_id, loaded.row_version, &core, &meta)
            .unwrap();
        store
            .append_pending_agent_drops(session_id, &["m8#0".to_string()], 2)
            .unwrap();
        store
            .seed_memory(5, project.to_str().unwrap(), "ARCHITECTURE", "pending", 70)
            .unwrap();
        store
            .seed_tags_for_test(
                session_id,
                &[
                    TagMintInput {
                        block_id: "m8#0".to_string(),
                        kind: "message".to_string(),
                        token_count: 2,
                        source_bytes: b"eight".to_vec(),
                    },
                    TagMintInput {
                        block_id: "m9#0".to_string(),
                        kind: "message".to_string(),
                        token_count: 2,
                        source_bytes: b"nine".to_vec(),
                    },
                    TagMintInput {
                        block_id: "m11#0".to_string(),
                        kind: "message".to_string(),
                        token_count: 2,
                        source_bytes: b"eleven".to_vec(),
                    },
                ],
                2,
            )
            .unwrap();

        let body = tool_body(handler.handle_session_status_value(
            7,
            &json!({ "method": "session.status", "v": 1, "session_id": session_id }),
        ));
        let summary = body["summary"].as_str().unwrap();

        assert!(summary.starts_with("session ccm-8518e338 (last active 2m ago):"));
        assert!(summary.contains("2 compartments"));
        assert!(summary.contains("coverage ordinal 10"));
        assert!(summary.contains("boundary present"));
        assert!(summary.contains("1 pending drop"));
        assert!(summary.contains("3 tags"));
        assert!(summary.contains("pending m1 delta true age_ms=0"));
        assert!(summary.contains("last historian: published seq 3"));
        assert_eq!(body["tag_count"], json!(3));
        assert_eq!(body["pending_m1_delta"], json!(true));
        assert_eq!(body["pending_m1_age_ms"], json!(0));
        assert_eq!(body["tail_identity_re_adopt_count"], json!(0));
        assert!(summary.ends_with("surface active"));
    }

    #[test]
    fn session_delete_clears_durable_state_for_the_bound_lineage() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) = handler_with_store(producer, default_test_config());
        let session_id = "ses-delete";
        handler.bind_route(7, binding(project.to_str().unwrap(), session_id));
        store
            .commit(
                session_id,
                None,
                &CoreState::default(),
                &ModuleMeta {
                    pending_channel2_directive: Some(mc_store::PendingChannel2Directive {
                        text: "frozen reminder".to_string(),
                        directive_id: "directive-id".to_string(),
                        armed_at_ms: 1,
                        arming_watermark: 1,
                    }),
                    channel2_pressure_latched: true,
                    channel2_arming_watermark: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .seed_tags_for_test(
                session_id,
                &[TagMintInput {
                    block_id: "m1#0".to_string(),
                    kind: "message".to_string(),
                    token_count: 1,
                    source_bytes: b"one".to_vec(),
                }],
                1,
            )
            .unwrap();

        let deleted = tool_body(handler.handle_session_delete_value(
            7,
            &json!({ "method": "session.delete", "v": 1, "session_id": session_id }),
        ));
        assert_eq!(deleted["ok"], json!(true));
        assert!(deleted["deleted_rows"].as_u64().unwrap() >= 2);
        assert!(!store.has_cache_state(session_id).unwrap());
        assert!(store.load_tags_for_session(session_id).unwrap().is_empty());
        assert!(store
            .load(session_id)
            .unwrap()
            .meta
            .pending_channel2_directive
            .is_none());
    }

    #[test]
    fn session_status_rereads_when_wrapup_latch_changes_during_snapshot() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let handler = Arc::new(handler);
        let hook_handler = Arc::clone(&handler);
        let hook_store = Arc::clone(&store);
        *handler
            .status_snapshot_hook
            .lock()
            .expect("status snapshot hook mutex") = Some(Box::new(move || {
            let loaded = hook_store.load("ses").unwrap();
            let mut meta = loaded.meta.clone();
            meta.coverage_ordinal = Some(7);
            hook_store
                .commit("ses", loaded.row_version, &loaded.core, &meta)
                .unwrap();
            hook_handler
                .wrapup_sessions
                .lock()
                .expect("wrapup sessions mutex")
                .insert(
                    "ses".to_string(),
                    LiveWrapupSession {
                        token: Arc::new(()),
                        rounds: 3,
                    },
                );
        }));

        let body = tool_body(handler.handle_session_status_value(
            7,
            &json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ));
        assert_eq!(body["wrapup_active"], json!(true));
        assert_eq!(body["wrapup_rounds"], json!(3));
        assert_eq!(body["coverage_ordinal"], json!(7));
        assert_eq!(body["row_version"], json!(1));
    }

    #[test]
    fn session_status_sanitizes_controls_and_caps_summary() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta.clone();
        meta.historian.last_failure = Some(format!("bad\0line\n{}", "x".repeat(2_000)));
        store
            .commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();

        let body = tool_body(handler.handle_session_status_value(
            7,
            &json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ));
        let summary = body["summary"].as_str().unwrap();
        assert!(!summary.chars().any(char::is_control));
        assert!(!summary.contains('\n'));
        assert!(summary.chars().count() <= 500);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn live_historian_session_installs_the_completion_notify_before_busy_is_visible() {
        let handler = McHandler::new();
        let guard = match handler.try_claim_live_historian_session("ses") {
            LiveHistorianSessionClaim::Acquired(guard) => guard,
            LiveHistorianSessionClaim::Busy(_) => panic!("first claim must acquire the live latch"),
        };
        let mut completion = match handler.try_claim_live_historian_session("ses") {
            LiveHistorianSessionClaim::Acquired(_) => {
                panic!("a second claim must observe the existing live session")
            }
            LiveHistorianSessionClaim::Busy(completion) => completion,
        };

        drop(guard);
        tokio::time::timeout(Duration::from_millis(50), completion.as_mut())
            .await
            .expect("busy observers must always see a completion notify they can await");
    }

    #[test]
    fn stale_live_historian_cleanup_cannot_delete_the_next_run_entry() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let old_token = Arc::new(());
        let old_completion = Arc::new(Notify::new());
        sessions.lock().unwrap().insert(
            "ses".to_string(),
            LiveHistorianSession {
                token: Arc::clone(&old_token),
                completion: Arc::clone(&old_completion),
            },
        );
        let old_guard = SessionSetGuard {
            sessions: Arc::clone(&sessions),
            session_id: "ses".to_string(),
            token: Arc::clone(&old_token),
            completion: Arc::clone(&old_completion),
        };

        let new_token = Arc::new(());
        let new_completion = Arc::new(Notify::new());
        sessions.lock().unwrap().insert(
            "ses".to_string(),
            LiveHistorianSession {
                token: Arc::clone(&new_token),
                completion: Arc::clone(&new_completion),
            },
        );

        drop(old_guard);
        let entry = sessions
            .lock()
            .unwrap()
            .get("ses")
            .cloned()
            .expect("the replacement live entry must survive stale cleanup");
        assert!(Arc::ptr_eq(&entry.token, &new_token));

        drop(SessionSetGuard {
            sessions: Arc::clone(&sessions),
            session_id: "ses".to_string(),
            token: new_token,
            completion: new_completion,
        });
        assert!(sessions.lock().unwrap().is_empty());
    }

    fn seeded_historian_identities() -> Vec<mc_store::HistorianSelectedMessageIdentity> {
        vec![mc_store::HistorianSelectedMessageIdentity {
            mid: "seeded-mid".to_string(),
            block_identities: vec![mc_store::BlockIdentity {
                kind_tag: "text".to_string(),
                byte_fingerprint: "seeded-content".to_string(),
            }],
        }]
    }

    fn seed_historian_phase(store: &McStore, phase: HistorianPhase) {
        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta;
        let selected_range_identities = seeded_historian_identities();
        for selected in &selected_range_identities {
            meta.block_identity_by_mid
                .insert(selected.mid.clone(), selected.block_identities.clone());
        }
        meta.historian = HistorianDurableState {
            state: phase,
            firing_seq: 1,
            chunk_range: Some(HistorianChunkRange {
                from_ordinal: 1,
                to_ordinal: 3,
            }),
            chunk_fingerprint: "seeded-fingerprint".to_string(),
            selected_range_identities,
            producer_session_id: Some("producer-session".to_string()),
            producer_run_id: Some("run-stale".to_string()),
            producer_attempt: 0,
            coordinator_token: None,
            claim_deadline_ms: None,
            fired_at_ms: Some(1),
            expected_revert_epoch: 0,
            compartment_set_generation: mc_store::CompartmentSetGeneration::default(),
            failure_backoff_at_ms: None,
            last_failure: None,
            last_no_fire: None,
            recent_decisions: Vec::new(),
            consecutive_publish_failures: 0,
        };
        store
            .commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_diagnostics_do_not_advertise_lossy_historian_side_channels_as_pending() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());
        seed_historian_phase(&store, HistorianPhase::Publishing);
        store.fail_next_historian_side_channel_for_test("event");
        let loaded = store.load("ses").unwrap();
        let event = mc_store::HistorianEventCandidate {
            kind: "trajectory_correction".to_string(),
            fields_json: "{}".to_string(),
            ..Default::default()
        };
        store
            .publish_historian_chunk(mc_store::HistorianPublishRequest {
                rust_background_enabled: false,
                lifecycle_publication_id: None,
                harness: None,
                session_id: "ses",
                expected_row_version: loaded.row_version,
                expected_revert_epoch: 0,
                predicate: &mc_store::HistorianPublishPredicate {
                    firing_seq: 1,
                    producer_run_id: "run-stale".to_string(),
                    producer_attempt: 0,
                    chunk_fingerprint: "seeded-fingerprint".to_string(),
                    selected_range_identities: seeded_historian_identities(),
                    compartment_set_generation: mc_store::CompartmentSetGeneration::default(),
                },
                project_path: "git:proj",
                compartments: &[stored_comp(1, 10, 20, "m20", "summary")],
                facts: &[],
                promote_facts: false,
                events: std::slice::from_ref(&event),
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 21,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap();

        let status =
            call_dispatch_request(&handler, json!({ "kind": "status", "session_id": "ses" })).await;
        assert_eq!(status["historian"]["side_channel_pending_count"], 0);
        assert_eq!(
            status["historian"]["side_channel_last_failure"],
            Value::Null
        );
        assert!(store.load_compartment_events("ses").unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wrapup_join_budget_covers_a_two_model_walk_whose_first_attempt_times_out() {
        let one_attempt =
            historian::completion_wait_budget(historian::historian_await_timeout(Some(720_000)));
        let two_models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];

        // The running firing may spend a full attempt budget timing out on model-a and
        // then another on model-b; joining it must not give up after the first.
        let budget = McHandler::active_firing_join_budget(Some(&two_models), Some(720_000));
        assert_eq!(budget, one_attempt * 2);

        // A longer host-resolved chain widens the join; the default timeout is the floor
        // when the host asks for a shorter per-attempt deadline.
        let host_chain = vec![
            "prov/model-a".to_string(),
            "prov/model-b".to_string(),
            "prov/model-c".to_string(),
        ];
        let default_attempt =
            historian::completion_wait_budget(historian::historian_await_timeout(None));
        assert_eq!(
            McHandler::active_firing_join_budget(Some(&host_chain), Some(60_000)),
            default_attempt * 3
        );
    }

    fn publish_ctx_expand_fixture(
        store: &McStore,
        session_id: &str,
        project_path: &str,
        messages: &[CkIngressMessage],
    ) {
        let start = i64::try_from(messages.first().expect("fixture messages").ordinal).unwrap();
        let end = i64::try_from(messages.last().expect("fixture messages").ordinal).unwrap();
        let selected_range_identities = messages
            .iter()
            .map(|message| mc_store::HistorianSelectedMessageIdentity {
                mid: message.mid.clone(),
                block_identities: vec![mc_store::BlockIdentity {
                    kind_tag: "text".to_string(),
                    byte_fingerprint: format!("{}-identity", message.mid),
                }],
            })
            .collect::<Vec<_>>();
        let meta = ModuleMeta {
            block_identity_by_mid: selected_range_identities
                .iter()
                .map(|identity| (identity.mid.clone(), identity.block_identities.clone()))
                .collect(),
            historian: HistorianDurableState {
                state: HistorianPhase::Publishing,
                firing_seq: 1,
                chunk_range: Some(HistorianChunkRange {
                    from_ordinal: start as u64,
                    to_ordinal: end as u64,
                }),
                chunk_fingerprint: "ctx-expand-fixture".to_string(),
                selected_range_identities: selected_range_identities.clone(),
                producer_session_id: Some("ctx-expand-producer".to_string()),
                producer_run_id: Some("ctx-expand-run".to_string()),
                fired_at_ms: Some(1),
                expected_revert_epoch: 0,
                compartment_set_generation: mc_store::CompartmentSetGeneration::default(),
                ..Default::default()
            },
            ..Default::default()
        };
        store
            .commit(session_id, None, &CoreState::default(), &meta)
            .unwrap();
        let raw_messages = serde_json::to_string(messages).unwrap();
        let predicate = mc_store::HistorianPublishPredicate {
            firing_seq: 1,
            producer_run_id: "ctx-expand-run".to_string(),
            producer_attempt: 0,
            chunk_fingerprint: "ctx-expand-fixture".to_string(),
            selected_range_identities,
            compartment_set_generation: mc_store::CompartmentSetGeneration::default(),
        };
        store
            .publish_historian_chunk(mc_store::HistorianPublishRequest {
                rust_background_enabled: false,
                lifecycle_publication_id: None,
                harness: None,
                session_id,
                expected_row_version: store.load(session_id).unwrap().row_version,
                expected_revert_epoch: 0,
                predicate: &predicate,
                project_path,
                compartments: &[stored_comp(
                    1,
                    start,
                    end,
                    &format!("{}#0", messages.last().unwrap().mid),
                    "condensed fixture",
                )],
                facts: &[],
                promote_facts: false,
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: end as u64,
                chunk_transcript: Some(&format!("[{start}-{end}] U: condensed fixture")),
                raw_chunk_messages: Some(&raw_messages),
            })
            .unwrap();
    }

    #[test]
    fn ctx_expand_normalizes_copied_tag_forms_and_reduce_ranges() {
        for value in [
            json!(12),
            json!("12"),
            json!("§12§"),
            json!("§12"),
            json!("tag 12"),
            json!("[dropped §12§]"),
            json!("  §12§  "),
        ] {
            assert_eq!(normalize_tag_input(&value).unwrap(), 12);
            assert!(matches!(
                resolve_ctx_expand_mode(json!({"tag": value}).as_object().unwrap()).unwrap(),
                CtxExpandMode::Tag(12)
            ));
        }
        for value in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!(""),
            json!("12 13"),
            json!("§§12§"),
            json!("tag 12 extra"),
        ] {
            assert!(normalize_tag_input(&value)
                .unwrap_err()
                .contains("[dropped §12§]"));
        }
        assert_eq!(parse_tag_range_string("§3§-§5§").unwrap(), vec![3, 4, 5]);
        assert_eq!(parse_tag_range_string("§1§,§9§").unwrap(), vec![1, 9]);
        assert_eq!(
            parse_tag_range_string("tag 1,[dropped §9§],§12").unwrap(),
            vec![1, 9, 12]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_expand_tag_recovers_durable_text_and_tool_sibling_not_the_colliding_ordinal() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let mut fixture = json!([
            {"mid":"one", "ordinal":1, "ck":{"role":"user", "content":[{"type":"text", "text":"original text"}]}},
            {"mid":"two", "ordinal":2, "ck":{"role":"assistant", "content":[{"type":"tool_call", "id":"single", "name":"read", "input":{"path":"single.txt"}}, {"type":"tool_result", "id":"single", "tool_name":"read", "output":{"kind":"text", "text":"single output"}}]}},
            {"mid":"three", "ordinal":3, "ck":{"role":"assistant", "content":[{"type":"tool_call", "id":"left", "name":"read", "input":{"path":"left.txt"}}, {"type":"tool_result", "id":"left", "tool_name":"read", "output":{"kind":"text", "text":"left output"}}, {"type":"tool_call", "id":"right", "name":"read", "input":{"path":"right.txt"}}, {"type":"tool_result", "id":"right", "tool_name":"read", "output":{"kind":"text", "text":"right output"}}]}},
            {"mid":"four", "ordinal":4, "ck":{"role":"user", "content":[{"type":"text", "text":"ordinal four, not tag four"}]}}
        ]);
        for message in fixture.as_array_mut().unwrap() {
            for part in message["ck"]["content"].as_array_mut().unwrap() {
                if part["type"] == "tool_result" {
                    let text = part["output"]["text"].clone();
                    part["output"] = json!({"kind":{"type":"text", "text":text}});
                }
                *part = json!({"kind":part.clone()});
            }
        }
        let messages: Vec<ck_wire::CkIngressMessage> = serde_json::from_value(fixture).unwrap();
        publish_ctx_expand_fixture(&store, "ses", project.to_str().unwrap(), &messages);
        let inputs = ["one#0", "two#1", "three#1", "three#3"].map(|id| mc_store::TagMintInput {
            block_id: id.to_string(),
            kind: "message".to_string(),
            token_count: 10,
            source_bytes: b"original".to_vec(),
        });
        store.seed_tags_for_test("ses", &inputs, 1).unwrap();
        let text = tool_text(call_facade(&handler, "ctx_expand", json!({"tag":1})).await);
        assert!(text.contains("original text"), "{text}");
        let single = tool_text(call_facade(&handler, "ctx_expand", json!({"tag":2})).await);
        assert!(
            single.contains("single.txt") && single.contains("single output"),
            "{single}"
        );
        let right =
            tool_text(call_facade(&handler, "ctx_expand", json!({"tag":"[dropped §4§]"})).await);
        assert!(
            right.contains("right.txt") && right.contains("right output"),
            "{right}"
        );
        assert!(!right.contains("left output") && !right.contains("ordinal four"));
        let ordinal = tool_text(call_facade(&handler, "ctx_expand", json!({"message":4})).await);
        assert!(ordinal.contains("ordinal four, not tag four"), "{ordinal}");
        let unknown = tool_text(call_facade(&handler, "ctx_expand", json!({"tag":99})).await);
        assert_eq!(unknown, "no tag 99 in this session; if 99 came from a <session-history> heading or a ctx_search hit, it is an ordinal: use message=99");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_expand_uses_durable_raw_messages_for_exact_ranges_and_snapshot_loss() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let full_tool_output = "durable full tool output\n".repeat(20_000);
        let mut messages = (1..=100)
            .map(|ordinal| {
                ck_with_role(
                    &format!("m{ordinal}"),
                    ordinal,
                    "user",
                    &format!("ordinal-{ordinal}"),
                )
            })
            .collect::<Vec<_>>();
        messages[51] = tool_result("m52", 52, &full_tool_output);
        publish_ctx_expand_fixture(&store, "ses", project.to_str().unwrap(), &messages);

        // R5-09: a persisted transcript covering 1-100 must expose only the requested ordinals.
        let sliced =
            tool_text(call_facade(&handler, "ctx_expand", json!({"start": 50, "end": 55})).await);
        assert!(sliced.contains("Messages 50-55"));
        assert!(sliced.contains("[50] U: ordinal-50"));
        assert!(sliced.contains("[55] U: ordinal-55"));
        assert!(!sliced.contains("[1] U:"));
        assert!(!sliced.contains("[100] U:"));

        // R5-10: no transform snapshot is installed, so both routes must decode the durable
        // original-message payload instead of falling back to the condensed historian line.
        let full = tool_text(call_facade(&handler, "ctx_expand", json!({"message": 52})).await);
        assert!(full.contains("[52] tool — full recovery:"), "{full}");
        assert!(full.contains(&full_tool_output));
        let verbose = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"start": 52, "end": 52, "verbose": true}),
            )
            .await,
        );
        assert!(verbose.contains("[52] tool"));
        assert!(verbose.contains(&format!(
            "output ~{} tok",
            mc_tokenizer::estimate_tokens(&full_tool_output)
        )));
    }

    #[test]
    fn ctx_expand_verbose_distinguishes_tool_results_from_user_text() {
        let mut result = tool_result("result-1", 4, "file contents");
        result.ck.role = "user".to_string();
        let mut mixed = tool_result("result-2", 5, "more contents");
        mixed.ck.role = "user".to_string();
        mixed.ck.content.push(CkWireBlock::bare(CkKind::Text {
            text: "Continue".to_string(),
        }));
        let mut assistant_result = tool_result("result-3", 6, "assistant output");
        assistant_result.ck.role = "assistant".to_string();
        let messages = [
            ck_with_role("prompt", 2, "user", "Read PLAN.md"),
            ck_with_role("call", 3, "assistant", "Reading"),
            result,
            mixed,
            assistant_result,
            tool_result("result-4", 7, "Pi output"),
        ];
        assert_eq!(
            render_verbose_range_expand(&messages[..2], 2, 3).text,
            "[2] U (user)\n    • Read PLAN.md\n\n[3] A (assistant)\n    • Reading"
        );
        let rendered = render_verbose_range_expand(&messages, 2, 7);
        assert!(rendered.text.contains("[2] U (user)\n    • Read PLAN.md"));
        assert!(rendered.text.contains("[3] A (assistant)\n    • Reading"));
        assert!(rendered
            .text
            .contains("[4] tool results\n    • tool bash → output ~"));
        assert!(rendered
            .text
            .contains("[5] U (user)\n    • tool bash → output ~"));
        assert!(rendered.text.contains("    • Continue"));
        assert!(rendered
            .text
            .contains("[6] A (assistant)\n    • tool bash → output ~"));
        assert!(rendered
            .text
            .contains("[7] tool results\n    • tool bash → output ~"));
        assert_eq!(rendered.last_ordinal, 7);
    }

    #[test]
    fn ctx_expand_renderers_match_typescript_facade_golden() {
        let golden: Value =
            serde_json::from_str(include_str!("../testdata/ctx-facade-golden.json")).unwrap();
        assert_eq!(golden["schema"], json!(1));
        let cases = golden["cases"].as_array().expect("golden cases");
        assert!(!cases.is_empty(), "ctx facade golden must not be empty");
        for case in cases {
            let name = case["name"].as_str().expect("case name");
            let messages: Vec<ck_wire::CkIngressMessage> =
                serde_json::from_value(case["ck_messages"].clone()).expect("CK messages");
            for expected in case["expected"]["full"]
                .as_array()
                .expect("full render cases")
            {
                let ordinal = expected["ordinal"].as_u64().expect("full ordinal");
                let message = messages
                    .iter()
                    .find(|message| message.ordinal == ordinal)
                    .expect("golden message ordinal");
                assert_eq!(
                    render_cached_message_expand(message),
                    expected["text"].as_str().expect("full text"),
                    "full renderer drifted for {name} ordinal {ordinal}"
                );
            }
            let start = i64::try_from(messages.first().expect("messages").ordinal).unwrap();
            let end = i64::try_from(messages.last().expect("messages").ordinal).unwrap();
            let rendered = render_verbose_range_expand_with_budget(&messages, start, end, 15_000);
            let expected = &case["expected"]["verbose"];
            assert_eq!(
                rendered.text,
                expected["text"].as_str().expect("verbose text"),
                "verbose renderer drifted for {name}"
            );
            assert_eq!(
                rendered.last_ordinal,
                expected["lastOrdinal"].as_i64().expect("last ordinal"),
                "verbose last ordinal drifted for {name}"
            );
            assert_eq!(
                rendered.truncated,
                expected["truncated"].as_bool().expect("truncated"),
                "verbose truncation drifted for {name}"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_expand_accepts_ordinal_zero_because_cc_transcripts_are_zero_based() {
        // The ordinal DOMAINS deliberately differ across legs: OpenCode/Pi
        // transcripts are 1-based (the TypeScript facade rejects 0), while
        // Claude Code chunk transcripts store 0-based ordinals — so the module
        // facade must accept ordinal 0 or a CC session's first message becomes
        // permanently unexpandable. Same-schema-everywhere is false parity here.
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, _store, _dir, _project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );

        // Ordinal 0 passes domain validation (the miss is a not-found, not a
        // domain rejection), and negatives still refuse.
        let by_message = call_facade(&handler, "ctx_expand", json!({"message": 0})).await;
        assert!(!tool_text(by_message).contains("must be a"));
        let by_range = call_facade(&handler, "ctx_expand", json!({"start": 0, "end": 0})).await;
        assert!(!tool_text(by_range).contains("non-negative integers"));
        let negative = call_facade(&handler, "ctx_expand", json!({"message": -1})).await;
        assert!(tool_is_error(negative));
        let schema = prompt_surface::session_tools(&PromptSurfaceSelection::default())
            .into_iter()
            .find(|tool| tool.name == "ctx_expand")
            .unwrap()
            .schema;
        for property in ["message", "start", "end"] {
            assert_eq!(schema["properties"][property]["type"], json!("number"));
            assert!(schema["properties"][property].get("minimum").is_none());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_expand_required_all_filler_matches_clean_call_for_every_mode() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, _store, _dir, _project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );

        let range_clean =
            tool_text(call_facade(&handler, "ctx_expand", json!({"start": 1, "end": 3})).await);
        let range_filler = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"start": 1, "end": 3, "message": 0, "verbose": false}),
            )
            .await,
        );
        assert_eq!(range_filler, range_clean);

        let verbose_clean = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"start": 1, "end": 3, "verbose": true}),
            )
            .await,
        );
        let verbose_filler = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"start": 1, "end": 3, "verbose": true, "message": 0}),
            )
            .await,
        );
        assert_eq!(verbose_filler, verbose_clean);

        let message_clean =
            tool_text(call_facade(&handler, "ctx_expand", json!({"message": 2})).await);
        let message_filler = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"message": 2, "start": 0, "end": 0, "verbose": false}),
            )
            .await,
        );
        assert_eq!(message_filler, message_clean);

        let zero_message_clean =
            tool_text(call_facade(&handler, "ctx_expand", json!({"message": 0})).await);
        let zero_message_filler = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"message": 0, "start": 0, "end": 0, "verbose": false}),
            )
            .await,
        );
        assert_eq!(zero_message_filler, zero_message_clean);

        let zero_range_clean =
            tool_text(call_facade(&handler, "ctx_expand", json!({"start": 0, "end": 10})).await);
        let zero_range_filler = tool_text(
            call_facade(
                &handler,
                "ctx_expand",
                json!({"start": 0, "end": 10, "message": 0, "verbose": false}),
            )
            .await,
        );
        assert_eq!(zero_range_filler, zero_range_clean);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_search_required_all_filler_matches_clean_call() {
        let resolver = FakeSessionResolver::with(&[("token", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let project = project.to_str().unwrap();
        handler.bind_route(7, binding(project, "token"));
        insert_memory(
            &store,
            project,
            "CONSTRAINTS",
            "Needle alpha should appear",
            10,
        );
        insert_memory(
            &store,
            project,
            "CONSTRAINTS",
            "Needle bravo should appear",
            20,
        );
        insert_memory(
            &store,
            project,
            "CONSTRAINTS",
            "Needle charlie should appear",
            30,
        );

        let clean =
            tool_text(call_facade(&handler, "ctx_search", json!({"query": "Needle"})).await);
        let filler = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": "Needle", "sources": [], "limit": 0}),
            )
            .await,
        );
        assert_eq!(filler, clean);
        assert!(clean.contains("Found 3 results"), "{clean}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_memory_required_all_filler_matches_clean_call_for_every_action() {
        let setup = || {
            let resolver =
                FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
            handler_with_store_and_resolver(
                Arc::new(ProducerState::default()),
                default_test_config(),
                resolver,
            )
        };
        let filler_ids = |ids: Value| {
            json!({
                "ids": ids,
                "id": 1,
                "target_id": 1,
                "source_ids": [1],
                "memory_project": "",
                "limit": 0,
                "reason": ""
            })
        };
        let mut mismatches = Vec::new();
        let mut check = |action: &'static str, filler: &str, clean: &str| {
            if filler != clean {
                mismatches.push(action);
            }
        };

        let (write_clean_handler, _store, _dir, _project) = setup();
        let (write_filler_handler, _store, _dir, _project) = setup();
        let write_clean = tool_text(
            call_facade(
                &write_clean_handler,
                "ctx_memory",
                json!({
                    "action": "write",
                    "category": "PROJECT_RULES",
                    "content": "Same standalone fact."
                }),
            )
            .await,
        );
        let mut write_filler = filler_ids(json!([0]));
        write_filler["action"] = json!("write");
        write_filler["category"] = json!("PROJECT_RULES");
        write_filler["content"] = json!("Same standalone fact.");
        let write_filler =
            tool_text(call_facade(&write_filler_handler, "ctx_memory", write_filler).await);
        check("write", &write_filler, &write_clean);
        assert!(write_clean.contains("Saved memory"), "{write_clean}");

        let (update_clean_handler, update_clean_store, _dir, update_clean_project) = setup();
        let (update_filler_handler, update_filler_store, _dir, update_filler_project) = setup();
        let update_clean_project = update_clean_project.to_str().unwrap();
        let update_filler_project = update_filler_project.to_str().unwrap();
        insert_memory(
            &update_clean_store,
            update_clean_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let update_clean_id = insert_memory(
            &update_clean_store,
            update_clean_project,
            "ARCHITECTURE",
            "Original fact.",
            20,
        );
        insert_memory(
            &update_filler_store,
            update_filler_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let update_filler_id = insert_memory(
            &update_filler_store,
            update_filler_project,
            "ARCHITECTURE",
            "Original fact.",
            20,
        );
        let update_clean = tool_text(
            call_facade(
                &update_clean_handler,
                "ctx_memory",
                json!({
                    "action": "update",
                    "ids": [update_clean_id],
                    "content": "Updated fact."
                }),
            )
            .await,
        );
        let mut update_filler = filler_ids(json!([update_filler_id]));
        update_filler["action"] = json!("update");
        update_filler["content"] = json!("Updated fact.");
        update_filler["category"] = json!("");
        let update_filler =
            tool_text(call_facade(&update_filler_handler, "ctx_memory", update_filler).await);
        check("update", &update_filler, &update_clean);

        let (archive_clean_handler, archive_clean_store, _dir, archive_clean_project) = setup();
        let (archive_filler_handler, archive_filler_store, _dir, archive_filler_project) = setup();
        let archive_clean_project = archive_clean_project.to_str().unwrap();
        let archive_filler_project = archive_filler_project.to_str().unwrap();
        insert_memory(
            &archive_clean_store,
            archive_clean_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let archive_clean_id = insert_memory(
            &archive_clean_store,
            archive_clean_project,
            "PROJECT_RULES",
            "Archive this fact.",
            20,
        );
        insert_memory(
            &archive_filler_store,
            archive_filler_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let archive_filler_id = insert_memory(
            &archive_filler_store,
            archive_filler_project,
            "PROJECT_RULES",
            "Archive this fact.",
            20,
        );
        let archive_clean = tool_text(
            call_facade(
                &archive_clean_handler,
                "ctx_memory",
                json!({"action": "archive", "ids": [archive_clean_id]}),
            )
            .await,
        );
        let mut archive_filler = filler_ids(json!([archive_filler_id]));
        archive_filler["action"] = json!("archive");
        archive_filler["content"] = json!("");
        archive_filler["category"] = json!("");
        let archive_filler =
            tool_text(call_facade(&archive_filler_handler, "ctx_memory", archive_filler).await);
        check("archive", &archive_filler, &archive_clean);

        let (merge_clean_handler, merge_clean_store, _dir, merge_clean_project) = setup();
        let (merge_filler_handler, merge_filler_store, _dir, merge_filler_project) = setup();
        let merge_clean_project = merge_clean_project.to_str().unwrap();
        let merge_filler_project = merge_filler_project.to_str().unwrap();
        insert_memory(
            &merge_clean_store,
            merge_clean_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let merge_clean_id_1 = insert_memory(
            &merge_clean_store,
            merge_clean_project,
            "PROJECT_RULES",
            "Merge source one.",
            20,
        );
        let merge_clean_id_2 = insert_memory(
            &merge_clean_store,
            merge_clean_project,
            "PROJECT_RULES",
            "Merge source two.",
            30,
        );
        insert_memory(
            &merge_filler_store,
            merge_filler_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let merge_filler_id_1 = insert_memory(
            &merge_filler_store,
            merge_filler_project,
            "PROJECT_RULES",
            "Merge source one.",
            20,
        );
        let merge_filler_id_2 = insert_memory(
            &merge_filler_store,
            merge_filler_project,
            "PROJECT_RULES",
            "Merge source two.",
            30,
        );
        let merge_clean = tool_text(
            call_facade(
                &merge_clean_handler,
                "ctx_memory",
                json!({
                    "action": "merge",
                    "ids": [merge_clean_id_1, merge_clean_id_2],
                    "content": "Merged standalone fact.",
                    "category": "ARCHITECTURE"
                }),
            )
            .await,
        );
        let mut merge_filler = filler_ids(json!([merge_filler_id_1, merge_filler_id_2]));
        merge_filler["action"] = json!("merge");
        merge_filler["content"] = json!("Merged standalone fact.");
        merge_filler["category"] = json!("ARCHITECTURE");
        let merge_filler =
            tool_text(call_facade(&merge_filler_handler, "ctx_memory", merge_filler).await);
        check("merge", &merge_filler, &merge_clean);
        check(
            "merge-category",
            if merge_clean.contains("in ARCHITECTURE") {
                "present"
            } else {
                "missing"
            },
            "present",
        );

        let (get_handler, get_store, _dir, get_project) = setup();
        let get_project = get_project.to_str().unwrap();
        insert_memory(
            &get_store,
            get_project,
            "PROJECT_RULES",
            "Unchanged control.",
            10,
        );
        let get_id = insert_memory(
            &get_store,
            get_project,
            "PROJECT_RULES",
            "Get this fact.",
            20,
        );
        let get_clean = tool_text(
            call_facade(
                &get_handler,
                "ctx_memory",
                json!({"action": "get", "ids": [get_id]}),
            )
            .await,
        );
        let mut get_filler = filler_ids(json!([get_id]));
        get_filler["action"] = json!("get");
        get_filler["content"] = json!("");
        get_filler["category"] = json!("");
        let get_filler = tool_text(call_facade(&get_handler, "ctx_memory", get_filler).await);
        check("get", &get_filler, &get_clean);

        let (list_handler, list_store, _dir, list_project) = setup();
        let list_project = list_project.to_str().unwrap();
        for (offset, label) in ["one", "two", "three"].into_iter().enumerate() {
            insert_memory(
                &list_store,
                list_project,
                "PROJECT_RULES",
                &format!("List filler {label}."),
                10 + i64::try_from(offset).unwrap(),
            );
        }
        let list_clean =
            tool_text(call_facade(&list_handler, "ctx_memory", json!({"action": "list"})).await);
        let mut list_filler = filler_ids(json!([1]));
        list_filler["action"] = json!("list");
        list_filler["content"] = json!("");
        list_filler["category"] = json!("");
        let list_filler = tool_text(call_facade(&list_handler, "ctx_memory", list_filler).await);
        check("list", &list_filler, &list_clean);

        assert!(
            mismatches.is_empty(),
            "required-all output drifted for: {}",
            mismatches.join(", ")
        );
    }

    // The ctx_note and ctx_memory schemas mark their key arguments required, so
    // providers that send only required arguments always carry `note_ids`, `ids`,
    // `content` and `category`, filled with an empty or unrelated value where the
    // action has no use for them. These calls go through the real facade argument
    // decoding and handlers.
    #[tokio::test(flavor = "current_thread")]
    async fn ctx_note_required_note_ids_accept_empty_lists_where_unused() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, _store, _dir, _project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );

        let written = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "write", "content": "remember the lattice", "note_ids": []}),
            )
            .await,
        );
        assert!(written.starts_with("Saved session note #1."), "{written}");

        let plain = tool_text(call_facade(&handler, "ctx_note", json!({"action": "read"})).await);
        assert!(plain.contains("remember the lattice"), "{plain}");
        let empty_list = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "content": "", "note_ids": []}),
            )
            .await,
        );
        assert_eq!(empty_list, plain);

        let targeted = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "content": "", "note_ids": [1]}),
            )
            .await,
        );
        assert!(targeted.starts_with("## Notes by ID"), "{targeted}");
        assert!(targeted.contains("remember the lattice"), "{targeted}");

        let dismiss = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "dismiss", "content": "", "note_ids": []}),
        )
        .await;
        assert_eq!(
            tool_text(dismiss),
            "Error: 'note_ids' must contain 1 to 50 positive integer ids when action is 'dismiss'."
        );
        let update = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "update", "content": "changed", "note_ids": []}),
        )
        .await;
        assert_eq!(
            tool_text(update),
            "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'."
        );
        let still_active =
            tool_text(call_facade(&handler, "ctx_note", json!({"action": "read"})).await);
        assert_eq!(still_active, plain);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_memory_required_arguments_accept_values_the_action_does_not_use() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let project = project.to_str().unwrap();

        // write: an empty ids list is ignored; empty content is still refused.
        let written = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "write",
                    "content": "Written with an empty id list.",
                    "category": "PROJECT_RULES",
                    "ids": []
                }),
            )
            .await,
        );
        assert!(written.starts_with("Saved memory [ID: "), "{written}");
        let empty_content = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({"action": "write", "content": "", "category": "PROJECT_RULES", "ids": []}),
            )
            .await,
        );
        assert_eq!(
            empty_content,
            "Error: 'content' is required when action is 'write'."
        );

        // get: content and an unrelated category are ignored; empty ids are refused.
        let get_id = insert_memory(&store, project, "PROJECT_RULES", "Get this fact.", 20);
        let got = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({"action": "get", "ids": [get_id], "content": "", "category": "CONSTRAINTS"}),
            )
            .await,
        );
        assert!(
            got.contains(&format!("Memory [ID: {get_id}] in PROJECT_RULES")),
            "{got}"
        );
        assert!(got.contains("Get this fact."), "{got}");
        let get_empty = call_facade(
            &handler,
            "ctx_memory",
            json!({"action": "get", "ids": [], "content": "", "category": "CONSTRAINTS"}),
        )
        .await;
        assert!(tool_is_error(get_empty));

        // archive: content and an unrelated category are ignored.
        let archive_id = insert_memory(&store, project, "PROJECT_RULES", "Archive this fact.", 30);
        let archived = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "archive",
                    "ids": [archive_id],
                    "content": "",
                    "category": "CONSTRAINTS"
                }),
            )
            .await,
        );
        assert_eq!(archived, format!("Archived memory IDs [{archive_id}]."));

        // update: the category sent is the one the memory ends up in. Sending its
        // current category keeps it; sending another moves it; an empty value
        // keeps it as well.
        let update_id = insert_memory(&store, project, "ARCHITECTURE", "Original fact.", 40);
        let kept = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "update",
                    "ids": [update_id],
                    "content": "Updated fact.",
                    "category": "ARCHITECTURE"
                }),
            )
            .await,
        );
        assert_eq!(
            kept,
            format!("Updated memory [ID: {update_id}] in ARCHITECTURE.")
        );
        let moved = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "update",
                    "ids": [update_id],
                    "content": "Updated fact, renamed.",
                    "category": "NAMING"
                }),
            )
            .await,
        );
        assert_eq!(
            moved,
            format!("Updated memory [ID: {update_id}] in NAMING.")
        );
        let empty_category = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "update",
                    "ids": [update_id],
                    "content": "Updated fact, once more.",
                    "category": ""
                }),
            )
            .await,
        );
        assert_eq!(
            empty_category,
            format!("Updated memory [ID: {update_id}] in NAMING.")
        );

        // merge: the category sent is the merged memory's category.
        let first = insert_memory(&store, project, "CONSTRAINTS", "Merge source one.", 50);
        let second = insert_memory(&store, project, "CONSTRAINTS", "Merge source two.", 60);
        let merged = tool_text(
            call_facade(
                &handler,
                "ctx_memory",
                json!({
                    "action": "merge",
                    "ids": [first, second],
                    "content": "Merged fact.",
                    "category": "CONFIG_VALUES"
                }),
            )
            .await,
        );
        assert!(merged.contains("in CONFIG_VALUES"), "{merged}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_glance_lists_one_row_per_note_with_age_and_stale_markers() {
        for smart_notes_enabled in [true, false] {
            let producer = Arc::new(ProducerState::default());
            let resolver =
                FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
            let (handler, store, _dir, _project) =
                handler_with_store_and_resolver(producer, default_test_config(), resolver);
            let mut route = binding("/repo", "token");
            route.config.smart_notes_enabled = smart_notes_enabled;
            handler.bind_route(7, route);
            if !smart_notes_enabled {
                let refused = tool_text(
                    call_facade(
                        &handler,
                        "ctx_note",
                        json!({"content": "cached", "surface_condition": "old"}),
                    )
                    .await,
                );
                assert_eq!(
                    refused,
                    "Error: Smart notes are disabled; surface_condition is unavailable."
                );
            }

            let now = now_ms();
            let day = 24 * 60 * 60 * 1000;
            // A ready smart note, a parked smart note, and three plain notes: one
            // fresh, one two days old, one untouched for 40 days.
            let ready = store
                .insert_project_note(NoteWriteInput {
                    project_path: "/repo",
                    route_project_root: None,
                    session_id: Some("session"),
                    content: "Ready smart item",
                    surface_condition: Some("condition"),
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    now_ms: now - 5 * day,
                })
                .unwrap();
            store
                .write_note_evaluation(NoteEvaluationInput {
                    project_path: "/repo",
                    note_id: ready.id,
                    source_revision: ready.status_version,
                    verdict: true,
                    compiled_check: None,
                    manifest_json: None,
                    check_hash: None,
                    next_due_at: None,
                    now_ms: now - 5 * day,
                })
                .unwrap();
            store
                .insert_project_note(NoteWriteInput {
                    project_path: "/repo",
                    route_project_root: None,
                    session_id: Some("session"),
                    content: "Parked smart item",
                    surface_condition: Some("condition"),
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    now_ms: now - 2 * day,
                })
                .unwrap();
            insert_session_note_at(&store, "Fresh plain item", now);
            insert_session_note_at(&store, "Two-day-old plain item", now - 2 * day);
            insert_session_note_at(&store, "Forty-day-old plain item", now - 40 * day);

            let glance =
                tool_text(call_facade(&handler, "ctx_note", json!({"action": "read"})).await);

            // Ready smart notes first, then pending, then plain notes newest first.
            assert_eq!(
                glance,
                "## Notes\n\n\
             #1 · 5d · Ready smart item · ready\n\
             #2 · 2d · Parked smart item · pending\n\
             #3 · 0m · Fresh plain item\n\
             #4 · 2d · Two-day-old plain item\n\
             #5 · 5w · Forty-day-old plain item · stale\n\n\
             To dismiss a stale note: ctx_note(action=\"dismiss\", note_ids=[N])"
            );
        }
    }

    #[test]
    fn note_facade_parked_reason_is_visible_in_glance_and_body() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (_handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let now = now_ms();
        let mut note = store
            .insert_project_note(NoteWriteInput {
                project_path: "/repo",
                route_project_root: None,
                session_id: Some("session"),
                content: "Watch schema",
                surface_condition: Some("schema appears"),
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                anchor_block_id: None,
                anchor_ordinal: None,
                now_ms: now,
            })
            .unwrap();
        note.check_status = Some("parked".to_string());
        note.ready_reason = Some(
            "Condition can't be checked: source is not publicly readable; rewrite it".to_string(),
        );
        assert_eq!(format_glance_row(&note, now), "#1 · 0m · Watch schema · pending · parked: Condition can't be checked: source is not publicly readable; rewrite it");
        assert_eq!(format_note_body(&note, now), "- **#1** · 0m · pending: Watch schema\n  Condition: schema appears\n  Condition can't be checked: source is not publicly readable; rewrite it");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_pages_ready_notes_beyond_one_hundred_with_shared_offset_semantics() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, _dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));
        for index in 0..105 {
            let note = store
                .insert_project_note(NoteWriteInput {
                    project_path: "/repo",
                    route_project_root: None,
                    session_id: Some("session"),
                    content: &format!("ready note {index}"),
                    surface_condition: Some("condition"),
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    now_ms: index,
                })
                .unwrap();
            store
                .write_note_evaluation(NoteEvaluationInput {
                    project_path: "/repo",
                    note_id: note.id,
                    source_revision: note.status_version,
                    verdict: true,
                    compiled_check: None,
                    manifest_json: None,
                    check_hash: None,
                    next_due_at: None,
                    now_ms: index,
                })
                .unwrap();
        }
        let page = tool_text(
            call_facade(
                &handler,
                "ctx_note",
                json!({"action": "read", "filter": "ready", "limit": 5, "offset": 100}),
            )
            .await,
        );
        assert!(page.contains("ready note 4"));
        assert!(page.contains("ready note 0"));
        assert!(!page.contains("ready note 104"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn note_facade_recovers_pre_and_post_migration_compilation_metadata() {
        let producer = Arc::new(ProducerState::default());
        let resolver =
            FakeSessionResolver::with(&[("token", FakeResolve::Hit("session".to_string()))]);
        let (handler, store, dir, _project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        handler.bind_route(7, binding("/repo", "token"));
        for (content, provider, config, at, status) in [
            ("legacy condition", None, None, None, None),
            (
                "compiled condition",
                Some("retina-local-fs"),
                Some("{\"kind\":\"path_exists\"}"),
                Some(123),
                Some("compiled"),
            ),
        ] {
            store
                .insert_project_note(NoteWriteInput {
                    project_path: "/repo",
                    route_project_root: None,
                    session_id: Some("session"),
                    content,
                    surface_condition: Some(content),
                    compiled_provider: provider,
                    compiled_config: config,
                    compiled_at: at,
                    compile_status: status,
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    now_ms: 1,
                })
                .unwrap();
        }
        let old = store
            .get_note_by_id("/repo", "session", 1)
            .unwrap()
            .unwrap();
        assert_eq!(old.compiled_provider, None);
        assert_eq!(old.compile_status, None);
        let new = store
            .get_note_by_id("/repo", "session", 2)
            .unwrap()
            .unwrap();
        assert_eq!(new.compiled_provider.as_deref(), Some("retina-local-fs"));
        assert_eq!(
            new.compiled_config.as_deref(),
            Some("{\"kind\":\"path_exists\"}")
        );
        assert_eq!(new.compiled_at, Some(123));
        assert_eq!(new.compile_status.as_deref(), Some("compiled"));

        drop(handler);
        drop(store);
        let reopened = McStore::open_for_test(&dev_descriptor_at(
            dir.path().join("data").to_str().unwrap(),
        ))
        .unwrap();
        let durable = reopened
            .get_note_by_id("/repo", "session", 2)
            .unwrap()
            .unwrap();
        assert_eq!(
            durable.compiled_provider.as_deref(),
            Some("retina-local-fs")
        );
        assert_eq!(durable.compiled_at, Some(123));
        assert_eq!(durable.compile_status.as_deref(), Some("compiled"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_search_matches_typescript_shape_for_available_module_corpora() {
        let producer = Arc::new(ProducerState::default());
        let resolver = FakeSessionResolver::with(&[("token", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) =
            handler_with_store_and_resolver(producer, default_test_config(), resolver);
        let project = project.to_str().unwrap();
        handler.bind_route(7, binding(project, "token"));

        let visible_id = insert_memory(&store, project, "CONSTRAINTS", "needle visible", 10);
        let first_id = insert_memory(&store, project, "CONSTRAINTS", "needle memory first", 20);
        let second_id = insert_memory(&store, project, "CONSTRAINTS", "needle memory second", 20);
        assert_eq!(
            parse_search_memory_ids(&format!("#{first_id}, {second_id}")),
            Some(vec![first_id, second_id])
        );
        assert_eq!(
            parse_search_memory_ids(&format!("{first_id} {second_id}")),
            None,
            "direct memory ids require TypeScript's comma-separated query shape"
        );
        store
            .replace_compartments("ses", &[stored_comp(1, 10, 20, "m20", "needle history")])
            .unwrap();
        let note = store
            .insert_project_note(NoteWriteInput {
                project_path: project,
                route_project_root: None,
                session_id: Some("ses"),
                content: "needle note",
                surface_condition: None,
                compiled_provider: None,
                compiled_config: None,
                compiled_at: None,
                compile_status: None,
                anchor_block_id: Some("m18#0"),
                anchor_ordinal: Some(18),
                now_ms: now_ms(),
            })
            .unwrap();
        seed_shown_memory_pair(&store, "ses", project, visible_id);

        let all = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": "needle", "limit": 10}),
            )
            .await,
        );
        assert!(all.starts_with("Found 4 results for \"needle\":"), "{all}");
        assert!(!all.lines().any(|line| {
            line.contains("[memory]") && line.contains(&format!("id={visible_id} "))
        }));
        assert!(all.contains(&format!("[memory] score=1.00 id={first_id}")));
        assert!(all.contains(&format!("[memory] score=1.00 id={second_id}")));
        assert!(all.contains(&format!(
            "Memories: 1 additional match suppressed because it is already visible in your project-memory block (ids {visible_id})."
        )));
        assert!(
            all.find(&format!("id={first_id}")) < all.find(&format!("id={second_id}")),
            "equal-score/equal-recency memory ties must use ascending ids: {all}"
        );
        assert!(
            all.contains("[message] score=0.90 compartment_id=1 range=10-20 match=fts title=C1")
        );
        assert!(all.contains(&format!("[note] score=0.11 id=#{}", note.id)));
        assert!(all.contains("@msg 18"));
        assert!(all.contains("Use ctx_expand(start, end)"));

        let message_only = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": "needle", "sources": ["message"]}),
            )
            .await,
        );
        assert!(message_only.contains("[message]"));
        assert!(!message_only.contains("[memory]"));
        assert!(!message_only.contains("[note]"));

        let id_lookup = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": format!("#{second_id}"), "sources": ["memory"]}),
            )
            .await,
        );
        assert!(id_lookup.contains(&format!("id={second_id}")));
        assert!(id_lookup.contains("match=fts"));

        let visible_lookup = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": format!("#{visible_id}"), "sources": ["memory"]}),
            )
            .await,
        );
        assert_eq!(
            visible_lookup,
            format!(
                "No hidden results found for \"#{visible_id}\".\n\nMemories: 1 match found, all already visible in your project-memory block (ids {visible_id})."
            )
        );

        let unsupported_corpus = tool_text(
            call_facade(
                &handler,
                "ctx_search",
                json!({"query": "needle", "sources": ["primer", "git_commit"]}),
            )
            .await,
        );
        assert_eq!(
            unsupported_corpus,
            "No results found for \"needle\" across notes, memories, primers, git commits, or message history."
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_dreamer_run_unregisters_its_child_session() {
        let producer = Arc::new(ProducerState::default());
        producer.block_output.store(true, Ordering::SeqCst);
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        let route_root = project.to_str().unwrap();
        handler.bind_route(7, binding(route_root, "parent"));
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;
        let handler = Arc::new(handler);
        let running_handler = Arc::clone(&handler);
        let task = tokio::spawn(async move {
            running_handler
                .handle_dreamer_run_task(
                    7,
                    &json!({
                        "v": 1,
                        "session_id": "parent",
                        "task": CLASSIFY_TASK,
                        "command_id": "cancel-command",
                        "authority_generation": generation,
                        "model_chain": [TEST_HISTORIAN_MODEL],
                        "payload": { "prompt_body": "classify", "items": [] },
                    }),
                )
                .await
        });
        wait_for_count(&producer.await_outputs, 1).await;
        // The session is minted per attempt, so read the one the producer actually ran
        // under rather than recomputing an id this test would have to keep in step.
        let child_session = producer
            .sessions
            .lock()
            .expect("sessions mutex")
            .first()
            .cloned()
            .expect("the classify attempt started under a session");
        assert!(handler.dreamer_run_registered(&child_session));

        task.abort();
        let _ = task.await;
        assert!(!handler.dreamer_run_registered(&child_session));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ctx_expand_preserves_typescript_tool_titles_from_durable_transcripts() {
        let golden: Value =
            serde_json::from_str(include_str!("../testdata/ctx-facade-golden.json")).unwrap();
        let case = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "merged-completed-tool-and-structural-noise")
            .unwrap();
        let messages: Vec<ck_wire::CkIngressMessage> =
            serde_json::from_value(case["ck_messages"].clone()).unwrap();
        let expected = case["expected"]["full"][0]["text"].as_str().unwrap();
        assert!(expected.contains("description: Read the runtime configuration"));

        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        publish_ctx_expand_fixture(&store, "ses", project.to_str().unwrap(), &messages);

        // ctx_expand reads the message back from its durable chunk transcript.
        let expanded = tool_text(call_facade(&handler, "ctx_expand", json!({"message": 7})).await);
        assert_eq!(expanded, expected);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn conditional_note_writes_are_refused_and_plain_notes_are_written() {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            default_test_config(),
            resolver,
        );
        let refused = call_facade(
            &handler,
            "ctx_note",
            json!({
                "action": "write",
                "content": "pending without evaluator",
                "surface_condition": "when evaluated",
            }),
        )
        .await;
        let refused_text = tool_text(refused);
        assert_eq!(
            refused_text,
            "Conditional notes are not available in the current mode. Save a regular note without a condition. (MC-C08)"
        );

        let plain = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "write", "content": "plain note is allowed"}),
        )
        .await;
        assert!(!tool_is_error(plain));
        let plain_id = store
            .search_notes_like(project.to_str().unwrap(), "ses", "plain note is allowed")
            .unwrap()[0]
            .id;
        let session_update = call_facade(
            &handler,
            "ctx_note",
            json!({"action": "update", "note_ids": [plain_id], "surface_condition": "when evaluated"}),
        ).await;
        assert!(
            tool_text(session_update).contains("Only a note created with a condition can have one")
        );
        let unchanged = store
            .get_note_by_id(project.to_str().unwrap(), "ses", plain_id)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.status, "active");
        assert!(unchanged.surface_condition.is_none());
    }

    /// Every route of the retired host-driven mode answers `transform_route_retired`
    /// with its own name, under either discriminator field, on a bound or unbound
    /// channel, so a stale caller never reads it as an unknown request.
    #[tokio::test(flavor = "current_thread")]
    async fn every_retired_route_answers_transform_route_retired_by_name() {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        assert_eq!(RETIRED_TRANSFORM_ROUTES.len(), 17);
        for method in RETIRED_TRANSFORM_ROUTES {
            for key in ["method", "kind"] {
                for channel in [7, 99] {
                    let mut request = json!({"v": 1, "session_id": "ses"});
                    request[key] = json!(method);
                    match handler.dispatch_value(channel, request).await {
                        HandlerOutcome::Error { code, message } => {
                            assert_eq!(code, RETIRED_ROUTE_CODE, "{method} {key} {channel}");
                            assert_eq!(message, *method, "{key} {channel}");
                        }
                        other => panic!("{method} {key} {channel}: {other:?}"),
                    }
                }
            }
        }
    }

    /// An old-lane `session.wrapup` drove the historian over the request the last
    /// `transform` pass left behind, so it can never succeed now: it answers the
    /// named, non-retryable `transform_route_retired` instead of a retryable
    /// refusal. Its envelope checks still run first.
    #[tokio::test(flavor = "current_thread")]
    async fn old_lane_session_wrapup_answers_transform_route_retired() {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        for request in [
            json!({"method": "session.wrapup", "v": 1, "session_id": "ses"}),
            json!({"method": "session.wrapup", "v": 1, "session_id": "ses",
                "command_id": "wrapup-1", "keep": 5}),
        ] {
            match handler.dispatch_value(7, request.clone()).await {
                HandlerOutcome::Error { code, message } => {
                    assert_eq!(code, RETIRED_ROUTE_CODE, "{request}");
                    assert_eq!(message, "session.wrapup", "{request}");
                }
                other => panic!("{request}: {other:?}"),
            }
        }
        let malformed = handler
            .dispatch_value(
                7,
                json!({"method": "session.wrapup", "v": 1, "session_id": "ses", "command_id": ""}),
            )
            .await;
        assert!(
            matches!(&malformed, HandlerOutcome::Error { code, .. } if code == "bad_request"),
            "{malformed:?}"
        );
    }

    /// The code, message and detail of an error frame that carries machine-readable detail.
    fn detailed_error_frame(outcome: HandlerOutcome) -> (String, String, Value) {
        match outcome {
            HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            } => (code, message, detail),
            other => panic!("expected an error frame with detail, got {other:?}"),
        }
    }

    /// Stand in for an open that has begun and not yet landed, so a test can drive the request
    /// lane's in-flight arm without racing a real open to it.
    fn mark_store_open_in_flight(handler: &McHandler, descriptor: &StorageDescriptor) {
        handler.store_open.begin_attempt(
            descriptor,
            DescriptorOrigin::DaemonAck,
            now_ms().max(0) as u64,
        );
        handler.store_open.set_phase(STORE_OPENING);
    }

    /// A store that a newer ck-mc migrated one version past this binary is refused, and every
    /// surface names that refusal with both versions: the health lane, the shared refusal seam,
    /// the runner lane, a session op and a facade tool. A lane that answered with a
    /// generic "no store" error, or answered at all, would be the half-working state the refusal
    /// exists to prevent.
    #[tokio::test]
    async fn a_store_ahead_of_this_binary_is_refused_by_name_on_health_and_every_lane() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let ahead = LATEST_MIGRATION_VERSION + 1;
        let newer = McStore::open_for_test(&descriptor).unwrap();
        newer.stamp_schema_version_for_test(ahead).unwrap();
        drop(newer);

        let handler = McHandler::new();
        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        tokio::time::timeout(Duration::from_secs(1), async {
            while handler.store_open.failure_snapshot().is_none() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("an open that cannot succeed must record its reason");
        assert!(handler.store.get().is_none(), "no store handle may exist");

        let report = <McHandler as ModuleHandler>::health(&handler).await;
        assert_eq!(report.status, HealthStatus::Failing);
        let metrics = report
            .metrics
            .expect("a refused open must carry health metrics");
        assert_eq!(metrics["storage_state"], "open_refused_store_ahead");
        assert_eq!(
            metrics["storage_open_failure_reason_code"],
            STORE_AHEAD_OF_BINARY_REFUSAL_REASON
        );
        assert_eq!(metrics["store_db_version"], ahead);
        assert_eq!(
            metrics["binary_max_store_version"],
            LATEST_MIGRATION_VERSION
        );
        let detail = report
            .detail
            .expect("a refused open must carry a health detail");
        assert!(
            detail.contains(&format!(
                "{STORE_AHEAD_OF_BINARY_REFUSAL_REASON}: db_version={ahead} binary_max={LATEST_MIGRATION_VERSION}"
            )),
            "health must name the refusal and both versions: {detail}"
        );
        assert!(
            detail.contains("context.db and store.db from the same backup"),
            "health must carry the remediation: {detail}"
        );

        let expected_detail = json!({
            "reason_code": STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
            "db_version": ahead,
            "binary_max": LATEST_MIGRATION_VERSION,
        });
        let (code, message, frame_detail) = detailed_error_frame(handler.store_refusal());
        assert_eq!(code, STORE_AHEAD_OF_BINARY_REFUSAL_REASON);
        assert_eq!(frame_detail, expected_detail);
        assert!(message.contains("(terminal)"), "{message}");

        // The runner lane's async compaction op and a session op, through request dispatch.
        for request in [
            json!({ "method": "compaction.setup", "params": {} }),
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ] {
            let (code, _, detail) =
                detailed_error_frame(handler.dispatch_value(7, request.clone()).await);
            assert_eq!(code, STORE_AHEAD_OF_BINARY_REFUSAL_REASON, "{request}");
            assert_eq!(detail, expected_detail, "{request}");
        }

        // A facade tool, whose message is what the user reads.
        let (tool_code, tool_message, tool_detail) = detailed_error_frame(
            call_facade(&handler, "ctx_memory", json!({ "action": "list" })).await,
        );
        assert_eq!(tool_code, STORE_AHEAD_OF_BINARY_REFUSAL_REASON);
        assert_eq!(tool_detail, expected_detail);
        assert_eq!(
            tool_message,
            format!(
                "Magic Context refused to start: its store (store.db) is at schema v{ahead} but this ck-mc build only knows up to v{LATEST_MIGRATION_VERSION}. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)"
            )
        );
    }

    /// A first request that arrives during the open must be served by that open, not refused a few
    /// dozen milliseconds before it lands.
    #[tokio::test]
    async fn a_request_waits_out_an_in_flight_store_open() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let opened = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        mark_store_open_in_flight(&handler, &descriptor);

        let slot = Arc::clone(&handler.store);
        let coordinator = Arc::clone(&handler.store_open);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            let _ = slot.set(Arc::new(opened));
            coordinator.set_phase(STORE_OPENED);
        });
        // The request lane's store seam, which every facade tool goes through, waits out
        // the open instead of refusing a request a few milliseconds before it lands.
        assert!(
            handler.store_for_request().await.is_ok(),
            "the request must reach the far side of the store seam once the open lands"
        );
    }

    /// A store that still holds the rows the single-store migration moves is refused
    /// by name on the mode-3 lanes: health reports it, and the shared refusal seam,
    /// the runner lane (`compaction.setup`), a session op (`session.status`) and a
    /// facade tool answer with it, so no lane half-works on rows this binary no
    /// longer reads. `echo` still answers. The store keeps every row and its
    /// version, because the refusal happens before any migration runs.
    #[tokio::test]
    async fn an_unmigrated_populated_store_is_refused_on_every_lane_except_echo() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let store_path = match &descriptor.backend {
            StorageBackend::Sqlite { path } => PathBuf::from(path),
            other => panic!("unexpected backend {other:?}"),
        };
        mc_store::migrate_store_to_pre_single_store(&store_path).unwrap();
        let rows_before = {
            let conn = rusqlite::Connection::open(&store_path).unwrap();
            conn.execute(
                "INSERT INTO mc_memories(project_path, category, content, normalized_hash)
                 VALUES ('git:p', 'CONSTRAINTS', 'kept', 'h')",
                [],
            )
            .unwrap();
            conn.query_row("SELECT COUNT(*) FROM mc_memories", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        };

        let handler = McHandler::new();
        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        tokio::time::timeout(Duration::from_secs(1), async {
            while handler.store_open.failure_snapshot().is_none() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("an open that cannot succeed must record its reason");
        assert!(handler.store.get().is_none(), "no store handle may exist");

        let report = <McHandler as ModuleHandler>::health(&handler).await;
        assert_eq!(report.status, HealthStatus::Failing);
        let metrics = report
            .metrics
            .expect("a refused open must carry health metrics");
        assert_eq!(metrics["storage_state"], "open_refused_unmigrated");
        assert_eq!(
            metrics["storage_open_failure_reason_code"],
            SINGLE_STORE_MIGRATION_REQUIRED_REASON
        );

        let (code, _, detail) = detailed_error_frame(handler.store_refusal());
        assert_eq!(code, SINGLE_STORE_MIGRATION_REQUIRED_REASON);
        assert_eq!(
            detail["reason_code"],
            SINGLE_STORE_MIGRATION_REQUIRED_REASON
        );

        // The runner lane's async compaction op and a session op, through request
        // dispatch. The dispatch fence answers before any binding check, so no
        // route needs binding for the refusal to name itself.
        for request in [
            json!({ "method": "compaction.setup", "params": {} }),
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ] {
            let (lane_code, _, lane_detail) =
                detailed_error_frame(handler.dispatch_value(7, request.clone()).await);
            assert_eq!(
                lane_code, SINGLE_STORE_MIGRATION_REQUIRED_REASON,
                "{request}"
            );
            assert_eq!(
                lane_detail["reason_code"],
                SINGLE_STORE_MIGRATION_REQUIRED_REASON
            );
        }

        let (tool_code, tool_message, _) = detailed_error_frame(
            call_facade(&handler, "ctx_memory", json!({ "action": "list" })).await,
        );
        assert_eq!(tool_code, SINGLE_STORE_MIGRATION_REQUIRED_REASON);
        assert_eq!(tool_message, SINGLE_STORE_MIGRATION_REQUIRED_SENTENCE);
        match handler
            .dispatch_value(7, json!({ "kind": "echo", "probe": 1 }))
            .await
        {
            HandlerOutcome::Response(body) => {
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["echo"]["probe"], 1);
            }
            other => panic!("echo must still answer, got {other:?}"),
        }

        let conn = rusqlite::Connection::open(&store_path).unwrap();
        let rows_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM mc_memories", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            rows_after, rows_before,
            "the refusal must not drop the store's rows"
        );
        assert_eq!(
            mc_store::single_store_schema::recorded_store_version(&conn).unwrap(),
            60
        );
    }

    /// A request that arrives while the lease is still held may retry; once the
    /// wait window has expired the open is never retried, so the refusal has to
    /// stop inviting a retry and name the reason instead. The two states therefore
    /// MUST NOT answer identically. Driven through the bound `session.status` op
    /// and the request-lane store seam, the mode-3 surfaces that outlive the
    /// retired transform lane.
    #[tokio::test]
    async fn lease_wait_expiry_turns_the_refusal_terminal_with_the_open_reason() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();
        let handler = McHandler::new();
        handler.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(60)));
        // The lease wait reaches the session arm past the dispatch fence (which
        // only covers the terminal migration refusals), so the channel must be
        // bound for the refusal to be the store's rather than the route's.
        handler.bind_route(7, binding(data_home.to_str().unwrap(), "ses"));

        handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&handler, STORE_OPEN_WAITING).await;
        let status_request = json!({ "method": "session.status", "v": 1, "session_id": "ses" });
        let (during_code, during_message) =
            error_frame(handler.dispatch_value(7, status_request.clone()).await);
        assert_eq!(during_code, "store_lease_wait");
        assert!(during_message.contains("retryable"), "{during_message}");
        let seam_during = match handler.store_for_request().await {
            Err(refusal) => refusal,
            Ok(_) => panic!("the lease wait must refuse on the request seam too"),
        };
        assert_eq!(seam_during.code(), "store_lease_wait");

        wait_for_store_open_phase(&handler, STORE_OPEN_IDLE).await;
        let (after_code, after_message) =
            error_frame(handler.dispatch_value(7, status_request).await);
        assert_eq!(after_code, "store_open_failed");
        assert!(
            after_message.contains("storage lease wait expired"),
            "the terminal refusal must carry the open reason: {after_message}"
        );
        assert!(
            after_message.contains("descriptor_origin=dev_fallback"),
            "the terminal refusal must name where the descriptor came from: {after_message}"
        );
        assert!(
            after_message.contains("terminal"),
            "a failed open must not invite a retry: {after_message}"
        );
        let seam_after = match handler.store_for_request().await {
            Err(refusal) => refusal,
            Ok(_) => panic!("the failed open must refuse on the request seam too"),
        };
        assert_eq!(seam_after.code(), "store_open_failed");
        assert_ne!(
            (during_code, during_message),
            (after_code, after_message),
            "a retryable lease wait and a terminal failed open must not share one refusal"
        );
    }

    /// The handle is a bare `Option`, so its emptiness cannot say WHICH state
    /// holds. A never-acked handle and a lease-waiting handle need opposite
    /// operator actions (find out why no ack arrived vs. wait for the other
    /// process to exit), so one shared code would be useless in both. Driven
    /// through the bound `session.status` op and the request-lane store seam.
    #[tokio::test]
    async fn missing_ack_refusal_says_no_open_was_ever_attempted() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();
        let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
        let _predecessor = McStore::open_for_test(&descriptor).unwrap();

        let never_acked = McHandler::new();
        never_acked.bind_route(7, binding(data_home.to_str().unwrap(), "ses"));
        let status_request = json!({ "method": "session.status", "v": 1, "session_id": "ses" });
        let (code, message) =
            error_frame(never_acked.dispatch_value(7, status_request.clone()).await);
        assert_eq!(code, "store_unavailable");
        assert!(
            message.contains("no HELLO_ACK has arrived"),
            "the never-acked arm is the only one that may blame the missing ack: {message}"
        );
        assert!(message.contains("retryable"), "{message}");
        let seam_never = match never_acked.store_for_request().await {
            Err(refusal) => refusal,
            Ok(_) => panic!("a never-acked handle must refuse on the request seam too"),
        };
        assert_eq!(seam_never.code(), "store_unavailable");

        // The lease wait must answer differently: same emptiness, different state.
        let waiting = McHandler::new();
        waiting.set_store_open_policy_for_test(short_store_open_policy(Duration::from_millis(500)));
        waiting.bind_route(7, binding(data_home.to_str().unwrap(), "ses"));
        waiting.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
        wait_for_store_open_phase(&waiting, STORE_OPEN_WAITING).await;
        let (lease_code, _) = error_frame(waiting.dispatch_value(7, status_request).await);
        assert_eq!(lease_code, "store_lease_wait");
        assert_ne!(
            code, lease_code,
            "two different storage states must not answer with one code"
        );
    }

    /// Rejected passes stay visible through `session.status`: the rejected-pass
    /// ring carries the attempt, the outcome and the error, and `health` mirrors
    /// it. The writes go straight to the store's pass-trace ring; the behaviour
    /// under test is the response surfacing on the live status entry points.
    #[tokio::test(flavor = "current_thread")]
    async fn status_and_health_surface_pass_trace_for_rejected_sessions() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());

        store
            .trace_pass_received("ses", "legacy-1", now_ms())
            .unwrap();
        store
            .trace_pass_rejected(
                "ses",
                "legacy-1",
                "live-source ordinals not strictly increasing",
                now_ms(),
            )
            .unwrap();

        let status = call_dispatch_request(
            &handler,
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        )
        .await;
        assert_eq!(status["ok"], true);
        assert_eq!(status["pass_trace"]["receive_count"], 1);
        assert_eq!(status["pass_trace"]["reject_count"], 1);
        assert_eq!(
            status["pass_trace"]["request_history"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            status["pass_trace"]["request_history"][0]["attempt_id"],
            "legacy-1"
        );
        assert_eq!(
            status["pass_trace"]["request_history"][0]["outcome"],
            "rejected"
        );
        assert!(status["pass_trace"]["request_history"][0]["completed_at_ms"].is_number());
        assert_eq!(
            status["pass_trace"]["last_reject_error"],
            "live-source ordinals not strictly increasing"
        );

        let health =
            call_dispatch_request(&handler, json!({ "kind": "health", "session_id": "ses" })).await;
        assert_eq!(health["pass_trace"], status["pass_trace"]);
    }

    /// The request-history ring caps at thirty-two entries: older attempts drop
    /// off the front while the newest stays complete, and a still-open attempt
    /// reads back as `received` with no completion. Surfaced through
    /// `session.status`, the live read path for the durable ring.
    #[tokio::test(flavor = "current_thread")]
    async fn request_trace_ring_records_attempt_lifecycle_and_caps_at_thirty_two() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());

        for index in 0..35 {
            let attempt = format!("attempt-{index}");
            store
                .trace_pass_received("ses", &attempt, now_ms())
                .unwrap();
            store
                .trace_pass_completed("ses", &attempt, now_ms())
                .unwrap();
        }

        let trace = store.load_pass_trace("ses").unwrap().unwrap();
        assert_eq!(trace.request_history.len(), 32);
        assert_eq!(
            trace.request_history.first().unwrap().attempt_id,
            "attempt-3"
        );
        assert_eq!(
            trace.request_history.last().unwrap().attempt_id,
            "attempt-34"
        );
        assert!(trace.request_history.iter().all(|request| {
            request.outcome == "completed"
                && request
                    .completed_at_ms
                    .is_some_and(|completed| completed >= request.received_at_ms)
        }));

        store
            .trace_pass_received("ses", "attempt-stalled", now_ms())
            .unwrap();
        let status = call_dispatch_request(
            &handler,
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        )
        .await;
        let history = status["pass_trace"]["request_history"]
            .as_array()
            .expect("session.status exposes request history");
        assert_eq!(history.len(), 32);
        assert_eq!(history.last().unwrap()["attempt_id"], "attempt-stalled");
        assert_eq!(
            history.last().unwrap()["received_at_ms"],
            json!(
                store
                    .load_pass_trace("ses")
                    .unwrap()
                    .unwrap()
                    .request_history
                    .last()
                    .unwrap()
                    .received_at_ms
            )
        );
        assert_eq!(history.last().unwrap()["completed_at_ms"], Value::Null);
        assert_eq!(history.last().unwrap()["outcome"], "received");
    }

    /// Runtime store diagnostics keep the failure arm that recorded them: two
    /// different codes recorded for one session read back verbatim on
    /// `session.status` and on `health`, never collapsed to one constant. The
    /// records are written the way the retired transform path wrote them; the
    /// behaviour under test is the fidelity of the live read surfaces.
    #[tokio::test(flavor = "current_thread")]
    async fn runtime_store_error_preserves_distinct_failure_codes_in_status_and_health() {
        let producer = Arc::new(ProducerState::default());
        let (handler, _store, _dir, _project) = handler_with_store(producer, default_test_config());

        handler
            .runtime_store_errors
            .lock()
            .expect("runtime store errors mutex")
            .insert(
                "ses".to_string(),
                RuntimeStoreError {
                    code: "store_write_failed".to_string(),
                    message: "first diagnostic".to_string(),
                    at_ms: 101,
                },
            );
        let status = call_dispatch_request(
            &handler,
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        )
        .await;

        handler
            .runtime_store_errors
            .lock()
            .expect("runtime store errors mutex")
            .insert(
                "ses".to_string(),
                RuntimeStoreError {
                    code: "store_unavailable".to_string(),
                    message: "second diagnostic".to_string(),
                    at_ms: 202,
                },
            );
        let health =
            call_dispatch_request(&handler, json!({ "kind": "health", "session_id": "ses" })).await;

        assert_eq!(status["runtime_store_error"]["code"], "store_write_failed");
        assert_eq!(status["runtime_store_error"]["message"], "first diagnostic");
        assert_eq!(status["runtime_store_error"]["at_ms"], 101);
        assert_eq!(health["runtime_store_error"]["code"], "store_unavailable");
        assert_eq!(
            health["runtime_store_error"]["message"],
            "second diagnostic"
        );
        assert_eq!(health["runtime_store_error"]["at_ms"], 202);
        assert_ne!(
            status["runtime_store_error"]["code"], health["runtime_store_error"]["code"],
            "runtime store diagnostics must preserve the failure arm rather than a constant code"
        );
    }

    /// A locked store fails typed on the live `session.flush` lane, and the
    /// recorded diagnostic reads back through `session.status` and `health`.
    /// The lock is a real `BEGIN IMMEDIATE` with no busy wait, so the write
    /// fails with the SQLite busy error instead of a fabricated string.
    #[tokio::test(flavor = "current_thread")]
    async fn sqlite_busy_session_flush_is_typed_and_visible_in_status_and_health() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, dir, _project) = handler_with_store(producer, default_test_config());

        let descriptor = dev_descriptor_at(dir.path().join("data").to_str().unwrap());
        let StorageBackend::Sqlite { path } = descriptor.backend else {
            panic!("test descriptor must use SQLite")
        };
        let locker = rusqlite::Connection::open(path).unwrap();
        locker.busy_timeout(Duration::ZERO).unwrap();
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        // Arming the soft refresh writes the session meta row, so the held
        // write lock fails the live lane with the typed store error.
        let outcome = handler.handle_session_flush_value(
            7,
            &json!({ "method": "session.flush", "v": 1, "session_id": "ses" }),
        );
        let (code, message) = error_frame(outcome);
        assert_eq!(code, "store_write_failed");
        assert!(message.contains("database is locked"), "{message}");
        locker.execute_batch("ROLLBACK").unwrap();
        // The lock is gone: the same lane serves again, proving the failure
        // was the lock rather than the lane.
        let recovered = tool_body(handler.handle_session_flush_value(
            7,
            &json!({ "method": "session.flush", "v": 1, "session_id": "ses" }),
        ));
        assert_eq!(recovered["ok"], true);

        // The retired transform path recorded `Store` failures for the status
        // surfaces; record this one the same way and check both surfaces.
        handler
            .runtime_store_errors
            .lock()
            .expect("runtime store errors mutex")
            .insert(
                "ses".to_string(),
                RuntimeStoreError {
                    code: code.clone(),
                    message: message.clone(),
                    at_ms: now_ms(),
                },
            );
        let status = call_dispatch_request(
            &handler,
            json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        )
        .await;
        assert_eq!(status["runtime_store_error"]["code"], "store_write_failed");
        assert_eq!(status["runtime_store_error"]["message"], message);
        let health =
            call_dispatch_request(&handler, json!({ "kind": "health", "session_id": "ses" })).await;
        assert_eq!(health["runtime_store_error"], status["runtime_store_error"]);
        drop(store);
    }

    /// The publish-failure counter and its degraded flag read through
    /// `session.status`, and a later success state resets both while keeping
    /// the refusal taxonomy (stage and canonical cause) on the last failure.
    #[tokio::test(flavor = "current_thread")]
    async fn session_status_surfaces_publish_failure_health_and_reset() {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, _project) = handler_with_store(producer, default_test_config());

        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta;
        meta.historian.consecutive_publish_failures = 3;
        store
            .commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let degraded = tool_body(handler.handle_session_status_value(
            7,
            &json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ));
        assert_eq!(degraded["historian"]["consecutive_publish_failures"], 3);
        assert_eq!(degraded["historian"]["publish_health_degraded"], true);
        assert!(degraded["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("publish health degraded"));

        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta;
        meta.historian.consecutive_publish_failures = 0;
        meta.historian.firing_seq = 2;
        meta.historian.failure_backoff_at_ms = None;
        meta.historian.last_no_fire = None;
        let refusal = "published with historian refusal: historian refusal stage=credential provider=opencode/model-a received=\"open_failed: run resolution failed: no apikey credential for provider 'opencode'\"";
        meta.historian.last_failure = Some(refusal.to_string());
        store
            .commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let recovered = tool_body(handler.handle_session_status_value(
            7,
            &json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        ));
        assert_eq!(recovered["historian"]["consecutive_publish_failures"], 0);
        assert_eq!(recovered["historian"]["publish_health_degraded"], false);
        assert!(recovered["historian"]["last_outcome"]
            .as_str()
            .is_some_and(|outcome| {
                outcome.contains("published seq 2")
                    && outcome.contains("stage=credential provider=opencode")
            }));
        assert!(recovered["summary"]
            .as_str()
            .is_some_and(|summary| summary.contains("stage=credential provider=opencode")));
        assert_eq!(recovered["historian"]["refusal_stage"], "credential");
        assert_eq!(
            recovered["historian"]["canonical_cause"],
            "credential_unavailable"
        );
        assert_eq!(recovered["historian"]["last_failure"], refusal);
    }

    /// The content language reaches the historian system prompt on the provider
    /// (runner-lane) path, and changes nothing else: the localized fire request
    /// carries the Turkish directive the plain one lacks, while the assembled
    /// user prompt, chunk fingerprint and raw chunk messages are identical.
    /// If the language wiring is removed both systems match and the test fails;
    /// if the language leaks into the data the fingerprints differ and it fails.
    #[tokio::test(flavor = "current_thread")]
    async fn content_language_changes_only_the_historian_system_prompt_on_the_provider_path() {
        // The assembler builds the USER prompt (chunk + references); the language
        // directive belongs only on the producer request's system prompt, never
        // on the served surface. So compare systems off the fire request and
        // data off the assembled firing.
        fn firing_system_and_data(language: Option<&str>) -> (String, String, String, String) {
            let producer = Arc::new(ProducerState::default());
            let mut config = default_test_config();
            config.rust_background_enabled = true;
            config.language = language.map(str::to_string);
            let (handler, store, _dir, project) = handler_with_store(producer, config.clone());
            let mut route = binding(project.to_str().unwrap(), "ses");
            route.config = config;
            route.principal = Some(subc_protocol::Principal::Reserved {
                module_id: "thalamus-harness".into(),
            });
            let mut raw = request(wrapup_messages(240, 800));
            raw["historian_model_chain"] = json!(["provider/model"]);
            raw["historian_model_limits"] =
                json!({"provider/model": {"context": 200_000, "output": 160_000}});
            let parsed: TransformRequest = serde_json::from_value(raw).unwrap();
            let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
            let mut timings = HistorianTriggerTimings::default();
            match handler.prepare_historian_fire(
                store.clone(),
                &parsed,
                &route,
                project.to_str().unwrap(),
                &projection,
                HistorianPrepareContext {
                    rust_background_enabled: Some(true),
                    now: now_ms(),
                    publication_fence: None,
                    async_coverage: None,
                    reclaim_ride_available: false,
                    runner_lane: true,
                    timings: &mut timings,
                },
            ) {
                PreparedHistorianAction::FireReady(prepared) => {
                    let task = prepared.task;
                    let firing_request = task.firing.as_fire_request(
                        &store,
                        &task.session_id,
                        &task.project_path,
                        &task.harness,
                        &task.project_slug,
                        task.language.as_deref(),
                    );
                    (
                        firing_request.system.into_owned(),
                        task.firing.prompt.clone(),
                        task.firing.chunk_fingerprint.clone(),
                        task.firing.raw_chunk_messages.clone(),
                    )
                }
                PreparedHistorianAction::Complete(diagnostics) => {
                    panic!("expected firing: {diagnostics:?}")
                }
                PreparedHistorianAction::Busy { .. } => panic!("unexpected busy"),
            }
        }

        let (plain_system, plain_prompt, plain_fingerprint, plain_raw) =
            firing_system_and_data(None);
        let (localized_system, localized_prompt, localized_fingerprint, localized_raw) =
            firing_system_and_data(Some("tr"));

        assert!(
            !plain_system.contains("prose you author in"),
            "the plain fire request carries no language directive"
        );
        assert!(
            localized_system.contains("Write human-readable prose you author in: Turkish (Türkçe)"),
            "the localized fire request carries the Turkish directive"
        );
        assert_ne!(
            localized_system, plain_system,
            "language must change the historian system prompt"
        );
        assert_eq!(
            localized_prompt, plain_prompt,
            "language must not change the assembled user prompt"
        );
        assert_eq!(
            localized_fingerprint, plain_fingerprint,
            "language must not change the assembled chunk identity"
        );
        assert_eq!(
            localized_raw, plain_raw,
            "language must not change the assembled chunk data"
        );
    }
}

#[cfg(test)]
mod provenance_form_degradation {
    use subc_client_rs::build_provenance;

    // Short 8-hex deploy stamps (the pre-0.17 ladder convention) must fail the
    // canonical form check — this pins WHY the manifest call site degrades to
    // omission instead of unwrapping.
    #[test]
    fn short_sha_is_rejected_by_form_check_and_full_sha_is_accepted() {
        assert!(build_provenance(Some("22464bf2"), None, None).is_err());
        let ok = build_provenance(Some("22464bf25db24c4037f5efda72c8bb02d64baf51"), None, None)
            .expect("full lowercase 40-hex sha is canonical");
        assert_eq!(
            ok.build_git_sha.as_deref(),
            Some("22464bf25db24c4037f5efda72c8bb02d64baf51")
        );
    }
}

mod user_answer;

fn normalize_tag_text(raw: &str) -> &str {
    let raw = raw.trim();
    if let Some(inner) = raw
        .strip_prefix("[dropped §")
        .and_then(|s| s.strip_suffix("§]"))
    {
        return inner;
    }
    if let Some(inner) = raw.strip_prefix("tag ") {
        return inner.trim_start();
    }
    if let Some(inner) = raw.strip_prefix('§') {
        return inner.strip_suffix('§').unwrap_or(inner);
    }
    raw
}

fn normalize_tag_input(value: &Value) -> Result<i64, String> {
    const ERROR: &str = "Error: tag must be one positive integer: 12, \"12\", \"§12§\", \"§12\", \"tag 12\", or \"[dropped §12§]\" (surrounding whitespace is allowed).";
    let number = if let Some(raw) = value.as_str() {
        parse_tag_integer(raw)
            .ok()
            .and_then(|n| i64::try_from(n).ok())
    } else {
        value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n <= 9007199254740991.0)
                .map(|n| n as i64)
        })
    };
    number
        .filter(|n| *n > 0 && *n <= 9007199254740991)
        .ok_or_else(|| ERROR.to_string())
}

fn render_tag_expand(tag: &mc_store::McTagRow, messages: &[ck_wire::CkIngressMessage]) -> String {
    let Some((mid, index)) = ck_wire::split_block_id(&tag.block_id) else {
        return format!(
            "Tag {}'s original block is no longer in stored history.",
            tag.tag_number
        );
    };
    let mut ordered = messages.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|message| message.ordinal);
    ordered.dedup_by(|left, right| left.mid == right.mid);
    let parts = ordered
        .iter()
        .flat_map(|message| {
            message
                .ck
                .content
                .iter()
                .enumerate()
                .map(move |(index, block)| (message.mid.as_str(), index, block))
        })
        .collect::<Vec<_>>();
    let Some(position) = parts
        .iter()
        .position(|(owner, part, _)| *owner == mid && *part == index)
    else {
        return format!(
            "Tag {}'s original block is no longer in stored history.",
            tag.tag_number
        );
    };
    let block = parts[position].2;
    let (call, result) = match &block.kind {
        ck_wire::CkKind::ToolCall { id, .. } => {
            let result = parts
                .iter()
                .skip(position + 1)
                .find_map(|(_, _, part)| match &part.kind {
                    ck_wire::CkKind::ToolResult { id: other, .. } if other == id => {
                        Some(Some(*part))
                    }
                    ck_wire::CkKind::ToolCall { id: other, .. } if other == id => Some(None),
                    _ => None,
                })
                .flatten();
            (Some(block), result)
        }
        ck_wire::CkKind::ToolResult { id, .. } => {
            let call = parts[..position]
                .iter()
                .rev()
                .find_map(|(_, _, part)| match &part.kind {
                    ck_wire::CkKind::ToolCall { id: other, .. } if other == id => Some(Some(*part)),
                    ck_wire::CkKind::ToolResult { id: other, .. } if other == id => Some(None),
                    _ => None,
                })
                .flatten();
            (call, Some(block))
        }
        _ => return render_cached_expand_part(block).unwrap_or_default(),
    };
    [call, result]
        .into_iter()
        .flatten()
        .filter_map(render_cached_expand_part)
        .collect::<Vec<_>>()
        .join("\n")
}
#[cfg(test)]
#[path = "../tests/support/perf_audit.rs"]
mod perf_audit;

impl McHandler {
    pub fn registered_module_id(&self) -> &str {
        &self.registered_module_id
    }
}
