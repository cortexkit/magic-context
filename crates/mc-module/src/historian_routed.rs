//! Summaries placed by routing.
//!
//! A summary asks the one `routing/v1` provider where to run, under the
//! conversation's own scope, as consumer `mc.summary`. It sends to exactly the
//! runner and model routing answered, reports how the run went, and on a
//! failure asks again with that route excluded (the shared engine in
//! `model_work`). No model chain, runner setting or session model is read on
//! this path. With no routing provider the summary is refused by name and
//! nothing is sent.
//!
//! The system text comes from the `mc_summary` persona, rendered once per
//! conversation and stored in the session meta together with the generation
//! and routing settings rendered with it. Every later summary of the
//! conversation sends those stored bytes, even after a persona file changes, so
//! the provider's cached prefix for the summarizer stays the same.
//!
//! Until routed summaries are proven live, a summary takes this path only when
//! its transport's [`SummaryRouting::routing_support`] check passes
//! ([`choose_summary_path`]); otherwise it keeps the model-chain path. The
//! production transport does not pass yet, so production summaries still walk
//! the chain. This gate goes away with the chain path.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_persona::{ApprovalSet, PersonaError, Tier};
use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{Outcome, ReportAnswer, ReportRequest, Usage},
    select::{Requirements, ToolsRequirement},
};
use mc_store::{FrozenSummaryPersona, McStore, McStoreError};
use sha2::{Digest, Sha256};
use subc_protocol::scope::{ScopeSelector, ScopeStamp};

use crate::historian::{
    HistorianDriveError, HistorianDriveOutcome, HistorianModelLimits, HistorianProducerDriver,
    HistorianPublicationFence, HistorianRunSuccess,
};
use crate::historian_chunk::AssembledHistorianFiring;
use crate::historian_producer::{
    HistorianProducerError, ProducerErrorBody, ProducerOutput, RunHandle, RunState,
};
use crate::model_work::{
    Clock, Engine, RoutingCatalog, RunResult, Runner, ScopeRoute, SelectParams, WallClock,
    WorkError, WorkOrder,
};
use crate::persona_host;
use crate::runner_choices::RoutedChoice;
use crate::session_resolver::RunnerBindIdentity;

/// Decisions one summary may take before it is refused `mc_route_exhausted`.
pub const SUMMARY_MAX_DECISIONS: usize = 3;

/// A transport sends an optional select control only when its provider declares support.
/// Production negotiates `select_hold_control` on the scoped provider route.
pub const ROUTE_SELECT_HOLD_OK_SUPPORTED: bool = false;

/// Why a transport cannot place summaries, by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingSupportRefusal {
    pub code: String,
    pub detail: String,
}

/// How one summary is carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryPath {
    /// Placed by routing, through [`run_routed_summary`].
    Routed,
    /// The model-chain drive summaries used before routing.
    Chain,
}

/// The path a summary takes: routed only when the transport reports that it
/// can place summaries. A summary never fails over from one path to the other.
pub fn choose_summary_path(support: Result<(), RoutingSupportRefusal>) -> SummaryPath {
    match support {
        Ok(()) => SummaryPath::Routed,
        Err(_) => SummaryPath::Chain,
    }
}

/// The routing a summary should use, or `None` to keep the chain path.
pub(crate) fn active_routing(
    routing: Option<Arc<dyn SummaryRouting>>,
    scope: Option<&ScopeStamp>,
) -> Option<Arc<dyn SummaryRouting>> {
    routing.filter(|routing| {
        choose_summary_path(routing.routing_support_for(scope)) == SummaryPath::Routed
    })
}

/// Engines kept at most for this many sessions; past it, sessions whose engine
/// is idle with no report waiting are forgotten.
const SUMMARY_ENGINE_SESSION_CAP: usize = 256;

/// One routing engine per session for the module's lifetime. An engine queues
/// a report routing did not acknowledge and sends it again on the session's next
/// summary, under the scope it was decided under; an engine made per firing
/// would drop that report when the firing ended.
#[derive(Default)]
pub struct SummaryEngines {
    engines: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Engine>>>>,
    routing_outage: Mutex<bool>,
}

impl SummaryEngines {
    fn note_outage(&self, code: &str, detail: &str) {
        let mut outage = self.routing_outage.lock().expect("summary routing outage");
        if !*outage {
            *outage = true;
            tracing::warn!(
                code,
                detail,
                "summary routing provider unavailable; later firings will rediscover it"
            );
        }
    }

    fn routing_ready(&self) {
        *self.routing_outage.lock().expect("summary routing outage") = false;
    }

    fn for_session(&self, session_id: &str) -> Arc<tokio::sync::Mutex<Engine>> {
        let mut engines = self.engines.lock().expect("summary engines mutex");
        if let Some(engine) = engines.get(session_id) {
            return Arc::clone(engine);
        }
        if engines.len() >= SUMMARY_ENGINE_SESSION_CAP {
            engines.retain(|_, engine| {
                Arc::strong_count(engine) > 1
                    || engine
                        .try_lock()
                        .map_or(true, |engine| engine.pending_report_count() > 0)
            });
        }
        let engine = Arc::new(tokio::sync::Mutex::new(Engine::new(WallClock)));
        engines.insert(session_id.to_string(), Arc::clone(&engine));
        engine
    }
}

/// Routing affinity and correlation ids are limited to this many characters.
const ROUTING_KEY_MAX_CHARS: usize = 128;

/// The conversation's daemon scope and the bind identity of its routes.
#[derive(Debug, Clone)]
pub struct SummaryScope {
    pub stamp: ScopeStamp,
    pub identity: RunnerBindIdentity,
}

impl SummaryScope {
    /// The selector a route opens under to carry this conversation's stamp.
    pub fn selector(&self) -> ScopeSelector {
        ScopeSelector::new(
            self.stamp.owner.clone(),
            self.stamp.scope_ref.clone(),
            Some(self.stamp.scope_epoch),
        )
    }

    fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            serde_json::to_string(&self.stamp.owner).unwrap_or_default(),
            self.stamp.scope_ref,
            self.stamp.scope_epoch
        )
    }

    /// The project the scope serves, with the bound root for older unstamped sessions.
    fn project(&self) -> String {
        self.stamp
            .project_id
            .clone()
            .unwrap_or_else(|| self.identity.project_root.display().to_string())
    }
}

/// How a summary reaches routing and the runner routing answers. Production
/// speaks subc ([`SubcSummaryRouting`]); tests supply fakes.
#[subc_client_rs::async_trait]
pub trait SummaryRouting: Send + Sync {
    /// Whether this transport can place summaries at all. A summary takes the
    /// routed path only when it can; the refusal names what is missing.
    fn routing_support(&self) -> Result<(), RoutingSupportRefusal>;
    fn routing_support_for(
        &self,
        _scope: Option<&ScopeStamp>,
    ) -> Result<(), RoutingSupportRefusal> {
        self.routing_support()
    }
    /// Check live provider admission while the session's scoped route is bound.
    async fn observe_scope(&self, _scope: &SummaryScope) {}
    /// The `routing/v1` providers in the catalog, with its generation.
    async fn catalog(&self) -> Result<RoutingCatalog, String>;
    async fn select(
        &self,
        provider: &str,
        scope: &SummaryScope,
        params: &SelectParams,
    ) -> Result<RoutedChoice, Refusal>;
    async fn report(
        &self,
        provider: &str,
        scope: &SummaryScope,
        report: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal>;
    /// A producer whose routes go to `module_id` under `scope`.
    async fn connect_runner(
        &self,
        scope: &SummaryScope,
        module_id: &str,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError>;
    /// Whether `route.select` may carry `hold_ok`.
    fn select_accepts_hold_ok(&self) -> bool {
        ROUTE_SELECT_HOLD_OK_SUPPORTED
    }
    fn select_accepts_hold_ok_for(&self, _scope: &SummaryScope) -> bool {
        self.select_accepts_hold_ok()
    }
    /// The persona tiers the summary renders from.
    fn persona_tiers(&self, project_root: &Path) -> Result<Vec<Tier>, PersonaError> {
        persona_host::tier_ladder(None, Some(project_root))
    }
}

struct RoutedScope<'a> {
    routing: &'a dyn SummaryRouting,
    scope: &'a SummaryScope,
    scope_key: String,
    project_key: String,
}

impl ScopeRoute for RoutedScope<'_> {
    fn scope_key(&self) -> &str {
        &self.scope_key
    }

    fn project_key(&self) -> &str {
        &self.project_key
    }

    async fn select(
        &self,
        provider: &str,
        request: &SelectParams,
    ) -> Result<RoutedChoice, Refusal> {
        self.routing.select(provider, self.scope, request).await
    }

    async fn report(
        &self,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        self.routing.report(provider, self.scope, request).await
    }
}

/// Everything one routed summary needs, borrowed from the prepared firing.
pub(crate) struct RoutedSummary<'a> {
    pub routing: &'a dyn SummaryRouting,
    /// The module's engines, so reports outlive the firing that made them.
    pub engines: &'a SummaryEngines,
    pub scope: Option<&'a ScopeStamp>,
    pub identity: &'a RunnerBindIdentity,
    pub store: &'a McStore,
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub project_root: &'a Path,
    pub harness: &'a str,
    pub project_slug: &'a str,
    pub language: Option<&'a str>,
    pub firing: &'a AssembledHistorianFiring,
    /// The configured temperature, used only when the persona sets none.
    pub fallback_temperature: Option<f64>,
    pub await_timeout: Duration,
    pub rust_background_enabled: bool,
    pub publication_fence: Option<&'a dyn HistorianPublicationFence>,
    /// Context pressure drove this summary (the force band, or a provider
    /// refusing turns for size), so it must not wait on a quota reset.
    pub pressure: bool,
}

/// Run one summary on routing. See the module documentation.
pub(crate) async fn run_routed_summary(
    summary: RoutedSummary<'_>,
) -> Result<HistorianDriveOutcome, HistorianDriveError> {
    let catalog = match summary.routing.catalog().await {
        Ok(catalog) => catalog,
        Err(detail) => {
            summary
                .engines
                .note_outage("routing_provider_missing", &detail);
            return refuse_without_send(&summary, "routing_provider_missing", &detail, None);
        }
    };
    if catalog.providers.is_empty() {
        summary
            .engines
            .note_outage("routing_provider_missing", "no module provides routing/v1");
        return refuse_without_send(
            &summary,
            "routing_provider_missing",
            "no module provides routing/v1",
            None,
        );
    }
    if catalog.providers.len() > 1 {
        let detail = catalog.providers.join(", ");
        summary
            .engines
            .note_outage("routing_provider_ambiguous", &detail);
        return refuse_without_send(&summary, "routing_provider_ambiguous", &detail, None);
    }
    summary.engines.routing_ready();
    let Some(stamp) = summary.scope else {
        return refuse_without_send(
            &summary,
            "mc_session_scope_missing",
            "the conversation's route carries no scope stamp to route under",
            None,
        );
    };
    let frozen = match freeze_summary_persona(
        summary.store,
        summary.session_id,
        summary.routing,
        summary.project_root,
        summary.language,
        summary.fallback_temperature,
    ) {
        Ok(frozen) => frozen,
        Err(FreezeError::Store(error)) => {
            return Err(HistorianDriveError::Producer(
                persona_host::summary_refusal(summary.session_id, error),
            ))
        }
        Err(FreezeError::Persona(error)) => {
            return Err(HistorianDriveError::Producer(
                persona_host::summary_refusal(summary.session_id, error),
            ))
        }
    };
    let scope = SummaryScope {
        stamp: stamp.clone(),
        identity: summary.identity.clone(),
    };
    let route = RoutedScope {
        routing: summary.routing,
        scope: &scope,
        scope_key: scope.key(),
        project_key: scope.project(),
    };
    let order = summary_work_order(&summary, &frozen, &route);
    let runner = SummaryRunner {
        summary: &summary,
        frozen: &frozen,
        stop: Mutex::new(None),
    };
    let engine = summary.engines.for_session(summary.session_id);
    let result = engine.lock().await.run(&catalog, &order, &runner).await;
    if let Some(stopped) = runner.stop.lock().expect("summary stop mutex").take() {
        return stopped;
    }
    match result {
        Ok(done) => Ok(HistorianDriveOutcome::Completed(done.output)),
        Err(error) => {
            let detail = work_error_detail(&error);
            if error.attempts.is_empty() {
                refuse_without_send(&summary, error.code, &detail, error.reset_at_ms)
            } else {
                // Each attempt already recorded its own failure and backoff.
                Err(routing_error(error.code, &detail))
            }
        }
    }
}

fn summary_work_order<'a>(
    summary: &RoutedSummary<'_>,
    frozen: &FrozenSummaryPersona,
    route: &'a RoutedScope<'a>,
) -> WorkOrder<'a, RoutedScope<'a>> {
    let reserve = u64::from(summary.firing.max_output_tokens);
    let prompt_tokens = (mc_tokenizer::estimate_tokens(&frozen.bytes)
        + mc_tokenizer::estimate_tokens(&summary.firing.prompt)) as u64;
    let requirements = Requirements {
        iq: frozen.iq,
        eq: frozen.eq,
        context_window: Some(prompt_tokens.saturating_add(reserve)),
        max_output_tokens: Some(reserve),
        tools: Some(ToolsRequirement::None),
        ..Requirements::default()
    };
    let lineage = lineage_hash(summary.project_slug, summary.session_id);
    let next_seq = summary
        .store
        .load_meta(summary.session_id)
        .map(|loaded| loaded.meta.historian.firing_seq.saturating_add(1))
        .unwrap_or(1);
    let budget = crate::historian::firing_completion_wait_budget(
        summary.await_timeout,
        SUMMARY_MAX_DECISIONS,
    );
    WorkOrder {
        scope_route: route,
        work_id: bounded(format!("{lineage}:{next_seq}")),
        consumer: frozen.consumer.clone(),
        requirements,
        pin: None,
        // One key per conversation lineage, so successive summaries of one
        // session prefer the model that served the previous one.
        affinity: bounded(format!(
            "{}:{}:{lineage}",
            frozen.consumer, summary.project_slug
        )),
        concurrency_slots: None,
        // The drive bounds each attempt by its own timeout, so the work
        // deadline only stops a run that outlives every attempt it may take.
        deadline_ms: WallClock
            .now_ms()
            .saturating_add(budget.as_millis() as u64 + 60_000),
        max_decisions: SUMMARY_MAX_DECISIONS,
        hold_ok: (summary.pressure && summary.routing.select_accepts_hold_ok_for(route.scope))
            .then_some(false),
    }
}

/// The FNV lineage hash in the summary's child session id
/// (`mc-historian:{slug}:{lineage}:{seq}`), so routing's affinity follows the
/// same lineage the child sessions do.
fn lineage_hash(project_slug: &str, session_id: &str) -> String {
    let child = crate::historian::historian_producer_session_id(project_slug, session_id, 0);
    child.rsplit(':').nth(1).unwrap_or_default().to_string()
}

/// Keep the end of an over-long key: its tail is the lineage, which is what
/// makes it unique.
fn bounded(key: String) -> String {
    let count = key.chars().count();
    if count <= ROUTING_KEY_MAX_CHARS {
        return key;
    }
    key.chars().skip(count - ROUTING_KEY_MAX_CHARS).collect()
}

fn work_error_detail(error: &WorkError) -> String {
    let mut parts = Vec::new();
    if let Some(source) = &error.source {
        parts.push(format!("{}: {}", source.code, source.message));
    }
    if !error.modules.is_empty() {
        parts.push(format!("modules={}", error.modules.join(",")));
    }
    for attempt in &error.attempts {
        parts.push(format!(
            "{} on {}: {}{}",
            attempt.report.outcome,
            attempt.choice.route.route_key(),
            attempt.choice.runner.module,
            attempt
                .report
                .runner_code
                .as_deref()
                .map(|code| format!(" ({code})"))
                .unwrap_or_default()
        ));
    }
    parts.join("; ")
}

fn routing_error(code: &str, detail: &str) -> HistorianDriveError {
    HistorianDriveError::Producer(HistorianProducerError::Subc(ProducerErrorBody::untagged(
        code, detail,
    )))
}

/// Record a summary refused before anything was sent, with its retry time:
/// a timed routing refusal parks the session until routing's reset, anything
/// else uses the ordinary failure backoff.
fn refuse_without_send(
    summary: &RoutedSummary<'_>,
    code: &str,
    detail: &str,
    reset_at_ms: Option<u64>,
) -> Result<HistorianDriveOutcome, HistorianDriveError> {
    let loaded = summary.store.load_meta(summary.session_id)?;
    let mut meta = loaded.meta.clone();
    meta.historian.last_failure = Some(format!("{code}: {detail}"));
    meta.historian.failure_backoff_at_ms = Some(
        reset_at_ms
            .and_then(|reset| i64::try_from(reset).ok())
            .unwrap_or(summary.firing.failure_backoff_at_ms),
    );
    summary
        .store
        .commit_meta(summary.session_id, loaded.row_version, &meta)?;
    if !matches!(
        code,
        "routing_provider_missing" | "routing_provider_ambiguous"
    ) {
        tracing::warn!(
            "[mc-module][{}] summary not sent: {code}: {detail}",
            summary.session_id
        );
    }
    Err(routing_error(code, detail))
}

#[derive(Debug)]
pub(crate) enum FreezeError {
    Store(McStoreError),
    Persona(PersonaError),
}

impl From<McStoreError> for FreezeError {
    fn from(error: McStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<PersonaError> for FreezeError {
    fn from(error: PersonaError) -> Self {
        Self::Persona(error)
    }
}

/// The identity covers the rendered bytes and every setting frozen with them,
/// so a temperature or demand change is a different frozen persona even when
/// the text is the same.
pub(crate) fn frozen_identity(
    render_digest: &str,
    temperature: Option<f64>,
    consumer: &str,
    iq: u8,
    eq: Option<u8>,
) -> String {
    let canonical = serde_json::json!({
        "render_digest": render_digest,
        "generation": {"temperature": temperature},
        "routing": {"consumer": consumer, "iq": iq, "eq": eq},
    });
    format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
}

/// Return the conversation's frozen summary persona, rendering and storing it
/// on the first summary. A stored persona is returned as stored: persona files,
/// language and fragments changing later never re-render it.
pub(crate) fn freeze_summary_persona(
    store: &McStore,
    session_id: &str,
    routing: &dyn SummaryRouting,
    project_root: &Path,
    language: Option<&str>,
    fallback_temperature: Option<f64>,
) -> Result<FrozenSummaryPersona, FreezeError> {
    let mut attempts = 0;
    loop {
        let loaded = store.load_meta(session_id)?;
        if let Some(frozen) = &loaded.meta.summary_persona {
            return Ok(frozen.as_ref().clone());
        }
        let frozen = render_frozen(
            routing,
            project_root,
            language,
            fallback_temperature,
            loaded.meta.memory_context.as_ref(),
            session_id,
        )?;
        let mut meta = loaded.meta.clone();
        meta.summary_persona = Some(Box::new(frozen.clone()));
        match store.commit_meta(session_id, loaded.row_version, &meta) {
            Ok(_) => {
                tracing::info!(
                    "[mc-module][{session_id}] froze summary persona {} (render {})",
                    frozen.identity,
                    frozen.render_digest
                );
                return Ok(frozen);
            }
            // Another writer moved the meta row; read it again and keep its
            // persona if it froze one first.
            Err(McStoreError::CasConflict { .. }) if attempts < 3 => attempts += 1,
            Err(error) => return Err(error.into()),
        }
    }
}

fn render_frozen(
    routing: &dyn SummaryRouting,
    project_root: &Path,
    language: Option<&str>,
    fallback_temperature: Option<f64>,
    memory_context: Option<&serde_json::Value>,
    session_id: &str,
) -> Result<FrozenSummaryPersona, PersonaError> {
    let tiers = routing.persona_tiers(project_root)?;
    let persona = persona_host::load_summary(&tiers, &ApprovalSet::new(), None)?;
    let context = persona_host::SummaryContext {
        language: persona_host::LanguageContext::new(language, Default::default()),
        memory_profile: persona_host::MemoryProfile::summary(memory_context, session_id)?,
        ..Default::default()
    };
    let rendered = persona_host::render_summary(&persona, &context)?;
    let temperature = persona.generation().temperature.or(fallback_temperature);
    let route = persona.routing();
    let render_digest = rendered.digest.hex();
    Ok(FrozenSummaryPersona {
        identity: frozen_identity(
            &render_digest,
            temperature,
            &route.consumer,
            route.iq,
            route.eq,
        ),
        render_digest,
        bytes: rendered.text,
        temperature,
        consumer: route.consumer.clone(),
        iq: route.iq,
        eq: route.eq,
    })
}

/// Sends one decision: the existing drive, with a one-model chain naming
/// exactly the answered model, under the frozen system bytes.
struct SummaryRunner<'a> {
    summary: &'a RoutedSummary<'a>,
    frozen: &'a FrozenSummaryPersona,
    /// An outcome that is not the route's doing (another firing holds the
    /// session, or the session state moved). The engine is told the decision
    /// was cancelled, which ends the work, and this is returned instead.
    stop: Mutex<Option<Result<HistorianDriveOutcome, HistorianDriveError>>>,
}

impl SummaryRunner<'_> {
    fn stop(
        &self,
        outcome: Result<HistorianDriveOutcome, HistorianDriveError>,
    ) -> RunResult<HistorianRunSuccess> {
        *self.stop.lock().expect("summary stop mutex") = Some(outcome);
        RunResult::new(Outcome::Cancelled, None)
    }
}

/// The model string the drive sends: the answered runner model, never the
/// route key, since the runner names models in its own terms.
pub(crate) fn answered_model(choice: &RoutedChoice) -> String {
    format!(
        "{}/{}",
        choice.runner.model.provider, choice.runner.model.model
    )
}

impl<'s> Runner<RoutedScope<'s>> for SummaryRunner<'_> {
    type Output = HistorianRunSuccess;

    async fn send(
        &self,
        scope: &RoutedScope<'s>,
        choice: &RoutedChoice,
        _deadline_ms: u64,
    ) -> RunResult<HistorianRunSuccess> {
        let summary = self.summary;
        let mut producer = match summary
            .routing
            .connect_runner(scope.scope, &choice.runner.module)
            .await
        {
            Ok(producer) => producer,
            Err(error) => return failure(&error, Outcome::Refused),
        };
        let model = answered_model(choice);
        let chain = [model.clone()];
        let mut variants = BTreeMap::new();
        if let Some(variant) = &choice.runner.model.variant {
            variants.insert(model.clone(), variant.clone());
        }
        let limits = BTreeMap::from([(
            model.clone(),
            HistorianModelLimits {
                context: usize::try_from(choice.context_window).ok(),
                input: None,
                output: u32::try_from(choice.max_output_tokens).ok(),
            },
        )]);
        let mut recording = Recording {
            inner: &mut *producer,
            last: None,
        };
        let mut repair: Option<String> = None;
        loop {
            let mut request = summary.firing.as_fire_request_with_system(
                summary.store,
                summary.session_id,
                summary.project_path,
                summary.harness,
                summary.project_slug,
                summary.language,
                std::borrow::Cow::Borrowed(self.frozen.bytes.as_str()),
            );
            request.temperature = self.frozen.temperature;
            request.rust_background_enabled = summary.rust_background_enabled;
            request.await_timeout = summary.await_timeout;
            request.publication_fence = summary.publication_fence;
            request.model_chain = &chain;
            request.model_variants = variants.clone();
            request.model_limits = limits.clone();
            request.fallback_context_limits = BTreeMap::new();
            request.historian_context_limit_tokens = usize::try_from(choice.context_window).ok();
            if let Some(prompt) = &repair {
                request.prompt = prompt;
            }
            let result = crate::historian::run_historian_firing_with_model_cache(
                &mut recording,
                request,
                None,
                0,
            )
            .await;
            let usage = recording
                .last
                .as_ref()
                .and_then(|output| output.usage)
                .map(|usage| Usage {
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                    cost_usd: None,
                });
            match result {
                Ok(HistorianDriveOutcome::Completed(success)) => {
                    let mut result = RunResult::new(Outcome::Completed, Some(success));
                    result.usage = usage;
                    return result;
                }
                Ok(busy @ HistorianDriveOutcome::Busy(_)) => return self.stop(Ok(busy)),
                // The model answered but its output was rejected. Ask it once
                // more on the same decision with the validation error attached.
                Err(HistorianDriveError::Validation(error)) if repair.is_none() => {
                    let Some(previous) = recording.last.take() else {
                        let mut result = RunResult::new(Outcome::Failed, None);
                        result.usage = usage;
                        return result;
                    };
                    repair = Some(crate::historian_prompt::build_historian_repair_prompt(
                        &summary.firing.prompt,
                        &previous.text,
                        &error.to_string(),
                        summary.language,
                    ));
                }
                Err(HistorianDriveError::Validation(_)) => {
                    let mut result = RunResult::new(Outcome::Failed, None);
                    result.usage = usage;
                    return result;
                }
                Err(HistorianDriveError::Producer(error)) => {
                    let mut result = failure(&error, Outcome::Failed);
                    result.usage = usage;
                    return result;
                }
                Err(other) => return self.stop(Err(other)),
            }
        }
    }

    async fn cancel(&self, _scope: &RoutedScope<'s>, _choice: &RoutedChoice) {
        // The drive cancels and closes its own run when an attempt times out,
        // before the work deadline can expire.
    }
}

/// Map a producer error onto the decision's outcome and the runner's code,
/// verbatim where the runner sent one.
fn failure(error: &HistorianProducerError, default: Outcome) -> RunResult<HistorianRunSuccess> {
    let now = WallClock.now_ms() as i64;
    let (outcome, code) = if let Some(refusal) = error.runner_refusal() {
        (Outcome::Refused, Some(refusal.received_code))
    } else {
        match error {
            HistorianProducerError::TimedOut => (Outcome::TimedOut, None),
            HistorianProducerError::Subc(body) => (default, Some(body.code.clone())),
            HistorianProducerError::RunFailed { .. } => (default, Some("run_failed".to_string())),
            HistorianProducerError::RunPaused { .. } => (default, Some("run_paused".to_string())),
            _ => (default, Some("runner_unavailable".to_string())),
        }
    };
    let mut result = RunResult::new(outcome, None);
    result.runner_code = code;
    result.reset_at_ms = error
        .provider_retry_at_ms(now)
        .and_then(|reset| u64::try_from(reset).ok());
    result
}

/// Passes every call through and remembers the last output it saw, so a
/// rejected answer can be repaired on the same decision.
struct Recording<'a> {
    inner: &'a mut (dyn HistorianProducerDriver + Send),
    last: Option<ProducerOutput>,
}

impl Recording<'_> {
    fn seen(
        &mut self,
        output: Result<ProducerOutput, HistorianProducerError>,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        if let Ok(output) = &output {
            self.last = Some(output.clone());
        }
        output
    }
}

#[subc_client_rs::async_trait]
impl HistorianProducerDriver for Recording<'_> {
    async fn session_runner_limits(
        &mut self,
        child: &str,
    ) -> Result<Option<crate::runner_limits::RunnerLimits>, HistorianProducerError> {
        self.inner.session_runner_limits(child).await
    }
    async fn bind_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        self.inner.bind_session(session_id).await
    }
    async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.inner.start(session_id, system, prompt, model).await
    }
    async fn start_with_temperature(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.inner
            .start_with_temperature(session_id, system, prompt, model, variant, temperature)
            .await
    }
    async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        max_output_tokens: u32,
        temperature: f64,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.inner
            .start_with_generation(
                session_id,
                system,
                prompt,
                model,
                variant,
                max_output_tokens,
                temperature,
            )
            .await
    }
    async fn start_stage_with_temperature(
        &mut self,
        session_id: &str,
        stage_key: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.inner
            .start_stage_with_temperature(
                session_id,
                stage_key,
                system,
                prompt,
                model,
                variant,
                temperature,
            )
            .await
    }
    async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let output = self.inner.await_output(run_id).await;
        self.seen(output)
    }
    async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let output = self.inner.await_output_with_timeout(run_id, timeout).await;
        self.seen(output)
    }
    async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let output = self.inner.redrain_output(run_id).await;
        self.seen(output)
    }
    async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let output = self
            .inner
            .redrain_output_with_timeout(run_id, timeout)
            .await;
        self.seen(output)
    }
    async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        self.inner.status(run_id).await
    }
    async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
        self.inner.cancel(run_id).await
    }
    async fn close(&mut self) {
        self.inner.close().await
    }
    async fn purge_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        self.inner.purge_session(session_id).await
    }
}

/// Routing time for one `route.select` or `route.report`.
const ROUTING_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Routing and runner transport over subc: the catalog read on channel 0,
/// `route.select`/`route.report` on a route to the provider opened under the
/// conversation's scope, and producers bound to the answered runner under the
/// same scope.
pub struct SubcSummaryRouting {
    pub connection_file: PathBuf,
    pub route_targets: crate::route_targets::RouteTargetConfig,
    readiness: Mutex<HashMap<String, Result<bool, RoutingSupportRefusal>>>,
}

impl SubcSummaryRouting {
    pub fn new(
        connection_file: PathBuf,
        route_targets: crate::route_targets::RouteTargetConfig,
    ) -> Self {
        Self {
            connection_file,
            route_targets,
            readiness: Mutex::default(),
        }
    }

    fn stamp_key(stamp: &ScopeStamp) -> String {
        format!(
            "{}|{}|{}",
            serde_json::to_string(&stamp.owner).expect("scope owner"),
            stamp.scope_ref,
            stamp.scope_epoch
        )
    }

    async fn preflight(&self, scope: &SummaryScope) -> Result<bool, RoutingSupportRefusal> {
        let catalog = self
            .catalog()
            .await
            .map_err(|detail| RoutingSupportRefusal {
                code: "routing_catalog_unavailable".into(),
                detail,
            })?;
        let provider = match catalog.providers.as_slice() {
            [] => {
                return Err(RoutingSupportRefusal {
                    code: "routing_provider_missing".into(),
                    detail: "no module provides routing/v1".into(),
                })
            }
            [provider] => provider,
            providers => {
                return Err(RoutingSupportRefusal {
                    code: "routing_provider_ambiguous".into(),
                    detail: providers.join(", "),
                })
            }
        };
        let describe: cortexkit_role_routing::describe::RoleDescribe = self
            .call(provider, scope, "role.describe", serde_json::json!({}))
            .await
            .map_err(|error| RoutingSupportRefusal {
                code: "mc_summary_route_unavailable".into(),
                detail: error.to_string(),
            })?;
        cortexkit_role_routing::describe::check_describe(&describe).map_err(|error| {
            RoutingSupportRefusal {
                code: "mc_routing_role_invalid".into(),
                detail: error.to_string(),
            }
        })?;
        Ok(describe.serves(cortexkit_role_routing::capabilities::SELECT_HOLD_CONTROL))
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        provider: &str,
        scope: &SummaryScope,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, Refusal> {
        use subc_client_rs::{
            CallError, CallOptions, CloseRouteOptions, ConsumerOptions, SubcConsumer,
        };
        let unavailable = |detail: String| Refusal::new(RefusalCode::RoutingUnavailable, detail);
        let options = ConsumerOptions {
            handshake_timeout: ROUTING_CALL_TIMEOUT,
            call_timeout: ROUTING_CALL_TIMEOUT,
            ..ConsumerOptions::default()
        };
        let consumer = SubcConsumer::connect(&self.connection_file, options)
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        let target = crate::route_targets::routed_module_target(provider);
        let identity = subc_protocol::BindIdentity::new(
            scope.identity.project_root.clone(),
            scope.identity.harness.as_str(),
            scope.identity.session.as_str(),
        );
        let role_versions = BTreeMap::from([(
            cortexkit_role_routing::ROLE.to_string(),
            cortexkit_role_routing::VERSION.to_string(),
        )]);
        let call_options = CallOptions {
            timeout: ROUTING_CALL_TIMEOUT,
            route_retry_deadline: ROUTING_CALL_TIMEOUT,
            role_versions: Some(role_versions.clone()),
            ..CallOptions::default()
        };
        let body = serde_json::to_vec(&serde_json::json!({"method": method, "params": params}))
            .map_err(|error| unavailable(error.to_string()))?;
        let reply = match consumer
            .open_route_scoped(target, identity, scope.selector(), call_options.clone())
            .await
        {
            Ok(handle) => {
                let reply = consumer.request(&handle, body, call_options).await;
                let _ = consumer
                    .close_handle(
                        &handle,
                        CloseRouteOptions {
                            role_versions: Some(role_versions),
                            ..CloseRouteOptions::default()
                        },
                    )
                    .await;
                reply
            }
            Err(error) => Err(error),
        };
        consumer.close().await;
        match reply {
            Ok(bytes) => cortexkit_role_routing::wire::read_reply(&bytes)
                .map_err(|error| unavailable(error.to_string())),
            Err(CallError::Module(body)) => serde_json::to_value(&body)
                .ok()
                .and_then(|value| serde_json::from_value(value).ok())
                .ok_or_else(|| unavailable(format!("{}: {}", body.code, body.message))),
            Err(error) => Err(unavailable(error.to_string())),
        }
    }
}

#[subc_client_rs::async_trait]
impl SummaryRouting for SubcSummaryRouting {
    fn routing_support_for(&self, scope: Option<&ScopeStamp>) -> Result<(), RoutingSupportRefusal> {
        let Some(stamp) = scope else {
            return Err(RoutingSupportRefusal {
                code: "mc_session_scope_missing".into(),
                detail: "no session scope".into(),
            });
        };
        self.readiness
            .lock()
            .expect("summary readiness")
            .get(&Self::stamp_key(stamp))
            .cloned()
            .unwrap_or_else(|| self.routing_support().map(|()| false))
            .map(|_| ())
    }

    async fn observe_scope(&self, scope: &SummaryScope) {
        let result = self.preflight(scope).await;
        let mut readiness = self.readiness.lock().expect("summary readiness");
        readiness.insert(Self::stamp_key(&scope.stamp), result);
    }

    fn select_accepts_hold_ok_for(&self, scope: &SummaryScope) -> bool {
        matches!(
            self.readiness
                .lock()
                .expect("summary readiness")
                .get(&Self::stamp_key(&scope.stamp)),
            Some(Ok(true))
        )
    }

    fn routing_support(&self) -> Result<(), RoutingSupportRefusal> {
        Err(RoutingSupportRefusal {
            code: "mc_session_scope_missing".into(),
            detail: "a session scope is required for the live routing check".into(),
        })
    }

    async fn catalog(&self) -> Result<RoutingCatalog, String> {
        use subc_client_rs::{ConsumerOptions, SubcConsumer};
        let consumer = SubcConsumer::connect(
            &self.connection_file,
            ConsumerOptions {
                handshake_timeout: ROUTING_CALL_TIMEOUT,
                call_timeout: ROUTING_CALL_TIMEOUT,
                ..ConsumerOptions::default()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        let listed = consumer.catalog_list().await;
        consumer.close().await;
        let listed = listed.map_err(|error| error.to_string())?;
        Ok(RoutingCatalog {
            generation: listed.generation,
            providers: listed
                .modules
                .iter()
                .filter(|entry| {
                    entry.capabilities.as_ref().is_some_and(|capabilities| {
                        capabilities
                            .provides
                            .iter()
                            .any(|provided| provided == cortexkit_role_routing::PROVIDES)
                    })
                })
                .map(|entry| entry.module_id.clone())
                .collect(),
        })
    }

    async fn select(
        &self,
        provider: &str,
        scope: &SummaryScope,
        params: &SelectParams,
    ) -> Result<RoutedChoice, Refusal> {
        let mut params = params.clone();
        if params.hold_ok.is_some() {
            let describe: cortexkit_role_routing::describe::RoleDescribe = self
                .call(provider, scope, "role.describe", serde_json::json!({}))
                .await?;
            if !describe.serves(cortexkit_role_routing::capabilities::SELECT_HOLD_CONTROL) {
                params.hold_ok = None;
            }
        }
        let params = serde_json::to_value(params)
            .map_err(|error| Refusal::new(RefusalCode::RoutingUnavailable, error.to_string()))?;
        self.call(
            provider,
            scope,
            cortexkit_role_routing::ops::ROUTE_SELECT,
            params,
        )
        .await
    }

    async fn report(
        &self,
        provider: &str,
        scope: &SummaryScope,
        report: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        let params = serde_json::to_value(report)
            .map_err(|error| Refusal::new(RefusalCode::RoutingUnavailable, error.to_string()))?;
        self.call(
            provider,
            scope,
            cortexkit_role_routing::ops::ROUTE_REPORT,
            params,
        )
        .await
    }

    async fn connect_runner(
        &self,
        scope: &SummaryScope,
        module_id: &str,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        let config = crate::historian_producer::HistorianProducerConfig {
            handshake_timeout: Duration::from_secs(2),
            route_targets: self.route_targets.clone(),
            ..crate::historian_producer::HistorianProducerConfig::new(
                self.connection_file.clone(),
                scope.identity.project_root.clone(),
                scope.identity.harness.clone(),
            )
        };
        Ok(Box::new(
            crate::historian_producer::HistorianProducer::connect_to_routed_runner(
                config,
                crate::historian_producer::RoutedRunnerTarget {
                    module_id: module_id.to_string(),
                    scope: scope.selector(),
                },
            )
            .await?,
        ))
    }
}
