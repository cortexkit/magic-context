//! Cache of derived policy preparation, valid only at the policy revision used
//! to build it. It is separate from normal published policy: reading or saving
//! it never acknowledges a view or publishes a baseline, cadence or hook answer.
//! Keeping these writes separate prevents preparation from advancing the next
//! hook's baseline before its actual newest message is admitted.
use crate::provider_log::{conversation_tx, ProviderError, ProviderPolicyIndex};
use crate::{McStore, ProviderSessionKey};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const MAX_PROVIDER_PREPARATION_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ProviderPreparationWrite {
    pub settings_key: String,
    pub original_baseline_json: String,
    pub newest_ordinal: u64,
    pub prepared_json: String,
}

#[derive(Clone, Debug)]
pub struct ProviderStoredPreparation {
    pub settings_key: String,
    pub original_baseline_json: String,
    pub newest_ordinal: u64,
    pub prepared_blob: Vec<u8>,
    pub uncompressed_bytes: usize,
}
impl ProviderStoredPreparation {
    pub fn decode(&self) -> Result<String, ProviderError> {
        if self.uncompressed_bytes > MAX_PROVIDER_PREPARATION_BYTES {
            return Err(ProviderError::Transient(
                "prepared policy exceeds its byte cap".into(),
            ));
        }
        if self.prepared_blob.len() < 32
            || Sha256::digest(&self.prepared_blob[32..])[..] != self.prepared_blob[..32]
        {
            return Err(ProviderError::Transient(
                "prepared policy checksum changed".into(),
            ));
        }
        let mut decoded = String::new();
        DeflateDecoder::new(&self.prepared_blob[32..])
            .take(MAX_PROVIDER_PREPARATION_BYTES as u64 + 1)
            .read_to_string(&mut decoded)
            .map_err(|e| ProviderError::Transient(e.to_string()))?;
        if decoded.len() != self.uncompressed_bytes {
            return Err(ProviderError::Transient(
                "prepared policy size changed".into(),
            ));
        }
        Ok(decoded)
    }
}

pub(crate) fn policy_revision_tx(conn: &Connection, namespace: &str) -> rusqlite::Result<u64> {
    conn.query_row(
        "SELECT revision FROM mc_provider_policy_revisions_v1 WHERE engine_namespace=?1",
        [namespace],
        |row| row.get(0),
    )
}

pub(crate) fn matching_preparation_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
    namespace: &str,
) -> rusqlite::Result<Option<ProviderStoredPreparation>> {
    conn.query_row("SELECT p.settings_key,p.original_baseline_json,p.newest_ordinal,p.prepared_blob,p.uncompressed_bytes FROM mc_provider_policy_preparations_v1 p JOIN mc_provider_policy_revisions_v1 r ON r.engine_namespace=p.engine_namespace AND r.revision=p.policy_revision WHERE p.conv_key=?1 AND p.engine_namespace=?2", params![key.conversation_key(),namespace], |row| {
        Ok(ProviderStoredPreparation { settings_key: row.get(0)?, original_baseline_json: row.get(1)?, newest_ordinal: row.get(2)?, prepared_blob: row.get(3)?, uncompressed_bytes: row.get(4)? })
    }).optional()
}

impl McStore {
    pub fn provider_policy_revision(&self, namespace: &str) -> Result<u64, ProviderError> {
        self.inner
            .with_conn(|conn| policy_revision_tx(conn, namespace))
            .map_err(|e| ProviderError::Storage(e.into()))
    }

    /// Build and save derived preparation in one transaction at the current
    /// policy revision. Return true only when a row is saved. Return false for
    /// pending change-log rows, a skipped builder or a size-cap failure; never
    /// erase those changes or publish normal policy to make the cache fit.
    pub fn prepare_provider_policy(
        &self,
        key: &ProviderSessionKey,
        build: impl FnOnce(
            &ProviderPolicyIndex<'_>,
            &Value,
        ) -> Result<Option<ProviderPreparationWrite>, ProviderError>,
    ) -> Result<bool, ProviderError> {
        let mut refusal = None;
        let result = self.inner.with_conn_fenced(|conn| {
            let operation = || -> Result<bool, ProviderError> {
                let conversation = conversation_tx(conn, key)?.ok_or_else(|| ProviderError::Transient("provider conversation is missing".into()))?;
                let conv = key.conversation_key();
                let changed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_policy_changes_v1 WHERE conv_key=?1)", [&conv], |row| row.get(0))?;
                if changed { return Ok(false); }
                let revision = policy_revision_tx(conn, &conversation.engine_namespace)?;
                let counters: Value = serde_json::from_str(&conversation.hook_counters_json).map_err(|e| ProviderError::Transient(e.to_string()))?;
                let index = ProviderPolicyIndex::new(conn, &conv, &conversation.lineage_id)?;
                let Some(prepared) = build(&index, &counters)? else { return Ok(false); };
                if prepared.prepared_json.len() > MAX_PROVIDER_PREPARATION_BYTES { return Ok(false); }
                let mut compressed = DeflateEncoder::new(Vec::new(), Compression::fast());
                compressed.write_all(prepared.prepared_json.as_bytes()).map_err(|e| ProviderError::Transient(e.to_string()))?;
                let compressed = compressed.finish().map_err(|e| ProviderError::Transient(e.to_string()))?;
                let mut blob = Sha256::digest(&compressed).to_vec();
                blob.extend(compressed);
                conn.execute("INSERT INTO mc_provider_policy_preparations_v1 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,json_extract(?1,'$[1]')) ON CONFLICT(conv_key) DO UPDATE SET engine_namespace=excluded.engine_namespace,policy_revision=excluded.policy_revision,settings_key=excluded.settings_key,original_baseline_json=excluded.original_baseline_json,newest_ordinal=excluded.newest_ordinal,prepared_blob=excluded.prepared_blob,uncompressed_bytes=excluded.uncompressed_bytes", params![conv,conversation.engine_namespace,revision,prepared.settings_key,prepared.original_baseline_json,prepared.newest_ordinal,blob,prepared.prepared_json.len()])?;
                Ok(true)
            };
            operation().map_err(|e| { refusal = Some(e); rusqlite::Error::InvalidQuery })
        });
        result.map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    fn rig() -> (tempfile::TempDir, McStore, ProviderSessionKey) {
        let root = std::env::temp_dir().join("magic-context/provider-revision-tests");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let descriptor = StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        let key = ProviderSessionKey {
            project_root: "/fixture".into(),
            session: "session".into(),
            harness: "opencode".into(),
            generation: None,
        };
        store
            .save_provider_conversation(
                &key,
                &crate::provider_log::ProviderConversation {
                    engine_namespace: "engine".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        (dir, store, key)
    }
    fn write(store: &McStore, key: &ProviderSessionKey, sql: &str) {
        let before = store.provider_policy_revision("engine").unwrap();
        store
            .inner
            .with_conn_fenced(|conn| conn.execute(sql, [key.conversation_key()]).map(|_| ()))
            .unwrap();
        assert!(
            store.provider_policy_revision("engine").unwrap() > before,
            "policy write did not bump its namespace revision: {sql}"
        );
    }
    #[test]
    fn every_policy_input_table_write_advances_the_revision() {
        let (_dir, store, key) = rig();
        let statements = [
            "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'L',1,NULL,NULL,'session')",
            "UPDATE mc_provider_lineages_v1 SET first_ordinal=2 WHERE conv_key=?1",
            "INSERT INTO mc_provider_messages_v1(conv_key,lineage_id,ordinal,mid,message_bytes,session) VALUES (?1,'L',2,'m',x'7b7d','session')",
            "UPDATE mc_provider_messages_v1 SET message_bytes=x'7b20207d' WHERE conv_key=?1",
            "DELETE FROM mc_provider_messages_v1 WHERE conv_key=?1",
            "INSERT INTO mc_provider_hook_answers_v1 (conv_key,answer_seq,lineage_id,subject_mid,hook,subject_part,ordinal,ops_json,tags_json,state,session) VALUES (?1,1,'L','m','post_tool','p',2,'[]','[]','pending','session')",
            "UPDATE mc_provider_hook_answers_v1 SET policy_json='{\"cadence_event\":{\"fire\":true}}' WHERE conv_key=?1",
            "DELETE FROM mc_provider_hook_answers_v1 WHERE conv_key=?1",
            "INSERT INTO mc_provider_policy_parts_v1 VALUES (?1,'L',2,'m#0','{}','session')",
            "UPDATE mc_provider_policy_parts_v1 SET policy_json='{\"protected\":true,\"measurement\":{\"tokens\":2}}' WHERE conv_key=?1",
            "DELETE FROM mc_provider_policy_parts_v1 WHERE conv_key=?1",
            "INSERT INTO mc_provider_policy_summaries_v1 VALUES (?1,'{}','session')",
            "UPDATE mc_provider_policy_summaries_v1 SET summary_json='{\"key\":\"changed\"}' WHERE conv_key=?1",
            "INSERT INTO mc_provider_policy_changes_v1 VALUES (?1,'L','m#0',NULL,0,'session')",
            "UPDATE mc_provider_policy_changes_v1 SET previous_consumed=1 WHERE conv_key=?1",
            "DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key=?1",
            "DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1",
            "INSERT INTO mc_provider_pending_drops_v1 VALUES (?1,1,'session')",
            "UPDATE mc_provider_pending_drops_v1 SET tag_number=2 WHERE conv_key=?1",
            "DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key=?1",
            "INSERT INTO mc_provider_legacy_tags_v1 VALUES (?1,1,'live','{}','session')",
            "UPDATE mc_provider_legacy_tags_v1 SET tag_json='{\"active\":false}' WHERE conv_key=?1",
            "DELETE FROM mc_provider_legacy_tags_v1 WHERE conv_key=?1",
            "UPDATE mc_provider_conversations_v2 SET params_json='{\"protection\":2}' WHERE conv_key=?1",
            "UPDATE mc_provider_conversations_v2 SET hook_counters_json='{\"engine_policy\":{\"baseline\":{\"baseline_generation\":2},\"protected_tools\":{\"bash\":3}}}' WHERE conv_key=?1",
            "DELETE FROM mc_provider_lineages_v1 WHERE conv_key=?1",
        ];
        for sql in statements {
            write(&store, &key, sql);
        }
        for sql in [
            "INSERT INTO mc_provider_consumed_tags_v1 VALUES ('engine',1,'session')",
            "UPDATE mc_provider_consumed_tags_v1 SET tag_number=2 WHERE engine_namespace='engine'",
            "DELETE FROM mc_provider_consumed_tags_v1 WHERE engine_namespace='engine'",
            "INSERT INTO mc_tags (session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES ('engine',1,'m#0','message',1,1,x'61')",
            "UPDATE mc_tags SET token_count=2 WHERE session_id='engine'",
            "DELETE FROM mc_tags WHERE session_id='engine'",
        ] {
            let before = store.provider_policy_revision("engine").unwrap();
            store.inner.with_conn_fenced(|conn| conn.execute(sql, []).map(|_| ())).unwrap();
            assert!(store.provider_policy_revision("engine").unwrap() > before, "{sql}");
        }
        let before = store.provider_policy_revision("engine").unwrap();
        let loaded = store.load("engine").unwrap();
        store
            .commit("engine", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        assert!(store.provider_policy_revision("engine").unwrap() > before);
        let before = store.provider_policy_revision("engine").unwrap();
        let mut loaded = store.load("engine").unwrap();
        loaded.meta.last_model_key = "revision-test".into();
        store
            .commit("engine", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        assert!(store.provider_policy_revision("engine").unwrap() > before);
        let before = store.provider_policy_revision("engine").unwrap();
        store
            .inner
            .with_conn_fenced(|conn| {
                conn.execute("DELETE FROM mc_cache_state WHERE session_id='engine'", [])
                    .map(|_| ())
            })
            .unwrap();
        assert!(store.provider_policy_revision("engine").unwrap() > before);
    }
    #[test]
    fn preparation_writes_no_policy_state_and_a_sibling_invalidates_it() {
        let (_dir, store, key) = rig();
        write(
            &store,
            &key,
            "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'L',1,NULL,NULL,'session')",
        );
        store
            .inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "UPDATE mc_provider_conversations_v2 SET lineage_id='L' WHERE conv_key=?1",
                    [key.conversation_key()],
                )
                .map(|_| ())
            })
            .unwrap();
        let revision = store.provider_policy_revision("engine").unwrap();
        assert!(store
            .prepare_provider_policy(&key, |_, _| Ok(Some(ProviderPreparationWrite {
                settings_key: "key".into(),
                original_baseline_json: "{}".into(),
                newest_ordinal: 1,
                prepared_json: "{\"derived\":true}".into()
            })))
            .unwrap());
        assert_eq!(store.provider_policy_revision("engine").unwrap(), revision);
        let decoded = store
            .inner
            .with_conn(|conn| matching_preparation_tx(conn, &key, "engine"))
            .unwrap()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(decoded, "{\"derived\":true}");
        let sibling = ProviderSessionKey {
            harness: "opencode2".into(),
            ..key.clone()
        };
        store
            .save_provider_conversation(
                &sibling,
                &crate::provider_log::ProviderConversation {
                    engine_namespace: "engine".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store
            .inner
            .with_conn(|conn| matching_preparation_tx(conn, &key, "engine"))
            .unwrap()
            .is_none());
    }
    #[test]
    fn policy_revision_bump_rolls_back_with_the_policy_write() {
        let (_dir, store, key) = rig();
        let before = store.provider_policy_revision("engine").unwrap();
        let result = store.inner.with_conn_fenced(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_policy_parts_v1 VALUES (?1,'L',1,'m#0','{}','session')",
                [key.conversation_key()],
            )?;
            Err::<(), _>(rusqlite::Error::InvalidQuery)
        });
        assert!(result.is_err());
        assert_eq!(store.provider_policy_revision("engine").unwrap(), before);
        let rows: u64 = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM mc_provider_policy_parts_v1",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn preparation_refuses_unaccounted_changes_without_clearing_frontier() {
        let (_dir, store, key) = rig();
        write(
            &store,
            &key,
            "INSERT INTO mc_provider_policy_changes_v1 VALUES (?1,'L','m#0',NULL,0,'session')",
        );
        let before = store.provider_policy_revision("engine").unwrap();
        assert!(!store
            .prepare_provider_policy(&key, |_, _| {
                panic!("unaccounted changes must prevent preparation before the builder runs")
            })
            .unwrap());
        assert_eq!(store.provider_policy_revision("engine").unwrap(), before);
        store.inner.with_conn(|conn| {
            let held: (String, String, i64) = conn.query_row("SELECT lineage_id,block_id,previous_consumed FROM mc_provider_policy_changes_v1 WHERE conv_key=?1", [key.conversation_key()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            assert_eq!(held, ("L".into(), "m#0".into(), 0));
            assert!(matching_preparation_tx(conn, &key, "engine")?.is_none());
            Ok(())
        }).unwrap();
    }
    #[test]
    fn exhausted_revision_aborts_an_or_ignore_writer() {
        let (_dir, store, _key) = rig();
        store.inner.with_conn_fenced(|conn| conn.execute("UPDATE mc_provider_policy_revisions_v1 SET revision=9223372036854775807 WHERE engine_namespace='engine'", []).map(|_| ())).unwrap();
        let result = store.inner.with_conn_fenced(|conn| conn.execute("INSERT OR IGNORE INTO mc_tags (session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES ('engine',1,'m#0','message',1,1,x'61')", []));
        assert!(result.is_err());
        let rows: u64 = store
            .inner
            .with_conn(|conn| conn.query_row("SELECT count(*) FROM mc_tags", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(rows, 0);
    }
}

#[cfg(test)]
mod namespace_revision_tests {
    use super::*;
    #[test]
    fn namespace_move_replace_and_delete_fence_old_and_new_spaces() {
        let root = std::env::temp_dir().join("magic-context/provider-revision-tests");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        let key = ProviderSessionKey {
            project_root: "/fixture".into(),
            session: "session".into(),
            harness: "opencode".into(),
            generation: None,
        };
        let mut conversation = crate::provider_log::ProviderConversation {
            engine_namespace: "first".into(),
            ..Default::default()
        };
        store
            .save_provider_conversation(&key, &conversation)
            .unwrap();
        let first = store.provider_policy_revision("first").unwrap();
        conversation.engine_namespace = "second".into();
        store
            .save_provider_conversation(&key, &conversation)
            .unwrap();
        assert!(store.provider_policy_revision("first").unwrap() > first);
        let second = store.provider_policy_revision("second").unwrap();
        store.inner.with_conn_fenced(|conn| conn.execute("INSERT OR REPLACE INTO mc_provider_conversations_v2 (conv_key,project_root,session,harness,engine_namespace) VALUES (?1,'/fixture','session','opencode','first')", [key.conversation_key()]).map(|_| ())).unwrap();
        assert!(store.provider_policy_revision("second").unwrap() > second);
        let before_delete = store.provider_policy_revision("first").unwrap();
        store
            .inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "DELETE FROM mc_provider_conversations_v2 WHERE conv_key=?1",
                    [key.conversation_key()],
                )
                .map(|_| ())
            })
            .unwrap();
        assert!(store.provider_policy_revision("first").unwrap() > before_delete);
    }
}

#[cfg(test)]
mod admission_revision_tests {
    use super::*;
    #[test]
    fn preparation_revision_is_checked_before_the_real_hook_admits_its_message() {
        let root = std::env::temp_dir().join("magic-context/provider-revision-tests");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        let key = ProviderSessionKey {
            project_root: "/fixture".into(),
            session: "session".into(),
            harness: "opencode".into(),
            generation: None,
        };
        store
            .save_provider_conversation(
                &key,
                &crate::provider_log::ProviderConversation {
                    engine_namespace: "engine".into(),
                    lineage_id: "L".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'L',1,NULL,NULL,'session')",
                    [key.conversation_key()],
                )
                .map(|_| ())
            })
            .unwrap();
        store
            .prepare_provider_policy(&key, |_, _| {
                Ok(Some(ProviderPreparationWrite {
                    settings_key: "key".into(),
                    original_baseline_json: "{}".into(),
                    newest_ordinal: 0,
                    prepared_json: "{}".into(),
                }))
            })
            .unwrap();
        let message = crate::provider_log::ProviderMessage {
            ordinal: 1,
            mid: "m".into(),
            message_bytes: b"{}".to_vec(),
        };
        let lineage = crate::provider_log::ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        let found = store
            .commit_provider_hook_with_preparation(
                &key,
                crate::provider_log::ProviderHookRequest {
                    lineage: &lineage,
                    message: Some(&message),
                    served_through_ordinal: None,
                    unserved_subjects: &[],
                    repeat_subject: None,
                },
                &[],
                true,
                |ctx| {
                    Ok((
                        crate::provider_log::ProviderHookWrite {
                            answer: None,
                            counters: ctx.counters.clone(),
                            policy_summary: None,
                        },
                        ctx.policy_index.preparation().is_some(),
                    ))
                },
            )
            .unwrap();
        assert!(
            found,
            "the hook's own admission must not invalidate its already-validated preparation"
        );
        let held: u64 = store
            .inner
            .with_conn(|conn| {
                conn.query_row("SELECT count(*) FROM mc_provider_messages_v1", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(held, 1);
        assert!(store
            .inner
            .with_conn(|conn| matching_preparation_tx(conn, &key, "engine"))
            .unwrap()
            .is_none());
    }
}
