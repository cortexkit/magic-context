//! Applying a view: the render plan a runner renders from, and what the
//! model sees in the neutral part model.
//!
//! The provider computes every byte it puts in a view (placeholders such as
//! `[dropped §12§]`, cut-down edit arguments, the history head). The runner
//! adds nothing to them, not even a tag prefix; every other numbered text is
//! rendered with its prefix ([`RenderedMessage::wire_text`]).
//!
//! No edit changes a tag number: the runner counts from the transcript, not
//! from what it renders. The only way a view could mislead the model's count
//! is a number written into its own bytes, so [`plan`] refuses an inserted
//! message that carries a tag prefix, and a replaced field that carries one
//! the part neither owns nor already contained.

use std::collections::{BTreeSet, HashMap, HashSet};

use ck_contract_draft::part::{Part, PartBody, Seal, ToolStatus};
use ck_contract_draft::read::{Entry, NoticeOrigin, Role};
use ck_contract_draft::view::{Edit, EditOp, InsertAt, InsertedMessage, View, ViewRefusal};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tags::tag_numbers_in;

/// One message as the model sees it after a view is applied.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderedMessage {
    /// The transcript message it comes from, or the inserted message's id.
    pub source: Source,
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<NoticeOrigin>,
    /// The parts that remain, with replaced fields applied. A replaced part
    /// keeps its id and tag and gets a new checksum.
    pub parts: Vec<Part>,
    /// The parts whose text (a text part's text or a tool result's output)
    /// a view replaced. Those bytes are final: no tag prefix goes in front.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub final_text: BTreeSet<String>,
}

impl RenderedMessage {
    /// The text the model sees for a text part or a finished tool result:
    /// the tag prefix ([`crate::tags::tag_prefix`]) then the stored text, or
    /// a view's replaced bytes as they are. `None` for other parts and for a
    /// tool still running.
    pub fn wire_text(&self, part: &Part) -> Option<String> {
        let text = match &part.body {
            PartBody::Text { text } => text,
            PartBody::Tool(tool) => match crate::tags::empty_result_label(tool) {
                Some(label) if !self.final_text.contains(&part.id) => {
                    let prefix = part.tag.map(crate::tags::tag_prefix).unwrap_or_default();
                    return Some(format!("{prefix}{label}"));
                }
                _ => tool.output.as_ref()?,
            },
            PartBody::Reasoning { .. } | PartBody::File(_) | PartBody::Opaque(_) => return None,
        };
        match part.tag {
            Some(tag) if !self.final_text.contains(&part.id) => {
                Some(format!("{}{text}", crate::tags::tag_prefix(tag)))
            }
            _ => Some(text.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Entry { ordinal: u64, mid: String },
    Inserted { id: String },
}

/// Apply a view to the transcript and return what the model sees, in the
/// neutral part model. It checks the view's checksum and shape;
/// [`crate::rules::check`] checks the provider rules on top.
pub fn apply(entries: &[Entry], view: &View) -> Result<Vec<RenderedMessage>, ViewRefusal> {
    if !view.verify() {
        return Err(ViewRefusal::BadChecksum);
    }
    apply_edits(entries, &view.edits)
}

/// What a runner renders, as instructions over its own host messages
/// (contract W6.3). Runners render from it, so everything it keeps goes out
/// byte-identical: signatures, encrypted reasoning, item ids and cache
/// markers stay as the host stored them. An entry or a part the plan does not
/// list is left out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderPlan {
    /// In render order.
    pub items: Vec<PlanItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "item", rename_all = "snake_case")]
pub enum PlanItem {
    /// A message the view inserts, rendered with exactly these texts and
    /// never numbered.
    Insert {
        id: String,
        role: Role,
        texts: Vec<String>,
    },
    /// A transcript entry the model sees, with the parts it keeps in host
    /// order.
    Entry {
        ordinal: u64,
        mid: String,
        parts: Vec<PlanPart>,
    },
}

impl PlanItem {
    fn inserted(message: &InsertedMessage) -> Self {
        PlanItem::Insert {
            id: message.id.clone(),
            role: message.role,
            texts: message.texts.clone(),
        }
    }
}

/// One part a plan keeps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanPart {
    pub id: String,
    /// The part's number, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<u64>,
    /// Whether the runner renders the prefix ([`crate::tags::tag_prefix`]) in
    /// front of the part's text, or its tool result. False for a part with no
    /// number and for text a replace wrote, which is final.
    pub prefix: bool,
    /// For a finished tool result with no text: what the runner renders after
    /// the prefix ([`crate::tags::empty_result_label`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_result_label: Option<String>,
    /// Fields the runner renders with new bytes, in edit order. The runner
    /// maps each neutral field to its host's field (for example a failed
    /// call's error text for `output`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replace: Vec<FieldReplace>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FieldReplace {
    pub field: String,
    pub value: Value,
}

/// Turn a view's edits and the transcript into a render plan, checking the
/// view's shape (every refusal of [`ViewRefusal`] except the checksum, the
/// version and `since`, which need the view itself or the previous one).
pub fn plan(entries: &[Entry], edits: &[Edit]) -> Result<RenderPlan, ViewRefusal> {
    let by_mid: HashMap<&str, &Entry> = entries
        .iter()
        .map(|entry| (entry.mid.as_str(), entry))
        .collect();

    let mut dropped_messages: HashSet<&str> = HashSet::new();
    let mut dropped_parts: HashSet<(&str, &str)> = HashSet::new();
    let mut replaces: HashMap<(&str, &str), Vec<(&str, &Value)>> = HashMap::new();
    let mut inserts_at_start: Vec<&InsertedMessage> = Vec::new();
    let mut inserts_before: HashMap<&str, Vec<&InsertedMessage>> = HashMap::new();
    let mut insert_ids: HashSet<&str> = HashSet::new();
    let mut cut: Option<u64> = None;

    for edit in edits {
        match &edit.op {
            EditOp::Drop { mid, part } => {
                let entry = find_entry(&by_mid, mid)?;
                match part {
                    None => {
                        for part in &entry.parts {
                            refuse_running(mid, part)?;
                        }
                        dropped_messages.insert(mid);
                    }
                    Some(part_id) => {
                        let part = find_part(entry, part_id)?;
                        refuse_running(mid, part)?;
                        dropped_parts.insert((mid, part_id));
                    }
                }
            }
            EditOp::Replace {
                mid,
                part,
                field,
                value,
                expect,
            } => {
                let entry = find_entry(&by_mid, mid)?;
                let found = find_part(entry, part)?;
                refuse_running(mid, found)?;
                if &found.digest != expect {
                    return Err(ViewRefusal::StalePart {
                        mid: mid.clone(),
                        part: part.clone(),
                    });
                }
                check_field(mid, found, field, value)?;
                check_replaced_tags(mid, found, field, value)?;
                let fields = replaces.entry((mid, part)).or_default();
                if fields.iter().any(|(existing, _)| existing == field) {
                    return Err(ViewRefusal::Conflict {
                        mid: mid.clone(),
                        part: part.clone(),
                    });
                }
                fields.push((field, value));
            }
            EditOp::Cut { through } => {
                if cut.is_some() {
                    return Err(ViewRefusal::DuplicateCut);
                }
                let last = find_entry(&by_mid, through)?.ordinal;
                for entry in entries.iter().take_while(|entry| entry.ordinal <= last) {
                    for part in &entry.parts {
                        refuse_running(&entry.mid, part)?;
                    }
                    dropped_messages.insert(&entry.mid);
                }
                cut = Some(last);
            }
            EditOp::Insert { at, message } => {
                if !insert_ids.insert(&message.id) {
                    return Err(ViewRefusal::DuplicateInsert {
                        id: message.id.clone(),
                    });
                }
                if message
                    .texts
                    .iter()
                    .any(|text| !tag_numbers_in(text).is_empty())
                {
                    return Err(ViewRefusal::TaggedInsert {
                        id: message.id.clone(),
                    });
                }
                match at {
                    InsertAt::Start => inserts_at_start.push(message),
                    InsertAt::Before(mid) => {
                        find_entry(&by_mid, mid)
                            .map_err(|_| ViewRefusal::UnknownAnchor { mid: mid.clone() })?;
                        inserts_before.entry(mid).or_default().push(message);
                    }
                }
            }
        }
    }

    for (mid, part) in replaces.keys() {
        if dropped_messages.contains(mid) || dropped_parts.contains(&(*mid, *part)) {
            return Err(ViewRefusal::Conflict {
                mid: (*mid).to_owned(),
                part: (*part).to_owned(),
            });
        }
    }

    let mut items = Vec::with_capacity(entries.len() + inserts_at_start.len());
    items.extend(inserts_at_start.into_iter().map(PlanItem::inserted));
    for entry in entries {
        if let Some(before) = inserts_before.get(entry.mid.as_str()) {
            items.extend(before.iter().copied().map(PlanItem::inserted));
        }
        if dropped_messages.contains(entry.mid.as_str()) {
            continue;
        }
        let mut parts = Vec::with_capacity(entry.parts.len());
        for part in &entry.parts {
            if dropped_parts.contains(&(entry.mid.as_str(), part.id.as_str())) {
                continue;
            }
            let replace: Vec<FieldReplace> = replaces
                .get(&(entry.mid.as_str(), part.id.as_str()))
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(field, value)| FieldReplace {
                            field: (*field).to_owned(),
                            value: (*value).clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let text_is_final = writes_final_text(&replace);
            let empty_result_label = match &part.body {
                PartBody::Tool(tool) if !text_is_final => {
                    crate::tags::empty_result_label(tool).map(str::to_owned)
                }
                _ => None,
            };
            parts.push(PlanPart {
                id: part.id.clone(),
                tag: part.tag,
                prefix: part.tag.is_some() && !text_is_final,
                empty_result_label,
                replace,
            });
        }
        // A message left with no parts is not rendered at all.
        if parts.is_empty() {
            continue;
        }
        items.push(PlanItem::Entry {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            parts,
        });
    }
    Ok(RenderPlan { items })
}

/// Whether a part's replaces write its text (a text part's text or a tool
/// result's output). Those bytes are final: no prefix goes in front.
fn writes_final_text(replace: &[FieldReplace]) -> bool {
    replace
        .iter()
        .any(|edit| matches!(edit.field.as_str(), "text" | "output"))
}

/// Apply a view's edits to the transcript and return what the model sees, in
/// the neutral part model: the render plan ([`plan`]) carried out over the
/// entries. Providers use it to know their own view's effect.
pub fn apply_edits(entries: &[Entry], edits: &[Edit]) -> Result<Vec<RenderedMessage>, ViewRefusal> {
    let plan = plan(entries, edits)?;
    let by_mid: HashMap<&str, &Entry> = entries
        .iter()
        .map(|entry| (entry.mid.as_str(), entry))
        .collect();
    Ok(plan
        .items
        .iter()
        .map(|item| match item {
            PlanItem::Insert { id, role, texts } => render_inserted(id, *role, texts),
            PlanItem::Entry {
                ordinal,
                mid,
                parts,
            } => {
                let entry = by_mid[mid.as_str()];
                let mut final_text = BTreeSet::new();
                let parts = parts
                    .iter()
                    .map(|planned| {
                        let part = entry
                            .parts
                            .iter()
                            .find(|part| part.id == planned.id)
                            .expect("a plan lists only parts of its entry");
                        if planned.replace.is_empty() {
                            return part.clone();
                        }
                        if writes_final_text(&planned.replace) {
                            final_text.insert(part.id.clone());
                        }
                        replaced(part, &planned.replace)
                    })
                    .collect();
                RenderedMessage {
                    source: Source::Entry {
                        ordinal: *ordinal,
                        mid: mid.clone(),
                    },
                    role: entry.role,
                    notice: entry.notice.clone(),
                    parts,
                    final_text,
                }
            }
        })
        .collect())
}

/// The edits that still name messages in the transcript. After a revert or
/// a branch switch removes messages, the runner renders with these until the
/// provider sends a view for the new transcript: an edit for a message that is
/// gone has nothing left to change, so skipping it changes nothing the model
/// would have seen of the remaining messages.
pub fn edits_for_transcript(entries: &[Entry], edits: &[Edit]) -> Vec<Edit> {
    let present: HashSet<&str> = entries.iter().map(|entry| entry.mid.as_str()).collect();
    edits
        .iter()
        .filter(|edit| match &edit.op {
            EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => {
                present.contains(mid.as_str())
            }
            EditOp::Insert {
                at: InsertAt::Before(mid),
                ..
            } => present.contains(mid.as_str()),
            EditOp::Insert {
                at: InsertAt::Start,
                ..
            } => true,
            EditOp::Cut { through } => present.contains(through.as_str()),
        })
        .cloned()
        .collect()
}

fn find_entry<'a>(by_mid: &HashMap<&str, &'a Entry>, mid: &str) -> Result<&'a Entry, ViewRefusal> {
    by_mid
        .get(mid)
        .copied()
        .ok_or_else(|| ViewRefusal::UnknownMessage {
            mid: mid.to_owned(),
        })
}

fn find_part<'a>(entry: &'a Entry, part_id: &str) -> Result<&'a Part, ViewRefusal> {
    entry
        .parts
        .iter()
        .find(|part| part.id == part_id)
        .ok_or_else(|| ViewRefusal::UnknownPart {
            mid: entry.mid.clone(),
            part: part_id.to_owned(),
        })
}

fn refuse_running(mid: &str, part: &Part) -> Result<(), ViewRefusal> {
    match &part.body {
        PartBody::Tool(tool) if tool.status == ToolStatus::Running => {
            Err(ViewRefusal::RunningTool {
                mid: mid.to_owned(),
                part: part.id.clone(),
            })
        }
        _ => Ok(()),
    }
}

fn check_field(mid: &str, part: &Part, field: &str, value: &Value) -> Result<(), ViewRefusal> {
    let bad = || ViewRefusal::BadField {
        mid: mid.to_owned(),
        part: part.id.clone(),
        field: field.to_owned(),
    };
    // A sealed part is checked by the model provider as it is, and a
    // provider-run tool call is replayed by the host as it is: neither can
    // take new bytes, only be dropped.
    if part.seal != Seal::None {
        return Err(bad());
    }
    match (&part.body, field) {
        (PartBody::Text { .. }, "text") => value.as_str().map(|_| ()).ok_or_else(bad),
        // A file's place in its message is taken by text, such as a marker
        // that an answered image was removed.
        (PartBody::File(_), "text") => value.as_str().map(|_| ()).ok_or_else(bad),
        (PartBody::Tool(tool), _) if tool.provider_executed => Err(bad()),
        // A finished call has an output size in both part forms.
        (PartBody::Tool(tool), "output") if tool.output_bytes.is_some() => {
            value.as_str().map(|_| ()).ok_or_else(bad)
        }
        (PartBody::Tool(tool), "attachments") => {
            let existing: HashSet<&str> = tool
                .attachments
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect();
            let mut seen = BTreeSet::new();
            for id in value.as_array().ok_or_else(bad)? {
                let id = id.as_str().ok_or_else(bad)?;
                if !existing.contains(id) || !seen.insert(id) {
                    return Err(bad());
                }
            }
            Ok(())
        }
        (PartBody::Tool(tool), "delivered") => {
            let mut seen = BTreeSet::new();
            for index in value.as_array().ok_or_else(bad)? {
                let index = index.as_u64().ok_or_else(bad)?;
                if index >= tool.delivered.len() as u64 || !seen.insert(index) {
                    return Err(bad());
                }
            }
            Ok(())
        }
        (PartBody::Tool(tool), field) => {
            let key = field.strip_prefix("input.").ok_or_else(bad)?;
            match tool.input.get(key) {
                Some(Value::String(_)) => value.as_str().map(|_| ()).ok_or_else(bad),
                _ => Err(bad()),
            }
        }
        _ => Err(bad()),
    }
}

/// A replaced text field may show the part's own number (a placeholder needs
/// it) and any number its original text already showed (compressed text keeps
/// the references the model wrote), and no other. When the original is not at
/// hand (a tool output in the compact form), only the part's own number is
/// allowed.
fn check_replaced_tags(
    mid: &str,
    part: &Part,
    field: &str,
    value: &Value,
) -> Result<(), ViewRefusal> {
    let Some(new_text) = value.as_str() else {
        return Ok(());
    };
    let original: Option<&str> = match (&part.body, field) {
        (PartBody::Text { text }, "text") => Some(text),
        (PartBody::Tool(tool), "output") => tool.output.as_deref(),
        (PartBody::Tool(tool), field) => field
            .strip_prefix("input.")
            .and_then(|key| tool.input.get(key))
            .and_then(Value::as_str),
        _ => None,
    };
    let known: BTreeSet<u64> = original
        .map(tag_numbers_in)
        .unwrap_or_default()
        .into_iter()
        .collect();
    for number in tag_numbers_in(new_text) {
        if Some(number) != part.tag && !known.contains(&number) {
            return Err(ViewRefusal::ForeignTag {
                mid: mid.to_owned(),
                part: part.id.clone(),
                field: field.to_owned(),
                tag: number,
            });
        }
    }
    Ok(())
}

fn replaced(part: &Part, fields: &[FieldReplace]) -> Part {
    let mut body = part.body.clone();
    for FieldReplace { field, value } in fields {
        if field == "text" && matches!(body, PartBody::File(_)) {
            body = PartBody::Text {
                text: string_of(value),
            };
            continue;
        }
        match (&mut body, field.as_str()) {
            (PartBody::Text { text }, "text") => *text = string_of(value),
            (PartBody::Tool(tool), "output") => {
                let output = string_of(value);
                tool.output_bytes = Some(output.len() as u64);
                tool.output = Some(output);
            }
            (PartBody::Tool(tool), "attachments") => {
                let keep: HashSet<&str> = value
                    .as_array()
                    .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                tool.attachments
                    .retain(|attachment| keep.contains(attachment.id.as_str()));
            }
            (PartBody::Tool(tool), "delivered") => {
                let keep: HashSet<u64> = value
                    .as_array()
                    .map(|indexes| indexes.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                let mut index = 0u64;
                tool.delivered.retain(|_| {
                    let kept = keep.contains(&index);
                    index += 1;
                    kept
                });
            }
            (PartBody::Tool(tool), field) => {
                if let (Some(key), Some(input)) =
                    (field.strip_prefix("input."), tool.input.as_object_mut())
                {
                    input.insert(key.to_owned(), Value::String(string_of(value)));
                }
            }
            _ => {}
        }
    }
    Part::new(part.id.clone(), part.tag, part.seal, body)
}

fn string_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn render_inserted(id: &str, role: Role, texts: &[String]) -> RenderedMessage {
    RenderedMessage {
        source: Source::Inserted { id: id.to_owned() },
        role,
        notice: None,
        parts: texts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                Part::new(
                    format!("{id}:{index}"),
                    None,
                    Seal::None,
                    PartBody::Text { text: text.clone() },
                )
            })
            .collect(),
        final_text: BTreeSet::new(),
    }
}

/// Check that a new view's `since` values are honest against the view the
/// runner applies now: an edit claiming a version the runner already applied
/// must appear, unchanged, in that view, and no edit may claim a version later
/// than its own view. Versions in between are fine: the runner may not have
/// fetched every view the provider published. A view that passes cannot hide
/// a new edit from [`crate::rules::check`] by backdating it.
pub fn check_carried(previous: Option<&View>, next: &View) -> Result<(), ViewRefusal> {
    let previous_version = previous.map_or(0, |view| view.version);
    for edit in &next.edits {
        if edit.since == 0 || edit.since > next.version {
            return Err(ViewRefusal::BadSince);
        }
        if edit.since <= previous_version && !previous.is_some_and(|view| view.edits.contains(edit))
        {
            return Err(ViewRefusal::BadSince);
        }
    }
    Ok(())
}
