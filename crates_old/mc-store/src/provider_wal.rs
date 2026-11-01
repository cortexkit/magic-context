//! Prime the shared serving WAL before accepting requests.
use crate::{McStore, McStoreError};

fn prime_tx(conn: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    conn.pragma_update(None, "user_version", version)
}

impl McStore {
    /// Pay WAL's first-header sync on the startup worker, before publishing the
    /// serving store. NORMAL still syncs a fresh WAL header on its first commit.
    /// Rewriting the unchanged user version dirties page one without changing
    /// application rows, the schema or the sync policy. The usual fenced writer
    /// still checks the lease epoch and commits this write.
    pub fn prime_wal_for_serving(&self) -> Result<(), McStoreError> {
        let wal = self.inner.with_conn(|conn| {
            conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
        })?;
        if wal.eq_ignore_ascii_case("wal") {
            self.inner.with_conn_fenced(prime_tx)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_wal_tests.rs"]
mod tests;
