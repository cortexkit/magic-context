//! ck-mc over the subc daemon (the CortexKit module bus that routes calls
//! between module processes): the handler that serves the provider ops, and
//! the client that calls a session's runner back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, AppliedViewRequest, ApplyViewAnswer, ApplyViewRequest,
};
use cortexkit_role_compaction::wire::{self, codes, Refusal};
use cortexkit_role_compaction::{
    ops, COMPACTION_PROVIDES, COMPACTION_ROLE, COMPACTION_RUNNER_ROLE, LLM_RUNNER_ROLE,
};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_step_transform_provider as step;
use cortexkit_role_tool_provider::result::{ContentPart, ToolResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use step::answer::{HookAnswer, Operation};
use step::hook::HookCall;
use step::subscription::{
    Declaration, DeclareRequest, DeclaredSubscription, Hook, OnUnavailable, Op,
};
use subc_client_rs::{
    async_trait, BindDecision, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler,
    RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_protocol::manifest::{
    CapabilityDeclarations, Concurrency, ExecutionMode, IdentityScope, ModuleManifest,
    ProviderRole, Tool,
};
use subc_protocol::scope::ScopeSelector;
use subc_protocol::tool_call::ToolCallRequest;
use subc_protocol::Principal;
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::sync::OnceCell;

use crate::child_scopes::ChildScopes;
use crate::client::{Child, ClientError, RunnerClient};
use crate::module::{Module, ModuleError, PRE_USER_BUDGET};
use crate::pre_user::Addition;
use crate::route::{Project, Route};
use crate::routing::RouteError;
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};

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
        // The daemon puts a scope's folder and project on a route's stamp
        // only for a provider that asks; they are where a session's project
        // comes from.
        .capabilities(Some(CapabilityDeclarations {
            provides: vec![
                COMPACTION_PROVIDES.to_owned(),
                subc_protocol::scope::BIND_NO_PROJECT_CAPABILITY.to_owned(),
                subc_protocol::scope::SCOPE_WORKDIR_CAPABILITY.to_owned(),
            ],
            requires: Vec::new(),
            must_never_reach: Vec::new(),
        }))
        .build()
}

/// Calls a session's runner over its management surface. Connects on first
/// use.
pub struct SubcRunnerClient {
    connection_file: PathBuf,
    consumer: OnceCell<SubcConsumer>,
    /// The scopes ck-mc's summarizer children run under.
    child_scopes: Arc<ChildScopes>,
}

impl SubcRunnerClient {
    pub fn new(connection_file: PathBuf, child_scopes: Arc<ChildScopes>) -> Self {
        Self {
            connection_file,
            consumer: OnceCell::new(),
            child_scopes,
        }
    }

    /// An llm-runner call on a child's route, opened under ck-mc's child
    /// scope for the parent's project folder. A daemon that restarted since
    /// the last sync answers `scope_not_synced`; the scope is synced again
    /// and the call made once more.
    async fn child_call<P: Serialize, A: DeserializeOwned>(
        &self,
        child: &Child,
        method: &str,
        params: &P,
    ) -> Result<A, ClientError> {
        let root = child.project_root.as_deref().ok_or_else(|| {
            ClientError(format!(
                "{method}: the session has no project folder, so its summarizer has no child scope"
            ))
        })?;
        let mut synced_again = false;
        loop {
            let scope = self
                .child_scopes
                .for_project(root)
                .await
                .map_err(|error| ClientError(format!("{method}: child scope: {error}")))?;
            match self
                .call_raw(&child.session, LLM_RUNNER_ROLE, method, params, Some(scope))
                .await
            {
                Err(error) if !synced_again && error.0.contains("scope_not_synced") => {
                    self.child_scopes.forget_sync().await;
                    synced_again = true;
                }
                Err(error) => return Err(error),
                Ok(reply) => {
                    return cortexkit_role_llm_runner::wire::read_reply(&reply)
                        .map_err(|error| ClientError(format!("{method} answer: {error:?}")))
                }
            }
        }
    }

    /// Call the session's runner on the route for `role`, bound to the
    /// session, one route per role (compaction-runner for the view and entry
    /// ops, llm-runner for sends and runs). Compaction answers come bare
    /// (compaction contract W1.1); llm-runner wraps every answer as `{"result": …}`
    /// (llm-runner §1).
    async fn call<P: Serialize, A: DeserializeOwned>(
        &self,
        session: &SessionRef,
        role: (&str, &str),
        method: &str,
        params: &P,
    ) -> Result<A, ClientError> {
        let reply = self.call_raw(session, role, method, params, None).await?;
        if role == LLM_RUNNER_ROLE {
            return cortexkit_role_llm_runner::wire::read_reply(&reply)
                .map_err(|error| ClientError(format!("{method} answer: {error:?}")));
        }
        serde_json::from_slice(&reply)
            .map_err(|error| ClientError(format!("{method} answer: {error}")))
    }

    /// One call on the route to `session` for `role`: an unscoped route for
    /// the session's own calls, or one opened under `scope`.
    async fn call_raw<P: Serialize>(
        &self,
        session: &SessionRef,
        role: (&str, &str),
        method: &str,
        params: &P,
        scope: Option<ScopeSelector>,
    ) -> Result<Vec<u8>, ClientError> {
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
            role_versions: Some(std::collections::BTreeMap::from([(
                role.0.to_owned(),
                role.1.to_owned(),
            )])),
            ..CallOptions::default()
        };
        let identity = BindIdentity::new(session.harness.clone(), session.session.clone());
        let body = wire::encode(method, params);
        let reply = match scope {
            None => consumer.call(target, identity, body, options).await,
            Some(scope) => {
                let route = consumer
                    .open_route_scoped(target, identity, scope, options.clone())
                    .await
                    .map_err(|error| ClientError(format!("{method}: {error:?}")))?;
                consumer.request(&route, body, options).await
            }
        }
        .map_err(|error| ClientError(format!("{method}: {error:?}")))?;
        Ok(reply)
    }
}

impl SubcRunnerClient {
    /// The connection to the daemon, made on first use.
    async fn consumer(&self) -> Result<&SubcConsumer, String> {
        self.consumer
            .get_or_try_init(|| {
                SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
            })
            .await
            .map_err(|error| format!("connect: {error:?}"))
    }

    /// One call to the routing provider the catalog lists. Its answer is
    /// `{"result": <answer>}`; a refusal is `{code, message, detail}`.
    async fn route_call<P: Serialize>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<Value, RouteError> {
        let unavailable = |message: String| RouteError {
            code: "routing_unavailable".into(),
            message,
        };
        let consumer = self.consumer().await.map_err(unavailable)?;
        let providers = consumer
            .resolve_providers(crate::routing::CAPABILITY)
            .await
            .map_err(|error| unavailable(format!("{error:?}")))?;
        let module_id = match providers.as_slice() {
            [] => return Err(unavailable("no module provides routing/v1".into())),
            [one] => one.clone(),
            many => {
                return Err(RouteError {
                    code: "routing_ambiguous".into(),
                    message: format!(
                        "routing/v1 has {} providers: {}",
                        many.len(),
                        many.join(", ")
                    ),
                })
            }
        };
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface { module_id },
                // An unscoped select is attributed to ck-mc itself.
                BindIdentity::new("magic-context", "routing"),
                wire::encode(method, params),
                CallOptions {
                    timeout: RUNNER_CALL_TIMEOUT,
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(|error| match error {
                // The provider's own refusal, by its code (`no_route`, ...).
                subc_client_rs::CallError::Module(body) => RouteError {
                    code: body.code,
                    message: body.message,
                },
                other => unavailable(format!("{method}: {other:?}")),
            })?;
        let mut body: Value = serde_json::from_slice(&reply).map_err(|error| RouteError {
            code: "routing_unavailable".into(),
            message: format!("{method} answer: {error}"),
        })?;
        Ok(body["result"].take())
    }
}

impl crate::routing::Router for SubcRunnerClient {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let result = self.route_call("route.select", &request).await?;
        serde_json::from_value(result).map_err(|error| RouteError {
            code: "routing_unavailable".into(),
            message: format!("route.select answer: {error}"),
        })
    }

    async fn report(&self, request: ReportRequest) {
        if let Err(error) = self.route_call("route.report", &request).await {
            eprintln!("ck-mc: route.report failed: {error}");
        }
    }
}

impl RunnerClient for SubcRunnerClient {
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.call(
            session,
            COMPACTION_RUNNER_ROLE,
            ops::SESSION_ENTRIES,
            &request,
        )
        .await
    }

    async fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.call(
            session,
            COMPACTION_RUNNER_ROLE,
            ops::SESSION_APPLY_VIEW,
            &request,
        )
        .await
    }

    async fn applied_view(&self, session: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.call(
            session,
            COMPACTION_RUNNER_ROLE,
            ops::SESSION_APPLIED_VIEW,
            &AppliedViewRequest::new(),
        )
        .await
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.call(session, LLM_RUNNER_ROLE, ops::SESSION_SEND, &request)
            .await
    }

    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.child_call(child, ops::SESSION_SEND, &request).await
    }

    async fn child_result(
        &self,
        child: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        self.child_call(child, ops::RUN_RESULT, &request).await
    }

    /// Synapse admits any principal on its management surface and reads no
    /// project from the bind, so the route is opened unscoped, bound to the
    /// `magic-context` harness and the session the search is for.
    async fn synapse_call(
        &self,
        session: &SessionRef,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let consumer = self
            .consumer()
            .await
            .map_err(|_| "missing_synapse".to_owned())?;
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: "synapse".to_owned(),
                },
                BindIdentity::new("magic-context", session.session.clone()),
                wire::encode(method, &params),
                CallOptions {
                    timeout: crate::search::rerank::SYNAPSE_DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(|error| match error {
                subc_client_rs::CallError::Module(body) => body.code,
                subc_client_rs::CallError::OutcomeUnknown(_) => "deadline_exceeded".to_owned(),
                _ => "missing_synapse".to_owned(),
            })?;
        serde_json::from_slice(&reply).map_err(|_| "validation".to_owned())
    }

    /// On Entorhinal's management surface, bound to the session's own
    /// identity, as Entorhinal attributes a context read to the session that
    /// asks. The caller bounds the wait.
    async fn entorhinal_call(
        &self,
        session: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, crate::client::EntorhinalRefusal>> {
        let consumer = self.consumer().await.ok()?;
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: "entorhinal".to_owned(),
                },
                BindIdentity::new(session.harness.clone(), session.session.clone()),
                body,
                CallOptions {
                    timeout: crate::memory_context::DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await;
        match reply {
            Ok(bytes) => Some(Ok(bytes)),
            Err(subc_client_rs::CallError::Module(body)) => {
                Some(Err(crate::client::EntorhinalRefusal {
                    code: body.code,
                    message: body.message,
                    detail: body.detail,
                }))
            }
            Err(_) => None,
        }
    }

    /// On Engram's device-stream service, under a fixed identity: the stream
    /// belongs to the device, not to a session.
    async fn engram_call(&self, method: &str, params: Value) -> Result<Value, String> {
        let consumer = self
            .consumer()
            .await
            .map_err(|_| "unavailable".to_owned())?;
        let reply = consumer
            .call(
                RouteTarget::InternalService {
                    module_id: "engram".to_owned(),
                    service_id: "device-streams".to_owned(),
                },
                BindIdentity::new("memory-sync", "memory-sync"),
                wire::encode(method, &params),
                CallOptions {
                    timeout: crate::memory_sync::ENGRAM_DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(|error| match error {
                subc_client_rs::CallError::Module(body) => body.code,
                _ => "unavailable".to_owned(),
            })?;
        let value: Value =
            serde_json::from_slice(&reply).map_err(|_| "malformed_reply".to_owned())?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(value)
    }
}

/// Serves the provider ops for the daemon.
pub struct Handler {
    module: Module<SubcRunnerClient>,
    /// Every bound route, by channel: what the daemon said about it at bind.
    bound: Mutex<HashMap<u16, Bound>>,
}

/// The roles of the two published contracts a runner also reaches ck-mc
/// through, each on a route of its own.
const TOOL_ROLE: (&str, &str) = ("tool-provider", "v1");
const HOOK_ROLE: (&str, &str) = (step::ROLE, step::VERSION);

/// A bound route: the session it concerns and the role it was opened for.
#[derive(Clone)]
struct Bound {
    route: Route,
    role: RouteRole,
}

/// The roles ck-mc serves, one per route.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RouteRole {
    Compaction,
    Tools,
    Hooks,
    /// A route that declared no role. `tool-provider/v1` lets a consumer
    /// reach `role.describe` and `tool.catalog` by name on any route (core
    /// fetches a plan's catalog that way), so such a route gets those two
    /// ops and nothing else.
    Discovery,
}

impl RouteRole {
    /// The role a route declares, when it declares exactly one ck-mc serves,
    /// or [`RouteRole::Discovery`] when it declares none.
    fn declared(roles: Option<&std::collections::BTreeMap<String, String>>) -> Option<Self> {
        let Some(roles) = roles.filter(|roles| !roles.is_empty()) else {
            return Some(Self::Discovery);
        };
        if roles.len() != 1 {
            return None;
        }
        let (name, version) = roles.iter().next()?;
        match (name.as_str(), version.as_str()) {
            COMPACTION_ROLE => Some(Self::Compaction),
            TOOL_ROLE => Some(Self::Tools),
            HOOK_ROLE => Some(Self::Hooks),
            _ => None,
        }
    }
}

impl Handler {
    pub fn new(module: Module<SubcRunnerClient>) -> Self {
        Self {
            module,
            bound: Mutex::default(),
        }
    }

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        // Every route was checked at bind (`on_bind`): one known role, and a
        // bound session unless it is a module-level hook route.
        let bound = self
            .bound
            .lock()
            .expect("bound routes")
            .get(&channel)
            .cloned()
            .ok_or_else(|| Refusal::new(codes::ROUTE_UNBOUND, "no route was bound", None))?;
        let answer = match bound.role {
            RouteRole::Compaction => self.compaction(&bound.route, body).await?,
            // Catalog answers are served as the exact canonical bytes the
            // catalog produced, never re-serialized.
            RouteRole::Tools => return self.tool(&bound.route, body).await,
            RouteRole::Discovery => return self.discovery(&bound.route, body),
            RouteRole::Hooks => self.hook(&bound.route, body).await?,
        };
        Ok(serde_json::to_vec(&answer).expect("answers serialize"))
    }

    /// A compaction op, about the session the route is bound to.
    async fn compaction(&self, route: &Route, body: &[u8]) -> Result<Value, Refusal> {
        let (method, params) = wire::decode(body)?;
        let session = &route.session;
        let answer = match method.as_str() {
            ops::COMPACTION_SETUP => {
                to_value(self.module.setup(route.clone(), wire::params(params)?))
            }
            ops::COMPACTION_NOTICE => to_value(self.module.notice(session, wire::params(params)?)),
            ops::COMPACTION_RIDE => {
                to_value(self.module.ride(session, wire::params(params)?).await)
            }
            other => return Err(Refusal::unknown_method(other)),
        };
        answer.map_err(refusal)
    }

    /// `role.describe` or `tool.catalog`, by name in the role's
    /// `{name, arguments}` envelope; `None` for any other name.
    fn role_op(&self, route: &Route, call: &ToolCallRequest) -> Option<Result<Vec<u8>, Refusal>> {
        let answer = match call.name.as_str() {
            cortexkit_role_tool_provider::ops::ROLE_DESCRIBE => {
                crate::catalog::role_describe_bytes()
            }
            cortexkit_role_tool_provider::ops::TOOL_CATALOG => {
                let root = route
                    .project
                    .as_ref()
                    .map(|project| project.root.as_str())
                    .or(route.workdir.as_deref());
                self.module.catalog(root, &call.arguments)
            }
            _ => return None,
        };
        Some(answer.map_err(crate::catalog::CatalogError::into_refusal))
    }

    /// An op on a route that declared no role: only the two role ops.
    fn discovery(&self, route: &Route, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        let call = tool_call(body)?;
        self.role_op(route, &call).unwrap_or_else(|| {
            Err(Refusal::new(
                codes::UNKNOWN_ROUTE_ROLE,
                format!("`{}` needs a route opened for tool-provider/v1", call.name),
                None,
            ))
        })
    }

    /// An op on a `tool-provider/v1` route: a role op by name, or a model's
    /// call to one of the `ctx_*` tools about the session the route is bound
    /// to, answered with its tool result.
    async fn tool(&self, route: &Route, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        let call = tool_call(body)?;
        if let Some(answer) = self.role_op(route, &call) {
            return answer;
        }
        if !call.name.starts_with("ctx_") {
            let error = cortexkit_role_tool_provider::errors::unknown_tool(&call.name);
            return Err(Refusal::new(&error.code, error.message, None));
        }
        let (text, is_error) = match self.module.tool(route, &call.name, call.arguments).await {
            Ok(output) => (output, false),
            Err(ModuleError::Tool(output)) => (output, true),
            Err(other) => return Err(refusal(other)),
        };
        let mut result = ToolResult::new(vec![ContentPart::text(text)]);
        if is_error {
            result.is_error = Some(true);
        }
        Ok(serde_json::to_vec(&result).expect("answers serialize"))
    }

    /// A hook op (`step-transform-provider/v2`). A hook concerns the session
    /// its route is bound to; a route bound to no session answers discovery
    /// only.
    async fn hook(&self, route: &Route, body: &[u8]) -> Result<Value, Refusal> {
        let (method, params) = wire::decode(body)?;
        match method.as_str() {
            step::ops::TRANSFORM_DECLARE => {
                let request: DeclareRequest = wire::params(params)?;
                let preset = request.preset.as_deref().unwrap_or("head");
                let declaration = declare(preset).ok_or_else(|| Refusal::unknown_preset(preset))?;
                Ok(serde_json::to_value(declaration).expect("answers serialize"))
            }
            step::ops::TRANSFORM_HOOK => {
                let call: HookCall = wire::params(params)?;
                // step-transform-provider/v2: a hook concerns the session its
                // route is bound to, whatever the body names; an unbound route
                // answers discovery only.
                if route.session.harness == MODULE_LEVEL_HARNESS {
                    return Err(Refusal::new(
                        codes::ROUTE_UNBOUND,
                        "transform.hook needs a route bound to the session",
                        None,
                    ));
                }
                let session = route.session.clone();
                let answer = match crate::pre_user::person_blocks(&call.subject) {
                    Some((blocks, at_ms)) => {
                        // The runner's clock when it sends one, so the gap
                        // since the previous message is measured on one
                        // machine's clock; ck-mc's own otherwise.
                        let addition = self
                            .module
                            .pre_user(&session, &blocks.join("\n"), at_ms.unwrap_or_else(now_ms))
                            .await;
                        hook_answer(addition, blocks.len())
                    }
                    _ => HookAnswer::Pass,
                };
                Ok(serde_json::to_value(answer).expect("answers serialize"))
            }
            other => Err(Refusal::unknown_method(other)),
        }
    }
}

/// The bind harness a runner declares on a route bound to no session: a
/// hook route opened for discovery.
const MODULE_LEVEL_HARNESS: &str = "runner";

/// What ck-mc subscribes to for a preset: `pre_user` for presets that add a
/// time marker or a memory hint, with ck-mc's budget, passing on any
/// failure so a message is never held up. `None` for a preset ck-mc does not
/// know.
fn declare(preset: &str) -> Option<Declaration> {
    let features = crate::preset::features(preset)?;
    let mut ops = Vec::new();
    if features.time_marker {
        ops.push(Op::Prepend);
    }
    if features.auto_memory {
        ops.push(Op::Append);
    }
    let budget = u64::try_from(PRE_USER_BUDGET.as_millis()).unwrap_or(u64::MAX);
    let subscriptions = if ops.is_empty() {
        Vec::new()
    } else {
        vec![DeclaredSubscription::new(Hook::PreUser, ops, budget)
            .with_on_unavailable(OnUnavailable::Pass)]
    };
    Some(Declaration::new(subscriptions))
}

/// The hook answer for an addition: the time marker before the first block,
/// the hint after the last.
fn hook_answer(addition: Addition, blocks: usize) -> HookAnswer {
    let last = u32::try_from(blocks.saturating_sub(1)).unwrap_or(u32::MAX);
    let mut ops = Vec::new();
    if let Some(text) = addition.prepend {
        ops.push(Operation::Prepend {
            block: 0,
            text,
            note: None,
        });
    }
    if let Some(text) = addition.append {
        ops.push(Operation::Append {
            block: last,
            text,
            note: None,
        });
    }
    if ops.is_empty() {
        HookAnswer::Pass
    } else {
        HookAnswer::Ops { ops }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The role's `{name, arguments}` envelope.
fn tool_call(body: &[u8]) -> Result<ToolCallRequest, Refusal> {
    serde_json::from_slice(body)
        .map_err(|error| Refusal::invalid_params("", format!("not a tool call: {error}")))
}

fn to_value<T: Serialize>(result: Result<T, ModuleError>) -> Result<Value, ModuleError> {
    result.map(|answer| serde_json::to_value(answer).expect("answers serialize"))
}

fn refusal(error: ModuleError) -> Refusal {
    match error {
        ModuleError::UnknownSession => Refusal::unknown_session(),
        ModuleError::UnknownPreset(preset) => Refusal::unknown_preset(&preset),
        ModuleError::UnknownTool(name) => {
            let error = cortexkit_role_tool_provider::errors::unknown_tool(&name);
            Refusal::new(&error.code, error.message, None)
        }
        other => Refusal::new("internal", format!("{other:?}"), None),
    }
}

#[async_trait]
impl ModuleHandler for Handler {
    /// Record who opened the route and for which session. Only a module the
    /// daemon attests can open one: the runner's identity is the attested
    /// module, the session is the route's bind identity, and the project is
    /// the scope stamp's, so nothing that decides whose data a call reaches
    /// comes from the caller's own words.
    async fn on_bind(&self, request: &RouteBindRequest) -> BindDecision {
        let Some(Principal::Reserved { module_id }) = &request.principal else {
            return BindDecision::reject(
                codes::UNATTESTED_RUNNER,
                "ck-mc serves sessions only to a runner the daemon attests",
            );
        };
        let Some(role) = RouteRole::declared(request.role_versions.as_ref()) else {
            return BindDecision::reject(
                codes::UNKNOWN_ROUTE_ROLE,
                "open the route for exactly one of compaction-provider/v2, tool-provider/v1 or step-transform-provider/v2",
            );
        };
        // A hook route may open unbound, for discovery (`role.describe`,
        // `transform.declare`) only; every other session route concerns the
        // session it is bound to.
        if matches!(role, RouteRole::Compaction | RouteRole::Tools)
            && request.identity.harness == MODULE_LEVEL_HARNESS
        {
            return BindDecision::reject(
                codes::ROUTE_UNBOUND,
                "compaction and tool routes must be bound to a session",
            );
        }
        let project =
            request
                .scope
                .as_ref()
                .and_then(|scope| match (&scope.project_id, &scope.workdir) {
                    (Some(id), Some(root)) => Some(Project {
                        id: id.clone(),
                        root: root.clone(),
                    }),
                    _ => None,
                });
        let route = Route {
            session: SessionRef::new(
                module_id.clone(),
                request.identity.harness.clone(),
                request.identity.session.clone(),
            ),
            project,
            workdir: request
                .scope
                .as_ref()
                .and_then(|scope| scope.workdir.clone()),
            agent_id: request
                .scope
                .as_ref()
                .and_then(|scope| scope.attributes.agent_id.clone()),
        };
        self.bound
            .lock()
            .expect("bound routes")
            .insert(request.handle.channel, Bound { route, role });
        BindDecision::accept()
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        match self.dispatch(ctx.route_handle().channel, &body).await {
            Ok(answer) => HandlerOutcome::Response(answer),
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

#[cfg(test)]
#[path = "transport_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn folder_only_catalog_uses_project_tier() {
        let root =
            std::env::temp_dir().join(format!("ck-mc-folder-catalog-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".cortexkit")).unwrap();
        std::fs::write(root.join("user.jsonc"), "{}").unwrap();
        std::fs::write(
            root.join(".cortexkit/magic-context.jsonc"),
            r#"{"prompt_surface":{"default":"light"}}"#,
        )
        .unwrap();
        let client = SubcRunnerClient::new(
            root.join("unused-connection"),
            Arc::new(ChildScopes::new("test-config")),
        );
        let handler = Handler::new(Module::new(
            client,
            crate::config::Config::Files(crate::config::Loader::with_user_path(
                root.join("user.jsonc"),
            )),
            None,
            None,
        ));
        let route = Route {
            session: SessionRef::new("runner", "test", "catalog"),
            project: None,
            workdir: Some(root.to_string_lossy().into_owned()),
            agent_id: None,
        };
        let arguments = json!({"preset":"worker","composition":{"providers":[{"provider":"magic-context","tools":[{"name":"ctx_reduce"},{"name":"ctx_expand"},{"name":"ctx_search"},{"name":"ctx_keep"}]}],"compaction":{"provider":"magic-context"}},"system_text":{"preset":"worker"}});
        let call = tool_call(
            &serde_json::to_vec(&json!({"name":"tool.catalog","arguments": arguments})).unwrap(),
        )
        .unwrap();
        let expected = handler
            .module
            .catalog(route.workdir.as_deref(), &arguments)
            .unwrap();
        assert_ne!(expected, handler.module.catalog(None, &arguments).unwrap());
        assert_eq!(handler.role_op(&route, &call).unwrap().unwrap(), expected);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod agent_surface_tests {
    #[test]
    fn unknown_tool_is_a_protocol_refusal() {
        let refusal = super::refusal(crate::module::ModuleError::UnknownTool(
            "ctx_missing".into(),
        ));
        assert_eq!(refusal.code, "unknown_tool");
    }
}
