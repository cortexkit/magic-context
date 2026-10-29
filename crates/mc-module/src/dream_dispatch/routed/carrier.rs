//! The one carrier of every routed dream task.
//!
//! Each child the task opens is a work order for the model-work engine: select
//! on the run's own project scope as the task's consumer, send exactly the
//! route routing answered to the runner it named, follow the run, report the
//! outcome, and on a failure select again with the failed route excluded. The
//! runner side of each decision is the llm-runner carrier ck-mc already uses for
//! Broca ([`BrocaCarrier`]), bound to a fresh `mc-dream:<project>:<run>` session
//! on the chosen runner under the run's scope.
//!
//! The domain and task leases are held by the dispatcher for the whole task, so
//! they stay held across every re-select. A timed `no_route` parks the task: the
//! carrier remembers the reset per project and consumer, asks nothing before it,
//! and tells the executor, which gives the slot back without recording a run.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{Outcome, ReportAnswer, ReportRequest, Usage as RouteUsage},
    select::{Requirements, ToolsRequirement},
};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use serde_json::{json, Value};

use super::fetch_plan::{self, Grant, Provider};
use super::registry::{self, DreamTaskRegistration};
use super::scope::{session_name, DreamScope, EntorhinalProjectId};
use super::wire::{DreamWire, RunnerBind};
use crate::dream_dispatch::broca_carrier::{
    BrocaCarrier, BrocaPolicy, BrocaPort, BrocaToolRoute, PortError,
};
use crate::dream_dispatch::context::{ChildObserver, TaskContext, TaskToolRouter};
use crate::dream_runner::{CarrierError, ChildRequest, Completion, DreamCarrier, ModelEntry};
use crate::model_work::{
    Clock as _, Engine, RoutingCatalog, RunResult, Runner, ScopeRoute, SelectParams, WallClock,
    WorkError, WorkOrder,
};
use crate::runner_choices::RoutedChoice;

/// No route routing answered names a harness its runner hosts the session on,
/// so no session could be bound.
pub const HARNESS_UNKNOWN: &str = "mc_dream_runner_harness_unknown";
/// Routing named a key pool for the route; llm-runner 0.7.0's `session.send`
/// has no member to pass it, and sending without it could bill another key.
pub const AUTH_UNSUPPORTED: &str = "mc_dream_runner_auth_unsupported";
/// No routing/v1 provider is in the catalog.
pub const ROUTING_UNAVAILABLE: &str = "routing_provider_missing";
/// Routing refused with a reset time; the task waits until then.
pub const ROUTE_WAITING: &str = "mc_route_waiting";
/// A runner session could not be shown to have stopped, so no further paid run
/// may start for this child.
pub const CLEANUP_FAILED: &str = "mc_dream_cleanup_failed";
pub const TOOL_UNAVAILABLE: &str = "mc_dream_tool_unavailable";
/// Decisions one child may use before it is refused `mc_route_exhausted`.
pub const MAX_DECISIONS: usize = 3;
/// Time kept back from each send so a timed-out run can still be cancelled and
/// shown to have stopped before the work's deadline.
const CLEANUP_MARGIN: Duration = Duration::from_secs(5);

/// The published routing answer carries only a harness declared by the runner.
pub(crate) fn hosted_harness(choice: &RoutedChoice) -> Option<String> {
    choice.runner.harness.clone()
}

fn error(message: impl Into<String>) -> CarrierError {
    CarrierError {
        message: message.into(),
        // The engine already re-selected; another model from a config chain
        // must not start a second round of paid runs.
        retryable: false,
    }
}

fn now_ms() -> u64 {
    WallClock.now_ms()
}

/// Routing's `no_route` resets, per project and consumer, so a parked task's
/// consumer is not asked again before routing said it could answer.
#[derive(Default)]
pub struct RoutedParks(Mutex<HashMap<(String, String), u64>>);

impl RoutedParks {
    pub fn park(&self, project: &str, consumer: &str, until_ms: u64) {
        if let Ok(mut parks) = self.0.lock() {
            let entry = parks
                .entry((project.to_owned(), consumer.to_owned()))
                .or_default();
            *entry = (*entry).max(until_ms);
        }
    }

    /// The reset `project`'s `consumer` waits for, if it is still in the future.
    pub fn until(&self, project: &str, consumer: &str, now_ms: u64) -> Option<u64> {
        let mut parks = self.0.lock().ok()?;
        let key = (project.to_owned(), consumer.to_owned());
        match parks.get(&key).copied() {
            Some(until) if now_ms < until => Some(until),
            Some(_) => {
                parks.remove(&key);
                None
            }
            None => None,
        }
    }
}

/// The runner's code inside a carrier error: `op: code: message` names the
/// code second, an admission refusal (`unavailable: retention`) first.
fn runner_code(message: &str) -> String {
    let mut parts = message.splitn(3, ": ");
    let first = parts.next().unwrap_or_default();
    match parts.next() {
        Some(second) if first.contains('.') => second.to_owned(),
        _ => first.to_owned(),
    }
}

fn outcome(outcome: Outcome, code: &str) -> RunResult<Completion> {
    let mut result = RunResult::new(outcome, None);
    result.runner_code = Some(code.to_owned());
    result
}

/// An llm-runner port to the runner routing chose, on a route under the run's
/// scope, bound to the session ck-mc named.
struct WirePort {
    wire: Arc<dyn DreamWire>,
    scope: DreamScope,
    bind: RunnerBind,
    plan: Value,
}

impl BrocaPort for WirePort {
    async fn call(&mut self, _: &str, op: &str, mut params: Value) -> Result<Value, PortError> {
        if op == "session.send" {
            // The shared carrier still builds the legacy provider-specific plan.
            // Only routed sends replace it with capability-resolved providers.
            params.as_object_mut().expect("send object").remove("plan");
            if !self.plan["items"].as_array().is_none_or(Vec::is_empty) {
                params["plan"] = self.plan.clone();
            }
        }
        self.wire
            .runner_call(&self.scope, &self.bind, op, params)
            .await
    }
    async fn next_unit(&mut self, _: &str) -> Result<Option<Value>, PortError> {
        self.wire.runner_next_unit(&self.scope, &self.bind).await
    }
    async fn release(&mut self, _: &str) {
        self.wire.runner_release(&self.scope, &self.bind).await;
    }
    fn routed(&self) -> bool {
        true
    }
    fn session_name(&self) -> Option<String> {
        Some(self.bind.session.clone())
    }
}

/// The run's scope as the engine sees it: selects and reports go out under it,
/// and each answer's hosted harness is kept by decision for the send.
struct RunScope {
    wire: Arc<dyn DreamWire>,
    scope: Mutex<DreamScope>,
    scope_key: String,
    project_key: String,
    harnesses: Mutex<HashMap<String, Option<String>>>,
    tool_refusals: Mutex<HashSet<String>>,
}

impl RunScope {
    fn current(&self) -> DreamScope {
        self.scope.lock().expect("dream scope").clone()
    }

    fn replace(&self, scope: DreamScope) {
        *self.scope.lock().expect("dream scope") = scope;
    }

    fn harness(&self, decision_id: &str) -> Option<String> {
        self.harnesses
            .lock()
            .ok()?
            .get(decision_id)
            .cloned()
            .flatten()
    }
}

impl ScopeRoute for RunScope {
    fn scope_key(&self) -> &str {
        &self.scope_key
    }

    fn project_key(&self) -> &str {
        &self.project_key
    }

    async fn select(
        &self,
        provider: &str,
        request: &SelectParams,
    ) -> Result<RoutedChoice, Refusal> {
        // Retrying a report for the same decision must not count as another
        // runner admission refusal. Stop before a third selection.
        if self.tool_refusals.lock().expect("tool refusals").len() >= 2 {
            return Err(Refusal::new(RefusalCode::NoRoute, "tool_unavailable twice"));
        }
        // The dream wire sends the published request only. Refuse rather than
        // drop `hold_ok` silently if a dream order ever starts setting it.
        if request.hold_ok.is_some() {
            return Err(Refusal::new(
                RefusalCode::InvalidRequest,
                "hold_ok is not supported on the dream wire",
            ));
        }
        let scope = self.current();
        let answer = self.wire.select(&scope, provider, request).await?;
        let choice: RoutedChoice = serde_json::from_value(answer.clone()).map_err(|e| {
            Refusal::new(
                RefusalCode::InvalidRequest,
                format!("route.select answer does not decode: {e}"),
            )
        })?;
        if let Ok(mut harnesses) = self.harnesses.lock() {
            harnesses.insert(choice.decision_id.clone(), hosted_harness(&choice));
        }
        Ok(choice)
    }

    async fn report(
        &self,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        if request.runner_code.as_deref() == Some("tool_unavailable") {
            self.tool_refusals
                .lock()
                .expect("tool refusals")
                .insert(request.decision_id.clone());
        }
        let scope = self.current();
        self.wire.report(&scope, provider, request).await
    }
}

/// What a send needs from the task, owned so the engine can hold it across
/// awaits.
struct RunRunner<'a> {
    wire: Arc<dyn DreamWire>,
    routes: Arc<BrocaToolRoute>,
    context: Arc<TaskContext>,
    router: Arc<dyn TaskToolRouter>,
    observer: Arc<dyn ChildObserver>,
    scheduler: Arc<SqliteDreamScheduler>,
    policy: BrocaPolicy,
    request: &'a ChildRequest,
    grants: Vec<Grant>,
}

impl Runner<RunScope> for RunRunner<'_> {
    type Output = Completion;

    async fn send(
        &self,
        scope: &RunScope,
        choice: &RoutedChoice,
        deadline_ms: u64,
    ) -> RunResult<Completion> {
        let Some(harness) = scope.harness(&choice.decision_id) else {
            return outcome(Outcome::Refused, HARNESS_UNKNOWN);
        };
        if choice.runner.auth.is_some() {
            return outcome(Outcome::Refused, AUTH_UNSUPPORTED);
        }
        let mut dream_scope = scope.current();
        let capabilities: Vec<_> = self.grants.iter().map(|grant| grant.capability).collect();
        let providers = if capabilities.is_empty() {
            Vec::new()
        } else {
            match self.wire.tool_providers(&dream_scope, &capabilities).await {
                Ok(providers) => providers,
                Err(_) => return outcome(Outcome::Refused, "tool_unavailable"),
            }
        };
        let mut items = Vec::new();
        let mut modules = Vec::new();
        for grant in &self.grants {
            let Some(Provider { module, .. }) = providers
                .iter()
                .find(|provider| provider.capability == grant.capability)
            else {
                return outcome(Outcome::Refused, "tool_unavailable");
            };
            let tools: Vec<_> = grant
                .tools
                .iter()
                .filter(|tool| self.request.allowed_tools.contains(tool))
                .collect();
            let mut params = json!({"tools": tools});
            if grant.capability == fetch_plan::CODE_READ {
                params["root"] = json!(dream_scope.workdir);
            }
            items.push(json!({"provider": module, "item": "tools", "params": params}));
            if !modules.contains(module) {
                modules.push(module.clone());
            }
        }
        if !modules.is_empty() || !dream_scope.record.carriers.is_empty() {
            dream_scope.carry_for(&choice.runner.module, modules);
            if let Err(refusal) = self.wire.sync_scope(&dream_scope).await {
                return outcome(Outcome::Refused, &refusal.code);
            }
            scope.replace(dream_scope.clone());
        }
        let bind = RunnerBind {
            module: choice.runner.module.clone(),
            harness,
            session: session_name(&dream_scope.project_id),
        };
        let mut request = self.request.clone();
        // Exactly the model routing answered, as the runner names it.
        request.model = Some(ModelEntry {
            model: format!(
                "{}/{}",
                choice.runner.model.provider, choice.runner.model.model
            ),
            qualifier: choice.runner.model.variant.clone(),
        });
        let budget = Duration::from_millis(deadline_ms.saturating_sub(now_ms()))
            .saturating_sub(CLEANUP_MARGIN)
            .min(request.timeout);
        if budget.is_zero() {
            return RunResult::new(Outcome::TimedOut, None);
        }
        request.timeout = budget;
        let port = WirePort {
            wire: self.wire.clone(),
            scope: dream_scope,
            bind,
            plan: json!({"items": items}),
        };
        let mut carrier = BrocaCarrier::new(
            port,
            self.routes.clone(),
            self.context.clone(),
            self.router.clone(),
            self.observer.clone(),
            self.scheduler.clone(),
            self.policy.clone(),
        );
        // Nothing was sent when open fails: the runner refused admission.
        let session = match carrier.open(&request).await {
            Ok(session) => session,
            Err(e) => return outcome(Outcome::Refused, &runner_code(&e.message)),
        };
        let completion = tokio::time::timeout(budget, carrier.complete(&session, &request)).await;
        let settled = matches!(completion, Ok(Ok(_)));
        if carrier.close(&session, settled).await.is_err() {
            // Never start another paid run while this one may still be running.
            return outcome(Outcome::Cancelled, CLEANUP_FAILED);
        }
        match completion {
            Ok(Ok(completion)) if completion.length_capped => {
                outcome(Outcome::Failed, "length_capped")
            }
            Ok(Ok(completion)) => {
                let usage = serde_json::from_value::<RouteUsage>(json!({
                    "input_tokens": completion.usage.input
                        + completion.usage.cache_read
                        + completion.usage.cache_write,
                    "output_tokens": completion.usage.output,
                }))
                .ok();
                let mut result = RunResult::new(Outcome::Completed, Some(completion));
                result.usage = usage;
                result
            }
            Ok(Err(e)) => {
                let code = runner_code(&e.message);
                let status = if code == "tool_unavailable" {
                    Outcome::Refused
                } else {
                    Outcome::Failed
                };
                outcome(status, &code)
            }
            Err(_) => RunResult::new(Outcome::TimedOut, None),
        }
    }

    /// A send cancels and closes its own session before it returns, so there is
    /// nothing left to cancel here.
    async fn cancel(&self, _: &RunScope, _: &RoutedChoice) {}
}

/// Everything one task's routed carrier is built from.
pub struct RoutedCarrierParts {
    pub wire: Arc<dyn DreamWire>,
    pub routes: Arc<BrocaToolRoute>,
    pub context: Arc<TaskContext>,
    pub router: Arc<dyn TaskToolRouter>,
    pub observer: Arc<dyn ChildObserver>,
    pub scheduler: Arc<SqliteDreamScheduler>,
    pub policy: BrocaPolicy,
    /// Entorhinal's answer for the run's folder, resolved before the run.
    pub project_id: EntorhinalProjectId,
    pub parks: Arc<RoutedParks>,
    /// Set to the reset time when a child of this task parks on a timed
    /// refusal; the executor then gives the slot back.
    pub parked: Arc<AtomicU64>,
}

pub struct RoutedCarrier {
    parts: RoutedCarrierParts,
    child: Option<DreamScope>,
}

impl RoutedCarrier {
    pub fn new(parts: RoutedCarrierParts) -> Self {
        Self { parts, child: None }
    }

    fn registration(&self) -> Result<&'static DreamTaskRegistration, CarrierError> {
        registry::registration(self.parts.context.task)
            .ok_or_else(|| error("mc_dream_task_unregistered"))
    }

    fn project_key(&self) -> &str {
        &self.parts.context.scope.project.0
    }

    fn park(&self, consumer: &str, until_ms: u64) {
        self.parts
            .parks
            .park(self.project_key(), consumer, until_ms);
        self.parts.parked.fetch_max(until_ms, Ordering::AcqRel);
    }

    fn work_error(&self, consumer: &str, failure: WorkError) -> CarrierError {
        if failure.code == ROUTE_WAITING {
            if let Some(until) = failure.reset_at_ms {
                self.park(consumer, until);
            }
        }
        let harness_only = !failure.attempts.is_empty()
            && failure
                .attempts
                .iter()
                .all(|a| a.report.runner_code.as_deref() == Some(HARNESS_UNKNOWN));
        let unavailable = failure
            .attempts
            .iter()
            .filter(|a| a.report.runner_code.as_deref() == Some("tool_unavailable"))
            .count()
            >= 2;
        let code = if unavailable {
            TOOL_UNAVAILABLE
        } else if harness_only && matches!(failure.code, "mc_route_exhausted" | "mc_no_route") {
            HARNESS_UNKNOWN
        } else {
            failure.code
        };
        let attempts: Vec<String> = failure
            .attempts
            .iter()
            .map(|a| {
                format!(
                    "{} on {}: {}",
                    a.choice.route.route_key(),
                    a.choice.runner.module,
                    a.report
                        .runner_code
                        .clone()
                        .unwrap_or_else(|| format!("{:?}", a.report.outcome))
                )
            })
            .collect();
        let tags: Vec<_> = fetch_plan::plan(self.parts.context.task)
            .iter()
            .map(|grant| grant.capability)
            .collect();
        error(format!(
            "{code}: tags [{}]; attempts [{}]",
            tags.join(", "),
            attempts.join("; ")
        ))
    }
}

impl DreamCarrier for RoutedCarrier {
    /// Register the child's own project scope. Nothing is selected or sent yet.
    async fn open(&mut self, _request: &ChildRequest) -> Result<String, CarrierError> {
        if self.child.is_some() {
            return Err(error("prior_cleanup_required"));
        }
        self.parts
            .context
            .check_control()
            .map_err(|e| error(format!("{e:?}")))?;
        let consumer = self.registration()?.consumer;
        if let Some(until) = self
            .parts
            .parks
            .until(self.project_key(), consumer, now_ms())
        {
            self.parts.parked.fetch_max(until, Ordering::AcqRel);
            return Err(error(format!("{ROUTE_WAITING}: until {until}")));
        }
        // Checked before any scope is registered: without a provider nothing
        // of this run can be placed, so nothing of it starts.
        if self.parts.wire.routing_catalog().await.providers.is_empty() {
            return Err(error(ROUTING_UNAVAILABLE));
        }
        let scope = DreamScope::new(
            self.parts.project_id.clone(),
            &self.parts.context.config.directory,
        );
        if let Err(refusal) = self.parts.wire.sync_scope(&scope).await {
            // A lost registration reply may still have created the scope.
            if self.parts.wire.end_scope(&scope).await.is_err() {
                self.child = Some(scope);
            }
            return Err(error(format!("{}: {}", refusal.code, refusal.detail)));
        }
        let child = scope.scope_ref().to_owned();
        self.child = Some(scope);
        Ok(child)
    }

    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        let scope = self
            .child
            .clone()
            .filter(|scope| scope.scope_ref() == child)
            .ok_or_else(|| error("child_mismatch"))?;
        let registration = self.registration()?;
        let catalog: RoutingCatalog = self.parts.wire.routing_catalog().await;
        let run_scope = RunScope {
            wire: self.parts.wire.clone(),
            scope_key: child.to_owned(),
            project_key: self.project_key().to_owned(),
            scope: Mutex::new(scope),
            harnesses: Mutex::default(),
            tool_refusals: Mutex::default(),
        };
        let runner = RunRunner {
            wire: self.parts.wire.clone(),
            routes: self.parts.routes.clone(),
            context: self.parts.context.clone(),
            router: self.parts.router.clone(),
            observer: self.parts.observer.clone(),
            scheduler: self.parts.scheduler.clone(),
            policy: self.parts.policy.clone(),
            request,
            grants: fetch_plan::child_plan(self.parts.context.task, request.allowed_tools),
        };
        let tools = if request.allowed_tools.is_empty() {
            ToolsRequirement::None
        } else {
            ToolsRequirement::Required
        };
        let order = WorkOrder {
            scope_route: &run_scope,
            work_id: child.to_owned(),
            consumer: registration.consumer.to_owned(),
            requirements: Requirements {
                iq: registration.iq,
                eq: registration.eq,
                tools: Some(tools),
                context_window: Some(
                    (mc_tokenizer::estimate_tokens(&request.system)
                        + mc_tokenizer::estimate_tokens(&request.prompt))
                    .max(1) as u64,
                ),
                tool_capabilities: (!runner.grants.is_empty()).then(|| {
                    runner
                        .grants
                        .iter()
                        .map(|grant| grant.capability.to_owned())
                        .collect()
                }),
                ..Requirements::default()
            },
            pin: None,
            // One key per project and task, so a task's successive children
            // prefer the model that served the last one.
            affinity: format!(
                "{}:{}",
                registration.consumer,
                self.parts.project_id.as_str()
            ),
            concurrency_slots: Some(vec![cortexkit_role_routing::select::ConcurrencySlot {
                key: "mc_dream".into(),
                running: 0,
                limit: 2,
                queued: None,
            }]),
            deadline_ms: now_ms().saturating_add(request.timeout.as_millis() as u64),
            max_decisions: MAX_DECISIONS,
            // Dream runs are background work with no context pressure, so they
            // may wait out a quota reset; the dream wire cannot carry the flag.
            hold_ok: None,
        };
        let result = Engine::new(WallClock).run(&catalog, &order, &runner).await;
        // Keep the carriers the last send registered, so close ends that scope.
        self.child = Some(run_scope.current());
        match result {
            Ok(done) => Ok(done.output),
            Err(failure) => Err(self.work_error(registration.consumer, failure)),
        }
    }

    /// End the child's scope. Every runner session it used was already closed by
    /// its send.
    async fn close(&mut self, child: &str, _prompt_settled: bool) -> Result<(), CarrierError> {
        if self
            .child
            .as_ref()
            .is_none_or(|scope| scope.scope_ref() != child)
        {
            return Err(error("child_mismatch"));
        }
        let scope = self.child.take().expect("checked above");
        if let Err(refusal) = self.parts.wire.end_scope(&scope).await {
            self.child = Some(scope);
            return Err(error(format!("{}: {}", refusal.code, refusal.detail)));
        }
        Ok(())
    }
}

impl Drop for RoutedCarrier {
    fn drop(&mut self) {
        let Some(scope) = self.child.take() else {
            return;
        };
        let wire = self.parts.wire.clone();
        // Task cancellation can drop the carrier before close. The module's
        // serving connection outlives task runtimes, so cleanup uses its own runtime.
        let _ = std::thread::Builder::new()
            .name("mc-dream-scope-release".into())
            .spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    if let Err(refusal) = runtime.block_on(wire.end_scope(&scope)) {
                        tracing::error!(
                            code = refusal.code,
                            detail = refusal.detail,
                            "dream scope cleanup refused"
                        );
                    }
                }
            });
    }
}
