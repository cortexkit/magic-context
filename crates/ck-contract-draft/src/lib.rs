//! Draft of the cleaned runner and compaction contracts (0.8.0).
//!
//! A runner holds a session's transcript and renders every request to the
//! model. A compaction provider decides how that history is shortened, and
//! says so as a view: a list of edits the runner applies to its transcript
//! before every request. The runner knows nothing about how history should
//! be edited; it applies a view exactly as written, or refuses it by name.
//!
//! Each side calls the other on a route bound to one session: the route's
//! bind identity names the session, the daemon attests the caller, and the
//! daemon's scope stamp names the session's folder and project. No request
//! body names a runner, a session or a project.
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
//! - the provider hands over new views with `session.apply_view` ([`view`]),
//!   or in a ride's answer; the runner
//!   checks each one against the rules it declared ([`rules`]), stores it, and
//!   applies it from the next step until a newer one arrives.
//!
//! This crate holds only what goes over the wire, plus the checksums that are
//! part of it ([`digest`]). How a view is rendered and checked lives in the
//! view library (`cortexkit-compaction-view`), which depends on this crate:
//! runners render with it, and providers use the same functions to know
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

/// The capability a compaction provider lists in its manifest. The major is
/// new because every op below changed shape incompatibly.
pub const COMPACTION_PROVIDES: &str = "compaction-provider/v2";

/// The role and version a runner declares when it opens a route for this
/// contract (`role_versions` on the route), so the provider knows which
/// contract the route speaks. Routes are per session and per role: a runner
/// opens one route for compaction, one for tools and one for hooks to the
/// same provider, each bound to the session's identity and scope.
pub const COMPACTION_ROLE: (&str, &str) = ("compaction-provider", "v2");

/// The capability a runner declares for its side of this contract:
/// `session.entries`, `session.apply_view` and `session.applied_view`. It
/// pairs with [`COMPACTION_PROVIDES`] by name; the name is new, so it starts
/// at v1.
pub const COMPACTION_RUNNER_PROVIDES: &str = "compaction-runner/v1";

/// The role a provider declares on the route it opens to the runner for this
/// contract's runner ops.
pub const COMPACTION_RUNNER_ROLE: (&str, &str) = ("compaction-runner", "v1");

/// The role a provider declares on the route it opens to the runner for the
/// llm-runner ops it uses as published (`session.send`, `run.result`). This
/// contract does not change llm-runner.
pub const LLM_RUNNER_ROLE: (&str, &str) = ("llm-runner", "v1");

/// Names of the ops, used as the `method` of the request that carries them.
/// The prefix names the side that serves the op: `compaction.*` the
/// compaction provider, `session.*` and `run.*` the runner.
pub mod ops {
    /// Served by the provider: start managing a session ([`crate::setup`]).
    pub const COMPACTION_SETUP: &str = "compaction.setup";
    /// Served by the provider: new entries were written ([`crate::notice`]).
    pub const COMPACTION_NOTICE: &str = "compaction.notice";
    /// Served by the provider: the runner asks for a view now ([`crate::ride`]).
    pub const COMPACTION_RIDE: &str = "compaction.ride";
    /// Served by the runner (compaction-runner): read transcript entries in
    /// the neutral part model ([`crate::read`]). A name of its own, so logs
    /// never show two shapes of llm-runner's `session.read`.
    pub const SESSION_ENTRIES: &str = "session.entries";
    /// Served by the runner (compaction-runner): take a new view
    /// ([`crate::view::ApplyViewRequest`]).
    pub const SESSION_APPLY_VIEW: &str = "session.apply_view";
    /// Served by the runner (compaction-runner): the view it applies now
    /// ([`crate::view::AppliedViewRequest`]).
    pub const SESSION_APPLIED_VIEW: &str = "session.applied_view";
    /// Served by the runner (llm-runner): queue text for the model, or start
    /// a run in a child session ([`crate::send`]).
    pub const SESSION_SEND: &str = "session.send";
    /// Served by the runner (llm-runner): a run's state and reply
    /// ([`crate::send`]).
    pub const RUN_RESULT: &str = "run.result";
}
