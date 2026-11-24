//! What one dreamer task kind implements, and how its prompts come from the
//! memory profile.
//!
//! A task kind reads the store for one owner and splits its work into
//! batches. Each batch is one message to a model ([`super::run`]); when its
//! reply is accepted, the batch checks what the reply proposes and writes
//! what passes, in one transaction that names the run in every history row.
//!
//! The prompts are the profile's documents `dreamer/<task id>/system` and
//! `dreamer/<task id>/<user document>`. The profile owns their wording;
//! Magic Context owns the frames they splice in (`⟦mc:…⟧`), and a task fills
//! its input frame with the rows it read, so the input's shape stays the
//! module's while its guidance is the profile's.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::run::{TaskInput, TaskReply};
use crate::context_db::ContextDb;
use crate::embedding::Provider;
use crate::memory_profile::{render, Profile, FRAMES};
use crate::workspace_members::WorkspaceMembers;

/// A run's batches, once planning them (which may wait on the network) ends.
pub(crate) type Planning<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<Box<dyn Batch>>, String>> + Send + 'a>>;
/// Whose memories a run reads and may change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    /// A project's memories; `root` is its folder, where the run's child
    /// session works.
    Project { id: String, root: String },
    /// The person's own memories, at the global level, and the summarizer's
    /// observations about them. One owner per machine, not per project.
    Global,
    /// The memories a workspace shares, shown in every session of every
    /// project in it; `id` is Entorhinal's id for the workspace.
    Workspace { id: String },
}

/// What a task kind reads its work from.
pub(crate) struct TaskContext<'a> {
    pub db: &'a ContextDb,
    pub owner: &'a Owner,
    pub profile: &'a Profile,
    /// The profile's declaration of this task: its `id`, `actions`,
    /// `categories` and `settings`.
    pub declaration: &'a Value,
    /// The workspace and its projects, as Entorhinal listed them, for a run
    /// that needs them: a task that works across a workspace
    /// ([`Task::once`]), a task of a workspace's own memories
    /// ([`Task::workspace`]), and a project's run of a task that also reads
    /// the project's workspace ([`Task::sees_workspace`]), when that
    /// workspace holds two or more projects. `None` for every other run.
    pub workspace: Option<&'a WorkspaceMembers>,
    /// The workspace guidance the run's messages show, as core serves it to
    /// head agents ([`super::guidance`]). Read only for a task that shows
    /// it ([`Task::reads_guidance`]), and `None` whenever core serves no
    /// guidance for head agents of the run's workspace.
    pub guidance: Option<&'a str>,
    /// The project's live branches besides its default branch, as the
    /// person's `dreamer.branches` setting lists them; empty for every
    /// other owner and for a project with one line.
    pub branches: &'a [String],
}

impl TaskContext<'_> {
    /// The task's id in the profile (`swe:classify-memories`).
    pub fn task_id(&self) -> &str {
        self.declaration["id"].as_str().unwrap_or_default()
    }
}

/// One kind of dreamer task.
pub(crate) trait Task: Send + Sync {
    /// The kind memory profiles name (`classify-memories`).
    fn kind(&self) -> &'static str;
    /// Whether the task works on the person's global memories rather than a
    /// project's. The engine then schedules it once per machine, under
    /// [`Owner::Global`], instead of once for each project whose profile
    /// declares it.
    fn global(&self) -> bool {
        false
    }
    /// Whether the task runs once for each project and the workspace the
    /// project is in, instead of on a schedule. The engine never schedules
    /// such a task: it starts it for a project whose workspace holds two or
    /// more projects, gives it that workspace, and records the workspace it
    /// ran for.
    fn once(&self) -> bool {
        false
    }
    /// Kinds of task that must have run on the project once before this
    /// one-time task starts for it ([`Self::once`]). A run counts when it
    /// ended without failing: it applied changes, found nothing to do,
    /// stopped at its budget, or was skipped because this machine can't run
    /// it.
    fn after(&self) -> &'static [&'static str] {
        &[]
    }
    /// Whether the task works on the memories a workspace shares rather
    /// than a project's. The engine then schedules it once for each
    /// workspace of two or more projects, under [`Owner::Workspace`], and
    /// gives each run the workspace and its projects.
    fn workspace(&self) -> bool {
        false
    }
    /// Whether a project's run of the task also reads the memories of the
    /// project's workspace. The engine then gives the run its workspace
    /// when Entorhinal lists two or more projects in it.
    fn sees_workspace(&self) -> bool {
        false
    }
    /// Whether the task's messages show the workspace guidance core serves
    /// ([`super::guidance`]). The engine then asks core for it once before
    /// planning the run, for the workspace the run is given, and passes it
    /// in [`TaskContext::guidance`].
    fn reads_guidance(&self) -> bool {
        false
    }
    /// The batches one run sends for the context's owner, in order. Empty
    /// when there is nothing to do; the run then sends nothing.
    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String>;
    /// The run's batches, for a task whose planning embeds text with the
    /// project's embedding provider (`embedding`, when one is configured)
    /// and so waits on the network. The engine plans every run through
    /// here; the default is [`Task::batches`], which needs neither.
    fn plan<'a>(
        &'a self,
        context: &'a TaskContext<'a>,
        embedding: Option<&'a Provider>,
    ) -> Planning<'a> {
        let _ = embedding;
        Box::pin(std::future::ready(self.batches(context)))
    }
    /// Why the run that just planned for `owner` sends nothing, when its
    /// planning ended on a reason worth recording with the run (a gate that
    /// held the model back). Taking it clears it. The default has none.
    fn skip_reason(&self, owner: &Owner) -> Option<String> {
        let _ = owner;
        None
    }
}

/// One message of a run, and how its accepted reply is written.
pub(crate) trait Batch: TaskInput + Send {
    /// Check what `reply` proposes and write what passes, inside `tx`. Every
    /// history row it writes names `run`, so the run can be undone as one.
    /// A proposal that fails its check is dropped with its reason; it never
    /// fails the batch.
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        reply: &TaskReply,
        run: i64,
    ) -> Result<Applied, String>;
    /// The folder the batch's child session works in, when it is not the
    /// folder of the session the run's project was learned from: the code
    /// reading tasks read the repository's main checkout, or a copy of one
    /// branch, instead of whatever worktree that session was in.
    fn folder(&self) -> Option<&str> {
        None
    }
    /// Whether what the batch writes is memories, so an applied change tells
    /// the memory pages. A batch that writes something else tells its own
    /// readers in [`Batch::after_commit`].
    fn changes_memories(&self) -> bool {
        true
    }
    /// What follows a committed [`Batch::apply`] outside the store: files the
    /// batch keeps next to its rows, and the readers it tells. The default
    /// does nothing.
    fn after_commit(&self, db: &ContextDb) {
        let _ = db;
    }
    /// Whether to record unusable answers after model fallback fails. A
    /// step-cap skip, like an accepted answer, can only commit while the
    /// computer still holds the role with enough time left on its lease.
    fn records_unusable_reply(&self) -> bool {
        false
    }
    /// Record what an unusable answer leaves behind, naming `run` as
    /// [`Batch::apply`] does. The default leaves each memory as it was.
    fn skip(&self, tx: &rusqlite::Transaction<'_>, run: i64) -> Result<Applied, String> {
        let _ = (tx, run);
        Ok(Applied::default())
    }
    /// The ids of the memories the batch's message asks about, for the line
    /// the engine logs when the batch is skipped. The default names none.
    fn memory_ids(&self) -> Vec<i64> {
        Vec::new()
    }
}

/// What applying a batch did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Changes the reply proposed.
    pub proposed: usize,
    /// Changes written.
    pub applied: usize,
    /// Each dropped proposal, with why.
    pub dropped: Vec<String>,
}

/// A task's system prompt and message, rendered from `profile`:
/// `dreamer/<task id>/system` and `dreamer/<task id>/<user>`. `inputs` fills
/// Magic Context's frames by name (`dreamer/classify-memories.input`) in
/// place of their sample shape, and `values` fills the documents' runtime
/// markers (`projectIdentity`). Text that still holds a marker afterwards is
/// refused: a model is never sent an unfilled slot. The check runs before
/// the inputs go in, so a memory whose own text contains `⟦` is sent as
/// written.
pub(crate) fn task_prompts(
    profile: &Profile,
    task_id: &str,
    user: &str,
    inputs: &[(&str, &str)],
    values: &[(&str, &str)],
) -> Result<(String, String), String> {
    document_prompts(
        profile,
        &format!("dreamer/{task_id}/system"),
        &format!("dreamer/{task_id}/{user}"),
        inputs,
        values,
    )
}

/// [`task_prompts`] for documents named in full, for a task whose
/// declaration names prompt documents of another task (`swe:verify-broad`
/// runs under `dreamer/swe:verify/system`).
pub(crate) fn document_prompts(
    profile: &Profile,
    system: &str,
    user: &str,
    inputs: &[(&str, &str)],
    values: &[(&str, &str)],
) -> Result<(String, String), String> {
    // Each frame first holds a placeholder no profile text or frame can
    // contain (a private-use character), replaced by the real input once
    // the markers are checked. A frame's text ends with one newline that is
    // not part of its text; a frame that ends with a blank line keeps it
    // after the input, so the next section stays apart from it.
    let placeholders: Vec<String> = (0..inputs.len())
        .map(|index| format!("\u{E000}input {index}\u{E000}"))
        .collect();
    let slots: Vec<String> = inputs
        .iter()
        .zip(&placeholders)
        .map(|((name, _), placeholder)| {
            let frame = FRAMES
                .iter()
                .find(|(frame, _)| frame == name)
                .map_or("\n", |(_, text)| text);
            let ending = &frame[frame.trim_end_matches('\n').len()..];
            let ending = if ending.is_empty() { "\n" } else { ending };
            format!("{placeholder}{ending}")
        })
        .collect();
    let mut frames: Vec<(&str, &str)> = FRAMES.to_vec();
    for ((name, _), slot_text) in inputs.iter().zip(&slots) {
        let slot = frames
            .iter_mut()
            .find(|(frame, _)| frame == name)
            .ok_or_else(|| format!("no frame {name}"))?;
        slot.1 = slot_text;
    }
    let fill = |document: &str| -> Result<String, String> {
        let mut text =
            render(profile, document, &frames).map_err(|refusal| format!("{refusal:?}"))?;
        for (name, value) in values {
            text = text.replace(&format!("⟦{name}⟧"), value);
        }
        if let Some(at) = text.find('⟦') {
            let marker: String = text[at..].chars().take_while(|c| *c != '⟧').collect();
            return Err(format!("{document}: {marker}⟧ is not filled"));
        }
        for ((_, input), placeholder) in inputs.iter().zip(&placeholders) {
            text = text.replace(
                placeholder.as_str(),
                input.strip_suffix('\n').unwrap_or(input),
            );
        }
        Ok(text)
    };
    Ok((fill(system)?, fill(user)?))
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
