//! Keep engine policy separate from host UI and transport settings so the engine
//! does not depend on a particular harness's presentation or connection choices.
//!
//! Callers can explicitly construct TrustedConfigResolver to mirror the TypeScript
//! loader. ConfigCache and the running engine still use their existing loading path.

mod profiles;
mod trust;
mod variables;

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::config::McModuleConfig;
use crate::parity_contract::{Availability, CapabilityResult, Generation};

#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub effective: McModuleConfig,
    pub generation: Generation,
    /// Complete validated engine settings, including families not in McModuleConfig yet.
    pub settings: Value,
    pub warnings: Vec<Warning>,
    pub trust: TrustFlags,
    pub protected_token_tiers: ProtectedTokenTiers,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeConfig {
    pub native_schema_dialect: String,
    pub notifications_enabled: bool,
    pub status_ui_enabled: bool,
    pub discovery_namespace: String,
    #[serde(default)]
    pub settings: BridgeSettings,
}

/// Distinct types prevent native UI and transport options from entering engine policy.
#[derive(Debug, Clone)]
pub struct ConfigNamespaces {
    core: CoreConfig,
    bridge: BridgeConfig,
}

impl ConfigNamespaces {
    pub fn new(core: CoreConfig, bridge: BridgeConfig) -> Self {
        Self { core, bridge }
    }

    pub fn core(&self) -> &CoreConfig {
        &self.core
    }

    pub fn bridge(&self) -> &BridgeConfig {
        &self.bridge
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigResolveRequest {
    pub user_config_path: String,
    pub project_root: String,
    pub generation: Generation,
}

pub trait CoreConfigResolver: Send + Sync {
    fn availability(&self) -> Availability;
    fn resolve(&self, request: &ConfigResolveRequest) -> CapabilityResult<CoreConfig>;
}

pub struct UnavailableConfigResolver;
pub static UNAVAILABLE: UnavailableConfigResolver = UnavailableConfigResolver;

impl CoreConfigResolver for UnavailableConfigResolver {
    fn availability(&self) -> Availability {
        mc_store::parity_schema_manifest::unavailable("config_parity")
    }

    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        CapabilityResult::unavailable("config_parity")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_settings_are_not_part_of_the_core_projection() {
        let config = ConfigNamespaces::new(
            CoreConfig {
                effective: McModuleConfig::default(),
                generation: Generation(7),
                settings: json!({}),
                warnings: vec![],
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
            BridgeConfig {
                native_schema_dialect: "pi".into(),
                notifications_enabled: false,
                status_ui_enabled: false,
                discovery_namespace: "fixture".into(),
                settings: BridgeSettings::default(),
            },
        );
        assert_eq!(config.core().generation, Generation(7));
        assert!(!config.bridge().status_ui_enabled);
        let request = ConfigResolveRequest {
            user_config_path: "/nonexistent/user.jsonc".into(),
            project_root: "/nonexistent/project".into(),
            generation: Generation(7),
        };
        assert!(matches!(
            UNAVAILABLE.resolve(&request),
            CapabilityResult::Unavailable { .. }
        ));
        assert!(matches!(
            UNAVAILABLE.availability(),
            Availability::Unavailable { .. }
        ));
    }

    #[test]
    fn bridge_namespace_rejects_core_policy_fields() {
        let bridge = serde_json::json!({
            "native_schema_dialect": "pi", "notifications_enabled": true,
            "status_ui_enabled": true, "discovery_namespace": "fixture",
            "memory_budget_tokens": 1
        });
        assert!(serde_json::from_value::<BridgeConfig>(bridge).is_err());
    }

    #[test]
    fn union_recovery_prunes_unknown_model_leaves_without_losing_valid_siblings() {
        let descriptor = json!({
            "type": "union",
            "options": [
                {"type": "string"},
                {"type": "object", "shape": {"model": {"type": "string"}},
                    "catchall": {"type": "never"}}
            ]
        });
        for leaf in ["unknown", "system_prompt"] {
            let mut raw = json!({"entry": {"model": "provider/model"}});
            raw["entry"][leaf] = json!("unrecognized");
            let (_, issues) = schema_parse(&descriptor, raw.get("entry"), "entry");
            assert_eq!(issues, vec![format!("entry.{leaf}")]);
            assert!(prune(&mut raw, &issues[0]));
            let (entry, remaining) = schema_parse(&descriptor, raw.get("entry"), "entry");
            assert!(remaining.is_empty());
            assert_eq!(entry, Some(json!({"model": "provider/model"})));
        }
        assert_eq!(
            schema_parse(&descriptor, Some(&json!(false)), "entry").1,
            vec!["entry"]
        );
    }
}

/// Host UI and transport choices (such as toast lifetime) are carried to the bridge,
/// not CoreConfig::settings, because engine policy must remain harness-independent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toast_duration_ms: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todowrite: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_hooks: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_subagents: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subc: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rust_pipeline: Option<String>,
}
const BRIDGE_KEYS: [&str; 9] = [
    "auto_update",
    "toast_duration_ms",
    "pi",
    "todowrite",
    "disabled_hooks",
    "command",
    "keep_subagents",
    "subc",
    "rust_pipeline",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Warning {
    pub code: String,
    pub message: String,
}
impl Warning {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustFlags {
    pub user: String,
    pub project: String,
    pub outcome: String,
    pub trusted: bool,
    pub cache_ttl_configured: bool,
}
impl Default for TrustFlags {
    fn default() -> Self {
        Self {
            user: "ok".into(),
            project: "ok".into(),
            outcome: "ok".into(),
            trusted: true,
            cache_ttl_configured: false,
        }
    }
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProtectedTokenTiers {
    pub user: Option<u64>,
    pub project: Option<u64>,
}

/// Explicit machine facts make substitutions and discovery testable without global env mutation.
#[derive(Debug, Clone)]
pub struct TrustedConfigResolver {
    pub home: PathBuf,
    pub environment: BTreeMap<String, String>,
}
impl TrustedConfigResolver {
    pub fn from_environment() -> Self {
        Self {
            home: crate::config::user_home_dir().unwrap_or_default(),
            environment: std::env::vars().collect(),
        }
    }
    pub fn new(home: PathBuf, environment: BTreeMap<String, String>) -> Self {
        Self { home, environment }
    }

    pub fn resolve_namespaces(
        &self,
        request: &ConfigResolveRequest,
        mut bridge: BridgeConfig,
    ) -> CapabilityResult<ConfigNamespaces> {
        match self.load(request) {
            Ok(mut core) => {
                let mut settings = Map::new();
                for key in BRIDGE_KEYS {
                    if let Some(value) = core.settings.as_object_mut().unwrap().remove(key) {
                        settings.insert(key.into(), value);
                    }
                }
                bridge.settings = serde_json::from_value(Value::Object(settings))
                    .expect("validated bridge projection");
                let reason = mc_store::parity_schema_manifest::CapabilityReason { code: core.trust.outcome.clone(), message: "Config needs repair; inspect safe warning codes before activating background work.".into() };
                let trusted = core.trust.trusted;
                let value = ConfigNamespaces::new(core, bridge);
                if trusted {
                    CapabilityResult::Available { value }
                } else {
                    CapabilityResult::Degraded { value, reason }
                }
            }
            Err(reason) => CapabilityResult::Unavailable { reason },
        }
    }

    fn load(
        &self,
        request: &ConfigResolveRequest,
    ) -> Result<CoreConfig, mc_store::parity_schema_manifest::CapabilityReason> {
        let mut warnings = Vec::new();
        let project_root = Path::new(&request.project_root);
        let explicit = self
            .environment
            .get("MAGIC_CONTEXT_CONFIG_PATH")
            .map(String::as_str)
            .or_else(|| {
                (!request.user_config_path.is_empty()).then_some(request.user_config_path.as_str())
            });
        let xdg = self
            .environment
            .get("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| self.home.join(".config"));
        let user_path = if let Some(explicit) = explicit {
            let path = PathBuf::from(variables::trim(explicit));
            if path.as_os_str().is_empty() || !path.is_absolute() {
                return Err(mc_store::parity_schema_manifest::CapabilityReason { code: "config_path_absolute".into(), message: "MAGIC_CONTEXT_CONFIG_PATH must be an absolute path to a user config file (not blank)".into() });
            }
            if !path.exists() {
                warnings.push(Warning::new("config_path_missing", "MAGIC_CONTEXT_CONFIG_PATH file not found; continuing without user config (no XDG or legacy fallback)."));
            }
            Some(path)
        } else {
            detect(&xdg.join("cortexkit/magic-context")).or_else(|| {
                let path = detect(&xdg.join("opencode/magic-context"));
                if path.is_some() {
                    warnings.push(Warning::new(
                        "legacy_read",
                        "Reading this harness's legacy user config until migration completes.",
                    ));
                }
                path
            })
        };
        let project_path = detect(&project_root.join(".cortexkit/magic-context")).or_else(|| {
            let path = detect(&project_root.join("magic-context"))
                .or_else(|| detect(&project_root.join(".opencode/magic-context")));
            if path.is_some() {
                warnings.push(Warning::new(
                    "legacy_read",
                    "Reading this harness's legacy project config until migration completes.",
                ));
            }
            path
        });
        let (mut user, mut user_outcome, user_order) =
            self.read(user_path.as_deref(), false, &mut warnings);
        let (mut project, mut project_outcome, project_order) =
            self.read(project_path.as_deref(), true, &mut warnings);
        if explicit.is_none()
            && user_path.is_none()
            && detect(&self.home.join(".pi/agent/magic-context")).is_some()
        {
            user_outcome = "legacy-config-unmigrated".into();
            warnings.push(Warning::new("legacy_unmigrated", "Other-harness legacy user config exists; embedding registration is paused until migration completes."));
        }
        if project_path.is_none() && detect(&project_root.join(".pi/magic-context")).is_some() {
            project_outcome = "legacy-config-unmigrated".into();
            warnings.push(Warning::new("legacy_unmigrated", "Other-harness legacy project config exists; embedding registration is paused until migration completes."));
        }
        profiles::removed(&mut user, &mut warnings);
        profiles::removed(&mut project, &mut warnings);
        trust::sanitize(&mut project, &mut warnings);
        let profile = profiles::resolve(&mut user, &mut project, &mut warnings);
        let trusted_raw = user.clone();
        let (trusted, _) = validate(&user, &user_order, &mut Vec::new());
        let mut merged = trust::deep_merge(&user, &project, &user_order, &project_order);
        trust::thresholds(&mut merged, &project, &trusted, &mut warnings);
        let restored = trust::restore_invalid(&mut merged, &project, &trusted_raw, &mut warnings);
        trust::commands(&mut merged, &project, &trusted_raw, &mut warnings);
        let cache_ttl_configured = merged.get("cache_ttl").is_some();
        let order = if project.get("protected_tools").is_some() {
            &project_order
        } else {
            &user_order
        };
        let (mut effective, recovered) = validate(&merged, order, &mut warnings);
        if let Some(profile) = profile {
            effective["profile"] = json!(profile);
        }
        // The plugin accepts these retired keys but ignores their values after parsing:
        // `loadPluginConfigDetailed` always resolves transform_mode to TypeScript and
        // rust_pipeline to full_request (packages/plugin/src/config/index.ts:788-894).
        effective["transform_mode"] = json!("ts");
        effective["rust_pipeline"] = json!("full_request");
        if let Some(value) = value_at(&effective, "subc.connection_file").and_then(Value::as_str) {
            if value == "~" {
                let home = self.home.to_string_lossy().into_owned();
                set_path(&mut effective, "subc.connection_file", json!(home));
            } else if let Some(relative) = value.strip_prefix("~/") {
                let home = self.home.join(relative).to_string_lossy().into_owned();
                set_path(&mut effective, "subc.connection_file", json!(home));
            }
        }
        let outcome = [
            "project-file-parse-error",
            "project-file-io-error",
            "legacy-config-unmigrated",
        ]
        .into_iter()
        .find(|v| *v == user_outcome || *v == project_outcome)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if recovered || restored {
                "schema-recovery".into()
            } else if user_outcome == "substitution-failure"
                || project_outcome == "substitution-failure"
            {
                "substitution-failure".into()
            } else {
                "ok".into()
            }
        });
        let tiers = ProtectedTokenTiers {
            user: trusted.get("protected_tokens").and_then(Value::as_u64),
            project: project
                .get("protected_tokens")
                .filter(|v| trust::protected(v))
                .and_then(Value::as_u64)
                .filter(|v| {
                    trusted
                        .get("protected_tokens")
                        .and_then(Value::as_u64)
                        .is_none_or(|u| *v >= u)
                }),
        };
        let mut module_config = crate::config::parity_projection(&effective);
        module_config.protected_tokens_user = tiers.user;
        module_config.protected_tokens_project = tiers.project;
        if !cache_ttl_configured {
            module_config.cache_ttl_by_model.clear();
        }
        Ok(CoreConfig {
            effective: module_config,
            generation: request.generation,
            settings: effective,
            warnings,
            trust: TrustFlags {
                user: user_outcome,
                project: project_outcome,
                trusted: outcome == "ok",
                outcome,
                cache_ttl_configured,
            },
            protected_token_tiers: tiers,
        })
    }

    fn read(
        &self,
        path: Option<&Path>,
        project: bool,
        warnings: &mut Vec<Warning>,
    ) -> (Value, String, Vec<String>) {
        let Some(path) = path.filter(|p| p.exists()) else {
            return (json!({}), "ok".into(), vec![]);
        };
        let Ok(bytes) = std::fs::read(path) else {
            warnings.push(Warning::new("file_io", "Failed to read config."));
            return (json!({}), "project-file-io-error".into(), vec![]);
        };
        let text = String::from_utf8_lossy(&bytes);
        // Flat model migration precedes substitution in TypeScript. In particular,
        // an environment token in a property name must not invent a legacy model key.
        let without_bom = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let mut migration = None;
        if let Ok(mut raw) = serde_json::from_str::<Value>(&crate::config::strip_jsonc(without_bom))
        {
            if raw.is_object() && profiles::flat(&mut raw, warnings) {
                let (_, _, _, original_order) = variables::parse(&text, &mut Vec::new());
                let migrated = profiles::serialize_flat(&raw, &original_order);
                migration = Some(if text.starts_with('\u{feff}') {
                    format!("\u{feff}{migrated}")
                } else {
                    migrated
                });
            }
        }
        let substitute_input = if project {
            &text
        } else {
            migration.as_deref().unwrap_or(&text)
        };
        let (substituted, substitutions) = variables::substitute(
            substitute_input,
            path,
            project,
            &self.home,
            &self.environment,
            warnings,
        );
        let parse_input = if project {
            migration.as_deref().unwrap_or(&substituted)
        } else {
            &substituted
        };
        let (value, invalid, unsafe_keys, order) = variables::parse(parse_input, warnings);
        // The TypeScript loader warns when the user config contains this key, even
        // when a `{file:...}` substitution returns an empty string because its file is missing
        // (`packages/plugin/src/config/index.ts:441`, `packages/plugin/src/config/deprecated-config.ts:29-43`). Project values are
        // warned and removed separately by the trust sanitizer.
        if !project && value_at(&value, "models.window_overlay_path").is_some() {
            warnings.push(Warning::new(
                "deprecated",
                "models.window_overlay_path is deprecated and ignored.",
            ));
        }
        (
            value,
            if invalid {
                "project-file-parse-error"
            } else if unsafe_keys {
                "schema-recovery"
            } else if substitutions {
                "substitution-failure"
            } else {
                "ok"
            }
            .into(),
            order,
        )
    }
}
impl CoreConfigResolver for TrustedConfigResolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, request: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        let bridge = BridgeConfig {
            native_schema_dialect: String::new(),
            notifications_enabled: true,
            status_ui_enabled: true,
            discovery_namespace: String::new(),
            settings: BridgeSettings::default(),
        };
        match self.resolve_namespaces(request, bridge) {
            CapabilityResult::Available { value } => {
                CapabilityResult::Available { value: value.core }
            }
            CapabilityResult::Degraded { value, reason } => CapabilityResult::Degraded {
                value: value.core,
                reason,
            },
            CapabilityResult::Unavailable { reason } => CapabilityResult::Unavailable { reason },
        }
    }
}
fn detect(base: &Path) -> Option<PathBuf> {
    ["jsonc", "json"]
        .iter()
        .map(|extension| base.with_extension(extension))
        .find(|p| p.exists())
}
pub(crate) fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../../testdata/config_parity/schema.json"))
            .expect("generated config schema")
    })
}
pub(crate) fn merge(user: &Value, project: &Value) -> Value {
    if let (Some(user), Some(project)) = (user.as_object(), project.as_object()) {
        let mut result = user.clone();
        for (key, value) in project {
            result.insert(
                key.clone(),
                result
                    .get(key)
                    .map_or_else(|| value.clone(), |u| merge(u, value)),
            );
        }
        Value::Object(result)
    } else {
        project.clone()
    }
}
fn segment(key: &str) -> String {
    key.replace('~', "~0").replace('.', "~1")
}
fn unsegment(key: &str) -> String {
    key.replace("~1", ".").replace("~0", "~")
}

pub(crate) fn value_at<'a>(raw: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(raw, |value, key| value.get(unsegment(key)))
}
pub(crate) fn set_path(raw: &mut Value, path: &str, value: Value) {
    let mut segments = path.split('.').map(unsegment).peekable();
    let mut current = raw;
    while let Some(segment) = segments.next() {
        if !current.is_object() {
            *current = json!({});
        }
        if segments.peek().is_none() {
            current[&segment] = value;
            return;
        }
        current = current
            .as_object_mut()
            .unwrap()
            .entry(segment)
            .or_insert(json!({}));
    }
}
pub(crate) fn remove_path(raw: &mut Value, path: &str) {
    if let Some((parent, key)) = path.rsplit_once('.') {
        let mut current = raw;
        for segment in parent.split('.') {
            if let Some(value) = current.get_mut(unsegment(segment)) {
                current = value;
            } else {
                return;
            }
        }
        if let Some(object) = current.as_object_mut() {
            object.remove(&unsegment(key));
        } else if let Some(array) = current.as_array_mut() {
            if let Ok(index) = key.parse::<usize>() {
                if index < array.len() {
                    array.remove(index);
                }
            }
        }
    } else if let Some(object) = raw.as_object_mut() {
        object.remove(path);
    }
}

fn validate(raw: &Value, tool_order: &[String], warnings: &mut Vec<Warning>) -> (Value, bool) {
    let mut tool_input = raw.get("protected_tools").cloned();
    let mut migrated = raw.clone();
    profiles::migrate(&mut migrated, warnings);
    let (parsed, issues) = schema_parse(&schema()["config"], Some(&migrated), "");
    let recovered = !issues.is_empty();
    let invalid_turn_two = issues.iter().any(|path| path == "historian.turn_two");
    let mut effective = if !recovered {
        parsed.unwrap()
    } else {
        let mut patched = raw.clone();
        let mut grouped = BTreeMap::<String, Vec<String>>::new();
        for path in issues {
            grouped
                .entry(path.split('.').next().unwrap_or("").to_owned())
                .or_default()
                .push(path);
        }
        for (key, paths) in grouped {
            let nested = raw.get(&key).is_some_and(Value::is_object)
                && paths.iter().all(|path| path.contains('.'));
            if nested {
                let mut complete = true;
                for path in paths {
                    if path == "historian.turn_two" {
                        // Removing the invalid leaf would re-enable the allowlist default.
                        set_path(&mut patched, &path, json!("off"));
                    } else {
                        complete &= prune(&mut patched, &path);
                    }
                }
                if !complete {
                    remove_path(&mut patched, &key);
                }
            } else {
                remove_path(&mut patched, &key);
            }
            warnings.push(Warning::new("invalid_leaf", "Invalid config value; valid siblings are retained. Invalid historian.turn_two uses off; other invalid leaves use defaults."));
        }
        tool_input = patched.get("protected_tools").cloned();
        profiles::migrate(&mut patched, warnings);
        let (retry, issues) = schema_parse(&schema()["config"], Some(&patched), "");
        if issues.is_empty() {
            retry.unwrap()
        } else {
            tool_input = None;
            warnings.push(Warning::new(
                "recovery_failed",
                "Config recovery failed; using all defaults.",
            ));
            let defaults = if invalid_turn_two {
                json!({"historian": {"turn_two": "off"}})
            } else {
                json!({})
            };
            schema_parse(&schema()["config"], Some(&defaults), "")
                .0
                .unwrap()
        }
    };
    if let Some(raw) = tool_input.filter(Value::is_object) {
        effective["protected_tools"] = merge(
            &json!({"todowrite":1,"ctx_reduce":3}),
            &trust::ordered_tools(&raw, tool_order),
        );
    }
    if let Some(hooks) = raw.get("disabled_hooks").and_then(Value::as_array) {
        effective["disabled_hooks"] =
            Value::Array(hooks.iter().filter(|v| v.is_string()).cloned().collect());
    }
    if let Some(command) = raw
        .get("command")
        .filter(|v| !v.is_null() && (v.is_object() || v.is_array()))
    {
        effective["command"] = command.clone();
    }
    (effective, recovered)
}

/// Interprets generated Zod input descriptors; custom refinements and transforms stay explicit.
pub(crate) fn schema_parse(
    node: &Value,
    input: Option<&Value>,
    path: &str,
) -> (Option<Value>, Vec<String>) {
    let kind = node["type"].as_str().unwrap_or("");
    if kind == "optional" && input.is_none() {
        return (None, vec![]);
    }
    if kind == "default" && input.is_none() {
        return (Some(node["value"].clone()), vec![]);
    }
    if kind == "nullable" && input == Some(&Value::Null) {
        return (Some(Value::Null), vec![]);
    }
    if ["optional", "default", "nullable"].contains(&kind) {
        return schema_parse(&node["inner"], input, path);
    }
    if kind == "transform" {
        let (value, issues) = schema_parse(&node["inner"], input, path);
        return if issues.is_empty() {
            (
                value.map(|value| transform(node["rule"].as_str().unwrap(), value)),
                issues,
            )
        } else {
            (value, issues)
        };
    }
    if kind == "unknown" || kind == "any" {
        return (input.cloned(), vec![]);
    }
    let Some(input) = input else {
        return (None, vec![path.into()]);
    };
    let mut issues = Vec::new();
    let mut output = input.clone();
    let valid = match kind {
        "boolean" => input.is_boolean(),
        "string" => input.is_string(),
        "number" => input.is_number(),
        "enum" | "literal" => node["values"].as_array().is_some_and(|v| v.contains(input)),
        "never" => false,
        "object" => {
            if let Some(object) = input.as_object() {
                let mut result = Map::new();
                for (key, child) in node["shape"].as_object().unwrap() {
                    let subpath = if path.is_empty() {
                        segment(key)
                    } else {
                        format!("{path}.{}", segment(key))
                    };
                    let (value, child_issues) = schema_parse(child, object.get(key), &subpath);
                    if let Some(value) = value {
                        result.insert(key.clone(), value);
                    }
                    issues.extend(child_issues);
                }
                if let Some(catchall) = node.get("catchall") {
                    for (key, value) in object {
                        if node["shape"].get(key).is_none() {
                            let (value, child_issues) = schema_parse(
                                catchall,
                                Some(value),
                                &format!("{path}.{}", segment(key)),
                            );
                            if let Some(value) = value {
                                result.insert(key.clone(), value);
                            }
                            issues.extend(child_issues);
                        }
                    }
                }
                output = Value::Object(result);
                true
            } else {
                false
            }
        }
        "record" => {
            if let Some(object) = input.as_object() {
                let mut result = Map::new();
                for (key, value) in object {
                    let subpath = format!("{path}.{}", segment(key));
                    let (key_value, key_issues) =
                        schema_parse(&node["key"], Some(&json!(key)), &subpath);
                    let (value, value_issues) = schema_parse(&node["value"], Some(value), &subpath);
                    issues.extend(key_issues);
                    issues.extend(value_issues);
                    if let Some(value) = value {
                        result.insert(
                            key_value
                                .and_then(|v| v.as_str().map(str::to_owned))
                                .unwrap_or(key.clone()),
                            value,
                        );
                    }
                }
                output = Value::Object(result);
                true
            } else {
                false
            }
        }
        "array" => {
            if let Some(array) = input.as_array() {
                let mut result = Vec::new();
                for (index, value) in array.iter().enumerate() {
                    let (value, child_issues) =
                        schema_parse(&node["element"], Some(value), &format!("{path}.{index}"));
                    if let Some(value) = value {
                        result.push(value);
                    }
                    issues.extend(child_issues);
                }
                output = Value::Array(result);
                true
            } else {
                false
            }
        }
        "union" => {
            let child_prefix = format!("{path}.");
            let mut nested_issues = Vec::new();
            let mut nested_depth = 0;
            for option in node["options"].as_array().unwrap() {
                let (value, option_issues) = schema_parse(option, Some(input), path);
                if option_issues.is_empty() {
                    return (value, vec![]);
                }
                // A matching object arm can identify a bad leaf even when the
                // union also accepts strings. Preserve that detail so recovery
                // removes only the bad leaf, as the TypeScript loader does.
                let depth = option_issues
                    .iter()
                    .map(|issue| issue.split('.').count())
                    .min()
                    .unwrap_or(0);
                if depth > nested_depth
                    && option_issues.iter().all(|issue| {
                        issue != path && (path.is_empty() || issue.starts_with(&child_prefix))
                    })
                {
                    nested_depth = depth;
                    nested_issues = option_issues;
                }
            }
            if !nested_issues.is_empty() {
                return (None, nested_issues);
            }
            false
        }
        _ => panic!("Unregistered generated schema type: {kind}"),
    };
    if !valid {
        return (None, vec![path.into()]);
    }
    if let Some(checks) = node.get("checks").and_then(Value::as_array) {
        for check in checks {
            let mut passed = true;
            match check["check"].as_str().unwrap_or("") {
                "trim" => {
                    if let Some(s) = output.as_str() {
                        output = json!(variables::trim(s));
                    }
                }
                "lowercase" => {
                    if let Some(s) = output.as_str() {
                        output = json!(s.to_lowercase());
                    }
                }
                "min_length" => {
                    passed = output.as_str().is_some_and(|s| {
                        s.encode_utf16().count() >= check["minimum"].as_u64().unwrap_or(0) as usize
                    })
                }
                "max_length" => {
                    passed = output.as_str().is_some_and(|s| {
                        s.encode_utf16().count()
                            <= check["maximum"].as_u64().unwrap_or(u64::MAX) as usize
                    })
                }
                "greater_than" => {
                    passed = output.as_f64().is_some_and(|n| {
                        if check["inclusive"] == true {
                            n >= check["value"].as_f64().unwrap()
                        } else {
                            n > check["value"].as_f64().unwrap()
                        }
                    })
                }
                "less_than" => {
                    passed = output.as_f64().is_some_and(|n| {
                        if check["inclusive"] == true {
                            n <= check["value"].as_f64().unwrap()
                        } else {
                            n < check["value"].as_f64().unwrap()
                        }
                    })
                }
                "number_format" => {
                    passed = output
                        .as_f64()
                        .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                }
                "string_format" => {
                    passed = output.as_str().is_some_and(|s| {
                        regex::Regex::new(check["pattern"].as_str().unwrap())
                            .expect("generated regex")
                            .is_match(s)
                    })
                }
                "custom" => {
                    let rule = check["rule"].as_str().unwrap();
                    if rule == "embedding" {
                        let provider = if output["provider"] == "synapse" {
                            output["fallback_provider"].as_str()
                        } else {
                            output["provider"].as_str()
                        };
                        if provider == Some("openai-compatible") {
                            for field in ["endpoint", "model"] {
                                if output
                                    .get(field)
                                    .and_then(Value::as_str)
                                    .is_none_or(|s| s.trim().is_empty())
                                {
                                    issues.push(format!("{path}.{field}"));
                                }
                            }
                        }
                    } else {
                        passed = custom(rule, &output);
                    }
                }
                other => panic!("Unregistered generated schema check: {other}"),
            }
            if !passed {
                issues.push(path.into());
            }
        }
    }
    (Some(output), issues)
}
fn transform(rule: &str, value: Value) -> Value {
    match rule {
        "protected_tools" => merge(
            &json!({"todowrite":1,"ctx_reduce":3}),
            &trust::protected_tools(&value),
        ),
        "subc.connection_file" => value,
        "rerank.timeout_ms" => json!(value.as_i64().unwrap_or(1500).clamp(50, 15_000)),
        "embedding" => {
            let provider = value["provider"].as_str().unwrap_or("local");
            if provider == "off" {
                return json!({"provider":"off"});
            }
            let mut result = json!({"provider":provider});
            if provider == "local" {
                result["model"] = json!(value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Xenova/all-MiniLM-L6-v2"));
                result["local_runtime"] = value["local_runtime"].clone();
                if let Some(dtype) = value.get("local_dtype") {
                    result["local_dtype"] = dtype.clone();
                }
            } else {
                for key in [
                    "model",
                    "endpoint",
                    "api_key",
                    "input_type",
                    "query_input_type",
                    "truncate",
                ] {
                    if let Some(s) = value.get(key).and_then(Value::as_str) {
                        let s = variables::trim(s);
                        if !s.is_empty()
                            || provider == "openai-compatible"
                                && ["model", "endpoint"].contains(&key)
                        {
                            result[key] = json!(s);
                        }
                    }
                }
                for key in ["fallback_provider", "query_instruction", "document_prefix"] {
                    if let Some(value) = value.get(key) {
                        result[key] = value.clone();
                    }
                }
            }
            if let Some(tokens) = value.get("max_input_tokens") {
                result["max_input_tokens"] = tokens.clone();
            }
            result
        }
        _ => panic!("Unregistered generated schema transform: {rule}"),
    }
}
fn custom(rule: &str, value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    match rule {
        "language" => schema()["languages"].as_array().unwrap().contains(value),
        "prompt_surface.models#key" => {
            if s.is_empty() || variables::trim(s) != s {
                return false;
            }
            if let Some((provider, model)) = s.split_once('/') {
                !provider.is_empty()
                    && !model.is_empty()
                    && variables::trim(provider) == provider
                    && variables::trim(model) == model
                    && !provider.contains('*')
                    && (model == "*"
                        || !model.contains('*')
                            && !model.starts_with('/')
                            && !model.ends_with('/')
                            && !model.contains("//"))
            } else {
                !s.contains('*')
            }
        }
        "prompt_surface.tool_descriptions#key"
        | "prompt_surface.tool_descriptions.*"
        | "prompt_surface.guidance_override_path" => !variables::trim(s).is_empty(),
        "historian.expand_tools.*" => profiles::valid_template(s),
        _ if rule.ends_with(".schedule") => valid_cron(s),
        _ => panic!("Unregistered generated schema refinement: {rule}"),
    }
}
fn valid_cron(s: &str) -> bool {
    if variables::trim(s).is_empty() {
        return true;
    }
    let fields: Vec<_> = s.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    for (field, (min, max)) in fields
        .into_iter()
        .zip([(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)])
    {
        for part in field.split(',') {
            let parts: Vec<_> = part.split('/').collect();
            if parts.len() > 2 || parts.len() == 2 && number(parts[1]).is_none_or(|n| n == 0) {
                return false;
            }
            let range = parts[0];
            let bounds = if range == "*" {
                Some((min, max))
            } else if let Some((lo, hi)) = range.split_once('-') {
                number(lo).zip(number(hi))
            } else {
                number(range).map(|n| (n, if parts.len() == 2 { max } else { n }))
            };
            if bounds.is_none_or(|(lo, hi)| lo < min || hi > max || lo > hi) {
                return false;
            }
        }
    }
    true
}

fn prune(raw: &mut Value, path: &str) -> bool {
    let segments: Vec<_> = path.split('.').map(unsegment).collect();
    let mut current = raw;
    for segment in &segments[..segments.len() - 1] {
        if !current.get(segment).is_some_and(Value::is_object) {
            return current
                .as_object_mut()
                .is_some_and(|object| object.remove(segment).is_some());
        }
        current = current.get_mut(segment).unwrap();
    }
    current
        .as_object_mut()
        .is_some_and(|object| object.remove(segments.last().unwrap()).is_some())
}
