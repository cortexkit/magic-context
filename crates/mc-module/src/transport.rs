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
            operations: management_app_methods()
                .chain(std::iter::once(crate::app_read::docs::METHOD))
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
    // Callosum relays only management operations, so the reads used by
    // remote apps are also declared here as queries. The caller's allowlist
    // is enforced at dispatch, not by the manifest.
    // Basal's flows read docs proposals over the management surface, so the
    // flow operations are declared there too, as queries. Astrocyte reads
    // the attribution facts there ([`crate::attribution::read`]).
    provides.push(ProviderRole::ManagementSurface {
        operations: management_app_methods()
            .chain(cortexkit_role_user_commands::MODULE_OPS.iter().copied())
            .chain(
                crate::docs_proposals::flow::FLOW_ROUTE_METHODS
                    .iter()
                    .copied(),
            )
            .chain(std::iter::once(crate::attribution::read::METHOD))
            .map(|method| subc_protocol::manifest::ManagementOperation {
                name: method.into(),
                kind: if method == "commands.run" {
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
        // Named readers honor the runner's caps and retry unanswered names.
        // The soft window-budget flag and ride cause are diagnostic only:
        // neither grants rebuild permission nor starts a summary.
        cortexkit_role_compaction::COMPACTION_LIMITS_PROVIDES.to_owned(),
        cortexkit_role_compaction::COMPACTION_RENDER_FAILED_PROVIDES.to_owned(),
        // The runner serves history whose part numbers it can't establish
        // (entries marked `numbers_unknown`, parts without `tag`) only to
        // providers declaring this. ck-mc keeps such entries as the same
        // messages, answers tag numbers the runner refuses with a tool
        // error, and cuts every view through that history once a summary
        // covers it (see `session::numbers_unknown`).
        cortexkit_role_compaction::COMPACTION_NUMBERS_UNKNOWN_PROVIDES.to_owned(),
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
        // A flow's route is stamped with its flow, and admitted only to the
        // flow operations (`crate::docs_proposals::flow`): ck-mc never
        // treats a call from a flow as a call from the agent that owns it.
        subc_protocol::scope::FLOW_SCOPES_CAPABILITY.to_owned(),
    ];
    if agent_data {
        claims.push(cortexkit_role_agent_data::PROVIDES.to_owned());
    }
    let routing = serde_json::to_value(crate::routing::consumer_declarations())
        .expect("routing declarations are JSON");
    let serde_json::Value::Object(routing) = routing else {
        unreachable!("routing declarations serialize as an object")
    };
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        // ck-mc serves through the SDK, which registers over the private
        // channel a daemon hands it at spawn and binds its outbound
        // connections with claims minted on that registration.
        .registration_channel(true)
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
        // The events ck-mc publishes on the bus, with the headers a notice
        // carries ([`crate::bus`], [`crate::memory_changed`],
        // [`crate::attribution`]).
        .events(Some(vec![
            crate::docs_proposals::event_declaration(),
            crate::memory_changed::event_declaration(),
            crate::attribution::event_declaration(),
        ]))
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
    /// The one connection to the daemon, shared with the vault reader
    /// ([`SubcRunnerClient::shared_consumer`]).
    consumer: SharedConsumer,
    /// The scopes ck-mc's summarizer children run under.
    child_scopes: Arc<ChildScopes>,
    runner_capabilities: crate::runner_capabilities::RunnerCapabilities,
    routing_capabilities: crate::routing::Capabilities,
    /// The waits on summary and dreamer child runs, which the bus's run-end
    /// reader wakes ([`crate::bus::spawn_run_end_reader`]).
    run_ends: Arc<crate::run_ends::RunEnds>,
    /// The id prefrontal's management surface last answered under.
    prefrontal: crate::prefrontal::ManagementIds,
}

/// ck-mc's connection to the daemon as a consumer, made on first use and
/// then kept. Cloning shares the one connection.
#[derive(Clone)]
pub struct SharedConsumer {
    connection_file: PathBuf,
    cell: Arc<OnceCell<Arc<SubcConsumer>>>,
}

impl SharedConsumer {
    /// The connection, made now if no caller has made it yet. Under a daemon
    /// that hands ck-mc a registration channel, call this only after ck-mc
    /// has registered (`serve_with_handle`): the connection is bound with a
    /// claim minted on that registration.
    pub async fn get(&self) -> Result<&Arc<SubcConsumer>, String> {
        self.cell
            .get_or_try_init(|| async {
                SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
                    .await
                    .map(Arc::new)
            })
            .await
            .map_err(|error| format!("connect: {error:?}"))
    }
}

impl SubcRunnerClient {
    pub fn new(connection_file: PathBuf, child_scopes: Arc<ChildScopes>) -> Self {
        Self {
            consumer: SharedConsumer {
                connection_file,
                cell: Arc::new(OnceCell::new()),
            },
            child_scopes,
            runner_capabilities: Default::default(),
            routing_capabilities: Default::default(),
            run_ends: Arc::default(),
            prefrontal: Default::default(),
        }
    }

    /// The waits on this client's child runs, for the reader that wakes
    /// them.
    pub fn run_end_waits(&self) -> Arc<crate::run_ends::RunEnds> {
        Arc::clone(&self.run_ends)
    }

    /// This client's connection to the daemon, for another part of ck-mc to
    /// call over (the vault reader). It is the same connection: made once,
    /// by whichever side needs it first.
    pub fn shared_consumer(&self) -> SharedConsumer {
        self.consumer.clone()
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
    /// the session's own calls, or one opened under `scope`. The route goes to
    /// the module's tool-provider surface for the tool-provider role and to
    /// its management surface for every other role.
    async fn call_raw<P: Serialize>(
        &self,
        session: &SessionRef,
        role: (&str, &str),
        method: &str,
        params: &P,
        scope: Option<ScopeSelector>,
    ) -> Result<Vec<u8>, ClientError> {
        let consumer = self.consumer().await.map_err(ClientError::new)?;
        let target = route_target(role.0, &session.runner);
        let options = CallOptions {
            timeout: RUNNER_CALL_TIMEOUT,
            role_versions: Some(std::collections::BTreeMap::from([(
                role.0.to_owned(),
                role.1.to_owned(),
            )])),
            ..CallOptions::default()
        };
        let identity = BindIdentity::new(session.harness.clone(), session.session.clone());
        let body = request_body(role.0, method, params);
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

/// The host family a tool provider's bind identity names for a session a
/// runner hosts.
const RUNNER_HOST_FAMILY: &str = "runner";

/// A request's body as `role` frames it. A tool provider reads every
/// request, `tool.catalog` and `role.describe` included, as a tool call
/// `{name, arguments}`; AFT, the fleet's code-tools provider, answers the
/// `{method, params}` frame of the
/// other roles with `invalid_request` ("missing field `name`").
fn request_body<P: Serialize>(role: &str, method: &str, params: &P) -> Vec<u8> {
    if role == cortexkit_role_tool_provider::ROLE {
        serde_json::to_vec(&json!({"name": method, "arguments": params}))
            .expect("tool-call requests serialize")
    } else {
        wire::encode(method, params)
    }
}

/// The surface of `module_id` that serves `role`. A tool provider serves
/// `tool.catalog` on its tool-provider route; its management surface is for
/// its own first-party callers, and AFT refuses ck-mc there
/// (`route_refused`). Every other role ck-mc calls is served on the module's
/// management surface.
fn route_target(role: &str, module_id: &str) -> RouteTarget {
    if role == cortexkit_role_tool_provider::ROLE {
        RouteTarget::ToolProvider {
            module_id: module_id.to_owned(),
        }
    } else {
        RouteTarget::ManagementSurface {
            module_id: module_id.to_owned(),
        }
    }
}

impl SubcRunnerClient {
    /// The connection to the daemon, made on first use.
    async fn consumer(&self) -> Result<&SubcConsumer, String> {
        self.consumer.get().await.map(|consumer| &**consumer)
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

    fn run_ends(&self) -> Option<&crate::run_ends::RunEnds> {
        Some(&self.run_ends)
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

    async fn clock_note_delivery(
        &self,
        session: &SessionRef,
    ) -> Option<Vec<cortexkit_role_llm_runner::delivery_order::Mode>> {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .clock_note_delivery(
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

    async fn child_plans(&self, child: &Child) -> bool {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .plans(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await
    }

    async fn child_session_retention(
        &self,
        child: &Child,
    ) -> Option<crate::runner_capabilities::SessionRetention> {
        let epoch = match self.consumer().await {
            Ok(consumer) => consumer.current_epoch(),
            Err(_) => 0,
        };
        self.runner_capabilities
            .session_retention(
                &child.session.runner,
                epoch,
                self.child_call(child, "role.describe", &json!({})),
            )
            .await
    }

    async fn tool_providers(&self) -> Result<Vec<String>, ClientError> {
        self.ready_participants(cortexkit_role_tool_provider::PROVIDES)
            .await
            .map_err(ClientError::new)
    }

    async fn tool_catalog(
        &self,
        child: &Child,
        provider: &str,
        preset: Option<&str>,
    ) -> Result<cortexkit_role_tool_provider::catalog::CatalogAnswer, ClientError> {
        let root = child.project_root.as_deref().ok_or_else(|| {
            ClientError::new("tool.catalog: the run has no project folder to read in")
        })?;
        let scope = self
            .child_scopes
            .for_project(root)
            .await
            .map_err(|error| ClientError::new(format!("tool.catalog: child scope: {error}")))?;
        // The same provider, preset, params and scope the runner fetches the
        // plan's tool item with, for the child's session. A tool provider
        // binds a route by host family, not by the runner's or ck-mc's module
        // id, and a session a runner hosts binds as `runner` (AFT, the
        // fleet's code-tools provider, refuses an unknown family with
        // `config_divergence`). Unscoped, AFT has no project folder for the
        // route and refuses the catalog (`project_required`). A request
        // without a preset carries none, as the role requires.
        let provider = SessionRef::new(
            provider.to_owned(),
            RUNNER_HOST_FAMILY.to_owned(),
            child.session.session.clone(),
        );
        let mut request = json!({"params": {}});
        if let Some(preset) = preset {
            request["preset"] = json!(preset);
        }
        let reply = self
            .call_raw(
                &provider,
                (
                    cortexkit_role_tool_provider::ROLE,
                    cortexkit_role_tool_provider::VERSION,
                ),
                cortexkit_role_tool_provider::ops::TOOL_CATALOG,
                &request,
                Some(scope),
            )
            .await?;
        // A tool provider's answer is the bare object, never wrapped.
        serde_json::from_slice(&reply)
            .map_err(|error| ClientError::new(format!("tool.catalog answer: {error}")))
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
    /// `magic-context` harness and the session the search is for. `module`
    /// is the local `synapse` or a remote one Callosum re-exports
    /// (`fed:<fingerprint>:synapse`); only that module is called.
    async fn synapse_call(
        &self,
        session: &SessionRef,
        module: &str,
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
                    module_id: module.to_owned(),
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

    /// On the management surface of core (prefrontal), under whichever of
    /// its two module ids this daemon has installed ([`crate::prefrontal`]):
    /// the id that answered last, and the other only when the daemon refuses
    /// that one as not installed. The SDK refuses a route to an absent module
    /// at once rather than retrying it, so trying the other id costs one
    /// round trip, not a retry deadline. Both attempts share `deadline`.
    /// Core admits the call by the route's attested caller, this module's
    /// own principal (`reserved:magic-context`), so the bind identity grants
    /// nothing and only says what the call is for.
    async fn core_call(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, crate::client::CoreRefusal> {
        use crate::client::CoreRefusal;
        let consumer = self.consumer().await.map_err(CoreRefusal::unavailable)?;
        let started = Instant::now();
        let params = &params;
        self.prefrontal
            .call(|module_id| async move {
                let reply = consumer
                    .call(
                        RouteTarget::ManagementSurface {
                            module_id: module_id.to_owned(),
                        },
                        BindIdentity::new("magic-context", "dreamer"),
                        wire::encode(method, params),
                        CallOptions {
                            timeout: deadline.saturating_sub(started.elapsed()),
                            ..CallOptions::default()
                        },
                    )
                    .await;
                core_attempt(method, reply)
            })
            .await
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

/// How one call to core's management surface under one module id ended
/// ([`crate::prefrontal::Attempt`]). Only the daemon's refusal to open the
/// route, because no module of that id is installed, lets the caller try
/// core's other id; a refusal core itself sends keeps its code, whatever
/// that code is.
fn core_attempt(
    method: &str,
    reply: Result<Vec<u8>, subc_client_rs::CallError>,
) -> crate::prefrontal::Attempt {
    use crate::client::CoreRefusal;
    use crate::prefrontal::Attempt;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error)
            if matches!(
                error
                    .route_open_refusal()
                    .map(|refusal| refusal.code.as_str()),
                Some("unknown_module")
            ) =>
        {
            return Attempt::NotInstalled
        }
        Err(subc_client_rs::CallError::Module(body)) => {
            return Attempt::Settled(Err(CoreRefusal {
                code: body.code,
                message: body.message,
                detail: body.detail,
            }))
        }
        Err(other) => {
            return Attempt::Settled(Err(CoreRefusal::unavailable(format!(
                "{method}: {other:?}"
            ))))
        }
    };
    Attempt::Settled(
        serde_json::from_slice(&reply).map_err(|error| {
            CoreRefusal::unavailable(format!("{method} answer is not JSON: {error}"))
        }),
    )
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

#[cfg(test)]
mod core_attempt_tests {
    use super::core_attempt;
    use crate::prefrontal::Attempt;
    use subc_client_rs::CallError;
    use subc_protocol::ErrorBody;

    /// A refusal core sends itself is core's answer, even one coded
    /// `unknown_module`: only the daemon's refusal to open the route sends
    /// the call on to core's other id.
    #[test]
    fn only_a_refused_route_lets_the_call_try_cores_other_id() {
        let own = ErrorBody::new("unknown_module", "core's own refusal");
        match core_attempt("persona.workspace_document", Err(CallError::Module(own))) {
            Attempt::Settled(Err(refusal)) => {
                assert_eq!(refusal.code, "unknown_module");
                assert_eq!(refusal.message, "core's own refusal");
            }
            other => panic!("{other:?}"),
        }
        let lost = CallError::OutcomeUnknown("no answer in time".into());
        match core_attempt("persona.workspace_document", Err(lost)) {
            Attempt::Settled(Err(refusal)) => assert_eq!(refusal.code, "unavailable"),
            other => panic!("{other:?}"),
        }
        let answer = br#"{"state":"no_root","workspace_id":"ws-a"}"#.to_vec();
        match core_attempt("persona.workspace_document", Ok(answer)) {
            Attempt::Settled(Ok(value)) => assert_eq!(value["workspace_id"], "ws-a"),
            other => panic!("{other:?}"),
        }
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
    /// Every route the daemon bound under a flow's scope, by channel, with
    /// its stamp. Such a route reaches only the flow operations
    /// ([`crate::docs_proposals::flow`]), whatever surface it targets.
    flow_bound: Mutex<HashMap<u16, FlowRoute>>,
    answer_routes: Mutex<HashMap<u16, AnswerRoute>>,
}

/// What the daemon stamped on a flow-scoped route at bind.
#[derive(Clone, Debug)]
struct FlowRoute {
    principal: Option<Principal>,
    scope: Option<subc_protocol::scope::ScopeStamp>,
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
/// so this is the wait the runner saw, not the session's later work. `slots`
/// are the connection's handler slots as the answer leaves
/// ([`handler_slots`]).
fn log_slow_answer(elapsed: Duration, body: &[u8], route: Option<&AnswerRoute>, slots: &str) {
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
        tracing::warn!(op, elapsed_ms, session, caller, slots, "ck-mc slow answer");
    } else {
        tracing::info!(op, elapsed_ms, session, caller, slots, "ck-mc slow answer");
    }
}

/// The connection's handler slots, for the slow-answer line: for each pool,
/// the slots in use out of its limit, the requests waiting for one, and how
/// long the oldest of them has waited. A request waits for a slot before
/// ck-mc's handler starts, so no other ck-mc line counts that wait; the
/// client library itself warns once one has waited two seconds.
fn handler_slots(pools: &[subc_client_rs::RequestPoolSnapshot]) -> String {
    pools
        .iter()
        .map(|pool| {
            format!(
                "{}:{}/{} waiting={} oldest_wait_ms={}",
                pool.pool.name(),
                pool.in_use,
                pool.limit,
                pool.waiting,
                pool.oldest_wait.map_or(0, |wait| wait.as_millis())
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug)]
struct AppCaller {
    principal: Principal,
    harness: String,
    /// Whether the route is ck-mc's management surface. Only a Direct caller
    /// on the internal service reaches every app read; every other caller
    /// gets the list for its kind, whichever surface it bound.
    management: bool,
}

impl AppCaller {
    fn allowed(&self) -> bool {
        if matches!(self.principal, Principal::Direct) {
            crate::app_read::DEVELOPMENT_ADMITS_DIRECT
        } else {
            self.relayed_as("fed-phone:") || self.relayed_as("fed-app:")
        }
    }

    fn relayed_as(&self, prefix: &str) -> bool {
        matches!(&self.principal, Principal::Reserved { module_id } if module_id == "callosum")
            && self.harness.starts_with(prefix)
    }

    fn allows_method(&self, method: &str) -> bool {
        // Called after admission. Naming the internal service does not widen
        // the reads available to a Callosum caller.
        if matches!(self.principal, Principal::Direct) && !self.management {
            true
        } else if self.relayed_as("fed-app:") {
            management_app_methods().any(|candidate| candidate == method)
        } else {
            PHONE_APP_METHODS.contains(&method)
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

const PHONE_APP_METHODS: &[&str] = &[
    "session_data.read",
    "context.cache_why",
    "context.search",
    "context.watch",
];

const DESKTOP_ONLY_RELAYED_APP_METHODS: &[&str] = &[
    "context.states",
    "context.head",
    "context.head_section",
    "context.compartment",
    "memories.stats",
    "memories.page",
    "memories.get",
    "observations.page",
    "facts.page",
    "dreamer.status",
    "dreamer.runs",
    "dreamer.run",
    "sessions.page",
    "notes.page",
];

fn management_app_methods() -> impl Iterator<Item = &'static str> {
    PHONE_APP_METHODS
        .iter()
        .chain(DESKTOP_ONLY_RELAYED_APP_METHODS)
        .copied()
}

enum AppAnswer {
    Read(Vec<u8>),
    Watch(crate::app_read::Subscription),
}

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

/// An agent-data reply as it goes on the wire: the body inside
/// `{"result": …}`, the envelope every module reply uses and Entorhinal's
/// participant client decodes. The reply is already one JSON object, so it
/// is wrapped without parsing it again. A refusal is an ERROR frame instead.
fn agent_data_result(reply: Vec<u8>) -> Vec<u8> {
    let mut wire = Vec::with_capacity(reply.len() + 11);
    wire.extend_from_slice(b"{\"result\":");
    wire.extend_from_slice(&reply);
    wire.push(b'}');
    wire
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
            flow_bound: Mutex::default(),
            answer_routes: Mutex::default(),
        }
    }

    /// A request on a flow-scoped route: the flow operation's answer, or the
    /// refusal of anything else. `None` for a route bound under no flow.
    async fn flow_request(&self, channel: u16, body: &[u8]) -> Option<HandlerOutcome> {
        use crate::docs_proposals::flow;
        let route = self
            .flow_bound
            .lock()
            .expect("flow routes")
            .get(&channel)
            .cloned()?;
        let error = |error: subc_protocol::ErrorBody| match error.detail {
            Some(detail) => HandlerOutcome::ErrorWithDetail {
                code: error.code,
                message: error.message,
                detail,
            },
            None => HandlerOutcome::Error {
                code: error.code,
                message: error.message,
            },
        };
        if let Some(refusal) = flow::flow_route_refusal(body) {
            return Some(error(refusal));
        }
        let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or_default();
        // The caller is judged from the daemon's bind stamp, before any
        // argument is read.
        if let Err(message) =
            flow::authorize_caller(method, route.principal.as_ref(), route.scope.as_ref())
        {
            return Some(HandlerOutcome::Error {
                code: "caller_forbidden".into(),
                message,
            });
        }
        Some(match flow::handle(self.module.store_db(), &request) {
            Ok(reply) => HandlerOutcome::Response(
                serde_json::to_vec(&reply).expect("flow replies serialize"),
            ),
            Err(refusal) => error(refusal),
        })
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
        let mut subscription = match self.app_dispatch(body, &caller).await? {
            AppAnswer::Read(bytes) => return Ok(HandlerOutcome::Response(bytes)),
            AppAnswer::Watch(subscription) => subscription,
        };
        loop {
            let notice = tokio::select! {
                _ = ctx.cancelled() => return Ok(HandlerOutcome::Streamed),
                value = subscription.recv() => match value? { Some(value) => value, None => return Ok(HandlerOutcome::Streamed) },
            };
            let bytes = crate::app_read::reply_bytes("context.watch", notice)?;
            tokio::select! {
                _ = ctx.cancelled() => return Ok(HandlerOutcome::Streamed),
                result = ctx.emit(bytes) => if result.is_err() { return Ok(HandlerOutcome::Streamed); },
            }
        }
    }

    async fn app_dispatch(&self, body: &[u8], caller: &AppCaller) -> Result<AppAnswer, Refusal> {
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
        if !caller.allows_method(method) {
            let message = if caller.management {
                format!("{method} isn't served on ck-mc's management surface.")
            } else {
                format!("{method} isn't served for this app caller.")
            };
            return Err(Refusal::new("unknown_method", message, None));
        }
        let params = envelope.get("params").cloned().unwrap_or(Value::Null);
        if method == "context.watch" {
            let subscription = self.module.app_watch(caller.quota(), params).await?;
            return Ok(AppAnswer::Watch(subscription));
        }
        let value = self.module.app_request(method, params).await?;
        let bytes = crate::app_read::reply_bytes(method, value)?;
        Ok(AppAnswer::Read(bytes))
    }

    /// An op on a route ck-mc bound, received at `Instant::now()`.
    #[cfg(test)]
    async fn dispatch(&self, channel: u16, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        self.dispatch_at(channel, body, Instant::now()).await
    }

    /// An op on a route ck-mc bound, received at `arrived`: a tool call's
    /// steps are timed from then ([`crate::tool_timing`]).
    async fn dispatch_at(
        &self,
        channel: u16,
        body: &[u8],
        arrived: Instant,
    ) -> Result<Vec<u8>, Refusal> {
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
                return self
                    .tool_at(&bound.route, body, arrived)
                    .await
                    .map_err(|mut refusal| {
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

    /// [`Handler::tool_at`] for a call received at `Instant::now()`.
    #[cfg(test)]
    async fn tool(&self, route: &Route, body: &[u8]) -> Result<Vec<u8>, Refusal> {
        self.tool_at(route, body, Instant::now()).await
    }

    /// An op on a `tool-provider/v1` route: a role op by name, or a model's
    /// call to one of the `ctx_*` tools about the session the route is bound
    /// to, answered with its tool result. `arrived` is when the transport
    /// received the call.
    async fn tool_at(
        &self,
        route: &Route,
        body: &[u8],
        arrived: Instant,
    ) -> Result<Vec<u8>, Refusal> {
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
        // A quick question a runner forks off the head carries the role's
        // `fork_id`. Only a tool the catalog marks read-only runs on a fork,
        // and it then changes nothing the person, the head or another session
        // can observe; a malformed marker, or a marker on any other tool, is
        // refused before anything runs. No ck-mc tool ever asks the person,
        // so no fork call is refused for needing approval.
        let fork = fork_call(body, &call.name)?;
        let (text, is_error) = match self
            .module
            .tool_at(route, &call.name, call.arguments, fork, arrived)
            .await
        {
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
                        // The runner's clock when it sends one, so a
                        // commit's age in the hint counts to when the
                        // message was written; ck-mc's own otherwise.
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

/// What ck-mc subscribes to for a preset: `pre_user` with `append` for
/// presets that get memory hints, with ck-mc's budget, passing on any failure
/// so a message is never held up. Nothing for the rest. `None` for a preset
/// ck-mc does not know.
///
/// A running session's frozen plan may still name the wider subscription of
/// earlier builds (`prepend` as well, and a `prepend`-only one for workers).
/// The runner refuses to refresh such a plan as `plan_stale`, and prefrontal
/// then composes a new plan from this declaration instead of resending the
/// old one.
fn declare(preset: &str) -> Option<Declaration> {
    let features = crate::preset::features(preset)?;
    let budget = u64::try_from(PRE_USER_BUDGET.as_millis()).unwrap_or(u64::MAX);
    let subscriptions = if features.auto_memory {
        vec![
            DeclaredSubscription::new(Hook::PreUser, vec![Op::Append], budget)
                .with_on_unavailable(OnUnavailable::Pass),
        ]
    } else {
        Vec::new()
    };
    Some(Declaration::new(subscriptions))
}

/// The hook answer for an addition: the hint after the last block.
fn hook_answer(addition: Addition, blocks: usize) -> HookAnswer {
    let last = u32::try_from(blocks.saturating_sub(1)).unwrap_or(u32::MAX);
    match addition.append {
        Some(text) => HookAnswer::Ops {
            ops: vec![Operation::Append {
                block: last,
                text,
                note: None,
            }],
        },
        None => HookAnswer::Pass,
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

/// Whether a call to `tool` carries a well-formed `fork_id`, refusing a
/// malformed one and a marked call to a tool the catalog does not mark
/// read-only.
fn fork_call(body: &[u8], tool: &str) -> Result<bool, Refusal> {
    use cortexkit_role_tool_provider::call;
    let body: Value = serde_json::from_slice(body)
        .map_err(|error| Refusal::invalid_params("", format!("not a tool call: {error}")))?;
    let refused =
        |error: subc_protocol::ErrorBody| Refusal::new(&error.code, error.message, error.detail);
    let read_only = crate::catalog::definition()
        .tool(tool)
        .is_some_and(|definition| definition.read_only);
    call::check_fork_call(&body, tool, read_only, false).map_err(refused)?;
    Ok(call::fork_id(&body).map_err(refused)?.is_some())
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
        self.flow_bound
            .lock()
            .expect("flow routes")
            .remove(&request.handle.channel);
        // First: a route bound under a flow's scope reaches the flow
        // operations and nothing else, on any surface, so it is never judged
        // as a runner's, an app's or a command caller's route.
        if crate::docs_proposals::flow::flow_scoped(request.scope.as_ref()) {
            self.flow_bound.lock().expect("flow routes").insert(
                request.handle.channel,
                FlowRoute {
                    principal: request.principal.clone(),
                    scope: request.scope.clone(),
                },
            );
            return BindDecision::accept();
        }
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
                // not admitted as an app gets discovery only: `role.describe` and
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
        let outcome = if let Some(answer) = self.flow_request(channel, &body).await {
            answer
        } else if let Some(answer) = self.attribution_read(channel, &body) {
            answer
        } else if let Some(answer) = self.command(channel, &body).await {
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
            self.handle_non_command(&ctx, &body, started).await
        };
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_millis(500) && !matches!(outcome, HandlerOutcome::Streamed) {
            let routes = self.answer_routes.lock().expect("answer routes");
            let slots = handler_slots(&ctx.module_handle().request_pool_snapshots());
            log_slow_answer(elapsed, &body, routes.get(&channel), &slots);
        }
        outcome
    }
}

impl Handler {
    /// `attribution.read` on a route to ck-mc's management surface: the page
    /// for `reserved:astrocyte`, `caller_not_admitted` for every other caller
    /// before the params are read ([`crate::attribution::read`]). `None` for
    /// another method, or a route to anything but the management surface.
    fn attribution_read(&self, channel: u16, body: &[u8]) -> Option<HandlerOutcome> {
        use crate::attribution::read;
        if !read::requested(body) {
            return None;
        }
        // Every route to the management surface records its caller at bind.
        let principal = self
            .command_bound
            .lock()
            .expect("command routes")
            .get(&channel)
            .cloned()?;
        let answer =
            read::admit(&principal).and_then(|()| read::handle(self.module.store_db(), body));
        Some(match answer {
            Ok(reply) => HandlerOutcome::Response(
                serde_json::to_vec(&reply).expect("attribution pages serialize"),
            ),
            Err(error) => match error.detail {
                Some(detail) => HandlerOutcome::ErrorWithDetail {
                    code: error.code,
                    message: error.message,
                    detail,
                },
                None => HandlerOutcome::Error {
                    code: error.code,
                    message: error.message,
                },
            },
        })
    }

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

    async fn handle_non_command(
        &self,
        ctx: &RequestCtx,
        body: &[u8],
        arrived: Instant,
    ) -> HandlerOutcome {
        // Before any other route: a move's request never reaches a session,
        // app or context handler.
        if let Some(answer) = self.agent_data(ctx.route_handle().channel, body).await {
            return match answer {
                Ok(reply) => HandlerOutcome::Response(agent_data_result(reply)),
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
            self.app(ctx, body, caller).await
        } else {
            self.dispatch_at(ctx.route_handle().channel, body, arrived)
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
        // A request may have reached the runner when the client wrote it and
        // saw no answer (`OutcomeUnknown`), and also when a `NotSent` can't
        // prove it stayed unsent (`never_forwarded() == Some(false)`: the
        // reply channel closed after the writer took the request, or a resend
        // followed a refusal an older daemon did not mark as unsent). Both
        // count as "may have arrived" because guessing wrong costs far less
        // that way: a view the runner never received is offered again on the
        // next notice, which the runner settles, while rolling back a view
        // the runner holds queues its drops again, shows it undelivered in
        // the apps and loses its acceptance line.
        outcome_unknown: may_have_arrived(
            matches!(error, subc_client_rs::CallError::OutcomeUnknown(_)),
            error.never_forwarded(),
        ),
    }
}

/// Whether a failed call may have reached the runner, from what the client
/// reports about it: no answer to a written request (`outcome_unknown`), or
/// [`subc_client_rs::CallError::never_forwarded`] (see [`call_error`]).
fn may_have_arrived(outcome_unknown: bool, never_forwarded: Option<bool>) -> bool {
    outcome_unknown || never_forwarded == Some(false)
}

#[cfg(test)]
#[path = "transport_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "transport_slow_answer_tests.rs"]
mod slow_answer_tests;

#[cfg(test)]
#[path = "transport_tool_steps_tests.rs"]
mod tool_steps_tests;

#[cfg(test)]
#[path = "transport_outcome_tests.rs"]
mod outcome_tests;

#[cfg(test)]
#[path = "transport_declare_tests.rs"]
mod declare_tests;

#[cfg(test)]
#[path = "tool_conformance_tests.rs"]
mod tool_conformance_tests;

#[cfg(test)]
#[path = "agent_data/transport_tests.rs"]
mod agent_data_transport_tests;

#[cfg(test)]
mod config_tests {
    use super::*;
    /// A tool catalog is read on the provider's tool-provider route, which
    /// any principal may open; runner calls stay on the management surface.
    #[test]
    fn a_tool_catalog_goes_to_the_tool_provider_route() {
        assert_eq!(
            route_target(cortexkit_role_tool_provider::ROLE, "aft"),
            RouteTarget::ToolProvider {
                module_id: "aft".into()
            }
        );
        assert_eq!(
            route_target(LLM_RUNNER_ROLE.0, "broca"),
            RouteTarget::ManagementSurface {
                module_id: "broca".into()
            }
        );
    }

    #[test]
    fn a_tool_provider_request_is_a_tool_call() {
        let params = json!({"params": {}, "preset": "reader"});
        let body: serde_json::Value = serde_json::from_slice(&request_body(
            cortexkit_role_tool_provider::ROLE,
            cortexkit_role_tool_provider::ops::TOOL_CATALOG,
            &params,
        ))
        .unwrap();
        assert_eq!(
            body,
            json!({"name": "tool.catalog", "arguments": {"params": {}, "preset": "reader"}})
        );
        let body: serde_json::Value =
            serde_json::from_slice(&request_body(LLM_RUNNER_ROLE.0, "session.read", &params))
                .unwrap();
        assert_eq!(body["method"], "session.read");
        assert_eq!(body["params"], params);
    }

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

    /// A forked quick question may call only the tools the catalog marks
    /// read-only: a fork call to any other tool is refused by name before it
    /// runs, and so is a malformed marker.
    #[tokio::test]
    async fn a_fork_call_runs_only_a_read_only_tool() {
        let handler = Handler::new(Module::new(
            SubcRunnerClient::new(
                std::env::temp_dir().join("ck-mc-fork-unused"),
                Arc::new(ChildScopes::new("test-fork")),
            ),
            crate::config::Config::from(crate::pass::Settings::default()),
            None,
            None,
        ));
        let route = Route {
            session: SessionRef::new("runner", "test", "fork"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let call = |name: &str, arguments: Value, fork_id: Value| {
            serde_json::to_vec(&json!({
                "name": name,
                "arguments": arguments,
                "fork_id": fork_id,
            }))
            .unwrap()
        };
        for (name, arguments) in [
            ("ctx_note", json!({"action": "read"})),
            ("ctx_memory", json!({"action": "list"})),
            ("ctx_reduce", json!({"drop": "1"})),
            ("ctx_keep", json!({"tags": "1", "note": "n"})),
        ] {
            let refused = handler
                .tool(&route, &call(name, arguments, json!("fork-1")))
                .await
                .err()
                .unwrap();
            assert_eq!(refused.code, "fork_call_refused", "{name}");
            assert_eq!(
                refused.detail,
                Some(json!({"tool": name, "reason": "not_read_only"})),
                "{name}"
            );
        }
        for malformed in [json!("not valid"), json!(null), json!(7)] {
            let refused = handler
                .tool(
                    &route,
                    &call("ctx_search", json!({"query": "q"}), malformed.clone()),
                )
                .await
                .err()
                .unwrap();
            assert_eq!(refused.code, "invalid_request", "{malformed}");
            assert_eq!(refused.detail.unwrap()["field"], "fork_id", "{malformed}");
        }
        // A marked tool runs: with no context store, ctx_search answers its
        // own tool error rather than a refusal.
        let answer = handler
            .tool(
                &route,
                &call("ctx_search", json!({"query": "q"}), json!("fork-1")),
            )
            .await
            .unwrap();
        let result: Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(result["isError"], json!(true), "{result}");
        assert!(result
            .to_string()
            .contains("ctx_search needs the context store"));
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
#[path = "transport_app_relay_tests.rs"]
mod app_relay_tests;

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
    fn app_read_admits_development_direct_and_attested_apps_only() {
        let mut request = request();
        let direct = app_admission(&request).unwrap();
        assert!(direct.allowed());
        assert_eq!(direct.quota(), "direct");
        request.principal = Some(Principal::Reserved {
            module_id: "callosum".into(),
        });
        for harness in ["other", "", "fed-worker:device-a", "fed-app"] {
            request.identity = BindIdentity::new(harness, "app");
            assert_eq!(app_admission(&request).err().unwrap().code, "not_permitted");
        }
        for harness in ["fed-phone:device-a", "fed-app:device-a"] {
            request.principal = Some(Principal::Reserved {
                module_id: "callosum".into(),
            });
            request.identity = BindIdentity::new(harness, "app");
            let caller = app_admission(&request).unwrap();
            assert!(caller.allowed());
            assert_eq!(caller.quota(), harness);
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
    }

    /// The phone's reads come through Callosum, which relays only management
    /// operations: ck-mc's own unscoped management surface is an app route.
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
    fn the_manifest_declares_relayed_app_reads_as_management_queries() {
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
                // Astrocyte's read of the attribution facts.
                ("attribution.read".into(), "query".into()),
                ("commands.describe".into(), "query".into()),
                ("commands.preview".into(), "query".into()),
                ("commands.run".into(), "mutate".into()),
                ("context.cache_why".into(), "query".into()),
                ("context.compartment".into(), "query".into()),
                ("context.head".into(), "query".into()),
                ("context.head_section".into(), "query".into()),
                ("context.search".into(), "query".into()),
                ("context.states".into(), "query".into()),
                ("context.watch".into(), "query".into()),
                // The two reads a Basal flow may call (docs proposals).
                ("docs_proposals.state".into(), "query".into()),
                ("dreamer.run".into(), "query".into()),
                ("dreamer.runs".into(), "query".into()),
                ("dreamer.status".into(), "query".into()),
                ("events_get".into(), "query".into()),
                ("facts.page".into(), "query".into()),
                ("memories.get".into(), "query".into()),
                ("memories.page".into(), "query".into()),
                ("memories.stats".into(), "query".into()),
                ("notes.page".into(), "query".into()),
                ("observations.page".into(), "query".into()),
                ("session_data.read".into(), "query".into()),
                ("sessions.page".into(), "query".into()),
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
mod attribution_read_tests {
    use super::*;

    fn handler(db: Option<crate::context_db::ContextDb>) -> Handler {
        Handler::new(Module::new(
            SubcRunnerClient::new(
                PathBuf::from("unused-attribution-connection"),
                Arc::new(ChildScopes::new("attribution")),
            ),
            crate::pass::Settings::default(),
            db,
            None,
        ))
    }

    async fn bind(handler: &Handler, channel: u16, target: RouteTarget, principal: Principal) {
        let mut request = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(channel, 1),
            target,
            BindIdentity::new("", "attribution-test"),
        );
        request.principal = Some(principal);
        handler.on_bind(&request).await;
    }

    fn management() -> RouteTarget {
        RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        }
    }

    const READ: &[u8] = br#"{"method":"attribution.read","params":{"limit":1}}"#;

    /// Astrocyte's route to the management surface reads the facts; every
    /// other caller there is refused as an unadmitted user command is,
    /// before its params are read.
    #[tokio::test]
    async fn only_astrocyte_reads_attribution_facts_on_the_management_surface() {
        let dir = tempfile::tempdir().unwrap();
        let db =
            crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let head = SessionRef::new("broca", "pi", "head");
        let purpose = crate::attribution::Purpose::summary(&head, None, None);
        for name in ["head:mc-summary:a", "head:mc-summary:b"] {
            crate::attribution::tests::put(&db, &SessionRef::new("broca", "pi", name), &purpose, 1);
        }
        let handler = handler(Some(db));
        bind(
            &handler,
            10,
            management(),
            Principal::Reserved {
                module_id: "astrocyte".into(),
            },
        )
        .await;
        let Some(HandlerOutcome::Response(bytes)) = handler.attribution_read(10, READ) else {
            panic!("astrocyte gets a page");
        };
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["result"]["facts"].as_array().unwrap().len(), 1);
        assert_eq!(page["result"]["next"], "1");
        assert_eq!(page["result"]["through"], "2");
        assert!(handler
            .attribution_read(10, br#"{"method":"role.describe","params":{}}"#)
            .is_none());

        for (channel, caller) in [
            Principal::Direct,
            Principal::Unverified,
            Principal::Reserved {
                module_id: "occipital".into(),
            },
            Principal::Reserved {
                module_id: "callosum".into(),
            },
            Principal::Reserved {
                module_id: "other".into(),
            },
        ]
        .into_iter()
        .enumerate()
        {
            let channel = 20 + channel as u16;
            bind(&handler, channel, management(), caller.clone()).await;
            // Bad params too: the caller is judged before they are read.
            let body = br#"{"method":"attribution.read","params":{"limit":"x"}}"#;
            match handler.attribution_read(channel, body) {
                Some(HandlerOutcome::Error { code, message }) => {
                    assert_eq!(code, "caller_not_admitted", "{caller:?}");
                    assert_eq!(message, "caller not admitted");
                }
                _ => panic!("{caller:?} is refused"),
            }
        }

        // A runner's route isn't the management surface: the read isn't
        // served there at all.
        bind(
            &handler,
            40,
            RouteTarget::ToolProvider {
                module_id: crate::MODULE_ID.into(),
            },
            Principal::Reserved {
                module_id: "astrocyte".into(),
            },
        )
        .await;
        assert!(handler.attribution_read(40, READ).is_none());
    }

    #[test]
    fn the_manifest_declares_the_read_as_a_management_query() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let surface = manifest["provides"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["role"] == "management_surface")
            .unwrap();
        let declared = surface["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == "attribution.read")
            .expect("attribution.read is declared");
        assert_eq!(declared["kind"], "query");
    }
}

#[cfg(test)]
mod manifest_tests {
    /// Routing refuses a consumer the calling module's catalog entry doesn't
    /// declare, so the summary consumer and each dreamer task's consumer
    /// must be in the manifest, valid for a routing that reads declarations,
    /// with their defaults and scheduling priorities on the wire.
    #[test]
    fn the_manifest_declares_its_consumers_to_routing() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let slot = &manifest["role_declarations"]["routing/v1"];
        let consumers = slot["consumers"].as_array().unwrap();
        assert_eq!(
            consumers[0],
            serde_json::json!({
                "name": "magic-context.summary",
                "iq": 40,
                "placement": "caller_runner",
                "tools": "none",
                "context_window": 64000,
                "priority": "blocking",
            })
        );
        // One consumer per dreamer task kind, placed wherever routing picks.
        let dream: Vec<&str> = consumers[1..]
            .iter()
            .map(|consumer| consumer["name"].as_str().unwrap())
            .collect();
        let kinds: Vec<String> = crate::routing::DREAM_DEMANDS
            .iter()
            .map(|demand| crate::routing::dream_consumer(demand.kind))
            .collect();
        assert_eq!(dream, kinds);
        assert!(consumers[1..]
            .iter()
            .all(|consumer| consumer.get("placement").is_none()));
        // Dreamer work yields a free model slot to anything more urgent.
        assert!(consumers[1..]
            .iter()
            .all(|consumer| consumer["priority"] == "background"));
        // No consumer states an output cap (see `routing::consumer_declarations`).
        assert!(consumers
            .iter()
            .all(|consumer| consumer.get("max_output_tokens").is_none()));
        let verify = consumers
            .iter()
            .find(|consumer| consumer["name"] == "magic-context.dream.verify")
            .unwrap();
        assert_eq!(
            verify,
            &serde_json::json!({
                "name": "magic-context.dream.verify",
                "iq": 60,
                "tools": "required",
                "context_window": 200000,
                "priority": "background",
            })
        );
        let parsed: cortexkit_role_routing::declarations::ConsumerDeclarations =
            serde_json::from_value(slot.clone()).unwrap();
        use cortexkit_role_routing::capabilities::{CONSUMER_DECLARATIONS, CONSUMER_PRIORITY};
        parsed
            .validate_serving(&[CONSUMER_DECLARATIONS, CONSUMER_PRIORITY])
            .unwrap();
        // A router that doesn't serve priorities rejects the whole slot by
        // the member's name; this is why ck-mc needs a router advertising
        // `consumer_priority`.
        assert_eq!(
            parsed.validate_serving(&[CONSUMER_DECLARATIONS]),
            Err(
                cortexkit_role_routing::declarations::DeclarationError::UnknownMember {
                    field: "consumers[0].priority".into()
                }
            )
        );
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
            "compaction-limits/v1",
            "compaction-statement-seq/v1",
            "tool-provider/v1",
            "step-transform-provider/v2",
        ] {
            assert!(provides.contains(&claim), "{claim} missing: {provides:?}");
        }
        assert!(
            !provides
                .iter()
                .any(|claim| claim.ends_with("-provider/v1") && *claim != "tool-provider/v1"),
            "an old contract version is still claimed: {provides:?}"
        );
    }

    /// ck-mc declares that it can serve over the private registration
    /// channel a daemon hands it at spawn. The SDK registers over that
    /// channel and binds every outbound connection with a claim.
    #[test]
    fn the_manifest_declares_registration_channel_support() {
        for agent_data in [false, true] {
            let manifest = super::manifest_for("magic-context", agent_data);
            assert_eq!(manifest.registration_channel, Some(true));
        }
    }
}

#[cfg(test)]
mod flow_tests {
    //! A route bound under a flow's scope reaches the two flow operations
    //! and nothing else, on every surface ck-mc serves, and only when the
    //! module that carries flow calls (Basal, `basal()` here) makes the call
    //! under a flow scope its owner authorized.

    use super::*;
    use subc_protocol::scope::{ScopeKind, ScopeStamp};

    const PROJECT: &str = "pj-flow";

    fn handler(dir: &std::path::Path) -> Handler {
        let db = crate::context_db::ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            crate::docs_proposals::insert(
                &tx,
                &crate::docs_proposals::NewProposal {
                    project: PROJECT.into(),
                    run_id: None,
                    checkout: "/nonexistent/pj-flow".into(),
                    base_commit: "0".repeat(40),
                    created_at: 1,
                    documents: Vec::new(),
                    changes: Vec::new(),
                    dropped: Vec::new(),
                },
            )
            .unwrap();
            tx.commit().unwrap();
        });
        Handler::new(Module::new(
            SubcRunnerClient::new(
                PathBuf::from("unused-flow-connection"),
                Arc::new(ChildScopes::new("flow")),
            ),
            crate::pass::Settings::default(),
            Some(db),
            None,
        ))
    }

    fn flow_scope() -> ScopeStamp {
        let mut scope = ScopeStamp::new(
            Principal::Reserved {
                module_id: "prefrontal-core".into(),
            },
            "flow-scope",
            1,
            ScopeKind::Worker,
        );
        scope.owner_authorized = true;
        scope.attributes.flow_id = Some("flow-docs".into());
        scope
    }

    fn basal() -> Principal {
        Principal::Reserved {
            module_id: "basal".into(),
        }
    }

    /// Bind a route on `channel` to `target`, declaring `role` when given.
    async fn bind(
        handler: &Handler,
        channel: u16,
        target: RouteTarget,
        role: Option<(&str, &str)>,
        principal: Principal,
        scope: ScopeStamp,
    ) {
        let mut request = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(channel, 1),
            target,
            BindIdentity::new("flow", "flow-docs"),
        );
        request.principal = Some(principal);
        request.scope = Some(scope);
        request.role_versions = role.map(|(name, version)| {
            std::collections::BTreeMap::from([(name.to_owned(), version.to_owned())])
        });
        let decision = handler.on_bind(&request).await;
        assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
    }

    /// The answer's error code, or `ok` with its body.
    async fn call(handler: &Handler, channel: u16, body: Value) -> (String, Value) {
        let bytes = serde_json::to_vec(&body).unwrap();
        match handler
            .flow_request(channel, &bytes)
            .await
            .expect("a flow route")
        {
            HandlerOutcome::Response(reply) => {
                ("ok".into(), serde_json::from_slice(&reply).unwrap())
            }
            HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => {
                (code, Value::Null)
            }
            _ => panic!("unexpected answer"),
        }
    }

    fn events_get() -> Value {
        json!({"method": "events_get", "params": {
            "event_key": format!("{PROJECT}:1"), "event_name": "docs_proposal", "version": 1,
        }})
    }

    #[tokio::test]
    async fn a_flow_route_reads_a_proposal_and_its_state() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let management = RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        bind(&handler, 20, management, None, basal(), flow_scope()).await;
        let (code, reply) = call(&handler, 20, events_get()).await;
        assert_eq!(code, "ok");
        assert_eq!(reply["result"]["event_key"], format!("{PROJECT}:1"));
        assert_eq!(reply["result"]["event_name"], "docs_proposal");
        let (code, reply) = call(
            &handler,
            20,
            json!({"method": "docs_proposals.state", "params": {"proposal_id": 1}}),
        )
        .await;
        assert_eq!(code, "ok");
        assert_eq!(reply, json!({"result": {"state": "pending"}}));
    }

    #[tokio::test]
    async fn every_other_call_on_a_flow_route_is_refused_on_every_surface() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let tool = RouteTarget::ToolProvider {
            module_id: crate::MODULE_ID.into(),
        };
        let management = RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        let app = RouteTarget::InternalService {
            module_id: crate::MODULE_ID.into(),
            service_id: crate::app_read::ROLE.0.into(),
        };
        bind(&handler, 30, tool, Some(TOOL_ROLE), basal(), flow_scope()).await;
        bind(&handler, 31, management, None, basal(), flow_scope()).await;
        bind(
            &handler,
            32,
            app,
            Some(crate::app_read::ROLE),
            basal(),
            flow_scope(),
        )
        .await;
        let cases = [
            // A `ctx_*` tool call on the tool provider.
            (
                30,
                json!({"name": "ctx_memory", "arguments": {"action": "list"}}),
            ),
            (30, json!({"name": "tool.catalog", "arguments": {}})),
            // An app read, a person's command, and a runner's op on the
            // management surface.
            (
                31,
                json!({"method": "memories.stats", "params": {"level": "global"}}),
            ),
            (31, json!({"method": "commands.describe", "params": {}})),
            (31, json!({"method": "compaction.setup", "params": {}})),
            (
                31,
                json!({"method": "subagent_invocations.read", "params": {}}),
            ),
            // An app read on the app-read service.
            (
                32,
                json!({"method": "dreamer.docs_proposal", "params": {"project": PROJECT}}),
            ),
            // A body that isn't a request.
            (31, json!("events_get")),
        ];
        for (channel, body) in cases {
            let (code, _) = call(&handler, channel, body.clone()).await;
            assert_eq!(code, "flow_route_not_admitted", "{body}");
        }
        // The flow operations are admitted on any surface the flow bound.
        assert_eq!(call(&handler, 30, events_get()).await.0, "ok");
        assert_eq!(call(&handler, 32, events_get()).await.0, "ok");
    }

    #[tokio::test]
    async fn a_flow_operation_needs_the_carrier_and_an_authorized_flow_scope() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let management = || RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        let mut unauthorized = flow_scope();
        unauthorized.owner_authorized = false;
        let mut foreign = flow_scope();
        foreign.owner = Principal::Direct;
        let mut codemode = flow_scope();
        codemode.attributes.run_id = Some("run-1".into());
        let cases = [
            (40, Principal::Direct, flow_scope()),
            (
                41,
                Principal::Reserved {
                    module_id: "callosum".into(),
                },
                flow_scope(),
            ),
            (42, basal(), unauthorized),
            (43, basal(), foreign),
            (44, basal(), codemode),
        ];
        for (channel, principal, scope) in cases {
            bind(&handler, channel, management(), None, principal, scope).await;
            let (code, _) = call(&handler, channel, events_get()).await;
            assert_eq!(code, "caller_forbidden", "channel {channel}");
        }
    }

    /// A flow scope like [`flow_scope`] but owned by `module_id`.
    fn owned_by(module_id: &str) -> ScopeStamp {
        let mut scope = flow_scope();
        scope.owner = Principal::Reserved {
            module_id: module_id.into(),
        };
        scope
    }

    /// Prefrontal owns flow scopes under its current module id, `prefrontal`,
    /// and under the one it had before, `prefrontal-core`; a scope owned by
    /// either reaches both flow operations.
    #[tokio::test]
    async fn a_flow_scope_owned_by_either_prefrontal_id_reaches_the_flow_operations() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let management = || RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        let state = || json!({"method": "docs_proposals.state", "params": {"proposal_id": 1}});
        for (channel, owner) in [(60, "prefrontal"), (61, "prefrontal-core")] {
            bind(
                &handler,
                channel,
                management(),
                None,
                basal(),
                owned_by(owner),
            )
            .await;
            assert_eq!(
                call(&handler, channel, events_get()).await.0,
                "ok",
                "{owner}"
            );
            assert_eq!(call(&handler, channel, state()).await.0, "ok", "{owner}");
        }
    }

    /// A flow scope any other module owns is refused, and the refusal names
    /// both of prefrontal's ids.
    #[tokio::test]
    async fn a_flow_scope_owned_by_another_module_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let management = || RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        };
        let body = serde_json::to_vec(&events_get()).unwrap();
        for (channel, owner) in [(62, "callosum"), (63, "prefrontal-legacy")] {
            bind(
                &handler,
                channel,
                management(),
                None,
                basal(),
                owned_by(owner),
            )
            .await;
            match handler.flow_request(channel, &body).await {
                Some(HandlerOutcome::Error { code, message }) => {
                    assert_eq!(code, "caller_forbidden", "{owner}");
                    assert!(
                        message.contains("reserved:prefrontal or reserved:prefrontal-core"),
                        "{message}"
                    );
                }
                other => panic!("{owner}: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn a_route_bound_under_no_flow_is_not_a_flow_route() {
        let dir = tempfile::tempdir().unwrap();
        let handler = handler(dir.path());
        let mut request = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(50, 1),
            RouteTarget::ManagementSurface {
                module_id: crate::MODULE_ID.into(),
            },
            BindIdentity::new("", "command-test"),
        );
        request.principal = Some(basal());
        handler.on_bind(&request).await;
        assert!(handler.flow_request(50, b"{}").await.is_none());
    }

    #[test]
    fn the_manifest_declares_flow_scopes_the_flow_operations_and_the_events() {
        let manifest = serde_json::to_value(super::manifest("magic-context")).unwrap();
        let claims = manifest["capabilities"]["provides"].as_array().unwrap();
        assert!(claims.contains(&json!("flow-scopes/v1")));
        let surface = manifest["provides"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["role"] == "management_surface")
            .unwrap();
        for op in ["events_get", "docs_proposals.state"] {
            let declared = surface["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|operation| operation["name"] == op)
                .unwrap_or_else(|| panic!("{op} is declared"));
            assert_eq!(declared["kind"], "query", "{op}");
        }
        assert_eq!(
            manifest["events"],
            json!([{
                "name": "docs_proposal",
                "version": 1,
                "headers": ["event_key", "project_id"],
                "summary": "Magic Context proposed edits to a project's ARCHITECTURE.md and STRUCTURE.md",
            }, {
                "name": "memory_changed",
                "version": 1,
                "headers": ["level", "owner_id", "revision"],
                "summary": "Magic Context memories of a project, a workspace or the person changed",
            }, {
                "name": "attribution_fact",
                "version": 1,
                "headers": [],
                "summary": "Magic Context recorded the agent, task and project a child session it started works for",
            }])
        );
        subc_protocol::manifest::validate_hello_event_declarations(&json!({"manifest": manifest}))
            .unwrap();
    }
}
