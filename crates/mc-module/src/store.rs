//! ck-mc's own store: per session, the decisions that are not in the
//! runner's transcript or view and must survive a restart. Views themselves
//! are not kept here: after a restart ck-mc takes the runner's current view
//! with `session.applied_view`, so this store is small and close to a cache.
//!
//! Version 4 keeps large immutable history text apart from the mutable state
//! rows. Rolling back to a version-3 build requires restoring its store backup.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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
    /// The view version the runner last reported applying, which a
    /// reading's `last_prompt_view` is judged against.
    #[serde(default)]
    pub newest_applied: u64,
    /// The newest reading measured a request rendered with an older view,
    /// so pressure counts as unknown until a reading under the current view.
    #[serde(default)]
    pub reading_stale: bool,
    /// The stale reading last ignored: prompt size, the view it named, and
    /// the applied view it was judged against.
    #[serde(default)]
    pub ignored_reading: Option<(u64, u64, u64)>,
    /// The runner named views it had already replaced; its view versions
    /// are ignored until the next Setup.
    #[serde(default)]
    pub prompt_views_untrusted: bool,
    /// Keep notice counts across restarts; rides never supply them.
    #[serde(default, skip_serializing_if = "crate::prompt_notes::Notes::is_empty")]
    pub notes: crate::prompt_notes::Notes,
    /// Parts the model asked to drop that no view carries yet.
    pub queued: BTreeSet<(String, String)>,
    pub reclaim_bookmark: u64,
    /// Notice tags age independently so they cannot constrain tool reclaim.
    #[serde(default)]
    pub notice_reclaim_bookmark: u64,
    pub emergency_latched: bool,
    pub keep_requested: bool,
    /// What the head's `m[0]` holds, so a restart does not re-render it.
    pub baseline: Option<Arc<Baseline>>,
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
    /// A summary was published that no view the runner took shows yet.
    #[serde(default)]
    pub summary_unshown: bool,
    /// For a session moved onto its runner, the entry its first view cut
    /// through: no later view may cut before it. Left out of the saved text
    /// for every other session, so their rows don't change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_floor: Option<crate::session::MoveFloor>,
    /// The entry id of the runner's signed floor: after a tool-set change on
    /// a model whose signed reasoning is bound to the request prefix, the
    /// runner strips signed reasoning at or before this entry. It is the
    /// floor the runner last stated (or none, after a refusal showed the
    /// runner does not apply it), so a restart starts from it. Left out of
    /// the saved text while there is none, so other sessions' rows don't
    /// change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_floor: Option<String>,
}

pub struct Store {
    /// Saving before a view is handed to the runner and after the notice job
    /// often writes identical state. Keep one successful value, not an unbounded
    /// per-session cache, so the second call need not encode or write it again.
    last_saved: Mutex<Option<(SessionRef, Durable)>>,
    text_cache: Mutex<crate::store_text::Cache>,
    #[cfg(test)]
    legacy_v3: bool,
    #[cfg(test)]
    write_max_ns: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    snapshot_writes: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    index_writes: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    decision_writes: std::sync::atomic::AtomicU64,
    connection: Mutex<Connection>,
    // Keep the offline-command interlock until after SQLite closes. The lock
    // lives on a sidecar so it never interferes with SQLite's database locks.
    _lease: std::fs::File,
    pub(crate) path: PathBuf,
}

/// Discover every per-session state table so auxiliary state and future
/// schema additions receive the same collision checks as the main state row.
pub(crate) fn session_tables(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut tables = connection.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )?;
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for name in names {
        let mut columns = connection.prepare("SELECT name FROM pragma_table_info(?1)")?;
        let columns = columns
            .query_map([&name], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        if ["runner", "harness", "session"]
            .iter()
            .all(|column| columns.contains(*column))
        {
            result.push(name);
        }
    }
    Ok(result)
}

/// The newest mode3.db schema this build can read and write.
pub const SCHEMA_VERSION: u32 = 5;

pub(crate) fn lock_store(path: &Path, exclusive: bool) -> Result<std::fs::File, String> {
    let canonical = if path.exists() {
        path.canonicalize()
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .canonicalize()
            .map(|parent| parent.join(path.file_name().unwrap_or_default()))
    }
    .map_err(|error| format!("store_lock: {}: {error}", path.display()))?;
    let mut name = canonical.into_os_string();
    name.push(".lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(PathBuf::from(name))
        .map_err(|error| format!("store_lock: {}: {error}", path.display()))?;
    let result = if exclusive {
        file.try_lock()
    } else {
        file.try_lock_shared()
    };
    result.map_err(|error| format!("store_in_use: {}: {error}", path.display()))?;
    Ok(file)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let lease = lock_store(path, false)?;
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
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS state_texts (id TEXT PRIMARY KEY, text TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS state_text_refs (runner TEXT,harness TEXT,session TEXT,id TEXT,PRIMARY KEY(runner,harness,session,id));
                 CREATE INDEX IF NOT EXISTS state_text_refs_id ON state_text_refs(id);",
            )
            .map_err(|error| error.to_string())?;
        if version < 4 {
            crate::store_text::migrate(&connection)?;
        }
        connection
            .execute_batch(crate::app_read::persistence::SCHEMA)
            .map_err(|error| error.to_string())?;
        if version < 5 {
            connection.execute_batch("CREATE TABLE IF NOT EXISTS app_read_snapshots (runner TEXT NOT NULL,harness TEXT NOT NULL,session TEXT NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(runner,harness,session));").map_err(|error|error.to_string())?;
            crate::app_read::persistence::migrate(&connection)?;
        }
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .and_then(|()| connection.execute_batch("COMMIT;"))
            .map_err(|error| format!("store {}: {error}", path.display()))?;
        Ok(Self {
            last_saved: Mutex::new(None),
            text_cache: Mutex::new(Default::default()),
            #[cfg(test)]
            legacy_v3: false,
            #[cfg(test)]
            write_max_ns: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            snapshot_writes: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            index_writes: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            decision_writes: std::sync::atomic::AtomicU64::new(0),
            connection: Mutex::new(connection),
            _lease: lease,
            path: path.to_owned(),
        })
    }

    /// Detect occupied destination keys without decoding state. Malformed
    /// state and auxiliary-only rows must not be overwritten by a move.
    pub fn has_rows(&self, key: &SessionRef) -> Result<bool, String> {
        let connection = self.lock();
        for table in session_tables(&connection).map_err(|e| e.to_string())? {
            let table = table.replace('"', "\"\"");
            let exists: bool=connection.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM \"{table}\" WHERE runner=?1 AND harness=?2 AND session=?3)"),
                params![key.runner,key.harness,key.session],|row|row.get(0),
            ).map_err(|e|e.to_string())?;
            if exists {
                return Ok(true);
            }
        }
        Ok(false)
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
                tracing::warn!(
                    "ck-mc: session {}: loading its state failed: {error}",
                    key.session
                );
                None
            });
        text.and_then(|text| {
            let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
            if let Err(error) = crate::store_text::transform(&mut value, &connection, false) {
                tracing::warn!(
                    "ck-mc: session {}: loading state failed: {error}",
                    key.session
                );
                return None;
            }
            serde_json::from_value(value).ok()
        })
    }

    pub fn save(&self, key: &SessionRef, state: &Durable) -> Result<(), String> {
        let _timing = crate::notice_cost_timing::span("store.save");
        let mut saved = self.last_saved.lock().expect("last saved session state");
        if saved
            .as_ref()
            .is_some_and(|(old_key, old)| old_key == key && old == state)
        {
            return Ok(());
        }
        let mut cached = self.text_cache.lock().expect("store text cache");
        let mut next_cache = cached.clone();
        #[cfg(test)]
        let legacy = self.legacy_v3;
        #[cfg(not(test))]
        let legacy = false;
        let (text, texts, used) = if legacy {
            (
                serde_json::to_string(state).expect("legacy state serializes"),
                vec![],
                BTreeSet::new(),
            )
        } else {
            crate::store_text::encode(state, &mut next_cache)
        };
        let mut connection = self.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for (id, text) in texts {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO state_texts (id,text) VALUES (?1,?2)",
                    params![id, text],
                )
                .map_err(|e| e.to_string())?;
        }
        let retired = {
            let mut stmt = transaction
                .prepare(
                    "SELECT id FROM state_text_refs WHERE runner=?1 AND harness=?2 AND session=?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![key.runner, key.harness, key.session], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        transaction
            .execute(
                "DELETE FROM state_text_refs WHERE runner=?1 AND harness=?2 AND session=?3",
                params![key.runner, key.harness, key.session],
            )
            .map_err(|e| e.to_string())?;
        for id in &used {
            transaction
                .execute(
                    "INSERT INTO state_text_refs VALUES (?1,?2,?3,?4)",
                    params![key.runner, key.harness, key.session, id],
                )
                .map_err(|e| e.to_string())?;
        }
        // Only the retiring session's old references need checking. An index
        // on id finds strings still referenced by another session or by the
        // saved state needed if the runner refuses an unconfirmed view.
        for id in retired.iter().filter(|id| !used.contains(*id)) {
            transaction.execute("DELETE FROM state_texts WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM state_text_refs WHERE id=?1)",[id]).map_err(|e|e.to_string())?;
        }
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result = transaction.execute(
            "INSERT INTO sessions (runner, harness, session, state) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (runner, harness, session) DO UPDATE SET state = excluded.state",
            params![key.runner, key.harness, key.session, text],
        );
        #[cfg(test)]
        self.record_write(started);
        let result = result
            .and_then(|_| transaction.commit())
            .map_err(|error| format!("session {}: saving its state failed: {error}", key.session));
        if result.is_ok() {
            *saved = Some((key.clone(), state.clone()));
            *cached = next_cache;
        }
        result
    }

    /// A version-three writer for the migration's step-through fixture. State
    /// is populated through save/load, using the old inline JSON representation.
    #[cfg(test)]
    pub fn create_version_three_for_tests(path: &Path) -> Result<Self, String> {
        if path.exists() {
            let conn = Connection::open(path).map_err(|e| e.to_string())?;
            let version: u32 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if version > 3 {
                return Err(format!(
                    "store_too_new: schema version {version}; version-three writer supports 3"
                ));
            }
        }
        let mut store = Self::open(path)?;
        store
            .lock()
            .pragma_update(None, "user_version", 3)
            .map_err(|e| e.to_string())?;
        store.legacy_v3 = true;
        Ok(store)
    }

    #[cfg(test)]
    pub(crate) fn save_app_snapshot(
        &self,
        snapshot: &crate::app_read::Snapshot,
    ) -> Result<(), String> {
        self.save_app_checkpoint(
            &snapshot.key,
            &crate::app_read::persistence::Checkpoint::full(snapshot),
        )?;
        self.save_app_decisions(&snapshot.key, &snapshot.decisions)
    }

    pub(crate) fn save_app_checkpoint(
        &self,
        key: &SessionRef,
        checkpoint: &crate::app_read::persistence::Checkpoint,
    ) -> Result<(), String> {
        let mut connection = self.lock();
        #[cfg(test)]
        let started = std::time::Instant::now();
        let result = (|| -> rusqlite::Result<()> {
            let tx = connection.transaction()?;
            checkpoint.write(&tx, key)?;
            tx.commit()
        })();
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
                tracing::warn!(
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
            tracing::warn!(
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
    #[ignore = "explicit offline backup only; never opens a live store"]
    fn offline_copy_version_three_migration_preserves_every_session() {
        use sha2::{Digest, Sha256};
        let path = PathBuf::from(
            std::env::var_os("NOTICE_COST_MIGRATION_COPY").expect("supply an offline backup copy"),
        );
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            3
        );
        let rows = {
            let mut stmt = conn.prepare("SELECT runner,harness,session,state FROM sessions ORDER BY runner,harness,session").unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        SessionRef::new(
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ),
                        r.get::<_, String>(3)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows
        };
        let before: Vec<(SessionRef, Durable)> = rows
            .into_iter()
            .map(|(key, text)| {
                (
                    key,
                    serde_json::from_str(&text).expect("version-three Durable"),
                )
            })
            .collect();
        drop(conn);
        let store = Store::open(&path).unwrap();
        for (index, (key, expected)) in before.iter().enumerate() {
            assert!(
                store.load(key).as_ref() == Some(expected),
                "decoded state differs for offline-copy row {index}"
            );
            println!("offline-copy row {index}: harness={} session_sha256={:x} decoded equality PASS baseline={} pending_views={}",key.harness,Sha256::digest(key.session.as_bytes()),expected.baseline.is_some(),expected.unconfirmed.len());
        }
        println!(
            "Offline copy migrated 3 -> 5: {}/{} sessions decoded identically",
            before.len(),
            before.len()
        );
    }

    /// Rehearses the version-four app snapshot split on a copy of a real
    /// store: every saved snapshot must load back from the new rows exactly as
    /// it was stored whole. Decisions are left out of the comparison: app reads
    /// take them from their own table (`app_read_decisions`), which may be newer
    /// than the copy inside the old snapshot.
    #[test]
    #[ignore = "explicit offline backup only; never opens a live store"]
    fn offline_copy_version_four_migration_preserves_every_app_snapshot() {
        let path = PathBuf::from(
            std::env::var_os("APP_SNAPSHOT_MIGRATION_COPY").expect("supply an offline backup copy"),
        );
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            4
        );
        let mut before: Vec<crate::app_read::Snapshot> = {
            let mut stmt = conn
                .prepare("SELECT snapshot FROM app_read_snapshots")
                .unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|text| serde_json::from_str(&text.unwrap()).expect("version-four snapshot"))
                .collect();
            rows
        };
        drop(conn);
        let store = Store::open(&path).unwrap();
        let mut after = crate::app_read::persistence::load(&store.lock()).unwrap();
        let order = |s: &crate::app_read::Snapshot| {
            (
                s.key.runner.clone(),
                s.key.harness.clone(),
                s.key.session.clone(),
            )
        };
        before.sort_by_key(order);
        after.sort_by_key(order);
        assert_eq!(after.len(), before.len(), "session count changed");
        for (expected, loaded) in before.iter_mut().zip(after.iter_mut()) {
            expected.decisions.clear();
            loaded.decisions.clear();
            assert!(
                loaded == expected,
                "snapshot differs for {}/{}",
                expected.key.harness,
                expected.key.session
            );
        }
        println!(
            "Offline copy migrated 4 -> 5: {}/{} app snapshots load identically",
            before.len(),
            before.len()
        );
    }

    #[test]
    fn a_new_store_records_the_supported_schema_version() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mode3.db");
        drop(Store::open(&path).unwrap());
        let connection = Connection::open(path).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
        let tables: u32 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('app_read_headers','app_read_messages','app_read_summaries','app_read_message_index','app_read_decisions')", [], |row| row.get(0)).unwrap();
        assert_eq!(tables, 5);
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
        assert_eq!(version, 5);
    }
    #[test]
    fn repeated_successful_save_does_not_write_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let store = Store::open(&path).unwrap();
        let key = SessionRef::new("runner", "pi", "session");
        let state = Durable::default();
        store.save(&key, &state).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TRIGGER forbid_redundant_state_write BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'redundant state write'); END;").unwrap();
        store.save(&key, &state).unwrap();
        assert_eq!(store.load(&key), Some(state));
    }

    /// A save writes a baseline's summary attribution by copying the JSON
    /// made with its list, not by serializing the items again; those bytes
    /// are what a full serialization of the state writes, after the items
    /// change and after the state is loaded back.
    #[test]
    fn a_save_copies_the_summary_items_json_that_a_full_serialization_writes() {
        use crate::summary::head::{SummaryItem, SummaryItems};
        let dir = tempfile::tempdir().unwrap();
        let key = SessionRef::new("runner", "pi", "session");
        let saved = |path: &Path| -> String {
            Connection::open(path)
                .unwrap()
                .query_row("SELECT state FROM sessions", [], |row| row.get(0))
                .unwrap()
        };
        let items = |count: u64| -> Vec<SummaryItem> {
            (1..=count)
                .map(|id| SummaryItem {
                    compartment_id: id.to_string(),
                    tier: (id % 4 + 1) as u8,
                    tokens: id * 17,
                })
                .collect()
        };
        let with_items = |summary_items: SummaryItems| Durable {
            baseline: Some(Arc::new(Baseline {
                summary_items,
                through_sequence: 5,
                m0: "<session-history>\nshort\n</session-history>".into(),
                ..Default::default()
            })),
            version: 3,
            ..Default::default()
        };

        // The save copies the list's JSON as it was made.
        let path = dir.path().join("copied.db");
        Store::open(&path)
            .unwrap()
            .save(
                &key,
                &with_items(SummaryItems::with_json(items(2), "[\"copied\"]")),
            )
            .unwrap();
        assert!(saved(&path).contains(r#""summary_items":["copied"]"#));

        let path = dir.path().join("mode3.db");
        let store = Store::open(&path).unwrap();
        let mut state = with_items(SummaryItems::new(items(3)));
        store.save(&key, &state).unwrap();
        assert_eq!(saved(&path), serde_json::to_string(&state).unwrap());
        Arc::make_mut(state.baseline.as_mut().unwrap()).summary_items = SummaryItems::new(items(5));
        store.save(&key, &state).unwrap();
        let written = saved(&path);
        assert_eq!(written, serde_json::to_string(&state).unwrap());

        let loaded = store.load(&key).unwrap();
        assert_eq!(loaded, state);
        let again = dir.path().join("again.db");
        Store::open(&again).unwrap().save(&key, &loaded).unwrap();
        assert_eq!(saved(&again), written);
    }
    #[test]
    fn version_three_migration_preserves_baselines_pending_views_and_rollback_state() {
        use cortexkit_role_compaction::read::Role;
        use cortexkit_role_compaction::view::{Edit, EditOp, InsertAt, InsertedMessage, View};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let legacy = Store::create_version_three_for_tests(&path).unwrap();
        let old = Baseline {
            m0: "old immutable history ".repeat(1_000),
            ..Baseline::default()
        };
        let base = Baseline {
            m0: "current immutable history ".repeat(1_000),
            ..Baseline::default()
        };
        let view = |version, text: &str| {
            View::seal(
                version,
                vec![Edit::new(
                    version,
                    EditOp::Insert {
                        at: InsertAt::Start,
                        message: InsertedMessage::new("history", Role::User, vec![text.to_owned()]),
                    },
                )],
            )
        };
        let pending = serde_json::from_value(serde_json::json!({
            "view":view(2,&base.m0),"covered":[],"before":{
                "latest":view(1,&old.m0),"queued":[],"refused_once":[],"emergency_latched":false,
                "baseline":old,"fold_due":false,"caveman":{"depths":[],"english_word_rules":null},"cut":19,"pruned_turns":3
            }
        })).unwrap();
        let state = Durable {
            version: 2,
            baseline: Some(Arc::new(base)),
            unconfirmed: vec![pending],
            ..Durable::default()
        };
        let keys = [
            SessionRef::new("runner", "pi", "one"),
            SessionRef::new("runner", "opencode2", "two"),
        ];
        for key in &keys {
            legacy.save(key, &state).unwrap();
            assert_eq!(legacy.load(key), Some(state.clone()));
        }
        drop(legacy);
        let migrated = Store::open(&path).unwrap();
        assert_eq!(
            migrated
                .lock()
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            5
        );
        for key in &keys {
            assert_eq!(migrated.load(key), Some(state.clone()));
        }
        let blobs: usize = migrated
            .lock()
            .query_row("SELECT COUNT(*) FROM state_texts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            blobs, 2,
            "current and rollback history each stored once across sessions"
        );
        assert!(Store::create_version_three_for_tests(&path)
            .err()
            .unwrap()
            .starts_with("store_too_new:"));
    }

    #[test]
    fn failed_normalized_save_does_not_cache_uncommitted_text_references() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let store = Store::open(&path).unwrap();
        let key = SessionRef::new("runner", "pi", "retry");
        let state = Durable {
            baseline: Some(Arc::new(Baseline {
                m0: "immutable history ".repeat(1_000),
                ..Baseline::default()
            })),
            ..Durable::default()
        };
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_state_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(store.save(&key, &state).is_err());
        conn.execute_batch("DROP TRIGGER fail_state_insert;")
            .unwrap();
        store.save(&key, &state).unwrap();
        assert_eq!(store.load(&key), Some(state));
    }

    #[test]
    fn retired_history_text_is_collected_only_after_its_last_session_reference() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let one = SessionRef::new("runner", "pi", "one");
        let two = SessionRef::new("runner", "pi", "two");
        let original = Durable {
            baseline: Some(Arc::new(Baseline {
                m0: "old history ".repeat(1_000),
                ..Baseline::default()
            })),
            ..Durable::default()
        };
        let newer = Durable {
            baseline: Some(Arc::new(Baseline {
                m0: "new history ".repeat(1_000),
                ..Baseline::default()
            })),
            ..Durable::default()
        };
        store.save(&one, &original).unwrap();
        store.save(&two, &original).unwrap();
        store.save(&one, &newer).unwrap();
        assert_eq!(store.load(&two), Some(original));
        assert_eq!(
            store
                .lock()
                .query_row("SELECT COUNT(*) FROM state_texts", [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            2
        );
        store.save(&two, &newer).unwrap();
        assert_eq!(
            store
                .lock()
                .query_row("SELECT COUNT(*) FROM state_texts", [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            1
        );
        assert_eq!(store.load(&one), Some(newer.clone()));
        assert_eq!(store.load(&two), Some(newer));
    }
}
