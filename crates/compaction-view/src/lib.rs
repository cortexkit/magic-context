//! The view library of the compaction contract: everything a runner and a
//! compaction provider must compute the same way.
//!
//! A runner renders every request from a view, and the provider decides
//! what goes into the view from what that rendering will be. If the two
//! computed it separately, they would drift, and a provider would plan
//! against a request the model never receives. So both call these functions:
//! - [`render::plan`]: what a runner renders, as keep, drop and replace
//!   instructions over its own host messages plus the inserted messages, with
//!   every refusal a malformed view earns;
//! - [`render::apply`] and [`render::apply_edits`]: the same result in the
//!   neutral part model, which is what the provider plans against;
//! - [`render::check_carried`]: that each edit of a new view claims an honest
//!   `since`, so no new edit is hidden from the rule check by backdating it.
//!   It does not check that the view carries every earlier edit (compaction contract V2): an
//!   edit also leaves when a later cut covers its message or a revert removes
//!   it, and only the provider holds those rules, so carrying edits forward
//!   is the provider's obligation;
//! - [`rules::check`]: whether a view keeps every signed part valid under the
//!   rules the runner declared, and [`rules::defaults`] for a model;
//! - [`tags`]: which parts take a number, how a runner counts them and how it
//!   writes them;
//! - [`clean::clean_reply`]: how a runner removes tag notation from a model's
//!   reply before storing it.
//!
//! The wire types live in the contract crate, `cortexkit-role-compaction`;
//! this library depends on it. A runner written in
//! another language uses the WebAssembly build of this library, or checks
//! its own implementation against the JSON test vectors under `vectors/`.
//!
//! A reference such as "(compaction contract W1.3)" names a rule of that
//! contract by its id in CONTRACT.md, which ships in the
//! `cortexkit-role-compaction` crate.

#![forbid(unsafe_code)]

/// The version of what a runner renders from a transcript and a view: tag
/// numbers, reply cleaning, the tag prefix, the label of a result with only
/// attachments, and what each edit does to the rendered messages. It changes
/// whenever some input could render different bytes. A runner that must
/// resume a run with exactly the bytes it sent before records it when the
/// run starts, and refuses to resume under another. A test pins each version
/// to a checksum of what the rendering vectors produce, so rendered bytes
/// cannot change without a new version.
pub const PLAN_VERSION: u32 = 1;

pub mod clean;
pub mod render;
pub mod rules;
pub mod tags;
pub mod vectors;

#[cfg(test)]
mod tests;
