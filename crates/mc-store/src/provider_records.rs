//! Provider records on the store's fenced connection. The older observation lane
//! uses a normalized compatibility codec; host hooks use the incremental API.
use crate::provider_legacy;
pub use crate::provider_log::*;
use rusqlite::functions::FunctionFlags;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) fn register_migration_functions(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "mc_provider_engine_namespace",
        3,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            #[derive(Serialize)]
            struct Key {
                project: String,
                session: String,
                harness: String,
            }
            let key = Key {
                project: ctx.get(0)?,
                session: ctx.get(1)?,
                harness: ctx.get(2)?,
            };
            let bytes = serde_json::to_vec(&key)
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            Ok(format!("mc-provider:{:x}", Sha256::digest(bytes)))
        },
    )
}

use crate::{McStore, McStoreError, McTagRow};
use rusqlite::{params, OptionalExtension};

/// The route-bound project and the runner's session/caller-harness coordinates.
#[derive(Clone, Debug)]
pub struct ProviderSessionKey {
    pub project_root: String,
    pub session: String,
    pub harness: String,
}

impl McStore {
    pub fn load_provider_record(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Option<String>, McStoreError> {
        Ok(self
            .inner
            .with_conn(|conn| provider_legacy::load_tx(conn, key))?)
    }

    /// Commit the answer/high-water record and newly live tags as one fenced write.
    /// Allocated but unobserved tags belong only in the opaque record, not mc_tags.
    pub fn save_provider_record(
        &self,
        key: &ProviderSessionKey,
        record_json: &str,
        engine_session: &str,
        tags: &[McTagRow],
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            provider_legacy::save_tx(tx, key, record_json, engine_session, tags)
        })?;
        Ok(())
    }

    pub fn provider_records_for_session(
        &self,
        project_root: &str,
        session: &str,
    ) -> Result<Vec<(String, String)>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut query = conn.prepare("SELECT harness FROM mc_provider_conversations_v2 WHERE project_root=?1 AND session=?2")?;
            let harnesses = query.query_map(params![project_root,session], |r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            harnesses.into_iter().map(|harness| {
                let key=ProviderSessionKey {project_root:project_root.into(),session:session.into(),harness:harness.clone()};
                Ok((harness,provider_legacy::load_tx(conn,&key)?.unwrap()))
            }).collect()
        })?)
    }

    pub fn load_provider_catalog(
        &self,
        project_root: &str,
        session: &str,
    ) -> Result<Option<String>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT catalog FROM mc_provider_catalogs_v1 WHERE project_root=?1 AND session=?2",
                params![project_root, session],
                |row| row.get(0),
            )
            .optional()
        })?)
    }

    /// Catalog admission and its copy into an already resolved conversation are
    /// one transaction. An ambiguous tool handle must not pick a caller harness.
    pub fn save_provider_catalog(
        &self,
        project_root: &str,
        session: &str,
        catalog_json: &str,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "INSERT INTO mc_provider_catalogs_v1 (project_root,session,catalog) VALUES (?1,?2,?3)
                 ON CONFLICT(project_root,session) DO UPDATE SET catalog=excluded.catalog",
                params![project_root, session, catalog_json],
            )?;
            tx.execute(
                "UPDATE mc_provider_conversations_v2 SET record_json=json_set(record_json,'$.catalog',json(?3))
                 WHERE project_root=?1 AND session=?2
                   AND (SELECT COUNT(*) FROM mc_provider_conversations_v2
                        WHERE project_root=?1 AND session=?2)=1",
                params![project_root, session, catalog_json],
            )?;
            Ok(())
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open_sqlite, register_legacy_trigger_functions, MIGRATIONS, NS};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: NS.into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }

    fn key(project: &str, session: &str, harness: &str) -> ProviderSessionKey {
        ProviderSessionKey {
            project_root: project.into(),
            session: session.into(),
            harness: harness.into(),
        }
    }

    fn tag(number: i64, block: &str) -> McTagRow {
        McTagRow {
            tag_number: number,
            block_id: block.into(),
            kind: "tool_result".into(),
            token_count: 4,
            created_at_ms: 10,
            source_bytes: b"payload".as_slice().into(),
        }
    }

    #[test]
    fn provider_migration_upgrades_a_populated_previous_store_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = descriptor(dir.path());
        let previous = &MIGRATIONS[..MIGRATIONS.len() - 2];
        let inner = open_sqlite(&descriptor).unwrap();
        inner.with_conn(register_legacy_trigger_functions).unwrap();
        inner.migrate(NS, previous).unwrap();
        inner.with_conn(|conn| {
            assert_eq!(crate::single_store_schema::recorded_store_version(conn)?,previous.last().unwrap().version);
            assert!(!crate::single_store_schema::table_exists(conn,"main","mc_provider_sessions_v1")?);
            assert!(!crate::single_store_schema::table_exists(conn,"main","mc_provider_catalogs_v1")?);
            conn.execute("INSERT INTO mc_cache_state (session_id,row_version,core_state,meta) VALUES ('existing',7,'{}','{}')",[])?;
            conn.execute("INSERT INTO mc_tags (session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes)
                VALUES ('existing',11,'m0#0','tool_result',4,10,X'7061796c6f6164')",[])?;
            conn.execute("INSERT INTO pending_agent_drops (session_id,target_id,queued_at) VALUES ('existing','m0#0',10)",[])?;
            Ok(())
        }).unwrap();
        drop(inner);

        let store = McStore::open_for_test(&descriptor).unwrap();
        assert_eq!(
            store.module_store_schema_version().unwrap(),
            crate::LATEST_MIGRATION_VERSION
        );
        store
            .inner
            .with_conn(|conn| {
                assert_eq!(
                    conn.query_row(
                        "SELECT row_version FROM mc_cache_state WHERE session_id='existing'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )?,
                    7
                );
                assert_eq!(
                    conn.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))?,
                    1
                );
                assert_eq!(
                    conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))?,
                    "wal"
                );
                crate::move_inventory::validate_schema(conn, crate::move_inventory::Store::Module)
                    .unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.load_tags_for_session("existing").unwrap()[0],
            tag(11, "m0#0")
        );
        assert_eq!(
            store.load_pending_agent_drops("existing").unwrap()[0].target_id,
            "m0#0"
        );
        let key = key("/project", "session", "broca");
        let record = r#"{"setup":{"compaction_id":"comp","allocated_version":17},"hook":{"high_water":23},"pending_drops":[23],"last_answer":{"request_id":"r"}}"#;
        let catalog = r#"{"compacting":true,"tools":["ctx_reduce"]}"#;
        store
            .save_provider_record(&key, record, "engine", &[tag(23, "m2#0")])
            .unwrap();
        store
            .save_provider_catalog(&key.project_root, &key.session, catalog)
            .unwrap();
        let stored = store.load_provider_record(&key).unwrap().unwrap();
        drop(store);

        let reopened = McStore::open_for_test(&descriptor).unwrap();
        assert_eq!(
            reopened.load_provider_record(&key).unwrap().as_deref(),
            Some(stored.as_str())
        );
        assert_eq!(
            reopened
                .load_provider_catalog(&key.project_root, &key.session)
                .unwrap()
                .as_deref(),
            Some(catalog)
        );
        assert_eq!(
            reopened.load_tags_for_session("engine").unwrap()[0],
            tag(23, "m2#0")
        );
        assert!(reopened
            .load_provider_record(&self::key("/other-project", "session", "broca"))
            .unwrap()
            .is_none());
        assert!(reopened
            .load_provider_record(&self::key("/project", "session", "claude-code"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn fresh_provider_schema_has_the_exact_classified_columns_and_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        store
            .inner
            .with_conn(|conn| {
                for (table, expected) in [
                    (
                        "mc_provider_sessions_v1",
                        vec![
                            ("project_root", 1),
                            ("session", 2),
                            ("harness", 3),
                            ("record", 0),
                        ],
                    ),
                    (
                        "mc_provider_catalogs_v1",
                        vec![("project_root", 1), ("session", 2), ("catalog", 0)],
                    ),
                ] {
                    let actual = conn
                        .prepare(&format!("PRAGMA table_xinfo({table})"))?
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    assert_eq!(
                        actual,
                        expected
                            .into_iter()
                            .map(|(column, key)| (column.to_string(), key))
                            .collect::<Vec<_>>()
                    );
                }
                crate::move_inventory::validate_schema(conn, crate::move_inventory::Store::Module)
                    .unwrap();
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn provider_answer_and_observed_tags_roll_back_together() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        let key = key("/project", "session", "broca");
        store.inner.with_conn(|conn|conn.execute_batch("CREATE TEMP TRIGGER abort_provider_tag BEFORE INSERT ON mc_tags
            WHEN NEW.session_id='engine' BEGIN SELECT RAISE(ABORT,'provider tag write failed'); END;")).unwrap();
        assert!(store
            .save_provider_record(
                &key,
                r#"{"allocated_version":17,"tag_high_water":23}"#,
                "engine",
                &[tag(23, "m2#0")]
            )
            .is_err());
        assert!(store.load_provider_record(&key).unwrap().is_none());
        assert!(store.load_tags_for_session("engine").unwrap().is_empty());
        store
            .inner
            .with_conn(|conn| conn.execute_batch("DROP TRIGGER abort_provider_tag;"))
            .unwrap();
        store
            .save_provider_record(
                &key,
                r#"{"allocated_version":17,"tag_high_water":23}"#,
                "engine",
                &[tag(23, "m2#0")],
            )
            .unwrap();
        assert!(store.load_provider_record(&key).unwrap().is_some());
        assert_eq!(store.load_tags_for_session("engine").unwrap().len(), 1);
    }

    #[test]
    fn catalog_admission_and_its_session_copy_roll_back_together() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        let key = key("/project", "session", "broca");
        let before = r#"{"catalog":null,"allocated_version":17}"#;
        store
            .save_provider_record(&key, before, "engine", &[])
            .unwrap();
        assert!(store
            .save_provider_catalog("/project", "session", "not JSON")
            .is_err());
        assert!(store
            .load_provider_catalog("/project", "session")
            .unwrap()
            .is_none());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &store.load_provider_record(&key).unwrap().unwrap()
            )
            .unwrap(),
            serde_json::from_str::<serde_json::Value>(before).unwrap()
        );
    }
}
