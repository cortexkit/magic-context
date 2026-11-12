pub mod commands;
pub mod config;
pub mod db;
pub mod db_capabilities;
pub mod embedding_probe;
pub mod external_cache_sessions;
pub mod jsonc;
mod legacy_memory;
pub mod log_parser;
pub mod memory_bridge;
pub mod memory_history;
pub mod pi_sessions;
pub mod process_ext;
pub mod project_identity;
pub mod project_names;
pub mod serve;
#[cfg(test)]
pub mod test_bin;
#[cfg(test)]
pub mod test_env;
pub mod workspaces;
pub mod writer_diagnostics;

use std::path::PathBuf;

/// Shared app state: how to find the Magic Context database.
///
/// The path is resolved on every lookup rather than once at startup. The
/// dashboard is a long-lived tray app: when it starts before the plugin has
/// created the database, a startup-time answer of "no database" would fail
/// every command until a restart, and when it starts while only the legacy
/// OpenCode-only database exists, it would keep reading and writing that stale
/// file after the plugin creates the shared one, silently losing memory edits.
/// Resolution is two `stat` calls, so doing it per command is cheap.
pub struct AppState {
    resolve_db_path: fn() -> Option<PathBuf>,
}

impl AppState {
    pub fn new() -> Self {
        Self::with_resolver(db::resolve_db_path)
    }

    /// State that resolves the database path with `resolve` instead of the
    /// real data directories (tests use this to stay off the live stores).
    pub fn with_resolver(resolve: fn() -> Option<PathBuf>) -> Self {
        Self {
            resolve_db_path: resolve,
        }
    }

    pub fn get_db_path(&self) -> Result<PathBuf, String> {
        (self.resolve_db_path)()
            .ok_or_else(|| "Database not found. Is the Magic Context plugin installed?".to_string())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod app_state_tests {
    use super::AppState;
    use std::fs;

    #[test]
    fn database_path_follows_the_plugin_after_startup() {
        let mut env = crate::test_env::EnvGuard::new();
        let root = tempfile::tempdir().unwrap();
        env.remove("MAGIC_CONTEXT_STORAGE_DIR");
        env.set("XDG_DATA_HOME", root.path());

        // Started before the plugin created any database.
        let state = AppState::new();
        assert!(state.get_db_path().is_err());

        // The legacy OpenCode-only database appears first...
        let legacy = root
            .path()
            .join("opencode/storage/plugin/magic-context/context.db");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        assert_eq!(state.get_db_path().unwrap(), legacy);

        // ...then the plugin creates the shared one, which must win at once.
        let shared = root.path().join("cortexkit/magic-context/context.db");
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        fs::write(&shared, b"shared").unwrap();
        assert_eq!(state.get_db_path().unwrap(), shared);
    }
}
