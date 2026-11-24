//! The docs-upkeep task: each gate, the request it renders, and how an
//! answer becomes a proposal and moves the watermark.

use serde_json::json;

use super::*;
use crate::context_db::ContextDb;
use crate::dreamer::checkout::tests::Repo;
use crate::dreamer::store;
use crate::memory_profile::prompt_profile;

pub(crate) const PROJECT: &str = "pj-docs";
pub(crate) const TASK: &str = "swe:maintain-docs";

pub(crate) const ARCHITECTURE: &str = "# Architecture\n\n## Core\nThe parser lives in src/parser.rs.\n\n## Guard\n<!-- mc:protected START hand-authored -->\nHand authored\n<!-- mc:protected END -->\n";
pub(crate) const STRUCTURE: &str = "# Structure\n\n## Layout\nsrc/ holds the code.\n";

/// A project whose main checkout is a git repository, and a store with the
/// task's schedule row.
pub(crate) struct Fixture {
    pub repo: Repo,
    _dir: tempfile::TempDir,
    pub db: ContextDb,
    task: MaintainDocs,
}

impl Fixture {
    /// A checkout whose first commit holds `files`.
    pub(crate) fn new(files: &[(&str, &str)]) -> Self {
        let repo = Repo::new(files);
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        db.with_connection(|conn| {
            store::ensure_schedule(conn, &OwnerKey::project(PROJECT), TASK, "30 5 * * *", 0)
                .unwrap()
        });
        Self {
            repo,
            _dir: dir,
            db,
            task: MaintainDocs::default(),
        }
    }

    /// Both documents and a parser.
    pub(crate) fn documented() -> Self {
        Self::new(&[
            ("ARCHITECTURE.md", ARCHITECTURE),
            ("STRUCTURE.md", STRUCTURE),
            ("src/parser.rs", "fn parse() {}\n"),
        ])
    }

    pub(crate) fn head(&self) -> String {
        self.repo.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    pub(crate) fn with_context<T>(&self, body: impl FnOnce(&TaskContext<'_>) -> T) -> T {
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
            root: self.repo.path().to_str().unwrap().to_owned(),
        };
        body(&TaskContext {
            db: &self.db,
            owner: &owner,
            profile: &profile,
            declaration: &declaration,
            workspace: None,
            guidance: None,
            branches: &[],
        })
    }

    pub(crate) fn plan(&self) -> Planned {
        self.with_context(|context| self.task.planned(context).unwrap())
    }

    /// The reason planning held the model back.
    pub(crate) fn skipped(&self) -> String {
        match self.plan() {
            Planned::Skip(reason) => reason,
            Planned::Batch(_) => panic!("the run was expected to stop before the model"),
        }
    }

    pub(crate) fn batch(&self) -> Box<DocsBatch> {
        match self.plan() {
            Planned::Batch(batch) => batch,
            Planned::Skip(reason) => panic!("the run stopped before the model: {reason}"),
        }
    }

    pub(crate) fn commit_recorded(&self) -> Option<String> {
        self.db
            .with_connection(|conn| stored_commit(conn, PROJECT, TASK))
            .unwrap()
    }

    pub(crate) fn record(&self, commit: &str) {
        self.db
            .with_connection(|conn| write_commit(conn, PROJECT, TASK, commit))
            .unwrap();
    }

    /// Apply `answer` to `batch` as the engine does: in one transaction,
    /// then what follows it.
    pub(crate) fn apply(&self, batch: &DocsBatch, answer: &Value) -> Applied {
        let applied = self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch
                .write(&tx, answer.as_array().unwrap(), Some(7), 1_700_000_000_000)
                .unwrap();
            tx.commit().unwrap();
            applied
        });
        batch.after_commit(&self.db);
        applied
    }

    pub(crate) fn proposal(&self, id: i64) -> proposals::Proposal {
        self.db
            .with_connection(|conn| proposals::by_id(conn, id))
            .unwrap()
            .unwrap()
    }

    pub(crate) fn pending(&self) -> Option<proposals::Proposal> {
        self.db
            .with_connection(|conn| proposals::pending_of(conn, PROJECT))
            .unwrap()
    }
}

/// A replacement of the parser sentence, as the model answers it.
pub(crate) fn replacement() -> Value {
    json!([{
        "file": "ARCHITECTURE.md",
        "action": "replace",
        "heading": "## Core",
        "text": "## Core\nThe parser lives in src/parse/ now.",
        "reason": "src/parser.rs moved to src/parse/.",
    }])
}

/// A change the documents name, recorded from the first commit.
pub(crate) fn changed(fixture: &Fixture) {
    fixture.record(&fixture.head());
    fixture
        .repo
        .write(&[("src/parser.rs", "fn parse() { todo!() }\n")]);
    fixture.repo.commit("parser");
}

// --- The gates ---

#[test]
fn the_schedule_is_daily_at_half_past_five() {
    assert_eq!(crate::dreamer::engine::default_schedule(KIND), "30 5 * * *");
}

#[test]
fn a_checkout_without_either_document_is_not_read() {
    let fixture = Fixture::new(&[("src/a.rs", "a\n")]);
    assert!(fixture
        .skipped()
        .starts_with("neither ARCHITECTURE.md nor STRUCTURE.md exists"));
    assert_eq!(fixture.commit_recorded(), None);
}

#[test]
fn a_document_with_uncommitted_changes_is_not_read() {
    let fixture = Fixture::documented();
    fixture.record(&fixture.head());
    fixture
        .repo
        .write(&[("STRUCTURE.md", "# Structure\n\nBeing edited.\n")]);
    assert_eq!(
        fixture.skipped(),
        "STRUCTURE.md has uncommitted changes; someone is editing it"
    );
    // A new document not yet committed counts as being edited too.
    let fixture = Fixture::new(&[("ARCHITECTURE.md", ARCHITECTURE)]);
    fixture.record(&fixture.head());
    fixture.repo.write(&[("STRUCTURE.md", STRUCTURE)]);
    assert!(fixture
        .skipped()
        .starts_with("STRUCTURE.md has uncommitted"));
}

#[test]
fn the_first_run_records_the_current_commit_and_reads_nothing() {
    let fixture = Fixture::documented();
    let head = fixture.head();
    assert_eq!(
        fixture.skipped(),
        format!(
            "first run: recorded commit {}; the task reads the changes made after it",
            short(&head)
        )
    );
    assert_eq!(fixture.commit_recorded(), Some(head.clone()));
    assert_eq!(
        fixture.skipped(),
        format!("no change since {}", short(&head))
    );
}

#[test]
fn a_change_that_needs_no_reading_moves_the_watermark_without_a_model() {
    let fixture = Fixture::documented();
    // A folder the documents don't name.
    fixture.repo.write(&[("tools/a.rs", "a\n")]);
    let first = fixture.repo.commit("tools");
    fixture.record(&first);
    // Only the documents.
    fixture
        .repo
        .write(&[("STRUCTURE.md", "# Structure\n\n## Layout\nsrc/ holds it.\n")]);
    let docs = fixture.repo.commit("docs");
    assert!(fixture
        .skipped()
        .starts_with("no file other than the documents changed"));
    assert_eq!(fixture.commit_recorded(), Some(docs.clone()));
    // Only tests and lock files.
    fixture
        .repo
        .write(&[("src/parser.test.rs", "t\n"), ("Cargo.lock", "l\n")]);
    let tests = fixture.repo.commit("tests");
    assert!(fixture
        .skipped()
        .starts_with("no file other than the documents, tests, specs and lock files"));
    assert_eq!(fixture.commit_recorded(), Some(tests.clone()));
    // Nothing the documents name, in an area that existed.
    fixture.repo.write(&[("tools/b.rs", "b\n")]);
    let other = fixture.repo.commit("other");
    assert!(fixture
        .skipped()
        .starts_with("no file the documents name, and no new area, changed"));
    assert_eq!(fixture.commit_recorded(), Some(other));
}

#[test]
fn a_pending_proposal_based_on_the_current_commit_holds_the_run_back() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    fixture.apply(&batch, &replacement());
    let id = fixture.pending().unwrap().id;
    // A watermark lost after the proposal was stored still finds it.
    fixture.record(fixture.repo.git(&["rev-parse", "HEAD~1"]).trim());
    let recorded = fixture.commit_recorded();
    assert_eq!(
        fixture.skipped(),
        format!(
            "pending proposal {id} already covers commit {}",
            short(&fixture.head())
        )
    );
    assert_eq!(
        fixture.commit_recorded(),
        recorded,
        "the gate moves nothing"
    );
}

#[test]
fn a_recorded_commit_gone_from_the_repository_starts_over_from_the_current_one() {
    let fixture = Fixture::documented();
    fixture.record(&"1".repeat(40));
    assert!(fixture.skipped().starts_with(&format!(
        "the recorded commit {} is no longer in the repository",
        short(&"1".repeat(40))
    )));
    assert_eq!(fixture.commit_recorded(), Some(fixture.head()));
}

#[test]
fn the_engine_records_why_a_run_sent_nothing() {
    let fixture = Fixture::documented();
    let batches = fixture.with_context(|context| fixture.task.batches(context).unwrap());
    assert!(batches.is_empty());
    let owner = Owner::Project {
        id: PROJECT.into(),
        root: String::new(),
    };
    assert!(fixture
        .task
        .skip_reason(&owner)
        .unwrap()
        .starts_with("first run:"));
    assert_eq!(fixture.task.skip_reason(&owner), None, "taking clears it");
}

// --- The request ---

#[test]
fn the_request_fills_the_frames_byte_for_byte() {
    let fixture = Fixture::new(&[
        ("ARCHITECTURE.md", ARCHITECTURE),
        ("src/parser.rs", "fn parse() {}\n"),
    ]);
    changed(&fixture);
    let batch = fixture.batch();
    // The system prompt is the profile's, with the answer frame in it.
    assert_eq!(
        batch.system(),
        include_str!("../../../testdata/memory_profile/today/dreamer/maintain-docs.system.md")
    );
    // The message: the frame's lines, filled. A document that exists shows
    // its text; one that doesn't, the frame's missing form.
    let frame: Vec<&str> = include_str!("../../../frames/dreamer/maintain-docs.input.md")
        .lines()
        .collect();
    let change_set::Outcome::Changes(changes) = change_set::build(
        fixture.repo.path(),
        &change_set::Range {
            base: fixture.repo.git(&["rev-parse", "HEAD~1"]).trim().to_owned(),
            head: fixture.head(),
        },
        ARCHITECTURE,
    )
    .unwrap() else {
        panic!("the change is read");
    };
    let input = [
        frame[0]
            .replace("⟦docs.tokens⟧", &count(ARCHITECTURE).to_string())
            .replace("⟦docs.budget⟧", "12000"),
        frame[1].to_owned(),
        frame[2].to_owned(),
        frame[3].replace("⟦changes.text⟧", &changes),
        frame[4].to_owned(),
        frame[5].to_owned(),
        frame[6].replace("⟦document.name⟧", "ARCHITECTURE.md"),
        frame[7].replace("⟦document.text⟧", ARCHITECTURE.trim_end_matches('\n')),
        frame[8].to_owned(),
        frame[9].replace("⟦document.name⟧", "STRUCTURE.md"),
    ]
    .join("\n");
    assert_eq!(frame.len(), 10, "the frame's shape this test reads");
    let user = include_str!("../../../profiles/memory-swe/prompts/dreamer/maintain-docs/user.md")
        .trim_end_matches('\n')
        .replace("⟦projectIdentity⟧", PROJECT)
        .replace("⟦mc:maintain-docs.input⟧", &input);
    assert_eq!(batch.message(), user);
    assert!(changes.contains("src/parser.rs"));
    assert_eq!(batch.folder(), fixture.repo.path().to_str());
}

#[test]
fn the_child_reads_the_main_checkout_not_the_worktree_the_session_was_in() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let (_guard, worktree) = fixture.repo.worktree("side");
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
        root: worktree.to_str().unwrap().to_owned(),
    };
    let context = TaskContext {
        db: &fixture.db,
        owner: &owner,
        profile: &profile,
        declaration: &declaration,
        workspace: None,
        guidance: None,
        branches: &[],
    };
    let Planned::Batch(batch) = fixture.task.planned(&context).unwrap() else {
        panic!("the change is read");
    };
    let main = std::fs::canonicalize(fixture.repo.path()).unwrap();
    assert_eq!(
        std::fs::canonicalize(batch.folder().unwrap()).unwrap(),
        main
    );
}

#[test]
fn the_run_reads_with_the_reader_tools_for_at_most_sixty_steps() {
    let demand = crate::routing::DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .unwrap();
    assert!(demand.reads_code);
    assert_eq!(demand.max_steps, 60);
}

// --- Applying an answer ---

#[test]
fn an_answer_becomes_the_pending_proposal_and_moves_the_watermark() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let head = fixture.head();
    let batch = fixture.batch();
    let mut answer = replacement();
    answer.as_array_mut().unwrap().push(json!({
        "file": "ARCHITECTURE.md",
        "action": "remove",
        "heading": "## Guard",
        "text": "",
        "reason": "Gone.",
    }));
    let applied = fixture.apply(&batch, &answer);
    assert_eq!((applied.proposed, applied.applied), (2, 1));
    assert_eq!(
        applied.dropped,
        ["ARCHITECTURE.md remove ## Guard: the removed section holds a protected region"]
    );
    assert_eq!(fixture.commit_recorded(), Some(head.clone()));
    let proposal = fixture.pending().unwrap();
    assert_eq!(proposal.base_commit, head);
    assert_eq!(proposal.run_id, Some(7));
    assert_eq!(proposal.changes.len(), 1);
    assert_eq!(proposal.dropped.len(), 1);
    let result = ARCHITECTURE.replace(
        "The parser lives in src/parser.rs.",
        "The parser lives in src/parse/ now.",
    );
    assert_eq!(
        proposal.base,
        [
            Some(proposals::sha256(ARCHITECTURE.as_bytes())),
            Some(proposals::sha256(STRUCTURE.as_bytes()))
        ]
    );
    assert_eq!(
        proposal.result,
        [
            Some(proposals::sha256(result.as_bytes())),
            Some(proposals::sha256(STRUCTURE.as_bytes()))
        ]
    );
    // The body: the proposal as the app read shows it, with the project and
    // the markdown copy's path.
    let body: Value = serde_json::from_str(&proposal.body).unwrap();
    assert_eq!(body["id"], proposal.id);
    assert_eq!(body["project_id"], PROJECT);
    assert_eq!(body["status"], "pending");
    assert_eq!(
        body["file"],
        format!(
            ".cortexkit/magic-context/docs-update-proposals/{}.md",
            proposal.id
        )
    );
    let documents = body["documents"].as_array().unwrap();
    assert_eq!(documents.len(), 1, "only the changed document");
    assert_eq!(documents[0]["name"], "ARCHITECTURE.md");
    let diff = documents[0]["diff"].as_str().unwrap();
    assert!(
        diff.contains("--- a/ARCHITECTURE.md\n+++ b/ARCHITECTURE.md\n"),
        "{diff}"
    );
    assert!(diff
        .contains("-The parser lives in src/parser.rs.\n+The parser lives in src/parse/ now.\n"));
    assert_eq!(
        documents[0]["changes"],
        json!([{"action": "replace", "heading": "## Core", "reason": "src/parser.rs moved to src/parse/."}])
    );
    assert_eq!(
        body["dropped"][0]["reason"],
        "the removed section holds a protected region"
    );
    // The markdown copy: the diff, then the whole new section and its reason.
    let copy =
        std::fs::read_to_string(proposals::file::path(fixture.repo.path(), proposal.id)).unwrap();
    assert!(copy.starts_with(&format!("# Docs update proposal {}\n", proposal.id)));
    assert!(copy.contains(&format!("Base commit: {head}\n")));
    assert!(copy.contains("\n## ARCHITECTURE.md\n\n```diff\n"));
    assert!(copy.contains(
        "### replace ## Core\n\nReason: src/parser.rs moved to src/parse/.\n\n```markdown\n## Core\nThe parser lives in src/parse/ now.\n```\n"
    ));
    // The documents themselves are untouched.
    assert_eq!(
        std::fs::read_to_string(fixture.repo.path().join("ARCHITECTURE.md")).unwrap(),
        ARCHITECTURE
    );
}

#[test]
fn an_empty_answer_moves_the_watermark_and_proposes_nothing() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    let applied = fixture.apply(&batch, &json!([]));
    assert_eq!(applied, Applied::default());
    assert_eq!(fixture.commit_recorded(), Some(fixture.head()));
    assert_eq!(fixture.pending(), None);
}

#[test]
fn an_answer_whose_changes_all_fail_proposes_nothing_and_moves_the_watermark() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    let applied = fixture.apply(
        &batch,
        &json!([{"file": "README.md", "action": "add", "heading": "## X", "text": "## X\ny", "reason": "r"}]),
    );
    assert_eq!(
        (applied.proposed, applied.applied, applied.dropped.len()),
        (1, 0, 1)
    );
    assert_eq!(fixture.pending(), None);
    assert_eq!(fixture.commit_recorded(), Some(fixture.head()));
}

#[test]
fn documents_that_changed_while_the_run_read_them_propose_nothing_and_keep_the_watermark() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let recorded = fixture.commit_recorded();
    let batch = fixture.batch();
    fixture
        .repo
        .write(&[("ARCHITECTURE.md", "# Architecture\n\nRewritten by hand.\n")]);
    let applied = fixture.apply(&batch, &replacement());
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        ["the documents changed while the run read them; nothing is proposed"]
    );
    assert_eq!(fixture.pending(), None);
    assert_eq!(fixture.commit_recorded(), recorded);
}

#[test]
fn a_new_edit_to_the_same_section_replaces_the_pending_edit() {
    let fixture = Fixture::documented();
    changed(&fixture);
    let first = fixture.batch();
    fixture.apply(&first, &replacement());
    let earlier = fixture.pending().unwrap();
    let earlier_copy = proposals::file::path(fixture.repo.path(), earlier.id);
    assert!(earlier_copy.exists());
    // A later commit, read as a new run.
    fixture
        .repo
        .write(&[("src/parser.rs", "fn parse() { 2 }\n")]);
    fixture.repo.commit("again");
    let second = fixture.batch();
    let mut newer = replacement();
    newer[0]["text"] = json!("## Core\nThe parser was rewritten.");
    let applied = fixture.apply(&second, &newer);
    let later = fixture.pending().unwrap();
    assert_ne!(later.id, earlier.id);
    assert_eq!(fixture.proposal(earlier.id).status, "stale");
    assert!(!earlier_copy.exists());
    assert!(proposals::file::path(fixture.repo.path(), later.id).exists());
    assert_eq!(later.changes.len(), 1);
    assert_eq!(later.changes[0].text, "## Core\nThe parser was rewritten.");
    assert!(applied
        .dropped
        .iter()
        .any(|reason| reason.contains("pending proposal") && reason.contains("## Core")));
}

#[test]
fn a_new_proposal_keeps_unrelated_unapplied_changes() {
    let fixture = Fixture::documented();
    changed(&fixture);
    fixture.apply(&fixture.batch(), &replacement());
    let earlier = fixture.pending().unwrap();

    fixture
        .repo
        .write(&[("src/parser.rs", "fn parse() { 2 }\n")]);
    fixture.repo.commit("change code a second time");
    let applied = fixture.apply(
        &fixture.batch(),
        &json!([{
            "file": "STRUCTURE.md",
            "action": "replace",
            "heading": "## Layout",
            "text": "## Layout\nThe parser module now handles output too.",
            "reason": "The output implementation moved."
        }]),
    );
    assert!(applied.dropped.is_empty(), "{applied:?}");
    let later = fixture.pending().unwrap();
    assert_ne!(later.id, earlier.id);
    assert_eq!(later.base_commit, fixture.head());
    assert_eq!(later.changes.len(), 2);
    assert!(later.changes.contains(&earlier.changes[0]));
    assert!(later
        .changes
        .iter()
        .any(|change| change.heading == "## Layout"));
    assert!(later
        .result
        .iter()
        .zip(later.base.iter())
        .all(|(result, base)| result != base));
}

// --- A proposal's status on read ---

#[test]
fn reading_a_proposal_finds_it_applied_stale_or_still_pending() {
    // Applied: both documents now have the result hashes.
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    fixture.apply(&batch, &replacement());
    let id = fixture.pending().unwrap().id;
    let still = proposals::refresh_pending(&fixture.db, PROJECT)
        .unwrap()
        .unwrap();
    assert_eq!(still.status, "pending");
    fixture.repo.write(&[(
        "ARCHITECTURE.md",
        &ARCHITECTURE.replace(
            "The parser lives in src/parser.rs.",
            "The parser lives in src/parse/ now.",
        ),
    )]);
    let read = proposals::refresh_pending(&fixture.db, PROJECT)
        .unwrap()
        .unwrap();
    assert_eq!((read.id, read.status.as_str()), (id, "applied"));
    assert_eq!(fixture.proposal(id).status, "applied");
    assert!(!proposals::file::path(fixture.repo.path(), id).exists());
    assert_eq!(
        proposals::refresh_pending(&fixture.db, PROJECT).unwrap(),
        None
    );

    // Stale: the documents changed some other way.
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    fixture.apply(&batch, &replacement());
    let id = fixture.pending().unwrap().id;
    fixture
        .repo
        .write(&[("STRUCTURE.md", "# Structure\n\nSomething else.\n")]);
    let read = proposals::refresh_id(&fixture.db, id).unwrap().unwrap();
    assert_eq!(read.status, "stale");
    assert_eq!(fixture.proposal(id).status, "stale");
}
