//! The dreamer: background tasks that keep memories accurate and useful
//! between sessions (classify, curate, verify against the code, review what
//! the person's sessions show about them, and so on).
//!
//! Each task kind comes from the memory profile a project or the person
//! resolved, and runs on a schedule. One run is one child session on a model
//! routing picks ([`run`]); its reply proposes changes, and nothing it
//! proposes is written until it passes the task's own checks.

pub mod cron;
pub mod engine;
pub mod run;
pub mod store;
// What a task kind reads and writes is used by the task kinds, and none is
// registered on this branch yet; the expectation fails once one is.
#[expect(dead_code, reason = "no task kind is registered yet")]
pub mod task;

/// Every task kind the module runs. A profile's task of any other kind is
/// not scheduled.
pub(crate) fn tasks() -> Vec<Box<dyn task::Task>> {
    Vec::new()
}
