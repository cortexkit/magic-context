//! ck-mc's own store: per session, the decisions that are not in the
//! runner's transcript or view and must survive a restart. Views themselves
//! are not kept here: after a restart ck-mc takes the runner's current view
//! with `view.current`, so this store is small and close to a cache.
//!
//! It is a new file, separate from the store earlier ck-mc builds used, so a
//! rollback to one of them finds its own file untouched.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use ck_contract_draft::read::SessionRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::summary::head::Baseline;

/// What a session keeps across a restart.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Durable {
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
}

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection =
            Connection::open(path).map_err(|error| format!("store {}: {error}", path.display()))?;
        connection
            .busy_timeout(Duration::from_secs(5))
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

    pub fn save(&self, key: &SessionRef, state: &Durable) {
        let text = serde_json::to_string(state).expect("state serializes");
        let result = self.lock().execute(
            "INSERT INTO sessions (runner, harness, session, state) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (runner, harness, session) DO UPDATE SET state = excluded.state",
            params![key.runner, key.harness, key.session, text],
        );
        if let Err(error) = result {
            eprintln!(
                "ck-mc: session {}: saving its state failed: {error}",
                key.session
            );
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
