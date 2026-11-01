//! Compartment writes that change both files: the cache state in `store.db` and the
//! session's history rows in `context.db`.
//!
//! The two files never commit together. Each such write therefore runs in three steps:
//!
//! 1. one `store.db` transaction does the checks (row version, historian phase, revert
//!    epoch), the cache changes, and records the `context.db` half as a pending row in
//!    `mc_single_store_pending_publish`;
//! 2. one `context.db` transaction applies that half;
//! 3. the pending row is deleted.
//!
//! A process that stops between steps leaves the pending row behind. The next write for
//! the session, the next transform pass for it, and the module's start all re-run step 2
//! from the row and then step 3, and no new write for the session starts while it exists.
//! Every `context.db` half is written so a second application finds nothing left to do:
//! compartments are compared with what is already stored, updated in place (keeping their
//! ids, so chunk embeddings survive) or inserted, and only rows that really changed count.
//!
//! Any rewrite of a compartment the session already had appends an `m0_mutation_log` row
//! in the same `context.db` transaction. That row is how every reader of the session
//! (TypeScript mode and this module alike) notices an in-place rewrite that the highest
//! compartment sequence alone would not reveal.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    append_compartments_tx, current_time_ms, insert_compartment_tx, insert_historian_events_tx,
    insert_historian_primer_tx, promote_facts_tx, session_harness_tx, FactCandidate,
    HistorianEventCandidate, HistorianPrimerCandidate, HistorianUserMemoryCandidate, McStore,
    McStoreError, PromotedRef, StoredCompartment,
};

/// The `context.db` tables a pending write may touch, for the module's per-table fence.
pub(crate) const HISTORY_TABLES: &[&str] = &[
    "compartment_events",
    "compartments",
    "memories",
    "memory_embedding_watermarks",
    "notes",
    "primer_candidates",
    "user_memory_candidates",
];

/// The `context.db` half of a write, as recorded in `store.db` before it is applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PendingContextWrite {
    /// A historian fold: new compartments at the session's tail and the rows derived
    /// from them.
    Fold(FoldWrite),
    /// The session's whole compartment set, replaced.
    ReplaceCompartments {
        compartments: Vec<StoredCompartment>,
        now_ms: i64,
    },
    /// Every compartment and history row of the session removed (native recomp reset).
    ClearSession { now_ms: i64 },
    /// Every compartment after `keep_through_seq` removed (revert re-cut).
    TruncateAfter { keep_through_seq: i64, now_ms: i64 },
    /// A fake-compaction lineage descent: the target key adopts the source key's
    /// compartments and session notes, plus a boundary placeholder.
    LineageCopy {
        source_key: String,
        placeholder: StoredCompartment,
    },
}

/// The `context.db` rows one historian fold writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FoldWrite {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fence: Option<HistorianFoldFence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_publication_id: Option<String>,
    pub project_path: String,
    /// The harness label for the fold's rows; `None` falls back to the session's own.
    #[serde(default)]
    pub harness: Option<String>,
    /// The fold's compartments with their durable sequences already assigned.
    pub compartments: Vec<StoredCompartment>,
    pub facts: Vec<FactCandidate>,
    pub promote_facts: bool,
    pub published_at_ms: i64,
    pub events: Vec<HistorianEventCandidate>,
    pub primer_candidates: Vec<HistorianPrimerCandidate>,
    pub user_memory_candidates: Vec<HistorianUserMemoryCandidate>,
}

/// Preserve assembly-time history identity and shared lease ownership across the
/// store.db intent commit and the later context.db compartment commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HistorianFoldFence {
    pub firing_seq: u64,
    pub prior_publication_floor_ordinal: Option<u64>,
    pub producer_run_id: String,
    pub holder_id: String,
    pub generation: crate::CompartmentSetGeneration,
    pub revert_epoch: u64,
}

pub(crate) enum ActivatedFoldOutcome {
    Applied(Vec<PromotedRef>),
    Deferred(String),
    Discarded(String),
}

/// Why a stored compartment and a desired one are the same row: every column the renderer,
/// the historian or a host reads, except the id and the harness label.
fn same_compartment(stored: &StoredCompartment, desired: &StoredCompartment) -> bool {
    stored.sequence == desired.sequence
        && stored.start_message == desired.start_message
        && stored.end_message == desired.end_message
        && stored.start_message_id == desired.start_message_id
        && stored.end_message_id == desired.end_message_id
        && stored.title == desired.title
        && stored.content == desired.content
        && stored.p1 == desired.p1
        && stored.p2 == desired.p2
        && stored.p3 == desired.p3
        && stored.p4 == desired.p4
        && stored.importance == desired.importance
        && stored.episode_type == desired.episode_type
        && stored.legacy == desired.legacy
        && stored.created_at == desired.created_at
}

fn read_session_compartments(
    tx: &rusqlite::Connection,
    session_id: &str,
    min_sequence: i64,
) -> rusqlite::Result<Vec<(i64, StoredCompartment)>> {
    let mut statement = tx.prepare(&format!(
        "SELECT id, {} FROM compartments WHERE session_id = ?1 AND sequence >= ?2 ORDER BY sequence ASC",
        crate::COMPARTMENT_SELECT_COLUMNS
    ))?;
    let rows = statement
        .query_map(params![session_id, min_sequence], |row| {
            let id: i64 = row.get(0)?;
            Ok((
                id,
                StoredCompartment {
                    sequence: row.get(1)?,
                    start_message: row.get(2)?,
                    end_message: row.get(3)?,
                    start_message_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    end_message_id: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    start_date: None,
                    end_date: None,
                    title: row.get(8)?,
                    content: row.get(9)?,
                    p1: row.get(10)?,
                    p2: row.get(11)?,
                    p3: row.get(12)?,
                    p4: row.get(13)?,
                    importance: row.get::<_, Option<i64>>(14)?.unwrap_or(50) as i32,
                    episode_type: row.get(15)?,
                    legacy: row.get::<_, Option<i64>>(16)?.unwrap_or(0) as i32,
                    created_at: row.get(17)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// What [`upsert_compartments_tx`] changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct UpsertOutcome {
    inserted: usize,
    updated: usize,
}

/// Write `desired` at their own sequences: a row already equal is left alone, a different
/// row at the same sequence is updated in place (its id, and so its chunk embeddings,
/// survive), a missing sequence is inserted.
fn upsert_compartments_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    desired: &[StoredCompartment],
    harness: &str,
) -> rusqlite::Result<UpsertOutcome> {
    let Some(min_sequence) = desired.iter().map(|row| row.sequence).min() else {
        return Ok(UpsertOutcome::default());
    };
    let mut stored = std::collections::HashMap::new();
    for (id, row) in read_session_compartments(tx, session_id, min_sequence)? {
        // Keep the first row, as the chronological scan did on older schemas that
        // permitted more than one row at a sequence.
        stored.entry(row.sequence).or_insert((id, row));
    }
    let mut outcome = UpsertOutcome::default();
    for compartment in desired {
        let (start_id, start_block) =
            crate::context_boundaries::canonical_boundary_parts(&compartment.start_message_id)?;
        let (end_id, end_block) =
            crate::context_boundaries::canonical_boundary_parts(&compartment.end_message_id)?;
        match stored.get(&compartment.sequence) {
            Some((_, row)) if same_compartment(row, compartment) => {}
            Some((id, _)) => {
                tx.execute(
                    "UPDATE compartments
                        SET start_message = ?2, end_message = ?3, start_message_id = ?4,
                            end_message_id = ?5, title = ?6, content = ?7, p1 = ?8, p2 = ?9,
                            p3 = ?10, p4 = ?11, importance = ?12, episode_type = ?13,
                            legacy = ?14, created_at = ?15, p1_embedding = NULL,
                            p1_embedding_model_id = NULL, start_block_index = ?16, end_block_index = ?17
                      WHERE id = ?1",
                    params![
                        id,
                        compartment.start_message,
                        compartment.end_message,
                        start_id,
                        end_id,
                        compartment.title,
                        compartment.content,
                        compartment.p1,
                        compartment.p2,
                        compartment.p3,
                        compartment.p4,
                        compartment.importance as i64,
                        compartment.episode_type,
                        compartment.legacy as i64,
                        compartment.created_at,
                        start_block,
                        end_block,
                    ],
                )?;
                outcome.updated += 1;
            }
            None => {
                insert_compartment_tx(tx, session_id, compartment.sequence, compartment, harness)?;
                outcome.inserted += 1;
            }
        }
    }
    Ok(outcome)
}

/// Delete the session's compartments matching `predicate` (a SQL condition over the
/// `compartments` row) together with the events that point at them. Returns how many
/// compartments went.
fn delete_compartments_where_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    predicate: &str,
    value: i64,
) -> rusqlite::Result<usize> {
    tx.execute(
        &format!(
            "DELETE FROM compartment_events
              WHERE session_id = ?1
                AND compartment_id IN (
                    SELECT id FROM compartments WHERE session_id = ?1 AND {predicate}
                )"
        ),
        params![session_id, value],
    )?;
    tx.execute(
        &format!("DELETE FROM compartments WHERE session_id = ?1 AND {predicate}"),
        params![session_id, value],
    )
}

/// The `target_id` the module stamps on the `m0_mutation_log` rows it writes itself.
///
/// No reader uses `target_id` as a row reference (the host compares only `MAX(id)`), so
/// the value is free to say who wrote the row. The module skips its own rows when it reads
/// the head: it already knows about its own rewrites and handles them through its own
/// boundary machinery, and treating them as another writer's change would force a HARD
/// on the next pass that the module's cache protection is there to avoid.
pub const MODULE_M0_MUTATION_TARGET: i64 = -1;

/// Record that the session's existing compartments were rewritten, so readers that key
/// their cache on the highest sequence also notice an in-place change.
pub(crate) fn append_m0_mutation_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    mutation_type: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO m0_mutation_log (session_id, mutation_type, target_id, queued_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, mutation_type, MODULE_M0_MUTATION_TARGET, now_ms],
    )?;
    Ok(())
}

/// Candidates whose source range starts past the session's last remaining compartment
/// were derived from compartments that no longer exist.
fn delete_candidates_past_tail_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<()> {
    for table in ["primer_candidates", "user_memory_candidates"] {
        tx.execute(
            &format!(
                "DELETE FROM {table}
                  WHERE session_id = ?1
                    AND source_compartment_start > COALESCE(
                        (SELECT MAX(end_message) FROM compartments WHERE session_id = ?1), -1)"
            ),
            params![session_id],
        )?;
    }
    Ok(())
}

/// When TypeScript owns the project's memory rows, preserve every extracted fact
/// as a pending candidate instead of attempting module admission. This runs in
/// the compartment transaction, including when the saved FoldWrite is replayed
/// from store.db after a crash; neither half of the publication can commit alone.
fn publish_dormant_candidates_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    fold: &FoldWrite,
) -> rusqlite::Result<()> {
    let Some(publication_id) = &fold.lifecycle_publication_id else {
        return Ok(());
    };
    tx.execute(
        "INSERT OR IGNORE INTO memory_publications(publication_id,project_path,source_session_id)
         VALUES (?1,?2,?3)",
        params![publication_id, fold.project_path, session_id],
    )?;
    tx.execute(
        "UPDATE memory_publications
         SET commit_order=(SELECT COALESCE(MAX(commit_order),0)+1 FROM memory_publications), committed_at=?2
         WHERE publication_id=?1 AND commit_order IS NULL",
        params![publication_id, fold.published_at_ms],
    )?;
    if !crate::memory_lifecycle::authority::module_owns_memory(tx, &fold.project_path)? {
        for (index, fact) in fold.facts.iter().enumerate() {
            tx.execute(
                "INSERT OR IGNORE INTO memory_pending_facts
                 (project_path,publication_id,fact_index,category,content,anchor_known,state,fact_attempts,reason)
                 VALUES (?1,?2,?3,?4,?5,0,'retryable',0,'authority_elsewhere')",
                params![fold.project_path, publication_id, index as i64, fact.category, fact.content],
            )?;
        }
    }

    for compartment in &fold.compartments {
        tx.execute(
            "INSERT OR IGNORE INTO memory_activity_ledger(project_path,publication_id,compartment_id,committed_at)
             SELECT ?1,?2,id,?3 FROM compartments WHERE session_id=?4 AND sequence=?5",
            params![fold.project_path, publication_id, fold.published_at_ms, session_id, compartment.sequence],
        )?;
    }
    Ok(())
}

fn apply_fold_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    fold: &FoldWrite,
) -> rusqlite::Result<Vec<PromotedRef>> {
    let harness = match &fold.harness {
        Some(harness) => harness.clone(),
        None => session_harness_tx(tx, session_id)?,
    };
    let upsert = upsert_compartments_tx(tx, session_id, &fold.compartments, &harness)?;
    if upsert.updated > 0 {
        // A fold normally only appends. Sequences it found occupied by different rows
        // belong to a stale tail it replaced.
        append_m0_mutation_tx(tx, session_id, "compartment_delete", fold.published_at_ms)?;
    }
    publish_dormant_candidates_tx(tx, session_id, fold)?;
    let promoted = if fold.promote_facts {
        promote_facts_tx(tx, &fold.project_path, &fold.facts, fold.published_at_ms)?
    } else {
        Vec::new()
    };
    // Events, primers and observations belong to the fold's first application. When
    // every compartment was already in place the fold has been applied before (a resume
    // after a crash), and writing them again would duplicate them.
    if upsert.inserted + upsert.updated == 0 && !fold.compartments.is_empty() {
        return Ok(promoted);
    }
    // Side channels are best effort, as they always were: a failure here must not
    // abort the fold's compartments.
    let _ = insert_historian_events_tx(tx, session_id, &fold.events, &harness);
    for candidate in &fold.primer_candidates {
        if insert_historian_primer_tx(tx, candidate, &harness).is_err() {
            break;
        }
    }
    for candidate in &fold.user_memory_candidates {
        if crate::insert_historian_user_observation_tx(tx, candidate).is_err() {
            break;
        }
    }
    Ok(promoted)
}

fn apply_lineage_copy_tx(
    tx: &rusqlite::Connection,
    target_key: &str,
    source_key: &str,
    placeholder: &StoredCompartment,
) -> rusqlite::Result<()> {
    delete_compartments_where_tx(tx, target_key, "sequence >= ?2", i64::MIN)?;
    tx.execute(
        "DELETE FROM notes WHERE session_id = ?1 AND type = 'session'",
        params![target_key],
    )?;
    // Session notes follow the descended conversation key. Smart notes are not copied:
    // their project-wide visibility is independent of one lineage's retained history.
    tx.execute(
        "INSERT INTO notes (type, project_path, session_id, content, status, surface_condition,
                            compiled_provider, compiled_config, compiled_at, compile_status,
                            ready_at, ready_reason, manifest_json, compiled_check, check_hash,
                            check_cron, check_failure_count, check_network_failure_count,
                            check_quarantined_until, check_next_due_at, check_compiled_at,
                            check_false_since_at, check_last_liveness_at, last_checked_at,
                            check_status, check_version, policy_version, harness,
                            anchor_block_id, anchor_ordinal, created_at, updated_at)
         SELECT type, project_path, ?1, content, status, surface_condition,
                compiled_provider, compiled_config, compiled_at, compile_status,
                ready_at, ready_reason, manifest_json, compiled_check, check_hash,
                check_cron, check_failure_count, check_network_failure_count,
                check_quarantined_until, check_next_due_at, check_compiled_at,
                check_false_since_at, check_last_liveness_at, last_checked_at,
                check_status, check_version, policy_version, harness,
                anchor_block_id, anchor_ordinal, created_at, updated_at
           FROM notes WHERE session_id = ?2 AND type = 'session'",
        params![target_key, source_key],
    )?;
    tx.execute(
        "INSERT INTO compartments (
             session_id, sequence, start_message, end_message, start_message_id,
             end_message_id, title, content, p1, p2, p3, p4, importance, episode_type,
             legacy, created_at, harness, start_block_index, end_block_index
         )
         SELECT ?1, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, importance, episode_type,
                legacy, created_at, harness, start_block_index, end_block_index
           FROM compartments WHERE session_id = ?2",
        params![target_key, source_key],
    )?;
    let harness = session_harness_tx(tx, target_key)?;
    insert_compartment_tx(tx, target_key, placeholder.sequence, placeholder, &harness)?;
    Ok(())
}

pub(crate) fn apply_pending_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    write: &PendingContextWrite,
) -> rusqlite::Result<Vec<PromotedRef>> {
    match write {
        PendingContextWrite::Fold(fold) => apply_fold_tx(tx, session_id, fold),
        PendingContextWrite::ReplaceCompartments {
            compartments,
            now_ms,
        } => {
            let harness = session_harness_tx(tx, session_id)?;
            let upsert = upsert_compartments_tx(tx, session_id, compartments, &harness)?;
            let keep: std::collections::BTreeSet<i64> =
                compartments.iter().map(|row| row.sequence).collect();
            let mut deleted = 0;
            let sequences = tx
                .prepare_cached(
                    "SELECT sequence FROM compartments WHERE session_id = ?1 ORDER BY sequence ASC",
                )?
                .query_map(params![session_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for sequence in sequences {
                if !keep.contains(&sequence) {
                    deleted +=
                        delete_compartments_where_tx(tx, session_id, "sequence = ?2", sequence)?;
                }
            }
            if upsert.updated + deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "recomp_boundary_change", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::ClearSession { now_ms } => {
            let deleted = delete_compartments_where_tx(tx, session_id, "sequence >= ?2", i64::MIN)?;
            for table in [
                "compartment_events",
                "primer_candidates",
                "user_memory_candidates",
            ] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE session_id = ?1"),
                    params![session_id],
                )?;
            }
            if deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "compartment_delete", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::TruncateAfter {
            keep_through_seq,
            now_ms,
        } => {
            let deleted =
                delete_compartments_where_tx(tx, session_id, "sequence > ?2", *keep_through_seq)?;
            delete_candidates_past_tail_tx(tx, session_id)?;
            if deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "compartment_delete", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::LineageCopy {
            source_key,
            placeholder,
        } => {
            apply_lineage_copy_tx(tx, session_id, source_key, placeholder)?;
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
pub(crate) fn perf_apply_pending(
    tx: &rusqlite::Connection,
    session_id: &str,
    write: &PendingContextWrite,
) -> rusqlite::Result<Vec<PromotedRef>> {
    apply_pending_tx(tx, session_id, write)
}

/// Record `write` as the session's pending `context.db` half, inside the caller's
/// `store.db` transaction. Fails when one is already pending: the caller resumes that one
/// before starting a new write, so a second one here means a concurrent writer.
pub(crate) fn record_pending_context_write_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    write: &PendingContextWrite,
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(write)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    tx.execute(
        "INSERT INTO mc_single_store_pending_publish (session_id, publish_json, created_at)
         VALUES (?1, ?2, ?3)",
        params![session_id, json, current_time_ms()],
    )?;
    Ok(())
}

impl McStore {
    /// Apply a pending `context.db` half, then delete its row. Returns the memories a
    /// fold promoted.
    pub(crate) fn complete_pending_context_write(
        &self,
        session_id: &str,
        write: &PendingContextWrite,
    ) -> Result<Vec<PromotedRef>, McStoreError> {
        // The same binary recorded the row from this value, so it serializes to the
        // stored text.
        let recorded =
            serde_json::to_string(write).map_err(|error| McStoreError::Serde(error.to_string()))?;
        self.complete_recorded_context_write(session_id, write, &recorded)
    }

    /// Apply `write`, then delete its pending row only if the row still holds `recorded`,
    /// the text it was stored as. Between the apply and the delete another writer can
    /// resume this row and record a newer write for the session; deleting by session
    /// alone would drop that newer write, and if its own `context.db` half then failed,
    /// nothing would be left to resume it.
    fn complete_recorded_context_write(
        &self,
        session_id: &str,
        write: &PendingContextWrite,
        recorded: &str,
    ) -> Result<Vec<PromotedRef>, McStoreError> {
        if let PendingContextWrite::Fold(fold) = write {
            if fold.fence.is_some() {
                return match self.complete_activated_fold(session_id, fold, recorded)? {
                    ActivatedFoldOutcome::Applied(promoted) => Ok(promoted),
                    ActivatedFoldOutcome::Discarded(_) => Ok(Vec::new()),
                    ActivatedFoldOutcome::Deferred(_) => Ok(Vec::new()),
                };
            }
        }
        let mut tables = HISTORY_TABLES.to_vec();
        if matches!(write, PendingContextWrite::Fold(fold) if fold.lifecycle_publication_id.is_some())
        {
            tables.extend([
                "memory_publications",
                "memory_pending_facts",
                "memory_activity_ledger",
            ]);
        }
        let promoted = self.context_write(&tables, |tx| apply_pending_tx(tx, session_id, write))?;
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_single_store_pending_publish
                  WHERE session_id = ?1 AND publish_json = ?2",
                params![session_id, recorded],
            )?;
            Ok(())
        })?;
        Ok(promoted)
    }

    pub(crate) fn complete_activated_fold(
        &self,
        session_id: &str,
        fold: &FoldWrite,
        recorded: &str,
    ) -> Result<ActivatedFoldOutcome, McStoreError> {
        let fence = fold.fence.as_ref().expect("activated fold has a fence");
        let Some(_lease) = self.acquire_historian_lease(session_id, &fence.holder_id)? else {
            return Ok(ActivatedFoldOutcome::Deferred(
                "compartment lease busy".into(),
            ));
        };
        #[cfg(test)]
        crate::HISTORIAN_FOLD_TEST_HOOK.with(|hook| {
            let hook = hook.borrow_mut().take();
            if let Some(hook) = hook {
                hook(self);
            }
        });
        let mut tables = HISTORY_TABLES.to_vec();
        if fold.lifecycle_publication_id.is_some() {
            tables.extend([
                "memory_publications",
                "memory_pending_facts",
                "memory_activity_ledger",
            ]);
        }
        // Lock store.db before context.db, and keep both locks until the context
        // commit. A revert cannot move its store-side epoch during the append.
        let mut failure = None;
        let result = self.inner.with_conn_fenced(|store_tx| {
            let outcome = self.context_write(&tables, |tx| {
                if !crate::historian_lease_held(tx, session_id, &fence.holder_id)? {
                    return Ok(ActivatedFoldOutcome::Deferred("compartment lease ownership lost".into()));
                }
                if crate::historian_wrapup_active(tx, session_id)? {
                    return Ok(ActivatedFoldOutcome::Deferred("wrapup in progress".into()));
                }
                let epoch: u64 = store_tx.query_row(
                    "SELECT COALESCE((SELECT json_extract(meta, '$.revert_epoch') FROM mc_cache_state WHERE session_id = ?1), 0)",
                    params![session_id], |row| row.get(0),
                )?;
                if epoch != fence.revert_epoch {
                    return Ok(ActivatedFoldOutcome::Discarded("revert epoch changed after firing".into()));
                }
                let generation = tx.query_row(
                    "SELECT COALESCE(MAX(sequence), 0), COUNT(*) FROM compartments WHERE session_id = ?1",
                    params![session_id], |row| Ok(crate::CompartmentSetGeneration { max_sequence: row.get(0)?, count: row.get(1)? }),
                )?;
                // A crash after the context commit but before deleting the intent
                // must not run fact promotion or other side channels a second time.
                if !fold.compartments.is_empty() {
                    let stored = read_session_compartments(tx, session_id, fence.generation.max_sequence + 1)?;
                    if fold.compartments.iter().all(|desired| stored.iter().any(|(_, row)| same_compartment(row, desired))) {
                        return Ok(ActivatedFoldOutcome::Applied(Vec::new()));
                    }
                }
                if generation != fence.generation {
                    return Ok(ActivatedFoldOutcome::Discarded("compartment set changed after firing".into()));
                }
                apply_fold_tx(tx, session_id, fold).map(ActivatedFoldOutcome::Applied)
            });
            let outcome = match outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    failure = Some(error);
                    return Err(rusqlite::Error::InvalidQuery);
                }
            };
            if !matches!(outcome, ActivatedFoldOutcome::Deferred(_)) {
                if matches!(outcome, ActivatedFoldOutcome::Discarded(_)) {
                    let (version, encoded): (i64, String) = store_tx.query_row("SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1", params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                    let mut meta: crate::ModuleMeta = serde_json::from_str(&encoded).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                    if meta.historian.state == crate::HistorianPhase::Idle && meta.historian.firing_seq == fence.firing_seq {
                        // An unapplied fold must not advance the next assembly's
                        // raw-message floor. Do not undo a newer firing's progress.
                        meta.publication_floor_ordinal = fence.prior_publication_floor_ordinal;
                        let encoded = serde_json::to_string(&meta).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        store_tx.execute("UPDATE mc_cache_state SET row_version = ?2, meta = ?3 WHERE session_id = ?1", params![session_id, version + 1, encoded])?;
                        crate::advance_row_state_digest_tx(store_tx, session_id, version, version + 1)?;
                    }
                    // The intent staged transcripts and boundary dates, but no Rust
                    // compartment was appended to own them. Remove them rather than
                    // attach stale recovery text or dates to TypeScript compartments.
                    for compartment in &fold.compartments {
                        store_tx.execute("DELETE FROM mc_chunk_transcripts WHERE session_id = ?1 AND compartment_seq = ?2", params![session_id, compartment.sequence])?;
                        store_tx.execute("DELETE FROM mc_compartment_dates WHERE session_id = ?1 AND sequence = ?2", params![session_id, compartment.sequence])?;
                    }
                }
                store_tx.execute(
                    "DELETE FROM mc_single_store_pending_publish WHERE session_id = ?1 AND publish_json = ?2",
                    params![session_id, recorded],
                )?;
                store_tx.execute("DELETE FROM mc_historian_pending_run WHERE run_id = ?1 AND session_id = ?2", params![fence.producer_run_id, session_id])?;
            }
            Ok(outcome)
        });
        if let Some(error) = failure {
            return Err(error);
        }
        let outcome = result?;
        if let ActivatedFoldOutcome::Discarded(reason) = &outcome {
            tracing::warn!(
                session_id,
                holder_id = fence.holder_id,
                reason,
                "discarded stale activated historian fold"
            );
        }
        Ok(outcome)
    }

    /// Finish the session's pending `context.db` write, if a crash or a busy `context.db`
    /// left one. Returns whether there was one.
    pub fn resume_pending_context_write(&self, session_id: &str) -> Result<bool, McStoreError> {
        let pending: Option<String> = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT publish_json FROM mc_single_store_pending_publish WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
        })?;
        let Some(json) = pending else {
            return Ok(false);
        };
        let write: PendingContextWrite =
            serde_json::from_str(&json).map_err(|error| McStoreError::Serde(error.to_string()))?;
        if let PendingContextWrite::Fold(fold) = &write {
            if fold.fence.is_some() {
                return Ok(!matches!(
                    self.complete_activated_fold(session_id, fold, &json)?,
                    ActivatedFoldOutcome::Deferred(_)
                ));
            }
        }
        // The stored text, not a re-serialization: a row an older binary wrote may not
        // round-trip byte for byte, and then it would never be deleted.
        self.complete_recorded_context_write(session_id, &write, &json)?;
        Ok(true)
    }

    /// Finish every session's pending `context.db` write. The module runs this once at
    /// start, so a write interrupted by the previous process lands before any pass reads.
    pub fn resume_all_pending_context_writes(&self) -> Result<usize, McStoreError> {
        let sessions: Vec<String> = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT p.session_id FROM mc_single_store_pending_publish p
                 WHERE NOT EXISTS(SELECT 1 FROM mc_move_fences f WHERE f.session_id = p.session_id)
                 ORDER BY p.created_at",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let mut resumed = 0;
        for session_id in sessions {
            if self.resume_pending_context_write(&session_id)? {
                resumed += 1;
            }
        }
        Ok(resumed)
    }

    /// Whether the session has a `context.db` write that has not landed yet.
    pub fn has_pending_context_write(&self, session_id: &str) -> Result<bool, McStoreError> {
        let exists: i64 = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_single_store_pending_publish WHERE session_id = ?1)",
                params![session_id],
                |row| row.get(0),
            )
        })?;
        Ok(exists != 0)
    }

    /// Append compartments at the session's tail in one `context.db` transaction. There
    /// is no cache half, so nothing is recorded as pending.
    pub(crate) fn append_compartments_now(
        &self,
        session_id: &str,
        compartments: &[StoredCompartment],
    ) -> Result<crate::AppendCompartmentsTxnOutcome, McStoreError> {
        self.context_write(HISTORY_TABLES, |tx| {
            append_compartments_tx(tx, session_id, compartments)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use rusqlite::{Connection, Transaction};

    use super::*;
    use crate::{ContextDomain, SqliteContextDomain};

    /// A `context.db` whose next write fails, standing in for a process that stops (or a
    /// `context.db` that stays busy) after the `store.db` half committed.
    struct FailNextWrite {
        inner: SqliteContextDomain,
        fail: AtomicBool,
    }

    impl ContextDomain for FailNextWrite {
        fn read(
            &self,
            read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.read(read)
        }

        fn write(
            &self,
            tables: &[&str],
            write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(crate::single_store_domain::context_error(
                    "context_busy",
                    "injected failure",
                ));
            }
            self.inner.write(tables, write)
        }
    }

    fn fold() -> PendingContextWrite {
        PendingContextWrite::Fold(FoldWrite {
            fence: None,
            lifecycle_publication_id: None,
            project_path: "git:proj".to_string(),
            harness: None,
            compartments: vec![StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 4,
                end_message_id: "m4#0".to_string(),
                title: "fold".to_string(),
                content: "folded".to_string(),
                p1: Some("folded".to_string()),
                importance: 50,
                created_at: 10,
                ..Default::default()
            }],
            facts: vec![FactCandidate {
                category: "CONSTRAINTS".to_string(),
                content: "a promoted fact".to_string(),
                ..Default::default()
            }],
            promote_facts: true,
            published_at_ms: 10,
            events: vec![HistorianEventCandidate {
                kind: "decision".to_string(),
                at_compartment: Some(1),
                compartment_id: Some(1),
                fields_json: "{}".to_string(),
                created_at: 10,
                harness: "opencode".to_string(),
            }],
            primer_candidates: vec![HistorianPrimerCandidate {
                project_path: "git:proj".to_string(),
                session_id: "ses".to_string(),
                question: "why this design?".to_string(),
                source_compartment_start: Some(1),
                source_compartment_end: Some(4),
                source_start_message_id: "m1".to_string(),
                source_end_message_id: "m4".to_string(),
                source_message_time: 10,
                created_at: 10,
            }],
            user_memory_candidates: vec![HistorianUserMemoryCandidate {
                content: "prefers terse answers".to_string(),
                session_id: "ses".to_string(),
                source_compartment_start: Some(1),
                source_compartment_end: Some(4),
                created_at: 10,
            }],
        })
    }

    /// Row counts of every table a fold writes, in the order: compartments, memories,
    /// events, primers, user observations.
    fn counts(store: &McStore) -> [i64; 5] {
        store
            .with_context_conn_for_test(|tx| {
                let count = |table: &str| -> rusqlite::Result<i64> {
                    tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                };
                Ok([
                    count("compartments")?,
                    count("memories")?,
                    count("compartment_events")?,
                    count("primer_candidates")?,
                    count("user_memory_candidates")?,
                ])
            })
            .unwrap()
    }

    fn record(store: &McStore, write: &PendingContextWrite) {
        store
            .inner
            .with_conn_fenced(|tx| record_pending_context_write_tx(tx, "ses", write))
            .unwrap();
    }

    fn lifecycle_counts(conn: &Connection) -> [i64; 4] {
        [
            "memory_publications",
            "memory_pending_facts",
            "memory_activity_ledger",
            "memories",
        ]
        .map(|table| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        })
    }

    fn mark_ts_owned(conn: &Connection) {
        conn.execute(
            "INSERT OR IGNORE INTO authority_managed(project_path,context_store_uuid,marked_at)
            VALUES ('git:another-project','fixture',1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn dormant_mirror_keeps_all_facts_retryable_without_attempts_or_memory_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&crash_descriptor(dir.path())).unwrap();
        let PendingContextWrite::Fold(mut write) = fold() else {
            unreachable!()
        };
        write.lifecycle_publication_id = Some("publication-1".into());
        write.facts.push(FactCandidate {
            category: "CONSTRAINTS".into(),
            content: "another fact".into(),
            ..Default::default()
        });
        store.with_context_conn_for_test(|conn| {
            mark_ts_owned(conn);
            apply_fold_tx(conn, "ses", &write)?;
            apply_fold_tx(conn, "ses", &write)?;
            assert_eq!(lifecycle_counts(conn), [1,2,1,0]);
            let facts = conn.prepare("SELECT content,anchor_known,state,fact_attempts,reason,reserved_stage_key,compartment_id
                FROM memory_pending_facts ORDER BY fact_index")?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?)))?.collect::<Result<Vec<_>,_>>()?;
            assert_eq!(facts, vec![("a promoted fact".into(),0,"retryable".into(),0,"authority_elsewhere".into(),None,None),
                ("another fact".into(),0,"retryable".into(),0,"authority_elsewhere".into(),None,None)]);
            Ok(())
        }).unwrap();
    }

    fn domain_rows(conn: &Connection) -> Vec<(String, Vec<String>)> {
        let names = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
            .query_map([], |row| row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        names
            .into_iter()
            .map(|name| {
                let mut statement = conn.prepare(&format!("SELECT * FROM \"{name}\"")).unwrap();
                let mut cols: Vec<String> = statement
                    .column_names()
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                cols.sort();
                let mut rows = statement
                    .query_map([], |row| {
                        Ok(cols
                            .iter()
                            .map(|col| format!("{:?}", row.get_ref(col.as_str()).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                rows.sort();
                (name, rows)
            })
            .collect()
    }

    #[test]
    fn publication_without_candidates_is_byte_identical_to_legacy_fold() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&crash_descriptor(dir.path())).unwrap();
        let legacy_dir = tempfile::tempdir().unwrap();
        let legacy = McStore::open_for_test(&crash_descriptor(legacy_dir.path())).unwrap();
        let PendingContextWrite::Fold(write) = fold() else {
            unreachable!()
        };
        assert!(!serde_json::to_string(&write)
            .unwrap()
            .contains("lifecycle_publication_id"));
        for fixture in [&store, &legacy] {
            fixture.with_context_conn_for_test(|conn| {
                conn.execute("INSERT INTO compartment_history_versions(session_id,generation,version,rewrite_version,seeded)
                    VALUES ('ses','fixed-generation',0,0,0)", [])?;
                Ok(())
            }).unwrap();
        }
        let before_a = store
            .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
            .unwrap();
        let before_b = legacy
            .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                apply_fold_tx(conn, "ses", &write)?;
                Ok(())
            })
            .unwrap();
        legacy
            .with_context_conn_for_test(|conn| {
                let harness = session_harness_tx(conn, "ses")?;
                upsert_compartments_tx(conn, "ses", &write.compartments, &harness)?;
                promote_facts_tx(
                    conn,
                    &write.project_path,
                    &write.facts,
                    write.published_at_ms,
                )?;
                insert_historian_events_tx(conn, "ses", &write.events, &harness)?;
                for candidate in &write.primer_candidates {
                    insert_historian_primer_tx(conn, candidate, &harness)?;
                }
                for candidate in &write.user_memory_candidates {
                    crate::insert_historian_user_observation_tx(conn, candidate)?;
                }
                Ok(())
            })
            .unwrap();
        let a = store
            .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
            .unwrap();
        let b = legacy
            .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
            .unwrap();
        let a = a
            .into_iter()
            .zip(before_a)
            .filter_map(|(after, before)| (after != before).then_some(after))
            .collect::<Vec<_>>();
        let b = b
            .into_iter()
            .zip(before_b)
            .filter_map(|(after, before)| (after != before).then_some(after))
            .collect::<Vec<_>>();
        assert_eq!(a.len(), b.len());
        for (a, b) in a.iter().zip(&b) {
            assert_eq!(a, b, "legacy row bytes differ in {}", a.0);
        }
    }

    struct KillBeforeFoldCommit {
        inner: SqliteContextDomain,
        marker: std::path::PathBuf,
    }

    impl ContextDomain for KillBeforeFoldCommit {
        fn read(
            &self,
            read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.read(read)
        }
        fn write(
            &self,
            tables: &[&str],
            write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.write(tables, &mut |tx| {
                write(tx)?;
                assert_eq!(
                    lifecycle_counts(tx),
                    [1, 1, 1, 0],
                    "candidate must be in the uncommitted compartment transaction"
                );
                std::fs::write(&self.marker, "fold applied, transaction uncommitted").unwrap();
                loop {
                    std::thread::park_timeout(std::time::Duration::from_secs(60));
                }
            })
        }
    }

    fn crash_descriptor(dir: &std::path::Path) -> cortexkit_store_types::StorageDescriptor {
        cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".into(),
            storage_namespace: crate::single_store_schema::STORE_NAMESPACE.into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }

    #[test]
    fn dormant_candidate_killed_before_commit_replays_exactly_once() {
        const CHILD_DIR: &str = "MC_TEST_CANDIDATE_CRASH_DIR";
        if let Some(dir) = std::env::var_os(CHILD_DIR) {
            let dir = std::path::PathBuf::from(dir);
            let store = McStore::open_for_test(&crash_descriptor(&dir)).unwrap();
            let context = dir.join("context.db");
            mark_ts_owned(&Connection::open(&context).unwrap());
            store.install_context_domain(Arc::new(KillBeforeFoldCommit {
                inner: SqliteContextDomain::open(&context).unwrap(),
                marker: dir.join("before-commit"),
            }));
            let PendingContextWrite::Fold(mut write) = fold() else {
                unreachable!()
            };
            write.lifecycle_publication_id = Some("crash-publication".into());
            let write = PendingContextWrite::Fold(write);
            record(&store, &write);
            store.complete_pending_context_write("ses", &write).unwrap();
            unreachable!("parent must kill the child before commit");
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("before-commit");
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "context_writes::tests::dormant_candidate_killed_before_commit_replays_exactly_once", "--nocapture"])
            .env(CHILD_DIR, dir.path()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !marker.exists() && std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                panic!(
                    "crash child exited before atomicity cut ({status}): {}",
                    std::fs::read_to_string(dir.path().join("child.log")).unwrap()
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !marker.exists() {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("child never reached precommit cut");
        }
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        let store = McStore::open_for_test(&crash_descriptor(dir.path())).unwrap();
        store
            .with_context_conn_for_test(|conn| {
                assert_eq!(
                    lifecycle_counts(conn),
                    [0, 0, 0, 0],
                    "killed fold leaked uncommitted evidence"
                );
                Ok(())
            })
            .unwrap();
        assert!(store.has_pending_context_write("ses").unwrap());
        assert!(store.resume_pending_context_write("ses").unwrap());
        assert!(!store.resume_pending_context_write("ses").unwrap());
        store
            .with_context_conn_for_test(|conn| {
                assert_eq!(lifecycle_counts(conn), [1, 1, 1, 0]);
                let attempts: i64 = conn.query_row(
                    "SELECT fact_attempts FROM memory_pending_facts",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(attempts, 0);
                Ok(())
            })
            .unwrap();
        // Also recover a commit whose outbox acknowledgement was lost.
        let PendingContextWrite::Fold(mut write) = fold() else {
            unreachable!()
        };
        write.lifecycle_publication_id = Some("crash-publication".into());
        record(&store, &PendingContextWrite::Fold(write));
        assert!(store.resume_pending_context_write("ses").unwrap());
        store
            .with_context_conn_for_test(|conn| {
                assert_eq!(lifecycle_counts(conn), [1, 1, 1, 0]);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn a_fold_resumed_after_either_crash_window_lands_its_side_channels_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: crate::single_store_schema::STORE_NAMESPACE.to_string(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        let context_path = dir.path().join("context.db");
        let failing = Arc::new(FailNextWrite {
            inner: SqliteContextDomain::open(&context_path).unwrap(),
            fail: AtomicBool::new(true),
        });
        store.install_context_domain(failing);
        let write = fold();

        // Window 1: store.db committed the pending row, then the context.db half never
        // landed. Nothing of the fold is in context.db and the row is still pending.
        record(&store, &write);
        assert!(store.complete_pending_context_write("ses", &write).is_err());
        assert_eq!(counts(&store), [0, 0, 0, 0, 0]);
        assert!(store.has_pending_context_write("ses").unwrap());

        // The resume applies the whole fold, side channels included, once.
        assert!(store.resume_pending_context_write("ses").unwrap());
        assert_eq!(counts(&store), [1, 1, 1, 1, 1]);
        assert!(!store.has_pending_context_write("ses").unwrap());

        // Window 2: the context.db half committed but the process stopped before the
        // pending row was deleted. The resume finds the compartments already in place
        // and must not write any side channel, or the promoted fact, a second time.
        record(&store, &write);
        assert!(store.resume_pending_context_write("ses").unwrap());
        assert_eq!(counts(&store), [1, 1, 1, 1, 1]);
        assert!(!store.has_pending_context_write("ses").unwrap());
    }

    #[test]
    fn a_late_completion_does_not_delete_the_pending_write_another_writer_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: crate::single_store_schema::STORE_NAMESPACE.to_string(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();

        // Writer A records its fold. Before A gets to its own completion, writer B resumes
        // A's row (applying and deleting it) and records a newer write of its own.
        let first = fold();
        record(&store, &first);
        assert!(store.resume_pending_context_write("ses").unwrap());
        let second = PendingContextWrite::TruncateAfter {
            keep_through_seq: 0,
            now_ms: 20,
        };
        record(&store, &second);

        // A's completion now runs. It may only remove the row it recorded, so B's write
        // stays pending until B (or a resume) applies it.
        store.complete_pending_context_write("ses", &first).unwrap();
        let stored: String = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT publish_json FROM mc_single_store_pending_publish WHERE session_id = 'ses'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(stored, serde_json::to_string(&second).unwrap());
    }
}
