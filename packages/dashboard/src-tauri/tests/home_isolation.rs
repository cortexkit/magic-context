//! Integration tests must never read the stores of whoever runs them.
//!
//! The library's own test-only guards (`cfg!(test)`) are off for tests in
//! this folder, so each test runs in the throwaway home of
//! `support/isolated_home.rs`. These tests check that every test calls it
//! first, and that once it has, the store list names only that home.

#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use std::path::Path;

use magic_context_dashboard_lib::db;
use rusqlite::Connection;

#[test]
fn every_integration_test_starts_in_the_isolated_home() {
    isolated_home();
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut missing = Vec::new();
    let mut checked = 0;
    for entry in std::fs::read_dir(&folder).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let attribute = line.trim();
            if !(attribute == "#[test]" || attribute.starts_with("#[tokio::test")) {
                continue;
            }
            checked += 1;
            // The signature ends at the first line that opens the body; the
            // next statement must enter the throwaway home (it may keep the
            // returned path).
            let body = lines[index..]
                .iter()
                .position(|line| line.trim_end().ends_with('{'))
                .map(|offset| index + offset + 1);
            let first = body.and_then(|start| {
                lines[start..]
                    .iter()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim())
            });
            let enters_home = first.is_some_and(|statement| {
                statement == "isolated_home();"
                    || (statement.starts_with("let ") && statement.ends_with("= isolated_home();"))
            });
            if !enters_home {
                missing.push(format!(
                    "{}:{}",
                    path.file_name().unwrap().to_string_lossy(),
                    index + 1
                ));
            }
        }
    }
    assert!(checked > 0);
    assert!(
        missing.is_empty(),
        "tests that do not start with isolated_home(): {missing:?}"
    );
}

/// An OpenCode store with one session, as a real one would hold.
fn opencode_store(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT NOT NULL);
             CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
                 directory TEXT, time_updated INTEGER NOT NULL, time_archived INTEGER);
             INSERT INTO project VALUES ('p', 'decoy', '/decoy');
             INSERT INTO session VALUES ('ses-decoy', 'p', 'decoy', '/decoy', 1, NULL);",
        )
        .unwrap();
}

#[test]
fn the_store_list_never_names_a_folder_the_test_did_not_point_at() {
    let home = isolated_home();
    // A second folder laid out like a real home with every store the
    // dashboard looks for. Nothing points the dashboard at it.
    let decoy = tempfile::tempdir().unwrap();
    let share = decoy.path().join(".local").join("share");
    opencode_store(&share.join("opencode").join("opencode.db"));
    let runner = decoy.path().join("runner");
    opencode_store(&runner.join("opencode.db"));
    let roots = share
        .join("cortexkit")
        .join("thalamus-harness")
        .join("opencode-sessions")
        .join("roots.json");
    std::fs::create_dir_all(roots.parent().unwrap()).unwrap();
    std::fs::write(
        &roots,
        serde_json::json!({"version": 1, "roots": [{"path": runner, "sessions": []}]}).to_string(),
    )
    .unwrap();
    let config = decoy.path().join(".config").join("cortexkit");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("magic-context.jsonc"),
        serde_json::json!({"dashboard": {"opencode_db_paths": [runner]}}).to_string(),
    )
    .unwrap();

    let rows = db::opencode_store_rows();

    assert!(!rows.is_empty(), "the default store is always listed");
    for row in &rows {
        assert!(
            Path::new(&row.path).starts_with(home),
            "{} is outside the throwaway home {}",
            row.path,
            home.display()
        );
        assert!(!Path::new(&row.path).starts_with(decoy.path()), "{row:?}");
    }
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(!rows[0].found, "{rows:?}");
}
