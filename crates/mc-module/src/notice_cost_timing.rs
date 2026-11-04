//! Opt-in CPU attribution for the in-process notice measurement, not telemetry.

#[cfg(all(feature = "notice-cost-timing", target_os = "linux"))]
mod enabled {
    use std::cell::RefCell;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static SAMPLES: Mutex<Vec<Sample>> = Mutex::new(Vec::new());
    thread_local! {
        static STACK: RefCell<Vec<(u64, u64)>> = const { RefCell::new(Vec::new()) };
    }

    #[derive(Debug, serde::Serialize)]
    pub struct Sample {
        pub stage: &'static str,
        pub cpu_us: u64,
        pub exclusive_us: u64,
        pub observed: Option<u64>,
    }

    fn cpu() -> u64 {
        // Each synchronous stage stays on its calling thread. Thread CPU lets
        // work be attributed to its calling thread, including the independent
        // phone/desktop read-projection thread.
        use nix::sys::resource::{getrusage, UsageWho};
        use nix::sys::time::TimeValLike;
        let usage = getrusage(UsageWho::RUSAGE_THREAD).expect("thread CPU usage");
        (usage.user_time().num_microseconds() + usage.system_time().num_microseconds()) as u64
    }

    pub fn begin() {
        SAMPLES.lock().unwrap().clear();
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
            });
        }
    }

    pub struct Span(Option<&'static str>);

    pub fn span(stage: &'static str) -> Span {
        if ACTIVE.load(Ordering::Relaxed) {
            STACK.with(|s| s.borrow_mut().push((cpu(), 0)));
            Span(Some(stage))
        } else {
            Span(None)
        }
    }

    impl Drop for Span {
        fn drop(&mut self) {
            let Some(stage) = self.0 else { return };
            let end = cpu();
            let (total, exclusive) = STACK.with(|s| {
                let mut s = s.borrow_mut();
                let (start, children) = s.pop().expect("balanced timing stages");
                let total = end.saturating_sub(start);
                if let Some(parent) = s.last_mut() {
                    parent.1 += total;
                }
                (total, total.saturating_sub(children))
            });
            SAMPLES.lock().unwrap().push(Sample {
                stage,
                cpu_us: total,
                exclusive_us: exclusive,
                observed: None,
            });
        }
    }
}

#[cfg(all(feature = "notice-cost-timing", target_os = "linux"))]
pub use enabled::*;

#[cfg(not(all(feature = "notice-cost-timing", target_os = "linux")))]
pub struct Span;

#[cfg(not(all(feature = "notice-cost-timing", target_os = "linux")))]
#[inline(always)]
pub fn span(_: &'static str) -> Span {
    Span
}
