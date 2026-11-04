//! One summarizer run, off the session's worker: read the messages it covers
//! in full, send them to the summarizer in a child session, check its
//! reply, and return the summaries to store.
//!
//! The run never touches the session's state: its worker keeps answering
//! notices and rides while the model writes, and takes the result as a job
//! of its own when the run ends.

use std::time::Duration;

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_llm_runner::finish::Finish;
use cortexkit_role_llm_runner::run::{states, RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::{json, Map, Value};

use super::two_pass::turn_one::{self, Lane};
use super::{chunk, fit};
use std::sync::OnceLock;

use regex::Regex;

use super::prompt::{
    build_compartment_agent_prompt, build_historian_repair_prompt, with_content_language_directive,
    CompartmentPromptInputs, ContentLanguageDirectiveOptions,
};
use super::validate::{
    validate_historian_output, StoredCompartmentRange, ValidateOptions, ValidatedChunk,
};
use crate::client::{Child, RunnerClient};
use crate::context_db::{ContextDb, StoredCompartment, StoredMemory};
use crate::routing::{self, Router};
use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_routing::report::Outcome;

/// Flash-class summarizers echo their examples back above this.
const TEMPERATURE: f64 = 0.1;
const MAX_OUTPUT_TOKENS: u64 = 32_000;
/// How long a run may take before it counts as failed.
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// What a child session's id adds to its parent's: each summarizer attempt
/// runs in a child of its own, `<parent session>:mc-summary:<attempt>`, so
/// the summarizer sees exactly its system prompt and one user message, and a
/// child never continues another attempt's conversation. The two-pass
/// historian's second turn is the one exception: it continues the child its
/// first turn answered in.
pub const CHILD: &str = "mc-summary";

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
    /// The session's project folder, where the runner creates the
    /// summarizer's child sessions.
    pub project_root: Option<String>,
    /// The session's project id. With it, the run keeps the plugin's send
    /// and publication records, and the two-pass historian can run.
    pub project: Option<String>,
    /// The user's `language`: the summarizer writes its prose in it.
    pub language: Option<String>,
    /// The project's memories, for the summarizer's `<project-memory>`
    /// block, so it leaves out facts already known. Empty with memory off.
    pub memories: Vec<StoredMemory>,
    /// Memory is on: the summarizer may report facts.
    pub memory_enabled: bool,
    /// `memory.auto_promote`: the facts it reports are kept.
    pub auto_promote: bool,
    /// The run started in the force band. Its reply keeps every summary,
    /// the last one included, as the plugin's emergency recovery does: the
    /// session needs the relief now.
    pub emergency: bool,
    /// `historian.turn_two` is on and the editor pass is off: the two-pass
    /// historian runs unless its failure budget for this chunk is spent.
    pub two_pass: bool,
}

/// What a run produced.
#[derive(Clone, Debug)]
pub struct Summarized {
    pub validated: ValidatedChunk,
    /// The first turn's send and publication record, stored with the
    /// summaries. `None` without a project or store.
    pub publication: Option<turn_one::Publication>,
    /// On the two-pass lane: the conversation the second turn continues.
    pub continuation: Option<Continuation>,
}

/// The child conversation a first turn answered in, and the model it ran on,
/// which the second turn and its checks reuse.
#[derive(Clone, Debug)]
pub struct Continuation {
    pub child: Child,
    pub model: ModelRef,
    pub decision_id: String,
    pub output_tokens: u64,
    /// The user's `language`, which the system prompt both turns run under
    /// carries.
    pub language: Option<String>,
    /// The publication whose candidates the second turn sends first.
    pub publication_id: String,
}

/// The two-pass historian's system prompt with `language`'s directive.
pub(crate) fn two_pass_system(language: Option<&str>) -> String {
    with_content_language_directive(
        turn_one::SYSTEM,
        language,
        ContentLanguageDirectiveOptions::default(),
    )
    .into_owned()
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

impl Target {
    fn model_json(&self) -> Value {
        json!({
            "provider": self.model.provider,
            "model": self.model.model,
            "variant": self.model.variant,
            "decision": self.decision_id,
        })
    }
}

/// Run the summarizer. `Ok(None)` when there was nothing to summarize.
///
/// Routing picks the model, on the session's own runner (compaction contract SR4). As
/// the plugin's historian (`compartment-runner-historian.ts`): a transient
/// provider error retries twice on the same model, after 2 to 3 s and then
/// 6 to 8 s; an invalid reply gets one repair run that sees the validation
/// error and its own reply; and when a model still fails, the next one
/// routing picks without it is tried. Every attempt runs in a child of its
/// own, so the summarizer always sees exactly its system prompt and one user
/// message. Each decision's outcome is reported back to routing.
///
/// With [`Request::two_pass`], a project and a store, each model first runs
/// the two-pass historian's first turn ([`turn_one`]) unless that chunk's
/// failure budget for the model is spent: its facts carry source anchors and
/// become candidates, and its reply is a JSON envelope. An invalid first
/// turn gets no repair and no fallback: it counts against the budget, and
/// the run ends.
pub async fn run<C: RunnerClient + Router>(
    client: &C,
    db: Option<&ContextDb>,
    job: &Request,
) -> Result<Option<Summarized>, String> {
    let entries = read_range(client, job).await?;
    if entries.is_empty() {
        return Ok(None);
    }
    let language = |prompt: &str| {
        with_content_language_directive(
            prompt,
            job.language.as_deref(),
            ContentLanguageDirectiveOptions::default(),
        )
        .into_owned()
    };
    let one_pass = language(super::prompt::historian_system_prompt());
    let two_pass = two_pass_system(job.language.as_deref());
    let carrier = format!("ck-mc:{}", job.session.runner);
    let mut tried: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    // One deadline for the whole run, retries, repair and fallbacks
    // included.
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    for fallback in 0..=MAX_FALLBACKS {
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
            counter: crate::count::Counter::for_model(Some(&answer.route.route_key())),
            context_window: answer.context_window,
        };
        let target = Target {
            model: routing::model_of(&answer),
            decision_id: answer.decision_id.clone(),
            output_tokens: window
                .output_tokens(MAX_OUTPUT_TOKENS)
                .min(answer.max_output_tokens),
        };
        let records = match (db, job.project.as_deref()) {
            (Some(db), Some(project)) => Some(Records {
                db,
                project,
                carrier: &carrier,
                counter: turn_one::CounterKey::new(
                    &job.session.session,
                    &entries[0].mid,
                    &carrier,
                    &target.model_json(),
                    &two_pass,
                ),
            }),
            _ => None,
        };
        let lane = match &records {
            Some(records) if job.two_pass && records.budget_left() => Lane::Enabled,
            _ => Lane::Dormant,
        };
        let mut usage = None;
        // Only the first model gets a repair run, as in the plugin; a
        // fallback's invalid reply moves on to the next model.
        let call = Call {
            target: &target,
            window,
            repair: fallback == 0 && lane == Lane::Dormant,
            deadline,
            lane,
            system: if lane == Lane::Enabled {
                &two_pass
            } else {
                &one_pass
            },
        };
        let outcome =
            summarize_on(client, job, &entries, &call, records.as_ref(), &mut usage).await;
        let reported = match &outcome {
            Ok(_) => Outcome::Completed,
            // The prompt never went out: this model's window cannot hold it.
            Err(Failure::NotSent(_)) => Outcome::Cancelled,
            Err(Failure::Failed(_) | Failure::Final(_)) => Outcome::Failed,
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
            Err(Failure::Final(error)) => return Err(error),
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
    /// The two-pass historian's first turn gave no valid reply: the run ends
    /// without trying another model.
    Final(String),
}

/// How one model is asked.
struct Call<'a> {
    target: &'a Target,
    window: fit::Window,
    /// An invalid reply gets one repair run.
    repair: bool,
    deadline: tokio::time::Instant,
    lane: Lane,
    /// The system prompt, language directive included.
    system: &'a str,
}

/// Where a run keeps the plugin's send and publication records.
struct Records<'a> {
    db: &'a ContextDb,
    project: &'a str,
    carrier: &'a str,
    /// The two-pass lane's failure budget key for this model and chunk.
    counter: turn_one::CounterKey,
}

impl Records<'_> {
    /// The two-pass lane's failure budget for this chunk and model is not
    /// spent. A store that can't be read leaves the lane off.
    fn budget_left(&self) -> bool {
        self.db
            .with_connection(|conn| turn_one::failure_count(conn, self.project, &self.counter))
            .is_ok_and(|failures| failures < turn_one::FAILURE_BUDGET)
    }
}

/// The marker an oversized chunk ends with, as in the plugin.
const TRUNCATION_MARKER: &str =
    "\n[… tokens truncated by Magic Context to fit the historian window …]";

/// `text` cut to fit `budget` tokens with [`TRUNCATION_MARKER`] after it, as
/// the plugin's `truncateHistorianInputIfNeeded`: a single message larger
/// than the whole budget is summarized from its start.
fn truncate_to(text: &str, budget: u64, counter: crate::count::Counter) -> String {
    let tokens = |text: &str| counter.count(text);
    if tokens(text) <= budget {
        return text.to_owned();
    }
    let boundaries: Vec<usize> = text
        .char_indices()
        .map(|(at, _)| at)
        .chain([text.len()])
        .collect();
    let (mut lo, mut hi, mut best) = (0usize, boundaries.len() - 1, 0usize);
    while lo <= hi {
        let mid = (lo + hi) / 2;
        if tokens(&format!("{}{TRUNCATION_MARKER}", &text[..boundaries[mid]])) <= budget {
            best = mid;
            lo = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    format!("{}{TRUNCATION_MARKER}", &text[..boundaries[best]])
}

/// Summarize on one model: fit the prompt to its window, ask, and repair an
/// invalid reply once when `call.repair` allows. Every prompt is checked
/// against the model's window right before it is sent. `usage` adds up what
/// every call reported. With `records`, the send is recorded before it goes
/// out and the result carries its publication.
async fn summarize_on<C: RunnerClient>(
    client: &C,
    job: &Request,
    entries: &[cortexkit_role_compaction::read::Entry],
    call: &Call<'_>,
    records: Option<&Records<'_>>,
    usage: &mut Option<StepUsage>,
) -> Result<Option<Summarized>, Failure> {
    let (target, window, system) = (call.target, call.window, call.system);
    let enabled = call.lane == Lane::Enabled;
    // Facts carry anchors only when memory is on: with memory off the
    // prompt asks for none.
    let anchored = enabled && job.memory_enabled;
    // A quarter of the routed model's window. Exact vocabularies use that
    // budget directly; estimates convert it with the prose/tool calibration.
    let requested = ((window.context_window as f64 * CHUNK_SHARE).round() as u64)
        .clamp(CHUNK_MIN_TOKENS, CHUNK_MAX_TOKENS);
    let requested = window.counter.local_budget(requested as f64) as u64;
    let fitted = fit::fit(&fit::Input {
        session_id: &job.session.session,
        chunk_start: job.from,
        last_ordinal: job.until.saturating_sub(1).max(job.from),
        summaries: &job.summaries,
        memories: &job.memories,
        memory_enabled: job.memory_enabled,
        anchored_facts: anchored,
        system_prompt: system,
        windows: &[window],
        output_cap: target.output_tokens,
        requested_chunk_tokens: requested,
    })
    .map_err(Failure::NotSent)?;
    // The two-pass lane prints each message on a line of its own, so a
    // fact's anchor can cite exactly the lines that state it.
    let lines = if enabled {
        chunk::Lines::PerMessage
    } else {
        chunk::Lines::Merged
    };
    let Some(chunk) = chunk::build_with(entries, fitted.chunk_tokens, lines, window.counter) else {
        return Ok(None);
    };
    // The first message is always taken, even past the budget.
    let input = truncate_to(&chunk.input, fitted.chunk_tokens, window.counter);
    let mut prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
        seed_examples: &fitted.seed_examples,
        session_references: &fitted.session_references,
        project_memory: &fitted.project_memory,
        input_source: &input,
        memory_enabled: job.memory_enabled,
        user_observations_requested: false,
        extraction_free: false,
        anchored_facts: anchored,
    });
    if enabled {
        prompt = format!("{prompt}\n\n{}", turn_one::FORMAT_INSTRUCTION);
    }
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
        in_emergency: job.emergency,
        ..ValidateOptions::default()
    };
    if !window.admits(target.output_tokens, system, &prompt) {
        return Err(Failure::NotSent(
            "prompt_over_window: the summarizer prompt does not fit the model".into(),
        ));
    }
    let label = format!("{range}:{}", if enabled { "turn-one" } else { "first" });
    let send = match records {
        Some(records) => Some(
            records
                .db
                .with_connection(|conn| {
                    turn_one::allocate(
                        conn,
                        &turn_one::SendInput {
                            project: records.project,
                            session: &job.session.session,
                            harness: &job.session.harness,
                            carrier: records.carrier,
                            lane: call.lane,
                            chunk: (chunk.validation.start_index, chunk.validation.end_index),
                            model: target.model_json(),
                            child: &child_name(job, &label, 0),
                        },
                        now_ms(),
                    )
                })
                .map_err(|error| Failure::NotSent(format!("recording the send: {error}")))?,
        ),
        None => None,
    };
    let (first, answered_in) = attempt(client, job, &label, &prompt, call, usage)
        .await
        .map_err(Failure::Failed)?;
    let hashes = super::hashes::by_ordinal(entries);
    let checked = |reply: &str| {
        validate_historian_output(reply, &chunk.validation, &prior, options()).map(
            |mut validated| {
                super::hashes::sanitize(&mut validated.compartments, &hashes);
                validated
            },
        )
    };
    let publish = |validated: ValidatedChunk, child: Option<Child>| {
        let publication = send
            .clone()
            .zip(records)
            .map(|(send, records)| turn_one::Publication {
                send,
                project: records.project.to_owned(),
                session: job.session.session.clone(),
                harness: job.session.harness.clone(),
                carrier: records.carrier.to_owned(),
                counter: enabled.then(|| records.counter.clone()),
                blocks: chunk::blocks_sent(&chunk, &input)
                    .into_iter()
                    .cloned()
                    .collect(),
                candidates: if anchored {
                    validated.facts.clone()
                } else {
                    Vec::new()
                },
            });
        let continuation = child
            .filter(|_| anchored)
            .zip(send.as_ref())
            .map(|(child, send)| Continuation {
                child,
                model: target.model.clone(),
                decision_id: target.decision_id.clone(),
                output_tokens: target.output_tokens,
                language: job.language.clone(),
                publication_id: send.publication_id.clone(),
            });
        Summarized {
            validated,
            publication,
            continuation,
        }
    };
    if enabled {
        // No repair and no other model: an invalid first turn counts
        // against the chunk's failure budget, and the run ends.
        let reply = turn_one::parse_reply(&first)
            .ok_or_else(|| "the reply is not a turn-one JSON envelope".to_owned())
            .and_then(|xml| checked(&xml).map_err(|error| error.message));
        return match reply {
            Ok(validated) => Ok(Some(publish(validated, Some(answered_in)))),
            Err(error) => {
                if let Some(records) = records {
                    let counted = records.db.with_connection(|conn| {
                        turn_one::record_counter(
                            conn,
                            records.project,
                            &records.counter,
                            &job.session.harness,
                            records.carrier,
                            true,
                            now_ms(),
                        )
                    });
                    if let Err(failure) = counted {
                        tracing::warn!("ck-mc: recording a turn-one failure failed: {failure}");
                    }
                }
                Err(Failure::Final(format!("invalid turn-one reply: {error}")))
            }
        };
    }
    let error = match checked(&first) {
        Ok(validated) => return Ok(Some(publish(validated, None))),
        Err(error) => error.message,
    };
    if !call.repair {
        return Err(Failure::Failed(format!("invalid reply: {error}")));
    }
    let repair_prompt =
        build_historian_repair_prompt(&prompt, &first, &error, job.language.as_deref());
    // The repair prompt carries the invalid reply, so it can outgrow the
    // window the first prompt fit.
    if !window.admits(target.output_tokens, system, &repair_prompt) {
        return Err(Failure::Failed(format!(
            "invalid reply, and its repair prompt does not fit the model: {error}"
        )));
    }
    let (repaired, _) = attempt(
        client,
        job,
        &format!("{range}:repair"),
        &repair_prompt,
        call,
        usage,
    )
    .await
    .map_err(Failure::Failed)?;
    checked(&repaired)
        .map(|validated| Some(publish(validated, None)))
        .map_err(|error| Failure::Failed(format!("invalid after repair: {}", error.message)))
}

/// The child session of attempt `retry` of the call `label` names.
fn child_name(job: &Request, label: &str, retry: usize) -> String {
    if retry == 0 {
        format!("{}:{CHILD}:{label}", job.session.session)
    } else {
        format!("{}:{CHILD}:{label}:retry{retry}", job.session.session)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// One summarizer call in the child `label` names, with retries for
/// transient provider errors. Returns the reply's text and the child that
/// answered.
async fn attempt<C: RunnerClient>(
    client: &C,
    job: &Request,
    label: &str,
    prompt: &str,
    call_on: &Call<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<(String, Child), String> {
    let mut retry = 0;
    loop {
        let child = Child {
            session: SessionRef::new(
                job.session.runner.clone(),
                job.session.harness.clone(),
                child_name(job, label, retry),
            ),
            project_root: job.project_root.clone(),
        };
        // The first send to a child is identified by the child itself, so a
        // retry after a lost answer finds the run already started.
        let send_id = child.session.session.clone();
        match call(client, &child, &send_id, prompt, call_on, usage).await {
            Ok(text) => return Ok((text, child)),
            Err(error) if retry < MAX_RETRIES && retryable(&error) => {
                tokio::time::sleep(backoff(retry)).await;
                retry += 1;
            }
            // The child names the run to the runner's owner, who can match it
            // against the runner's own records.
            Err(error) => return Err(format!("{error} (child {})", child.session.session)),
        }
    }
}

/// Send one summarizer call in `child` and wait for its reply. A reply cut
/// off at its output limit is incomplete even when it parses.
async fn call<C: RunnerClient>(
    client: &C,
    child: &Child,
    send_id: &str,
    prompt: &str,
    call_on: &Call<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<String, String> {
    let target = call_on.target;
    let how = Model {
        model: &target.model,
        decision_id: &target.decision_id,
        output_tokens: target.output_tokens,
        system: call_on.system,
        deadline: call_on.deadline,
    };
    let reply = send_and_wait(client, child, send_id, prompt, &how, usage).await?;
    if reply.length_capped {
        return Err("the reply hit its output limit".into());
    }
    Ok(reply.text)
}

/// How a call in a summarizer child is made: the model routing picked and
/// its decision, the output cap, the system prompt and the run's deadline.
pub(crate) struct Model<'a> {
    pub model: &'a ModelRef,
    pub decision_id: &'a str,
    pub output_tokens: u64,
    pub system: &'a str,
    pub deadline: tokio::time::Instant,
}

/// A completed call's reply.
pub(crate) struct Reply {
    pub text: String,
    /// The reply stopped at its output limit.
    pub length_capped: bool,
}

/// Send `prompt` in `child` under `send_id` and wait for the run to end. A
/// run that ends other than `completed` is an error naming its state.
pub(crate) async fn send_and_wait<C: RunnerClient>(
    client: &C,
    child: &Child,
    send_id: &str,
    prompt: &str,
    how: &Model<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<Reply, String> {
    let runner = &child.session.runner;
    let with_temperature = !refuses_temperature(runner);
    let send = |temperature: bool| {
        let mut request = SendRequest::new(prompt, send_id.to_owned());
        request.runner_params = run_params(how, temperature);
        // The routing decision is a typed send field: the runner fixes it
        // for the run and forwards it when it gets an account from routing.
        request.route_decision_id = Some(how.decision_id.to_owned());
        request
    };
    let reply = match client.send_child(child, send(with_temperature)).await {
        // No contract declares `generation.temperature`, so a runner may
        // refuse it by name (llm-runner §9). A refused send starts nothing:
        // send again without it, and leave it out for that runner from now on.
        Err(error) if with_temperature && error.message.contains("generation.temperature") => {
            remember_temperature_refused(runner);
            client.send_child(child, send(false)).await
        }
        other => other,
    }
    .map_err(|error| send_error(&error))?;
    let Some(run_id) = reply.run_id.filter(|_| reply.state == states::ACTIVE) else {
        return Err(format!("the runner did not start a run: {}", reply.state));
    };
    let result = wait_for(client, child, &run_id, how.deadline).await?;
    if let Some(reported) = &result.usage {
        *usage = Some(add_usage(usage.take(), &step_usage(reported)));
    }
    if result.state != states::COMPLETED {
        let error = result
            .error
            .as_ref()
            .map_or_else(String::new, |error| error.message.clone());
        return Err(format!("the run ended {}: {error}", result.state));
    }
    Ok(Reply {
        length_capped: result.finish == Some(Finish::Length),
        text: result
            .final_message
            .map(|message| message.text)
            .unwrap_or_default(),
    })
}

/// A summarizer run's own parameters, which ride beside llm-runner's fields
/// of `session.send`: the model routing picked and its decision, the system
/// prompt, one model step and no tools.
fn run_params(how: &Model<'_>, temperature: bool) -> Map<String, Value> {
    let mut model = json!({
        "provider": how.model.provider,
        "model": how.model.model,
    });
    if let Some(variant) = &how.model.variant {
        model["variant"] = json!(variant);
    }
    let mut generation = json!({"max_output_tokens": how.output_tokens});
    if temperature {
        generation["temperature"] = json!(TEMPERATURE);
    }
    let Value::Object(params) = json!({
        "model": model,
        "system": how.system,
        "generation": generation,
        "stop_when": {"max_steps": 1},
        "tools": [],
    }) else {
        unreachable!("an object literal");
    };
    params
}

/// The runners that refused `generation.temperature`, for this process.
fn temperature_refusals() -> &'static std::sync::Mutex<std::collections::BTreeSet<String>> {
    static REFUSED: OnceLock<std::sync::Mutex<std::collections::BTreeSet<String>>> =
        OnceLock::new();
    REFUSED.get_or_init(Default::default)
}

fn refuses_temperature(runner: &str) -> bool {
    temperature_refusals()
        .lock()
        .expect("temperature refusals")
        .contains(runner)
}

fn remember_temperature_refused(runner: &str) {
    temperature_refusals()
        .lock()
        .expect("temperature refusals")
        .insert(runner.to_owned());
}

/// A run's usage as one step's: the summarizer runs one step.
fn step_usage(run: &cortexkit_role_llm_runner::usage::RunUsage) -> StepUsage {
    let mut usage = StepUsage::new();
    usage.prompt_tokens = run.input_tokens;
    usage.cache_read_tokens = run.cached_input_tokens;
    usage.cache_write_tokens = run.cache_write_tokens;
    usage.output_tokens = run.output_tokens;
    usage.reasoning_tokens = run.reasoning_tokens;
    usage
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
    let mut usage = StepUsage::new();
    usage.prompt_tokens = sum(total.prompt_tokens, more.prompt_tokens);
    usage.cache_read_tokens = sum(total.cache_read_tokens, more.cache_read_tokens);
    usage.cache_write_tokens = sum(total.cache_write_tokens, more.cache_write_tokens);
    usage.output_tokens = sum(total.output_tokens, more.output_tokens);
    usage.reasoning_tokens = sum(total.reasoning_tokens, more.reasoning_tokens);
    usage
}

/// Marks a send the runner refused by name with the code `transient`, the
/// contract's "nothing happened, send again". The provider-text rule in
/// [`is_transient`] never sees that code, so without the mark a runner busy
/// with the parent session failed the whole summary run.
const RUNNER_TRANSIENT: &str = "the runner refused it as transient: ";

/// A failed `session.send` as the run's error text.
fn send_error(error: &crate::client::ClientError) -> String {
    if error.code.as_deref() == Some("transient") {
        format!("session.send: {RUNNER_TRANSIENT}{}", error.message)
    } else {
        format!("session.send: {error:?}")
    }
}

/// Whether a failed summarizer call is retried: the runner said so, or the
/// provider's error text reads as transient.
fn retryable(error: &str) -> bool {
    error.contains(RUNNER_TRANSIENT) || is_transient(error)
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
) -> Result<Vec<cortexkit_role_compaction::read::Entry>, String> {
    crate::reads::full_range(client, &job.session, job.from, job.until, |_| false).await
}

/// Wait for a run's result until `deadline`, the run's overall limit. The
/// wait for each answer is bounded by it too.
async fn wait_for<C: RunnerClient>(
    client: &C,
    child: &Child,
    run_id: &str,
    deadline: tokio::time::Instant,
) -> Result<RunResult, String> {
    loop {
        let result = tokio::time::timeout_at(
            deadline,
            client.child_result(child, RunResultRequest::new(run_id)),
        )
        .await
        .map_err(|_| "the run did not finish in time".to_owned())?
        .map_err(|error| format!("run.result: {error:?}"))?;
        if result.state != states::ACTIVE {
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
    use super::{is_transient, truncate_to, TRUNCATION_MARKER};

    /// A chunk over its budget is cut to fit it, ending in the plugin's
    /// marker; one within it is untouched.
    #[test]
    fn an_oversized_chunk_is_cut_to_its_budget() {
        let text = "word ".repeat(10_000);
        let counter = crate::count::Counter::for_model(None);
        let cut = truncate_to(&text, 500, counter);
        assert!(cut.ends_with(TRUNCATION_MARKER));
        assert!(mc_tokenizer::estimate_tokens(&cut) as u64 <= 500);
        assert!(cut.len() > 1_000, "cut far too short: {}", cut.len());
        assert_eq!(truncate_to("short", 500, counter), "short");
    }

    // The cases the plugin's classifier is written for.
    /// A send the runner refused with the code `transient` is retried, while
    /// any other refusal ends the run as before.
    #[test]
    fn a_send_the_runner_refuses_as_transient_is_retried() {
        let mut transient = crate::client::ClientError::new("session changed during external I/O");
        transient.code = Some("transient".into());
        assert!(super::retryable(&super::send_error(&transient)));
        let mut refused = crate::client::ClientError::new("only the session's owner may do this");
        refused.code = Some("scope_owner_mismatch".into());
        assert!(!super::retryable(&super::send_error(&refused)));
    }

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
