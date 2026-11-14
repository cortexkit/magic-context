//! The `lift-workspace` task: move each of a project's memories that holds
//! for every project of its workspace up to the workspace level, once.
//!
//! A workspace memory is shown in every session of every project in the
//! workspace, so the bar is high. A model judges each memory from its text
//! and the names of the workspace's projects, and a memory moves only when
//! the model says it holds for all of them. Anything project-specific or
//! uncertain stays with its project.
//!
//! The task runs once for a project whose workspace holds two or more
//! projects, and never on a schedule: the engine starts it and records the
//! workspace it ran for ([`super::super::engine`]). It reads the project's
//! live memories (active or permanent, not expired) and leaves out those the
//! person wrote or edited ([`PERSON_WRITTEN`], the same check that keeps
//! them out of the curate task's archives and merges): the person chose
//! where those belong. A batch holds forty memories, in id order.
//!
//! A move keeps the row: the same id and text, its level becomes
//! `workspace`, its owner the workspace, and the project stays recorded as
//! its source. Each move is one history decision that names the run and the
//! model's reason, so undoing the run puts the memory back with its project.
//! A move is refused, and the memory stays where it is, when the workspace
//! already holds a live memory with the same text in the same category, when
//! the profile doesn't allow the memory's category at the workspace level,
//! or when the memory changed after the batch read it.

use std::collections::{BTreeSet, HashSet};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;

use super::classify::{attribute, body, describe_shape};
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_profile::Profile;
use crate::memory_writes::{
    history_json, history_snapshot, now_ms, record_history, History, PERSON_WRITTEN,
};
use crate::summary::fit::Window;
use crate::workspace_members::WorkspaceMembers;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "lift-workspace";
/// Magic Context's frame that the task's message fills with the memories.
const INPUT_FRAME: &str = "dreamer/lift-workspace.input";
/// Who the undo history names as the decider.
const WRITER: &str = "dreamer:lift-workspace";
/// The operation the journal records for a move.
const OPERATION: &str = "lift_workspace";
/// At most this many memories are placed by one message.
pub(crate) const BATCH_SIZE: usize = 40;
/// The level a move files a memory at.
const WORKSPACE: &str = "workspace";

/// One live project memory as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The tag it was written under (`origin_category`), the category the
    /// classify task's message shows too.
    pub category: String,
    pub content: String,
    pub revision: i64,
    /// The person wrote or edited it, so it is never sent.
    pub person: bool,
}

/// `project`'s live memories at `now`, by id: active or permanent, and not
/// expired.
pub(crate) fn live_memories(
    conn: &Connection,
    project: &str,
    now: i64,
) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare(&format!(
        "SELECT m.id, m.origin_category, m.content, m.revision, {PERSON_WRITTEN}
           FROM memories m
          WHERE m.level = 'project' AND m.owner_id = ?1 AND m.status IN ('active', 'permanent')
            AND (m.expires_at IS NULL OR m.expires_at > ?2)
          ORDER BY m.id"
    ))?
    .query_map(params![project, now], |row| {
        Ok(Memory {
            id: row.get(0)?,
            category: row.get(1)?,
            content: row.get(2)?,
            revision: row.get(3)?,
            person: row.get(4)?,
        })
    })?
    .collect()
}

/// The workspace's project names, sorted and comma-separated, as the
/// message names them.
pub(crate) fn project_names(workspace: &WorkspaceMembers) -> String {
    let mut names: Vec<&str> = workspace
        .members
        .iter()
        .map(|member| member.name.as_str())
        .collect();
    names.sort_unstable();
    names.join(", ")
}

/// The text that fills the task's input frame: each memory in the frame's
/// own shape.
pub(crate) fn input(memories: &[Memory]) -> String {
    let entries: Vec<String> = memories
        .iter()
        .map(|memory| format!("[{}] {}\n{}", memory.id, memory.category, memory.content))
        .collect();
    format!("### Memories of this project\n{}", entries.join("\n\n"))
}

/// One memory's place as a reply gives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub id: i64,
    /// Why the memory holds for every project of the workspace; `None` keeps
    /// it with its project.
    pub workspace: Option<String>,
}

/// An attribute value with XML's five entities decoded.
fn unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Read a reply's `<place>` manifest. Each entry needs a numeric `id` and a
/// `level` of `project` or `workspace`; a workspace entry also needs a
/// `reason`. Any entry without them refuses the whole manifest.
pub(crate) fn parse_manifest(text: &str) -> Result<Vec<Verdict>, String> {
    let body = body(text, "place")?;
    // An attribute value may hold `>` or `/`, so quoted values are skipped
    // whole when looking for the end of the tag.
    let entry = Regex::new(r#"<memory\b((?:"[^"]*"|[^">])*)>"#).expect("a fixed manifest pattern");
    let mut found = Vec::new();
    for captures in entry.captures_iter(&body) {
        let attributes = &captures[1];
        let id: i64 = attribute(attributes, "id", "[0-9]+", false)
            .and_then(|value| value.parse().ok())
            .ok_or("place manifest entry missing numeric id")?;
        let level = attribute(attributes, "level", "[^\"]*", false)
            .ok_or_else(|| format!("place manifest entry {id} missing level"))?;
        let workspace = match level.trim() {
            "project" => None,
            WORKSPACE => {
                let reason = attribute(attributes, "reason", "[^\"]*", false)
                    .map(|reason| unescape(reason.trim()))
                    .filter(|reason| !reason.is_empty())
                    .ok_or_else(|| {
                        format!("place manifest entry {id} moves to the workspace without a reason")
                    })?;
                Some(reason)
            }
            other => {
                return Err(format!(
                    "place manifest entry {id} has level {other:?}; expected project or workspace"
                ))
            }
        };
        found.push(Verdict { id, workspace });
    }
    if found.is_empty() && !body.trim().is_empty() {
        return Err(describe_shape(text, "place"));
    }
    let mut seen = HashSet::new();
    for verdict in &found {
        if !seen.insert(verdict.id) {
            return Err(format!(
                "place manifest contains duplicate id {}",
                verdict.id
            ));
        }
    }
    Ok(found)
}

/// A reply's manifest when it places exactly the memories in `expected`,
/// each once.
pub(crate) fn validate_manifest(text: &str, expected: &[i64]) -> Result<Vec<Verdict>, String> {
    let found = parse_manifest(text)?;
    if found.is_empty() && !expected.is_empty() {
        return Err(describe_shape(text, "place"));
    }
    for verdict in &found {
        if !expected.contains(&verdict.id) {
            return Err(format!("place manifest contains unknown id {}", verdict.id));
        }
    }
    for id in expected {
        if !found.iter().any(|verdict| verdict.id == *id) {
            return Err(format!("place manifest missing id {id}"));
        }
    }
    Ok(found)
}

/// The profile category ids a memory may be filed under at the workspace
/// level (their `allowed_levels`).
fn workspace_categories(profile: &Profile) -> BTreeSet<String> {
    profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|category| {
            category["allowed_levels"]
                .as_array()
                .is_some_and(|levels| levels.iter().any(|level| level == WORKSPACE))
        })
        .filter_map(|category| category["id"].as_str().map(str::to_owned))
        .collect()
}

/// What one run reads before it plans its batches: the memories it sends,
/// and the ids it leaves out because the person wrote or edited them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Pool {
    pub sent: Vec<Memory>,
    pub person: Vec<i64>,
}

impl Pool {
    pub(crate) fn of(live: Vec<Memory>) -> Self {
        let (person, sent): (Vec<Memory>, Vec<Memory>) =
            live.into_iter().partition(|memory| memory.person);
        Self {
            sent,
            person: person.iter().map(|memory| memory.id).collect(),
        }
    }
}

/// The task kind.
pub(crate) struct LiftWorkspace;

impl LiftWorkspace {
    /// The context owner's pool and the run's batches for `workspace`, in
    /// order. A workspace of fewer than two projects has nothing to lift
    /// into: no batches.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
        workspace: &WorkspaceMembers,
    ) -> Result<(Pool, Vec<LiftBatch>), String> {
        let Owner::Project { id: project, .. } = context.owner else {
            return Err(format!("{KIND} works on a project's memories only"));
        };
        if workspace.members.len() < 2 {
            return Ok((Pool::default(), Vec::new()));
        }
        let live = context
            .db
            .with_connection(|conn| live_memories(conn, project, now_ms()))
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let pool = Pool::of(live);
        let allowed = workspace_categories(context.profile);
        let count = workspace.members.len().to_string();
        let projects = project_names(workspace);
        let batches = pool
            .sent
            .chunks(BATCH_SIZE)
            .enumerate()
            .map(|(index, memories)| {
                let text = input(memories);
                let (system, message) = task_prompts(
                    context.profile,
                    context.task_id(),
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[
                        ("projectIdentity", project.as_str()),
                        ("workspace.name", workspace.name.as_str()),
                        ("workspace.count", count.as_str()),
                        ("workspace.projects", projects.as_str()),
                    ],
                )?;
                Ok(LiftBatch {
                    index,
                    project: project.clone(),
                    workspace: workspace.workspace_id.clone(),
                    allowed: allowed.clone(),
                    system,
                    message,
                    read: memories
                        .iter()
                        .map(|memory| (memory.id, memory.revision))
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok((pool, batches))
    }
}

impl Task for LiftWorkspace {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn once(&self) -> bool {
        true
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        let workspace = context
            .workspace
            .ok_or_else(|| format!("{KIND} runs only for a project in a workspace"))?;
        Ok(self
            .plan_batches(context, workspace)?
            .1
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// One message of a lift run.
pub(crate) struct LiftBatch {
    /// Its place in the run, which names its decisions in the undo history.
    index: usize,
    project: String,
    /// The workspace's id: the owner a moved memory gets.
    workspace: String,
    /// The profile category ids the workspace level allows.
    allowed: BTreeSet<String>,
    system: String,
    message: String,
    /// Each memory the batch places, with the revision it was read at.
    pub(crate) read: Vec<(i64, i64)>,
}

impl LiftBatch {
    pub(crate) fn ids(&self) -> Vec<i64> {
        self.read.iter().map(|(id, _)| *id).collect()
    }

    /// The decision one move is recorded under.
    fn decision_key(&self, run: i64, id: i64) -> String {
        format!("dream-run:{run}:{KIND}:{}:{id}", self.index)
    }
}

impl TaskInput for LiftBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        validate_manifest(reply, &self.ids()).map(|_| ())
    }
}

impl Batch for LiftBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let verdicts = validate_manifest(&reply.text, &self.ids())?;
        let placed = self
            .place(tx, &verdicts, run)
            .map_err(|error| format!("moving memories to the workspace: {error}"))?;
        Ok(Applied {
            proposed: placed.proposed,
            applied: placed.moved.len(),
            dropped: placed.refused.into_iter().map(|(_, why)| why).collect(),
        })
    }
}

/// What placing a batch's verdicts did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Placed {
    /// Moves the reply proposed.
    pub proposed: usize,
    /// Each memory moved, with the model's reason.
    pub moved: Vec<(i64, String)>,
    /// Each proposed move refused, with why.
    pub refused: Vec<(i64, String)>,
}

/// A memory row as a batch finds it when it writes.
struct Current {
    live: bool,
    revision: i64,
    category_id: String,
    hash: String,
}

fn current(
    tx: &Transaction<'_>,
    id: i64,
    project: &str,
    now: i64,
) -> rusqlite::Result<Option<Current>> {
    tx.query_row(
        "SELECT level = 'project' AND owner_id = ?2 AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?3),
                revision, category, normalized_hash
           FROM memories WHERE id = ?1",
        params![id, project, now],
        |row| {
            Ok(Current {
                live: row.get::<_, Option<bool>>(0)?.unwrap_or(false),
                revision: row.get(1)?,
                category_id: row.get(2)?,
                hash: row.get(3)?,
            })
        },
    )
    .optional()
}

impl LiftBatch {
    /// Move each memory `verdicts` places at the workspace, in `tx`, and
    /// refuse each move that doesn't pass its checks.
    pub(crate) fn place(
        &self,
        tx: &Transaction<'_>,
        verdicts: &[Verdict],
        run: i64,
    ) -> rusqlite::Result<Placed> {
        let now = now_ms();
        let mut placed = Placed::default();
        for verdict in verdicts {
            let Some(reason) = &verdict.workspace else {
                continue;
            };
            placed.proposed += 1;
            let id = verdict.id;
            let Some(&(_, read_revision)) = self.read.iter().find(|(read, _)| *read == id) else {
                continue;
            };
            match self.refusal(tx, id, read_revision, now)? {
                Some(why) => placed.refused.push((id, why)),
                None => match self.move_one(tx, id, read_revision, reason, run, now)? {
                    Some(why) => placed.refused.push((id, why)),
                    None => placed.moved.push((id, reason.clone())),
                },
            }
        }
        Ok(placed)
    }

    /// Why memory `id` can't move now, or `None` when it can.
    fn refusal(
        &self,
        tx: &Transaction<'_>,
        id: i64,
        read_revision: i64,
        now: i64,
    ) -> rusqlite::Result<Option<String>> {
        let Some(current) = current(tx, id, &self.project, now)?.filter(|current| current.live)
        else {
            return Ok(Some(format!(
                "memory {id} is no longer a live memory of the project"
            )));
        };
        if current.revision != read_revision {
            return Ok(Some(format!(
                "memory {id} changed after the batch read it (revision {read_revision}, now {})",
                current.revision
            )));
        }
        if !self.allowed.contains(&current.category_id) {
            return Ok(Some(format!(
                "memory {id} is filed under {}, which the profile doesn't allow at the workspace level",
                current.category_id
            )));
        }
        let duplicate: Option<i64> = tx
            .query_row(
                "SELECT id FROM memories
                  WHERE level = 'workspace' AND owner_id = ?1 AND category = ?2
                    AND normalized_hash = ?3 AND id != ?4
                    AND (status IS NULL OR status IN ('active', 'permanent'))
                  ORDER BY id LIMIT 1",
                params![self.workspace, current.category_id, current.hash, id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(duplicate.map(|other| {
            format!("memory {id}'s text already exists at the workspace level as memory {other}")
        }))
    }

    /// Move memory `id`, at `revision`, to the workspace and record the
    /// move. Why it can't, when the undo history can't record its row.
    #[allow(clippy::too_many_arguments)]
    fn move_one(
        &self,
        tx: &Transaction<'_>,
        id: i64,
        revision: i64,
        reason: &str,
        run: i64,
        now: i64,
    ) -> rusqlite::Result<Option<String>> {
        let Some(before) = history_snapshot(tx, id)? else {
            return Ok(Some(format!(
                "memory {id} holds a row the undo history can't record"
            )));
        };
        // Clause evidence is kept per revision. The text stays the same, so
        // the evidence moves to the new revision with it.
        tx.execute(
            "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
             SELECT memory_id, revision + 1, clause_ordinal, text_hash, evidence_json
               FROM memory_clause_evidence WHERE memory_id = ?1 AND revision = ?2",
            params![id, revision],
        )?;
        // Every change the undo history records advances the revision, so a
        // writer holding the old one sees that its read is stale.
        tx.execute(
            "UPDATE memories SET level = 'workspace', owner_id = ?2, source_project_id = ?3,
                    revision = revision + 1, updated_at = ?4
              WHERE id = ?1",
            params![id, self.workspace, self.project, now],
        )?;
        let after = history_snapshot(tx, id)?.ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!(
                "memory {id} has no history snapshot after its move"
            ))
        })?;
        let key = self.decision_key(run, id);
        let decision = record_history(
            tx,
            &History {
                key: &key,
                project: &self.project,
                writer: WRITER,
                operation: OPERATION,
                reason,
                now,
                before: &[Some(before)],
                after: &[Some(after)],
                source_ids: &[id],
                survivor_id: None,
                evidence: json!({"workspace": self.workspace, "reason": reason}),
            },
        )?;
        // The journal row is written the way the other history writers
        // write theirs: the receipt first, then the whole decision, writer
        // included, in both snapshot columns, where the undo view reads it.
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                self.project,
                key,
                OPERATION,
                json!({"state": "applied", "reason": OPERATION, "memoryIds": [id], "workspace": self.workspace})
                    .to_string(),
                now
            ],
        )?;
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![key, history_json(&decision)],
        )?;
        Ok(None)
    }
}

#[cfg(test)]
#[path = "lift_workspace_tests.rs"]
pub(crate) mod tests;
