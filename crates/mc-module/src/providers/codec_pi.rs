//! Pi provider ingress shares the journal codec with full native transforms.
use super::*;

pub fn decode_messages(
    messages: &[codec::InboundMessage],
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    decode_messages_from(messages, messages.first().map_or(0, |m| m.ordinal))
}

pub fn decode_messages_from(
    messages: &[codec::InboundMessage],
    source_from: u64,
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    let ordinals = messages
        .iter()
        .map(|m| m.ordinal.saturating_sub(source_from).saturating_add(1))
        .collect::<Vec<_>>();
    decode_messages_with_ordinals(messages, &ordinals)
}

/// Origins are one-based positions in the original message sequence, not indexes
/// within the selected view or historian suffix. Keep them explicit so both kinds of
/// selection retain the same fallback tool IDs and sidecar bytes.
pub fn decode_messages_with_ordinals(
    messages: &[codec::InboundMessage],
    ordinals: &[u64],
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    for message in messages {
        if message.message.get("id").and_then(Value::as_str) != Some(message.mid.as_str())
            || cortexkit_role_llm_runner::serializer_profile::top_level_part_count(
                "pi",
                &message.message,
            )
            .is_err()
        {
            return Err(error(
                "history_unreadable",
                "Pi provider requires stable served entries",
            ));
        }
    }
    let native: Vec<_> = messages.iter().map(|m| m.message.clone()).collect();
    // Provider IDs are journal IDs. Timestamp/response aliases used by full
    // native transforms must not replace the relay's already-frozen identity.
    let mut pins = crate::codec::DecodeSidecar::new("pi");
    for message in messages {
        pins.mid_pins
            .insert(message.mid.clone(), message.mid.clone());
    }
    let mut decoded =
        crate::codec::pi::decode_pi_with_sidecar_and_ordinals(&native, Some(&pins), ordinals);
    if decoded.messages.len() != messages.len() {
        return Err(error(
            "history_unreadable",
            "Pi entry did not decode to one message",
        ));
    }
    for (decoded, source) in decoded.messages.iter_mut().zip(messages) {
        decoded.mid = source.mid.clone();
        decoded.ordinal = source.ordinal;
        decoded.ck.meta.harness_id = Some(source.mid.clone());
        decoded.ck.meta.ordinal = Some(source.ordinal);
    }
    Ok(decoded)
}

pub fn encode_view(
    view: &transform::compaction::View,
    request: &TransformRequest,
) -> Result<codec::OutboundMessage, HandlerOutcome> {
    let native = request
        .native_messages
        .as_deref()
        .ok_or_else(|| error("history_unreadable", "Pi view requires native ingress"))?;
    let source = native
        .iter()
        .zip(&request.messages)
        .map(|(message, ingress)| codec::InboundMessage {
            mid: ingress.mid.clone(),
            ordinal: ingress.ordinal,
            message: message.clone(),
        })
        .collect::<Vec<_>>();
    let sidecar = decode_messages_from(&source, view.range.from)?.sidecar;
    validate_synthesized_edits(&view.replacement, &sidecar)?;
    Ok(codec::OutboundMessage::new(
        &view.compaction_id,
        view.version,
        codec::MessageRange::new(view.range.from, view.range.to),
        crate::codec::encode_pi(&view.replacement, &sidecar),
    ))
}

fn validate_synthesized_edits(
    messages: &[ck_wire::CkWireMessage],
    sidecar: &crate::codec::DecodeSidecar,
) -> Result<(), HandlerOutcome> {
    for (index, message) in messages.iter().enumerate() {
        let Some(meta) = crate::codec::sidecar::meta_for_ck(sidecar, message, index) else {
            continue;
        };
        if !crate::codec::pi::is_synthesized(&meta.raw) || crate::codec::pi::whole_row_drop(message)
        {
            continue;
        }
        if message.content.len() != meta.blocks.len()
            || !message
                .content
                .iter()
                .zip(&meta.blocks)
                .all(|(block, meta)| crate::codec::sidecar::block_is_unchanged(block, meta))
        {
            let reason = format!(
                "pi_synthesized_edit_unsupported: {} permits only whole-row drops",
                meta.mid
            );
            eprintln!("mc-module: refusing Pi view: {reason}");
            return Err(error("pi_synthesized_edit_unsupported", reason));
        }
    }
    Ok(())
}

/// Pi stores tool results separately from their assistant's calls. Read the
/// actual preceding assistant and intervening results (at most 64 prior rows)
/// so tool-pair validation never invents a missing call.
pub fn decode_hook_messages(
    store: &McStore,
    key: &Key,
    lineage: &str,
    entry: codec::InboundMessage,
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    let mut entries = Vec::new();
    if entry
        .message
        .pointer("/message/role")
        .and_then(Value::as_str)
        == Some("toolResult")
    {
        let prior = store
            .load_provider_messages_page(
                &key.store_key(),
                lineage,
                entry.ordinal.saturating_sub(64),
                entry.ordinal.saturating_sub(1),
                64,
            )
            .map_err(transient)?;
        for source in prior {
            let message: Value =
                serde_json::from_slice(&source.message_bytes).map_err(transient)?;
            if message.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                entries.clear();
            }
            entries.push(codec::InboundMessage {
                mid: source.mid,
                ordinal: source.ordinal,
                message,
            });
        }
    }
    entries.push(entry);
    decode_messages(&entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served_entry(body: Value) -> codec::InboundMessage {
        codec::InboundMessage {
            mid: "row".into(),
            ordinal: 19,
            message: body,
        }
    }

    fn assert_served_row(body: Value, count: usize, role: &str) {
        let entry = served_entry(body);
        let decoded = codec::Codec::Pi.decode_message(&entry).unwrap();
        assert_eq!(
            (
                decoded.mid.as_str(),
                decoded.ordinal,
                decoded.ck.role.as_str()
            ),
            ("row", 19, role)
        );
        assert_eq!(
            cortexkit_role_llm_runner::serializer_profile::top_level_part_count(
                "pi",
                &entry.message
            )
            .unwrap(),
            count
        );
        assert_eq!(decoded.ck.content.len(), count);
    }

    #[test]
    fn served_pi_shell_runs_are_tool_output_with_projected_parts() {
        assert_served_row(
            json!({"type":"message","id":"row","message":{
                "role":"bashExecution","command":"printf hi","output":"hi","exitCode":0,
                "images":[{"type":"image","data":"AA==","mimeType":"image/png"}]
            }}),
            2,
            "tool",
        );
        assert_served_row(
            json!({"type":"message","id":"row","message":{
                "role":"bashExecution","command":"printf hidden","output":"hidden","excludeFromContext":true
            }}),
            0,
            "tool",
        );
    }

    #[test]
    fn served_pi_extension_messages_are_not_person_turns() {
        assert_served_row(
            json!({"type":"custom_message","id":"row","content":[
                {"type":"text","text":"extension notice"},{"type":"text","text":"another notice"}
            ]}),
            2,
            "notice",
        );
        assert_served_row(
            json!({"type":"custom_message","id":"row","content":[]}),
            0,
            "notice",
        );
    }

    #[test]
    fn served_pi_branch_summaries_read_summary_not_content() {
        assert_served_row(
            json!({"type":"branch_summary","id":"row","summary":"earlier branch"}),
            1,
            "notice",
        );
        assert_served_row(
            json!({"type":"branch_summary","id":"row","summary":""}),
            0,
            "notice",
        );
    }

    #[test]
    fn removed_pi_tool_results_keep_their_zero_part_message_number() {
        let body = json!({"type":"message","id":"row","message":{
            "role":"toolResult","toolCallId":"call","toolName":"read","content":[]
        }});
        assert_served_row(body.clone(), 0, "tool");
        let entry = served_entry(body.clone());
        assert_eq!(
            render_edited(&entry, |_| {}).unwrap().replacement,
            vec![body]
        );
    }

    fn render_edited(
        entry: &codec::InboundMessage,
        edit: impl FnOnce(&mut ck_wire::CkWireMessage),
    ) -> Result<codec::OutboundMessage, HandlerOutcome> {
        let mut message = codec::Codec::Pi.decode_message(entry).unwrap().ck;
        edit(&mut message);
        codec::Codec::Pi.render_view(
            &transform::compaction::View {
                compaction_id: "edit".into(),
                version: 1,
                range: transform::compaction::Range {
                    lineage_id: "L".into(),
                    from: 19,
                    to: 20,
                },
                replacement: vec![message],
            },
            "s",
            std::slice::from_ref(entry),
        )
    }

    #[test]
    fn synthesized_pi_rows_drop_whole_and_refuse_partial_edits() {
        for body in [
            json!({"type":"message","id":"row","message":{"role":"bashExecution","command":"ls","output":"output"}}),
            json!({"type":"branch_summary","id":"row","summary":"branch history"}),
        ] {
            let entry = served_entry(body.clone());
            assert_eq!(
                render_edited(&entry, |_| {}).unwrap().replacement,
                vec![body]
            );
            assert!(render_edited(&entry, |m| m.content.clear())
                .unwrap()
                .replacement
                .is_empty());
            assert!(
                render_edited(&entry, |m| m.content[0].kind = ck_wire::CkKind::Text {
                    text: "[dropped §5§]".into()
                })
                .unwrap()
                .replacement
                .is_empty()
            );
            for text in ["partial rewrite", "§5§ tagged prefix"] {
                let error = render_edited(&entry, |m| {
                    m.content[0].kind = ck_wire::CkKind::Text { text: text.into() }
                })
                .unwrap_err();
                assert!(format!("{error:?}").contains("pi_synthesized_edit_unsupported"));
            }
            let error = render_edited(&entry, |m| {
                m.meta.harness_id = None;
                m.content[0].kind = ck_wire::CkKind::Text {
                    text: "partial without an id".into(),
                };
            })
            .unwrap_err();
            assert!(format!("{error:?}").contains("pi_synthesized_edit_unsupported"));
        }
    }

    #[test]
    fn custom_pi_part_edits_and_removals_preserve_the_served_shape() {
        let entry = served_entry(
            json!({"type":"custom_message","id":"row","customType":"extension","display":true,"content":[
                {"type":"text","text":"first","extra":"keep-first"},
                {"type":"text","text":"second","extra":"keep-second"}
            ]}),
        );
        let edited = render_edited(&entry, |m| {
            m.content.remove(0);
            m.content[0].kind = ck_wire::CkKind::Text {
                text: "placeholder".into(),
            };
        })
        .unwrap();
        assert_eq!(
            edited.replacement,
            vec![
                json!({"type":"custom_message","id":"row","customType":"extension","display":true,"content":[
                    {"type":"text","text":"placeholder","extra":"keep-second"}
                ]})
            ]
        );
        let removed = render_edited(&entry, |m| m.content.clear()).unwrap();
        assert_eq!(
            removed.replacement[0],
            cortexkit_role_llm_runner::serializer_profile::pi_served_body(
                &entry.message,
                cortexkit_role_llm_runner::serializer_profile::PiEdit::Removed
            )
            .unwrap()
        );
    }

    #[test]
    fn suffix_decode_preserves_full_bytes_and_fallback_tool_ids() {
        let messages = (0..5)
            .map(|n| codec::InboundMessage {
                ordinal: n,
                mid: format!("m{n}"),
                message: json!({
                    "type":"message", "id":format!("m{n}"), "timestamp":"2026-01-01T00:00:00Z",
                    "message":{"role":"assistant","content":[
                        {"type":"toolCall","name":"read","arguments":{"path":format!("file{n}")}}
                    ]}
                }),
            })
            .collect::<Vec<_>>();
        let full = decode_messages(&messages).unwrap();
        let suffix = decode_messages_with_ordinals(&messages[3..], &[4, 5]).unwrap();
        assert_eq!(
            serde_json::to_vec(&suffix.messages).unwrap(),
            serde_json::to_vec(&full.messages[3..]).unwrap()
        );
        for message in &suffix.messages {
            assert_eq!(
                serde_json::to_vec(suffix.sidecar.message_by_mid(&message.mid).unwrap()).unwrap(),
                serde_json::to_vec(full.sidecar.message_by_mid(&message.mid).unwrap()).unwrap()
            );
            assert!(
                matches!(&message.ck.content[0].kind, ck_wire::CkKind::ToolCall { id, .. } if !id.is_empty())
            );
        }
        assert_ne!(
            suffix.messages,
            decode_messages(&messages[3..]).unwrap().messages,
            "the fixture must exercise position-dependent fallback IDs"
        );
    }

    #[test]
    fn journal_identity_beats_repeated_timestamp_and_response_aliases() {
        let entries: Vec<_> = ["entry-a", "entry-b"].into_iter().enumerate().map(|(i, id)| codec::InboundMessage {
            mid: id.into(), ordinal: 41 + i as u64,
            message: json!({"id":id,"type":"message","parentId":null,"message":{"role":"assistant","timestamp":1,"responseId":"same-response","content":[{"type":"text","text":id,"textSignature":"sig"}]}}),
        }).collect();
        let decoded = decode_messages(&entries).unwrap();
        for (actual, expected) in decoded.messages.iter().zip(&entries) {
            assert_eq!(actual.mid, expected.mid);
            assert_eq!(actual.ordinal, expected.ordinal);
            assert_eq!(
                decoded.sidecar.messages[&expected.mid].raw,
                expected.message
            );
        }
        let ck: Vec<_> = decoded.messages.into_iter().map(|m| m.ck).collect();
        assert_eq!(
            crate::codec::encode_pi(&ck, &decoded.sidecar),
            entries.into_iter().map(|e| e.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn mismatched_or_missing_journal_identity_refuses() {
        for native in [
            json!({"id":"wrong","message":{"role":"user","content":"text"}}),
            json!({"role":"user","content":"text"}),
        ] {
            assert!(decode_messages(&[codec::InboundMessage {
                mid: "expected".into(),
                ordinal: 1,
                message: native
            }])
            .is_err());
        }
    }
}
