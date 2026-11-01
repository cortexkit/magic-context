//! Process-wide admission for background provider historians. A queued task owns
//! no decoded transcript, conversation mutex guard, or resident-cache lease.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::time::Instant;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MIB: usize = 1024 * 1024;

pub(crate) struct Budget {
    slots: Arc<Semaphore>,
    memory: Arc<Semaphore>,
    limit_mb: usize,
    concurrency: usize,
    queued: AtomicU64,
    active: AtomicU64,
    peak_active: AtomicU64,
    charged_mb: AtomicU64,
    peak_charged_mb: AtomicU64,
    completed: AtomicU64,
    queue_us: AtomicU64,
    max_queue_us: AtomicU64,
}

pub(crate) struct Permit {
    budget: Arc<Budget>,
    charge: u64,
    _slots: OwnedSemaphorePermit,
    _memory: OwnedSemaphorePermit,
}

struct Waiting<'a>(&'a AtomicU64);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Budget {
    pub(crate) fn process() -> Arc<Self> {
        static PROCESS: OnceLock<Arc<Budget>> = OnceLock::new();
        Arc::clone(PROCESS.get_or_init(|| {
            let (concurrency, memory_mb) = crate::config::user_provider_historian_budget();
            Self::new(concurrency, memory_mb)
        }))
    }

    pub(crate) fn new(concurrency: usize, memory_mb: usize) -> Arc<Self> {
        let concurrency = concurrency.clamp(1, 64);
        let memory_mb = memory_mb.clamp(32, 4096);
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(concurrency)),
            memory: Arc::new(Semaphore::new(memory_mb)),
            concurrency,
            limit_mb: memory_mb,
            queued: AtomicU64::new(0),
            active: AtomicU64::new(0),
            peak_active: AtomicU64::new(0),
            charged_mb: AtomicU64::new(0),
            peak_charged_mb: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            queue_us: AtomicU64::new(0),
            max_queue_us: AtomicU64::new(0),
        })
    }

    pub(crate) async fn acquire(self: &Arc<Self>, native_bytes: usize) -> Arc<Permit> {
        let start = Instant::now();
        self.queued.fetch_add(1, Ordering::Relaxed);
        let waiting = Waiting(&self.queued);
        // Reserve 128 times the stored JSON size for owned JSON, tool-call/result
        // expansion, projection and decoder scratch, plus 32 MiB for prompt
        // context. This is conservative accounting, not a heap-allocation cap.
        // Saturating at the entire memory pool lets oversized ranges run alone;
        // requesting more semaphore permits than exist would wait forever.
        let charge = native_bytes
            .saturating_mul(128)
            .div_ceil(MIB)
            .saturating_add(32)
            .min(self.limit_mb) as u32;
        let slots = Arc::clone(&self.slots)
            .acquire_owned()
            .await
            .expect("historian slots open");
        let memory = Arc::clone(&self.memory)
            .acquire_many_owned(charge)
            .await
            .expect("historian memory open");
        drop(waiting);
        self.admit(slots, memory, charge, start)
    }

    /// Explicit requests refuse a full budget instead of queueing behind other
    /// conversations while their caller waits for admission.
    pub(crate) fn try_acquire(self: &Arc<Self>, native_bytes: usize) -> Option<Arc<Permit>> {
        let start = Instant::now();
        let charge = native_bytes
            .saturating_mul(128)
            .div_ceil(MIB)
            .saturating_add(32)
            .min(self.limit_mb) as u32;
        let slots = Arc::clone(&self.slots).try_acquire_owned().ok()?;
        let memory = Arc::clone(&self.memory)
            .try_acquire_many_owned(charge)
            .ok()?;
        Some(self.admit(slots, memory, charge, start))
    }

    fn admit(
        self: &Arc<Self>,
        slots: OwnedSemaphorePermit,
        memory: OwnedSemaphorePermit,
        charge: u32,
        start: Instant,
    ) -> Arc<Permit> {
        let delay = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.queue_us.fetch_add(delay, Ordering::Relaxed);
        self.max_queue_us.fetch_max(delay, Ordering::Relaxed);
        let active = self.active.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_active.fetch_max(active, Ordering::Relaxed);
        let charged = self.charged_mb.fetch_add(charge as u64, Ordering::Relaxed) + charge as u64;
        self.peak_charged_mb.fetch_max(charged, Ordering::Relaxed);
        tracing::info!(
            queue_ms = delay as f64 / 1000.0,
            active,
            charged_mb = charged,
            concurrency = self.concurrency,
            memory_mb = self.limit_mb,
            "provider historian admitted"
        );
        Arc::new(Permit {
            budget: Arc::clone(self),
            charge: charge as u64,
            _slots: slots,
            _memory: memory,
        })
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> serde_json::Value {
        serde_json::json!({"concurrency":self.concurrency,"memory_mb":self.limit_mb,
            "queued":self.queued.load(Ordering::Relaxed),"active":self.active.load(Ordering::Relaxed),
            "peak_active":self.peak_active.load(Ordering::Relaxed),
            "charged_mb":self.charged_mb.load(Ordering::Relaxed),"peak_charged_mb":self.peak_charged_mb.load(Ordering::Relaxed),
            "completed":self.completed.load(Ordering::Relaxed),"queue_total_ms":self.queue_us.load(Ordering::Relaxed) as f64 / 1000.0,
            "queue_max_ms":self.max_queue_us.load(Ordering::Relaxed) as f64 / 1000.0})
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.budget.active.fetch_sub(1, Ordering::Relaxed);
        self.budget
            .charged_mb
            .fetch_sub(self.charge, Ordering::Relaxed);
        self.budget.completed.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_admission_refuses_capacity_without_leaking_a_slot() {
        for (slots, memory) in [(1, 128), (2, 32)] {
            let budget = Budget::new(slots, memory);
            let held = budget.acquire(0).await;
            assert!(budget.try_acquire(0).is_none());
            assert_eq!(budget.stats()["queued"], 0);
            drop(held);
            let admitted = budget.try_acquire(0).expect("capacity was released");
            drop(admitted);
            assert_eq!(budget.stats()["active"], 0);
            assert_eq!(budget.stats()["charged_mb"], 0);
        }
    }

    #[tokio::test]
    async fn concurrency_and_memory_limits_queue_across_sessions() {
        for (slots, memory, bytes) in [(2, 512, 0), (8, 64, 1024 * 1024)] {
            let budget = Budget::new(slots, memory);
            let first = budget.acquire(bytes).await;
            let second = if slots == 2 {
                Some(budget.acquire(bytes).await)
            } else {
                None
            };
            let next_budget = Arc::clone(&budget);
            let next = tokio::spawn(async move { next_budget.acquire(bytes).await });
            tokio::task::yield_now().await;
            assert_eq!(budget.stats()["queued"], 1);
            assert_eq!(budget.stats()["active"], if slots == 2 { 2 } else { 1 });
            assert!(
                !next.is_finished(),
                "another session must wait for the process budget"
            );
            drop(first);
            let permit = tokio::time::timeout(std::time::Duration::from_secs(2), next)
                .await
                .unwrap()
                .unwrap();
            assert!(budget.stats()["peak_active"].as_u64().unwrap() <= slots as u64);
            assert!(budget.stats()["peak_charged_mb"].as_u64().unwrap() <= memory as u64);
            drop((permit, second));
            assert_eq!(budget.stats()["active"], 0);
        }
    }

    #[tokio::test]
    async fn cancelled_waiter_releases_queue_and_blocking_owner_keeps_permit() {
        let budget = Budget::new(1, 64);
        let permit = budget.acquire(0).await;
        let blocking_owner = Arc::clone(&permit);
        let next_budget = Arc::clone(&budget);
        let next = tokio::spawn(async move { next_budget.acquire(0).await });
        tokio::task::yield_now().await;
        next.abort();
        assert!(next.await.err().unwrap().is_cancelled());
        assert_eq!(budget.stats()["queued"], 0);
        drop(permit);
        assert_eq!(budget.stats()["active"], 1);
        drop(blocking_owner);
        assert_eq!(budget.stats()["active"], 0);
    }
}
