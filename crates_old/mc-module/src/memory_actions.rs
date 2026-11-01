//! Transactional, non-served memory actions. The caller supplies an authorized
//! channel/session binding, canonical workspace members and shared categories,
//! and a local embedding outbox; no model or network client is used.
//! This module does not register a route. A future `mc.memory` adapter must obtain
//! authorization through `management_binding` before constructing the context below.
#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};

use mc_store::compute_normalized_memory_hash;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CATEGORIES: &[&str] = &[
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "CONFIG_DEFAULTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingEffectKind {
    Embed,
    Invalidate,
}

/// An embed is guarded by the content hash at drain time. Invalidations remove all
/// vectors for the old row, including superseded merge sources and archived rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmbeddingEffect {
    pub project_path: String,
    pub session_id: String,
    pub memory_id: i64,
    pub kind: EmbeddingEffectKind,
    pub content: Option<String>,
    pub content_hash: String,
    pub queued_at: i64,
}

/// Implementations must only append a durable outbox row on `tx`. They must not
/// commit, open another connection, spawn work or call subc. Draining is separate.
pub trait MemoryEmbeddingQueue {
    fn enqueue_tx(&self, tx: &Transaction<'_>, effect: &EmbeddingEffect) -> rusqlite::Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryRole {
    Primary,
    Dreamer,
}

/// Trusted inputs resolved by the management binding, never from tool arguments.
/// Workspace members are canonical project identities; shared categories come
/// from that workspace's configured read policy.
pub struct MemoryActionContext<'a> {
    pub project_path: &'a str,
    pub session_id: &'a str,
    pub harness: &'a str,
    pub role: MemoryRole,
    pub workspace_members: &'a [String],
    pub shared_categories: &'a [String],
    pub curate_category: Option<&'a str>,
    pub memory_enabled: bool,
    pub now_ms: i64,
    /// Fresh per invocation; retries of that invocation reuse the same key.
    pub decision_key: &'a str,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct MemoryActionArgs {
    pub action: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
    pub ids: Option<Vec<i64>>,
    pub limit: Option<f64>,
    pub reason: Option<String>,
    pub superseded_by: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedMutationReceipt<'a> {
    state: &'a str,
    reason: &'a str,
    memory_id: i64,
    adoption_class: &'a str,
    superseded_ids: &'a [i64],
}

/// Counts curate safety refusals separately for each session, so a reply's running
/// refusal count never includes another session's rejected edits.
#[derive(Default)]
pub struct MemoryActions {
    refusals: HashMap<String, usize>,
}

fn text(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or_default().into()
}
// JavaScript's trim and /\s/ include BOM but exclude NEXT LINE. Rust's built-in
// Unicode whitespace set does the opposite, which changes saved content bytes.
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}
fn js_regex(pattern: &str) -> regex::Regex {
    let pattern=pattern.replace("(?i)","(?i-u)").replace(r"\s",r"(?u:[\x{0009}-\x{000d}\x{0020}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}])");
    regex::Regex::new(&pattern).unwrap()
}
fn number(row: &Value, key: &str) -> i64 {
    row[key].as_i64().unwrap_or_default()
}
fn live(row: &Value) -> bool {
    matches!(row["status"].as_str(), Some("active" | "permanent"))
        && row["superseded_by_memory_id"].is_null()
}
fn valid_category(category: Option<&str>) -> Option<&str> {
    category.map(js_trim).filter(|s| CATEGORIES.contains(s))
}
fn bucket(category: &str) -> &str {
    match category {
        "ARCHITECTURE_DECISIONS" => "ARCHITECTURE",
        "CONFIG_DEFAULTS" | "ENVIRONMENT" => "CONFIG_VALUES",
        "KNOWN_ISSUES" => "CONSTRAINTS",
        "USER_DIRECTIVES" | "USER_PREFERENCES" | "WORKFLOW_RULES" => "PROJECT_RULES",
        _ => category,
    }
}
fn unique(ids: &[i64]) -> Vec<i64> {
    let mut seen = BTreeSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}
fn ids_text(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}
fn load(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    let mut stmt = conn.prepare("SELECT * FROM memories WHERE id=?1")?;
    let names = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    stmt.query_row([id], |row| {
        let mut object = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                ValueRef::Blob(_) => {
                    return Err(rusqlite::Error::InvalidColumnType(
                        i,
                        name.clone(),
                        rusqlite::types::Type::Blob,
                    ))
                }
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })
    .optional()
}
fn history_error(error: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
}

fn history_snapshot(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    let mut snapshot = mc_store::memory_history::snapshot(conn, id).map_err(history_error)?;
    // The audited schema has a fixed canonical core. Retain future opaque columns
    // too, without changing the core fields the shared restore planner understands.
    if let (Some(snapshot), Some(row)) = (snapshot.as_mut(), load(conn, id)?) {
        let known =
            serde_json::to_value(mc_store::StoredMemoryFull::default()).map_err(json_error)?;
        for (column, value) in row.as_object().ok_or(rusqlite::Error::InvalidQuery)? {
            if known.get(column).is_none()
                && !matches!(
                    column.as_str(),
                    "revision" | "verify_result" | "verify_files_json" | "verify_commit"
                )
            {
                snapshot[column] = value.clone();
            }
        }
    }
    Ok(snapshot)
}
fn visible(row: &Value, ctx: &MemoryActionContext<'_>) -> bool {
    row["project_path"] == ctx.project_path
        || (ctx
            .workspace_members
            .iter()
            .any(|p| row["project_path"] == *p)
            && ctx.shared_categories.iter().any(|c| row["category"] == *c))
}
fn inactive(id: i64, action: &str) -> String {
    format!("Error: Memory with ID {id} is archived or superseded; restore it before {action}.")
}

impl MemoryActions {
    /// Recover arguments from `{reduced:true, summary:"<JSON arguments>"}` once.
    /// Models sometimes copy this display-only form from compacted tool history;
    /// its JSON must not supply a trusted role, project, session or workspace policy.
    pub fn execute_value(
        &mut self,
        conn: &mut Connection,
        queue: &impl MemoryEmbeddingQueue,
        ctx: &MemoryActionContext<'_>,
        value: &Value,
    ) -> rusqlite::Result<String> {
        let decoded = if value.get("action").is_none() && value["reduced"] == true {
            value["summary"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .filter(valid_reduced)
        } else {
            None
        };
        let value = decoded.as_ref().unwrap_or(value);
        let args = MemoryActionArgs {
            action: value["action"].as_str().map(str::to_string),
            content: value["content"].as_str().map(str::to_string),
            category: value["category"].as_str().map(str::to_string),
            ids: value["ids"]
                .as_array()
                .and_then(|ids| ids.iter().map(Value::as_i64).collect()),
            limit: value["limit"].as_f64(),
            reason: value["reason"].as_str().map(str::to_string),
            superseded_by: value["superseded_by"].as_i64(),
        };
        self.execute(conn, queue, ctx, &args)
    }
    /// Owns the commit boundary. Any queue or later memory/history error rolls back
    /// everything, including jobs already appended by the queue adapter.
    pub fn execute(
        &mut self,
        conn: &mut Connection,
        queue: &impl MemoryEmbeddingQueue,
        ctx: &MemoryActionContext<'_>,
        args: &MemoryActionArgs,
    ) -> rusqlite::Result<String> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let reply = self.execute_tx(&tx, queue, ctx, args)?;
        tx.commit()?;
        Ok(reply)
    }

    /// An enclosing tool transaction may compose this with its command ledger.
    /// Errors must propagate to that transaction's owner without being swallowed.
    pub fn execute_tx(
        &mut self,
        tx: &Transaction<'_>,
        queue: &impl MemoryEmbeddingQueue,
        ctx: &MemoryActionContext<'_>,
        args: &MemoryActionArgs,
    ) -> rusqlite::Result<String> {
        let action = args.action.as_deref().unwrap_or("undefined");
        let dreamer = ctx.role == MemoryRole::Dreamer;
        if action == "undefined" || (!dreamer && action == "list") {
            return Ok(format!(
                "Error: Action '{action}' is not allowed in this context."
            ));
        }
        let ids = args.ids.as_deref().unwrap_or_default();
        if dreamer {
            if let Some(scope) = ctx.curate_category {
                if matches!(action, "write" | "update" | "merge" | "list") {
                    if let Some(category) = args.category.as_deref().filter(|s| !s.is_empty()) {
                        if category != scope {
                            return Ok(format!("Error: Curate scope is {scope}; {action} cannot target category {category}."));
                        }
                    }
                }
                if matches!(action, "update" | "archive" | "merge" | "get") {
                    let mut targets = ids.to_vec();
                    if matches!(action, "update" | "archive") {
                        targets.extend(args.superseded_by);
                    }
                    for id in targets {
                        if let Some(row) = load(tx, id)? {
                            if bucket(&text(&row, "category")) != scope {
                                return Ok(format!("Error: Curate scope is {scope}; memory ID {id} is outside the scoped category."));
                            }
                        }
                    }
                }
            }
            if let Some(reply) = self.curate_preflight(tx, ctx, args)? {
                return Ok(reply);
            }
        }
        if !ctx.memory_enabled {
            return Ok("Cross-session memory is disabled for this project.".into());
        }
        if action == "get" {
            if ids.is_empty() {
                return Ok("Error: 'ids' must contain at least one integer memory ID when action is 'get'.".into());
            }
            if ids.len() > 20 {
                return Ok(format!("Error: 'ids' must contain at most 20 memory IDs when action is 'get' (got {}).", ids.len()));
            }
            let mut parts = Vec::new();
            for id in unique(ids) {
                match load(tx, id)?.filter(|row| visible(row, ctx)) {
                    Some(row) => parts.push(format_rows(&[row])),
                    None => parts.push(format!(
                        "id {id}: not found or not visible from this project"
                    )),
                }
            }
            return Ok(parts.join("\n\n"));
        }
        if action == "list" {
            return list(tx, ctx, args);
        }
        if matches!(action, "write" | "update" | "archive" | "merge") {
            let saved: Option<(String,String)> = tx.query_row("SELECT project_path,receipt_json FROM memory_decision_receipts WHERE decision_key=?1",
                [ctx.decision_key], |r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((project, saved)) = saved {
                let saved: Value = serde_json::from_str(&saved).map_err(json_error)?;
                if project != ctx.project_path
                    || saved["request"] != serde_json::to_value(args).map_err(json_error)?
                    || saved["session_id"] != ctx.session_id
                    || saved["harness"] != ctx.harness
                    || saved["role"] != format!("{:?}", ctx.role)
                {
                    return Ok(
                        "Error: Decision key belongs to a different memory invocation.".into(),
                    );
                }
                return Ok(text(&saved, "reply"));
            }
        }
        if action == "write" {
            let content = args
                .content
                .as_deref()
                .unwrap_or_default()
                .trim_matches(js_whitespace);
            if content.is_empty() {
                return Ok("Error: 'content' is required when action is 'write'.".into());
            }
            let raw = args
                .category
                .as_deref()
                .unwrap_or_default()
                .trim_matches(js_whitespace);
            if raw.is_empty() {
                return Ok("Error: 'category' is required when action is 'write'.".into());
            }
            let Some(category) = valid_category(Some(raw)) else {
                return Ok(format!("Error: Unknown memory category '{raw}'."));
            };
            // The existing Rust admission helper requires an authority_managed
            // marker, which tells TypeScript to stop writing this project's memory.
            // These saves must leave TypeScript enabled: match normalized duplicates,
            // reject archived/cross-category matches, otherwise insert directly.
            let hash = compute_normalized_memory_hash(content);
            let matching: Option<i64> = tx.query_row("SELECT id FROM memories WHERE project_path=?1 AND category=?2 AND normalized_hash=?3",params![ctx.project_path,category,hash],|r|r.get(0)).optional()?;
            let cross: Option<i64> = tx.query_row("SELECT id FROM memories WHERE project_path=?1 AND category!=?2 AND normalized_hash=?3 AND content=?4 AND status!='archived' ORDER BY id LIMIT 1",params![ctx.project_path,category,hash,content],|r|r.get(0)).optional()?;
            let archived_match = match matching {
                Some(id) => load(tx, id)?.is_some_and(|r| r["status"] == "archived"),
                None => false,
            };
            let pending = if let Some(id) = matching.filter(|_| archived_match) {
                Some(("archived_match", id))
            } else if matching.is_none() {
                cross.map(|id| ("cross_category_match", id))
            } else {
                None
            };
            if let Some((reason, id)) = pending {
                let reply = format!("{reason}: memory was not saved.");
                save_receipt(
                    tx,
                    ctx,
                    args,
                    json!({"state":"decided_pending","reason":reason,"memoryId":id,"adoptionClass":null}),
                    &reply,
                )?;
                return Ok(reply);
            }
            let id = if let Some(id) = matching {
                tx.execute("UPDATE memories SET seen_count=seen_count+1,last_seen_at=?1,updated_at=?1 WHERE id=?2",params![ctx.now_ms,id])?;
                id
            } else {
                insert_memory(tx, ctx, category, content)?
            };
            let reply = if matching.is_some() {
                format!("Memory already exists [ID: {id}] in {category} (seen count incremented).")
            } else {
                enqueue(tx, queue, ctx, id, EmbeddingEffectKind::Embed)?;
                format!("Saved memory [ID: {id}] in {category}.")
            };
            let receipt = json!({"state":"applied","reason":if matching.is_some() {"live_match"}else{"inserted"},"memoryId":id,"inserted":matching.is_none(),"adoptionClass":null});
            save_receipt(tx, ctx, args, receipt.clone(), &reply)?;
            tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at) VALUES(?1,?2,'agent_save',?3,?4)",params![ctx.project_path,ctx.decision_key,receipt.to_string(),ctx.now_ms])?;
            if !dreamer && !session_shows(tx, ctx, id, &text(&load(tx, id)?.unwrap(), "content"))? {
                fragment(tx, ctx, "write", &[], Some(id), false, category, content)?;
            }
            return Ok(reply);
        }
        if !matches!(action, "update" | "archive" | "merge") {
            return Ok("Error: Unknown action.".into());
        }
        let shape_error = match action {
            "update" if ids.len() != 1 => Some("Error: 'ids' must contain exactly one integer memory ID when action is 'update'."),
            "archive" if ids.is_empty() => Some("Error: 'ids' must contain at least one integer memory ID when action is 'archive'."),
            "merge" if ids.len() < 2 => Some("Error: 'ids' must include at least two integer memory IDs when action is 'merge'."),
            "merge" if unique(ids).len() != ids.len() => Some("Error: 'ids' must include at least two distinct memory IDs when action is 'merge'."),
            _ => None,
        };
        if let Some(error) = shape_error {
            return Ok(error.into());
        }
        let content = args
            .content
            .as_deref()
            .unwrap_or_default()
            .trim_matches(js_whitespace);
        if action != "archive" && content.is_empty() {
            return Ok(format!(
                "Error: 'content' is required when action is '{action}'."
            ));
        }
        let ids = if action == "archive" {
            unique(ids)
        } else {
            ids.to_vec()
        };
        let mut sources = Vec::new();
        for &id in &ids {
            let Some(row) = load(tx, id)? else {
                return Ok(if action == "merge" {
                    "Error: One or more source memories were not found.".into()
                } else {
                    format!("Error: Memory with ID {id} was not found.")
                });
            };
            let allowed = if dreamer {
                visible(&row, ctx)
            } else {
                row["project_path"] == ctx.project_path
            };
            if !allowed {
                return Ok(if dreamer && action == "merge" {
                    format!("Error: Memory with ID {id} is in a category not shared with this workspace member and cannot be merged.")
                } else {
                    format!("Error: Memory with ID {id} was not found.")
                });
            }
            if !dreamer && !live(&row) {
                return Ok(inactive(
                    id,
                    match action {
                        "update" => "updating",
                        "merge" => "merging",
                        _ => "archiving",
                    },
                ));
            }
            sources.push(row);
        }
        let categories =
            sources
                .iter()
                .map(|r| text(r, "category"))
                .fold(Vec::new(), |mut v, c| {
                    if !v.contains(&c) {
                        v.push(c);
                    }
                    v
                });
        if action == "merge" && categories.len() > 1 {
            return Ok(format!("Error: Cannot merge memories from different categories ({}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.", categories.join(", ")));
        }
        let category = if !dreamer && action == "update" {
            args.category
                .as_deref()
                .filter(|c| CATEGORIES[..5].contains(c))
        } else {
            valid_category(args.category.as_deref())
        }
        .unwrap_or(&categories[0]);
        let hash = compute_normalized_memory_hash(content);
        let project = if action == "update" {
            text(&sources[0], "project_path")
        } else {
            ctx.project_path.into()
        };
        let duplicate: Option<i64> = if action == "archive" {
            None
        } else {
            tx.query_row("SELECT id FROM memories WHERE project_path=?1 AND category=?2 AND normalized_hash=?3",params![project,category,hash],|r|r.get(0)).optional()?
        };
        if let Some(id) = duplicate.filter(|id| !ids.contains(id)) {
            return Ok(if action == "merge" && !dreamer {
                format!("Error: Memory content already exists as ID {id}; update or archive existing duplicates instead.")
            } else {
                format!("Error: Memory content already exists as ID {id}; merge or archive duplicates instead.")
            });
        }
        // Every source is validated before the first write. BEGIN IMMEDIATE keeps
        // the revisions stable until all history and queue rows are committed.
        let mut before = ids
            .iter()
            .map(|id| history_snapshot(tx, *id))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in &sources {
            tx.execute(
                "UPDATE memories SET revision=revision+1 WHERE id=?1",
                [number(row, "id")],
            )?;
        }
        let mut canonical = None;
        let mut superseded = Vec::new();
        match action {
            "update" => {
                let id = ids[0];
                update_content(tx, id, content, &hash, ctx.now_ms)?;
                tx.execute(
                    "UPDATE memories SET category=?1 WHERE id=?2",
                    params![category, id],
                )?;
                mutation(
                    tx,
                    ctx,
                    dreamer,
                    &sources[0],
                    "update",
                    None,
                    Some(category),
                    Some(content),
                    false,
                )?;
                enqueue(tx, queue, ctx, id, EmbeddingEffectKind::Embed)?;
                canonical = Some(id);
            }
            "archive" => {
                for source in &sources {
                    let id = number(source, "id");
                    let mut metadata: Value = source["metadata_json"]
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({}));
                    let reason = args
                        .reason
                        .as_deref()
                        .unwrap_or_default()
                        .trim_matches(js_whitespace);
                    if !reason.is_empty() {
                        metadata["archive_reason"] = json!(reason);
                        tx.execute(
                            "UPDATE memories SET metadata_json=?1 WHERE id=?2",
                            params![metadata.to_string(), id],
                        )?;
                    }
                    tx.execute(
                        "UPDATE memories SET status='archived',updated_at=?1 WHERE id=?2",
                        params![ctx.now_ms, id],
                    )?;
                    if dreamer {
                        if let Some(successor) = args.superseded_by {
                            successor_link(tx, ctx, id, successor)?;
                        }
                    }
                    clear_derived(tx, id)?;
                    mutation(tx, ctx, dreamer, source, "archive", None, None, None, true)?;
                    enqueue(tx, queue, ctx, id, EmbeddingEffectKind::Invalidate)?;
                }
            }
            "merge" => {
                let id = if let Some(id) = duplicate {
                    id
                } else {
                    tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,importance,source_session_id,source_type,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,?3,?4,50,?5,?6,?7,?7,?7,?7)",
                        params![ctx.project_path,category,content,hash,ctx.session_id,if dreamer {"dreamer"} else {"agent"},ctx.now_ms])?;
                    tx.last_insert_rowid()
                };
                let target = load(tx, id)?.unwrap();
                if target["content"] != content || target["normalized_hash"] != hash {
                    update_content(tx, id, content, &hash, ctx.now_ms)?;
                    mutation(
                        tx,
                        ctx,
                        dreamer,
                        &target,
                        "update",
                        None,
                        Some(category),
                        Some(content),
                        true,
                    )?;
                }
                let mut ancestry = BTreeSet::new();
                for source in &sources {
                    let source_id = number(source, "id");
                    ancestry.insert(source_id);
                    if let Some(prior) = source["merged_from"]
                        .as_str()
                        .and_then(|s| serde_json::from_str::<Vec<i64>>(s).ok())
                    {
                        ancestry.extend(prior);
                    }
                    if source_id != id {
                        successor_link(tx, ctx, source_id, id)?;
                        clear_derived(tx, source_id)?;
                        mutation(
                            tx,
                            ctx,
                            dreamer,
                            source,
                            "superseded",
                            Some(id),
                            None,
                            None,
                            true,
                        )?;
                        enqueue(tx, queue, ctx, source_id, EmbeddingEffectKind::Invalidate)?;
                        superseded.push(source_id);
                    }
                }
                tx.execute("UPDATE memories SET seen_count=?1,retrieval_count=?2,merged_from=?3,status=?4,updated_at=?5 WHERE id=?6",
                    params![sources.iter().map(|r|number(r,"seen_count")).sum::<i64>(),sources.iter().map(|r|number(r,"retrieval_count")).sum::<i64>(),json!(ancestry).to_string(),if sources.iter().any(|r|r["status"]=="permanent") {"permanent"} else {"active"},ctx.now_ms,id])?;
                clear_derived(tx, id)?;
                enqueue(tx, queue, ctx, id, EmbeddingEffectKind::Embed)?;
                canonical = Some(id);
            }
            _ => unreachable!(),
        }
        let mut after = Vec::new();
        for source in &sources {
            let id = number(source, "id");
            after.push(history_snapshot(tx, id)?.ok_or(rusqlite::Error::InvalidQuery)?);
        }
        if let Some(id) = canonical.filter(|id| !ids.contains(id)) {
            before.push(None);
            after.push(history_snapshot(tx, id)?.ok_or(rusqlite::Error::InvalidQuery)?);
        }
        let writer = if dreamer { "curate" } else { "ctx_memory" };
        let reason = args
            .reason
            .clone()
            .unwrap_or_else(|| format!("{writer}_{action}"));
        let decision = mc_store::memory_history::decision(
            ctx.decision_key,
            ctx.project_path,
            writer,
            action,
            &reason,
            ctx.now_ms,
            &before,
            &after,
            &ids,
            if action == "merge" { canonical } else { None },
            json!([]),
        );
        mc_store::memory_history::record_decision(tx, &decision).map_err(history_error)?;
        let reply = match action {
            "update" => format!("Updated memory [ID: {}] in {category}.",ids[0]),
            "merge" => format!("Merged memories [{}] into canonical memory [ID: {}] in {category}; superseded [{}].",ids_text(&ids),canonical.unwrap(),ids_text(&superseded)),
            _ => {
                let base = format!("Archived {} [ID: {}]",if ids.len()>1 {"memories"} else {"memory"},ids_text(&ids));
                let reason = args.reason.as_deref().unwrap_or_default().trim_matches(js_whitespace);
                if reason.is_empty() {format!("{base}.")} else {format!("{base} ({reason}).")}
            }
        };
        if !dreamer {
            fragment(
                tx,
                ctx,
                action,
                &sources,
                canonical,
                duplicate.is_some(),
                category,
                content,
            )?;
        }
        let receipt = AppliedMutationReceipt {
            state: "applied",
            reason: action,
            memory_id: canonical.unwrap_or(ids[0]),
            adoption_class: if dreamer { "deferred" } else { "live" },
            superseded_ids: &superseded,
        };
        save_receipt(
            tx,
            ctx,
            args,
            serde_json::to_value(&receipt).map_err(json_error)?,
            &reply,
        )?;
        tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,before_json,after_json,applied_at) VALUES(?1,?2,?3,?4,?5,?5,?6)",params![ctx.project_path,ctx.decision_key,format!("{writer}_{action}"),serde_json::to_string(&receipt).map_err(json_error)?,mc_store::memory_history::canonical_json(&decision),ctx.now_ms])?;
        Ok(reply)
    }

    fn curate_preflight(
        &mut self,
        tx: &Transaction<'_>,
        ctx: &MemoryActionContext<'_>,
        args: &MemoryActionArgs,
    ) -> rusqlite::Result<Option<String>> {
        let action = args.action.as_deref().unwrap_or_default();
        let ids = args.ids.as_deref().unwrap_or_default();
        let content = args
            .content
            .as_deref()
            .unwrap_or_default()
            .trim_matches(js_whitespace);
        if !matches!(action, "archive" | "update")
            || ids.is_empty()
            || (action == "update" && (ids.len() != 1 || content.is_empty()))
        {
            return Ok(None);
        }
        let mut rows = Vec::new();
        for id in unique(ids) {
            let Some(row) = load(tx, id)? else {
                return Ok(None);
            };
            rows.push(row);
        }
        let successor = match args.superseded_by {
            Some(id) => load(tx, id)?,
            None => None,
        };
        let mut refused_ids = Vec::new();
        let mut reasons = Vec::new();
        for row in rows {
            let survives = successor.as_ref().is_some_and(|s| {
                s["id"] != row["id"]
                    && s["status"] == "active"
                    && s["superseded_by_memory_id"].is_null()
                    && (s["expires_at"].is_null() || number(s, "expires_at") > ctx.now_ms)
                    && s["project_path"] == row["project_path"]
                    && s["category"] == row["category"]
            });
            let reason = if action == "archive" && !survives {
                Some("missing-active-same-category-successor")
            } else if action == "archive"
                && CATEGORIES[..5].contains(&text(&row, "category").as_str())
                && profile_reference(args.reason.as_deref().unwrap_or_default())
            {
                Some("user-profile-is-not-project-memory")
            } else if directive(&text(&row, "category"), &text(&row, "content")) {
                Some("directive-shaped-project-rule")
            } else if action == "update"
                && content.encode_utf16().count() * 2
                    < text(&row, "content")
                        .trim_matches(js_whitespace)
                        .encode_utf16()
                        .count()
                && !survives
            {
                Some("content-loss")
            } else {
                None
            };
            if let Some(reason) = reason {
                refused_ids.push(number(&row, "id"));
                if !reasons.contains(&reason) {
                    reasons.push(reason);
                }
            }
        }
        if refused_ids.is_empty() {
            return Ok(None);
        }
        let count = self.refusals.entry(ctx.session_id.into()).or_default();
        *count += refused_ids.len();
        Ok(Some(format!(
            "Skipped {action} for memory [ID: {}]: curate safety refusal ({}); refused={count}.",
            ids_text(&refused_ids),
            reasons.join(",")
        )))
    }
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}
fn insert_memory(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    category: &str,
    content: &str,
) -> rusqlite::Result<i64> {
    tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,importance,source_session_id,source_type,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,?3,?4,50,?5,?6,?7,?7,?7,?7)",params![ctx.project_path,category,content,compute_normalized_memory_hash(content),ctx.session_id,if ctx.role==MemoryRole::Dreamer {"dreamer"} else {"agent"},ctx.now_ms])?;
    Ok(tx.last_insert_rowid())
}
fn save_receipt(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    args: &MemoryActionArgs,
    mut receipt: Value,
    reply: &str,
) -> rusqlite::Result<()> {
    receipt["request"] = serde_json::to_value(args).map_err(json_error)?;
    receipt["session_id"] = json!(ctx.session_id);
    receipt["harness"] = json!(ctx.harness);
    receipt["role"] = json!(format!("{:?}", ctx.role));
    receipt["reply"] = json!(reply);
    tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,?2,?3,?4)",params![ctx.decision_key,ctx.project_path,receipt.to_string(),ctx.now_ms])?;
    Ok(())
}
fn session_shows(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    id: i64,
    content: &str,
) -> rusqlite::Result<bool> {
    let metadata=tx.prepare("SELECT projected_metadata_json FROM memory_applied_rows WHERE session_id=?1 AND harness=?2 AND memory_id=?3 AND projected_text=?4")?.query_map(params![ctx.session_id,ctx.harness,id,content],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for raw in metadata {
        if serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v["representations"].as_array().cloned())
            .is_some_and(|v| v.iter().any(|r| r == "text" || r == "delta"))
        {
            return Ok(true);
        }
    }
    let snapshot:Option<String>=tx.query_row("SELECT committed_fragments_json FROM memory_applied_snapshots WHERE session_id=?1 AND harness=?2 LIMIT 1",params![ctx.session_id,ctx.harness],|r|r.get(0)).optional()?;
    Ok(snapshot
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .is_some_and(|fs| {
            fs.iter().any(|f| {
                f["form"] == "full"
                    && f["visibleTexts"]
                        .as_array()
                        .is_some_and(|v| v.iter().any(|v| v["id"] == id && v["text"] == content))
            })
        }))
}
#[allow(clippy::too_many_arguments)]
fn fragment(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    action: &str,
    sources: &[Value],
    canonical: Option<i64>,
    existed: bool,
    category: &str,
    content: &str,
) -> rusqlite::Result<()> {
    let mut lines = Vec::new();
    let mut ids = Vec::new();
    let mut texts = Vec::new();
    for source in sources {
        let id = number(source, "id");
        if action == "archive" {
            lines.push(format!("  <removed id=\"{id}\"/>"));
            ids.push(id);
        } else if action == "merge" && Some(id) != canonical {
            lines.push(format!(
                "  <superseded id=\"{id}\" by=\"{}\"/>",
                canonical.unwrap()
            ));
            ids.push(id);
        }
    }
    if let Some(id) = canonical {
        let row = load(tx, id)?.unwrap();
        let final_text = if action == "write" {
            text(&row, "content")
        } else {
            content.into()
        };
        if action != "merge" || !session_shows(tx, ctx, id, &final_text)? {
            let kind = if action == "update"
                || (action == "merge" && existed && sources.iter().any(|s| s["id"] == id))
            {
                "updated"
            } else {
                "added"
            };
            lines.push(mc_store::memory_projection::text_line(
                kind,
                id,
                category,
                &final_text,
            ));
            texts.push(json!({"id":id,"text":final_text}));
        }
        ids.push(id);
    }
    if !lines.is_empty() {
        tx.execute("INSERT OR IGNORE INTO memory_agent_fragments(session_id,harness,project_path,operation_key,memory_ids_json,current_id,lines,visible_texts_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![ctx.session_id,ctx.harness,ctx.project_path,ctx.decision_key,json!(ids).to_string(),canonical,lines.join("\n"),json!(texts).to_string(),ctx.now_ms])?;
    }
    Ok(())
}
fn valid_reduced(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.iter().all(|(key, value)| match key.as_str() {
            "action" => value.as_str().is_some_and(|s| {
                [
                    "write", "update", "archive", "merge", "get", "list", "search",
                ]
                .contains(&s)
            }),
            "category" => value.as_str().is_some_and(|s| CATEGORIES[..5].contains(&s)),
            "content" | "reason" | "summary" => value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 1024 * 1024),
            "limit" | "superseded_by" => value.is_number(),
            "ids" => value
                .as_array()
                .is_some_and(|v| v.len() <= 100 && v.iter().all(Value::is_number)),
            "reduced" => value.is_boolean(),
            _ => false,
        })
    })
}
fn enqueue(
    tx: &Transaction<'_>,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    id: i64,
    kind: EmbeddingEffectKind,
) -> rusqlite::Result<()> {
    let row = load(tx, id)?.unwrap();
    queue.enqueue_tx(
        tx,
        &EmbeddingEffect {
            project_path: text(&row, "project_path"),
            session_id: ctx.session_id.into(),
            memory_id: id,
            kind,
            content: if kind == EmbeddingEffectKind::Embed {
                Some(text(&row, "content"))
            } else {
                None
            },
            content_hash: text(&row, "normalized_hash"),
            queued_at: ctx.now_ms,
        },
    )
}
fn clear_derived(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE memories SET shareable=0,classified_at=NULL WHERE id=?1",
        [id],
    )?;
    tx.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", [id])?;
    tx.execute("DELETE FROM memory_verifications WHERE memory_id=?1", [id])?;
    Ok(())
}
fn update_content(
    tx: &Transaction<'_>,
    id: i64,
    content: &str,
    hash: &str,
    now: i64,
) -> rusqlite::Result<()> {
    tx.execute("UPDATE memories SET content=?1,normalized_hash=?2,updated_at=?3,mural_cue=NULL,mural_cue_hash=NULL,mural_cue_at=NULL,mural_cue_rejection_count=0 WHERE id=?4",params![content,hash,now,id])?;
    clear_derived(tx, id)
}
fn successor_link(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    id: i64,
    successor: i64,
) -> rusqlite::Result<()> {
    tx.execute("UPDATE memories SET superseded_by_memory_id=?1,status='archived',updated_at=?2 WHERE id=?3",params![successor,ctx.now_ms,id])?;
    tx.execute("INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?1,?2,?3)",params![id,successor,ctx.decision_key])?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn mutation(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    automated: bool,
    row: &Value,
    kind: &str,
    successor: Option<i64>,
    category: Option<&str>,
    content: Option<&str>,
    operation: bool,
) -> rusqlite::Result<()> {
    if !automated {
        tx.execute("INSERT INTO memory_mutation_log(project_path,mutation_type,target_memory_id,superseded_by_id,category,new_content,queued_at,operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![text(row,"project_path"),kind,number(row,"id"),successor,category,content,ctx.now_ms,if operation {Some(ctx.decision_key)} else {None}])?;
    }
    Ok(())
}

fn profile_reference(reason: &str) -> bool {
    js_regex(r"(?i)\buser(?:(?:\s|_|-)+)(?:profile|preferences?)\b|\bU\d+\b").is_match(reason)
}
fn directive(category: &str, content: &str) -> bool {
    if category != "PROJECT_RULES" {
        return false;
    }
    [r"(?i)(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
     r"(?i)\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
     r"(?i)\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
     r"(?i)(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
     r"(?i)\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b"]
        .iter().any(|pattern|js_regex(pattern).is_match(content.trim_matches(js_whitespace)))
}

fn list(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    args: &MemoryActionArgs,
) -> rusqlite::Result<String> {
    let limit = args
        .limit
        .filter(|n| n.is_finite() && *n != 0.0)
        .map(|n| n.floor().max(1.0) as usize)
        .unwrap_or(10);
    let category = args
        .category
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty());
    let ids = tx.prepare("SELECT id FROM memories WHERE project_path=?1 AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at>?2) ORDER BY category ASC,updated_at DESC,id ASC")?
        .query_map(params![ctx.project_path,ctx.now_ms],|r|r.get::<_,i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut rows = Vec::new();
    for id in ids {
        let row = load(tx, id)?.unwrap();
        let cat = text(&row, "category");
        if !CATEGORIES.contains(&cat.as_str()) {
            continue;
        }
        if let Some(scope) = ctx.curate_category {
            if bucket(&cat) != scope {
                continue;
            }
        } else if category.is_some_and(|c| c != cat) {
            continue;
        }
        rows.push(row);
        if rows.len() == limit {
            break;
        }
    }
    Ok(format_rows(&rows))
}
fn format_rows(rows: &[Value]) -> String {
    if rows.is_empty() {
        return "No active memories found.".into();
    }
    let headers = ["ID", "CATEGORY", "STATUS", "VERIFY", "UPDATED", "CONTENT"].map(str::to_string);
    let data = rows
        .iter()
        .map(|r| {
            [
                number(r, "id").to_string(),
                text(r, "category"),
                text(r, "status"),
                text(r, "verification_status"),
                chrono::DateTime::from_timestamp_millis(number(r, "updated_at"))
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                text(r, "content")
                    .split(js_whitespace)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            ]
        })
        .collect::<Vec<_>>();
    let widths = (0..5)
        .map(|i| {
            data.iter()
                .map(|r| r[i].encode_utf16().count())
                .chain([headers[i].len()])
                .max()
                .unwrap()
        })
        .collect::<Vec<_>>();
    let render = |row: &[String; 6]| {
        (0..6)
            .map(|i| {
                if i < 5 {
                    format!(
                        "{}{}",
                        row[i],
                        " ".repeat(widths[i] - row[i].encode_utf16().count())
                    )
                } else {
                    row[i].clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let mut lines = vec![
        format!(
            "Found {} {}{}:",
            rows.len(),
            if rows.iter().all(|r| r["status"] == "active") {
                "active "
            } else {
                ""
            },
            if rows.len() == 1 {
                "memory"
            } else {
                "memories"
            }
        ),
        String::new(),
        render(&headers),
        widths
            .iter()
            .map(|w| "-".repeat(*w))
            .chain(["-------".into()])
            .collect::<Vec<_>>()
            .join("-+-"),
    ];
    lines.extend(data.iter().map(render));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &include_str!("../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", &NOW.to_string()),
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE test_embedding_queue(id INTEGER PRIMARY KEY, effect_json TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }
    struct Queue;
    impl MemoryEmbeddingQueue for Queue {
        fn enqueue_tx(
            &self,
            tx: &Transaction<'_>,
            effect: &EmbeddingEffect,
        ) -> rusqlite::Result<()> {
            assert!(
                !tx.is_autocommit(),
                "embedding effects require the memory transaction"
            );
            tx.execute(
                "INSERT INTO test_embedding_queue(effect_json) VALUES(?1)",
                [serde_json::to_string(effect).unwrap()],
            )?;
            Ok(())
        }
    }
    fn context(key: &str, role: MemoryRole) -> MemoryActionContext<'_> {
        MemoryActionContext {
            project_path: "project-a",
            session_id: "session-a",
            harness: "opencode",
            role,
            workspace_members: &[],
            shared_categories: &[],
            curate_category: None,
            memory_enabled: true,
            now_ms: NOW,
            decision_key: key,
        }
    }
    fn args(value: Value) -> MemoryActionArgs {
        serde_json::from_value(value).unwrap()
    }
    fn run(
        actions: &mut MemoryActions,
        conn: &mut Connection,
        key: &str,
        role: MemoryRole,
        value: Value,
    ) -> String {
        actions
            .execute(conn, &Queue, &context(key, role), &args(value))
            .unwrap()
    }
    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }
    fn all_rows(conn: &Connection) -> Vec<Value> {
        let ids = conn
            .prepare("SELECT id FROM memories ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<i64>>>()
            .unwrap();
        ids.into_iter()
            .map(|id| load(conn, id).unwrap().unwrap())
            .collect()
    }
    fn histories(conn: &Connection) -> Vec<Value> {
        conn.prepare("SELECT memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id").unwrap()
            .query_map([],|r|Ok(json!({"memory_id":r.get::<_,i64>(0)?,"revision":r.get::<_,i64>(1)?,"previous_text":r.get::<_,String>(2)?,"after_text":r.get::<_,String>(3)?,"before_json":r.get::<_,String>(4)?,"after_json":r.get::<_,String>(5)?,"applied_at":r.get::<_,i64>(6)?,"reason":r.get::<_,String>(7)?,"evidence_json":r.get::<_,String>(8)?,"source_ids_json":r.get::<_,String>(9)?}))).unwrap()
            .collect::<rusqlite::Result<_>>().unwrap()
    }
    fn queued(conn: &Connection) -> Vec<Value> {
        conn.prepare("SELECT effect_json FROM test_embedding_queue ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok(serde_json::from_str::<Value>(&r.get::<_, String>(0)?).unwrap())
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn assert_ts_ownership(conn: &Connection) {
        assert_eq!(scalar(conn, "SELECT COUNT(*) FROM authority_managed"), 0);
        assert_eq!(
            scalar(conn, "SELECT COUNT(*) FROM authority_repair_pending"),
            0
        );
        assert_eq!(
            scalar(
                conn,
                "SELECT COUNT(*) FROM memory_pending_facts WHERE reason='authority_elsewhere'"
            ),
            0
        );
        assert_eq!(
            scalar(
                conn,
                "SELECT COUNT(*) FROM project_state WHERE project_memory_epoch!=0"
            ),
            0
        );
    }

    // CI regenerates this fixture from the pinned TypeScript oracle and rejects drift.
    #[test]
    fn ts_a06_a12_replies_rows_history_and_embedding_effects() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/memory_actions/golden.json"))
                .expect("parse memory_actions TypeScript golden");
        assert_eq!(vectors.len(), 34, "memory_actions golden vector count");
        let mut conn = database();
        let mut actions = MemoryActions::default();
        for (index, vector) in vectors.iter().enumerate() {
            let key = format!("oracle-{index}");
            let role = if vector["role"] == "dreamer" {
                MemoryRole::Dreamer
            } else {
                MemoryRole::Primary
            };
            let reply = actions
                .execute_value(&mut conn, &Queue, &context(&key, role), &vector["args"])
                .unwrap();
            assert_eq!(reply, vector["reply"], "TS reply vector {index}");
            assert_eq!(
                json!(all_rows(&conn)),
                vector["memories"],
                "TS memory rows vector {index}"
            );
            assert_eq!(
                json!(histories(&conn)),
                vector["history"],
                "TS history vector {index}"
            );
            let mutation_rows = conn.prepare("SELECT mutation_type,target_memory_id,superseded_by_id,category,new_content,queued_at FROM memory_mutation_log ORDER BY id").unwrap().query_map([],|r|Ok(json!({"mutation_type":r.get::<_,String>(0)?,"target_memory_id":r.get::<_,i64>(1)?,"superseded_by_id":r.get::<_,Option<i64>>(2)?,"category":r.get::<_,Option<String>>(3)?,"new_content":r.get::<_,Option<String>>(4)?,"queued_at":r.get::<_,i64>(5)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            assert_eq!(
                json!(mutation_rows),
                vector["mutations"],
                "TS mutation effects vector {index}"
            );
            let fragments = conn.prepare("SELECT session_id,harness,project_path,memory_ids_json,current_id,lines,visible_texts_json,created_at FROM memory_agent_fragments ORDER BY id").unwrap().query_map([],|r|Ok(json!({"session_id":r.get::<_,String>(0)?,"harness":r.get::<_,String>(1)?,"project_path":r.get::<_,String>(2)?,"memory_ids_json":r.get::<_,String>(3)?,"current_id":r.get::<_,Option<i64>>(4)?,"lines":r.get::<_,String>(5)?,"visible_texts_json":r.get::<_,String>(6)?,"created_at":r.get::<_,i64>(7)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            assert_eq!(
                json!(fragments),
                vector["fragments"],
                "TS agent fragment effects vector {index}"
            );
            let embed_texts = queued(&conn)
                .iter()
                .filter(|e| e["kind"] == "embed")
                .map(|e| text(e, "content"))
                .collect::<Vec<_>>();
            assert_eq!(
                json!(embed_texts),
                vector["embedCalls"],
                "TS embedding effects vector {index}"
            );
            for effect in queued(&conn) {
                assert_eq!(effect["project_path"], "project-a");
                assert_eq!(effect["session_id"], "session-a");
                assert_eq!(effect["queued_at"], NOW);
                if effect["kind"] == "embed" {
                    assert_eq!(
                        effect["content_hash"],
                        compute_normalized_memory_hash(effect["content"].as_str().unwrap())
                    );
                }
            }
            assert_eq!(vector["tsOwnsMemory"], true);
            assert_ts_ownership(&conn);
        }
        assert_eq!(
            queued(&conn)
                .iter()
                .filter(|e| e["kind"] == "invalidate")
                .map(|e| number(e, "memory_id"))
                .collect::<Vec<_>>(),
            vec![2, 1, 3, 4]
        );
    }

    #[test]
    fn queue_and_memory_rollback_after_enqueue() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        run(
            &mut actions,
            &mut conn,
            "seed",
            MemoryRole::Primary,
            json!({"action":"write","category":"CONSTRAINTS","content":"A sufficiently long fact."}),
        );
        conn.execute_batch("DELETE FROM test_embedding_queue; CREATE TRIGGER fail_history BEFORE INSERT ON memory_history BEGIN SELECT RAISE(ABORT,'history unavailable'); END;").unwrap();
        let before = all_rows(&conn);
        let result = actions.execute(
            &mut conn,
            &Queue,
            &context("update", MemoryRole::Primary),
            &args(json!({"action":"update","ids":[1],"content":"Changed sufficiently long fact."})),
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("history unavailable"));
        assert_eq!(all_rows(&conn), before);
        assert!(queued(&conn).is_empty());
        assert!(histories(&conn).is_empty());
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM memory_mutation_log"), 0);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM memory_decision_receipts"),
            1
        );
    }

    #[test]
    fn queue_failure_rolls_back_admission_and_history() {
        struct FailingQueue;
        impl MemoryEmbeddingQueue for FailingQueue {
            fn enqueue_tx(
                &self,
                tx: &Transaction<'_>,
                effect: &EmbeddingEffect,
            ) -> rusqlite::Result<()> {
                Queue.enqueue_tx(tx, effect)?;
                Err(rusqlite::Error::InvalidQuery)
            }
        }
        let mut conn = database();
        assert!(MemoryActions::default()
            .execute(
                &mut conn,
                &FailingQueue,
                &context("save", MemoryRole::Primary),
                &args(json!({"action":"write","category":"NAMING","content":"A fact."}))
            )
            .is_err());
        assert!(all_rows(&conn).is_empty());
        assert!(queued(&conn).is_empty());
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM memory_decision_receipts"),
            0
        );
    }

    #[test]
    fn replay_is_effect_free_and_keys_cannot_cross_invocations_or_projects() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        let write = json!({"action":"write","category":"CONSTRAINTS","content":"A fact."});
        let reply = run(
            &mut actions,
            &mut conn,
            "save",
            MemoryRole::Primary,
            write.clone(),
        );
        assert_eq!(
            run(
                &mut actions,
                &mut conn,
                "save",
                MemoryRole::Primary,
                write.clone()
            ),
            reply
        );
        assert_eq!(number(&all_rows(&conn)[0], "seen_count"), 1);
        assert_eq!(queued(&conn).len(), 1);
        let mut ctx = context("save", MemoryRole::Primary);
        ctx.project_path = "foreign";
        assert_eq!(
            actions
                .execute(&mut conn, &Queue, &ctx, &args(write))
                .unwrap(),
            "Error: Decision key belongs to a different memory invocation."
        );
        let update = json!({"action":"update","ids":[1],"content":"A newer fact."});
        let reply = run(
            &mut actions,
            &mut conn,
            "edit",
            MemoryRole::Primary,
            update.clone(),
        );
        assert_eq!(
            run(&mut actions, &mut conn, "edit", MemoryRole::Primary, update),
            reply
        );
        assert_eq!(histories(&conn).len(), 1);
        assert_eq!(queued(&conn).len(), 2);
        assert_eq!(
            run(
                &mut actions,
                &mut conn,
                "edit",
                MemoryRole::Primary,
                json!({"action":"archive","ids":[1]})
            ),
            "Error: Decision key belongs to a different memory invocation."
        );
    }

    #[test]
    fn primary_batch_preflight_and_workspace_curate_do_not_widen_scope() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        for (key, project, category) in [
            ("own", "project-a", "CONSTRAINTS"),
            ("shared", "project-b", "CONSTRAINTS"),
            ("private", "project-b", "NAMING"),
        ] {
            let mut ctx = context(key, MemoryRole::Primary);
            ctx.project_path = project;
            actions.execute(&mut conn,&Queue,&ctx,&args(json!({"action":"write","category":category,"content":format!("Fact {key}.")}))).unwrap();
        }
        let before = all_rows(&conn);
        let jobs = queued(&conn);
        let members = vec!["project-b".into()];
        let categories = vec!["CONSTRAINTS".into()];
        let mut ctx = context("foreign", MemoryRole::Primary);
        ctx.workspace_members = &members;
        ctx.shared_categories = &categories;
        assert_eq!(
            actions
                .execute(
                    &mut conn,
                    &Queue,
                    &ctx,
                    &args(json!({"action":"archive","ids":[1,2]}))
                )
                .unwrap(),
            "Error: Memory with ID 2 was not found."
        );
        assert_eq!(all_rows(&conn), before);
        assert_eq!(queued(&conn), jobs);
        ctx.role = MemoryRole::Dreamer;
        assert_eq!(
            actions
                .execute(
                    &mut conn,
                    &Queue,
                    &ctx,
                    &args(json!({"action":"update","ids":[2],"content":"Fact shared updated."}))
                )
                .unwrap(),
            "Updated memory [ID: 2] in CONSTRAINTS."
        );
        ctx.decision_key = "hidden";
        assert_eq!(
            actions
                .execute(
                    &mut conn,
                    &Queue,
                    &ctx,
                    &args(json!({"action":"update","ids":[3],"content":"Fact private updated."}))
                )
                .unwrap(),
            "Error: Memory with ID 3 was not found."
        );
        let get = actions
            .execute(
                &mut conn,
                &Queue,
                &ctx,
                &args(json!({"action":"get","ids":[3,999]})),
            )
            .unwrap();
        assert_eq!(get,"id 3: not found or not visible from this project\n\nid 999: not found or not visible from this project");
        assert_ts_ownership(&conn);
    }

    #[test]
    fn curate_successor_and_category_preflight_is_atomic() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        for (key, category, content) in [
            (
                "one",
                "CONFIG_VALUES",
                "A long fact about the configuration.",
            ),
            (
                "two",
                "CONFIG_VALUES",
                "A replacement fact about configuration.",
            ),
            ("three", "NAMING", "Names use camelCase."),
        ] {
            run(
                &mut actions,
                &mut conn,
                key,
                MemoryRole::Dreamer,
                json!({"action":"write","category":category,"content":content}),
            );
        }
        let before = all_rows(&conn);
        let jobs = queued(&conn);
        let mut ctx = context("scope", MemoryRole::Dreamer);
        ctx.curate_category = Some("CONFIG_VALUES");
        assert_eq!(
            actions
                .execute(
                    &mut conn,
                    &Queue,
                    &ctx,
                    &args(json!({"action":"archive","ids":[1],"superseded_by":3}))
                )
                .unwrap(),
            "Error: Curate scope is CONFIG_VALUES; memory ID 3 is outside the scoped category."
        );
        assert_eq!(actions.execute(&mut conn,&Queue,&ctx,&args(json!({"action":"archive","ids":[1]}))).unwrap(),"Skipped archive for memory [ID: 1]: curate safety refusal (missing-active-same-category-successor); refused=1.");
        assert_eq!(actions.execute(&mut conn,&Queue,&ctx,&args(json!({"action":"archive","ids":[1],"superseded_by":2,"reason":"user profile"}))).unwrap(),"Skipped archive for memory [ID: 1]: curate safety refusal (user-profile-is-not-project-memory); refused=2.");
        assert_eq!(all_rows(&conn), before);
        assert_eq!(queued(&conn), jobs);
        assert_eq!(actions.execute(&mut conn,&Queue,&ctx,&args(json!({"action":"archive","ids":[1],"superseded_by":2,"reason":"duplicate configuration"}))).unwrap(),"Archived memory [ID: 1] (duplicate configuration).");
        assert_eq!(
            scalar(
                &conn,
                "SELECT successor_id FROM memory_successor_links WHERE source_id=1"
            ),
            2
        );
        assert_eq!(histories(&conn).len(), 1);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM memory_mutation_log"), 0);
        assert_ts_ownership(&conn);
    }

    #[test]
    fn content_mutations_clear_derived_data_and_enqueue_exact_payloads() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        run(
            &mut actions,
            &mut conn,
            "seed",
            MemoryRole::Primary,
            json!({"action":"write","category":"NAMING","content":"Original fact."}),
        );
        conn.execute_batch("INSERT INTO memory_embeddings(memory_id,model_id,embedding) VALUES(1,'fixture',X'00000000'); INSERT INTO memory_verifications(memory_id,file_path,verified_at) VALUES(1,'src/a.rs',1); UPDATE memories SET shareable=1,classified_at=1,mural_cue='old cue',mural_cue_hash='old hash',mural_cue_at=1,mural_cue_rejection_count=3 WHERE id=1; DELETE FROM test_embedding_queue;").unwrap();
        run(
            &mut actions,
            &mut conn,
            "update",
            MemoryRole::Primary,
            json!({"action":"update","ids":[1],"content":"Updated fact."}),
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM memory_embeddings"), 0);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM memory_verifications"),
            0
        );
        let row = load(&conn, 1).unwrap().unwrap();
        assert_eq!(row["shareable"], 0);
        assert!(row["classified_at"].is_null());
        assert!(row["mural_cue"].is_null());
        assert_eq!(row["mural_cue_rejection_count"], 0);
        run(
            &mut actions,
            &mut conn,
            "archive",
            MemoryRole::Primary,
            json!({"action":"archive","ids":[1]}),
        );
        assert_eq!(
            queued(&conn),
            vec![
                json!({"project_path":"project-a","session_id":"session-a","memory_id":1,"kind":"embed","content":"Updated fact.","content_hash":compute_normalized_memory_hash("Updated fact."),"queued_at":NOW}),
                json!({"project_path":"project-a","session_id":"session-a","memory_id":1,"kind":"invalidate","content":null,"content_hash":compute_normalized_memory_hash("Updated fact."),"queued_at":NOW}),
            ]
        );
        assert_ts_ownership(&conn);
    }

    #[test]
    fn list_is_dreamer_only_default_ten_and_get_keeps_requested_order() {
        let mut conn = database();
        let mut actions = MemoryActions::default();
        for i in 0..12 {
            run(
                &mut actions,
                &mut conn,
                &format!("seed-{i}"),
                MemoryRole::Dreamer,
                json!({"action":"write","category":if i<6 {"NAMING"}else{"CONSTRAINTS"},"content":format!("Fact number {i}.")}),
            );
        }
        assert_eq!(
            run(
                &mut actions,
                &mut conn,
                "primary-list",
                MemoryRole::Primary,
                json!({"action":"list"})
            ),
            "Error: Action 'list' is not allowed in this context."
        );
        let list = run(
            &mut actions,
            &mut conn,
            "list",
            MemoryRole::Dreamer,
            json!({"action":"list"}),
        );
        assert!(list.starts_with("Found 10 active memories:"));
        let rows = list.lines().skip(4).collect::<Vec<_>>();
        assert_eq!(rows.len(), 10);
        assert!(rows[0].starts_with("7 "));
        let get = run(
            &mut actions,
            &mut conn,
            "get",
            MemoryRole::Primary,
            json!({"action":"get","ids":[12,1,12,2]}),
        );
        assert_eq!(get.matches("Found 1 active memory:").count(), 3);
        assert!(get.find("Fact number 11.").unwrap() < get.find("Fact number 0.").unwrap());
        assert!(get.find("Fact number 0.").unwrap() < get.find("Fact number 1.").unwrap());
    }
}
