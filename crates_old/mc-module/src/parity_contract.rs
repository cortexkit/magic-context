//! Versioned declarations for host-neutral parity slices, not new serving endpoints.
//!
//! Existing provider requests, transforms and tool facades do not use these registrations.
//! Bridges supply native facts and apply native actions; core owns policy and durable state.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use mc_store::parity_schema_manifest::{
    ArchiveCoverage, Availability, BackgroundTask, CapabilityReason, CapabilityResult, ContentHash,
    EmbeddingIdentity, Generation, InputOrigin, InvocationId, MessageId, MessageOrdinal,
    OrdinalBase, OrdinalRange, ParityStoreAccess, ParityStoreApi, PartId, ProjectId, Provenance,
    RawArchiveBatch, RawMessage, SessionId, StoreScope, TranscriptRole, PARITY_CONTRACT_VERSION,
};

pub type CallbackFuture<'a, T> = Pin<Box<dyn Future<Output = CapabilityResult<T>> + Send + 'a>>;

/// This binding is supplied by authenticated transport, never deserialized from tool arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteIdentity {
    scope: StoreScope,
    harness: InputOrigin,
}

impl RouteIdentity {
    /// The caller must obtain this scope from the authenticated route, not a request payload.
    pub fn from_authenticated_route(scope: StoreScope, harness: InputOrigin) -> Self {
        Self { scope, harness }
    }

    pub fn scope(&self) -> &StoreScope {
        &self.scope
    }

    pub fn harness(&self) -> &InputOrigin {
        &self.harness
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRole {
    Compaction,
    Transform,
    Tools,
    ResponseObserver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LifecycleMethod {
    #[serde(rename = "compaction.setup")]
    CompactionSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Head,
    Worker,
    Historian,
    Dreamer,
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub contract_version: u32,
    pub route: RouteIdentity,
    pub invocation: InvocationId,
    pub config_generation: Generation,
    pub control: CallbackControl,
}

/// Callback cancellation and deadlines travel outside model-authored JSON.
#[derive(Debug, Clone)]
pub struct CallbackControl {
    pub deadline_at_ms: i64,
    cancelled: Arc<AtomicBool>,
}

impl CallbackControl {
    pub fn new(deadline_at_ms: i64) -> Self {
        Self {
            deadline_at_ms,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelDescriptor {
    pub provider: String,
    pub model: String,
    pub variant: Option<String>,
    pub supports_temperature: Option<bool>,
    pub supports_vision: Option<bool>,
    pub soft_input_tokens: Option<u64>,
    pub hard_context_tokens: Option<u64>,
    pub reserved_output_tokens: Option<u64>,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionSetupRequest {
    pub agent_role: AgentRole,
    pub model: ModelDescriptor,
    pub source_revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreDirective {
    pub id: InvocationId,
    pub kind: String,
    pub source: Provenance,
    pub payload_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecycleResult {
    pub method: LifecycleMethod,
    pub generation: Generation,
    pub items: Vec<Value>,
    pub tools: Vec<ProviderTool>,
    pub published_boundary: Option<MessageOrdinal>,
    pub directives: Vec<CoreDirective>,
}

pub trait LifecycleCallbacks: Send + Sync {
    fn availability(&self, role: ProviderRole) -> Availability;
    fn compaction_setup<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a CompactionSetupRequest,
    ) -> CallbackFuture<'a, LifecycleResult>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedToolArc {
    pub invocation: InvocationId,
    pub call_message: MessageId,
    pub result_message: MessageId,
    pub tool_name: String,
    pub argument_bytes: Vec<u8>,
    pub result_bytes: Vec<u8>,
    pub source: Provenance,
}

pub trait ResponseObserver: Send + Sync {
    fn availability(&self) -> Availability;
    fn observe<'a>(
        &'a self,
        context: &'a RequestContext,
        arc: &'a ObservedToolArc,
    ) -> CallbackFuture<'a, InvocationId>;
}

pub trait BridgeActions: Send + Sync {
    fn apply<'a>(
        &'a self,
        context: &'a RequestContext,
        directive: &'a CoreDirective,
    ) -> CallbackFuture<'a, InvocationId>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalSource {
    Memory,
    RawMessage,
    Compartment,
    GitCommit,
    Primer,
    Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalIntent {
    Explicit,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetrievalRequest {
    pub query: String,
    pub intent: RetrievalIntent,
    pub limit: u32,
    pub start_at_ms: Option<i64>,
    pub end_at_ms_inclusive: Option<i64>,
    pub ordinal_cutoff: Option<MessageOrdinal>,
    pub visible_memory_ids: Vec<u64>,
    pub embedding: Option<EmbeddingIdentity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetrievalHit {
    pub source: RetrievalSource,
    pub source_id: String,
    pub provenance: Provenance,
    pub ordinal: Option<MessageOrdinal>,
    pub score: f64,
    pub text: String,
}

pub trait RetrievalLane: Send + Sync {
    fn source(&self) -> RetrievalSource;
    fn availability(&self) -> Availability;
    fn retrieve<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a RetrievalRequest,
    ) -> CallbackFuture<'a, Vec<RetrievalHit>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingInputKind {
    Query,
    Passage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingInput {
    pub source: Provenance,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingRequest {
    pub identity: EmbeddingIdentity,
    pub kind: EmbeddingInputKind,
    pub inputs: Vec<EmbeddingInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingResult {
    pub identity: EmbeddingIdentity,
    pub generation: Generation,
    pub vectors: Vec<mc_store::parity_schema_manifest::StoredVector>,
}

pub trait EmbeddingProvider: Send + Sync {
    fn availability(&self) -> Availability;
    fn embed<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a EmbeddingRequest,
    ) -> CallbackFuture<'a, EmbeddingResult>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedToolGrant {
    pub tool: String,
    pub allowed_roots: Vec<String>,
    pub allowed_origins: Vec<String>,
    pub may_write: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundTaskRequest {
    pub task: BackgroundTask,
    pub model_chain: Vec<ModelDescriptor>,
    pub system_prompt: String,
    pub prompt_bytes: Vec<u8>,
    pub grants: Vec<ScopedToolGrant>,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub temperature: Option<f64>,
    pub parent_invocation: Option<InvocationId>,
    pub continuation_session: Option<SessionId>,
    pub expected_sources: Vec<Provenance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundTaskResult {
    pub child_session: SessionId,
    pub invocation: InvocationId,
    pub actual_model: ModelDescriptor,
    pub reply_bytes: Vec<u8>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub generation: Generation,
}

pub trait BackgroundTaskRunner: Send + Sync {
    fn availability(&self, task: BackgroundTask) -> Availability;
    fn run<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a BackgroundTaskRequest,
    ) -> CallbackFuture<'a, BackgroundTaskResult>;
}

pub struct UnavailableTaskRunner;

impl BackgroundTaskRunner for UnavailableTaskRunner {
    fn availability(&self, _: BackgroundTask) -> Availability {
        mc_store::parity_schema_manifest::unavailable("background_task_runner")
    }

    fn run<'a>(
        &'a self,
        _: &'a RequestContext,
        _: &'a BackgroundTaskRequest,
    ) -> CallbackFuture<'a, BackgroundTaskResult> {
        Box::pin(async { CapabilityResult::unavailable("background_task_runner") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn context() -> RequestContext {
        RequestContext {
            contract_version: PARITY_CONTRACT_VERSION,
            route: RouteIdentity::from_authenticated_route(
                StoreScope {
                    project: ProjectId("project".into()),
                    session: SessionId("session".into()),
                    generation: Generation(1),
                },
                InputOrigin::Broca,
            ),
            invocation: InvocationId("invocation".into()),
            config_generation: Generation(1),
            control: CallbackControl::new(100),
        }
    }

    #[tokio::test]
    async fn every_module_stub_is_unavailable_not_empty() {
        let context = context();
        let request = RetrievalRequest {
            query: "needle".into(),
            intent: RetrievalIntent::Explicit,
            limit: 10,
            start_at_ms: None,
            end_at_ms_inclusive: None,
            ordinal_cutoff: None,
            visible_memory_ids: vec![],
            embedding: None,
        };
        let mut sources = Vec::new();
        for lane in &crate::retrieval::UNAVAILABLE_LANES {
            sources.push(lane.source());
            assert!(matches!(
                lane.availability(),
                Availability::Unavailable { .. }
            ));
            let wire = serde_json::to_value(lane.retrieve(&context, &request).await).unwrap();
            assert_eq!(wire["status"], "unavailable");
            assert_eq!(wire["reason"]["code"], "not_implemented");
            assert!(wire.get("value").is_none());
        }
        assert_eq!(
            sources,
            vec![
                RetrievalSource::Memory,
                RetrievalSource::RawMessage,
                RetrievalSource::Compartment,
                RetrievalSource::GitCommit,
                RetrievalSource::Primer,
                RetrievalSource::Note
            ]
        );
        let identity = EmbeddingIdentity {
            provider: "fixture".into(),
            model: "fixture".into(),
            dimensions: 2,
            query_recipe: "query".into(),
            passage_recipe: "passage".into(),
            fingerprint: "fingerprint".into(),
            epoch: 1,
        };
        let provider = &crate::retrieval::UNAVAILABLE_EMBEDDING;
        assert!(matches!(
            provider.availability(),
            Availability::Unavailable { .. }
        ));
        for kind in [EmbeddingInputKind::Query, EmbeddingInputKind::Passage] {
            assert!(matches!(
                provider
                    .embed(
                        &context,
                        &EmbeddingRequest {
                            identity: identity.clone(),
                            kind,
                            inputs: vec![],
                        }
                    )
                    .await,
                CapabilityResult::Unavailable { .. }
            ));
        }
        let runner = UnavailableTaskRunner;
        for task in [
            BackgroundTask::Map,
            BackgroundTask::Verify,
            BackgroundTask::Curate,
            BackgroundTask::Classify,
            BackgroundTask::Retrospective,
            BackgroundTask::MaintainDocs,
            BackgroundTask::Primers,
            BackgroundTask::EvaluateSmartNotes,
            BackgroundTask::ReviewUserMemories,
            BackgroundTask::CompressMuralCues,
            BackgroundTask::ExpireMemories,
            BackgroundTask::Historian,
            BackgroundTask::HistorianEditor,
            BackgroundTask::Recomp,
        ] {
            assert!(matches!(
                runner.availability(task.clone()),
                Availability::Unavailable { .. }
            ));
            assert!(matches!(
                runner
                    .run(
                        &context,
                        &BackgroundTaskRequest {
                            task,
                            model_chain: vec![],
                            system_prompt: String::new(),
                            prompt_bytes: vec![],
                            grants: vec![],
                            max_input_tokens: 1,
                            max_output_tokens: 1,
                            temperature: None,
                            parent_invocation: None,
                            continuation_session: None,
                            expected_sources: vec![],
                        }
                    )
                    .await,
                CapabilityResult::Unavailable { .. }
            ));
        }
    }

    #[test]
    fn ordinal_base_and_partial_coverage_survive_wire_roundtrip() {
        let ordinal = MessageOrdinal {
            value: 1,
            base: OrdinalBase::One,
        };
        let batch = RawArchiveBatch {
            scope: context().route.scope().clone(),
            invocation: InvocationId("call".into()),
            source_revision: "revision".into(),
            messages: vec![],
            deleted_ids: vec![MessageId("deleted".into())],
            coverage: ArchiveCoverage::Partial {
                through: Some(ordinal),
                reason: CapabilityReason {
                    code: "read_gap".into(),
                    message: "source page missing".into(),
                },
            },
        };
        let bytes = serde_json::to_vec(&batch).unwrap();
        assert_eq!(
            serde_json::from_slice::<RawArchiveBatch>(&bytes).unwrap(),
            batch
        );
        let wire: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(wire["coverage"]["through"]["base"], "one");
        assert_eq!(wire["coverage"]["status"], "partial");
        let control = context().control;
        let clone = control.clone();
        assert!(!clone.is_cancelled());
        control.cancel();
        assert!(clone.is_cancelled());
    }

    #[test]
    fn disposition_covers_inventory_and_names_host_inputs() {
        let inventory = include_str!("tests/fixtures/rust-parity-inventory.md");
        let manifest: Value =
            serde_json::from_str(include_str!("tests/fixtures/rust-parity-disposition.json"))
                .unwrap();
        let inventory_ids: Vec<&str> = inventory
            .lines()
            .filter_map(|line| {
                let id = line.strip_prefix("| ")?.split(" ·").next()?;
                (id.len() == 3
                    && id.as_bytes()[0].is_ascii_uppercase()
                    && id.as_bytes()[1..].iter().all(u8::is_ascii_digit))
                .then_some(id)
            })
            .collect();
        assert_eq!(inventory_ids.len(), 98);
        let expected: BTreeSet<_> = inventory_ids.into_iter().collect();
        assert_eq!(expected.len(), 98, "inventory has duplicate capability IDs");
        let rows = manifest["capabilities"].as_array().unwrap();
        assert_eq!(rows.len(), 98);
        let actual: BTreeSet<_> = rows.iter().map(|row| row["id"].as_str().unwrap()).collect();
        assert_eq!(
            actual, expected,
            "disposition IDs must match the inventory exactly"
        );
        let inputs = manifest["host_inputs"].as_object().unwrap();
        for row in rows {
            assert!([
                "rust_core",
                "thalamus_bridge",
                "retained_typescript_transitional",
                "retired"
            ]
            .contains(&row["disposition"].as_str().unwrap()));
            assert!(!row["target"].as_str().unwrap().is_empty());
            let dependencies = row["host_inputs"].as_array().unwrap();
            assert!(
                !dependencies.is_empty(),
                "{} has unnamed host dependencies",
                row["id"]
            );
            for dependency in dependencies {
                assert!(
                    inputs.contains_key(dependency.as_str().unwrap()),
                    "unknown host input {dependency}"
                );
            }
        }
        for input in inputs.values() {
            for field in ["input", "current_source", "target"] {
                assert!(!input[field].as_str().unwrap().is_empty());
            }
        }
        let extensions = manifest["extension_points"].as_array().unwrap();
        for slice in ["1A", "1B", "1C", "1D", "1E", "1F"] {
            let entry = extensions
                .iter()
                .find(|entry| entry["slice"] == slice)
                .unwrap();
            assert!(!entry["seam"].as_str().unwrap().is_empty());
            assert!(!entry["owned_files"].as_array().unwrap().is_empty());
        }
    }
}
