//! Exact, one-shot recognition of accepted reminder sends in runner transcripts.
use super::*;
use crate::runner_reminders::{DeliveryLedger, SentReminder};

const EXTRAS: &str = "mc-async-origin";

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct ReminderEchoes {
    blocks: Vec<Echo>,
    #[serde(default)]
    awaiting_resync: Vec<Echo>,
    #[serde(skip)]
    preparation_epoch: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Echo {
    ordinal: u64,
    mid: String,
    digest: String,
    part: usize,
    /// JSON pointer to the tool-result content-block array within this transcript part.
    container: Option<String>,
    index: Option<usize>,
    /// Only standalone user text has a CK text-block index.
    ck_index: Option<usize>,
    sent: SentReminder,
    frozen: bool,
}

pub(crate) fn origin(message: &ck_wire::CkWireMessage, index: usize) -> (bool, bool) {
    let Some(origin) = message.provider_extras.get(EXTRAS) else {
        return (false, false);
    };
    let delivered = origin
        .get("delivered")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_u64() == Some(index as u64)));
    (true, delivered)
}

pub(crate) fn accounting(message: &ck_wire::CkWireMessage, index: usize) -> Option<&str> {
    message
        .provider_extras
        .get(EXTRAS)?
        .get("accounting")?
        .get(index.to_string())?
        .as_str()
}

impl ReminderEchoes {
    pub(super) fn truncate(&mut self, through: Option<u64>) {
        self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
        if let Some(through) = through {
            self.blocks.retain(|echo| echo.ordinal <= through);
        } else {
            self.awaiting_resync.append(&mut self.blocks);
        }
    }

    /// Forget the echoes below `first`, whose rows a cut removed.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn truncate_below(&mut self, first: u64) {
        self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
        self.blocks.retain(|echo| echo.ordinal >= first);
        self.awaiting_resync.retain(|echo| echo.ordinal >= first);
    }

    pub(super) fn finish_resync(&mut self) {
        if !self.awaiting_resync.is_empty() {
            self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
        }
        self.awaiting_resync.clear();
    }

    pub(super) fn preparation_epoch(&self) -> u64 {
        self.preparation_epoch
    }

    pub(super) fn retained_bytes(&self) -> usize {
        self.blocks
            .iter()
            .chain(&self.awaiting_resync)
            .map(|echo| {
                std::mem::size_of::<Echo>()
                    + echo.mid.len()
                    + echo.digest.len()
                    + echo.sent.text.len()
                    + echo.sent.kind.len()
                    + echo.container.as_ref().map_or(0, String::len)
            })
            .sum()
    }

    pub(super) fn ingest(
        &mut self,
        entry: &ReadMessage,
        codec: codec::Codec,
        ledger: &mut DeliveryLedger,
        now: u64,
    ) -> Result<(), HandlerOutcome> {
        ledger.expire(now);
        let digest = served_digest(entry)?;
        let mut restored = false;
        self.awaiting_resync.retain_mut(|echo| {
            if echo.mid == entry.mid && echo.digest == digest {
                echo.ordinal = entry.ordinal;
                self.blocks.push(echo.clone());
                restored = true;
                false
            } else {
                true
            }
        });
        if restored {
            self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
            return Ok(());
        }
        if ledger.is_empty() {
            return Ok(());
        }
        // Most entries contain no echo. Inspect their already-read JSON before
        // paying for another codec decode, even while a send is still pending.
        if !possible_echo(&entry.message, ledger) {
            return Ok(());
        }
        let decoded = decoded_entry(
            codec,
            &InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            },
        )?;
        let tool_message = entry.message.get("role").and_then(Value::as_str) == Some("tool")
            || entry
                .message
                .pointer("/message/role")
                .and_then(Value::as_str)
                == Some("toolResult");
        let mut used = BTreeSet::new();
        for (part, value) in parts(&entry.message)?.iter().enumerate() {
            let text = value.as_str().or_else(|| {
                (value["type"] == "text")
                    .then(|| value["text"].as_str())
                    .flatten()
            });
            if let Some(text) = text.filter(|_| decoded.ck.role == "user" || tool_message) {
                if let Some(sent) = ledger.recognize(text, now, entry.written_at) {
                    let ck_index = (!tool_message)
                        .then(|| {
                            decoded.ck.content.iter().enumerate().find_map(|(index, block)| {
                            (matches!(&block.kind, ck_wire::CkKind::Text { text: t } if t == text)
                                && !used.contains(&index)).then_some(index)
                        })
                        })
                        .flatten();
                    if let Some(index) = ck_index {
                        used.insert(index);
                    }
                    self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
                    self.blocks.push(Echo {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        digest: digest.clone(),
                        part,
                        container: None,
                        index: None,
                        ck_index,
                        sent,
                        frozen: false,
                    });
                }
            }
            // Only explicit text blocks in a tool-result content array qualify.
            // A scalar tool output with an appended suffix has no safe boundary.
            if matches!(value["type"].as_str(), Some("tool_result" | "tool")) {
                for container in [
                    "/content",
                    "/output/value",
                    "/output/blocks",
                    "/state/output",
                ] {
                    let Some(blocks) = value.pointer(container).and_then(Value::as_array) else {
                        continue;
                    };
                    for (index, block) in blocks.iter().enumerate() {
                        let Some(text) = (block["type"] == "text")
                            .then(|| block["text"].as_str())
                            .flatten()
                        else {
                            continue;
                        };
                        if let Some(sent) = ledger.recognize(text, now, entry.written_at) {
                            self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
                            self.blocks.push(Echo {
                                ordinal: entry.ordinal,
                                mid: entry.mid.clone(),
                                digest: digest.clone(),
                                part,
                                container: Some(container.into()),
                                index: Some(index),
                                ck_index: None,
                                sent,
                                frozen: false,
                            });
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn annotate(&self, message: &mut ck_wire::CkIngressMessage) {
        let delivered: Vec<_> = self
            .blocks
            .iter()
            .filter(|echo| echo.ordinal == message.ordinal && echo.mid == message.mid)
            .filter_map(|echo| echo.ck_index)
            .collect();
        message.ck.provider_extras.insert(
            EXTRAS.into(),
            BTreeMap::from([("delivered".into(), json!(delivered))]),
        );
    }

    pub(super) fn authored(&self, message: &ck_wire::CkIngressMessage) -> bool {
        message.ck.role == "user" && message.ck.content.iter().enumerate().any(|(index, block)| {
            matches!(&block.kind, ck_wire::CkKind::Text { text } if !text.trim().is_empty())
                || matches!(block.kind, ck_wire::CkKind::Media(_) | ck_wire::CkKind::Opaque(_))
        } && !self.blocks.iter().any(|echo| echo.ordinal == message.ordinal
            && echo.mid == message.mid && echo.ck_index == Some(index)))
    }

    #[cfg(test)]
    pub(super) fn prepare(
        &self,
        codec: codec::Codec,
        request: &mut TransformRequest,
        entries: &[InboundMessage],
        historian: bool,
    ) -> Result<(), HandlerOutcome> {
        self.prepare_with(codec, request, entries, historian, |request, entries| {
            codec.prepare_request(request, entries)
        })
    }

    pub(super) fn prepare_with(
        &self,
        codec: codec::Codec,
        request: &mut TransformRequest,
        entries: &[InboundMessage],
        historian: bool,
        prepare: impl FnOnce(&mut TransformRequest, &[InboundMessage]) -> Result<(), HandlerOutcome>,
    ) -> Result<(), HandlerOutcome> {
        let entries_original = entries;
        let mut entries = entries.to_vec();
        {
            // User text is marked synthetic below, preserving block identities.
            // Nested tool-result reminders are removed without dropping the result.
            for entry in &mut entries {
                let echoes: Vec<_> = self
                    .blocks
                    .iter()
                    .filter(|echo| {
                        echo.ordinal == entry.ordinal
                            && echo.mid == entry.mid
                            && echo.ck_index.is_none()
                    })
                    .collect();
                if echoes.is_empty() {
                    continue;
                }
                let mut values = parts(&entry.message)?.into_owned();
                for part in (0..values.len()).rev() {
                    let selected: Vec<_> = echoes
                        .iter()
                        .copied()
                        .filter(|echo| echo.part == part)
                        .collect();
                    if selected.is_empty() {
                        continue;
                    }
                    match strip_part(values[part].clone(), &selected) {
                        Some(value) => values[part] = value,
                        None => {
                            values.remove(part);
                        }
                    }
                }
                let target = if entry.message.get("parts").is_some() {
                    "/parts"
                } else if entry.message.get("content").is_some() {
                    "/content"
                } else {
                    "/message/content"
                };
                *entry
                    .message
                    .pointer_mut(target)
                    .ok_or_else(|| transient("missing runner content"))? = json!(values);
            }
        }
        let sanitized = entries;
        prepare(
            request,
            if historian {
                &sanitized
            } else {
                entries_original
            },
        )?;
        for message in &mut request.messages {
            self.annotate(message);
            if !historian
                && self
                    .blocks
                    .iter()
                    .any(|echo| echo.ordinal == message.ordinal && echo.ck_index.is_none())
            {
                if let Some(entry) = sanitized
                    .iter()
                    .find(|entry| entry.ordinal == message.ordinal)
                {
                    let clean = decoded_entry(codec, entry)?;
                    let accounting: serde_json::Map<_, _> = clean
                        .ck
                        .content
                        .iter()
                        .enumerate()
                        .filter_map(|(index, block)| {
                            if let ck_wire::CkKind::ToolResult { output, .. } = &block.kind {
                                Some((
                                    index.to_string(),
                                    json!(crate::tail_hygiene::tool_output_content(&output.kind)),
                                ))
                            } else {
                                None
                            }
                        })
                        .collect();
                    message
                        .ck
                        .provider_extras
                        .get_mut(EXTRAS)
                        .expect("annotated")
                        .insert("accounting".into(), json!(accounting));
                }
            }
        }
        Ok(())
    }

    pub(super) fn pending(&self, ledger: &DeliveryLedger, now: u64) -> bool {
        self.blocks
            .iter()
            .any(|echo| echo.frozen || ledger.stale(&echo.sent, now))
    }

    /// Called only after the engine has granted a rebuild. No notice or clock
    /// observation alone advances the frozen strip set.
    ///
    /// A strip on a part with no edit yet is a new edit; a keep range that
    /// gains one is sorted again by part position (`tool_arcs::sort_edits`),
    /// because the contract rejects a message whose edits are out of part
    /// order (`edit_order`) and the new edit may belong before an existing one.
    pub(super) fn apply(
        &mut self,
        ledger: &DeliveryLedger,
        now: u64,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
        kept: &tool_arcs::KeptMessages,
        ranges: &mut [view::ViewRange],
    ) -> Result<(), HandlerOutcome> {
        self.preparation_epoch = self.preparation_epoch.wrapping_add(1);
        for range in ranges {
            let view::ViewRange::Keep { from, to, edits } = range else {
                continue;
            };
            let mut added = false;
            for (ordinal, entry) in entries.range(*from..*to) {
                if !self
                    .blocks
                    .iter()
                    .any(|echo| echo.ordinal == *ordinal && echo.mid == entry.mid)
                {
                    continue;
                }
                let entry = entry.read()?;
                let before = parts(&entry.message)?;
                for (index, row) in entry.tags.iter().enumerate() {
                    let selected: Vec<_> = self
                        .blocks
                        .iter_mut()
                        .filter(|echo| {
                            echo.ordinal == *ordinal && echo.mid == entry.mid && echo.part == index
                        })
                        .collect();
                    if selected.is_empty() {
                        continue;
                    }
                    let mut frozen = Vec::new();
                    for echo in selected {
                        if echo.frozen || ledger.stale(&echo.sent, now) {
                            echo.frozen = true;
                            frozen.push(&*echo);
                        }
                    }
                    if frozen.is_empty() {
                        continue;
                    }
                    // An earlier reduction may already have dropped the whole part.
                    let existing = edits
                        .iter()
                        .position(|edit| edit.ordinal == *ordinal && edit.part == row.part);
                    let source = match existing.map(|at| &edits[at]) {
                        Some(view::PartEdit { bytes: None, .. }) => continue,
                        Some(edit) => {
                            serde_json::from_str(edit.bytes.as_deref().expect("replacement"))
                                .map_err(transient)?
                        }
                        None => before[index].clone(),
                    };
                    let stripped = strip_part(source, &frozen);
                    let edit = match stripped {
                        Some(value) => view::PartEdit::replace(
                            *ordinal,
                            &entry.mid,
                            &row.part,
                            serde_json::to_string(&value).map_err(transient)?,
                        ),
                        None => view::PartEdit::drop(*ordinal, &entry.mid, &row.part),
                    };
                    if let Some(at) = existing {
                        edits[at] = edit;
                    } else {
                        edits.push(edit);
                        added = true;
                    }
                }
            }
            if added {
                tool_arcs::sort_edits(kept, edits);
            }
        }
        Ok(())
    }
}

fn strip_part(mut value: Value, echoes: &[&Echo]) -> Option<Value> {
    if echoes.iter().any(|echo| echo.container.is_none()) {
        return None;
    }
    // Reverse original indices so removing one block never shifts another target.
    let mut paths: Vec<_> = echoes
        .iter()
        .filter_map(|echo| {
            Some((
                echo.container.as_deref()?,
                echo.index?,
                echo.sent.text.as_str(),
            ))
        })
        .collect();
    paths.sort_by(|a, b| b.0.cmp(a.0).then(b.1.cmp(&a.1)));
    for (container, index, text) in paths {
        if let Some(blocks) = value.pointer_mut(container).and_then(Value::as_array_mut) {
            if blocks
                .get(index)
                .is_some_and(|block| block["type"] == "text" && block["text"] == text)
            {
                blocks.remove(index);
            }
        }
    }
    Some(value)
}

fn possible_echo(value: &Value, ledger: &DeliveryLedger) -> bool {
    match value {
        Value::String(text) => ledger.contains(text),
        Value::Array(values) => values.iter().any(|value| possible_echo(value, ledger)),
        Value::Object(values) => values.values().any(|value| possible_echo(value, ledger)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frozen whole-part echo on part "0" of a message whose part "2" the
    /// view already drops: the strip's new drop must come before the existing
    /// one, or the runner rejects the message's edits as out of part order.
    #[test]
    fn a_strip_on_an_earlier_part_than_an_existing_edit_keeps_part_order() {
        let entry = ReadMessage::new(
            0,
            "m0",
            json!({"role":"user","content":[
                {"type":"text","text":"reminder echo"},
                {"type":"text","text":"kept"},
                {"type":"text","text":"dropped"}
            ]}),
        )
        .with_tags(
            ["0", "1", "2"]
                .map(cortexkit_role_llm_runner::tags::PartTag::untagged)
                .to_vec(),
        );
        let entries = BTreeMap::from([(0, Arc::new(HeldEntry::from_read(&entry).unwrap()))]);
        let kept = BTreeMap::from([(
            0,
            tool_arcs::KeptMessage::new(codec::Codec::AnthropicMessages, &entry).unwrap(),
        )]);
        let sent: SentReminder = serde_json::from_value(json!({
            "text":"reminder echo","kind":"test","sent_at_ms":0,"expires_at_ms":0,"serial":1
        }))
        .unwrap();
        let mut echoes = ReminderEchoes {
            blocks: vec![Echo {
                ordinal: 0,
                mid: "m0".into(),
                digest: String::new(),
                part: 0,
                container: None,
                index: None,
                ck_index: None,
                sent,
                frozen: true,
            }],
            awaiting_resync: Vec::new(),
            preparation_epoch: 0,
        };
        let mut ranges = vec![view::ViewRange::keep_with_edits(
            0,
            1,
            vec![view::PartEdit::drop(0, "m0", "2")],
        )];
        echoes
            .apply(&DeliveryLedger::default(), 0, &entries, &kept, &mut ranges)
            .unwrap();
        assert_eq!(
            ranges,
            vec![view::ViewRange::keep_with_edits(
                0,
                1,
                vec![
                    view::PartEdit::drop(0, "m0", "0"),
                    view::PartEdit::drop(0, "m0", "2"),
                ]
            )]
        );
        // The contract's own part-order check, as the runner applies it.
        let view = view::CompactionView::new(
            "00000000000000000000000000000000",
            1,
            "L",
            compact::lineage::MessageRef {
                ordinal: 0,
                mid: "m0".into(),
            },
            ranges,
        );
        view.check().unwrap();
        assert_eq!(
            view.check_parts(|_| Some(vec!["0".into(), "1".into(), "2".into()])),
            Ok(())
        );
    }
}
