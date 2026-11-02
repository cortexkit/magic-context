//! The calls ck-mc makes to a session's runner. The real module makes them
//! through the subc daemon, the CortexKit module bus that routes calls
//! between module processes ([`crate::transport`]); tests make them in
//! process.

use std::future::Future;

use ck_contract_draft::read::{ReadPage, ReadRequest};
use ck_contract_draft::send::{RunResult, RunResultRequest, SendAnswer, SendRequest};
use ck_contract_draft::view::{
    ViewCurrentAnswer, ViewCurrentRequest, ViewPublishAnswer, ViewPublishRequest,
};

/// A call to the runner that got no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientError(pub String);

pub trait RunnerClient: Send + Sync + 'static {
    /// `session.read`.
    fn read(
        &self,
        request: ReadRequest,
    ) -> impl Future<Output = Result<ReadPage, ClientError>> + Send;
    /// `view.publish`.
    fn publish(
        &self,
        request: ViewPublishRequest,
    ) -> impl Future<Output = Result<ViewPublishAnswer, ClientError>> + Send;
    /// `view.current`.
    fn current(
        &self,
        request: ViewCurrentRequest,
    ) -> impl Future<Output = Result<ViewCurrentAnswer, ClientError>> + Send;
    /// `session.send`.
    fn send(
        &self,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendAnswer, ClientError>> + Send;
    /// `run.result`.
    fn run_result(
        &self,
        request: RunResultRequest,
    ) -> impl Future<Output = Result<RunResult, ClientError>> + Send;
}
