//! Offline tag queries use disposable stores and never start the module.

use mc_module::context_db::ContextDb;
use rusqlite::params;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const USAGE: &str = "Usage: ck-mc tag-floor --harness <harness> --session <session id>";

fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ck-mc"));
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root.join("home"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .arg("tag-floor");
    command
}

fn fixture(root: &Path) -> PathBuf {
    let path = root.join("data/cortexkit/magic-context/context.db");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let db = ContextDb::create_for_tests(&path).unwrap();
    db.with_connection(|conn| {
        for (harness, session, number) in [
            ("opencode", "s1", 2),
            ("opencode", "s1", 42),
            ("opencode", "s1", 17),
            ("opencode", "other", 900),
            ("pi", "s1", 800),
        ] {
            conn.execute(
                "INSERT INTO tags (harness, session_id, message_id, type, tag_number, byte_size)
                 VALUES (?1, ?2, ?3, 'text', ?4, 10)",
                params![harness, session, format!("m{number}"), number],
            )
            .unwrap();
        }
    });
    path
}

fn answer(output: Output) -> Value {
    assert!(output.status.success(), "{:?}", output);
    assert!(output.stderr.is_empty(), "{:?}", output);
    serde_json::from_slice(&output.stdout).unwrap()
}

fn run(root: &Path, harness: &str, session: &str) -> Output {
    command(root)
        .args(["--harness", harness, "--session", session])
        .output()
        .unwrap()
}

#[test]
fn tag_floor_reports_the_scoped_maximum_and_count() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let output = run(root.path(), "opencode", "s1");
    println!(
        "fixture stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        answer(output),
        json!({"harness": "opencode", "session": "s1", "tag_floor": 42, "tags": 3})
    );
}

#[test]
fn tag_floor_returns_zeros_without_tags() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    for (harness, session) in [("opencode", "empty"), ("unknown", "s1")] {
        assert_eq!(
            answer(run(root.path(), harness, session)),
            json!({"harness": harness, "session": session, "tag_floor": 0, "tags": 0})
        );
    }
}

#[test]
fn tag_floor_leaves_database_bytes_and_modification_time_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let path = fixture(root.path());
    // A rollback journal makes an accidental writable startup observable in
    // the file header, even when no session rows would need changing.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode = DELETE;").unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let entries = || {
        let mut names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before_entries = entries();
    assert_eq!(answer(run(root.path(), "opencode", "s1"))["tag_floor"], 42);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(entries(), before_entries);
    for name in ["home", "config", "state", "cache"] {
        assert!(!root.path().join(name).exists(), "created {name}");
    }
}

#[test]
fn tag_floor_uses_the_explicit_context_path_without_opening_mode3() {
    let root = tempfile::tempdir().unwrap();
    let path = fixture(root.path());
    let explicit = root.path().join("explicit.db");
    std::fs::rename(path, &explicit).unwrap();
    let mode3 = root.path().join("mode3.db");
    std::fs::write(&mode3, b"not a database").unwrap();
    let output = command(root.path())
        .env("MAGIC_CONTEXT_DB", explicit)
        .env("MAGIC_CONTEXT_MODE3_STORE", &mode3)
        .args(["--session", "s1", "--harness", "opencode"])
        .output()
        .unwrap();
    assert_eq!(answer(output)["tag_floor"], 42);
    assert_eq!(std::fs::read(mode3).unwrap(), b"not a database");
}

#[test]
fn tag_floor_reads_a_session_held_by_a_move() {
    let root = tempfile::tempdir().unwrap();
    let path = fixture(root.path());
    let agent_data = path.parent().unwrap().join("agent-data");
    std::fs::create_dir(&agent_data).unwrap();
    std::fs::write(
        agent_data.join("journal.json"),
        json!({
            "format": "mc-agent-data-journal/1",
            "sessions": [{
                "runner": "runner", "harness": "opencode", "session": "s1",
                "moving": {"cut": "cut", "state": "staged"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(answer(run(root.path(), "opencode", "s1"))["tag_floor"], 42);
}

#[test]
fn tag_floor_refuses_a_missing_database_without_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let output = run(root.path(), "opencode", "s1");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Magic Context has no context.db."),
        "{:?}",
        output
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn tag_floor_bad_arguments_exit_two_with_usage() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec![],
        vec!["--harness", "opencode"],
        vec!["--session", "s1"],
        vec!["--harness", "opencode", "--session"],
        vec!["--harness", "--session", "s1"],
        vec!["--harness", "", "--session", "s1"],
        vec!["--harness", "opencode", "--session", ""],
        vec!["--harness", "opencode", "--session", "s1", "--unknown"],
        vec!["--harness", "opencode", "--session", "s1", "--version"],
        vec!["--harness", "opencode", "--session", "s1", "--print-fences"],
        vec!["--harness", "opencode", "--session", "s1", "extra"],
        vec![
            "--harness",
            "opencode",
            "--harness",
            "pi",
            "--session",
            "s1",
        ],
        vec![
            "--harness",
            "opencode",
            "--session",
            "s1",
            "--session",
            "s2",
        ],
    ] {
        let output = command(root.path()).args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(USAGE),
            "{args:?}: {output:?}"
        );
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn tag_floor_help_needs_no_database() {
    let root = tempfile::tempdir().unwrap();
    for help in ["--help", "-h"] {
        let output = command(root.path()).arg(help).output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{USAGE}\n")
        );
        assert!(output.stderr.is_empty());
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn move_in_checkpoint_matches_tag_floor_without_a_request_floor() {
    use cortexkit_role_compaction::read::{Cursor, SessionRef};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;
    use mc_module::move_in::{move_in, MoveRequest};
    use mc_module::pass::Settings;
    use mc_module::store::Store;

    let root = tempfile::tempdir().unwrap();
    let path = fixture(root.path());
    let floor = answer(run(root.path(), "opencode", "s1"))["tag_floor"]
        .as_u64()
        .unwrap();
    let db = ContextDb::open(&path).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments (harness, session_id, sequence, start_message, end_message,
                start_message_id, end_message_id, title, content, p1, created_at)
             VALUES ('opencode', 's1', 1, 1, 3, 'm1', 'm3', 'Summary', 'history', 'history', 1);",
        )
        .unwrap();
    });
    let request = MoveRequest {
        session: SessionRef::new("runner", "opencode", "s1"),
        preset: "head".into(),
        project: None,
        model: ModelRef::new("test", "model"),
        context_window: 100_000,
        output_reserve: 1000,
        rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
        newest: Cursor::new(3, "m3", "d"),
        now: 1,
        messages: None,
        source_harness: None,
        source_session: None,
        source_runner_entries: false,
        tag_floor: None,
        before_newest: Some("m2".into()),
    };
    let moved = move_in(
        db,
        &Store::open(&root.path().join("mode3.db")).unwrap(),
        &Settings::default().into(),
        &request,
    )
    .unwrap();
    assert_eq!(moved.tag_checkpoint, floor);
    assert_eq!(moved.tag_checkpoint, 42);
}
