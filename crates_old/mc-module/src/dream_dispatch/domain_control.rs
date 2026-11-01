//! Run control shared by task hosts and transports, with no database lock across await.

use super::context::{Cancellation, Clock, ControlError, TaskControl};
use crate::dream_runner::Usage;
use mc_store::dream_domain::{DreamDomainLease, HEARTBEAT_INTERVAL_MS};
use mc_store::dream_scheduler::{budget::BudgetAction, SqliteDreamScheduler};
use mc_store::parity_schema_manifest::{CapabilityResult, DreamLease, DreamSchedulerStore};
use mc_store::McStore;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis().min(i64::MAX as u128) as i64)
    }
}

pub(crate) fn available<T>(result: CapabilityResult<T>) -> Result<T, String> {
    match result {
        CapabilityResult::Available { value } => Ok(value),
        CapabilityResult::Unavailable { reason } | CapabilityResult::Degraded { reason, .. } => {
            Err(reason.code)
        }
    }
}

pub struct DomainControl {
    store: Arc<McStore>,
    scheduler: Arc<SqliteDreamScheduler>,
    domain: DreamDomainLease,
    task: DreamLease,
    cancellation: Cancellation,
    clock: Arc<dyn Clock>,
    deadline_ms: i64,
    lost: AtomicBool,
    messages: Mutex<HashSet<String>>,
}

impl DomainControl {
    pub fn new(
        store: Arc<McStore>,
        scheduler: Arc<SqliteDreamScheduler>,
        domain: DreamDomainLease,
        task: DreamLease,
        cancellation: Cancellation,
        clock: Arc<dyn Clock>,
        deadline_ms: i64,
    ) -> Self {
        Self {
            store,
            scheduler,
            domain,
            task,
            cancellation,
            clock,
            deadline_ms,
            lost: AtomicBool::new(false),
            messages: Mutex::new(HashSet::new()),
        }
    }

    fn check_live(&self) -> Result<(), ControlError> {
        if self.cancellation.is_cancelled() {
            return Err(ControlError::Cancelled);
        }
        let now = self.clock.now_ms();
        if now >= self.deadline_ms {
            return Err(ControlError::Deadline);
        }
        if self.lost.load(Ordering::Acquire) {
            return Err(ControlError::LeaseLost);
        }
        match self.store.owns_dream_domain(&self.domain, now) {
            Ok(true) => {}
            Ok(false) => return Err(ControlError::LeaseLost),
            Err(e) => return Err(ControlError::Storage(e.to_string())),
        }
        available(self.scheduler.token_budget(&self.task, now))
            .map_err(|_| ControlError::LeaseLost)?;
        Ok(())
    }

    /// Renew the context.db domain and separate scheduler task lease without
    /// nesting locks. Any refusal permanently revokes this run's write permission;
    /// renewing the other lease cannot restore it.
    pub fn heartbeat(&self) -> Result<(), ControlError> {
        let result = (|| {
            self.check_live()?;
            let now = self.clock.now_ms();
            if !self
                .store
                .renew_dream_domain(&self.domain, now)
                .map_err(|e| ControlError::Storage(e.to_string()))?
            {
                return Err(ControlError::LeaseLost);
            }
            available(self.scheduler.heartbeat(&self.task, now))
                .map_err(|_| ControlError::LeaseLost)?;
            Ok(())
        })();
        if result.is_err() {
            self.lost.store(true, Ordering::Release);
        }
        result
    }
}

impl TaskControl for DomainControl {
    fn check_control(&self) -> Result<(), ControlError> {
        self.check_live()?;
        let budget = available(self.scheduler.token_budget(&self.task, self.clock.now_ms()))
            .map_err(|_| ControlError::LeaseLost)?;
        if budget.hard_stopped() {
            Err(ControlError::BudgetExhausted)
        } else {
            Ok(())
        }
    }

    fn charge_usage(
        &self,
        message_id: &str,
        usage: &Usage,
        completed: bool,
        can_finalize: bool,
    ) -> Result<BudgetAction, ControlError> {
        self.check_live()?;
        let mut messages = self.messages.lock().map_err(|_| ControlError::LeaseLost)?;
        if message_id.is_empty() || message_id.len() > 4096 {
            return Err(ControlError::BudgetExhausted);
        }
        if messages.contains(message_id) {
            return Ok(BudgetAction::Continue);
        }
        if messages.len() >= 4096 {
            return Err(ControlError::BudgetExhausted);
        }
        let action = available(self.scheduler.update_budget(
            &self.task,
            self.clock.now_ms(),
            |b| {
                b.charge(
                    usage.input,
                    usage.cache_read,
                    usage.cache_write,
                    completed,
                    can_finalize,
                )
            },
        ))
        .map_err(ControlError::Storage)?;
        messages.insert(message_id.into());
        Ok(action)
    }

    fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError> {
        self.check_live()?;
        available(
            self.scheduler
                .update_budget(&self.task, self.clock.now_ms(), |b| Ok(b.refuse_tool())),
        )
        .map_err(ControlError::Storage)
    }
}

/// Own the renewal worker for exactly one acquired run. Drop also covers a
/// cancelled future or panic: stop renewal, abandon the scheduler, release domain.
pub(crate) struct LeaseGuard {
    pub control: Arc<DomainControl>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
    finished: bool,
}

impl LeaseGuard {
    pub fn start(control: DomainControl) -> std::io::Result<Self> {
        let control = Arc::new(control);
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_control = control.clone();
        let worker_stop = stop.clone();
        let worker = std::thread::Builder::new()
            .name("mc-dream-domain".into())
            .spawn(move || {
                let (lock, wake) = &*worker_stop;
                let Ok(mut stopped) = lock.lock() else { return };
                while !*stopped {
                    let Ok((next, _)) =
                        wake.wait_timeout(stopped, Duration::from_millis(HEARTBEAT_INTERVAL_MS))
                    else {
                        return;
                    };
                    stopped = next;
                    if *stopped {
                        break;
                    }
                    drop(stopped);
                    if worker_control.heartbeat().is_err() {
                        break;
                    }
                    let Ok(next) = lock.lock() else { return };
                    stopped = next;
                }
            })?;
        Ok(Self {
            control,
            stop,
            worker: Some(worker),
            finished: false,
        })
    }

    pub fn stop(&mut self) {
        let (lock, wake) = &*self.stop;
        if let Ok(mut stopped) = lock.lock() {
            *stopped = true;
            wake.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    pub fn finished(&mut self) {
        self.finished = true;
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        self.stop();
        if !self.finished {
            let _ = self.control.scheduler.abandon(&self.control.task);
        }
        let _ = self
            .control
            .store
            .release_dream_domain(&self.control.domain);
    }
}
