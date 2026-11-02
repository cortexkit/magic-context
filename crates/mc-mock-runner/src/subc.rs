//! The mock runner over the subc daemon (the CortexKit module bus that
//! routes calls between module processes). It serves the runner ops a
//! compaction provider calls back (`session.read`, `view.publish`,
//! `view.current`), plus `mock.play`, which plays one scenario against the
//! provider over the wire and answers with the run's report.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ck_contract_draft::notice::{NoticeAnswer, NoticeRequest};
use ck_contract_draft::ops;
use ck_contract_draft::read::{ReadRequest, SessionRef};
use ck_contract_draft::ride::{RideAnswer, RideRequest};
use ck_contract_draft::send::SendRequest;
use ck_contract_draft::setup::{SetupAnswer, SetupRequest};
use ck_contract_draft::view::{View, ViewCurrentRequest, ViewGetRequest, ViewPublishRequest};
use ck_contract_draft::wire::{
    self, codes, PreUserAnswer, PreUserRequest, ToolCallAnswer, ToolCallRequest,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler, RequestCtx,
    SubcConsumer,
};
use subc_protocol::manifest::{
    Concurrency, IdentityScope, ManagementOperation, ManagementOperationKind, ModuleManifest,
    ProviderRole,
};
use subc_protocol::{BindIdentity, RouteTarget};

use crate::runner::{CallError, Host, Provider, Report, Runner, SessionConfig, UserEdit};
use crate::script::Step;

/// Plays a scenario: the mock runner's own test op.
pub const MOCK_PLAY: &str = "mock.play";

/// How long the runner waits on one call to the provider. Rides carry their
/// own, shorter deadline inside the request.
const PROVIDER_CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayRequest {
    pub config: SessionConfig,
    pub steps: Vec<Step>,
}

/// The runner's calls to a compaction provider module.
pub struct SubcProvider {
    consumer: SubcConsumer,
    provider: String,
}

impl SubcProvider {
    pub async fn connect(
        connection_file: &std::path::Path,
        provider: String,
    ) -> Result<Self, CallError> {
        let consumer = SubcConsumer::connect(connection_file, ConsumerOptions::default())
            .await
            .map_err(|error| CallError(format!("connect: {error:?}")))?;
        Ok(Self { consumer, provider })
    }

    async fn call<P: Serialize, A: DeserializeOwned>(
        &self,
        session: &SessionRef,
        method: &str,
        params: &P,
    ) -> Result<A, CallError> {
        let options = CallOptions {
            timeout: PROVIDER_CALL_TIMEOUT,
            ..CallOptions::default()
        };
        let reply = self
            .consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: self.provider.clone(),
                },
                BindIdentity::new(session.harness.clone(), session.session.clone()),
                wire::encode(method, params),
                options,
            )
            .await
            .map_err(|error| CallError(format!("{method}: {error:?}")))?;
        serde_json::from_slice(&reply)
            .map_err(|error| CallError(format!("{method} answer: {error}")))
    }
}

impl Provider for SubcProvider {
    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.call(&request.session.clone(), ops::COMPACTION_SETUP, &request)
            .await
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        self.call(&request.session.clone(), ops::COMPACTION_NOTICE, &request)
            .await
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.call(&request.session.clone(), ops::COMPACTION_RIDE, &request)
            .await
    }

    async fn view_get(&self, request: ViewGetRequest) -> Result<View, CallError> {
        self.call(&request.session.clone(), ops::VIEW_GET, &request)
            .await
    }

    async fn tool(
        &self,
        session: &SessionRef,
        name: &str,
        input: &Value,
    ) -> Result<String, CallError> {
        let request = ToolCallRequest {
            session: session.clone(),
            name: name.to_owned(),
            input: input.clone(),
        };
        let answer: ToolCallAnswer = self.call(session, wire::ops::TOOL_CALL, &request).await?;
        if answer.is_error {
            Err(CallError(answer.output))
        } else {
            Ok(answer.output)
        }
    }

    async fn pre_user(&self, session: &SessionRef, text: &str) -> Result<UserEdit, CallError> {
        let request = PreUserRequest {
            session: session.clone(),
            text: text.to_owned(),
        };
        let answer: PreUserAnswer = self.call(session, wire::ops::PRE_USER, &request).await?;
        Ok(UserEdit {
            prepend: answer.prepend,
            append: answer.append,
        })
    }
}

/// The module's manifest: a management surface, the role compaction
/// providers open their routes back to the runner with.
pub fn manifest(module_id: &str) -> ModuleManifest {
    let operation = |name: &str, kind| ManagementOperation {
        name: name.into(),
        kind,
        description: None,
    };
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        .provides(vec![ProviderRole::ManagementSurface {
            operations: vec![
                operation(ops::SESSION_READ, ManagementOperationKind::Query),
                operation(ops::VIEW_CURRENT, ManagementOperationKind::Query),
                operation(ops::VIEW_PUBLISH, ManagementOperationKind::Mutate),
                operation(ops::SESSION_SEND, ManagementOperationKind::Mutate),
                operation(MOCK_PLAY, ManagementOperationKind::Mutate),
            ],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
        }])
        .build()
}

/// Serves the runner ops for every session being played.
pub struct Handler {
    connection_file: PathBuf,
    provider: String,
    hosts: Arc<Mutex<HashMap<SessionRef, Host>>>,
}

impl Handler {
    pub fn new(connection_file: PathBuf, provider: String) -> Self {
        Self {
            connection_file,
            provider,
            hosts: Arc::default(),
        }
    }

    fn host(&self, session: &SessionRef) -> Result<Host, (&'static str, String)> {
        self.hosts
            .lock()
            .expect("host map")
            .get(session)
            .cloned()
            .ok_or_else(|| {
                (
                    codes::UNKNOWN_SESSION,
                    format!("no session {}", session.session),
                )
            })
    }

    async fn dispatch(&self, body: &[u8]) -> Result<Value, (&'static str, String)> {
        let bad = |message: String| (codes::BAD_REQUEST, message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        match method.as_str() {
            ops::SESSION_READ => {
                let request: ReadRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(&request.session)?.read(&request)))
            }
            ops::VIEW_PUBLISH => {
                let request: ViewPublishRequest = wire::params(params).map_err(bad)?;
                let host = self.host(&request.session)?;
                Ok(json_of(&host.publish(request)))
            }
            ops::VIEW_CURRENT => {
                let request: ViewCurrentRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(&request.session)?.current()))
            }
            ops::SESSION_SEND => {
                let request: SendRequest = wire::params(params).map_err(bad)?;
                let host = self.host(&request.session)?;
                Ok(json_of(&host.send(request)))
            }
            MOCK_PLAY => {
                let request: PlayRequest = wire::params(params).map_err(bad)?;
                let report = self
                    .play(request)
                    .await
                    .map_err(|error| (codes::REFUSED, error.0))?;
                Ok(json_of(&report))
            }
            other => Err((
                codes::UNKNOWN_METHOD,
                format!("the mock runner does not serve `{other}`"),
            )),
        }
    }

    /// Play one scenario on a thread of its own, so the runner (whose
    /// provider futures need not be `Send`) never has to cross threads.
    async fn play(&self, request: PlayRequest) -> Result<Report, CallError> {
        let connection_file = self.connection_file.clone();
        let provider = self.provider.clone();
        let hosts = Arc::clone(&self.hosts);
        let (reply, report) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a scenario runtime");
            let result = runtime.block_on(async move {
                let session = request.config.session.clone();
                let provider = SubcProvider::connect(&connection_file, provider).await?;
                let mut runner = Runner::start(request.config, provider).await?;
                hosts
                    .lock()
                    .expect("host map")
                    .insert(session.clone(), runner.host().clone());
                runner.play(&request.steps).await;
                hosts.lock().expect("host map").remove(&session);
                Ok(runner.report)
            });
            let _ = reply.send(result);
        });
        report
            .await
            .map_err(|_| CallError("the scenario thread stopped".into()))?
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

fn json_of<T: Serialize>(answer: &T) -> Value {
    serde_json::to_value(answer).expect("answers serialize")
}
