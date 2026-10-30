use std::path::{Path, PathBuf};
use std::process::Command;

pub fn configure_daemon_cargo(command: &mut Command) {
    set_daemon_cargo_home(command, std::env::var_os("MC_TEST_DAEMON_CARGO_HOME"));
}

fn set_daemon_cargo_home(command: &mut Command, home: Option<std::ffi::OsString>) {
    if let Some(home) = home {
        command.env("CARGO_HOME", home);
    }
}

pub fn root(workspace: &Path) -> PathBuf {
    std::env::var_os("MC_TEST_SUBCONSCIOUS_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .parent()
                .expect("workspace has a parent")
                .join("subconscious")
        })
}

pub fn available(workspace: &Path) -> bool {
    if std::env::var_os("MC_TEST_LOCKED_SUBC_SOURCE").is_some()
        || std::env::var_os("MC_TEST_CK_SUBC_BIN").is_some()
    {
        return true;
    }
    available_at(
        &root(workspace),
        std::env::var_os("MC_TEST_SUBCONSCIOUS_SOURCE").is_some(),
    )
}

fn available_at(sibling: &Path, required: bool) -> bool {
    if sibling.join("Cargo.toml").is_file() {
        true
    } else {
        assert!(
            !required,
            "MC_TEST_SUBCONSCIOUS_SOURCE requires a checkout at {}",
            sibling.display()
        );
        eprintln!(
            "SKIP real-daemon test: sibling subconscious checkout is missing at {}",
            sibling.display()
        );
        false
    }
}

#[test]
fn missing_checkout_skips_but_a_present_checkout_runs() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("magic-context");
    std::fs::create_dir(&workspace).unwrap();
    let sibling = root.path().join("subconscious");
    assert!(!available_at(&sibling, false));
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("Cargo.toml"), "[workspace]\n").unwrap();
    assert!(available_at(&sibling, false));
    assert!(available_at(&sibling, true));
}

#[test]
#[should_panic(expected = "MC_TEST_SUBCONSCIOUS_SOURCE requires a checkout")]
fn explicitly_required_missing_checkout_fails() {
    let root = tempfile::tempdir().unwrap();
    available_at(&root.path().join("missing"), true);
}

#[test]
fn daemon_cargo_home_applies_only_to_the_child_command() {
    let inherited = std::env::var_os("CARGO_HOME");
    let mut daemon = Command::new("cargo");
    set_daemon_cargo_home(&mut daemon, Some("job-local-daemon-cache".into()));
    let selected = daemon.get_envs().find(|(name, _)| *name == "CARGO_HOME");
    assert_eq!(
        selected.unwrap().1,
        Some(std::ffi::OsStr::new("job-local-daemon-cache"))
    );
    let mut module = Command::new("cargo");
    set_daemon_cargo_home(&mut module, None);
    assert_eq!(module.get_envs().count(), 0);
    assert_eq!(std::env::var_os("CARGO_HOME"), inherited);
}

#[test]
fn daemon_cargo_home_follows_the_explicit_override() {
    let expected = std::env::var_os("MC_TEST_DAEMON_CARGO_HOME");
    let mut command = Command::new("cargo");
    configure_daemon_cargo(&mut command);
    let actual = command
        .get_envs()
        .find(|(name, _)| *name == "CARGO_HOME")
        .and_then(|(_, value)| value);
    assert_eq!(actual, expected.as_deref());
}
