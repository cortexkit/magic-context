//! Small helpers over the contract's neutral part model.
//!
//! The contract's sets of kinds, roles, seals and statuses may grow in later
//! versions. ck-mc keeps a value it doesn't know and handles it on the safe
//! side (CONTRACT.md W1.5): an unknown part kind, or any part of an entry whose
//! role is unknown, is handled as an opaque part that is carried unchanged;
//! an unknown tool status counts as running.

use cortexkit_role_compaction::part::{Part, PartBody, Seal, ToolStatus};
use cortexkit_role_compaction::read::{Entry, HostPart, Role};

/// The single decision for the host's omission fact, independent of any
/// view. An unnumbered part can still be carried, for example system text.
pub(crate) fn carries_part(part: &Part) -> bool {
    !part.omitted
}

pub(crate) fn all_parts(entry: &Entry) -> std::slice::Iter<'_, Part> {
    entry.parts.iter()
}

pub(crate) fn carried_parts(entry: &Entry) -> impl DoubleEndedIterator<Item = &Part> {
    all_parts(entry).filter(|part| carries_part(part))
}

pub(crate) fn has_carried_parts(entry: &Entry) -> bool {
    carried_parts(entry).next().is_some()
}

/// A row whose parts are all left out is absent from the request. A row
/// with no parts at all is different: a runner opens one when a model step
/// starts, so it is in the request and still counts as one step, for
/// example when old reasoning is cleared by step age.
pub(crate) fn is_absent_from_request(entry: &Entry) -> bool {
    omitted_only(entry, || has_carried_parts(entry))
}

fn omitted_only(entry: &Entry, has_carried_parts: impl FnOnce() -> bool) -> bool {
    !entry.parts.is_empty() && !has_carried_parts()
}

pub(crate) fn first_request_entry(entries: &[Entry]) -> Option<&Entry> {
    entries.iter().find(|entry| !is_absent_from_request(entry))
}

pub(crate) fn last_request_entry(entries: &[Entry]) -> Option<&Entry> {
    entries.iter().rfind(|entry| !is_absent_from_request(entry))
}

/// Runner-authored content is still on the wire, but is not a speaker's words.
pub(crate) fn host_part<'a>(entry: &'a Entry, part: &Part) -> Option<&'a HostPart> {
    entry.host_parts.iter().find(|fact| fact.part == part.id)
}

/// The stored part id and the person's words for each verified wrapper.
pub(crate) fn verified_host_frames(entry: &Entry) -> impl Iterator<Item = (&str, &str)> {
    let frames = entry.host_frames();
    let frames = if frames.is_empty() || entry.check_host_frames().is_ok() {
        frames
    } else {
        &[]
    };
    frames
        .iter()
        .filter_map(|fact| fact.words(entry).map(|words| (fact.part.as_str(), words)))
}

pub(crate) fn has_verified_host_frames(entry: &Entry) -> bool {
    verified_host_frames(entry).next().is_some()
}

pub(crate) fn carried_host_frames(entry: &Entry) -> impl Iterator<Item = (&str, &str)> {
    verified_host_frames(entry).filter(|(id, _)| carried_parts(entry).any(|part| part.id == *id))
}

pub(crate) fn has_carried_host_frames(entry: &Entry) -> bool {
    carried_host_frames(entry).next().is_some()
}

/// Parts eligible for attribution to the entry's user or assistant speaker.
pub(crate) fn authored_parts(entry: &Entry) -> impl Iterator<Item = &Part> {
    all_parts(entry).filter(|part| host_part(entry, part).is_none())
}

pub(crate) fn carried_authored_parts(entry: &Entry) -> impl Iterator<Item = &Part> {
    carried_parts(entry).filter(|part| host_part(entry, part).is_none())
}

/// Runners can prefix tool names with `mcp_`; the prefix is case-insensitive.
pub(crate) fn without_tool_prefix(name: &str) -> &str {
    match name.get(..4) {
        Some(prefix) if prefix.eq_ignore_ascii_case("mcp_") => &name[4..],
        _ => name,
    }
}

/// The runner marks notices carrying the person's own words. They stay
/// verbatim until a summary covers them, rather than being reclaimed as notices.
pub(crate) fn is_kept_notice(entry: &Entry) -> bool {
    entry.notice.as_ref().is_some_and(|notice| notice.keep)
}

pub(crate) fn protects_from_automatic_reclaim(entry: &Entry) -> bool {
    is_kept_notice(entry) || has_carried_host_frames(entry)
}

pub(crate) fn protects_from_explicit_drop(entry: &Entry) -> bool {
    is_kept_notice(entry) && !has_carried_host_frames(entry)
}

pub(crate) fn is_unkept_notice(entry: &Entry) -> bool {
    entry.notice.as_ref().is_some_and(|notice| !notice.keep)
}

pub(crate) fn is_host_only(entry: &Entry) -> bool {
    has_carried_parts(entry) && carried_authored_parts(entry).next().is_none()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_omitted_only_row_is_absent_but_a_genuinely_empty_row_is_not() {
        let empty = Entry::new(1, "empty", Role::Assistant, 0, vec![]);
        let nonempty = Entry::new(
            2,
            "nonempty",
            Role::Assistant,
            0,
            vec![Part::new("part", PartBody::Text { text: "a".into() })],
        );
        assert!(!omitted_only(&empty, || false));
        assert!(!omitted_only(&nonempty, || true));
        assert!(omitted_only(&nonempty, || false));
    }
}
