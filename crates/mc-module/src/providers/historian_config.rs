//! The historian's model chain, variants, timeout and output cap, resolved from
//! ck-mc's own config, with model context/output limits filled from Fusiform.
//!
//! Runner conversations resolve settings from the user's trusted config, with the precedence and
//! defaults the TypeScript plugin uses. The committed fixture
//! `testdata/historian-config-resolution.json` is generated from the TypeScript code
//! (`packages/plugin/src/shared/historian-config-resolution.test.ts`, which also
//! fails when the TypeScript side drifts from it), and the tests below compare
//! against it.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use subc_client_rs::{CallError, CallOptions, CloseRouteOptions, ConsumerOptions, SubcConsumer};
use subc_protocol::BindIdentity;

use crate::config_parity::{ConfigResolveRequest, CoreConfigResolver};
use crate::historian::HistorianModelLimits;
use crate::route_targets::{RegisteredRoute, RouteTargetConfig};
use mc_store::parity_schema_manifest::{CapabilityResult, Generation};

/// The per-attempt historian timeout when the config sets none. It must equal the
/// plugin's default, `DEFAULT_HISTORIAN_TIMEOUT_MS` in
/// packages/plugin/src/config/schema/magic-context.ts:20.
const DEFAULT_HISTORIAN_TIMEOUT_MS: u64 = 600_000;
const FUSIFORM_LIMITS_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const FUSIFORM_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);

/// The historian settings resolved for one harness.
#[derive(Debug, Clone, Default)]
pub(crate) struct ConfiguredHistorian {
    pub model_chain: Vec<String>,
    pub model_limits: BTreeMap<String, HistorianModelLimits>,
    pub model_variants: BTreeMap<String, String>,
    pub session_model_fallback: bool,
    pub timeout_ms: u64,
    pub max_output_tokens: Option<u32>,
}

impl ConfiguredHistorian {
    /// The settings as transform-request fields, in the shape the TypeScript plugin
    /// sends them (`historianFieldsFromConfig`,
    /// packages/plugin/src/shared/historian-config-resolution.test.ts:295-355).
    pub(crate) fn request_fields(&self) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("historian_model_chain".into(), json!(self.model_chain));
        // Only the known limits, as the plugin sends them: an unknown one is absent,
        // not null.
        let limits: Map<String, Value> = self
            .model_limits
            .iter()
            .map(|(model, limits)| {
                let mut entry = Map::new();
                if let Some(context) = limits.context {
                    entry.insert("context".into(), json!(context));
                }
                if let Some(input) = limits.input {
                    entry.insert("input".into(), json!(input));
                }
                if let Some(output) = limits.output {
                    entry.insert("output".into(), json!(output));
                }
                (model.clone(), Value::Object(entry))
            })
            .collect();
        fields.insert("historian_model_limits".into(), Value::Object(limits));
        fields.insert(
            "historian_model_variants".into(),
            json!(self.model_variants),
        );
        fields.insert("historian_timeout_ms".into(), json!(self.timeout_ms));
        if let Some(max_output_tokens) = self.max_output_tokens {
            fields.insert(
                "historian_max_output_tokens".into(),
                json!(max_output_tokens),
            );
        }
        fields
    }
}

/// Process-local Fusiform limits cache. A provider-scoped catalog read is used when
/// several configured models share a provider; a named read keeps single-model
/// lookups precise, including Fusiform's `no_coverage` and `retired` disclosures.
pub(crate) struct HistorianModelCatalog {
    connection_file: Option<PathBuf>,
    route_targets: RouteTargetConfig,
    cache: Mutex<HashMap<String, CachedModelLimits>>,
    fetch_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    warned: Mutex<HashSet<String>>,
}

#[derive(Clone)]
struct CachedModelLimits {
    fetched_at: Instant,
    reply: CatalogModelLimits,
}

#[derive(Clone, Default)]
struct CatalogModelLimits {
    limits: BTreeMap<String, HistorianModelLimits>,
    retired: BTreeSet<String>,
}

#[derive(Clone, Copy)]
enum CatalogLookup<'a> {
    Provider(&'a str),
    Model { provider: &'a str, model: &'a str },
}

impl CatalogLookup<'_> {
    fn cache_key(self) -> String {
        match self {
            Self::Provider(provider) => format!("provider:{provider}"),
            Self::Model { provider, model } => format!("model:{provider}/{model}"),
        }
    }

    fn arguments(self) -> Value {
        match self {
            Self::Provider(provider) => json!({
                "provider_id": provider,
                "fact_prefixes": ["limit."],
            }),
            Self::Model { provider, model } => json!({
                "provider_id": provider,
                "model_id": model,
                "fact_prefixes": ["limit."],
            }),
        }
    }
}

impl HistorianModelCatalog {
    pub(crate) fn new(
        connection_file: Option<PathBuf>,
        route_targets: RouteTargetConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            connection_file,
            route_targets,
            cache: Mutex::new(HashMap::new()),
            fetch_locks: Mutex::new(HashMap::new()),
            warned: Mutex::new(HashSet::new()),
        })
    }

    /// Fill limits only for the chain resolved from ck-mc config. Host-synchronized
    /// chains never call this method, so their request fields remain untouched.
    async fn populate(
        &self,
        configured: &mut ConfiguredHistorian,
        project_root: &Path,
        harness: &str,
    ) {
        let mut by_provider = BTreeMap::<String, Vec<String>>::new();
        for model in &configured.model_chain {
            let Some((provider, _)) = model.split_once('/') else {
                continue;
            };
            if provider.is_empty() {
                continue;
            }
            by_provider
                .entry(provider.to_string())
                .or_default()
                .push(model.clone());
        }

        for (provider, models) in by_provider {
            let lookup = if models.len() > 1 {
                CatalogLookup::Provider(&provider)
            } else {
                let Some((_, model_id)) = models[0].split_once('/') else {
                    continue;
                };
                CatalogLookup::Model {
                    provider: &provider,
                    model: model_id,
                }
            };
            let reply = self.lookup(lookup, project_root, harness).await;
            for model in models {
                if let Some(limits) = reply.as_ref().and_then(|reply| reply.limits.get(&model)) {
                    configured.model_limits.insert(model, limits.clone());
                } else if reply.is_some() {
                    let retired = reply
                        .as_ref()
                        .is_some_and(|reply| reply.retired.contains(&model));
                    self.warn_once(
                        format!("uncovered:{model}"),
                        &provider,
                        Some(&model),
                        if retired {
                            "model is retired in Fusiform; using empty limits"
                        } else {
                            "model has no published Fusiform limits; using empty limits"
                        },
                    );
                }
            }
        }
    }

    async fn lookup(
        &self,
        lookup: CatalogLookup<'_>,
        project_root: &Path,
        harness: &str,
    ) -> Option<CatalogModelLimits> {
        let key = lookup.cache_key();
        if self.connection_file.is_none() {
            self.warn_once(
                "missing-connection-file".to_string(),
                "fusiform",
                None,
                "no SubC connection file; using empty historian model limits",
            );
            return None;
        }

        let lock = {
            let mut locks = self.fetch_locks.lock().expect("model limit fetch locks");
            Arc::clone(
                locks
                    .entry(key.clone())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _guard = lock.lock().await;
        let stale = {
            let cache = self.cache.lock().expect("model limit cache");
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed() < FUSIFORM_LIMITS_CACHE_TTL {
                    return Some(entry.reply.clone());
                }
                Some(entry.reply.clone())
            } else {
                None
            }
        };

        match self.fetch(lookup, project_root, harness).await {
            Ok(reply) => {
                self.cache.lock().expect("model limit cache").insert(
                    key,
                    CachedModelLimits {
                        fetched_at: Instant::now(),
                        reply: reply.clone(),
                    },
                );
                Some(reply)
            }
            Err(error) => {
                self.warn_once(
                    format!("unavailable:{key}"),
                    match lookup {
                        CatalogLookup::Provider(provider)
                        | CatalogLookup::Model { provider, .. } => provider,
                    },
                    None,
                    &format!("Fusiform model-limit lookup failed ({error}); using empty limits"),
                );
                stale
            }
        }
    }

    async fn fetch(
        &self,
        lookup: CatalogLookup<'_>,
        _project_root: &Path,
        harness: &str,
    ) -> Result<CatalogModelLimits, String> {
        let connection_file = self
            .connection_file
            .as_ref()
            .ok_or_else(|| "no SubC connection file".to_string())?;
        let target = self
            .route_targets
            .target(RegisteredRoute::FusiformCatalog)
            .ok_or_else(|| "Fusiform catalog route is not registered".to_string())?;
        let identity = BindIdentity::new(harness, "ck-mc-historian-model-limits");
        let consumer_options = ConsumerOptions {
            handshake_timeout: FUSIFORM_LOOKUP_TIMEOUT,
            call_timeout: FUSIFORM_LOOKUP_TIMEOUT,
            ..ConsumerOptions::default()
        };
        let call = async {
            let consumer = SubcConsumer::connect(connection_file, consumer_options)
                .await
                .map_err(|error| error.to_string())?;
            let body = serde_json::to_vec(&json!({
                "name": "catalog.get",
                "arguments": lookup.arguments(),
            }))
            .map_err(|error| error.to_string())?;
            let response = consumer
                .call(
                    target.clone(),
                    identity.clone(),
                    body,
                    CallOptions {
                        timeout: FUSIFORM_LOOKUP_TIMEOUT,
                        route_retry_deadline: FUSIFORM_LOOKUP_TIMEOUT,
                        ..CallOptions::default()
                    },
                )
                .await;
            consumer
                .close_route(target, identity, CloseRouteOptions::default())
                .await;
            consumer.close().await;
            let bytes = match response {
                Ok(bytes) => bytes,
                Err(CallError::Module(body)) if body.code == "no_coverage" => {
                    return Ok(CatalogModelLimits::default());
                }
                Err(error) => return Err(error.to_string()),
            };
            let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            Ok(parse_catalog_limits(&value))
        };
        tokio::time::timeout(FUSIFORM_LOOKUP_TIMEOUT, call)
            .await
            .map_err(|_| "lookup timed out".to_string())?
    }

    fn warn_once(&self, key: String, provider: &str, model: Option<&str>, reason: &str) {
        let first = self
            .warned
            .lock()
            .expect("model limit warning set")
            .insert(key);
        if first {
            tracing::warn!(
                provider,
                model = model.unwrap_or(""),
                reason,
                "mc-module: historian model limits unavailable"
            );
        }
    }
}

/// Resolve the configured chain and optional session-model fallback, then add
/// context/output values from Fusiform before preparing a background historian call.
/// `session_model` is the model recorded during conversation setup.
pub(crate) async fn resolve_with_model_catalog(
    settings: &Value,
    harness: &str,
    session_model: Option<&str>,
    project_root: &Path,
    catalog: &HistorianModelCatalog,
) -> ConfiguredHistorian {
    let mut configured = resolve_for_session(settings, harness, session_model);
    catalog
        .populate(&mut configured, project_root, harness)
        .await;
    configured
}

fn parse_catalog_limits(value: &Value) -> CatalogModelLimits {
    let mut reply = CatalogModelLimits::default();
    if let Some(models) = value.get("models").and_then(Value::as_object) {
        for (model, facts) in models {
            let Some(facts) = facts.as_object() else {
                continue;
            };
            let context_wire = facts.get("limit.context").and_then(Value::as_u64);
            let context = context_wire.and_then(|tokens| usize::try_from(tokens).ok());
            let output_wire = facts.get("limit.output").and_then(Value::as_u64);
            let output_is_placeholder = context_wire
                .zip(output_wire)
                .is_some_and(|(context, output)| output >= context);
            let output = (!output_is_placeholder)
                .then_some(output_wire)
                .flatten()
                .and_then(|tokens| u32::try_from(tokens).ok());
            if context.is_some() || output.is_some() {
                // Fusiform serves alias facts under the alias model key; keeping that
                // key preserves the configured chain's own provider/model identity.
                reply.limits.insert(
                    model.clone(),
                    HistorianModelLimits {
                        context,
                        input: None,
                        output,
                    },
                );
            }
        }
    }
    if let Some(retired) = value.get("retired").and_then(Value::as_array) {
        for entry in retired {
            if let Some(model) = entry.get("model").and_then(Value::as_str) {
                reply.retired.insert(model.to_string());
            }
        }
    }
    reply
}

/// The value as a trimmed string, or `None` when it is not a string or is blank; the
/// plugin reads every model and qualifier this way (`readString`,
/// packages/plugin/src/shared/model-resolution.ts:20-24).
fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The value when it is a JSON object; an array or scalar counts as absent, as in the
/// plugin's `asRecord` (packages/plugin/src/shared/model-resolution.ts:14-18).
fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

/// One configured attempt: the model and its OpenCode variant or Pi thinking level.
#[derive(Debug, Clone, PartialEq)]
struct Attempt {
    model: String,
    qualifier: Option<String>,
}

/// One configured model entry: either a `provider/model` string, or an object with a
/// `model` string and an optional qualifier under `qualifier_key`. Anything else, or
/// a blank model, is no entry (`normalizeModelEntry`,
/// packages/plugin/src/shared/model-resolution.ts:43-61).
fn normalize(entry: &Value, qualifier_key: &str) -> Option<Attempt> {
    if entry.is_string() {
        return text(Some(entry)).map(|model| Attempt {
            model,
            qualifier: None,
        });
    }
    let entry = entry.as_object()?;
    Some(Attempt {
        model: text(entry.get("model"))?,
        qualifier: text(entry.get(qualifier_key)),
    })
}

/// Whether a model reads as `provider/model`: text on both sides of the first slash
/// (`isValidModelReference`, packages/plugin/src/shared/model-resolution.ts:63-66).
/// The plugin checks only fallbacks this way; a malformed primary is kept.
fn valid_reference(model: &str) -> bool {
    model
        .find('/')
        .is_some_and(|slash| slash > 0 && slash < model.len() - 1)
}

/// The primary and fallback attempts configured under `historian.<harness>`, resolved
/// as `resolveHistorianModel` does (packages/plugin/src/shared/model-resolution.ts:112-128).
fn attempts(settings: &Value, harness: &str) -> (Option<Attempt>, Vec<Attempt>) {
    let historian = record(settings.get("historian"));
    // OMP falls back to the Pi block when its own is absent or null, as
    // `resolveHarnessBlock` does (packages/plugin/src/shared/model-resolution.ts:30-36).
    let selected = match harness {
        "omp" => historian
            .and_then(|h| h.get("omp"))
            .filter(|v| !v.is_null())
            .or_else(|| historian.and_then(|h| h.get("pi"))),
        _ => historian.and_then(|h| h.get(harness)),
    };
    let Some(block) = record(selected) else {
        return (None, Vec::new());
    };
    let qualifier_key = if matches!(harness, "opencode" | "broca") {
        "variant"
    } else {
        "thinking_level"
    };
    // The primary's qualifier is its own, else the one written beside it in the block
    // (`resolvePrimaryEntry`, packages/plugin/src/shared/model-resolution.ts:92-101).
    let primary = block
        .get("model")
        .and_then(|entry| normalize(entry, qualifier_key))
        .map(|mut attempt| {
            attempt.qualifier = attempt.qualifier.or_else(|| text(block.get(qualifier_key)));
            attempt
        });
    // Fallbacks are one value or a list, kept in declaration order, without malformed
    // references, and deduplicated by model plus qualifier, so one model with two
    // qualifiers stays two attempts (`resolveFallbackEntries`,
    // packages/plugin/src/shared/model-resolution.ts:77-90).
    let mut fallbacks: Vec<Attempt> = Vec::new();
    if let Some(value) = block.get("fallback_models") {
        let values = value
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(std::slice::from_ref(value));
        for value in values {
            if let Some(attempt) = normalize(value, qualifier_key) {
                if valid_reference(&attempt.model) && !fallbacks.contains(&attempt) {
                    fallbacks.push(attempt);
                }
            }
        }
    }
    (primary, fallbacks)
}

/// Resolve the configured historian chain, variants, timeout and output cap from trusted settings.
/// Per-model limits start empty and are filled by `resolve_with_model_catalog` when
/// Fusiform is available.
///
/// `settings` is the validated config object: `historian.<harness>.model`,
/// `historian.<harness>.fallback_models`, the OpenCode/Broca `variant` or Pi/OMP
/// `thinking_level`, `historian.maxTokens` and `historian_timeout_ms`.
///
/// The chain is the primary followed by the fallbacks, each model once in its first
/// position. That is the chain the OpenCode bridge sent with `state_sync`
/// (packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter.ts:737-743,764)
/// and the one `historianFieldsFromConfig` builds
/// (packages/plugin/src/shared/historian-config-resolution.test.ts:295-317). A
/// model's variant is the qualifier of its first attempt, so a qualifier written only
/// on a later attempt of the same model is dropped (same file, :311-316).
///
/// This synchronous resolver builds the configured chain and its empty limit entries.
pub(crate) fn resolve(settings: &Value, harness: &str) -> ConfiguredHistorian {
    // Both OpenCode hosts read the `opencode` block, as the dreamer's model
    // resolution does (dream_runner.rs `resolve_task_models`).
    let harness = if harness == "opencode2" {
        "opencode"
    } else {
        harness
    };
    let (primary, fallbacks) = attempts(settings, harness);
    let mut resolved = ConfiguredHistorian {
        // The configured timeout, else the plugin's default, as the plugin's historian
        // sampler reads it (packages/plugin/src/hooks/magic-context/hook.ts:323).
        timeout_ms: settings
            .get("historian_timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_HISTORIAN_TIMEOUT_MS),
        // `historian.maxTokens` caps the output; unset stays unset and the module
        // applies its own default, as the plugin passes it
        // (packages/plugin/src/hooks/magic-context/host-runner/bridge-deps.ts:42).
        max_output_tokens: settings
            .pointer("/historian/maxTokens")
            .and_then(Value::as_u64)
            .and_then(|tokens| u32::try_from(tokens).ok()),
        ..ConfiguredHistorian::default()
    };
    for attempt in primary.into_iter().chain(fallbacks) {
        if resolved.model_chain.contains(&attempt.model) {
            continue;
        }
        if let Some(qualifier) = attempt.qualifier {
            resolved
                .model_variants
                .insert(attempt.model.clone(), qualifier);
        }
        resolved
            .model_limits
            .insert(attempt.model.clone(), HistorianModelLimits::default());
        resolved.model_chain.push(attempt.model);
    }
    resolved
}

/// Append a valid, non-duplicate session model after configured fallbacks only when no
/// primary model is configured.
pub(crate) fn resolve_for_session(
    settings: &Value,
    harness: &str,
    session_model: Option<&str>,
) -> ConfiguredHistorian {
    let mut resolved = resolve(settings, harness);
    let harness = if harness == "opencode2" {
        "opencode"
    } else {
        harness
    };
    let (primary, _) = attempts(settings, harness);
    if primary.is_none() {
        if let Some(model) = session_model
            .map(str::trim)
            .filter(|model| valid_reference(model))
            .filter(|model| {
                !resolved
                    .model_chain
                    .iter()
                    .any(|configured| configured == model)
            })
        {
            resolved
                .model_limits
                .insert(model.to_owned(), HistorianModelLimits::default());
            resolved.model_chain.push(model.to_owned());
            resolved.session_model_fallback = true;
        }
    }
    resolved
}

/// The user's trusted effective settings for `project_root`, loaded the way the
/// TypeScript plugin loads them (user tier with the selected profile, project tier
/// under the trust rules; model choice stays user-tier only). A config that needed
/// repair still yields its recovered settings, as the plugin runs on them too. When
/// no config can be loaded at all the result is empty; a caller may separately supply
/// the current session model as an explicit last-resort historian candidate.
pub(crate) fn trusted_settings(resolver: &dyn CoreConfigResolver, project_root: &Path) -> Value {
    match resolver.resolve(&ConfigResolveRequest {
        user_config_path: String::new(),
        project_root: project_root.to_string_lossy().into_owned(),
        generation: Generation(0),
    }) {
        CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
            value.settings
        }
        CapabilityResult::Unavailable { reason } => {
            tracing::warn!(
                code = %reason.code,
                "mc-module: historian config unavailable; resolving no historian models"
            );
            json!({})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HandlerOutcome, ModuleHandler};
    use subc_client_rs::{BindDecision, RequestCtx, RouteBindRequest};
    use subc_daemon::{
        serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth,
    };
    use subc_protocol::RouteTarget;
    use subc_transport::{
        generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
    };
    use tokio::net::TcpListener;

    const FIXTURE: &str = include_str!("../../testdata/historian-config-resolution.json");

    struct FakeFusiform {
        requests: Arc<Mutex<Vec<Value>>>,
    }

    #[subc_client_rs::async_trait]
    impl ModuleHandler for FakeFusiform {
        async fn on_bind(&self, request: &RouteBindRequest) -> BindDecision {
            assert_eq!(
                request.target,
                RouteTarget::ToolProvider {
                    module_id: "fusiform".to_string()
                }
            );
            BindDecision::accept()
        }

        async fn handle(&self, _ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
            let request: Value = serde_json::from_slice(&body).unwrap();
            self.requests.lock().unwrap().push(request.clone());
            assert_eq!(request["name"], "catalog.get");
            let arguments = &request["arguments"];
            match arguments["provider_id"].as_str().unwrap() {
                "google" => HandlerOutcome::Response(
                    serde_json::to_vec(&json!({
                        "models": {
                            "google/main": {"limit.context": 200_000, "limit.output": 20_000},
                            "google/alias": {"limit.context": 200_000, "limit.output": 20_000}
                        },
                        "aliased": [{
                            "model": "google/alias",
                            "target_provider_id": "google",
                            "target_model_id": "main"
                        }]
                    }))
                    .unwrap(),
                ),
                "placeholder" => HandlerOutcome::Response(
                    serde_json::to_vec(&json!({
                        "models": {
                            "placeholder/model": {"limit.context": 200_000, "limit.output": 200_000}
                        }
                    }))
                    .unwrap(),
                ),
                "unpublished" => HandlerOutcome::Response(
                    serde_json::to_vec(&json!({
                        "models": {"unpublished/model": {"limit.context": 200_000}}
                    }))
                    .unwrap(),
                ),
                "retired" => HandlerOutcome::Response(
                    serde_json::to_vec(&json!({
                        "models": {},
                        "retired": [{"model": "retired/old", "retired_at_ms": 10}]
                    }))
                    .unwrap(),
                ),
                "uncovered" => HandlerOutcome::Error {
                    code: "no_coverage".to_string(),
                    message: "unknown provider/model".to_string(),
                },
                provider => panic!("unexpected provider lookup: {provider}"),
            }
        }
    }

    struct FakeFusiformRoute {
        connection_file: PathBuf,
        requests: Arc<Mutex<Vec<Value>>>,
        module: tokio::task::JoinHandle<Result<(), subc_client_rs::SubcModuleError>>,
        daemon: tokio::task::JoinHandle<Result<(), subc_daemon::ServerError>>,
        _directory: tempfile::TempDir,
    }

    impl Drop for FakeFusiformRoute {
        fn drop(&mut self) {
            self.module.abort();
            self.daemon.abort();
        }
    }

    impl FakeFusiformRoute {
        async fn start() -> Self {
            let directory = tempfile::tempdir().unwrap();
            assert_eq!(
                mc_store::private_permissions::tighten_directory(directory.path(), true).failures,
                0
            );
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let connection_file = directory.path().join("subc-connection.json");
            let connection = ConnectionInfo {
                schema: SCHEMA_VERSION,
                wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                endpoints: vec![Endpoint {
                    host: "127.0.0.1".into(),
                    port: listener.local_addr().unwrap().port(),
                }],
                key: generate_key().unwrap(),
                daemon_id: generate_daemon_id().unwrap(),
                pid: std::process::id(),
                daemon_ver: "0.39.0".into(),
            };
            write_atomic(&connection_file, &connection).unwrap();
            let connected = ConnectedClients::new();
            let control = Arc::new(
                ControlHandler::new(Arc::new(Registry::default()))
                    .with_connected_clients(connected.clone()),
            );
            let router = Arc::new(Router::with_control_handler(control));
            let auth = ServerAuth::new(connection.key, connection.daemon_id, connection.daemon_ver)
                .with_connected_clients(connected);
            let daemon = tokio::spawn(serve_listener(listener, router, auth));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let handler = FakeFusiform {
                requests: Arc::clone(&requests),
            };
            let (_, serve) = subc_client_rs::serve_with_handle(
                &connection_file,
                crate::manifest("fusiform"),
                handler,
            )
            .await
            .unwrap();
            let module = tokio::spawn(serve);
            Self {
                connection_file,
                requests,
                module,
                daemon,
                _directory: directory,
            }
        }
    }

    /// Every case of the TypeScript-generated matrix resolves to exactly the fields
    /// the plugin resolves for it.
    #[test]
    fn configured_historian_matches_typescript_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "the matrix must not shrink unnoticed");
        for case in cases {
            let resolved = resolve(&case["config"], case["harness"].as_str().unwrap());
            assert_eq!(
                Value::Object(resolved.request_fields()),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }

    /// The fallback models follow the primary in the resolved chain.
    #[test]
    fn configured_historian_chain_keeps_fallbacks() {
        let settings = json!({"historian":{"opencode":{
            "model":"fixture-a/main",
            "fallback_models":["fixture-b/fallback",{"model":"fixture-c/second","variant":"max"}]}}});
        let resolved = resolve(&settings, "opencode");
        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback", "fixture-c/second"]
        );
        assert_eq!(
            resolved
                .model_variants
                .get("fixture-c/second")
                .map(String::as_str),
            Some("max")
        );
    }

    #[test]
    fn broca_historian_block_resolves_variant_and_fallback_chain() {
        let settings = json!({"historian":{"broca":{
            "model":"fixture-a/main",
            "variant":"high",
            "fallback_models":[{"model":"fixture-b/fallback","variant":"medium"}]
        }}});

        let resolved = resolve(&settings, "broca");
        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback"]
        );
        assert_eq!(
            resolved.model_variants,
            BTreeMap::from([
                ("fixture-a/main".into(), "high".into()),
                ("fixture-b/fallback".into(), "medium".into()),
            ])
        );
    }

    #[test]
    fn broca_without_historian_block_falls_back_to_session_model() {
        let resolved = resolve_for_session(&json!({}), "broca", Some("provider/session-model"));

        assert_eq!(resolved.model_chain, ["provider/session-model"]);
        assert!(resolved.session_model_fallback);
        assert!(resolved.model_variants.is_empty());
    }

    #[test]
    fn session_model_fallback_follows_configured_fallbacks_without_a_primary() {
        let settings = json!({"historian":{"broca":{
            "fallback_models":["configured/first", "configured/second"]
        }}});
        let resolved = resolve_for_session(&settings, "broca", Some("provider/session-model"));

        assert_eq!(
            resolved.model_chain,
            [
                "configured/first",
                "configured/second",
                "provider/session-model"
            ]
        );
        assert!(resolved.session_model_fallback);
    }

    #[test]
    fn opencode_configured_chain_never_appends_session_model() {
        let settings = json!({"historian":{"opencode":{
            "model":"fixture-a/main",
            "fallback_models":["fixture-b/fallback"]
        }}});
        let resolved = resolve_for_session(&settings, "opencode", Some("provider/session-model"));

        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback"]
        );
        assert!(!resolved.session_model_fallback);
    }

    #[test]
    fn omp_still_falls_back_to_pi_block() {
        let settings = json!({"historian":{"pi":{
            "model":"fixture-a/pi",
            "thinking_level":"high",
            "fallback_models":["fixture-b/fallback"]
        }}});
        let resolved = resolve_for_session(&settings, "omp", Some("provider/session-model"));

        assert_eq!(resolved.model_chain, ["fixture-a/pi", "fixture-b/fallback"]);
        assert_eq!(
            resolved
                .model_variants
                .get("fixture-a/pi")
                .map(String::as_str),
            Some("high")
        );
        assert!(!resolved.session_model_fallback);
    }

    #[test]
    fn configured_block_always_wins_over_session_model() {
        let settings = json!({"historian":{"broca":{
            "model":"configured/model",
            "fallback_models":["configured/fallback"]
        }}});
        let resolved = resolve_for_session(&settings, "broca", Some("session/model"));

        assert_eq!(
            resolved.model_chain,
            ["configured/model", "configured/fallback"]
        );
        assert!(!resolved.session_model_fallback);
    }

    #[test]
    fn session_model_fallback_still_obeys_runner_run_limits() {
        let resolved = resolve_for_session(&json!({}), "broca", Some("opencode/free"));
        let mut chain = resolved.model_chain;
        let limits = crate::runner_limits::RunnerLimits {
            max_steps: true,
            max_output_tokens: true,
            no_tools: true,
        };

        let refusal = limits.historian_chain("session-model-fallback", &mut chain);

        assert!(resolved.session_model_fallback);
        assert!(refusal.is_err());
        assert!(chain.is_empty());
    }

    #[test]
    fn opencode2_reads_the_opencode_block() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            if case["harness"] == "opencode" {
                assert_eq!(
                    Value::Object(resolve(&case["config"], "opencode2").request_fields()),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
        }
    }

    /// The loader reads the user's config file under a throwaway home, applies the
    /// trust rules (a project file cannot choose the model), and the resolution runs
    /// on what it returns.
    #[test]
    fn trusted_settings_read_user_config_and_ignore_project_models() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let xdg = root.path().join("xdg");
        let project = root.path().join("project");
        std::fs::create_dir_all(xdg.join("cortexkit")).unwrap();
        std::fs::create_dir_all(project.join(".cortexkit")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            xdg.join("cortexkit/magic-context.jsonc"),
            r#"{
                // user tier
                "historian_timeout_ms": 90000,
                "historian": {"maxTokens": 12000, "opencode": {"model": {"model": "fixture-a/main", "variant": "high"}, "fallback_models": ["fixture-b/fallback"]}}
            }"#,
        )
        .unwrap();
        std::fs::write(
            project.join(".cortexkit/magic-context.jsonc"),
            r#"{"historian": {"opencode": {"model": "fixture-evil/project"}}}"#,
        )
        .unwrap();
        let resolver = crate::config_parity::TrustedConfigResolver::new(
            home,
            BTreeMap::from([("XDG_CONFIG_HOME".to_string(), xdg.display().to_string())]),
        );
        let settings = trusted_settings(&resolver, &project);
        let resolved = resolve(&settings, "opencode");
        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback"]
        );
        assert_eq!(
            resolved
                .model_variants
                .get("fixture-a/main")
                .map(String::as_str),
            Some("high")
        );
        assert_eq!(resolved.timeout_ms, 90_000);
        assert_eq!(resolved.max_output_tokens, Some(12_000));
    }

    #[test]
    fn trusted_settings_without_any_config_resolve_no_models() {
        let root = tempfile::tempdir().unwrap();
        let resolver = crate::config_parity::TrustedConfigResolver::new(
            root.path().join("home"),
            BTreeMap::from([(
                "XDG_CONFIG_HOME".to_string(),
                root.path().join("xdg").display().to_string(),
            )]),
        );
        let settings = trusted_settings(&resolver, &root.path().join("project"));
        let resolved = resolve(&settings, "opencode");
        assert!(resolved.model_chain.is_empty());
        assert_eq!(resolved.timeout_ms, DEFAULT_HISTORIAN_TIMEOUT_MS);
        assert_eq!(resolved.max_output_tokens, None);
    }

    #[tokio::test]
    async fn fusiform_model_limits_cover_aliases_placeholder_output_and_no_coverage() {
        let route = FakeFusiformRoute::start().await;
        let catalog = HistorianModelCatalog::new(
            Some(route.connection_file.clone()),
            RouteTargetConfig::default(),
        );
        let settings = json!({"historian":{"opencode":{
            "model":"google/main",
            "fallback_models":[
                "google/alias",
                "placeholder/model",
                "unpublished/model",
                "retired/old",
                "uncovered/model"
            ]
        }}});

        let resolved = resolve_with_model_catalog(
            &settings,
            "opencode",
            None,
            Path::new("/tmp/historian-limits-project"),
            &catalog,
        )
        .await;
        assert_eq!(resolved.model_limits["google/main"].context, Some(200_000));
        assert_eq!(resolved.model_limits["google/main"].output, Some(20_000));
        assert_eq!(resolved.model_limits["google/alias"].context, Some(200_000));
        assert_eq!(resolved.model_limits["google/alias"].output, Some(20_000));
        assert_eq!(
            resolved.model_limits["placeholder/model"].context,
            Some(200_000)
        );
        assert_eq!(resolved.model_limits["placeholder/model"].output, None);
        assert_eq!(
            resolved.model_limits["unpublished/model"].context,
            Some(200_000)
        );
        assert_eq!(resolved.model_limits["unpublished/model"].output, None);
        for model in ["retired/old", "uncovered/model"] {
            let limit = &resolved.model_limits[model];
            assert_eq!(limit.context, None);
            assert_eq!(limit.input, None);
            assert_eq!(limit.output, None);
        }

        let requests = route.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 5, "catalog route calls: {requests:?}");
        let google = requests
            .iter()
            .find(|request| request["arguments"]["provider_id"] == "google")
            .unwrap();
        assert_eq!(google["arguments"]["fact_prefixes"], json!(["limit."]));
        assert!(google["arguments"].get("model_id").is_none());
        let placeholder = requests
            .iter()
            .find(|request| request["arguments"]["provider_id"] == "placeholder")
            .unwrap();
        assert_eq!(placeholder["arguments"]["model_id"], "model");
        let retired = requests
            .iter()
            .find(|request| request["arguments"]["provider_id"] == "retired")
            .unwrap();
        assert_eq!(retired["arguments"]["model_id"], "old");
        let uncovered = requests
            .iter()
            .find(|request| request["arguments"]["provider_id"] == "uncovered")
            .unwrap();
        assert_eq!(uncovered["arguments"]["model_id"], "model");

        let cached = resolve_with_model_catalog(
            &settings,
            "opencode",
            None,
            Path::new("/tmp/historian-limits-project"),
            &catalog,
        )
        .await;
        assert_eq!(cached.request_fields(), resolved.request_fields());
        assert_eq!(route.requests.lock().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn broca_session_model_fallback_gets_catalog_limits() {
        let route = FakeFusiformRoute::start().await;
        let catalog = HistorianModelCatalog::new(
            Some(route.connection_file.clone()),
            RouteTargetConfig::default(),
        );

        let resolved = resolve_with_model_catalog(
            &json!({}),
            "broca",
            Some("google/main"),
            Path::new("/tmp/historian-limits-project"),
            &catalog,
        )
        .await;

        assert_eq!(resolved.model_chain, ["google/main"]);
        assert!(resolved.session_model_fallback);
        assert_eq!(resolved.model_limits["google/main"].context, Some(200_000));
        assert_eq!(resolved.model_limits["google/main"].output, Some(20_000));
    }

    #[tokio::test]
    async fn a_fetched_200k_window_first_model_gets_a_chunk_that_fits() {
        let route = FakeFusiformRoute::start().await;
        let catalog = HistorianModelCatalog::new(
            Some(route.connection_file.clone()),
            RouteTargetConfig::default(),
        );
        let settings = json!({"historian":{"opencode":{
            "model":"google/main",
            "fallback_models":["google/alias"]
        }}});
        let resolved = resolve_with_model_catalog(
            &settings,
            "opencode",
            None,
            Path::new("/tmp/historian-limits-project"),
            &catalog,
        )
        .await;
        assert_eq!(
            resolved.model_chain.first().map(String::as_str),
            Some("google/main")
        );
        assert_eq!(resolved.model_limits["google/main"].context, Some(200_000));
        crate::historian_chunk::assert_fetched_200k_window_sizes_chunk(
            "google/main",
            resolved.model_limits,
        );
    }

    #[tokio::test]
    async fn fusiform_unreachable_keeps_the_chain_and_empty_model_limits() {
        let route = FakeFusiformRoute::start().await;
        route.module.abort();
        route.daemon.abort();
        let catalog = HistorianModelCatalog::new(
            Some(route.connection_file.clone()),
            RouteTargetConfig::default(),
        );
        let settings = json!({"historian":{"opencode":{"model":"google/main"}}});
        let resolved = resolve_with_model_catalog(
            &settings,
            "opencode",
            None,
            Path::new("/tmp/historian-limits-project"),
            &catalog,
        )
        .await;
        assert_eq!(resolved.model_chain, ["google/main"]);
        let limit = &resolved.model_limits["google/main"];
        assert_eq!(limit.context, None);
        assert_eq!(limit.input, None);
        assert_eq!(limit.output, None);
    }
}
