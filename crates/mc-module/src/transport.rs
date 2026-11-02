//! ck-mc over the subc daemon (the CortexKit module bus that routes calls
//! between module processes): the handler that serves the provider ops, and
//! the client that calls a session's runner back.

use std::path::PathBuf;
use std::time::Duration;

use ck_contract_draft::read::{ReadPage, ReadRequest, SessionRef};
use ck_contract_draft::send::{RunResult, RunResultRequest, SendAnswer, SendRequest};
use ck_contract_draft::view::{
    AppliedViewAnswer, AppliedViewRequest, ApplyViewAnswer, ApplyViewRequest,
};
use ck_contract_draft::wire::{self, codes, PreUserRequest, ToolCallAnswer, ToolCallRequest};
use ck_contract_draft::{ops, COMPACTION_PROVIDES};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler, RequestCtx,
    SubcConsumer,
};
use subc_protocol::manifest::{
    Concurrency, ExecutionMode, IdentityScope, ModuleManifest, ProviderRole, Tool,
};
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::sync::OnceCell;

use crate::client::{ClientError, RunnerClient};
use crate::module::{Module, ModuleError};

/// How long ck-mc waits on one call to a runner.
const RUNNER_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The module's manifest: a tool provider, which is the role runners open
/// their compaction routes to.
pub fn manifest(module_id: &str) -> ModuleManifest {
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        .provides(vec![ProviderRole::ToolProvider {
            tools: vec![Tool {
                name: "ctx_reduce".into(),
                description: Some(format!(
                    "Drop tagged items you no longer need ({COMPACTION_PROVIDES})."
                )),
                execution_mode: ExecutionMode::Mutating,
                schema: json!({
                    "type": "object",
                    "properties": {"drop": {"type": "string"}},
                    "required": ["drop"],
                }),
            }],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
            emits_push: false,
            sub_supervises: false,
        }])
        .build()
}

/// Calls a session's runner over its management surface. Connects on first
/// use.
pub struct SubcRunnerClient {
    connection_file: PathBuf,
    consumer: OnceCell<SubcConsumer>,
}

impl SubcRunnerClient {
    pub fn new(connection_file: PathBuf) -> Self {
        Self {
            connection_file,
            consumer: OnceCell::new(),
        }
    }

    async fn call<P: Serialize, A: DeserializeOwned>(
        &self,
        session: &SessionRef,
        method: &str,
        params: &P,
    ) -> Result<A, ClientError> {
        let consumer = self
            .consumer
            .get_or_try_init(|| {
                SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
            })
            .await
            .map_err(|error| ClientError(format!("connect: {error:?}")))?;
        let target = RouteTarget::ManagementSurface {
            module_id: session.runner.clone(),
        };
        let options = CallOptions {
            timeout: RUNNER_CALL_TIMEOUT,
            ..CallOptions::default()
        };
        let reply = consumer
            .call(
                target,
                BindIdentity::new(session.harness.clone(), session.session.clone()),
                wire::encode(method, params),
                options,
            )
            .await
            .map_err(|error| ClientError(format!("{method}: {error:?}")))?;
        serde_json::from_slice(&reply)
            .map_err(|error| ClientError(format!("{method} answer: {error}")))
    }
}

impl RunnerClient for SubcRunnerClient {
    async fn read(&self, request: ReadRequest) -> Result<ReadPage, ClientError> {
        self.call(&request.session.clone(), ops::SESSION_READ, &request)
            .await
    }

    async fn apply_view(&self, request: ApplyViewRequest) -> Result<ApplyViewAnswer, ClientError> {
        self.call(&request.session.clone(), ops::SESSION_APPLY_VIEW, &request)
            .await
    }

    async fn applied_view(
        &self,
        request: AppliedViewRequest,
    ) -> Result<AppliedViewAnswer, ClientError> {
        self.call(
            &request.session.clone(),
            ops::SESSION_APPLIED_VIEW,
            &request,
        )
        .await
    }

    async fn send(&self, request: SendRequest) -> Result<SendAnswer, ClientError> {
        self.call(&request.session.clone(), ops::SESSION_SEND, &request)
            .await
    }

    async fn run_result(&self, request: RunResultRequest) -> Result<RunResult, ClientError> {
        self.call(&request.session.clone(), ops::RUN_RESULT, &request)
            .await
    }
}

/// Serves the provider ops for the daemon.
pub struct Handler {
    module: Module<SubcRunnerClient>,
}

impl Handler {
    pub fn new(module: Module<SubcRunnerClient>) -> Self {
        Self { module }
    }

    async fn dispatch(&self, body: &[u8]) -> Result<Value, (&'static str, String)> {
        let bad = |message: String| (codes::BAD_REQUEST, message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        let answer = match method.as_str() {
            ops::COMPACTION_SETUP => {
                to_value(self.module.setup(wire::params(params).map_err(bad)?))
            }
            ops::COMPACTION_NOTICE => {
                to_value(self.module.notice(wire::params(params).map_err(bad)?))
            }
            ops::COMPACTION_RIDE => {
                to_value(self.module.ride(wire::params(params).map_err(bad)?).await)
            }
            wire::ops::TOOL_CALL => {
                let request: ToolCallRequest = wire::params(params).map_err(bad)?;
                let answer = match self
                    .module
                    .tool(&request.session, &request.name, request.input)
                    .await
                {
                    Ok(output) => ToolCallAnswer {
                        output,
                        is_error: false,
                    },
                    Err(ModuleError::Tool(output)) => ToolCallAnswer {
                        output,
                        is_error: true,
                    },
                    Err(other) => return Err(refusal(other)),
                };
                Ok(serde_json::to_value(answer).expect("answers serialize"))
            }
            wire::ops::PRE_USER => {
                let request: PreUserRequest = wire::params(params).map_err(bad)?;
                let answer = self
                    .module
                    .pre_user(&request.session, &request.text, request.now)
                    .await;
                Ok(serde_json::to_value(answer).expect("answers serialize"))
            }
            other => {
                return Err((
                    codes::UNKNOWN_METHOD,
                    format!("ck-mc does not serve `{other}`"),
                ))
            }
        };
        answer.map_err(refusal)
    }
}

fn to_value<T: Serialize>(result: Result<T, ModuleError>) -> Result<Value, ModuleError> {
    result.map(|answer| serde_json::to_value(answer).expect("answers serialize"))
}

fn refusal(error: ModuleError) -> (&'static str, String) {
    match error {
        ModuleError::UnknownSession => (codes::UNKNOWN_SESSION, "no Setup for this session".into()),
        other => (codes::REFUSED, format!("{other:?}")),
    }
}

#[async_trait]
impl ModuleHandler for Handler {
    async fn handle(&self, _ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        match self.dispatch(&body).await {
            Ok(answer) => {
                HandlerOutcome::Response(serde_json::to_vec(&answer).expect("answers serialize"))
            }
            Err((code, message)) => HandlerOutcome::Error {
                code: code.into(),
                message,
            },
        }
    }
}
