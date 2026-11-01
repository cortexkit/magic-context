//! The advance notice: after every durable write to a session's transcript,
//! the runner publishes one on ck-bus. The bus carries identifiers and small
//! headers, never message content, so the notice only says where the
//! transcript stands; the provider then reads what is new with
//! `session.read`. A lost or repeated notice only delays a wake, because the
//! provider reads from its own position, not from the notice.

use serde::{Deserialize, Serialize};

use crate::read::{Cursor, SessionRef};
use crate::rules::ProviderRules;
use crate::setup::ModelRef;
use crate::view::{AppliedView, ViewRefusal};

/// The bus header that carries a notice, as canonical JSON.
pub const HEADER: &str = "ck-compaction-notice";

/// Largest header value a notice may take on the bus.
pub const MAX_HEADER_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdvanceNotice {
    pub session: SessionRef,
    /// Increases by one with every notice for the session, so the provider
    /// can tell a repeated or reordered notice apart.
    pub seq: u64,
    pub newest: Cursor,
    /// The view the runner applies now, absent when it applies none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_view: Option<AppliedView>,
    pub conditions: Conditions,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<Event>,
}

/// What the session runs under now. Notices and rides both carry it, so a
/// change reaches the provider with the next one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conditions {
    pub model: ModelRef,
    pub context_window: u64,
    pub output_reserve: u64,
    pub rules: ProviderRules,
    /// The prompt size of the newest request, as the provider reported it.
    /// Absent before the first request, or when the provider reported none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// Entries from this ordinal on may differ from what the provider read
    /// before: a revert, a branch switch, or a host that changed stored
    /// messages. The provider re-reads from there; edits naming messages that
    /// are gone are dropped from its next view.
    TranscriptChanged { from_ordinal: u64 },
    /// The runner refused this view and keeps applying its previous one.
    ViewRefused { version: u64, refusal: ViewRefusal },
    /// The runner wrote the host's own compaction marker for this view, so the
    /// host stops loading the messages the view leaves out at the start.
    MarkerWritten { version: u64 },
}

impl AdvanceNotice {
    /// The bus header value: the notice as canonical JSON. Fails when it would
    /// not fit the bus's header limit.
    pub fn to_header(&self) -> Result<String, NoticeTooLarge> {
        let value = serde_json::to_value(self).expect("a notice always serializes");
        let text = crate::digest::canonical_json(&value);
        if text.len() > MAX_HEADER_BYTES {
            return Err(NoticeTooLarge { bytes: text.len() });
        }
        Ok(text)
    }

    pub fn from_header(value: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoticeTooLarge {
    pub bytes: usize,
}
