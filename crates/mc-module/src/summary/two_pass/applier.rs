//! The shared memory applier's historian paths, as the plugin's
//! `memory/lifecycle-applier.ts` writes them: admitting a candidate fact
//! (`new`, `conflict`), resolving one without a memory write (`covered`,
//! pending, retryable), and committing a gated revision (`edit`, `merge`,
//! `replaces`). Every outcome is a receipt keyed by its decision key, so the
//! same decision never applies twice.
//!
//! These are automated writes: they change memories and their undo history
//! but write no `memory_mutation_log` row, so a session's history head shows
//! them only after its next fold rebuilds the head's frozen baseline message
//! (`m[0]`), never in the changes message after it. A changed memory's
//! embedding is deleted, and the embedding upkeep computes the new one.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::constants::MAX_STAGE2_ATTEMPTS;
use super::gates::{Plan, Revision, Source};
use super::text::{lifecycle_text_hash, split_memory_clauses};
use crate::memory_writes::{
    archive, category_ttl_ms, get_memory, history_json, history_snapshot, insert_memory,
    memory_by_hash, normalized_hash, now_ms, record_history, update_content, History,
};

/// What a decision did, in the plugin's `ApplierReceipt` shape, so either
/// side reads a receipt the other recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    /// `applied`, `covered`, `decided_pending` or `retryable`.
    pub state: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted: Option<bool>,
    pub adoption_class: Option<String>,
}

impl Receipt {
    fn new(state: &str, reason: &str, memory_id: Option<i64>, adoption: Option<&str>) -> Self {
        Self {
            state: state.to_owned(),
            reason: reason.to_owned(),
            memory_id,
            inserted: None,
            adoption_class: adoption.map(str::to_owned),
        }
    }
}

/// When a decision's change may reach a cached prompt
/// (`memoryAdoptionClass`): admissions have none, edits are `live`.
fn adoption(operation: &str) -> Option<&'static str> {
    match operation {
        "new" | "conflict" | "agent_save" | "seen_count" => None,
        "edit" | "merge" | "replaces" | "dashboard_content" | "dashboard_archive" => Some("live"),
        _ => Some("deferred"),
    }
}

/// A second-turn send's hold on a candidate fact. The resolving
/// transaction checks it, so a send that lost the fact (revoked, given up)
/// can't apply anything for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub stage_key: String,
    pub fact_id: i64,
    pub project: String,
    pub attempts: i64,
}

/// Why a decision applied nothing.
#[derive(Debug)]
pub enum Error {
    /// The send no longer holds the fact.
    ReservationLost,
    Store(rusqlite::Error),
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(error)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReservationLost => f.write_str("the send no longer holds the fact"),
            Self::Store(error) => write!(f, "{error}"),
        }
    }
}

fn check_reservation(tx: &Connection, reservation: Option<&Reservation>) -> Result<(), Error> {
    let Some(reservation) = reservation else {
        return Ok(());
    };
    let owned: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM memory_pending_facts f JOIN memory_stage_attempts s ON s.stage_key = f.reserved_stage_key
             WHERE f.id = ?1 AND f.project_path = ?2 AND f.state = 'in_flight' AND f.fact_attempts = ?3
               AND s.stage_key = ?4 AND s.project_path = f.project_path AND s.stage = 'turn_two'
               AND s.state = 'replied'",
            params![reservation.fact_id, reservation.project, reservation.attempts, reservation.stage_key],
            |row| row.get(0),
        )
        .optional()?;
    owned.map(|_| ()).ok_or(Error::ReservationLost)
}

/// The receipt recorded under `key`, if any.
pub fn read_receipt(conn: &Connection, key: &str) -> rusqlite::Result<Option<Receipt>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT receipt_json FROM memory_decision_receipts WHERE decision_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
}

/// What a decision is about.
struct Request<'a> {
    key: &'a str,
    project: &'a str,
    fact_id: Option<i64>,
    operation: &'a str,
}

/// Record `receipt` under the request's key; an applied one goes to the
/// journal too, and the fact (if any) takes the receipt's state and drops
/// its reservation.
fn record(tx: &Transaction, request: &Request<'_>, receipt: Receipt) -> rusqlite::Result<Receipt> {
    let json = serde_json::to_string(&receipt).expect("receipts serialize");
    let now = now_ms();
    tx.execute(
        "INSERT INTO memory_decision_receipts(decision_key, project_path, fact_id, receipt_json, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![request.key, request.project, request.fact_id, json, now],
    )?;
    if receipt.state == "applied" {
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![request.project, request.key, request.operation, json, now],
        )?;
    }
    if let Some(fact) = request.fact_id {
        tx.execute(
            "UPDATE memory_pending_facts
             SET state = ?1, reason = ?2, matched_memory_id = ?3, reserved_stage_key = NULL
             WHERE id = ?4 AND project_path = ?5",
            params![
                receipt.state,
                receipt.reason,
                receipt.memory_id,
                fact,
                request.project
            ],
        )?;
    }
    Ok(receipt)
}

/// A failed revision or charged send: with `retryable`, the fact spends an
/// attempt and is retried while it has attempts left, else it stays pending
/// (`resolveRevisionFailure`).
fn failure(
    tx: &Transaction,
    request: &Request<'_>,
    reason: &str,
    retryable: bool,
) -> rusqlite::Result<Receipt> {
    let mut attempts = 0;
    if let Some(fact) = request.fact_id {
        if retryable {
            tx.execute(
                "UPDATE memory_pending_facts SET fact_attempts = fact_attempts + 1 WHERE id = ?1 AND project_path = ?2",
                params![fact, request.project],
            )?;
        }
        attempts = tx
            .query_row(
                "SELECT fact_attempts FROM memory_pending_facts WHERE id = ?1",
                params![fact],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
    }
    let state = if retryable && attempts < MAX_STAGE2_ATTEMPTS {
        "retryable"
    } else {
        "decided_pending"
    };
    record(
        tx,
        request,
        Receipt::new(state, reason, None, adoption(request.operation)),
    )
}

/// Inside the caller's transaction: charge a fact one attempt for a send
/// that failed as a whole, so it is retried while it has attempts left. A
/// receipt already under `key` wins.
pub fn charge(
    tx: &Transaction,
    key: &str,
    project: &str,
    fact_id: i64,
    reason: &str,
) -> rusqlite::Result<Receipt> {
    if let Some(existing) = read_receipt(tx, key)? {
        return Ok(existing);
    }
    let request = Request {
        key,
        project,
        fact_id: Some(fact_id),
        operation: "turn_two",
    };
    failure(tx, &request, reason, true)
}

/// How a fact resolves without a memory write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// An existing memory states it; only the mapping is kept.
    Covered,
    /// Left for the read-only review list.
    Pending,
    /// Sent again later, with one attempt spent.
    Retryable,
}

/// Resolve a fact without touching any memory (`resolveFactDecision`). A
/// receipt already under `key` wins.
#[allow(clippy::too_many_arguments)]
pub fn resolve(
    conn: &mut Connection,
    key: &str,
    project: &str,
    fact_id: i64,
    reservation: Option<&Reservation>,
    operation: &str,
    resolution: Resolution,
    reason: &str,
    memory_id: Option<i64>,
    mapping: Option<Value>,
) -> Result<Receipt, Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = read_receipt(&tx, key)? {
        return Ok(existing);
    }
    check_reservation(&tx, reservation)?;
    let request = Request {
        key,
        project,
        fact_id: Some(fact_id),
        operation,
    };
    let receipt = match resolution {
        Resolution::Retryable => failure(&tx, &request, reason, true)?,
        Resolution::Covered | Resolution::Pending => {
            let state = if resolution == Resolution::Covered {
                "covered"
            } else {
                "decided_pending"
            };
            let receipt = record(&tx, &request, Receipt::new(state, reason, memory_id, None))?;
            if let Some(mapping) = mapping {
                tx.execute(
                    "UPDATE memory_pending_facts SET mapping_json = ?1 WHERE id = ?2",
                    params![mapping.to_string(), fact_id],
                )?;
            }
            receipt
        }
    };
    tx.commit()?;
    Ok(receipt)
}

/// A candidate fact to admit.
pub struct Admission<'a> {
    pub key: &'a str,
    /// `new` or `conflict`.
    pub operation: &'a str,
    pub project: &'a str,
    pub category: &'a str,
    pub content: &'a str,
    pub source_session: &'a str,
    pub memory_enabled: bool,
    pub auto_promote: bool,
    /// `conflict`: the memory the fact disagrees with.
    pub conflict_target: Option<i64>,
    pub fact_id: i64,
    pub reservation: Option<&'a Reservation>,
    /// The session's writer authority, for a new memory's project-level
    /// placement record, written in the same transaction as the memory.
    pub authority: Option<&'a crate::memory_levels::Authority>,
}

/// The message ordinals a fact's evidence blocks cover.
fn fact_ordinals(tx: &Transaction, fact: i64) -> rusqlite::Result<Vec<(u64, u64)>> {
    tx.prepare_cached(
        "SELECT b.start_ordinal, b.end_ordinal FROM memory_fact_block_links l
         JOIN memory_fact_blocks b ON b.id = l.block_id WHERE l.fact_id = ?1",
    )?
    .query_map(params![fact], |row| Ok((row.get(0)?, row.get(1)?)))?
    .collect()
}

/// Copy a memory's clause evidence from one revision to the next one, for a
/// revision that changed no text.
fn carry_evidence(tx: &Transaction, snapshot: &Value) -> rusqlite::Result<()> {
    let (Some(id), Some(revision)) = (snapshot["id"].as_i64(), snapshot["revision"].as_i64())
    else {
        return Ok(());
    };
    tx.execute(
        "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT memory_id, ?1, clause_ordinal, text_hash, evidence_json FROM memory_clause_evidence
         WHERE memory_id = ?2 AND revision = ?3",
        params![revision + 1, id, revision],
    )?;
    Ok(())
}

/// Admit a candidate fact (`applyMemoryAdmission` for `new` and `conflict`):
/// a live memory with the same text in the category is seen once more
/// instead of a new one; an archived match, a byte-identical memory of
/// another category, or a conflict with itself leaves the fact pending. A
/// conflict links the two memories and advances the other one's revision.
/// Admission changes no existing text, so it writes no mutation-log row.
pub fn admit(conn: &mut Connection, admission: &Admission<'_>) -> Result<Receipt, Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = read_receipt(&tx, admission.key)? {
        return Ok(existing);
    }
    check_reservation(&tx, admission.reservation)?;
    let request = Request {
        key: admission.key,
        project: admission.project,
        fact_id: Some(admission.fact_id),
        operation: admission.operation,
    };
    let pending = |tx: &Transaction, reason: &str, memory: Option<i64>| {
        record(
            tx,
            &request,
            Receipt::new("decided_pending", reason, memory, None),
        )
    };
    let conflict = admission.operation == "conflict";
    let receipt = 'decide: {
        if !admission.memory_enabled {
            break 'decide pending(&tx, "memory_disabled", None)?;
        }
        if admission.content.trim().is_empty() {
            break 'decide pending(&tx, "empty_content", None)?;
        }
        let target = match admission.conflict_target.filter(|_| conflict) {
            Some(id) => get_memory(&tx, id)?,
            None => None,
        };
        if conflict
            && target.as_ref().is_none_or(|target| {
                target.project_path != admission.project || target.status == "archived"
            })
        {
            break 'decide pending(&tx, "conflict_target", None)?;
        }
        if !admission.auto_promote {
            break 'decide pending(
                &tx,
                "auto_promote_disabled",
                target.as_ref().map(|target| target.id),
            )?;
        }
        let hash = normalized_hash(admission.content);
        let matched = memory_by_hash(&tx, admission.project, admission.category, &hash)?;
        if let Some(archived) = matched
            .as_ref()
            .filter(|matched| matched.status == "archived")
        {
            break 'decide pending(&tx, "archived_match", Some(archived.id))?;
        }
        if matched.is_none() {
            let cross: Option<i64> = tx
                .query_row(
                    "SELECT id FROM memories WHERE project_path = ?1 AND category != ?2 AND normalized_hash = ?3
                       AND content = ?4 AND status != 'archived' ORDER BY id LIMIT 1",
                    params![admission.project, admission.category, hash, admission.content],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(cross) = cross {
                break 'decide pending(&tx, "cross_category_match", Some(cross))?;
            }
        }
        if let (Some(target), Some(matched)) = (&target, &matched) {
            if target.id == matched.id {
                break 'decide pending(&tx, "self_conflict", Some(target.id))?;
            }
        }
        let before = match &matched {
            Some(matched) => history_snapshot(&tx, matched.id)?,
            None => None,
        };
        let conflict_before = match &target {
            Some(target) => history_snapshot(&tx, target.id)?,
            None => None,
        };
        let memory_id = match &matched {
            Some(matched) => {
                tx.execute(
                    "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?2, updated_at = ?2,
                            revision = revision + 1
                     WHERE id = ?1",
                    params![matched.id, now_ms()],
                )?;
                matched.id
            }
            None => {
                let memory = insert_memory(
                    &tx,
                    admission.project,
                    admission.category,
                    admission.content,
                    admission.source_session,
                    "historian",
                    None,
                )?;
                if let Some(ttl) = category_ttl_ms(admission.category) {
                    tx.execute(
                        "UPDATE memories SET expires_at = ?2 WHERE id = ?1",
                        params![memory.id, now_ms() + ttl],
                    )?;
                }
                // Turn two's `new` is the two-pass form of fact promotion, so
                // it is placed the same way, with the historian as its actor.
                let ordinals = fact_ordinals(&tx, admission.fact_id)?;
                crate::memory_levels::created(
                    &tx,
                    &crate::memory_levels::Placer {
                        authority: admission.authority,
                        actor: crate::memory_levels::Actor::Historian,
                        session: Some(admission.source_session),
                        ordinals: &ordinals,
                    },
                    memory.id,
                    crate::memory_levels::CreateKind::Create,
                    None,
                    now_ms(),
                )?;
                memory.id
            }
        };
        if let Some(target) = &target {
            tx.execute(
                "INSERT OR IGNORE INTO memory_conflict_links(left_id, right_id, decision_key) VALUES (?1, ?2, ?3)",
                params![memory_id.min(target.id), memory_id.max(target.id), admission.key],
            )?;
            // The relationship changes both memories, so decisions read before it go stale.
            tx.execute(
                "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
                params![target.id],
            )?;
        }
        let mut receipt = Receipt::new(
            "applied",
            if matched.is_some() {
                "live_match"
            } else {
                "inserted"
            },
            Some(memory_id),
            None,
        );
        receipt.inserted = Some(matched.is_none());
        let receipt = record(&tx, &request, receipt)?;
        for snapshot in [&before, &conflict_before].into_iter().flatten() {
            carry_evidence(&tx, snapshot)?;
        }
        let mut befores = vec![before];
        let mut afters = vec![history_snapshot(&tx, memory_id)?];
        if let Some(target) = &target {
            befores.push(conflict_before);
            afters.push(history_snapshot(&tx, target.id)?);
        }
        let mut sources: Vec<i64> = matched.iter().map(|matched| matched.id).collect();
        sources.extend(target.iter().map(|target| target.id));
        let decision = record_history(
            &tx,
            &History {
                key: admission.key,
                project: admission.project,
                writer: "historian",
                operation: admission.operation,
                reason: &receipt.reason,
                now: now_ms(),
                before: &befores,
                after: &afters,
                source_ids: &sources,
                survivor_id: Some(memory_id),
                evidence: json!([]),
            },
        )?;
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![admission.key, history_json(&decision)],
        )?;
        receipt
    };
    tx.commit()?;
    Ok(receipt)
}

/// The sources of a revision as the store holds them now.
pub fn sources(conn: &Connection, expected: &[(i64, i64)]) -> rusqlite::Result<Vec<Source>> {
    let mut found = Vec::new();
    for (id, _) in expected {
        let row = conn
            .query_row(
                "SELECT id, revision, project_path, COALESCE(status, 'active'), content FROM memories WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Source {
                        id: row.get(0)?,
                        revision: row.get(1)?,
                        project: row.get(2)?,
                        status: row.get(3)?,
                        content: row.get(4)?,
                    })
                },
            )
            .optional()?;
        found.extend(row);
    }
    Ok(found)
}

/// Record that a revision failed before it changed anything: `retryable`
/// spends an attempt (a compare-and-swap loss, a check transport failure),
/// otherwise the fact stays pending (a gate or check refusal).
pub fn revision_failed(
    conn: &mut Connection,
    decision: &Revision,
    fact_id: i64,
    reservation: Option<&Reservation>,
    reason: &str,
    retryable: bool,
) -> Result<Receipt, Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = read_receipt(&tx, &decision.key)? {
        return Ok(existing);
    }
    check_reservation(&tx, reservation)?;
    let request = Request {
        key: &decision.key,
        project: &decision.project,
        fact_id: Some(fact_id),
        operation: &decision.action,
    };
    let receipt = failure(&tx, &request, reason, retryable)?;
    tx.commit()?;
    Ok(receipt)
}

/// The safety assessment a survivor inherits: true when any source is, false
/// only when every source was assessed false, else unknown; a true one keeps
/// importance at least 80 (`inheritMemorySafety`). `None` on a store without
/// the assessment column.
fn inherited_safety(
    tx: &Transaction,
    ids: &[i64],
    importance: Option<i64>,
) -> rusqlite::Result<Option<(Option<i64>, Option<i64>)>> {
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('memories') WHERE name = 'safety_critical')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        return Ok(None);
    }
    let mut flags = Vec::new();
    for id in ids {
        let flag: Option<i64> = tx.query_row(
            "SELECT safety_critical FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        flags.push(flag);
    }
    let safety = if flags.contains(&Some(1)) {
        Some(1)
    } else if !flags.is_empty() && flags.iter().all(|flag| *flag == Some(0)) {
        Some(0)
    } else {
        None
    };
    let importance = if safety == Some(1) {
        Some(importance.unwrap_or(50).max(80))
    } else {
        importance
    };
    Ok(Some((safety, importance)))
}

/// Commit a revision that passed its gates and checks
/// (`commitMemoryRevision`), after checking every source is still live at
/// the revision the decision read; one that moved is a compare-and-swap
/// loss and the fact is retried. `edit` rewrites the survivor; `merge`
/// rewrites the survivor and archives the other sources as superseded by
/// it; `replaces` inserts a new memory and archives the source as superseded
/// by it. Kept clauses keep their evidence, and the survivor inherits the
/// sources' safety assessment.
pub fn commit_revision(
    conn: &mut Connection,
    decision: &Revision,
    plan: &Plan,
    fact_id: i64,
    reservation: Option<&Reservation>,
    authority: Option<&crate::memory_levels::Authority>,
) -> Result<Receipt, Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = read_receipt(&tx, &decision.key)? {
        return Ok(existing);
    }
    check_reservation(&tx, reservation)?;
    let request = Request {
        key: &decision.key,
        project: &decision.project,
        fact_id: Some(fact_id),
        operation: &decision.action,
    };
    let current = sources(&tx, &decision.expected)?;
    let moved = current.len() != decision.expected.len()
        || decision.expected.iter().any(|(id, revision)| {
            !current.iter().any(|source| {
                source.id == *id
                    && source.revision == *revision
                    && source.project == decision.project
                    && source.status != "archived"
            })
        });
    if moved {
        let receipt = failure(&tx, &request, "cas_loss", true)?;
        tx.commit()?;
        return Ok(receipt);
    }
    // A replacement's sources must share one owner, which the new row takes.
    let owner = if decision.action == "replaces" {
        let ids: Vec<i64> = current.iter().map(|source| source.id).collect();
        match crate::memory_levels::merge_owner(&tx, &ids, &decision.project, authority) {
            Ok(owner) => owner,
            Err(error)
                if crate::memory_levels::refusal_code(&error).as_deref()
                    == Some("merge_owner_mismatch") =>
            {
                let receipt = failure(&tx, &request, "merge_owner_mismatch", false)?;
                tx.commit()?;
                return Ok(receipt);
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    let mut before: Vec<Option<Value>> = Vec::new();
    for source in &current {
        before.push(history_snapshot(&tx, source.id)?);
    }
    let survivor =
        get_memory(&tx, decision.survivor)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let survivor_importance: Option<i64> = tx.query_row(
        "SELECT importance FROM memories WHERE id = ?1",
        params![survivor.id],
        |row| row.get(0),
    )?;
    let safety = inherited_safety(
        &tx,
        &current.iter().map(|source| source.id).collect::<Vec<_>>(),
        if decision.action == "replaces" {
            Some(50)
        } else {
            survivor_importance
        },
    )?;
    let survivor_id = if decision.action == "replaces" {
        let expires: Option<i64> = tx.query_row(
            "SELECT expires_at FROM memories WHERE id = ?1",
            params![survivor.id],
            |row| row.get(0),
        )?;
        let inserted = insert_memory(
            &tx,
            &decision.project,
            &survivor.category,
            &decision.final_text,
            "",
            "historian",
            None,
        )?;
        tx.execute(
            "UPDATE memories SET expires_at = ?2, source_session_id = NULL WHERE id = ?1",
            params![inserted.id, expires],
        )?;
        crate::memory_levels::created(
            &tx,
            &crate::memory_levels::Placer {
                authority,
                actor: crate::memory_levels::Actor::Historian,
                session: None,
                ordinals: &[],
            },
            inserted.id,
            crate::memory_levels::CreateKind::MergeSurvivor,
            owner.as_ref(),
            now_ms(),
        )?;
        inserted.id
    } else {
        survivor.id
    };
    let survivor_revision = if decision.action == "replaces" {
        1
    } else {
        decision
            .expected
            .iter()
            .find(|(id, _)| *id == survivor_id)
            .map_or(1, |(_, revision)| revision + 1)
    };
    let kept: std::collections::BTreeSet<String> = plan
        .kept
        .iter()
        .map(|operand| lifecycle_text_hash(&operand.text))
        .collect();
    let mut inherited: Vec<(String, String)> = Vec::new();
    for source in &current {
        let mut statement = tx.prepare_cached(
            "SELECT text_hash, evidence_json FROM memory_clause_evidence WHERE memory_id = ?1 AND revision = ?2",
        )?;
        let rows = statement.query_map(params![source.id, source.revision], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            inherited.push(row?);
        }
    }
    for source in &current {
        if source.id == survivor_id {
            update_content(
                &tx,
                source.id,
                &decision.final_text,
                &normalized_hash(&decision.final_text),
            )?;
            tx.execute(
                "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
                params![source.id],
            )?;
        } else {
            let row = get_memory(&tx, source.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            archive(&tx, &row, Some(&decision.action))?;
            tx.execute(
                "DELETE FROM memory_embeddings WHERE memory_id = ?1",
                params![source.id],
            )?;
            tx.execute(
                "UPDATE memories SET revision = revision + 1, superseded_by_memory_id = ?2 WHERE id = ?1",
                params![source.id, survivor_id],
            )?;
            tx.execute(
                "INSERT INTO memory_successor_links(source_id, successor_id, decision_key) VALUES (?1, ?2, ?3)",
                params![source.id, survivor_id, decision.key],
            )?;
        }
    }
    for clause in split_memory_clauses(&decision.final_text) {
        let hash = lifecycle_text_hash(&clause.text);
        if !kept.contains(&hash) {
            continue;
        }
        let evidence: Vec<Value> = inherited
            .iter()
            .filter(|(text_hash, _)| *text_hash == hash)
            .filter_map(|(_, json)| serde_json::from_str(json).ok())
            .collect();
        if !evidence.is_empty() {
            tx.execute(
                "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![survivor_id, survivor_revision, clause.ordinal as i64, hash, Value::from(evidence).to_string()],
            )?;
        }
    }
    match safety {
        Some((flag, importance)) => {
            tx.execute(
                "UPDATE memories SET safety_critical = ?2, importance = ?3 WHERE id = ?1",
                params![survivor_id, flag, importance],
            )?;
        }
        None => {
            if decision.action == "replaces" {
                tx.execute(
                    "UPDATE memories SET importance = 50 WHERE id = ?1",
                    params![survivor_id],
                )?;
            }
        }
    }
    let mut after: Vec<Option<Value>> = Vec::new();
    for source in &current {
        after.push(history_snapshot(&tx, source.id)?);
    }
    if !current.iter().any(|source| source.id == survivor_id) {
        before.push(None);
        after.push(history_snapshot(&tx, survivor_id)?);
    }
    let receipt = record(
        &tx,
        &request,
        Receipt::new("applied", &decision.action, Some(survivor_id), Some("live")),
    )?;
    let history = record_history(
        &tx,
        &History {
            key: &decision.key,
            project: &decision.project,
            writer: "historian",
            operation: &decision.action,
            reason: &decision.action,
            now: now_ms(),
            before: &before,
            after: &after,
            source_ids: &current.iter().map(|source| source.id).collect::<Vec<_>>(),
            survivor_id: Some(survivor_id),
            evidence: serde_json::to_value(&plan.spans).expect("spans serialize"),
        },
    )?;
    tx.execute(
        "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
        params![decision.key, history_json(&history)],
    )?;
    tx.commit()?;
    Ok(receipt)
}
