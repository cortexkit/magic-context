//! Tool-side provider resolution. No indexing, registration writes or inference runtime.
//!
//! A captured query is usable only with the registration it was embedded against.
//! Local encoders are not available in ck-mc; local/off and failed remote calls
//! deliberately leave lexical recall intact. Credentials and provider bodies are
//! never included in errors or Debug output.

use crate::parity_contract::*;
use crate::retrieval::embedding_provider::{
    EmbeddingError, HttpRequest, HttpResponse, HttpTransport, OpenAiConfig,
    RemoteEmbeddingProvider, ResolvedEmbeddingConfig,
};
use crate::retrieval::hybrid::{RerankCallOptions, RerankClient, RerankIdentity};
use mc_store::retrieval_vectors::drain::Registration;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicU64, Arc};
use std::time::Duration;

#[derive(Clone)]
pub struct Settings {
    embedding: Value,
    rerank: Value,
    connection_file: Option<PathBuf>,
    pub(crate) git_enabled: bool,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SearchProviderSettings { credentials: [redacted] }")
    }
}

impl Settings {
    /// Apply the TS per-leaf trust policy before merging. Only user strings may
    /// expand secrets; project tokens remain literal, including in model/key fields.
    pub fn from_tiers(user: Option<&Value>, project: Option<&Value>, user_path: &Path) -> Self {
        let user = expand_user(user.cloned().unwrap_or(Value::Null), user_path);
        let mut embedding = json!({"provider":"local"});
        merge_fields(
            &mut embedding,
            &user["embedding"],
            &[
                "provider",
                "fallback_provider",
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
        let project = project.unwrap_or(&Value::Null);
        merge_fields(
            &mut embedding,
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
        let mut rerank = json!({"provider":"synapse","timeout_ms":1500,"top_n":20});
        merge_fields(
            &mut rerank,
            &user["rerank"],
            &[
                "provider",
                "endpoint",
                "model",
                "api_key",
                "timeout_ms",
                "top_n",
            ],
        );
        if project.pointer("/rerank/provider").and_then(Value::as_str) == Some("off") {
            rerank["provider"] = json!("off");
        }
        Self {
            embedding,
            rerank,
            git_enabled: project
                .pointer("/memory/git_commit_indexing/enabled")
                .and_then(Value::as_bool)
                .or_else(|| {
                    user.pointer("/memory/git_commit_indexing/enabled")
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false),
            connection_file: user
                .pointer("/subc/connection_file")
                .and_then(Value::as_str)
                .map(PathBuf::from),
        }
    }

    pub(crate) fn rerank_enabled(&self) -> bool {
        matches!(self.rerank["provider"].as_str(), Some("synapse" | "remote"))
    }

    pub(crate) fn rerank_limit(&self) -> usize {
        if self.rerank["provider"] == "remote" {
            self.rerank["top_n"].as_u64().unwrap_or(20).clamp(1, 20) as usize
        } else {
            20
        }
    }

    /// None means retain the complete baseline, never the larger fusion pool.
    /// Hosted failures additionally return the TS tool's safe diagnostic suffix.
    pub(crate) async fn rerank(
        &self,
        io: &dyn ProviderIo,
        identity: &RerankIdentity,
        query: &str,
        documents: &[String],
    ) -> (Option<Vec<usize>>, Option<String>) {
        let remote = self.rerank["provider"] == "remote";
        let result = if remote {
            self.remote_rerank(io, query, documents).await
        } else {
            self.local_rerank(io, identity, query, documents)
                .await
                .ok_or_else(|| "provider_unavailable".to_owned())
        };
        match result {
            Ok(scores) => {
                let mut order = (0..scores.len()).collect::<Vec<_>>();
                order.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]).then(a.cmp(&b)));
                (Some(order), None)
            }
            Err(reason) => (None, remote.then(|| format!("Reranking skipped: {reason}"))),
        }
    }

    async fn local_rerank(
        &self,
        io: &dyn ProviderIo,
        identity: &RerankIdentity,
        query: &str,
        documents: &[String],
    ) -> Option<Vec<f64>> {
        let catalog = self
            .rpc(io, "models.list", json!({}), identity, 1500)
            .await?;
        let lane = crate::retrieval::hybrid::pin_reranker(&catalog)?;
        let body = self.rpc(io, "rerank.score", json!({
            "model":"gte-reranker-modernbert-base-f32", "query":query,"candidates":documents,
            "required_fingerprint":lane.fingerprint,"allow_equivalent":false,
            "max_queue_ms":100,"deadline_ms":1500,
        }), identity, 1500).await?;
        if body["fingerprint"] != lane.fingerprint
            || body["table_epoch"].as_i64() != Some(lane.table_epoch)
        {
            return None;
        }
        let scores: Vec<f64> = serde_json::from_value(body["scores"].clone()).ok()?;
        (scores.len() == documents.len() && scores.iter().all(|s| s.is_finite())).then_some(scores)
    }

    async fn remote_rerank(
        &self,
        io: &dyn ProviderIo,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<f64>, String> {
        let endpoint = text(&self.rerank, "endpoint").ok_or("invalid_endpoint")?;
        let (tei, endpoint) = endpoint
            .strip_prefix("tei+")
            .map_or((false, endpoint.as_str()), |s| (true, s));
        crate::retrieval::embedding_provider::validate_endpoint(endpoint)
            .map_err(|_| "invalid_endpoint")?;
        let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid_endpoint")?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err("invalid_endpoint".into());
        }
        let model = text(&self.rerank, "model").ok_or("validation")?;
        let body = if tei {
            json!({"query":query,"texts":documents})
        } else {
            json!({"model":model,"query":query,"documents":documents,"top_n":documents.len()})
        };
        let mut headers = vec![("content-type".into(), "application/json".into())];
        if let Some(key) = text(&self.rerank, "api_key") {
            headers.push(("authorization".into(), format!("Bearer {key}")));
        }
        let timeout = Duration::from_millis(
            self.rerank["timeout_ms"]
                .as_i64()
                .unwrap_or(1500)
                .clamp(50, 15000) as u64,
        );
        let request = HttpRequest {
            method: "POST".into(),
            url: format!("{}/rerank", endpoint.trim_end_matches('/')),
            headers,
            body: body.to_string().into_bytes(),
        };
        let response = tokio::time::timeout(timeout, io.post(request, timeout))
            .await
            .map_err(|_| "timeout")?
            .map_err(|_| "remote_error")?;
        if !(200..300).contains(&response.status) {
            return Err(format!("http_{}", response.status));
        }
        let body: Value = serde_json::from_slice(&response.body).map_err(|_| "invalid_reply")?;
        let rows = if tei {
            body.as_array()
        } else {
            body["results"].as_array()
        }
        .ok_or("invalid_reply")?;
        let mut scores = vec![None; documents.len()];
        for row in rows {
            let index = row["index"]
                .as_u64()
                .and_then(|i| usize::try_from(i).ok())
                .filter(|&i| i < scores.len())
                .ok_or("invalid_reply")?;
            let score = if tei {
                row["score"].as_f64()
            } else {
                row["relevance_score"].as_f64()
            }
            .filter(|s| s.is_finite())
            .ok_or("invalid_reply")?;
            if scores[index].replace(score).is_some() {
                return Err("invalid_reply".into());
            }
        }
        scores
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| "invalid_reply".into())
    }

    pub(crate) async fn query(
        &self,
        io: Arc<dyn ProviderIo>,
        registration: &Registration,
        scope: &StoreScope,
        identity: &RerankIdentity,
        text: &str,
    ) -> Option<QueryVector> {
        let provider = self.embedding["provider"].as_str()?;
        let vector = match provider {
            "openai-compatible" => self.openai(io, registration, scope, text).await,
            "synapse" => {
                let primary = self.synapse(io.clone(), registration, identity, text).await;
                if primary.is_some() {
                    primary
                } else if self.embedding["fallback_provider"] == "openai-compatible" {
                    self.openai(io, registration, scope, text).await
                } else {
                    None
                }
            }
            // The TypeScript local encoder needs an inference runtime which this
            // module does not ship. It must not relabel a remote vector as local.
            _ => None,
        }?;
        Some(QueryVector {
            values: vector,
            registration: registration.clone(),
        })
    }

    fn openai_config(&self, dimensions: usize) -> Option<OpenAiConfig> {
        let raw = &self.embedding;
        Some(OpenAiConfig {
            endpoint: raw["endpoint"].as_str()?.trim().into(),
            model: raw["model"].as_str()?.trim().into(),
            api_key: text(raw, "api_key"),
            input_type: text(raw, "input_type"),
            query_input_type: text(raw, "query_input_type"),
            query_instruction: raw
                .get("query_instruction")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .ok()?,
            document_prefix: text(raw, "document_prefix"),
            truncate: text(raw, "truncate"),
            max_input_tokens: raw["max_input_tokens"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0),
            dimensions: u32::try_from(dimensions).ok()?,
        })
    }

    async fn openai(
        &self,
        io: Arc<dyn ProviderIo>,
        registration: &Registration,
        scope: &StoreScope,
        text: &str,
    ) -> Option<Vec<f32>> {
        let config = self.openai_config(registration.dimensions)?;
        let generation = Generation(registration.generation as u64);
        let provider = RemoteEmbeddingProvider::new(
            ResolvedEmbeddingConfig::OpenAiCompatible(config),
            Some(Arc::new(HttpIo(io))),
            generation,
            Arc::new(AtomicU64::new(generation.0)),
        );
        let identity = provider.identity()?.clone();
        // model_id is the TS passage-provider fingerprint, not a model display name.
        if identity.fingerprint != registration.model_id {
            return None;
        }
        let context = RequestContext {
            contract_version: PARITY_CONTRACT_VERSION,
            route: RouteIdentity::from_authenticated_route(scope.clone(), InputOrigin::Core),
            invocation: InvocationId("ctx_search".into()),
            config_generation: generation,
            control: CallbackControl::new(chrono::Utc::now().timestamp_millis() + 30_000),
        };
        let request = EmbeddingRequest {
            identity,
            kind: EmbeddingInputKind::Query,
            inputs: vec![EmbeddingInput {
                text: text.into(),
                source: Provenance {
                    origin: InputOrigin::Core,
                    source_id: "ctx_search".into(),
                    source_revision: "query".into(),
                    content_hash: ContentHash(hash(text)),
                    generation: scope.generation,
                    observed_at_ms: 0,
                },
            }],
        };
        provider
            .embed_checked(&context, &request)
            .await
            .ok()?
            .vectors
            .into_iter()
            .next()
            .map(|v| v.values)
    }

    async fn rpc(
        &self,
        io: &dyn ProviderIo,
        method: &str,
        params: Value,
        identity: &RerankIdentity,
        timeout_ms: u64,
    ) -> Option<Value> {
        let reply = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            io.rpc(
                method,
                params,
                identity.clone(),
                timeout_ms,
                self.connection_file.as_deref(),
            ),
        )
        .await
        .ok()?
        .ok()?;
        let reply = unwrap_reply(&reply)?;
        Some(reply.clone())
    }

    async fn synapse(
        &self,
        io: Arc<dyn ProviderIo>,
        registration: &Registration,
        identity: &RerankIdentity,
        text: &str,
    ) -> Option<Vec<f32>> {
        let catalog = self
            .rpc(io.as_ref(), "models.list", json!({}), identity, 3000)
            .await?;
        // Synapse's model is selected by embedding-routing.ts, independently of
        // the configured fallback model.
        let model = "gte-modernbert-base-f16";
        let entries = catalog
            .get("models")
            .or_else(|| catalog.get("entries"))
            .unwrap_or(&catalog)
            .as_array()?;
        let entry = entries
            .iter()
            .find(|e| e["model"].as_str().or(e["model_id"].as_str()) == Some(model))?;
        if entry["certified"] == false || entry["status"] == "not_certified" {
            return None;
        }
        let fingerprint = entry["fingerprint"]
            .as_str()
            .or_else(|| entry["fingerprints"].get(0)?.as_str())?;
        let epoch = entry["table_epoch"]
            .as_i64()
            .or(entry["tableEpoch"].as_i64())
            .or(catalog["table_epoch"].as_i64())?;
        let max_tokens = entry["max_tokens"].as_u64()?;
        if max_tokens == 0
            || !matches!(
                entry["max_tokens_source"].as_str(),
                Some("runtime_bucket" | "worker_bucket" | "catalog" | "catalog_unloaded")
            )
        {
            return None;
        }
        let model_id = format!(
            "synapse:v1:{}",
            hash(&json!({"model":model,"fingerprint":fingerprint}).to_string())
        );
        if registration.model_id != model_id
            || registration.fingerprint != fingerprint
            || registration.table_epoch != epoch
        {
            return None;
        }
        let body = self.rpc(io.as_ref(), "embed.query", json!({
            "id":"query", "text":text,"purpose":"query","deadline_ms":3000,
            "model":model,"required_fingerprint":fingerprint,"required_epoch":epoch,"allow_equivalent":false,
        }), identity, 3000).await?;
        let row = body["vectors"].as_array()?.first()?;
        let digest = hash(text);
        if row["id"] != "query"
            || row["submitted_sha256"] != digest
            || row["content_sha256"] != digest
            || body["fingerprint"]
                .as_str()
                .or(body["served_fingerprint"].as_str())
                != Some(fingerprint)
            || body["table_epoch"].as_i64().or(body["tableEpoch"].as_i64()) != Some(epoch)
            || body["truncation_disclosures"].get(0).is_some_and(|v| {
                v["truncated"] != false || v["effective_tokens"].as_u64().is_none()
            })
        {
            return None;
        }
        let values: Vec<f32> = serde_json::from_value(row["vector"].clone()).ok()?;
        if values.len() != registration.dimensions
            || values.is_empty()
            || values.iter().any(|v| !v.is_finite())
            || entry
                .get("dims")
                .or_else(|| entry.get("dimensions"))
                .and_then(Value::as_u64)
                .is_some_and(|d| d != values.len() as u64)
            || body["dims"]
                .as_u64()
                .is_some_and(|d| d != values.len() as u64)
        {
            return None;
        }
        Some(values)
    }
}

#[derive(Clone)]
pub(crate) struct QueryVector {
    pub values: Vec<f32>,
    pub registration: Registration,
}

impl QueryVector {
    pub fn chunk_model(&self, settings: &Settings) -> Option<&str> {
        let max = settings.embedding["max_input_tokens"]
            .as_u64()
            .filter(|v| *v > 0)
            .unwrap_or(512);
        let truncate = if self
            .registration
            .model_id
            .starts_with("embedding-provider:")
        {
            settings.embedding["truncate"].as_str().unwrap_or("")
        } else {
            ""
        };
        let chunk = json!({"providerIdentity":self.registration.model_id,"chunkerVersion":2,"maxInputTokens":max,"truncate":truncate});
        let expected = format!(
            "{}:chunk:{}",
            self.registration.model_id,
            &hash(&chunk.to_string())[..16]
        );
        (self.registration.chunk_model_id == expected)
            .then_some(self.registration.chunk_model_id.as_str())
    }
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn merge_fields(target: &mut Value, source: &Value, keys: &[&str]) {
    for &key in keys {
        if let Some(value) = source.get(key).filter(|v| match key {
            "max_input_tokens" | "top_n" => v.as_u64().is_some_and(|v| v > 0),
            "timeout_ms" => v.as_i64().is_some(),
            "query_instruction" => v.is_string() || **v == Value::Bool(false),
            _ => v.is_string(),
        }) {
            target[key] = value.clone();
        }
    }
}

fn expand_user(mut value: Value, path: &Path) -> Value {
    match &mut value {
        Value::String(s) => {
            for (pattern, file) in [(r"\{env:([^}]*)\}", false), (r"\{file:([^}]*)\}", true)] {
                *s = regex::Regex::new(pattern)
                    .unwrap()
                    .replace_all(s, |caps: &regex::Captures<'_>| {
                        let name = caps[1].trim();
                        if !file {
                            return std::env::var(name).unwrap_or_default();
                        }
                        let candidate = if let Some(suffix) = name.strip_prefix("~/") {
                            crate::config::user_home_dir()
                                .unwrap_or_default()
                                .join(suffix)
                        } else {
                            path.parent().unwrap_or(Path::new(".")).join(name)
                        };
                        std::fs::read_to_string(candidate)
                            .unwrap_or_default()
                            .trim()
                            .to_owned()
                    })
                    .into_owned();
            }
        }
        Value::Object(object) => {
            for v in object.values_mut() {
                *v = expand_user(v.take(), path);
            }
        }
        Value::Array(array) => {
            for v in array {
                *v = expand_user(v.take(), path);
            }
        }
        _ => {}
    }
    value
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn unwrap_reply(value: &Value) -> Option<&Value> {
    if value.get("error").is_some() {
        return None;
    }
    Some(value.get("result").unwrap_or(value))
}

/// Injectable transport shared by search and future bounded embedding workers.
/// Implementations must never log bodies/keys, follow redirects, or retry POSTs.
#[subc_client_rs::async_trait]
pub trait ProviderIo: Send + Sync {
    async fn post(
        &self,
        request: HttpRequest,
        timeout: Duration,
    ) -> Result<HttpResponse, EmbeddingError>;
    async fn rpc(
        &self,
        method: &str,
        params: Value,
        identity: RerankIdentity,
        timeout_ms: u64,
        connection_file: Option<&Path>,
    ) -> Result<Value, String>;
}

pub(crate) struct NetworkIo {
    rpc: Option<Arc<dyn RerankClient>>,
}

impl NetworkIo {
    pub fn new(rpc: Option<Arc<dyn RerankClient>>) -> Self {
        Self { rpc }
    }
}

#[subc_client_rs::async_trait]
impl ProviderIo for NetworkIo {
    async fn post(
        &self,
        request: HttpRequest,
        timeout: Duration,
    ) -> Result<HttpResponse, EmbeddingError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|_| EmbeddingError::TransportUnavailable)?;
        let url = reqwest::Url::parse(&request.url).map_err(|_| EmbeddingError::EndpointBlocked)?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(EmbeddingError::EndpointBlocked);
        }
        crate::retrieval::embedding_provider::validate_endpoint(url.as_str())?;
        let mut post = client.post(request.url);
        for (key, value) in request.headers {
            post = post.header(key, value);
        }
        let response = post
            .body(request.body)
            .send()
            .await
            .map_err(|_| EmbeddingError::TransportUnavailable)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_owned())))
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|_| EmbeddingError::TransportUnavailable)?
            .to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }

    async fn rpc(
        &self,
        method: &str,
        params: Value,
        identity: RerankIdentity,
        timeout_ms: u64,
        connection_file: Option<&Path>,
    ) -> Result<Value, String> {
        let custom = connection_file.map(|path| crate::retrieval_store::RerankTransport {
            connection_file: path.to_owned(),
            target: crate::route_targets::RouteTargetConfig::default()
                .target(crate::route_targets::RegisteredRoute::SynapseRerank)
                .unwrap(),
        });
        let client = custom
            .as_ref()
            .map(|v| v as &dyn RerankClient)
            .or(self.rpc.as_deref())
            .ok_or("provider unavailable")?;
        client
            .call(
                "synapse",
                method,
                params,
                RerankCallOptions {
                    identity,
                    timeout_ms,
                    target_kind: "management_surface".into(),
                },
            )
            .await
    }
}

struct HttpIo(Arc<dyn ProviderIo>);
impl HttpTransport for HttpIo {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        _control: &'a CallbackControl,
        timeout: Duration,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, EmbeddingError>> + Send + 'a>,
    > {
        Box::pin(self.0.post(request, timeout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_cache_applies_ts_provider_trust_without_expanding_project_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let user_path = dir.path().join("user.json");
        let secret = dir.path().join("key");
        std::fs::write(&secret, "  fake-user-secret  ").unwrap();
        std::fs::create_dir(dir.path().join(".cortexkit")).unwrap();
        std::fs::write(&user_path,json!({
            "embedding":{"provider":"openai-compatible","endpoint":"https://trusted.invalid","model":"user","api_key":"{file:key}","query_instruction":"user recipe"},
            "rerank":{"provider":"remote","endpoint":"https://trusted.invalid","model":"hosted","api_key":"{file:key}","timeout_ms":16000,"top_n":20}
        }).to_string()).unwrap();
        std::fs::write(dir.path().join(".cortexkit/magic-context.json"),json!({
            "embedding":{"provider":"synapse","fallback_provider":"off","endpoint":"https://evil.invalid","model":"project-model","api_key":"{file:must-not-open}","query_instruction":"evil"},
            "rerank":{"provider":"remote","endpoint":"https://evil.invalid","api_key":"{env:HOME}","timeout_ms":50,"top_n":1}
        }).to_string()).unwrap();
        let mut cache = crate::config::ConfigCache::default();
        let settings = cache.search_providers_for_paths(&user_path, dir.path());
        assert_eq!(settings.embedding["provider"], "openai-compatible");
        assert_eq!(settings.embedding["endpoint"], "https://trusted.invalid");
        assert_eq!(settings.embedding["model"], "project-model");
        assert_eq!(settings.embedding["query_instruction"], "user recipe");
        assert_eq!(settings.embedding["api_key"], "{file:must-not-open}");
        assert_eq!(settings.rerank["endpoint"], "https://trusted.invalid");
        assert_eq!(settings.rerank["api_key"], "fake-user-secret");
        assert!(!format!("{settings:?}").contains("fake-user-secret"));
        let off = Settings::from_tiers(
            Some(
                &json!({"rerank":{"provider":"remote","endpoint":"https://trusted.invalid","model":"hosted"}}),
            ),
            Some(&json!({"rerank":{"provider":"off"}})),
            &user_path,
        );
        assert!(!off.rerank_enabled());
    }

    #[test]
    fn local_off_and_unknown_providers_never_invent_a_vector_identity() {
        for provider in ["local", "off", "unknown"] {
            let settings = Settings::from_tiers(
                Some(&json!({"embedding":{"provider":provider}})),
                None,
                Path::new("fixture.json"),
            );
            assert!(settings.openai_config(2).is_none());
        }
    }
}
