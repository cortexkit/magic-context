//! Slow context-store transactions, shared with the dashboard's SQLite version.
//!
//! The clock starts after BEGIN succeeds and ends after COMMIT or rollback. The
//! interval includes SQLite's commit work; it is an upper bound on writer-lock
//! ownership because an automatic PASSIVE checkpoint can run after lock release.

use std::ops::Deref;
use std::time::{Duration, Instant};

use rusqlite::{Connection, Transaction, TransactionBehavior};

pub const SLOW_WRITER: Duration = Duration::from_millis(100);

pub struct WriterTransaction<'conn> {
    transaction: Option<Transaction<'conn>>,
    started: Instant,
    site: &'static str,
    host: &'static str,
    lane: &'static str,
    emit: fn(&str),
    outcome: &'static str,
    finished: bool,
    tables: &'conn [&'conn str],
}

impl<'conn> WriterTransaction<'conn> {
    pub fn immediate(
        conn: &'conn mut Connection,
        site: &'static str,
        host: &'static str,
        lane: &'static str,
        emit: fn(&str),
    ) -> rusqlite::Result<Self> {
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Ok(Self {
            transaction: Some(transaction),
            started: Instant::now(),
            site,
            host,
            lane,
            emit,
            outcome: "rolled_back",
            finished: false,
            tables: &[],
        })
    }

    pub fn with_tables(mut self, tables: &'conn [&'conn str]) -> Self {
        self.tables = tables;
        self
    }

    pub fn commit(self) -> rusqlite::Result<()> {
        self.commit_timed().map(|_| ())
    }

    pub fn commit_timed(mut self) -> rusqlite::Result<Duration> {
        let result = self.transaction.take().expect("open transaction").commit();
        self.outcome = if result.is_ok() {
            "committed"
        } else {
            "failed"
        };
        let elapsed = self.finish();
        result.map(|_| elapsed)
    }

    fn finish(&mut self) -> Duration {
        drop(self.transaction.take());
        self.finished = true;
        let elapsed = self.started.elapsed();
        if let Some(mut line) = report(self.site, self.host, self.lane, self.outcome, elapsed) {
            if !self.tables.is_empty() {
                line.push_str(" tables=");
                line.push_str(&self.tables.join(","));
            }
            (self.emit)(&line);
        }
        elapsed
    }
}

impl<'conn> Deref for WriterTransaction<'conn> {
    type Target = Transaction<'conn>;

    fn deref(&self) -> &Self::Target {
        self.transaction.as_ref().expect("open transaction")
    }
}

impl Drop for WriterTransaction<'_> {
    fn drop(&mut self) {
        // Finish rollback before measuring, including error and unwinding paths.
        if !self.finished {
            self.finish();
        }
    }
}

fn report(site: &str, host: &str, lane: &str, outcome: &str, elapsed: Duration) -> Option<String> {
    (elapsed >= SLOW_WRITER).then(|| {
        format!(
            "sqlite writer site={site} lane={lane} pid={} host={host} hold_ms={} outcome={outcome} timing=through_commit_upper_bound",
            std::process::id(),
            elapsed.as_millis(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn capture(line: &str) {
        LINES.lock().unwrap().push(line.to_string());
    }

    #[test]
    fn slow_writer_threshold_and_identity() {
        assert!(report(
            "site",
            "host",
            "foreground",
            "committed",
            Duration::from_millis(99)
        )
        .is_none());
        let line = report("lkg_save", "Pi", "foreground", "committed", SLOW_WRITER).unwrap();
        assert!(line.contains("site=lkg_save lane=foreground"));
        assert!(line.contains(&format!("pid={}", std::process::id())));
        assert!(line.contains("host=Pi hold_ms=100 outcome=committed"));
    }

    #[test]
    fn slow_writer_reports_commit_and_rollback_after_release() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE result(value);").unwrap();
        for committed in [true, false] {
            let mut tx =
                WriterTransaction::immediate(&mut conn, "domain_test", "ck-mc", "domain", capture)
                    .unwrap();
            tx.execute("INSERT INTO result VALUES (1)", []).unwrap();
            tx.started -= Duration::from_millis(101);
            if committed {
                tx.commit().unwrap();
            } else {
                drop(tx);
            }
            assert!(conn.is_autocommit());
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM result", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let lines = LINES.lock().unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("outcome=committed"));
        assert!(lines[1].contains("outcome=rolled_back"));
    }
}
