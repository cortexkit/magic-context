use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Resolves paths to magic-context config files.
pub fn resolve_user_config_path() -> PathBuf {
    let config_dir = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"));
    config_dir.join("opencode").join("magic-context.jsonc")
}

fn resolve_home_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("MAGIC_CONTEXT_DASHBOARD_TEST_HOME") {
        return PathBuf::from(home);
    }

    dirs::home_dir().unwrap_or_default()
}

/// Resolves the Pi user-level magic-context config path.
pub fn resolve_pi_config_path() -> PathBuf {
    resolve_home_dir()
        .join(".pi")
        .join("agent")
        .join("magic-context.jsonc")
}

/// Resolve the active magic-context config path for a project.
/// Checks root first, then `.opencode/` alt path. Returns the first that exists,
/// or root path as default for new config creation.
pub fn resolve_project_config_path(project_path: &str) -> PathBuf {
    let root_config = PathBuf::from(project_path).join("magic-context.jsonc");
    if root_config.exists() {
        return root_config;
    }
    let alt_config = PathBuf::from(project_path)
        .join(".opencode")
        .join("magic-context.jsonc");
    if alt_config.exists() {
        return alt_config;
    }
    // Default to root path for new configs
    root_config
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub source: String, // "user" or "project"
}

pub type ConfigFileResponse = ConfigFile;

pub fn read_config(path: &PathBuf, source: &str) -> ConfigFile {
    let exists = path.exists();
    let content = if exists {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    ConfigFile {
        path: path.to_string_lossy().to_string(),
        exists,
        content,
        source: source.to_string(),
    }
}

pub fn write_config(path: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn read_pi_config() -> Result<ConfigFileResponse, String> {
    let path = resolve_pi_config_path();
    Ok(read_config(&path, "pi"))
}

#[tauri::command]
pub fn write_pi_config(content: String) -> Result<(), String> {
    let path = resolve_pi_config_path();
    write_config(&path, &content)
}

#[tauri::command]
pub fn pi_config_path() -> String {
    resolve_pi_config_path().to_string_lossy().to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectConfigEntry {
    pub project_name: String,
    pub worktree: String,
    pub config_path: String,
    pub exists: bool,
    pub alt_config_path: Option<String>,
    pub alt_exists: bool,
}

/// Discover projects with magic-context config files by scanning OpenCode project worktrees.
pub fn discover_project_configs() -> Vec<ProjectConfigEntry> {
    let opencode_db = {
        let data_dir = if cfg!(target_os = "windows") {
            match dirs::data_dir() {
                Some(d) => d,
                None => return vec![],
            }
        } else {
            std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local")
                        .join("share")
                })
        };
        data_dir.join("opencode").join("opencode.db")
    };

    if !opencode_db.exists() {
        return vec![];
    }

    let conn = match rusqlite::Connection::open_with_flags(
        &opencode_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut stmt = match conn.prepare("SELECT name, worktree FROM project") {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let rows: Vec<(String, String)> = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, String>(1)?,
        ))
    }) {
        Ok(mapped) => mapped.flatten().collect(),
        Err(_) => return vec![],
    };

    let mut entries = Vec::new();
    for (name, worktree) in rows {
        let root_config = PathBuf::from(&worktree).join("magic-context.jsonc");
        let alt_config = PathBuf::from(&worktree)
            .join(".opencode")
            .join("magic-context.jsonc");
        let root_exists = root_config.exists();
        let alt_exists = alt_config.exists();

        // Only include projects that have at least one config file
        if root_exists || alt_exists {
            let display_name = if name.is_empty() {
                std::path::Path::new(&worktree)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| worktree.clone())
            } else {
                name
            };

            entries.push(ProjectConfigEntry {
                project_name: display_name,
                worktree: worktree.clone(),
                config_path: root_config.to_string_lossy().to_string(),
                exists: root_exists,
                alt_config_path: Some(alt_config.to_string_lossy().to_string()),
                alt_exists,
            });
        }
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_config_path_and_read_cover_missing_and_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAGIC_CONTEXT_DASHBOARD_TEST_HOME", dir.path());

        let expected = dir.path().join(".pi/agent/magic-context.jsonc");
        assert_eq!(resolve_pi_config_path(), expected);
        assert_eq!(pi_config_path(), expected.to_string_lossy());

        let missing = read_pi_config().unwrap();
        assert_eq!(missing.path, expected.to_string_lossy());
        assert!(!missing.exists);
        assert_eq!(missing.content, "");
        assert_eq!(missing.source, "pi");

        let content = "{\n  \"enabled\": true\n}";
        write_pi_config(content.to_string()).unwrap();

        let existing = read_pi_config().unwrap();
        assert!(existing.exists);
        assert_eq!(existing.content, content);
        assert_eq!(existing.source, "pi");

        std::env::remove_var("MAGIC_CONTEXT_DASHBOARD_TEST_HOME");
    }
}
