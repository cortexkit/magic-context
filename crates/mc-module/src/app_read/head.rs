//! The head is captured only when a view changes. Splitting and counting belong
//! to the app-read thread, not to a session's steady-state notice work.
use super::{error, Refusal, Snapshot};
use crate::count::Counter;
use crate::summary::head::{Baseline, Form, M0_ID, M1_ID};
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

pub(crate) fn read(snapshot: &Snapshot, state: Option<&ReadState>) -> Result<Value, Refusal> {
    let breakdown = snapshot.breakdown.without_summaries();
    let managed = breakdown["managed"]["value"].as_bool().unwrap_or(false);
    let state = state.filter(|state| state.ready);
    if managed && state.is_none() {
        return Err(error(
            "head_not_ready",
            "The session has not set up with its runner since the module started.",
        ));
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
    Ok(json!({"as_of":as_of,"managed":managed,"messages":messages}))
}

/// Fixed renderer wrappers delimit sections; content inside these wrappers is
/// escaped by the composers. Slice rather than re-render to retain every byte.
fn split(text: &str, delta: bool) -> Result<Vec<(&'static str, &str)>, Refusal> {
    let wrappers: &[(&str, &str)] = if delta {
        &[
            ("memory_updates", "memory-updates"),
            ("history", "new-compartments"),
            ("user_profile", "new-user-profile"),
        ]
    } else {
        &[
            ("project_docs", "project-docs"),
            ("user_profile", "user-profile"),
            ("history", "session-history"),
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
        let end = rest.find(&close).ok_or_else(unavailable)? + close.len();
        sections.push((kind, &rest[..end]));
        rest = &rest[end..];
        if !rest.is_empty() {
            rest = rest
                .strip_prefix(if delta { "\n" } else { "\n\n" })
                .ok_or_else(unavailable)?;
        }
    }
    if !rest.is_empty() {
        return Err(unavailable());
    }
    Ok(sections)
}

fn unavailable() -> Refusal {
    error("store_unavailable", "The session head could not be read.")
}

fn message(slot: &Slot, head: &Head, counter: Counter) -> Result<Value, Refusal> {
    let delta = slot.id == M1_ID;
    let mut message = json!({"slot":if delta {"delta"} else {"baseline"},"tokens":counter.count(&slot.text),"sections":[]});
    if delta && !slot.text.starts_with("<session-history-since>\n") {
        message["empty"] = json!(true);
        message["placeholder"] = json!(slot.text);
        return Ok(message);
    }
    let mut sections = Vec::new();
    for (kind, text) in split(&slot.text, delta)? {
        let mut section = json!({"kind":kind,"tokens":counter.count(text),"text":text});
        match kind {
            "project_docs" => {
                static FILES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new(r#"(?s)<file name="([^"]*)">.*?</file>"#)
                        .expect("file wrappers")
                });
                section["items"] = json!(FILES.captures_iter(text).map(|m|json!({"name":unescape(&m[1]),"tokens":counter.count(&m[0]),"text":&m[0]})).collect::<Vec<_>>());
            }
            "history" => {
                if let Some(baseline) = &head.baseline {
                    section["items"] = json!(baseline
                        .summary_items
                        .iter()
                        .filter(|item| {
                            let in_baseline = item
                                .compartment_id
                                .parse::<i64>()
                                .is_ok_and(|id| id <= baseline.through_sequence);
                            in_baseline != delta
                        })
                        .collect::<Vec<_>>());
                }
            }
            "memory" => {
                section["items"] = json!(memory_items(text, counter));
            }
            "memory_updates" => {
                if let Some(baseline) = &head.baseline {
                    section["items"] = json!(baseline.committed.iter().flat_map(|entry|entry.lines.iter().map(move |line|json!({"form":match entry.form { Form::Full=>"full",Form::Marker=>"marker",Form::Overflow=>"overflow" },"text":crate::neutral::without_tag_notation(line)}))).collect::<Vec<_>>());
                }
            }
            "memory_mural" => {
                if let Some(image) = &slot.image {
                    use base64::Engine as _;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&image.data)
                        .map_err(|_| unavailable())?;
                    section["image"] = json!({"media_type":image.media_type,"sha256":format!("{:x}",Sha256::digest(bytes)),"data":image.data,"tokens":null});
                }
            }
            _ => {}
        }
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

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn memory_items(text: &str, counter: Counter) -> Vec<Value> {
    let mut category = "";
    let mut items: Vec<Value> = Vec::new();
    for line in text.lines().skip(1) {
        if line.starts_with('<') {
            if !line.starts_with("</") {
                category = line.trim_start_matches('<').trim_end_matches('>');
            }
        } else if let Some((id, _)) = line.strip_prefix('#').and_then(|line| line.split_once(':')) {
            if let Ok(id) = id.parse::<i64>() {
                items.push(json!({"id":id,"category":unescape(category),"text":line}));
            }
        } else if let Some(item) = items.last_mut() {
            item["text"] = json!(format!(
                "{}\n{line}",
                item["text"].as_str().expect("memory text")
            ));
        }
    }
    for item in &mut items {
        item["tokens"] = json!(counter.count(item["text"].as_str().expect("memory text")));
    }
    items
}

#[cfg(test)]
#[path = "head_tests.rs"]
mod tests;
