//! Summaries: the summarizer that turns older messages into stored
//! summaries, and the history head that shows them to the model.
//!
//! The parsing, checks, prompt and rendering here are ported from the
//! TypeScript plugin and pinned against its goldens in `testdata/`.

pub mod chunk;
pub mod drain;
pub mod fit;
pub mod head;
pub mod prompt;
pub mod render;
pub mod run;
pub mod trigger;
pub mod validate;
