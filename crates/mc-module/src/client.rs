//! The calls ck-mc makes to a session's runner. The real module makes them
//! over the subc daemon; tests make them in process.

use std::future::Future;

use ck_contract_draft::read::{ReadPage, ReadRequest};
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
}
