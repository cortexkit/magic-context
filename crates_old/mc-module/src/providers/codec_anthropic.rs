//! The `anthropic-messages` runner schema (llm-runner 0.3.0): an entry body
//! is one Anthropic Messages request message, exactly as the client sent it
//! minus the `cache_control` markers the profile strips.
//!
//! The engine runs these sessions under the Claude Code serializer profile
//! (`SerializerProfile::ClaudeCodeAnthropic`), the same healing and rendering
//! rules the full-array Claude Code route uses. This module only maps the
//! native message to CK blocks and back. Each decoded block keeps its native
//! JSON beside it, and rendering starts from that JSON and writes back only
//! the members the CK block carries, so an unchanged block (a signed
//! `thinking` block and its `signature` included) is served as the runner's
//! own value and an unknown block type is never rewritten.
use super::*;
use ck_wire::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, MediaBlock,
    MediaKind, OpaqueBlock, ProviderExtras,
};

/// Provider-extras namespace holding the native JSON a block or message was
/// decoded from.
const EXTRAS: &str = "mc-anthropic";
const NATIVE_BLOCK: &str = "native_block";
const NATIVE_MESSAGE: &str = "native_message";
const NATIVE_INDEX: &str = "native_index";

fn unreadable(reason: &str) -> HandlerOutcome {
    error("history_unreadable", reason)
}

/// Decode one runner entry. `mid` and `ordinal` come from the runner's read
/// envelope: an Anthropic message carries no id of its own.
pub fn decode_message(
    entry: &codec::InboundMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    let message = &entry.message;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| matches!(*role, "user" | "assistant"))
        .ok_or_else(|| unreadable("anthropic-messages entry needs a user or assistant role"))?;
    let content = match message.get("content") {
        // String content is one text block with no native block of its own;
        // rendering restores the string form from the message.
        Some(Value::String(text)) => vec![CkWireBlock::bare(CkKind::Text { text: text.clone() })],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .enumerate()
            .map(|(index, block)| {
                let kind = decode_block(block)?;
                let mut extras = ProviderExtras::new();
                extras.insert(
                    EXTRAS.into(),
                    BTreeMap::from([
                        (NATIVE_BLOCK.into(), block.clone()),
                        (NATIVE_INDEX.into(), json!(index)),
                    ]),
                );
                Ok(CkWireBlock::with_provider_extras(kind, extras))
            })
            .collect::<Result<Vec<_>, HandlerOutcome>>()?,
        _ => {
            return Err(unreadable(
                "anthropic-messages entry content must be a string or an array",
            ))
        }
    };
    let mut extras = ProviderExtras::new();
    extras.insert(
        EXTRAS.into(),
        BTreeMap::from([(NATIVE_MESSAGE.into(), message.clone())]),
    );
    let meta = HarnessMeta {
        harness_id: Some(entry.mid.clone()),
        ordinal: Some(entry.ordinal),
        ..HarnessMeta::default()
    };
    Ok(ck_wire::CkIngressMessage {
        mid: entry.mid.clone(),
        ordinal: entry.ordinal,
        ck: CkWireMessage::from_parts(role, content, None, extras, meta),
    })
}

fn str_member<'a>(block: &'a Value, key: &str) -> Option<&'a str> {
    block.get(key).and_then(Value::as_str)
}

/// The CK kind for one native content block. A block type the engine has no
/// CK kind for, or a known type in a shape it cannot read, stays opaque.
fn decode_block(block: &Value) -> Result<CkKind, HandlerOutcome> {
    if !block.is_object() {
        return Err(unreadable(
            "anthropic-messages content block must be an object",
        ));
    }
    let kind = match str_member(block, "type") {
        Some("text") if str_member(block, "text").is_some() => CkKind::Text {
            text: str_member(block, "text").unwrap().into(),
        },
        Some("thinking") if str_member(block, "thinking").is_some() => CkKind::Reasoning {
            text: str_member(block, "thinking").unwrap().into(),
            signature: str_member(block, "signature").map(str::to_owned),
        },
        Some("redacted_thinking") if str_member(block, "data").is_some() => {
            CkKind::RedactedReasoning {
                data: str_member(block, "data").unwrap().into(),
            }
        }
        Some("tool_use")
            if str_member(block, "id").is_some() && str_member(block, "name").is_some() =>
        {
            CkKind::ToolCall {
                id: str_member(block, "id").unwrap().into(),
                name: str_member(block, "name").unwrap().into(),
                input: block.get("input").cloned().unwrap_or(Value::Null),
                provider_executed: false,
            }
        }
        Some("tool_result") if str_member(block, "tool_use_id").is_some() => {
            let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
            let content = block.get("content").cloned().unwrap_or(Value::Null);
            let output = match (content, error) {
                (Value::String(text), true) => CkOutputKind::ErrorText { text },
                (Value::String(text), false) => CkOutputKind::Text { text },
                (value, true) => CkOutputKind::ErrorJson { value },
                (value, false) => CkOutputKind::Json { value },
            };
            CkKind::ToolResult {
                id: str_member(block, "tool_use_id").unwrap().into(),
                tool_name: String::new(),
                output: CkToolOutput::bare(output),
                provider_executed: false,
            }
        }
        Some("image") => match image_source(block) {
            Some((media_type, source)) => CkKind::Media(MediaBlock {
                kind: MediaKind::Image,
                media_type,
                filename: None,
                source,
            }),
            None => opaque(block),
        },
        _ => opaque(block),
    };
    Ok(kind)
}

fn opaque(block: &Value) -> CkKind {
    CkKind::Opaque(OpaqueBlock {
        source: json!("anthropic"),
        kind: str_member(block, "type").unwrap_or("unknown").into(),
        raw: block.clone(),
        arc: None,
    })
}

/// An Anthropic image source as the engine's media source: inline base64
/// becomes `data_base64`, a URL stays a `url` source.
fn image_source(block: &Value) -> Option<(String, Value)> {
    let source = block.get("source")?;
    match str_member(source, "type")? {
        "base64" => Some((
            str_member(source, "media_type")?.into(),
            json!({"type":"data_base64","data":str_member(source, "data")?}),
        )),
        "url" => Some((
            str_member(source, "media_type").unwrap_or_default().into(),
            json!({"type":"url","url":str_member(source, "url")?}),
        )),
        _ => None,
    }
}

fn native_block(block: &CkWireBlock) -> Option<&Value> {
    block
        .provider_extras
        .get(EXTRAS)
        .and_then(|extras| extras.get(NATIVE_BLOCK))
}

/// Start from the decoded native block when it has the same native type, so
/// members the CK kind does not model (and the members it does, when they
/// are unchanged) keep the runner's value; otherwise start from an empty
/// block of `kind`.
fn base(raw: Option<&Value>, kind: &str) -> serde_json::Map<String, Value> {
    match raw.and_then(Value::as_object) {
        Some(raw) if raw.get("type").and_then(Value::as_str) == Some(kind) => raw.clone(),
        _ => serde_json::Map::from_iter([("type".to_string(), json!(kind))]),
    }
}

fn encode_block(block: &CkWireBlock) -> Result<Value, HandlerOutcome> {
    let raw = native_block(block);
    let value = match &block.kind {
        CkKind::Text { text } => {
            let mut out = base(raw, "text");
            out.insert("text".into(), json!(text));
            out
        }
        CkKind::Reasoning { text, signature } => {
            let mut out = base(raw, "thinking");
            out.insert("thinking".into(), json!(text));
            match signature {
                Some(signature) => out.insert("signature".into(), json!(signature)),
                None => out.remove("signature"),
            };
            out
        }
        CkKind::RedactedReasoning { data } => {
            let mut out = base(raw, "redacted_thinking");
            out.insert("data".into(), json!(data));
            out
        }
        CkKind::ToolCall {
            id, name, input, ..
        } => {
            let mut out = base(raw, "tool_use");
            out.insert("id".into(), json!(id));
            out.insert("name".into(), json!(name));
            out.insert("input".into(), input.clone());
            out
        }
        CkKind::ToolResult { id, output, .. } => {
            let mut out = base(raw, "tool_result");
            out.insert("tool_use_id".into(), json!(id));
            let (content, error) = match &output.kind {
                CkOutputKind::Text { text } => (json!(text), false),
                CkOutputKind::ErrorText { text } => (json!(text), true),
                CkOutputKind::Json { value } => (value.clone(), false),
                CkOutputKind::ErrorJson { value } => (value.clone(), true),
                CkOutputKind::ExecutionDenied { reason } => {
                    (json!(reason.as_deref().unwrap_or("denied")), true)
                }
                CkOutputKind::Content { .. } | CkOutputKind::ErrorContent { .. } => {
                    return Err(unreadable(
                        "anthropic-messages has no rendering for a CK content-array tool output",
                    ))
                }
            };
            // An absent `content` decodes to a null JSON output; keep it absent.
            if content.is_null() && !out.contains_key("content") {
                out.remove("content");
            } else {
                out.insert("content".into(), content);
            }
            // `is_error` is optional on the wire: written when the result is
            // an error, kept as `false` only where the runner sent it.
            if error {
                out.insert("is_error".into(), json!(true));
            } else if out.contains_key("is_error") {
                out.insert("is_error".into(), json!(false));
            }
            out
        }
        CkKind::Media(media) if media.kind == MediaKind::Image => {
            let mut out = base(raw, "image");
            let source = match media.source.get("type").and_then(Value::as_str) {
                Some("data_base64") => {
                    json!({"type":"base64","media_type":media.media_type,"data":media.source["data"]})
                }
                Some("url") => json!({"type":"url","url":media.source["url"]}),
                _ => {
                    return Err(unreadable(
                        "anthropic-messages image source is not renderable",
                    ))
                }
            };
            // Keep the runner's own source object when it still says the same thing.
            let kept = out.get("source").is_some_and(|old| {
                image_source(&json!({"source":old})) == image_source(&json!({"source":source}))
            });
            if !kept {
                out.insert("source".into(), source);
            }
            out
        }
        CkKind::Media(_) => {
            return Err(unreadable(
                "anthropic-messages renders only image media blocks",
            ))
        }
        CkKind::Opaque(opaque) => return Ok(opaque.raw.clone()),
    };
    Ok(Value::Object(value))
}

/// Render one engine message in the runner's schema. A message the engine
/// left unchanged is the runner's own entry value.
pub fn encode_message(message: &CkWireMessage) -> Result<Value, HandlerOutcome> {
    if !matches!(message.role.as_str(), "user" | "assistant") {
        return Err(unreadable(
            "anthropic-messages has no message role other than user and assistant",
        ));
    }
    let original = message
        .provider_extras
        .get(EXTRAS)
        .and_then(|extras| extras.get(NATIVE_MESSAGE))
        .filter(|original| original.get("role") == Some(&json!(message.role)));
    // A string-content entry renders back as a string while the engine keeps
    // it as one text block.
    if let (Some(Value::String(_)), [block]) = (
        original.and_then(|original| original.get("content")),
        message.content.as_slice(),
    ) {
        if let CkKind::Text { text } = &block.kind {
            let mut out = original.expect("original message").clone();
            out["content"] = json!(text);
            return Ok(out);
        }
    }
    let content = message
        .content
        .iter()
        .map(encode_block)
        .collect::<Result<Vec<_>, _>>()?;
    match original.and_then(Value::as_object) {
        Some(original) => {
            let mut out = original.clone();
            out.insert("content".into(), Value::Array(content));
            Ok(Value::Object(out))
        }
        None => Ok(json!({"role":message.role,"content":content})),
    }
}

/// For each content part of `rendered` (the encoding of `message`), the
/// index of the runner part it was decoded from, or `None` for a part the
/// engine authored. Anthropic content blocks carry no ids, so this is how a
/// kept message's parts are matched to the runner's when the engine removes
/// one (an old thinking block, say) and the rest shift left.
pub fn part_origins(message: &CkWireMessage, rendered: &Value) -> Option<Vec<Option<usize>>> {
    match rendered.get("content")? {
        // A string-content message is its own single part.
        Value::String(_) => Some(vec![Some(0)]),
        Value::Array(parts) if parts.len() == message.content.len() => Some(
            message
                .content
                .iter()
                .map(|block| {
                    block
                        .provider_extras
                        .get(EXTRAS)
                        .and_then(|extras| extras.get(NATIVE_INDEX))
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                })
                .collect(),
        ),
        _ => None,
    }
}

pub fn encode_view(
    view: &transform::compaction::View,
) -> Result<codec::OutboundMessage, HandlerOutcome> {
    let replacement = view
        .replacement
        .iter()
        .map(encode_message)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(codec::OutboundMessage::new(
        &view.compaction_id,
        view.version,
        codec::MessageRange::new(view.range.from, view.range.to),
        replacement,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::codec::Codec;
    use cortexkit_role_llm_runner::serializer_profile;

    /// llm-runner 0.3.0's `serializer-anthropic-messages.json`, copied
    /// unchanged from commons 737490bbe9ee15f3c69c5781e461e6ef4e795dde (the
    /// revision the pinned crate was published from; the crate package does
    /// not ship its vectors).
    const VECTORS: &str =
        include_str!("../../testdata/llm-runner-v1/serializer-anthropic-messages.json");
    const VECTORS_SHA256: &str = "8c7306fcff103ee03e2841c94549b64672eae76d82e0b0efe27be0263e562ff6";

    /// Every entry the vectors define, named, in file order: the stripped
    /// `entry` of each `strip` case and the kept first form of each `resends`
    /// case.
    fn vector_entries() -> Vec<(String, Value)> {
        assert_eq!(crate::sha256_hex(VECTORS.as_bytes()), VECTORS_SHA256);
        let file: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(file["profile"], serializer_profile::ANTHROPIC_MESSAGES);
        let mut entries = Vec::new();
        for group in ["strip", "resends"] {
            for case in file[group].as_array().unwrap() {
                let name = format!("{group}: {}", case["name"].as_str().unwrap());
                entries.push((name, case["entry"].clone()));
            }
        }
        assert_eq!(entries.len(), 6, "the vector file lost or gained a case");
        entries
    }

    fn inbound(entries: &[(String, Value)]) -> Vec<codec::InboundMessage> {
        entries
            .iter()
            .enumerate()
            .map(|(ordinal, (_, message))| codec::InboundMessage {
                ordinal: ordinal as u64,
                mid: format!("m{ordinal}"),
                message: message.clone(),
            })
            .collect()
    }

    fn whole_view(replacement: Vec<CkWireMessage>) -> transform::compaction::View {
        transform::compaction::View {
            compaction_id: "compact".into(),
            version: 1,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 0,
                to: replacement.len() as u64,
            },
            replacement,
        }
    }

    #[test]
    fn every_anthropic_messages_vector_decodes_and_rerenders_byte_identically() {
        let named = vector_entries();
        let entries = inbound(&named);
        let codec =
            Codec::from_params(&json!({"serializer_profile":"anthropic-messages"})).unwrap();
        assert_eq!(codec, Codec::AnthropicMessages);
        assert_eq!(
            codec.serializer_profile(),
            SerializerProfile::ClaudeCodeAnthropic
        );
        for ((name, message), entry) in named.iter().zip(&entries) {
            // A vector entry is already in its final, stripped form.
            assert_eq!(
                &serializer_profile::strip_cache_control(message),
                message,
                "{name}"
            );
            let decoded = codec.decode_message(entry).unwrap();
            assert_eq!(decoded.mid, entry.mid);
            assert_eq!(decoded.ck.meta.ordinal, Some(entry.ordinal));
            assert_eq!(
                bytes(&encode_message(&decoded.ck).unwrap()).unwrap(),
                bytes(message).unwrap(),
                "{name}"
            );
        }
        // The whole transcript through the codec's view rendering.
        let replacement = codec
            .decode_entries(&entries)
            .unwrap()
            .into_iter()
            .map(|ingress| ingress.ck)
            .collect();
        let rendered = codec
            .render_view(&whole_view(replacement), "runner-session", &entries)
            .unwrap();
        assert_eq!(
            bytes(&rendered.replacement).unwrap(),
            bytes(&entries.iter().map(|e| &e.message).collect::<Vec<_>>()).unwrap()
        );
    }

    #[test]
    fn anthropic_blocks_map_to_engine_kinds_and_keep_unknown_blocks_opaque() {
        let named = vector_entries();
        let user = decode_message(&inbound(&named)[0]).unwrap().ck;
        let kinds: Vec<_> = user.content.iter().map(|block| block.kind.tag()).collect();
        assert_eq!(kinds, ["text", "media", "tool_result", "opaque"]);
        let assistant = decode_message(&inbound(&named)[1]).unwrap().ck;
        assert_eq!(
            assistant.content[0].kind,
            CkKind::Reasoning {
                text: "plan".into(),
                signature: Some("sig-1".into())
            }
        );
        assert!(matches!(
            &assistant.content[2].kind,
            CkKind::ToolCall { id, input, .. } if id == "toolu_1" && input["cache_control"]["type"] == "ephemeral"
        ));
        let string = decode_message(&inbound(&named)[2]).unwrap().ck;
        assert_eq!(string.content.len(), 1);
        assert_eq!(
            string.content[0].kind,
            CkKind::Text {
                text: "hello".into()
            }
        );
        for refused in [
            json!({"role":"system","content":"x"}),
            json!({"role":"user"}),
            json!({"role":"user","content":7}),
            json!({"role":"user","content":["not a block"]}),
        ] {
            let entry = codec::InboundMessage {
                ordinal: 0,
                mid: "m".into(),
                message: refused.clone(),
            };
            assert!(decode_message(&entry).is_err(), "{refused}");
        }
    }

    /// An engine edit to one block rewrites only that block's modelled
    /// member: a signed thinking block beside it, and every member the CK
    /// kind does not model, keep the runner's bytes.
    #[test]
    fn an_edited_sibling_leaves_signed_thinking_and_unmodelled_members_untouched() {
        let message = json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"plan","signature":"EqQBCkYIBxgCKkD+/sig=="},
            {"type":"text","text":"old answer","citations":[{"type":"char_location","cited_text":"x"}]},
            {"type":"redacted_thinking","data":"opaque=="},
        ]});
        let entry = codec::InboundMessage {
            ordinal: 4,
            mid: "m4".into(),
            message: message.clone(),
        };
        let mut ck = decode_message(&entry).unwrap().ck;
        ck.content[1].kind = CkKind::Text {
            text: "[dropped]".into(),
        };
        ck.content[1].mark_modified();
        let rendered = encode_message(&ck).unwrap();
        assert_eq!(
            bytes(&rendered["content"][0]).unwrap(),
            bytes(&message["content"][0]).unwrap()
        );
        assert_eq!(
            bytes(&rendered["content"][2]).unwrap(),
            bytes(&message["content"][2]).unwrap()
        );
        assert_eq!(
            rendered["content"][1],
            json!({"type":"text","text":"[dropped]","citations":[{"type":"char_location","cited_text":"x"}]})
        );
        // An engine-authored message has no native copy and gets the plain form.
        let authored = CkWireMessage::from_parts(
            "user",
            vec![CkWireBlock::bare(CkKind::Text {
                text: "history".into(),
            })],
            None,
            ProviderExtras::new(),
            HarnessMeta::default(),
        );
        assert_eq!(
            encode_message(&authored).unwrap(),
            json!({"role":"user","content":[{"type":"text","text":"history"}]})
        );
    }

    #[test]
    fn string_content_and_tool_result_strings_render_back_in_their_own_form() {
        let entry = codec::InboundMessage {
            ordinal: 0,
            mid: "m0".into(),
            message: json!({"role":"user","content":"fix the build"}),
        };
        let mut ck = decode_message(&entry).unwrap().ck;
        assert_eq!(encode_message(&ck).unwrap(), entry.message);
        ck.content[0].kind = CkKind::Text {
            text: "§3§ fix the build".into(),
        };
        assert_eq!(
            encode_message(&ck).unwrap(),
            json!({"role":"user","content":"§3§ fix the build"})
        );
        let result = codec::InboundMessage {
            ordinal: 1,
            mid: "m1".into(),
            message: json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"}]}),
        };
        let mut ck = decode_message(&result).unwrap().ck;
        if let CkKind::ToolResult { output, .. } = &mut ck.content[0].kind {
            output.kind = CkOutputKind::Text {
                text: "[dropped]".into(),
            };
        }
        assert_eq!(
            encode_message(&ck).unwrap(),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"[dropped]"}]})
        );
    }
}
