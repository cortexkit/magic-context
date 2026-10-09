//! The module's memory applier: the one path every module memory admission takes.
//!
//! This is the Rust twin of `applyMemoryAdmission` in
//! `packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts`. It applies
//! the same receipt rules, writes the same `context.db` tables, and records receipts the
//! TypeScript applier can read back:
//!
//! - A decision key that already has a receipt returns that receipt and writes nothing, so a
//!   retried write applies at most once.
//! - The module writes nothing to `memories` for a project it does not own
//!   ([`super::authority::module_owns_memory`]); the receipt is `retryable` with reason
//!   `authority_elsewhere`.
//! - A live row with the same project, category and normalized hash has its `seen_count`
//!   bumped once and nothing is inserted. A matching archived row writes nothing and leaves
//!   the decision `decided_pending` with the archived id; so does a live byte-identical row
//!   in another category.
//! - Admission writes no mutation-log row and bumps no epoch: new rows surface through
//!   the existing max-memory-id watermark, so admission never invalidates a cached prompt.
//!
//! The caller owns the transaction. Every function here must run inside one `context.db`
//! write transaction that also commits the caller's own rows.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::authority::module_owns_memory;
use crate::compute_normalized_memory_hash;

/// The `context.db` tables an admission may write, for the module's per-table schema
/// fence. A caller passes these to its write transaction.
pub const ADMISSION_TABLES: &[&str] = &[
    "memories",
    "memory_embedding_watermarks",
    "memory_decision_receipts",
    "memory_journal",
    "memory_pending_facts",
    "memory_conflict_links",
    "memory_classification_items",
];

/// Reason recorded when the module is not the project's memory authority.
pub const AUTHORITY_ELSEWHERE: &str = "authority_elsewhere";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptState {
    Applied,
    Covered,
    DecidedPending,
    Retryable,
}

/// When a mutation-log row may surface in a cached prompt. Admission has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdoptionClass {
    Live,
    Deferred,
}

/// The outcome of one applier decision, serialized as the TypeScript applier's
/// `ApplierReceipt` so either side can read a receipt the other recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplierReceipt {
    pub state: ReceiptState,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted: Option<bool>,
    pub adoption_class: Option<AdoptionClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_ids: Option<Vec<i64>>,
}

impl ApplierReceipt {
    pub fn is_applied(&self) -> bool {
        self.state == ReceiptState::Applied
    }

    /// The memory id of an applied receipt.
    pub fn applied_memory_id(&self) -> Option<i64> {
        self.is_applied().then_some(self.memory_id).flatten()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionOperation {
    /// A historian fact admitted as a new memory.
    New,
    /// A historian fact that disagrees with an existing memory: admitted beside it with a
    /// conflict link, never replacing it.
    Conflict,
    /// An agent's `ctx_memory` save.
    AgentSave,
}

impl AdmissionOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            AdmissionOperation::New => "new",
            AdmissionOperation::Conflict => "conflict",
            AdmissionOperation::AgentSave => "agent_save",
        }
    }
}

/// Where an agent save happened, so the historian can score it later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassificationAnchor<'a> {
    pub tool_call_part_id: &'a str,
    pub save_ordinal: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AdmissionRequest<'a> {
    /// The decision key the receipt is recorded under. Reusing a key returns the recorded
    /// receipt instead of applying again.
    pub key: &'a str,
    pub operation: AdmissionOperation,
    pub project_path: &'a str,
    pub category: &'a str,
    pub content: &'a str,
    /// Defaults to 50, the host's insert default.
    pub importance: Option<i64>,
    pub source_session_id: Option<&'a str>,
    /// Defaults to `agent` for an agent save and `historian` otherwise.
    pub source_type: Option<&'a str>,
    pub expires_at: Option<i64>,
    pub metadata_json: Option<&'a str>,
    pub now_ms: i64,
    /// `Some(false)` when memory is disabled for the project: nothing applies.
    pub memory_enabled: Option<bool>,
    /// `Some(false)` mirrors `memory.auto_promote: false`: historian admissions stay
    /// pending. An agent save is an explicit user action and ignores it.
    pub auto_promote: Option<bool>,
    pub conflict_target_id: Option<i64>,
    /// The pending-fact row this decision resolves, if any.
    pub fact_id: Option<i64>,
    pub classification_anchor: Option<ClassificationAnchor<'a>>,
}

impl<'a> AdmissionRequest<'a> {
    /// A request with every optional field unset.
    pub fn new(
        key: &'a str,
        operation: AdmissionOperation,
        project_path: &'a str,
        category: &'a str,
        content: &'a str,
        now_ms: i64,
    ) -> Self {
        AdmissionRequest {
            key,
            operation,
            project_path,
            category,
            content,
            importance: None,
            source_session_id: None,
            source_type: None,
            expires_at: None,
            metadata_json: None,
            now_ms,
            memory_enabled: None,
            auto_promote: None,
            conflict_target_id: None,
            fact_id: None,
            classification_anchor: None,
        }
    }
}

/// A process-unique decision key for a write that has no natural key of its own. Such a
/// write is not retried under the same key, so it may apply again on a retry, as the
/// TypeScript tool's random key does.
pub fn fresh_decision_key(prefix: &str, now_ms: i64) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    format!(
        "{prefix}:{now_ms}:{}:{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

/// The memory-op adoption class a receipt records, as `memoryAdoptionClass` assigns it.
pub fn memory_adoption_class(operation: &str) -> Option<AdoptionClass> {
    match operation {
        "new" | "conflict" | "agent_save" | "seen_count" => None,
        "edit" | "merge" | "replaces" | "dashboard_content" | "dashboard_archive" => {
            Some(AdoptionClass::Live)
        }
        _ => Some(AdoptionClass::Deferred),
    }
}

/// The receipt recorded under `key`, if any.
pub fn read_receipt(conn: &Connection, key: &str) -> rusqlite::Result<Option<ApplierReceipt>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT receipt_json FROM memory_decision_receipts WHERE decision_key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| {
        serde_json::from_str(&json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
        })
    })
    .transpose()
}

struct ReceiptContext<'a> {
    key: &'a str,
    project_path: &'a str,
    fact_id: Option<i64>,
    operation: &'a str,
    now_ms: i64,
}

fn record_receipt(
    conn: &Connection,
    context: &ReceiptContext<'_>,
    receipt: ApplierReceipt,
) -> rusqlite::Result<ApplierReceipt> {
    let json = serde_json::to_string(&receipt)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
    conn.execute(
        "INSERT INTO memory_decision_receipts(decision_key, project_path, fact_id, receipt_json, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![context.key, context.project_path, context.fact_id, json, context.now_ms],
    )?;
    if receipt.is_applied() {
        conn.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                context.project_path,
                context.key,
                context.operation,
                json,
                context.now_ms
            ],
        )?;
    }
    if let Some(fact_id) = context.fact_id {
        conn.execute(
            "UPDATE memory_pending_facts
                SET state = ?1, reason = ?2, matched_memory_id = ?3, reserved_stage_key = NULL
              WHERE id = ?4 AND project_path = ?5",
            params![
                state_name(receipt.state),
                receipt.reason,
                receipt.memory_id,
                fact_id,
                context.project_path
            ],
        )?;
    }
    Ok(receipt)
}

fn state_name(state: ReceiptState) -> &'static str {
    match state {
        ReceiptState::Applied => "applied",
        ReceiptState::Covered => "covered",
        ReceiptState::DecidedPending => "decided_pending",
        ReceiptState::Retryable => "retryable",
    }
}

/// JavaScript's `String.prototype.trim` whitespace, so "empty content" means what it
/// means to the TypeScript applier.
fn is_blank(text: &str) -> bool {
    text.chars().all(|ch| {
        matches!(
            ch,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

/// Admit one memory, or record why it was not admitted. See the module documentation for
/// the rules; they are the TypeScript applier's, rule for rule.
pub fn apply_memory_admission_tx(
    conn: &Connection,
    request: &AdmissionRequest<'_>,
) -> rusqlite::Result<ApplierReceipt> {
    if let Some(existing) = read_receipt(conn, request.key)? {
        return Ok(existing);
    }
    let context = ReceiptContext {
        key: request.key,
        project_path: request.project_path,
        fact_id: request.fact_id,
        operation: request.operation.as_str(),
        now_ms: request.now_ms,
    };
    let record = |receipt: ApplierReceipt| record_receipt(conn, &context, receipt);
    let pending = |reason: &str, memory_id: Option<i64>| {
        record(ApplierReceipt {
            state: ReceiptState::DecidedPending,
            reason: reason.to_string(),
            memory_id,
            inserted: None,
            adoption_class: None,
            superseded_ids: None,
        })
    };
    if request.memory_enabled == Some(false) {
        return pending("memory_disabled", None);
    }
    if !module_owns_memory(conn, request.project_path)? {
        return record(ApplierReceipt {
            state: ReceiptState::Retryable,
            reason: AUTHORITY_ELSEWHERE.to_string(),
            memory_id: None,
            inserted: None,
            adoption_class: None,
            superseded_ids: None,
        });
    }
    if is_blank(request.content) {
        return pending("empty_content", None);
    }
    let target = if request.operation == AdmissionOperation::Conflict {
        let row: Option<(i64, String, String)> = conn
            .query_row(
                "SELECT id, project_path, status FROM memories WHERE id = ?1",
                [request.conflict_target_id.unwrap_or(-1)],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match row {
            Some((id, project, status))
                if project == request.project_path && status != "archived" =>
            {
                Some(id)
            }
            _ => return pending("conflict_target", None),
        }
    } else {
        None
    };
    if request.operation != AdmissionOperation::AgentSave && request.auto_promote == Some(false) {
        return pending("auto_promote_disabled", target);
    }
    if let (AdmissionOperation::AgentSave, Some(anchor)) =
        (request.operation, request.classification_anchor)
    {
        let prior: Option<i64> = conn
            .query_row(
                "SELECT memory_id FROM memory_classification_items
                  WHERE project_path = ?1 AND source_session_id = ?2 AND tool_call_part_id = ?3",
                params![
                    request.project_path,
                    request.source_session_id.unwrap_or(""),
                    anchor.tool_call_part_id
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(memory_id) = prior {
            return record(ApplierReceipt {
                state: ReceiptState::Applied,
                reason: "saved".to_string(),
                memory_id: Some(memory_id),
                inserted: Some(false),
                adoption_class: None,
                superseded_ids: None,
            });
        }
    }
    let hash = compute_normalized_memory_hash(request.content);
    let matched: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, status FROM memories
              WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3",
            params![request.project_path, request.category, hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((id, status)) = &matched {
        if status == "archived" {
            return pending("archived_match", Some(*id));
        }
    }
    if matched.is_none() {
        let cross: Option<i64> = conn
            .query_row(
                "SELECT id FROM memories
                  WHERE project_path = ?1 AND category != ?2 AND normalized_hash = ?3
                    AND content = ?4 AND status != 'archived'
                  ORDER BY id LIMIT 1",
                params![
                    request.project_path,
                    request.category,
                    hash,
                    request.content
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = cross {
            return pending("cross_category_match", Some(id));
        }
    }
    let matched_id = matched.map(|(id, _)| id);
    if let (Some(target), Some(id)) = (target, matched_id) {
        if target == id {
            return pending("self_conflict", Some(target));
        }
    }
    let memory_id = match matched_id {
        Some(id) => {
            conn.execute(
                "UPDATE memories
                    SET seen_count = COALESCE(seen_count, 0) + 1, last_seen_at = ?1, updated_at = ?1
                  WHERE id = ?2",
                params![request.now_ms, id],
            )?;
            id
        }
        None => {
            let agent = request.operation == AdmissionOperation::AgentSave;
            conn.execute(
                "INSERT INTO memories
                   (project_path, category, content, normalized_hash, importance, source_session_id,
                    source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                    last_seen_at, last_retrieved_at, status, expires_at, verification_status,
                    verified_at, superseded_by_memory_id, merged_from, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?8, ?8, ?8, NULL, 'active',
                         ?9, 'unverified', NULL, NULL, NULL, ?10)",
                params![
                    request.project_path,
                    request.category,
                    request.content,
                    hash,
                    request.importance.unwrap_or(50),
                    request.source_session_id,
                    request
                        .source_type
                        .unwrap_or(if agent { "agent" } else { "historian" }),
                    request.now_ms,
                    request.expires_at,
                    request.metadata_json,
                ],
            )?;
            conn.last_insert_rowid()
        }
    };
    if let Some(target) = target {
        conn.execute(
            "INSERT OR IGNORE INTO memory_conflict_links(left_id, right_id, decision_key)
             VALUES (?1, ?2, ?3)",
            params![memory_id.min(target), memory_id.max(target), request.key],
        )?;
    }
    if let (AdmissionOperation::AgentSave, Some(anchor)) =
        (request.operation, request.classification_anchor)
    {
        conn.execute(
            "INSERT OR IGNORE INTO memory_classification_items
               (project_path, memory_id, saved_revision, source_session_id, tool_call_part_id, save_ordinal)
             SELECT project_path, id, revision, ?1, ?2, ?3 FROM memories WHERE id = ?4",
            params![
                request.source_session_id.unwrap_or(""),
                anchor.tool_call_part_id,
                anchor.save_ordinal,
                memory_id
            ],
        )?;
    }
    record(ApplierReceipt {
        state: ReceiptState::Applied,
        reason: if matched_id.is_some() {
            "live_match"
        } else {
            "inserted"
        }
        .to_string(),
        memory_id: Some(memory_id),
        inserted: Some(matched_id.is_none()),
        adoption_class: None,
        superseded_ids: None,
    })
}
