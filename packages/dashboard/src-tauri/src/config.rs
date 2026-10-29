use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolves paths to magic-context config files.
pub fn config_home() -> PathBuf {
    std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"))
}

pub fn resolve_user_config_path(config_home: &Path) -> PathBuf {
    config_home.join("cortexkit").join("magic-context.jsonc")
}

/// Pi uses the same CortexKit user config as OpenCode.
pub fn resolve_pi_config_path(config_home: &Path) -> PathBuf {
    resolve_user_config_path(config_home)
}

/// Resolve the project-level magic-context config path (CortexKit layout).
pub fn resolve_project_config_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".cortexkit")
        .join("magic-context.jsonc")
}

/// Canonical dreamer task names (mirrors the plugin's task registry and the
/// frontend DreamerTasksField list). The dashboard renders this fixed set so
/// every project shows the same tasks regardless of its (possibly stale) per-
/// project scheduler snapshot in task_schedule_state.
pub const CANONICAL_DREAM_TASKS: [&str; 12] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
];

/// Default cron per task (mirrors DEFAULT_TASK_SCHEDULES in the plugin schema and
/// the frontend). Applied when neither the project nor the global config sets a
/// schedule. maintain-docs defaults OFF (empty).
pub fn default_task_schedule(task: &str) -> &'static str {
    match task {
        "map-memories" => "0 2 * * *",
        "verify" => "0 3 * * *",
        "verify-broad" => "0 4 * * 0",
        "curate" => "0 4 * * 0",
        "compress-cues" => "0 4 * * *",
        "classify-memories" => "0 6 * * *",
        "retrospective" => "0 5 * * *",
        "maintain-docs" => "",
        "evaluate-smart-notes" => "0 3 * * *",
        "review-user-memories" => "0 3 * * *",
        "promote-primers" => "0 3 * * *",
        "refresh-primers" => "0 3 * * *",
        _ => "",
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: Option<String>,
    pub source: String, // "user", "pi", or "project"
    pub error: Option<String>,
}

pub type ConfigFileResponse = ConfigFile;

pub fn read_config(path: &PathBuf, source: &str) -> ConfigFile {
    let base = || ConfigFile {
        path: path.to_string_lossy().to_string(),
        exists: false,
        content: None,
        source: source.to_string(),
        error: None,
    };

    // Preserve read failures instead of treating them as empty files; the
    // structured editor would otherwise write that empty state over API keys.
    match std::fs::symlink_metadata(path) {
        Ok(_) => match std::fs::read_to_string(path) {
            Ok(content) => ConfigFile {
                exists: true,
                content: Some(content),
                ..base()
            },
            Err(e) => ConfigFile {
                exists: true,
                error: Some(format!("Failed to read config: {e}")),
                ..base()
            },
        },
        Err(e) if e.kind() == ErrorKind::NotFound => base(),
        Err(e) => ConfigFile {
            exists: true,
            error: Some(format!("Failed to inspect config path: {e}")),
            ..base()
        },
    }
}

pub fn write_config(path: &Path, content: &str) -> Result<(), String> {
    write_config_atomic(path, content, None)
}

pub fn write_project_config(project_path: &str, content: &str) -> Result<(), String> {
    let canonical_project = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Invalid project path: {e}"))?;

    // The project path can be a workspace-member alias (for example, a symlinked
    // checkout). Derive the write target from its canonical root so the containment
    // guard compares two paths in the same namespace and cannot be redirected by a
    // caller-provided target.
    let path = canonical_project
        .join(".cortexkit")
        .join("magic-context.jsonc");
    validate_project_config_target(&canonical_project, &path)?;
    write_config_atomic(&path, content, Some(&canonical_project))
}

fn validate_project_config_target(canonical_project: &Path, path: &Path) -> Result<(), String> {
    let expected_config = canonical_project
        .join(".cortexkit")
        .join("magic-context.jsonc");
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_project.join(path)
    };
    if abs_path != expected_config {
        return Err("Config path is outside the project directory".to_string());
    }

    let parent = expected_config
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    let canonical_parent = if parent.exists() {
        parent
            .canonicalize()
            .map_err(|e| format!("Invalid config directory: {e}"))?
    } else {
        parent.to_path_buf()
    };
    if !canonical_parent.starts_with(canonical_project) {
        return Err("Config path is outside the project directory".to_string());
    }

    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                return Err(
                    "Refusing to write project config because the config path is a symlink"
                        .to_string(),
                );
            }
            if !file_type.is_file() {
                return Err(
                    "Refusing to write project config because the config path is not a regular file"
                        .to_string(),
                );
            }
            validate_existing_file_no_follow(path)?;
            let canonical_target = path
                .canonicalize()
                .map_err(|e| format!("Invalid config file path: {e}"))?;
            if !canonical_target.starts_with(canonical_project) {
                return Err("Config file resolves outside the project directory".to_string());
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to inspect config path: {e}")),
    }

    Ok(())
}

#[cfg(unix)]
fn validate_existing_file_no_follow(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map(|_| ())
        .map_err(|e| format!("Failed to open config without following symlinks: {e}"))
}

#[cfg(not(unix))]
fn validate_existing_file_no_follow(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_config_atomic(
    path: &Path,
    content: &str,
    project_root: Option<&Path>,
) -> Result<(), String> {
    // A user config is often a symlink into a dotfiles repo (stow, chezmoi,
    // home-manager). Renaming over the link would replace it with a regular
    // file and edits would silently stop reaching the repo, so write through
    // to the file it points at. Project configs never get here as symlinks:
    // they are untrusted repository content and the project validation
    // refuses a symlinked target.
    let path = if project_root.is_none() {
        resolve_symlinked_config(path)?
    } else {
        path.to_path_buf()
    };
    let path = path.as_path();
    let parent = path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    ensure_private_config_directory(parent)
        .map_err(|e| format!("Failed to create directory: {e}"))?;
    // A user config always ends owner-only, including when replacing a formerly
    // permissive file. Project config retains its prior mode when one exists.
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if project_root.is_none() {
            0o600
        } else {
            std::fs::metadata(path)
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.permissions().mode() & 0o777)
                .unwrap_or(0o600)
        }
    };
    #[cfg(not(unix))]
    let mode = 0o600;
    // Create the temporary config with its final mode, before content is written.
    let temp_path = create_temp_config_file(parent, path.file_name(), content, mode)?;
    if let Some(root) = project_root {
        if let Err(e) = validate_project_config_target(root, path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e);
        }
    }

    replace_with_temp(&temp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to replace config atomically: {e}")
    })
}

/// The file a config path finally names, following any chain of symlinks.
/// A path that is not a symlink is returned as is; a dangling link resolves to
/// the missing file it points at, so the write recreates it there.
fn resolve_symlinked_config(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    for _ in 0..40 {
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = std::fs::read_link(&current)
                    .map_err(|e| format!("Failed to read config symlink: {e}"))?;
                current = match current.parent() {
                    Some(parent) if target.is_relative() => parent.join(target),
                    _ => target,
                };
            }
            Ok(_) => return Ok(current),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(current),
            Err(e) => return Err(format!("Failed to inspect config path: {e}")),
        }
    }
    Err("Config path has too many levels of symlinks".to_string())
}

fn ensure_private_config_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

fn create_temp_config_file(
    parent: &Path,
    file_name: Option<&std::ffi::OsStr>,
    content: &str,
    mode: u32,
) -> Result<PathBuf, String> {
    let file_name = file_name
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("magic-context.jsonc");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..16u8 {
        let temp_path = parent.join(format!(
            ".{file_name}.{}.{}.{}.tmp",
            std::process::id(),
            stamp,
            attempt
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW).mode(mode);
        }
        match options.open(&temp_path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(content.as_bytes()) {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("Failed to write config: {e}"));
                }
                if let Err(e) = file.sync_all() {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("Failed to sync config: {e}"));
                }
                return Ok(temp_path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create temporary config: {e}")),
        }
    }

    Err("Failed to create a unique temporary config path".to_string())
}

/// `std::fs::rename` replaces an existing file on every platform (on Windows
/// it renames with replace-if-exists semantics), so there is never a moment
/// with no config on disk. Deleting the target first, as a Windows
/// workaround, would lose the config if the process died between the two steps.
fn replace_with_temp(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp_path, path)
}

#[tauri::command(async)]
pub fn read_pi_config() -> Result<ConfigFileResponse, String> {
    let path = resolve_pi_config_path(&config_home());
    Ok(read_config(&path, "pi"))
}

#[tauri::command(async)]
pub fn write_pi_config(content: String) -> Result<(), String> {
    let path = resolve_pi_config_path(&config_home());
    write_config(&path, &content)
}

#[tauri::command]
pub fn pi_config_path() -> String {
    resolve_pi_config_path(&config_home())
        .to_string_lossy()
        .to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectConfigEntry {
    pub project_name: String,
    pub worktree: String,
    pub config_path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_config_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_exists: Option<bool>,
}

/// Discover projects with magic-context config files.
///
/// Uses the Magic Context DB (`context.db`) as the primary source of project
/// enumeration — the same authority as the Projects tab — so projects remain
/// discoverable even when OpenCode's resolved session DB is absent. The resolved
/// OpenCode DB is consulted as a secondary source to enrich display names and
/// pick up projects that have sessions but no Magic Context data yet. Results are
/// deduplicated by worktree path.
pub fn discover_project_configs() -> Vec<ProjectConfigEntry> {
    discover_project_configs_with_db(
        crate::db::resolve_db_path().as_ref(),
        &crate::db::data_home(),
        &config_home(),
        &crate::db::opencode_overrides(),
    )
}

/// Internal entry point that accepts an explicit context DB path (for testing
/// and for the serve path which already resolves the path).
pub fn discover_project_configs_with_db(
    context_db_path: Option<&PathBuf>,
    data_home: &Path,
    _config_home: &Path,
    overrides: &crate::db::OpenCodeDbOverrides,
) -> Vec<ProjectConfigEntry> {
    // ── 1. Collect project worktrees from context.db ──────────────
    // The Projects tab uses `get_projects` which queries context.db for project
    // identities and resolves filesystem paths. We use the same source so
    // Users without a readable OpenCode DB still see their Magic Context projects.
    let mut worktree_map: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new(); // worktree_path → display_name

    let opencode_db = crate::db::resolve_opencode_db_path_for(data_home, overrides);
    if let Some(db_path) = context_db_path {
        if let Ok(conn) = crate::db::open_readonly(db_path) {
            if let Ok(projects) = crate::db::get_projects_for_config(&conn, opencode_db.as_ref()) {
                for p in &projects {
                    if let Some(path) = &p.path {
                        if !path.is_empty() {
                            worktree_map.entry(path.clone()).or_insert(p.label.clone());
                        }
                    }
                }
            }
        }
    }

    // ── 2. Enrich from the resolved OpenCode DB (names + extra projects) ──
    if let Some(ref opencode_path) = opencode_db {
        if let Ok((conn, _generation)) = crate::db::open_opencode_readonly(opencode_path) {
            collect_opencode_db_projects(&conn, &mut worktree_map);
        }
    }

    // ── 3. Build entries, checking for config files ───────────────
    let mut entries = Vec::new();
    for (worktree, display_name) in &worktree_map {
        // Skip dead/deleted roots silently
        let Ok(metadata) = std::fs::symlink_metadata(worktree) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }

        let config_path = resolve_project_config_path(worktree);
        let exists = config_path.exists();

        entries.push(ProjectConfigEntry {
            project_name: display_name.clone(),
            worktree: worktree.clone(),
            config_path: config_path.to_string_lossy().to_string(),
            exists,
            alt_config_path: None,
            alt_exists: None,
        });
    }

    entries
}

/// Query the OpenCode CLI DB for project worktrees and names.
/// Adds entries not yet present in `worktree_map` (i.e. projects that have
/// CLI sessions but no Magic Context data yet).
fn collect_opencode_db_projects(
    conn: &rusqlite::Connection,
    worktree_map: &mut std::collections::BTreeMap<String, String>,
) {
    let Ok(mut stmt) = conn.prepare("SELECT name, worktree FROM project") else {
        return;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, String>(1)?,
        ))
    }) else {
        return;
    };

    for row in rows.flatten() {
        let (name, worktree) = row;
        let display_name = if name.is_empty() {
            Path::new(&worktree)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| worktree.clone())
        } else {
            name
        };
        worktree_map.entry(worktree).or_insert(display_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_config_path_matches_cortexkit_user_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = crate::test_env::EnvGuard::new();
        env.set("XDG_CONFIG_HOME", dir.path());

        let expected = dir.path().join("cortexkit/magic-context.jsonc");
        assert_eq!(resolve_pi_config_path(&config_home()), expected);
        assert_eq!(resolve_user_config_path(dir.path()), expected);
        assert_eq!(pi_config_path(), expected.to_string_lossy());

        let missing = read_pi_config().unwrap();
        assert_eq!(missing.path, expected.to_string_lossy());
        assert!(!missing.exists);
        assert_eq!(missing.content.as_deref(), None);
        assert_eq!(missing.source, "pi");
        assert!(missing.error.is_none());

        let content = "{\n  \"enabled\": true\n}";
        write_pi_config(content.to_string()).unwrap();

        let existing = read_pi_config().unwrap();
        assert!(existing.exists);
        assert_eq!(existing.content.as_deref(), Some(content));
        assert_eq!(existing.source, "pi");
        assert!(existing.error.is_none());
    }

    #[test]
    fn read_config_reports_absent_without_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.jsonc");

        let config = read_config(&path, "user");

        assert!(!config.exists);
        assert_eq!(config.content.as_deref(), None);
        assert!(config.error.is_none());
    }

    #[test]
    fn read_config_reports_error_for_present_unreadable_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("magic-context.jsonc");
        std::fs::create_dir(&path).unwrap();

        let config = read_config(&path, "user");

        assert!(config.exists);
        assert_eq!(config.content.as_deref(), None);
        let error = config.error.as_deref().unwrap_or("");
        assert!(
            error.contains("Failed to read config"),
            "unexpected error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_config_writes_through_a_symlinked_user_config() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let dotfiles = dir.path().join("dotfiles/cortexkit");
        std::fs::create_dir_all(&dotfiles).unwrap();
        let real = dotfiles.join("magic-context.jsonc");
        std::fs::write(&real, "{}\n").unwrap();
        let config_dir = dir.path().join("config/cortexkit");
        std::fs::create_dir_all(&config_dir).unwrap();
        let link = config_dir.join("magic-context.jsonc");
        // A relative link, as stow creates them.
        symlink("../../dotfiles/cortexkit/magic-context.jsonc", &link).unwrap();

        write_config(&link, "{ \"enabled\": false }\n").expect("write through link");

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "{ \"enabled\": false }\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&config_dir)
            .unwrap()
            .chain(std::fs::read_dir(&dotfiles).unwrap())
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn new_user_config_is_created_with_owner_only_mode() {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let root = std::env::temp_dir().join("magic-context").join(format!(
            "dashboard-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(&root).unwrap();
        let path = root.join("config/cortexkit/magic-context.jsonc");

        write_config(&path, "{ \"api_key\": \"secret\" }\n").expect("write");

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_config_keeps_the_existing_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("magic-context.jsonc");
        std::fs::write(&path, "{}\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        write_config(&path, "{ \"api_key\": \"secret\" }\n").expect("write");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".cortexkit")).unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let project_config = canonical_project.join(".cortexkit/magic-context.jsonc");
        std::fs::write(&project_config, "{}\n").unwrap();
        std::fs::set_permissions(&project_config, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_project_config(canonical_project.to_str().unwrap(), "{}\n").expect("write");
        let mode = std::fs::metadata(&project_config)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn write_project_config_writes_regular_file_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let path = canonical_project.join(".cortexkit/magic-context.jsonc");

        write_project_config(
            canonical_project.to_str().unwrap(),
            "{\n  \"enabled\": true\n}\n",
        )
        .expect("initial write");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"enabled\": true\n}\n"
        );

        write_project_config(
            canonical_project.to_str().unwrap(),
            "{\n  \"enabled\": false\n}\n",
        )
        .expect("overwrite regular file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"enabled\": false\n}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_project_config_uses_the_canonical_workspace_member_root() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let workspace_member = dir.path().join("workspace/member");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir_all(workspace_member.parent().unwrap()).unwrap();
        symlink(&project, &workspace_member).unwrap();

        write_project_config(
            workspace_member.to_str().unwrap(),
            "{\n  \"dreamer\": { \"tasks\": {} }\n}\n",
        )
        .expect("workspace member should create its own project override");

        let canonical_target = project.join(".cortexkit/magic-context.jsonc");
        assert_eq!(
            std::fs::read_to_string(canonical_target).unwrap(),
            "{\n  \"dreamer\": { \"tasks\": {} }\n}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_project_config_refuses_symlink_target() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "do not overwrite").unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let config_path = canonical_project.join(".cortexkit/magic-context.jsonc");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        symlink(&outside, &config_path).unwrap();

        let err = write_project_config(canonical_project.to_str().unwrap(), "{\"enabled\":true}\n")
            .expect_err("symlinked config must be refused");
        assert!(err.contains("symlink"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "do not overwrite"
        );
    }

    #[test]
    fn write_project_config_refuses_non_regular_target() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let config_path = canonical_project.join(".cortexkit/magic-context.jsonc");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::create_dir(&config_path).unwrap();

        let err = write_project_config(canonical_project.to_str().unwrap(), "{}\n")
            .expect_err("directory target must be refused");
        assert!(err.contains("regular file"), "unexpected error: {err}");
    }

    // ── discover_project_configs_with_db tests ─────────────────────

    /// Create a minimal opencode.db with a project table.
    fn create_test_opencode_db(
        db_path: &Path,
        projects: &[(&str, &str)], // (name, worktree)
    ) -> rusqlite::Connection {
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (
                id TEXT PRIMARY KEY,
                name TEXT,
                worktree TEXT NOT NULL
            );",
        )
        .unwrap();
        for (i, (name, worktree)) in projects.iter().enumerate() {
            conn.execute(
                "INSERT INTO project (id, name, worktree) VALUES (?1, ?2, ?3)",
                rusqlite::params![format!("p-{}", i), name, worktree],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn discover_project_configs_with_none_returns_no_crash() {
        // No context DB or OpenCode DB in the injected home yields no projects.
        let temp = tempfile::tempdir().unwrap();
        let data_home = temp.path().join("data");
        let entries =
            discover_project_configs_with_db(None, &data_home, temp.path(), &Default::default());
        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.worktree).starts_with(temp.path())));
        assert!(entries.is_empty());
    }

    #[test]
    fn discover_project_configs_finds_projects_from_opencode_db() {
        // When opencode.db exists with project worktrees, the config editor
        // should discover those projects even without context.db data.
        let temp = tempfile::tempdir().unwrap();
        let data_home = temp.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();

        // Create a project directory with a config file
        let proj = temp.path().join("my-project");
        std::fs::create_dir_all(proj.join(".cortexkit")).unwrap();
        std::fs::write(
            proj.join(".cortexkit").join("magic-context.jsonc"),
            "{\"enabled\": true}",
        )
        .unwrap();
        let proj_str = proj.to_string_lossy().to_string();

        // Set up opencode.db with the project
        let oc_path = data_home.join("opencode").join("opencode.db");
        let oc = create_test_opencode_db(&oc_path, &[("My Project", proj_str.as_str())]);
        drop(oc);

        // A different environment home must not leak its projects into discovery.
        let other = tempfile::tempdir().unwrap();
        let other_project = other.path().join("other-project");
        std::fs::create_dir(&other_project).unwrap();
        let other_db = other.path().join("opencode/opencode.db");
        drop(create_test_opencode_db(
            &other_db,
            &[("Other Project", other_project.to_str().unwrap())],
        ));
        let mut env = crate::test_env::EnvGuard::new();
        env.set("XDG_DATA_HOME", other.path());

        // No context.db — OpenCode discovery still finds the injected store.
        let entries =
            discover_project_configs_with_db(None, &data_home, temp.path(), &Default::default());

        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.worktree).starts_with(temp.path())));
        // Should find the project with config
        let found = entries.iter().find(|e| e.worktree.contains("my-project"));
        assert!(
            found.is_some(),
            "expected to find project with my-project, got: {:?}",
            entries
        );
        assert!(found.unwrap().exists, "project config should exist");
    }

    #[test]
    fn discover_project_configs_finds_projects_from_context_db() {
        // When only context.db exists (no opencode.db), the Config Editor
        // should discover projects via get_projects. This is the Desktop scenario
        // that was broken before the fix: opencode.db doesn't exist on Desktop,
        // so the old discover_project_configs() returned empty.
        let temp = tempfile::tempdir().unwrap();
        let data_home = temp.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();

        // Create a project directory with a config file
        let proj = temp.path().join("my-project");
        std::fs::create_dir_all(proj.join(".cortexkit")).unwrap();
        std::fs::write(
            proj.join(".cortexkit").join("magic-context.jsonc"),
            "{\"enabled\": true}",
        )
        .unwrap();
        let proj_str = proj.to_string_lossy().to_string();

        // Set up opencode.db with the project (so enumerate_projects can
        // resolve the identity → path mapping)
        let oc_path = data_home.join("opencode").join("opencode.db");
        let oc = create_test_opencode_db(&oc_path, &[("My Project", proj_str.as_str())]);
        drop(oc);

        // Set up context.db with a memory row for the same project
        let ctx_path = data_home
            .join("cortexkit")
            .join("magic-context")
            .join("context.db");
        std::fs::create_dir_all(ctx_path.parent().unwrap()).unwrap();
        let ctx_conn = rusqlite::Connection::open(&ctx_path).unwrap();
        ctx_conn
            .execute_batch(
                "CREATE TABLE memories (
                    project_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                );",
            )
            .unwrap();
        ctx_conn
            .execute(
                "INSERT INTO memories (project_path, status) VALUES (?1, 'active')",
                rusqlite::params![proj_str],
            )
            .unwrap();
        drop(ctx_conn);

        // Pass context.db — this should discover the project
        let entries = discover_project_configs_with_db(
            Some(&ctx_path),
            &data_home,
            temp.path(),
            &Default::default(),
        );

        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.worktree).starts_with(temp.path())));
        // Should find the project with config
        let found = entries.iter().find(|e| e.worktree.contains("my-project"));
        assert!(
            found.is_some(),
            "expected to find project with my-project via context.db, got: {:?}",
            entries
        );
        assert!(found.unwrap().exists, "project config should exist");
    }

    #[test]
    fn discover_project_configs_skips_dead_roots() {
        // Dead/deleted project roots should be silently skipped.
        let temp = tempfile::tempdir().unwrap();
        let data_home = temp.path().join("data");
        std::fs::create_dir_all(&data_home).unwrap();

        // Create one real project and one nonexistent path
        let proj_real = temp.path().join("real-project");
        std::fs::create_dir_all(proj_real.join(".cortexkit")).unwrap();
        std::fs::write(
            proj_real.join(".cortexkit").join("magic-context.jsonc"),
            "{\"enabled\": true}",
        )
        .unwrap();
        let proj_dead = temp.path().join("deleted-project"); // does NOT exist on disk

        let proj_real_str = proj_real.to_string_lossy().to_string();
        let proj_dead_str = proj_dead.to_string_lossy().to_string();

        // Set up opencode.db with both projects (real + dead path)
        let oc_path = data_home.join("opencode").join("opencode.db");
        let oc = create_test_opencode_db(
            &oc_path,
            &[
                ("Real Project", proj_real_str.as_str()),
                ("Dead Project", proj_dead_str.as_str()),
            ],
        );
        drop(oc);

        let entries =
            discover_project_configs_with_db(None, &data_home, temp.path(), &Default::default());

        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.worktree).starts_with(temp.path())));
        // Should only contain the real project (dead root skipped)
        assert_eq!(
            entries.len(),
            1,
            "should skip dead root, got: {:?}",
            entries
        );
        assert!(entries[0].worktree.contains("real-project"));
        assert!(entries[0].exists, "real project config should exist");
    }
}
