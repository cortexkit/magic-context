//! Store-half move primitives. Transport and the two-store coordinator live above
//! this API. Every method takes a short transaction on a dedicated connection;
//! capture uses a separate read-only connection and never McStore's shared handle.
//!
//! Install batches contain at most 16 source rows and 256 KiB of encoded row
//! bytes. An indivisible row larger than that budget is installed alone. Discard
//! deletes one session row per transaction; key-map cleanup deletes at most 64.
//! The default A6 test audits actual SQL writes and cursor advances to check these
//! structural limits. Wall-clock holds are printed, not asserted under parallel
//! load. Run the 100 ms wall-clock gate on a quiet machine with:
//! `cargo test --locked -p mc-store move_store::tests::a6_store_155_mib_wall_clock_lock_bound -- --ignored --exact --test-threads=1 --nocapture`.
use crate::move_inventory::{self, Class, KeyPolicy, RowSelector, Store};
use crate::move_snapshot::{self as codec, SnapshotError};
use crate::{McStore, McStoreError};
use rusqlite::{params, types::Value, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const MAX_INSTALL_ROWS: usize = 16;
const MAX_INSTALL_BYTES: u64 = 256 * 1024;

pub const SCHEMA_SQL: &str = r#"
-- cortexkit-store otherwise creates its local writer epoch on the first fenced
-- write. Materialize the same schema now so the inventory is deterministic.
CREATE TABLE IF NOT EXISTS cortexkit_fence (id INTEGER PRIMARY KEY CHECK (id = 0), epoch INTEGER NOT NULL);
CREATE TABLE mc_move_fences (
    session_id TEXT PRIMARY KEY, cut_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK(phase IN ('draining','frozen','staged','discarding'))
);
CREATE TABLE mc_move_cuts (
    cut_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, binding TEXT NOT NULL,
    manifest_digest TEXT NOT NULL, state TEXT NOT NULL
        CHECK(state IN ('exporting','sealed','aborted','staged','installed','discarding','discarded','activated')),
    result TEXT, file_path TEXT, discard_table INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mc_move_installs (
    cut_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
    manifest_digest TEXT NOT NULL, table_index INTEGER NOT NULL DEFAULT 0,
    file_offset INTEGER NOT NULL DEFAULT 0, rows_remaining INTEGER NOT NULL DEFAULT -1,
    last_source_key BLOB, complete INTEGER NOT NULL DEFAULT 0,
    prior_generation INTEGER NOT NULL DEFAULT 0, shipped_generation INTEGER NOT NULL DEFAULT 0,
    tag_count INTEGER NOT NULL DEFAULT 0, max_tag_number INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mc_move_key_map (
    cut_id TEXT NOT NULL, table_name TEXT NOT NULL, source_key BLOB NOT NULL,
    destination_key BLOB NOT NULL, PRIMARY KEY(cut_id, table_name, source_key)
);
-- Survives discard: a live module may still remember an earlier generation.
CREATE TABLE mc_move_tag_epochs (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
"#;

#[derive(Debug)]
pub enum MoveError {
    Snapshot(SnapshotError),
    Refused {
        code: &'static str,
        table: Option<String>,
    },
}
impl MoveError {
    fn refusal(code: &'static str) -> Self {
        Self::Refused { code, table: None }
    }
    fn table(code: &'static str, table: &str) -> Self {
        Self::Refused {
            code,
            table: Some(table.to_owned()),
        }
    }
    pub fn code(&self) -> &str {
        match self {
            Self::Refused { code, .. } => code,
            Self::Snapshot(SnapshotError::Invalid(code)) => code,
            Self::Snapshot(SnapshotError::Inventory(_)) => "inventory_unclassified",
            _ => "move_storage_error",
        }
    }
}
impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Snapshot(e) => e.fmt(f),
            Self::Refused { code, table } => write!(f, "{code}: {table:?}"),
        }
    }
}
impl std::error::Error for MoveError {}
impl From<SnapshotError> for MoveError {
    fn from(e: SnapshotError) -> Self {
        Self::Snapshot(e)
    }
}
impl From<rusqlite::Error> for MoveError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Snapshot(e.into())
    }
}
impl From<std::io::Error> for MoveError {
    fn from(e: std::io::Error) -> Self {
        Self::Snapshot(e.into())
    }
}

/// Stored verbatim for retry/conflict checks, including the opaque host cut.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CutBinding {
    pub cut_id: String,
    pub session_ref: String,
    pub host_session_id: String,
    pub host_end_offset: u64,
    pub host_cut: serde_json::Value,
    pub mc_start_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCutRecord {
    pub state: String,
    pub manifest_digest: String,
    pub capture_path: Option<String>,
    /// Exact persisted receipt bytes, including the planned mc stream end.
    pub receipt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallProgress {
    pub complete: bool,
    pub table_index: usize,
    pub last_source_key: Option<Vec<u8>>,
    pub rows_written: usize,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LockMetrics {
    pub transactions: u64,
    pub longest_hold: Duration,
}

/// Keep SQL trigger coverage independent of how a writer reaches a table. This
/// includes writers using with_conn instead of with_conn_fenced, bulk deletes,
/// trigger side effects, and another process's McStore instance.
///
/// Guards are installed on every ordinary McStore writer connection. The private
/// move connection has no guards and its methods verify cut ownership inside each
/// transaction. No persistent flag temporarily opens a session to other writers,
/// and read-only/raw diagnostic connections need no application SQL functions.
pub(crate) fn install_writer_guards(conn: &Connection) -> rusqlite::Result<()> {
    let recorded = crate::single_store_schema::recorded_store_version(conn)?;
    for table in move_inventory::tables(Store::Module) {
        let RowSelector::Predicate(_) = table.rows else {
            continue;
        };
        if table.class == Class::NotSession {
            continue;
        }
        // A store whose recorded version predates the migration that creates a
        // table (an older binary's schema, as migration-fence tests open it)
        // has nothing to guard there. A store at or past that migration must
        // have the table: creating its guard fails and the open is refused.
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?1)",
            [table.table],
            |r| r.get(0),
        )?;
        if !exists
            && crate::migration_creating_table(table.table)
                .is_some_and(|created| recorded < created)
        {
            continue;
        }
        let owner = table.session_column().ok_or_else(|| {
            rusqlite::Error::InvalidColumnName(format!("{} session owner", table.table))
        })?;
        for action in ["INSERT", "UPDATE", "DELETE"] {
            let sides: &[&str] = match action {
                "INSERT" => &["NEW"],
                "UPDATE" => &["OLD", "NEW"],
                _ => &["OLD"],
            };
            let allowed = draining_exception(table.table, action, table.columns);
            let conditions = sides.iter().map(|side| {
                if table.table == "mc_cache_sections" {
                    let owner = crate::async_compaction_layout::owner_expression(side);
                    return format!("({owner}) IS NULL OR EXISTS(SELECT 1 FROM mc_move_fences f WHERE f.session_id=({owner}) AND CASE WHEN f.phase='draining' AND ({allowed}) THEN 0 ELSE 1 END)");
                }
                format!(
                // CASE fails closed if a JSON field needed by the exception is
                // missing (SQL NULL must not become a terminalization permit).
                "EXISTS(SELECT 1 FROM mc_move_fences f WHERE f.session_id = {side}.{} AND CASE WHEN f.phase = 'draining' AND ({allowed}) THEN 0 ELSE 1 END)", codec::quoted(owner)
            )}).collect::<Vec<_>>().join(" OR ");
            conn.execute_batch(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS {} BEFORE {action} ON main.{} WHEN {conditions} BEGIN SELECT RAISE(ABORT, 'session_moving'); END;",
                codec::quoted(&format!("mc_move_guard_{}_{}", table.table, action.to_lowercase())), codec::quoted(table.table)
            ))?;
        }
    }
    Ok(())
}
fn draining_exception(table: &str, action: &str, columns: &[&str]) -> String {
    match (table, action) {
        ("mc_single_store_pending_publish" | "mc_historian_pending_run", "DELETE") => "1".into(),
        ("mc_historian_pending_run", "UPDATE") => "NEW.session_id IS OLD.session_id AND NEW.run_id IS OLD.run_id AND NEW.phase = 'cancelled'".into(),
        ("mc_cache_state", "UPDATE") => {
            let unchanged = columns.iter().filter(|c| !["meta", "row_version"].contains(c)).map(|c| format!("NEW.{} IS OLD.{}", codec::quoted(c), codec::quoted(c))).collect::<Vec<_>>().join(" AND ");
            // json_remove preserves all non-historian metadata, including opaque
            // future fields. Only an idle/terminal historian can be recorded.
            format!("{unchanged} AND json_valid(NEW.meta) AND json_valid(OLD.meta) AND json_remove(NEW.meta, '$.historian') = json_remove(OLD.meta, '$.historian') AND json_extract(NEW.meta, '$.historian.state') IN ('Idle','idle','Cancelled','cancelled','Completed','completed')")
        }
        // This non-shipped digest is maintained by the permitted meta-only CAS.
        ("mc_cache_state_digest", _) => "EXISTS(SELECT 1 FROM mc_cache_state s WHERE s.session_id = NEW.session_id AND json_extract(s.meta, '$.historian.state') IN ('Idle','idle','Cancelled','cancelled','Completed','completed'))".replace("NEW", if action == "DELETE" { "OLD" } else { "NEW" }),
        _ => "0".into(),
    }
}

pub(crate) fn phase(conn: &Connection, session: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT phase FROM mc_move_fences WHERE session_id = ?1",
        [session],
        |r| r.get(0),
    )
    .optional()
}
pub(crate) fn check_writer(conn: &Connection, session: &str) -> rusqlite::Result<()> {
    if phase(conn, session)?.is_some() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER),
            Some("session_moving".into()),
        ));
    }
    Ok(())
}

impl McStore {
    pub fn move_storage_path(&self) -> Option<&Path> {
        self.move_path.as_deref()
    }

    /// Return the persisted harness, original project root, native session id,
    /// and engine namespace. The registrar hashes the literal first three fields
    /// into sessionRef; substituting a resolved git identity would change it.
    pub fn move_provider_identities(
        &self,
    ) -> Result<Vec<(String, String, String, String)>, McStoreError> {
        self.inner.with_conn(|conn| {
            conn.prepare("SELECT harness,project_root,session,engine_namespace FROM mc_provider_conversations_v2 ORDER BY conv_key")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect()
        }).map_err(Into::into)
    }
    /// Used by the method layer for read/serve gating; table triggers independently
    /// protect every write in its own transaction.
    pub fn session_move_phase(&self, session: &str) -> Result<Option<String>, McStoreError> {
        self.inner
            .with_conn(|conn| phase(conn, session))
            .map_err(Into::into)
    }
    pub fn check_session_not_moving(&self, session: &str) -> Result<(), McStoreError> {
        if self.session_move_phase(session)?.is_some() {
            Err(McStoreError::SessionMoving)
        } else {
            Ok(())
        }
    }
    pub fn move_store(&self) -> Result<MoveStore, MoveError> {
        let path = self
            .move_path
            .as_ref()
            .ok_or_else(|| MoveError::refusal("move_requires_sqlite"))?;
        MoveStore::open(
            path,
            self.tag_cache_namespace.clone(),
            self.context_boundary_cache.clone(),
        )
    }
}

pub struct MoveStore {
    path: PathBuf,
    writer: Connection,
    metrics: LockMetrics,
    namespace: Arc<AtomicU64>,
    boundaries: Arc<Mutex<crate::context_boundaries::BoundaryValidationCache>>,
    #[cfg(test)]
    transaction_probe: Option<tests::TransactionProbe>,
}
impl MoveStore {
    pub fn schema_version(&self) -> Result<u32, MoveError> {
        Ok(crate::single_store_schema::recorded_store_version(
            &self.writer,
        )?)
    }
    pub fn cut_state(&self, cut: &str) -> Result<Option<String>, MoveError> {
        Ok(self
            .writer
            .query_row(
                "SELECT state FROM mc_move_cuts WHERE cut_id=?1",
                [cut],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn session_fence_cut(&self, session: &str) -> Result<Option<String>, MoveError> {
        Ok(self
            .writer
            .query_row(
                "SELECT cut_id FROM mc_move_fences WHERE session_id=?1",
                [session],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn restore_source_fence(&mut self, cut: &str) -> Result<(), MoveError> {
        self.write(cut, |tx| {
            let (session,state): (String,String)=tx.query_row("SELECT session_id,state FROM mc_move_cuts WHERE cut_id=?1", [cut], |r| Ok((r.get(0)?,r.get(1)?)))?;
            if state != "sealed" {return Err(MoveError::refusal("cut_conflict"));}
            tx.execute("INSERT OR IGNORE INTO mc_move_fences(session_id,cut_id,phase) VALUES(?1,?2,'frozen')",params![session,cut])?;
            Ok(())
        })
    }
    /// Copy the session's store.db rows before replacement, so an interrupted
    /// activation can restore them. The coordinator has already blocked requests
    /// for every moving session; encoding and schema checks match source capture.
    pub fn capture_undo(&self, session: &str, path: &Path) -> Result<u64, MoveError> {
        let mut reader = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut out = BufWriter::new(crate::private_permissions::create_file(path, true)?);
        codec::capture_half_checked(&mut reader, Store::Module, session, &mut out, |conn| {
            if crate::single_store_schema::recorded_store_version(conn)?
                != move_inventory::STORE_SCHEMA_VERSION
            {
                return Err(SnapshotError::Invalid("schema_mismatch"));
            }
            Ok(())
        })?;
        out.flush()?;
        out.get_ref().sync_all()?;
        Ok(out.get_ref().metadata()?.len())
    }
    pub fn busy_reason(&self, session: &str) -> Result<Option<&'static str>, MoveError> {
        let provider: bool = self.writer.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_conversations_v2 WHERE (session=?1 OR engine_namespace=?1) AND (json_type(hook_counters_json,'$.historian_launch_pending')='object' OR json_extract(hook_counters_json,'$.historian_evaluation_due')=1))", [session], |r|r.get(0))?;
        if provider {
            return Ok(Some("historian_running"));
        }
        let historian: bool = self.writer.query_row("SELECT EXISTS(SELECT 1 FROM mc_historian_pending_run WHERE session_id=?1) OR EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id=?1 AND json_extract(meta,'$.historian.state') NOT IN ('Idle','idle','Cancelled','cancelled','Completed','completed'))", [session], |r| r.get(0))?;
        if historian {
            return Ok(Some("historian_running"));
        }
        let pending: bool = self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM mc_single_store_pending_publish WHERE session_id=?1)",
            [session],
            |r| r.get(0),
        )?;
        Ok(pending.then_some("turn_in_flight"))
    }
    pub fn fingerprint(&self, session: &str) -> Result<String, MoveError> {
        let mut reader = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(codec::fingerprint_half(
            &mut reader,
            Store::Module,
            session,
        )?)
    }
    pub fn has_session_data(&self, session: &str) -> Result<bool, MoveError> {
        Ok(codec::has_session_data(
            &self.writer,
            Store::Module,
            session,
        )?)
    }
    /// Validate an incoming staged file without reserving or installing database
    /// rows. Replacing this session can reuse its primary keys, but a key owned
    /// by another session is always refused.
    pub fn validate_import(&self, session: &str, path: &Path) -> Result<(), MoveError> {
        preflight_for(&self.writer, Store::Module, session, path, true)
    }

    /// Mark this session's store.db rows unavailable before bounded removal.
    /// The coordinator is already durably blocking every moving session. An
    /// existing frozen marker is replaced only when prior_cut names its owner,
    /// preventing one move from clearing another move's write protection.
    pub fn reserve_discard(
        &mut self,
        binding: &CutBinding,
        prior_cut: Option<&str>,
    ) -> Result<(), MoveError> {
        let json =
            serde_json::to_string(binding).map_err(|_| MoveError::refusal("cut_conflict"))?;
        self.write(&binding.cut_id, |tx| {
            let existing: Option<String> = tx.query_row("SELECT binding FROM mc_move_cuts WHERE cut_id=?1", [&binding.cut_id], |r| r.get(0)).optional()?;
            if let Some(old) = existing {
                return if old == json { Ok(()) } else { Err(MoveError::refusal("cut_conflict")) };
            }
            let fence: Option<String> = tx.query_row("SELECT cut_id FROM mc_move_fences WHERE session_id=?1", [&binding.host_session_id], |r| r.get(0)).optional()?;
            if let Some(fence) = fence {
                if prior_cut != Some(fence.as_str()) { return Err(MoveError::refusal("move_in_progress")); }
                tx.execute("DELETE FROM mc_move_fences WHERE cut_id=?1", [&fence])?;
                tx.execute("DELETE FROM mc_move_installs WHERE cut_id=?1", [&fence])?;
            }
            tx.execute("INSERT INTO mc_move_cuts(cut_id,session_id,binding,manifest_digest,state) VALUES(?1,?2,?3,'','staged')", params![binding.cut_id,binding.host_session_id,json])?;
            tx.execute("INSERT INTO mc_move_fences VALUES(?1,?2,'staged')", params![binding.host_session_id,binding.cut_id])?;
            tx.execute("INSERT INTO mc_move_installs(cut_id,session_id,manifest_digest) VALUES(?1,?2,'')", params![binding.cut_id,binding.host_session_id])?;
            Ok(())
        })
    }

    /// Publish a completed module half only while the two-store coordinator still
    /// gates the entire ref set. Replays after a lost reply are harmless.
    pub fn activate(&mut self, cut: &str) -> Result<(), MoveError> {
        self.write(cut, |tx| {
            let (session, state): (String, String) = tx.query_row(
                "SELECT session_id,state FROM mc_move_cuts WHERE cut_id=?1",
                [cut],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state == "activated" {
                return Ok(());
            }
            if state != "installed" {
                return Err(MoveError::refusal("cut_conflict"));
            }
            require_owner(tx, cut, &session, "staged")?;
            tx.execute(
                "UPDATE mc_move_cuts SET state='activated' WHERE cut_id=?1",
                [cut],
            )?;
            tx.execute("DELETE FROM mc_move_fences WHERE cut_id=?1", [cut])?;
            tx.execute("DELETE FROM mc_move_installs WHERE cut_id=?1", [cut])?;
            Ok(())
        })
    }
    fn open(
        path: &Path,
        namespace: Arc<AtomicU64>,
        boundaries: Arc<Mutex<crate::context_boundaries::BoundaryValidationCache>>,
    ) -> Result<Self, MoveError> {
        let writer = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        writer.busy_timeout(Duration::from_secs(1))?;
        writer.pragma_update(None, "foreign_keys", true)?;
        crate::single_store_domain::set_synchronous_normal_if_wal(&writer)?;
        // A cursor commit must not also copy an accumulated WAL back into the
        // database. Ordinary store writers retain their checkpoint policy; this
        // dedicated connection only does the bounded move transactions.
        writer.pragma_update(None, "wal_autocheckpoint", 0)?;
        Ok(Self {
            path: path.to_owned(),
            writer,
            metrics: LockMetrics::default(),
            namespace,
            boundaries,
            #[cfg(test)]
            transaction_probe: None,
        })
    }
    pub fn lock_metrics(&self) -> LockMetrics {
        self.metrics
    }
    /// Prepare reads this before opening or recapturing a file. It can resume an
    /// exporting cut, return a sealed receipt without its deleted capture, or
    /// refuse an aborted cut. The original host binding is checked in all states.
    pub fn source_cut_record(
        &self,
        binding: &CutBinding,
    ) -> Result<Option<SourceCutRecord>, MoveError> {
        let row = self.writer.query_row(
            "SELECT binding,state,manifest_digest,file_path,result FROM mc_move_cuts WHERE cut_id = ?1",
            [&binding.cut_id],
            |r| Ok((r.get::<_, String>(0)?, SourceCutRecord { state:r.get(1)?, manifest_digest:r.get(2)?, capture_path:r.get(3)?, receipt:r.get(4)? })),
        ).optional()?;
        let Some((stored, record)) = row else {
            return Ok(None);
        };
        let expected =
            serde_json::to_string(binding).map_err(|_| MoveError::refusal("cut_conflict"))?;
        if stored != expected
            || !matches!(record.state.as_str(), "exporting" | "sealed" | "aborted")
        {
            return Err(MoveError::refusal("cut_conflict"));
        }
        if record.state == "aborted" {
            return Err(MoveError::refusal("cut_released"));
        }
        Ok(Some(record))
    }
    fn invalidate_caches(&self, session: &str) {
        // The module's tag baselines are keyed by this namespace. Moves are rare;
        // rotating it safely invalidates all baselines without reaching into the
        // module's private cache. Boundary entries can be invalidated by session.
        self.namespace.store(
            crate::NEXT_TAG_CACHE_NAMESPACE.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        self.boundaries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .invalidate_session(session);
    }

    fn write<T>(
        &mut self,
        _cut: &str,
        run: impl FnOnce(&Transaction<'_>) -> Result<T, MoveError>,
    ) -> Result<T, MoveError> {
        let tx = self
            .writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Waiting for another writer precedes this timestamp and holds no lock.
        let started = Instant::now();
        #[cfg(test)]
        if let Some(probe) = &self.transaction_probe {
            probe.begin();
        }
        let result = run(&tx);
        let result = match result {
            Ok(value) => tx.commit().map(|()| value).map_err(Into::into),
            Err(error) => {
                drop(tx);
                Err(error)
            }
        };
        self.metrics.transactions += 1;
        self.metrics.longest_hold = self.metrics.longest_hold.max(started.elapsed());
        #[cfg(test)]
        if let Some(probe) = &self.transaction_probe {
            probe.finish();
        }
        // SQLite's busy handler backs other writers off, so immediately taking
        // the next batch can starve a writer that is already waiting. Leave a
        // short scheduling window after the transaction released its lock.
        std::thread::park_timeout(Duration::from_millis(1));
        result
    }

    /// Take the source fence and durable identity binding before capture. A retry
    /// never changes the binding, including after abort/seal.
    pub fn acquire_fence(&mut self, binding: &CutBinding) -> Result<(), MoveError> {
        let json =
            serde_json::to_string(binding).map_err(|_| MoveError::refusal("cut_conflict"))?;
        self.write(&binding.cut_id, |tx| {
            if let Some((stored, state)) = tx.query_row("SELECT binding, state FROM mc_move_cuts WHERE cut_id = ?1", [&binding.cut_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
                if stored != json { return Err(MoveError::refusal("cut_conflict")); }
                if state == "aborted" { return Err(MoveError::refusal("cut_released")); }
                if !matches!(state.as_str(), "exporting" | "sealed") { return Err(MoveError::refusal("cut_conflict")); }
                return Ok(());
            }
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM mc_move_fences WHERE session_id = ?1)", [&binding.host_session_id], |r| r.get::<_, bool>(0))? { return Err(MoveError::refusal("move_in_progress")); }
            tx.execute("INSERT INTO mc_move_cuts(cut_id,session_id,binding,manifest_digest,state) VALUES(?1,?2,?3,'','exporting')", params![binding.cut_id,binding.host_session_id,json])?;
            tx.execute("INSERT INTO mc_move_fences VALUES(?1,?2,'draining')", params![binding.host_session_id,binding.cut_id])?;
            Ok(())
        })
    }
    pub fn freeze(&mut self, cut: &str) -> Result<(), MoveError> {
        self.write(cut, |tx| {
            let session = source_session(tx, cut)?;
            let provider: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_conversations_v2 WHERE (session=?1 OR engine_namespace=?1) AND (json_type(hook_counters_json,'$.historian_launch_pending')='object' OR json_extract(hook_counters_json,'$.historian_evaluation_due')=1))", [&session], |r|r.get(0))?;
            if provider {return Err(MoveError::refusal("session_busy"));}
            for table in ["mc_single_store_pending_publish", "mc_historian_pending_run"] {
                if tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id = ?1)"), [&session], |r| r.get::<_, bool>(0))? {
                    return Err(MoveError::refusal(if table == "mc_single_store_pending_publish" { "pending_context_write" } else { "session_busy" }));
                }
            }
            let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1 AND json_extract(meta, '$.historian.state') NOT IN ('Idle','idle','Cancelled','cancelled','Completed','completed'))", [&session], |r| r.get(0))?;
            if busy { return Err(MoveError::refusal("session_busy")); }
            tx.execute("UPDATE mc_move_fences SET phase = 'frozen' WHERE cut_id = ?1 AND phase = 'draining'", [cut])?;
            Ok(())
        })
    }
    pub fn capture(&self, cut: &str, path: &Path) -> Result<u64, MoveError> {
        self.capture_inner(cut, path, |_| {})
    }

    // The test commits through a peer store after the read snapshot is pinned.
    #[cfg(test)]
    fn capture_with_snapshot_hook(
        &self,
        cut: &str,
        path: &Path,
        on_snapshot_ready: impl FnOnce(&Connection),
    ) -> Result<u64, MoveError> {
        self.capture_inner(cut, path, on_snapshot_ready)
    }

    fn capture_inner(
        &self,
        cut: &str,
        path: &Path,
        on_snapshot_ready: impl FnOnce(&Connection),
    ) -> Result<u64, MoveError> {
        let mut reader = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let session: String = reader
            .query_row(
                "SELECT session_id FROM mc_move_fences WHERE cut_id = ?1 AND phase = 'frozen'",
                [cut],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| MoveError::refusal("session_moving"))?;
        let session_for_check = session.as_str();
        let file = crate::private_permissions::create_file(path, true)?;
        let mut out = BufWriter::new(file);
        let result = codec::capture_half_checked(
            &mut reader,
            Store::Module,
            &session,
            &mut out,
            move |conn| {
                let frozen: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_move_fences WHERE cut_id = ?1 AND session_id = ?2 AND phase = 'frozen')",params![cut,session_for_check],|r|r.get(0))?;
                if !frozen {
                    return Err(SnapshotError::Invalid("session_moving"));
                }
                if crate::single_store_schema::recorded_store_version(conn)?
                    != move_inventory::STORE_SCHEMA_VERSION
                {
                    return Err(SnapshotError::Invalid("schema_mismatch"));
                }
                on_snapshot_ready(conn);
                Ok(())
            },
        );
        if let Err(error) = result {
            drop(out);
            std::fs::remove_file(path)?;
            return Err(error.into());
        }
        out.flush()?;
        out.get_ref().sync_all()?;
        Ok(out.get_ref().metadata()?.len())
    }
    /// Persist capture identity and receipt before any transport call; retries
    /// return these bytes rather than recapturing. `result` is the receipt JSON.
    pub fn record_capture(
        &mut self,
        cut: &str,
        manifest_digest: &str,
        path: &Path,
        result: &str,
    ) -> Result<(), MoveError> {
        self.write(cut, |tx| {
            source_session(tx, cut)?;
            let (old, old_path, old_result): (String, Option<String>, Option<String>) = tx.query_row("SELECT manifest_digest,file_path,result FROM mc_move_cuts WHERE cut_id = ?1", [cut], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if !old.is_empty() && (old != manifest_digest || old_path.as_deref() != Some(path.to_string_lossy().as_ref()) || old_result.as_deref() != Some(result)) { return Err(MoveError::refusal("cut_conflict")); }
            tx.execute("UPDATE mc_move_cuts SET manifest_digest = ?2, file_path = ?3, result = ?4 WHERE cut_id = ?1 AND state = 'exporting'", params![cut,manifest_digest,path.to_string_lossy(),result])?;
            Ok(())
        })
    }
    /// Seal keeps the fence. Abort removes it only for its owning source cut.
    /// File deletion is repeatable even if the process died after the tombstone.
    pub fn release_source(&mut self, cut: &str, seal: bool) -> Result<Option<String>, MoveError> {
        let (path, result) = self.write(cut, |tx| {
            let row = tx
                .query_row(
                    "SELECT state,file_path,result FROM mc_move_cuts WHERE cut_id = ?1",
                    [cut],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((state, path, result)) = row else {
                return Err(MoveError::refusal("cut_conflict"));
            };
            let terminal = if seal { "sealed" } else { "aborted" };
            if state != "exporting" && state != terminal {
                return Err(MoveError::refusal("cut_conflict"));
            }
            if seal && result.is_none() {
                return Err(MoveError::refusal("cut_conflict"));
            }
            tx.execute(
                "UPDATE mc_move_cuts SET state = ?2 WHERE cut_id = ?1",
                params![cut, terminal],
            )?;
            if !seal {
                tx.execute("DELETE FROM mc_move_fences WHERE cut_id = ?1", [cut])?;
            }
            Ok((path, result))
        })?;
        remove_file(path.as_deref())?;
        Ok(result)
    }

    /// Read this before touching staging/transport. Installed cuts retain their
    /// exact result even once the input and staging files no longer exist.
    pub fn installed_result(
        &self,
        binding: &CutBinding,
        manifest_digest: Option<&str>,
    ) -> Result<Option<String>, MoveError> {
        let row = self
            .writer
            .query_row(
                "SELECT binding,manifest_digest,state,result FROM mc_move_cuts WHERE cut_id = ?1",
                [&binding.cut_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((json, digest, state, result)) = row else {
            return Ok(None);
        };
        let expected =
            serde_json::to_string(binding).map_err(|_| MoveError::refusal("cut_conflict"))?;
        if json != expected || manifest_digest.is_some_and(|d| d != digest) {
            return Err(MoveError::refusal("cut_conflict"));
        }
        if state == "installed" {
            return Ok(result);
        }
        if state != "staged" {
            return Err(MoveError::refusal("cut_conflict"));
        }
        Ok(None)
    }

    /// Preflight reads the entire staged half on an independent connection before
    /// reservation writes anything. Key policies currently preserve or refuse;
    /// no surrogate is remapped without the served-byte/reference proof.
    pub fn reserve_install(
        &mut self,
        binding: &CutBinding,
        digest: &str,
        staging: &Path,
    ) -> Result<(), MoveError> {
        self.installed_result(binding, Some(digest))?;
        let existing: bool = self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM mc_move_installs WHERE cut_id = ?1)",
            [&binding.cut_id],
            |r| r.get(0),
        )?;
        if existing {
            return Ok(());
        }
        let reader = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        move_inventory::validate_schema(&reader, Store::Module).map_err(SnapshotError::from)?;
        if crate::single_store_schema::recorded_store_version(&reader)?
            != move_inventory::STORE_SCHEMA_VERSION
        {
            return Err(MoveError::refusal("schema_mismatch"));
        }
        check_destination(&reader, &binding.host_session_id)?;
        preflight(&reader, &binding.host_session_id, staging)?;
        let json =
            serde_json::to_string(binding).map_err(|_| MoveError::refusal("cut_conflict"))?;
        self.write(&binding.cut_id, |tx| {
            // Recheck under the reservation lock: a writer may have committed
            // while preflight inspected the independent read connection.
            check_destination(tx, &binding.host_session_id)?;
            if phase(tx, &binding.host_session_id)?.is_some() { return Err(MoveError::refusal("cut_conflict")); }
            let prior: i64 = tx.query_row("SELECT MAX(COALESCE((SELECT generation FROM mc_tag_cache_generations WHERE session_id = ?1),0),COALESCE((SELECT generation FROM mc_move_tag_epochs WHERE session_id = ?1),0))", [&binding.host_session_id], |r| r.get(0))?;
            tx.execute("INSERT INTO mc_move_cuts(cut_id,session_id,binding,manifest_digest,state,file_path) VALUES(?1,?2,?3,?4,'staged',?5)", params![binding.cut_id,binding.host_session_id,json,digest,staging.to_string_lossy()])?;
            tx.execute("INSERT INTO mc_move_fences VALUES(?1,?2,'staged')", params![binding.host_session_id,binding.cut_id])?;
            tx.execute("INSERT INTO mc_move_installs(cut_id,session_id,manifest_digest,prior_generation) VALUES(?1,?2,?3,?4)", params![binding.cut_id,binding.host_session_id,digest,prior])?;
            Ok(())
        })
    }

    /// One bounded batch; call again (or after restart) until complete. The file
    /// cursor and last *source* PK, key map and rows commit in the same transaction.
    pub fn install_batch(&mut self, cut: &str) -> Result<InstallProgress, MoveError> {
        let (session, path, state): (String, String, String) = self
            .writer
            .query_row(
                "SELECT session_id,file_path,state FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| MoveError::refusal("cut_conflict"))?;
        if state != "staged" {
            return Err(MoveError::refusal("cut_conflict"));
        }
        let cursor = read_cursor(&self.writer, cut)?;
        if cursor.complete {
            return Ok(cursor.progress(0));
        }
        let tables = codec::ship_tables(Store::Module).collect::<Vec<_>>();
        let mut input = BufReader::new(File::open(path)?);
        input.seek(SeekFrom::Start(cursor.offset))?;
        let mut next = cursor.clone();
        // Decoding and file I/O happen before BEGIN IMMEDIATE. Bound both rows
        // and byte work; a single large SQLite value is an indivisible insert.
        let mut rows = Vec::new();
        let mut bytes = 0u64;
        while next.table < tables.len()
            && rows.len() < MAX_INSTALL_ROWS
            && bytes < MAX_INSTALL_BYTES
        {
            let table = tables[next.table];
            if next.remaining == -1 {
                next.remaining = i64::try_from(codec::read_section(&mut input, table)?)
                    .map_err(|_| MoveError::refusal("manifest_mismatch"))?;
            }
            if next.remaining == 0 {
                next.table += 1;
                next.remaining = -1;
                next.key = None;
                continue;
            }
            let row_start = input.stream_position()?;
            let row = codec::read_row(&mut input, table)?;
            let end = input.stream_position()?;
            let row_bytes = end - row_start;
            if !rows.is_empty() && bytes + row_bytes > MAX_INSTALL_BYTES {
                // Keep the decoded section header, but leave the next row for
                // the next transaction. A lone oversized row still makes progress.
                input.seek(SeekFrom::Start(row_start))?;
                break;
            }
            let key = codec::source_key(table, &row)?;
            next.key = Some(key.clone());
            next.remaining -= 1;
            bytes += row_bytes;
            next.offset = end;
            rows.push((table, row, key, next.clone()));
        }
        next.offset = input.stream_position()?;
        if next.table == tables.len() {
            let mut tail = [0];
            if input.read(&mut tail)? != 0 {
                return Err(MoveError::refusal("manifest_mismatch"));
            }
            next.complete = true;
        }
        self.write(cut, |tx| {
            require_owner(tx, cut, &session, "staged")?;
            // Serialize competing retries. The later caller re-reads instead of
            // reapplying a batch decoded from a cursor which already advanced.
            if read_cursor(tx, cut)? != cursor { return Ok(read_cursor(tx, cut)?.progress(0)); }
            let started = Instant::now(); let mut written = 0; let mut committed = next.clone();
            for (table,row,key,after) in &rows {
                validate_row_owner(table, row, &session)?;
                if table.table == "mc_tag_cache_generations" {
                    let cols = table.shipped_columns();
                    let integer = |name| match &row[cols.iter().position(|c| *c == name).unwrap()] { Value::Integer(n) => Ok(*n), _ => Err(MoveError::refusal("manifest_mismatch")) };
                    tx.execute("UPDATE mc_move_installs SET shipped_generation = ?2, tag_count = ?3, max_tag_number = ?4 WHERE cut_id = ?1", params![cut,integer("generation")?,integer("tag_count")?,integer("max_tag_number")?])?;
                } else {
                    let columns = table.shipped_columns();
                    let sql = format!("INSERT INTO {} ({}) VALUES ({})", codec::quoted(table.table), columns.iter().map(|c| codec::quoted(c)).collect::<Vec<_>>().join(","), (1..=columns.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(","));
                    if let Err(error) = tx.execute(&sql, rusqlite::params_from_iter(row.iter())) {
                        if matches!(&error, rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::ConstraintViolation) { return Err(MoveError::table("key_collision",table.table)); }
                        return Err(error.into());
                    }
                }
                // Identity mappings are durable too. A future reviewed reassign
                // policy must populate its real mapping here, never in memory.
                tx.execute("INSERT INTO mc_move_key_map VALUES(?1,?2,?3,?3)", params![cut,table.table,key])?;
                written += 1;
                if started.elapsed() >= Duration::from_millis(25) { committed = after.clone(); break; }
            }
            if committed.complete { finish_tags(tx, cut, &session)?; }
            save_cursor(tx, cut, &committed)?;
            Ok(committed.progress(written))
        })
    }

    /// The two-store coordinator calls this only after both halves completed.
    /// Keeping completion separate from file cleanup makes a lost response safe.
    pub fn finish_install(&mut self, cut: &str, result: &str) -> Result<(), MoveError> {
        let path = self.write(cut, |tx| {
            let cursor = read_cursor(tx, cut)?;
            if !cursor.complete {
                return Err(MoveError::refusal("cut_conflict"));
            }
            let (session, state, path): (String, String, Option<String>) = tx.query_row(
                "SELECT session_id,state,file_path FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            require_owner(tx, cut, &session, "staged")?;
            if !matches!(state.as_str(), "staged" | "installed") {
                return Err(MoveError::refusal("cut_conflict"));
            }
            tx.execute(
                "UPDATE mc_move_cuts SET state = 'installed', result = ?2 WHERE cut_id = ?1",
                params![cut, result],
            )?;
            Ok(path)
        })?;
        let session: String = self.writer.query_row(
            "SELECT session_id FROM mc_move_cuts WHERE cut_id = ?1",
            [cut],
            |r| r.get(0),
        )?;
        self.invalidate_caches(&session);
        remove_file(path.as_deref())?;
        Ok(())
    }

    /// Begin discard without dropping the gate; the coordinator gates context.db
    /// next, then repeatedly calls discard_batch on each half.
    pub fn begin_discard(&mut self, cut: &str) -> Result<(), MoveError> {
        let session = self.write(cut, |tx| {
            let (session, state): (String, String) = tx
                .query_row(
                    "SELECT session_id,state FROM mc_move_cuts WHERE cut_id = ?1",
                    [cut],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| MoveError::refusal("cut_conflict"))?;
            if state == "discarded" {
                return Ok(session);
            }
            if !matches!(state.as_str(), "staged" | "installed" | "discarding") {
                return Err(MoveError::refusal("cut_conflict"));
            }
            require_owner(
                tx,
                cut,
                &session,
                if state == "discarding" {
                    "discarding"
                } else {
                    "staged"
                },
            )?;
            tx.execute(
                "UPDATE mc_move_cuts SET state = 'discarding' WHERE cut_id = ?1",
                [cut],
            )?;
            tx.execute(
                "UPDATE mc_move_fences SET phase = 'discarding' WHERE cut_id = ?1",
                [cut],
            )?;
            Ok(session)
        })?;
        self.invalidate_caches(&session);
        Ok(())
    }
    pub fn discard_batch(&mut self, cut: &str) -> Result<bool, MoveError> {
        let row = self
            .writer
            .query_row(
                "SELECT session_id,state,discard_table FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, usize>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| MoveError::refusal("cut_conflict"))?;
        let (session, state, index) = row;
        if state == "discarded" {
            return Ok(true);
        }
        if state != "discarding" {
            return Err(MoveError::refusal("cut_conflict"));
        }
        let tables = discard_tables();
        if index == tables.len() {
            return Ok(true);
        }
        self.write(cut, |tx| {
            require_owner(tx, cut, &session, "discarding")?;
            let current: usize = tx.query_row(
                "SELECT discard_table FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| r.get(0),
            )?;
            if current != index {
                return Ok(current == tables.len());
            }
            let table = tables[index];
            let RowSelector::Predicate(predicate) = table.rows else {
                return Err(MoveError::refusal("inventory_mismatch"));
            };
            // Tag deletion triggers keep summaries alive; delete that summary
            // last. No parent FK cascades can delete an unbounded half here.
            let order = if table.table == "mc_cache_sections" {
                // Keep v2 ownership headers until every dependent KV row has
                // been removed; later batches still need their selector.
                format!("ORDER BY CASE WHEN session_id='{}' THEN 1 ELSE 0 END", crate::async_compaction_layout::HEADERS)
            } else { String::new() };
            let sql = format!(
                "DELETE FROM {} WHERE rowid IN (SELECT rowid FROM {} WHERE ({predicate}) {order} LIMIT 1)",
                codec::quoted(table.table),
                codec::quoted(table.table)
            );
            let deleted = tx.execute(&sql, [&session])?;
            let next = if deleted == 0 { index + 1 } else { index };
            tx.execute(
                "UPDATE mc_move_cuts SET discard_table = ?2 WHERE cut_id = ?1",
                params![cut, next],
            )?;
            Ok(next == tables.len())
        })
    }
    /// Delete key-map rows in bounded batches after both halves' row deletions.
    pub fn discard_key_map_batch(&mut self, cut: &str) -> Result<bool, MoveError> {
        self.write(cut, |tx| {
            let state: String = tx.query_row("SELECT state FROM mc_move_cuts WHERE cut_id = ?1",[cut],|r|r.get(0))?;
            if state == "discarded" { return Ok(true); }
            if state != "discarding" { return Err(MoveError::refusal("cut_conflict")); }
            let deleted = tx.execute("DELETE FROM mc_move_key_map WHERE rowid IN (SELECT rowid FROM mc_move_key_map WHERE cut_id = ?1 LIMIT 64)",[cut])?;
            Ok(deleted == 0)
        })
    }
    /// Call only after context.db's marker/gate are removed. The cut tombstone
    /// outlives both markers, so replay after this step remains deterministic.
    pub fn finish_discard(&mut self, cut: &str) -> Result<(), MoveError> {
        let path: Option<String> = self
            .writer
            .query_row(
                "SELECT file_path FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        remove_file(path.as_deref())?;
        self.write(cut, |tx| {
            let (state, index): (String, usize) = tx
                .query_row(
                    "SELECT state,discard_table FROM mc_move_cuts WHERE cut_id = ?1",
                    [cut],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| MoveError::refusal("cut_conflict"))?;
            if state == "discarded" {
                return Ok(());
            }
            if state != "discarding" || index != discard_tables().len() {
                return Err(MoveError::refusal("cut_conflict"));
            }
            let maps: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_move_key_map WHERE cut_id = ?1)",
                [cut],
                |r| r.get(0),
            )?;
            if maps {
                return Err(MoveError::refusal("cut_conflict"));
            }
            tx.execute("DELETE FROM mc_move_installs WHERE cut_id = ?1", [cut])?;
            tx.execute("DELETE FROM mc_move_fences WHERE cut_id = ?1", [cut])?;
            tx.execute(
                "UPDATE mc_move_cuts SET state = 'discarded' WHERE cut_id = ?1",
                [cut],
            )?;
            Ok(())
        })
    }
    #[cfg(any(test, feature = "test-support"))]
    pub fn activate_for_test(&mut self, cut: &str) -> Result<(), MoveError> {
        self.write(cut, |tx| {
            let (session, state): (String, String) = tx.query_row(
                "SELECT session_id,state FROM mc_move_cuts WHERE cut_id = ?1",
                [cut],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state != "installed" {
                return Err(MoveError::refusal("cut_conflict"));
            }
            require_owner(tx, cut, &session, "staged")?;
            tx.execute("DELETE FROM mc_move_fences WHERE cut_id = ?1", [cut])?;
            tx.execute(
                "UPDATE mc_move_cuts SET state = 'activated' WHERE cut_id = ?1",
                [cut],
            )?;
            Ok(())
        })
    }
}

fn source_session(tx: &Connection, cut: &str) -> Result<String, MoveError> {
    tx.query_row("SELECT f.session_id FROM mc_move_fences f JOIN mc_move_cuts c USING(cut_id) WHERE f.cut_id = ?1 AND f.phase IN ('draining','frozen') AND c.state IN ('exporting','sealed')",[cut],|r|r.get(0)).optional()?.ok_or_else(|| MoveError::refusal("cut_conflict"))
}
fn require_owner(
    conn: &Connection,
    cut: &str,
    session: &str,
    phase: &str,
) -> Result<(), MoveError> {
    let owns: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_move_fences f JOIN mc_move_installs i USING(cut_id) WHERE f.cut_id = ?1 AND f.session_id = ?2 AND f.phase = ?3 AND i.session_id = f.session_id)",params![cut,session,phase],|r|r.get(0))?;
    if owns {
        Ok(())
    } else {
        Err(MoveError::refusal("cut_conflict"))
    }
}
fn check_destination(conn: &Connection, session: &str) -> Result<(), MoveError> {
    for table in move_inventory::tables(Store::Module).filter(|t| {
        matches!(t.class, Class::Ship | Class::Rebuild)
            || t.table == "mc_single_store_pending_publish"
    }) {
        let RowSelector::Predicate(predicate) = table.rows else {
            continue;
        };
        if conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {} WHERE ({predicate}))",
                codec::quoted(table.table)
            ),
            [session],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(MoveError::table("destination_populated", table.table));
        }
    }
    Ok(())
}
fn validate_row_owner(
    table: &move_inventory::TableInventory,
    row: &[Value],
    session: &str,
) -> Result<(), MoveError> {
    if table.table == "mc_cache_sections" {
        if let Some(owned) = crate::async_compaction_layout::special_owner(row, session) {
            return if owned {
                Ok(())
            } else {
                Err(MoveError::refusal("identity_mismatch"))
            };
        }
    }
    let owner = table
        .session_column()
        .ok_or_else(|| MoveError::refusal("inventory_mismatch"))?;
    let columns = table.shipped_columns();
    let index = columns
        .iter()
        .position(|c| *c == owner)
        .ok_or_else(|| MoveError::refusal("inventory_mismatch"))?;
    if row[index] != Value::Text(session.into()) {
        return Err(MoveError::refusal("identity_mismatch"));
    }
    Ok(())
}
fn preflight(conn: &Connection, session: &str, path: &Path) -> Result<(), MoveError> {
    preflight_for(conn, Store::Module, session, path, false)
}

/// Provider row selectors refer to conversation identities in the same snapshot.
/// Validate every conversation owner before exposing those identities to selectors;
/// an empty or populated destination must never supply missing source references.
fn staged_conversation_catalogue(
    store: Store,
    session: &str,
    path: &Path,
) -> Result<Connection, MoveError> {
    let catalogue = Connection::open_in_memory()?;
    let mut input = BufReader::new(File::open(path)?);
    for table in codec::ship_tables(store) {
        let count = codec::read_section(&mut input, table)?;
        let conversation = table.table == "mc_provider_conversations_v2";
        let async_sections = store == Store::Module && table.table == "mc_cache_sections";
        let columns = table.shipped_columns();
        if conversation || async_sections {
            catalogue.execute_batch(&format!(
                "CREATE TABLE {} ({})",
                codec::quoted(table.table),
                columns
                    .iter()
                    .map(|c| codec::quoted(c))
                    .collect::<Vec<_>>()
                    .join(",")
            ))?;
        }
        for _ in 0..count {
            let row = codec::read_row(&mut input, table)?;
            let async_header = async_sections
                && row.first()
                    == Some(&Value::Text(crate::async_compaction_layout::HEADERS.into()));
            if conversation || async_header {
                validate_row_owner(table, &row, session)?;
                catalogue.execute(
                    &format!(
                        "INSERT INTO {} VALUES ({})",
                        codec::quoted(table.table),
                        vec!["?"; columns.len()].join(",")
                    ),
                    rusqlite::params_from_iter(row),
                )?;
            }
        }
    }
    Ok(catalogue)
}

pub(crate) fn preflight_for(
    conn: &Connection,
    store: Store,
    session: &str,
    path: &Path,
    replacing: bool,
) -> Result<(), MoveError> {
    let catalogue = staged_conversation_catalogue(store, session, path)?;
    let mut input = BufReader::new(File::open(path)?);
    for table in codec::ship_tables(store) {
        let count = codec::read_section(&mut input, table)?;
        // A temporary, throwaway DB checks source PK uniqueness without holding
        // the destination handle or retaining all keys in a process-sized set.
        let keys = Connection::open_in_memory()?;
        keys.execute_batch("CREATE TABLE keys (key BLOB PRIMARY KEY)")?;
        for _ in 0..count {
            let row = codec::read_row(&mut input, table)?;
            validate_row_owner(table, &row, session)?;
            let RowSelector::Predicate(selector) = table.rows else {
                return Err(MoveError::refusal("inventory_mismatch"));
            };
            let columns = table.shipped_columns();
            let projection = columns
                .iter()
                .enumerate()
                .map(|(i, c)| format!("?{} AS {}", i + 2, codec::quoted(c)))
                .collect::<Vec<_>>()
                .join(",");
            let values = std::iter::once(Value::Text(session.into())).chain(row.iter().cloned());
            if !catalogue.query_row(
                &format!("SELECT ({selector}) FROM (SELECT {projection})"),
                rusqlite::params_from_iter(values),
                |r| r.get::<_, bool>(0),
            )? {
                return Err(if selector.contains("SELECT ") {
                    MoveError::table("snapshot_reference_missing", table.table)
                } else {
                    MoveError::refusal("identity_mismatch")
                });
            }
            let key = codec::source_key(table, &row)?;
            if keys.execute("INSERT INTO keys VALUES(?1)", [key]).is_err() {
                return Err(MoveError::table("key_collision", table.table));
            }
            if replacing {
                refuse_foreign_key_collision(conn, table, &row, session)?;
            } else {
                refuse_inventory_key_collision(conn, table, &row)?;
            }
        }
    }
    let mut tail = [0];
    if input.read(&mut tail)? != 0 {
        return Err(MoveError::refusal("manifest_mismatch"));
    }
    Ok(())
}

fn refuse_foreign_key_collision(
    conn: &Connection,
    table: &move_inventory::TableInventory,
    row: &[Value],
    session: &str,
) -> Result<(), MoveError> {
    let columns = table.shipped_columns();
    let RowSelector::Predicate(selector) = table.rows else {
        return Err(MoveError::refusal("inventory_mismatch"));
    };
    let predicate = table
        .primary_key
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{} IS ?{}", codec::quoted(c), i + 2))
        .collect::<Vec<_>>()
        .join(" AND ");
    let values = std::iter::once(Value::Text(session.into())).chain(
        table
            .primary_key
            .iter()
            .map(|c| row[columns.iter().position(|col| col == c).unwrap()].clone()),
    );
    let collision: bool = conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE {predicate} AND NOT ({selector}))",
            codec::quoted(table.table)
        ),
        rusqlite::params_from_iter(values),
        |r| r.get(0),
    )?;
    if collision {
        Err(MoveError::table("key_collision", table.table))
    } else {
        Ok(())
    }
}

/// Check the inventory-declared primary key against a destination table without
/// reserving or installing rows. Production preflight uses this only for store.db
/// (Module) tables. A context.db (Context) query test does not implement that importer.
fn refuse_inventory_key_collision(
    conn: &Connection,
    table: &move_inventory::TableInventory,
    row: &[Value],
) -> Result<(), MoveError> {
    if table.key_policy != Some(KeyPolicy::PreserveOrRefuseCollision) {
        return Ok(());
    }
    let columns = table.shipped_columns();
    let key_values = table
        .primary_key
        .iter()
        .map(|name| &row[columns.iter().position(|column| column == name).unwrap()]);
    let predicate = table
        .primary_key
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{} = ?{}", codec::quoted(column), index + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let collision = conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE {predicate})",
            codec::quoted(table.table)
        ),
        rusqlite::params_from_iter(key_values),
        |row| row.get::<_, bool>(0),
    )?;
    if collision {
        return Err(MoveError::table("key_collision", table.table));
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Cursor {
    table: usize,
    offset: u64,
    remaining: i64,
    key: Option<Vec<u8>>,
    complete: bool,
}
impl Cursor {
    fn progress(&self, rows_written: usize) -> InstallProgress {
        InstallProgress {
            complete: self.complete,
            table_index: self.table,
            last_source_key: self.key.clone(),
            rows_written,
        }
    }
}
fn read_cursor(conn: &Connection, cut: &str) -> Result<Cursor, MoveError> {
    conn.query_row("SELECT table_index,file_offset,rows_remaining,last_source_key,complete FROM mc_move_installs WHERE cut_id = ?1",[cut],|r|Ok(Cursor{table:r.get(0)?,offset:r.get(1)?,remaining:r.get(2)?,key:r.get(3)?,complete:r.get(4)?})).optional()?.ok_or_else(||MoveError::refusal("cut_conflict"))
}
fn save_cursor(tx: &Transaction<'_>, cut: &str, cursor: &Cursor) -> Result<(), MoveError> {
    tx.execute("UPDATE mc_move_installs SET table_index = ?2,file_offset = ?3,rows_remaining = ?4,last_source_key = ?5,complete = ?6 WHERE cut_id = ?1",params![cut,cursor.table,cursor.offset,cursor.remaining,cursor.key,cursor.complete])?;
    Ok(())
}
fn finish_tags(tx: &Transaction<'_>, cut: &str, session: &str) -> Result<(), MoveError> {
    tx.execute("INSERT INTO mc_tag_cache_generations(session_id,generation,tag_count,max_tag_number) SELECT ?2,MAX(i.shipped_generation,i.prior_generation,COALESCE(g.generation,0))+1,i.tag_count,i.max_tag_number FROM mc_move_installs i LEFT JOIN mc_tag_cache_generations g ON g.session_id = ?2 WHERE i.cut_id = ?1 ON CONFLICT(session_id) DO UPDATE SET generation = excluded.generation,tag_count = excluded.tag_count,max_tag_number = excluded.max_tag_number",params![cut,session])?;
    tx.execute("INSERT INTO mc_move_tag_epochs SELECT session_id,generation FROM mc_tag_cache_generations WHERE session_id = ?1 ON CONFLICT(session_id) DO UPDATE SET generation = MAX(generation,excluded.generation)",[session])?;
    Ok(())
}
fn discard_tables() -> Vec<&'static move_inventory::TableInventory> {
    let mut tables = move_inventory::tables(Store::Module)
        .filter(|t| t.class != Class::NotSession && matches!(t.rows, RowSelector::Predicate(_)))
        .collect::<Vec<_>>();
    // Remove revision rows after conversations and policy rows: their delete
    // triggers recreate a missing revision row, leaving an orphan if it was
    // removed first. Import uses the opposite order to avoid insert collisions.
    tables.sort_by_key(|t| match t.table {
        "mc_provider_policy_revisions_v1" => 1,
        "mc_tag_cache_generations" => 2,
        _ => 0,
    });
    tables
}
fn remove_file(path: Option<&str>) -> Result<(), MoveError> {
    if let Some(path) = path {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
