use crate::embedding_probe::{
    probe_embedding_endpoint, substitute_value, EmbeddingProbeOptions, EmbeddingProbeOutcome,
};
use crate::{config, db, log_parser, AppState};
use tauri::State;

// ── Memory commands ─────────────────────────────────────────

#[tauri::command]
pub fn get_projects(state: State<'_, AppState>) -> Result<Vec<db::ProjectInfo>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_memories(
    state: State<'_, AppState>,
    project: Option<String>,
    status: Option<String>,
    category: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<db::Memory>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_memories(
        &conn,
        project.as_deref(),
        status.as_deref(),
        category.as_deref(),
        search.as_deref(),
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_memory_stats(
    state: State<'_, AppState>,
    project: Option<String>,
) -> Result<db::MemoryStats, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_memory_stats(&conn, project.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_memory_status(
    state: State<'_, AppState>,
    memory_id: i64,
    status: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_memory_status(&conn, memory_id, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_memory_content(
    state: State<'_, AppState>,
    memory_id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_memory_content(&conn, memory_id, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, memory_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_memory(&conn, memory_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bulk_update_memory_status(
    state: State<'_, AppState>,
    memory_ids: Vec<i64>,
    status: String,
) -> Result<usize, String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::bulk_update_memory_status(&mut conn, &memory_ids, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bulk_delete_memory(
    state: State<'_, AppState>,
    memory_ids: Vec<i64>,
) -> Result<usize, String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::bulk_delete_memory(&mut conn, &memory_ids).map_err(|e| e.to_string())
}

// ── Session commands ────────────────────────────────────────

#[tauri::command]
pub fn get_sessions(state: State<'_, AppState>) -> Result<Vec<db::SessionSummary>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_sessions(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_compartments(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::Compartment>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_compartments(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_facts(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::SessionFact>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_facts(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_notes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::Note>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_notes(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_smart_notes(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<db::Note>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_smart_notes(&conn, &project_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_fact(
    state: State<'_, AppState>,
    fact_id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_session_fact(&conn, fact_id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_session_fact(
    state: State<'_, AppState>,
    fact_id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_session_fact(&conn, fact_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_note(
    state: State<'_, AppState>,
    note_id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_note(&conn, note_id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_note(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_note(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn dismiss_note(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::dismiss_note(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_session_meta(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<db::SessionMetaRow>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_meta(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_context_token_breakdown(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<db::ContextTokenBreakdown>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_context_token_breakdown(&conn, &session_id).map_err(|e| e.to_string())
}

// ── Dreamer commands ────────────────────────────────────────

#[tauri::command]
pub fn get_dream_queue(state: State<'_, AppState>) -> Result<Vec<db::DreamQueueEntry>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_queue(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_dream_state(state: State<'_, AppState>) -> Result<Vec<db::DreamStateEntry>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_state(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_dream_runs(
    state: State<'_, AppState>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<db::DreamRun>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_runs(&conn, project_path.as_deref(), limit.unwrap_or(20))
}

#[tauri::command]
pub fn enqueue_dream(
    state: State<'_, AppState>,
    project_path: String,
    reason: String,
) -> Result<i64, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::enqueue_dream(&conn, &project_path, &reason).map_err(|e| e.to_string())
}

// ── Log commands ────────────────────────────────────────────

#[tauri::command]
pub fn get_log_entries(max_lines: Option<usize>) -> Vec<log_parser::LogEntry> {
    let log_path = log_parser::resolve_log_path();
    log_parser::read_log_tail(&log_path, max_lines.unwrap_or(500))
}

#[tauri::command]
pub fn get_cache_events(max_lines: Option<usize>) -> Vec<log_parser::CacheEvent> {
    let log_path = log_parser::resolve_log_path();
    let entries = log_parser::read_log_tail(&log_path, max_lines.unwrap_or(2000));
    log_parser::extract_cache_events(&entries)
}

#[tauri::command]
pub fn get_session_cache_stats(
    max_lines: Option<usize>,
    limit: Option<usize>,
) -> Vec<log_parser::SessionCacheStats> {
    let log_path = log_parser::resolve_log_path();
    let entries = log_parser::read_log_tail(&log_path, max_lines.unwrap_or(5000));
    let events = log_parser::extract_cache_events(&entries);
    log_parser::aggregate_session_cache_stats(&events, limit.unwrap_or(5))
}

#[tauri::command]
pub fn get_cache_events_from_db(
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<db::DbCacheEvent> {
    db::get_cache_events_from_db(limit.unwrap_or(200), since_timestamp)
}

#[tauri::command]
pub fn get_session_cache_stats_from_db(limit: Option<usize>) -> Vec<db::SessionCacheStats> {
    db::get_session_cache_stats_from_db(limit.unwrap_or(5))
}

// ── Config commands ─────────────────────────────────────────

#[tauri::command]
pub fn get_config(source: String, project_path: Option<String>) -> config::ConfigFile {
    match source.as_str() {
        "project" => {
            let proj = project_path.unwrap_or_else(|| ".".to_string());
            let path = config::resolve_project_config_path(&proj);
            config::read_config(&path, "project")
        }
        _ => {
            let path = config::resolve_user_config_path();
            config::read_config(&path, "user")
        }
    }
}

#[tauri::command]
pub fn save_config(source: String, content: String) -> Result<(), String> {
    let path = match source.as_str() {
        "user" => config::resolve_user_config_path(),
        _ => return Err("Only user config editing is supported in V1".to_string()),
    };
    config::write_config(&path, &content)
}

#[tauri::command]
pub fn get_project_configs() -> Vec<config::ProjectConfigEntry> {
    config::discover_project_configs()
}

#[tauri::command]
pub fn save_project_config(project_path: String, content: String) -> Result<(), String> {
    let path = config::resolve_project_config_path(&project_path);

    // Validate: path must be under the project directory (prevent path traversal)
    let canonical_project = std::path::Path::new(&project_path)
        .canonicalize()
        .map_err(|e| format!("Invalid project path: {}", e))?;
    let canonical_config = path
        .parent()
        .unwrap_or(&path)
        .canonicalize()
        .unwrap_or_else(|_| path.clone());
    if !canonical_config.starts_with(&canonical_project) {
        return Err("Config path is outside the project directory".to_string());
    }

    config::write_config(&path, &content)
}

// ── Model commands ──────────────────────────────────────────

#[tauri::command]
pub async fn get_available_models() -> Vec<String> {
    // GUI apps on macOS don't inherit shell PATH; try common locations
    let candidates = if cfg!(target_os = "windows") {
        vec!["opencode".to_string()]
    } else {
        vec![
            "opencode".to_string(),
            format!(
                "{}/.local/bin/opencode",
                std::env::var("HOME").unwrap_or_default()
            ),
            "/usr/local/bin/opencode".to_string(),
            "/opt/homebrew/bin/opencode".to_string(),
        ]
    };

    for bin in &candidates {
        if let Ok(output) = tokio::process::Command::new(bin)
            .arg("models")
            .output()
            .await
        {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
            }
        }
    }

    Vec::new()
}

// ── Embedding test ──────────────────────────────────────────

/// Probe an OpenAI-compatible embedding endpoint and classify the outcome.
///
/// This mirrors `doctor`'s behavior (see
/// packages/plugin/src/cli/doctor.ts > checkEmbeddingConfig). The frontend
/// uses the structured outcome kind to render provider-specific guidance
/// rather than a raw HTTP status. Key behaviors:
///
/// 1. `{env:VAR}` / `{file:path}` substitution runs on endpoint, model, and
///    api_key before the probe so users who stored their API key as
///    `{env:EMBED_KEY}` in `magic-context.jsonc` get the same result in the
///    dashboard as they do in doctor. If a token doesn't resolve (the env
///    var isn't set in the dashboard's process environment, which on macOS
///    often differs from the terminal environment), we return
///    `UnresolvedToken` with the failing token so the UI can point users to
///    launch OpenCode from the shell or run `doctor`.
///
/// 2. Body inspection on 2xx — `data[0].embedding` must be a non-empty float
///    array. OpenRouter and similar proxies return 200 for `/embeddings` but
///    with a chat-style body; we classify that as `EndpointUnsupported`
///    instead of falsely reporting success.
///
/// 3. 401/403 → `AuthFailed` (specific "credentials rejected" message).
///    404/405 → `EndpointUnsupported` (wrong URL / no embeddings API).
#[tauri::command]
pub async fn test_embedding_endpoint(
    endpoint: String,
    model: String,
    api_key: Option<String>,
) -> EmbeddingProbeOutcome {
    // Substitute each field. None of these values are emitted to logs, so
    // resolved values are safe to carry through the probe. We deliberately
    // pass `None` for config_dir because the dashboard renders parsed form
    // values that have already stripped JSONC context — relative file paths
    // therefore resolve against cwd, which is the best we can do without
    // knowing which config file the values came from.
    let (endpoint, endpoint_residual) = substitute_value(&endpoint, None);
    let (model, model_residual) = substitute_value(&model, None);
    let (api_key_val, api_key_residual) = match api_key.as_deref() {
        Some(s) => {
            let (v, r) = substitute_value(s, None);
            (Some(v), r)
        }
        None => (None, None),
    };

    // If any residual tokens survived substitution, surface the first one
    // so the user sees exactly which variable is missing. The dashboard may
    // be running from a GUI launcher (e.g., macOS Dock) whose environment
    // doesn't inherit shell rc files — users setting EMBED_API_KEY in
    // ~/.zshrc won't see it in the dashboard process unless they launch
    // OpenCode from the terminal.
    if let Some(token) = endpoint_residual {
        return EmbeddingProbeOutcome::UnresolvedToken {
            field: "endpoint".to_string(),
            token,
        };
    }
    if let Some(token) = model_residual {
        return EmbeddingProbeOutcome::UnresolvedToken {
            field: "model".to_string(),
            token,
        };
    }
    if let Some(token) = api_key_residual {
        return EmbeddingProbeOutcome::UnresolvedToken {
            field: "api_key".to_string(),
            token,
        };
    }

    probe_embedding_endpoint(EmbeddingProbeOptions {
        endpoint,
        model,
        api_key: api_key_val,
        timeout_ms: 10_000,
    })
    .await
}

// ── User Memory commands ────────────────────────────────────

#[tauri::command]
pub fn get_user_memories(
    state: State<'_, AppState>,
    status: Option<String>,
) -> Result<Vec<db::UserMemory>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_user_memories(&conn, status.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_user_memory_candidates(
    state: State<'_, AppState>,
) -> Result<Vec<db::UserMemoryCandidate>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_user_memory_candidates(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dismiss_user_memory(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::dismiss_user_memory(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user_memory(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user_memory_candidate(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory_candidate(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn promote_user_memory_candidate(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::promote_user_memory_candidate(&conn, id).map_err(|e| e.to_string())
}

// ── Health commands ─────────────────────────────────────────

#[tauri::command]
pub fn get_db_health(state: State<'_, AppState>) -> db::DbHealth {
    match state.get_db_path() {
        Ok(path) => db::get_db_health(&path),
        Err(_) => db::DbHealth {
            exists: false,
            path: "Not found".to_string(),
            size_bytes: 0,
            wal_size_bytes: 0,
            table_counts: Vec::new(),
        },
    }
}
