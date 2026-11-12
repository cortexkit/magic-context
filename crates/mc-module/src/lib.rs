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
//!   that the request's bytes before the conversation change anyway (or it
//!   would not fit), so held work can land in it at no extra cost. A ride
//!   that only says the provider forgot its cache lands nothing by itself
//!   ([`pass::RideCauseKind`]).
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

// Unsafe is forbidden off Windows. Only Windows-only FFI without a safe standard
// library equivalent may opt in locally, with a SAFETY comment for every call;
// unsafe is otherwise rejected throughout the crate.
#![cfg_attr(not(windows), forbid(unsafe_code))]
#![cfg_attr(windows, deny(unsafe_code))]

pub mod agent_data;
pub mod app_read;
pub mod calibration;
pub mod catalog;
pub mod caveman;
pub mod child_scopes;
mod chunk_embedding;
pub mod client;
pub mod config;
pub mod content_language;
pub mod context_db;
pub mod context_read;
pub mod count;
pub mod decay;
pub mod embedding;
pub mod expand;
pub mod index;
pub mod injection;
pub mod js_text;
pub mod lanes;
pub mod memory;
pub(crate) mod memory_context;
pub mod memory_levels;
pub mod memory_profile;
pub(crate) mod memory_sync;
pub mod memory_tool;
pub mod memory_writes;
pub mod module;
mod move_batches;
pub mod move_in;
pub mod move_renumber;
pub mod mural;
pub mod neutral;
pub mod notes;
pub mod notice_cost_timing;
pub mod nudges;
pub mod pass;
pub mod pre_user;
pub mod preset;
pub mod project_docs;
pub mod prompt_notes;
pub mod reads;
pub mod reduce;
pub mod rekey;
pub mod route;
pub mod routing;
pub mod runner_capabilities;
pub mod search;
pub mod session;
pub mod store;
mod store_text;
pub mod summary;
pub mod tokens;
pub mod transport;
pub mod upkeep;
pub mod view_builder;
pub mod workspace;

/// Magic Context's module id, as runners and core name it.
pub const MODULE_ID: &str = "magic-context";

pub mod engram_catalog;
pub mod private_permissions;
pub mod storage_paths;
#[cfg(test)]
pub(crate) mod test_log;

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
