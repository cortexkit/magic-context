use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const FAILURE_THRESHOLD: usize = 3;
// Three full request timeouts leave scheduling slack between serial hangs.
const FAILURE_WINDOW: Duration = super::FETCH_TIMEOUT.saturating_mul(FAILURE_THRESHOLD as u32);
const OPEN_DURATION: Duration = Duration::from_secs(5 * 60);
type SharedCircuit = Arc<Mutex<Circuit>>;

#[derive(Default)]
pub(super) struct Circuit {
    failures: Vec<Instant>,
    open_until: Option<Instant>,
    probe_in_flight: bool,
}

impl Circuit {
    pub(super) fn for_endpoint(endpoint: &str) -> SharedCircuit {
        // Settings resolution constructs new providers per session and pass.
        // Keep strong references so those short-lived providers share one
        // endpoint's health across projects and background upkeep in this process.
        static CIRCUITS: OnceLock<Mutex<HashMap<String, SharedCircuit>>> = OnceLock::new();
        CIRCUITS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .entry(endpoint.trim_end_matches('/').to_owned())
            .or_default()
            .clone()
    }

    fn claim(&mut self, now: Instant) -> Option<bool> {
        let Some(until) = self.open_until else {
            return Some(false);
        };
        if now < until || self.probe_in_flight {
            return None;
        }
        self.probe_in_flight = true;
        Some(true)
    }

    fn failure(&mut self, started: Instant, now: Instant, probe: bool) {
        if probe {
            self.open_until = Some(now + OPEN_DURATION);
            self.failures.clear();
            return;
        }
        // Use request starts, not completions, and include the exact boundary.
        self.failures
            .retain(|time| started.saturating_duration_since(*time) <= FAILURE_WINDOW);
        self.failures.push(started);
        if self.failures.len() >= FAILURE_THRESHOLD {
            self.open_until = Some(now + OPEN_DURATION);
            self.failures.clear();
            tracing::info!("ck-mc: embedding circuit open for 5 minutes after endpoint failures");
        }
    }
}

/// Dropping an unfinished request is caller cancellation, not endpoint failure.
pub(super) struct Attempt {
    circuit: Arc<Mutex<Circuit>>,
    started: Instant,
    probe: bool,
}

impl Attempt {
    pub(super) fn claim(circuit: &Arc<Mutex<Circuit>>) -> Option<Self> {
        let started = Instant::now();
        let probe = circuit.lock().unwrap().claim(started)?;
        Some(Self {
            circuit: circuit.clone(),
            started,
            probe,
        })
    }

    pub(super) fn failure(&self) {
        self.circuit
            .lock()
            .unwrap()
            .failure(self.started, Instant::now(), self.probe);
    }

    pub(super) fn success(&self) {
        let mut state = self.circuit.lock().unwrap();
        state.failures.clear();
        state.open_until = None;
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if self.probe {
            self.circuit.lock().unwrap().probe_in_flight = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_timeout_starts_use_an_inclusive_ninety_second_window() {
        assert_eq!(super::super::FETCH_TIMEOUT, Duration::from_secs(30));
        assert_eq!(
            super::super::QUERY_EMBEDDING_TIMEOUT,
            Duration::from_secs(5)
        );
        assert_eq!(FAILURE_WINDOW, Duration::from_secs(90));
        assert_eq!(OPEN_DURATION, Duration::from_secs(300));
        let zero = Instant::now();
        for starts in [[0, 30_000, 60_000], [0, 45_000, 90_000]] {
            let mut state = Circuit::default();
            for millis in starts {
                let start = zero + Duration::from_millis(millis);
                state.failure(start, start + super::super::FETCH_TIMEOUT, false);
            }
            assert!(state.open_until.is_some());
        }
        let mut state = Circuit::default();
        for millis in [0, 45_000, 90_001] {
            let start = zero + Duration::from_millis(millis);
            state.failure(start, start + super::super::FETCH_TIMEOUT, false);
        }
        assert!(state.open_until.is_none());
        assert_eq!(state.failures.len(), 2);
    }

    #[test]
    fn delayed_completions_do_not_move_failure_timestamps() {
        let zero = Instant::now();
        let mut state = Circuit::default();
        for (start, finish) in [(0, 30), (30, 90), (60, 121)] {
            state.failure(
                zero + Duration::from_secs(start),
                zero + Duration::from_secs(finish),
                false,
            );
        }
        assert_eq!(
            state.open_until,
            Some(zero + Duration::from_secs(121 + 300))
        );
    }

    #[test]
    fn only_one_probe_is_admitted_and_a_failed_probe_reopens_for_five_minutes() {
        let zero = Instant::now();
        let mut state = Circuit::default();
        for _ in 0..3 {
            state.failure(zero, zero, false);
        }
        assert_eq!(
            state.claim(zero + OPEN_DURATION - Duration::from_nanos(1)),
            None
        );
        let probe_time = zero + OPEN_DURATION;
        assert_eq!(state.claim(probe_time), Some(true));
        assert_eq!(state.claim(probe_time), None);
        state.failure(probe_time, probe_time, true);
        state.probe_in_flight = false;
        assert_eq!(state.claim(probe_time), None);
        assert_eq!(state.claim(probe_time + OPEN_DURATION), Some(true));
    }

    #[test]
    fn cancellation_releases_the_probe_and_success_resets_all_failures() {
        let circuit = Arc::new(Mutex::new(Circuit {
            open_until: Some(Instant::now()),
            ..Circuit::default()
        }));
        let probe = Attempt::claim(&circuit).unwrap();
        assert!(Attempt::claim(&circuit).is_none());
        drop(probe);
        let probe = Attempt::claim(&circuit).unwrap();
        probe.success();
        drop(probe);
        let state = circuit.lock().unwrap();
        assert!(state.open_until.is_none());
        assert!(state.failures.is_empty());
        assert!(!state.probe_in_flight);
        drop(state);
        for _ in 0..2 {
            Attempt::claim(&circuit).unwrap().failure();
        }
        Attempt::claim(&circuit).unwrap().success();
        Attempt::claim(&circuit).unwrap().failure();
        assert!(circuit.lock().unwrap().open_until.is_none());
        assert_eq!(circuit.lock().unwrap().failures.len(), 1);
    }
}
