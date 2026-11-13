use std::path::PathBuf;

use cortexkit_role_compaction::setup::ModelRef;
use serde_json::{json, Value};

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::memory_profile::prompt_profile;
use crate::memory_writes::person::{self, OwnerRef, Target};

const PROJECT: &str = "pj-curate";
const RUN: i64 = 7;

/// A temporary store at the module's schema, and a project folder.
struct Store {
    dir: tempfile::TempDir,
    db: ContextDb,
}

/// A memory row as the tests write it.
#[derive(Clone)]
struct Row {
    id: i64,
    tag: &'static str,
    content: String,
    importance: Option<i64>,
    status: &'static str,
    safety_critical: Option<bool>,
    authority: &'static str,
    source_type: &'static str,
}

fn row(id: i64, tag: &'static str, content: &str) -> Row {
    Row {
        id,
        tag,
        content: content.into(),
        importance: Some(50),
        status: "active",
        safety_critical: None,
        authority: "learned",
        source_type: "historian",
    }
}

fn store(rows: &[Row]) -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    std::fs::create_dir_all(dir.path().join("project")).unwrap();
    let store = Store { dir, db };
    store.insert(rows);
    store
}

/// The project's ARCHITECTURE.md in the fixtures.
const DOCS: &str = "# Layout\n\nRun scripts/gate.sh preflight before every delivery of a change.\nA <frame> is filled by the module & never by a profile.\n";

/// The memories most tests curate: rules of the project, one of each kind
/// of protected memory, and an architecture memory every session sees.
fn fixture() -> Store {
    let mut rows = vec![
        row(1, "PROJECT_RULES", "Run `cargo fmt --all` before every commit in crates/mc-module."),
        row(2, "PROJECT_RULES", "Before committing, run `cargo fmt --all` in crates/mc-module."),
        row(3, "PROJECT_RULES", "Every release needs two reviewers, and the CI run must be green, which takes 45 minutes on main."),
        Row {
            importance: Some(70),
            ..row(4, "PROJECT_RULES", "The release checklist lives in docs/release.md and needs 2 sign-offs. Release tags use the vX.Y.Z form.")
        },
        row(5, "PROJECT_RULES", "Room 4711 was used on 2026-11-12 for the release sync."),
        Row {
            safety_critical: Some(true),
            ..row(6, "PROJECT_RULES", "Never force-push to main.")
        },
        Row {
            status: "permanent",
            ..row(7, "PROJECT_RULES", "Use bun for the TypeScript packages.")
        },
        Row {
            authority: "policy",
            ..row(8, "PROJECT_RULES", "Commit messages name the task.")
        },
        row(9, "PROJECT_RULES", "Keep pull requests small."),
        Row {
            source_type: "person",
            ..row(10, "PROJECT_RULES", "Prefer short commit messages.")
        },
        row(11, "PROJECT_RULES", "Once we lost a whole day because the cache was cold and nobody knew why; it was a long story."),
        row(12, "PROJECT_RULES", "Use the gate script before delivering a change."),
        row(20, "ARCHITECTURE", "The module owns context.db from schema 106 on."),
    ];
    rows.sort_by_key(|row| row.id);
    let store = store(&rows);
    store.docs(DOCS);
    // The person edits memory 9 from the apps.
    store.db.with_connection(|conn| {
        person::edit(
            conn,
            &owner(),
            Target { id: 9, revision: 1 },
            &person::Edit {
                content: Some("Keep pull requests small and focused.".into()),
                ..person::Edit::default()
            },
        )
        .unwrap();
    });
    store
}

fn owner() -> OwnerRef {
    OwnerRef {
        level: "project".into(),
        owner_id: PROJECT.into(),
    }
}

impl Store {
    fn root(&self) -> String {
        self.dir.path().join("project").to_str().unwrap().to_owned()
    }

    fn docs(&self, text: &str) {
        std::fs::write(self.dir.path().join("project/ARCHITECTURE.md"), text).unwrap();
    }

    fn insert(&self, rows: &[Row]) {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            for row in rows {
                tx.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          importance, status, safety_critical, authority, source_type,
                                          first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, 0)",
                    params![
                        row.id,
                        PROJECT,
                        frozen_category_id(row.tag),
                        row.tag,
                        row.content,
                        normalized_hash(&row.content),
                        row.importance,
                        row.status,
                        row.safety_critical,
                        row.authority,
                        row.source_type
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

    fn plan(&self, resume: Option<&Resume>, only: Option<&str>) -> Vec<CurateBatch> {
        with_context(self, None, |context| {
            Curate.plan_batches(context, resume, only).unwrap()
        })
    }

    /// The one batch of the project's rules.
    fn rules(&self) -> CurateBatch {
        let mut batches = self.plan(None, Some("PROJECT_RULES"));
        assert_eq!(batches.len(), 1);
        batches.remove(0)
    }

    fn apply(&self, batch: &CurateBatch, text: &str, run: i64) -> Applied {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply(text), run).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    /// A memory's text, status, successor, revision, category id and tag.
    fn memory(&self, id: i64) -> Stored {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT content, status, superseded_by_memory_id, revision, category, origin_category
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(Stored {
                            content: row.get(0)?,
                            status: row.get(1)?,
                            superseded_by: row.get(2)?,
                            revision: row.get(3)?,
                            category: row.get(4)?,
                            tag: row.get(5)?,
                        })
                    },
                )
            })
            .unwrap()
    }

    fn value<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.db
            .with_connection(|conn| conn.query_row(sql, [], |row| row.get(0)))
            .unwrap()
    }

    /// Every journal row: decision key, operation and the decision it keeps.
    fn journal(&self) -> Vec<(String, String, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare(
                "SELECT decision_key, operation, before_json FROM memory_journal
                  WHERE decision_key LIKE 'dream-run:%' ORDER BY id",
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stored {
    content: String,
    status: String,
    superseded_by: Option<i64>,
    revision: i64,
    category: String,
    tag: String,
}

fn declaration() -> Value {
    let profile = prompt_profile(None).unwrap();
    profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == KIND)
        .unwrap()
        .clone()
}

/// Run `body` with a curate context for the test project, on the bundled
/// profile and, unless `declaration` replaces it, its curate declaration.
fn with_context<T>(
    store: &Store,
    declaration: Option<Value>,
    body: impl FnOnce(&TaskContext<'_>) -> T,
) -> T {
    let profile = prompt_profile(None).unwrap();
    let declaration = declaration.unwrap_or_else(self::declaration);
    let owner = Owner::Project {
        id: PROJECT.into(),
        root: store.root(),
    };
    body(&TaskContext {
        db: &store.db,
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
        child: "mc-dream:7.0:0.0".into(),
        usage: None,
    }
}

fn list(changes: &str) -> String {
    format!("<curate>\n{changes}\n</curate>")
}

fn ids(batch: &CurateBatch) -> Vec<i64> {
    batch.read.iter().map(|(id, _)| *id).collect()
}

// --- The list parser ---

#[test]
fn the_parser_reads_every_change_the_output_contract_shows() {
    let (_, contract) = FRAMES
        .iter()
        .find(|(name, _)| *name == "dreamer/curate.output-contract")
        .unwrap();
    let example = &contract[contract.find("<curate>").unwrap()
        ..contract.find("</curate>").unwrap() + "</curate>".len()];
    let changes: Vec<Change> = parse_list(example)
        .unwrap()
        .into_iter()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        changes,
        [
            Change::Merge {
                ids: vec![12, 15],
                text: "The merged text".into()
            },
            Change::Shorten {
                id: 21,
                text: "The shorter text".into()
            },
            Change::Split {
                id: 30,
                parts: vec!["The first fact".into(), "The second fact".into()]
            },
            Change::Archive {
                id: 40,
                reason: "duplicate".into(),
                of: Some(12),
                quote: None,
                why: None
            },
            Change::Archive {
                id: 41,
                reason: "duplicate".into(),
                of: None,
                quote: Some("The exact line from the project documents".into()),
                why: None
            },
            Change::Archive {
                id: 42,
                reason: "one-off".into(),
                of: None,
                quote: None,
                why: Some("a chat room id".into())
            },
            Change::Archive {
                id: 43,
                reason: "lesson".into(),
                of: None,
                quote: None,
                why: Some("a story with no rule".into())
            },
        ]
    );
}

#[test]
fn a_reply_without_a_complete_list_fails_and_an_empty_list_is_valid() {
    assert_eq!(
        parse_list("Nothing to change.").unwrap_err(),
        "curate list missing complete root element"
    );
    assert_eq!(
        parse_list("<curate>\n<archive id=\"1\" reason=\"lesson\" why=\"x\"/>").unwrap_err(),
        "curate list missing closing root tag"
    );
    assert_eq!(parse_list("<curate></curate>").unwrap(), []);
    assert_eq!(parse_list("<curate>\n</curate>").unwrap(), []);
    assert_eq!(parse_list("<curate/>").unwrap(), []);
    // A batch refuses such a reply, so the next model is tried.
    let store = fixture();
    let batch = store.rules();
    assert!(batch.accepts("I would merge 1 and 2.").is_err());
    assert!(batch.accepts("<curate></curate>").is_ok());
}

#[test]
fn an_unreadable_element_is_dropped_alone_and_the_last_list_is_the_answer() {
    let text = "Like the example <curate><merge ids=\"1,2\">example</merge></curate>, my answer:\n\
        <curate>\n\
        <!-- one comment <shorten id=\"9\">hidden</shorten> -->\n\
        <update id=\"3\">An update is not a change this list takes.</update>\n\
        <merge ids=\"a,b\">Text.</merge>\n\
        <shorten>No id.</shorten>\n\
        <shorten id=\"5\">  </shorten>\n\
        <shorten id=\"3\">Use `Vec&lt;String&gt;` &amp; keep it.</shorten>\n\
        <merge ids=\"1, 2\">Raw <tags> stay as written.</merge>\n\
        <archive id='4' reason='Lesson'>a story with no rule</archive>\n\
        <split id=\"6\"><part>One.</part>\n<part>Two.</part></split>\n\
        </curate>";
    let entries = parse_list(text).unwrap();
    assert_eq!(
        entries,
        [
            Err("<update> is not a change a curate list takes".into()),
            Err("<merge> ids=\"a,b\" are not memory ids".into()),
            Err("<shorten> names no id".into()),
            Err("<shorten> has no text".into()),
            Ok(Change::Shorten {
                id: 3,
                text: "Use `Vec<String>` & keep it.".into()
            }),
            Ok(Change::Merge {
                ids: vec![1, 2],
                text: "Raw <tags> stay as written.".into()
            }),
            Ok(Change::Archive {
                id: 4,
                reason: "lesson".into(),
                of: None,
                quote: None,
                why: Some("a story with no rule".into())
            }),
            Ok(Change::Split {
                id: 6,
                parts: vec!["One.".into(), "Two.".into()]
            }),
        ]
    );
}

// --- Planning ---

#[test]
fn a_run_covers_every_category_in_the_profiles_order_in_parts_of_sixty() {
    let mut rows: Vec<Row> = (1..=61)
        .map(|id| row(id, "PROJECT_RULES", &format!("Rule {id}.")))
        .collect();
    rows.push(row(100, "NAMING", "Crates are named mc-*."));
    rows.push(row(200, "ARCHITECTURE", "The module owns the store."));
    // Neither another project's memory nor an archived one is curated.
    rows.push(row(300, "NAMING", "Archived name."));
    let store = store(&rows);
    store.execute(&format!(
        "UPDATE memories SET status = 'archived' WHERE id = 300;
         INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                              first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (400, 'project', 'pj-other', '{}', 'NAMING', 'Other.', 'h', 0, 0, 0, 0)",
        frozen_category_id("NAMING")
    ));

    let batches = store.plan(None, None);
    let shape: Vec<(String, (usize, usize), usize)> = batches
        .iter()
        .map(|batch| (batch.category.tag.clone(), batch.part, batch.read.len()))
        .collect();
    assert_eq!(
        shape,
        [
            ("PROJECT_RULES".into(), (1, 2), 60),
            ("PROJECT_RULES".into(), (2, 2), 1),
            ("ARCHITECTURE".into(), (1, 1), 1),
            ("NAMING".into(), (1, 1), 1),
        ]
    );
    assert_eq!(ids(&batches[1]), [61]);
    assert!(batches[1]
        .message
        .contains("<memories part=\"2 of 2\">\n[61]\nRule 61.\n</memories>"));
    assert!(batches[1]
        .message
        .starts_with("## Curate the `PROJECT_RULES` memories\n\n**Project:** pj-curate\n\n"));
    // Each part names where the next run starts once it is applied; the
    // last clears it.
    let next: Vec<Option<Resume>> = batches.iter().map(|batch| batch.next.clone()).collect();
    let resume = |category: &str, part, after| {
        Some(Resume {
            category: category.into(),
            part,
            after,
        })
    };
    assert_eq!(
        next,
        [
            resume("swe:project-rules", 2, 60),
            resume("swe:architecture", 1, 0),
            resume("swe:naming", 1, 0),
            None
        ]
    );

    // A run resumes there: the part's number goes on from the parts done.
    let resumed = store.plan(next[0].as_ref(), None);
    assert_eq!(resumed.len(), 3);
    assert_eq!((ids(&resumed[0]), resumed[0].part), (vec![61], (2, 2)));
    assert_eq!(resumed[1].category.tag, "ARCHITECTURE");
    // A resume point in a category the task doesn't curate starts over.
    let elsewhere = resume("swe:dev-environment", 3, 9);
    assert_eq!(store.plan(elsewhere.as_ref(), None).len(), 4);
    // One category alone, by tag or id.
    let naming = store.plan(None, Some("NAMING"));
    assert_eq!((naming.len(), ids(&naming[0])), (1, vec![100]));
    assert_eq!(store.plan(None, Some("swe:naming")).len(), 1);
    // With nothing to curate there is nothing to send.
    let empty = self::store(&[]);
    assert!(with_context(&empty, None, |context| Curate.batches(context).unwrap()).is_empty());
}

/// A text the module's own counter prices at about `tokens` tokens.
fn text_of_tokens(seed: &str, tokens: u64) -> String {
    let counter = Counter::for_model(None);
    let unit = format!("{seed} lorem ipsum dolor ");
    let per = counter.count(&unit.repeat(100)) / 100;
    let text = unit.repeat((tokens / per.max(1)) as usize);
    let counted = counter.count(&text);
    assert!(
        counted.abs_diff(tokens) * 10 <= tokens,
        "{counted} tokens for about {tokens}"
    );
    text
}

#[test]
fn a_part_holds_about_twelve_thousand_tokens_of_memory_text() {
    let counter = Counter::for_model(None);
    let memory = |id: i64, content: String| Memory {
        id,
        content,
        revision: 1,
        protected: false,
    };
    let lens =
        |pool: &[Memory]| -> Vec<usize> { parts(pool, counter).iter().map(Vec::len).collect() };
    // Three memories of about 5,000 tokens: two fit a part, the third
    // starts the next.
    let pool: Vec<Memory> = (1..=3)
        .map(|id| memory(id, text_of_tokens(&format!("m{id}"), 5_000)))
        .collect();
    assert_eq!(lens(&pool), [2, 1]);
    // A memory longer than a part is a part of its own.
    let pool = vec![
        memory(1, text_of_tokens("long", 13_000)),
        memory(2, "Short.".into()),
    ];
    assert_eq!(lens(&pool), [1, 1]);
    // Sixty short memories fill a part.
    let pool: Vec<Memory> = (1..=121)
        .map(|id| memory(id, format!("Rule {id}.")))
        .collect();
    assert_eq!(lens(&pool), [60, 60, 1]);
}

#[test]
fn similar_memories_are_close_texts_of_the_category_outside_the_part() {
    let memory = |id: i64, content: &str| Memory {
        id,
        content: content.into(),
        revision: 1,
        protected: false,
    };
    let part = vec![memory(1, "Run cargo fmt before every commit.")];
    let pool = vec![
        part[0].clone(),
        // The same words, other case, punctuation and backticks: 1.0.
        memory(2, "run `cargo` FMT, before every commit!"),
        // 5 of 8 words: 0.625, close, but only the closest three show.
        memory(3, "Run cargo fmt before every single push."),
        // 4 of 9: 0.44, not close.
        memory(4, "Run cargo clippy before every merge request."),
        // 6 of 7: 0.86.
        memory(5, "Run cargo fmt before every commit please."),
        // 5 of 7: 0.71.
        memory(6, "Run cargo fmt before each commit."),
        // The same text as the memory once case and spaces are ignored.
        memory(7, "run cargo fmt  before every COMMIT."),
    ];
    let found: Vec<i64> = similar(&part, &pool)
        .iter()
        .map(|memory| memory.id)
        .collect();
    // The closest three, the same text first.
    assert_eq!(found, [7, 2, 5]);

    // At most twenty for a part, each shown once.
    let part: Vec<Memory> = (0..10)
        .map(|index| {
            memory(
                index,
                &format!("Alpha{index} beta{index} gamma{index} delta{index} epsilon."),
            )
        })
        .collect();
    let mut pool = part.clone();
    for index in 0..10 {
        pool.extend((0..4).map(|other| {
            memory(
                100 + index * 10 + other,
                &format!("Alpha{index} beta{index} gamma{index} delta{index} zeta{other}."),
            )
        }));
    }
    let found = similar(&part, &pool);
    assert_eq!(found.len(), 20);
    let distinct: HashSet<i64> = found.iter().map(|memory| memory.id).collect();
    assert_eq!(distinct.len(), 20);
    // The first memories' three closest each, in the part's order.
    let first: Vec<i64> = found.iter().take(4).map(|memory| memory.id).collect();
    assert_eq!(first, [100, 101, 102, 110]);
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace(
            "⟦docs⟧",
            "<file name=\"ARCHITECTURE.md\">\nOne crate.\n</file>",
        )
        .replace("⟦shown.id⟧", "20")
        .replace("⟦shown.category⟧", "ARCHITECTURE")
        .replace("⟦shown.content⟧", "The module owns the store.")
        .replace("⟦similar.id⟧", "30")
        .replace("⟦similar.content⟧", "Run the gate first.")
        .replace("⟦part⟧", "2")
        .replace("⟦parts⟧", "3")
        .replace("⟦memory.id⟧", "1")
        .replace("⟦memory.content⟧", "Run the gate.")
        .replace("⟦memory2.id⟧", "6")
        .replace("⟦memory2.content⟧", "Never force-push.");
    let shown = [Shown {
        id: 20,
        tag: "ARCHITECTURE".into(),
        content: "The module owns the store.".into(),
    }];
    let close = Memory {
        id: 30,
        content: "Run the gate first.".into(),
        revision: 1,
        protected: false,
    };
    let memories = [
        Memory {
            id: 1,
            content: "Run the gate.".into(),
            revision: 1,
            protected: false,
        },
        Memory {
            id: 6,
            content: "Never force-push.".into(),
            revision: 1,
            protected: true,
        },
    ];
    let text = input(
        "<file name=\"ARCHITECTURE.md\">\nOne crate.\n</file>",
        &shown,
        &[&close],
        (2, 3),
        &memories,
    );
    assert_eq!(text, filled.trim_end_matches('\n'));
    // A block with no lines is left out whole.
    let memories_block = &filled[filled.find("<memories").unwrap()..];
    assert_eq!(
        input("", &[], &[], (2, 3), &memories),
        memories_block.trim_end_matches('\n')
    );
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
fn the_rendered_request_is_pinned() {
    // The fixture's rules and one more, resumed after memory 2: memories 1
    // and 2 are outside the part, so the part shows them as similar to
    // memory 13; the architecture memory is shown to every session; the
    // documents are the project's ARCHITECTURE.md.
    let store = fixture();
    store.insert(&[row(
        13,
        "PROJECT_RULES",
        "Run `cargo fmt --all` before each commit in crates/mc-module.",
    )]);
    let resume = Resume {
        category: "swe:project-rules".into(),
        part: 2,
        after: 2,
    };
    let batches = store.plan(Some(&resume), Some("PROJECT_RULES"));
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    let window = Window {
        counter: Counter::for_model(None),
        context_window: 1_000_000,
    };
    let message = batch
        .prompt(window, crate::routing::DREAM_OUTPUT_TOKENS)
        .unwrap();
    golden(
        "curate-request.txt",
        &format!(
            "=== system ===\n{}\n=== user ===\n{message}\n",
            batch.system()
        ),
    );
    // A model whose window can't take the message isn't offered it.
    let small = Window {
        context_window: 2_000,
        ..window
    };
    assert_eq!(batch.prompt(small, 1_000), None);
}

// --- Checks and writes ---

/// What `batch` drops when it applies `changes`, after checking that
/// nothing was written.
fn refused(store: &Store, batch: &CurateBatch, changes: &str) -> Vec<String> {
    let before: Vec<Stored> = (1..=20).filter_map(|id| store.memory_or_none(id)).collect();
    let applied = store.apply(batch, &list(changes), RUN);
    assert_eq!(applied.applied, 0, "{changes}: {applied:?}");
    let after: Vec<Stored> = (1..=20).filter_map(|id| store.memory_or_none(id)).collect();
    assert_eq!(before, after, "{changes} changed a memory");
    applied.dropped
}

impl Store {
    fn memory_or_none(&self, id: i64) -> Option<Stored> {
        let exists: bool = self.value(&format!(
            "SELECT EXISTS(SELECT 1 FROM memories WHERE id = {id})"
        ));
        exists.then(|| self.memory(id))
    }
}

/// Whether `dropped` holds one reason, about `label`, that says `why`.
fn says(dropped: &[String], label: &str, why: &str) {
    assert!(
        dropped.len() == 1 && dropped[0].contains(label) && dropped[0].contains(why),
        "expected one drop of {label} saying {why:?}, got {dropped:?}"
    );
}

#[test]
fn a_merge_writes_one_survivor_and_supersedes_its_sources() {
    let store = fixture();
    let batch = store.rules();
    let applied = store.apply(
        &batch,
        &list("<merge ids=\"1,2\">Run `cargo fmt --all` in crates/mc-module before every commit.</merge>"),
        RUN,
    );
    assert_eq!((applied.proposed, applied.applied), (1, 1), "{applied:?}");
    let survivor: i64 = store.value("SELECT MAX(id) FROM memories");
    let written = store.memory(survivor);
    assert_eq!(
        (
            written.content.as_str(),
            written.status.as_str(),
            written.category.as_str(),
            written.tag.as_str()
        ),
        (
            "Run `cargo fmt --all` in crates/mc-module before every commit.",
            "active",
            "swe:project-rules",
            "PROJECT_RULES"
        )
    );
    for id in [1, 2] {
        let source = store.memory(id);
        assert_eq!(
            (
                source.status.as_str(),
                source.superseded_by,
                source.revision
            ),
            ("archived", Some(survivor), 2)
        );
    }
    let (merged_from, source, session): (String, String, String) =
        store.db.with_connection(|conn| {
            conn.query_row(
                "SELECT merged_from, source_type, source_session_id FROM memories WHERE id = ?1",
                [survivor],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        });
    assert_eq!(merged_from, "[1,2]");
    assert_eq!(source, "dreamer");
    // The session that proposed it, so its transcript can be found.
    assert_eq!(session, "mc-dream:7.0:0.0");
    let journal = store.journal();
    assert_eq!(journal.len(), 1);
    let (key, operation, decision) = &journal[0];
    assert_eq!(
        (key.as_str(), operation.as_str()),
        ("dream-run:7:curate:0:0", "curate_merge")
    );
    assert_eq!(decision["writer"], "dreamer:curate");
    assert_eq!(decision["survivorId"], survivor);
    assert_eq!(decision["sourceIds"], json!([1, 2]));
    assert_eq!(decision["rows"].as_array().unwrap().len(), 3);

    // A source that already holds the merged text survives with it.
    let store = fixture();
    let batch = store.rules();
    let text = store.memory(1).content;
    let applied = store.apply(
        &batch,
        &list(&format!("<merge ids=\"1,2\">{text}</merge>")),
        RUN,
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(store.memory(1).status, "active");
    assert_eq!(store.memory(2).superseded_by, Some(1));
    assert_eq!(store.value::<i64>("SELECT MAX(id) FROM memories"), 20);
}

#[test]
fn a_merge_is_refused_unless_every_check_passes() {
    let store = fixture();
    let batch = store.rules();
    let good = "Run `cargo fmt --all` in crates/mc-module before every commit.";
    says(
        &refused(&store, &batch, &format!("<merge ids=\"1\">{good}</merge>")),
        "merge 1",
        "two or more memories",
    );
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,1\">{good}</merge>"),
        ),
        "merge 1,1",
        "memory 1 is named twice",
    );
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,20\">{good}</merge>"),
        ),
        "merge 1,20",
        "memory 20 is not in this part",
    );
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,6\">{good}</merge>"),
        ),
        "merge 1,6",
        "memory 6 is protected",
    );
    says(
        &refused(
            &store,
            &batch,
            "<merge ids=\"1,2\">Run cargo fmt in crates/mc-module before every commit.</merge>",
        ),
        "merge 1,2",
        "the merged text drops `cargo fmt --all`",
    );
    // Both changes that name memory 2 are dropped.
    let dropped = refused(
        &store,
        &batch,
        &format!(
            "<merge ids=\"1,2\">{good}</merge>\n<archive id=\"2\" reason=\"one-off\" why=\"x\"/>"
        ),
    );
    assert_eq!(dropped.len(), 2, "{dropped:?}");
    assert!(dropped
        .iter()
        .all(|reason| reason.contains("memory 2 is named by more than one change")));
    // The merged text may not repeat another live memory, in any category.
    store.insert(&[row(30, "NAMING", good)]);
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,2\">{good}</merge>"),
        ),
        "merge 1,2",
        "the merged text repeats live memory 30",
    );
    store.execute("DELETE FROM memories WHERE id = 30");
    // A memory changed after the run read it keeps its change.
    store.execute("UPDATE memories SET revision = revision + 1 WHERE id = 2");
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,2\">{good}</merge>"),
        ),
        "merge 1,2",
        "memory 2 changed after the run read it (revision 1, now 2)",
    );
    // So does one that left the project's live memories of the category.
    store.execute("UPDATE memories SET revision = 1, status = 'archived' WHERE id = 2");
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,2\">{good}</merge>"),
        ),
        "merge 1,2",
        "memory 2 is no longer a live PROJECT_RULES memory",
    );
    // A declaration that doesn't allow merges.
    let mut declaration = declaration();
    declaration["actions"] = json!(["shorten", "split", "archive"]);
    let store = fixture();
    let batch = with_context(&store, Some(declaration), |context| {
        Curate
            .plan_batches(context, None, Some("PROJECT_RULES"))
            .unwrap()
            .remove(0)
    });
    says(
        &refused(
            &store,
            &batch,
            &format!("<merge ids=\"1,2\">{good}</merge>"),
        ),
        "merge 1,2",
        "does not allow merge",
    );
}

#[test]
fn a_shorten_keeps_every_detail_in_fewer_words() {
    let store = fixture();
    let batch = store.rules();
    let shorter = "Releases need two reviewers and a green CI run of 45 minutes.";
    let applied = store.apply(
        &batch,
        &list(&format!("<shorten id=\"3\">{shorter}</shorten>")),
        RUN,
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    let written = store.memory(3);
    assert_eq!((written.content.as_str(), written.revision), (shorter, 2));
    let classified: Option<i64> = store.value("SELECT classified_at FROM memories WHERE id = 3");
    assert_eq!(classified, None, "new text is classified again");

    let store = fixture();
    let batch = store.rules();
    says(
        &refused(&store, &batch, "<shorten id=\"3\">Every release needs two reviewers, and the CI run on main must be green, which takes 45 minutes there.</shorten>"),
        "shorten 3",
        "the new text is not shorter",
    );
    // Only backticks, case and punctuation differ.
    says(
        &refused(&store, &batch, "<shorten id=\"1\">run cargo fmt --all before every commit in crates/mc-module</shorten>"),
        "shorten 1",
        "differs only in formatting",
    );
    says(
        &refused(
            &store,
            &batch,
            "<shorten id=\"3\">Releases need two reviewers and a green CI run.</shorten>",
        ),
        "shorten 3",
        "the new text drops 45",
    );
    says(
        &refused(
            &store,
            &batch,
            &format!("<shorten id=\"1\">{}</shorten>", store.memory(2).content),
        ),
        "shorten 1",
        "the new text repeats live memory 2",
    );
    says(
        &refused(&store, &batch, "<shorten id=\"7\">Use bun.</shorten>"),
        "shorten 7",
        "memory 7 is protected",
    );
}

#[test]
fn a_split_keeps_the_original_as_its_first_part() {
    let store = fixture();
    let batch = store.rules();
    let applied = store.apply(
        &batch,
        &list("<split id=\"4\"><part>The release checklist lives in docs/release.md and needs 2 sign-offs.</part><part>Release tags use the vX.Y.Z form.</part></split>"),
        RUN,
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    let original = store.memory(4);
    assert_eq!(
        (
            original.content.as_str(),
            original.status.as_str(),
            original.revision
        ),
        (
            "The release checklist lives in docs/release.md and needs 2 sign-offs.",
            "active",
            2
        )
    );
    let added: i64 = store.value("SELECT MAX(id) FROM memories");
    let written = store.memory(added);
    assert_eq!(
        (
            written.content.as_str(),
            written.status.as_str(),
            written.category.as_str(),
            written.tag.as_str()
        ),
        (
            "Release tags use the vX.Y.Z form.",
            "active",
            "swe:project-rules",
            "PROJECT_RULES"
        )
    );
    let (level, owner, importance): (String, String, i64) = store.db.with_connection(|conn| {
        conn.query_row(
            "SELECT level, owner_id, importance FROM memories WHERE id = ?1",
            [added],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    });
    assert_eq!(
        (level.as_str(), owner.as_str(), importance),
        ("project", PROJECT, 70)
    );

    let store = fixture();
    let batch = store.rules();
    says(
        &refused(&store, &batch, "<split id=\"4\"><part>The release checklist lives in docs/release.md and needs 2 sign-offs; tags use vX.Y.Z.</part></split>"),
        "split 4",
        "two or more parts",
    );
    says(
        &refused(&store, &batch, "<split id=\"4\"><part>The release checklist lives in docs/release.md.</part><part>Release tags use the vX.Y.Z form.</part></split>"),
        "split 4",
        "the parts drop 2",
    );
    says(
        &refused(&store, &batch, "<split id=\"4\"><part>The checklist is docs/release.md, 2 sign-offs, vX.Y.Z tags.</part><part>The checklist is docs/release.md, 2 sign-offs, vX.Y.Z tags.</part></split>"),
        "split 4",
        "two parts have the same text",
    );
}

#[test]
fn an_archive_needs_its_reason_and_what_it_repeats() {
    let quote = "Run scripts/gate.sh preflight before every delivery of a change.";
    // A duplicate of a memory of the part, of one every session sees, or
    // of a documents line; a one-off; a lesson.
    let store = fixture();
    let batch = store.rules();
    let applied = store.apply(
        &batch,
        &list(&format!(
            "<archive id=\"2\" reason=\"duplicate\" of=\"1\"/>\n\
             <archive id=\"3\" reason=\"duplicate\" of=\"20\"/>\n\
             <archive id=\"12\" reason=\"duplicate\" quote=\"{quote}\"/>\n\
             <archive id=\"5\" reason=\"one-off\" why=\"a room id and a date\"/>\n\
             <archive id=\"11\" reason=\"lesson\" why=\"a story with no rule\"/>"
        )),
        RUN,
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (5, 0),
        "{applied:?}"
    );
    let archived = |id: i64| {
        let memory = store.memory(id);
        let reason: String = store.value(&format!(
            "SELECT json_extract(metadata_json, '$.archive_reason') FROM memories WHERE id = {id}"
        ));
        (memory.status, memory.superseded_by, reason)
    };
    assert_eq!(
        archived(2),
        ("archived".into(), Some(1), "duplicate of memory 1".into())
    );
    assert_eq!(
        archived(3),
        ("archived".into(), Some(20), "duplicate of memory 20".into())
    );
    assert_eq!(
        archived(12),
        (
            "archived".into(),
            None,
            format!("duplicate of the project documents: \"{quote}\"")
        )
    );
    assert_eq!(
        archived(5),
        (
            "archived".into(),
            None,
            "one-off: a room id and a date".into()
        )
    );
    assert_eq!(
        archived(11),
        (
            "archived".into(),
            None,
            "lesson: a story with no rule".into()
        )
    );
    // The history records the reason, and the survivor or the quote.
    let journal = store.journal();
    assert_eq!(journal.len(), 5);
    assert_eq!(journal[0].2["reason"], "duplicate of memory 1");
    assert_eq!(
        journal[0].2["evidence"],
        json!({"reason": "duplicate", "of": 1})
    );
    assert_eq!(
        journal[2].2["evidence"],
        json!({"reason": "duplicate", "quote": quote})
    );
    assert_eq!(
        journal[3].2["evidence"],
        json!({"reason": "one-off", "why": "a room id and a date"})
    );

    // A quote that holds the documents' escapes written out matches too.
    let store = fixture();
    let batch = store.rules();
    let applied = store.apply(
        &batch,
        &list("<archive id=\"12\" reason=\"duplicate\" quote=\"A &lt;frame&gt; is filled by the module &amp; never\"/>"),
        RUN,
    );
    assert_eq!(applied.applied, 1, "{applied:?}");

    let store = fixture();
    let batch = store.rules();
    for (change, label, why) in [
        ("<archive id=\"2\" reason=\"duplicate\" of=\"2\"/>", "archive 2", "duplicate of itself"),
        ("<archive id=\"2\" reason=\"duplicate\" of=\"999\"/>", "archive 2", "memory 999 was not shown"),
        ("<archive id=\"2\" reason=\"duplicate\"/>", "archive 2", "names no memory (of) and no documents line"),
        ("<archive id=\"12\" reason=\"duplicate\" quote=\"Run scripts/gate.sh\"/>", "archive 12", "shorter than 20 characters"),
        ("<archive id=\"12\" reason=\"duplicate\" quote=\"Run the gate script before every delivery.\"/>", "archive 12", "not in the project documents"),
        ("<archive id=\"5\" reason=\"one-off\"/>", "archive 5", "a one-off archive says no why"),
        ("<archive id=\"11\" reason=\"lesson\" why=\" \"/>", "archive 11", "a lesson archive says no why"),
        ("<archive id=\"5\" reason=\"obsolete\" why=\"old\"/>", "archive 5", "obsolete is not an archive reason"),
        ("<archive id=\"5\" why=\"old\"/>", "archive 5", "gives no reason"),
        ("<archive id=\"6\" reason=\"one-off\" why=\"x\"/>", "archive 6", "memory 6 is protected"),
    ] {
        says(&refused(&store, &batch, change), label, why);
    }
    // The survivor may not be changed by the same list.
    let applied = store.apply(
        &batch,
        &list("<archive id=\"2\" reason=\"duplicate\" of=\"1\"/>\n<shorten id=\"1\">Run `cargo fmt --all` before commits in crates/mc-module.</shorten>"),
        RUN,
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    says(
        &applied.dropped,
        "archive 2",
        "memory 1 is changed by this list too",
    );
    // Nor archived since the run read the part.
    let store = fixture();
    let batch = store.rules();
    store.execute("UPDATE memories SET status = 'archived' WHERE id = 20");
    says(
        &refused(
            &store,
            &batch,
            "<archive id=\"3\" reason=\"duplicate\" of=\"20\"/>",
        ),
        "archive 3",
        "memory 20 is not a live memory of the project",
    );
}

#[test]
fn protected_memories_are_shown_as_protected_and_never_changed() {
    let store = fixture();
    let batch = store.rules();
    // Safety-critical, permanent, a policy, edited by the person, written
    // by the person.
    for id in [6, 7, 8, 9, 10] {
        assert!(batch.protected.contains(&id), "memory {id}");
        assert!(
            batch.message.contains(&format!("\n[{id}] protected\n")),
            "memory {id} is marked protected"
        );
    }
    for id in [1, 2, 3, 4, 5, 11, 12] {
        assert!(!batch.protected.contains(&id), "memory {id}");
        assert!(batch.message.contains(&format!("\n[{id}]\n")));
    }
    let before: Vec<Stored> = [6, 7, 8, 9, 10]
        .iter()
        .map(|id| store.memory(*id))
        .collect();
    let applied = store.apply(
        &batch,
        &list(
            "<archive id=\"6\" reason=\"one-off\" why=\"x\"/>\n\
             <shorten id=\"7\">Use bun.</shorten>\n\
             <merge ids=\"8,10\">Commit messages name the task and stay short.</merge>\n\
             <split id=\"9\"><part>Keep pull requests small.</part><part>Keep them focused.</part></split>\n\
             <archive id=\"5\" reason=\"one-off\" why=\"a room id\"/>",
        ),
        RUN,
    );
    // The change to an unprotected memory still applies.
    assert_eq!((applied.proposed, applied.applied), (5, 1), "{applied:?}");
    assert_eq!(applied.dropped.len(), 4);
    assert!(applied
        .dropped
        .iter()
        .all(|reason| reason.contains("is protected")));
    let after: Vec<Stored> = [6, 7, 8, 9, 10]
        .iter()
        .map(|id| store.memory(*id))
        .collect();
    assert_eq!(before, after);
}

#[test]
fn each_change_is_one_decision_named_after_the_run_and_undoes_alone_or_with_the_run() {
    let store = fixture();
    let originals: Vec<Stored> = (1..=12).map(|id| store.memory(id)).collect();
    let batch = store.rules();
    let applied = store.apply(
        &batch,
        &list(
            "<merge ids=\"1,2\">Run `cargo fmt --all` in crates/mc-module before every commit.</merge>\n\
             <shorten id=\"3\">Releases need two reviewers and a green CI run of 45 minutes.</shorten>\n\
             <split id=\"4\"><part>The release checklist lives in docs/release.md and needs 2 sign-offs.</part><part>Release tags use the vX.Y.Z form.</part></split>\n\
             <archive id=\"5\" reason=\"one-off\" why=\"a room id\"/>",
        ),
        RUN,
    );
    assert_eq!(applied.applied, 4, "{applied:?}");
    let journal = store.journal();
    let keys: Vec<(&str, &str)> = journal
        .iter()
        .map(|(key, operation, _)| (key.as_str(), operation.as_str()))
        .collect();
    assert_eq!(
        keys,
        [
            ("dream-run:7:curate:0:0", "curate_merge"),
            ("dream-run:7:curate:0:1", "curate_shorten"),
            ("dream-run:7:curate:0:2", "curate_split"),
            ("dream-run:7:curate:0:3", "curate_archive"),
        ]
    );
    let rows: i64 = store.value(
        "SELECT COUNT(*) FROM memory_history WHERE decision_key LIKE 'dream-run:7:curate:%'",
    );
    // Merge: two sources and the survivor; shorten: one; split: the
    // original and its new part; archive: one.
    assert_eq!(rows, 7);

    // One change undone alone: the shortened memory gets its text back.
    let shortened = store.memory(3);
    store.db.with_connection(|conn| {
        let entry = person::entry(conn, 3, shortened.revision).unwrap().unwrap();
        assert_eq!(entry.key, "dream-run:7:curate:0:1");
        person::undo(
            conn,
            &owner(),
            Target {
                id: 3,
                revision: shortened.revision,
            },
            &entry,
        )
        .unwrap();
    });
    assert_eq!(store.memory(3).content, originals[2].content);

    // The rest of the run undone as one.
    store.db.with_connection(|conn| {
        let plan = person::plan_run_undo(conn, &owner(), RUN).unwrap();
        // Memory 3 changed again after the run: the undo above.
        assert_eq!(plan.left, [(3, person::LeftAlone::ChangedAfter)]);
        person::undo_run(conn, &owner(), RUN, &plan.restore).unwrap();
    });
    for (index, original) in originals.iter().enumerate() {
        let now = store.memory(index as i64 + 1);
        assert_eq!(
            (&now.content, &now.status, now.superseded_by),
            (&original.content, &original.status, original.superseded_by),
            "memory {}",
            index + 1
        );
    }
    // What the run created is archived again.
    let created: Vec<String> = store.db.with_connection(|conn| {
        conn.prepare("SELECT status FROM memories WHERE id > 20 ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    });
    assert_eq!(created, ["archived", "archived"]);
}

#[test]
fn applying_a_part_moves_the_resume_point_past_it() {
    let mut rows: Vec<Row> = (1..=61)
        .map(|id| row(id, "PROJECT_RULES", &format!("Rule {id}.")))
        .collect();
    rows.push(row(100, "NAMING", "Crates are named mc-*."));
    let store = store(&rows);
    let task = declaration()["id"].as_str().unwrap().to_owned();
    store.db.with_connection(|conn| {
        crate::dreamer::store::ensure_schedule(
            conn,
            &crate::dreamer::store::OwnerKey::project(PROJECT),
            &task,
            "0 4 * * 0",
            1,
        )
        .unwrap();
    });
    let watermark =
        || -> Option<String> { store.value("SELECT watermark_json FROM dream_schedules") };
    let batches = with_context(&store, None, |context| Curate.batches(context).unwrap());
    assert_eq!(batches.len(), 3);
    store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        batches[0]
            .apply(&tx, &reply("<curate></curate>"), RUN)
            .unwrap();
        tx.commit().unwrap();
    });
    assert_eq!(
        watermark().map(|text| serde_json::from_str::<Value>(&text).unwrap()),
        Some(json!({"category": "swe:project-rules", "part": 2, "after": 60}))
    );
    // The next run reads it and starts at the second part.
    let resumed = with_context(&store, None, |context| Curate.batches(context).unwrap());
    assert_eq!(resumed.len(), 2);
    let message = resumed[0]
        .prompt(
            Window {
                counter: Counter::for_model(None),
                context_window: 1_000_000,
            },
            1_000,
        )
        .unwrap();
    assert!(message.contains("<memories part=\"2 of 2\">\n[61]\nRule 61.\n</memories>"));
    store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for batch in &resumed {
            batch
                .apply(&tx, &reply("<curate></curate>"), RUN + 1)
                .unwrap();
        }
        tx.commit().unwrap();
    });
    // The last part clears it: the run after starts over.
    assert_eq!(watermark(), None);
    assert_eq!(
        with_context(&store, None, |context| Curate.batches(context).unwrap()).len(),
        3
    );
}

#[test]
fn every_memory_the_head_shows_is_listed_except_the_parts_own() {
    let store = fixture();
    let batch = store.rules();
    let shown = &batch.message[batch.message.find("<always-shown>").unwrap()
        ..batch.message.find("</always-shown>").unwrap()];
    // The architecture memory every session sees, with its category's tag;
    // none of the rules the part itself lists.
    assert!(shown.contains("\n[20] ARCHITECTURE: The module owns context.db from schema 106 on.\n"));
    assert!(!shown.contains("PROJECT_RULES"), "{shown}");
    // An archived memory is no longer shown to any session.
    store.execute("UPDATE memories SET status = 'archived' WHERE id = 20");
    let batch = store.rules();
    assert!(!batch.message.contains("<always-shown>"));
    // The documents are the head's own block, inside the frame's wrapper.
    assert!(batch
        .message
        .contains("<project-documents>\n<file name=\"ARCHITECTURE.md\">\n# Layout\n"));
    assert!(batch.message.contains("A &lt;frame&gt; is filled by the module &amp; never by a profile.\n</file>\n</project-documents>"));
}
