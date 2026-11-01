//! Bounded recovery for already-accepted historian sends whose outcome is unknown.
use crate::historian::{abandon_with_detail, HistorianDriveError, HistorianStateError};
use crate::historian_producer::{is_stage_submission, HistorianProducerError, ProducerErrorBody};
use mc_store::{HistorianDurableState, HistorianPhase, McStore};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) const MAX_UNKNOWN_PROBES: u64 = 3;
pub(crate) const UNKNOWN_FENCE_FLOOR_MS: i64 = 30 * 60 * 1_000;
const PREFIX: &str = "mc-broca-stage:";

fn record(state: &HistorianDurableState) -> Option<Value> {
    state
        .producer_run_id
        .as_deref()?
        .strip_prefix(PREFIX)
        .and_then(|text| serde_json::from_str(text).ok())
}

fn terminal(record: &Value) -> bool {
    record["recovery"]["terminal_unknown"].as_bool() == Some(true)
}

pub(crate) fn is_terminal_unknown(state: &HistorianDurableState) -> bool {
    record(state).is_some_and(|record| terminal(&record))
}

pub(crate) fn redispatch_blocked(state: &HistorianDurableState, now: i64) -> bool {
    record(state).is_some_and(|record| {
        terminal(&record)
            && (now
                < record["recovery"]["fence_expires_at_ms"]
                    .as_i64()
                    .unwrap_or(i64::MAX)
                || state
                    .failure_backoff_at_ms
                    .is_some_and(|deadline| now < deadline))
    })
}

fn with_record(mut state: HistorianDurableState, record: &Value) -> HistorianDurableState {
    state.producer_run_id = Some(format!("{PREFIX}{record}"));
    state
}

fn unknown_error() -> HistorianDriveError {
    HistorianProducerError::Subc(ProducerErrorBody::untagged(
        "historian_outcome_unknown",
        "historian recovery budget exhausted; original send is fenced",
    ))
    .into()
}

fn write_owned(
    store: &McStore,
    session: &str,
    previous: &HistorianDurableState,
    mut next: HistorianDurableState,
) -> Result<(), HistorianDriveError> {
    let loaded = store.load_meta(session)?;
    let current = &loaded.meta.historian;
    if current.state != previous.state
        || current.firing_seq != previous.firing_seq
        || current.producer_run_id != previous.producer_run_id
    {
        return Err(HistorianStateError::InvalidTransition {
            from: current.state.clone(),
            event: "stale_unknown_observation",
        }
        .into());
    }
    next.recent_decisions = current.recent_decisions.clone();
    next.last_no_fire = current.last_no_fire.clone();
    let mut meta = loaded.meta;
    meta.historian = next.clone();
    store.commit_meta(session, loaded.row_version, &meta)?;
    if next.state == HistorianPhase::Idle {
        crate::historian_stage::finish_idle_stage(store, session, next.firing_seq)
            .map_err(|error| mc_store::single_store_domain::context_error(error.code(), error))?;
    }
    Ok(())
}

fn tombstone(
    store: &McStore,
    session: &str,
    state: &HistorianDurableState,
    mut record: Value,
    backoff: i64,
) -> Result<HistorianDurableState, HistorianDriveError> {
    let key = record["request"]["params"]["send_id"]
        .as_str()
        .unwrap_or("unknown")
        .to_owned();
    record["stage_key"] = json!(key);
    // Retain the provider session id, original send key and recovery budget, but
    // remove the original prompt and system text from the terminal record.
    record.as_object_mut().unwrap().remove("request");
    record["recovery"]["terminal_unknown"] = json!(true);
    let mut next = with_record(abandon_with_detail(state, backoff,
        Some(format!("historian_outcome_unknown: recovery exhausted for {key}; attempts={}, expiry={}, no redispatch before {}",
            record["recovery"]["attempts"], record["recovery"]["expires_at_ms"], record["recovery"]["fence_expires_at_ms"]))), &record);
    next.producer_session_id = state.producer_session_id.clone();
    write_owned(store, session, state, next.clone())?;
    tracing::warn!(session_id=session, firing_seq=state.firing_seq, stage_key=%key,
        attempts=%record["recovery"]["attempts"], expiry=%record["recovery"]["fence_expires_at_ms"],
        "historian unknown-send tombstone recorded");
    Ok(next)
}

/// Each probe waits for the outcome of the already-accepted session.send, keeping
/// its original send_id. Count probes before contacting the transport so restart
/// cannot reset them. Waiting ends after three probes or the historian timeout
/// configured at dispatch. A fresh send waits until max(2 * that timeout,
/// 30 minutes) from dispatch.
pub(crate) fn reserve_probe(
    store: &McStore,
    session: &str,
    state: &HistorianDurableState,
    now: i64,
    timeout: Duration,
    backoff: i64,
) -> Result<HistorianDurableState, HistorianDriveError> {
    let Some(mut record) = record(state) else {
        return Ok(state.clone());
    };
    if terminal(&record) {
        return Err(unknown_error());
    }
    if !record["recovery"].is_object() {
        let timeout_ms = timeout.as_millis().min(i64::MAX as u128) as i64;
        let started = state.fired_at_ms.unwrap_or(now);
        record["recovery"] = json!({"attempts":0,
            "expires_at_ms":started.saturating_add(timeout_ms.max(1)),
            "fence_expires_at_ms":started.saturating_add(timeout_ms.saturating_mul(2).max(UNKNOWN_FENCE_FLOOR_MS)),
            "terminal_unknown":false});
    }
    let attempts = record["recovery"]["attempts"]
        .as_u64()
        .unwrap_or(MAX_UNKNOWN_PROBES);
    if attempts >= MAX_UNKNOWN_PROBES
        || now >= record["recovery"]["expires_at_ms"].as_i64().unwrap_or(now)
    {
        tombstone(store, session, state, record, backoff)?;
        return Err(unknown_error());
    }
    record["recovery"]["attempts"] = json!(attempts + 1);
    let next = with_record(state.clone(), &record);
    write_owned(store, session, state, next.clone())?;
    Ok(next)
}

pub(crate) fn probe_wait_budget(
    state: &HistorianDurableState,
    now: i64,
    timeout: Duration,
) -> Duration {
    record(state)
        .and_then(|record| record["recovery"]["expires_at_ms"].as_i64())
        .map_or(timeout, |expiry| {
            timeout.min(Duration::from_millis(
                expiry.saturating_sub(now).max(0) as u64
            ))
        })
}

pub(crate) fn probe_failed(
    store: &McStore,
    session: &str,
    state: &HistorianDurableState,
    now: i64,
    backoff: i64,
) -> Result<(), HistorianDriveError> {
    let Some(record) = record(state) else {
        return Ok(());
    };
    if !terminal(&record)
        && (record["recovery"]["attempts"]
            .as_u64()
            .unwrap_or(MAX_UNKNOWN_PROBES)
            >= MAX_UNKNOWN_PROBES
            || now >= record["recovery"]["expires_at_ms"].as_i64().unwrap_or(now))
    {
        tombstone(store, session, state, record, backoff)?;
    }
    Ok(())
}

pub(crate) fn reject_retired_reattach(
    state: &HistorianDurableState,
) -> Result<(), HistorianDriveError> {
    if state.state == HistorianPhase::Idle && is_terminal_unknown(state) {
        return Err(unknown_error());
    }
    Ok(())
}

pub(crate) fn log_release(previous: &HistorianDurableState, session: &str, now: i64) {
    if is_terminal_unknown(previous) && !redispatch_blocked(previous, now) {
        let record = record(previous).unwrap();
        tracing::info!(session_id=session, firing_seq=previous.firing_seq, stage_key=%record["stage_key"],
            "historian unknown-send tombstone released");
    }
}

pub(crate) fn is_unknown_handle(state: &HistorianDurableState) -> bool {
    state
        .producer_run_id
        .as_deref()
        .is_some_and(is_stage_submission)
}
