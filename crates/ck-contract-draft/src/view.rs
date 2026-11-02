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

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::part::{Part, PartBody, ToolStatus};
use crate::read::{Entry, NoticeOrigin, Role, SessionRef};

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
            PartBody::Tool(tool) => tool.output.as_ref()?,
            PartBody::Reasoning { .. } | PartBody::Image(_) | PartBody::File(_) => return None,
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
    /// The view breaks a provider rule the runner declared.
    Rule(crate::rules::RuleBreak),
}

/// Apply a view to the transcript and return what the model sees.
///
/// Runners render with this function, and providers use it to know their own
/// view's effect, so both sides agree on the outcome. It checks the view's
/// shape; [`crate::rules::check`] checks the provider rules on top.
pub fn apply(entries: &[Entry], view: &View) -> Result<Vec<RenderedMessage>, ViewRefusal> {
    if !view.verify() {
        return Err(ViewRefusal::BadChecksum);
    }
    apply_edits(entries, &view.edits)
}

/// [`apply`] without the checksum check, for code that builds edits before
/// sealing them.
pub fn apply_edits(entries: &[Entry], edits: &[Edit]) -> Result<Vec<RenderedMessage>, ViewRefusal> {
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

    let mut rendered = Vec::with_capacity(entries.len() + inserts_at_start.len());
    rendered.extend(inserts_at_start.into_iter().map(render_inserted));
    for entry in entries {
        if let Some(before) = inserts_before.get(entry.mid.as_str()) {
            rendered.extend(before.iter().copied().map(render_inserted));
        }
        if dropped_messages.contains(entry.mid.as_str()) {
            continue;
        }
        let mut parts = Vec::with_capacity(entry.parts.len());
        let mut final_text = BTreeSet::new();
        for part in &entry.parts {
            if dropped_parts.contains(&(entry.mid.as_str(), part.id.as_str())) {
                continue;
            }
            match replaces.get(&(entry.mid.as_str(), part.id.as_str())) {
                Some(fields) => {
                    if fields
                        .iter()
                        .any(|(field, _)| matches!(*field, "text" | "output"))
                    {
                        final_text.insert(part.id.clone());
                    }
                    parts.push(replaced(part, fields));
                }
                None => parts.push(part.clone()),
            }
        }
        // A message left with no parts is not rendered at all.
        if parts.is_empty() {
            continue;
        }
        rendered.push(RenderedMessage {
            source: Source::Entry {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
            },
            role: entry.role,
            notice: entry.notice.clone(),
            parts,
            final_text,
        });
    }
    Ok(rendered)
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
    match (&part.body, field) {
        (PartBody::Text { .. }, "text") => value.as_str().map(|_| ()).ok_or_else(bad),
        // A finished call has an output size in both part forms.
        (PartBody::Tool(tool), "output") if tool.output_bytes.is_some() => {
            value.as_str().map(|_| ()).ok_or_else(bad)
        }
        (PartBody::Tool(tool), "attachments") => {
            let ids = value.as_array().ok_or_else(bad)?;
            let existing: HashSet<&str> = tool
                .attachments
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect();
            let mut seen = BTreeSet::new();
            for id in ids {
                let id = id.as_str().ok_or_else(bad)?;
                if !existing.contains(id) || !seen.insert(id) {
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

fn replaced(part: &Part, fields: &[(&str, &Value)]) -> Part {
    let mut body = part.body.clone();
    for (field, value) in fields {
        match (&mut body, *field) {
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
            (PartBody::Tool(tool), field) => {
                if let Some(key) = field.strip_prefix("input.") {
                    tool.input
                        .insert(key.to_owned(), Value::String(string_of(value)));
                }
            }
            _ => {}
        }
    }
    Part::new(part.id.clone(), part.tag, body)
}

fn string_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn render_inserted(message: &InsertedMessage) -> RenderedMessage {
    RenderedMessage {
        source: Source::Inserted {
            id: message.id.clone(),
        },
        role: message.role,
        notice: None,
        parts: message
            .texts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                Part::new(
                    format!("{}:{index}", message.id),
                    None,
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

/// A view sent inline, or named for a `view.get` fetch when it is too large
/// for one call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "form", rename_all = "snake_case")]
pub enum ViewDelivery {
    Inline { view: View },
    Fetch { version: u64, checksum: String },
}

/// `view.publish`, served by the runner: the provider hands over a new view.
/// The runner checks it ([`apply`], [`check_carried`],
/// [`crate::rules::check`]), stores it, and applies it from the next step
/// boundary, never in the middle of a step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewPublishRequest {
    pub session: SessionRef,
    pub delivery: ViewDelivery,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum ViewPublishAnswer {
    /// Stored; it applies from the next step boundary.
    Accepted,
    /// Not stored; the runner keeps its current view.
    Refused { refusal: ViewRefusal },
}

/// `view.get`, served by the provider: the fallback fetch for a view too
/// large to send inline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewGetRequest {
    pub session: SessionRef,
    pub version: u64,
}

/// `view.current`, served by the runner. The answer is the view it applies
/// now, or none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewCurrentRequest {
    pub session: SessionRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewCurrentAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<View>,
}
