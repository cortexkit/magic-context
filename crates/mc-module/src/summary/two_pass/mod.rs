//! The two-pass historian: the summarizer's first turn publishes summaries
//! and candidate facts, each anchored to the lines that state it, and a
//! second turn in the same child conversation reconciles the candidates with
//! the project's memories, applying only edits that pass deterministic gates
//! and narrow model checks. Ported from the plugin's
//! `memory/turn-one-publication.ts`, `turn-two*.ts` and `lifecycle-*.ts`.

pub mod applier;
pub mod constants;
pub mod envelope;
pub mod gates;
pub mod text;
pub mod turn_one;
pub mod turn_two;

#[cfg(test)]
mod tests;
