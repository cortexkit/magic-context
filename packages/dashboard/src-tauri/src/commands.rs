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
pub fn list_sessions(filter: Option<db::SessionFilter>) -> Vec<db::SessionRow> {
    db::list_all_sessions(filter.unwrap_or_default())
}

#[tauri::command]
pub fn list_sessions_paged(filter: Option<db::SessionFilter>) -> db::PagedSessions {
    db::list_sessions_paged(filter.unwrap_or_default())
}

#[tauri::command]
pub fn get_session_detail(
    state: State<'_, AppState>,
    harness: String,
    session_id: String,
) -> Result<db::SessionDetail, String> {
    let harness = harness.parse::<db::Harness>()?;
    let conn = state
        .get_db_path()
        .ok()
        .and_then(|path| db::open_readonly(&path).ok());
    db::get_session_detail(conn.as_ref(), harness, &session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("session not found: {session_id}"))
}

#[tauri::command]
pub fn get_session_cache_events(
    harness: String,
    session_id: String,
    limit: Option<usize>,
) -> Vec<db::DbCacheEvent> {
    match harness.parse::<db::Harness>() {
        Ok(harness) => db::get_session_cache_events(harness, &session_id, limit),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub fn get_session_cache_events_by_turns(
    harness: String,
    session_id: String,
    target_turns: usize,
) -> Vec<db::DbCacheEvent> {
    match harness.parse::<db::Harness>() {
        Ok(harness) => {
            db::get_session_cache_events_by_turn_count(harness, &session_id, target_turns)
        }
        Err(_) => Vec::new(),
    }
}

/// Lazy fetch for the Messages tab; see `db::get_session_messages` for why
/// this is split from `get_session_detail`.
#[tauri::command]
pub fn get_session_messages(
    harness: String,
    session_id: String,
) -> Result<Vec<db::SessionMessageRow>, String> {
    let harness = harness.parse::<db::Harness>()?;
    db::get_session_messages(harness, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project_key_files(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<db::KeyFileRow>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_project_key_files(&conn, &project_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn enumerate_projects() -> Vec<db::ProjectRow> {
    db::enumerate_projects()
}

#[tauri::command]
pub fn enumerate_memory_projects(
    state: State<'_, AppState>,
) -> Result<Vec<db::ProjectRow>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::enumerate_memory_projects(&conn).map_err(|e| e.to_string())
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
pub fn delete_session_fact(state: State<'_, AppState>, fact_id: i64) -> Result<(), String> {
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
pub fn delete_note(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_note(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn dismiss_note(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
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
    // GUI apps on macOS don't inherit shell PATH; try common locations.
    //
    // The first candidate must be `~/.opencode/bin/opencode` because that's
    // the path the official OpenCode installer (`curl -fsSL ... | bash`)
    // writes to and it's NOT on the GUI launcher's $PATH on macOS. Without
    // this candidate, every dashboard model dropdown silently returned
    // empty for users with a stock OpenCode install — the historian /
    // dreamer / sidekick fallback "Add fallback model" dropdown would show
    // "No models found" because `props.models = []`, so `grouped()`
    // returned no groups and the `<For fallback>` rendered.
    //
    // Additional fallback paths cover pre-CI installs, custom installs,
    // Homebrew on Intel + ARM, and shell-PATH discovery for users who
    // launched OpenCode from a terminal.
    let candidates = if cfg!(target_os = "windows") {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        vec![
            format!("{}\\.opencode\\bin\\opencode.exe", home),
            "opencode".to_string(),
        ]
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![
            format!("{}/.opencode/bin/opencode", home),
            "opencode".to_string(),
            format!("{}/.local/bin/opencode", home),
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

/// Parse the tabular output of `pi --list-models` into `provider/model` strings.
///
/// Skips the header line, empty lines, and any row with fewer than 2 tokens.
/// Whitespace is normalized via `split_whitespace`.
pub fn parse_pi_models_output(text: &str) -> Vec<String> {
    text.lines()
        .skip(1) // skip header
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().take(2).collect();
            if tokens.len() >= 2 {
                Some(format!("{}/{}", tokens[0], tokens[1]))
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub async fn get_available_pi_models() -> Vec<String> {
    // GUI apps on macOS don't inherit shell PATH; try common locations.
    //
    // The first candidate is `~/.pi/bin/pi` because that's the path the
    // official pi-coding-agent installer writes to and it's NOT on the GUI
    // launcher's $PATH on macOS. Additional fallback paths cover pre-CI
    // installs, custom installs, Homebrew on Intel + ARM, and shell-PATH
    // discovery for users who launched from a terminal.
    let candidates = if cfg!(target_os = "windows") {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        vec![
            format!("{}\\.pi\\bin\\pi.exe", home),
            "pi.exe".to_string(),
        ]
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![
            format!("{}/.pi/bin/pi", home),
            "pi".to_string(),
            format!("{}/.local/bin/pi", home),
            "/usr/local/bin/pi".to_string(),
            "/opt/homebrew/bin/pi".to_string(),
        ]
    };

    for bin in &candidates {
        if let Ok(output) = tokio::process::Command::new(bin)
            .arg("--list-models")
            .output()
            .await
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                return parse_pi_models_output(&text);
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
pub fn dismiss_user_memory(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::dismiss_user_memory(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user_memory(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user_memory_candidate(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory_candidate(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn promote_user_memory_candidate(state: State<'_, AppState>, id: i64) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::parse_pi_models_output;

    #[test]
    fn test_parse_pi_models_output_normal() {
        let input = "provider        model                           context  max-out  thinking  images\nanthropic       claude-opus-4-5                 200K     64K      yes       yes   \ncerebras        gpt-oss-120b                    131.1K   32.8K    yes       no    \ngithub-copilot  claude-opus-4.7                 144K     64K      yes       yes   \n";
        let result = parse_pi_models_output(input);
        assert_eq!(
            result,
            vec![
                "anthropic/claude-opus-4-5",
                "cerebras/gpt-oss-120b",
                "github-copilot/claude-opus-4.7",
            ]
        );
    }

    #[test]
    fn test_parse_pi_models_output_empty() {
        assert!(parse_pi_models_output("").is_empty());
    }

    #[test]
    fn test_parse_pi_models_output_header_only() {
        assert!(parse_pi_models_output("provider        model").is_empty());
    }

    #[test]
    fn test_parse_pi_models_output_extra_whitespace() {
        let input = "provider   model\n  anthropic    claude-sonnet-4-5  \n\n  \n";
        let result = parse_pi_models_output(input);
        assert_eq!(result, vec!["anthropic/claude-sonnet-4-5"]);
    }

    #[test]
    fn test_parse_pi_models_output_single_token_skipped() {
        let input = "provider   model\nanthropic\n  \ncerebras  gpt-oss\n";
        let result = parse_pi_models_output(input);
        assert_eq!(result, vec!["cerebras/gpt-oss"]);
    }
}
