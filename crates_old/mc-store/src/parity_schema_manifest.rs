//! Additive storage contracts for Rust parity producers.
//!
//! These registrations do not open databases or participate in the existing store migrations.
//! An absent producer is unavailable, never a successful query with an empty result.

use serde::{Deserialize, Serialize};

pub const PARITY_CONTRACT_VERSION: u32 = 1;

macro_rules! string_identity {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
    )+};
}

string_identity!(
    ProjectId,
    SessionId,
    MessageId,
    PartId,
    InvocationId,
    ContentHash
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Generation(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrdinalBase {
    Zero,
    One,
}

/// Native transcript ordinals must carry their base; neither core nor bridges may guess it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageOrdinal {
    pub value: u64,
    pub base: OrdinalBase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrdinalRange {
    pub start: MessageOrdinal,
    pub end_inclusive: MessageOrdinal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoreScope {
    pub project: ProjectId,
    pub session: SessionId,
    pub generation: Generation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputOrigin {
    OpenCode,
    Pi,
    OhMyPi,
    Broca,
    Core,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub origin: InputOrigin,
    pub source_id: String,
    pub source_revision: String,
    pub content_hash: ContentHash,
    pub generation: Generation,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityReason {
    pub code: String,
    pub message: String,
}

impl CapabilityReason {
    pub fn not_implemented(component: &str) -> Self {
        Self {
            code: "not_implemented".into(),
            message: format!("{component} has no Rust parity implementation registered"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Availability {
    Available,
    Degraded { reason: CapabilityReason },
    Unavailable { reason: CapabilityReason },
}

/// The unavailable variant cannot contain data, so it cannot masquerade as empty success.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum CapabilityResult<T> {
    Available { value: T },
    Degraded { value: T, reason: CapabilityReason },
    Unavailable { reason: CapabilityReason },
}

impl<T> CapabilityResult<T> {
    pub fn unavailable(component: &str) -> Self {
        Self::Unavailable {
            reason: CapabilityReason::not_implemented(component),
        }
    }

    pub fn availability(&self) -> Availability {
        match self {
            Self::Available { .. } => Availability::Available,
            Self::Degraded { reason, .. } => Availability::Degraded {
                reason: reason.clone(),
            },
            Self::Unavailable { reason } => Availability::Unavailable {
                reason: reason.clone(),
            },
        }
    }
}

pub fn unavailable(component: &str) -> Availability {
    Availability::Unavailable {
        reason: CapabilityReason::not_implemented(component),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextSchemaRequest {
    pub database_path: String,
    pub expected_schema_version: u32,
    pub writer_generation: Generation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextSchemaReport {
    pub schema_version: u32,
    pub schema_fingerprint: ContentHash,
}

/// Implementations own bootstrap and writer exclusion, not the caller's native host storage.
pub trait ContextSchemaStore: Send + Sync {
    fn availability(&self) -> Availability;
    fn bootstrap(&self, request: &ContextSchemaRequest) -> CapabilityResult<ContextSchemaReport>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingIdentity {
    pub provider: String,
    pub model: String,
    pub dimensions: u32,
    pub query_recipe: String,
    pub passage_recipe: String,
    pub fingerprint: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredVector {
    pub source: Provenance,
    pub embedding: EmbeddingIdentity,
    pub values: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorReadRequest {
    pub scope: StoreScope,
    pub source_ids: Vec<String>,
    pub embedding: EmbeddingIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorPublishRequest {
    pub scope: StoreScope,
    pub invocation: InvocationId,
    pub vectors: Vec<StoredVector>,
}

pub trait RetrievalVectorStore: Send + Sync {
    fn availability(&self) -> Availability;
    fn read(&self, request: &VectorReadRequest) -> CapabilityResult<Vec<StoredVector>>;
    /// Accept publication only after atomically checking that source hashes, model identity
    /// and generation still match; a delayed provider reply must not overwrite newer content.
    fn publish(&self, request: &VectorPublishRequest) -> CapabilityResult<PublishReceipt>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishReceipt {
    pub generation: Generation,
    pub accepted_source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveQuery {
    pub scope: StoreScope,
    pub query: String,
    pub limit: u32,
    pub start_at_ms: Option<i64>,
    pub end_at_ms_inclusive: Option<i64>,
    pub cutoff: Option<MessageOrdinal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitCommitRecord {
    pub provenance: Provenance,
    pub sha: String,
    pub parents: Vec<String>,
    pub message: String,
    pub committed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitIngestRequest {
    pub scope: StoreScope,
    pub repository_id: String,
    pub head_sha: String,
    pub invocation: InvocationId,
    pub commits: Vec<GitCommitRecord>,
}

pub trait GitArchiveStore: Send + Sync {
    fn availability(&self) -> Availability;
    fn ingest(&self, request: &GitIngestRequest) -> CapabilityResult<PublishReceipt>;
    fn search(&self, request: &ArchiveQuery) -> CapabilityResult<Vec<GitCommitRecord>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawMessage {
    pub id: MessageId,
    pub ordinal: MessageOrdinal,
    pub role: TranscriptRole,
    pub part_ids: Vec<PartId>,
    pub tool_invocation: Option<InvocationId>,
    pub provenance: Provenance,
    /// Keep original bytes so expanding a retrieved message can recover full tool inputs,
    /// media and reasoning rather than only the searchable text.
    pub transcript_bytes: Vec<u8>,
    pub searchable_text: String,
    pub created_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub synthetic: bool,
}

/// A partial read may leave gaps, so it cannot certify that every message through an ordinal
/// has been archived. The archive implementation must verify a contiguous prefix itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArchiveCoverage {
    Complete {
        through: MessageOrdinal,
    },
    Partial {
        through: Option<MessageOrdinal>,
        reason: CapabilityReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawArchiveBatch {
    pub scope: StoreScope,
    pub invocation: InvocationId,
    pub source_revision: String,
    pub messages: Vec<RawMessage>,
    pub deleted_ids: Vec<MessageId>,
    pub coverage: ArchiveCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawReadRequest {
    pub scope: StoreScope,
    pub range: OrdinalRange,
    pub max_bytes: u64,
}

pub trait RawArchiveStore: Send + Sync {
    fn availability(&self) -> Availability;
    fn ingest(&self, request: &RawArchiveBatch) -> CapabilityResult<PublishReceipt>;
    fn read(&self, request: &RawReadRequest) -> CapabilityResult<Vec<RawMessage>>;
    fn search(&self, request: &ArchiveQuery) -> CapabilityResult<Vec<RawMessage>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTask {
    Map,
    Verify,
    Curate,
    Classify,
    Retrospective,
    MaintainDocs,
    Primers,
    EvaluateSmartNotes,
    ReviewUserMemories,
    CompressMuralCues,
    ExpireMemories,
    Historian,
    HistorianEditor,
    Recomp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DreamClaimRequest {
    pub scope: StoreScope,
    pub task: BackgroundTask,
    pub domain: String,
    pub invocation: InvocationId,
    pub now_ms: i64,
    pub lease_ms: u64,
    pub token_budget: u64,
    pub manual_force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DreamLease {
    pub scope: StoreScope,
    pub invocation: InvocationId,
    pub token: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DreamFinishRequest {
    pub lease: DreamLease,
    pub now_ms: i64,
    pub spent_tokens: u64,
    pub succeeded: bool,
}

pub trait DreamSchedulerStore: Send + Sync {
    fn availability(&self) -> Availability;
    fn claim(&self, request: &DreamClaimRequest) -> CapabilityResult<DreamLease>;
    fn heartbeat(&self, lease: &DreamLease, now_ms: i64) -> CapabilityResult<DreamLease>;
    fn finish(&self, request: &DreamFinishRequest) -> CapabilityResult<PublishReceipt>;
}

/// Callers provide store implementations through this API; importing the module does not
/// open a database, run migrations or access the implementations.
pub struct ParityStoreApi<'a> {
    pub context_schema: &'a dyn ContextSchemaStore,
    pub retrieval_vectors: &'a dyn RetrievalVectorStore,
    pub git_archive: &'a dyn GitArchiveStore,
    pub raw_archive: &'a dyn RawArchiveStore,
    pub dream_scheduler: &'a dyn DreamSchedulerStore,
}

pub trait ParityStoreAccess: Send + Sync {
    fn parity_stores(&self) -> ParityStoreApi<'_>;
}

pub struct UnavailableParityStore;

impl ParityStoreAccess for UnavailableParityStore {
    fn parity_stores(&self) -> ParityStoreApi<'_> {
        unavailable_stores()
    }
}

pub fn unavailable_stores() -> ParityStoreApi<'static> {
    ParityStoreApi {
        context_schema: &crate::context_schema::UNAVAILABLE,
        retrieval_vectors: &crate::retrieval_vectors::UNAVAILABLE,
        git_archive: &crate::git_archive::UNAVAILABLE,
        raw_archive: &crate::archive_index::UNAVAILABLE,
        dream_scheduler: &crate::dream_scheduler::UNAVAILABLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_unavailable<T: Serialize>(result: CapabilityResult<T>) {
        assert!(matches!(
            result.availability(),
            Availability::Unavailable { .. }
        ));
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire["status"], "unavailable");
        assert_eq!(wire["reason"]["code"], "not_implemented");
        assert!(!wire["reason"]["message"].as_str().unwrap().is_empty());
        assert!(
            wire.get("value").is_none(),
            "unavailable must not encode empty success"
        );
    }

    #[test]
    fn every_store_stub_is_unavailable_not_empty() {
        let api = UnavailableParityStore.parity_stores();
        for availability in [
            api.context_schema.availability(),
            api.retrieval_vectors.availability(),
            api.git_archive.availability(),
            api.raw_archive.availability(),
            api.dream_scheduler.availability(),
        ] {
            assert!(matches!(availability, Availability::Unavailable { .. }));
        }
        let scope = StoreScope {
            project: ProjectId("project".into()),
            session: SessionId("session".into()),
            generation: Generation(1),
        };
        let invocation = InvocationId("invocation".into());
        let ordinal = MessageOrdinal {
            value: 1,
            base: OrdinalBase::One,
        };
        let query = ArchiveQuery {
            scope: scope.clone(),
            query: "needle".into(),
            limit: 10,
            start_at_ms: None,
            end_at_ms_inclusive: None,
            cutoff: Some(ordinal),
        };
        let identity = EmbeddingIdentity {
            provider: "fixture".into(),
            model: "fixture".into(),
            dimensions: 2,
            query_recipe: "query".into(),
            passage_recipe: "passage".into(),
            fingerprint: "fingerprint".into(),
            epoch: 1,
        };
        assert_unavailable(api.context_schema.bootstrap(&ContextSchemaRequest {
            database_path: "/nonexistent/context.db".into(),
            expected_schema_version: 1,
            writer_generation: Generation(1),
        }));
        assert_unavailable(api.retrieval_vectors.read(&VectorReadRequest {
            scope: scope.clone(),
            source_ids: vec!["memory:1".into()],
            embedding: identity,
        }));
        assert_unavailable(api.retrieval_vectors.publish(&VectorPublishRequest {
            scope: scope.clone(),
            invocation: invocation.clone(),
            vectors: vec![],
        }));
        assert_unavailable(api.git_archive.ingest(&GitIngestRequest {
            scope: scope.clone(),
            repository_id: "repo".into(),
            head_sha: "head".into(),
            invocation: invocation.clone(),
            commits: vec![],
        }));
        assert_unavailable(api.git_archive.search(&query));
        assert_unavailable(api.raw_archive.ingest(&RawArchiveBatch {
            scope: scope.clone(),
            invocation: invocation.clone(),
            source_revision: "revision".into(),
            messages: vec![],
            deleted_ids: vec![],
            coverage: ArchiveCoverage::Complete { through: ordinal },
        }));
        assert_unavailable(api.raw_archive.read(&RawReadRequest {
            scope: scope.clone(),
            range: OrdinalRange {
                start: ordinal,
                end_inclusive: ordinal,
            },
            max_bytes: 1024,
        }));
        assert_unavailable(api.raw_archive.search(&query));
        assert_unavailable(api.dream_scheduler.claim(&DreamClaimRequest {
            scope: scope.clone(),
            task: BackgroundTask::Classify,
            domain: "memory".into(),
            invocation: invocation.clone(),
            now_ms: 0,
            lease_ms: 100,
            token_budget: 100,
            manual_force: false,
        }));
        let lease = DreamLease {
            scope,
            invocation,
            token: "token".into(),
            expires_at_ms: 100,
        };
        assert_unavailable(api.dream_scheduler.heartbeat(&lease, 1));
        assert_unavailable(api.dream_scheduler.finish(&DreamFinishRequest {
            lease,
            now_ms: 1,
            spent_tokens: 0,
            succeeded: false,
        }));
    }

    #[test]
    fn unavailable_wire_cannot_carry_empty_results() {
        let malformed = serde_json::json!({
            "status": "unavailable", "value": [],
            "reason": { "code": "not_implemented", "message": "absent" }
        });
        assert!(serde_json::from_value::<CapabilityResult<Vec<RawMessage>>>(malformed).is_err());
        let empty = CapabilityResult::<Vec<RawMessage>>::Available { value: vec![] };
        assert_eq!(empty.availability(), Availability::Available);
        let degraded = CapabilityResult::Degraded {
            value: vec![1],
            reason: CapabilityReason {
                code: "provider_offline".into(),
                message: "lexical only".into(),
            },
        };
        assert!(matches!(
            degraded.availability(),
            Availability::Degraded { .. }
        ));
    }
}
