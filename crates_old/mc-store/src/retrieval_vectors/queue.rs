//! Transactional memory embedding effects backed by the existing missing-vector set.
//! There is no separate queue table: removing stale vectors makes a live memory
//! retryable until the registered model has a vector for its current content.

use super::{
    drain::{self, DrainError, EmbeddingProvider, FinishOutcome, Registration},
    store::{self, ChunkCatalog, Source},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingEffectKind {
    Embed,
    Invalidate,
}

/// Same serialized fields and enum names as `mc_module::memory_actions::EmbeddingEffect`.
/// The module adapter supplies this record inside the source mutation transaction;
/// session and enqueue time describe the writer, not a second durable work cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingEffect {
    pub project_path: String,
    pub session_id: String,
    pub memory_id: i64,
    pub kind: EmbeddingEffectKind,
    pub content: Option<String>,
    pub content_hash: String,
    pub queued_at: i64,
}

/// Apply a memory writer's effect without committing or making a provider call.
/// All models are invalidated together with the source change. For live memories,
/// the missing vector is the durable pending state; an archive's invalidation is
/// complete here and must not cause the archived memory to be re-embedded.
pub fn enqueue_tx(tx: &Transaction<'_>, effect: &EmbeddingEffect) -> rusqlite::Result<()> {
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT content,normalized_hash FROM memories WHERE id=?1 AND project_path=?2",
            params![effect.memory_id, effect.project_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((content, hash)) = current else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    if hash != effect.content_hash
        || match effect.kind {
            EmbeddingEffectKind::Embed => {
                effect.content.as_deref() != Some(content.as_str())
                    || crate::compute_normalized_memory_hash(&content) != hash
            }
            EmbeddingEffectKind::Invalidate => effect.content.is_some(),
        }
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    store::invalidate(
        tx,
        &Source::Memory {
            id: effect.memory_id,
        },
    )?;
    Ok(())
}

/// Run one batch on a background thread when Rust background work is enabled.
/// The caller passes the setting it read when its background run started. False
/// skips selection, leasing, embedding and the end-time callback. Provider calls
/// run after the claim transaction commits; their end time bounds the lease.
#[allow(clippy::too_many_arguments)]
pub fn drain_once(
    activation: bool,
    db: &mut Connection,
    chunks: &dyn ChunkCatalog,
    provider: &mut dyn EmbeddingProvider,
    registration: &Registration,
    limit: usize,
    now_ms: i64,
    completed_at: impl FnOnce() -> i64,
) -> Result<Option<FinishOutcome>, DrainError> {
    if !activation {
        return Ok(None);
    }
    drain::drain_once(
        db,
        chunks,
        provider,
        registration,
        limit,
        now_ms,
        completed_at,
    )
}
