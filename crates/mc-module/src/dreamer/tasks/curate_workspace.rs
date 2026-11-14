//! The `curate-workspace` task: keep each category of the memories a
//! workspace shares small and free of repeats.
//!
//! A workspace groups several projects, and its memories are shown in every
//! session of every one of them. Many arrive there from separate projects
//! (the workspace lift moves a project's memories up, and a summary of any
//! project may save one), so the same rule is often written several times in
//! different words. This task curates them the way the `curate` task
//! curates a project's ([`super::curate`]): the same parts, similar
//! memories, list parser, checks, protection, writes and undo history, on
//! the workspace's live memories (level `workspace`, owned by the workspace).
//!
//! What differs is what the message shows. A workspace has no documents, so
//! there are none to show or quote: an archive that quotes one is refused.
//! The memories every session sees are the person's own (the global level),
//! as the history head chooses them; a workspace memory that repeats one of
//! them may be archived as its duplicate. The message names the workspace and
//! its projects instead of a project.
//!
//! The engine schedules the task once per workspace of two or more
//! projects, and runs it in the folder of one of its projects seen in this
//! process; the task reads no files. A merge or split writes new workspace
//! memories that name the project the memory they replace came from.

use super::curate::{plan, shown_global, stored_resume, CurateBatch, Resume, Scope};
use crate::dreamer::task::{Batch, Owner, Task, TaskContext};
use crate::memory_writes::now_ms;
use crate::workspace_members::WorkspaceMembers;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "curate-workspace";
/// Magic Context's frame that the task's message fills.
pub(crate) const INPUT_FRAME: &str = "dreamer/curate-workspace.input";

/// The task kind.
pub(crate) struct CurateWorkspace;

/// The workspace a run is for: the context's owner, as the context's
/// workspace lists it.
fn workspace_of<'a>(context: &TaskContext<'a>) -> Result<&'a WorkspaceMembers, String> {
    let Owner::Workspace { id } = context.owner else {
        return Err(format!("{KIND} works on a workspace's memories only"));
    };
    context
        .workspace
        .filter(|workspace| workspace.workspace_id == *id)
        .ok_or_else(|| format!("{KIND} runs only with the projects of workspace {id}"))
}

impl CurateWorkspace {
    /// The run's batches for the context's workspace, in order: every part
    /// of every category the task curates, from `resume` on. `only` keeps
    /// one category, by id or tag. A workspace of fewer than two projects
    /// shares no memories: no batches.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
        resume: Option<&Resume>,
        only: Option<&str>,
    ) -> Result<Vec<CurateBatch>, String> {
        let workspace = workspace_of(context)?;
        if workspace.members.len() < 2 {
            return Ok(Vec::new());
        }
        let id = workspace.workspace_id.as_str();
        let now = now_ms();
        let shown = context
            .db
            .with_connection(|conn| shown_global(conn, id, context.profile, now))
            .map_err(|error| format!("reading the memories workspace {id} sees: {error}"))?;
        let count = workspace.members.len().to_string();
        let projects = super::lift_workspace::project_names(workspace);
        plan(
            context,
            &Scope::workspace(id),
            "",
            &shown,
            &[
                ("workspace.name", workspace.name.as_str()),
                ("workspace.count", count.as_str()),
                ("workspace.projects", projects.as_str()),
            ],
            now,
            resume,
            only,
        )
    }
}

impl Task for CurateWorkspace {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn workspace(&self) -> bool {
        true
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        let workspace = workspace_of(context)?;
        let task = context.declaration["id"].as_str().unwrap_or(KIND);
        let scope = Scope::workspace(&workspace.workspace_id);
        let resume = context
            .db
            .with_connection(|conn| stored_resume(conn, &scope.key(), task))
            .map_err(|error| {
                format!(
                    "reading where curate stopped for workspace {}: {error}",
                    scope.owner
                )
            })?;
        Ok(self
            .plan_batches(context, resume.as_ref(), None)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

#[cfg(test)]
#[path = "curate_workspace_tests.rs"]
pub(crate) mod tests;
