//! The offline CLI must work with only mode3.db and reject legacy openers.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::path::Path;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::{Child, Stdio};
use std::process::{Command, Output};

use cortexkit_role_compaction::read::SessionRef;
use mc_module::store::{Durable, Store};

#[cfg(target_os = "linux")]
#[path = "support/rekey_proc.rs"]
mod rekey_proc;

// The non-dumpable helper affects every sibling test's process scan. Keep its
// lifetime separate from CLI tests that expect the store to be idle.
static CLI_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ck-mc"));
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root)
        .env("XDG_DATA_HOME", root)
        .env("XDG_CONFIG_HOME", root)
        .env("MAGIC_CONTEXT_DB", root.join("must-not-open-context.db"))
        .env("MAGIC_CONTEXT_MODE3_STORE", root.join("mode3.db"))
        .arg("rekey-runner");
    #[cfg(target_os = "linux")]
    for pid in rekey_proc::unrelated_unreadable_pids() {
        command.arg("--ignore-pid").arg(pid.to_string());
    }
    command
}

fn run(root: &Path, extra: &[&str]) -> Output {
    command(root)
        .args([
            "--from",
            "old",
            "--to",
            "new",
            "--harness",
            "pi",
            "--session",
            "s",
        ])
        .args(extra)
        .output()
        .unwrap()
}

fn fixture(root: &Path) {
    let store = Store::open(&root.join("mode3.db")).unwrap();
    store
        .save(&SessionRef::new("old", "pi", "s"), &Durable::default())
        .unwrap();
}

/// A move journal beside the context database naming session `pi/s`.
fn journal(root: &Path, entry: serde_json::Value) {
    let folder = root.join("agent-data");
    std::fs::create_dir_all(&folder).unwrap();
    let mut entry = entry;
    entry["runner"] = "old".into();
    entry["harness"] = "pi".into();
    entry["session"] = "s".into();
    std::fs::write(
        folder.join("journal.json"),
        serde_json::to_vec(&serde_json::json!({
            "format": "mc-agent-data-journal/1",
            "sessions": [entry],
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn rekey_cli_refuses_a_session_a_move_holds_with_its_code_and_cut() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    for (entry, expected) in [
        (
            serde_json::json!({"moving": {"cut": "cut-1", "state": "frozen"}}),
            "session_moving: cut cut-1",
        ),
        (
            serde_json::json!({"released": {"cut": "cut-2", "holder": "mac-b"}}),
            "session_moved: cut cut-2",
        ),
    ] {
        journal(root.path(), entry);
        for dry in [true, false] {
            let output = run(root.path(), if dry { &["--dry-run"] } else { &[] });
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(!output.status.success(), "{stderr}");
            assert!(stderr.contains(expected), "{stderr}");
            assert!(output.stdout.is_empty());
        }
    }
    let store = Store::open(&root.path().join("mode3.db")).unwrap();
    assert!(store.load(&SessionRef::new("old", "pi", "s")).is_some());
    assert!(store.load(&SessionRef::new("new", "pi", "s")).is_none());
    assert!(!root.path().join("must-not-open-context.db").exists());
}

#[test]
fn rekey_cli_dry_run_and_write_need_no_context_database() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    for dry in [true, false] {
        let output = run(root.path(), if dry { &["--dry-run"] } else { &[] });
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let summary: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(summary["sessions_rekeyed"], 1);
        assert_eq!(summary["rows_per_table"]["sessions"], 1);
        assert_eq!(summary["dry_run"], dry);
        assert!(!root.path().join("must-not-open-context.db").exists());
        let store = Store::open(&root.path().join("mode3.db")).unwrap();
        assert_eq!(
            store.load(&SessionRef::new("old", "pi", "s")).is_some(),
            dry
        );
        assert_eq!(
            store.load(&SessionRef::new("new", "pi", "s")).is_some(),
            !dry
        );
    }
}

#[test]
fn rekey_cli_help_says_stop_ck_mc_and_never_opens_a_store() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let output = command(root.path()).arg("--help").output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("ck-mc must be stopped"));
    assert!(!root.path().join("mode3.db").exists());
}

#[test]
#[cfg(target_os = "macos")]
fn rekey_cli_fails_closed_without_lsof() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let output = command(root.path())
        .env("PATH", root.path())
        .args([
            "--from",
            "old",
            "--to",
            "new",
            "--harness",
            "pi",
            "--session",
            "s",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("process_check_failed"));
    let store = Store::open(&root.path().join("mode3.db")).unwrap();
    assert!(store.load(&SessionRef::new("old", "pi", "s")).is_some());
    assert!(store.load(&SessionRef::new("new", "pi", "s")).is_none());
}

#[test]
#[cfg(target_os = "linux")]
fn rekey_cli_linux_checks_proc_without_lsof() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let output = command(root.path())
        .env("PATH", root.path())
        .args([
            "--from",
            "old",
            "--to",
            "new",
            "--harness",
            "pi",
            "--session",
            "s",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct Holder(Child);

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn helper(root: &Path, name: &str) -> Holder {
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--ignored", "--nocapture"])
        .env_clear()
        .env("HOME", root)
        .env("REKEY_TEST_STORE", root.join("mode3.db"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut holder = Holder(child);
    let mut reader = BufReader::new(holder.0.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "helper exited before readiness"
        );
        if line.contains("helper-ready") {
            return holder;
        }
    }
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rekey_cli_refuses_another_process_with_an_open_store() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let holder = helper(root.path(), "rekey_legacy_holder");
    let output = run(root.path(), &[]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("store_in_use"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    #[cfg(target_os = "linux")]
    {
        let output = run(root.path(), &["--ignore-pid", &holder.0.id().to_string()]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("store_in_use"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    drop(holder);
    let output = run(root.path(), &[]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "subprocess helper; opens only the test parent's temporary store"]
fn rekey_legacy_holder() {
    let path = std::env::var_os("REKEY_TEST_STORE").expect("test store path");
    let _file = std::fs::File::open(path).unwrap();
    println!("helper-ready");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
}

#[test]
#[cfg(target_os = "linux")]
fn rekey_cli_unreadable_process_requires_explicit_ignore_pid() {
    let _guard = CLI_TEST_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let unreadable = helper(root.path(), "rekey_nondumpable_helper");
    let pid = unreadable.0.id();
    match rekey_proc::unreadable_same_user(pid) {
        Some(true) => {
            let output = run(root.path(), &["--dry-run"]);
            assert!(!output.status.success());
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(error.contains("store_check_incomplete:"), "{error}");
            assert!(error.contains(&format!("pid={pid}")), "{error}");
            assert!(
                error.contains("comm=") && error.contains("cmdline="),
                "{error}"
            );
            let holder = helper(root.path(), "rekey_legacy_holder");
            for extra in [vec![], vec!["--ignore-pid".to_owned(), pid.to_string()]] {
                let args: Vec<_> = extra.iter().map(String::as_str).collect();
                let output = run(root.path(), &args);
                assert!(!output.status.success());
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains("store_in_use"),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            drop(holder);
        }
        None => {
            // Some sandbox procfs mounts hide non-dumpable processes entirely.
            // The synthetic procfs unit tests cover permission-denied errors on those hosts.
            eprintln!("non-dumpable pid {pid} is hidden by procfs; native EACCES case unavailable");
            let output = run(root.path(), &["--dry-run"]);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Some(false) => panic!("non-dumpable helper {pid} remains inspectable"),
    }
    let output = run(root.path(), &["--ignore-pid", &pid.to_string()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let store = Store::open(&root.path().join("mode3.db")).unwrap();
    assert!(store.load(&SessionRef::new("old", "pi", "s")).is_none());
    assert!(store.load(&SessionRef::new("new", "pi", "s")).is_some());
}

#[test]
#[cfg(target_os = "linux")]
#[ignore = "subprocess helper; makes only itself non-dumpable and opens no store"]
fn rekey_nondumpable_helper() {
    // PR_SET_DUMPABLE changes only this helper's ptrace visibility.
    assert_eq!(
        unsafe { nix::libc::prctl(nix::libc::PR_SET_DUMPABLE, 0, 0, 0, 0) },
        0
    );
    println!("helper-ready");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
}
