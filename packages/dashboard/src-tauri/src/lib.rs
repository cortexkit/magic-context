pub mod commands;
pub mod config;
pub mod db;
pub mod embedding_probe;
pub mod log_parser;

use std::path::PathBuf;
use std::sync::Mutex;

/// Shared app state holding the resolved database path.
pub struct AppState {
    pub db_path: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        let db_path = db::resolve_db_path();
        Self {
            db_path: Mutex::new(db_path),
        }
    }

    pub fn get_db_path(&self) -> Result<PathBuf, String> {
        self.db_path
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "Database not found. Is the Magic Context plugin installed?".to_string())
    }
}
