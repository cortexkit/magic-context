use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::ck_wire::{
    CkIngressMessage, CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta,
    MediaBlock, MediaKind, MessageOrigin, OpaqueBlock, ProviderExtras, ResultBlock,
    ResultBlockKind,
};
use crate::injection::SYNTHETIC_TIMESTAMP;

use super::common::{classify_tool_result_child, ToolResultChildAdapter};
use super::sidecar::{
    block_is_unchanged, decoded_block_fingerprint, is_synthetic_part, match_block_metas,
    meta_for_ck, stable_hash_prefix, stamp_block_identity, BlockMeta, DecodeSidecar,
    DecodedHarnessMessages, ExtractedBoundary, HarnessMessageMeta,
};

pub type MessageV2Json = Value;

const HARNESS: &str = "opencode";

pub fn decode_opencode(messages: &[MessageV2Json]) -> DecodedHarnessMessages {
    decode_opencode_with_sidecar_and_base(messages, None, 0)
}

pub fn decode_opencode_with_sidecar(
    messages: &[MessageV2Json],
    prior: Option<&DecodeSidecar>,
) -> DecodedHarnessMessages {
    decode_opencode_with_sidecar_and_base(messages, prior, 0)
}

/// Decode a wholly fresh OpenCode array in the absolute ordinal space inherited from a
/// completed lineage descent. Explicit absolute ordinals win; otherwise the positional
/// fallback starts after `provisional_base` instead of silently restarting at one.
pub fn decode_opencode_with_sidecar_and_base(
    messages: &[MessageV2Json],
    prior: Option<&DecodeSidecar>,
    provisional_base: u64,
) -> DecodedHarnessMessages {
    let mut sidecar = DecodeSidecar::new(HARNESS);
    if let Some(prior) = prior {
        sidecar.mid_pins = prior.mid_pins.clone();
    }

    let mut decoded = Vec::with_capacity(messages.len());
    let mut boundary = None;

    for (message_index, raw_message) in messages.iter().enumerate() {
        let info = raw_message.get("info").unwrap_or(raw_message);
        let explicit_ordinal = raw_message
            .get("absolute_ordinal")
            .and_then(Value::as_u64)
            .or_else(|| info.get("absolute_ordinal").and_then(Value::as_u64));
        let ordinal = explicit_ordinal.unwrap_or_else(|| {
            provisional_base
                .saturating_add(message_index as u64)
                .saturating_add(1)
        });
        let stable_key = string_field(info, "id")
            .or_else(|| string_field(raw_message, "id"))
            .unwrap_or_else(|| format!("opencode-hash-{}", stable_hash_prefix(raw_message, 24)));
        let mid = sidecar
            .inherit_pin(&stable_key)
            .unwrap_or_else(|| stable_key.clone());
        sidecar.pin_mid(stable_key.clone(), mid.clone());

        let role = string_field(info, "role")
            .or_else(|| string_field(raw_message, "role"))
            .unwrap_or_else(|| "user".to_string());
        let created_at_ms = opencode_message_time(info, "created")
            .or_else(|| integer_field(info, "time_created"))
            .or_else(|| integer_field(info, "timeCreated"));
        let completed_at_ms = opencode_message_time(info, "completed")
            .or_else(|| integer_field(info, "time_completed"))
            .or_else(|| integer_field(info, "timeCompleted"));
        let origin = opencode_origin(info).or_else(|| opencode_origin(raw_message));
        let parts = raw_message
            .get("parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut content = Vec::new();
        let mut block_metas = Vec::new();

        for (part_index, part) in parts.iter().enumerate() {
            let part_type = string_field(part, "type").unwrap_or_else(|| "unknown".to_string());
            match part_type.as_str() {
                "text" => {
                    if part
                        .get("ignored")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    let text = string_field(part, "text").unwrap_or_default();
                    let block =
                        block_with_metadata(CkKind::Text { text }, part.get("metadata").cloned());
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        "text",
                    );
                }
                "reasoning" => {
                    let text = string_field(part, "text")
                        .or_else(|| string_field(part, "thinking"))
                        .unwrap_or_default();
                    let metadata = part.get("metadata").cloned();
                    let kind = if text.is_empty() {
                        if let Some(data) = redacted_reasoning_data(part) {
                            CkKind::RedactedReasoning { data }
                        } else {
                            CkKind::Reasoning {
                                text,
                                signature: metadata.as_ref().and_then(find_signature),
                            }
                        }
                    } else {
                        CkKind::Reasoning {
                            text,
                            signature: metadata.as_ref().and_then(find_signature),
                        }
                    };
                    let block = block_with_metadata(kind, metadata);
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        "reasoning",
                    );
                }
                "tool" => {
                    decode_tool_part(ordinal, part_index, part, &mut content, &mut block_metas);
                }
                "file" | "image" => {
                    let media = media_from_part(part);
                    let block = CkWireBlock::bare(CkKind::Media(media));
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        "file",
                    );
                }
                "step-start" => {
                    let block = opaque_block("step-start", part.clone(), None);
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        "step-start",
                    );
                }
                "compaction" => {
                    boundary = Some(ExtractedBoundary {
                        harness: HARNESS.to_string(),
                        message_id: mid.clone(),
                        ordinal,
                        part_index: Some(part_index),
                        entry_id: None,
                        raw: part.clone(),
                    });
                }
                "subtask" => {
                    let block = opaque_block("subtask", part.clone(), None);
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        "subtask",
                    );
                }
                // OpenCode's model adapter treats step-finish as structural metadata. Keep it
                // only in the native sidecar, just as the TypeScript CK adapter does, so both
                // projections assign the same block indexes to authored text and tool parts.
                "step-finish" | "snapshot" | "patch" | "agent" | "retry" => {}
                _ => {
                    let block = opaque_block(&part_type, part.clone(), opaque_arc(part));
                    push_block(
                        &mut content,
                        &mut block_metas,
                        block,
                        part_index,
                        part,
                        &part_type,
                    );
                }
            }
        }

        let synthetic = is_synthetic_message(&parts);
        let ck = CkWireMessage::from_parts(
            role.clone(),
            content,
            origin,
            ProviderExtras::new(),
            HarnessMeta {
                harness_id: Some(mid.clone()),
                ordinal: Some(ordinal),
                synthetic,
                created_at_ms,
                completed_at_ms,
                ..Default::default()
            },
        );
        decoded.push(CkIngressMessage {
            mid: mid.clone(),
            ordinal,
            ck,
        });
        sidecar.remember_message(
            mid.clone(),
            HarnessMessageMeta {
                mid,
                ordinal,
                role,
                raw: raw_message.clone(),
                stable_key: Some(stable_key),
                blocks: block_metas,
            },
        );
    }

    DecodedHarnessMessages {
        messages: decoded,
        boundary,
        sidecar,
    }
}

pub(crate) fn decode_opencode_sidecar_incremental(
    messages: &[MessageV2Json],
    prior: &DecodeSidecar,
    replace_from: usize,
) -> DecodeSidecar {
    debug_assert!(replace_from <= messages.len());
    debug_assert!(replace_from <= prior.order.len());
    if replace_from == messages.len() && replace_from == prior.order.len() {
        return prior.clone();
    }

    let suffix = decode_opencode_with_sidecar_and_base(
        &messages[replace_from..],
        Some(prior),
        replace_from as u64,
    )
    .sidecar;
    let mut sidecar = DecodeSidecar::new(HARNESS);
    sidecar.mid_pins = suffix.mid_pins;
    for mid in prior.order.iter().take(replace_from) {
        sidecar.order.push(mid.clone());
        if let Some(meta) = prior.messages.get(mid) {
            sidecar.messages.insert(mid.clone(), Arc::clone(meta));
        }
    }
    for mid in suffix.order {
        let Some(meta) = suffix.messages.get(&mid) else {
            continue;
        };
        if !sidecar.order.contains(&mid) {
            sidecar.order.push(mid.clone());
        }
        sidecar.messages.insert(mid, Arc::clone(meta));
    }
    sidecar
}

pub fn encode_opencode(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    mutation_exempt_mid: Option<&str>,
) -> Vec<MessageV2Json> {
    match mutation_exempt_mid {
        Some(mid) => encode_opencode_impl(messages, sidecar, None, false, &[mid], true),
        None => encode_opencode_impl(messages, sidecar, None, false, &[], true),
    }
}

/// Encode CK messages back to OpenCode while optionally supplying the session id used by
/// newly-created synthetic user messages. Existing messages use their retained sidecar raw
/// value, so provider fields that CK does not model remain untouched. Native serving also
/// retains compaction parts because it promises a full-array replay of untouched ingress.
pub fn encode_opencode_with_session(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    mutation_exempt_mid: Option<&str>,
) -> Vec<MessageV2Json> {
    match mutation_exempt_mid {
        Some(mid) => encode_opencode_impl(messages, sidecar, session_id, true, &[mid], true),
        None => encode_opencode_impl(messages, sidecar, session_id, true, &[], true),
    }
}

pub fn encode_opencode_with_session_exemptions(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    mutation_exempt_mids: &[&str],
) -> Vec<MessageV2Json> {
    encode_opencode_impl(
        messages,
        sidecar,
        session_id,
        true,
        mutation_exempt_mids,
        true,
    )
}

#[cfg(test)]
pub(crate) fn encode_opencode_with_transition_state(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    mutation_exempt_mids: &[&str],
    transition_consumed: bool,
) -> Vec<MessageV2Json> {
    encode_opencode_with_transition_state_and_reasoning_exemption(
        messages,
        sidecar,
        session_id,
        mutation_exempt_mids,
        None,
        transition_consumed,
    )
}

#[derive(Clone, Copy)]
pub(crate) struct NativeEncodeExemptions<'a> {
    pub(crate) mutation_mids: &'a [&'a str],
    pub(crate) reasoning_mid: Option<&'a str>,
}

pub(crate) fn encode_opencode_with_transition_state_and_reasoning_exemption(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    mutation_exempt_mids: &[&str],
    reasoning_exempt_mid: Option<&str>,
    transition_consumed: bool,
) -> Vec<MessageV2Json> {
    let encoded = encode_opencode_chunks_with_transition_state(
        messages,
        sidecar,
        session_id,
        true,
        NativeEncodeExemptions {
            mutation_mids: mutation_exempt_mids,
            reasoning_mid: reasoning_exempt_mid,
        },
        transition_consumed,
        0,
    )
    .into_iter()
    .map(|chunk| chunk.value)
    .collect::<Vec<_>>();
    assert_unique_tool_use_ids(&encoded);
    encoded
}

#[derive(Debug, Clone)]
pub(crate) struct EncodedOpencodeChunk {
    pub(crate) start_index: usize,
    pub(crate) end_index: usize,
    pub(crate) value: MessageV2Json,
}

fn encode_opencode_impl(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    preserve_compaction: bool,
    mutation_exempt_mids: &[&str],
    transition_consumed: bool,
) -> Vec<MessageV2Json> {
    let encoded = encode_opencode_chunks_with_transition_state(
        messages,
        sidecar,
        session_id,
        preserve_compaction,
        NativeEncodeExemptions {
            mutation_mids: mutation_exempt_mids,
            reasoning_mid: None,
        },
        transition_consumed,
        0,
    )
    .into_iter()
    .map(|chunk| chunk.value)
    .collect::<Vec<_>>();
    assert_unique_tool_use_ids(&encoded);
    encoded
}

pub(crate) fn encode_opencode_chunks_with_transition_state(
    messages: &[CkWireMessage],
    sidecar: &DecodeSidecar,
    session_id: Option<&str>,
    preserve_compaction: bool,
    exemptions: NativeEncodeExemptions<'_>,
    _transition_consumed: bool,
    base_index: usize,
) -> Vec<EncodedOpencodeChunk> {
    let mut encoded = Vec::with_capacity(messages.len());
    let mut index = 0;
    while index < messages.len() {
        let absolute_index = base_index.saturating_add(index);
        if let Some(next) = messages.get(index + 1) {
            if let Some(part) = render_synthetic_todo_pair(&messages[index], next) {
                let info = synthetic_message_info(&messages[index], session_id);
                encoded.push(EncodedOpencodeChunk {
                    start_index: absolute_index,
                    end_index: absolute_index.saturating_add(2),
                    value: json!({
                        "info": info,
                        "parts": [part],
                    }),
                });
                index += 2;
                continue;
            }
            let call_is_fresh = meta_for_ck(sidecar, &messages[index], absolute_index).is_none();
            let result_is_fresh =
                meta_for_ck(sidecar, next, absolute_index.saturating_add(1)).is_none();
            if call_is_fresh && result_is_fresh {
                if let Some(part) = render_adjacent_tool_pair(&messages[index], next) {
                    let mut message = encode_new_message(&messages[index], session_id);
                    set_value(&mut message, "parts", Value::Array(vec![part]));
                    encoded.push(EncodedOpencodeChunk {
                        start_index: absolute_index,
                        end_index: absolute_index.saturating_add(2),
                        value: message,
                    });
                    index += 2;
                    continue;
                }
            }
        }
        let msg = &messages[index];
        // Decoded input messages retain their harness id, so metadata can be rebound by
        // identity. A positional synthetic fallback can instead attach an input nudge's
        // native envelope to a fresh module-authored m0/m1 message.
        let meta = meta_for_ck(sidecar, msg, absolute_index);
        let preserve_native_reasoning =
            meta.is_some_and(|meta| exemptions.reasoning_mid == Some(meta.mid.as_str()));
        let mut value = match meta {
            Some(meta) if exemptions.mutation_mids.contains(&meta.mid.as_str()) => meta.raw.clone(),
            Some(meta) => encode_with_meta(
                msg,
                meta,
                preserve_compaction,
                preserve_native_reasoning,
                exemptions.reasoning_mid.is_some(),
            ),
            None => encode_new_message(msg, session_id),
        };
        preserve_persisted_text_tool_order(&mut value, meta.map(|meta| &meta.raw));
        if preserve_native_reasoning {
            if let Some(meta) = meta {
                enforce_latest_assistant_native_reasoning(&mut value, &meta.raw);
            }
        }
        encoded.push(EncodedOpencodeChunk {
            start_index: absolute_index,
            end_index: absolute_index.saturating_add(1),
            value,
        });
        index += 1;
    }
    encoded
}

fn duplicate_tool_use_locations<'a>(
    messages: impl IntoIterator<Item = &'a MessageV2Json>,
) -> Vec<(String, usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    let mut duplicates = Vec::new();
    for (message_index, message) in messages.into_iter().enumerate() {
        let Some(parts) = message.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for (part_index, part) in parts.iter().enumerate() {
            if part.get("type").and_then(Value::as_str) != Some("tool") {
                continue;
            }
            let Some(call_id) = part.get("callID").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(call_id.to_string()) {
                duplicates.push((call_id.to_string(), message_index, part_index));
            }
        }
    }
    duplicates
}

pub(crate) fn assert_unique_tool_use_ids<'a>(
    messages: impl IntoIterator<Item = &'a MessageV2Json>,
) {
    let duplicates = duplicate_tool_use_locations(messages);
    debug_assert!(
        duplicates.is_empty(),
        "OpenCode serialization produced duplicate tool_use ids: {duplicates:?}"
    );
}

fn decode_tool_part(
    ordinal: u64,
    part_index: usize,
    part: &Value,
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
) {
    let tool_name = tool_name(part);
    let input = part
        .get("state")
        .and_then(|state| state.get("input"))
        .or_else(|| part.get("input"))
        .or_else(|| part.get("args"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let id = string_field(part, "callID")
        .or_else(|| string_field(part, "callId"))
        .or_else(|| string_field(part, "id"))
        .unwrap_or_else(|| synth_tool_id(ordinal, part_index, &tool_name, &input));
    let provider_executed = part
        .get("metadata")
        .and_then(|m| m.get("providerExecuted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let call_block = CkWireBlock::bare(CkKind::ToolCall {
        id: id.clone(),
        name: tool_name.clone(),
        input,
        provider_executed,
    });
    push_block(
        content,
        block_metas,
        call_block,
        part_index,
        part,
        "tool_call",
    );
    if let Some(last) = block_metas.last_mut() {
        last.native_id = Some(id.clone());
    }

    let status = tool_status(part);
    if matches!(status.as_deref(), Some("completed" | "error")) {
        let output_text = part
            .get("state")
            .and_then(|state| state.get("output").or_else(|| state.get("error")))
            .or_else(|| part.get("output").or_else(|| part.get("error")))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let output = tool_output_from_part(part, status.as_deref() == Some("error"), output_text);
        let result_block = CkWireBlock::bare(CkKind::ToolResult {
            id: id.clone(),
            tool_name,
            output,
            provider_executed,
        });
        push_block(
            content,
            block_metas,
            result_block,
            part_index,
            part,
            "tool_result",
        );
        if let Some(last) = block_metas.last_mut() {
            last.native_id = Some(id);
        }
    }
}

fn push_block(
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
    mut block: CkWireBlock,
    part_index: usize,
    raw: &Value,
    kind: &str,
) {
    let block_index = content.len();
    let content_fingerprint = decoded_block_fingerprint(&block);
    stamp_block_identity(&mut block, block_index, part_index, &content_fingerprint);
    content.push(block);
    block_metas.push(BlockMeta {
        block_index,
        kind: kind.to_string(),
        native_index: Some(part_index),
        native_id: string_field(raw, "id").or_else(|| string_field(raw, "callID")),
        item_id: None,
        content_fingerprint: Some(content_fingerprint),
        raw: raw.clone(),
    });
}

fn block_with_metadata(kind: CkKind, metadata: Option<Value>) -> CkWireBlock {
    if let Some(metadata) = metadata {
        let mut extras = ProviderExtras::new();
        let mut ns = BTreeMap::new();
        ns.insert("metadata".to_string(), metadata);
        extras.insert(HARNESS.to_string(), ns);
        CkWireBlock::with_provider_extras(kind, extras)
    } else {
        CkWireBlock::bare(kind)
    }
}

fn opencode_origin(value: &Value) -> Option<MessageOrigin> {
    let model = value.get("model").unwrap_or(value);
    let provider = string_field(model, "providerID")
        .or_else(|| string_field(model, "provider"))
        .or_else(|| string_field(value, "providerID"))
        .or_else(|| string_field(value, "provider"))?;
    let model_id = string_field(model, "modelID")
        .or_else(|| string_field(model, "model"))
        .or_else(|| string_field(value, "modelID"))
        .or_else(|| string_field(value, "model"))?;
    Some(MessageOrigin {
        api: provider.clone(),
        provider,
        model: model_id,
    })
}

fn media_from_part(part: &Value) -> MediaBlock {
    let media_type = string_field(part, "mime")
        .or_else(|| string_field(part, "mimeType"))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let filename = string_field(part, "filename").or_else(|| string_field(part, "name"));
    let source = media_source(part, &media_type);
    MediaBlock {
        kind: media_kind(&media_type),
        media_type,
        filename,
        source,
    }
}

fn media_source(part: &Value, media_type: &str) -> Value {
    if let Some(data) = string_field(part, "data") {
        return json!({ "type": "data_base64", "data": data });
    }
    if let Some(url) = string_field(part, "url") {
        let prefix = format!("data:{media_type};base64,");
        if let Some(data) = url.strip_prefix(&prefix) {
            return json!({ "type": "data_base64", "data": data });
        }
        return json!({ "type": "url", "url": url });
    }
    json!({ "type": "opaque", "raw": part })
}

fn media_kind(media_type: &str) -> MediaKind {
    if media_type.starts_with("image/") {
        MediaKind::Image
    } else if media_type.starts_with("audio/") {
        MediaKind::Audio
    } else if media_type.starts_with("video/") {
        MediaKind::Video
    } else if media_type == "application/pdf" {
        MediaKind::Document
    } else {
        MediaKind::File
    }
}

fn tool_output_from_part(part: &Value, is_error: bool, output_text: String) -> CkToolOutput {
    let attachments = part
        .get("state")
        .and_then(|state| state.get("attachments"))
        .or_else(|| part.get("attachments"))
        .and_then(Value::as_array);
    let Some(attachments) = attachments else {
        return if is_error {
            CkToolOutput::bare(CkOutputKind::ErrorText { text: output_text })
        } else {
            CkToolOutput::bare(CkOutputKind::Text { text: output_text })
        };
    };

    let mut blocks = Vec::new();
    if !output_text.is_empty() {
        blocks.push(ResultBlock {
            kind: ResultBlockKind::Text { text: output_text },
            provider_extras: ProviderExtras::new(),
        });
    }
    for attachment in attachments {
        let mut provider_extras = ProviderExtras::new();
        provider_extras
            .entry(HARNESS.to_string())
            .or_default()
            .insert("rawAttachment".to_string(), attachment.clone());
        blocks.push(ResultBlock {
            kind: classify_tool_result_child(attachment, ToolResultChildAdapter::OpenCode),
            provider_extras,
        });
    }
    CkToolOutput::bare(if is_error {
        CkOutputKind::ErrorContent { blocks }
    } else {
        CkOutputKind::Content { blocks }
    })
}

fn is_native_reasoning_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("reasoning" | "thinking" | "redacted_thinking")
    )
}

// Anthropic binds the latest assistant's thinking blocks to their native bytes and content-array
// positions. Its provider projection may regroup OpenCode part kinds, so even a suffix insertion
// can move thinking. Preserve the complete native part vector whenever signed reasoning is live.
fn enforce_latest_assistant_native_reasoning(message: &mut Value, persisted: &Value) {
    let Some(persisted_parts) = persisted.get("parts").and_then(Value::as_array) else {
        return;
    };
    if !persisted_parts.iter().any(is_native_reasoning_part)
        || message.get("parts").and_then(Value::as_array) == Some(persisted_parts)
    {
        return;
    }
    let Some(message) = message.as_object_mut() else {
        *message = persisted.clone();
        return;
    };
    message.insert("parts".to_string(), Value::Array(persisted_parts.clone()));
}

fn has_text_after_tool(parts: &[Value]) -> bool {
    let mut saw_tool = false;
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("tool") => saw_tool = true,
            Some("text") if saw_tool => return true,
            _ => {}
        }
    }
    false
}

// Anthropic rejects a live assistant whose text follows tool_use. OpenCode persists authored
// assistant text before its tool part, so encode-back may retain a post-tool order only when that
// exceptional order already existed in the native message rather than being created by fallback.
fn preserve_persisted_text_tool_order(message: &mut Value, persisted: Option<&Value>) {
    let info = message.get("info").unwrap_or(message);
    if info.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let persisted_parts = persisted
        .and_then(|message| message.get("parts"))
        .and_then(Value::as_array);
    if persisted_parts.is_some_and(|parts| has_text_after_tool(parts)) {
        return;
    }
    let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(first_tool) = parts
        .iter()
        .position(|part| part.get("type").and_then(Value::as_str) == Some("tool"))
    else {
        return;
    };
    let mut moved_text = Vec::new();
    let mut index = first_tool.saturating_add(1);
    while index < parts.len() {
        if parts[index].get("type").and_then(Value::as_str) == Some("text") {
            moved_text.push(parts.remove(index));
        } else {
            index += 1;
        }
    }
    parts.splice(first_tool..first_tool, moved_text);
    debug_assert!(!has_text_after_tool(parts));
}

fn encode_with_meta(
    msg: &CkWireMessage,
    meta: &HarnessMessageMeta,
    preserve_compaction: bool,
    preserve_native_reasoning: bool,
    clear_historical_reasoning: bool,
) -> Value {
    let mut raw = meta.raw.clone();
    let mut parts = raw
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matched_metas = match_block_metas(&msg.content, &meta.blocks, true, block_matches_meta);
    let matched_meta_block_indexes = matched_metas
        .by_block
        .iter()
        .flatten()
        .map(|meta| meta.block_index)
        .collect::<BTreeSet<_>>();
    let matched_native_indices = matched_metas
        .by_block
        .iter()
        .flatten()
        .filter_map(|meta| meta.native_index)
        .collect::<BTreeSet<_>>();
    // The newest replayable assistant must carry its provider-signed reasoning into a tool-use
    // continuation. Preserve the native carrier even when CK omitted it or could not align it.
    let native_reasoning_to_reattach = if preserve_native_reasoning {
        meta.blocks
            .iter()
            .filter(|meta| matches!(meta.kind.as_str(), "reasoning" | "redacted_reasoning"))
            .filter_map(|meta| {
                let native_index = meta.native_index?;
                (!matched_native_indices.contains(&native_index))
                    .then_some((meta.block_index, native_index))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut pending_parts = Vec::new();

    let mut block_index = 0;
    while block_index < msg.content.len() {
        let block = &msg.content[block_index];
        let block_meta = matched_metas.by_block[block_index];

        if let (
            CkKind::ToolCall { id, .. },
            Some(
                result @ CkWireBlock {
                    kind: CkKind::ToolResult { id: result_id, .. },
                    ..
                },
            ),
        ) = (&block.kind, msg.content.get(block_index + 1))
        {
            if id == result_id {
                let result_meta = matched_metas.by_block[block_index + 1];
                let call_native_index = block_meta.and_then(|meta| meta.native_index);
                let result_native_index = result_meta.and_then(|meta| meta.native_index);
                let shared_native_index = match (call_native_index, result_native_index) {
                    (Some(call), Some(result)) if call == result => Some(call),
                    (Some(call), None) => Some(call),
                    (None, Some(result)) => Some(result),
                    _ => None,
                };

                if let Some(part) = shared_native_index.and_then(|index| parts.get_mut(index)) {
                    for (arc_block, arc_meta) in [(block, block_meta), (result, result_meta)] {
                        if !arc_meta.is_some_and(|meta| block_is_unchanged(arc_block, meta)) {
                            update_part_from_block(part, arc_block);
                        }
                    }
                    block_index += 2;
                    continue;
                }
                if call_native_index.is_none() && result_native_index.is_none() {
                    // OpenCode stores a completed invocation as one part, while CK expands that
                    // part into adjacent call and result blocks. This provider-validity invariant
                    // cannot depend on whether an older renderer-transition marker was persisted:
                    // two independently emitted shells carry the same callID.
                    pending_parts.push((
                        block_index,
                        None,
                        render_tool_pair_as_part(block, result),
                    ));
                    block_index += 2;
                    continue;
                }
            }
        }

        if let Some(part_index) = block_meta.and_then(|block_meta| block_meta.native_index) {
            if let Some(part) = parts.get_mut(part_index) {
                if block_meta.is_some_and(|meta| block_is_unchanged(block, meta)) {
                    block_index += 1;
                    continue;
                }
                // Reasoning parts may contain provider signatures, so changing their bytes could
                // invalidate verification. Preserve the matched native reasoning part exactly;
                // apply updates only to separately mapped sibling parts.
                if !matches!(
                    &block.kind,
                    CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
                ) {
                    update_part_from_block(part, block);
                }
                block_index += 1;
                continue;
            }
        }
        let mut positional_candidates = meta.blocks.iter().filter(|candidate| {
            !matched_meta_block_indexes.contains(&candidate.block_index)
                && candidate
                    .native_index
                    .is_none_or(|index| !matched_native_indices.contains(&index))
                && block_matches_meta(block, candidate)
        });
        let positional_candidate = positional_candidates.next().filter(|_| {
            positional_candidates.next().is_none()
                && (!matches!(
                    &block.kind,
                    CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
                ) || preserve_native_reasoning)
        });
        if let Some(candidate) = positional_candidate {
            if let Some(native_index) = candidate.native_index {
                if let Some(source_part) = parts.get(native_index) {
                    let mut replacement = source_part.clone();
                    if !matches!(
                        &block.kind,
                        CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
                    ) {
                        update_part_from_block(&mut replacement, block);
                    }
                    pending_parts.push((block_index, Some(native_index), replacement));
                    block_index += 1;
                    continue;
                }
            }
        }

        let reasoning_reattaches_from_native = preserve_native_reasoning
            && matches!(
                &block.kind,
                CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
            )
            && !native_reasoning_to_reattach.is_empty();
        if !reasoning_reattaches_from_native {
            pending_parts.push((block_index, None, render_block_as_part(block)));
        }
        block_index += 1;
    }
    for (source_block_index, native_index) in native_reasoning_to_reattach {
        if let Some(part) = parts.get(native_index) {
            pending_parts.push((source_block_index, Some(native_index), part.clone()));
        }
    }
    pending_parts.sort_by_key(|(source_block_index, _, _)| *source_block_index);

    parts = matched_metas.remove_unretained_native_parts_with_insertions(parts, pending_parts);
    if !preserve_compaction {
        parts.retain(|part| part.get("type").and_then(Value::as_str) != Some("compaction"));
    }

    // Only the newest provider-visible assistant may replay signed reasoning beside changed
    // native parts. Historical mutations keep every non-reasoning part in its encoded order but
    // drop the native reasoning carriers before OpenCode projects the message onto provider wire.
    let native_parts_changed = meta.raw.get("parts").and_then(Value::as_array) != Some(&parts);
    if msg.role == "assistant"
        && native_parts_changed
        && clear_historical_reasoning
        && !preserve_native_reasoning
    {
        parts.retain(|part| !is_native_reasoning_part(part));
    }

    if let Some(obj) = raw.as_object_mut() {
        obj.insert("parts".to_string(), Value::Array(parts));
        let info = obj.entry("info").or_insert_with(|| json!({}));
        if let Some(info_obj) = info.as_object_mut() {
            info_obj
                .entry("id".to_string())
                .or_insert_with(|| Value::String(meta.mid.clone()));
            info_obj.insert("role".to_string(), Value::String(msg.role.clone()));
        }
    } else {
        raw = json!({
            "info": { "id": meta.mid, "role": msg.role },
            "parts": parts,
        });
    }
    if raw == meta.raw {
        meta.raw.clone()
    } else {
        raw
    }
}

fn block_matches_meta(block: &CkWireBlock, meta: &BlockMeta) -> bool {
    match &block.kind {
        CkKind::Text { text } => {
            meta.kind == "text"
                || (text.is_empty()
                    && matches!(meta.kind.as_str(), "reasoning" | "redacted_reasoning"))
        }
        CkKind::Reasoning { .. } => meta.kind == "reasoning",
        CkKind::RedactedReasoning { .. } => {
            matches!(meta.kind.as_str(), "reasoning" | "redacted_reasoning")
        }
        CkKind::ToolCall { id, .. } => {
            meta.kind == "tool_call" && meta.native_id.as_deref().is_none_or(|native| native == id)
        }
        CkKind::ToolResult { id, .. } => {
            meta.kind == "tool_result"
                && meta.native_id.as_deref().is_none_or(|native| native == id)
        }
        CkKind::Media(_) => meta.kind == "file",
        CkKind::Opaque(opaque) => meta.kind == opaque.kind,
    }
}

fn update_part_from_block(part: &mut Value, block: &CkWireBlock) {
    match &block.kind {
        CkKind::Text { text } => {
            set_string(part, "type", "text");
            set_string(part, "text", text);
            if let Some(metadata) = block
                .provider_extras
                .get(HARNESS)
                .and_then(|ns| ns.get("metadata"))
            {
                set_value(part, "metadata", metadata.clone());
            }
        }
        CkKind::Reasoning { text, signature } => {
            set_string(part, "type", "reasoning");
            set_string(part, "text", text);
            if part.get("metadata").is_none() {
                if let Some(signature) = signature {
                    set_value(part, "metadata", json!({ "signature": signature }));
                }
            }
        }
        CkKind::RedactedReasoning { data } => {
            set_string(part, "type", "reasoning");
            set_string(part, "text", "");
            if part.get("metadata").is_none() {
                set_value(part, "metadata", json!({ "redacted": data }));
            }
        }
        CkKind::ToolCall {
            id,
            name,
            input,
            provider_executed,
        } => {
            set_string(part, "type", "tool");
            set_string(part, "callID", id);
            set_string(part, "tool", name);
            set_nested_value(part, "state", "input", input.clone());
            if *provider_executed {
                set_nested_value(part, "metadata", "providerExecuted", Value::Bool(true));
            }
        }
        CkKind::ToolResult {
            id,
            tool_name,
            output,
            ..
        } => {
            set_string(part, "type", "tool");
            set_string(part, "callID", id);
            set_string(part, "tool", tool_name);
            apply_tool_output_to_part(part, output);
        }
        CkKind::Media(media) => {
            *part = render_media_part(media);
        }
        CkKind::Opaque(opaque) => {
            *part = opaque.raw.clone();
        }
    }
}

fn render_adjacent_tool_pair(call: &CkWireMessage, result: &CkWireMessage) -> Option<Value> {
    if call.role != "assistant" || result.role != "tool" {
        return None;
    }
    let [call_block] = call.content.as_slice() else {
        return None;
    };
    let [result_block] = result.content.as_slice() else {
        return None;
    };
    let CkKind::ToolCall { id: call_id, .. } = &call_block.kind else {
        return None;
    };
    let CkKind::ToolResult { id: result_id, .. } = &result_block.kind else {
        return None;
    };
    (call_id == result_id).then(|| render_tool_pair_as_part(call_block, result_block))
}

fn render_synthetic_todo_pair(call: &CkWireMessage, result: &CkWireMessage) -> Option<Value> {
    if !call.meta.synthetic
        || !result.meta.synthetic
        || call.role != "assistant"
        || result.role != "tool"
    {
        return None;
    }
    let CkKind::ToolCall { id, name, .. } = call.content.first()?.kind.clone() else {
        return None;
    };
    let CkKind::ToolResult {
        id: result_id,
        output,
        ..
    } = result.content.first()?.kind.clone()
    else {
        return None;
    };
    if id != result_id || !id.starts_with("mc_synthetic_todo_") {
        return None;
    }
    let CkOutputKind::Json { value } = output.kind else {
        return None;
    };
    Some(json!({
        "type": "tool",
        "callID": id,
        "tool": name,
        "state": value,
        "syntheticTodoMarker": true,
    }))
}

fn synthetic_message_info(msg: &CkWireMessage, session_id: Option<&str>) -> Value {
    let mut info = json!({ "role": msg.role });
    if let Some(session_id) = session_id {
        set_value(
            &mut info,
            "sessionID",
            Value::String(session_id.to_string()),
        );
    } else {
        let id =
            msg.meta.harness_id.clone().unwrap_or_else(|| {
                format!("opencode-ck-{}", stable_hash_prefix(&json!(msg.role), 12))
            });
        set_value(&mut info, "id", Value::String(id));
    }
    info
}

fn encode_new_message(msg: &CkWireMessage, session_id: Option<&str>) -> Value {
    let id = msg
        .meta
        .harness_id
        .clone()
        .unwrap_or_else(|| format!("opencode-ck-{}", stable_hash_prefix(&json!(msg.role), 12)));
    let mut parts = Vec::new();
    let mut index = 0;
    while index < msg.content.len() {
        let block = &msg.content[index];
        if let CkKind::ToolCall { id, .. } = &block.kind {
            if let Some(next) = msg.content.get(index + 1) {
                if matches!(&next.kind, CkKind::ToolResult { id: result_id, .. } if result_id == id)
                {
                    parts.push(render_tool_pair_as_part(block, next));
                    index += 2;
                    continue;
                }
            }
        }
        parts.push(render_block_as_part(block));
        index += 1;
    }
    if msg.meta.synthetic && msg.role == "user" {
        for part in &mut parts {
            set_value(part, "synthetic", Value::Bool(true));
        }
    }
    let info = if msg.meta.synthetic && msg.role == "user" {
        let mut info = json!({ "role": msg.role });
        if let Some(session_id) = session_id {
            set_value(
                &mut info,
                "sessionID",
                Value::String(session_id.to_string()),
            );
        } else {
            set_value(&mut info, "id", Value::String(id));
        }
        info
    } else {
        let role = if msg.role == "tool" {
            // MessageV2 model conversion only visits tool parts inside assistant messages.
            "assistant"
        } else {
            msg.role.as_str()
        };
        json!({ "id": id, "role": role })
    };
    json!({ "info": info, "parts": parts })
}

fn render_block_as_part(block: &CkWireBlock) -> Value {
    match &block.kind {
        CkKind::Text { text } => json!({ "type": "text", "text": text }),
        CkKind::Reasoning { text, signature } => {
            let mut part = json!({ "type": "reasoning", "text": text });
            if let Some(signature) = signature {
                set_value(&mut part, "metadata", json!({ "signature": signature }));
            }
            part
        }
        CkKind::RedactedReasoning { data } => {
            json!({ "type": "reasoning", "text": "", "metadata": { "redacted": data } })
        }
        CkKind::ToolCall {
            id,
            name,
            input,
            provider_executed,
        } => {
            let mut part = json!({
                "type": "tool",
                "callID": id,
                "tool": name,
                "state": {
                    "status": "running",
                    "input": input,
                    "time": synthetic_tool_time(),
                },
            });
            if *provider_executed {
                set_nested_value(&mut part, "metadata", "providerExecuted", Value::Bool(true));
            }
            part
        }
        CkKind::ToolResult {
            id,
            tool_name,
            output,
            ..
        } => {
            let mut part = json!({
                "type": "tool",
                "callID": id,
                "tool": tool_name,
                "state": {
                    "input": {},
                    "time": synthetic_tool_time(),
                }
            });
            apply_tool_output_to_part(&mut part, output);
            part
        }
        CkKind::Media(media) => render_media_part(media),
        CkKind::Opaque(opaque) => opaque.raw.clone(),
    }
}

fn render_tool_pair_as_part(call: &CkWireBlock, result: &CkWireBlock) -> Value {
    let mut part = render_block_as_part(call);
    let CkKind::ToolResult { output, .. } = &result.kind else {
        update_part_from_block(&mut part, result);
        return part;
    };

    apply_tool_output_to_part(&mut part, output);
    set_nested_value(&mut part, "state", "time", synthetic_tool_time());
    part
}

fn synthetic_tool_time() -> Value {
    json!({
        "start": SYNTHETIC_TIMESTAMP,
        "end": SYNTHETIC_TIMESTAMP,
    })
}

fn render_media_part(media: &MediaBlock) -> Value {
    let mut part = json!({
        "type": "file",
        "mime": media.media_type,
    });
    if let Some(filename) = &media.filename {
        set_string(&mut part, "filename", filename);
    }
    if let Some(obj) = media.source.as_object() {
        match obj.get("type").and_then(Value::as_str) {
            Some("data_base64") => {
                if let Some(data) = obj.get("data").and_then(Value::as_str) {
                    set_string(
                        &mut part,
                        "url",
                        &format!("data:{};base64,{data}", media.media_type),
                    );
                }
            }
            Some("url") => {
                if let Some(url) = obj.get("url").and_then(Value::as_str) {
                    set_string(&mut part, "url", url);
                }
            }
            _ => {}
        }
    }
    part
}

fn output_status_text(output: &CkToolOutput) -> (&'static str, String) {
    match &output.kind {
        CkOutputKind::Text { text } => ("completed", text.clone()),
        CkOutputKind::Json { value } => ("completed", value.to_string()),
        CkOutputKind::ErrorText { text } => ("error", text.clone()),
        CkOutputKind::ErrorJson { value } => ("error", value.to_string()),
        CkOutputKind::ExecutionDenied { reason } => (
            "error",
            reason
                .clone()
                .unwrap_or_else(|| "Execution denied".to_string()),
        ),
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => {
            let text = blocks
                .iter()
                .filter(|block| {
                    block
                        .provider_extras
                        .get(HARNESS)
                        .and_then(|namespace| namespace.get("rawAttachment"))
                        .is_none()
                })
                .filter_map(|block| match &block.kind {
                    ResultBlockKind::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let status = if matches!(&output.kind, CkOutputKind::ErrorContent { .. }) {
                "error"
            } else {
                "completed"
            };
            (status, text)
        }
    }
}

fn output_attachments(output: &CkToolOutput) -> Vec<Value> {
    let blocks = match &output.kind {
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => blocks,
        _ => return Vec::new(),
    };
    blocks
        .iter()
        .filter_map(|block| match &block.kind {
            ResultBlockKind::Text { text } => render_tool_text_attachment(block, text),
            ResultBlockKind::Media { media } => Some(render_tool_attachment(block, media)),
            ResultBlockKind::Opaque { opaque } => Some(opaque.raw.clone()),
        })
        .collect()
}

fn render_tool_text_attachment(block: &ResultBlock, text: &str) -> Option<Value> {
    let mut retained = block
        .provider_extras
        .get(HARNESS)
        .and_then(|namespace| namespace.get("rawAttachment"))
        .cloned()?;
    if retained.get("type").and_then(Value::as_str) == Some("text")
        && retained.get("text").and_then(Value::as_str) == Some(text)
    {
        return Some(retained);
    }
    let Some(object) = retained.as_object_mut() else {
        return Some(json!({ "type": "text", "text": text }));
    };
    object.insert("type".to_string(), Value::String("text".to_string()));
    object.insert("text".to_string(), Value::String(text.to_string()));
    Some(retained)
}

fn render_tool_attachment(block: &ResultBlock, media: &MediaBlock) -> Value {
    let Some(mut retained) = block
        .provider_extras
        .get(HARNESS)
        .and_then(|namespace| namespace.get("rawAttachment"))
        .cloned()
    else {
        return render_media_part(media);
    };
    if media_from_part(&retained) == *media {
        return retained;
    }
    let fresh = render_media_part(media);
    let Some(retained_object) = retained.as_object_mut() else {
        return fresh;
    };
    for key in [
        "type", "mime", "mimeType", "filename", "name", "url", "data",
    ] {
        retained_object.remove(key);
    }
    if let Some(fresh_object) = fresh.as_object() {
        retained_object.extend(fresh_object.clone());
    }
    retained
}

fn apply_tool_output_to_part(part: &mut Value, output: &CkToolOutput) {
    let (status, text) = output_status_text(output);
    set_nested_value(part, "state", "status", Value::String(status.to_string()));
    let output_key = if status == "error" { "error" } else { "output" };
    let stale_key = if status == "error" { "output" } else { "error" };
    remove_nested_value(part, "state", stale_key);
    set_nested_value(part, "state", output_key, Value::String(text));

    let attachments = output_attachments(output);
    if attachments.is_empty() {
        remove_nested_value(part, "state", "attachments");
    } else {
        set_nested_value(part, "state", "attachments", Value::Array(attachments));
    }
}

fn opaque_block(kind: &str, raw: Value, arc: Option<Value>) -> CkWireBlock {
    CkWireBlock::bare(CkKind::Opaque(OpaqueBlock {
        source: json!({ "type": "harness", "harness": HARNESS }),
        kind: kind.to_string(),
        raw,
        arc,
    }))
}

fn opaque_arc(part: &Value) -> Option<Value> {
    let approval_id = string_field(part, "approvalId")?;
    let part_type = string_field(part, "type").unwrap_or_default();
    let role = if part_type.contains("response") {
        "Response"
    } else {
        "Request"
    };
    Some(json!({ "kind": "Approval", "id": approval_id, "role": role }))
}

fn redacted_reasoning_data(part: &Value) -> Option<String> {
    string_field(part, "data")
        .or_else(|| string_field(part, "redacted"))
        .or_else(|| {
            part.get("metadata")
                .and_then(|m| string_field(m, "redacted"))
        })
}

fn find_signature(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(signature) = map.get("signature").and_then(Value::as_str) {
                return Some(signature.to_string());
            }
            map.values().find_map(find_signature)
        }
        Value::Array(values) => values.iter().find_map(find_signature),
        _ => None,
    }
}

fn synth_tool_id(ordinal: u64, part_index: usize, tool_name: &str, input: &Value) -> String {
    format!(
        "synth-tool-{ordinal}-{part_index}-{tool_name}-{}",
        stable_hash_prefix(input, 12)
    )
}

fn tool_name(part: &Value) -> String {
    string_field(part, "tool")
        .or_else(|| string_field(part, "toolName"))
        .or_else(|| string_field(part, "name"))
        .unwrap_or_else(|| "tool".to_string())
}

fn tool_status(part: &Value) -> Option<String> {
    part.get("state")
        .and_then(|state| string_field(state, "status"))
        .or_else(|| string_field(part, "status"))
}

fn is_synthetic_message(parts: &[Value]) -> bool {
    !parts.is_empty() && parts.iter().all(is_synthetic_part)
}

fn opencode_message_time(info: &Value, key: &str) -> Option<i64> {
    info.get("time").and_then(|time| integer_field(time, key))
}

fn integer_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn set_string(value: &mut Value, key: &str, text: &str) {
    set_value(value, key, Value::String(text.to_string()));
}

fn set_value(value: &mut Value, key: &str, next: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(key.to_string(), next);
    }
}

fn remove_nested_value(value: &mut Value, object_key: &str, key: &str) {
    if let Some(nested) = value.get_mut(object_key).and_then(Value::as_object_mut) {
        nested.remove(key);
    }
}

fn set_nested_value(value: &mut Value, object_key: &str, key: &str, next: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let entry = obj
        .entry(object_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Some(nested) = entry.as_object_mut() {
        nested.insert(key.to_string(), next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_tool_transform_fixture() -> Vec<CkWireMessage> {
        let paired_id = "folded-call";
        let paired_call = CkWireBlock::bare(CkKind::ToolCall {
            id: paired_id.to_string(),
            name: "read".to_string(),
            input: json!({ "path": "covered.txt" }),
            provider_executed: false,
        });
        let paired_result = CkWireBlock::bare(CkKind::ToolResult {
            id: paired_id.to_string(),
            tool_name: "read".to_string(),
            output: CkToolOutput::bare(CkOutputKind::Text {
                text: "folded output".to_string(),
            }),
            provider_executed: false,
        });
        let standalone_call = CkWireBlock::bare(CkKind::ToolCall {
            id: "standalone-call".to_string(),
            name: "write".to_string(),
            input: json!({ "path": "new.txt", "content": "hello" }),
            provider_executed: false,
        });
        let standalone_result = CkWireBlock::bare(CkKind::ToolResult {
            id: "standalone-result".to_string(),
            tool_name: "write".to_string(),
            output: CkToolOutput::bare(CkOutputKind::ErrorContent {
                blocks: vec![
                    ResultBlock {
                        kind: ResultBlockKind::Text {
                            text: "write denied".to_string(),
                        },
                        provider_extras: ProviderExtras::new(),
                    },
                    ResultBlock {
                        kind: ResultBlockKind::Media {
                            media: MediaBlock {
                                kind: MediaKind::Image,
                                media_type: "image/png".to_string(),
                                filename: Some("error.png".to_string()),
                                source: json!({
                                    "type": "data_base64",
                                    "data": "aW1hZ2U="
                                }),
                            },
                        },
                        provider_extras: ProviderExtras::new(),
                    },
                ],
            }),
            provider_executed: false,
        });

        vec![
            CkWireMessage::from_parts(
                "assistant",
                vec![paired_call, paired_result],
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    harness_id: Some("folded-tool-arc".to_string()),
                    ..Default::default()
                },
            ),
            CkWireMessage::from_parts(
                "assistant",
                vec![standalone_call],
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    harness_id: Some("standalone-call-message".to_string()),
                    ..Default::default()
                },
            ),
            CkWireMessage::from_parts(
                "tool",
                vec![standalone_result],
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    harness_id: Some("standalone-result-message".to_string()),
                    ..Default::default()
                },
            ),
        ]
    }

    #[test]
    fn native_decoder_promotes_nested_message_times_from_temporal_golden() {
        let golden: Value =
            serde_json::from_str(include_str!("../../testdata/temporal-parity-golden.json"))
                .expect("temporal parity golden");
        let raw = golden["cases"][0]["raw_messages"]
            .as_array()
            .expect("golden raw messages");
        let decoded = decode_opencode(raw);
        let assistant = decoded
            .messages
            .iter()
            .find(|message| message.mid == "temporal-assistant-1")
            .expect("timed assistant");
        assert_eq!(assistant.ck.meta.created_at_ms, Some(10_000));
        assert_eq!(assistant.ck.meta.completed_at_ms, Some(70_000));
    }

    #[test]
    fn every_fresh_tool_part_from_folded_transform_fixture_has_complete_state() {
        let encoded = encode_opencode(
            &fresh_tool_transform_fixture(),
            &DecodeSidecar::new(HARNESS),
            None,
        );
        let mut tool_part_count = 0;

        for message in &encoded {
            for part in message["parts"].as_array().unwrap() {
                if part["type"] != "tool" {
                    continue;
                }
                tool_part_count += 1;
                assert!(
                    part.get("callID").and_then(Value::as_str).is_some(),
                    "tool part has no callID: {part}"
                );
                assert!(
                    part.get("tool").and_then(Value::as_str).is_some(),
                    "tool part has no tool name: {part}"
                );
                let state = part["state"].as_object().unwrap();
                assert!(
                    state.get("status").is_some(),
                    "tool part has no status: {part}"
                );
                assert!(
                    state
                        .get("time")
                        .and_then(Value::as_object)
                        .and_then(|time| time.get("start"))
                        .is_some(),
                    "tool part has no state.time.start: {part}"
                );
                assert!(
                    state
                        .get("time")
                        .and_then(Value::as_object)
                        .and_then(|time| time.get("end"))
                        .is_some(),
                    "tool part has no state.time.end: {part}"
                );
            }
        }

        assert_eq!(
            tool_part_count, 3,
            "fixture did not exercise all fresh tool arms"
        );
        assert_eq!(encoded[0]["parts"][0]["state"]["status"], "completed");
        assert_eq!(
            encoded[0]["parts"][0]["state"]["input"],
            json!({ "path": "covered.txt" })
        );
        assert_eq!(encoded[1]["parts"][0]["state"]["status"], "running");
        assert_eq!(encoded[2]["info"]["role"], "assistant");
        assert_eq!(encoded[2]["parts"][0]["callID"], "standalone-result");
        assert_eq!(encoded[2]["parts"][0]["tool"], "write");
        assert_eq!(encoded[2]["parts"][0]["state"]["status"], "error");
        assert_eq!(encoded[2]["parts"][0]["state"]["input"], json!({}));
        assert_eq!(encoded[2]["parts"][0]["state"]["error"], "write denied");
        assert_eq!(
            encoded[2]["parts"][0]["state"]["attachments"],
            json!([{
                "type": "file",
                "mime": "image/png",
                "filename": "error.png",
                "url": "data:image/png;base64,aW1hZ2U="
            }])
        );
    }

    #[test]
    fn fresh_tool_parts_are_byte_identical_across_consecutive_defer_passes() {
        let fixture = fresh_tool_transform_fixture();
        let sidecar = DecodeSidecar::new(HARNESS);
        let first = encode_opencode(&fixture, &sidecar, None);
        let second = encode_opencode(&fixture, &sidecar, None);
        let first_tool_parts = first
            .iter()
            .flat_map(|message| message["parts"].as_array().unwrap())
            .filter(|part| part["type"] == "tool")
            .cloned()
            .collect::<Vec<_>>();
        let second_tool_parts = second
            .iter()
            .flat_map(|message| message["parts"].as_array().unwrap())
            .filter(|part| part["type"] == "tool")
            .cloned()
            .collect::<Vec<_>>();

        assert_eq!(
            serde_json::to_vec(&first_tool_parts).unwrap(),
            serde_json::to_vec(&second_tool_parts).unwrap()
        );
        assert!(first_tool_parts.iter().all(|part| {
            part["state"]["time"]["start"] == SYNTHETIC_TIMESTAMP
                && part["state"]["time"]["end"] == SYNTHETIC_TIMESTAMP
        }));
    }

    #[test]
    fn adjacent_equal_kind_deletion_retains_the_surviving_native_part() {
        let raw = vec![json!({
            "info": { "id": "adjacent-text", "role": "assistant" },
            "parts": [
                { "type": "text", "text": "A", "vendorPart": "A" },
                {
                    "type": "text",
                    "text": "DELETE",
                    "time": { "start": 2 },
                    "vendorPart": "delete"
                },
                {
                    "type": "text",
                    "text": "SURVIVE",
                    "time": { "start": 3 },
                    "vendorPart": "survive"
                }
            ]
        })];
        let decoded = decode_opencode(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(1);

        let encoded = encode_opencode(&[message], &decoded.sidecar, None);
        assert_eq!(
            encoded[0]["parts"],
            json!([
                { "type": "text", "text": "A", "vendorPart": "A" },
                {
                    "type": "text",
                    "text": "SURVIVE",
                    "time": { "start": 3 },
                    "vendorPart": "survive"
                }
            ])
        );
    }

    #[test]
    fn mutated_survivor_keeps_its_own_native_extras_after_sibling_deletion() {
        let raw = vec![json!({
            "info": { "id": "mutated-adjacent-text", "role": "assistant" },
            "parts": [
                { "type": "text", "text": "A", "vendorPart": "A" },
                { "type": "text", "text": "DELETE", "vendorPart": "delete" },
                { "type": "text", "text": "SURVIVE", "vendorPart": "survive" }
            ]
        })];
        let decoded = decode_opencode(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(1);
        let survivor = &mut message.content[1];
        survivor.kind = CkKind::Text {
            text: "§3§ SURVIVE".to_string(),
        };
        survivor.mark_modified();
        message.mark_modified();

        let encoded = encode_opencode(&[message], &decoded.sidecar, None);
        assert_eq!(
            encoded[0]["parts"],
            json!([
                { "type": "text", "text": "A", "vendorPart": "A" },
                { "type": "text", "text": "§3§ SURVIVE", "vendorPart": "survive" }
            ])
        );
    }

    #[test]
    fn adjacent_idless_tools_match_their_synthesized_identity() {
        let raw = vec![json!({
            "info": { "id": "idless-tools", "role": "assistant" },
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "vendorPart": "delete",
                    "state": { "status": "running", "input": { "path": "delete" } }
                },
                {
                    "type": "tool",
                    "tool": "read",
                    "vendorPart": "survive",
                    "state": { "status": "running", "input": { "path": "survive" } }
                }
            ]
        })];
        let decoded = decode_opencode(&raw);
        let mut message = decoded.messages[0].ck.clone();
        let first_id = match &message.content[0].kind {
            CkKind::ToolCall { id, .. } => id.clone(),
            _ => panic!("expected first tool call"),
        };
        let second_id = match &message.content[1].kind {
            CkKind::ToolCall { id, .. } => id.clone(),
            _ => panic!("expected second tool call"),
        };
        assert_ne!(first_id, second_id);
        assert_eq!(
            decoded.sidecar.messages["idless-tools"].blocks[1]
                .native_id
                .as_deref(),
            Some(second_id.as_str())
        );
        message.content.remove(0);

        let encoded = encode_opencode(&[message], &decoded.sidecar, None);
        assert_eq!(encoded[0]["parts"], json!([raw[0]["parts"][1].clone()]));
    }

    #[test]
    fn completed_and_error_attachments_round_trip_with_native_polarity() {
        let raw = vec![
            json!({
                "info": { "id": "completed-attachment", "role": "assistant" },
                "parts": [{
                    "type": "tool",
                    "callID": "call-ok",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {},
                        "output": "done",
                        "attachments": [{
                            "mime": "image/png",
                            "url": "data:image/png;base64,b2s=",
                            "vendor": "keep-ok"
                        }],
                        "time": { "start": 1, "end": 2 }
                    }
                }]
            }),
            json!({
                "info": { "id": "error-attachment", "role": "assistant" },
                "parts": [{
                    "type": "tool",
                    "callID": "call-err",
                    "tool": "read",
                    "state": {
                        "status": "error",
                        "input": {},
                        "error": "failed",
                        "attachments": [
                            {
                                "mime": "image/png",
                                "url": "data:image/png;base64,ZXJy",
                                "vendor": "keep-error"
                            },
                            { "type": "vendor-attachment", "payload": { "keep": true } }
                        ],
                        "time": { "start": 3, "end": 4 }
                    }
                }]
            }),
        ];
        let decoded = decode_opencode(&raw);
        let completed_output = match &decoded.messages[0].ck.content[1].kind {
            CkKind::ToolResult { output, .. } => output,
            _ => panic!("expected completed tool result"),
        };
        let error_output = match &decoded.messages[1].ck.content[1].kind {
            CkKind::ToolResult { output, .. } => output,
            _ => panic!("expected error tool result"),
        };
        assert!(matches!(
            completed_output.kind,
            CkOutputKind::Content { .. }
        ));
        assert!(matches!(
            error_output.kind,
            CkOutputKind::ErrorContent { .. }
        ));
        assert_eq!(
            encode_opencode(
                &decoded
                    .messages
                    .iter()
                    .map(|message| message.ck.clone())
                    .collect::<Vec<_>>(),
                &decoded.sidecar,
                None,
            ),
            raw
        );

        let mut error_message = decoded.messages[1].ck.clone();
        let result = &mut error_message.content[1];
        let CkKind::ToolResult { output, .. } = &mut result.kind else {
            panic!("expected error tool result");
        };
        let CkOutputKind::ErrorContent { blocks } = &mut output.kind else {
            panic!("expected ErrorContent");
        };
        let ResultBlockKind::Text { text } = &mut blocks[0].kind else {
            panic!("expected leading text block");
        };
        *text = "tagged failure".to_string();
        result.mark_modified();
        error_message.mark_modified();
        let encoded = encode_opencode(&[error_message], &decoded.sidecar, None);
        assert_eq!(encoded[0]["parts"][0]["state"]["status"], "error");
        assert_eq!(encoded[0]["parts"][0]["state"]["error"], "tagged failure");
        assert_eq!(
            encoded[0]["parts"][0]["state"]["attachments"],
            raw[1]["parts"][0]["state"]["attachments"]
        );
        assert_eq!(
            encoded[0]["parts"][0]["state"]["time"],
            raw[1]["parts"][0]["state"]["time"]
        );
    }

    #[test]
    fn adjacent_fresh_call_and_result_coalesce_for_message_v2_conversion() {
        let call = CkWireMessage::from_parts(
            "assistant",
            vec![CkWireBlock::bare(CkKind::ToolCall {
                id: "call-7".to_string(),
                name: "inspect".to_string(),
                input: json!({ "path": "artifact.bin" }),
                provider_executed: false,
            })],
            None,
            ProviderExtras::new(),
            HarnessMeta::default(),
        );
        let result = CkWireMessage::from_parts(
            "tool",
            vec![CkWireBlock::bare(CkKind::ToolResult {
                id: "call-7".to_string(),
                tool_name: "inspect".to_string(),
                output: CkToolOutput::bare(CkOutputKind::Text {
                    text: "done".to_string(),
                }),
                provider_executed: false,
            })],
            None,
            ProviderExtras::new(),
            HarnessMeta::default(),
        );

        let encoded = encode_opencode(&[call, result], &DecodeSidecar::new(HARNESS), None);
        assert_eq!(encoded.len(), 1);
        assert_eq!(encoded[0]["info"]["role"], "assistant");
        assert_eq!(encoded[0]["parts"][0]["callID"], "call-7");
        assert_eq!(encoded[0]["parts"][0]["tool"], "inspect");
        assert_eq!(
            encoded[0]["parts"][0]["state"]["input"],
            json!({ "path": "artifact.bin" })
        );
        assert_eq!(encoded[0]["parts"][0]["state"]["status"], "completed");
        assert_eq!(encoded[0]["parts"][0]["state"]["output"], "done");
    }

    #[test]
    fn mark_modified_tool_mutation_preserves_native_time_verbatim() {
        let raw = vec![json!({
            "info": { "id": "native-tool", "role": "assistant" },
            "parts": [{
                "type": "tool",
                "callID": "native-call",
                "tool": "bash",
                "state": {
                    "status": "completed",
                    "input": { "command": "printf native" },
                    "output": "native output",
                    "time": { "start": 12345, "end": 67890 }
                }
            }]
        })];
        let decoded = decode_opencode(&raw);
        let mut message = decoded.messages[0].ck.clone();
        let result = message
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::ToolResult { .. }))
            .unwrap();
        if let CkKind::ToolResult { output, .. } = &mut result.kind {
            output.kind = CkOutputKind::Text {
                text: "§1§ tagged output".to_string(),
            };
        }
        result.mark_modified();
        message.mark_modified();

        let served = encode_opencode(&[message], &decoded.sidecar, None);
        assert_eq!(
            served[0]["parts"][0]["state"]["time"],
            raw[0]["parts"][0]["state"]["time"]
        );
        assert_eq!(
            served[0]["parts"][0]["state"]["output"],
            "§1§ tagged output"
        );
    }

    #[test]
    fn empty_text_and_ignored_text_obey_wire_reachability() {
        let raw = vec![json!({
            "info": { "id": "msg_1", "role": "user" },
            "parts": [
                { "type": "text", "text": "", "time": { "start": 1 } },
                { "type": "text", "text": "hidden", "ignored": true }
            ]
        })];
        let decoded = decode_opencode(&raw);
        assert_eq!(decoded.messages[0].ck.content.len(), 1);
        assert!(matches!(
            decoded.messages[0].ck.content[0].kind,
            CkKind::Text { ref text } if text.is_empty()
        ));
        assert_eq!(
            encode_opencode(&[decoded.messages[0].ck.clone()], &decoded.sidecar, None),
            raw
        );
    }

    #[test]
    fn synthetic_todo_marker_survives_collapsed_pair_decode() {
        let raw = vec![json!({
            "info": { "id": "msg_todo", "role": "assistant" },
            "parts": [{
                "type": "tool",
                "tool": "todowrite",
                "callID": "mc_synthetic_todo_deadbeefdeadbeef",
                "syntheticTodoMarker": true,
                "state": {
                    "status": "completed",
                    "input": { "todos": [] },
                    "output": "[]"
                }
            }]
        })];

        let decoded = decode_opencode(&raw);

        assert!(decoded.messages[0].ck.meta.synthetic);
        assert_eq!(
            encode_opencode(&[decoded.messages[0].ck.clone()], &decoded.sidecar, None),
            raw
        );
    }

    #[test]
    fn compaction_is_extracted_as_boundary_not_content() {
        let raw = vec![json!({
            "info": { "id": "msg_boundary", "role": "user" },
            "parts": [
                { "type": "text", "text": "before" },
                { "type": "compaction", "auto": true }
            ]
        })];
        let decoded = decode_opencode(&raw);
        assert_eq!(decoded.messages[0].ck.content.len(), 1);
        assert_eq!(
            decoded.boundary.as_ref().unwrap().message_id,
            "msg_boundary"
        );
        assert_eq!(decoded.boundary.as_ref().unwrap().part_index, Some(1));
        let encoded = encode_opencode(&[decoded.messages[0].ck.clone()], &decoded.sidecar, None);
        let encoded_parts = encoded[0].get("parts").and_then(Value::as_array).unwrap();
        assert!(encoded_parts
            .iter()
            .all(|part| part.get("type").and_then(Value::as_str) != Some("compaction")));
    }

    #[test]
    fn resolved_reasoning_exemption_and_completed_sibling_mutation_are_distinct() {
        let raw = vec![
            json!({
                "info": { "id": "msg_old", "role": "assistant" },
                "parts": [
                    { "type": "reasoning", "text": "old thinking", "metadata": { "signature": "old-sig" } },
                    { "type": "text", "text": "old answer" }
                ]
            }),
            json!({
                "info": { "id": "msg_latest", "role": "assistant", "providerField": "keep" },
                "parts": [
                    { "type": "step-start", "step": 7 },
                    { "type": "reasoning", "text": "latest thinking", "metadata": { "signature": "latest-sig" }, "providerField": "keep" },
                    { "type": "text", "text": "latest answer" },
                    { "type": "reasoning", "text": "latest second thinking", "metadata": { "signature": "latest-sig-2" } },
                    { "type": "step-finish", "reason": "stop" }
                ]
            }),
        ];
        let decoded = decode_opencode(&raw);
        let mut output = decoded
            .messages
            .iter()
            .map(|message| message.ck.clone())
            .collect::<Vec<_>>();

        let untouched = encode_opencode_with_session(
            &output,
            &decoded.sidecar,
            Some("ses_live"),
            Some("msg_latest"),
        );
        assert_eq!(
            untouched[1], raw[1],
            "the transform-resolved live exemption replays untouched ingress exactly"
        );

        let latest_text = output[1]
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::Text { .. }))
            .unwrap();
        latest_text.kind = CkKind::Text {
            text: "§7§ mutated latest answer".to_string(),
        };
        let served =
            encode_opencode_with_session(&output, &decoded.sidecar, Some("ses_live"), None);
        assert_eq!(served[1]["parts"][1], raw[1]["parts"][1]);
        assert_eq!(served[1]["parts"][3], raw[1]["parts"][3]);
        assert_eq!(served[1]["parts"][2]["text"], "§7§ mutated latest answer");
        assert_eq!(served[1]["info"]["providerField"], "keep");
    }

    #[test]
    fn lineage_anchor_and_live_assistant_exemptions_replay_native_envelopes_exactly() {
        let raw = vec![
            json!({
                "info": { "id": "summary", "role": "user", "providerField": "anchor-info" },
                "parts": [
                    { "type": "text", "text": "volatile date", "providerField": "date-part" },
                    { "type": "text", "text": "continuation summary", "providerField": "anchor-part" }
                ]
            }),
            json!({
                "info": { "id": "latest", "role": "assistant", "providerField": "live-info" },
                "parts": [
                    { "type": "reasoning", "text": "signed", "metadata": { "signature": "sig" } },
                    { "type": "text", "text": "answer", "providerField": "live-part" }
                ]
            }),
        ];
        let decoded = decode_opencode(&raw);
        let mut output = decoded
            .messages
            .iter()
            .map(|message| message.ck.clone())
            .collect::<Vec<_>>();
        output[0].content[1].kind = CkKind::Text {
            text: "overlay must not escape".to_string(),
        };
        output[1].content[1].kind = CkKind::Text {
            text: "strip must not escape".to_string(),
        };

        let served = encode_opencode_with_session_exemptions(
            &output,
            &decoded.sidecar,
            Some("ses_live"),
            &["summary", "latest"],
        );
        assert_eq!(served, raw);
    }

    #[test]
    fn hard_epoch_fold_with_head_todo_coalesces_unmatched_reduced_tool_arc() {
        let raw = vec![json!({
            "absolute_ordinal": 2_752,
            "info": { "id": "first-tail-assistant", "role": "assistant" },
            "parts": [
                { "type": "step-start" },
                {
                    "type": "reasoning",
                    "text": "signed transition reasoning",
                    "metadata": { "signature": "transition-signature" }
                },
                {
                    "type": "tool",
                    "tool": "aft_zoom",
                    "callID": "call_uRXFDXYYs6UiMIkmAVDWZDzX",
                    "state": {
                        "status": "completed",
                        "input": { "path": "src/lib.rs", "symbols": ["target"] },
                        "output": "historical output"
                    }
                },
                { "type": "step-finish", "reason": "tool-calls" }
            ]
        })];
        let decoded = decode_opencode(&raw);
        assert!(matches!(
            decoded.messages[0].ck.content[2].kind,
            CkKind::ToolCall { ref id, .. } if id == "call_uRXFDXYYs6UiMIkmAVDWZDzX"
        ));
        assert!(matches!(
            decoded.messages[0].ck.content[3].kind,
            CkKind::ToolResult { ref id, .. } if id == "call_uRXFDXYYs6UiMIkmAVDWZDzX"
        ));
        let mut reduced_tail = decoded.messages[0].ck.clone();
        reduced_tail.content = reduced_tail
            .content
            .into_iter()
            .map(|block| {
                let reduced = match &block.kind {
                    CkKind::ToolCall { .. } => {
                        crate::ck_wire::reduced_block(&block, "reduced call skeleton")
                    }
                    CkKind::ToolResult { .. } => crate::ck_wire::reduced_block(&block, "[dropped]"),
                    _ => block,
                };
                CkWireBlock::bare(reduced.kind)
            })
            .collect();
        reduced_tail.mark_modified();

        let active_todo = crate::injection::build_synthetic_todo_pair(
            r#"[{"content":"Inspect contributor issue","status":"in_progress","priority":"high"}]"#,
        )
        .unwrap();
        let served = vec![
            CkWireMessage::synthetic_user_text("m0"),
            CkWireMessage::synthetic_user_text("m1"),
            active_todo.assistant_msg,
            active_todo.tool_msg,
            reduced_tail,
        ];

        // A hard request triggered by an epoch change can be the first request after a renderer
        // deployment, before the session row contains a transition marker. The codec must still
        // produce a valid request when that marker is absent.
        let encoded = encode_opencode_with_transition_state(
            &served,
            &decoded.sidecar,
            Some("astro-epoch-change"),
            &[],
            false,
        );
        let tool_ids = encoded
            .iter()
            .flat_map(|message| message["parts"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "tool")
            .filter_map(|part| part["callID"].as_str())
            .collect::<Vec<_>>();
        let unique_ids = tool_ids
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(
            tool_ids.len(),
            unique_ids.len(),
            "a reduced call/result shell must serialize as one native tool part: {tool_ids:?}"
        );
        assert_eq!(
            tool_ids
                .iter()
                .filter(|id| **id == "call_uRXFDXYYs6UiMIkmAVDWZDzX")
                .count(),
            1
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn whole_array_tool_use_guard_rejects_both_id_collision_directions() {
        let valid = vec![
            json!({
                "info": { "id": "first", "role": "assistant" },
                "parts": [{
                    "type": "tool",
                    "tool": "read",
                    "callID": "call-first",
                    "state": { "status": "pending", "input": {} }
                }]
            }),
            json!({
                "info": { "id": "second", "role": "assistant" },
                "parts": [{
                    "type": "tool",
                    "tool": "read",
                    "callID": "call-second",
                    "state": { "status": "pending", "input": {} }
                }]
            }),
        ];
        assert_unique_tool_use_ids(&valid);

        for (source, target) in [(0, 1), (1, 0)] {
            let mut collided = valid.clone();
            collided[target]["parts"][0]["callID"] = collided[source]["parts"][0]["callID"].clone();
            assert!(
                std::panic::catch_unwind(|| assert_unique_tool_use_ids(&collided)).is_err(),
                "copying the id from message {source} to message {target} must trip the guard"
            );
        }
    }

    #[test]
    fn incremental_sidecar_carries_pins_across_three_generations() {
        let mut seed = DecodeSidecar::new(HARNESS);
        seed.pin_mid("stable-key", "pinned-mid");
        let generation_1 = vec![json!({
            "info": { "id": "stable-key", "role": "user" },
            "parts": [{ "type": "text", "text": "first" }]
        })];
        let first = decode_opencode_with_sidecar(&generation_1, Some(&seed));
        assert_eq!(first.messages[0].mid, "pinned-mid");

        let mut generation_2 = generation_1.clone();
        generation_2.push(json!({
            "info": { "id": "other-key", "role": "assistant" },
            "parts": [{ "type": "text", "text": "second" }]
        }));
        let second = decode_opencode_sidecar_incremental(&generation_2, &first.sidecar, 1);
        assert_eq!(
            second.inherit_pin("stable-key").as_deref(),
            Some("pinned-mid")
        );

        let mut generation_3 = generation_2.clone();
        generation_3.push(json!({
            "info": { "id": "stable-key", "role": "user", "generation": 3 },
            "parts": [{ "type": "text", "text": "third" }]
        }));
        let incremental = decode_opencode_sidecar_incremental(&generation_3, &second, 2);
        let full = decode_opencode_with_sidecar(&generation_3, Some(&seed)).sidecar;
        assert_eq!(incremental, full);
        assert_eq!(
            incremental.message_by_mid("pinned-mid").unwrap().raw["info"]["generation"],
            3
        );

        // Mutation proof: dropping inherited pins before the third generation creates a second
        // identity for the repeated stable key and must diverge from the full decoder.
        let mut broken_prior = second;
        broken_prior.mid_pins.clear();
        let broken = decode_opencode_sidecar_incremental(&generation_3, &broken_prior, 2);
        assert_ne!(broken, full);
        assert!(broken.message_by_mid("stable-key").is_some());
    }

    #[test]
    fn text_before_latest_reasoning_uses_typed_wire_projection() {
        let raw = vec![json!({
            "info": { "id": "msg_text_first", "role": "assistant" },
            "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "answer" },
                { "type": "reasoning", "text": "signed thinking", "metadata": { "signature": "sig" } }
            ]
        })];
        let decoded = decode_opencode(&raw);
        let mut output = decoded
            .messages
            .iter()
            .map(|message| message.ck.clone())
            .collect::<Vec<_>>();

        output[0].content[1].kind = CkKind::Text {
            text: "§18240§ answer".to_string(),
        };
        output[0].content[2].kind = CkKind::Text {
            text: String::new(),
        };

        let served =
            encode_opencode_with_session(&output, &decoded.sidecar, Some("ses_live"), None);
        assert_eq!(served[0]["parts"][1]["text"], "§18240§ answer");
        assert_eq!(served[0]["parts"][2]["type"], "text");
        assert_eq!(served[0]["parts"][2]["text"], "");
    }

    #[test]
    fn unstamped_live_reasoning_tool_vector_replays_complete_native_parts() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../testdata/merged-reasoning-adapter-golden.json"
        ))
        .unwrap();
        let fixture = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "incident_astro_signed_reasoning_tool_without_text")
            .expect("ASTRO incident fixture generated from persisted rows");
        let raw: Vec<Value> = serde_json::from_value(fixture["raw_messages"].clone()).unwrap();
        let ingress: Vec<CkIngressMessage> =
            serde_json::from_value(fixture["encoded_input"].clone()).unwrap();
        let decoded = decode_opencode(&raw);
        let mut output = ingress
            .into_iter()
            .map(|message| message.ck)
            .collect::<Vec<_>>();
        let target = &mut output[0];
        target
            .content
            .retain(|block| !matches!(&block.kind, CkKind::Reasoning { .. }));
        let result = target
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::ToolResult { .. }))
            .expect("completed live tool result");
        if let CkKind::ToolResult { output, .. } = &mut result.kind {
            output.kind = CkOutputKind::Text {
                text: "§7685§ [redacted tool result]".to_string(),
            };
        }
        result.mark_modified();
        target.mark_modified();

        let served = encode_opencode_with_transition_state_and_reasoning_exemption(
            &output,
            &decoded.sidecar,
            Some("ses_08df2045bffeBcWcqw60elghER"),
            &[],
            fixture["target_mid"].as_str(),
            true,
        );
        let parts = served[0]["parts"].as_array().expect("served parts");
        let expected_types = fixture["expected_native_part_types"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part_type| part_type.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_types
        );
        assert_eq!(parts[1], raw[0]["parts"][1]);
        assert_eq!(served[0]["parts"], raw[0]["parts"]);
    }

    #[test]
    fn tag_mutation_clears_historical_thinking_but_replays_newest_native_vector() {
        fn native_assistant(mid: &str, thinking: &str, signature: &str, text: &str) -> Value {
            json!({
                "info": { "id": mid, "role": "assistant" },
                "parts": [
                    { "type": "step-start" },
                    { "type": "thinking", "thinking": thinking, "signature": signature },
                    { "type": "text", "text": text },
                    {
                        "type": "tool",
                        "callID": format!("call-{mid}"),
                        "tool": "bash",
                        "state": {
                            "status": "completed",
                            "input": { "command": "true" },
                            "output": "done"
                        }
                    },
                    { "type": "step-finish", "reason": "tool-calls" }
                ]
            })
        }

        let raw = vec![
            native_assistant(
                "historical",
                "historical thinking",
                "sig-historical",
                "older",
            ),
            native_assistant("newest", "newest thinking", "sig-newest", "latest"),
        ];
        let decoded = decode_opencode(&raw);
        let mut output = decoded
            .messages
            .into_iter()
            .map(|message| message.ck)
            .collect::<Vec<_>>();
        for (index, tag) in ["§1§ ", "§2§ "].into_iter().enumerate() {
            let message = &mut output[index];
            let text = message
                .content
                .iter_mut()
                .find_map(|block| match &mut block.kind {
                    CkKind::Text { text } => Some(text),
                    _ => None,
                })
                .expect("assistant text");
            text.insert_str(0, tag);
            message.mark_modified();
        }

        let served = encode_opencode_with_transition_state_and_reasoning_exemption(
            &output,
            &decoded.sidecar,
            Some("ses-thinking-scope"),
            &[],
            Some("newest"),
            true,
        );
        let historical_parts = served[0]["parts"].as_array().expect("historical parts");
        assert!(
            historical_parts
                .iter()
                .all(|part| !is_native_reasoning_part(part)),
            "historical thinking must not survive tag-mutated native replay: {historical_parts:?}"
        );
        assert_eq!(
            historical_parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["step-start", "text", "tool", "step-finish"]
        );
        assert_eq!(historical_parts[1]["text"], "§1§ older");
        assert_eq!(historical_parts[2]["callID"], "call-historical");
        assert_eq!(served[1], raw[1]);
        assert_eq!(served[1]["parts"][1], raw[1]["parts"][1]);
    }

    #[test]
    fn unmatched_tag_overlay_cannot_shift_or_duplicate_latest_native_reasoning() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../testdata/merged-reasoning-adapter-golden.json"
        ))
        .unwrap();
        let fixture = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "incident_astro_signed_reasoning_tool_without_text")
            .expect("ASTRO provider rejection fixture generated from persisted rows");
        let raw: Vec<Value> = serde_json::from_value(fixture["raw_messages"].clone()).unwrap();
        let ingress: Vec<CkIngressMessage> =
            serde_json::from_value(fixture["encoded_input"].clone()).unwrap();
        let decoded = decode_opencode(&raw);
        let mut output = ingress
            .into_iter()
            .map(|message| message.ck)
            .collect::<Vec<_>>();
        let target = &mut output[0];
        let reasoning_index = fixture["target_reasoning_index"].as_u64().unwrap() as usize;
        let mut inserted = CkWireBlock::bare(CkKind::Text {
            text: ".".to_string(),
        });
        inserted.mark_modified();
        target.content.insert(reasoning_index, inserted);
        target.mark_modified();

        let served = encode_opencode_with_transition_state_and_reasoning_exemption(
            &output,
            &decoded.sidecar,
            Some("ses_08df2045bffeBcWcqw60elghER"),
            &[],
            fixture["target_mid"].as_str(),
            true,
        );

        assert_eq!(served[0], raw[0]);
    }

    #[test]
    fn served_assistant_text_after_tool_requires_persisted_order() {
        let fresh = CkWireMessage::from_parts(
            "assistant",
            vec![
                CkWireBlock::bare(CkKind::ToolCall {
                    id: "fresh-call".to_string(),
                    name: "bash".to_string(),
                    input: json!({ "command": "true" }),
                    provider_executed: false,
                }),
                CkWireBlock::bare(CkKind::Text {
                    text: "fresh trailing text".to_string(),
                }),
            ],
            None,
            ProviderExtras::new(),
            HarnessMeta {
                harness_id: Some("fresh-text-tool-order".to_string()),
                ..Default::default()
            },
        );
        let fresh_served = encode_opencode(
            &[fresh],
            &DecodeSidecar::new("opencode"),
            Some("text-tool-invariant"),
        );
        let fresh_parts = fresh_served[0]["parts"].as_array().unwrap();
        assert_eq!(
            fresh_parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["text", "tool"]
        );
        assert!(!has_text_after_tool(fresh_parts));

        let persisted = vec![json!({
            "info": { "id": "persisted-text-tool-order", "role": "assistant" },
            "parts": [
                {
                    "type": "tool",
                    "callID": "persisted-call",
                    "tool": "bash",
                    "state": { "status": "running", "input": { "command": "true" } }
                },
                { "type": "text", "text": "persisted trailing text" }
            ]
        })];
        let decoded = decode_opencode(&persisted);
        let persisted_served = encode_opencode(
            &[decoded.messages[0].ck.clone()],
            &decoded.sidecar,
            Some("text-tool-invariant"),
        );
        let persisted_parts = persisted_served[0]["parts"].as_array().unwrap();
        assert!(has_text_after_tool(
            persisted[0]["parts"].as_array().unwrap()
        ));
        assert!(has_text_after_tool(persisted_parts));
        assert_eq!(persisted_served[0], persisted[0]);
    }

    #[test]
    fn unmatched_mutated_text_stays_at_its_persisted_pre_tool_position() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../testdata/merged-reasoning-adapter-golden.json"
        ))
        .unwrap();
        let fixture = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "incident_engram_text_after_tool_recurrence")
            .expect("ENGRAM recurrence fixture generated from persisted rows");
        let raw: Vec<Value> = serde_json::from_value(fixture["raw_messages"].clone()).unwrap();
        let ingress: Vec<CkIngressMessage> =
            serde_json::from_value(fixture["encoded_input"].clone()).unwrap();
        let decoded = decode_opencode(&raw);
        let mut output = ingress
            .into_iter()
            .map(|message| message.ck)
            .collect::<Vec<_>>();
        let target = &mut output[0];
        target
            .content
            .retain(|block| !matches!(&block.kind, CkKind::Reasoning { .. }));
        let text = target
            .content
            .iter_mut()
            .find_map(|block| match &mut block.kind {
                CkKind::Text { text } if text.starts_with("Three construction sites") => Some(text),
                _ => None,
            })
            .expect("incident assistant text");
        let expected_text =
            "§5696§ Three construction sites, plus a third upstream break in the same window."
                .to_string();
        *text = expected_text.clone();
        target.mark_modified();

        let served = encode_opencode_with_session(
            &output,
            &decoded.sidecar,
            Some("ses_0ad83017cffexe0g5N8UG0y3LZ"),
            None,
        );
        let parts = served[0]["parts"].as_array().expect("served parts");
        let expected_types = fixture["expected_native_part_types"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part_type| part_type.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_types
        );
        assert_eq!(parts[1]["text"], expected_text);
        assert_eq!(parts[2]["callID"], "toolu_01AveJRXHJBnmXzSD16U5zmi");
    }

    #[test]
    fn tagged_unstamped_text_stays_before_its_following_tool_part() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../testdata/merged-reasoning-adapter-golden.json"
        ))
        .unwrap();
        let fixture = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "incident_337_text_before_tool")
            .expect("incident fixture generated from persisted rows");
        let raw: Vec<Value> = serde_json::from_value(fixture["raw_messages"].clone()).unwrap();
        let ingress: Vec<CkIngressMessage> =
            serde_json::from_value(fixture["encoded_input"].clone()).unwrap();
        let decoded = decode_opencode(&raw);
        let mut output = ingress
            .into_iter()
            .map(|message| message.ck)
            .collect::<Vec<_>>();
        let incident = &mut output[0];
        let text = incident
            .content
            .iter_mut()
            .find_map(|block| match &mut block.kind {
                CkKind::Text { text } if text.starts_with("All three match") => Some(text),
                _ => None,
            })
            .expect("incident assistant text");
        *text = "§5548§ All three match the live keystore...".to_string();
        incident.mark_modified();
        incident
            .content
            .iter_mut()
            .filter(|block| matches!(block.kind, CkKind::Reasoning { .. }))
            .for_each(|block| {
                block.kind = CkKind::Text {
                    text: String::new(),
                };
                block.mark_modified();
            });

        let served = encode_opencode_with_session(
            &output,
            &decoded.sidecar,
            Some("ses_0ad83017cffexe0g5N8UG0y3LZ"),
            None,
        );
        let parts = served[0]["parts"].as_array().expect("served parts");
        let expected_types = fixture["expected_native_part_types"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part_type| part_type.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_types
        );
        assert_eq!(
            parts[2]["text"],
            "§5548§ All three match the live keystore..."
        );
        assert_eq!(parts[3]["callID"], "toolu_019MxMREqQYT875aJy8Q5w6W");
    }

    #[test]
    fn malformed_tool_attachments_round_trip_as_opaque_bytes() {
        let raw = vec![json!({
            "info": { "id": "malformed-attachments", "role": "assistant" },
            "parts": [{
                "type": "tool",
                "callID": "call-malformed",
                "tool": "inspect",
                "state": {
                    "status": "completed",
                    "input": {},
                    "output": "",
                    "attachments": [
                        {
                            "type": "text",
                            "text": { "not": "a string" },
                            "vendor": [3, 2, 1]
                        },
                        {
                            "type": "image",
                            "mime": "image/png",
                            "url": 17,
                            "vendor": { "keep": true }
                        }
                    ]
                }
            }]
        })];
        let ingress_bytes =
            serde_json::to_vec(&raw[0]["parts"][0]["state"]["attachments"]).unwrap();
        let decoded = decode_opencode(&raw);
        let mut message = decoded.messages[0].ck.clone();
        let result = message
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::ToolResult { .. }))
            .expect("tool result");
        let CkKind::ToolResult { output, .. } = &result.kind else {
            unreachable!();
        };
        let CkOutputKind::Content { blocks } = &output.kind else {
            panic!("malformed attachments must remain structured content");
        };
        assert!(blocks
            .iter()
            .all(|block| matches!(block.kind, ResultBlockKind::Opaque { .. })));
        result.mark_modified();
        message.mark_modified();

        let encoded = encode_opencode(&[message], &decoded.sidecar, None);
        let replay_bytes =
            serde_json::to_vec(&encoded[0]["parts"][0]["state"]["attachments"]).unwrap();
        assert_eq!(replay_bytes, ingress_bytes);
    }

    #[test]
    fn cleared_ck_reasoning_encodes_to_pre_fix_native_bytes_whole_and_chunked() {
        let expected: Vec<Value> = serde_json::from_slice(include_bytes!(
            "../../gen/reasoning-clear-legacy/pre-fix.native.json"
        ))
        .unwrap();
        let expected = expected
            .into_iter()
            .find(|message| message["info"]["id"] == "already")
            .unwrap();
        let mut source = expected.clone();
        source["parts"][0]["text"] = Value::String("pre-clear answer".to_string());
        source["parts"].as_array_mut().unwrap().insert(
            0,
            json!({
                "id": "a0",
                "type": "reasoning",
                "text": "thinking-already",
                "metadata": {
                    "custom": "retained",
                    "signature": "signature-already"
                }
            }),
        );
        let decoded = decode_opencode_with_sidecar(std::slice::from_ref(&source), None);
        let ck: Vec<CkWireMessage> = serde_json::from_slice(include_bytes!(
            "../../gen/reasoning-clear-legacy/pre-fix.ck.json"
        ))
        .unwrap();
        let mut cleared = ck
            .into_iter()
            .find(|message| message.meta.harness_id.as_deref() == Some("already"))
            .unwrap();
        let cleared_reasoning = cleared
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::Reasoning { .. }))
            .unwrap();
        assert!(matches!(
            &cleared_reasoning.kind,
            CkKind::Reasoning { text, signature } if text.is_empty() && signature.is_none()
        ));
        cleared_reasoning.mark_modified();
        cleared.mark_modified();
        let expected_bytes = serde_json::to_vec(&expected).unwrap();

        let whole = encode_opencode_with_transition_state_and_reasoning_exemption(
            std::slice::from_ref(&cleared),
            &decoded.sidecar,
            None,
            &[],
            Some("new"),
            true,
        );
        assert_eq!(serde_json::to_vec(&whole[0]).unwrap(), expected_bytes);

        let chunks = encode_opencode_chunks_with_transition_state(
            &[cleared],
            &decoded.sidecar,
            None,
            true,
            NativeEncodeExemptions {
                mutation_mids: &[],
                reasoning_mid: Some("new"),
            },
            true,
            0,
        );
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            serde_json::to_vec(&chunks[0].value).unwrap(),
            expected_bytes
        );
    }
}
