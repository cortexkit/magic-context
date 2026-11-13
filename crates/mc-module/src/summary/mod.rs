//! Summaries: the summarizer that turns older messages into stored
//! summaries, and the history head that shows them to the model.
//!
//! The parsing, checks, prompt and rendering here are ported from the
//! TypeScript plugin and pinned against its goldens in `testdata/`.

pub mod account_wait;
pub mod chunk;
pub mod drain;
pub(crate) mod due;
pub mod fit;
pub mod hashes;
pub mod head;
pub mod prompt;
pub mod render;
pub mod run;
pub mod trigger;
pub mod two_pass;
pub mod validate;
