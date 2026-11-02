//! A reference runner for the mode-3 contract draft (`ck-contract-draft`).
//!
//! It does what a real runner does for a compaction provider, and nothing
//! more: it holds the transcript and its tag numbers ([`transcript`]), renders
//! every request by applying the current view, checks each new view before
//! storing it, asks for a view before a request that would lose the prompt
//! cache or not fit, and refuses rather than send over its limit
//! ([`runner`]). A scripted agent decides what the model "does" each step
//! ([`script`]), so every run is deterministic, and mock model providers
//! ([`model`]) answer the way the real ones would: they count tokens, keep a
//! prompt cache with expiry, and reject a request whose signed reasoning no
//! longer matches what came before it.
//!
//! The mock providers check the provider rules on their own, from the
//! rendered request, without using `cortexkit_role_compaction::rules`. So when a
//! compaction provider's view passes the contract's checker but would fail at
//! a real provider, the scenario fails here too.

#![forbid(unsafe_code)]

pub mod child;
pub mod model;
pub mod runner;
pub mod script;
pub mod subc;
pub mod tokens;
pub mod transcript;

#[cfg(test)]
mod runner_tests;
