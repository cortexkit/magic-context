//! `session.entries`, served by the runner: transcript entries in the neutral
//! part model, plus where the transcript and the applied view stand.
//!
//! An entry is every record of the host's transcript, on the active path,
//! that the model sees or that holds part of what it sees, in host order.
//! Marker records are never entries. A record whose content belongs to
//! another entry (a Pi `toolResult`, a tool-role message holding a batch's
//! results) is an entry with no parts: its result sits in the call's tool
//! part. So is a step that died before any content. Which storage records
//! that means on each host is the contract's table W4.2.

use serde::{Deserialize, Serialize};

use crate::part::Part;
use crate::view::AppliedView;

/// Names a session: the key each side keeps it under. It is built from the
/// route a call arrives on, never from a request body, which the caller could
/// forge. `runner` is the module the daemon attests for the route, and
/// `harness` and `session` are the identity the route is bound to. Every op of
/// this contract concerns the session its route is bound to, so no request
/// names a session. `harness` and `session` stay the same when a session moves
/// from a standalone host to a runner.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionRef {
    /// The runner module serving the session, for example `thalamus-harness`.
    pub runner: String,
    /// The host the session lives in, for example `opencode` or `pi`.
    pub harness: String,
    /// The host's own session id.
    pub session: String,
}

/// One message of the transcript, as stored. Views never change entries;
/// they change what the runner renders from them. The parts come in full or
/// compact form ([`Detail`]); the checksums are always computed over the full
/// content.
///
/// Kinds allowed by role: user entries (notices included) hold text and
/// files; assistant entries hold text, reasoning, tool, file and opaque
/// parts; system entries hold text only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// Position on the session's active path, counting from 1 at its first
    /// entry. Every entry counts, including the ones a cut leaves out. After a
    /// revert or a branch switch, a new entry takes the ordinal of the removed
    /// one; the runner's notice says so.
    pub ordinal: u64,
    /// The host's message id. Stable for the life of the message. Nothing may
    /// derive it from the ordinal or the reverse.
    pub mid: String,
    pub role: Role,
    /// Set when a user-role entry was delivered by a module or the runner
    /// (a reminder, a wake, a notice) rather than typed or prompted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<NoticeOrigin>,
    /// When the host first stored the message, in milliseconds since the Unix
    /// epoch. It does not change when the entry is updated. For a message the
    /// runner did not store itself (history from before the runner, a moved
    /// session), the host's own write time.
    pub written_at: u64,
    /// Checksum of the entry's role, notice origin and parts, with the parts
    /// in full form ([`entry_digest`]).
    pub digest: String,
    pub parts: Vec<Part>,
    /// For an assistant entry: what the request that produced it reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
    /// For an assistant entry: the view applied to the request that produced
    /// it. Signed reasoning is bound to the history as rendered under that
    /// view, so the view library's rule check compares against it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_under: Option<AppliedView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    /// A turn-scoped system entry (llm-runner's `turn_system` delivery).
    System,
}

/// Who delivered a notice entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeOrigin {
    /// The module that sent it, for example `magic-context` or `prefrontal`.
    pub sender: String,
    /// The template it was rendered from, when it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

/// Token counts the model provider reported for one request, attached to the
/// assistant entry it produced. The runner fills these per provider so they
/// mean the same everywhere.
///
/// Every count is optional: absent means the provider did not report it,
/// never zero. A runner whose host stores 0 for "not reported" leaves the
/// count out unless it knows the 0 was reported, and always leaves out a
/// `prompt_tokens` of 0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepUsage {
    /// The whole prompt: uncached input plus cache reads plus cache writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// Reply tokens, reasoning included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Reasoning tokens within `output_tokens`. The reasoning budget depends
    /// on it: encrypted reasoning has no other measure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

/// Where an entry sits: enough to tell whether a later read continues from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub ordinal: u64,
    pub mid: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadRequest {
    pub select: Select,
    pub detail: Detail,
    /// Stop adding entries once the page reaches this many bytes. The page
    /// always holds at least one entry when one matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

/// How much of each part a read returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Detail {
    /// Parts in compact form ([`crate::part::Part::compact`]): enough to keep
    /// an index and plan edits. Used to catch up after a missed notice.
    Compact,
    /// Parts in full, for the summarizer and for showing a message again.
    Full,
}

/// Which entries to read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Select {
    /// Entries after an ordinal, oldest first; from the start when absent.
    After {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_ordinal: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u64>,
    },
    /// Exactly these messages, in transcript order. Missing ids are left out.
    Mids { mids: Vec<String> },
    /// The messages holding these tag numbers, in transcript order.
    Tags { tags: Vec<u64> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadPage {
    pub entries: Vec<Entry>,
    /// For [`Select::After`]: the ordinal to continue after when more entries
    /// match than fit the page. Absent when the page reaches the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after: Option<u64>,
    pub head: Head,
}

/// Where the session stands at the moment of the read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Head {
    /// The newest entry, absent for an empty transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest: Option<Cursor>,
    /// The view the runner applies now, absent when it applies none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_view: Option<AppliedView>,
}

/// Checksum of an entry's role, notice origin and parts, as [`Entry::digest`]
/// carries it.
pub fn entry_digest(role: Role, notice: Option<&NoticeOrigin>, parts: &[Part]) -> String {
    #[derive(Serialize)]
    struct Digested<'a> {
        role: Role,
        notice: Option<&'a NoticeOrigin>,
        parts: &'a [Part],
    }
    crate::digest::checksum(&Digested {
        role,
        notice,
        parts,
    })
}
