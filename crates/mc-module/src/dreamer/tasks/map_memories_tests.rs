use std::path::{Path, PathBuf};
use std::sync::Arc;

use cortexkit_role_compaction::setup::ModelRef;
use serde_json::Value;

use super::*;
use crate::context_db::ContextDb;
use crate::count::Counter;
use crate::dreamer::engine::{Engine, Settings};
use crate::dreamer::run::tests::{Client, Ends};
use crate::memory_profile::{prompt_profile, FRAMES};
use crate::memory_writes::normalized_hash;

const PROJECT: &str = "pj-map";

/// A git checkout in a folder of its own, with `files` written and added to
/// git's index; `untracked` are written and left out.
struct Repo {
    dir: tempfile::TempDir,
}

fn git(root: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

impl Repo {
    fn new(files: &[(&str, &str)], untracked: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        for (path, text) in files.iter().chain(untracked) {
            let path = dir.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        if !files.is_empty() {
            let mut args = vec!["add", "--"];
            args.extend(files.iter().map(|(path, _)| *path));
            git(dir.path(), &args);
        }
        Self { dir }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn checkout(&self) -> Checkout {
        Checkout::open(self.root()).unwrap()
    }
}

/// The checkout most tests read: two source files and a test file, one
/// untracked file, and a document that isn't code.
fn repo() -> Repo {
    Repo::new(
        &[
            ("src/view.rs", "pub fn build_view() {}\n"),
            ("src/head.rs", "pub fn render_head() { build_view(); }\n"),
            ("web/app.tsx", "export function AppShell() {}\n"),
            ("web/app.ts", "export const legacy = 1;\n"),
            ("docs/guide.md", "See src/view.rs.\n"),
        ],
        &[("src/scratch.rs", "fn scratch() {}\n")],
    )
}

/// A memory row as the tests write it.
#[derive(Clone)]
struct Row {
    id: i64,
    owner: &'static str,
    tag: &'static str,
    category: &'static str,
    content: String,
    status: &'static str,
}

/// Memory `id`: a live architecture memory of the test project.
fn row(id: i64) -> Row {
    Row {
        id,
        owner: PROJECT,
        tag: "ARCHITECTURE",
        category: "swe:architecture",
        content: format!("Fact {id}."),
        status: "active",
    }
}

/// A temporary store at the module's schema, and a checkout.
struct Store {
    _dir: tempfile::TempDir,
    db: ContextDb,
    repo: Repo,
}

fn store(rows: &[Row]) -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let store = Store {
        _dir: dir,
        db,
        repo: repo(),
    };
    store.insert(rows);
    store
}

/// A mapping row as a writer leaves it: (path, origin).
fn mapped(path: &str, origin: &str) -> (String, String) {
    (path.to_owned(), origin.to_owned())
}

impl Store {
    fn insert(&self, rows: &[Row]) {
        self.db.with_connection(|conn| {
            for row in rows {
                conn.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          importance, status, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, 50, ?7, 0, 0, 0, 0)",
                    params![
                        row.id,
                        row.owner,
                        row.category,
                        row.tag,
                        row.content,
                        normalized_hash(&row.content),
                        row.status
                    ],
                )
                .unwrap();
            }
        });
    }

    fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    /// Give memory `id` the mapping `rows`, as an earlier run left it.
    fn map(&self, id: i64, rows: &[(String, String)]) {
        self.db.with_connection(|conn| {
            for (path, origin) in rows {
                conn.execute(
                    "INSERT INTO memory_verifications(memory_id, file_path, verified_at, mapped_at, mapping_origin)
                     VALUES (?1, ?2, 7, 5, ?3)",
                    params![id, path, origin],
                )
                .unwrap();
            }
        });
    }

    fn batches(&self) -> Vec<MapBatch> {
        with_context(&self.db, self.repo.root(), |context| {
            MapMemories.plan_batches(context).unwrap()
        })
    }

    fn apply(&self, batch: &MapBatch, text: &str, run: i64) -> Applied {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply(text), run).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    /// Memory `id`'s mapping rows.
    fn mapping(&self, id: i64) -> Vec<MappingRow> {
        self.db
            .with_connection(|conn| mapping_rows(conn, id))
            .unwrap()
    }

    /// Memory `id`'s mapping as (path, origin).
    fn mapped(&self, id: i64) -> Vec<(String, String)> {
        self.mapping(id)
            .into_iter()
            .map(|row| (row.file_path, row.mapping_origin))
            .collect()
    }

    /// Every journal row: decision key, operation, receipt and decision.
    fn journal(&self) -> Vec<(String, String, Value, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare(
                "SELECT decision_key, operation, receipt_json, before_json, after_json
                   FROM memory_journal ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                let before: String = row.get(3)?;
                let after: String = row.get(4)?;
                assert_eq!(before, after, "both columns keep the decision");
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    serde_json::from_str(&row.get::<_, String>(2)?).unwrap(),
                    serde_json::from_str(&before).unwrap(),
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
        })
    }

    fn count(&self, sql: &str) -> i64 {
        self.db
            .with_connection(|conn| conn.query_row(sql, [], |row| row.get(0)))
            .unwrap()
    }
}

/// The bundled profile's map task.
fn declaration() -> Value {
    prompt_profile(None).unwrap().body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == KIND)
        .unwrap()
        .clone()
}

/// Run `body` with a map context for the test project in `root`, on the
/// bundled profile.
fn with_context<T>(db: &ContextDb, root: &Path, body: impl FnOnce(&TaskContext<'_>) -> T) -> T {
    let profile = prompt_profile(None).unwrap();
    let declaration = declaration();
    let owner = Owner::Project {
        id: PROJECT.into(),
        root: root.display().to_string(),
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

/// A `<mappings>` manifest with one entry per id and its attributes.
fn manifest(entries: &[(i64, &str)]) -> String {
    let lines: String = entries
        .iter()
        .map(|(id, attributes)| format!("<memory id=\"{id}\" {attributes}/>\n"))
        .collect();
    format!("<mappings>\n{lines}</mappings>")
}

fn ids(batch: &MapBatch) -> Vec<i64> {
    batch.read.iter().map(|memory| memory.id).collect()
}

#[test]
fn a_run_sends_unmapped_memories_then_at_most_twenty_marked_ones_that_name_a_file() {
    let mut rows: Vec<Row> = (1..=40).map(row).collect();
    // 4 to 25 name a file the checkout tracks.
    for row in &mut rows[3..25] {
        row.content = format!("Fact {} lives in `src/view.rs`.", row.id);
    }
    rows[26].content = "Fact 27 lives in `src/view.rs`.".into();
    rows[27].status = "archived";
    rows[28].owner = "pj-other";
    let store = store(&rows);
    // 3 is mapped to a file; 4 to 25 carry the model's file-independent
    // mark; 26 carries it too but names no file; 27 names one, but its mark
    // is the module's own refusal.
    store.map(3, &[mapped("src/view.rs", MAPPER)]);
    for id in 4..=26 {
        store.map(id, &[mapped("", MAPPER)]);
    }
    store.map(27, &[mapped("", REJECTED)]);
    store.map(30, &[mapped("", MAPPER), mapped("src/view.rs", MAPPER)]);

    let batches = store.batches();
    let sent: Vec<Vec<i64>> = batches.iter().map(ids).collect();
    let unmapped: Vec<i64> = [1, 2].into_iter().chain(31..=40).collect();
    // Unmapped first (28 is archived, 29 another project's), then the first
    // twenty marked memories that name a file; twenty to a message.
    let expected: Vec<i64> = unmapped.into_iter().chain(4..=23).collect();
    assert_eq!(sent.concat(), expected);
    assert_eq!(
        sent.iter().map(Vec::len).collect::<Vec<_>>(),
        [BATCH_SIZE, expected.len() - BATCH_SIZE]
    );
    // A memory the run re-sends is shown the file its text names.
    assert_eq!(batches[0].inputs[12].candidates, ["src/view.rs"]);
}

#[test]
fn likely_files_are_tracked_paths_the_memory_names_with_the_profile_s_extensions() {
    let repo = repo();
    let checkout = repo.checkout();
    let exists = |path: &str| checkout.file(path).is_ok();
    let declared = declaration();
    // The bundled profile's settings.
    assert_eq!(seeds(&declared), 3);
    assert_eq!(
        extensions(&declared),
        [
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "json", "jsonc", "sql",
            "toml", "sh"
        ]
    );
    let pattern = path_pattern(&extensions(&declared));
    let text = "See `src/view.rs`, src/view.rs again, src/scratch.rs (untracked), \
                ../src/head.rs, docs/guide.md, web/app.tsx and src/head.rs.";
    // Each once, in the order named; never untracked, climbing or of
    // another extension; `app.tsx` read whole. Three at most.
    assert_eq!(
        candidate_paths(text, &pattern, 3, exists),
        ["src/view.rs", "web/app.tsx", "src/head.rs"]
    );
    assert_eq!(candidate_paths(text, &pattern, 1, exists), ["src/view.rs"]);

    // Other settings change both.
    let mut other = declared.clone();
    other["settings"] = json!({"map_extensions": ["md"], "seed_paths_per_memory": 1});
    assert_eq!(seeds(&other), 1);
    let pattern = path_pattern(&extensions(&other));
    assert_eq!(
        candidate_paths(text, &pattern, seeds(&other), exists),
        ["docs/guide.md"]
    );
}

#[test]
fn a_memory_naming_no_file_gets_the_files_its_code_names_are_found_in() {
    assert_eq!(
        code_names("Use `render_head` and RenderHead, then renderHead; not render or ok_x."),
        ["render_head", "RenderHead", "renderHead"]
    );
    let input = |id: i64, content: &str, candidates: &[&str]| Input {
        id,
        tag: "ARCHITECTURE".into(),
        content: content.into(),
        candidates: candidates.iter().map(|path| (*path).to_owned()).collect(),
    };
    let lines = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned()))
            .collect()
    };
    let mut inputs = vec![
        input(1, "build_view feeds render_head.", &[]),
        input(2, "Named src/x.rs already.", &["src/x.rs"]),
        input(3, "plain prose only.", &[]),
    ];
    let mut searched = Vec::new();
    seed_code_names(
        &mut inputs,
        2,
        |terms| {
            searched.push(terms.to_vec());
            Some(lines(&[
                ("b.rs", "build_view()"),
                ("a.rs", "build_view()"),
                ("c.rs", "build_view(); render_head()"),
                ("gone.rs", "build_view(); render_head()"),
            ]))
        },
        |path| path != "gone.rs",
    );
    // One search for the batch, for the names of the memories naming no
    // file; the file holding both names first, then by path.
    assert_eq!(searched, [["build_view", "render_head"]]);
    assert_eq!(inputs[0].candidates, ["c.rs", "a.rs"]);
    assert_eq!(inputs[1].candidates, ["src/x.rs"]);
    assert!(inputs[2].candidates.is_empty());

    // A failed search leaves the memories as they were.
    let mut unchanged = vec![input(1, "build_view feeds render_head.", &[])];
    seed_code_names(&mut unchanged, 3, |_| None, |_| true);
    assert!(unchanged[0].candidates.is_empty());

    // The real search reads the tracked files with the profile's extensions.
    let repo = repo();
    let checkout = repo.checkout();
    let found = checkout
        .search(&["build_view".into()], &extensions(&declaration()))
        .unwrap();
    let mut paths: Vec<&str> = found.iter().map(|(path, _)| path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["src/head.rs", "src/view.rs"]);
    // Nothing found is an empty answer, not a failure.
    assert_eq!(
        checkout.search(&["NoSuchName".into()], &extensions(&declaration())),
        Some(Vec::new())
    );
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace("⟦memory.id⟧", "1")
        .replace("⟦memory.category⟧", "CONSTRAINTS")
        .replace("⟦memory.content⟧", "Releases need two reviewers.")
        .replace("⟦candidatePath1⟧", "src/a.rs")
        .replace("⟦candidatePath2⟧", "src/b.rs")
        .replace("⟦memory2.id⟧", "2")
        .replace("⟦memory2.category⟧", "NAMING")
        .replace("⟦memory2.content⟧", "Crates are named mc-*.");
    let inputs = [
        Input {
            id: 1,
            tag: "CONSTRAINTS".into(),
            content: "Releases need two reviewers.".into(),
            candidates: vec!["src/a.rs".into(), "src/b.rs".into()],
        },
        Input {
            id: 2,
            tag: "NAMING".into(),
            content: "Crates are named mc-*.".into(),
            candidates: Vec::new(),
        },
    ];
    assert_eq!(input(&inputs), filled.trim_end_matches('\n'));
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
    // A memory naming a tracked file, one whose code names a search finds,
    // one with neither, text that needs no escaping, and a marked memory
    // sent again for the file it names.
    let store = store(&[
        Row {
            content: "Views are built in `src/view.rs`.".into(),
            ..row(1)
        },
        Row {
            tag: "PROJECT_RULES",
            category: "swe:project-rules",
            content: "render_head runs after the view.".into(),
            ..row(2)
        },
        Row {
            tag: "CONSTRAINTS",
            category: "swe:constraints",
            content: "Use <tags> & Unicode 日本語.\nLine two.".into(),
            ..row(3)
        },
        Row {
            content: "AppShell lives in web/app.tsx.".into(),
            ..row(4)
        },
    ]);
    store.map(4, &[mapped("", MAPPER)]);
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    golden(
        "map-memories-request.txt",
        &format!(
            "=== system ===\n{}\n=== user ===\n{}\n",
            batch.system(),
            batch.message()
        ),
    );
    assert!(batch.system().starts_with("You are a memory mapper"));
    assert!(batch
        .message()
        .contains("[2] PROJECT_RULES\nrender_head runs after the view.\nLikely files (candidate paths, confirmed to exist): src/head.rs\n"));
}

#[test]
fn a_batch_offers_its_message_only_to_a_model_it_fits() {
    let store = store(&[row(1)]);
    let batch = &store.batches()[0];
    let window = |context_window| Window {
        counter: Counter::for_model(None),
        context_window,
    };
    assert_eq!(
        batch.prompt(window(200_000), 32_000).as_deref(),
        Some(batch.message())
    );
    // The system prompt alone is several hundred tokens.
    assert_eq!(batch.prompt(window(600), 300), None);
}

#[test]
fn a_project_folder_git_does_not_track_fails_the_run_before_anything_is_sent() {
    let store = store(&[row(1)]);
    let plain = tempfile::tempdir().unwrap();
    let refused = with_context(&store.db, plain.path(), |context| {
        MapMemories.plan_batches(context).map(|_| ()).unwrap_err()
    });
    assert!(
        refused.contains("listing the files git tracks"),
        "{refused}"
    );
}

#[test]
fn a_reply_must_hold_one_whole_manifest_with_well_formed_entries() {
    let expected = [1, 2, 3];
    let accepted = |text: &str| validate_manifest(text, &expected);
    // Files as an attribute or nested, the mark, and files over the mark.
    assert_eq!(
        accepted(
            "Done.\n<mappings>\n<memory id=\"1\" files=\"src/a.rs, src/b.rs\"/>\n\
             <memory id=\"2\"><file path=\"src/c.rs\"/></memory>\n\
             <memory id=\"3\" independent=\"true\"/>\n<memory id=\"9\" files=\"x.rs\" independent=\"true\"/>\n</mappings>"
        )
        .unwrap(),
        [
            Mapping { id: 1, files: vec!["src/a.rs".into(), "src/b.rs".into()], independent: false },
            Mapping { id: 2, files: vec!["src/c.rs".into()], independent: false },
            Mapping { id: 3, files: Vec::new(), independent: true },
            Mapping { id: 9, files: vec!["x.rs".into()], independent: false },
        ]
    );
    // Leaving every id out is an answer: nothing could be decided.
    assert_eq!(accepted("<mappings>\n</mappings>").unwrap(), []);
    // Only the final message is read, so a manifest whose opening tag was
    // in an earlier message is refused, as is one cut off before its end.
    assert_eq!(
        accepted("<memory id=\"2\" independent=\"true\"/>\n</mappings>").unwrap_err(),
        "root <memory> unrecognized; expected <mappings> with <memory> entries"
    );
    assert_eq!(
        accepted("</mappings>").unwrap_err(),
        "mappings manifest missing complete root element"
    );
    assert_eq!(
        accepted("<mappings>\n<memory id=\"1\" independent=\"true\"/>").unwrap_err(),
        "mappings manifest missing closing root tag"
    );
    assert_eq!(
        accepted("[{\"id\": 1}]").unwrap_err(),
        "JSON array unrecognized; expected <mappings> with <memory> entries"
    );
    assert_eq!(
        accepted("<classify><memory id=\"1\"/></classify>").unwrap_err(),
        "root <classify> unrecognized; expected <mappings> with <memory> entries"
    );
    // Every entry needs an id, and files or the mark.
    assert_eq!(
        accepted("<mappings><memory files=\"a.rs\"/></mappings>").unwrap_err(),
        "mappings manifest entry missing numeric id"
    );
    assert_eq!(
        accepted("<mappings><memory id=\"1\" files=\"\"/></mappings>").unwrap_err(),
        "mappings manifest entry 1 has neither files nor independent=\"true\""
    );
    assert_eq!(
        accepted("<mappings>stray words</mappings>").unwrap_err(),
        "parsed zero entries; expected <mappings> with <memory> entries"
    );
    // A memory of the batch mapped twice is ambiguous; an id the batch
    // didn't send is left for the apply step to drop.
    assert_eq!(
        accepted(&manifest(&[
            (1, "independent=\"true\""),
            (1, "files=\"a.rs\"")
        ]))
        .unwrap_err(),
        "mappings manifest contains duplicate id 1"
    );
    assert_eq!(
        accepted(&manifest(&[
            (9, "independent=\"true\""),
            (9, "files=\"a.rs\"")
        ]))
        .unwrap()
        .len(),
        2
    );
}

/// Five live memories, each naming nothing, in one batch.
fn apply_store() -> (Store, MapBatch) {
    let store = store(&(1..=5).map(row).collect::<Vec<_>>());
    let batch = store.batches().remove(0);
    assert_eq!(ids(&batch), [1, 2, 3, 4, 5]);
    (store, batch)
}

#[test]
fn applying_writes_each_mapping_in_one_journal_entry_naming_the_run() {
    let (store, batch) = apply_store();
    // 5 had a mapping the run replaces; its old rows go in the journal.
    store.map(5, &[mapped("", MAPPER)]);
    let revisions = store.count("SELECT SUM(revision) FROM memories");
    let applied = store.apply(
        &batch,
        &manifest(&[
            (1, "files=\"src/view.rs,./src/head.rs,src\\view.rs\""),
            (2, "independent=\"true\""),
            (5, "files=\"web/app.tsx\""),
        ]),
        41,
    );
    assert_eq!(
        applied,
        Applied {
            proposed: 3,
            applied: 3,
            dropped: Vec::new()
        }
    );
    // Paths are recorded as git names them, each once, mapped and not yet
    // checked; the mark is the row with the empty path.
    assert_eq!(
        store.mapped(1),
        [mapped("src/head.rs", MAPPER), mapped("src/view.rs", MAPPER)]
    );
    assert_eq!(store.mapped(2), [mapped("", MAPPER)]);
    assert_eq!(store.mapped(5), [mapped("web/app.tsx", MAPPER)]);
    let row = &store.mapping(1)[0];
    assert_eq!(row.verified_at, 0);
    assert!(row.mapped_at > 0);
    // Memories the reply left out stay unmapped, and nothing reports them.
    assert!(store.mapped(3).is_empty() && store.mapped(4).is_empty());

    // One journal entry for the message, keyed by the run, with every
    // mapping before and after; no undo-history row and no revision moved.
    let journal = store.journal();
    assert_eq!(journal.len(), 1);
    let (key, operation, receipt, decision) = &journal[0];
    assert_eq!(key, "dream-run:41:map-memories:0");
    assert_eq!(operation, "map");
    assert_eq!(
        receipt,
        &json!({"state": "applied", "reason": "map", "memoryIds": [1, 2, 5]})
    );
    assert_eq!(decision["writer"], "dreamer:map-memories");
    assert_eq!(decision["decisionKey"], "dream-run:41:map-memories:0");
    let mappings = decision["mappings"].as_array().unwrap();
    assert_eq!(mappings.len(), 3);
    assert_eq!(mappings[0]["memoryId"], 1);
    assert_eq!(mappings[0]["before"], json!([]));
    assert_eq!(
        mapping_of_json(&mappings[0]["after"]).unwrap(),
        store.mapping(1)
    );
    assert_eq!(
        mappings[2]["before"],
        json!([{"filePath": "", "mappingOrigin": "mapper", "verifiedAt": 7, "mappedAt": 5}])
    );
    assert!(decision.get("rows").is_none());
    assert_eq!(store.count("SELECT COUNT(*) FROM memory_history"), 0);
    assert_eq!(store.count("SELECT SUM(revision) FROM memories"), revisions);

    // The same reply again changes nothing, so it records nothing.
    let again = store.apply(
        &batch,
        &manifest(&[
            (1, "files=\"src/head.rs,src/view.rs\""),
            (2, "independent=\"true\""),
        ]),
        42,
    );
    assert_eq!(
        again,
        Applied {
            proposed: 2,
            applied: 0,
            dropped: Vec::new()
        }
    );
    assert_eq!(store.journal().len(), 1);
}

#[test]
fn applying_drops_an_id_the_batch_never_sent_or_a_memory_changed_since_it_was_read() {
    let (store, batch) = apply_store();
    store.execute(
        "UPDATE memories SET revision = revision + 1 WHERE id = 1;
         UPDATE memories SET status = 'archived' WHERE id = 2;
         UPDATE memories SET owner_id = 'pj-other' WHERE id = 3;",
    );
    let applied = store.apply(
        &batch,
        &manifest(&[
            (1, "independent=\"true\""),
            (2, "independent=\"true\""),
            (3, "independent=\"true\""),
            (4, "independent=\"true\""),
            (77, "independent=\"true\""),
        ]),
        5,
    );
    assert_eq!(applied.proposed, 5);
    assert_eq!(applied.applied, 1);
    assert_eq!(
        applied.dropped,
        [
            "memory 1 changed after the batch read it (revision 1, now 2)",
            "memory 2 is no longer a live memory of the project",
            "memory 3 is no longer a live memory of the project",
            "memory 77 is not one this batch sent",
        ]
    );
    for id in [1, 2, 3, 77] {
        assert!(store.mapped(id).is_empty(), "memory {id}");
    }
    assert_eq!(store.mapped(4), [mapped("", MAPPER)]);
    assert_eq!(store.journal()[0].2["memoryIds"], json!([4]));
}

#[test]
fn a_file_must_be_tracked_present_and_inside_the_checkout() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.rs"), "fn secret() {}\n").unwrap();
    let store = store(&(1..=5).map(row).collect::<Vec<_>>());
    let root = store.repo.root();
    // A tracked link that leads out of the checkout, a tracked link to a
    // folder inside it, and a tracked file since deleted.
    std::os::unix::fs::symlink(outside.path().join("secret.rs"), root.join("src/escape.rs"))
        .unwrap();
    std::os::unix::fs::symlink(root.join("src"), root.join("folder.rs")).unwrap();
    git(root, &["add", "src/escape.rs", "folder.rs"]);
    std::fs::remove_file(root.join("web/app.ts")).unwrap();
    let batch = &store.batches()[0];
    let applied = store.apply(
        batch,
        &manifest(&[
            (
                1,
                "files=\"src/view.rs,src/scratch.rs,src/escape.rs,folder.rs,web/app.ts,nope.rs\"",
            ),
            (2, "files=\"src/scratch.rs,web/app.ts\""),
        ]),
        6,
    );
    assert_eq!(applied.applied, 2);
    assert_eq!(
        applied.dropped,
        [
            "memory 1: src/scratch.rs is not a file git tracks in the checkout",
            "memory 1: src/escape.rs leads outside the checkout once its links are resolved",
            "memory 1: folder.rs is not a file",
            "memory 1: web/app.ts is not in the checkout",
            "memory 1: nope.rs is not a file git tracks in the checkout",
            "memory 2: src/scratch.rs is not a file git tracks in the checkout",
            "memory 2: web/app.ts is not in the checkout",
            "memory 2: none of its files passed the checks; recorded as file-independent (host_rejected_fallback)",
        ]
    );
    // The files that passed are recorded; a memory none of whose files
    // passed is marked file-independent by the module, not left unmapped.
    assert_eq!(store.mapped(1), [mapped("src/view.rs", MAPPER)]);
    assert_eq!(store.mapped(2), [mapped("", REJECTED)]);
}

#[test]
fn a_directive_shaped_project_rule_never_maps_to_files() {
    let rules = [
        "Never push without approval; see scripts/release.sh.",
        "Agents must run `cargo fmt` before committing src/view.rs.",
        "When reviewing, read src/view.rs first.",
        "The user decides which files ship.",
    ];
    let mut rows: Vec<Row> = rules
        .iter()
        .enumerate()
        .map(|(index, text)| Row {
            tag: "PROJECT_RULES",
            category: "swe:project-rules",
            content: (*text).into(),
            ..row(index as i64 + 1)
        })
        .collect();
    // A claim about code in the rules category, and a directive in another
    // category, map to files as usual.
    rows.push(Row {
        tag: "PROJECT_RULES",
        category: "swe:project-rules",
        content: "Views bind with spread args.".into(),
        ..row(5)
    });
    rows.push(Row {
        content: "Never call build_view twice.".into(),
        ..row(6)
    });
    let store = store(&rows);
    let batch = &store.batches()[0];
    let applied = store.apply(
        batch,
        &manifest(&[
            (1, "files=\"src/view.rs\""),
            (2, "files=\"src/view.rs\""),
            (3, "files=\"src/view.rs\""),
            (4, "files=\"src/view.rs\""),
            (5, "files=\"src/view.rs\""),
            (6, "files=\"src/view.rs\""),
        ]),
        8,
    );
    assert_eq!(applied.applied, 6);
    for id in 1..=4 {
        assert_eq!(store.mapped(id), [mapped("", REJECTED)], "memory {id}");
        assert!(applied.dropped.contains(&format!(
            "memory {id}: a directive-shaped project rule names files to act on, not code that backs it; recorded as file-independent (host_rejected_fallback) instead of src/view.rs"
        )));
    }
    assert_eq!(applied.dropped.len(), 4);
    assert_eq!(store.mapped(5), [mapped("src/view.rs", MAPPER)]);
    assert_eq!(store.mapped(6), [mapped("src/view.rs", MAPPER)]);
    assert!(!directive_shaped_rule("swe:project-rules", "   "));
}

#[test]
fn the_module_runs_the_task_kind() {
    assert_eq!(MapMemories.kind(), "map-memories");
    assert!(crate::dreamer::tasks()
        .iter()
        .any(|task| task.kind() == "map-memories"));
}

/// The run's outcome, proposed and applied counts and dropped list, once
/// it has ended.
async fn ended_run(db: &ContextDb) -> (String, i64, i64, Value) {
    for _ in 0..500 {
        let ended = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT outcome, proposed, applied, dropped_json FROM dream_task_runs
                      WHERE ended_at IS NOT NULL",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .optional()
            })
            .unwrap();
        if let Some((outcome, proposed, applied, dropped)) = ended {
            let dropped = dropped.map_or(Value::Null, |text| serde_json::from_str(&text).unwrap());
            return (outcome, proposed, applied, dropped);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the run never ended");
}

/// A whole run through the engine: the project's schedule comes due, the
/// task reads the store and the checkout, its one message goes to a child
/// with AFT's reader tools, and the reply's mappings are written under the
/// run's id.
#[tokio::test]
async fn a_due_run_maps_the_project_s_memories_through_the_engine() {
    let store = store(&[
        Row {
            content: "Views are built in `src/view.rs`.".into(),
            ..row(1)
        },
        Row {
            content: "Anthropic returns 400 on empty content.".into(),
            ..row(2)
        },
        row(3),
    ]);
    let Store { _dir, db, repo } = store;
    let db = Arc::new(db);
    let engine = Arc::new(Engine::new("this", vec![Box::new(MapMemories)]));
    let profile = Arc::new(prompt_profile(None).unwrap());
    let root = repo.root().display().to_string();
    engine.see_project(&db, PROJECT, &root, profile, &Settings::default(), 1);
    db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
    let answer: &'static str = Box::leak(
        manifest(&[
            (1, "files=\"src/view.rs\""),
            (2, "independent=\"true\""),
            (9, "independent=\"true\""),
        ])
        .into_boxed_str(),
    );
    let mut client = Client::new(&["p/a"], &[Ends::Reply(answer)]);
    client.plans = vec!["ra"];
    client.catalog = Ok(vec![("read", &["code.read/v1"]), ("grep", &[])]);
    let client = Arc::new(client);

    engine.tick(&db, &client, &Settings::default(), now_ms());
    let (outcome, proposed, applied, dropped) = ended_run(&db).await;

    assert_eq!((outcome.as_str(), proposed, applied), ("applied", 3, 2));
    assert_eq!(dropped, json!(["memory 9 is not one this batch sent"]));
    // One child, created with the reader tools in the project's folder, its
    // message listing every memory with no mapping.
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let (child, request) = &sends[0];
    assert_eq!(child.session.session, "mc-dream:1.0:0.0");
    assert_eq!(child.project_root.as_deref(), Some(root.as_str()));
    let plan = request.plan.as_ref().expect("a plan");
    assert_eq!(
        plan["tool_items"],
        json!([{"params": {}, "preset": "reader", "provider": "aft"}])
    );
    assert!(plan["system_text_items"][0]["params"]["text"]
        .as_str()
        .unwrap()
        .starts_with("You are a memory mapper"));
    assert_eq!(request.runner_params["stop_when"], json!({"max_steps": 60}));
    let prompt = request.prompt.as_deref().unwrap();
    assert!(prompt.contains(&format!("Project: {PROJECT}")));
    assert!(prompt.contains(
        "[1] ARCHITECTURE\nViews are built in `src/view.rs`.\nLikely files (candidate paths, confirmed to exist): src/view.rs"
    ));
    assert!(prompt.contains("[3] ARCHITECTURE\nFact 3."));
    drop(sends);

    // The spawned run may still hold the store, so it is read in place.
    let mapped_now = |id: i64| -> Vec<(String, String)> {
        db.with_connection(|conn| mapping_rows(conn, id))
            .unwrap()
            .into_iter()
            .map(|row| (row.file_path, row.mapping_origin))
            .collect()
    };
    assert_eq!(mapped_now(1), [mapped("src/view.rs", MAPPER)]);
    assert_eq!(mapped_now(2), [mapped("", MAPPER)]);
    assert!(mapped_now(3).is_empty());
    let journal: Vec<(String, String)> = db
        .with_connection(|conn| {
            conn.prepare("SELECT decision_key, receipt_json FROM memory_journal ORDER BY id")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].0, "dream-run:1:map-memories:0");
    let receipt: Value = serde_json::from_str(&journal[0].1).unwrap();
    assert_eq!(receipt["memoryIds"], json!([1, 2]));
    drop((_dir, repo));
}

#[test]
fn undoing_the_run_puts_back_the_mappings_it_replaced_unless_they_changed_since() {
    use crate::memory_writes::person::{self, LeftAlone, OwnerRef};
    let (store, batch) = apply_store();
    store.map(3, &[mapped("src/head.rs", MAPPER)]);
    store.map(4, &[mapped("", MAPPER)]);
    store.apply(
        &batch,
        &manifest(&[
            (1, "files=\"src/view.rs\""),
            (3, "files=\"src/view.rs\""),
            (4, "files=\"web/app.tsx\""),
        ]),
        12,
    );
    // Verify checking 1's file later is no change; a person remapping 4 is.
    store.execute(
        "UPDATE memory_verifications SET verified_at = 99 WHERE memory_id = 1;
         DELETE FROM memory_verifications WHERE memory_id = 4;",
    );
    store.map(4, &[mapped("src/head.rs", MAPPER)]);
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: PROJECT.into(),
    };
    let plan = store
        .db
        .with_connection(|conn| person::plan_run_undo(conn, &owner, 12))
        .unwrap();
    assert!(plan.restore.is_empty());
    assert_eq!(
        plan.mappings
            .iter()
            .map(|mapping| mapping.id)
            .collect::<Vec<_>>(),
        [1, 3]
    );
    assert_eq!(plan.left, [(4, LeftAlone::ChangedAfter)]);
    let decision = store
        .db
        .with_connection(|conn| person::undo_run(conn, &owner, 12, &plan))
        .unwrap();
    // 1 had no mapping before the run; 3 gets its old file back, with the
    // times it had; 4 keeps the person's.
    assert!(store.mapped(1).is_empty());
    assert_eq!(store.mapping(3)[0].file_path, "src/head.rs");
    assert_eq!(
        (
            store.mapping(3)[0].verified_at,
            store.mapping(3)[0].mapped_at
        ),
        (7, 5)
    );
    assert_eq!(store.mapped(4), [mapped("src/head.rs", MAPPER)]);
    assert_eq!(decision["evidence"]["runId"], 12);
    assert_eq!(decision["evidence"]["mappings"][0]["memoryId"], 1);
    assert_eq!(
        decision["evidence"]["mappings"][1]["after"][0]["filePath"],
        "src/head.rs"
    );
    // Undone once, there is nothing left to undo.
    let again = store
        .db
        .with_connection(|conn| person::plan_run_undo(conn, &owner, 12))
        .unwrap();
    assert!(again.mappings.is_empty());
}
