//! Read-only provider inputs for in-memory policy rebuilding and offline fixtures.
//! Capturing these inputs never publishes a resident checkpoint or a new baseline.
use crate::provider_log::{
    conversation_tx, ProviderConversation, ProviderError, ProviderMessage, ProviderPolicyIndex,
    ProviderPolicyPart,
};
use crate::{McStore, ProviderSessionKey};
use rusqlite::params;
use serde_json::Value;
use std::collections::BTreeMap;

fn fold_counters_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    conversation: &ProviderConversation,
) -> rusqlite::Result<Value> {
    use rusqlite::OptionalExtension;
    let mut counters: Value = serde_json::from_str(&conversation.hook_counters_json)
        .map_err(crate::serde_to_sql_error)?;
    let cut: Option<(u64, String)> = conn.query_row(
        "SELECT cut_id,policy_key FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND lineage_id=?2 ORDER BY cut_id DESC LIMIT 1",
        params![conv, conversation.lineage_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    // Initial insertion recipes use the literal key "setup", not engine settings.
    // They have no summarized prefix to restore into a resident fold.
    if let Some((cut, settings)) = cut.filter(|(_, settings)| settings != "setup") {
        let settings: Value = serde_json::from_str(&settings).map_err(crate::serde_to_sql_error)?;
        // Runner metadata saves replace hook counters on both serving paths.
        // Each immutable cut keeps the settings for its summarized prefix, so
        // recover those settings here when the counters no longer contain them.
        if counters.get("engine_policy").is_none() {
            counters["engine_policy"] = settings.clone();
        }
        if let Some(revision) = settings.get("native_compartment_source_revision") {
            counters["engine_policy"]["native_compartment_source_revision"] = revision.clone();
        }
        // baseline_cut_id ties cached prefix measurements to this stored cut.
        // Synthesize it for the reader without changing durable hook counters.
        counters["engine_policy"]["baseline_cut_id"] = serde_json::json!(cut);
    }
    Ok(counters)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CompartmentSourceRevision {
    pub generation: String,
    pub version: u64,
}

pub struct ProviderResidentAuthority {
    pub conversation_key: String,
    pub store_instance: u64,
    pub conversation: ProviderConversation,
    pub policy_revision: u64,
    pub ancestry: Vec<(String, u64)>,
    pub parts: Vec<ProviderPolicyPart>,
    pub tail: Vec<ProviderMessage>,
    pub coverage: Option<u64>,
    pub tail_blob_rows: usize,
    pub tail_blob_bytes: usize,
}

impl McStore {
    /// Prove that each target exists in the active lineage at or below the
    /// retained coverage boundary. Coverage only advances, so those blocks are
    /// permanently retired even when the current request omits them. Missing
    /// rows are not proof: a partial request can omit a still-live queued target.
    pub fn provider_covered_drop_targets(
        &self,
        namespace: &str,
        through: u64,
        targets: &[&str],
    ) -> Result<std::collections::HashSet<String>, crate::McStoreError> {
        use rusqlite::OptionalExtension;
        Ok(self.inner.with_conn(|conn| {
            let owner: Option<(String, String)> = conn.query_row(
                "SELECT conv_key,lineage_id FROM mc_provider_conversations_v2 WHERE engine_namespace=?1",
                [namespace], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            let mut covered = std::collections::HashSet::new();
            let Some((conv, lineage)) = owner else { return Ok(covered); };
            let ancestry = crate::provider_log::ancestry_tx(conn, &conv, &lineage)?;
            let mut query = conn.prepare_cached("SELECT ordinal,frozen_policy_format,frozen_policy_bytes,frozen_policy_raw_bytes,frozen_policy_parts FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND mid=?3")?;
            for target in targets {
                let Some((mid, _)) = target.rsplit_once('#') else { continue; };
                for (source, cut) in &ancestry {
                    let row = query.query_row(params![conv, source.lineage_id, mid], |row| {
                        Ok((row.get::<_,u64>(0)?, row.get::<_,u32>(1)?, row.get::<_,Option<Vec<u8>>>(2)?, row.get::<_,usize>(3)?, row.get::<_,usize>(4)?))
                    }).optional()?;
                    if let Some((ordinal, format, blob, bytes, parts)) = row {
                        if ordinal > *cut { continue; }
                        if ordinal <= through && format == 1 {
                            let facts = crate::provider_policy_overlay::decode_facts(&blob.unwrap_or_default(), bytes, parts)
                                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
                            if facts.iter().any(|part| part.kind != "header" && part.block_id == *target) {
                                covered.insert((*target).to_owned());
                            }
                        }
                        break;
                    }
                }
            }
            Ok(covered)
        })?)
    }

    pub fn provider_fold_settings(&self, key: &ProviderSessionKey) -> Result<Value, ProviderError> {
        self.inner
            .with_conn(|conn| {
                let conversation =
                    conversation_tx(conn, key)?.ok_or(rusqlite::Error::InvalidQuery)?;
                Ok(
                    fold_counters_tx(conn, &key.conversation_key(), &conversation)?
                        ["engine_policy"]
                        .clone(),
                )
            })
            .map_err(|error| ProviderError::Storage(error.into()))
    }
    /// Includes every compartment write, including interior boundary edits that
    /// leave the last covered message unchanged. Fold reuse needs that stronger
    /// identity than the revision used to decide whether to refresh history text.
    pub fn compartment_source_revision(
        &self,
        session: &str,
    ) -> Result<Option<CompartmentSourceRevision>, crate::McStoreError> {
        use rusqlite::OptionalExtension;
        self.context_read(|conn| {
            conn.query_row(
                "SELECT generation,version FROM compartment_history_versions WHERE session_id=?1",
                [session],
                |row| {
                    Ok(CompartmentSourceRevision {
                        generation: row.get(0)?,
                        version: row.get(1)?,
                    })
                },
            )
            .optional()
        })
    }

    /// Read the compartment revision captured with the policy baseline referenced
    /// by this cache row. The latest conversation baseline may name a newer cut
    /// and cannot establish which compartments produced an older cached view.
    pub fn provider_cut_source_revision(
        &self,
        key: &ProviderSessionKey,
        namespace: &str,
        cut: u64,
    ) -> Result<Option<CompartmentSourceRevision>, ProviderError> {
        use rusqlite::OptionalExtension;
        self.inner.with_conn(|conn| {
            let tx=conn.unchecked_transaction()?;
            if crate::cache_codec::native_tail_cut(&tx,namespace)? != Some(cut) { return Ok(None); }
            let raw:Option<String>=tx.query_row("SELECT defaults_json FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND cut_id=?2",
                params![key.conversation_key(),cut],|row|row.get(0)).optional()?;
            let revision=raw.and_then(|raw|serde_json::from_str::<Value>(&raw).ok())
                .and_then(|value|value.get("native_compartment_source_revision").cloned())
                .and_then(|value|serde_json::from_value(value).ok());
            tx.commit()?; Ok(revision)
        }).map_err(|error|ProviderError::Storage(error.into()))
    }

    pub fn provider_prefix_user_messages(
        &self,
        key: &ProviderSessionKey,
        lineage: &str,
        through: u64,
    ) -> Result<Vec<ProviderMessage>, ProviderError> {
        self.inner.with_conn(|conn| {
            let mut out=BTreeMap::new();
            let mut bytes=0usize;
            for (lineage,cut) in crate::provider_log::ancestry_tx(conn,&key.conversation_key(),lineage)? {
                let mut q=conn.prepare_cached("SELECT ordinal,mid,CASE WHEN length(message_bytes)<=8388608 THEN message_bytes ELSE NULL END FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3 AND json_extract(CAST(message_bytes AS TEXT),'$.info.role')='user'")?;
                let rows=q.query_map(params![key.conversation_key(),lineage.lineage_id,cut.min(through)],|row|Ok(ProviderMessage{ordinal:row.get(0)?,mid:row.get(1)?,message_bytes:row.get::<_,Option<Vec<u8>>>(2)?.ok_or(rusqlite::Error::InvalidQuery)?}))?;
                for row in rows {let row=row?;bytes=bytes.saturating_add(row.message_bytes.len());if bytes>8*1024*1024 {return Err(rusqlite::Error::InvalidQuery);}out.entry(row.ordinal).or_insert(row);}
            }
            Ok(out.into_values().collect())
        }).map_err(|error|ProviderError::Storage(error.into()))
    }
    /// Read the authoritative policy rows and their counters at one database cut.
    /// This read does not save a resident checkpoint or advance a policy baseline.
    pub fn read_provider_resident_policy<T>(
        &self,
        key: &ProviderSessionKey,
        read: impl FnOnce(&ProviderPolicyIndex<'_>, &Value) -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        let mut refusal = None;
        self.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let conversation = conversation_tx(&tx, key)?.ok_or(rusqlite::Error::InvalidQuery)?;
            let result = (|| {
                let (rows, bytes): (u64, u64) = tx.query_row(
                    "SELECT COALESCE(SUM(parts),0),COALESCE(SUM(bytes),0) FROM (SELECT COUNT(*) AS parts,COALESCE(SUM(length(CAST(policy_json AS BLOB))),0) AS bytes FROM mc_provider_policy_parts_v1 WHERE conv_key=?1 UNION ALL SELECT COALESCE(SUM(frozen_policy_parts),0),COALESCE(SUM(frozen_policy_raw_bytes),0) FROM mc_provider_messages_v1 WHERE conv_key=?1 AND frozen_policy_format=1)",
                    [key.conversation_key()], |r| Ok((r.get(0)?, r.get(1)?)))?;
                if rows > 100_000 || bytes > 128 * 1024 * 1024 {
                    return Err(ProviderError::Transient("resident_not_ready: policy input exceeds rebuild cap".into()));
                }
                let counters = fold_counters_tx(&tx, &key.conversation_key(), &conversation)?;
                let index = ProviderPolicyIndex::new(&tx, &key.conversation_key(), &conversation.lineage_id)?;
                read(&index, &counters)
            })().map_err(|e| { refusal = Some(e); rusqlite::Error::InvalidQuery })?;
            tx.commit()?;
            Ok(result)
        }).map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// Too many policy rows, or too much encoded row data, can make rebuilding
    /// the process cache inadmissible. Folds then read the complete transcript
    /// instead. Other storage errors still refuse; transform.hook continues to
    /// use the bounded reader and keeps its retryable admission error.
    pub fn read_provider_fold_resident_policy<T>(
        &self,
        key: &ProviderSessionKey,
        read: impl FnOnce(&ProviderPolicyIndex<'_>, &Value) -> Result<T, ProviderError>,
    ) -> Result<Option<T>, ProviderError> {
        match self.read_provider_resident_policy(key, read) {
            Ok(value) => Ok(Some(value)),
            Err(ProviderError::Transient(reason))
                if reason == "resident_not_ready: policy input exceeds rebuild cap" =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Capture current provider authority in one read transaction. The policy
    /// index is a cold-build input; native BLOB reads are restricted to the
    /// unsummarized tail before they are decoded or copied.
    pub fn read_provider_resident_authority(
        &self,
        key: &ProviderSessionKey,
        max_parts: usize,
        max_tail: usize,
        max_bytes: usize,
    ) -> Result<ProviderResidentAuthority, ProviderError> {
        let mut refusal = None;
        let result = self.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let read = || -> Result<ProviderResidentAuthority, ProviderError> {
                let conversation = conversation_tx(&tx, key)?.ok_or_else(|| ProviderError::Transient("resident input conversation is missing".into()))?;
                let revision = crate::provider_preparation::policy_revision_tx(&tx, &conversation.engine_namespace)?;
                let counters: Value = serde_json::from_str(&conversation.hook_counters_json).map_err(|e| ProviderError::Transient(e.to_string()))?;
                let coverage = counters.pointer("/engine_policy/coverage").and_then(Value::as_u64);
                let conv = key.conversation_key();
                // Count before allocating. Counting shadowed rows is deliberately
                // conservative; an oversize experiment must not truncate policy.
                let (rows, bytes): (u64, u64) = tx.query_row("SELECT COALESCE(SUM(parts),0),COALESCE(SUM(bytes),0) FROM (SELECT COUNT(*) AS parts,COALESCE(SUM(length(CAST(policy_json AS BLOB))),0) AS bytes FROM mc_provider_policy_parts_v1 WHERE conv_key=?1 UNION ALL SELECT COALESCE(SUM(frozen_policy_parts),0),COALESCE(SUM(frozen_policy_raw_bytes),0) FROM mc_provider_messages_v1 WHERE conv_key=?1 AND frozen_policy_format=1)", [&conv], |r| Ok((r.get(0)?, r.get(1)?)))?;
                if rows > max_parts as u64 || bytes > max_bytes as u64 {
                    return Err(ProviderError::Transient("resident policy input exceeds cap".into()));
                }
                let index = ProviderPolicyIndex::new(&tx, &conv, &conversation.lineage_id)?;
                if index.ancestry().len() > 64 { return Err(ProviderError::Transient("resident ancestry exceeds cap".into())); }
                let parts = index.all_parts()?;
                let ancestry = index.ancestry().to_vec();
                let mut tail = BTreeMap::new();
                let mut tail_blob_rows = 0;
                let mut tail_blob_bytes = 0usize;
                for (lineage, cut) in &ancestry {
                    if coverage.is_some_and(|n| n >= i64::MAX as u64) { continue; }
                    let mut q = tx.prepare("SELECT ordinal,mid,CASE WHEN length(message_bytes)<=?6 THEN message_bytes ELSE NULL END FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal>=?3 AND ordinal<=?4 ORDER BY ordinal LIMIT ?5")?;
                    let first = coverage.map_or(0, |n| n.saturating_add(1));
                    let messages = q.query_map(params![conv, lineage, first.min(i64::MAX as u64), (*cut).min(i64::MAX as u64), max_tail.saturating_add(1).min(i64::MAX as usize) as i64, max_bytes.min(i64::MAX as usize) as i64], |r| Ok(ProviderMessage { ordinal: r.get(0)?, mid: r.get(1)?, message_bytes: r.get::<_, Option<Vec<u8>>>(2)?.ok_or(rusqlite::Error::InvalidQuery)? }))?;
                    for message in messages {
                        let message = message?;
                        tail_blob_rows += 1;
                        tail_blob_bytes = tail_blob_bytes.checked_add(message.message_bytes.len()).ok_or_else(|| ProviderError::Transient("resident tail byte count overflow".into()))?;
                        if tail_blob_bytes.checked_add(bytes as usize).is_none_or(|size| size > max_bytes) { return Err(ProviderError::Transient("resident tail input exceeds byte cap".into())); }
                        if tail.insert(message.ordinal, message).is_some() { return Err(ProviderError::Transient("resident ancestry has overlapping native ordinals".into())); }
                        if tail.len() > max_tail { return Err(ProviderError::Transient("resident native tail exceeds cap".into())); }
                    }
                }
                Ok(ProviderResidentAuthority { conversation_key: conv, store_instance: self.tag_cache_namespace(), conversation, policy_revision: revision, ancestry, parts, tail: tail.into_values().collect(), coverage, tail_blob_rows, tail_blob_bytes })
            };
            let captured = read().map_err(|e| { refusal = Some(e); rusqlite::Error::InvalidQuery })?;
            tx.commit()?;
            Ok(captured)
        });
        result.map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_records::{ProviderLineage, ProviderStatusPage};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    fn rig(coverage: Option<u64>) -> (tempfile::TempDir, McStore, ProviderSessionKey) {
        let root = std::env::temp_dir().join("magic-context/provider-resident-authority");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let key = ProviderSessionKey {
            project_root: "/resident-fixture".into(),
            session: "s".into(),
            harness: "opencode".into(),
            generation: None,
        };
        store
            .save_provider_conversation(
                &key,
                &ProviderConversation {
                    lineage_id: "L".into(),
                    engine_namespace: "engine".into(),
                    hook_counters_json: serde_json::json!({"engine_policy":{"coverage":coverage}})
                        .to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
        (dir, store, key)
    }
    fn ingest(store: &McStore, key: &ProviderSessionKey, count: u64) {
        let lineage = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        let messages = (1..=count).map(|ordinal| ProviderMessage { ordinal, mid: format!("m{ordinal}"),
            message_bytes: serde_json::to_vec(&serde_json::json!({"info":{"id":format!("m{ordinal}"),"role":"assistant"},"parts":[{"type":"text","text":"raw tail"}]})).unwrap() }).collect::<Vec<_>>();
        store
            .commit_provider_status_page(
                key,
                ProviderStatusPage {
                    lineage: &lineage,
                    messages: &messages,
                    served: Some(count),
                    unserved: &[],
                    newest: Some(count),
                    more: false,
                },
            )
            .unwrap();
    }
    #[test]
    fn resident_authority_covered_history_is_not_materialized() {
        let (_dir, store, key) = rig(Some(16_500));
        ingest(&store, &key, 17_000);
        let read = store
            .read_provider_resident_authority(&key, 100_000, 500, 128 * 1024 * 1024)
            .unwrap();
        assert_eq!(read.tail_blob_rows, 500);
        assert_eq!(read.tail.first().unwrap().ordinal, 16_501);
        assert_eq!(read.tail.last().unwrap().ordinal, 17_000);
        let full = store.load_provider_messages(&key, "L").unwrap();
        assert_eq!(
            read.tail,
            full[16_500..],
            "independent existing lineage reader tail"
        );
    }
    #[test]
    fn resident_authority_read_transaction_has_no_writes() {
        let (_dir, store, key) = rig(None);
        ingest(&store, &key, 3);
        let changes = || {
            store
                .inner
                .with_conn(|conn| Ok(conn.total_changes()))
                .unwrap()
        };
        let before = changes();
        let revision = store.provider_policy_revision("engine").unwrap();
        let conversation = store.load_provider_conversation(&key).unwrap().unwrap();
        let read = store
            .read_provider_resident_authority(&key, 100, 10, 1024 * 1024)
            .unwrap();
        assert_eq!(
            serde_json::to_value(read.conversation).unwrap(),
            serde_json::to_value(conversation).unwrap()
        );
        assert_eq!(changes(), before);
        assert_eq!(store.provider_policy_revision("engine").unwrap(), revision);
        assert_eq!(read.tail, store.load_provider_messages(&key, "L").unwrap());
    }
    #[test]
    fn resident_authority_native_limits_refuse_instead_of_truncating() {
        let (_dir, store, key) = rig(None);
        ingest(&store, &key, 3);
        assert!(store
            .read_provider_resident_authority(&key, 100, 2, 1024 * 1024)
            .is_err());
        assert!(store
            .read_provider_resident_authority(&key, 100, 10, 16)
            .is_err());
        assert_eq!(store.load_provider_messages(&key, "L").unwrap().len(), 3);
    }
}
