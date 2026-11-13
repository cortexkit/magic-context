//! The dreamer's own rows in `context.db` (migration 107): each owner's
//! task schedules, the lock an owner's writer holds, and one record per
//! task run.
//!
//! An owner is a `(level, owner_id)` pair, the same pair memories are kept
//! under, so a task scheduled for a project and the memories it changes name
//! the project the same way.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::cron;

/// Whose memories a schedule, lock or run concerns.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OwnerKey {
    pub level: String,
    pub owner_id: String,
}

impl OwnerKey {
    pub fn project(id: &str) -> Self {
        Self {
            level: "project".into(),
            owner_id: id.into(),
        }
    }
}

/// A schedule that is due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Due {
    pub owner: OwnerKey,
    pub task: String,
    pub schedule: String,
    pub next_due_at: i64,
    pub failures: i64,
    pub watermark: Option<Value>,
}

/// Make sure `task` has a schedule row for `owner` under `schedule`.
///
/// A new row is due at the schedule's next slot after `now`. A row whose
/// schedule changed is moved to the new schedule's next slot, so an edited
/// setting takes effect without waiting out the old one. A task switched off
/// (an empty schedule) keeps its row with no due time, and its resume point.
pub fn ensure_schedule(
    conn: &Connection,
    owner: &OwnerKey,
    task: &str,
    schedule: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT schedule FROM dream_schedules WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
            params![owner.level, owner.owner_id, task],
            |row| row.get(0),
        )
        .optional()?;
    match stored {
        Some(stored) if stored == schedule => Ok(()),
        Some(_) => conn
            .execute(
                "UPDATE dream_schedules SET schedule = ?4, next_due_at = ?5
                  WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
                params![
                    owner.level,
                    owner.owner_id,
                    task,
                    schedule,
                    cron::next_due(schedule, now)
                ],
            )
            .map(drop),
        None => conn
            .execute(
                "INSERT INTO dream_schedules(level, owner_id, task, schedule, next_due_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    owner.level,
                    owner.owner_id,
                    task,
                    schedule,
                    cron::next_due(schedule, now)
                ],
            )
            .map(drop),
    }
}

/// The schedules due at `now`, oldest due time first.
pub fn due(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Due>> {
    conn.prepare(
        "SELECT level, owner_id, task, schedule, next_due_at, failures, watermark_json
           FROM dream_schedules
          WHERE next_due_at IS NOT NULL AND next_due_at <= ?1
          ORDER BY next_due_at, level, owner_id, task",
    )?
    .query_map([now], |row| {
        let watermark: Option<String> = row.get(6)?;
        Ok(Due {
            owner: OwnerKey {
                level: row.get(0)?,
                owner_id: row.get(1)?,
            },
            task: row.get(2)?,
            schedule: row.get(3)?,
            next_due_at: row.get(4)?,
            failures: row.get(5)?,
            watermark: watermark.and_then(|text| serde_json::from_str(&text).ok()),
        })
    })?
    .collect()
}

/// How a run left its schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settled {
    /// It ran (whether or not it changed anything): due at the next slot.
    Ran { status: &'static str },
    /// It failed: due at the next slot, with one more failure counted.
    Failed { error: String },
    /// An account or routing named a time to ask again: due then, or at the
    /// next slot if that comes first. Nothing is counted against the task.
    Waiting { until: i64, reason: String },
    /// It couldn't start here (the owner is locked by another writer, or its
    /// evidence is missing on this machine): due at the next slot.
    Skipped { reason: String },
}

/// Record how a run of `task` for `owner` ended, and when it is due next.
pub fn settle(
    conn: &Connection,
    owner: &OwnerKey,
    task: &str,
    settled: &Settled,
    watermark: Option<&Value>,
    now: i64,
) -> rusqlite::Result<()> {
    let schedule: Option<String> = conn
        .query_row(
            "SELECT schedule FROM dream_schedules WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
            params![owner.level, owner.owner_id, task],
            |row| row.get(0),
        )
        .optional()?;
    let Some(schedule) = schedule else {
        return Ok(());
    };
    let next_slot = cron::next_due(&schedule, now);
    let (status, error, next_due, failures) = match settled {
        Settled::Ran { status } => (*status, None, next_slot, "0"),
        Settled::Failed { error } => ("failed", Some(error.as_str()), next_slot, "failures + 1"),
        Settled::Waiting { until, reason } => (
            "waiting",
            Some(reason.as_str()),
            Some(next_slot.map_or(*until, |slot| slot.min(*until))),
            "failures",
        ),
        Settled::Skipped { reason } => ("skipped", Some(reason.as_str()), next_slot, "failures"),
    };
    let ran = matches!(settled, Settled::Ran { .. } | Settled::Failed { .. });
    conn.execute(
        &format!(
            "UPDATE dream_schedules
                SET last_status = ?4, last_error = ?5, next_due_at = ?6, failures = {failures},
                    last_run_at = CASE WHEN ?7 THEN ?8 ELSE last_run_at END,
                    watermark_json = COALESCE(?9, watermark_json)
              WHERE level = ?1 AND owner_id = ?2 AND task = ?3"
        ),
        params![
            owner.level,
            owner.owner_id,
            task,
            status,
            error,
            next_due,
            ran,
            now,
            watermark.map(Value::to_string)
        ],
    )
    .map(drop)
}

/// Take `owner`'s lock for `holder` until `expires_at`. Free, lapsed, or
/// already this holder's: taken. Held by another writer and unexpired:
/// `false`, and nothing changes.
pub fn lock(
    conn: &mut Connection,
    owner: &OwnerKey,
    holder: &str,
    task: &str,
    now: i64,
    expires_at: i64,
) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let held: Option<(String, i64)> = tx
        .query_row(
            "SELECT holder, expires_at FROM dream_locks WHERE level = ?1 AND owner_id = ?2",
            params![owner.level, owner.owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((other, until)) = held {
        if other != holder && until > now {
            return Ok(false);
        }
    }
    tx.execute(
        "INSERT INTO dream_locks(level, owner_id, holder, task, acquired_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(level, owner_id) DO UPDATE
            SET holder = excluded.holder, task = excluded.task,
                acquired_at = excluded.acquired_at, expires_at = excluded.expires_at",
        params![owner.level, owner.owner_id, holder, task, now, expires_at],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Extend `holder`'s lock on `owner`. `false` when it no longer holds it:
/// another writer took it after it lapsed, and this run must stop writing.
pub fn renew(
    conn: &Connection,
    owner: &OwnerKey,
    holder: &str,
    expires_at: i64,
) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE dream_locks SET expires_at = ?4 WHERE level = ?1 AND owner_id = ?2 AND holder = ?3",
        params![owner.level, owner.owner_id, holder, expires_at],
    )
    .map(|changed| changed == 1)
}

/// Release `holder`'s lock on `owner`, if it still holds it.
pub fn unlock(conn: &Connection, owner: &OwnerKey, holder: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM dream_locks WHERE level = ?1 AND owner_id = ?2 AND holder = ?3",
        params![owner.level, owner.owner_id, holder],
    )
    .map(drop)
}

/// A started run's record. Returns its id, which names its child sessions
/// and the history rows it writes.
pub fn start_run(
    conn: &Connection,
    owner: &OwnerKey,
    task: &str,
    kind: &str,
    profile: &str,
    now: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO dream_task_runs(task, kind, level, owner_id, profile, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![task, kind, owner.level, owner.owner_id, profile, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The schedule row of `task` for `owner`, due or not.
pub fn schedule_of(
    conn: &Connection,
    owner: &OwnerKey,
    task: &str,
) -> rusqlite::Result<Option<Due>> {
    conn.query_row(
        "SELECT schedule, next_due_at, failures, watermark_json FROM dream_schedules
          WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
        params![owner.level, owner.owner_id, task],
        |row| {
            let watermark: Option<String> = row.get(3)?;
            Ok(Due {
                owner: owner.clone(),
                task: task.to_owned(),
                schedule: row.get(0)?,
                next_due_at: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                failures: row.get(2)?,
                watermark: watermark.and_then(|text| serde_json::from_str(&text).ok()),
            })
        },
    )
    .optional()
}

/// Who holds `owner`'s lock at `now`, and for which task. A lapsed lock is
/// held by no one.
pub fn lock_holder(
    conn: &Connection,
    owner: &OwnerKey,
    now: i64,
) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT holder, task FROM dream_locks
          WHERE level = ?1 AND owner_id = ?2 AND expires_at > ?3",
        params![owner.level, owner.owner_id, now],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// How a run ended, for its record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunEnd {
    /// `applied`, `nothing_to_do`, `waiting`, `failed`, `budget_stopped` or
    /// `lock_lost`.
    pub outcome: String,
    pub failure_class: Option<String>,
    pub error: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub proposed: usize,
    pub applied: usize,
    pub dropped: Vec<String>,
    /// One entry per message sent: model, runner, child session and tokens.
    pub batches: Vec<Value>,
}

pub fn finish_run(conn: &Connection, id: i64, end: &RunEnd, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dream_task_runs
            SET ended_at = ?2, outcome = ?3, failure_class = ?4, error = ?5,
                input_tokens = ?6, output_tokens = ?7, proposed = ?8, applied = ?9,
                dropped_json = ?10, batches_json = ?11
          WHERE id = ?1",
        params![
            id,
            now,
            end.outcome,
            end.failure_class,
            end.error,
            end.input_tokens as i64,
            end.output_tokens as i64,
            end.proposed as i64,
            end.applied as i64,
            (!end.dropped.is_empty()).then(|| Value::from(end.dropped.clone()).to_string()),
            (!end.batches.is_empty()).then(|| Value::from(end.batches.clone()).to_string()),
        ],
    )
    .map(drop)
}

/// Close every run a stopped process left open. A run without an end was
/// interrupted: its applied batches stay written, and the task is due again
/// at its next slot.
pub fn close_interrupted(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE dream_task_runs SET ended_at = ?1, outcome = 'interrupted' WHERE ended_at IS NULL",
        [now],
    )
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
