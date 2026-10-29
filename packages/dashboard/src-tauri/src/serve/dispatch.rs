use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::{commands, config, db, embedding_probe, log_parser, workspaces, AppState};

#[derive(Debug)]
pub enum DispatchError {
    UnknownCommand,
    BadArgs(String),
    Command(String),
    Serialize(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetMemoriesArgs {
    project: Option<String>,
    workspace_id: Option<i64>,
    status: Option<String>,
    category: Option<String>,
    search: Option<String>,
    exclude_archived: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryStatsArgs {
    project: Option<String>,
    workspace_id: Option<i64>,
    status: Option<String>,
    search: Option<String>,
    include_archived: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectArgs {
    project: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NameArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceIdArgs {
    workspace_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameWorkspaceArgs {
    workspace_id: i64,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyWorkspaceChangesArgs {
    workspace_id: i64,
    rename: Option<String>,
    add_members: Vec<workspaces::WorkspaceMemberChange>,
    remove_members: Vec<String>,
    set_display_names: Vec<workspaces::WorkspaceDisplayNameChange>,
    share_categories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryStatusArgs {
    memory_id: i64,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryContentArgs {
    memory_id: i64,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryCategoryArgs {
    memory_id: i64,
    category: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryIdArgs {
    memory_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BulkMemoryStatusArgs {
    memory_ids: Vec<i64>,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BulkMemoryIdsArgs {
    memory_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListSessionsArgs {
    filter: Option<db::SessionFilter>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionArgs {
    harness: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCacheEventsArgs {
    harness: String,
    session_id: String,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCacheEventsByTurnsArgs {
    harness: String,
    session_id: String,
    target_turns: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIdArgs {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectPathArgs {
    project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FactContentArgs {
    fact_id: i64,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FactIdArgs {
    fact_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteContentArgs {
    note_id: i64,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteIdArgs {
    note_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DreamRunsArgs {
    project_path: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunIdArgs {
    run_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaxLinesArgs {
    max_lines: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheStatsArgs {
    max_lines: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheEventsFromDbArgs {
    limit: Option<usize>,
    since_timestamp: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LimitArgs {
    limit: Option<usize>,
    show_unmanaged: Option<bool>,
    hide_subagents: Option<bool>,
    harness_filter: Option<db::Harness>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetConfigArgs {
    source: String,
    project_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveConfigArgs {
    source: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveProjectConfigArgs {
    project_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentArgs {
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestEmbeddingEndpointArgs {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    input_type: Option<String>,
    truncate: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserMemoryStatusArgs {
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdArgs {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdContentArgs {
    id: i64,
    content: String,
}

pub async fn dispatch(state: &AppState, cmd: &str, args: Value) -> Result<Value, DispatchError> {
    match cmd {
        "get_projects" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_projects(&conn).map_err(to_command)?)
        }
        "get_memories" => {
            let a: GetMemoriesArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(
                db::get_memories_filtered(
                    &conn,
                    a.project.as_deref(),
                    a.workspace_id,
                    a.status.as_deref(),
                    a.category.as_deref(),
                    a.search.as_deref(),
                    a.exclude_archived.unwrap_or(false),
                    a.limit.unwrap_or(100),
                    a.offset.unwrap_or(0),
                )
                .map_err(to_command)?,
            )
        }
        "get_memory_stats" => {
            let a: MemoryStatsArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(
                db::get_memory_stats_scoped(
                    &conn,
                    db::MemoryStatsScope {
                        project: a.project.as_deref(),
                        workspace_id: a.workspace_id,
                        status: a.status.as_deref().filter(|value| !value.is_empty()),
                        search: a.search.as_deref().filter(|value| !value.trim().is_empty()),
                        include_archived: a.include_archived.unwrap_or(false),
                    },
                )
                .map_err(to_command)?,
            )
        }
        "get_primers" => {
            let a: ProjectArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_primers(&conn, a.project.as_deref()).map_err(to_command)?)
        }
        "get_primer_candidates" => {
            let a: ProjectArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_primer_candidates(&conn, a.project.as_deref()).map_err(to_command)?)
        }
        "get_mural" => {
            let a: ProjectArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_mural(&conn, a.project.as_deref()).map_err(to_command)?)
        }
        "workspace_schema_ready" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(workspaces::workspace_schema_ready(&conn).map_err(to_command)?)
        }
        "list_workspaces" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(workspaces::list_workspaces(&conn).map_err(to_command)?)
        }
        "list_workspace_summaries" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(workspaces::list_workspace_summaries(&conn).map_err(to_command)?)
        }
        "create_workspace" => {
            let a: NameArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(workspaces::create_workspace(&mut conn, &a.name).map_err(to_command)?)
        }
        "rename_workspace" => {
            let a: RenameWorkspaceArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(
                workspaces::rename_workspace(&mut conn, a.workspace_id, &a.name)
                    .map_err(to_command)?,
            )
        }
        "delete_workspace" => {
            let a: WorkspaceIdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(workspaces::delete_workspace(&mut conn, a.workspace_id).map_err(to_command)?)
        }
        "apply_workspace_changes" => {
            let a: ApplyWorkspaceChangesArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(
                workspaces::apply_workspace_changes(
                    &mut conn,
                    a.workspace_id,
                    a.rename,
                    a.add_members,
                    a.remove_members,
                    a.set_display_names,
                    a.share_categories,
                )
                .map_err(to_command)?,
            )
        }
        "update_memory_status" => {
            let a: MemoryStatusArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::update_memory_status(&mut conn, a.memory_id, &a.status).map_err(to_command)?)
        }
        "update_memory_content" => {
            let a: MemoryContentArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(
                db::update_memory_content(&mut conn, a.memory_id, &a.content)
                    .map_err(to_command)?,
            )
        }
        "update_memory_category" => {
            let a: MemoryCategoryArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(
                db::update_memory_category(&mut conn, a.memory_id, &a.category)
                    .map_err(to_command)?,
            )
        }
        "delete_memory" => {
            let a: MemoryIdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::delete_memory(&mut conn, a.memory_id).map_err(to_command)?)
        }
        "bulk_update_memory_status" => {
            let a: BulkMemoryStatusArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(
                db::bulk_update_memory_status(&mut conn, &a.memory_ids, &a.status)
                    .map_err(to_command)?,
            )
        }
        "bulk_delete_memory" => {
            let a: BulkMemoryIdsArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::bulk_delete_memory(&mut conn, &a.memory_ids).map_err(to_command)?)
        }
        "get_sessions" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_sessions(&conn).map_err(to_command)?)
        }
        "list_sessions" => {
            let a: ListSessionsArgs = parse_args(args)?;
            json(db::list_all_sessions(a.filter.unwrap_or_default()))
        }
        "list_sessions_paged" => {
            let a: ListSessionsArgs = parse_args(args)?;
            json(db::list_sessions_paged(a.filter.unwrap_or_default()))
        }
        "get_session_detail" => {
            let a: SessionArgs = parse_args(args)?;
            let harness = parse_harness(&a.harness)?;
            let conn = state
                .get_db_path()
                .ok()
                .and_then(|path| db::open_readonly(&path).ok());
            let detail = db::get_session_detail(conn.as_ref(), harness, &a.session_id)
                .map_err(to_command)?
                .ok_or_else(|| {
                    DispatchError::Command(format!("session not found: {}", a.session_id))
                })?;
            json(detail)
        }
        "get_session_cache_events" => {
            let a: SessionCacheEventsArgs = parse_args(args)?;
            let events = match a.harness.parse::<db::Harness>() {
                Ok(harness) => {
                    db::get_session_cache_events(harness, &a.session_id, a.limit, a.since_timestamp)
                }
                Err(_) => Vec::new(),
            };
            json(events)
        }
        "get_session_cache_events_by_turns" => {
            let a: SessionCacheEventsByTurnsArgs = parse_args(args)?;
            let events = match a.harness.parse::<db::Harness>() {
                Ok(harness) => db::get_session_cache_events_by_turn_count(
                    harness,
                    &a.session_id,
                    a.target_turns,
                ),
                Err(_) => Vec::new(),
            };
            json(events)
        }
        "get_session_messages" => {
            let a: SessionArgs = parse_args(args)?;
            let harness = parse_harness(&a.harness)?;
            json(db::get_session_messages(harness, &a.session_id).map_err(to_command)?)
        }
        "get_subagent_invocations" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_subagent_invocations(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_subagent_totals_by_subagent" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_subagent_totals_by_subagent(&conn, &a.session_id).map_err(to_command)?)
        }
        "enumerate_projects" => {
            parse_args::<NoArgs>(args)?;
            json(db::enumerate_projects())
        }
        "enumerate_memory_projects" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::enumerate_memory_projects(&conn).map_err(to_command)?)
        }
        "get_project_cards" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_project_cards(&conn))
        }
        "get_compartments" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_compartments(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_session_facts" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_session_facts(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_session_notes" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_session_notes(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_smart_notes" => {
            let a: ProjectPathArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_smart_notes(&conn, &a.project_path).map_err(to_command)?)
        }
        "update_session_fact" => {
            let a: FactContentArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            db::update_session_fact(&mut conn, a.fact_id, &a.content).map_err(to_command)?;
            json(())
        }
        "delete_session_fact" => {
            let a: FactIdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            db::delete_session_fact(&mut conn, a.fact_id).map_err(to_command)?;
            json(())
        }
        "update_note" => {
            let a: NoteContentArgs = parse_args(args)?;
            let conn = open_readwrite(state)?;
            db::update_note(&conn, a.note_id, &a.content).map_err(to_command)?;
            json(())
        }
        "delete_note" => {
            let a: NoteIdArgs = parse_args(args)?;
            let conn = open_readwrite(state)?;
            db::delete_note(&conn, a.note_id).map_err(to_command)?;
            json(())
        }
        "dismiss_note" => {
            let a: NoteIdArgs = parse_args(args)?;
            let conn = open_readwrite(state)?;
            db::dismiss_note(&conn, a.note_id).map_err(to_command)?;
            json(())
        }
        "get_session_meta" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_session_meta(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_context_token_breakdown" => {
            let a: SessionIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_context_token_breakdown(&conn, &a.session_id).map_err(to_command)?)
        }
        "get_task_schedule_state" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_task_schedule_state(&conn).map_err(to_command)?)
        }
        "get_dream_state" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_dream_state(&conn).map_err(to_command)?)
        }
        "get_dreamer_projects" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_dreamer_projects(&conn).map_err(to_command)?)
        }
        "get_dream_runs" => {
            let a: DreamRunsArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(
                db::get_dream_runs(&conn, a.project_path.as_deref(), a.limit.unwrap_or(20))
                    .map_err(DispatchError::Command)?,
            )
        }
        "get_dream_run_memory_changes" => {
            let a: RunIdArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(
                db::get_dream_run_memory_changes(&conn, a.run_id)
                    .map_err(DispatchError::Command)?,
            )
        }
        "get_log_paths" => {
            parse_args::<NoArgs>(args)?;
            json(
                log_parser::resolve_log_paths()
                    .into_iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>(),
            )
        }
        "get_log_entries" => {
            let a: MaxLinesArgs = parse_args(args)?;
            let log_paths = log_parser::resolve_log_paths();
            json(log_parser::read_log_tails(
                &log_paths,
                a.max_lines.unwrap_or(500),
            ))
        }
        "get_cache_events" => {
            let a: MaxLinesArgs = parse_args(args)?;
            let log_paths = log_parser::resolve_log_paths();
            let entries = log_parser::read_log_tails(&log_paths, a.max_lines.unwrap_or(2000));
            json(log_parser::extract_cache_events(&entries))
        }
        "get_session_cache_stats" => {
            let a: CacheStatsArgs = parse_args(args)?;
            let log_paths = log_parser::resolve_log_paths();
            let entries = log_parser::read_log_tails(&log_paths, a.max_lines.unwrap_or(5000));
            let events = log_parser::extract_cache_events(&entries);
            json(log_parser::aggregate_session_cache_stats(
                &events,
                a.limit.unwrap_or(5),
            ))
        }
        "get_cache_events_from_db" => {
            let a: CacheEventsFromDbArgs = parse_args(args)?;
            json(db::get_cache_events_from_db(
                a.limit.unwrap_or(200),
                a.since_timestamp,
            ))
        }
        "get_session_cache_stats_from_db" => {
            let a: LimitArgs = parse_args(args)?;
            json(db::get_session_cache_stats_from_db(
                a.limit.unwrap_or(5),
                a.show_unmanaged.unwrap_or(false),
                a.hide_subagents.unwrap_or(false),
                a.harness_filter,
            ))
        }
        "get_config" => {
            let a: GetConfigArgs = parse_args(args)?;
            let config_file = match a.source.as_str() {
                "project" => {
                    let project = a.project_path.unwrap_or_else(|| ".".to_string());
                    let path = config::resolve_project_config_path(&project);
                    config::read_config(&path, "project")
                }
                _ => {
                    let path = config::resolve_user_config_path(&config::config_home());
                    config::read_config(&path, "user")
                }
            };
            json(config_file)
        }
        "save_config" => {
            let a: SaveConfigArgs = parse_args(args)?;
            let path = match a.source.as_str() {
                "user" => config::resolve_user_config_path(&config::config_home()),
                _ => {
                    return Err(DispatchError::Command(
                        "Only user config editing is supported in V1".to_string(),
                    ));
                }
            };
            json(config::write_config(&path, &a.content).map_err(DispatchError::Command)?)
        }
        "get_project_configs" => {
            parse_args::<NoArgs>(args)?;
            let db_path = state.get_db_path().ok();
            json(config::discover_project_configs_with_db(
                db_path.as_ref(),
                &crate::db::data_home(),
                &config::config_home(),
                &crate::db::opencode_overrides(),
            ))
        }
        "save_project_config" => {
            let a: SaveProjectConfigArgs = parse_args(args)?;
            json(
                config::write_project_config(&a.project_path, &a.content)
                    .map_err(DispatchError::Command)?,
            )
        }
        "read_pi_config" => {
            parse_args::<NoArgs>(args)?;
            let path = config::resolve_pi_config_path(&config::config_home());
            json(config::read_config(&path, "pi"))
        }
        "write_pi_config" => {
            let a: ContentArgs = parse_args(args)?;
            let path = config::resolve_pi_config_path(&config::config_home());
            json(config::write_config(&path, &a.content).map_err(DispatchError::Command)?)
        }
        "pi_config_path" => {
            parse_args::<NoArgs>(args)?;
            json(
                config::resolve_pi_config_path(&config::config_home())
                    .to_string_lossy()
                    .to_string(),
            )
        }
        "get_opencode_install_state" => {
            parse_args::<NoArgs>(args)?;
            json(commands::get_opencode_install_state().await)
        }
        "get_model_catalogs" => {
            parse_args::<NoArgs>(args)?;
            json(commands::get_model_catalogs().await)
        }
        "test_embedding_endpoint" => {
            let a: TestEmbeddingEndpointArgs = parse_args(args)?;
            let options = match commands::prepare_embedding_probe_options(
                a.endpoint,
                a.model,
                a.api_key,
                a.input_type,
                a.truncate,
                a.source,
            ) {
                Ok(options) => options,
                Err(outcome) => return json(outcome),
            };
            json(embedding_probe::probe_embedding_endpoint(options).await)
        }
        "get_user_memories" => {
            let a: UserMemoryStatusArgs = parse_args(args)?;
            let conn = open_readonly(state)?;
            json(db::get_user_memories(&conn, a.status.as_deref()).map_err(to_command)?)
        }
        "get_user_memory_candidates" => {
            parse_args::<NoArgs>(args)?;
            let conn = open_readonly(state)?;
            json(db::get_user_memory_candidates(&conn).map_err(to_command)?)
        }
        "dismiss_user_memory" => {
            let a: IdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::dismiss_user_memory(&mut conn, a.id).map_err(to_command)?)
        }
        "restore_user_memory" => {
            let a: IdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::restore_user_memory(&mut conn, a.id).map_err(to_command)?)
        }
        "delete_user_memory" => {
            let a: IdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::delete_user_memory(&mut conn, a.id).map_err(to_command)?)
        }
        "update_user_memory_content" => {
            let a: IdContentArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::update_user_memory_content(&mut conn, a.id, &a.content).map_err(to_command)?)
        }
        "delete_user_memory_candidate" => {
            let a: IdArgs = parse_args(args)?;
            let conn = open_readwrite(state)?;
            json(db::delete_user_memory_candidate(&conn, a.id).map_err(to_command)?)
        }
        "promote_user_memory_candidate" => {
            let a: IdArgs = parse_args(args)?;
            let mut conn = open_readwrite(state)?;
            json(db::promote_user_memory_candidate(&mut conn, a.id).map_err(to_command)?)
        }
        "get_db_health" => {
            parse_args::<NoArgs>(args)?;
            let health = match state.get_db_path() {
                Ok(path) => db::get_db_health(&path),
                Err(_) => db::DbHealth {
                    exists: false,
                    path: "Not found".to_string(),
                    size_bytes: 0,
                    wal_size_bytes: 0,
                    table_counts: Vec::new(),
                },
            };
            json(health)
        }
        _ => Err(DispatchError::UnknownCommand),
    }
}

pub fn uses_subprocess_or_network_probe(cmd: &str) -> bool {
    matches!(
        cmd,
        "get_opencode_install_state" | "get_model_catalogs" | "test_embedding_endpoint"
    )
}

fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, DispatchError> {
    serde_json::from_value(args).map_err(|err| DispatchError::BadArgs(err.to_string()))
}

fn json<T: serde::Serialize>(value: T) -> Result<Value, DispatchError> {
    serde_json::to_value(value).map_err(|err| DispatchError::Serialize(err.to_string()))
}

fn open_readonly(state: &AppState) -> Result<rusqlite::Connection, DispatchError> {
    let path = state.get_db_path().map_err(DispatchError::Command)?;
    db::open_readonly(&path).map_err(to_command)
}

fn open_readwrite(state: &AppState) -> Result<rusqlite::Connection, DispatchError> {
    let path = state.get_db_path().map_err(DispatchError::Command)?;
    db::open_readwrite(&path).map_err(to_command)
}

fn parse_harness(value: &str) -> Result<db::Harness, DispatchError> {
    value.parse::<db::Harness>().map_err(DispatchError::Command)
}

fn to_command<E: ToString>(err: E) -> DispatchError {
    DispatchError::Command(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn state_without_db() -> AppState {
        AppState::with_resolver(|| None)
    }

    #[tokio::test]
    async fn dispatch_read_command_round_trips_json() {
        let value = dispatch(&state_without_db(), "get_db_health", serde_json::json!({}))
            .await
            .expect("health response");
        assert_eq!(value["exists"], false);
        assert_eq!(value["path"], "Not found");
    }

    #[tokio::test]
    async fn dispatch_mutation_command_round_trips_json() {
        let dir = tempdir().expect("tempdir");
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).expect("project dir");
        let project = project.canonicalize().expect("canonical project");
        let value = dispatch(
            &state_without_db(),
            "save_project_config",
            serde_json::json!({
                "projectPath": project.to_string_lossy(),
                "content": "{\"enabled\":true}\n"
            }),
        )
        .await
        .expect("save response");
        assert!(value.is_null());
        let saved = std::fs::read_to_string(project.join(".cortexkit").join("magic-context.jsonc"))
            .expect("saved config");
        assert!(saved.contains("enabled"));
    }

    #[tokio::test]
    async fn dispatch_unknown_command_is_not_found() {
        let err = dispatch(
            &state_without_db(),
            "missing_command",
            serde_json::json!({}),
        )
        .await
        .expect_err("unknown command");
        assert!(matches!(err, DispatchError::UnknownCommand));
    }

    #[tokio::test]
    async fn dispatch_rejects_extra_args_for_model_commands() {
        let err = dispatch(
            &state_without_db(),
            "get_model_catalogs",
            serde_json::json!({ "program": "sh" }),
        )
        .await
        .expect_err("extra args rejected");
        assert!(matches!(err, DispatchError::BadArgs(_)));
    }
}
