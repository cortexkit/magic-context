//! Draft of the cleaned runner and compaction contracts (0.8.0).
//!
//! A runner holds a session's transcript and renders every request to the
//! model. A compaction provider decides how that history is shortened, and
//! says so as a view: a list of edits the runner applies to its transcript
//! before every request. The runner knows nothing about how history should
//! be edited; it applies a view exactly as written, or refuses it by name.
//!
//! What flows between them:
//! - the runner presents its transcript in one neutral part model
//!   ([`part`], [`read`]), whatever its host stores, so a provider needs no
//!   decoder per harness;
//! - the runner calls Setup once per session ([`setup`]), wakes the provider
//!   after every durable write with a small notice ([`notice`]), and asks for
//!   a view synchronously before a request that rewrites its cache anyway or
//!   would not fit ([`ride`]);
//! - the provider publishes views ([`view`]); the runner fetches one, checks
//!   it against the provider rules it declared ([`rules`]), stores it, and
//!   applies it until a newer one arrives.
//!
//! [`view::apply`] and [`rules::check`] are shared on purpose: the runner
//! renders with them, and the provider uses the same functions to know
//! exactly what the model sees.

#![forbid(unsafe_code)]

pub mod digest;
pub mod notice;
pub mod part;
pub mod read;
pub mod ride;
pub mod rules;
pub mod setup;
pub mod view;

#[cfg(test)]
mod tests;

/// The capability a compaction provider lists in its manifest. The major is
/// new because every op below changed shape incompatibly.
pub const COMPACTION_PROVIDES: &str = "compaction-provider/v2";

/// The capability a runner declares when it serves neutral reads
/// (`session.read` in the [`read`] shape) and `view.current`.
pub const RUNNER_NEUTRAL_READS: &str = "neutral-reads/v1";

/// Names of the ops, used as the `method` of the request that carries them.
pub mod ops {
    /// Served by the provider: start managing a session ([`crate::setup`]).
    pub const COMPACTION_SETUP: &str = "compaction.setup";
    /// Served by the provider: the runner asks for a view now ([`crate::ride`]).
    pub const COMPACTION_RIDE: &str = "compaction.ride";
    /// Served by the provider: fetch a published view by version.
    pub const VIEW_GET: &str = "view.get";
    /// Served by the runner: read transcript entries ([`crate::read`]).
    pub const SESSION_READ: &str = "session.read";
    /// Served by the runner: the view it currently applies, for a provider
    /// whose own copy is missing or older (for example after a store restore).
    pub const VIEW_CURRENT: &str = "view.current";
}
