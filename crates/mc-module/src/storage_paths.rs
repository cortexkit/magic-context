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
    } else {
        resolve_cortexkit_data_root(&env, home).join("magic-context")
    };
    storage_dir.join("context.db")
}

/// The folder CortexKit's tools keep their data under on this machine,
/// resolved from the process environment ([`resolve_cortexkit_data_root`]).
pub(crate) fn cortexkit_data_root() -> PathBuf {
    resolve_cortexkit_data_root(|name| std::env::var(name), user_home_dir())
}

/// The CortexKit data root: `$XDG_DATA_HOME/cortexkit` when `XDG_DATA_HOME`
/// is set and not blank, otherwise `<home>/.local/share/cortexkit`. Magic
/// Context's own store lives in its `magic-context` folder
/// ([`resolve_context_db_path`]), and agents keep their task checkouts and
/// working copies elsewhere below it.
fn resolve_cortexkit_data_root(
    env: impl Fn(&str) -> Result<String, std::env::VarError>,
    home: Option<PathBuf>,
) -> PathBuf {
    match env("XDG_DATA_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(data_home) => Path::new(&data_home).join("cortexkit"),
        None => home
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local/share/cortexkit"),
    }
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

    #[test]
    fn the_data_root_is_under_xdg_data_home_when_set_and_the_home_folder_otherwise() {
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[], "home/.local/share/cortexkit"),
            (&[("XDG_DATA_HOME", "xdg")], "xdg/cortexkit"),
            (&[("XDG_DATA_HOME", " xdg ")], "xdg/cortexkit"),
            (&[("XDG_DATA_HOME", "  ")], "home/.local/share/cortexkit"),
            // The store's own overrides move the store, not the data root.
            (
                &[("MAGIC_CONTEXT_STORAGE_DIR", "explicit")],
                "home/.local/share/cortexkit",
            ),
        ];
        for (vars, expected) in cases {
            let env = |name: &str| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
                    .ok_or(std::env::VarError::NotPresent)
            };
            let root = resolve_cortexkit_data_root(env, Some(PathBuf::from("home")));
            assert_eq!(root, PathBuf::from(expected), "{vars:?}");
            // Without the store's own overrides, the store is in the root.
            if !vars.iter().any(|(key, _)| key.starts_with("MAGIC_CONTEXT")) {
                assert_eq!(
                    resolve_context_db_path(env, Some(PathBuf::from("home"))),
                    root.join("magic-context/context.db")
                );
            }
        }
    }
}
