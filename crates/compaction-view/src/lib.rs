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
//! - [`render::check_carried`]: that a new view repeats the edits of the view
//!   the runner applies now, so none is hidden from the rule check;
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

#![forbid(unsafe_code)]

pub mod clean;
pub mod render;
pub mod rules;
pub mod tags;
pub mod vectors;

#[cfg(test)]
mod tests;
