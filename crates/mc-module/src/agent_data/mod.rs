//! Magic Context's side of moving a runner session between machines: the
//! `agent-data/v1` participant.
//!
//! Entorhinal moves an agent by asking every module that holds data for it
//! to stop that data at a cut, ship it through Engram's session door, and
//! bring it up on the other machine. A cut is one move attempt, which
//! Entorhinal identifies with a cut id that every step of the move names.
//! Engram's session door is Engram's service that carries a session's
//! snapshot from one machine to the other. For ck-mc a move covers, per runner
//! session, its summaries, session notes, project link, and the facts its
//! summarizer extracted that still wait for the summarizer's second turn to
//! reconcile them with project memory, all in `context.db`.
//!
//! While a session moves, nothing may change or read it half-way. The
//! [`journal`] records every move durably, and its [`gate`] refuses the
//! session on every surface: `session_moving` while it is frozen at the
//! source, staged or being installed at the receiver, and `session_moved`
//! once it was released to another machine. The journal is loaded and its
//! gate enforced in every build, before any session is served.
//!
//! Serving moves is a separate switch ([`switch`]): only with it on does
//! the manifest declare the `agent-data` service ([`service`]) and are its
//! requests served. A build with it off still enforces every move the
//! journal records.

pub mod busy;
pub mod gate;
pub mod install;
pub mod journal;
pub mod moved;
pub mod resolve;
pub mod service;
pub mod snapshot;

#[cfg(test)]
mod moved_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod snapshot_tests;
#[cfg(test)]
mod tests;

pub use gate::{Gate, Gated, SESSION_MOVED, SESSION_MOVING};
pub use journal::Journal;
pub use service::{Host, Probe, Service};

use std::path::Path;

/// The environment variable that turns serving moves on (`1`) or off (`0`)
/// in a build that lets it ([`ENV_HONOURED`]).
pub const ENV: &str = "MAGIC_CONTEXT_AGENT_DATA";

/// Whether this build serves moves when nothing says otherwise: the
/// `agent-data` Cargo feature, off by default.
pub const FEATURE: bool = cfg!(feature = "agent-data");

/// Whether this build reads [`ENV`]: builds with debug assertions (tests
/// and development) and builds with the feature. A release build without
/// the feature never serves moves, whatever its environment says, so
/// switching moves on for real is the owner's step, made by building with
/// the feature.
pub const ENV_HONOURED: bool = cfg!(debug_assertions) || FEATURE;

/// Whether moves are served, from the value of [`ENV`] if it is set.
/// `1` and `0` decide in a build that honours the variable; anything else,
/// or a build that does not, gets the feature's default.
pub fn switch(value: Option<&str>, env_honoured: bool, feature: bool) -> bool {
    match value {
        Some("1") if env_honoured => true,
        Some("0") if env_honoured => false,
        _ => feature,
    }
}

/// [`switch`] for this build and this process's environment, said in the
/// log so an operator can see why moves are on or off.
pub fn switch_from_environment() -> bool {
    let value = std::env::var(ENV).ok();
    let on = switch(value.as_deref(), ENV_HONOURED, FEATURE);
    match value.as_deref() {
        Some(value) if !ENV_HONOURED => tracing::warn!(
            "ck-mc: {ENV}={value} is ignored: this release build was made without the agent-data feature, so it never serves moves"
        ),
        Some(value) if value != "1" && value != "0" => tracing::warn!(
            "ck-mc: {ENV}={value} is neither 1 nor 0, so it is ignored and the build's default applies"
        ),
        _ => {}
    }
    if on {
        tracing::info!(
            "ck-mc: agent-data moves are on: the agent-data service is declared and served"
        );
    } else {
        tracing::info!("ck-mc: agent-data moves are off: the agent-data service is not declared, and moves already recorded stay enforced");
    }
    on
}

/// For the offline tools (`ck-mc move-in`, `ck-mc rekey-runner`): refuse
/// when a move holds any of these sessions, named by harness and session
/// id. Both tools rewrite rows every runner of the session shares, so any
/// entry with that harness and session id refuses. The error line starts
/// with the code and names the cut.
pub fn refuse_offline<'a>(
    context_db: &Path,
    sessions: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
    let journal = Journal::load(journal::path(context_db));
    for (harness, session) in sessions {
        journal
            .gate()
            .check_any_runner(harness, session)
            .map_err(|gated| gated.line())?;
    }
    Ok(())
}
