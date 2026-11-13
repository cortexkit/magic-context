//! The prompt renderer: one prompt document of a resolved memory profile
//! (`prompts` in an `mc/memory-profile@1` body), rendered as the text a model
//! is sent.
//!
//! A document is a list of sections. Each section is a profile file or an MC
//! frame; a section with `requires` renders only when the resolved profile has
//! that stream. The sections are joined with a newline, then expanded:
//! - a line that is exactly `⟦mc:<frame>⟧` becomes the frame's text;
//! - a line starting `⟦if <stream>⟧` is kept, without that prefix, only when the
//!   profile has the stream;
//! - `⟦profile:<name>⟧` becomes text generated from the profile's declarations
//!   (a line holding only the marker disappears when the generator has nothing
//!   to say, for example shape blocks of a stream the profile lacks);
//! - any other `⟦name⟧` is a runtime value the caller fills, left as it is.
//!
//! A marker of the first three kinds that names nothing known, or one still in
//! the text after expansion, refuses the render: the model is never sent an
//! unexpanded instruction.
//!
//! Files and frames end with one newline that is not part of their text.
//!
//! Nothing sends rendered text yet: the summarizer still takes its prompts from
//! the module's copies of the plugin's texts. It moves onto this renderer only
//! after real summarizer chunks have been run with both texts side by side and
//! the replies read. The golden test in `render_tests.rs` holds the bundled
//! coding profile's rendering to today's texts.

use serde_json::Value;

use super::{list, refuse, text, Profile, Result};

/// The streams a section's `requires` or a line's `⟦if …⟧` may name.
pub(super) const CONDITIONS: &[&str] = &[
    "fact_categories",
    "user_categories",
    "event_kinds",
    "primer_candidates",
];

/// Every `⟦profile:…⟧` generator, besides `<event tag>.<field>`, which lists
/// the closed values of one event field.
pub(super) const GENERATORS: &[&str] = &[
    "fact-category-count",
    "fact-category-definitions",
    "fact-routing-list",
    "fact-routing-next",
    "fact-category-taxonomy",
    "fact-category-tags",
    "fact-shape-blocks",
    "project-memory-groups",
    "user-category-definitions",
    "user-category-tags",
    "user-category-list",
    "user-observation-shape-blocks",
    "event-definitions",
    "event-shape-blocks",
    "episode-types",
    "decay-class-list",
    "memory-guidance-categories",
    "memory-guidance-categories-light",
    "cue-chars-high",
    "cue-chars-low",
    "cue-high-from",
    "min-proof-count",
];

const MC_MARKER: &str = "⟦mc:";
const PROFILE_MARKER: &str = "⟦profile:";
const IF_MARKER: &str = "⟦if ";

/// Render `document` of `profile`, splicing MC frames from `frames` (name and
/// file text, as in [`super::frames::FRAMES`]).
#[allow(dead_code)] // No prompt is rendered from a profile yet; see the module docs.
pub(crate) fn render(profile: &Profile, document: &str, frames: &[(&str, &str)]) -> Result<String> {
    let doc = profile.body["prompts"]
        .get(document)
        .ok_or_else(|| refuse("prompt_invalid", format!("document {document} missing")))?;
    let mut parts = Vec::new();
    for section in list(doc, "sections") {
        if let Some(stream) = section["requires"].as_str() {
            if !has_stream(profile, stream)? {
                continue;
            }
        }
        match section["mc"].as_str() {
            Some(frame) => parts.push(format!("{MC_MARKER}{frame}⟧")),
            None => parts.push(file_text(profile, section, "file")?.to_owned()),
        }
    }
    let rendered = expand(profile, &parts.join("\n"), Some(frames))?;
    if let Some(line) = rendered.lines().find(|line| {
        [MC_MARKER, PROFILE_MARKER, IF_MARKER]
            .iter()
            .any(|m| line.contains(m))
    }) {
        return Err(refuse(
            "prompt_invalid",
            format!("{document}: marker left unexpanded: {line}"),
        ));
    }
    Ok(rendered)
}

/// A member file's text without its final newline.
fn file_text<'a>(profile: &'a Profile, entry: &Value, field: &str) -> Result<&'a str> {
    let bytes = profile.member(entry, field)?;
    bytes.strip_suffix('\n').ok_or_else(|| {
        refuse(
            "prompt_invalid",
            format!("{} does not end with a newline", text(entry, field)),
        )
    })
}

fn has_stream(profile: &Profile, stream: &str) -> Result<bool> {
    let body = &profile.body;
    Ok(match stream {
        "fact_categories" => !categories(profile, "fact").is_empty(),
        "user_categories" => !categories(profile, "user-observation").is_empty(),
        "event_kinds" => !list(&body["extraction"], "events").is_empty(),
        "primer_candidates" => !body["extraction"]["primer_candidates"].is_null(),
        _ => {
            return Err(refuse(
                "prompt_invalid",
                format!("unknown condition {stream}"),
            ))
        }
    })
}

/// The categories of one stream, in their `render_order`.
fn categories<'a>(profile: &'a Profile, stream: &str) -> Vec<&'a Value> {
    let mut out: Vec<&Value> = list(&profile.body, "categories")
        .iter()
        .filter(|c| c["stream"] == stream)
        .collect();
    out.sort_by_key(|c| c["render_order"].as_i64().unwrap_or(i64::MAX));
    out
}

/// Expand the markers of `source`. Frames are spliced only when `frames` is
/// given: a category or event definition is expanded without them, and an MC
/// marker inside one is left to the caller's unexpanded-marker check.
fn expand(profile: &Profile, source: &str, frames: Option<&[(&str, &str)]>) -> Result<String> {
    let mut spliced = Vec::new();
    for line in source.split('\n') {
        let frame = line
            .strip_prefix(MC_MARKER)
            .and_then(|rest| rest.strip_suffix('⟧'))
            .filter(|name| !name.contains('⟧'));
        match (frame, frames) {
            (Some(name), Some(frames)) => {
                let (_, text) = super::frames::resolve(frames, name).ok_or_else(|| {
                    refuse("prompt_invalid", format!("MC frame {name} not found"))
                })?;
                let text = text.strip_suffix('\n').ok_or_else(|| {
                    refuse(
                        "prompt_invalid",
                        format!("MC frame {name} does not end with a newline"),
                    )
                })?;
                spliced.extend(text.split('\n'));
            }
            _ => spliced.push(line),
        }
    }
    let mut out: Vec<String> = Vec::new();
    for line in spliced {
        let mut line = line;
        if let Some(rest) = line.strip_prefix(IF_MARKER) {
            let (stream, after) = rest
                .split_once('⟧')
                .ok_or_else(|| refuse("prompt_invalid", format!("malformed condition: {line}")))?;
            if !has_stream(profile, stream)? {
                continue;
            }
            line = after;
        }
        if let Some(name) = line
            .strip_prefix(PROFILE_MARKER)
            .and_then(|rest| rest.strip_suffix('⟧'))
            .filter(|name| !name.contains('⟧'))
        {
            if let Some(value) = generate(profile, name)? {
                out.push(value);
            }
            continue;
        }
        let mut expanded = String::with_capacity(line.len());
        let mut rest = line;
        while let Some(at) = rest.find(PROFILE_MARKER) {
            expanded.push_str(&rest[..at]);
            let after = &rest[at + PROFILE_MARKER.len()..];
            let Some(end) = after.find('⟧') else {
                // Left in place; the unexpanded-marker check refuses it.
                expanded.push_str(&rest[at..]);
                rest = "";
                break;
            };
            let name = &after[..end];
            let value = generate(profile, name)?.ok_or_else(|| {
                refuse(
                    "prompt_invalid",
                    format!("⟦profile:{name}⟧ generates nothing inside a line"),
                )
            })?;
            expanded.push_str(&value);
            rest = &after[end + '⟧'.len_utf8()..];
        }
        expanded.push_str(rest);
        out.push(expanded);
    }
    Ok(out.join("\n"))
}

/// The text a `⟦profile:<name>⟧` marker stands for, or `None` when the profile
/// declares nothing it could show (a line holding only the marker is dropped).
fn generate(profile: &Profile, name: &str) -> Result<Option<String>> {
    let body = &profile.body;
    let facts = categories(profile, "fact");
    let users = categories(profile, "user-observation");
    let events = list(&body["extraction"], "events");
    let unknown = || refuse("prompt_invalid", format!("unknown profile marker {name}"));
    let definitions = |entries: &[&Value]| -> Result<String> {
        let mut texts = Vec::new();
        for entry in entries {
            texts.push(expand(
                profile,
                file_text(profile, entry, "definition_file")?,
                None,
            )?);
        }
        Ok(texts.join("\n"))
    };
    let joined = |entries: &[&Value], line: &dyn Fn(&Value) -> String| -> String {
        entries
            .iter()
            .map(|&entry| line(entry))
            .collect::<Vec<_>>()
            .join("\n")
    };
    if !GENERATORS.contains(&name) {
        // `<event tag>.<field>`: the closed values of one enumerated event field.
        let (tag, field) = name.split_once('.').ok_or_else(unknown)?;
        let values = events
            .iter()
            .find(|event| event["tag"] == tag)
            .and_then(|event| event["enums"][field].as_array())
            .ok_or_else(unknown)?;
        let values: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        return Ok(Some(values.join(" | ")));
    }
    let setting = |kind: &str, key: &str| -> Result<String> {
        list(body, "tasks")
            .iter()
            .find(|task| task["kind"] == kind && task["enabled"] == true)
            .map(|task| &task["settings"][key])
            .filter(|value| value.is_number())
            .map(Value::to_string)
            .ok_or_else(|| {
                refuse(
                    "prompt_invalid",
                    format!("marker {name} has no enabled {kind} task setting {key}"),
                )
            })
    };
    Ok(Some(match name {
        "fact-category-count" => facts.len().to_string(),
        "fact-category-definitions" => definitions(&facts)?,
        "fact-routing-list" => facts
            .iter()
            .enumerate()
            .map(|(i, c)| {
                format!(
                    "{}. **{}** → {}",
                    i + 1,
                    text(c, "routing_question"),
                    text(c, "tag")
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "fact-routing-next" => (facts.len() + 1).to_string(),
        "fact-category-taxonomy" => joined(&facts, &|c| {
            format!("- **{}** — {}", text(c, "tag"), text(c, "description"))
        }),
        "fact-category-tags" => tags(&facts),
        "fact-shape-blocks" if facts.is_empty() => return Ok(None),
        "fact-shape-blocks" => joined(&facts, &|c| {
            let tag = text(c, "tag");
            format!("<{tag}>\n* Fact text\n</{tag}>")
        }),
        "project-memory-groups" => joined(&facts, &|c| {
            let tag = text(c, "tag");
            format!("<{tag}>\n- ⟦{tag}.memory.content⟧\n</{tag}>")
        }),
        "user-category-definitions" => definitions(&users)?,
        "user-category-tags" => tags(&users),
        "user-category-list" => joined(&users, &|c| {
            let seen_by = if c["visibility"] == "all-profiles" {
                "every profile's agents".to_owned()
            } else {
                format!("only agents running {}", text(c, "_from"))
            };
            format!(
                "- **{}** ({}; seen by {seen_by}) — {}",
                text(c, "tag"),
                text(c, "default_level"),
                text(c, "description")
            )
        }),
        "user-observation-shape-blocks" if users.is_empty() => return Ok(None),
        "user-observation-shape-blocks" => joined(&users, &|c| {
            let tag = text(c, "tag");
            format!("<{tag}>\n* Observation text\n</{tag}>")
        }),
        "event-definitions" => definitions(&events.iter().collect::<Vec<_>>())?,
        "event-shape-blocks" if events.is_empty() => return Ok(None),
        "event-shape-blocks" => joined(&events.iter().collect::<Vec<_>>(), &|e| {
            let tag = text(e, "tag");
            let mut lines = vec![format!("<{tag} at_compartment=\"N\">")];
            for field in list(e, "shape_fields").iter().filter_map(Value::as_str) {
                lines.push(format!("<{field}>...</{field}>"));
            }
            lines.push(format!("</{tag}>"));
            lines.join("\n")
        }),
        "episode-types" => list(&body["extraction"], "episode_types")
            .iter()
            .filter_map(Value::as_str)
            .map(|t| format!("`{t}`"))
            .collect::<Vec<_>>()
            .join(", "),
        "decay-class-list" => joined(
            &list(body, "decay_classes").iter().collect::<Vec<_>>(),
            &|d| format!("  - `{}`: {}", text(d, "id"), text(d, "meaning")),
        ),
        "memory-guidance-categories" if facts.is_empty() => return Ok(None),
        "memory-guidance-categories" => {
            let hints = facts
                .iter()
                .map(|c| format!("{} ({})", text(c, "tag"), text(c, "guidance_hint")))
                .collect::<Vec<_>>()
                .join(", ");
            let mut examples = Vec::new();
            for example in list(&body["main_agent"], "memory_examples") {
                let tag = list(body, "categories")
                    .iter()
                    .find(|c| c["id"] == example["category"])
                    .map(|c| text(c, "tag"))
                    .ok_or_else(|| {
                        refuse(
                            "prompt_invalid",
                            format!(
                                "memory example names unknown category {}",
                                example["category"]
                            ),
                        )
                    })?;
                examples.push(format!(
                    "category=\"{tag}\", content=\"{}\"",
                    text(example, "content")
                ));
            }
            let examples = if examples.is_empty() {
                String::new()
            } else {
                format!(" Examples: {}", examples.join(" · "))
            };
            format!("Categories for `ctx_memory`: {hints}.{examples}")
        }
        "memory-guidance-categories-light" if facts.is_empty() => return Ok(None),
        "memory-guidance-categories-light" => format!(
            "Categories: {}.",
            facts
                .iter()
                .map(|c| format!("{} ({})", text(c, "tag"), text(c, "guidance_hint_light")))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        "cue-chars-high" => setting("compress-cues", "cue_chars_high")?,
        "cue-chars-low" => setting("compress-cues", "cue_chars_low")?,
        "cue-high-from" => setting("compress-cues", "cue_high_from")?,
        "min-proof-count" => setting("reflect-events", "min_proof_count")?,
        _ => return Err(unknown()),
    }))
}

fn tags(categories: &[&Value]) -> String {
    categories
        .iter()
        .map(|c| text(c, "tag"))
        .collect::<Vec<_>>()
        .join(", ")
}
