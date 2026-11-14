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

use serde_json::Value;

use super::run::{TaskInput, TaskReply};
use crate::context_db::ContextDb;
use crate::memory_profile::{render, Profile, FRAMES};
use crate::workspace_members::WorkspaceMembers;

/// Whose memories a run reads and may change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    /// A project's memories; `root` is its folder, where the run's child
    /// session works.
    Project { id: String, root: String },
    /// The person's own memories, at the global level, and the summarizer's
    /// observations about them. One owner per machine, not per project.
    Global,
}

/// What a task kind reads its work from.
pub(crate) struct TaskContext<'a> {
    pub db: &'a ContextDb,
    pub owner: &'a Owner,
    pub profile: &'a Profile,
    /// The profile's declaration of this task: its `id`, `actions`,
    /// `categories` and `settings`.
    pub declaration: &'a Value,
    /// The workspace of the owner's project and its projects, as Entorhinal
    /// listed them, for a task that works across a workspace
    /// ([`Task::once`]). `None` for every other run.
    pub workspace: Option<&'a WorkspaceMembers>,
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
    /// The batches one run sends for the context's owner, in order. Empty
    /// when there is nothing to do; the run then sends nothing.
    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String>;
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
