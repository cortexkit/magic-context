//! Record code-check results against the memory revision that was checked.
//! Automated corrections and archives use the same mutation applier as curate,
//! preserving prior memory content and status for undo.

use crate::host_store::HostStore;
use mc_store::memory_lifecycle::{applier::fresh_decision_key, authority::module_owns_memory};
use mc_store::McStore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct VerificationRow {
    memory_id: i64,
    expected_revision: i64,
    content_hash_at_prompt: String,
    verification_status: String,
    files: Vec<String>,
    checked_commit: Option<String>,
    #[serde(default = "source_matches")]
    source_commit_matches: bool,
    updated_content: Option<String>,
    archive_reason: Option<String>,
    refusal_reason: Option<String>,
}

fn source_matches() -> bool {
    true
}

pub(crate) fn validate_rows(value: &Value) -> Result<Vec<VerificationRow>, String> {
    let rows: Vec<VerificationRow> =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    let mut ids = std::collections::HashSet::new();
    for row in &rows {
        if row.expected_revision < 1 || !ids.insert(row.memory_id) {
            return Err("verification requires positive revisions and unique memory ids".into());
        }
        if ![
            "verified", "update", "archive", "skipped", "unmapped", "failed",
        ]
        .contains(&row.verification_status.as_str())
        {
            return Err("invalid verification_status".into());
        }
        if row.checked_commit.as_ref().is_some_and(|head| {
            head.len() != 40 || !head.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err("checked_commit must be a Git commit or null".into());
        }
        normalized_files(&row.files)?;
    }
    Ok(rows)
}

fn normalized_files(files: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for file in files {
        let file = file.trim().replace('\\', "/");
        if file.is_empty() {
            continue;
        }
        if file.starts_with('/') || file.contains(':') || file.split('/').any(|part| part == "..") {
            return Err("verification files must be repo-relative".into());
        }
        let file = file
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect::<Vec<_>>()
            .join("/");
        if !file.is_empty() {
            normalized.push(file);
        }
    }
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn git_head(root: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C", root, "rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_owned())
}

/// Use the module's attached context.db and privileged writer transaction, never a
/// fallback write through the TypeScript host's database connection.
/// A saved batch response commits with its row updates; a retry returns that response without stamping the rows again.
pub(crate) fn apply(
    store: &McStore,
    project: &str,
    root: &str,
    session: &str,
    command: Option<&str>,
    rows: &[VerificationRow],
    now: i64,
) -> Result<Vec<u8>, String> {
    store.with_facade_mutation(root, "memories", || {
        let status = store.context_domain_status();
        let path = status.get("path").and_then(Value::as_str).ok_or("context domain unavailable")?;
        let mut writer = HostStore::open_with_private_permissions(Path::new(path), crate::config::private_storage_permissions_enabled()).map_err(|error| error.to_string())?;
        let nonce = fresh_decision_key("verification", now);
        let key = format!("verification-batch:{}", json!([project, session, command.unwrap_or(&nonce)]));
        let head = git_head(root);
        let mut response = None;
        writer.with_domain_transaction(&["memories", "memory_verifications", "memory_history", "memory_decision_receipts", "memory_journal"], &mut |tx| {
            if let Some(saved) = tx.query_row("SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=?1", [&key], |row| row.get::<_, String>(0)).optional()? {
                response = Some(saved.into_bytes());
                return Ok(());
            }
            let mut results = Vec::new();
            let mut accepted = Vec::new();
            let mut rejected = Vec::new();
            for row in rows {
                let result = apply_row(tx, project, &key, row, head.as_deref(), now)?;
                if result["state"] == "applied" { accepted.push(row.memory_id); }
                else { rejected.push(json!({"memory_id": row.memory_id, "reason": result["reason"]})); }
                results.push(result);
            }
            let result = json!({"ok": true, "accepted": accepted, "rejected": rejected, "results": results}).to_string();
            tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,?2,?3,?4)", params![key, project, result, now])?;
            response = Some(result.into_bytes());
            Ok(())
        }).map_err(|error| error.to_string())?;
        response.ok_or_else(|| "verification produced no receipt".into())
    })
}

struct VerificationTarget {
    project: String,
    hash: String,
    revision: i64,
    status: String,
    successor: Option<i64>,
    metadata: Option<String>,
}

pub(crate) fn apply_row(
    conn: &Connection,
    project: &str,
    batch_key: &str,
    row: &VerificationRow,
    head: Option<&str>,
    now: i64,
) -> rusqlite::Result<Value> {
    mc_store::with_automated_memory_mutation_tx(conn, |applier| {
        apply_row_with_applier(conn, applier, project, batch_key, row, head, now)
            .map_err(|error| error.to_string())
    })
    .map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
    })
}

fn apply_row_with_applier(
    conn: &Connection,
    applier: &mc_store::FacadeMutationTxn<'_>,
    project: &str,
    batch_key: &str,
    row: &VerificationRow,
    head: Option<&str>,
    now: i64,
) -> rusqlite::Result<Value> {
    let memory: Option<VerificationTarget> = conn.query_row(
        "SELECT project_path,normalized_hash,revision,status,superseded_by_memory_id,metadata_json FROM memories WHERE id=?1",
        [row.memory_id], |record| Ok(VerificationTarget { project: record.get(0)?, hash: record.get(1)?, revision: record.get(2)?, status: record.get(3)?, successor: record.get(4)?, metadata: record.get(5)? }),
    ).optional()?;
    let refusal = match memory.as_ref() {
        None => Some("not_found"),
        Some(memory) if memory.project != project => Some("not_owned"),
        Some(_) if !module_owns_memory(conn, project)? => Some("authority_elsewhere"),
        Some(memory)
            if memory.hash != row.content_hash_at_prompt
                || memory.revision != row.expected_revision
                || memory.status == "archived"
                || memory.successor.is_some() =>
        {
            Some("stale_revision")
        }
        _ => None,
    };
    let files = normalized_files(&row.files).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
    })?;
    let source_matches = row.source_commit_matches && row.checked_commit.as_deref() == head;
    let mut semantic_refusal = row.refusal_reason.clone();
    if refusal.is_none() && source_matches && semantic_refusal.is_none() {
        let mutation = match row.verification_status.as_str() {
            "update" => {
                let content = row.updated_content.as_deref().unwrap_or("").trim();
                if content.is_empty() || content.encode_utf16().count() > 20_000 {
                    semantic_refusal = Some("invalid_content".into());
                    None
                } else {
                    applier
                        .check_memory_revisions(&[(row.memory_id, row.expected_revision)])
                        .map_err(sql_failure)?;
                    Some(
                        applier
                            .update_memory_content(project, row.memory_id, content, None, now)
                            .map(|_| ()),
                    )
                }
            }
            "archive" => {
                applier
                    .check_memory_revisions(&[(row.memory_id, row.expected_revision)])
                    .map_err(sql_failure)?;
                Some(
                    applier
                        .archive_memories(
                            project,
                            &[row.memory_id],
                            row.archive_reason.as_deref(),
                            now,
                        )
                        .map(|_| ()),
                )
            }
            _ => None,
        };
        if let Some(Err(error)) = mutation {
            match error {
                mc_store::FacadeMemoryMutationError::DuplicateContent { id } => {
                    semantic_refusal = Some(format!("duplicate_of:{id}"))
                }
                error => return Err(sql_failure(error.to_string())),
            }
        }
    }
    let result = if refusal.is_some() {
        "stale"
    } else if !source_matches {
        "failed"
    } else if semantic_refusal.is_some() {
        "refused"
    } else if row.verification_status == "update" {
        if files.is_empty() {
            "unmapped"
        } else {
            "updated"
        }
    } else if row.verification_status == "archive" {
        "archived"
    } else if row.verification_status == "verified" {
        if files.is_empty() {
            "unmapped"
        } else {
            "confirmed"
        }
    } else {
        row.verification_status.as_str()
    };
    let reason = refusal
        .or(semantic_refusal.as_deref())
        .unwrap_or(if !source_matches {
            "source_commit_changed"
        } else {
            result
        });
    let state = if refusal.is_some() || semantic_refusal.is_some() {
        "decided_pending"
    } else {
        "applied"
    };
    let receipt = json!({"state": state, "reason": reason, "memoryId": row.memory_id, "adoptionClass": "deferred", "verificationResult": result});
    let key = format!("{batch_key}:{}", row.memory_id);
    if refusal.is_none() {
        if row.verification_status == "update" && matches!(result, "updated" | "unmapped") {
            conn.execute(
                "UPDATE memories SET verification_status='unverified',verified_at=NULL WHERE id=?1",
                [row.memory_id],
            )?;
            conn.execute(
                "DELETE FROM memory_verifications WHERE memory_id=?1",
                [row.memory_id],
            )?;
        }
        conn.execute("UPDATE memories SET verify_result=?1,verify_files_json=?2,verify_commit=?3 WHERE id=?4", params![result, json!(files).to_string(), row.checked_commit, row.memory_id])?;
        if result == "confirmed" || result == "updated" {
            conn.execute(
                "DELETE FROM memory_verifications WHERE memory_id=?1",
                [row.memory_id],
            )?;
            for file in &files {
                conn.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at) VALUES(?1,?2,?3,?3)", params![row.memory_id, file, now])?;
            }
            let mut metadata = memory
                .as_ref()
                .and_then(|memory| memory.metadata.as_deref())
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            metadata["dreamerVerifiedAt"] = json!(now);
            metadata["dreamerVerifiedCommit"] = json!(row.checked_commit);
            conn.execute("UPDATE memories SET verification_status='verified',verified_at=?1,metadata_json=?2 WHERE id=?3", params![now, metadata.to_string(), row.memory_id])?;
        }
    }
    conn.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,?2,?3,?4)", params![key, project, receipt.to_string(), now])?;
    if state == "applied" {
        conn.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,after_json,applied_at) VALUES(?1,?2,'verification',?3,?4,?5)", params![project, key, receipt.to_string(), json!({"files": files, "checkedCommit": row.checked_commit, "revision": row.expected_revision}).to_string(), now])?;
    }
    Ok(
        json!({"memory_id": row.memory_id, "result": result, "reason": reason, "state": state, "revision": row.expected_revision, "files": files, "checked_commit": row.checked_commit, "receipt": receipt}),
    )
}

fn sql_failure(error: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
}
