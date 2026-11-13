//! Picking the model ck-mc's own runs use, through the routing capability
//! (`routing/v1`, `cortexkit-role-routing`). ck-mc states what the work
//! needs and the runner it can send to; routing answers a model, and ck-mc
//! reports how the run went. ck-mc never picks a model itself: with no
//! routing provider, its runs are refused by name (`routing_unavailable`).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::OnceCell;

use cortexkit_role_routing::report::{Outcome, ReportRequest, Usage};
use cortexkit_role_routing::select::{Requirements, SelectAnswer, SelectRequest};

use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_compaction::setup::ModelRef;

/// The routing capability ck-mc requires.
pub const CAPABILITY: &str = "routing/v1";
/// The consumer name summaries are selected under. It is rooted at the
/// module's id, and the module's manifest declares it with its defaults
/// ([`consumer_declarations`]), so routing knows it even while ck-mc is
/// stopped and no operator configuration is needed.
pub const SUMMARY_CONSUMER: &str = "magic-context.summary";

/// The largest reply a summary run asks for.
pub const SUMMARY_OUTPUT_TOKENS: u64 = 32_000;

/// The smallest context window a summary run can use: a chunk, the prompt
/// around it and the reply.
pub const SUMMARY_CONTEXT_WINDOW: u64 = 64_000;

/// The routing consumers ck-mc owns, for its manifest's
/// `role_declarations["routing/v1"]` slot: summaries run tool-free on the
/// session's own runner, at [`SUMMARY_IQ`]; each dreamer task kind has a
/// consumer of its own ([`DREAM_DEMANDS`]), on whatever runner routing picks.
pub fn consumer_declarations() -> cortexkit_role_routing::declarations::ConsumerDeclarations {
    use cortexkit_role_routing::declarations::{
        ConsumerDeclaration, ConsumerDeclarations, DemandDefaults,
    };
    use cortexkit_role_routing::select::ToolsRequirement;
    let mut summary = DemandDefaults::new()
        .with_iq(SUMMARY_IQ)
        .with_placement(cortexkit_role_routing::placement::Placement::caller_runner());
    summary.tools = Some(ToolsRequirement::None);
    summary.max_output_tokens = Some(SUMMARY_OUTPUT_TOKENS);
    summary.context_window = Some(SUMMARY_CONTEXT_WINDOW);
    let mut consumers = vec![ConsumerDeclaration::new(SUMMARY_CONSUMER).with_defaults(summary)];
    for demand in DREAM_DEMANDS {
        let mut defaults = DemandDefaults::new().with_iq(demand.iq);
        defaults.tools = Some(if demand.reads_code {
            ToolsRequirement::Required
        } else {
            ToolsRequirement::None
        });
        defaults.max_output_tokens = Some(DREAM_OUTPUT_TOKENS);
        defaults.context_window = Some(demand.context_window);
        consumers
            .push(ConsumerDeclaration::new(dream_consumer(demand.kind)).with_defaults(defaults));
    }
    ConsumerDeclarations::new().with_consumers(consumers)
}

/// What one kind of dreamer task asks routing for.
pub struct DreamDemand {
    /// The task kind, as memory profiles name it (`classify-memories`).
    pub kind: &'static str,
    pub iq: u8,
    /// The smallest window the task's input, prompt and reply fit in.
    pub context_window: u64,
    /// The task reads the project's files through the code-reading tools.
    pub reads_code: bool,
    /// The most model steps one message of the task may take. A task without
    /// tools answers in one; a code-reading task needs a step after each
    /// round of reads. The bounds are the 0.49 dreamer's own: 60 for mapping
    /// and verifying a batch, 40 for one primer.
    pub max_steps: u64,
}

/// The dreamer task kinds the module runs, and the least each needs. A
/// person can raise any of them in routing's own configuration. Tasks that
/// only reread memories need less than the summarizer; the ones that judge
/// memories against code or the person's history need more, and verify needs
/// room for the files it reads.
pub const DREAM_DEMANDS: &[DreamDemand] = &[
    DreamDemand {
        kind: "review-user-memories",
        iq: 60,
        context_window: 128_000,
        reads_code: false,
        max_steps: 1,
    },
    DreamDemand {
        kind: "classify-memories",
        iq: 30,
        context_window: 64_000,
        reads_code: false,
        max_steps: 1,
    },
    DreamDemand {
        kind: "curate",
        iq: 50,
        context_window: 128_000,
        reads_code: false,
        max_steps: 1,
    },
    DreamDemand {
        kind: "compress-cues",
        iq: 30,
        context_window: 64_000,
        reads_code: false,
        max_steps: 1,
    },
    DreamDemand {
        kind: "reflect-events",
        iq: 60,
        context_window: 128_000,
        reads_code: false,
        max_steps: 1,
    },
    DreamDemand {
        kind: "map-memories",
        iq: 40,
        context_window: 128_000,
        reads_code: true,
        max_steps: 60,
    },
    DreamDemand {
        kind: "verify",
        iq: 60,
        context_window: 200_000,
        reads_code: true,
        max_steps: 60,
    },
    DreamDemand {
        kind: "verify-broad",
        iq: 60,
        context_window: 200_000,
        reads_code: true,
        max_steps: 60,
    },
    DreamDemand {
        kind: "refresh-primers",
        iq: 50,
        context_window: 128_000,
        reads_code: true,
        max_steps: 40,
    },
];

/// The largest reply a dreamer task asks for.
pub const DREAM_OUTPUT_TOKENS: u64 = 32_000;

/// The consumer a dreamer task kind is selected under.
pub fn dream_consumer(kind: &str) -> String {
    format!("magic-context.dream.{kind}")
}

/// A dreamer run's select: its task kind's demand, on any runner routing
/// picks, leaving out the routes this run already tried.
pub fn dream_select(demand: &DreamDemand, tried: &[String]) -> SelectRequest {
    let mut request = SelectRequest::new(dream_consumer(demand.kind), Requirements::iq(demand.iq));
    if !tried.is_empty() {
        request.exclude = Some(tried.to_vec());
    }
    request
}
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
    /// The provider's open refusal detail. Its fields are optional to readers:
    /// an absent or malformed timing hint must not hide the refusal itself.
    pub detail: Option<serde_json::Value>,
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

type Declaration = (u64, Arc<OnceCell<bool>>);

/// Routing's optional select fields are opt-in. A provider's answer is cached
/// per connection epoch, a missing capability included, so an older provider
/// isn't asked again on every select. A describe call that fails is not an
/// answer: that select omits the field and the next select asks again, so a
/// provider that was still starting doesn't lose the field until it reconnects.
#[derive(Default)]
pub(crate) struct Capabilities {
    providers: Mutex<HashMap<String, Declaration>>,
}

impl Capabilities {
    pub(crate) async fn select_request(
        &self,
        provider: &str,
        connection_epoch: u64,
        mut request: SelectRequest,
        describe: impl Future<Output = Result<Value, RouteError>>,
    ) -> SelectRequest {
        let cell = {
            let mut providers = self.providers.lock().expect("routing capabilities");
            let declaration = providers
                .entry(provider.to_owned())
                .or_insert_with(|| (connection_epoch, Arc::new(OnceCell::new())));
            if declaration.0 != connection_epoch {
                *declaration = (connection_epoch, Arc::new(OnceCell::new()));
            }
            Arc::clone(&declaration.1)
        };
        let select_harness = cell
            .get_or_try_init(|| async {
                describe.await.map(|value| {
                    value["capabilities"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|name| name.as_str() == Some(cortexkit_role_routing::capabilities::SELECT_HARNESS))
                })
            })
            .await
            .copied()
            .unwrap_or_else(|error| {
                tracing::warn!(provider, reason = %error, "routing harness omitted: provider discovery failed");
                false
            });
        if !select_harness {
            request.harness = None;
        }
        request
    }
}

/// A summary run's select: the summarizer's demand, on the session's own
/// runner and child's harness, leaving out the routes already tried for this
/// work. The transport omits the harness for providers that cannot read it.
pub fn summary_select(runner: &str, harness: &str, tried: &[String]) -> SelectRequest {
    let mut request = SelectRequest::new(SUMMARY_CONSUMER, Requirements::iq(SUMMARY_IQ));
    request.runners = Some(vec![runner.to_owned()]);
    request.harness = Some(harness.to_owned());
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

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
