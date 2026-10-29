//! Opt-in scheduler storage, separate from context.db and the serving path.
//!
//! Construct one handle per read-once unit with its captured activation value.
//! This module never reads configuration, starts timers, or executes a task. The
//! runner evaluates domain inputs/gates and supplies them to the methods below.

pub mod budget;
pub mod cron;
mod leases;
pub mod schedules;
pub mod targets;

use crate::parity_schema_manifest::*;
use rusqlite::{Connection, TransactionBehavior};
use schedules::{DueTask, RunOutcome, RunStatus, ScheduleState, TaskConfig, TaskName};
use std::{path::Path, sync::Mutex, time::Duration};

#[derive(Debug)]
pub enum Error {
    Refused(&'static str),
    Storage(rusqlite::Error),
    Json(serde_json::Error),
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Run,
    Skip { code: String },
}

impl From<bool> for GateDecision {
    fn from(run: bool) -> Self {
        if run {
            Self::Run
        } else {
            Self::Skip {
                code: "inputs_unchanged".into(),
            }
        }
    }
}

struct PreparedClaim {
    lease: DreamLease,
    bypass: bool,
    state: ScheduleState,
    prior: Option<ScheduleState>,
    slot: i64,
}
impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value)
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

fn capability<T>(result: Result<T>) -> CapabilityResult<T> {
    match result {
        Ok(value) => CapabilityResult::Available { value },
        Err(error) => CapabilityResult::Unavailable {
            reason: CapabilityReason {
                code: match &error {
                    Error::Refused(code) => code,
                    _ => "scheduler_storage_error",
                }
                .into(),
                message: format!("{error:?}"),
            },
        },
    }
}

/// A durable scheduler in its own SQLite file. The activation value is immutable
/// so a run can finish under the value it captured even if configuration flips.
pub struct SqliteDreamScheduler {
    db: Option<Mutex<Connection>>,
}

impl SqliteDreamScheduler {
    pub fn open(path: impl AsRef<Path>, activated: bool) -> Result<Self> {
        if !activated {
            return Ok(Self { db: None });
        }
        let mut db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let application_id: i64 = tx.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let tables: u64 = tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if application_id != 0x4D434453 && (application_id != 0 || tables != 0) {
            return Err(Error::Refused("not_scheduler_database"));
        }
        tx.execute_batch("PRAGMA application_id=1296254035;
            CREATE TABLE IF NOT EXISTS dream_schedules(project TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(project,task));
            CREATE TABLE IF NOT EXISTS dream_leases(domain TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS dream_runs(project TEXT NOT NULL, invocation TEXT NOT NULL, token TEXT NOT NULL UNIQUE, state TEXT NOT NULL, PRIMARY KEY(project,invocation));
            CREATE TABLE IF NOT EXISTS dream_targets(project TEXT PRIMARY KEY, workdir TEXT NOT NULL, project_id TEXT, seen_at INTEGER NOT NULL);")?;
        tx.commit()?;
        Ok(Self {
            db: Some(Mutex::new(db)),
        })
    }

    fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let db = self
            .db
            .as_ref()
            .ok_or(Error::Refused("activation_off"))?
            .lock()
            .map_err(|_| Error::Refused("scheduler_poisoned"))?;
        f(&db)
    }

    fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut db = self
            .db
            .as_ref()
            .ok_or(Error::Refused("activation_off"))?
            .lock()
            .map_err(|_| Error::Refused("scheduler_poisoned"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// Disabled worktrees do not seed, reconcile, or advance shared schedules.
    /// Input predicates are supplied by the runner; activity gates are separate.
    pub fn plan_due(
        &self,
        scope: &StoreScope,
        configs: &[TaskConfig],
        now: i64,
        project_memory_enabled: bool,
    ) -> CapabilityResult<Vec<DueTask>> {
        if self.db.is_none() || !project_memory_enabled {
            return capability(Ok(Vec::new()));
        }
        capability((|| {
            validate_scope(scope)?;
            let mut prepared = Vec::new();
            for config in configs {
                if config.schedule.trim().is_empty() {
                    continue;
                }
                let candidate = cron::next_due(&config.schedule, now, None)?;
                let repeated = candidate
                    .map(cron::is_repeated)
                    .transpose()?
                    .unwrap_or(false);
                let after = if repeated {
                    cron::next_due(&config.schedule, now, candidate)?
                } else {
                    candidate
                };
                prepared.push((config, candidate, after, repeated));
            }
            self.write(|db| {
                let mut due = Vec::new();
                for (config, candidate, after, repeated) in prepared {
                    let prior = schedules::read(db, &scope.project.0, config.task)?;
                    let Some(mut state) = prior.or_else(|| {
                        config
                            .has_input
                            .then(|| schedules::seeded(config, candidate))
                    }) else {
                        continue;
                    };
                    schedules::reconcile(&mut state, config, candidate, after, repeated);
                    schedules::write(db, &scope.project.0, config.task, &state)?;
                    if let Some(slot) = state.next_due_at.filter(|slot| now >= *slot) {
                        due.push(DueTask {
                            task: config.task,
                            scheduled_at: slot,
                        });
                    }
                }
                // Mapping precedes verification because verification consumes mappings.
                // Keep siblings in the registry order before the runner groups domains.
                due.sort_by_key(|d| schedules::CANONICAL_TASKS.iter().position(|t| *t == d.task));
                due.dedup_by_key(|d| d.task);
                Ok(due)
            })
        })())
    }

    pub fn schedule(
        &self,
        scope: &StoreScope,
        task: TaskName,
    ) -> CapabilityResult<Option<ScheduleState>> {
        capability(self.read(|db| {
            validate_scope(scope)?;
            Ok(schedules::read(db, &scope.project.0, task)?)
        }))
    }

    /// Take over the TypeScript dreamer's progress on a task before planning it.
    ///
    /// The two runtimes keep separate schedule rows, and ownership of a task can
    /// move between them. Without this, a task TypeScript already ran in the
    /// current cron period would look due here again (a second run), and a task
    /// TypeScript had due but not yet run would be seeded at the next slot after
    /// now (a skipped run). When the TypeScript row was computed from the same
    /// schedule and its `next_due_at` is later than this row's, this row moves to
    /// it; an absent row is seeded from it. Returns whether the row changed.
    pub fn adopt_legacy(
        &self,
        scope: &StoreScope,
        config: &TaskConfig,
        legacy: &schedules::LegacySchedule,
    ) -> CapabilityResult<bool> {
        if self.db.is_none() {
            return capability(Ok(false));
        }
        capability((|| {
            validate_scope(scope)?;
            let Some(legacy_next) = legacy.next_due_at.filter(|n| *n > 0) else {
                return Ok(false);
            };
            if config.schedule.trim().is_empty()
                || legacy.schedule.as_deref() != Some(config.schedule.as_str())
            {
                return Ok(false);
            }
            let legacy_last = legacy.last_run_at.filter(|n| *n > 0);
            self.write(|db| {
                let state = match schedules::read(db, &scope.project.0, config.task)? {
                    None => ScheduleState {
                        last_run_at: legacy_last,
                        next_due_at: Some(legacy_next),
                        ..schedules::seeded(config, None)
                    },
                    Some(mut state) => {
                        if state.schedule.as_deref() != Some(config.schedule.as_str())
                            || state.next_due_at.is_none_or(|n| n >= legacy_next)
                        {
                            return Ok(false);
                        }
                        state.next_due_at = Some(legacy_next);
                        state.retry_count = 0;
                        state.last_run_at = state.last_run_at.max(legacy_last);
                        state
                    }
                };
                schedules::write(db, &scope.project.0, config.task, &state)?;
                Ok(true)
            })
        })())
    }

    /// Advance a scheduled slot when an activity check finds no work, without
    /// changing the last successful run's cutoff. The slot comparison prevents a
    /// stale planner from consuming a newer slot.
    pub fn skip_due(
        &self,
        scope: &StoreScope,
        task: TaskName,
        scheduled_at: i64,
        now: i64,
    ) -> CapabilityResult<()> {
        capability((|| {
            let mut state = self.read(|db| {
                validate_scope(scope)?;
                schedules::read(db, &scope.project.0, task)?.ok_or(Error::Refused("not_due"))
            })?;
            let prior = state.clone();
            if prior.next_due_at != Some(scheduled_at) || now < scheduled_at {
                return Err(Error::Refused("not_due"));
            }
            schedules::advance(
                &mut state,
                &RunOutcome::new(RunStatus::Skipped),
                now,
                now,
                scheduled_at,
            )?;
            self.write(|db| {
                if schedules::read(db, &scope.project.0, task)?.as_ref() != Some(&prior) {
                    return Err(Error::Refused("schedule_changed"));
                }
                schedules::write(db, &scope.project.0, task, &state)?;
                Ok(())
            })
        })())
    }

    /// Use the canonical task name when selecting verify-broad, promote-primers,
    /// or refresh-primers: BackgroundTask groups these with verify or primers.
    /// `manual` supplies the schedule for a forced run, even if disabled. Claiming
    /// never waits for a busy lease; the off-thread runner drives ManualLeaseWait.
    pub fn claim_task(
        &self,
        request: &DreamClaimRequest,
        task: TaskName,
        manual: Option<&TaskConfig>,
        gate: impl FnOnce(&ScheduleState) -> bool,
    ) -> CapabilityResult<DreamLease> {
        self.claim_task_checked(request, task, manual, |state| Ok(gate(state)))
    }

    /// A failed gate read is an error, not a skip. No SQLite lock is held while
    /// evaluating the gate, including the asynchronous project-context read.
    pub fn claim_task_checked(
        &self,
        request: &DreamClaimRequest,
        task: TaskName,
        manual: Option<&TaskConfig>,
        gate: impl FnOnce(&ScheduleState) -> Result<bool>,
    ) -> CapabilityResult<DreamLease> {
        capability((|| {
            let prepared = self.prepare_claim(request, task, manual)?;
            let result = if prepared.bypass {
                Ok(GateDecision::Run)
            } else {
                // The compatibility callback has no named skip reason. New
                // executors use the asynchronous API's explicit skip code.
                gate(&prepared.state).map(|run| {
                    if run {
                        GateDecision::Run
                    } else {
                        GateDecision::Skip {
                            code: String::new(),
                        }
                    }
                })
            };
            self.resolve_gate(request, task, prepared, result)
        })())
    }

    pub async fn claim_task_checked_async<F: std::future::Future<Output = Result<GateDecision>>>(
        &self,
        request: &DreamClaimRequest,
        task: TaskName,
        manual: Option<&TaskConfig>,
        gate: impl FnOnce(ScheduleState, DreamLease) -> F,
    ) -> CapabilityResult<DreamLease> {
        let prepared = match self.prepare_claim(request, task, manual) {
            Ok(value) => value,
            Err(error) => return capability(Err(error)),
        };
        let result = if prepared.bypass {
            Ok(GateDecision::Run)
        } else {
            gate(prepared.state.clone(), prepared.lease.clone()).await
        };
        capability(self.resolve_gate(request, task, prepared, result))
    }

    fn prepare_claim(
        &self,
        request: &DreamClaimRequest,
        task: TaskName,
        manual: Option<&TaskConfig>,
    ) -> Result<PreparedClaim> {
        (|| {
            let mut prior = self.read(|db| {
                validate_scope(&request.scope)?;
                if request.invocation.0.trim().is_empty()
                    || !task.matches(&request.task)
                    || request.domain != task.lease_key(&request.scope.project.0)
                {
                    return Err(Error::Refused("invalid_claim"));
                }
                if request.manual_force != manual.is_some()
                    || manual.is_some_and(|c| c.task != task)
                {
                    return Err(Error::Refused("invalid_manual_claim"));
                }
                Ok(schedules::read(db, &request.scope.project.0, task)?)
            })?;
            if let Some(config) = manual.filter(|config| config.has_input && prior.is_none()) {
                let candidate = cron::next_due(&config.schedule, request.now_ms, None)?;
                prior = self.write(|db| {
                    // Manual requests seed existing input before attempting the
                    // lease, so a busy request still arms the next scheduled slot.
                    let state = schedules::read(db, &request.scope.project.0, task)?
                        .unwrap_or_else(|| schedules::seeded(config, candidate));
                    schedules::write(db, &request.scope.project.0, task, &state)?;
                    Ok(Some(state))
                })?;
            }
            let state = if let Some(config) = manual {
                prior
                    .clone()
                    .unwrap_or_else(|| schedules::seeded(config, None))
            } else {
                prior.clone().ok_or(Error::Refused("not_due"))?
            };
            let slot = if request.manual_force {
                request.now_ms
            } else {
                state
                    .next_due_at
                    .filter(|slot| request.now_ms >= *slot)
                    .ok_or(Error::Refused("not_due"))?
            };
            let (lease, existing) = self.write(|db| {
                if request.invocation.0.trim().is_empty()
                    || !task.matches(&request.task)
                    || request.domain != task.lease_key(&request.scope.project.0)
                {
                    return Err(Error::Refused("invalid_claim"));
                }
                if request.manual_force != manual.is_some()
                    || manual.is_some_and(|c| c.task != task)
                {
                    return Err(Error::Refused("invalid_manual_claim"));
                }
                if schedules::read(db, &request.scope.project.0, task)? != prior {
                    return Err(Error::Refused("schedule_changed"));
                }
                let existing =
                    leases::by_invocation(db, &request.scope.project.0, &request.invocation.0)?
                        .is_some();
                let lease = leases::acquire(db, request, task, slot)?;
                if request.manual_force && !existing {
                    let mut state = state.clone();
                    state.schedule = manual.map(|c| c.schedule.clone());
                    schedules::write(db, &request.scope.project.0, task, &state)?;
                }
                Ok((lease, existing))
            })?;
            Ok(PreparedClaim {
                lease,
                bypass: existing || request.manual_force,
                state,
                prior,
                slot,
            })
        })()
    }

    fn resolve_gate(
        &self,
        request: &DreamClaimRequest,
        task: TaskName,
        prepared: PreparedClaim,
        gate_result: Result<GateDecision>,
    ) -> Result<DreamLease> {
        let PreparedClaim {
            lease,
            state,
            prior,
            slot,
            ..
        } = prepared;
        match gate_result {
            Ok(GateDecision::Run) => Ok(lease),
            Ok(GateDecision::Skip { code }) => {
                let mut skipped = state.clone();
                let mut outcome = RunOutcome::new(RunStatus::Skipped);
                outcome.last_skip_code = (!code.is_empty()).then_some(code);
                schedules::advance(&mut skipped, &outcome, request.now_ms, request.now_ms, slot)?;
                let result = self.write(|db| {
                    let run = leases::owned(db, &lease, request.now_ms, false)?;
                    if schedules::read(db, &request.scope.project.0, task)? != prior {
                        return Err(Error::Refused("schedule_changed"));
                    }
                    schedules::write(db, &request.scope.project.0, task, &skipped)?;
                    leases::release(db, &run)?;
                    db.execute(
                        "DELETE FROM dream_runs WHERE project=?1 AND invocation=?2",
                        rusqlite::params![request.scope.project.0, request.invocation.0],
                    )?;
                    Ok(())
                });
                if result.is_err() {
                    let _ = self.abandon_claim(&lease);
                }
                result?;
                Err(Error::Refused("gate_closed"))
            }
            Err(error) => {
                self.abandon_claim(&lease)?;
                Err(error)
            }
        }
    }

    /// Release a cancelled run without advancing its schedule. A delayed caller
    /// cannot release a successor's token. The runner also uses this on gate errors.
    pub fn abandon(&self, lease: &DreamLease) -> CapabilityResult<()> {
        capability(self.abandon_claim(lease))
    }

    fn abandon_claim(&self, lease: &DreamLease) -> Result<()> {
        self.write(|db| {
            let run = leases::owned(db, lease, i64::MIN, true)?;
            leases::release(db, &run)?;
            db.execute(
                "DELETE FROM dream_runs WHERE project=?1 AND invocation=?2",
                rusqlite::params![lease.scope.project.0, lease.invocation.0],
            )?;
            Ok(())
        })
    }

    pub fn finish_task(
        &self,
        request: &DreamFinishRequest,
        outcome: &RunOutcome,
    ) -> CapabilityResult<PublishReceipt> {
        capability((|| {
            let (run, mut state) = self.read(|db| {
                let run = leases::owned(db, &request.lease, request.now_ms, false)?;
                let state = schedules::read(db, &run.lease.scope.project.0, run.task)?
                    .ok_or(Error::Refused("schedule_missing"))?;
                Ok((run, state))
            })?;
            let prior = state.clone();
            // Cron search may scan years. Do it before acquiring the write lock.
            schedules::advance(
                &mut state,
                outcome,
                run.started_at,
                request.now_ms,
                run.scheduled_at,
            )?;
            self.write(|db| {
                let mut run = leases::owned(db, &request.lease, request.now_ms, false)?;
                if schedules::read(db, &run.lease.scope.project.0, run.task)?.as_ref()
                    != Some(&prior)
                {
                    return Err(Error::Refused("schedule_changed"));
                }
                schedules::write(db, &run.lease.scope.project.0, run.task, &state)?;
                run.finished = true;
                run.spent_tokens = request.spent_tokens;
                leases::release(db, &run)?;
                leases::save(db, &run)?;
                Ok(PublishReceipt {
                    generation: request.lease.scope.generation,
                    accepted_source_ids: vec![request.lease.invocation.0.clone()],
                })
            })
        })())
    }

    pub fn update_budget<T>(
        &self,
        lease: &DreamLease,
        now: i64,
        update: impl FnOnce(&mut budget::TokenBudget) -> std::result::Result<T, &'static str>,
    ) -> CapabilityResult<T> {
        capability(self.write(|db| {
            let mut run = leases::owned(db, lease, now, false)?;
            let result = update(&mut run.budget).map_err(Error::Refused)?;
            leases::save(db, &run)?;
            Ok(result)
        }))
    }

    pub fn token_budget(
        &self,
        lease: &DreamLease,
        now: i64,
    ) -> CapabilityResult<budget::TokenBudget> {
        capability(self.read(|db| Ok(leases::owned(db, lease, now, false)?.budget)))
    }
}

fn validate_scope(scope: &StoreScope) -> Result<()> {
    if scope.project.0.trim().is_empty() || scope.session.0.trim().is_empty() {
        return Err(Error::Refused("invalid_scope"));
    }
    Ok(())
}

impl DreamSchedulerStore for SqliteDreamScheduler {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn claim(&self, request: &DreamClaimRequest) -> CapabilityResult<DreamLease> {
        let Some(task) = TaskName::from_background(&request.task) else {
            return CapabilityResult::unavailable("dream_task");
        };
        if request.manual_force {
            let config = match self.schedule(&request.scope, task) {
                CapabilityResult::Available { value } => TaskConfig {
                    task,
                    schedule: value.and_then(|s| s.schedule).unwrap_or_default(),
                    has_input: false,
                    legacy_last_run_at: None,
                },
                CapabilityResult::Unavailable { reason } => {
                    return CapabilityResult::Unavailable { reason }
                }
                _ => unreachable!(),
            };
            self.claim_task(request, task, Some(&config), |_| true)
        } else {
            self.claim_task(request, task, None, |_| true)
        }
    }
    fn heartbeat(&self, lease: &DreamLease, now_ms: i64) -> CapabilityResult<DreamLease> {
        capability(self.write(|db| leases::heartbeat(db, lease, now_ms)))
    }
    fn finish(&self, request: &DreamFinishRequest) -> CapabilityResult<PublishReceipt> {
        self.finish_task(
            request,
            &RunOutcome::new(if request.succeeded {
                RunStatus::Completed
            } else {
                RunStatus::Failed
            }),
        )
    }
}

pub struct UnavailableDreamScheduler;
pub static UNAVAILABLE: UnavailableDreamScheduler = UnavailableDreamScheduler;

impl DreamSchedulerStore for UnavailableDreamScheduler {
    fn availability(&self) -> Availability {
        unavailable("dream_scheduler")
    }

    fn claim(&self, _: &DreamClaimRequest) -> CapabilityResult<DreamLease> {
        CapabilityResult::unavailable("dream_scheduler")
    }

    fn heartbeat(&self, _: &DreamLease, _: i64) -> CapabilityResult<DreamLease> {
        CapabilityResult::unavailable("dream_scheduler")
    }

    fn finish(&self, _: &DreamFinishRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("dream_scheduler")
    }
}

#[cfg(test)]
mod tests;
