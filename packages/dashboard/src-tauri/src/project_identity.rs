use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{OnceLock, RwLock};

static IDENTITY_CACHE: OnceLock<RwLock<HashMap<PathBuf, String>>> = OnceLock::new();

fn cache() -> &'static RwLock<HashMap<PathBuf, String>> {
    IDENTITY_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn resolve_project_identity(cwd: &str) -> String {
    let path = if cwd.trim().is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(cwd)
    };
    let canonical = canonicalize_lossy(&path);

    if let Ok(cache) = cache().read() {
        if let Some(identity) = cache.get(&canonical) {
            return identity.clone();
        }
    }

    let identity = root_commit_hash(&canonical)
        .map(|hash| format!("git:{hash}"))
        .unwrap_or_else(|| directory_fallback(&canonical));

    if let Ok(mut cache) = cache().write() {
        cache.insert(canonical, identity.clone());
    }
    identity
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

fn root_commit_hash(path: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("rev-list")
        .arg("--max-parents=0")
        .arg("HEAD")
        .current_dir(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next()?.trim();
    if first.len() >= 7 {
        Some(first.to_string())
    } else {
        None
    }
}

fn directory_fallback(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    format!("dir:{:x}", hasher.finalize())
}

pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
pub fn clear_cache_for_tests() {
    if let Ok(mut cache) = cache().write() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_current_repo_as_git_identity() {
        clear_cache_for_tests();
        let identity = resolve_project_identity(".");
        assert!(identity.starts_with("git:"), "{identity}");
        assert!(identity.len() > 11);
    }

    #[test]
    fn non_git_directory_uses_sha256_dir_identity() {
        clear_cache_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let identity = resolve_project_identity(dir.path().to_str().unwrap());
        assert!(identity.starts_with("dir:"), "{identity}");
        assert_eq!(identity.len(), 68);
    }
}
