//! Plan scheduled and manual dream tasks on a background worker. Acquire the
//! shared context.db domain before the separate scheduler's task lease.

use super::context::{Cancellation, CapturedConfig, Clock, TaskContext};
use super::domain_control::{available, DomainControl, LeaseGuard};
use mc_store::dream_domain::LEASE_DURATION_MS;
use mc_store::dream_scheduler::schedules::{RunOutcome, ScheduleState, TaskConfig, TaskName};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::{
    BackgroundTask, DreamClaimRequest, DreamFinishRequest, InvocationId, StoreScope,
};
use mc_store::McStore;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The tasks this build runs, one per registration in
/// `routed::registry::REGISTRATIONS`. A new task registers there, next to its
/// host; this dispatcher never lists tasks itself.
pub use super::routed::registry::OPERATIONAL_TASKS;
pub use mc_store::dream_scheduler::GateDecision;

/// An executor that could not start any work, for a reason that says nothing
/// about the task (routing may require a timed retry), reports a
/// failed outcome whose error starts with this prefix. The dispatcher then gives
/// the claim back without recording a run, so the slot stays due and is retried
/// on a later tick instead of being counted as a failed attempt.
pub const ABANDON_PREFIX: &str = "abandon:";

#[allow(async_fn_in_trait)]
pub trait TaskExecutor {
    fn operational_tasks(&self) -> &[TaskName];
    async fn gate(
        &mut self,
        task: TaskName,
        scope: &StoreScope,
        state: &ScheduleState,
        invocation: &str,
    ) -> Result<GateDecision, String>;
    async fn run(&mut self, context: &TaskContext) -> RunOutcome;
}

pub struct UnavailableTasks;

impl TaskExecutor for UnavailableTasks {
    fn operational_tasks(&self) -> &[TaskName] {
        OPERATIONAL_TASKS
    }
    async fn gate(
        &mut self,
        _: TaskName,
        _: &StoreScope,
        _: &ScheduleState,
        _: &str,
    ) -> Result<GateDecision, String> {
        Err("unavailable_capability".into())
    }
    async fn run(&mut self, _: &TaskContext) -> RunOutcome {
        let mut outcome = RunOutcome::new(mc_store::dream_scheduler::schedules::RunStatus::Failed);
        outcome.error = Some("unavailable_capability".into());
        outcome
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    Inactive,
    Unavailable,
    Refused(String),
    Finished(mc_store::dream_scheduler::schedules::RunStatus),
    Aborted(super::context::ControlError),
}

pub struct Dispatcher<E = UnavailableTasks> {
    pub store: Arc<McStore>,
    pub scheduler: Arc<SqliteDreamScheduler>,
    pub scope: StoreScope,
    pub config: Arc<CapturedConfig>,
    pub clock: Arc<dyn Clock>,
    pub executor: E,
}

fn background_task(task: TaskName) -> BackgroundTask {
    match task {
        TaskName::Map => BackgroundTask::Map,
        TaskName::Verify | TaskName::VerifyBroad => BackgroundTask::Verify,
        TaskName::Curate => BackgroundTask::Curate,
        TaskName::CompressCues => BackgroundTask::CompressMuralCues,
        TaskName::Classify => BackgroundTask::Classify,
        TaskName::Retrospective => BackgroundTask::Retrospective,
        TaskName::MaintainDocs => BackgroundTask::MaintainDocs,
        TaskName::EvaluateSmartNotes => BackgroundTask::EvaluateSmartNotes,
        TaskName::ReviewUserMemories => BackgroundTask::ReviewUserMemories,
        TaskName::PromotePrimers | TaskName::RefreshPrimers => BackgroundTask::Primers,
    }
}

fn unique_holder() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // A process start timestamp plus monotonic sequence also distinguishes retries
    // across restarts without deriving ownership from a request-supplied command id.
    format!(
        "rust:{}:{}:{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

impl<E: TaskExecutor> Dispatcher<E> {
    /// Exclude tasks without an executor before planning, so discovering missing
    /// support cannot seed, reconcile or advance their durable schedules.
    pub async fn tick(
        &mut self,
        configs: &[TaskConfig],
        project_memory_enabled: bool,
        timeout: Duration,
    ) -> Result<Vec<(TaskName, DispatchOutcome)>, String> {
        if !self.config.activated {
            return Ok(Vec::new());
        }
        let supported: Vec<_> = configs
            .iter()
            .filter(|c| self.executor.operational_tasks().contains(&c.task))
            .cloned()
            .collect();
        let due = available(self.scheduler.plan_due(
            &self.scope,
            &supported,
            self.clock.now_ms(),
            project_memory_enabled,
        ))?;
        let mut outcomes = Vec::new();
        for due in due {
            let Some(config) = supported.iter().find(|c| c.task == due.task) else {
                continue;
            };
            let invocation = format!(
                "due:{}:{}:{}",
                due.task.as_str(),
                due.scheduled_at,
                unique_holder()
            );
            outcomes.push((
                due.task,
                self.dispatch(config, &invocation, false, timeout, Cancellation::default())
                    .await,
            ));
        }
        Ok(outcomes)
    }

    /// Manual commands use a durable command id; replay cannot run a finished id.
    /// Unlike due ticks, a manual force may run a disabled schedule and bypass gates.
    pub async fn manual(
        &mut self,
        config: &TaskConfig,
        command_id: &str,
        timeout: Duration,
        cancellation: Cancellation,
    ) -> DispatchOutcome {
        self.dispatch(config, command_id, true, timeout, cancellation)
            .await
    }

    /// Move this task's Rust schedule forward to the TypeScript dreamer's row when
    /// TypeScript is further ahead. Called while this run holds the shared domain
    /// lease: TypeScript writes its row before it releases that lease, so a slot
    /// TypeScript ran after this tick planned is seen here and not run again.
    fn adopt_typescript_progress(&self, config: &TaskConfig) {
        if let Ok(Some(legacy)) = self
            .store
            .legacy_task_schedule(&self.scope.project.0, config.task)
        {
            let _ = self.scheduler.adopt_legacy(&self.scope, config, &legacy);
        }
    }

    /// Copy this task's Rust schedule into the TypeScript dreamer's row (forward
    /// only, see `McStore::publish_task_schedule`). Called before the shared domain
    /// lease is released, so a TypeScript dreamer that takes the lease next, even
    /// one that never asks ck-mc which tasks it owns, already sees the slot as run.
    fn publish_progress(&self, task: TaskName) {
        if let mc_store::parity_schema_manifest::CapabilityResult::Available {
            value: Some(state),
        } = self.scheduler.schedule(&self.scope, task)
        {
            let _ = self
                .store
                .publish_task_schedule(&self.scope.project.0, task, &state);
        }
    }

    async fn dispatch(
        &mut self,
        config: &TaskConfig,
        invocation: &str,
        manual: bool,
        timeout: Duration,
        cancellation: Cancellation,
    ) -> DispatchOutcome {
        let task = config.task;
        let manual = manual.then_some(config);
        if !self.config.activated {
            return DispatchOutcome::Inactive;
        }
        if !self.executor.operational_tasks().contains(&task) {
            return DispatchOutcome::Unavailable;
        }
        let now = self.clock.now_ms();
        let Some(deadline_ms) = i64::try_from(timeout.as_millis())
            .ok()
            .filter(|t| *t > 0)
            .and_then(|t| now.checked_add(t))
        else {
            return DispatchOutcome::Refused("invalid_deadline".into());
        };
        if invocation.trim().is_empty() || !self.config.directory.is_absolute() {
            return DispatchOutcome::Refused("invalid_request".into());
        }
        if cancellation.is_cancelled() {
            return DispatchOutcome::Aborted(super::context::ControlError::Cancelled);
        }
        let key = task.lease_key(&self.scope.project.0);
        let domain = match self.store.acquire_dream_domain(&key, &unique_holder(), now) {
            Ok(Some(lease)) => lease,
            Ok(None) => return DispatchOutcome::Refused("domain_busy".into()),
            Err(e) => return DispatchOutcome::Refused(e.to_string()),
        };
        self.adopt_typescript_progress(config);
        let claim = DreamClaimRequest {
            scope: self.scope.clone(),
            task: background_task(task),
            domain: key,
            invocation: InvocationId(invocation.into()),
            now_ms: now,
            lease_ms: LEASE_DURATION_MS as u64,
            token_budget: task.default_budget().unwrap_or(2_500_000),
            manual_force: manual.is_some(),
        };
        let gate_store = self.store.clone();
        let gate_scheduler = self.scheduler.clone();
        let gate_scope = self.scope.clone();
        let gate_config = self.config.clone();
        let gate_domain = domain.clone();
        let gate_cancel = cancellation.clone();
        let gate_clock = self.clock.clone();
        let executor = &mut self.executor;
        let lease = match available(
            self.scheduler
                .claim_task_checked_async(&claim, task, manual, |state, lease| async move {
                    let invocation = lease.invocation.0.clone();
                    if task == TaskName::Curate {
                        let context = TaskContext {
                            task,
                            scope: gate_scope.clone(),
                            config: gate_config,
                            domain_lease: gate_domain.clone(),
                            task_lease: lease.clone(),
                            cancellation: gate_cancel.clone(),
                            clock: gate_clock.clone(),
                            deadline_ms,
                            control: Arc::new(DomainControl::new(
                                gate_store.clone(),
                                gate_scheduler,
                                gate_domain,
                                lease,
                                gate_cancel,
                                gate_clock,
                                deadline_ms,
                            )),
                        };
                        super::due_inputs::expire_on_curate(&gate_store, &context).map_err(
                            |_| mc_store::dream_scheduler::Error::Refused("expiry_error"),
                        )?;
                    }
                    executor
                        .gate(task, &gate_scope, &state, &invocation)
                        .await
                        .map_err(|_| mc_store::dream_scheduler::Error::Refused("gate_error"))
                })
                .await,
        ) {
            Ok(lease) => lease,
            Err(reason) => {
                // A closed gate advanced the task's due slot as skipped.
                if reason == "gate_closed" {
                    self.publish_progress(task);
                }
                let _ = self.store.release_dream_domain(&domain);
                return DispatchOutcome::Refused(reason);
            }
        };
        let control = DomainControl::new(
            self.store.clone(),
            self.scheduler.clone(),
            domain.clone(),
            lease.clone(),
            cancellation.clone(),
            self.clock.clone(),
            deadline_ms,
        );
        let mut guard = match LeaseGuard::start(control) {
            Ok(guard) => guard,
            Err(e) => {
                let _ = self.scheduler.abandon(&lease);
                let _ = self.store.release_dream_domain(&domain);
                return DispatchOutcome::Refused(e.to_string());
            }
        };
        let context = TaskContext {
            task,
            scope: self.scope.clone(),
            config: self.config.clone(),
            domain_lease: domain,
            task_lease: lease.clone(),
            cancellation,
            clock: self.clock.clone(),
            deadline_ms,
            control: guard.control.clone(),
        };
        if let Err(error) = context.check_control() {
            return DispatchOutcome::Aborted(error);
        }
        let outcome = match tokio::time::timeout(timeout, self.executor.run(&context)).await {
            Ok(outcome) => outcome,
            Err(_) => return DispatchOutcome::Aborted(super::context::ControlError::Deadline),
        };
        guard.stop();
        if outcome.status == mc_store::dream_scheduler::schedules::RunStatus::Failed
            && outcome
                .error
                .as_deref()
                .is_some_and(|e| e.starts_with(ABANDON_PREFIX))
        {
            // Dropping the unfinished guard abandons the scheduler claim and
            // releases the domain; the schedule row is left as it was.
            return DispatchOutcome::Refused(outcome.error.unwrap_or_default());
        }
        // Exhausting the prompt-token budget stops further tool effects but still
        // records this run's outcome and provider-reported input/cache token count.
        if let Err(error) = context.check_control() {
            if error != super::context::ControlError::BudgetExhausted {
                return DispatchOutcome::Aborted(error);
            }
        }
        let spent = match available(self.scheduler.token_budget(&lease, self.clock.now_ms())) {
            Ok(budget) => budget.spent,
            Err(reason) => return DispatchOutcome::Refused(reason),
        };
        match available(self.scheduler.finish_task(
            &DreamFinishRequest {
                lease,
                now_ms: self.clock.now_ms(),
                spent_tokens: spent,
                succeeded: outcome.status
                    == mc_store::dream_scheduler::schedules::RunStatus::Completed,
            },
            &outcome,
        )) {
            Ok(_) => {
                // The guard still holds the domain lease here; it is released when
                // the guard drops at the end of this function.
                self.publish_progress(task);
                guard.finished();
                DispatchOutcome::Finished(outcome.status)
            }
            Err(reason) => DispatchOutcome::Refused(reason),
        }
    }
}
