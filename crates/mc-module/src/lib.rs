//! Magic Context as a compaction provider for llm-runners (ck-mc).
//!
//! A runner holds a session's transcript and renders every request. This
//! module decides how that history is shortened and says so as views: lists of
//! edits the runner applies before every request (see the
//! `cortexkit-role-compaction` contract crate).
//! Between two views the runner sends exactly what it sent before plus what is
//! new, so the provider's prompt cache keeps hitting; a new view rewrites the
//! cache once, so a view is only built on a pass that may pay for that.
//!
//! Per session, ck-mc keeps an index of the transcript in compact form
//! ([`index`]), the views it published, and the work it holds for the next
//! view (such as parts the model asked to drop). Everything a session receives
//! (notices, rides, tool calls) runs in order on that session's own worker
//! ([`module`]), so one slow session never holds up another.
//!
//! A pass ([`pass`]) decides whether the session may rebuild now; when it may,
//! every lane with work adds its edits ([`lanes`]) and one view carries them
//! ([`view_builder`]).
//!
//! Terms used throughout:
//! - **Pass:** one decision on a notice or a ride about whether a new view is
//!   built now. A **ride** is the runner telling ck-mc, before a request,
//!   that the request rewrites the provider's cache anyway (or would not fit),
//!   so held work can land in it at no extra cost.
//! - **Lane:** one kind of reduction (queued `ctx_reduce` drops, the age
//!   sweep, reasoning clearing, emergency drops, ...).
//! - **History head:** the two messages a head's view inserts at the start of
//!   the request. `m[0]` is the baseline: docs, the user profile, memories and
//!   the summaries as of the last **fold**, the rebuild that re-renders it.
//!   `m[1]` holds what changed since: newer summaries and memory changes.
//! - **Standalone:** the Magic Context plugin running inside a host
//!   (`packages/plugin`), whose behaviour mode 3 matches.
//!
//! A reference such as "(compaction contract W1.3)" names a rule of that
//! contract by its id in CONTRACT.md, which ships in the
//! `cortexkit-role-compaction` crate.

#![forbid(unsafe_code)]

pub mod calibration;
pub mod catalog;
pub mod caveman;
pub mod child_scopes;
pub mod client;
pub mod config;
pub mod content_language;
pub mod context_db;
pub mod decay;
pub mod embedding;
pub mod expand;
pub mod index;
pub mod injection;
pub mod js_text;
pub mod lanes;
pub mod memory;
pub mod memory_tool;
pub mod memory_writes;
pub mod module;
pub mod move_in;
pub mod mural;
pub mod neutral;
pub mod notes;
pub mod nudges;
pub mod pass;
pub mod pre_user;
pub mod preset;
pub mod project_docs;
pub mod reads;
pub mod reduce;
pub mod route;
pub mod routing;
pub mod search;
pub mod session;
pub mod store;
pub mod summary;
pub mod tokens;
pub mod transport;
pub mod upkeep;
pub mod view_builder;

/// Magic Context's module id, as runners and core name it.
pub const MODULE_ID: &str = "magic-context";

/// The version line ck-mc reports: its package version, and the commit it
/// was built from when the build set `MC_BUILD_SHA`.
pub fn version_line() -> String {
    match option_env!("MC_BUILD_SHA")
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
    {
        Some(sha) => format!("ck-mc {} ({sha})", env!("CARGO_PKG_VERSION")),
        None => format!("ck-mc {}", env!("CARGO_PKG_VERSION")),
    }
}
