//! Sync of new memories to Engram (spec 3c, ML3). A memory's create is queued
//! in the transaction that wrote it; a background task appends queued ops to
//! the device's stream later. Appending changes only the sync tables, never a
//! view, `m[0]`, `m[1]` or a fold. Updates, archives and merges are not
//! synced. Ported from the memory-levels card
//! (`crates/mc-module/src/memory_sync/` at `75adf757`).

mod account;
mod engram;
mod hlc;
mod jcs;
mod ledger;
mod op;
mod outbox;

use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};
use tokio::sync::Notify;

use crate::client::RunnerClient;
use crate::context_db::ContextDb;
use crate::memory_levels::{CreateEvent, CreateKind};

/// How long one Engram call may take.
pub const ENGRAM_DEADLINE: Duration = Duration::from_secs(5);
const IDLE_REFRESH: Duration = Duration::from_secs(15 * 60);
const INITIAL_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30 * 60);

/// Wakes the background task when a create was queued.
fn work() -> &'static Notify {
    static WORK: OnceLock<Notify> = OnceLock::new();
    WORK.get_or_init(Notify::new)
}

/// Queue a new memory's op, in the caller's transaction (ML3.1). A create
/// that cannot be synced is logged with its reason and changes nothing; a
/// failure to write the sync rows fails the caller's whole write.
pub(crate) fn queue(conn: &Connection, event: &CreateEvent, now: i64) -> rusqlite::Result<()> {
    match queue_reason(conn, event, now)? {
        None => work().notify_one(),
        // A survivor is never synced; that is not worth a log line.
        Some(_) if event.kind == CreateKind::MergeSurvivor => {}
        Some(reason) => eprintln!("ck-mc: memory {} is not synced: {reason}", event.memory_id),
    }
    Ok(())
}

fn queue_reason(
    conn: &Connection,
    event: &CreateEvent,
    now: i64,
) -> rusqlite::Result<Option<&'static str>> {
    if event.kind == CreateKind::MergeSurvivor {
        return Ok(Some("merge_survivor"));
    }
    if event.owner.is_none() || event.writer_project_id.is_none() {
        return Ok(Some("owner_unknown"));
    }
    if !op::eligible(event) {
        return Ok(Some("not_eligible"));
    }
    let Some(account) = account::cached(conn)? else {
        return Ok(Some("unknown"));
    };
    if account.state != "enrolled" {
        return Ok(Some(match account.state.as_str() {
            "not_enrolled" => "not_enrolled",
            "credential_invalid" => "credential_invalid",
            _ => "unknown",
        }));
    }
    let Some(state) = ledger::sync_state(conn, &account.device)? else {
        return Ok(Some("unknown"));
    };
    let Some(clock) = hlc::next(now, state.hlc_wall_ms, state.hlc_logical) else {
        return Ok(Some("op_unmappable"));
    };
    let Some(next) = state.next_local_id.checked_add(1) else {
        return Ok(Some("op_unmappable"));
    };
    let bytes = match op::map(
        event,
        &account.account,
        &account.device,
        state.next_local_id,
        clock,
    ) {
        Ok(bytes) => bytes,
        Err(reason) => return Ok(Some(reason)),
    };
    ledger::append_op(
        conn,
        &account.account,
        &account.device,
        state.next_local_id,
        event,
        &jcs::digest(&bytes),
        &bytes,
        now,
    )?;
    ledger::enqueue(conn, &account.account, &account.device, state.next_local_id)?;
    ledger::advance(
        conn,
        &account.account,
        &account.device,
        next,
        clock.0,
        clock.1,
    )?;
    Ok(None)
}

/// Run `write` in a short transaction of its own on `context.db`.
fn transaction(
    db: &ContextDb,
    write: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        write(&tx)?;
        tx.commit()
    })
    .map_err(|error| error.to_string())
}

/// The background task: append queued ops until none is left, then wait for
/// a new create or the idle refresh (ML3.3). Never returns.
pub(crate) async fn run<C: RunnerClient>(client: &C, db: &ContextDb) {
    let holder = format!("{}-{}", std::process::id(), crate::memory_writes::now_ms());
    let mut retry = INITIAL_RETRY;
    loop {
        let result = cycle(&engram::Wire(client), db, &holder).await;
        let (inactive, pending) = match scheduling_state(db) {
            Ok(state) => state,
            Err(error) => {
                eprintln!("ck-mc: memory sync: {error}");
                (false, true)
            }
        };
        if let Err(error) = &result {
            eprintln!("ck-mc: memory sync: {error}");
        }
        let delay = if inactive {
            retry = MAX_RETRY;
            MAX_RETRY
        } else if result.is_ok() && !pending {
            retry = INITIAL_RETRY;
            IDLE_REFRESH
        } else {
            let delay = retry;
            retry = retry.saturating_mul(2).min(MAX_RETRY);
            delay
        };
        let deadline = tokio::time::Instant::now() + delay;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                _ = work().notified() => {
                    // A wake may describe work the last cycle already
                    // appended, or a create that rolled back; neither is
                    // worth a heads refresh.
                    match scheduling_state(db) {
                        Ok((_, true)) => break,
                        Ok((_, false)) => {}
                        Err(_) => break,
                    }
                }
            }
        }
    }
}

/// Whether the account is inactive, and whether ops wait to be appended.
fn scheduling_state(db: &ContextDb) -> Result<(bool, bool), String> {
    let mut state = (false, false);
    transaction(db, &mut |conn| {
        let Some(account) = account::cached(conn)? else {
            return Ok(());
        };
        let inactive = matches!(
            account.state.as_str(),
            "not_enrolled" | "credential_invalid"
        );
        let pending = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_outbox WHERE account = ?1 AND device = ?2
                 AND appended_seq IS NULL AND coalesce(last_error, '') != 'seq_reused')",
            rusqlite::params![account.account, account.device],
            |row| row.get(0),
        )?;
        state = (inactive, pending);
        Ok(())
    })?;
    Ok(state)
}

async fn cycle<E: engram::Engram>(wire: &E, db: &ContextDb, holder: &str) -> Result<(), String> {
    // An uncertain append owns its sequence: the heads refresh waits until
    // that exact append is retried after a lost answer.
    let mut uncertain = false;
    transaction(db, &mut |conn| {
        uncertain = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_outbox q JOIN memory_sync_state s USING(device)
                 WHERE s.enrollment_state = 'enrolled' AND q.pending_seq IS NOT NULL AND q.appended_seq IS NULL)",
            [],
            |row| row.get(0),
        )?;
        Ok(())
    })?;
    if !uncertain {
        let heads = wire.heads().await;
        transaction(db, &mut |conn| account::refresh(conn, &heads))?;
        heads?;
    }
    let result = outbox::drain(
        wire,
        |write| transaction(db, write),
        holder,
        crate::memory_writes::now_ms(),
    )
    .await;
    if let Err(error) = &result {
        transaction(db, &mut |conn| account::refresh(conn, &Err(error.clone())))?;
    }
    result
}

#[cfg(test)]
mod tests;
