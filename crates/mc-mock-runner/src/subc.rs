//! The mock runner over the subc daemon (the CortexKit module bus that
//! routes calls between module processes). It serves the runner ops a
//! compaction provider calls back (`session.entries`, `session.apply_view`,
//! `session.applied_view`, `session.send`, `run.result`), plus `mock.play`,
//! which plays one scenario against the provider over the wire and answers
//! with the run's report.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ck_contract_draft::send::{RunResultRequest, SendRequest};
use cortexkit_role_compaction::notice::{NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::ops;
use cortexkit_role_compaction::read::{ReadRequest, SessionRef};
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
use cortexkit_role_compaction::setup::{SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewRequest, ApplyViewRequest};
use cortexkit_role_compaction::wire::{self, codes, Refusal};
use cortexkit_role_compaction::COMPACTION_ROLE;
use cortexkit_role_step_transform_provider as step;
use cortexkit_role_tool_provider::result::{ContentPart, ToolResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use step::answer::{HookAnswer, Operation};
use subc_client_rs::{
    async_trait, BindDecision, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler,
    RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_protocol::manifest::{
    Concurrency, IdentityScope, ManagementOperation, ManagementOperationKind, ModuleManifest,
    ProviderRole,
};
use subc_protocol::tool_call::ToolCallRequest;
use subc_protocol::{BindIdentity, Principal, RouteTarget};

use crate::runner::{CallError, Host, Provider, Report, Runner, SessionConfig, UserEdit};
use crate::script::Step;

/// Plays a scenario: the mock runner's own test op.
pub const MOCK_PLAY: &str = "mock.play";

/// Fetches a `tool-provider/v1` op from the provider (`role.describe` or
/// `tool.catalog`) the way a plan builder does, and answers with the
/// provider's reply as it came: the mock runner's own test op.
pub const MOCK_FETCH: &str = "mock.fetch";

/// A [`MOCK_FETCH`] request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FetchRequest {
    /// `role.describe` or `tool.catalog`.
    pub name: String,
    pub arguments: Value,
    /// Open the route for `tool-provider/v1`, as a runner does; `false`
    /// declares no role, as a plan builder may.
    pub declare_role: bool,
}

/// A [`MOCK_FETCH`] answer: the provider's reply bytes as text, or its
/// refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchAnswer {
    Reply(String),
    Refused(String),
}

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
        self.call_body(role, method, wire::encode(method, params))
            .await
    }

    /// Send `body` on the session's route for `role`; `label` names the call
    /// in errors.
    async fn call_body<A: DeserializeOwned>(
        &self,
        role: Role,
        label: &str,
        body: Vec<u8>,
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
                body,
                options,
            )
            .await
            .map_err(|error| CallError(format!("{label}: {error:?}")))?;
        serde_json::from_slice(&reply)
            .map_err(|error| CallError(format!("{label} answer: {error}")))
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

    /// A tool call in the published tool-provider shape: the body is the
    /// `{name, arguments}` call, and the answer its tool result.
    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        let call = ToolCallRequest::new(name, input.clone());
        let body = serde_json::to_vec(&call).expect("tool calls serialize");
        let result: ToolResult = self.call_body(Role::Tools, name, body).await?;
        let text = result
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_error == Some(true) {
            Err(CallError(text))
        } else {
            Ok(text)
        }
    }

    /// The `pre_user` hook in the published step-transform shape. The
    /// provider uses its own clock; `_now` is the scenario's, which only an
    /// in-process provider can share.
    async fn pre_user(&self, text: &str, _now: u64) -> Result<UserEdit, CallError> {
        let call = json!({
            "session": self.session.session,
            "harness": self.session.harness,
            "hook": "pre_user",
            "blocks": [text],
        });
        let answer: HookAnswer = self
            .call(Role::Hooks, step::ops::TRANSFORM_HOOK, &call)
            .await?;
        Ok(user_edit(answer))
    }
}

/// A hook answer as text before and after the message: the ops the mock
/// sends a one-block message can only prepend to or append to that block.
pub fn user_edit(answer: HookAnswer) -> UserEdit {
    let mut edit = UserEdit::default();
    if let HookAnswer::Ops { ops } = answer {
        for op in ops {
            match op {
                Operation::Prepend { text, .. } => {
                    edit.prepend = Some(text + edit.prepend.as_deref().unwrap_or(""));
                }
                Operation::Append { text, .. } => {
                    edit.append = Some(edit.append.unwrap_or_default() + &text);
                }
                Operation::Replace { .. } => {}
            }
        }
    }
    edit
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
                operation(ops::SESSION_ENTRIES, ManagementOperationKind::Query),
                operation(ops::SESSION_APPLIED_VIEW, ManagementOperationKind::Query),
                operation(ops::SESSION_APPLY_VIEW, ManagementOperationKind::Mutate),
                operation(ops::SESSION_SEND, ManagementOperationKind::Mutate),
                operation(ops::RUN_RESULT, ManagementOperationKind::Query),
                operation(MOCK_PLAY, ManagementOperationKind::Mutate),
                operation(MOCK_FETCH, ManagementOperationKind::Query),
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
    fn host(&self, channel: u16) -> Result<Host, Refusal> {
        let caller = self
            .callers
            .lock()
            .expect("callers")
            .get(&channel)
            .cloned()
            .ok_or_else(|| Refusal::new(codes::ROUTE_UNBOUND, "the route has no session", None))?;
        if caller.module.as_deref() != Some(self.provider.as_str()) {
            // Mock only: one provider is configured per run, and only it may
            // call back for its sessions.
            return Err(Refusal::new(
                "caller_not_provider",
                format!(
                    "only {} may call the runner for its sessions",
                    self.provider
                ),
                None,
            ));
        }
        self.hosts
            .lock()
            .expect("host map")
            .get(&(caller.harness.clone(), caller.session.clone()))
            .cloned()
            .ok_or_else(Refusal::unknown_session)
    }

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Value, Refusal> {
        let (method, params) = wire::decode(body)?;
        match method.as_str() {
            ops::SESSION_ENTRIES => {
                let request: ReadRequest = wire::params(params)?;
                Ok(json_of(&self.host(channel)?.read(&request)?))
            }
            ops::SESSION_APPLY_VIEW => {
                let request: ApplyViewRequest = wire::params(params)?;
                Ok(json_of(&self.host(channel)?.apply_view(request)))
            }
            ops::SESSION_APPLIED_VIEW => {
                let _: AppliedViewRequest = wire::params(params)?;
                Ok(json_of(&self.host(channel)?.applied_view()))
            }
            ops::SESSION_SEND => {
                let request: SendRequest = wire::params(params)?;
                Ok(json_of(&self.host(channel)?.send(request)))
            }
            ops::RUN_RESULT => {
                let request: RunResultRequest = wire::params(params)?;
                self.host(channel)?
                    .run_result(&request)
                    .map(|result| json_of(&result))
                    .ok_or_else(|| {
                        Refusal::invalid_params("run_id", format!("unknown run {}", request.run_id))
                    })
            }
            MOCK_PLAY => {
                let request: PlayRequest = wire::params(params)?;
                let report = self
                    .play(request)
                    .await
                    .map_err(|error| Refusal::new("play_failed", error.0, None))?;
                Ok(json_of(&report))
            }
            MOCK_FETCH => {
                let request: FetchRequest = wire::params(params)?;
                Ok(json_of(&self.fetch(request).await?))
            }
            other => Err(Refusal::unknown_method(other)),
        }
    }

    /// Send one `tool-provider/v1` op to the provider and report its reply
    /// unparsed, so a test sees the exact bytes.
    async fn fetch(&self, request: FetchRequest) -> Result<FetchAnswer, Refusal> {
        let consumer = SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
            .await
            .map_err(|error| Refusal::new("fetch_failed", format!("connect: {error:?}"), None))?;
        let options = CallOptions {
            timeout: PROVIDER_CALL_TIMEOUT,
            role_versions: request.declare_role.then(|| Role::Tools.versions()),
            ..CallOptions::default()
        };
        let body = serde_json::to_vec(&json!({
            "name": request.name,
            "arguments": request.arguments,
        }))
        .expect("requests serialize");
        let reply = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: self.provider.clone(),
                },
                BindIdentity::new("mock", "catalog-fetch"),
                body,
                options,
            )
            .await;
        Ok(match reply {
            Ok(bytes) => FetchAnswer::Reply(String::from_utf8_lossy(&bytes).into_owned()),
            Err(error) => FetchAnswer::Refused(format!("{error:?}")),
        })
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
            Err(refusal) => match refusal.detail {
                Some(detail) => HandlerOutcome::ErrorWithDetail {
                    code: refusal.code,
                    message: refusal.message,
                    detail,
                },
                None => HandlerOutcome::Error {
                    code: refusal.code,
                    message: refusal.message,
                },
            },
        }
    }
}

fn json_of<T: Serialize>(answer: &T) -> Value {
    serde_json::to_value(answer).expect("answers serialize")
}
