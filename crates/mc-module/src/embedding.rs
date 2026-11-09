//! Query embeddings for `ctx_search`, from an OpenAI-compatible endpoint,
//! compared with the vectors the standalone plugin stores in `context.db`.
//!
//! A stored vector is usable only for the provider that made it, so every
//! vector row carries a model id. This module derives that id exactly as the
//! plugin does (`getEmbeddingProviderIdentity`, and `getChunkEmbeddingModelId`
//! for history chunks), which lets ck-mc search the plugin's vectors and the
//! plugin search ck-mc's.
//!
//! Only `openai-compatible` providers are served. The plugin's default,
//! `local`, runs an in-process model that ck-mc does not have; `synapse` needs
//! the Synapse module. With either, search keeps its lexical lanes.
//!
//! The request matches `embedding-openai.ts`: one POST to `<endpoint>/embeddings`
//! with `model`, `input`, and `input_type`/`truncate` when set; no redirects;
//! a 30-second background limit and a 5-second explicit-search limit; a response
//! for another model is refused. A failed query embed only drops semantic scores.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const QUERY_EMBEDDING_TIMEOUT: Duration = Duration::from_secs(5);

mod circuit;
use circuit::{Attempt, Circuit};

#[cfg(test)]
pub(crate) mod circuit_tests;
/// History chunks are sized for this many input tokens when the user names
/// no limit; it is part of the chunk vectors' identity.
const DEFAULT_CHUNK_MAX_INPUT_TOKENS: u64 = 512;
/// Queries are cut to this share of the input limit, the margin the plugin's
/// chunker keeps.
const QUERY_WINDOW_SAFETY_RATIO: f64 = 0.9;
const QWEN_STYLE_QUERY_INSTRUCTION: &str =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

/// An OpenAI-compatible embedding provider, as the user configured it.
#[derive(Clone)]
pub struct Provider {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    input_type: Option<String>,
    query_input_type: Option<String>,
    /// `Some("")` when the user switched the instruction off.
    query_instruction: Option<String>,
    document_prefix: Option<String>,
    truncate: Option<String>,
    max_input_tokens: Option<u64>,
    circuit: Arc<Mutex<Circuit>>,
    fetch_timeout: Duration,
    query_timeout: Duration,
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provider")
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl Provider {
    /// The provider from the two configuration tiers, or `None` when search
    /// has no remote embedding. The user tier arrives with `{env:}`/`{file:}`
    /// already expanded. A project may tune the model's request, but where
    /// text is sent and how a query is worded stay the user's choice.
    pub fn from_tiers(user: &Value, project: &Value, _user_path: &Path) -> Option<Self> {
        let mut merged = json!({"provider": "local"});
        merge(
            &mut merged,
            &user["embedding"],
            &[
                "provider",
                "endpoint",
                "model",
                "api_key",
                "input_type",
                "query_input_type",
                "query_instruction",
                "document_prefix",
                "truncate",
                "max_input_tokens",
            ],
        );
        merge(
            &mut merged,
            &project["embedding"],
            &[
                "model",
                "api_key",
                "input_type",
                "query_input_type",
                "truncate",
                "max_input_tokens",
            ],
        );
        if merged["provider"] != "openai-compatible" {
            return None;
        }
        let endpoint = text(&merged, "endpoint")?.trim_end_matches('/').to_owned();
        let model = text(&merged, "model")?;
        if validate_endpoint(&endpoint).is_err() {
            tracing::info!("ck-mc: the embedding endpoint is not allowed; search uses words only");
            return None;
        }
        Some(Self {
            circuit: Circuit::for_endpoint(&endpoint),
            fetch_timeout: FETCH_TIMEOUT,
            query_timeout: QUERY_EMBEDDING_TIMEOUT,
            endpoint,
            model,
            api_key: text(&merged, "api_key"),
            input_type: text(&merged, "input_type"),
            query_input_type: text(&merged, "query_input_type"),
            query_instruction: match &merged["query_instruction"] {
                Value::String(text) => Some(text.clone()),
                Value::Bool(false) => Some(String::new()),
                _ => None,
            },
            document_prefix: merged["document_prefix"].as_str().map(str::to_owned),
            truncate: text(&merged, "truncate"),
            max_input_tokens: crate::config::integer(&merged["max_input_tokens"])
                .filter(|n| *n > 0),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    #[cfg(test)]
    pub(crate) fn api_key_for_test(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn for_test(endpoint: &str, model: &str) -> Self {
        Self {
            circuit: Circuit::for_endpoint(endpoint),
            fetch_timeout: FETCH_TIMEOUT,
            query_timeout: QUERY_EMBEDDING_TIMEOUT,
            endpoint: endpoint.to_owned(),
            model: model.to_owned(),
            api_key: None,
            input_type: None,
            query_input_type: None,
            query_instruction: None,
            document_prefix: None,
            truncate: None,
            max_input_tokens: None,
        }
    }

    /// The model id memory and commit vectors are stored under.
    pub fn model_id(&self) -> String {
        // Written field by field: the plugin hashes `JSON.stringify` of an
        // object literal, which keeps this field order, and the hash must match.
        let mut serialized = format!(
            "{{\"provider\":\"openai-compatible\",\"model\":{},\"endpoint\":{},\"apiKeyPresent\":{},\"inputType\":{}",
            json!(self.model),
            json!(self.endpoint),
            self.api_key.is_some(),
            json!(self.input_type.clone().unwrap_or_default()),
        );
        let document_prefix = self.document_prefix();
        if !document_prefix.is_empty() {
            serialized.push_str(&format!(",\"documentPrefix\":{}", json!(document_prefix)));
        }
        if let Some(truncate) = &self.truncate {
            serialized.push_str(&format!(",\"truncate\":{}", json!(truncate)));
        }
        serialized.push('}');
        let normalized = serialized
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        format!("embedding-provider:{:x}", md5::compute(normalized))
    }

    /// The model id history-chunk vectors are stored under: the provider's
    /// id plus the chunking recipe, so a change in how history is cut into
    /// chunks retires only chunk vectors.
    pub fn chunk_model_id(&self) -> String {
        let provider = self.model_id();
        // Keys in sorted order, as the plugin's stable serialization writes them.
        let recipe = format!(
            "{{\"chunkerVersion\":2,\"maxInputTokens\":{},\"providerIdentity\":{},\"truncate\":{}}}",
            self.max_input_tokens.unwrap_or(DEFAULT_CHUNK_MAX_INPUT_TOKENS),
            json!(provider),
            json!(self.truncate.clone().unwrap_or_default()),
        );
        let digest = format!("{:x}", Sha256::digest(recipe.as_bytes()));
        format!("{provider}:chunk:{}", &digest[..16])
    }

    /// The same ceiling used in the chunk recipe and the document request.
    pub(crate) fn chunk_max_input_tokens(&self) -> u64 {
        self.max_input_tokens
            .unwrap_or(DEFAULT_CHUNK_MAX_INPUT_TOKENS)
    }

    fn document_prefix(&self) -> String {
        if let Some(prefix) = &self.document_prefix {
            return prefix.clone();
        }
        match family(&self.model) {
            Some(Family::Nomic) => "search_document: ".into(),
            _ => String::new(),
        }
    }

    fn query_prefix(&self) -> String {
        if let Some(instruction) = &self.query_instruction {
            return instruction.clone();
        }
        match family(&self.model) {
            Some(Family::Nomic) => "search_query: ".into(),
            Some(Family::Instruct) => QWEN_STYLE_QUERY_INSTRUCTION.into(),
            None => String::new(),
        }
    }

    /// Embed one search query. `None` when the endpoint fails, refuses, is
    /// rate limited or answers for another model; the caller then searches
    /// by words only.
    pub async fn embed_query(&self, query: &str) -> Option<Vec<f32>> {
        self.query_with_timeout(query, self.fetch_timeout).await
    }

    /// Explicit search has a shorter semantic budget; expiry is an endpoint
    /// timeout, not cancellation of the keyword search.
    pub async fn embed_search_query(&self, query: &str) -> Option<Vec<f32>> {
        self.query_with_timeout(query, self.query_timeout).await
    }

    #[cfg(test)]
    pub(crate) fn with_timeouts_for_test(mut self, fetch: Duration, query: Duration) -> Self {
        self.fetch_timeout = fetch;
        self.query_timeout = query;
        self
    }

    async fn query_with_timeout(&self, query: &str, timeout: Duration) -> Option<Vec<f32>> {
        let mut input = format!(
            "{}{}",
            self.query_prefix(),
            if query.trim().is_empty() { " " } else { query }
        );
        let budget = ((self
            .max_input_tokens
            .unwrap_or(DEFAULT_CHUNK_MAX_INPUT_TOKENS) as f64
            * QUERY_WINDOW_SAFETY_RATIO)
            .floor() as u64)
            .max(1);
        cap_input(&mut input, budget);
        let input_type = self.query_input_type.as_ref().or(self.input_type.as_ref());
        let mut vectors = self
            .request(
                vec![input],
                input_type.map(String::as_str),
                "search query",
                timeout,
            )
            .await?;
        vectors.swap_remove(0)
    }

    /// Embed stored texts (memories, commit messages), one slot per text in
    /// order. `None` when the whole request failed; a `None` slot when only
    /// that text came back unusable. As the plugin's passage batches: each
    /// text gets the document prefix and is cut at the model's full input
    /// limit, and a blank text is sent as one space, which every provider
    /// accepts. A failed or rate-limited batch is simply tried again on the
    /// next upkeep run.
    pub async fn embed_documents(&self, texts: &[String]) -> Option<Vec<Option<Vec<f32>>>> {
        let prefix = self.document_prefix();
        let budget = self
            .max_input_tokens
            .unwrap_or(DEFAULT_CHUNK_MAX_INPUT_TOKENS)
            .max(1);
        let inputs = texts
            .iter()
            .map(|text| {
                let mut input = format!(
                    "{prefix}{}",
                    if text.trim().is_empty() { " " } else { text }
                );
                cap_input(&mut input, budget);
                input
            })
            .collect();
        self.request(
            inputs,
            self.input_type.as_deref(),
            "document",
            self.fetch_timeout,
        )
        .await
    }

    /// One `/embeddings` request, without redirects or proxies.
    async fn request(
        &self,
        inputs: Vec<String>,
        input_type: Option<&str>,
        what: &str,
        timeout: Duration,
    ) -> Option<Vec<Option<Vec<f32>>>> {
        let attempt = Attempt::claim(&self.circuit)?;
        // Bound headers and body together. Dropping this future for caller
        // cancellation only releases the probe; an internal expiry counts once.
        let result = tokio::time::timeout(timeout, self.send(inputs, input_type, timeout)).await;
        match result {
            Ok(Ok(vectors)) => {
                if vectors.iter().any(Option::is_some) {
                    attempt.success();
                } else {
                    attempt.failure();
                }
                Some(vectors)
            }
            Ok(Err(RequestFailure::RateLimited)) => None,
            Ok(Err(RequestFailure::Unavailable)) | Err(_) => {
                tracing::warn!("ck-mc: {what} embedding failed or timed out");
                attempt.failure();
                None
            }
        }
    }

    async fn send(
        &self,
        inputs: Vec<String>,
        input_type: Option<&str>,
        timeout: Duration,
    ) -> Result<Vec<Option<Vec<f32>>>, RequestFailure> {
        let count = inputs.len();
        let mut body = json!({"model": self.model, "input": inputs});
        if let Some(input_type) = input_type {
            body["input_type"] = json!(input_type);
        }
        if let Some(truncate) = &self.truncate {
            body["truncate"] = json!(truncate);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|_| RequestFailure::Unavailable)?;
        let mut request = client
            .post(format!("{}/embeddings", self.endpoint))
            .header("content-type", "application/json");
        if let Some(key) = &self.api_key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        let response = request
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| RequestFailure::Unavailable)?;
        let status = response.status().as_u16();
        // A 429 is healthy backpressure, even if its body never finishes.
        if status == 429 {
            return Err(RequestFailure::RateLimited);
        }
        if status != 200 {
            return Err(RequestFailure::Unavailable);
        }
        let raw = response
            .bytes()
            .await
            .map_err(|_| RequestFailure::Unavailable)?;
        parse_response(&raw, &self.model, count).ok_or(RequestFailure::Unavailable)
    }
}

enum RequestFailure {
    RateLimited,
    Unavailable,
}

/// Cut `input` to about `budget` tokens at a character boundary, keeping its
/// start, where a search task or a document's subject usually is.
fn cap_input(input: &mut String, budget: u64) {
    if crate::tokens::bytes(input.len() as u64) > budget {
        let mut end = (budget * 4) as usize;
        while end > 0 && !input.is_char_boundary(end) {
            end -= 1;
        }
        input.truncate(end);
    }
}

/// The vectors in an embeddings response, one slot per input in order (an
/// unindexed response keeps array order). `None` when the envelope is
/// malformed or names a different model than the one requested; a `None`
/// slot when that input's vector is missing, empty or not finite.
fn parse_response(raw: &[u8], requested: &str, count: usize) -> Option<Vec<Option<Vec<f32>>>> {
    let body: Value = serde_json::from_slice(raw).ok()?;
    if let Some(served) = body["model"].as_str().filter(|served| !served.is_empty()) {
        if !models_match(served, requested) {
            tracing::warn!(
                "ck-mc: the embedding endpoint answered for another model; result refused"
            );
            return None;
        }
    }
    let items = body["data"].as_array()?;
    let indexed = items.iter().any(|item| item.get("index").is_some());
    let mut seen = std::collections::HashSet::new();
    let mut slots = vec![None; count];
    for (position, item) in items.iter().enumerate() {
        let index = if indexed {
            let index = usize::try_from(item["index"].as_u64()?).ok()?;
            if index >= count || !seen.insert(index) {
                return None;
            }
            index
        } else {
            position
        };
        let Some(slot) = slots.get_mut(index) else {
            continue;
        };
        let vector: Option<Vec<f32>> = item["embedding"].as_array().and_then(|values| {
            values
                .iter()
                .map(|value| value.as_f64().map(|value| value as f32))
                .collect()
        });
        *slot = vector
            .filter(|vector| !vector.is_empty() && vector.iter().all(|value| value.is_finite()));
    }
    Some(slots)
}

/// The plugin's substitution guard: equal names, or one name extending the
/// other at a `-` or `/` boundary; a differing `:tag` never matches.
fn models_match(served: &str, requested: &str) -> bool {
    let split = |model: &str| -> (String, Option<String>) {
        let model = model.trim().to_lowercase();
        match model.rfind(':') {
            Some(colon) if colon > model.rfind('/').unwrap_or(0) => (
                model[..colon].to_owned(),
                Some(model[colon + 1..].to_owned()),
            ),
            _ => (model, None),
        }
    };
    let ((a, a_tag), (b, b_tag)) = (split(served), split(requested));
    if let (Some(a_tag), Some(b_tag)) = (&a_tag, &b_tag) {
        if a_tag != b_tag {
            return false;
        }
    }
    if a.is_empty() || b.is_empty() || a == b {
        return true;
    }
    let (longer, shorter) = if a.len() >= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let boundary = |ch: Option<char>| matches!(ch, Some('-' | '/'));
    (longer.starts_with(shorter.as_str()) && boundary(longer[shorter.len()..].chars().next()))
        || (longer.ends_with(shorter.as_str())
            && boundary(longer[..longer.len() - shorter.len()].chars().last()))
}

enum Family {
    /// Qwen3, GTE-Qwen-instruct and E5-instruct embeddings: queries carry the
    /// web-search instruction.
    Instruct,
    /// Nomic embeddings: `search_query: ` / `search_document: ` prefixes.
    Nomic,
}

fn family(model: &str) -> Option<Family> {
    let normalized = model.trim().to_lowercase();
    let base = match normalized.rfind(':') {
        Some(colon) if colon > normalized.rfind('/').unwrap_or(0) => &normalized[..colon],
        _ => normalized.as_str(),
    };
    let name = &base[base.rfind('/').map_or(0, |slash| slash + 1)..];
    let instruct = regex::Regex::new(
        r"^(?:qwen3-embedding(?:-|$)|gte-qwen.*-instruct(?:-|$)|(?:multilingual-)?e5-.*-instruct(?:-|$))",
    )
    .expect("family pattern");
    if instruct.is_match(name) {
        Some(Family::Instruct)
    } else if regex::Regex::new(r"^nomic-embed-text(?:-|$)")
        .expect("nomic pattern")
        .is_match(name)
    {
        Some(Family::Nomic)
    } else {
        None
    }
}

/// Refuse endpoints that could reach a cloud metadata service: only http(s),
/// no control characters or backslashes, and no link-local or metadata host.
fn validate_endpoint(endpoint: &str) -> Result<(), ()> {
    let (scheme, rest) = endpoint.split_once("://").ok_or(())?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(());
    }
    if endpoint
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
    {
        return Err(());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split_once(']').ok_or(())?.0.to_lowercase(),
        None => authority.split(':').next().unwrap_or("").to_lowercase(),
    };
    if host.is_empty()
        || host.contains('%')
        || host == "metadata.google.internal"
        || host == "metadata.goog"
    {
        return Err(());
    }
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        let metadata: std::net::Ipv6Addr = "fd00:ec2::254".parse().expect("address");
        if ip.segments()[0] & 0xffc0 == 0xfe80
            || ip == metadata
            || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_link_local())
        {
            return Err(());
        }
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if ip.is_link_local() {
            return Err(());
        }
    }
    Ok(())
}

/// A vector as stored: little-endian `f32`s, as the plugin writes them.
pub fn encode(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// A stored vector: little-endian `f32`s, as the plugin writes them.
pub fn decode(blob: &[u8]) -> Option<Vec<f32>> {
    (blob.len().is_multiple_of(4) && !blob.is_empty()).then(|| {
        blob.as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect()
    })
}

/// Cosine similarity clamped to 0..1, as the plugin scores memories. Vectors
/// of different lengths score 0.
pub fn similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0f64, 0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (*x as f64, *y as f64);
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    let score = dot / (norm_a.sqrt() * norm_b.sqrt());
    if score.is_finite() {
        score.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn merge(target: &mut Value, source: &Value, keys: &[&str]) {
    for &key in keys {
        if let Some(value) = source.get(key).filter(|value| match key {
            "max_input_tokens" => crate::config::integer(value).is_some_and(|n| n > 0),
            "query_instruction" => value.is_string() || **value == Value::Bool(false),
            _ => value.is_string(),
        }) {
            target[key] = value.clone();
        }
    }
}

#[cfg(test)]
mod config_regression_tests {
    use super::*;

    #[test]
    fn integral_input_limit_is_accepted() {
        let provider = Provider::from_tiers(&json!({"embedding": {"provider": "openai-compatible", "endpoint": "https://example.com/v1", "model": "test", "max_input_tokens": 30000.0}}), &json!({}), Path::new("unused")).unwrap();
        assert_eq!(provider.max_input_tokens, Some(30000));
    }

    #[test]
    fn project_embedding_fields_respect_trust_boundary() {
        let provider = Provider::from_tiers(&json!({"embedding": {
            "provider": "openai-compatible", "endpoint": "https://trusted.example/v1", "model": "user",
            "query_instruction": "trusted query", "document_prefix": "trusted document"
        }}), &json!({"embedding": {
            "provider": "local", "endpoint": "https://project.example/v1", "query_instruction": "unsafe query", "document_prefix": "unsafe document",
            "model": "project", "api_key": "{env:SECRET}", "input_type": "document", "query_input_type": "query", "truncate": "end", "max_input_tokens": 30000
        }}), Path::new("unused")).unwrap();
        assert_eq!(provider.endpoint, "https://trusted.example/v1");
        assert_eq!(provider.query_instruction.as_deref(), Some("trusted query"));
        assert_eq!(
            provider.document_prefix.as_deref(),
            Some("trusted document")
        );
        assert_eq!(provider.model, "project");
        assert_eq!(provider.api_key.as_deref(), Some("{env:SECRET}"));
        assert_eq!(provider.input_type.as_deref(), Some("document"));
        assert_eq!(provider.query_input_type.as_deref(), Some("query"));
        assert_eq!(provider.truncate.as_deref(), Some("end"));
        assert_eq!(provider.max_input_tokens, Some(30000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voyage(api_key: bool) -> Provider {
        Provider::from_tiers(
            &json!({"embedding": {
                "provider": "openai-compatible",
                "endpoint": "https://api.voyageai.com/v1/",
                "model": "voyage-4",
                "api_key": if api_key { "k" } else { "" },
                "input_type": "document",
                "query_input_type": "query",
                "max_input_tokens": 8192
            }}),
            &json!({}),
            Path::new("/u"),
        )
        .unwrap()
    }

    #[test]
    fn ids_match_the_plugin_for_the_same_configuration() {
        // The ids the TypeScript plugin derives for this configuration, taken
        // from vectors it stored. A different derivation would find none of
        // the plugin's vectors.
        let provider = voyage(true);
        assert_eq!(
            provider.model_id(),
            "embedding-provider:fe1e3cf9119cf8e4c7667b9d6c0fb057"
        );
        assert_eq!(
            provider.chunk_model_id(),
            "embedding-provider:fe1e3cf9119cf8e4c7667b9d6c0fb057:chunk:b73ea7976141f62f"
        );
        assert_ne!(voyage(false).model_id(), provider.model_id());
    }

    #[test]
    fn only_remote_providers_with_safe_endpoints_are_served() {
        let local = Provider::from_tiers(&json!({}), &json!({}), Path::new("/u"));
        assert!(local.is_none());
        let metadata = Provider::from_tiers(
            &json!({"embedding": {"provider": "openai-compatible", "endpoint": "http://169.254.169.254/v1", "model": "m"}}),
            &json!({}),
            Path::new("/u"),
        );
        assert!(metadata.is_none());
        let project_endpoint = Provider::from_tiers(
            &json!({"embedding": {"provider": "openai-compatible", "endpoint": "https://a.invalid", "model": "m"}}),
            &json!({"embedding": {"endpoint": "https://evil.invalid", "provider": "off"}}),
            Path::new("/u"),
        )
        .unwrap();
        assert_eq!(project_endpoint.endpoint(), "https://a.invalid");
    }

    #[test]
    fn responses_for_another_model_are_refused() {
        let body = br#"{"model":"voyage-4","data":[{"index":0,"embedding":[0.5,0.25]}]}"#;
        assert_eq!(
            parse_response(body, "voyage-4", 1),
            Some(vec![Some(vec![0.5, 0.25])])
        );
        let other = br#"{"model":"text-embedding-3-small","data":[{"embedding":[1.0]}]}"#;
        assert_eq!(parse_response(other, "voyage-4", 1), None);
        assert!(models_match("nomic-embed-text:latest", "nomic-embed-text"));
        assert!(models_match("org/qwen3-embedding-8b", "qwen3-embedding-8b"));
        assert!(!models_match("model:a", "model:b"));
    }

    #[test]
    fn prefixes_follow_the_model_family() {
        let qwen = Provider::for_test("https://e.invalid", "Qwen/Qwen3-Embedding-8B");
        assert_eq!(qwen.query_prefix(), QWEN_STYLE_QUERY_INSTRUCTION);
        let nomic = Provider::for_test("https://e.invalid", "nomic-embed-text:latest");
        assert_eq!(nomic.query_prefix(), "search_query: ");
        assert_eq!(nomic.document_prefix(), "search_document: ");
        assert_eq!(voyage(true).query_prefix(), "");
    }

    #[test]
    fn similarity_is_clamped_cosine() {
        assert!((similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert_eq!(similarity(&[1.0, 0.0], &[-1.0, 0.0]), 0.0);
        assert_eq!(similarity(&[1.0], &[1.0, 0.0]), 0.0);
        assert_eq!(decode(&1.5f32.to_le_bytes()), Some(vec![1.5]));
    }
}
