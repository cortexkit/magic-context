//! Picking the model ck-mc's own runs use, through the routing capability
//! (`routing/v1`, `cortexkit-role-routing`). ck-mc states what the work
//! needs and the runner it can send to; routing answers a model, and ck-mc
//! reports how the run went. ck-mc never picks a model itself: with no
//! routing provider, its runs are refused by name (`routing_unavailable`).

use std::future::Future;

use cortexkit_role_routing::report::{Outcome, ReportRequest, Usage};
use cortexkit_role_routing::select::{Requirements, SelectAnswer, SelectRequest};

use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_compaction::setup::ModelRef;

/// The routing capability ck-mc requires.
pub const CAPABILITY: &str = "routing/v1";
/// The consumer name summaries are selected under. Routing ships a default
/// entry for it, so no operator configuration is needed.
pub const SUMMARY_CONSUMER: &str = "mc_summary";
/// Summaries need a mid-level model (ARCHITECTURE: module-only model
/// placement). Routing grades models against the best one the consumer may
/// use, so the demand that lands on a mid-level model moves when grades move:
/// under the grades of 10 Nov 2026, 50 selected a top-tier model and 40 the
/// mid-level one summaries ran on before.
pub const SUMMARY_IQ: u8 = 40;

/// Why routing gave no model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteError {
    /// A routing refusal code (`no_route`, `unknown_consumer`, ...) or one
    /// of the consumer's own: `routing_unavailable` (no provider) and
    /// `routing_ambiguous` (more than one).
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// ck-mc's calls to the routing provider.
pub trait Router: Send + Sync + 'static {
    /// `route.select`.
    fn select(
        &self,
        request: SelectRequest,
    ) -> impl Future<Output = Result<SelectAnswer, RouteError>> + Send;
    /// `route.report`. A failed report is logged and dropped: routing does
    /// not block the next select on a missing one.
    fn report(&self, request: ReportRequest) -> impl Future<Output = ()> + Send;
}

/// A summary run's select: the summarizer's demand, on the session's own
/// runner, leaving out the routes already tried for this work.
pub fn summary_select(runner: &str, tried: &[String]) -> SelectRequest {
    let mut request = SelectRequest::new(SUMMARY_CONSUMER, Requirements::iq(SUMMARY_IQ));
    request.runners = Some(vec![runner.to_owned()]);
    if !tried.is_empty() {
        request.exclude = Some(tried.to_vec());
    }
    request
}

/// The model to send to: as the runner names it.
pub fn model_of(answer: &SelectAnswer) -> ModelRef {
    let model = &answer.runner.model;
    let mut chosen = ModelRef::new(model.provider.clone(), model.model.clone());
    chosen.variant = model.variant.clone();
    chosen.service_tier = answer.service_tier_chosen.clone();
    chosen
}

/// A report of how a decision's run went, with what the run reported.
pub fn report(decision_id: &str, outcome: Outcome, usage: Option<&StepUsage>) -> ReportRequest {
    let mut request = ReportRequest::new(decision_id, outcome);
    request.usage = usage.map(|usage| {
        let mut reported = Usage::default();
        // Routing counts input without the cache reads and writes.
        reported.input_tokens = usage.prompt_tokens.map(|prompt| {
            prompt
                .saturating_sub(usage.cache_read_tokens.unwrap_or(0))
                .saturating_sub(usage.cache_write_tokens.unwrap_or(0))
        });
        reported.cached_input_tokens = usage.cache_read_tokens;
        reported.cache_write_tokens = usage.cache_write_tokens;
        reported.output_tokens = usage.output_tokens;
        reported.reasoning_tokens = usage.reasoning_tokens;
        reported
    });
    request
}
