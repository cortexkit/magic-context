//! Historian item scores assess importance, never the classifier's safety flag.

use rusqlite::{params, Connection};

use crate::{McStore, McStoreError};

#[derive(Debug, Clone)]
pub struct ItemScore {
    pub item: i64,
    pub importance: i32,
    pub proposed_class: String,
}

impl McStore {
    /// Persist only scores for sent, still-pending items. The floor is enforced
    /// here so every lifecycle caller preserves a classifier's safety assessment.
    pub fn record_memory_item_scores(
        &self,
        sent_sequences: &[i64],
        scores: &[ItemScore],
        now_ms: i64,
    ) -> Result<usize, McStoreError> {
        self.context_write(&["memories", "memory_classification_items"], |tx| {
            record_item_scores_tx(tx, sent_sequences, scores, now_ms)
        })
    }
}

fn record_item_scores_tx(
    tx: &Connection,
    sent_sequences: &[i64],
    scores: &[ItemScore],
    now_ms: i64,
) -> rusqlite::Result<usize> {
    let mut recorded = 0;
    for score in scores {
        if !sent_sequences.contains(&score.item) {
            continue;
        }
        let won = tx.execute(
            "UPDATE memory_classification_items SET state='scored',importance=?1,proposed_class=?2,scored_at=?3
             WHERE enqueue_sequence=?4 AND state='pending'",
            params![score.importance, score.proposed_class, now_ms, score.item],
        )?;
        if won != 1 {
            continue;
        }
        tx.execute(
            "UPDATE memories SET importance=CASE WHEN safety_critical=1 THEN MAX(80,?1) ELSE ?1 END,classified_at=?2
             WHERE id=(SELECT memory_id FROM memory_classification_items WHERE enqueue_sequence=?3) AND status!='archived'",
            params![score.importance, now_ms, score.item],
        )?;
        recorded += 1;
    }
    Ok(recorded)
}
