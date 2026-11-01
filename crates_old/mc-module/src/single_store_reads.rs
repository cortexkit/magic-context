//! The module's connections to `context.db`, installed on its `McStore`.
//!
//! After the single-store migration every memory, note, compartment and history row lives
//! in `context.db`. [`ModuleContextDomain`] gives the store what it needs to reach them:
//! one reader connection, whose reads run in a read transaction so revision heads agree
//! with the rows they describe, and the fenced [`HostStore`] writer. Each write runs in one
//! `BEGIN IMMEDIATE`, after checking that every table it writes still has the schema this
//! build was made against, with the host's guard triggers switched off for that
//! transaction only.
//!
//! [`attach`] also decides whether the pair of files may be served at all: `store.db`
//! carries the single-store marker (it is at migration 61) and `context.db` must record
//! the same migration with the same stamp in `single_store_state`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mc_store::single_store_domain::{context_error, context_sql_error};
use mc_store::single_store_schema::FRESH_INSTALL_MARKER_SUFFIX;
use mc_store::{ContextDomain, McStore, McStoreError};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::host_store::{HostStore, HostStoreError, CONTEXT_BUSY_TIMEOUT_MS};

fn host_error(error: HostStoreError) -> McStoreError {
    context_error(error.code(), error)
}

/// The module's reader and writer on `context.db`.
pub struct ModuleContextDomain {
    path: PathBuf,
    reader: Mutex<Connection>,
    writer: Mutex<HostStore>,
}

impl ModuleContextDomain {
    /// Open an existing `context.db`. A missing file is refused rather than created: an
    /// empty file would not be the host's database.
    pub fn open(path: &Path) -> Result<Self, McStoreError> {
        Self::open_with_private_permissions(path, true)
    }

    pub fn open_with_private_permissions(
        path: &Path,
        enforce_private_permissions: bool,
    ) -> Result<Self, McStoreError> {
        if !path.exists() {
            return Err(context_error(
                "context_db_missing",
                format!(
                    "no context.db at {}; run `npx @cortexkit/magic-context doctor store init` to provision it",
                    path.display()
                ),
            ));
        }
        let writer = HostStore::open_with_private_permissions(path, enforce_private_permissions)
            .map_err(host_error)?;
        let reader = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(context_sql_error)?;
        mc_store::single_store_domain::set_wal_synchronous_normal(&reader)
            .map_err(context_sql_error)?;
        reader
            .pragma_update(None, "query_only", "ON")
            .map_err(context_sql_error)?;
        reader
            .busy_timeout(std::time::Duration::from_millis(u64::from(
                CONTEXT_BUSY_TIMEOUT_MS,
            )))
            .map_err(context_sql_error)?;
        Ok(Self {
            path: path.to_path_buf(),
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl ContextDomain for ModuleContextDomain {
    fn try_write(
        &self,
        tables: &[&str],
        write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        self.writer
            .try_lock()
            .map_err(|_| context_error("context_busy", "telemetry writer is occupied"))?
            .try_domain_transaction(tables, write)
            .map_err(host_error)
    }

    fn read(
        &self,
        read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        let mut conn = self
            .reader
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(context_sql_error)?;
        read(&transaction).map_err(context_sql_error)?;
        transaction.commit().map_err(context_sql_error)
    }

    fn write(
        &self,
        tables: &[&str],
        write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        self.writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .with_domain_transaction(tables, write)
            .map_err(host_error)
    }

    fn status(&self) -> Value {
        let writer = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut block = writer.health_value();
        if let Some(object) = block.as_object_mut() {
            object.insert(
                "busy_refusals".to_string(),
                json!(crate::host_store::busy_refusal_count()),
            );
        }
        block
    }
}

/// Where the module finds `context.db` for a store opened from `store_path`.
///
/// Production uses the host's own resolution order, so the two processes agree on one
/// file. Unit tests keep it beside their temporary `store.db`, created from the schema
/// snapshot, so no test can reach a real database.
pub fn context_db_path_for(store_path: Option<&Path>) -> PathBuf {
    #[cfg(test)]
    if let Some(store_path) = store_path {
        let path = store_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("context.db");
        mc_store::single_store_domain::create_test_context_db(&path)
            .expect("create the test context.db");
        return path;
    }
    let _ = store_path;
    crate::host_store::resolve_context_db_path()
}

/// `single_store_state` as `context.db` records it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ContextFlag {
    state: String,
    migrated_at: Option<i64>,
}

fn read_context_flag(conn: &Connection) -> rusqlite::Result<Option<ContextFlag>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'single_store_state')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    conn.query_row(
        "SELECT state, migrated_at FROM single_store_state WHERE id = 1",
        [],
        |row| {
            Ok(ContextFlag {
                state: row.get(0)?,
                migrated_at: row.get(1)?,
            })
        },
    )
    .optional()
}

/// Open `context.db` at `context_path`, check that it and `store`'s marker record the same
/// single-store migration, and install it as the store's domain.
///
/// - A store that `McStore::open` just took to migration 61 (a fresh install, marked with
///   the fresh-install build suffix) writes `single_store_state = migrated` with the same
///   stamp, in one `BEGIN IMMEDIATE`, if `context.db` does not record a migration yet.
///   If `context.db` already records one (the cache file was deleted and rebuilt), a fresh
///   store that has served no session yet adopts that stamp: it holds no rows of its own
///   to disagree with.
/// - `context.db` recording no migration (`required`, or no table) while the store is a
///   migrated one is `single_store_migration_required`.
/// - Both recording the migration with different stamps is `single_store_state_split`.
///
/// Any pending `context.db` write a previous process left behind lands before this returns.
pub fn attach(
    store: &McStore,
    context_path: &Path,
) -> Result<Arc<ModuleContextDomain>, McStoreError> {
    attach_with_private_permissions(store, context_path, true)
}

pub fn attach_with_private_permissions(
    store: &McStore,
    context_path: &Path,
    enforce_private_permissions: bool,
) -> Result<Arc<ModuleContextDomain>, McStoreError> {
    let marker =
        store
            .single_store_marker()?
            .ok_or_else(|| McStoreError::SingleStoreStateSplit {
                detail: "store.db is at migration 61 without its single-store marker".to_string(),
            })?;
    let domain = Arc::new(ModuleContextDomain::open_with_private_permissions(
        context_path,
        enforce_private_permissions,
    )?);
    let mut flag = None;
    domain.read(&mut |conn| {
        flag = read_context_flag(conn)?;
        Ok(())
    })?;
    let fresh = marker.set_by.ends_with(FRESH_INSTALL_MARKER_SUFFIX);
    let stamp = marker.set_at_ms.unwrap_or_default();
    match flag.as_ref() {
        Some(flag) if flag.state == "migrated" => {
            if flag.migrated_at != Some(stamp) {
                // Only a store that has served nothing yet may take context.db's stamp: it
                // is a rebuilt cache for an already-migrated file. A store with sessions of
                // its own and a different stamp belongs to another migration.
                if fresh && store.is_cache_empty()? {
                    store.adopt_single_store_stamp(flag.migrated_at.unwrap_or_default())?;
                } else {
                    return Err(McStoreError::SingleStoreStateSplit {
                        detail: format!(
                            "store.db was migrated at {stamp} but context.db records {:?}",
                            flag.migrated_at
                        ),
                    });
                }
            }
        }
        _ if fresh => {
            if flag.is_none() {
                return Err(McStoreError::SingleStoreMigrationRequired {
                    db_version: mc_store::single_store_schema::SINGLE_STORE_MIGRATION_VERSION,
                    populated_table: "context.db has no single_store_state table (the plugin that creates it has not started yet)".to_string(),
                });
            }
            let conn = Connection::open_with_flags(context_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(context_sql_error)?;
            mc_store::single_store_domain::set_wal_synchronous_normal(&conn)
                .map_err(context_sql_error)?;
            conn.busy_timeout(std::time::Duration::from_millis(u64::from(
                CONTEXT_BUSY_TIMEOUT_MS,
            )))
            .map_err(context_sql_error)?;
            crate::single_store_migrate::write_fresh_context_flag(&conn, stamp, &marker.set_by)
                .map_err(context_sql_error)?;
        }
        _ => {
            return Err(McStoreError::SingleStoreMigrationRequired {
                db_version: mc_store::single_store_schema::SINGLE_STORE_MIGRATION_VERSION,
                populated_table: format!(
                    "context.db single_store_state is {}",
                    flag.as_ref().map_or("absent", |flag| flag.state.as_str())
                ),
            });
        }
    }
    store.install_context_domain(Arc::clone(&domain) as Arc<dyn ContextDomain>);
    let resumed = store.resume_all_pending_context_writes()?;
    if resumed > 0 {
        tracing::info!(
            "mc-module: finished {resumed} pending context.db write(s) left by an earlier process"
        );
    }
    Ok(domain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use mc_store::single_store_domain::CONTEXT_SCHEMA_SNAPSHOT;
    use mc_store::single_store_schema::{
        SINGLE_STORE_MIGRATION_REQUIRED_REASON, SINGLE_STORE_STATE_SPLIT_REASON,
    };

    fn descriptor(dir: &Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context".to_string(),
            storage_namespace: "magic-context".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }

    #[cfg(unix)]
    #[test]
    fn rust_store_directory_stays_private_when_the_plugin_permission_setting_is_disabled() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join("magic-context").join(format!(
            "rust-store-private-policy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();

        let store = McStore::open_with_private_permissions(&descriptor(&root), false).unwrap();
        drop(store);

        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A `context.db` from the schema snapshot, with `single_store_state` as given.
    fn context_db(dir: &Path, state: Option<(&str, Option<i64>)>) -> PathBuf {
        let path = dir.join("context.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(CONTEXT_SCHEMA_SNAPSHOT).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0)",
            [],
        )
        .unwrap();
        if let Some((state, migrated_at)) = state {
            conn.execute(
                "INSERT INTO single_store_state(id, state, migrated_at, migrated_by, report_json)
                 VALUES (1, ?1, ?2, 'test', '{}')",
                rusqlite::params![state, migrated_at],
            )
            .unwrap();
        }
        path
    }

    fn context_flag(path: &Path) -> (String, Option<i64>) {
        Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT state, migrated_at FROM single_store_state WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn missing_context_db_refuses_with_provisioning_command_without_creating_it() {
        let parent = std::env::temp_dir().join("magic-context/store-init");
        std::fs::create_dir_all(&parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let path = dir.path().join("context.db");
        let error = ModuleContextDomain::open(&path)
            .err()
            .expect("missing store refused");
        assert!(error.to_string().contains("context_db_missing"));
        assert!(error
            .to_string()
            .contains("npx @cortexkit/magic-context doctor store init"));
        assert!(!path.exists());
    }

    #[test]
    fn freshly_opened_module_context_reader_uses_wal_normal() {
        let dir = tempfile::tempdir().unwrap();
        let path = context_db(dir.path(), Some(("migrated", Some(0))));
        let domain = ModuleContextDomain::open(&path).unwrap();
        let reader = domain.reader.lock().unwrap();
        let journal: String = reader
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        let synchronous: i64 = reader
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        assert_eq!(synchronous, 1);
    }

    #[test]
    fn a_fresh_store_flips_a_required_context_db_to_migrated_with_its_own_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let context = context_db(dir.path(), Some(("required", None)));
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let marker = store.single_store_marker().unwrap().unwrap();
        attach(&store, &context).unwrap();
        assert_eq!(
            context_flag(&context),
            ("migrated".to_string(), marker.set_at_ms),
            "the two files carry equal stamps"
        );
        assert!(store.has_context_domain());
    }

    #[test]
    fn stamps_that_differ_are_refused_as_a_split() {
        let dir = tempfile::tempdir().unwrap();
        let context = context_db(dir.path(), Some(("migrated", Some(1))));
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        // A store that has served a session is not a rebuilt cache, so it may not adopt the
        // other file's stamp.
        store
            .commit(
                "served",
                None,
                &mc_core::CoreState::default(),
                &mc_store::ModuleMeta::default(),
            )
            .unwrap();
        let error = attach(&store, &context).err().expect("a split is refused");
        assert!(
            matches!(error, McStoreError::SingleStoreStateSplit { .. }),
            "{error:?}"
        );
        assert!(error
            .to_string()
            .starts_with(SINGLE_STORE_STATE_SPLIT_REASON));
        assert!(!store.has_context_domain());
        assert_eq!(context_flag(&context), ("migrated".to_string(), Some(1)));
    }

    #[test]
    fn a_rebuilt_empty_store_adopts_the_stamp_of_an_already_migrated_context_db() {
        let dir = tempfile::tempdir().unwrap();
        let context = context_db(dir.path(), Some(("migrated", Some(7))));
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        attach(&store, &context).unwrap();
        assert_eq!(
            store.single_store_marker().unwrap().unwrap().set_at_ms,
            Some(7)
        );
    }

    #[test]
    fn a_migrated_store_against_a_required_context_db_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let context = context_db(dir.path(), Some(("required", None)));
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        // Not a fresh install: the marker was written by the migration itself.
        store.adopt_single_store_stamp(5).unwrap();
        store
            .set_single_store_marker_build_for_test("ck-mc 0.44.0")
            .unwrap();
        let error = attach(&store, &context).err().expect("refused");
        assert!(
            error
                .to_string()
                .starts_with(SINGLE_STORE_MIGRATION_REQUIRED_REASON),
            "{error}"
        );
        assert_eq!(context_flag(&context), ("required".to_string(), None));
    }
}
