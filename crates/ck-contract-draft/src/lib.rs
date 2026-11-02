//! Draft of the cleaned runner and compaction contracts (0.8.0).
//!
//! A runner holds a session's transcript and renders every request to the
//! model. A compaction provider decides how that history is shortened, and
//! says so as a view: a list of edits the runner applies to its transcript
//! before every request. The runner knows nothing about how history should
//! be edited; it applies a view exactly as written, or refuses it by name.
//!
//! What flows between them, all as calls over their routes:
//! - the runner presents its transcript in one neutral part model
//!   ([`part`], [`read`]), whatever its host stores, so a provider needs no
//!   decoder per harness;
//! - the runner calls Setup once per session ([`setup`]); after every durable
//!   write it sends a notice with the new entries in compact form
//!   ([`notice`]); and before a request that rewrites the model provider's
//!   prompt cache anyway, or that would not fit, it asks for a view and waits
//!   for the answer ([`ride`]);
//! - the provider sends new views with `view.publish` ([`view`]); the runner
//!   checks each one against the rules it declared ([`rules`]), stores it, and
//!   applies it from the next step until a newer one arrives.
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
pub mod send;
pub mod setup;
pub mod view;
pub mod wire;

#[cfg(test)]
mod tests;

/// The capability a compaction provider lists in its manifest. The major is
/// new because every op below changed shape incompatibly.
pub const COMPACTION_PROVIDES: &str = "compaction-provider/v2";

/// The capability a runner declares when it serves the runner-side ops below
/// in these shapes.
pub const RUNNER_NEUTRAL_READS: &str = "neutral-reads/v1";

/// Names of the ops, used as the `method` of the request that carries them.
pub mod ops {
    /// Served by the provider: start managing a session ([`crate::setup`]).
    pub const COMPACTION_SETUP: &str = "compaction.setup";
    /// Served by the provider: new entries were written ([`crate::notice`]).
    pub const COMPACTION_NOTICE: &str = "compaction.notice";
    /// Served by the provider: the runner asks for a view now ([`crate::ride`]).
    pub const COMPACTION_RIDE: &str = "compaction.ride";
    /// Served by the provider: fetch a view too large to send inline.
    pub const VIEW_GET: &str = "view.get";
    /// Served by the runner: read transcript entries ([`crate::read`]).
    pub const SESSION_READ: &str = "session.read";
    /// Served by the runner: take a new view ([`crate::view::ViewPublishRequest`]).
    pub const VIEW_PUBLISH: &str = "view.publish";
    /// Served by the runner: the view it currently applies, for a provider
    /// whose own copy is missing or older (for example after a store restore).
    pub const VIEW_CURRENT: &str = "view.current";
    /// Served by the runner: queue text for the model, or start a run in a
    /// child session ([`crate::send`]).
    pub const SESSION_SEND: &str = "session.send";
    /// Served by the runner: a run's state and reply ([`crate::send`]).
    pub const RUN_RESULT: &str = "run.result";
}
