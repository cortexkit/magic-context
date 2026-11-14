use std::path::PathBuf;

use cortexkit_role_compaction::setup::ModelRef;

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::memory_profile::{prompt_profile, FRAMES};
use crate::memory_writes::normalized_hash;
use crate::memory_writes::person::{plan_run_undo, undo_run, OwnerRef};
use crate::workspace_members::Member;

pub(crate) const PROJECT: &str = "pj-lift";
pub(crate) const WORKSPACE: &str = "ws-lift";

/// A temporary store at the module's schema.
pub(crate) struct Store {
    _dir: tempfile::TempDir,
    pub(crate) db: ContextDb,
}

/// A memory row as the tests write it.
#[derive(Clone)]
pub(crate) struct Row {
    pub(crate) id: i64,
    pub(crate) level: &'static str,
    pub(crate) owner: &'static str,
    pub(crate) tag: &'static str,
    pub(crate) content: String,
    pub(crate) status: &'static str,
    pub(crate) expires_at: Option<i64>,
    pub(crate) source_type: &'static str,
}

/// Memory `id`: a live rule of the test project the summarizer wrote.
pub(crate) fn row(id: i64) -> Row {
    Row {
        id,
        level: "project",
        owner: PROJECT,
        tag: "PROJECT_RULES",
        content: format!("Rule {id}."),
        status: "active",
        expires_at: None,
        source_type: "historian",
    }
}

pub(crate) fn store(rows: &[Row]) -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    insert(&db, rows);
    Store { _dir: dir, db }
}

pub(crate) fn insert(db: &ContextDb, rows: &[Row]) {
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for row in rows {
            tx.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                      status, expires_at, source_type, source_project_id,
                                      first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, 0)",
                params![
                    row.id,
                    row.level,
                    row.owner,
                    frozen_category_id(row.tag),
                    row.tag,
                    row.content,
                    normalized_hash(&row.content),
                    row.status,
                    row.expires_at,
                    row.source_type,
                    PROJECT
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    });
}

/// A workspace named CortexKit holding projects with these names.
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

fn three() -> WorkspaceMembers {
    members(&["subc", "magic-context", "entorhinal"])
}

impl Store {
    fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    /// The run a lift of the test project into `workspace` would send, on
    /// the bundled profile.
    fn plan(&self, workspace: &WorkspaceMembers) -> (Pool, Vec<LiftBatch>) {
        let profile = prompt_profile(None).unwrap();
        let declaration = declaration(&profile);
        let owner = Owner::Project {
            id: PROJECT.into(),
            root: "/work/project".into(),
        };
        LiftWorkspace
            .plan_batches(
                &TaskContext {
                    db: &self.db,
                    owner: &owner,
                    profile: &profile,
                    declaration: &declaration,
                    workspace: Some(workspace),
                },
                workspace,
            )
            .unwrap()
    }

    /// Apply `text` as `batch`'s reply for run `run`, as the engine does: in
    /// one transaction, committed only when the batch accepts it.
    fn apply(&self, batch: &LiftBatch, text: &str, run: i64) -> Result<Applied, String> {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.apply(&tx, &reply(text), run)?;
            tx.commit().unwrap();
            Ok(applied)
        })
    }

    /// A memory's level, owner, source project, revision and text.
    fn placed(&self, id: i64) -> (String, String, Option<String>, i64, String) {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT level, owner_id, source_project_id, revision, content FROM memories WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
            })
            .unwrap()
    }
}

fn declaration(profile: &Profile) -> serde_json::Value {
    profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == "swe:lift-workspace")
        .unwrap()
        .clone()
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

/// A `<place>` manifest with one entry per id and its attributes.
fn manifest(entries: &[(i64, &str)]) -> String {
    let lines: String = entries
        .iter()
        .map(|(id, attributes)| format!("<memory id=\"{id}\" {attributes}/>\n"))
        .collect();
    format!("<place>\n{lines}</place>")
}

fn file(path: &str) -> String {
    std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn the_bundled_profile_registers_the_lift_switched_off_and_renders_its_texts_unchanged() {
    let profile = prompt_profile(None).unwrap();
    let declaration = declaration(&profile);
    assert_eq!(declaration["kind"], KIND);
    // A person reads a replay's report before the lift runs for real; until
    // then the bundled profile declares it off.
    assert_eq!(declaration["enabled"], false);
    assert!(crate::dreamer::tasks()
        .iter()
        .any(|task| task.kind() == KIND && task.once()));

    let store = store(&[
        row(1),
        Row {
            tag: "CONSTRAINTS",
            content: "Line one.\nLine two.".into(),
            ..row(2)
        },
    ]);
    let (_, batches) = store.plan(&three());
    assert_eq!(batches.len(), 1);
    // The system prompt is the profile's text with the output contract in
    // place of its marker, word for word.
    let system = file("profiles/memory-swe/prompts/dreamer/lift-workspace/system.md").replace(
        "⟦mc:lift-workspace.output-contract⟧\n",
        &file("frames/dreamer/lift-workspace.output-contract.md"),
    );
    assert_eq!(batches[0].system, system.trim_end_matches('\n'));
    // The message names the project and the workspace with its projects,
    // sorted, then lists the memories in the input frame's shape.
    let message = file("profiles/memory-swe/prompts/dreamer/lift-workspace/user.md")
        // The members carry no ids here, so the project is named by its id.
        .replace("⟦project.name⟧", PROJECT)
        .replace("⟦workspace.name⟧", "CortexKit")
        .replace("⟦workspace.count⟧", "3")
        .replace("⟦workspace.projects⟧", "entorhinal, magic-context, subc")
        .replace(
            "⟦mc:lift-workspace.input⟧\n",
            "### Memories of this project\n[1] PROJECT_RULES\nRule 1.\n\n[2] CONSTRAINTS\nLine one.\nLine two.\n",
        );
    assert_eq!(batches[0].message, message.trim_end_matches('\n'));
}

#[test]
fn the_input_follows_its_frame_line_for_line() {
    let memory = Memory {
        id: 1,
        category: "CONSTRAINTS".into(),
        content: "Releases need two reviewers.".into(),
        revision: 1,
        person: false,
    };
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .unwrap();
    let filled = frame
        .replace("⟦memory.id⟧", "1")
        .replace("⟦memory.category⟧", "CONSTRAINTS")
        .replace("⟦memory.content⟧", "Releases need two reviewers.");
    assert_eq!(input(&[memory]), filled.trim_end_matches('\n'));
}

#[test]
fn a_run_sends_live_project_memories_in_batches_of_forty_and_never_the_persons() {
    let mut rows: Vec<Row> = (1..=90).map(row).collect();
    rows.extend([
        Row {
            status: "archived",
            ..row(91)
        },
        Row {
            expires_at: Some(1),
            ..row(92)
        },
        Row {
            owner: "pj-other",
            ..row(93)
        },
        Row {
            level: "workspace",
            owner: WORKSPACE,
            ..row(94)
        },
        // The person wrote this one from the apps, and edited the next.
        Row {
            source_type: "person",
            ..row(95)
        },
        row(96),
        Row {
            status: "permanent",
            ..row(97)
        },
    ]);
    let store = store(&rows);
    store.execute(
        "INSERT INTO memory_history(memory_id, revision, previous_text, after_text, applied_at, reason,
                                    evidence_json, source_ids_json, decision_key)
         VALUES (96, 0, 'Rule 96 before.', 'Rule 96.', 5, 'person_edit', '[]', '[96]', 'person-key');
         INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
         VALUES ('pj-lift', 'person-key', 'person_edit', '{}', 5);",
    );

    let (pool, batches) = store.plan(&three());
    assert_eq!(pool.person, [95, 96]);
    let sent: Vec<Vec<i64>> = batches.iter().map(LiftBatch::ids).collect();
    let mut expected: Vec<i64> = (1..=90).collect();
    expected.push(97);
    assert_eq!(
        sent.iter().map(Vec::len).collect::<Vec<_>>(),
        [BATCH_SIZE, BATCH_SIZE, 11]
    );
    assert_eq!(sent.concat(), expected);
    for batch in &batches {
        assert!(!batch.message.contains("Rule 95."));
        assert!(!batch.message.contains("Rule 96."));
    }
}

#[test]
fn a_workspace_of_one_project_plans_nothing() {
    let store = store(&[row(1)]);
    let (pool, batches) = store.plan(&members(&["solo"]));
    assert!(batches.is_empty());
    assert!(pool.sent.is_empty());
}

#[test]
fn the_manifest_gate_takes_only_a_complete_manifest() {
    let ids = [1, 2];
    let good = "Placed.\n<place>\n<memory id=\"1\" level=\"project\"/>\n<memory id=\"2\" level=\"workspace\" reason=\"Every project &quot;ships&quot; when x > y.\" />\n</place>";
    assert_eq!(
        validate_manifest(good, &ids).unwrap(),
        [
            Verdict {
                id: 1,
                workspace: None
            },
            Verdict {
                id: 2,
                workspace: Some("Every project \"ships\" when x > y.".into())
            }
        ]
    );
    // A reason on a project entry is not needed, and is ignored.
    assert_eq!(
        validate_manifest(
            &manifest(&[
                (1, "level=\"project\" reason=\"Stays.\""),
                (2, "level=\"project\"")
            ]),
            &ids
        )
        .unwrap()[0]
            .workspace,
        None
    );
    let refused = [
        (
            "no manifest at all".to_owned(),
            "missing complete root element",
        ),
        (
            "<place>\n<memory id=\"1\" level=\"project\"/>".to_owned(),
            "missing closing root tag",
        ),
        ("[{\"id\": 1}]".to_owned(), "JSON array"),
        (manifest(&[(1, "level=\"project\"")]), "missing id 2"),
        (
            manifest(&[
                (1, "level=\"project\""),
                (2, "level=\"project\""),
                (3, "level=\"project\""),
            ]),
            "unknown id 3",
        ),
        (
            manifest(&[
                (1, "level=\"project\""),
                (1, "level=\"project\""),
                (2, "level=\"project\""),
            ]),
            "duplicate id 1",
        ),
        (
            manifest(&[(1, "level=\"global\""), (2, "level=\"project\"")]),
            "has level \"global\"",
        ),
        (
            manifest(&[(1, ""), (2, "level=\"project\"")]),
            "entry 1 missing level",
        ),
        (
            manifest(&[(1, "level=\"workspace\""), (2, "level=\"project\"")]),
            "entry 1 moves to the workspace without a reason",
        ),
        (
            manifest(&[
                (1, "level=\"workspace\" reason=\"  \""),
                (2, "level=\"project\""),
            ]),
            "entry 1 moves to the workspace without a reason",
        ),
        (
            "<place>\n<memory level=\"project\"/>\n</place>".to_owned(),
            "missing numeric id",
        ),
    ];
    for (text, expected) in refused {
        let error = validate_manifest(&text, &ids).unwrap_err();
        assert!(error.contains(expected), "{text:?}: {error}");
    }
}

#[test]
fn a_malformed_or_incomplete_manifest_applies_nothing() {
    let store = store(&[row(1), row(2)]);
    let (_, batches) = store.plan(&three());
    let before = (store.placed(1), store.placed(2));
    for text in [
        // Memory 1's move is well formed, but memory 2 is missing.
        manifest(&[(1, "level=\"workspace\" reason=\"Holds for every project.\"")]),
        manifest(&[
            (1, "level=\"workspace\" reason=\"Holds for every project.\""),
            (2, "level=\"everywhere\""),
        ]),
        "I would move memory 1.".to_owned(),
    ] {
        assert!(batches[0].accepts(&text).is_err(), "{text}");
        assert!(store.apply(&batches[0], &text, 7).is_err(), "{text}");
        assert_eq!((store.placed(1), store.placed(2)), before, "{text}");
    }
    let journal: i64 = store
        .db
        .with_connection(|conn| {
            conn.query_row("SELECT COUNT(*) FROM memory_journal", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(journal, 0);
}

#[test]
fn a_workspace_verdict_moves_the_row_with_history_and_undoing_the_run_puts_it_back() {
    let store = store(&[row(1), row(2)]);
    store.execute(
        "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         VALUES (1, 1, 0, 'hash', '{}')",
    );
    let (_, batches) = store.plan(&three());
    let text = manifest(&[
        (
            1,
            "level=\"workspace\" reason=\"Every project is released by the same pipeline.\"",
        ),
        (2, "level=\"project\""),
    ]);
    let applied = store.apply(&batches[0], &text, 7).unwrap();
    assert_eq!(
        applied,
        Applied {
            proposed: 1,
            applied: 1,
            dropped: vec![]
        }
    );
    // The same row and text, now the workspace's, with the project as its
    // source; memory 2 stays.
    assert_eq!(
        store.placed(1),
        (
            "workspace".into(),
            WORKSPACE.into(),
            Some(PROJECT.into()),
            2,
            "Rule 1.".into()
        )
    );
    assert_eq!(store.placed(2).0, "project");
    // The history row, the journal row and the clause evidence the move
    // carried to the new revision.
    type Recorded = (Vec<(i64, String, String)>, Vec<(String, String)>, i64);
    let (history, journal, evidence): Recorded = store.db.with_connection(|conn| {
        let history = conn
            .prepare("SELECT memory_id, reason, decision_key FROM memory_history ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let journal = conn
            .prepare("SELECT project_path, operation FROM memory_journal ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let evidence = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_clause_evidence WHERE memory_id = 1 AND revision = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        (history, journal, evidence)
    });
    assert_eq!(
        history,
        [(
            1,
            "Every project is released by the same pipeline.".into(),
            "dream-run:7:lift-workspace:0:1".into()
        )]
    );
    assert_eq!(journal, [(PROJECT.into(), OPERATION.into())]);
    assert_eq!(evidence, 1);

    // Undoing the run from the project's dreamer page brings it back.
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: PROJECT.into(),
    };
    let plan = store
        .db
        .with_connection(|conn| plan_run_undo(conn, &owner, 7))
        .unwrap();
    assert!(plan.left.is_empty(), "{:?}", plan.left);
    assert_eq!(plan.restore.len(), 1);
    store
        .db
        .with_connection(|conn| undo_run(conn, &owner, 7, &plan))
        .unwrap();
    assert_eq!(
        store.placed(1),
        (
            "project".into(),
            PROJECT.into(),
            Some(PROJECT.into()),
            3,
            "Rule 1.".into()
        )
    );
}

#[test]
fn undoing_the_run_leaves_a_moved_memory_that_moved_or_changed_again() {
    let store = store(&[row(1), row(2)]);
    let (_, batches) = store.plan(&three());
    let text = manifest(&[
        (1, "level=\"workspace\" reason=\"Holds for every project.\""),
        (2, "level=\"workspace\" reason=\"Holds for every project.\""),
    ]);
    assert_eq!(store.apply(&batches[0], &text, 7).unwrap().applied, 2);
    // Memory 1 was edited at the workspace after the run, and memory 2 was
    // moved to another workspace.
    store.execute(
        "UPDATE memories SET revision = revision + 1 WHERE id = 1;
         UPDATE memories SET owner_id = 'ws-other', revision = revision + 1 WHERE id = 2;",
    );
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: PROJECT.into(),
    };
    let plan = store
        .db
        .with_connection(|conn| plan_run_undo(conn, &owner, 7))
        .unwrap();
    assert!(plan.restore.is_empty());
    assert_eq!(
        plan.left,
        [
            (1, crate::memory_writes::person::LeftAlone::ChangedAfter),
            (2, crate::memory_writes::person::LeftAlone::Moved)
        ]
    );
}

#[test]
fn a_move_whose_text_the_workspace_already_holds_is_refused() {
    let store = store(&[
        row(1),
        row(2),
        // The workspace already holds memory 1's text in its category, in
        // other words and case.
        Row {
            level: "workspace",
            owner: WORKSPACE,
            content: "rule   1.".into(),
            ..row(3)
        },
    ]);
    let (_, batches) = store.plan(&three());
    let applied = store
        .apply(
            &batches[0],
            &manifest(&[
                (1, "level=\"workspace\" reason=\"Holds everywhere.\""),
                (2, "level=\"workspace\" reason=\"Holds everywhere.\""),
            ]),
            7,
        )
        .unwrap();
    assert_eq!(applied.proposed, 2);
    assert_eq!(applied.applied, 1);
    assert_eq!(
        applied.dropped,
        ["memory 1's text already exists at the workspace level as memory 3"]
    );
    assert_eq!(store.placed(1).0, "project");
    assert_eq!(store.placed(2).0, "workspace");
}

#[test]
fn a_memory_changed_after_the_batch_read_it_is_not_moved() {
    let store = store(&[row(1), row(2), row(3)]);
    let (_, batches) = store.plan(&three());
    // After the read: memory 1 is edited, memory 2 archived, and memory 3
    // filed under a category the workspace level doesn't allow.
    store.execute(
        "UPDATE memories SET content = 'Rule one.', revision = revision + 1 WHERE id = 1;
         UPDATE memories SET status = 'archived' WHERE id = 2;
         UPDATE memories SET category = 'mc:unmapped' WHERE id = 3;",
    );
    let applied = store
        .apply(
            &batches[0],
            &manifest(&[
                (1, "level=\"workspace\" reason=\"Holds everywhere.\""),
                (2, "level=\"workspace\" reason=\"Holds everywhere.\""),
                (3, "level=\"workspace\" reason=\"Holds everywhere.\""),
            ]),
            7,
        )
        .unwrap();
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        [
            "memory 1 changed after the batch read it (revision 1, now 2)",
            "memory 2 is no longer a live memory of the project",
            "memory 3 is filed under mc:unmapped, which the profile doesn't allow at the workspace level",
        ]
    );
    for id in 1..=3 {
        assert_eq!(store.placed(id).0, "project");
    }
}
