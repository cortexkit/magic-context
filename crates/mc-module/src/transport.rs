//! ck-mc over the subc daemon (the CortexKit module bus that routes calls
//! between module processes): the handler that serves the provider ops, and
//! the client that calls a session's runner back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use ck_contract_draft::read::{ReadPage, ReadRequest, SessionRef};
use ck_contract_draft::send::{RunResult, RunResultRequest, SendAnswer, SendRequest};
use ck_contract_draft::view::{
    AppliedViewAnswer, AppliedViewRequest, ApplyViewAnswer, ApplyViewRequest,
};
use ck_contract_draft::wire::{self, codes, Refusal};
use ck_contract_draft::{
    ops, COMPACTION_PROVIDES, COMPACTION_ROLE, COMPACTION_RUNNER_ROLE, LLM_RUNNER_ROLE,
};
use cortexkit_role_step_transform_provider as step;
use cortexkit_role_tool_provider::result::{ContentPart, ToolResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use step::answer::{HookAnswer, Operation};
use step::hook::{HookCall, Subject};
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
use subc_protocol::tool_call::ToolCallRequest;
use subc_protocol::Principal;
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::sync::OnceCell;

use crate::client::{ClientError, RunnerClient};
use crate::module::{Module, ModuleError, PRE_USER_BUDGET};
use crate::pre_user::Addition;
use crate::route::{Project, Route};

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
}

impl SubcRunnerClient {
    pub fn new(connection_file: PathBuf) -> Self {
        Self {
            connection_file,
            consumer: OnceCell::new(),
        }
    }

    /// Call the session's runner on the route for `role`, bound to the
    /// session, one route per role (compaction-runner for the view and entry
    /// ops, llm-runner for sends and runs).
    async fn call<P: Serialize, A: DeserializeOwned>(
        &self,
        session: &SessionRef,
        role: (&str, &str),
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
            role_versions: Some(std::collections::BTreeMap::from([(
                role.0.to_owned(),
                role.1.to_owned(),
            )])),
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
            &AppliedViewRequest {},
        )
        .await
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendAnswer, ClientError> {
        self.call(session, LLM_RUNNER_ROLE, ops::SESSION_SEND, &request)
            .await
    }

    async fn run_result(
        &self,
        session: &SessionRef,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        self.call(session, LLM_RUNNER_ROLE, ops::RUN_RESULT, &request)
            .await
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
const HOOK_ROLE: (&str, &str) = ("step-transform-provider", "v1");

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
                let root = route.project.as_ref().map(|project| project.root.as_str());
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
        let (text, is_error) = match self
            .module
            .tool(&route.session, &call.name, call.arguments)
            .await
        {
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

    /// A hook op (`step-transform-provider/v1`). That contract names the
    /// session in the body, on a route that may serve all of a runner's
    /// sessions. The body only picks among the sessions of the runner the
    /// daemon attests for the route, so one runner never reaches another's;
    /// on a route bound to one session, the body must name that session.
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
                let bound_to_session = route.session.harness != MODULE_LEVEL_HARNESS;
                if bound_to_session
                    && (call.harness != route.session.harness
                        || call.session != route.session.session)
                {
                    return Err(Refusal::session_mismatch(&call.session));
                }
                let session = SessionRef {
                    runner: route.session.runner.clone(),
                    harness: call.harness.clone(),
                    session: call.session.clone(),
                };
                let answer = match &call.subject {
                    Subject::PreUser { blocks, .. } if !blocks.is_empty() => {
                        let addition = self
                            .module
                            .pre_user(&session, &blocks.join("\n"), now_ms())
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

/// The bind harness a runner declares on a route that serves all of its
/// sessions, as the step-transform contract allows.
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
    Some(Declaration {
        subscriptions,
        claude_code: None,
    })
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
                "open the route for exactly one of compaction-provider/v2, tool-provider/v1 or step-transform-provider/v1",
            );
        };
        // Only the transitional hook routes may serve all of a runner's
        // sessions; every other session route concerns the session it is
        // bound to. Discovery concerns no session.
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
            session: SessionRef {
                runner: module_id.clone(),
                harness: request.identity.harness.clone(),
                session: request.identity.session.clone(),
            },
            project,
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
            Err(Refusal {
                code,
                message,
                detail: Some(detail),
            }) => HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            },
            Err(Refusal { code, message, .. }) => HandlerOutcome::Error { code, message },
        }
    }
}
