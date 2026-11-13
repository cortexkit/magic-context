//! ck-mc over the subc daemon (the CortexKit module bus that routes calls
//! between module processes): the handler that serves the provider ops, and
//! the client that calls a session's runner back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, AppliedViewRequest, ApplyViewAnswer, ApplyViewRequest,
};
use cortexkit_role_compaction::wire::{self, codes, Refusal};
use cortexkit_role_compaction::{
    ops, COMPACTION_PROVIDES, COMPACTION_ROLE, COMPACTION_RUNNER_ROLE, LLM_RUNNER_ROLE,
};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest, RunStatus, RunStatusRequest};
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

// Enabling this makes runners cap and continue named reads and send the soft
// window-budget flag and ride cause. Deploy ck-mc's readers before declaring
// compaction-limits/v1 in its manifest.
const DECLARE_COMPACTION_LIMITS: bool = false;

/// The module's manifest with moves off ([`manifest_for`]).
pub fn manifest(module_id: &str) -> ModuleManifest {
    manifest_for(module_id, false)
}

/// The module's manifest: a tool provider, which is the role runners open
/// their compaction routes to, and its internal services. With
/// `agent_data` on it also declares the `agent-data` service and claims
/// `agent-data/v1`: Entorhinal finds participants in the catalog by the
/// claim, and the daemon opens a route only to a service the module
/// declares, so a participant needs both. With it off, neither is there.
pub fn manifest_for(module_id: &str, agent_data: bool) -> ModuleManifest {
    let mut provides = vec![
        ProviderRole::ToolProvider {
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
        },
        ProviderRole::InternalService {
            service_id: crate::context_read::ROLE.0.into(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: crate::context_read::OPS
                .into_iter()
                .map(str::to_owned)
                .collect(),
        },
        ProviderRole::InternalService {
            service_id: crate::app_read::ROLE.0.into(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: [
                "session_data.read",
                "context.watch",
                "context.states",
                "context.head",
                "context.head_section",
                "context.compartment",
                "context.cache_why",
                "context.search",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    ];
    if agent_data {
        provides.push(ProviderRole::InternalService {
            service_id: cortexkit_role_agent_data::SERVICE_ID.into(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: cortexkit_role_agent_data::REQUIRED_OPS
                .iter()
                .map(|op| (*op).to_owned())
                .collect(),
        });
    }
    // The phone reaches ck-mc through Callosum, which relays only
    // management-surface operations, so the reads it uses are also
    // declared there, as queries.
    provides.push(ProviderRole::ManagementSurface {
        operations: MANAGEMENT_APP_METHODS
            .iter()
            .chain(cortexkit_role_user_commands::MODULE_OPS.iter())
            .map(|method| subc_protocol::manifest::ManagementOperation {
                name: (*method).into(),
                kind: if *method == "commands.run" {
                    subc_protocol::manifest::ManagementOperationKind::Mutate
                } else {
                    subc_protocol::manifest::ManagementOperationKind::Query
                },
                description: None,
            })
            .collect(),
        config_schema: json!({ "type": "object" }),
        observability: Vec::new(),
        identity_scope: Vec::new(),
        concurrency: Concurrency::ModuleManaged,
    });
    let mut claims = vec![
        COMPACTION_PROVIDES.to_owned(),
        cortexkit_role_compaction::COMPACTION_ENTRY_SPEAKS_FOR_PROVIDES.to_owned(),
        cortexkit_role_compaction::COMPACTION_HOST_PARTS_PROVIDES.to_owned(),
        // The runner sends its signed floor (reasoning it strips after
        // a tool-set change) only to providers declaring this.
        cortexkit_role_compaction::COMPACTION_SIGNED_FLOOR_PROVIDES.to_owned(),
        cortexkit_role_compaction::COMPACTION_NOTES_TOKENS_PROVIDES.to_owned(),
        cortexkit_role_compaction::COMPACTION_RENDER_FAILED_PROVIDES.to_owned(),
        // The runner marks Setup, notices and rides with `statement_epoch`
        // and `statement_seq` only for providers declaring this (allowed from
        // contract 0.3.8 on), so ck-mc can drop a statement from a replaced
        // history and tell a notice that arrived late from newer runner
        // state (see `statement_order`).
        cortexkit_role_compaction::COMPACTION_STATEMENT_SEQ_PROVIDES.to_owned(),
        "mc-app-read/v1".to_owned(),
        "mc-context-read/v1".to_owned(),
        cortexkit_role_user_commands::PROVIDES.to_owned(),
        // Core finds tool providers and step-transform providers in
        // the daemon's module catalog by these claims, before it calls
        // `role.describe`. Without them core composes Magic Context
        // into no plan: no tools, no compaction, no `pre_user` hook.
        cortexkit_role_tool_provider::PROVIDES.to_owned(),
        step::PROVIDES.to_owned(),
        subc_protocol::scope::BIND_NO_PROJECT_CAPABILITY.to_owned(),
        subc_protocol::scope::SCOPE_WORKDIR_CAPABILITY.to_owned(),
    ];
    if agent_data {
        claims.push(cortexkit_role_agent_data::PROVIDES.to_owned());
    }
    if DECLARE_COMPACTION_LIMITS {
        claims.push(cortexkit_role_compaction::COMPACTION_LIMITS_PROVIDES.to_owned());
    }
    let routing = serde_json::to_value(crate::routing::consumer_declarations())
        .expect("routing declarations are JSON");
    let serde_json::Value::Object(routing) = routing else {
        unreachable!("routing declarations serialize as an object")
    };
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        .provides(provides)
        // Routing reads the consumers a module owns from its catalog entry,
        // so they stay known while the module is stopped.
        .role_declarations(std::collections::BTreeMap::from([(
            cortexkit_role_routing::ROLE_DECLARATIONS_KEY.to_owned(),
            routing,
        )]))
        // The daemon puts a scope's folder and project on a route's stamp
        // only for a provider that asks; they are where a session's project
        // comes from.
        .capabilities(Some(CapabilityDeclarations {
            provides: claims,
            requires: Vec::new(),
            must_never_reach: Vec::new(),
        }))
        // The build's commit, from MC_BUILD_SHA at compile time. The daemon
        // shows it in module status, and placement checks it to prove the
        // running module is the placed build. A missing or malformed stamp
        // (a plain `cargo build`) leaves it out rather than stopping the
        // module.
        .provenance(
            match subc_protocol::manifest::build_provenance(option_env!("MC_BUILD_SHA"), None, None)
            {
                Ok(provenance) => {
                    Some(provenance.with_launch_nonce_source(subc_client_rs::launch_nonce_source()))
                }
                Err(error) => {
                    tracing::warn!("ck-mc: MC_BUILD_SHA rejected, build not declared: {error}");
                    None
                }
            },
        )
        .build()
}

/// Calls a session's runner over its management surface. Connects on first
/// use.
pub struct SubcRunnerClient {
    connection_file: PathBuf,
    consumer: OnceCell<SubcConsumer>,
    /// The scopes ck-mc's summarizer children run under.
    child_scopes: Arc<ChildScopes>,
    runner_capabilities: crate::runner_capabilities::RunnerCapabilities,
    routing_capabilities: crate::routing::Capabilities,
}

impl SubcRunnerClient {
    pub fn new(connection_file: PathBuf, child_scopes: Arc<ChildScopes>) -> Self {
        Self {
            connection_file,
            consumer: OnceCell::new(),
            child_scopes,
            runner_capabilities: Default::default(),
            routing_capabilities: Default::default(),
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
            ClientError::new(format!(
                "{method}: the session has no project folder, so its summarizer has no child scope"
            ))
        })?;
        let mut synced_again = false;
        loop {
            let scope = self
                .child_scopes
                .for_project(root)
                .await
                .map_err(|error| ClientError::new(format!("{method}: child scope: {error}")))?;
            match self
                .call_raw(&child.session, LLM_RUNNER_ROLE, method, params, Some(scope))
                .await
            {
                Err(error) if !synced_again && error.message.contains("scope_not_synced") => {
                    self.child_scopes.forget_sync().await;
                    synced_again = true;
                }
                Err(error) => return Err(error),
                Ok(reply) => {
                    return cortexkit_role_llm_runner::wire::read_reply(&reply)
                        .map_err(|error| ClientError::new(format!("{method} answer: {error:?}")))
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
                .map_err(|error| ClientError::new(format!("{method} answer: {error:?}")));
        }
        serde_json::from_slice(&reply)
            .map_err(|error| ClientError::new(format!("{method} answer: {error}")))
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
            .map_err(|error| ClientError::new(format!("connect: {error:?}")))?;
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
                    .map_err(|error| call_error(method, &error))?;
                consumer.request(&route, body, options).await
            }
        }
        .map_err(|error| call_error(method, &error))?;
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

    async fn routing_provider(&self) -> Result<(&SubcConsumer, String), RouteError> {
        let unavailable = |message: String| RouteError {
            code: "routing_unavailable".into(),
            message,
            detail: None,
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
                    detail: None,
                })
            }
        };
        Ok((consumer, module_id))
    }

    /// One call to the routing provider the catalog lists. Its answer is
    /// `{"result": <answer>}`; a refusal is `{code, message, detail}`.
    async fn route_call<P: Serialize>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<Value, RouteError> {
        let (consumer, module_id) = self.routing_provider().await?;
        Self::route_call_on(consumer, &module_id, method, params).await
    }

    async fn route_call_on<P: Serialize>(
        consumer: &SubcConsumer,
        module_id: &str,
        method: &str,
        params: &P,
    ) -> Result<Value, RouteError> {
        let unavailable = |message: String| RouteError {
            code: "routing_unavailable".into(),
            message,
            detail: None,
        };
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: module_id.to_owned(),
                },
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
                    detail: body.detail,
                },
                other => unavailable(format!("{method}: {other:?}")),
            })?;
        let mut body: Value = serde_json::from_slice(&reply).map_err(|error| RouteError {
            code: "routing_unavailable".into(),
            message: format!("{method} answer: {error}"),
            detail: None,
        })?;
        Ok(body["result"].take())
    }
}

impl crate::routing::Router for SubcRunnerClient {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let (consumer, module_id) = self.routing_provider().await?;
        // Discovery and selection must use the same provider: runner features
        // cannot authorize optional fields on routing's separate role.
        let request = self
            .routing_capabilities
            .select_request(
                &module_id,
                consumer.current_epoch(),
                request,
                Self::route_call_on(consumer, &module_id, "role.describe", &json!({})),
            )
            .await;
        let result = Self::route_call_on(consumer, &module_id, "route.select", &request).await?;
        serde_json::from_value(result).map_err(|error| RouteError {
            code: "routing_unavailable".into(),
            message: format!("route.select answer: {error}"),
            detail: None,
        })
    }

    async fn report(&self, request: ReportRequest) {
        if let Err(error) = self.route_call("route.report", &request).await {
            tracing::warn!("ck-mc: route.report failed: {error}");
        }
    }
}

impl RunnerClient for SubcRunnerClient {
    fn runner_setup(&self, runner: &str) {
        self.runner_capabilities.forget(runner);
    }

    async fn notice_keep(&self, session: &SessionRef) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .notice_keep(
                &session.runner,
                epoch,
                self.call(session, LLM_RUNNER_ROLE, "role.describe", &json!({})),
            )
            .await
    }

    async fn turn_system_cleared(&self, session: &SessionRef) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .turn_system_cleared(
                &session.runner,
                epoch,
                self.call(session, LLM_RUNNER_ROLE, "role.describe", &json!({})),
            )
            .await
    }

    async fn child_cache_policy(&self, child: &Child) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .cache_policy(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await
    }

    async fn child_session_class(&self, child: &Child) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .session_class(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await
    }

    async fn child_temperature(&self, child: &Child) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .temperature(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await
    }

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

    async fn child_status(
        &self,
        child: &Child,
        request: RunStatusRequest,
    ) -> Result<RunStatus, ClientError> {
        self.child_call(child, cortexkit_role_llm_runner::ops::RUN_STATUS, &request)
            .await
    }

    async fn cancel_child_run(&self, child: &Child, run_id: &str) -> Result<bool, ClientError> {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        let declared = self
            .runner_capabilities
            .run_cancel(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await;
        if !declared {
            return Ok(false);
        }
        let request = cortexkit_role_llm_runner::run::RunCancelRequest::new(run_id);
        self.child_call::<_, Value>(child, cortexkit_role_llm_runner::ops::RUN_CANCEL, &request)
            .await
            .map(|_| true)
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
                // Route-open refusals are NotSent, not Module errors. Keep the
                // daemon's code so searches can remember an absent Synapse.
                error
                    if matches!(
                        error
                            .route_open_refusal()
                            .map(|refusal| refusal.code.as_str()),
                        Some("unknown_module")
                    ) =>
                {
                    "unknown_module".to_owned()
                }
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
        engram_result(value)
    }

    /// The modules in the daemon's catalog that claim `capability` and are
    /// ready and nonce-verified. `resolve_providers` matches the claim
    /// alone, and would list a module the daemon would not open a route to.
    async fn ready_participants(&self, capability: &str) -> Result<Vec<String>, String> {
        let consumer = self.consumer().await?;
        let catalog = consumer
            .catalog_list()
            .await
            .map_err(|error| format!("{error:?}"))?;
        Ok(crate::agent_data::service::ready_participants(
            &catalog.modules,
            capability,
        ))
    }

    /// On Engram's session door, which keeps one stream per caller and
    /// session: it derives the stream from the route's attested caller,
    /// ck-mc's own principal, so the bind identity names no session.
    async fn door_call(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, crate::client::DoorRefusal> {
        use crate::client::DoorRefusal;
        let consumer = self.consumer().await.map_err(DoorRefusal::unavailable)?;
        let reply = consumer
            .call(
                // Named, not resolved by capability as the other providers
                // here are: Engram declares no capability for its session
                // door, and `engram` is a reserved module id the daemon
                // verifies by launch nonce, so no other process can answer
                // under it.
                RouteTarget::InternalService {
                    module_id: "engram".to_owned(),
                    service_id: "session-door".to_owned(),
                },
                // Chosen by ck-mc and never attested, so it grants nothing:
                // the door decides by the route's attested caller alone.
                BindIdentity::new("agent-data", "agent-data"),
                wire::encode(method, &params),
                CallOptions {
                    timeout: deadline,
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(|error| match error {
                subc_client_rs::CallError::Module(body) => DoorRefusal {
                    code: body.code,
                    message: body.message,
                    detail: body.detail,
                },
                other => DoorRefusal::unavailable(format!("{method}: {other:?}")),
            })?;
        let value: Value = serde_json::from_slice(&reply).map_err(|error| {
            DoorRefusal::unavailable(format!("{method} answer is not JSON: {error}"))
        })?;
        engram_result(value)
            .map_err(|_| DoorRefusal::unavailable(format!("{method} answer has no result")))
    }

    fn door_stream(&self) -> String {
        format!("reserved:{}", self.child_scopes.module_id())
    }
}

/// Engram answers a device-streams call as `{"result": <answer>}`; a
/// refusal arrives as an error frame instead.
fn engram_result(mut value: Value) -> Result<Value, String> {
    match value
        .as_object_mut()
        .and_then(|object| object.remove("result"))
    {
        Some(result) => Ok(result),
        None => Err("malformed_reply".to_owned()),
    }
}

#[cfg(test)]
mod engram_reply_tests {
    use super::engram_result;
    use serde_json::json;

    #[test]
    fn an_engram_answer_is_read_from_its_result_member() {
        let heads = json!({"account": "a", "device": "d", "devices": []});
        assert_eq!(engram_result(json!({"result": heads.clone()})), Ok(heads));
        assert_eq!(
            engram_result(json!({"account": "a"})),
            Err("malformed_reply".to_owned())
        );
    }
}

/// Serves the provider ops for the daemon.
pub struct Handler {
    module: Module<SubcRunnerClient>,
    /// Every bound route, by channel: what the daemon said about it at bind.
    bound: Mutex<HashMap<u16, Bound>>,
    app_bound: Mutex<HashMap<u16, AppCaller>>,
    command_bound: Mutex<HashMap<u16, Principal>>,
    context_bound: Mutex<std::collections::HashSet<u16>>,
    /// Every bound `agent-data` route, by channel, with the caller the
    /// daemon stamped on it.
    agent_data_bound: Mutex<HashMap<u16, String>>,
    answer_routes: Mutex<HashMap<u16, AnswerRoute>>,
}

/// Who a route's answers go to, recorded at bind so a slow answer can be
/// logged with its session and calling module.
struct AnswerRoute {
    session: Option<String>,
    caller: Option<String>,
}

/// Log an answer that took 500 ms or more, so a runner's "late reply" can be
/// checked against ck-mc's side. From 1,500 ms, the deadline runners give a
/// step hook, it is a warning. The time runs from the request's arrival to
/// the handler's return: a Setup or notice is answered when it is queued,
/// so this is the wait the runner saw, not the session's later work.
fn log_slow_answer(elapsed: Duration, body: &[u8], route: Option<&AnswerRoute>) {
    let elapsed_ms = elapsed.as_millis();
    if elapsed_ms < 500 {
        return;
    }
    let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let op = request
        .get("method")
        .or_else(|| request.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let session = route
        .and_then(|route| route.session.as_deref())
        .unwrap_or("");
    let caller = route
        .and_then(|route| route.caller.as_deref())
        .unwrap_or("");
    if elapsed_ms >= 1500 {
        tracing::warn!(op, elapsed_ms, session, caller, "ck-mc slow answer");
    } else {
        tracing::info!(op, elapsed_ms, session, caller, "ck-mc slow answer");
    }
}

#[derive(Clone, Debug)]
struct AppCaller {
    principal: Principal,
    harness: String,
    /// Whether the route is ck-mc's management surface, which serves only
    /// [`MANAGEMENT_APP_METHODS`].
    management: bool,
}

impl AppCaller {
    fn allowed(&self) -> bool {
        match &self.principal {
            Principal::Direct => crate::app_read::DEVELOPMENT_ADMITS_DIRECT,
            Principal::Reserved { module_id } => {
                module_id == "callosum" && self.harness.starts_with("fed-phone:")
            }
            _ => false,
        }
    }
    fn quota(&self) -> String {
        if matches!(self.principal, Principal::Direct) {
            "direct".into()
        } else {
            self.harness.clone()
        }
    }
}

/// The app reads ck-mc's management surface serves: the ones the phone uses,
/// as Callosum relays only management operations. The desktop reaches every
/// read on the internal app-read service.
const MANAGEMENT_APP_METHODS: &[&str] = &[
    "session_data.read",
    "context.cache_why",
    "context.search",
    "context.watch",
];

/// Whether a route is opened to the `agent-data` service: by its target or
/// by the role it declares.
fn agent_data_route(request: &RouteBindRequest) -> bool {
    matches!(&request.target, RouteTarget::InternalService { service_id, .. } if service_id == cortexkit_role_agent_data::SERVICE_ID)
        || request
            .role_versions
            .as_ref()
            .is_some_and(|roles| roles.contains_key(cortexkit_role_agent_data::ROLE))
}

/// An `agent-data` route is bound only on ck-mc's own service, and only for
/// the caller the contract admits. The caller is the principal the daemon
/// stamped on the bind, never anything the caller says, and it is checked
/// again on every request before the request is decoded.
fn agent_data_admission(
    request: &RouteBindRequest,
) -> Result<String, cortexkit_role_agent_data::errors::ErrorBody> {
    use cortexkit_role_agent_data::errors::{ErrorBody, RefusalCode};
    let target = matches!(&request.target,
        RouteTarget::InternalService { module_id, service_id }
        if module_id == crate::MODULE_ID && service_id == cortexkit_role_agent_data::SERVICE_ID);
    let caller = principal_text(request.principal.as_ref());
    if !target || !cortexkit_role_agent_data::caller_admitted(&caller) {
        return Err(ErrorBody::new(
            RefusalCode::CallerForbidden,
            format!(
                "Only {} may open an agent-data route to ck-mc.",
                cortexkit_role_agent_data::ADMITTED_CALLER
            ),
        ));
    }
    Ok(caller)
}

/// A principal as the agent-data contract spells callers:
/// `reserved:<module id>`, `direct` or `unverified`; empty when the daemon
/// stamped none.
fn principal_text(principal: Option<&Principal>) -> String {
    match principal {
        Some(Principal::Reserved { module_id }) => format!("reserved:{module_id}"),
        Some(Principal::Direct) => "direct".to_owned(),
        Some(Principal::Unverified) => "unverified".to_owned(),
        None => String::new(),
    }
}

fn context_admission(request: &RouteBindRequest) -> Result<(), Refusal> {
    let target = matches!(&request.target,
        RouteTarget::InternalService { module_id, service_id }
        if module_id == crate::MODULE_ID && service_id == crate::context_read::ROLE.0);
    let principal = matches!(&request.principal,
        Some(Principal::Reserved { module_id }) if module_id == "colliculus");
    let version = request.role_versions.as_ref().is_none_or(|roles| {
        roles.len() == 1
            && roles.get(crate::context_read::ROLE.0).map(String::as_str)
                == Some(crate::context_read::ROLE.1)
    });
    if !target || !principal || !version || request.scope.is_some() {
        return Err(Refusal::new(
            "not_permitted",
            "Context reads require an attested colliculus service route.",
            None,
        ));
    }
    Ok(())
}

fn app_admission(request: &RouteBindRequest) -> Result<AppCaller, Refusal> {
    let refused = || {
        Refusal::new(
            "not_permitted",
            "App reads require an unscoped operator app route.",
            None,
        )
    };
    let management = match &request.target {
        RouteTarget::InternalService {
            module_id,
            service_id,
        } if module_id == crate::MODULE_ID && service_id == crate::app_read::ROLE.0 => false,
        RouteTarget::ManagementSurface { module_id } if module_id == crate::MODULE_ID => true,
        _ => return Err(refused()),
    };
    if request.scope.is_some()
        || request.role_versions.as_ref().is_some_and(|roles| {
            roles.iter().any(|(name, version)| {
                name != crate::app_read::ROLE.0 || version != crate::app_read::ROLE.1
            })
        })
    {
        return Err(refused());
    }
    let caller = AppCaller {
        principal: request.principal.clone().ok_or_else(refused)?,
        harness: request.identity.harness.clone(),
        management,
    };
    if !caller.allowed() {
        return Err(refused());
    }
    Ok(caller)
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
            app_bound: Mutex::default(),
            command_bound: Mutex::default(),
            context_bound: Mutex::default(),
            agent_data_bound: Mutex::default(),
            answer_routes: Mutex::default(),
        }
    }

    /// An `agent-data` request on `channel`, when that channel is a bound
    /// `agent-data` route: the reply's bytes or the contract's refusal.
    /// `None` for any other channel.
    async fn agent_data(
        &self,
        channel: u16,
        body: &[u8],
    ) -> Option<Result<Vec<u8>, cortexkit_role_agent_data::errors::ErrorBody>> {
        let caller = self
            .agent_data_bound
            .lock()
            .expect("agent-data routes")
            .get(&channel)
            .cloned()?;
        Some(self.module.agent_data(&caller, body).await)
    }

    async fn app(
        &self,
        ctx: &RequestCtx,
        body: &[u8],
        caller: AppCaller,
    ) -> Result<HandlerOutcome, Refusal> {
        if !caller.allowed() {
            return Err(Refusal::new(
                "not_permitted",
                "App admission is no longer granted.",
                None,
            ));
        }
        if body.len() > 64 * 1024 {
            return Err(Refusal::new(
                "invalid_params",
                "App request exceeds 64 KiB.",
                None,
            ));
        }
        let value: Value =
            serde_json::from_slice(body).map_err(|_| crate::app_read::invalid("request"))?;
        let envelope = crate::app_read::object(&value, &["method", "params"])?;
        let method = crate::app_read::string(envelope, "method")?;
        if caller.management && !MANAGEMENT_APP_METHODS.contains(&method) {
            return Err(Refusal::new(
                "unknown_method",
                format!("{method} isn't served on ck-mc's management surface."),
                None,
            ));
        }
        let params = envelope.get("params").cloned().unwrap_or(Value::Null);
        if method == "context.watch" {
            let mut subscription = self.module.app_watch(caller.quota(), params).await?;
            loop {
                let notice = tokio::select! {
                    _ = ctx.cancelled() => return Ok(HandlerOutcome::Streamed),
                    value = subscription.recv() => match value? { Some(value) => value, None => return Ok(HandlerOutcome::Streamed) },
                };
                let bytes = crate::app_read::reply_bytes(method, notice)?;
                tokio::select! {
                    _ = ctx.cancelled() => return Ok(HandlerOutcome::Streamed),
                    result = ctx.emit(bytes) => if result.is_err() { return Ok(HandlerOutcome::Streamed); },
                }
            }
        }
        let value = self.module.app_request(method, params).await?;
        let bytes = crate::app_read::reply_bytes(method, value)?;
        Ok(HandlerOutcome::Response(bytes))
    }

    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        // Every route was checked at bind (`on_bind`): one known role, and a
        // bound session unless it is a module-level hook or tool route, which
        // answers discovery only.
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
            RouteRole::Tools => {
                return self.tool(&bound.route, body).await.map_err(|mut refusal| {
                    refusal.message = crate::tool_output::bounded(refusal.message);
                    refusal
                });
            }
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
        // A tool call acts on the session its route is bound to; a route
        // bound to no session answers the catalog only.
        if route.session.harness == MODULE_LEVEL_HARNESS {
            return Err(Refusal::new(
                codes::ROUTE_UNBOUND,
                format!("`{}` needs a route bound to the session", call.name),
                None,
            ));
        }
        if !call.name.starts_with("ctx_") {
            let error = cortexkit_role_tool_provider::errors::unknown_tool(&call.name);
            return Err(Refusal::new(&error.code, error.message, None));
        }
        // A malformed call key or pin, or a pin naming another tool, is
        // refused before anything runs; a pin ck-mc can no longer honour is
        // refused by name, and the runner records it as the call's result.
        let pin = cortexkit_role_tool_provider::call::check_call(&call)
            .map_err(|error| Refusal::new(&error.code, error.message, error.detail))?;
        if let Some(pin) = pin {
            if let Err(refused) = crate::catalog::check_pin(&pin) {
                return Err(Refusal::new(
                    refused.code,
                    format!("{} can no longer honour this call's schema pin", pin.tool),
                    Some(refused.detail),
                ));
            }
        }
        let (text, is_error) = match self.module.tool(route, &call.name, call.arguments).await {
            Ok(output) => (output, false),
            Err(ModuleError::Tool(output)) => (output, true),
            Err(other) => return Err(refusal(other)),
        };
        let mut result =
            ToolResult::new(vec![ContentPart::text(crate::tool_output::bounded(text))]);
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
            // A runner handed a plan naming ck-mc checks this before it routes
            // a hook here, and refuses the provider when an op is missing.
            step::ops::ROLE_DESCRIBE => Ok(step_describe()),
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

/// ck-mc's description of the build, never of a session: the tool-provider
/// answer (with its `compacting-preflight/v1` capability) plus the
/// step-transform and compaction majors. Core reads one route's answer while
/// it composes a plan; a runner's check reads only the major it needs and
/// ignores the rest.
fn step_describe() -> Value {
    let mut answer: Value = crate::catalog::role_describe_bytes()
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({"majors": [], "implementation_version": crate::version_line()}));
    let step_major = step::describe::Major::new(
        step::PROVIDES,
        step::REQUIRED_OPS
            .iter()
            .map(|op| (*op).to_owned())
            .collect(),
        "alpha",
    );
    if let Some(majors) = answer.get_mut("majors").and_then(Value::as_array_mut) {
        majors.push(serde_json::to_value(step_major).expect("answers serialize"));
        majors.push(json!({
            "version": COMPACTION_PROVIDES,
            "ops": [ops::COMPACTION_SETUP, ops::COMPACTION_NOTICE, ops::COMPACTION_RIDE],
            "stability": "alpha",
        }));
    }
    answer
}

/// A route to ck-mc's own management surface from a module the daemon
/// attests, not for the app reads: core reading the declarations it composes
/// a plan from. It may be scoped (core binds it under the head's scope) and
/// may name a role; it serves discovery only, so neither widens anything.
fn module_discovery(request: &RouteBindRequest) -> bool {
    matches!(
        &request.target,
        RouteTarget::ManagementSurface { module_id } if module_id == crate::MODULE_ID
    ) && matches!(request.principal, Some(Principal::Reserved { .. }))
        && !request
            .role_versions
            .as_ref()
            .is_some_and(|roles| roles.contains_key(crate::app_read::ROLE.0))
}

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
        ModuleError::Gated(gated) => gated.refusal(),
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
        let session = (request.identity.harness != MODULE_LEVEL_HARNESS
            && !request.identity.session.is_empty())
        .then(|| request.identity.session.clone());
        let caller = match &request.principal {
            Some(Principal::Reserved { module_id }) => Some(module_id.clone()),
            _ => None,
        };
        self.answer_routes
            .lock()
            .expect("answer routes")
            .insert(request.handle.channel, AnswerRoute { session, caller });
        self.bound
            .lock()
            .expect("bound routes")
            .remove(&request.handle.channel);
        self.app_bound
            .lock()
            .expect("app routes")
            .remove(&request.handle.channel);
        self.context_bound
            .lock()
            .expect("context routes")
            .remove(&request.handle.channel);
        self.agent_data_bound
            .lock()
            .expect("agent-data routes")
            .remove(&request.handle.channel);
        self.command_bound
            .lock()
            .expect("command routes")
            .remove(&request.handle.channel);
        if matches!(&request.target, RouteTarget::ManagementSurface { module_id } if module_id == crate::MODULE_ID)
        {
            let principal = request.principal.clone().unwrap_or(Principal::Unverified);
            self.command_bound
                .lock()
                .expect("command routes")
                .insert(request.handle.channel, principal.clone());
            if cortexkit_role_user_commands::check_admission(&principal, false, false).is_ok() {
                self.bound.lock().expect("bound routes").insert(
                    request.handle.channel,
                    Bound {
                        route: Route {
                            session: SessionRef::new(
                                "",
                                MODULE_LEVEL_HARNESS,
                                request.identity.session.clone(),
                            ),
                            project: None,
                            workdir: None,
                            agent_id: None,
                        },
                        role: RouteRole::Hooks,
                    },
                );
                return BindDecision::accept();
            }
        }
        // First: app admission below takes every other internal-service
        // route and would judge Entorhinal as an app caller. With moves off
        // an agent-data route goes on like a route to any service ck-mc
        // does not declare, and is refused the same way.
        if self.module.agent_data_enabled() && agent_data_route(request) {
            return match agent_data_admission(request) {
                Ok(caller) => {
                    self.agent_data_bound
                        .lock()
                        .expect("agent-data routes")
                        .insert(request.handle.channel, caller);
                    BindDecision::accept()
                }
                Err(error) => {
                    tracing::warn!(
                        target = ?request.target,
                        principal = ?request.principal,
                        "ck-mc refused an agent-data route at bind: only reserved:entorhinal may open one"
                    );
                    BindDecision::reject(error.code.as_str(), error.message)
                }
            };
        }
        if matches!(&request.target, RouteTarget::InternalService { service_id, .. } if service_id == crate::context_read::ROLE.0)
            || request
                .role_versions
                .as_ref()
                .is_some_and(|roles| roles.contains_key(crate::context_read::ROLE.0))
        {
            return match context_admission(request) {
                Ok(()) => {
                    self.context_bound
                        .lock()
                        .expect("context routes")
                        .insert(request.handle.channel);
                    BindDecision::accept()
                }
                Err(error) => BindDecision::reject(error.code, error.message),
            };
        }
        if matches!(
            &request.target,
            RouteTarget::InternalService { .. } | RouteTarget::ManagementSurface { .. }
        ) || request
            .role_versions
            .as_ref()
            .is_some_and(|roles| roles.contains_key(crate::app_read::ROLE.0))
        {
            return match app_admission(request) {
                Ok(caller) => {
                    self.app_bound
                        .lock()
                        .expect("app routes")
                        .insert(request.handle.channel, caller);
                    BindDecision::accept()
                }
                // Core composes a session's plan before the session exists, so
                // it reads ck-mc's step-transform declaration over ck-mc's own
                // management surface (step-transform-provider/v2 allows a
                // declaration on a module route). An attested module that is
                // not a phone gets that discovery only: `role.describe` and
                // `transform.declare`, never a hook or an app read.
                Err(_) if module_discovery(request) => {
                    self.bound.lock().expect("bound routes").insert(
                        request.handle.channel,
                        Bound {
                            route: Route {
                                session: SessionRef::new(
                                    "",
                                    MODULE_LEVEL_HARNESS,
                                    request.identity.session.clone(),
                                ),
                                project: None,
                                workdir: None,
                                agent_id: None,
                            },
                            role: RouteRole::Hooks,
                        },
                    );
                    BindDecision::accept()
                }
                Err(error) => {
                    tracing::warn!(
                        target = ?request.target,
                        principal = ?request.principal,
                        role_versions = ?request.role_versions,
                        scoped = request.scope.is_some(),
                        harness = %request.identity.harness,
                        code = %error.code,
                        "ck-mc refused a route at bind"
                    );
                    BindDecision::reject(error.code, error.message)
                }
            };
        }
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
        // Hook and tool routes may open unbound, for discovery only: a hook
        // route for `role.describe` and `transform.declare`, a tool route for
        // `role.describe` and `tool.catalog` (core lists a head's tools that
        // way when the head registered no session). A compaction route always
        // concerns the session it is bound to.
        if matches!(role, RouteRole::Compaction) && request.identity.harness == MODULE_LEVEL_HARNESS
        {
            return BindDecision::reject(
                codes::ROUTE_UNBOUND,
                "compaction routes must be bound to a session",
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
        let started = Instant::now();
        let channel = ctx.route_handle().channel;
        let outcome = if let Some(answer) = self.command(channel, &body).await {
            match answer {
                Ok(value) => {
                    HandlerOutcome::Response(serde_json::to_vec(&value).expect("command reply"))
                }
                Err(error) => HandlerOutcome::ErrorWithDetail {
                    code: error.code,
                    message: error.message,
                    detail: error.detail.unwrap_or(Value::Null),
                },
            }
        } else {
            self.handle_non_command(ctx, &body).await
        };
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_millis(500) && !matches!(outcome, HandlerOutcome::Streamed) {
            let routes = self.answer_routes.lock().expect("answer routes");
            log_slow_answer(elapsed, &body, routes.get(&channel));
        }
        outcome
    }
}

impl Handler {
    async fn command(
        &self,
        channel: u16,
        body: &[u8],
    ) -> Option<Result<Value, subc_protocol::ErrorBody>> {
        let principal = self
            .command_bound
            .lock()
            .expect("command routes")
            .get(&channel)
            .cloned();
        if let Some(principal) = principal {
            // Other management consumers retain their existing operations.
            // Command params are decoded only after admitting the daemon's
            // recorded caller for this route.
            let admitted =
                cortexkit_role_user_commands::check_admission(&principal, false, false).is_ok();
            let command = crate::user_commands::method(body)
                .map_or(admitted, |method| method.starts_with("commands."));
            if command {
                return Some(self.module.command_request(&principal, body).await);
            }
        }
        None
    }

    async fn handle_non_command(&self, ctx: RequestCtx, body: &[u8]) -> HandlerOutcome {
        // Before any other route: a move's request never reaches a session,
        // app or context handler.
        if let Some(answer) = self.agent_data(ctx.route_handle().channel, body).await {
            return match answer {
                Ok(reply) => HandlerOutcome::Response(reply),
                Err(refusal) => match refusal.detail {
                    Some(detail) => HandlerOutcome::ErrorWithDetail {
                        code: refusal.code.as_str().to_owned(),
                        message: refusal.message,
                        detail,
                    },
                    None => HandlerOutcome::Error {
                        code: refusal.code.as_str().to_owned(),
                        message: refusal.message,
                    },
                },
            };
        }
        let context = self
            .context_bound
            .lock()
            .expect("context routes")
            .contains(&ctx.route_handle().channel);
        let caller = self
            .app_bound
            .lock()
            .expect("app routes")
            .get(&ctx.route_handle().channel)
            .cloned();
        let result = if context {
            self.module
                .context_read()
                .read(body)
                .await
                .map(|value| HandlerOutcome::Response(crate::app_read::result_bytes(value)))
        } else if let Some(caller) = caller {
            self.app(&ctx, body, caller).await
        } else {
            self.dispatch(ctx.route_handle().channel, body)
                .await
                .map(HandlerOutcome::Response)
        };
        match result {
            Ok(answer) => answer,
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

/// A failed runner call, keeping the refusal's code when the runner refused
/// the route at bind or the call itself.
fn call_error(method: &str, error: &subc_client_rs::CallError) -> ClientError {
    let code = error
        .route_open_refusal()
        .map(|body| body.code.clone())
        .or_else(|| error.code().map(str::to_owned));
    // A runner's own refusal keeps its detail: some refusals, such as an
    // account wait, say in it when to ask again.
    let detail = match error {
        subc_client_rs::CallError::Module(body) => body.detail.clone(),
        _ => None,
    };
    ClientError {
        message: format!("{method}: {error:?}"),
        code,
        detail,
    }
}

#[cfg(test)]
#[path = "transport_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "transport_slow_answer_tests.rs"]
mod slow_answer_tests;

#[cfg(test)]
#[path = "tool_conformance_tests.rs"]
mod tool_conformance_tests;

#[cfg(test)]
#[path = "agent_data/transport_tests.rs"]
mod agent_data_transport_tests;

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
    use super::*;

    /// The schema-pin checks run before a tool does: a pin naming another
    /// tool is a malformed call, and a pin this build can't serve is refused
    /// by name.
    #[tokio::test]
    async fn a_call_is_checked_against_its_schema_pin_before_it_runs() {
        let handler = Handler::new(Module::new(
            SubcRunnerClient::new(
                std::env::temp_dir().join("ck-mc-pin-unused"),
                Arc::new(ChildScopes::new("test-pin")),
            ),
            crate::config::Config::from(crate::pass::Settings::default()),
            None,
            None,
        ));
        let route = Route {
            session: SessionRef::new("runner", "test", "pin"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let call = |pin: &str| {
            serde_json::to_vec(&json!({
                "name": "ctx_note",
                "arguments": {"action": "read"},
                "schema_pin": pin,
            }))
            .unwrap()
        };
        let other =
            cortexkit_role_tool_provider::call::SchemaPin::new("ctx_memory", "0".repeat(64), 1)
                .encode()
                .unwrap();
        let refused = handler.tool(&route, &call(&other)).await.err().unwrap();
        assert_eq!(refused.code, "invalid_request");
        let stale =
            cortexkit_role_tool_provider::call::SchemaPin::new("ctx_note", "0".repeat(64), 1)
                .encode()
                .unwrap();
        let refused = handler.tool(&route, &call(&stale)).await.err().unwrap();
        assert_eq!(refused.code, "tool_schema_changed");
    }

    #[test]
    fn unknown_tool_is_a_protocol_refusal() {
        let refusal = super::refusal(crate::module::ModuleError::UnknownTool(
            "ctx_missing".into(),
        ));
        assert_eq!(refusal.code, "unknown_tool");
    }
}

#[cfg(test)]
mod app_read_tests {
    use super::*;

    #[test]
    fn app_read_head_is_declared_and_uses_the_states_admission() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let service = manifest["provides"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["service_id"] == "mc-app-read")
            .unwrap();
        for method in ["context.head", "context.head_section", "context.states"] {
            assert!(service["operations"]
                .as_array()
                .unwrap()
                .contains(&json!(method)));
            // Admission precedes method decoding, so a forbidden caller cannot
            // enter either read, regardless of the requested session.
            let mut bind = request();
            bind.principal = Some(Principal::Unverified);
            assert_eq!(app_admission(&bind).unwrap_err().code, "not_permitted");
        }
    }

    #[test]
    fn app_read_oversized_replies_name_the_method_and_use_the_size_refusal() {
        for method in [
            "context.head",
            "context.head_section",
            "session_data.read",
            "context.watch",
        ] {
            let refusal =
                crate::app_read::reply_bytes(method, json!("x".repeat(512 * 1024))).unwrap_err();
            assert_eq!(refusal.code, "reply_too_large");
            assert!(refusal.message.contains(method));
        }
        assert!(crate::app_read::reply_bytes("context.head", json!({})).is_ok());
    }

    fn request() -> RouteBindRequest {
        let mut request = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(10, 1),
            RouteTarget::InternalService {
                module_id: crate::MODULE_ID.into(),
                service_id: "mc-app-read".into(),
            },
            BindIdentity::new("", "alfonso-desktop"),
        );
        request.principal = Some(Principal::Direct);
        request.role_versions = Some(std::collections::BTreeMap::from([(
            "mc-app-read".into(),
            "v1".into(),
        )]));
        request
    }

    #[test]
    fn app_read_development_direct_and_attested_phone_are_the_only_admissions() {
        let mut request = request();
        let direct = app_admission(&request).unwrap();
        assert!(direct.allowed());
        assert_eq!(direct.quota(), "direct");
        request.principal = Some(Principal::Reserved {
            module_id: "callosum".into(),
        });
        request.identity = BindIdentity::new("fed-phone:device-a", "app");
        let phone = app_admission(&request).unwrap();
        assert!(phone.allowed());
        assert_eq!(phone.quota(), "fed-phone:device-a");
        request.identity = BindIdentity::new("other", "app");
        assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
        request.identity = BindIdentity::new("fed-phone:device-a", "app");
        for principal in [
            None,
            Some(Principal::Unverified),
            Some(Principal::Reserved {
                module_id: "untrusted-module".into(),
            }),
        ] {
            request.principal = principal;
            assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
        }
    }

    /// The phone's reads come through Callosum, which relays only management
    /// operations: ck-mc's own management surface admits the same callers as
    /// the app-read service, and a management route is marked so it serves
    /// only the phone's methods.
    #[test]
    fn app_read_admits_ck_mcs_own_management_surface_for_the_phone() {
        let mut request = request();
        request.target = RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        request.role_versions = None;
        request.principal = Some(Principal::Reserved {
            module_id: "callosum".into(),
        });
        request.identity.harness = "fed-phone:device-1".into();
        assert!(app_admission(&request).unwrap().management);
        request.target = RouteTarget::ManagementSurface {
            module_id: "other".into(),
        };
        assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
        request.target = RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        request.identity.harness = "opencode".into();
        assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
    }

    #[test]
    fn the_manifest_declares_the_phones_reads_as_management_queries() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let surface = manifest["provides"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["role"] == "management_surface")
            .expect("a management surface");
        let mut operations: Vec<(String, String)> = surface["operations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| {
                (
                    op["name"].as_str().unwrap().to_owned(),
                    op["kind"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        operations.sort();
        assert_eq!(
            operations,
            [
                ("commands.describe".into(), "query".into()),
                ("commands.preview".into(), "query".into()),
                ("commands.run".into(), "mutate".into()),
                ("context.cache_why".into(), "query".into()),
                ("context.search".into(), "query".into()),
                ("context.watch".into(), "query".into()),
                ("session_data.read".into(), "query".into()),
            ]
        );
    }

    #[test]
    fn app_read_refuses_wrong_targets_and_all_scopes_including_flows() {
        for target in [
            RouteTarget::InternalService {
                module_id: "other".into(),
                service_id: "mc-app-read".into(),
            },
            RouteTarget::ToolProvider {
                module_id: crate::MODULE_ID.into(),
            },
        ] {
            let mut request = request();
            request.target = target;
            assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
        }
        let mut scoped = request();
        let mut scope = subc_protocol::scope::ScopeStamp::new(
            Principal::Direct,
            "scope",
            1,
            subc_protocol::scope::ScopeKind::Head,
        );
        scoped.scope = Some(scope.clone());
        assert_eq!(app_admission(&scoped).err().unwrap().code, "not_permitted");
        scope.attributes.flow_id = Some("flow".into());
        scoped.scope = Some(scope);
        assert_eq!(app_admission(&scoped).err().unwrap().code, "not_permitted");
    }

    #[test]
    fn app_read_accepts_omitted_role_versions_on_the_exact_internal_target() {
        let mut request = request();
        request.role_versions = None;
        assert!(app_admission(&request).is_ok());
    }

    #[test]
    fn app_read_refuses_a_supplied_wrong_version() {
        let mut request = request();
        request.role_versions = Some(std::collections::BTreeMap::from([(
            "mc-app-read".into(),
            "v2".into(),
        )]));
        assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
    }

    #[test]
    fn app_read_refuses_any_supplied_additional_role() {
        let mut request = request();
        request.role_versions = Some(std::collections::BTreeMap::from([
            ("mc-app-read".into(), "v1".into()),
            ("tool-provider".into(), "v1".into()),
        ]));
        assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
    }
}

#[cfg(test)]
mod user_commands_tests {
    use super::*;

    fn handler() -> Handler {
        Handler::new(Module::new(
            SubcRunnerClient::new(
                PathBuf::from("unused-user-command-connection"),
                Arc::new(ChildScopes::new("user-commands")),
            ),
            crate::pass::Settings::default(),
            None,
            None,
        ))
    }

    fn route(principal: Principal) -> RouteBindRequest {
        let mut request = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(10, 1),
            RouteTarget::ManagementSurface {
                module_id: crate::MODULE_ID.into(),
            },
            BindIdentity::new("", "command-test"),
        );
        request.principal = Some(principal);
        request
    }

    #[tokio::test]
    async fn user_commands_management_dispatch_admits_occipital_and_keeps_discovery() {
        let handler = handler();
        let request = route(Principal::Reserved {
            module_id: "occipital".into(),
        });
        handler.on_bind(&request).await;
        let result = handler
            .command(10, br#"{"method":"commands.describe","params":{}}"#)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            serde_json::to_value(crate::user_commands::describe()).unwrap()
        );
        assert!(handler
            .command(10, br#"{"method":"transform.declare","params":{}}"#)
            .await
            .is_none());
        assert!(handler
            .dispatch(10, br#"{"method":"role.describe","params":{}}"#)
            .await
            .is_ok());
        assert!(handler.command(10, b"invalid json").await.unwrap().is_err());
    }

    #[tokio::test]
    async fn user_commands_management_dispatch_refuses_other_callers_before_params() {
        let handler = handler();
        for caller in [
            Principal::Direct,
            Principal::Unverified,
            Principal::Reserved {
                module_id: "callosum".into(),
            },
            Principal::Reserved {
                module_id: "other".into(),
            },
        ] {
            handler.on_bind(&route(caller)).await;
            for method in cortexkit_role_user_commands::MODULE_OPS {
                let body = serde_json::to_vec(&json!({"method":method,"params":42})).unwrap();
                let result = handler.command(10, &body).await.unwrap().unwrap_err();
                assert_eq!(result.code, "caller_not_admitted");
            }
        }
        handler.on_bind(&route(Principal::Direct)).await;
        assert!(handler
            .command(10, br#"{"method":"session_data.read","params":{}}"#)
            .await
            .is_none());
    }
}

#[cfg(test)]
mod manifest_tests {
    /// Routing refuses a consumer the calling module's catalog entry doesn't
    /// declare, so the summary consumer must be in the manifest, valid for
    /// a routing that reads declarations, with its defaults on the wire.
    #[test]
    fn the_manifest_declares_the_summary_consumer_to_routing() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let slot = &manifest["role_declarations"]["routing/v1"];
        assert_eq!(
            slot,
            &serde_json::json!({"consumers": [{
                "name": "magic-context.summary",
                "iq": 40,
                "placement": "caller_runner",
                "tools": "none",
                "max_output_tokens": 32000,
                "context_window": 64000,
            }]})
        );
        let parsed: cortexkit_role_routing::declarations::ConsumerDeclarations =
            serde_json::from_value(slot.clone()).unwrap();
        parsed
            .validate_serving(&[cortexkit_role_routing::capabilities::CONSUMER_DECLARATIONS])
            .unwrap();
    }

    /// Core and runners find ck-mc by these claims in the daemon's module
    /// catalog. Each one missing makes core leave ck-mc out of every plan's
    /// matching item, silently.
    #[test]
    fn the_manifest_claims_every_role_ck_mc_serves() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let provides: Vec<&str> = manifest["capabilities"]["provides"]
            .as_array()
            .expect("capabilities.provides")
            .iter()
            .filter_map(|claim| claim.as_str())
            .collect();
        for claim in [
            "compaction-provider/v2",
            "compaction-entry-speaks-for/v1",
            "compaction-host-parts/v1",
            "compaction-signed-floor/v1",
            "compaction-notes-tokens/v1",
            "compaction-statement-seq/v1",
            "tool-provider/v1",
            "step-transform-provider/v2",
        ] {
            assert!(provides.contains(&claim), "{claim} missing: {provides:?}");
        }
        assert!(!provides.contains(&"compaction-limits/v1"));
        assert!(
            !provides
                .iter()
                .any(|claim| claim.ends_with("-provider/v1") && *claim != "tool-provider/v1"),
            "an old contract version is still claimed: {provides:?}"
        );
    }
}
