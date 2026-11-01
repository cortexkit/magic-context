//! Atomic background learning, profile review, and content-window checkpoints.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{McStore, McStoreError};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RetrospectiveState {
    pub watermark_ms: i64,
    pub task_state_json: Option<String>,
}

#[derive(Debug)]
pub struct RetrospectiveSnapshot {
    pub state: RetrospectiveState,
    pub processed_windows: HashSet<String>,
}

pub struct Observation {
    pub content: String,
    pub session_id: String,
}

pub struct RetrospectiveCommit<'a> {
    pub project: &'a str,
    pub expected: &'a RetrospectiveState,
    pub watermark_ms: i64,
    pub window_key: Option<&'a str>,
    pub task_state_json: Option<&'a str>,
    pub now_ms: i64,
    pub observations: &'a [Observation],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserCandidate {
    pub id: i64,
    pub content: String,
    pub session_id: String,
    pub created_at: i64,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserProfile {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub promoted_at: i64,
    pub source_candidate_ids: String,
    pub source_candidate_provenance: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSnapshot {
    pub candidates: Vec<UserCandidate>,
    pub profiles: Vec<UserProfile>,
    pub task_state_json: Option<String>,
}

pub struct UserPromotion {
    pub content: String,
    pub candidate_ids: Vec<i64>,
}

pub struct ReviewCommit<'a> {
    pub expected: &'a ReviewSnapshot,
    pub decision_key: &'a str,
    pub now_ms: i64,
    pub promotions: &'a [UserPromotion],
    pub updates: &'a [(i64, String)],
    pub dismissals: &'a [i64],
    pub consume_candidate_ids: &'a [i64],
}

fn state(conn: &Connection, project: &str) -> rusqlite::Result<RetrospectiveState> {
    conn.query_row(
        "SELECT COALESCE(retrospective_watermark_ms,0),last_checked_commit FROM task_schedule_state WHERE project_path=?1 AND task='retrospective'",
        [project], |r| Ok(RetrospectiveState { watermark_ms: r.get(0)?, task_state_json: r.get(1)? }),
    ).optional().map(Option::unwrap_or_default)
}

fn candidates(conn: &Connection) -> rusqlite::Result<Vec<UserCandidate>> {
    conn.prepare("SELECT id,content,session_id,created_at,source_compartment_start,source_compartment_end FROM user_memory_candidates ORDER BY created_at,id")?
        .query_map([], |r| Ok(UserCandidate { id: r.get(0)?, content: r.get(1)?, session_id: r.get(2)?, created_at: r.get(3)?, source_compartment_start: r.get(4)?, source_compartment_end: r.get(5)? }))?
        .collect()
}

fn profiles(conn: &Connection) -> rusqlite::Result<Vec<UserProfile>> {
    conn.prepare("SELECT id,content,status,promoted_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at FROM user_memories ORDER BY promoted_at,id")?
        .query_map([], |r| Ok(UserProfile { id: r.get(0)?, content: r.get(1)?, status: r.get(2)?, promoted_at: r.get(3)?, source_candidate_ids: r.get(4)?, source_candidate_provenance: r.get(5)?, created_at: r.get(6)?, updated_at: r.get(7)? }))?
        .collect()
}

fn review_snapshot(conn: &Connection) -> rusqlite::Result<ReviewSnapshot> {
    Ok(ReviewSnapshot {
        candidates: candidates(conn)?, profiles: profiles(conn)?,
        task_state_json: conn.query_row("SELECT last_checked_commit FROM task_schedule_state WHERE project_path='__global__' AND task='review-user-memories'", [], |r| r.get(0)).optional()?.flatten(),
    })
}

fn encode(value: &impl Serialize) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

impl McStore {
    pub fn load_dream_retrospective(
        &self,
        project: &str,
    ) -> Result<RetrospectiveSnapshot, McStoreError> {
        self.context_read(|conn| Ok(RetrospectiveSnapshot {
            state: state(conn, project)?,
            processed_windows: conn.prepare("SELECT window_key FROM retrospective_processed_windows WHERE project_path=?1")?
                .query_map([project], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
        }))
    }

    /// `apply_memories` invokes the audited memory actions on this transaction.
    /// It must propagate refusals and errors, never open a nested store writer.
    /// The context checkpoint is authoritative; scheduler timing lives separately.
    pub fn commit_dream_retrospective(
        &self,
        batch: &RetrospectiveCommit<'_>,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        apply_memories: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<bool, McStoreError> {
        self.context_write(&[
            "memories", "memory_history", "memory_decision_receipts", "memory_journal",
            "memory_embeddings", "user_memory_candidates", "retrospective_processed_windows", "task_schedule_state",
        ], |tx| {
            check_commit_fence(tx)?;
            let current = state(tx, batch.project)?;
            if current != *batch.expected || batch.watermark_ms <= current.watermark_ms {
                return Ok(false);
            }
            if let Some(key) = batch.window_key {
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM retrospective_processed_windows WHERE project_path=?1 AND window_key=?2)", params![batch.project,key], |r| r.get::<_,bool>(0))? {
                    return Ok(false);
                }
            }
            apply_memories(tx)?;
            for row in batch.observations {
                tx.execute("INSERT INTO user_memory_candidates(content,session_id,created_at,source_compartment_start,source_compartment_end) VALUES(?1,?2,?3,NULL,NULL)", params![row.content,row.session_id,batch.now_ms])?;
            }
            if let Some(key) = batch.window_key {
                tx.execute("INSERT INTO retrospective_processed_windows(project_path,window_key,processed_at) VALUES(?1,?2,?3)", params![batch.project,key,batch.now_ms])?;
            }
            // Effects and their input frontier are inseparable, including when the
            // final checkpoint statement fails after earlier effects succeeded.
            tx.execute("INSERT INTO task_schedule_state(project_path,task,retrospective_watermark_ms,last_checked_commit) VALUES(?1,'retrospective',?2,?3) ON CONFLICT(project_path,task) DO UPDATE SET retrospective_watermark_ms=excluded.retrospective_watermark_ms,last_checked_commit=excluded.last_checked_commit", params![batch.project,batch.watermark_ms,batch.task_state_json.or(current.task_state_json.as_deref())])?;
            Ok(true)
        })
    }

    pub fn load_dream_user_review(&self) -> Result<ReviewSnapshot, McStoreError> {
        self.context_read(review_snapshot)
    }

    /// Expired observations are removed before model execution, even if the
    /// subsequent model request fails. Snapshot validation prevents stale pruning.
    pub fn prune_dream_user_candidates(
        &self,
        expected: &[UserCandidate],
        cutoff_ms: i64,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<usize, McStoreError> {
        self.context_write(&["user_memory_candidates"], |tx| {
            check_commit_fence(tx)?;
            if candidates(tx)? != expected {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "DELETE FROM user_memory_candidates WHERE created_at < ?1",
                [cutoff_ms],
            )
        })
    }

    pub fn commit_dream_user_review(
        &self,
        batch: &ReviewCommit<'_>,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<bool, McStoreError> {
        self.context_write(&["user_memory_candidates", "user_memories", "memory_journal", "project_state", "task_schedule_state"], |tx| {
            check_commit_fence(tx)?;
            let already: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_journal WHERE decision_key=?1)", [batch.decision_key], |r| r.get(0))?;
            if already || review_snapshot(tx)? != *batch.expected { return Ok(false); }
            // As the TypeScript reviewer: an id the answer names but the pool does
            // not hold is kept in source_candidate_ids, contributes no provenance
            // and deletes nothing. Refusing it would fail every retry of a review
            // the TypeScript dreamer commits.
            for promotion in batch.promotions {
                let mut sources: Vec<_> = batch.expected.candidates.iter().filter(|c| promotion.candidate_ids.contains(&c.id)).collect();
                sources.sort_by_key(|c| c.id);
                // A struct keeps the TypeScript key order (json! sorts keys).
                #[derive(Serialize)]
                struct Provenance<'a> { candidate_id: i64, session_id: &'a str, source_compartment_start: Option<i64>, source_compartment_end: Option<i64> }
                let provenance: Vec<_> = sources.iter().map(|c| Provenance { candidate_id: c.id, session_id: &c.session_id, source_compartment_start: c.source_compartment_start, source_compartment_end: c.source_compartment_end }).collect();
                // TypeScript stores null when ids were named but none exists.
                let provenance = if provenance.is_empty() && !promotion.candidate_ids.is_empty() { None } else { Some(encode(&provenance)?) };
                tx.execute("INSERT INTO user_memories(content,status,promoted_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at) VALUES(?1,'active',?2,?3,?4,?2,?2)", params![promotion.content,batch.now_ms,encode(&promotion.candidate_ids)?,provenance])?;
            }
            for (id, content) in batch.updates {
                tx.execute("UPDATE user_memories SET content=?2,updated_at=?3 WHERE id=?1", params![id,content,batch.now_ms])?;
            }
            for id in batch.dismissals {
                tx.execute("UPDATE user_memories SET status='dismissed',updated_at=?2 WHERE id=?1", params![id,batch.now_ms])?;
            }
            for id in batch.consume_candidate_ids {
                tx.execute("DELETE FROM user_memory_candidates WHERE id=?1", [id])?;
            }
            if !batch.promotions.is_empty() || !batch.updates.is_empty() || !batch.dismissals.is_empty() {
                tx.execute("INSERT INTO project_state(project_path,project_user_profile_version,updated_at) VALUES('__global__',1,?1) ON CONFLICT(project_path) DO UPDATE SET project_user_profile_version=project_user_profile_version+1,updated_at=excluded.updated_at", [batch.now_ms])?;
            }
            let receipt = json!({"candidate_provenance":batch.expected.candidates,"consumed":batch.consume_candidate_ids});
            tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at,before_json,after_json) VALUES('__global__',?1,'user_profile_review',?2,?3,?4,?5)", params![batch.decision_key,encode(&receipt)?,batch.now_ms,encode(&batch.expected.profiles)?,encode(&profiles(tx)?)?])?;
            tx.execute("INSERT INTO task_schedule_state(project_path,task,last_checked_commit) VALUES('__global__','review-user-memories',?1) ON CONFLICT(project_path,task) DO UPDATE SET last_checked_commit=excluded.last_checked_commit", [encode(&json!({"reviewDecisionKey":batch.decision_key}))?])?;
            Ok(true)
        })
    }
}

#[cfg(test)]
#[path = "dream_retrospective_tests.rs"]
mod tests;
