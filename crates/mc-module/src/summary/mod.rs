//! Summaries: the summarizer that turns older messages into stored
//! summaries, and the history head that shows them to the model.
//!
//! The parsing, checks, prompt and rendering here are ported from the
//! TypeScript plugin and pinned against its goldens in `testdata/`.

pub mod account_wait;
pub mod chunk;
pub(crate) mod dates;
pub mod drain;
pub(crate) mod due;
pub mod fit;
pub mod hashes;
pub mod head;
pub mod index;
pub(crate) mod line;
pub mod prompt;
pub mod prompts;
pub mod render;
#[cfg(test)]
pub(crate) mod render_before_line;
pub mod run;
pub(crate) mod telemetry;
pub mod trigger;
pub mod two_pass;
pub mod validate;

#[cfg(test)]
mod line_replay_tests;
#[cfg(test)]
mod line_tests;
#[cfg(test)]
mod render_line_tests;
#[cfg(test)]
mod replay_tests;
