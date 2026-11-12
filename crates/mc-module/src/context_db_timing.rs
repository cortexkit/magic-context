//! Opt-in upper bounds on context.db write locks and connection-mutex holds.
//!
//! A connection operation must enter and leave in autocommit mode: no write
//! transaction may outlive its measured guard. The guard's entire duration
//! bounds every write lock taken inside it, including reads before a write,
//! multiple transactions, commit I/O, and time waiting for another writer.
//! Commit/rollback hooks also count zero-row writes and schema changes, which
//! total_changes alone would miss. No hooks or clocks exist in default builds.

use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::panic::Location;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Sample {
    pub site: &'static Location<'static>,
    pub elapsed: Duration,
    pub wrote: bool,
}

pub(super) struct Timing {
    completions: Arc<AtomicU64>,
    samples: Arc<Mutex<Vec<Sample>>>,
}

/// Keeps measurements available after an offline operation consumes its database.
#[derive(Clone)]
pub struct Recorder(Arc<Mutex<Vec<Sample>>>);

impl Recorder {
    pub fn take(&self) -> Vec<Sample> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

/// The write transactions the offline mover's write loop runs on a
/// connection of its own, which no [`Guard`] measures: `ck-mc move-in` and
/// the install of a session moved here from another machine. Nothing is
/// kept until [`transactions`] asks for it.
#[derive(Clone)]
pub struct Transactions(Arc<Mutex<Vec<Transaction>>>);

/// One write transaction of the mover's write loop: its phase, how many
/// rows it changed, and how long it held the write lock, from the moment
/// it had the lock to its commit or rollback.
#[derive(Debug)]
pub struct Transaction {
    pub phase: String,
    pub rows: u64,
    pub sample: Sample,
}

impl Transactions {
    pub fn take(&self) -> Vec<Transaction> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

static TRANSACTIONS: Mutex<Option<Transactions>> = Mutex::new(None);

/// Record every write transaction of the mover's write loop from now on,
/// in this process, into the returned recorder.
pub fn transactions() -> Transactions {
    let recorder = Transactions(Arc::default());
    *TRANSACTIONS.lock().unwrap() = Some(recorder.clone());
    recorder
}

/// One write transaction of the mover's write loop, which changed `rows`
/// rows and held the write lock for `elapsed`.
#[track_caller]
pub(crate) fn transaction(phase: &str, rows: u64, elapsed: Duration) {
    if let Some(recorder) = TRANSACTIONS.lock().unwrap().as_ref() {
        recorder.0.lock().unwrap().push(Transaction {
            phase: phase.to_owned(),
            rows,
            sample: Sample {
                site: Location::caller(),
                elapsed,
                wrote: true,
            },
        });
    }
}

impl Timing {
    pub(super) fn install(connection: &Connection) -> Self {
        let completions = Arc::new(AtomicU64::new(0));
        let commits = completions.clone();
        connection.commit_hook(Some(move || {
            commits.fetch_add(1, Ordering::Relaxed);
            false
        }));
        let rollbacks = completions.clone();
        connection.rollback_hook(Some(move || {
            rollbacks.fetch_add(1, Ordering::Relaxed);
        }));
        Self {
            completions,
            samples: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[track_caller]
    pub(super) fn lock<'a>(&'a self, mutex: &'a Mutex<Connection>) -> Guard<'a> {
        let connection = mutex.lock().unwrap_or_else(|p| p.into_inner());
        let started = Instant::now();
        assert!(
            connection.is_autocommit(),
            "transaction spans measured guards"
        );
        let changes = connection.total_changes();
        let completions = self.completions.load(Ordering::Relaxed);
        Guard {
            connection: Some(connection),
            timing: self,
            started,
            changes,
            completions,
            site: Location::caller(),
        }
    }

    pub(super) fn take(&self) -> Vec<Sample> {
        std::mem::take(&mut *self.samples.lock().unwrap())
    }

    pub(super) fn recorder(&self) -> Recorder {
        Recorder(self.samples.clone())
    }
}

pub(super) struct Guard<'a> {
    connection: Option<MutexGuard<'a, Connection>>,
    timing: &'a Timing,
    started: Instant,
    changes: u64,
    completions: u64,
    site: &'static Location<'static>,
}

impl Deref for Guard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.connection.as_deref().unwrap()
    }
}

impl DerefMut for Guard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.connection.as_deref_mut().unwrap()
    }
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let ended = self.is_autocommit();
        let wrote = self.total_changes() != self.changes
            || self.timing.completions.load(Ordering::Relaxed) != self.completions;
        drop(self.connection.take());
        let elapsed = self.started.elapsed();
        self.timing.samples.lock().unwrap().push(Sample {
            site: self.site,
            elapsed,
            wrote,
        });
        assert!(ended, "transaction spans measured guards");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measurement_includes_commit_rollback_schema_and_zero_row_writes() {
        let connection = Mutex::new(Connection::open_in_memory().unwrap());
        let timing = Timing::install(&connection.lock().unwrap());
        timing
            .lock(&connection)
            .execute_batch("CREATE TABLE facts (id INTEGER PRIMARY KEY)")
            .unwrap();
        timing
            .lock(&connection)
            .execute("UPDATE facts SET id = 1 WHERE id = 2", [])
            .unwrap();
        timing
            .lock(&connection)
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO facts VALUES (1); ROLLBACK;")
            .unwrap();
        timing
            .lock(&connection)
            .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let samples = timing.take();
        assert_eq!(samples.len(), 4);
        assert!(samples[..3].iter().all(|sample| sample.wrote));
        assert!(!samples[3].wrote);
    }

    #[test]
    fn measurement_bounds_work_before_and_after_a_write() {
        let connection = Mutex::new(Connection::open_in_memory().unwrap());
        let timing = Timing::install(&connection.lock().unwrap());
        {
            let guard = timing.lock(&connection);
            std::thread::sleep(Duration::from_millis(2));
            guard
                .execute_batch("CREATE TABLE facts (id INTEGER)")
                .unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let samples = timing.take();
        assert!(samples[0].wrote);
        assert!(samples[0].elapsed >= Duration::from_millis(4));
    }
}
