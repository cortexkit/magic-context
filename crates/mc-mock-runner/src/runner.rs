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
use std::time::Instant;

use cortexkit_compaction_view::clean::clean_reply;
use cortexkit_compaction_view::render::{self as view, edits_for_transcript, RenderedMessage};
use cortexkit_compaction_view::tags::tag_prefix;
use cortexkit_role_compaction::notice::{
    Conditions, Event, NoticeAnswer, NoticeRequest, ENTRIES_BUDGET_BYTES,
};
use cortexkit_role_compaction::part::{
    Attachment, AttachmentItem, Delivered, FileMedia, Part, PartBody, Seal, ToolPart, ToolStatus,
};
use cortexkit_role_compaction::read::{
    Entry, Head, NoticeOrigin, ReadPage, ReadRequest, Role, SessionRef, StepUsage,
};
use cortexkit_role_compaction::ride::{RideAnswer, RideCause, RideRequest, CONTEXT_CEILING};
use cortexkit_role_compaction::rules::ProviderRules;
use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, EditOp, View, ViewRefusal,
};
use cortexkit_role_compaction::wire::{codes, Refusal};
use cortexkit_role_llm_runner::delivery_order::{Mode, Template, TemplateUse};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
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
    /// The templates the session's plan admits from the compaction provider
    /// (its `senders` entry). A reminder send names one of them.
    #[serde(default)]
    pub templates: Vec<Template>,
    /// Whether the session's model reads images, as Setup and notices report
    /// it; `None` when the runner doesn't know.
    #[serde(default)]
    pub accepts_images: Option<bool>,
    /// Opt in to checksummed anchors and render-time signed-part stripping.
    /// False omits the Setup member and emulates a pre-anchor runner.
    #[serde(default = "anchor_enabled")]
    pub view_anchor: bool,
}

fn anchor_enabled() -> bool {
    true
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

/// A call to the provider that did not get an answer: refused by name
/// (`code`, from the provider's error frame), or failed in transport.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CallError {
    pub code: Option<String>,
    pub message: String,
}

impl CallError {
    /// A failure with no refusal code.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// A refusal the provider named.
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.into()),
            message: message.into(),
        }
    }

    fn is(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

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
    /// The child sessions the provider ran in (its summarizer runs), in
    /// order.
    #[serde(default)]
    pub child_runs: Vec<String>,
    /// Each message a person wrote, as stored after the `pre_user` hook.
    #[serde(default)]
    pub user_texts: Vec<String>,
    /// The plan template of every send delivered with a tool result, in
    /// order.
    #[serde(default)]
    pub delivered_templates: Vec<String>,
    /// Real wire timings and payload observations, only when explicitly enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observations: Option<Observations>,
}

/// Wall-clock measurements, independent of the script's simulated clock.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Observations {
    pub setups: Vec<SetupObservation>,
    pub views: Vec<ViewObservation>,
    pub tools: Vec<ToolObservation>,
    pub children: Vec<ChildObservation>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SetupObservation {
    pub elapsed_ms: f64,
    pub answer: Value,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ViewObservation {
    pub version: u64,
    /// Milliseconds since Runner started, at accepted publication or ride reply.
    pub published_ms: f64,
    pub adopted_ms: Option<f64>,
    /// Only the first view retains inserted text and image counts, not image
    /// payloads: large images can otherwise exhaust the report's wire frame budget.
    pub inserted_text: Vec<String>,
    pub image_count: usize,
    /// Every edit of the view in one short line each: the version that
    /// introduced it, its kind, what it targets and a hash of the whole op.
    /// Comparing two views' lists shows what a publication changed without
    /// carrying the edits' payloads.
    #[serde(default)]
    pub edits: Vec<String>,
}

/// One edit as a short, comparable line.
fn edit_line(edit: &cortexkit_role_compaction::view::Edit) -> String {
    use std::hash::{Hash as _, Hasher as _};
    let op = serde_json::to_string(&edit.op).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    op.hash(&mut hasher);
    let target = match &edit.op {
        EditOp::Insert { message, .. } => format!("insert {}", message.id),
        EditOp::Cut { through } => format!("cut {through}"),
        EditOp::Drop { mid, part } => format!("drop {mid}/{}", part.as_deref().unwrap_or("*")),
        EditOp::Replace {
            mid, part, field, ..
        } => format!("replace {mid}/{part}.{field}"),
        _ => "other".to_owned(),
    };
    format!("{} {target} {:016x}", edit.since, hasher.finish())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ToolObservation {
    pub name: String,
    pub elapsed_ms: f64,
    pub output: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ChildObservation {
    pub session: String,
    pub started_ms: f64,
    /// Time spent answering session.send, including the mock child responder.
    pub elapsed_ms: f64,
}

struct ObservationLog {
    started: Instant,
    values: Observations,
}

impl ObservationLog {
    fn publish(&mut self, view: &View) {
        if self
            .values
            .views
            .iter()
            .any(|seen| seen.version == view.version)
        {
            return;
        }
        let mut record = ViewObservation {
            version: view.version,
            published_ms: self.started.elapsed().as_secs_f64() * 1_000.0,
            adopted_ms: None,
            inserted_text: Vec::new(),
            image_count: 0,
            edits: view.edits.iter().map(edit_line).collect(),
        };
        if self.values.views.is_empty() {
            for edit in &view.edits {
                if let EditOp::Insert { message, .. } = &edit.op {
                    record.inserted_text.extend(message.texts.clone());
                    record.image_count += message.images.len();
                }
            }
        }
        self.values.views.push(record);
    }
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
    pub causes: Vec<RideCause>,
    pub got_view: bool,
}

impl RideRecord {
    pub fn has(&self, cause: RideCause) -> bool {
        self.causes.contains(&cause)
    }
}

impl Report {
    /// Requests that wrote more than `tokens` to the prompt cache: the
    /// expensive ones a scenario counts.
    pub fn cache_writes_over(&self, tokens: u64) -> usize {
        self.requests
            .iter()
            .filter(|record| record.usage.cache_write_tokens.unwrap_or(0) > tokens)
            .count()
    }
}

struct State {
    notice_keep: bool,
    observations: Option<ObservationLog>,
    config: SessionConfig,
    transcript: Transcript,
    applied: Option<View>,
    /// A view accepted since the last request; it applies at the next step
    /// boundary.
    pending: Option<View>,
    /// How many of the next views to refuse at the step boundary, after
    /// accepting them, as a runner whose transcript moved on would: for
    /// tests of a provider's rollback.
    refuse_at_boundary: u32,
    /// Refuse, at the step boundary, every view with an edit of the part
    /// numbered with this tag, as a runner would that keeps finding that
    /// part changed: for tests of a refusal that would repeat.
    refuse_tag_at_boundary: Option<u64>,
    /// Reasoning tokens per reasoning part, as reported when produced.
    reasoning_tokens: HashMap<String, u64>,
    reminders: Vec<Reminder>,
    /// Runs the provider started in child sessions.
    runs: crate::child::Runs,
    responder: crate::child::Responder,
    seq: u64,
    /// The newest entry the provider was sent, and its checksum then.
    notified: Option<(u64, String)>,
    now: u64,
    last_send: Option<u64>,
    last_prompt_tokens: Option<u64>,
    /// The view version the request `last_prompt_tokens` measured was
    /// rendered with, 0 for none; `None` when the runner can't tie the
    /// reading to a request, as after its restart.
    last_prompt_view: Option<u64>,
    /// Report each model step late: its notice goes only after the next
    /// step has applied its view and rendered its request, as a runner does
    /// whose notices trail its requests. A view the provider hands over in
    /// answer to such a notice is accepted while a request is in flight.
    lag_notices: bool,
    /// A step's notice that [`State::lag_notices`] holds back.
    notice_owed: bool,
    /// A cache loss already known before the next request.
    forced_cause: Option<RideCause>,
    events: Vec<Event>,
    /// Whether the provider manages the session; false after it refused
    /// Setup with `unknown_preset`.
    compaction: bool,
    /// The provider lost the session; Setup goes before the next notice.
    setup_due: bool,
}

impl State {
    fn conditions(&self) -> Conditions {
        let mut conditions = Conditions::new(
            self.config.model.clone(),
            self.config.context_window,
            self.config.output_reserve,
            self.config.rules.clone(),
        );
        conditions.last_prompt_tokens = self.last_prompt_tokens;
        // Sent only with the reading it describes (compaction contract,
        // `Conditions`).
        if self.last_prompt_tokens.is_some() {
            conditions.last_prompt_view = self.last_prompt_view;
        }
        conditions.accepts_images = self.config.accepts_images;
        conditions
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
        self.verify(view)?;
        view::check_carried(self.latest_view(), view)?;
        let entries = self.transcript.entries();
        // broca refuses a cut through the transcript's newest message, so its
        // requests always end with a message shown as it is. The mock holds
        // ck-mc to the same rule.
        let newest = entries.last().map(|entry| entry.mid.as_str());
        if view.edits.iter().any(
            |edit| matches!(&edit.op, EditOp::Cut { through } if Some(through.as_str()) == newest),
        ) {
            return Err(ViewRefusal::Unknown {
                name: "cut_through_newest".into(),
                fields: serde_json::Map::new(),
            });
        }
        self.plan(view)?;
        Ok(())
    }

    fn verify(&self, candidate: &View) -> Result<(), ViewRefusal> {
        let valid = if self.config.view_anchor {
            candidate.verify()
        } else {
            // Older runners decode only version and edits when verifying a
            // checksum, even if an unknown policy member was sent on the wire.
            candidate.checksum == View::seal(candidate.version, candidate.edits.clone()).checksum
        };
        if valid {
            Ok(())
        } else {
            Err(ViewRefusal::BadChecksum)
        }
    }

    fn plan(&self, candidate: &View) -> Result<(), ViewRefusal> {
        self.verify(candidate)?;
        let entries = self.transcript.entries();
        if self.config.view_anchor {
            view::plan_view(entries, candidate, &self.config.rules)?;
        } else {
            view::plan(entries, &candidate.edits)?;
            cortexkit_compaction_view::rules::check(entries, &candidate.edits, &self.config.rules)
                .map_err(ViewRefusal::Rule)?;
        }
        Ok(())
    }

    fn render(&self) -> Vec<RenderedMessage> {
        let entries = self.transcript.entries();
        let candidate = self
            .applied
            .as_ref()
            .map(|applied| {
                View::seal_with_policy(
                    applied.version,
                    edits_for_transcript(entries, &applied.edits),
                    applied.built_through.clone(),
                    applied.new_signed.clone(),
                )
            })
            .unwrap_or_else(|| View::seal(1, vec![]));
        let rendered = if self.config.view_anchor {
            view::apply_with_rules(entries, &candidate, &self.config.rules)
        } else {
            view::apply(entries, &candidate)
        };
        rendered.expect("an applied view stays valid for the transcript it was checked against")
    }
}

/// The runner side a compaction provider calls into.
#[derive(Clone)]
pub struct Host {
    state: Arc<Mutex<State>>,
}

impl Host {
    /// Change the optional declaration before the next Setup, as a runner
    /// upgrade would. Existing sessions keep their transcript marks.
    pub fn declare_notice_keep(&self, declared: bool) {
        self.lock().notice_keep = declared;
    }

    pub fn describe(&self) -> Value {
        let capabilities = if self.lock().notice_keep {
            vec!["cache_policy", "message_marks", "notice_keep"]
        } else {
            vec!["cache_policy"]
        };
        serde_json::json!({"capabilities": capabilities})
    }

    /// Store an inbox notice as core would deliver it, outside a model reply.
    pub fn append_notice(&self, text: &str, keep: bool) {
        let mut state = self.lock();
        assert!(!keep || state.notice_keep, "keep requires notice_keep");
        let mut origin = NoticeOrigin::new("prefrontal");
        origin.keep = keep;
        let now = state.now;
        state.transcript.append(
            Role::User,
            Some(origin),
            vec![(Seal::None, PartBody::Text { text: text.into() })],
            None,
            None,
            now,
        );
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("runner state lock")
    }

    /// `session.read`.
    pub fn read(&self, request: &ReadRequest) -> Result<ReadPage, Refusal> {
        let state = self.lock();
        let (entries, next_after) =
            state
                .transcript
                .read(&request.select, request.detail, request.max_bytes)?;
        let mut head = Head::new();
        head.newest = state.transcript.cursor();
        head.applied_view = state.applied.as_ref().map(View::applied);
        let mut page = ReadPage::new(entries, head);
        page.next_after = next_after;
        Ok(page)
    }

    /// `session.apply_view`: check the view and store it for the next step.
    pub fn apply_view(&self, request: ApplyViewRequest) -> ApplyViewAnswer {
        let mut state = self.lock();
        match state.check(&request.view) {
            Ok(()) => {
                if let Some(log) = &mut state.observations {
                    log.publish(&request.view);
                }
                state.pending = Some(request.view);
                ApplyViewAnswer::Accepted
            }
            Err(refusal) => ApplyViewAnswer::Refused { refusal },
        }
    }

    /// `session.applied_view`.
    pub fn applied_view(&self) -> AppliedViewAnswer {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.lock().applied.clone();
        answer
    }

    /// `session.send` on a route bound to `bound_session`: a run in a child
    /// session of the provider's own, or a reminder for this session. A
    /// reminder must name its delivery modes (`delivery_order`); the mock
    /// delivers `tool_result` and `steer`. A newer reminder with the same
    /// `dedupe_key` replaces a queued one.
    ///
    /// As llm-runner classifies sends: a send naming a plan template is a
    /// notice from its sender, rendered when it is delivered; any other send
    /// is stored as a person's message, whoever sent it.
    pub fn send(&self, bound_session: &str, request: SendRequest) -> Result<SendReply, Refusal> {
        let mut state = self.lock();
        if bound_session != state.config.session.session {
            let started = Instant::now();
            let responder = state.responder.clone();
            let run_id = state
                .runs
                .start(bound_session, request, &responder)
                .map_err(|(field, error)| Refusal::invalid_params(field, error))?;
            if let Some(log) = &mut state.observations {
                log.values.children.push(ChildObservation {
                    session: bound_session.to_owned(),
                    started_ms: started.duration_since(log.started).as_secs_f64() * 1_000.0,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
                });
            }
            let mut reply = SendReply::new(cortexkit_role_llm_runner::run::states::ACTIVE);
            reply.run_id = Some(run_id);
            return Ok(reply);
        }
        let order = request
            .delivery_order()
            .map_err(|field| Refusal::invalid_params(field, "malformed delivery"))?
            .ok_or_else(|| Refusal::invalid_params("delivery", "a reminder names its modes"))?;
        if let Some(template) = &order.template {
            // Refused at admission when it cannot render, as a runner does.
            render(&state.config.templates, template, &state.transcript)
                .map_err(|problem| Refusal::invalid_params("template", format!("{problem:?}")))?;
        }
        let reminder = Reminder {
            prompt: request.prompt.clone(),
            template: order.template.clone(),
            modes: order.modes.clone(),
            dedupe_key: order.dedupe_key.clone(),
        };
        if let Some(key) = &reminder.dedupe_key {
            state
                .reminders
                .retain(|queued| queued.dedupe_key.as_ref() != Some(key));
        }
        state.reminders.push(reminder);
        Ok(SendReply::new("pending"))
    }

    /// `run.result`.
    pub fn run_result(&self, request: &RunResultRequest) -> Option<RunResult> {
        self.lock().runs.result(&request.run_id)
    }

    /// The folder of the session's project, if it has one.
    pub fn project_root(&self) -> Option<String> {
        self.lock()
            .config
            .project
            .as_ref()
            .map(|project| project.root.clone())
    }

    /// Every run started in a child session, for assertions.
    pub fn child_runs(&self) -> Vec<crate::child::ChildRun> {
        self.lock().runs.all().to_vec()
    }

    pub fn observations(&self) -> Option<Observations> {
        self.lock()
            .observations
            .as_ref()
            .map(|log| log.values.clone())
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

    /// Refuse the next `count` views at the step boundary, after accepting
    /// them in `session.apply_view`, with a `view_refused` event.
    pub fn refuse_at_boundary(&self, count: u32) {
        self.lock().refuse_at_boundary = count;
    }

    /// Refuse, at the step boundary, every view that edits the part with
    /// `tag` (`stale_part`).
    pub fn refuse_tag_at_boundary(&self, tag: u64) {
        self.lock().refuse_tag_at_boundary = Some(tag);
    }

    pub fn applied_version(&self) -> Option<u64> {
        self.lock().applied.as_ref().map(|view| view.version)
    }

    /// From now on, send each model step's notice only after the next step
    /// has applied its view and rendered its request (see
    /// [`State::lag_notices`]). A notice still held when a script ends goes
    /// out then.
    pub fn lag_notices(&self, lag: bool) {
        self.lock().lag_notices = lag;
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
        Self::start_with_observations(config, provider, false).await
    }

    /// Enable payload/timing capture without changing the scenario or its clock.
    pub async fn start_observed(config: SessionConfig, provider: P) -> Result<Self, CallError> {
        Self::start_with_observations(config, provider, true).await
    }

    async fn start_with_observations(
        config: SessionConfig,
        provider: P,
        observe: bool,
    ) -> Result<Self, CallError> {
        let model = MockModel::new(config.kind, config.cache_ttl_ms);
        let mut transcript = Transcript::new(config.tag_checkpoint);
        let mut applied = None;
        if let Some(moved) = &config.moved_in {
            // As THALAMUS's runner does, a moved session's numbering starts at
            // the moved view's cut: messages through it stay unnumbered, and
            // the parts of any moved message after it are numbered from the
            // checkpoint up, before the first new message.
            let cut = moved.view.edits.iter().find_map(|edit| match &edit.op {
                EditOp::Cut { through } => Some(through.clone()),
                _ => None,
            });
            let mut past_cut = cut.is_none();
            for (role, text) in &moved.messages {
                if past_cut {
                    let body = PartBody::Text { text: text.clone() };
                    transcript.append(
                        role.clone(),
                        None,
                        vec![(Seal::None, body)],
                        None,
                        None,
                        config.start_ms,
                    );
                } else {
                    let entry = transcript.append_unnumbered(role.clone(), text, config.start_ms);
                    past_cut = Some(&entry.mid) == cut.as_ref();
                }
            }
            // The same rule `check` applies to every later view: broca refuses
            // to install a moved view that cuts through the newest message.
            let newest = transcript.entries().last().map(|entry| entry.mid.clone());
            assert!(
                !moved.view.edits.iter().any(|edit| matches!(
                    &edit.op,
                    EditOp::Cut { through } if Some(through) == newest.as_ref()
                )),
                "cut_through_newest: the moved view cuts through the newest message"
            );
            applied = Some(moved.view.clone());
        }
        let state = State {
            notice_keep: false,
            observations: observe.then(|| ObservationLog {
                started: Instant::now(),
                values: Observations::default(),
            }),
            transcript,
            now: config.start_ms,
            config,
            applied,
            pending: None,
            refuse_at_boundary: 0,
            refuse_tag_at_boundary: None,
            reasoning_tokens: HashMap::new(),
            reminders: Vec::new(),
            runs: crate::child::Runs::default(),
            responder: crate::child::scripted_summarizer(),
            seq: 0,
            notified: None,
            last_send: None,
            last_prompt_tokens: None,
            last_prompt_view: None,
            lag_notices: false,
            notice_owed: false,
            forced_cause: None,
            events: Vec::new(),
            compaction: true,
            setup_due: false,
        };
        let mut runner = Self {
            host: Host {
                state: Arc::new(Mutex::new(state)),
            },
            model,
            provider,
            report: Report::default(),
        };
        match runner.setup().await {
            Ok(_) => {}
            // The provider has no such preset: the session runs without
            // compaction (compaction contract W1.3).
            Err(error) if error.is(codes::UNKNOWN_PRESET) => {
                runner.host.lock().compaction = false;
                runner.report.call_errors.push(error);
            }
            Err(error) => return Err(error),
        }
        Ok(runner)
    }

    pub fn host(&self) -> &Host {
        &self.host
    }

    pub fn provider(&self) -> &P {
        &self.provider
    }

    /// Setup, which restarts the notice count on both sides (compaction contract S3).
    async fn setup(&self) -> Result<SetupAnswer, CallError> {
        let request = {
            let mut state = self.host.lock();
            state.seq = 0;
            state.setup_due = false;
            let mut request = SetupRequest::new(
                state.config.preset.clone(),
                state.config.model.clone(),
                state.config.context_window,
                state.config.output_reserve,
                state.config.rules.clone(),
                DETECTS.to_vec(),
                state.now,
            );
            request.applied_view = state.applied.as_ref().map(View::applied);
            request.newest = state.transcript.cursor();
            request.accepts_images = state.config.accepts_images;
            request.view_anchor = state.config.view_anchor.then_some(true);
            request
        };
        let started = Instant::now();
        let answer = self.provider.setup(request).await;
        if let Some(log) = &mut self.host.lock().observations {
            log.values.setups.push(SetupObservation {
                elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
                answer: match &answer {
                    Ok(answer) => serde_json::to_value(answer).expect("Setup answer serializes"),
                    Err(error) => serde_json::json!({"error": error.message}),
                },
            });
        }
        answer
    }

    /// Play a script. Stops early only when the runner refuses a run or a
    /// model provider rejects a request; both are in the report.
    pub async fn play(&mut self, steps: &[Step]) {
        for step in steps {
            let keep_going = match step {
                Step::User { text } => {
                    self.user(text, 0).await;
                    true
                }
                Step::UserWithImages { text, images } => {
                    self.user(text, *images).await;
                    true
                }
                Step::Model(turn) => self.model_step(turn).await,
                Step::Wait { ms } => {
                    self.host.lock().now += ms;
                    true
                }
                Step::Await {
                    condition,
                    timeout_ms,
                } => self.await_condition(condition, *timeout_ms).await,
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
                    state.config.rules = rules.clone();
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
                        // The reading survives, but which request it measured
                        // does not.
                        state.last_prompt_view = None;
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
        if self.host.lock().notice_owed {
            self.notice().await;
        }
    }

    async fn await_condition(
        &mut self,
        condition: &crate::script::AwaitCondition,
        timeout_ms: u64,
    ) -> bool {
        use crate::script::AwaitCondition;
        use std::time::Duration;

        let wait = async {
            match condition {
                AwaitCondition::NoticesProcessed => {
                    // Unlike a notice acknowledgement, a tool reply comes from
                    // the session worker after earlier notices have been handled.
                    // Expanding raw history is read-only and does not add a turn.
                    self.provider
                        .tool("ctx_expand", &serde_json::json!({"start": 1, "end": 1}))
                        .await?;
                }
                AwaitCondition::ChildRuns { count } => {
                    while self.host.child_runs().len() < *count {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
            }
            Ok::<_, CallError>(())
        };
        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await;
        let error = match result {
            Ok(Ok(())) => return true,
            Ok(Err(error)) => CallError::new(format!("await {condition:?} failed: {error:?}")),
            Err(_) => CallError::new(format!(
                "await {condition:?} timed out after {timeout_ms} ms (observed {} child runs)",
                self.host.child_runs().len()
            )),
        };
        self.report.call_errors.push(error);
        false
    }

    async fn user(&mut self, text: &str, images: u64) {
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
            let mut parts = vec![(Seal::None, PartBody::Text { text: full })];
            parts.extend((0..images).map(|_| (Seal::None, PartBody::File(pasted_image()))));
            state
                .transcript
                .append(Role::User, None, parts, None, None, now);
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

        let cache_cause = {
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

        // One ride with every cause that applies. A view that answers a
        // cache loss can still leave the request too big (it may add the
        // summaries and memories a head's view inserts at the start), so the runner estimates again and rides once more
        // for the limit before it refuses.
        let limit = {
            let state = self.host.lock();
            state.config.context_window - state.config.output_reserve
        };
        let estimate = self.estimate();
        let mut causes: Vec<RideCause> = cache_cause.into_iter().collect();
        if estimate > limit {
            causes.push(RideCause::OverLimit);
        }
        if !causes.is_empty() {
            let over = causes.contains(&RideCause::OverLimit);
            self.ride(causes, over.then_some(estimate)).await;
            let estimate = self.estimate();
            if estimate > limit && !over {
                self.ride(vec![RideCause::OverLimit], Some(estimate)).await;
            }
            if self.estimate() > limit {
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
        // The previous step's notice, held back while this request went out.
        if self.host.lock().notice_owed {
            self.notice().await;
        }
        self.store_reply(turn, completion, highest_tag);
        let lag = self.host.lock().lag_notices;
        if lag {
            self.host.lock().notice_owed = true;
        } else {
            self.notice().await;
        }
        if !turn.tools.is_empty() {
            self.run_tools(&turn.tools).await;
            if !lag {
                self.notice().await;
            }
        }
        self.host.lock().now += STEP_MS;
        true
    }

    fn store_reply(&mut self, turn: &Turn, completion: Completion, highest_tag: u64) {
        let mut state = self.host.lock();
        let mut bodies = Vec::new();
        if let Some(tokens) = turn.reasoning_tokens {
            let seal = match self.model.kind() {
                Kind::Anthropic => Seal::Signed,
                Kind::OpenAi | Kind::OpenAiChained => Seal::Encrypted,
            };
            let text = match self.model.kind() {
                Kind::Anthropic => Some(
                    turn.reasoning_text
                        .clone()
                        .unwrap_or_else(|| "x".repeat(tokens as usize * 4)),
                ),
                Kind::OpenAi | Kind::OpenAiChained => None,
            };
            bodies.push((
                seal,
                PartBody::Reasoning {
                    text_bytes: text.as_ref().map(|text| text.len() as u64),
                    text,
                },
            ));
        }
        // The text exactly as the model wrote it, tag prefix included. The
        // transcript keeps it cleaned of tag notation; rendering puts the
        // assigned number back.
        let written = turn.text.as_ref().map(|text| match turn.self_tag {
            SelfTag::Next => format!("{}{text}", tag_prefix(highest_tag + 1)),
            SelfTag::Missing => text.clone(),
            SelfTag::Number(number) => format!("{}{text}", tag_prefix(number)),
        });
        if let Some(written) = &written {
            bodies.push((
                Seal::None,
                PartBody::Text {
                    text: clean_reply(written).text,
                },
            ));
        }
        let ordinal = state.transcript.entries().len();
        for (index, call) in turn.tools.iter().enumerate() {
            bodies.push((
                Seal::None,
                PartBody::Tool(ToolPart::new(
                    format!("call-{ordinal}-{index}"),
                    call.name.clone(),
                    call.input.clone(),
                    ToolStatus::Running,
                )),
            ));
        }
        let mut usage = completion.usage;
        usage.output_tokens = Some(turn.output_tokens + turn.reasoning_tokens.unwrap_or(0));
        usage.reasoning_tokens = turn.reasoning_tokens;
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
            if let PartBody::Reasoning { .. } = part.body {
                state
                    .reasoning_tokens
                    .insert(part.id.clone(), turn.reasoning_tokens.unwrap_or(0));
                if part.seal == Seal::Signed {
                    self.model.bind(&part.id, completion.binding.clone());
                }
            }
        }
        state.last_send = Some(now);
        state.last_prompt_tokens = usage.prompt_tokens;
        state.last_prompt_view = Some(state.applied.as_ref().map_or(0, |view| view.version));
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
            let started = Instant::now();
            let (status, output) = if call.name.starts_with("ctx_") {
                match self.provider.tool(&call.name, &call.input).await {
                    Ok(output) => (ToolStatus::Completed, output),
                    Err(error) => (ToolStatus::Error, error.message),
                }
            } else {
                (call.status.clone(), call.output.clone())
            };
            let mut state = self.host.lock();
            if let Some(log) = &mut state.observations {
                log.values.tools.push(ToolObservation {
                    name: call.name.clone(),
                    elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
                    output: output.clone(),
                });
            }
            // A reminder that may ride a tool result is delivered with this
            // one, after its output, in the tool part's delivered list.
            let mut delivered = Vec::new();
            if let Some(index) = state
                .reminders
                .iter()
                .position(|reminder| reminder.modes.first() == Some(&Mode::ToolResult))
            {
                let reminder = state.reminders.remove(index);
                let (text, template) = reminder.text(&state.config.templates, &state.transcript);
                let mut item = Delivered::new("magic-context", text);
                item.template = template;
                delivered.push(item);
            }
            state
                .transcript
                .complete_tool(
                    &call_id,
                    status,
                    output,
                    image_attachments(call.images),
                    delivered,
                )
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
                    reminder.modes.contains(&Mode::Steer)
                        && !reminder.modes.contains(&Mode::ToolResult)
                });
            state.reminders = rest;
            let now = state.now;
            for reminder in &steers {
                let (text, template) = reminder.text(&state.config.templates, &state.transcript);
                // Only a template send is a notice; a plain one reads as the
                // person's own message.
                let notice = template.clone().map(|template| {
                    let mut origin = NoticeOrigin::new("magic-context");
                    origin.template = Some(template);
                    origin
                });
                state.transcript.append(
                    Role::User,
                    notice,
                    vec![(Seal::None, PartBody::Text { text })],
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
            let forced = state.refuse_at_boundary > 0;
            if forced {
                state.refuse_at_boundary -= 1;
            }
            let stale = state.refuse_tag_at_boundary.and_then(|tag| {
                let (mid, part) = state.transcript.entries().iter().find_map(|entry| {
                    entry
                        .parts
                        .iter()
                        .find(|part| part.tag == Some(tag))
                        .map(|part| (entry.mid.clone(), part.id.clone()))
                })?;
                view.edits
                    .iter()
                    .any(|edit| match &edit.op {
                        EditOp::Drop {
                            mid: target,
                            part: Some(target_part),
                        }
                        | EditOp::Replace {
                            mid: target,
                            part: target_part,
                            ..
                        } => *target == mid && *target_part == part,
                        _ => false,
                    })
                    .then_some(ViewRefusal::StalePart { mid, part })
            });
            let result = {
                let latest = previous.as_ref().map_or(0, |view| view.version);
                if forced {
                    Err(ViewRefusal::BadSince)
                } else if let Some(refusal) = stale {
                    Err(refusal)
                } else if view.version <= latest {
                    Err(ViewRefusal::StaleVersion {
                        version: view.version,
                        latest,
                    })
                } else {
                    view::check_carried(previous.as_ref(), &view).and_then(|()| state.plan(&view))
                }
            };
            match result {
                Ok(()) => {
                    // A view with a cut has applied: write the host's marker
                    // at the cut and report it in the next notice (compaction contract M1).
                    let cut = view.edits.iter().find_map(|edit| match &edit.op {
                        EditOp::Cut { through } => Some(through.clone()),
                        _ => None,
                    });
                    if let Some(through) = cut {
                        if state.transcript.write_marker(&through).is_some() {
                            state.events.push(Event::MarkerWritten {
                                version: view.version,
                            });
                        }
                    }
                    state.applied = Some(view.clone());
                    if let Some(log) = &mut state.observations {
                        log.publish(&view);
                        if let Some(record) = log
                            .values
                            .views
                            .iter_mut()
                            .find(|v| v.version == view.version)
                        {
                            record.adopted_ms = Some(log.started.elapsed().as_secs_f64() * 1_000.0);
                        }
                    }
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

    async fn ride(&mut self, causes: Vec<RideCause>, request_tokens: Option<u64>) {
        let request = {
            let state = self.host.lock();
            if !state.compaction {
                return;
            }
            let deadline_ms = if state.last_send.is_none() {
                COLD_RIDE_DEADLINE_MS
            } else {
                RIDE_DEADLINE_MS
            };
            let mut request = RideRequest::new(causes.clone(), deadline_ms, state.conditions());
            request.applied_view = state.applied.as_ref().map(View::applied);
            request.request_tokens = request_tokens;
            request
        };
        // A late answer counts as none: the request goes out with the view
        // the runner has (compaction contract RD2).
        let deadline = std::time::Duration::from_millis(request.deadline_ms);
        let answer = tokio::time::timeout(deadline, self.provider.ride(request))
            .await
            .unwrap_or_else(|_| Err(CallError::new("no ride answer before its deadline")));
        let got_view = match answer {
            Ok(RideAnswer::Nothing) => false,
            Ok(RideAnswer::View { view }) => {
                // A view handed over earlier but not yet applied is
                // superseded by the ride's answer.
                self.host.lock().pending = None;
                self.adopt(view);
                true
            }
            // The provider no longer knows the session: counted as
            // `nothing`, and Setup goes before the next notice (compaction contract S1, F2).
            Err(error) if error.is(codes::UNKNOWN_SESSION) => {
                self.host.lock().setup_due = true;
                self.report.call_errors.push(error);
                false
            }
            Err(error) => {
                self.report.call_errors.push(error);
                false
            }
            // W1.5: an answer the runner doesn't know counts as `nothing`.
            Ok(_) => false,
        };
        self.report.rides.push(RideRecord { causes, got_view });
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
        let (compaction, setup_due) = {
            let state = self.host.lock();
            (state.compaction, state.setup_due)
        };
        if !compaction {
            return;
        }
        if setup_due {
            if let Err(error) = self.setup().await {
                self.report.call_errors.push(error);
                return;
            }
        }
        let request = {
            let mut state = self.host.lock();
            state.notice_owed = false;
            // An empty transcript, after a revert of every message, still
            // gets a notice, with no newest entry (compaction contract W4.1).
            let newest = state.transcript.cursor();
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
                .map(|entry| {
                    let mut compact = entry.clone();
                    compact.parts = entry.parts.iter().map(Part::compact).collect();
                    compact
                })
                .collect();
            let size = serde_json::to_vec(&entries)
                .expect("entries serialize")
                .len();
            state.seq += 1;
            state.notified = newest
                .as_ref()
                .map(|newest| (newest.ordinal, newest.digest.clone()));
            let mut request = NoticeRequest::new(state.seq, state.conditions());
            if let Some(newest) = newest {
                request = request.with_newest(newest);
            }
            request.applied_view = state.applied.as_ref().map(View::applied);
            request.events = std::mem::take(&mut state.events);
            if size <= ENTRIES_BUDGET_BYTES {
                request.entries = entries;
            }
            request
        };
        match self.provider.notice(request.clone()).await {
            Ok(NoticeAnswer::Received) => {}
            // The provider restarted: Setup again, then send the same notice,
            // with every entry so it can start from the whole transcript. An
            // answer the runner doesn't know is handled the same way (compaction contract W1.5).
            Ok(_) => {
                if let Err(error) = self.setup().await {
                    self.report.call_errors.push(error);
                    return;
                }
                // Setup restarted the count, so this is notice 1 again.
                let mut request = request;
                request.seq = {
                    let mut state = self.host.lock();
                    state.seq += 1;
                    state.seq
                };
                if let Err(error) = self.provider.notice(request).await {
                    self.report.call_errors.push(error);
                }
            }
            Err(error) => self.report.call_errors.push(error),
        }
    }
}

/// A reminder a provider queued, until it is delivered.
#[derive(Clone, Debug)]
struct Reminder {
    prompt: Option<String>,
    template: Option<TemplateUse>,
    modes: Vec<Mode>,
    dedupe_key: Option<String>,
}

impl Reminder {
    /// The text as delivered now, and the template it came from. A template
    /// renders each `part_tag` slot as the number the transcript gives that
    /// part.
    fn text(&self, templates: &[Template], transcript: &Transcript) -> (String, Option<String>) {
        match &self.template {
            Some(template) => (
                render(templates, template, transcript).unwrap_or_default(),
                Some(template.id.clone()),
            ),
            None => (self.prompt.clone().unwrap_or_default(), None),
        }
    }
}

/// `template` rendered from the plan's `templates`, with each part named by
/// a `part_tag` slot shown as its number.
fn render(
    templates: &[Template],
    template: &TemplateUse,
    transcript: &Transcript,
) -> Result<String, cortexkit_role_llm_runner::delivery_order::TemplateProblem> {
    cortexkit_role_llm_runner::delivery_order::render(templates, template, |part| {
        transcript
            .entries()
            .iter()
            .find(|entry| entry.mid == part.mid)
            .and_then(|entry| {
                entry
                    .parts
                    .iter()
                    .find(|candidate| candidate.id == part.part)
            })
            .and_then(|found| found.tag)
    })
}

/// The ride causes the mock runner detects and declares at Setup. Its model
/// providers keep no connection whose reset would lose the cache, and it has
/// no accounts or tool surfaces that change.
const DETECTS: [RideCause; 4] = [
    RideCause::CacheExpired,
    RideCause::ModelChange,
    RideCause::TierChange,
    RideCause::OverLimit,
];

/// A part body for tests and scenarios: a finished tool part as a host would
/// store it.
pub fn finished_tool(call_id: &str, name: &str, input: Value, output: &str) -> PartBody {
    PartBody::Tool(
        ToolPart::new(call_id, name, input, ToolStatus::Completed)
            .with_output(output)
            .with_output_bytes(output.len() as u64),
    )
}

/// An inline image as a person pastes one or a tool returns one: 200 KB of PNG.
fn pasted_image() -> FileMedia {
    FileMedia::inline("image/png", Some(200_000))
}

fn image_attachments(count: u64) -> Vec<Attachment> {
    (0..count)
        .map(|index| Attachment::new(format!("img-{index}"), AttachmentItem::File(pasted_image())))
        .collect()
}
