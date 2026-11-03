//! Dashboard writer timing uses the same threshold and fields as ck-mc.

use std::io::Write;
use std::path::PathBuf;

use rusqlite::Connection;

// Compile the transaction wrapper against the dashboard's rusqlite version,
// without pulling the cache store or its different SQLite library into Tauri.
#[path = "writer_transaction.rs"]
mod transaction;

pub fn begin<'conn>(
    conn: &'conn mut Connection,
    site: &'static str,
) -> rusqlite::Result<transaction::WriterTransaction<'conn>> {
    transaction::WriterTransaction::immediate(conn, site, "dashboard", "interactive", emit)
}

fn log_path() -> PathBuf {
    std::env::var("MAGIC_CONTEXT_LOG_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value.trim()))
        .unwrap_or_else(|| std::env::temp_dir().join("dashboard/magic-context/magic-context.log"))
}

fn emit(line: &str) {
    // File work happens only after a slow transaction has released its lock.
    // Reporting must not turn a successful user edit into an error.
    let _ = (|| -> std::io::Result<()> {
        let path = log_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        writeln!(
            options.open(path)?,
            "[{}] [magic-context] {line}",
            chrono::Utc::now().to_rfc3339()
        )
    })();
}

pub fn statement<T>(site: &str, operation: impl FnOnce() -> T) -> T {
    let started = std::time::Instant::now();
    let result = operation();
    let elapsed = started.elapsed();
    if elapsed >= transaction::SLOW_WRITER {
        // SQLite's autocommit API does not expose the acquisition boundary.
        emit(&format!("sqlite writer site={site} lane=interactive pid={} host=dashboard elapsed_ms={} timing=statement_including_acquisition", std::process::id(), elapsed.as_millis()));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_writer_reaches_the_discoverable_log_after_commit() {
        let mut env = crate::test_env::EnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dashboard.log");
        env.set("MAGIC_CONTEXT_LOG_PATH", &path);
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE result(value);").unwrap();
        let tx = begin(&mut conn, "dashboard_test").unwrap();
        tx.execute("INSERT INTO result VALUES (1)", []).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(110));
        tx.commit().unwrap();
        let line = std::fs::read_to_string(path).unwrap();
        assert!(line.contains("site=dashboard_test lane=interactive"));
        assert!(line.contains(&format!("pid={} host=dashboard", std::process::id())));
        assert!(line.contains("hold_ms="));
        assert!(line.contains("outcome=committed"));
        assert!(conn.is_autocommit());
    }
}
