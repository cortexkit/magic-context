//! Opt-in CPU attribution for the in-process notice measurement, not telemetry.

#[cfg(all(feature = "notice-cost-timing", target_os = "linux"))]
mod enabled {
    use std::cell::RefCell;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static SAMPLES: Mutex<Vec<Sample>> = Mutex::new(Vec::new());
    thread_local! {
        static STACK: RefCell<Vec<(u64, u64, (u64, u64), (u64, u64))>> = const { RefCell::new(Vec::new()) };
    }

    #[derive(Debug, serde::Serialize)]
    pub struct Sample {
        pub stage: &'static str,
        pub cpu_us: u64,
        pub exclusive_us: u64,
        pub observed: Option<u64>,
        pub allocations: u64,
        pub bytes: u64,
        pub exclusive_allocations: u64,
        pub exclusive_bytes: u64,
    }

    static ALLOCATIONS: OnceLock<fn() -> (u64, u64)> = OnceLock::new();

    /// The measurement executable owns its allocator. Reading its counters
    /// here attributes exact calls to the same nested stages as CPU samples.
    pub fn allocation_reader(reader: fn() -> (u64, u64)) {
        let _ = ALLOCATIONS.set(reader);
    }

    fn allocations() -> (u64, u64) {
        ALLOCATIONS.get().map_or((0, 0), |reader| reader())
    }

    fn cpu() -> u64 {
        // Each synchronous stage stays on its calling thread. Thread CPU lets
        // work be attributed to its calling thread, including the independent
        // phone/desktop read-projection thread.
        use nix::time::{clock_gettime, ClockId};
        let time = clock_gettime(ClockId::CLOCK_THREAD_CPUTIME_ID).expect("thread CPU clock");
        time.tv_sec() as u64 * 1_000_000_000 + time.tv_nsec() as u64
    }

    pub fn begin() {
        SAMPLES.lock().unwrap().clear();
        SAMPLES.lock().unwrap().reserve(100_000);
        STACK.with(|stack| stack.borrow_mut().reserve(32));
        ACTIVE.store(true, Ordering::SeqCst);
    }

    pub fn take() -> Vec<Sample> {
        ACTIVE.store(false, Ordering::SeqCst);
        std::mem::take(&mut *SAMPLES.lock().unwrap())
    }

    pub fn observe(stage: &'static str, value: u64) {
        if ACTIVE.load(Ordering::Relaxed) {
            SAMPLES.lock().unwrap().push(Sample {
                stage,
                cpu_us: 0,
                exclusive_us: 0,
                observed: Some(value),
                allocations: 0,
                bytes: 0,
                exclusive_allocations: 0,
                exclusive_bytes: 0,
            });
        }
    }

    pub struct Span(Option<&'static str>);

    pub fn span(stage: &'static str) -> Span {
        if ACTIVE.load(Ordering::Relaxed) {
            STACK.with(|s| s.borrow_mut().push((cpu(), 0, allocations(), (0, 0))));
            Span(Some(stage))
        } else {
            Span(None)
        }
    }

    impl Drop for Span {
        fn drop(&mut self) {
            let Some(stage) = self.0 else { return };
            let end = cpu();
            let allocation_end = allocations();
            let (total, exclusive, allocated, own) = STACK.with(|s| {
                let mut s = s.borrow_mut();
                let (start, children, allocation_start, child_allocations) =
                    s.pop().expect("balanced timing stages");
                let total = end.saturating_sub(start);
                let allocated = (
                    allocation_end.0 - allocation_start.0,
                    allocation_end.1 - allocation_start.1,
                );
                if let Some(parent) = s.last_mut() {
                    parent.1 += total;
                    parent.3 .0 += allocated.0;
                    parent.3 .1 += allocated.1;
                }
                (
                    total,
                    total.saturating_sub(children),
                    allocated,
                    (
                        allocated.0 - child_allocations.0,
                        allocated.1 - child_allocations.1,
                    ),
                )
            });
            SAMPLES.lock().unwrap().push(Sample {
                stage,
                cpu_us: total / 1_000,
                exclusive_us: exclusive / 1_000,
                observed: None,
                allocations: allocated.0,
                bytes: allocated.1,
                exclusive_allocations: own.0,
                exclusive_bytes: own.1,
            });
        }
    }
}

#[cfg(all(feature = "notice-cost-timing", target_os = "linux"))]
pub use enabled::*;

#[cfg(not(all(feature = "notice-cost-timing", target_os = "linux")))]
pub struct Span;

#[cfg(not(all(feature = "notice-cost-timing", target_os = "linux")))]
impl Drop for Span {
    #[inline(always)]
    fn drop(&mut self) {}
}

#[cfg(not(all(feature = "notice-cost-timing", target_os = "linux")))]
#[inline(always)]
pub fn span(_: &'static str) -> Span {
    Span
}
