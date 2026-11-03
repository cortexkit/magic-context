//! Standalone hosts and ck-mc share one data directory, including test isolation.

use std::path::{Path, PathBuf};

pub fn context_db_path() -> PathBuf {
    std::env::var_os("MAGIC_CONTEXT_DB")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_context_db_path(|name| std::env::var(name), user_home_dir()))
}

pub fn store_path(context_db: &Path) -> PathBuf {
    std::env::var_os("MAGIC_CONTEXT_MODE3_STORE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| context_db.with_file_name("mode3.db"))
}

fn user_home_dir() -> Option<PathBuf> {
    let non_empty = |name| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    #[cfg(windows)]
    if let Some(profile) = non_empty("USERPROFILE") {
        return Some(profile);
    }
    non_empty("HOME").or_else(|| std::env::home_dir().filter(|home| !home.as_os_str().is_empty()))
}

fn resolve_context_db_path(
    env: impl Fn(&str) -> Result<String, std::env::VarError>,
    home: Option<PathBuf>,
) -> PathBuf {
    let non_empty = |name| {
        env(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let under_data_home = |home: &str| Path::new(home).join("cortexkit/magic-context");
    let storage_dir = if let Some(test_data) = non_empty("MAGIC_CONTEXT_TEST_DATA_DIR") {
        // A per-test XDG home wins over the shared test root, as it does in the host.
        under_data_home(&non_empty("XDG_DATA_HOME").unwrap_or(test_data))
    } else if let Some(explicit) = non_empty("MAGIC_CONTEXT_STORAGE_DIR") {
        PathBuf::from(explicit)
    } else if let Some(data_home) = non_empty("XDG_DATA_HOME") {
        under_data_home(&data_home)
    } else {
        home.unwrap_or_else(|| PathBuf::from("."))
            .join(".local/share/cortexkit/magic-context")
    };
    storage_dir.join("context.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_path_matches_the_standalone_hosts_precedence() {
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[], "home/.local/share/cortexkit/magic-context/context.db"),
            (
                &[("XDG_DATA_HOME", "xdg")],
                "xdg/cortexkit/magic-context/context.db",
            ),
            (
                &[
                    ("XDG_DATA_HOME", "xdg"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", " explicit "),
                ],
                "explicit/context.db",
            ),
            (
                &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", "explicit"),
                ],
                "test/cortexkit/magic-context/context.db",
            ),
            (
                &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("XDG_DATA_HOME", "xdg"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", "explicit"),
                ],
                "xdg/cortexkit/magic-context/context.db",
            ),
            (
                &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("XDG_DATA_HOME", "test"),
                ],
                "test/cortexkit/magic-context/context.db",
            ),
            (
                &[("XDG_DATA_HOME", "  "), ("MAGIC_CONTEXT_STORAGE_DIR", "")],
                "home/.local/share/cortexkit/magic-context/context.db",
            ),
        ];
        for (vars, expected) in cases {
            let actual = resolve_context_db_path(
                |name| {
                    vars.iter()
                        .find(|(key, _)| *key == name)
                        .map(|(_, value)| value.to_string())
                        .ok_or(std::env::VarError::NotPresent)
                },
                Some(PathBuf::from("home")),
            );
            assert_eq!(actual, PathBuf::from(expected), "{vars:?}");
        }
    }
}
