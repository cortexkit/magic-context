use std::path::PathBuf;
use std::sync::Arc;

use cortexkit_role_compaction::setup::ModelRef;
use serde_json::Value;

use super::*;
use crate::context_db::ContextDb;
use crate::memory_profile::{prompt_profile, FRAMES};

/// A temporary store at the module's schema.
struct Store {
    _dir: tempfile::TempDir,
    db: ContextDb,
}

fn store() -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    Store { _dir: dir, db }
}

/// A memory row as the tests read it back: level, owner, category id, tag,
/// text, status, revision, importance, source type and metadata.
type Stored = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
);

impl Store {
    /// Memory `id` of `level`/`owner`, filed under `category` with `tag`.
    #[allow(clippy::too_many_arguments)]
    fn memory(
        &self,
        id: i64,
        level: &str,
        owner: &str,
        category: &str,
        tag: &str,
        content: &str,
        status: &str,
    ) {
        self.db
            .with_connection(|conn| {
                conn.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          status, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, 0, 0)",
                    params![id, level, owner, category, tag, content, normalized_hash(content), status],
                )
            })
            .unwrap();
    }

    /// A live global memory of the person.
    fn global(&self, id: i64, category: &str, tag: &str, content: &str) {
        self.memory(id, "global", "self", category, tag, content, "active");
    }

    /// Observation `id`, pending unless `consumed`.
    fn observation(
        &self,
        id: i64,
        content: &str,
        proposed: Option<&str>,
        session: &str,
        project: Option<&str>,
        consumed: bool,
    ) {
        self.db
            .with_connection(|conn| {
                conn.execute(
                    "INSERT INTO memory_observations(id, content, proposed_category, session_id, project_id,
                                                     created_at, consumed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        id,
                        content,
                        proposed,
                        session,
                        project,
                        now_ms() - 24 * 60 * 60 * 1000 + id,
                        consumed.then_some(5_i64)
                    ],
                )
            })
            .unwrap();
    }

    fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    fn batches(&self) -> Vec<ReviewBatch> {
        with_context(&self.db, &|_| {}, |context| {
            ReviewUserMemories.plan_batches(context).unwrap()
        })
    }

    fn batch(&self) -> ReviewBatch {
        let mut batches = self.batches();
        assert_eq!(batches.len(), 1);
        batches.remove(0)
    }

    /// Apply `text` to `batch` as run `run`. The fixture's unsorted line is
    /// left unsorted by every reply that doesn't name it, which adds the same
    /// entry to every dropped list; it is taken out here, and the tests on
    /// unsorted lines read it with [`Self::apply_all`].
    fn apply(&self, batch: &ReviewBatch, text: &str, run: i64) -> Applied {
        let mut applied = self.apply_all(batch, text, run);
        applied
            .dropped
            .retain(|reason| reason != "memory #2 left unsorted");
        applied
    }

    /// Apply `text` to `batch` as run `run`: everything applying did.
    fn apply_all(&self, batch: &ReviewBatch, text: &str, run: i64) -> Applied {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply(text), run).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    fn stored(&self, id: i64) -> Stored {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT level, owner_id, category, origin_category, content, status, revision, importance,
                            source_type, metadata_json
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                            row.get(8)?,
                            row.get(9)?,
                        ))
                    },
                )
            })
            .unwrap()
    }

    /// The ids of every memory row, in id order.
    fn memory_ids(&self) -> Vec<i64> {
        self.db.with_connection(|conn| {
            conn.prepare("SELECT id FROM memories ORDER BY id")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    }

    /// The observations still in review, in id order.
    fn pending(&self) -> Vec<i64> {
        self.db.with_connection(|conn| {
            conn.prepare("SELECT id FROM memory_observations WHERE consumed_at IS NULL ORDER BY id")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    }

    /// Every undo-history row: memory, revision, decision key, and the
    /// snapshots before and after.
    fn history(&self) -> Vec<(i64, i64, String, Value, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare(
                "SELECT memory_id, revision, decision_key, before_json, after_json FROM memory_history ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                let snapshot = |json: String| {
                    serde_json::from_str::<Value>(&json).unwrap()["snapshot"].clone()
                };
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    snapshot(row.get(3)?),
                    snapshot(row.get(4)?),
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
        })
    }

    /// Every journal row: owner, decision key and the decision it keeps.
    fn journal(&self) -> Vec<(String, String, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare(
                "SELECT project_path, decision_key, before_json FROM memory_journal ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    serde_json::from_str(&row.get::<_, String>(2)?).unwrap(),
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
        })
    }
}

/// The bundled profile and its review declaration, changed by `adjust`.
fn declaration(adjust: &dyn Fn(&mut Value)) -> (Profile, Value) {
    let profile = prompt_profile(None).unwrap();
    let mut declaration = profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == KIND)
        .unwrap()
        .clone();
    adjust(&mut declaration);
    (profile, declaration)
}

/// Run `body` with a review context for the person's own memories, on the
/// bundled profile, its declaration changed by `adjust`.
fn with_context<T>(
    db: &ContextDb,
    adjust: &dyn Fn(&mut Value),
    body: impl FnOnce(&TaskContext<'_>) -> T,
) -> T {
    let (profile, declaration) = declaration(adjust);
    body(&TaskContext {
        db,
        owner: &Owner::Global,
        profile: &profile,
        declaration: &declaration,
    })
}

fn reply(text: &str) -> TaskReply {
    TaskReply {
        text: text.into(),
        model: ModelRef::new("p", "m"),
        runner: "r".into(),
        child: "mc-dream:7:0.0".into(),
        usage: None,
    }
}

/// The person's memories and observations most tests start from:
/// - memory 1, a filed communication trait; memory 2, a line the 0.50
///   migration moved without a category; memory 3, a filed engineering
///   practice; memory 4, archived; memory 5, a project's; memory 6, a
///   boundary the person wrote from the apps;
/// - observations 101-103 about replies, 104 moved from 0.49 with no
///   proposed category, and 105 already taken out of review, all a day old.
fn fixture() -> Store {
    let store = store();
    store.global(
        1,
        "base:communication",
        "COMMUNICATION",
        "Prefers concise answers",
    );
    store.global(
        2,
        USER_UNSORTED_CATEGORY,
        "USER_MEMORY",
        "Expects changes to be tested",
    );
    store.global(
        3,
        "swe:engineering-practice",
        "ENGINEERING_PRACTICE",
        "Runs the test suite on a build server",
    );
    store.memory(
        4,
        "global",
        "self",
        "base:preferences",
        "PREFERENCES",
        "Likes tabs",
        "archived",
    );
    store.memory(
        5,
        "project",
        "pj-a",
        "swe:project-rules",
        "PROJECT_RULES",
        "Use bun",
        "active",
    );
    store.global(6, "base:boundaries", "BOUNDARIES", "Asks before pushing");
    store.execute("UPDATE memories SET source_type = 'person' WHERE id = 6");
    store.observation(
        101,
        "Asked for a shorter reply",
        Some("COMMUNICATION"),
        "ses_aaaaaaaaaaaaaaaaaaaa",
        Some("pj-a"),
        false,
    );
    store.observation(
        102,
        "Wanted the summary in one line",
        Some("COMMUNICATION"),
        "ses_bbbbbbbbbbbbbbbbbbbb",
        Some("pj-b"),
        false,
    );
    store.observation(
        103,
        "Cut the explanation short",
        Some("COMMUNICATION"),
        "ses_cccccccccccccccccccc",
        None,
        false,
    );
    store.observation(
        104,
        "Tests every change before handing it over",
        None,
        "ses_dddd",
        None,
        false,
    );
    store.observation(
        105,
        "Already reviewed",
        Some("PREFERENCES"),
        "ses_eeee",
        None,
        true,
    );
    store
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let memory = Memory {
        id: 1,
        category_id: "base:communication".into(),
        tag: "COMMUNICATION".into(),
        content: "Prefers concise answers".into(),
        revision: 1,
        protected: false,
    };
    // A memory the person wrote or edited is marked after its tag.
    let written = Memory {
        id: 2,
        category_id: "base:boundaries".into(),
        tag: "BOUNDARIES".into(),
        content: "Asks before pushing".into(),
        revision: 3,
        protected: true,
    };
    let candidate = |id: i64, session: &str, proposed: Option<&str>, content: &str| Candidate {
        id,
        content: content.into(),
        proposed: proposed.map(str::to_owned),
        session: session.into(),
    };
    let candidates = [
        candidate(
            1,
            "ses_0123456789abcdef",
            Some("COMMUNICATION"),
            "Asked for less",
        ),
        candidate(2, "ses_2", None, "Said \"short\" twice"),
        candidate(3, "ses_3", Some(" "), "Cut it"),
    ];
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace("⟦stableMemory.category⟧", "COMMUNICATION")
        .replace("⟦stableMemory.content⟧", "Prefers concise answers")
        .replace("⟦stableMemory2.category⟧", "BOUNDARIES")
        .replace("⟦stableMemory2.content⟧", "Asks before pushing")
        // The 0.49 review showed a session id's first twelve characters.
        .replace("⟦sid1⟧", "ses_01234567")
        .replace("⟦candidate1.category⟧", "COMMUNICATION")
        .replace("⟦candidate1.content⟧", "Asked for less")
        .replace("⟦sid2⟧", "ses_2")
        // A candidate without a proposed category shows `none`.
        .replace("⟦candidate2.category⟧", "none")
        .replace("⟦candidate2.content⟧", "Said \"short\" twice")
        .replace("⟦sid3⟧", "ses_3")
        .replace("⟦candidate3.category⟧", "none")
        .replace("⟦candidate3.content⟧", "Cut it");
    let filled = filled.trim_end_matches('\n');
    assert!(!filled.contains('⟦'), "{filled}");
    assert_eq!(
        input(
            &[
                (memory, "COMMUNICATION".into()),
                (written, "BOUNDARIES".into())
            ],
            &candidates
        ),
        filled
    );
    // With no live memories the list reads `(none)`, as in 0.49.
    let none = input(&[], &candidates[..1]);
    assert!(
        none.starts_with("### Current Stable User Memories\n(none)\n\n### Candidate Observations"),
        "{none}"
    );
}

#[test]
fn a_run_shows_every_live_global_memory_and_pending_observation() {
    let store = fixture();
    let batch = store.batch();
    // Archived memories, other owners' memories and observations already
    // taken out of review are not shown.
    assert_eq!(batch.memories, [(1, 1), (2, 1), (3, 1), (6, 1)]);
    assert_eq!(batch.candidates, [101, 102, 103, 104]);
    assert_eq!(batch.unsorted, [2]);
    assert_eq!(batch.protected, HashSet::from([6]));
    // A line moved without a category reads UNSORTED; a filed one shows its
    // category's tag; one the person wrote is marked protected.
    assert!(batch
        .message
        .contains("- Memory #1 [COMMUNICATION]: \"Prefers concise answers\"\n- Memory #2 [UNSORTED]: \"Expects changes to be tested\"\n- Memory #3 [ENGINEERING_PRACTICE]:"));
    assert!(batch
        .message
        .contains("- Memory #6 [BOUNDARIES, protected]: \"Asks before pushing\"\n"));
    assert!(batch.message.contains(
        "- Candidate #101 [session ses_aaaaaaaa, proposed COMMUNICATION]: \"Asked for a shorter reply\""
    ));
    assert!(batch.message.contains(
        "- Candidate #104 [session ses_dddd, proposed none]: \"Tests every change before handing it over\""
    ));
    assert!(!batch.message.contains("Likes tabs") && !batch.message.contains("Use bun"));
    assert!(!batch.message.contains("Already reviewed"));
    // The frame's blank line keeps the review rules apart from the list.
    assert!(
        batch
            .message
            .contains("handing it over\"\n\n### Review rules (fixed by Magic Context)\n"),
        "{}",
        batch.message
    );
    // The categories a change may name: the base profile's five and the
    // coding profile's two, all usable at the global level.
    let tags: Vec<&str> = batch
        .categories
        .iter()
        .map(|category| category.tag.as_str())
        .collect();
    assert_eq!(
        tags,
        [
            "COMMUNICATION",
            "PREFERENCES",
            "BOUNDARIES",
            "WORKING_STYLE",
            "IDENTITY",
            "ENGINEERING_PRACTICE",
            "DEV_ENVIRONMENT"
        ]
    );
    assert_eq!(batch.threshold, PROMOTION_THRESHOLD);
    let origin = batch.origin.unwrap();
    assert_eq!(origin.name, prompt_profile(None).unwrap().name);
}

#[test]
fn a_run_needs_enough_pending_observations_for_one_promotion_or_an_unsorted_line() {
    let store = fixture();
    store.execute("UPDATE memory_observations SET consumed_at = 9 WHERE id IN (103, 104)");
    // Two pending observations can't back a promotion, but an unsorted line
    // still needs filing: the run goes ahead.
    assert_eq!(store.batch().candidates, [101, 102]);
    // With every line filed there is nothing to send.
    store.execute("UPDATE memories SET category = 'base:working-style' WHERE id = 2");
    assert!(store.batches().is_empty());
    // A task setting lowers the threshold.
    let batches = with_context(
        &store.db,
        &|declaration| declaration["settings"] = json!({"promotion_threshold": 2}),
        |context| ReviewUserMemories.plan_batches(context).unwrap(),
    );
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].threshold, 2);
    assert_eq!(batches[0].candidates, [101, 102]);
    // An unsorted line alone, with no observation waiting, is a run too.
    store.execute(
        "UPDATE memory_observations SET consumed_at = 9;
         UPDATE memories SET category = 'mc:user-unsorted' WHERE id = 2;",
    );
    let batch = store.batch();
    assert!(batch.candidates.is_empty());
    assert_eq!(batch.unsorted, [2]);
}

#[test]
fn observations_waiting_over_thirty_days_leave_review_unreviewed() {
    let store = fixture();
    let day = 24 * 60 * 60 * 1000;
    store.execute(&format!(
        "UPDATE memory_observations SET created_at = {} WHERE id = 101;
         UPDATE memory_observations SET created_at = {} WHERE id = 102;",
        now_ms() - 31 * day,
        now_ms() - 29 * day,
    ));
    let batch = store.batch();
    assert_eq!(batch.candidates, [102, 103, 104]);
    // It is marked out of review, not deleted.
    assert_eq!(store.pending(), [102, 103, 104]);
    let kept: i64 = store
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM memory_observations WHERE id = 101 AND consumed_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(kept, 1);
}

#[test]
fn a_message_holds_the_unsorted_lines_then_the_oldest_observations_within_its_budget() {
    let counter = Counter::for_model(None);
    let memory = |id: i64, category: &str, content: &str| Memory {
        id,
        category_id: category.into(),
        tag: "T".into(),
        content: content.into(),
        revision: 1,
        protected: false,
    };
    let candidate = |id: i64, content: &str| Candidate {
        id,
        content: content.into(),
        proposed: None,
        session: "s".into(),
    };
    let words = |count: usize| vec!["word"; count].join(" ");
    let filed = memory(1, "base:communication", &words(50));
    let unsorted = [
        memory(2, USER_UNSORTED_CATEGORY, &words(30)),
        memory(3, USER_UNSORTED_CATEGORY, &words(30)),
    ];
    let candidates = [
        candidate(10, &words(30)),
        candidate(11, &words(5)),
        candidate(12, &words(5)),
    ];
    let memories = [filed.clone(), unsorted[0].clone(), unsorted[1].clone()];
    let cost = |text: &str| counter.count(text);
    let ids = |(memories, candidates): (Vec<Memory>, Vec<Candidate>)| {
        (
            memories.iter().map(|memory| memory.id).collect::<Vec<_>>(),
            candidates
                .iter()
                .map(|candidate| candidate.id)
                .collect::<Vec<_>>(),
        )
    };
    // Everything fits a large budget.
    assert_eq!(
        ids(fit(&memories, &candidates, counter, MESSAGE_TOKENS)),
        (vec![1, 2, 3], vec![10, 11, 12])
    );
    // Room for the filed line, both unsorted lines and the oldest
    // observation: the newer ones wait, though they are shorter.
    let budget = cost(&filed.content)
        + cost(&unsorted[0].content)
        + cost(&unsorted[1].content)
        + cost(&candidates[0].content);
    assert_eq!(
        ids(fit(&memories, &candidates, counter, budget)),
        (vec![1, 2, 3], vec![10])
    );
    // Unsorted lines come before any observation.
    let budget = cost(&filed.content) + cost(&unsorted[0].content);
    assert_eq!(
        ids(fit(&memories, &candidates, counter, budget)),
        (vec![1, 2], vec![])
    );
    // Filed lines are always shown, and the first waiting item goes in even
    // when nothing else fits.
    assert_eq!(
        ids(fit(&memories, &candidates, counter, 1)),
        (vec![1, 2], vec![])
    );
    assert_eq!(
        ids(fit(&memories[..1], &candidates, counter, 1)),
        (vec![1], vec![10])
    );

    // A run reads with the module's budget: forty observations of about
    // five hundred tokens each don't all fit one message.
    let store = fixture();
    store.execute("UPDATE memories SET category = 'base:working-style' WHERE id = 2");
    for id in 200..240 {
        store.observation(id, &words(500), None, "ses_long", None, false);
    }
    let batch = store.batch();
    let shown = batch.candidates.len();
    assert!(shown > 4 && shown < 44, "{shown}");
    // The oldest go first.
    assert_eq!(batch.candidates[..4], [101, 102, 103, 104]);
    assert_eq!(
        batch.candidates[4..],
        (200..200 + shown as i64 - 4).collect::<Vec<_>>()[..]
    );
    let text: u64 = store
        .db
        .with_connection(|conn| {
            Ok::<_, rusqlite::Error>(
                live_memories(conn)?
                    .iter()
                    .map(|memory| counter.count(&memory.content))
                    .sum::<u64>()
                    + pending_candidates(conn)?
                        .iter()
                        .filter(|candidate| batch.candidates.contains(&candidate.id))
                        .map(|candidate| counter.count(&candidate.content))
                        .sum::<u64>(),
            )
        })
        .unwrap();
    assert!(text <= MESSAGE_TOKENS, "{text}");
}

#[test]
fn the_task_runs_only_for_the_person_and_once_per_machine() {
    assert_eq!(ReviewUserMemories.kind(), "review-user-memories");
    assert!(ReviewUserMemories.global());
    assert!(crate::dreamer::tasks()
        .iter()
        .any(|task| task.kind() == KIND && task.global()));
    let store = fixture();
    let (profile, declaration) = declaration(&|_| {});
    let refused = ReviewUserMemories.plan_batches(&TaskContext {
        db: &store.db,
        owner: &Owner::Project {
            id: "pj-a".into(),
            root: "/work".into(),
        },
        profile: &profile,
        declaration: &declaration,
    });
    assert!(refused.is_err());
}

/// Compare `actual` with the golden file `name`. With
/// `MC_REGENERATE_DREAMER_GOLDENS` set, write it first.
fn golden(name: &str, actual: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/dreamer")
        .join(name);
    if std::env::var_os("MC_REGENERATE_DREAMER_GOLDENS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert_eq!(actual, expected, "{name}");
}

#[test]
fn the_request_bytes_are_pinned() {
    let batch = fixture().batch();
    golden("review-user-memories-system.txt", &batch.system);
    golden("review-user-memories-message.txt", &batch.message);
}

#[test]
fn a_batch_offers_its_message_only_to_a_model_it_fits() {
    let batch = fixture().batch();
    let window = |context_window| Window {
        counter: crate::count::Counter::for_model(None),
        context_window,
    };
    assert_eq!(
        batch.prompt(window(200_000), 32_000),
        Some(batch.message.clone())
    );
    // The system prompt and message are well over a thousand tokens.
    assert_eq!(batch.prompt(window(2_000), 500), None);
}

#[test]
fn a_reply_is_read_from_its_json_object() {
    let bare = r#"Here it is: {"promote": [], "consume_candidate_ids": [1, 2, 2]} done"#;
    let verdict = parse_verdict(bare).unwrap();
    // Each listed observation counts once.
    assert_eq!(verdict.consume, [Ok(1), Ok(2)]);
    let fenced = "```json\n{\"dismiss_existing\": [{\"memory_id\": 3}]}\n```";
    assert_eq!(
        parse_verdict(fenced).unwrap().dismiss,
        [Ok(Dismissal {
            memory_id: 3,
            reason: None
        })]
    );
    // Nothing a change can be read from: the next model is tried.
    for refused in [
        "No changes are warranted.",
        "{\"promote\": [",
        "[1, 2]",
        "{\"promote\": {\"content\": \"x\"}}",
        "{\"consume_candidate_ids\": 4}",
    ] {
        assert!(parse_verdict(refused).is_err(), "{refused}");
        assert!(fixture().batch().accepts(refused).is_err(), "{refused}");
    }
    // An entry no change can be read from is dropped on its own.
    let verdict = parse_verdict(
        r#"{"promote": [{"content": "  "}, {"content": "Likes tea", "category": "PREFERENCES", "candidate_ids": [1, "2"]}],
            "update_existing": [{"content": "x"}, {"memory_id": 4, "content": ""}],
            "dismiss_existing": [{"reason": "gone"}],
            "consume_candidate_ids": ["7"]}"#,
    )
    .unwrap();
    assert!(verdict.promote.iter().all(Result::is_err), "{verdict:?}");
    assert!(verdict.update.iter().all(Result::is_err), "{verdict:?}");
    assert!(verdict.dismiss.iter().all(Result::is_err), "{verdict:?}");
    assert!(verdict.consume.iter().all(Result::is_err), "{verdict:?}");
}

/// The reply the apply test sends: one promotion, one refiling update, one
/// dismissal, and every shown observation consumed.
const FULL_REPLY: &str = r#"{
  "promote": [
    { "content": "Prefers short, direct replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 103] }
  ],
  "update_existing": [
    { "memory_id": 2, "content": "Expects every change to be tested", "category": "ENGINEERING_PRACTICE", "candidate_ids": [104] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "Specific to one project" }
  ],
  "consume_candidate_ids": [101, 102, 103, 104]
}"#;

#[test]
fn applying_writes_each_change_with_history_naming_the_run() {
    let store = fixture();
    let batch = store.batch();
    let applied = store.apply(&batch, FULL_REPLY, 7);
    assert_eq!(
        applied,
        Applied {
            proposed: 7,
            applied: 7,
            dropped: Vec::new()
        }
    );
    let profile = prompt_profile(None).unwrap();

    // The promotion: a global memory of the person in the named category,
    // unscored, recording the observations behind it.
    let promoted = *store.memory_ids().last().unwrap();
    assert!(promoted > 5);
    let (level, owner, category, tag, content, status, revision, importance, source, metadata) =
        store.stored(promoted);
    assert_eq!(
        (
            level.as_str(),
            owner.as_str(),
            category.as_str(),
            tag.as_str()
        ),
        ("global", "self", "base:communication", "COMMUNICATION")
    );
    assert_eq!(
        (content.as_str(), status.as_str(), revision, importance),
        ("Prefers short, direct replies", "active", 1, None)
    );
    assert_eq!(source.as_deref(), Some("user-review"));
    assert_eq!(
        serde_json::from_str::<Value>(&metadata.unwrap()).unwrap(),
        json!({"source_candidate_ids": [101, 102, 103]})
    );
    let (origin, session, project): (Option<String>, Option<String>, Option<String>) = store
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT origin_profile, source_session_id, source_project_id FROM memories WHERE id = ?1",
                [promoted],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(origin, Some(profile.name.clone()));
    assert_eq!(session.as_deref(), Some("ses_aaaaaaaaaaaaaaaaaaaa"));
    assert_eq!(project.as_deref(), Some("pj-a"));

    // The update rewrote the moved line and filed it where it said.
    let updated = store.stored(2);
    assert_eq!(
        (
            updated.2.as_str(),
            updated.3.as_str(),
            updated.4.as_str(),
            updated.6
        ),
        (
            "swe:engineering-practice",
            "ENGINEERING_PRACTICE",
            "Expects every change to be tested",
            2
        )
    );
    // The dismissal archived the memory with its reason.
    let dismissed = store.stored(3);
    assert_eq!((dismissed.5.as_str(), dismissed.6), ("archived", 2));
    assert_eq!(
        serde_json::from_str::<Value>(&dismissed.9.unwrap()).unwrap()["archive_reason"],
        "Specific to one project"
    );
    // Memory 1 was not touched; every observation shown left review, and
    // the one already out of it stays out.
    assert_eq!(store.stored(1).6, 1);
    assert!(store.pending().is_empty());

    // One history decision per change, each keyed to the run.
    let history = store.history();
    let keys: Vec<(i64, i64, &str)> = history
        .iter()
        .map(|(id, revision, key, _, _)| (*id, *revision, key.as_str()))
        .collect();
    assert_eq!(
        keys,
        [
            (promoted, 0, "dream-run:7:review-user-memories:0"),
            (2, 1, "dream-run:7:review-user-memories:1"),
            (3, 1, "dream-run:7:review-user-memories:2"),
        ]
    );
    assert_eq!(history[0].3, Value::Null);
    assert_eq!(history[0].4["level"], "global");
    assert_eq!(history[1].3["categoryId"], USER_UNSORTED_CATEGORY);
    assert_eq!(history[1].4["categoryId"], "swe:engineering-practice");
    assert_eq!(history[2].3["status"], "active");
    assert_eq!(history[2].4["status"], "archived");
    let journal = store.journal();
    let operations: Vec<(&str, &str, &str, &str)> = journal
        .iter()
        .map(|(owner, key, decision)| {
            (
                owner.as_str(),
                key.as_str(),
                decision["operation"].as_str().unwrap(),
                decision["writer"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        operations,
        [
            (
                "self",
                "dream-run:7:review-user-memories:0",
                "promote",
                WRITER
            ),
            (
                "self",
                "dream-run:7:review-user-memories:1",
                "update",
                WRITER
            ),
            (
                "self",
                "dream-run:7:review-user-memories:2",
                "archive",
                WRITER
            ),
        ]
    );

    // The person's undo of the run puts every memory back.
    let owner = crate::memory_writes::person::global();
    let plan = store
        .db
        .with_connection(|conn| crate::memory_writes::person::plan_run_undo(conn, &owner, 7))
        .unwrap();
    assert!(plan.left.is_empty(), "{:?}", plan.left);
    let undone: Vec<i64> = plan.restore.iter().map(|(target, _)| target.id).collect();
    assert_eq!(undone, [2, 3, promoted]);
}

/// Apply `text` to a fresh fixture's batch: what applying did, and the store.
fn run_reply(text: &str) -> (Applied, Store) {
    let store = fixture();
    let batch = store.batch();
    let applied = store.apply(&batch, text, 7);
    (applied, store)
}

/// A reply with only `promote` entries.
fn promotions(entries: &str) -> String {
    format!(r#"{{"promote": [{entries}]}}"#)
}

#[test]
fn a_promotion_needs_enough_shown_pending_observations() {
    let memories = fixture().memory_ids();
    for (entry, reason) in [
        (
            r#"{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102]}"#,
            "promotion \"Prefers short replies\" names 2 observation(s); a promotion needs 3",
        ),
        (
            // Repeating an id doesn't make another observation.
            r#"{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 101, 102]}"#,
            "promotion \"Prefers short replies\" names 2 observation(s); a promotion needs 3",
        ),
        (
            r#"{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 999]}"#,
            "promotion \"Prefers short replies\" names candidate #999, which this review was not shown",
        ),
        (
            r#"{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 105]}"#,
            "promotion \"Prefers short replies\" names candidate #105, which this review was not shown",
        ),
    ] {
        let (applied, store) = run_reply(&promotions(entry));
        assert_eq!(applied.applied, 0, "{entry}");
        assert_eq!(applied.dropped, [reason], "{entry}");
        assert_eq!(store.memory_ids(), memories, "{entry}");
        assert_eq!(store.pending(), [101, 102, 103, 104], "{entry}");
    }

    // An observation taken out of review after the batch read it (the
    // person dismissed it) no longer backs a promotion.
    let store = fixture();
    let batch = store.batch();
    store.execute("UPDATE memory_observations SET consumed_at = 9 WHERE id = 103");
    let applied = store.apply(
        &batch,
        &promotions(
            r#"{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 103]}"#,
        ),
        7,
    );
    assert_eq!(
        applied.dropped,
        ["promotion \"Prefers short replies\" names candidate #103, which was already taken out of review"]
    );
    assert_eq!(store.memory_ids(), memories);
}

#[test]
fn a_promotion_needs_a_user_category_the_review_declares_for_global_memories() {
    let memories = fixture().memory_ids();
    for (category, reason) in [
        (None, "promotion \"Prefers short replies\" names no category"),
        (
            Some("UNSORTED"),
            "promotion \"Prefers short replies\": UNSORTED is not a user category this review may file a global memory under",
        ),
        (
            Some("PROJECT_RULES"),
            "promotion \"Prefers short replies\": PROJECT_RULES is not a user category this review may file a global memory under",
        ),
        (
            Some("TONE"),
            "promotion \"Prefers short replies\": TONE is not a user category this review may file a global memory under",
        ),
    ] {
        let category = category.map_or(String::new(), |category| format!(r#""category": "{category}", "#));
        let (applied, store) = run_reply(&promotions(&format!(
            r#"{{"content": "Prefers short replies", {category}"candidate_ids": [101, 102, 103]}}"#
        )));
        assert_eq!(applied.dropped, [reason]);
        assert_eq!(store.memory_ids(), memories);
    }
    // A tag in any case, or the category's id, names the category.
    for category in ["working_style", "base:working-style"] {
        let (applied, store) = run_reply(&promotions(&format!(
            r#"{{"content": "Plans before coding", "category": "{category}", "candidate_ids": [101, 102, 103]}}"#
        )));
        assert_eq!(
            (applied.applied, applied.dropped.len()),
            (1, 0),
            "{category}"
        );
        let promoted = *store.memory_ids().last().unwrap();
        assert_eq!(store.stored(promoted).2, "base:working-style");
        assert_eq!(store.stored(promoted).3, "WORKING_STYLE");
    }

    // A declared category that global memories may not use is not offered.
    let store = fixture();
    let batches = with_context(
        &store.db,
        &|declaration| {
            declaration["categories"]
                .as_array_mut()
                .unwrap()
                .push(json!("swe:project-rules"))
        },
        |context| ReviewUserMemories.plan_batches(context).unwrap(),
    );
    assert!(batches[0]
        .categories
        .iter()
        .all(|category| category.tag != "PROJECT_RULES"));
    assert_eq!(batches[0].categories.len(), 7);
}

#[test]
fn a_promotion_repeating_a_live_global_memory_is_dropped() {
    // Same normalized text as memory 3, in another category.
    let (applied, store) = run_reply(&promotions(
        r#"{"content": "runs the TEST suite   on a build server", "category": "WORKING_STYLE", "candidate_ids": [101, 102, 103]},
           {"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 103]},
           {"content": "Prefers short replies", "category": "PREFERENCES", "candidate_ids": [101, 102, 103]}"#,
    ));
    let promoted = store.memory_ids();
    assert_eq!(applied.applied, 1);
    // The second promotion of one text repeats the first one's memory.
    assert_eq!(
        applied.dropped,
        [
            "promotion \"runs the TEST suite   on a build server\" repeats live global memory #3"
                .to_owned(),
            format!(
                "promotion \"Prefers short replies\" repeats live global memory #{}",
                promoted.last().unwrap()
            ),
        ]
    );
    // An archived memory's text may come back.
    let (applied, _) = applied_to_archived();
    assert_eq!((applied.applied, applied.dropped.len()), (1, 0));
}

fn applied_to_archived() -> (Applied, Store) {
    run_reply(&promotions(
        r#"{"content": "Likes tabs", "category": "PREFERENCES", "candidate_ids": [101, 102, 103]}"#,
    ))
}

/// A reply with only `update_existing` entries.
fn updates(entries: &str) -> String {
    format!(r#"{{"update_existing": [{entries}]}}"#)
}

#[test]
fn an_update_keeps_a_filed_memorys_category_and_files_an_unsorted_one() {
    // The same category, or none, keeps a filed memory where it is.
    let (applied, store) = run_reply(&updates(
        r#"{"memory_id": 1, "content": "Prefers concise, direct answers", "category": "COMMUNICATION"},
           {"memory_id": 3, "content": "Runs tests on a build server"}"#,
    ));
    assert_eq!((applied.applied, applied.dropped.len()), (2, 0));
    assert_eq!(store.stored(1).2, "base:communication");
    assert_eq!(store.stored(1).4, "Prefers concise, direct answers");
    assert_eq!(store.stored(3).2, "swe:engineering-practice");

    // Another category for a filed memory is refused.
    let (applied, store) = run_reply(&updates(
        r#"{"memory_id": 1, "content": "Prefers concise answers in chat", "category": "PREFERENCES"}"#,
    ));
    assert_eq!(
        applied.dropped,
        ["update of memory #1 files it under PREFERENCES, but an update keeps the category a memory is filed under (COMMUNICATION)"]
    );
    assert_eq!(store.stored(1).4, "Prefers concise answers");

    // An unsorted line takes the category the update names, even with its
    // text unchanged; without a valid category it stays where it is.
    let (applied, store) = run_reply(&updates(
        r#"{"memory_id": 2, "content": "Expects changes to be tested", "category": "ENGINEERING_PRACTICE"}"#,
    ));
    assert_eq!((applied.applied, applied.dropped.len()), (1, 0));
    assert_eq!(
        (
            store.stored(2).2.as_str(),
            store.stored(2).3.as_str(),
            store.stored(2).6
        ),
        ("swe:engineering-practice", "ENGINEERING_PRACTICE", 2)
    );
    let (applied, store) = run_reply(&updates(
        r#"{"memory_id": 2, "content": "Expects changes to be tested first", "category": "UNSORTED"}"#,
    ));
    assert_eq!(
        applied.dropped,
        ["update of memory #2: UNSORTED is not a user category this review may file a global memory under"]
    );
    assert_eq!(store.stored(2).2, USER_UNSORTED_CATEGORY);
}

#[test]
fn an_update_needs_a_live_shown_memory_unchanged_since_the_review_read_it() {
    for (entry, reason) in [
        (
            r#"{"memory_id": 4, "content": "Likes tabs a lot", "category": "PREFERENCES"}"#,
            "update of memory #4: #4 is not a live global memory this review was shown",
        ),
        (
            r#"{"memory_id": 5, "content": "Use bun 1.3", "category": "PREFERENCES"}"#,
            "update of memory #5: #5 is not a live global memory this review was shown",
        ),
        (
            r#"{"memory_id": 1, "content": "Prefers concise answers", "category": "COMMUNICATION"}"#,
            "update of memory #1 changes nothing",
        ),
        (
            r#"{"memory_id": 1, "content": "runs the test suite on a BUILD server", "category": "COMMUNICATION"}"#,
            "update of memory #1 repeats live global memory #3",
        ),
    ] {
        let (applied, store) = run_reply(&updates(entry));
        assert_eq!(applied.dropped, [reason], "{entry}");
        assert!(store.history().is_empty(), "{entry}");
    }

    // A memory the person edited or archived after the batch read it is
    // left as they made it.
    let store = fixture();
    let batch = store.batch();
    store.execute(
        "UPDATE memories SET content = 'Prefers very concise answers', revision = 2 WHERE id = 1;
         UPDATE memories SET status = 'archived' WHERE id = 3;",
    );
    let applied = store.apply(
        &batch,
        &updates(
            r#"{"memory_id": 1, "content": "Prefers concise answers in chat", "category": "COMMUNICATION"},
               {"memory_id": 3, "content": "Runs tests remotely", "category": "ENGINEERING_PRACTICE"}"#,
        ),
        7,
    );
    assert_eq!(
        applied.dropped,
        [
            "update of memory #1: it changed after the review read it (revision 1, now 2)",
            "update of memory #3: it is no longer a live global memory",
        ]
    );
    assert_eq!(store.stored(1).4, "Prefers very concise answers");

    // One entry per memory: a memory two entries name is changed by neither.
    let (applied, store) = run_reply(
        r#"{"update_existing": [{"memory_id": 1, "content": "Prefers concise, direct answers", "category": "COMMUNICATION"}],
            "dismiss_existing": [{"memory_id": 1, "reason": "duplicate"}]}"#,
    );
    assert_eq!(
        applied.dropped,
        [
            "update of memory #1: #1 is named by more than one entry of the reply",
            "dismissal of memory #1: #1 is named by more than one entry of the reply"
        ]
    );
    assert_eq!(store.stored(1).4, "Prefers concise answers");
    assert_eq!(store.stored(1).5, "active");
}

#[test]
fn a_dismissal_archives_only_a_live_shown_memory() {
    let (applied, store) = run_reply(
        r#"{"dismiss_existing": [{"memory_id": 5, "reason": "x"}, {"memory_id": 4}, {"memory_id": 1}]}"#,
    );
    assert_eq!(
        applied.dropped,
        [
            "dismissal of memory #5: #5 is not a live global memory this review was shown",
            "dismissal of memory #4: #4 is not a live global memory this review was shown",
        ]
    );
    assert_eq!(applied.applied, 1);
    assert_eq!(store.stored(5).5, "active");
    assert_eq!(store.stored(1).5, "archived");
    // Without a reason nothing is added to the memory's metadata.
    assert_eq!(store.stored(1).9, None);
    assert_eq!(store.history()[0].2, "dream-run:7:review-user-memories:0");
}

#[test]
fn only_observations_this_review_was_shown_leave_review() {
    let (applied, store) = run_reply(r#"{"consume_candidate_ids": [101, 105, 999, 104]}"#);
    assert_eq!(
        applied.dropped,
        [
            "candidate #105 can't be consumed: this review was not shown it",
            "candidate #999 can't be consumed: this review was not shown it",
        ]
    );
    assert_eq!((applied.proposed, applied.applied), (4, 2));
    assert_eq!(store.pending(), [102, 103]);

    // One the person took out of review after the batch read it is not
    // counted again.
    let store = fixture();
    let batch = store.batch();
    store.execute("UPDATE memory_observations SET consumed_at = 9 WHERE id = 102");
    let applied = store.apply(&batch, r#"{"consume_candidate_ids": [102]}"#, 7);
    assert_eq!(
        applied.dropped,
        ["candidate #102 can't be consumed: it was already taken out of review"]
    );

    // The observations behind a written promotion or update leave review
    // even when the reply forgets to list them; those behind a dropped one
    // stay.
    let (applied, store) = run_reply(
        r#"{"promote": [{"content": "Prefers short replies", "category": "COMMUNICATION", "candidate_ids": [101, 102, 103]},
                        {"content": "Tests first", "category": "WORKING_STYLE", "candidate_ids": [104]}],
            "update_existing": [{"memory_id": 2, "content": "Expects changes to be tested", "category": "ENGINEERING_PRACTICE", "candidate_ids": [999]}]}"#,
    );
    assert_eq!(
        applied.dropped,
        [
            "promotion \"Tests first\" names 1 observation(s); a promotion needs 3",
            "update of memory #2 names candidate #999, which this review was not shown; it is not taken out of review",
        ]
    );
    assert_eq!(store.pending(), [104]);
}

#[tokio::test]
async fn a_due_review_runs_once_for_the_machine_through_the_engine() {
    use crate::dreamer::engine::{Engine, Settings};
    use crate::dreamer::run::tests::{Client, Ends};

    let Store { _dir, db } = fixture();
    let db = Arc::new(db);
    let engine = Arc::new(Engine::new("this", crate::dreamer::tasks()));
    let profile = Arc::new(prompt_profile(None).unwrap());
    let settings = Settings::default();
    // Two projects declare the review; the person gets one schedule for it,
    // and neither project gets one of its own. Their own tasks are due at
    // their next slot, after this test ends.
    let now = now_ms();
    engine.see_project(&db, "pj-a", "/work/a", Arc::clone(&profile), &settings, now);
    engine.see_project(&db, "pj-b", "/work/b", Arc::clone(&profile), &settings, now);
    let schedules = |db: &ContextDb| -> Vec<(String, String, Option<String>)> {
        db.with_connection(|conn| {
            conn.prepare(
                "SELECT level, owner_id, last_status FROM dream_schedules
                  WHERE task = 'base:review-user-memories' ORDER BY level, owner_id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
        })
    };
    assert_eq!(schedules(&db), [("global".into(), "self".into(), None)]);

    db.with_connection(|conn| {
        conn.execute(
            "UPDATE dream_schedules SET next_due_at = 1 WHERE level = 'global'",
            [],
        )
    })
    .unwrap();
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply(FULL_REPLY)]));
    engine.tick(&db, &client, &settings, now_ms());
    for _ in 0..500 {
        let unlocked: i64 = db
            .with_connection(|conn| {
                conn.query_row("SELECT COUNT(*) FROM dream_locks", [], |row| row.get(0))
            })
            .unwrap();
        if schedules(&db)[0].2.is_some() && unlocked == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // One child, in the folder of the first project seen.
    assert_eq!(client.children(), ["mc-dream:1.0:0.0"]);
    let root = client.sends.lock().unwrap()[0].0.project_root.clone();
    assert_eq!(root.as_deref(), Some("/work/a"));
    assert_eq!(
        schedules(&db),
        [("global".into(), "self".into(), Some("applied".into()))]
    );
    let run: (String, String, String, String, String, i64, i64) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT task, kind, level, owner_id, outcome, proposed, applied FROM dream_task_runs",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
        })
        .unwrap();
    assert_eq!(
        run,
        (
            "base:review-user-memories".into(),
            KIND.into(),
            "global".into(),
            "self".into(),
            "applied".into(),
            7,
            7
        )
    );
    // Every write names the run.
    let keys: Vec<String> = db.with_connection(|conn| {
        conn.prepare("SELECT decision_key FROM memory_history ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    });
    assert_eq!(
        keys,
        [
            "dream-run:1:review-user-memories:0",
            "dream-run:1:review-user-memories:1",
            "dream-run:1:review-user-memories:2"
        ]
    );
    let pending: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM memory_observations WHERE consumed_at IS NULL",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(pending, 0);
}

/// A reply with only `refile` entries.
fn refiles(entries: &str) -> String {
    format!(r#"{{"refile": [{entries}]}}"#)
}

#[test]
fn a_refile_files_an_unsorted_memory_and_keeps_its_text() {
    let store = fixture();
    store.execute(
        "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         VALUES (2, 1, 0, 'hash', '{}')",
    );
    let batch = store.batch();
    let applied = store.apply_all(
        &batch,
        &refiles(r#"{"memory_id": 2, "category": "ENGINEERING_PRACTICE"}"#),
        7,
    );
    assert_eq!(
        applied,
        Applied {
            proposed: 1,
            applied: 1,
            dropped: Vec::new()
        }
    );
    let (_, _, category, tag, content, status, revision, ..) = store.stored(2);
    assert_eq!(
        (
            category.as_str(),
            tag.as_str(),
            content.as_str(),
            status.as_str(),
            revision
        ),
        (
            "swe:engineering-practice",
            "ENGINEERING_PRACTICE",
            "Expects changes to be tested",
            "active",
            2
        )
    );
    // One history decision naming the run, with the row before and after.
    let history = store.history();
    assert_eq!(history.len(), 1);
    let (id, revision, key, before, after) = &history[0];
    assert_eq!(
        (*id, *revision, key.as_str()),
        (2, 1, "dream-run:7:review-user-memories:0")
    );
    assert_eq!(before["categoryId"], USER_UNSORTED_CATEGORY);
    assert_eq!(after["categoryId"], "swe:engineering-practice");
    assert_eq!(before["content"], after["content"]);
    assert_eq!(store.journal()[0].2["operation"], "refile");
    // The text's clause evidence moves to the new revision with it.
    let evidence: Vec<i64> = store.db.with_connection(|conn| {
        conn.prepare(
            "SELECT revision FROM memory_clause_evidence WHERE memory_id = 2 ORDER BY revision",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
    });
    assert_eq!(evidence, [1, 2]);
}

#[test]
fn a_refile_is_dropped_for_a_filed_memory_an_unusable_category_or_a_memory_named_twice() {
    for (reply, reasons) in [
        (
            refiles(r#"{"memory_id": 1, "category": "PREFERENCES"}"#),
            vec!["refile of memory #1: it is not UNSORTED, so it keeps its category (COMMUNICATION)"],
        ),
        (
            refiles(r#"{"memory_id": 2, "category": "TONE"}"#),
            vec!["refile of memory #2: TONE is not a user category this review may file a global memory under"],
        ),
        (
            refiles(r#"{"memory_id": 2, "category": "PROJECT_RULES"}"#),
            vec!["refile of memory #2: PROJECT_RULES is not a user category this review may file a global memory under"],
        ),
        (
            refiles(r#"{"memory_id": 2, "category": "UNSORTED"}"#),
            vec!["refile of memory #2: UNSORTED is not a user category this review may file a global memory under"],
        ),
        (
            refiles(r#"{"memory_id": 2}"#),
            vec!["refile of memory #2 names no category"],
        ),
        (
            refiles(r#"{"memory_id": 4, "category": "PREFERENCES"}"#),
            vec!["refile of memory #4: #4 is not a live global memory this review was shown"],
        ),
        (
            refiles(r#"{"category": "PREFERENCES"}"#),
            vec!["refile 1 names no memory id"],
        ),
        (
            r#"{"update_existing": [{"memory_id": 2, "content": "Expects every change to be tested", "category": "ENGINEERING_PRACTICE"}],
                "refile": [{"memory_id": 2, "category": "WORKING_STYLE"}]}"#
                .to_owned(),
            vec![
                "update of memory #2: #2 is named by more than one entry of the reply",
                "refile of memory #2: #2 is named by more than one entry of the reply",
            ],
        ),
        (
            refiles(
                r#"{"memory_id": 2, "category": "WORKING_STYLE"}, {"memory_id": 2, "category": "BOUNDARIES"}"#,
            ),
            vec![
                "refile of memory #2: #2 is named by more than one entry of the reply",
                "refile of memory #2: #2 is named by more than one entry of the reply",
            ],
        ),
    ] {
        let store = fixture();
        let batch = store.batch();
        let applied = store.apply_all(&batch, &reply, 7);
        // Only the entry is dropped; the memory stays unsorted and says so.
        let mut expected: Vec<String> = reasons.iter().map(|reason| reason.to_string()).collect();
        expected.push("memory #2 left unsorted".into());
        assert_eq!(applied.dropped, expected, "{reply}");
        assert_eq!(applied.applied, 0, "{reply}");
        assert_eq!(store.stored(1).2, "base:communication", "{reply}");
        assert_eq!(store.stored(2).2, USER_UNSORTED_CATEGORY, "{reply}");
        assert!(store.history().is_empty(), "{reply}");
    }
}

#[test]
fn an_unsorted_memory_the_reply_leaves_out_stays_and_is_listed() {
    let store = fixture();
    store.global(7, USER_UNSORTED_CATEGORY, "USER_MEMORY", "Works late");
    let batch = store.batch();
    assert_eq!(batch.unsorted, [2, 7]);
    // A reply that names neither applies the rest and lists both.
    let applied = store.apply_all(&batch, r#"{"consume_candidate_ids": [101]}"#, 7);
    assert_eq!(
        applied,
        Applied {
            proposed: 1,
            applied: 1,
            dropped: vec![
                "memory #2 left unsorted".into(),
                "memory #7 left unsorted".into()
            ]
        }
    );
    assert_eq!(store.stored(2).2, USER_UNSORTED_CATEGORY);
    assert_eq!(store.pending(), [102, 103, 104]);

    // An update without a category leaves the line unsorted too; a
    // dismissed one is no longer listed.
    let store = fixture();
    store.global(7, USER_UNSORTED_CATEGORY, "USER_MEMORY", "Works late");
    let batch = store.batch();
    let applied = store.apply_all(
        &batch,
        r#"{"update_existing": [{"memory_id": 2, "content": "Expects every change to be tested"}],
            "dismiss_existing": [{"memory_id": 7, "reason": "one-off"}]}"#,
        7,
    );
    assert_eq!(applied.applied, 2);
    assert_eq!(applied.dropped, ["memory #2 left unsorted"]);
    assert_eq!(store.stored(2).4, "Expects every change to be tested");
    assert_eq!(store.stored(7).5, "archived");
}

#[test]
fn a_memory_the_person_wrote_or_edited_is_never_updated_or_archived() {
    let store = fixture();
    // Memory 1 was edited by the person: its history names a person_edit.
    // Memory 3 was edited by an agent.
    store.execute(
        "UPDATE memories SET revision = 2 WHERE id IN (1, 3);
         INSERT INTO memory_history(memory_id, revision, previous_text, after_text, applied_at, reason,
                                    evidence_json, source_ids_json, decision_key)
         VALUES (1, 1, 'Prefers short answers', 'Prefers concise answers', 5, 'person_edit', '[]', '[1]', 'person-key');
         INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
         VALUES ('self', 'person-key', 'person_edit', '{}', 5);
         INSERT INTO memory_history(memory_id, revision, previous_text, after_text, applied_at, reason,
                                    evidence_json, source_ids_json, decision_key)
         VALUES (3, 1, 'a', 'b', 5, 'edit', '[]', '[3]', 'agent-key');
         INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
         VALUES ('self', 'agent-key', 'edit', '{}', 5);",
    );
    let batch = store.batch();
    // Memory 6 the person wrote from the apps; memory 1 they edited; memory 3
    // was edited by someone else.
    assert_eq!(batch.protected, HashSet::from([1, 6]));
    assert!(batch
        .message
        .contains("- Memory #1 [COMMUNICATION, protected]: \"Prefers concise answers\""));
    assert!(batch
        .message
        .contains("- Memory #3 [ENGINEERING_PRACTICE]: \"Runs the test suite on a build server\""));
    let applied = store.apply(
        &batch,
        r#"{"update_existing": [{"memory_id": 1, "content": "Prefers concise, direct answers", "category": "COMMUNICATION"},
                               {"memory_id": 3, "content": "Runs tests on a build server", "category": "ENGINEERING_PRACTICE"}],
            "dismiss_existing": [{"memory_id": 6, "reason": "stale"}]}"#,
        7,
    );
    assert_eq!(
        applied.dropped,
        [
            "update of memory #1: the person wrote or edited it, so the review may not change it",
            "dismissal of memory #6: the person wrote or edited it, so the review may not archive it",
        ]
    );
    assert_eq!(applied.applied, 1);
    assert_eq!(store.stored(1).4, "Prefers concise answers");
    assert_eq!(store.stored(6).5, "active");
    assert_eq!(store.stored(3).4, "Runs tests on a build server");
}
