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
}

#[derive(Default)]
struct Pending {
    mark: Option<Mark>,
    generation: u64,
    queued: bool,
    running: bool,
    error: Option<String>,
}

#[derive(Default)]
struct State {
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
    Work(SessionRef),
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
        let (tx, rx) = mpsc::channel::<Command>();
        let shared = Arc::new(Shared::default());
        let own = shared.clone();
        let next = tx.clone();
        let thread = std::thread::Builder::new()
            .name("mc-message-index".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("search runtime");
                let mut db = None;
                while let Ok(Command::Work(key)) = rx.recv() {
                    let (mark, generation) = {
                        let mut state = own.state.lock().unwrap();
                        while state.paused {
                            state = own.resumed.wait(state).unwrap();
                        }
                        let pending = state.sessions.get_mut(&key).expect("queued search session");
                        pending.queued = false;
                        pending.running = true;
                        (
                            pending.mark.take().expect("dirty search session"),
                            pending.generation,
                        )
                    };
                    // Open independently: a slow reader or SQLite commit must not
                    // own the foreground ContextDb mutex or a Tokio executor thread.
                    let result = (|| {
                        if db.is_none() {
                            db = Some(ContextDb::open(&path)?);
                        }
                        db.as_ref().unwrap().with_connection(|conn| {
                            runtime.block_on(batch(client.as_ref(), conn, &key, &mark))
                        })
                    })();
                    let mut state = own.state.lock().unwrap();
                    let pending = state.sessions.get_mut(&key).unwrap();
                    pending.running = false;
                    match result {
                        Ok(more) => {
                            pending.error = None;
                            if more && pending.mark.is_none() {
                                pending.mark = Some(Mark {
                                    newest: mark.newest,
                                    from: None,
                                });
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                "ck-mc: session {}: background search index: {error}",
                                key.session
                            );
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
                        if next.send(Command::Work(key)).is_err() {
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
        let p = state.sessions.entry(key.clone()).or_default();
        merge(&mut p.mark, mark);
        p.generation += 1;
        p.error = None;
        if !p.queued && !p.running {
            p.queued = true;
            if self.tx.send(Command::Work(key.clone())).is_err() {
                p.queued = false;
                p.error = Some("search worker stopped".into());
            }
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
        old.newest = next.newest;
    } else {
        *held = Some(next);
    }
}

async fn batch<C: RunnerClient>(
    client: &C,
    conn: &mut Connection,
    key: &SessionRef,
    mark: &Mark,
) -> Result<bool, String> {
    let _timing = crate::notice_cost_timing::span("search.background_batch");
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
    if let Some(end) = end {
        tx.execute("DELETE FROM message_history_fts WHERE rowid IN (SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3)", params![key.session,from as i64,end])?;
        tx.execute("DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3", params![key.session,from as i64,end])?;
        tx.execute("DELETE FROM message_history_source WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3", params![key.session,from as i64,end])?;
    }
    let remains: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM message_history_source WHERE session_id=?1 AND message_ordinal>=?2)", params![key.session,from as i64], |r|r.get(0))?;
    if !remains {
        tx.execute(
            "UPDATE message_history_index SET dirty_floor_ordinal=0 WHERE session_id=?1",
            [&key.session],
        )?;
    }
    tx.commit()?;
    Ok(!remains)
}

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;
