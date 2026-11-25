//! One summarizer run, off the session's worker: read the messages it covers
//! in full, send them to the summarizer in a child session, check its
//! reply, and return the summaries to store.
//!
//! The run never touches the session's state: its worker keeps answering
//! notices and rides while the model writes, and takes the result as a job
//! of its own when the run ends.

use std::sync::Arc;
use std::time::Duration;

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_llm_runner::awaits::AwaitParty;
use cortexkit_role_llm_runner::finish::Finish;
use cortexkit_role_llm_runner::run::{states, RunResult, RunResultRequest, RunStatusRequest};
use cortexkit_role_llm_runner::send::states as send_states;
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::{json, Map, Value};

use super::account_wait::{caller_next_ms, AccountWait, Reselect, SendKind};
use super::two_pass::turn_one;
use super::{chunk, fit};
use std::sync::OnceLock;

use regex::Regex;

use super::prompt::{
    build_compartment_agent_prompt, with_content_language_directive, CompartmentPromptInputs,
    ContentLanguageDirectiveOptions, ReferenceCompartment,
};
use super::prompts::SummaryPrompts;
use super::validate::{
    validate_historian_output, StoredCompartmentRange, ValidateOptions, ValidatedChunk,
};
use crate::client::{Child, RunnerClient};
use crate::context_db::ContextDb;
use crate::routing::{self, Router};
use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_routing::report::Outcome;

/// Flash-class summarizers echo their examples back above this.
const TEMPERATURE: f64 = 0.1;
/// The most output a summary run asks for, before the model's own limit and
/// a quarter of its window cut it further. A reasoning summarizer spends much
/// of it thinking: Gemini 3.8 Flash on high used 36,111 tokens reasoning and
/// 5,797 writing for a 180-message chunk, so a 32,000 cap cut the summary off
/// before it began.
const MAX_OUTPUT_TOKENS: u64 = 65_536;
/// How long a run may take before it counts as failed.
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const CLEANUP_GRACE: Duration = Duration::from_secs(5);
const TIMED_OUT: &str = "the run did not finish in time";
/// What a child session's id adds to its parent's: each summarizer attempt
/// runs in a child of its own, `<parent session>:mc-summary:<attempt>`, so
/// the summarizer sees exactly its system prompt and one user message, and a
/// child never continues another attempt's conversation. The second turn is
/// the one exception: it continues the child its first turn answered in.
pub const CHILD: &str = "mc-summary";
/// How many days a runner that keeps sessions by policy keeps a child that
/// is meant to be kept ([`Model::keep_child`]), counted from its last
/// activity: long enough to read its transcript when tuning a prompt.
pub const KEPT_CHILD_DAYS: u32 = 7;

/// What a run reads and writes.
#[derive(Clone, Debug)]
pub struct Request {
    pub limits: crate::reads::Limits,
    pub session: SessionRef,
    /// Snapshot the child's route when the run starts. Later Setup updates
    /// affect the next run, never a child or continuation already in flight.
    pub child_harness: Option<String>,
    /// The first ordinal no summary covers yet.
    pub from: u64,
    /// The first ordinal of the protected tail, which the run leaves alone.
    pub until: u64,
    /// The session's summaries so far, oldest first: every one's index
    /// entry, and the rows the session holds. The run reads the bodies of
    /// the references it chooses from `context.db` when they aren't held.
    pub summaries: crate::summary::index::Summaries,
    /// The session's project folder, where the runner creates the
    /// summarizer's child sessions.
    pub project_root: Option<String>,
    /// The memory level the session can write to: its project id (see
    /// `Session::writable_memory_level`). With it and a store, the run keeps
    /// the plugin's send and publication records, which the second turn
    /// reads its candidate facts from.
    pub project: Option<String>,
    /// The user's `language`: the summarizer writes its prose in it.
    pub language: Option<String>,
    /// Memory is on: the summarizer may report facts.
    pub memory_enabled: bool,
    /// `memory.auto_promote`: the facts it reports are kept.
    pub auto_promote: bool,
    /// The run started in the force band. Its reply keeps every summary,
    /// the last one included, as the plugin's emergency recovery does: the
    /// session needs the relief now.
    pub emergency: bool,
    /// Keep the final compartment only when this chunk reaches the manual target.
    pub force_keep_last_compartment: bool,
    /// The session's memory context: the summarizer's texts render from the
    /// profile it chose (see `prompts.rs`).
    pub memory_context: Option<crate::memory_profile::MemoryContext>,
    /// The user's `keep_subagents`: the run's child sessions are kept for
    /// inspection (see [`Model::keep_child`]).
    pub keep_subagents: bool,
    /// The agent the session works for, as its route's scope names it: the
    /// run's attribution facts name it ([`crate::attribution`]).
    pub agent_id: Option<String>,
}

/// What a run produced.
#[derive(Clone, Debug)]
pub struct Summarized {
    pub validated: ValidatedChunk,
    /// The raw messages this publication covers, before any change to a view.
    pub(crate) source: PublicationSource,
    /// The first turn's send and publication record, stored with the
    /// summaries. `None` without a project or store.
    pub publication: Option<turn_one::Publication>,
    /// With memory on and a publication: the conversation the second turn
    /// continues.
    pub continuation: Option<Continuation>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PublicationSource {
    pub(crate) from: u64,
    pub(crate) until: u64,
    entries: Vec<cortexkit_role_compaction::read::Cursor>,
}

impl PublicationSource {
    pub(crate) fn new(
        from: u64,
        until: u64,
        entries: &[cortexkit_role_compaction::read::Entry],
    ) -> Self {
        Self {
            from,
            until,
            entries: entries
                .iter()
                .filter(|entry| (from..until).contains(&entry.ordinal))
                .map(|entry| {
                    cortexkit_role_compaction::read::Cursor::new(
                        entry.ordinal,
                        entry.mid.clone(),
                        entry.digest.clone(),
                    )
                })
                .collect(),
        }
    }

    pub(crate) fn matches(&self, entries: &[cortexkit_role_compaction::read::Entry]) -> bool {
        self.entries
            .iter()
            .map(|cursor| (cursor.ordinal, &cursor.mid, &cursor.digest))
            .eq(entries
                .iter()
                .map(|entry| (entry.ordinal, &entry.mid, &entry.digest)))
    }
}

/// The child conversation a first turn answered in, and the model it ran on,
/// which the second turn and its checks reuse.
#[derive(Clone, Debug)]
pub struct Continuation {
    pub child: Child,
    pub model: ModelRef,
    pub decision_id: String,
    pub output_tokens: u64,
    pub history: Option<fit::ContinuationWindow>,
    /// The user's `language`, which the system prompt both turns run under
    /// carries.
    pub language: Option<String>,
    /// The publication whose candidates the second turn sends first.
    pub publication_id: String,
    /// The texts the first turn ran with; the second turn uses the same.
    pub prompts: Arc<SummaryPrompts>,
    /// Whether the first turn's children were kept (`keep_subagents`); the
    /// second turn's check children are kept the same way.
    pub keep_child: bool,
}

/// The summarizer's system prompt with `language`'s directive.
pub(crate) fn two_pass_system(system: &str, language: Option<&str>) -> String {
    with_content_language_directive(system, language, ContentLanguageDirectiveOptions::default())
        .into_owned()
}

/// Transient provider errors retry this many times on the same model.
pub(crate) const MAX_RETRIES: usize = 2;
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

/// Run the summarizer: the two-pass historian's first turn ([`turn_one`]).
/// `Ok(None)` when there was nothing to summarize.
///
/// Routing picks the model, on the session's own runner. A transient provider error retries twice on the same model, after
/// 2 to 3 s and then 6 to 8 s. When a model still fails, or gives no valid
/// turn-one reply, the next one routing picks without it is tried. Every
/// attempt runs in a child of its own, so the summarizer always sees exactly
/// its system prompt and one user message. Each decision's outcome is
/// reported back to routing.
///
/// With memory on, the reply's facts carry source anchors. With a project
/// and a store, the run records its send before it goes out, and the facts
/// become candidates for the second turn.
pub async fn run<C: RunnerClient + Router>(
    client: &C,
    db: Option<&ContextDb>,
    job: &Request,
) -> Result<Option<Summarized>, SummaryError> {
    // The same deadline covers preparation, retries and route fallbacks.
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    let entries = tokio::time::timeout_at(deadline, read_range(client, job))
        .await
        .map_err(|_| TIMED_OUT)??;
    if entries.is_empty() {
        return Ok(None);
    }
    let prompts = SummaryPrompts::for_context(job.memory_context.as_ref())?;
    // The references the prompt shows are chosen on the summaries' index
    // entries, so only the chosen ones' bodies are read.
    let references = fit::references(
        &job.summaries,
        &prompts,
        &job.session.session,
        job.from,
        db.map(|db| {
            (
                db,
                job.session.harness.as_str(),
                job.session.session.as_str(),
            )
        }),
    )
    .map_err(|error| format!("reading the summaries shown as references: {error}"))?;
    let system = two_pass_system(&prompts.system, job.language.as_deref());
    let carrier = format!("ck-mc:{}", job.session.runner);
    // A runner may host several harnesses with different model support. Route
    // against the same harness that will receive every attempt's child send.
    let child_harness = job.child_harness.as_deref().unwrap_or(&job.session.harness);
    let mut tried: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    let mut paid_failure: Option<String> = None;
    // Every child the run creates is attributed to this session, its agent
    // and its project, before the child's first send.
    let purpose = crate::attribution::Purpose::summary(
        &job.session,
        job.agent_id.as_deref(),
        job.project.as_deref(),
    );
    let attribution = db.map(|db| crate::attribution::Attribution {
        db,
        purpose: &purpose,
    });
    let mut reselect = Reselect::default();
    let mut next = None;
    let mut selections_left = 1 + MAX_FALLBACKS;
    while next.is_some() || selections_left > 0 {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let select = reselect.exclusions(routing::summary_select(
            &job.session.runner,
            child_harness,
            &tried,
        ));
        let answer = if let Some(answer) = next.take() {
            answer
        } else {
            selections_left -= 1;
            match tokio::time::timeout_at(deadline, client.select(select.clone())).await {
                Ok(Ok(answer)) if tokio::time::Instant::now() < deadline => answer,
                Ok(Ok(_)) | Err(_) => break,
                Ok(Err(error)) => {
                    // Waiting charges no failure, so a fallback refusal must not
                    // erase the route failure that made the fallback necessary.
                    if paid_failure.is_none() && failure.is_none() {
                        if let Some(wait) =
                            AccountWait::of_routing(&error, SendKind::TurnOne, now_ms())
                        {
                            return Err(SummaryError::AccountWait(wait));
                        }
                    }
                    // No route left after a failure: the failure is what to report.
                    return Err(paid_failure
                        .or(failure)
                        .unwrap_or_else(|| error.to_string())
                        .into());
                }
            }
        };
        // Routing picks the model per attempt and ck-mc keeps no other record
        // of it, so this line is the only place to see which model wrote a
        // session's summaries.
        tracing::info!(
            "ck-mc: session {}: summary model {} on {}/{} (decision {})",
            job.session.session,
            answer.route.route_key(),
            job.session.runner,
            child_harness,
            answer.decision_id,
        );
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
            }),
            _ => None,
        };
        let mut usage = Vec::new();
        let call = Call {
            target: &target,
            child_harness,
            window,
            deadline,
            system: &system,
            prompts: &prompts,
            references: &references,
            keep_child: job.keep_subagents,
            attribution,
        };
        let outcome =
            summarize_on(client, job, &entries, &call, records.as_ref(), &mut usage).await;
        let reported = match &outcome {
            Ok(_) => Outcome::Completed,
            // The prompt never went out: this model's window cannot hold it.
            Err(Failure::NotSent(_)) => Outcome::Cancelled,
            // An unavailable account or a person-owned wait says nothing
            // against the route, even if the run had already started.
            Err(Failure::AccountWait(_) | Failure::NeverRan(_) | Failure::HostRefused(_)) => {
                Outcome::Cancelled
            }
            Err(Failure::Uncertain(_)) if usage.is_empty() => Outcome::Cancelled,
            Err(Failure::Failed(_) | Failure::Uncertain(_) | Failure::PaidThenWait { .. }) => {
                Outcome::Failed
            }
        };
        // Give the active route one bounded settlement even at expiry.
        let report_deadline =
            (deadline + 3 * CLEANUP_GRACE).min(tokio::time::Instant::now() + CLEANUP_GRACE);
        let _ = tokio::time::timeout_at(
            report_deadline,
            routing::report_runs(client, &answer.decision_id, reported, &usage),
        )
        .await;
        let (wait, failed_on_route) = match outcome {
            Ok(result) => return Ok(result),
            Err(Failure::AccountWait(wait)) => (wait, None),
            Err(Failure::NeverRan(wait)) => {
                return Err(paid_failure.map_or(SummaryError::NeverRan(wait), SummaryError::Failed));
            }
            Err(Failure::PaidThenWait { error, wait }) => (wait, Some(error)),
            Err(Failure::HostRefused(error) | Failure::Uncertain(error)) => {
                return Err(SummaryError::Failed(error))
            }
            Err(Failure::NotSent(error)) => {
                tried.push(answer.route.route_key());
                failure = Some(error);
                continue;
            }
            Err(Failure::Failed(error)) => {
                tried.push(answer.route.route_key());
                paid_failure = Some(error);
                continue;
            }
        };
        let rerouting = wait.refusal.is_some();
        match reselect
            .after_refusal(client, select, &answer, wait, deadline)
            .await
        {
            Ok(answer) => {
                next = Some(answer);
                paid_failure = failed_on_route.or(paid_failure);
            }
            Err(wait) => {
                return Err(match failed_on_route {
                    Some(error) => SummaryError::PaidThenWait { error, wait },
                    None => match paid_failure {
                        Some(error) if rerouting => SummaryError::PaidThenWait { error, wait },
                        Some(error) => SummaryError::Failed(error),
                        None => SummaryError::AccountWait(wait),
                    },
                });
            }
        }
    }
    Err(paid_failure
        .or(failure)
        .unwrap_or_else(|| TIMED_OUT.into())
        .into())
}

/// Why a summarizer send, or a whole run, produced no reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SummaryError {
    /// An account is unavailable or the run needs a person. Neither wait
    /// spends a summary attempt or counts against the route.
    AccountWait(AccountWait),
    /// The runner proved the words never ran. Retry after a transient wait,
    /// without spending a summary attempt or blaming the model.
    NeverRan(AccountWait),
    /// Delivery may have happened: reattach to the same send ID instead of
    /// starting another request.
    Uncertain(String),
    /// A retry met a wait after a previous request already used the route.
    PaidThenWait { error: String, wait: AccountWait },
    /// Any other failure, as text.
    Failed(String),
}

impl std::fmt::Display for SummaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NeverRan(wait) => write!(f, "{}: the {} never ran", wait.code, wait.send.name()),
            Self::AccountWait(wait) => write!(
                f,
                "{}: the {} waits for an account until {} ms since the epoch",
                wait.code,
                wait.send.name(),
                wait.until_ms
            ),
            Self::Failed(error) | Self::Uncertain(error) | Self::PaidThenWait { error, .. } => {
                f.write_str(error)
            }
        }
    }
}

impl From<String> for SummaryError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl From<&str> for SummaryError {
    fn from(error: &str) -> Self {
        Self::Failed(error.to_owned())
    }
}

/// Why one model did not produce a summary.
enum Failure {
    /// Nothing was sent to the model.
    NotSent(String),
    /// The model was asked and did not give a valid summary.
    Failed(String),
    /// The runner holds summarizer sends back until an account has room.
    AccountWait(AccountWait),
    /// The runner retired the send or could not hand its words to the host.
    NeverRan(AccountWait),
    HostRefused(String),
    Uncertain(String),
    PaidThenWait {
        error: String,
        wait: AccountWait,
    },
}

impl From<SummaryError> for Failure {
    fn from(error: SummaryError) -> Self {
        match error {
            SummaryError::AccountWait(wait) => Self::AccountWait(wait),
            SummaryError::NeverRan(wait) => Self::NeverRan(wait),
            SummaryError::Failed(error) => Self::Failed(error),
            SummaryError::Uncertain(error) => Self::Uncertain(error),
            SummaryError::PaidThenWait { error, wait } => Self::PaidThenWait { error, wait },
        }
    }
}

/// How one model is asked.
struct Call<'a> {
    target: &'a Target,
    child_harness: &'a str,
    window: fit::Window,
    deadline: tokio::time::Instant,
    /// The system prompt, language directive included.
    system: &'a str,
    /// The profile texts the system prompt came from.
    prompts: &'a Arc<SummaryPrompts>,
    /// The earlier summaries the prompt shows as references.
    references: &'a [ReferenceCompartment],
    /// Keep the children this model is asked in ([`Model::keep_child`]).
    keep_child: bool,
    /// Where the children this model is asked in are attributed.
    attribution: Option<crate::attribution::Attribution<'a>>,
}

/// Where a run keeps the plugin's send and publication records.
struct Records<'a> {
    db: &'a ContextDb,
    project: &'a str,
    carrier: &'a str,
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

/// Summarize on one model: fit the prompt to its window and ask. The prompt
/// is checked against the model's window right before it is sent. `usage`
/// adds up what every call reported. With `records`, the send is recorded
/// before it goes out and the result carries its publication.
async fn summarize_on<C: RunnerClient>(
    client: &C,
    job: &Request,
    entries: &[cortexkit_role_compaction::read::Entry],
    call: &Call<'_>,
    records: Option<&Records<'_>>,
    usage: &mut Vec<(String, StepUsage)>,
) -> Result<Option<Summarized>, Failure> {
    let (target, window, system) = (call.target, call.window, call.system);
    // Facts carry anchors only when memory is on: with memory off the
    // prompt asks for none.
    let anchored = job.memory_enabled;
    // A quarter of the routed model's window. Exact vocabularies use that
    // budget directly; estimates convert it with the prose/tool calibration.
    let requested = ((window.context_window as f64 * CHUNK_SHARE).round() as u64)
        .clamp(CHUNK_MIN_TOKENS, CHUNK_MAX_TOKENS);
    let requested = window.counter.local_budget(requested as f64) as u64;
    let fitted = fit::fit(&fit::Input {
        session_id: &job.session.session,
        chunk_start: job.from,
        last_ordinal: job.until.saturating_sub(1).max(job.from),
        references: call.references,
        // The first turn shows no memories: the second turn compares the
        // facts with them.
        memories: &[],
        memory_enabled: job.memory_enabled,
        anchored_facts: anchored,
        system_prompt: system,
        prompts: call.prompts,
        windows: &[window],
        output_cap: target.output_tokens,
        requested_chunk_tokens: requested,
    })
    .map_err(Failure::NotSent)?;
    // Each message is printed on a line of its own, so a fact's anchor can
    // cite exactly the lines that state it.
    let Some(chunk) = chunk::build_with(
        entries,
        fitted.chunk_tokens,
        chunk::Lines::PerMessage,
        window.counter,
    ) else {
        return Ok(None);
    };
    // The first message is always taken, even past the budget.
    let input = truncate_to(&chunk.input, fitted.chunk_tokens, window.counter);
    let prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
        seed_examples: &fitted.seed_examples,
        session_references: &fitted.session_references,
        project_memory: &fitted.project_memory,
        input_source: &input,
        memory_enabled: job.memory_enabled,
        user_observations_requested: false,
        extraction_free: false,
        anchored_facts: anchored,
        turn_one_instruction: &call.prompts.turn_one,
    });
    let mut prompt = format!("{prompt}\n\n{}", turn_one::FORMAT_INSTRUCTION);
    if chunk.marks_mid_turn {
        prompt.push_str("\n\n`U (mid-turn):` marks words the person spoke during an ongoing turn. Include them in the preceding compartment: do not start a compartment or set `<unprocessed_from>` at that message unless it is the first message in this chunk.");
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
    let options = ValidateOptions {
        sequence_offset: job
            .summaries
            .last()
            .map_or(0, |summary| summary.sequence as u64 + 1),
        memory_enabled: job.memory_enabled,
        auto_promote: job.auto_promote,
        in_emergency: job.emergency,
        force_keep_last_compartment: job.force_keep_last_compartment && !chunk.has_more,
        ..ValidateOptions::default()
    };
    if !window.admits(target.output_tokens, system, &prompt) {
        return Err(Failure::NotSent(
            "prompt_over_window: the summarizer prompt does not fit the model".into(),
        ));
    }
    if tokio::time::Instant::now() >= call.deadline {
        return Err(Failure::NotSent(TIMED_OUT.into()));
    }
    let label = format!("{range}:turn-one");
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
    let (reply, answered_in) = attempt(client, job, &label, &prompt, call, usage).await?;
    // An invalid reply fails this model; the run moves on to the next one.
    let hashes = super::hashes::by_ordinal(entries);
    let mut validated = turn_one::parse_reply(&reply)
        .ok_or_else(|| "the reply is not a turn-one JSON envelope".to_owned())
        .and_then(|xml| {
            validate_historian_output(&xml, &chunk.validation, &prior, options)
                .map_err(|error| error.message)
        })
        .map_err(|error| Failure::Failed(format!("invalid turn-one reply: {error}")))?;
    super::hashes::sanitize(&mut validated.compartments, &hashes);
    let publication = send
        .clone()
        .zip(records)
        .map(|(send, records)| turn_one::Publication {
            send,
            project: records.project.to_owned(),
            session: job.session.session.clone(),
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
    let continuation = send.as_ref().filter(|_| anchored).map(|send| Continuation {
        child: answered_in,
        model: target.model.clone(),
        decision_id: target.decision_id.clone(),
        output_tokens: target.output_tokens,
        history: Some(fit::ContinuationWindow {
            window,
            system_tokens: window.counter.count(system),
            history_tokens: window
                .counter
                .count(&prompt)
                .saturating_add(window.counter.count(&reply)),
        }),
        language: job.language.clone(),
        publication_id: send.publication_id.clone(),
        prompts: call.prompts.clone(),
        keep_child: call.keep_child,
    });
    let source = PublicationSource::new(job.from, validated.unprocessed_from, entries);
    Ok(Some(Summarized {
        validated,
        source,
        publication,
        continuation,
    }))
}

/// The child session of attempt `retry` of the call `label` names.
fn child_name(job: &Request, label: &str, retry: usize) -> String {
    if retry == 0 {
        format!("{}:{CHILD}:{label}", job.session.session)
    } else {
        format!("{}:{CHILD}:{label}:retry{retry}", job.session.session)
    }
}

pub(super) fn summary_run_id(child: &str) -> &str {
    child
        .rsplit_once(":retry")
        .filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .map_or(child, |(root, _)| root)
}

pub(crate) fn now_ms() -> i64 {
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
    usage: &mut Vec<(String, StepUsage)>,
) -> Result<(String, Child), Failure> {
    let mut retry = 0;
    let mut paid_failure = None;
    let wait_after_retry = |paid: Option<String>, wait, never_ran| match paid {
        Some(error) => Failure::PaidThenWait { error, wait },
        None if never_ran => Failure::NeverRan(wait),
        None => Failure::AccountWait(wait),
    };
    loop {
        if tokio::time::Instant::now() >= call_on.deadline {
            return Err(Failure::Failed(
                paid_failure.unwrap_or_else(|| TIMED_OUT.into()),
            ));
        }
        let child = Child {
            session: SessionRef::new(
                job.session.runner.clone(),
                call_on.child_harness,
                child_name(job, label, retry),
            ),
            project_root: job.project_root.clone(),
        };
        // The first send to a child is identified by the child itself, so a
        // retry after a lost answer finds the run already started.
        let send_id = child.session.session.clone();
        let mut spent = None;
        let result = call(client, &child, &send_id, prompt, call_on, &mut spent).await;
        let paid = spent.is_some();
        if let Some(spent) = spent {
            let root = summary_run_id(&send_id);
            let id = if retry == 0 {
                format!("{root}:turn1")
            } else {
                format!("{root}:turn1:retry{retry}")
            };
            usage.push((id, spent));
        }
        match result {
            Ok(text) => return Ok((text, child)),
            Err(CallError::RetryAt { next_ms, error }) => {
                let remaining = call_on
                    .deadline
                    .saturating_duration_since(tokio::time::Instant::now());
                let floor = Duration::from_millis(next_ms.saturating_sub(now_ms().max(0) as u64));
                let error = format!("{error} (child {})", child.session.session);
                if paid {
                    paid_failure = Some(error.clone());
                }
                if floor >= remaining {
                    return Err(wait_after_retry(
                        paid_failure,
                        AccountWait::retry_at(next_ms, SendKind::TurnOne, now_ms()),
                        false,
                    ));
                }
                if retry == MAX_RETRIES {
                    return Err(Failure::Failed(error));
                }
                tokio::time::sleep(backoff(retry).max(floor).min(remaining)).await;
                retry += 1;
            }
            Err(CallError::Summary(SummaryError::Failed(error)))
                if retry < MAX_RETRIES && retryable(&error) =>
            {
                let remaining = call_on
                    .deadline
                    .saturating_duration_since(tokio::time::Instant::now());
                let delay = backoff(retry);
                let error = format!("{error} (child {})", child.session.session);
                if paid {
                    paid_failure = Some(error.clone());
                }
                if delay >= remaining {
                    return Err(Failure::Failed(error));
                }
                tokio::time::sleep(delay).await;
                retry += 1;
            }
            Err(CallError::Summary(SummaryError::NeverRan(wait)))
                if retry < MAX_RETRIES && wait.code == "handover_failed" =>
            {
                let remaining = call_on
                    .deadline
                    .saturating_duration_since(tokio::time::Instant::now());
                let delay = backoff(retry);
                if delay >= remaining {
                    return Err(wait_after_retry(paid_failure, wait, true));
                }
                tokio::time::sleep(delay).await;
                retry += 1;
            }
            // The child names the run to the runner's owner, who can match it
            // against the runner's own records.
            Err(CallError::Summary(SummaryError::Failed(error))) => {
                return Err(Failure::Failed(format!(
                    "{error} (child {})",
                    child.session.session
                )))
            }
            // The outer loop may re-select, but this decision never retries a
            // runner account refusal.
            Err(CallError::Summary(SummaryError::AccountWait(wait))) => {
                return Err(wait_after_retry(paid_failure, wait, false))
            }
            Err(CallError::Summary(SummaryError::NeverRan(wait))) => {
                return Err(wait_after_retry(paid_failure, wait, true))
            }
            Err(CallError::HostRefused(error)) => {
                return Err(Failure::HostRefused(error));
            }
            Err(CallError::Summary(error)) => return Err(error.into()),
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
) -> Result<String, CallError> {
    let target = call_on.target;
    let how = Model {
        model: &target.model,
        decision_id: &target.decision_id,
        output_tokens: target.output_tokens,
        system: call_on.system,
        deadline: call_on.deadline,
        continuation: false,
        creates_child: true,
        keep_child: call_on.keep_child,
        send: SendKind::TurnOne,
        // The second turn follows within seconds and reuses the cache this
        // send writes.
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        plan: None,
        attribution: call_on.attribution,
    };
    let reply = send_and_wait_inner(client, child, send_id, prompt, &how, usage)
        .await?
        .completed()?;
    if reply.length_capped {
        return Err(CallError::Summary("the reply hit its output limit".into()));
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
    /// Preserve the existing tools/cache parameter shape. Turn two and its
    /// memory fact checks omit those members; the first summary turn sends them. Runners
    /// freeze tools on creation and refuse them on later sends, even an
    /// unchanged empty list (llm-runner §9.3.1).
    pub continuation: bool,
    /// This logical send creates its child (including an idempotent retry).
    /// Storage labels are never repeated on a later send in that conversation.
    pub creates_child: bool,
    /// On a runner that keeps sessions by policy (`session_retention`), the
    /// child is kept [`KEPT_CHILD_DAYS`] after its last activity so its
    /// transcript can be read; otherwise it asks to be kept not at all, and
    /// the runner deletes it once its hold ends. Dreamer children are always
    /// kept; summary children only with the user's `keep_subagents`.
    pub keep_child: bool,
    /// A single call cannot reuse a cache write; the second turn follows
    /// within seconds and can reuse the shortest explicit lifetime.
    pub cache_ttl: cortexkit_role_llm_runner::cache::Ttl,
    /// Which summarizer send this is, named by an account wait it meets.
    pub send: SendKind,
    /// A child that gets tools: created with this fetch plan instead of an
    /// inline system prompt and an empty tool list, since a runner takes no
    /// inline system text next to a plan. `None` for every summarizer call.
    pub plan: Option<&'a PlanRun>,
    /// What a child this send creates is for. The send that creates a child
    /// (`creates_child`) records the child's attribution fact right before
    /// it goes out; a later send to the same child records nothing. `None`
    /// records nothing, as without a store.
    pub attribution: Option<crate::attribution::Attribution<'a>>,
}

/// A fetch plan a child is created with, and how many model steps its run
/// may take: each tool call needs a step after it.
pub(crate) struct PlanRun {
    pub plan: Map<String, Value>,
    pub max_steps: u64,
}

/// A completed call's reply.
pub(crate) struct Reply {
    pub text: String,
    /// The reply stopped at its output limit.
    pub length_capped: bool,
    /// The model steps the run took, when the runner reported its usage.
    /// Each tool call needs a step after it, so a run of more than one step
    /// made at least one tool call.
    pub steps: Option<u64>,
}

/// The run a send started, as it ended: completed with its reply, or
/// stopped at its step limit.
pub(crate) struct Ended {
    /// The completed run's reply. For a run stopped at its step limit, the
    /// final message it left, which answers nothing, and the steps it took.
    pub reply: Reply,
    /// The run ended at its step limit (`stop_when.max_steps`): its last
    /// step asked for a tool call the limit cut off. Only a child with tools
    /// can end this way.
    pub step_capped: bool,
    /// For a run stopped at its step limit, the failure [`Ended::completed`]
    /// reports; empty for a completed run.
    failure: String,
}

impl Ended {
    /// The reply of a run that completed. A run stopped at its step limit
    /// is the failure every caller saw before such runs were told apart.
    pub(crate) fn completed(self) -> Result<Reply, String> {
        if self.step_capped {
            Err(self.failure)
        } else {
            Ok(self.reply)
        }
    }
}

/// Retry timing stays typed until the first-turn retry loop consumes it.
/// Direct sends (turn two and fact checks) have no transient retry loop.
#[derive(Debug)]
enum CallError {
    Summary(SummaryError),
    HostRefused(String),
    RetryAt { next_ms: u64, error: String },
}

impl From<SummaryError> for CallError {
    fn from(error: SummaryError) -> Self {
        Self::Summary(error)
    }
}

impl From<String> for CallError {
    fn from(error: String) -> Self {
        Self::Summary(error.into())
    }
}

/// Send `prompt` in `child` under `send_id` and wait for the run to end. A
/// run that ends other than `completed` is an error naming its state. A
/// wait for an account or a person is [`SummaryError::AccountWait`], as is
/// a caller-owned retry floor when this direct send cannot retry itself.
pub(crate) async fn send_and_wait<C: RunnerClient>(
    client: &C,
    child: &Child,
    send_id: &str,
    prompt: &str,
    how: &Model<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<Reply, SummaryError> {
    send_and_wait_stepped(client, child, send_id, prompt, how, usage)
        .await?
        .completed()
        .map_err(SummaryError::from)
}

/// [`send_and_wait`], with a run stopped at its step limit returned as
/// such ([`Ended::step_capped`]) instead of as a failure, for a dreamer
/// child with tools that is asked to answer once more when stopped.
pub(crate) async fn send_and_wait_stepped<C: RunnerClient>(
    client: &C,
    child: &Child,
    send_id: &str,
    prompt: &str,
    how: &Model<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<Ended, SummaryError> {
    match send_and_wait_inner(client, child, send_id, prompt, how, usage).await {
        Ok(reply) => Ok(reply),
        Err(CallError::Summary(error)) => Err(error),
        Err(CallError::HostRefused(error)) => Err(SummaryError::Failed(error)),
        Err(CallError::RetryAt { next_ms, .. }) => Err(SummaryError::AccountWait(
            AccountWait::retry_at(next_ms, how.send, now_ms()),
        )),
    }
}

async fn send_and_wait_inner<C: RunnerClient>(
    client: &C,
    child: &Child,
    send_id: &str,
    prompt: &str,
    how: &Model<'_>,
    usage: &mut Option<StepUsage>,
) -> Result<Ended, CallError> {
    if tokio::time::Instant::now() >= how.deadline {
        return Err(TIMED_OUT.to_owned().into());
    }
    let (with_temperature, session_class, retention_policy, cache) =
        tokio::time::timeout_at(how.deadline, async {
            let with_temperature = client.child_temperature(child).await;
            let session_class = if how.creates_child && client.child_session_class(child).await {
                Some(how.send.session_class().to_owned())
            } else {
                None
            };
            // The runner freezes a child's storage policy (how long it keeps the
            // child's transcript) on the send that creates it, so only that send
            // carries one. A runner that doesn't declare the retention capability
            // would refuse the field, so it is never sent one.
            let retention_policy = if how.creates_child {
                client.child_session_retention(child).await.map(|limits| {
                    if how.keep_child {
                        limits.keep_for(KEPT_CHILD_DAYS)
                    } else {
                        limits.keep_none()
                    }
                })
            } else {
                None
            };
            // A cache policy is set only for a planless session; a planned one
            // takes the runner's.
            let cache = if !how.continuation
                && how.plan.is_none()
                && client.child_cache_policy(child).await
            {
                let mut cache = cortexkit_role_llm_runner::cache::Cache::new();
                cache.ttl = Some(how.cache_ttl);
                cache.keep_warm = Some(cortexkit_role_llm_runner::cache::KeepWarm::Off);
                Some(cache)
            } else {
                None
            };
            (with_temperature, session_class, retention_policy, cache)
        })
        .await
        .map_err(|_| TIMED_OUT.to_owned())?;
    if tokio::time::Instant::now() >= how.deadline {
        return Err(TIMED_OUT.to_owned().into());
    }
    let mut request = SendRequest::new(prompt, send_id.to_owned());
    request.session_class = session_class;
    request.cache = cache;
    request.retention_policy = retention_policy;
    request.runner_params = run_params(how, with_temperature);
    if !how.continuation {
        request.plan = how.plan.map(|plan| plan.plan.clone());
    }
    // The routing decision is a typed send field: the runner fixes it
    // for the run and forwards it when it gets an account from routing.
    request.route_decision_id = Some(how.decision_id.to_owned());
    // Registered before the first send, so a run-end event that arrives
    // while a send is being answered ends the next pause at once.
    let watch = client.run_ends().map(|ends| ends.watch(&child.session));
    // The child's attribution fact is stored before its first model call
    // can start, so no spend of the child is ever unattributed. Only the
    // send that creates the child records it; the fact keeps the child's
    // first purpose whatever later sends to it say.
    if how.creates_child {
        if let Some(attribution) = &how.attribution {
            attribution.record(&child.session);
        }
    }
    let mut resent = false;
    let mut reattachments = 0;
    let mut pending = false;
    let mut submission = None;
    let reply = loop {
        if tokio::time::Instant::now() >= how.deadline {
            if pending {
                return Err(
                    queued_timeout(client, child, submission.as_deref(), how.send)
                        .await
                        .into(),
                );
            }
            return Err(SummaryError::Failed(TIMED_OUT.into()).into());
        }
        let reply =
            match tokio::time::timeout_at(how.deadline, client.send_child(child, request.clone()))
                .await
            {
                Ok(Ok(reply)) => reply,
                Ok(Err(_)) if submission.is_some() => {
                    crate::run_ends::pause(watch.as_ref(), how.deadline).await;
                    continue;
                }
                Ok(Err(error)) if error.outcome_unknown || pending => {
                    // Only replay the identical send. Another route or child
                    // cannot tell whether the runner already accepted these words.
                    let delay = backoff(reattachments);
                    if how.send == SendKind::TurnOne
                        && reattachments < MAX_RETRIES
                        && tokio::time::Instant::now() + delay < how.deadline
                    {
                        reattachments += 1;
                        pending = true;
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    return Err(SummaryError::Uncertain(send_error(&error)).into());
                }
                Ok(Err(error)) => return Err(send_refused(&error, how.send).into()),
                Err(_) => {
                    return Err(
                        queued_timeout(client, child, submission.as_deref(), how.send)
                            .await
                            .into(),
                    )
                }
            };
        if reply.state == send_states::NOT_DELIVERED {
            // A host that refused the words themselves (an unreadable
            // attachment, invalid host configuration, an unsupported host
            // version, a managed policy) refuses the same send again on every
            // try, so it is never resent. It is an ordinary failure, counted
            // and backed off like a failed run, not a wait that would probe the
            // same refusal forever.
            if reply.reason.as_deref() == Some(cortexkit_role_llm_runner::send::REASON_HOST_REFUSED)
            {
                return Err(CallError::HostRefused(format!(
                    "the host refused the {} send; it is not resent (host_refused)",
                    how.send.name()
                )));
            }
            // Every other reason, including a future one, proves final
            // non-delivery. Only that proof permits a new id; an unknown
            // outcome must not duplicate a prompt that may already have run.
            let delay = backoff(0);
            if resent || tokio::time::Instant::now() + delay >= how.deadline {
                return Err(never_ran(send_states::NOT_DELIVERED, how.send).into());
            }
            tokio::time::sleep(delay).await;
            request.send_id = format!("{send_id}:not-delivered:1");
            // The retired send already admitted the child, which keeps its
            // storage policy and fetch plan. A new send in that conversation
            // drops the creation-only session class, cache policy, retention
            // policy, plan and inline tool list instead of setting them again.
            request.session_class = None;
            request.cache = None;
            request.retention_policy = None;
            request.plan = None;
            request.runner_params.remove("tools");
            resent = true;
            pending = false;
            submission = None;
        } else if reply.state == send_states::PENDING && reply.run_id.is_none() {
            // Interrupting another turn does not retire this queued send.
            // Replay its identical id until the runner names its own run.
            pending = true;
            if reply.submission_id.is_some() {
                submission = reply.submission_id;
            }
            crate::run_ends::pause(watch.as_ref(), how.deadline).await;
        } else {
            break reply;
        }
    };
    drop(watch);
    // A runner may answer a run-starting send as soon as it is stored,
    // before the prompt reaches its host: `pending` with the run's id. That
    // run is followed like an active one, even if it finished between polls.
    let Some(run_id) = reply.run_id.filter(|_| {
        matches!(
            reply.state.as_str(),
            states::ACTIVE | send_states::PENDING | send_states::FINISHED
        )
    }) else {
        return Err(format!("the runner did not start a run: {}", reply.state).into());
    };
    let result = wait_for(client, child, &run_id, how.deadline, how.send, usage).await?;
    if result.state != states::COMPLETED {
        if result.state == states::ERROR
            && result.error.as_ref().is_some_and(|error| {
                error.class == cortexkit_role_llm_runner::errors::run_error_classes::HANDOVER_FAILED
            })
        {
            let cause = result
                .error
                .as_ref()
                .and_then(|error| error.cause.as_deref())
                .unwrap_or("unknown");
            tracing::info!(
                "ck-mc: session {}: {} never ran: handover_failed (cause {cause})",
                child.session.session,
                how.send.name(),
            );
            return Err(never_ran("handover_failed", how.send).into());
        }
        // A runner that queued the send refuses it at the run's own
        // admission, and says so in the error the run ends with.
        if let Some(wait) = AccountWait::of_ended_run(&result, how.send, now_ms()) {
            if AccountWait::of_person(&result, how.send, now_ms()).is_some() {
                cancel_waiting(client, child, &run_id).await;
            }
            return Err(SummaryError::AccountWait(wait).into());
        }
        let error = result
            .error
            .as_ref()
            .map_or_else(String::new, |error| error.message.clone());
        if let Some(next_ms) = caller_next_ms(&result).filter(|_| {
            result
                .error
                .as_ref()
                .is_some_and(|error| error.provider_code == "transient")
        }) {
            return Err(CallError::RetryAt { next_ms, error });
        }
        let failure = format!("the run ended {}: {error}", result.state);
        if result.state == states::ERROR
            && result
                .error
                .as_ref()
                .is_some_and(|error| error.class == "host_refused")
        {
            return Err(CallError::HostRefused(failure));
        }
        if result.state == states::MAX_STEPS {
            return Ok(Ended {
                reply: Reply {
                    length_capped: false,
                    steps: result.usage.as_ref().map(|usage| usage.steps),
                    text: result
                        .final_message
                        .map(|message| message.text)
                        .unwrap_or_default(),
                },
                step_capped: true,
                failure,
            });
        }
        return Err(failure.into());
    }
    Ok(Ended {
        reply: Reply {
            length_capped: result.finish == Some(Finish::Length),
            steps: result.usage.as_ref().map(|usage| usage.steps),
            text: result
                .final_message
                .map(|message| message.text)
                .unwrap_or_default(),
        },
        step_capped: false,
        failure: String::new(),
    })
}

async fn queued_timeout<C: RunnerClient>(
    client: &C,
    child: &Child,
    submission: Option<&str>,
    send: SendKind,
) -> SummaryError {
    if let Some(submission) = submission {
        if matches!(
            tokio::time::timeout(CLEANUP_GRACE, client.retract_child_send(child, submission)).await,
            Ok(Ok(true))
        ) {
            return never_ran(send_states::NOT_DELIVERED, send);
        }
        tracing::warn!("ck-mc: queued summarizer submission {submission} in {} timed out without confirmed withdrawal", child.session.session);
    }
    SummaryError::Uncertain(TIMED_OUT.into())
}

/// Reuse the session's wait scheduler, but not its failure accounting or
/// the one-minute minimum delay for account waits. An unavailable host gets bounded
/// probes at the existing transient backoff, not a retry on every notice.
fn never_ran(code: &str, send: SendKind) -> SummaryError {
    let at_ms = now_ms();
    SummaryError::NeverRan(AccountWait {
        code: code.to_owned(),
        at_ms,
        until_ms: at_ms.saturating_add(backoff(MAX_RETRIES - 1).as_millis() as i64),
        send,
        refusal: None,
    })
}

#[cfg(test)]
#[path = "session_class_tests.rs"]
pub(crate) mod session_class_tests;

#[cfg(test)]
#[path = "pending_send_tests.rs"]
mod pending_send_tests;

#[cfg(test)]
#[path = "run_wake_tests.rs"]
mod run_wake_tests;

#[cfg(test)]
#[path = "never_ran_tests.rs"]
pub(crate) mod never_ran_tests;

#[cfg(test)]
#[path = "harness_tests.rs"]
mod harness_tests;

#[cfg(test)]
#[path = "account_wait_send_tests.rs"]
pub(crate) mod account_wait_send_tests;

#[cfg(test)]
#[path = "run_awaits_tests.rs"]
mod run_awaits_tests;

#[cfg(test)]
#[path = "temperature_tests.rs"]
mod temperature_tests;

#[cfg(test)]
#[path = "retention_tests.rs"]
mod retention_tests;

#[cfg(test)]
#[path = "one_summarizer_tests.rs"]
mod one_summarizer_tests;

#[cfg(test)]
#[path = "attribution_tests.rs"]
mod attribution_tests;

/// A summarizer run's own parameters, which ride beside llm-runner's fields
/// of `session.send`: the model routing picked and its decision, the system
/// prompt, one model step and, on the send that creates the child, no tools.
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
    // Built member by member in the order a planless call always used, so
    // its bytes don't change.
    let mut params = Map::new();
    params.insert("model".into(), model);
    if how.plan.is_none() {
        params.insert("system".into(), json!(how.system));
    }
    params.insert("generation".into(), generation);
    let steps = how.plan.map_or(1, |plan| plan.max_steps);
    params.insert("stop_when".into(), json!({"max_steps": steps}));
    if how.plan.is_none() && !how.continuation {
        params.insert("tools".into(), json!([]));
    }
    params
}

/// A run's usage as one step's. `prompt_tokens` is the whole prompt the run
/// sent, as `StepUsage` defines it: the runner's `input_tokens` counts only
/// input that was neither read from nor written to the prompt cache, so the
/// cache reads and writes are added back. The dreamer (Magic Context's
/// scheduled memory upkeep) adds these up across a run's batches to hold
/// the run to its token budget, and a tool-using batch sends most of its
/// prompt from the cache, so counting the uncached part alone let a run
/// spend several times its budget.
fn step_usage(run: &cortexkit_role_llm_runner::usage::RunUsage) -> StepUsage {
    let mut usage = StepUsage::new();
    usage.prompt_tokens = [
        run.input_tokens,
        run.cached_input_tokens,
        run.cache_write_tokens,
    ]
    .into_iter()
    .flatten()
    .reduce(|total, part| total + part);
    usage.cache_read_tokens = run.cached_input_tokens;
    usage.cache_write_tokens = run.cache_write_tokens;
    usage.output_tokens = run.output_tokens;
    usage.reasoning_tokens = run.reasoning_tokens;
    usage
}

#[cfg(test)]
mod step_usage_tests {
    use super::step_usage;

    fn run_usage(value: serde_json::Value) -> cortexkit_role_llm_runner::usage::RunUsage {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_prompt_counts_cache_reads_and_writes() {
        let usage = step_usage(&run_usage(serde_json::json!({
            "steps": 3, "unreported_steps": 0,
            "input_tokens": 100, "cached_input_tokens": 900,
            "cache_write_tokens": 50, "output_tokens": 20, "by_model": []
        })));
        assert_eq!(usage.prompt_tokens, Some(1_050));
        assert_eq!(usage.cache_read_tokens, Some(900));
        assert_eq!(usage.output_tokens, Some(20));
    }

    #[test]
    fn an_unreported_prompt_stays_unknown() {
        let usage = step_usage(&run_usage(serde_json::json!({
            "steps": 0, "unreported_steps": 0
        })));
        assert_eq!(usage.prompt_tokens, None);
        let usage = step_usage(&run_usage(serde_json::json!({
            "steps": 1, "unreported_steps": 0,
            "cached_input_tokens": 400, "by_model": []
        })));
        assert_eq!(usage.prompt_tokens, Some(400));
    }
}

/// The usage of several calls on one decision, added up. A count either
/// call left out stays as the other reported it.
pub(crate) fn add_usage(total: Option<StepUsage>, more: &StepUsage) -> StepUsage {
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

/// A failed `session.send`: an account wait when the runner refused it as
/// one, a short wait when the runner was restarting and the send never left,
/// otherwise the run's error text.
fn send_refused(error: &crate::client::ClientError, send: SendKind) -> SummaryError {
    // The daemon refused the route because the runner module is reloading or
    // not up yet, and proved nothing was sent. That says nothing about the
    // model or the words, so probe again after the transient backoff instead
    // of failing the run: a dreamer run would otherwise end `failed` and drop
    // its remaining batches.
    if !error.outcome_unknown {
        if let Some(code @ ("module_reloading" | "target_unavailable")) = error.code.as_deref() {
            return never_ran(code, send);
        }
    }
    let wait = error.code.as_deref().and_then(|code| {
        AccountWait::of_refusal(
            code,
            error.detail.as_ref(),
            send,
            super::account_wait::now_ms(),
        )
    });
    match wait {
        Some(wait) => SummaryError::AccountWait(wait),
        None => SummaryError::Failed(send_error(error)),
    }
}

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
pub(crate) fn retryable(error: &str) -> bool {
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
pub(crate) fn backoff(retry: usize) -> Duration {
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
    crate::reads::full_range(
        client,
        &job.session,
        job.from,
        job.until,
        job.limits,
        |_| false,
    )
    .await
}

/// Whether a run in `state` has not ended: active, paused, or `pending`,
/// stored and not yet handed to the host.
fn still_running(state: &str) -> bool {
    matches!(
        state,
        states::ACTIVE | states::PAUSED | send_states::PENDING
    )
}

/// Wait for a run's result until `deadline`, the run's overall limit. The
/// wait for each answer is bounded by it too. Between reads it sleeps the
/// poll interval, or less when the runner's run-end event wakes it
/// ([`crate::run_ends`]). A runner may resume a paused run by itself, so we
/// keep polling it unless the pause names an account limit. In that case
/// cancel now so the work can try another route. Status supplies the earliest
/// retry time and who the wait is on when the result omits them.
async fn wait_for<C: RunnerClient>(
    client: &C,
    child: &Child,
    run_id: &str,
    deadline: tokio::time::Instant,
    send: SendKind,
    usage: &mut Option<StepUsage>,
) -> Result<RunResult, SummaryError> {
    // Registered before the first read: an event that comes after that read
    // wakes the next pause, and one that came before it means the read
    // already sees the run's end.
    let watch = client.run_ends().map(|ends| ends.watch(&child.session));
    let mut last: Option<RunResult> = None;
    let mut reported = None;
    loop {
        let answer = tokio::time::timeout_at(
            deadline,
            client.child_result(child, RunResultRequest::new(run_id)),
        )
        .await;
        let result = match answer {
            Ok(Ok(result)) => result,
            // A lost read does not end a named run. Retry the same run on
            // the next poll rather than abandoning it for another child.
            Ok(Err(_)) if tokio::time::Instant::now() < deadline => {
                crate::run_ends::pause(watch.as_ref(), deadline).await;
                continue;
            }
            Ok(Err(_)) | Err(_) => break,
        };
        if let Some(current) = result.usage.as_ref().filter(|usage| {
            usage.steps > 0
                || [
                    usage.input_tokens,
                    usage.cached_input_tokens,
                    usage.cache_write_tokens,
                    usage.output_tokens,
                    usage.reasoning_tokens,
                ]
                .into_iter()
                .flatten()
                .any(|tokens| tokens > 0)
        }) {
            // Each read reports usage for the whole child run, not a delta.
            reported = Some(step_usage(current));
        }
        let runner_wait = result
            .awaits
            .as_ref()
            .is_some_and(|wait| wait.party == AwaitParty::Runner);
        if !still_running(&result.state) && !runner_wait {
            if let Some(reported) = reported {
                *usage = Some(add_usage(usage.take(), &reported));
            }
            return Ok(result);
        }
        let account_paused = result.state == states::PAUSED
            && AccountWait::of_paused_run(&result, None, send, now_ms())
                .is_some_and(|wait| wait.refusal.is_some());
        last = Some(result);
        if account_paused || tokio::time::Instant::now() >= deadline {
            break;
        }
        crate::run_ends::pause(watch.as_ref(), deadline).await;
    }
    if let Some(reported) = reported {
        *usage = Some(add_usage(usage.take(), &reported));
    }
    stop_waiting(client, child, run_id, last, send).await
}

/// Read status before cancelling: cancellation may clear the wait. Older
/// runners may not serve status, so the last result remains the fallback.
async fn stop_waiting<C: RunnerClient>(
    client: &C,
    child: &Child,
    run_id: &str,
    last: Option<RunResult>,
    send: SendKind,
) -> Result<RunResult, SummaryError> {
    if let Some(result) = last.as_ref().filter(|result| !still_running(&result.state)) {
        return Ok(result.clone());
    }
    let status = tokio::time::timeout(
        CLEANUP_GRACE,
        client.child_status(child, RunStatusRequest::new().with_run_id(run_id)),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let resume = status
        .as_ref()
        .and_then(|status| status.resume_not_before_ms);
    let mut run = last.unwrap_or_else(|| RunResult::new(run_id, states::ACTIVE));
    let cancel = status.as_ref().map_or_else(
        || still_running(&run.state),
        |status| still_running(&status.state) || status.state == "unknown",
    );
    if let Some(status) = status {
        // Without a caller- or person-owned wait, keep the run result's
        // existing error and reason instead of adopting status diagnostics.
        if status
            .awaits
            .as_ref()
            .is_some_and(|wait| matches!(wait.party, AwaitParty::Caller | AwaitParty::Person))
        {
            run.error = status.error.or(run.error);
            run.reason = status.reason.map(String::from).or(run.reason);
        }
        if status.awaits.is_some() {
            run.awaits = status.awaits;
        }
    }
    let now = now_ms();
    let person = AccountWait::of_person(&run, send, now);
    let wait = person
        .clone()
        .or_else(|| {
            if run.state == states::PAUSED {
                AccountWait::of_paused_run(&run, resume, send, now)
            } else {
                AccountWait::of_ended_run(&run, send, now).filter(|_| {
                    run.awaits
                        .as_ref()
                        .is_some_and(|wait| wait.party == AwaitParty::Caller)
                })
            }
        })
        .or_else(|| {
            caller_next_ms(&run)
                .filter(|_| {
                    run.error
                        .as_ref()
                        .is_some_and(|error| error.provider_code == "transient")
                })
                .map(|next| AccountWait::retry_at(next, send, now))
        });
    let cancelled = (cancel || person.is_some()) && cancel_waiting(client, child, run_id).await;
    Err(match wait {
        Some(wait) => SummaryError::AccountWait(wait),
        None if cancel && !cancelled => SummaryError::Uncertain(TIMED_OUT.into()),
        None => SummaryError::Failed(TIMED_OUT.into()),
    })
}

/// Cancel a run whose caller has stopped waiting, when the runner
/// serves `run.cancel`. Best effort: a cancel that fails is logged and
/// changes nothing else.
async fn cancel_waiting<C: RunnerClient>(client: &C, child: &Child, run_id: &str) -> bool {
    let Ok(cancelled) =
        tokio::time::timeout(CLEANUP_GRACE, client.cancel_child_run(child, run_id)).await
    else {
        return false;
    };
    match &cancelled {
        Ok(true) => tracing::info!(
            "ck-mc: child run {run_id} in {} no longer has a reader; cancelled it",
            child.session.session
        ),
        Ok(false) => {}
        Err(error) => tracing::warn!(
            "ck-mc: summarizer run {run_id} in {} was waiting without a reader; cancelling it failed: {error}",
            child.session.session
        ),
    }
    matches!(cancelled, Ok(true))
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

    /// A send the daemon refused because the runner was reloading, with
    /// proof it never left, ends in a short wait rather than a failure. One
    /// that may have reached the runner, or another route refusal, is not.
    #[test]
    fn a_send_refused_while_the_runner_reloads_waits() {
        use super::{send_refused, SummaryError};
        use crate::summary::account_wait::SendKind;
        for code in ["module_reloading", "target_unavailable"] {
            let mut error = crate::client::ClientError::new("route.open failed");
            error.code = Some(code.into());
            match send_refused(&error, SendKind::Dream) {
                SummaryError::NeverRan(wait) => {
                    assert_eq!(wait.code, code);
                    assert!(wait.until_ms > wait.at_ms);
                }
                other => panic!("{code}: {other:?}"),
            }
            error.outcome_unknown = true;
            assert!(matches!(
                send_refused(&error, SendKind::Dream),
                SummaryError::Failed(_)
            ));
        }
        let mut other = crate::client::ClientError::new("route.open failed");
        other.code = Some("target_not_found".into());
        assert!(matches!(
            send_refused(&other, SendKind::Dream),
            SummaryError::Failed(_)
        ));
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
