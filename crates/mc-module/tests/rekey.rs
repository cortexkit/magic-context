//! The offline CLI must work with only mode3.db and reject legacy openers.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

use cortexkit_role_compaction::read::SessionRef;
use mc_module::store::{Durable, Store};

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

#[test]
fn rekey_cli_dry_run_and_write_need_no_context_database() {
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

struct Holder(Child);

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rekey_cli_refuses_another_process_with_an_open_store() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "rekey_legacy_holder", "--ignored", "--nocapture"])
        .env_clear()
        .env("HOME", root.path())
        .env("REKEY_TEST_STORE", root.path().join("mode3.db"))
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
            "holder exited before opening its file"
        );
        if line.contains("store-open") {
            break;
        }
    }
    let output = run(root.path(), &[]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("store_in_use"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
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
    println!("store-open");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
}
