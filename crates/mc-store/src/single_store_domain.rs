//! Where the module's domain rows are read and written: the host's `context.db`.
//!
//! After the one-time single-store migration, `context.db` is the only copy of the
//! memories, notes, compartments and history rows. This crate owns the SQL for those rows,
//! but not the file: the module holds the `context.db` connections, applies the schema
//! fence and the privileged-writer bracket, and hands them to [`crate::McStore`] through
//! [`ContextDomain`]. `store.db` keeps only cache rows.
//!
//! The two files are never written in one transaction. A caller that needs both writes
//! `store.db` first (recording what it is about to do, when a crash in between must be
//! repairable) and `context.db` second, and never holds one write lock while taking the
//! other.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::McStoreError;

/// The `context.db` connections `McStore` reads and writes domain rows through.
///
/// Both methods run the whole callback inside one transaction: a read sees one snapshot
/// (so revision heads agree with the rows they describe), and a write is one
/// `BEGIN IMMEDIATE`.
pub trait ContextDomain: Send + Sync {
    /// Run `read` inside one read transaction.
    fn read(
        &self,
        read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError>;

    /// Run `write` inside one `BEGIN IMMEDIATE` transaction. `tables` names the domain
    /// tables the callback writes, so an implementation that fences the schema per table
    /// checks exactly those.
    fn write(
        &self,
        tables: &[&str],
        write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError>;

    /// What the domain reports on the status surface: where it is and what its schema
    /// fence found. Null when it has nothing to report.
    fn status(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// The `McStoreError` a failed `context.db` operation reports.
pub fn context_error(code: &str, detail: impl std::fmt::Display) -> McStoreError {
    McStoreError::ContextDomain {
        code: code.to_string(),
        detail: detail.to_string(),
    }
}

/// Map a SQLite error from `context.db` to its reported code. A lock that outlived the
/// busy timeout is named separately, because the caller retries it rather than failing.
pub fn context_sql_error(error: rusqlite::Error) -> McStoreError {
    let code = match &error {
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            "context_busy"
        }
        _ => "context_sql",
    };
    context_error(code, error)
}

/// Use WAL's checkpoint durability rather than syncing each commit. The cache and
/// domain databases are backed up and restored together. Never apply this policy to
/// a rollback-journal transaction, whose cross-file atomicity needs FULL syncing.
pub fn set_wal_synchronous_normal(conn: &Connection) -> rusqlite::Result<()> {
    let journal: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if !journal.eq_ignore_ascii_case("wal") {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!("synchronous=NORMAL requires WAL, found {journal}")),
        ));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")
}

/// Offline tools may also open rollback-journal databases. Keep their existing
/// durability policy; use the runtime policy only when WAL is already active.
pub fn set_synchronous_normal_if_wal(conn: &Connection) -> rusqlite::Result<()> {
    let journal: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if journal.eq_ignore_ascii_case("wal") {
        set_wal_synchronous_normal(conn)?;
    }
    Ok(())
}

/// A plain two-connection [`ContextDomain`]: one reader, one writer, no schema fence.
///
/// The module wraps its fenced writer instead; this one serves tests and tools that open
/// a `context.db` they created themselves.
pub struct SqliteContextDomain {
    reader: Mutex<Connection>,
    writer: Mutex<Connection>,
}

impl SqliteContextDomain {
    /// Open `path` twice, with the busy timeout and foreign keys the host uses.
    pub fn open(path: &Path) -> Result<Self, McStoreError> {
        let open = || -> rusqlite::Result<Connection> {
            let conn = Connection::open(path)?;
            conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            Ok(conn)
        };
        let writer = open().map_err(context_sql_error)?;
        writer
            .query_row("PRAGMA journal_mode = WAL", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(context_sql_error)?;
        set_wal_synchronous_normal(&writer).map_err(context_sql_error)?;
        // Refuse any memory write on this connection for a project whose memories the
        // TypeScript host owns, exactly as the module's fenced `HostStore` writer does.
        crate::memory_lifecycle::authority::install_module_memory_authority_guard(&writer)
            .map_err(context_sql_error)?;
        let reader = open().map_err(context_sql_error)?;
        set_wal_synchronous_normal(&reader).map_err(context_sql_error)?;
        Ok(Self {
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        })
    }
}

impl ContextDomain for SqliteContextDomain {
    fn read(
        &self,
        read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        let mut conn = self
            .reader
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(context_sql_error)?;
        read(&transaction).map_err(context_sql_error)?;
        transaction.commit().map_err(context_sql_error)
    }

    fn write(
        &self,
        _tables: &[&str],
        write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        let mut conn = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(context_sql_error)?;
        write(&transaction).map_err(context_sql_error)?;
        transaction.commit().map_err(context_sql_error)
    }
}

/// The `context.db` schema the plugin creates, as the module's tests pin it.
#[cfg(any(test, feature = "test-support"))]
pub const CONTEXT_SCHEMA_SNAPSHOT: &str =
    include_str!("../../mc-module/tests/fixtures/context-db-schema.sql");

/// Create a `context.db` at `path` from the schema snapshot, recorded as already migrated
/// to single-store, unless a file is already there.
#[cfg(any(test, feature = "test-support"))]
pub fn create_test_context_db(path: &Path) -> Result<(), McStoreError> {
    if path.exists() {
        return Ok(());
    }
    let conn = Connection::open(path).map_err(context_sql_error)?;
    conn.execute_batch(CONTEXT_SCHEMA_SNAPSHOT)
        .map_err(context_sql_error)?;
    conn.execute_batch(
        "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0);
         INSERT OR IGNORE INTO single_store_state(id, state, migrated_at, migrated_by, report_json)
             VALUES (1, 'migrated', 0, 'test', '{}');",
    )
    .map_err(context_sql_error)?;
    Ok(())
}

#[cfg(test)]
mod durability_tests {
    use super::*;

    #[test]
    fn freshly_opened_context_connections_use_wal_normal() {
        let dir = tempfile::tempdir().unwrap();
        let domain = SqliteContextDomain::open(&dir.path().join("context.db")).unwrap();
        for connection in [&domain.reader, &domain.writer] {
            let conn = connection.lock().unwrap();
            let journal: String = conn
                .pragma_query_value(None, "journal_mode", |row| row.get(0))
                .unwrap();
            let synchronous: i64 = conn
                .pragma_query_value(None, "synchronous", |row| row.get(0))
                .unwrap();
            assert_eq!(journal, "wal");
            assert_eq!(synchronous, 1);
        }
    }

    #[test]
    fn normal_policy_refuses_a_non_wal_connection() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(set_wal_synchronous_normal(&conn).is_err());
    }
}
