//! Small helpers over the contract's neutral part model.
//!
//! The contract's sets of kinds, roles, seals and statuses may grow in later
//! versions. ck-mc keeps a value it doesn't know and handles it on the safe
//! side (CONTRACT.md W1.5): an unknown part kind, or any part of an entry whose
//! role is unknown, is handled as an opaque part that is carried unchanged;
//! an unknown tool status counts as running.

use cortexkit_role_compaction::part::{Part, PartBody, Seal, ToolStatus};
use cortexkit_role_compaction::read::{Entry, Role};

/// A part with its number and seal, its checksum computed over both.
pub fn part(id: impl Into<String>, tag: Option<u64>, seal: Seal, body: PartBody) -> Part {
    let mut part = Part::new(id, body).with_seal(seal);
    part.tag = tag;
    part
}

/// Whether a tool call has its result. A status the contract may add later
/// counts as running, so no lane drops, replaces or cuts it.
pub fn is_finished(status: &ToolStatus) -> bool {
    matches!(
        status,
        ToolStatus::Completed | ToolStatus::Error | ToolStatus::Denied
    )
}

/// Whether ck-mc may edit this part beyond dropping it whole: its kind and
/// its entry's role are ones ck-mc knows.
pub fn is_known(entry: &Entry, part: &Part) -> bool {
    !matches!(entry.role, Role::Unknown(_)) && !matches!(part.body, PartBody::Unknown { .. })
}
