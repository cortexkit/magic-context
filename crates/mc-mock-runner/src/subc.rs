//! The mock runner over the subc daemon (the CortexKit module bus that
//! routes calls between module processes). It serves the runner ops a
//! compaction provider calls back (`session.read`, `session.apply_view`,
//! `session.applied_view`, `session.send`, `run.result`), plus `mock.play`,
//! which plays one scenario against the provider over the wire and answers
//! with the run's report.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ck_contract_draft::notice::{NoticeAnswer, NoticeRequest};
use ck_contract_draft::ops;
use ck_contract_draft::read::{ReadRequest, SessionRef};
use ck_contract_draft::ride::{RideAnswer, RideRequest};
use ck_contract_draft::send::{RunResultRequest, SendRequest};
use ck_contract_draft::setup::{SetupAnswer, SetupRequest};
use ck_contract_draft::view::{AppliedViewRequest, ApplyViewRequest};
use ck_contract_draft::wire::{
    self, codes, PreUserAnswer, PreUserRequest, ToolCallAnswer, ToolCallRequest,
};
use ck_contract_draft::COMPACTION_ROLE;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, BindDecision, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler,
    RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_protocol::manifest::{
    Concurrency, IdentityScope, ManagementOperation, ManagementOperationKind, ModuleManifest,
    ProviderRole,
};
use subc_protocol::{BindIdentity, Principal, RouteTarget};

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

/// The roles a runner opens routes for, one route per role and session.
#[derive(Clone, Copy)]
enum Role {
    Compaction,
    Tools,
    Hooks,
}

impl Role {
    fn versions(self) -> BTreeMap<String, String> {
        let (role, version) = match self {
            Self::Compaction => COMPACTION_ROLE,
            Self::Tools => ("tool-provider", "v1"),
            Self::Hooks => ("step-transform-provider", "v1"),
        };
        BTreeMap::from([(role.to_owned(), version.to_owned())])
    }
}

/// The runner's calls to a compaction provider module for one session. Every
/// call goes over a route bound to the session, one route per role, so the
/// provider learns the session from the route and the runner from the
/// daemon's attestation, never from a request body.
pub struct SubcProvider {
    consumer: SubcConsumer,
    provider: String,
    session: SessionRef,
}

impl SubcProvider {
    pub async fn connect(
        connection_file: &std::path::Path,
        provider: String,
        session: SessionRef,
    ) -> Result<Self, CallError> {
        let consumer = SubcConsumer::connect(connection_file, ConsumerOptions::default())
            .await
            .map_err(|error| CallError(format!("connect: {error:?}")))?;
        Ok(Self {
            consumer,
            provider,
            session,
        })
    }

    async fn call<P: Serialize, A: DeserializeOwned>(
        &self,
        role: Role,
        method: &str,
        params: &P,
    ) -> Result<A, CallError> {
        let options = CallOptions {
            timeout: PROVIDER_CALL_TIMEOUT,
            role_versions: Some(role.versions()),
            ..CallOptions::default()
        };
        let reply = self
            .consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: self.provider.clone(),
                },
                BindIdentity::new(self.session.harness.clone(), self.session.session.clone()),
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
        self.call(Role::Compaction, ops::COMPACTION_SETUP, &request)
            .await
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        self.call(Role::Compaction, ops::COMPACTION_NOTICE, &request)
            .await
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.call(Role::Compaction, ops::COMPACTION_RIDE, &request)
            .await
    }

    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        let request = ToolCallRequest {
            name: name.to_owned(),
            input: input.clone(),
        };
        let answer: ToolCallAnswer = self
            .call(Role::Tools, wire::ops::TOOL_CALL, &request)
            .await?;
        if answer.is_error {
            Err(CallError(answer.output))
        } else {
            Ok(answer.output)
        }
    }

    async fn pre_user(&self, text: &str, now: u64) -> Result<UserEdit, CallError> {
        let request = PreUserRequest {
            text: text.to_owned(),
            now,
        };
        let answer: PreUserAnswer = self
            .call(Role::Hooks, wire::ops::PRE_USER, &request)
            .await?;
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
                operation(ops::SESSION_APPLIED_VIEW, ManagementOperationKind::Query),
                operation(ops::SESSION_APPLY_VIEW, ManagementOperationKind::Mutate),
                operation(ops::SESSION_SEND, ManagementOperationKind::Mutate),
                operation(ops::RUN_RESULT, ManagementOperationKind::Query),
                operation(MOCK_PLAY, ManagementOperationKind::Mutate),
            ],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
        }])
        .build()
}

/// Who opened a route, as the daemon told the mock at bind: the attested
/// module, and the session the route is bound to.
#[derive(Clone)]
struct Caller {
    module: Option<String>,
    harness: String,
    session: String,
}

/// Serves the runner ops for every session being played. Each call is about
/// the session its route is bound to, and only that session's provider may
/// make it.
pub struct Handler {
    connection_file: PathBuf,
    provider: String,
    /// Played sessions by harness and session id.
    hosts: Arc<Mutex<HashMap<(String, String), Host>>>,
    callers: Mutex<HashMap<u16, Caller>>,
}

impl Handler {
    pub fn new(connection_file: PathBuf, provider: String) -> Self {
        Self {
            connection_file,
            provider,
            hosts: Arc::default(),
            callers: Mutex::default(),
        }
    }

    /// The session a provider op is about: the one the route is bound to,
    /// and only when the daemon attests the session's provider as the caller.
    fn host(&self, channel: u16) -> Result<Host, (&'static str, String)> {
        let caller = self
            .callers
            .lock()
            .expect("callers")
            .get(&channel)
            .cloned()
            .ok_or((codes::REFUSED, "route_unbound".to_owned()))?;
        if caller.module.as_deref() != Some(self.provider.as_str()) {
            return Err((
                codes::REFUSED,
                format!(
                    "caller_not_provider: only {} may call the runner for its sessions",
                    self.provider
                ),
            ));
        }
        self.hosts
            .lock()
            .expect("host map")
            .get(&(caller.harness.clone(), caller.session.clone()))
            .cloned()
            .ok_or_else(|| {
                (
                    codes::UNKNOWN_SESSION,
                    format!("no session {}", caller.session),
                )
            })
    }

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Value, (&'static str, String)> {
        let bad = |message: String| (codes::BAD_REQUEST, message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        match method.as_str() {
            ops::SESSION_READ => {
                let request: ReadRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(channel)?.read(&request)))
            }
            ops::SESSION_APPLY_VIEW => {
                let request: ApplyViewRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(channel)?.apply_view(request)))
            }
            ops::SESSION_APPLIED_VIEW => {
                let _: AppliedViewRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(channel)?.applied_view()))
            }
            ops::SESSION_SEND => {
                let request: SendRequest = wire::params(params).map_err(bad)?;
                Ok(json_of(&self.host(channel)?.send(request)))
            }
            ops::RUN_RESULT => {
                let request: RunResultRequest = wire::params(params).map_err(bad)?;
                self.host(channel)?
                    .run_result(&request)
                    .map(|result| json_of(&result))
                    .ok_or_else(|| bad(format!("unknown run {}", request.run_id)))
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
                let key = (session.harness.clone(), session.session.clone());
                let provider = SubcProvider::connect(&connection_file, provider, session).await?;
                let mut runner = Runner::start(request.config, provider).await?;
                hosts
                    .lock()
                    .expect("host map")
                    .insert(key.clone(), runner.host().clone());
                runner.play(&request.steps).await;
                hosts.lock().expect("host map").remove(&key);
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
    async fn on_bind(&self, request: &RouteBindRequest) -> BindDecision {
        let module = match &request.principal {
            Some(Principal::Reserved { module_id }) => Some(module_id.clone()),
            _ => None,
        };
        self.callers.lock().expect("callers").insert(
            request.handle.channel,
            Caller {
                module,
                harness: request.identity.harness.clone(),
                session: request.identity.session.clone(),
            },
        );
        BindDecision::accept()
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        match self.dispatch(ctx.route_handle().channel, &body).await {
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
