//! One bounded backfill lease per project, stored in existing registration provenance.
//! No provider call runs while a SQLite transaction is held.

use super::store::{self, ChunkCatalog, Kind, Passage};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_BATCH: usize = store::MAX_SELECTION;
pub const MAX_LEASE_MS: i64 = 60_000;
const STATE_KEY: &str = "_magicContextVectorDrain";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub project: String,
    /// Provider identity fingerprint stored as `model_id` in memory/commit vector
    /// rows. This identifies embedding settings, not just a model's display name.
    pub model_id: String,
    /// Identity of the provider plus raw transcript formatting/window-splitting
    /// settings, stored as `model_id` in chunk vector rows.
    pub chunk_model_id: String,
    pub fingerprint: String,
    pub table_epoch: i64,
    pub dimensions: usize,
    pub generation: i64,
}

impl Registration {
    pub fn model(&self, kind: Kind) -> &str {
        if kind == Kind::Chunk {
            &self.chunk_model_id
        } else {
            &self.model_id
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Progress {
    pub next_kind: usize,
    pub batches: u64,
    pub accepted: u64,
    pub discarded: u64,
    pub failures: u64,
    pub lease_until_ms: i64,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    registration: Registration,
    passages: Vec<Passage>,
    kind: Kind,
    claimed_json: String,
    progress: Progress,
}

impl Claim {
    /// Keep passage text/hashes and registration model/generation bound to the lease.
    /// Shared-reference access prevents relabeling an old provider batch as new work.
    pub fn registration(&self) -> &Registration {
        &self.registration
    }
    pub fn passages(&self) -> &[Passage] {
        &self.passages
    }
    pub fn kind(&self) -> Kind {
        self.kind
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    Claimed(Box<Claim>),
    Busy,
    Drained,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishOutcome {
    Published { accepted: usize, discarded: usize },
    Superseded,
}

pub trait EmbeddingProvider {
    /// Return one vector per passage, in input order. Transport and cancellation are
    /// the adapter's responsibility; this store never makes a network request.
    fn embed(
        &mut self,
        registration: &Registration,
        passages: &[Passage],
    ) -> Result<Vec<Vec<f32>>, String>;
}

#[derive(Debug)]
pub enum DrainError {
    Sql(rusqlite::Error),
    Provider(String),
    InvalidVectors,
}
impl From<rusqlite::Error> for DrainError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}
impl std::fmt::Display for DrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(error) => write!(f, "vector store: {error}"),
            Self::Provider(error) => write!(f, "embedding provider: {error}"),
            Self::InvalidVectors => write!(f, "provider returned invalid vectors"),
        }
    }
}
impl std::error::Error for DrainError {}

fn parse(json: &str) -> rusqlite::Result<(Map<String, Value>, Progress)> {
    let object: Map<String, Value> =
        serde_json::from_str(json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let progress = object
        .get(STATE_KEY)
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .unwrap_or_default();
    Ok((object, progress))
}

fn encode_state(mut object: Map<String, Value>, progress: &Progress) -> String {
    object.insert(STATE_KEY.into(), serde_json::to_value(progress).unwrap());
    serde_json::to_string(&object).unwrap()
}

fn registered_json(db: &Connection, r: &Registration) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "SELECT provenance_json FROM embedding_registrations WHERE project_path=?1
         AND model_id=?2 AND chunk_model_id=?3 AND fingerprint=?4 AND table_epoch=?5
         AND dims=?6 AND generation=?7",
        params![
            r.project,
            r.model_id,
            r.chunk_model_id,
            r.fingerprint,
            r.table_epoch,
            r.dimensions as i64,
            r.generation
        ],
        |row| row.get(0),
    )
    .optional()
}

pub fn progress(
    db: &Connection,
    registration: &Registration,
) -> rusqlite::Result<Option<Progress>> {
    registered_json(db, registration)?
        .map(|json| parse(&json).map(|(_, progress)| progress))
        .transpose()
}

/// Missing vectors are the durable cursor. A crashed batch is retried after its
/// lease expires; completed rows are never skipped by advancing a numeric offset.
pub fn claim(
    db: &mut Connection,
    chunks: &dyn ChunkCatalog,
    registration: &Registration,
    limit: usize,
    now_ms: i64,
    lease_ms: i64,
) -> rusqlite::Result<ClaimOutcome> {
    if limit == 0
        || limit > MAX_BATCH
        || !(1..=MAX_LEASE_MS).contains(&lease_ms)
        || registration.dimensions == 0
        || registration.generation < 0
        || registration.model_id.is_empty()
        || registration.chunk_model_id.is_empty()
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(json) = registered_json(&tx, registration)? else {
        return Ok(ClaimOutcome::Superseded);
    };
    let (object, mut state) = parse(&json)?;
    if state.lease_until_ms > now_ms {
        return Ok(ClaimOutcome::Busy);
    }
    for offset in 0..3 {
        let index = (state.next_kind % 3 + offset) % 3;
        let kind = Kind::ALL[index];
        let passages = store::pending(
            &tx,
            chunks,
            &registration.project,
            kind,
            registration.model(kind),
            limit,
        )?;
        if passages.is_empty() {
            continue;
        }
        state.next_kind = (index + 1) % 3;
        state.lease_until_ms = now_ms
            .checked_add(lease_ms)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        // A random token distinguishes a new claim even if a registration refresh resets JSON.
        state.token = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        let claimed_json = encode_state(object, &state);
        let changed = tx.execute(
            "UPDATE embedding_registrations SET provenance_json=?1,updated_at=?2
             WHERE project_path=?3 AND provenance_json=?4",
            params![claimed_json, now_ms, registration.project, json],
        )?;
        if changed != 1 {
            return Ok(ClaimOutcome::Superseded);
        }
        tx.commit()?;
        return Ok(ClaimOutcome::Claimed(Box::new(Claim {
            registration: registration.clone(),
            passages,
            kind,
            claimed_json,
            progress: state,
        })));
    }
    tx.commit()?;
    Ok(ClaimOutcome::Drained)
}

/// Both generation/model validation and JSON CAS occur in the immediate transaction
/// containing vector writes. A timed-out or superseded claim cannot write any rows.
pub fn finish(
    db: &mut Connection,
    chunks: &dyn ChunkCatalog,
    claim: &Claim,
    vectors: &[Vec<f32>],
    now_ms: i64,
) -> Result<FinishOutcome, DrainError> {
    if vectors.len() != claim.passages.len()
        || vectors
            .iter()
            .any(|v| v.len() != claim.registration.dimensions || v.iter().any(|x| !x.is_finite()))
    {
        return Err(DrainError::InvalidVectors);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if registered_json(&tx, &claim.registration)?.as_deref() != Some(&claim.claimed_json)
        || claim.progress.lease_until_ms <= now_ms
    {
        return Ok(FinishOutcome::Superseded);
    }
    let (object, mut state) = parse(&claim.claimed_json)?;
    let mut accepted = 0;
    for (passage, values) in claim.passages.iter().zip(vectors) {
        accepted += usize::from(store::save_if_current(
            &tx,
            chunks,
            passage,
            claim.registration.model(claim.kind),
            values,
            now_ms,
        )?);
    }
    let discarded = claim.passages.len() - accepted;
    state.batches = state.batches.saturating_add(1);
    state.accepted = state.accepted.saturating_add(accepted as u64);
    state.discarded = state.discarded.saturating_add(discarded as u64);
    state.lease_until_ms = 0;
    state.token.clear();
    tx.execute(
        "UPDATE embedding_registrations SET provenance_json=?1,updated_at=?2
         WHERE project_path=?3 AND provenance_json=?4",
        params![
            encode_state(object, &state),
            now_ms,
            claim.registration.project,
            claim.claimed_json
        ],
    )?;
    tx.commit()?;
    Ok(FinishOutcome::Published {
        accepted,
        discarded,
    })
}

pub fn fail(db: &mut Connection, claim: &Claim, now_ms: i64) -> rusqlite::Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if registered_json(&tx, &claim.registration)?.as_deref() != Some(&claim.claimed_json)
        || claim.progress.lease_until_ms <= now_ms
    {
        return Ok(false);
    }
    let (object, mut state) = parse(&claim.claimed_json)?;
    state.failures = state.failures.saturating_add(1);
    state.lease_until_ms = 0;
    state.token.clear();
    tx.execute(
        "UPDATE embedding_registrations SET provenance_json=?1,updated_at=?2
         WHERE project_path=?3 AND provenance_json=?4",
        params![
            encode_state(object, &state),
            now_ms,
            claim.registration.project,
            claim.claimed_json
        ],
    )?;
    tx.commit()?;
    Ok(true)
}

/// At most one provider batch per call, with round-robin fairness even on failures.
pub fn drain_once(
    db: &mut Connection,
    chunks: &dyn ChunkCatalog,
    provider: &mut dyn EmbeddingProvider,
    registration: &Registration,
    limit: usize,
    now_ms: i64,
    completed_at: impl FnOnce() -> i64,
) -> Result<Option<FinishOutcome>, DrainError> {
    let ClaimOutcome::Claimed(claim) =
        claim(db, chunks, registration, limit, now_ms, MAX_LEASE_MS)?
    else {
        return Ok(None);
    };
    match provider.embed(registration, &claim.passages) {
        Ok(vectors) => {
            let end = completed_at();
            match finish(db, chunks, &claim, &vectors, end) {
                Err(DrainError::InvalidVectors) => {
                    fail(db, &claim, end)?;
                    Err(DrainError::InvalidVectors)
                }
                result => result,
            }
            .map(Some)
        }
        Err(error) => {
            fail(db, &claim, completed_at())?;
            Err(DrainError::Provider(error))
        }
    }
}
