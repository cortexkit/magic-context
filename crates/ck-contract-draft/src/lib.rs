//! A stand-in for llm-runner's `session.send` and `run.result`, in the subset
//! ck-mc uses: text queued for a session's model, and a model run in a child
//! session whose reply ck-mc reads back.
//!
//! The compaction contract itself is the published `cortexkit-role-compaction`
//! crate. These two ops belong to llm-runner, whose published types carry the
//! same requests in a richer shape (plans, runner parameters, delivery
//! orders); ck-mc and the mock runner use this smaller shape until they move
//! to those types, and then this crate goes.

#![forbid(unsafe_code)]

pub mod send;
