use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::{json, Value};

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::dreamer::checkout::tests::Repo;
use crate::dreamer::engine::{Engine, Settings};
use crate::dreamer::run::tests::{Client, Ends};
use crate::memory_profile::{prompt_profile, Profile};
use crate::memory_writes::normalized_hash;

pub(crate) const PROJECT: &str = "pj-verify";
/// The memories a message checked by reading held before it held one
/// ([`READ_BATCH_SIZE`]), for tests of a reply that decides several
/// memories of one message.
pub(crate) const SEVERAL: usize = 5;

/// A memory row as the tests write it.
#[derive(Clone)]
pub(crate) struct Row {
    pub id: i64,
    pub tag: &'static str,
    pub content: String,
    /// Mapped files.
    pub files: Vec<&'static str>,
    /// When it was verified, and at which commit.
    pub verified: Option<(i64, Option<String>)>,
    /// The lines that verification cited (path, first and last line,
    /// text); none for a confirmation recorded without them.
    pub spans: Vec<(&'static str, usize, usize, &'static str)>,
    /// When a verify task last skipped it.
    pub checked_at: Option<i64>,
}

/// Memory `id`: a live architecture memory with `content`, never verified.
pub(crate) fn row(id: i64, content: &str) -> Row {
    Row {
        id,
        tag: "ARCHITECTURE",
        content: content.to_owned(),
        files: Vec::new(),
        verified: None,
        spans: Vec::new(),
        checked_at: None,
    }
}

/// A store of the module's schema next to a git checkout of the project.
pub(crate) struct Fixture {
    pub repo: Repo,
    _dir: tempfile::TempDir,
    pub db: ContextDb,
    pub profile: Profile,
    /// The project's live branches besides its default branch, as the
    /// person's `dreamer.branches` setting would name them.
    pub branches: Vec<String>,
}

impl Fixture {
    pub(crate) fn new(files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        Self {
            repo: Repo::new(files),
            _dir: dir,
            db,
            profile: prompt_profile(None).unwrap(),
            branches: Vec::new(),
        }
    }

    /// [`Fixture::new`] with the first commit on branch `branch`.
    pub(crate) fn on(branch: &str, files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        Self {
            repo: Repo::on(branch, files),
            _dir: dir,
            db,
            profile: prompt_profile(None).unwrap(),
            branches: Vec::new(),
        }
    }

    pub(crate) fn insert(&self, rows: &[Row]) {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            for row in rows {
                let mut metadata = serde_json::Map::new();
                if let Some((at, commit)) = &row.verified {
                    metadata.insert("dreamerVerifiedAt".into(), json!(at));
                    metadata.insert("dreamerVerifiedCommit".into(), json!(commit));
                    if let (Some(commit), false) = (commit, row.spans.is_empty()) {
                        let confirmation = Confirmation {
                            commit: commit.clone(),
                            spans: row
                                .spans
                                .iter()
                                .map(|(path, start, end, text)| Cited {
                                    path: (*path).to_owned(),
                                    start: *start,
                                    end: *end,
                                    text: (*text).to_owned(),
                                })
                                .collect(),
                            derive: None,
                        };
                        metadata.insert(STORED_KEY.into(), confirmation.json(*at));
                    }
                }
                if let Some(at) = row.checked_at {
                    metadata.insert("dreamerCheckedAt".into(), json!(at));
                }
                tx.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          status, verified_at, metadata_json,
                                          first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, 0, 0, 5, 0)",
                    params![
                        row.id,
                        PROJECT,
                        frozen_category_id(row.tag),
                        row.tag,
                        row.content,
                        normalized_hash(&row.content),
                        row.verified.as_ref().map(|(at, _)| *at),
                        (!metadata.is_empty()).then(|| Value::Object(metadata).to_string()),
                    ],
                )
                .unwrap();
                for file in &row.files {
                    tx.execute(
                        "INSERT INTO memory_verifications(memory_id, file_path, verified_at, mapped_at)
                         VALUES (?1, ?2, ?3, 1)",
                        params![row.id, file, row.verified.as_ref().map_or(0, |(at, _)| *at)],
                    )
                    .unwrap();
                }
            }
            tx.commit().unwrap();
        });
    }

    pub(crate) fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    pub(crate) fn declaration(&self, kind: &str) -> Value {
        self.profile.body["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["kind"] == kind)
            .cloned()
            .unwrap()
    }

    /// The batches a run of the task plans now, under `declaration`.
    pub(crate) fn batches_under(&self, broad: bool, declaration: &Value) -> Vec<VerifyBatch> {
        self.plan_at(broad, declaration, self.repo.path(), READ_BATCH_SIZE)
    }

    /// The batches a run would plan now if a message checked by reading held
    /// up to [`SEVERAL`] memories, for a test of a reply that decides several
    /// memories of one message, as a diff message's reply does.
    pub(crate) fn several(&self, broad: bool) -> Vec<VerifyBatch> {
        let declaration = self.declaration(if broad { VERIFY_BROAD } else { VERIFY });
        self.plan_at(broad, &declaration, self.repo.path(), SEVERAL)
    }

    /// [`Fixture::several`], for a run started from a session in `root`.
    pub(crate) fn several_at(&self, broad: bool, root: &std::path::Path) -> Vec<VerifyBatch> {
        let declaration = self.declaration(if broad { VERIFY_BROAD } else { VERIFY });
        self.plan_at(broad, &declaration, root, SEVERAL)
    }

    /// [`Fixture::several`], under `declaration`.
    pub(crate) fn several_under(&self, broad: bool, declaration: &Value) -> Vec<VerifyBatch> {
        self.plan_at(broad, declaration, self.repo.path(), SEVERAL)
    }

    fn plan_at(
        &self,
        broad: bool,
        declaration: &Value,
        root: &std::path::Path,
        read_batch: usize,
    ) -> Vec<VerifyBatch> {
        let owner = Owner::Project {
            id: PROJECT.into(),
            root: root.to_str().unwrap().into(),
        };
        Verify { broad }
            .plan_batches_of(
                &TaskContext {
                    db: &self.db,
                    owner: &owner,
                    profile: &self.profile,
                    declaration,
                    workspace: None,
                    guidance: None,
                    branches: &self.branches,
                },
                read_batch,
            )
            .unwrap()
            .batches
    }

    pub(crate) fn batches(&self, broad: bool) -> Vec<VerifyBatch> {
        let declaration = self.declaration(if broad { VERIFY_BROAD } else { VERIFY });
        self.batches_under(broad, &declaration)
    }

    /// Apply `reply` to `batch` as the engine applies an accepted one.
    pub(crate) fn apply(&self, batch: &VerifyBatch, reply: &str) -> Applied {
        batch.accepts(reply).unwrap();
        let reply = TaskReply {
            text: reply.into(),
            model: cortexkit_role_compaction::setup::ModelRef::new("p", "m"),
            runner: "r".into(),
            child: "child".into(),
            usage: None,
            steps: None,
        };
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply, 7).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    /// Memory `id`'s status, content, revision, verified time, metadata and
    /// update time.
    pub(crate) fn memory(&self, id: i64) -> (String, String, i64, Option<i64>, Value, i64) {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT status, content, revision, verified_at, metadata_json, updated_at
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| {
                        let metadata: Option<String> = row.get(4)?;
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            metadata
                                .and_then(|text| serde_json::from_str(&text).ok())
                                .unwrap_or(Value::Null),
                            row.get(5)?,
                        ))
                    },
                )
            })
            .unwrap()
    }

    pub(crate) fn mapping(&self, id: i64) -> Vec<String> {
        self.db
            .with_connection(|conn| {
                conn.prepare(
                    "SELECT file_path FROM memory_verifications WHERE memory_id = ?1 ORDER BY file_path",
                )
                .unwrap()
                .query_map([id], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
            })
            .unwrap()
    }

    /// Each history row's memory, revision, reason, evidence and decision.
    pub(crate) fn history(&self) -> Vec<(i64, i64, String, Value, String)> {
        self.db
            .with_connection(|conn| {
                conn.prepare(
                    "SELECT memory_id, revision, reason, evidence_json, decision_key
                       FROM memory_history ORDER BY id",
                )
                .unwrap()
                .query_map([], |row| {
                    let evidence: String = row.get(3)?;
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        serde_json::from_str(&evidence).unwrap(),
                        row.get(4)?,
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
            })
            .unwrap()
    }
}

/// A batch standing for one a replay planned earlier, so the replay harness
/// can check the verdicts of its reply without writing anything: `read`
/// holds its memories as the batch sent them, `checkout` the code at the
/// commit the batch read, and `main` the repository's main checkout, whose
/// live branches (the default branch and `branches`) a memory without a line
/// of its own is checked against.
pub(crate) fn replay_batch(
    declaration: &Value,
    broad: bool,
    project: &str,
    read: Vec<Read>,
    checkout: Arc<Checkout>,
    main: &std::path::Path,
    branches: &[String],
) -> VerifyBatch {
    let gate = read
        .iter()
        .any(|read| !read.lined)
        .then(|| Gate::new(main, branches));
    VerifyBatch {
        declared: Arc::new(Declared::of(declaration, Verify { broad }.kind())),
        index: 0,
        project: project.to_owned(),
        system: String::new(),
        message: String::new(),
        read,
        diff: false,
        search: None,
        folder: checkout.root().to_string_lossy().into_owned(),
        checkout,
        branch: None,
        gate,
        history_timeout: HISTORY_TIMEOUT,
        absence: Mutex::default(),
        archive_branches: Default::default(),
        confirmations: Mutex::default(),
        files: Mutex::default(),
    }
}

fn ids(batch: &VerifyBatch) -> Vec<i64> {
    batch.read().iter().map(|read| read.id).collect()
}

#[test]
fn verify_checks_mapped_memories_whose_files_changed_verified_ones_apart() {
    let fixture = Fixture::new(&[
        ("src/a.rs", "old\n"),
        ("src/b.rs", "steady\n"),
        ("src/c.rs", "new\n"),
        ("src/gone.rs", "soon gone\n"),
    ]);
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture.repo.write(&[("src/a.rs", "new\n")]);
    std::fs::remove_file(fixture.repo.path().join("src/gone.rs")).unwrap();
    fixture.repo.commit("change a, remove gone");
    let verified = Some((1_000, Some(first.clone())));
    fixture.insert(&[
        Row {
            files: vec!["src/a.rs"],
            verified: verified.clone(),
            spans: vec![("src/a.rs", 1, 1, "old")],
            ..row(1, "A changed.")
        },
        Row {
            files: vec!["src/b.rs"],
            verified: verified.clone(),
            spans: vec![("src/b.rs", 1, 1, "steady")],
            ..row(2, "B did not change.")
        },
        Row {
            files: vec!["src/c.rs"],
            ..row(3, "C was never verified; it cites `missing_helper`.")
        },
        row(4, "Not mapped, so not this task's."),
        Row {
            files: vec!["src/gone.rs"],
            verified: verified.clone(),
            spans: vec![("src/gone.rs", 1, 1, "soon gone")],
            ..row(5, "Gone was removed.")
        },
        // Confirmed before cited lines were required: its file did not
        // change, yet it is read in full, as one never confirmed.
        Row {
            files: vec!["src/b.rs"],
            verified,
            ..row(6, "B was confirmed without cited lines.")
        },
    ]);
    let batches = fixture.batches(false);
    assert_eq!(
        batches.iter().map(ids).collect::<Vec<_>>(),
        [vec![1, 5], vec![3], vec![6]]
    );
    // The memories whose cited lines changed are shown their files' diffs
    // since the commit they were confirmed at, under the task's diff
    // message, with the lines they were confirmed from.
    assert!(batches[0].has_diff());
    let message = &batches[0].message;
    assert!(
        message.contains("The git diff below shows what changed."),
        "{message}"
    );
    assert!(message.contains(
        "[1] ARCHITECTURE\nContent: A changed.\nBacking files: src/a.rs\nConfirmed from: src/a.rs:1-1\n"
    ));
    assert!(message.contains("Confirmed from: src/gone.rs:1-1\n</memories>"));
    assert!(
        message.contains("<changed-files mode=\"diff\">\nFile: src/a.rs (memories: 1)\ndiff --git")
    );
    assert!(message.contains("-old\n+new\n"));
    assert!(message.contains("File: src/gone.rs (memories: 5)\ndiff --git"));
    assert!(!message.contains("Not found by a plain search"));
    assert_eq!(batches[0].commit(), fixture.repo.checkout().head());
    // A memory never confirmed with cited lines is checked by reading, one
    // to a message, under the other message, with what a plain search
    // didn't find.
    assert!(!batches[1].has_diff() && !batches[2].has_diff());
    let message = &batches[1].message;
    assert!(message.contains("Check each memory's claim against its backing files"));
    assert!(message.contains(
        "[3] ARCHITECTURE\nContent: C was never verified; it cites `missing_helper`.\nBacking files: src/c.rs\nNot found by a plain search of the checkout: missing_helper\n</memories>"
    ));
    assert!(batches[2].message.contains(
        "[6] ARCHITECTURE\nContent: B was confirmed without cited lines.\nBacking files: src/b.rs\n</memories>"
    ));
    assert!(!message.contains("Confirmed from"));
    assert_eq!(batches[1].system, batches[0].system);
    assert!(batches[0].system.starts_with("You are a memory verifier"));
    assert!(!batches[0].system.contains('⟦'));
}

#[test]
fn an_old_confirmation_without_cited_lines_counts_as_never_made() {
    let fixture = Fixture::new(&[("src/a.rs", "a\n")]);
    let head = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    let now = crate::memory_writes::now_ms();
    fixture.insert(&[
        Row {
            files: vec!["src/a.rs"],
            verified: Some((1, None)),
            ..row(1, "Confirmed by 0.49 without a commit.")
        },
        Row {
            files: vec!["src/a.rs"],
            verified: Some((now + 60_000, Some(head.clone()))),
            ..row(2, "Confirmed at this very commit, without cited lines.")
        },
        Row {
            files: vec!["src/a.rs"],
            verified: Some((now + 60_000, Some(head.clone()))),
            spans: vec![("src/a.rs", 1, 1, "a")],
            ..row(3, "Confirmed at this commit from its cited line.")
        },
    ]);
    // Spans kept for an earlier confirmation count for nothing either.
    fixture.execute(&format!(
        "UPDATE memories SET metadata_json = json_set(metadata_json, '$.{STORED_KEY}.verifiedAt', 5)
          WHERE id = 3"
    ));
    fixture.insert(&[Row {
        files: vec!["src/a.rs"],
        verified: Some((now + 60_000, Some(head.clone()))),
        spans: vec![("src/a.rs", 1, 1, "a")],
        ..row(
            4,
            "Confirmed at this commit from its cited line, and nothing changed.",
        )
    }]);
    let pool = fixture
        .db
        .with_connection(|conn| live_memories(conn, PROJECT, &["swe:architecture".to_owned()], 0))
        .unwrap();
    let state: Vec<(i64, i64, bool)> = pool
        .iter()
        .map(|memory| (memory.id, memory.verified_at, memory.confirmation.is_some()))
        .collect();
    assert_eq!(
        state,
        [
            (1, 0, false),
            (2, 0, false),
            (3, 0, false),
            (4, now + 60_000, true)
        ]
    );
    // They are read in full, one to a message, never shown a diff; memory 4
    // needs nothing.
    let batches = fixture.batches(false);
    assert_eq!(
        batches.iter().map(ids).collect::<Vec<_>>(),
        [vec![1], vec![2], vec![3]]
    );
    assert!(batches.iter().all(|batch| !batch.has_diff()));
}

#[test]
fn verify_broad_puts_memories_whose_citations_are_all_gone_first_then_the_least_recently_checked() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture.insert(&[
        Row {
            checked_at: Some(100),
            ..row(1, "`live_function` runs first.")
        },
        Row {
            checked_at: Some(500),
            ..row(2, "`gone_function` in src/old/gone.rs does it.")
        },
        Row {
            checked_at: Some(50),
            ..row(3, "A plain rule with no names.")
        },
        Row {
            checked_at: Some(200),
            ..row(4, "live_function calls gone_thing.")
        },
        Row {
            verified: Some((300, None)),
            checked_at: Some(10),
            ..row(5, "Verified at 300, so checked then.")
        },
        Row {
            files: vec!["src/live.rs"],
            ..row(6, "Never checked.")
        },
    ]);
    let batches = fixture.batches(true);
    assert_eq!(
        batches.iter().map(ids).collect::<Vec<_>>(),
        [vec![2], vec![6], vec![3], vec![1], vec![4], vec![5]]
    );
    let message = &batches[0].message;
    assert!(message.contains(
        "[2] ARCHITECTURE\nContent: `gone_function` in src/old/gone.rs does it.\nBacking files: (none mapped)\nNot found by a plain search of the checkout: gone_function, src/old/gone.rs\n</memories>"
    ), "{message}");
    assert!(batches[1].message.contains(
        "[6] ARCHITECTURE\nContent: Never checked.\nBacking files: src/live.rs\n</memories>"
    ));
    assert!(batches[3].message.contains(
        "Content: `live_function` runs first.\nBacking files: (none mapped)\n</memories>"
    ));
    assert!(batches[4].message.contains(
        "Backing files: (none mapped)\nNot found by a plain search of the checkout: gone_thing\n</memories>"
    ));
    // verify-broad runs under verify's system prompt and its own message.
    assert!(batches[0].system.starts_with("You are a memory verifier"));
    assert!(message.contains("when it has none, by searching the checkout"));
    assert_eq!(
        batches[0].search().map(|search| (search.names, search.cut)),
        Some((3, false))
    );
}

/// A behavioural rule whose only hyphenated words are English cites
/// nothing, so nothing it cites can be missing: it neither goes first nor
/// gets a `Not found` line, as rules in a real verify-broad batch did.
#[test]
fn a_memory_citing_nothing_never_goes_first() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture.insert(&[
        Row {
            checked_at: Some(100),
            ..row(1, "`live_function` runs first.")
        },
        Row {
            tag: "PROJECT_RULES",
            checked_at: Some(500),
            ..row(
                2,
                "When intentionally keeping an audit-flagged pattern, add inline comments; zero-delta runs are release-bound.",
            )
        },
    ]);
    let batches = fixture.batches(true);
    assert_eq!(
        batches.iter().map(ids).collect::<Vec<_>>(),
        [vec![1], vec![2]]
    );
    for batch in &batches {
        assert!(
            !batch.message.contains("Not found by a plain search"),
            "{}",
            batch.message
        );
    }
    let pool = fixture
        .db
        .with_connection(|conn| live_memories(conn, PROJECT, &["swe:project-rules".to_owned()], 0))
        .unwrap();
    let lookup = look_up(
        &fixture.repo.checkout(),
        &pool.iter().collect::<Vec<_>>(),
        &SEARCH_LIMITS,
    );
    assert!(lookup.gone.is_empty() && lookup.not_found.is_empty());
}

/// A broad run sends one memory to a message: the memories of one message
/// paid for each other's reads on every step of its run.
#[test]
fn a_broad_run_sends_one_memory_a_batch_and_only_covered_categories() {
    let fixture = Fixture::new(&[("README.md", "readme\n")]);
    let mut rows: Vec<Row> = (1..=45).map(|id| row(id, &format!("Fact {id}."))).collect();
    rows.push(Row {
        tag: "USER_PREFERENCES",
        ..row(46, "A preference, filed under project rules.")
    });
    fixture.insert(&rows);
    // A category the task doesn't cover is left out.
    fixture.execute("UPDATE memories SET category = 'swe:workflow' WHERE id = 45");
    let batches = fixture.batches(true);
    assert_eq!(
        batches
            .iter()
            .map(|batch| batch.read().len())
            .collect::<Vec<_>>(),
        [1; 45]
    );
    let all: Vec<i64> = batches.iter().flat_map(ids).collect();
    assert!(all.contains(&46) && !all.contains(&45));
    // verify sends nothing for memories no file backs.
    assert!(fixture.batches(false).is_empty());
}

#[test]
fn a_search_cut_by_its_limits_lists_nothing_and_puts_nobody_first() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    let memory = Memory {
        id: 1,
        tag: "ARCHITECTURE".into(),
        category: "swe:architecture".into(),
        content: "`gone_function` is gone.".into(),
        revision: 1,
        files: Vec::new(),
        verified_at: 0,
        verified_commit: None,
        confirmation: None,
        branch: None,
        checked_at: 0,
        checked_revision: None,
        checked_commit: None,
        not_code: false,
    };
    let checkout = fixture.repo.checkout();
    let full = look_up(&checkout, &[&memory], &SEARCH_LIMITS);
    assert_eq!(full.not_found[&1], ["gone_function"]);
    assert!(full.gone.contains(&1) && !full.cut);
    let cut = look_up(
        &checkout,
        &[&memory],
        &Limits {
            max_files: 0,
            max_time: Duration::from_secs(60),
        },
    );
    assert!(cut.cut && cut.not_found.is_empty() && cut.gone.is_empty());
    assert_eq!(
        input(&[&memory], &cut),
        "<memories>\n[1] ARCHITECTURE\nContent: `gone_function` is gone.\nBacking files: (none mapped)\n</memories>"
    );
}

#[test]
fn the_diff_frame_keeps_the_plugins_shape_and_bounds_long_diffs() {
    let memory = Memory {
        id: 1,
        tag: "ARCHITECTURE".into(),
        category: "swe:architecture".into(),
        content: "The handler has one argument.".into(),
        revision: 1,
        files: vec!["src/a.ts".into()],
        verified_at: 1,
        verified_commit: None,
        confirmation: None,
        branch: None,
        checked_at: 1,
        checked_revision: None,
        checked_commit: None,
        not_code: false,
    };
    let diff = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    let evidence = bounded_evidence(vec![EvidenceFile {
        path: "src/a.ts".into(),
        text: diff.into(),
        memory_ids: vec![1],
    }]);
    // The input the 0.49 plugin's verifier sent for this batch.
    assert_eq!(
        diff_input(&[&memory], &evidence),
        "<memories>\n[1] ARCHITECTURE\nContent: The handler has one argument.\nBacking files: src/a.ts\n</memories>\n\n<changed-files mode=\"diff\">\nFile: src/a.ts (memories: 1)\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n</changed-files>"
    );
    let long = format!("{diff}{}", "+line\n".repeat(7_000));
    let bounded = bounded_evidence(vec![EvidenceFile {
        path: "src/a.ts".into(),
        text: long,
        memory_ids: vec![1],
    }]);
    assert_eq!(bounded.mode, "ranges");
    assert_eq!(
        bounded.files[0].text,
        "Changed lines: +7001/-1.\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\nRead only these changed line ranges if they may affect the claim."
    );
}

/// A verify-broad run through the engine, ended, and what it ran against.
struct Ran {
    db: Arc<ContextDb>,
    client: Arc<Client>,
    engine: Arc<Engine>,
    /// The project's folder, as git names it.
    root: String,
    _repo: Repo,
    _dir: tempfile::TempDir,
}

impl Ran {
    /// The run's task, outcome, proposed and applied counts, error and batch
    /// records.
    fn run(&self) -> (String, String, i64, i64, Option<String>, Value) {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT task, outcome, proposed, applied, error, COALESCE(batches_json, '[]')
                       FROM dream_task_runs ORDER BY id DESC LIMIT 1",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
            })
            .map(|(task, outcome, proposed, applied, error, batches)| {
                let batches = serde_json::from_str(&batches).unwrap();
                (task, outcome, proposed, applied, error, batches)
            })
            .unwrap()
    }

    /// Memory `id`'s status, verify result and the time a verify task last
    /// decided anything about it.
    fn checked(&self, id: i64) -> (String, Option<String>, Option<i64>) {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT status, verify_result, json_extract(metadata_json, '$.dreamerCheckedAt')
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap()
    }

    /// Each send's child and prompt.
    fn sent(&self) -> Vec<(String, String)> {
        self.client
            .sends
            .lock()
            .unwrap()
            .iter()
            .map(|(child, request)| {
                (
                    child.session.session.clone(),
                    request.prompt.clone().unwrap_or_default(),
                )
            })
            .collect()
    }
}

/// Run `verify-broad` for `fixture`'s project through the engine, on runners
/// that take plans with AFT's reader tools, each child run ending as `ends`
/// says, and wait for the run to end.
async fn broad_through_engine(fixture: Fixture, ends: &[Ends], settings: &Settings) -> Ran {
    let engine = Engine::new("this", vec![Box::new(Verify { broad: true })])
        .with_leases(crate::dreamer::lease_double::SampleLeases::granting());
    verify_through_engine(fixture, ends, settings, engine).await
}

async fn verify_through_engine(
    fixture: Fixture,
    ends: &[Ends],
    settings: &Settings,
    engine: Engine,
) -> Ran {
    let Fixture {
        repo,
        _dir,
        db,
        profile,
        ..
    } = fixture;
    let db = Arc::new(db);
    let engine = Arc::new(engine);
    let mut client = Client::new(&["p/a", "p/b"], ends);
    client.plans = vec!["ra", "rb"];
    client.catalog = Ok(vec![
        ("read", &["code.read/v1"]),
        ("grep", &[]),
        ("glob", &[]),
    ]);
    let client = Arc::new(client);
    // Canonical, as git names the main checkout (macOS keeps temp folders
    // under /private/var behind a /var link).
    let root = repo.path().canonicalize().unwrap().display().to_string();
    engine.see_project(&db, PROJECT, &root, Arc::new(profile), settings, 1);
    db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
    engine.tick(&db, &client, settings, crate::memory_writes::now_ms());
    for _ in 0..500 {
        let ended: bool = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM dream_task_runs WHERE ended_at IS NOT NULL)",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        if ended {
            return Ran {
                db,
                client,
                engine,
                root,
                _repo: repo,
                _dir,
            };
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the run never ended");
}

/// A broad run of a live memory and one whose code name is gone from the
/// checkout but was in its history: the gone one is checked first.
fn live_and_gone(rows: &[Row]) -> Fixture {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/gone.rs", "fn gone_function() {}\n")]);
    fixture.insert(rows);
    fixture
}

const ARCHIVE_2: &str = "<verify>\n<archive id=\"2\" reason=\"its subject was removed\" missing=\"gone_function\"/>\n</verify>";

#[tokio::test]
async fn a_request_refusal_defers_one_memory_without_stopping_verification() {
    let fixture = live_and_gone(&[
        row(1, "`live_function` runs first."),
        row(2, "`gone_function` does it."),
        row(3, "`live_function` is in `src/live.rs`."),
    ]);
    let refused = Ends::Error("invalid_request_error: the prompt is too long");
    let settings = Settings::default();
    let ran = broad_through_engine(fixture, &[
        refused.clone(), refused,
        Ends::Reply(r#"<verify><verified id="1" files="src/live.rs" cites="src/live.rs:1-1"/></verify>"#),
        Ends::Reply(r#"<verify><skip id="3" reason="unsure"/></verify>"#),
    ], &settings).await;
    assert_eq!(ran.checked(1).1.as_deref(), Some("confirmed"));
    assert_eq!(ran.checked(2), ("active".into(), None, None));
    let initial = ran.sent().len();
    assert_eq!(initial, 4);
    ran.client.ends.lock().unwrap().extend([
        Ends::Reply(r#"<verify><skip id="1" reason="unsure"/></verify>"#),
        Ends::Reply(r#"<verify><skip id="3" reason="unsure"/></verify>"#),
        Ends::Reply(ARCHIVE_2),
    ]);
    for _ in 0..500 {
        if ran.engine.is_idle_for_tests() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ran.db
        .with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
    ran.engine.tick(
        &ran.db,
        &ran.client,
        &settings,
        crate::memory_writes::now_ms(),
    );
    for _ in 0..500 {
        if ran.engine.is_idle_for_tests() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let next = ran.sent().split_off(initial);
    assert_eq!(next.len(), 3);
    assert!(next.last().unwrap().1.contains("[2]"), "{next:?}");
}

#[tokio::test]
async fn an_account_wait_still_stops_verification_before_later_batches() {
    let fixture = live_and_gone(&[
        row(1, "`live_function` runs first."),
        row(2, "`gone_function` does it."),
    ]);
    let reset = crate::memory_writes::now_ms() as u64 + 60_000;
    let ran = broad_through_engine(fixture, &[Ends::Full(reset)], &Settings::default()).await;
    assert_eq!(ran.run().1, "waiting");
    assert_eq!(ran.sent().len(), 1);
    assert_eq!(ran.checked(1).1, None);
}

/// The engine runs `verify-broad` end to end: each memory goes alone to a
/// runner that takes plans, with AFT's reader tools; a final message without
/// a complete manifest fails that model, and the next model's manifest is
/// applied.
#[tokio::test]
async fn a_broad_run_goes_through_the_engine_and_writes_what_the_reply_decides() {
    let fixture = live_and_gone(&[
        row(1, "`live_function` runs first."),
        row(2, "`gone_function` does it."),
    ]);
    let ran = broad_through_engine(
        fixture,
        &[
            // Memory 2 goes first, its code name gone.
            Ends::Reply("I checked it; it holds."),
            Ends::Reply(ARCHIVE_2),
            Ends::Reply(
                "<verify>\n<verified id=\"1\" files=\"src/live.rs\" cites=\"src/live.rs:1-1\"/>\n</verify>",
            ),
        ],
        &Settings::default(),
    )
    .await;
    let (task, outcome, proposed, applied, _, _) = ran.run();
    assert_eq!(
        (task.as_str(), outcome.as_str(), proposed, applied),
        ("swe:verify-broad", "applied", 2, 2)
    );
    let children: Vec<String> = ran.sent().into_iter().map(|(child, _)| child).collect();
    // The first model's reply about memory 2 was refused; memory 1 had a
    // child of its own.
    assert_eq!(
        children,
        ["mc-dream:1.0:0.0", "mc-dream:1.0:1.0", "mc-dream:1.1:0.0"]
    );
    {
        let sends = ran.client.sends.lock().unwrap();
        let (child, request) = &sends[1];
        assert_eq!(child.project_root.as_deref(), Some(ran.root.as_str()));
        let plan = request.plan.as_ref().expect("a plan");
        assert_eq!(
            plan["tool_items"],
            json!([{"params": {}, "preset": "reader", "provider": "aft"}])
        );
        assert_eq!(
            request.runner_params["stop_when"],
            json!({"max_steps": STEP_CAP})
        );
    }
    assert_eq!(ran.checked(2).0, "archived");
    let verified_mapping: Vec<String> = ran
        .db
        .with_connection(|conn| {
            conn.prepare("SELECT file_path FROM memory_verifications WHERE memory_id = 1")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    assert_eq!(verified_mapping, ["src/live.rs"]);
    let key: String = ran
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT decision_key FROM memory_history WHERE memory_id = 2",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(key, "dream-run:1:verify-broad:0:2");
}

/// A child that reaches the step cap is sent verify's finalize message once,
/// in the same conversation, and the manifest it answers with is written.
/// One that still answers without a manifest leaves its memory written as a
/// skip, as a `<skip>` verdict is, and the run goes on to the next memory.
#[tokio::test]
async fn a_capped_child_answers_once_more_and_one_without_a_manifest_counts_as_a_skip() {
    let fixture = live_and_gone(&[
        row(1, "A plain rule with no names."),
        row(2, "`gone_function` does it."),
        row(3, "`live_function` runs first."),
    ]);
    let ran = broad_through_engine(
        fixture,
        &[
            // Memory 2, its code name gone, goes first.
            Ends::StepCapped(STEP_CAP),
            Ends::Reply(ARCHIVE_2),
            // Memory 1.
            Ends::StepCapped(STEP_CAP),
            Ends::Reply("I ran out of steps before I could decide."),
            // Memory 3, answered within the cap.
            Ends::Reply(
                "<verify>\n<verified id=\"3\" files=\"src/live.rs\" cites=\"src/live.rs:1-1\"/>\n</verify>",
            ),
        ],
        &Settings::default(),
    )
    .await;
    let (_, outcome, proposed, applied, _, batches) = ran.run();
    // The archive, the skip and the confirmation.
    assert_eq!((outcome.as_str(), proposed, applied), ("applied", 3, 3));
    let sent = ran.sent();
    assert_eq!(sent.len(), 5);
    // The finalize message goes once to each capped child, in that child.
    assert_eq!(
        sent[1],
        ("mc-dream:1.0:0.0".to_owned(), FINALIZE.to_owned())
    );
    assert_eq!(
        sent[3],
        ("mc-dream:1.1:0.0".to_owned(), FINALIZE.to_owned())
    );
    assert_eq!(
        sent.iter().filter(|(_, prompt)| prompt == FINALIZE).count(),
        2
    );
    assert_eq!(sent[4].0, "mc-dream:1.2:0.0");
    assert_eq!(
        ran.client.sends.lock().unwrap()[1].1.runner_params["stop_when"],
        json!({"max_steps": 1})
    );
    assert_eq!(ran.checked(2).0, "archived");
    let (status, result, checked_at) = ran.checked(1);
    assert_eq!(
        (status.as_str(), result.as_deref()),
        ("active", Some("skipped"))
    );
    assert!(checked_at.is_some_and(|at| at > 0));
    assert_eq!(ran.checked(3).1.as_deref(), Some("confirmed"));
    // The skipped message is recorded with the run, with why.
    let skipped = batches[1]["skipped"].as_str().unwrap();
    assert!(skipped.contains("mc-dream:1.1:0.0"), "{skipped}");
    assert!(
        skipped.contains("verify manifest missing complete root element"),
        "{skipped}"
    );
    assert!(batches[0].get("skipped").is_none() && batches[2].get("skipped").is_none());
}

/// The run's token budget counts a capped child's two sends, and stops the
/// run before its next message as before.
#[tokio::test]
async fn the_token_budget_stops_a_run_of_one_memory_messages_before_the_next() {
    let fixture = live_and_gone(&[
        row(1, "A plain rule with no names."),
        row(2, "`gone_function` does it."),
        row(3, "`live_function` runs first."),
    ]);
    let settings = Settings {
        budget_tokens: 1_500,
        ..Settings::default()
    };
    // 1,000 tokens to the cap, 500 for an answer without a manifest.
    let ran = broad_through_engine(
        fixture,
        &[
            Ends::StepCapped(STEP_CAP),
            Ends::Spent("I ran out of steps.", 500),
        ],
        &settings,
    )
    .await;
    let (_, outcome, _, _, error, _) = ran.run();
    assert_eq!(outcome, "budget_stopped");
    assert_eq!(
        error.as_deref(),
        Some("used 1500 of 1500 tokens; 2 of 3 batches left unsent")
    );
    assert_eq!(ran.sent().len(), 2);
    // The capped memory counts as checked; the others are untouched.
    assert_eq!(ran.checked(2).1.as_deref(), Some("skipped"));
    assert_eq!(ran.checked(1).1, None);
    assert_eq!(ran.checked(3).1, None);
}

fn unchanged_confirmation() -> (Fixture, String) {
    let fixture = Fixture::new(&[("src/a.rs", "fn keep() {}\nconst CAP: u64 = 64_000;\n")]);
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture.repo.write(&[(
        "src/a.rs",
        "// The cap.\n\nfn keep() {}\nconst CAP: u64 = 64_000;\n",
    )]);
    let second = fixture.repo.commit("move the cap down");
    fixture.insert(&[Row {
        files: vec!["src/a.rs"],
        verified: Some((1_000, Some(first))),
        spans: vec![("src/a.rs", 2, 2, "const CAP: u64 = 64_000;")],
        ..row(1, "`CAP` in src/a.rs is 64k.")
    }]);
    (fixture, second)
}

/// A confirmed memory whose file changed, but not the lines it cites, stays
/// confirmed without a model and records the commit under the run's role.
#[tokio::test]
async fn a_confirmation_whose_cited_lines_are_unchanged_stays_without_a_model() {
    let (fixture, second) = unchanged_confirmation();
    assert!(fixture.batches(false).is_empty(), "no model is needed");
    assert_ne!(
        fixture.memory(1).4["dreamerVerifiedCommit"],
        json!(second),
        "planning alone must not write"
    );
    let engine = Engine::new("this", vec![Box::new(Verify { broad: false })])
        .with_leases(crate::dreamer::lease_double::SampleLeases::granting());
    let ran = verify_through_engine(fixture, &[], &Settings::default(), engine).await;
    assert!(ran.sent().is_empty(), "no model is asked");
    assert_eq!(ran.run().1, "nothing_to_do");
    let (revision, verified_at, metadata, updated_at): (i64, Option<i64>, String, i64) = ran.db.with_connection(|conn| {
        conn.query_row(
            "SELECT revision, verified_at, metadata_json, updated_at FROM memories WHERE id = 1", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
    }).unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!((revision, verified_at, updated_at), (1, Some(1_000), 5));
    assert_eq!(metadata["dreamerVerifiedAt"], json!(1_000));
    assert_eq!(metadata["dreamerVerifiedCommit"], json!(second));
    assert_eq!(
        metadata[STORED_KEY],
        json!({
            "verifiedAt": 1_000,
            "commit": second,
            "spans": [{"path": "src/a.rs", "start": 4, "end": 4, "text": "const CAP: u64 = 64_000;"}],
        })
    );
    let (verify_commit, actor, run_id, epoch): (String, String, i64, Option<i64>) = ran
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT m.verify_commit, o.actor, o.run_id, o.epoch
                   FROM memories m JOIN replica_outbox o ON o.kind = 'memory' AND o.local_id = m.id
                  WHERE m.id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .unwrap();
    assert_eq!(verify_commit, second);
    assert_eq!(
        (actor.as_str(), run_id, epoch),
        ("dreamer", 1, cfg!(feature = "memory-replica").then_some(1))
    );

    let profile = prompt_profile(None).unwrap();
    let declaration = profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == VERIFY)
        .unwrap();
    let plan = Verify { broad: false }
        .plan_batches(&TaskContext {
            db: &ran.db,
            owner: &Owner::Project {
                id: PROJECT.into(),
                root: ran.root.clone(),
            },
            profile: &profile,
            declaration,
            workspace: None,
            guidance: None,
            branches: &[],
        })
        .unwrap();
    assert!(plan.batches.is_empty());
    assert!(
        plan.rechecked.is_empty(),
        "the next run already knows this commit"
    );
}

#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_verify_recheck_rolls_back_if_its_role_window_closes_before_commit() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (fixture, _) = unchanged_confirmation();
    let before = fixture.memory(1).4;
    let checks = AtomicUsize::new(0);
    let clock = crate::dreamer::lease::system_clock();
    let engine = Engine::new("this", vec![Box::new(Verify { broad: false })])
        .with_leases(crate::dreamer::lease_double::SampleLeases::granting())
        .with_clock(Arc::new(move || {
            // The watch opens and the engine journals its generation while
            // the role is held. The transaction reaches commit too late.
            let advance = if checks.fetch_add(1, Ordering::SeqCst) < 2 {
                0
            } else {
                120_000
            };
            clock() + advance
        }));
    let ran = verify_through_engine(fixture, &[], &Settings::default(), engine).await;
    assert_eq!(ran.run().1, "lease_lost");
    assert!(ran.sent().is_empty());
    let (metadata, dreamer_outbox): (String, i64) = ran
        .db
        .with_connection(|conn| {
            conn.query_row(
            "SELECT metadata_json, (SELECT COUNT(*) FROM replica_outbox WHERE actor = 'dreamer')
               FROM memories WHERE id = 1", [], |row| Ok((row.get(0)?, row.get(1)?)),
        )
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&metadata).unwrap(), before);
    assert_eq!(dreamer_outbox, 0);
}

/// A confirmed memory whose cited lines changed goes to the model with the
/// diff, here of a file it cites but is not mapped to, and the lines it was
/// confirmed from.
#[test]
fn a_confirmation_whose_cited_lines_changed_goes_to_the_model_with_them() {
    let fixture = Fixture::new(&[
        ("src/a.rs", "fn uses_cap() {}\n"),
        ("src/b.rs", "const CAP: u64 = 64_000;\n"),
    ]);
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture
        .repo
        .write(&[("src/b.rs", "const CAP: u64 = 32_000;\n")]);
    fixture.repo.commit("halve the cap");
    fixture.insert(&[Row {
        files: vec!["src/a.rs"],
        verified: Some((1_000, Some(first))),
        spans: vec![("src/b.rs", 1, 1, "const CAP: u64 = 64_000;")],
        ..row(1, "`uses_cap` reads `CAP`, which is 64k.")
    }]);
    let batches = fixture.batches(false);
    assert_eq!(batches.iter().map(ids).collect::<Vec<_>>(), [vec![1]]);
    assert!(batches[0].has_diff());
    let message = &batches[0].message;
    assert!(
        message.contains("Backing files: src/a.rs\nConfirmed from: src/b.rs:1-1\n</memories>"),
        "{message}"
    );
    assert!(message.contains("File: src/b.rs (memories: 1)\ndiff --git"));
    assert!(message.contains("-const CAP: u64 = 64_000;\n+const CAP: u64 = 32_000;\n"));
    // Nothing is recorded for it until the model decides.
    assert_eq!(
        fixture.memory(1).4["dreamerVerifiedCommit"],
        json!(fixture.repo.git(&["rev-parse", "HEAD~1"]).trim())
    );
}

#[test]
fn an_unsure_or_refused_recheck_of_a_stale_confirmation_waits() {
    for verdict in [
        r#"<skip id="1" reason="unsure: the cap changed"/>"#,
        r#"<update id="1">`CAP` is 32_000.</update>"#,
    ] {
        let fixture = Fixture::new(&[
            ("src/a.rs", "fn uses_cap() {}\n"),
            ("src/b.rs", "const CAP: u64 = 64_000;\n"),
        ]);
        let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        fixture
            .repo
            .write(&[("src/b.rs", "const CAP: u64 = 32_000;\n")]);
        fixture.repo.commit("halve the cap");
        fixture.insert(&[Row {
            files: vec!["src/a.rs"],
            verified: Some((1_000, Some(first))),
            spans: vec![("src/b.rs", 1, 1, "const CAP: u64 = 64_000;")],
            ..row(1, "`uses_cap` reads `CAP`, which is 64k.")
        }]);

        let batch = fixture.batches(false).remove(0);
        fixture.apply(&batch, &format!("<verify>{verdict}</verify>"));
        assert!(
            fixture.batches(false).is_empty(),
            "sent again after {verdict}"
        );

        fixture
            .repo
            .write(&[("src/b.rs", "const CAP: u64 = 16_000;\n")]);
        fixture.repo.commit("change the evidence again");
        let batch = fixture.batches(false).remove(0);
        fixture.apply(&batch, &format!("<verify>{verdict}</verify>"));
        assert!(fixture.batches(false).is_empty());
        fixture.execute(&format!(
            "UPDATE memories SET metadata_json = json_set(metadata_json, '$.dreamerCheckedAt', {}) WHERE id = 1",
            crate::memory_writes::now_ms() - RECHECK_AFTER_MS - 1,
        ));
        assert_eq!(
            fixture
                .batches(false)
                .iter()
                .flat_map(ids)
                .collect::<Vec<_>>(),
            [1]
        );
    }
}

/// Diff messages hold up to twenty memories; a memory checked by reading
/// goes alone.
#[test]
fn diff_batches_hold_twenty_memories_and_read_batches_one() {
    let fixture = Fixture::new(&[("src/a.rs", "old\n")]);
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture.repo.write(&[("src/a.rs", "new\n")]);
    fixture.repo.commit("change");
    let mut rows: Vec<Row> = (1..=25)
        .map(|id| Row {
            files: vec!["src/a.rs"],
            verified: Some((1_000, Some(first.clone()))),
            spans: vec![("src/a.rs", 1, 1, "old")],
            ..row(id, &format!("Fact {id}."))
        })
        .collect();
    rows.extend((26..=32).map(|id| Row {
        files: vec!["src/a.rs"],
        ..row(id, &format!("Fact {id}."))
    }));
    fixture.insert(&rows);
    let batches = fixture.batches(false);
    assert_eq!(
        batches
            .iter()
            .map(|batch| (batch.read().len(), batch.has_diff()))
            .collect::<Vec<_>>(),
        [
            (20, true),
            (5, true),
            (1, false),
            (1, false),
            (1, false),
            (1, false),
            (1, false),
            (1, false),
            (1, false)
        ]
    );
}

/// A memory a model called no code fact waits for new text; one it couldn't
/// confirm, or whose verdict the module refused, waits a week unless one of
/// its files changes. Without the wait, each went back to a model every
/// night with the same evidence and got the same answer.
#[test]
fn a_memory_decided_without_a_confirmation_waits_before_it_is_sent_again() {
    let fixture = Fixture::new(&[
        ("src/a.rs", "fn alpha() {}\n"),
        ("src/b.rs", "fn beta() {}\n"),
    ]);
    fixture.insert(&[
        Row {
            files: vec!["src/a.rs"],
            ..row(1, "OpenCode answers `alpha` in src/a.rs with a 403.")
        },
        Row {
            files: vec!["src/b.rs"],
            ..row(2, "`beta` in src/b.rs retries twice.")
        },
        Row {
            files: vec!["src/a.rs"],
            ..row(3, "`alpha` in src/a.rs takes no argument.")
        },
    ]);
    let replies = [
        (
            1,
            r#"<skip id="1" reason="about another program: OpenCode's answer"/>"#,
        ),
        (2, r#"<skip id="2" reason="unsure: no retry found"/>"#),
        // An empty rewrite the module refuses.
        (
            3,
            r#"<update id="3" files="src/a.rs" cites="src/a.rs:1-1"></update>"#,
        ),
    ];
    let sent = |fixture: &Fixture| -> Vec<i64> {
        let mut ids: Vec<i64> = fixture
            .batches(false)
            .iter()
            .flat_map(|batch| batch.memory_ids())
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(sent(&fixture), [1, 2, 3]);
    for batch in fixture.batches(false) {
        let id = batch.memory_ids()[0];
        let (_, verdict) = replies.iter().find(|(of, _)| *of == id).unwrap();
        let applied = fixture.apply(&batch, &format!("<verify>{verdict}</verify>"));
        if id == 3 {
            // The refusal reads as before; the memory is marked checked.
            assert_eq!(
                applied.dropped,
                ["memory 3: the update's text is empty or longer than 20000 characters"]
            );
        }
    }
    assert_eq!(fixture.memory(1).4[NOT_CODE_KEY], 1);
    assert_eq!(fixture.memory(2).4[NOT_CODE_KEY], Value::Null);
    assert_eq!(fixture.memory(3).4[CHECKED_REVISION_KEY], 1);
    assert!(sent(&fixture).is_empty());

    // A changed file brings back the unsure memory mapped to it.
    fixture
        .repo
        .write(&[("src/b.rs", "fn beta() { retry(); retry(); }\n")]);
    fixture.repo.commit("retry");
    assert_eq!(sent(&fixture), [2]);

    // New text brings back the memory no code could decide; a week brings
    // back the refused one.
    fixture
        .db
        .with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET content = '`alpha` in src/a.rs answers 403.', revision = 2
                  WHERE id = 1",
                [],
            )?;
            conn.execute(
                "UPDATE memories SET metadata_json = json_set(metadata_json, '$.dreamerCheckedAt', ?1)
                  WHERE id = 3",
                [crate::memory_writes::now_ms() - RECHECK_AFTER_MS - 1],
            )
        })
        .unwrap();
    assert_eq!(sent(&fixture), [1, 2, 3]);
}
