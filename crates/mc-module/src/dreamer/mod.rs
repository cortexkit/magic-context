//! The dreamer: background tasks that keep memories accurate and useful
//! between sessions (classify, curate, verify against the code, review what
//! the person's sessions show about them, and so on).
//!
//! Each task kind comes from the memory profile a project or the person
//! resolved, and runs on a schedule ([`engine`]). One message of a run goes
//! to a model routing picks ([`run`]); its reply proposes changes, and
//! nothing it proposes is written until it passes the task's own checks.

pub mod cron;
pub mod engine;
pub mod run;
pub mod store;
pub mod task;
pub mod tasks;

/// Every task kind the module runs. A profile's task of any other kind is
/// not scheduled.
pub(crate) fn tasks() -> Vec<Box<dyn task::Task>> {
    vec![Box::new(tasks::classify::Classify)]
}
