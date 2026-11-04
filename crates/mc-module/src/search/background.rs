//! Coalesced transcript indexing on its own thread and SQLite connection.
//! A session only posts a cursor; no runner read or index write runs on its worker.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use cortexkit_role_compaction::read::{Cursor, Detail, ReadRequest, Select, SessionRef};
use rusqlite::{params, Connection, OptionalExtension};
use tokio::sync::Notify;

use crate::client::RunnerClient;
use crate::context_db::ContextDb;

const PAGE_ENTRIES: u64 = 200;
const PAGE_BYTES: u64 = 64 * 1024;
const PAGES_PER_BATCH: usize = 4;

#[derive(Clone)]
pub(crate) struct Mark {
    pub newest: Option<Cursor>,
    pub from: Option<u64>,
    pub reconcile: Option<u64>,
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
                    let (mut mark, generation) = {
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
                        )
                    };
                    // Open independently: a slow reader or SQLite commit must not
                    // own the foreground ContextDb mutex or a Tokio executor thread.
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if db.is_none() {
                            db = Some(ContextDb::open_background(&path)?);
                        }
                        db.as_ref().unwrap().with_connection(|conn| {
                            runtime.block_on(batch(client.as_ref(), conn, &key, &mut mark))
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
                            merge(&mut pending.mark, mark);
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
    let from = mark
        .from
        .into_iter()
        .chain((dirty > 0).then_some(dirty))
        .min();
    if let Some(from) = from {
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
    if let Some(mut from) = mark.reconcile {
        for _ in 0..PAGES_PER_BATCH {
            let page = tokio::time::timeout(
                Duration::from_secs(10),
                client.read(
                    key,
                    ReadRequest::new(
                        Select::After {
                            after_ordinal: from.checked_sub(1).filter(|n| *n > 0),
                            limit: Some(PAGE_ENTRIES),
                        },
                        Detail::Compact,
                    )
                    .with_max_bytes(PAGE_BYTES),
                ),
            )
            .await
            .map_err(|_| "search reconcile read timed out".to_owned())?
            .map_err(|e| e.to_string())?;
            let newest = page.head.newest.as_ref().map_or(0, |c| c.ordinal);
            if super::messages::watermark(conn, session)
                .map_err(|e| e.to_string())?
                .max(0) as u64
                > newest
            {
                mark.from = Some(newest + 1);
                return Ok(true);
            }
            for (offset, entry) in page.entries.iter().enumerate() {
                if entry.ordinal != from + offset as u64 {
                    return Err("search reconcile contains an ordinal gap".into());
                }
            }
            super::messages::reconcile(conn, &key.harness, session, &page.entries)
                .map_err(|e| e.to_string())?;
            let complete = page.entries.last().is_some_and(|last| {
                page.head.newest.as_ref().is_some_and(|c| {
                    c.ordinal == last.ordinal && c.mid == last.mid && c.digest == last.digest
                })
            });
            if complete || (page.entries.is_empty() && from > newest) {
                mark.reconcile = None;
                if super::messages::watermark(conn, session)
                    .map_err(|e| e.to_string())?
                    .max(0) as u64
                    == newest
                {
                    return Ok(false);
                }
                break;
            }
            let Some(last) = page.entries.last() else {
                return Err("search reconcile made no progress".into());
            };
            from = last.ordinal + 1;
            mark.reconcile = Some(from);
        }
        if mark.reconcile.is_some() {
            return Ok(true);
        }
    }
    let watermark = super::messages::watermark(conn, session)
        .map_err(|e| e.to_string())?
        .max(0) as u64;
    // Verify the durable boundary on every new batch. After a crash there may
    // be no revert event in memory: a changed/missing boundary id forces a
    // replay from the start, so a replacement branch cannot leave stale rows.
    let mut after = watermark.saturating_sub(1);
    for _ in 0..PAGES_PER_BATCH {
        let request = ReadRequest::new(
            Select::After {
                after_ordinal: (after > 0).then_some(after),
                limit: Some(PAGE_ENTRIES),
            },
            Detail::Compact,
        )
        .with_max_bytes(PAGE_BYTES);
        let page = tokio::time::timeout(Duration::from_secs(10), client.read(key, request))
            .await
            .map_err(|_| "search read timed out".to_owned())?
            .map_err(|e| e.to_string())?;
        let newest = page.head.newest.as_ref().map_or(0, |c| c.ordinal);
        if watermark > 0 && after < watermark {
            let stored: Option<String> = conn.query_row("SELECT message_id FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2", params![session, watermark as i64], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if page
                .entries
                .first()
                .is_none_or(|e| e.ordinal != watermark || stored.as_deref() != Some(&e.mid))
            {
                truncate_chunk(conn, key, 1).map_err(|e| e.to_string())?;
                return Ok(true);
            }
        }
        if page.entries.is_empty() {
            if newest == 0 {
                return truncate_chunk(conn, key, 1)
                    .map(|done| !done)
                    .map_err(|e| e.to_string());
            }
            return Err("search read made no progress".into());
        }
        for (offset, entry) in page.entries.iter().enumerate() {
            if entry.ordinal != after + 1 + offset as u64 {
                return Err("search read contains an ordinal gap".into());
            }
        }
        let last = page.entries.last().unwrap();
        let complete = page.head.newest.as_ref().is_some_and(|c| {
            c.ordinal == last.ordinal && c.mid == last.mid && c.digest == last.digest
        });
        super::messages::index(conn, &key.harness, session, &page.entries)
            .map_err(|e| e.to_string())?;
        if complete {
            return Ok(false);
        }
        after = last.ordinal;
    }
    Ok(true)
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
