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
use ck_contract_draft::wire::{self, codes, PreUserRequest, ToolCallAnswer, ToolCallRequest};
use ck_contract_draft::{ops, COMPACTION_PROVIDES, COMPACTION_ROLE};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, BindDecision, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler,
    RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_protocol::manifest::{
    CapabilityDeclarations, Concurrency, ExecutionMode, IdentityScope, ModuleManifest,
    ProviderRole, Tool,
};
use subc_protocol::Principal;
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::sync::OnceCell;

use crate::client::{ClientError, RunnerClient};
use crate::module::{Module, ModuleError};
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

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Value, (&'static str, String)> {
        let bad = |message: String| (codes::BAD_REQUEST, message);
        let (method, params) = wire::decode(body).map_err(bad)?;
        let role = match method.as_str() {
            ops::COMPACTION_SETUP | ops::COMPACTION_NOTICE | ops::COMPACTION_RIDE => {
                COMPACTION_ROLE
            }
            wire::ops::TOOL_CALL => TOOL_ROLE,
            wire::ops::PRE_USER => HOOK_ROLE,
            other => {
                return Err((
                    codes::UNKNOWN_METHOD,
                    format!("ck-mc does not serve `{other}`"),
                ))
            }
        };
        let bound = self.bound(channel, role)?;
        let session = &bound.route.session;
        let answer = match method.as_str() {
            ops::COMPACTION_SETUP => to_value(
                self.module
                    .setup(bound.route.clone(), wire::params(params).map_err(bad)?),
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
            wire::ops::TOOL_CALL => {
                let request: ToolCallRequest = wire::params(params).map_err(bad)?;
                let answer = match self
                    .module
                    .tool(session, &request.name, request.input)
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
                    .pre_user(session, &request.text, request.now)
                    .await;
                Ok(serde_json::to_value(answer).expect("answers serialize"))
            }
            _ => unreachable!("every method has a role above"),
        };
        answer.map_err(refusal)
    }

    /// The binding of the route a call came in on, when it was opened for
    /// `role`. A call on a route opened for another role is refused, so one
    /// role's route never carries another's ops.
    fn bound(&self, channel: u16, role: (&str, &str)) -> Result<Bound, (&'static str, String)> {
        let bound = self
            .bound
            .lock()
            .expect("bound routes")
            .get(&channel)
            .cloned()
            .ok_or((codes::REFUSED, "route_unbound".to_owned()))?;
        if bound
            .role
            .as_ref()
            .map(|(name, version)| (name.as_str(), version.as_str()))
            != Some(role)
        {
            return Err((
                codes::REFUSED,
                format!(
                    "wrong_route_role: this op needs a route opened for {}/{}",
                    role.0, role.1
                ),
            ));
        }
        Ok(bound)
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
            Err((code, message)) => HandlerOutcome::Error {
                code: code.into(),
                message,
            },
        }
    }
}
