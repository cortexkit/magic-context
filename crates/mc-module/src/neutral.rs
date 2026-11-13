//! Small helpers over the contract's neutral part model.
//!
//! The contract's sets of kinds, roles, seals and statuses may grow in later
//! versions. ck-mc keeps a value it doesn't know and handles it on the safe
//! side (CONTRACT.md W1.5): an unknown part kind, or any part of an entry whose
//! role is unknown, is handled as an opaque part that is carried unchanged;
//! an unknown tool status counts as running.

use cortexkit_role_compaction::part::{Part, PartBody, Seal, ToolStatus};
use cortexkit_role_compaction::read::{Entry, HostPart, Role};

/// Runner-authored content is still on the wire, but is not a speaker's words.
pub(crate) fn host_part<'a>(entry: &'a Entry, part: &Part) -> Option<&'a HostPart> {
    entry.host_parts.iter().find(|fact| fact.part == part.id)
}

/// Parts eligible for attribution to the entry's user or assistant speaker.
pub(crate) fn authored_parts(entry: &Entry) -> impl Iterator<Item = &Part> {
    entry
        .parts
        .iter()
        .filter(|part| host_part(entry, part).is_none())
}

pub(crate) fn is_host_only(entry: &Entry) -> bool {
    !entry.parts.is_empty() && authored_parts(entry).next().is_none()
}

pub(crate) fn host_label(fact: &HostPart) -> String {
    fact.host_code.as_ref().map_or_else(
        || "[host text]".to_owned(),
        |code| format!("[host text: {code}]"),
    )
}

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

/// `text` with every tag notation (a section sign, digits, a section sign;
/// the view library's `tag_notation_in`) replaced by its digits.
pub fn without_tag_notation(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('§') {
        let after_open = &rest[start + '§'.len_utf8()..];
        let digits = after_open.bytes().take_while(u8::is_ascii_digit).count();
        match after_open[digits..].strip_prefix('§') {
            Some(after_close) if digits > 0 => {
                out.push_str(&rest[..start]);
                out.push_str(&after_open[..digits]);
                rest = after_close;
            }
            _ => {
                out.push_str(&rest[..start + '§'.len_utf8()]);
                rest = after_open;
            }
        }
    }
    out.push_str(rest);
    out
}
