//! Keep Broca media references native. Text readers see only the marker Broca uses
//! when a provider cannot carry media, never the referenced payload or full digest.
use super::*;
use crate::ck_wire::{CkOutputKind, MediaBlock, MediaKind, ResultBlock, ResultBlockKind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum NativePart {
    Text { text: String },
    Media { media: Value },
}

fn unreadable(member: &str, rule: &str) -> HandlerOutcome {
    error("history_unreadable", format!("{member}: {rule}"))
}

fn constraint() -> HandlerOutcome {
    error(
        "provider_constraint",
        "media reference must equal a captured reference",
    )
}

pub(super) fn decode_ref(value: &Value) -> Result<MediaBlock, HandlerOutcome> {
    let object = value
        .as_object()
        .ok_or_else(|| unreadable("media", "must be an object"))?;
    for member in object.keys() {
        if ![
            "type",
            "kind",
            "mime",
            "byte_size",
            "sha256",
            "width",
            "height",
        ]
        .contains(&member.as_str())
        {
            return Err(unreadable(member, "unknown media member"));
        }
    }
    let string = |member: &str| {
        value
            .get(member)
            .and_then(Value::as_str)
            .ok_or_else(|| unreadable(member, "required string"))
    };
    let kind_name = string("kind")?;
    let kind = match kind_name {
        "image" => MediaKind::Image,
        "document" => MediaKind::Document,
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        _ => return Err(unreadable("kind", "unknown media kind")),
    };
    let mime = string("mime")?;
    let size = value
        .get("byte_size")
        .and_then(Value::as_u64)
        .ok_or_else(|| unreadable("byte_size", "required u64"))?;
    let sha = string("sha256")?;
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(unreadable("sha256", "must be 64 lowercase hex characters"));
    }
    for member in ["width", "height"] {
        if kind == MediaKind::Image {
            if value
                .get(member)
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .is_none()
            {
                return Err(unreadable(member, "image requires u32"));
            }
        } else if value.get(member).is_some() {
            return Err(unreadable(member, "only permitted on image"));
        }
    }
    Ok(MediaBlock {
        kind,
        media_type: mime.into(),
        filename: None,
        source: json!({"broca_media_marker": format!("[media not shown: kind={kind_name} mime={mime} bytes={size} sha256={} reason=carrier]", &sha[..12])}),
    })
}

pub(super) fn validate_block(block: &Value) -> Result<(), HandlerOutcome> {
    if block["type"] == "media" {
        decode_ref(block)?;
    }
    if block["type"] == "media_ref" {
        decode_descriptor(block)?;
    }
    if block["type"] == "tool_result"
        && block.pointer("/output/kind").and_then(Value::as_str) == Some("parts")
    {
        let output = &block["output"];
        let parsed: Vec<NativePart> = serde_json::from_value(
            output
                .get("parts")
                .cloned()
                .ok_or_else(|| unreadable("parts", "required array"))?,
        )
        .map_err(|e| unreadable("parts", &e.to_string()))?;
        for part in &parsed {
            if let NativePart::Media { media } = part {
                if media.get("type").is_some_and(|kind| kind != "media_ref") {
                    return Err(unreadable("type", "unknown media member"));
                }
                decode_ref(media)?;
            }
        }
    }
    Ok(())
}

pub(super) fn decode_descriptor(value: &Value) -> Result<MediaBlock, HandlerOutcome> {
    if value.get("part").and_then(Value::as_str).is_none() {
        return Err(unreadable("part", "media_ref requires string"));
    }
    let mut media = value.clone();
    media
        .as_object_mut()
        .ok_or_else(|| unreadable("media_ref", "must be object"))?
        .remove("part");
    decode_ref(&media)
}

fn extras(part: Value) -> crate::ck_wire::ProviderExtras {
    BTreeMap::from([(
        "mc-provider".into(),
        BTreeMap::from([("native_part".into(), part)]),
    )])
}

pub(super) fn decode_parts(
    parts: Vec<NativePart>,
    is_error: bool,
) -> Result<CkOutputKind, HandlerOutcome> {
    let blocks = parts
        .into_iter()
        .map(|part| {
            let raw = serde_json::to_value(&part).map_err(transient)?;
            let kind = match part {
                NativePart::Text { text } => ResultBlockKind::Text { text },
                NativePart::Media { media } => ResultBlockKind::Media {
                    media: decode_ref(&media)?,
                },
            };
            Ok(ResultBlock {
                kind,
                provider_extras: extras(raw),
            })
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    Ok(if is_error {
        CkOutputKind::ErrorContent { blocks }
    } else {
        CkOutputKind::Content { blocks }
    })
}

pub(crate) fn marker(media: &MediaBlock) -> Option<&str> {
    media.source.get("broca_media_marker")?.as_str()
}

/// A parts output uses Broca's media-off projection for every text consumer.
/// The per-part native shell distinguishes it from other codecs' content arrays.
pub(crate) fn parts_text(output: &CkOutputKind) -> Option<String> {
    let (CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks }) = output else {
        return None;
    };
    if !blocks.is_empty()
        && !blocks.iter().any(|block| {
            block
                .provider_extras
                .get("mc-provider")
                .is_some_and(|e| e.contains_key("native_part"))
        })
    {
        return None;
    }
    blocks
        .iter()
        .map(|block| match &block.kind {
            ResultBlockKind::Text { text } => Some(text.as_str()),
            ResultBlockKind::Media { media } => marker(media),
            ResultBlockKind::Opaque { .. } => None,
        })
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join("\n"))
}

pub(crate) fn prepend_parts_tag(output: &mut CkOutputKind, number: i64) -> Option<bool> {
    parts_text(output)?;
    let (CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks }) = output else {
        return None;
    };
    for block in blocks.iter_mut() {
        if let ResultBlockKind::Text { text } = &mut block.kind {
            let next = format!("§{number}§ {text}");
            *text = next;
            return Some(true);
        }
    }
    if blocks.is_empty() {
        return Some(false);
    }
    let label = if blocks.iter().all(|block| matches!(&block.kind, ResultBlockKind::Media { media } if media.kind == MediaKind::Image)) { "[image]" } else { "[media]" };
    let text = format!("§{number}§ {label}");
    blocks.insert(
        0,
        ResultBlock {
            kind: ResultBlockKind::Text { text: text.clone() },
            provider_extras: extras(json!({"kind":"text","text":text})),
        },
    );
    Some(true)
}

pub(super) fn encode_parts(blocks: &[ResultBlock]) -> Result<Value, HandlerOutcome> {
    let parts = blocks
        .iter()
        .map(|block| {
            let raw = block
                .provider_extras
                .get("mc-provider")
                .and_then(|e| e.get("native_part"));
            match &block.kind {
                ResultBlockKind::Text { text } => Ok(json!({"kind":"text","text":text})),
                ResultBlockKind::Media { media } => {
                    let raw = raw.ok_or_else(constraint)?;
                    if raw["kind"] != "media"
                        || decode_ref(&raw["media"]).map_err(|_| constraint())? != *media
                    {
                        return Err(constraint());
                    }
                    Ok(raw.clone())
                }
                ResultBlockKind::Opaque { .. } => Err(constraint()),
            }
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    Ok(json!({"kind":"parts","parts":parts}))
}

/// A changed tool-result part must be native content, not a read descriptor.
/// Unchanged descriptor values are kept verbatim and never sent as part edits.
pub(super) fn inline_parts(output: &mut Value) {
    if output["kind"] != "parts" {
        return;
    }
    for part in output["parts"].as_array_mut().into_iter().flatten() {
        if part["kind"] == "media" && part["media"]["type"] == "media_ref" {
            part["media"]
                .as_object_mut()
                .expect("media reference")
                .remove("type");
        }
    }
}

/// Reproduce Broca's tag-only rendering so it is not mistaken for a content edit.
pub(crate) fn render_native_parts(part: &Value, number: Option<u64>) -> Option<Value> {
    if part["type"] != "tool_result" || part.pointer("/output/kind")?.as_str()? != "parts" {
        return None;
    }
    let Some(number) = number else {
        return Some(part.clone());
    };
    let parts: Vec<NativePart> = serde_json::from_value(part["output"]["parts"].clone()).ok()?;
    let mut output = decode_parts(parts, false).ok()?;
    prepend_parts_tag(&mut output, i64::try_from(number).ok()?)?;
    let CkOutputKind::Content { blocks } = output else {
        return None;
    };
    let mut rendered = part.clone();
    rendered["output"] = encode_parts(&blocks).ok()?;
    inline_parts(&mut rendered["output"]);
    Some(rendered)
}

pub(super) fn encode_block(
    media: &MediaBlock,
    raw: Option<&Value>,
) -> Result<Value, HandlerOutcome> {
    let raw = raw.ok_or_else(constraint)?;
    let captured = match raw["type"].as_str() {
        Some("media") => decode_ref(raw).map_err(|_| constraint())?,
        Some("media_ref") => decode_descriptor(raw).map_err(|_| constraint())?,
        _ => return Err(constraint()),
    };
    if captured != *media {
        return Err(constraint());
    }
    Ok(raw.clone())
}

fn references(message: &Value) -> Vec<Value> {
    let mut refs = Vec::new();
    for block in message["content"].as_array().into_iter().flatten() {
        if block["type"] == "media" || block["type"] == "media_ref" {
            let mut media = block.clone();
            media.as_object_mut().expect("media object").remove("type");
            media.as_object_mut().expect("media object").remove("part");
            refs.push(media);
        }
        if block["type"] == "tool_result"
            && block.pointer("/output/kind").and_then(Value::as_str) == Some("parts")
        {
            for part in block["output"]["parts"].as_array().into_iter().flatten() {
                if part["kind"] == "media" {
                    let mut media = part["media"].clone();
                    if media["type"] == "media_ref" {
                        media
                            .as_object_mut()
                            .expect("media reference")
                            .remove("type");
                    }
                    refs.push(media);
                }
            }
        }
    }
    refs
}

pub(super) fn validate_message(
    message: &Value,
    original: Option<&Value>,
) -> Result<(), HandlerOutcome> {
    let captured = original.map(references).unwrap_or_default();
    if references(message)
        .iter()
        .any(|reference| !captured.contains(reference))
    {
        return Err(constraint());
    }
    Ok(())
}

/// Check references against the source messages, not extras retained by the edited view.
pub(super) fn validate_view<'a>(
    outbound: &codec::OutboundMessage,
    view: &transform::compaction::View,
    sources: impl Iterator<Item = (u64, &'a Value)>,
) -> Result<(), HandlerOutcome> {
    let sources: Vec<_> = sources.collect();
    let captured: Vec<_> = sources
        .iter()
        .flat_map(|(_, message)| references(message))
        .collect();
    for (message, ck) in outbound.replacement.iter().zip(&view.replacement) {
        if references(message)
            .iter()
            .any(|reference| !captured.contains(reference))
        {
            return Err(constraint());
        }
        if let Some((_, original)) = sources
            .iter()
            .find(|(ordinal, _)| Some(*ordinal) == ck.meta.ordinal)
        {
            for (block, retained) in message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .zip(&ck.content)
            {
                let refs = references(&json!({"content":[block]}));
                if refs.is_empty() {
                    continue;
                }
                let raw = retained
                    .provider_extras
                    .get("mc-provider")
                    .and_then(|extras| extras.get("native_block"))
                    .ok_or_else(constraint)?;
                if !original["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.contains(raw))
                {
                    return Err(constraint());
                }
                let captured_part = references(&json!({"content":[raw]}));
                if refs
                    .iter()
                    .any(|reference| !captured_part.contains(reference))
                {
                    return Err(constraint());
                }
                if block["type"] == "tool_result" {
                    if block["tool_call_id"] != raw["tool_call_id"] {
                        return Err(error(
                            "provider_constraint",
                            "media tool_call_id must retain its captured pair",
                        ));
                    }
                    let id = &block["tool_call_id"];
                    let call_is_covered = sources.iter().any(|(ordinal, source)| {
                        *ordinal >= view.range.from
                            && *ordinal < view.range.to
                            && source["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|block| {
                                    block["type"] == "tool_call" && &block["tool_call_id"] == id
                                })
                    });
                    if call_is_covered
                        && !outbound.replacement.iter().any(|message| {
                            message["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|block| {
                                    block["type"] == "tool_call" && &block["tool_call_id"] == id
                                })
                        })
                    {
                        return Err(error(
                            "provider_constraint",
                            "media tool_result requires its tool_call pair",
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn encode_prepared_view(
    view: &transform::compaction::View,
    request: &TransformRequest,
) -> Result<codec::OutboundMessage, HandlerOutcome> {
    let encoded = codec::encode_view(view)?;
    validate_view(
        &encoded,
        view,
        request.messages.iter().filter_map(|message| {
            message
                .ck
                .provider_extras
                .get("mc-provider")
                .and_then(|e| e.get("native_message"))
                .map(|native| (message.ordinal, native))
        }),
    )?;
    Ok(encoded)
}
