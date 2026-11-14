//! The head is captured only when a view changes. Splitting it into sections
//! and counting tokens run on the app-read thread when an app asks, never in
//! the work a session does for each step of its runner.
#[cfg(test)]
use super::Snapshot;
use super::{error, invalid, Refusal, REPLY_BUDGET};
use crate::count::Counter;
use crate::summary::head::{Baseline, Form, M0_ID, M1_EMPTY, M1_ID};
use cortexkit_role_compaction::view::{EditOp, InsertedImage, View};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Default)]
pub(crate) struct ReadState {
    pub ready: bool,
    pub offered: Option<Arc<Head>>,
    pub confirmed: Option<Arc<Head>>,
    pub counter: Option<Counter>,
}

pub(crate) struct Head {
    pub version: u64,
    slots: Vec<Arc<Slot>>,
    baseline: Option<Arc<Baseline>>,
    counter: Counter,
}

struct Slot {
    id: String,
    text: String,
    image: Option<InsertedImage>,
}

impl ReadState {
    pub fn record(&mut self, view: &View, baseline: Option<Arc<Baseline>>, model: &str) {
        let previous = self.offered.as_ref().or(self.confirmed.as_ref());
        let slots = view
            .edits
            .iter()
            .filter_map(|edit| {
                let EditOp::Insert { message, .. } = &edit.op else {
                    return None;
                };
                if message.id != M0_ID && message.id != M1_ID {
                    return None;
                }
                // Inserts retain their bytes in a conversation-only rebuild. Compare
                // before copying so large heads and images remain shared across it.
                let old = previous.and_then(|head| {
                    head.slots.iter().find(|slot| {
                        slot.id == message.id
                            && message.texts.len() == 1
                            && slot.text == message.texts[0]
                            && slot.image.as_ref() == message.images.first()
                    })
                });
                Some(old.cloned().unwrap_or_else(|| {
                    Arc::new(Slot {
                        id: message.id.clone(),
                        text: message.texts.join("\n"),
                        image: message.images.first().cloned(),
                    })
                }))
            })
            .collect::<Vec<_>>();
        // The baseline's metadata (which summaries and corrections it holds)
        // is kept only when it describes the baseline text this view inserts:
        // either both are the ones the previous head held, or the text equals
        // the baseline's own rendering. A runner restored to an older view
        // inserts an older text, and items taken from a newer baseline would
        // then name summaries that text does not show.
        let baseline = baseline.filter(|baseline| {
            previous.is_some_and(|head| {
                head.baseline
                    .as_ref()
                    .is_some_and(|old| Arc::ptr_eq(old, baseline))
            }) && slots
                .iter()
                .find(|slot| slot.id == M0_ID)
                .zip(previous.and_then(|head| head.slots.iter().find(|slot| slot.id == M0_ID)))
                .is_some_and(|(new, old)| Arc::ptr_eq(new, old))
                || slots
                    .iter()
                    .find(|slot| slot.id == M0_ID)
                    .is_some_and(|slot| {
                        slot.text == crate::neutral::without_tag_notation(&baseline.m0)
                    })
        });
        self.offered = Some(Arc::new(Head {
            version: view.version,
            slots,
            baseline,
            counter: Counter::for_model(Some(model)),
        }));
        self.counter = Some(Counter::for_model(Some(model)));
        self.ready = true;
    }

    pub fn confirm(&mut self, version: u64) {
        if let Some(head) = self.offered.as_ref().filter(|head| head.version == version) {
            self.confirmed = Some(head.clone());
        }
    }
}

#[cfg(test)]
pub(crate) fn read(snapshot: &Snapshot, state: Option<&ReadState>) -> Result<Value, Refusal> {
    let breakdown = snapshot.breakdown.without_summaries();
    read_breakdown(breakdown, state)
}

pub(super) fn not_ready() -> Refusal {
    error(
        "head_not_ready",
        "The session has not set up with its runner since the module started.",
    )
}

pub(super) fn read_breakdown(
    breakdown: &Value,
    state: Option<&ReadState>,
) -> Result<Value, Refusal> {
    let managed = breakdown["managed"]["value"].as_bool().unwrap_or(false);
    let state = state.filter(|state| state.ready);
    if managed && state.is_none() {
        return Err(not_ready());
    }
    let head = state.and_then(|state| state.offered.as_ref().or(state.confirmed.as_ref()));
    let applied = head.is_some_and(|head| {
        state
            .and_then(|state| state.confirmed.as_ref())
            .is_some_and(|confirmed| confirmed.version == head.version)
    });
    let mut as_of = json!({"view":head.map(|head|head.version),"applied":applied});
    for field in ["step_ref", "at_ms"] {
        if let Some(value) = breakdown["as_of"]
            .get(field)
            .filter(|value| !value.is_null())
        {
            as_of[field] = value.clone();
        }
    }
    let mut messages = Vec::new();
    if let Some(head) = head.filter(|_| managed) {
        for id in [M0_ID, M1_ID] {
            if let Some(slot) = head.slots.iter().find(|slot| slot.id == id) {
                messages.push(message(
                    slot,
                    head,
                    state
                        .and_then(|state| state.counter)
                        .unwrap_or(head.counter),
                )?);
            }
        }
    }
    let mut outline = json!({"as_of":as_of,"managed":managed,"messages":messages});
    // Attribution can grow independently of the head's text. Keep the outline
    // readable even when an unusually large item list exhausts the frame.
    while super::result_bytes(outline.clone()).len() > REPLY_BUDGET {
        let largest = outline["messages"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .flat_map(|(m, message)| {
                message["sections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .filter_map(move |(s, section)| {
                        section
                            .get("items")
                            .map(|items| (serde_json::to_vec(items).unwrap().len(), m, s))
                    })
            })
            .max();
        let Some((_, m, s)) = largest else { break };
        let section = outline["messages"][m]["sections"][s]
            .as_object_mut()
            .unwrap();
        section.remove("items");
        section.insert("items_omitted".into(), json!("too_large"));
    }
    Ok(outline)
}

/// Fixed renderer wrappers delimit sections; content inside these wrappers is
/// escaped by the composers. Slice rather than re-render to retain every byte.
fn split(text: &str, delta: bool) -> Result<Vec<(&'static str, &str)>, Refusal> {
    let wrappers: &[(&str, &str)] = if delta {
        &[
            ("memory_updates", "memory-updates"),
            ("history", "new-compartments"),
            // Heads built before the profile's lines became global memories,
            // still served until the session's next fold.
            ("user_profile", "new-user-profile"),
        ]
    } else {
        &[
            ("project_docs", "project-docs"),
            ("user_profile", "user-profile"),
            ("history", "session-history"),
            // The workspace's memories, then the project's: both are memory
            // sections, with the same `#id: fact` and `#id [project]: fact`
            // lines.
            ("memory", "workspace-memory"),
            ("memory", "project-memory"),
            ("memory_mural", "memory-mural"),
        ]
    };
    let mut rest = if delta {
        text.strip_prefix("<session-history-since>\n")
            .and_then(|text| text.strip_suffix("\n</session-history-since>"))
            .ok_or_else(unavailable)?
    } else {
        text
    };
    let mut sections = Vec::new();
    for &(kind, tag) in wrappers {
        let open = format!("<{tag}>");
        if !rest.starts_with(&open) {
            continue;
        }
        let close = format!("</{tag}>");
        let Some(end) = rest.find(&close).map(|end| end + close.len()) else {
            break;
        };
        let after = &rest[end..];
        let separator = if delta { "\n" } else { "\n\n" };
        if !after.is_empty() && !after.starts_with(separator) {
            break;
        }
        sections.push((kind, &rest[..end]));
        rest = after;
        if !rest.is_empty() {
            rest = &rest[separator.len()..];
            if rest.is_empty() {
                sections.push(("other", rest));
            }
        }
    }
    if !rest.is_empty() {
        sections.push(("other", rest));
    }
    Ok(sections)
}

fn unavailable() -> Refusal {
    error("store_unavailable", "The session head could not be read.")
}

fn message(slot: &Slot, head: &Head, counter: Counter) -> Result<Value, Refusal> {
    let delta = slot.id == M1_ID;
    let mut message = json!({"slot":if delta {"delta"} else {"baseline"},"tokens":counter.count(&slot.text),"bytes":slot.text.len(),"sections":[]});
    if delta && slot.text == M1_EMPTY {
        message["empty"] = json!(true);
        message["placeholder"] = json!(slot.text);
        return Ok(message);
    }
    let mut sections = Vec::new();
    for (index, (kind, text)) in split(&slot.text, delta)?.into_iter().enumerate() {
        let mut section =
            json!({"index":index,"kind":kind,"tokens":counter.count(text),"bytes":text.len()});
        match kind {
            "project_docs" => {
                static FILES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new(r#"(?s)<file name="([^"]*)">.*?</file>"#)
                        .expect("file wrappers")
                });
                let items = FILES.captures_iter(text).map(|m| {
                    let range = m.get(0).unwrap();
                    json!({"name":unescape(&m[1]),"tokens":counter.count(range.as_str()),"start":range.start(),"len":range.len()})
                }).collect::<Vec<_>>();
                if !items.is_empty() {
                    section["items"] = json!(items);
                }
            }
            "history" => {
                if let Some(baseline) = &head.baseline {
                    let items = baseline
                        .summary_items
                        .iter()
                        .filter(|item| {
                            let in_baseline = item
                                .compartment_id
                                .parse::<i64>()
                                .is_ok_and(|id| id <= baseline.through_sequence);
                            in_baseline != delta
                        })
                        .collect::<Vec<_>>();
                    let empty = baseline.through_sequence == -1
                        || baseline.through_sequence == 0
                            && text == crate::summary::head::HISTORY_EMPTY;
                    if !items.is_empty() || !delta && empty {
                        section["items"] = json!(items);
                    }
                }
            }
            "memory" => {
                if let Some(level) = memory_level(text) {
                    section["level"] = json!(level);
                }
                if let Some(items) = memory_items(text, counter) {
                    section["items"] = json!(items);
                }
            }
            "memory_updates" => {
                if let Some(baseline) = &head.baseline {
                    let mut cursor = 0;
                    let mut items = Vec::new();
                    let mut known = true;
                    for entry in &baseline.committed {
                        for line in &entry.lines {
                            let line = crate::neutral::without_tag_notation(line);
                            if line.is_empty() {
                                known = false;
                                break;
                            }
                            let Some(start) = text[cursor..].find(&line).map(|n| cursor + n) else {
                                known = false;
                                break;
                            };
                            let mut item = json!({"form":match entry.form { Form::Full=>"full",Form::Marker=>"marker",Form::Overflow=>"overflow" },"start":start,"len":line.len()});
                            let (level, category) = update_attributes(&line);
                            if let Some(level) = level {
                                item["level"] = json!(level);
                            }
                            if let Some(category) = category {
                                item["category"] = json!(category);
                            }
                            items.push(item);
                            cursor = start + line.len();
                        }
                    }
                    if known && !items.is_empty() {
                        section["items"] = json!(items);
                    }
                }
            }
            "memory_mural" => {
                if let Some(image) = &slot.image {
                    use base64::Engine as _;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&image.data)
                        .map_err(|_| unavailable())?;
                    section["image"] = json!({"media_type":image.media_type,"sha256":format!("{:x}",Sha256::digest(&bytes)),"bytes":bytes.len(),"tokens":null});
                }
            }
            _ => {}
        }
        validate_ranges(&mut section, text);
        sections.push(section);
    }
    message["sections"] = json!(sections);
    if delta {
        message["empty"] = json!(false);
        message["wrapper"] =
            json!({"open":"<session-history-since>","close":"</session-history-since>"});
    }
    Ok(message)
}

/// The level a `memory` section's wrapper names. `split` cuts a memory
/// section only at `<workspace-memory>` (the workspace's memories) or
/// `<project-memory>` (the project's), so the opening tag says which.
fn memory_level(text: &str) -> Option<&'static str> {
    [
        ("<workspace-memory>", "workspace"),
        ("<project-memory>", "project"),
    ]
    .into_iter()
    .find(|(open, _)| text.starts_with(open))
    .map(|(_, level)| level)
}

/// The `level` and `category` attributes of a memory-update line's opening
/// tag, for example `<updated id="1" level="global" category="USER">`.
/// Each is `None` when the line doesn't carry it: update lines written
/// before memories had levels have no `level`, and the out-of-date markers
/// and the overflow line have neither. Attribute values are escaped, so the
/// first `>` ends the opening tag.
fn update_attributes(line: &str) -> (Option<String>, Option<String>) {
    static ATTRIBUTE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"\s([A-Za-z_-]+)="([^"]*)""#).expect("update attributes")
    });
    let Some(open) = line
        .trim_start()
        .strip_prefix('<')
        .and_then(|rest| rest.split_once('>'))
        .map(|(open, _)| open)
    else {
        return (None, None);
    };
    let attribute = |name: &str| {
        ATTRIBUTE
            .captures_iter(open)
            .find(|m| &m[1] == name)
            .map(|m| unescape(&m[2]))
            .filter(|value| !value.is_empty())
    };
    (attribute("level"), attribute("category"))
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn validate_ranges(section: &mut Value, text: &str) {
    let valid =
        section
            .get("items")
            .and_then(Value::as_array)
            .is_none_or(|items| {
                items.iter().all(|item| {
                    if item.get("start").is_none() && item.get("len").is_none() {
                        return true;
                    }
                    let range = item["start"].as_u64().zip(item["len"].as_u64()).and_then(
                        |(start, len)| {
                            Some((
                                usize::try_from(start).ok()?,
                                usize::try_from(start.checked_add(len)?).ok()?,
                            ))
                        },
                    );
                    range.is_some_and(|(start, end)| {
                        text.is_char_boundary(start) && text.is_char_boundary(end)
                    })
                })
            });
    if !valid {
        section.as_object_mut().unwrap().remove("items");
    }
}

fn memory_items(text: &str, counter: Counter) -> Option<Vec<Value>> {
    // Shared memories have unindented continuation lines, so their boundaries
    // cannot be proved once one appears. Continuations that all look like new
    // memory starts remain indistinguishable without renderer-recorded boundaries.
    static START: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^#([0-9]+)(?: \[(.*?)\])?: ").expect("memory start")
    });
    let mut category = "";
    let mut items: Vec<Value> = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for line in text.lines().skip(1) {
        if line.starts_with('<') {
            if !line.starts_with("</") {
                category = line.trim_start_matches('<').trim_end_matches('>');
            }
        } else if let Some(start) = START.captures(line) {
            let id = start[1].parse::<i64>().ok()?;
            if !ids.insert(id) {
                return None;
            }
            let mut item = json!({"id":id,"category":unescape(category),"text":line});
            if let Some(source) = start.get(2) {
                item["source"] = json!(unescape(source.as_str()));
            }
            items.push(item);
        } else if let Some(item) = items.last_mut() {
            if item.get("source").is_some() {
                return None;
            }
            item["text"] = json!(format!(
                "{}\n{line}",
                item["text"].as_str().expect("memory text")
            ));
        }
    }
    // Items are in text order. Each is searched for after the previous one,
    // so a memory whose content quotes a later memory's line cannot take that
    // memory's range.
    let mut cursor = 0;
    for item in &mut items {
        let rendered = item.as_object_mut().unwrap().remove("text").unwrap();
        let rendered = rendered.as_str().expect("memory text");
        let start = cursor + text[cursor..].find(rendered)?;
        item["tokens"] = json!(counter.count(rendered));
        item["start"] = json!(start);
        item["len"] = json!(rendered.len());
        cursor = start + rendered.len();
    }
    (!items.is_empty()).then_some(items)
}

#[path = "head_section.rs"]
mod section;
pub(super) use section::{read_section, SectionRequest};

#[cfg(test)]
#[path = "head_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "head_v12_tests.rs"]
mod v12_tests;

#[cfg(test)]
#[path = "head_levels_tests.rs"]
mod levels_tests;
