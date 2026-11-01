//! Protected-tail drain accounting, ported from the TypeScript session-meta policy.
//!
//! The off-thread historian root supplies its captured activation value and a store
//! adapter. This module neither reads configuration nor starts historian work.

// The store adapter and off-thread callers are supplied by code outside this module.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

const DRAIN_WINDOW_MS: i64 = 10 * 60 * 1000;
const FAILURE_BACKOFF_MS: i64 = 60_000;
const MAX_LATCH_MS: i64 = 30 * 60 * 1000;

/// Existing session_meta columns used to track drain spending and emergency catch-up.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DrainMeta {
    pub protected_tail_drain_window_started_at: i64,
    pub protected_tail_drain_tokens: f64,
    /// Entry time in milliseconds, not a boolean; zero means unlatched.
    pub emergency_drain_active: i64,
    pub historian_drain_failure_at: i64,
}

/// Store handoff for atomic reservation and refund against context.db.
pub trait DrainStore {
    type Error;

    /// Run under BEGIN IMMEDIATE, ensuring the session_meta row exists first.
    /// Load these four columns (NULL/non-finite values read as zero), call `apply`,
    /// and persist its changes before committing. On any store error, roll back
    /// the entire transaction, including row creation. Do not write other columns
    /// or cache epochs. Concurrent calls must serialize the read/modify/write.
    fn with_immediate_transaction<T>(
        &self,
        session_id: &str,
        apply: impl FnOnce(&mut DrainMeta) -> T,
    ) -> Result<T, Self::Error>;
}

#[derive(Debug, Clone, Copy)]
pub struct ReserveRequest<'a> {
    pub session_id: &'a str,
    pub run_id: &'a str,
    pub true_raw_tokens: f64,
    pub usage_percentage: f64,
    pub usable: f64,
    pub per_run_cap: f64,
    pub execute_threshold_percentage: f64,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReservation {
    pub session_id: String,
    pub run_id: String,
    pub tokens: f64,
    pub window_started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainBudgetState {
    pub window_started_at: i64,
    pub resets_at: i64,
    pub reset_in_ms: i64,
    pub spent_tokens: f64,
    pub limit_tokens: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReserveResult {
    pub ok: bool,
    pub reserved_tokens: f64,
    pub over_quota_bypass: bool,
    pub reservation: Option<DrainReservation>,
    pub budget_state: Option<DrainBudgetState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}

// Rust's min/max ignore NaN; JavaScript's Math.min/Math.max propagate it.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    -js_max(-a, -b)
}

fn window_budget(request: &ReserveRequest<'_>) -> f64 {
    let (ceiling, multiplier, fraction) = if request.usage_percentage >= 95.0 {
        (1_000_000.0, 4.0, 0.5)
    } else if request.usage_percentage >= 80.0 {
        (750_000.0, 3.0, 0.35)
    } else {
        (500_000.0, 1.0, 0.2)
    };
    // Math.round chooses the integer toward positive infinity at a half tie.
    // Adding 0.5 first can itself round a value just below a half tie upward.
    let scaled = fraction * request.usable;
    let floor = scaled.floor();
    let rounded = if scaled - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    js_min(ceiling, js_max(multiplier * request.per_run_cap, rounded))
}

fn resolved_latch(meta: &DrainMeta, request: &ReserveRequest<'_>) -> i64 {
    let force = crate::scheduler::escalation_bands(request.execute_threshold_percentage)
        .force_materialize_percentage;
    // Usage at the force-cleanup threshold keeps the latch active even past its
    // thirty-minute expiry, retaining the timestamp when catch-up first began.
    if request.usage_percentage >= force {
        return if meta.emergency_drain_active > 0 {
            meta.emergency_drain_active
        } else {
            request.now
        };
    }
    let threshold = request.execute_threshold_percentage;
    let exit = if !threshold.is_finite() || threshold <= 0.0 {
        55.0
    } else {
        (threshold - 10.0).max(0.0)
    };
    if request.usage_percentage < exit
        || request.now.saturating_sub(meta.emergency_drain_active) > MAX_LATCH_MS
    {
        0
    } else {
        meta.emergency_drain_active
    }
}

/// `None` means activation was off: not even a store transaction was started.
pub fn reserve_protected_tail_drain_tokens<S: DrainStore>(
    store: &S,
    activation: bool,
    request: ReserveRequest<'_>,
) -> Result<Option<DrainReserveResult>, S::Error> {
    if !activation {
        return Ok(None);
    }
    let requested = js_max(0.0, request.true_raw_tokens.floor());
    if requested == 0.0 {
        return Ok(Some(DrainReserveResult {
            ok: true,
            reserved_tokens: 0.0,
            over_quota_bypass: false,
            reservation: None,
            budget_state: None,
            skipped_reason: None,
        }));
    }
    store
        .with_immediate_transaction(request.session_id, |meta| {
            let start = meta.protected_tail_drain_window_started_at;
            if start <= 0
                || start > request.now
                || request.now.saturating_sub(start) >= DRAIN_WINDOW_MS
            {
                meta.protected_tail_drain_window_started_at = request.now;
                meta.protected_tail_drain_tokens = 0.0;
            }

            let latch = resolved_latch(meta, &request);
            // Save latch entry/exit even if no tokens can be reserved, so later
            // attempts inherit the usage-driven catch-up state rather than losing it.
            meta.emergency_drain_active = latch;
            let budget = window_budget(&request);
            let remaining = js_max(0.0, budget - meta.protected_tail_drain_tokens);
            let mut reserved = js_min(js_min(requested, request.per_run_cap), remaining);
            let mut bypass = false;
            let failure = meta.historian_drain_failure_at;
            let in_backoff = failure > 0
                && failure <= request.now
                && request.now.saturating_sub(failure) < FAILURE_BACKOFF_MS;
            if reserved <= 0.0 && latch > 0 && !in_backoff {
                reserved = js_min(requested, request.per_run_cap);
                bypass = true;
            }

            let start = meta.protected_tail_drain_window_started_at;
            let budget_state = |spent_tokens| DrainBudgetState {
                window_started_at: start,
                resets_at: start + DRAIN_WINDOW_MS,
                reset_in_ms: (start + DRAIN_WINDOW_MS - request.now).max(0),
                spent_tokens,
                limit_tokens: budget,
            };
            if reserved <= 0.0 {
                return DrainReserveResult {
                    ok: false,
                    reserved_tokens: 0.0,
                    over_quota_bypass: false,
                    reservation: None,
                    budget_state: Some(budget_state(meta.protected_tail_drain_tokens)),
                    skipped_reason: Some("internal drain budget spent".into()),
                };
            }
            meta.protected_tail_drain_tokens += reserved;
            DrainReserveResult {
                ok: true,
                reserved_tokens: reserved,
                over_quota_bypass: bypass,
                reservation: Some(DrainReservation {
                    session_id: request.session_id.into(),
                    run_id: request.run_id.into(),
                    tokens: reserved,
                    window_started_at: start,
                }),
                budget_state: Some(budget_state(meta.protected_tail_drain_tokens)),
                skipped_reason: None,
            }
        })
        .map(Some)
}

/// Pass the same activation value used to reserve tokens. Rereading the setting
/// after historian work finishes could suppress a refund for an enabled run.
pub fn rollback_protected_tail_drain_reservation<S: DrainStore>(
    store: &S,
    activation: bool,
    reservation: Option<&DrainReservation>,
) -> Result<(), S::Error> {
    if !activation {
        return Ok(());
    }
    let Some(reservation) = reservation.filter(|reservation| reservation.tokens > 0.0) else {
        return Ok(());
    };
    store.with_immediate_transaction(&reservation.session_id, |meta| {
        // A new window starts spending at zero. Subtracting an older window's
        // reservation would incorrectly give the current window additional budget.
        if meta.protected_tail_drain_window_started_at == reservation.window_started_at {
            meta.protected_tail_drain_tokens =
                js_max(0.0, meta.protected_tail_drain_tokens - reservation.tokens);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection, TransactionBehavior};
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    const NOW: i64 = 10_000_000;

    // Generated by executing the TS reserve/rollback functions with Bun 1.4.2 on
    // throwaway SQLite rows, so expected results are independent of the Rust port.
    // These git blob hashes verify each policy file matches the reference revision
    // 282d9c08bce4 exactly: reference blob == worktree blob used to generate fixtures.
    // storage-meta-persisted.ts: a6ed260cfefee9bf1cc1ac82e64f77fee3216930 == a6ed260cfefee9bf1cc1ac82e64f77fee3216930
    // storage-meta-shared.ts: 8b85e8907c150fce831239d6dc3bc56545b76779 == 8b85e8907c150fce831239d6dc3bc56545b76779
    // shared/escalation-bands.ts: 46ac560355771124bb67574dbb117e49e0c1e981 == 46ac560355771124bb67574dbb117e49e0c1e981
    // The first two paths are under packages/plugin/src/features/magic-context/;
    // shared/escalation-bands.ts is under packages/plugin/src/.
    // Reserve vector: name, group, row-before, [raw, usage, usable, cap, threshold],
    // result [ok, reserved, bypass, reservation, budget, skip], row-after.
    // Row: [window start, spent, latch timestamp, failure timestamp].
    // Reservation: [session, run, tokens, window start].
    // Budget: [window start, resets at, reset in ms, spent, limit].
    // Every call uses session "s" and NOW; a null threshold represents JS NaN.
    const RESERVE_FIXTURES: &str = r#"[
["fractional_request","reservation",[9999999,0,0,0],[1234.9,20,100000,20000,80],[true,1234,false,["s","fractional_request",1234,9999999],[9999999,10599999,599999,1234,20000],null],[9999999,1234,0,0]],
["fractional_cap","reservation",[9999999,0,0,0],[100,20,100000,17.5,80],[true,17.5,false,["s","fractional_cap",17.5,9999999],[9999999,10599999,599999,17.5,20000],null],[9999999,17.5,0,0]],
["last_token","reservation",[9999999,19999,0,0],[20000,20,100000,20000,80],[true,1,false,["s","last_token",1,9999999],[9999999,10599999,599999,20000,20000],null],[9999999,20000,0,0]],
["spent","reservation",[9999999,20000,0,0],[1,20,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,20000,20000],"internal drain budget spent"],[9999999,20000,0,0]],
["zero_request","reservation",[9400000,999,7,9],[0,95,100000,20000,80],[true,0,false,null,null,null],[9400000,999,7,9]],
["negative_request","reservation",[9400000,999,7,9],[-1.2,95,100000,20000,80],[true,0,false,null,null,null],[9400000,999,7,9]],
["floor_to_zero","reservation",[9999999,0,0,0],[0.99,95,100000,20000,80],[true,0,false,null,null,null],[9999999,0,0,0]],
["zero_cap","reservation",[9999999,0,0,0],[1,20,100000,0,80],[false,0,false,null,[9999999,10599999,599999,0,20000],"internal drain budget spent"],[9999999,0,0,0]],
["negative_counter","reservation",[9999999,-9,0,0],[1,20,100000,20000,80],[true,1,false,["s","negative_counter",1,9999999],[9999999,10599999,599999,-8,20000],null],[9999999,-8,0,0]],
["low_round","budget",[9999999,0,9999900,0],[1,79.999,17.5,1,80],[true,1,false,["s","low_round",1,9999999],[9999999,10599999,599999,1,4],null],[9999999,1,9999900,0]],
["below_half_round","budget",[9999999,0,9999900,0],[1,79.999,2.4999999999999996,0.25,80],[true,0.25,false,["s","below_half_round",0.25,9999999],[9999999,10599999,599999,0.25,0.25],null],[9999999,0.25,9999900,0]],
["middle_round","budget",[9999999,0,9999900,0],[1,80,10,1,80],[true,1,false,["s","middle_round",1,9999999],[9999999,10599999,599999,1,4],null],[9999999,1,9999900,0]],
["below_high","budget",[9999999,0,9999900,0],[1,94.999,100,1,80],[true,1,false,["s","below_high",1,9999999],[9999999,10599999,599999,1,35],null],[9999999,1,9999900,0]],
["high_round","budget",[9999999,0,9999900,0],[1,95,7,1,80],[true,1,false,["s","high_round",1,9999999],[9999999,10599999,599999,1,4],null],[9999999,1,9999900,0]],
["low_cap","budget",[9999999,0,9999900,0],[1,20,1,20000,80],[true,1,false,["s","low_cap",1,9999999],[9999999,10599999,599999,1,20000],null],[9999999,1,0,0]],
["middle_cap","budget",[9999999,0,9999900,0],[1,80,1,20000,80],[true,1,false,["s","middle_cap",1,9999999],[9999999,10599999,599999,1,60000],null],[9999999,1,9999900,0]],
["high_cap","budget",[9999999,0,9999900,0],[1,95,1,20000,80],[true,1,false,["s","high_cap",1,9999999],[9999999,10599999,599999,1,80000],null],[9999999,1,9999900,0]],
["low_ceiling","budget",[9999999,0,9999900,0],[1,20,10000000,20000,80],[true,1,false,["s","low_ceiling",1,9999999],[9999999,10599999,599999,1,500000],null],[9999999,1,0,0]],
["middle_ceiling","budget",[9999999,0,9999900,0],[1,80,10000000,20000,80],[true,1,false,["s","middle_ceiling",1,9999999],[9999999,10599999,599999,1,750000],null],[9999999,1,9999900,0]],
["high_ceiling","budget",[9999999,0,9999900,0],[1,95,10000000,20000,80],[true,1,false,["s","high_ceiling",1,9999999],[9999999,10599999,599999,1,1000000],null],[9999999,1,9999900,0]],
["not_expired","window",[9400001,20000,0,0],[1,20,100000,20000,80],[false,0,false,null,[9400001,10000001,1,20000,20000],"internal drain budget spent"],[9400001,20000,0,0]],
["exact_expiry","window",[9400000,20000,0,0],[1,20,100000,20000,80],[true,1,false,["s","exact_expiry",1,10000000],[10000000,10600000,600000,1,20000],null],[10000000,1,0,0]],
["after_expiry","window",[9399999,20000,0,0],[1,20,100000,20000,80],[true,1,false,["s","after_expiry",1,10000000],[10000000,10600000,600000,1,20000],null],[10000000,1,0,0]],
["future","window",[10000001,20000,0,0],[1,20,100000,20000,80],[true,1,false,["s","future",1,10000000],[10000000,10600000,600000,1,20000],null],[10000000,1,0,0]],
["unstarted","window",[0,20000,0,0],[1,20,100000,20000,80],[true,1,false,["s","unstarted",1,10000000],[10000000,10600000,600000,1,20000],null],[10000000,1,0,0]],
["negative_start","window",[-1,20000,0,0],[1,20,100000,20000,80],[true,1,false,["s","negative_start",1,10000000],[10000000,10600000,600000,1,20000],null],[10000000,1,0,0]],
["reset_even_if_skipped","window",[9400000,12345,0,0],[1,20,100000,0,80],[false,0,false,null,[10000000,10600000,600000,0,20000],"internal drain budget spent"],[10000000,0,0,0]],
["below_force","latch",[9999999,1000000,0,0],[1,84.999,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,60000],"internal drain budget spent"],[9999999,1000000,0,0]],
["enter_force","latch",[9999999,1000000,0,0],[1,85,100000,20000,80],[true,1,true,["s","enter_force",1,9999999],[9999999,10599999,599999,1000001,60000],null],[9999999,1000001,10000000,0]],
["enter_derived_force","latch",[9999999,1000000,0,0],[1,92,100000,20000,90],[true,1,true,["s","enter_derived_force",1,9999999],[9999999,10599999,599999,1000001,60000],null],[9999999,1000001,10000000,0]],
["below_derived_force","latch",[9999999,1000000,0,0],[1,91.999,100000,20000,90],[false,0,false,null,[9999999,10599999,599999,1000000,60000],"internal drain budget spent"],[9999999,1000000,0,0]],
["clamped_force","latch",[9999999,1000000,0,0],[1,92,100000,20000,100],[true,1,true,["s","clamped_force",1,9999999],[9999999,10599999,599999,1000001,60000],null],[9999999,1000001,10000000,0]],
["stay_at_exit","latch",[9999999,1000000,9999000,0],[1,70,100000,20000,80],[true,1,true,["s","stay_at_exit",1,9999999],[9999999,10599999,599999,1000001,20000],null],[9999999,1000001,9999000,0]],
["below_exit","latch",[9999999,1000000,9999000,0],[1,69.999,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,20000],"internal drain budget spent"],[9999999,1000000,0,0]],
["at_self_expiry","latch",[9999999,1000000,8200000,0],[1,70,100000,20000,80],[true,1,true,["s","at_self_expiry",1,9999999],[9999999,10599999,599999,1000001,20000],null],[9999999,1000001,8200000,0]],
["after_self_expiry","latch",[9999999,1000000,8199999,0],[1,70,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,20000],"internal drain budget spent"],[9999999,1000000,0,0]],
["force_beats_expiry","latch",[9999999,1000000,8199999,0],[1,95,100000,20000,80],[true,1,true,["s","force_beats_expiry",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,8199999,0]],
["fallback_at_exit","latch",[9999999,1000000,9999000,0],[1,55,100000,20000,null],[true,1,true,["s","fallback_at_exit",1,9999999],[9999999,10599999,599999,1000001,20000],null],[9999999,1000001,9999000,0]],
["fallback_below_exit","latch",[9999999,1000000,9999000,0],[1,54.999,100000,20000,null],[false,0,false,null,[9999999,10599999,599999,1000000,20000],"internal drain budget spent"],[9999999,1000000,0,0]],
["nonpositive_exit","latch",[9999999,1000000,9999000,0],[1,54.999,100000,20000,0],[false,0,false,null,[9999999,10599999,599999,1000000,20000],"internal drain budget spent"],[9999999,1000000,0,0]],
["negative_exit","latch",[9999999,1000000,9999000,0],[1,55,100000,20000,-2],[true,1,true,["s","negative_exit",1,9999999],[9999999,10599999,599999,1000001,20000],null],[9999999,1000001,9999000,0]],
["small_threshold_exit","latch",[9999999,1000000,9999000,0],[1,0,100000,20000,5],[true,1,true,["s","small_threshold_exit",1,9999999],[9999999,10599999,599999,1000001,20000],null],[9999999,1000001,9999000,0]],
["no_failure","backoff",[9999999,1000000,9999000,0],[1,95,100000,20000,80],[true,1,true,["s","no_failure",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,9999000,0]],
["failure_now","backoff",[9999999,1000000,9999000,10000000],[1,95,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,80000],"internal drain budget spent"],[9999999,1000000,9999000,10000000]],
["recent_failure","backoff",[9999999,1000000,9999000,9940001],[1,95,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,80000],"internal drain budget spent"],[9999999,1000000,9999000,9940001]],
["backoff_boundary","backoff",[9999999,1000000,9999000,9940000],[1,95,100000,20000,80],[true,1,true,["s","backoff_boundary",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,9999000,9940000]],
["old_failure","backoff",[9999999,1000000,9999000,9939999],[1,95,100000,20000,80],[true,1,true,["s","old_failure",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,9999000,9939999]],
["future_failure","backoff",[9999999,1000000,9999000,10000001],[1,95,100000,20000,80],[true,1,true,["s","future_failure",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,9999000,10000001]],
["negative_failure","backoff",[9999999,1000000,9999000,-1],[1,95,100000,20000,80],[true,1,true,["s","negative_failure",1,9999999],[9999999,10599999,599999,1000001,80000],null],[9999999,1000001,9999000,-1]],
["failure_allows_normal_budget","backoff",[9999999,0,9999000,10000000],[1,95,100000,20000,80],[true,1,false,["s","failure_allows_normal_budget",1,9999999],[9999999,10599999,599999,1,80000],null],[9999999,1,9999000,10000000]],
["persist_entry_on_skip","latch",[9999999,1000000,0,10000000],[1,95,100000,20000,80],[false,0,false,null,[9999999,10599999,599999,1000000,80000],"internal drain budget spent"],[9999999,1000000,10000000,10000000]]
]"#;

    // Refund vector: name, row-before, reservation (or null), row-after.
    const REFUND_FIXTURES: &str = r#"[
["same_window",[10000000,21,7,9],["s","refund",20,10000000],[10000000,1,7,9]],
["clamp_zero",[10000000,5,7,9],["s","refund",20,10000000],[10000000,0,7,9]],
["late_refund",[10000000,21,7,9],["s","refund",20,9400000],[10000000,21,7,9]],
["future_window_refund",[10000000,21,7,9],["s","refund",20,10000001],[10000000,21,7,9]],
["null_refund",[10000000,21,7,9],null,[10000000,21,7,9]],
["zero_refund",[10000000,21,7,9],["s","refund",0,10000000],[10000000,21,7,9]],
["negative_refund",[10000000,21,7,9],["s","refund",-1,10000000],[10000000,21,7,9]],
["fractional_refund",[10000000,21,7,9],["s","refund",17.5,10000000],[10000000,3.5,7,9]]
]"#;

    struct FixtureStore {
        path: PathBuf,
        transactions: AtomicUsize,
        fail_after_apply: AtomicBool,
        _root: tempfile::TempDir,
    }

    impl FixtureStore {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("context.db");
            // Use the real table DDL, without replaying unrelated migration-history
            // inserts whose timestamp expressions require a newer system SQLite.
            let schema = include_str!("../../mc-store/testdata/context_schema/schema.sql");
            let start = schema.find("CREATE TABLE session_meta (").unwrap();
            let end = start + schema[start..].find(");").unwrap() + 2;
            Connection::open(&path)
                .unwrap()
                .execute_batch(&schema[start..end])
                .unwrap();
            Self {
                path,
                transactions: AtomicUsize::new(0),
                fail_after_apply: AtomicBool::new(false),
                _root: root,
            }
        }

        fn conn(&self) -> Connection {
            let conn = Connection::open(&self.path).unwrap();
            conn.busy_timeout(Duration::from_secs(10)).unwrap();
            conn
        }

        fn seed(&self, row: &Value) {
            self.conn().execute(
                "INSERT INTO session_meta(session_id, protected_tail_drain_window_started_at,
                 protected_tail_drain_tokens, emergency_drain_active, historian_drain_failure_at,
                 protected_tail_policy_version, counter) VALUES ('s', ?1, ?2, ?3, ?4, 3, 42)
                 ON CONFLICT(session_id) DO UPDATE SET
                 protected_tail_drain_window_started_at=excluded.protected_tail_drain_window_started_at,
                 protected_tail_drain_tokens=excluded.protected_tail_drain_tokens,
                 emergency_drain_active=excluded.emergency_drain_active,
                 historian_drain_failure_at=excluded.historian_drain_failure_at",
                params![row[0].as_i64(), row[1].as_f64(), row[2].as_i64(), row[3].as_i64()],
            ).unwrap();
        }

        fn row(&self) -> Value {
            let meta = read_meta(&self.conn(), "s").unwrap();
            json!([
                meta.protected_tail_drain_window_started_at,
                meta.protected_tail_drain_tokens,
                meta.emergency_drain_active,
                meta.historian_drain_failure_at
            ])
        }

        fn unrelated_columns(&self) -> Vec<rusqlite::types::Value> {
            let conn = self.conn();
            let mut stmt = conn
                .prepare("SELECT * FROM session_meta WHERE session_id='s'")
                .unwrap();
            let indices: Vec<_> = stmt
                .column_names()
                .iter()
                .enumerate()
                .filter_map(|(i, name)| {
                    (!matches!(
                        *name,
                        "protected_tail_drain_window_started_at"
                            | "protected_tail_drain_tokens"
                            | "emergency_drain_active"
                            | "historian_drain_failure_at"
                    ))
                    .then_some(i)
                })
                .collect();
            stmt.query_row([], |row| indices.iter().map(|i| row.get(*i)).collect())
                .unwrap()
        }
    }

    fn read_meta(conn: &Connection, session: &str) -> rusqlite::Result<DrainMeta> {
        conn.query_row(
            "SELECT COALESCE(protected_tail_drain_window_started_at,0),
             COALESCE(protected_tail_drain_tokens,0), COALESCE(emergency_drain_active,0),
             COALESCE(historian_drain_failure_at,0) FROM session_meta WHERE session_id=?1",
            [session],
            |row| {
                Ok(DrainMeta {
                    protected_tail_drain_window_started_at: row.get(0)?,
                    protected_tail_drain_tokens: row.get(1)?,
                    emergency_drain_active: row.get(2)?,
                    historian_drain_failure_at: row.get(3)?,
                })
            },
        )
    }

    impl DrainStore for FixtureStore {
        type Error = rusqlite::Error;

        fn with_immediate_transaction<T>(
            &self,
            session: &str,
            apply: impl FnOnce(&mut DrainMeta) -> T,
        ) -> Result<T, Self::Error> {
            self.transactions.fetch_add(1, Ordering::SeqCst);
            let mut conn = self.conn();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT OR IGNORE INTO session_meta(session_id) VALUES (?1)",
                [session],
            )?;
            let mut meta = read_meta(&tx, session)?;
            let result = apply(&mut meta);
            if self.fail_after_apply.load(Ordering::SeqCst) {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "UPDATE session_meta SET protected_tail_drain_window_started_at=?2,
                 protected_tail_drain_tokens=?3, emergency_drain_active=?4,
                 historian_drain_failure_at=?5 WHERE session_id=?1",
                params![
                    session,
                    meta.protected_tail_drain_window_started_at,
                    meta.protected_tail_drain_tokens,
                    meta.emergency_drain_active,
                    meta.historian_drain_failure_at
                ],
            )?;
            tx.commit()?;
            Ok(result)
        }
    }

    fn request<'a>(name: &'a str, args: &Value) -> ReserveRequest<'a> {
        ReserveRequest {
            session_id: "s",
            run_id: name,
            true_raw_tokens: args[0].as_f64().unwrap(),
            usage_percentage: args[1].as_f64().unwrap(),
            usable: args[2].as_f64().unwrap(),
            per_run_cap: args[3].as_f64().unwrap(),
            execute_threshold_percentage: args[4].as_f64().unwrap_or(f64::NAN),
            now: NOW,
        }
    }

    // Flatten every TS result field without calculating any expected policy values.
    fn projection(result: DrainReserveResult) -> Value {
        json!([
            result.ok,
            result.reserved_tokens,
            result.over_quota_bypass,
            result.reservation.map(|r| json!([
                r.session_id,
                r.run_id,
                r.tokens,
                r.window_started_at
            ])),
            result.budget_state.map(|b| json!([
                b.window_started_at,
                b.resets_at,
                b.reset_in_ms,
                b.spent_tokens,
                b.limit_tokens
            ])),
            result.skipped_reason
        ])
    }

    // JSON preserves JS integer numbers, whereas serde_json distinguishes 1 from 1.0.
    // Compare numbers as their exact f64 values, never using a tolerance.
    fn exact_values(actual: &Value, expected: &Value, name: &str) {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{name}"),
            (Value::Array(a), Value::Array(b)) => {
                assert_eq!(a.len(), b.len(), "{name}");
                for (a, b) in a.iter().zip(b) {
                    exact_values(a, b, name);
                }
            }
            _ => assert_eq!(actual, expected, "{name}"),
        }
    }

    fn reserve_vectors(group: &str) {
        let fixtures: Value = serde_json::from_str(RESERVE_FIXTURES).unwrap();
        let store = FixtureStore::new();
        let mut count = 0;
        for fixture in fixtures.as_array().unwrap() {
            if fixture[1] != group {
                continue;
            }
            count += 1;
            let name = fixture[0].as_str().unwrap();
            store.seed(&fixture[2]);
            let unrelated = store.unrelated_columns();
            let result =
                reserve_protected_tail_drain_tokens(&store, true, request(name, &fixture[3]))
                    .unwrap()
                    .unwrap();
            exact_values(&projection(result), &fixture[4], name);
            exact_values(&store.row(), &fixture[5], name);
            assert_eq!(unrelated, store.unrelated_columns(), "{name}");
        }
        assert!(count > 0, "no TS fixtures selected for {group}");
    }

    #[test]
    fn typescript_reservation_exact_values() {
        reserve_vectors("reservation");
        empty_requests_and_refunds_start_no_transaction();
    }

    #[test]
    fn typescript_budget_tiers_and_rounding() {
        reserve_vectors("budget");
    }

    #[test]
    fn typescript_window_reset() {
        reserve_vectors("window");
    }

    #[test]
    fn typescript_latch_transitions() {
        reserve_vectors("latch");
    }

    #[test]
    fn typescript_failure_backoff() {
        reserve_vectors("backoff");
    }

    #[test]
    fn typescript_refunds_same_window_and_late() {
        let fixtures: Value = serde_json::from_str(REFUND_FIXTURES).unwrap();
        let store = FixtureStore::new();
        for fixture in fixtures.as_array().unwrap() {
            let name = fixture[0].as_str().unwrap();
            store.seed(&fixture[1]);
            let unrelated = store.unrelated_columns();
            let r = &fixture[2];
            let reservation = (!r.is_null()).then(|| DrainReservation {
                session_id: r[0].as_str().unwrap().into(),
                run_id: r[1].as_str().unwrap().into(),
                tokens: r[2].as_f64().unwrap(),
                window_started_at: r[3].as_i64().unwrap(),
            });
            rollback_protected_tail_drain_reservation(&store, true, reservation.as_ref()).unwrap();
            exact_values(&store.row(), &fixture[3], name);
            assert_eq!(unrelated, store.unrelated_columns(), "{name}");
        }

        // Reserve before and after the ten-minute window expires, proving that a
        // refund from actual earlier work cannot change the new window's spending.
        store.seed(&json!([0, 0, 0, 0]));
        let first = reserve_protected_tail_drain_tokens(
            &store,
            true,
            request("first", &json!([123, 20, 100000, 20000, 80])),
        )
        .unwrap()
        .unwrap();
        let mut next = request("next", &json!([17, 20, 100000, 20000, 80]));
        next.now += DRAIN_WINDOW_MS + 1;
        let second = reserve_protected_tail_drain_tokens(&store, true, next)
            .unwrap()
            .unwrap();
        rollback_protected_tail_drain_reservation(&store, true, first.reservation.as_ref())
            .unwrap();
        exact_values(
            &store.row(),
            &json!([NOW + DRAIN_WINDOW_MS + 1, 17, 0, 0]),
            "rollover",
        );
        rollback_protected_tail_drain_reservation(&store, true, second.reservation.as_ref())
            .unwrap();
        exact_values(
            &store.row(),
            &json!([NOW + DRAIN_WINDOW_MS + 1, 0, 0, 0]),
            "current refund",
        );
    }

    struct NoWorkStore;
    impl DrainStore for NoWorkStore {
        type Error = ();
        fn with_immediate_transaction<T>(
            &self,
            _: &str,
            _: impl FnOnce(&mut DrainMeta) -> T,
        ) -> Result<T, Self::Error> {
            panic!("unexpected store work");
        }
    }

    #[test]
    fn activation_off_starts_no_work() {
        let req = request("off", &json!([20, 95, 100000, 20000, 80]));
        assert!(
            reserve_protected_tail_drain_tokens(&NoWorkStore, false, req)
                .unwrap()
                .is_none()
        );
        let reservation = DrainReservation {
            session_id: "s".into(),
            run_id: "off".into(),
            tokens: 20.0,
            window_started_at: NOW,
        };
        rollback_protected_tail_drain_reservation(&NoWorkStore, false, Some(&reservation)).unwrap();
    }

    fn empty_requests_and_refunds_start_no_transaction() {
        for raw in [0.0, -1.0, 0.99] {
            let req = request("empty", &json!([raw, 95, 100000, 20000, 80]));
            assert_eq!(
                reserve_protected_tail_drain_tokens(&NoWorkStore, true, req)
                    .unwrap()
                    .unwrap()
                    .reserved_tokens,
                0.0
            );
        }
        rollback_protected_tail_drain_reservation(&NoWorkStore, true, None).unwrap();
        for tokens in [0.0, -1.0] {
            let reservation = DrainReservation {
                session_id: "s".into(),
                run_id: "empty".into(),
                tokens,
                window_started_at: NOW,
            };
            rollback_protected_tail_drain_reservation(&NoWorkStore, true, Some(&reservation))
                .unwrap();
        }
    }

    #[test]
    fn concurrent_reservations_do_not_overspend() {
        let store = Arc::new(FixtureStore::new());
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    reserve_protected_tail_drain_tokens(
                        &*store,
                        true,
                        request("concurrent", &json!([7000, 20, 100000, 20000, 80])),
                    )
                    .unwrap()
                    .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            results.iter().map(|r| r.reserved_tokens).sum::<f64>(),
            20000.0
        );
        assert_eq!(results.iter().filter(|r| r.ok).count(), 3);
        assert_eq!(store.transactions.load(Ordering::SeqCst), 8);
        exact_values(&store.row(), &json!([NOW, 20000, 0, 0]), "concurrent row");
    }

    #[test]
    fn store_error_rolls_back_including_row_creation() {
        let store = FixtureStore::new();
        store.fail_after_apply.store(true, Ordering::SeqCst);
        assert!(reserve_protected_tail_drain_tokens(
            &store,
            true,
            request("failed", &json!([20, 95, 100000, 20000, 80]))
        )
        .is_err());
        assert_eq!(
            store
                .conn()
                .query_row("SELECT count(*) FROM session_meta", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store.seed(&json!([NOW, 20, 7, 9]));
        let reservation = DrainReservation {
            session_id: "s".into(),
            run_id: "failed".into(),
            tokens: 20.0,
            window_started_at: NOW,
        };
        assert!(
            rollback_protected_tail_drain_reservation(&store, true, Some(&reservation)).is_err()
        );
        exact_values(&store.row(), &json!([NOW, 20, 7, 9]), "failed refund");
    }
}
