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
    // The backup copies get the name of the config path, not of the link
    // target, so that a link that changes to a different file keeps one set
    // of copies, which pruning keeps at its limit.
    let logical_path = path;
    let path = if project_root.is_none() {
        resolve_symlinked_config(path)?
    } else {
        path.to_path_buf()
    };
    let path = path.as_path();
    let backup_dir = config_backup_dir()?;
    let backup_scope = match project_root {
        Some(root) => format!("project-{}", project_hash(root)),
        None => "user".to_string(),
    };
    // Hold the lock of this config's backup set from before the read of the
    // current config until after the replace. Two saves that overlap could
    // otherwise both copy the same old version, and the version between them
    // would have no copy.
    let scope_mutex = in_process_scope_lock(&backup_dir, &backup_scope);
    let _in_process = scope_mutex
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let _cross_process = lock_backup_scope(&backup_dir, &backup_scope, CONFIG_LOCK_WAIT)?;
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
    // Make the copy before the rename replaces the file. If there is no copy,
    // do not save.
    if let Err(e) = back_up_current_config(path, logical_path, &backup_dir, &backup_scope) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e);
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

/// The longest time that a save waits for a different dashboard process to end
/// its save of the same config.
const CONFIG_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The lock file of one backup set: `.<scope>.lock` in the backup folder.
fn backup_scope_lock_path(backup_dir: &Path, scope: &str) -> PathBuf {
    backup_dir.join(format!(".{scope}.lock"))
}

/// One mutex for each backup set in this process. The file lock alone does not
/// serialize threads on platforms that have no `flock`, and saves of different
/// configs do not wait for each other.
fn in_process_scope_lock(backup_dir: &Path, scope: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    Arc::clone(
        locks
            .entry(backup_scope_lock_path(backup_dir, scope))
            .or_default(),
    )
}

/// Take the exclusive lock of one backup set, so that a save in a different
/// dashboard process waits. The lock stays until the returned file closes.
/// If the lock is not free in `wait`, the save is refused, as when no copy can
/// be made.
#[cfg(unix)]
fn lock_backup_scope(
    backup_dir: &Path,
    scope: &str,
    wait: std::time::Duration,
) -> Result<Option<std::fs::File>, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::os::unix::io::AsRawFd;

    let refuse = |e: std::io::Error| {
        format!(
            "Refusing to save config: cannot lock the backup folder {}: {e}",
            backup_dir.display()
        )
    };
    ensure_private_backup_directory(backup_dir).map_err(|e| {
        format!(
            "Refusing to save config: cannot use the backup folder {}: {e}",
            backup_dir.display()
        )
    })?;
    // O_NOFOLLOW: a symlink at the lock path must not open a different file.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(backup_scope_lock_path(backup_dir, scope))
        .map_err(refuse)?;
    let metadata = file.metadata().map_err(refuse)?;
    if !metadata.is_file() {
        return Err(refuse(std::io::Error::other(
            "the lock path is not a regular file",
        )));
    }
    if metadata.permissions().mode() & 0o777 != 0o600 {
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(refuse)?;
    }
    let deadline = std::time::Instant::now() + wait;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(file));
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(code) if code == libc::EWOULDBLOCK => {}
            _ => return Err(refuse(error)),
        }
        if std::time::Instant::now() >= deadline {
            return Err(refuse(std::io::Error::other(
                "a different save of this config did not end in time",
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Without `flock`, only the in-process mutex serializes saves. Saves in
/// different dashboard processes can then overlap.
#[cfg(not(unix))]
fn lock_backup_scope(
    _backup_dir: &Path,
    _scope: &str,
    _wait: std::time::Duration,
) -> Result<Option<std::fs::File>, String> {
    Ok(None)
}

/// Number of copies kept for each config in the backup folder.
const CONFIG_BACKUP_LIMIT: usize = 5;

/// The folder for config copies: `config-backups` in the Magic Context store.
/// This function uses the same rule as the plugin to find the store
/// (`getMagicContextStorageResolution` in `packages/plugin/src/shared/data-path.ts`):
/// `MAGIC_CONTEXT_STORAGE_DIR`, then `XDG_DATA_HOME`, then `~/.local/share`,
/// on all platforms. Thus the copies stay out of the config folder, which must
/// not get more files, and out of project repositories.
fn config_backup_dir() -> Result<PathBuf, String> {
    let non_empty = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let store = if let Some(explicit) = non_empty("MAGIC_CONTEXT_STORAGE_DIR") {
        let explicit = PathBuf::from(explicit);
        if !explicit.is_absolute() {
            return Err(
                "Refusing to save config: MAGIC_CONTEXT_STORAGE_DIR is not an absolute path, \
                 so there is no folder for the backup copy"
                    .to_string(),
            );
        }
        explicit
    } else {
        let data_home = match non_empty("XDG_DATA_HOME") {
            Some(value) => PathBuf::from(value),
            None => dirs::home_dir()
                .ok_or_else(|| {
                    "Refusing to save config: no home folder, \
                     so there is no folder for the backup copy"
                        .to_string()
                })?
                .join(".local")
                .join("share"),
        };
        data_home.join("cortexkit").join("magic-context")
    };
    Ok(store.join("config-backups"))
}

/// A short, stable name part for a project. It keeps the copies of different
/// project configs apart, and it keeps the project path out of file names.
fn project_hash(canonical_project: &Path) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(canonical_project.to_string_lossy().as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// Copy the current config at `path` into the backup folder, then remove the
/// oldest copies of the same config. The copy names come from `logical_path`,
/// the config path before symlinks resolve. If there is no config, there is
/// no copy.
fn back_up_current_config(
    path: &Path,
    logical_path: &Path,
    backup_dir: &Path,
    scope: &str,
) -> Result<(), String> {
    let Some(current) = read_current_config_no_follow(path).map_err(|e| {
        format!("Refusing to save config: cannot read the current config for a backup copy: {e}")
    })?
    else {
        return Ok(());
    };
    #[cfg(test)]
    run_after_backup_read_hook(path);
    ensure_private_backup_directory(backup_dir).map_err(|e| {
        format!(
            "Refusing to save config: cannot use the backup folder {}: {e}",
            backup_dir.display()
        )
    })?;

    let stem = logical_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("magic-context");
    let suffix = logical_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    let prefix = format!("{stem}.{scope}.");
    write_backup_copy(backup_dir, &prefix, &suffix, &current).map_err(|e| {
        format!(
            "Refusing to save config: cannot write the backup copy in {}: {e}",
            backup_dir.display()
        )
    })?;
    prune_config_backups(backup_dir, &prefix, &suffix);
    Ok(())
}

/// A test can stop a save after it reads the current config, to make two saves
/// overlap at the point where a lost backup can occur.
#[cfg(test)]
type BackupReadHook = std::sync::Arc<dyn Fn(&Path) + Send + Sync>;

#[cfg(test)]
static AFTER_BACKUP_READ_HOOK: std::sync::Mutex<Option<BackupReadHook>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
fn run_after_backup_read_hook(path: &Path) {
    let hook = AFTER_BACKUP_READ_HOOK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    if let Some(hook) = hook {
        hook(path);
    }
}

fn read_current_config_no_follow(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "the config path is not a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// Make the backup folder owner-only. Refuse a symlink at the folder path, so
/// that a copy does not go to a folder that a different path selects.
fn ensure_private_backup_directory(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => ensure_private_config_directory(dir)?,
        Err(e) => return Err(e),
    }
    let metadata = std::fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("the folder is a symlink"));
    }
    if !metadata.is_dir() {
        return Err(std::io::Error::other("the path is not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // Open the folder with O_NOFOLLOW and change the mode through that
        // file descriptor, so that the chmod cannot touch a different folder.
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(dir)?;
        if handle.metadata()?.permissions().mode() & 0o777 != 0o700 {
            handle.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// Write one copy as `<stem>.<scope>.<UTC timestamp>-<NN><suffix>`. The
/// timestamp width does not change, so name order is time order. The counter and
/// `create_new` make sure that two saves at the same time do not write to the
/// same copy.
fn write_backup_copy(
    backup_dir: &Path,
    prefix: &str,
    suffix: &str,
    content: &[u8],
) -> std::io::Result<()> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ").to_string();
    for attempt in 0..100u8 {
        let copy_path = backup_dir.join(format!("{prefix}{stamp}-{attempt:02}{suffix}"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
        }
        let mut file = match options.open(&copy_path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = (|| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(content)?;
            file.sync_all()
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&copy_path);
            return Err(e);
        }
        return Ok(());
    }
    Err(std::io::Error::other("no unique backup copy name"))
}

/// Remove all but the newest copies of one config. Only regular files with
/// this config's prefix, suffix and timestamp shape go, so copies of other
/// configs stay. A failure here does not stop the save: the copy of the
/// current file is on disk, and the next save tries again.
fn prune_config_backups(backup_dir: &Path, prefix: &str, suffix: &str) {
    let Ok(entries) = std::fs::read_dir(backup_dir) else {
        return;
    };
    let mut copies: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| {
            name.strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix(suffix))
                .is_some_and(is_backup_stamp)
        })
        .collect();
    if copies.len() <= CONFIG_BACKUP_LIMIT {
        return;
    }
    copies.sort();
    let excess = copies.len() - CONFIG_BACKUP_LIMIT;
    for name in &copies[..excess] {
        let _ = std::fs::remove_file(backup_dir.join(name));
    }
}

/// Agrees with `YYYYMMDDTHHMMSS.NNNNNNNNNZ-NN`, the shape that `write_backup_copy` writes.
fn is_backup_stamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 29
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 => *b == b'T',
            15 => *b == b'.',
            25 => *b == b'Z',
            26 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

pub(crate) fn ensure_private_config_directory(path: &Path) -> std::io::Result<()> {
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
        env.set("XDG_DATA_HOME", dir.path().join("data"));
        env.remove("MAGIC_CONTEXT_STORAGE_DIR");

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
        let (_env, _) = isolated_data_home(dir.path());
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
        let (_env, _) = isolated_data_home(&root);
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
        let (_env, _) = isolated_data_home(dir.path());
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
        let (_env, _) = isolated_data_home(dir.path());
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
        let (_env, _) = isolated_data_home(dir.path());
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

    // ── config backup tests ─────────────────────────────────────────

    /// Point the backup store at a temporary data home. The guard also holds
    /// the environment lock, so parallel tests cannot see a different value.
    fn isolated_data_home(root: &Path) -> (crate::test_env::EnvGuard, PathBuf) {
        let mut env = crate::test_env::EnvGuard::new();
        let data_home = root.join("data");
        env.set("XDG_DATA_HOME", &data_home);
        env.remove("MAGIC_CONTEXT_STORAGE_DIR");
        (
            env,
            data_home.join("cortexkit/magic-context/config-backups"),
        )
    }

    fn sorted_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = match std::fs::read_dir(dir) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        names
    }

    /// The config copies in a backup folder, without the lock files.
    fn backup_copies(dir: &Path) -> Vec<String> {
        sorted_names(dir)
            .into_iter()
            .filter(|name| !name.ends_with(".lock"))
            .collect()
    }

    /// Remove the read hook also when the test fails.
    struct BackupReadHookGuard;

    impl BackupReadHookGuard {
        fn set(hook: BackupReadHook) -> Self {
            *AFTER_BACKUP_READ_HOOK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(hook);
            Self
        }
    }

    impl Drop for BackupReadHookGuard {
        fn drop(&mut self) {
            *AFTER_BACKUP_READ_HOOK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = None;
        }
    }

    fn user_config_in(root: &Path, content: &str) -> PathBuf {
        let path = root.join("config/cortexkit/magic-context.jsonc");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn save_keeps_the_previous_bytes_in_the_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = user_config_in(dir.path(), "{ \"version\": 0 }\n");

        write_config(&path, "{ \"version\": 1 }\n").expect("save");

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"version\": 1 }\n"
        );
        let names = backup_copies(&backups);
        assert_eq!(names.len(), 1, "copies: {names:?}");
        assert!(
            names[0].starts_with("magic-context.user.") && names[0].ends_with(".jsonc"),
            "unexpected copy name: {}",
            names[0]
        );
        assert_eq!(
            std::fs::read_to_string(backups.join(&names[0])).unwrap(),
            "{ \"version\": 0 }\n"
        );
        // The config folder gets no more files.
        assert_eq!(
            sorted_names(path.parent().unwrap()),
            vec!["magic-context.jsonc".to_string()]
        );
    }

    #[test]
    fn first_save_of_a_new_config_makes_no_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = dir.path().join("config/cortexkit/magic-context.jsonc");

        write_config(&path, "{}\n").expect("save");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        assert!(backup_copies(&backups).is_empty());
    }

    #[test]
    fn sixth_save_drops_the_oldest_copy_only() {
        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = user_config_in(dir.path(), "v0");
        // A copy of a different config must stay after the pruning, also when
        // it is older than all copies of this config.
        std::fs::create_dir_all(&backups).unwrap();
        let other = "magic-context.project-0123456789ab.20000101T000000.000000000Z-00.jsonc";
        std::fs::write(backups.join(other), "other").unwrap();

        // The saves run in a fast loop, so some occur in one second: a copy
        // must not replace an earlier copy.
        for version in 1..=6 {
            write_config(&path, &format!("v{version}")).expect("save");
        }

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v6");
        let names = sorted_names(&backups);
        assert!(names.contains(&other.to_string()), "copies: {names:?}");
        let contents: Vec<String> = names
            .iter()
            .filter(|name| name.starts_with("magic-context.user."))
            .map(|name| std::fs::read_to_string(backups.join(name)).unwrap())
            .collect();
        assert_eq!(contents, vec!["v1", "v2", "v3", "v4", "v5"]);
    }

    #[test]
    fn copy_failure_refuses_the_save_and_leaves_the_config_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = user_config_in(dir.path(), "{ \"keep\": true }\n");
        // A regular file where the backup folder must be: no copy can be made.
        std::fs::create_dir_all(backups.parent().unwrap()).unwrap();
        std::fs::write(&backups, "not a directory").unwrap();

        let err = write_config(&path, "{ \"keep\": false }\n")
            .expect_err("save without a copy must be refused");

        assert!(err.contains("backup"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"keep\": true }\n"
        );
        assert_eq!(
            sorted_names(path.parent().unwrap()),
            vec!["magic-context.jsonc".to_string()]
        );
    }

    #[test]
    fn copies_go_to_the_storage_override_when_it_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let (mut env, xdg_backups) = isolated_data_home(dir.path());
        let storage = dir.path().join("store");
        env.set("MAGIC_CONTEXT_STORAGE_DIR", &storage);
        let path = user_config_in(dir.path(), "v0");

        write_config(&path, "v1").expect("save");

        assert_eq!(backup_copies(&storage.join("config-backups")).len(), 1);
        assert!(sorted_names(&xdg_backups).is_empty());
    }

    #[test]
    fn project_copy_lands_in_the_data_folder_with_a_project_hash() {
        use sha2::{Digest, Sha256};

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".cortexkit")).unwrap();
        let canonical_project = project.canonicalize().unwrap();
        let config = canonical_project.join(".cortexkit/magic-context.jsonc");
        std::fs::write(&config, "p0").unwrap();

        write_project_config(canonical_project.to_str().unwrap(), "p1").expect("save");

        assert_eq!(std::fs::read_to_string(&config).unwrap(), "p1");
        assert_eq!(
            sorted_names(&canonical_project.join(".cortexkit")),
            vec!["magic-context.jsonc".to_string()]
        );
        let digest = Sha256::digest(canonical_project.to_string_lossy().as_bytes());
        let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let prefix = format!("magic-context.project-{}.", &hash[..12]);
        let names = backup_copies(&backups);
        assert_eq!(names.len(), 1, "copies: {names:?}");
        assert!(
            names[0].starts_with(&prefix),
            "unexpected name: {}",
            names[0]
        );
        assert_eq!(
            std::fs::read_to_string(backups.join(&names[0])).unwrap(),
            "p0"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_folder_and_copies_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        // The save narrows the mode of a folder that has a wide mode.
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = user_config_in(dir.path(), "{ \"api_key\": \"secret\" }\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_config(&path, "{}\n").expect("save");

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&backups), 0o700);
        let names = backup_copies(&backups);
        assert_eq!(names.len(), 1, "copies: {names:?}");
        assert_eq!(mode(&backups.join(&names[0])), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_backup_folder_refuses_the_save() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::create_dir_all(backups.parent().unwrap()).unwrap();
        symlink(&elsewhere, &backups).unwrap();
        let path = user_config_in(dir.path(), "v0");

        let err = write_config(&path, "v1").expect_err("symlinked folder must be refused");

        assert!(err.contains("backup"), "unexpected error: {err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v0");
        assert!(sorted_names(&elsewhere).is_empty());
    }

    /// Two saves that overlap must not both copy the same old bytes: the
    /// save that runs second must copy what the first save wrote.
    #[test]
    fn overlapping_saves_back_up_each_replaced_version() {
        use std::sync::{Arc, Condvar, Mutex};

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = user_config_in(dir.path(), "A");
        // After it reads the current config, each save waits until the other
        // save also read it, or until the timeout. Without serialization, both
        // saves read "A". With serialization, the second save cannot read
        // before the first save replaced the file, so the first wait ends at
        // the timeout and the result does not depend on thread timing.
        let arrivals = Arc::new((Mutex::new(0usize), Condvar::new()));
        let hook_arrivals = Arc::clone(&arrivals);
        let hook_path = path.clone();
        let _hook = BackupReadHookGuard::set(Arc::new(move |read_path: &Path| {
            if read_path != hook_path {
                return;
            }
            let (count, ready) = &*hook_arrivals;
            let mut count = count.lock().unwrap();
            *count += 1;
            ready.notify_all();
            let _ = ready
                .wait_timeout_while(count, std::time::Duration::from_secs(2), |count| *count < 2)
                .unwrap();
        }));

        let savers: Vec<_> = ["B", "C"]
            .into_iter()
            .map(|content| {
                let path = path.clone();
                std::thread::spawn(move || write_config(&path, content))
            })
            .collect();
        for saver in savers {
            saver.join().unwrap().expect("save");
        }

        let last = std::fs::read_to_string(&path).unwrap();
        let first = if last == "B" { "C" } else { "B" };
        let contents: Vec<String> = backup_copies(&backups)
            .iter()
            .map(|name| std::fs::read_to_string(backups.join(name)).unwrap())
            .collect();
        assert_eq!(contents, vec!["A".to_string(), first.to_string()]);
    }

    /// Open the lock file of a backup scope and lock it, as a save in a
    /// different dashboard process does.
    #[cfg(unix)]
    fn hold_scope_lock(backups: &Path, scope: &str) -> std::fs::File {
        use std::os::unix::io::AsRawFd;

        ensure_private_backup_directory(backups).unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(backups.join(format!(".{scope}.lock")))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        file
    }

    /// A save waits while a different process holds the lock, and then copies
    /// what that process wrote.
    #[cfg(unix)]
    #[test]
    fn save_waits_for_a_scope_lock_held_by_another_handle() {
        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let path = user_config_in(dir.path(), "A");
        let holder = hold_scope_lock(&backups, "user");

        let saver = {
            let path = path.clone();
            std::thread::spawn(move || write_config(&path, "B"))
        };
        // A save that does not wait finishes in this time and copies "A".
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(&path, "X").unwrap();
        drop(holder);
        saver.join().unwrap().expect("save");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "B");
        let contents: Vec<String> = backup_copies(&backups)
            .iter()
            .map(|name| std::fs::read_to_string(backups.join(name)).unwrap())
            .collect();
        assert_eq!(contents, vec!["X".to_string()]);
    }

    /// Copies of a symlinked user config get the name of the config, not of
    /// the file that the link points at, so that one set of copies is pruned
    /// also after the link changes to a different file.
    #[cfg(unix)]
    #[test]
    fn symlinked_user_config_copies_use_the_config_name() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        let dotfiles = dir.path().join("dotfiles");
        std::fs::create_dir_all(&dotfiles).unwrap();
        std::fs::write(dotfiles.join("other-name.jsonc"), "v0").unwrap();
        std::fs::write(dotfiles.join("third-name.jsonc"), "w0").unwrap();
        let config_dir = dir.path().join("config/cortexkit");
        std::fs::create_dir_all(&config_dir).unwrap();
        let link = config_dir.join("magic-context.jsonc");
        symlink(dotfiles.join("other-name.jsonc"), &link).unwrap();

        for version in 1..=3 {
            write_config(&link, &format!("v{version}")).expect("save");
        }
        std::fs::remove_file(&link).unwrap();
        symlink(dotfiles.join("third-name.jsonc"), &link).unwrap();
        for version in 1..=3 {
            write_config(&link, &format!("w{version}")).expect("save");
        }

        let names = backup_copies(&backups);
        assert!(
            names
                .iter()
                .all(|name| name.starts_with("magic-context.user.") && name.ends_with(".jsonc")),
            "copies: {names:?}"
        );
        let contents: Vec<String> = names
            .iter()
            .map(|name| std::fs::read_to_string(backups.join(name)).unwrap())
            .collect();
        assert_eq!(contents, vec!["v1", "v2", "w0", "w1", "w2"]);
    }

    /// If a different process holds the lock for longer than the wait, the
    /// save is refused.
    #[cfg(unix)]
    #[test]
    fn scope_lock_held_past_the_wait_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("config-backups");
        let _holder = hold_scope_lock(&backups, "user");

        let err = lock_backup_scope(&backups, "user", std::time::Duration::ZERO)
            .expect_err("a held lock must refuse");

        assert!(err.contains("cannot lock the backup folder"), "{err}");
        // A different backup set does not wait for this lock.
        assert!(
            lock_backup_scope(&backups, "project-0123456789ab", std::time::Duration::ZERO).is_ok()
        );
    }

    /// A symlink at the lock path refuses the save and does not touch the file
    /// that the link points at.
    #[cfg(unix)]
    #[test]
    fn symlinked_lock_file_refuses_the_save() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let (_env, backups) = isolated_data_home(dir.path());
        ensure_private_backup_directory(&backups).unwrap();
        let elsewhere = dir.path().join("elsewhere.txt");
        std::fs::write(&elsewhere, "keep").unwrap();
        symlink(&elsewhere, backups.join(".user.lock")).unwrap();
        let path = user_config_in(dir.path(), "v0");

        let err = write_config(&path, "v1").expect_err("symlinked lock must be refused");

        assert!(err.contains("cannot lock the backup folder"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v0");
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "keep");
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
