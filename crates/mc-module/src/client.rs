//! The calls ck-mc makes to a session's runner. The real module makes them
//! through the subc daemon, the CortexKit module bus that routes calls
//! between module processes ([`crate::transport`]); tests make them in
//! process.

use std::future::Future;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

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
    /// `session.send`, llm-runner's. A summarizer run goes to a child session
    /// of ck-mc's own, named by `session`; a reminder goes to the session it
    /// is for.
    fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendReply, ClientError>> + Send;
    /// `run.result`, llm-runner's, on the session the run is in.
    fn run_result(
        &self,
        session: &SessionRef,
        request: RunResultRequest,
    ) -> impl Future<Output = Result<RunResult, ClientError>> + Send;
}
