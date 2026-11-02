//! Views: what the provider wants the model to see, as edits over the
//! runner's transcript.
//!
//! A view is cumulative: each new version repeats every earlier edit and
//! adds its own, and an edit is never taken back except when a revert removes
//! the messages it named. Everything a view does not name is rendered
//! unchanged. Between two views the runner renders every request with the
//! same view and only appends new messages, so each request extends the
//! previous one byte for byte and the provider's cache keeps hitting.
//!
//! The provider computes every byte it puts in a view (placeholders such as
//! `[dropped §12§]`, cut-down edit arguments, the history head). The runner
//! adds nothing to them, not even a tag prefix; every other tagged text is
//! rendered with its prefix ([`RenderedMessage::wire_text`]).
//!
//! No edit changes a tag number: the runner counts from the transcript, not
//! from what it renders. The only way a view could mislead the model's count
//! is a number written into its own bytes, so [`apply`] refuses an inserted
//! message that carries a tag prefix, and a replaced field that carries one
//! the part neither owns nor already contained.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::part::{tag_numbers_in, Part, PartBody, Seal, ToolStatus};
use crate::read::{Entry, NoticeOrigin, Role};

/// A published view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct View {
    /// Increases with every view the provider publishes for the session.
    pub version: u64,
    /// Checksum of `version` and `edits` ([`View::seal`]).
    pub checksum: String,
    pub edits: Vec<Edit>,
}

impl View {
    /// Build a view, computing its checksum.
    pub fn seal(version: u64, edits: Vec<Edit>) -> Self {
        let checksum = view_checksum(version, &edits);
        Self {
            version,
            checksum,
            edits,
        }
    }

    /// Whether the checksum matches the content.
    pub fn verify(&self) -> bool {
        self.checksum == view_checksum(self.version, &self.edits)
    }

    pub fn applied(&self) -> AppliedView {
        AppliedView {
            version: self.version,
            checksum: self.checksum.clone(),
        }
    }
}

fn view_checksum(version: u64, edits: &[Edit]) -> String {
    #[derive(Serialize)]
    struct Sealed<'a> {
        version: u64,
        edits: &'a [Edit],
    }
    crate::digest::checksum(&Sealed { version, edits })
}

/// Names a view by version and checksum. A version alone is not enough: a
/// provider restored from an older backup could publish different content
/// under a version number the runner already applied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedView {
    pub version: u64,
    pub checksum: String,
}

/// One edit, with the view version that first held it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edit {
    /// The version of the first view that held this edit unchanged. A view
    /// repeats an earlier edit with its original `since`; a new or changed
    /// edit gets the view's own version. [`crate::rules`] uses it to tell
    /// which edits came after a signed reasoning part was generated, and
    /// [`check_carried`] lets the runner verify it against its previous view.
    pub since: u64,
    #[serde(flatten)]
    pub op: EditOp,
}

impl Edit {
    pub fn new(since: u64, op: EditOp) -> Self {
        Self { since, op }
    }
}

/// What an edit does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditOp {
    /// Leave out one part, or the whole message when `part` is absent.
    Drop {
        mid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<String>,
    },
    /// Render one field of a part with new bytes.
    Replace {
        mid: String,
        part: String,
        /// `text` (a text part), `output` (a tool result's text),
        /// `input.<key>` (one top-level string argument of a tool call), or
        /// `attachments` (a tool result's attachments).
        field: String,
        /// A string, or for `attachments` the array of attachment ids to keep.
        value: Value,
        /// The part's checksum when the provider computed this edit.
        expect: String,
    },
    /// Render a message the transcript does not hold, such as the history
    /// summary at the start.
    Insert {
        at: InsertAt,
        message: InsertedMessage,
    },
    /// Leave out every message up to and including `through`: the messages a
    /// summary at the start replaces. One per view. Once a view with a cut
    /// applies, the runner may write its host's own compaction marker there,
    /// so the host stops loading those messages.
    Cut { through: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsertAt {
    /// Before the first rendered message.
    Start,
    /// Immediately before this message, whether or not the message itself
    /// is dropped.
    Before(String),
}

/// A message a view adds. Its parts are text only and carry no tag numbers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InsertedMessage {
    /// Chosen by the provider, unique within the view, and kept the same
    /// across views while the message is unchanged.
    pub id: String,
    pub role: Role,
    pub texts: Vec<String>,
}

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
    /// the tag prefix ([`crate::part::tag_prefix`]) then the stored text, or
    /// a view's replaced bytes as they are. `None` for other parts and for a
    /// tool still running.
    pub fn wire_text(&self, part: &Part) -> Option<String> {
        let text = match &part.body {
            PartBody::Text { text } => text,
            PartBody::Tool(tool) => match crate::part::empty_result_label(tool) {
                Some(label) if !self.final_text.contains(&part.id) => {
                    let prefix = part.tag.map(crate::part::tag_prefix).unwrap_or_default();
                    return Some(format!("{prefix}{label}"));
                }
                _ => tool.output.as_ref()?,
            },
            PartBody::Reasoning { .. } | PartBody::File(_) | PartBody::Opaque(_) => return None,
        };
        match part.tag {
            Some(tag) if !self.final_text.contains(&part.id) => {
                Some(format!("{}{text}", crate::part::tag_prefix(tag)))
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

/// Why a runner refuses a view. The runner keeps applying its previous view
/// and reports the refusal on its next notice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ViewRefusal {
    BadChecksum,
    /// The view's version is not newer than the runner's latest view.
    StaleVersion {
        version: u64,
        latest: u64,
    },
    /// An edit's `since` is not consistent with the previous view.
    BadSince,
    UnknownMessage {
        mid: String,
    },
    UnknownPart {
        mid: String,
        part: String,
    },
    /// The part changed since the provider computed the edit.
    StalePart {
        mid: String,
        part: String,
    },
    /// The field does not exist on that part, or the value has the wrong shape.
    BadField {
        mid: String,
        part: String,
        field: String,
    },
    /// Two edits target the same part in ways that cannot both hold, such as
    /// a drop and a replace, or two replaces of one field.
    Conflict {
        mid: String,
        part: String,
    },
    /// A tool call still running cannot be dropped or edited.
    RunningTool {
        mid: String,
        part: String,
    },
    UnknownAnchor {
        mid: String,
    },
    DuplicateInsert {
        id: String,
    },
    /// More than one cut.
    DuplicateCut,
    /// An inserted message's text contains a tag prefix.
    TaggedInsert {
        id: String,
    },
    /// A replace value contains a tag prefix for a number other than the
    /// part's own that the field's original text does not already contain.
    ForeignTag {
        mid: String,
        part: String,
        field: String,
        tag: u64,
    },
    /// The view breaks a provider rule the runner declared.
    Rule(crate::rules::RuleBreak),
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
    /// Whether the runner renders the prefix ([`crate::part::tag_prefix`]) in
    /// front of the part's text, or its tool result. False for a part with no
    /// number and for text a replace wrote, which is final.
    pub prefix: bool,
    /// For a finished tool result with no text: what the runner renders after
    /// the prefix ([`crate::part::empty_result_label`]).
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
                    crate::part::empty_result_label(tool).map(str::to_owned)
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

/// The largest view, as serialized JSON, a provider may hand over. Views name
/// edits, never copies of held content, so a real one stays far below this
/// (the largest seen, a 9,000-message session's first view, was about 400 KB).
/// It leaves room under a module call's 4 MiB frame for the request around it.
/// A provider refuses by name to send a larger view: one would be a bug in
/// the provider, not something to page.
pub const MAX_VIEW_BYTES: usize = 3 << 20;

/// `session.apply_view`, served by the runner: the provider hands over a new
/// view. The runner checks it ([`apply`], [`check_carried`],
/// [`crate::rules::check`]), stores it, and applies it from the next step
/// boundary, never in the middle of a step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplyViewRequest {
    pub view: View,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum ApplyViewAnswer {
    /// Stored; it applies from the next step boundary.
    Accepted,
    /// Not stored; the runner keeps its current view.
    Refused { refusal: ViewRefusal },
}

/// `session.applied_view`, served by the runner: the view it applies now, for
/// a provider whose own copy is missing or older (for example after its store
/// was restored from a backup).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AppliedViewRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppliedViewAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<View>,
}
