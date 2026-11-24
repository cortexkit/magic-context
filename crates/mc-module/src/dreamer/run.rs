//! One dreamer task run on a model.
//!
//! Routing picks a model for the task's kind (`magic-context.dream.<kind>`)
//! on whatever runner it chooses. The run happens in a child session of
//! Magic Context's own on that runner, in the project's folder, the same way
//! a summary run does ([`crate::summary::run`]): one message with the task's
//! input under the task's system prompt, no tools, one model step, and one
//! reply that the task reads.
//!
//! A task that reads the project's code gets a tool provider's read-only
//! tools instead (the engine chose the provider, [`super::plan::select_reader`]):
//! its child is created with a fetch plan ([`super::plan`]) on a runner that
//! takes plans, and its run may take as many steps as the task's kind
//! allows. A runner without plans can't run such a task, so its model counts
//! as unusable and the next one is tried. A task with a step cap
//! ([`TaskInput::step_cap`]) runs at most that many steps; a run that
//! reaches it is sent the task's finalize message ([`StepCap::finalize`]) in
//! the same child, and that reply is the
//! run's answer. When it can't be used, the run is skipped
//! ([`TaskError::Skipped`]) instead of trying another model.
//!
//! The task's input is built after the model is chosen, so it can fit the
//! model's window. A transient provider error retries twice on the same
//! model in a new child; a model that still fails, or whose reply the task
//! can't use, is replaced by the next one routing picks without it, at most
//! twice. Every routing decision's outcome is reported back to routing. An
//! account wait or routing's full capacity (`concurrency_full`), from
//! routing or the runner, ends the run as a wait: nothing is counted against
//! the task, and the engine's schedule tries again when the wait ends.

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
    backoff, now_ms, retryable, send_and_wait_stepped, Ended, Model, PlanRun, Reply, SummaryError,
    MAX_RETRIES,
};

/// How long one task run may take, retries and fallbacks included.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// After the first model routing picks fails, this many others are tried.
const MAX_FALLBACKS: usize = 2;
/// What a dreamer child's session id starts with. The engine's run id
/// follows, then the attempt, so each attempt has a child of its own and a
/// runner's owner can find the run in their records.
pub const CHILD: &str = "mc-dream";
/// The most model steps one child run of a task with a step cap takes
/// ([`TaskInput::step_cap`]). Every step resends each tool result read so
/// far, so a run costs roughly the square of its steps: a verify batch that
/// ran 32 steps ended on a request about 24 times its first.
pub const STEP_CAP: u64 = 12;
/// The model steps the run that answers a finalize message may take: one,
/// so the child answers from what it already read instead of reading on.
const FINALIZE_STEPS: u64 = 1;

/// How a task's child runs are capped ([`TaskInput::step_cap`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepCap {
    /// The most model steps one child run takes ([`STEP_CAP`]).
    pub steps: u64,
    /// What a child whose run reached `steps` is sent, once, in the same
    /// conversation. Its reply is read as the run's answer.
    pub finalize: &'static str,
}

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
    /// How one child run of the task is capped: the most model steps it
    /// takes before it is sent the finalize message, whose reply is read as
    /// its answer. `None` for a task bounded only by its demand's
    /// `max_steps`, where a run that reaches the bound fails its model like
    /// any reply the task can't use. Only a task that reads code takes more
    /// than one step.
    fn step_cap(&self) -> Option<StepCap> {
        None
    }
}

/// One task run's request.
pub struct TaskRun<'a> {
    pub demand: &'static DreamDemand,
    /// The engine's id for this run; it names the run's child sessions.
    pub run_id: &'a str,
    /// The folder the child runs in: the project's root, where the runner
    /// creates it under Magic Context's scope for that folder.
    pub project_root: &'a str,
    /// The tool provider whose `reader` preset a code-reading child reads
    /// with; `None` for a task that reads no code.
    pub reader: Option<&'a str>,
    /// Tokens the occurrence can still spend before starting this batch.
    pub remaining_tokens: u64,
    /// Where the run's children are attributed, each right before the send
    /// that creates it ([`crate::attribution`]); `None` attributes none.
    pub attribution: Option<crate::attribution::Attribution<'a>>,
}

/// A run that got a reply the task accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskReply {
    pub text: String,
    pub model: ModelRef,
    pub runner: String,
    pub child: String,
    pub usage: Option<StepUsage>,
    /// The model steps the child's run took, when the runner reported them.
    /// A run that took more than one step made at least one tool call.
    pub steps: Option<u64>,
}

/// Why a run ended without a usable reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskError {
    /// Routing or the runner named a time to ask again. Not a failure.
    AccountWait(AccountWait, Option<Box<StepUsage>>),
    /// A send spent the balance, leaving none for a retry, fallback or finalize.
    BudgetStopped(Option<StepUsage>),
    Failed {
        error: String,
        usage: Option<StepUsage>,
        /// A child returned an unusable answer and no fallback succeeded.
        /// Failures to start or reach a model don't count as answers.
        unusable_reply: bool,
        /// Every route that ran explicitly rejected this particular request.
        request_specific: bool,
    },
    /// The child's run reached its step cap ([`TaskInput::step_cap`]) and
    /// its answer to the finalize message can't be used. No other model is tried:
    /// the batch counts as skipped, and the run goes on to its next batch.
    Skipped(Box<Skipped>),
}

/// A batch whose child reached its step cap without an answer the task can
/// use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped {
    /// Why the answer can't be used, naming the child.
    pub reason: String,
    /// The run as it ended: its model, runner and child, the tokens of both
    /// sends, every step, and the unusable answer as its text.
    pub reply: TaskReply,
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccountWait(wait, _) => write!(f, "waiting on an account: {}", wait.code),
            Self::BudgetStopped(_) => f.write_str("the task's token budget is spent"),
            Self::Failed { error, .. } => f.write_str(error),
            Self::Skipped(skipped) => write!(f, "skipped at the step cap: {}", skipped.reason),
        }
    }
}

fn budget_spent(remaining: u64, usage: Option<StepUsage>) -> bool {
    let (input, output) = usage_tokens(usage.as_ref());
    input.saturating_add(output) >= remaining
}

pub(super) fn usage_tokens(usage: Option<&StepUsage>) -> (u64, u64) {
    // Prompt tokens include uncached input, cache reads and cache writes.
    usage.map_or((0, 0), |usage| {
        (
            usage.prompt_tokens.unwrap_or(0),
            usage.output_tokens.unwrap_or(0),
        )
    })
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
    let mut paid_failure: Option<String> = None;
    let mut unusable_reply = false;
    let mut total = None;
    let mut only_request_failures = true;
    for attempt in 0..=MAX_FALLBACKS {
        if budget_spent(job.remaining_tokens, total) {
            return Err(TaskError::BudgetStopped(total));
        }
        let answer = match client
            .select(routing::dream_select(job.demand, &tried))
            .await
        {
            Ok(answer) => answer,
            Err(error) => {
                // A wait after a failed model would hide the failure that
                // made the fallback necessary.
                if paid_failure.is_none() && failure.is_none() {
                    if let Some(wait) = AccountWait::of_routing(&error, SendKind::Dream, now_ms()) {
                        return Err(TaskError::AccountWait(wait, total.map(Box::new)));
                    }
                }
                return Err(TaskError::Failed {
                    request_specific: paid_failure.is_some()
                        && only_request_failures
                        && error.code == "no_route",
                    error: paid_failure
                        .or(failure)
                        .unwrap_or_else(|| error.to_string()),
                    usage: total,
                    unusable_reply,
                });
            }
        };
        tried.push(answer.route.route_key());
        let report = |outcome, usage: Option<&StepUsage>| {
            client.report(routing::report(&answer.decision_id, outcome, usage))
        };
        // A runner session can only be bound on an answer that names the
        // harness to run it in.
        let Some(harness) = answer.runner.harness.clone() else {
            only_request_failures = false;
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
            only_request_failures = false;
            report(Outcome::Cancelled, None).await;
            failure = Some(format!(
                "the task's input doesn't fit {}",
                answer.route.route_key()
            ));
            continue;
        };
        let model = routing::model_of(&answer);
        let plan = if job.demand.reads_code {
            let Some(reader) = job.reader else {
                report(Outcome::Cancelled, None).await;
                return Err(TaskError::Failed {
                    error: "the task reads code, and no tool provider was chosen to read it with"
                        .into(),
                    usage: total,
                    unusable_reply,
                    request_specific: false,
                });
            };
            let child = Child {
                session: SessionRef::new(
                    answer.runner.module.clone(),
                    harness.clone(),
                    child_session(job.run_id, attempt, 0),
                ),
                project_root: Some(job.project_root.to_owned()),
            };
            match reader_plan(client, &child, reader, task.system()).await {
                Ok(plan) => Some(PlanRun {
                    plan,
                    max_steps: task.step_cap().map_or(job.demand.max_steps, |cap| {
                        cap.steps.min(job.demand.max_steps)
                    }),
                }),
                Err(ReaderPlan::Runner(problem)) => {
                    only_request_failures = false;
                    report(Outcome::Cancelled, None).await;
                    failure = Some(problem);
                    continue;
                }
                // The tools are missing whichever model runs: no other
                // model would get further.
                Err(ReaderPlan::Tools(problem)) => {
                    report(Outcome::Cancelled, None).await;
                    return Err(TaskError::Failed {
                        error: problem,
                        usage: total,
                        unusable_reply,
                        request_specific: false,
                    });
                }
            }
        } else {
            None
        };
        let how = Model {
            model: &model,
            decision_id: &answer.decision_id,
            output_tokens,
            system: task.system(),
            deadline,
            continuation: false,
            creates_child: true,
            // A dreamer child's transcript is read when tuning the task's
            // prompt, so it is kept whatever `keep_subagents` says.
            keep_child: true,
            send: SendKind::Dream,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
            plan: plan.as_ref(),
            attribution: job.attribution,
        };
        let mut usage = None;
        // Routing wants just this decision's usage. The task's budget and
        // journal must also count every earlier route that was tried.
        let batch_usage = |usage: Option<StepUsage>| {
            usage.map_or(total, |more| {
                Some(crate::summary::run::add_usage(total, &more))
            })
        };
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
            let sent = match (
                send_and_wait_stepped(client, &child, &send_id, &prompt, &how, &mut usage).await,
                task.step_cap(),
            ) {
                // A run that reached the task's step cap answers once more in
                // the same child, and no other model is tried after it.
                (Ok(ended), Some(cap)) if ended.step_capped => {
                    let used = batch_usage(usage);
                    if budget_spent(job.remaining_tokens, used) {
                        report(Outcome::Failed, usage.as_ref()).await;
                        return Err(TaskError::BudgetStopped(used));
                    }
                    let capped_steps = ended.reply.steps;
                    let (last, usable) = match finalize(
                        client,
                        task,
                        cap.finalize,
                        &child,
                        &send_id,
                        &how,
                        &mut usage,
                    )
                    .await
                    {
                        Ok(answered) => answered,
                        Err(wait) => {
                            report(Outcome::Cancelled, usage.as_ref()).await;
                            return Err(waiting(
                                wait,
                                paid_failure,
                                batch_usage(usage),
                                unusable_reply,
                            ));
                        }
                    };
                    let reply = TaskReply {
                        text: last.text,
                        model: model.clone(),
                        runner: answer.runner.module.clone(),
                        child: child.session.session.clone(),
                        usage: batch_usage(usage),
                        steps: capped_steps
                            .zip(last.steps)
                            .map(|(capped, last)| capped + last),
                    };
                    return match usable {
                        Ok(()) => {
                            report(Outcome::Completed, usage.as_ref()).await;
                            Ok(reply)
                        }
                        Err(problem) => {
                            report(Outcome::Failed, usage.as_ref()).await;
                            Err(TaskError::Skipped(Box::new(Skipped {
                                reason: format!(
                                    "the run reached its step cap, and its answer to the request to stop reading can't be used: {problem} (child {})",
                                    child.session.session
                                ),
                                reply,
                            })))
                        }
                    };
                }
                // Any other task takes a run stopped at its step limit as
                // the failure it always was.
                (Ok(ended), _) => ended.completed().map_err(SummaryError::from),
                (Err(error), _) => Err(error),
            };
            match sent {
                Ok(reply) if reply.length_capped => {
                    unusable_reply = true;
                    break Err(format!(
                        "the reply hit its output limit (child {})",
                        child.session.session
                    ));
                }
                Ok(reply) => match task.accepts(&reply.text) {
                    Ok(()) => {
                        break Ok(TaskReply {
                            text: reply.text,
                            model: model.clone(),
                            runner: answer.runner.module.clone(),
                            child: child.session.session,
                            usage,
                            steps: reply.steps,
                        })
                    }
                    Err(problem) => {
                        unusable_reply = true;
                        break Err(format!(
                            "the reply can't be used: {problem} (child {})",
                            child.session.session
                        ));
                    }
                },
                Err(SummaryError::AccountWait(wait) | SummaryError::NeverRan(wait)) => {
                    report(Outcome::Cancelled, usage.as_ref()).await;
                    return Err(waiting(
                        wait,
                        paid_failure,
                        batch_usage(usage),
                        unusable_reply,
                    ));
                }
                Err(SummaryError::Failed(error)) if retry < MAX_RETRIES && retryable(&error) => {
                    let used = batch_usage(usage);
                    if budget_spent(job.remaining_tokens, used) {
                        report(Outcome::Failed, usage.as_ref()).await;
                        return Err(TaskError::BudgetStopped(used));
                    }
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
            Ok(mut reply) => {
                report(Outcome::Completed, reply.usage.as_ref()).await;
                reply.usage = batch_usage(reply.usage);
                return Ok(reply);
            }
            Err(error) => {
                only_request_failures &= request_refusal(&error);
                report(Outcome::Failed, usage.as_ref()).await;
                total = batch_usage(usage);
                paid_failure = Some(error);
            }
        }
    }
    Err(TaskError::Failed {
        request_specific: paid_failure.is_some() && only_request_failures,
        error: paid_failure.or(failure).unwrap_or_default(),
        usage: total,
        unusable_reply,
    })
}

/// Only explicit request-level provider errors may move a memory back in
/// the queue. An unknown error, including a missing provider, must stop the
/// run instead of making the next batch pay for the same failure.
fn request_refusal(error: &str) -> bool {
    error
        .strip_prefix("the run ended error: ")
        .and_then(|message| message.split_once(':'))
        .is_some_and(|(code, _)| {
            matches!(
                code.trim(),
                "invalid_request_error"
                    | "invalid_request"
                    | "context_length_exceeded"
                    | "content_policy_violation"
                    | "request_too_large"
                    | "safety_refusal"
            )
        })
}

fn waiting(
    wait: AccountWait,
    failed: Option<String>,
    usage: Option<StepUsage>,
    unusable_reply: bool,
) -> TaskError {
    failed.map_or_else(
        || TaskError::AccountWait(wait, usage.map(Box::new)),
        |error| TaskError::Failed {
            error,
            usage,
            unusable_reply,
            request_specific: false,
        },
    )
}

/// Send `message`, the task's finalize message, to `child`, whose run under
/// `how` stopped at its step cap, and wait for the run that answers it: the
/// same conversation and plan, with [`FINALIZE_STEPS`] steps. Its reply, and
/// whether `task` can use it; a failed send counts as an answer it can't
/// use. An account wait or a send that never ran is returned as the wait.
async fn finalize<C: RunnerClient>(
    client: &C,
    task: &dyn TaskInput,
    message: &str,
    child: &Child,
    send_id: &str,
    how: &Model<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<(Reply, Result<(), String>), AccountWait> {
    let plan = how.plan.map(|plan| PlanRun {
        plan: plan.plan.clone(),
        max_steps: FINALIZE_STEPS,
    });
    let how = Model {
        model: how.model,
        decision_id: how.decision_id,
        output_tokens: how.output_tokens,
        system: how.system,
        deadline: how.deadline,
        // The child exists, with its plan; a later send carries neither
        // the plan nor the creating send's policies.
        continuation: true,
        creates_child: false,
        keep_child: how.keep_child,
        send: how.send,
        cache_ttl: how.cache_ttl,
        plan: plan.as_ref(),
        attribution: how.attribution,
    };
    let send_id = format!("{send_id}:finalize");
    match send_and_wait_stepped(client, child, &send_id, message, &how, usage).await {
        Ok(ended) if ended.step_capped => Ok((
            ended.reply,
            Err("it asked for another read instead of answering".into()),
        )),
        Ok(Ended { reply, .. }) if reply.length_capped => {
            Ok((reply, Err("the reply hit its output limit".into())))
        }
        Ok(Ended { reply, .. }) => {
            let usable = task.accepts(&reply.text);
            Ok((reply, usable))
        }
        Err(SummaryError::AccountWait(wait) | SummaryError::NeverRan(wait)) => Err(wait),
        Err(SummaryError::Failed(error)) => Ok((
            Reply {
                text: String::new(),
                length_capped: false,
                steps: None,
            },
            Err(format!("the send failed: {error}")),
        )),
    }
}

/// Why a code-reading child has no plan.
enum ReaderPlan {
    /// This model's runner can't take one: try another model.
    Runner(String),
    /// The code-reading tools themselves are unavailable.
    Tools(String),
}

/// The plan a code-reading child of `child`'s runner is created with:
/// `reader`'s reader tools in the child's folder, and `system` as its text.
async fn reader_plan<C: RunnerClient>(
    client: &C,
    child: &Child,
    reader: &str,
    system: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, ReaderPlan> {
    if !client.child_plans(child).await {
        return Err(ReaderPlan::Runner(format!(
            "{} takes no fetch plan, so it can't give the task tools",
            child.session.runner
        )));
    }
    let answer = client
        .tool_catalog(child, reader, Some(super::plan::reader_preset()))
        .await
        .map_err(|error| ReaderPlan::Tools(format!("the code-reading tools: {error}")))?;
    let tools = super::plan::reader_tools(reader, &answer).map_err(ReaderPlan::Tools)?;
    match super::plan::plan(&tools, reader, crate::MODULE_ID, system).map_err(ReaderPlan::Tools)? {
        serde_json::Value::Object(plan) => Ok(plan),
        _ => unreachable!("a plan is an object"),
    }
}

/// The child session of a run's `attempt` (one per model) and `retry`.
pub fn child_session(run_id: &str, attempt: usize, retry: usize) -> String {
    format!("{CHILD}:{run_id}:{attempt}.{retry}")
}

#[cfg(test)]
#[path = "run_tests.rs"]
pub(super) mod tests;
