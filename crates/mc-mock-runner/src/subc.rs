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

use cortexkit_role_compaction::notice::{NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::ops;
use cortexkit_role_compaction::read::{ReadRequest, SessionRef};
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
use cortexkit_role_compaction::setup::{SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewRequest, ApplyViewRequest};
use cortexkit_role_compaction::wire::{self, codes, Refusal};
use cortexkit_role_compaction::COMPACTION_ROLE;
use cortexkit_role_llm_runner::run::RunResultRequest;
use cortexkit_role_llm_runner::send::SendRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
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
    CapabilityDeclarations, Concurrency, IdentityScope, ManagementOperation,
    ManagementOperationKind, ModuleManifest, ProviderRole,
};
use subc_protocol::scope::{ScopeKind, ScopeRecord, ScopeSelector};
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

/// The stand-in routing provider's capability and ops. It answers every
/// select with the first runner the request allows and the model
/// `test/test-model`, and ignores reports.
const ROUTING_CAPABILITY: &str = "routing/v1";
const ROUTE_SELECT: &str = "route.select";
const ROUTE_REPORT: &str = "route.report";

fn next_decision() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The scopes the mock owns: one per played project, as core owns a
/// session's scope in production. Each sync carries every project so far.
#[derive(Default)]
pub struct Scopes {
    /// The mock's own module id: a scope selector names its owner.
    module_id: Mutex<String>,
    handle: Mutex<Option<subc_client_rs::ModuleHandle>>,
    state: tokio::sync::Mutex<(u64, BTreeMap<String, ScopeRecord>)>,
}

impl Scopes {
    pub fn install(&self, module_id: &str, handle: subc_client_rs::ModuleHandle) {
        *self.module_id.lock().expect("scope owner") = module_id.to_owned();
        *self.handle.lock().expect("scope handle") = Some(handle);
    }

    async fn for_project(
        &self,
        project: &crate::runner::Project,
    ) -> Result<ScopeSelector, CallError> {
        let handle = self
            .handle
            .lock()
            .expect("scope handle")
            .clone()
            .ok_or_else(|| CallError::new("the mock runner is not serving yet"))?;
        let scope_ref = format!("mock-session-{}", project.id);
        let mut state = self.state.lock().await;
        state.1.entry(project.root.clone()).or_insert_with(|| {
            ScopeRecord::new(scope_ref.clone(), 1, ScopeKind::Ephemeral)
                .with_workdir(Some(project.root.clone()))
                .with_project_id(Some(project.id.clone()))
        });
        state.0 += 1;
        let records = state.1.values().cloned().collect();
        handle
            .scope_sync(state.0, records)
            .await
            .map_err(|error| CallError::new(format!("scope.sync: {error:?}")))?;
        Ok(ScopeSelector::new(
            Principal::Reserved {
                module_id: self.module_id.lock().expect("scope owner").clone(),
            },
            &scope_ref,
            Some(1),
        ))
    }
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
    /// The session's scope, for a session with a project: its routes to the
    /// provider are opened under it, so the daemon tells the provider the
    /// project's folder and id.
    pub scope: Option<ScopeSelector>,
}

impl SubcProvider {
    pub async fn connect(
        connection_file: &std::path::Path,
        provider: String,
        session: SessionRef,
    ) -> Result<Self, CallError> {
        let consumer = SubcConsumer::connect(connection_file, ConsumerOptions::default())
            .await
            .map_err(|error| CallError::new(format!("connect: {error:?}")))?;
        Ok(Self {
            consumer,
            provider,
            session,
            scope: None,
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
        let target = RouteTarget::ToolProvider {
            module_id: self.provider.clone(),
        };
        let identity =
            BindIdentity::new(self.session.harness.clone(), self.session.session.clone());
        let reply = match &self.scope {
            None => self.consumer.call(target, identity, body, options).await,
            Some(scope) => {
                let route = self
                    .consumer
                    .open_route_scoped(target, identity, scope.clone(), options.clone())
                    .await
                    .map_err(|error| CallError::new(format!("{label}: {error:?}")))?;
                self.consumer.request(&route, body, options).await
            }
        }
        .map_err(|error| match error {
            // The provider refused by name (W1.3).
            subc_client_rs::consumer::CallError::Module(body) => {
                CallError::refused(body.code, format!("{label}: {}", body.message))
            }
            other => CallError::new(format!("{label}: {other:?}")),
        })?;
        serde_json::from_slice(&reply)
            .map_err(|error| CallError::new(format!("{label} answer: {error}")))
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
            Err(CallError::new(text))
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
                operation(ROUTE_SELECT, ManagementOperationKind::Query),
                operation(ROUTE_REPORT, ManagementOperationKind::Mutate),
            ],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
        }])
        // A stand-in routing provider, so a provider's summarizer has a
        // model to run on over the wire.
        .capabilities(Some(CapabilityDeclarations {
            provides: vec![
                ROUTING_CAPABILITY.to_owned(),
                // So the daemon stamps a route's scope folder on its bind.
                subc_protocol::scope::SCOPE_WORKDIR_CAPABILITY.to_owned(),
            ],
            requires: Vec::new(),
            must_never_reach: Vec::new(),
        }))
        .build()
}

/// Who opened a route, as the daemon told the mock at bind: the attested
/// module, and the session the route is bound to.
#[derive(Clone)]
struct Caller {
    module: Option<String>,
    harness: String,
    session: String,
    /// The folder of the scope the route was opened under, as the daemon
    /// stamped it.
    workdir: Option<String>,
}

/// Serves the runner ops for every session being played. Each call is about
/// the session its route is bound to, and only that session's provider may
/// make it.
pub struct Handler {
    connection_file: PathBuf,
    provider: String,
    /// Played sessions by harness and session id.
    hosts: Arc<Mutex<HashMap<(String, String), Host>>>,
    /// The scopes of played sessions with a project.
    pub scopes: Arc<Scopes>,
    callers: Mutex<HashMap<u16, Caller>>,
}

impl Handler {
    pub fn new(connection_file: PathBuf, provider: String) -> Self {
        Self {
            connection_file,
            provider,
            hosts: Arc::default(),
            scopes: Arc::default(),
            callers: Mutex::default(),
        }
    }

    /// The session a provider op is about: the one the route is bound to,
    /// and only when the daemon attests the session's provider as the caller.
    /// A route bound to one of the provider's child sessions reaches the
    /// session it is a child of: the mock names a child
    /// `<parent session>:<anything>`, as ck-mc names its summarizer's.
    fn host(&self, channel: u16) -> Result<Host, Refusal> {
        self.host_and_session(channel).map(|(host, _)| host)
    }

    /// The host, and the session id the route is bound to. A route bound to a
    /// child session must be opened under a scope whose folder is the
    /// session's project, as a real runner creates the child there and
    /// refuses a scope without one.
    fn host_and_session(&self, channel: u16) -> Result<(Host, String), Refusal> {
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
        let hosts = self.hosts.lock().expect("host map");
        let host = hosts
            .get(&(caller.harness.clone(), caller.session.clone()))
            .or_else(|| {
                hosts.iter().find_map(|((harness, session), host)| {
                    (harness == &caller.harness
                        && caller
                            .session
                            .strip_prefix(session.as_str())
                            .is_some_and(|rest| rest.starts_with(':')))
                    .then_some(host)
                })
            })
            .cloned()
            .ok_or_else(Refusal::unknown_session)?;
        let is_child = !hosts.contains_key(&(caller.harness.clone(), caller.session.clone()));
        if is_child && (host.project_root().is_none() || caller.workdir != host.project_root()) {
            return Err(Refusal::new(
                codes::INVALID_PARAMS,
                "a child session needs a scope with the session's project folder",
                Some(json!({"field": "scope", "problem": "workdir_required"})),
            ));
        }
        Ok((host, caller.session))
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
            ROUTE_SELECT => {
                let request: SelectRequest = wire::params(params)?;
                let route = RouteRef::new("test", "test-model");
                let runner = request
                    .runners
                    .and_then(|runners| runners.into_iter().next())
                    .unwrap_or_else(|| "mock-runner".into());
                let answer = SelectAnswer::new(
                    format!("mock-{}", next_decision()),
                    route.clone(),
                    RunnerRef::new(runner, route),
                    400_000,
                    32_000,
                    u64::MAX,
                    "mock",
                );
                Ok(json!({"result": answer}))
            }
            ROUTE_REPORT => Ok(json!({"result": {}})),
            // llm-runner's ops answer `{"result": <answer>}` (llm-runner §1).
            ops::SESSION_SEND => {
                let request: SendRequest = wire::params(params)?;
                let (host, session) = self.host_and_session(channel)?;
                Ok(json!({"result": host.send(&session, request)?}))
            }
            ops::RUN_RESULT => {
                let request: RunResultRequest = wire::params(params)?;
                self.host(channel)?
                    .run_result(&request)
                    .map(|result| json!({"result": result}))
                    .ok_or_else(|| {
                        Refusal::invalid_params("run_id", format!("unknown run {}", request.run_id))
                    })
            }
            MOCK_PLAY => {
                let request: PlayRequest = wire::params(params)?;
                let report = self
                    .play(request)
                    .await
                    .map_err(|error| Refusal::new("play_failed", error.message, None))?;
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
        let scopes = Arc::clone(&self.scopes);
        let (reply, report) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a scenario runtime");
            let result = runtime.block_on(async move {
                let session = request.config.session.clone();
                let key = (session.harness.clone(), session.session.clone());
                let mut provider =
                    SubcProvider::connect(&connection_file, provider, session).await?;
                if let Some(project) = &request.config.project {
                    provider.scope = Some(scopes.for_project(project).await?);
                }
                let mut runner = Runner::start(request.config, provider).await?;
                hosts
                    .lock()
                    .expect("host map")
                    .insert(key.clone(), runner.host().clone());
                runner.play(&request.steps).await;
                hosts.lock().expect("host map").remove(&key);
                let mut report = runner.report.clone();
                report.child_runs = runner
                    .host()
                    .child_runs()
                    .into_iter()
                    .map(|run| run.child)
                    .collect();
                Ok(report)
            });
            let _ = reply.send(result);
        });
        report
            .await
            .map_err(|_| CallError::new("the scenario thread stopped"))?
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
                workdir: request
                    .scope
                    .as_ref()
                    .and_then(|scope| scope.workdir.clone()),
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
