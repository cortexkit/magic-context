//! Session-owned context.db rows, encoded with the same table and column rules
//! as store.db in move_inventory. The coordinator durably records which sessions
//! are moving and refuses their MC requests until activation has installed both
//! context.db domain rows and store.db cache rows.
use crate::move_inventory::{self, Class, RowSelector, Store};
use crate::move_snapshot::{self as codec, SnapshotError};
use crate::move_store::{preflight_for, MoveError};
use rusqlite::{Connection, OpenFlags};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

pub struct ContextMoveStore {
    path: PathBuf,
}

impl ContextMoveStore {
    pub fn schema_version(&self) -> Result<u32, MoveError> {
        Ok(Self::reader(&self.path)?.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations WHERE version < 10000",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn fingerprint(&self, session: &str) -> Result<String, MoveError> {
        Ok(codec::fingerprint_half(
            &mut Self::reader(&self.path)?,
            Store::Context,
            session,
        )?)
    }
    pub fn has_session_data(&self, session: &str) -> Result<bool, MoveError> {
        Ok(codec::has_session_data(
            &Self::reader(&self.path)?,
            Store::Context,
            session,
        )?)
    }
    pub fn open(path: &Path) -> Result<Self, MoveError> {
        let conn = Self::reader(path)?;
        move_inventory::validate_schema(&conn, Store::Context).map_err(SnapshotError::from)?;
        Ok(Self { path: path.into() })
    }

    fn reader(path: &Path) -> Result<Connection, MoveError> {
        Ok(Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?)
    }

    pub fn capture(&self, session: &str, path: &Path) -> Result<u64, MoveError> {
        let mut conn = Self::reader(&self.path)?;
        let file = crate::private_permissions::create_file(path, true)?;
        let mut output = BufWriter::new(file);
        if let Err(error) = codec::capture_half(&mut conn, Store::Context, session, &mut output) {
            drop(output);
            std::fs::remove_file(path)?;
            return Err(error.into());
        }
        output.flush()?;
        output.get_ref().sync_all()?;
        Ok(output.get_ref().metadata()?.len())
    }

    pub fn validate_import(&self, session: &str, path: &Path) -> Result<(), MoveError> {
        let conn = Self::reader(&self.path)?;
        preflight_for(&conn, Store::Context, session, path, true)
    }

    /// Replace session-owned context.db rows in one SQLite transaction. The
    /// coordinator blocks requests until store.db is installed too. If a crash
    /// loses the completion record, repeating the delete-and-insert restores
    /// exactly the same file's rows while those requests remain blocked.
    pub fn replace(&self, session: &str, path: &Path) -> Result<(), MoveError> {
        let mut conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        move_inventory::validate_schema(&tx, Store::Context).map_err(SnapshotError::from)?;
        preflight_for(&tx, Store::Context, session, path, true)?;
        tx.execute(
            "UPDATE context_privilege_state SET enabled=1 WHERE id=1",
            [],
        )?;
        // Children precede parents when deleting; deferred foreign keys also
        // allow inventory order to install a complete, internally linked half.
        tx.pragma_update(None, "defer_foreign_keys", true)?;
        for table in move_inventory::TABLES.iter().rev().filter(|t| {
            t.store == Store::Context
                && matches!(t.class, Class::Ship | Class::Rebuild | Class::LocalReset)
        }) {
            let RowSelector::Predicate(predicate) = table.rows else {
                continue;
            };
            tx.execute(
                &format!(
                    "DELETE FROM {} WHERE {predicate}",
                    codec::quoted(table.table)
                ),
                [session],
            )?;
        }
        let mut input = BufReader::new(File::open(path)?);
        for table in codec::ship_tables(Store::Context) {
            let count = codec::read_section(&mut input, table)?;
            let columns = table.shipped_columns();
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                codec::quoted(table.table),
                columns
                    .iter()
                    .map(|c| codec::quoted(c))
                    .collect::<Vec<_>>()
                    .join(","),
                (1..=columns.len())
                    .map(|i| format!("?{i}"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            for _ in 0..count {
                let row = codec::read_row(&mut input, table)?;
                tx.execute(&sql, rusqlite::params_from_iter(row.iter()))?;
            }
        }
        let mut tail = [0];
        if input.read(&mut tail)? != 0 {
            return Err(SnapshotError::Invalid("manifest_mismatch").into());
        }
        tx.execute(
            "UPDATE context_privilege_state SET enabled=0 WHERE id=1",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
}
