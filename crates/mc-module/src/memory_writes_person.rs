//! The person's own memory writes, made from the apps' commands: an edit, an
//! archive or restore, a permanent delete, undoing one history entry or a
//! whole dreamer run, and promoting an observation about the person to a
//! global memory. Each keeps the same records as the agent's and the
//! summarizer's writes (the row's revision, its undo history, the decision
//! receipt and the journal entry), with the writer `person`, so the apps'
//! history view shows it and an undo can take it back. A delete is the one
//! exception: it removes the memory with everything derived from its text
//! and keeps no history.
//!
//! Like every other memory write, none touches a session's prompt: each
//! session that shows a changed memory sees the change at its next rebuild.
//! Each write runs in one `BEGIN IMMEDIATE` transaction and checks, inside it,
//! that every target still has the revision the preview read.

use super::*;
use crate::dreamer::tasks::map_memories::{
    mapping_json, mapping_of_json, mapping_rows, put_mapping, same_mapping, MappingRow,
};

/// The writer name history and the journal record for the person.
pub(crate) const WRITER: &str = "person";

/// The memories a write may change: one level and its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwnerRef {
    pub level: String,
    pub owner_id: String,
}

/// A memory a write targets, at the revision the preview read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub id: i64,
    pub revision: i64,
}

#[derive(Debug)]
pub(crate) enum PersonError {
    /// A target changed, left the owner or disappeared after the preview.
    Stale,
    /// The change would give the owner two live memories with one text in
    /// one category.
    Duplicate,
    /// The row holds a value the undo history can't record.
    Unrecordable,
    Store(String),
}

impl From<rusqlite::Error> for PersonError {
    fn from(error: rusqlite::Error) -> Self {
        PersonError::Store(error.to_string())
    }
}

/// The target as stored, when it is still the owner's at the revision read.
fn checked(tx: &Transaction, owner: &OwnerRef, target: Target) -> Result<MemoryRow, PersonError> {
    let memory = get_memory(tx, target.id)?.ok_or(PersonError::Stale)?;
    if memory.level != owner.level
        || memory.owner_id != owner.owner_id
        || memory.revision != target.revision
    {
        return Err(PersonError::Stale);
    }
    Ok(memory)
}

fn snapshot(tx: &Transaction, id: i64) -> Result<Value, PersonError> {
    history_snapshot(tx, id)?.ok_or(PersonError::Unrecordable)
}

/// Advance the target's revision, as every change the history records does.
fn bump(tx: &Transaction, target: Target) -> Result<(), PersonError> {
    let changed = tx.execute(
        "UPDATE memories SET revision = revision + 1 WHERE id = ?1 AND revision = ?2",
        params![target.id, target.revision],
    )?;
    if changed != 1 {
        return Err(PersonError::Stale);
    }
    Ok(())
}

/// Another live memory of the owner that already holds this text in this
/// category. Live rows are unique per owner, category and text.
pub(crate) fn live_duplicate(
    conn: &Connection,
    owner: &OwnerRef,
    category_id: &str,
    hash: &str,
    except: i64,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM memories
          WHERE level = ?1 AND owner_id = ?2 AND category = ?3 AND normalized_hash = ?4
            AND id != ?5 AND (status IS NULL OR status IN ('active', 'permanent'))
          ORDER BY id LIMIT 1",
        params![owner.level, owner.owner_id, category_id, hash, except],
        |row| row.get(0),
    )
    .optional()
}

/// Clause evidence is kept per revision. When a write keeps the text, the
/// evidence for the text moves to the new revision with it.
fn carry_evidence(tx: &Transaction, id: i64, from: i64, to: i64) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT memory_id, ?3, clause_ordinal, text_hash, evidence_json
           FROM memory_clause_evidence WHERE memory_id = ?1 AND revision = ?2",
        params![id, from, to],
    )
    .map(drop)
}

/// Record one decision of the person's: the history rows, the receipt and the
/// journal entry, the way the other writers record theirs.
#[allow(clippy::too_many_arguments)]
fn record(
    tx: &Transaction,
    owner: &OwnerRef,
    operation: &str,
    reason: &str,
    before: &[Option<Value>],
    after: &[Option<Value>],
    ids: &[i64],
    evidence: Value,
) -> Result<Value, PersonError> {
    let key = decision_key();
    let decision = record_history(
        tx,
        &History {
            key: &key,
            project: &owner.owner_id,
            writer: WRITER,
            operation,
            reason,
            now: now_ms(),
            before,
            after,
            source_ids: ids,
            survivor_id: None,
            evidence,
        },
    )?;
    record_receipt(
        tx,
        &key,
        &owner.owner_id,
        &format!("person_{operation}"),
        &json!({"state": "applied", "reason": operation, "memoryIds": ids}),
        true,
    )?;
    tx.execute(
        "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
        params![key, history_json(&decision)],
    )?;
    Ok(decision)
}

/// What a person's edit changes. `None` keeps the field.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Edit {
    pub content: Option<String>,
    /// The profile category id and its tag.
    pub category: Option<(String, String)>,
    pub importance: Option<i64>,
}

/// The importance a write may give a memory: a safety-critical one never
/// drops below [`SAFETY_CRITICAL_MIN_IMPORTANCE`].
pub(crate) fn kept_importance(importance: i64, safety_critical: bool) -> i64 {
    if safety_critical {
        importance.max(SAFETY_CRITICAL_MIN_IMPORTANCE)
    } else {
        importance
    }
}

/// Edit one live memory's text, category or importance.
pub(crate) fn edit(
    conn: &mut Connection,
    owner: &OwnerRef,
    target: Target,
    change: &Edit,
) -> Result<Value, PersonError> {
    let tx = immediate(conn)?;
    let memory = checked(&tx, owner, target)?;
    if !memory.is_mutable() {
        return Err(PersonError::Stale);
    }
    let before = snapshot(&tx, target.id)?;
    let content = change.content.as_deref().unwrap_or(&memory.content);
    let hash = normalized_hash(content);
    let category_id = change
        .category
        .as_ref()
        .map_or(memory.category_id.as_str(), |(id, _)| id.as_str());
    if live_duplicate(&tx, owner, category_id, &hash, target.id)?.is_some() {
        return Err(PersonError::Duplicate);
    }
    bump(&tx, target)?;
    match &change.content {
        Some(content) if *content != memory.content => {
            update_content(&tx, target.id, content, &hash)?;
        }
        _ => carry_evidence(&tx, target.id, target.revision, target.revision + 1)?,
    }
    if let Some((id, tag)) = &change.category {
        tx.execute(
            "UPDATE memories SET category = ?2, origin_category = ?3, updated_at = ?4 WHERE id = ?1",
            params![target.id, id, tag, now_ms()],
        )?;
    }
    if let Some(importance) = change.importance {
        tx.execute(
            "UPDATE memories
                SET importance = CASE WHEN safety_critical = 1 THEN MAX(?2, ?3) ELSE ?2 END,
                    updated_at = ?4
              WHERE id = ?1",
            params![
                target.id,
                importance,
                SAFETY_CRITICAL_MIN_IMPORTANCE,
                now_ms()
            ],
        )?;
    }
    let after = snapshot(&tx, target.id)?;
    let decision = record(
        &tx,
        owner,
        "edit",
        "person_edit",
        &[Some(before)],
        &[Some(after)],
        &[target.id],
        json!([]),
    )?;
    tx.commit()?;
    Ok(decision)
}

/// Archive a live memory, or restore an archived one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Archive,
    Restore,
}

impl Status {
    /// Whether the memory is one this change applies to: archiving takes a
    /// live memory, restoring an archived one that no merge replaced (that
    /// one comes back only through undoing the merge).
    pub(crate) fn applies(self, memory: &MemoryRow) -> bool {
        match self {
            Status::Archive => memory.is_mutable(),
            Status::Restore => {
                memory.status == "archived" && memory.superseded_by_memory_id.is_none()
            }
        }
    }
}

/// The status a restored memory takes: the one it had before it was last
/// archived, when its history says it was permanent; active otherwise.
pub(crate) fn restored_status(conn: &Connection, id: i64) -> rusqlite::Result<&'static str> {
    let rows: Vec<(Option<String>, Option<String>)> = conn
        .prepare(
            "SELECT before_json, after_json FROM memory_history
              WHERE memory_id = ?1 ORDER BY applied_at DESC, id DESC",
        )?
        .query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let status = |json: &Option<String>| -> Option<String> {
        let value: Value = serde_json::from_str(json.as_deref()?).ok()?;
        value["snapshot"]["status"].as_str().map(str::to_owned)
    };
    for (before, after) in &rows {
        if status(after).as_deref() == Some("archived")
            && status(before).as_deref() != Some("archived")
        {
            return Ok(if status(before).as_deref() == Some("permanent") {
                "permanent"
            } else {
                "active"
            });
        }
    }
    Ok("active")
}

/// Archive or restore every target, as one decision.
pub(crate) fn set_status(
    conn: &mut Connection,
    owner: &OwnerRef,
    targets: &[Target],
    change: Status,
) -> Result<Value, PersonError> {
    let tx = immediate(conn)?;
    let (mut before, mut after, mut ids) = (Vec::new(), Vec::new(), Vec::new());
    for target in targets {
        let memory = checked(&tx, owner, *target)?;
        if !change.applies(&memory) {
            return Err(PersonError::Stale);
        }
        before.push(Some(snapshot(&tx, target.id)?));
        bump(&tx, *target)?;
        match change {
            Status::Archive => {
                archive(&tx, &memory, None)?;
                clear_derived(&tx, target.id)?;
            }
            Status::Restore => {
                if live_duplicate(
                    &tx,
                    owner,
                    &memory.category_id,
                    &memory.normalized_hash,
                    target.id,
                )?
                .is_some()
                {
                    return Err(PersonError::Duplicate);
                }
                tx.execute(
                    "UPDATE memories SET status = ?2, updated_at = ?3 WHERE id = ?1",
                    params![target.id, restored_status(&tx, target.id)?, now_ms()],
                )?;
                carry_evidence(&tx, target.id, target.revision, target.revision + 1)?;
            }
        }
        after.push(Some(snapshot(&tx, target.id)?));
        ids.push(target.id);
    }
    let operation = match change {
        Status::Archive => "archive",
        Status::Restore => "restore",
    };
    let decision = record(
        &tx,
        owner,
        operation,
        &format!("person_{operation}"),
        &before,
        &after,
        &ids,
        json!([]),
    )?;
    tx.commit()?;
    Ok(decision)
}

/// A history snapshot with everything derived from the memory's text taken
/// out: what a deleted memory's journal rows keep, so a dreamer run that
/// changed it still counts the change and names the id.
fn without_text(snapshot: &Value) -> Value {
    if snapshot.is_null() {
        return Value::Null;
    }
    json!({
        "id": snapshot["id"],
        "revision": snapshot["revision"],
        "status": snapshot["status"],
        "supersededByMemoryId": snapshot["supersededByMemoryId"],
        "deleted": true,
    })
}

/// Remove a memory and everything derived from its text: its history and
/// its rows' text in the journal, its embeddings, verifications, clause
/// evidence, classification excerpts, the standalone plugin's applied-row and
/// fragment records, its links to other memories, and (through the
/// `memories_ad` trigger) its search entry.
fn purge(tx: &Transaction, id: i64) -> rusqlite::Result<()> {
    let keys: Vec<String> = tx
        .prepare("SELECT DISTINCT decision_key FROM memory_history WHERE memory_id = ?1")?
        .query_map(params![id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for key in keys {
        let decision: Option<Option<String>> = tx
            .query_row(
                "SELECT before_json FROM memory_journal WHERE decision_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        let Some(mut decision) = decision
            .flatten()
            .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        else {
            continue;
        };
        for row in decision["rows"].as_array_mut().into_iter().flatten() {
            if row["memoryId"].as_i64() == Some(id) {
                row["before"] = without_text(&row["before"]);
                row["after"] = without_text(&row["after"]);
            }
        }
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![key, history_json(&decision)],
        )?;
    }
    for sql in [
        "DELETE FROM memory_history WHERE memory_id = ?1",
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        "DELETE FROM memory_clause_evidence WHERE memory_id = ?1",
        "DELETE FROM memory_classification_items WHERE memory_id = ?1",
        "DELETE FROM memory_applied_rows WHERE memory_id = ?1",
        "DELETE FROM memory_successor_links WHERE source_id = ?1 OR successor_id = ?1",
        "DELETE FROM memory_conflict_links WHERE left_id = ?1 OR right_id = ?1",
        "DELETE FROM memory_agent_fragments
          WHERE current_id = ?1
             OR EXISTS(SELECT 1 FROM json_each(memory_ids_json) WHERE value = ?1)",
    ] {
        tx.execute(sql, params![id])?;
    }
    if table_exists(tx, "memory_verifications")? {
        tx.execute(
            "DELETE FROM memory_verifications WHERE memory_id = ?1",
            params![id],
        )?;
    }
    tx.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
    Ok(())
}

/// Delete every target for good. The journal keeps one entry naming the ids,
/// with no text, so the delete itself stays on record.
pub(crate) fn delete(
    conn: &mut Connection,
    owner: &OwnerRef,
    targets: &[Target],
) -> Result<(), PersonError> {
    let tx = immediate(conn)?;
    for target in targets {
        checked(&tx, owner, *target)?;
    }
    for target in targets {
        purge(&tx, target.id)?;
    }
    let ids: Vec<i64> = targets.iter().map(|target| target.id).collect();
    record_receipt(
        &tx,
        &decision_key(),
        &owner.owner_id,
        "person_delete",
        &json!({"state": "applied", "reason": "delete", "memoryIds": ids}),
        true,
    )?;
    tx.commit()?;
    Ok(())
}

/// One entry of a memory's history: the row before and after it, and the
/// decision it belongs to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Entry {
    /// `None` when the decision created the memory.
    pub before: Option<Value>,
    pub after: Value,
    pub key: String,
}

/// The history entry that produced `revision` of the memory: the one whose
/// row after the change has that revision. `None` when there is none, or it
/// was written before history kept whole rows.
pub(crate) fn entry(conn: &Connection, id: i64, revision: i64) -> rusqlite::Result<Option<Entry>> {
    let rows: Vec<(Option<String>, Option<String>, String)> = conn
        .prepare(
            "SELECT before_json, after_json, decision_key FROM memory_history
              WHERE memory_id = ?1 ORDER BY applied_at DESC, id DESC",
        )?
        .query_map(params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let snapshot = |json: &Option<String>| -> Option<Value> {
        let value: Value = serde_json::from_str(json.as_deref()?).ok()?;
        let snapshot = value["snapshot"].clone();
        (!snapshot.is_null()).then_some(snapshot)
    };
    for (before, after, key) in rows {
        let Some(after) = snapshot(&after) else {
            continue;
        };
        if after["revision"].as_i64() == Some(revision) && after["deleted"].is_null() {
            return Ok(Some(Entry {
                before: snapshot(&before),
                after,
                key,
            }));
        }
    }
    Ok(None)
}

/// What restoring `to` would make of the memory: its category id and text
/// hash, and whether it would be live. `to` is `None` for a memory a decision
/// created; restoring that archives it.
pub(crate) struct Restored {
    pub category_id: String,
    pub hash: String,
    pub live: bool,
}

pub(crate) fn restored(memory: &MemoryRow, to: Option<&Value>) -> Restored {
    match to {
        None => Restored {
            category_id: memory.category_id.clone(),
            hash: memory.normalized_hash.clone(),
            live: false,
        },
        Some(to) => Restored {
            category_id: to["categoryId"]
                .as_str()
                .unwrap_or(&memory.category_id)
                .to_owned(),
            hash: normalized_hash(to["content"].as_str().unwrap_or(&memory.content)),
            live: matches!(to["status"].as_str(), Some("active" | "permanent"))
                && to["supersededByMemoryId"].is_null(),
        },
    }
}

/// Whether `to` can be restored onto the memory in place: it belongs to the
/// same level and owner, and holds the fields a restore writes.
pub(crate) fn restorable(memory: &MemoryRow, to: Option<&Value>) -> bool {
    let Some(to) = to else { return true };
    to["level"].as_str() == Some(memory.level.as_str())
        && to["projectPath"].as_str() == Some(memory.owner_id.as_str())
        && to["content"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
        && to["category"].is_string()
        && to["categoryId"].is_string()
        && to["status"].is_string()
}

/// Write `to` back onto the memory: the row as it was before a change, or,
/// for a memory the change created, the memory archived. The revision is
/// advanced by the caller. Successor links follow the restored row.
fn restore_row(
    tx: &Transaction,
    memory: &MemoryRow,
    to: Option<&Value>,
    new_revision: i64,
) -> Result<(), PersonError> {
    let now = now_ms();
    let Some(to) = to else {
        tx.execute(
            "UPDATE memories SET status = 'archived', superseded_by_memory_id = NULL, updated_at = ?2
              WHERE id = ?1",
            params![memory.id, now],
        )?;
        tx.execute(
            "DELETE FROM memory_successor_links WHERE source_id = ?1",
            params![memory.id],
        )?;
        clear_derived(tx, memory.id)?;
        return Ok(());
    };
    let content = to["content"].as_str().unwrap_or(&memory.content);
    let hash = normalized_hash(content);
    if content != memory.content {
        update_content(tx, memory.id, content, &hash)?;
    } else if let Some(from) = to["revision"].as_i64() {
        // Evidence is kept per revision: restoring a text brings back the
        // evidence recorded for it, now at the new revision.
        carry_evidence(tx, memory.id, from, new_revision)?;
    }
    let superseded = to["supersededByMemoryId"].as_i64();
    tx.execute(
        "UPDATE memories
            SET origin_category = ?2, category = ?3, importance = ?4, scope = ?5, status = ?6,
                expires_at = ?7, superseded_by_memory_id = ?8, merged_from = ?9,
                metadata_json = ?10, source_session_id = ?11, source_type = ?12, updated_at = ?13
          WHERE id = ?1",
        params![
            memory.id,
            to["category"].as_str(),
            to["categoryId"].as_str(),
            to["importance"].as_i64(),
            to["scope"].as_str().unwrap_or("project"),
            to["status"].as_str(),
            to["expiresAt"].as_i64(),
            superseded,
            to["mergedFrom"].as_str(),
            to["metadataJson"].as_str(),
            to["sourceSessionId"].as_str(),
            to["sourceType"].as_str(),
            now
        ],
    )?;
    tx.execute(
        "DELETE FROM memory_successor_links WHERE source_id = ?1",
        params![memory.id],
    )?;
    if let Some(successor) = superseded {
        tx.execute(
            "INSERT OR IGNORE INTO memory_successor_links(source_id, successor_id, decision_key)
             VALUES (?1, ?2, ?3)",
            params![
                memory.id,
                successor,
                format!("person-restore:{}", memory.id)
            ],
        )?;
    }
    Ok(())
}

/// The rows a restore changed, before and after, index for index, and their
/// ids: what its history decision records.
type RestoredRows = (Vec<Option<Value>>, Vec<Option<Value>>, Vec<i64>);

/// Restore each target to the row it holds in `to`, as one decision.
fn restore_all(
    tx: &Transaction,
    owner: &OwnerRef,
    targets: &[(Target, Option<Value>)],
) -> Result<RestoredRows, PersonError> {
    let (mut before, mut after, mut ids) = (Vec::new(), Vec::new(), Vec::new());
    for (target, to) in targets {
        let memory = checked(tx, owner, *target)?;
        if !restorable(&memory, to.as_ref()) {
            return Err(PersonError::Stale);
        }
        let plan = restored(&memory, to.as_ref());
        if plan.live
            && live_duplicate(tx, owner, &plan.category_id, &plan.hash, target.id)?.is_some()
        {
            return Err(PersonError::Duplicate);
        }
        before.push(Some(snapshot(tx, target.id)?));
        bump(tx, *target)?;
        restore_row(tx, &memory, to.as_ref(), target.revision + 1)?;
        after.push(Some(snapshot(tx, target.id)?));
        ids.push(target.id);
    }
    Ok((before, after, ids))
}

/// Undo one history entry of a memory: put back the row as it was before
/// `entry`.
pub(crate) fn undo(
    conn: &mut Connection,
    owner: &OwnerRef,
    target: Target,
    entry: &Entry,
) -> Result<Value, PersonError> {
    let tx = immediate(conn)?;
    let (before, after, ids) = restore_all(&tx, owner, &[(target, entry.before.clone())])?;
    let decision = record(
        &tx,
        owner,
        "undo",
        &format!("undo:{}", entry.key),
        &before,
        &after,
        &ids,
        json!({"restoredDecisionKey": entry.key, "revision": entry.after["revision"]}),
    )?;
    tx.commit()?;
    Ok(decision)
}

/// Why undoing a dreamer run leaves a memory as it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeftAlone {
    /// Something changed the memory again after the run.
    ChangedAfter,
    /// The memory was deleted.
    Deleted,
    /// It belongs to another owner now.
    Moved,
    /// Its row before the run would repeat a live memory of the owner.
    Duplicate,
}

/// What undoing a run does: the memories it puts back, each at its current
/// revision with the row it held before the run, the mappings it puts back,
/// and the memories it leaves.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RunUndo {
    pub restore: Vec<(Target, Option<Value>)>,
    pub mappings: Vec<MappingUndo>,
    pub left: Vec<(i64, LeftAlone)>,
}

/// A memory's mapping that undoing a run puts back. A mapping is not part of
/// the memory's row, so it keeps no history entry of its own: the run's
/// journal holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MappingUndo {
    pub id: i64,
    /// The mapping the run left, which must still be in place.
    pub from: Vec<MappingRow>,
    /// The mapping before the run; empty when the memory had none.
    pub to: Vec<MappingRow>,
}

/// Plan undoing every memory change dreamer run `run` made. A memory the
/// run changed several times goes back to its row before the first change,
/// and only while it still holds what the last change wrote.
pub(crate) fn plan_run_undo(
    conn: &Connection,
    owner: &OwnerRef,
    run: i64,
) -> rusqlite::Result<RunUndo> {
    let decisions: Vec<Option<String>> = conn
        .prepare(
            "SELECT before_json FROM memory_journal
              WHERE decision_key >= ?1 AND decision_key < ?2 ORDER BY applied_at, id",
        )?
        .query_map(
            params![format!("dream-run:{run}:"), format!("dream-run:{run};")],
            |row| row.get(0),
        )?
        .collect::<rusqlite::Result<_>>()?;
    // Each memory's row before the run's first change and after its last,
    // and the same for its mapping.
    let mut changed: std::collections::BTreeMap<i64, (Value, Value)> = Default::default();
    let mut mapped: std::collections::BTreeMap<i64, (Vec<MappingRow>, Vec<MappingRow>)> =
        Default::default();
    for decision in decisions.iter().flatten() {
        let Ok(decision) = serde_json::from_str::<Value>(decision) else {
            continue;
        };
        for mapping in decision["mappings"].as_array().into_iter().flatten() {
            let (Some(id), Some(before), Some(after)) = (
                mapping["memoryId"].as_i64(),
                mapping_of_json(&mapping["before"]),
                mapping_of_json(&mapping["after"]),
            ) else {
                continue;
            };
            mapped
                .entry(id)
                .and_modify(|(_, last)| *last = after.clone())
                .or_insert((before, after));
        }
        for row in decision["rows"].as_array().into_iter().flatten() {
            let (before, after) = (&row["before"], &row["after"]);
            let Some(id) = row["memoryId"].as_i64() else {
                continue;
            };
            if after.is_null() || before == after {
                continue;
            }
            changed
                .entry(id)
                .and_modify(|(_, last)| *last = after.clone())
                .or_insert_with(|| (before.clone(), after.clone()));
        }
    }
    let mut plan = RunUndo::default();
    for (id, (first, last)) in changed {
        let memory = get_memory(conn, id)?;
        let Some(memory) = memory.filter(|_| last["deleted"].is_null()) else {
            plan.left.push((id, LeftAlone::Deleted));
            continue;
        };
        if memory.level != owner.level || memory.owner_id != owner.owner_id {
            plan.left.push((id, LeftAlone::Moved));
            continue;
        }
        let to = (!first.is_null()).then_some(first);
        if last["revision"].as_i64() != Some(memory.revision) || !restorable(&memory, to.as_ref()) {
            plan.left.push((id, LeftAlone::ChangedAfter));
            continue;
        }
        let restored = restored(&memory, to.as_ref());
        if restored.live
            && live_duplicate(conn, owner, &restored.category_id, &restored.hash, id)?.is_some()
        {
            plan.left.push((id, LeftAlone::Duplicate));
            continue;
        }
        plan.restore.push((
            Target {
                id,
                revision: memory.revision,
            },
            to,
        ));
    }
    for (id, (first, last)) in mapped {
        let Some(memory) = get_memory(conn, id)? else {
            plan.left.push((id, LeftAlone::Deleted));
            continue;
        };
        if memory.level != owner.level || memory.owner_id != owner.owner_id {
            plan.left.push((id, LeftAlone::Moved));
            continue;
        }
        // Verify checking the files later is not a change; a different
        // file or origin, or a text edit that cleared the mapping, is.
        if !same_mapping(&mapping_rows(conn, id)?, &last) {
            plan.left.push((id, LeftAlone::ChangedAfter));
            continue;
        }
        plan.mappings.push(MappingUndo {
            id,
            from: last,
            to: first,
        });
    }
    Ok(plan)
}

/// Undo a dreamer run's changes as `plan` lists them, as one decision.
pub(crate) fn undo_run(
    conn: &mut Connection,
    owner: &OwnerRef,
    run: i64,
    plan: &RunUndo,
) -> Result<Value, PersonError> {
    let tx = immediate(conn)?;
    let (before, after, ids) = restore_all(&tx, owner, &plan.restore)?;
    let mut evidence = json!({"runId": run});
    if !plan.mappings.is_empty() {
        let mut restored = Vec::new();
        for mapping in &plan.mappings {
            let memory = get_memory(&tx, mapping.id)?.ok_or(PersonError::Stale)?;
            if memory.level != owner.level
                || memory.owner_id != owner.owner_id
                || !same_mapping(&mapping_rows(&tx, mapping.id)?, &mapping.from)
            {
                return Err(PersonError::Stale);
            }
            let undone = mapping_rows(&tx, mapping.id)?;
            put_mapping(&tx, mapping.id, &mapping.to)?;
            restored.push(json!({
                "memoryId": mapping.id,
                "before": mapping_json(&undone),
                "after": mapping_json(&mapping.to),
            }));
        }
        evidence["mappings"] = Value::Array(restored);
    }
    let decision = record(
        &tx,
        owner,
        "undo_run",
        &format!("undo:dream-run:{run}"),
        &before,
        &after,
        &ids,
        evidence,
    )?;
    tx.commit()?;
    Ok(decision)
}

/// A pending observation about the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub id: i64,
    pub content: String,
    pub session: String,
    pub project: Option<String>,
}

/// The observations among `ids` no review has taken yet.
pub(crate) fn pending_observations(
    conn: &Connection,
    ids: &[i64],
) -> rusqlite::Result<Vec<Observation>> {
    let mut found = Vec::new();
    for id in ids {
        let row = conn
            .query_row(
                "SELECT id, content, session_id, project_id FROM memory_observations
                  WHERE id = ?1 AND consumed_at IS NULL",
                params![id],
                |row| {
                    Ok(Observation {
                        id: row.get(0)?,
                        content: row.get(1)?,
                        session: row.get(2)?,
                        project: row.get(3)?,
                    })
                },
            )
            .optional()?;
        found.extend(row);
    }
    Ok(found)
}

/// The global level: the person's own memories, owned by `self`.
pub(crate) fn global() -> OwnerRef {
    OwnerRef {
        level: "global".into(),
        owner_id: "self".into(),
    }
}

/// Promote a pending observation to a global memory under `category` (the
/// profile category id and its tag). The observation leaves the review queue
/// in the same transaction. Returns the new memory's id.
pub(crate) fn promote(
    conn: &mut Connection,
    observation: i64,
    category: (&str, &str),
) -> Result<i64, PersonError> {
    let tx = immediate(conn)?;
    let found = pending_observations(&tx, &[observation])?;
    let Some(observation) = found.into_iter().next() else {
        return Err(PersonError::Stale);
    };
    let owner = global();
    let (category_id, tag) = category;
    let hash = normalized_hash(&observation.content);
    if live_duplicate(&tx, &owner, category_id, &hash, 0)?.is_some() {
        return Err(PersonError::Duplicate);
    }
    let row = crate::memory_levels::NewRow {
        level: owner.level.clone(),
        owner_id: owner.owner_id.clone(),
        category_id: category_id.to_owned(),
        origin_profile: None,
        source_ordinals_json: None,
    };
    let memory = insert_memory(
        &tx,
        &row,
        observation.project.as_deref().unwrap_or(""),
        tag,
        &observation.content,
        &observation.session,
        WRITER,
        None,
    )?;
    tx.execute(
        "UPDATE memory_observations SET consumed_at = ?2 WHERE id = ?1",
        params![observation.id, now_ms()],
    )?;
    let after = snapshot(&tx, memory.id)?;
    record(
        &tx,
        &owner,
        "promote",
        "person_promote",
        &[None],
        &[Some(after)],
        &[memory.id],
        json!({"observationId": observation.id}),
    )?;
    tx.commit()?;
    Ok(memory.id)
}

/// Take pending observations out of the review queue without a memory.
/// Returns how many left it.
pub(crate) fn dismiss_observations(conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let tx = immediate(conn)?;
    let now = now_ms();
    let mut dismissed = 0;
    for id in ids {
        dismissed += tx.execute(
            "UPDATE memory_observations SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
            params![id, now],
        )?;
    }
    tx.commit()?;
    Ok(dismissed)
}
