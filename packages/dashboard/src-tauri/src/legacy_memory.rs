//! Schema-95 edits keep the pre-history dashboard's mutation and epoch signals.
use crate::memory_history::EditRequest;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn edit(conn: &mut Connection, request: &Value, now: i64) -> Result<Value, String> {
    let caps = crate::db_capabilities::get(conn).map_err(|error| error.to_string())?;
    if !caps.legacy_memory_edits {
        return Err("incomplete_memory_schema".into());
    }
    crate::memory_history::validate_write_request("memory.edit", request)?;
    let request: EditRequest =
        serde_json::from_value(request.clone()).map_err(|_| "invalid_request")?;
    let mut apply = || -> rusqlite::Result<Value> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut epochs = HashSet::new();
        for change in &request.changes {
            let (project, category, status, stored_hash): (String, String, String, String) = tx
                .query_row(
                    "SELECT project_path,category,status,normalized_hash FROM memories WHERE id=?1",
                    [change.memory_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            if project != request.project_path {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let identity = crate::project_identity::normalize_stored_project_path(&project);
            if let Some(new_category) = &change.category {
                if ![
                    "PROJECT_RULES",
                    "ARCHITECTURE",
                    "CONSTRAINTS",
                    "CONFIG_VALUES",
                    "NAMING",
                ]
                .contains(&new_category.as_str())
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                if new_category != &category {
                    collision(&tx, &project, new_category, &stored_hash, change.memory_id)?;
                    tx.execute(
                        "UPDATE memories SET category=?1,updated_at=?2 WHERE id=?3",
                        params![new_category, now, change.memory_id],
                    )?;
                    epochs.extend(crate::workspaces::workspace_member_identities_for_project(
                        &tx, &identity,
                    )?);
                }
            }
            if let Some(new_content) = &change.content {
                let hash = crate::memory_history::normalized_hash(new_content);
                collision(
                    &tx,
                    &project,
                    change.category.as_deref().unwrap_or(&category),
                    &hash,
                    change.memory_id,
                )?;
                tx.execute("UPDATE memories SET content=?1,normalized_hash=?2,updated_at=?3,shareable=0 WHERE id=?4", params![new_content,hash,now,change.memory_id])?;
                tx.execute(
                    "DELETE FROM memory_embeddings WHERE memory_id=?1",
                    [change.memory_id],
                )?;
                queue(
                    &tx,
                    &identity,
                    "update",
                    change.memory_id,
                    &category,
                    Some(new_content),
                    now,
                )?;
            }
            if let Some(new_status) = &change.status {
                if !["active", "permanent", "archived"].contains(&new_status.as_str()) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                tx.execute(
                    "UPDATE memories SET status=?1,updated_at=?2 WHERE id=?3",
                    params![new_status, now, change.memory_id],
                )?;
                if new_status != &status {
                    if new_status == "archived" {
                        queue(
                            &tx,
                            &identity,
                            "archive",
                            change.memory_id,
                            &category,
                            None,
                            now,
                        )?;
                    } else {
                        epochs.extend(crate::workspaces::workspace_member_identities_for_project(
                            &tx, &identity,
                        )?);
                    }
                }
            }
        }
        crate::workspaces::bump_epochs_for_identities(&tx, &epochs)?;
        tx.commit()?;
        // Legacy stores have neither a revision nor a durable retry/history receipt.
        Ok(
            json!({"version":1,"state":"applied","projectPath":request.project_path,"operationId":request.operation_id,"decisionKey":null,"revisions":[],"conflicts":[]}),
        )
    };
    apply().map_err(|error| error.to_string())
}

fn collision(
    conn: &Connection,
    project: &str,
    category: &str,
    hash: &str,
    id: i64,
) -> rusqlite::Result<()> {
    let duplicate: Option<i64> = conn.query_row("SELECT id FROM memories WHERE project_path=?1 AND category=?2 AND normalized_hash=?3 AND id!=?4 LIMIT 1", params![project,category,hash,id], |row| row.get(0)).optional()?;
    if let Some(duplicate) = duplicate {
        return Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT), Some(format!("Memory content already exists as ID {duplicate} in this category; merge or archive the duplicate first."))));
    }
    Ok(())
}

fn queue(
    conn: &Connection,
    project: &str,
    kind: &str,
    id: i64,
    category: &str,
    content: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO memory_mutation_log(project_path,mutation_type,target_memory_id,superseded_by_id,category,new_content,queued_at) VALUES (?1,?2,?3,NULL,?4,?5,?6)", params![project,kind,id,category,content,now])?;
    Ok(())
}
