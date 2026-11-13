//! How much history the summarizer may read per ten minutes: the plugin's
//! drain quota (`historian-drain-gate.ts`, `storage-meta-persisted.ts`).
//!
//! Each run reserves the raw tokens it is about to read. A ten-minute window
//! allows a share of the usable window that grows with usage, so a session
//! that keeps growing cannot keep the summarizer busy without end. From the
//! force band an emergency latch lets runs past a spent window, until usage
//! falls well below the threshold. A run that fails keeps its reservation,
//! so a broken summarizer does not retry on every pass, and it holds the
//! latch's bypass back for a minute.

use serde::{Deserialize, Serialize};

/// The window the quota counts over.
pub const WINDOW_MS: i64 = 10 * 60 * 1000;
/// The latch ends once usage is this many points below the execute
/// threshold.
const LATCH_EXIT_MARGIN: f64 = 10.0;
/// After a failed run the latch lets nothing past a spent window for this
/// long.
const FAILURE_BACKOFF_MS: i64 = 60_000;
/// The latch ends after this long whatever the usage, in case a floor of
/// content the summarizer cannot reduce keeps usage high.
const MAX_LATCH_MS: i64 = 30 * 60 * 1000;

/// What one window allows, by usage (`protectedTailWindowBudget`).
pub fn window_budget(usage_percentage: f64, usable: u64, per_run_cap: u64) -> u64 {
    let share = |ratio: f64| (usable as f64 * ratio).round() as u64;
    if usage_percentage >= 95.0 {
        (4 * per_run_cap).max(share(0.5)).min(1_000_000)
    } else if usage_percentage >= 80.0 {
        (3 * per_run_cap).max(share(0.35)).min(750_000)
    } else {
        per_run_cap.max(share(0.2)).min(500_000)
    }
}

/// The session's quota, kept across restarts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Drain {
    /// When the current window started, in milliseconds; 0 before the first
    /// run.
    pub window_started_at: i64,
    /// Raw tokens reserved in the current window.
    pub spent: u64,
    /// When the emergency latch was set; 0 when it is off.
    pub latch_since: i64,
    /// When a run last failed.
    pub failure_at: i64,
}

/// What a pass knows when it asks the quota.
pub struct Usage {
    pub now: i64,
    pub percentage: f64,
    pub threshold: f64,
    /// Usage is in the force band.
    pub force: bool,
    /// The usable window at the execute threshold.
    pub usable: u64,
    pub per_run_cap: u64,
}

/// A reservation a run holds until it ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub tokens: u64,
    pub window_started_at: i64,
}

impl Drain {
    fn window_open(&self, now: i64) -> bool {
        self.window_started_at > 0
            && self.window_started_at <= now
            && now - self.window_started_at < WINDOW_MS
    }

    /// Set the latch from the force band on, and end it below the threshold
    /// minus ten points or after thirty minutes.
    fn update_latch(&mut self, usage: &Usage) {
        if usage.force {
            if self.latch_since == 0 {
                self.latch_since = usage.now;
            }
        } else if usage.percentage < (usage.threshold - LATCH_EXIT_MARGIN).max(0.0)
            || usage.now - self.latch_since > MAX_LATCH_MS
        {
            self.latch_since = 0;
        }
    }

    pub(crate) fn in_failure_backoff(&self, now: i64) -> bool {
        self.failure_at > 0 && self.failure_at <= now && now - self.failure_at < FAILURE_BACKOFF_MS
    }

    /// Whether the current window is spent and the latch lets nothing past
    /// it, so the trigger need not look at the history at all.
    pub fn exhausted(&mut self, usage: &Usage) -> bool {
        self.update_latch(usage);
        if !self.window_open(usage.now) {
            return false;
        }
        let limit = window_budget(usage.percentage, usage.usable, usage.per_run_cap);
        self.spent >= limit && (self.latch_since == 0 || self.in_failure_backoff(usage.now))
    }

    /// Reserve up to `requested` text and tool-input tokens for a run: what the window has
    /// left, at most one run's cap. Past a spent window the latch admits one
    /// run's worth. `None` when nothing may run.
    pub fn reserve(&mut self, usage: &Usage, requested: u64) -> Option<Reservation> {
        if requested == 0 {
            return Some(Reservation {
                tokens: 0,
                window_started_at: self.window_started_at,
            });
        }
        if !self.window_open(usage.now) {
            self.window_started_at = usage.now;
            self.spent = 0;
        }
        self.update_latch(usage);
        let limit = window_budget(usage.percentage, usage.usable, usage.per_run_cap);
        let remaining = limit.saturating_sub(self.spent);
        let mut tokens = requested.min(usage.per_run_cap).min(remaining);
        if tokens == 0 && self.latch_since > 0 && !self.in_failure_backoff(usage.now) {
            tokens = requested.min(usage.per_run_cap);
        }
        if tokens == 0 {
            return None;
        }
        self.spent += tokens;
        Some(Reservation {
            tokens,
            window_started_at: self.window_started_at,
        })
    }

    /// A person's anchored wrapup can drain past the automatic window quota,
    /// but keeps the per-run cap, failure backoff and reservation accounting.
    pub fn reserve_wrapup(&mut self, usage: &Usage, requested: u64) -> Option<Reservation> {
        if self.in_failure_backoff(usage.now) {
            return None;
        }
        if !self.window_open(usage.now) {
            self.window_started_at = usage.now;
            self.spent = 0;
        }
        let tokens = requested.min(usage.per_run_cap);
        self.spent = self.spent.saturating_add(tokens);
        Some(Reservation {
            tokens,
            window_started_at: self.window_started_at,
        })
    }

    /// A run that ended without summarizing anything for a reason other than
    /// the summarizer failing gives its reservation back, if its window is
    /// still the current one.
    pub fn release(&mut self, reservation: Reservation) {
        if reservation.window_started_at == self.window_started_at {
            self.spent = self.spent.saturating_sub(reservation.tokens);
        }
    }

    /// A run failed: its reservation stays spent, and the latch lets nothing
    /// past a spent window for a minute.
    pub fn record_failure(&mut self, now: i64) {
        self.failure_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(now: i64, percentage: f64) -> Usage {
        Usage {
            now,
            percentage,
            threshold: 65.0,
            force: percentage >= 85.0,
            usable: 100_000,
            per_run_cap: 25_000,
        }
    }

    #[test]
    fn a_window_admits_its_budget_then_nothing_until_it_ends() {
        let mut drain = Drain::default();
        // Below 80%: max(cap, 20% of usable) = 25,000.
        let first = drain.reserve(&usage(1_000, 70.0), 40_000).unwrap();
        assert_eq!(first.tokens, 25_000);
        assert!(drain.exhausted(&usage(2_000, 70.0)));
        assert_eq!(drain.reserve(&usage(2_000, 70.0), 10_000), None);
        // A new window starts after ten minutes.
        let later = 1_000 + WINDOW_MS;
        assert!(!drain.exhausted(&usage(later, 70.0)));
        assert_eq!(
            drain.reserve(&usage(later, 70.0), 10_000).unwrap().tokens,
            10_000
        );
    }

    #[test]
    fn the_force_band_latch_admits_a_run_past_a_spent_window_unless_one_just_failed() {
        let mut drain = Drain::default();
        // In the force band a window allows max(3 x cap, 35%) = 75,000.
        for _ in 0..3 {
            drain.reserve(&usage(1_000, 90.0), 25_000).unwrap();
        }
        assert_eq!(drain.spent, 75_000);
        // Spent, but the latch lets one run's worth past it.
        assert!(!drain.exhausted(&usage(2_000, 90.0)));
        let bypass = drain.reserve(&usage(2_000, 90.0), 80_000).unwrap();
        assert_eq!(bypass.tokens, 25_000);
        // A failure holds the bypass back for a minute.
        drain.record_failure(3_000);
        assert!(drain.exhausted(&usage(4_000, 90.0)));
        assert_eq!(drain.reserve(&usage(4_000, 90.0), 10_000), None);
        assert!(!drain.exhausted(&usage(3_000 + 61_000, 90.0)));
        // Usage well below the threshold ends the latch.
        drain.exhausted(&usage(70_000, 50.0));
        assert_eq!(drain.latch_since, 0);
    }

    #[test]
    fn a_released_reservation_is_given_back_only_in_its_own_window() {
        let mut drain = Drain::default();
        let reservation = drain.reserve(&usage(1_000, 70.0), 10_000).unwrap();
        drain.release(reservation);
        assert_eq!(drain.spent, 0);
        let old = drain.reserve(&usage(2_000, 70.0), 10_000).unwrap();
        drain
            .reserve(&usage(2_000 + WINDOW_MS, 70.0), 5_000)
            .unwrap();
        drain.release(old);
        assert_eq!(drain.spent, 5_000);
    }
}
