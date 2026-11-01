//! Project-scoped primer snapshots and atomic, non-publishing dream writes.

use crate::{McStore, McStoreError};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// JSON projections share the deterministic planner's camel-case wire contract.
/// The hash also covers persistence-only fields, including support and timestamps.
#[derive(Debug, Clone)]
pub struct PrimerSnapshot {
    pub project: String,
    pub candidates: Vec<Value>,
    pub primers: Vec<Value>,
    pub compartments: Vec<Value>,
    pub input_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorWrite {
    pub candidate_id: i64,
    pub vector: Vec<f32>,
    pub model_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportWrite {
    pub primer_id: Option<i64>,
    pub project_path: String,
    pub question: Option<String>,
    pub question_embedding: Option<Vec<f32>>,
    pub question_embedding_model_id: Option<String>,
    pub total_support: usize,
    pub last_observed_at: i64,
    pub source_candidate_ids: Vec<i64>,
    pub source_provenance: Option<Value>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionWrite {
    pub project_path: String,
    pub pruned_candidate_ids: Vec<i64>,
    pub embedding_updates: Vec<VectorWrite>,
    pub writes: Vec<SupportWrite>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerWrite {
    pub project_path: String,
    pub primer_id: i64,
    pub answer: String,
    pub answer_refreshed_at: i64,
    pub updated_at: i64,
}

impl PrimerSnapshot {
    /// Missing or wrong-model vectors are the durable queue; no separate queue
    /// row can outlive its source. Failed requests remain pending on the next scan.
    pub fn pending_vectors(&self, model: &str) -> (Vec<i64>, Vec<i64>) {
        let pending = |rows: &[Value]| {
            rows.iter()
                .filter(|row| {
                    row["questionEmbedding"].is_null()
                        || row["questionEmbeddingModelId"].as_str() != Some(model)
                })
                .filter_map(|row| row["id"].as_i64())
                .collect()
        };
        (pending(&self.candidates), pending(&self.primers))
    }
}

impl McStore {
    pub fn load_dream_primers(&self, project: &str) -> Result<PrimerSnapshot, McStoreError> {
        self.context_read(|conn| snapshot(conn, project))
    }

    /// Every effect, including pruning and both vector kinds, shares the caller's
    /// lease fence and the prompt snapshot recheck in this writer transaction.
    pub fn commit_dream_primer_promotion(
        &self,
        expected: &PrimerSnapshot,
        batch: &PromotionWrite,
        primer_vectors: &[VectorWrite],
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        self.context_write(&["primer_candidates", "primers"], |tx| {
            check_commit_fence(tx)?;
            require_inputs(tx, expected)?;
            if batch.project_path != expected.project { return Err(rusqlite::Error::InvalidQuery); }
            for id in &batch.pruned_candidate_ids {
                tx.execute("DELETE FROM primer_candidates WHERE project_path=?1 AND id=?2", params![expected.project, id])?;
            }
            for update in &batch.embedding_updates {
                write_vector(tx, &expected.project, update, true)?;
            }
            for update in primer_vectors {
                write_vector(tx, &expected.project, update, false)?;
            }
            for write in &batch.writes {
                if write.project_path != expected.project { return Err(rusqlite::Error::InvalidQuery); }
                let ids = serde_json::to_string(&write.source_candidate_ids).map_err(crate::serde_to_sql_error)?;
                let provenance = write.source_provenance.as_ref().map(stored_provenance).transpose()?;
                let vector = write.question_embedding.as_deref().map(vector_blob).transpose()?;
                if let Some(id) = write.primer_id {
                    // Identical support is a replay, not a new observation. Preserve
                    // timestamps and vectors rather than manufacturing refresh work.
                    tx.execute("UPDATE primers SET question_embedding=COALESCE(?3,question_embedding),question_embedding_model_id=COALESCE(?4,question_embedding_model_id),total_support=?5,last_observed_at=?6,source_candidate_ids=?7,source_candidate_provenance=?8,updated_at=?9 WHERE project_path=?1 AND id=?2 AND status='active' AND NOT (question_embedding IS COALESCE(?3,question_embedding) AND question_embedding_model_id IS COALESCE(?4,question_embedding_model_id) AND total_support IS ?5 AND last_observed_at IS ?6 AND source_candidate_ids IS ?7 AND source_candidate_provenance IS ?8)", params![expected.project,id,vector,write.question_embedding_model_id,write.total_support,write.last_observed_at,ids,provenance,write.updated_at])?;
                } else {
                    let question = write.question.as_deref().ok_or(rusqlite::Error::InvalidQuery)?;
                    tx.execute("INSERT INTO primers(project_path,question,question_embedding,question_embedding_model_id,answer,status,total_support,last_observed_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at) VALUES (?1,?2,?3,?4,'','active',?5,?6,?7,?8,?9,?9)", params![expected.project,question,vector,write.question_embedding_model_id,write.total_support,write.last_observed_at,ids,provenance,write.updated_at])?;
                }
            }
            Ok(())
        })
    }

    pub fn commit_dream_primer_answer(
        &self,
        expected: &PrimerSnapshot,
        answer: &AnswerWrite,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        self.context_write(&["primers"], |tx| {
            check_commit_fence(tx)?;
            require_inputs(tx, expected)?;
            if answer.project_path != expected.project { return Err(rusqlite::Error::InvalidQuery); }
            let changed = tx.execute("UPDATE primers SET answer=?3,answer_refreshed_at=?4,updated_at=?5 WHERE project_path=?1 AND id=?2 AND status='active'", params![expected.project,answer.primer_id,answer.answer,answer.answer_refreshed_at,answer.updated_at])?;
            if changed != 1 { return Err(rusqlite::Error::QueryReturnedNoRows); }
            Ok(())
        })
    }
}

fn require_inputs(tx: &Transaction<'_>, expected: &PrimerSnapshot) -> rusqlite::Result<()> {
    if snapshot(tx, &expected.project)?.input_hash != expected.input_hash {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn vector_blob(vector: &[f32]) -> rusqlite::Result<Vec<u8>> {
    if vector.is_empty() || vector.iter().any(|v| !v.is_finite()) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(vector.iter().flat_map(|v| v.to_le_bytes()).collect())
}

fn vector_value(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Value> {
    let bytes: Option<Vec<u8>> = row.get(column)?;
    match bytes {
        None => Ok(Value::Null),
        Some(bytes) if bytes.len() % 4 == 0 => {
            let vector = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect::<Vec<_>>();
            if vector.iter().any(|v| !v.is_finite()) {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(json!(vector))
        }
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn write_vector(
    tx: &Transaction<'_>,
    project: &str,
    update: &VectorWrite,
    candidate: bool,
) -> rusqlite::Result<()> {
    if update.model_id.is_empty() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let sql = if candidate {
        "UPDATE primer_candidates SET question_embedding=?3,question_embedding_model_id=?4 WHERE project_path=?1 AND id=?2"
    } else {
        "UPDATE primers SET question_embedding=?3,question_embedding_model_id=?4 WHERE project_path=?1 AND id=?2 AND status='active'"
    };
    let changed = tx.execute(
        sql,
        params![
            project,
            update.candidate_id,
            vector_blob(&update.vector)?,
            update.model_id
        ],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// The `primers.source_candidate_provenance` column as the TypeScript dreamer
/// writes it (storage-primers.ts `serializePrimerSourceProvenance`): snake-case
/// keys in a fixed order. The planner's camel-case entries are converted here.
fn stored_provenance(provenance: &Value) -> rusqlite::Result<String> {
    #[derive(Serialize)]
    struct Stored<'a> {
        candidate_id: &'a Value,
        project_path: &'a Value,
        harness: &'a Value,
        session_id: &'a Value,
        source_compartment_start: &'a Value,
        source_compartment_end: &'a Value,
        source_start_message_id: &'a Value,
        source_end_message_id: &'a Value,
    }
    let entries = provenance.as_array().ok_or(rusqlite::Error::InvalidQuery)?;
    let stored: Vec<_> = entries
        .iter()
        .map(|e| Stored {
            candidate_id: &e["candidateId"],
            project_path: &e["projectPath"],
            harness: &e["harness"],
            session_id: &e["sessionId"],
            source_compartment_start: &e["sourceCompartmentStart"],
            source_compartment_end: &e["sourceCompartmentEnd"],
            source_start_message_id: &e["sourceStartMessageId"],
            source_end_message_id: &e["sourceEndMessageId"],
        })
        .collect();
    serde_json::to_string(&stored).map_err(crate::serde_to_sql_error)
}

/// Read the column as storage-primers.ts `parsePrimerSourceProvenance` does: an
/// array of complete snake-case entries becomes the planner's camel-case list;
/// anything else reads as no provenance.
fn loaded_provenance(raw: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let mut out = Vec::new();
    for e in parsed.as_array()? {
        let text = |key: &str| e.get(key).filter(|v| v.is_string()).cloned();
        let bound = |key: &str| e.get(key).filter(|v| v.is_null() || v.is_number()).cloned();
        let candidate = e.get("candidate_id").filter(|v| v.is_number())?;
        out.push(json!({
            "candidateId": candidate,
            "projectPath": text("project_path")?,
            "harness": text("harness")?,
            "sessionId": text("session_id")?,
            "sourceCompartmentStart": bound("source_compartment_start")?,
            "sourceCompartmentEnd": bound("source_compartment_end")?,
            "sourceStartMessageId": text("source_start_message_id")?,
            "sourceEndMessageId": text("source_end_message_id")?,
        }));
    }
    Some(Value::Array(out))
}

fn snapshot(conn: &Connection, project: &str) -> rusqlite::Result<PrimerSnapshot> {
    let candidates = conn.prepare("SELECT id,project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,question_embedding,question_embedding_model_id,created_at FROM primer_candidates WHERE project_path=?1 ORDER BY id")?
        .query_map([project], |r| Ok(json!({
            "id":r.get::<_,i64>(0)?,"projectPath":r.get::<_,String>(1)?,"harness":r.get::<_,String>(2)?,"sessionId":r.get::<_,String>(3)?,"question":r.get::<_,String>(4)?,"normalizedQuestion":r.get::<_,String>(5)?,"sourceCompartmentStart":r.get::<_,Option<i64>>(6)?,"sourceCompartmentEnd":r.get::<_,Option<i64>>(7)?,"sourceStartMessageId":r.get::<_,String>(8)?,"sourceEndMessageId":r.get::<_,String>(9)?,"sourceMessageTime":r.get::<_,i64>(10)?,"questionEmbedding":vector_value(r,11)?,"questionEmbeddingModelId":r.get::<_,Option<String>>(12)?,"createdAt":r.get::<_,i64>(13)?
        })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let primers = conn.prepare("SELECT id,project_path,question,question_embedding,question_embedding_model_id,answer,status,total_support,last_observed_at,answer_refreshed_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at FROM primers WHERE project_path=?1 AND status='active' ORDER BY id")?
        .query_map([project], |r| {
            let ids: String = r.get(10)?;
            let provenance: Option<String> = r.get(11)?;
            Ok(json!({"id":r.get::<_,i64>(0)?,"projectPath":r.get::<_,String>(1)?,"question":r.get::<_,String>(2)?,"questionEmbedding":vector_value(r,3)?,"questionEmbeddingModelId":r.get::<_,Option<String>>(4)?,"answer":r.get::<_,String>(5)?,"status":r.get::<_,String>(6)?,"totalSupport":r.get::<_,i64>(7)?,"lastObservedAt":r.get::<_,Option<i64>>(8)?,"answerRefreshedAt":r.get::<_,Option<i64>>(9)?,"sourceCandidateIds":serde_json::from_str::<Value>(&ids).map_err(crate::serde_to_sql_error)?,"sourceProvenance":provenance.as_deref().and_then(loaded_provenance),"createdAt":r.get::<_,i64>(12)?,"updatedAt":r.get::<_,i64>(13)?}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
    let compartments = conn.prepare("SELECT DISTINCT p.session_id,p.sequence,p.start_message,p.title,p.p1,p.content FROM compartments p JOIN compartments o ON o.session_id=p.session_id AND p.sequence BETWEEN o.sequence-1 AND o.sequence+1 JOIN primer_candidates c ON c.session_id=o.session_id AND c.harness=o.harness AND c.source_compartment_start=o.start_message WHERE c.project_path=?1 AND p.harness=c.harness AND o.sequence=(SELECT MIN(first.sequence) FROM compartments first WHERE first.session_id=c.session_id AND first.harness=c.harness AND first.start_message=c.source_compartment_start) ORDER BY p.session_id,p.sequence")?
        .query_map([project], |r| Ok(json!({"sessionId":r.get::<_,String>(0)?,"sequence":r.get::<_,i64>(1)?,"startMessage":r.get::<_,i64>(2)?,"title":r.get::<_,String>(3)?,"p1":r.get::<_,Option<String>>(4)?,"content":r.get::<_,String>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let input_hash = crate::md5_hex(
        &serde_json::to_string(&json!([project, candidates, primers, compartments]))
            .map_err(crate::serde_to_sql_error)?,
    );
    Ok(PrimerSnapshot {
        project: project.into(),
        candidates,
        primers,
        compartments,
        input_hash,
    })
}

#[cfg(test)]
#[path = "dream_primer_tests.rs"]
mod tests;
