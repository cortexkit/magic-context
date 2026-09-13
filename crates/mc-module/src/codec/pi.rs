use serde_json::{json, Map, Value};

use crate::ck_wire::{
    CkIngressMessage, CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta,
    MediaBlock, MediaKind, MessageOrigin, OpaqueBlock, ProviderExtras, ResultBlock,
    ResultBlockKind,
};

use super::common::{classify_tool_result_child, ToolResultChildAdapter};
use super::sidecar::{
    block_is_unchanged, decoded_block_fingerprint, match_block_metas, meta_for_ck,
    stable_hash_prefix, stamp_block_identity, BlockMeta, DecodeSidecar, DecodedHarnessMessages,
    ExtractedBoundary, HarnessMessageMeta, MatchedBlockMetas,
};

pub type PiSessionEntryJson = Value;

const HARNESS: &str = "pi";

pub fn decode_pi(entries: &[PiSessionEntryJson]) -> DecodedHarnessMessages {
    decode_pi_with_sidecar(entries, None)
}

pub fn decode_pi_with_sidecar(
    entries: &[PiSessionEntryJson],
    prior: Option<&DecodeSidecar>,
) -> DecodedHarnessMessages {
    let mut sidecar = DecodeSidecar::new(HARNESS);
    if let Some(prior) = prior {
        sidecar.mid_pins = prior.mid_pins.clone();
    }

    let mut decoded = Vec::new();
    let mut boundary = None;

    for (entry_index, raw_entry) in entries.iter().enumerate() {
        if raw_entry.get("type").and_then(Value::as_str) == Some("compaction") {
            boundary = Some(pi_boundary(raw_entry, (entry_index + 1) as u64));
            continue;
        }

        let Some(message) = pi_message(raw_entry) else {
            if is_pi_opaque_entry(raw_entry) {
                decoded.push(decode_opaque_entry(
                    raw_entry,
                    (decoded.len() + 1) as u64,
                    &mut sidecar,
                ));
            }
            continue;
        };

        let ordinal = (decoded.len() + 1) as u64;
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let stable_key = pi_stable_key(raw_entry, message, entry_index);
        let mid = sidecar
            .inherit_pin(&stable_key)
            .unwrap_or_else(|| first_sight_pi_mid(raw_entry, message, &stable_key));
        sidecar.pin_mid(stable_key.clone(), mid.clone());

        let mut content = Vec::new();
        let mut block_metas = Vec::new();
        let origin = if role == "assistant" {
            pi_origin(message)
        } else {
            None
        };

        match role.as_str() {
            "user" => decode_user_message(message, ordinal, &mut content, &mut block_metas),
            "assistant" => {
                decode_assistant_message(message, ordinal, &mut content, &mut block_metas)
            }
            "toolResult" => {
                decode_tool_result_message(message, ordinal, &mut content, &mut block_metas)
            }
            _ => {
                let block = opaque_block(&role, message.clone(), None);
                push_block(&mut content, &mut block_metas, block, 0, message, &role);
            }
        }

        let ck_role = if role == "toolResult" {
            "tool"
        } else {
            role.as_str()
        };
        let ck = CkWireMessage::from_parts(
            ck_role.to_string(),
            content,
            origin,
            ProviderExtras::new(),
            HarnessMeta {
                harness_id: Some(mid.clone()),
                ordinal: Some(ordinal),
                synthetic: false,
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
                raw: raw_entry.clone(),
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

pub fn encode_pi(messages: &[CkWireMessage], sidecar: &DecodeSidecar) -> Vec<PiSessionEntryJson> {
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, msg)| match meta_for_ck(sidecar, msg, index) {
            Some(meta) => encode_with_meta(msg, meta),
            None => Some(encode_new_message(msg)),
        })
        .collect()
}

fn decode_user_message(
    message: &Value,
    _ordinal: u64,
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
) {
    match message.get("content") {
        Some(Value::String(text)) => {
            let block = CkWireBlock::bare(CkKind::Text { text: text.clone() });
            push_block(content, block_metas, block, 0, message, "text");
        }
        Some(Value::Array(parts)) => {
            for (part_index, part) in parts.iter().enumerate() {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = string_field(part, "text").unwrap_or_default();
                        let block =
                            block_with_pi_extras(CkKind::Text { text }, pi_extras_for_text(part));
                        push_block(content, block_metas, block, part_index, part, "text");
                    }
                    Some("image") => {
                        let block = CkWireBlock::bare(CkKind::Media(pi_media_from_part(part)));
                        push_block(content, block_metas, block, part_index, part, "image");
                    }
                    Some(other) => {
                        let block = opaque_block(other, part.clone(), None);
                        push_block(content, block_metas, block, part_index, part, other);
                    }
                    None => {
                        let block = opaque_block("unknown", part.clone(), None);
                        push_block(content, block_metas, block, part_index, part, "unknown");
                    }
                }
            }
        }
        _ => {}
    }
}

fn decode_assistant_message(
    message: &Value,
    ordinal: u64,
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
) {
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for (part_index, part) in parts.iter().enumerate() {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = string_field(part, "text").unwrap_or_default();
                let block = block_with_pi_extras(CkKind::Text { text }, pi_extras_for_text(part));
                push_block(content, block_metas, block, part_index, part, "text");
            }
            Some("thinking") => {
                let redacted = part
                    .get("redacted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if redacted {
                    let data = string_field(part, "thinkingSignature")
                        .or_else(|| string_field(part, "thinking"))
                        .unwrap_or_default();
                    let block = CkWireBlock::bare(CkKind::RedactedReasoning { data });
                    push_block(
                        content,
                        block_metas,
                        block,
                        part_index,
                        part,
                        "redacted_reasoning",
                    );
                } else {
                    let text = string_field(part, "thinking").unwrap_or_default();
                    let signature = string_field(part, "thinkingSignature");
                    let block = CkWireBlock::bare(CkKind::Reasoning { text, signature });
                    push_block(content, block_metas, block, part_index, part, "reasoning");
                }
            }
            Some("toolCall") => {
                let input = part.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let native_id = string_field(part, "id")
                    .or_else(|| string_field(part, "callId"))
                    .unwrap_or_else(|| {
                        synth_tool_id(ordinal, part_index, &tool_name(part), &input)
                    });
                let (canonical_id, item_id) = canonical_tool_id(&native_id);
                let mut extras = pi_extras_for_tool(part, item_id.as_deref(), Some(&native_id));
                let block = CkWireBlock::with_provider_extras(
                    CkKind::ToolCall {
                        id: canonical_id,
                        name: tool_name(part),
                        input,
                        provider_executed: false,
                    },
                    std::mem::take(&mut extras),
                );
                push_block(content, block_metas, block, part_index, part, "tool_call");
                if let Some(last) = block_metas.last_mut() {
                    last.native_id = Some(native_id);
                    last.item_id = item_id;
                }
            }
            Some(other) => {
                let block = opaque_block(other, part.clone(), opaque_arc(part));
                push_block(content, block_metas, block, part_index, part, other);
            }
            None => {
                let block = opaque_block("unknown", part.clone(), None);
                push_block(content, block_metas, block, part_index, part, "unknown");
            }
        }
    }
}

fn decode_tool_result_message(
    message: &Value,
    _ordinal: u64,
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
) {
    let native_id = string_field(message, "toolCallId").unwrap_or_else(|| "tool".to_string());
    let (canonical_id, item_id) = canonical_tool_id(&native_id);
    let tool_name = string_field(message, "toolName").unwrap_or_else(|| "tool".to_string());
    let is_error = message
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = pi_tool_result_output(message, is_error);
    let mut extras = ProviderExtras::new();
    if let Some(item_id) = item_id.as_deref() {
        insert_pi_extra(&mut extras, "itemId", Value::String(item_id.to_string()));
        insert_pi_extra(
            &mut extras,
            "nativeToolCallId",
            Value::String(native_id.clone()),
        );
    }
    let block = CkWireBlock::with_provider_extras(
        CkKind::ToolResult {
            id: canonical_id,
            tool_name,
            output,
            provider_executed: false,
        },
        extras,
    );
    push_block(content, block_metas, block, 0, message, "tool_result");
    if let Some(last) = block_metas.last_mut() {
        last.native_id = Some(native_id);
        last.item_id = item_id;
    }
}

fn push_block(
    content: &mut Vec<CkWireBlock>,
    block_metas: &mut Vec<BlockMeta>,
    mut block: CkWireBlock,
    native_index: usize,
    raw: &Value,
    kind: &str,
) {
    let block_index = content.len();
    let content_fingerprint = decoded_block_fingerprint(&block);
    stamp_block_identity(&mut block, block_index, native_index, &content_fingerprint);
    content.push(block);
    block_metas.push(BlockMeta {
        block_index,
        kind: kind.to_string(),
        native_index: Some(native_index),
        native_id: string_field(raw, "id").or_else(|| string_field(raw, "toolCallId")),
        item_id: None,
        content_fingerprint: Some(content_fingerprint),
        raw: raw.clone(),
    });
}

fn decode_opaque_entry(
    raw_entry: &Value,
    ordinal: u64,
    sidecar: &mut DecodeSidecar,
) -> CkIngressMessage {
    let stable_key = string_field(raw_entry, "id")
        .unwrap_or_else(|| format!("pi-entry-{}", stable_hash_prefix(raw_entry, 24)));
    let mid = sidecar
        .inherit_pin(&stable_key)
        .unwrap_or_else(|| format!("pi-entry-{stable_key}"));
    sidecar.pin_mid(stable_key.clone(), mid.clone());
    let role = raw_entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("custom")
        .to_string();
    let block = opaque_block(&role, raw_entry.clone(), None);
    let mut content = Vec::new();
    let mut blocks = Vec::new();
    push_block(&mut content, &mut blocks, block, 0, raw_entry, "opaque");
    let ck = CkWireMessage::from_parts(
        "user",
        content,
        None,
        ProviderExtras::new(),
        HarnessMeta {
            harness_id: Some(mid.clone()),
            ordinal: Some(ordinal),
            synthetic: false,
            ..Default::default()
        },
    );
    sidecar.remember_message(
        mid.clone(),
        HarnessMessageMeta {
            mid: mid.clone(),
            ordinal,
            role,
            raw: raw_entry.clone(),
            stable_key: Some(stable_key),
            blocks,
        },
    );
    CkIngressMessage { mid, ordinal, ck }
}

fn encode_with_meta(msg: &CkWireMessage, meta: &HarnessMessageMeta) -> Option<Value> {
    let mut raw = meta.raw.clone();
    let matched_metas = match_block_metas(&msg.content, &meta.blocks, false, block_matches_meta);
    if meta.role == "toolResult" || raw.get("role").and_then(Value::as_str) == Some("toolResult") {
        let (block, matched_meta) = msg
            .content
            .iter()
            .zip(&matched_metas.by_block)
            .find(|(block, _)| matches!(&block.kind, CkKind::ToolResult { .. }))?;
        if matched_meta.is_some_and(|meta| block_is_unchanged(block, meta)) {
            return Some(meta.raw.clone());
        }
        if let Some(message) = pi_message_mut(&mut raw) {
            update_tool_result_message(message, msg, matched_meta.is_some());
        } else {
            update_tool_result_message(&mut raw, msg, matched_meta.is_some());
        }
        return Some(if raw == meta.raw {
            meta.raw.clone()
        } else {
            raw
        });
    }

    if let Some(message) = pi_message_mut(&mut raw) {
        update_pi_message_content(message, msg, &matched_metas);
    } else if matches!(
        msg.content.first().map(|b| &b.kind),
        Some(CkKind::Opaque(_))
    ) {
        if let CkKind::Opaque(opaque) = &msg.content[0].kind {
            raw = opaque.raw.clone();
        }
    } else if msg.content.is_empty() {
        return None;
    }
    Some(if raw == meta.raw {
        meta.raw.clone()
    } else {
        raw
    })
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
            meta.kind == "tool_call"
                && meta.native_id.as_deref().is_none_or(|native| {
                    let (canonical, _) = canonical_tool_id(native);
                    canonical == id.as_str()
                })
        }
        CkKind::ToolResult { id, .. } => {
            meta.kind == "tool_result"
                && meta.native_id.as_deref().is_none_or(|native| {
                    let (canonical, _) = canonical_tool_id(native);
                    canonical == id.as_str()
                })
        }
        CkKind::Media(_) => meta.kind == "image",
        CkKind::Opaque(opaque) => meta.kind == opaque.kind,
    }
}

fn update_pi_message_content(
    message: &mut Value,
    msg: &CkWireMessage,
    matched_metas: &MatchedBlockMetas<'_>,
) {
    if msg.role == "user"
        && msg.content.len() == 1
        && message.get("content").is_some_and(Value::is_string)
    {
        if let Some(CkWireBlock {
            kind: CkKind::Text { text },
            ..
        }) = msg.content.first()
        {
            set_value(message, "content", Value::String(text.clone()));
            return;
        }
    }

    let mut parts = message
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (block, block_meta) in msg.content.iter().zip(&matched_metas.by_block) {
        if let Some(part_index) = block_meta.and_then(|block_meta| block_meta.native_index) {
            if let Some(part) = parts.get_mut(part_index) {
                if block_meta.is_some_and(|meta| block_is_unchanged(block, meta)) {
                    continue;
                }
                if !matches!(
                    &block.kind,
                    CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
                ) {
                    update_content_part(part, block);
                }
                continue;
            }
        }
        parts.push(render_block_as_content_part(block));
    }
    parts = matched_metas.remove_unretained_native_parts(parts);
    set_value(message, "content", Value::Array(parts));
}

fn update_tool_result_message(raw: &mut Value, msg: &CkWireMessage, preserve_existing_id: bool) {
    let Some(block) = msg
        .content
        .iter()
        .find(|block| matches!(&block.kind, CkKind::ToolResult { .. }))
    else {
        return;
    };
    if let CkKind::ToolResult {
        id,
        tool_name,
        output,
        ..
    } = &block.kind
    {
        let existing = preserve_existing_id
            .then(|| string_field(raw, "toolCallId"))
            .flatten();
        set_string(raw, "role", "toolResult");
        set_string(
            raw,
            "toolCallId",
            &native_tool_id(id, &block.provider_extras, existing),
        );
        set_string(raw, "toolName", tool_name);
        let is_error = matches!(
            output.kind,
            CkOutputKind::ErrorText { .. }
                | CkOutputKind::ErrorJson { .. }
                | CkOutputKind::ErrorContent { .. }
                | CkOutputKind::ExecutionDenied { .. }
        );
        set_value(raw, "isError", Value::Bool(is_error));
        set_value(
            raw,
            "content",
            Value::Array(render_tool_result_content(output)),
        );
    }
}

fn update_content_part(part: &mut Value, block: &CkWireBlock) {
    match &block.kind {
        CkKind::Text { text } => {
            set_string(part, "type", "text");
            set_string(part, "text", text);
            if let Some(sig) = block
                .provider_extras
                .get(HARNESS)
                .and_then(|ns| ns.get("textSignature"))
                .and_then(Value::as_str)
            {
                set_string(part, "textSignature", sig);
            }
        }
        CkKind::Reasoning { text, signature } => {
            set_string(part, "type", "thinking");
            set_string(part, "thinking", text);
            if let Some(signature) = signature {
                set_string(part, "thinkingSignature", signature);
            }
        }
        CkKind::RedactedReasoning { data } => {
            set_string(part, "type", "thinking");
            set_string(part, "thinking", "");
            set_string(part, "thinkingSignature", data);
            set_value(part, "redacted", Value::Bool(true));
        }
        CkKind::ToolCall {
            id, name, input, ..
        } => {
            let existing = string_field(part, "id");
            set_string(part, "type", "toolCall");
            set_string(
                part,
                "id",
                &native_tool_id(id, &block.provider_extras, existing),
            );
            set_string(part, "name", name);
            set_value(part, "arguments", input.clone());
            if let Some(sig) = block
                .provider_extras
                .get(HARNESS)
                .and_then(|ns| ns.get("thoughtSignature"))
                .and_then(Value::as_str)
            {
                set_string(part, "thoughtSignature", sig);
            }
        }
        CkKind::Media(media) => {
            *part = render_media_part(media);
        }
        CkKind::Opaque(opaque) => {
            *part = opaque.raw.clone();
        }
        CkKind::ToolResult { .. } => {
            *part = render_block_as_content_part(block);
        }
    }
}

fn encode_new_message(msg: &CkWireMessage) -> Value {
    if msg.role == "tool" {
        let mut raw = json!({ "role": "toolResult", "content": [] });
        update_tool_result_message(&mut raw, msg, false);
        return raw;
    }
    let role = &msg.role;
    let content: Vec<Value> = msg
        .content
        .iter()
        .map(render_block_as_content_part)
        .collect();
    if role == "assistant" {
        json!({
            "role": "assistant",
            "content": content,
            "api": msg.origin.as_ref().map(|o| o.api.as_str()).unwrap_or(""),
            "provider": msg.origin.as_ref().map(|o| o.provider.as_str()).unwrap_or(""),
            "model": msg.origin.as_ref().map(|o| o.model.as_str()).unwrap_or(""),
            "usage": {},
            "stopReason": "stop",
        })
    } else {
        json!({ "role": role, "content": content })
    }
}

fn render_block_as_content_part(block: &CkWireBlock) -> Value {
    match &block.kind {
        CkKind::Text { text } => {
            let mut part = json!({ "type": "text", "text": text });
            if let Some(sig) = block
                .provider_extras
                .get(HARNESS)
                .and_then(|ns| ns.get("textSignature"))
                .and_then(Value::as_str)
            {
                set_string(&mut part, "textSignature", sig);
            }
            part
        }
        CkKind::Reasoning { text, signature } => {
            let mut part = json!({ "type": "thinking", "thinking": text });
            if let Some(signature) = signature {
                set_string(&mut part, "thinkingSignature", signature);
            }
            part
        }
        CkKind::RedactedReasoning { data } => {
            json!({ "type": "thinking", "thinking": "", "thinkingSignature": data, "redacted": true })
        }
        CkKind::ToolCall {
            id, name, input, ..
        } => {
            let mut part = json!({
                "type": "toolCall",
                "id": native_tool_id(id, &block.provider_extras, None),
                "name": name,
                "arguments": input,
            });
            if let Some(sig) = block
                .provider_extras
                .get(HARNESS)
                .and_then(|ns| ns.get("thoughtSignature"))
                .and_then(Value::as_str)
            {
                set_string(&mut part, "thoughtSignature", sig);
            }
            part
        }
        CkKind::ToolResult { output, .. } => json!({
            "type": "text",
            "text": output_text(output),
        }),
        CkKind::Media(media) => render_media_part(media),
        CkKind::Opaque(opaque) => opaque.raw.clone(),
    }
}

fn pi_message(raw_entry: &Value) -> Option<&Value> {
    if raw_entry.get("type").and_then(Value::as_str) == Some("message") {
        raw_entry.get("message")
    } else if raw_entry.get("role").is_some() {
        Some(raw_entry)
    } else {
        None
    }
}

fn pi_message_mut(raw_entry: &mut Value) -> Option<&mut Value> {
    if raw_entry.get("type").and_then(Value::as_str) == Some("message") {
        raw_entry.get_mut("message")
    } else if raw_entry.get("role").is_some() {
        Some(raw_entry)
    } else {
        None
    }
}

fn is_pi_opaque_entry(raw_entry: &Value) -> bool {
    matches!(
        raw_entry.get("type").and_then(Value::as_str),
        Some("custom_message" | "custom" | "branch_summary")
    )
}

fn pi_boundary(raw_entry: &Value, ordinal: u64) -> ExtractedBoundary {
    let message_id = string_field(raw_entry, "firstKeptEntryId")
        .or_else(|| string_field(raw_entry, "id"))
        .unwrap_or_else(|| format!("pi-boundary-{}", stable_hash_prefix(raw_entry, 12)));
    ExtractedBoundary {
        harness: HARNESS.to_string(),
        message_id,
        ordinal,
        part_index: None,
        entry_id: string_field(raw_entry, "id"),
        raw: raw_entry.clone(),
    }
}

fn pi_origin(message: &Value) -> Option<MessageOrigin> {
    Some(MessageOrigin {
        api: string_field(message, "api")?,
        provider: string_field(message, "provider")?,
        model: string_field(message, "model")?,
    })
}

fn pi_stable_key(raw_entry: &Value, message: &Value, entry_index: usize) -> String {
    string_field(raw_entry, "id")
        .or_else(|| string_field(message, "responseId"))
        .or_else(|| message_timestamp(message).map(|ts| format!("pi-ts-{ts}")))
        .unwrap_or_else(|| format!("pi-msg-{entry_index}-{}", stable_hash_prefix(message, 24)))
}

fn first_sight_pi_mid(raw_entry: &Value, message: &Value, stable_key: &str) -> String {
    string_field(message, "responseId")
        .or_else(|| message_timestamp(message).map(|ts| format!("pi-ts-{ts}")))
        .or_else(|| entry_timestamp(raw_entry).map(|ts| format!("pi-ts-{ts}")))
        .unwrap_or_else(|| stable_key.to_string())
}

fn message_timestamp(message: &Value) -> Option<i64> {
    message.get("timestamp").and_then(number_to_i64)
}

fn entry_timestamp(entry: &Value) -> Option<i64> {
    if let Some(n) = entry.get("timestamp").and_then(number_to_i64) {
        return Some(n);
    }
    let text = entry.get("timestamp").and_then(Value::as_str)?;
    chrono_like_timestamp_ms(text)
}

fn number_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
}

fn chrono_like_timestamp_ms(text: &str) -> Option<i64> {
    // Keep the codec dependency-free: use the stable digits in ISO-8601 strings only as a
    // deterministic fallback when the AgentMessage timestamp is absent.
    let digits: String = text.chars().filter(|ch| ch.is_ascii_digit()).collect();
    digits.get(..14)?.parse::<i64>().ok()
}

fn canonical_tool_id(native_id: &str) -> (String, Option<String>) {
    if let Some((call_id, item_id)) = native_id.split_once('|') {
        (call_id.to_string(), Some(item_id.to_string()))
    } else {
        (native_id.to_string(), None)
    }
}

fn native_tool_id(id: &str, extras: &ProviderExtras, existing: Option<String>) -> String {
    if let Some(existing) = existing {
        if !existing.is_empty() {
            return existing;
        }
    }
    if let Some(native) = extras
        .get(HARNESS)
        .and_then(|ns| ns.get("nativeToolCallId"))
        .and_then(Value::as_str)
    {
        return native.to_string();
    }
    if let Some(item_id) = extras
        .get(HARNESS)
        .and_then(|ns| ns.get("itemId"))
        .and_then(Value::as_str)
    {
        return format!("{id}|{item_id}");
    }
    id.to_string()
}

fn synth_tool_id(ordinal: u64, part_index: usize, tool_name: &str, input: &Value) -> String {
    format!(
        "synth-tool-{ordinal}-{part_index}-{tool_name}-{}",
        stable_hash_prefix(input, 12)
    )
}

fn pi_extras_for_text(part: &Value) -> ProviderExtras {
    let mut extras = ProviderExtras::new();
    if let Some(signature) = string_field(part, "textSignature") {
        insert_pi_extra(&mut extras, "textSignature", Value::String(signature));
    }
    extras
}

fn pi_extras_for_tool(
    part: &Value,
    item_id: Option<&str>,
    native_id: Option<&str>,
) -> ProviderExtras {
    let mut extras = ProviderExtras::new();
    if let Some(signature) = string_field(part, "thoughtSignature") {
        insert_pi_extra(&mut extras, "thoughtSignature", Value::String(signature));
    }
    if let Some(item_id) = item_id {
        insert_pi_extra(&mut extras, "itemId", Value::String(item_id.to_string()));
    }
    if let Some(native_id) = native_id {
        insert_pi_extra(
            &mut extras,
            "nativeToolCallId",
            Value::String(native_id.to_string()),
        );
    }
    extras
}

fn insert_pi_extra(extras: &mut ProviderExtras, key: &str, value: Value) {
    extras
        .entry(HARNESS.to_string())
        .or_default()
        .insert(key.to_string(), value);
}

fn block_with_pi_extras(kind: CkKind, extras: ProviderExtras) -> CkWireBlock {
    if extras.is_empty() {
        CkWireBlock::bare(kind)
    } else {
        CkWireBlock::with_provider_extras(kind, extras)
    }
}

fn pi_tool_result_output(message: &Value, is_error: bool) -> CkToolOutput {
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return CkToolOutput::bare(if is_error {
            CkOutputKind::ErrorText {
                text: String::new(),
            }
        } else {
            CkOutputKind::Text {
                text: String::new(),
            }
        });
    };

    if let [part] = parts.as_slice() {
        let only_plain_fields = part.as_object().is_some_and(|object| {
            object
                .keys()
                .all(|key| matches!(key.as_str(), "type" | "text"))
        });
        if only_plain_fields && part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = string_field(part, "text") {
                return CkToolOutput::bare(if is_error {
                    CkOutputKind::ErrorText { text }
                } else {
                    CkOutputKind::Text { text }
                });
            }
        }
    }

    let blocks = parts
        .iter()
        .map(|part| {
            let mut provider_extras = ProviderExtras::new();
            provider_extras
                .entry(HARNESS.to_string())
                .or_default()
                .insert("rawResultPart".to_string(), part.clone());
            ResultBlock {
                kind: classify_tool_result_child(part, ToolResultChildAdapter::Pi),
                provider_extras,
            }
        })
        .collect();
    CkToolOutput::bare(if is_error {
        CkOutputKind::ErrorContent { blocks }
    } else {
        CkOutputKind::Content { blocks }
    })
}

fn render_tool_result_content(output: &CkToolOutput) -> Vec<Value> {
    match &output.kind {
        CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => {
            vec![json!({ "type": "text", "text": text })]
        }
        CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => {
            vec![json!({ "type": "text", "text": value.to_string() })]
        }
        CkOutputKind::ExecutionDenied { reason } => vec![json!({
            "type": "text",
            "text": reason.clone().unwrap_or_else(|| "Execution denied".to_string())
        })],
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => {
            blocks.iter().map(render_tool_result_block).collect()
        }
    }
}

fn render_tool_result_block(block: &ResultBlock) -> Value {
    let retained = block
        .provider_extras
        .get(HARNESS)
        .and_then(|namespace| namespace.get("rawResultPart"))
        .cloned();
    match &block.kind {
        ResultBlockKind::Text { text } => {
            let mut part = retained.unwrap_or_else(|| json!({ "type": "text" }));
            set_string(&mut part, "type", "text");
            set_string(&mut part, "text", text);
            part
        }
        ResultBlockKind::Media { media } => {
            let Some(mut retained) = retained else {
                return render_media_part(media);
            };
            if pi_media_from_part(&retained) == *media {
                return retained;
            }
            let fresh = render_media_part(media);
            let Some(retained_object) = retained.as_object_mut() else {
                return fresh;
            };
            for key in ["type", "mimeType", "mime", "filename", "data", "url"] {
                retained_object.remove(key);
            }
            if let Some(fresh_object) = fresh.as_object() {
                retained_object.extend(fresh_object.clone());
            }
            retained
        }
        ResultBlockKind::Opaque { opaque } => opaque.raw.clone(),
    }
}

fn output_text(output: &CkToolOutput) -> String {
    match &output.kind {
        CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => text.clone(),
        CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => value.to_string(),
        CkOutputKind::ExecutionDenied { reason } => reason
            .clone()
            .unwrap_or_else(|| "Execution denied".to_string()),
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => blocks
            .iter()
            .filter_map(|block| match &block.kind {
                ResultBlockKind::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn pi_media_from_part(part: &Value) -> MediaBlock {
    let media_type = string_field(part, "mimeType")
        .or_else(|| string_field(part, "mime"))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let source = if let Some(data) = string_field(part, "data") {
        json!({ "type": "data_base64", "data": data })
    } else if let Some(url) = string_field(part, "url") {
        json!({ "type": "url", "url": url })
    } else {
        json!({ "type": "opaque", "raw": part })
    };
    MediaBlock {
        kind: media_kind(&media_type),
        media_type,
        filename: string_field(part, "filename"),
        source,
    }
}

fn render_media_part(media: &MediaBlock) -> Value {
    let mut part = json!({ "type": "image", "mimeType": media.media_type });
    if media.kind != MediaKind::Image {
        set_string(&mut part, "type", "file");
    }
    if let Some(filename) = &media.filename {
        set_string(&mut part, "filename", filename);
    }
    if let Some(obj) = media.source.as_object() {
        match obj.get("type").and_then(Value::as_str) {
            Some("data_base64") => {
                if let Some(data) = obj.get("data").and_then(Value::as_str) {
                    set_string(&mut part, "data", data);
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

fn tool_name(part: &Value) -> String {
    string_field(part, "name").unwrap_or_else(|| "tool".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_id_arriving_later_does_not_replace_pinned_timestamp_mid() {
        let first = vec![json!({
            "type": "message",
            "id": "entry-a",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "streaming" }],
                "api": "responses",
                "provider": "openai",
                "model": "gpt-test",
                "usage": {},
                "stopReason": "stop",
                "timestamp": 42
            }
        })];
        let decoded_first = decode_pi(&first);
        assert_eq!(decoded_first.messages[0].mid, "pi-ts-42");

        let settled = vec![json!({
            "type": "message",
            "id": "entry-a",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "streaming" }],
                "api": "responses",
                "provider": "openai",
                "model": "gpt-test",
                "responseId": "resp_late",
                "usage": {},
                "stopReason": "stop",
                "timestamp": 42
            }
        })];
        let decoded_settled = decode_pi_with_sidecar(&settled, Some(&decoded_first.sidecar));
        assert_eq!(decoded_settled.messages[0].mid, "pi-ts-42");
    }

    #[test]
    fn split_pipe_tool_ids_decode_to_canonical_id_and_round_trip() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [{
                "type": "toolCall",
                "id": "call-1|item-9",
                "name": "lookup",
                "arguments": { "q": "x" },
                "thoughtSignature": "sig"
            }],
            "api": "responses",
            "provider": "openai",
            "model": "gpt-test",
            "responseId": "resp-1",
            "usage": {},
            "stopReason": "toolUse",
            "timestamp": 7
        })];
        let decoded = decode_pi(&raw);
        let block = &decoded.messages[0].ck.content[0];
        assert!(matches!(block.kind, CkKind::ToolCall { ref id, .. } if id == "call-1"));
        assert_eq!(
            block.provider_extras[HARNESS]["itemId"],
            Value::String("item-9".to_string())
        );
        assert_eq!(
            encode_pi(&[decoded.messages[0].ck.clone()], &decoded.sidecar),
            raw
        );
    }

    #[test]
    fn adjacent_tool_deletion_matches_the_surviving_native_id() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "head" },
                { "type": "toolCall", "id": "call-a|item-a", "name": "first", "arguments": { "a": 1 } },
                { "type": "toolCall", "id": "call-b|item-b", "name": "second", "arguments": { "b": 2 } },
                { "type": "text", "text": "tail" }
            ],
            "api": "responses",
            "provider": "openai",
            "model": "gpt-test",
            "responseId": "resp-tools",
            "usage": {},
            "stopReason": "toolUse",
            "timestamp": 8
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(1);

        let encoded = encode_pi(&[message], &decoded.sidecar);
        let content = encoded[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0], raw[0]["content"][0]);
        assert_eq!(content[1], raw[0]["content"][2]);
        assert_eq!(content[2], raw[0]["content"][3]);
    }

    #[test]
    fn leading_deletion_does_not_shift_the_next_block_onto_the_removed_slot() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-a", "name": "first", "arguments": {} },
                { "type": "text", "text": "survivor", "textSignature": "sig-survivor" }
            ],
            "timestamp": 9
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(0);

        let encoded = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(encoded[0]["content"], json!([raw[0]["content"][1].clone()]));
    }

    #[test]
    fn duplicate_kind_adjacency_removes_only_the_deleted_text() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "A", "vendorPart": "A" },
                {
                    "type": "text",
                    "text": "DELETE",
                    "textSignature": "sig-delete",
                    "vendorPart": "delete"
                },
                { "type": "text", "text": "SURVIVE", "vendorPart": "survive" }
            ],
            "timestamp": 10
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(1);

        let encoded = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(
            encoded[0]["content"],
            json!([
                { "type": "text", "text": "A", "vendorPart": "A" },
                { "type": "text", "text": "SURVIVE", "vendorPart": "survive" }
            ])
        );
    }

    #[test]
    fn mutated_text_survivor_keeps_its_own_signature_and_vendor_extras() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "A", "vendorPart": "A" },
                {
                    "type": "text",
                    "text": "DELETE",
                    "textSignature": "sig-delete",
                    "vendorPart": "delete"
                },
                {
                    "type": "text",
                    "text": "SURVIVE",
                    "textSignature": "sig-survive",
                    "vendorPart": "survive"
                }
            ],
            "timestamp": 10
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(1);
        let survivor = &mut message.content[1];
        survivor.kind = CkKind::Text {
            text: "§3§ SURVIVE".to_string(),
        };
        survivor.mark_modified();
        message.mark_modified();

        let encoded = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(
            encoded[0]["content"],
            json!([
                { "type": "text", "text": "A", "vendorPart": "A" },
                {
                    "type": "text",
                    "text": "§3§ SURVIVE",
                    "textSignature": "sig-survive",
                    "vendorPart": "survive"
                }
            ])
        );
    }

    #[test]
    fn untouched_multi_text_tool_result_replays_raw_part_boundaries_and_extras() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "read",
            "isError": false,
            "content": [
                { "type": "text", "text": "a", "vendor": "keep" },
                { "type": "text", "text": "b" }
            ]
        })];
        let decoded = decode_pi(&raw);
        let CkKind::ToolResult { output, .. } = &decoded.messages[0].ck.content[0].kind else {
            panic!("expected tool result");
        };
        assert!(matches!(output.kind, CkOutputKind::Content { .. }));
        assert_eq!(
            encode_pi(&[decoded.messages[0].ck.clone()], &decoded.sidecar),
            raw
        );
    }

    #[test]
    fn mixed_image_error_tool_result_preserves_polarity_and_part_extras_on_mutation() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-2",
            "toolName": "inspect",
            "isError": true,
            "content": [
                { "type": "text", "text": "failed", "vendor": "text-extra" },
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": "aW1hZ2U=",
                    "vendor": "image-extra"
                }
            ]
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        let block = &mut message.content[0];
        let CkKind::ToolResult { output, .. } = &mut block.kind else {
            panic!("expected tool result");
        };
        let CkOutputKind::ErrorContent { blocks } = &mut output.kind else {
            panic!("mixed native error must decode as ErrorContent");
        };
        let ResultBlockKind::Text { text } = &mut blocks[0].kind else {
            panic!("expected leading text result block");
        };
        *text = "tagged failed".to_string();
        let ResultBlockKind::Media { media } = &mut blocks[1].kind else {
            panic!("expected image result block");
        };
        media.filename = Some("failure.png".to_string());
        block.mark_modified();
        message.mark_modified();

        let encoded = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(encoded[0]["isError"], true);
        assert_eq!(
            encoded[0]["content"],
            json!([
                { "type": "text", "text": "tagged failed", "vendor": "text-extra" },
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "filename": "failure.png",
                    "data": "aW1hZ2U=",
                    "vendor": "image-extra"
                }
            ])
        );
    }

    #[test]
    fn mixed_opaque_error_tool_result_retains_opaque_part() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-opaque",
            "toolName": "inspect",
            "isError": true,
            "content": [
                { "type": "text", "text": "failed" },
                { "type": "vendor-detail", "code": 17, "vendor": { "keep": true } }
            ]
        })];
        let decoded = decode_pi(&raw);
        let CkKind::ToolResult { output, .. } = &decoded.messages[0].ck.content[0].kind else {
            panic!("expected tool result");
        };
        let CkOutputKind::ErrorContent { blocks } = &output.kind else {
            panic!("mixed opaque error must decode as ErrorContent");
        };
        assert!(matches!(blocks[1].kind, ResultBlockKind::Opaque { .. }));
        assert_eq!(
            encode_pi(&[decoded.messages[0].ck.clone()], &decoded.sidecar),
            raw
        );

        let mut message = decoded.messages[0].ck.clone();
        let result = &mut message.content[0];
        let CkKind::ToolResult { output, .. } = &mut result.kind else {
            panic!("expected tool result");
        };
        let CkOutputKind::ErrorContent { blocks } = &mut output.kind else {
            panic!("expected ErrorContent");
        };
        let ResultBlockKind::Text { text } = &mut blocks[0].kind else {
            panic!("expected leading text block");
        };
        *text = "tagged failed".to_string();
        result.mark_modified();
        message.mark_modified();
        let encoded = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(encoded[0]["isError"], true);
        assert_eq!(
            encoded[0]["content"],
            json!([
                { "type": "text", "text": "tagged failed" },
                { "type": "vendor-detail", "code": 17, "vendor": { "keep": true } }
            ])
        );
    }

    #[test]
    fn empty_error_tool_result_retains_empty_content_and_error_polarity() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-empty",
            "toolName": "inspect",
            "isError": true,
            "content": []
        })];
        let decoded = decode_pi(&raw);
        let CkKind::ToolResult { output, .. } = &decoded.messages[0].ck.content[0].kind else {
            panic!("expected tool result");
        };
        assert!(matches!(
            output.kind,
            CkOutputKind::ErrorContent { ref blocks } if blocks.is_empty()
        ));
        assert_eq!(
            encode_pi(&[decoded.messages[0].ck.clone()], &decoded.sidecar),
            raw
        );
    }

    #[test]
    fn frozen_deletion_replay_is_byte_stable() {
        let raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-a", "name": "first", "arguments": {} },
                { "type": "toolCall", "id": "call-b", "name": "second", "arguments": {} }
            ],
            "timestamp": 11
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.remove(0);

        let first = encode_pi(&[message.clone()], &decoded.sidecar);
        let replay = encode_pi(&[message], &decoded.sidecar);
        assert_eq!(replay, first);
        assert_eq!(first[0]["content"], json!([raw[0]["content"][1].clone()]));
    }

    #[test]
    fn untouched_message_replays_the_exact_retained_raw_value() {
        let raw = vec![json!({
            "type": "message",
            "id": "entry-byte-identity",
            "vendorEnvelope": { "unknown": [1, 2, 3] },
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "text",
                    "text": "unchanged",
                    "textSignature": "sig",
                    "vendorPart": { "keep": true }
                }],
                "timestamp": 12,
                "vendorMessage": "keep"
            }
        })];
        let decoded = decode_pi(&raw);
        let encoded = encode_pi(&[decoded.messages[0].ck.clone()], &decoded.sidecar);
        assert_eq!(encoded, raw);
    }

    #[test]
    fn deleted_tool_result_does_not_replay_the_retained_raw_entry() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-a",
            "toolName": "first",
            "content": [{ "type": "text", "text": "done" }],
            "isError": false,
            "timestamp": 13
        })];
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        message.content.clear();

        assert!(encode_pi(&[message], &decoded.sidecar).is_empty());
    }

    #[test]
    fn malformed_tool_result_children_round_trip_as_opaque_bytes() {
        let raw = vec![json!({
            "role": "toolResult",
            "toolCallId": "call-malformed",
            "toolName": "inspect",
            "isError": false,
            "content": [
                {
                    "type": "text",
                    "text": { "not": "a string" },
                    "vendor": [3, 2, 1]
                },
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": 17,
                    "vendor": { "keep": true }
                }
            ]
        })];
        let ingress_bytes = serde_json::to_vec(&raw[0]["content"]).unwrap();
        let decoded = decode_pi(&raw);
        let mut message = decoded.messages[0].ck.clone();
        let result = &mut message.content[0];
        let CkKind::ToolResult { output, .. } = &result.kind else {
            panic!("expected tool result");
        };
        let CkOutputKind::Content { blocks } = &output.kind else {
            panic!("malformed children must remain structured content");
        };
        assert!(blocks
            .iter()
            .all(|block| matches!(block.kind, ResultBlockKind::Opaque { .. })));
        result.mark_modified();
        message.mark_modified();

        let encoded = encode_pi(&[message], &decoded.sidecar);
        let replay_bytes = serde_json::to_vec(&encoded[0]["content"]).unwrap();
        assert_eq!(replay_bytes, ingress_bytes);
    }

    #[test]
    fn compaction_entry_is_boundary_signal() {
        let raw = vec![json!({
            "type": "compaction",
            "id": "cmp-1",
            "summary": "summary",
            "firstKeptEntryId": "entry-kept",
            "tokensBefore": 100
        })];
        let decoded = decode_pi(&raw);
        assert!(decoded.messages.is_empty());
        assert_eq!(decoded.boundary.as_ref().unwrap().message_id, "entry-kept");
    }
}
