use std::path::PathBuf;

use cortexkit_role_compaction::setup::ModelRef;
use serde_json::Value;

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, FRAMES};
use crate::memory_writes::normalized_hash;
use crate::summary::two_pass::{applier, gates};

const PROJECT: &str = "pj-classify";

/// A temporary store at the module's schema.
struct Store {
    _dir: tempfile::TempDir,
    db: ContextDb,
}

/// A memory row as the tests write it.
#[derive(Clone)]
struct Row {
    id: i64,
    level: &'static str,
    owner: &'static str,
    tag: &'static str,
    content: String,
    importance: Option<i64>,
    scope: &'static str,
    shareable: bool,
    safety_critical: Option<bool>,
    classified: bool,
    status: &'static str,
}

/// Memory `id`: a live, unclassified rule of the test project.
fn row(id: i64) -> Row {
    Row {
        id,
        level: "project",
        owner: PROJECT,
        tag: "PROJECT_RULES",
        content: format!("Rule {id}."),
        importance: Some(50),
        scope: "project",
        shareable: false,
        safety_critical: None,
        classified: false,
        status: "active",
    }
}

/// A memory's classification fields as the store holds them: importance,
/// scope, shareable, safety-critical, classified, revision.
type Stored = (Option<i64>, String, bool, Option<bool>, bool, i64);

fn store(rows: &[Row]) -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let store = Store { _dir: dir, db };
    store.insert(rows);
    store
}

impl Store {
    fn insert(&self, rows: &[Row]) {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            for row in rows {
                tx.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          importance, scope, shareable, safety_critical, classified_at, status,
                                          first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, 0, 0)",
                    params![
                        row.id,
                        row.level,
                        row.owner,
                        frozen_category_id(row.tag),
                        row.tag,
                        row.content,
                        normalized_hash(&row.content),
                        row.importance,
                        row.scope,
                        row.shareable,
                        row.safety_critical,
                        row.classified.then_some(1_i64),
                        row.status
                    ],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        });
    }

    fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    /// A pending classification item for `memory`, which the summarizer's
    /// second turn has sent `sends` times.
    fn item(&self, memory: i64, sends: usize) {
        self.db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO memory_classification_items(project_path, memory_id, saved_revision,
                         source_session_id, tool_call_part_id, save_ordinal, excerpt)
                 VALUES (?1, ?2, 1, 'session', ?3, 1, 'excerpt')",
                params![PROJECT, memory, format!("call-{memory}")],
            )
            .unwrap();
            let sequence = conn.last_insert_rowid();
            for send in 0..sends {
                conn.execute(
                    "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt,
                             stage, session_id, carrier, state, request_json, started_at)
                     VALUES (?1, ?2, 'publication', ?3, 'turn_two', 'session', 'carrier', 'replied', ?4, 0)",
                    params![
                        format!("stage-{memory}-{send}"),
                        PROJECT,
                        memory * 100 + send as i64,
                        json!({ "items": [sequence] }).to_string()
                    ],
                )
                .unwrap();
            }
        });
    }

    fn live(&self) -> Vec<Memory> {
        self.db
            .with_connection(|conn| live_memories(conn, PROJECT))
            .unwrap()
    }

    fn batches(&self) -> Vec<ClassifyBatch> {
        with_context(&self.db, |context| Classify.plan_batches(context).unwrap())
    }

    fn apply(&self, batch: &ClassifyBatch, text: &str, run: i64) -> Applied {
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
                    "SELECT importance, scope, shareable, safety_critical, classified_at IS NOT NULL, revision
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get::<_, i64>(2)? != 0,
                            row.get::<_, Option<i64>>(3)?.map(|flag| flag != 0),
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
            })
            .unwrap()
    }

    /// Every column of memory `id` except the ones a classification writes
    /// (importance, safety-critical, classified, updated, revision), by name.
    fn untouched(&self, id: i64) -> Vec<(String, rusqlite::types::Value)> {
        const WRITTEN: [&str; 5] = [
            "importance",
            "safety_critical",
            "classified_at",
            "updated_at",
            "revision",
        ];
        self.db.with_connection(|conn| {
            let mut statement = conn
                .prepare("SELECT * FROM memories WHERE id = ?1")
                .unwrap();
            let names: Vec<String> = statement
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            statement
                .query_row([id], |row| {
                    names
                        .iter()
                        .enumerate()
                        .filter(|(_, name)| !WRITTEN.contains(&name.as_str()))
                        .map(|(index, name)| Ok((name.clone(), row.get(index)?)))
                        .collect()
                })
                .unwrap()
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

    /// Every journal row: decision key and the decision it keeps.
    fn journal(&self) -> Vec<(String, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare("SELECT decision_key, before_json FROM memory_journal ORDER BY id")
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        serde_json::from_str(&row.get::<_, String>(1)?).unwrap(),
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    }
}

/// Run `body` with a classify context for the test project, on the bundled
/// profile.
fn with_context<T>(db: &ContextDb, body: impl FnOnce(&TaskContext<'_>) -> T) -> T {
    let profile = prompt_profile(None).unwrap();
    let declaration = profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == KIND)
        .unwrap()
        .clone();
    let owner = Owner::Project {
        id: PROJECT.into(),
        root: "/work/project".into(),
    };
    body(&TaskContext {
        db,
        owner: &owner,
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

/// A `<classify>` manifest with one entry per id and its attributes.
fn manifest(entries: &[(i64, &str)]) -> String {
    let lines: String = entries
        .iter()
        .map(|(id, attributes)| format!("<memory id=\"{id}\" {attributes}/>\n"))
        .collect();
    format!("<classify>\n{lines}</classify>")
}

fn ids(batch: &ClassifyBatch) -> Vec<i64> {
    batch.read.iter().map(|(id, _)| *id).collect()
}

/// The prompt the 0.49.x module in `crates_old/mc-module` pinned for two
/// memories, the second also a reference (`TS_VECTORS` in
/// `src/dream_tasks/classify.rs`, recorded from the TypeScript dreamer),
/// with one deliberate difference: pool entries no longer show the
/// memory's "current" values (see `classify::input`).
const ARCHIVED_PROMPT: &str = "## Task: Classify Project Memories\n\n**Project:** /repo\n\nScore EVERY memory in the pool below. Emit one <classify> manifest covering every id.\n\n### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)\n[2] PROJECT_RULES importance=91\nNever push without approval.\n\n### Memory pool to classify\n[1] PROJECT_FACTS\nUse <tags> & Unicode 日本語.\n\n[2] PROJECT_RULES\nNever push without approval.";

/// The pool of the planning vectors in that same file: memory `i + 1` has
/// importance `i % 101`, was classified unless `i % 3 == 0`, and has an
/// open classification item when `i % 9 == 0`.
fn vector_pool(count: i64) -> Store {
    let rows: Vec<Row> = (0..count)
        .map(|i| Row {
            importance: Some(i % 101),
            classified: i % 3 != 0,
            ..row(i + 1)
        })
        .collect();
    let store = store(&rows);
    for i in (0..count).filter(|i| i % 9 == 0) {
        store.item(i + 1, 0);
    }
    store
}

#[test]
fn planning_matches_the_archived_vectors() {
    let vectors: [(i64, u8, Vec<i64>); 6] = [
        (9, 1, vec![]),
        (10, 2, vec![]),
        (100, 2, vec![]),
        (
            101,
            3,
            vec![
                2, 5, 8, 11, 14, 18, 21, 24, 27, 32, 35, 38, 41, 45, 48, 51, 54, 57, 62, 65, 68,
                71, 75, 78, 81, 84, 89, 92, 95, 98,
            ],
        ),
        (
            160,
            3,
            vec![
                102, 104, 107, 9, 12, 14, 17, 120, 123, 125, 128, 30, 33, 35, 38, 41, 144, 147,
                149, 152, 54, 57, 59, 65, 69, 75, 80, 86, 90, 96,
            ],
        ),
        (
            231,
            3,
            vec![
                102, 104, 6, 210, 11, 215, 117, 119, 122, 24, 228, 29, 32, 36, 140, 44, 48, 152,
                156, 59, 63, 167, 171, 75, 179, 183, 86, 90, 194, 198,
            ],
        ),
    ];
    for (count, stage, anchors) in vectors {
        let plan = plan(&vector_pool(count).live());
        // Unclassified memories without an open item, unless the pool is too
        // small to classify at all.
        let targets: Vec<i64> = (0..count)
            .filter(|i| stage > 1 && i % 3 == 0 && i % 9 != 0)
            .map(|i| i + 1)
            .collect();
        assert_eq!(
            plan,
            Plan {
                stage,
                targets,
                anchors
            },
            "pool {count}"
        );
    }
    assert_eq!(plan(&vector_pool(10).live()).targets, [4, 7]);
}

#[test]
fn only_ten_or_more_live_memories_of_the_project_make_a_run() {
    let mut rows: Vec<Row> = (1..=9).map(row).collect();
    rows[0].status = "permanent";
    rows[1].classified = true;
    rows.extend([
        Row {
            status: "archived",
            ..row(10)
        },
        Row {
            owner: "pj-other",
            ..row(11)
        },
        Row {
            level: "workspace",
            ..row(12)
        },
        Row {
            level: "global",
            owner: "self",
            ..row(13)
        },
    ]);
    let store = store(&rows);
    assert!(store.batches().is_empty());
    // A tenth live memory of the project makes a run over the unclassified
    // ones; the classified memory counts toward the pool but isn't sent.
    store.insert(&[row(14)]);
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    assert_eq!(ids(&batches[0]), [1, 3, 4, 5, 6, 7, 8, 9, 14]);
    with_context(&store.db, |context| {
        assert_eq!(Classify.kind(), "classify-memories");
        assert_eq!(Classify.batches(context).unwrap().len(), 1);
    });
    // Nothing left to classify is nothing to send.
    store.execute("UPDATE memories SET classified_at = 1");
    assert!(store.batches().is_empty());
}

#[test]
fn an_open_classification_item_holds_its_memory_back_until_it_is_given_up() {
    let store = store(&(1..=10).map(row).collect::<Vec<_>>());
    // Still owed a score by the summarizer's second turn.
    store.item(3, 2);
    // Sent as often as the second turn sends an item: given up.
    store.item(4, MAX_STAGE2_ATTEMPTS as usize);
    // Scored already.
    store.item(5, 0);
    store.execute("UPDATE memory_classification_items SET state = 'scored' WHERE memory_id = 5");
    let batches = store.batches();
    assert_eq!(ids(&batches[0]), [1, 2, 4, 5, 6, 7, 8, 9, 10]);
}

#[test]
fn a_large_pool_goes_in_batches_of_a_hundred_with_the_same_references() {
    let rows: Vec<Row> = (0..245)
        .map(|i| Row {
            importance: Some(i % 101),
            classified: i % 7 == 0,
            ..row(i + 1)
        })
        .collect();
    let store = store(&rows);
    let batches = store.batches();
    let unclassified: Vec<i64> = (0..245).filter(|i| i % 7 != 0).map(|i| i + 1).collect();
    assert_eq!(
        batches
            .iter()
            .map(|batch| batch.read.len())
            .collect::<Vec<_>>(),
        [100, 100, 10]
    );
    assert_eq!(
        batches.iter().flat_map(ids).collect::<Vec<_>>(),
        unclassified
    );
    assert_eq!(
        batches[2].decision_key(7),
        "dream-run:7:classify-memories:2"
    );
    let references = |batch: &ClassifyBatch| -> String {
        let start = batch
            .message
            .find("### Already-classified reference memories")
            .expect("a references section");
        let end = batch.message.find("### Memory pool to classify").unwrap();
        batch.message[start..end].to_owned()
    };
    let first = references(&batches[0]);
    assert_eq!(
        first.lines().filter(|line| line.starts_with('[')).count(),
        30
    );
    for batch in &batches[1..] {
        assert_eq!(references(batch), first);
    }
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let memory = Memory {
        id: 1,
        category: "CONSTRAINTS".into(),
        content: "Releases need two reviewers.".into(),
        importance: Some(40),
        scope: "ecosystem".into(),
        shareable: false,
        revision: 1,
        classified: false,
        open_item: false,
    };
    let anchor = Memory {
        id: 2,
        category: "NAMING".into(),
        content: "Crates are named mc-*.".into(),
        importance: Some(70),
        classified: true,
        ..memory.clone()
    };
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace("⟦anchor.id⟧", "2")
        .replace("⟦anchor.category⟧", "NAMING")
        .replace("⟦anchor.importance⟧", "70")
        .replace("⟦anchor.content⟧", "Crates are named mc-*.")
        .replace("⟦memory.id⟧", "1")
        .replace("⟦memory.category⟧", "CONSTRAINTS")
        .replace("⟦memory.content⟧", "Releases need two reviewers.");
    let filled = filled.trim_end_matches('\n');
    assert_eq!(input(std::slice::from_ref(&memory), &[anchor]), filled);
    // Without references the section is left out whole.
    let pool = &filled[filled.find("### Memory pool to classify").unwrap()..];
    assert_eq!(input(&[memory], &[]), pool);
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
fn the_message_bytes_are_pinned() {
    // A small pool read from the store: real values, a missing importance,
    // a shareable memory, text that needs no escaping, and rows that aren't
    // sent (a classified memory, an archived one).
    let rows = [
        Row {
            content: "Never push without approval.".into(),
            importance: Some(91),
            ..row(1)
        },
        Row {
            tag: "ARCHITECTURE",
            content: "Use <tags> & Unicode 日本語.".into(),
            importance: None,
            scope: "universe",
            shareable: true,
            ..row(2)
        },
        Row {
            tag: "CONSTRAINTS",
            content: "Line one.\nLine two.".into(),
            importance: Some(30),
            scope: "ecosystem",
            ..row(3)
        },
        Row {
            tag: "CONFIG_VALUES",
            importance: Some(1),
            ..row(4)
        },
        Row {
            tag: "NAMING",
            importance: Some(100),
            ..row(5)
        },
        row(6),
        row(7),
        row(8),
        row(9),
        Row {
            classified: true,
            ..row(10)
        },
        Row {
            status: "archived",
            ..row(11)
        },
    ];
    let store = store(&rows);
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    golden("classify-memories-pool.txt", &batches[0].message);
    // The system prompt is the profile's, with the reply contract that asks
    // for the safety-critical flag.
    assert!(batches[0].system.starts_with("You are a memory classifier"));
    assert!(batches[0].system.contains("safety_critical=\"true\""));

    // With references: byte for byte the archived prompt above, for the same
    // memories.
    let first = Memory {
        id: 1,
        category: "PROJECT_FACTS".into(),
        content: "Use <tags> & Unicode 日本語.".into(),
        importance: Some(0),
        scope: "project".into(),
        shareable: true,
        revision: 1,
        classified: false,
        open_item: false,
    };
    let second = Memory {
        id: 2,
        category: "PROJECT_RULES".into(),
        content: "Never push without approval.".into(),
        importance: Some(91),
        scope: "universe".into(),
        shareable: false,
        ..first.clone()
    };
    let profile = prompt_profile(None).unwrap();
    let text = input(&[first, second.clone()], &[second]);
    let (_, message) = task_prompts(
        &profile,
        "swe:classify-memories",
        "user",
        &[(INPUT_FRAME, text.as_str())],
        &[("projectIdentity", "/repo")],
    )
    .unwrap();
    golden("classify-memories-references.txt", &message);
    assert_eq!(message, ARCHIVED_PROMPT);
}

#[test]
fn a_batch_offers_its_message_only_to_a_model_it_fits() {
    let store = store(&(1..=10).map(row).collect::<Vec<_>>());
    let batch = &store.batches()[0];
    let window = |context_window| Window {
        counter: Counter::for_model(None),
        context_window,
    };
    assert_eq!(
        batch.prompt(window(200_000), 32_000).as_deref(),
        Some(batch.message.as_str())
    );
    // The system prompt alone is over a thousand tokens.
    assert_eq!(batch.prompt(window(2_000), 500), None);
}

/// A classification with the given fields.
fn proposal(id: i64, importance: Option<i64>, safety_critical: Option<bool>) -> Classification {
    Classification {
        id,
        importance,
        safety_critical,
    }
}

/// A reply, the ids its batch sent, and what the gate makes of it.
type GateCase = (
    &'static str,
    Vec<i64>,
    Result<Vec<Classification>, &'static str>,
);

#[test]
fn the_manifest_gate_matches_the_archived_vectors() {
    let zero = "parsed zero entries; expected <classify> with <memory> entries";
    let missing = "classify manifest entry 1 missing classification fields";
    // The 0.49 module also read `scope` and `shareable`. They are ignored
    // now, so the archived replies that carry nothing else are missing
    // their classification fields, and an unknown scope is no error.
    let cases: Vec<GateCase> = vec![
        (
            r#"<classify><memory id="1" importance="0" scope="UNIVERSE" shareable="1"/><memory id="2" importance="999"/></classify>"#,
            vec![1, 2],
            Ok(vec![
                proposal(1, Some(1), None),
                proposal(2, Some(100), None),
            ]),
        ),
        (
            r#"<classify><memory id="1" shareable="FALSE"/></classify>"#,
            vec![1],
            Err(missing),
        ),
        (
            r#"<classify><memory id="1" importance="50"/></classify>"#,
            vec![1, 2],
            Err("classify manifest missing id 2"),
        ),
        (
            r#"<classify><memory id="3" importance="50"/></classify>"#,
            vec![1],
            Err("classify manifest contains unknown id 3"),
        ),
        (
            r#"<classify><memory id="1" importance="50"/><memory id="1" scope="project"/></classify>"#,
            vec![1],
            Err(missing),
        ),
        (
            r#"<classify><memory id="1" importance="50"/><memory id="1" safety_critical="true"/></classify>"#,
            vec![1],
            Err("classify manifest contains duplicate id 1"),
        ),
        (
            r#"<classify><memory id="1" scope="galaxy"/></classify>"#,
            vec![1],
            Err(missing),
        ),
        (
            r#"<classify><memory id="1" importance="40" scope="galaxy"/></classify>"#,
            vec![1],
            Ok(vec![proposal(1, Some(40), None)]),
        ),
        (
            r#"<classify><memory id="1"/></classify>"#,
            vec![1],
            Err(missing),
        ),
        (
            r#"<classify><memory id="1" importance="50"/>"#,
            vec![1],
            Err("classify manifest missing closing root tag"),
        ),
        ("<classify></classify>", vec![1], Err(zero)),
        ("<classify></classify>", vec![], Ok(vec![])),
        (
            r#"<classify><MEMORY id="1" importance="20"/></classify>"#,
            vec![1],
            Err(zero),
        ),
        (
            r#"{"memories":[]}"#,
            vec![1],
            Err("JSON object unrecognized; expected <classify> with <memory> entries"),
        ),
        (
            "<map/>",
            vec![1],
            Err("root <map> unrecognized; expected <classify> with <memory> entries"),
        ),
        // The safety-critical flag is a classification field of its own:
        // true, false, 1 or 0, in any case.
        (
            r#"<classify><memory id="1" safety_critical="TRUE"/><memory id="2" safety_critical="0"/></classify>"#,
            vec![1, 2],
            Ok(vec![
                proposal(1, None, Some(true)),
                proposal(2, None, Some(false)),
            ]),
        ),
        // A value outside true|false|1|0 reads as no value.
        (
            r#"<classify><memory id="1" importance="40" safety_critical="maybe"/></classify>"#,
            vec![1],
            Ok(vec![proposal(1, Some(40), None)]),
        ),
    ];
    for (text, expected_ids, expected) in cases {
        assert_eq!(
            validate_manifest(text, &expected_ids),
            expected.map_err(str::to_owned),
            "{text}"
        );
    }

    // The reply the profile's output contract shows, for real ids: only its
    // importance and safety_critical are read.
    let (_, contract) = FRAMES
        .iter()
        .find(|(name, _)| *name == "dreamer/classify-memories.output-contract")
        .unwrap();
    let sample = contract
        .replace("id=\"N\"", "id=\"4\"")
        .replace("id=\"M\"", "id=\"5\"");
    assert_eq!(
        validate_manifest(&sample, &[4, 5]),
        Ok(vec![
            proposal(4, Some(80), Some(true)),
            proposal(5, Some(20), Some(false)),
        ])
    );

    // A batch accepts exactly its own memories.
    let store = store(&(1..=10).map(row).collect::<Vec<_>>());
    let batch = &store.batches()[0];
    let all: Vec<(i64, &str)> = (1..=10).map(|id| (id, "importance=\"50\"")).collect();
    assert_eq!(batch.accepts(&manifest(&all)), Ok(()));
    assert_eq!(
        batch.accepts(&manifest(&all[1..])),
        Err("classify manifest missing id 1".to_owned())
    );
    let mut extra = all.clone();
    extra.push((11, "importance=\"50\""));
    assert_eq!(
        batch.accepts(&manifest(&extra)),
        Err("classify manifest contains unknown id 11".to_owned())
    );
}

/// Ten live, unclassified rules; memory 1 is already shareable.
fn apply_pool() -> Store {
    let mut rows: Vec<Row> = (1..=10).map(row).collect();
    rows[0].shareable = true;
    store(&rows)
}

/// What the reply in the apply tests says about memories 4 to 10: what they
/// already hold.
fn confirmed(from: i64) -> Vec<(i64, &'static str)> {
    (from..=10)
        .map(|id| (id, r#"importance="50" scope="project" shareable="false""#))
        .collect()
}

#[test]
fn applying_writes_each_changed_classification_with_one_history_decision() {
    let store = apply_pool();
    store.execute(
        "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         VALUES (1, 1, 0, 'clause', '[]')",
    );
    let batch = &store.batches()[0];
    let mut entries = vec![
        (
            1,
            r#"importance="90" scope="project" shareable="false" safety_critical="true""#,
        ),
        // Confirms what memory 2 holds: it only becomes classified.
        (2, r#"importance="50" scope="project" shareable="false""#),
        (
            3,
            r#"importance="20" scope="universe" shareable="false" safety_critical="false""#,
        ),
    ];
    entries.extend(confirmed(4));
    let text = manifest(&entries);
    let applied = store.apply(batch, &text, 7);
    assert_eq!(
        applied,
        Applied {
            proposed: 10,
            applied: 10,
            dropped: vec![],
        }
    );
    // The reply's scope and shareable are not read: memory 1 stays
    // shareable and memory 3 keeps its scope.
    assert_eq!(
        store.stored(1),
        (Some(90), "project".into(), true, Some(true), true, 2)
    );
    assert_eq!(
        store.stored(2),
        (Some(50), "project".into(), false, None, true, 1)
    );
    assert_eq!(
        store.stored(3),
        (Some(20), "project".into(), false, Some(false), true, 2)
    );
    // The changed memories, and only they, are in one decision named for
    // the run and the batch, each row at the revision it replaced.
    let history = store.history();
    let key = "dream-run:7:classify-memories:0";
    assert_eq!(
        history
            .iter()
            .map(|(id, revision, decision, _, _)| (*id, *revision, decision.as_str()))
            .collect::<Vec<_>>(),
        [(1, 1, key), (3, 1, key)]
    );
    let (_, _, _, before, after) = &history[0];
    assert_eq!(
        (
            &before["importance"],
            &before["shareable"],
            &before["revision"]
        ),
        (&json!(50), &json!(1), &json!(1))
    );
    assert_eq!(
        (
            &after["importance"],
            &after["shareable"],
            &after["revision"]
        ),
        (&json!(90), &json!(1), &json!(2))
    );
    let journal = store.journal();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].0, key);
    assert_eq!(journal[0].1["writer"], "dreamer:classify-memories");
    assert_eq!(journal[0].1["sourceIds"], json!([1, 3]));
    // The clause evidence moved to the new revision with the unchanged text.
    let evidence: Vec<i64> = store.db.with_connection(|conn| {
        conn.prepare(
            "SELECT revision FROM memory_clause_evidence WHERE memory_id = 1 ORDER BY revision",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
    });
    assert_eq!(evidence, [1, 2]);

    // The same reply again finds every memory already holding what it says.
    let stored: Vec<Stored> = (1..=10).map(|id| store.stored(id)).collect();
    let again = store.apply(batch, &text, 7);
    assert_eq!(
        again,
        Applied {
            proposed: 10,
            applied: 0,
            dropped: vec![],
        }
    );
    assert_eq!(
        (1..=10).map(|id| store.stored(id)).collect::<Vec<_>>(),
        stored
    );
    assert_eq!(store.history().len(), 2);
    assert_eq!(store.journal().len(), 1);
}

#[test]
fn applying_never_overwrites_a_memory_changed_or_retired_since_the_batch_read_it() {
    let store = apply_pool();
    let batch = &store.batches()[0];
    // Edited after the batch read it, and archived after it.
    store.execute(
        "UPDATE memories SET importance = 70, revision = 2 WHERE id = 2;
         UPDATE memories SET status = 'archived' WHERE id = 3;
         UPDATE memories SET owner_id = 'pj-other' WHERE id = 4;",
    );
    let entries: Vec<(i64, &str)> = (1..=10)
        .map(|id| (id, r#"importance="90" scope="project" shareable="false""#))
        .collect();
    let applied = store.apply(batch, &manifest(&entries), 7);
    assert_eq!(applied.applied, 7);
    assert_eq!(
        applied.dropped,
        [
            "memory 2 changed after the batch read it (revision 1, now 2)",
            "memory 3 is no longer a live memory of the project",
            "memory 4 is no longer a live memory of the project",
        ]
    );
    assert_eq!(
        store.stored(2),
        (Some(70), "project".into(), false, None, false, 2)
    );
    assert_eq!(
        store.stored(3),
        (Some(50), "project".into(), false, None, false, 1)
    );
    assert_eq!(
        store.stored(4),
        (Some(50), "project".into(), false, None, false, 1)
    );
    assert_eq!(
        store.stored(5),
        (Some(90), "project".into(), false, None, true, 2)
    );
    let changed: Vec<i64> = store.history().iter().map(|row| row.0).collect();
    assert_eq!(changed, [1, 5, 6, 7, 8, 9, 10]);
}

#[test]
fn a_reply_that_still_carries_scope_and_shareable_writes_only_importance_and_safety_critical() {
    let mut rows: Vec<Row> = (1..=10).map(row).collect();
    rows[0].shareable = true;
    rows[1].scope = "ecosystem";
    let store = store(&rows);
    let batch = &store.batches()[0];
    let untouched: Vec<_> = (1..=10).map(|id| store.untouched(id)).collect();
    // Each reply asks for a scope and a shareability the memory doesn't have.
    let mut entries = vec![
        (
            1,
            r#"importance="70" scope="universe" shareable="false" safety_critical="false""#,
        ),
        (2, r#"importance="50" scope="project" shareable="true""#),
        (
            3,
            r#"importance="85" scope="ecosystem" shareable="true" safety_critical="true""#,
        ),
    ];
    entries.extend(confirmed(4));
    let applied = store.apply(batch, &manifest(&entries), 7);
    assert_eq!(
        applied,
        Applied {
            proposed: 10,
            applied: 10,
            dropped: vec![],
        }
    );
    // Importance and the safety-critical flag are written.
    assert_eq!(
        store.stored(1),
        (Some(70), "project".into(), true, Some(false), true, 2)
    );
    // Memory 2 already holds the importance proposed: it only becomes
    // classified, at the same revision.
    assert_eq!(
        store.stored(2),
        (Some(50), "ecosystem".into(), false, None, true, 1)
    );
    assert_eq!(
        store.stored(3),
        (Some(85), "project".into(), false, Some(true), true, 2)
    );
    // No other column of any memory changed.
    assert_eq!(
        (1..=10).map(|id| store.untouched(id)).collect::<Vec<_>>(),
        untouched
    );
    let changed: Vec<i64> = store.history().iter().map(|row| row.0).collect();
    assert_eq!(changed, [1, 3]);
}

#[test]
fn applying_leaves_a_row_the_undo_history_cannot_record_unchanged() {
    let mut rows: Vec<Row> = (1..=10).map(row).collect();
    // A tag outside the categories history snapshots know.
    rows[0].tag = "DEV_NOTES";
    let store = store(&rows);
    let batch = &store.batches()[0];
    let mut entries = vec![(1, r#"importance="90""#)];
    entries.extend(confirmed(2));
    let applied = store.apply(batch, &manifest(&entries), 7);
    assert_eq!(
        applied.dropped,
        ["memory 1 holds a row the undo history can't record"]
    );
    assert_eq!(
        store.stored(1),
        (Some(50), "project".into(), false, None, false, 1)
    );
    assert!(store.history().is_empty());
}

#[test]
fn applying_keeps_a_safety_critical_memory_at_the_importance_floor() {
    let mut rows: Vec<Row> = (1..=10).map(row).collect();
    rows[1].importance = None;
    rows[2].importance = Some(30);
    rows[2].safety_critical = Some(true);
    let store = store(&rows);
    let batch = &store.batches()[0];
    let mut entries = vec![
        // Flagged with a score below the floor.
        (
            1,
            r#"importance="40" scope="project" shareable="false" safety_critical="true""#,
        ),
        // Flagged with no score, on a row that has none.
        (2, r#"scope="project" safety_critical="true""#),
        // Already flagged, and the reply confirms its low score.
        (3, r#"importance="30" scope="project" shareable="false""#),
        // Flagged above the floor.
        (4, r#"importance="95" safety_critical="true""#),
        // Not safety-critical: no floor.
        (5, r#"importance="20" safety_critical="false""#),
    ];
    entries.extend(confirmed(6));
    let applied = store.apply(batch, &manifest(&entries), 7);
    assert_eq!(applied.applied, 10);
    assert_eq!(
        store.stored(1),
        (Some(80), "project".into(), false, Some(true), true, 2)
    );
    assert_eq!(
        store.stored(2),
        (Some(80), "project".into(), false, Some(true), true, 2)
    );
    assert_eq!(
        store.stored(3),
        (Some(80), "project".into(), false, Some(true), true, 2)
    );
    assert_eq!(
        store.stored(4),
        (Some(95), "project".into(), false, Some(true), true, 2)
    );
    assert_eq!(
        store.stored(5),
        (Some(20), "project".into(), false, Some(false), true, 2)
    );
}

#[test]
fn a_classification_makes_a_second_turn_edit_read_before_it_stale() {
    let store = apply_pool();
    store.execute(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
             VALUES ('publication', 'pj-classify', 'session', 1, 0);
         INSERT INTO memory_pending_facts(id, project_path, publication_id, fact_index, category, content)
             VALUES (1, 'pj-classify', 'publication', 0, 'PROJECT_RULES', 'Rule 1, revised.');",
    );
    // The summarizer's second turn decides to rewrite memory 1, having read
    // it at revision `read`.
    let edit = |key: &str, read: i64| gates::Revision {
        key: key.into(),
        action: "edit".into(),
        project: PROJECT.into(),
        expected: vec![(1, read)],
        survivor: 1,
        final_text: "Rule 1, revised.".into(),
        changes: Vec::new(),
        added: Vec::new(),
        expires: None,
    };
    let plan = gates::Plan {
        checks: Vec::new(),
        kept: Vec::new(),
        spans: Vec::new(),
    };
    let commit = |key: &str, read: i64| {
        store
            .db
            .with_connection(|conn| {
                applier::commit_revision(conn, &edit(key, read), &plan, 1, None, None)
            })
            .unwrap()
    };
    let content = || -> String {
        store
            .db
            .with_connection(|conn| {
                conn.query_row("SELECT content FROM memories WHERE id = 1", [], |row| {
                    row.get(0)
                })
            })
            .unwrap()
    };
    // A classification lands between the read and the commit.
    let batch = &store.batches()[0];
    let mut entries = vec![(1, r#"importance="90""#)];
    entries.extend(confirmed(2));
    store.apply(batch, &manifest(&entries), 7);

    let stale = commit("turn-two:stale", 1);
    assert_eq!(
        (stale.state.as_str(), stale.reason.as_str()),
        ("retryable", "cas_loss")
    );
    assert_eq!(content(), "Rule 1.");
    assert_eq!(
        store.stored(1),
        (Some(90), "project".into(), true, None, true, 2)
    );
    // Read at the revision the classification left, the same edit applies.
    let fresh = commit("turn-two:fresh", 2);
    assert_eq!(fresh.state, "applied");
    assert_eq!(content(), "Rule 1, revised.");
}
