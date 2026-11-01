//! Read and write the host's SQLite float32 vector rows without changing their schema.
//! Source text writers must delete old vectors in the same transaction as a text change,
//! because memory and commit vector rows do not persist the hash of their input text.

use crate::parity_schema_manifest::{
    CapabilityReason, CapabilityResult, EmbeddingIdentity, StoreScope,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_SELECTION: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Memory,
    Commit,
    Chunk,
}

impl Kind {
    pub const ALL: [Self; 3] = [Self::Memory, Self::Commit, Self::Chunk];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    Memory {
        id: i64,
    },
    Commit {
        sha: String,
    },
    Chunk {
        compartment_id: i64,
        window_index: i64,
    },
}

impl Source {
    pub fn kind(&self) -> Kind {
        match self {
            Self::Memory { .. } => Kind::Memory,
            Self::Commit { .. } => Kind::Commit,
            Self::Chunk { .. } => Kind::Chunk,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkSpan {
    pub session_id: String,
    pub harness: String,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
}

/// Text and hash must come from the same source snapshot. Chunk text is the canonical
/// raw window produced by the archive reader, not a summary or a provider-prefixed input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Passage {
    pub source: Source,
    pub project: String,
    pub text: String,
    pub content_hash: String,
    pub span: Option<ChunkSpan>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorRow {
    pub source: Source,
    pub model_id: String,
    pub values: Vec<f32>,
}

pub fn content_sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Bun's Float32Array blobs are native-endian on the supported little-endian hosts.
/// Explicit little-endian encoding also avoids alignment-dependent decoding.
pub fn encode(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

pub fn decode(bytes: &[u8], dimensions: usize) -> Option<Vec<f32>> {
    if dimensions == 0 || bytes.len() != dimensions.checked_mul(4)? {
        return None;
    }
    let values: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    values
        .iter()
        .all(|value| value.is_finite())
        .then_some(values)
}

/// Match JavaScript number arithmetic: f32 inputs, f64 products and accumulators.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0, 0.0, 0.0);
    for (&a, &b) in a.iter().zip(b) {
        let (a, b) = (f64::from(a), f64::from(b));
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a.sqrt() * norm_b.sqrt())
    }
}

/// The shared memory/commit vector schema has no input-hash column. Their text
/// writers must invalidate old vectors on text changes; this operation checks the
/// source's current hash against the embedded text to reject delayed provider replies.
/// Memory status is rechecked too: archiving leaves the hash unchanged but must
/// still prevent an in-flight reply from restoring a vector removed by the writer.
pub fn save_if_current(
    db: &Transaction<'_>,
    chunks: &dyn ChunkCatalog,
    passage: &Passage,
    model_id: &str,
    values: &[f32],
    now_ms: i64,
) -> rusqlite::Result<bool> {
    if model_id.is_empty() || values.is_empty() || values.iter().any(|v| !v.is_finite()) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let expected_hash = if passage.source.kind() == Kind::Memory {
        crate::compute_normalized_memory_hash(&passage.text)
    } else {
        content_sha256(&passage.text)
    };
    if expected_hash != passage.content_hash {
        return Ok(false);
    }
    let blob = encode(values);
    let changed = match &passage.source {
        Source::Memory { id } => db.execute(
            "INSERT INTO memory_embeddings(memory_id,embedding,model_id)
             SELECT id,?1,?2 FROM memories WHERE id=?3 AND project_path=?4 AND normalized_hash=?5
             AND status IN ('active','permanent')
             ON CONFLICT(memory_id,model_id) DO UPDATE SET embedding=excluded.embedding",
            params![blob, model_id, id, passage.project, passage.content_hash],
        )?,
        Source::Commit { sha } => {
            let message: Option<String> = db
                .query_row(
                    "SELECT message FROM git_commits WHERE sha=?1 AND project_path=?2",
                    params![sha, passage.project],
                    |row| row.get(0),
                )
                .optional()?;
            if message.as_deref().map(content_sha256).as_deref() != Some(&passage.content_hash) {
                return Ok(false);
            }
            db.execute(
                "INSERT INTO git_commit_embeddings(sha,embedding,model_id,created_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(sha,model_id) DO UPDATE SET embedding=excluded.embedding,created_at=excluded.created_at",
                params![sha, blob, model_id, now_ms],
            )?
        }
        Source::Chunk {
            compartment_id,
            window_index,
        } => {
            if !chunks.current(db, passage)? {
                return Ok(false);
            }
            let span = passage.span.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
            if *window_index < 0
                || span.end_ordinal < span.start_ordinal
                || content_sha256(&passage.text) != passage.content_hash
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            db.execute(
                "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,
                   window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                 SELECT c.id,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 FROM compartments c
                 JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
                 WHERE c.id=?12 AND sp.project_path=?2 AND c.session_id=?1 AND c.harness=?3
                 ON CONFLICT(compartment_id,model_id,window_index) DO UPDATE SET
                   session_id=excluded.session_id,project_path=excluded.project_path,harness=excluded.harness,
                   start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,
                   chunk_hash=excluded.chunk_hash,dims=excluded.dims,vector=excluded.vector,created_at=excluded.created_at",
                params![span.session_id, passage.project, span.harness, window_index, span.start_ordinal,
                    span.end_ordinal, passage.content_hash, model_id, values.len() as i64, blob, now_ms, compartment_id],
            )?
        }
    };
    Ok(changed > 0)
}

/// Supply raw transcript windows whose text has already been formatted and split
/// by the archive reader. `current` must compare a window's hash, ordinal range and
/// project/session/harness against current archive data. It must use the supplied
/// connection so a source edit cannot slip between validation and publication.
pub trait ChunkCatalog {
    /// Return at most `limit` missing/stale raw transcript windows. When text changes
    /// how it is split into windows, the text writer must delete all vector rows for
    /// that compartment (the transcript span), including obsolete window indexes.
    fn pending(
        &self,
        db: &Connection,
        project: &str,
        model_id: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<Passage>>;
    fn current(&self, db: &Connection, passage: &Passage) -> rusqlite::Result<bool>;
}

/// Rust backfill includes permanent memories as well as active ones. TypeScript's
/// primary backfill selects active rows only (project-embedding-registry.ts at
/// 282d9c08bce4); its per-write attempt usually embeds permanent rows. This is a
/// deliberate superset: permanent memories are live retrieval inputs too, and
/// selection only fills missing vectors without removing any existing vector.
pub fn pending(
    db: &Connection,
    chunks: &dyn ChunkCatalog,
    project: &str,
    kind: Kind,
    model_id: &str,
    limit: usize,
) -> rusqlite::Result<Vec<Passage>> {
    if limit > MAX_SELECTION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if limit == 0 {
        return Ok(Vec::new());
    }
    match kind {
        Kind::Memory => db
            .prepare(
                "SELECT id,content,normalized_hash FROM memories m WHERE project_path=?1
             AND status IN ('active','permanent') AND NOT EXISTS
             (SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id AND e.model_id=?2)
             ORDER BY id ASC LIMIT ?3",
            )?
            .query_map(params![project, model_id, limit as i64], |row| {
                Ok(Passage {
                    source: Source::Memory { id: row.get(0)? },
                    project: project.into(),
                    text: row.get(1)?,
                    content_hash: row.get(2)?,
                    span: None,
                })
            })?
            .collect(),
        Kind::Commit => db
            .prepare(
                "SELECT sha,message FROM git_commits c WHERE project_path=?1 AND NOT EXISTS
             (SELECT 1 FROM git_commit_embeddings e WHERE e.sha=c.sha AND e.model_id=?2)
             ORDER BY committed_at DESC,sha ASC LIMIT ?3",
            )?
            .query_map(params![project, model_id, limit as i64], |row| {
                let text: String = row.get(1)?;
                Ok(Passage {
                    source: Source::Commit { sha: row.get(0)? },
                    project: project.into(),
                    content_hash: content_sha256(&text),
                    text,
                    span: None,
                })
            })?
            .collect(),
        Kind::Chunk => {
            let rows = chunks.pending(db, project, model_id, limit)?;
            if rows.len() > limit
                || rows
                    .iter()
                    .any(|row| row.project != project || row.source.kind() != Kind::Chunk)
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(rows)
        }
    }
}

/// Load only vectors for the requested project and stored model identity. Reject
/// corrupt or mismatched widths. The retrieval caller must still apply memory
/// status/access policy; this loader does not decide whether an archived row is visible.
pub fn load(
    db: &Connection,
    chunks: &dyn ChunkCatalog,
    project: &str,
    kind: Kind,
    model_id: &str,
    dimensions: usize,
) -> rusqlite::Result<Vec<VectorRow>> {
    let mut out = Vec::new();
    match kind {
        Kind::Memory | Kind::Commit => {
            let sql = if kind == Kind::Memory {
                "SELECT e.memory_id,e.embedding FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
                 WHERE m.project_path=?1 AND e.model_id=?2 ORDER BY e.memory_id ASC"
            } else {
                "SELECT e.sha,e.embedding FROM git_commit_embeddings e JOIN git_commits c ON c.sha=e.sha
                 WHERE c.project_path=?1 AND e.model_id=?2 ORDER BY e.sha ASC"
            };
            let mut statement = db.prepare(sql)?;
            let rows = statement.query_map(params![project, model_id], |row| {
                let source = if kind == Kind::Memory {
                    Source::Memory { id: row.get(0)? }
                } else {
                    Source::Commit { sha: row.get(0)? }
                };
                Ok((source, row.get::<_, Vec<u8>>(1)?))
            })?;
            for row in rows {
                let (source, bytes) = row?;
                if let Some(values) = decode(&bytes, dimensions) {
                    out.push(VectorRow {
                        source,
                        model_id: model_id.into(),
                        values,
                    });
                }
            }
        }
        Kind::Chunk => {
            let mut statement = db.prepare(
                "SELECT e.compartment_id,e.window_index,e.session_id,e.harness,e.start_ordinal,
                        e.end_ordinal,e.chunk_hash,e.dims,e.vector
                 FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id
                 JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
                 WHERE e.project_path=?1 AND sp.project_path=?1 AND e.session_id=c.session_id
                   AND e.harness=c.harness AND e.model_id=?2 ORDER BY e.compartment_id ASC,e.window_index ASC",
            )?;
            let rows = statement.query_map(params![project, model_id], |row| {
                Ok((
                    Passage {
                        source: Source::Chunk {
                            compartment_id: row.get(0)?,
                            window_index: row.get(1)?,
                        },
                        project: project.into(),
                        text: String::new(),
                        content_hash: row.get(6)?,
                        span: Some(ChunkSpan {
                            session_id: row.get(2)?,
                            harness: row.get(3)?,
                            start_ordinal: row.get(4)?,
                            end_ordinal: row.get(5)?,
                        }),
                    },
                    row.get::<_, i64>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                ))
            })?;
            for row in rows {
                let (passage, dims, bytes) = row?;
                if dims == dimensions as i64 && chunks.current(db, &passage)? {
                    if let Some(values) = decode(&bytes, dimensions) {
                        out.push(VectorRow {
                            source: passage.source,
                            model_id: model_id.into(),
                            values,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Call in the same transaction that changes or deletes source text. Delete vectors
/// for every model, including experimental alternatives. A status-only change to
/// `archived` does not change text and need not delete vectors, matching the host writer.
pub fn invalidate(db: &Connection, source: &Source) -> rusqlite::Result<usize> {
    match source {
        Source::Memory { id } => {
            db.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", [id])
        }
        Source::Commit { sha } => {
            db.execute("DELETE FROM git_commit_embeddings WHERE sha=?1", [sha])
        }
        Source::Chunk { compartment_id, .. } => db.execute(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id=?1",
            [compartment_id],
        ),
    }
}

pub fn clear_model(
    db: &Connection,
    project: &str,
    kind: Kind,
    model_id: &str,
) -> rusqlite::Result<usize> {
    match kind {
        Kind::Memory => db.execute(
            "DELETE FROM memory_embeddings WHERE model_id=?1 AND memory_id IN
             (SELECT id FROM memories WHERE project_path=?2)",
            params![model_id, project],
        ),
        Kind::Commit => db.execute(
            "DELETE FROM git_commit_embeddings WHERE model_id=?1 AND sha IN
             (SELECT sha FROM git_commits WHERE project_path=?2)",
            params![model_id, project],
        ),
        Kind::Chunk => db.execute(
            "DELETE FROM compartment_chunk_embeddings WHERE model_id=?1 AND project_path=?2",
            params![model_id, project],
        ),
    }
}

/// Replace all windows for one transcript compartment/model together, deleting
/// obsolete windows when the new text splits differently. Supply the complete set
/// here, not just one partial embedding-provider response.
pub fn replace_chunks_if_current(
    db: &Transaction<'_>,
    chunks: &dyn ChunkCatalog,
    passages: &[Passage],
    model_id: &str,
    vectors: &[Vec<f32>],
    now_ms: i64,
) -> rusqlite::Result<usize> {
    if model_id.is_empty() || passages.is_empty() || passages.len() != vectors.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let Source::Chunk { compartment_id, .. } = passages[0].source else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    let mut windows = std::collections::BTreeSet::new();
    for (passage, vector) in passages.iter().zip(vectors) {
        let Source::Chunk {
            compartment_id: id,
            window_index,
        } = passage.source
        else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        if id != compartment_id
            || passage.project != passages[0].project
            || window_index < 0
            || !windows.insert(window_index)
            || vector.is_empty()
            || vector.len() != vectors[0].len()
            || vector.iter().any(|x| !x.is_finite())
            || passage
                .span
                .as_ref()
                .is_none_or(|span| span.end_ordinal < span.start_ordinal)
            || content_sha256(&passage.text) != passage.content_hash
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if !chunks.current(db, passage)? {
            return Ok(0);
        }
    }
    db.execute(
        "DELETE FROM compartment_chunk_embeddings WHERE compartment_id=?1 AND model_id=?2",
        params![compartment_id, model_id],
    )?;
    let mut accepted = 0;
    for (passage, vector) in passages.iter().zip(vectors) {
        if !save_if_current(db, chunks, passage, model_id, vector, now_ms)? {
            return Err(rusqlite::Error::InvalidQuery);
        }
        accepted += 1;
    }
    Ok(accepted)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCoverage {
    pub embedded: i64,
    pub total: i64,
}

/// Count only memories with `status='active'`, and the subset with this model's
/// vector. The host's `/ctx-embed` status excludes permanent and archived rows too.
pub fn memory_coverage(
    db: &Connection,
    project: &str,
    model_id: &str,
) -> rusqlite::Result<MemoryCoverage> {
    db.query_row(
        "SELECT count(*),coalesce(sum(CASE WHEN EXISTS
           (SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id AND e.model_id=?1)
           THEN 1 ELSE 0 END),0) FROM memories m WHERE m.project_path=?2 AND m.status='active'",
        params![model_id, project],
        |row| {
            Ok(MemoryCoverage {
                total: row.get(0)?,
                embedded: row.get(1)?,
            })
        },
    )
}

/// Certified correspondence between a complete query identity and persisted passage
/// model keys. The integration layer must certify compatibility before constructing
/// this value: the shared SQLite vector tables do not store every identity field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertifiedModelKeys {
    pub identity: EmbeddingIdentity,
    pub memory_model_key: String,
    pub chunk_model_key: String,
}

/// Authorization and project aliases resolved once for a read transaction. Only
/// memory projects/IDs may include workspace sources; compartment aliases must
/// identify the caller's own project, session and harness.
#[derive(Debug, Clone)]
pub struct ResolvedVectorScope {
    pub scope: StoreScope,
    pub authorized_memory_ids: BTreeSet<i64>,
    pub memory_projects: BTreeSet<String>,
    pub compartment_projects: BTreeSet<String>,
    pub session_id: String,
    pub harness: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VectorDateBounds {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompartmentChunkVector {
    pub compartment_id: i64,
    pub session_id: String,
    pub project_path: String,
    pub title: String,
    /// Whole-compartment bounds, not this embedding window's bounds.
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub first_message_time_ms: Option<i64>,
    pub last_message_time_ms: Option<i64>,
    pub window_index: i64,
    pub window_start_ordinal: i64,
    pub window_end_ordinal: i64,
    pub model_id: String,
    pub identity: EmbeddingIdentity,
    pub values: Vec<f32>,
}

/// Both search reads borrow the same transaction, authorization snapshot and certified
/// model mapping. Neither method performs retrieval scoring or broadens authorization.
pub struct VectorReadSnapshot<'a, 'connection> {
    db: &'a Transaction<'connection>,
    chunks: &'a dyn ChunkCatalog,
    resolved: &'a ResolvedVectorScope,
    certified: Option<&'a CertifiedModelKeys>,
}

impl<'a, 'connection> VectorReadSnapshot<'a, 'connection> {
    pub fn new(
        db: &'a Transaction<'connection>,
        chunks: &'a dyn ChunkCatalog,
        resolved: &'a ResolvedVectorScope,
        certified: Option<&'a CertifiedModelKeys>,
    ) -> Self {
        Self {
            db,
            chunks,
            resolved,
            certified,
        }
    }

    fn model_key(
        &self,
        scope: &StoreScope,
        identity: &EmbeddingIdentity,
        kind: Kind,
    ) -> Result<&str, CapabilityReason> {
        if scope != &self.resolved.scope {
            return Err(vector_reason(
                "vector_scope_mismatch",
                "The vector read scope differs from the authenticated snapshot",
            ));
        }
        let Some(certified) = self.certified else {
            return Err(vector_reason(
                "vector_identity_unavailable",
                "No certified identity-to-model-key mapping is installed",
            ));
        };
        if identity != &certified.identity || identity.dimensions == 0 {
            return Err(vector_reason(
                "vector_identity_unsupported",
                "The complete vector identity is not certified for this snapshot",
            ));
        }
        let key = if kind == Kind::Chunk {
            &certified.chunk_model_key
        } else {
            &certified.memory_model_key
        };
        if key.is_empty() {
            return Err(vector_reason(
                "vector_identity_unavailable",
                "No persisted model key is certified for this vector corpus",
            ));
        }
        Ok(key)
    }

    /// Return vectors keyed by authorized numeric memory IDs. A missing mapping or
    /// failed SQL read is unavailable, not an available empty vector corpus.
    pub fn read_memory_vectors(
        &self,
        scope: &StoreScope,
        memory_ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<BTreeMap<i64, Vec<f32>>> {
        let model_key = match self.model_key(scope, identity, Kind::Memory) {
            Ok(key) => key,
            Err(reason) => return CapabilityResult::Unavailable { reason },
        };
        if memory_ids
            .iter()
            .any(|id| !self.resolved.authorized_memory_ids.contains(id))
        {
            return CapabilityResult::Unavailable {
                reason: vector_reason(
                    "vector_memory_unauthorized",
                    "Requested memory IDs are outside the authorized snapshot",
                ),
            };
        }
        let read = || -> rusqlite::Result<(BTreeMap<i64, Vec<f32>>, usize)> {
            let mut statement = self.db.prepare(
                "SELECT e.memory_id,e.embedding FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
                 WHERE m.project_path IN (SELECT value FROM json_each(?1))
                   AND e.memory_id IN (SELECT value FROM json_each(?2)) AND e.model_id=?3
                 ORDER BY e.memory_id ASC",
            )?;
            let rows = statement.query_map(
                params![
                    serde_json::to_string(&self.resolved.memory_projects).unwrap(),
                    serde_json::to_string(memory_ids).unwrap(),
                    model_key
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )?;
            let (mut values, mut invalid) = (BTreeMap::new(), 0);
            for row in rows {
                let (id, blob) = row?;
                if let Some(vector) = decode(&blob, identity.dimensions as usize) {
                    values.insert(id, vector);
                } else {
                    invalid += 1;
                }
            }
            Ok((values, invalid))
        };
        vector_read_result(read())
    }

    /// Join raw windows to current titles and whole-compartment bounds. Date bounds
    /// overlap the first/last message times; missing endpoints exclude dated reads.
    /// The session/harness and own-project aliases never expand to workspace history.
    pub fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        dates: Option<&VectorDateBounds>,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunkVector>> {
        let model_key = match self.model_key(scope, identity, Kind::Chunk) {
            Ok(key) => key,
            Err(reason) => return CapabilityResult::Unavailable { reason },
        };
        if dates.is_some_and(|bounds| bounds.from_ms > bounds.to_ms) {
            return CapabilityResult::Unavailable {
                reason: vector_reason(
                    "vector_date_bounds_invalid",
                    "Vector date bounds are reversed",
                ),
            };
        }
        let read = || -> rusqlite::Result<(Vec<CompartmentChunkVector>, usize)> {
            let mut statement = self.db.prepare(
                "SELECT e.compartment_id,e.session_id,e.project_path,c.title,c.start_message,c.end_message,
                        start_map.message_time_ms,end_map.message_time_ms,e.window_index,e.start_ordinal,
                        e.end_ordinal,e.model_id,e.dims,e.vector,e.chunk_hash
                 FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id
                 JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
                 LEFT JOIN message_fts_rowid_map start_map ON start_map.session_id=c.session_id
                   AND start_map.message_ordinal=c.start_message
                 LEFT JOIN message_fts_rowid_map end_map ON end_map.session_id=c.session_id
                   AND end_map.message_ordinal=c.end_message
                 WHERE e.session_id=?1 AND c.session_id=?1 AND e.harness=?2 AND c.harness=?2
                   AND e.project_path IN (SELECT value FROM json_each(?3))
                   AND sp.project_path IN (SELECT value FROM json_each(?3)) AND e.model_id=?4
                   AND (?5 IS NULL OR (start_map.message_time_ms<=?6 AND end_map.message_time_ms>=?5))
                 ORDER BY e.compartment_id ASC,e.window_index ASC",
            )?;
            let rows = statement.query_map(
                params![
                    self.resolved.session_id,
                    self.resolved.harness,
                    serde_json::to_string(&self.resolved.compartment_projects).unwrap(),
                    model_key,
                    dates.map(|bounds| bounds.from_ms),
                    dates.map(|bounds| bounds.to_ms)
                ],
                |row| {
                    let source = Passage {
                        source: Source::Chunk {
                            compartment_id: row.get(0)?,
                            window_index: row.get(8)?,
                        },
                        project: row.get(2)?,
                        text: String::new(),
                        content_hash: row.get(14)?,
                        span: Some(ChunkSpan {
                            session_id: row.get(1)?,
                            harness: self.resolved.harness.clone(),
                            start_ordinal: row.get(9)?,
                            end_ordinal: row.get(10)?,
                        }),
                    };
                    Ok((
                        CompartmentChunkVector {
                            compartment_id: row.get(0)?,
                            session_id: row.get(1)?,
                            project_path: row.get(2)?,
                            title: row.get(3)?,
                            start_ordinal: row.get(4)?,
                            end_ordinal: row.get(5)?,
                            first_message_time_ms: row.get(6)?,
                            last_message_time_ms: row.get(7)?,
                            window_index: row.get(8)?,
                            window_start_ordinal: row.get(9)?,
                            window_end_ordinal: row.get(10)?,
                            model_id: row.get(11)?,
                            identity: identity.clone(),
                            values: Vec::new(),
                        },
                        row.get::<_, i64>(12)?,
                        row.get::<_, Vec<u8>>(13)?,
                        source,
                    ))
                },
            )?;
            let (mut values, mut invalid) = (Vec::new(), 0);
            for row in rows {
                let (mut vector, dimensions, blob, passage) = row?;
                if !self.chunks.current(self.db, &passage)? {
                    continue;
                }
                if dimensions == i64::from(identity.dimensions) {
                    if let Some(decoded) = decode(&blob, identity.dimensions as usize) {
                        vector.values = decoded;
                        values.push(vector);
                        continue;
                    }
                }
                invalid += 1;
            }
            Ok((values, invalid))
        };
        vector_read_result(read())
    }
}

fn vector_reason(code: &str, message: &str) -> CapabilityReason {
    CapabilityReason {
        code: code.into(),
        message: message.into(),
    }
}

fn vector_read_result<T>(result: rusqlite::Result<(T, usize)>) -> CapabilityResult<T> {
    match result {
        Ok((value, 0)) => CapabilityResult::Available { value },
        Ok((value, invalid)) => CapabilityResult::Degraded {
            value,
            reason: vector_reason(
                "vector_rows_invalid",
                &format!("Ignored {invalid} vectors with invalid float32 data or dimensions"),
            ),
        },
        Err(error) => CapabilityResult::Unavailable {
            reason: vector_reason("vector_store_read_failed", &error.to_string()),
        },
    }
}
