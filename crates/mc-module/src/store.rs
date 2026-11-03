//! ck-mc's own store: per session, the decisions that are not in the
//! runner's transcript or view and must survive a restart. Views themselves
//! are not kept here: after a restart ck-mc takes the runner's current view
//! with `session.applied_view`, so this store is small and close to a cache.
//!
//! It is a new file, separate from the store earlier ck-mc builds used, so a
//! rollback to one of them finds its own file untouched.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::memory_profile::MemoryContext;
use crate::summary::head::Baseline;

/// What a session keeps across a restart.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Durable {
    /// Compaction features and conditions, for a tool arriving before Setup
    /// after a restart. Older rows recover these at their next Setup.
    #[serde(default)]
    pub compaction: Option<(
        crate::preset::Features,
        cortexkit_role_compaction::notice::Conditions,
    )>,
    /// The preset used to select tools for a compacting session restored before Setup.
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub pending_keep: Option<BTreeSet<(String, String)>>,
    #[serde(default)]
    pub head_stale: bool,
    /// Reserved reminder ids, independent of the runner's notice numbering.
    #[serde(default)]
    pub reminder_counter: u64,
    /// The highest view version ck-mc has built, so none is used twice.
    pub version: u64,
    /// Parts the model asked to drop that no view carries yet.
    pub queued: BTreeSet<(String, String)>,
    pub reclaim_bookmark: u64,
    pub emergency_latched: bool,
    pub keep_requested: bool,
    /// What the head's `m[0]` holds, so a restart does not re-render it.
    pub baseline: Option<Baseline>,
    /// The `ctx_reduce` reminders' cadence, so a restart neither repeats a
    /// reminder nor forgets a grace.
    #[serde(default)]
    pub nudges: crate::nudges::State,
    /// The ordinal of the last message the applied view cuts, where reading
    /// the transcript starts again after a restart.
    #[serde(default)]
    pub cut: Option<u64>,
    /// Messages a person wrote before the cut, for the reminders' cadence.
    #[serde(default)]
    pub pruned_turns: u64,
    /// How far each compressed text part is compressed.
    #[serde(default)]
    pub caveman: crate::lanes::CavemanState,
    /// The summarizer's drain quota.
    #[serde(default)]
    pub drain: crate::summary::drain::Drain,
    /// The newest message a summary run made no progress on, so a restart
    /// does not pay for the same run again.
    #[serde(default)]
    pub no_progress: Option<(String, bool)>,
    /// The prompt a run already summarized past, so a restart does not lift
    /// it twice.
    #[serde(default)]
    pub floor_lifted_for: Option<String>,
    /// Views handed to the runner that it has not yet confirmed applying,
    /// with the state each replaced, so a refusal after a restart can
    /// still put it back.
    #[serde(default)]
    pub unconfirmed: Vec<crate::session::Unconfirmed>,
}

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection =
            Connection::open(path).map_err(|error| format!("store {}: {error}", path.display()))?;
        // Let the next job retry a busy write instead of blocking an executor
        // thread shared by other sessions.
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS sessions (
                     runner TEXT NOT NULL,
                     harness TEXT NOT NULL,
                     session TEXT NOT NULL,
                     state TEXT NOT NULL,
                     PRIMARY KEY (runner, harness, session)
                 );
                 CREATE TABLE IF NOT EXISTS memory_contexts (
                     runner TEXT NOT NULL,
                     harness TEXT NOT NULL,
                     session TEXT NOT NULL,
                     context TEXT NOT NULL,
                     PRIMARY KEY (runner, harness, session)
                 );",
            )
            .map_err(|error| format!("store {}: {error}", path.display()))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn load(&self, key: &SessionRef) -> Option<Durable> {
        let connection = self.lock();
        let text: Option<String> = connection
            .query_row(
                "SELECT state FROM sessions WHERE runner = ?1 AND harness = ?2 AND session = ?3",
                params![key.runner, key.harness, key.session],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or_else(|error| {
                eprintln!(
                    "ck-mc: session {}: loading its state failed: {error}",
                    key.session
                );
                None
            });
        text.and_then(|text| serde_json::from_str(&text).ok())
    }

    pub fn save(&self, key: &SessionRef, state: &Durable) -> Result<(), String> {
        let text = serde_json::to_string(state).expect("state serializes");
        let result = self.lock().execute(
            "INSERT INTO sessions (runner, harness, session, state) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (runner, harness, session) DO UPDATE SET state = excluded.state",
            params![key.runner, key.harness, key.session, text],
        );
        result
            .map(|_| ())
            .map_err(|error| format!("session {}: saving its state failed: {error}", key.session))
    }

    /// The memory context stored for the session (spec 3c, ML1), if any.
    /// It is kept apart from [`Durable`] because a session that only calls
    /// tools has one too.
    pub fn memory_context(&self, key: &SessionRef) -> Option<MemoryContext> {
        let text: Option<String> = self
            .lock()
            .query_row(
                "SELECT context FROM memory_contexts WHERE runner = ?1 AND harness = ?2 AND session = ?3",
                params![key.runner, key.harness, key.session],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or_else(|error| {
                eprintln!(
                    "ck-mc: session {}: loading its memory context failed: {error}",
                    key.session
                );
                None
            });
        text.and_then(|text| serde_json::from_str(&text).ok())
    }

    /// Store a session's memory context once. If one is already stored, that
    /// one is kept and returned: a session's context never changes.
    pub fn keep_memory_context(&self, key: &SessionRef, context: MemoryContext) -> MemoryContext {
        let text = serde_json::to_string(&context).expect("memory context serializes");
        let result = self.lock().execute(
            "INSERT INTO memory_contexts (runner, harness, session, context) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (runner, harness, session) DO NOTHING",
            params![key.runner, key.harness, key.session, text],
        );
        if let Err(error) = result {
            eprintln!(
                "ck-mc: session {}: saving its memory context failed: {error}",
                key.session
            );
            return context;
        }
        self.memory_context(key).unwrap_or(context)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
