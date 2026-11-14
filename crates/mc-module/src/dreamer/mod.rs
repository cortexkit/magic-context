//! The dreamer: background tasks that keep memories accurate and useful
//! between sessions (classify, curate, verify against the code, review what
//! the person's sessions show about them, and so on).
//!
//! Each task kind comes from the memory profile a project or the person
//! resolved, and runs on a schedule ([`engine`]). One message of a run goes
//! to a model routing picks ([`run`]); its reply proposes changes, and
//! nothing it proposes is written until it passes the task's own checks.

pub mod checkout;
pub mod cron;
pub mod engine;
pub mod plan;
pub mod run;
pub mod store;
pub mod task;
pub mod tasks;

#[cfg(test)]
pub(crate) mod curate_replay_tests;
#[cfg(test)]
mod curate_workspace_replay_tests;
#[cfg(test)]
mod lift_replay_tests;
#[cfg(test)]
mod map_replay_tests;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
mod review_replay_tests;
#[cfg(test)]
mod verify_replay_tests;

/// Every task kind the module runs. A profile's task of any other kind is
/// not scheduled.
pub(crate) fn tasks() -> Vec<Box<dyn task::Task>> {
    vec![
        Box::new(tasks::classify::Classify),
        Box::new(tasks::compress_cues::CompressCues),
        Box::new(tasks::curate::Curate),
        Box::new(tasks::curate_workspace::CurateWorkspace),
        Box::new(tasks::lift_workspace::LiftWorkspace),
        Box::new(tasks::map_memories::MapMemories),
        Box::new(tasks::verify::Verify { broad: false }),
        Box::new(tasks::verify::Verify { broad: true }),
        Box::new(tasks::review_user_memories::ReviewUserMemories),
    ]
}
