#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use magic_context_dashboard_lib::{commands, serve, AppState};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

const OPEN_DASHBOARD_MENU_ID: &str = "open_dashboard";
const CHECK_UPDATES_MENU_ID: &str = "check_updates";
const QUIT_MENU_ID: &str = "quit";

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match serve::parse_serve_args(&argv) {
        Ok(Some(opts)) => {
            serve::run(opts);
            return;
        }
        Ok(None) => {}
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(2);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Memory
            commands::get_projects,
            commands::get_memories,
            commands::get_memory_stats,
            commands::get_primers,
            commands::get_primer_candidates,
            commands::get_mural,
            commands::get_memory_history,
            commands::get_database_capabilities,
            commands::preview_memory_restore,
            commands::restore_memory_history,
            commands::update_memory_status,
            commands::update_memory_content,
            commands::update_memory_category,
            commands::delete_memory,
            commands::bulk_update_memory_status,
            commands::bulk_delete_memory,
            // Sessions
            commands::get_sessions,
            commands::list_sessions,
            commands::list_sessions_paged,
            commands::get_session_detail,
            commands::get_session_messages,
            commands::get_subagent_invocations,
            commands::get_subagent_totals_by_subagent,
            commands::get_session_cache_events,
            commands::get_session_cache_events_by_turns,
            commands::enumerate_projects,
            commands::enumerate_memory_projects,
            commands::get_project_cards,
            commands::refresh_project_names,
            commands::get_compartments,
            commands::get_session_facts,
            commands::get_session_notes,
            commands::get_smart_notes,
            commands::update_session_fact,
            commands::delete_session_fact,
            commands::update_note,
            commands::delete_note,
            commands::dismiss_note,
            commands::get_session_meta,
            commands::get_context_token_breakdown,
            // Dreamer
            commands::get_task_schedule_state,
            commands::get_dream_state,
            commands::get_dreamer_projects,
            commands::get_dream_runs,
            commands::get_dream_run_memory_changes,
            // Logs & Cache
            commands::get_log_paths,
            commands::get_log_entries,
            commands::get_cache_events,
            commands::get_session_cache_stats,
            commands::get_cache_events_from_db,
            commands::get_session_cache_stats_from_db,
            // Config
            commands::get_config,
            commands::save_config,
            commands::get_project_configs,
            commands::get_opencode_stores,
            commands::save_project_config,
            magic_context_dashboard_lib::config::read_pi_config,
            magic_context_dashboard_lib::config::write_pi_config,
            magic_context_dashboard_lib::config::pi_config_path,
            // Models
            commands::get_opencode_install_state,
            commands::get_model_catalogs,
            commands::test_embedding_endpoint,
            // User Memories
            commands::get_user_memories,
            commands::get_user_memory_candidates,
            commands::dismiss_user_memory,
            commands::restore_user_memory,
            commands::delete_user_memory,
            commands::update_user_memory_content,
            commands::delete_user_memory_candidate,
            commands::promote_user_memory_candidate,
            // Health
            commands::get_db_health,
            // Workspaces
            commands::workspace_schema_ready,
            commands::list_workspaces,
            commands::list_workspace_summaries,
            commands::create_workspace,
            commands::rename_workspace,
            commands::delete_workspace,
            commands::apply_workspace_changes,
        ])
        .setup(|app| {
            tauri::async_runtime::block_on(
                magic_context_dashboard_lib::project_names::cache()
                    .initialize(&magic_context_dashboard_lib::project_names::connection_file()),
            );
            // ── macOS app menu bar ──
            let app_handle_for_menu = app.app_handle().clone();
            let check_updates_item =
                MenuItemBuilder::with_id("app_check_updates", "Check for Updates...").build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "Magic Context")
                .about(None)
                .item(&check_updates_item)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let app_menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .build()?;
            app.set_menu(app_menu)?;
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "app_check_updates" {
                    let _ = app_handle_for_menu.emit("check-for-updates", ());
                }
            });

            // ── System tray ──
            let tray_app_handle = app.app_handle().clone();
            let tray_menu = MenuBuilder::new(app)
                .text(OPEN_DASHBOARD_MENU_ID, "Open Dashboard")
                .text(CHECK_UPDATES_MENU_ID, "Check for Updates...")
                .separator()
                .text(QUIT_MENU_ID, "Quit")
                .build()?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    OPEN_DASHBOARD_MENU_ID => show_main_window(app),
                    CHECK_UPDATES_MENU_ID => {
                        show_main_window(app);
                        let _ = app.emit("check-for-updates", ());
                    }
                    QUIT_MENU_ID => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |_, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(&tray_app_handle);
                    }
                });

            {
                let png_bytes = include_bytes!("../icons/tray-icon.png");
                let img =
                    image::load_from_memory(png_bytes).expect("failed to decode tray icon PNG");
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
                tray_builder = tray_builder.icon(icon).icon_as_template(true);
            }

            tray_builder.build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
