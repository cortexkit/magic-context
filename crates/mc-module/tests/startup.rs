//! Production startup uses only the disposable homes provided by these tests.

use std::path::Path;
use std::process::{Command, Output};

fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ck-mc"));
    for name in [
        "MAGIC_CONTEXT_DB",
        "MAGIC_CONTEXT_MODE3_STORE",
        "MAGIC_CONTEXT_TEST_DATA_DIR",
        "MAGIC_CONTEXT_STORAGE_DIR",
        "SUBC_MODULE_ID",
        "SUBC_LAUNCH_NONCE",
        "SUBC_LAUNCH_NONCE_FD",
    ] {
        command.env_remove(name);
    }
    command
        .env("HOME", root.join("home"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_CACHE_HOME", root.join("cache"));
    command
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn probes_need_no_connection_and_create_no_files() {
    let root = tempfile::tempdir().unwrap();
    for probe in ["--version", "--print-fences"] {
        let output = command(root.path()).arg(probe).output().unwrap();
        assert!(output.status.success(), "{}", stderr(&output));
        let line = String::from_utf8(output.stdout).unwrap();
        if probe == "--version" {
            assert_eq!(line, format!("{}\n", mc_module::version_line()));
        } else {
            assert_eq!(
                line,
                format!(
                    "context.db={} mode3.db={}\n",
                    mc_module::context_db::SCHEMA_VERSION,
                    mc_module::store::SCHEMA_VERSION
                )
            );
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[test]
fn startup_and_move_in_refuse_a_missing_context_db() {
    let root = tempfile::tempdir().unwrap();
    for args in [vec!["--subc", "missing-connection.json"], vec!["move-in"]] {
        let output = command(root.path()).args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(stderr(&output).contains("Magic Context has no context.db. Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc."), "{}", stderr(&output));
        assert!(!root
            .path()
            .join("data/cortexkit/magic-context/context.db")
            .exists());
        assert!(!root
            .path()
            .join("data/cortexkit/magic-context/mode3.db")
            .exists());
    }
}

#[test]
fn startup_opens_default_stores_writes_catalog_and_leaves_rollback_store_alone() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data/cortexkit/magic-context");
    std::fs::create_dir_all(&data).unwrap();
    drop(mc_module::context_db::ContextDb::create_for_tests(&data.join("context.db")).unwrap());
    std::fs::write(data.join("store.db"), b"rollback bytes").unwrap();
    // The missing connection ends startup after stores and the descriptor are ready.
    let output = command(root.path())
        .args(["--subc", "missing-connection.json"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(data.join("mode3.db").exists(), "{}", stderr(&output));
    assert_eq!(
        std::fs::read(data.join("store.db")).unwrap(),
        b"rollback bytes"
    );
    assert_eq!(
        std::fs::read(data.join("engram-catalog.json")).unwrap(),
        mc_module::engram_catalog::catalog_bytes()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(data.join("mode3.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    fn has_log(path: &Path) -> bool {
        std::fs::read_dir(path).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                if entry.path().is_dir() {
                    has_log(&entry.path())
                } else {
                    std::fs::read_to_string(entry.path())
                        .is_ok_and(|text| text.contains("logger initialized"))
                }
            })
        })
    }
    assert!(
        has_log(root.path()),
        "logger must write startup events inside the isolated root"
    );
}

#[test]
fn explicit_paths_are_shared_by_startup_and_move_in() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("explicit");
    std::fs::create_dir(&data).unwrap();
    let context = data.join("override.db");
    drop(mc_module::context_db::ContextDb::create_for_tests(&context).unwrap());
    for args in [vec!["--subc", "missing-connection.json"], vec!["move-in"]] {
        let output = command(root.path())
            .env("MAGIC_CONTEXT_DB", &context)
            .env("MAGIC_CONTEXT_MODE3_STORE", data.join("override-mode3.db"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            data.join("override-mode3.db").exists(),
            "{}",
            stderr(&output)
        );
        assert!(!root
            .path()
            .join("data/cortexkit/magic-context/context.db")
            .exists());
        assert!(!root
            .path()
            .join("data/cortexkit/magic-context/mode3.db")
            .exists());
    }
}

#[test]
fn move_in_refuses_a_session_a_move_holds_with_its_code_and_cut() {
    use std::io::Write;
    use std::process::Stdio;

    use cortexkit_role_compaction::read::{Cursor, SessionRef};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;

    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data/cortexkit/magic-context");
    std::fs::create_dir_all(data.join("agent-data")).unwrap();
    drop(mc_module::context_db::ContextDb::create_for_tests(&data.join("context.db")).unwrap());
    let target = SessionRef::new("mock-runner", "opencode2", "s1");
    let request = serde_json::json!({
        "session": target,
        "preset": "head",
        "project": null,
        "model": ModelRef::new("test", "model"),
        "context_window": 100_000,
        "output_reserve": 1000,
        "rules": ProviderRules::new(SignedParts::None, EditCost::Suffix),
        "newest": Cursor::new(1, "m1", "d"),
        "now": 1,
        // The plugin kept the session under OpenCode 1's harness.
        "source_harness": "opencode",
    });
    // Held under the runner's harness, then under the plugin's.
    for (harness, entry, expected) in [
        (
            "opencode2",
            serde_json::json!({"released": {"cut": "cut-r", "holder": "mac-b"}}),
            "session_moved: cut cut-r",
        ),
        (
            "opencode",
            serde_json::json!({"moving": {"cut": "cut-m", "state": "staged"}}),
            "session_moving: cut cut-m",
        ),
    ] {
        let mut entry = entry;
        entry["runner"] = "another-runner".into();
        entry["harness"] = harness.into();
        entry["session"] = "s1".into();
        std::fs::write(
            data.join("agent-data/journal.json"),
            serde_json::to_vec(&serde_json::json!({
                "format": "mc-agent-data-journal/1",
                "sessions": [entry],
            }))
            .unwrap(),
        )
        .unwrap();
        let mut child = command(root.path())
            .arg("move-in")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&request).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success(), "{}", stderr(&output));
        assert!(stderr(&output).contains(expected), "{}", stderr(&output));
        assert!(output.stdout.is_empty());
        let store = mc_module::store::Store::open(&data.join("mode3.db")).unwrap();
        assert!(store.load(&target).is_none());
    }
}
