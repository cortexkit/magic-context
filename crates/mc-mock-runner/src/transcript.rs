//! The runner's transcript: entries in full form, ordinals counted from 1,
//! and tag numbers counted from the compaction marker's checkpoint. A part's
//! number is the checkpoint plus its position among the numbered parts on the
//! transcript ([`is_numbered`]: text, and tool results the model provider did
//! not produce itself; never reasoning, files, opaque items or system text).
//! Numbers are contiguous: after a revert, counting continues from what
//! remains, so the model never sees a gap at the newest message it could
//! pattern-match into a jump. Only the runner counts; it hands each part's
//! number to the compaction provider in reads and notices.

use ck_contract_draft::part::{
    is_numbered, Attachment, Delivered, Part, PartBody, Seal, ToolStatus,
};
use ck_contract_draft::read::{
    entry_digest, Cursor, Detail, Entry, NoticeOrigin, Role, Select, StepUsage,
};
use ck_contract_draft::view::AppliedView;

#[derive(Clone, Debug)]
pub struct Transcript {
    entries: Vec<Entry>,
    /// The number before the first numbered part: the checkpoint the
    /// session's compaction marker carries.
    checkpoint: u64,
    /// Message ids come from the host and are never reused, revert or not.
    next_mid: u64,
}

impl Transcript {
    /// A new transcript counting from `checkpoint`, so its first number is
    /// `checkpoint + 1`. A session moved in from a host that ran Magic Context
    /// as its own plugin (OpenCode or Pi without a runner) gets that plugin's
    /// highest number as its checkpoint, so new numbers stay above every
    /// number its model has already seen.
    pub fn new(checkpoint: u64) -> Self {
        Self {
            entries: Vec::new(),
            checkpoint,
            next_mid: 1,
        }
    }

    /// The number the next numbered part gets.
    fn next_tag(&self) -> u64 {
        let numbered = self
            .entries
            .iter()
            .flat_map(|entry| &entry.parts)
            .filter(|part| part.tag.is_some())
            .count() as u64;
        self.checkpoint + numbered + 1
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn cursor(&self) -> Option<Cursor> {
        self.entries.last().map(|entry| Cursor {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            digest: entry.digest.clone(),
        })
    }

    /// Store a message. Numbered parts ([`is_numbered`]) get the next numbers
    /// in order.
    pub fn append(
        &mut self,
        role: Role,
        notice: Option<NoticeOrigin>,
        bodies: Vec<(Seal, PartBody)>,
        usage: Option<StepUsage>,
        generated_under: Option<AppliedView>,
        written_at: u64,
    ) -> &Entry {
        let mid = format!("msg{:05}", self.next_mid);
        self.next_mid += 1;
        let mut next_tag = self.next_tag();
        let parts: Vec<Part> = bodies
            .into_iter()
            .enumerate()
            .map(|(index, (seal, body))| {
                let tag = is_numbered(role, &body).then(|| {
                    next_tag += 1;
                    next_tag - 1
                });
                Part::new(format!("{mid}:p{index}"), tag, seal, body)
            })
            .collect();
        let entry = Entry {
            ordinal: self.entries.len() as u64 + 1,
            mid,
            role,
            digest: entry_digest(role, notice.as_ref(), &parts),
            notice,
            written_at,
            parts,
            usage,
            generated_under,
        };
        self.entries.push(entry);
        self.entries.last().expect("just pushed")
    }

    /// Store a text message without a tag number: a message from before a
    /// move, which the move's first view already cuts.
    pub fn append_unnumbered(&mut self, role: Role, text: &str, written_at: u64) -> &Entry {
        let mid = format!("msg{:05}", self.next_mid);
        self.next_mid += 1;
        let parts = vec![Part::new(
            format!("{mid}:p0"),
            None,
            Seal::None,
            PartBody::Text { text: text.into() },
        )];
        self.entries.push(Entry {
            ordinal: self.entries.len() as u64 + 1,
            mid,
            role,
            digest: entry_digest(role, None, &parts),
            notice: None,
            written_at,
            parts,
            usage: None,
            generated_under: None,
        });
        self.entries.last().expect("just pushed")
    }

    /// Record a tool's result on the newest message, the only one that may
    /// still change, with any text delivered after it.
    pub fn complete_tool(
        &mut self,
        call_id: &str,
        status: ToolStatus,
        output: String,
        attachments: Vec<Attachment>,
        delivered: Vec<Delivered>,
    ) -> Result<(), String> {
        let entry = self.entries.last_mut().ok_or("empty transcript")?;
        let part = entry
            .parts
            .iter_mut()
            .find(|part| matches!(&part.body, PartBody::Tool(tool) if tool.call_id == call_id))
            .ok_or_else(|| format!("no tool call {call_id} on the newest message"))?;
        let PartBody::Tool(mut tool) = part.body.clone() else {
            unreachable!("matched a tool part");
        };
        if tool.status != ToolStatus::Running {
            return Err(format!("tool call {call_id} already finished"));
        }
        tool.status = status;
        tool.output_bytes = Some(output.len() as u64);
        tool.output = Some(output);
        tool.attachments = attachments;
        tool.delivered = delivered;
        *part = Part::new(part.id.clone(), part.tag, part.seal, PartBody::Tool(tool));
        entry.digest = entry_digest(entry.role, entry.notice.as_ref(), &entry.parts);
        Ok(())
    }

    /// Remove every entry from `ordinal` on. Their numbers become free, and
    /// the next numbered part takes the first of them.
    pub fn revert_to(&mut self, ordinal: u64) {
        self.entries.truncate(ordinal.saturating_sub(1) as usize);
    }

    /// Serve a `session.entries` read: matching entries, and where to
    /// continue when they did not fit.
    pub fn read(
        &self,
        select: &Select,
        detail: Detail,
        max_bytes: Option<u64>,
    ) -> (Vec<Entry>, Option<u64>) {
        let candidates: Vec<&Entry> = match select {
            Select::After { after_ordinal, .. } => self
                .entries
                .iter()
                .filter(|entry| after_ordinal.is_none_or(|after| entry.ordinal > after))
                .collect(),
            Select::Mids { mids } => self
                .entries
                .iter()
                .filter(|entry| mids.contains(&entry.mid))
                .collect(),
            Select::Tags { tags } => self
                .entries
                .iter()
                .filter(|entry| {
                    entry
                        .parts
                        .iter()
                        .any(|part| part.tag.is_some_and(|tag| tags.contains(&tag)))
                })
                .collect(),
        };
        let limit = match select {
            Select::After { limit, .. } => limit.map(|limit| limit as usize),
            _ => None,
        };
        let mut page = Vec::new();
        let mut bytes = 0u64;
        for entry in &candidates {
            let shaped = match detail {
                Detail::Full => (*entry).clone(),
                Detail::Compact => Entry {
                    parts: entry.parts.iter().map(Part::compact).collect(),
                    ..(*entry).clone()
                },
            };
            let size = serde_json::to_vec(&shaped)
                .expect("entries serialize")
                .len() as u64;
            let full = limit.is_some_and(|limit| page.len() >= limit)
                || (!page.is_empty() && max_bytes.is_some_and(|max| bytes + size > max));
            if full {
                let next_after = match select {
                    Select::After { .. } => page.last().map(|last: &Entry| last.ordinal),
                    _ => None,
                };
                return (page, next_after);
            }
            bytes += size;
            page.push(shaped);
        }
        (page, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ck_contract_draft::part::{OutputFormat, ToolPart};
    use serde_json::json;

    fn text(value: &str) -> (Seal, PartBody) {
        (Seal::None, PartBody::Text { text: value.into() })
    }

    fn tool(call_id: &str) -> (Seal, PartBody) {
        (
            Seal::None,
            PartBody::Tool(ToolPart {
                call_id: call_id.into(),
                name: "read".into(),
                input: json!({"path": "a.rs"}),
                provider_executed: false,
                status: ToolStatus::Running,
                output: None,
                output_format: OutputFormat::Text,
                output_bytes: None,
                attachments: vec![],
                approval: None,
                delivered: vec![],
            }),
        )
    }

    #[test]
    fn numbers_count_from_the_checkpoint_and_continue_after_a_revert() {
        let mut transcript = Transcript::new(99);
        transcript.append(Role::User, None, vec![text("hi")], None, None, 1);
        let reasoning = (
            Seal::Signed,
            PartBody::Reasoning {
                text: Some("hmm".into()),
                text_bytes: Some(3),
            },
        );
        let entry = transcript.append(
            Role::Assistant,
            None,
            vec![reasoning, text("ok"), tool("c1")],
            None,
            None,
            2,
        );
        let tags: Vec<_> = entry.parts.iter().map(|part| part.tag).collect();
        assert_eq!(tags, [None, Some(101), Some(102)]);
        transcript.revert_to(2);
        let entry = transcript.append(Role::Assistant, None, vec![text("again")], None, None, 3);
        assert_eq!(entry.parts[0].tag, Some(101));
        assert_eq!(entry.ordinal, 2);
        assert_eq!(entry.mid, "msg00003");
    }

    #[test]
    fn a_tool_result_updates_the_newest_message_and_its_checksums() {
        let mut transcript = Transcript::new(0);
        transcript.append(Role::Assistant, None, vec![tool("c1")], None, None, 1);
        let before = transcript.entries()[0].clone();
        transcript
            .complete_tool(
                "c1",
                ToolStatus::Completed,
                "fn main() {}".into(),
                vec![],
                vec![],
            )
            .unwrap();
        let after = &transcript.entries()[0];
        assert_eq!(after.parts[0].tag, before.parts[0].tag);
        assert_ne!(after.parts[0].digest, before.parts[0].digest);
        assert_ne!(after.digest, before.digest);
        assert!(transcript
            .complete_tool("c1", ToolStatus::Completed, "again".into(), vec![], vec![])
            .is_err());
    }

    #[test]
    fn reads_page_by_size_and_compact_reads_drop_output_text() {
        let mut transcript = Transcript::new(0);
        for index in 0..5 {
            transcript.append(
                Role::User,
                None,
                vec![text(&"x".repeat(100))],
                None,
                None,
                index,
            );
        }
        let (page, next) = transcript.read(
            &Select::After {
                after_ordinal: None,
                limit: None,
            },
            Detail::Full,
            Some(700),
        );
        assert!(page.len() < 5 && !page.is_empty());
        assert_eq!(next, Some(page.last().unwrap().ordinal));

        transcript.append(Role::Assistant, None, vec![tool("c1")], None, None, 9);
        transcript
            .complete_tool(
                "c1",
                ToolStatus::Completed,
                "big output".into(),
                vec![],
                vec![],
            )
            .unwrap();
        let (page, _) = transcript.read(&Select::Tags { tags: vec![6] }, Detail::Compact, None);
        let PartBody::Tool(tool) = &page[0].parts[0].body else {
            panic!()
        };
        assert_eq!(
            (tool.output.as_deref(), tool.output_bytes),
            (None, Some(10))
        );
        assert_eq!(
            page[0].parts[0].digest,
            transcript.entries()[5].parts[0].digest
        );
    }
}
