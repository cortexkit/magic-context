//! The dreamer's task kinds. Each implements [`super::task::Task`]: it reads
//! its owner's rows, splits the work into batches, and writes what an
//! accepted reply proposes once the reply passes the kind's own checks.

pub mod classify;
pub mod compress_cues;
pub mod curate;
pub mod curate_workspace;
mod directive;
pub mod lift_workspace;
pub mod maintain_docs;
pub mod map_memories;
pub mod reflect_events;
pub mod refresh_primers;
pub mod review_user_memories;
pub mod verify;

/// Common eligibility for maintenance tasks that only work on live rows.
/// Queries using this predicate bind the same `:now` for their entire read.
const LIVE_MEMORY: &str = "status IN ('active', 'permanent') AND superseded_by_memory_id IS NULL
                           AND (expires_at IS NULL OR expires_at > :now)";
