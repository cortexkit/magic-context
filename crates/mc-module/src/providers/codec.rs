//! Strict Broca-native transcript and replacement codec.
use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeOrigin {
    provider_module_id: String,
    model_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeMessage {
    role: String,
    content: Vec<NativeBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cache_prefix_blocks: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<NativeOrigin>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum NativeBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedReasoning {
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_format: Option<String>,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
    },
    ToolResult {
        tool_call_id: String,
        output: NativeOutput,
        is_error: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum NativeOutput {
    Text { text: String },
    Json { value: Value },
    Denied { reason: String },
    Error { message: String },
}

fn native(message: &Value) -> Result<NativeMessage, HandlerOutcome> {
    let parsed: NativeMessage =
        serde_json::from_value(message.clone()).map_err(|e| error("history_unreadable", e))?;
    if !["system", "user", "assistant", "tool"].contains(&parsed.role.as_str()) {
        return Err(error("history_unreadable", "unknown runner message role"));
    }
    Ok(parsed)
}

/// Broca serves its native messages, not the retired whole-array CK envelope.
/// Preserve the native shell for unchanged content; authored content cannot
/// inherit cache markers, origin attribution or encrypted reasoning.
pub fn decode_message(
    message: &compact::status::StatusMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    use ck_wire::{
        CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
    };
    let parsed = native(&message.message)?;
    let mut content = Vec::new();
    for block in parsed.content {
        let raw = serde_json::to_value(&block).map_err(transient)?;
        let kind = match block {
            NativeBlock::Text { text } => CkKind::Text { text },
            NativeBlock::Reasoning { text, signature } => CkKind::Reasoning { text, signature },
            NativeBlock::RedactedReasoning { data, .. } => CkKind::RedactedReasoning { data },
            NativeBlock::ToolCall {
                tool_call_id,
                tool_name,
                input,
                ..
            } => CkKind::ToolCall {
                id: tool_call_id,
                name: tool_name,
                input,
                provider_executed: false,
            },
            NativeBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
            } => {
                let kind = match output {
                    NativeOutput::Text { text } => {
                        if is_error {
                            CkOutputKind::ErrorText { text }
                        } else {
                            CkOutputKind::Text { text }
                        }
                    }
                    NativeOutput::Json { value } => {
                        if is_error {
                            CkOutputKind::ErrorJson { value }
                        } else {
                            CkOutputKind::Json { value }
                        }
                    }
                    NativeOutput::Denied { reason } => CkOutputKind::ExecutionDenied {
                        reason: Some(reason),
                    },
                    NativeOutput::Error { message } => CkOutputKind::ErrorText { text: message },
                };
                CkKind::ToolResult {
                    id: tool_call_id,
                    tool_name: String::new(),
                    output: CkToolOutput::bare(kind),
                    provider_executed: false,
                }
            }
        };
        let mut extras = ProviderExtras::new();
        extras.insert(
            "mc-provider".into(),
            BTreeMap::from([("native_block".into(), raw)]),
        );
        content.push(CkWireBlock::with_provider_extras(kind, extras));
    }
    let mut extras = ProviderExtras::new();
    extras.insert(
        "mc-provider".into(),
        BTreeMap::from([("native_message".into(), message.message.clone())]),
    );
    let ck = CkWireMessage::from_parts(parsed.role, content, None, extras, HarnessMeta::default());
    Ok(ck_wire::CkIngressMessage {
        mid: message.mid.clone(),
        ordinal: message.ordinal,
        ck,
    })
}

pub(super) fn encode_message(message: &ck_wire::CkWireMessage) -> Result<Value, HandlerOutcome> {
    use ck_wire::{CkKind, CkOutputKind};
    let mut content = Vec::new();
    for block in &message.content {
        let raw = block
            .provider_extras
            .get("mc-provider")
            .and_then(|v| v.get("native_block"));
        let native = match &block.kind {
            CkKind::Text { text } => json!({"type":"text","text":text}),
            CkKind::Reasoning { text, signature } => {
                let mut value = json!({"type":"reasoning","text":text});
                if let Some(signature) = signature {
                    value["signature"] = json!(signature);
                }
                value
            }
            CkKind::RedactedReasoning { data } => {
                let mut value = json!({"type":"redacted_reasoning","data":data});
                if let Some(format) = raw.and_then(|v| v.get("provider_format")) {
                    value["provider_format"] = format.clone();
                }
                value
            }
            CkKind::ToolCall {
                id, name, input, ..
            } => {
                let mut value =
                    json!({"type":"tool_call","tool_call_id":id,"tool_name":name,"input":input});
                if raw.is_some_and(|v| {
                    v.get("input") == Some(input)
                        && v.get("tool_call_id") == Some(&json!(id))
                        && v.get("tool_name") == Some(&json!(name))
                }) {
                    if let Some(signature) = raw.and_then(|v| v.get("thought_signature")) {
                        value["thought_signature"] = signature.clone();
                    }
                }
                value
            }
            CkKind::ToolResult { id, output, .. } => {
                let is_error = matches!(
                    output.kind,
                    CkOutputKind::ErrorText { .. }
                        | CkOutputKind::ErrorJson { .. }
                        | CkOutputKind::ErrorContent { .. }
                        | CkOutputKind::ExecutionDenied { .. }
                );
                let output = match &output.kind {
                    CkOutputKind::Text { text } => json!({"kind":"text","text":text}),
                    CkOutputKind::ErrorText { text } => {
                        if raw
                            .and_then(|v| v.pointer("/output/kind"))
                            .and_then(Value::as_str)
                            == Some("text")
                        {
                            json!({"kind":"text","text":text})
                        } else {
                            json!({"kind":"error","message":text})
                        }
                    }
                    CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => {
                        json!({"kind":"json","value":value})
                    }
                    CkOutputKind::ExecutionDenied { reason } => {
                        json!({"kind":"denied","reason":reason.as_deref().unwrap_or("denied")})
                    }
                    _ => {
                        return Err(error(
                            "history_unreadable",
                            "Broca does not accept a CK content-array output",
                        ))
                    }
                };
                // Error/denied outputs and their error flag are independent on
                // Broca's wire. An unchanged block retains even a false flag.
                let candidate = json!({"type":"tool_result","tool_call_id":id,"output":output,"is_error":is_error});
                if raw.is_some_and(|v| {
                    v.get("output") == candidate.get("output")
                        && v.get("tool_call_id") == candidate.get("tool_call_id")
                }) {
                    raw.expect("matched native block").clone()
                } else {
                    candidate
                }
            }
            _ => {
                return Err(error(
                    "history_unreadable",
                    "CK block has no Broca-native representation",
                ))
            }
        };
        content.push(native);
    }
    if let Some(original) = message
        .provider_extras
        .get("mc-provider")
        .and_then(|v| v.get("native_message"))
    {
        if original.get("role") == Some(&json!(message.role))
            && original.get("content") == Some(&json!(content))
        {
            return Ok(original.clone());
        }
    }
    Ok(json!({"role":message.role,"content":content}))
}

pub fn encode_view(
    view: &transform::compaction::View,
) -> Result<compact::answer::CompactionMessage, HandlerOutcome> {
    let replacement = view
        .replacement
        .iter()
        .map(encode_message)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(compact::answer::CompactionMessage::new(
        &view.compaction_id,
        view.version,
        compact::answer::Range::new(view.range.from, view.range.to),
        replacement,
    ))
}

pub(super) fn validate_replacement(
    view: &compact::answer::CompactionMessage,
    record: &Record,
    lineage: &str,
) -> Result<(), HandlerOutcome> {
    let originals = record.messages.get(lineage);
    for message in &view.replacement {
        let parsed = native(message)?;
        let carried = originals
            .is_some_and(|entries| entries.values().any(|entry| entry.message == *message));
        if parsed.role == "system" {
            return Err(error("history_unreadable", "replacement_system_message"));
        }
        if !carried && parsed.cache_prefix_blocks.is_some() {
            return Err(error("history_unreadable", "authored_cache_prefix_blocks"));
        }
        if !carried && parsed.origin.is_some() {
            return Err(error("history_unreadable", "authored_origin"));
        }
        if !carried
            && parsed.content.iter().any(|b| {
                matches!(
                    b,
                    NativeBlock::Reasoning {
                        signature: Some(_),
                        ..
                    } | NativeBlock::RedactedReasoning { .. }
                )
            })
        {
            return Err(error("history_unreadable", "authored_signed_reasoning"));
        }
    }
    let mut conversation = view.replacement.clone();
    if let Some(originals) = originals {
        conversation.extend(
            originals
                .range(view.range.to..)
                .map(|(_, entry)| entry.message.clone()),
        );
    }
    let mut pending = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for message in &conversation {
        let parsed = native(message)?;
        if parsed.role == "system" {
            continue;
        }
        if matches!(parsed.role.as_str(), "assistant" | "user") && !pending.is_empty() {
            return Err(error("history_unreadable", "turn_before_tool_result"));
        }
        if parsed.role == "tool" && pending.is_empty() {
            return Err(error("history_unreadable", "orphan_tool_result"));
        }
        let mut results = 0;
        for block in parsed.content {
            match block {
                NativeBlock::ToolCall { tool_call_id, .. } => {
                    if parsed.role != "assistant" || !seen.insert(tool_call_id.clone()) {
                        return Err(error("history_unreadable", "invalid_tool_call"));
                    }
                    pending.insert(tool_call_id);
                }
                NativeBlock::ToolResult { tool_call_id, .. } => {
                    if parsed.role != "tool" || !pending.remove(&tool_call_id) {
                        return Err(error("history_unreadable", "orphan_tool_result"));
                    }
                    results += 1;
                }
                _ => {}
            }
        }
        if parsed.role == "tool" && results == 0 {
            return Err(error("history_unreadable", "tool_message_without_result"));
        }
    }
    if !pending.is_empty() {
        return Err(error("history_unreadable", "missing_tool_result"));
    }
    Ok(())
}

pub(super) fn checked_view(
    view: &transform::compaction::View,
    record: &Record,
) -> Result<compact::answer::CompactionMessage, HandlerOutcome> {
    let answer = encode_view(view)?;
    validate_replacement(&answer, record, &view.range.lineage_id)?;
    Ok(answer)
}
