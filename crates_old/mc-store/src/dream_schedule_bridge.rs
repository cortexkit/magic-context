//! Keep the TypeScript dreamer's `task_schedule_state` row and the Rust
//! scheduler's row for the same task in step.
//!
//! The two runtimes schedule from separate rows, and ownership of a task moves
//! between them when the user flips `rust_background_enabled` or a claimant comes
//! and goes. The TypeScript scheduler runs a task once `next_due_at` has passed and
//! moves `next_due_at` past the slot it ran, so the later `next_due_at` is the
//! progress both must respect. Before a Rust tick the Rust row adopts the
//! TypeScript row's progress (`SqliteDreamScheduler::adopt_legacy`); after a Rust
//! run the TypeScript row adopts the Rust row's progress here. Each side only ever
//! moves forward, so a flip inside one cron period neither repeats nor skips a run.

use crate::dream_scheduler::schedules::{LegacySchedule, ScheduleState, TaskName};
use crate::{McStore, McStoreError};
use rusqlite::{params, OptionalExtension};

impl McStore {
    /// The TypeScript scheduler's row for `task` in `project`, or `None` when it
    /// never seeded one.
    pub fn legacy_task_schedule(
        &self,
        project: &str,
        task: TaskName,
    ) -> Result<Option<LegacySchedule>, McStoreError> {
        self.context_read(|db| {
            db.query_row(
                "SELECT last_run_at,next_due_at,schedule FROM task_schedule_state WHERE project_path=?1 AND task=?2",
                params![project, task.as_str()],
                |r| {
                    Ok(LegacySchedule {
                        last_run_at: r.get(0)?,
                        next_due_at: r.get(1)?,
                        schedule: r.get(2)?,
                    })
                },
            )
            .optional()
        })
    }

    /// Record a Rust run's schedule progress in the TypeScript row, so that the
    /// TypeScript scheduler does not run the task again in the same period after
    /// ownership returns to it. A TypeScript row that is already further ahead is
    /// left alone; task cursors stored in the same row are never touched. Returns
    /// whether the row was written.
    pub fn publish_task_schedule(
        &self,
        project: &str,
        task: TaskName,
        state: &ScheduleState,
    ) -> Result<bool, McStoreError> {
        let Some(next_due_at) = state.next_due_at else {
            return Ok(false);
        };
        self.context_write(&["task_schedule_state"], |tx| {
            let prior: Option<(Option<i64>, Option<i64>)> = tx
                .query_row(
                    "SELECT last_run_at,next_due_at FROM task_schedule_state WHERE project_path=?1 AND task=?2",
                    params![project, task.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (prior_run, prior_due) = prior.unwrap_or((None, None));
            if prior_due.is_some_and(|due| due > next_due_at) {
                return Ok(false);
            }
            let last_run_at = prior_run.max(state.last_run_at);
            tx.execute(
                "INSERT INTO task_schedule_state(project_path,task,last_run_at,next_due_at,schedule,last_status,last_error,retry_count)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(project_path,task) DO UPDATE SET
                   last_run_at=excluded.last_run_at, next_due_at=excluded.next_due_at,
                   schedule=excluded.schedule, last_status=excluded.last_status,
                   last_error=excluded.last_error, retry_count=excluded.retry_count",
                params![
                    project,
                    task.as_str(),
                    last_run_at,
                    next_due_at,
                    state.schedule,
                    state.last_status.map(|s| s.as_str()),
                    state.last_error,
                    state.retry_count,
                ],
            )?;
            Ok(true)
        })
    }
}

#[cfg(test)]
#[path = "dream_schedule_bridge_tests.rs"]
mod tests;
