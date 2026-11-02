//! The two-pass historian (historian 2.5): turn one publishes summaries and
//! candidate facts, and turn two, in the same child conversation, reconciles
//! the candidates with the project's memories. Ported from the plugin's
//! `memory/turn-one-publication.ts`, `turn-two*.ts` and `lifecycle-*.ts`;
//! the rules are numbered in the mode 3 spec 3b.

pub mod constants;
pub mod envelope;
pub mod text;

#[cfg(test)]
mod tests;
