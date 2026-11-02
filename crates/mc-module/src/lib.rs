//! Magic Context as a compaction provider for llm-runners (ck-mc).
//!
//! A runner holds a session's transcript and renders every request. This
//! module decides how that history is shortened and says so as views: lists of
//! edits the runner applies before every request (see `ck-contract-draft`).
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

#![forbid(unsafe_code)]

pub mod calibration;
pub mod client;
pub mod config;
pub mod content_language;
pub mod context_db;
pub mod decay;
pub mod embedding;
pub mod expand;
pub mod index;
pub mod js_text;
pub mod lanes;
pub mod memory;
pub mod memory_tool;
pub mod memory_writes;
pub mod module;
pub mod notes;
pub mod pass;
pub mod preset;
pub mod project_docs;
pub mod reads;
pub mod reduce;
pub mod search;
pub mod session;
pub mod store;
pub mod summary;
pub mod tokens;
pub mod transport;
pub mod view_builder;
