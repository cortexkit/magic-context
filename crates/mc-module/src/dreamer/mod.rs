//! The dreamer: background tasks that keep memories accurate and useful
//! between sessions (classify, curate, verify against the code, review what
//! the person's sessions show about them, and so on).
//!
//! Each task kind comes from the memory profile a project or the person
//! resolved, and runs on a schedule. One run is one child session on a model
//! routing picks ([`run`]); its reply proposes changes, and nothing it
//! proposes is written until it passes the task's own checks.

pub mod run;
pub mod task;
