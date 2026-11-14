//! The `refresh-primers` task: keep the answers to a project's standing
//! questions true to its code.
//!
//! A primer is a question agents asked in several sessions; its answer
//! reaches agents only through `ctx_search`. Each run first promotes
//! ([`promote`]): it prunes old candidates, embeds the questions that have
//! no vector yet when an embedding provider is configured, and clusters the
//! candidates into primers. It then refreshes at most [`PER_RUN`] stale
//! primers (an empty answer, never refreshed, or asked again since the last
//! refresh), the least recently refreshed first, one child each. A child
//! reads the project's code with the read-only reader tools the run's plan
//! gives it ([`crate::dreamer::run`]), oriented by the summary of the work in
//! which the question last came up, and answers `{"answer": "..."}`.
//!
//! The stored answer stays when the run made no tool call (an answer that
//! read no code is a paraphrase of the orientation), when the answer is
//! empty, or when it is longer than [`MAX_ANSWER`]. A written answer is
//! guarded by the primer's state as the run read it, so a primer changed
//! meanwhile is not overwritten.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Planning, Task, TaskContext};
use crate::embedding::Provider;
use crate::memory_profile::FRAMES;
use crate::memory_writes::now_ms;
use crate::summary::fit::Window;

pub(crate) mod promote;

use promote::Primer;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "refresh-primers";
/// Magic Context's frame the task's message fills.
pub(crate) const INPUT_FRAME: &str = "dreamer/refresh-primers.input";
/// At most this many primers are refreshed in one run.
pub(crate) const PER_RUN: usize = 5;
/// The longest answer written, in UTF-16 units as the plugin counted.
pub(crate) const MAX_ANSWER: usize = 20_000;
/// What the message shows for a primer with no answer yet.
const NO_ANSWER: &str = "none yet";
/// What it shows when the summary the question last came up in is gone.
const NO_ORIENTATION: &str = "none";
/// The action a task declaration names writing an answer by.
const ACTION: &str = "set-primer-answer";

/// Whether `primer` needs a refresh: its answer is empty, it was never
/// refreshed, or it was asked again since its last refresh.
pub(crate) fn stale(primer: &Primer) -> bool {
    primer.answer.trim().is_empty()
        || primer
            .answer_refreshed_at
            .is_none_or(|refreshed| primer.last_observed_at.unwrap_or(0) > refreshed)
}

/// The stale primers of `primers` a run refreshes, at most `limit` (a run
/// takes [`PER_RUN`]), in order: the least recently refreshed first (never
/// refreshed before all), then the least recently observed (or created),
/// then by id. A primer asked often is observed again on every recurrence,
/// so ordering by observation first would keep it ahead of the quiet ones
/// for good.
pub(crate) fn select(primers: &[Primer], limit: usize) -> Vec<Primer> {
    let mut chosen: Vec<Primer> = primers
        .iter()
        .filter(|primer| stale(primer))
        .cloned()
        .collect();
    chosen.sort_by_key(|primer| {
        (
            primer.answer_refreshed_at.unwrap_or(0),
            primer.last_observed_at.unwrap_or(primer.created_at),
            primer.id,
        )
    });
    chosen.truncate(limit);
    chosen
}

/// The summary of the work in which `primer` last came up: the title and
/// text of the summary its newest source candidate of the project names.
/// `None` when that candidate or summary no longer exists.
pub(crate) fn orientation(conn: &Connection, primer: &Primer) -> rusqlite::Result<Option<String>> {
    let newest = promote::candidates_by_ids(conn, &primer.sources)?
        .into_iter()
        .filter(|candidate| candidate.project == primer.project)
        .max_by_key(|candidate| (candidate.source_time, candidate.id));
    let Some(candidate) = newest else {
        return Ok(None);
    };
    let Some(start) = candidate.compartment_start else {
        return Ok(None);
    };
    let found: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT title, p1, content FROM compartments
              WHERE session_id = ?1 AND harness = ?2 AND start_message = ?3
              ORDER BY sequence LIMIT 1",
            params![candidate.session, candidate.harness, start],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(found.map(|(title, p1, content)| {
        let text = p1.filter(|p1| !p1.trim().is_empty()).unwrap_or(content);
        format!("{}\n{}", title.trim(), text.trim())
    }))
}

/// The line of the input frame right after the line `open`: a block's
/// standing instruction.
fn frame_line_after(open: &str) -> &'static str {
    let (_, text) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .expect("the refresh-primers input frame is bundled");
    text.lines()
        .skip_while(|line| *line != open)
        .nth(1)
        .unwrap_or_default()
}

/// The text that fills the task's input frame, in the frame's own layout.
pub(crate) fn input(primer: &Primer, orientation: Option<&str>) -> String {
    let answer = primer.answer.trim();
    format!(
        "<question>\n{}\n</question>\n\n<current-answer>\n{}\n</current-answer>\n\n<orientation>\n{}\n{}\n</orientation>",
        primer.question.trim(),
        if answer.is_empty() { NO_ANSWER } else { answer },
        frame_line_after("<orientation>"),
        orientation.unwrap_or(NO_ORIENTATION)
    )
}

/// The answer a reply gives: its JSON object's `answer`, trimmed. The
/// object is read from the reply's first `{` to its last `}`, or else from
/// inside its first code fence. A missing or non-text `answer` is an empty
/// one. A reply with no readable object is refused.
pub(crate) fn parse_answer(reply: &str) -> Result<String, String> {
    let braces = match (reply.find('{'), reply.rfind('}')) {
        (Some(start), Some(end)) if start <= end => Some(&reply[start..=end]),
        _ => None,
    };
    let fenced = reply.find("```").and_then(|open| {
        let after = &reply[open + 3..];
        let body = after.strip_prefix("json").unwrap_or(after);
        body.find("```").map(|close| &body[..close])
    });
    let value = [braces, fenced]
        .into_iter()
        .flatten()
        .find_map(|text| {
            serde_json::from_str::<Value>(text.trim())
                .ok()
                .filter(Value::is_object)
        })
        .ok_or("the reply holds no JSON object")?;
    Ok(value["answer"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned())
}

/// The task kind.
pub(crate) struct RefreshPrimers;

impl RefreshPrimers {
    /// Promote the project's candidates at `now`, after pruning old ones
    /// and, with `vectors`, storing the question vectors just made (each
    /// candidate's id with its vector) under `model`.
    pub(crate) fn promote(
        &self,
        context: &TaskContext<'_>,
        project: &str,
        vectors: &[(i64, Vec<f32>)],
        model: Option<&str>,
        now: i64,
    ) -> Result<promote::Promoted, String> {
        context
            .db
            .with_connection(|conn| {
                if let Some(model) = model {
                    for (id, vector) in vectors {
                        promote::set_embedding(conn, *id, vector, model)?;
                    }
                }
                promote::promote(conn, project, now)
            })
            .map_err(|error| format!("promoting the primers of {project}: {error}"))
    }

    /// Prune the project's old candidates at `now`, and return the
    /// questions of the ones left that have no vector yet.
    fn prune(
        &self,
        context: &TaskContext<'_>,
        project: &str,
        now: i64,
    ) -> Result<Vec<(i64, String)>, String> {
        context
            .db
            .with_connection(|conn| {
                let pruned = promote::prune(conn, project, now)?;
                if pruned > 0 {
                    tracing::info!(
                        "ck-mc: dreamer: primers of {project}: {pruned} expired candidate(s) pruned"
                    );
                }
                Ok::<_, rusqlite::Error>(
                    promote::candidates_for_promotion(conn, project, now)?
                        .into_iter()
                        .filter(|candidate| {
                            candidate.embedding.is_none() || candidate.model.is_none()
                        })
                        .map(|candidate| (candidate.id, candidate.question))
                        .collect(),
                )
            })
            .map_err(|error| format!("pruning the primer candidates of {project}: {error}"))
    }

    /// The run's messages once promotion is done: one per primer it
    /// refreshes.
    pub(crate) fn refresh_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<RefreshBatch>, String> {
        self.refresh_up_to(context, PER_RUN)
    }

    /// [`Self::refresh_batches`] with room for `limit` primers: a replay
    /// may ask for every stale primer.
    pub(crate) fn refresh_up_to(
        &self,
        context: &TaskContext<'_>,
        limit: usize,
    ) -> Result<Vec<RefreshBatch>, String> {
        let Owner::Project { id: project, .. } = context.owner else {
            return Err(format!("{KIND} works on a project's primers only"));
        };
        let chosen = context
            .db
            .with_connection(|conn| {
                let chosen = select(&promote::active_primers(conn, project)?, limit);
                chosen
                    .into_iter()
                    .map(|primer| Ok((orientation(conn, &primer)?, primer)))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|error| format!("reading the primers of {project}: {error}"))?;
        let allowed = context.declaration["actions"]
            .as_array()
            .is_some_and(|actions| actions.iter().any(|action| action == ACTION));
        chosen
            .into_iter()
            .map(|(orientation, primer)| {
                let text = input(&primer, orientation.as_deref());
                let (system, message) = task_prompts(
                    context.profile,
                    context.task_id(),
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[("projectIdentity", project.as_str())],
                )?;
                Ok(RefreshBatch {
                    primer,
                    system,
                    message,
                    allowed,
                })
            })
            .collect()
    }

    /// Prune and promote as a run without an embedding provider does:
    /// questions without a vector cluster by their text.
    pub(crate) fn promote_by_text(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<promote::Promoted, String> {
        let Owner::Project { id: project, .. } = context.owner else {
            return Err(format!("{KIND} works on a project's primers only"));
        };
        let now = now_ms();
        self.prune(context, project, now)?;
        let promoted = self.promote(context, project, &[], None, now)?;
        log_promotion(project, &promoted);
        Ok(promoted)
    }

    /// A whole run's messages without an embedding provider.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<RefreshBatch>, String> {
        self.promote_by_text(context)?;
        self.refresh_batches(context)
    }
}

fn log_promotion(project: &str, promoted: &promote::Promoted) {
    tracing::info!(
        "ck-mc: dreamer: primers of {project}: {} candidate(s), {} promoted, {} updated",
        promoted.candidates,
        promoted.promoted,
        promoted.updated
    );
}

impl Task for RefreshPrimers {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }

    /// With an embedding provider, the candidates without a question vector
    /// get one before they are clustered; when the provider fails they
    /// cluster by their text.
    fn plan<'a>(
        &'a self,
        context: &'a TaskContext<'a>,
        embedding: Option<&'a Provider>,
    ) -> Planning<'a> {
        Box::pin(async move {
            let Owner::Project { id: project, .. } = context.owner else {
                return Err(format!("{KIND} works on a project's primers only"));
            };
            let now = now_ms();
            let missing = self.prune(context, project, now)?;
            let mut vectors = Vec::new();
            if let Some(provider) = embedding.filter(|_| !missing.is_empty()) {
                let questions: Vec<String> = missing
                    .iter()
                    .map(|(_, question)| question.clone())
                    .collect();
                match provider.embed_documents(&questions).await {
                    Some(made) => {
                        vectors = missing
                            .iter()
                            .zip(made)
                            .filter_map(|((id, _), vector)| Some((*id, vector?)))
                            .collect();
                    }
                    None => tracing::info!(
                        "ck-mc: dreamer: primers of {project}: embedding unavailable; questions without a vector cluster by their text"
                    ),
                }
            }
            let model = embedding.map(Provider::model_id);
            let promoted = self.promote(context, project, &vectors, model.as_deref(), now)?;
            log_promotion(project, &promoted);
            let batches: Vec<Box<dyn Batch>> = self
                .refresh_batches(context)?
                .into_iter()
                .map(|batch| Box::new(batch) as Box<dyn Batch>)
                .collect();
            Ok::<_, String>(batches)
        })
    }
}

/// One message of a refresh run: one primer.
pub(crate) struct RefreshBatch {
    /// The primer as the run read it.
    pub(crate) primer: Primer,
    system: String,
    message: String,
    /// Whether the task's declaration allows writing an answer.
    allowed: bool,
}

impl RefreshBatch {
    /// The message the batch sends.
    #[cfg(test)]
    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    /// Why the stored answer stays for `reply`'s `answer`, or `None` when
    /// the answer is written.
    fn refusal(&self, answer: &str, steps: Option<u64>) -> Option<String> {
        if !self.allowed {
            return Some(format!("the task's declaration does not allow {ACTION}"));
        }
        match steps {
            None => {
                return Some("the runner reported no step count, so no tool call is proven".into())
            }
            Some(steps) if steps <= 1 => return Some("the run made no tool call".into()),
            Some(_) => {}
        }
        if answer.is_empty() {
            return Some("the answer is empty".into());
        }
        let length = answer.encode_utf16().count();
        if length > MAX_ANSWER {
            return Some(format!(
                "the answer is longer than {MAX_ANSWER} characters ({length})"
            ));
        }
        None
    }

    /// Write `answer` from a run of `steps` model steps when it passes, as
    /// of `now`, guarded by the primer's state as the run read it.
    pub(crate) fn write(
        &self,
        tx: &Transaction<'_>,
        answer: &str,
        steps: Option<u64>,
        now: i64,
    ) -> rusqlite::Result<Applied> {
        let mut applied = Applied {
            proposed: 1,
            ..Applied::default()
        };
        let label = format!("primer {}", self.primer.id);
        if let Some(reason) = self.refusal(answer, steps) {
            applied
                .dropped
                .push(format!("{label}: {reason}; the stored answer stays"));
            return Ok(applied);
        }
        let changed = tx.execute(
            "UPDATE primers SET answer = ?2, answer_refreshed_at = ?3, updated_at = ?3
              WHERE id = ?1 AND status = 'active' AND updated_at = ?4 AND answer = ?5",
            params![
                self.primer.id,
                answer,
                now,
                self.primer.updated_at,
                self.primer.answer
            ],
        )?;
        if changed == 1 {
            applied.applied = 1;
        } else {
            applied
                .dropped
                .push(format!("{label}: it changed after the run read it"));
        }
        Ok(applied)
    }
}

impl TaskInput for RefreshBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        parse_answer(reply).map(drop)
    }
}

impl Batch for RefreshBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, _run: i64) -> Result<Applied, String> {
        let answer = parse_answer(&reply.text)?;
        self.write(tx, &answer, reply.steps, now_ms())
            .map_err(|error| format!("writing primer {}'s answer: {error}", self.primer.id))
    }
}

#[cfg(test)]
#[path = "refresh_primers_tests.rs"]
pub(crate) mod tests;
