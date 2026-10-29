use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use mc_module::config_parity::{
    BridgeConfig, BridgeSettings, ConfigResolveRequest, CoreConfigResolver, TrustedConfigResolver,
};
use mc_module::parity_contract::{Availability, CapabilityResult, Generation};
use serde_json::{json, Value};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("../testdata/config_parity/golden.json")).unwrap()
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn expand(text: &str, root: &Path) -> String {
    text.replace("$ROOT", &root.to_string_lossy())
}
fn expand_json(text: &str, root: &Path) -> String {
    let encoded = serde_json::to_string(&root.to_string_lossy()).unwrap();
    text.replace("$ROOT", &encoded[1..encoded.len() - 1])
}
fn normalize_roots(value: &Value, root: &Path) -> Value {
    match value {
        Value::String(s) => json!(s.replace(root.to_string_lossy().as_ref(), "$ROOT")),
        Value::Array(array) => {
            Value::Array(array.iter().map(|v| normalize_roots(v, root)).collect())
        }
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(k, v)| (k.clone(), normalize_roots(v, root)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
fn normalize(value: &Value, root: &Path) -> Value {
    #[cfg(windows)]
    {
        let mut value = normalize_roots(value, root);
        // This field compares path meaning; backslashes in arbitrary config
        // strings (including prompts and model names) must remain untouched.
        match value.pointer_mut("/subc/connection_file") {
            Some(Value::String(path))
                if path.as_str() == "$ROOT"
                    || path.starts_with("$ROOT/")
                    || path.starts_with("$ROOT\\") =>
            {
                *path = path.replace('\\', "/");
            }
            _ => {}
        }
        value
    }
    #[cfg(not(windows))]
    {
        normalize_roots(value, root)
    }
}
fn check(row: &Value) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let home = root.join("home");
    let project = root.join("project");
    let user_path = root.join("xdg/cortexkit/magic-context.jsonc");
    fs::create_dir_all(&project).unwrap();
    let mut environment = BTreeMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        (
            "XDG_CONFIG_HOME".into(),
            root.join("xdg").to_string_lossy().into_owned(),
        ),
    ]);
    if let Some(env) = row.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            environment.insert(k.clone(), v.as_str().unwrap().into());
        }
    }
    if let Some(files) = row.get("files").and_then(Value::as_object) {
        for (path, text) in files {
            let path = if let Some(relative) = path.strip_prefix("~/") {
                home.join(relative)
            } else if path.starts_with("$ROOT") {
                PathBuf::from(expand(path, root))
            } else {
                user_path.parent().unwrap().join(path)
            };
            write(&path, text.as_str().unwrap());
        }
    }
    for (field, text_field, path) in [
        ("user", "userText", user_path.clone()),
        (
            "project",
            "projectText",
            project.join(".cortexkit/magic-context.jsonc"),
        ),
        (
            "userJson",
            "unused",
            root.join("xdg/cortexkit/magic-context.json"),
        ),
        (
            "legacyUser",
            "unused",
            root.join("xdg/opencode/magic-context.jsonc"),
        ),
        (
            "legacyProject",
            "unused",
            project.join(".opencode/magic-context.jsonc"),
        ),
        ("bareProject", "unused", project.join("magic-context.jsonc")),
        (
            "otherUser",
            "unused",
            home.join(".pi/agent/magic-context.jsonc"),
        ),
        (
            "otherProject",
            "unused",
            project.join(".pi/magic-context.jsonc"),
        ),
    ] {
        if let Some(value) = row.get(field) {
            write(
                &path,
                &expand_json(&serde_json::to_string(value).unwrap(), root),
            );
        }
        if let Some(text) = row.get(text_field).and_then(Value::as_str) {
            write(&path, &expand_json(text, root));
        }
    }
    if let Some(value) = row.get("override").and_then(Value::as_str) {
        let selected = expand(value, root);
        environment.insert("MAGIC_CONTEXT_CONFIG_PATH".into(), selected.clone());
        // The default-path config uses 99m as a decoy: an explicit override must
        // replace it completely, even when the selected file does not exist.
        if row.get("missing") == Some(&json!(true)) {
            write(&user_path, "{\"cache_ttl\":\"99m\"}");
        } else if Path::new(selected.trim()).is_absolute() && user_path.exists() {
            write(
                Path::new(selected.trim()),
                &fs::read_to_string(&user_path).unwrap(),
            );
            write(&user_path, "{\"cache_ttl\":\"99m\"}");
        }
    }
    let resolver = TrustedConfigResolver::new(home, environment);
    assert_eq!(resolver.availability(), Availability::Available);
    let request = ConfigResolveRequest {
        user_config_path: String::new(),
        project_root: project.to_string_lossy().into_owned(),
        generation: Generation(19),
    };
    let bridge = BridgeConfig {
        native_schema_dialect: "pi".into(),
        notifications_enabled: true,
        status_ui_enabled: true,
        discovery_namespace: "fixture".into(),
        settings: BridgeSettings::default(),
    };
    let namespaces = match resolver.resolve_namespaces(&request, bridge) {
        CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
            assert!(
                row.get("error").is_none(),
                "{} should be refused",
                row["name"]
            );
            value
        }
        CapabilityResult::Unavailable { reason } => {
            assert_eq!(row["error"], reason.code, "{}", row["name"]);
            return;
        }
    };
    let core = namespaces.core();
    assert_eq!(core.generation, Generation(19));
    assert_eq!(
        core.effective.signed_thinking_hold,
        if row["effective"]["signed_thinking_hold"] == "on" {
            mc_module::config::SignedThinkingHold::On
        } else {
            mc_module::config::SignedThinkingHold::Off
        },
        "signed-thinking projection for {}",
        row["name"]
    );
    let mut effective = core.settings.clone();
    for (key, value) in serde_json::to_value(&namespaces.bridge().settings)
        .unwrap()
        .as_object()
        .unwrap()
    {
        assert!(
            effective.get(key).is_none(),
            "bridge leaked into core: {key}"
        );
        effective[key] = value.clone();
    }
    assert_eq!(
        normalize(&effective, root),
        row["effective"],
        "effective config for {}",
        row["name"]
    );
    assert_eq!(
        serde_json::to_value(&core.trust).unwrap(),
        row["trust"],
        "trust flags for {}",
        row["name"]
    );
    let codes: BTreeSet<_> = core.warnings.iter().map(|w| w.code.clone()).collect();
    let expected: BTreeSet<_> = row["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(codes, expected, "warning codes for {}", row["name"]);
    for warning in &core.warnings {
        assert!(
            !warning.message.contains("do-not-expand") && !warning.message.contains("quoted\""),
            "resolved secrets must not appear in warnings"
        );
    }
}

#[test]
fn json_root_expansion_escapes_backslashes_and_quotes() {
    let root = Path::new(r#"C:\fixtures\quoted"name"#);
    let text = r#"{"subc":{"connection_file":"$ROOT/connection.json"}}"#;
    let expanded: Value = serde_json::from_str(&expand_json(text, root)).unwrap();
    assert_eq!(
        expanded["subc"]["connection_file"],
        json!(format!("{}/connection.json", root.to_string_lossy()))
    );
}

#[test]
fn normalization_preserves_non_path_backslashes() {
    let root = Path::new(r"C:\fixture");
    let value = json!({
        "subc": {"connection_file": r"C:\fixture\home\daemon/connection.json"},
        "prompt": r"C:\fixture\prompt\literal",
        "model": "quoted\\\"\\nsecret",
        "other": {"subc": {"connection_file": r"C:\fixture\must\keep"}}
    });
    let normalized = normalize(&value, root);
    assert_eq!(normalized["prompt"], json!(r"$ROOT\prompt\literal"));
    assert_eq!(normalized["model"], value["model"]);
    assert_eq!(
        normalized["other"]["subc"]["connection_file"],
        json!(r"$ROOT\must\keep")
    );
    assert_eq!(
        normalized["subc"]["connection_file"],
        json!(if cfg!(windows) {
            "$ROOT/home/daemon/connection.json"
        } else {
            r"$ROOT\home\daemon/connection.json"
        })
    );
}

#[test]
fn generated_loader_matrix_matches() {
    let mut failures = Vec::new();
    for row in rows() {
        if [
            "project-env",
            "project-file-escape",
            "project-both-tokens",
            "project-token-comment",
            "project-user-only",
        ]
        .contains(&row["name"].as_str().unwrap())
        {
            continue;
        }
        if std::panic::catch_unwind(|| check(&row)).is_err() {
            failures.push(row["name"].clone());
        }
    }
    assert!(failures.is_empty(), "failing fixtures: {failures:?}");
}

#[test]
fn project_substitutions_are_never_expanded() {
    for row in rows() {
        if [
            "project-env",
            "project-file-escape",
            "project-both-tokens",
            "project-token-comment",
        ]
        .contains(&row["name"].as_str().unwrap())
        {
            check(&row);
        }
    }
}

#[test]
fn project_cannot_set_user_only_keys() {
    check(
        &rows()
            .into_iter()
            .find(|row| row["name"] == "project-user-only")
            .unwrap(),
    );
}

#[test]
fn core_resolver_does_not_expose_bridge_settings() {
    let root = tempfile::tempdir().unwrap();
    let resolver = TrustedConfigResolver::new(root.path().to_owned(), BTreeMap::new());
    let request = ConfigResolveRequest {
        user_config_path: String::new(),
        project_root: root.path().to_string_lossy().into_owned(),
        generation: Generation(1),
    };
    let CapabilityResult::Available { value } = resolver.resolve(&request) else {
        panic!("default resolver should be available");
    };
    for key in [
        "pi",
        "toast_duration_ms",
        "todowrite",
        "rust_pipeline",
        "keep_subagents",
    ] {
        assert!(value.settings.get(key).is_none(), "{key}");
    }
    assert!(serde_json::from_value::<BridgeSettings>(json!({"memory":{"enabled":false}})).is_err());
}

#[test]
fn compatibility_projection_preserves_derived_floors_and_default_ttl() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join("project/.cortexkit/magic-context.jsonc"),
        r#"{"protected_tokens":4000}"#,
    );
    let resolver = TrustedConfigResolver::new(root.path().join("home"), BTreeMap::new());
    let request = ConfigResolveRequest {
        user_config_path: String::new(),
        project_root: root.path().join("project").to_string_lossy().into_owned(),
        generation: Generation(1),
    };
    let CapabilityResult::Available { value } = resolver.resolve(&request) else {
        panic!("valid project config should resolve");
    };
    assert_eq!(value.settings["protected_tokens"], 4000);
    assert_eq!(value.effective.protected_tokens_user, None);
    assert_eq!(value.effective.protected_tokens_project, Some(4000));
    assert_eq!(
        value.effective.resolve_protected_tokens(1_000_000).floor,
        50_000
    );
    assert_eq!(
        value.effective.resolve_cache_ttl(Some("openai/gpt-5.6")),
        "5m"
    );
    assert_eq!(
        value
            .effective
            .resolve_cache_ttl_with_provenance(None)
            .provenance,
        mc_module::config::CacheTtlProvenance::Default
    );
}
