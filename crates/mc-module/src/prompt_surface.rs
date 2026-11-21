use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subc_protocol::manifest::{ExecutionMode, Tool};

use super::{
    ctx_expand_description, ctx_expand_schema, ctx_memory_description, ctx_memory_schema,
    ctx_note_description, ctx_note_schema, ctx_search_description, ctx_search_schema,
};

pub const LIGHT_FALLBACK_NOTICE: &str = "prompt_surface selected light, but built-in light assets are not available yet; using the byte-identical full guidance and tool descriptions until light assets ship.";

pub(crate) const GUIDANCE_FULL_PRIMARY: &str = include_str!("../assets/guidance_primary.txt");
pub(crate) const GUIDANCE_FULL_NO_REDUCE: &str = include_str!("../assets/guidance_no_reduce.txt");

const GUIDANCE_LIGHT_PRIMARY: Option<&str> =
    Some(include_str!("../assets/guidance_light_primary.txt"));
const GUIDANCE_LIGHT_NO_REDUCE: Option<&str> =
    Some(include_str!("../assets/guidance_light_no_reduce.txt"));
const TOOL_LIGHT_DESCRIPTIONS: Option<&[(&str, &str)]> = Some(&[
    (
        "ctx_reduce",
        r#"Stamp an item as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays readable until Magic Context clears stamped items in one sweep, newest tags are protected, and a cleared item goes to the archive (recent: a [dropped §N§] placeholder; older: removed) recoverable via ctx_expand(tag=N). The question is "does this need to stay on my desk for what comes next?" — a file you keep editing stays, the grep that found it goes. Stamp used reads/searches/outputs, acted-on build/test output, redundant dumps, extracted pasted payloads; keep user messages, your own text, unresolved errors, raw evidence, exact wording that may matter. Look at each tag; never blanket-stamp "1-50". Grammar: "3-5", "1,2,9", "1-5,8,12-15"."#,
    ),
    (
        "ctx_memory",
        r#"Durable facts about this project, shared with every agent on it and kept for the months this work lasts; active ones are already in <project-memory> as `#id: fact`. Write one standalone fact when it must not have to be found again — a rule, an architecture fact, a constraint, a config value, a naming convention — especially what cost you turns. A pending intention with evidence is ctx_note, not memory. write (content + category); update one id (content; category required); archive one or more ids (reason optional); merge two or more ids (content); get 1–20 ids in any status."#,
    ),
    (
        "ctx_search",
        r#"Search the archive — everything that ever happened here that is not on your desk: memories not in <project-memory>, compacted conversation, commits, notes. Phrase query as a natural-language question carrying the exact terms you expect ("where is the opencode source code path?", "why did we choose SQLite over postgres?", "how does the dreamer lease work?") — a keyword stack finds less. Sources (omit for all): memory (rules, conventions), message (compacted conversation; hits carry ordinals for ctx_expand), git_commit (when did this change), primer (reusable project Q&A the dreamer distils from recurring questions), note (parked follow-ups). Memory ids alone (`#7234`) resolve directly. from/to restrict every source to an inclusive UTC date range."#,
    ),
    (
        "ctx_expand",
        "Recover one item with tag=N (a §N§ or dropped placeholder number), not a message ordinal; text or one tool call with full input/output. message=N and start/end are whole-message ordinals from history/search, never tag numbers. Recover raw conversation behind a <session-history> heading or around a ctx_search hit: ctx_expand(start, end) returns [N] U:/A: lines (~15K-token cap; oversized ranges return the head and where to continue). verbose=true lists messages with per-part previews to pick one; message=N returns that message in full, including a tool output released with ctx_reduce. Ranges after the last compartment are your live tail, not expandable.",
    ),
    (
        "ctx_note",
        r#"Session notes are pending intentions: work you intend to return to, with findings attached ("take a note" always qualifies). Not active steps, an executing plan, or restart insurance; a record of how things stand (world-state, a design at a point in time) with nothing you intend to do about it — that goes stale silently; a fact worth keeping is memory, the rest is nothing. First line = title (<80 chars). write saves; read lists rows (note_ids for bodies); update changes one; dismiss retires 1–50. Dismiss a note when its work lands or is abandoned; a queue you never dismiss from stops being read. surface_condition parks it until an outside check against repo files, git, GitHub or the web holds."#,
    ),
]);

const CTX_REDUCE_DESCRIPTION: &str = r#"Stamp an item on your desk as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest tags are protected so stamping recent output is harmless. A cleared item goes to the archive — a recent one leaves a `[dropped §N§]` placeholder, an older one leaves nothing — and `ctx_expand(tag=N)` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay on my desk for what comes next?" — a file you read and will keep editing stays; the grep that found it goes.

Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected; a large block pasted inside a user message once you have used it.
Keep: user messages (never stamp one for its directive), your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.

Look at each tag before stamping it; never blanket-stamp a range like "1-50". Many small targeted stamps beat one sweep. `drop` accepts "3-5", "1,2,9", "1-5,8,12-15"."#;

fn schema_with_preset_descriptions(
    tool_id: &str,
    mut schema: serde_json::Value,
    preset: PromptSurfacePreset,
) -> serde_json::Value {
    if preset != PromptSurfacePreset::Light {
        return schema;
    }
    let descriptions: &[(&str, &str)] = match tool_id {
        "ctx_reduce" => &[("drop", "Tag IDs: \"3-5\", \"1,2,9\", \"1-5,8,12-15\".")],
        "ctx_expand" => &[
            ("tag", "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone."),
            ("start", "First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number."),
            ("end", "Last message ordinal of the range, inclusive, not a tag number."),
            ("verbose", "With start/end: one entry per message with previews instead of the transcript."),
            ("message", "Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone."),
        ],
        "ctx_note" => &[
            ("action", "write | read | update | dismiss (default: write with content, else read)."),
            ("content", "Note text: first line title (<80 chars), then detail."),
            ("surface_condition", "A condition an outside checker can verify on its own, periodically (repository, releases, web — anything it can look up); never something only this conversation knows."),
            ("filter", "Read filter: all, active, pending, ready, dismissed. Omitted: active notes plus every current smart note (pending included); active: only active-status notes."),
            ("limit", "Rows per read (default 25)."),
            ("offset", "Skip newest rows (default 0)."),
            ("note_ids", "One id for update, 1–50 for dismiss or read (full bodies). Ignored by write."),
        ],
        "ctx_memory" => &[
            ("action", "write | update | archive | merge | get"),
            ("content", "One standalone fact (write, update, merge)."),
            ("category", "Kind of fact (required for write; optional on update/merge)."),
            ("ids", "Ids from <project-memory>: one for update, 1+ for archive, 2+ for merge, 1–20 for get."),
            ("reason", "Why it is archived (optional)."),
        ],
        "ctx_search" => &[
            ("query", "A natural-language question carrying the exact terms you expect in the answer."),
            ("limit", "Maximum results (default 10)."),
            ("from", "Earliest date, YYYY-MM-DD (inclusive)."),
            ("to", "Latest date, YYYY-MM-DD (inclusive; default open)."),
        ],
        _ => &[],
    };
    if let Some(properties) = schema
        .get_mut("properties")
        .and_then(|value| value.as_object_mut())
    {
        for (name, description) in descriptions {
            if let Some(property) = properties
                .get_mut(*name)
                .and_then(|value| value.as_object_mut())
            {
                property.insert("description".to_string(), json!(description));
            }
        }
    }
    schema
}

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
    for tool in tools.iter_mut().filter(|tool| tool.name == "ctx_note") {
        disable_smart_note_schema(&mut tool.schema);
        let description = if preset == PromptSurfacePreset::Light {
            TOOL_LIGHT_DESCRIPTIONS
                .and_then(|descriptions| {
                    descriptions
                        .iter()
                        .find_map(|(id, text)| (*id == "ctx_note").then_some(*text))
                })
                .map(str::to_string)
                .unwrap_or_else(ctx_note_description)
        } else {
            ctx_note_description()
        };
        tool.description = Some(without_smart_note_description(&description));
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

pub fn tool_manifest_falls_back(preset: PromptSurfacePreset) -> bool {
    preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()
}

pub fn module_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    let description = |tool_id: &str, full: String| {
        selection
            .tool_descriptions
            .get(tool_id)
            .cloned()
            .or_else(|| {
                (selection.preset == PromptSurfacePreset::Light)
                    .then_some(TOOL_LIGHT_DESCRIPTIONS)
                    .flatten()
                    .and_then(|descriptions| {
                        descriptions
                            .iter()
                            .find_map(|(id, text)| (*id == tool_id).then(|| (*text).to_string()))
                    })
            })
            .unwrap_or(full)
    };

    vec![
        Tool {
            name: "transform".to_string(),
            description: Some(
                "Cache-stable context transform: folds compacted history into m0/m1 and applies frozen reductions".to_string(),
            ),
            execution_mode: ExecutionMode::Pure,
            schema: json!({ "type": "object" }),
        },
        Tool {
            name: "ctx_reduce".to_string(),
            description: Some(description(
                "ctx_reduce",
                CTX_REDUCE_DESCRIPTION.to_string(),
            )),
            execution_mode: ExecutionMode::Pure,
            // This exact advertised shape is the Thalamus authorization contract. Prompt-surface
            // selection may replace only the top-level description.
            schema: schema_with_preset_descriptions(
                "ctx_reduce",
                json!({
                    "type": "object",
                    "properties": {
                        "drop": {
                            "type": "string",
                            "description": "Tag IDs to drop: \"3-5\", \"1,2,9\", \"1-5,8,12-15\"."
                        }
                    },
                    "required": ["drop"],
                    "additionalProperties": false
                }),
                selection.preset,
            ),
        },
        Tool {
            name: "ctx_memory".to_string(),
            description: Some(description("ctx_memory", ctx_memory_description())),
            execution_mode: ExecutionMode::Mutating,
            schema: schema_with_preset_descriptions(
                "ctx_memory",
                ctx_memory_schema(),
                selection.preset,
            ),
        },
        Tool {
            name: "ctx_expand".to_string(),
            description: Some(description("ctx_expand", ctx_expand_description())),
            execution_mode: ExecutionMode::Pure,
            schema: schema_with_preset_descriptions(
                "ctx_expand",
                ctx_expand_schema(),
                selection.preset,
            ),
        },
        Tool {
            name: "ctx_search".to_string(),
            description: Some(description("ctx_search", ctx_search_description())),
            execution_mode: ExecutionMode::Pure,
            schema: schema_with_preset_descriptions(
                "ctx_search",
                ctx_search_schema(),
                selection.preset,
            ),
        },
        Tool {
            name: "ctx_note".to_string(),
            description: Some(description("ctx_note", ctx_note_description())),
            execution_mode: ExecutionMode::Mutating,
            schema: schema_with_preset_descriptions(
                "ctx_note",
                ctx_note_schema(),
                selection.preset,
            ),
        },
    ]
}

pub fn session_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    module_tools(selection)
        .into_iter()
        .filter(|tool| is_known_tool_id(&tool.name))
        .collect()
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
            if light.name == "ctx_search" {
                assert_eq!(light.schema, full.schema);
            } else {
                assert_ne!(light.schema, full.schema);
            }
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
