//! The production task executor: the hosts that run each dream task in Rust, and
//! the carrier their children go through.
//!
//! Children go through the llm-runner carrier: to the user-configured Broca
//! runner, or to a runner-lane conversation's own runner. A task reaches this
//! executor only when `ownership::publish` named it, so a run never starts for a
//! task whose children nothing can carry.

use super::broca_carrier::{BrocaCarrier, BrocaPolicy, BrocaPort, BrocaToolRoute};
use super::classify_host::ClassifyHost;
use super::context::{
    ChildEvent, ChildObserver, ControlError, TaskContext, TaskToolRouter, ToolError, ToolResult,
};
use super::curate_host::{CurateError, CurateHost};
use super::dispatcher::{GateDecision, TaskExecutor};
use super::due_inputs::{self, ProjectProfiles};
use super::primer_host::{PrimerCarrier, PrimerHost};
use super::retrospective_host::{HostError, RetrospectiveHost};
use super::routed::carrier::{RoutedCarrier, RoutedCarrierParts, RoutedParks, ROUTE_WAITING};
use super::routed::scope::EntorhinalProjectId;
use super::routed::wire::DreamWire;
use super::session_reader;
use super::verify_host::VerifyHost;
use crate::dream_runner::{
    resolve_task_models, CarrierError, ChildRequest, Completion, DreamCarrier,
};
use crate::dream_tasks::{classify::SensitiveContext, classify::TaskError, curate::CurateCarrier};
use mc_store::dream_scheduler::schedules::{RunOutcome, RunStatus, ScheduleState, TaskName};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::StoreScope;
use mc_store::McStore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Makes one Broca port per task run. A port carries the llm-runner ops of the
/// sessions that run opens; it is never shared between runs.
pub trait BrocaPorts: Send {
    type Port: BrocaPort;
    fn port(&self) -> Self::Port;
}

/// No Broca transport is wired; a Broca run is refused before any work.
pub struct NoBroca;

impl BrocaPort for NoBroca {
    async fn call(
        &mut self,
        _: &str,
        _: &str,
        _: Value,
    ) -> Result<Value, super::broca_carrier::PortError> {
        Err(super::broca_carrier::PortError {
            code: "broca_unwired".into(),
            message: "no Broca transport is wired".into(),
            detail: Value::Null,
            outcome_unknown: false,
        })
    }
    async fn next_unit(
        &mut self,
        _: &str,
    ) -> Result<Option<Value>, super::broca_carrier::PortError> {
        Ok(None)
    }
    async fn release(&mut self, _: &str) {}
}

impl BrocaPorts for NoBroca {
    type Port = NoBroca;
    fn port(&self) -> NoBroca {
        NoBroca
    }
}

/// Where this run's children go.
pub enum Transport<B: BrocaPorts> {
    /// Send children to the configured Broca runner.
    Broca {
        ports: B,
        routes: Arc<BrocaToolRoute>,
        module_id: String,
    },
    /// Place every child through routing, under the run's own project scope,
    /// on the runner routing names (see `routed::carrier`).
    Routed {
        wire: Arc<dyn DreamWire>,
        routes: Arc<BrocaToolRoute>,
        module_id: String,
        /// Entorhinal's answer for the run's folder, resolved before the run.
        project_id: EntorhinalProjectId,
        parks: Arc<RoutedParks>,
    },
}

/// The carrier of one task run.
pub enum TaskCarrier<P: BrocaPort> {
    Broca(Box<BrocaCarrier<P>>),
    Routed(Box<RoutedCarrier>),
}

impl<P: BrocaPort> DreamCarrier for TaskCarrier<P> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        match self {
            Self::Broca(c) => c.open(request).await,
            Self::Routed(c) => c.open(request).await,
        }
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        match self {
            Self::Broca(c) => c.complete(child, request).await,
            Self::Routed(c) => c.complete(child, request).await,
        }
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        match self {
            Self::Broca(c) => c.close(child, settled).await,
            Self::Routed(c) => c.close(child, settled).await,
        }
    }
}

/// A router for children whose role routes no tool back to Rust. Every call is
/// refused; the carriers' allowlists already keep such calls from arriving.
struct NoTools;

impl TaskToolRouter for NoTools {
    fn execute(&self, _: &str, tool: &str, _: &Value) -> Result<ToolResult, ToolError> {
        Err(ToolError::NotAdmitted(tool.into()))
    }
}

/// Child events are informational here: effects land through the hosts' fenced
/// commits and tool routers, never through an observed event.
struct Discard;

impl ChildObserver for Discard {
    fn observe(&self, _: &str, _: ChildEvent) -> Result<(), ToolError> {
        Ok(())
    }
}

/// Records every tool call the task router actually executed, per child, so the
/// curate validator can count completed memory operations from what ran rather
/// than from what the model wrote about running.
struct RecordingRouter {
    inner: Arc<dyn TaskToolRouter>,
    calls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
}

impl TaskToolRouter for RecordingRouter {
    fn execute(&self, child: &str, tool: &str, arguments: &Value) -> Result<ToolResult, ToolError> {
        let result = self.inner.execute(child, tool, arguments);
        let part = match &result {
            Ok(done) => json!({"type": "tool", "tool": tool, "state": {"status": "completed",
                "input": arguments, "output": done.output.as_str().map_or_else(|| done.output.to_string(), str::to_owned)}}),
            Err(error) => json!({"type": "tool", "tool": tool, "state": {"status": "error",
                "input": arguments, "error": format!("{error:?}")}}),
        };
        if let Ok(mut calls) = self.calls.lock() {
            calls.entry(child.to_owned()).or_default().push(part);
        }
        result
    }
}

/// A carrier whose message list for a child is the tool calls the task router
/// actually executed for it, in the assistant-message shape that
/// `curate::inspect_operations` and the primer grounding gate read. Tools the
/// host runs itself (read, grep and the like) never reach the router, so they
/// are not listed.
struct RecordedCarrier<P: BrocaPort> {
    inner: TaskCarrier<P>,
    calls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
}

impl<P: BrocaPort> RecordedCarrier<P> {
    fn recorded(&self, child: &str) -> Value {
        let parts = self
            .calls
            .lock()
            .ok()
            .and_then(|calls| calls.get(child).cloned())
            .unwrap_or_default();
        json!([{"info": {"role": "assistant"}, "parts": parts}])
    }
}

impl<P: BrocaPort> DreamCarrier for RecordedCarrier<P> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        self.inner.open(request).await
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        self.inner.complete(child, request).await
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        self.inner.close(child, settled).await
    }
}

impl<P: BrocaPort> CurateCarrier for RecordedCarrier<P> {
    fn messages(&self, child: &str) -> Value {
        self.recorded(child)
    }
}

/// The module has no embedding client of its own (ctx_search receives its query
/// vector from the host), so `embedding_model` stays `None`: promotion clusters
/// by normalized question text, as the TypeScript dreamer does when its
/// embedding call fails.
impl<P: BrocaPort> PrimerCarrier for RecordedCarrier<P> {
    fn messages(&self, child: &str) -> Value {
        self.recorded(child)
    }
}

/// The tasks this build runs end to end in Rust. Publication never names a task
/// outside this list.
pub const OPERATIONAL: &[TaskName] = super::dispatcher::OPERATIONAL_TASKS;

/// The production executor for one project's dream tick or manual run.
pub struct DreamExecutor<B: BrocaPorts> {
    pub store: Arc<McStore>,
    pub scheduler: Arc<SqliteDreamScheduler>,
    pub transport: Transport<B>,
    /// `ownership::publish`'s list for the project, restricted to the tasks this
    /// build has wired. Nothing else is planned, seeded or dispatched.
    pub published: Vec<TaskName>,
    /// Host identity used by classification's shareability check.
    pub sensitive: SensitiveContext,
    /// Set by a routed child that parked on a timed refusal during the current
    /// task run, to the reset time routing named.
    parked: Arc<AtomicU64>,
    project_context: Option<Arc<dyn ProjectProfiles>>,
    project_directory: Option<PathBuf>,
    project_harness: String,
    captured: Option<(String, Value, mc_store::memory_levels::RunAuthority)>,
}

impl<B: BrocaPorts> DreamExecutor<B> {
    /// `wired` is the wiring publication used (`Wiring::tasks`, which is
    /// [`OPERATIONAL`] in production); a published task outside it never runs.
    pub fn new(
        store: Arc<McStore>,
        scheduler: Arc<SqliteDreamScheduler>,
        transport: Transport<B>,
        published: &[TaskName],
        wired: &[TaskName],
    ) -> Self {
        Self {
            store,
            scheduler,
            transport,
            published: published
                .iter()
                .copied()
                .filter(|task| wired.contains(task))
                .collect(),
            sensitive: SensitiveContext {
                home: std::env::var("HOME").unwrap_or_default(),
                username: std::env::var("USER").unwrap_or_default(),
            },
            parked: Arc::default(),
            project_context: None,
            project_directory: None,
            project_harness: String::new(),
            captured: None,
        }
    }

    pub(crate) fn with_project_context(
        mut self,
        source: Arc<dyn ProjectProfiles>,
        directory: PathBuf,
        harness: &str,
    ) -> Self {
        self.project_context = Some(source);
        self.project_directory = Some(directory);
        self.project_harness = harness.to_owned();
        self
    }

    async fn capture_run(
        &self,
        task: TaskName,
        scope: &StoreScope,
    ) -> Result<(Value, mc_store::memory_levels::RunAuthority), String> {
        let root = self
            .project_directory
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new(&scope.project.0));
        let pin = match &self.project_context {
            Some(source) => source.read(&root.to_string_lossy()).await,
            None => due_inputs::unavailable_context(),
        };
        let inputs = due_inputs::capture(
            &self.store,
            &scope.project.0,
            root,
            &self.project_harness,
            task,
        )?;
        Ok((inputs.watermark(), due_inputs::authority(&pin)))
    }

    fn carrier(
        &self,
        context: &Arc<TaskContext>,
        router: Arc<dyn TaskToolRouter>,
    ) -> TaskCarrier<B::Port> {
        match &self.transport {
            Transport::Broca {
                ports,
                routes,
                module_id,
            } => TaskCarrier::Broca(Box::new(BrocaCarrier::new(
                ports.port(),
                routes.clone(),
                context.clone(),
                router,
                Arc::new(Discard),
                self.scheduler.clone(),
                BrocaPolicy {
                    module_id: module_id.clone(),
                    require_hard_cap: false,
                    privacy_sensitive: false,
                },
            ))),
            Transport::Routed {
                wire,
                routes,
                module_id,
                project_id,
                parks,
            } => TaskCarrier::Routed(Box::new(RoutedCarrier::new(RoutedCarrierParts {
                wire: wire.clone(),
                routes: routes.clone(),
                context: context.clone(),
                router,
                observer: Arc::new(Discard),
                scheduler: self.scheduler.clone(),
                policy: BrocaPolicy {
                    module_id: module_id.clone(),
                    require_hard_cap: false,
                    privacy_sensitive: false,
                },
                project_id: project_id.clone(),
                parks: parks.clone(),
                parked: self.parked.clone(),
            }))),
        }
    }

    /// The durable task cursor this scheduler keeps for `task`, if any.
    fn task_state(&self, context: &TaskContext) -> Option<Value> {
        match self.scheduler.schedule(&context.scope, context.task) {
            mc_store::parity_schema_manifest::CapabilityResult::Available {
                value: Some(state),
            } => state
                .task_state_json
                .and_then(|raw| serde_json::from_str(&raw).ok()),
            _ => None,
        }
    }
}

fn shared(context: &TaskContext) -> Arc<TaskContext> {
    Arc::new(TaskContext {
        task: context.task,
        scope: context.scope.clone(),
        config: context.config.clone(),
        domain_lease: context.domain_lease.clone(),
        task_lease: context.task_lease.clone(),
        cancellation: context.cancellation.clone(),
        clock: context.clock.clone(),
        deadline_ms: context.deadline_ms,
        control: context.control.clone(),
    })
}

fn failed(error: impl Into<String>) -> RunOutcome {
    let mut outcome = RunOutcome::new(RunStatus::Failed);
    outcome.error = Some(error.into());
    outcome
}

fn task_error(error: TaskError) -> RunOutcome {
    match error {
        TaskError::Budget => failed("token_budget: budget_exhausted"),
        TaskError::LeaseLost => failed("lease_lost"),
        TaskError::Commit(message) => failed(message),
        TaskError::Runner(failure) => {
            // A restart quarantine (a killed process's child may still run) is not
            // an attempt at the task: give the slot back for a later tick.
            if let crate::dream_runner::Failure::Open(message) = &failure {
                if message.contains("dream_restart_quarantine_until") {
                    return failed(format!("{}{message}", super::dispatcher::ABANDON_PREFIX));
                }
            }
            let mut outcome = failed(format!("{failure:?}"));
            outcome.transient = matches!(
                failure,
                crate::dream_runner::Failure::Transport(_) | crate::dream_runner::Failure::Timeout
            );
            outcome
        }
    }
}

impl<B: BrocaPorts> TaskExecutor for DreamExecutor<B> {
    fn operational_tasks(&self) -> &[TaskName] {
        &self.published
    }

    async fn gate(
        &mut self,
        task: TaskName,
        scope: &StoreScope,
        state: &ScheduleState,
        invocation: &str,
    ) -> Result<GateDecision, String> {
        self.captured = None;
        let (watermark, authority) = self.capture_run(task, scope).await?;
        if due_inputs::memory_kind(task)
            && matches!(
                authority.state.as_str(),
                "unresolved" | "conflict" | "blocked" | "unavailable"
            )
        {
            return Ok(GateDecision::Skip {
                code: authority.state,
            });
        }
        let inputs: due_inputs::Inputs =
            serde_json::from_value(watermark.clone()).map_err(|error| error.to_string())?;
        if !inputs.due(task, state) {
            return Ok(GateDecision::Skip {
                code: "inputs_unchanged".into(),
            });
        }
        self.captured = Some((invocation.to_owned(), watermark, authority));
        Ok(GateDecision::Run)
    }

    async fn run(&mut self, context: &TaskContext) -> RunOutcome {
        if self.project_harness.is_empty() {
            self.project_harness = context.config.harness.clone();
        }
        if self
            .captured
            .as_ref()
            .is_none_or(|(invocation, _, _)| *invocation != context.task_lease.invocation.0)
        {
            // Forced runs bypass the gate, but capture exactly the same authority
            // and inputs at run start. They never consult the unchanged predicate.
            let (watermark, authority) = match self.capture_run(context.task, &context.scope).await
            {
                Ok(captured) => captured,
                Err(error) => return failed(error),
            };
            self.captured = Some((
                context.task_lease.invocation.0.clone(),
                watermark,
                authority,
            ));
            if context.task == TaskName::Curate {
                if let Err(error) = due_inputs::expire_on_curate(&self.store, context) {
                    return failed(error);
                }
            }
        }
        self.parked.store(0, Ordering::Release);
        let mut outcome = self.run_host(context).await;
        outcome.inputs_watermark = self.captured.take().map(|(_, watermark, _)| watermark);
        let parked = self.parked.load(Ordering::Acquire);
        if parked > 0 {
            // Routing asked the task to wait: give the slot back without
            // recording an attempt, so the next tick after the reset retries it.
            return failed(format!(
                "{}{ROUTE_WAITING}: until {parked}",
                super::dispatcher::ABANDON_PREFIX
            ));
        }
        outcome
    }
}

impl<B: BrocaPorts> DreamExecutor<B> {
    async fn run_host(&mut self, context: &TaskContext) -> RunOutcome {
        let context = shared(context);
        match context.task {
            TaskName::Classify | TaskName::Map => {
                let carrier = self.carrier(&context, Arc::new(NoTools));
                let mut host = ClassifyHost::new(carrier, self.store.clone(), context);
                match host.run(&self.sensitive).await {
                    Ok(outcome) => {
                        if matches!(outcome, super::classify_host::Outcome::Map(_)) {
                            if let Some((_, watermark, _)) = &mut self.captured {
                                due_inputs::Inputs::map_attempts(
                                    watermark,
                                    host.map_attempted_ids(),
                                );
                            }
                        }
                        RunOutcome::new(RunStatus::Completed)
                    }
                    Err(error) => task_error(error),
                }
            }
            TaskName::Verify | TaskName::VerifyBroad => {
                let broad_start = self
                    .task_state(&context)
                    .and_then(|state| state["broadCycleStartAt"].as_i64());
                let carrier = self.carrier(&context, Arc::new(NoTools));
                let task = context.task;
                let mut host = VerifyHost::new(carrier, self.store.clone(), context);
                match host.run(broad_start).await {
                    Ok(outcome) => {
                        let mut done = RunOutcome::new(RunStatus::Completed);
                        // An unfinished broad cycle resumes from its start next run.
                        if task == TaskName::VerifyBroad {
                            let open = outcome
                                .as_ref()
                                .filter(|o| !o.verification.complete)
                                .and_then(|o| o.verification.broad_cycle_start);
                            done.task_state_json =
                                Some(json!({"broadCycleStartAt": open}).to_string());
                        }
                        done
                    }
                    Err(error) => failed(error),
                }
            }
            TaskName::Curate => {
                let calls = Arc::new(Mutex::new(HashMap::new()));
                let store = self.store.clone();
                let mut host = CurateHost::new_with_authority(
                    store,
                    context.clone(),
                    |router| {
                        let recording = Arc::new(RecordingRouter {
                            inner: router,
                            calls: calls.clone(),
                        });
                        RecordedCarrier {
                            inner: self.carrier(&context, recording),
                            calls: calls.clone(),
                        }
                    },
                    self.captured
                        .as_ref()
                        .map(|(_, _, authority)| authority.clone()),
                );
                match host.run().await {
                    Ok(_) => RunOutcome::new(RunStatus::Completed),
                    Err(CurateError::Run(failure)) => task_error(TaskError::Runner(failure)),
                    Err(error) => failed(format!("{error:?}")),
                }
            }
            TaskName::Retrospective => {
                let (reader, options, collection) = session_reader::retrospective_inputs(
                    self.store.clone(),
                    &context.config.effective,
                    &context.config.harness,
                    context.now_ms(),
                );
                let carrier = self.carrier(&context, Arc::new(NoTools));
                let mut host = RetrospectiveHost::new(carrier, self.store.clone(), context)
                    .with_authority(
                        self.captured
                            .as_ref()
                            .map(|(_, _, authority)| authority.clone()),
                    );
                match host.run_retrospective(&reader, &options, collection).await {
                    Ok(_) => RunOutcome::new(RunStatus::Completed),
                    Err(error) => host_error(error),
                }
            }
            TaskName::PromotePrimers | TaskName::RefreshPrimers => {
                let calls = Arc::new(Mutex::new(HashMap::new()));
                let recording = Arc::new(RecordingRouter {
                    inner: Arc::new(NoTools),
                    calls: calls.clone(),
                });
                let carrier = RecordedCarrier {
                    inner: self.carrier(&context, recording),
                    calls,
                };
                let mut host = PrimerHost::new(carrier, self.store.clone(), context);
                match host.run().await {
                    Ok(_) => RunOutcome::new(RunStatus::Completed),
                    Err(error) => task_error(error),
                }
            }
            TaskName::ReviewUserMemories => {
                // `dreamer.tasks["review-user-memories"].promotion_threshold ?? 3`,
                // as task-config.ts `userMemoryPromotionThreshold` reads it.
                let threshold = resolve_task_models(
                    &context.config.effective,
                    &context.config.harness,
                    context.task.as_str(),
                )
                .promotion_threshold
                // `candidates.length < threshold` over whole counts is the same
                // test as against the threshold rounded up.
                .map_or(3, |t| t.max(0.0).ceil() as usize);
                let carrier = self.carrier(&context, Arc::new(NoTools));
                let mut host = RetrospectiveHost::new(carrier, self.store.clone(), context)
                    .with_authority(
                        self.captured
                            .as_ref()
                            .map(|(_, _, authority)| authority.clone()),
                    );
                match host.run_user_review(threshold).await {
                    Ok(_) => RunOutcome::new(RunStatus::Completed),
                    Err(error) => host_error(error),
                }
            }
            other => failed(format!("unavailable_capability: {}", other.as_str())),
        }
    }
}

fn host_error(error: HostError) -> RunOutcome {
    match error {
        HostError::Model(failure) => task_error(TaskError::Runner(failure)),
        HostError::Control(ControlError::BudgetExhausted) => task_error(TaskError::Budget),
        HostError::Control(_) => task_error(TaskError::LeaseLost),
        HostError::Store(error) => failed(error.to_string()),
        HostError::Input(message) => failed(message),
    }
}
