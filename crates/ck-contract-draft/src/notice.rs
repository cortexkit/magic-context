//! `compaction.notice`, served by the provider. After every durable write to
//! a session's transcript, the runner sends where the transcript stands, plus
//! the new entries in compact form. The provider acknowledges at once and does
//! its work afterwards, so the runner never waits on it.
//!
//! A notice is a convenience, not the source of truth: the provider keeps its
//! own position and reads any gap with `session.read`. So a notice that never
//! arrives (the provider was down, a call failed) only delays its work until
//! the next notice or Setup.

use serde::{Deserialize, Serialize};

use crate::read::{Cursor, Entry, SessionRef};
use crate::rules::ProviderRules;
use crate::setup::ModelRef;
use crate::view::{AppliedView, ViewRefusal};

/// Above roughly this many bytes of entries, a notice carries none and the
/// provider reads them instead, keeping every call far below the transport's
/// frame limit. With compact parts that only happens for a huge tool input,
/// such as a `write` of a large file.
pub const ENTRIES_BUDGET_BYTES: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoticeRequest {
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
    /// Entries written since the previous notice, oldest first, in compact
    /// form. Only the newest message can change after it was sent (a running
    /// tool gets its result), and it is then sent again at the same ordinal.
    /// Empty when they would exceed [`ENTRIES_BUDGET_BYTES`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<Entry>,
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
    /// Entries from this ordinal on may differ from what the provider saw
    /// before: a revert, a branch switch, or a host that changed stored
    /// messages. The provider re-reads from there; edits naming messages that
    /// are gone leave its next view. Until that view arrives, the runner
    /// renders with the edits that still apply
    /// ([`crate::view::edits_for_transcript`]).
    TranscriptChanged { from_ordinal: u64 },
    /// The runner wrote the host's own compaction marker for this view, so the
    /// host stops loading the messages the view leaves out at the start.
    MarkerWritten { version: u64 },
    /// A view the runner refused when it came to apply it: a ride's answer,
    /// or an accepted view that no longer fits the transcript at the next step
    /// boundary. Otherwise a view handed over with `session.apply_view` is
    /// refused in that call's answer.
    ViewRefused { version: u64, refusal: ViewRefusal },
}

/// The provider's answer: it has the notice, which says nothing about the
/// work the notice causes; or it does not know the session (it restarted),
/// and the runner calls Setup again before its next notice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum NoticeAnswer {
    Received,
    SetupRequired,
}
