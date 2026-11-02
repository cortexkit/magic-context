//! Tag numbers: which parts take one, how runners count them, and how they
//! are written in front of a part's text.

use cortexkit_role_compaction::part::{AttachmentItem, PartBody, ToolPart};
use cortexkit_role_compaction::read::{Entry, Role};

/// What a runner renders in front of a numbered part's text (a text part's
/// text, a tool result's output): the number between section signs, then one
/// space, as in `§12§ `. Text in the neutral part model never carries it.
///
/// A model sees these numbers and starts its own reply with the next one, the
/// way a runner will number it. Its reply then reaches the next request with
/// exactly the bytes the model produced, which routes that continue from
/// earlier replies depend on (see [`crate::clean::clean_reply`]).
pub fn tag_prefix(tag: u64) -> String {
    format!("§{tag}§ ")
}

/// What a runner renders after the prefix for a finished tool result with no
/// text of its own (contract W4.7): `[image]` when every attachment is an
/// image, `[file]` otherwise. `None` for a result that has text, has no
/// attachments, or is still running.
pub fn empty_result_label(tool: &ToolPart) -> Option<&'static str> {
    if tool.output_bytes != Some(0) || tool.attachments.is_empty() {
        return None;
    }
    let all_images = tool.attachments.iter().all(
        |attachment| matches!(&attachment.item, AttachmentItem::File(file) if file.is_image()),
    );
    Some(if all_images { "[image]" } else { "[file]" })
}

/// Every tag notation written anywhere in `text` (a section sign, one or more
/// ASCII digits, a section sign), as its digits without leading zeros. The
/// notation is syntactic (W6.4): digits too many for a number still count.
/// The runner checks view bytes with it, so a summary or a replaced field
/// cannot show the model a number that would mislead its count.
pub fn tag_notation_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('§') {
        let after_open = &rest[start + '§'.len_utf8()..];
        let digits = after_open.bytes().take_while(u8::is_ascii_digit).count();
        match after_open[digits..].strip_prefix('§') {
            Some(after_close) if digits > 0 => {
                let number = after_open[..digits].trim_start_matches('0');
                found.push(if number.is_empty() { "0" } else { number }.to_owned());
                rest = after_close;
            }
            _ => rest = after_open,
        }
    }
    found
}

/// The tag numbers written in `text` ([`tag_notation_in`]) that fit a `u64`.
pub fn tag_numbers_in(text: &str) -> Vec<u64> {
    tag_notation_in(text)
        .iter()
        .filter_map(|number| number.parse().ok())
        .collect()
}

/// Whether a part takes a number: text parts of user, notice and assistant
/// entries, and tool parts the model provider did not run itself (the number
/// belongs to the result, whatever its format: text, JSON, error or denial
/// text, or attachments only). Reasoning, files, opaque items, the text of
/// system entries and provider-executed tool parts never take one: a
/// provider-run result is replayed by the host as it is and cannot carry a
/// prefix. Parts of a kind, or of an entry role, the runner does not know
/// are handled as opaque parts (W1.5) and take none either.
pub fn is_numbered(role: &Role, body: &PartBody) -> bool {
    if matches!(role, Role::Unknown(_)) {
        return false;
    }
    match body {
        PartBody::Text { .. } => *role != Role::System,
        PartBody::Tool(tool) => !tool.provider_executed,
        _ => false,
    }
}

/// Number the parts of `entries` as a runner does (contract T1): the
/// checkpoint of the session's latest compaction marker, plus each numbered
/// part's position ([`is_numbered`]) among the numbered parts of the entries
/// after the marker's cut, counting from 1. Parts that take no number get
/// none. `entries` are the entries after the cut, in transcript order. Each
/// entry's checksum is computed again, since it covers its parts' numbers
/// (W7).
pub fn assign_tags(checkpoint: u64, entries: &mut [Entry]) {
    let mut next = checkpoint;
    for entry in entries.iter_mut() {
        let role = entry.role.clone();
        for part in &mut entry.parts {
            part.tag = if is_numbered(&role, &part.body) {
                next += 1;
                Some(next)
            } else {
                None
            };
        }
        entry.digest = cortexkit_role_compaction::read::entry_digest(
            entry.role.clone(),
            entry.notice.as_ref(),
            &entry.parts,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::part::{Attachment, FileMedia, Part, ToolStatus};
    use serde_json::json;

    fn tool(output: &str) -> PartBody {
        PartBody::Tool(
            ToolPart::new(
                "call_1",
                "read",
                json!({"path": "a.rs"}),
                ToolStatus::Completed,
            )
            .with_output(output)
            .with_output_bytes(output.len() as u64),
        )
    }

    #[test]
    fn a_tool_result_with_only_attachments_renders_a_label() {
        let mut body = tool("");
        let PartBody::Tool(tool) = &mut body else {
            unreachable!()
        };
        assert_eq!(empty_result_label(tool), None);
        tool.attachments.push(Attachment::new(
            "a1",
            AttachmentItem::File(FileMedia::inline("image/png", None)),
        ));
        assert_eq!(empty_result_label(tool), Some("[image]"));
        tool.attachments.push(Attachment::new(
            "a2",
            AttachmentItem::File(FileMedia::inline("application/pdf", None)),
        ));
        assert_eq!(empty_result_label(tool), Some("[file]"));
        tool.output_bytes = Some(4);
        assert_eq!(empty_result_label(tool), None);
    }

    #[test]
    fn tag_numbers_are_found_anywhere_in_a_text() {
        assert_eq!(tag_numbers_in("[dropped §12§]"), vec![12]);
        assert_eq!(
            tag_numbers_in("§3§ then §40§ and §§ and §7 open"),
            vec![3, 40]
        );
        assert_eq!(tag_numbers_in("§§9§"), vec![9]);
        assert!(tag_numbers_in("no numbers § here").is_empty());
        // The notation is syntactic: too many digits for a number still count.
        assert_eq!(
            tag_notation_in("§18446744073709551616§ and §007§"),
            ["18446744073709551616", "7"]
        );
        assert!(tag_numbers_in("§18446744073709551616§").is_empty());
    }

    #[test]
    fn provider_executed_tools_files_and_system_text_take_no_number() {
        use Role;
        let text = PartBody::Text { text: "x".into() };
        assert!(is_numbered(&Role::User, &text));
        assert!(is_numbered(&Role::Assistant, &text));
        assert!(!is_numbered(&Role::System, &text));
        let mut hosted = tool("result");
        if let PartBody::Tool(tool) = &mut hosted {
            tool.provider_executed = true;
        }
        assert!(is_numbered(&Role::Assistant, &tool("result")));
        assert!(!is_numbered(&Role::Assistant, &hosted));
        assert!(!is_numbered(
            &Role::User,
            &PartBody::File(FileMedia::inline("image/png", None))
        ));
    }

    #[test]
    fn numbers_count_from_the_checkpoint_over_numbered_parts_only() {
        let part = |id: &str, body: PartBody| Part::new(id, body);
        let text = || PartBody::Text { text: "x".into() };
        let entry = |ordinal: u64, role: Role, parts: Vec<Part>| {
            Entry::new(ordinal, format!("m{ordinal}"), role, 0, parts)
        };
        let mut entries = vec![
            entry(4, Role::User, vec![part("a", text())]),
            entry(
                5,
                Role::Assistant,
                vec![
                    part(
                        "r",
                        PartBody::Reasoning {
                            text: None,
                            text_bytes: Some(10),
                        },
                    ),
                    part("b", text()),
                    part("c", tool("ok")),
                ],
            ),
            entry(6, Role::System, vec![part("s", text())]),
            entry(7, Role::User, vec![part("d", text())]),
        ];
        assign_tags(41, &mut entries);
        let tags: Vec<Option<u64>> = entries
            .iter()
            .flat_map(|entry| entry.parts.iter().map(|part| part.tag))
            .collect();
        assert_eq!(tags, [Some(42), None, Some(43), Some(44), None, Some(45)]);
    }
}
