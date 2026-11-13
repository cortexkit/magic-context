//! The dreamer's task kinds. Each implements [`super::task::Task`]: it reads
//! its owner's rows, splits the work into batches, and writes what an
//! accepted reply proposes once the reply passes the kind's own checks.

pub mod classify;
pub mod compress_cues;
