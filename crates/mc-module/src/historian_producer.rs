//! llm-runner session client used by the historian writer.
//!
//! The client intentionally speaks only the JSON session wire over subc routes. It
//! does not depend on llm-runner Rust crates, so Magic Context remains an origin-
//! agnostic consumer module.

use std::{
    error::Error,
    fmt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use crate::child_retention::{self, ChildRetention, ReleaseOutcome};
use crate::runner_follow::{self, FollowCapabilities};
use crate::runner_limits::RunnerLimits;
use cortexkit_role_llm_runner::run::{
    RunResult as RoleRunResult, RunState as RoleRunState, RunStatus as RoleRunStatus,
};
use cortexkit_role_llm_runner::send::SendRequest as RoleSendRequest;
use serde::Serialize;
use serde_json::{json, Value};
use subc_control::{ClientControlRequest, ClientControlResponse, ConsumerIdentity};
use subc_protocol::{
    BindIdentity, ErrorBody, Flags, Frame, FrameBuildError, FrameType, Priority, SUBC_MODULE_ID_ENV,
};
use subc_transport::{
    authenticate_client, connection_file, read_frame, write_frame, AuthError, ConnectionFileError,
    FrameIoError,
};
use tokio::net::TcpStream;

use crate::route_targets::{RegisteredRoute, RouteTargetConfig, SessionRunnerRoute};

/// Output budget for a historian summarization pass. llm-runner's default (4k) truncated
/// a real 50k-input chunk mid-XML on the rig: a tiered compartment doc for a full chunk
/// legitimately needs five figures. The provider clamps to its own per-model limit, so a
/// generous request costs nothing unless the model actually generates that much.
pub(crate) const HISTORIAN_MAX_OUTPUT_TOKENS: u32 = 32_000;
const HISTORIAN_SESSION_RETENTION_SECONDS: u64 = 86_400;

#[derive(Serialize)]
struct GenerationRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

/// The `model` object of a `session.send`. Broca decodes it as `{provider, model,
/// variant?}` and freezes the variant (for example a reasoning effort such as `high`)
/// on the run. A typed struct rather than a `json!` object keeps the field order
/// `provider`, `model`, `variant` on the wire, byte-identical to Broca's own send
/// goldens. `variant` is omitted, never sent empty, when the attempt names none.
#[derive(Serialize)]
struct SendModel<'a> {
    provider: &'a str,
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<&'a str>,
}

/// Serialize `prompt`, `send_id`, and nested `model` first, followed by the one
/// optional retention member (`retention` seconds or `retention_policy`), then this
/// client's `tools`, `generation`, and `system` fields.
/// Omitting `delivery` selects queued mode; put any requested variant in `model`.
#[derive(Serialize)]
struct SendParams<'a> {
    prompt: &'a str,
    send_id: &'a str,
    model: SendModel<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention_policy: Option<cortexkit_role_llm_runner::session_retention::RetentionPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a [Value]>,
    generation: GenerationRequest,
    #[serde(skip_serializing_if = "str::is_empty")]
    system: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_when: Option<StopWhen>,
}

/// The runner-enforced step limit. A historian child has no tools, so it gets
/// exactly one model step.
#[derive(Serialize)]
struct StopWhen {
    max_steps: u64,
}

/// The step limit a historian child runs under on a session runner.
const HISTORIAN_SESSION_RUNNER_MAX_STEPS: u64 = 1;

#[derive(Serialize)]
pub(crate) struct SendRequest<'a> {
    method: &'static str,
    params: SendParams<'a>,
}

impl<'a> SendRequest<'a> {
    /// Apply the runner's declared limits to this historian `session.send` request.
    pub(crate) fn for_session_runner(
        mut self,
        limits: RunnerLimits,
    ) -> Result<Self, HistorianProducerError> {
        limits.require_historian()?;
        if self.params.model.provider == "opencode" {
            return Err(crate::runner_limits::refusal(
                "historian_zen_no_tools: OpenCode Zen requires an offered tool".into(),
            ));
        }
        let mut run = RoleSendRequest::new(self.params.prompt, self.params.send_id)
            .with_max_steps(HISTORIAN_SESSION_RUNNER_MAX_STEPS)
            .with_no_tools();
        if limits.max_output_tokens {
            if let Some(cap) = self.params.generation.max_output_tokens {
                run = run.with_max_output_tokens(cap);
            }
        }
        // Validate limits with the role builders, then copy their values into
        // SendParams to preserve the established wire-field order.
        self.params.stop_when = run
            .max_steps()
            .map_err(run_parameter_error)?
            .map(|max_steps| StopWhen { max_steps });
        self.params.generation.max_output_tokens =
            run.max_output_tokens().map_err(run_parameter_error)?;
        self.params.tools = run
            .no_tools()
            .map_err(run_parameter_error)?
            .filter(|empty| *empty)
            .map(|_| &[][..]);
        Ok(self)
    }
}

/// Build one `session.send` request. `model` is the canonical `provider/model` string,
/// split at the FIRST slash so multi-slash model names keep their remainder intact.
#[allow(clippy::too_many_arguments)] // Each argument corresponds to a separate wire value.
pub(crate) fn session_send_request<'a>(
    send_id: &'a str,
    system: &'a str,
    prompt: &'a str,
    model: &'a str,
    variant: Option<&'a str>,
    max_output_tokens: u32,
    temperature: Option<f64>,
    retention: ChildRetention,
) -> Result<SendRequest<'a>, HistorianProducerError> {
    let (provider, model_name) = model.split_once('/').ok_or_else(|| {
        HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "invalid_model",
            format!("model '{model}' is not in canonical provider/model form"),
        ))
    })?;
    let run = RoleSendRequest::new(prompt, send_id)
        .with_max_output_tokens(u64::from(max_output_tokens))
        .with_no_tools();
    Ok(SendRequest {
        method: "session.send",
        params: SendParams {
            prompt,
            send_id,
            model: SendModel {
                provider,
                model: model_name,
                variant: variant.filter(|variant| !variant.is_empty()),
            },
            // At most one member: a runner refuses a send carrying both.
            retention: retention.seconds(),
            retention_policy: retention.policy(),
            tools: run
                .no_tools()
                .map_err(run_parameter_error)?
                .filter(|empty| *empty)
                .map(|_| &[][..]),
            generation: GenerationRequest {
                max_output_tokens: run.max_output_tokens().map_err(run_parameter_error)?,
                temperature,
            },
            system,
            stop_when: None,
        },
    })
}

fn run_parameter_error(field: String) -> HistorianProducerError {
    HistorianProducerError::Subc(ProducerErrorBody::untagged("invalid_params", field))
}
const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for a summarization run to finish. A historian pass legitimately
/// generates 10k+ output tokens and can run several minutes on a flash-class model; a
/// 120s window abandoned a run on the rig WHILE it was still successfully finishing
/// (the terminal arrived moments after the waiter gave up). A fold is a background
/// operation, never latency-sensitive: waiting longer and publishing always beats
/// abandoning a completed run and re-firing the whole 50k-input pass.
const DEFAULT_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
/// How long the timeout recovery path gets to re-drain a run after the main
/// waiter gives up. A completed historian run can land moments after the
/// 600s wait expires; one short replay salvages that durable output without
/// letting the fallback path hang for another full production timeout.
const RECOVERY_REDRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Fixed error-class strings used by the producer/consumer wire contract.
pub const ERROR_CLASS_WIRE_SET: [&str; 4] = [
    "transient",
    "permanent",
    "auth_required",
    "context_overflow",
];

/// Runner route-open contract. Message literals identify the reporting stage;
/// typed error classes, when supplied, decide retryability instead of that text.
pub const RUNNER_REFUSAL_OPEN_CODES: [&str; 1] = ["open_failed"];
pub const RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS: [&str; 4] = [
    "run resolution failed",
    "no apikey credential for provider",
    "unknown provider",
    "unknown model",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerRefusalStage {
    Credential,
    Provider,
    Model,
    /// The runner refused route resolution without a more specific credential/catalog literal.
    Resolution,
}

impl RunnerRefusalStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Credential => "credential",
            Self::Provider => "provider",
            Self::Model => "model",
            Self::Resolution => "resolution",
        }
    }

    pub const fn canonical_cause(self) -> &'static str {
        match self {
            Self::Credential => "credential_unavailable",
            Self::Provider => "provider_unknown",
            Self::Model => "model_unknown",
            Self::Resolution => "runner_resolution_failed",
        }
    }

    pub const fn is_durable(self) -> bool {
        matches!(self, Self::Provider | Self::Model)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerRefusal {
    pub stage: RunnerRefusalStage,
    pub received_code: String,
    pub received_message: String,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

impl RunnerRefusal {
    /// Older runners supplied only text. Never let that text override a typed
    /// class, or permanently cache a refusal with an unknown future class.
    pub fn is_durable(&self) -> bool {
        if let Some(classification) = self.classification {
            return classification.class == ErrorClass::Permanent;
        }
        !self.class_field_present && self.stage.is_durable()
    }

    fn from_open_body(body: &ProducerErrorBody) -> Option<Self> {
        if !RUNNER_REFUSAL_OPEN_CODES.contains(&body.code.as_str()) {
            return None;
        }
        let message = body.message.to_ascii_lowercase();
        // Specific stages take precedence because the credential/provider/model messages are
        // commonly nested below the generic "run resolution failed" text.
        let stage = if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[1]) {
            RunnerRefusalStage::Credential
        } else if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[2]) {
            RunnerRefusalStage::Provider
        } else if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[3]) {
            RunnerRefusalStage::Model
        } else {
            RunnerRefusalStage::Resolution
        };
        Some(Self {
            stage,
            received_code: body.code.clone(),
            received_message: body.message.clone(),
            classification: body.classification(),
            class_field_present: body.has_class_field(),
        })
    }
}

static DEPRECATED_HEURISTIC_USES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Transient,
    Permanent,
    AuthRequired,
    ContextOverflow,
}

impl ErrorClass {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            ErrorClass::Transient => ERROR_CLASS_WIRE_SET[0],
            ErrorClass::Permanent => ERROR_CLASS_WIRE_SET[1],
            ErrorClass::AuthRequired => ERROR_CLASS_WIRE_SET[2],
            ErrorClass::ContextOverflow => ERROR_CLASS_WIRE_SET[3],
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "transient" => Some(ErrorClass::Transient),
            "permanent" => Some(ErrorClass::Permanent),
            "auth_required" | "auth" => Some(ErrorClass::AuthRequired),
            "context_overflow" => Some(ErrorClass::ContextOverflow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorClassification {
    pub class: ErrorClass,
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerErrorBody {
    pub code: String,
    pub message: String,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
    retry_metadata: Option<Value>,
}

impl ProducerErrorBody {
    pub fn untagged(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            classification: None,
            class_field_present: false,
            retry_metadata: None,
        }
    }

    pub fn tagged(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            classification: Some(ErrorClassification {
                class,
                retry_after_secs,
            }),
            class_field_present: true,
            retry_metadata: None,
        }
    }

    pub fn classification(&self) -> Option<ErrorClassification> {
        self.classification
    }

    pub fn has_class_field(&self) -> bool {
        self.class_field_present
    }

    fn from_value(value: Value) -> Self {
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("producer_error")
            .to_string();
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("producer error")
            .to_string();
        // Broca route-open failures carry their class in detail, not at the
        // top level used by ordinary producer errors. Absent detail.class keeps
        // the legacy message-based decision; unknown present classes do not.
        let class_source = if code == "open_failed" {
            value.get("detail").unwrap_or(&Value::Null)
        } else {
            &value
        };
        let (classification, class_field_present) = classification_from_object(class_source);
        Self {
            code,
            message,
            classification,
            class_field_present,
            retry_metadata: Some(value),
        }
    }
}

impl From<ErrorBody> for ProducerErrorBody {
    fn from(body: ErrorBody) -> Self {
        Self::untagged(body.code, body.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeprecatedHeuristicDecision {
    pub retryable_model_failure: bool,
    pub abort_or_overflow: bool,
}

pub fn deprecated_heuristic_uses() -> u64 {
    DEPRECATED_HEURISTIC_USES.load(Ordering::Relaxed)
}

#[cfg(test)]
pub(crate) fn reset_deprecated_heuristic_uses_for_test() {
    DEPRECATED_HEURISTIC_USES.store(0, Ordering::Relaxed);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHandle {
    pub run_id: String,
}

const STAGE_SUBMISSION_PREFIX: &str = "mc-broca-stage:";

/// Store this opaque handle in HistorianDurableState.producer_run_id. It includes
/// the exact request so restart can reattach even if the Broca model runner's
/// acknowledgement was lost. Broca deduplicates requests with the same send_id,
/// so replay returns the original submission rather than a second provider call.
pub(crate) fn stage_submission_handle(session_id: &str, request: &Value) -> RunHandle {
    RunHandle {
        run_id: format!(
            "{STAGE_SUBMISSION_PREFIX}{}",
            json!({"session_id": session_id, "request": request})
        ),
    }
}

pub(crate) fn is_stage_submission(handle: &str) -> bool {
    handle.starts_with(STAGE_SUBMISSION_PREFIX)
}

fn stage_submission(handle: &str) -> Result<Option<Value>, HistorianProducerError> {
    handle
        .strip_prefix(STAGE_SUBMISSION_PREFIX)
        .map(serde_json::from_str)
        .transpose()
        .map_err(Into::into)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerOutput {
    pub text: String,
    /// True when a completion transport reports an output-length finish. The role
    /// result does not define that metadata, so llm-runner leaves this false rather
    /// than inferring a finish reason from an open control event.
    pub length_capped: bool,
    /// Provider token spend for the run, when the runner reported any. `None` means
    /// nothing was reported, not a zero-cost run.
    pub usage: Option<ProducerUsage>,
}

/// Token spend for one producer run, summed over its model steps. Field meanings follow
/// the runner's usage record: `input` is fresh (non-cached) input, `cache_read` and
/// `cache_write` are the cached-input hit and cache-creation counts, and `output`
/// already includes any reasoning tokens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProducerUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

pub(crate) fn producer_token_log(
    usage: Option<ProducerUsage>,
    max_tokens: Option<u32>,
    length_capped: bool,
) -> Value {
    serde_json::json!({
        "input": usage.map(|value| value.input),
        "output": usage.map(|value| value.output),
        "reasoning": None::<u64>,
        "cache_read": usage.map(|value| value.cache_read),
        "cache_write": usage.map(|value| value.cache_write),
        "max_tokens": max_tokens,
        "finish_reason": if length_capped { Some("length") } else { None },
    })
}

impl ProducerUsage {
    pub(crate) fn from_contract_usage(
        value: &cortexkit_role_llm_runner::usage::RunUsage,
    ) -> Option<Self> {
        if [
            value.input_tokens,
            value.output_tokens,
            value.cached_input_tokens,
            value.cache_write_tokens,
        ]
        .iter()
        .all(Option::is_none)
        {
            return None;
        }
        Some(Self {
            input: value.input_tokens.unwrap_or(0),
            output: value.output_tokens.unwrap_or(0),
            cache_read: value.cached_input_tokens.unwrap_or(0),
            cache_write: value.cache_write_tokens.unwrap_or(0),
        })
    }
    /// Reads a runner usage object (`input_tokens`, `output_tokens`,
    /// `cached_input_tokens`, `cache_write_tokens`; each optional). Returns `None` when
    /// the value is not an object.
    #[cfg(test)]
    fn from_runner_usage(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let field = |name: &str| object.get(name).and_then(Value::as_u64).unwrap_or(0);
        Some(Self {
            input: field("input_tokens"),
            output: field("output_tokens"),
            cache_read: field("cached_input_tokens"),
            cache_write: field("cache_write_tokens"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunState {
    Terminal,
    Active,
    Missing { detail: Option<String> },
}

#[derive(Debug, Clone)]
pub struct HistorianProducerConfig {
    pub connection_file: PathBuf,
    pub project_root: PathBuf,
    pub harness: String,
    pub route_targets: RouteTargetConfig,
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    pub await_timeout: Duration,
}

impl HistorianProducerConfig {
    pub fn new(
        connection_file: impl Into<PathBuf>,
        project_root: impl Into<PathBuf>,
        harness: impl Into<String>,
    ) -> Self {
        Self {
            connection_file: connection_file.into(),
            project_root: project_root.into(),
            harness: harness.into(),
            route_targets: RouteTargetConfig::default(),
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            await_timeout: DEFAULT_AWAIT_TIMEOUT,
        }
    }
}

#[derive(Debug)]
pub enum HistorianProducerError {
    ConnectionFile {
        path: PathBuf,
        source: ConnectionFileError,
    },
    NoEndpoint {
        path: PathBuf,
    },
    Connect {
        endpoint: String,
        source: std::io::Error,
    },
    Auth(AuthError),
    FrameIo(FrameIoError),
    FrameBuild(FrameBuildError),
    Json(serde_json::Error),
    Subc(ProducerErrorBody),
    UnexpectedControlResponse,
    MissingRunId,
    /// The send was accepted but did not start a run: the lineage already had an active
    /// run, so the prompt was durably queued behind it under `submission_id`.
    SendQueued {
        submission_id: String,
        /// Whether the queued submission was withdrawn again. A submission left standing
        /// eventually runs a model call whose output no one is waiting for.
        retracted: bool,
    },
    MissingSession,
    RunnerSessionDeletionUnsupported {
        session_id: String,
    },
    HostRunnerRequiresHostTransport,
    UnexpectedStreamEnd,
    TimedOut,
    RunFailed {
        run_id: String,
        detail: String,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
    TerminalRunMismatch {
        expected: String,
        found: Option<String>,
    },
    RunPaused {
        run_id: String,
        reason: Option<String>,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
}

impl HistorianProducerError {
    /// An llm-runner reply in the wrong envelope (`runner_reply_shape`).
    pub(crate) fn is_runner_reply_shape(&self) -> bool {
        matches!(self, Self::Subc(body) if body.code == crate::session_resolver::RUNNER_REPLY_SHAPE)
    }

    pub(crate) fn unknown_send_outcome(&self) -> bool {
        matches!(
            self,
            Self::FrameIo(_) | Self::UnexpectedStreamEnd | Self::TimedOut
        )
    }
    /// Provider reset metadata is a retry hint, never an error-class override.
    pub(crate) fn unknown_run_outcome(&self) -> bool {
        !matches!(self, Self::RunFailed { .. })
    }

    pub(crate) fn provider_retry_at_ms(&self, now_ms: i64) -> Option<i64> {
        let (metadata, text) = match self {
            Self::Subc(body) => (body.retry_metadata.as_ref(), body.message.as_str()),
            Self::RunFailed { detail, .. } => (None, detail.as_str()),
            Self::RunPaused { reason, .. } => (None, reason.as_deref().unwrap_or("")),
            _ => return None,
        };
        metadata
            .and_then(|value| provider_retry_at_ms(value, now_ms, 0))
            .or_else(|| provider_retry_at_ms(&Value::String(text.to_string()), now_ms, 0))
            .or_else(|| {
                let seconds = self.classification()?.retry_after_secs?;
                let delay_ms = seconds.saturating_mul(1000).min(i64::MAX as u64) as i64;
                Some(
                    now_ms.saturating_add(
                        delay_ms.max(crate::historian::HISTORIAN_FAILURE_BACKOFF_MS),
                    ),
                )
            })
    }

    pub fn retryable_model_failure(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "retryable_model_failure",
            message,
        ))
    }

    pub fn context_overflow(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged("context_overflow", message))
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged("aborted", message))
    }

    pub fn tagged_subc(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::tagged(
            code,
            message,
            class,
            retry_after_secs,
        ))
    }

    pub fn classification(&self) -> Option<ErrorClassification> {
        match self {
            HistorianProducerError::Subc(body) => body.classification(),
            HistorianProducerError::RunFailed { classification, .. }
            | HistorianProducerError::RunPaused { classification, .. } => *classification,
            // A busy lineage clears once its active run ends, so a queued send is always
            // worth retrying. This is a fact about the response, not a parsed hint.
            HistorianProducerError::SendQueued { .. } => Some(ErrorClassification {
                class: ErrorClass::Transient,
                retry_after_secs: None,
            }),
            _ => None,
        }
    }

    pub fn has_class_field(&self) -> bool {
        match self {
            HistorianProducerError::Subc(body) => body.has_class_field(),
            HistorianProducerError::RunFailed {
                class_field_present,
                ..
            }
            | HistorianProducerError::RunPaused {
                class_field_present,
                ..
            } => *class_field_present,
            _ => false,
        }
    }

    pub(crate) fn deprecated_heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        record_deprecated_heuristic_use(self.heuristic_log_code());
        self.heuristic_decision()
    }

    pub fn is_retryable_model_failure(&self) -> bool {
        if let Some(classification) = self.classification() {
            return classification.class == ErrorClass::Transient;
        }
        if self.has_class_field() {
            return false;
        }
        self.heuristic_decision().retryable_model_failure
    }

    pub fn is_abort_or_overflow(&self) -> bool {
        if let Some(classification) = self.classification() {
            return classification.class == ErrorClass::ContextOverflow;
        }
        if self.has_class_field() {
            return false;
        }
        self.heuristic_decision().abort_or_overflow
    }

    pub fn is_unknown_module(&self) -> bool {
        matches!(
            self,
            HistorianProducerError::Subc(body) if body.code == "unknown_module"
        )
    }

    pub(crate) fn is_expired(&self) -> bool {
        matches!(self, HistorianProducerError::Subc(body) if body.code == "expired")
    }

    /// Parse a route-open refusal while preserving the runner's code and message verbatim.
    pub fn runner_refusal(&self) -> Option<RunnerRefusal> {
        let HistorianProducerError::Subc(body) = self else {
            return None;
        };
        RunnerRefusal::from_open_body(body)
    }

    fn heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        match self {
            HistorianProducerError::Subc(body) => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(&body.code)
                    || retryable_code(&body.message),
                abort_or_overflow: abort_or_overflow(&body.code)
                    || abort_or_overflow(&body.message),
            },
            HistorianProducerError::RunFailed { detail, .. } => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(detail),
                abort_or_overflow: abort_or_overflow(detail),
            },
            _ => DeprecatedHeuristicDecision {
                retryable_model_failure: false,
                abort_or_overflow: false,
            },
        }
    }

    fn heuristic_log_code(&self) -> &str {
        match self {
            HistorianProducerError::Subc(body) => &body.code,
            HistorianProducerError::RunFailed { .. } => "run_failed",
            HistorianProducerError::RunPaused { .. } => "run_paused",
            HistorianProducerError::SendQueued { .. } => "send_queued",
            HistorianProducerError::TimedOut => "timed_out",
            _ => "producer_error",
        }
    }
}

fn record_deprecated_heuristic_use(code: &str) {
    DEPRECATED_HEURISTIC_USES.fetch_add(1, Ordering::Relaxed);
    tracing::error!("[mc-module] untagged producer error (deprecated heuristic used): code={code}");
}

fn retryable_code(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("retry")
        || s.contains("transient")
        || s.contains("rate_limit")
        || s.contains("quota_exhausted")
        || s.trim() == "429"
        || s.contains("provider_unavailable")
        || s.contains("overloaded")
}

fn abort_or_overflow(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("abort")
        || s.contains("cancel")
        || s.contains("context_overflow")
        || s.contains("overflow")
}

impl fmt::Display for HistorianProducerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistorianProducerError::ConnectionFile { path, source } => {
                write!(f, "read connection file {}: {source}", path.display())
            }
            HistorianProducerError::NoEndpoint { path } => {
                write!(f, "connection file {} has no endpoint", path.display())
            }
            HistorianProducerError::Connect { endpoint, source } => {
                write!(f, "connect to {endpoint}: {source}")
            }
            HistorianProducerError::Auth(e) => write!(f, "authenticate to subc: {e}"),
            HistorianProducerError::FrameIo(e) => write!(f, "subc frame I/O: {e}"),
            HistorianProducerError::FrameBuild(e) => write!(f, "build subc frame: {e}"),
            HistorianProducerError::Json(e) => write!(f, "json: {e}"),
            HistorianProducerError::Subc(body) => {
                write!(f, "subc error {}: {}", body.code, body.message)
            }
            HistorianProducerError::UnexpectedControlResponse => {
                write!(f, "route.open returned an unexpected control response")
            }
            HistorianProducerError::MissingRunId => {
                write!(f, "session.send did not return an active run_id")
            }
            HistorianProducerError::SendQueued {
                submission_id,
                retracted,
            } => write!(
                f,
                "session.send queued this prompt behind the run already active on the session (submission {submission_id}, retracted: {})",
                if *retracted { "yes" } else { "no" }
            ),
            HistorianProducerError::MissingSession => {
                write!(f, "historian producer has no bound session")
            }
            HistorianProducerError::RunnerSessionDeletionUnsupported { session_id } => write!(
                f,
                "runner cannot delete session {session_id}; Broca never deletes sessions, so it stays in Broca's store indefinitely"
            ),
            HistorianProducerError::HostRunnerRequiresHostTransport => {
                write!(f, "host historian runner does not use a subc module route")
            }
            HistorianProducerError::UnexpectedStreamEnd => write!(
                f,
                "subscribe stream ended before the run terminal control unit"
            ),
            HistorianProducerError::TimedOut => write!(f, "historian producer timed out"),
            HistorianProducerError::RunFailed { run_id, detail, .. } => {
                write!(f, "run {run_id} failed: {detail}")
            }
            HistorianProducerError::TerminalRunMismatch { expected, found } => {
                write!(
                    f,
                    "run {expected} received terminal control unit after RunStarted {:?}",
                    found
                )
            }
            HistorianProducerError::RunPaused { run_id, reason, .. } => {
                write!(f, "run {run_id} paused")?;
                if let Some(reason) = reason {
                    write!(f, ": {reason}")?;
                }
                Ok(())
            }
        }
    }
}

impl Error for HistorianProducerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            HistorianProducerError::ConnectionFile { source, .. } => Some(source),
            HistorianProducerError::Connect { source, .. } => Some(source),
            HistorianProducerError::Auth(e) => Some(e),
            HistorianProducerError::FrameIo(e) => Some(e),
            HistorianProducerError::FrameBuild(e) => Some(e),
            HistorianProducerError::Json(e) => Some(e),
            HistorianProducerError::NoEndpoint { .. }
            | HistorianProducerError::Subc(_)
            | HistorianProducerError::UnexpectedControlResponse
            | HistorianProducerError::MissingRunId
            | HistorianProducerError::SendQueued { .. }
            | HistorianProducerError::MissingSession
            | HistorianProducerError::RunnerSessionDeletionUnsupported { .. }
            | HistorianProducerError::HostRunnerRequiresHostTransport
            | HistorianProducerError::UnexpectedStreamEnd
            | HistorianProducerError::TimedOut
            | HistorianProducerError::RunFailed { .. }
            | HistorianProducerError::TerminalRunMismatch { .. }
            | HistorianProducerError::RunPaused { .. } => None,
        }
    }
}

impl From<FrameIoError> for HistorianProducerError {
    fn from(e: FrameIoError) -> Self {
        HistorianProducerError::FrameIo(e)
    }
}

impl From<FrameBuildError> for HistorianProducerError {
    fn from(e: FrameBuildError) -> Self {
        HistorianProducerError::FrameBuild(e)
    }
}

impl From<serde_json::Error> for HistorianProducerError {
    fn from(e: serde_json::Error) -> Self {
        HistorianProducerError::Json(e)
    }
}

/// The daemon-assigned identity of an open consumer route.
///
/// This raw client cannot construct `subc_client_rs::RouteHandle` because that type also
/// fences SDK-managed connections. It retains the serializable wire identity needed to
/// stamp every data-plane frame and reject stale replies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenedRoute {
    channel: u16,
    epoch: u32,
}

pub struct HistorianProducer {
    config: HistorianProducerConfig,
    stream: TcpStream,
    next_corr: u64,
    session_id: Option<String>,
    command_route: Option<OpenedRoute>,
    subscribe_route: Option<OpenedRoute>,
    /// `None` means this route has not been queried; otherwise the retention member
    /// its runner's `role.describe` selects. This cache belongs to a route and is
    /// cleared on close.
    route_retention: Option<ChildRetention>,
    route_limits: RunnerLimits,
    route_follow: FollowCapabilities,
    control_pending: bool,
    /// Freeze the first send's policy for this session. In particular, a session that
    /// began without retention must not opt in on a later send.
    session_retention: Option<ChildRetention>,
    /// The child this producer sent `session.release` for, so no child is
    /// released twice.
    released: Option<String>,
    /// When set, every route opens to this session's own runner instead of the
    /// configured runner module. The child session remains its own bind identity.
    session_runner: Option<SessionRunnerRoute>,
    /// When set, every route opens to the runner module routing answered, under
    /// the conversation's scope. Takes precedence over `session_runner`.
    routed_runner: Option<RoutedRunnerTarget>,
}

/// The runner module a `route.select` answer named and the scope the answer
/// was given under. Child routes open under that same scope, so the runner
/// sees the same project and session routing placed the work for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutedRunnerTarget {
    pub module_id: String,
    pub scope: subc_protocol::scope::ScopeSelector,
}

impl HistorianProducer {
    /// Dormant calls keep session_id as send_id, as the original producer did.
    /// Enabled historian turns share one provider session, with send keys that
    /// distinguish project, publication, run attempt and turn. Clause checks use
    /// separate sessions so they cannot inherit earlier historian messages.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_stage_with_generation(
        &mut self,
        session_id: &str,
        stage_key: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        max_output_tokens: u32,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        if !crate::historian_stage::lifecycle_enabled() {
            return self
                .start_with_generation(
                    session_id,
                    system,
                    prompt,
                    model,
                    variant,
                    max_output_tokens,
                    temperature,
                )
                .await;
        }
        if self.session_id.as_deref() != Some(session_id) {
            self.close().await;
        }
        self.bind_session(session_id.to_string());
        let route = self.ensure_command_route().await?;
        // Stage sends carry no retention: recovery rebuilds this exact body from the
        // persisted stage request to derive the same submission handle, and that request
        // does not record a retention. Giving stage sessions a retention would first require
        // persisting it in that stage request. Stage sends happen only while
        // `historian_stage::RUST_LIFECYCLE_ENABLED` is on, which it is not in production.
        self.retention_for_route(route).await?;
        self.require_follow()?;
        let request = serde_json::to_value(
            session_send_request(
                stage_key,
                system,
                prompt,
                model,
                variant,
                max_output_tokens,
                temperature,
                ChildRetention::Nothing,
            )?
            .for_session_runner(self.route_limits)?,
        )?;
        match self.unary_json(route, &request).await {
            Ok(response) => match send_outcome(&response) {
                SendOutcome::Active(run_id) => Ok(RunHandle { run_id }),
                SendOutcome::Queued(_) => Ok(stage_submission_handle(session_id, &request)),
                SendOutcome::Unrecognized => Err(HistorianProducerError::MissingRunId),
            },
            // The write may have reached Broca. Keep the original key and request
            // rather than starting a fallback attempt with an unknown outcome.
            Err(error) if error.unknown_send_outcome() => {
                Ok(stage_submission_handle(session_id, &request))
            }
            Err(error) => Err(error),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_check_with_generation(
        &mut self,
        check_key: &str,
        system: &str,
        operands_and_input: &str,
        model: &str,
        variant: Option<&str>,
        max_output_tokens: u32,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        if !crate::historian_stage::lifecycle_enabled() {
            return Err(HistorianProducerError::Subc(ProducerErrorBody::untagged(
                "historian_lane_dormant",
                "clause checks require an enabled historian lane",
            )));
        }
        let session = crate::historian_stage::check_session_id(check_key);
        self.start_stage_with_generation(
            &session,
            check_key,
            system,
            operands_and_input,
            model,
            variant,
            max_output_tokens,
            temperature,
        )
        .await
    }

    async fn reattach_submission(
        &mut self,
        submission: &Value,
    ) -> Result<String, HistorianProducerError> {
        let session = submission["session_id"]
            .as_str()
            .ok_or(HistorianProducerError::MissingRunId)?;
        if self.session_id.as_deref() != Some(session) {
            self.close().await;
        }
        self.bind_session(session.to_string());
        loop {
            let route = self.ensure_command_route().await?;
            let response = self.unary_json(route, &submission["request"]).await?;
            match send_outcome(&response) {
                SendOutcome::Active(run_id) => return Ok(run_id),
                SendOutcome::Queued(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                SendOutcome::Unrecognized => return Err(HistorianProducerError::MissingRunId),
            }
        }
    }
    pub async fn connect(config: HistorianProducerConfig) -> Result<Self, HistorianProducerError> {
        let conn = connection_file::read(&config.connection_file).map_err(|source| {
            HistorianProducerError::ConnectionFile {
                path: config.connection_file.clone(),
                source,
            }
        })?;
        let endpoint =
            conn.endpoints
                .first()
                .ok_or_else(|| HistorianProducerError::NoEndpoint {
                    path: config.connection_file.clone(),
                })?;
        let endpoint_label = format!("{}:{}", endpoint.host, endpoint.port);
        let mut stream = TcpStream::connect(&endpoint_label)
            .await
            .map_err(|source| HistorianProducerError::Connect {
                endpoint: endpoint_label,
                source,
            })?;
        authenticate_client(&mut stream, &conn, config.handshake_timeout)
            .await
            .map_err(HistorianProducerError::Auth)?;
        Ok(Self {
            config,
            stream,
            next_corr: 1,
            session_id: None,
            command_route: None,
            subscribe_route: None,
            route_retention: None,
            route_limits: RunnerLimits::default(),
            route_follow: FollowCapabilities::default(),
            control_pending: false,
            session_retention: None,
            released: None,
            session_runner: None,
            routed_runner: None,
        })
    }

    /// Connect a producer whose routes go to the runner module routing selected.
    pub async fn connect_to_routed_runner(
        config: HistorianProducerConfig,
        target: RoutedRunnerTarget,
    ) -> Result<Self, HistorianProducerError> {
        let mut producer = Self::connect(config).await?;
        producer.routed_runner = Some(target);
        Ok(producer)
    }

    /// Connect a producer whose routes go to a runner-lane conversation's own runner.
    pub async fn connect_to_session_runner(
        config: HistorianProducerConfig,
        route: SessionRunnerRoute,
    ) -> Result<Self, HistorianProducerError> {
        let mut producer = Self::connect(config).await?;
        producer.session_runner = Some(route);
        Ok(producer)
    }

    /// Bind subsequent status/subscribe/cancel calls to an existing session. Reattach
    /// probes open the route with the persisted session id and must not call send again.
    pub fn bind_session(&mut self, session_id: impl Into<String>) {
        let session_id = session_id.into();
        if self.session_id.as_deref() != Some(session_id.as_str()) {
            self.session_retention = None;
        }
        self.session_id = Some(session_id);
    }

    pub async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start_with_generation(
            session_id,
            system,
            prompt,
            model,
            None,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            None,
        )
        .await
    }

    pub async fn start_with_temperature(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start_with_generation(
            session_id,
            system,
            prompt,
            model,
            variant,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            temperature,
        )
        .await
    }

    /// `variant` is the host-configured model variant for this attempt's model (for
    /// example an OpenCode reasoning variant). It rides `model.variant`; `None` omits it.
    #[allow(clippy::too_many_arguments)] // Each value is a distinct field of one send.
    pub async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        max_output_tokens: u32,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.bind_session(session_id.to_string());
        let route = self.ensure_command_route().await?;
        // Check `role.describe` before building this send; the groups it declares pick
        // the retention member (see `child_retention`). Its first accepted send fixes the
        // session's lifetime, so repeat sends must keep that initial policy.
        let declared_retention = self.retention_for_route(route).await?;
        self.require_follow()?;
        let retention = select_session_retention(&mut self.session_retention, declared_retention);
        // The route identity is the session. Keeping `session` out of this body avoids
        // a second, diverging source of truth for the run lineage.
        //
        // `system` rides the role-scoped SendParams.system field (delivered as a leading
        // system message in the run's durable input, byte-exact) — NEVER concatenated
        // into the user prompt: the historian's parse/validate contract assumes the
        // model saw its role guidance as a system message. Empty means absent, matching
        // the wire's empty-as-absent rule, so we omit the field entirely.
        //
        // The params shape mirrors llm-runner's SendParams (llmr-module-serve wire.rs):
        // `model` is a nested {provider, model, variant?} object. The server decodes
        // strictly enough that a flat model string fails the whole send with
        // invalid_params, which a live rig drive surfaced as firings dying before any
        // producer run existed.
        //
        // Each historian firing (including model fallbacks) and dreamer attempt owns
        // a distinct session id. Use that durable attempt identity as `send_id`, not a
        // connection nonce or frame correlation id: resending after a lost reply must
        // deduplicate, while a new attempt after a classified failure must start a new run.
        let body = session_send_request(
            session_id,
            system,
            prompt,
            model,
            variant,
            max_output_tokens,
            temperature,
            retention,
        )?
        .for_session_runner(self.route_limits)?;
        let response = self.unary_json(route, body).await?;
        match send_outcome(&response) {
            SendOutcome::Active(run_id) => Ok(RunHandle { run_id }),
            SendOutcome::Queued(submission_id) => {
                // The prompt was ACCEPTED, not rejected: the run this producer wanted is
                // sitting in the lineage's queue. Nothing here will ever drain it — this
                // producer only subscribes to a run it started — so withdraw it rather
                // than leave a model call to fire for output no one is waiting for.
                let retracted = self.retract(route, &submission_id).await.is_ok();
                Err(HistorianProducerError::SendQueued {
                    submission_id,
                    retracted,
                })
            }
            SendOutcome::Unrecognized => Err(HistorianProducerError::MissingRunId),
        }
    }

    /// Withdraw a queued submission. Best effort: a submission the server has already
    /// consumed, or a server without the operation, is reported by the caller as such.
    async fn retract(
        &mut self,
        route: OpenedRoute,
        submission_id: &str,
    ) -> Result<(), HistorianProducerError> {
        let _ = self
            .unary_json(
                route,
                json!({
                    "method": "session.retract",
                    "params": { "submission_id": submission_id }
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.await_output_with_timeout(run_id, self.config.await_timeout)
            .await
    }

    pub async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.redrain_output_with_timeout(run_id, RECOVERY_REDRAIN_TIMEOUT)
            .await
    }

    pub async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        if is_stage_submission(run_id) {
            return Ok(RunState::Active);
        }
        let route = self.ensure_command_route().await?;
        self.retention_for_route(route).await?;
        self.require_follow()?;
        let response = self
            .unary_json(
                route,
                json!({ "method": "run.status", "params": { "run_id": run_id } }),
            )
            .await?;
        Ok(classify_run_state(run_id, &response))
    }

    pub async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
        // This handle may name a queued send or a send whose acknowledgement was
        // lost. Its eventual run is not yet known. Preserve it for recovery rather
        // than retracting the send or using this local handle as a provider run id.
        if is_stage_submission(run_id) {
            return Ok(());
        }
        let route = self.ensure_command_route().await?;
        let _ = self
            .unary_json(
                route,
                json!({ "method": "run.cancel", "params": { "run_id": run_id } }),
            )
            .await?;
        Ok(())
    }

    /// Release the bound child session once its result has been consumed: one
    /// `session.release {}` call when the runner declares `session_retention`
    /// (every child ck-mc starts on such a runner was sent the keep-nothing
    /// policy). The outcome is logged once with `parent` and never retried; a
    /// child is never released twice. Returns `None` when nothing was called.
    pub(crate) async fn release_child(
        &mut self,
        kind: &str,
        parent: &str,
    ) -> Option<ReleaseOutcome> {
        let child = self.session_id.clone()?;
        if self.released.as_deref() == Some(child.as_str()) {
            return None;
        }
        let route = match self.ensure_command_route().await {
            Ok(route) => route,
            Err(error) => {
                tracing::warn!(
                    "[mc-module] {kind} child {child} of {parent}: no route to release it: {error}"
                );
                return None;
            }
        };
        if self.retention_for_route(route).await.ok()? != ChildRetention::Policy {
            return None;
        }
        self.released = Some(child.clone());
        let body = json!({ "method": child_retention::SESSION_RELEASE, "params": {} });
        let outcome = match self.send_request(route, body).await {
            Err(error) => ReleaseOutcome::Unanswered(error.to_string()),
            Ok(corr) => match self
                .read_terminal_for(route, corr, self.config.request_timeout)
                .await
            {
                Err(error) => ReleaseOutcome::Unanswered(error.to_string()),
                Ok(frame) => release_outcome(frame.header.ty, &frame.body),
            },
        };
        child_retention::log_release(kind, parent, &child, &outcome);
        Some(outcome)
    }

    /// Release routes, but report that the runner cannot delete session data.
    /// Dreamer sessions contain memory-pool snapshots; closing a route does not
    /// remove those snapshots from Broca's append-only write-ahead log. A child
    /// already released through `release_child` is the runner's to delete, so
    /// that case closes the routes and reports nothing.
    pub async fn purge_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        let released = self.released.as_deref() == Some(session_id);
        self.close().await;
        if released {
            return Ok(());
        }
        static RETENTION_WARNING: std::sync::Once = std::sync::Once::new();
        RETENTION_WARNING.call_once(|| {
            tracing::warn!("[mc-module] runner cannot delete sessions: Broca has no session.delete operation and never deletes a session. Its write-ahead log is append-only, an idle session is moved into an archive byte for byte after 7 days and kept, and engram backs both up. Dreamer memory-pool snapshots sent to the runner therefore stay indefinitely; closing routes does not delete them.");
        });
        Err(HistorianProducerError::RunnerSessionDeletionUnsupported {
            session_id: session_id.to_string(),
        })
    }

    pub async fn close(&mut self) {
        if let Some(route) = self.subscribe_route.take() {
            let _ = self.send_goodbye(route).await;
        }
        if let Some(route) = self.command_route.take() {
            let _ = self.send_goodbye(route).await;
        }
        self.route_retention = None;
        self.route_limits = RunnerLimits::default();
        self.route_follow = FollowCapabilities::default();
        self.control_pending = false;
    }

    /// Read and cache the route runner's `role.describe`: its retention, run
    /// limits and follow groups. A reply in the wrong envelope is returned as
    /// `runner_reply_shape` and nothing is cached; any other failure reads as a
    /// runner declaring no groups, which `require_follow` then names.
    async fn retention_for_route(
        &mut self,
        route: OpenedRoute,
    ) -> Result<ChildRetention, HistorianProducerError> {
        if let Some(retention) = self.route_retention {
            return Ok(retention);
        }

        let described = self
            .unary_json(route, json!({ "method": "role.describe", "params": {} }))
            .await;
        let retention = match described {
            Ok(answer) => {
                self.route_limits = RunnerLimits::from_describe(&answer);
                self.route_follow = FollowCapabilities::from_describe(&answer);
                retention_from_role_describe(&answer)
            }
            Err(error) if error.is_runner_reply_shape() => return Err(error),
            Err(_) => ChildRetention::Nothing,
        };
        if retention == ChildRetention::Nothing {
            static RETENTION_UNAVAILABLE_WARNING: std::sync::Once = std::sync::Once::new();
            RETENTION_UNAVAILABLE_WARNING.call_once(|| {
                tracing::warn!("[mc-module] Broca does not declare a usable retention capability; historian and dreamer sessions will use the runner's default lifetime");
            });
        }
        self.route_retention = Some(retention);
        Ok(retention)
    }

    /// Reuse the route-local describe cache for both configured and session-owned
    /// module runners. Discovery binds the next child, never the foreground session.
    pub(crate) async fn session_runner_limits(
        &mut self,
        child: &str,
    ) -> Result<Option<RunnerLimits>, HistorianProducerError> {
        self.bind_session(child.to_string());
        let route = self.ensure_command_route().await?;
        self.retention_for_route(route).await?;
        self.require_follow()?;
        Ok(Some(self.route_limits))
    }

    fn require_follow(&self) -> Result<(), HistorianProducerError> {
        match self.route_follow.missing() {
            Some(reason) => Err(crate::runner_limits::refusal(reason.into())),
            None => Ok(()),
        }
    }

    async fn subscribe_from_start(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let follow = async {
            let resolved = if let Some(submission) = stage_submission(run_id)? {
                self.reattach_submission(&submission).await?
            } else {
                run_id.to_string()
            };
            let route = self.ensure_command_route().await?;
            self.retention_for_route(route).await?;
            self.require_follow()?;
            let subscription = if self.route_follow.streaming {
                let route = self.ensure_subscribe_route().await?;
                let body = json!({ "method": "session.subscribe", "params": { "from": "start" } });
                let corr = self.send_request(route, body).await?;
                Some((route, corr))
            } else {
                None
            };
            self.drain_subscribe(subscription, &resolved).await
        };
        match tokio::time::timeout(timeout, follow).await {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    async fn ensure_command_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        if let Some(route) = self.command_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.command_route = Some(route);
        Ok(route)
    }

    async fn ensure_subscribe_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        if let Some(route) = self.subscribe_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.subscribe_route = Some(route);
        Ok(route)
    }

    async fn open_bound_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        let session = self
            .session_id
            .clone()
            .ok_or(HistorianProducerError::MissingSession)?;
        let target = match (&self.routed_runner, &self.session_runner) {
            (Some(routed), _) => crate::route_targets::routed_module_target(&routed.module_id),
            (None, Some(route)) => route.target(),
            (None, None) => self
                .config
                .route_targets
                .target(RegisteredRoute::HistorianRunner)
                .ok_or(HistorianProducerError::HostRunnerRequiresHostTransport)?,
        };
        let request = ClientControlRequest::RouteOpen {
            target,
            identity: BindIdentity::new(
                self.config.project_root.clone(),
                self.config.harness.clone(),
                session,
            ),
            consumer_identity: consumer_identity_from_launch(),
            consumer_capabilities: None,
            admission_facts: None,
            // A routed summary runs under the conversation's scope, the same stamp
            // routing selected under. Other historian routes carry no scope and
            // run under the module's own identity.
            scope: self
                .routed_runner
                .as_ref()
                .map(|routed| routed.scope.clone()),
            // The historian runner is an llm-runner management surface.
            role_versions: Some(crate::session_resolver::llm_runner_role_versions()),
        };
        let corr = self.next_corr();
        let body = serde_json::to_vec(&request)?;
        self.write_frame(FrameType::Request, 0, 0, corr, body)
            .await?;
        let frame = self
            .read_terminal_for(
                OpenedRoute {
                    channel: 0,
                    epoch: 0,
                },
                corr,
                self.config.request_timeout,
            )
            .await?;
        match frame.header.ty {
            FrameType::Response => {
                let response: ClientControlResponse = serde_json::from_slice(&frame.body)?;
                if let ClientControlResponse::RouteOpen {
                    route_channel,
                    route_epoch,
                } = response
                {
                    Ok(OpenedRoute {
                        channel: route_channel,
                        epoch: route_epoch,
                    })
                } else {
                    Err(HistorianProducerError::UnexpectedControlResponse)
                }
            }
            FrameType::Error => Err(HistorianProducerError::Subc(error_body(&frame.body))),
            _ => Err(HistorianProducerError::UnexpectedControlResponse),
        }
    }

    /// One llm-runner op on `route`, returning the answer inside its reply.
    /// Every llm-runner reply is exactly `{"result": <answer>}`; a reply in any
    /// other shape is refused as `runner_reply_shape` by
    /// `session_resolver::read_runner_reply`, the one decoder of that envelope.
    async fn unary_json(
        &mut self,
        route: OpenedRoute,
        body: impl Serialize + Send,
    ) -> Result<Value, HistorianProducerError> {
        let corr = self.send_request(route, body).await?;
        let frame = self
            .read_terminal_for(route, corr, self.config.request_timeout)
            .await?;
        match frame.header.ty {
            FrameType::Response => {
                crate::session_resolver::read_runner_reply(serde_json::from_slice(&frame.body)?)
                    .map_err(|shape| {
                        HistorianProducerError::Subc(ProducerErrorBody::untagged(
                            crate::session_resolver::RUNNER_REPLY_SHAPE,
                            shape.to_string(),
                        ))
                    })
            }
            FrameType::StreamEnd => Ok(Value::Null),
            FrameType::Error => Err(HistorianProducerError::Subc(error_body(&frame.body))),
            _ => Err(HistorianProducerError::UnexpectedControlResponse),
        }
    }

    async fn send_request(
        &mut self,
        route: OpenedRoute,
        body: impl Serialize + Send,
    ) -> Result<u64, HistorianProducerError> {
        let corr = self.next_corr();
        let bytes = serde_json::to_vec(&body)?;
        self.write_frame(FrameType::Request, route.channel, route.epoch, corr, bytes)
            .await?;
        Ok(corr)
    }

    async fn drain_subscribe(
        &mut self,
        mut subscription: Option<(OpenedRoute, u64)>,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        loop {
            let route = self.ensure_command_route().await?;
            let answer = self
                .unary_json(
                    route,
                    json!({"method":"run.status", "params":{"run_id":run_id}}),
                )
                .await?;
            let status: RoleRunStatus = serde_json::from_value(answer)?;
            if status.run_state().is_terminal() {
                let answer = self
                    .unary_json(
                        route,
                        json!({"method":"run.result", "params":{"run_id":run_id}}),
                    )
                    .await?;
                let result: RoleRunResult = serde_json::from_value(answer)?;
                if result.run_id != run_id
                    || result.state != status.state
                    || !result.final_message_consistent()
                {
                    return Err(HistorianProducerError::Subc(ProducerErrorBody::untagged(
                        "run_result_malformed",
                        "run.result disagrees with the requested run or its terminal status",
                    )));
                }
                return output_from_run_result(result, self.route_follow.run_usage);
            }
            // Active, paused and unknown future states are all nonterminal. A
            // quiet or ended subscription cannot make any of them terminal.
            self.wait_for_control(&mut subscription).await?;
        }
    }

    async fn wait_for_control(
        &mut self,
        subscription: &mut Option<(OpenedRoute, u64)>,
    ) -> Result<(), HistorianProducerError> {
        if std::mem::take(&mut self.control_pending) {
            return Ok(());
        }
        let Some((route, corr)) = *subscription else {
            tokio::time::sleep(runner_follow::POLL_INTERVAL).await;
            return Ok(());
        };
        let wake = async {
            loop {
                let Some(frame) = read_frame(&mut self.stream).await? else {
                    return Err(HistorianProducerError::UnexpectedStreamEnd);
                };
                if frame.header.channel != route.channel
                    || frame.header.epoch != route.epoch
                    || frame.header.corr != corr
                {
                    continue;
                }
                match frame.header.ty {
                    FrameType::StreamData => {
                        let event: Value = serde_json::from_slice(&frame.body)?;
                        if runner_follow::control_wake(&event) {
                            return Ok(true);
                        }
                    }
                    FrameType::StreamEnd | FrameType::Error => return Ok(false),
                    _ => {}
                }
            }
        };
        if let Ok(connected) = tokio::time::timeout(runner_follow::POLL_INTERVAL, wake).await {
            if !connected? {
                *subscription = None;
            }
        }
        Ok(())
    }

    async fn read_terminal_for(
        &mut self,
        route: OpenedRoute,
        corr: u64,
        timeout: Duration,
    ) -> Result<Frame, HistorianProducerError> {
        match tokio::time::timeout(timeout, async {
            loop {
                let Some(frame) = read_frame(&mut self.stream).await? else {
                    return Err(HistorianProducerError::UnexpectedStreamEnd);
                };
                if frame.header.channel == route.channel
                    && frame.header.epoch == route.epoch
                    && frame.header.corr == corr
                {
                    return Ok(frame);
                }
                if frame.header.ty == FrameType::StreamData
                    && self.subscribe_route.is_some_and(|subscription| {
                        subscription.channel == frame.header.channel
                            && subscription.epoch == frame.header.epoch
                    })
                {
                    let event: Value = serde_json::from_slice(&frame.body)?;
                    self.control_pending |= runner_follow::control_wake(&event);
                }
            }
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    async fn write_frame(
        &mut self,
        ty: FrameType,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: Vec<u8>,
    ) -> Result<(), HistorianProducerError> {
        let frame = Frame::build(
            ty,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            body,
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    async fn send_goodbye(&mut self, route: OpenedRoute) -> Result<(), HistorianProducerError> {
        let frame = Frame::build(
            FrameType::Goodbye,
            Flags::new(false, Priority::Interactive, false),
            route.channel,
            route.epoch,
            0,
            Vec::new(),
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    fn next_corr(&mut self) -> u64 {
        let corr = self.next_corr;
        self.next_corr = self.next_corr.saturating_add(1).max(1);
        corr
    }
}

/// What a `session.release` reply frame says. An error frame is the runner's
/// refusal, carried with its whole body as detail.
fn release_outcome(ty: FrameType, body: &[u8]) -> ReleaseOutcome {
    match ty {
        FrameType::Response => match serde_json::from_slice::<Value>(body) {
            Ok(reply) => match crate::session_resolver::read_runner_reply(reply) {
                Ok(answer) => ReleaseOutcome::from_answer(&answer),
                Err(shape) => ReleaseOutcome::Unanswered(shape.to_string()),
            },
            Err(error) => ReleaseOutcome::Unanswered(error.to_string()),
        },
        FrameType::Error => match serde_json::from_slice::<Value>(body) {
            Ok(detail) => ReleaseOutcome::Refused {
                code: detail
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                detail,
            },
            Err(error) => ReleaseOutcome::Unanswered(error.to_string()),
        },
        other => ReleaseOutcome::Unanswered(format!("unexpected {other:?} frame")),
    }
}

/// The retention member a send carries, from the groups `role.describe` declares
/// (see `child_retention`). With only the older `retention` group, return seconds
/// only when its limits are positive: older runners may not support the field, so
/// omitting it when unusable keeps their `session.send` requests valid. `answer`
/// is the answer inside the runner's reply envelope (see `unary_json`).
fn retention_from_role_describe(answer: &Value) -> ChildRetention {
    match child_retention::member_of_describe(answer) {
        child_retention::RetentionMember::Policy => return ChildRetention::Policy,
        child_retention::RetentionMember::Nothing => return ChildRetention::Nothing,
        child_retention::RetentionMember::Seconds => {}
    }
    let Some(max_seconds) = answer
        .get("retention")
        .and_then(|retention| retention.get("max_seconds"))
        .and_then(Value::as_u64)
        .filter(|max_seconds| *max_seconds > 0)
    else {
        return ChildRetention::Nothing;
    };
    let delete_within_ms = answer
        .get("retention")
        .and_then(|retention| retention.get("delete_within_ms"))
        .and_then(Value::as_u64);
    if delete_within_ms.is_none_or(|ms| ms == 0) {
        return ChildRetention::Nothing;
    }
    ChildRetention::Seconds(HISTORIAN_SESSION_RETENTION_SECONDS.min(max_seconds))
}

/// The retention a send into this session carries. The first send's member is
/// frozen: later sends repeat it while the runner still declares it (seconds
/// shrinking to a lowered maximum), and otherwise carry none.
fn select_session_retention(
    frozen: &mut Option<ChildRetention>,
    declared: ChildRetention,
) -> ChildRetention {
    match (*frozen.get_or_insert(declared), declared) {
        (ChildRetention::Policy, ChildRetention::Policy) => ChildRetention::Policy,
        (ChildRetention::Seconds(original), ChildRetention::Seconds(maximum)) => {
            let selected = ChildRetention::Seconds(original.min(maximum));
            *frozen = Some(selected);
            selected
        }
        _ => ChildRetention::Nothing,
    }
}

impl Drop for HistorianProducer {
    fn drop(&mut self) {
        // Async close is preferred by callers; drop only releases the TCP socket.
    }
}

/// What a `session.send` reply actually said.
#[derive(Debug, PartialEq, Eq)]
enum SendOutcome {
    /// The session was idle and this run started.
    Active(String),
    /// The session was busy; the prompt is durably queued under this submission id.
    Queued(String),
    /// Neither shape — the reply carries no run and names no submission.
    Unrecognized,
}

/// Decode a `session.send` answer (the answer inside the reply envelope, which
/// `unary_json` has already removed).
///
/// The runner answers with a `state`-tagged result. Any answer carrying a `run_id`
/// names the run that started (`active`); `pending` with a `submission_id` means
/// the session already had an active run and this prompt was durably QUEUED
/// behind it under that submission id. Reading only `run_id`
/// collapses those two into "no run id", which reports a queued (accepted) prompt as a
/// malformed reply and hides the one fact that explains it — the session was busy.
fn send_outcome(body: &Value) -> SendOutcome {
    if let Some(run_id) = body.get("run_id").and_then(Value::as_str) {
        return SendOutcome::Active(run_id.to_string());
    }
    let pending = body
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("pending"));
    match body.get("submission_id").and_then(Value::as_str) {
        Some(submission_id) if pending => SendOutcome::Queued(submission_id.to_string()),
        _ => SendOutcome::Unrecognized,
    }
}

/// Classify a `run.status` answer (the answer inside the reply envelope).
fn classify_run_state(_run_id: &str, value: &Value) -> RunState {
    match serde_json::from_value::<RoleRunStatus>(value.clone()) {
        Ok(status) if status.run_state().is_terminal() => RunState::Terminal,
        Ok(_) => RunState::Active,
        Err(error) => RunState::Missing {
            detail: Some(error.to_string()),
        },
    }
}

fn output_from_run_result(
    result: RoleRunResult,
    reports_usage: bool,
) -> Result<ProducerOutput, HistorianProducerError> {
    let usage = reports_usage
        .then_some(result.usage.as_ref())
        .flatten()
        .and_then(ProducerUsage::from_contract_usage);
    match result.run_state() {
        RoleRunState::Completed => {
            let final_message = result.final_message.ok_or_else(|| {
                HistorianProducerError::Subc(ProducerErrorBody::untagged(
                    "run_result_malformed",
                    "completed run.result is missing final_message",
                ))
            })?;
            Ok(ProducerOutput {
                text: final_message.text,
                length_capped: false,
                usage,
            })
        }
        RoleRunState::ContextCeiling => Err(HistorianProducerError::context_overflow(
            "run ended context_ceiling",
        )),
        _ => {
            let error = result.error.map(|error| {
                ProducerErrorBody::from_value(
                    serde_json::to_value(error).expect("run error serializes"),
                )
            });
            Err(HistorianProducerError::RunFailed {
                run_id: result.run_id,
                detail: error.as_ref().map_or_else(
                    || format!("run ended {}", result.state),
                    |error| format!("run ended {}: {}", result.state, error.message),
                ),
                classification: error.as_ref().and_then(ProducerErrorBody::classification),
                class_field_present: error
                    .as_ref()
                    .is_some_and(|error| error.class_field_present),
            })
        }
    }
}

#[cfg(test)]
fn control_unit(event: &Value) -> Option<&Value> {
    let kind = event.get("kind").and_then(Value::as_str);
    if kind == Some("display") {
        return None;
    }
    if kind == Some("control") {
        let unit = event.get("unit").unwrap_or(event);
        return Some(unit);
    }
    Some(event.get("unit").unwrap_or(event))
}

#[cfg(test)]
fn unit_type(unit: &Value) -> Option<&str> {
    unit.get("type")
        .or_else(|| unit.get("kind"))
        .and_then(Value::as_str)
}

/// Extract assistant text from the fake Broca script. Its assistant_message
/// unit nests an assembled message with a content-block array; only `text` blocks are
/// the historian's output. `reasoning` blocks are deliberately EXCLUDED: a reasoning
/// model's thinking legitimately restates the prompt's format template and walks the
/// seed examples, so folding it into the output would corrupt the parse with
/// template/seed prose. Flat `text`/`content` fields are kept as a fallback for
/// simpler unit shapes.
#[cfg(test)]
fn unit_text(unit: &Value) -> Option<String> {
    if !unit_type(unit).is_some_and(|ty| ty.eq_ignore_ascii_case("assistant_message")) {
        return None;
    }
    if let Some(blocks) = unit
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    {
        let text: String = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect();
        return (!text.is_empty()).then_some(text);
    }
    unit.get("text")
        .or_else(|| unit.get("content"))
        .or_else(|| unit.get("message").and_then(|m| m.get("text")))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
fn is_terminal_unit(unit: &Value) -> bool {
    let Some(ty) = unit_type(unit).map(str::to_ascii_lowercase) else {
        return false;
    };
    ty == "run_finished"
        || ty == "terminal"
        || ty == "run_terminal"
        || ty == "finished"
        || ty == "error"
}

#[cfg(test)]
fn is_step_finished_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "step_finished" || ty == "stepfinished")
}

#[cfg(test)]
fn is_paused_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "paused")
}

#[cfg(test)]
fn is_error_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "error" || ty == "run_error")
}

#[derive(Debug, Default)]
#[cfg(test)]
struct UnitErrorInfo {
    detail: Option<String>,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

#[cfg(test)]
fn unit_error_info(unit: &Value) -> UnitErrorInfo {
    if let Some(error) = unit.get("error") {
        let (classification, class_field_present) = classification_from_object(error);
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| unit.get("detail").and_then(Value::as_str))
            .or_else(|| unit.get("message").and_then(Value::as_str))
            .map(ToString::to_string)
            .or_else(|| error.as_str().map(ToString::to_string))
            .or_else(|| Some(error.to_string()));
        // Keep reset siblings that would otherwise disappear when only message is retained.
        let detail = if provider_retry_at_ms(error, 0, 0).is_some() {
            Some(error.to_string())
        } else {
            detail
        };
        return UnitErrorInfo {
            detail,
            classification,
            class_field_present,
        };
    }

    let detail = unit
        .get("detail")
        .or_else(|| unit.get("message"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let (classification, class_field_present) = detail
        .as_deref()
        .and_then(classification_from_json_text)
        .unwrap_or((None, false));
    UnitErrorInfo {
        detail,
        classification,
        class_field_present,
    }
}

fn consumer_identity_from_launch() -> Option<ConsumerIdentity> {
    let module_id = std::env::var(SUBC_MODULE_ID_ENV).ok()?;
    // Share the SDK's cached HELLO read: the first read consumes and closes the pipe.
    let launch_nonce = subc_client_rs::launch_nonce().ok()??.value().to_owned();
    (!module_id.is_empty() && !launch_nonce.is_empty()).then_some(ConsumerIdentity {
        module_id,
        launch_nonce,
    })
}

fn error_body(body: &[u8]) -> ProducerErrorBody {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => ProducerErrorBody::from_value(value),
        Err(e) => ProducerErrorBody::untagged("invalid_error_body", e.to_string()),
    }
}

fn retry_delay_seconds(text: &str) -> Option<f64> {
    if let Ok(seconds) = text.parse::<f64>() {
        return Some(seconds);
    }
    let mut total = 0.0;
    let mut start = 0;
    for (index, unit) in text.char_indices() {
        if unit.is_ascii_digit() || unit == '.' {
            continue;
        }
        let scale = match unit {
            'h' => 3600.0,
            'm' => 60.0,
            's' => 1.0,
            _ => return None,
        };
        total += text[start..index].parse::<f64>().ok()? * scale;
        start = index + unit.len_utf8();
    }
    (start == text.len() && start > 0).then_some(total)
}

/// Walk only structured retry fields, including JSON carried inside provider messages.
/// Absolute resets take precedence over relative delays in the same object.
fn provider_retry_at_ms(value: &Value, now_ms: i64, depth: usize) -> Option<i64> {
    if depth > 12 {
        return None;
    }
    match value {
        Value::Object(fields) => {
            let absolute = ["quotaResetTimeStamp", "quotaResetTimestamp", "retry_at"]
                .into_iter()
                .filter_map(|key| fields.get(key).and_then(Value::as_str))
                .filter_map(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                .map(|time| time.timestamp_millis())
                .min();
            if absolute.is_some() {
                return absolute;
            }
            let relative = ["quotaResetDelay", "retryDelay", "retry_after"]
                .into_iter()
                .filter_map(|key| fields.get(key))
                .filter_map(|value| {
                    let seconds = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(retry_delay_seconds))?;
                    (seconds.is_finite() && seconds >= 0.0)
                        .then_some(now_ms.saturating_add((seconds * 1000.0).ceil() as i64))
                })
                .min();
            relative.or_else(|| {
                fields
                    .values()
                    .filter_map(|child| provider_retry_at_ms(child, now_ms, depth + 1))
                    .min()
            })
        }
        Value::Array(values) => values
            .iter()
            .filter_map(|child| provider_retry_at_ms(child, now_ms, depth + 1))
            .min(),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .or_else(|| {
                let start = text.find('{')?;
                let end = text.rfind('}')?;
                if end < start {
                    return None;
                }
                serde_json::from_str::<Value>(&text[start..=end]).ok()
            })
            .and_then(|nested| provider_retry_at_ms(&nested, now_ms, depth + 1)),
        _ => None,
    }
}

#[cfg(test)]
fn classification_from_json_text(s: &str) -> Option<(Option<ErrorClassification>, bool)> {
    serde_json::from_str::<Value>(s)
        .ok()
        .map(|value| classification_from_object(&value))
}

fn classification_from_object(value: &Value) -> (Option<ErrorClassification>, bool) {
    let Some(class_value) = value.get("class") else {
        return (None, false);
    };
    let Some(class) = class_value.as_str().and_then(ErrorClass::from_wire) else {
        return (None, true);
    };
    (
        Some(ErrorClassification {
            class,
            retry_after_secs: value
                .get("retry_after_secs")
                .and_then(retry_after_secs_from_value),
        }),
        true,
    )
}

fn retry_after_secs_from_value(value: &Value) -> Option<u64> {
    if let Some(secs) = value.as_u64() {
        return Some(secs);
    }
    let secs = value.as_f64()?;
    if secs.is_finite() && secs >= 0.0 {
        Some(secs.ceil() as u64)
    } else {
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::{BTreeMap, VecDeque},
        net::SocketAddr,
        sync::Arc,
    };

    use serde_json::json;
    use subc_transport::{
        authenticate_server, generate_daemon_id, generate_key, write_atomic, ConnectionInfo,
        Endpoint, SCHEMA_VERSION,
    };
    use tempfile::TempDir;
    use tokio::{net::TcpListener, sync::Mutex};

    #[cfg(unix)]
    #[test]
    fn pipe_only_launch_identity_reuses_sdk_nonce() {
        const CHILD: &str = "MC_TEST_PIPE_IDENTITY_CHILD";
        const NONCE: &str = "pipe-only-mc-launch-nonce";
        const TEST: &str = "historian_producer::tests::pipe_only_launch_identity_reuses_sdk_nonce";
        if std::env::var_os(CHILD).is_some() {
            assert!(std::env::var_os(subc_protocol::SUBC_LAUNCH_NONCE_ENV).is_none());
            // HELLO uses this same accessor before the historian opens a route.
            let hello_nonce = subc_client_rs::launch_nonce().unwrap().unwrap();
            assert_eq!(hello_nonce.value(), NONCE);
            assert_eq!(hello_nonce.source().as_str(), "fd");
            let provenance = crate::manifest("magic-context").provenance.unwrap();
            assert_eq!(
                serde_json::to_value(provenance).unwrap()["launch_nonce_source"],
                "fd"
            );
            for _ in 0..2 {
                let identity = consumer_identity_from_launch().expect("pipe-only route identity");
                assert_eq!(identity.module_id, "magic-context");
                assert_eq!(identity.launch_nonce, NONCE);
            }
            return;
        }

        // A fresh process isolates the process-wide nonce cache from other tests.
        let handoff = subc_os::LaunchNonceHandoff::new(NONCE).unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env(SUBC_MODULE_ID_ENV, "magic-context")
            .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
            .env(subc_os::LAUNCH_NONCE_FD_ENV, handoff.fd_env_value());
        handoff.install_last(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "pipe-only child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    #[test]
    fn producer_token_log_distinguishes_missing_usage_from_zero_and_reports_cap() {
        assert_eq!(
            producer_token_log(None, None, false),
            json!({"input":null,"output":null,"reasoning":null,"cache_read":null,"cache_write":null,"max_tokens":null,"finish_reason":null})
        );
        let usage = ProducerUsage::from_runner_usage(&json!({"input_tokens":4,"output_tokens":32,"cached_input_tokens":0,"cache_write_tokens":2})).unwrap();
        assert_eq!(
            producer_token_log(Some(usage), Some(32), true),
            json!({"input":4,"output":32,"reasoning":null,"cache_read":0,"cache_write":2,"max_tokens":32,"finish_reason":"length"})
        );
    }

    #[test]
    fn provider_reset_metadata_survives_open_and_terminal_errors() {
        let reset = chrono::DateTime::parse_from_rfc3339("2026-09-11T20:34:51Z")
            .unwrap()
            .timestamp_millis();
        let value = json!({"code":"429", "message":"quota exhausted", "class":"transient", "metadata":{"quotaResetTimeStamp":"2026-09-11T20:34:51Z", "quotaResetDelay":"1h36m"}});
        let error = HistorianProducerError::Subc(ProducerErrorBody::from_value(value.clone()));
        assert_eq!(error.provider_retry_at_ms(1000), Some(reset));
        let info = unit_error_info(&json!({"error":value}));
        let error = HistorianProducerError::RunFailed {
            run_id: "r".into(),
            detail: info.detail.unwrap(),
            classification: info.classification,
            class_field_present: info.class_field_present,
        };
        assert_eq!(error.provider_retry_at_ms(1000), Some(reset));
        let delay =
            HistorianProducerError::retryable_model_failure(r#"{"quotaResetDelay":"1h36m0.5s"}"#);
        assert_eq!(delay.provider_retry_at_ms(1000), Some(5_761_500));
        let invalid = HistorianProducerError::retryable_model_failure(
            r#"{"quotaResetTimeStamp":"invalid","quotaResetDelay":"-1s"}"#,
        );
        assert_eq!(invalid.provider_retry_at_ms(1000), None);
        let quota =
            HistorianProducerError::Subc(ProducerErrorBody::untagged("429", "QUOTA_EXHAUSTED"));
        assert!(quota.is_retryable_model_failure());
    }

    #[test]
    fn runner_refusal_literals_map_to_the_reporting_stage() {
        assert_eq!(RUNNER_REFUSAL_OPEN_CODES, ["open_failed"]);
        assert_eq!(
            RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS,
            [
                "run resolution failed",
                "no apikey credential for provider",
                "unknown provider",
                "unknown model",
            ]
        );

        let cases = [
            (
                "open failed: run resolution failed: no apikey credential for provider 'google'",
                RunnerRefusalStage::Credential,
            ),
            (
                "open failed: run resolution failed: unknown provider 'missing'",
                RunnerRefusalStage::Provider,
            ),
            (
                "open failed: run resolution failed: unknown model 'missing'",
                RunnerRefusalStage::Model,
            ),
            (
                "open failed: run resolution failed: malformed runner selection",
                RunnerRefusalStage::Resolution,
            ),
        ];
        for (message, expected_stage) in cases {
            let error =
                HistorianProducerError::Subc(ProducerErrorBody::untagged("open_failed", message));
            let refusal = error.runner_refusal().expect("runner refusal");
            assert_eq!(refusal.stage, expected_stage);
            assert_eq!(refusal.received_code, "open_failed");
            assert_eq!(refusal.received_message, message);
        }

        let unmatched = HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "open_failed",
            "open failed: route closed before bind completed",
        ));
        assert_eq!(
            unmatched
                .runner_refusal()
                .expect("unmatched open refusal")
                .stage,
            RunnerRefusalStage::Resolution
        );
        let wrong_outer_code = HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "route_rejected",
            "run resolution failed: unknown provider 'opencode'",
        ));
        assert!(wrong_outer_code.runner_refusal().is_none());
    }

    #[test]
    fn open_failed_detail_class_overrides_message_and_unknown_classes_never_fall_back() {
        for (class, message, durable, retryable) in [
            ("permanent", "runner selection rejected", true, false),
            (
                "transient",
                "run resolution failed: unknown model 'x'",
                false,
                true,
            ),
            (
                "permanent",
                "rate limit; no apikey credential for provider 'x'",
                true,
                false,
            ),
            (
                "future_class",
                "rate limit; unknown provider 'x'",
                false,
                false,
            ),
        ] {
            let parsed = error_body(
                &serde_json::to_vec(&json!({
                    "code": "open_failed",
                    "message": message,
                    "detail": {"class": class, "retry_after_secs": 120}
                }))
                .unwrap(),
            );
            let error = HistorianProducerError::Subc(parsed);
            assert!(error.has_class_field());
            assert_eq!(error.is_retryable_model_failure(), retryable, "{class}");
            assert_eq!(
                error.runner_refusal().unwrap().is_durable(),
                durable,
                "{class}"
            );
            assert_eq!(
                error.classification(),
                ErrorClass::from_wire(class).map(|class| ErrorClassification {
                    class,
                    retry_after_secs: Some(120),
                })
            );
        }
        for detail in [Value::Null, json!({"cause": "catalog"})] {
            let error = HistorianProducerError::Subc(error_body(
                &serde_json::to_vec(&json!({
                    "code": "open_failed",
                    "message": "run resolution failed: unknown model 'x'",
                    "detail": detail
                }))
                .unwrap(),
            ));
            assert!(!error.has_class_field());
            assert!(
                error.runner_refusal().unwrap().is_durable(),
                "legacy stage fallback"
            );
        }
    }

    #[test]
    fn error_class_wire_strings_match_pinned_contract_set() {
        assert_eq!(
            ERROR_CLASS_WIRE_SET,
            [
                "transient",
                "permanent",
                "auth_required",
                "context_overflow"
            ]
        );
        assert_eq!(ErrorClass::Transient.as_wire_str(), "transient");
        assert_eq!(ErrorClass::Permanent.as_wire_str(), "permanent");
        assert_eq!(ErrorClass::AuthRequired.as_wire_str(), "auth_required");
        assert_eq!(
            ErrorClass::ContextOverflow.as_wire_str(),
            "context_overflow"
        );
        assert_eq!(
            ErrorClass::from_wire("auth"),
            Some(ErrorClass::AuthRequired)
        );
    }

    #[test]
    fn parses_tagged_subc_error_body_from_contract_shape() {
        let body = serde_json::to_vec(&json!({
            "code": "provider_error",
            "message": "rate limit window",
            "class": "transient",
            "retry_after_secs": 120,
            "provider_code": "rate_limit_exceeded"
        }))
        .unwrap();

        let parsed = error_body(&body);
        assert_eq!(parsed.code, "provider_error");
        assert_eq!(
            parsed.classification(),
            Some(ErrorClassification {
                class: ErrorClass::Transient,
                retry_after_secs: Some(120),
            })
        );
    }

    #[test]
    fn parses_current_llm_runner_control_error_shape() {
        let unit = json!({
            "type": "error",
            "error": {
                "class": "permanent",
                "message": "model id does not exist",
                "status": 404,
                "provider_code": "model_not_found"
            }
        });

        let info = unit_error_info(&unit);
        assert_eq!(info.detail.as_deref(), Some("model id does not exist"));
        assert_eq!(
            info.classification,
            Some(ErrorClassification {
                class: ErrorClass::Permanent,
                retry_after_secs: None,
            })
        );
    }

    #[test]
    fn send_outcome_reads_the_runner_send_contract() {
        // `send_outcome` reads the answer inside the reply envelope, which
        // `unary_json` removes strictly; both shapes are tagged by `state`.
        assert_eq!(
            send_outcome(&json!({"state":"active","run_id":"run-9"})),
            SendOutcome::Active("run-9".to_string())
        );
        assert_eq!(
            send_outcome(&json!({"state":"pending","submission_id":"sub-3"})),
            SendOutcome::Queued("sub-3".to_string()),
            "a queued prompt was ACCEPTED behind a busy session, not malformed"
        );
        // A second envelope inside the answer is not peeled: there is exactly one.
        assert_eq!(
            send_outcome(&json!({"result":{"state":"active","run_id":"run-9"}})),
            SendOutcome::Unrecognized
        );
        // A submission id without the pending state is not a queue acknowledgement.
        assert_eq!(
            send_outcome(&json!({"submission_id":"sub-4"})),
            SendOutcome::Unrecognized
        );
        assert_eq!(send_outcome(&json!({})), SendOutcome::Unrecognized);
        assert_eq!(send_outcome(&Value::Null), SendOutcome::Unrecognized);
    }

    #[tokio::test]
    async fn dormant_stage_api_preserves_legacy_send_and_refuses_checks() {
        assert!(!crate::historian_stage::lifecycle_enabled());
        let server = fake_server(json!({"run_id":"run-1"}), vec![]).await;
        let mut producer = client(&server).await;
        producer
            .start_stage_with_generation(
                "legacy-child",
                "different-stage-key",
                "system",
                "prompt",
                "prov/model",
                None,
                100,
                None,
            )
            .await
            .unwrap();
        let check = producer
            .start_check_with_generation(
                "check-key",
                "check-system",
                "input",
                "prov/model",
                None,
                100,
                None,
            )
            .await;
        assert!(
            matches!(check, Err(HistorianProducerError::Subc(ref error)) if error.code == "historian_lane_dormant")
        );
        producer.close().await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 1);
        assert_eq!(log.sends[0]["send_id"], "legacy-child");
        assert_eq!(log.route_sessions, vec!["legacy-child"]);
    }

    #[tokio::test]
    async fn queued_stage_reattaches_after_restart_without_retract_or_new_identity() {
        let _lane = crate::historian_stage::enabled_test_lane();
        let events = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"assistant_message","message":{"content":[{"type":"text","text":"stage reply"}]}}}),
            json!({"kind":"control","unit":{"type":"run_finished"}}),
        ];
        let server = fake_server(
            json!([
                {"state":"pending","submission_id":"queued-1"},
                {"state":"active","run_id":"run-1"}
            ]),
            events,
        )
        .await;
        let key = crate::historian_stage::stage_key("/p", "pub", 7, "turn_two");
        let mut first = client(&server).await;
        let handle = first
            .start_stage_with_generation(
                "retained-child",
                &key,
                "system",
                "prompt",
                "prov/model",
                None,
                32_000,
                None,
            )
            .await
            .unwrap();
        assert!(is_stage_submission(&handle.run_id));
        first.close().await;
        drop(first);
        let mut recovered = client(&server).await;
        assert_eq!(
            recovered.status(&handle.run_id).await.unwrap(),
            RunState::Active
        );
        let output = recovered
            .await_output_with_timeout(&handle.run_id, Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(output.text, "stage reply");
        recovered.close().await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 2);
        assert_eq!(log.sends[0], log.sends[1]);
        assert_eq!(log.sends[0]["send_id"], key);
        assert!(log.sends[0].get("schema").is_none());
        assert!(log.retracts.is_empty());
        assert!(log
            .route_sessions
            .iter()
            .all(|session| session == "retained-child"));
    }

    #[tokio::test]
    async fn checks_bind_distinct_fresh_sessions_and_never_historian_lineage() {
        let _lane = crate::historian_stage::enabled_test_lane();
        let server = fake_server(json!({"run_id":"run-1"}), vec![]).await;
        let mut producer = client(&server).await;
        let keys = [
            "decision:revision=1:support:c1:hash=a:profile=p",
            "decision:revision=1:support:c2:hash=a:profile=p",
        ];
        producer
            .start_stage_with_generation(
                "retained-historian",
                "historian-key",
                "historian-system",
                "past-historian-context",
                "prov/model",
                None,
                100,
                None,
            )
            .await
            .unwrap();
        for key in keys {
            producer
                .start_check_with_generation(
                    key,
                    "check-system",
                    "only-operands-and-window",
                    "prov/model",
                    None,
                    100,
                    None,
                )
                .await
                .unwrap();
        }
        let log = server.log.lock().await;
        assert_eq!(
            log.route_sessions,
            std::iter::once("retained-historian".to_string())
                .chain(keys.map(crate::historian_stage::check_session_id))
                .collect::<Vec<_>>()
        );
        for (send, key) in log.sends.iter().skip(1).zip(keys) {
            assert_eq!(send["send_id"], key);
            assert_eq!(send["system"], "check-system");
            assert_eq!(send["prompt"], "only-operands-and-window");
        }
    }

    #[tokio::test]
    async fn staged_lost_ack_keeps_original_request_for_recovery() {
        let _lane = crate::historian_stage::enabled_test_lane();
        let server =
            fake_server_with_lost_send_reply(json!({"run_id":"run-1"}), vec![], true).await;
        let key = crate::historian_stage::stage_key("/p", "pub", 3, "turn_one");
        let mut producer = client(&server).await;
        let handle = producer
            .start_stage_with_generation("child", &key, "s", "p", "prov/model", None, 100, None)
            .await
            .unwrap();
        let record = stage_submission(&handle.run_id).unwrap().unwrap();
        assert_eq!(record["request"]["params"]["send_id"], key);
        producer.close().await;
        drop(producer);
        let mut recovered = client(&server).await;
        assert_eq!(
            recovered.reattach_submission(&record).await.unwrap(),
            "run-1"
        );
        recovered.close().await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 2);
        assert_eq!(log.sends[0], log.sends[1]);
    }

    #[derive(Debug, Default)]
    struct ServerLog {
        route_project_roots: Vec<String>,
        route_harnesses: Vec<String>,
        route_sessions: Vec<String>,
        route_targets: Vec<subc_protocol::RouteTarget>,
        route_role_versions: Vec<Option<BTreeMap<String, String>>>,
        role_describes: Vec<Value>,
        sends: Vec<Value>,
        subscribes: Vec<Value>,
        retracts: Vec<Value>,
        goodbyes: Vec<u16>,
        statuses: Vec<Value>,
        results: Vec<Value>,
        /// Each `session.release`: the session its route is bound to, and params.
        releases: Vec<(String, Value)>,
        /// The method of every llm-runner request, in arrival order.
        methods: Vec<String>,
    }

    /// How the fake runner answers one `session.release`.
    #[derive(Clone)]
    enum ReleaseScript {
        /// Answer with this release reply.
        Answer(Value),
        /// Refuse with this error body.
        Refuse(Value),
        /// Never answer.
        Silent,
    }

    #[derive(Default)]
    struct FakeAnswers {
        statuses: VecDeque<Value>,
        result: Option<Value>,
        describe: Option<Value>,
        /// Answers to `session.release`, in order; once they run out the runner
        /// answers `deleted`.
        releases: VecDeque<ReleaseScript>,
        /// Answer every llm-runner op bare instead of inside `{"result": ...}`,
        /// as a runner off the pinned reply shape would.
        bare: bool,
    }

    fn result_for_script(events: &[Value]) -> Value {
        use cortexkit_role_llm_runner::{
            run::FinalMessage,
            usage::{RunUsage, StepUsage},
        };
        let step_usage = |measured: &Value| {
            let field = |name| measured.get(name).and_then(Value::as_u64);
            let mut step = StepUsage::unreported();
            if let Some(tokens) = field("input_tokens") {
                step = step.with_input_tokens(tokens);
            }
            if let Some(tokens) = field("output_tokens") {
                step = step.with_output_tokens(tokens);
            }
            if let Some(tokens) = field("cached_input_tokens") {
                step = step.with_cached_input_tokens(tokens);
            }
            if let Some(tokens) = field("cache_write_tokens") {
                step = step.with_cache_write_tokens(tokens);
            }
            step
        };
        let mut text = String::new();
        let mut state = "completed";
        let mut usage = RunUsage::new();
        let mut terminal_usage = None;
        let mut failure = None;
        for event in events {
            let Some(unit) = control_unit(event) else {
                continue;
            };
            if let Some(piece) = unit_text(unit) {
                text.push_str(&piece);
            }
            if is_step_finished_unit(unit) {
                if let Some(measured) = unit.get("usage") {
                    let step = step_usage(measured);
                    usage.record_step("provider", "model", None, step);
                }
            }
            if is_terminal_unit(unit) {
                terminal_usage = unit.get("usage").cloned();
            }
            if is_error_unit(unit) {
                state = "error";
                failure = Some(unit_error_info(unit));
            }
            if is_paused_unit(unit) {
                state = "paused";
            }
        }
        if usage.steps == 0 {
            if let Some(measured) = terminal_usage {
                usage.record_step("provider", "model", None, step_usage(&measured));
            }
        }
        let mut result = RoleRunResult::new("run-1", state);
        if state == "completed" {
            result = result.with_final_message(FinalMessage {
                ordinal: 1,
                mid: "answer".into(),
                text,
            });
        }
        if usage.steps > 0 {
            result = result.with_usage(usage);
        }
        let mut result = serde_json::to_value(result).unwrap();
        if let Some(failure) = failure {
            result["error"] = json!({"class":failure.classification.map_or("permanent", |c| c.class.as_wire_str()),"message":failure.detail.unwrap_or_else(|| "run failed".into()),"provider_code":"provider_error"});
        }
        result
    }

    pub(crate) struct FakeServer {
        connection_file: PathBuf,
        log: Arc<Mutex<ServerLog>>,
        answers: Arc<Mutex<FakeAnswers>>,
        _temp: TempDir,
    }

    impl FakeServer {
        pub(crate) async fn follow_counts(&self) -> (usize, usize) {
            let log = self.log.lock().await;
            (log.statuses.len(), log.results.len())
        }

        /// The method of every llm-runner request, in arrival order.
        pub(crate) async fn methods(&self) -> Vec<String> {
            self.log.lock().await.methods.clone()
        }

        /// The session each `session.release` was bound to, in order.
        pub(crate) async fn released_sessions(&self) -> Vec<String> {
            let log = self.log.lock().await;
            log.releases
                .iter()
                .map(|(session, _)| session.clone())
                .collect()
        }
    }

    pub(crate) async fn publication_follower(
        output: &str,
        open_controls: bool,
    ) -> (HistorianProducer, FakeServer) {
        publication_follower_described(
            output,
            open_controls,
            json!({"capabilities":["no_tools","max_steps"]}),
        )
        .await
    }

    /// [`publication_follower`] against a runner whose `role.describe` answer is
    /// `describe` plus the run capabilities every fake runner adds.
    pub(crate) async fn publication_follower_described(
        output: &str,
        open_controls: bool,
        describe: Value,
    ) -> (HistorianProducer, FakeServer) {
        let events = if open_controls {
            vec![
                json!({"kind":"control","event":{"vendor":"thalamus","opaque":true}}),
                json!({"kind":"control","event":{"state":"not a role state","text":"not an answer"}}),
            ]
        } else {
            vec![
                json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
                json!({"kind":"control","unit":{"type":"assistant_message","run_id":"run-1","text":output}}),
                json!({"kind":"control","unit":{"type":"run_finished","run_id":"run-1"}}),
            ]
        };
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            events,
            describe,
            false,
        )
        .await;
        {
            let mut answers = server.answers.lock().await;
            answers.statuses = [json!({"state":"active"}), json!({"state":"completed"})].into();
            answers.result = Some(
                json!({"run_id":"run-1","state":"completed","final_message":{"ordinal":1,"mid":"answer","text":output}}),
            );
        }
        let producer = session_runner_client(&server).await;
        (producer, server)
    }

    async fn fake_server(send_response: Value, stream_events: Vec<Value>) -> FakeServer {
        fake_server_with_lost_send_reply(send_response, stream_events, false).await
    }

    async fn fake_server_with_lost_send_reply(
        send_response: Value,
        stream_events: Vec<Value>,
        lose_first_reply: bool,
    ) -> FakeServer {
        fake_server_with_role_describe(
            send_response,
            stream_events,
            json!({"capabilities": ["no_tools","max_steps","max_output_tokens"], "retention": {"max_seconds": 2_592_000, "delete_within_ms": 3_600_000}}),
            lose_first_reply,
        )
        .await
    }

    async fn fake_server_with_role_describe(
        send_response: Value,
        stream_events: Vec<Value>,
        mut role_describe_response: Value,
        mut lose_first_reply: bool,
    ) -> FakeServer {
        // Each fixture independently chooses its run-limit declarations; all of
        // these fake runners all answer run.status and run.result calls.
        role_describe_response["capabilities"]
            .as_array_mut()
            .unwrap()
            .extend(["run_ops", "run_status", "streaming", "run_usage"].map(|group| json!(group)));
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let key = generate_key().unwrap();
        let daemon_id = generate_daemon_id().unwrap();
        let connection_file = temp.path().join("subc-connection.json");
        write_atomic(
            &connection_file,
            &ConnectionInfo {
                schema: SCHEMA_VERSION,
                wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                endpoints: vec![Endpoint {
                    host: addr.ip().to_string(),
                    port: addr.port(),
                }],
                key: key.clone(),
                daemon_id,
                pid: std::process::id(),
                daemon_ver: "fake".to_string(),
            },
        )
        .unwrap();
        let log = Arc::new(Mutex::new(ServerLog::default()));
        let log_task = Arc::clone(&log);
        let answers = Arc::new(Mutex::new(FakeAnswers::default()));
        let answers_task = answers.clone();
        let run_result = result_for_script(&stream_events);
        tokio::spawn(async move {
            let mut stream_events: VecDeque<Value> = stream_events.into();
            let mut responses: VecDeque<Value> = send_response
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![send_response])
                .into();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                authenticate_server(
                    &mut stream,
                    &key,
                    &daemon_id,
                    "fake",
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
                let mut next_route = 10u16;
                let mut route_sessions = std::collections::HashMap::<u16, String>::new();
                loop {
                    let Some(frame) = read_frame(&mut stream).await.unwrap() else {
                        break;
                    };
                    match frame.header.ty {
                        FrameType::Goodbye => {
                            log_task.lock().await.goodbyes.push(frame.header.channel);
                        }
                        FrameType::Request if frame.header.channel == 0 => {
                            let req: ClientControlRequest =
                                serde_json::from_slice(&frame.body).unwrap();
                            if let ClientControlRequest::RouteOpen {
                                identity,
                                target,
                                role_versions,
                                ..
                            } = req
                            {
                                let route = next_route;
                                next_route += 1;
                                route_sessions.insert(route, identity.session.clone());
                                let mut log = log_task.lock().await;
                                log.route_project_roots
                                    .push(identity.project_root.to_string_lossy().into());
                                log.route_harnesses.push(identity.harness);
                                log.route_sessions.push(identity.session);
                                log.route_targets.push(target);
                                log.route_role_versions.push(role_versions);
                                drop(log);
                                send_response_frame(
                                    &mut stream,
                                    frame.header.channel,
                                    frame.header.epoch,
                                    frame.header.corr,
                                    serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                        route_channel: route,
                                        route_epoch: 1,
                                    })
                                    .unwrap(),
                                )
                                .await;
                            }
                        }
                        FrameType::Request => {
                            let req: Value = serde_json::from_slice(&frame.body).unwrap();
                            log_task.lock().await.methods.push(
                                req.get("method")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            );
                            match req.get("method").and_then(Value::as_str) {
                                Some("role.describe") => {
                                    log_task.lock().await.role_describes.push(req.clone());
                                    let described = answers_task
                                        .lock()
                                        .await
                                        .describe
                                        .clone()
                                        .unwrap_or_else(|| role_describe_response.clone());
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, described).await,
                                    )
                                    .await;
                                }
                                Some("session.send") => {
                                    log_task.lock().await.sends.push(req["params"].clone());
                                    if lose_first_reply {
                                        lose_first_reply = false;
                                        continue;
                                    }
                                    let response = if responses.len() > 1 {
                                        responses.pop_front().unwrap()
                                    } else {
                                        responses.front().unwrap().clone()
                                    };
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, response).await,
                                    )
                                    .await;
                                }
                                Some("session.subscribe") => {
                                    log_task.lock().await.subscribes.push(req["params"].clone());
                                    while let Some(event) = stream_events.pop_front() {
                                        send_stream_data(
                                            &mut stream,
                                            frame.header.channel,
                                            frame.header.epoch,
                                            frame.header.corr,
                                            event,
                                        )
                                        .await;
                                    }
                                    send_stream_end(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                    )
                                    .await;
                                }
                                Some("run.status") => {
                                    log_task.lock().await.statuses.push(req["params"].clone());
                                    let mut answers = answers_task.lock().await;
                                    let status =
                                        if answers.statuses.len() > 1 {
                                            answers.statuses.pop_front().unwrap()
                                        } else {
                                            answers.statuses.front().cloned().unwrap_or_else(
                                                || json!({"state":run_result["state"]}),
                                            )
                                        };
                                    drop(answers);
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, status).await,
                                    )
                                    .await;
                                }
                                Some("run.result") => {
                                    log_task.lock().await.results.push(req["params"].clone());
                                    let mut result = run_result.clone();
                                    result["run_id"] = req["params"]["run_id"].clone();
                                    let result =
                                        answers_task.lock().await.result.clone().unwrap_or(result);
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, result).await,
                                    )
                                    .await;
                                }
                                Some("run.cancel") => {
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, json!({"ack":true})).await,
                                    )
                                    .await;
                                }
                                Some("session.release") => {
                                    let session = route_sessions
                                        .get(&frame.header.channel)
                                        .cloned()
                                        .unwrap_or_default();
                                    log_task
                                        .lock()
                                        .await
                                        .releases
                                        .push((session, req["params"].clone()));
                                    let script =
                                        answers_task.lock().await.releases.pop_front().unwrap_or(
                                            ReleaseScript::Answer(json!({"state": "deleted"})),
                                        );
                                    match script {
                                        ReleaseScript::Answer(reply) => {
                                            send_response_frame(
                                                &mut stream,
                                                frame.header.channel,
                                                frame.header.epoch,
                                                frame.header.corr,
                                                runner_reply(&answers_task, reply).await,
                                            )
                                            .await;
                                        }
                                        ReleaseScript::Refuse(body) => {
                                            let frame = Frame::build(
                                                FrameType::Error,
                                                Flags::new(false, Priority::Interactive, false),
                                                frame.header.channel,
                                                frame.header.epoch,
                                                frame.header.corr,
                                                serde_json::to_vec(&body).unwrap(),
                                            )
                                            .unwrap();
                                            write_frame(&mut stream, &frame).await.unwrap();
                                        }
                                        ReleaseScript::Silent => {}
                                    }
                                }
                                Some("session.retract") => {
                                    log_task.lock().await.retracts.push(req["params"].clone());
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        runner_reply(&answers_task, json!({"state":"retracted"}))
                                            .await,
                                    )
                                    .await;
                                }
                                other => panic!(
                                    "unexpected request {other:?} on route {:?}",
                                    route_sessions.get(&frame.header.channel)
                                ),
                            }
                        }
                        _ => {}
                    }
                }
            }
        });
        FakeServer {
            connection_file,
            log,
            answers,
            _temp: temp,
        }
    }

    /// The fake runner's reply body for `answer`: `{"result": answer}`, the
    /// pinned llm-runner reply shape, unless the test asked for bare replies.
    async fn runner_reply(answers: &Mutex<FakeAnswers>, answer: Value) -> Vec<u8> {
        let reply = if answers.lock().await.bare {
            answer
        } else {
            json!({ "result": answer })
        };
        serde_json::to_vec(&reply).unwrap()
    }

    async fn send_response_frame(
        stream: &mut TcpStream,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: Vec<u8>,
    ) {
        let frame = Frame::build(
            FrameType::Response,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            body,
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn send_stream_data(
        stream: &mut TcpStream,
        channel: u16,
        epoch: u32,
        corr: u64,
        event: Value,
    ) {
        let frame = Frame::build(
            FrameType::StreamData,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            serde_json::to_vec(&event).unwrap(),
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn send_stream_end(stream: &mut TcpStream, channel: u16, epoch: u32, corr: u64) {
        let frame = Frame::build(
            FrameType::StreamEnd,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            Vec::new(),
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn client(server: &FakeServer) -> HistorianProducer {
        HistorianProducer::connect(HistorianProducerConfig {
            connection_file: server.connection_file.clone(),
            project_root: std::env::current_dir().unwrap(),
            harness: "mc-test".to_string(),
            route_targets: RouteTargetConfig::runner_module("llm-runner"),
            handshake_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(2),
            await_timeout: Duration::from_secs(2),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn lost_send_reply_retry_reuses_attempt_send_id_after_reconnect() {
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            json!({"capabilities":["retention","no_tools","max_steps","max_output_tokens"],"retention":{"max_seconds":2_592_000,"delete_within_ms":3_600_000}}),
            true,
        )
        .await;
        let mut first = client(&server).await;
        first.config.request_timeout = Duration::from_millis(50);
        let session = "mc-historian:proj:lineage:1";
        let error = first
            .start(session, "role", "prompt", "prov/model-a")
            .await
            .unwrap_err();
        assert!(matches!(error, HistorianProducerError::TimedOut));
        first.close().await;
        drop(first);

        // A retry of the same logical send survives a fresh connection and corr id.
        let mut retry = client(&server).await;
        let handle = retry
            .start(session, "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-1");
        retry.close().await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 2);
        assert_eq!(log.sends[0]["send_id"], json!(session));
        assert_eq!(log.sends[1]["send_id"], json!(session));
        assert_eq!(log.sends[0]["retention"], json!(86_400));
        assert_eq!(log.sends[1]["retention"], json!(86_400));
        assert_eq!(
            log.role_describes.len(),
            2,
            "each new route is queried once"
        );
    }

    #[tokio::test]
    async fn first_send_includes_one_day_retention_when_role_declares_group() {
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            json!({"capabilities":["retention","no_tools","max_steps","max_output_tokens"],"retention":{"max_seconds":2_592_000,"delete_within_ms":3_600_000}}),
            false,
        )
        .await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:1", "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        client.close().await;

        let log = server.log.lock().await;
        assert_eq!(log.role_describes.len(), 1);
        assert_eq!(
            log.role_describes[0],
            json!({"method":"role.describe","params":{}})
        );
        assert_eq!(log.sends[0]["retention"], json!(86_400));
    }

    #[tokio::test]
    async fn first_send_omits_retention_when_role_does_not_declare_group() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:1", "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        client.close().await;

        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 1);
        assert!(log.sends[0].get("retention").is_none());
    }

    /// A describe declaring `session_retention` (with or without `retention`).
    pub(crate) fn session_retention_describe(with_retention: bool) -> Value {
        let mut capabilities = vec![
            "no_tools",
            "max_steps",
            "max_output_tokens",
            "session_retention",
        ];
        if with_retention {
            capabilities.push("retention");
        }
        json!({
            "capabilities": capabilities,
            "retention": {"max_seconds": 2_592_000, "delete_within_ms": 3_600_000},
            "session_retention": {"max_days": 30, "max_unreleased_hold_ms": 60_000, "required": false},
        })
    }

    /// Each describe shape selects at most one retention member (none when the
    /// runner declares neither group), and no send ever carries both.
    #[tokio::test]
    async fn each_describe_shape_picks_exactly_one_retention_member() {
        let keep_nothing =
            json!({"keep":"none","archive_after_days":0,"backup":false,"request_dumps":false});
        let retention = json!({"max_seconds": 2_592_000, "delete_within_ms": 3_600_000});
        for (describe, expected_retention, expected_policy) in [
            (
                session_retention_describe(true),
                None,
                Some(keep_nothing.clone()),
            ),
            (
                session_retention_describe(false),
                None,
                Some(keep_nothing.clone()),
            ),
            (
                json!({"capabilities":["retention","no_tools","max_steps"],"retention":retention}),
                Some(json!(86_400)),
                None,
            ),
            (
                json!({"capabilities":["no_tools","max_steps"],"retention":retention}),
                None,
                None,
            ),
        ] {
            let server = fake_server_with_role_describe(
                json!({"state":"active","run_id":"run-1"}),
                Vec::new(),
                describe.clone(),
                false,
            )
            .await;
            let mut client = client(&server).await;
            client
                .start("mc-historian:proj:shape", "role", "prompt", "prov/model-a")
                .await
                .unwrap();
            client.close().await;
            let log = server.log.lock().await;
            assert_eq!(log.sends.len(), 1);
            let send = &log.sends[0];
            assert_eq!(
                send.get("retention"),
                expected_retention.as_ref(),
                "{describe}"
            );
            assert_eq!(
                send.get("retention_policy"),
                expected_policy.as_ref(),
                "{describe}"
            );
            assert!(send.get("retention").is_none() || send.get("retention_policy").is_none());
        }
    }

    /// The bound child is released with one `session.release {}` on its own
    /// route; a second request for the same child sends nothing, and purging
    /// a released child reports no unsupported deletion.
    #[tokio::test]
    async fn release_child_releases_the_bound_child_exactly_once() {
        let child = "mc-historian:proj:release-once";
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            session_retention_describe(true),
            false,
        )
        .await;
        let mut client = client(&server).await;
        client
            .start(child, "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        assert_eq!(
            client.release_child("historian", "parent").await,
            Some(ReleaseOutcome::Answered(
                cortexkit_role_llm_runner::session_retention::ReleaseState::Deleted
            ))
        );
        assert_eq!(client.release_child("historian", "parent").await, None);
        client.purge_session(child).await.unwrap();
        let log = server.log.lock().await;
        assert_eq!(log.releases, vec![(child.to_string(), json!({}))]);
        let lines = child_retention::release_lines(child);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].contains("of parent released: deleted"),
            "{lines:?}"
        );
    }

    /// A runner without `session_retention` gets no release, and purging still
    /// reports that it cannot delete the session.
    #[tokio::test]
    async fn release_child_sends_nothing_without_session_retention() {
        let child = "mc-historian:proj:no-release";
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start(child, "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        assert_eq!(client.release_child("historian", "parent").await, None);
        assert!(matches!(
            client.purge_session(child).await,
            Err(HistorianProducerError::RunnerSessionDeletionUnsupported { .. })
        ));
        assert!(server.log.lock().await.releases.is_empty());
        assert!(child_retention::release_lines(child).is_empty());
    }

    /// A refusal is logged once with its detail, and a release that never
    /// answers is logged once with its failure reason; neither is retried.
    #[tokio::test]
    async fn a_refused_or_unanswered_release_is_logged_once_and_never_retried() {
        let frozen =
            json!({"keep":{"days":3},"archive_after_days":0,"backup":false,"request_dumps":false});
        for (name, script, expected) in [
            (
                "conflict",
                ReleaseScript::Refuse(
                    json!({"code":"retention_conflict","message":"policy differs","detail":{"frozen":frozen}}),
                ),
                "release refused retention_conflict",
            ),
            (
                "released",
                ReleaseScript::Refuse(json!({"code":"session_released","message":"pending"})),
                "release refused session_released",
            ),
            (
                "owner",
                ReleaseScript::Refuse(
                    json!({"code":"scope_owner_mismatch","message":"not the owner"}),
                ),
                "release refused scope_owner_mismatch",
            ),
            (
                "invalid",
                ReleaseScript::Refuse(
                    json!({"code":"invalid_params","message":"bad","detail":{"field":"retention_policy"}}),
                ),
                "release refused invalid_params",
            ),
            ("silent", ReleaseScript::Silent, "release got no answer"),
        ] {
            let child = format!("mc-historian:proj:release-{name}");
            let server = fake_server_with_role_describe(
                json!({"state":"active","run_id":"run-1"}),
                Vec::new(),
                session_retention_describe(false),
                false,
            )
            .await;
            server.answers.lock().await.releases = [
                script,
                // A retry would be answered; none must be made.
                ReleaseScript::Answer(json!({"state":"deleted"})),
            ]
            .into();
            let mut client = client(&server).await;
            client.config.request_timeout = Duration::from_millis(200);
            client
                .start(&child, "role", "prompt", "prov/model-a")
                .await
                .unwrap();
            let outcome = client.release_child("historian", "parent").await.unwrap();
            assert!(
                !matches!(outcome, ReleaseOutcome::Answered(_)),
                "{name}: {outcome:?}"
            );
            assert_eq!(client.release_child("historian", "parent").await, None);
            assert_eq!(server.log.lock().await.releases.len(), 1, "{name}");
            let lines = child_retention::release_lines(&child);
            assert_eq!(lines.len(), 1, "{lines:?}");
            assert!(lines[0].contains(expected), "{lines:?}");
            if name == "conflict" {
                assert!(lines[0].contains("\"frozen\""), "{lines:?}");
            }
        }
    }

    #[tokio::test]
    async fn first_send_clamps_retention_to_role_maximum() {
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            json!({"capabilities":["retention","no_tools","max_steps","max_output_tokens"],"retention":{"max_seconds":43_200,"delete_within_ms":3_600_000}}),
            false,
        )
        .await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:1", "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        client.close().await;

        assert_eq!(server.log.lock().await.sends[0]["retention"], json!(43_200));
    }

    #[tokio::test]
    async fn new_historian_and_dreamer_attempts_get_distinct_send_ids() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        let sessions = [
            crate::historian::historian_producer_session_id("proj", "lineage", 1),
            crate::historian::historian_producer_session_id("proj", "lineage", 2),
            crate::classify::child_session_id("proj", "command", 1),
            crate::classify::child_session_id("proj", "command", 2),
        ];
        for session in &sessions {
            client
                .start(session, "role", "prompt", "prov/model-a")
                .await
                .unwrap();
            client.close().await;
        }
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), sessions.len());
        let ids = log
            .sends
            .iter()
            .map(|params| params["send_id"].as_str().expect("send_id on every send"))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            ids.len(),
            sessions.len(),
            "even identical prompts need a new id for a new attempt"
        );
    }

    #[tokio::test]
    async fn purge_session_reports_retention_and_closes_both_routes() {
        const CHILD: &str = "MC_TEST_RUNNER_RETENTION_CHILD";
        const TEST: &str =
            "historian_producer::tests::purge_session_reports_retention_and_closes_both_routes";
        if std::env::var_os(CHILD).is_none() {
            // Isolate the process-wide once-only warning from parallel tests.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "retention child failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = Arc::clone(&logs);
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_writer(move || LogWriter(Arc::clone(&writer)))
                .finish(),
        )
        .unwrap();
        let server = fake_server(json!({}), Vec::new()).await;
        let mut client = client(&server).await;
        client.bind_session("mc-dreamer:classify:snapshot");
        client.ensure_command_route().await.unwrap();
        client.ensure_subscribe_route().await.unwrap();
        let error = crate::historian::HistorianProducerDriver::purge_session(
            &mut client,
            "mc-dreamer:classify:snapshot",
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            HistorianProducerError::RunnerSessionDeletionUnsupported { .. }
        ));
        assert!(error
            .to_string()
            .contains("stays in Broca's store indefinitely"));
        assert!(client.command_route.is_none());
        assert!(client.subscribe_route.is_none());
        client.purge_session("another-snapshot").await.unwrap_err();
        // Goodbye frames reach the fake server asynchronously; a loaded runner can
        // take longer than a fixed sleep, so wait for both with a deadline.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while server.log.lock().await.goodbyes.len() < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let log = server.log.lock().await;
        assert_eq!(log.route_sessions, vec!["mc-dreamer:classify:snapshot"; 2]);
        assert_eq!(log.goodbyes, vec![11, 10]);
        assert!(log.sends.is_empty());
        let logs = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        assert_eq!(logs.matches("runner cannot delete sessions").count(), 1);
        assert!(logs.contains("memory-pool snapshots"));
        assert!(logs.contains("never deletes a session"));
    }

    #[tokio::test]
    async fn start_binds_session_at_route_open_and_omits_session_param() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        let handle = client
            .start(
                "mc-historian:proj:1",
                "role guidance",
                "prompt",
                "prov/model-a",
            )
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-1");
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let log = server.log.lock().await;
        assert_eq!(log.route_sessions, vec!["mc-historian:proj:1"]);
        assert_eq!(log.sends.len(), 1);
        assert!(
            log.sends[0].get("session").is_none(),
            "session id lives in BindIdentity, not params"
        );
        assert_eq!(
            log.sends[0]["model"],
            json!({ "provider": "prov", "model": "model-a" }),
            "model is llm-runner's nested ModelParams object, split at the FIRST slash"
        );
        assert_eq!(log.sends[0]["tools"], json!([]));
        assert_eq!(
            log.sends[0]["generation"]["max_output_tokens"],
            json!(HISTORIAN_MAX_OUTPUT_TOKENS),
            "an explicit output budget rides every send: llm-runner's default truncated a real summarization pass"
        );
        assert!(
            log.sends[0]["generation"].get("temperature").is_none(),
            "an omitted historian temperature must not become a provider instruction"
        );
        assert_eq!(
            log.sends[0]["system"],
            json!("role guidance"),
            "system rides the role-scoped SendParams field, byte-exact"
        );
        assert_eq!(log.goodbyes, vec![10]);
    }

    #[tokio::test]
    async fn a_queued_send_is_named_as_such_and_its_submission_is_withdrawn() {
        let server = fake_server(
            json!({"state":"pending","submission_id":"sub-77"}),
            Vec::new(),
        )
        .await;
        let mut client = client(&server).await;
        let error = client
            .start("mc-dreamer:classify:abc", "role", "prompt", "prov/model-a")
            .await
            .expect_err("a queued send starts no run");

        match &error {
            HistorianProducerError::SendQueued {
                submission_id,
                retracted,
            } => {
                assert_eq!(submission_id, "sub-77");
                assert!(retracted, "the queued submission must be withdrawn");
            }
            other => panic!("expected a queued send, got {other:?}"),
        }
        assert!(
            error.to_string().contains("already active on the session"),
            "the message must name the busy session, not a missing field: {error}"
        );
        assert!(
            error.is_retryable_model_failure(),
            "a busy session clears; the caller should try again"
        );
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let log = server.log.lock().await;
        assert_eq!(log.retracts.len(), 1);
        assert_eq!(log.retracts[0]["submission_id"], json!("sub-77"));
    }

    async fn session_runner_client(server: &FakeServer) -> HistorianProducer {
        session_runner_client_with_harness(server, "opencode").await
    }

    async fn session_runner_client_with_harness(
        server: &FakeServer,
        harness: &str,
    ) -> HistorianProducer {
        HistorianProducer::connect_to_session_runner(
            HistorianProducerConfig {
                request_timeout: Duration::from_secs(2),
                await_timeout: Duration::from_secs(2),
                route_targets: RouteTargetConfig::default(),
                ..HistorianProducerConfig::new(
                    server.connection_file.clone(),
                    std::env::current_dir().unwrap(),
                    harness,
                )
            },
            SessionRunnerRoute::for_principal(
                Some(&subc_protocol::Principal::Reserved {
                    module_id: "thalamus-harness".into(),
                }),
                "ses-parent",
            )
            .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn session_runner_client_with_identity(
        server: &FakeServer,
        identity: &crate::session_resolver::RunnerBindIdentity,
        route: SessionRunnerRoute,
    ) -> HistorianProducer {
        let config = HistorianProducerConfig {
            request_timeout: Duration::from_secs(2),
            await_timeout: Duration::from_secs(2),
            route_targets: RouteTargetConfig::default(),
            ..HistorianProducerConfig::new(
                server.connection_file.clone(),
                identity.project_root.clone(),
                identity.harness.clone(),
            )
        };
        HistorianProducer::connect_to_session_runner(config, route)
            .await
            .unwrap()
    }

    /// A runner-lane historian uses the conversation's runner rather than the configured
    /// `broca` module. It creates the child with the harness value supplied in Setup and
    /// omits `parent`, which the runner does not declare. The historian caps each child
    /// run at one step; retention is applied within the limits declared by the runner.
    #[tokio::test]
    async fn a_session_runner_child_uses_the_conversation_harness_without_parent_fields() {
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            json!({"capabilities":["retention","no_tools","max_steps","max_output_tokens"],"retention":{"max_seconds":2_592_000,"delete_within_ms":3_600_000}}),
            false,
        )
        .await;
        let mut producer = session_runner_client_with_harness(&server, "claude-code").await;
        producer
            .start("mc-hist-1", "system", "prompt", "provider/model")
            .await
            .unwrap();
        let log = server.log.lock().await;
        assert_eq!(
            log.route_targets,
            vec![subc_protocol::RouteTarget::ManagementSurface {
                module_id: "thalamus-harness".into()
            }],
            "the configured broca target must not be used for a THALAMUS session"
        );
        assert_eq!(
            log.route_role_versions,
            vec![Some(BTreeMap::from([(
                "llm-runner".to_string(),
                "v1".to_string()
            )]))],
            "a runner route declares it speaks llm-runner/v1"
        );
        assert_eq!(
            log.route_project_roots,
            vec![std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
        assert_eq!(log.route_harnesses, vec!["claude-code"]);
        assert_eq!(log.route_sessions, vec!["mc-hist-1".to_string()]);
        let send = &log.sends[0];
        assert!(send.get("parent").is_none(), "{send}");
        assert_eq!(send["tools"], json!([]));
        assert_eq!(send["stop_when"], json!({"max_steps": 1}));
        assert_eq!(send["retention"], 86_400);
        assert!(send.get("budget").is_none(), "{send}");
    }

    #[tokio::test]
    async fn published_route_identity_child_vector_uses_setup_root_harness_and_child_session() {
        const VECTORS: &[u8] =
            include_bytes!("../testdata/compaction-provider-v1/route-identity.json");
        assert_eq!(
            crate::sha256_hex(VECTORS),
            "a9a11e290293c8789a4472067dfe373ad68a2b625d53e579bf9bf7bf6d7d18d4"
        );
        let vectors: Value = serde_json::from_slice(VECTORS).unwrap();
        let case = vectors["identity_cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["child_session"].as_str().is_some())
            .unwrap();
        let setup = &case["setup"];
        let child_bind = &case["expected"]["child_bind"];
        let child_session = case["child_session"].as_str().unwrap();
        let parent_session = setup["session"].as_str().unwrap();
        let identity = crate::session_resolver::RunnerBindIdentity {
            project_root: PathBuf::from(child_bind["project_root"].as_str().unwrap()),
            harness: child_bind["harness"].as_str().unwrap().into(),
            session: child_session.into(),
        };
        assert_eq!(identity.session, child_bind["session"]);
        assert_ne!(identity.session, child_bind["forbidden_child_bind_session"]);
        let route = SessionRunnerRoute::for_principal(
            Some(&subc_protocol::Principal::Reserved {
                module_id: "broca".into(),
            }),
            parent_session,
        )
        .unwrap();
        assert_eq!(route.parent_session(), parent_session);
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            json!({"capabilities":["retention","no_tools","max_steps","max_output_tokens"],"retention":{"max_seconds":2_592_000,"delete_within_ms":3_600_000}}),
            false,
        )
        .await;
        let mut producer = session_runner_client_with_identity(&server, &identity, route).await;
        producer
            .start(child_session, "system", "prompt", "provider/model")
            .await
            .unwrap();
        let log = server.log.lock().await;
        assert_eq!(
            log.route_targets,
            vec![subc_protocol::RouteTarget::ManagementSurface {
                module_id: "broca".into()
            }]
        );
        assert_eq!(
            log.route_project_roots,
            vec![identity.project_root.to_string_lossy().into_owned()]
        );
        assert_eq!(log.route_harnesses, vec![identity.harness.clone()]);
        assert_eq!(log.route_sessions, vec![child_session.to_string()]);
        assert!(log.sends[0].get("parent").is_none(), "{}", log.sends[0]);
    }

    #[tokio::test]
    async fn session_runner_limit_combinations_gate_every_historian_member() {
        for mask in 0..8 {
            let groups: Vec<_> = ["max_steps", "max_output_tokens", "no_tools"]
                .into_iter()
                .enumerate()
                .filter_map(|(bit, group)| (mask & (1 << bit) != 0).then_some(group))
                .collect();
            let server = fake_server_with_role_describe(
                json!({"state":"active","run_id":"run-1"}),
                vec![],
                json!({"capabilities":groups}),
                false,
            )
            .await;
            let mut producer = session_runner_client(&server).await;
            let limits = producer
                .session_runner_limits("child")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(limits.max_output_tokens, mask & 2 != 0);
            let result = producer
                .start("child", "system", "prompt", "provider/model")
                .await;
            let log = server.log.lock().await;
            assert_eq!(log.role_describes.len(), 1, "fit and send share discovery");
            if mask & 5 == 5 {
                result.unwrap();
                assert_eq!(log.sends.len(), 1);
                let send = &log.sends[0];
                let typed: RoleSendRequest = serde_json::from_value(send.clone()).unwrap();
                assert_eq!(typed.no_tools().unwrap(), Some(true));
                assert_eq!(typed.max_steps().unwrap(), Some(1));
                assert_eq!(
                    typed.max_output_tokens().unwrap().is_some(),
                    mask & 2 != 0,
                    "mask={mask}: {send}"
                );
                if mask == 7 {
                    let bytes = serde_json::to_string(
                        &session_send_request(
                            "child",
                            "system",
                            "prompt",
                            "provider/model",
                            None,
                            32_000,
                            None,
                            ChildRetention::Nothing,
                        )
                        .unwrap()
                        .for_session_runner(limits)
                        .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        bytes,
                        r#"{"method":"session.send","params":{"prompt":"prompt","send_id":"child","model":{"provider":"provider","model":"model"},"tools":[],"generation":{"max_output_tokens":32000},"system":"system","stop_when":{"max_steps":1}}}"#
                    );
                    assert_eq!(
                        send,
                        &json!({"prompt":"prompt","send_id":"child","model":{"provider":"provider","model":"model"},"tools":[],"generation":{"max_output_tokens":32000},"system":"system","stop_when":{"max_steps":1}})
                    );
                }
            } else {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("historian_runner_missing_groups"), "{error}");
                for (bit, name) in [(1, "max_steps"), (4, "no_tools")] {
                    if mask & bit == 0 {
                        assert!(error.contains(name), "{error}");
                    }
                }
                assert!(
                    log.sends.is_empty(),
                    "no unsafe raw-request fallback: mask={mask}"
                );
            }
        }
    }

    #[tokio::test]
    async fn session_runner_never_sends_a_tool_free_zen_request() {
        let server = fake_server_with_role_describe(
            json!({"state":"active","run_id":"run-1"}),
            vec![],
            json!({"capabilities":["no_tools","max_steps","max_output_tokens"]}),
            false,
        )
        .await;
        let mut producer = session_runner_client(&server).await;
        let error = producer
            .start("child", "", "prompt", "opencode/paid-model")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("historian_zen_no_tools"));
        assert!(server.log.lock().await.sends.is_empty());
    }

    /// The configured `llm-runner` module route and the session-runner route both bind
    /// each child to its own session, omit `parent`, and enforce a one-step limit.
    #[tokio::test]
    async fn a_configured_runner_send_has_no_parent_and_enforces_one_step() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut producer = client(&server).await;
        producer
            .start("mc-hist-1", "system", "prompt", "provider/model")
            .await
            .unwrap();
        let log = server.log.lock().await;
        assert_eq!(
            log.route_targets,
            vec![subc_protocol::RouteTarget::ManagementSurface {
                module_id: "llm-runner".into()
            }]
        );
        assert_eq!(
            log.route_role_versions,
            vec![Some(BTreeMap::from([(
                "llm-runner".to_string(),
                "v1".to_string()
            )]))]
        );
        assert!(log.sends[0].get("parent").is_none());
        assert_eq!(log.sends[0]["stop_when"], json!({"max_steps":1}));
    }

    #[tokio::test]
    async fn start_with_explicit_temperature_serializes_it() {
        for temperature in [0.1, 0.0] {
            let server = fake_server(
                json!({"state":"active","run_id":"run-temperature"}),
                Vec::new(),
            )
            .await;
            let mut client = client(&server).await;
            client
                .start_with_temperature(
                    "mc-historian:proj:1",
                    "role guidance",
                    "prompt",
                    "prov/model-a",
                    None,
                    Some(temperature),
                )
                .await
                .unwrap();
            client.close().await;
            tokio::time::sleep(Duration::from_millis(20)).await;

            let log = server.log.lock().await;
            assert_eq!(
                log.sends[0]["generation"]["temperature"],
                json!(temperature)
            );
        }
    }

    /// Broca's own `session.send` goldens, vendored byte-for-byte; see
    /// `testdata/broca/README.md` for their source path and Broca commit.
    const BROCA_SEND_MODEL_VARIANT_QUEUE: &str =
        include_str!("../testdata/broca/send_request.model_variant_queue.json");
    const BROCA_SEND_MODEL_VARIANT_STEER: &str =
        include_str!("../testdata/broca/send_request.model_variant_steer.json");
    const SEND_WITH_RETENTION: &str =
        include_str!("../testdata/broca/send_request.model_variant_retention.json");

    fn golden_send_params(variant: Option<&str>) -> String {
        golden_send_params_with_retention(variant, ChildRetention::Nothing)
    }

    fn golden_send_params_with_retention(
        variant: Option<&str>,
        retention: ChildRetention,
    ) -> String {
        let request = session_send_request(
            "s-1",
            "",
            "continue",
            "openai/gpt-6.1-sol",
            variant,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            None,
            retention,
        )
        .unwrap();
        assert_eq!(request.method, "session.send");
        serde_json::to_string(&request.params).unwrap()
    }

    /// The send params this client serializes start with exactly Broca's queued-send
    /// golden (`prompt`, `send_id`, `model` with its variant), byte for byte. Only the
    /// fields Broca's golden leaves out (`tools`, `generation`) follow it.
    #[test]
    fn session_send_with_variant_matches_broca_queue_golden_bytes() {
        let golden_body = BROCA_SEND_MODEL_VARIANT_QUEUE
            .strip_suffix('}')
            .expect("golden is one JSON object");
        assert_eq!(
            golden_send_params(Some("high")),
            format!(
                "{golden_body},\"tools\":[],\"generation\":{{\"max_output_tokens\":{HISTORIAN_MAX_OUTPUT_TOKENS}}}}}"
            )
        );
    }

    /// The retention fixture keeps the runner fields first: `prompt`, `send_id`, nested
    /// `model`, and integer retention seconds. This producer appends `tools` and
    /// `generation` afterward.
    #[test]
    fn session_send_retention_matches_runner_contract_field_order() {
        let golden_body = SEND_WITH_RETENTION
            .strip_suffix('}')
            .expect("retention golden is one JSON object");
        assert_eq!(
            golden_send_params_with_retention(Some("high"), ChildRetention::Seconds(86_400)),
            format!(
                "{golden_body},\"tools\":[],\"generation\":{{\"max_output_tokens\":{HISTORIAN_MAX_OUTPUT_TOKENS}}}}}"
            )
        );
    }

    #[test]
    fn retention_requires_a_declared_group_and_clamps_to_its_maximum() {
        assert_eq!(
            retention_from_role_describe(
                &json!({"capabilities": ["retention"], "retention": {"max_seconds": 2_592_000, "delete_within_ms": 3_600_000}})
            ),
            ChildRetention::Seconds(86_400)
        );
        assert_eq!(
            retention_from_role_describe(
                &json!({"capabilities": [], "retention": {"max_seconds": 2_592_000, "delete_within_ms": 3_600_000}})
            ),
            ChildRetention::Nothing
        );
        assert_eq!(
            retention_from_role_describe(
                &json!({"capabilities": ["retention"], "retention": {"max_seconds": 43_200, "delete_within_ms": 3_600_000}})
            ),
            ChildRetention::Seconds(43_200)
        );
    }

    /// A runner declaring `session_retention` gets the policy whatever else it
    /// declares, including the older group with usable limits.
    #[test]
    fn session_retention_selects_the_policy_over_retention_seconds() {
        for capabilities in [
            json!(["session_retention"]),
            json!(["retention", "session_retention"]),
        ] {
            assert_eq!(
                retention_from_role_describe(&json!({
                    "capabilities": capabilities,
                    "retention": {"max_seconds": 2_592_000, "delete_within_ms": 3_600_000},
                    "session_retention": {"max_days": 30, "max_unreleased_hold_ms": 60_000, "required": false},
                })),
                ChildRetention::Policy
            );
        }
    }

    #[test]
    fn a_session_without_first_send_retention_cannot_opt_in_later() {
        let mut frozen = None;
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Nothing),
            ChildRetention::Nothing
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Seconds(86_400)),
            ChildRetention::Nothing,
            "a later route cannot opt a session into retention"
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Policy),
            ChildRetention::Nothing,
            "a later route cannot opt a session into a policy"
        );
        assert_eq!(frozen, Some(ChildRetention::Nothing));
    }

    #[test]
    fn a_reconnected_session_can_only_shorten_its_frozen_retention() {
        let mut frozen = None;
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Seconds(86_400)),
            ChildRetention::Seconds(86_400)
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Seconds(43_200)),
            ChildRetention::Seconds(43_200)
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Seconds(172_800)),
            ChildRetention::Seconds(43_200)
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Policy),
            ChildRetention::Nothing,
            "a session started with seconds never switches member"
        );
    }

    #[test]
    fn a_policy_session_keeps_its_policy_and_never_gains_seconds() {
        let mut frozen = None;
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Policy),
            ChildRetention::Policy
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Policy),
            ChildRetention::Policy
        );
        assert_eq!(
            select_session_retention(&mut frozen, ChildRetention::Seconds(86_400)),
            ChildRetention::Nothing
        );
    }

    /// Broca's steer golden carries the same `model` object plus `delivery: "steer"`.
    /// This client never sends `delivery` (every send is a queued send, which must name
    /// its variant), so the steer golden pins only that the model object is shared.
    #[test]
    fn broca_steer_golden_shares_the_queue_golden_model_object() {
        let steer_body = BROCA_SEND_MODEL_VARIANT_STEER
            .strip_suffix(r#","delivery":"steer"}"#)
            .expect("steer golden ends with its delivery field");
        let queue_body = BROCA_SEND_MODEL_VARIANT_QUEUE
            .strip_suffix('}')
            .expect("golden is one JSON object");
        assert_eq!(steer_body, queue_body);
        assert!(
            golden_send_params(Some("high")).starts_with(steer_body),
            "the steer golden's model object must match this client's bytes too"
        );
    }

    #[test]
    fn session_send_without_variant_omits_the_field() {
        let params = golden_send_params(None);
        assert!(
            params.contains(r#","model":{"provider":"openai","model":"gpt-6.1-sol"},"#),
            "{params}"
        );
        assert!(!params.contains("variant"), "{params}");
        // An empty configured variant is absent, never sent as "".
        assert_eq!(golden_send_params(Some("")), params);
    }

    #[tokio::test]
    async fn start_with_generation_sends_the_variant_on_the_wire() {
        let server = fake_server(json!({"state":"active","run_id":"run-v"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start_with_generation(
                "mc-dreamer:classify:v",
                "role",
                "prompt",
                "openai/gpt-6.1-sol",
                Some("high"),
                4_000,
                Some(0.1),
            )
            .await
            .unwrap();
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let log = server.log.lock().await;
        assert_eq!(
            log.sends[0]["model"],
            json!({ "provider": "openai", "model": "gpt-6.1-sol", "variant": "high" })
        );
        assert_eq!(log.sends[0]["send_id"], json!("mc-dreamer:classify:v"));
        assert_eq!(
            log.sends[0]["generation"]["max_output_tokens"],
            json!(4_000)
        );
        assert_eq!(log.sends[0]["system"], json!("role"));
    }

    #[tokio::test]
    async fn start_omits_system_param_when_empty() {
        // Empty means absent on the wire (the field's empty-as-absent rule); omitting it
        // entirely keeps the send byte-shape identical to pre-system clients.
        let server = fake_server(json!({"state":"active","run_id":"run-9"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:9", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 1);
        assert!(
            log.sends[0].get("system").is_none(),
            "empty system must be omitted, not sent as \"\""
        );
    }

    #[test]
    fn unit_text_collects_only_assistant_message_units() {
        let leaked = json!({
            "type": "example_replay",
            "message": {"content": [{"type": "text", "text": "seed output"}]},
            "text": "flat seed output"
        });
        let assistant = json!({
            "type": "assistant_message",
            "message": {"content": [{"type": "text", "text": "real output"}]}
        });

        assert_eq!(unit_text(&leaked), None);
        assert_eq!(unit_text(&assistant).as_deref(), Some("real output"));
    }

    #[tokio::test]
    async fn await_output_reads_final_result_and_releases_stream_routes() {
        let terminal_text = r#"<output><compartments><compartment start="1" end="1" title="t"><p1>x</p1></compartment></compartments><meta><messages_processed>1-1</messages_processed></meta></output>"#;
        let events = vec![
            json!({"kind":"display","event":{"type":"text_delta","text":"ignored"}}),
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"assistant_message","message":{"message_id":"m-1","content":[
                {"type":"reasoning","text":"planning prose that restates start=\"FIRST\" and walks the seed examples"},
                {"type":"text","text":terminal_text}
            ]}}}),
            json!({"kind":"control","unit":{"type":"run_finished","finish_reason":"completed"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:2", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = client.await_output("run-1").await.unwrap();
        client.close().await;
        // Route release is asynchronous after close(); poll for both goodbyes
        // instead of budgeting a fixed sleep, which raced the second release on
        // slower hardware (issue #373: ~40-60ms observed against a 20ms budget).
        let release_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if server.log.lock().await.goodbyes.len() >= 2 {
                break;
            }
            if tokio::time::Instant::now() >= release_deadline {
                break; // fall through to the assertions for a full diagnostic
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(output.text, terminal_text);
        let log = server.log.lock().await;
        assert_eq!(
            log.route_sessions,
            vec!["mc-historian:proj:2", "mc-historian:proj:2"]
        );
        assert_eq!(log.subscribes, vec![json!({"from":"start"})]);
        assert_eq!(
            log.goodbyes,
            vec![11, 10],
            "close releases subscribe and command routes"
        );
    }

    /// The fake runner sums scripted-step usage into run.result. The producer
    /// reads that total, not the individual stream-event bodies.
    #[tokio::test]
    async fn await_output_reads_aggregated_result_usage() {
        let with_steps = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"step_finished","step_id":"s1","finish_reason":"tool_calls",
                "usage":{"input_tokens":10_000,"output_tokens":2_000,"cached_input_tokens":7,"cache_write_tokens":1}}}),
            json!({"kind":"control","unit":{"type":"step_finished","step_id":"s2","finish_reason":"stop",
                "usage":{"input_tokens":4_039,"output_tokens":4_125,"cached_input_tokens":5}}}),
            json!({"kind":"control","unit":{"type":"run_finished","reason":"completed",
                "usage":{"input_tokens":1,"output_tokens":1}}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), with_steps).await;
        let mut first = client(&server).await;
        first
            .start("mc-historian:proj:4", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = first.await_output("run-1").await.unwrap();
        first.close().await;
        assert_eq!(
            output.usage,
            Some(ProducerUsage {
                input: 14_039,
                output: 6_125,
                cache_read: 12,
                cache_write: 1,
            })
        );

        let terminal_only = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"run_finished","reason":"completed",
                "usage":{"input_tokens":30,"output_tokens":40}}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), terminal_only).await;
        let mut second = client(&server).await;
        second
            .start("mc-historian:proj:5", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = second.await_output("run-1").await.unwrap();
        second.close().await;
        assert_eq!(
            output.usage,
            Some(ProducerUsage {
                input: 30,
                output: 40,
                cache_read: 0,
                cache_write: 0,
            })
        );
    }

    #[tokio::test]
    async fn run_result_for_a_different_run_is_refused() {
        let events = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"other-run"}}),
            json!({"kind":"control","unit":{"type":"run_finished","finish_reason":"completed"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        server.answers.lock().await.result = Some(
            json!({"run_id":"other-run","state":"completed","final_message":{"ordinal":1,"mid":"m","text":""}}),
        );
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:3", "", "prompt", "prov/model-a")
            .await
            .unwrap();

        let err = client.await_output("run-1").await.unwrap_err();
        assert!(err.to_string().contains("run_result_malformed"));
    }

    #[tokio::test]
    async fn paused_status_is_nonterminal_until_the_follow_deadline() {
        let events = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"paused","run_id":"run-1","reason":"auth_required"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:4", "", "prompt", "prov/model-a")
            .await
            .unwrap();

        let err = client
            .await_output_with_timeout("run-1", Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(matches!(err, HistorianProducerError::TimedOut));
        let (statuses, results) = server.follow_counts().await;
        assert!(statuses >= 2);
        assert_eq!(results, 0);
    }

    #[test]
    fn run_status_uses_exact_role_states_and_keeps_unknown_states_nonterminal() {
        for state in [
            "completed",
            "max_steps",
            "budget_exhausted",
            "context_ceiling",
            "cancelled",
            "error",
            "interrupted",
        ] {
            assert_eq!(
                classify_run_state("r", &json!({"state":state})),
                RunState::Terminal
            );
        }
        for state in [
            "active",
            "paused",
            "unknown",
            "future_state",
            "terminal",
            "finished",
            "active_error",
        ] {
            assert_eq!(
                classify_run_state("r", &json!({"state":state})),
                RunState::Active
            );
        }
    }

    #[tokio::test]
    async fn completed_empty_result_overrides_stream_text_and_costs_one_status_probe() {
        let server = fake_server(json!({"run_id":"run-1"}), vec![json!({"kind":"control","unit":{"type":"assistant_message","text":"must not escape"}})]).await;
        server.answers.lock().await.result = Some(
            json!({"run_id":"run-1","state":"completed","final_message":{"ordinal":1,"mid":"empty","text":""}}),
        );
        let mut producer = client(&server).await;
        producer
            .start("child", "", "prompt", "provider/model")
            .await
            .unwrap();
        assert_eq!(producer.await_output("run-1").await.unwrap().text, "");
        assert_eq!(server.follow_counts().await, (1, 1));
    }

    #[tokio::test]
    async fn quiet_stream_uses_bounded_status_timer_through_paused_and_unknown_states() {
        let server = fake_server(json!({"run_id":"run-1"}), vec![]).await;
        server.answers.lock().await.statuses = ["active", "paused", "unknown", "completed"]
            .map(|state| json!({"state":state}))
            .into();
        let mut producer = client(&server).await;
        producer
            .start("child", "", "prompt", "provider/model")
            .await
            .unwrap();
        producer
            .await_output_with_timeout("run-1", Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(server.follow_counts().await, (4, 1));
    }

    #[tokio::test]
    async fn both_module_transports_omit_the_undeclared_parent_field() {
        for session_owned in [false, true] {
            let server = fake_server_with_role_describe(
                json!({"run_id":"run-1"}),
                vec![],
                json!({"capabilities":["max_steps","no_tools"]}),
                false,
            )
            .await;
            let mut producer = if session_owned {
                session_runner_client(&server).await
            } else {
                client(&server).await
            };
            producer
                .start("child", "", "prompt", "provider/model")
                .await
                .unwrap();
            let log = server.log.lock().await;
            let request: RoleSendRequest = serde_json::from_value(log.sends[0].clone()).unwrap();
            assert_eq!(request.max_steps().unwrap(), Some(1));
            assert_eq!(request.no_tools().unwrap(), Some(true));
            assert_eq!(request.max_output_tokens().unwrap(), None);
            assert!(log.sends[0].get("parent").is_none());
        }
    }

    /// The error a bare llm-runner reply must produce.
    fn assert_reply_shape(error: &HistorianProducerError) {
        assert!(error.is_runner_reply_shape(), "{error:?}");
        assert!(
            error.to_string().contains("runner_reply_shape"),
            "named in the message: {error}"
        );
    }

    #[tokio::test]
    async fn a_bare_role_describe_reply_is_refused_by_name_before_any_send() {
        // `role.describe` feeds `RunnerLimits::from_describe`,
        // `FollowCapabilities::from_describe` and the retention policy.
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), vec![]).await;
        server.answers.lock().await.bare = true;
        let mut producer = client(&server).await;
        let error = producer
            .start("child", "", "prompt", "provider/model")
            .await
            .unwrap_err();
        assert_reply_shape(&error);
        let error = producer.session_runner_limits("child").await.unwrap_err();
        assert_reply_shape(&error);
        assert!(server.log.lock().await.sends.is_empty());
        producer.close().await;
    }

    #[tokio::test]
    async fn a_bare_send_reply_is_refused_by_name() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), vec![]).await;
        let mut producer = client(&server).await;
        // The describe is read wrapped; only the send's reply comes back bare.
        producer.session_runner_limits("child").await.unwrap();
        server.answers.lock().await.bare = true;
        let error = producer
            .start("child", "", "prompt", "provider/model")
            .await
            .unwrap_err();
        assert_reply_shape(&error);
        assert_eq!(server.log.lock().await.sends.len(), 1);
        producer.close().await;
    }

    /// The summarizer's retention read keeps the 0.7 describe: the two new
    /// groups change neither the retained lifetime nor the limit and follow
    /// decisions built from the same answer.
    #[test]
    fn broca_0_7_describe_keeps_summarizer_retention_and_limits() {
        let load = |name: &str| {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("testdata")
                .join("broca-0.7")
                .join(name);
            let reply: Value = serde_json::from_slice(&std::fs::read(&path).expect("read fixture"))
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            crate::session_resolver::read_runner_reply(reply).expect("envelope")
        };
        let before = load("role.describe.before.json");
        let after = load("role.describe.after.json");
        assert_eq!(
            retention_from_role_describe(&before),
            retention_from_role_describe(&after)
        );
        assert!(matches!(
            retention_from_role_describe(&after),
            crate::child_retention::ChildRetention::Seconds(_)
        ));
        assert_eq!(
            crate::runner_limits::RunnerLimits::from_describe(&before),
            crate::runner_limits::RunnerLimits::from_describe(&after)
        );
        assert_eq!(
            crate::runner_follow::FollowCapabilities::from_describe(&before).missing(),
            None
        );
        assert_eq!(
            crate::runner_follow::FollowCapabilities::from_describe(&after).missing(),
            None
        );
    }

    #[tokio::test]
    async fn bare_run_status_and_result_replies_are_refused_by_name() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), vec![]).await;
        let mut producer = client(&server).await;
        let handle = producer
            .start("child", "", "prompt", "provider/model")
            .await
            .unwrap();
        server.answers.lock().await.bare = true;
        assert_reply_shape(&producer.status(&handle.run_id).await.unwrap_err());
        assert_reply_shape(&producer.await_output(&handle.run_id).await.unwrap_err());
        assert_reply_shape(&producer.cancel(&handle.run_id).await.unwrap_err());
        producer.close().await;
    }

    #[tokio::test]
    async fn missing_follow_groups_are_named_before_any_send() {
        for missing in ["run_ops", "run_status"] {
            let server = fake_server(json!({"run_id":"run-1"}), vec![]).await;
            let groups: Vec<_> = [
                "run_ops",
                "run_status",
                "streaming",
                "no_tools",
                "max_steps",
                "max_output_tokens",
            ]
            .into_iter()
            .filter(|group| *group != missing)
            .collect();
            server.answers.lock().await.describe = Some(json!({"capabilities":groups}));
            let mut producer = client(&server).await;
            let error = producer
                .start("child", "", "prompt", "provider/model")
                .await
                .unwrap_err();
            assert!(error
                .to_string()
                .contains(&format!("background_runner_missing_groups: {missing}")));
            assert!(server.log.lock().await.sends.is_empty());
        }
    }
}
