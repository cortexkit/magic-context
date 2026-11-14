//! Read-only connections for searches.
//!
//! A `ctx_search` can read for a second or more on a large store. On the
//! shared connection that would hold up every other call that needs the
//! store: a `ctx_memory` of another session, a Setup, upkeep. Searches and
//! the automatic memory hint therefore read on read-only connections of
//! their own, a few at most, so searches of different sessions also run
//! side by side. Writes, including a search's retrieval counts, stay on the
//! shared connection.
//!
//! In WAL mode a reader never blocks a writer, and a read transaction sees
//! the newest commit at the moment it starts. Each search starts its own
//! transaction when it begins and ends it when it is done, and an idle
//! connection keeps none open, so a search sees everything its session's
//! earlier calls committed, which finished before it started.

use std::path::Path;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};

use crate::search::messages::Coverage;

/// At most this many read-only connections are open at once.
const READERS: usize = 4;
/// After a read-only connection could not be opened, searches read on the
/// shared connection for this long before another one is tried.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// One read-only connection and the coverage proof it last made.
pub(super) struct Reader {
    conn: Connection,
    coverage: Coverage,
}

#[derive(Default)]
struct Pool {
    idle: Vec<Reader>,
    /// Connections open, idle or in use.
    open: usize,
    retry_at: Option<Instant>,
}

#[derive(Default)]
pub(super) struct Readers {
    pool: Mutex<Pool>,
    returned: Condvar,
}

/// A connection taken from the pool. Dropping it gives the connection
/// back, unless it still has a transaction open (a read that panicked):
/// that one is closed, so no later search can start inside an old
/// snapshot.
pub(super) struct Lease<'a> {
    readers: &'a Readers,
    reader: Option<Reader>,
}

impl Lease<'_> {
    pub(super) fn parts(&mut self) -> (&Connection, &mut Coverage) {
        let reader = self.reader.as_mut().expect("a lease holds its reader");
        (&reader.conn, &mut reader.coverage)
    }

    /// Close the connection instead of giving it back.
    pub(super) fn discard(mut self) {
        self.reader = None;
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut pool = self.readers.lock();
        match self.reader.take() {
            Some(reader) if reader.conn.is_autocommit() => pool.idle.push(reader),
            _ => pool.open -= 1,
        }
        drop(pool);
        self.readers.returned.notify_one();
    }
}

impl Readers {
    fn lock(&self) -> std::sync::MutexGuard<'_, Pool> {
        self.pool.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// An idle connection, a new one, or, when [`READERS`] are in use, the
    /// next one given back. `None` when no connection can be opened.
    pub(super) fn lease(&self, path: &Path) -> Option<Lease<'_>> {
        let mut pool = self.lock();
        loop {
            if let Some(reader) = pool.idle.pop() {
                return Some(Lease {
                    readers: self,
                    reader: Some(reader),
                });
            }
            if pool.open < READERS {
                if pool.retry_at.is_some_and(|at| Instant::now() < at) {
                    return None;
                }
                pool.open += 1;
                drop(pool);
                let opened = open(path);
                let mut pool = self.lock();
                return match opened {
                    Ok(conn) => {
                        pool.retry_at = None;
                        Some(Lease {
                            readers: self,
                            reader: Some(Reader {
                                conn,
                                coverage: Coverage::default(),
                            }),
                        })
                    }
                    Err(error) => {
                        pool.open -= 1;
                        if pool.retry_at.is_none() {
                            tracing::info!(
                                "ck-mc: context.db {}: searches read on the shared connection: {error}",
                                path.display()
                            );
                        }
                        pool.retry_at = Some(Instant::now() + RETRY_AFTER);
                        drop(pool);
                        self.returned.notify_one();
                        None
                    }
                };
            }
            pool = self
                .returned
                .wait(pool)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// A read-only connection to the store, refused unless the store is at the
/// schema version this build reads and in WAL mode, where readers and
/// writers never wait for each other.
fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    conn.busy_timeout(super::CONTEXT_BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    let found = super::live_schema_version(&conn).map_err(|error| error.to_string())?;
    if found != i64::from(super::SCHEMA_VERSION) {
        return Err(format!(
            "the store is at schema version {found}; this ck-mc reads version {}",
            super::SCHEMA_VERSION
        ));
    }
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("the store is in {mode} mode, not WAL"));
    }
    Ok(conn)
}
