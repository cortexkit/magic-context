//! Opt-in thread CPU clocks for test-only performance checks.
//!
//! Spans are inclusive, just like the production wall timers. A current-thread
//! Tokio runtime is required: thread CPU would be meaningless across migration.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use cpu_time::ThreadTime;
use serde::Serialize;

#[derive(Clone, Copy, Default, Serialize)]
pub(crate) struct Cost {
    pub wall_ms: f64,
    pub thread_cpu_ms: f64,
    pub calls: u64,
}

thread_local! {
    static COSTS: RefCell<Option<BTreeMap<&'static str, Cost>>> = const { RefCell::new(None) };
}

pub(crate) fn begin_pass() {
    COSTS.with(|costs| *costs.borrow_mut() = Some(BTreeMap::new()));
}

pub(crate) fn end_pass() -> BTreeMap<&'static str, Cost> {
    COSTS.with(|costs| costs.borrow_mut().take().expect("profiling pass active"))
}

// `ThreadTime` is deliberately !Send, and spans live across awaits in the
// transform handler, so a span keeps the thread clock's reading as a plain
// `Duration`. Callers must use a current-thread runtime to read start and end on
// the same thread.
pub(crate) struct Span {
    name: &'static str,
    wall: Instant,
    cpu_start: Duration,
}

pub(crate) fn start(name: &'static str) -> Option<Span> {
    COSTS.with(|costs| {
        costs.borrow().as_ref().map(|_| Span {
            name,
            wall: Instant::now(),
            cpu_start: ThreadTime::now().as_duration(),
        })
    })
}

pub(crate) fn finish(span: Option<Span>) {
    drop(span);
}

impl Drop for Span {
    fn drop(&mut self) {
        let cpu_ms = ThreadTime::now()
            .as_duration()
            .saturating_sub(self.cpu_start)
            .as_secs_f64()
            * 1_000.0;
        let wall_ms = self.wall.elapsed().as_secs_f64() * 1_000.0;
        COSTS.with(|costs| {
            if let Some(costs) = costs.borrow_mut().as_mut() {
                let cost = costs.entry(self.name).or_default();
                cost.wall_ms += wall_ms;
                cost.thread_cpu_ms += cpu_ms;
                cost.calls += 1;
            }
        });
    }
}

#[test]
fn thread_cpu_clock_records_work_and_stays_opt_in() {
    assert!(start("inactive").is_none());
    begin_pass();
    let span = start("hash");
    let mut value = 1_u64;
    for i in 0..100_000 {
        value = std::hint::black_box(value.wrapping_mul(31).wrapping_add(i));
    }
    finish(span);
    let costs = end_pass();
    assert_eq!(costs.len(), 1);
    assert!(costs["hash"].thread_cpu_ms > 0.0);
    assert!(costs["hash"].wall_ms > 0.0);
    assert!(start("inactive").is_none());
}
