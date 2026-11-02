//! The runner: one session, played step by step from a script.
//!
//! The parts a compaction provider calls back into (reads, new views, the
//! current view, reminders) live in [`Host`], which shares the session's state
//! with [`Runner`]. The state is locked only for short, synchronous sections
//! and never across a call to the provider, so the provider can call back
//! while the runner waits on it.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use ck_contract_draft::notice::{
    Conditions, Event, NoticeAnswer, NoticeRequest, ENTRIES_BUDGET_BYTES,
};
use ck_contract_draft::part::{
    split_self_tag, tag_prefix, Part, PartBody, Sealing, ToolPart, ToolStatus,
};
use ck_contract_draft::read::{
    Entry, Head, NoticeOrigin, ReadPage, ReadRequest, Role, SessionRef, StepUsage,
};
use ck_contract_draft::ride::{RideAnswer, RideCause, RideRequest, CONTEXT_CEILING};
use ck_contract_draft::rules::{self, ProviderRules};
use ck_contract_draft::send::{Delivery, RunResult, RunResultRequest, SendAnswer, SendRequest};
use ck_contract_draft::setup::{ModelRef, SetupAnswer, SetupRequest};
use ck_contract_draft::view::{
    self, edits_for_transcript, AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest,
    RenderedMessage, View, ViewRefusal,
};
use serde_json::Value;

use crate::model::{Completion, Kind, MockModel, ModelError, Request};
use crate::script::{SelfTag, Step, ToolCall, Turn};
use crate::tokens;
use crate::transcript::Transcript;

/// How a session starts.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SessionConfig {
    pub session: SessionRef,
    pub preset: String,
    pub model: ModelRef,
    pub context_window: u64,
    pub output_reserve: u64,
    pub rules: ProviderRules,
    pub kind: Kind,
    /// The prompt-cache lifetime the runner requests, in milliseconds.
    pub cache_ttl_ms: u64,
    pub system_tokens: u64,
    /// The checkpoint numbers count from: 0 for a new session, the old highest
    /// number for a session moved in from a standalone host.
    pub tag_checkpoint: u64,
    /// The scenario clock at the start, in milliseconds since the Unix epoch.
    pub start_ms: u64,
    /// The session's project, as the route's scope would name it.
    #[serde(default)]
    pub project: Option<Project>,
    /// Real time each model request takes, in milliseconds. Over the real
    /// wire a provider works on a notice while the next request is out, as
    /// with a real model; in process it is 0, and tests wait on the provider
    /// instead.
    #[serde(default)]
    pub model_latency_ms: u64,
    /// A session moved in from a standalone host, as the move left it.
    #[serde(default)]
    pub moved_in: Option<MovedIn>,
}

/// What a move from a standalone host leaves in the runner: the old
/// messages, already summarized, and the first view, installed as the
/// session's current view. The old messages carry no tag numbers; numbering
/// continues from [`SessionConfig::tag_checkpoint`].
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct MovedIn {
    pub messages: Vec<(Role, String)>,
    pub view: View,
}

/// A call to the provider that did not get an answer.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CallError(pub String);

/// The compaction provider's text edits to a user message before it is
/// stored (the `pre_user` hook).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UserEdit {
    pub prepend: Option<String>,
    pub append: Option<String>,
}

/// Everything the runner calls on the compaction provider, for one session.
/// Each call goes over a route bound to that session, so no request names the
/// session: a transport over the subc daemon (the CortexKit module bus that
/// routes calls between module processes) binds its routes to it, and an
/// in-process provider is built for it.
pub trait Provider {
    fn setup(&self, request: SetupRequest) -> impl Future<Output = Result<SetupAnswer, CallError>>;
    fn notice(
        &self,
        request: NoticeRequest,
    ) -> impl Future<Output = Result<NoticeAnswer, CallError>>;
    fn ride(&self, request: RideRequest) -> impl Future<Output = Result<RideAnswer, CallError>>;
    /// A `ctx_*` tool call the model made; the answer is the tool's output.
    fn tool(&self, name: &str, input: &Value) -> impl Future<Output = Result<String, CallError>>;
    fn pre_user(&self, text: &str, now: u64) -> impl Future<Output = Result<UserEdit, CallError>>;
}

/// A session's project, as the daemon's scope stamp on its routes names it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Project {
    pub id: String,
    pub root: String,
}

/// What a scenario run observed, for its assertions.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Report {
    pub requests: Vec<RequestRecord>,
    /// Runs the runner refused rather than send over its limit.
    pub refusals: Vec<String>,
    /// Requests a model provider rejected. A correct provider and runner
    /// never cause one.
    pub model_errors: Vec<ModelError>,
    pub rides: Vec<RideRecord>,
    /// Views the runner refused, at publish or at a step boundary.
    pub view_refusals: Vec<ViewRefusal>,
    /// Calls to the provider that failed.
    pub call_errors: Vec<CallError>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RequestRecord {
    pub ordinal: u64,
    pub view: Option<u64>,
    pub usage: StepUsage,
    pub now: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RideRecord {
    pub cause: RideCause,
    pub got_view: bool,
}

impl Report {
    /// Requests that wrote more than `tokens` to the prompt cache: the
    /// expensive ones a scenario counts.
    pub fn cache_writes_over(&self, tokens: u64) -> usize {
        self.requests
            .iter()
            .filter(|record| record.usage.cache_write_tokens > tokens)
            .count()
    }
}

struct State {
    config: SessionConfig,
    transcript: Transcript,
    applied: Option<View>,
    /// A view accepted since the last request; it applies at the next step
    /// boundary.
    pending: Option<View>,
    /// Reasoning tokens per reasoning part, as reported when produced.
    reasoning_tokens: HashMap<String, u64>,
    reminders: Vec<SendRequest>,
    /// Runs the provider started in child sessions.
    runs: crate::child::Runs,
    responder: crate::child::Responder,
    seq: u64,
    /// The newest entry the provider was sent, and its checksum then.
    notified: Option<(u64, String)>,
    now: u64,
    last_send: Option<u64>,
    last_prompt_tokens: Option<u64>,
    /// A cache loss already known before the next request.
    forced_cause: Option<RideCause>,
    events: Vec<Event>,
}

impl State {
    fn conditions(&self) -> Conditions {
        Conditions {
            model: self.config.model.clone(),
            context_window: self.config.context_window,
            output_reserve: self.config.output_reserve,
            rules: self.config.rules,
            last_prompt_tokens: self.last_prompt_tokens,
        }
    }

    fn latest_version(&self) -> u64 {
        self.latest_view().map_or(0, |view| view.version)
    }

    fn latest_view(&self) -> Option<&View> {
        self.pending.as_ref().or(self.applied.as_ref())
    }

    /// Check a view a provider sent: what a runner must verify before it
    /// stores one.
    fn check(&self, view: &View) -> Result<(), ViewRefusal> {
        let latest = self.latest_version();
        if view.version <= latest {
            return Err(ViewRefusal::StaleVersion {
                version: view.version,
                latest,
            });
        }
        if !view.verify() {
            return Err(ViewRefusal::BadChecksum);
        }
        view::check_carried(self.latest_view(), view)?;
        let entries = self.transcript.entries();
        view::apply(entries, view)?;
        rules::check(entries, &view.edits, &self.config.rules).map_err(ViewRefusal::Rule)?;
        Ok(())
    }

    fn render(&self) -> Vec<RenderedMessage> {
        let entries = self.transcript.entries();
        let edits = self
            .applied
            .as_ref()
            .map(|view| edits_for_transcript(entries, &view.edits))
            .unwrap_or_default();
        view::apply_edits(entries, &edits)
            .expect("an applied view stays valid for the transcript it was checked against")
    }
}

/// The runner side a compaction provider calls into.
#[derive(Clone)]
pub struct Host {
    state: Arc<Mutex<State>>,
}

impl Host {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("runner state lock")
    }

    /// `session.read`.
    pub fn read(&self, request: &ReadRequest) -> ReadPage {
        let state = self.lock();
        let (entries, next_after) =
            state
                .transcript
                .read(&request.select, request.detail, request.max_bytes);
        ReadPage {
            entries,
            next_after,
            head: Head {
                newest: state.transcript.cursor(),
                applied_view: state.applied.as_ref().map(View::applied),
            },
        }
    }

    /// `session.apply_view`: check the view and store it for the next step.
    pub fn apply_view(&self, request: ApplyViewRequest) -> ApplyViewAnswer {
        let mut state = self.lock();
        match state.check(&request.view) {
            Ok(()) => {
                state.pending = Some(request.view);
                ApplyViewAnswer::Accepted
            }
            Err(refusal) => ApplyViewAnswer::Refused { refusal },
        }
    }

    /// `session.applied_view`.
    pub fn applied_view(&self) -> AppliedViewAnswer {
        AppliedViewAnswer {
            view: self.lock().applied.clone(),
        }
    }

    /// `session.send`: queue a reminder, or start a run in a child session.
    pub fn send(&self, request: SendRequest) -> SendAnswer {
        let mut state = self.lock();
        if request.run.is_some() {
            let responder = state.responder.clone();
            let run_id = state.runs.start(request, &responder);
            return SendAnswer::Active { run_id };
        }
        state.reminders.push(request);
        SendAnswer::Queued
    }

    /// `run.result`.
    pub fn run_result(&self, request: &RunResultRequest) -> Option<RunResult> {
        self.lock().runs.result(&request.run_id)
    }

    /// Every run started in a child session, for assertions.
    pub fn child_runs(&self) -> Vec<crate::child::ChildRun> {
        self.lock().runs.all().to_vec()
    }

    /// Answer child runs with `responder` from now on.
    pub fn set_responder(&self, responder: crate::child::Responder) {
        self.lock().responder = responder;
    }

    pub fn session(&self) -> SessionRef {
        self.lock().config.session.clone()
    }

    /// The transcript as stored, for assertions.
    pub fn entries(&self) -> Vec<Entry> {
        self.lock().transcript.entries().to_vec()
    }

    /// What the model sees now, for assertions.
    pub fn rendered(&self) -> Vec<RenderedMessage> {
        self.lock().render()
    }

    pub fn applied_version(&self) -> Option<u64> {
        self.lock().applied.as_ref().map(|view| view.version)
    }
}

/// Plays a session against a compaction provider.
pub struct Runner<P> {
    host: Host,
    model: MockModel,
    provider: P,
    pub report: Report,
}

/// The step every scripted model request advances the clock by.
const STEP_MS: u64 = 2_000;
/// How long the runner waits on a ride, and on one after a cold start, when
/// the provider may first have to read the transcript.
const RIDE_DEADLINE_MS: u64 = 5_000;
const COLD_RIDE_DEADLINE_MS: u64 = 30_000;

impl<P: Provider> Runner<P> {
    /// Start a session: Setup, nothing else.
    pub async fn start(config: SessionConfig, provider: P) -> Result<Self, CallError> {
        let model = MockModel::new(config.kind, config.cache_ttl_ms);
        let mut transcript = Transcript::new(config.tag_checkpoint);
        let mut applied = None;
        if let Some(moved) = &config.moved_in {
            for (role, text) in &moved.messages {
                transcript.append_unnumbered(*role, text, config.start_ms);
            }
            applied = Some(moved.view.clone());
        }
        let state = State {
            transcript,
            now: config.start_ms,
            config,
            applied,
            pending: None,
            reasoning_tokens: HashMap::new(),
            reminders: Vec::new(),
            runs: crate::child::Runs::default(),
            responder: crate::child::scripted_summarizer(),
            seq: 0,
            notified: None,
            last_send: None,
            last_prompt_tokens: None,
            forced_cause: None,
            events: Vec::new(),
        };
        let runner = Self {
            host: Host {
                state: Arc::new(Mutex::new(state)),
            },
            model,
            provider,
            report: Report::default(),
        };
        runner.setup().await?;
        Ok(runner)
    }

    pub fn host(&self) -> &Host {
        &self.host
    }

    pub fn provider(&self) -> &P {
        &self.provider
    }

    async fn setup(&self) -> Result<SetupAnswer, CallError> {
        let request = {
            let state = self.host.lock();
            SetupRequest {
                preset: state.config.preset.clone(),
                model: state.config.model.clone(),
                context_window: state.config.context_window,
                output_reserve: state.config.output_reserve,
                rules: state.config.rules,
                applied_view: state.applied.as_ref().map(View::applied),
                newest: state.transcript.cursor(),
                now: state.now,
            }
        };
        self.provider.setup(request).await
    }

    /// Play a script. Stops early only when the runner refuses a run or a
    /// model provider rejects a request; both are in the report.
    pub async fn play(&mut self, steps: &[Step]) {
        for step in steps {
            let keep_going = match step {
                Step::User { text } => {
                    self.user(text).await;
                    true
                }
                Step::Model(turn) => self.model_step(turn).await,
                Step::Wait { ms } => {
                    self.host.lock().now += ms;
                    true
                }
                Step::ChangeModel {
                    model,
                    context_window,
                    output_reserve,
                    rules,
                } => {
                    let mut state = self.host.lock();
                    let cause = if state.config.model.provider != model.provider
                        || state.config.model.model != model.model
                    {
                        RideCause::ModelChange
                    } else {
                        RideCause::TierChange
                    };
                    state.config.model = model.clone();
                    state.config.context_window = *context_window;
                    state.config.output_reserve = *output_reserve;
                    state.config.rules = *rules;
                    state.forced_cause = Some(cause);
                    true
                }
                Step::Revert { ordinal } => {
                    {
                        let mut state = self.host.lock();
                        state.transcript.revert_to(*ordinal);
                        state.notified = None;
                        state.events.push(Event::TranscriptChanged {
                            from_ordinal: *ordinal,
                        });
                    }
                    self.notice().await;
                    true
                }
                Step::RestartRunner => {
                    {
                        let mut state = self.host.lock();
                        state.last_send = None;
                        state.forced_cause = Some(RideCause::CacheExpired);
                    }
                    if let Err(error) = self.setup().await {
                        self.report.call_errors.push(error);
                    }
                    true
                }
            };
            if !keep_going {
                return;
            }
        }
    }

    async fn user(&mut self, text: &str) {
        let now = self.host.lock().now;
        let edit = match self.provider.pre_user(text, now).await {
            Ok(edit) => edit,
            Err(error) => {
                // `pre_user` is best effort: the message goes out unchanged.
                self.report.call_errors.push(error);
                UserEdit::default()
            }
        };
        let full = [edit.prepend.as_deref(), Some(text), edit.append.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("");
        {
            let mut state = self.host.lock();
            let now = state.now;
            state.transcript.append(
                Role::User,
                None,
                vec![PartBody::Text { text: full }],
                None,
                None,
                now,
            );
        }
        self.notice().await;
    }

    /// One model request and the tool calls of its reply. Returns false when
    /// the run stops.
    async fn model_step(&mut self, turn: &Turn) -> bool {
        let latency = self.host.lock().config.model_latency_ms;
        if latency > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(latency)).await;
        }
        self.deliver_steers().await;
        self.step_boundary().await;

        let cause = {
            let mut state = self.host.lock();
            let empty = state.transcript.entries().is_empty();
            let expired = state
                .last_send
                .is_some_and(|last| state.now.saturating_sub(last) >= state.config.cache_ttl_ms);
            let cause = state
                .forced_cause
                .take()
                .or(expired.then_some(RideCause::CacheExpired));
            cause.filter(|_| !empty)
        };
        if let Some(cause) = cause {
            self.ride(cause, None).await;
        }

        let limit = {
            let state = self.host.lock();
            state.config.context_window - state.config.output_reserve
        };
        let mut estimate = self.estimate();
        if estimate > limit {
            self.ride(RideCause::OverLimit, Some(estimate)).await;
            estimate = self.estimate();
            if estimate > limit {
                self.report.refusals.push(CONTEXT_CEILING.to_owned());
                return false;
            }
        }

        let (completion, highest_tag) = {
            let state = self.host.lock();
            let messages = state.render();
            let highest_tag = messages
                .iter()
                .flat_map(|message| &message.parts)
                .filter_map(|part| part.tag)
                .max()
                .unwrap_or(0);
            let reasoning = &state.reasoning_tokens;
            let lookup = |id: &str| reasoning.get(id).copied().unwrap_or(0);
            let request = Request {
                messages: &messages,
                system_digest: "system-v1",
                system_tokens: state.config.system_tokens,
                window: state.config.context_window,
                now: state.now,
                reasoning_tokens: &lookup,
            };
            (self.model.complete(&request), highest_tag)
        };
        let completion = match completion {
            Ok(completion) => completion,
            Err(error) => {
                self.report.model_errors.push(error);
                return false;
            }
        };
        self.store_reply(turn, completion, highest_tag);
        self.notice().await;
        if !turn.tools.is_empty() {
            self.run_tools(&turn.tools).await;
            self.notice().await;
        }
        self.host.lock().now += STEP_MS;
        true
    }

    fn store_reply(&mut self, turn: &Turn, completion: Completion, highest_tag: u64) {
        let mut state = self.host.lock();
        let mut bodies = Vec::new();
        if let Some(tokens) = turn.reasoning_tokens {
            let sealing = match self.model.kind() {
                Kind::Anthropic => Sealing::Signed,
                Kind::OpenAi | Kind::OpenAiChained => Sealing::Encrypted,
            };
            let text = match self.model.kind() {
                Kind::Anthropic => Some(
                    turn.reasoning_text
                        .clone()
                        .unwrap_or_else(|| "x".repeat(tokens as usize * 4)),
                ),
                Kind::OpenAi | Kind::OpenAiChained => None,
            };
            bodies.push(PartBody::Reasoning {
                text_bytes: text.as_ref().map(|text| text.len() as u64),
                text,
                sealing,
            });
        }
        // The text exactly as the model wrote it, tag prefix included. The
        // transcript keeps it without the prefix; rendering puts the assigned
        // number back.
        let written = turn.text.as_ref().map(|text| match turn.self_tag {
            SelfTag::Next => format!("{}{text}", tag_prefix(highest_tag + 1)),
            SelfTag::Missing => text.clone(),
            SelfTag::Number(number) => format!("{}{text}", tag_prefix(number)),
        });
        if let Some(written) = &written {
            bodies.push(PartBody::Text {
                text: split_self_tag(written).1.to_owned(),
            });
        }
        let ordinal = state.transcript.entries().len();
        for (index, call) in turn.tools.iter().enumerate() {
            bodies.push(PartBody::Tool(ToolPart {
                call_id: format!("call-{ordinal}-{index}"),
                name: call.name.clone(),
                input: call.input.as_object().cloned().unwrap_or_default(),
                status: ToolStatus::Running,
                output: None,
                output_bytes: None,
                attachments: vec![],
            }));
        }
        let usage = StepUsage {
            output_tokens: turn.output_tokens + turn.reasoning_tokens.unwrap_or(0),
            reasoning_tokens: turn.reasoning_tokens,
            ..completion.usage
        };
        let generated_under = state.applied.as_ref().map(View::applied);
        let now = state.now;
        let entry = state
            .transcript
            .append(
                Role::Assistant,
                None,
                bodies,
                Some(usage),
                generated_under,
                now,
            )
            .clone();
        for part in &entry.parts {
            if let (PartBody::Text { .. }, Some(written)) = (&part.body, &written) {
                self.model.record_output(&part.id, written.clone());
            }
            if let PartBody::Reasoning { sealing, .. } = part.body {
                state
                    .reasoning_tokens
                    .insert(part.id.clone(), turn.reasoning_tokens.unwrap_or(0));
                if sealing == Sealing::Signed {
                    self.model.bind(&part.id, completion.binding.clone());
                }
            }
        }
        state.last_send = Some(now);
        state.last_prompt_tokens = Some(usage.prompt_tokens);
        self.report.requests.push(RequestRecord {
            ordinal: entry.ordinal,
            view: state.applied.as_ref().map(|view| view.version),
            usage,
            now,
        });
    }

    async fn run_tools(&mut self, calls: &[ToolCall]) {
        let call_ids: Vec<String> = {
            let state = self.host.lock();
            let entry = state
                .transcript
                .entries()
                .last()
                .expect("the reply was stored")
                .clone();
            entry
                .parts
                .iter()
                .filter_map(|part| match &part.body {
                    PartBody::Tool(tool) => Some(tool.call_id.clone()),
                    _ => None,
                })
                .collect()
        };
        for (call, call_id) in calls.iter().zip(call_ids) {
            let (status, mut output) = if call.name.starts_with("ctx_") {
                match self.provider.tool(&call.name, &call.input).await {
                    Ok(output) => (ToolStatus::Completed, output),
                    Err(error) => (ToolStatus::Error, error.0),
                }
            } else {
                (call.status, call.output.clone())
            };
            let mut state = self.host.lock();
            if let Some(index) = state
                .reminders
                .iter()
                .position(|reminder| reminder.delivery.first() == Some(&Delivery::ToolResult))
            {
                let reminder = state.reminders.remove(index);
                output.push_str("\n\n");
                output.push_str(&reminder.prompt);
            }
            state
                .transcript
                .complete_tool(&call_id, status, output, vec![])
                .expect("the call is running on the newest message");
        }
    }

    /// Store queued reminders that may only go out as a notice message. A
    /// reminder that may ride a tool result waits for one instead; with no
    /// tool call before the next request, it waits for the next tool result.
    async fn deliver_steers(&mut self) {
        let delivered = {
            let mut state = self.host.lock();
            let (steers, rest): (Vec<_>, Vec<_>) =
                state.reminders.drain(..).partition(|reminder| {
                    reminder.delivery.contains(&Delivery::Steer)
                        && !reminder.delivery.contains(&Delivery::ToolResult)
                });
            state.reminders = rest;
            let now = state.now;
            for reminder in &steers {
                state.transcript.append(
                    Role::User,
                    Some(NoticeOrigin {
                        sender: "magic-context".into(),
                        template: reminder.template.clone(),
                    }),
                    vec![PartBody::Text {
                        text: reminder.prompt.clone(),
                    }],
                    None,
                    None,
                    now,
                );
            }
            !steers.is_empty()
        };
        if delivered {
            self.notice().await;
        }
    }

    /// Apply the view that arrived since the last request.
    async fn step_boundary(&mut self) {
        let Some(view) = self.host.lock().pending.take() else {
            return;
        };
        self.adopt(view);
    }

    fn adopt(&mut self, view: View) {
        let checked = {
            let mut state = self.host.lock();
            // The transcript may have grown since the view was checked; check
            // again against what will be rendered.
            let previous = state.applied.take();
            let result = {
                let latest = previous.as_ref().map_or(0, |view| view.version);
                if view.version <= latest {
                    Err(ViewRefusal::StaleVersion {
                        version: view.version,
                        latest,
                    })
                } else {
                    view::check_carried(previous.as_ref(), &view)
                        .and_then(|()| view::apply(state.transcript.entries(), &view).map(|_| ()))
                        .and_then(|()| {
                            rules::check(
                                state.transcript.entries(),
                                &view.edits,
                                &state.config.rules,
                            )
                            .map_err(ViewRefusal::Rule)
                        })
                }
            };
            match result {
                Ok(()) => {
                    state.applied = Some(view.clone());
                    Ok(())
                }
                Err(refusal) => {
                    state.applied = previous;
                    Err(refusal)
                }
            }
        };
        if let Err(refusal) = checked {
            self.refuse_at_boundary(view.version, refusal);
        }
    }

    fn refuse_at_boundary(&mut self, version: u64, refusal: ViewRefusal) {
        self.report.view_refusals.push(refusal.clone());
        self.host
            .lock()
            .events
            .push(Event::ViewRefused { version, refusal });
    }

    async fn ride(&mut self, cause: RideCause, request_tokens: Option<u64>) {
        let request = {
            let state = self.host.lock();
            RideRequest {
                cause,
                deadline_ms: if state.last_send.is_none() {
                    COLD_RIDE_DEADLINE_MS
                } else {
                    RIDE_DEADLINE_MS
                },
                conditions: state.conditions(),
                applied_view: state.applied.as_ref().map(View::applied),
                request_tokens,
            }
        };
        let answer = self.provider.ride(request).await;
        let got_view = match answer {
            Ok(RideAnswer::Nothing) => false,
            Ok(RideAnswer::View { view }) => {
                // A view handed over earlier but not yet applied is
                // superseded by the ride's answer.
                self.host.lock().pending = None;
                self.adopt(view);
                true
            }
            Err(error) => {
                self.report.call_errors.push(error);
                false
            }
        };
        self.report.rides.push(RideRecord { cause, got_view });
    }

    fn estimate(&self) -> u64 {
        let state = self.host.lock();
        let messages = state.render();
        let reasoning = &state.reasoning_tokens;
        state.config.system_tokens
            + tokens::messages_tokens(&messages, |id: &str| {
                reasoning.get(id).copied().unwrap_or(0)
            })
    }

    /// Tell the provider what was written since the last notice.
    async fn notice(&mut self) {
        let request = {
            let mut state = self.host.lock();
            let Some(newest) = state.transcript.cursor() else {
                return;
            };
            let entries: Vec<Entry> = state
                .transcript
                .entries()
                .iter()
                .filter(|entry| match &state.notified {
                    None => true,
                    Some((ordinal, digest)) => {
                        entry.ordinal > *ordinal
                            || (entry.ordinal == *ordinal && &entry.digest != digest)
                    }
                })
                .map(|entry| Entry {
                    parts: entry.parts.iter().map(Part::compact).collect(),
                    ..entry.clone()
                })
                .collect();
            let size = serde_json::to_vec(&entries)
                .expect("entries serialize")
                .len();
            state.seq += 1;
            state.notified = Some((newest.ordinal, newest.digest.clone()));
            NoticeRequest {
                seq: state.seq,
                newest,
                applied_view: state.applied.as_ref().map(View::applied),
                conditions: state.conditions(),
                events: std::mem::take(&mut state.events),
                entries: if size > ENTRIES_BUDGET_BYTES {
                    Vec::new()
                } else {
                    entries
                },
            }
        };
        match self.provider.notice(request.clone()).await {
            Ok(NoticeAnswer::Received) => {}
            // The provider restarted: Setup again, then send the same notice,
            // with every entry so it can start from the whole transcript.
            Ok(NoticeAnswer::SetupRequired) => {
                if let Err(error) = self.setup().await {
                    self.report.call_errors.push(error);
                    return;
                }
                if let Err(error) = self.provider.notice(request).await {
                    self.report.call_errors.push(error);
                }
            }
            Err(error) => self.report.call_errors.push(error),
        }
    }
}

/// A part body for tests and scenarios: a finished tool part as a host would
/// store it.
pub fn finished_tool(call_id: &str, name: &str, input: Value, output: &str) -> PartBody {
    PartBody::Tool(ToolPart {
        call_id: call_id.into(),
        name: name.into(),
        input: input.as_object().cloned().unwrap_or_default(),
        status: ToolStatus::Completed,
        output_bytes: Some(output.len() as u64),
        output: Some(output.into()),
        attachments: vec![],
    })
}
