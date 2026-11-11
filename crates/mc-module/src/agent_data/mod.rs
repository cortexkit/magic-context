//! Magic Context's side of moving a runner session between machines: the
//! `agent-data/v1` participant.
//!
//! Entorhinal moves an agent by asking every module that holds data for it
//! to stop that data at a cut, ship it through Engram's session door, and
//! bring it up on the other machine. For ck-mc a move covers, per runner
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

pub mod gate;
pub mod journal;

#[cfg(test)]
mod tests;

pub use gate::{Gate, Gated, SESSION_MOVED, SESSION_MOVING};
pub use journal::Journal;

use std::path::Path;

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
