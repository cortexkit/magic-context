//! Render documents from a validated `Profile`'s captured package bytes and the
//! compile-time frame registry, without filesystem reads during rendering.
//! `⟦profile:…⟧`, `⟦mc:…⟧` and `⟦if …⟧` must expand here; runtime placeholders
//! such as `⟦PROJECT_RULES.memory.content⟧` remain for the document's consumer.

use serde_json::Value;

use super::{frames, list, refuse, text, Profile, Result};

pub(crate) fn bundled_swe() -> Result<Profile> {
    super::bundled::swe()
}

pub(crate) fn parity_mode() -> bool {
    #[cfg(test)]
    if let Some(mode) = TEST_PARITY.with(std::cell::Cell::get) {
        return mode;
    }
    super::resolve::parity_mode()
}

#[cfg(test)]
thread_local! { static TEST_PARITY: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) }; }

#[cfg(test)]
pub(crate) fn with_parity_mode<T>(parity: bool, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<bool>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_PARITY.with(|mode| mode.set(self.0));
        }
    }
    let _restore = Restore(TEST_PARITY.with(|mode| mode.replace(Some(parity))));
    run()
}

pub(crate) fn render(profile: &Profile, document: &str, variant: Option<&str>) -> Result<String> {
    let doc = profile.body["prompts"]
        .get(document)
        .ok_or_else(|| refuse("prompt_invalid", format!("document {document} missing")))?;
    let mut parts = Vec::new();
    for section in list(doc, "sections") {
        if let Some(condition) = section["requires"].as_str() {
            if !condition_value(profile, condition)? {
                continue;
            }
        }
        parts.push(if let Some(frame) = section["mc"].as_str() {
            format!("⟦mc:{frame}⟧")
        } else {
            frames::source(profile.member(section, "file")?)?.to_owned()
        });
    }
    expand(profile, &parts.join("\n"), true, variant)
}

pub(crate) fn render_frame(profile: &Profile, name: &str, variant: Option<&str>) -> Result<String> {
    expand(profile, frames::frame(name, variant)?, true, variant)
}

fn categories<'a>(profile: &'a Profile, stream: &str) -> Vec<&'a Value> {
    let mut entries: Vec<_> = list(&profile.body, "categories")
        .iter()
        .filter(|c| c["stream"] == stream)
        .collect();
    entries.sort_by_key(|c| c["render_order"].as_i64().unwrap_or_default());
    entries
}

fn condition_value(profile: &Profile, name: &str) -> Result<bool> {
    Ok(match name {
        "fact_categories" => !categories(profile, "fact").is_empty(),
        "user_categories" => !categories(profile, "user-observation").is_empty(),
        "event_kinds" => !list(&profile.body["extraction"], "events").is_empty(),
        "primer_candidates" => !profile.body["extraction"]["primer_candidates"].is_null(),
        _ => {
            return Err(refuse(
                "prompt_invalid",
                format!("unknown condition {name}"),
            ))
        }
    })
}

fn whole<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.strip_prefix(prefix)?
        .strip_suffix('⟧')
        .filter(|s| !s.contains('⟧'))
}

fn expand(
    profile: &Profile,
    input: &str,
    with_frames: bool,
    variant: Option<&str>,
) -> Result<String> {
    let mut lines = Vec::new();
    for line in input.split('\n') {
        if let Some(name) = whole(line, "⟦mc:").filter(|_| with_frames) {
            lines.extend(frames::frame(name, variant)?.split('\n'));
        } else {
            lines.push(line);
        }
    }
    let mut out = Vec::new();
    for mut line in lines {
        if let Some(rest) = line.strip_prefix("⟦if ") {
            let (condition, body) = rest
                .split_once('⟧')
                .ok_or_else(|| refuse("prompt_invalid", "unterminated condition"))?;
            if !condition_value(profile, condition)? {
                continue;
            }
            line = body;
        }
        if let Some(name) = whole(line, "⟦profile:") {
            if let Some(value) = generator(profile, name)? {
                out.push(value);
            }
            continue;
        }
        let mut expanded = String::new();
        while let Some((before, rest)) = line.split_once("⟦profile:") {
            expanded.push_str(before);
            let (name, after) = rest
                .split_once('⟧')
                .ok_or_else(|| refuse("prompt_invalid", "unterminated profile marker"))?;
            expanded.push_str(&generator(profile, name)?.ok_or_else(|| {
                refuse(
                    "prompt_invalid",
                    format!("profile marker {name} is empty inside a line"),
                )
            })?);
            line = after;
        }
        expanded.push_str(line);
        out.push(expanded);
    }
    let result = out.join("\n");
    if result.contains("⟦profile:")
        || result.contains("⟦if ")
        || (with_frames && result.contains("⟦mc:"))
    {
        return Err(refuse("prompt_invalid", "unexpanded prompt marker"));
    }
    if !with_frames
        && result
            .split('\n')
            .any(|l| l.contains("⟦mc:") && whole(l, "⟦mc:").is_none())
    {
        return Err(refuse(
            "prompt_invalid",
            "an MC marker must stand on its own line",
        ));
    }
    Ok(result)
}

fn definitions(profile: &Profile, entries: &[&Value]) -> Result<String> {
    entries
        .iter()
        .map(|entry| {
            expand(
                profile,
                frames::source(profile.member(entry, "definition_file")?)?,
                false,
                None,
            )
        })
        .collect::<Result<Vec<_>>>()
        .map(|v| v.join("\n"))
}

fn task<'a>(profile: &'a Profile, kind: &str) -> Result<&'a Value> {
    list(&profile.body, "tasks")
        .iter()
        .find(|t| t["kind"] == kind && t["enabled"] == true)
        .ok_or_else(|| refuse("prompt_invalid", format!("no {kind} task")))
}

fn generator(profile: &Profile, name: &str) -> Result<Option<String>> {
    let body = &profile.body;
    let facts = categories(profile, "fact");
    let users = categories(profile, "user-observation");
    let events: Vec<_> = list(&body["extraction"], "events").iter().collect();
    let tags = |entries: &[&Value]| {
        entries
            .iter()
            .map(|c| text(c, "tag"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let shapes = |entries: &[&Value], content: &str| {
        entries
            .iter()
            .map(|c| format!("<{}>\n{content}\n</{}>", text(c, "tag"), text(c, "tag")))
            .collect::<Vec<_>>()
            .join("\n")
    };
    if let Some((tag, field)) = name.split_once('.') {
        let values = events
            .iter()
            .find(|e| e["tag"] == tag)
            .and_then(|e| e["enums"][field].as_array())
            .ok_or_else(|| refuse("prompt_invalid", format!("unknown event enum {name}")))?;
        return Ok(Some(
            values
                .iter()
                .map(|v| v.as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" | "),
        ));
    }
    let value = match name {
        "fact-category-count" => facts.len().to_string(),
        "fact-category-definitions" => definitions(profile, &facts)?,
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
        "fact-category-taxonomy" => facts
            .iter()
            .map(|c| format!("- **{}** — {}", text(c, "tag"), text(c, "description")))
            .collect::<Vec<_>>()
            .join("\n"),
        "fact-category-tags" => tags(&facts),
        "fact-shape-blocks" => {
            if facts.is_empty() {
                return Ok(None);
            }
            shapes(&facts, "* Fact text")
        }
        "project-memory-groups" => facts
            .iter()
            .map(|c| {
                let tag = text(c, "tag");
                format!("<{tag}>\n- ⟦{tag}.memory.content⟧\n</{tag}>")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "user-category-definitions" => definitions(profile, &users)?,
        "user-category-tags" => tags(&users),
        "user-category-list" => users
            .iter()
            .map(|c| {
                let visibility = if c["visibility"] == "all-profiles" {
                    "every profile's agents".to_owned()
                } else {
                    format!("only agents running {}", text(c, "_from"))
                };
                format!(
                    "- **{}** ({}; seen by {}) — {}",
                    text(c, "tag"),
                    text(c, "default_level"),
                    visibility,
                    text(c, "description")
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "user-observation-shape-blocks" => {
            if users.is_empty() {
                return Ok(None);
            }
            shapes(&users, "* Observation text")
        }
        "event-definitions" => definitions(profile, &events)?,
        "event-shape-blocks" => {
            if events.is_empty() {
                return Ok(None);
            }
            events
                .iter()
                .map(|e| {
                    let tag = text(e, "tag");
                    let fields = list(e, "shape_fields")
                        .iter()
                        .map(|f| {
                            let f = f.as_str().unwrap_or_default();
                            format!("<{f}>...</{f}>")
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("<{tag} at_compartment=\"N\">\n{fields}\n</{tag}>")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "episode-types" => list(&body["extraction"], "episode_types")
            .iter()
            .map(|t| format!("`{}`", t.as_str().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join(", "),
        "decay-class-list" => list(body, "decay_classes")
            .iter()
            .map(|d| format!("  - `{}`: {}", text(d, "id"), text(d, "meaning")))
            .collect::<Vec<_>>()
            .join("\n"),
        "memory-guidance-categories" => {
            if facts.is_empty() {
                return Ok(None);
            }
            let examples = list(&body["main_agent"], "memory_examples")
                .iter()
                .map(|e| {
                    let tag = facts
                        .iter()
                        .find(|c| c["id"] == e["category"])
                        .map(|c| text(c, "tag"))
                        .ok_or_else(|| {
                            refuse("prompt_invalid", "unknown memory example category")
                        })?;
                    Ok(format!(
                        "category=\"{tag}\", content=\"{}\"",
                        text(e, "content")
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let examples = if examples.is_empty() {
                String::new()
            } else {
                format!(" Examples: {}", examples.join(" · "))
            };
            format!(
                "Categories for `ctx_memory`: {}.{examples}",
                facts
                    .iter()
                    .map(|c| format!("{} ({})", text(c, "tag"), text(c, "guidance_hint")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        "memory-guidance-categories-light" => {
            if facts.is_empty() {
                return Ok(None);
            }
            format!(
                "Categories: {}.",
                facts
                    .iter()
                    .map(|c| format!("{} ({})", text(c, "tag"), text(c, "guidance_hint_light")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        "cue-chars-high" | "cue-chars-low" | "cue-high-from" => task(profile, "compress-cues")?
            ["settings"][name.replace('-', "_")]
        .as_u64()
        .ok_or_else(|| refuse("prompt_invalid", format!("missing {name}")))?
        .to_string(),
        "min-proof-count" => task(profile, "reflect-events")?["settings"]["min_proof_count"]
            .as_u64()
            .ok_or_else(|| refuse("prompt_invalid", "missing min-proof-count"))?
            .to_string(),
        _ => {
            return Err(refuse(
                "prompt_invalid",
                format!("unknown profile marker {name}"),
            ))
        }
    };
    Ok(Some(value))
}

#[cfg(test)]
#[path = "documents_tests.rs"]
pub(crate) mod tests;
