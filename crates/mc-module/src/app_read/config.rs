//! Effective config, with secrets removed, and a rate-limited embedding probe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{allow, named, named_detail, opt_str, row_reply, AppReadContext};
use crate::config_parity::CoreConfigResolver;

const READ_OP: &str = "config.read";
const PROBE_OP: &str = "config.embedding_probe";
const PROBE_WINDOW_MS: i64 = 60_000;

pub trait ProbeTransport: Send + Sync {
    fn send(&self, url: &str, body: &[u8], authorization: Option<&str>) -> ProbeHttp;
}

pub struct ProbeHttp {
    pub status: u16,
    pub body: Vec<u8>,
    pub error: Option<String>,
}

pub fn read(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    let started = Instant::now();
    if let Err(refusal) = allow(params, &["project"], "params") {
        return refusal;
    }
    let project = match opt_str(params, "project", "params") {
        Ok(project) => project,
        Err(refusal) => return refusal,
    };
    let (user_path, project_file, resolved) = config_inputs(ctx, project.as_deref());
    let user = read_layer(&user_path);
    let project_layer = project_file.as_ref().map(|path| read_layer(path));
    let mut merged = json!({});
    if let Some(value) = user.value.as_ref() {
        merged = value.clone();
    }
    if let Some(layer) = project_layer.as_ref().and_then(|layer| layer.value.clone()) {
        merge(&mut merged, &layer);
    }
    let (settings, runtime) = match effective(ctx, &user_path, project_file.as_deref()) {
        Ok(settings) => settings,
        Err(refusal) => return refusal,
    };
    retain_unknown(&mut merged, &crate::config_parity::schema()["config"]);
    merge(&mut merged, &settings);
    merge(&mut merged, &runtime);
    redact(&mut merged, false);
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The configuration read exceeded its time budget.",
        );
    }
    let mut built_in = crate::config_parity::schema_parse(
        &crate::config_parity::schema()["config"],
        Some(&json!({})),
        "",
    )
    .0
    .unwrap_or_else(|| json!({}));
    merge(
        &mut built_in,
        &runtime_projection(crate::config::McModuleConfig::default()),
    );
    let sources = json!([
        {"layer": "built-in", "loaded": true, "error": null, "keys": built_in.as_object().unwrap().keys().collect::<Vec<_>>()},
        layer_source("user", &user),
        match &project_layer {
            Some(layer) => layer_source("project", layer),
            None => json!({"layer": "project", "loaded": false, "error": null, "keys": []}),
        }
    ]);
    row_reply(
        READ_OP,
        None,
        ctx.now_ms(),
        None,
        json!({
            "project_resolved": resolved,
            "config": merged,
            "sources": sources,
        }),
    )
}

pub fn probe(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    if let Err(refusal) = allow(params, &["project"], "params") {
        return refusal;
    }
    let project = match opt_str(params, "project", "params") {
        Ok(project) => project,
        Err(refusal) => return refusal,
    };
    let (user_path, project_file) = config_paths(ctx, project.as_deref());
    let (settings, _) = match effective(ctx, &user_path, project_file.as_deref()) {
        Ok(settings) => settings,
        Err(refusal) => return refusal,
    };
    let embedding = settings.get("embedding").cloned().unwrap_or(Value::Null);
    let provider = embedding
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("off");
    if provider == "off" || provider == "local" || embedding.is_null() {
        return named(
            "embedding_disabled",
            "Embeddings are off or local, so there is no remote endpoint to probe.",
        );
    }
    let endpoint = embedding
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model = embedding.get("model").and_then(Value::as_str).unwrap_or("");
    if endpoint.is_empty() || model.is_empty() {
        return named(
            "embedding_disabled",
            "Embeddings are off or local, so there is no remote endpoint to probe.",
        );
    }
    let key = project
        .filter(|identity| project_is_visible(ctx, identity))
        .unwrap_or_else(|| "user".to_string());
    if let Some(retry) = probe_admission(&key, ctx.now_ms()) {
        return named_detail(
            "probe_rate_limited",
            "An embedding probe for this project already ran recently.",
            json!({"retry_after_ms": retry}),
        );
    }
    let started = Instant::now();
    let body = serde_json::to_vec(&json!({"model": model, "input": "ping"})).unwrap_or_default();
    let authorization = embedding
        .get("api_key")
        .and_then(Value::as_str)
        .map(|key| format!("Bearer {key}"));
    let url = format!("{endpoint}/embeddings");
    let http = match ctx.probe() {
        Some(transport) => transport.send(&url, &body, authorization.as_deref()),
        None => curl_probe(&url, &body, authorization.as_deref()),
    };
    let latency = started.elapsed().as_millis() as i64;
    let (reachable, dimensions, error) = interpret(&http);
    let mut fields = Map::new();
    fields.insert("configured".into(), json!(true));
    fields.insert("provider".into(), json!(provider));
    fields.insert("model".into(), json!(model));
    fields.insert("reachable".into(), json!(reachable));
    fields.insert("latency_ms".into(), json!(latency));
    fields.insert("dimensions".into(), dimensions);
    fields.insert("error".into(), error);
    super::envelope::reply(PROBE_OP, ctx.now_ms(), fields)
}

pub(super) fn dream_schedules(ctx: &AppReadContext, project: Option<&str>) -> Map<String, Value> {
    let (user_path, project_file) = config_paths(ctx, project);
    let mut schedules = Map::new();
    if let Ok((settings, _)) = effective(ctx, &user_path, project_file.as_deref()) {
        collect_schedules(&settings, &mut schedules);
    }
    schedules
}

fn collect_schedules(value: &Value, into: &mut Map<String, Value>) {
    for task in super::dreamer::TASKS {
        let crate::dream_runner::TaskModels {
            schedule,
            primary: _,             // Model selections are not part of a schedule row.
            fallbacks: _,           // Model fallbacks are not part of a schedule row.
            timeout_minutes: _,     // Completion timeouts do not change the schedule.
            promotion_threshold: _, // Promotion thresholds do not change the schedule.
        } = crate::dream_runner::resolve_task_models(value, "opencode", task);
        if let Some(schedule) = schedule {
            into.insert(task.to_string(), json!(schedule));
        }
    }
}

pub(super) fn project_is_visible(ctx: &AppReadContext, project: &str) -> bool {
    ctx.config_files()
        .and_then(|(_, project)| project)
        .is_some()
        || resolve_root(ctx, project).is_some()
}

struct Layer {
    loaded: bool,
    error: Option<String>,
    keys: Vec<String>,
    value: Option<Value>,
}

fn read_layer(path: &Path) -> Layer {
    match std::fs::read_to_string(path) {
        Err(error) => Layer {
            loaded: false,
            error: (error.kind() != std::io::ErrorKind::NotFound)
                .then(|| "Config file could not be read.".to_string()),
            keys: Vec::new(),
            value: None,
        },
        Ok(raw) => match serde_json::from_str::<Value>(&crate::config::strip_jsonc(
            raw.trim_start_matches('\u{feff}'),
        )) {
            Ok(Value::Object(object)) => Layer {
                loaded: true,
                error: None,
                keys: object.keys().cloned().collect(),
                value: Some(Value::Object(object)),
            },
            Ok(_) => Layer {
                loaded: false,
                error: Some("Config file must be a JSON object.".into()),
                keys: Vec::new(),
                value: None,
            },
            Err(error) => Layer {
                loaded: false,
                error: Some(error.to_string()),
                keys: Vec::new(),
                value: None,
            },
        },
    }
}

fn layer_source(layer: &str, source: &Layer) -> Value {
    json!({
        "layer": layer,
        "loaded": source.loaded,
        "error": source.error,
        "keys": source.keys,
    })
}

fn config_inputs(ctx: &AppReadContext, project: Option<&str>) -> (PathBuf, Option<PathBuf>, bool) {
    if let Some((user, project_file)) = ctx.config_files() {
        let project_file = project.and_then(|identity| {
            project_file
                .map(Path::to_path_buf)
                .or_else(|| resolve_root(ctx, identity).map(|root| project_config(&root)))
        });
        let resolved = project_file.is_some();
        return (user.to_path_buf(), project_file, resolved);
    }
    let user = user_config_file();
    let root = project.and_then(|identity| resolve_root(ctx, identity));
    let file = root.as_ref().map(|root| project_config(root));
    let resolved = root.is_some();
    (user, file, resolved)
}

fn config_paths(ctx: &AppReadContext, project: Option<&str>) -> (PathBuf, Option<PathBuf>) {
    let (user, project_file, _) = config_inputs(ctx, project);
    (user, project_file)
}

fn resolve_root(ctx: &AppReadContext, identity: &str) -> Option<PathBuf> {
    ctx.identity_root(identity).map(Path::to_path_buf)
}

fn user_config_file() -> PathBuf {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| {
            crate::config::user_home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    let directory = config_home.join("cortexkit");
    let jsonc = directory.join("magic-context.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    let json = directory.join("magic-context.json");
    if json.exists() {
        return json;
    }
    jsonc
}

fn project_config(root: &Path) -> PathBuf {
    let directory = root.join(".cortexkit");
    let jsonc = directory.join("magic-context.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    let json = directory.join("magic-context.json");
    if json.exists() {
        return json;
    }
    jsonc
}

fn merge(into: &mut Value, overlay: &Value) {
    match (into, overlay) {
        (Value::Object(base), Value::Object(extra)) => {
            for (key, value) in extra {
                merge(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (slot, value) => *slot = value.clone(),
    }
}

// Known settings come from the trusted resolver; only unrecognized leaves survive the raw layers.
fn retain_unknown(value: &mut Value, schema: &Value) {
    let node = if schema.get("inner").is_some() {
        &schema["inner"]
    } else {
        schema
    };
    if node.get("inner").is_some() {
        retain_unknown(value, node);
        return;
    }
    if let (Some(object), Some(shape)) = (value.as_object_mut(), node["shape"].as_object()) {
        object.retain(|key, child| {
            let Some(rule) = shape.get(key) else {
                return true;
            };
            retain_unknown(child, rule);
            !child.is_null() && child.as_object().is_none_or(|object| !object.is_empty())
        });
    } else {
        *value = Value::Null;
    }
}

fn effective(
    ctx: &AppReadContext,
    user_path: &Path,
    project_file: Option<&Path>,
) -> Result<(Value, Value), HandlerOutcome> {
    // A file cannot contain a project directory; this avoids consulting the working directory when no root is visible.
    let root = project_file
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or(user_path);
    let runtime = ctx
        .config_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .effective_for_paths(user_path, root);
    let environment = if ctx.config_files().is_some() {
        std::collections::BTreeMap::new()
    } else {
        std::env::vars().collect()
    };
    let home = if ctx.config_files().is_some() {
        user_path.parent().unwrap_or(user_path).to_path_buf()
    } else {
        crate::config::user_home_dir()
            .unwrap_or_else(|| user_path.parent().unwrap_or(user_path).to_path_buf())
    };
    let resolver = crate::config_parity::TrustedConfigResolver::new(home, environment);
    let result = resolver.resolve(&crate::config_parity::ConfigResolveRequest {
        user_config_path: user_path.to_string_lossy().into_owned(),
        project_root: root.to_string_lossy().into_owned(),
        generation: crate::parity_contract::Generation(0),
    });
    let core = match result {
        crate::parity_contract::CapabilityResult::Available { value }
        | crate::parity_contract::CapabilityResult::Degraded { value, reason: _ } => value,
        crate::parity_contract::CapabilityResult::Unavailable { reason: _ } => {
            return Err(super::named(
                "store_unavailable",
                "The effective configuration could not be resolved.",
            ))
        }
    };
    let crate::config_parity::CoreConfig {
        settings,
        effective: _,  // ConfigCache is the serving engine's authority for these fields.
        generation: _, // Config generations are not app-surface versions.
        warnings: _,   // Layer errors are reported through sources without raw diagnostic text.
        trust: _,      // Trust metadata is internal to resolution, not configuration values.
        protected_token_tiers: _, // The serving projection retains the separate runtime tiers.
    } = core;
    Ok((settings, runtime_projection(runtime)))
}

fn runtime_projection(config: crate::config::McModuleConfig) -> Value {
    let crate::config::McModuleConfig {
        rust_background_enabled,
        signed_thinking_hold,
        historian_expand_tools: _, // Templates contain arbitrary user prompt text and are not exposed.
        historian_temperature,
        historian_runner,
        dreamer_runner,
        language,
        execute_threshold_percentage,
        execute_threshold_user_config,
        execute_threshold_user_configured,
        execute_threshold_project_config,
        protected_tokens_user,
        protected_tokens_project,
        keep_reasoning_tokens,
        compaction_enabled,
        smart_notes_enabled,
        memory_enabled,
        auto_search,
        caveman,
        auto_promote,
        user_memory_collection_enabled,
        user_observations_requested,
        historian_context_limit_tokens,
        historian_context_limit_known,
        memory_budget_tokens,
        user_profile_budget_tokens,
        inject_docs,
        temporal_awareness,
        prompt_surface_guidance_override: _, // Guidance contains arbitrary user prompt text and is not exposed.
        smart_drops,
        protected_tools,
        cache_ttl,
        cache_ttl_by_model,
        catalog,
    } = config;
    let crate::config::AutoSearchConfig {
        enabled,
        score_threshold,
        min_prompt_chars,
    } = auto_search;
    let auto_search = json!({"enabled": enabled, "score_threshold": score_threshold, "min_prompt_chars": min_prompt_chars});
    let crate::config::CavemanConfig { enabled, min_size } = caveman;
    let caveman = json!({"enabled": enabled, "min_size": min_size});
    let crate::config::CatalogConfigInputs {
        prompt_surface_default,
        prompt_surface_models,
        tool_descriptions: _, // User-authored replacement descriptions may contain private prompt text.
        dreamer_runnable,
    } = catalog;
    let signed_thinking_hold = match signed_thinking_hold {
        crate::config::SignedThinkingHold::Off => "off",
        crate::config::SignedThinkingHold::On => "on",
    };
    let threshold = |value: Option<crate::scheduler::ExecuteThresholdConfig>| match value {
        None => Value::Null,
        Some(crate::scheduler::ExecuteThresholdConfig::Percentage(value)) => json!(value),
        Some(crate::scheduler::ExecuteThresholdConfig::ByModel(values)) => json!(values),
    };
    let runner = |value| match value {
        crate::historian_runner::HistorianRunnerKind::Broca => "broca",
        crate::historian_runner::HistorianRunnerKind::Host => "host",
    };
    let mut output = json!({
        "rust_background_enabled": rust_background_enabled, "signed_thinking_hold": signed_thinking_hold,
        "historian_temperature": historian_temperature, "historian_runner": historian_runner.map(runner),
        "dreamer_runner": dreamer_runner.map(runner), "language": language,
        "execute_threshold_percentage": execute_threshold_percentage,
        "execute_threshold_user_config": threshold(execute_threshold_user_config),
        "execute_threshold_user_configured": execute_threshold_user_configured,
        "execute_threshold_project_config": threshold(execute_threshold_project_config),
        "protected_tokens_user": protected_tokens_user, "protected_tokens_project": protected_tokens_project,
        "keep_reasoning_tokens": keep_reasoning_tokens, "compaction_enabled": compaction_enabled,
        "smart_notes_enabled": smart_notes_enabled, "memory_enabled": memory_enabled,
        "auto_search": auto_search, "caveman": caveman, "auto_promote": auto_promote,
        "user_memory_collection_enabled": user_memory_collection_enabled, "user_observations_requested": user_observations_requested,
        "historian_context_limit_tokens": historian_context_limit_tokens, "historian_context_limit_known": historian_context_limit_known,
        "memory_budget_tokens": memory_budget_tokens, "user_profile_budget_tokens": user_profile_budget_tokens,
        "inject_docs": inject_docs, "temporal_awareness": temporal_awareness, "smart_drops": smart_drops,
        "protected_tools": protected_tools, "cache_ttl": cache_ttl, "cache_ttl_by_model": cache_ttl_by_model,
        "catalog": {"prompt_surface_default": prompt_surface_default, "prompt_surface_models": prompt_surface_models, "dreamer_runnable": dreamer_runnable},
    });
    // These schema-shaped fields must agree with the serving engine, not just the full JSON resolver.
    output["memory"] = json!({"enabled": memory_enabled, "auto_search": output["auto_search"].clone(), "auto_promote": auto_promote});
    output["historian"] =
        json!({"runner": output["historian_runner"].clone(), "temperature": historian_temperature});
    output
}

fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("key")
        || key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key == "authorization"
}

fn redact(value: &mut Value, in_headers: bool) {
    let Value::Object(object) = value else {
        if let Value::Array(items) = value {
            for item in items {
                redact(item, false);
            }
        }
        return;
    };
    let keys: Vec<String> = object.keys().cloned().collect();
    for key in keys {
        let child = object.get_mut(&key).unwrap();
        let headers = key.eq_ignore_ascii_case("headers");
        if in_headers || secret_key(&key) || (headers && !child.is_object()) {
            let present = !child.is_null();
            *child = json!({"redacted": true, "present": present});
        } else if headers {
            redact(child, true);
        } else {
            redact(child, false);
        }
    }
}

fn probes() -> &'static Mutex<HashMap<String, i64>> {
    static PROBES: std::sync::OnceLock<Mutex<HashMap<String, i64>>> = std::sync::OnceLock::new();
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_admission(key: &str, now_ms: i64) -> Option<i64> {
    let mut probes = probes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(last) = probes.get(key) {
        let elapsed = now_ms.saturating_sub(*last);
        if elapsed < PROBE_WINDOW_MS {
            return Some(PROBE_WINDOW_MS - elapsed);
        }
    }
    probes.insert(key.to_string(), now_ms);
    None
}

fn interpret(http: &ProbeHttp) -> (bool, Value, Value) {
    if let Some(message) = &http.error {
        return (
            false,
            Value::Null,
            json!({"kind": "transport", "message": message}),
        );
    }
    if !(200..300).contains(&http.status) {
        return (
            false,
            Value::Null,
            json!({"kind": "http", "message": format!("Embedding endpoint returned HTTP {}.", http.status)}),
        );
    }
    let parsed: Value = match serde_json::from_slice(&http.body) {
        Ok(value) => value,
        Err(_) => {
            return (
                false,
                Value::Null,
                json!({"kind": "invalid_envelope", "message": "Embedding response was not JSON."}),
            )
        }
    };
    let dimensions = parsed
        .pointer("/data/0/embedding")
        .and_then(Value::as_array)
        .map(|values| json!(values.len()))
        .unwrap_or(Value::Null);
    if dimensions.is_null() {
        return (
            false,
            Value::Null,
            json!({"kind": "invalid_envelope", "message": "Embedding response had no vector."}),
        );
    }
    (true, dimensions, Value::Null)
}

fn curl_probe(url: &str, body: &[u8], authorization: Option<&str>) -> ProbeHttp {
    fn quoted(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    }
    let mut config = format!(
        "url = \"{}\"\nheader = \"content-type: application/json\"\n",
        quoted(url)
    );
    if let Some(authorization) = authorization {
        config.push_str(&format!(
            "header = \"authorization: {}\"\n",
            quoted(authorization)
        ));
    }
    config.push_str("data-binary = \"");
    config.push_str(&quoted(&String::from_utf8_lossy(body)));
    config.push_str("\"\n");
    let mut command = std::process::Command::new("curl");
    command
        .args([
            "-q",
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "--max-filesize",
            "65536",
            "--proto",
            "=http,https",
            "-w",
            "\n%{http_code}",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProbeHttp {
                status: 0,
                body: Vec::new(),
                error: Some(format!("No HTTP client is available ({error}).")),
            }
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(config.as_bytes());
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return ProbeHttp {
                status: 0,
                body: Vec::new(),
                error: Some(error.to_string()),
            }
        }
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let (body, status) = text.rsplit_once('\n').unwrap_or((text.as_ref(), "0"));
    ProbeHttp {
        status: status.trim().parse().unwrap_or(0),
        body: body.as_bytes().to_vec(),
        error: (!output.status.success())
            .then(|| "The configured embedding endpoint could not be reached.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Recording {
        calls: Mutex<Vec<String>>,
    }

    impl ProbeTransport for Recording {
        fn send(&self, url: &str, _body: &[u8], _authorization: Option<&str>) -> ProbeHttp {
            self.calls.lock().unwrap().push(url.to_string());
            ProbeHttp {
                status: 200,
                body: br#"{"data":[{"embedding":[0.1,0.2]}]}"#.to_vec(),
                error: None,
            }
        }
    }

    fn ctx() -> (AppReadContext<'static>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::app_read::tests_support::open_store(dir.path());
        let mut ctx = AppReadContext::for_test(store, 5_000);
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/config");
        let user = dir.path().join("user.json");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join(".cortexkit")).unwrap();
        let project = root.join(".cortexkit/magic-context.json");
        std::fs::copy(fixture.join("user.json"), &user).unwrap();
        std::fs::copy(fixture.join("project.json"), &project).unwrap();
        ctx.set_config_files(user, Some(project));
        ctx.set_identity_root("git:fixture", root);
        (ctx, dir)
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
    }

    #[test]
    fn config_redacts_a_secret_in_every_location() {
        let (ctx, _dir) = ctx();
        let reply = crate::app_read::tests_support::response(&read(
            &caller(),
            &ctx,
            json!({"project": "git:fixture"}).as_object().unwrap(),
        ));
        let config = &reply["row"]["config"];
        assert_eq!(
            config["api_key"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["embedding"]["api_key"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["headers"]["authorization"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["headers"]["x-trace"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["auth"]["password"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["auth"]["token"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["project_token"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["webhook_secret"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["headers"]["x-project"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(config["memory_enabled"], true);
        assert_eq!(config["auth"]["label"], "user-visible-label");
        assert_eq!(config["note"], "project-visible");
        assert_eq!(config["embedding"]["model"], "embed-test");
        assert_eq!(
            config["future"]["SECRET"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["array"][0]["access_token"],
            json!({"redacted": true, "present": true})
        );
        assert_eq!(
            config["auth"]["null_key"],
            json!({"redacted": true, "present": false})
        );
        let encoded = reply.to_string();
        assert!(!encoded.contains("user-top-level-secret"));
        assert!(!encoded.contains("user-nested-secret"));
        assert!(!encoded.contains("user-password-secret"));
        assert!(!encoded.contains("project-token-secret"));
    }

    #[test]
    fn unresolved_project_uses_the_user_layer_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::app_read::tests_support::open_store(dir.path());
        let mut ctx = AppReadContext::for_test(store, 1);
        ctx.set_config_files(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/config/user.json"),
            None,
        );
        let reply = crate::app_read::tests_support::response(&read(
            &caller(),
            &ctx,
            json!({"project": "git:missing"}).as_object().unwrap(),
        ));
        assert_eq!(reply["row"]["project_resolved"], false);
        assert!(reply["row"]["config"].get("project_token").is_none());
    }

    #[test]
    fn probe_refuses_a_caller_endpoint_and_honours_the_rate_limit() {
        let (mut ctx, _dir) = ctx();
        let transport = Arc::new(Recording {
            calls: Mutex::new(Vec::new()),
        });
        ctx.set_probe(transport.clone());
        let refused = probe(
            &caller(),
            &ctx,
            json!({"project": "git:fixture", "endpoint": "https://evil.example"})
                .as_object()
                .unwrap(),
        );
        assert_eq!(
            crate::app_read::tests_support::detail_field(&refused)["field"],
            "params.endpoint"
        );
        assert!(transport.calls.lock().unwrap().is_empty());
        let first = crate::app_read::tests_support::response(&probe(
            &caller(),
            &ctx,
            json!({"project": "git:fixture"}).as_object().unwrap(),
        ));
        assert_eq!(first["reachable"], true);
        assert_eq!(first["dimensions"], 2);
        assert_eq!(
            transport.calls.lock().unwrap().as_slice(),
            ["https://embeddings.example.test/v1/embeddings"]
        );
        match probe(
            &caller(),
            &ctx,
            json!({"project": "git:fixture"}).as_object().unwrap(),
        ) {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, "probe_rate_limited");
                assert!(detail["retry_after_ms"].as_i64().unwrap() > 0);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
        ctx.now_ms += PROBE_WINDOW_MS;
        let again = crate::app_read::tests_support::response(&probe(
            &caller(),
            &ctx,
            json!({"project":"git:fixture"}).as_object().unwrap(),
        ));
        assert_eq!(again["reachable"], true);
        assert_eq!(transport.calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn nested_unknown_key_is_refused() {
        let (ctx, _dir) = ctx();
        let outcome = read(
            &caller(),
            &ctx,
            json!({"project": {"identity": "git:fixture"}})
                .as_object()
                .unwrap(),
        );
        assert_eq!(
            crate::app_read::tests_support::detail_field(&outcome)["reason"],
            "type"
        );
    }

    #[test]
    fn effective_projection_matches_runtime_user_only_policy_and_project_floor() {
        let (ctx, _dir) = ctx();
        let (user, project) = config_paths(&ctx, Some("git:fixture"));
        let root = project
            .as_ref()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let runtime = ctx
            .config_cache()
            .lock()
            .unwrap()
            .effective_for_paths(&user, root);
        let reply = crate::app_read::tests_support::response(&read(
            &caller(),
            &ctx,
            json!({"project": "git:fixture"}).as_object().unwrap(),
        ));
        assert_eq!(
            runtime.signed_thinking_hold,
            crate::config::SignedThinkingHold::On
        );
        assert_eq!(reply["row"]["config"]["signed_thinking_hold"], "on");
        assert_eq!(runtime.execute_threshold_percentage, 80.0);
        assert_eq!(reply["row"]["config"]["execute_threshold_percentage"], 80.0);
        assert_eq!(
            reply["row"]["config"]["embedding"]["endpoint"],
            "https://embeddings.example.test/v1"
        );
        assert_eq!(reply["row"]["project_resolved"], true);
        assert!(!reply["row"]["sources"][0]["keys"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn scalar_only_operations_refuse_nested_parameter_objects() {
        let (ctx, _dir) = ctx();
        for op in [read, probe] {
            let outcome = op(
                &caller(),
                &ctx,
                json!({"filters": {"endpoint": "https://evil.invalid"}})
                    .as_object()
                    .unwrap(),
            );
            assert_eq!(
                crate::app_read::tests_support::detail_field(&outcome),
                json!({"field": "params.filters", "reason": "unknown"})
            );
            let outcome = op(
                &caller(),
                &ctx,
                json!({"project": {"unknown": true}}).as_object().unwrap(),
            );
            assert_eq!(
                crate::app_read::tests_support::detail_field(&outcome)["field"],
                "params.project"
            );
        }
    }
}
