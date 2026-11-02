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
use ck_contract_draft::wire::{self, codes};
use ck_contract_draft::{ops, COMPACTION_PROVIDES, COMPACTION_ROLE};
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
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.call(session, ops::SESSION_READ, &request).await
    }

    async fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.call(session, ops::SESSION_APPLY_VIEW, &request).await
    }

    async fn applied_view(&self, session: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.call(session, ops::SESSION_APPLIED_VIEW, &AppliedViewRequest {})
            .await
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendAnswer, ClientError> {
        self.call(session, ops::SESSION_SEND, &request).await
    }

    async fn run_result(
        &self,
        session: &SessionRef,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        self.call(session, ops::RUN_RESULT, &request).await
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
    /// The single role the opener declared, as name and version.
    role: Option<(String, String)>,
}

impl Handler {
    pub fn new(module: Module<SubcRunnerClient>) -> Self {
        Self {
            module,
            bound: Mutex::default(),
        }
    }

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Value, (String, String)> {
        let bound = self
            .bound
            .lock()
            .expect("bound routes")
            .get(&channel)
            .cloned()
            .ok_or_else(|| (codes::REFUSED.to_owned(), "route_unbound".to_owned()))?;
        let role = bound
            .role
            .as_ref()
            .map(|(name, version)| (name.as_str(), version.as_str()));
        match role {
            Some(COMPACTION_ROLE) => self.compaction(&bound.route, body).await,
            Some(TOOL_ROLE) => self.tool(&bound.route, body).await,
            Some(HOOK_ROLE) => self.hook(&bound.route, body).await,
            _ => Err((
                codes::REFUSED.to_owned(),
                "unknown_route_role: open the route for compaction-provider/v2, tool-provider/v1 or step-transform-provider/v1"
                    .to_owned(),
            )),
        }
    }

    /// A compaction op, about the session the route is bound to.
    async fn compaction(&self, route: &Route, body: &[u8]) -> Result<Value, (String, String)> {
        let bad = |message: String| (codes::BAD_REQUEST.to_owned(), message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        let session = &route.session;
        let answer = match method.as_str() {
            ops::COMPACTION_SETUP => to_value(
                self.module
                    .setup(route.clone(), wire::params(params).map_err(bad)?),
            ),
            ops::COMPACTION_NOTICE => to_value(
                self.module
                    .notice(session, wire::params(params).map_err(bad)?),
            ),
            ops::COMPACTION_RIDE => to_value(
                self.module
                    .ride(session, wire::params(params).map_err(bad)?)
                    .await,
            ),
            other => return Err(unknown_method(other)),
        };
        answer.map_err(refusal)
    }

    /// A model tool call (`tool-provider/v1`): the body is the published
    /// `{name, arguments}` call, and the answer its tool result. The call is
    /// about the session the route is bound to.
    async fn tool(&self, route: &Route, body: &[u8]) -> Result<Value, (String, String)> {
        let call: ToolCallRequest = serde_json::from_slice(body).map_err(|error| {
            (
                codes::BAD_REQUEST.to_owned(),
                format!("not a tool call: {error}"),
            )
        })?;
        if !call.name.starts_with("ctx_") {
            let error = cortexkit_role_tool_provider::errors::unknown_tool(&call.name);
            return Err((error.code, error.message));
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
        Ok(serde_json::to_value(result).expect("answers serialize"))
    }

    /// A hook op (`step-transform-provider/v1`). That contract names the
    /// session in the body, on a route that may serve all of a runner's
    /// sessions. The body only picks among the sessions of the runner the
    /// daemon attests for the route, so one runner never reaches another's;
    /// on a route bound to one session, the body must name that session.
    async fn hook(&self, route: &Route, body: &[u8]) -> Result<Value, (String, String)> {
        let bad = |message: String| (codes::BAD_REQUEST.to_owned(), message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        match method.as_str() {
            step::ops::TRANSFORM_DECLARE => {
                let request: DeclareRequest = wire::params(params).map_err(bad)?;
                let declaration = declare(request.preset.as_deref().unwrap_or("head"))
                    .ok_or_else(|| bad("unknown preset".into()))?;
                Ok(serde_json::to_value(declaration).expect("answers serialize"))
            }
            step::ops::TRANSFORM_HOOK => {
                let call: HookCall = wire::params(params).map_err(bad)?;
                let bound_to_session = route.session.harness != MODULE_LEVEL_HARNESS;
                if bound_to_session
                    && (call.harness != route.session.harness
                        || call.session != route.session.session)
                {
                    return Err((
                        codes::REFUSED.to_owned(),
                        "session_mismatch: the hook names another session than its route".into(),
                    ));
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
            other => Err(unknown_method(other)),
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

fn unknown_method(method: &str) -> (String, String) {
    (
        codes::UNKNOWN_METHOD.to_owned(),
        format!("ck-mc does not serve `{method}` on this route"),
    )
}

fn to_value<T: Serialize>(result: Result<T, ModuleError>) -> Result<Value, ModuleError> {
    result.map(|answer| serde_json::to_value(answer).expect("answers serialize"))
}

fn refusal(error: ModuleError) -> (String, String) {
    match error {
        ModuleError::UnknownSession => (
            codes::UNKNOWN_SESSION.to_owned(),
            "no Setup for this session".into(),
        ),
        other => (codes::REFUSED.to_owned(), format!("{other:?}")),
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
                "unattested_runner",
                "ck-mc serves sessions only to a runner the daemon attests",
            );
        };
        let role = match request.role_versions.as_ref() {
            Some(roles) if roles.len() == 1 => roles
                .iter()
                .next()
                .map(|(name, version)| (name.clone(), version.clone())),
            _ => None,
        };
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
            Ok(answer) => {
                HandlerOutcome::Response(serde_json::to_vec(&answer).expect("answers serialize"))
            }
            Err((code, message)) => HandlerOutcome::Error { code, message },
        }
    }
}
