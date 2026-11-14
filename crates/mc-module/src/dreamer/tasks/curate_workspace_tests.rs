//! The workspace curate task: what a run of a workspace's shared memories
//! reads, what its message shows, and how its changes are checked and
//! written at the workspace level.

use cortexkit_role_compaction::setup::ModelRef;
use rusqlite::params;
use serde_json::Value;

use super::*;
use crate::context_db::ContextDb;
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::Applied;
use crate::dreamer::tasks::curate::{parse_list, Written};
use crate::memory_profile::prompt_profile;
use crate::memory_writes::normalized_hash;
use crate::memory_writes::person::{self, OwnerRef};
use crate::summary::fit::Window;
use crate::workspace_members::Member;

pub(crate) const WORKSPACE: &str = "ws-curate";
const RUN: i64 = 7;

/// A memory row as the tests write it.
#[derive(Clone)]
pub(crate) struct Row {
    pub(crate) id: i64,
    pub(crate) level: &'static str,
    pub(crate) owner: String,
    pub(crate) category: &'static str,
    pub(crate) tag: &'static str,
    pub(crate) content: String,
    pub(crate) status: &'static str,
    pub(crate) source_project: Option<&'static str>,
    pub(crate) source_type: &'static str,
    pub(crate) safety_critical: bool,
    pub(crate) expires_at: Option<i64>,
}

/// Memory `id`: a live rule the workspace shares, lifted from project
/// `pj-a`.
pub(crate) fn rule(id: i64, content: &str) -> Row {
    Row {
        id,
        level: "workspace",
        owner: WORKSPACE.into(),
        category: "swe:project-rules",
        tag: "PROJECT_RULES",
        content: content.into(),
        status: "active",
        source_project: Some("pj-a"),
        source_type: "historian",
        safety_critical: false,
        expires_at: None,
    }
}

/// Memory `id`: one of the person's own memories, which every session sees.
pub(crate) fn personal(id: i64, content: &str) -> Row {
    Row {
        level: "global",
        owner: "self".into(),
        category: "base:communication",
        tag: "COMMUNICATION",
        source_project: None,
        ..rule(id, content)
    }
}

pub(crate) fn insert(db: &ContextDb, rows: &[Row]) {
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for row in rows {
            tx.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                      importance, status, expires_at, source_type, source_project_id,
                                      safety_critical, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 50, ?8, ?9, ?10, ?11, ?12, 0, 0, 0, 0)",
                params![
                    row.id,
                    row.level,
                    row.owner,
                    row.category,
                    row.tag,
                    row.content,
                    normalized_hash(&row.content),
                    row.status,
                    row.expires_at,
                    row.source_type,
                    row.source_project,
                    row.safety_critical
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    });
}

/// The workspace with projects named `names`, in that order.
pub(crate) fn members(names: &[&str]) -> WorkspaceMembers {
    WorkspaceMembers {
        workspace_id: WORKSPACE.into(),
        name: "CortexKit".into(),
        members: names
            .iter()
            .enumerate()
            .map(|(index, name)| Member {
                project_id: format!("pj-{index}"),
                name: (*name).into(),
            })
            .collect(),
    }
}

struct Store {
    _dir: tempfile::TempDir,
    db: ContextDb,
}

/// The rules most tests curate, and what a run must leave out or show
/// beside them.
fn fixture() -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    insert(
        &db,
        &[
            rule(1, "Run `cargo fmt --all` before every commit."),
            Row {
                source_project: Some("pj-b"),
                ..rule(2, "Before committing, run `cargo fmt --all`.")
            },
            rule(
                3,
                "Every release needs two reviewers, and the CI run must be green, which takes 45 minutes on main.",
            ),
            Row {
                source_project: Some("pj-c"),
                ..rule(
                    4,
                    "The release checklist lives in docs/release.md. Release tags use the vX.Y.Z form.",
                )
            },
            Row {
                safety_critical: true,
                ..rule(5, "Never force-push to main.")
            },
            Row {
                source_project: Some("pj-b"),
                ..rule(6, "Always answer the person in English.")
            },
            Row {
                source_type: "person",
                ..rule(7, "Prefer short commit messages.")
            },
            Row {
                category: "swe:architecture",
                tag: "ARCHITECTURE",
                ..rule(8, "The module owns context.db from schema 106 on.")
            },
            Row {
                owner: "ws-other".into(),
                ..rule(9, "A rule of another workspace.")
            },
            Row {
                level: "project",
                owner: "pj-a".into(),
                ..rule(10, "A rule of one project.")
            },
            Row {
                status: "archived",
                ..rule(11, "An archived rule.")
            },
            Row {
                expires_at: Some(1),
                ..rule(12, "An expired rule.")
            },
            personal(30, "Always answer the person in English."),
            Row {
                status: "archived",
                ..personal(31, "An archived memory of the person.")
            },
        ],
    );
    Store { _dir: dir, db }
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

impl Store {
    /// The run's batches for `workspace`, on the bundled profile.
    fn plan(&self, workspace: &WorkspaceMembers, only: Option<&str>) -> Vec<CurateBatch> {
        let profile = prompt_profile(None).unwrap();
        let declaration = declaration();
        let owner = Owner::Workspace {
            id: workspace.workspace_id.clone(),
        };
        CurateWorkspace
            .plan_batches(
                &TaskContext {
                    db: &self.db,
                    owner: &owner,
                    profile: &profile,
                    declaration: &declaration,
                    workspace: Some(workspace),
                },
                None,
                only,
            )
            .unwrap()
    }

    /// The one batch of the workspace's rules.
    fn rules(&self) -> CurateBatch {
        let mut batches = self.plan(
            &members(&["subc", "magic-context", "entorhinal"]),
            Some("PROJECT_RULES"),
        );
        assert_eq!(batches.len(), 1);
        batches.remove(0)
    }

    /// Write `changes` as `batch`'s reply for the test run, as the engine
    /// does, in one transaction.
    fn write(&self, batch: &CurateBatch, changes: &str) -> Written {
        let entries = parse_list(&format!("<curate>\n{changes}\n</curate>")).unwrap();
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let written = batch.write(&tx, &entries, "mc-dream:7.0:0.0", RUN).unwrap();
            tx.commit().unwrap();
            written
        })
    }

    /// A memory's level, owner, status, successor, source project and text.
    fn memory(&self, id: i64) -> Stored {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT level, owner_id, status, superseded_by_memory_id, source_project_id, content
                       FROM memories WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(Stored {
                            level: row.get(0)?,
                            owner: row.get(1)?,
                            status: row.get(2)?,
                            superseded_by: row.get(3)?,
                            source_project: row.get(4)?,
                            content: row.get(5)?,
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

    /// Every dreamer journal row: decision key, operation, the project
    /// path it is filed under, and the decision it keeps.
    fn journal(&self) -> Vec<(String, String, String, Value)> {
        self.db.with_connection(|conn| {
            conn.prepare(
                "SELECT decision_key, operation, project_path, before_json FROM memory_journal
                  WHERE decision_key LIKE 'dream-run:%' ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    serde_json::from_str(&row.get::<_, String>(3)?).unwrap(),
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
    level: String,
    owner: String,
    status: String,
    superseded_by: Option<i64>,
    source_project: Option<String>,
    content: String,
}

fn ids(batch: &CurateBatch) -> Vec<i64> {
    batch.read.iter().map(|(id, _)| *id).collect()
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

// --- The task as the profile declares it ---

#[test]
fn the_profile_declares_curate_for_the_workspace_as_it_declares_it_for_a_project() {
    let profile = prompt_profile(None).unwrap();
    let task = |id: &str| {
        profile.body["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == id)
            .unwrap_or_else(|| panic!("the bundled profile declares no {id}"))
            .clone()
    };
    let (workspace, project) = (task("swe:curate-workspace"), task("swe:curate"));
    assert_eq!(workspace["kind"], KIND);
    assert_eq!(workspace["enabled"], true);
    for field in ["reads", "evidence", "actions", "categories"] {
        assert_eq!(workspace[field], project[field], "{field}");
    }
    assert_eq!(
        workspace["prompts"],
        serde_json::json!({
            "system": "dreamer/swe:curate-workspace/system",
            "user": "dreamer/swe:curate-workspace/user",
        })
    );
    // Its routing consumer asks for what curate's asks for.
    let demand = |kind: &str| {
        crate::routing::DREAM_DEMANDS
            .iter()
            .find(|demand| demand.kind == kind)
            .unwrap_or_else(|| panic!("no routing demand for {kind}"))
    };
    let (ours, curate) = (demand(KIND), demand(super::super::curate::KIND));
    assert_eq!(
        (
            ours.iq,
            ours.context_window,
            ours.reads_code,
            ours.max_steps
        ),
        (
            curate.iq,
            curate.context_window,
            curate.reads_code,
            curate.max_steps
        )
    );
    assert_eq!(
        crate::routing::dream_consumer(KIND),
        "magic-context.dream.curate-workspace"
    );
    // Its default schedule is curate's.
    assert_eq!(
        crate::dreamer::engine::default_schedule(KIND),
        crate::dreamer::engine::default_schedule("curate")
    );
    assert!(CurateWorkspace.workspace() && !CurateWorkspace.once() && !CurateWorkspace.global());
}

// --- What a run reads and shows ---

#[test]
fn the_pool_is_the_workspaces_live_memories_of_the_category() {
    let store = fixture();
    let batch = store.rules();
    // Not the architecture memory, another workspace's, a project's, an
    // archived or an expired one.
    assert_eq!(ids(&batch), [1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(batch.scope, Scope::workspace(WORKSPACE));
    // The safety-critical and the person's memories are protected.
    let message = batch.message();
    assert!(message.contains("\n[5] protected\nNever force-push to main.\n"));
    assert!(message.contains("\n[7] protected\nPrefer short commit messages.\n"));
    assert!(message.contains("\n[1]\nRun `cargo fmt --all` before every commit.\n"));
    // The workspace's memories of another category are not shown.
    assert!(!message.contains("[8]"));
}

#[test]
fn the_message_shows_the_persons_memories_the_head_shows_and_names_the_workspace() {
    let store = fixture();
    let batch = store.rules();
    let message = batch.message();
    assert!(message.starts_with(
        "## Curate the `PROJECT_RULES` memories\n\n**Workspace:** CortexKit, with 3 projects: entorhinal, magic-context, subc\n\n"
    ));
    let shown =
        &message[message.find("<always-shown>").unwrap()..message.find("</always-shown>").unwrap()];
    // The person's live memory, with its category's tag, under the
    // workspace frame's own instruction; not their archived one, and none
    // of the workspace's or a project's memories.
    assert_eq!(
        shown,
        "<always-shown>\nEvery session in the workspace already sees these memories of the person, from any category. Use them to find duplicates. Do not change them.\n[30] COMMUNICATION: Always answer the person in English.\n"
    );
    // A workspace has no documents.
    assert!(!message.contains("<project-documents>"));
    assert!(!batch.system().contains('⟦'));
    assert!(batch
        .system()
        .contains("You curate the memories a workspace shares."));
    // A workspace of one project shares no memories: no run.
    assert!(store.plan(&members(&["subc"]), None).is_empty());
}

#[test]
fn similar_memories_come_from_the_workspaces_other_parts() {
    let store = fixture();
    let batches = store.plan(&members(&["subc", "magic-context"]), Some("PROJECT_RULES"));
    // Resumed after memory 1: memory 2 is in the part, memory 1 outside it.
    let resume = Resume {
        category: "swe:project-rules".into(),
        part: 2,
        after: 1,
    };
    let profile = prompt_profile(None).unwrap();
    let declaration = declaration();
    let workspace = members(&["subc", "magic-context"]);
    let owner = Owner::Workspace {
        id: WORKSPACE.into(),
    };
    let resumed = CurateWorkspace
        .plan_batches(
            &TaskContext {
                db: &store.db,
                owner: &owner,
                profile: &profile,
                declaration: &declaration,
                workspace: Some(&workspace),
            },
            Some(&resume),
            Some("PROJECT_RULES"),
        )
        .unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].part, (2, 2));
    let message = resumed[0].message();
    let similar = &message[message.find("<similar>").unwrap()..message.find("</similar>").unwrap()];
    assert!(similar.contains("\n[1] Run `cargo fmt --all` before every commit."));
}

/// Compare `actual` with the golden file `name`. With
/// `MC_REGENERATE_DREAMER_GOLDENS` set, write it first.
fn golden(name: &str, actual: &str) {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
    let store = fixture();
    let batch = store.rules();
    let window = Window {
        counter: crate::count::Counter::for_model(None),
        context_window: 1_000_000,
    };
    let message = batch
        .prompt(window, crate::routing::DREAM_OUTPUT_TOKENS)
        .unwrap();
    golden(
        "curate-workspace-request.txt",
        &format!(
            "=== system ===\n{}\n=== user ===\n{message}\n",
            batch.system()
        ),
    );
}

// --- Checks and writes ---

#[test]
fn a_merge_writes_a_workspace_memory_and_supersedes_the_copies() {
    let store = fixture();
    let batch = store.rules();
    let written = store.write(
        &batch,
        "<merge ids=\"2,1\">Run `cargo fmt --all` before every commit.</merge>",
    );
    assert_eq!(written.refusals, [None], "{written:?}");
    // Memory 1 already holds the merged text, so it survives; memory 2 is
    // archived as replaced by it.
    let (survivor, merged) = (store.memory(1), store.memory(2));
    assert_eq!(
        (
            survivor.level.as_str(),
            survivor.owner.as_str(),
            survivor.status.as_str()
        ),
        ("workspace", WORKSPACE, "active")
    );
    assert_eq!(
        (merged.status.as_str(), merged.superseded_by),
        ("archived", Some(1))
    );

    // A merge into new text writes a new workspace memory beside the first
    // source it names, from that source's project.
    let store = fixture();
    let batch = store.rules();
    let written = store.write(
        &batch,
        "<merge ids=\"2,1\">Run `cargo fmt --all` before each commit.</merge>",
    );
    assert_eq!(written.refusals, [None], "{written:?}");
    let new: i64 = store.value("SELECT MAX(id) FROM memories");
    assert!(new > 31);
    assert_eq!(
        store.memory(new),
        Stored {
            level: "workspace".into(),
            owner: WORKSPACE.into(),
            status: "active".into(),
            superseded_by: None,
            source_project: Some("pj-b".into()),
            content: "Run `cargo fmt --all` before each commit.".into(),
        }
    );
    for id in [1, 2] {
        assert_eq!(store.memory(id).superseded_by, Some(new));
    }
    let journal = store.journal();
    assert_eq!(journal.len(), 1);
    let (key, operation, path, decision) = &journal[0];
    assert_eq!(key, "dream-run:7:curate-workspace:0:0");
    assert_eq!(operation, "curate_workspace_merge");
    // The workspace's history names the workspace, as the person's own
    // edits of its memories do.
    assert_eq!(path, WORKSPACE);
    assert_eq!(decision["projectPath"], WORKSPACE);
    assert_eq!(decision["writer"], "dreamer:curate-workspace");
}

#[test]
fn a_split_keeps_the_project_the_memory_came_from() {
    let store = fixture();
    let batch = store.rules();
    let written = store.write(
        &batch,
        "<split id=\"4\"><part>The release checklist lives in docs/release.md.</part><part>Release tags use the vX.Y.Z form.</part></split>",
    );
    assert_eq!(written.refusals, [None], "{written:?}");
    assert_eq!(
        store.memory(4).content,
        "The release checklist lives in docs/release.md."
    );
    let new: i64 = store.value("SELECT MAX(id) FROM memories");
    let part = store.memory(new);
    assert_eq!(
        (
            part.level.as_str(),
            part.owner.as_str(),
            part.source_project.as_deref(),
            part.content.as_str()
        ),
        (
            "workspace",
            WORKSPACE,
            Some("pj-c"),
            "Release tags use the vX.Y.Z form."
        )
    );
}

#[test]
fn a_duplicate_may_name_a_memory_of_the_person_the_message_showed() {
    let store = fixture();
    let batch = store.rules();
    let written = store.write(&batch, "<archive id=\"6\" reason=\"duplicate\" of=\"30\"/>");
    assert_eq!(written.refusals, [None], "{written:?}");
    let archived = store.memory(6);
    assert_eq!(
        (archived.status.as_str(), archived.superseded_by),
        ("archived", Some(30))
    );
    // The person's memory itself is not changed.
    assert_eq!(store.memory(30).status, "active");
    let link: i64 =
        store.value("SELECT successor_id FROM memory_successor_links WHERE source_id = 6");
    assert_eq!(link, 30);
}

/// What `batch` refuses of `changes`, after checking that nothing was
/// written.
fn refused(store: &Store, batch: &CurateBatch, changes: &str) -> Vec<Option<String>> {
    let before: Vec<Stored> = (1..=12).chain(30..=31).map(|id| store.memory(id)).collect();
    let written = store.write(batch, changes);
    assert_eq!(written.applied.applied, 0, "{changes}: {written:?}");
    let after: Vec<Stored> = (1..=12).chain(30..=31).map(|id| store.memory(id)).collect();
    assert_eq!(before, after, "{changes} changed a memory");
    written.refusals
}

#[test]
fn a_change_that_fails_a_check_leaves_the_memory_as_it_is_and_says_why() {
    let store = fixture();
    let batch = store.rules();
    let cases: &[(&str, &str)] = &[
        // A workspace has no documents to repeat.
        (
            "<archive id=\"3\" reason=\"duplicate\" quote=\"Every release needs two reviewers and a green CI run.\"/>",
            "a workspace has no documents to quote",
        ),
        (
            "<archive id=\"3\" reason=\"duplicate\"/>",
            "a duplicate names no memory (of)",
        ),
        // Only a memory the message showed may be named, and only while
        // it is still live where it was shown.
        (
            "<archive id=\"3\" reason=\"duplicate\" of=\"10\"/>",
            "memory 10 was not shown with this part",
        ),
        (
            "<archive id=\"3\" reason=\"duplicate\" of=\"31\"/>",
            "memory 31 was not shown with this part",
        ),
        // Memories of a project, of another workspace, or outside the
        // category are not the part's.
        ("<shorten id=\"10\">One rule.</shorten>", "memory 10 is not in this part"),
        ("<shorten id=\"9\">A rule.</shorten>", "memory 9 is not in this part"),
        ("<shorten id=\"8\">The module owns context.db.</shorten>", "memory 8 is not in this part"),
        // Protected memories are never changed.
        (
            "<archive id=\"5\" reason=\"lesson\" why=\"a story\"/>",
            "memory 5 is protected",
        ),
        (
            "<merge ids=\"7,1\">Prefer short commit messages; run `cargo fmt --all` first.</merge>",
            "memory 7 is protected",
        ),
        // Every path, name and number stays.
        (
            "<shorten id=\"3\">Every release needs two reviewers and a green CI run.</shorten>",
            "the new text drops",
        ),
    ];
    for (changes, why) in cases {
        let refusals = refused(&store, &batch, changes);
        assert!(
            refusals.len() == 1
                && refusals[0]
                    .as_deref()
                    .is_some_and(|said| said.contains(why)),
            "{changes}: expected {why:?}, got {refusals:?}"
        );
    }
    // A refusal is recorded in the run's record with its part.
    let entries =
        parse_list("<curate><archive id=\"5\" reason=\"lesson\" why=\"a story\"/></curate>")
            .unwrap();
    let applied: Applied = store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        batch.write(&tx, &entries, "child", RUN).unwrap().applied
    });
    assert_eq!(
        applied.dropped,
        ["PROJECT_RULES part 1, archive 5: memory 5 is protected"]
    );

    // A memory of the person that stops being live is no longer a valid
    // original.
    store
        .db
        .with_connection(|conn| {
            conn.execute("UPDATE memories SET status = 'archived' WHERE id = 30", [])
        })
        .unwrap();
    let refusals = refused(
        &store,
        &batch,
        "<archive id=\"6\" reason=\"duplicate\" of=\"30\"/>",
    );
    assert_eq!(
        refusals,
        [Some(
            "memory 30 is no longer a live memory every session sees".into()
        )]
    );
    // A memory changed after the run read it is left alone.
    store
        .db
        .with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET revision = revision + 1 WHERE id = 3",
                [],
            )
        })
        .unwrap();
    let refusals = refused(
        &store,
        &batch,
        "<archive id=\"3\" reason=\"one-off\" why=\"a run id\"/>",
    );
    assert!(
        refusals[0]
            .as_deref()
            .is_some_and(|why| why.contains("memory 3 changed after the run read it")),
        "{refusals:?}"
    );
}

#[test]
fn applying_a_part_moves_the_workspace_schedules_resume_point() {
    let store = fixture();
    let owner = crate::dreamer::store::OwnerKey::workspace(WORKSPACE);
    store.db.with_connection(|conn| {
        crate::dreamer::store::ensure_schedule(
            conn,
            &owner,
            "swe:curate-workspace",
            "0 4 * * 0",
            0,
        )
        .unwrap();
    });
    // Two categories: the rules, then the architecture memory.
    let batches = store.plan(&members(&["subc", "magic-context"]), None);
    assert_eq!(batches.len(), 2);
    store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        batches[0]
            .apply(&tx, &reply("<curate></curate>"), RUN)
            .unwrap();
        tx.commit().unwrap();
    });
    let resume = store.db.with_connection(|conn| {
        super::super::curate::stored_resume(conn, &owner, "swe:curate-workspace").unwrap()
    });
    assert_eq!(
        resume,
        Some(Resume {
            category: "swe:architecture".into(),
            part: 1,
            after: 0,
        })
    );
}

#[test]
fn a_run_of_the_workspace_undoes_as_one() {
    let store = fixture();
    let originals: Vec<Stored> = (1..=7).map(|id| store.memory(id)).collect();
    let batch = store.rules();
    let written = store.write(
        &batch,
        "<merge ids=\"1,2\">Run `cargo fmt --all` before each commit.</merge>\n\
         <archive id=\"6\" reason=\"duplicate\" of=\"30\"/>",
    );
    assert_eq!(written.refusals, [None, None], "{written:?}");
    let owner = OwnerRef {
        level: "workspace".into(),
        owner_id: WORKSPACE.into(),
    };
    store.db.with_connection(|conn| {
        let plan = person::plan_run_undo(conn, &owner, RUN).unwrap();
        assert!(plan.left.is_empty(), "{:?}", plan.left);
        person::undo_run(conn, &owner, RUN, &plan).unwrap();
    });
    for (index, original) in originals.iter().enumerate() {
        assert_eq!(
            &store.memory(index as i64 + 1),
            original,
            "memory {}",
            index + 1
        );
    }
}
