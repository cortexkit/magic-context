//! The calls ck-mc makes to a session's runner. The real module makes them
//! through the subc daemon, the CortexKit module bus that routes calls
//! between module processes ([`crate::transport`]); tests make them in
//! process.

use std::future::Future;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

/// A child session of ck-mc's own on a session's runner, where a summarizer
/// run happens. The route to it is opened under ck-mc's child scope for the
/// session's project folder ([`crate::child_scopes`]); the runner creates the
/// child in that folder on its first send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Child {
    /// The child's runner and harness are its parent's.
    pub session: SessionRef,
    /// The parent session's project folder. A real runner refuses a child
    /// without one.
    pub project_root: Option<String>,
}

/// A call to the runner that got no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientError(pub String);

/// Each call concerns one session: the transport sends it on a route bound to
/// that session, so the request itself never names it.
pub trait RunnerClient: Send + Sync + 'static {
    /// `session.read`.
    fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> impl Future<Output = Result<ReadPage, ClientError>> + Send;
    /// `session.apply_view`.
    fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> impl Future<Output = Result<ApplyViewAnswer, ClientError>> + Send;
    /// `session.applied_view`.
    fn applied_view(
        &self,
        session: &SessionRef,
    ) -> impl Future<Output = Result<AppliedViewAnswer, ClientError>> + Send;
    /// `session.send`, llm-runner's, on the session's own route: a reminder.
    fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendReply, ClientError>> + Send;
    /// `session.send` on a child's route: it starts a summarizer run.
    fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendReply, ClientError>> + Send;
    /// `run.result` on the child's route the run started on.
    fn child_result(
        &self,
        child: &Child,
        request: RunResultRequest,
    ) -> impl Future<Output = Result<RunResult, ClientError>> + Send;
    /// One call to the Synapse module's management surface on the session's
    /// behalf, for `ctx_search`'s rerank (`models.list`, `rerank.score`),
    /// within [`crate::search::rerank::SYNAPSE_DEADLINE`]. The answer is the
    /// reply's JSON; an error is a fixed reason for the log, such as the
    /// module's refusal code. Without Synapse every search keeps its
    /// ordinary ranking, which is the default here.
    fn synapse_call(
        &self,
        _session: &SessionRef,
        _method: &str,
        _params: serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send {
        async { Err("missing_synapse".to_owned()) }
    }
}
