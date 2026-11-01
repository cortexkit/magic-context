//! Bounded, non-publishing classify/map writes in the context-domain transaction.

use crate::{
    load_memory_full_tx, set_memory_mapping_tx, ClassificationUpdate, MappingUpdate, McStore,
    McStoreError, StoredMemoryFull,
};
use rusqlite::{params, Transaction};

#[derive(Debug, Clone)]
pub struct MetadataMemory {
    pub memory: StoredMemoryFull,
    pub unclassified: bool,
    pub open_classification: bool,
    pub files: Vec<String>,
    pub has_sentinel: bool,
    pub mapping_origin: Option<String>,
}

#[cfg(test)]
#[path = "dream_memory_tests.rs"]
mod tests;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ClassificationCommit {
    pub accepted: Vec<i64>,
    pub changed: usize,
}

impl McStore {
    /// The memory domain is project-wide; the task's session identifies its lease,
    /// not the source session of every memory it may classify or map.
    pub fn load_dream_metadata(&self, project: &str) -> Result<Vec<MetadataMemory>, McStoreError> {
        self.context_read(|conn| {
            let ids = conn
                .prepare("SELECT id FROM memories WHERE project_path=?1 AND status IN ('active','permanent') ORDER BY id")?
                .query_map([project], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.into_iter().map(|id| {
                let memory = load_memory_full_tx(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                let (unclassified, open_classification) = conn.query_row(
                    "SELECT classified_at IS NULL, EXISTS(SELECT 1 FROM memory_classification_items i WHERE i.project_path=memories.project_path AND i.memory_id=memories.id AND i.state='pending' AND (SELECT COUNT(*) FROM memory_stage_attempts s, json_each(s.request_json,'$.items') j WHERE s.project_path=i.project_path AND s.stage='turn_two' AND j.value=i.enqueue_sequence)<3) FROM memories WHERE id=?1",
                    [id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let mappings = conn.prepare("SELECT file_path,mapping_origin FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path")?
                    .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(MetadataMemory {
                    memory, unclassified, open_classification,
                    has_sentinel: mappings.iter().any(|(path, _)| path.is_empty()),
                    mapping_origin: mappings.first().map(|(_, origin)| origin.clone()),
                    files: mappings.into_iter().filter_map(|(path, _)| (!path.is_empty()).then_some(path)).collect(),
                })
            }).collect()
        })
    }

    /// Both callbacks run on the metadata's writer transaction. The caller must
    /// check the scheduler's task claim and context.db conflict-domain lease in
    /// `check_commit_fence`. Its enqueue callback invalidates old vectors so the
    /// embedding drain retries the accepted memory after this transaction commits.
    pub fn commit_dream_classifications(
        &self,
        project: &str,
        rows: &[ClassificationUpdate],
        now_ms: i64,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        mut enqueue: impl FnMut(&Transaction<'_>, &StoredMemoryFull) -> rusqlite::Result<()>,
    ) -> Result<ClassificationCommit, McStoreError> {
        self.context_write(&["memories", "memory_embeddings"], |tx| {
            check_commit_fence(tx)?;
            require_memory_authority(tx, project)?;
            let mut result = ClassificationCommit::default();
            for update in rows {
                let Some(memory) = load_memory_full_tx(tx, update.memory_id)? else { continue };
                if memory.project_path != project || !matches!(memory.status.as_str(), "active" | "permanent") || memory.normalized_hash != update.content_hash_at_prompt {
                    continue;
                }
                if update.scope.as_deref().is_some_and(|scope| !matches!(scope, "project" | "ecosystem" | "universe")) { continue; }
                let importance = update.importance.map(|v| v.clamp(1, 100)).or(memory.importance);
                let scope = update.scope.as_deref().unwrap_or(&memory.scope);
                let shareable = update.shareable.unwrap_or(memory.shareable != 0);
                let classified = memory.classified_at.is_some();
                let changed = importance != memory.importance || scope != memory.scope || shareable != (memory.shareable != 0);
                result.accepted.push(memory.id);
                if classified && !changed { continue; }
                // Leave cached session prompts untouched. Updated metadata,
                // including visibility, is read when a prompt is rebuilt normally;
                // no mutation-log correction should force an earlier refresh.
                tx.execute("UPDATE memories SET importance=?2,scope=?3,shareable=?4,classified_at=?5,updated_at=?5 WHERE id=?1", params![memory.id, importance, scope, shareable, now_ms])?;
                enqueue(tx, &memory)?;
                result.changed += usize::from(changed);
            }
            Ok(result)
        })
    }

    pub fn commit_dream_mappings(
        &self,
        project: &str,
        rows: &[MappingUpdate],
        now_ms: i64,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        mut enqueue: impl FnMut(&Transaction<'_>, &StoredMemoryFull) -> rusqlite::Result<()>,
    ) -> Result<Vec<i64>, McStoreError> {
        self.context_write(&["memory_verifications", "memory_embeddings"], |tx| {
            check_commit_fence(tx)?;
            require_memory_authority(tx, project)?;
            let mut accepted = Vec::new();
            for update in rows {
                let Some(memory) = load_memory_full_tx(tx, update.memory_id)? else { continue };
                if memory.project_path != project || !matches!(memory.status.as_str(), "active" | "permanent") || memory.normalized_hash != update.content_hash_at_prompt { continue; }
                let current = tx.prepare("SELECT file_path,mapping_origin FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path")?
                    .query_map([memory.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut paths = update.mapped_files.clone().unwrap_or_default();
                paths.retain(|path| !path.is_empty());
                paths.sort();
                paths.dedup();
                if paths.is_empty() { paths.push(String::new()); }
                let wanted: Vec<_> = paths.into_iter().map(|path| (path, update.mapping_origin.clone())).collect();
                if current == wanted { accepted.push(memory.id); continue; }
                let result = set_memory_mapping_tx(tx, project, std::slice::from_ref(update), now_ms)?;
                if !result.accepted.is_empty() { enqueue(tx, &memory)?; }
                accepted.extend(result.accepted);
            }
            Ok(accepted)
        })
    }
}

fn require_memory_authority(tx: &Transaction<'_>, project: &str) -> rusqlite::Result<()> {
    if crate::memory_lifecycle::authority::module_owns_memory(tx, project)? {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}
