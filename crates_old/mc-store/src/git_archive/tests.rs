use super::*;
use flate2::read::GzDecoder;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

const NOW: i64 = 1_800_000_000_123;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    project: String,
    head: String,
    now_ms: i64,
    max_commits: f64,
    since_days: f64,
    rows: Vec<Value>,
    result: Value,
}

#[derive(Deserialize)]
struct Embedding {
    sha: String,
    vector: Vec<f32>,
    model: String,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    query: String,
    project: String,
    options: SearchOptions,
    expected: SearchResults,
}

#[derive(Deserialize)]
struct Sanitizer {
    input: String,
    expected: String,
}

#[derive(Deserialize)]
struct Fixture {
    revision: String,
    steps: Vec<Step>,
    embeddings: Vec<Embedding>,
    cases: Vec<Case>,
    sanitizers: Vec<Sanitizer>,
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let mut text = String::new();
        GzDecoder::new(&include_bytes!("fixtures/search.json.gz")[..])
            .read_to_string(&mut text)
            .unwrap();
        serde_json::from_str(&text).unwrap()
    })
}

fn connection() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    fts::initialize_schema(&db).unwrap();
    db
}

fn add_embeddings(db: &Connection) {
    for entry in &fixture().embeddings {
        let bytes: Vec<u8> = entry.vector.iter().flat_map(|n| n.to_le_bytes()).collect();
        db.execute(
            "INSERT INTO git_commit_embeddings VALUES (?, ?, ?, ?)",
            params![entry.sha, bytes, entry.model, NOW],
        )
        .unwrap();
    }
}

fn seeded() -> Connection {
    replay_history()
}

fn assert_case(db: &Connection, case: &Case) {
    let before: (i64, i64) = db
        .query_row(
            "SELECT total_changes(), schema_version FROM pragma_schema_version",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let actual = search_with_lanes(db, &case.project, &case.query, &case.options).unwrap();
    for (lane, actual, expected) in [
        ("hits", &actual.hits, &case.expected.hits),
        ("fts", &actual.fts, &case.expected.fts),
        ("vector", &actual.vector, &case.expected.vector),
    ] {
        assert_eq!(
            actual.len(),
            expected.len(),
            "{} {lane} hit count",
            case.name
        );
        for (position, (actual, expected)) in actual.iter().zip(expected).enumerate() {
            assert_eq!(
                actual.commit, expected.commit,
                "{} {lane}[{position}] metadata/order",
                case.name
            );
            assert_eq!(
                actual.match_type, expected.match_type,
                "{} {lane}[{position}] match type",
                case.name
            );
            assert!(
                (actual.score - expected.score).abs() < 1e-14,
                "{} {lane}[{position}] score {} != {}",
                case.name,
                actual.score,
                expected.score
            );
        }
    }
    let after = db
        .query_row(
            "SELECT total_changes(), schema_version FROM pragma_schema_version",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, after, "search must not write rows or schema");
}

fn cases_named(db: &Connection, names: &[&str]) {
    for name in names {
        let case = fixture()
            .cases
            .iter()
            .find(|case| case.name == *name)
            .unwrap();
        assert_case(db, case);
    }
}

fn git(directory: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    command.current_dir(directory).args(args);
    for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GIT_")) {
        command.env_remove(key);
    }
    let output = command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn search_differential_pinned_typescript_history() {
    let fixture = fixture();
    assert_eq!(fixture.revision, "282d9c08bce490346583a3b8c145c402499f980f");
    assert!(fixture.cases.len() >= 30);
    let db = seeded();
    // query_only also rejects accidental writes that leave row counts unchanged.
    db.execute_batch("PRAGMA query_only = ON").unwrap();
    for case in &fixture.cases {
        assert_case(&db, case);
    }
}

fn replay_history() -> Connection {
    // The producer excludes concurrent sweeps of the same project identity even
    // on different connections; fixtures share identities but not databases.
    static REPLAY: Mutex<()> = Mutex::new(());
    let _guard = REPLAY.lock().unwrap();
    let fixture = fixture();
    let temp = tempfile::tempdir().unwrap();
    let bundle = temp.path().join("history.bundle");
    std::fs::write(&bundle, include_bytes!("fixtures/history.bundle")).unwrap();
    git(
        temp.path(),
        &["clone", "-q", bundle.to_str().unwrap(), "repo"],
    );
    let repo = temp.path().join("repo");
    let mut db = connection();
    for step in &fixture.steps {
        git(&repo, &["reset", "--hard", &step.head]);
        let result = index::index_project_at(
            &mut db,
            &step.project,
            &repo,
            &index::IndexOptions {
                since_days: step.since_days,
                max_commits: step.max_commits,
            },
            step.now_ms,
        )
        .unwrap();
        let result = serde_json::to_value(result).unwrap();
        for key in ["scanned", "inserted", "evicted", "embedded", "nonIndexable"] {
            assert_eq!(result[key], step.result[key], "sweep {} {key}", step.head);
        }
        let rows: Vec<Value> = db.prepare("SELECT * FROM git_commits ORDER BY sha").unwrap()
            .query_map([], |row| Ok(json!({
                "sha": row.get::<_, String>(0)?, "project_path": row.get::<_, String>(1)?,
                "short_sha": row.get::<_, String>(2)?, "message": row.get::<_, String>(3)?,
                "author": row.get::<_, Option<String>>(4)?, "committed_at": row.get::<_, i64>(5)?,
                "indexed_at": row.get::<_, i64>(6)?,
            }))).unwrap().map(Result::unwrap).collect();
        assert_eq!(rows, step.rows, "indexed rows for sweep {}", step.head);
    }
    add_embeddings(&db);
    db
}

#[test]
fn search_project_scope_matches_pinned_typescript() {
    cases_named(
        &seeded(),
        &[
            "bound-project",
            "other-project",
            "missing-project",
            "hybrid:no-such-token",
        ],
    );
}

#[test]
fn search_date_bounds_match_pinned_typescript() {
    cases_named(
        &seeded(),
        &[
            "date-inclusive-point",
            "date-from",
            "date-to",
            "date-inverted",
            "fallback-date",
            "hybrid-date",
        ],
    );
}

#[test]
fn search_ranking_matches_pinned_typescript() {
    cases_named(
        &seeded(),
        &[
            "lexical:\"repair\"",
            "limit-1",
            "limit-50",
            "hybrid:repair",
            "hybrid-weights",
        ],
    );
}

#[test]
fn search_quoting_matches_pinned_typescript() {
    let db = seeded();
    for case in &fixture().sanitizers {
        assert_eq!(
            fts::sanitize_fts_query(&case.input),
            case.expected,
            "sanitizer input {:?}",
            case.input
        );
    }
    cases_named(
        &db,
        &[
            "lexical:\"repair OR NOT\"",
            "lexical:\"src/git-archive/search.rs\"",
        ],
    );
}

#[test]
fn search_trait_projects_ranked_records_and_refuses_scope_mismatch() {
    let store = SqliteGitArchive::new(seeded(), ProjectId("git:search-fixture".into()));
    let mut query = ArchiveQuery {
        scope: StoreScope {
            project: ProjectId("git:search-fixture".into()),
            session: SessionId("fixture".into()),
            generation: Generation(3),
        },
        query: "repair".into(),
        limit: 10,
        start_at_ms: None,
        end_at_ms_inclusive: None,
        cutoff: None,
    };
    let expected = fixture()
        .cases
        .iter()
        .find(|case| case.name == "lexical:\"repair\"")
        .unwrap();
    assert_eq!(store.availability(), Availability::Available);
    let CapabilityResult::Available { value: hits } = store.search(&query) else {
        panic!("search unavailable")
    };
    assert_eq!(hits.len(), expected.expected.hits.len());
    for (actual, expected) in hits.iter().zip(&expected.expected.hits) {
        assert_eq!(actual.sha, expected.commit.sha);
        assert_eq!(actual.message, expected.commit.message);
        assert_eq!(actual.committed_at_ms, expected.commit.committed_at_ms);
        assert_eq!(actual.provenance.generation, query.scope.generation);
        assert_eq!(
            actual.provenance.observed_at_ms,
            expected.commit.indexed_at_ms
        );
        assert_eq!(actual.provenance.source_id, actual.sha);
        assert_eq!(actual.provenance.source_revision, actual.sha);
        assert_eq!(
            actual.provenance.content_hash.0,
            format!("{:x}", Sha256::digest(actual.message.as_bytes()))
        );
        assert!(actual.parents.is_empty());
    }
    query.scope.project = ProjectId("dir:foreign-project".into());
    let CapabilityResult::Unavailable { reason } = store.search(&query) else {
        panic!("accepted wrong scope")
    };
    assert_eq!(reason.code, "project_mismatch");
    assert!(matches!(
        UNAVAILABLE.search(&query),
        CapabilityResult::Unavailable { .. }
    ));
    let missing = SqliteGitArchive::new(
        Connection::open_in_memory().unwrap(),
        query.scope.project.clone(),
    );
    let CapabilityResult::Unavailable { reason } = missing.search(&query) else {
        panic!("missing schema is not empty success")
    };
    assert_eq!(reason.code, "git_archive_search_failed");
}

#[test]
fn search_like_fallback_handles_missing_fts_and_literal_wildcards() {
    let db = seeded();
    db.execute_batch("DROP TABLE git_commits_fts").unwrap();
    let hits = search(&db, "git:search-fixture", "100%", &SearchOptions::default()).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].commit.message.contains("100%"));
    assert_eq!(hits[0].score, 0.8);
    let options = SearchOptions {
        from: Some(NOW),
        ..SearchOptions::default()
    };
    assert!(search(&db, "git:search-fixture", "100%", &options)
        .unwrap()
        .is_empty());
}

#[test]
fn search_vectors_read_current_transaction_and_model_space() {
    let db = seeded();
    let options = SearchOptions {
        query_embedding: Some(vec![1.0, 0.0, 0.0]),
        query_model_id: Some("fixture-model".into()),
        ..SearchOptions::default()
    };
    let before = search(&db, "git:search-fixture", "no-such-token", &options).unwrap();
    assert!(!before.is_empty());
    db.execute_batch("BEGIN; DELETE FROM git_commit_embeddings")
        .unwrap();
    assert!(search(&db, "git:search-fixture", "no-such-token", &options)
        .unwrap()
        .is_empty());
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        search(&db, "git:search-fixture", "no-such-token", &options).unwrap(),
        before
    );
    db.execute(
        "UPDATE git_commit_embeddings SET embedding = X'00' WHERE sha = ?",
        [&before[0].commit.sha],
    )
    .unwrap();
    assert!(search(&db, "git:search-fixture", "no-such-token", &options).is_err());
}
