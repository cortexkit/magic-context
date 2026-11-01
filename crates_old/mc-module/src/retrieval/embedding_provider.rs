//! Remote embedding protocol, independent of the HTTP/TLS implementation.
//!
//! Only OpenAI-compatible providers use HTTP. Synapse uses subc RPC and local
//! encoders require a separate inference runtime; both remain explicitly unavailable.

use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::parity_contract::*;
use mc_store::parity_schema_manifest::StoredVector;

const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const OPEN_DURATION: Duration = Duration::from_secs(300);
// HTTP 429 handling, matching embedding-openai.ts. A rate limit means the
// endpoint is healthy but asks for a pause, so it never counts toward the circuit
// above. The endpoint enters a cooldown taken from Retry-After (delta-seconds or
// an HTTP date, capped at RETRY_AFTER_CAP). Without a usable header the cooldown
// is an exponential backoff from RATE_LIMIT_BACKOFF_BASE, doubled per
// consecutive 429 and capped at RATE_LIMIT_BACKOFF_CAP, plus up to
// RATE_LIMIT_BACKOFF_JITTER of extra delay so separate processes spread out.
// Query embeds never wait: a 429, or a call during the cooldown, fails at once
// with RateLimited and sends nothing more. Passage embeds wait out the cooldown
// and resend the same batch until a real result arrives or the caller cancels or
// its deadline passes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(60);
const RATE_LIMIT_BACKOFF_BASE_MS: f64 = 1_000.0;
const RATE_LIMIT_BACKOFF_CAP_MS: f64 = 30_000.0;
const RATE_LIMIT_BACKOFF_JITTER: f64 = 0.25;
// Send the entire supplied batch in one POST, matching embedding-openai.ts.
// Introducing a limit here would change provider requests and batch failure scope.
const HTTP_BATCH_SIZE: usize = usize::MAX;
const QUERY_INSTRUCTION: &str =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum QueryInstruction {
    Text(String),
    Disabled(bool),
}

/// Values are already resolved by the trusted configuration loader. No environment
/// lookup, credential-file access or endpoint discovery happens in this client.
#[derive(Clone, Deserialize, Serialize)]
pub struct OpenAiConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub input_type: Option<String>,
    pub query_input_type: Option<String>,
    pub query_instruction: Option<QueryInstruction>,
    pub document_prefix: Option<String>,
    pub truncate: Option<String>,
    pub max_input_tokens: Option<u32>,
    /// Expected vector width supplied by the caller. Every returned vector is
    /// checked against it before publication; no dimensions field is sent to HTTP.
    pub dimensions: u32,
}

#[derive(Clone)]
pub enum ResolvedEmbeddingConfig {
    Off,
    Local { model: String },
    OpenAiCompatible(OpenAiConfig),
    Synapse { identity: EmbeddingIdentity },
}

// Deliberately no Debug implementation: requests and config carry credentials
// and private text, which must not escape through diagnostic formatting.
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingError {
    Off,
    LocalUnavailable,
    SynapseUnavailable,
    TransportUnavailable,
    InvalidConfig,
    EndpointBlocked,
    Cancelled,
    Timeout,
    Transport,
    Http {
        status: u16,
    },
    InvalidEnvelope,
    EmptyResult,
    SubstitutionRejected,
    InvalidVector,
    IdentityMismatch,
    StaleGeneration,
    ContractVersion,
    EmptyInput,
    CircuitOpen,
    /// The endpoint answered HTTP 429, or its cooldown from an earlier 429 is
    /// still running. Back-pressure, not an endpoint failure.
    RateLimited,
}

impl EmbeddingError {
    pub fn reason(self) -> CapabilityReason {
        let (code, message) = match self {
            Self::Off => ("embedding_off", "Embedding provider is disabled"),
            Self::LocalUnavailable => (
                "local_unavailable",
                "Local embedding inference is unavailable",
            ),
            Self::SynapseUnavailable => (
                "synapse_unavailable",
                "Synapse embeddings use subc RPC; scheduled for a separate slice",
            ),
            Self::TransportUnavailable => (
                "transport_unavailable",
                "HTTP transport has not been injected",
            ),
            Self::InvalidConfig => (
                "invalid_config",
                "Embedding endpoint, model and dimensions are required",
            ),
            Self::EndpointBlocked => (
                "endpoint_blocked",
                "Embedding endpoint is invalid or blocked by metadata policy",
            ),
            Self::Cancelled => ("cancelled", "Embedding request was cancelled"),
            Self::Timeout => ("timeout", "Embedding request deadline expired"),
            Self::Transport => ("transport_error", "Embedding transport failed"),
            Self::Http { .. } => (
                "http_error",
                "Embedding endpoint returned a non-success status",
            ),
            Self::InvalidEnvelope => (
                "invalid_envelope",
                "Embedding response envelope or indices are invalid",
            ),
            Self::EmptyResult => ("empty_result", "Embedding endpoint returned no vectors"),
            Self::SubstitutionRejected => (
                "substitution_rejected",
                "Embedding endpoint substituted a different model",
            ),
            Self::InvalidVector => (
                "invalid_vector",
                "Embedding vector is empty, nonfinite or has the wrong dimensions",
            ),
            Self::IdentityMismatch => (
                "identity_mismatch",
                "Embedding request identity does not match this provider",
            ),
            Self::StaleGeneration => (
                "stale_generation",
                "Embedding configuration or source generation changed",
            ),
            Self::ContractVersion => (
                "contract_version",
                "Embedding contract version is unsupported",
            ),
            Self::EmptyInput => (
                "empty_input",
                "Embedding request must contain at least one input",
            ),
            Self::CircuitOpen => ("circuit_open", "Embedding endpoint circuit is open"),
            Self::RateLimited => (
                "rate_limited",
                "Embedding endpoint is rate limited; requests pause until its cooldown ends",
            ),
        };
        CapabilityReason {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::Timeout | Self::Transport | Self::EmptyResult | Self::RateLimited
        ) || matches!(self, Self::Http { status } if status >= 500 || status == 408 || status == 429)
    }
}

pub type HttpFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HttpResponse, EmbeddingError>> + Send + 'a>>;

/// The transport must not follow redirects, log requests, or retry. It must abort
/// network work when this future is dropped, the control is cancelled or timeout
/// expires. Automatically generated Host, Content-Length, Connection, User-Agent,
/// Accept and Accept-Encoding headers are transport-owned, not provider headers.
pub trait HttpTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        control: &'a CallbackControl,
        timeout: Duration,
    ) -> HttpFuture<'a>;
}

#[derive(Default)]
struct Circuit {
    failures: Vec<Instant>,
    open_until: Option<Instant>,
    probing: bool,
}

struct Probe<'a> {
    circuit: &'a Mutex<Circuit>,
    is_probe: bool,
}

impl Drop for Probe<'_> {
    fn drop(&mut self) {
        if self.is_probe {
            self.circuit.lock().unwrap().probing = false;
        }
    }
}

#[derive(Default)]
struct RateLimit {
    /// No request may be sent to the endpoint before this instant.
    until: Option<Instant>,
    /// 429s received since the last successful response; drives the backoff.
    consecutive: u32,
}

pub struct RemoteEmbeddingProvider {
    config: ResolvedEmbeddingConfig,
    transport: Option<Arc<dyn HttpTransport>>,
    identity: Option<EmbeddingIdentity>,
    config_generation: Generation,
    live_generation: Arc<AtomicU64>,
    circuit: Mutex<Circuit>,
    // Per provider instance. TypeScript shares one cooldown between every
    // provider on the same endpoint and API key; this client keeps no
    // process-wide state and never derives anything from the key, so an owner
    // that wants the cooldown shared must share the provider.
    rate_limit: Mutex<RateLimit>,
}

impl RemoteEmbeddingProvider {
    /// The owner advances live_generation on reload. Responses from a different
    /// config generation are discarded, even if the POST succeeded. The store
    /// must separately check its current writer generation before publishing:
    /// configuration freshness alone does not prove that source text is unchanged.
    pub fn new(
        config: ResolvedEmbeddingConfig,
        transport: Option<Arc<dyn HttpTransport>>,
        config_generation: Generation,
        live_generation: Arc<AtomicU64>,
    ) -> Self {
        let identity = match &config {
            ResolvedEmbeddingConfig::OpenAiCompatible(config) => Some(openai_identity(config)),
            ResolvedEmbeddingConfig::Synapse { identity } => Some(identity.clone()),
            _ => None,
        };
        Self {
            config,
            transport,
            identity,
            config_generation,
            live_generation,
            circuit: Mutex::default(),
            rate_limit: Mutex::default(),
        }
    }

    pub fn identity(&self) -> Option<&EmbeddingIdentity> {
        self.identity.as_ref()
    }

    fn readiness(&self) -> Result<&OpenAiConfig, EmbeddingError> {
        match &self.config {
            ResolvedEmbeddingConfig::Off => Err(EmbeddingError::Off),
            ResolvedEmbeddingConfig::Local { .. } => Err(EmbeddingError::LocalUnavailable),
            ResolvedEmbeddingConfig::Synapse { .. } => Err(EmbeddingError::SynapseUnavailable),
            ResolvedEmbeddingConfig::OpenAiCompatible(config) => {
                if trim(&config.endpoint).is_empty()
                    || trim(&config.model).is_empty()
                    || config.dimensions == 0
                    || matches!(
                        config.query_instruction,
                        Some(QueryInstruction::Disabled(true))
                    )
                {
                    return Err(EmbeddingError::InvalidConfig);
                }
                validate_endpoint(&config.endpoint)?;
                if self.transport.is_none() {
                    return Err(EmbeddingError::TransportUnavailable);
                }
                Ok(config)
            }
        }
    }

    fn fence(
        &self,
        context: &RequestContext,
        request: &EmbeddingRequest,
    ) -> Result<(), EmbeddingError> {
        if context.contract_version != PARITY_CONTRACT_VERSION {
            return Err(EmbeddingError::ContractVersion);
        }
        if context.control.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        if chrono::Utc::now().timestamp_millis() >= context.control.deadline_at_ms {
            return Err(EmbeddingError::Timeout);
        }
        if context.config_generation != self.config_generation
            || self.live_generation.load(Ordering::Acquire) != self.config_generation.0
            || request
                .inputs
                .iter()
                .any(|input| input.source.generation != context.route.scope().generation)
        {
            return Err(EmbeddingError::StaleGeneration);
        }
        if Some(&request.identity) != self.identity.as_ref() {
            return Err(EmbeddingError::IdentityMismatch);
        }
        Ok(())
    }

    fn claim(&self) -> Result<Probe<'_>, EmbeddingError> {
        let mut circuit = self.circuit.lock().unwrap();
        let is_probe = if let Some(until) = circuit.open_until {
            if Instant::now() < until || circuit.probing {
                return Err(EmbeddingError::CircuitOpen);
            }
            circuit.probing = true;
            true
        } else {
            false
        };
        Ok(Probe {
            circuit: &self.circuit,
            is_probe,
        })
    }

    fn record(&self, result: &Result<Vec<Vec<f32>>, EmbeddingError>, probe: &Probe<'_>) {
        if result.is_ok() {
            self.rate_limit.lock().unwrap().consecutive = 0;
        }
        let mut circuit = self.circuit.lock().unwrap();
        match result {
            Ok(_) => {
                circuit.failures.clear();
                circuit.open_until = None;
            }
            Err(EmbeddingError::Cancelled | EmbeddingError::StaleGeneration) => {}
            Err(_) => {
                let now = Instant::now();
                circuit
                    .failures
                    .retain(|time| now.duration_since(*time) < FAILURE_WINDOW);
                circuit.failures.push(now);
                if probe.is_probe || circuit.failures.len() >= 3 {
                    circuit.open_until = Some(now + OPEN_DURATION);
                    circuit.failures.clear();
                }
            }
        }
    }

    /// Time left in the rate-limit cooldown, or None when requests may be sent.
    fn cooldown_remaining(&self) -> Option<Duration> {
        let until = self.rate_limit.lock().unwrap().until?;
        until
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
    }

    /// Start or extend the cooldown after an HTTP 429.
    fn note_rate_limit(&self, headers: &[(String, String)]) {
        let header_delay = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("retry-after"))
            .and_then(|(_, value)| parse_retry_after(value, chrono::Utc::now()));
        let mut state = self.rate_limit.lock().unwrap();
        let delay =
            header_delay.unwrap_or_else(|| rate_limit_backoff(state.consecutive, jitter_sample()));
        state.consecutive = state.consecutive.saturating_add(1);
        let until = Instant::now() + delay;
        state.until = Some(state.until.map_or(until, |current| current.max(until)));
    }

    /// Sleep through `wait`, returning early when the caller cancels or its
    /// deadline arrives. The caller re-runs its fence afterwards to report which.
    async fn pause(&self, context: &RequestContext, wait: Duration) {
        let deadline = Duration::from_millis(
            (context.control.deadline_at_ms - chrono::Utc::now().timestamp_millis()).max(0) as u64,
        );
        tokio::select! {
            biased;
            _ = until_cancelled(&context.control) => {}
            _ = tokio::time::sleep(wait.min(deadline)) => {}
        }
    }

    pub async fn embed_checked(
        &self,
        context: &RequestContext,
        request: &EmbeddingRequest,
    ) -> Result<EmbeddingResult, EmbeddingError> {
        let config = self.readiness()?;
        self.fence(context, request)?;
        if request.inputs.is_empty() {
            return Err(EmbeddingError::EmptyInput);
        }
        let mut vectors = Vec::with_capacity(request.inputs.len());
        let is_query = request.kind == EmbeddingInputKind::Query;
        for inputs in request.inputs.chunks(HTTP_BATCH_SIZE) {
            // Each turn either returns, waits out a rate-limit cooldown and
            // resends (passages only), or ends with this batch's vectors.
            let batch = loop {
                self.fence(context, request)?;
                if let Some(wait) = self.cooldown_remaining() {
                    if is_query {
                        return Err(EmbeddingError::RateLimited);
                    }
                    self.pause(context, wait).await;
                    continue;
                }
                let probe = self.claim()?;
                let timeout = FETCH_TIMEOUT.min(Duration::from_millis(
                    (context.control.deadline_at_ms - chrono::Utc::now().timestamp_millis()).max(0)
                        as u64,
                ));
                let http = make_request(config, request.kind, inputs);
                let transport = self.transport.as_ref().unwrap();
                let send = transport.send(http, &context.control, timeout);
                let result = tokio::select! {
                    biased;
                    _ = until_cancelled(&context.control) => Err(EmbeddingError::Cancelled),
                    _ = tokio::time::sleep(timeout) => Err(EmbeddingError::Timeout),
                    response = send => response.and_then(|response| {
                        if response.status == 429 {
                            self.note_rate_limit(&response.headers);
                            return Err(EmbeddingError::RateLimited);
                        }
                        parse_response(config, response, inputs.len())
                    }),
                };
                // Caller cancellation/deadline and configuration reload are checked
                // before recording health, so they cannot open the endpoint circuit.
                self.fence(context, request)?;
                if matches!(result, Err(EmbeddingError::RateLimited)) {
                    // Never recorded: a 429 leaves the circuit as it was. Dropping
                    // the probe frees a half-open slot without re-opening it.
                    drop(probe);
                    if is_query {
                        return Err(EmbeddingError::RateLimited);
                    }
                    continue;
                }
                self.record(&result, &probe);
                break result?;
            };
            for (input, values) in inputs.iter().zip(batch) {
                vectors.push(StoredVector {
                    source: input.source.clone(),
                    embedding: request.identity.clone(),
                    values,
                });
            }
        }
        self.fence(context, request)?;
        Ok(EmbeddingResult {
            identity: request.identity.clone(),
            generation: context.config_generation,
            vectors,
        })
    }
}

impl EmbeddingProvider for RemoteEmbeddingProvider {
    fn availability(&self) -> Availability {
        if self.live_generation.load(Ordering::Acquire) != self.config_generation.0 {
            return Availability::Unavailable {
                reason: EmbeddingError::StaleGeneration.reason(),
            };
        }
        if let Err(error) = self.readiness() {
            return Availability::Unavailable {
                reason: error.reason(),
            };
        }
        let circuit = self.circuit.lock().unwrap();
        if circuit
            .open_until
            .is_some_and(|until| Instant::now() < until)
            || circuit.probing
        {
            return Availability::Unavailable {
                reason: EmbeddingError::CircuitOpen.reason(),
            };
        }
        Availability::Available
    }

    fn embed<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a EmbeddingRequest,
    ) -> CallbackFuture<'a, EmbeddingResult> {
        Box::pin(async move {
            match self.embed_checked(context, request).await {
                Ok(value) => CapabilityResult::Available { value },
                Err(error) => CapabilityResult::Unavailable {
                    reason: error.reason(),
                },
            }
        })
    }
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}
fn option_text(text: &Option<String>) -> &str {
    text.as_deref().map(trim).unwrap_or("")
}
fn endpoint(config: &OpenAiConfig) -> &str {
    trim(&config.endpoint).trim_end_matches('/')
}

/// Resolves once the caller cancels. CallbackControl has no async notification,
/// so poll its shared flag; the select that awaits this drops the transport
/// future, which aborts the underlying POST.
async fn until_cancelled(control: &CallbackControl) {
    while !control.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

/// Delay requested by a Retry-After header, capped at RETRY_AFTER_CAP. None when
/// the value is empty, unparseable or asks for no delay, so the caller falls back
/// to exponential backoff instead of resending at once. Same rules as
/// parseRetryAfterMs in embedding-openai.ts: delta-seconds may be fractional and
/// the delay is rounded up to whole milliseconds.
fn parse_retry_after(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<Duration> {
    let value = trim(value);
    if value.is_empty() {
        return None;
    }
    let is_seconds = {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, "0"));
        !whole.is_empty()
            && !fraction.is_empty()
            && whole.bytes().all(|byte| byte.is_ascii_digit())
            && fraction.bytes().all(|byte| byte.is_ascii_digit())
    };
    let delay_ms = if is_seconds {
        value.parse::<f64>().ok()? * 1_000.0
    } else {
        let at = chrono::DateTime::parse_from_rfc2822(value)
            .or_else(|_| chrono::DateTime::parse_from_rfc3339(value))
            .ok()?;
        (at.timestamp_millis() - now.timestamp_millis()) as f64
    };
    if delay_ms.is_nan() || delay_ms <= 0.0 {
        return None;
    }
    Some(Duration::from_millis(delay_ms.ceil() as u64).min(RETRY_AFTER_CAP))
}

/// Backoff for a 429 without a usable Retry-After. `consecutive` counts the 429s
/// already seen in this streak (0 for the first) and `random` is a sample in
/// [0, 1]. The result lies in [nominal, nominal * (1 + jitter)] with nominal =
/// 1 s * 2^consecutive, and never exceeds RATE_LIMIT_BACKOFF_CAP_MS.
fn rate_limit_backoff(consecutive: u32, random: f64) -> Duration {
    let nominal = RATE_LIMIT_BACKOFF_CAP_MS
        .min(RATE_LIMIT_BACKOFF_BASE_MS * 2f64.powi(consecutive.min(30) as i32));
    let jitter = random.clamp(0.0, 1.0) * RATE_LIMIT_BACKOFF_JITTER;
    Duration::from_millis(RATE_LIMIT_BACKOFF_CAP_MS.min((nominal * (1.0 + jitter)).round()) as u64)
}

/// A sample in [0, 1) for backoff jitter. It only spreads processes apart, so the
/// standard library's randomly keyed hasher is enough; no RNG dependency is needed.
fn jitter_sample() -> f64 {
    let bits = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

fn model_parts(model: &str) -> (&str, Option<&str>) {
    match model.rfind(':') {
        Some(colon) if model.rfind('/').is_none_or(|slash| colon > slash) => {
            (&model[..colon], Some(&model[colon + 1..]))
        }
        _ => (model, None),
    }
}
fn models_match(served: &str, requested: &str) -> bool {
    let served = trim(served).to_lowercase();
    let requested = trim(requested).to_lowercase();
    let (a, at) = model_parts(&served);
    let (b, bt) = model_parts(&requested);
    if at.is_some() && bt.is_some() && at != bt {
        return false;
    }
    if a.is_empty() || b.is_empty() || a == b {
        return true;
    }
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    long.strip_prefix(short)
        .is_some_and(|rest| rest.starts_with(['-', '/']))
        || long
            .strip_suffix(short)
            .is_some_and(|rest| rest.ends_with(['-', '/']))
}
fn prefixes(config: &OpenAiConfig) -> (String, String) {
    let model = trim(&config.model).to_lowercase();
    let basename = model_parts(&model).0.rsplit('/').next().unwrap_or("");
    let (query, passage) = if regex::Regex::new("^nomic-embed-text(?:-|$)").unwrap().is_match(basename) {
        ("search_query: ", "search_document: ")
    } else if regex::Regex::new(r"^(?:qwen3-embedding(?:-|$)|gte-qwen[^\n\r\u{2028}\u{2029}]*-instruct(?:-|$)|(?:multilingual-)?e5-[^\n\r\u{2028}\u{2029}]*-instruct(?:-|$))").unwrap().is_match(basename) {
        (QUERY_INSTRUCTION, "")
    } else { ("", "") };
    let query = match &config.query_instruction {
        Some(QueryInstruction::Text(text)) => text.as_str(),
        Some(QueryInstruction::Disabled(false)) => "",
        _ => query,
    };
    (
        query.into(),
        config.document_prefix.as_deref().unwrap_or(passage).into(),
    )
}

/// EmbeddingIdentity.fingerprint equals the TypeScript stored model_id so vectors
/// from either client are recognized as the same embedding. Query-only settings
/// (query_instruction and query_input_type) are excluded because they do not
/// change stored passage vectors.
fn openai_identity(config: &OpenAiConfig) -> EmbeddingIdentity {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct IdentityInput<'a> {
        provider: &'a str,
        model: &'a str,
        endpoint: &'a str,
        api_key_present: bool,
        input_type: &'a str,
        #[serde(skip_serializing_if = "str::is_empty")]
        document_prefix: &'a str,
        #[serde(skip_serializing_if = "str::is_empty")]
        truncate: &'a str,
    }
    let (query, passage) = prefixes(config);
    let raw = serde_json::to_string(&IdentityInput {
        provider: "openai-compatible",
        model: trim(&config.model),
        endpoint: endpoint(config),
        api_key_present: !option_text(&config.api_key).is_empty(),
        input_type: option_text(&config.input_type),
        document_prefix: &passage,
        truncate: option_text(&config.truncate),
    })
    .unwrap();
    let query_type = if option_text(&config.query_input_type).is_empty() {
        option_text(&config.input_type)
    } else {
        option_text(&config.query_input_type)
    };
    let recipe = |prefix: &str, input_type: &str, ratio: f64| {
        serde_json::to_string(&(
            prefix,
            input_type,
            config.max_input_tokens.unwrap_or(512).max(1),
            ratio,
            "float32;no-l2-normalization",
        ))
        .unwrap()
    };
    EmbeddingIdentity {
        provider: "openai-compatible".into(),
        model: trim(&config.model).into(),
        dimensions: config.dimensions,
        query_recipe: recipe(&query, query_type, 0.9),
        passage_recipe: recipe(&passage, option_text(&config.input_type), 1.0),
        fingerprint: format!(
            "embedding-provider:{}",
            mc_store::compute_normalized_memory_hash(&raw)
        ),
        epoch: 0,
    }
}

fn cap_input(input: &str, max_tokens: u32, kind: EmbeddingInputKind) -> String {
    let budget = ((max_tokens.max(1) as f64
        * if kind == EmbeddingInputKind::Query {
            0.9
        } else {
            1.0
        })
    .floor() as usize)
        .max(1);
    if mc_tokenizer::estimate_tokens(input) <= budget {
        return input.into();
    }
    let utf16: Vec<u16> = input.encode_utf16().collect();
    let (mut low, mut high) = (0, utf16.len());
    while low < high {
        let mid = (low + high).div_ceil(2);
        if mc_tokenizer::estimate_tokens(&String::from_utf16_lossy(&utf16[..mid])) <= budget {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    if low > 0
        && low < utf16.len()
        && (0xd800..=0xdbff).contains(&utf16[low - 1])
        && (0xdc00..=0xdfff).contains(&utf16[low])
    {
        low -= 1;
    }
    String::from_utf16_lossy(&utf16[..low])
}

fn make_request(
    config: &OpenAiConfig,
    kind: EmbeddingInputKind,
    inputs: &[EmbeddingInput],
) -> HttpRequest {
    #[derive(Serialize)]
    struct Body<'a> {
        model: &'a str,
        input: Vec<String>,
        #[serde(skip_serializing_if = "str::is_empty")]
        input_type: &'a str,
        #[serde(skip_serializing_if = "str::is_empty")]
        truncate: &'a str,
    }
    let (query, passage) = prefixes(config);
    let prefix = if kind == EmbeddingInputKind::Query {
        query
    } else {
        passage
    };
    let input_type =
        if kind == EmbeddingInputKind::Query && !option_text(&config.query_input_type).is_empty() {
            option_text(&config.query_input_type)
        } else {
            option_text(&config.input_type)
        };
    let body = Body {
        model: trim(&config.model),
        input: inputs
            .iter()
            .map(|input| {
                cap_input(
                    &format!(
                        "{prefix}{}",
                        if trim(&input.text).is_empty() {
                            " "
                        } else {
                            &input.text
                        }
                    ),
                    config.max_input_tokens.unwrap_or(512),
                    kind,
                )
            })
            .collect(),
        input_type,
        truncate: option_text(&config.truncate),
    };
    let mut headers = vec![("content-type".into(), "application/json".into())];
    if !option_text(&config.api_key).is_empty() {
        headers.push((
            "authorization".into(),
            format!("Bearer {}", option_text(&config.api_key)),
        ));
    }
    HttpRequest {
        method: "POST".into(),
        url: format!("{}/embeddings", endpoint(config)),
        headers,
        body: serde_json::to_vec(&body).unwrap(),
    }
}

fn parse_response(
    config: &OpenAiConfig,
    response: HttpResponse,
    count: usize,
) -> Result<Vec<Vec<f32>>, EmbeddingError> {
    if !(200..300).contains(&response.status) {
        return Err(EmbeddingError::Http {
            status: response.status,
        });
    }
    let body: Value =
        serde_json::from_slice(&response.body).map_err(|_| EmbeddingError::InvalidEnvelope)?;
    if body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !models_match(model, trim(&config.model)))
    {
        return Err(EmbeddingError::SubstitutionRejected);
    }
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or(EmbeddingError::InvalidEnvelope)?;
    if data.is_empty() {
        return Err(EmbeddingError::EmptyResult);
    }
    let indexed = data.iter().any(|item| item.get("index").is_some());
    let mut vectors = vec![None; count];
    for (position, item) in data.iter().enumerate() {
        let slot = if indexed {
            item.get("index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .ok_or(EmbeddingError::InvalidEnvelope)?
        } else {
            position
        };
        if slot >= count || vectors[slot].is_some() {
            return Err(EmbeddingError::InvalidEnvelope);
        }
        let values = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or(EmbeddingError::InvalidEnvelope)?;
        if values.is_empty() || values.len() != config.dimensions as usize {
            return Err(EmbeddingError::InvalidVector);
        }
        let values = values
            .iter()
            .map(|value| {
                let value = value.as_f64().ok_or(EmbeddingError::InvalidVector)? as f32;
                if value.is_finite() {
                    Ok(value)
                } else {
                    Err(EmbeddingError::InvalidVector)
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        // The HTTP TypeScript provider only converts to Float32Array; it does
        // not normalize. L2 normalization here would change stored vector bytes.
        vectors[slot] = Some(values);
    }
    vectors
        .into_iter()
        .map(|vector| vector.ok_or(EmbeddingError::InvalidEnvelope))
        .collect()
}

fn validate_endpoint(endpoint: &str) -> Result<(), EmbeddingError> {
    let endpoint = trim(endpoint);
    let (_, rest) = endpoint
        .split_once("://")
        .filter(|(scheme, _)| {
            scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
        })
        .ok_or(EmbeddingError::EndpointBlocked)?;
    if endpoint
        .chars()
        .any(|ch| ch.is_control() || js_whitespace(ch) || ch == '\\')
    {
        return Err(EmbeddingError::EndpointBlocked);
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(ipv6) = authority.strip_prefix('[') {
        let (host, tail) = ipv6
            .split_once(']')
            .ok_or(EmbeddingError::EndpointBlocked)?;
        if !tail.is_empty()
            && !tail
                .strip_prefix(':')
                .is_some_and(|port| port.parse::<u16>().is_ok())
        {
            return Err(EmbeddingError::EndpointBlocked);
        }
        host.to_lowercase()
    } else {
        let mut parts = authority.split(':');
        let host = parts.next().unwrap_or("").to_lowercase();
        if let Some(port) = parts.next() {
            if port.parse::<u16>().is_err() || parts.next().is_some() {
                return Err(EmbeddingError::EndpointBlocked);
            }
        }
        host
    };
    if host.is_empty()
        || host.contains('%')
        || host == "metadata.google.internal"
        || host == "metadata.goog"
    {
        return Err(EmbeddingError::EndpointBlocked);
    }
    if host.contains(':') {
        let ip: std::net::Ipv6Addr = host.parse().map_err(|_| EmbeddingError::EndpointBlocked)?;
        if ip.segments()[0] == 0xfe80
            || ip == "fd00:ec2::254".parse::<std::net::Ipv6Addr>().unwrap()
            || ip
                .to_ipv4_mapped()
                .is_some_and(|ip| ip.octets()[..2] == [169, 254])
        {
            return Err(EmbeddingError::EndpointBlocked);
        }
    } else {
        // WHATWG accepts short, integer, octal and hexadecimal IPv4 spellings.
        // Canonicalize before blocking the 169.254/16 cloud metadata/link-local
        // range so alternate address spellings cannot bypass the restriction.
        let parts: Vec<_> = host.trim_end_matches('.').split('.').collect();
        let last = parts.last().unwrap();
        if last.chars().all(|ch| ch.is_ascii_digit()) || last.starts_with("0x") {
            let numbers = parts
                .iter()
                .map(|part| {
                    let (digits, radix) = if let Some(digits) = part.strip_prefix("0x") {
                        (digits, 16)
                    } else if part.len() > 1 && part.starts_with('0') {
                        (&part[1..], 8)
                    } else {
                        (*part, 10)
                    };
                    u64::from_str_radix(if digits.is_empty() { "0" } else { digits }, radix)
                        .map_err(|_| EmbeddingError::EndpointBlocked)
                })
                .collect::<Result<Vec<_>, _>>()?;
            if numbers.len() > 4
                || numbers[..numbers.len() - 1].iter().any(|n| *n > 255)
                || numbers[numbers.len() - 1] >= (1u64 << (8 * (5 - numbers.len())))
            {
                return Err(EmbeddingError::EndpointBlocked);
            }
            let ip = numbers[..numbers.len() - 1]
                .iter()
                .enumerate()
                .fold(numbers[numbers.len() - 1], |ip, (index, value)| {
                    ip + (value << (8 * (3 - index)))
                });
            if ip >> 16 == 0xa9fe {
                return Err(EmbeddingError::EndpointBlocked);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_open_has_one_probe_and_drop_releases_it_without_resetting_timer() {
        let provider = RemoteEmbeddingProvider::new(
            ResolvedEmbeddingConfig::Off,
            None,
            Generation(1),
            Arc::new(AtomicU64::new(1)),
        );
        let until = Instant::now() - Duration::from_secs(1);
        provider.circuit.lock().unwrap().open_until = Some(until);
        let probe = provider.claim().unwrap();
        assert!(probe.is_probe);
        assert!(matches!(provider.claim(), Err(EmbeddingError::CircuitOpen)));
        provider.record(&Err(EmbeddingError::Cancelled), &probe);
        drop(probe);
        assert_eq!(provider.circuit.lock().unwrap().open_until, Some(until));
        let probe = provider.claim().unwrap();
        provider.record(&Err(EmbeddingError::Transport), &probe);
        drop(probe);
        assert!(matches!(provider.claim(), Err(EmbeddingError::CircuitOpen)));
    }

    #[test]
    fn expired_failures_do_not_count_toward_open_threshold() {
        let provider = RemoteEmbeddingProvider::new(
            ResolvedEmbeddingConfig::Off,
            None,
            Generation(1),
            Arc::new(AtomicU64::new(1)),
        );
        provider.circuit.lock().unwrap().failures =
            vec![Instant::now() - Duration::from_secs(61); 2];
        let probe = provider.claim().unwrap();
        provider.record(&Err(EmbeddingError::Transport), &probe);
        assert!(provider.circuit.lock().unwrap().open_until.is_none());
        provider.record(&Ok(vec![vec![1.0]]), &probe);
        assert!(provider.circuit.lock().unwrap().failures.is_empty());
    }

    #[test]
    fn retry_after_matches_the_typescript_parser() {
        let now = chrono::DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let ms = |value: &str| parse_retry_after(value, now).map(|delay| delay.as_millis());
        assert_eq!(ms(" 2 "), Some(2_000));
        assert_eq!(ms("0.0015"), Some(2), "fractional seconds round up");
        assert_eq!(ms("120"), Some(60_000), "capped at sixty seconds");
        assert_eq!(ms("Mon, 01 Jan 2024 00:00:05 GMT"), Some(5_000));
        for no_delay in ["", "0", "-1", "1.", "soon", "Sun, 31 Dec 2023 23:59:59 GMT"] {
            assert_eq!(ms(no_delay), None, "{no_delay:?}");
        }
    }

    #[test]
    fn backoff_doubles_per_consecutive_429_with_bounded_jitter() {
        assert_eq!(rate_limit_backoff(0, 0.0), Duration::from_secs(1));
        assert_eq!(rate_limit_backoff(0, 1.0), Duration::from_millis(1_250));
        assert_eq!(rate_limit_backoff(3, 0.0), Duration::from_secs(8));
        assert_eq!(rate_limit_backoff(40, 1.0), Duration::from_secs(30));
        let sample = jitter_sample();
        assert!((0.0..1.0).contains(&sample));
    }

    #[test]
    fn a_429_extends_the_cooldown_and_success_resets_the_streak() {
        let provider = RemoteEmbeddingProvider::new(
            ResolvedEmbeddingConfig::Off,
            None,
            Generation(1),
            Arc::new(AtomicU64::new(1)),
        );
        assert!(provider.cooldown_remaining().is_none());
        provider.note_rate_limit(&[("Retry-After".into(), "30".into())]);
        provider.note_rate_limit(&[("retry-after".into(), "1".into())]);
        let left = provider.cooldown_remaining().unwrap();
        assert!(
            left > Duration::from_secs(28),
            "a shorter pause never shortens the cooldown"
        );
        assert_eq!(provider.rate_limit.lock().unwrap().consecutive, 2);
        let probe = provider.claim().unwrap();
        provider.record(&Ok(vec![vec![1.0]]), &probe);
        assert_eq!(provider.rate_limit.lock().unwrap().consecutive, 0);
    }
}
