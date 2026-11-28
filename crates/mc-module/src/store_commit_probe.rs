use std::time::{Duration, Instant};

use rusqlite::Connection;

use super::Store;
use crate::context_db::ContextDb;

const TRANSACTIONS: i64 = 200;

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn distribution(store: &str, phase: &str, mut values: Vec<Duration>) {
    values.sort_unstable();
    let count = values.len();
    let total = millis(values.iter().sum());
    let median = millis(values[(count - 1) / 2] + values[count / 2]) / 2.0;
    eprintln!(
        "sqlite-commit store={store} phase={phase} count={count} total_ms={total:.3} mean_ms={:.3} min_ms={:.3} median_ms={median:.3} p95_ms={:.3} max_ms={:.3}",
        total / count as f64,
        millis(values[0]),
        millis(values[(count * 95).div_ceil(100) - 1]),
        millis(values[count - 1]),
    );
}

fn sample(store: &str, connection: &mut Connection) {
    let journal: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let synchronous: u32 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    let autocheckpoint: u32 = connection
        .pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))
        .unwrap();
    eprintln!("sqlite-commit store={store} journal={journal} synchronous={synchronous} wal_autocheckpoint={autocheckpoint}");
    assert_eq!(journal, "wal", "the freshly opened product store uses WAL");

    // Use the same one-row table in both throwaway stores so the measured
    // commits do not differ in triggers or indexes. Setup is not timed.
    connection
        .execute_batch(
            "CREATE TABLE commit_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
             INSERT INTO commit_probe VALUES (1, 0);",
        )
        .unwrap();
    let mut commits = Vec::with_capacity(TRANSACTIONS as usize);
    let mut transactions = Vec::with_capacity(TRANSACTIONS as usize);
    for value in 1..=TRANSACTIONS {
        let start = Instant::now();
        let transaction = connection.transaction().unwrap();
        let changed = transaction
            .execute("UPDATE commit_probe SET value = ?1 WHERE id = 1", [value])
            .unwrap();
        let commit_start = Instant::now();
        transaction.commit().unwrap();
        let done = Instant::now();
        commits.push(done - commit_start);
        transactions.push(done - start);
        assert_eq!(changed, 1);
    }
    let last: i64 = connection
        .query_row("SELECT value FROM commit_probe WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(last, TRANSACTIONS);
    distribution(store, "commit", commits);
    distribution(store, "transaction", transactions);
}

#[test]
#[ignore = "explicit timing of single-row transactions on throwaway production-mode stores"]
fn production_store_commit_timing() {
    let root = tempfile::tempdir().unwrap();
    eprintln!(
        "sqlite-commit arch={} sqlite={}",
        std::env::consts::ARCH,
        rusqlite::version()
    );
    let context = ContextDb::create(&root.path().join("context.db")).unwrap();
    context.with_connection(|connection| sample("context", connection));
    let sessions = Store::open(&root.path().join("sessions.db")).unwrap();
    sample("sessions", &mut sessions.lock());
}
