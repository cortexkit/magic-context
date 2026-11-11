//! The in-memory gate: which sessions a move holds, rebuilt from the journal
//! after every change and at startup.
//!
//! Every surface that serves a session asks [`Gate::check`] first: Setup,
//! notices, rides, tool calls, `pre_user`, app reads and context reads, and
//! the session's worker again when it takes a job off its queue. A session
//! no move names costs one atomic load, so sessions that are not moving pay
//! nothing measurable per step.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::wire::Refusal;
use serde_json::{json, Value};

use super::journal::{Contents, MovingState};

/// The refusal for a session a move holds on this machine: frozen at the
/// source, staged or being installed at the receiver. Every session also
/// gets it while the journal cannot be read.
pub const SESSION_MOVING: &str = "session_moving";
/// The refusal for a session released to another machine.
pub const SESSION_MOVED: &str = "session_moved";

/// Why a session is not served.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gated {
    /// [`SESSION_MOVING`] or [`SESSION_MOVED`].
    pub code: &'static str,
    /// The cut that holds the session; `None` only when the journal is
    /// unreadable, so no cut is known.
    pub cut: Option<String>,
    pub message: String,
    /// `{"cut": ...}` for a moving session, `{"holder": ...}` for a moved
    /// one, nothing for an unreadable journal.
    pub detail: Option<Value>,
}

impl Gated {
    /// The refusal every wire surface sends for it.
    pub fn refusal(&self) -> Refusal {
        Refusal::new(self.code, self.message.clone(), self.detail.clone())
    }

    /// One line for the offline tools: the code first, then the cut, so a
    /// script can read both.
    pub fn line(&self) -> String {
        match &self.cut {
            Some(cut) => format!("{}: cut {cut}: {}", self.code, self.message),
            None => format!("{}: {}", self.code, self.message),
        }
    }
}

/// One session a journal entry holds.
#[derive(Clone, Debug)]
struct Hold {
    runner: String,
    harness: String,
    cut: String,
    kind: Kind,
}

#[derive(Clone, Debug)]
enum Kind {
    Moving(MovingState),
    Moved { holder: String },
}

#[derive(Debug, Default)]
struct Index {
    /// Set when the journal could not be read: every session is refused,
    /// because an unread journal may name any of them.
    unreadable: Option<String>,
    /// By session id; a session id is shared by few (runner, harness) pairs.
    holds: HashMap<String, Vec<Hold>>,
}

#[derive(Debug, Default)]
pub struct Gate {
    /// False while the journal was read and names no held session, so a
    /// check is this one load and nothing else.
    any: AtomicBool,
    index: RwLock<Index>,
}

impl Gate {
    /// Whether the session with this runner, harness and session id is
    /// served. Runner surfaces (Setup, notices, rides, tool calls, hooks)
    /// name the full key.
    pub fn check(&self, key: &SessionRef) -> Result<(), Gated> {
        self.check_with(&key.harness, &key.session, Some(&key.runner))
    }

    /// The same, for a read that names no runner or reads rows every runner
    /// shares: `context.db` keys a session's rows by harness and session id
    /// alone, so any entry with that harness and session id refuses it.
    pub fn check_any_runner(&self, harness: &str, session: &str) -> Result<(), Gated> {
        self.check_with(harness, session, None)
    }

    fn check_with(&self, harness: &str, session: &str, runner: Option<&str>) -> Result<(), Gated> {
        if !self.any.load(Ordering::Acquire) {
            return Ok(());
        }
        let index = self.index.read().expect("agent-data gate");
        if let Some(reason) = &index.unreadable {
            return Err(Gated {
                code: SESSION_MOVING,
                cut: None,
                message: format!(
                    "The agent-data move journal cannot be read, so no session is served until it is repaired or restored ({reason})."
                ),
                detail: None,
            });
        }
        let Some(hold) = index.holds.get(session).and_then(|holds| {
            holds.iter().find(|hold| {
                hold.harness == harness && runner.is_none_or(|runner| hold.runner == runner)
            })
        }) else {
            return Ok(());
        };
        Err(match &hold.kind {
            Kind::Moving(state) => Gated {
                code: SESSION_MOVING,
                cut: Some(hold.cut.clone()),
                message: format!(
                    "Session {harness}/{session} is {} by agent-data cut {}; it is served again once the move is aborted or finished.",
                    state.describe(),
                    hold.cut
                ),
                detail: Some(json!({"cut": hold.cut})),
            },
            Kind::Moved { holder } => Gated {
                code: SESSION_MOVED,
                cut: Some(hold.cut.clone()),
                message: format!(
                    "Session {harness}/{session} was moved to {holder} by agent-data cut {} and is no longer served here.",
                    hold.cut
                ),
                detail: Some(json!({"holder": holder})),
            },
        })
    }

    /// Rebuild from the journal's contents. Called under the journal lock,
    /// after the change it reflects is durable.
    pub(super) fn rebuild(&self, contents: &Contents) {
        let mut holds: HashMap<String, Vec<Hold>> = HashMap::new();
        for entry in &contents.sessions {
            // A move in flight wins over an older tombstone: the session
            // is being moved back here, so it is moving, not moved.
            let kind = match (&entry.moving, &entry.released) {
                (Some(moving), _) => Some((moving.cut.clone(), Kind::Moving(moving.state))),
                (None, Some(released)) => Some((
                    released.cut.clone(),
                    Kind::Moved {
                        holder: released.holder.clone(),
                    },
                )),
                (None, None) => None,
            };
            if let Some((cut, kind)) = kind {
                holds.entry(entry.session.clone()).or_default().push(Hold {
                    runner: entry.runner.clone(),
                    harness: entry.harness.clone(),
                    cut,
                    kind,
                });
            }
        }
        let any = !holds.is_empty();
        *self.index.write().expect("agent-data gate") = Index {
            unreadable: None,
            holds,
        };
        self.any.store(any, Ordering::Release);
    }

    /// Refuse every session: the journal could not be read.
    pub(super) fn refuse_all(&self, reason: String) {
        *self.index.write().expect("agent-data gate") = Index {
            unreadable: Some(reason),
            holds: HashMap::new(),
        };
        self.any.store(true, Ordering::Release);
    }
}
