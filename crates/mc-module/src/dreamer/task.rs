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

/// Whose memories a run reads and may change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    /// A project's memories; `root` is its folder, where the run's child
    /// session works.
    Project { id: String, root: String },
}

/// What a task kind reads its work from.
pub(crate) struct TaskContext<'a> {
    pub db: &'a ContextDb,
    pub owner: &'a Owner,
    pub profile: &'a Profile,
    /// The profile's declaration of this task: its `id`, `actions`,
    /// `categories` and `settings`.
    pub declaration: &'a Value,
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
/// refused: a model is never sent an unfilled slot.
pub(crate) fn task_prompts(
    profile: &Profile,
    task_id: &str,
    user: &str,
    inputs: &[(&str, &str)],
    values: &[(&str, &str)],
) -> Result<(String, String), String> {
    // A frame's text ends with one newline that is not part of its text.
    let texts: Vec<String> = inputs
        .iter()
        .map(|(_, text)| format!("{}\n", text.strip_suffix('\n').unwrap_or(text)))
        .collect();
    let mut frames: Vec<(&str, &str)> = FRAMES.to_vec();
    for ((name, _), text) in inputs.iter().zip(&texts) {
        let slot = frames
            .iter_mut()
            .find(|(frame, _)| frame == name)
            .ok_or_else(|| format!("no frame {name}"))?;
        slot.1 = text;
    }
    let fill = |document: String| -> Result<String, String> {
        let mut text =
            render(profile, &document, &frames).map_err(|refusal| format!("{refusal:?}"))?;
        for (name, value) in values {
            text = text.replace(&format!("⟦{name}⟧"), value);
        }
        match text.find('⟦') {
            Some(at) => {
                let marker: String = text[at..].chars().take_while(|c| *c != '⟧').collect();
                Err(format!("{document}: {marker}⟧ is not filled"))
            }
            None => Ok(text),
        }
    };
    Ok((
        fill(format!("dreamer/{task_id}/system"))?,
        fill(format!("dreamer/{task_id}/{user}"))?,
    ))
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
