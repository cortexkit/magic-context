use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

/// Route exactly once. A rejected module response is never an invitation to local SQL.
pub async fn request(path: &Path, method: &str, params: Value) -> Result<Value, String> {
    if matches!(method, "memory.edit" | "memory.restore") {
        crate::memory_history::validate_write_request(method, &params)?;
    }
    let project = params["projectPath"].as_str().ok_or("invalid_request")?;
    pub fn readonly_memory_host_refusal(params: &Value, method: &str) -> Value {
        let mut value = json!({ "version":1, "state":"refused", "projectPath":params["projectPath"], "operationId":params["operationId"], "reason":"authority_unavailable", "detail":"module_host_not_running", "decisionKey":null, "revisions":[], "conflicts":[] });
        if method == "memory.restore" {
            value["decisionKey"] = params["decisionKey"].clone();
            value["restoredDecisionKey"] = Value::Null;
            value["adoption"] = json!("next_allowed_bust");
        }
        value
    }
    let mut conn =
        crate::db::open_readonly(&path.to_path_buf()).map_err(|error| error.to_string())?;
    let capabilities = crate::db_capabilities::get(&conn).map_err(|error| error.to_string())?;
    if method == "memory.edit" && capabilities.legacy_memory_edits {
        drop(conn);
        let mut conn =
            crate::db::open_readwrite(&path.to_path_buf()).map_err(|error| error.to_string())?;
        return local_request(&mut conn, method, &params);
    }
    crate::db_capabilities::require_history(&conn, method != "memory.history")?;
    if matches!(method, "memory.history" | "memory.restore.preview") {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as i64;
        return crate::memory_history::readonly_rpc(&mut conn, method, &params, now);
    }
    let local = crate::memory_history::local_owns(&conn, project)?;
    if local {
        drop(conn);
        let mut conn =
            crate::db::open_readwrite(&path.to_path_buf()).map_err(|error| error.to_string())?;
        return local_request(&mut conn, method, &params);
    }
    drop(conn);
    let root = path.parent().ok_or("authority_unavailable")?.join("rpc");
    let mut candidate: Option<Value> = None;
    let directories = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(readonly_memory_host_refusal(&params, method))
        }
        Err(_) => return Err("authority_unavailable".into()),
    };
    for directory in directories {
        let directory = directory.map_err(|error| error.to_string())?;
        if !directory
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        for file in std::fs::read_dir(directory.path()).map_err(|error| error.to_string())? {
            let file = file.map_err(|error| error.to_string())?;
            let Some(name) = file.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !name.starts_with("port-") || !name.ends_with(".json") {
                continue;
            }
            let Ok(raw) = std::fs::read(file.path()) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
                continue;
            };
            if value["projectPath"] == project
                && value["port"]
                    .as_u64()
                    .is_some_and(|port| port > 0 && port <= 65535)
                && value["token"].as_str().is_some()
                && candidate.as_ref().map_or(true, |old| {
                    value["started_at"].as_i64() > old["started_at"].as_i64()
                })
            {
                candidate = Some(value);
            }
        }
    }
    let Some(candidate) = candidate else {
        return Ok(readonly_memory_host_refusal(&params, method));
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/rpc/{method}",
            candidate["port"].as_u64().unwrap()
        ))
        .bearer_auth(candidate["token"].as_str().unwrap())
        .json(&params)
        .send()
        .await
        .map_err(|_| "authority_unavailable")?
        .error_for_status()
        .map_err(|_| "authority_unavailable")?;
    let value: Value = response
        .json()
        .await
        .map_err(|_| "invalid_module_receipt")?;
    if value["version"] != 1 {
        return Err("invalid_module_receipt".into());
    }
    if matches!(method, "memory.edit" | "memory.restore")
        && (value["projectPath"] != project
            || value["operationId"] != params["operationId"]
            || !["applied", "refused", "conflict"].contains(&value["state"].as_str().unwrap_or(""))
            || !value["revisions"].is_array()
            || !value["conflicts"].is_array())
    {
        return Err("invalid_module_receipt".into());
    }
    if matches!(method, "memory.edit" | "memory.restore")
        && !crate::memory_history::valid_receipt(method, &params, &value)
    {
        return Err("invalid_module_receipt".into());
    }
    Ok(value)
}
pub fn local_request(conn: &mut Connection, method: &str, params: &Value) -> Result<Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i64;
    if method == "memory.edit"
        && crate::db_capabilities::get(conn)
            .map_err(|error| error.to_string())?
            .legacy_memory_edits
    {
        return crate::legacy_memory::edit(conn, params, now);
    }
    crate::db_capabilities::require_history(conn, method != "memory.history")?;
    match method {
        "memory.edit" => {
            let parsed: crate::memory_history::EditRequest =
                serde_json::from_value(params.clone()).map_err(|_| "invalid_request")?;
            crate::memory_history::local_write(
                conn,
                &serde_json::to_value(parsed).map_err(|error| error.to_string())?,
                now,
            )
        }
        "memory.restore" => {
            let parsed: crate::memory_history::RestoreRequest =
                serde_json::from_value(params.clone()).map_err(|_| "invalid_request")?;
            crate::memory_history::local_write(
                conn,
                &serde_json::to_value(parsed).map_err(|error| error.to_string())?,
                now,
            )
        }
        "memory.history" => crate::memory_history::history(
            conn,
            &serde_json::from_value(params.clone()).map_err(|_| "invalid_request")?,
        ),
        "memory.restore.preview" => crate::memory_history::preview(
            conn,
            params["projectPath"].as_str().ok_or("invalid_request")?,
            params["decisionKey"].as_str().ok_or("invalid_request")?,
            now,
            crate::memory_history::MemoryWriter::Local,
        ),
        _ => Err("unknown_memory_method".into()),
    }
}
pub fn edit_request(
    project: &str,
    operation: &str,
    ids: &[i64],
    expectations: &[crate::memory_history::RevisionExpectation],
    field: &str,
    value: &str,
) -> Value {
    json!({ "projectPath": project, "operationId": operation, "expectedRevisions": expectations, "changes": ids.iter().map(|id| { let mut change = json!({ "memoryId": id }); change[field] = json!(value); change }).collect::<Vec<_>>() })
}
