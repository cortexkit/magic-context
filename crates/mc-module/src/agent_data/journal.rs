//! The move journal: one private file, `agent-data/journal.json`, beside
//! `context.db`.
//!
//! It records every cut this machine has taken part in and, per session,
//! whether a move holds it. It is the one durable source of the gate: the
//! in-memory [`Gate`] is rebuilt from it after every change and at startup,
//! so what a session is refused always matches what a restart reads back.
//!
//! A change is written to a temporary file, synced, renamed over the
//! journal, and then the folder is synced, so a crash leaves either the old
//! journal or the new one, never a mix. One lock serializes every change and
//! the gate update that goes with it. A change is a plain function over the
//! journal's contents, so the lock is never held across a door, catalog or
//! Entorhinal call or a row read; those happen before the change is made.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cortexkit_role_agent_data::refs::Refs;
use cortexkit_role_agent_data::step::Step;
use serde::{Deserialize, Serialize};

use super::gate::Gate;

/// The journal's format name. A file naming another format is unreadable:
/// a build must never act on a journal it does not understand.
pub const FORMAT: &str = "mc-agent-data-journal/1";

/// The journal's folder, beside `context.db`.
pub fn folder(context_db: &Path) -> PathBuf {
    context_db.with_file_name("agent-data")
}

/// The journal file for the `context.db` at this path.
pub fn path(context_db: &Path) -> PathBuf {
    folder(context_db).join("journal.json")
}

/// Everything the journal holds. Unknown fields make the file unreadable on
/// purpose, for the same reason as an unknown format.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contents {
    pub format: String,
    /// Every cut this machine took part in, by cut id. Terminal records
    /// stay, so a repeated request still finds its receipt.
    #[serde(default)]
    pub cuts: BTreeMap<String, Cut>,
    /// Every session a move has touched here.
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
}

impl Default for Contents {
    fn default() -> Self {
        Self {
            format: FORMAT.to_owned(),
            cuts: BTreeMap::new(),
            sessions: Vec::new(),
        }
    }
}

impl Contents {
    /// The entry for a session, if a move has touched it.
    pub fn session(&self, runner: &str, harness: &str, session: &str) -> Option<&SessionEntry> {
        self.sessions
            .iter()
            .find(|entry| entry.is(runner, harness, session))
    }

    /// The entry for a session, created empty when no move has touched it.
    pub fn session_mut(&mut self, runner: &str, harness: &str, session: &str) -> &mut SessionEntry {
        let index = match self
            .sessions
            .iter()
            .position(|entry| entry.is(runner, harness, session))
        {
            Some(index) => index,
            None => {
                self.sessions.push(SessionEntry {
                    runner: runner.to_owned(),
                    harness: harness.to_owned(),
                    session: session.to_owned(),
                    moving: None,
                    released: None,
                    baseline: None,
                });
                self.sessions.len() - 1
            }
        };
        &mut self.sessions[index]
    }
}

/// One cut, as this machine saw it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cut {
    pub step: Step,
    /// The data this cut moves. A ref names one piece of an agent's data a
    /// module holds, here one runner session. The set is fixed when the cut
    /// starts, and every later step of the move must name the same set.
    #[serde(default)]
    pub refs: Option<Refs>,
    /// The reply to each state-changing op, by op name, so a repeat of the
    /// same request returns the same bytes.
    #[serde(default)]
    pub receipts: BTreeMap<String, Receipt>,
    /// The snapshot digest per ref.
    #[serde(default)]
    pub snapshots: BTreeMap<String, String>,
    /// The digest of each ref's undo image, written before an install.
    #[serde(default)]
    pub undo_images: BTreeMap<String, String>,
    /// The digest of an `activate` request still being carried out; cleared
    /// once every ref is installed.
    #[serde(default)]
    pub activate_request: Option<String>,
    /// Source: where `prepare` cut each ref's session, in the order of the
    /// cut's refs. `export` admits these snapshots and `release` tombstones
    /// these sessions, so neither asks Entorhinal again, whose answer may
    /// already name the new holder by then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prepared: Vec<Prepared>,
}

/// One ref's session as `prepare` cut it on the source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub ref_kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub runner: String,
    pub harness: String,
    pub session: String,
    /// The session's handle on Engram's door, the llm-runner `sessionRef`
    /// of runner, harness and session.
    pub session_ref: String,
    /// Where this cut's snapshot starts and ends in the session's stream on
    /// the door. Earlier moves of the session left the bytes before `start`.
    pub start: u64,
    pub end: u64,
    /// The SHA-256 of the stream's bytes up to `end`, which the cut seals.
    pub digest: String,
    /// The SHA-256 of the snapshot's body: the session's baseline once the
    /// snapshot is exported.
    pub body: String,
}

/// A cut no op has recorded anything for yet.
impl Default for Cut {
    fn default() -> Self {
        Self {
            step: Step::None,
            refs: None,
            receipts: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            undo_images: BTreeMap::new(),
            activate_request: None,
            prepared: Vec::new(),
        }
    }
}

/// A state-changing op's request and the exact reply it was given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request: String,
    pub reply: String,
}

/// One session, keyed as ck-mc keys sessions: runner, harness, session id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionEntry {
    pub runner: String,
    pub harness: String,
    pub session: String,
    /// The move holding the session now. While it is set the session is
    /// refused `session_moving`.
    #[serde(default)]
    pub moving: Option<Moving>,
    /// Set when the session was released to another machine. Without a move
    /// in flight the session is refused `session_moved`. It stays while a
    /// move back is staged, so an aborted move back still refuses the
    /// session with the holder it had.
    #[serde(default)]
    pub released: Option<Released>,
    /// The digest of the session's snapshot body at its last move, which
    /// tells a later move back whether the rows here changed since.
    #[serde(default)]
    pub baseline: Option<String>,
}

impl SessionEntry {
    fn is(&self, runner: &str, harness: &str, session: &str) -> bool {
        self.runner == runner && self.harness == harness && self.session == session
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moving {
    pub cut: String,
    pub state: MovingState,
}

/// How far a move in flight has come for one session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovingState {
    /// Source: `prepare` froze the session; nothing new runs for it.
    Frozen,
    /// Receiver: `import` staged the snapshot; nothing of it is live yet.
    Staged,
    /// Receiver: `activate` is installing the snapshot.
    Activating,
}

impl MovingState {
    /// The state in words, for refusals and log lines.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Frozen => "frozen",
            Self::Staged => "staged",
            Self::Activating => "being installed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Released {
    pub cut: String,
    /// The machine that holds the session now.
    pub holder: String,
}

/// Why a journal change was not made.
#[derive(Debug)]
pub enum ChangeError {
    /// The journal could not be read at startup. It is never overwritten,
    /// since it may hold moves only a repair can recover.
    Unreadable,
    /// The change could not be made durable; nothing changed.
    Io(io::Error),
}

impl std::fmt::Display for ChangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => f.write_str("the agent-data journal is unreadable"),
            Self::Io(error) => write!(f, "the agent-data journal could not be written: {error}"),
        }
    }
}

impl std::error::Error for ChangeError {}

/// The journal and its gate.
#[derive(Debug)]
pub struct Journal {
    /// Where the journal lives; `None` keeps it in memory only, for a
    /// module with no data folder (tests).
    path: Option<PathBuf>,
    /// The journal lock, over the contents as last made durable. `None`
    /// when the file could not be read.
    contents: Mutex<Option<Contents>>,
    gate: Arc<Gate>,
}

impl Journal {
    /// A journal kept in memory only, holding nothing.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            contents: Mutex::new(Some(Contents::default())),
            gate: Arc::default(),
        }
    }

    /// Read the journal at `path`. A missing file is an empty journal. A
    /// file that cannot be read or parsed makes every session refused and
    /// every change refused: treating it as empty would serve sessions a
    /// move still holds.
    pub fn load(path: PathBuf) -> Self {
        let gate = Arc::new(Gate::default());
        let contents = match read(&path) {
            Ok(contents) => {
                gate.rebuild(&contents);
                Some(contents)
            }
            Err(reason) => {
                tracing::error!(
                    journal = %path.display(),
                    "ck-mc: the agent-data move journal cannot be read ({reason}); every session is refused session_moving until it is repaired or restored from a backup"
                );
                gate.refuse_all(reason);
                None
            }
        };
        Self {
            path: Some(path),
            contents: Mutex::new(contents),
            gate,
        }
    }

    /// Name, at startup, every session a move still holds and what has to
    /// happen for it to be served again. `agent_data` says whether this
    /// build serves moves: without it, a session a move holds stays refused
    /// until a build that does aborts or finishes the move.
    pub fn log_held(&self, agent_data: bool) {
        if let Some(contents) = self.contents() {
            log_held(&contents, agent_data);
        }
    }

    /// The gate every surface checks.
    pub fn gate(&self) -> &Arc<Gate> {
        &self.gate
    }

    /// A copy of the contents, or `None` when the journal is unreadable.
    pub fn contents(&self) -> Option<Contents> {
        self.contents.lock().expect("agent-data journal").clone()
    }

    /// Make one change durable, then update the gate to match. The lock is
    /// held from reading the current contents until the gate is updated, so
    /// two changes never lose each other, whichever cuts they touch. If the
    /// write fails, neither the journal nor the gate changes.
    pub fn change<R>(&self, edit: impl FnOnce(&mut Contents) -> R) -> Result<R, ChangeError> {
        let mut current = self.contents.lock().expect("agent-data journal");
        let Some(contents) = current.as_ref() else {
            return Err(ChangeError::Unreadable);
        };
        let mut next = contents.clone();
        let result = edit(&mut next);
        if next == *contents {
            return Ok(result);
        }
        if let Some(path) = &self.path {
            write(path, &next).map_err(ChangeError::Io)?;
        }
        self.gate.rebuild(&next);
        *current = Some(next);
        Ok(result)
    }
}

fn read(path: &Path) -> Result<Contents, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Contents::default()),
        Err(error) => return Err(error.to_string()),
    };
    let contents: Contents = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if contents.format != FORMAT {
        return Err(format!(
            "format {:?}, this build reads {FORMAT:?}",
            contents.format
        ));
    }
    Ok(contents)
}

/// Write the whole journal: temporary file, sync, rename, folder sync.
fn write(path: &Path, contents: &Contents) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(contents).map_err(io::Error::other)?;
    // The folder may predate this build with wider permissions; it holds
    // session snapshots too, so it is kept owner-only like the logs.
    if let Some(folder) = path.parent().filter(|folder| folder.exists()) {
        let report = crate::private_permissions::tighten_tree(folder);
        if report.failures > 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("cannot make {} private", folder.display()),
            ));
        }
    }
    crate::private_permissions::write_file_atomic(path, &bytes)?;
    sync_folder(path)
}

/// Make the rename itself durable. Windows has no folder handle to sync here;
/// the atomic write asks for a write-through rename there instead.
fn sync_folder(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(folder) = path.parent() {
        std::fs::File::open(folder)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn log_held(contents: &Contents, agent_data: bool) {
    for entry in &contents.sessions {
        let session = format!("{}/{}/{}", entry.runner, entry.harness, entry.session);
        match (&entry.moving, &entry.released) {
            (Some(moving), _) if agent_data => tracing::warn!(
                session = %session,
                cut = %moving.cut,
                state = moving.state.describe(),
                "ck-mc: session {session} is {} by agent-data cut {} and is refused session_moving until Entorhinal aborts or finishes the move",
                moving.state.describe(),
                moving.cut
            ),
            (Some(moving), _) => tracing::warn!(
                session = %session,
                cut = %moving.cut,
                state = moving.state.describe(),
                "ck-mc: session {session} is {} by agent-data cut {} and is refused session_moving; agent-data moves are off in this build, so a build with them on must abort or finish the move",
                moving.state.describe(),
                moving.cut
            ),
            (None, Some(released)) => tracing::info!(
                session = %session,
                cut = %released.cut,
                holder = %released.holder,
                "ck-mc: session {session} was released to {} by agent-data cut {} and is refused session_moved here; only a move back to this machine serves it here again",
                released.holder,
                released.cut
            ),
            (None, None) => {}
        }
    }
}
