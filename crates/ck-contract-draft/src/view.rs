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
//! rendered with its prefix.
//!
//! No edit changes a tag number: the runner counts from the transcript, not
//! from what it renders. The only way a view could mislead the model's count
//! is a number written into its own bytes, so a runner refuses an inserted
//! message that carries a tag prefix, and a replaced field that carries one
//! the part neither owns nor already contained.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::read::Role;

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
    /// edit gets the view's own version. The rule check uses it to tell
    /// which edits came after a signed reasoning part was generated, and
    /// a runner verifies it against its previous view.
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

/// The largest view, as serialized JSON, a provider may hand over. Views name
/// edits, never copies of held content, so a real one stays far below this
/// (the largest seen, a 9,000-message session's first view, was about 400 KB).
/// It leaves room under a module call's 4 MiB frame for the request around it.
/// A provider refuses by name to send a larger view: one would be a bug in
/// the provider, not something to page.
pub const MAX_VIEW_BYTES: usize = 3 << 20;

/// `session.apply_view`, served by the runner: the provider hands over a new
/// view. The runner checks it with the view library (its shape, its `since`
/// values and the provider rules), stores it, and applies it from the next step
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
