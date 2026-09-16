//! Historian writer orchestration: the durable firing state machine
//! (idle → firing → awaiting_producer → validating → publishing), the pinned
//! ordinal-range chunk snapshot with fail-loud fingerprint verification, and the
//! CAS-gated publish transaction whose writes surface only through the m1
//! watermark on the next materializing pass (a publish never mutates cached
//! render state directly).

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(test)]
use mc_store::HistorianDecision;
use mc_store::{
    CompartmentSetGeneration, FactCandidate, HistorianChunkRange, HistorianDurableState,
    HistorianEventCandidate, HistorianPhase, HistorianPrimerCandidate, HistorianPublishError,
    HistorianPublishPredicate, HistorianPublishRequest, HistorianPublishResult,
    HistorianRecentDecision, HistorianSelectedMessageIdentity, HistorianUserMemoryCandidate,
    McStore, McStoreError, StoredCompartment,
};

use crate::historian_producer::{
    ErrorClass, ErrorClassification, HistorianProducer, HistorianProducerError, ProducerErrorBody,
    ProducerOutput, RunHandle, RunState,
};
use crate::historian_validate::{
    validate_historian_output, HistorianChunk, HistorianValidationError, StoredCompartmentRange,
    ValidateOptions, ValidatedChunk, ValidatedCompartment,
};

/// Default cooldown after an abandoned historian firing.
pub const HISTORIAN_FAILURE_BACKOFF_MS: i64 = 60_000;

const CHAIN_EXHAUSTED_PERMANENT_PREFIX: &str = "chain-exhausted-permanent:";
const AUTH_REQUIRED_PREFIX: &str = "auth-required:";
const UNKNOWN_ERROR_CLASS_PREFIX: &str = "unknown-error-class:";
pub(crate) const MODEL_UNRESOLVABLE_CHAIN_EXHAUSTED_PREFIX: &str =
    "model_unresolvable_chain_exhausted:";
pub(crate) const MODEL_UNRESOLVABLE_PUBLISHED_PREFIX: &str = "published_with_model_unresolvable:";

#[derive(Debug, Default)]
struct HistorianModelUnresolvableCacheState {
    generation: u64,
    model_chain: Vec<String>,
    reasons: BTreeMap<String, String>,
}

/// Models rejected by Broca's resolver for the current module/config generation. The handler
/// shares this cache across sessions; changing the effective chain advances the generation and
/// discards every prior refusal.
#[derive(Debug, Default)]
pub struct HistorianModelUnresolvableCache {
    state: Mutex<HistorianModelUnresolvableCacheState>,
}

impl HistorianModelUnresolvableCache {
    pub(crate) fn activate_chain(&self, model_chain: &[String]) -> u64 {
        let mut state = self.state.lock().expect("historian model cache mutex");
        if state.model_chain != model_chain {
            state.generation = state.generation.wrapping_add(1).max(1);
            state.model_chain = model_chain.to_vec();
            state.reasons.clear();
        }
        state.generation
    }

    fn cached_reason(&self, generation: u64, model: &str) -> Option<String> {
        let state = self.state.lock().expect("historian model cache mutex");
        (state.generation == generation)
            .then(|| state.reasons.get(model).cloned())
            .flatten()
    }

    pub(crate) fn cached_reasons(
        &self,
        generation: u64,
        model_chain: &[String],
    ) -> Vec<(String, String)> {
        model_chain
            .iter()
            .filter_map(|model| {
                self.cached_reason(generation, model)
                    .map(|reason| (model.clone(), reason))
            })
            .collect()
    }

    pub(crate) fn all_models_unresolvable(&self, generation: u64, model_chain: &[String]) -> bool {
        !model_chain.is_empty()
            && model_chain
                .iter()
                .all(|model| self.cached_reason(generation, model).is_some())
    }

    fn record(&self, generation: u64, model: &str, reason: &str) -> bool {
        let mut state = self.state.lock().expect("historian model cache mutex");
        if state.generation != generation {
            return false;
        }
        if state.reasons.contains_key(model) {
            return false;
        }
        state.reasons.insert(model.to_string(), reason.to_string());
        true
    }
}

/// Project a validated compartment onto the durable store row shape. Validation
/// resolves the message-id endpoints and tiers; publication stamps the row and
/// carries the message-boundary dates captured by the native ingress path.
fn to_stored_compartment(
    c: &ValidatedCompartment,
    created_at_ms: i64,
    boundary_dates: &BTreeMap<String, String>,
) -> StoredCompartment {
    StoredCompartment {
        sequence: c.sequence as i64,
        start_message: c.start_message as i64,
        end_message: c.end_message as i64,
        start_message_id: c.start_message_id.clone(),
        end_message_id: c.end_message_id.clone(),
        start_date: boundary_dates.get(&c.start_message_id).cloned(),
        end_date: boundary_dates.get(&c.end_message_id).cloned(),
        title: c.title.clone(),
        content: c.content.clone(),
        p1: c.p1.clone(),
        p2: c.p2.clone(),
        p3: c.p3.clone(),
        p4: c.p4.clone(),
        importance: c.importance.map(|i| i as i32).unwrap_or(50),
        episode_type: c.episode_type.clone(),
        // Strict validation makes tierless output unreachable, but derive legacy
        // from P1 so a future bypass cannot falsely mark a flat row as v2.
        legacy: if c.p1.as_deref().is_some_and(|p1| !p1.trim().is_empty()) {
            0
        } else {
            1
        },
        created_at: created_at_ms,
    }
}

/// Project a validated fact candidate onto the store's promotion input. Historian facts
/// have no importance or expiry at publish time, but retain the source session so later
/// maintenance can relate them to the publication that created them.
fn to_store_fact(
    f: &crate::historian_validate::FactCandidate,
    source_session_id: &str,
) -> FactCandidate {
    FactCandidate {
        category: f.category.clone(),
        content: f.content.clone(),
        importance: None,
        expires_at: None,
        source_session_id: Some(source_session_id.to_string()),
    }
}

fn source_compartment(
    compartments: &[crate::historian_validate::ValidatedCompartment],
    origin: Option<u64>,
) -> Option<&crate::historian_validate::ValidatedCompartment> {
    origin
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| compartments.get(index as usize))
}

fn to_store_event(
    event: &crate::historian_validate::ParsedEvent,
    compartments: &[crate::historian_validate::ValidatedCompartment],
    created_at: i64,
) -> HistorianEventCandidate {
    HistorianEventCandidate {
        kind: event.kind.clone(),
        at_compartment: event.at_compartment,
        compartment_id: source_compartment(compartments, event.at_compartment)
            .map(|compartment| compartment.sequence),
        fields_json: serde_json::to_string(&event.fields).unwrap_or_else(|_| "{}".to_string()),
        created_at,
        harness: "module".to_string(),
    }
}

fn to_store_primer(
    candidate: &crate::historian_validate::PrimerCandidate,
    session_id: &str,
    project_path: &str,
    compartments: &[crate::historian_validate::ValidatedCompartment],
    created_at: i64,
) -> HistorianPrimerCandidate {
    let source = source_compartment(compartments, candidate.origin_compartment_index);
    let start = source.or_else(|| compartments.first());
    let end = source.or_else(|| compartments.last());
    HistorianPrimerCandidate {
        project_path: project_path.to_string(),
        session_id: session_id.to_string(),
        question: candidate.question.clone(),
        source_compartment_start: start.map(|compartment| compartment.start_message),
        source_compartment_end: end.map(|compartment| compartment.end_message),
        source_start_message_id: start
            .map(|compartment| compartment.start_message_id.clone())
            .unwrap_or_default(),
        source_end_message_id: end
            .map(|compartment| compartment.end_message_id.clone())
            .unwrap_or_default(),
        source_message_time: created_at,
        created_at,
    }
}

fn to_store_user_observation(
    observation: &crate::historian_validate::UserObservationCandidate,
    session_id: &str,
    compartments: &[crate::historian_validate::ValidatedCompartment],
    created_at: i64,
) -> HistorianUserMemoryCandidate {
    let source = source_compartment(compartments, observation.origin_compartment_index);
    let start = source.or_else(|| compartments.first());
    let end = source.or_else(|| compartments.last());
    HistorianUserMemoryCandidate {
        content: observation.content.clone(),
        session_id: session_id.to_string(),
        source_compartment_start: start.map(|compartment| compartment.start_message),
        source_compartment_end: end.map(|compartment| compartment.end_message),
        created_at,
    }
}

/// One flat item in the pinned chunk snapshot used to guard producer output.
/// The fingerprint intentionally records byte lengths rather than content bytes:
/// insertion/removal and type/id changes alter the fingerprint, while unrelated
/// metadata drift and same-length content edits do not stale a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkSnapshotItem<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub bytes: &'a str,
}

/// Compute the content-stable historian chunk fingerprint. For already-flattened
/// chunk items it uses ordered `(id, kind, byte-length)` pieces joined without
/// hashing so mismatches are readable in diagnostics.
pub fn compute_chunk_fingerprint(items: &[ChunkSnapshotItem<'_>]) -> String {
    items
        .iter()
        .map(|item| format!("{}:{}:{}", item.id, item.kind, item.bytes.len()))
        .collect::<Vec<_>>()
        .join("|")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FireOutcome {
    Fired(HistorianDurableState),
    Busy(HistorianDurableState),
}

/// Rust's concrete reason for declining a historian firing. The raw variant name stays
/// available for Rust incident tooling while `canonical_cause` maps the decision onto the
/// TypeScript operator vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianNoFireCause {
    HistorianAlreadyInProgress,
    LiveHistorianClaimBusy,
    RestartRecoveryInProgress,
    CheapGateBelowTriggerBudget,
    NoLiveMessageAtOrAfterOffset,
    RawTailInspectionFailed,
    ProjectedPostDropSatisfied,
    ProtectedTailWindowEmpty,
    BelowProactiveFloor,
    BelowMinimumEligibleContent,
    DrainBudgetSpent,
    MissingBoundarySnapshot,
    StaleBoundarySnapshot,
    EmptyFilteredChunk,
    InvalidChunkCoverage,
    NoModels,
    ModelUnresolvable,
    FailureBackoff,
    ValidationRejected,
    ChainExhausted,
    PendingRewrite,
    StateLoadFailed,
    ContinuedOrdinalOffsetMissing,
    MissingBoundary,
    EmptyEligibleRange,
    EmptyChunk,
    BelowSubstanceFloor,
    MissingBlockIdentity,
    AssemblyFailed,
    SubagentSession,
}

impl HistorianNoFireCause {
    pub const fn raw_cause(self) -> &'static str {
        match self {
            Self::HistorianAlreadyInProgress => "HistorianAlreadyInProgress",
            Self::LiveHistorianClaimBusy => "LiveHistorianClaimBusy",
            Self::RestartRecoveryInProgress => "RestartRecoveryInProgress",
            Self::CheapGateBelowTriggerBudget => "CheapGateBelowTriggerBudget",
            Self::NoLiveMessageAtOrAfterOffset => "NoLiveMessageAtOrAfterOffset",
            Self::RawTailInspectionFailed => "RawTailInspectionFailed",
            Self::ProjectedPostDropSatisfied => "ProjectedPostDropSatisfied",
            Self::ProtectedTailWindowEmpty => "ProtectedTailWindowEmpty",
            Self::BelowProactiveFloor => "BelowProactiveFloor",
            Self::BelowMinimumEligibleContent => "BelowMinimumEligibleContent",
            Self::DrainBudgetSpent => "DrainBudgetSpent",
            Self::MissingBoundarySnapshot => "MissingBoundarySnapshot",
            Self::StaleBoundarySnapshot => "StaleBoundarySnapshot",
            Self::EmptyFilteredChunk => "EmptyFilteredChunk",
            Self::InvalidChunkCoverage => "InvalidChunkCoverage",
            Self::NoModels => "NoModels",
            Self::ModelUnresolvable => "ModelUnresolvable",
            Self::FailureBackoff => "FailureBackoff",
            Self::ValidationRejected => "ValidationRejected",
            Self::ChainExhausted => "ChainExhausted",
            Self::PendingRewrite => "PendingRewrite",
            Self::StateLoadFailed => "StateLoadFailed",
            Self::ContinuedOrdinalOffsetMissing => "ContinuedOrdinalOffsetMissing",
            Self::MissingBoundary => "MissingBoundary",
            Self::EmptyEligibleRange => "EmptyEligibleRange",
            Self::EmptyChunk => "EmptyChunk",
            Self::BelowSubstanceFloor => "BelowSubstanceFloor",
            Self::MissingBlockIdentity => "MissingBlockIdentity",
            Self::AssemblyFailed => "AssemblyFailed",
            Self::SubagentSession => "SubagentSession",
        }
    }

    pub const fn canonical_cause(self) -> &'static str {
        match self {
            Self::HistorianAlreadyInProgress
            | Self::LiveHistorianClaimBusy
            | Self::RestartRecoveryInProgress => "in_flight",
            Self::CheapGateBelowTriggerBudget => "cheap_skip",
            Self::NoLiveMessageAtOrAfterOffset | Self::EmptyChunk => "no_new_raw_history",
            Self::RawTailInspectionFailed => "raw_history_unavailable",
            Self::ProjectedPostDropSatisfied => "redundancy_skip",
            Self::ProtectedTailWindowEmpty | Self::MissingBoundary | Self::EmptyEligibleRange => {
                "protected_tail"
            }
            Self::BelowMinimumEligibleContent | Self::BelowSubstanceFloor => "below_min_chunk",
            Self::DrainBudgetSpent => "drain_budget",
            Self::MissingBoundarySnapshot => "missing_boundary_snapshot",
            Self::StaleBoundarySnapshot => "stale_boundary_snapshot",
            Self::EmptyFilteredChunk => "below_min_chunk",
            Self::InvalidChunkCoverage => "invalid_chunk_coverage",
            Self::BelowProactiveFloor => "below_proactive_floor",
            Self::NoModels => "no_models",
            Self::ModelUnresolvable => "model_unresolvable",
            Self::FailureBackoff => "failure_backoff",
            Self::ValidationRejected => "validation_rejected",
            Self::ChainExhausted => "chain_exhausted",
            Self::PendingRewrite => "pending_rewrite",
            Self::StateLoadFailed => "state_load_failed",
            Self::ContinuedOrdinalOffsetMissing => "state_incomplete",
            Self::MissingBlockIdentity => "invalid_boundary_identity",
            Self::AssemblyFailed => "assembly_failed",
            Self::SubagentSession => "subagent_session",
        }
    }
}

#[derive(Debug)]
pub enum HistorianStateError {
    InvalidRange {
        from_ordinal: u64,
        to_ordinal: u64,
    },
    InvalidTransition {
        from: HistorianPhase,
        event: &'static str,
    },
    MissingProducerIds {
        firing_seq: u64,
    },
    FingerprintMismatch {
        expected: String,
        found: String,
    },
    Store(McStoreError),
    Publish(HistorianPublishError),
}

impl fmt::Display for HistorianStateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistorianStateError::InvalidRange {
                from_ordinal,
                to_ordinal,
            } => write!(
                f,
                "historian invalid chunk range: from {from_ordinal} is after to {to_ordinal}"
            ),
            HistorianStateError::InvalidTransition { from, event } => write!(
                f,
                "historian invalid transition: event {event} cannot run from {}",
                from.as_str()
            ),
            HistorianStateError::MissingProducerIds { firing_seq } => write!(
                f,
                "historian firing {firing_seq} is missing producer ids needed for reattach/publish"
            ),
            HistorianStateError::FingerprintMismatch { expected, found } => write!(
                f,
                "historian chunk fingerprint mismatch: expected {expected}, found {found}"
            ),
            HistorianStateError::Store(e) => write!(f, "store: {e}"),
            HistorianStateError::Publish(e) => write!(f, "publish: {e}"),
        }
    }
}

impl std::error::Error for HistorianStateError {}

impl From<McStoreError> for HistorianStateError {
    fn from(e: McStoreError) -> Self {
        HistorianStateError::Store(e)
    }
}

impl From<HistorianPublishError> for HistorianStateError {
    fn from(e: HistorianPublishError) -> Self {
        HistorianStateError::Publish(e)
    }
}

/// Try to start a historian firing. Single-flight is enforced here: any
/// non-idle phase returns `Busy` with the unchanged state.
#[allow(clippy::too_many_arguments)] // The durable firing snapshot carries each fence explicitly.
pub fn fire(
    current: &HistorianDurableState,
    from_ordinal: u64,
    to_ordinal: u64,
    chunk_fingerprint: String,
    selected_range_identities: Vec<HistorianSelectedMessageIdentity>,
    expected_revert_epoch: u64,
    compartment_set_generation: CompartmentSetGeneration,
    fired_at_ms: i64,
    recent_decision: Option<HistorianRecentDecision>,
) -> Result<FireOutcome, HistorianStateError> {
    if from_ordinal > to_ordinal {
        return Err(HistorianStateError::InvalidRange {
            from_ordinal,
            to_ordinal,
        });
    }
    if current.state != HistorianPhase::Idle {
        return Ok(FireOutcome::Busy(current.clone()));
    }

    let mut recent_decisions = current.recent_decisions.clone();
    if let Some(decision) = recent_decision {
        let mut decision_state = HistorianDurableState {
            recent_decisions,
            ..HistorianDurableState::default()
        };
        decision_state.start_recent_fire(decision);
        recent_decisions = decision_state.recent_decisions;
    }

    Ok(FireOutcome::Fired(HistorianDurableState {
        state: HistorianPhase::Firing,
        firing_seq: current.firing_seq.saturating_add(1),
        chunk_range: Some(HistorianChunkRange {
            from_ordinal,
            to_ordinal,
        }),
        chunk_fingerprint,
        selected_range_identities,
        producer_session_id: None,
        producer_run_id: None,
        fired_at_ms: Some(fired_at_ms),
        expected_revert_epoch,
        compartment_set_generation,
        failure_backoff_at_ms: current.failure_backoff_at_ms,
        last_failure: current.last_failure.clone(),
        // A fire resolves whatever skip reason preceded it.
        last_no_fire: None,
        recent_decisions,
        consecutive_publish_failures: current.consecutive_publish_failures,
    }))
}

pub fn producer_started(
    current: &HistorianDurableState,
    producer_session_id: String,
    producer_run_id: String,
) -> Result<HistorianDurableState, HistorianStateError> {
    require_phase(current, HistorianPhase::Firing, "producer_started")?;
    let mut next = current.clone();
    next.state = HistorianPhase::AwaitingProducer;
    next.producer_session_id = Some(producer_session_id);
    next.producer_run_id = Some(producer_run_id);
    // A producer run is established: any failure detail or retry cooldown from a
    // prior firing is resolved.
    next.failure_backoff_at_ms = None;
    next.last_failure = None;
    Ok(next)
}

pub fn output_received(
    current: &HistorianDurableState,
    _output_text: &str,
) -> Result<HistorianDurableState, HistorianStateError> {
    require_phase(current, HistorianPhase::AwaitingProducer, "output_received")?;
    let mut next = current.clone();
    next.state = HistorianPhase::Validating;
    Ok(next)
}

pub fn validation_ok(
    current: &HistorianDurableState,
) -> Result<HistorianDurableState, HistorianStateError> {
    require_phase(current, HistorianPhase::Validating, "validation_ok")?;
    let mut next = current.clone();
    next.state = HistorianPhase::Publishing;
    Ok(next)
}

pub fn tx_committed(
    current: &HistorianDurableState,
) -> Result<HistorianDurableState, HistorianStateError> {
    require_phase(current, HistorianPhase::Publishing, "tx_committed")?;
    let mut next = idle_after_success(current);
    next.consecutive_publish_failures = 0;
    Ok(next)
}

pub fn tx_conflict(
    current: &HistorianDurableState,
    failure_backoff_at_ms: i64,
) -> Result<HistorianDurableState, HistorianStateError> {
    require_phase(current, HistorianPhase::Publishing, "tx_conflict")?;
    Ok(abandon(current, failure_backoff_at_ms))
}

/// Release the single-flight lease after any terminal/missing/expired producer,
/// validation rejection, or stale snapshot. The failed firing sequence is kept so
/// the next fire remains monotonic.
pub fn abandon(
    current: &HistorianDurableState,
    failure_backoff_at_ms: i64,
) -> HistorianDurableState {
    abandon_with_detail(current, failure_backoff_at_ms, None)
}

/// Abandon while recording WHY. The detail lands in durable state because the firing
/// runs in a spawned task whose stderr a supervised deployment never captures; without
/// this, a connect/bind failure is indistinguishable from any other in a state dump.
pub fn abandon_with_detail(
    current: &HistorianDurableState,
    failure_backoff_at_ms: i64,
    detail: Option<String>,
) -> HistorianDurableState {
    HistorianDurableState {
        state: HistorianPhase::Idle,
        firing_seq: current.firing_seq,
        failure_backoff_at_ms: Some(failure_backoff_at_ms),
        last_failure: detail.or_else(|| current.last_failure.clone()),
        recent_decisions: current.recent_decisions.clone(),
        consecutive_publish_failures: current.consecutive_publish_failures,
        ..HistorianDurableState::default()
    }
}

pub fn verify_chunk_fingerprint(expected: &str, observed: &str) -> Result<(), HistorianStateError> {
    if expected == observed {
        Ok(())
    } else {
        Err(HistorianStateError::FingerprintMismatch {
            expected: expected.to_string(),
            found: observed.to_string(),
        })
    }
}

pub fn publish_predicate(
    state: &HistorianDurableState,
) -> Result<HistorianPublishPredicate, HistorianStateError> {
    let Some(producer_run_id) = state.producer_run_id.clone() else {
        return Err(HistorianStateError::MissingProducerIds {
            firing_seq: state.firing_seq,
        });
    };
    Ok(HistorianPublishPredicate {
        firing_seq: state.firing_seq,
        producer_run_id,
        chunk_fingerprint: state.chunk_fingerprint.clone(),
        selected_range_identities: state.selected_range_identities.clone(),
        compartment_set_generation: state.compartment_set_generation,
    })
}

pub fn persist_historian_state(
    store: &McStore,
    session_id: &str,
    next_state: HistorianDurableState,
) -> Result<u64, HistorianStateError> {
    let loaded = store.load(session_id)?;
    let mut meta = loaded.meta.clone();
    meta.historian = next_state;
    if meta == loaded.meta {
        return Ok(loaded.row_version.unwrap_or(0));
    }
    Ok(store.commit(session_id, loaded.row_version, &loaded.core, &meta)?)
}

pub trait HistorianPublicationFence: Send + Sync {
    fn publish(
        &self,
        store: &McStore,
        request: HistorianPublishRequest<'_>,
    ) -> Result<HistorianPublishResult, HistorianPublishError>;
}

pub struct ValidatedPublishRequest<'a> {
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub expected_row_version: Option<u64>,
    pub expected_revert_epoch: u64,
    pub predicate: &'a HistorianPublishPredicate,
    pub observed_chunk_fingerprint: &'a str,
    pub validated: &'a ValidatedChunk,
    /// Facts are dropped when either memory.enabled or memory.auto_promote is off.
    pub promote_facts: bool,
    /// User observations are stored only when the privacy collection gate is enabled.
    pub collect_user_memory_candidates: bool,
    pub publication_floor_ordinal: u64,
    pub chunk_transcript: &'a str,
    /// Original CK messages for exact durable full-message and verbose recovery.
    pub raw_chunk_messages: &'a str,
    /// Creation timestamp stamped on the appended compartment rows.
    pub created_at_ms: i64,
    /// YYYY-MM-DD dates keyed by native message id; missing entries remain date-less.
    pub boundary_dates: &'a BTreeMap<String, String>,
    pub failure_backoff_at_ms: i64,
    pub publication_fence: Option<&'a dyn HistorianPublicationFence>,
}

/// Publish after re-checking the chunk fingerprint at the commit point. A mismatch
/// abandons the matching firing before returning the typed error, so a future fire
/// is not blocked by the stale producer.
///
/// The validation module owns the [`ValidatedChunk`] shape (message-id endpoints,
/// tiers, discard-last healing); this boundary projects it onto the durable store
/// rows and drives the CAS-gated publish transaction. Facts promote as additive
/// inserts, so a publish only surfaces on the next materializing pass via the
/// compartment/memory watermarks — it never mutates cached render state.
pub fn publish_validated_chunk(
    store: &McStore,
    request: ValidatedPublishRequest<'_>,
) -> Result<HistorianPublishResult, HistorianStateError> {
    if request.predicate.chunk_fingerprint != request.observed_chunk_fingerprint {
        abandon_matching_run_with_detail(
            store,
            request.session_id,
            request.predicate,
            request.failure_backoff_at_ms,
            None,
        )?;
        return Err(HistorianStateError::FingerprintMismatch {
            expected: request.predicate.chunk_fingerprint.clone(),
            found: request.observed_chunk_fingerprint.to_string(),
        });
    }

    let compartments: Vec<StoredCompartment> = request
        .validated
        .compartments
        .iter()
        .map(|c| to_stored_compartment(c, request.created_at_ms, request.boundary_dates))
        .collect();
    let facts: Vec<FactCandidate> = if request.promote_facts {
        request
            .validated
            .facts
            .iter()
            .map(|fact| to_store_fact(fact, request.session_id))
            .collect()
    } else {
        Vec::new()
    };
    let events: Vec<HistorianEventCandidate> = request
        .validated
        .events
        .iter()
        .map(|event| {
            to_store_event(
                event,
                &request.validated.compartments,
                request.created_at_ms,
            )
        })
        .collect();
    let primer_candidates: Vec<HistorianPrimerCandidate> = request
        .validated
        .primer_candidates
        .iter()
        .map(|candidate| {
            to_store_primer(
                candidate,
                request.session_id,
                request.project_path,
                &request.validated.compartments,
                request.created_at_ms,
            )
        })
        .collect();
    let user_memory_candidates: Vec<HistorianUserMemoryCandidate> =
        if request.collect_user_memory_candidates {
            request
                .validated
                .user_observations
                .iter()
                .map(|observation| {
                    to_store_user_observation(
                        observation,
                        request.session_id,
                        &request.validated.compartments,
                        request.created_at_ms,
                    )
                })
                .collect()
        } else {
            Vec::new()
        };

    let publish_request = HistorianPublishRequest {
        session_id: request.session_id,
        expected_row_version: request.expected_row_version,
        expected_revert_epoch: request.expected_revert_epoch,
        predicate: request.predicate,
        project_path: request.project_path,
        compartments: &compartments,
        facts: &facts,
        promote_facts: request.promote_facts,
        events: &events,
        primer_candidates: &primer_candidates,
        user_memory_candidates: &user_memory_candidates,
        publication_floor_ordinal: request.publication_floor_ordinal,
        chunk_transcript: Some(request.chunk_transcript),
        raw_chunk_messages: Some(request.raw_chunk_messages),
    };
    let publish_result = match request.publication_fence {
        Some(fence) => fence.publish(store, publish_request),
        None => store.publish_historian_chunk(publish_request),
    };
    match publish_result {
        Ok(result) => Ok(result),
        Err(HistorianPublishError::FenceRejected { reason }) => {
            // A fence rejection is a fast local race (the caller's snapshot was
            // retired mid-round), not a producer failure: return the run to Idle
            // with NO failure cooldown so an immediate retry on a fresh snapshot
            // is admitted instead of reading backoff_active for a minute.
            abandon_matching_run_without_cooldown(
                store,
                request.session_id,
                request.predicate,
                Some(format!("publish rejected: {reason}")),
            )?;
            Err(HistorianStateError::Publish(
                HistorianPublishError::FenceRejected { reason },
            ))
        }
        Err(error @ HistorianPublishError::CompartmentOverlap { .. }) => {
            // The storage backstop found an overlap after the optimistic fence. Treat it
            // like every other stale local race: make the matching firing immediately
            // idle so the caller never leaves a durable Publishing wedge behind.
            abandon_matching_run_without_cooldown(
                store,
                request.session_id,
                request.predicate,
                Some(format!("publish rejected: {error}")),
            )?;
            Err(HistorianStateError::Publish(error))
        }
        Err(HistorianPublishError::CasConflict {
            expected,
            found,
            reason,
        }) => {
            let detail = reason
                .clone()
                .map(|reason| format!("publish rejected: {reason}"))
                .or_else(|| Some("publish rejected: row-version CAS conflict".to_string()));
            abandon_matching_run_with_detail(
                store,
                request.session_id,
                request.predicate,
                request.failure_backoff_at_ms,
                detail,
            )?;
            Err(HistorianStateError::Publish(
                HistorianPublishError::CasConflict {
                    expected,
                    found,
                    reason,
                },
            ))
        }
        Err(err) => {
            // The publish error occurs after the producer has completed its work, so
            // leave the producer run available for the normal recovery path instead of
            // abandoning it. Record the failure so repeated publication errors remain visible.
            let _ = store.record_historian_publish_failure_if_matching(
                request.session_id,
                request.predicate,
            );
            Err(err.into())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartAction {
    Done,
    ReattachProducer {
        producer_session_id: String,
        producer_run_id: String,
        firing_seq: u64,
        chunk_fingerprint: String,
    },
    AbandonedAndRefireEligible {
        firing_seq: u64,
    },
}

/// Interpret durable state after process restart. If publish had committed before
/// the crash, the load observes idle and returns `Done`; if it still observes a
/// publishing row, the transaction did not commit, so the stale single-flight is
/// abandoned and a future trigger may refire when eligible.
pub fn handle_restart_load(
    store: &McStore,
    session_id: &str,
    failure_backoff_at_ms: i64,
) -> Result<RestartAction, HistorianStateError> {
    let loaded = store.load(session_id)?;
    let state = loaded.meta.historian.clone();
    match state.state {
        HistorianPhase::Idle => Ok(RestartAction::Done),
        HistorianPhase::AwaitingProducer => {
            let (Some(producer_session_id), Some(producer_run_id)) = (
                state.producer_session_id.clone(),
                state.producer_run_id.clone(),
            ) else {
                let next = abandon(&state, failure_backoff_at_ms);
                persist_historian_state(store, session_id, next)?;
                return Ok(RestartAction::AbandonedAndRefireEligible {
                    firing_seq: state.firing_seq,
                });
            };
            Ok(RestartAction::ReattachProducer {
                producer_session_id,
                producer_run_id,
                firing_seq: state.firing_seq,
                chunk_fingerprint: state.chunk_fingerprint,
            })
        }
        HistorianPhase::Firing | HistorianPhase::Validating | HistorianPhase::Publishing => {
            let firing_seq = state.firing_seq;
            let next = abandon(&state, failure_backoff_at_ms);
            persist_historian_state(store, session_id, next)?;
            Ok(RestartAction::AbandonedAndRefireEligible { firing_seq })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianRunSuccess {
    pub row_version: u64,
    pub producer_session_id: String,
    pub producer_run_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianDriveOutcome {
    Completed(HistorianRunSuccess),
    Busy(HistorianDurableState),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianReattachOutcome {
    Done,
    Published(HistorianRunSuccess),
    RefireEligible { firing_seq: u64 },
}

#[derive(Debug)]
pub enum HistorianDriveError {
    NoModels,
    State(HistorianStateError),
    Producer(HistorianProducerError),
    ProducerConnect {
        source: Box<HistorianProducerError>,
        backoff_error: Option<Box<McStoreError>>,
    },
    Validation(HistorianValidationError),
}

impl fmt::Display for HistorianDriveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistorianDriveError::NoModels => write!(f, "historian model chain is empty"),
            HistorianDriveError::State(e) => write!(f, "state: {e}"),
            HistorianDriveError::Producer(e) => write!(f, "producer: {e}"),
            HistorianDriveError::ProducerConnect {
                source,
                backoff_error: Some(error),
            } => write!(
                f,
                "producer connect: {source}; durable backoff could not be recorded: {error}"
            ),
            HistorianDriveError::ProducerConnect {
                source,
                backoff_error: None,
            } => write!(f, "producer connect: {source}"),
            HistorianDriveError::Validation(e) => write!(f, "validation: {e}"),
        }
    }
}

impl std::error::Error for HistorianDriveError {}

impl From<HistorianStateError> for HistorianDriveError {
    fn from(e: HistorianStateError) -> Self {
        HistorianDriveError::State(e)
    }
}

impl From<HistorianProducerError> for HistorianDriveError {
    fn from(e: HistorianProducerError) -> Self {
        HistorianDriveError::Producer(e)
    }
}

impl From<HistorianValidationError> for HistorianDriveError {
    fn from(e: HistorianValidationError) -> Self {
        HistorianDriveError::Validation(e)
    }
}

impl From<McStoreError> for HistorianDriveError {
    fn from(e: McStoreError) -> Self {
        HistorianDriveError::State(HistorianStateError::Store(e))
    }
}

#[subc_client_rs::async_trait]
pub trait HistorianProducerDriver: Send {
    async fn bind_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError>;
    async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError>;
    async fn start_with_temperature(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        _temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start(session_id, system, prompt, model).await
    }
    async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        _max_output_tokens: u32,
        _temperature: f64,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start(session_id, system, prompt, model).await
    }
    async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError>;
    async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        _timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.await_output(run_id).await
    }
    async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.await_output(run_id).await
    }
    async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        _timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.redrain_output(run_id).await
    }
    async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError>;
    async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError>;
    async fn close(&mut self);
    /// Delete the provider session on every terminal path. The default calls close()
    /// for compatibility with older test producers, while production producers override
    /// this method to explicitly delete session data before closing.
    async fn purge_session(&mut self, _session_id: &str) {
        self.close().await;
    }
}

#[subc_client_rs::async_trait]
impl HistorianProducerDriver for HistorianProducer {
    async fn bind_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        HistorianProducer::bind_session(self, session_id.to_string());
        Ok(())
    }

    async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        HistorianProducer::start(self, session_id, system, prompt, model).await
    }

    async fn start_with_temperature(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        HistorianProducer::start_with_temperature(
            self,
            session_id,
            system,
            prompt,
            model,
            temperature,
        )
        .await
    }

    async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        max_output_tokens: u32,
        temperature: f64,
    ) -> Result<RunHandle, HistorianProducerError> {
        HistorianProducer::start_with_generation(
            self,
            session_id,
            system,
            prompt,
            model,
            max_output_tokens,
            Some(temperature),
        )
        .await
    }

    async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        HistorianProducer::await_output(self, run_id).await
    }

    async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        HistorianProducer::redrain_output(self, run_id).await
    }

    async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        HistorianProducer::await_output_with_timeout(self, run_id, timeout).await
    }

    async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        HistorianProducer::redrain_output_with_timeout(self, run_id, timeout).await
    }

    async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        HistorianProducer::status(self, run_id).await
    }

    async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
        HistorianProducer::cancel(self, run_id).await
    }

    async fn close(&mut self) {
        HistorianProducer::close(self).await;
    }

    async fn purge_session(&mut self, session_id: &str) {
        if HistorianProducer::purge_session(self, session_id)
            .await
            .is_err()
        {
            HistorianProducer::close(self).await;
        }
    }
}

pub struct HistorianFireRequest<'a> {
    pub store: &'a McStore,
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub project_slug: &'a str,
    /// The role-scoped historian SYSTEM prompt (HISTORIAN_SYSTEM_PROMPT). Sent via the
    /// producer's `system` field, never concatenated into `prompt`. Empty means absent.
    pub system: Cow<'a, str>,
    /// Trusted language setting for retry-only repair guidance. It never reaches transform
    /// composition or the primary prompt surface.
    pub content_language: Option<&'a str>,
    pub prompt: &'a str,
    pub model_chain: &'a [String],
    pub temperature: Option<f64>,
    pub producer_source_tokens: usize,
    pub historian_context_limit_tokens: Option<usize>,
    pub max_output_tokens: u32,
    pub from_ordinal: u64,
    pub to_ordinal: u64,
    pub chunk_fingerprint: &'a str,
    pub selected_range_identities: Vec<HistorianSelectedMessageIdentity>,
    pub expected_revert_epoch: u64,
    pub compartment_set_generation: CompartmentSetGeneration,
    pub observed_chunk_fingerprint: &'a str,
    pub validation_chunk: &'a HistorianChunk,
    pub chunk_transcript: &'a str,
    pub raw_chunk_messages: &'a str,
    /// Message boundary dates captured with the native ingress messages.
    pub boundary_dates: &'a BTreeMap<String, String>,
    pub prior_compartments: &'a [StoredCompartmentRange],
    pub validate_options: ValidateOptions,
    pub now_ms: i64,
    pub failure_backoff_at_ms: i64,
    pub recent_decision: Option<HistorianRecentDecision>,
    pub completion_now_ms: fn() -> i64,
    pub publication_fence: Option<&'a dyn HistorianPublicationFence>,
}

pub struct HistorianReattachRequest<'a> {
    pub store: &'a McStore,
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub observed_chunk_fingerprint: &'a str,
    pub validation_chunk: &'a HistorianChunk,
    pub chunk_transcript: &'a str,
    pub raw_chunk_messages: &'a str,
    /// Message boundary dates captured with the native ingress messages.
    pub boundary_dates: &'a BTreeMap<String, String>,
    pub prior_compartments: &'a [StoredCompartmentRange],
    pub validate_options: ValidateOptions,
    pub publication_floor_ordinal: u64,
    pub now_ms: i64,
    pub failure_backoff_at_ms: i64,
    pub completion_now_ms: fn() -> i64,
    pub publication_fence: Option<&'a dyn HistorianPublicationFence>,
}

/// Session-id prefix for the module's own producer (child) sessions. The transform
/// handler treats any session in this namespace as self-owned and passes it through
/// untouched: routing a producer request back through the module's own transform
/// prepends the m0/m1 framing ahead of the historian system prompt, restructuring the
/// calibrated [system, user] request into one the model was never tuned on (observed
/// live as template-echo and seed-regurgitation on the calibration model itself).
pub const MC_CHILD_SESSION_PREFIX: &str = "mc-historian:";

/// Wait budget for a full historian run plus its one short timeout recovery re-drain.
pub fn completion_wait_budget() -> Duration {
    Duration::from_secs(660)
}

/// The per-attempt deadline a consumer sets, VERBATIM, for `session.wrapup` calls —
/// margin included, no consumer-side arithmetic on top (the module owns the margin,
/// mirroring `MAX_EMERGENCY_REQUEST_BUDGET`). The producer loop has NO round-count
/// cap: it drains chunks until the keep watermark is reached or this budget expires,
/// so the budget itself — not a chunk count — is the ceiling (the TypeScript wrapup
/// drain has the same uncapped-until-target shape). Derivation: one busy-join at
/// entry (bounded by [`completion_wait_budget`], 660s) plus producer rounds each
/// bounded by [`wrapup_round_wait_budget`] (600s); the loop re-checks the remaining
/// budget before every round, so the wall time is one join plus as many rounds as
/// fit under the budget. Sized for a large multi-chunk drain with margin. Bump this
/// in the same commit as any change to those inputs and notify consumers.
pub const MAX_WRAPUP_REQUEST_BUDGET: Duration = Duration::from_secs(3_800);

/// Per-round wrapup wait bound. A timed-out producer keeps running under the normal
/// historian guard so durable recovery remains identical to an incremental firing.
pub fn wrapup_round_wait_budget() -> Duration {
    Duration::from_secs(600)
}

/// The transform-call deadline a consumer sets, VERBATIM, for requests to this module —
/// margin included, no consumer-side arithmetic on top (adding local margin would
/// double-count and drift the number per consumer; this module owns the margin).
///
/// Derivation: a ≥95% (Emergency95) request may legitimately block until compaction
/// lands, and its worst case nests both emergency arms sequentially — busy-await of an
/// active run (one `completion_wait_budget`, 660s) followed by an inline refire (a
/// second 660s) plus transform re-runs — ≈ 1350s, rounded up with margin. A consumer
/// deadline below this false-trips on legitimate work and forwards a RAW array at the
/// exact pressure where raw risks provider context-overflow; a trip at THIS value means
/// the module violated its own per-arm bounds (a bug), making forward-raw-and-discard
/// the least-bad recovery. If per-arm semantics grow, bump this constant and re-sync
/// the consumers.
pub const MAX_EMERGENCY_REQUEST_BUDGET: Duration = Duration::from_secs(1500);

/// The transform-call deadline a consumer sets, VERBATIM, for every request whose fill
/// signal is BELOW the emergency band (or unknown). Same no-consumer-arithmetic rule as
/// `MAX_EMERGENCY_REQUEST_BUDGET`.
///
/// Derivation: below `scheduler::EMERGENCY_PERCENTAGE` a transform request NEVER blocks
/// on historian model work — a fire spawns in the background (`spawn_historian_firing`)
/// and the request path does classification, compose, and store I/O only. The measured
/// request-path work is sub-second; the budget covers worst-case SQLite busy storms and
/// scheduler stalls with wide margin. A hang past this value is a wedge, and failing
/// open to the raw array is cheap at sub-emergency fill. Deliberately NOT tiered on the
/// execute threshold: execute-band passes do more local work than defers but still no
/// model work, so one non-emergency bound covers both and stays immune to
/// `execute_threshold_percentage` retunes.
pub const MAX_NONEMERGENCY_REQUEST_BUDGET: Duration = Duration::from_secs(120);

/// Build the llm-runner session id owned by Magic Context for one historian firing.
/// The firing sequence is part of the id so a fallback model attempt never resumes a
/// failed run under a different model.
///
/// The id must be unique per (lineage, firing), not per (project, firing): multiple
/// lineages under one project — a parent conversation plus concurrent subagent
/// lineages under composite keys — fold concurrently in normal operation, and their
/// firing sequences advance independently. A project-scoped id lets two lineages at
/// the same sequence share one producer session, crossing their terminal-run
/// tracking (expected run-id from one lineage, found run-id from the other) and
/// losing the commit. A stable hash of the bound session key disambiguates without
/// leaking composite-key bytes (which may carry non-slug-safe delimiters) into the
/// id, and keeps the `mc-historian:` prefix the self-exemption matches on.
pub fn historian_producer_session_id(
    project_slug: &str,
    session_id: &str,
    firing_seq: u64,
) -> String {
    let slug: String = project_slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "project" } else { slug };
    let lineage = fnv1a_hex16(session_id);
    format!("mc-historian:{slug}:{lineage}:{firing_seq}")
}

/// FNV-1a 64-bit rendered in full so producer sessions retain the hash's
/// collision resistance across adversarially chosen lineage keys.
fn fnv1a_hex16(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProducerFailureDecision {
    try_next_model: bool,
    failure_backoff_at_ms: i64,
    detail_prefix: Option<&'static str>,
}

fn decide_producer_failure(
    err: &HistorianProducerError,
    model: &str,
    remaining_models: &[String],
    auth_blocked_providers: &mut Vec<String>,
    all_failures_permanent: &mut bool,
    now_ms: i64,
    default_failure_backoff_at_ms: i64,
) -> ProducerFailureDecision {
    if let Some(classification) = err.classification() {
        // The producer owns classification. Once a class tag is present, the consumer
        // branches only on that field and its structured retry-after sibling; provider
        // codes/messages stay diagnostic detail and never override the tag.
        return match classification.class {
            ErrorClass::Permanent => {
                let try_next = has_eligible_model(remaining_models, auth_blocked_providers);
                ProducerFailureDecision {
                    try_next_model: try_next,
                    failure_backoff_at_ms: default_failure_backoff_at_ms,
                    detail_prefix: (!try_next && *all_failures_permanent)
                        .then_some(CHAIN_EXHAUSTED_PERMANENT_PREFIX),
                }
            }
            ErrorClass::Transient => {
                *all_failures_permanent = false;
                let try_next = has_eligible_model(remaining_models, auth_blocked_providers);
                ProducerFailureDecision {
                    try_next_model: try_next,
                    failure_backoff_at_ms: if try_next {
                        default_failure_backoff_at_ms
                    } else {
                        classified_backoff_at_ms(
                            now_ms,
                            default_failure_backoff_at_ms,
                            classification,
                        )
                    },
                    detail_prefix: None,
                }
            }
            ErrorClass::AuthRequired => {
                *all_failures_permanent = false;
                add_auth_blocked_provider(auth_blocked_providers, provider_prefix(model));
                let try_next = has_eligible_model(remaining_models, auth_blocked_providers);
                ProducerFailureDecision {
                    try_next_model: try_next,
                    failure_backoff_at_ms: default_failure_backoff_at_ms,
                    detail_prefix: (!try_next).then_some(AUTH_REQUIRED_PREFIX),
                }
            }
            ErrorClass::ContextOverflow => {
                *all_failures_permanent = false;
                // Historian chunks are sized below every configured model window; a
                // source-classified overflow means our estimator is wrong. Trying a
                // larger fallback would mask the bad budget and hide the health signal.
                ProducerFailureDecision {
                    try_next_model: false,
                    failure_backoff_at_ms: default_failure_backoff_at_ms,
                    detail_prefix: None,
                }
            }
        };
    }

    if err.has_class_field() {
        *all_failures_permanent = false;
        return ProducerFailureDecision {
            try_next_model: false,
            failure_backoff_at_ms: default_failure_backoff_at_ms,
            detail_prefix: Some(UNKNOWN_ERROR_CLASS_PREFIX),
        };
    }

    *all_failures_permanent = false;
    let heuristic = err.deprecated_heuristic_decision();
    let try_next = heuristic.retryable_model_failure
        && !heuristic.abort_or_overflow
        && has_eligible_model(remaining_models, auth_blocked_providers);
    ProducerFailureDecision {
        try_next_model: try_next,
        failure_backoff_at_ms: default_failure_backoff_at_ms,
        detail_prefix: None,
    }
}

pub(crate) fn completion_failure_backoff_at_ms(
    started_at_ms: i64,
    configured_backoff_at_ms: i64,
    completed_at_ms: i64,
) -> i64 {
    let cooldown_ms = configured_backoff_at_ms
        .saturating_sub(started_at_ms)
        .max(0);
    completed_at_ms.saturating_add(cooldown_ms)
}

fn abandon_chain_failure(
    current: &HistorianDurableState,
    error: &HistorianProducerError,
    decision: ProducerFailureDecision,
    earliest_reset_ms: Option<i64>,
    detail: Option<String>,
) -> HistorianDurableState {
    let mut next = abandon_with_detail(current, decision.failure_backoff_at_ms, detail);
    let refused = matches!(
        error.classification().map(|value| value.class),
        Some(ErrorClass::Transient | ErrorClass::Permanent | ErrorClass::AuthRequired)
    ) || (!error.has_class_field() && error.is_retryable_model_failure());
    if !decision.try_next_model && refused {
        record_chain_outage(&mut next, earliest_reset_ms);
    }
    next
}

fn record_chain_outage(next: &mut HistorianDurableState, earliest_reset_ms: Option<i64>) {
    let reset = earliest_reset_ms
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| "unknown".into());
    let outage = format!("chain_exhausted earliest_provider_reset={reset} retry=probe; serving retained context and reductions");
    next.last_failure = Some(format!(
        "{}; {outage}",
        next.last_failure.as_deref().unwrap_or("")
    ));
    next.last_no_fire = Some(outage);
}

fn classified_backoff_at_ms(
    now_ms: i64,
    default_failure_backoff_at_ms: i64,
    classification: ErrorClassification,
) -> i64 {
    let Some(retry_after_secs) = classification.retry_after_secs else {
        return default_failure_backoff_at_ms;
    };
    let retry_after_ms = retry_after_secs.saturating_mul(1000).min(i64::MAX as u64) as i64;
    now_ms.saturating_add(HISTORIAN_FAILURE_BACKOFF_MS.max(retry_after_ms))
}

fn has_eligible_model(models: &[String], auth_blocked_providers: &[String]) -> bool {
    models
        .iter()
        .any(|model| !provider_is_auth_blocked(auth_blocked_providers, model))
}

fn provider_is_auth_blocked(auth_blocked_providers: &[String], model: &str) -> bool {
    let provider = provider_prefix(model);
    auth_blocked_providers
        .iter()
        .any(|blocked| blocked == provider)
}

fn add_auth_blocked_provider(auth_blocked_providers: &mut Vec<String>, provider: &str) {
    if !auth_blocked_providers
        .iter()
        .any(|blocked| blocked == provider)
    {
        auth_blocked_providers.push(provider.to_string());
    }
}

fn provider_prefix(model: &str) -> &str {
    model
        .split_once('/')
        .map_or(model, |(provider, _)| provider)
}

fn prefixed_detail(prefix: Option<&str>, detail: String) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}{detail}"),
        None => detail,
    }
}

pub(crate) fn model_unresolvable_detail(
    failures: &[(String, String)],
    chain_exhausted: bool,
) -> String {
    let reasons = failures
        .iter()
        .map(|(model, reason)| format!("model_unresolvable:{model}: {reason}"))
        .collect::<Vec<_>>()
        .join("; ");
    if chain_exhausted {
        format!("{MODEL_UNRESOLVABLE_CHAIN_EXHAUSTED_PREFIX}{reasons}")
    } else {
        reasons
    }
}

fn detail_with_model_unresolvable(
    failures: &[(String, String)],
    detail_prefix: Option<&str>,
    detail: String,
) -> String {
    let detail = prefixed_detail(detail_prefix, detail);
    if failures.is_empty() {
        detail
    } else {
        format!("{}; {detail}", model_unresolvable_detail(failures, false))
    }
}

fn remaining_uncached_models(
    models: &[String],
    cache: Option<&HistorianModelUnresolvableCache>,
    generation: u64,
) -> Vec<String> {
    models
        .iter()
        .filter(|model| {
            cache
                .and_then(|cache| cache.cached_reason(generation, model))
                .is_none()
        })
        .cloned()
        .collect()
}

fn abandon_model_unresolvable(
    current: &HistorianDurableState,
    detail: String,
    earliest_reset_ms: Option<i64>,
) -> HistorianDurableState {
    let mut next = abandon_with_detail(current, 0, Some(detail));
    next.failure_backoff_at_ms = earliest_reset_ms;
    if next
        .last_failure
        .as_deref()
        .is_some_and(|detail| detail.contains("chain_exhausted"))
    {
        record_chain_outage(&mut next, earliest_reset_ms);
    }
    next
}

fn persist_idle_model_unresolvable_detail(
    store: &McStore,
    session_id: &str,
    expected_firing_seq: Option<u64>,
    detail: String,
) -> Result<u64, HistorianStateError> {
    for attempt in 0..3 {
        let loaded = store.load(session_id)?;
        if loaded.meta.historian.state != HistorianPhase::Idle
            || expected_firing_seq
                .is_some_and(|expected| loaded.meta.historian.firing_seq != expected)
        {
            return Ok(loaded.row_version.unwrap_or(0));
        }
        let mut meta = loaded.meta.clone();
        meta.historian.last_failure = Some(detail.clone());
        meta.historian.last_no_fire = None;
        meta.historian.failure_backoff_at_ms = None;
        match store.commit(session_id, loaded.row_version, &loaded.core, &meta) {
            Ok(row_version) => return Ok(row_version),
            Err(McStoreError::CasConflict { .. }) if attempt < 2 => continue,
            Err(error) => return Err(HistorianStateError::Store(error)),
        }
    }
    unreachable!("the model-unresolvable CAS loop returns from every attempt")
}

pub(crate) const PRODUCER_WINDOW_REFUSAL_MARGIN_PERCENT: usize = 15;

pub(crate) fn producer_window_failure_reason(
    producer_source_tokens: usize,
    context_limit_tokens: Option<usize>,
    max_output_tokens: u32,
) -> Option<String> {
    let context_limit_tokens = context_limit_tokens?;
    if producer_source_tokens == 0 {
        return None;
    }
    let usable_input_tokens = context_limit_tokens.saturating_sub(max_output_tokens as usize);
    let source_scaled = (producer_source_tokens as u128).saturating_mul(100);
    let refusal_scaled = (usable_input_tokens as u128)
        .saturating_mul((100 + PRODUCER_WINDOW_REFUSAL_MARGIN_PERCENT) as u128);
    if source_scaled < refusal_scaled {
        return None;
    }
    Some(format!(
        "producer_source_exceeds_window producer_source_tokens={producer_source_tokens} usable_input_tokens={usable_input_tokens} context_limit_tokens={context_limit_tokens} max_output_tokens={max_output_tokens} refusal_margin=0.15"
    ))
}

pub async fn run_historian_firing<P>(
    producer: &mut P,
    request: HistorianFireRequest<'_>,
) -> Result<HistorianDriveOutcome, HistorianDriveError>
where
    P: HistorianProducerDriver + ?Sized,
{
    run_historian_firing_with_model_cache(producer, request, None, 0).await
}

pub(crate) async fn run_historian_firing_with_model_cache<P>(
    producer: &mut P,
    request: HistorianFireRequest<'_>,
    model_unresolvable_cache: Option<&HistorianModelUnresolvableCache>,
    model_chain_generation: u64,
) -> Result<HistorianDriveOutcome, HistorianDriveError>
where
    P: HistorianProducerDriver + ?Sized,
{
    if request.model_chain.is_empty() {
        return Err(HistorianDriveError::NoModels);
    }
    if let Some(reason) = producer_window_failure_reason(
        request.producer_source_tokens,
        request.historian_context_limit_tokens,
        request.max_output_tokens,
    ) {
        let loaded = request.store.load(request.session_id)?;
        let mut meta = loaded.meta.clone();
        meta.historian.last_failure = Some(reason.clone());
        meta.historian.failure_backoff_at_ms = Some(request.failure_backoff_at_ms);
        request
            .store
            .commit(request.session_id, loaded.row_version, &loaded.core, &meta)?;
        eprintln!(
            "[mc-module][{}] historian oversize admission refused before spawn: {reason}",
            request.session_id
        );
        return Err(HistorianDriveError::Producer(
            HistorianProducerError::context_overflow(reason),
        ));
    }

    let mut auth_blocked_providers = Vec::new();
    let mut all_failures_permanent = true;
    let mut earliest_provider_reset_ms: Option<i64> = None;
    let mut model_unresolvable_failures = Vec::new();
    let mut prompt = request.prompt.to_string();

    for (index, model) in request.model_chain.iter().enumerate() {
        if provider_is_auth_blocked(&auth_blocked_providers, model) {
            continue;
        }
        if let Some(reason) = model_unresolvable_cache
            .and_then(|cache| cache.cached_reason(model_chain_generation, model))
        {
            model_unresolvable_failures.push((model.clone(), reason));
            continue;
        }
        verify_chunk_fingerprint(
            request.chunk_fingerprint,
            request.observed_chunk_fingerprint,
        )?;
        let loaded = request.store.load(request.session_id)?;
        let mut recent_decision = request.recent_decision.clone();
        if let Some(decision) = recent_decision.as_mut() {
            decision.producer_model = Some(model.clone());
        }
        let mut fired = match fire(
            &loaded.meta.historian,
            request.from_ordinal,
            request.to_ordinal,
            request.chunk_fingerprint.to_string(),
            request.selected_range_identities.clone(),
            request.expected_revert_epoch,
            request.compartment_set_generation,
            request.now_ms,
            recent_decision,
        )? {
            FireOutcome::Busy(state) => return Ok(HistorianDriveOutcome::Busy(state)),
            FireOutcome::Fired(state) => state,
        };
        if !model_unresolvable_failures.is_empty() {
            fired.last_failure = Some(model_unresolvable_detail(
                &model_unresolvable_failures,
                false,
            ));
            fired.failure_backoff_at_ms = None;
        }
        persist_historian_state(request.store, request.session_id, fired.clone())?;

        let producer_session_id = historian_producer_session_id(
            request.project_slug,
            request.session_id,
            fired.firing_seq,
        );
        let handle = match producer
            .start_with_temperature(
                &producer_session_id,
                request.system.as_ref(),
                &prompt,
                model,
                request.temperature,
            )
            .await
        {
            Ok(handle) => handle,
            Err(err) => {
                if let Some(body) = err.model_unresolvable_open_body() {
                    let reason = format!("{}: {}", body.code, body.message);
                    model_unresolvable_failures.push((model.clone(), reason.clone()));
                    if model_unresolvable_cache
                        .is_some_and(|cache| cache.record(model_chain_generation, model, &reason))
                    {
                        eprintln!(
                            "[mc-module] historian model unresolvable for generation {}: {model}: {reason}",
                            model_chain_generation
                        );
                    }
                    let remaining = remaining_uncached_models(
                        &request.model_chain[index + 1..],
                        model_unresolvable_cache,
                        model_chain_generation,
                    );
                    let exhausted = !has_eligible_model(&remaining, &auth_blocked_providers);
                    persist_historian_state(
                        request.store,
                        request.session_id,
                        abandon_model_unresolvable(
                            &fired,
                            model_unresolvable_detail(&model_unresolvable_failures, exhausted),
                            earliest_provider_reset_ms,
                        ),
                    )?;
                    producer.close().await;
                    if !exhausted {
                        continue;
                    }
                    return Err(HistorianDriveError::Producer(err));
                }

                let completed_at_ms = (request.completion_now_ms)();
                let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                    request.now_ms,
                    request.failure_backoff_at_ms,
                    completed_at_ms,
                );
                let remaining = remaining_uncached_models(
                    &request.model_chain[index + 1..],
                    model_unresolvable_cache,
                    model_chain_generation,
                );
                let mut decision = decide_producer_failure(
                    &err,
                    model,
                    &remaining,
                    &mut auth_blocked_providers,
                    &mut all_failures_permanent,
                    completed_at_ms,
                    failure_backoff_at_ms,
                );
                if let Some(reset) = err.provider_retry_at_ms(completed_at_ms) {
                    earliest_provider_reset_ms =
                        Some(earliest_provider_reset_ms.map_or(reset, |prior| prior.min(reset)));
                }
                if !decision.try_next_model {
                    if let Some(reset) =
                        earliest_provider_reset_ms.filter(|reset| *reset > completed_at_ms)
                    {
                        decision.failure_backoff_at_ms = reset;
                    }
                }
                persist_historian_state(
                    request.store,
                    request.session_id,
                    abandon_chain_failure(
                        &fired,
                        &err,
                        decision,
                        earliest_provider_reset_ms,
                        Some(detail_with_model_unresolvable(
                            &model_unresolvable_failures,
                            decision.detail_prefix,
                            format!("producer start ({model}): {err:?}"),
                        )),
                    ),
                )?;
                producer.close().await;
                if decision.try_next_model {
                    continue;
                }
                return Err(HistorianDriveError::Producer(err));
            }
        };

        let awaiting =
            producer_started(&fired, producer_session_id.clone(), handle.run_id.clone())?;
        persist_historian_state(request.store, request.session_id, awaiting.clone())?;

        let output = match producer.await_output(&handle.run_id).await {
            Ok(output) => output,
            Err(HistorianProducerError::TimedOut) => {
                match producer.redrain_output(&handle.run_id).await {
                    Ok(output) => output,
                    Err(recovery_err) => {
                        let _ = producer.cancel(&handle.run_id).await;
                        let detail = detail_with_model_unresolvable(
                            &model_unresolvable_failures,
                            None,
                            format!(
                                "producer output ({model}): timed out; recovery re-drain also failed: {recovery_err}"
                            ),
                        );
                        let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                            request.now_ms,
                            request.failure_backoff_at_ms,
                            (request.completion_now_ms)(),
                        );
                        persist_historian_state(
                            request.store,
                            request.session_id,
                            abandon_with_detail(&awaiting, failure_backoff_at_ms, Some(detail)),
                        )?;
                        producer.close().await;
                        return Err(HistorianDriveError::Producer(recovery_err));
                    }
                }
            }
            Err(err) => {
                let _ = producer.cancel(&handle.run_id).await;
                let completed_at_ms = (request.completion_now_ms)();
                let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                    request.now_ms,
                    request.failure_backoff_at_ms,
                    completed_at_ms,
                );
                let remaining = remaining_uncached_models(
                    &request.model_chain[index + 1..],
                    model_unresolvable_cache,
                    model_chain_generation,
                );
                let mut decision = decide_producer_failure(
                    &err,
                    model,
                    &remaining,
                    &mut auth_blocked_providers,
                    &mut all_failures_permanent,
                    completed_at_ms,
                    failure_backoff_at_ms,
                );
                if let Some(reset) = err.provider_retry_at_ms(completed_at_ms) {
                    earliest_provider_reset_ms =
                        Some(earliest_provider_reset_ms.map_or(reset, |prior| prior.min(reset)));
                }
                if !decision.try_next_model {
                    if let Some(reset) =
                        earliest_provider_reset_ms.filter(|reset| *reset > completed_at_ms)
                    {
                        decision.failure_backoff_at_ms = reset;
                    }
                }
                persist_historian_state(
                    request.store,
                    request.session_id,
                    abandon_chain_failure(
                        &awaiting,
                        &err,
                        decision,
                        earliest_provider_reset_ms,
                        Some(detail_with_model_unresolvable(
                            &model_unresolvable_failures,
                            decision.detail_prefix,
                            format!("producer output ({model}): {err:?}"),
                        )),
                    ),
                )?;
                producer.close().await;
                if decision.try_next_model {
                    continue;
                }
                return Err(HistorianDriveError::Producer(err));
            }
        };

        // Always release both routes, whether publish succeeds or the validate/publish
        // path errors out — an early `?` return here would leak the command + subscribe
        // routes for this firing on the shared consumer connection.
        let publish_result = publish_output_from_awaiting(PublishOutputRequest {
            store: request.store,
            session_id: request.session_id,
            project_path: request.project_path,
            awaiting,
            output: output.clone(),
            observed_chunk_fingerprint: request.observed_chunk_fingerprint,
            validation_chunk: request.validation_chunk,
            chunk_transcript: request.chunk_transcript,
            raw_chunk_messages: request.raw_chunk_messages,
            boundary_dates: request.boundary_dates,
            prior_compartments: request.prior_compartments,
            validate_options: request.validate_options,
            created_at_ms: request.now_ms,
            failure_started_at_ms: request.now_ms,
            failure_backoff_at_ms: request.failure_backoff_at_ms,
            completion_now_ms: request.completion_now_ms,
            publication_fence: request.publication_fence,
        });
        producer.close().await;
        let row_version = match publish_result {
            Ok(row_version) => row_version,
            Err(HistorianDriveError::Validation(err)) => {
                // Validation rejection is model-local output failure. Exhaust the
                // configured fallback chain before returning the final rejection.
                let remaining = remaining_uncached_models(
                    &request.model_chain[index + 1..],
                    model_unresolvable_cache,
                    model_chain_generation,
                );
                if has_eligible_model(&remaining, &auth_blocked_providers) {
                    prompt = crate::historian_prompt::build_historian_repair_prompt(
                        request.prompt,
                        &output.text,
                        &err.to_string(),
                        request.content_language,
                    );
                    continue;
                }
                return Err(HistorianDriveError::Validation(err));
            }
            Err(err) => return Err(err),
        };
        let row_version = if model_unresolvable_failures.is_empty() {
            row_version
        } else {
            persist_idle_model_unresolvable_detail(
                request.store,
                request.session_id,
                Some(fired.firing_seq),
                format!(
                    "{MODEL_UNRESOLVABLE_PUBLISHED_PREFIX}{}",
                    model_unresolvable_detail(&model_unresolvable_failures, false)
                ),
            )?
        };
        return Ok(HistorianDriveOutcome::Completed(HistorianRunSuccess {
            row_version,
            producer_session_id,
            producer_run_id: handle.run_id,
            model: model.clone(),
        }));
    }

    let detail = model_unresolvable_detail(&model_unresolvable_failures, true);
    persist_idle_model_unresolvable_detail(
        request.store,
        request.session_id,
        None,
        detail.clone(),
    )?;
    Err(HistorianDriveError::Producer(HistorianProducerError::Subc(
        ProducerErrorBody::untagged("model_unresolvable", detail),
    )))
}

pub async fn reattach_historian_producer<P>(
    producer: &mut P,
    request: HistorianReattachRequest<'_>,
) -> Result<HistorianReattachOutcome, HistorianDriveError>
where
    P: HistorianProducerDriver + ?Sized,
{
    let action = handle_restart_load(
        request.store,
        request.session_id,
        request.failure_backoff_at_ms,
    )?;
    let RestartAction::ReattachProducer {
        producer_session_id,
        producer_run_id,
        firing_seq,
        ..
    } = action
    else {
        return Ok(match action {
            RestartAction::Done => HistorianReattachOutcome::Done,
            RestartAction::AbandonedAndRefireEligible { firing_seq } => {
                HistorianReattachOutcome::RefireEligible { firing_seq }
            }
            RestartAction::ReattachProducer { .. } => unreachable!(),
        });
    };

    producer.bind_session(&producer_session_id).await?;
    let state = match producer.status(&producer_run_id).await {
        Ok(state) => state,
        Err(_) => {
            let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                request.now_ms,
                request.failure_backoff_at_ms,
                (request.completion_now_ms)(),
            );
            abandon_current_state(request.store, request.session_id, failure_backoff_at_ms)?;
            producer.close().await;
            return Ok(HistorianReattachOutcome::RefireEligible { firing_seq });
        }
    };

    match state {
        RunState::Terminal | RunState::Active => {}
        RunState::Missing { .. } => {
            let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                request.now_ms,
                request.failure_backoff_at_ms,
                (request.completion_now_ms)(),
            );
            abandon_current_state(request.store, request.session_id, failure_backoff_at_ms)?;
            producer.close().await;
            return Ok(HistorianReattachOutcome::RefireEligible { firing_seq });
        }
    }

    let loaded = request.store.load(request.session_id)?;
    let awaiting = loaded.meta.historian.clone();
    let output = match producer.await_output(&producer_run_id).await {
        Ok(output) => output,
        Err(err) => {
            let _ = producer.cancel(&producer_run_id).await;
            let detail_prefix = match err
                .classification()
                .map(|classification| classification.class)
            {
                Some(ErrorClass::AuthRequired) => Some(AUTH_REQUIRED_PREFIX),
                _ if err.has_class_field() && err.classification().is_none() => {
                    Some(UNKNOWN_ERROR_CLASS_PREFIX)
                }
                _ => None,
            };
            let completed_at_ms = (request.completion_now_ms)();
            let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                request.now_ms,
                request.failure_backoff_at_ms,
                completed_at_ms,
            );
            let backoff_at_ms =
                err.classification()
                    .map_or(failure_backoff_at_ms, |classification| {
                        if classification.class == ErrorClass::Transient {
                            classified_backoff_at_ms(
                                completed_at_ms,
                                failure_backoff_at_ms,
                                classification,
                            )
                        } else {
                            failure_backoff_at_ms
                        }
                    });
            abandon_current_state_with_detail(
                request.store,
                request.session_id,
                backoff_at_ms,
                Some(prefixed_detail(
                    detail_prefix,
                    format!("producer reattach output ({producer_run_id}): {err:?}"),
                )),
            )?;
            producer.close().await;
            return Err(HistorianDriveError::Producer(err));
        }
    };

    // Always release both routes, whether publish succeeds or errors — an early `?`
    // return would leak the command + subscribe routes for this reattached firing.
    let publish_result = publish_output_from_awaiting(PublishOutputRequest {
        store: request.store,
        session_id: request.session_id,
        project_path: request.project_path,
        awaiting,
        output,
        observed_chunk_fingerprint: request.observed_chunk_fingerprint,
        validation_chunk: request.validation_chunk,
        chunk_transcript: request.chunk_transcript,
        raw_chunk_messages: request.raw_chunk_messages,
        boundary_dates: request.boundary_dates,
        prior_compartments: request.prior_compartments,
        validate_options: request.validate_options,
        created_at_ms: request.now_ms,
        failure_started_at_ms: request.now_ms,
        failure_backoff_at_ms: request.failure_backoff_at_ms,
        completion_now_ms: request.completion_now_ms,
        publication_fence: request.publication_fence,
    });
    producer.close().await;
    let row_version = publish_result?;
    Ok(HistorianReattachOutcome::Published(HistorianRunSuccess {
        row_version,
        producer_session_id,
        producer_run_id,
        model: String::new(),
    }))
}

struct PublishOutputRequest<'a> {
    store: &'a McStore,
    session_id: &'a str,
    project_path: &'a str,
    awaiting: HistorianDurableState,
    output: ProducerOutput,
    observed_chunk_fingerprint: &'a str,
    validation_chunk: &'a HistorianChunk,
    chunk_transcript: &'a str,
    raw_chunk_messages: &'a str,
    boundary_dates: &'a BTreeMap<String, String>,
    prior_compartments: &'a [StoredCompartmentRange],
    validate_options: ValidateOptions,
    created_at_ms: i64,
    failure_started_at_ms: i64,
    failure_backoff_at_ms: i64,
    completion_now_ms: fn() -> i64,
    publication_fence: Option<&'a dyn HistorianPublicationFence>,
}

fn publish_output_from_awaiting(
    request: PublishOutputRequest<'_>,
) -> Result<u64, HistorianDriveError> {
    let PublishOutputRequest {
        store,
        session_id,
        project_path,
        awaiting,
        output,
        observed_chunk_fingerprint,
        validation_chunk,
        chunk_transcript,
        raw_chunk_messages,
        boundary_dates,
        prior_compartments,
        validate_options,
        created_at_ms,
        failure_started_at_ms,
        failure_backoff_at_ms,
        completion_now_ms,
        publication_fence,
    } = request;
    let validating = output_received(&awaiting, &output.text)?;
    persist_historian_state(store, session_id, validating.clone())?;

    let validation_result = if output.length_capped {
        Err(HistorianValidationError {
            message:
                "Historian output hit the length cap; refusing a potentially partial document."
                    .to_string(),
        })
    } else {
        validate_historian_output(
            &output.text,
            validation_chunk,
            prior_compartments,
            validate_options,
        )
    };
    let validated = match validation_result {
        Ok(validated) => validated,
        Err(err) => {
            let failure_backoff_at_ms = completion_failure_backoff_at_ms(
                failure_started_at_ms,
                failure_backoff_at_ms,
                completion_now_ms(),
            );
            let cap_hint = if output.length_capped {
                " [output hit the length cap: raise the output budget or shrink the chunk]"
            } else {
                ""
            };
            persist_historian_state(
                store,
                session_id,
                abandon_with_detail(
                    &validating,
                    failure_backoff_at_ms,
                    Some(format!("validate rejected: {err}{cap_hint}")),
                ),
            )?;
            return Err(HistorianDriveError::Validation(err));
        }
    };

    let publishing = validation_ok(&validating)?;
    let publishing_row_version = persist_historian_state(store, session_id, publishing.clone())?;
    let predicate = publish_predicate(&publishing)?;
    // Commit-point freshness checks live INSIDE publish_validated_chunk, which abandons
    // the matching firing before returning a rejection. A separate pre-check could return
    // early and strand the state in Publishing. Keep the row version written by the
    // Publishing transition too: reloading here would adopt a racing sync's version and
    // erase the CAS conflict that must retire this stale run.
    let published = publish_validated_chunk(
        store,
        ValidatedPublishRequest {
            session_id,
            project_path,
            expected_row_version: Some(publishing_row_version),
            expected_revert_epoch: publishing.expected_revert_epoch,
            predicate: &predicate,
            observed_chunk_fingerprint,
            validated: &validated,
            promote_facts: validate_options.memory_enabled && validate_options.auto_promote,
            collect_user_memory_candidates: validate_options.user_memory_collection_enabled,
            publication_floor_ordinal: validated.unprocessed_from,
            chunk_transcript,
            raw_chunk_messages,
            boundary_dates,
            created_at_ms,
            failure_backoff_at_ms,
            publication_fence,
        },
    )?;
    Ok(published.row_version)
}

fn abandon_current_state(
    store: &McStore,
    session_id: &str,
    failure_backoff_at_ms: i64,
) -> Result<(), HistorianStateError> {
    abandon_current_state_with_detail(store, session_id, failure_backoff_at_ms, None)
}

fn abandon_current_state_with_detail(
    store: &McStore,
    session_id: &str,
    failure_backoff_at_ms: i64,
    detail: Option<String>,
) -> Result<(), HistorianStateError> {
    let loaded = store.load(session_id)?;
    persist_historian_state(
        store,
        session_id,
        abandon_with_detail(&loaded.meta.historian, failure_backoff_at_ms, detail),
    )?;
    Ok(())
}

fn require_phase(
    current: &HistorianDurableState,
    expected: HistorianPhase,
    event: &'static str,
) -> Result<(), HistorianStateError> {
    if current.state == expected {
        Ok(())
    } else {
        Err(HistorianStateError::InvalidTransition {
            from: current.state.clone(),
            event,
        })
    }
}

fn idle_after_success(current: &HistorianDurableState) -> HistorianDurableState {
    HistorianDurableState {
        firing_seq: current.firing_seq,
        recent_decisions: current.recent_decisions.clone(),
        ..HistorianDurableState::default()
    }
}

/// Abandon like `abandon_matching_run_with_detail` but WITHOUT arming the
/// failure backoff: used when the publish was refused by a local fence rather
/// than failing in the producer, so the next attempt should not wait out a
/// model-failure cooldown.
fn abandon_matching_run_without_cooldown(
    store: &McStore,
    session_id: &str,
    predicate: &HistorianPublishPredicate,
    detail: Option<String>,
) -> Result<Option<u64>, HistorianStateError> {
    Ok(
        store.abandon_historian_run_if_matching_with_publish_failure(
            session_id,
            predicate,
            None,
            detail.as_deref(),
            true,
        )?,
    )
}

fn abandon_matching_run_with_detail(
    store: &McStore,
    session_id: &str,
    predicate: &HistorianPublishPredicate,
    failure_backoff_at_ms: i64,
    detail: Option<String>,
) -> Result<Option<u64>, HistorianStateError> {
    Ok(
        store.abandon_historian_run_if_matching_with_publish_failure(
            session_id,
            predicate,
            Some(failure_backoff_at_ms),
            detail.as_deref(),
            true,
        )?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use mc_core::CoreState;
    use mc_store::{ModuleMeta, StoredCompartment};

    use crate::ck_wire::{self, CkIngressMessage, CkWireMessage};
    use crate::transform::{transform, ProducerContext, TransformRequest};

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

    fn req(messages: Vec<CkIngressMessage>) -> TransformRequest {
        TransformRequest {
            cache_ttl: None,
            effective_execute_threshold: None,
            auto_search_enabled: true,
            auto_search_score_threshold: 0.35,
            auto_search_min_prompt_chars: 0,
            kind: "transform".to_string(),
            v: 2,
            serializer_profile: "owned-llmrunner".to_string(),
            session_id: "ses".to_string(),
            render_config: "cfg".to_string(),
            system_prompt_hash: String::new(),
            upgrade_state: String::new(),
            is_subagent: false,
            subagent_reconciliation: false,
            protected_tags: 20,
            protected_tags_present: false,
            protected_tokens_effective: None,
            provider_id: None,
            model_key: None,
            clear_reasoning_age: 50,
            caveman_enabled: false,
            caveman_min_chars: 500,
            tool_input_key_orders: Default::default(),
            tool_present: false,
            todo_tool_present: None,
            prompt_surface_preset: crate::prompt_surface::PromptSurfacePreset::Full,
            prompt_surface_model_key: None,
            prompt_surface_config_identity: String::new(),
            prompt_surface_tool_descriptions: BTreeMap::new(),
            prompt_surface_guidance_override: None,
            mural: None,
            serve_native: false,
            native_messages: None,
            full_array_fingerprint: None,
            messages,
            tail_delta: None,
            usage: None,
            geometry: None,
            provider_error: None,
            mid_turn: false,
            prev_response_completed_at_ms: None,
            request_observed_at_ms: None,
            channel2_nudge_state: String::new(),
            channel2_delivered_id: None,
            emergency_recovery_armed: false,
            emergency_recovery_no_head_escape: false,
            detected_context_limit: 0,
            detected_context_limit_model_key: None,
            history_budget_tokens: None,
            historian_model_chain: None,
            declared_trim: None,
            lineage_switched: false,
            descent_edge_id: 0,
            prior_conversation_key: String::new(),
            prior_epoch: 0,
            new_epoch: 0,
            constituents: Vec::new(),
            compaction_observed: false,
        }
    }

    fn empty_boundary_dates() -> &'static BTreeMap<String, String> {
        static EMPTY: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(BTreeMap::new)
    }

    fn pctx<'a>() -> ProducerContext<'a> {
        ProducerContext {
            project_path: "git:proj",
            note_project_path: "git:proj",
            project_directory: "/nonexistent-docs",
            history_budget_tokens: 60_000.0,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            memory_enabled: true,
            inject_docs: true,
            temporal_awareness: true,
            now_ms: 0,
            execute_threshold_percentage: 65.0,
            protected_tokens_floor: 16_000,
            protected_tokens_provenance: "derived",
            compaction_enabled: true,
            smart_drops: false,
            cache_ttl: "5m".to_string(),
            cache_ttl_provenance: crate::config::CacheTtlProvenance::Default,
            model_key: None,
            observed_last_response_at_ms: None,
            guidance_date: Some("Today's date: Thu Jan 01 1970".to_string()),
            historian_active: false,
            wrapup_active: false,
            injected_reductions: Vec::new(),
        }
    }

    fn run_transform(store: &McStore, request: &TransformRequest) -> Vec<CkWireMessage> {
        transform(store, request, &pctx())
            .unwrap()
            .ck_messages
            .unwrap_or_default()
            .into_iter()
            .map(crate::transform::ServedMessage::into_message)
            .collect()
    }

    fn comp(seq: i64, start: i64, end: i64, end_id: &str, p1: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: format!("{end_id}#0"),
            title: format!("C{seq}"),
            content: p1.to_string(),
            p1: Some(p1.to_string()),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn stored_compartment_legacy_flag_tracks_p1_presence() {
        let tiered = ValidatedCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 2,
            start_message_id: "m1#0".into(),
            end_message_id: "m2#0".into(),
            title: "tiered".into(),
            content: "full".into(),
            p1: Some("full".into()),
            p2: Some("short".into()),
            p3: Some("brief".into()),
            p4: Some("".into()),
            importance: None,
            episode_type: None,
        };
        let flat = ValidatedCompartment {
            p1: None,
            p2: None,
            p3: None,
            p4: None,
            ..tiered.clone()
        };

        assert_eq!(
            to_stored_compartment(&tiered, 1, empty_boundary_dates()).legacy,
            0
        );
        assert_eq!(
            to_stored_compartment(&flat, 1, empty_boundary_dates()).legacy,
            1
        );
    }

    fn flat_historian_xml(content: &str) -> String {
        format!(
            r#"<output>
<compartments>
<compartment start="2" end="3" title="flat">{content}</compartment>
</compartments>
<meta><messages_processed>2-3</messages_processed><unprocessed_from>4</unprocessed_from></meta>
</output>"#
        )
    }

    fn historian_xml(p1: &str) -> String {
        format!(
            r#"<output>
<compartments>
<compartment start="2" end="3" title="second arc" episode_type="feature" importance="60">
<p1>{p1}</p1>
<p2>second arc short</p2>
<p3>second arc</p3>
<p4 />
</compartment>
</compartments>
<meta><messages_processed>2-3</messages_processed><unprocessed_from>4</unprocessed_from></meta>
</output>"#
        )
    }

    fn historian_chunk() -> HistorianChunk {
        use crate::historian_validate::ChunkLine;
        HistorianChunk {
            start_index: 2,
            end_index: 4,
            lines: vec![
                ChunkLine {
                    ordinal: 2,
                    message_id: "m2#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 3,
                    message_id: "m3#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 4,
                    message_id: "m4#0".into(),
                    anchorable: true,
                },
            ],
            present_ordinals: vec![1, 2, 3, 4],
            tool_only_ranges: vec![],
            completed_tool_arcs: vec![],
        }
    }

    fn prior_ranges() -> Vec<StoredCompartmentRange> {
        vec![StoredCompartmentRange {
            start_message: 1,
            end_message: 1,
        }]
    }

    fn validate_options() -> ValidateOptions {
        ValidateOptions {
            sequence_offset: 1,
            in_emergency: true,
            memory_enabled: true,
            auto_promote: true,
            user_memory_collection_enabled: false,
            force_keep_last_compartment: false,
        }
    }

    fn seed_prior_compartment(store: &McStore) {
        store
            .replace_compartments("ses", &[comp(1, 1, 1, "m1", "C1 summary")])
            .unwrap();
    }

    fn test_selected_range_identities() -> Vec<HistorianSelectedMessageIdentity> {
        ["m2", "m3"]
            .into_iter()
            .map(|mid| HistorianSelectedMessageIdentity {
                mid: mid.to_string(),
                block_identities: vec![mc_store::BlockIdentity {
                    kind_tag: "text".to_string(),
                    byte_fingerprint: format!("{mid}-content-a"),
                }],
            })
            .collect()
    }

    fn test_meta_with_historian(historian: HistorianDurableState) -> ModuleMeta {
        let mut meta = ModuleMeta {
            historian,
            ..Default::default()
        };
        for selected in test_selected_range_identities() {
            meta.block_identity_by_mid
                .insert(selected.mid, selected.block_identities);
        }
        meta
    }

    fn seed_test_selected_range_identities(store: &McStore) {
        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta.clone();
        for selected in test_selected_range_identities() {
            meta.block_identity_by_mid
                .insert(selected.mid, selected.block_identities);
        }
        if meta != loaded.meta {
            store
                .commit("ses", loaded.row_version, &loaded.core, &meta)
                .unwrap();
        }
    }

    #[derive(Default)]
    struct ScriptedProducer {
        starts: VecDeque<Result<RunHandle, HistorianProducerError>>,
        outputs: VecDeque<Result<ProducerOutput, HistorianProducerError>>,
        statuses: VecDeque<Result<RunState, HistorianProducerError>>,
        observed_starts: Vec<(String, String)>,
        observed_sessions: Vec<String>,
        observed_systems: Vec<String>,
        observed_prompts: Vec<String>,
        observed_temperatures: Vec<Option<f64>>,
        await_run_ids: Vec<String>,
        cancels: Vec<String>,
        closes: usize,
        on_await_output: Option<Box<dyn FnOnce() + Send>>,
    }

    impl ScriptedProducer {
        fn with_start(mut self, result: Result<RunHandle, HistorianProducerError>) -> Self {
            self.starts.push_back(result);
            self
        }

        fn with_output(mut self, result: Result<ProducerOutput, HistorianProducerError>) -> Self {
            self.outputs.push_back(result);
            self
        }

        fn with_status(mut self, result: Result<RunState, HistorianProducerError>) -> Self {
            self.statuses.push_back(result);
            self
        }

        fn with_await_output_hook(mut self, hook: impl FnOnce() + Send + 'static) -> Self {
            self.on_await_output = Some(Box::new(hook));
            self
        }
    }

    #[subc_client_rs::async_trait]
    impl HistorianProducerDriver for ScriptedProducer {
        async fn bind_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
            self.observed_sessions.push(session_id.to_string());
            Ok(())
        }

        async fn start(
            &mut self,
            session_id: &str,
            system: &str,
            prompt: &str,
            model: &str,
        ) -> Result<RunHandle, HistorianProducerError> {
            self.observed_sessions.push(session_id.to_string());
            self.observed_systems.push(system.to_string());
            self.observed_prompts.push(prompt.to_string());
            self.observed_starts
                .push((session_id.to_string(), model.to_string()));
            self.starts
                .pop_front()
                .expect("scripted start result available")
        }

        async fn start_with_temperature(
            &mut self,
            session_id: &str,
            system: &str,
            prompt: &str,
            model: &str,
            temperature: Option<f64>,
        ) -> Result<RunHandle, HistorianProducerError> {
            self.observed_temperatures.push(temperature);
            self.start(session_id, system, prompt, model).await
        }

        async fn await_output(
            &mut self,
            run_id: &str,
        ) -> Result<ProducerOutput, HistorianProducerError> {
            self.await_run_ids.push(run_id.to_string());
            if let Some(hook) = self.on_await_output.take() {
                hook();
            }
            self.outputs
                .pop_front()
                .expect("scripted output result available")
        }

        async fn status(&mut self, _run_id: &str) -> Result<RunState, HistorianProducerError> {
            self.statuses
                .pop_front()
                .expect("scripted status result available")
        }

        async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
            self.cancels.push(run_id.to_string());
            Ok(())
        }

        async fn close(&mut self) {
            self.closes += 1;
        }
    }

    fn run_handle(id: &str) -> RunHandle {
        RunHandle {
            run_id: id.to_string(),
        }
    }

    fn producer_output(text: String) -> ProducerOutput {
        ProducerOutput {
            text,
            length_capped: false,
        }
    }

    #[test]
    fn full_lineage_hash_separates_keys_that_collided_at_32_bits() {
        let first = historian_producer_session_id("proj", "lineage-ZiDxmBSjhQbv", 2);
        let second = historian_producer_session_id("proj", "lineage-OPeZDtvlh9LD", 2);

        assert_ne!(first, second);
        let first_hash = first.split(':').nth(2).expect("hash segment");
        let second_hash = second.split(':').nth(2).expect("hash segment");
        assert_eq!(first_hash.len(), 16);
        assert_eq!(second_hash.len(), 16);
        assert_eq!(
            &first_hash[..8],
            &second_hash[..8],
            "the regression keys collided under the former 32-bit prefix"
        );
    }

    #[test]
    fn producer_session_ids_are_lineage_scoped_under_one_project() {
        // A parent conversation and a concurrent subagent lineage (composite key
        // with the U+241F delimiter) share the project slug and can reach the
        // same firing sequence at the same time. Their producer sessions must
        // not collide, or the terminal-run tracking crosses lineages and one
        // fold's commit is lost.
        let parent = historian_producer_session_id("proj", "84b85b9f", 2);
        let subagent = historian_producer_session_id("proj", "84b85b9f\u{241F}a063e\u{241F}0", 2);
        assert_ne!(parent, subagent);
        // Both stay inside the self-exemption namespace so the transform
        // pass-through still recognizes them as MC-owned children.
        assert!(parent.starts_with("mc-historian:"));
        assert!(subagent.starts_with("mc-historian:"));
        // Composite-key delimiter bytes never leak into the id (llm-runner
        // session ids should stay slug-safe ASCII).
        assert!(subagent.is_ascii());
        // Same lineage, different firing: still unique per firing.
        assert_ne!(parent, historian_producer_session_id("proj", "84b85b9f", 3));
    }

    fn fire_request<'a>(
        store: &'a McStore,
        prompt: &'a str,
        models: &'a [String],
        chunk: &'a HistorianChunk,
        prior: &'a [StoredCompartmentRange],
    ) -> HistorianFireRequest<'a> {
        seed_test_selected_range_identities(store);
        let compartment_set_generation = store
            .load_historian_assembly_snapshot("ses")
            .unwrap()
            .compartment_set_generation;
        HistorianFireRequest {
            store,
            session_id: "ses",
            project_path: "git:proj",
            project_slug: "proj",
            system: Cow::Borrowed("role guidance"),
            content_language: None,
            prompt,
            model_chain: models,
            temperature: None,
            producer_source_tokens: 1,
            historian_context_limit_tokens: None,
            max_output_tokens: 32_000,
            from_ordinal: 2,
            to_ordinal: 4,
            chunk_fingerprint: "fp",
            selected_range_identities: test_selected_range_identities(),
            expected_revert_epoch: 0,
            compartment_set_generation,
            observed_chunk_fingerprint: "fp",
            validation_chunk: chunk,
            chunk_transcript: "U: transcript",
            raw_chunk_messages: "[]",
            boundary_dates: empty_boundary_dates(),
            prior_compartments: prior,
            validate_options: validate_options(),
            now_ms: 123,
            failure_backoff_at_ms: 999,
            recent_decision: None,
            completion_now_ms: || 123,
            publication_fence: None,
        }
    }

    fn reattach_request<'a>(
        store: &'a McStore,
        chunk: &'a HistorianChunk,
        prior: &'a [StoredCompartmentRange],
    ) -> HistorianReattachRequest<'a> {
        HistorianReattachRequest {
            store,
            session_id: "ses",
            project_path: "git:proj",
            observed_chunk_fingerprint: "fp",
            validation_chunk: chunk,
            chunk_transcript: "U: transcript",
            raw_chunk_messages: "[]",
            boundary_dates: empty_boundary_dates(),
            prior_compartments: prior,
            validate_options: validate_options(),
            publication_floor_ordinal: 4,
            now_ms: 123,
            failure_backoff_at_ms: 999,
            completion_now_ms: || 123,
            publication_fence: None,
        }
    }

    fn publishing_state() -> HistorianDurableState {
        HistorianDurableState {
            state: HistorianPhase::Publishing,
            firing_seq: 3,
            chunk_range: Some(HistorianChunkRange {
                from_ordinal: 2,
                to_ordinal: 4,
            }),
            chunk_fingerprint: "fp".into(),
            selected_range_identities: test_selected_range_identities(),
            producer_session_id: Some("producer-session".into()),
            producer_run_id: Some("run-3".into()),
            fired_at_ms: Some(10),
            expected_revert_epoch: 0,
            compartment_set_generation: CompartmentSetGeneration::default(),
            failure_backoff_at_ms: None,
            last_failure: None,
            last_no_fire: None,
            recent_decisions: Vec::new(),
            consecutive_publish_failures: 0,
        }
    }

    #[tokio::test]
    async fn producer_window_guard_refuses_two_x_and_admits_one_point_zero_five_x() {
        let refused_dir = tempfile::tempdir().unwrap();
        let refused_store = store(refused_dir.path());
        seed_prior_compartment(&refused_store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut refused_request = fire_request(
            &refused_store,
            "placeholder prompt",
            &models,
            &chunk,
            &prior,
        );
        refused_request.producer_source_tokens = 20_000;
        refused_request.historian_context_limit_tokens = Some(11_000);
        refused_request.max_output_tokens = 1_000;
        let mut refused_producer = ScriptedProducer::default();

        assert!(run_historian_firing(&mut refused_producer, refused_request)
            .await
            .is_err());
        assert!(refused_producer.observed_starts.is_empty());
        let refused_state = refused_store.load("ses").unwrap().meta.historian;
        assert_eq!(refused_state.failure_backoff_at_ms, Some(999));
        assert_eq!(
            refused_state.last_failure.as_deref(),
            Some("producer_source_exceeds_window producer_source_tokens=20000 usable_input_tokens=10000 context_limit_tokens=11000 max_output_tokens=1000 refusal_margin=0.15")
        );

        let admitted_dir = tempfile::tempdir().unwrap();
        let admitted_store = store(admitted_dir.path());
        seed_prior_compartment(&admitted_store);
        let mut admitted_request = fire_request(
            &admitted_store,
            "placeholder prompt",
            &models,
            &chunk,
            &prior,
        );
        admitted_request.producer_source_tokens = 10_500;
        admitted_request.historian_context_limit_tokens = Some(11_000);
        admitted_request.max_output_tokens = 1_000;
        let mut admitted_producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-window-edge")))
            .with_output(Ok(producer_output(historian_xml("within margin"))));

        assert!(
            run_historian_firing(&mut admitted_producer, admitted_request)
                .await
                .is_ok()
        );
        assert_eq!(admitted_producer.observed_starts.len(), 1);
    }

    #[tokio::test]
    async fn wired_historian_happy_path_sends_validates_and_publishes() {
        let dir = tempfile::tempdir().unwrap();
        let main_store = store(dir.path());
        seed_prior_compartment(&main_store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let text = historian_xml("second arc full and exact");
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Ok(producer_output(text)));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&main_store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected completed outcome");
        };
        assert_eq!(success.model, "prov/model-a");
        let expected_session = historian_producer_session_id("proj", "ses", 1);
        assert_eq!(success.producer_session_id, expected_session);
        assert_eq!(producer.observed_starts.len(), 1);
        assert_eq!(producer.observed_starts[0].0, expected_session);
        assert_eq!(
            producer.observed_systems,
            vec!["role guidance".to_string()],
            "exactly ONE send carries the system prompt; a reattach path never re-sends \
             (system rides the run's durable input, re-drained not re-sent)"
        );
        assert_eq!(producer.await_run_ids, vec!["run-1"]);

        let loaded = main_store.load("ses").unwrap();
        assert_eq!(loaded.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(loaded.meta.publication_floor_ordinal, Some(4));
        let comps = main_store.load_compartments("ses").unwrap();
        assert_eq!(
            comps.len(),
            2,
            "prior C1 preserved and historian C2 appended"
        );
        let c2 = comps.last().unwrap();
        assert_eq!(c2.end_message_id, "m3#0");
        assert_eq!(c2.p1.as_deref(), Some("second arc full and exact"));
        assert_eq!(c2.created_at, 123);
    }

    #[tokio::test]
    async fn selected_range_identity_drift_during_await_rejects_without_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(store(dir.path()));
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let hook_store = std::sync::Arc::clone(&store);
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Ok(producer_output(historian_xml("stale summary"))))
            .with_await_output_hook(move || {
                let loaded = hook_store.load("ses").unwrap();
                let mut meta = loaded.meta;
                meta.block_identity_by_mid.get_mut("m2").unwrap()[0].byte_fingerprint =
                    "m2-content-b".to_string();
                hook_store
                    .commit("ses", loaded.row_version, &loaded.core, &meta)
                    .unwrap();
            });

        let error = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            HistorianDriveError::State(HistorianStateError::Publish(
                HistorianPublishError::FenceRejected { .. }
            ))
        ));
        let loaded = store.load("ses").unwrap();
        assert_eq!(loaded.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(loaded.meta.historian.failure_backoff_at_ms, None);
        assert_eq!(loaded.meta.publication_floor_ordinal, None);
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
        assert!(store
            .load_chunk_transcripts_for_range("ses", 2, 4)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn tail_identity_extension_during_await_still_publishes() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(store(dir.path()));
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let hook_store = std::sync::Arc::clone(&store);
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Ok(producer_output(historian_xml("current summary"))))
            .with_await_output_hook(move || {
                let loaded = hook_store.load("ses").unwrap();
                let mut meta = loaded.meta;
                meta.block_identity_by_mid.insert(
                    "m5".to_string(),
                    vec![mc_store::BlockIdentity {
                        kind_tag: "text".to_string(),
                        byte_fingerprint: "later-content".to_string(),
                    }],
                );
                hook_store
                    .commit("ses", loaded.row_version, &loaded.core, &meta)
                    .unwrap();
            });

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        assert!(matches!(outcome, HistorianDriveOutcome::Completed(_)));
        let loaded = store.load("ses").unwrap();
        assert_eq!(loaded.meta.publication_floor_ordinal, Some(4));
        assert!(loaded.meta.block_identity_by_mid.contains_key("m5"));
        assert_eq!(store.load_compartments("ses").unwrap().len(), 2);
    }

    #[tokio::test]
    async fn fallback_retry_uses_new_session_and_overflow_short_circuits() {
        let dir = tempfile::tempdir().unwrap();
        let fallback_store = store(dir.path());
        seed_prior_compartment(&fallback_store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::retryable_model_failure(
                "provider overloaded",
            )))
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml("fallback model summary"))));

        let mut request = fire_request(
            &fallback_store,
            "placeholder prompt",
            &models,
            &chunk,
            &prior,
        );
        request.temperature = Some(0.0);
        let outcome = run_historian_firing(&mut producer, request).await.unwrap();
        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected completed fallback outcome");
        };
        assert_eq!(success.model, "prov/model-b");
        assert_eq!(
            producer.observed_starts,
            vec![
                (
                    historian_producer_session_id("proj", "ses", 1),
                    "prov/model-a".to_string()
                ),
                (
                    historian_producer_session_id("proj", "ses", 2),
                    "prov/model-b".to_string()
                ),
            ],
            "fallback retries author a new session/run instead of resuming under another model"
        );
        assert_eq!(producer.observed_temperatures, vec![Some(0.0), Some(0.0)]);
        assert_eq!(
            fallback_store
                .load("ses")
                .unwrap()
                .meta
                .historian
                .firing_seq,
            2
        );

        let dir = tempfile::tempdir().unwrap();
        let overflow_store = store(dir.path());
        seed_prior_compartment(&overflow_store);
        let mut overflow = ScriptedProducer::default().with_start(Err(
            HistorianProducerError::context_overflow("context window exceeded"),
        ));
        let err = run_historian_firing(
            &mut overflow,
            fire_request(
                &overflow_store,
                "placeholder prompt",
                &models,
                &chunk,
                &prior,
            ),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(
            overflow.observed_starts.len(),
            1,
            "overflow does not try the next model"
        );
        let state = overflow_store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(state.firing_seq, 1);
    }

    fn live_model_unresolvable_open_error() -> HistorianProducerError {
        HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "open_failed",
            "open failed: run resolution failed: no apikey credential for provider 'opencode' (credential id 'apikey:opencode')",
        ))
    }

    #[tokio::test]
    async fn open_resolution_refusal_advances_and_records_skipped_model() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["opencode/model-a".to_string(), "google/model-b".to_string()];
        let cache = HistorianModelUnresolvableCache::default();
        let generation = cache.activate_chain(&models);
        let mut producer = ScriptedProducer::default()
            .with_start(Err(live_model_unresolvable_open_error()))
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml(
                "fallback after unresolved primary",
            ))));
        let request = fire_request(&store, "placeholder prompt", &models, &chunk, &prior);

        let outcome =
            run_historian_firing_with_model_cache(&mut producer, request, Some(&cache), generation)
                .await
                .unwrap();

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected unresolved primary to advance to fallback model");
        };
        assert_eq!(success.model, "google/model-b");
        assert_eq!(producer.observed_starts.len(), 2);
        let state = store.load("ses").unwrap().meta.historian;
        let detail = state.last_failure.expect("skipped model remains durable");
        assert!(detail.contains("model_unresolvable:opencode/model-a"));
        assert!(detail.contains("no apikey credential for provider 'opencode'"));
        assert_eq!(state.failure_backoff_at_ms, None);
    }

    #[tokio::test]
    async fn transport_open_refusal_stays_on_primary_and_arms_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "other/model-b".to_string()];
        let mut producer = ScriptedProducer::default().with_start(Err(
            HistorianProducerError::Subc(ProducerErrorBody::untagged(
                "open_failed",
                "open failed: route closed before bind completed",
            )),
        ));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.observed_starts.len(), 1);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        assert!(!state
            .last_failure
            .as_deref()
            .unwrap_or_default()
            .contains("model_unresolvable"));
    }

    #[tokio::test]
    async fn unresolved_chain_exhaustion_records_every_model_without_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["opencode/model-a".to_string(), "google/model-b".to_string()];
        let cache = HistorianModelUnresolvableCache::default();
        let generation = cache.activate_chain(&models);
        let mut producer = ScriptedProducer::default()
            .with_start(Err(live_model_unresolvable_open_error()))
            .with_start(Err(HistorianProducerError::Subc(
                ProducerErrorBody::untagged(
                    "open_failed",
                    "open failed: run resolution failed: unknown model 'model-b' for provider 'google'",
                ),
            )));
        let request = fire_request(&store, "placeholder prompt", &models, &chunk, &prior);

        let err =
            run_historian_firing_with_model_cache(&mut producer, request, Some(&cache), generation)
                .await
                .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.observed_starts.len(), 2);
        let state = store.load("ses").unwrap().meta.historian;
        let detail = state.last_failure.expect("chain failure remains durable");
        assert!(detail.starts_with(MODEL_UNRESOLVABLE_CHAIN_EXHAUSTED_PREFIX));
        assert!(detail.contains("model_unresolvable:opencode/model-a"));
        assert!(detail.contains("model_unresolvable:google/model-b"));
        assert_eq!(state.failure_backoff_at_ms, None);
    }

    #[tokio::test]
    async fn generation_cache_opens_unresolved_model_only_once_across_firings() {
        let models = vec!["opencode/model-a".to_string(), "google/model-b".to_string()];
        let cache = HistorianModelUnresolvableCache::default();
        let generation = cache.activate_chain(&models);

        let dir_one = tempfile::tempdir().unwrap();
        let store_one = store(dir_one.path());
        seed_prior_compartment(&store_one);
        let chunk_one = historian_chunk();
        let prior_one = prior_ranges();
        let mut first = ScriptedProducer::default()
            .with_start(Err(live_model_unresolvable_open_error()))
            .with_start(Ok(run_handle("run-first-b")))
            .with_output(Ok(producer_output(historian_xml("first fallback"))));
        let first_request = fire_request(
            &store_one,
            "placeholder prompt",
            &models,
            &chunk_one,
            &prior_one,
        );
        run_historian_firing_with_model_cache(&mut first, first_request, Some(&cache), generation)
            .await
            .unwrap();

        let dir_two = tempfile::tempdir().unwrap();
        let store_two = store(dir_two.path());
        seed_prior_compartment(&store_two);
        let chunk_two = historian_chunk();
        let prior_two = prior_ranges();
        let mut second = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-second-b")))
            .with_output(Ok(producer_output(historian_xml("second fallback"))));
        let second_request = fire_request(
            &store_two,
            "placeholder prompt",
            &models,
            &chunk_two,
            &prior_two,
        );
        run_historian_firing_with_model_cache(
            &mut second,
            second_request,
            Some(&cache),
            generation,
        )
        .await
        .unwrap();

        let model_a_open_count = first
            .observed_starts
            .iter()
            .chain(&second.observed_starts)
            .filter(|(_, model)| model == "opencode/model-a")
            .count();
        assert_eq!(model_a_open_count, 1);
        assert_eq!(
            second
                .observed_starts
                .iter()
                .map(|(_, model)| model.as_str())
                .collect::<Vec<_>>(),
            vec!["google/model-b"]
        );
        assert!(store_two
            .load("ses")
            .unwrap()
            .meta
            .historian
            .last_failure
            .as_deref()
            .unwrap_or_default()
            .contains("model_unresolvable:opencode/model-a"));
    }

    #[test]
    fn model_unresolvable_cache_invalidates_when_chain_changes() {
        let cache = HistorianModelUnresolvableCache::default();
        let first_chain = vec!["opencode/model-a".to_string(), "google/model-b".to_string()];
        let first_generation = cache.activate_chain(&first_chain);
        assert!(cache.record(first_generation, &first_chain[0], "open_failed: unresolved"));
        assert!(cache
            .cached_reason(first_generation, &first_chain[0])
            .is_some());

        let second_chain = vec!["anthropic/model-c".to_string()];
        let second_generation = cache.activate_chain(&second_chain);
        assert_ne!(second_generation, first_generation);
        assert!(cache
            .cached_reason(second_generation, &first_chain[0])
            .is_none());
        assert!(cache
            .cached_reason(first_generation, &first_chain[0])
            .is_none());
    }

    #[tokio::test]
    async fn permanent_class_advances_chain_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "model id does not exist",
                ErrorClass::Permanent,
                None,
            )))
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml(
                "fallback after permanent",
            ))));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected permanent failure to advance to fallback model");
        };
        assert_eq!(success.model, "prov/model-b");
        assert_eq!(producer.observed_starts.len(), 2);
    }

    #[tokio::test]
    async fn chain_exhausted_all_permanent_records_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "other/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "model a is permanently unavailable",
                ErrorClass::Permanent,
                None,
            )))
            .with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "model b is permanently unavailable",
                ErrorClass::Permanent,
                None,
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.observed_starts.len(), 2);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        assert!(
            state
                .last_failure
                .as_deref()
                .is_some_and(|detail| detail.starts_with(CHAIN_EXHAUSTED_PERMANENT_PREFIX)),
            "all-permanent chain exhaustion must be visible in durable state: {:?}",
            state.last_failure
        );
    }

    #[tokio::test]
    async fn exhausted_chain_keeps_earliest_reset_and_tries_third_model() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["primary/a".into(), "google/b".into(), "third/c".into()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::tagged_subc(
                "refused",
                "unavailable",
                ErrorClass::Permanent,
                None,
            )))
            .with_start(Err(HistorianProducerError::tagged_subc(
                "429",
                r#"{"quotaResetTimeStamp":"2026-09-11T20:34:51Z","quotaResetDelay":"5760s"}"#,
                ErrorClass::Transient,
                None,
            )))
            .with_start(Err(HistorianProducerError::tagged_subc(
                "429",
                r#"{"quotaResetTimeStamp":"2026-09-11T21:34:51Z"}"#,
                ErrorClass::Transient,
                None,
            )));
        run_historian_firing(
            &mut producer,
            fire_request(&store, "prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert_eq!(producer.observed_starts.len(), 3);
        let state = store.load("ses").unwrap().meta.historian;
        let reset = chrono::DateTime::parse_from_rfc3339("2026-09-11T20:34:51Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(state.failure_backoff_at_ms, Some(reset));
        let detail = state.last_no_fire.unwrap();
        assert!(detail.contains("chain_exhausted"));
        assert!(detail.contains("2026-09-11T20:34:51"));
        assert!(detail.contains("probe"));
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn transient_retry_after_sets_backoff_floor() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer =
            ScriptedProducer::default().with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "short retry-after should not shorten our schedule",
                ErrorClass::Transient,
                Some(5),
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(
            state.failure_backoff_at_ms,
            Some(123 + HISTORIAN_FAILURE_BACKOFF_MS),
            "retry_after_secs is a floor input and cannot shorten the historian schedule"
        );
    }

    #[tokio::test]
    async fn transient_retry_after_longer_than_schedule_wins() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer =
            ScriptedProducer::default().with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "rate limit reset later",
                ErrorClass::Transient,
                Some(120),
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.failure_backoff_at_ms, Some(123 + 120_000));
    }

    #[tokio::test]
    async fn auth_required_skips_same_provider_and_tries_different_provider() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec![
            "openai/model-a".to_string(),
            "openai/model-b".to_string(),
            "anthropic/model-c".to_string(),
        ];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "credential needs re-authentication",
                ErrorClass::AuthRequired,
                None,
            )))
            .with_start(Ok(run_handle("run-3")))
            .with_output(Ok(producer_output(historian_xml(
                "different provider summary",
            ))));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected auth failure to try the different provider fallback");
        };
        assert_eq!(success.model, "anthropic/model-c");
        assert_eq!(
            producer.observed_starts,
            vec![
                (
                    historian_producer_session_id("proj", "ses", 1),
                    "openai/model-a".to_string()
                ),
                (
                    historian_producer_session_id("proj", "ses", 2),
                    "anthropic/model-c".to_string()
                ),
            ],
            "same-provider auth alternatives are skipped without opening a producer session"
        );
    }

    #[tokio::test]
    async fn auth_required_all_same_provider_records_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["openai/model-a".to_string(), "openai/model-b".to_string()];
        let mut producer =
            ScriptedProducer::default().with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "credential needs re-authentication",
                ErrorClass::AuthRequired,
                None,
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.observed_starts.len(), 1);
        let state = store.load("ses").unwrap().meta.historian;
        assert!(
            state
                .last_failure
                .as_deref()
                .is_some_and(|detail| detail.starts_with(AUTH_REQUIRED_PREFIX)),
            "same-provider auth exhaustion must be visible in durable state: {:?}",
            state.last_failure
        );
    }

    #[tokio::test]
    async fn tagged_context_overflow_short_circuits_chain() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "other/model-b".to_string()];
        let mut producer =
            ScriptedProducer::default().with_start(Err(HistorianProducerError::tagged_subc(
                "provider_error",
                "context window exceeded",
                ErrorClass::ContextOverflow,
                None,
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.observed_starts.len(), 1);
    }

    #[tokio::test]
    async fn untagged_error_uses_deprecated_heuristic_and_counts_it() {
        crate::historian_producer::reset_deprecated_heuristic_uses_for_test();
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::retryable_model_failure(
                "provider overloaded",
            )))
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml("heuristic fallback"))));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        assert!(matches!(outcome, HistorianDriveOutcome::Completed(_)));
        assert!(
            crate::historian_producer::deprecated_heuristic_uses() >= 1,
            "an untagged producer error must increment the migration counter"
        );
    }

    #[tokio::test]
    async fn tagged_error_ignores_contradicting_heuristic_text() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Err(HistorianProducerError::tagged_subc(
                "context_overflow",
                "overflow text would block retry under the deprecated heuristic",
                ErrorClass::Permanent,
                None,
            )))
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml("tag wins summary"))));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected permanent tag to advance despite overflow text");
        };
        assert_eq!(success.model, "prov/model-b");
    }

    #[tokio::test]
    async fn reattach_terminal_redrains_from_start_without_second_send() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            0,
            CompartmentSetGeneration {
                max_sequence: 1,
                count: 1,
            },
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(awaiting),
            )
            .unwrap();
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml(
                "terminal replay summary",
            ))));

        let outcome =
            reattach_historian_producer(&mut producer, reattach_request(&store, &chunk, &prior))
                .await
                .unwrap();
        assert!(matches!(outcome, HistorianReattachOutcome::Published(_)));
        assert!(
            producer.observed_starts.is_empty(),
            "reattach publishes replayed output without a second session.send"
        );
        assert_eq!(producer.observed_sessions, vec!["producer-session"]);
        assert_eq!(producer.await_run_ids, vec!["run-1"]);
        let c2 = store.load_compartments("ses").unwrap().pop().unwrap();
        assert_eq!(c2.p1.as_deref(), Some("terminal replay summary"));
    }

    #[tokio::test]
    async fn reattach_equal_length_identity_drift_rejects_before_publish() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            0,
            CompartmentSetGeneration {
                max_sequence: 1,
                count: 1,
            },
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(awaiting),
            )
            .unwrap();
        let loaded = store.load("ses").unwrap();
        let mut meta = loaded.meta;
        meta.block_identity_by_mid.get_mut("m2").unwrap()[0].byte_fingerprint =
            "m2-content-b".to_string();
        store
            .commit("ses", loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml("stale replay summary"))));

        let error =
            reattach_historian_producer(&mut producer, reattach_request(&store, &chunk, &prior))
                .await
                .unwrap_err();

        assert!(matches!(
            error,
            HistorianDriveError::State(HistorianStateError::Publish(
                HistorianPublishError::FenceRejected { .. }
            ))
        ));
        let loaded = store.load("ses").unwrap();
        assert_eq!(loaded.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(loaded.meta.historian.failure_backoff_at_ms, None);
        assert_eq!(loaded.meta.publication_floor_ordinal, None);
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn concurrent_lineages_reattach_and_publish_in_isolated_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let left_lineage = "lineage-ZiDxmBSjhQbv";
        let right_lineage = "lineage-OPeZDtvlh9LD";
        let left_producer_session = historian_producer_session_id("proj", left_lineage, 1);
        let right_producer_session = historian_producer_session_id("proj", right_lineage, 1);
        assert_ne!(left_producer_session, right_producer_session);

        for (lineage, producer_session, run_id) in [
            (left_lineage, left_producer_session.as_str(), "run-left"),
            (right_lineage, right_producer_session.as_str(), "run-right"),
        ] {
            store
                .replace_compartments(lineage, &[comp(1, 1, 1, "m1", "C1 summary")])
                .unwrap();
            let fired = match fire(
                &HistorianDurableState::default(),
                2,
                4,
                "fp".into(),
                test_selected_range_identities(),
                0,
                CompartmentSetGeneration {
                    max_sequence: 1,
                    count: 1,
                },
                1,
                None,
            )
            .unwrap()
            {
                FireOutcome::Fired(state) => state,
                FireOutcome::Busy(_) => unreachable!(),
            };
            let awaiting =
                producer_started(&fired, producer_session.to_string(), run_id.to_string()).unwrap();
            store
                .commit(
                    lineage,
                    None,
                    &CoreState::default(),
                    &test_meta_with_historian(awaiting),
                )
                .unwrap();
        }

        let mut left_producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml("left summary"))));
        let mut right_producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml("right summary"))));
        let left_request = HistorianReattachRequest {
            store: &store,
            session_id: left_lineage,
            project_path: "git:proj",
            observed_chunk_fingerprint: "fp",
            validation_chunk: &chunk,
            chunk_transcript: "U: left transcript",
            raw_chunk_messages: "[]",
            boundary_dates: empty_boundary_dates(),
            prior_compartments: &prior,
            validate_options: validate_options(),
            publication_floor_ordinal: 4,
            now_ms: 123,
            failure_backoff_at_ms: 999,
            completion_now_ms: || 123,
            publication_fence: None,
        };
        let right_request = HistorianReattachRequest {
            store: &store,
            session_id: right_lineage,
            project_path: "git:proj",
            observed_chunk_fingerprint: "fp",
            validation_chunk: &chunk,
            chunk_transcript: "U: right transcript",
            raw_chunk_messages: "[]",
            boundary_dates: empty_boundary_dates(),
            prior_compartments: &prior,
            validate_options: validate_options(),
            publication_floor_ordinal: 4,
            now_ms: 123,
            failure_backoff_at_ms: 999,
            completion_now_ms: || 123,
            publication_fence: None,
        };

        let (left, right) = tokio::join!(
            reattach_historian_producer(&mut left_producer, left_request),
            reattach_historian_producer(&mut right_producer, right_request),
        );

        assert!(matches!(
            left.unwrap(),
            HistorianReattachOutcome::Published(_)
        ));
        assert!(matches!(
            right.unwrap(),
            HistorianReattachOutcome::Published(_)
        ));
        assert_eq!(left_producer.observed_sessions, vec![left_producer_session]);
        assert_eq!(
            right_producer.observed_sessions,
            vec![right_producer_session]
        );
        let left_tail = store
            .load_compartments(left_lineage)
            .unwrap()
            .pop()
            .unwrap();
        let right_tail = store
            .load_compartments(right_lineage)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(left_tail.p1.as_deref(), Some("left summary"));
        assert_eq!(right_tail.p1.as_deref(), Some("right summary"));
    }

    #[tokio::test]
    async fn reattach_redrains_full_run_from_start() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            0,
            CompartmentSetGeneration {
                max_sequence: 1,
                count: 1,
            },
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(awaiting),
            )
            .unwrap();
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml("full replay summary"))));

        let outcome =
            reattach_historian_producer(&mut producer, reattach_request(&store, &chunk, &prior))
                .await
                .unwrap();

        assert!(matches!(outcome, HistorianReattachOutcome::Published(_)));
        assert!(
            producer.observed_starts.is_empty(),
            "re-draining from the start is a subscribe-only reattach, not a new send"
        );
        assert_eq!(producer.await_run_ids, vec!["run-1"]);
        let c2 = store.load_compartments("ses").unwrap().pop().unwrap();
        assert_eq!(c2.p1.as_deref(), Some("full replay summary"));
    }

    #[tokio::test]
    async fn reattach_missing_abandons_and_releases_single_flight() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            0,
            CompartmentSetGeneration::default(),
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(awaiting),
            )
            .unwrap();
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let mut producer = ScriptedProducer::default().with_status(Ok(RunState::Missing {
            detail: Some("gone".into()),
        }));

        let outcome =
            reattach_historian_producer(&mut producer, reattach_request(&store, &chunk, &prior))
                .await
                .unwrap();
        assert_eq!(
            outcome,
            HistorianReattachOutcome::RefireEligible { firing_seq: 1 }
        );
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert!(matches!(
            fire(
                &state,
                2,
                4,
                "fp2".into(),
                Vec::new(),
                0,
                CompartmentSetGeneration::default(),
                2,
                None,
            )
            .unwrap(),
            FireOutcome::Fired(_)
        ));
    }

    #[tokio::test]
    async fn producer_timeout_redrain_recovers_completed_run_without_abandon() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Err(HistorianProducerError::TimedOut))
            .with_output(Ok(producer_output(historian_xml("recovered summary"))));

        let outcome = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, HistorianDriveOutcome::Completed(_)));
        assert_eq!(producer.await_run_ids, vec!["run-1", "run-1"]);
        assert!(
            producer.cancels.is_empty(),
            "successful recovery must not abandon the run"
        );
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(state.failure_backoff_at_ms, None);
        assert_eq!(state.last_failure, None);
        let c2 = store.load_compartments("ses").unwrap().pop().unwrap();
        assert_eq!(c2.p1.as_deref(), Some("recovered summary"));
    }

    #[tokio::test]
    async fn producer_timeout_recovery_timeout_abandons_and_best_effort_cancels() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Err(HistorianProducerError::TimedOut))
            .with_output(Err(HistorianProducerError::TimedOut));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.await_run_ids, vec!["run-1", "run-1"]);
        assert_eq!(producer.cancels, vec!["run-1"]);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        let detail = state.last_failure.expect("failure detail recorded");
        assert!(
            detail.contains("timed out; recovery re-drain also failed")
                && detail.contains("prov/model-a"),
            "durable failure detail keeps the timeout + recovery cause: {detail}"
        );
    }

    #[tokio::test]
    async fn producer_timeout_recovery_run_mismatch_abandons() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Err(HistorianProducerError::TimedOut))
            .with_output(Err(HistorianProducerError::TerminalRunMismatch {
                expected: "run-1".into(),
                found: Some("run-other".into()),
            }));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(producer.await_run_ids, vec!["run-1", "run-1"]);
        assert_eq!(producer.cancels, vec!["run-1"]);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        let detail = state.last_failure.expect("failure detail recorded");
        assert!(
            detail.contains("timed out; recovery re-drain also failed")
                && detail.contains("run-1 received terminal control unit"),
            "a replay terminal for another run id must not publish this firing: {detail}"
        );
    }

    #[tokio::test]
    async fn length_capped_closed_output_is_rejected_before_publish() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut capped = producer_output(historian_xml("closed but incomplete summary"));
        capped.length_capped = true;
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-cap")))
            .with_output(Ok(capped));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Validation(_)));
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert!(state
            .last_failure
            .as_deref()
            .is_some_and(|detail| detail.contains("length cap")));
    }

    #[tokio::test]
    async fn truncated_output_validation_reject_records_cap_hint() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        // A document cut mid-XML with the length flag set, the exact shape a
        // max-output-capped model step produces under a completed run terminal.
        let mut truncated = producer_output(historian_xml("truncated summary"));
        truncated.text.truncate(truncated.text.len() / 2);
        truncated.length_capped = true;
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-cap")))
            .with_output(Ok(truncated));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Validation(_)));
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        let detail = state.last_failure.expect("validate reject records detail");
        assert!(
            detail.contains("validate rejected") && detail.contains("length cap"),
            "truncation self-diagnoses from the state dump: {detail}"
        );
    }

    #[tokio::test]
    async fn producer_start_failure_records_durable_detail() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer =
            ScriptedProducer::default().with_start(Err(HistorianProducerError::Subc(
                subc_protocol::ErrorBody::new("route_rejected", "no such module").into(),
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Producer(_)));
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        let detail = state.last_failure.expect("failure detail recorded");
        assert!(
            detail.contains("producer start") && detail.contains("route_rejected"),
            "connect/bind-class failures are diagnosable from the state dump alone: {detail}"
        );

        // A later firing that establishes its run clears the stale detail.
        let mut ok_producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-2")))
            .with_output(Ok(producer_output(historian_xml("recovery summary"))));
        run_historian_firing(
            &mut ok_producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap();
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(
            state.last_failure, None,
            "success clears the failure detail"
        );
    }

    #[tokio::test]
    async fn run_paused_abandons_and_refires() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "prov/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Err(HistorianProducerError::RunPaused {
                run_id: "run-1".into(),
                reason: Some("auth_required".into()),
                classification: None,
                class_field_present: false,
            }));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, HistorianDriveError::Producer(_)));
        assert_eq!(
            producer.observed_starts,
            vec![(
                historian_producer_session_id("proj", "ses", 1),
                "prov/model-a".to_string()
            )],
            "paused runs abandon the slot instead of retrying the next model"
        );
        assert_eq!(producer.cancels, vec!["run-1"]);
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        assert!(matches!(
            fire(
                &state,
                2,
                4,
                "fp2".into(),
                Vec::new(),
                0,
                CompartmentSetGeneration::default(),
                124,
                None,
            )
            .unwrap(),
            FireOutcome::Fired(_)
        ));
    }

    #[tokio::test]
    async fn reattach_fingerprint_mismatch_recovers_to_idle_and_releases_routes() {
        // A tail that changed under the historian makes the observed fingerprint differ
        // from the frozen one at publish time. The mismatch must abandon the firing back
        // to Idle (single source of the check lives inside publish_validated_chunk) — the
        // historian must NOT wedge in Publishing — and both routes must be released.
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            0,
            CompartmentSetGeneration {
                max_sequence: 1,
                count: 1,
            },
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(awaiting),
            )
            .unwrap();
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml(
                "summary for a changed tail",
            ))));

        // observed fingerprint diverges from the stored "fp" — a tail change since firing.
        let request = HistorianReattachRequest {
            store: &store,
            session_id: "ses",
            project_path: "git:proj",
            observed_chunk_fingerprint: "fp-changed",
            validation_chunk: &chunk,
            chunk_transcript: "U: transcript",
            raw_chunk_messages: "[]",
            boundary_dates: empty_boundary_dates(),
            prior_compartments: &prior,
            validate_options: validate_options(),
            publication_floor_ordinal: 4,
            now_ms: 123,
            failure_backoff_at_ms: 999,
            completion_now_ms: || 123,
            publication_fence: None,
        };
        let err = reattach_historian_producer(&mut producer, request)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            HistorianDriveError::State(HistorianStateError::FingerprintMismatch { .. })
        ));
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(
            state.state,
            HistorianPhase::Idle,
            "fingerprint mismatch must recover to Idle, never wedge in Publishing"
        );
        assert_eq!(state.failure_backoff_at_ms, Some(999));
        assert!(
            producer.closes >= 1,
            "routes must be released on the error path"
        );
    }

    #[tokio::test]
    async fn fresh_path_validation_rejection_releases_routes() {
        // A publish/validate failure on the fresh firing path must still release the
        // producer routes — an early `?` return before close would leak them.
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-1")))
            .with_output(Ok(producer_output(
                "not a valid historian document".to_string(),
            )));

        let err = run_historian_firing(
            &mut producer,
            fire_request(&store, "placeholder prompt", &models, &chunk, &prior),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HistorianDriveError::Validation(_)));
        assert_eq!(
            producer.closes, 1,
            "the route must be closed even when validate/publish errors out"
        );
        let state = store.load("ses").unwrap().meta.historian;
        assert_eq!(state.state, HistorianPhase::Idle);
    }

    #[tokio::test]
    async fn validation_rejection_advances_to_valid_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "other/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-invalid")))
            .with_output(Ok(producer_output(flat_historian_xml("flat primary"))))
            .with_start(Ok(run_handle("run-valid")))
            .with_output(Ok(producer_output(historian_xml("fallback summary"))));

        let mut request = fire_request(&store, "placeholder prompt", &models, &chunk, &prior);
        request.content_language = Some("tr");
        let outcome = run_historian_firing(&mut producer, request)
            .await
            .expect("a valid fallback must publish after primary validation rejection");

        let HistorianDriveOutcome::Completed(success) = outcome else {
            panic!("expected completed fallback run");
        };
        assert_eq!(success.model, "other/model-b");
        assert_eq!(producer.observed_starts.len(), 2);
        assert_eq!(producer.observed_prompts[0], "placeholder prompt");
        assert!(
            producer.observed_prompts[1].ends_with(
                "Preserve U: lines and directly quoted user text in their original source language; write the surrounding summary prose in Turkish (Türkçe)."
            ),
            "the validation retry must append quote-preserving language guidance after invalid XML"
        );
        assert!(
            producer.observed_prompts[1].contains("Previous invalid XML:\n<output>"),
            "the repair prompt must retain the rejected output as data"
        );
        assert_eq!(
            store
                .load_historian_assembly_snapshot("ses")
                .unwrap()
                .compartments
                .len(),
            2
        );
    }

    fn completion_after_long_model_run() -> i64 {
        120_000
    }

    #[tokio::test]
    async fn all_validation_rejections_preserve_final_error_and_start_cooldown_at_completion() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string(), "other/model-b".to_string()];
        let mut producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-invalid-a")))
            .with_output(Ok(producer_output(flat_historian_xml("flat primary"))))
            .with_start(Ok(run_handle("run-invalid-b")))
            .with_output(Ok(producer_output(flat_historian_xml("flat fallback"))));
        let mut request = fire_request(&store, "placeholder prompt", &models, &chunk, &prior);
        request.now_ms = 0;
        request.failure_backoff_at_ms = HISTORIAN_FAILURE_BACKOFF_MS;
        request.completion_now_ms = completion_after_long_model_run;

        let err = run_historian_firing(&mut producer, request)
            .await
            .expect_err("the final validation rejection must be returned");
        let HistorianDriveError::Validation(final_error) = err else {
            panic!("expected final validation error");
        };
        let state = store.load("ses").unwrap().meta.historian;

        assert_eq!(producer.observed_starts.len(), 2);
        assert_eq!(
            store
                .load_historian_assembly_snapshot("ses")
                .unwrap()
                .compartments
                .len(),
            1,
            "flat retries must not publish any new compartment rows"
        );
        assert_eq!(
            state.last_failure.as_deref(),
            Some(format!("validate rejected: {final_error}").as_str()),
        );
        assert_eq!(state.failure_backoff_at_ms, Some(180_000));
        assert!(
            completion_after_long_model_run() < state.failure_backoff_at_ms.unwrap(),
            "a model run longer than the cooldown must not leave immediate refire eligible"
        );
    }

    #[tokio::test]
    async fn narrative_gap_rejection_preserves_boundary_for_next_run() {
        use crate::historian_validate::ChunkLine;

        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = HistorianChunk {
            start_index: 2,
            end_index: 9,
            lines: (2..=9)
                .map(|ordinal| ChunkLine {
                    ordinal,
                    message_id: format!("m{ordinal}#0"),
                    anchorable: true,
                })
                .collect(),
            present_ordinals: (1..=9).collect(),
            tool_only_ranges: vec![],
            completed_tool_arcs: vec![],
        };
        let prior = prior_ranges();
        let models = vec!["prov/model-a".to_string()];
        let rejected_output = r#"<output><compartments>
<compartment start="2" end="2" title="first" episode_type="feature" importance="50"><p1>first</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
<compartment start="8" end="9" title="second" episode_type="feature" importance="50"><p1>second</p1><p2>second</p2><p3>second</p3><p4 /></compartment>
</compartments><meta><unprocessed_from>10</unprocessed_from></meta></output>"#;
        let mut rejected_request = fire_request(&store, "messages 2-9", &models, &chunk, &prior);
        rejected_request.to_ordinal = 9;
        let mut rejecting_producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-gap")))
            .with_output(Ok(producer_output(rejected_output.to_string())));

        let error = run_historian_firing(&mut rejecting_producer, rejected_request)
            .await
            .expect_err("a five-message narrative gap must reject");
        assert!(matches!(error, HistorianDriveError::Validation(_)));
        let after_rejection = store.load_historian_assembly_snapshot("ses").unwrap();
        assert_eq!(after_rejection.compartments.len(), 1);
        assert_eq!(after_rejection.compartments[0].end_message, 1);
        assert_eq!(
            store.load("ses").unwrap().meta.publication_floor_ordinal,
            None
        );

        // A later firing starts from the unchanged compartment boundary and can cover
        // every rejected ordinal, including the former gap at 3..=7.
        let accepted_output = r#"<output><compartments>
<compartment start="2" end="9" title="re-read" episode_type="feature" importance="50"><p1>all messages re-read</p1><p2>re-read</p2><p3>re-read</p3><p4 /></compartment>
</compartments><meta><unprocessed_from>10</unprocessed_from></meta></output>"#;
        let mut retry_request = fire_request(&store, "messages 2-9", &models, &chunk, &prior);
        retry_request.to_ordinal = 9;
        retry_request.now_ms = 1_000;
        let mut accepting_producer = ScriptedProducer::default()
            .with_start(Ok(run_handle("run-reread")))
            .with_output(Ok(producer_output(accepted_output.to_string())));
        let outcome = run_historian_firing(&mut accepting_producer, retry_request)
            .await
            .expect("the same ordinals remain publishable on the next run");

        assert!(matches!(outcome, HistorianDriveOutcome::Completed(_)));
        let after_retry = store.load_historian_assembly_snapshot("ses").unwrap();
        assert_eq!(after_retry.compartments.len(), 2);
        assert_eq!(after_retry.compartments[1].start_message, 2);
        assert_eq!(after_retry.compartments[1].end_message, 9);
        assert_eq!(
            store.load("ses").unwrap().meta.publication_floor_ordinal,
            Some(10)
        );
    }

    /// The seam-close proof: a real historian output is parsed + validated by the
    /// validation module, and the resulting `ValidatedChunk` drives the publish
    /// path end to end. This is the capstone that both parallel units are correct
    /// TOGETHER — the validator's message-id endpoints and tiers land as durable
    /// compartment rows, and the publish stays defer-invisible.
    #[test]
    fn validated_output_drives_publish_end_to_end() {
        use crate::historian_validate::{
            validate_historian_output, ChunkLine, HistorianChunk, ValidateOptions,
        };

        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // m0 already folds C1 (covers ordinal 1); ordinals 2..=4 are the chunk the
        // historian just summarized into C2.
        store
            .replace_compartments("ses", &[comp(1, 1, 1, "m1", "C1 summary")])
            .unwrap();

        let text = r#"<output>
<compartments>
<compartment start="2" end="3" title="second arc" episode_type="feature" importance="60">
<p1>second arc full and exact</p1>
<p2>second arc short</p2>
<p3>second arc</p3>
<p4 />
</compartment>
</compartments>
<facts><ARCHITECTURE>* [at_compartment=1] Publish facts in the same flow.</ARCHITECTURE></facts>
<events><causal_incident at_compartment="1"><summary>event survives</summary></causal_incident></events>
<primer_candidates><primer at_compartment="1">What did this publish preserve?</primer></primer_candidates>
<user_observations>* [at_compartment=1] The user prefers durable history.</user_observations>
<meta><messages_processed>2-3</messages_processed><unprocessed_from>4</unprocessed_from></meta>
</output>"#;
        let chunk = HistorianChunk {
            start_index: 2,
            end_index: 4,
            lines: vec![
                ChunkLine {
                    ordinal: 2,
                    message_id: "m2#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 3,
                    message_id: "m3#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 4,
                    message_id: "m4#0".into(),
                    anchorable: true,
                },
            ],
            present_ordinals: vec![1, 2, 3, 4],
            tool_only_ranges: vec![],
            completed_tool_arcs: vec![],
        };
        let prior = [crate::historian_validate::StoredCompartmentRange {
            start_message: 1,
            end_message: 1,
        }];
        let validated = validate_historian_output(
            text,
            &chunk,
            &prior,
            ValidateOptions {
                sequence_offset: 1,
                in_emergency: true, // skip discard-last so the single compartment persists
                memory_enabled: true,
                auto_promote: true,
                user_memory_collection_enabled: true,
                force_keep_last_compartment: false,
            },
        )
        .expect("validation succeeds");
        assert_eq!(validated.compartments.len(), 1);
        assert_eq!(validated.compartments[0].end_message_id, "m3#0");

        // Drive the state machine to a publishing row and publish the validated chunk.
        let mut meta = store.load("ses").unwrap().meta;
        for selected in test_selected_range_identities() {
            meta.block_identity_by_mid
                .insert(selected.mid, selected.block_identities);
        }
        meta.historian = HistorianDurableState {
            state: HistorianPhase::Publishing,
            firing_seq: 1,
            chunk_range: Some(HistorianChunkRange {
                from_ordinal: 2,
                to_ordinal: 4,
            }),
            chunk_fingerprint: "fp".into(),
            selected_range_identities: test_selected_range_identities(),
            producer_session_id: Some("ps".into()),
            producer_run_id: Some("run-1".into()),
            fired_at_ms: Some(1),
            expected_revert_epoch: 0,
            compartment_set_generation: CompartmentSetGeneration {
                max_sequence: 1,
                count: 1,
            },
            failure_backoff_at_ms: None,
            last_failure: None,
            last_no_fire: None,
            recent_decisions: Vec::new(),
            consecutive_publish_failures: 0,
        };
        let rv = store
            .commit(
                "ses",
                store.load("ses").unwrap().row_version,
                &store.load("ses").unwrap().core,
                &meta,
            )
            .unwrap();
        let predicate = publish_predicate(&meta.historian).unwrap();

        publish_validated_chunk(
            &store,
            ValidatedPublishRequest {
                session_id: "ses",
                project_path: "git:proj",
                expected_row_version: Some(rv),
                expected_revert_epoch: 0,
                predicate: &predicate,
                observed_chunk_fingerprint: "fp",
                validated: &validated,
                promote_facts: true,
                collect_user_memory_candidates: true,
                publication_floor_ordinal: 4,
                chunk_transcript: "U: transcript",
                raw_chunk_messages: "[]",
                boundary_dates: empty_boundary_dates(),
                created_at_ms: 123,
                failure_backoff_at_ms: 0,
                publication_fence: None,
            },
        )
        .expect("publish succeeds");

        // The validated compartment landed as a durable v2 row with the resolved
        // end message id and tier, and the state machine returned to idle.
        let after = store.load("ses").unwrap();
        assert_eq!(after.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(after.meta.publication_floor_ordinal, Some(4));
        let comps = store.load_compartments("ses").unwrap();
        assert_eq!(comps.len(), 2, "C1 preserved, C2 appended");
        assert_eq!(store.load_compartment_events("ses").unwrap().len(), 1);
        assert_eq!(store.load_primer_candidates("ses").unwrap().len(), 1);
        assert_eq!(store.load_user_memory_candidates("ses").unwrap().len(), 1);
        let c2 = comps.last().unwrap();
        assert_eq!(c2.end_message_id, "m3#0");
        assert_eq!(c2.p1.as_deref(), Some("second arc full and exact"));
        assert_eq!(c2.legacy, 0);
        assert_eq!(c2.created_at, 123);
        let memories = store.load_active_memories("git:proj", 0).unwrap();
        assert_eq!(memories.len(), 1);
        let fact = store.get_memory_full(memories[0].id).unwrap().unwrap();
        assert_eq!(fact.source_session_id.as_deref(), Some("ses"));
        assert_eq!(fact.first_seen_at, 123);
        assert_eq!(fact.created_at, 123);
        assert_eq!(fact.updated_at, 123);
        assert_eq!(fact.last_seen_at, 123);
    }

    #[test]
    fn publish_gates_facts_when_memory_or_auto_promote_is_off() {
        use std::collections::BTreeMap;

        for (session_id, memory_enabled, auto_promote) in
            [("memory-off", false, true), ("auto-off", true, false)]
        {
            let dir = tempfile::tempdir().unwrap();
            let store = store(dir.path());
            let loaded = store
                .commit(
                    session_id,
                    None,
                    &mc_core::CoreState::default(),
                    &test_meta_with_historian(publishing_state()),
                )
                .unwrap();
            let state = store.load(session_id).unwrap();
            let predicate = publish_predicate(&state.meta.historian).unwrap();
            let validated = ValidatedChunk {
                facts: vec![crate::historian_validate::FactCandidate {
                    category: "ARCHITECTURE".into(),
                    content: "gated fact".into(),
                    origin_compartment_index: None,
                }],
                events: vec![crate::historian_validate::ParsedEvent {
                    kind: "causal_incident".into(),
                    at_compartment: None,
                    fields: BTreeMap::from([("summary".into(), "event".into())]),
                }],
                primer_candidates: vec![crate::historian_validate::PrimerCandidate {
                    question: "What was preserved?".into(),
                    origin_compartment_index: None,
                }],
                user_observations: vec![crate::historian_validate::UserObservationCandidate {
                    content: "private observation".into(),
                    origin_compartment_index: None,
                }],
                unprocessed_from: 1,
                ..Default::default()
            };
            publish_validated_chunk(
                &store,
                ValidatedPublishRequest {
                    session_id,
                    project_path: "git:proj",
                    expected_row_version: Some(loaded),
                    expected_revert_epoch: 0,
                    predicate: &predicate,
                    observed_chunk_fingerprint: "fp",
                    validated: &validated,
                    promote_facts: memory_enabled && auto_promote,
                    collect_user_memory_candidates: false,
                    publication_floor_ordinal: 1,
                    chunk_transcript: "U: transcript",
                    raw_chunk_messages: "[]",
                    boundary_dates: empty_boundary_dates(),
                    created_at_ms: 123,
                    failure_backoff_at_ms: 0,
                    publication_fence: None,
                },
            )
            .expect("gated publication succeeds without promoting facts");

            assert!(store
                .load_active_memories("git:proj", 0)
                .unwrap()
                .is_empty());
            assert_eq!(store.load_compartment_events(session_id).unwrap().len(), 1);
            assert_eq!(store.load_primer_candidates(session_id).unwrap().len(), 1);
            assert!(store
                .load_user_memory_candidates(session_id)
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn chunk_fingerprint_uses_id_kind_and_byte_length() {
        let a = compute_chunk_fingerprint(&[
            ChunkSnapshotItem {
                id: "m1",
                kind: "user",
                bytes: "abc",
            },
            ChunkSnapshotItem {
                id: "m2",
                kind: "assistant",
                bytes: "å",
            },
        ]);
        let b = compute_chunk_fingerprint(&[
            ChunkSnapshotItem {
                id: "m1",
                kind: "user",
                bytes: "xyz",
            },
            ChunkSnapshotItem {
                id: "m2",
                kind: "assistant",
                bytes: "ø",
            },
        ]);
        assert_eq!(a, b, "same ids/kinds/byte lengths fingerprint the same");
        assert_eq!(a, "m1:user:3|m2:assistant:2");
    }

    #[test]
    fn pure_state_machine_happy_path_and_single_flight() {
        let idle = HistorianDurableState::default();
        let fired = match fire(
            &idle,
            2,
            5,
            "fp".into(),
            Vec::new(),
            0,
            CompartmentSetGeneration::default(),
            100,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => panic!("idle state must fire"),
        };
        assert_eq!(fired.state, HistorianPhase::Firing);
        assert_eq!(fired.firing_seq, 1);
        assert!(matches!(
            fire(
                &fired,
                6,
                7,
                "other".into(),
                Vec::new(),
                0,
                CompartmentSetGeneration::default(),
                101,
                None,
            )
            .unwrap(),
            FireOutcome::Busy(_)
        ));

        let awaiting = producer_started(&fired, "ps".into(), "run".into()).unwrap();
        let validating = output_received(&awaiting, "text").unwrap();
        let publishing = validation_ok(&validating).unwrap();
        let idle_again = tx_committed(&publishing).unwrap();
        assert_eq!(idle_again.state, HistorianPhase::Idle);
        assert_eq!(idle_again.firing_seq, 1);
    }

    #[test]
    fn producer_establish_clears_failure_detail_and_backoff() {
        let idle = HistorianDurableState {
            failure_backoff_at_ms: Some(999),
            last_failure: Some("stale failure".into()),
            ..HistorianDurableState::default()
        };
        let fired = match fire(
            &idle,
            2,
            5,
            "fp".into(),
            Vec::new(),
            0,
            CompartmentSetGeneration::default(),
            100,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => panic!("idle state must fire"),
        };
        assert_eq!(fired.failure_backoff_at_ms, Some(999));
        let awaiting = producer_started(&fired, "ps".into(), "run".into()).unwrap();
        assert_eq!(awaiting.failure_backoff_at_ms, None);
        assert_eq!(awaiting.last_failure, None);
    }

    #[test]
    fn fingerprint_mismatch_at_publish_abandons_and_releases_single_flight() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let meta = test_meta_with_historian(publishing_state());
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        let loaded = store.load("ses").unwrap();
        let predicate = publish_predicate(&loaded.meta.historian).unwrap();
        let abandon_hook_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let abandon_hook_calls_for_hook = std::sync::Arc::clone(&abandon_hook_calls);
        store.set_abandon_historian_hook(Box::new(move || {
            abandon_hook_calls_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let err = publish_validated_chunk(
            &store,
            ValidatedPublishRequest {
                session_id: "ses",
                project_path: "git:proj",
                expected_row_version: loaded.row_version,
                expected_revert_epoch: 0,
                predicate: &predicate,
                observed_chunk_fingerprint: "different-fingerprint",
                validated: &ValidatedChunk::default(),
                promote_facts: true,
                collect_user_memory_candidates: false,
                publication_floor_ordinal: 5,
                chunk_transcript: "U: transcript",
                raw_chunk_messages: "[]",
                boundary_dates: empty_boundary_dates(),
                created_at_ms: 0,
                failure_backoff_at_ms: 999,
                publication_fence: None,
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            HistorianStateError::FingerprintMismatch { .. }
        ));

        let after = store.load("ses").unwrap().meta.historian;
        assert_eq!(after.state, HistorianPhase::Idle);
        assert_eq!(after.failure_backoff_at_ms, Some(999));
        assert_eq!(
            abandon_hook_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "fingerprint cleanup must use the store's fenced abandon primitive"
        );
        assert!(matches!(
            fire(
                &after,
                6,
                7,
                "new".into(),
                Vec::new(),
                0,
                CompartmentSetGeneration::default(),
                1000,
                None,
            )
            .unwrap(),
            FireOutcome::Fired(_)
        ));
    }

    #[test]
    fn fire_persists_expected_revert_epoch_for_reattach() {
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            5,
            "fp".into(),
            Vec::new(),
            42,
            CompartmentSetGeneration::default(),
            100,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => panic!("idle state must fire"),
        };
        assert_eq!(fired.expected_revert_epoch, 42);
        let awaiting = producer_started(&fired, "ps".into(), "run".into()).unwrap();
        assert_eq!(awaiting.expected_revert_epoch, 42);
    }

    #[test]
    fn epoch_mismatch_publish_abandons_to_idle_with_detail() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let meta = ModuleMeta {
            revert_epoch: 1,
            ..test_meta_with_historian(publishing_state())
        };
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        let loaded = store.load("ses").unwrap();
        let predicate = publish_predicate(&loaded.meta.historian).unwrap();

        let err = publish_validated_chunk(
            &store,
            ValidatedPublishRequest {
                session_id: "ses",
                project_path: "git:proj",
                expected_row_version: loaded.row_version,
                expected_revert_epoch: 0,
                predicate: &predicate,
                observed_chunk_fingerprint: "fp",
                validated: &ValidatedChunk::default(),
                promote_facts: true,
                collect_user_memory_candidates: false,
                publication_floor_ordinal: 5,
                chunk_transcript: "U: transcript",
                raw_chunk_messages: "[]",
                boundary_dates: empty_boundary_dates(),
                created_at_ms: 0,
                failure_backoff_at_ms: 999,
                publication_fence: None,
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            HistorianStateError::Publish(HistorianPublishError::CasConflict { .. })
        ));

        let after = store.load("ses").unwrap().meta.historian;
        assert_eq!(after.state, HistorianPhase::Idle);
        assert_eq!(after.failure_backoff_at_ms, Some(999));
        assert_eq!(
            after.last_failure.as_deref(),
            Some("publish rejected: revert epoch mismatch (session was re-cut mid-firing)")
        );
        assert!(store.load_compartments("ses").unwrap().is_empty());
    }

    #[test]
    fn compartment_generation_fence_releases_overlapped_publish_to_idle() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &test_meta_with_historian(publishing_state()),
            )
            .unwrap();
        let predicate = publish_predicate(&store.load("ses").unwrap().meta.historian).unwrap();

        // This models a state-sync commit that lands after the wrapup snapshot but before
        // publication. Passing its fresh row version proves the compartment generation,
        // not just the cache CAS, rejects the stale overlapping publish.
        store
            .append_compartments("ses", &[comp(1, 2, 4, "m4#0", "seeded summary")])
            .unwrap();
        let synced = store.load("ses").unwrap();
        store
            .commit("ses", synced.row_version, &synced.core, &synced.meta)
            .unwrap();
        let fresh = store.load("ses").unwrap();

        let validated = ValidatedChunk {
            compartments: vec![crate::historian_validate::ValidatedCompartment {
                sequence: 1,
                start_message: 2,
                end_message: 4,
                start_message_id: "m2#0".to_string(),
                end_message_id: "m4#0".to_string(),
                title: "stale summary".to_string(),
                content: "stale summary".to_string(),
                p1: Some("stale summary".to_string()),
                p2: None,
                p3: None,
                p4: None,
                importance: Some(50),
                episode_type: None,
            }],
            unprocessed_from: 5,
            ..Default::default()
        };
        let error = publish_validated_chunk(
            &store,
            ValidatedPublishRequest {
                session_id: "ses",
                project_path: "git:proj",
                expected_row_version: fresh.row_version,
                expected_revert_epoch: 0,
                predicate: &predicate,
                observed_chunk_fingerprint: "fp",
                validated: &validated,
                promote_facts: false,
                collect_user_memory_candidates: false,
                publication_floor_ordinal: 5,
                chunk_transcript: "U: transcript",
                raw_chunk_messages: "[]",
                boundary_dates: empty_boundary_dates(),
                created_at_ms: 0,
                failure_backoff_at_ms: 999,
                publication_fence: None,
            },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            HistorianStateError::Publish(HistorianPublishError::FenceRejected { .. })
        ));
        let after = store.load("ses").unwrap();
        assert_eq!(after.meta.historian.state, HistorianPhase::Idle);
        assert_eq!(after.meta.historian.failure_backoff_at_ms, None);
        let compartments = store.load_compartments("ses").unwrap();
        assert_eq!(
            compartments.len(),
            1,
            "the stale publish must not append a second overlapping range"
        );
        assert!(crate::compartment_coverage::resolve_coverage(&compartments).is_ok());
    }

    #[tokio::test]
    async fn reattach_carries_durable_revert_epoch_to_publish() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        seed_prior_compartment(&store);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let fired = match fire(
            &HistorianDurableState::default(),
            2,
            4,
            "fp".into(),
            test_selected_range_identities(),
            7,
            CompartmentSetGeneration::default(),
            1,
            None,
        )
        .unwrap()
        {
            FireOutcome::Fired(state) => state,
            FireOutcome::Busy(_) => unreachable!(),
        };
        let awaiting = producer_started(&fired, "producer-session".into(), "run-1".into()).unwrap();
        store
            .commit(
                "ses",
                None,
                &CoreState::default(),
                &ModuleMeta {
                    revert_epoch: 8,
                    ..test_meta_with_historian(awaiting)
                },
            )
            .unwrap();
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Terminal))
            .with_output(Ok(producer_output(historian_xml("stale epoch summary"))));

        let err =
            reattach_historian_producer(&mut producer, reattach_request(&store, &chunk, &prior))
                .await
                .unwrap_err();
        assert!(matches!(
            err,
            HistorianDriveError::State(HistorianStateError::Publish(
                HistorianPublishError::CasConflict { .. }
            ))
        ));
        let after = store.load("ses").unwrap().meta.historian;
        assert_eq!(after.state, HistorianPhase::Idle);
        assert_eq!(
            after.last_failure.as_deref(),
            Some("publish rejected: revert epoch mismatch (session was re-cut mid-firing)")
        );
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
    }

    #[test]
    fn restart_mid_awaiting_exposes_reattach_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let awaiting = producer_started(
            &match fire(
                &HistorianDurableState::default(),
                1,
                3,
                "fp".into(),
                test_selected_range_identities(),
                0,
                CompartmentSetGeneration::default(),
                10,
                None,
            )
            .unwrap()
            {
                FireOutcome::Fired(state) => state,
                FireOutcome::Busy(_) => unreachable!(),
            },
            "producer-session".into(),
            "run-1".into(),
        )
        .unwrap();
        let meta = test_meta_with_historian(awaiting);
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();

        let action = handle_restart_load(&store, "ses", 500).unwrap();
        assert_eq!(
            action,
            RestartAction::ReattachProducer {
                producer_session_id: "producer-session".into(),
                producer_run_id: "run-1".into(),
                firing_seq: 1,
                chunk_fingerprint: "fp".into(),
            }
        );
        assert_eq!(
            store.load("ses").unwrap().meta.historian.state,
            HistorianPhase::AwaitingProducer,
            "reattach does not clear the durable single-flight"
        );
    }

    #[test]
    fn restart_mid_publishing_with_committed_tx_detects_idle() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let meta = test_meta_with_historian(publishing_state());
        store
            .commit("ses", None, &CoreState::default(), &meta)
            .unwrap();
        let loaded = store.load("ses").unwrap();
        let predicate = publish_predicate(&loaded.meta.historian).unwrap();
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: loaded.row_version,
                expected_revert_epoch: 0,
                predicate: &predicate,
                project_path: "git:proj",
                compartments: &[comp(1, 2, 4, "m4", "summary")],
                facts: &[],
                promote_facts: true,
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 5,
                chunk_transcript: Some("U: transcript"),
                raw_chunk_messages: None,
            })
            .unwrap();

        assert_eq!(
            handle_restart_load(&store, "ses", 500).unwrap(),
            RestartAction::Done
        );
        assert_eq!(
            store.load("ses").unwrap().meta.historian.state,
            HistorianPhase::Idle
        );
    }

    #[test]
    fn historian_fire_and_no_fire_meta_are_byte_invisible_to_transform() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .replace_compartments("ses", &[comp(1, 1, 1, "m1", "SUMMARY")])
            .unwrap();
        store
            .seed_memory(1, "git:proj", "ARCHITECTURE", "existing fact", 70)
            .unwrap();
        let request = req(vec![item("m1", 1, "raw"), item("t2", 2, "tail")]);
        run_transform(&store, &request);
        let before = run_transform(&store, &request);
        let wire_sha =
            |messages: &[CkWireMessage]| crate::sha256_hex(&serde_json::to_vec(messages).unwrap());
        let before_sha = wire_sha(&before);

        let loaded = store.load("ses").unwrap();
        let mut no_fire_meta = loaded.meta.clone();
        no_fire_meta
            .historian
            .record_recent_decision(HistorianRecentDecision {
                at_ms: 10,
                request_observed_at_ms: 9,
                decision: HistorianDecision::NoFire,
                cause: "below_proactive_floor".to_string(),
                eligible_tokens: 200,
                bar_tokens: 19_500,
                pressure_pct: 40,
                drain_latch: false,
                chunk_range: Some(HistorianChunkRange {
                    from_ordinal: 2,
                    to_ordinal: 2,
                }),
                producer_model: None,
                completed_at_ms: None,
                apply_row_version: None,
            });
        store
            .commit("ses", loaded.row_version, &loaded.core, &no_fire_meta)
            .unwrap();
        let after_no_fire = run_transform(&store, &request);
        assert_eq!(wire_sha(&after_no_fire), before_sha);

        let mut meta = store.load("ses").unwrap().meta;
        let selected_range_identities = vec![HistorianSelectedMessageIdentity {
            mid: "t2".to_string(),
            block_identities: meta.block_identity_by_mid["t2"].clone(),
        }];
        let mut state = publishing_state();
        let compartment_set_generation = store
            .load_historian_assembly_snapshot("ses")
            .unwrap()
            .compartment_set_generation;
        state.compartment_set_generation = compartment_set_generation;
        state.chunk_range = Some(HistorianChunkRange {
            from_ordinal: 2,
            to_ordinal: 2,
        });
        state.chunk_fingerprint = "tail-fp".into();
        state.selected_range_identities = selected_range_identities.clone();
        state.producer_run_id = Some("run-3".into());
        state.recent_decisions = meta.historian.recent_decisions.clone();
        state.record_recent_decision(HistorianRecentDecision {
            at_ms: 20,
            request_observed_at_ms: 19,
            decision: HistorianDecision::Fired,
            cause: "trigger_true:pressure".to_string(),
            eligible_tokens: 20_000,
            bar_tokens: 19_500,
            pressure_pct: 60,
            drain_latch: false,
            chunk_range: state.chunk_range.clone(),
            producer_model: Some("test/model".to_string()),
            completed_at_ms: None,
            apply_row_version: None,
        });
        meta.historian = state;
        let row_version = store
            .commit(
                "ses",
                store.load("ses").unwrap().row_version,
                &store.load("ses").unwrap().core,
                &meta,
            )
            .unwrap();
        let predicate = HistorianPublishPredicate {
            firing_seq: 3,
            producer_run_id: "run-3".into(),
            chunk_fingerprint: "tail-fp".into(),
            selected_range_identities,
            compartment_set_generation,
        };
        store
            .publish_historian_chunk(HistorianPublishRequest {
                session_id: "ses",
                expected_row_version: Some(row_version),
                expected_revert_epoch: 0,
                predicate: &predicate,
                project_path: "git:proj",
                compartments: &[],
                facts: &[FactCandidate {
                    category: "ARCHITECTURE".into(),
                    content: "existing fact".into(),
                    ..Default::default()
                }],
                promote_facts: true,
                events: &[],
                primer_candidates: &[],
                user_memory_candidates: &[],
                publication_floor_ordinal: 3,
                chunk_transcript: None,
                raw_chunk_messages: None,
            })
            .unwrap();

        let after = run_transform(&store, &request);
        assert_eq!(wire_sha(&after), before_sha);
        assert_eq!(
            after, before,
            "historian decision metadata, publication floor, and deduped facts never render"
        );
        let loaded = store.load("ses").unwrap();
        assert_eq!(loaded.meta.publication_floor_ordinal, Some(3));
        assert_eq!(loaded.meta.coverage_ordinal, Some(1));
        let fire_decision = loaded.meta.historian.recent_decisions.last().unwrap();
        assert_eq!(fire_decision.decision, HistorianDecision::Fired);
        assert!(fire_decision.completed_at_ms.is_some());
        assert_eq!(fire_decision.apply_row_version, loaded.row_version);
    }
}
