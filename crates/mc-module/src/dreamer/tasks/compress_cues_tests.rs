use std::path::PathBuf;

use cortexkit_role_compaction::setup::ModelRef;

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, FRAMES};
use crate::memory_writes::{normalized_hash, update_content};
use crate::summary::two_pass::{applier, gates};

const PROJECT: &str = "pj-cues";

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
    status: &'static str,
    updated_at: i64,
    expires_at: Option<i64>,
    cue: Option<String>,
    cue_hash: Option<String>,
    rejections: i64,
}

/// Memory `id`: a live rule of the test project with no cue.
fn row(id: i64) -> Row {
    Row {
        id,
        level: "project",
        owner: PROJECT,
        tag: "PROJECT_RULES",
        content: format!("Rule {id}."),
        importance: Some(50),
        status: "active",
        updated_at: 0,
        expires_at: None,
        cue: None,
        cue_hash: None,
        rejections: 0,
    }
}

/// Memory `id` with a cue written from its current text.
fn cued(id: i64) -> Row {
    let row = row(id);
    Row {
        cue: Some(format!("cue {id}")),
        cue_hash: Some(content_hash(&row.content)),
        ..row
    }
}

/// A memory's cue columns as the store holds them, with the fields a cue
/// must not touch: cue, cue hash, cue time, rejections, revision, updated at.
type Stored = (Option<String>, Option<String>, Option<i64>, i64, i64, i64);

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
                                          importance, status, expires_at, mural_cue, mural_cue_hash,
                                          mural_cue_rejection_count, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, ?14, 0)",
                    params![
                        row.id,
                        row.level,
                        row.owner,
                        frozen_category_id(row.tag),
                        row.tag,
                        row.content,
                        normalized_hash(&row.content),
                        row.importance,
                        row.status,
                        row.expires_at,
                        row.cue,
                        row.cue_hash,
                        row.rejections,
                        row.updated_at
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

    fn batches(&self) -> Vec<CompressCuesBatch> {
        with_context(&self.db, |context| {
            CompressCues.plan_batches(context).unwrap()
        })
    }

    fn apply(&self, batch: &CompressCuesBatch, text: &str) -> Applied {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply(text), 7).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    fn stored(&self, id: i64) -> Stored {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count, revision, updated_at
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
                        ))
                    },
                )
            })
            .unwrap()
    }

    /// Rows in the undo history and the journal.
    fn recorded(&self) -> (i64, i64) {
        self.db.with_connection(|conn| {
            let count = |table: &str| -> i64 {
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
            };
            (count("memory_history"), count("memory_journal"))
        })
    }

    /// Rewrite memory `id`'s text the way the memory writers do.
    fn edit(&self, id: i64, content: &str) {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            update_content(&tx, id, content, &normalized_hash(content)).unwrap();
            tx.commit().unwrap();
        });
    }
}

/// Run `body` with a compress-cues context for the test project, on the
/// bundled profile.
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

/// A `<cues>` manifest with one entry per id and its cue text.
fn manifest(entries: &[(i64, &str)]) -> String {
    let lines: String = entries
        .iter()
        .map(|(id, cue)| format!("<cue id=\"{id}\">{cue}</cue>\n"))
        .collect();
    format!("<cues>\n{lines}</cues>")
}

fn ids(batch: &CompressCuesBatch) -> Vec<i64> {
    batch.ids()
}

#[test]
fn a_memory_is_sent_until_it_has_a_cue_written_from_its_current_text() {
    let rows = [
        // No cue yet.
        row(1),
        // A cue written from older text.
        Row {
            cue: Some("old cue".into()),
            cue_hash: Some(content_hash("Rule 2, before an edit.")),
            ..row(2)
        },
        // A cue for the current text: not sent.
        cued(3),
        // Refused twice for its current text, still without a cue.
        Row {
            cue_hash: Some(content_hash("Rule 4.")),
            rejections: 2,
            ..row(4)
        },
        // A cue with no hash can't be shown as current.
        Row {
            cue: Some("unhashed".into()),
            ..row(5)
        },
        Row {
            status: "permanent",
            ..row(6)
        },
        Row {
            expires_at: Some(i64::MAX),
            ..row(7)
        },
        // Not live, or not the project's.
        Row {
            status: "archived",
            ..row(8)
        },
        Row {
            expires_at: Some(1),
            ..row(9)
        },
        Row {
            owner: "pj-other",
            ..row(10)
        },
        Row {
            level: "workspace",
            ..row(11)
        },
        Row {
            level: "global",
            owner: "self",
            ..row(12)
        },
    ];
    let store = store(&rows);
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    assert_eq!(ids(&batches[0]), [1, 2, 4, 5, 6, 7]);
    with_context(&store.db, |context| {
        assert_eq!(CompressCues.kind(), "compress-cues");
        assert_eq!(CompressCues.batches(context).unwrap().len(), 1);
    });
    // The engine runs the kind.
    assert!(crate::dreamer::tasks()
        .iter()
        .any(|task| task.kind() == "compress-cues"));
    // With every cue current there is nothing to send.
    store.execute(&format!(
        "UPDATE memories SET mural_cue = 'cue', mural_cue_hash = CASE id {} END WHERE id IN (1, 2, 4, 5, 6, 7)",
        [1, 2, 4, 5, 6, 7]
            .iter()
            .map(|id| format!("WHEN {id} THEN '{}'", content_hash(&format!("Rule {id}."))))
            .collect::<Vec<_>>()
            .join(" ")
    ));
    assert!(store.batches().is_empty());
}

#[test]
fn memories_go_in_batches_of_forty_by_tag_then_newest_first() {
    let tags = ["PROJECT_RULES", "ARCHITECTURE", "NAMING"];
    let rows: Vec<Row> = (1..=85)
        .map(|id| Row {
            tag: tags[id as usize % 3],
            updated_at: id % 5,
            ..row(id)
        })
        .collect();
    let store = store(&rows);
    let batches = store.batches();
    assert_eq!(
        batches
            .iter()
            .map(|batch| batch.sent.len())
            .collect::<Vec<_>>(),
        [40, 40, 5]
    );
    let mut expected = rows.clone();
    expected.sort_by(|left, right| {
        left.tag
            .cmp(right.tag)
            .then(right.updated_at.cmp(&left.updated_at))
            .then(left.id.cmp(&right.id))
    });
    assert_eq!(
        batches.iter().flat_map(ids).collect::<Vec<_>>(),
        expected.iter().map(|row| row.id).collect::<Vec<_>>()
    );
    // Every batch carries its own memories under the same instructions.
    for batch in &batches {
        assert_eq!(batch.system, batches[0].system);
        assert_eq!(
            batch.message.matches("\n[").count(),
            batch.sent.len(),
            "one entry per memory"
        );
    }
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let memory = Memory {
        id: 1,
        category: "CONSTRAINTS".into(),
        content: "Releases need two reviewers.".into(),
        importance: Some(75),
        cue: None,
        cue_hash: None,
    };
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace("⟦memory.id⟧", "1")
        .replace("⟦memory.category⟧", "CONSTRAINTS")
        .replace("⟦memory.content⟧", "Releases need two reviewers.");
    assert_eq!(
        input(std::slice::from_ref(&memory), Budget::default()),
        filled.trim_end_matches('\n')
    );
    // The importance and budget lines follow the memory: the budget is the
    // high one from importance 70, and a missing importance counts as 50.
    let budgets: Vec<String> = [Some(70), Some(69), None]
        .into_iter()
        .map(|importance| {
            input(
                &[Memory {
                    importance,
                    ..memory.clone()
                }],
                Budget::default(),
            )
        })
        .collect();
    assert!(budgets[0].contains("importance=70 (budget 90)"));
    assert!(budgets[1].contains("importance=69 (budget 50)"));
    assert!(budgets[2].contains("importance=50 (budget 50)"));
}

#[test]
fn the_budgets_come_from_the_task_settings() {
    let declaration = |settings: Value| serde_json::json!({ "settings": settings });
    assert_eq!(
        Budget::of(&declaration(serde_json::json!({}))),
        Ok(Budget::default())
    );
    let budget = Budget::of(&declaration(serde_json::json!({
        "cue_chars_high": 120, "cue_chars_low": 40, "cue_high_from": 60
    })))
    .unwrap();
    assert_eq!((budget.chars(60), budget.chars(59)), (120, 40));
    assert_eq!(
        validate_cue(&"x".repeat(41), 59, 1, budget),
        Err("over-budget 41>40".into())
    );
    assert!(Budget::of(&declaration(serde_json::json!({ "cue_chars_low": 0 }))).is_err());
    assert!(Budget::of(&declaration(serde_json::json!({ "cue_chars_high": 9.5 }))).is_err());
    // The bundled profile states 0.49's budgets.
    with_context(&store(&[]).db, |context| {
        assert_eq!(Budget::of(context.declaration), Ok(Budget::default()));
    });
}

/// What the 0.49 plugin's `buildCompressCuesPrompt` made for the pool of
/// `the_message_bytes_are_pinned`, recorded by running it.
const ARCHIVED_PROMPT: &str = "## Task: Compress Project Memory Cues\n\n**Project:** pj-cues\n\nCompress EVERY memory in the pool below into one mural cue. Emit one <cues> manifest with exactly one <cue> per id.\n\n### Memory pool to compress\n[2] ARCHITECTURE importance=50 (budget 50)\nUse <tags> & Unicode 日本語.\n\n[3] CONSTRAINTS importance=70 (budget 90)\nLine one.\nLine two.\n\n[4] NAMING importance=69 (budget 50)\nCrates are named mc-*.\n\n[6] PROJECT_RULES importance=80 (budget 90)\nRun the gate before pushing.\n\n[1] PROJECT_RULES importance=91 (budget 90)\nNever push without approval.\n\n[10] PROJECT_RULES importance=50 (budget 50)\nKeep #10 out of cues.";

/// The 0.49 plugin's `COMPRESS_CUES_SYSTEM_PROMPT`.
const ARCHIVED_SYSTEM: &str = r#"You compress project memories into mnemonic mural cues. Each cue is a compact pidgin anchor that lets a reader recall the full memory at a glance — NOT a sentence, NOT a summary. You do not select, rank, group, merge, or reword the underlying facts; you compress each supplied memory into one cue, independently.

### Cue grammar
- A cue is mnemonic shorthand, not prose. Prefer one to three distinctive tokens plus a relation. Use the symbols → ← ⊘ ∵ ≺ ≻ ∅ ∀ when they are shorter than words.
- Preserve exact identifiers, paths, commands, flags, versions, filenames, hashes, and code tokens VERBATIM. These are the anchor — never abbreviate or paraphrase them.
- Per-cue hard budget (in characters): 90 when importance >= 70, else 50. Exceeding the budget makes the cue unusable, so compress harder rather than overrun.
- Never put a source memory id (e.g. #7863) in a cue.
- XML-escape &, <, >, and quotes in cue text (&amp; &lt; &gt; &quot;).
- A PROHIBITION must mark the excluded thing as ⊘thing followed IMMEDIATELY by a terse parenthesized mechanism, e.g. ⊘cache write (ABI break). Keep parentheses balanced. Positive facts must be phrased WITHOUT trigger words (must not / never / without / instead of / exclude).
- Do not invent facts, add commentary, or restate the category. Compress only what the memory says.

### Output contract
Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<cues>
<cue id="7863">terse anchor → relation</cue>
<cue id="8102">⊘cache write (ABI break)</cue>
</cues>

Rules:
- Emit exactly one <cue> per memory in the pool below, using its id.
- The complete <cues> root must be closed. Do not wrap it in a Markdown fence."#;

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
    // A small pool read from the store: a missing importance, text that needs
    // no escaping, both sides of the budget line, two rules of one tag sent
    // newest first, a stale cue, and rows that aren't sent (a current cue,
    // an archived memory).
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
            ..row(2)
        },
        Row {
            tag: "CONSTRAINTS",
            content: "Line one.\nLine two.".into(),
            importance: Some(70),
            ..row(3)
        },
        Row {
            tag: "NAMING",
            content: "Crates are named mc-*.".into(),
            importance: Some(69),
            ..row(4)
        },
        cued(5),
        Row {
            content: "Run the gate before pushing.".into(),
            importance: Some(80),
            updated_at: 5,
            ..row(6)
        },
        Row {
            status: "archived",
            ..row(7)
        },
        Row {
            content: "Keep #10 out of cues.".into(),
            cue: Some("stale".into()),
            cue_hash: Some(content_hash("Keep #10 in cues.")),
            ..row(10)
        },
    ];
    let store = store(&rows);
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    golden("compress-cues-pool.txt", &batches[0].message);
    // Byte for byte what 0.49 sent for the same memories, under the same
    // system prompt.
    assert_eq!(batches[0].message, ARCHIVED_PROMPT);
    assert_eq!(batches[0].system, ARCHIVED_SYSTEM);
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
    // Too small for the system prompt and the message next to the reply.
    assert_eq!(batch.prompt(window(700), 500), None);
}

/// Each cue, the importance and memory id it is checked for, and why 0.49's
/// `validateCue` refused it (`None`: accepted). Recorded by running 0.49's
/// function on the same inputs; a memory id of 4242 stands for none.
const CUE_VECTORS: &[(&str, i64, i64, Option<&str>)] = &[
    ("queue name → worker", 50, 4242, None),
    (
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        50,
        4242,
        Some("over-budget 51>50"),
    ),
    (
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        80,
        4242,
        None,
    ),
    ("   ", 50, 4242, Some("empty")),
    // JavaScript trims U+FEFF but not U+0085; Rust's trim does the reverse.
    ("\u{FEFF}", 50, 4242, Some("empty")),
    ("\u{85}", 50, 4242, None),
    ("see #7863 for detail", 80, 7863, Some("leaked-id")),
    ("thing (mechanism", 80, 4242, Some("unbalanced-parens")),
    ("thing) (mechanism", 80, 4242, Some("unbalanced-parens")),
    (
        "must not write cache",
        80,
        4242,
        Some("prohibition-missing-marker"),
    ),
    (
        "MUST NOT write cache",
        80,
        4242,
        Some("prohibition-missing-marker"),
    ),
    ("Never mind", 80, 4242, Some("prohibition-missing-marker")),
    ("nevermore", 80, 4242, None),
    ("exclude_list", 80, 4242, None),
    ("excluded files", 80, 4242, None),
    ("⊘cache write", 80, 4242, Some("polarity-missing-mechanism")),
    ("⊘cache write (ABI break)", 80, 4242, None),
    ("⊘a (x) ⊘b", 80, 4242, Some("polarity-missing-mechanism")),
    ("⊘a ((x))", 80, 4242, None),
    ("⊘a ()", 80, 4242, Some("polarity-missing-mechanism")),
    ("leaked #123", 50, 123, Some("leaked-id")),
    ("PR #21729 → issue #31638", 50, 123, None),
    ("foreign #999", 50, 123, None),
    ("embedded #1234", 50, 123, None),
    // Word boundaries are ASCII, as in a JavaScript pattern without the `u`
    // flag.
    ("#123_x", 50, 123, None),
    ("#123é", 50, 123, Some("leaked-id")),
    ("#123-x", 50, 123, Some("leaked-id")),
    ("without ⊘x (y)", 80, 4242, None),
    ("éwithout", 80, 4242, Some("prohibition-missing-marker")),
    ("withouté", 80, 4242, Some("prohibition-missing-marker")),
];

#[test]
fn the_cue_checks_match_the_archived_vectors() {
    for (cue, importance, id, expected) in CUE_VECTORS {
        assert_eq!(
            validate_cue(cue, *importance, *id, Budget::default()),
            expected.map_or(Ok(()), |reason| Err(reason.to_owned())),
            "{cue:?} at importance {importance}"
        );
    }
    // The budget counts characters, not bytes, and holds at its edge.
    let budget = Budget::default();
    assert_eq!(validate_cue(&"x".repeat(90), 80, 1, budget), Ok(()));
    assert_eq!(
        validate_cue(&"x".repeat(91), 80, 1, budget),
        Err("over-budget 91>90".into())
    );
    assert_eq!(validate_cue(&"日".repeat(50), 50, 1, budget), Ok(()));
    assert_eq!(
        validate_cue(&"日".repeat(51), 50, 1, budget),
        Err("over-budget 51>50".into())
    );
}

/// A memory as a batch sent it, for the fallback vectors.
fn sent(id: i64, importance: Option<i64>, content: &str) -> Sent {
    Sent {
        id,
        importance,
        content: content.into(),
        hash: content_hash(content),
    }
}

#[test]
fn the_fallback_cue_matches_the_archived_vectors() {
    // Memory, the refused cue, and the cue 0.49's `deterministicFallbackCue`
    // wrote in its place.
    let cases: Vec<(Sent, String, String)> = vec![
        // The model's try, cut to its budget on a word.
        (
            sent(
                7,
                Some(90),
                "The repeater must remain stable for issue #31638.",
            ),
            "x ".repeat(49),
            ["x"; 45].join(" "),
        ),
        // The model's try without the memory's own id.
        (
            sent(7, Some(50), "Keep #7 stable."),
            "see #7 (ok)".into(),
            "see  (ok)".into(),
        ),
        // The memory's text without the prohibition marks.
        (
            sent(
                8,
                Some(50),
                "Never write the cache without the lock (it corrupts the index) and never skip it.",
            ),
            "must not write".into(),
            "write the cache the lock it".into(),
        ),
        (sent(9, Some(50), "((("), "(((".into(), "memory".into()),
        (sent(9, None, "   "), "   ".into(), "memory".into()),
        (
            sent(11, Some(80), &"word ".repeat(30)),
            "x".repeat(200),
            "x".repeat(90),
        ),
        // The start of the memory's text, cut mid-word when it has no space.
        (
            sent(
                12,
                Some(50),
                &"supercalifragilisticexpialidocious".repeat(3),
            ),
            "(".into(),
            "supercalifragilisticexpialidocioussupercalifragili".into(),
        ),
        (
            sent(
                13,
                Some(50),
                "a\u{A0}b\u{3000}c d\te f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg",
            ),
            "(".into(),
            "a\u{A0}b\u{3000}c d\te f g h i j k l m n o p q r s t u v w x y".into(),
        ),
        (
            sent(14, Some(50), "⊘ nothing to see (here"),
            ")".into(),
            "nothing to see here".into(),
        ),
    ];
    for (memory, last_try, expected) in cases {
        let fallback = fallback_cue(&memory, &last_try, Budget::default());
        assert_eq!(fallback, expected, "{:?}", memory.content);
        let importance = memory.importance.unwrap_or(50);
        assert_eq!(
            validate_cue(&fallback, importance, memory.id, Budget::default()),
            Ok(())
        );
    }
}

fn cue(id: i64, cue: &str) -> ProposedCue {
    ProposedCue {
        id,
        cue: cue.into(),
    }
}

#[test]
fn the_manifest_gate_matches_the_archived_vectors() {
    // What 0.49's `parseCuesManifest` made of each reply.
    let parsed: Vec<(&str, Result<Vec<ProposedCue>, &str>)> = vec![
        (
            r#"<cues><cue id="7">a &lt;b&gt; &amp; c</cue><cue id="8">plain</cue></cues>"#,
            Ok(vec![cue(7, "a <b> & c"), cue(8, "plain")]),
        ),
        (
            r#"<cues><cue id="7">only</cue><cue id="8">trunc"#,
            Err("cues manifest missing closing root tag"),
        ),
        (
            "here are your cues: none",
            Err("cues manifest missing complete root element"),
        ),
        (
            "sure, here you go:\n<cues><cue id=\"1\">x→y</cue></cues>\ndone",
            Ok(vec![cue(1, "x→y")]),
        ),
        (
            r#"<CUES attr="1"><cue  id="5" >  spaced  </cue><Cue id="6">ignored</Cue><cue id="7">&amp;lt;</cue></CUES>"#,
            Ok(vec![cue(5, "spaced"), cue(7, "&lt;")]),
        ),
        (
            "<cues><cue id=\"1\">line\none</cue></cues>",
            Ok(vec![cue(1, "line\none")]),
        ),
        (
            r#"<cuesx><cue id="1">a</cue></cuesx>"#,
            Err("cues manifest missing complete root element"),
        ),
        ("<cues></cues>", Ok(vec![])),
    ];
    for (text, expected) in parsed {
        assert_eq!(
            parse_manifest(text),
            expected.map_err(str::to_owned),
            "{text}"
        );
    }
    // Each memory the batch sent, exactly once, and no other.
    let coverage: Vec<(&str, Result<Vec<ProposedCue>, &str>)> = vec![
        ("<cues></cues>", Err("cues manifest missing id 4")),
        (
            r#"<cues><cue id="4">one</cue><cue id="4">two</cue></cues>"#,
            Err("cues manifest contains duplicate id 4"),
        ),
        (
            r#"<cues><cue id="4">ok</cue><cue id="99999">stray</cue></cues>"#,
            Err("cues manifest contains unknown id 99999"),
        ),
        (
            r#"<cues><cue id="4">ok</cue></cues>"#,
            Ok(vec![cue(4, "ok")]),
        ),
        // A cue that breaks the grammar still passes the gate: it is
        // checked on its own when the batch writes.
        (
            r#"<cues><cue id="4">oops (unbalanced</cue></cues>"#,
            Ok(vec![cue(4, "oops (unbalanced")]),
        ),
    ];
    for (text, expected) in coverage {
        assert_eq!(
            validate_manifest(text, &[4]),
            expected.map_err(str::to_owned),
            "{text}"
        );
    }

    // The reply the profile's output contract shows, for real ids.
    let (_, contract) = FRAMES
        .iter()
        .find(|(name, _)| *name == "dreamer/compress-cues.output-contract")
        .unwrap();
    let proposals = validate_manifest(contract, &[7863, 8102]).unwrap();
    assert_eq!(
        proposals,
        [
            cue(7863, "terse anchor → relation"),
            cue(8102, "⊘cache write (ABI break)")
        ]
    );
    for proposal in &proposals {
        assert_eq!(
            validate_cue(&proposal.cue, 50, proposal.id, Budget::default()),
            Ok(())
        );
    }

    // A batch accepts exactly its own memories.
    let store = store(&(1..=3).map(row).collect::<Vec<_>>());
    let batch = &store.batches()[0];
    let all = [(1, "one"), (2, "two"), (3, "three")];
    assert_eq!(batch.accepts(&manifest(&all)), Ok(()));
    assert_eq!(
        batch.accepts(&manifest(&all[1..])),
        Err("cues manifest missing id 1".to_owned())
    );
    assert_eq!(
        batch.accepts(&manifest(&[
            (1, "one"),
            (2, "two"),
            (3, "three"),
            (4, "four")
        ])),
        Err("cues manifest contains unknown id 4".to_owned())
    );
}

#[test]
fn applying_writes_each_valid_cue_with_the_hash_of_its_text_and_nothing_else() {
    let store = store(&[
        row(1),
        Row {
            cue: Some("old cue".into()),
            cue_hash: Some(content_hash("Rule 2, before an edit.")),
            ..row(2)
        },
        Row {
            importance: Some(80),
            ..row(3)
        },
    ]);
    let batch = &store.batches()[0];
    let before: Vec<Stored> = (1..=3).map(|id| store.stored(id)).collect();
    let text = manifest(&[
        (1, "rule one &amp; more"),
        (2, "rule → two"),
        // Over the low budget, inside the high one memory 3 has.
        (3, &"x".repeat(60)),
    ]);
    let applied = store.apply(batch, &text);
    assert_eq!(
        applied,
        Applied {
            proposed: 3,
            applied: 3,
            dropped: vec![],
        }
    );
    for (id, cue) in [
        (1, "rule one & more".to_owned()),
        (2, "rule → two".to_owned()),
        (3, "x".repeat(60)),
    ] {
        let (stored_cue, hash, at, rejections, revision, updated_at) = store.stored(id);
        assert_eq!(stored_cue.as_deref(), Some(cue.as_str()), "memory {id}");
        assert_eq!(hash, Some(content_hash(&format!("Rule {id}."))));
        assert!(at.is_some_and(|at| at > 0));
        // Display data: the memory's revision and update time stay.
        let was = &before[id as usize - 1];
        assert_eq!((rejections, revision, updated_at), (0, was.4, was.5));
    }
    assert_eq!(store.recorded(), (0, 0), "no history and no journal rows");
    // The mural shows them now.
    store.db.with_connection(|conn| {
        let cues = crate::mural::read_cues(conn, &[1, 2, 3]).unwrap();
        for id in 1..=3 {
            let cue = &cues[&id];
            assert_eq!(
                cue.hash.as_deref(),
                Some(content_hash(&format!("Rule {id}.")).as_str())
            );
        }
    });
    // Nothing is left to send.
    assert!(store.batches().is_empty());

    // The same reply again finds every memory holding its cue.
    let written: Vec<Stored> = (1..=3).map(|id| store.stored(id)).collect();
    let again = store.apply(batch, &text);
    assert_eq!(
        again,
        Applied {
            proposed: 3,
            applied: 0,
            dropped: vec![],
        }
    );
    assert_eq!(
        (1..=3).map(|id| store.stored(id)).collect::<Vec<_>>(),
        written
    );
    assert_eq!(store.recorded(), (0, 0));
}

#[test]
fn applying_drops_an_invalid_cue_and_writes_the_rest() {
    let store = store(&(1..=3).map(row).collect::<Vec<_>>());
    let batch = &store.batches()[0];
    let applied = store.apply(
        batch,
        &manifest(&[(1, "good anchor"), (2, "oops (unbalanced"), (3, "see #3")]),
    );
    assert_eq!(applied.applied, 1);
    assert_eq!(
        applied.dropped,
        [
            "memory 2: cue refused (unbalanced-parens), rejection 1 of 3",
            "memory 3: cue refused (leaked-id), rejection 1 of 3",
        ]
    );
    assert_eq!(store.stored(1).0.as_deref(), Some("good anchor"));
    assert_eq!(store.stored(2).0, None);
    assert_eq!(store.stored(3).0, None);
}

#[test]
fn applying_never_writes_a_cue_for_a_memory_changed_or_retired_since_the_batch_read_it() {
    let store = store(&(1..=6).map(row).collect::<Vec<_>>());
    let batch = &store.batches()[0];
    store.execute(
        "UPDATE memories SET content = 'Rule 2, edited.', normalized_hash = 'edited' WHERE id = 2;
         UPDATE memories SET status = 'archived' WHERE id = 3;
         UPDATE memories SET owner_id = 'pj-other' WHERE id = 4;
         UPDATE memories SET expires_at = 1 WHERE id = 5;
         UPDATE memories SET importance = 90, revision = 2 WHERE id = 6;",
    );
    let before: Vec<Stored> = (1..=6).map(|id| store.stored(id)).collect();
    let entries: Vec<(i64, String)> = (1..=6).map(|id| (id, format!("cue {id}"))).collect();
    let entries: Vec<(i64, &str)> = entries
        .iter()
        .map(|(id, cue)| (*id, cue.as_str()))
        .collect();
    let applied = store.apply(batch, &manifest(&entries));
    assert_eq!(
        applied.dropped,
        [
            "memory 2 changed after the batch read it",
            "memory 3 is no longer a live memory of the project",
            "memory 4 is no longer a live memory of the project",
            "memory 5 is no longer a live memory of the project",
        ]
    );
    // A new revision with the same text still takes the cue the text was
    // given.
    assert_eq!(applied.applied, 2);
    for id in [1, 6] {
        assert_eq!(store.stored(id).0, Some(format!("cue {id}")));
    }
    for id in 2..=5 {
        assert_eq!(store.stored(id), before[id as usize - 1], "memory {id}");
    }
}

#[test]
fn the_third_refusal_for_the_same_text_writes_the_fallback_cue() {
    let store = store(&[Row {
        content: "The repeater must remain stable for issue #31638.".into(),
        importance: Some(90),
        ..row(1)
    }]);
    let hash = content_hash("The repeater must remain stable for issue #31638.");
    let over_budget = "x ".repeat(49);
    let refuse = || {
        let batches = store.batches();
        assert_eq!(batches.len(), 1, "the memory is still sent");
        store.apply(&batches[0], &manifest(&[(1, &over_budget)]))
    };
    for count in 1..=2 {
        let applied = refuse();
        assert_eq!(applied.applied, 0);
        assert_eq!(
            applied.dropped,
            [format!(
                "memory 1: cue refused (over-budget 97>90), rejection {count} of 3"
            )]
        );
        let (cue, stored_hash, _, rejections, revision, _) = store.stored(1);
        assert_eq!(
            (cue, stored_hash.as_deref(), rejections, revision),
            (None, Some(hash.as_str()), count, 1)
        );
    }
    let applied = refuse();
    let fallback = ["x"; 45].join(" ");
    assert_eq!(applied.applied, 1);
    assert_eq!(
        applied.dropped,
        [format!("memory 1: cue refused (over-budget 97>90), rejection 3 of 3; wrote the fallback cue {fallback:?}")]
    );
    let (cue, stored_hash, _, rejections, revision, _) = store.stored(1);
    assert_eq!(
        (cue, stored_hash, rejections, revision),
        (Some(fallback), Some(hash), 0, 1)
    );
    assert!(store.batches().is_empty(), "a cue for the text is written");
    assert_eq!(store.recorded(), (0, 0));
}

#[test]
fn a_text_change_starts_the_refusal_count_again() {
    // Refuse memory 1's cue once more; the count the row then holds.
    let refuse = |store: &Store| -> i64 {
        let batches = store.batches();
        assert_eq!(batches.len(), 1, "the memory is still sent");
        store.apply(&batches[0], &manifest(&[(1, "broken (")]));
        store.stored(1).3
    };
    let edited = store(&[row(1)]);
    assert_eq!(refuse(&edited), 1);
    assert_eq!(refuse(&edited), 2);
    // An edit through the memory writers clears the cue columns, as 0.49's
    // did.
    edited.edit(1, "Rule 1, edited.");
    let (cue, hash, at, rejections, _, _) = edited.stored(1);
    assert_eq!((cue, hash, at, rejections), (None, None, None, 0));
    assert_eq!(refuse(&edited), 1);

    // A count kept for older text doesn't carry over to new text even when
    // nothing cleared it.
    let unreset = store(&[row(1)]);
    assert_eq!(refuse(&unreset), 1);
    assert_eq!(refuse(&unreset), 2);
    unreset.execute(
        "UPDATE memories SET content = 'Rule 1, edited.', normalized_hash = 'edited' WHERE id = 1",
    );
    assert_eq!(unreset.stored(1).3, 2);
    assert_eq!(refuse(&unreset), 1);
}

#[test]
fn a_cue_leaves_a_second_turn_edit_read_before_it_applicable() {
    let store = store(&(1..=2).map(row).collect::<Vec<_>>());
    store.execute(&format!(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
             VALUES ('publication', '{PROJECT}', 'session', 1, 0);
         INSERT INTO memory_pending_facts(id, project_path, publication_id, fact_index, category, content)
             VALUES (1, '{PROJECT}', 'publication', 0, 'PROJECT_RULES', 'Rule 1, revised.');"
    ));
    // The summarizer's second turn reads memory 1 at revision 1 and decides
    // to rewrite it; a cue is written before it commits.
    let batch = &store.batches()[0];
    store.apply(batch, &manifest(&[(1, "rule one"), (2, "rule two")]));
    assert_eq!(store.stored(1).0.as_deref(), Some("rule one"));
    let edit = gates::Revision {
        key: "turn-two:after-cue".into(),
        action: "edit".into(),
        project: PROJECT.into(),
        workspace: None,
        expected: vec![(1, 1)],
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
    let outcome = store
        .db
        .with_connection(|conn| applier::commit_revision(conn, &edit, &plan, 1, None, None))
        .unwrap();
    assert_eq!(outcome.state, "applied", "{}", outcome.reason);
    // The new text has no cue yet, so it is sent again.
    let (cue, hash, _, _, revision, _) = store.stored(1);
    assert_eq!((cue, hash, revision), (None, None, 2));
    assert_eq!(ids(&store.batches()[0]), [1]);
}
