//! Standalone hosts and ck-mc share one data directory, including test isolation.

use std::path::{Path, PathBuf};

use cortexkit_paths::{EnvSource, SystemEnv};

pub(crate) const MODULE_DIR: &str = "magic-context";
pub(crate) const CONTEXT_DB: &str = "context.db";
pub(crate) const SESSION_DB: &str = "mode3.db";

pub fn context_db_path() -> Result<PathBuf, String> {
    resolve_context_db_path(&SystemEnv, std::env::home_dir)
}

pub fn store_path(context_db: &Path) -> PathBuf {
    resolve_store_path(&SystemEnv, context_db)
}

fn resolve_store_path(env: &impl EnvSource, context_db: &Path) -> PathBuf {
    path_var(env, "MAGIC_CONTEXT_MODE3_STORE")
        .unwrap_or_else(|| context_db.with_file_name(SESSION_DB))
}

fn path_var(env: &impl EnvSource, name: &str) -> Option<PathBuf> {
    env.var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn trimmed_var(env: &impl EnvSource, name: &str) -> Option<String> {
    env.var_os(name)
        .and_then(|value| value.into_string().ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn resolve_context_db_path(
    env: &impl EnvSource,
    os_home: impl FnOnce() -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(explicit) = path_var(env, "MAGIC_CONTEXT_DB") {
        return Ok(explicit);
    }
    if let Some(test_data) = trimmed_var(env, "MAGIC_CONTEXT_TEST_DATA_DIR") {
        // A per-test XDG home wins over the shared test root, as it does in the host.
        let home = trimmed_var(env, "XDG_DATA_HOME").unwrap_or(test_data);
        return Ok(Path::new(&home)
            .join("cortexkit")
            .join(MODULE_DIR)
            .join(CONTEXT_DB));
    }
    if let Some(explicit) = trimmed_var(env, "MAGIC_CONTEXT_STORAGE_DIR") {
        return Ok(Path::new(&explicit).join(CONTEXT_DB));
    }

    let old = legacy_default_context_db_path(env, os_home);
    match cortexkit_paths::with_env(env).cortexkit_data_dir() {
        Ok(root) => {
            let path = root.join(MODULE_DIR).join(CONTEXT_DB);
            if old != path && !env.path_exists(&path) && env.path_exists(&old) {
                tracing::warn!(
                    "ck-mc: context.db exists at the previous path {}, but not at the resolved path {}; move the store or set MAGIC_CONTEXT_STORAGE_DIR to its directory",
                    old.display(),
                    path.display()
                );
            }
            Ok(path)
        }
        Err(error) => {
            let mut message = format!(
                "ck-mc: cannot resolve context.db ({error}); set MAGIC_CONTEXT_STORAGE_DIR to the store directory"
            );
            if env.path_exists(&old) {
                use std::fmt::Write as _;
                let _ = write!(message, "; previous store: {}", old.display());
                tracing::warn!("{message}");
            }
            Err(message)
        }
    }
}

/// The shared data root, if the environment identifies one. Store-specific
/// overrides do not move the rest of CortexKit's data.
pub(crate) fn cortexkit_data_root() -> Option<PathBuf> {
    cortexkit_paths::cortexkit_data_dir().ok()
}

/// Where this module looked for its store before it used the shared path
/// resolver. This path is only checked for a warning;
/// it must never select where ck-mc opens a store.
fn legacy_default_context_db_path(
    env: &impl EnvSource,
    os_home: impl FnOnce() -> Option<PathBuf>,
) -> PathBuf {
    let root = match trimmed_var(env, "XDG_DATA_HOME") {
        Some(data_home) => Path::new(&data_home).join("cortexkit"),
        None => {
            let home = path_var(env, "HOME");
            #[cfg(windows)]
            let home = path_var(env, "USERPROFILE").or(home);
            home.or_else(|| os_home().filter(|home| !home.as_os_str().is_empty()))
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local/share/cortexkit")
        }
    };
    root.join(MODULE_DIR).join(CONTEXT_DB)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[derive(Default)]
    struct TestEnv<'a> {
        vars: &'a [(&'a str, &'a str)],
        existing: &'a [&'a str],
    }

    impl EnvSource for TestEnv<'_> {
        fn var_os(&self, name: &str) -> Option<OsString> {
            self.vars
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).into())
        }

        fn path_exists(&self, path: &Path) -> bool {
            self.existing.iter().any(|item| Path::new(item) == path)
        }
    }

    #[cfg(unix)]
    #[test]
    fn normal_unix_storage_paths_match_the_previous_bytes() {
        const HOME: &str = "/home/fixture";
        const HOME_ROOT: &str = "/home/fixture/.local/share/cortexkit";
        const HOME_DB: &str = "/home/fixture/.local/share/cortexkit/magic-context/context.db";
        const XDG_ROOT: &str = "/xdg/cortexkit";
        const XDG_DB: &str = "/xdg/cortexkit/magic-context/context.db";
        struct Case<'a> {
            vars: &'a [(&'a str, &'a str)],
            root: &'a str,
            db: &'a str,
            store_override: Option<&'a str>,
        }
        let cases = [
            Case {
                vars: &[],
                root: HOME_ROOT,
                db: HOME_DB,
                store_override: None,
            },
            Case {
                vars: &[("XDG_DATA_HOME", "/xdg")],
                root: XDG_ROOT,
                db: XDG_DB,
                store_override: None,
            },
            Case {
                vars: &[
                    ("XDG_DATA_HOME", ""),
                    ("MAGIC_CONTEXT_DB", ""),
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", " "),
                    ("MAGIC_CONTEXT_STORAGE_DIR", ""),
                    ("MAGIC_CONTEXT_MODE3_STORE", ""),
                ],
                root: HOME_ROOT,
                db: HOME_DB,
                store_override: None,
            },
            Case {
                vars: &[
                    ("XDG_DATA_HOME", "/xdg"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", " explicit "),
                ],
                root: XDG_ROOT,
                db: "explicit/context.db",
                store_override: None,
            },
            Case {
                vars: &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", " test "),
                    ("MAGIC_CONTEXT_STORAGE_DIR", "explicit"),
                ],
                root: HOME_ROOT,
                db: "test/cortexkit/magic-context/context.db",
                store_override: None,
            },
            Case {
                vars: &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("XDG_DATA_HOME", "/xdg"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", "explicit"),
                ],
                root: XDG_ROOT,
                db: XDG_DB,
                store_override: None,
            },
            Case {
                vars: &[
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("XDG_DATA_HOME", " relative "),
                ],
                root: HOME_ROOT,
                db: "relative/cortexkit/magic-context/context.db",
                store_override: None,
            },
            Case {
                vars: &[
                    ("MAGIC_CONTEXT_DB", " selected.db "),
                    ("MAGIC_CONTEXT_TEST_DATA_DIR", "test"),
                    ("MAGIC_CONTEXT_STORAGE_DIR", "explicit"),
                    ("MAGIC_CONTEXT_MODE3_STORE", " selected-mode3.db "),
                ],
                root: HOME_ROOT,
                db: " selected.db ",
                store_override: Some(" selected-mode3.db "),
            },
        ];
        for Case {
            vars,
            root,
            db,
            store_override,
        } in cases
        {
            let vars = [("HOME", HOME)]
                .into_iter()
                .chain(vars.iter().copied())
                .collect::<Vec<_>>();
            let env = TestEnv {
                vars: &vars,
                existing: &[HOME_DB, XDG_DB],
            };
            let (actual, log) = crate::test_log::logged(|| resolve_context_db_path(&env, || None));
            let actual = actual.unwrap();
            assert_eq!(actual.as_os_str(), db, "{vars:?}");
            assert!(log.is_empty(), "{vars:?}: {log}");
            assert_eq!(
                cortexkit_paths::with_env(&env)
                    .cortexkit_data_dir()
                    .unwrap()
                    .as_os_str(),
                root,
                "{vars:?}"
            );
            let expected_store = store_override
                .map_or_else(|| Path::new(db).with_file_name("mode3.db"), PathBuf::from);
            assert_eq!(
                resolve_store_path(&env, &actual).as_os_str(),
                expected_store.as_os_str(),
                "{vars:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn context_path_warns_when_shared_resolution_leaves_an_old_store_behind() {
        const HOME_DB: &str = "/home/fixture/.local/share/cortexkit/magic-context/context.db";
        let cases = [
            (
                "/home/fixture",
                "relative",
                "relative/cortexkit/magic-context/context.db",
                Some(HOME_DB),
            ),
            (
                "/home/fixture",
                " /xdg ",
                "/xdg/cortexkit/magic-context/context.db",
                Some(HOME_DB),
            ),
            (
                "/home/fixture",
                "/xdg ",
                "/xdg/cortexkit/magic-context/context.db",
                Some("/xdg /cortexkit/magic-context/context.db"),
            ),
            ("", "", HOME_DB, None),
        ];
        for (home, xdg, old, resolved) in cases {
            let check = |existing: &[&str], warn| {
                let env = TestEnv {
                    vars: &[("HOME", home), ("XDG_DATA_HOME", xdg)],
                    existing,
                };
                let (result, log) = crate::test_log::logged(|| {
                    resolve_context_db_path(&env, || Some(PathBuf::from("/home/fixture")))
                });
                match resolved {
                    Some(path) => assert_eq!(result.unwrap().as_os_str(), path, "{xdg:?}"),
                    None => {
                        let error = result.unwrap_err();
                        assert!(
                            error.contains("could not resolve an absolute XDG_DATA_HOME"),
                            "{error}"
                        );
                        assert!(error.contains("MAGIC_CONTEXT_STORAGE_DIR"), "{error}");
                        assert_eq!(error.contains(old), warn, "{error}");
                    }
                }
                if warn {
                    assert_eq!(log.lines().count(), 1, "{xdg:?}: {log}");
                    assert!(
                        log.contains("WARN")
                            && log.contains(old)
                            && log.contains("MAGIC_CONTEXT_STORAGE_DIR"),
                        "{log}"
                    );
                    if let Some(path) = resolved {
                        assert!(
                            log.contains(path) && log.contains("move the store"),
                            "{log}"
                        );
                    }
                } else {
                    assert!(log.is_empty(), "{xdg:?}: {log}");
                }
            };
            check(&[], false);
            check(&[old][..], true);
            if let Some(new) = resolved {
                check(&[old, new][..], false);
            }
        }
    }

    #[test]
    fn explicit_store_directory_needs_no_user_home() {
        let env = TestEnv {
            vars: &[("HOME", ""), ("MAGIC_CONTEXT_STORAGE_DIR", " override ")],
            ..TestEnv::default()
        };
        let (result, log) = crate::test_log::logged(|| {
            resolve_context_db_path(&env, || {
                panic!("explicit override must skip the legacy lookup")
            })
        });
        assert_eq!(result.unwrap(), Path::new("override").join("context.db"));
        assert!(log.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_local_appdata_unless_only_the_roaming_root_exists() {
        let vars = [
            ("USERPROFILE", r"C:\profile"),
            ("LOCALAPPDATA", r"C:\local"),
            ("APPDATA", r"C:\roaming"),
        ];
        for (existing, expected) in [
            (&[][..], r"C:\local\cortexkit\magic-context\context.db"),
            (
                &[r"C:\roaming\cortexkit"][..],
                r"C:\roaming\cortexkit\magic-context\context.db",
            ),
            (
                &[r"C:\roaming\cortexkit", r"C:\local\cortexkit"][..],
                r"C:\local\cortexkit\magic-context\context.db",
            ),
        ] {
            let env = TestEnv {
                vars: &vars,
                existing,
            };
            assert_eq!(
                resolve_context_db_path(&env, || None).unwrap().as_os_str(),
                expected
            );
        }
    }
}
