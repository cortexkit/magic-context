//! One dreamer task run on a model.
//!
//! Routing picks a model for the task's kind (`magic-context.dream.<kind>`)
//! on whatever runner it chooses. The run happens in a child session of
//! Magic Context's own on that runner, in the project's folder, the same way
//! a summary run does ([`crate::summary::run`]): one message with the task's
//! input under the task's system prompt, no tools, one model step, and one
//! reply that the task reads.
//!
//! The task's input is built after the model is chosen, so it can fit the
//! model's window. A transient provider error retries twice on the same
//! model in a new child; a model that still fails, or whose reply the task
//! can't use, is replaced by the next one routing picks without it, at most
//! twice. Every routing decision's outcome is reported back to routing. An
//! account wait, from routing or the runner, ends the run as a wait: nothing
//! is counted against the task.

use std::time::Duration;

use cortexkit_role_compaction::read::{SessionRef, StepUsage};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_routing::report::Outcome;

use crate::client::{Child, RunnerClient};
use crate::count::Counter;
use crate::routing::{self, DreamDemand, Router, DREAM_OUTPUT_TOKENS};
use crate::summary::account_wait::{AccountWait, SendKind};
use crate::summary::fit::Window;
use crate::summary::run::{
    backoff, now_ms, retryable, send_and_wait, Model, SummaryError, MAX_RETRIES,
};

/// How long one task run may take, retries and fallbacks included.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// After the first model routing picks fails, this many others are tried.
const MAX_FALLBACKS: usize = 2;
/// What a dreamer child's session id starts with. The engine's run id
/// follows, then the attempt, so each attempt has a child of its own and a
/// runner's owner can find the run in their records.
pub const CHILD: &str = "mc-dream";

/// What a task gives a run: its system prompt, and its message for a model
/// once the model's window is known.
pub trait TaskInput: Sync {
    /// The system prompt the task runs under.
    fn system(&self) -> &str;
    /// The task's message for a model that can take `window`'s input next to
    /// `output_tokens` of reply. `None` when not even the smallest input the
    /// task can send fits this model; the engine only starts a run that has
    /// something to do.
    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String>;
    /// Whether the task can use `reply`. A reply it can't use counts as a
    /// failed model, and the next model is tried with the same input.
    fn accepts(&self, reply: &str) -> Result<(), String>;
}

/// One task run's request.
pub struct TaskRun<'a> {
    pub demand: &'static DreamDemand,
    /// The engine's id for this run; it names the run's child sessions.
    pub run_id: &'a str,
    /// The folder the child runs in: the project's root, where the runner
    /// creates it under Magic Context's scope for that folder.
    pub project_root: &'a str,
}

/// A run that got a reply the task accepted.
#[derive(Clone, Debug)]
#[expect(
    dead_code,
    reason = "the task kinds that read a reply are not registered yet"
)]
pub struct TaskReply {
    pub text: String,
    /// The prompt the reply answers, as sent.
    pub prompt: String,
    pub model: ModelRef,
    pub runner: String,
    pub child: String,
    pub usage: Option<StepUsage>,
}

/// Why a run ended without a usable reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskError {
    /// Routing or the runner named a time to ask again. Not a failure.
    AccountWait(AccountWait),
    Failed(String),
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccountWait(wait) => write!(f, "waiting on an account: {}", wait.code),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

/// Run `task` once.
pub async fn run<C: RunnerClient + Router>(
    client: &C,
    job: &TaskRun<'_>,
    task: &dyn TaskInput,
) -> Result<TaskReply, TaskError> {
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    let mut tried: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    for attempt in 0..=MAX_FALLBACKS {
        let answer = match client
            .select(routing::dream_select(job.demand, &tried))
            .await
        {
            Ok(answer) => answer,
            Err(error) => {
                // A wait after a failed model would hide the failure that
                // made the fallback necessary.
                if failure.is_none() {
                    if let Some(wait) = AccountWait::of_routing(&error, SendKind::Dream, now_ms()) {
                        return Err(TaskError::AccountWait(wait));
                    }
                }
                return Err(TaskError::Failed(
                    failure.unwrap_or_else(|| error.to_string()),
                ));
            }
        };
        tried.push(answer.route.route_key());
        let report = |outcome, usage: Option<&StepUsage>| {
            client.report(routing::report(&answer.decision_id, outcome, usage))
        };
        // A runner session can only be bound on an answer that names the
        // harness to run it in.
        let Some(harness) = answer.runner.harness.clone() else {
            report(Outcome::Cancelled, None).await;
            failure = Some(format!(
                "routing named no harness on {} for {}",
                answer.runner.module,
                answer.route.route_key()
            ));
            continue;
        };
        let window = Window {
            counter: Counter::for_model(Some(&answer.route.route_key())),
            context_window: answer.context_window,
        };
        let output_tokens = window
            .output_tokens(DREAM_OUTPUT_TOKENS)
            .min(answer.max_output_tokens);
        let Some(prompt) = task.prompt(window, output_tokens) else {
            report(Outcome::Cancelled, None).await;
            failure = Some(format!(
                "the task's input doesn't fit {}",
                answer.route.route_key()
            ));
            continue;
        };
        let model = routing::model_of(&answer);
        let how = Model {
            model: &model,
            decision_id: &answer.decision_id,
            output_tokens,
            system: task.system(),
            deadline,
            continuation: false,
            creates_child: true,
            send: SendKind::Dream,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        };
        let mut usage = None;
        let mut retry = 0;
        let outcome = loop {
            let child = Child {
                session: SessionRef::new(
                    answer.runner.module.clone(),
                    harness.clone(),
                    child_session(job.run_id, attempt, retry),
                ),
                project_root: Some(job.project_root.to_owned()),
            };
            // The child names the send, so a retry after a lost answer finds
            // the run already started instead of starting a second one.
            let send_id = child.session.session.clone();
            match send_and_wait(client, &child, &send_id, &prompt, &how, &mut usage).await {
                Ok(reply) if reply.length_capped => {
                    break Err(format!(
                        "the reply hit its output limit (child {})",
                        child.session.session
                    ))
                }
                Ok(reply) => match task.accepts(&reply.text) {
                    Ok(()) => {
                        break Ok(TaskReply {
                            text: reply.text,
                            prompt,
                            model: model.clone(),
                            runner: answer.runner.module.clone(),
                            child: child.session.session,
                            usage,
                        })
                    }
                    Err(problem) => {
                        break Err(format!(
                            "the reply can't be used: {problem} (child {})",
                            child.session.session
                        ))
                    }
                },
                Err(SummaryError::AccountWait(wait)) => {
                    report(Outcome::Cancelled, usage.as_ref()).await;
                    return Err(TaskError::AccountWait(wait));
                }
                Err(SummaryError::Failed(error)) if retry < MAX_RETRIES && retryable(&error) => {
                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                    tokio::time::sleep(backoff(retry).min(remaining)).await;
                    retry += 1;
                }
                Err(SummaryError::Failed(error)) => {
                    break Err(format!("{error} (child {})", child.session.session))
                }
            }
        };
        match outcome {
            Ok(reply) => {
                report(Outcome::Completed, reply.usage.as_ref()).await;
                return Ok(reply);
            }
            Err(error) => {
                report(Outcome::Failed, usage.as_ref()).await;
                failure = Some(error);
            }
        }
    }
    Err(TaskError::Failed(failure.unwrap_or_default()))
}

/// The child session of a run's `attempt` (one per model) and `retry`.
pub fn child_session(run_id: &str, attempt: usize, retry: usize) -> String {
    format!("{CHILD}:{run_id}:{attempt}.{retry}")
}

#[cfg(test)]
#[path = "run_tests.rs"]
pub(super) mod tests;
