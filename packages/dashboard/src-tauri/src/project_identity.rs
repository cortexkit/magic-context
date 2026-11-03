use std::path::{Component, Path, PathBuf};

/// Lexically resolve `input` against `cwd`, matching Node's `path.resolve` semantics.
///
/// This intentionally does not touch the filesystem: no symlink resolution, no
/// existence checks, and no `std::fs::canonicalize`. The dashboard MSRV is 1.77,
/// so this also avoids `std::path::absolute` (stabilized in 1.79).
pub fn logical_absolute(input: &Path, cwd: &Path) -> PathBuf {
    let mut base = if input.is_absolute() {
        PathBuf::new()
    } else {
        cwd.to_path_buf()
    };

    for component in input.components() {
        match component {
            Component::Prefix(prefix) => {
                base = PathBuf::from(prefix.as_os_str());
            }
            Component::RootDir => {
                // Reset to root while preserving a Windows drive/UNC prefix when present.
                let prefix = base.components().find_map(|component| match component {
                    Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
                    _ => None,
                });
                base = match prefix {
                    Some(prefix) => {
                        let mut path = PathBuf::from(prefix);
                        path.push("/");
                        path
                    }
                    None => PathBuf::from("/"),
                };
            }
            Component::CurDir => {}
            Component::ParentDir => {
                // Match Node path.resolve("/..") === "/": only pop a normal path segment.
                let last = base.components().next_back();
                if matches!(last, Some(Component::Normal(_))) {
                    base.pop();
                }
            }
            Component::Normal(segment) => {
                base.push(segment);
            }
        }
    }

    base
}

fn directory_fallback(path: &Path) -> String {
    let digest = md5::compute(path.to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("dir:{}", &hex[..12])
}

/// Normalize a value read from `memories.project_path` / related stored identity columns.
///
/// Stored DB values may already be identities (`git:*`, `dir:*`, `pj-*`). Those must be returned
/// unchanged; hashing the identity text as a filesystem path would produce a wrong project
/// key. Legacy raw paths degrade to the deterministic directory fallback so the dashboard
/// never probes git while reading historical rows.
pub fn normalize_stored_project_path(raw_or_stored: &str) -> String {
    if is_project_identity(raw_or_stored) {
        return raw_or_stored.to_string();
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let canonical = logical_absolute(Path::new(raw_or_stored), &cwd);
    directory_fallback(&canonical)
}

pub fn is_project_identity(value: &str) -> bool {
    value.starts_with("git:") || value.starts_with("dir:") || value.starts_with("pj-")
}

pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected_dir_identity(path: &Path) -> String {
        let digest = md5::compute(path.to_string_lossy().as_bytes());
        let hex = format!("{digest:x}");
        format!("dir:{}", &hex[..12])
    }

    #[test]
    fn normalize_stored_project_path_preserves_identity_values() {
        assert_eq!(normalize_stored_project_path("git:abc123"), "git:abc123");
        assert_eq!(
            normalize_stored_project_path("dir:deadbeef0000"),
            "dir:deadbeef0000"
        );
        for value in ["pj-dashboard-editor", "pj-A_B-0123456789"] {
            assert_eq!(
                normalize_stored_project_path(value).as_bytes(),
                value.as_bytes()
            );
        }
    }

    #[test]
    fn identity_vs_path_classification_accepts_pj() {
        assert!(is_project_identity("pj-dashboard-editor"));
        assert!(is_project_identity("git:abc123"));
        assert!(is_project_identity("dir:deadbeef0000"));
        assert!(!is_project_identity("/tmp/pj-dashboard-editor"));
    }

    #[test]
    fn normalize_stored_project_path_hashes_raw_paths_without_git() {
        let dir = tempfile::tempdir().unwrap();
        let identity = normalize_stored_project_path(dir.path().to_str().unwrap());
        assert_eq!(identity, expected_dir_identity(dir.path()));
    }

    #[test]
    fn relative_raw_paths_are_resolved_logically_before_hashing() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = logical_absolute(Path::new("relative/project"), &cwd);
        assert_eq!(
            normalize_stored_project_path("relative/project"),
            expected_dir_identity(&resolved)
        );
    }

    #[test]
    fn basename_uses_last_path_component_when_present() {
        assert_eq!(basename("/tmp/example"), "example");
        assert_eq!(basename("/"), "/");
    }
}
