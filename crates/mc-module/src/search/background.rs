//! Coalesced transcript indexing on its own thread and SQLite connection.
//! A session only posts a cursor; no runner read or index write runs on its worker.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use cortexkit_role_compaction::read::{Cursor, Detail, Entry, ReadRequest, Select, SessionRef};
use rusqlite::{params, Connection, OptionalExtension};
use tokio::sync::Notify;

use crate::client::RunnerClient;
use crate::context_db::ContextDb;

const PAGE_ENTRIES: u64 = 200;
const PAGE_BYTES: u64 = 64 * 1024;
const PAGES_PER_BATCH: usize = 4;
const ACTIVITY_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct Mark {
    pub newest: Option<Cursor>,
    pub from: Option<u64>,
    pub reconcile: Option<u64>,
    pub base: u64,
    pub entries: Arc<Vec<Entry>>,
}

#[derive(Default)]
struct Pending {
    instance: u64,
    mark: Option<Mark>,
    generation: u64,
    queued: bool,
    running: bool,
    error: Option<String>,
    warned_non_wal: bool,
    activity: Activity,
}

#[derive(Default)]
struct Activity {
    newest: Option<i64>,
    last_write: Option<Instant>,
}

impl Activity {
    fn indexed(&mut self, entry: &Entry) {
        let at = entry.written_at.min(i64::MAX as u64) as i64;
        self.newest = Some(self.newest.map_or(at, |previous| previous.max(at)));
    }

    fn publish(
        &mut self,
        conn: &mut Connection,
        key: &SessionRef,
        now: Instant,
    ) -> rusqlite::Result<()> {
        let Some(at) = self.newest else {
            return Ok(());
        };
        if self
            .last_write
            .is_some_and(|last| now.saturating_duration_since(last) < ACTIVITY_INTERVAL)
        {
            return Ok(());
        }
        let stored: Option<Option<i64>> = conn
            .query_row(
                "SELECT last_response_time FROM session_meta WHERE harness=?1 AND session_id=?2",
                params![key.harness, key.session],
                |row| row.get(0),
            )
            .optional()?;
        if stored.flatten().is_some_and(|stored| stored >= at) {
            self.newest = None;
            return Ok(());
        }
        // Only the activity field belongs to the runner here. In particular,
        // creating a row must not import or reset plugin cache/scheduler state.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO session_meta (harness, session_id, last_response_time) VALUES (?1, ?2, ?3)",
            params![key.harness, key.session, at],
        )?;
        let updated = tx.execute(
            "UPDATE session_meta SET last_response_time=?3 WHERE harness=?1 AND session_id=?2 AND (last_response_time IS NULL OR last_response_time<?3)",
            params![key.harness, key.session, at],
        )?;
        tx.commit()?;
        if inserted + updated > 0 {
            self.last_write = Some(Instant::now());
        }
        self.newest = None;
        Ok(())
    }
}

#[derive(Default)]
struct State {
    serial: u64,
    sessions: HashMap<SessionRef, Pending>,
    paused: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    resumed: Condvar,
    changed: Notify,
}

pub(crate) struct Background {
    tx: mpsc::Sender<Command>,
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

enum Command {
    Work(SessionRef, u64),
    Stop,
}

impl Drop for Background {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().paused = false;
        self.shared.resumed.notify_all();
        let _ = self.tx.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Background {
    pub fn new<C: RunnerClient>(client: Arc<C>, path: PathBuf) -> Self {
        // Client reconnects spawn reader/writer tasks on the current runtime.
        // They must belong to the module's continuously driven runtime, not
        // a private runtime parked whenever this thread waits for more work.
        let runtime = tokio::runtime::Handle::current();
        let (tx, rx) = mpsc::channel::<Command>();
        let shared = Arc::new(Shared::default());
        let own = shared.clone();
        let next = tx.clone();
        let thread = std::thread::Builder::new()
            .name("mc-message-index".into())
            .spawn(move || {
                let mut db = None;
                while let Ok(Command::Work(key, instance)) = rx.recv() {
                    let (mut mark, generation, mut activity) = {
                        let mut state = own.state.lock().unwrap();
                        while state.paused {
                            state = own.resumed.wait(state).unwrap();
                        }
                        let Some(pending) = state
                            .sessions
                            .get_mut(&key)
                            .filter(|p| p.instance == instance)
                        else {
                            continue;
                        };
                        pending.queued = false;
                        pending.running = true;
                        (
                            pending.mark.take().expect("dirty search session"),
                            pending.generation,
                            std::mem::take(&mut pending.activity),
                        )
                    };
                    // Open independently: a slow reader or SQLite commit must not
                    // own the foreground ContextDb mutex or a Tokio executor thread.
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if db.is_none() {
                            db = Some(ContextDb::open_background(&path)?);
                        }
                        db.as_ref().unwrap().with_connection(|conn| {
                            runtime.block_on(batch(
                                client.as_ref(),
                                conn,
                                &key,
                                &mut mark,
                                &mut activity,
                            ))
                        })
                    }));
                    let result = match result {
                        Ok(result) => result,
                        Err(panic) => {
                            // A panic poisons the private connection lock. A
                            // fresh connection lets the next dirty retry run.
                            db = None;
                            let message = panic
                                .downcast_ref::<&str>()
                                .copied()
                                .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
                                .unwrap_or("unknown panic");
                            Err(format!("search batch panicked: {message}"))
                        }
                    };
                    let mut state = own.state.lock().unwrap();
                    let Some(pending) = state
                        .sessions
                        .get_mut(&key)
                        .filter(|p| p.instance == instance)
                    else {
                        own.changed.notify_waiters();
                        continue;
                    };
                    pending.running = false;
                    pending.activity = activity;
                    match result {
                        Ok(more) => {
                            pending.error = None;
                            pending.warned_non_wal = false;
                            if more && pending.mark.is_none() {
                                pending.mark = Some(mark);
                            } else if more {
                                let newer = pending.mark.take().unwrap();
                                pending.mark = Some(mark);
                                merge(&mut pending.mark, newer);
                            }
                        }
                        Err(error) => {
                            let non_wal = error.contains("context_wal_required:");
                            if !non_wal || !pending.warned_non_wal {
                                tracing::warn!(
                                    "ck-mc: session {}: background search index: {error}",
                                    key.session
                                );
                            }
                            pending.warned_non_wal |= non_wal;
                            pending.error = Some(error);
                            let newer = pending.mark.take();
                            pending.mark = Some(mark);
                            if let Some(newer) = newer {
                                merge(&mut pending.mark, newer);
                            }
                        }
                    }
                    // A failed batch stays dirty but does not spin on a locked DB.
                    // A newer notice retries it; successful bounded catch-up yields
                    // to the other sessions already in the queue between batches.
                    if pending.mark.is_some()
                        && (pending.error.is_none() || pending.generation != generation)
                    {
                        pending.queued = true;
                        if next.send(Command::Work(key, instance)).is_err() {
                            break;
                        }
                    }
                    own.changed.notify_waiters();
                }
            })
            .expect("background search worker");
        Self {
            tx,
            shared,
            thread: Some(thread),
        }
    }

    pub fn mark(&self, key: &SessionRef, mark: Mark) {
        let mut state = self.shared.state.lock().unwrap();
        if !state.sessions.contains_key(key) {
            state.serial = state.serial.wrapping_add(1);
            let instance = state.serial;
            state.sessions.insert(
                key.clone(),
                Pending {
                    instance,
                    ..Pending::default()
                },
            );
        }
        let p = state.sessions.get_mut(key).unwrap();
        merge(&mut p.mark, mark);
        p.generation += 1;
        p.error = None;
        if !p.queued && !p.running {
            p.queued = true;
            if self
                .tx
                .send(Command::Work(key.clone(), p.instance))
                .is_err()
            {
                p.queued = false;
                p.error = Some("search worker stopped".into());
            }
        }
    }

    pub fn forget(&self, key: &SessionRef) {
        self.shared.state.lock().unwrap().sessions.remove(key);
        self.shared.changed.notify_waiters();
    }

    pub fn session_guard(&self, key: SessionRef) -> SessionGuard<'_> {
        SessionGuard {
            background: self,
            key,
        }
    }

    /// A test/maintenance fence, never used by a notice, compaction.ride request
    /// for an immediately needed view, or pre-user hook.
    pub async fn idle(&self, key: &SessionRef) -> Result<(), String> {
        loop {
            let changed = self.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.shared.state.lock().unwrap();
                let Some(p) = state.sessions.get(key) else {
                    return Ok(());
                };
                if !p.queued && !p.running {
                    return p.error.clone().map_or(Ok(()), Err);
                }
            }
            changed.await;
        }
    }

    #[cfg(feature = "notice-cost-timing")]
    pub fn pause(&self, paused: bool) {
        let mut state = self.shared.state.lock().unwrap();
        assert!(
            !paused || state.sessions.values().all(|p| !p.running),
            "drain search before pausing its CPU measurement"
        );
        state.paused = paused;
        self.shared.resumed.notify_all();
    }
}

fn merge(held: &mut Option<Mark>, next: Mark) {
    if let Some(old) = held {
        old.from = old.from.into_iter().chain(next.from).min();
        old.reconcile = old.reconcile.into_iter().chain(next.reconcile).min();
        old.newest = next.newest;
        old.base = next.base;
        old.entries = next.entries;
    } else {
        *held = Some(next);
    }
}

pub(crate) struct SessionGuard<'a> {
    background: &'a Background,
    key: SessionRef,
}
impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        self.background.forget(&self.key);
    }
}

async fn batch<C: RunnerClient>(
    client: &C,
    conn: &mut Connection,
    key: &SessionRef,
    mark: &mut Mark,
    activity: &mut Activity,
) -> Result<bool, String> {
    let more = index_batch(client, conn, key, mark, activity).await?;
    activity
        .publish(conn, key, Instant::now())
        .map_err(|e| e.to_string())?;
    Ok(more)
}

async fn index_batch<C: RunnerClient>(
    client: &C,
    conn: &mut Connection,
    key: &SessionRef,
    mark: &mut Mark,
    activity: &mut Activity,
) -> Result<bool, String> {
    let _timing = crate::notice_cost_timing::span("search.background_batch");
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("context_wal_required: indexer found {mode}"));
    }
    let session = &key.session;
    let dirty: u64 = conn
        .query_row(
            "SELECT dirty_floor_ordinal FROM message_history_index WHERE session_id=?1",
            [session],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0)
        .max(0) as u64;
    if let Some(from) = mark
        .from
        .into_iter()
        .chain((dirty > 0).then_some(dirty))
        .min()
    {
        for _ in 0..PAGES_PER_BATCH {
            if truncate_chunk(conn, key, from).map_err(|e| e.to_string())? {
                break;
            }
        }
        let remaining: i64 = conn
            .query_row(
                "SELECT dirty_floor_ordinal FROM message_history_index WHERE session_id=?1",
                [session],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if remaining > 0 {
            return Ok(true);
        }
        mark.from = None;
    }
    let newest = mark.newest.as_ref().map_or(0, |cursor| cursor.ordinal);
    let mut watermark = super::messages::watermark(conn, session)
        .map_err(|e| e.to_string())?
        .max(0) as u64;
    if watermark > newest {
        mark.from = Some(mark.base.min(newest + 1));
        return Ok(true);
    }
    // Setup and notices already supplied these compact entries. Compare only
    // their changed range; no runner read is needed to reconcile this window.
    if let Some(from) = mark.reconcile.take() {
        let start = mark.entries.partition_point(|entry| entry.ordinal < from);
        if let Err(error) =
            super::messages::reconcile(conn, &key.harness, session, &mark.entries[start..])
        {
            mark.reconcile = Some(from);
            return Err(error.to_string());
        }
    }
    // The supplied tip may already be indexed, including a streamed reply
    // reconciled above or activity held by the write-rate limit.
    if let Some(entry) = mark.entries.iter().rev().find(|e| e.ordinal <= watermark) {
        activity.indexed(entry);
    }
    for _ in 0..PAGES_PER_BATCH {
        if watermark >= newest {
            return Ok(false);
        }
        let next = watermark + 1;
        let start = mark.entries.partition_point(|entry| entry.ordinal < next);
        let cached = &mark.entries[start..];
        let updated = if cached.first().is_some_and(|entry| entry.ordinal == next) {
            let end = cached
                .partition_point(|entry| entry.ordinal <= newest)
                .min(PAGE_ENTRIES as usize);
            index_page(conn, key, &cached[..end], activity)?
        } else {
            // Only a missing durable range can require older transcript I/O.
            // Limit the read to that gap, stopping before the cached window.
            let before_cached = cached.first().map_or(newest + 1, |entry| entry.ordinal);
            let limit = PAGE_ENTRIES.min(before_cached.saturating_sub(next));
            if limit == 0 {
                return Err("search snapshot contains an ordinal gap".into());
            }
            let request = ReadRequest::new(
                Select::After {
                    after_ordinal: (watermark > 0).then_some(watermark),
                    limit: Some(limit),
                },
                Detail::Compact,
            )
            .with_max_bytes(PAGE_BYTES);
            let page = tokio::time::timeout(Duration::from_secs(10), client.read(key, request))
                .await
                .map_err(|_| "search gap read timed out".to_owned())?
                .map_err(|e| e.to_string())?;
            let actual_newest = page.head.newest.as_ref().map_or(0, |cursor| cursor.ordinal);
            if actual_newest < newest {
                mark.newest = page.head.newest;
                mark.from = Some(mark.base.min(actual_newest + 1));
                return Ok(true);
            }
            let entries: Vec<_> = page
                .entries
                .into_iter()
                .take_while(|entry| entry.ordinal < before_cached && entry.ordinal <= newest)
                .collect();
            if entries.is_empty() {
                return Err("search gap read made no progress".into());
            }
            for (offset, entry) in entries.iter().enumerate() {
                if entry.ordinal != next + offset as u64 {
                    return Err("search gap read contains an ordinal gap".into());
                }
            }
            index_page(conn, key, &entries, activity)?
        };
        if updated <= watermark {
            return Err("search index made no progress".into());
        }
        watermark = updated;
    }
    Ok(watermark < newest)
}

fn index_page(
    conn: &mut Connection,
    key: &SessionRef,
    entries: &[Entry],
    activity: &mut Activity,
) -> Result<u64, String> {
    super::messages::index(conn, &key.harness, &key.session, entries).map_err(|e| e.to_string())?;
    let watermark = super::messages::watermark(conn, &key.session)
        .map_err(|e| e.to_string())?
        .max(0) as u64;
    if let Some(entry) = entries.iter().rev().find(|e| e.ordinal <= watermark) {
        activity.indexed(entry);
    }
    Ok(watermark)
}

/// Invalidation itself is bounded, not just subsequent inserts. The durable
/// dirty floor survives a process stopping between deletion chunks.
fn truncate_chunk(conn: &mut Connection, key: &SessionRef, from: u64) -> rusqlite::Result<bool> {
    let from = from.max(1);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO message_history_index (session_id,last_indexed_ordinal,dirty_floor_ordinal,updated_at,harness) VALUES (?1,0,?2,0,?3) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal=MIN(last_indexed_ordinal,excluded.dirty_floor_ordinal-1), dirty_floor_ordinal=excluded.dirty_floor_ordinal", params![key.session, from as i64, key.harness])?;
    let end: Option<i64> = tx.query_row("SELECT MAX(message_ordinal) FROM (SELECT message_ordinal FROM message_history_source WHERE session_id=?1 AND message_ordinal>=?2 ORDER BY message_ordinal LIMIT ?3)", params![key.session,from as i64,PAGE_ENTRIES], |r| r.get(0))?;
    let legacy_remains = super::messages::delete_fts_range(
        &tx,
        &key.session,
        from as i64,
        end.unwrap_or(i64::MAX),
        PAGE_ENTRIES as i64,
    )?;
    if let Some(end) = end {
        tx.execute("DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3", params![key.session,from as i64,end])?;
        tx.execute("DELETE FROM message_history_source WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3", params![key.session,from as i64,end])?;
    }
    let remains: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM message_history_source WHERE session_id=?1 AND message_ordinal>=?2)", params![key.session,from as i64], |r|r.get(0))?;
    if !remains && !legacy_remains {
        tx.execute(
            "UPDATE message_history_index SET dirty_floor_ordinal=0 WHERE session_id=?1",
            [&key.session],
        )?;
    }
    tx.commit()?;
    Ok(!remains && !legacy_remains)
}

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;
