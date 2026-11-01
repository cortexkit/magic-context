use mc_store::git_archive::{fts, index};

use index::{GitCommit, GitLogFailure, GitLogRunner, IndexOptions, ReadOptions};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tempfile::TempDir;

const NOW: i64 = 1_800_000_000_123;
const DAY: i64 = 86_400_000;

struct Fixture {
    temp: TempDir,
    rust: Connection,
    project: String,
}

impl Fixture {
    fn new(name: &str, initialize_git: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("repo")).unwrap();
        let rust = Connection::open_in_memory().unwrap();
        rust.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        fts::initialize_schema(&rust).unwrap();
        let fixture = Self {
            temp,
            rust,
            project: format!("git:fixture:{name}"),
        };
        if initialize_git {
            fixture.git(&["init", "-q", "-b", "main"], None);
            fixture.git(&["config", "user.name", "Fixture"], None);
            fixture.git(&["config", "user.email", "fixture@example.com"], None);
            fixture.git(&["config", "core.hooksPath", "/dev/null"], None);
        }
        fixture
    }

    fn directory(&self) -> std::path::PathBuf {
        self.temp.path().join("repo")
    }

    fn git(&self, args: &[&str], at: Option<i64>) -> String {
        let mut command = Command::new("git");
        command.args(args).current_dir(self.directory());
        // Fixture creation ignores host hooks, identities and injected Git configuration.
        for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GIT_")) {
            command.env_remove(key);
        }
        command
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("LC_ALL", "C")
            .env("LANG", "C");
        if let Some(at) = at {
            let stamp = format!("@{} +0000", at / 1000);
            command
                .env("GIT_AUTHOR_DATE", &stamp)
                .env("GIT_COMMITTER_DATE", stamp);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn commit(&self, file: &str, message: &str, at: i64) -> String {
        std::fs::write(self.directory().join(file), message).unwrap();
        std::fs::write(self.temp.path().join("message"), message).unwrap();
        self.git(&["add", "--", file], None);
        self.git(
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--cleanup=verbatim",
                "-F",
                self.temp.path().join("message").to_str().unwrap(),
            ],
            Some(at),
        );
        self.git(&["rev-parse", "HEAD"], None)
    }

    fn oracle(&self, operation: &str, mut extra: Value) -> Value {
        let mut request = json!({
            "operation": operation,
            "database": self.temp.path().join("typescript.sqlite"),
            "directory": self.directory(),
            "project": self.project,
            "nowMs": NOW,
            "maxCommits": 100,
            "sinceDays": 30,
        });
        for (key, value) in extra.as_object_mut().unwrap() {
            request[key] = value.take();
        }
        let mut child = Command::new("bun")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/git_archive/oracle.ts"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Bun is required to compare against the actual TypeScript producer");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "TypeScript oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        let line = text
            .lines()
            .find_map(|line| line.strip_prefix("MC_GIT_ORACLE="))
            .unwrap_or_else(|| panic!("oracle missing JSON: {text}"));
        serde_json::from_str(line).unwrap()
    }

    fn assert_snapshot(&self, oracle: &Value) {
        let snapshot = snapshot(&self.rust);
        for key in ["rows", "fts", "terms"] {
            assert_eq!(
                snapshot[key], oracle[key],
                "{key} differs from the TypeScript producer"
            );
        }
    }

    fn sweep(&mut self, max_commits: i64, since_days: i64) -> index::IndexResult {
        let oracle = self.oracle(
            "index",
            json!({"maxCommits": max_commits, "sinceDays": since_days}),
        );
        let result = index::index_project_at(
            &mut self.rust,
            &self.project,
            &self.temp.path().join("repo"),
            &IndexOptions {
                since_days: since_days as f64,
                max_commits: max_commits as f64,
            },
            NOW,
        )
        .unwrap();
        // Bun's native run() may count deferred FTS writes as an unchanged update.
        // Compare every other diagnostic and the durable data, then assert Rust's
        // changed-row counts explicitly in the behavior tests below.
        let actual = serde_json::to_value(&result).unwrap();
        for key in ["scanned", "inserted", "evicted", "embedded", "nonIndexable"] {
            assert_eq!(actual[key], oracle["result"][key], "{key} differs");
        }
        self.assert_snapshot(&oracle);
        result
    }

    fn upsert(&mut self, commits: &[GitCommit], now_ms: i64) -> index::UpsertResult {
        let oracle = self.oracle("upsert", json!({"commits": commits, "nowMs": now_ms}));
        let result =
            index::upsert_commits_at(&mut self.rust, &self.project, commits, now_ms).unwrap();
        assert_eq!(json!(result.inserted), oracle["result"]["inserted"]);
        self.assert_snapshot(&oracle);
        result
    }

    fn messages(&self) -> Vec<String> {
        self.rust
            .prepare("SELECT message FROM git_commits ORDER BY message")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
}

fn snapshot(db: &Connection) -> Value {
    let rows: Vec<Value> = db
        .prepare("SELECT * FROM git_commits ORDER BY sha")
        .unwrap()
        .query_map([], |row| {
            Ok(json!({
                "sha": row.get::<_, String>("sha")?,
                "project_path": row.get::<_, String>("project_path")?,
                "short_sha": row.get::<_, String>("short_sha")?,
                "message": row.get::<_, String>("message")?,
                "author": row.get::<_, Option<String>>("author")?,
                "committed_at": row.get::<_, i64>("committed_at")?,
                "indexed_at": row.get::<_, i64>("indexed_at")?,
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let fts: Vec<Value> = db
        .prepare("SELECT sha, project_path, message FROM git_commits_fts ORDER BY sha")
        .unwrap()
        .query_map([], |row| {
            Ok(json!({
                "sha": row.get::<_, String>(0)?,
                "project_path": row.get::<_, String>(1)?,
                "message": row.get::<_, String>(2)?,
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    db.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS temp.git_archive_vocab USING fts5vocab(main, git_commits_fts, 'row')").unwrap();
    let terms: Vec<Value> = db.prepare("SELECT term, doc, cnt FROM temp.git_archive_vocab ORDER BY term").unwrap()
        .query_map([], |row| Ok(json!({
            "term": row.get::<_, String>(0)?, "doc": row.get::<_, i64>(1)?, "cnt": row.get::<_, i64>(2)?,
        }))).unwrap().map(Result::unwrap).collect();
    json!({"rows": rows, "fts": fts, "terms": terms})
}

fn record(sha_character: char, message: &str, at: i64) -> GitCommit {
    GitCommit {
        sha: sha_character.to_string().repeat(40),
        short_sha: sha_character.to_string().repeat(7),
        message: message.into(),
        author: Some("fixture@example.com".into()),
        committed_at_ms: at,
    }
}

#[test]
fn merge_history_reachable_sha_matches_typescript() {
    let mut fixture = Fixture::new("merge", true);
    fixture.commit("base", "base commit", NOW - 5 * DAY);
    fixture.git(&["checkout", "-q", "-b", "feature"], None);
    fixture.commit("feature", "older branch running repair", NOW - 2 * DAY);
    fixture.git(&["checkout", "-q", "main"], None);
    fixture.commit("main", "main tip", NOW - DAY);
    assert_eq!(fixture.sweep(100, 30).inserted, 2);
    assert_eq!(fixture.messages(), ["base commit", "main tip"]);
    fixture.git(
        &[
            "-c",
            "commit.gpgsign=false",
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "merge omitted",
            "feature",
        ],
        Some(NOW),
    );
    let result = fixture.sweep(100, 30);
    assert_eq!((result.scanned, result.inserted, result.updated), (1, 1, 0));
    assert_eq!(
        fixture.messages(),
        ["base commit", "main tip", "older branch running repair"]
    );
    assert_eq!(fixture.sweep(100, 30).inserted, 0);
    fixture.commit("next", "next incremental", NOW + 1000);
    assert_eq!(fixture.sweep(100, 30).inserted, 1);
}

#[test]
fn rewritten_history_retains_rows_and_missing_tip_falls_back() {
    let mut fixture = Fixture::new("rewrite", true);
    fixture.commit("base", "base", NOW - 5 * DAY);
    let old_sha = fixture.commit("tip", "original tip", NOW - DAY);
    fixture.sweep(100, 30);
    // An older-dated amendment leaves the removed original as the newest indexed row.
    fixture.git(
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--amend",
            "-m",
            "amended tip",
        ],
        Some(NOW - 2 * DAY),
    );
    assert_eq!(fixture.sweep(100, 30).inserted, 1);
    assert!(fixture.messages().contains(&"original tip".into()));
    fixture.git(&["reflog", "expire", "--expire=now", "--all"], None);
    fixture.git(&["gc", "--prune=now"], None);
    assert_eq!(
        index::latest_indexed_sha(&fixture.rust, &fixture.project).unwrap(),
        Some(old_sha)
    );
    let result = fixture.sweep(100, 30);
    assert_eq!((result.scanned, result.inserted, result.updated), (2, 0, 0));
    assert_eq!(fixture.messages(), ["amended tip", "base", "original tip"]);
}

#[test]
fn empty_and_non_git_repositories_report_structural_failures() {
    for (name, initialize_git, failure) in [
        ("empty", true, GitLogFailure::NoHead),
        ("non-git", false, GitLogFailure::NotARepo),
    ] {
        let mut fixture = Fixture::new(name, initialize_git);
        let oracle = fixture.oracle("read", json!({}));
        let read = index::read_git_commits(&fixture.directory(), &ReadOptions::default()).unwrap();
        assert_eq!(read.failure, Some(failure));
        assert_eq!(serde_json::to_value(read).unwrap(), oracle["result"]);
        fixture.upsert(
            &[
                record('a', "retained a", NOW - DAY),
                record('b', "retained b", NOW - DAY),
            ],
            NOW,
        );
        let result = fixture.sweep(1, 30);
        assert!(result.non_indexable);
        assert_eq!(result.evicted, 0);
        assert_eq!(fixture.messages().len(), 2);
    }
}

#[test]
fn history_caps_and_empty_sweep_eviction_match_typescript() {
    let mut fixture = Fixture::new("caps", true);
    for number in 0..24 {
        fixture.commit(
            "sequence",
            &format!("commit {number:02}"),
            NOW - DAY + number * 1000,
        );
    }
    let first = fixture.sweep(7, 30);
    assert_eq!((first.scanned, first.inserted), (7, 7));
    assert_eq!(
        fixture.messages(),
        (17..24)
            .map(|number| format!("commit {number:02}"))
            .collect::<Vec<_>>()
    );
    let smaller = fixture.sweep(3, 30);
    assert_eq!((smaller.scanned, smaller.evicted), (0, 4));
    assert_eq!(fixture.messages(), ["commit 21", "commit 22", "commit 23"]);
    let disabled = fixture.sweep(0, 30);
    assert_eq!((disabled.scanned, disabled.evicted), (0, 0));
    fixture.commit("sequence", "newest after cap", NOW);
    let incremental = fixture.sweep(2, 30);
    assert_eq!(
        (
            incremental.scanned,
            incremental.inserted,
            incremental.evicted
        ),
        (1, 1, 2)
    );
    assert_eq!(fixture.messages(), ["commit 23", "newest after cap"]);
}

#[test]
fn cap_sha_ties_project_isolation_and_embedding_cascade() {
    let mut fixture = Fixture::new("tie-cap", false);
    fixture.upsert(
        &[
            record('a', "alpha", NOW),
            record('b', "beta", NOW),
            record('c', "gamma", NOW),
        ],
        NOW,
    );
    let original = fixture.project.clone();
    fixture.project = "dir:other-opaque-identity".into();
    fixture.upsert(&[record('d', "other project", NOW - DAY)], NOW);
    fixture.project = original;
    fixture
        .rust
        .execute(
            "INSERT INTO git_commit_embeddings VALUES (?, X'00000000', 'fixture-model', ?)",
            params!["a".repeat(40), NOW],
        )
        .unwrap();
    let oracle = fixture.oracle("cap", json!({"maxCommits": 2}));
    let evicted = index::enforce_project_cap(&fixture.rust, &fixture.project, 2.0).unwrap();
    assert_eq!(json!(evicted), oracle["result"]);
    fixture.assert_snapshot(&oracle);
    assert_eq!(fixture.messages(), ["beta", "gamma", "other project"]);
    assert_eq!(
        fixture
            .rust
            .query_row("SELECT count(*) FROM git_commit_embeddings", [], |row| {
                row.get::<_, usize>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        index::latest_indexed_sha(&fixture.rust, &fixture.project).unwrap(),
        Some("c".repeat(40))
    );
    assert_eq!(
        index::enforce_project_cap(&fixture.rust, &fixture.project, -1.0).unwrap(),
        0
    );
}

#[test]
fn long_messages_body_separators_and_fts_tokens_match_typescript() {
    let mut fixture = Fixture::new("long", true);
    fixture.git(&["config", "user.email", ""], None);
    let message = format!(
        "Running café repairs\n\n  {}\x1finner separator\n\n",
        "🦀 running café\n".repeat(3000)
    );
    fixture.commit("HEAD", &message, NOW - DAY);
    assert_eq!(fixture.sweep(100, 30).inserted, 1);
    let messages = fixture.messages();
    assert!(
        messages[0].len() > 40_000,
        "messages must not acquire an invented truncation cap"
    );
    assert!(messages[0].contains("\x1finner separator"));
    assert!(fixture
        .rust
        .query_row("SELECT author IS NULL FROM git_commits", [], |row| row
            .get::<_, bool>(0))
        .unwrap());
    assert_eq!(
        fixture
            .rust
            .query_row(
                "SELECT count(*) FROM git_commits_fts WHERE git_commits_fts MATCH 'run'",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        fixture
            .rust
            .query_row(
                "SELECT count(*) FROM git_commits_fts WHERE git_commits_fts MATCH 'fixture'",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn date_window_and_explicit_branch_match_typescript() {
    let mut fixture = Fixture::new("dates", true);
    fixture.commit("old", "outside window", NOW - 40 * DAY);
    fixture.commit("inside", "inside window", NOW - 2 * DAY);
    fixture.git(&["checkout", "-q", "-b", "other"], None);
    fixture.commit("other", "not on HEAD main", NOW - DAY);
    fixture.git(&["checkout", "-q", "main"], None);
    assert_eq!(fixture.sweep(100, 30).inserted, 1);
    assert_eq!(fixture.messages(), ["inside window"]);
    let oracle = fixture.oracle(
        "read",
        json!({"options": {"branch": "other", "sinceMs": NOW - 30 * DAY, "maxCommits": 1}}),
    );
    let read = index::read_git_commits(
        &fixture.directory(),
        &ReadOptions {
            branch: "other".into(),
            since_ms: Some(NOW - 30 * DAY),
            max_commits: 1.0,
            ..ReadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), oracle["result"]);
    assert_eq!(read.commits[0].message, "not on HEAD main");
}

#[test]
fn sha256_repository_matches_typescript() {
    let mut fixture = Fixture::new("sha256", false);
    fixture.git(
        &["init", "-q", "-b", "main", "--object-format=sha256"],
        None,
    );
    fixture.git(&["config", "user.name", "Fixture"], None);
    fixture.git(&["config", "user.email", "fixture@example.com"], None);
    let sha = fixture.commit("sha256", "full sha256 object", NOW - DAY);
    assert_eq!(sha.len(), 64);
    assert_eq!(fixture.sweep(100, 30).inserted, 1);
    let oracle = fixture.oracle("read", json!({"options": {"excludeReachableFrom": sha}}));
    let read = index::read_git_commits(
        &fixture.directory(),
        &ReadOptions {
            exclude_reachable_from: Some(sha),
            ..ReadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(serde_json::to_value(read).unwrap(), oracle["result"]);
}

#[test]
fn unchanged_rows_changed_messages_and_global_sha_identity_match_typescript() {
    let mut fixture = Fixture::new("upsert", false);
    let mut commit = record('a', "original running message", NOW - DAY);
    assert_eq!(
        fixture
            .upsert(&[commit.clone(), commit.clone()], NOW)
            .inserted,
        1
    );
    commit.author = None;
    commit.committed_at_ms = NOW;
    assert_eq!(
        fixture.upsert(&[commit.clone()], NOW + 1000),
        index::UpsertResult::default()
    );
    assert_eq!(
        fixture
            .rust
            .query_row("SELECT committed_at FROM git_commits", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        NOW - DAY
    );
    commit.message = "changed jumping message".into();
    assert_eq!(fixture.upsert(&[commit.clone()], NOW + 2000).updated, 1);
    fixture.project = "dir:alias-identity".into();
    assert_eq!(
        fixture.upsert(&[commit.clone()], NOW + 3000),
        index::UpsertResult::default()
    );
    commit.message = "moving identity with changed message".into();
    // The plugin producer counts a moved SHA as inserted because its counters track
    // existing SHAs in the destination project, not all projects.
    assert_eq!(fixture.upsert(&[commit], NOW + 4000).inserted, 1);
    assert_eq!(
        fixture
            .rust
            .query_row("SELECT project_path FROM git_commits", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        fixture.project
    );
}

#[test]
fn failed_batch_rolls_back_rows_and_fts_like_typescript() {
    let mut fixture = Fixture::new("rollback", false);
    let sql = "CREATE TRIGGER reject_second BEFORE INSERT ON git_commits WHEN NEW.message = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture rejects row'); END;";
    fixture.rust.execute_batch(sql).unwrap();
    let commits = [record('a', "would insert", NOW), record('b', "reject", NOW)];
    let oracle = fixture.oracle("upsert", json!({"commits": commits, "sql": sql}));
    assert_eq!(oracle["result"], json!({"failed": true}));
    assert!(index::upsert_commits_at(&mut fixture.rust, &fixture.project, &commits, NOW).is_err());
    fixture.assert_snapshot(&oracle);
    assert!(fixture.messages().is_empty());
    fixture
        .rust
        .execute_batch("DROP TRIGGER reject_second")
        .unwrap();
    let oracle = fixture.oracle(
        "upsert",
        json!({"commits": commits, "sql": "DROP TRIGGER reject_second"}),
    );
    assert_eq!(
        index::upsert_commits_at(&mut fixture.rust, &fixture.project, &commits, NOW)
            .unwrap()
            .inserted,
        2
    );
    fixture.assert_snapshot(&oracle);
}

#[test]
fn failed_eviction_rolls_back_the_entire_sweep_and_releases_guard() {
    let mut fixture = Fixture::new("eviction-rollback", true);
    fixture.commit("first", "first", NOW - 2 * DAY);
    fixture.sweep(100, 30);
    let before = snapshot(&fixture.rust);
    fixture.commit("second", "second", NOW - DAY);
    fixture.rust.execute_batch("CREATE TRIGGER reject_eviction BEFORE DELETE ON git_commits BEGIN SELECT RAISE(ABORT, 'fixture rejects eviction'); END;").unwrap();
    let directory = fixture.directory();
    assert!(index::index_project_at(
        &mut fixture.rust,
        &fixture.project,
        &directory,
        &IndexOptions {
            max_commits: 1.0,
            since_days: 30.0
        },
        NOW
    )
    .is_err());
    assert_eq!(snapshot(&fixture.rust), before);
    fixture
        .rust
        .execute_batch("DROP TRIGGER reject_eviction")
        .unwrap();
    let result = fixture.sweep(1, 30);
    assert_eq!((result.inserted, result.evicted), (1, 1));
    assert_eq!(fixture.messages(), ["second"]);
}

#[test]
fn parser_contract_matches_typescript_without_truncation() {
    let fixture = Fixture::new("parser", false);
    let cases: Vec<String> =
        serde_json::from_str(include_str!("../testdata/git_archive/parser-cases.json")).unwrap();
    for raw in cases {
        let oracle = fixture.oracle("parse", json!({"raw": raw}));
        assert_eq!(
            serde_json::to_value(index::parse_git_log_output(&raw)).unwrap(),
            oracle["result"]
        );
    }
}

struct RecordingRunner {
    calls: Mutex<Vec<Vec<String>>>,
    responses: Mutex<Vec<Result<String, String>>>,
}

impl GitLogRunner for RecordingRunner {
    fn run(&self, _: &Path, args: &[String]) -> Result<String, String> {
        self.calls.lock().unwrap().push(args.into());
        self.responses.lock().unwrap().remove(0)
    }
}

#[test]
fn reader_arguments_timeout_classification_and_fallback_are_bounded() {
    assert_eq!(index::GIT_TIMEOUT, std::time::Duration::from_secs(10));
    assert_eq!(index::GIT_MAX_BUFFER, 32 * 1024 * 1024);
    let runner = RecordingRunner {
        calls: Mutex::new(Vec::new()),
        responses: Mutex::new(vec![Err("fatal: bad object".into()), Ok(String::new())]),
    };
    let read = index::read_git_commits_with_runner(
        Path::new("unused"),
        &ReadOptions {
            since_ms: Some(1_709_251_199_123),
            exclude_reachable_from: Some("a".repeat(40)),
            ..ReadOptions::default()
        },
        &runner,
    )
    .unwrap();
    assert_eq!(read.failure, None);
    let calls = runner.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0],
        vec![
            "log".into(),
            "HEAD".into(),
            format!("^{}", "a".repeat(40)),
            "--no-merges".into(),
            "--max-count=5000".into(),
            "--format=%H\x1f%s\x1f%ae\x1f%ct\x1f%b\x1e".into(),
            "--since=2024-02-29T23:59:59.123Z".into(),
            "--".into()
        ]
    );
    assert!(!calls[1].iter().any(|arg| arg.starts_with('^')));
    drop(calls);
    for (error, failure) in [
        ("git log timed out", GitLogFailure::Transient),
        ("git output exceeded maxBuffer", GitLogFailure::Transient),
        ("not a git repository", GitLogFailure::NotARepo),
        ("bad revision HEAD", GitLogFailure::NoHead),
    ] {
        let runner = RecordingRunner {
            calls: Mutex::default(),
            responses: Mutex::new(vec![Err(error.into())]),
        };
        let read = index::read_git_commits_with_runner(
            Path::new("unused"),
            &ReadOptions {
                exclude_reachable_from: Some("--injected".into()),
                ..ReadOptions::default()
            },
            &runner,
        )
        .unwrap();
        assert_eq!(read.failure, Some(failure));
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        assert!(!runner.calls.lock().unwrap()[0]
            .iter()
            .any(|arg| arg.starts_with('^')));
    }
    let oracle_fixture = Fixture::new("argument-guard", false);
    let oracle = oracle_fixture.oracle("read", json!({"options": {"branch": "--all"}}));
    assert_eq!(oracle["result"], json!({"failed": true}));
    assert!(index::read_git_commits(
        &oracle_fixture.directory(),
        &ReadOptions {
            branch: "--all".into(),
            ..ReadOptions::default()
        }
    )
    .is_err());
}

#[test]
fn production_entry_point_reports_non_git_without_touching_rows() {
    let mut fixture = Fixture::new("clock", false);
    let directory = fixture.directory();
    let result = index::index_project(
        &mut fixture.rust,
        &fixture.project,
        &directory,
        &IndexOptions {
            since_days: 30.0,
            max_commits: 100.0,
        },
    )
    .unwrap();
    assert!(result.non_indexable);
    assert!(fixture.messages().is_empty());
}

#[test]
fn fractional_configuration_matches_typescript() {
    let mut fixture = Fixture::new("fractional", true);
    fixture.commit("old", "outside fractional window", NOW - 15 * DAY / 2);
    fixture.commit("new", "inside fractional window", NOW - 7 * DAY);
    let oracle = fixture.oracle("index", json!({"sinceDays": 7.25, "maxCommits": 100}));
    let directory = fixture.directory();
    let result = index::index_project_at(
        &mut fixture.rust,
        &fixture.project,
        &directory,
        &IndexOptions {
            since_days: 7.25,
            max_commits: 100.0,
        },
        NOW,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap(), oracle["result"]);
    fixture.assert_snapshot(&oracle);
    assert_eq!(fixture.messages(), ["inside fractional window"]);
    let oracle = fixture.oracle("read", json!({"options": {"maxCommits": 1.5}}));
    let read = index::read_git_commits(
        &directory,
        &ReadOptions {
            max_commits: 1.5,
            ..ReadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(read.failure, Some(GitLogFailure::Transient));
    assert_eq!(serde_json::to_value(read).unwrap(), oracle["result"]);
    let oracle = fixture.oracle("index", json!({"sinceDays": 7.25, "maxCommits": 100.5}));
    let result = index::index_project_at(
        &mut fixture.rust,
        &fixture.project,
        &directory,
        &IndexOptions {
            since_days: 7.25,
            max_commits: 100.5,
        },
        NOW,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), oracle["result"]);
    fixture.assert_snapshot(&oracle);

    let mut overflow = Fixture::new("fractional-cap", false);
    let commits: Vec<_> = (0..102)
        .map(|number| {
            let sha = format!("f{number:039x}");
            GitCommit {
                short_sha: sha[..7].into(),
                sha,
                ..record('f', "same timestamp", NOW)
            }
        })
        .collect();
    overflow.upsert(&commits, NOW);
    let before = snapshot(&overflow.rust);
    let oracle = overflow.oracle("cap", json!({"maxCommits": 100.5}));
    // The plugin config accepts fractions, but SQLite rejects a fractional OFFSET
    // when eviction is actually needed. Preserve that error instead of rounding.
    assert_eq!(oracle["result"], json!({"failed": true}));
    assert!(index::enforce_project_cap(&overflow.rust, &overflow.project, 100.5).is_err());
    overflow.assert_snapshot(&oracle);
    assert_eq!(snapshot(&overflow.rust), before);
}
