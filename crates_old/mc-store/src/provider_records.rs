//! Provider records on the store's fenced connection. The older observation lane
//! uses a normalized compatibility codec; host hooks use the incremental API.
#[cfg(test)]
use crate::provider_legacy;
pub use crate::provider_log::*;
use rusqlite::functions::FunctionFlags;
use serde::{Deserialize, Serialize};
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

#[cfg(test)]
use crate::McTagRow;
use crate::{McStore, McStoreError};
use rusqlite::{params, OptionalExtension};

// The connection-local revision catches our own writes; data_version catches
// other connections. Triggers cover every metadata writer without copying the
// compatibility JSON (which contains the last, potentially large, served view).
#[derive(Clone, Debug)]
pub struct ProviderSessionKey {
    pub project_root: String,
    pub session: String,
    pub harness: String,
    pub generation: Option<ProviderGeneration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderGeneration {
    pub profile: String,
    pub provider: String,
}

impl McStore {
    /// Resolve tools to one stored conversation without hydrating legacy hook records.
    pub fn provider_session_keys(
        &self,
        project_root: &str,
        session: &str,
    ) -> Result<Vec<ProviderSessionKey>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT harness FROM mc_provider_conversations_v2
                 WHERE project_root = ?1 AND session = ?2 AND profile_generation = '' AND provider_generation = ''",
            )?;
            let rows = statement.query_map(params![project_root, session], |row| {
                Ok(ProviderSessionKey {
                    project_root: project_root.into(),
                    session: session.into(),
                    harness: row.get(0)?,
                    generation: None,
                })
            })?.collect();
            rows
        }).map_err(McStoreError::from)
    }

    /// Remove one provider conversation atomically. The caller holds its provider
    /// serial lock; project memories and the normal session/engine data are not owned here.
    pub fn delete_provider_conversation(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            let conv = key.conversation_key();
            let namespace: Option<String> = tx.query_row(
                "SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1",
                [&conv], |row| row.get(0),
            ).optional()?;
            let revision: Option<i64> = match &namespace {
                Some(namespace) => tx.query_row("SELECT revision FROM mc_provider_policy_revisions_v1 WHERE engine_namespace=?1", [namespace], |row| row.get(0)).optional()?,
                None => None,
            };
            // Remove the head first: child-delete triggers must not invalidate a
            // different conversation's policy cache in a shared engine namespace.
            tx.execute("DELETE FROM mc_provider_conversations_v2 WHERE conv_key=?1", [&conv])?;
            for table in [
                "mc_provider_view_overrides_v1",
                "mc_provider_views_v2",
                "mc_provider_policy_overrides_v1",
                "mc_provider_policy_cuts_v1",
                "mc_provider_policy_preparations_v1",
                "mc_provider_policy_summaries_v1",
                "mc_provider_policy_changes_v1",
                "mc_provider_policy_parts_v1",
                "mc_provider_hook_answers_v1",
                "mc_provider_legacy_tags_v1",
                "mc_provider_pending_drops_v1",
                "mc_provider_messages_v1",
                "mc_provider_lineages_v1",
            ] {
                tx.execute(&format!("DELETE FROM {table} WHERE conv_key=?1"), [&conv])?;
            }
            tx.execute(
                "DELETE FROM mc_provider_sessions_v1 WHERE project_root=?1 AND session=?2 AND harness=?3",
                params![key.project_root, key.session, key.harness],
            )?;
            // Catalogs predate harness selection. Keep one while any sibling
            // conversation in that project/session can still depend on it.
            tx.execute(
                "DELETE FROM mc_provider_catalogs_v1 WHERE project_root=?1 AND session=?2
                 AND NOT EXISTS (SELECT 1 FROM mc_provider_conversations_v2 WHERE project_root=?1 AND session=?2)",
                params![key.project_root, key.session],
            )?;
            if let Some(namespace) = namespace {
                // The head's BEFORE DELETE trigger bumps the namespace revision.
                // Surviving conversations lost no policy inputs: preserve their
                // cache token within this transaction, before any reader can see it.
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_conversations_v2 WHERE engine_namespace=?1)", [&namespace], |row| row.get::<_, bool>(0))? {
                    if let Some(revision) = revision {
                        tx.execute("UPDATE mc_provider_policy_revisions_v1 SET revision=?2 WHERE engine_namespace=?1", params![namespace, revision])?;
                    } else {
                        tx.execute("DELETE FROM mc_provider_policy_revisions_v1 WHERE engine_namespace=?1", [&namespace])?;
                    }
                }
                for table in ["mc_provider_consumed_tags_v1", "mc_provider_policy_revisions_v1"] {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE engine_namespace=?1 AND NOT EXISTS
                            (SELECT 1 FROM mc_provider_conversations_v2 WHERE engine_namespace=?1)"),
                        [&namespace],
                    )?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Read historical runner fixtures while verifying schema upgrades.
    #[cfg(test)]
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
    /// The record names its views by version; `views` holds recipes for
    /// referenced versions not yet stored, committed in the same transaction.
    #[cfg(test)]
    pub fn save_provider_record(
        &self,
        key: &ProviderSessionKey,
        record_json: &str,
        engine_session: &str,
        tags: &[McTagRow],
        views: &[crate::ProviderViewRecipe],
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            provider_legacy::save_tx(tx, key, record_json, engine_session, tags, views)
        })?;
        Ok(())
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
            generation: None,
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
        let previous: Vec<_> = MIGRATIONS
            .iter()
            .filter(|migration| migration.version < 65)
            .cloned()
            .collect();
        let inner = open_sqlite(&descriptor).unwrap();
        inner.with_conn(register_legacy_trigger_functions).unwrap();
        inner.migrate(NS, &previous).unwrap();
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
            .save_provider_record(&key, record, "engine", &[tag(23, "m2#0")], &[])
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
}

#[cfg(test)]
mod generation_migration_tests {
    use super::*;
    use crate::{open_sqlite, register_legacy_trigger_functions, MIGRATIONS, NS};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    #[test]
    fn migration_70_preserves_legacy_keys_payloads_views_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: NS.into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        };
        let legacy = ProviderSessionKey {
            project_root: "/project".into(),
            session: "s".into(),
            // OpenCode projection rows are discarded during the recipe cutover.
            // Broca's generic observation rows must still survive generation migration.
            harness: "broca".into(),
            generation: None,
        };
        let key = legacy.conversation_key();
        let raw = b"{ \"content\":\"opaque\\u0021\", \"role\":\"user\" }";
        let inner = open_sqlite(&descriptor).unwrap();
        inner.with_conn(register_legacy_trigger_functions).unwrap();
        inner.with_conn(register_migration_functions).unwrap();
        inner
            .migrate(
                NS,
                &MIGRATIONS
                    .iter()
                    .filter(|m| m.version <= 69)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        inner.with_conn(|conn| {
            conn.execute("INSERT INTO mc_provider_conversations_v2(conv_key,project_root,session,harness,engine_namespace) VALUES(?1,'/project','s','broca','legacy-engine')",[&key])?;
            conn.execute("INSERT INTO mc_provider_lineages_v1(conv_key,lineage_id,first_ordinal,session) VALUES(?1,'L',0,'s')",[&key])?;
            conn.execute("INSERT INTO mc_provider_messages_v1 VALUES(?1,'L',0,'m',?2,'s')",params![key,raw.as_slice()])?;
            conn.execute("INSERT INTO mc_provider_views_v1 VALUES(?1,1,'L',0,1,' [ ] ','applied','{}','s')",[&key])?;
            conn.execute("INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{\"kept\":true}','s')",[&key])?;
            Ok(())
        }).unwrap();
        drop(inner);
        // Stop at 72: migration 73 resets development conversations that own a
        // retired mc_provider_views_v1 row, which this fixture deliberately has.
        let through_72 = MIGRATIONS
            .iter()
            .filter(|m| m.version <= 72)
            .cloned()
            .collect::<Vec<_>>();
        let store = McStore::open_with_migrations(&descriptor, false, &through_72).unwrap();
        assert_eq!(store.module_store_schema_version().unwrap(), 72);
        let conversation = store.load_provider_conversation(&legacy).unwrap().unwrap();
        assert_eq!(conversation.engine_namespace, "legacy-engine");
        assert!(conversation.native_pins_json.is_none());
        assert_eq!(
            store.load_provider_messages(&legacy, "L").unwrap()[0].message_bytes,
            raw
        );
        store
            .inner
            .with_conn(|conn| {
                assert_eq!(
                    conn.query_row(
                        "SELECT replacement_json FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=1",
                        [&key],
                        |r| r.get::<_, String>(0)
                    )?,
                    " [ ] "
                );
                Ok(())
            })
            .unwrap();
        store.inner.with_conn(|conn| {
            // Schema-inventory validation runs at the current head in the
            // migration train; this database deliberately stays at 72.
            assert_eq!(conn.query_row("SELECT summary_json FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1",[&key],|r|r.get::<_,String>(0))?,"{\"kept\":true}");
            assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('mc_provider_native_contract_immutable','mc_provider_consumed_tags_change','mc_provider_conversations_policy_namespace_change')",[],|r|r.get::<_,u64>(0))?,3);
            Ok(())
        }).unwrap();
        drop(store);
        let reopened = McStore::open_with_migrations(&descriptor, false, &through_72).unwrap();
        assert_eq!(
            reopened.load_provider_messages(&legacy, "L").unwrap()[0].message_bytes,
            raw
        );
    }
}
