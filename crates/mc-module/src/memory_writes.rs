//! Agent memory writes on `context.db`: a save, and an update, archive or
//! merge. This is the TypeScript applier's agent path
//! (`features/magic-context/memory/lifecycle-applier.ts`), row for row,
//! because the standalone plugin writes the same tables: each write keeps
//! the memory's revision, its undo history, the decision receipt and
//! journal entry, and the memory-mutation-log rows. How a change reaches a
//! prompt is the history head's business: every session that shows the
//! memory sees the change in its `m[1]` on its next rebuild. Each runs in one
//! `BEGIN IMMEDIATE` transaction, so it lands whole or not at all.
//!
//! Embeddings are not computed here: a changed memory's vector is deleted,
//! and the embedding upkeep computes the new one.

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};

/// The categories a memory row may hold; history refuses a snapshot outside them.
const KNOWN_CATEGORIES: [&str; 12] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONFIG_VALUES",
    "ARCHITECTURE_DECISIONS",
    "CONSTRAINTS",
    "CONFIG_DEFAULTS",
    "NAMING",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

/// Whether JavaScript's `\s` matches `ch`. It differs from
/// `char::is_whitespace` in two code points: U+FEFF counts here and U+0085
/// does not.
fn is_js_whitespace(ch: char) -> bool {
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
}

/// The duplicate key of a memory's text: MD5 of the lowercased text with
/// whitespace runs collapsed, as the TypeScript plugin computes it.
pub fn normalized_hash(content: &str) -> String {
    let normalized = content
        .to_lowercase()
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    format!("{:032x}", md5::compute(normalized.as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRow {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub status: String,
    pub verification_status: String,
    pub superseded_by_memory_id: Option<i64>,
    pub revision: i64,
    pub seen_count: i64,
    pub retrieval_count: i64,
    pub merged_from: Option<String>,
    pub metadata_json: Option<String>,
    pub updated_at: i64,
}

impl MemoryRow {
    /// Active or permanent, and not replaced by another memory.
    pub fn is_mutable(&self) -> bool {
        matches!(self.status.as_str(), "active" | "permanent")
            && self.superseded_by_memory_id.is_none()
    }
}

const ROW_COLUMNS: &str = "id, project_path, category, content, normalized_hash,
    COALESCE(status, 'active'), COALESCE(verification_status, 'unverified'), superseded_by_memory_id,
    revision, COALESCE(seen_count, 1), COALESCE(retrieval_count, 0), merged_from, metadata_json, updated_at";

fn row(row: &Row) -> rusqlite::Result<MemoryRow> {
    Ok(MemoryRow {
        id: row.get(0)?,
        project_path: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        normalized_hash: row.get(4)?,
        status: row.get(5)?,
        verification_status: row.get(6)?,
        superseded_by_memory_id: row.get(7)?,
        revision: row.get(8)?,
        seen_count: row.get(9)?,
        retrieval_count: row.get(10)?,
        merged_from: row.get(11)?,
        metadata_json: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub fn get_memory(conn: &Connection, id: i64) -> rusqlite::Result<Option<MemoryRow>> {
    conn.query_row(
        &format!("SELECT {ROW_COLUMNS} FROM memories WHERE id = ?1"),
        params![id],
        row,
    )
    .optional()
}

fn memory_by_hash(
    conn: &Connection,
    project: &str,
    category: &str,
    hash: &str,
) -> rusqlite::Result<Option<MemoryRow>> {
    conn.query_row(
        &format!(
            "SELECT {ROW_COLUMNS} FROM memories WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3"
        ),
        params![project, category, hash],
        row,
    )
    .optional()
}

/// The memory row as undo history stores it: the shared field set, or
/// nothing when the row holds a value history cannot restore.
fn history_snapshot(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    const TEXT: [&str; 10] = [
        "projectPath",
        "category",
        "content",
        "normalizedHash",
        "scope",
        "sourceSessionId",
        "sourceType",
        "status",
        "verificationStatus",
        "mergedFrom",
    ];
    const NULLABLE: [&str; 9] = [
        "importance",
        "sourceSessionId",
        "sourceType",
        "lastRetrievedAt",
        "expiresAt",
        "verifiedAt",
        "supersededByMemoryId",
        "mergedFrom",
        "metadataJson",
    ];
    const FIELDS: [&str; 25] = [
        "id",
        "projectPath",
        "revision",
        "category",
        "content",
        "normalizedHash",
        "importance",
        "scope",
        "shareable",
        "sourceSessionId",
        "sourceType",
        "seenCount",
        "retrievalCount",
        "firstSeenAt",
        "createdAt",
        "updatedAt",
        "lastSeenAt",
        "lastRetrievedAt",
        "status",
        "expiresAt",
        "verificationStatus",
        "verifiedAt",
        "supersededByMemoryId",
        "mergedFrom",
        "metadataJson",
    ];
    let snake = |field: &str| {
        field
            .chars()
            .flat_map(|ch| {
                if ch.is_ascii_uppercase() {
                    vec!['_', ch.to_ascii_lowercase()]
                } else {
                    vec![ch]
                }
            })
            .collect::<String>()
    };
    let mut statement = conn.prepare_cached("SELECT * FROM memories WHERE id = ?1")?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let values: Option<Vec<rusqlite::types::Value>> = statement
        .query_row(params![id], |row| {
            (0..names.len()).map(|index| row.get(index)).collect()
        })
        .optional()?;
    let Some(values) = values else {
        return Ok(None);
    };
    let mut snapshot = Map::new();
    for field in FIELDS {
        let column = snake(field);
        let value = names
            .iter()
            .position(|name| *name == column)
            .map(|index| &values[index]);
        let json = match value {
            None | Some(rusqlite::types::Value::Null) if NULLABLE.contains(&field) => Value::Null,
            Some(rusqlite::types::Value::Integer(number)) if !TEXT.contains(&field) => {
                json!(number)
            }
            Some(rusqlite::types::Value::Text(text))
                if TEXT.contains(&field) || field == "metadataJson" =>
            {
                json!(text)
            }
            _ => return Ok(None),
        };
        snapshot.insert(field.to_owned(), json);
    }
    let valid = snapshot["id"].as_i64() > Some(0)
        && snapshot["revision"].as_i64() > Some(0)
        && KNOWN_CATEGORIES.contains(&snapshot["category"].as_str().unwrap_or(""))
        && ["active", "permanent", "archived"].contains(&snapshot["status"].as_str().unwrap_or(""))
        && ["project", "ecosystem", "universe"].contains(&snapshot["scope"].as_str().unwrap_or(""))
        && [Some(0), Some(1)].contains(&snapshot["shareable"].as_i64());
    Ok(valid.then_some(Value::Object(snapshot)))
}

/// Recursively key-sorted JSON, the bytes both writers persist.
fn history_json(value: &Value) -> String {
    // serde_json's map keeps keys sorted, so plain serialization sorts them.
    serde_json::to_string(value).unwrap_or_default()
}

/// What a write did, as the decision receipt records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub applied: bool,
    pub reason: String,
    pub memory_id: Option<i64>,
    pub inserted: bool,
    pub superseded_ids: Vec<i64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// A fresh decision key, unique per write.
fn decision_key() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "ck-mc:{}:{}:{}",
        std::process::id(),
        now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn record_receipt(
    tx: &Transaction,
    key: &str,
    project: &str,
    operation: &str,
    receipt_json: &Value,
    applied: bool,
) -> rusqlite::Result<()> {
    let json = receipt_json.to_string();
    let now = now_ms();
    tx.execute(
        "INSERT INTO memory_decision_receipts(decision_key, project_path, fact_id, receipt_json, resolved_at)
         VALUES (?1, ?2, NULL, ?3, ?4)",
        params![key, project, json, now],
    )?;
    if applied {
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project, key, operation, json, now],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn queue_mutation(
    tx: &Transaction,
    project: &str,
    kind: &str,
    target: i64,
    superseded_by: Option<i64>,
    category: Option<&str>,
    content: Option<&str>,
    operation: Option<&str>,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO memory_mutation_log
            (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at, operation_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![project, kind, target, superseded_by, category, content, now_ms(), operation],
    )?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![name],
        |row| row.get(0),
    )
}

/// What a classification, verification, share decision or embedding said
/// about the old text no longer holds for the new one.
fn clear_derived(tx: &Transaction, id: i64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE memories SET shareable = 0, classified_at = NULL WHERE id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![id],
    )?;
    if table_exists(tx, "memory_verifications")? {
        tx.execute(
            "DELETE FROM memory_verifications WHERE memory_id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

fn update_content(tx: &Transaction, id: i64, content: &str, hash: &str) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE memories SET content = ?2, normalized_hash = ?3, updated_at = ?4, shareable = 0,
                classified_at = NULL, mural_cue = NULL, mural_cue_hash = NULL, mural_cue_at = NULL,
                mural_cue_rejection_count = 0
          WHERE id = ?1",
        params![id, content, hash, now_ms()],
    )?;
    if table_exists(tx, "memory_verifications")? {
        tx.execute(
            "DELETE FROM memory_verifications WHERE memory_id = ?1",
            params![id],
        )?;
    }
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![id],
    )?;
    Ok(())
}

fn archive(tx: &Transaction, memory: &MemoryRow, reason: Option<&str>) -> rusqlite::Result<()> {
    match reason.map(str::trim).filter(|reason| !reason.is_empty()) {
        None => tx.execute(
            "UPDATE memories SET status = 'archived', updated_at = ?2 WHERE id = ?1",
            params![memory.id, now_ms()],
        )?,
        Some(reason) => {
            let mut metadata: Map<String, Value> = memory
                .metadata_json
                .as_deref()
                .and_then(|json| serde_json::from_str(json).ok())
                .unwrap_or_default();
            metadata.insert("archive_reason".into(), json!(reason));
            tx.execute(
                "UPDATE memories SET status = 'archived', metadata_json = ?2, updated_at = ?3 WHERE id = ?1",
                params![memory.id, Value::Object(metadata).to_string(), now_ms()],
            )?
        }
    };
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_memory(
    tx: &Transaction,
    project: &str,
    category: &str,
    content: &str,
    session: &str,
    source_type: &str,
    importance: Option<i64>,
) -> rusqlite::Result<MemoryRow> {
    let now = now_ms();
    tx.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id,
                               source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                               last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at,
                               superseded_by_memory_id, merged_from, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?8, ?8, ?8, NULL, 'active', NULL, 'unverified', NULL, NULL, NULL, NULL)",
        params![project, category, content, normalized_hash(content), importance.unwrap_or(50), session, source_type, now],
    )?;
    let id = tx.last_insert_rowid();
    get_memory(tx, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Who writes: the session and the project its memories belong to.
pub struct Writer<'a> {
    pub harness: &'a str,
    pub session: &'a str,
    pub project: &'a str,
}

fn immediate(conn: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
}

/// Save a memory the agent asked for. A memory with the same text in the
/// category bumps that memory's seen count instead.
pub fn save(
    conn: &mut Connection,
    who: &Writer,
    category: &str,
    content: &str,
) -> rusqlite::Result<Receipt> {
    let key = decision_key();
    let tx = immediate(conn)?;
    let pending = |tx: &Transaction,
                   reason: &str,
                   memory_id: Option<i64>|
     -> rusqlite::Result<Receipt> {
        record_receipt(
            tx,
            &key,
            who.project,
            "agent_save",
            &json!({"state": "decided_pending", "reason": reason, "memoryId": memory_id, "adoptionClass": null}),
            false,
        )?;
        Ok(Receipt {
            applied: false,
            reason: reason.to_owned(),
            memory_id,
            inserted: false,
            superseded_ids: Vec::new(),
        })
    };
    let hash = normalized_hash(content);
    let matched = memory_by_hash(&tx, who.project, category, &hash)?;
    if matched
        .as_ref()
        .is_some_and(|memory| memory.status == "archived")
    {
        let receipt = pending(&tx, "archived_match", matched.map(|memory| memory.id))?;
        tx.commit()?;
        return Ok(receipt);
    }
    if matched.is_none() {
        let cross: Option<i64> = tx
            .query_row(
                "SELECT id FROM memories WHERE project_path = ?1 AND category != ?2 AND normalized_hash = ?3
                    AND content = ?4 AND status != 'archived' ORDER BY id LIMIT 1",
                params![who.project, category, hash, content],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(cross) = cross {
            let receipt = pending(&tx, "cross_category_match", Some(cross))?;
            tx.commit()?;
            return Ok(receipt);
        }
    }
    let memory = match &matched {
        Some(memory) => {
            let now = now_ms();
            tx.execute(
                "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![memory.id, now],
            )?;
            get_memory(&tx, memory.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?
        }
        None => insert_memory(
            &tx,
            who.project,
            category,
            content,
            who.session,
            "agent",
            Some(50),
        )?,
    };
    let reason = if matched.is_some() {
        "live_match"
    } else {
        "inserted"
    };
    record_receipt(
        &tx,
        &key,
        who.project,
        "agent_save",
        &json!({"state": "applied", "reason": reason, "memoryId": memory.id, "inserted": matched.is_none(), "adoptionClass": null}),
        true,
    )?;
    tx.commit()?;
    Ok(Receipt {
        applied: true,
        reason: reason.to_owned(),
        memory_id: Some(memory.id),
        inserted: matched.is_none(),
        superseded_ids: Vec::new(),
    })
}

/// An agent's update, archive or merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Update,
    Archive,
    Merge,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Operation::Update => "update",
            Operation::Archive => "archive",
            Operation::Merge => "merge",
        }
    }
}

/// Why a mutation did not apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// The new text already exists as this memory.
    Duplicate(i64),
    /// A recorded reason, as the receipt holds it.
    Pending(String),
}

/// An agent's update, archive or merge, as the tool call asked for it.
pub struct Change<'a> {
    pub operation: Operation,
    /// Each target memory, with the revision the caller read.
    pub targets: &'a [(i64, i64)],
    pub content: Option<&'a str>,
    pub category: Option<&'a str>,
    pub reason: Option<&'a str>,
}

/// Apply a change to memories of `who.project`.
pub fn mutate(
    conn: &mut Connection,
    who: &Writer,
    change: &Change,
) -> Result<Receipt, MutationError> {
    let Change {
        operation,
        targets,
        content,
        category,
        reason,
    } = *change;
    let key = decision_key();
    let writer_op = format!("ctx_memory_{}", operation.name());
    let tx = immediate(conn)?;
    let refuse = |tx: Transaction, reason: &str| -> Result<Receipt, MutationError> {
        record_receipt(
            &tx,
            &key,
            who.project,
            &writer_op,
            &json!({"state": "decided_pending", "reason": reason, "adoptionClass": "live"}),
            false,
        )?;
        tx.commit()?;
        Err(MutationError::Refused(Refused::Pending(reason.to_owned())))
    };
    let distinct: std::collections::HashSet<i64> = targets.iter().map(|(id, _)| *id).collect();
    if targets.is_empty()
        || distinct.len() != targets.len()
        || (operation == Operation::Update && targets.len() != 1)
        || (operation == Operation::Merge && targets.len() < 2)
    {
        return refuse(tx, "invalid_targets");
    }
    let mut sources = Vec::new();
    for (id, revision) in targets {
        let Some(memory) = get_memory(&tx, *id)? else {
            return refuse(tx, "target_not_owned");
        };
        if memory.project_path != who.project {
            return refuse(tx, "target_not_owned");
        }
        if memory.revision != *revision || !memory.is_mutable() {
            return refuse(tx, "stale_revision");
        }
        sources.push(memory);
    }
    let content = content.map(str::trim).filter(|content| !content.is_empty());
    if operation != Operation::Archive && content.is_none() {
        return refuse(tx, "empty_content");
    }
    if operation == Operation::Merge
        && sources
            .iter()
            .any(|source| source.category != sources[0].category)
    {
        return refuse(tx, "cross_category_merge");
    }
    let first = sources[0].clone();
    let category = category.unwrap_or(&first.category).to_owned();
    let hash = content.map(normalized_hash);
    let duplicate = match (&hash, operation) {
        (Some(hash), Operation::Update | Operation::Merge) => {
            memory_by_hash(&tx, who.project, &category, hash)?
        }
        _ => None,
    };
    if let Some(duplicate) = &duplicate {
        if !sources.iter().any(|source| source.id == duplicate.id) {
            return Err(MutationError::Refused(Refused::Duplicate(duplicate.id)));
        }
    }
    let mut before: Vec<Option<Value>> = Vec::new();
    for source in &sources {
        before.push(history_snapshot(&tx, source.id)?);
    }
    for (id, revision) in targets {
        let changed = tx.execute(
            "UPDATE memories SET revision = revision + 1
              WHERE id = ?1 AND revision = ?2 AND status != 'archived' AND superseded_by_memory_id IS NULL",
            params![id, revision],
        )?;
        if changed != 1 {
            return Err(MutationError::Store(
                "memory revision changed during apply".into(),
            ));
        }
    }
    let mut canonical: Option<MemoryRow> = None;
    let mut superseded_ids = Vec::new();
    match operation {
        Operation::Update => {
            let content = content.expect("checked");
            update_content(&tx, first.id, content, hash.as_deref().expect("checked"))?;
            tx.execute(
                "UPDATE memories SET category = ?2 WHERE id = ?1",
                params![first.id, category],
            )?;
            queue_mutation(
                &tx,
                &first.project_path,
                "update",
                first.id,
                None,
                Some(&category),
                Some(content),
                None,
            )?;
            canonical = get_memory(&tx, first.id)?;
        }
        Operation::Archive => {
            for source in &sources {
                archive(&tx, source, reason)?;
                clear_derived(&tx, source.id)?;
                queue_mutation(
                    &tx,
                    &source.project_path,
                    "archive",
                    source.id,
                    None,
                    None,
                    None,
                    Some(&key),
                )?;
            }
        }
        Operation::Merge => {
            let content = content.expect("checked");
            let hash = hash.as_deref().expect("checked");
            let survivor = match &duplicate {
                Some(duplicate) => duplicate.clone(),
                None => {
                    before.push(None);
                    insert_memory(
                        &tx,
                        who.project,
                        &category,
                        content,
                        who.session,
                        "agent",
                        None,
                    )?
                }
            };
            if survivor.content != content || survivor.normalized_hash != hash {
                update_content(&tx, survivor.id, content, hash)?;
                queue_mutation(
                    &tx,
                    &survivor.project_path,
                    "update",
                    survivor.id,
                    None,
                    Some(&category),
                    Some(content),
                    Some(&key),
                )?;
            }
            let mut merged_from: std::collections::BTreeSet<i64> =
                sources.iter().map(|source| source.id).collect();
            for source in &sources {
                if let Some(prior) = source
                    .merged_from
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<Vec<Value>>(json).ok())
                {
                    merged_from.extend(prior.iter().filter_map(Value::as_i64));
                }
                if source.id != survivor.id {
                    tx.execute(
                        "UPDATE memories SET superseded_by_memory_id = ?2, status = 'archived', updated_at = ?3 WHERE id = ?1",
                        params![source.id, survivor.id, now_ms()],
                    )?;
                    clear_derived(&tx, source.id)?;
                    tx.execute(
                        "INSERT OR IGNORE INTO memory_successor_links(source_id, successor_id, decision_key) VALUES (?1, ?2, ?3)",
                        params![source.id, survivor.id, key],
                    )?;
                    queue_mutation(
                        &tx,
                        &source.project_path,
                        "superseded",
                        source.id,
                        Some(survivor.id),
                        None,
                        None,
                        Some(&key),
                    )?;
                    superseded_ids.push(source.id);
                }
            }
            let merged: Vec<i64> = merged_from.into_iter().collect();
            tx.execute(
                "UPDATE memories SET seen_count = ?2, retrieval_count = ?3, merged_from = ?4, status = ?5, updated_at = ?6 WHERE id = ?1",
                params![
                    survivor.id,
                    sources.iter().map(|source| source.seen_count).sum::<i64>(),
                    sources.iter().map(|source| source.retrieval_count).sum::<i64>(),
                    serde_json::to_string(&merged).unwrap_or_default(),
                    if sources.iter().any(|source| source.status == "permanent") { "permanent" } else { "active" },
                    now_ms()
                ],
            )?;
            clear_derived(&tx, survivor.id)?;
            canonical = get_memory(&tx, survivor.id)?;
        }
    }
    let mut after = Vec::new();
    for source in &sources {
        after.push(history_snapshot(&tx, source.id)?);
    }
    if let Some(canonical) = &canonical {
        if !sources.iter().any(|source| source.id == canonical.id) {
            after.push(history_snapshot(&tx, canonical.id)?);
        }
    }
    let survivor_id = (operation == Operation::Merge)
        .then(|| canonical.as_ref().map(|memory| memory.id))
        .flatten();
    let now = now_ms();
    let reason_text = reason
        .map(str::to_owned)
        .unwrap_or_else(|| writer_op.clone());
    let multiple = after.len() > 1;
    let rows: Vec<Value> = after
        .iter()
        .enumerate()
        .map(|(index, after)| {
            let id = after.as_ref().and_then(|after| after["id"].as_i64()).unwrap_or(0);
            let before = before.get(index).cloned().flatten();
            json!({
                "memoryId": id,
                "role": if Some(id) == survivor_id { "survivor" } else if multiple { "source" } else { "target" },
                "beforeRevision": before.as_ref().and_then(|before| before["revision"].as_i64()),
                "afterRevision": after.as_ref().and_then(|after| after["revision"].as_i64()),
                "before": before,
                "after": after,
                "completeness": "complete",
            })
        })
        .collect();
    let decision = json!({
        "version": 1,
        "decisionKey": key,
        "projectPath": first.project_path,
        "writer": "ctx_memory",
        "operation": operation.name(),
        "reason": reason_text,
        "appliedAt": now,
        "evidence": [],
        "sourceIds": sources.iter().map(|source| source.id).collect::<Vec<_>>(),
        "survivorId": survivor_id,
        "rows": rows,
        "restorable": true,
        "refusalReason": null,
    });
    for row in decision["rows"].as_array().expect("rows") {
        tx.execute(
            "INSERT INTO memory_history(memory_id, revision, previous_text, after_text, before_json, after_json,
                                        applied_at, reason, evidence_json, source_ids_json, decision_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row["memoryId"].as_i64(),
                row["beforeRevision"].as_i64().unwrap_or(0),
                row["before"]["content"].as_str().unwrap_or(""),
                row["after"]["content"].as_str().unwrap_or(""),
                history_json(&json!({"version": 1, "snapshot": row["before"]})),
                history_json(&json!({"version": 1, "snapshot": row["after"]})),
                now,
                decision["reason"].as_str(),
                history_json(&decision["evidence"]),
                history_json(&decision["sourceIds"]),
                key
            ],
        )?;
    }
    let memory_id = canonical.as_ref().map_or(first.id, |memory| memory.id);
    record_receipt(
        &tx,
        &key,
        who.project,
        &writer_op,
        &json!({"state": "applied", "reason": operation.name(), "memoryId": memory_id, "adoptionClass": "live", "supersededIds": superseded_ids}),
        true,
    )?;
    let history = history_json(&decision);
    tx.execute(
        "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
        params![key, history],
    )?;
    tx.commit()?;
    Ok(Receipt {
        applied: true,
        reason: operation.name().to_owned(),
        memory_id: Some(memory_id),
        inserted: false,
        superseded_ids,
    })
}

#[derive(Debug)]
pub enum MutationError {
    Refused(Refused),
    Store(String),
}

impl From<rusqlite::Error> for MutationError {
    fn from(error: rusqlite::Error) -> Self {
        MutationError::Store(error.to_string())
    }
}
