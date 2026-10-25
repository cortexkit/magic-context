//! Effective config, with secrets removed, and a rate-limited embedding probe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{allow, named, named_detail, opt_str, row_reply, AppReadContext};

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
    if let Err(refusal) = allow(params, &["project"], "params") {
        return refusal;
    }
    let project = match opt_str(params, "project", "params") {
        Ok(project) => project,
        Err(refusal) => return refusal,
    };
    let (user_path, project_file, resolved) = config_inputs(ctx, project.as_deref());
    if let Ok(mut cache) = ctx.config_cache().lock() {
        let root = project_file
            .as_deref()
            .and_then(|path| path.parent())
            .unwrap_or_else(|| Path::new("."));
        let _applied = cache.effective_for_paths(&user_path, root);
    }
    let user = read_layer(&user_path);
    let project_layer = project_file.as_ref().map(|path| read_layer(path));
    let mut merged = json!({});
    if let Some(value) = user.value.as_ref() {
        merged = value.clone();
    }
    if let Some(layer) = project_layer.as_ref().and_then(|layer| layer.value.clone()) {
        merge(&mut merged, &layer);
    }
    redact(&mut merged, false);
    let sources = json!([
        {"layer": "built-in", "loaded": true, "error": null, "keys": []},
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
    let (user_path, _) = config_paths(ctx, project.as_deref());
    let user = read_layer(&user_path);
    let embedding = user
        .value
        .as_ref()
        .and_then(|value| value.get("embedding"))
        .cloned()
        .unwrap_or(Value::Null);
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
    let key = project.unwrap_or_else(|| "user".to_string());
    if let Some(retry) = rate_limited(&key, ctx.now_ms()) {
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
    remember_probe(&key, ctx.now_ms());
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

pub(super) fn dream_schedules(ctx: &AppReadContext) -> Map<String, Value> {
    let (user_path, _) = config_paths(ctx, None);
    let mut schedules = Map::new();
    if let Some(value) = read_layer(&user_path).value {
        collect_schedules(&value, &mut schedules);
    }
    schedules
}

fn collect_schedules(value: &Value, into: &mut Map<String, Value>) {
    if let Some(tasks) = value.pointer("/dreamer/tasks").and_then(Value::as_object) {
        for (task, config) in tasks {
            if let Some(schedule) = config.get("schedule").and_then(Value::as_str) {
                into.insert(task.clone(), json!(schedule));
            }
        }
    }
}

struct Layer {
    loaded: bool,
    error: Option<String>,
    keys: Vec<String>,
    value: Option<Value>,
}

fn read_layer(path: &Path) -> Layer {
    match std::fs::read_to_string(path) {
        Err(_) => Layer {
            loaded: false,
            error: None,
            keys: Vec::new(),
            value: None,
        },
        Ok(raw) => match serde_json::from_str::<Value>(&crate::config::strip_jsonc(&raw)) {
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
        let resolved = project.is_some() && project_file.is_some();
        return (
            user.to_path_buf(),
            project_file.map(Path::to_path_buf),
            resolved,
        );
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
    if let Some(path) = ctx.identity_root(identity) {
        return Some(path.to_path_buf());
    }
    let resolver = crate::project_identity::ProjectIdentityResolver::new();
    ctx.bound_roots().iter().find_map(|path| {
        resolver
            .resolve(path)
            .ok()
            .filter(|found| found == identity)
            .map(|_| path.clone())
    })
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
        let headers = key.eq_ignore_ascii_case("headers") && child.is_object();
        if in_headers || secret_key(&key) {
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

fn rate_limited(key: &str, now_ms: i64) -> Option<i64> {
    let probes = probes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let last = *probes.get(key)?;
    let elapsed = now_ms.saturating_sub(last);
    (elapsed < PROBE_WINDOW_MS).then_some(PROBE_WINDOW_MS - elapsed)
}

fn remember_probe(key: &str, now_ms: i64) {
    probes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.to_string(), now_ms);
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
    let mut config = format!(
        "url = \"{}\"\nheader = \"content-type: application/json\"\n",
        url.replace('"', "")
    );
    if let Some(authorization) = authorization {
        config.push_str(&format!("header = \"authorization: {authorization}\"\n"));
    }
    config.push_str("data-binary = \"");
    config.push_str(&String::from_utf8_lossy(body).replace('"', "\\\""));
    config.push_str("\"\n");
    let mut command = std::process::Command::new("curl");
    command
        .args([
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
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
            .then(|| String::from_utf8_lossy(&output.stderr).to_string()),
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

    fn ctx() -> AppReadContext {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::app_read::tests_support::open_store(dir.path());
        let mut ctx = AppReadContext::for_test(store, 5_000);
        let user =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/config/user.json");
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/app-read-g/config/project.json");
        ctx.set_config_files(user, Some(project));
        ctx.set_identity_root("git:fixture", project_parent());
        ctx
    }

    fn project_parent() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/config")
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
    }

    #[test]
    fn config_redacts_a_secret_in_every_location() {
        let ctx = ctx();
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
        probes().lock().unwrap().clear();
        let mut ctx = ctx();
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
    }

    #[test]
    fn nested_unknown_key_is_refused() {
        let ctx = ctx();
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
}
