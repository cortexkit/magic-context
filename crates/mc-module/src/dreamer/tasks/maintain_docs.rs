//! The `maintain-docs` task: keep a project's `ARCHITECTURE.md` and
//! `STRUCTURE.md` true to its code.
//!
//! Every session of a project reads both documents at the start of its head,
//! so a stale sentence misleads every agent. Once a day the task reads what
//! changed in the code since the commit it last processed (its watermark,
//! `{"commit": <sha>}`), and one child reads the code with the read-only
//! reader tools and answers a list of section changes. The task never writes
//! either document: the changes that pass their checks ([`edits`]) become a
//! proposal ([`crate::docs_proposals`]) that a person or the project's head
//! agent applies.
//!
//! It reads the repository's main checkout at its current commit, never a
//! worktree a session ran in, so the documents and the code come from one
//! tree. A run ends without a model call, recording why, when:
//!
//! - neither document exists, or one has uncommitted changes (someone is
//!   editing it);
//! - it is the first run: it records the current commit, so the task reads
//!   changes made after it was switched on, not the whole history;
//! - a pending proposal is already based on the current commit;
//! - the change since the recorded commit touches no file but the documents,
//!   only tests, specs and lock files besides them, or nothing the documents
//!   name or a new area ([`change_set`]). These three record the current
//!   commit as processed, as there is nothing to read in the change.
//!
//! When the recorded commit isn't an ancestor of the current one (the
//! checkout moved to another branch), the change is taken from their merge
//! base. The watermark moves to the commit a run read only once its answer
//! is applied, an empty answer included.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, Transaction};
use serde_json::{json, Value};

use crate::context_db::ContextDb;
use crate::count::Counter;
use crate::docs_proposals::{self as proposals, DocumentResult, NewProposal, DOCUMENTS};
use crate::dreamer::branches::{main_checkout, short};
use crate::dreamer::checkout::{run_git_output, run_git_within, GIT_TIMEOUT};
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::store::OwnerKey;
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_profile::FRAMES;
use crate::memory_writes::now_ms;
use crate::summary::fit::Window;

pub(crate) mod change_set;
pub(crate) mod edits;
pub(crate) mod protected;

/// The task kind, as a memory profile's task declaration names it.
pub(crate) const KIND: &str = "maintain-docs";
/// Magic Context's frame the task's message fills.
pub(crate) const INPUT_FRAME: &str = "dreamer/maintain-docs.input";
/// The action a task declaration names proposing a change by.
const ACTION: &str = "propose-doc-change";
/// The documents' budget together, in the module's tokens.
pub(crate) const BUDGET: u64 = crate::project_docs::DOCS_BUDGET_TOKENS;

/// The two documents' text, in [`DOCUMENTS`] order; `None` for one that
/// doesn't exist.
pub(crate) type Texts = [Option<String>; 2];

/// The tokens of `text` by the module's own counter.
pub(crate) fn count(text: &str) -> u64 {
    Counter::for_model(None).count(text)
}

/// Read both documents at the top of `checkout`. A document that is there
/// but isn't a regular UTF-8 file (a link, a folder, binary) is refused: the
/// task can't propose edits to it.
pub(crate) fn read_documents(checkout: &Path) -> Result<Texts, String> {
    let read = |name: &str| -> Result<Option<String>, String> {
        let path = checkout.join(name);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{name}: {error}")),
            Ok(meta) if !meta.is_file() => Err(format!("{name} is not a regular file")),
            Ok(_) => std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|error| format!("{name}: {error}")),
        }
    };
    Ok([read(DOCUMENTS[0])?, read(DOCUMENTS[1])?])
}

/// The commit the task's watermark names: the last one a run processed.
pub(crate) fn stored_commit(
    conn: &Connection,
    project: &str,
    task: &str,
) -> rusqlite::Result<Option<String>> {
    Ok(
        crate::dreamer::store::schedule_of(conn, &OwnerKey::project(project), task)?
            .and_then(|schedule| schedule.watermark)
            .and_then(|watermark| watermark["commit"].as_str().map(str::to_owned)),
    )
}

/// Move the task's watermark to `commit`.
pub(crate) fn write_commit(
    conn: &Connection,
    project: &str,
    task: &str,
    commit: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dream_schedules SET watermark_json = ?4
          WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
        params![
            "project",
            project,
            task,
            json!({ "commit": commit }).to_string()
        ],
    )
    .map(drop)
}

/// The frame's three parts: what comes before the documents, a document
/// that exists, and one that doesn't.
fn frame_parts() -> (&'static str, &'static str, &'static str) {
    let (_, text) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .expect("the maintain-docs input frame is bundled");
    let text = text.strip_suffix('\n').unwrap_or(text);
    let missing_at = text
        .find("<document name=\"⟦document.name⟧\" missing=\"yes\">")
        .expect("the frame shows a missing document");
    let present_at = text
        .find("<document name=\"⟦document.name⟧\">")
        .expect("the frame shows a document");
    (
        &text[..present_at],
        text[present_at..missing_at].trim_end_matches('\n'),
        &text[missing_at..],
    )
}

/// The text that fills the task's input frame, in the frame's own layout:
/// the documents' tokens and budget, the code changes, then each document,
/// or its missing form. The values go in after the frame's own markers are
/// filled, so a document that quotes a marker is shown as written.
pub(crate) fn input(tokens: u64, budget: u64, changes: &str, documents: &Texts) -> String {
    let (head, present, missing) = frame_parts();
    let mut text = head
        .replace("⟦docs.tokens⟧", &tokens.to_string())
        .replace("⟦docs.budget⟧", &budget.to_string())
        .replace("⟦changes.text⟧", changes);
    let shown: Vec<String> = DOCUMENTS
        .iter()
        .zip(documents)
        .map(|(name, document)| match document {
            Some(document) => present.replace("⟦document.name⟧", name).replace(
                "⟦document.text⟧",
                document.strip_suffix('\n').unwrap_or(document),
            ),
            None => missing.replace("⟦document.name⟧", name),
        })
        .collect();
    text.push_str(&shown.join("\n"));
    text
}

/// What planning a run decided.
pub(crate) enum Planned {
    /// No model call, and why.
    Skip(String),
    Batch(Box<DocsBatch>),
}

/// The task kind. It keeps why each project's last planning sent nothing
/// until the engine records it ([`Task::skip_reason`]): one owner runs one
/// task at a time, so a project's entry is its own run's.
#[derive(Default)]
pub(crate) struct MaintainDocs {
    skipped: Mutex<HashMap<String, String>>,
}

impl MaintainDocs {
    /// Plan one run for the context's project.
    pub(crate) fn planned(&self, context: &TaskContext<'_>) -> Result<Planned, String> {
        let Owner::Project { id: project, root } = context.owner else {
            return Err(format!("{KIND} works on a project's documents only"));
        };
        let task = context.task_id().to_owned();
        let checkout = main_checkout(Path::new(root))?;
        let git = |args: &[&str]| -> Result<String, String> {
            run_git_within(&checkout, args, GIT_TIMEOUT).map(|out| out.trim().to_owned())
        };
        let Ok(head) = git(&["rev-parse", "--verify", "HEAD^{commit}"]) else {
            return Ok(Planned::Skip(format!(
                "the main checkout {} has no commit",
                checkout.display()
            )));
        };
        let documents = read_documents(&checkout)?;
        if documents.iter().all(Option::is_none) {
            return Ok(Planned::Skip(format!(
                "neither ARCHITECTURE.md nor STRUCTURE.md exists in {}",
                checkout.display()
            )));
        }
        let mut status_args = vec![
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
        ];
        status_args.extend(DOCUMENTS);
        let edited: Vec<&str> = {
            // Not trimmed: a status line starts with a space when only the
            // working tree changed.
            let listed = run_git_within(&checkout, &status_args, GIT_TIMEOUT)?;
            DOCUMENTS
                .into_iter()
                .filter(|name| {
                    listed
                        .split('\0')
                        .filter_map(|entry| entry.get(3..))
                        .any(|path| path == *name)
                })
                .collect()
        };
        if !edited.is_empty() {
            return Ok(Planned::Skip(format!(
                "{} {} uncommitted changes; someone is editing {}",
                edited.join(" and "),
                if edited.len() == 1 { "has" } else { "have" },
                if edited.len() == 1 { "it" } else { "them" }
            )));
        }
        let db = context.db;
        let record = |commit: &str| -> Result<(), String> {
            db.with_connection(|conn| write_commit(conn, project, &task, commit))
                .map_err(|error| format!("recording {task}'s commit: {error}"))
        };
        let recorded = db
            .with_connection(|conn| stored_commit(conn, project, &task))
            .map_err(|error| format!("reading {task}'s commit: {error}"))?;
        let Some(recorded) = recorded else {
            record(&head)?;
            return Ok(Planned::Skip(format!(
                "first run: recorded commit {}; the task reads the changes made after it",
                short(&head)
            )));
        };
        if !change_set::is_commit(&checkout, &recorded) {
            record(&head)?;
            return Ok(Planned::Skip(format!(
                "the recorded commit {} is no longer in the repository; recorded {} to start again",
                short(&recorded),
                short(&head)
            )));
        }
        let pending = proposals::refresh_pending(db, project)
            .map_err(|error| format!("reading {project}'s docs proposal: {error}"))?
            .filter(|proposal| proposal.status == proposals::PENDING);
        if let Some(pending) = pending.filter(|pending| pending.base_commit == head) {
            return Ok(Planned::Skip(format!(
                "pending proposal {} already covers commit {}",
                pending.id,
                short(&head)
            )));
        }
        let Some(range) = change_set::range(&checkout, &recorded, &head)? else {
            record(&head)?;
            return Ok(Planned::Skip(format!(
                "the recorded commit {} shares no history with {}; recorded {} to start again",
                short(&recorded),
                short(&head),
                short(&head)
            )));
        };
        if range.base == head {
            return Ok(Planned::Skip(format!(
                "no change since {}",
                short(&recorded)
            )));
        }
        let joined = documents
            .iter()
            .map(|document| document.as_deref().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let changes = match change_set::build(&checkout, &range, &joined)? {
            change_set::Outcome::Changes(text) => text,
            outcome => {
                let why = match outcome {
                    change_set::Outcome::DocumentsOnly => "no file other than the documents",
                    change_set::Outcome::Filtered => {
                        "no file other than the documents, tests, specs and lock files"
                    }
                    _ => "no file the documents name, and no new area,",
                };
                record(&head)?;
                return Ok(Planned::Skip(format!(
                    "{why} changed between {} and {}",
                    short(&range.base),
                    short(&head)
                )));
            }
        };
        let tokens: u64 = documents.iter().flatten().map(|text| count(text)).sum();
        let text = input(tokens, BUDGET, &changes, &documents);
        let (system, message) = task_prompts(
            context.profile,
            context.task_id(),
            "user",
            &[(INPUT_FRAME, text.as_str())],
            &[("projectIdentity", project.as_str())],
        )?;
        let allowed = context.declaration["actions"]
            .as_array()
            .is_some_and(|actions| actions.iter().any(|action| action == ACTION));
        Ok(Planned::Batch(Box::new(DocsBatch {
            project: project.clone(),
            task,
            checkout,
            head,
            documents,
            system,
            message,
            allowed,
            made: Mutex::new(None),
        })))
    }
}

impl Task for MaintainDocs {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        let key = match context.owner {
            Owner::Project { id, .. } => id.clone(),
            _ => String::new(),
        };
        match self.planned(context)? {
            Planned::Batch(batch) => Ok(vec![batch as Box<dyn Batch>]),
            Planned::Skip(reason) => {
                tracing::info!("ck-mc: dreamer: {KIND} for {key}: {reason}");
                self.skipped
                    .lock()
                    .expect("skip reasons")
                    .insert(key, reason);
                Ok(Vec::new())
            }
        }
    }

    fn skip_reason(&self, owner: &Owner) -> Option<String> {
        let Owner::Project { id, .. } = owner else {
            return None;
        };
        self.skipped.lock().expect("skip reasons").remove(id)
    }
}

/// A proposal a batch stored, for what follows its transaction.
struct Made {
    id: i64,
    proposal: NewProposal,
    replaced: Vec<(i64, String)>,
    tokens: u64,
}

/// The run's one message, and how its answer becomes a proposal.
pub(crate) struct DocsBatch {
    project: String,
    task: String,
    /// The main checkout the run reads.
    checkout: PathBuf,
    /// The commit the run reads, where the watermark moves once it applies.
    head: String,
    /// The documents as the run read them.
    documents: Texts,
    system: String,
    message: String,
    /// Whether the task's declaration allows proposing a change.
    allowed: bool,
    made: Mutex<Option<Made>>,
}

impl DocsBatch {
    /// The message the batch sends.
    #[cfg(test)]
    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    /// Check `answer` and store what passes as the project's pending
    /// proposal, then move the watermark, inside `tx`. A run whose documents
    /// changed since it read them proposes nothing and keeps the watermark.
    pub(crate) fn write(
        &self,
        tx: &Transaction<'_>,
        answer: &[Value],
        run: Option<i64>,
        now: i64,
    ) -> Result<Applied, String> {
        let mut applied = Applied {
            proposed: answer.len(),
            ..Applied::default()
        };
        let now_documents = read_documents(&self.checkout)?;
        if now_documents != self.documents {
            applied
                .dropped
                .push("the documents changed while the run read them; nothing is proposed".into());
            return Ok(applied);
        }
        if !self.allowed && !answer.is_empty() {
            applied
                .dropped
                .push(format!("the task's declaration does not allow {ACTION}"));
        } else {
            let pending = proposals::pending_of(tx, &self.project)
                .map_err(|error| format!("reading the pending docs proposal: {error}"))?;
            let carried = pending
                .as_ref()
                .map_or(&[][..], |proposal| proposal.changes.as_slice());
            let checked =
                edits::check_with_pending(answer, carried, &self.documents, BUDGET, &count);
            applied.dropped = checked
                .dropped
                .iter()
                .map(|change| {
                    format!(
                        "{} {} {}: {}",
                        change.file, change.action, change.heading, change.reason
                    )
                })
                .collect();
            if !checked.kept.is_empty() && checked.kept != carried {
                let documents = DOCUMENTS
                    .into_iter()
                    .zip(self.documents.iter().zip(&checked.results))
                    .map(|(name, (base, result))| -> Result<DocumentResult, String> {
                        let diff = if base == result {
                            String::new()
                        } else {
                            unified_diff(name, base.as_deref(), result.as_deref())?
                        };
                        Ok(DocumentResult {
                            name,
                            base: base.clone(),
                            result: result.clone(),
                            diff,
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let proposal = NewProposal {
                    project: self.project.clone(),
                    run_id: run,
                    checkout: self.checkout.to_string_lossy().into_owned(),
                    base_commit: self.head.clone(),
                    created_at: now,
                    documents,
                    changes: checked.kept.clone(),
                    dropped: checked.dropped.clone(),
                };
                let stored = proposals::insert(tx, &proposal)
                    .map_err(|error| format!("storing the docs proposal: {error}"))?;
                applied.applied = checked.kept.len();
                *self.made.lock().expect("made proposal") = Some(Made {
                    id: stored.id,
                    proposal,
                    replaced: stored.replaced,
                    tokens: checked.tokens_after,
                });
            }
        }
        write_commit(tx, &self.project, &self.task, &self.head)
            .map_err(|error| format!("moving {}'s commit: {error}", self.task))?;
        Ok(applied)
    }
}

impl TaskInput for DocsBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        edits::parse_answer(reply).map(drop)
    }
}

impl Batch for DocsBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let answer = edits::parse_answer(&reply.text)?;
        self.write(tx, &answer, Some(run), now_ms())
    }

    fn folder(&self) -> Option<&str> {
        self.checkout.to_str()
    }

    fn changes_memories(&self) -> bool {
        false
    }

    /// Once the proposal is stored: write its markdown copy, remove the
    /// copies of the proposals it replaced, and tell the dreamer page.
    fn after_commit(&self, db: &ContextDb) {
        let Some(made) = self.made.lock().expect("made proposal").take() else {
            return;
        };
        proposals::file::write_logged(made.id, &made.proposal, made.tokens, BUDGET);
        proposals::ended(db, &self.project, &made.replaced);
    }
}

/// The unified diff of document `name` from `before` to `after` (each
/// `None` when the document doesn't exist), as git writes one.
pub(crate) fn unified_diff(
    name: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<String, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mc-docs-diff-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let result = (|| -> Result<String, String> {
        for (side, text) in [("a", before), ("b", after)] {
            std::fs::create_dir_all(dir.join(side)).map_err(|error| error.to_string())?;
            std::fs::write(dir.join(side).join(name), text.unwrap_or_default())
                .map_err(|error| error.to_string())?;
        }
        let a = format!("a/{name}");
        let b = format!("b/{name}");
        let output = run_git_output(
            &dir,
            &[
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--no-prefix",
                "--",
                &a,
                &b,
            ],
            GIT_TIMEOUT,
        )?;
        match output.code {
            Some(0) | Some(1) => Ok(output.stdout),
            _ => Err(output.stderr.trim().chars().take(500).collect()),
        }
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result.map_err(|error| format!("diffing {name}: {error}"))
}

#[cfg(test)]
#[path = "maintain_docs_tests.rs"]
pub(crate) mod tests;
