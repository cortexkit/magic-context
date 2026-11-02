//! One summarizer run, off the session's worker: read the messages it covers
//! in full, send them to the summarizer in a child session, check its
//! reply, and return the summaries to store.
//!
//! The run never touches the session's state: its worker keeps answering
//! notices and rides while the model writes, and takes the result as a job
//! of its own when the run ends.

use std::time::Duration;

use ck_contract_draft::read::SessionRef;
use ck_contract_draft::send::{
    Generation, RunResultRequest, RunSettings, RunState, SendAnswer, SendRequest, StopWhen,
};
use ck_contract_draft::setup::ModelRef;

use super::{chunk, fit};
use crate::calibration::DecisionCalibration;
use std::sync::OnceLock;

use regex::Regex;

use super::prompt::{
    build_compartment_agent_prompt, build_historian_repair_prompt, with_content_language_directive,
    CompartmentPromptInputs, ContentLanguageDirectiveOptions, HISTORIAN_SYSTEM_PROMPT,
};
use super::validate::{
    validate_historian_output, StoredCompartmentRange, ValidateOptions, ValidatedChunk,
};
use crate::client::RunnerClient;
use crate::context_db::{StoredCompartment, StoredMemory};
use crate::routing::{self, Router};
use ck_contract_draft::read::StepUsage;
use cortexkit_role_routing::report::Outcome;

/// Flash-class summarizers echo their examples back above this.
const TEMPERATURE: f64 = 0.1;
const MAX_OUTPUT_TOKENS: u64 = 32_000;
/// How long a run may take before it counts as failed.
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// The child session summaries are written in.
pub const CHILD: &str = "magic-context:summary";

/// What a run reads and writes.
#[derive(Clone, Debug)]
pub struct Request {
    pub session: SessionRef,
    /// The first ordinal no summary covers yet.
    pub from: u64,
    /// The first ordinal of the protected tail, which the run leaves alone.
    pub until: u64,
    /// The session's summaries so far, oldest first.
    pub summaries: Vec<StoredCompartment>,
    /// The user's `language`: the summarizer writes its prose in it.
    pub language: Option<String>,
    /// The project's memories, for the summarizer's `<project-memory>`
    /// block, so it leaves out facts already known. Empty with memory off.
    pub memories: Vec<StoredMemory>,
    /// Memory is on: the summarizer may report facts.
    pub memory_enabled: bool,
    /// `memory.auto_promote`: the facts it reports are kept.
    pub auto_promote: bool,
}

/// Transient provider errors retry this many times on the same model.
const MAX_RETRIES: usize = 2;
/// A run reads at most this share of the summarizer's window of messages,
/// within these bounds (`HISTORIAN_CHUNK_PERCENTAGE` in the plugin's
/// `derive-budgets.ts`), before the prompt is fitted to the window.
const CHUNK_SHARE: f64 = 0.25;
const CHUNK_MIN_TOKENS: u64 = 8_000;
const CHUNK_MAX_TOKENS: u64 = 50_000;
/// After the first model routing picks fails, this many others are tried,
/// each excluding the ones before it (the plugin's fallback models).
const MAX_FALLBACKS: usize = 2;

/// The model a summary runs on, as routing picked it.
struct Target {
    model: ModelRef,
    decision_id: String,
    output_tokens: u64,
}

/// Run the summarizer. `Ok(None)` when there was nothing to summarize.
///
/// Routing picks the model, on the session's own runner (spec 1, SR4). As
/// the plugin's historian (`compartment-runner-historian.ts`): a transient
/// provider error retries twice on the same model, after 2 to 3 s and then
/// 6 to 8 s; an invalid reply gets one repair run that sees the validation
/// error and its own reply; and when a model still fails, the next one
/// routing picks without it is tried. Every attempt runs in a child of its
/// own, so the summarizer always sees exactly its system prompt and one user
/// message. Each decision's outcome is reported back to routing.
pub async fn run<C: RunnerClient + Router>(
    client: &C,
    job: &Request,
) -> Result<Option<ValidatedChunk>, String> {
    let entries = read_range(client, job).await?;
    if entries.is_empty() {
        return Ok(None);
    }
    let system = with_content_language_directive(
        HISTORIAN_SYSTEM_PROMPT,
        job.language.as_deref(),
        ContentLanguageDirectiveOptions::default(),
    )
    .into_owned();
    let mut tried: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    for _ in 0..=MAX_FALLBACKS {
        let answer = match client
            .select(routing::summary_select(&job.session.runner, &tried))
            .await
        {
            Ok(answer) => answer,
            // No route left after a failure: the failure is what to report.
            Err(error) => return Err(failure.unwrap_or_else(|| error.to_string())),
        };
        tried.push(answer.route.route_key());
        let window = fit::Window {
            calibration: DecisionCalibration::for_model(Some(&answer.route.route_key())),
            context_window: answer.context_window,
        };
        let target = Target {
            model: routing::model_of(&answer),
            decision_id: answer.decision_id.clone(),
            output_tokens: window
                .output_tokens(MAX_OUTPUT_TOKENS)
                .min(answer.max_output_tokens),
        };
        let mut usage = None;
        let outcome =
            summarize_on(client, job, &system, &entries, window, &target, &mut usage).await;
        let reported = match &outcome {
            Ok(_) => Outcome::Completed,
            // The prompt never went out: this model's window cannot hold it.
            Err(Failure::NotSent(_)) => Outcome::Cancelled,
            Err(Failure::Failed(_)) => Outcome::Failed,
        };
        client
            .report(routing::report(
                &answer.decision_id,
                reported,
                usage.as_ref(),
            ))
            .await;
        match outcome {
            Ok(result) => return Ok(result),
            Err(Failure::NotSent(error) | Failure::Failed(error)) => failure = Some(error),
        }
    }
    Err(failure.unwrap_or_default())
}

/// Why one model did not produce a summary.
enum Failure {
    /// Nothing was sent to the model.
    NotSent(String),
    /// The model was asked and did not give a valid summary.
    Failed(String),
}

/// Summarize on one model: fit the prompt to its window, ask, and repair an
/// invalid reply once. `usage` adds up what every call reported.
async fn summarize_on<C: RunnerClient>(
    client: &C,
    job: &Request,
    system: &str,
    entries: &[ck_contract_draft::read::Entry],
    window: fit::Window,
    target: &Target,
    usage: &mut Option<StepUsage>,
) -> Result<Option<ValidatedChunk>, Failure> {
    let fitted = fit::fit(&fit::Input {
        session_id: &job.session.session,
        chunk_start: job.from,
        last_ordinal: job.until.saturating_sub(1).max(job.from),
        summaries: &job.summaries,
        memories: &job.memories,
        memory_enabled: job.memory_enabled,
        system_prompt: system,
        windows: &[window],
        output_cap: target.output_tokens,
        requested_chunk_tokens: ((window.context_window as f64 * CHUNK_SHARE).round() as u64)
            .clamp(CHUNK_MIN_TOKENS, CHUNK_MAX_TOKENS),
    })
    .map_err(Failure::NotSent)?;
    let Some(chunk) = chunk::build(entries, fitted.chunk_tokens) else {
        return Ok(None);
    };
    let prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
        seed_examples: &fitted.seed_examples,
        session_references: &fitted.session_references,
        project_memory: &fitted.project_memory,
        input_source: &chunk.input,
        memory_enabled: job.memory_enabled,
        user_observations_requested: false,
        extraction_free: false,
    });
    // The model is part of the child's name, so a fallback model never
    // continues another model's conversation.
    let range = format!(
        "{}-{}:{}",
        chunk.validation.start_index, chunk.validation.end_index, target.decision_id
    );
    let prior: Vec<StoredCompartmentRange> = job
        .summaries
        .iter()
        .map(|summary| StoredCompartmentRange {
            start_message: summary.start_message as u64,
            end_message: summary.end_message as u64,
        })
        .collect();
    let options = || ValidateOptions {
        sequence_offset: job
            .summaries
            .last()
            .map_or(0, |summary| summary.sequence as u64 + 1),
        memory_enabled: job.memory_enabled,
        auto_promote: job.auto_promote,
        ..ValidateOptions::default()
    };
    let first = attempt(
        client,
        job,
        &format!("{range}:first"),
        &prompt,
        system,
        target,
        usage,
    )
    .await
    .map_err(Failure::Failed)?;
    let error = match validate_historian_output(&first, &chunk.validation, &prior, options()) {
        Ok(validated) => return Ok(Some(validated)),
        Err(error) => error.message,
    };
    let repair_prompt =
        build_historian_repair_prompt(&prompt, &first, &error, job.language.as_deref());
    let repaired = attempt(
        client,
        job,
        &format!("{range}:repair"),
        &repair_prompt,
        system,
        target,
        usage,
    )
    .await
    .map_err(Failure::Failed)?;
    validate_historian_output(&repaired, &chunk.validation, &prior, options())
        .map(Some)
        .map_err(|error| Failure::Failed(format!("invalid after repair: {}", error.message)))
}

/// One summarizer call in the child `label` names, with retries for
/// transient provider errors. Returns the reply's text.
async fn attempt<C: RunnerClient>(
    client: &C,
    job: &Request,
    label: &str,
    prompt: &str,
    system: &str,
    target: &Target,
    usage: &mut Option<StepUsage>,
) -> Result<String, String> {
    let mut retry = 0;
    loop {
        let child = if retry == 0 {
            format!("{CHILD}:{label}")
        } else {
            format!("{CHILD}:{label}:retry{retry}")
        };
        match call(client, job, &child, prompt, system, target, usage).await {
            Ok(text) => return Ok(text),
            Err(error) if retry < MAX_RETRIES && is_transient(&error) => {
                tokio::time::sleep(backoff(retry)).await;
                retry += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Send one run and wait for its reply.
async fn call<C: RunnerClient>(
    client: &C,
    job: &Request,
    child: &str,
    prompt: &str,
    system: &str,
    target: &Target,
    usage: &mut Option<StepUsage>,
) -> Result<String, String> {
    let request = SendRequest {
        // A retry after a lost answer finds the run already started.
        send_id: child.to_owned(),
        prompt: prompt.to_owned(),
        template: None,
        delivery: Vec::new(),
        run: Some(RunSettings {
            child: child.to_owned(),
            system: system.to_owned(),
            model: target.model.clone(),
            route_decision_id: Some(target.decision_id.clone()),
            generation: Generation {
                max_output_tokens: target.output_tokens,
                temperature: Some(TEMPERATURE),
            },
            stop_when: StopWhen { max_steps: 1 },
        }),
    };
    let run_id = match client
        .send(&job.session, request)
        .await
        .map_err(|error| format!("session.send: {error:?}"))?
    {
        SendAnswer::Active { run_id } => run_id,
        SendAnswer::Queued => return Err("the runner queued the run as text".into()),
    };
    let result = wait_for(client, &job.session, &run_id).await?;
    if let Some(reported) = &result.usage {
        *usage = Some(add_usage(usage.take(), reported));
    }
    match result.state {
        RunState::Finished => {}
        RunState::Failed => {
            return Err(format!(
                "the run failed: {}",
                result.error.unwrap_or_default()
            ))
        }
        RunState::Active => unreachable!("wait_for returns a finished run"),
    }
    // A reply cut off at its output limit is incomplete even when it parses.
    if result.finish.as_deref() == Some("length") {
        return Err("the reply hit its output limit".into());
    }
    Ok(result.text.unwrap_or_default())
}

/// The usage of several calls on one decision, added up. A count either
/// call left out stays as the other reported it.
fn add_usage(total: Option<StepUsage>, more: &StepUsage) -> StepUsage {
    let Some(total) = total else {
        return *more;
    };
    let sum = |a: Option<u64>, b: Option<u64>| match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    StepUsage {
        prompt_tokens: sum(total.prompt_tokens, more.prompt_tokens),
        cache_read_tokens: sum(total.cache_read_tokens, more.cache_read_tokens),
        cache_write_tokens: sum(total.cache_write_tokens, more.cache_write_tokens),
        output_tokens: sum(total.output_tokens, more.output_tokens),
        reasoning_tokens: sum(total.reasoning_tokens, more.reasoning_tokens),
    }
}

/// Whether a failed call is worth retrying on the same model, as the plugin
/// decides (`historian-transient-error.ts`): provider errors arrive as free
/// text, so each keyword must stand alone ("auth" must not match "author",
/// 500 must not match "250000"), and request or authorization errors never
/// retry.
pub fn is_transient(error: &str) -> bool {
    static NON_TRANSIENT: OnceLock<Regex> = OnceLock::new();
    static TRANSIENT: OnceLock<Regex> = OnceLock::new();
    let lower = error.to_lowercase();
    let non_transient = NON_TRANSIENT.get_or_init(|| {
        Regex::new(r"(?:^|[^a-z])(?:invalid[ _]request|bad[ _]request|unauthori[sz]ed|forbidden|authentication|authenticate|authorization|o?auth)(?:[^a-z]|$)|(?:^| )400(?:[^0-9]|$)").unwrap()
    });
    let transient = TRANSIENT.get_or_init(|| {
        Regex::new(r"(?:^|[^0-9])(?:429|500|502|503)(?:[^0-9]|$)|rate[ _]limit|timeout|econnreset|etimedout|overloaded").unwrap()
    });
    !non_transient.is_match(&lower) && transient.is_match(&lower)
}

/// The wait before retry `retry` (0 or 1): 2 to 3 s, then 6 to 8 s, with
/// jitter so parallel sessions do not retry together.
fn backoff(retry: usize) -> Duration {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::from(elapsed.subsec_nanos()));
    let (base, spread) = if retry == 0 {
        (2_000, 1_001)
    } else {
        (6_000, 2_001)
    };
    Duration::from_millis(base + jitter % spread)
}

/// The messages from `job.from` up to `job.until`, in full.
async fn read_range<C: RunnerClient>(
    client: &C,
    job: &Request,
) -> Result<Vec<ck_contract_draft::read::Entry>, String> {
    crate::reads::full_range(client, &job.session, job.from, job.until, |_| false).await
}

async fn wait_for<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    run_id: &str,
) -> Result<ck_contract_draft::send::RunResult, String> {
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    loop {
        let request = RunResultRequest {
            run_id: run_id.to_owned(),
        };
        let result = client
            .run_result(session, request)
            .await
            .map_err(|error| format!("run.result: {error:?}"))?;
        if result.state != RunState::Active {
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("the run did not finish in time".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::is_transient;

    // The cases the plugin's classifier is written for.
    #[test]
    fn transient_errors_retry_and_request_errors_never_do() {
        for error in [
            "429 Too Many Requests",
            "HTTP 503: overloaded",
            "rate_limit_error",
            "request timeout",
            "ECONNRESET",
        ] {
            assert!(is_transient(error), "{error}");
        }
        for error in [
            "400 Bad Request",
            "invalid_request: prompt is too long: 250000 tokens",
            "401 Unauthorized",
            "OAuth token expired, rate limit",
            "the model could not parse the author list",
        ] {
            assert!(!is_transient(error), "{error}");
        }
    }
}
