//! `tool.catalog` and `role.describe`: Magic Context's answers under the
//! `tool-provider/v1` role (commons `cortexkit-role-tool-provider`).
//!
//! Pinned request/response fixtures in `src/tests/fixtures/tool-catalog/`
//! hold the exact bytes this module serves; tests compare them byte for byte.
//!
//! Everything the answer says comes from one shared definition,
//! `assets/tool_catalog_v1.json`: the
//! tools, their argument-schema structures, descriptions and parameter
//! descriptions, and the guidance templates. The fixture generator
//! (`gen/gen-tool-catalog.ts`) reads the same files and
//! checks them against the plugin's shipped strings.
//!
//! The answer is a pure function of the request (preset, params, composition,
//! system-text item) and the user and project configuration. Session identity,
//! agent and route scope never enter a byte of it, and nothing here reads the
//! store.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use cortexkit_role_tool_provider::catalog::{self, CatalogRequest, SystemTextItem};
use cortexkit_role_tool_provider::{errors, ops, PROVIDES};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use subc_client_rs::HandlerOutcome;

use crate::config::McModuleConfig;

const DEFINITION_JSON: &str = include_str!("../assets/tool_catalog_v1.json");
const TOOLS_ONLY_FULL: &str = include_str!("../assets/catalog_tools_only.txt");
const TOOLS_ONLY_LIGHT: &str = include_str!("../assets/catalog_tools_only_light.txt");

/// The `format` the shared definition must declare. A file declaring anything
/// else was written for a different layout, and loading it fails.
const DEFINITION_FORMAT: &str = "magic-context/tool-catalog-definition/1";

/// The `format` member of the value `system_text.preflight_digest` hashes.
const PREFLIGHT_FORMAT: &str = "magic-context/preflight/1";

/// The `provider` value that marks Magic Context's own entry in a composition.
const MODULE_ID: &str = crate::DEFAULT_MODULE_ID;

/// The tools the compaction guidance texts name. A session without one of them
/// has no accurate text yet, so a text request for it is refused rather than
/// served a text that names a missing tool.
const TEXT_REQUIRED_TOOLS: [&str; 3] = ["ctx_expand", "ctx_search", "ctx_note"];

/// The structural digest `ctx_reduce`'s schema must keep for all of v1. The
/// Claude Code gateway grants stamping only to a `ctx_reduce` whose name and
/// schema both match, so a different digest would silently turn stamping off
/// there; any change ships together with the gateway change that recognises it.
pub(crate) const FROZEN_CTX_REDUCE_SCHEMA_DIGEST: &str =
    "69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6";

/// The params a tool item may carry: the role's shared vocabulary plus `model`
/// and a compacting hint for preflight requests.
const TOOL_PARAMS: [&str; 6] = [
    "scope",
    "tool_descs",
    "exclude",
    "behavior",
    "model",
    "compacting",
];
/// The params a system-text item may carry.
const TEXT_PARAMS: [&str; 3] = ["surface", "model", "compacting"];

/// One tool as the shared definition declares it.
#[derive(Debug, Deserialize)]
pub(crate) struct ToolDefinition {
    pub name: String,
    pub capabilities: Vec<String>,
    pub result_ops: Vec<String>,
    pub semantics: u64,
    /// Served under `scope: read`: the tool writes no project data.
    pub read_scope: bool,
    /// The argument schema without descriptions.
    pub structure: Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Definition {
    format: String,
    /// In catalog order.
    pub tools: Vec<ToolDefinition>,
    /// Allowed tools by preset, before config and request filtering.
    preset_tools: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    /// Transitional input spellings, shared with the TypeScript generator.
    preset_aliases: BTreeMap<String, String>,
    /// Descriptions by surface and tool, with separate non-compacting overrides.
    descriptions: Value,
    /// `{full: {tool: {param: text}}, light: ...}`.
    parameter_descriptions: Value,
    /// Guidance templates and the fragments they include, by name.
    texts: BTreeMap<String, String>,
    /// English-plus-endonym names captured from the TypeScript ICU runtime.
    pub language_names: BTreeMap<String, String>,
}

/// The shared definition, parsed once. The files are compiled in, so a
/// malformed one is a build defect the tests catch before it ships.
pub(crate) fn definition() -> &'static Definition {
    static DEFINITION: OnceLock<Definition> = OnceLock::new();
    DEFINITION.get_or_init(|| {
        let mut definition: Definition =
            serde_json::from_str(DEFINITION_JSON).expect("assets/tool_catalog_v1.json parses");
        assert_eq!(
            definition.format, DEFINITION_FORMAT,
            "assets/tool_catalog_v1.json declares another format"
        );
        // The tools-only texts live in their own files so they read as plain
        // text; they join the definition under these names.
        definition
            .texts
            .insert("tools_only/full".to_string(), TOOLS_ONLY_FULL.to_string());
        definition
            .texts
            .insert("tools_only/light".to_string(), TOOLS_ONLY_LIGHT.to_string());
        definition
    })
}

impl Definition {
    pub(crate) fn tool(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    pub(crate) fn description(&self, surface: Surface, tool: &str) -> Option<&str> {
        self.descriptions
            .get(surface.as_str())
            .and_then(|table| table.get(tool))
            .and_then(Value::as_str)
    }

    fn parameter_description(&self, surface: Surface, tool: &str, param: &str) -> Option<&str> {
        self.parameter_descriptions
            .get(surface.as_str())
            .and_then(|table| table.get(tool))
            .and_then(|table| table.get(param))
            .and_then(Value::as_str)
    }
}

/// Light or full wording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Surface {
    Full,
    Light,
}

impl Surface {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "full" => Some(Self::Full),
            "light" => Some(Self::Light),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Light => "light",
        }
    }
}

/// Fleet roles. Compaction is selected separately by the frozen composition,
/// never inferred from a preset name (including a transitional alias).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Preset {
    Head,
    Worker,
    Reader,
}

impl Preset {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Head => "head",
            Self::Worker => "worker",
            Self::Reader => "reader",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        let name = definition()
            .preset_aliases
            .get(value)
            .map_or(value, String::as_str);
        match name {
            "head" => Some(Self::Head),
            "worker" => Some(Self::Worker),
            "reader" => Some(Self::Reader),
            _ => None,
        }
    }

    fn tools(self, compacting: bool) -> &'static [String] {
        &definition().preset_tools[if compacting {
            "compacting"
        } else {
            "not_compacting"
        }][self.as_str()]
    }

    pub(crate) fn serves(self, name: &str, compacting: bool) -> bool {
        self.tools(compacting).iter().any(|tool| tool == name)
    }
}

/// A preflight has no composition, so its compacting param previews the tools
/// the eventual composition will request. Once a composition exists, its
/// compaction provider remains authoritative and explicit params must agree.
pub(crate) fn compacts_session(arguments: &Value) -> Result<bool, CatalogError> {
    let composition_compacting = if let Some(compaction) = arguments
        .get("composition")
        .and_then(|value| value.get("compaction"))
    {
        let provider = compaction
            .as_object()
            .and_then(|item| item.get("provider"))
            .and_then(Value::as_str)
            .filter(|provider| !provider.is_empty())
            .ok_or_else(|| {
                CatalogError::invalid(
                    "composition.compaction",
                    "compaction must be an object with a non-empty provider",
                )
            })?;
        provider == MODULE_ID
    } else {
        false
    };
    let has_composition = arguments
        .get("composition")
        .and_then(Value::as_object)
        .is_some();
    let parameter_compacting = arguments
        .get("params")
        .and_then(|params| params.get("compacting"))
        .and_then(Value::as_bool);
    let text_parameter_compacting = arguments
        .get("system_text")
        .and_then(|item| item.get("params"))
        .and_then(|params| params.get("compacting"))
        .and_then(Value::as_bool);
    if has_composition
        && [parameter_compacting, text_parameter_compacting]
            .into_iter()
            .flatten()
            .any(|compacting| compacting != composition_compacting)
    {
        return Err(CatalogError::invalid(
            "params.compacting",
            "compacting must agree with composition.compaction.provider",
        ));
    }
    if has_composition {
        Ok(composition_compacting)
    } else {
        Ok(parameter_compacting.unwrap_or(false))
    }
}

/// Process-local copy of the admitted catalog, shared by the session's routes.
/// Callers send a preset, not a mutable assertion about who compacts them.
#[derive(Clone, Debug)]
pub(crate) struct FrozenCatalog {
    pub compacting: bool,
    pub tools: BTreeSet<String>,
}

/// The configuration a catalog answer depends on, resolved from the user and
/// project tiers. `resolved_json` is the form `preflight_digest` hashes, and
/// matches `config.json` beside the design's examples member for member.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CatalogConfig {
    pub smart_notes_enabled: bool,
    pub compaction_enabled: bool,
    pub memory_enabled: bool,
    pub dreamer_runnable: bool,
    pub temporal_awareness: bool,
    pub caveman_text_compression: bool,
    pub language: Option<String>,
    pub surface_default: Surface,
    pub surface_models: BTreeMap<String, Surface>,
    /// The user's own replacement for the primary guidance section, if any.
    pub guidance_override: Option<String>,
    /// User-tier description overrides, by tool name.
    pub tool_descriptions: BTreeMap<String, String>,
    /// Tools the configuration disables by exact name. Magic Context's config
    /// has no such setting yet, so this is empty outside tests.
    pub disabled_tools: Vec<String>,
}

impl CatalogConfig {
    pub(crate) fn from_module_config(config: &McModuleConfig) -> Self {
        let definition = definition();
        let inputs = &config.catalog;
        Self {
            compaction_enabled: config.compaction_enabled,
            smart_notes_enabled: config.smart_notes_enabled,
            memory_enabled: config.memory_enabled,
            dreamer_runnable: inputs.dreamer_runnable,
            temporal_awareness: config.temporal_awareness,
            caveman_text_compression: config.caveman.enabled,
            language: config.language.clone(),
            surface_default: inputs
                .prompt_surface_default
                .as_deref()
                .and_then(Surface::parse)
                .unwrap_or(Surface::Full),
            surface_models: inputs
                .prompt_surface_models
                .iter()
                .filter_map(|(key, value)| Surface::parse(value).map(|s| (key.clone(), s)))
                .collect(),
            guidance_override: config.prompt_surface_guidance_override.clone(),
            // Only names the catalog serves can be overridden; anything else
            // would change preflight_digest without changing a served byte.
            tool_descriptions: inputs
                .tool_descriptions
                .iter()
                .filter(|(tool, _)| definition.tool(tool).is_some())
                .map(|(tool, text)| (tool.clone(), text.clone()))
                .collect(),
            disabled_tools: Vec::new(),
        }
    }

    fn resolved_json(&self) -> Value {
        let models: Map<String, Value> = self
            .surface_models
            .iter()
            .map(|(key, surface)| (key.clone(), json!(surface.as_str())))
            .collect();
        let mut resolved = json!({
            "compaction_enabled": self.compaction_enabled,
            "memory_enabled": self.memory_enabled,
            "dreamer_runnable": self.dreamer_runnable,
            "temporal_awareness": self.temporal_awareness,
            "caveman_text_compression": self.caveman_text_compression,
            "language": self.language,
            "prompt_surface": {"default": self.surface_default.as_str(), "models": models},
            "guidance_override_sha256": self.guidance_override.as_deref().map(sha256_hex),
            "tool_descriptions": self.tool_descriptions,
            "disabled_tools": self.disabled_tools,
        });
        if !self.smart_notes_enabled {
            resolved["smart_notes_enabled"] = json!(false);
        }
        resolved
    }

    /// The surface from Magic Context's own config: the request's `model`
    /// param (frozen with the session's plan) looked up in
    /// `prompt_surface.models`, then `prompt_surface.default`.
    fn surface_for_model(&self, model: Option<&str>) -> Surface {
        model
            .into_iter()
            .flat_map(model_key_candidates)
            .find_map(|candidate| self.surface_models.get(&candidate).copied())
            .unwrap_or(self.surface_default)
    }
}

/// Why a catalog request gets no answer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CatalogError {
    /// The request is malformed or asks for something Magic Context does not
    /// define: `invalid_request` naming the offending field.
    Invalid { field: String, message: String },
    /// The shipped definition could not produce the answer. A build defect.
    Internal(String),
}

impl CatalogError {
    pub(crate) fn unserved_preset(name: &str) -> Self {
        Self::invalid(
            "preset",
            format!("Magic Context defines no preset {name:?}"),
        )
    }
    fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Invalid {
            field: field.into(),
            message: message.into(),
        }
    }

    pub(crate) fn into_outcome(self) -> HandlerOutcome {
        match self {
            Self::Invalid { field, message } => {
                let body = errors::invalid_request(&field, message);
                HandlerOutcome::ErrorWithDetail {
                    code: body.code,
                    message: body.message,
                    detail: body.detail.unwrap_or(Value::Null),
                }
            }
            Self::Internal(message) => HandlerOutcome::Error {
                code: "internal_error".to_string(),
                message,
            },
        }
    }
}

/// The `tool.catalog` answer's bytes (RFC 8785 canonical JSON) for the
/// request `arguments`.
pub(crate) fn catalog_answer_bytes(
    arguments: &Value,
    config: &CatalogConfig,
) -> Result<Vec<u8>, CatalogError> {
    let answer = catalog_answer(arguments, config)?;
    jcs_bytes(&answer)
}

/// The `role.describe` answer's bytes. It depends only on the build.
pub(crate) fn role_describe_bytes() -> Result<Vec<u8>, CatalogError> {
    let mut capabilities = vec!["compacting-preflight/v1".to_string()];
    capabilities.extend(crate::project_bind_capabilities());
    jcs_bytes(&json!({
        "majors": [{
            "version": PROVIDES,
            "ops": [ops::ROLE_DESCRIBE, ops::TOOL_CATALOG, ops::USER_COMMAND_INVOKE, ops::LATE_RESULTS, ops::LATE_RESULTS_ACK],
            "stability": "alpha",
        }],
        "implementation_version": crate::version_line(),
        "capabilities": capabilities,
    }))
}

pub(crate) fn catalog_answer(
    arguments: &Value,
    config: &CatalogConfig,
) -> Result<Value, CatalogError> {
    if !arguments.is_object() {
        return Err(CatalogError::invalid(
            "arguments",
            "tool.catalog arguments must be an object",
        ));
    }
    let request: CatalogRequest = serde_json::from_value(arguments.clone()).map_err(|error| {
        CatalogError::invalid("arguments", format!("tool.catalog arguments: {error}"))
    })?;
    let preset = request_preset(&request)?;
    check_tool_params(&request.params)?;
    if let Some(item) = &request.system_text {
        check_text_params(&item.params)?;
    }
    let compacting = compacts_session(arguments)?;
    let served = served_tools(preset, compacting, &request.params, config);
    let own = own_tool_names(&request, &served);
    if request.composition.is_some() {
        let listed: BTreeSet<&str> = own.iter().map(String::as_str).collect();
        let serving: BTreeSet<&str> = served.iter().map(|tool| tool.name.as_str()).collect();
        if listed != serving {
            return Err(CatalogError::invalid(
                "composition",
                format!(
                    "the composition lists {listed:?} under {MODULE_ID}, but this request serves {serving:?}"
                ),
            ));
        }
    }
    let composition_digest = request
        .composition
        .as_ref()
        .map(|composition| catalog::composition_digest(&Value::Object(composition.clone())))
        .transpose()
        .map_err(|error| CatalogError::invalid("composition", error.to_string()))?;

    let mut content = Map::new();
    if request.preset.is_none() {
        content.insert(
            "presets".to_string(),
            json!([
                Preset::Head.as_str(),
                Preset::Worker.as_str(),
                Preset::Reader.as_str()
            ]),
        );
    }
    if let Some(digest) = &composition_digest {
        content.insert("composition_digest".to_string(), json!(digest));
    }
    let surface = tool_surface(&request.params, config);
    let tools = served
        .iter()
        .map(|tool| catalog_tool(tool, surface, compacting, config))
        .collect::<Result<Vec<_>, _>>()?;
    content.insert("tools".to_string(), Value::Array(tools));
    if compacting && preset == Preset::Head {
        let declared = catalog::CatalogAnswer::new("", "").with_user_commands(vec![
            cortexkit_role_tool_provider::user_command::UserCommand::new(
                "ctx-status",
                "Show magic context status, pending queue, cache TTL, and debug info",
            ),
            cortexkit_role_tool_provider::user_command::UserCommand::new(
                "ctx-flush",
                "Force-process all pending magic context operations immediately",
            ),
            cortexkit_role_tool_provider::user_command::UserCommand::new(
                "ctx-wrapup",
                "Summarize older history while keeping the newest N messages with optional keep-N",
            ),
        ]);
        content.insert("user_commands".into(), json!(declared.user_commands));
        content.insert("capabilities".into(), json!({"late_results":true}));
    }
    if let Some(item) = &request.system_text {
        let text_compacting = item
            .params
            .get("compacting")
            .and_then(Value::as_bool)
            .unwrap_or(compacting);
        let text = guidance_text(preset, text_compacting, item, &own, config)?;
        let mut system_text = Map::new();
        system_text.insert("item_digest".to_string(), json!(sha256_hex(&text)));
        system_text.insert(
            "preflight_digest".to_string(),
            json!(preflight_digest(item, config)?),
        );
        if let Some(digest) = &composition_digest {
            system_text.insert("composition_digest".to_string(), json!(digest));
        }
        system_text.insert("tool_names".to_string(), json!(own));
        system_text.insert("text".to_string(), Value::String(text));
        content.insert("system_text".to_string(), Value::Object(system_text));
    }
    let catalog_digest = sha256_hex_bytes(&jcs_bytes(&Value::Object(content.clone()))?);
    let mut answer = Map::new();
    answer.insert("generation".to_string(), json!(catalog_digest));
    answer.insert("catalog_digest".to_string(), json!(catalog_digest));
    if request.digest_only != Some(true) {
        answer.extend(content);
    }
    Ok(Value::Object(answer))
}

fn request_preset(request: &CatalogRequest) -> Result<Preset, CatalogError> {
    let name = request.preset.as_deref().unwrap_or("head");
    let preset = Preset::parse(name).ok_or_else(|| CatalogError::unserved_preset(name))?;
    if let Some(item) = &request.system_text {
        let text_name = item.preset.as_deref().unwrap_or("head");
        let text_preset =
            Preset::parse(text_name).ok_or_else(|| CatalogError::unserved_preset(text_name))?;
        if text_preset != preset {
            return Err(CatalogError::invalid(
                "system_text.preset",
                format!(
                    "the text item's preset {:?} must be the tool item's {name:?}",
                    text_name
                ),
            ));
        }
    }
    Ok(preset)
}

fn check_tool_params(params: &Map<String, Value>) -> Result<(), CatalogError> {
    for (key, value) in params {
        let field = format!("params.{key}");
        let valid = match key.as_str() {
            "scope" => one_of(value, &["read", "readwrite", "all"]),
            "tool_descs" => one_of(value, &["concise", "full"]),
            "behavior" => one_of(value, &["autonomous", "interactive"]),
            "model" => value.is_string(),
            "compacting" => value.is_boolean(),
            "exclude" => value.as_array().is_some_and(|names| {
                names.iter().all(|name| {
                    name.as_str()
                        .is_some_and(|name| definition().tool(name).is_some())
                })
            }),
            _ => {
                return Err(CatalogError::invalid(
                    field,
                    format!("unknown param {key:?}; Magic Context accepts {TOOL_PARAMS:?}"),
                ))
            }
        };
        if !valid {
            return Err(CatalogError::invalid(
                field,
                format!("unsupported value {value} for param {key:?}"),
            ));
        }
    }
    Ok(())
}

fn check_text_params(params: &Map<String, Value>) -> Result<(), CatalogError> {
    for (key, value) in params {
        let field = format!("system_text.params.{key}");
        let valid = match key.as_str() {
            "surface" => one_of(value, &["light", "full"]),
            "model" => value.is_string(),
            "compacting" => value.is_boolean(),
            _ => {
                return Err(CatalogError::invalid(
                    field,
                    format!("unknown text param {key:?}; Magic Context accepts {TEXT_PARAMS:?}"),
                ))
            }
        };
        if !valid {
            return Err(CatalogError::invalid(
                field,
                format!("unsupported value {value} for text param {key:?}"),
            ));
        }
    }
    Ok(())
}

fn one_of(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|value| allowed.contains(&value))
}

fn served_tools(
    preset: Preset,
    compacting: bool,
    params: &Map<String, Value>,
    config: &CatalogConfig,
) -> Vec<&'static ToolDefinition> {
    let excluded: BTreeSet<&str> = params
        .get("exclude")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let read_only = params.get("scope").and_then(Value::as_str) == Some("read");
    definition()
        .tools
        .iter()
        .filter(|tool| {
            let name = tool.name.as_str();
            !(name == "ctx_reduce" && !config.compaction_enabled)
                && preset.serves(name, compacting)
                && !(name == "ctx_memory" && !config.memory_enabled)
                && !config
                    .disabled_tools
                    .iter()
                    .any(|disabled| disabled == name)
                && !excluded.contains(name)
                && !(read_only && !tool.read_scope)
        })
        .collect()
}

/// Magic Context's own tool names as the request's composition lists them. A
/// preflight request carries no composition, so the served names stand in.
fn own_tool_names(request: &CatalogRequest, served: &[&ToolDefinition]) -> BTreeSet<String> {
    let Some(composition) = &request.composition else {
        return served.iter().map(|tool| tool.name.clone()).collect();
    };
    composition
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers
                .iter()
                .find(|entry| entry.get("provider").and_then(Value::as_str) == Some(MODULE_ID))
        })
        .and_then(|entry| entry.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn tool_surface(params: &Map<String, Value>, config: &CatalogConfig) -> Surface {
    match params.get("tool_descs").and_then(Value::as_str) {
        Some("concise") => Surface::Light,
        Some("full") => Surface::Full,
        _ => config.surface_for_model(params.get("model").and_then(Value::as_str)),
    }
}

fn text_surface(params: &Map<String, Value>, config: &CatalogConfig) -> Surface {
    params
        .get("surface")
        .and_then(Value::as_str)
        .and_then(Surface::parse)
        .unwrap_or_else(|| config.surface_for_model(params.get("model").and_then(Value::as_str)))
}

/// The tool's argument schema at `surface`: its structure with each property's
/// description added.
pub(crate) fn input_schema(tool: &ToolDefinition, surface: Surface) -> Result<Value, CatalogError> {
    let mut schema = tool.structure.clone();
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return Err(CatalogError::Internal(format!(
            "{}'s structure has no properties",
            tool.name
        )));
    };
    for (param, property) in properties.iter_mut() {
        let text = definition()
            .parameter_description(surface, &tool.name, param)
            .ok_or_else(|| {
                CatalogError::Internal(format!(
                    "no {} description for {}.{param}",
                    surface.as_str(),
                    tool.name
                ))
            })?;
        let Some(property) = property.as_object_mut() else {
            return Err(CatalogError::Internal(format!(
                "{}.{param} is not a schema object",
                tool.name
            )));
        };
        property.insert("description".to_string(), json!(text));
    }
    Ok(schema)
}

fn catalog_tool(
    tool: &ToolDefinition,
    surface: Surface,
    compacting: bool,
    config: &CatalogConfig,
) -> Result<Value, CatalogError> {
    let mut schema = input_schema(tool, surface)?;
    if tool.name == "ctx_note" && !config.smart_notes_enabled {
        crate::prompt_surface::disable_smart_note_schema(&mut schema);
    }
    let schema_digest = catalog::schema_digest(&schema)
        .map_err(|error| CatalogError::Internal(error.to_string()))?;
    if tool.name == "ctx_reduce" && schema_digest != FROZEN_CTX_REDUCE_SCHEMA_DIGEST {
        return Err(CatalogError::Internal(format!(
            "ctx_reduce's schema digest is {schema_digest}, but it is frozen for v1 at \
             {FROZEN_CTX_REDUCE_SCHEMA_DIGEST}; change it only together with the gateway"
        )));
    }
    let description = match config.tool_descriptions.get(&tool.name) {
        Some(text) => text.as_str(),
        None => (!compacting)
            .then(|| {
                definition()
                    .descriptions
                    .get("not_compacting")?
                    .get(surface.as_str())?
                    .get(&tool.name)?
                    .as_str()
            })
            .flatten()
            .or_else(|| definition().description(surface, &tool.name))
            .ok_or_else(|| {
                CatalogError::Internal(format!(
                    "no {} description for {}",
                    surface.as_str(),
                    tool.name
                ))
            })?,
    };
    let description = if tool.name == "ctx_note" && !config.smart_notes_enabled {
        crate::prompt_surface::without_smart_note_description(
            definition()
                .description(surface, &tool.name)
                .unwrap_or(description),
        )
    } else {
        description.to_string()
    };
    Ok(json!({
        "name": tool.name,
        "schema_digest": schema_digest,
        "semantics": tool.semantics,
        "result_ops": tool.result_ops,
        "capabilities": tool.capabilities,
        "description": description,
        "input_schema": schema,
    }))
}

fn guidance_text(
    preset: Preset,
    compacting: bool,
    item: &SystemTextItem,
    own: &BTreeSet<String>,
    config: &CatalogConfig,
) -> Result<String, CatalogError> {
    if !compacting && preset != Preset::Head {
        return Ok(String::new());
    }
    let required: &[&str] = if !compacting {
        &["ctx_search", "ctx_note"]
    } else if preset != Preset::Head {
        &["ctx_expand", "ctx_search"]
    } else {
        &TEXT_REQUIRED_TOOLS
    };
    if let Some(missing) = required.iter().find(|tool| !own.contains(**tool)) {
        return Err(CatalogError::invalid(
            "system_text",
            format!("no shipped text describes a session without {missing}"),
        ));
    }
    let surface = text_surface(&item.params, config).as_str();
    let directive = crate::prompt_surface::primary_language_directive(config.language.as_deref());
    let flags = TextFlags {
        memory: config.memory_enabled && own.contains("ctx_memory"),
        dreamer: config.dreamer_runnable && config.smart_notes_enabled,
        temporal: config.temporal_awareness,
        caveman: config.caveman_text_compression,
        language: !directive.is_empty(),
    };
    let mut values = BTreeMap::new();
    values.insert("language_directive", directive);
    let reduce = own.contains("ctx_reduce");
    let name = match preset {
        // A subagent without ctx_reduce has no tagged messages, so it gets no
        // guidance at all; the runner skips an empty text.
        Preset::Worker | Preset::Reader if !reduce => return Ok(String::new()),
        Preset::Worker | Preset::Reader => format!("worker/{surface}"),
        Preset::Head => match &config.guidance_override {
            // A user's override replaces the whole primary section; the
            // runtime clauses (temporal, caveman, language) still follow it.
            Some(text) => {
                values.insert(
                    "override",
                    if config.smart_notes_enabled {
                        text.clone()
                    } else {
                        crate::prompt_surface::without_smart_note_guidance(text)
                    },
                );
                "override".to_string()
            }
            None if !compacting => format!("tools_only/{surface}"),
            None if reduce => format!("head/reduce/{surface}"),
            None => format!("head/no_reduce/{surface}"),
        },
    };
    render_text(&name, &flags, &values).map_err(CatalogError::Internal)
}

fn preflight_digest(item: &SystemTextItem, config: &CatalogConfig) -> Result<String, CatalogError> {
    let value = json!({
        "format": PREFLIGHT_FORMAT,
        "preset": item.preset.as_deref().unwrap_or("head"),
        "params": item.params,
        "config": config.resolved_json(),
        "text_revision": text_revision()?,
    });
    Ok(sha256_hex_bytes(&jcs_bytes(&value)?))
}

/// A digest of every model-facing string the build ships: every guidance
/// template and fragment (the tools-only texts included), every description,
/// every parameter description, and the generated ICU language names. It sits
/// inside `preflight_digest`, so a deploy that only rewords text still changes
/// the digest a session's owner compares to notice new wording.
pub(crate) fn text_revision() -> Result<String, CatalogError> {
    let definition = definition();
    let value = json!({
        "texts": definition.texts,
        "descriptions": definition.descriptions,
        "parameters": definition.parameter_descriptions,
        "language_names": definition.language_names,
    });
    Ok(sha256_hex_bytes(&jcs_bytes(&value)?))
}

/// The config switches a guidance template may test.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TextFlags {
    pub memory: bool,
    pub dreamer: bool,
    pub temporal: bool,
    pub caveman: bool,
    pub language: bool,
}

impl TextFlags {
    fn get(&self, flag: &str) -> Option<bool> {
        match flag {
            "memory" => Some(self.memory),
            "dreamer" => Some(self.dreamer),
            "temporal" => Some(self.temporal),
            "caveman" => Some(self.caveman),
            "language" => Some(self.language),
            _ => None,
        }
    }
}

/// Render the definition's text `name`. A template is literal text with four
/// kinds of tag:
///
/// - `{{name}}` includes the definition's text `name`, rendered the same way;
/// - `{{$name}}` inserts the runtime value `name` verbatim (never rendered, so
///   a user's override may contain braces);
/// - `{{#flag}}…{{/flag}}` keeps its body only when `flag` is on, and
///   `{{^flag}}…{{/flag}}` only when it is off. Sections nest, and a closing
///   tag names the section it closes.
///
/// Anything else between `{{` and `}}`, an unknown name, value or flag, or an
/// unclosed section is an error. `renderText` in the design's generator
/// follows the same rules, and the guidance-matrix test holds the two to the
/// same bytes.
pub(crate) fn render_text(
    name: &str,
    flags: &TextFlags,
    values: &BTreeMap<&str, String>,
) -> Result<String, String> {
    let template = definition()
        .texts
        .get(name)
        .ok_or_else(|| format!("no text named {name}"))?;
    let mut out = String::new();
    // Each open section: its flag, and whether its body is kept.
    let mut open: Vec<(&str, bool)> = Vec::new();
    let mut rest = template.as_str();
    loop {
        let keeping = open.iter().all(|(_, keep)| *keep);
        let Some(start) = rest.find("{{") else {
            if keeping {
                out.push_str(rest);
            }
            break;
        };
        if keeping {
            out.push_str(&rest[..start]);
        }
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| format!("{name}: unterminated tag"))?;
        let tag = &after[..end];
        rest = &after[end + 2..];
        let mut chars = tag.chars();
        match chars.next() {
            Some(sigil @ ('#' | '^')) => {
                let flag = chars.as_str();
                let on = flags
                    .get(flag)
                    .ok_or_else(|| format!("{name}: unknown flag {flag}"))?;
                open.push((flag, if sigil == '#' { on } else { !on }));
            }
            Some('/') => {
                let flag = chars.as_str();
                match open.pop() {
                    Some((open_flag, _)) if open_flag == flag => {}
                    _ => return Err(format!("{name}: {{{{/{flag}}}}} closes nothing open")),
                }
            }
            Some('$') => {
                let key = chars.as_str();
                let value = values
                    .get(key)
                    .ok_or_else(|| format!("{name}: no value {key}"))?;
                if keeping {
                    out.push_str(value);
                }
            }
            _ if !tag.is_empty()
                && tag
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'/') =>
            {
                if keeping {
                    out.push_str(&render_text(tag, flags, values)?);
                }
            }
            _ => return Err(format!("{name}: malformed tag {{{{{tag}}}}}")),
        }
    }
    if let Some((flag, _)) = open.first() {
        return Err(format!("{name}: section {flag} is never closed"));
    }
    Ok(out)
}

// ── Model-key lookup ─────────────────────────────────────────────────────

/// Provider aliases Pi uses for canonical (OpenCode) providers.
const PI_TO_CANONICAL: &[(&str, &str)] =
    &[("openai-codex", "openai"), ("google-antigravity", "google")];
const CANONICAL_TO_PI: &[(&str, &str)] =
    &[("openai", "openai-codex"), ("google", "google-antigravity")];
/// Provider aliases OMP uses; it also renames the OpenCode Zen gateway.
const OMP_TO_CANONICAL: &[(&str, &str)] = &[
    ("openai-codex", "openai"),
    ("google-antigravity", "google"),
    ("opencode-zen", "opencode"),
];
const CANONICAL_TO_OMP: &[(&str, &str)] = &[
    ("openai", "openai-codex"),
    ("google", "google-antigravity"),
    ("opencode", "opencode-zen"),
];

/// Rewrite only the provider prefix (the text before the first `/`).
fn remap_provider(reference: &str, map: &[(&str, &str)]) -> String {
    let Some(slash) = reference.find('/').filter(|slash| *slash > 0) else {
        return reference.to_string();
    };
    let provider = &reference[..slash];
    match map.iter().find(|(from, _)| *from == provider) {
        Some((_, to)) => format!("{to}{}", &reference[slash..]),
        None => reference.to_string(),
    }
}

/// Every spelling of a model reference, canonical first: the plugin's
/// `modelRefLookupOrder` (`packages/plugin/src/shared/harness-provider-map.ts`).
fn model_ref_lookup_order(reference: &str) -> Vec<String> {
    let canonical = remap_provider(
        &remap_provider(reference, OMP_TO_CANONICAL),
        PI_TO_CANONICAL,
    );
    let pi = remap_provider(
        &remap_provider(&canonical, PI_TO_CANONICAL),
        CANONICAL_TO_PI,
    );
    let omp = remap_provider(
        &remap_provider(&canonical, OMP_TO_CANONICAL),
        CANONICAL_TO_OMP,
    );
    let mut refs: Vec<String> = Vec::new();
    for candidate in [canonical, reference.to_string(), pi, omp] {
        if !refs.contains(&candidate) {
            refs.push(candidate);
        }
    }
    refs
}

/// The keys `prompt_surface.models` is searched with, most specific first:
/// the plugin's `modelKeyLookupOrder` (`packages/plugin/src/shared/prompt-surface.ts`).
/// Each provider spelling with the full model id, then the bare model id, then
/// both again with the model id cut at its last `-`, and finally `provider/*`.
pub(crate) fn model_key_candidates(model_key: &str) -> Vec<String> {
    let Some(slash) = model_key.find('/') else {
        return Vec::new();
    };
    if slash == 0 || slash == model_key.len() - 1 {
        return Vec::new();
    }
    let prefixes: Vec<String> = model_ref_lookup_order(model_key)
        .into_iter()
        .map(|reference| match reference.find('/') {
            Some(at) => reference[..at].to_string(),
            None => reference,
        })
        .collect();
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |candidate: String| {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };
    let mut model_id = &model_key[slash + 1..];
    while !model_id.is_empty() {
        for prefix in &prefixes {
            push(format!("{prefix}/{model_id}"));
        }
        push(model_id.to_string());
        match model_id.rfind('-') {
            Some(dash) if dash > 0 => model_id = &model_id[..dash],
            _ => break,
        }
    }
    for prefix in &prefixes {
        push(format!("{prefix}/*"));
    }
    candidates
}

// ── Canonical JSON and digests ───────────────────────────────────────────

fn jcs_bytes(value: &Value) -> Result<Vec<u8>, CatalogError> {
    serde_jcs::to_vec(value).map_err(|error| CatalogError::Internal(error.to_string()))
}

fn sha256_hex(text: &str) -> String {
    sha256_hex_bytes(text.as_bytes())
}

fn sha256_hex_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod parity_runtime_tests {
    use super::*;

    async fn refusal(handler: &crate::McHandler, name: &str, arguments: Value) -> String {
        let outcome = handler
            .dispatch_value(7, json!({"name": name, "arguments": arguments}))
            .await;
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("expected tool refusal, got {outcome:?}");
        };
        let refused: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(refused["isError"], true);
        refused["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn removed_advertised_string_caps_are_still_enforced_by_facades() {
        let handler = crate::McHandler::new();
        for (name, action, field, cap) in [
            ("ctx_note", "write", "content", 65536),
            ("ctx_note", "write", "surface_condition", 4096),
            ("ctx_memory", "write", "content", 65536),
            ("ctx_memory", "archive", "reason", 4096),
            ("ctx_search", "", "query", 1024),
        ] {
            let mut arguments = json!({"action": action});
            arguments[field] = json!("x".repeat(cap + 1));
            assert_eq!(
                refusal(&handler, name, arguments).await,
                format!("Error: '{field}' exceeds the {cap}-byte limit."),
                "{name}.{field}"
            );
        }
    }

    #[tokio::test]
    async fn search_query_required_refusal_is_unchanged() {
        let handler = crate::McHandler::new();
        assert_eq!(
            refusal(&handler, "ctx_search", json!({})).await,
            "Error: 'query' is required for ctx_search."
        );
    }

    #[tokio::test]
    async fn removed_memory_id_schema_bounds_are_still_enforced_by_facade() {
        let handler = crate::McHandler::new();
        assert_eq!(
            refusal(
                &handler,
                "ctx_memory",
                json!({"action": "get", "ids": vec![1; 101]})
            )
            .await,
            "Error: 'ids' exceeds the 100-item limit."
        );
        for id in [json!(-1), json!(0), json!(1.5)] {
            assert_eq!(
                refusal(
                    &handler,
                    "ctx_memory",
                    json!({"action": "get", "ids": [id]})
                )
                .await,
                "Error: 'ids' must contain only positive 64-bit integers."
            );
        }
    }

    #[test]
    fn removed_expand_schema_bounds_are_still_enforced_by_runtime_mode_parser() {
        for arguments in [json!({"message": -1}), json!({"message": 1.5})] {
            assert_eq!(
                crate::resolve_ctx_expand_mode(arguments.as_object().unwrap()).unwrap_err(),
                "Error: message must be a non-negative integer."
            );
        }
        for arguments in [
            json!({"start": -1, "end": 3}),
            json!({"start": 1.5, "end": 3}),
            json!({"start": 1, "end": -1}),
            json!({"start": 1, "end": 3.5}),
        ] {
            assert_eq!(crate::resolve_ctx_expand_mode(arguments.as_object().unwrap()).unwrap_err(),
                "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end).");
        }
    }

    #[tokio::test]
    async fn reduce_advertises_required_drop_and_execution_requires_it() {
        let config = CatalogConfig::from_module_config(&McModuleConfig::default());
        let reduce = catalog_tool(
            definition().tool("ctx_reduce").unwrap(),
            Surface::Full,
            true,
            &config,
        )
        .unwrap();
        assert_eq!(reduce["input_schema"]["required"], json!(["drop"]));
        assert_eq!(reduce["input_schema"].as_object().unwrap().len(), 4);
        assert_eq!(reduce["schema_digest"], FROZEN_CTX_REDUCE_SCHEMA_DIGEST);

        let handler = crate::McHandler::new();
        for arguments in [json!({}), json!({ "drop": "  " }), json!({ "drop": 7 })] {
            let outcome = handler
                .dispatch_value(7, json!({ "name": "ctx_reduce", "arguments": arguments }))
                .await;
            let HandlerOutcome::Response(bytes) = outcome else {
                panic!("expected tool refusal, got {outcome:?}");
            };
            let refused: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(refused["isError"], true);
            assert_eq!(
                refused["content"][0]["text"],
                r#"Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}."#
            );
        }
    }
}
