use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::{json, Value};

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::dreamer::checkout::tests::Repo;
use crate::memory_profile::{prompt_profile, Profile};
use crate::memory_writes::normalized_hash;

pub(crate) const PROJECT: &str = "pj-verify";

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
        self.plan_at(broad, declaration, self.repo.path())
    }

    /// The batches a run started from a session in `root` plans now.
    pub(crate) fn batches_at(&self, broad: bool, root: &std::path::Path) -> Vec<VerifyBatch> {
        let declaration = self.declaration(if broad { VERIFY_BROAD } else { VERIFY });
        self.plan_at(broad, &declaration, root)
    }

    fn plan_at(
        &self,
        broad: bool,
        declaration: &Value,
        root: &std::path::Path,
    ) -> Vec<VerifyBatch> {
        let owner = Owner::Project {
            id: PROJECT.into(),
            root: root.to_str().unwrap().into(),
        };
        Verify { broad }
            .plan_batches(&TaskContext {
                db: &self.db,
                owner: &owner,
                profile: &self.profile,
                declaration,
                workspace: None,
                guidance: None,
            })
            .unwrap()
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
/// live branches a memory without a line of its own is checked against.
pub(crate) fn replay_batch(
    declaration: &Value,
    broad: bool,
    project: &str,
    read: Vec<Read>,
    checkout: Arc<Checkout>,
    main: &std::path::Path,
) -> VerifyBatch {
    let gate = read.iter().any(|read| !read.lined).then(|| Gate::new(main));
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
        [vec![1, 5], vec![3, 6]]
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
    // A memory never confirmed with cited lines is checked by reading,
    // under the other message, with what a plain search didn't find.
    assert!(!batches[1].has_diff());
    let message = &batches[1].message;
    assert!(message.contains("Check each memory's claim against its backing files"));
    assert!(message.contains(
        "[3] ARCHITECTURE\nContent: C was never verified; it cites `missing_helper`.\nBacking files: src/c.rs\nNot found by a plain search of the checkout: missing_helper\n\n[6]"
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
    // They are read in full, never shown a diff; memory 4 needs nothing.
    let batches = fixture.batches(false);
    assert_eq!(batches.iter().map(ids).collect::<Vec<_>>(), [vec![1, 2, 3]]);
    assert!(!batches[0].has_diff());
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
        [vec![2, 6, 3, 1, 4], vec![5]]
    );
    let message = &batches[0].message;
    assert!(message.contains(
        "[2] ARCHITECTURE\nContent: `gone_function` in src/old/gone.rs does it.\nBacking files: (none mapped)\nNot found by a plain search of the checkout: gone_function, src/old/gone.rs\n\n[6]"
    ), "{message}");
    assert!(message
        .contains("[6] ARCHITECTURE\nContent: Never checked.\nBacking files: src/live.rs\n\n"));
    assert!(
        message.contains("Content: `live_function` runs first.\nBacking files: (none mapped)\n\n")
    );
    assert!(message.contains(
        "Backing files: (none mapped)\nNot found by a plain search of the checkout: gone_thing\n"
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
    assert_eq!(batches.iter().map(ids).collect::<Vec<_>>(), [vec![1, 2]]);
    assert!(
        !batches[0].message.contains("Not found by a plain search"),
        "{}",
        batches[0].message
    );
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

#[test]
fn a_broad_run_sends_five_memories_a_batch_and_only_covered_categories() {
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
        [5; 9]
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

/// The engine runs `verify-broad` end to end: the batch goes to a runner
/// that takes plans, with AFT's reader tools; a final message without a
/// complete manifest fails that model, and the next model's manifest is
/// applied.
#[tokio::test]
async fn a_broad_run_goes_through_the_engine_and_writes_what_the_reply_decides() {
    use crate::dreamer::engine::{Engine, Settings};
    use crate::dreamer::run::tests::{Client, Ends};

    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/gone.rs", "fn gone_function() {}\n")]);
    fixture.insert(&[
        row(1, "`live_function` runs first."),
        row(2, "`gone_function` does it."),
    ]);
    let db = Arc::new(fixture.db);
    let engine = Arc::new(Engine::new("this", vec![Box::new(Verify { broad: true })]));
    let mut client = Client::new(
        &["p/a", "p/b"],
        &[
            Ends::Reply("I checked both; they hold."),
            Ends::Reply(
                "<verify>\n<verified id=\"1\" files=\"src/live.rs\" cites=\"src/live.rs:1-1\"/>\n<archive id=\"2\" reason=\"its subject was removed\" missing=\"gone_function\"/>\n</verify>",
            ),
        ],
    );
    client.plans = vec!["ra", "rb"];
    client.catalog = Ok(vec![
        ("read", &["code.read/v1"]),
        ("grep", &[]),
        ("glob", &[]),
    ]);
    let client = Arc::new(client);
    // Canonical, as git names the main checkout (macOS keeps temp folders
    // under /private/var behind a /var link).
    let root = fixture
        .repo
        .path()
        .canonicalize()
        .unwrap()
        .display()
        .to_string();
    engine.see_project(
        &db,
        PROJECT,
        &root,
        Arc::new(fixture.profile),
        &Settings::default(),
        1,
    );
    db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
    engine.tick(
        &db,
        &client,
        &Settings::default(),
        crate::memory_writes::now_ms(),
    );
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
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (task, outcome, proposed, applied): (String, String, i64, i64) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT task, outcome, proposed, applied FROM dream_task_runs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .unwrap();
    assert_eq!(
        (task.as_str(), outcome.as_str(), proposed, applied),
        ("swe:verify-broad", "applied", 2, 2)
    );
    {
        let sends = client.sends.lock().unwrap();
        assert_eq!(sends.len(), 2, "the first model's reply was refused");
        let (child, request) = &sends[1];
        assert_eq!(child.project_root.as_deref(), Some(root.as_str()));
        let plan = request.plan.as_ref().expect("a plan");
        assert_eq!(
            plan["tool_items"],
            json!([{"params": {}, "preset": "reader", "provider": "aft"}])
        );
        assert_eq!(request.runner_params["stop_when"], json!({"max_steps": 60}));
    }
    let (verified_mapping, archived): (Vec<String>, String) = db
        .with_connection(|conn| {
            let mapping = conn
                .prepare("SELECT file_path FROM memory_verifications WHERE memory_id = 1")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()?;
            let status = conn.query_row("SELECT status FROM memories WHERE id = 2", [], |row| {
                row.get(0)
            })?;
            Ok::<_, rusqlite::Error>((mapping, status))
        })
        .unwrap();
    assert_eq!(verified_mapping, ["src/live.rs"]);
    assert_eq!(archived, "archived");
    let key: String = db
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

/// A confirmed memory whose file changed, but not the lines it cites, stays
/// confirmed without a model: the module finds the lines again, where they
/// moved, and records the new commit and their new place.
#[test]
fn a_confirmation_whose_cited_lines_are_unchanged_stays_without_a_model() {
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
    assert!(fixture.batches(false).is_empty(), "no model is asked");
    let (_, _, revision, verified_at, metadata, updated_at) = fixture.memory(1);
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
    let verify_commit: String = fixture
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT verify_commit FROM memories WHERE id = 1",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(verify_commit, second);
    // Nothing changed since the commit recorded, so the next run has
    // nothing to check either.
    assert!(fixture.batches(false).is_empty());
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
fn diff_batches_hold_twenty_memories_and_read_batches_five() {
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
        [(20, true), (5, true), (5, false), (2, false)]
    );
}
