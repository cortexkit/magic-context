#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use magic_context_dashboard_lib::{commands, db, AppState};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

const OPEN_DASHBOARD_MENU_ID: &str = "open_dashboard";
const TRIGGER_DREAMER_MENU_ID: &str = "trigger_dreamer";
const QUIT_MENU_ID: &str = "quit";

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn trigger_dreamer(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = state.get_db_path()?;
    let conn = db::open_readwrite(&path).map_err(|e| e.to_string())?;
    db::enqueue_dream(&conn, ".", "Manual trigger from dashboard tray")
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Memory
            commands::get_projects,
            commands::get_memories,
            commands::get_memory_stats,
            commands::update_memory_status,
            commands::update_memory_content,
            commands::delete_memory,
            // Sessions
            commands::get_sessions,
            commands::get_compartments,
            commands::get_session_facts,
            commands::get_session_notes,
            commands::get_session_meta,
            // Dreamer
            commands::get_dream_queue,
            commands::get_dream_state,
            commands::enqueue_dream,
            // Logs & Cache
            commands::get_log_entries,
            commands::get_cache_events,
            commands::get_session_cache_stats,
            // Config
commands::get_config,
commands::save_config,
commands::get_project_configs,
commands::save_project_config,
            // Models
            commands::get_available_models,
                commands::test_embedding_endpoint,
            // Health
            commands::get_db_health,
        ])
        .setup(|app| {
            let tray_app_handle = app.app_handle().clone();
            let tray_menu = MenuBuilder::new(app)
                .text(OPEN_DASHBOARD_MENU_ID, "Open Dashboard")
                .text(TRIGGER_DREAMER_MENU_ID, "Trigger Dreamer")
                .separator()
                .text(QUIT_MENU_ID, "Quit")
                .build()?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    OPEN_DASHBOARD_MENU_ID => show_main_window(app),
                    TRIGGER_DREAMER_MENU_ID => {
                        if let Err(error) = trigger_dreamer(app) {
                            eprintln!("failed to trigger dreamer from tray: {error}");
                        }
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

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder.build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
