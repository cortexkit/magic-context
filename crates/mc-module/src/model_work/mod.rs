//! Placement and outcome accounting for ck-mc's model work.
//!
//! The scoped routing transport and runner lifecycle are injected. Summaries
//! supply them in `historian_routed`; dream runs will supply their own.
// Parts of the engine (concurrency slots, pins, parking shared across work
// orders) are used only by dream runs, which do not call it yet.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{Outcome, ReportAnswer, ReportRequest, Usage},
    select::{ConcurrencySlot, Requirements, SelectRequest},
};

use crate::runner_choices::RoutedChoice;

/// A route already bound to the work's daemon scope stamp. Implementations must
/// use this same stamp for routing and runner calls, never a scope in a body.
pub trait ScopeRoute: Sync {
    /// Stable identity of the daemon scope stamp, including its caller/session/run
    /// binding. Equal keys must authorize reports for the same scoped decisions.
    fn scope_key(&self) -> &str;
    /// Stable project identity for parking work across sessions of that project.
    fn project_key(&self) -> &str;
    fn select(
        &self,
        provider: &str,
        request: &SelectParams,
    ) -> impl Future<Output = Result<RoutedChoice, Refusal>> + Send;
    fn report(
        &self,
        provider: &str,
        request: &ReportRequest,
    ) -> impl Future<Output = Result<ReportAnswer, Refusal>> + Send;
}

/// The published request. Optional hold controls require provider negotiation.
pub type SelectParams = SelectRequest;

/// Bound paid routed work across all sessions and projects in this process.
const ROUTED_WORK_LIMIT: usize = 2;
static ROUTED_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(ROUTED_WORK_LIMIT);

/// Catalog discovery is supplied by the owner of the scoped route, not inferred
/// from runner configuration. Only routing/v1 providers belong in this list.
pub struct RoutingCatalog {
    pub generation: u64,
    pub providers: Vec<String>,
}

pub struct WorkOrder<'a, S> {
    pub scope_route: &'a S,
    pub work_id: String,
    pub consumer: String,
    pub requirements: Requirements,
    pub pin: Option<String>,
    pub affinity: String,
    pub concurrency_slots: Option<Vec<ConcurrencySlot>>,
    pub deadline_ms: u64,
    pub max_decisions: usize,
    /// Sent on every select of this order when set; see [`SelectParams::hold_ok`].
    pub hold_ok: Option<bool>,
}

/// The adapter owns prompt construction, validation/repair and following a send
/// to its terminal outcome. It must send exactly choice.runner (including auth).
/// Limits are available before sending, so callers can size/chunk their input.
pub trait Runner<S>: Sync {
    type Output;
    fn send(
        &self,
        scope: &S,
        choice: &RoutedChoice,
        deadline_ms: u64,
    ) -> impl Future<Output = RunResult<Self::Output>> + Send;
    /// Cancel and settle the selected send before its timeout is reported.
    fn cancel(&self, scope: &S, choice: &RoutedChoice) -> impl Future<Output = ()> + Send;
}

pub struct RunResult<T> {
    pub outcome: Outcome,
    pub output: Option<T>,
    pub runner_code: Option<String>,
    pub credential_id: Option<String>,
    pub reset_at_ms: Option<u64>,
    pub usage: Option<Usage>,
}

impl<T> RunResult<T> {
    pub fn new(outcome: Outcome, output: Option<T>) -> Self {
        Self {
            outcome,
            output,
            runner_code: None,
            credential_id: None,
            reset_at_ms: None,
            usage: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub choice: RoutedChoice,
    pub report: ReportRequest,
}

#[derive(Debug)]
pub struct WorkDone<T> {
    pub output: T,
    pub choice: RoutedChoice,
    pub attempts: Vec<Attempt>,
}

/// Engine codes describe the work; source refusals and runner codes remain
/// untouched in source/attempts for callers and routing's outcome accounting.
#[derive(Clone, Debug)]
pub struct WorkError {
    pub code: &'static str,
    pub source: Option<Box<Refusal>>,
    pub reset_at_ms: Option<u64>,
    pub modules: Vec<String>,
    pub attempts: Vec<Attempt>,
}

impl WorkError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            source: None,
            reset_at_ms: None,
            modules: Vec::new(),
            attempts: Vec::new(),
        }
    }
}

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub struct WallClock;

impl Clock for WallClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

/// Keep accounting retries small during a prolonged routing outage. Reports hold
/// no model output; the oldest accounting entry is sacrificed before paid work.
pub const PENDING_REPORT_CAP: usize = 64;

/// Accounting must not hold paid output hostage to an unresponsive provider.
/// Every report gets at most this budget, or the remaining work deadline if less.
pub const REPORT_TIMEOUT_MS: u64 = 250;
/// An outage must not make each run drain the entire queue before placing work.
/// Three retries cost at most 750 ms, further capped by the work deadline.
pub const MAX_PENDING_REPORT_RETRIES_PER_RUN: usize = 3;

#[derive(Clone, Debug, PartialEq)]
enum ReportFailure {
    Refused(Refusal),
    TimedOut,
}

struct PendingReport {
    provider: String,
    scope_key: String,
    report: ReportRequest,
    source: ReportFailure,
}

/// One boundary for accounting warnings: production emits structured logs, while
/// tests can observe the same emission decisions without a global subscriber.
trait ReportLog: Send + Sync {
    fn unacknowledged(&self, pending: &PendingReport);
    fn evicted(&self, pending: &PendingReport);
}

struct TracingReportLog;

impl ReportLog for TracingReportLog {
    fn unacknowledged(&self, pending: &PendingReport) {
        let code = match &pending.source {
            ReportFailure::Refused(refusal) => refusal.code.to_string(),
            ReportFailure::TimedOut => "mc_route_report_timed_out".to_owned(),
        };
        tracing::warn!(
            decision_id = %pending.report.decision_id,
            routing_provider = %pending.provider,
            scope_key = %pending.scope_key,
            code,
            "model work report unacknowledged; queued for retry"
        );
    }

    fn evicted(&self, pending: &PendingReport) {
        tracing::warn!(
            decision_id = %pending.report.decision_id,
            routing_provider = %pending.provider,
            scope_key = %pending.scope_key,
            "model work pending-report queue full; dropped oldest report"
        );
    }
}

pub struct Engine<C = WallClock> {
    clock: C,
    provider: Option<(u64, Result<String, WorkError>)>,
    parked: HashMap<(String, String), WorkError>,
    misconfigured: HashMap<(String, String), (u64, WorkError)>,
    pending_reports: VecDeque<PendingReport>,
    report_log: Box<dyn ReportLog>,
}

impl<C: Clock> Engine<C> {
    pub fn new(clock: C) -> Self {
        Self {
            clock,
            provider: None,
            parked: HashMap::new(),
            misconfigured: HashMap::new(),
            pending_reports: VecDeque::new(),
            report_log: Box::new(TracingReportLog),
        }
    }

    /// Reports still waiting for routing's acknowledgement. An engine holding
    /// any must be kept, or routing never learns those outcomes.
    pub fn pending_report_count(&self) -> usize {
        self.pending_reports.len()
    }

    fn provider(&mut self, catalog: &RoutingCatalog) -> Result<String, WorkError> {
        if let Some((generation, result)) = &self.provider {
            if *generation == catalog.generation {
                return result.clone();
            }
        }
        let result = match catalog.providers.as_slice() {
            [] => Err(WorkError::new("routing_provider_missing")),
            [provider] => Ok(provider.clone()),
            providers => {
                let mut error = WorkError::new("routing_provider_ambiguous");
                error.modules = providers.to_vec();
                Err(error)
            }
        };
        self.provider = Some((catalog.generation, result.clone()));
        result
    }

    fn queue_report(
        &mut self,
        provider: &str,
        scope_key: &str,
        report: ReportRequest,
        source: ReportFailure,
    ) {
        if self.pending_reports.iter().any(|pending| {
            pending.provider == provider
                && pending.scope_key == scope_key
                && pending.report.decision_id == report.decision_id
        }) {
            return;
        }
        let pending = PendingReport {
            provider: provider.to_owned(),
            scope_key: scope_key.to_owned(),
            report,
            source,
        };
        self.report_log.unacknowledged(&pending);
        if self.pending_reports.len() == PENDING_REPORT_CAP {
            let oldest = self
                .pending_reports
                .pop_front()
                .expect("report queue is full");
            self.report_log.evicted(&oldest);
        }
        self.pending_reports.push_back(pending);
    }

    fn remaining_budget(&self, deadline_ms: u64, deadline: tokio::time::Instant) -> Duration {
        Duration::from_millis(deadline_ms.saturating_sub(self.clock.now_ms()))
            .min(deadline.saturating_duration_since(tokio::time::Instant::now()))
    }

    async fn send_report<S: ScopeRoute>(
        &self,
        provider: &str,
        scope: &S,
        report: &ReportRequest,
        deadline_ms: u64,
        deadline: tokio::time::Instant,
    ) -> Result<ReportAnswer, ReportFailure> {
        let budget = self
            .remaining_budget(deadline_ms, deadline)
            .min(Duration::from_millis(REPORT_TIMEOUT_MS));
        match tokio::time::timeout(budget, scope.report(provider, report)).await {
            Ok(result) => result.map_err(ReportFailure::Refused),
            Err(_) => Err(ReportFailure::TimedOut),
        }
    }

    async fn retry_pending_reports<S: ScopeRoute>(
        &mut self,
        provider: &str,
        scope: &S,
        deadline_ms: u64,
        deadline: tokio::time::Instant,
    ) {
        let mut index = 0;
        let mut retried = 0;
        while index < self.pending_reports.len() && retried < MAX_PENDING_REPORT_RETRIES_PER_RUN {
            if self.remaining_budget(deadline_ms, deadline).is_zero() {
                break;
            }
            let pending = &self.pending_reports[index];
            // Reports are idempotent by decision id. Leave an unacknowledged
            // entry in place across awaits, and log only its initial failure.
            if pending.provider != provider || pending.scope_key != scope.scope_key() {
                index += 1;
                continue;
            }
            retried += 1;
            if self
                .send_report(provider, scope, &pending.report, deadline_ms, deadline)
                .await
                .is_ok()
            {
                self.pending_reports.remove(index);
            } else {
                index += 1;
            }
        }
    }

    pub async fn run<S: ScopeRoute, R: Runner<S>>(
        &mut self,
        catalog: &RoutingCatalog,
        order: &WorkOrder<'_, S>,
        runner: &R,
    ) -> Result<WorkDone<R::Output>, WorkError> {
        let provider = self.provider(catalog)?;
        // Keep a monotonic deadline too, so elapsed report retries consume the
        // same work budget even if the wall clock moves backwards.
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(order.deadline_ms.saturating_sub(self.clock.now_ms()));
        let _permit = tokio::time::timeout_at(deadline, ROUTED_WORK.acquire())
            .await
            .map_err(|_| WorkError::new("mc_run_timed_out"))?
            .expect("routed work semaphore is never closed");
        self.retry_pending_reports(&provider, order.scope_route, order.deadline_ms, deadline)
            .await;
        let key = (
            order.scope_route.project_key().to_owned(),
            order.consumer.clone(),
        );
        if let Some(error) = self.parked.get(&key) {
            if self.clock.now_ms() < error.reset_at_ms.unwrap_or(0) {
                return Err(error.clone());
            }
        }
        self.parked.remove(&key);
        if let Some((generation, error)) = self.misconfigured.get(&key) {
            if *generation == catalog.generation {
                return Err(error.clone());
            }
        }
        self.misconfigured.remove(&key);

        let mut attempts = Vec::new();
        let mut exclude = Vec::new();
        let mut timeouts = 0;
        loop {
            let remaining = self.remaining_budget(order.deadline_ms, deadline);
            if remaining.is_zero() {
                let mut error = WorkError::new("mc_run_timed_out");
                error.attempts = attempts;
                return Err(error);
            }
            if attempts.len() >= order.max_decisions {
                let mut error = WorkError::new("mc_route_exhausted");
                error.attempts = attempts;
                return Err(error);
            }
            let mut request = SelectRequest::new(&order.consumer, order.requirements.clone());
            request.pin = order.pin.clone();
            request.affinity = Some(order.affinity.clone());
            request.correlation_id = Some(order.work_id.clone());
            request.concurrency_slots = order.concurrency_slots.clone();
            if let Some(slots) = &mut request.concurrency_slots {
                for slot in slots.iter_mut().filter(|s| s.key == "mc_dream") {
                    slot.running = (ROUTED_WORK_LIMIT - ROUTED_WORK.available_permits()) as u64;
                    slot.limit = ROUTED_WORK_LIMIT as u64;
                }
            }
            request.exclude = (!exclude.is_empty()).then(|| exclude.clone());
            request.hold_ok = order.hold_ok;
            let params = request;
            let selected =
                tokio::time::timeout(remaining, order.scope_route.select(&provider, &params)).await;
            let choice = match selected {
                Ok(Ok(choice)) => choice,
                Ok(Err(source)) => {
                    let mut error = WorkError::new(match source.code {
                        RefusalCode::InvalidRequirements | RefusalCode::UnknownConsumer => {
                            "mc_route_misconfigured"
                        }
                        RefusalCode::NoRoute if source.wait_until_ms().is_none() => "mc_no_route",
                        _ if source.wait_until_ms().is_some() => "mc_route_waiting",
                        _ => "mc_route_refused",
                    });
                    error.reset_at_ms = source.wait_until_ms();
                    error.source = Some(Box::new(source));
                    // Parking belongs to the project/consumer, not this work's
                    // attempt history; another task must not inherit its sends.
                    if error.reset_at_ms.is_some() {
                        self.parked.insert(key.clone(), error.clone());
                    } else if error.code == "mc_route_misconfigured" {
                        self.misconfigured
                            .insert(key.clone(), (catalog.generation, error.clone()));
                    }
                    error.attempts = attempts;
                    return Err(error);
                }
                Err(_) => {
                    let mut error = WorkError::new("mc_run_timed_out");
                    error.attempts = attempts;
                    return Err(error);
                }
            };

            let remaining = self.remaining_budget(order.deadline_ms, deadline);
            let mut result = if remaining.is_zero() {
                RunResult::new(Outcome::TimedOut, None)
            } else {
                match tokio::time::timeout(
                    remaining,
                    runner.send(order.scope_route, &choice, order.deadline_ms),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => RunResult::new(Outcome::TimedOut, None),
                }
            };
            if result.outcome == Outcome::TimedOut {
                if !remaining.is_zero() {
                    runner.cancel(order.scope_route, &choice).await;
                }
                timeouts += 1;
            }
            // A claimed completion without a validated value is a failed run,
            // not a successful affinity signal.
            if result.outcome == Outcome::Completed && result.output.is_none() {
                result.outcome = Outcome::Failed;
            }
            let mut report = ReportRequest::new(&choice.decision_id, result.outcome.clone());
            report.runner_code = result.runner_code;
            report.credential_id = result.credential_id;
            report.reset_at_ms = result.reset_at_ms;
            report.usage = result.usage;
            attempts.push(Attempt {
                choice: choice.clone(),
                report: report.clone(),
            });
            if let Err(source) = self
                .send_report(
                    &provider,
                    order.scope_route,
                    &report,
                    order.deadline_ms,
                    deadline,
                )
                .await
            {
                self.queue_report(&provider, order.scope_route.scope_key(), report, source);
            }
            if result.outcome == Outcome::Completed {
                return Ok(WorkDone {
                    output: result.output.expect("completed run has validated output"),
                    choice,
                    attempts,
                });
            }
            if result.outcome == Outcome::Cancelled || timeouts >= 2 {
                let mut error = WorkError::new(if result.outcome == Outcome::Cancelled {
                    "mc_run_cancelled"
                } else {
                    "mc_run_timed_out"
                });
                error.attempts = attempts;
                return Err(error);
            }
            // Routing treats unknown outcomes as failures. Exclude the failed
            // route even if routing has not acknowledged its report yet.
            exclude.push(choice.route.route_key());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
