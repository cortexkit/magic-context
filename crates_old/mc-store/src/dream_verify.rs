//! Snapshot reads and atomic, non-publishing verification/expiry batches.

use crate::{load_memory_full_tx, McStore, McStoreError, StoredMemoryFull};
use rusqlite::{params, Transaction};

#[cfg(test)]
#[path = "dream_verify_tests.rs"]
mod tests;

#[derive(Debug, Clone)]
pub struct VerifyMemory {
    pub memory: StoredMemoryFull,
    pub revision: i64,
    pub files: Vec<String>,
    pub verified_at: i64,
    pub verified_commit: Option<String>,
    pub decided: bool,
}

/// Project, session, harness and invocation identify a verification run. These
/// fields reproduce the verification applier's receipt keys so a resumed run can
/// omit already-decided memories before making another model call.
pub struct VerifyIdentity<'a> {
    pub project: &'a str,
    pub session: &'a str,
    pub harness: &'a str,
    pub invocation: &'a str,
}

impl VerifyIdentity<'_> {
    fn receipt_key(&self, id: i64) -> String {
        format!(
            "verify:{}:{id}",
            serde_json::json!([self.project, self.session, self.harness, self.invocation])
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub enum VerifyBatchKind {
    Verify,
    Expiry,
}

impl McStore {
    pub fn load_dream_verify(
        &self,
        identity: &VerifyIdentity<'_>,
    ) -> Result<Vec<VerifyMemory>, McStoreError> {
        self.context_read(|conn| {
            let ids = conn.prepare("SELECT id,revision FROM memories WHERE project_path=?1 AND status IN ('active','permanent') AND superseded_by_memory_id IS NULL ORDER BY category,updated_at DESC,id")?
                .query_map([identity.project], |row| Ok((row.get::<_, i64>(0)?,row.get::<_, i64>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.into_iter().map(|(id, revision)| {
                let memory = load_memory_full_tx(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                let mappings = conn.prepare("SELECT file_path,verified_at FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path")?
                    .query_map([id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let verified_at = mappings.iter().map(|(_, at)| *at).max().unwrap_or(0);
                let metadata = memory.metadata_json.as_deref().and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
                let verified_commit = metadata.as_ref().filter(|value| value["dreamerVerifiedAt"] == verified_at)
                    .and_then(|value| value["dreamerVerifiedCommit"].as_str())
                    .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .map(str::to_owned);
                let decided = conn.query_row("SELECT EXISTS(SELECT 1 FROM memory_decision_receipts WHERE decision_key=?1 AND project_path=?2)", params![identity.receipt_key(id), identity.project], |row| row.get(0))?;
                Ok(VerifyMemory {
                    memory, revision, verified_at, verified_commit, decided,
                    files: mappings.into_iter().filter_map(|(path, _)| (!path.is_empty()).then_some(path)).collect(),
                })
            }).collect()
        })
    }

    /// A memory's declared expiry time permits archiving without a surviving
    /// replacement, unlike curation, which must name a replacement memory. Use
    /// the existing automated archive action to record history without changing
    /// served prompts; retain undo, receipts and vector changes in this transaction.
    pub fn commit_dream_expiry(
        &self,
        project: &str,
        batch: &[VerifyMemory],
        now_ms: i64,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        mut enqueue: impl FnMut(&Transaction<'_>, &StoredMemoryFull) -> rusqlite::Result<()>,
    ) -> Result<usize, McStoreError> {
        if batch.len() > 100 {
            return Err(crate::single_store_domain::context_sql_error(
                rusqlite::Error::InvalidQuery,
            ));
        }
        self.commit_dream_verify(project, batch, VerifyBatchKind::Expiry, now_ms, check_commit_fence, |tx, accepted| {
            for row in accepted {
                let id = row.memory.id;
                let result = crate::with_automated_memory_mutation_tx(tx, |writer| writer.expire_memories(project, &[id], now_ms))
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error))))?;
                if result.accepted != [id] { return Err(rusqlite::Error::InvalidQuery); }
                // The shared automated writer already records the versioned undo
                // decision and journal. Add only the replay receipt and queue effect.
                let key = format!("expire:{id}:{}", row.revision);
                let receipt = serde_json::json!({"state":"applied","reason":"expired","memoryId":id,"adoptionClass":"deferred"}).to_string();
                tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,?2,?3,?4)", params![key, project, receipt, now_ms])?;
                let memory = load_memory_full_tx(tx, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                enqueue(tx, &memory)?;
            }
            Ok(accepted.len())
        })
    }

    /// The applier and embedding callback must use only this transaction. No
    /// model calls or nested public store writers may run inside the callback.
    /// Invalidated prompt rows are excluded before even a refusal receipt lands.
    pub fn commit_dream_verify<T>(
        &self,
        project: &str,
        batch: &[VerifyMemory],
        kind: VerifyBatchKind,
        now_ms: i64,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        apply: impl FnOnce(&Transaction<'_>, &[VerifyMemory]) -> rusqlite::Result<T>,
    ) -> Result<T, McStoreError> {
        self.context_write(
            &[
                "memories",
                "memory_verifications",
                "memory_embeddings",
                "memory_history",
                "memory_journal",
                "memory_decision_receipts",
            ],
            |tx| {
                check_commit_fence(tx)?;
                if !crate::memory_lifecycle::authority::module_owns_memory(tx, project)? {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let mut current = Vec::new();
                for original in batch {
                    let Some(memory) = load_memory_full_tx(tx, original.memory.id)? else {
                        continue;
                    };
                    let revision: i64 = tx.query_row(
                        "SELECT revision FROM memories WHERE id=?1",
                        [memory.id],
                        |row| row.get(0),
                    )?;
                    if memory.project_path != project
                        || !matches!(memory.status.as_str(), "active" | "permanent")
                        || memory.superseded_by_memory_id.is_some()
                        || revision != original.revision
                        || memory.normalized_hash != original.memory.normalized_hash
                    {
                        continue;
                    }
                    let expired = memory.expires_at.is_some_and(|at| at <= now_ms);
                    if match kind {
                        VerifyBatchKind::Verify => expired,
                        VerifyBatchKind::Expiry => !expired || memory.status != "active",
                    } {
                        continue;
                    }
                    current.push(original.clone());
                }
                apply(tx, &current)
            },
        )
    }
}
