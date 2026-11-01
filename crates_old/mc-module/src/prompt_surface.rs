use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subc_protocol::manifest::{ExecutionMode, Tool};

use crate::config::McModuleConfig;
use crate::tool_catalog::{self, Surface, TextFlags};

pub const LIGHT_FALLBACK_NOTICE: &str = "prompt_surface selected light, but built-in light assets are not available yet; using the byte-identical full guidance and tool descriptions until light assets ship.";

pub(crate) const GUIDANCE_FULL_PRIMARY: &str = include_str!("../assets/guidance_primary.txt");
pub(crate) const GUIDANCE_FULL_NO_REDUCE: &str = include_str!("../assets/guidance_no_reduce.txt");
const GUIDANCE_LIGHT_PRIMARY: Option<&str> =
    Some(include_str!("../assets/guidance_light_primary.txt"));
const GUIDANCE_LIGHT_NO_REDUCE: Option<&str> =
    Some(include_str!("../assets/guidance_light_no_reduce.txt"));

pub const PROMPT_SURFACE_TOOL_IDS: [&str; 5] = [
    "ctx_reduce",
    "ctx_memory",
    "ctx_search",
    "ctx_expand",
    "ctx_note",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptSurfacePreset {
    #[default]
    Full,
    Light,
}

impl PromptSurfacePreset {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceVariant {
    Full,
    NoReduce,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuidanceAsset {
    pub bytes: &'static str,
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSurfaceSelection {
    pub model_key: Option<String>,
    /// Caller-computed identity of the live prompt-surface config generation.
    /// It participates only in materialization freezing, never provider-visible epochs.
    pub config_identity: String,
    pub preset: PromptSurfacePreset,
    /// Complete trusted user-authored primary guidance bytes, resolved by the host.
    pub guidance_override: Option<String>,
    pub tool_descriptions: BTreeMap<String, String>,
}

impl Default for PromptSurfaceSelection {
    fn default() -> Self {
        Self {
            model_key: None,
            config_identity: String::new(),
            preset: PromptSurfacePreset::Full,
            guidance_override: None,
            tool_descriptions: BTreeMap::new(),
        }
    }
}

pub fn guidance_asset(preset: PromptSurfacePreset, variant: GuidanceVariant) -> GuidanceAsset {
    let full = match variant {
        GuidanceVariant::Full => GUIDANCE_FULL_PRIMARY,
        GuidanceVariant::NoReduce => GUIDANCE_FULL_NO_REDUCE,
    };
    let light = match variant {
        GuidanceVariant::Full => GUIDANCE_LIGHT_PRIMARY,
        GuidanceVariant::NoReduce => GUIDANCE_LIGHT_NO_REDUCE,
    };

    match preset {
        PromptSurfacePreset::Full => GuidanceAsset {
            bytes: full,
            fallback: false,
        },
        PromptSurfacePreset::Light => GuidanceAsset {
            bytes: light.unwrap_or(full),
            fallback: light.is_none(),
        },
    }
}

pub fn is_known_tool_id(tool_id: &str) -> bool {
    PROMPT_SURFACE_TOOL_IDS.contains(&tool_id)
}

pub(crate) fn disable_smart_note_schema(schema: &mut serde_json::Value) {
    if let Some(properties) = schema.get_mut("properties").and_then(|v| v.as_object_mut()) {
        properties.remove("surface_condition");
        if let Some(filter) = properties.get_mut("filter") {
            filter["description"] = json!("Read filter: all, active, pending, ready, dismissed. Omitted: active session notes plus every current project note; active shows only active-status notes.");
        }
    }
}

pub(crate) fn without_smart_note_description(text: &str) -> String {
    text.replace("ready smart notes first, then newest", "newest first")
        .split("\n- surface_condition:")
        .next()
        .unwrap_or_default()
        .split(" surface_condition parks")
        .next()
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn without_smart_note_guidance(text: &str) -> String {
    let plain = text.replace(" A note with a `surface_condition` is left with an outside checker that looks the condition up periodically and returns the note only when it holds.", "")
        .replace("; a `surface_condition` leaves the note with an outside checker that returns it when the condition holds", "");
    let mut smart_section_level = 0;
    plain
        .split('\n')
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            let mentions = [
                "smart note",
                "smart-note",
                "smart_note",
                "surface_condition",
                "outside checker",
            ]
            .iter()
            .any(|term| lower.contains(term));
            let trimmed = line.trim_start();
            let heading_level = trimmed.chars().take_while(|ch| *ch == '#').count();
            if (1..=6).contains(&heading_level)
                && trimmed
                    .chars()
                    .nth(heading_level)
                    .is_some_and(char::is_whitespace)
                && (smart_section_level == 0 || heading_level <= smart_section_level)
            {
                smart_section_level = if mentions { heading_level } else { 0 };
            }
            smart_section_level == 0 && !mentions
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn disable_smart_notes_in_tools(tools: &mut [Tool], preset: PromptSurfacePreset) {
    let surface = match preset {
        PromptSurfacePreset::Full => Surface::Full,
        PromptSurfacePreset::Light => Surface::Light,
    };
    for tool in tools.iter_mut().filter(|tool| tool.name == "ctx_note") {
        disable_smart_note_schema(&mut tool.schema);
        let description = tool_catalog::definition()
            .description(surface, "ctx_note")
            .expect("note description");
        tool.description = Some(without_smart_note_description(description));
    }
}

#[cfg(test)]
#[test]
fn disabled_legacy_facade_tool_and_guidance_surfaces_have_no_smart_note_clauses() {
    for preset in [PromptSurfacePreset::Full, PromptSurfacePreset::Light] {
        let mut tools = session_tools(&PromptSurfaceSelection {
            preset,
            ..Default::default()
        });
        disable_smart_notes_in_tools(&mut tools, preset);
        let note = tools.iter().find(|tool| tool.name == "ctx_note").unwrap();
        let text = serde_json::to_string(note).unwrap();
        assert!(!text.contains("surface_condition"), "{text}");
        assert!(!text.contains("smart note"), "{text}");
        for variant in [GuidanceVariant::Full, GuidanceVariant::NoReduce] {
            let text = without_smart_note_guidance(guidance_asset(preset, variant).bytes);
            assert!(!text.contains("surface_condition"), "{text}");
            assert!(!text.contains("outside checker"), "{text}");
        }
    }
    let manifest = crate::manifest_with_route_targets_and_smart_notes(
        crate::DEFAULT_MODULE_ID,
        &crate::route_targets::RouteTargetConfig::default(),
        false,
    );
    let text = serde_json::to_string(&manifest).unwrap();
    assert!(!text.contains("surface_condition"), "{text}");
    assert!(!text.contains("smart note"), "{text}");
}

pub fn warn_ignored_unknown_tool_description(tool_id: &str) {
    tracing::warn!(
        "mc-module: config warning: prompt_surface.tool_descriptions.{tool_id} is not a known ctx_* tool ID; the override was ignored."
    );
}

pub fn tool_manifest_falls_back(_preset: PromptSurfacePreset) -> bool {
    false
}

pub fn module_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    let surface = match selection.preset {
        PromptSurfacePreset::Full => Surface::Full,
        PromptSurfacePreset::Light => Surface::Light,
    };
    let mut tools = vec![Tool {
        name: "transform".to_string(),
        description: Some("Cache-stable context transform: folds compacted history into m0/m1 and applies frozen reductions".to_string()),
        execution_mode: ExecutionMode::Pure,
        schema: json!({ "type": "object" }),
    }];
    // Share the catalog definition so startup and session discovery cannot
    // advertise different schemas. McHandler's handle_ctx_*_facade methods
    // validate execution arguments separately from this metadata.
    for name in [
        "ctx_reduce",
        "ctx_memory",
        "ctx_expand",
        "ctx_search",
        "ctx_note",
    ] {
        let definition = tool_catalog::definition();
        let tool = definition.tool(name).expect("known context tool");
        tools.push(Tool {
            name: name.to_string(),
            description: Some(
                selection
                    .tool_descriptions
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| {
                        definition
                            .description(surface, name)
                            .expect("tool description")
                            .to_string()
                    }),
            ),
            execution_mode: if matches!(name, "ctx_memory" | "ctx_note") {
                ExecutionMode::Mutating
            } else {
                ExecutionMode::Pure
            },
            schema: tool_catalog::input_schema(tool, surface).expect("tool schema"),
        });
    }
    tools
}

pub fn session_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    module_tools(selection)
        .into_iter()
        .filter(|tool| is_known_tool_id(&tool.name))
        .collect()
}

/// The pure catalog renderer, shared by provider discovery and offline parity
/// checks. It never opens a store or persists a session's selected tool surface.
pub fn catalog_for_config(
    arguments: &serde_json::Value,
    config: &McModuleConfig,
) -> Result<serde_json::Value, String> {
    tool_catalog::catalog_answer(
        arguments,
        &tool_catalog::CatalogConfig::from_module_config(config),
    )
    .map_err(|error| format!("{error:?}"))
}

/// Compose the same primary-agent or subagent guidance as the TypeScript plugin.
/// The caller supplies whether the reduce tool is callable. A subagent without
/// that tool gets an empty string instead of instructions for unavailable tags.
pub fn compose_guidance(
    selection: &PromptSurfaceSelection,
    config: &McModuleConfig,
    subagent: bool,
    reduce_callable: bool,
) -> String {
    if subagent && !reduce_callable {
        return String::new();
    }
    let surface = selection.preset.as_str();
    let directive = primary_language_directive(config.language.as_deref());
    let flags = TextFlags {
        memory: config.memory_enabled,
        dreamer: config.catalog.dreamer_runnable && config.smart_notes_enabled,
        temporal: config.temporal_awareness,
        caveman: config.caveman.enabled,
        language: !directive.is_empty(),
    };
    let mut values = BTreeMap::new();
    values.insert("language_directive", directive);
    let name = if subagent {
        format!("worker/{surface}")
    } else if let Some(text) = &selection.guidance_override {
        values.insert(
            "override",
            if config.smart_notes_enabled {
                text.clone()
            } else {
                without_smart_note_guidance(text)
            },
        );
        "override".to_string()
    } else if reduce_callable {
        format!("head/reduce/{surface}")
    } else {
        format!("head/no_reduce/{surface}")
    };
    tool_catalog::render_text(&name, &flags, &values).expect("compiled guidance template")
}

/// Return reply-language guidance, or an empty string for an unknown code.
/// The name table comes from the macOS TypeScript capture in
/// `testdata/tool_surfaces/golden.json`, not the Rust process's host ICU version.
pub fn primary_language_directive(language: Option<&str>) -> String {
    let code = language.unwrap_or_default().trim().to_ascii_lowercase();
    let Some(name) = tool_catalog::definition().language_names.get(&code) else {
        return String::new();
    };
    format!("Use {name} for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim.")
}

/// Session tool metadata for a harness. Disabling smart notes selects the
/// ordinary-note schema and description. Project identity stays authenticated
/// transport state, not a model-chosen `memory_project` argument.
pub fn session_tools_for_config(
    selection: &PromptSurfaceSelection,
    config: &McModuleConfig,
) -> Vec<Tool> {
    let mut tools = session_tools(selection);
    if !config.smart_notes_enabled {
        disable_smart_notes_in_tools(&mut tools, selection.preset);
    }
    tools
}

pub fn selection_freeze_identity(selection: &PromptSurfaceSelection) -> String {
    if !selection.config_identity.is_empty() {
        return selection.config_identity.clone();
    }

    // Older callers did not send an explicit config generation. Derive a stable
    // compatibility key from the selected bytes so live preset/override changes
    // still reselect while unchanged requests remain frozen.
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "preset", selection.preset.as_str());
    if let Some(guidance) = &selection.guidance_override {
        hash_part(&mut hasher, "guidance_override", guidance);
    }
    for (tool_id, description) in &selection.tool_descriptions {
        hash_part(&mut hasher, "tool", tool_id);
        hash_part(&mut hasher, "description", description);
    }
    format!("legacy{}", hex_digest(hasher.finalize()))
}

pub fn manifest_content_epoch(selection: &PromptSurfaceSelection) -> String {
    if selection.preset == PromptSurfacePreset::Full && selection.tool_descriptions.is_empty() {
        return String::new();
    }

    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "preset", selection.preset.as_str());
    for tool in session_tools(selection) {
        hash_part(&mut hasher, "tool", &tool.name);
        hash_part(
            &mut hasher,
            "description",
            tool.description.as_deref().unwrap_or_default(),
        );
    }
    format!("pm{}", hex_digest(hasher.finalize()))
}

pub fn guidance_content_hash(text: &str, preset: PromptSurfacePreset) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    if preset == PromptSurfacePreset::Light {
        hasher.update(b"\n\0magic-context-prompt-surface:light");
    }
    hex_digest(hasher.finalize())
}

/// Combine guidance and manifest identities before deriving the render identity. Full prompts
/// without overrides return the empty sentinel so legacy and default sessions retain their exact
/// pre-prompt-surface render identity.
pub fn unified_content_epoch(
    system_prompt_hash: &str,
    selection: &PromptSurfaceSelection,
) -> String {
    let manifest_epoch = manifest_content_epoch(selection);
    if manifest_epoch.is_empty() {
        return String::new();
    }

    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "guidance", system_prompt_hash);
    hash_part(&mut hasher, "manifest", &manifest_epoch);
    format!("ps{}", hex_digest(hasher.finalize()))
}

fn hash_part(hasher: &mut Sha256, label: &str, value: &str) {
    hasher.update(label.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(label.as_bytes());
    hasher.update(b"=");
    hasher.update(value.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(value.as_bytes());
    hasher.update(b";");
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn without_descriptions(mut value: serde_json::Value) -> serde_json::Value {
        match &mut value {
            serde_json::Value::Object(fields) => {
                fields.remove("description");
                for child in fields.values_mut() {
                    *child = without_descriptions(child.take());
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    *child = without_descriptions(child.take());
                }
            }
            _ => {}
        }
        value
    }

    #[test]
    fn light_slots_serve_authored_guidance_and_descriptions() {
        for variant in [GuidanceVariant::Full, GuidanceVariant::NoReduce] {
            let full = guidance_asset(PromptSurfacePreset::Full, variant);
            let light = guidance_asset(PromptSurfacePreset::Light, variant);
            assert_ne!(light.bytes.as_bytes(), full.bytes.as_bytes());
            assert!(!full.fallback);
            assert!(!light.fallback);
            assert_ne!(
                guidance_content_hash(full.bytes, PromptSurfacePreset::Full),
                guidance_content_hash(light.bytes, PromptSurfacePreset::Light)
            );
        }
        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Light));
        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Full));

        let full_tools = session_tools(&PromptSurfaceSelection::default());
        let light_tools = session_tools(&PromptSurfaceSelection {
            preset: PromptSurfacePreset::Light,
            ..PromptSurfaceSelection::default()
        });
        assert_eq!(light_tools.len(), full_tools.len());
        for (light, full) in light_tools.iter().zip(full_tools) {
            assert_eq!(light.name, full.name);
            assert_ne!(light.schema, full.schema);
            assert_eq!(
                without_descriptions(light.schema.clone()),
                without_descriptions(full.schema.clone())
            );
            assert_eq!(light.execution_mode, full.execution_mode);
            assert_ne!(light.description, full.description);
        }
    }

    #[test]
    fn default_full_manifest_is_legacy_inert_and_overrides_only_descriptions() {
        let full = PromptSurfaceSelection::default();
        assert!(manifest_content_epoch(&full).is_empty());
        assert!(unified_content_epoch("guidance", &full).is_empty());

        let mut selected = full.clone();
        selected.preset = PromptSurfacePreset::Light;
        selected.tool_descriptions.insert(
            "ctx_search".to_string(),
            "Replacement search prose.".to_string(),
        );
        let legacy = session_tools(&full);
        let tools = session_tools(&selected);
        assert_eq!(tools.len(), legacy.len());
        for (actual, expected) in tools.iter().zip(legacy) {
            assert_eq!(actual.name, expected.name);
            assert_eq!(
                without_descriptions(actual.schema.clone()),
                without_descriptions(expected.schema.clone())
            );
            assert_eq!(actual.execution_mode, expected.execution_mode);
        }
        assert_eq!(
            tools[3].description.as_deref(),
            Some("Replacement search prose.")
        );
        assert!(!manifest_content_epoch(&selected).is_empty());
        assert!(!unified_content_epoch("guidance", &selected).is_empty());
    }
}
