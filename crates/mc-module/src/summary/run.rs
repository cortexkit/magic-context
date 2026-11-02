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

use super::chunk;
use super::prompt::{
    build_compartment_agent_prompt, build_reference_blocks_from_stored, CompartmentPromptInputs,
    HISTORIAN_SYSTEM_PROMPT,
};
use super::validate::{
    validate_historian_output, StoredCompartmentRange, ValidateOptions, ValidatedChunk,
};
use crate::client::RunnerClient;
use crate::context_db::StoredCompartment;

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
    pub model: ModelRef,
    /// How many tokens of messages one run reads at most.
    pub chunk_tokens: u64,
}

/// Run the summarizer. `Ok(None)` when there was nothing to summarize.
pub async fn run<C: RunnerClient>(
    client: &C,
    job: &Request,
) -> Result<Option<ValidatedChunk>, String> {
    let entries = read_range(client, job).await?;
    let Some(chunk) = chunk::build(&entries, job.chunk_tokens) else {
        return Ok(None);
    };
    let references = build_reference_blocks_from_stored(
        &job.session.session,
        chunk.validation.start_index as i64,
        &job.summaries,
    );
    let prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
        seed_examples: &references.seed_examples,
        session_references: &references.session_references,
        project_memory: "",
        input_source: &chunk.input,
        memory_enabled: false,
        user_observations_requested: false,
        extraction_free: false,
    });
    let request = SendRequest {
        // A retry after a lost answer finds the run already started.
        send_id: format!(
            "{CHILD}:{}-{}",
            chunk.validation.start_index, chunk.validation.end_index
        ),
        prompt,
        template: None,
        delivery: Vec::new(),
        run: Some(RunSettings {
            child: CHILD.into(),
            system: HISTORIAN_SYSTEM_PROMPT.into(),
            model: job.model.clone(),
            generation: Generation {
                max_output_tokens: MAX_OUTPUT_TOKENS,
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
    let text = result.text.unwrap_or_default();
    let prior: Vec<StoredCompartmentRange> = job
        .summaries
        .iter()
        .map(|summary| StoredCompartmentRange {
            start_message: summary.start_message as u64,
            end_message: summary.end_message as u64,
        })
        .collect();
    let options = ValidateOptions {
        sequence_offset: job
            .summaries
            .last()
            .map_or(0, |summary| summary.sequence as u64 + 1),
        memory_enabled: false,
        auto_promote: false,
        ..ValidateOptions::default()
    };
    validate_historian_output(&text, &chunk.validation, &prior, options)
        .map(Some)
        .map_err(|error| error.message)
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
