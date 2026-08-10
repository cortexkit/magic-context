use crate::embedding_probe::{
    expand_config_value, probe_embedding_endpoint, EmbeddingProbeOptions, EmbeddingProbeOutcome,
    TokenExpandError,
};
use crate::process_ext::NoWindowExtTokio;
use crate::{config, db, log_parser, AppState};
use std::path::{Path, PathBuf};
use tauri::State;

// ── Memory commands ─────────────────────────────────────────

// `(async)` runs this synchronous body on a worker thread instead of the
// webview main thread. get_projects is heavy (a GROUP BY over the full
// opencode.db plus a recursive Pi session-dir scan), so on the main thread it
// froze the UI for ~1-2s on every History re-entry. There are no await points,
// so the borrowed `State` lifetime is fine.
#[tauri::command(async)]
pub fn get_projects(state: State<'_, AppState>) -> Result<Vec<db::ProjectInfo>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn get_memories(
    state: State<'_, AppState>,
    project: Option<String>,
    workspace_id: Option<i64>,
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
        workspace_id,
        status.as_deref(),
        category.as_deref(),
        search.as_deref(),
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_memory_stats(
    state: State<'_, AppState>,
    project: Option<String>,
    workspace_id: Option<i64>,
) -> Result<db::MemoryStats, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_memory_stats(&conn, project.as_deref(), workspace_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_primers(
    state: State<'_, AppState>,
    project: Option<String>,
) -> Result<Vec<db::Primer>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_primers(&conn, project.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_primer_candidates(
    state: State<'_, AppState>,
    project: Option<String>,
) -> Result<Vec<db::PrimerCandidate>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_primer_candidates(&conn, project.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_mural(
    state: State<'_, AppState>,
    project: Option<String>,
) -> Result<Option<db::MuralManifest>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_mural(&conn, project.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn workspace_schema_ready(state: State<'_, AppState>) -> Result<bool, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    crate::workspaces::workspace_schema_ready(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<crate::workspaces::WorkspaceListItem>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    crate::workspaces::list_workspaces(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_workspace_summaries(
    state: State<'_, AppState>,
) -> Result<Vec<crate::workspaces::WorkspaceSummary>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    crate::workspaces::list_workspace_summaries(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_workspace(state: State<'_, AppState>, name: String) -> Result<i64, String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    crate::workspaces::create_workspace(&mut conn, &name).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn rename_workspace(
    state: State<'_, AppState>,
    workspace_id: i64,
    name: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    crate::workspaces::rename_workspace(&mut conn, workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_workspace(state: State<'_, AppState>, workspace_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    crate::workspaces::delete_workspace(&mut conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn apply_workspace_changes(
    state: State<'_, AppState>,
    workspace_id: i64,
    rename: Option<String>,
    add_members: Vec<crate::workspaces::WorkspaceMemberChange>,
    remove_members: Vec<String>,
    set_display_names: Vec<crate::workspaces::WorkspaceDisplayNameChange>,
    share_categories: Vec<String>,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    crate::workspaces::apply_workspace_changes(
        &mut conn,
        workspace_id,
        rename,
        add_members,
        remove_members,
        set_display_names,
        share_categories,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_memory_status(
    state: State<'_, AppState>,
    memory_id: i64,
    status: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_memory_status(&mut conn, memory_id, &status).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_memory_content(
    state: State<'_, AppState>,
    memory_id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_memory_content(&mut conn, memory_id, &content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_memory_category(
    state: State<'_, AppState>,
    memory_id: i64,
    category: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_memory_category(&mut conn, memory_id, &category).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_memory(state: State<'_, AppState>, memory_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_memory(&mut conn, memory_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn bulk_update_memory_status(
    state: State<'_, AppState>,
    memory_ids: Vec<i64>,
    status: String,
) -> Result<usize, String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::bulk_update_memory_status(&mut conn, &memory_ids, &status).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn bulk_delete_memory(
    state: State<'_, AppState>,
    memory_ids: Vec<i64>,
) -> Result<usize, String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::bulk_delete_memory(&mut conn, &memory_ids).map_err(|e| e.to_string())
}

// ── Session commands ────────────────────────────────────────

#[tauri::command(async)]
pub fn get_sessions(state: State<'_, AppState>) -> Result<Vec<db::SessionSummary>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_sessions(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_sessions(filter: Option<db::SessionFilter>) -> Vec<db::SessionRow> {
    db::list_all_sessions(filter.unwrap_or_default())
}

#[tauri::command(async)]
pub fn list_sessions_paged(filter: Option<db::SessionFilter>) -> db::PagedSessions {
    db::list_sessions_paged(filter.unwrap_or_default())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn get_session_cache_events(
    harness: String,
    session_id: String,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<db::DbCacheEvent> {
    match harness.parse::<db::Harness>() {
        Ok(harness) => db::get_session_cache_events(harness, &session_id, limit, since_timestamp),
        Err(_) => Vec::new(),
    }
}

#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn get_session_messages(
    harness: String,
    session_id: String,
) -> Result<Vec<db::SessionMessageRow>, String> {
    let harness = harness.parse::<db::Harness>()?;
    db::get_session_messages(harness, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_subagent_invocations(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::SubagentInvocation>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_subagent_invocations(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_subagent_totals_by_subagent(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::SubagentTotals>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_subagent_totals_by_subagent(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn enumerate_projects() -> Vec<db::ProjectRow> {
    db::enumerate_projects()
}

#[tauri::command(async)]
pub fn enumerate_memory_projects(
    state: State<'_, AppState>,
) -> Result<Vec<db::ProjectRow>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::enumerate_memory_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_project_cards(state: State<'_, AppState>) -> Result<Vec<db::ProjectCard>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    Ok(db::get_project_cards(&conn))
}

#[tauri::command(async)]
pub fn get_compartments(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::Compartment>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_compartments(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_session_facts(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::SessionFact>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_facts(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_session_notes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::Note>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_notes(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_smart_notes(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<db::Note>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_smart_notes(&conn, &project_path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_session_fact(
    state: State<'_, AppState>,
    fact_id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_session_fact(&mut conn, fact_id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_session_fact(state: State<'_, AppState>, fact_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_session_fact(&mut conn, fact_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn delete_note(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_note(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn dismiss_note(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::dismiss_note(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_session_meta(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<db::SessionMetaRow>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_session_meta(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_context_token_breakdown(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<db::ContextTokenBreakdown>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_context_token_breakdown(&conn, &session_id).map_err(|e| e.to_string())
}

// ── Dreamer commands ────────────────────────────────────────

#[tauri::command(async)]
pub fn get_task_schedule_state(
    state: State<'_, AppState>,
) -> Result<Vec<db::TaskScheduleEntry>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_task_schedule_state(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_dream_state(state: State<'_, AppState>) -> Result<Vec<db::DreamStateEntry>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_state(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_dreamer_projects(state: State<'_, AppState>) -> Result<Vec<db::DreamerProject>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dreamer_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_dream_runs(
    state: State<'_, AppState>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<db::DreamRun>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_runs(&conn, project_path.as_deref(), limit.unwrap_or(20))
}

#[tauri::command(async)]
pub fn get_dream_run_memory_changes(
    state: State<'_, AppState>,
    run_id: i64,
) -> Result<db::DreamRunMemoryDetail, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_dream_run_memory_changes(&conn, run_id)
}

// ── Log commands ────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_log_entries(max_lines: Option<usize>) -> Vec<log_parser::LogEntry> {
    let log_path = log_parser::resolve_log_path();
    log_parser::read_log_tail(&log_path, max_lines.unwrap_or(500))
}

#[tauri::command(async)]
pub fn get_cache_events(max_lines: Option<usize>) -> Vec<log_parser::CacheEvent> {
    let log_path = log_parser::resolve_log_path();
    let entries = log_parser::read_log_tail(&log_path, max_lines.unwrap_or(2000));
    log_parser::extract_cache_events(&entries)
}

#[tauri::command(async)]
pub fn get_session_cache_stats(
    max_lines: Option<usize>,
    limit: Option<usize>,
) -> Vec<log_parser::SessionCacheStats> {
    let log_path = log_parser::resolve_log_path();
    let entries = log_parser::read_log_tail(&log_path, max_lines.unwrap_or(5000));
    let events = log_parser::extract_cache_events(&entries);
    log_parser::aggregate_session_cache_stats(&events, limit.unwrap_or(5))
}

#[tauri::command(async)]
pub fn get_cache_events_from_db(
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<db::DbCacheEvent> {
    db::get_cache_events_from_db(limit.unwrap_or(200), since_timestamp)
}

#[tauri::command(async)]
pub fn get_session_cache_stats_from_db(
    limit: Option<usize>,
    show_unmanaged: Option<bool>,
    hide_subagents: Option<bool>,
    harness_filter: Option<db::Harness>,
) -> Vec<db::SessionCacheStats> {
    db::get_session_cache_stats_from_db(
        limit.unwrap_or(5),
        show_unmanaged.unwrap_or(false),
        hide_subagents.unwrap_or(false),
        harness_filter,
    )
}

// ── Config commands ─────────────────────────────────────────

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn save_config(source: String, content: String) -> Result<(), String> {
    let path = match source.as_str() {
        "user" => config::resolve_user_config_path(),
        _ => return Err("Only user config editing is supported in V1".to_string()),
    };
    config::write_config(&path, &content)
}

#[tauri::command(async)]
pub fn get_project_configs(state: State<'_, AppState>) -> Vec<config::ProjectConfigEntry> {
    let db_path = state.db_path.lock().ok().and_then(|guard| guard.clone());
    config::discover_project_configs_with_db(db_path.as_ref())
}

#[tauri::command(async)]
pub fn save_project_config(project_path: String, content: String) -> Result<(), String> {
    let path = config::resolve_project_config_path(&project_path);
    config::write_project_config(&project_path, &path, &content)
}

// ── Model commands ──────────────────────────────────────────

const OPENCODE_DESKTOP_APP_IDS: [&str; 3] = [
    "ai.opencode.desktop",
    "ai.opencode.desktop.beta",
    "ai.opencode.desktop.dev",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopPlatform {
    Macos,
    Windows,
    Linux,
}

#[derive(Clone, Debug)]
struct OpencodeDesktopEnv {
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    localappdata: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
    mac_system_applications: PathBuf,
}

impl OpencodeDesktopEnv {
    fn from_process() -> Self {
        let home = env_path("HOME")
            .or_else(|| env_path("USERPROFILE"))
            .or_else(dirs::home_dir);
        Self::resolve(
            home,
            env_path("APPDATA"),
            env_path("LOCALAPPDATA"),
            env_path("XDG_CONFIG_HOME"),
            env_path("XDG_DATA_HOME"),
        )
    }

    /// Derive the env from already-resolved roots. Falls back to home-derived
    /// Windows AppData roots when those env vars are unset, so a Desktop user is
    /// never misreported as having no OpenCode install just because %APPDATA% /
    /// %LOCALAPPDATA% are absent in this process environment. Kept in lockstep
    /// with the CLI's opencode-detect.ts fallbacks.
    fn resolve(
        home: Option<PathBuf>,
        appdata: Option<PathBuf>,
        localappdata: Option<PathBuf>,
        xdg_config_home: Option<PathBuf>,
        xdg_data_home: Option<PathBuf>,
    ) -> Self {
        let appdata = appdata.or_else(|| home.as_ref().map(|h| h.join("AppData").join("Roaming")));
        let localappdata =
            localappdata.or_else(|| home.as_ref().map(|h| h.join("AppData").join("Local")));
        Self {
            home,
            appdata,
            localappdata,
            xdg_config_home,
            xdg_data_home,
            mac_system_applications: PathBuf::from("/Applications"),
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    })
}

fn current_desktop_platform() -> DesktopPlatform {
    if cfg!(target_os = "macos") {
        DesktopPlatform::Macos
    } else if cfg!(target_os = "windows") {
        DesktopPlatform::Windows
    } else {
        DesktopPlatform::Linux
    }
}

fn opencode_cli_candidates() -> Vec<String> {
    // GUI apps do not inherit every shell PATH, so keep this list in one place
    // for model discovery and install-state detection.
    if cfg!(target_os = "windows") {
        windows_opencode_candidates(
            std::env::var("USERPROFILE").ok().as_deref(),
            std::env::var("APPDATA").ok().as_deref(),
            std::env::var("LOCALAPPDATA").ok().as_deref(),
        )
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![
            format!("{}/.opencode/bin/opencode", home),
            "opencode".to_string(),
            format!("{}/.local/bin/opencode", home),
            "/usr/local/bin/opencode".to_string(),
            "/opt/homebrew/bin/opencode".to_string(),
            format!("{}/.local/share/mise/shims/opencode", home),
            format!("{}/.asdf/shims/opencode", home),
            format!("{}/.volta/bin/opencode", home),
        ]
    }
}

/// Windows OpenCode CLI candidates, as absolute paths tried directly (so they
/// work even though a GUI launch does not inherit the user's shell PATH). Pure
/// over its env inputs so it can be unit-tested without touching process env.
///
/// pnpm is the key #149 addition: pnpm installs global bins under
/// `%LOCALAPPDATA%\pnpm\<name>.cmd` (its store) AND links them into
/// `%LOCALAPPDATA%\pnpm\bin\<name>.cmd` (the dir it puts on PATH). Neither is on
/// a GUI process's PATH, so `where.exe` misses them; listing the absolute paths
/// here finds them. A direct `.cmd` launch works on Windows (verified), so no
/// `cmd /C` wrapper is needed.
fn windows_opencode_candidates(
    userprofile: Option<&str>,
    appdata: Option<&str>,
    localappdata: Option<&str>,
) -> Vec<String> {
    let mut list = Vec::new();
    if let Some(p) = userprofile.filter(|s| !s.is_empty()) {
        list.push(format!("{p}\\.opencode\\bin\\opencode.exe"));
    }
    if let Some(p) = appdata.filter(|s| !s.is_empty()) {
        list.push(format!("{p}\\npm\\opencode.cmd"));
        list.push(format!("{p}\\npm\\opencode.exe"));
    }
    if let Some(p) = localappdata.filter(|s| !s.is_empty()) {
        // pnpm: both the bin-link dir (on PATH for shells) and the store root.
        list.push(format!("{p}\\pnpm\\bin\\opencode.cmd"));
        list.push(format!("{p}\\pnpm\\opencode.cmd"));
        list.push(format!("{p}\\Microsoft\\WinGet\\Links\\opencode.exe"));
    }
    if let Some(p) = userprofile.filter(|s| !s.is_empty()) {
        list.push(format!("{p}\\scoop\\shims\\opencode.exe"));
    }
    if let Some(p) = localappdata.filter(|s| !s.is_empty()) {
        list.push(format!("{p}\\opencode\\bin\\opencode.exe"));
    }
    list.push("opencode".to_string());
    list.push("opencode.exe".to_string());
    list
}

fn opencode_desktop_settings_paths(
    platform: DesktopPlatform,
    env: &OpencodeDesktopEnv,
) -> Vec<PathBuf> {
    let Some(user_data_dir) = (match platform {
        DesktopPlatform::Macos => env
            .home
            .as_ref()
            .map(|home| home.join("Library").join("Application Support")),
        DesktopPlatform::Windows => env.appdata.clone(),
        DesktopPlatform::Linux => env
            .xdg_config_home
            .clone()
            .or_else(|| env.home.as_ref().map(|home| home.join(".config"))),
    }) else {
        return Vec::new();
    };

    OPENCODE_DESKTOP_APP_IDS
        .iter()
        .map(|app_id| user_data_dir.join(app_id).join("opencode.settings"))
        .collect()
}

fn opencode_desktop_app_paths(platform: DesktopPlatform, env: &OpencodeDesktopEnv) -> Vec<PathBuf> {
    match platform {
        DesktopPlatform::Macos => {
            let mut paths = vec![env.mac_system_applications.join("OpenCode.app")];
            if let Some(home) = &env.home {
                paths.push(home.join("Applications").join("OpenCode.app"));
            }
            paths
        }
        DesktopPlatform::Windows => env
            .localappdata
            .as_ref()
            .map(|localappdata| {
                vec![localappdata
                    .join("Programs")
                    .join("OpenCode")
                    .join("OpenCode.exe")]
            })
            .unwrap_or_default(),
        DesktopPlatform::Linux => {
            let Some(data_dir) = env.xdg_data_home.clone().or_else(|| {
                env.home
                    .as_ref()
                    .map(|home| home.join(".local").join("share"))
            }) else {
                return Vec::new();
            };
            OPENCODE_DESKTOP_APP_IDS
                .iter()
                .map(|app_id| {
                    data_dir
                        .join("applications")
                        .join(format!("{app_id}.desktop"))
                })
                .collect()
        }
    }
}

fn opencode_desktop_detected_for_env(platform: DesktopPlatform, env: &OpencodeDesktopEnv) -> bool {
    // OpenCode Desktop runs its server as an Electron sidecar, so a Desktop-only
    // install has no CLI for model discovery. These canonical markers are shared
    // with packages/cli/src/lib/opencode-detect.ts and must stay in lockstep.
    opencode_desktop_settings_paths(platform, env)
        .iter()
        .any(|path| path.is_file())
        || opencode_desktop_app_paths(platform, env)
            .iter()
            .any(|path| path.exists())
}

fn opencode_desktop_detected() -> bool {
    opencode_desktop_detected_for_env(
        current_desktop_platform(),
        &OpencodeDesktopEnv::from_process(),
    )
}

/// Upper bound for model-discovery subprocesses so a hung CLI shim cannot block
/// the dashboard worker thread indefinitely.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run a binary with args, bounded by [`PROBE_TIMEOUT`]. `kill_on_drop` reaps
/// the child when the future is dropped on timeout so orphans do not accumulate.
async fn run_bounded_binary(program: &str, args: &[&str]) -> Option<String> {
    let fut = tokio::process::Command::new(program)
        .args(args)
        .no_window()
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(PROBE_TIMEOUT, fut).await {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        }
        _ => None,
    }
}

/// Run `command` through the user's login shell and return its stdout on
/// success. GUI apps don't inherit the shell PATH, and version managers
/// (mise/nvm/fnm/volta/asdf) install binaries under per-version directories
/// that cannot be hardcoded — but a login shell resolves them exactly as the
/// user's terminal does. Bounded by a timeout so a slow/misconfigured shell rc
/// can't hang the model dropdown. Unix-only: Windows version managers write to
/// known dirs already covered by the candidate paths, and `-l -c` is not a
/// portable Windows shell idiom.
///
/// Owned `String` arg (not `&str`): this lives in the commands module and an
/// async fn with a reference input would trip Tauri's command macro rules.
#[cfg(unix)]
async fn run_via_login_shell(command: String) -> Option<String> {
    // Only the user's real login shell carries their version-manager PATH; a
    // bare /bin/sh fallback wouldn't, so skip when SHELL is unset.
    let shell = std::env::var("SHELL").ok()?;
    let fut = tokio::process::Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg(&command)
        .no_window()
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(PROBE_TIMEOUT, fut).await {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        }
        _ => None,
    }
}

#[cfg(not(unix))]
async fn run_via_login_shell(_command: String) -> Option<String> {
    None
}

#[cfg(any(windows, test))]
fn pick_first_line(stdout: &str) -> Option<String> {
    let first_line = stdout.lines().next()?.trim().to_string();
    if !first_line.is_empty() {
        Some(first_line)
    } else {
        None
    }
}

#[cfg(windows)]
async fn resolve_via_where(tool: &str) -> Option<String> {
    let fut = tokio::process::Command::new("where.exe")
        .arg(tool)
        .no_window()
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(PROBE_TIMEOUT, fut).await {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            pick_first_line(&stdout)
        }
        _ => None,
    }
}

#[cfg(not(windows))]
async fn resolve_via_where(_tool: &str) -> Option<String> {
    None
}

async fn opencode_cli_available() -> bool {
    for bin in opencode_cli_candidates() {
        if run_bounded_binary(&bin, &["--version"]).await.is_some() {
            return true;
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(bin) = resolve_via_where("opencode").await {
            if run_bounded_binary(&bin, &["--version"]).await.is_some() {
                return true;
            }
        }
    }

    run_via_login_shell("opencode --version".to_string())
        .await
        .is_some()
}

#[tauri::command]
pub async fn get_opencode_install_state() -> String {
    if opencode_cli_available().await {
        "cli".to_string()
    } else if opencode_desktop_detected() {
        "desktop".to_string()
    } else {
        "none".to_string()
    }
}

#[tauri::command]
pub async fn get_available_models() -> Vec<String> {
    let candidates = opencode_cli_candidates();

    let parse = |text: &str| -> Vec<String> {
        text.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };

    // Use the plain `opencode models` command, NOT `--pure`. `--pure` skips all
    // external plugins, including the auth/provider plugins that register the
    // user's configured providers (e.g. anthropic, google), so under `--pure`
    // the dropdowns silently omit exactly the models the user set up. The plain
    // command lists every provider. It does not run any tool, so plugins that
    // start background work only on a tool call (rather than at plugin load) are
    // not triggered by a model listing.
    for bin in &candidates {
        if let Some(text) = run_bounded_binary(bin, &["models"]).await {
            let models = parse(&text);
            if !models.is_empty() {
                return models;
            }
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(bin) = resolve_via_where("opencode").await {
            if let Some(text) = run_bounded_binary(&bin, &["models"]).await {
                let models = parse(&text);
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }

    // Login-shell fallback for version-manager (mise/nvm/fnm) installs the
    // hardcoded candidates can't enumerate — see run_via_login_shell.
    if let Some(text) = run_via_login_shell("opencode models".to_string()).await {
        return parse(&text);
    }

    Vec::new()
}

fn strip_ansi_pi_output(text: &str) -> String {
    let re = regex::Regex::new(r"\x1b\[[0-9;]*m").expect("ansi strip regex");
    re.replace_all(text, "").into_owned()
}

fn pi_provider_token_ok(s: &str) -> bool {
    let s = s.trim_matches(',');
    if s.is_empty() || !s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn pi_model_token_ok(s: &str) -> bool {
    let s = s.trim_matches(',');
    if s.is_empty() || !s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// Parse `pi --list-models` output into `provider/model` ids.
///
/// Mirrors `packages/cli/src/lib/pi-helpers.ts` `parseModelListOutput`: skip
/// `Usage:`/help lines, detect the header by column content (not blind skip(1)),
/// validate provider/model token shapes, strip ANSI, and accept slash-joined ids.
pub fn parse_pi_models_output(text: &str) -> Vec<String> {
    let mut models = std::collections::BTreeSet::new();
    for raw_line in strip_ansi_pi_output(text).lines() {
        let mut line = raw_line.trim().to_string();
        if line.starts_with('•') || line.starts_with('*') || line.starts_with('-') {
            line = line
                .trim_start_matches(['•', '*', '-'])
                .trim_start()
                .to_string();
        }
        if line.is_empty() || line.to_ascii_lowercase().contains("usage:") {
            continue;
        }

        let cols: Vec<&str> = line.split_whitespace().collect();
        let first = cols.first().copied().unwrap_or("").trim_end_matches(',');

        if first.contains('/') && !first.starts_with("http://") && !first.starts_with("https://") {
            models.insert(first.to_string());
            continue;
        }

        let provider = first;
        let model = cols.get(1).copied().unwrap_or("").trim_end_matches(',');
        if provider.eq_ignore_ascii_case("provider") && model.eq_ignore_ascii_case("model") {
            continue;
        }
        if pi_provider_token_ok(provider) && pi_model_token_ok(model) {
            models.insert(format!("{provider}/{model}"));
        }
    }
    models.into_iter().collect()
}

/// Parse `omp models --json`, preserving selectors with scoped or nested model IDs.
pub fn parse_omp_models_output(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(entries) = value.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };

    let mut models = std::collections::BTreeSet::new();
    for entry in entries {
        if let Some(selector) = entry.get("selector").and_then(serde_json::Value::as_str) {
            if !selector.is_empty() {
                models.insert(selector.to_string());
                continue;
            }
        }
        if let (Some(provider), Some(id)) = (
            entry.get("provider").and_then(serde_json::Value::as_str),
            entry.get("id").and_then(serde_json::Value::as_str),
        ) {
            if !provider.is_empty() && !id.is_empty() {
                models.insert(format!("{provider}/{id}"));
            }
        }
    }
    models.into_iter().collect()
}

async fn get_available_omp_models() -> Vec<String> {
    let candidates = if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
        let mut list = Vec::new();
        if !appdata.is_empty() {
            list.push(format!("{}\\npm\\omp.cmd", appdata));
            list.push(format!("{}\\npm\\omp.exe", appdata));
        }
        if !userprofile.is_empty() {
            list.push(format!("{}\\.bun\\bin\\omp.exe", userprofile));
            list.push(format!("{}\\.bun\\bin\\omp.cmd", userprofile));
        }
        list.push("omp".to_string());
        list.push("omp.exe".to_string());
        list
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![
            format!("{}/.bun/bin/omp", home),
            "omp".to_string(),
            format!("{}/.local/bin/omp", home),
            "/usr/local/bin/omp".to_string(),
            "/opt/homebrew/bin/omp".to_string(),
            format!("{}/.local/share/mise/shims/omp", home),
            format!("{}/.asdf/shims/omp", home),
            format!("{}/.volta/bin/omp", home),
        ]
    };

    for bin in &candidates {
        if let Some(text) = run_bounded_binary(bin, &["models", "--json"]).await {
            let models = parse_omp_models_output(&text);
            if !models.is_empty() {
                return models;
            }
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(bin) = resolve_via_where("omp").await {
            if let Some(text) = run_bounded_binary(&bin, &["models", "--json"]).await {
                let models = parse_omp_models_output(&text);
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }

    if let Some(text) = run_via_login_shell("omp models --json".to_string()).await {
        return parse_omp_models_output(&text);
    }
    Vec::new()
}

fn merge_pi_and_omp_models(mut pi_models: Vec<String>, omp_models: Vec<String>) -> Vec<String> {
    pi_models.extend(omp_models);
    pi_models.sort();
    pi_models.dedup();
    pi_models
}

async fn include_omp_models(pi_models: Vec<String>) -> Vec<String> {
    merge_pi_and_omp_models(pi_models, get_available_omp_models().await)
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
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let mut list = Vec::new();
        if !userprofile.is_empty() {
            list.push(format!("{}\\.pi\\bin\\pi.exe", userprofile));
        }
        if !appdata.is_empty() {
            list.push(format!("{}\\npm\\pi.cmd", appdata));
            list.push(format!("{}\\npm\\pi.exe", appdata));
        }
        if !localappdata.is_empty() {
            list.push(format!(
                "{}\\Microsoft\\WinGet\\Links\\pi.exe",
                localappdata
            ));
        }
        if !userprofile.is_empty() {
            list.push(format!("{}\\scoop\\shims\\pi.exe", userprofile));
        }
        if !localappdata.is_empty() {
            list.push(format!("{}\\pi\\bin\\pi.exe", localappdata));
        }
        list.push("pi".to_string());
        list.push("pi.exe".to_string());
        list
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![
            format!("{}/.pi/bin/pi", home),
            "pi".to_string(),
            format!("{}/.local/bin/pi", home),
            "/usr/local/bin/pi".to_string(),
            "/opt/homebrew/bin/pi".to_string(),
            // Version-manager shim dirs (stable across the managed runtime's
            // version bumps, unlike the per-version install dir).
            format!("{}/.local/share/mise/shims/pi", home),
            format!("{}/.asdf/shims/pi", home),
            format!("{}/.volta/bin/pi", home),
        ]
    };

    for bin in &candidates {
        if let Some(text) = run_bounded_binary(bin, &["--list-models"]).await {
            let models = parse_pi_models_output(&text);
            if !models.is_empty() {
                return include_omp_models(models).await;
            }
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(bin) = resolve_via_where("pi").await {
            if let Some(text) = run_bounded_binary(&bin, &["--list-models"]).await {
                let models = parse_pi_models_output(&text);
                if !models.is_empty() {
                    return include_omp_models(models).await;
                }
            }
        }
    }

    // Resolve Pi through the user's login shell before falling back to OMP.
    // Otherwise an OMP install can mask a real Pi install managed by an
    // uncommon version manager whose shims are only present in login-shell PATH.
    if let Some(text) = run_via_login_shell("pi --list-models".to_string()).await {
        let models = parse_pi_models_output(&text);
        if !models.is_empty() {
            return include_omp_models(models).await;
        }
    }

    get_available_omp_models().await
}

// ── Embedding test ──────────────────────────────────────────

/// Probe an OpenAI-compatible embedding endpoint and classify the outcome.
///
/// The frontend uses the structured outcome kind to render provider-specific
/// guidance rather than a raw HTTP status. Key behaviors:
///
/// 1. `{env:VAR}` / `{file:path}` tokens are refused, not expanded. The probe
///    contacts a user-configured endpoint, so expanding a local file or env var
///    before the request would turn the “Test endpoint” button into a secret
///    exfiltration primitive.
///
/// 2. Body inspection on 2xx — `data[0].embedding` must be a non-empty float
///    array. OpenRouter and similar proxies return 200 for `/embeddings` but
///    with a chat-style body; we classify that as `EndpointUnsupported`
///    instead of falsely reporting success.
///
/// 3. 401/403 → `AuthFailed` (specific "credentials rejected" message).
///    404/405 → `EndpointUnsupported` (wrong URL / no embeddings API).
///
/// Expand an `{env:}`/`{file:}` token in one probe field, mapping a failure to
/// the matching probe outcome. The embedding fields come from the USER-level
/// config editor, so expanding the user's own tokens to test their endpoint is
/// exactly what the plugin does at runtime (see `expand_config_value`).
fn expand_probe_field(
    field: &str,
    value: &str,
    config_dir: &Path,
) -> Result<String, EmbeddingProbeOutcome> {
    expand_config_value(value, config_dir).map_err(|err| match err {
        TokenExpandError::Unresolved(token) => EmbeddingProbeOutcome::UnresolvedToken {
            field: field.to_string(),
            token,
        },
        TokenExpandError::SensitiveFile { token, reason } => {
            EmbeddingProbeOutcome::BlockedSensitiveFile {
                field: field.to_string(),
                token,
                reason,
            }
        }
    })
}

pub(crate) fn prepare_embedding_probe_options(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    input_type: Option<String>,
    truncate: Option<String>,
    source: Option<String>,
) -> Result<EmbeddingProbeOptions, EmbeddingProbeOutcome> {
    // TRUST BOUNDARY. Token expansion + contacting the endpoint is only safe for
    // USER-level config, whose values are the user's own. Project config is
    // untrusted repository input: a malicious repo could set
    // `api_key: "{env:GITHUB_TOKEN}"` + an attacker endpoint and exfiltrate the
    // secret on one "Test Connection" click. Default-deny: only an explicit
    // "user" source is allowed (frontend hides the button for projects anyway;
    // this is the enforced backend boundary). An absent source is treated as
    // user for backward-compat with the single existing (user-config) caller.
    match source.as_deref() {
        Some("user") | None => {}
        Some(other) => {
            return Err(EmbeddingProbeOutcome::ScopeNotAllowed {
                scope: other.to_string(),
            });
        }
    }

    // Relative `{file:}` references resolve against the user config file's dir,
    // matching the plugin's load-time resolution.
    let config_dir = config::resolve_user_config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let endpoint = expand_probe_field("endpoint", &endpoint, &config_dir)?;
    let model = expand_probe_field("model", &model, &config_dir)?;
    let api_key = match api_key {
        Some(key) => Some(expand_probe_field("api_key", &key, &config_dir)?),
        None => None,
    };

    let input_type = input_type
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let truncate = truncate
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(EmbeddingProbeOptions {
        endpoint,
        model,
        api_key,
        input_type,
        truncate,
        timeout_ms: 10_000,
    })
}

#[tauri::command]
pub async fn test_embedding_endpoint(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    input_type: Option<String>,
    truncate: Option<String>,
    // "user" (the only scope that expands tokens + probes) or "project"
    // (refused). Absent = user, for the existing user-config caller.
    source: Option<String>,
) -> EmbeddingProbeOutcome {
    let options = match prepare_embedding_probe_options(
        endpoint, model, api_key, input_type, truncate, source,
    ) {
        Ok(options) => options,
        Err(outcome) => return outcome,
    };
    probe_embedding_endpoint(options).await
}

// ── User Memory commands ────────────────────────────────────

#[tauri::command(async)]
pub fn get_user_memories(
    state: State<'_, AppState>,
    status: Option<String>,
) -> Result<Vec<db::UserMemory>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_user_memories(&conn, status.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_user_memory_candidates(
    state: State<'_, AppState>,
) -> Result<Vec<db::UserMemoryCandidate>, String> {
    let path = state.get_db_path()?;
    let conn = db::open_readonly(&path).map_err(|e| e.to_string())?;
    db::get_user_memory_candidates(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dismiss_user_memory(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::dismiss_user_memory(&mut conn, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_user_memory(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory(&mut conn, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_user_memory_content(
    state: State<'_, AppState>,
    id: i64,
    content: String,
) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::update_user_memory_content(&mut conn, id, &content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_user_memory_candidate(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::delete_user_memory_candidate(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn promote_user_memory_candidate(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = state.get_db_path()?;
    let mut conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::promote_user_memory_candidate(&mut conn, id).map_err(|e| e.to_string())
}

// ── Health commands ─────────────────────────────────────────

#[tauri::command(async)]
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
    use super::{
        merge_pi_and_omp_models, opencode_desktop_detected_for_env, parse_omp_models_output,
        parse_pi_models_output, pick_first_line, prepare_embedding_probe_options,
        run_bounded_binary, windows_opencode_candidates, DesktopPlatform, OpencodeDesktopEnv,
        OPENCODE_DESKTOP_APP_IDS,
    };
    use crate::embedding_probe::EmbeddingProbeOutcome;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    fn test_desktop_env(root: &Path) -> OpencodeDesktopEnv {
        OpencodeDesktopEnv {
            home: Some(root.join("home")),
            appdata: Some(root.join("appdata")),
            localappdata: Some(root.join("localappdata")),
            xdg_config_home: Some(root.join("xdg_config")),
            xdg_data_home: Some(root.join("xdg_data")),
            mac_system_applications: root.join("system_applications"),
        }
    }

    fn write_file(path: PathBuf) {
        let parent = path.parent().expect("test path has parent");
        std::fs::create_dir_all(parent).expect("create marker parent");
        std::fs::write(path, "{}").expect("write marker");
    }

    #[test]
    fn opencode_desktop_app_ids_match_canonical_markers() {
        assert_eq!(
            OPENCODE_DESKTOP_APP_IDS,
            [
                "ai.opencode.desktop",
                "ai.opencode.desktop.beta",
                "ai.opencode.desktop.dev",
            ]
        );
    }

    #[test]
    fn windows_desktop_marker_detected_when_appdata_env_unset() {
        // With %APPDATA% unset but home known, the Windows userData marker must
        // still resolve from the home-derived AppData/Roaming fallback.
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let env = OpencodeDesktopEnv::resolve(Some(home.clone()), None, None, None, None);
        write_file(
            home.join("AppData")
                .join("Roaming")
                .join(OPENCODE_DESKTOP_APP_IDS[0])
                .join("opencode.settings"),
        );
        assert!(opencode_desktop_detected_for_env(
            DesktopPlatform::Windows,
            &env
        ));
    }

    #[test]
    fn opencode_desktop_settings_marker_detects_each_channel() {
        for app_id in OPENCODE_DESKTOP_APP_IDS {
            let dir = tempfile::tempdir().expect("tempdir");
            let env = test_desktop_env(dir.path());
            write_file(
                env.xdg_config_home
                    .as_ref()
                    .expect("xdg config")
                    .join(app_id)
                    .join("opencode.settings"),
            );

            assert!(opencode_desktop_detected_for_env(
                DesktopPlatform::Linux,
                &env
            ));
        }
    }

    #[test]
    fn opencode_desktop_settings_marker_uses_home_and_appdata_roots() {
        let mac_dir = tempfile::tempdir().expect("mac tempdir");
        let mac_env = test_desktop_env(mac_dir.path());
        write_file(
            mac_env
                .home
                .as_ref()
                .expect("home")
                .join("Library")
                .join("Application Support")
                .join(OPENCODE_DESKTOP_APP_IDS[0])
                .join("opencode.settings"),
        );
        assert!(opencode_desktop_detected_for_env(
            DesktopPlatform::Macos,
            &mac_env
        ));

        let win_dir = tempfile::tempdir().expect("windows tempdir");
        let win_env = test_desktop_env(win_dir.path());
        write_file(
            win_env
                .appdata
                .as_ref()
                .expect("appdata")
                .join(OPENCODE_DESKTOP_APP_IDS[0])
                .join("opencode.settings"),
        );
        assert!(opencode_desktop_detected_for_env(
            DesktopPlatform::Windows,
            &win_env
        ));
    }

    #[test]
    fn opencode_core_config_dir_is_not_a_desktop_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".config").join("opencode"))
            .expect("create core config dir");
        let env = OpencodeDesktopEnv {
            home: Some(home),
            appdata: Some(dir.path().join("appdata")),
            localappdata: Some(dir.path().join("localappdata")),
            xdg_config_home: None,
            xdg_data_home: Some(dir.path().join("xdg_data")),
            mac_system_applications: dir.path().join("system_applications"),
        };

        assert!(!opencode_desktop_detected_for_env(
            DesktopPlatform::Linux,
            &env
        ));
    }

    #[tokio::test]
    async fn run_bounded_binary_times_out_on_sleep() {
        let start = Instant::now();
        let result = if cfg!(windows) {
            run_bounded_binary("cmd", &["/C", "timeout", "/t", "30", "/nobreak"]).await
        } else {
            run_bounded_binary("sleep", &["30"]).await
        };
        assert!(result.is_none());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(12),
            "probe should return within timeout, took {:?}",
            start.elapsed()
        );
    }

    // #149 regression: the discovery path must be able to LAUNCH a `.cmd` shim
    // (pnpm/npm install opencode as opencode.cmd). Verified on windows-latest
    // that Rust's Command runs a `.cmd` directly, so the fix is purely adding the
    // pnpm path to the candidate list (no `cmd /C` wrapper). This asserts that
    // run_bounded_binary actually executes a `.cmd`, so a future regression (or a
    // Rust/Windows behavior change) is caught. Windows-only.
    #[cfg(windows)]
    #[tokio::test]
    async fn win_run_bounded_binary_executes_cmd_shim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("opencode.cmd");
        std::fs::write(&shim, "@echo off\r\necho probe-opencode 9.9.9\r\n").expect("write shim");
        let out = run_bounded_binary(&shim.to_string_lossy(), &["--version"]).await;
        assert_eq!(
            out.as_deref().map(str::trim),
            Some("probe-opencode 9.9.9"),
            "run_bounded_binary must launch a .cmd shim directly (got {out:?})"
        );
    }

    #[test]
    fn windows_candidates_include_pnpm_global_bin() {
        // #149: pnpm installs global bins at %LOCALAPPDATA%\pnpm\bin\<name>.cmd
        // (and the store root). Both must be in the candidate list so discovery
        // finds a pnpm-installed opencode that is never on a GUI process's PATH.
        let list = windows_opencode_candidates(
            Some("C:\\Users\\me"),
            Some("C:\\Users\\me\\AppData\\Roaming"),
            Some("C:\\Users\\me\\AppData\\Local"),
        );
        assert!(
            list.iter()
                .any(|c| c == "C:\\Users\\me\\AppData\\Local\\pnpm\\bin\\opencode.cmd"),
            "missing pnpm bin-link candidate; got {list:?}"
        );
        assert!(
            list.iter()
                .any(|c| c == "C:\\Users\\me\\AppData\\Local\\pnpm\\opencode.cmd"),
            "missing pnpm store-root candidate; got {list:?}"
        );
        // Existing coverage stays: npm, winget, scoop, the stock installer, and
        // the bare-name PATH fallbacks.
        assert!(list
            .iter()
            .any(|c| c == "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd"));
        assert!(list.contains(&"opencode".to_string()));
    }

    #[test]
    fn windows_candidates_skip_empty_env_vars() {
        // Unset/empty env vars must not yield malformed leading-separator paths.
        let list = windows_opencode_candidates(None, Some(""), Some("C:\\L"));
        assert!(list.iter().all(|c| !c.starts_with('\\')), "got {list:?}");
        assert!(list.iter().any(|c| c == "C:\\L\\pnpm\\bin\\opencode.cmd"));
        // No APPDATA -> no npm candidates.
        assert!(list.iter().all(|c| !c.contains("\\npm\\")));
    }

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

    #[test]
    fn test_parse_pi_models_output_skips_usage_and_accepts_slash_ids() {
        let input = "Usage: pi --list-models\nanthropic/claude-opus-4-8  extra cols\n";
        let result = parse_pi_models_output(input);
        assert_eq!(result, vec!["anthropic/claude-opus-4-8"]);
    }

    #[test]
    fn test_parse_pi_models_output_strips_ansi() {
        let input = "\x1b[32manthropic\x1b[0m  claude-sonnet-4-5";
        let result = parse_pi_models_output(input);
        assert_eq!(result, vec!["anthropic/claude-sonnet-4-5"]);
    }

    #[test]
    fn test_parse_omp_models_output_preserves_selectors() {
        let input = r#"{"models":[{"provider":"anthropic","id":"claude-opus-4-5","selector":"anthropic/claude-opus-4-5"},{"provider":"modal","id":"@modal/qwen/model-v1","selector":"modal/@modal/qwen/model-v1"},{"provider":"openai","id":"fallback/model"}]}"#;
        assert_eq!(
            parse_omp_models_output(input),
            vec![
                "anthropic/claude-opus-4-5",
                "modal/@modal/qwen/model-v1",
                "openai/fallback/model",
            ]
        );
    }

    #[test]
    fn pi_and_omp_model_catalogs_are_merged_and_deduplicated() {
        assert_eq!(
            merge_pi_and_omp_models(
                vec!["anthropic/shared".into(), "pi/only".into()],
                vec!["omp/only".into(), "anthropic/shared".into()],
            ),
            vec!["anthropic/shared", "omp/only", "pi/only"]
        );
    }

    #[test]
    fn test_pick_first_line() {
        assert_eq!(pick_first_line(""), None);
        assert_eq!(pick_first_line("   \n"), None);
        assert_eq!(
            pick_first_line("C:\\bin\\opencode.exe\nC:\\other\\opencode.exe"),
            Some("C:\\bin\\opencode.exe".to_string())
        );
        assert_eq!(
            pick_first_line("  C:\\bin\\opencode.exe  \n"),
            Some("C:\\bin\\opencode.exe".to_string())
        );
    }

    #[test]
    fn embedding_probe_expands_file_api_key_for_the_test() {
        // The embedding fields come from the USER config editor, so a
        // {file:...} api_key is the user's own secret; expand it (as the
        // plugin does at runtime) instead of refusing.
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("embedding-secret.txt");
        std::fs::write(&secret_path, "  super-secret-token\n").expect("write secret");
        let token = format!("{{file:{}}}", secret_path.display());

        let options = prepare_embedding_probe_options(
            "https://example.com/v1".to_string(),
            "text-embedding-3-small".to_string(),
            Some(token),
            None,
            None,
            None,
        )
        .expect("resolvable file token should expand, not error");

        // file contents are trimmed by expand_config_value (the file had
        // leading/trailing whitespace).
        assert_eq!(options.api_key.as_deref(), Some("super-secret-token"));
    }

    #[test]
    fn embedding_probe_expands_env_model_token_for_the_test() {
        std::env::set_var("MC_DASHBOARD_TEST_MODEL", "resolved-model");
        let options = prepare_embedding_probe_options(
            "https://example.com/v1".to_string(),
            "{env:MC_DASHBOARD_TEST_MODEL}".to_string(),
            Some("literal-key".to_string()),
            None,
            None,
            None,
        )
        .expect("resolvable env token should expand, not error");
        std::env::remove_var("MC_DASHBOARD_TEST_MODEL");

        assert_eq!(options.model, "resolved-model");
    }

    #[test]
    fn embedding_probe_reports_unresolved_env_token() {
        std::env::remove_var("MC_DASHBOARD_UNSET_TEST_VAR");
        let outcome = prepare_embedding_probe_options(
            "https://example.com/v1".to_string(),
            "text-embedding-3-small".to_string(),
            Some("{env:MC_DASHBOARD_UNSET_TEST_VAR}".to_string()),
            None,
            None,
            None,
        )
        .expect_err("an unset env token must not reach the network");

        match outcome {
            EmbeddingProbeOutcome::UnresolvedToken { field, token } => {
                assert_eq!(field, "api_key");
                assert_eq!(token, "{env:MC_DASHBOARD_UNSET_TEST_VAR}");
            }
            other => panic!("expected unresolved token, got {other:?}"),
        }
    }

    #[test]
    fn embedding_probe_refuses_project_scope_without_expanding() {
        // Project config is untrusted. A project-scope probe must refuse BEFORE
        // expanding any {env:}/{file:} token, so a malicious repo can't
        // exfiltrate a secret to its endpoint via one Test Connection click.
        std::env::set_var("MC_DASHBOARD_PROJECT_SECRET", "should-not-leak");
        let outcome = prepare_embedding_probe_options(
            "https://attacker.example/v1".to_string(),
            "text-embedding-3-small".to_string(),
            Some("{env:MC_DASHBOARD_PROJECT_SECRET}".to_string()),
            None,
            None,
            Some("project".to_string()),
        )
        .expect_err("project scope must be refused");
        std::env::remove_var("MC_DASHBOARD_PROJECT_SECRET");

        match outcome {
            EmbeddingProbeOutcome::ScopeNotAllowed { scope } => assert_eq!(scope, "project"),
            other => panic!("expected scope refusal, got {other:?}"),
        }
    }

    #[test]
    fn embedding_probe_allows_explicit_user_scope() {
        std::env::set_var("MC_DASHBOARD_USER_SCOPE_MODEL", "ok-model");
        let options = prepare_embedding_probe_options(
            "https://example.com/v1".to_string(),
            "{env:MC_DASHBOARD_USER_SCOPE_MODEL}".to_string(),
            None,
            None,
            None,
            Some("user".to_string()),
        )
        .expect("explicit user scope should expand + probe");
        std::env::remove_var("MC_DASHBOARD_USER_SCOPE_MODEL");
        assert_eq!(options.model, "ok-model");
    }
}
