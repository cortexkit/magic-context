//! ck-mc's own store: per session, the decisions that are not in the
//! runner's transcript or view and must survive a restart. Views themselves
//! are not kept here: after a restart ck-mc takes the runner's current view
//! with `session.applied_view`, so this store is small and close to a cache.
//!
//! It is a new file, separate from the store earlier ck-mc builds used, so a
//! rollback to one of them finds its own file untouched.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
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
    #[serde(default)]
    pub app: crate::app_read::SessionState,
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
    /// A live-prompt floor marked for the next pass, including its transcript
    /// ordinal so a replaced prompt cannot spend an earlier mark.
    #[serde(default)]
    pub floor_pending_for: Option<(u64, String)>,
    /// Views handed to the runner that it has not yet confirmed applying,
    /// with the state each replaced, so a refusal after a restart can
    /// still put it back.
    #[serde(default)]
    pub unconfirmed: Vec<crate::session::Unconfirmed>,
}

pub struct Store {
    #[cfg(test)]
    write_max_ns: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    snapshot_writes: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    index_writes: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    decision_writes: std::sync::atomic::AtomicU64,
    connection: Mutex<Connection>,
    pub(crate) path: PathBuf,
}

/// The newest mode3.db schema this build can read and write.
pub const SCHEMA_VERSION: u32 = 3;

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection =
            Connection::open(path).map_err(|error| format!("store {}: {error}", path.display()))?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("store {}: {error}", path.display()))?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "store_too_new: {} has schema version {version}; this ck-mc supports {SCHEMA_VERSION}",
                path.display()
            ));
        }
        // Let the next job retry a busy write instead of blocking an executor
        // thread shared by other sessions.
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS sessions (
                     runner TEXT NOT NULL,
                     harness TEXT NOT NULL,
                     session TEXT NOT NULL,
                     state TEXT NOT NULL,
                     PRIMARY KEY (runner, harness, session)
                 );
                 CREATE TABLE IF NOT EXISTS head_murals (
                     runner TEXT NOT NULL,
                     harness TEXT NOT NULL,
                     session TEXT NOT NULL,
                     content_hash TEXT NOT NULL,
                     png BLOB NOT NULL,
                     PRIMARY KEY (runner, harness, session)
                 );
                  CREATE TABLE IF NOT EXISTS app_read_snapshots (
                      runner TEXT NOT NULL,
                      harness TEXT NOT NULL,
                      session TEXT NOT NULL,
                      snapshot TEXT NOT NULL,
                      PRIMARY KEY (runner, harness, session)
                  );
                  CREATE TABLE IF NOT EXISTS app_read_message_index (
                      runner TEXT NOT NULL,
                      harness TEXT NOT NULL,
                      session TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      ordinal INTEGER NOT NULL,
                      at_ms INTEGER NOT NULL,
                      PRIMARY KEY (runner, harness, session, message_id)
                  );
                  CREATE INDEX IF NOT EXISTS app_read_message_ordinals ON app_read_message_index(runner, harness, session, ordinal);
                  CREATE TABLE IF NOT EXISTS app_read_decisions (
                      runner TEXT NOT NULL,
                      harness TEXT NOT NULL,
                      session TEXT NOT NULL,
                      decisions TEXT NOT NULL,
                      PRIMARY KEY(runner,harness,session)
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
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .and_then(|()| connection.execute_batch("COMMIT;"))
            .map_err(|error| format!("store {}: {error}", path.display()))?;
        Ok(Self {
            #[cfg(test)]
            write_max_ns: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            snapshot_writes: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            index_writes: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            decision_writes: std::sync::atomic::AtomicU64::new(0),
            connection: Mutex::new(connection),
            path: path.to_owned(),
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
        let connection = self.lock();
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result = connection.execute(
            "INSERT INTO sessions (runner, harness, session, state) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (runner, harness, session) DO UPDATE SET state = excluded.state",
            params![key.runner, key.harness, key.session, text],
        );
        #[cfg(test)]
        self.record_write(started);
        result
            .map(|_| ())
            .map_err(|error| format!("session {}: saving its state failed: {error}", key.session))
    }

    /// Checkpoint a projection only on Setup, a cut, or a transcript replacement.
    /// Ordinary notices persist only newly observed message identities.
    pub(crate) fn save_app_snapshot(
        &self,
        snapshot: &crate::app_read::Snapshot,
    ) -> Result<(), String> {
        let key = &snapshot.key;
        let text = serde_json::to_string(snapshot).expect("snapshot JSON");
        let connection = self.lock();
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result=connection.execute("INSERT INTO app_read_snapshots VALUES (?1,?2,?3,?4) ON CONFLICT(runner,harness,session) DO UPDATE SET snapshot=excluded.snapshot",params![key.runner,key.harness,key.session,text]);
        #[cfg(test)]
        {
            self.record_write(started);
            self.snapshot_writes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        result
            .map(|_| ())
            .map_err(|error| format!("app checkpoint: {error}"))
    }

    pub(crate) fn app_index_tip(&self, key: &SessionRef) -> Option<(u64, String)> {
        self.lock().query_row("SELECT ordinal,message_id FROM app_read_message_index WHERE runner=?1 AND harness=?2 AND session=?3 ORDER BY ordinal DESC LIMIT 1",params![key.runner,key.harness,key.session],|row|Ok((row.get(0)?,row.get(1)?))).optional().unwrap_or_default()
    }

    pub(crate) fn save_app_index(
        &self,
        key: &SessionRef,
        rows: &[crate::app_read::IndexRow],
        reverted_from: Option<u64>,
    ) -> Result<(), String> {
        let mut connection = self.lock();
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result = (|| -> rusqlite::Result<()> {
            let tx = connection.transaction()?;
            if let Some(from) = reverted_from {
                tx.execute("DELETE FROM app_read_message_index WHERE runner=?1 AND harness=?2 AND session=?3 AND ordinal>=?4",params![key.runner,key.harness,key.session,from])?;
            }
            {
                let mut insert=tx.prepare_cached("INSERT INTO app_read_message_index VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(runner,harness,session,message_id) DO UPDATE SET ordinal=excluded.ordinal,at_ms=excluded.at_ms WHERE ordinal<>excluded.ordinal OR at_ms<>excluded.at_ms")?;
                for row in rows {
                    let written = insert.execute(params![
                        key.runner,
                        key.harness,
                        key.session,
                        row.mid,
                        row.ordinal,
                        row.at_ms
                    ])?;
                    #[cfg(test)]
                    self.index_writes
                        .fetch_add(written as u64, std::sync::atomic::Ordering::Relaxed);
                    #[cfg(not(test))]
                    let _ = written;
                }
            }
            tx.commit()
        })();
        #[cfg(test)]
        self.record_write(started);
        result.map_err(|error| format!("app message index: {error}"))
    }

    pub(crate) fn app_decisions(&self, key: &SessionRef) -> Vec<serde_json::Value> {
        let text:Option<String>=self.lock().query_row("SELECT decisions FROM app_read_decisions WHERE runner=?1 AND harness=?2 AND session=?3",params![key.runner,key.harness,key.session],|row|row.get(0)).optional().unwrap_or_default();
        let mut rows: Vec<serde_json::Value> = text
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        if rows.len() > 256 {
            rows.drain(..rows.len() - 256);
        }
        rows
    }

    pub(crate) fn save_app_decisions(
        &self,
        key: &SessionRef,
        decisions: &[serde_json::Value],
    ) -> Result<(), String> {
        let decisions = &decisions[decisions.len().saturating_sub(256)..];
        let text = serde_json::to_string(decisions).expect("decision JSON");
        let connection = self.lock();
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result=connection.execute("INSERT INTO app_read_decisions VALUES(?1,?2,?3,?4) ON CONFLICT(runner,harness,session) DO UPDATE SET decisions=excluded.decisions",params![key.runner,key.harness,key.session,text]);
        #[cfg(test)]
        {
            self.record_write(started);
            self.decision_writes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        result
            .map(|_| ())
            .map_err(|error| format!("app decisions: {error}"))
    }

    /// Keep the mural image the session's history head was last folded
    /// with, so the same bytes can be served again after a restart. One row
    /// per session: a later fold's mural replaces it.
    pub fn save_head_mural(
        &self,
        key: &SessionRef,
        content_hash: &str,
        png: &[u8],
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT INTO head_murals (runner, harness, session, content_hash, png) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (runner, harness, session) DO UPDATE SET content_hash = excluded.content_hash, png = excluded.png",
                params![key.runner, key.harness, key.session, content_hash, png],
            )
            .map(|_| ())
            .map_err(|error| format!("session {}: saving its mural failed: {error}", key.session))
    }

    /// The session's stored mural image, if it is the one with `content_hash`.
    pub fn head_mural(&self, key: &SessionRef, content_hash: &str) -> Option<Vec<u8>> {
        self.lock()
            .query_row(
                "SELECT png FROM head_murals WHERE runner = ?1 AND harness = ?2 AND session = ?3 AND content_hash = ?4",
                params![key.runner, key.harness, key.session, content_hash],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None)
    }

    /// The memory context fixed once and stored for the session, if any.
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

    #[cfg(test)]
    fn record_write(&self, started: std::time::Instant) {
        self.write_max_ns.fetch_max(
            started.elapsed().as_nanos() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    #[cfg(test)]
    pub(crate) fn take_write_max_ns(&self) -> u64 {
        self.write_max_ns
            .swap(0, std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn take_app_writes(&self) -> (u64, u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            self.index_writes.swap(0, Relaxed),
            self.snapshot_writes.swap(0, Relaxed),
            self.decision_writes.swap(0, Relaxed),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_connection_held(&self, f: impl FnOnce()) {
        let _connection = self.lock();
        f();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_store_records_the_supported_schema_version() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mode3.db");
        drop(Store::open(&path).unwrap());
        let connection = Connection::open(path).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let tables: u32 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('app_read_snapshots','app_read_message_index','app_read_decisions')", [], |row| row.get(0)).unwrap();
        assert_eq!(tables, 3);
    }

    #[test]
    fn a_newer_store_is_refused_without_changing_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mode3.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        let error = Store::open(&path)
            .err()
            .expect("newer stores must be refused");
        assert!(error.contains("store_too_new"), "{error}");
        assert!(error.contains(&path.display().to_string()), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_file_name("mode3.db-wal").exists());
    }

    #[test]
    fn an_unversioned_mode3_store_is_adopted_without_losing_rows() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mode3.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE sessions (runner TEXT, harness TEXT, session TEXT, state TEXT, PRIMARY KEY(runner, harness, session)); INSERT INTO sessions VALUES ('r', 'h', 's', '{}');").unwrap();
        drop(connection);
        drop(Store::open(&path).unwrap());
        let connection = Connection::open(path).unwrap();
        let count: u32 = connection
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }
}
