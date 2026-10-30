//! Keep Broca media references native. Text readers see only the marker Broca uses
//! when a provider cannot carry media, never the referenced payload or full digest.
use super::*;
use crate::ck_wire::{CkOutputKind, MediaBlock, MediaKind, ResultBlock, ResultBlockKind};
use cortexkit_role_llm_runner::tags::{
    image_label, media_label, numbered_block_index, render_counted_text, tool_result_kind,
    PartKind, ToolResultBlock,
};
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
        "media occurrence must retain its captured reference and position",
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
        } else if value.get(member).is_some_and(|value| !value.is_null()) {
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
    let number = u64::try_from(number).ok()?;
    let (kind, index) = parts_numbering(blocks);
    if let Some(index) = index {
        let ResultBlockKind::Text { text } = &mut blocks[index].kind else {
            return None;
        };
        let next = render_counted_text(number, text);
        let changed = *text != next;
        *text = next;
        return Some(changed);
    }
    let Some(text) = numbered_media_label(kind, number) else {
        return Some(false);
    };
    blocks.insert(
        0,
        ResultBlock {
            kind: ResultBlockKind::Text { text: text.clone() },
            provider_extras: extras(json!({"kind":"text","text":text})),
        },
    );
    Some(true)
}

fn parts_numbering(blocks: &[ResultBlock]) -> (PartKind, Option<usize>) {
    let parts: Vec<_> = blocks
        .iter()
        .map(|block| match &block.kind {
            ResultBlockKind::Text { text } => ToolResultBlock::Text(text),
            ResultBlockKind::Media { media } if media.kind == MediaKind::Image => {
                ToolResultBlock::Image
            }
            _ => ToolResultBlock::Media,
        })
        .collect();
    (tool_result_kind(&parts), numbered_block_index(&parts))
}

fn numbered_media_label(kind: PartKind, number: u64) -> Option<String> {
    match kind {
        PartKind::ToolResultImageOnly => Some(image_label(number)),
        PartKind::ToolResultMediaOnly => Some(media_label(number)),
        _ => None,
    }
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

fn media_occurrences(block: &Value) -> Vec<(usize, Value)> {
    let normalize = |reference: &Value| {
        let mut reference = reference.clone();
        if let Some(object) = reference.as_object_mut() {
            object.remove("type");
            object.remove("part");
        }
        reference
    };
    if matches!(block["type"].as_str(), Some("media" | "media_ref")) {
        return vec![(0, normalize(block))];
    }
    if block["type"] == "tool_result"
        && block.pointer("/output/kind").and_then(Value::as_str) == Some("parts")
    {
        return block["output"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, part)| part["kind"] == "media")
            .map(|(index, part)| (index, normalize(&part["media"])))
            .collect();
    }
    Vec::new()
}

fn has_inserted_media_label(original: &Value, changed: &Value) -> bool {
    let Some(before) = original.pointer("/output/parts").and_then(Value::as_array) else {
        return false;
    };
    let Some(after) = changed.pointer("/output/parts").and_then(Value::as_array) else {
        return false;
    };
    if after.len() != before.len() + 1 || after[0]["kind"] != "text" {
        return false;
    }
    let Some(text) = after[0]["text"].as_str() else {
        return false;
    };
    let Some((tag, _)) = text.split_once(' ') else {
        return false;
    };
    let Some(number) = cortexkit_role_llm_runner::tags::parse_tag(tag) else {
        return false;
    };
    let Ok(parts) = serde_json::from_value::<Vec<NativePart>>(Value::Array(before.clone())) else {
        return false;
    };
    let Ok(CkOutputKind::Content { blocks }) = decode_parts(parts, false) else {
        return false;
    };
    let (kind, index) = parts_numbering(&blocks);
    index.is_none() && numbered_media_label(kind, number).as_deref() == Some(text)
}

fn validate_block_occurrences(changed: &Value, original: &Value) -> Result<(), HandlerOutcome> {
    let before = media_occurrences(original);
    let after = media_occurrences(changed);
    if before.is_empty() && after.is_empty() {
        return Ok(());
    }
    if original["type"] == "tool_result" {
        if changed["type"] != "tool_result" || changed["tool_call_id"] != original["tool_call_id"] {
            return Err(error(
                "provider_constraint",
                "media tool_call_id must retain its captured pair",
            ));
        }
        // Dropping the complete output is allowed; deleting individual media children is not.
        if changed.pointer("/output/kind").and_then(Value::as_str) == Some("text")
            && after.is_empty()
        {
            return Ok(());
        }
        if changed.pointer("/output/kind").and_then(Value::as_str) != Some("parts") {
            return Err(constraint());
        }
    } else if !matches!(changed["type"].as_str(), Some("media" | "media_ref")) {
        return Err(constraint());
    }
    if before == after {
        return Ok(());
    }
    // Broca may insert one numbered label before an otherwise media-only output.
    if has_inserted_media_label(original, changed)
        && before
            .iter()
            .map(|(index, reference)| (index + 1, reference))
            .eq(after.iter().map(|(index, reference)| (*index, reference)))
    {
        return Ok(());
    }
    Err(constraint())
}

fn message_media_origins(
    message: &Value,
    ck: &crate::ck_wire::CkWireMessage,
    original: Option<&Value>,
) -> Result<Vec<usize>, HandlerOutcome> {
    let mut origins = Vec::new();
    for (block, retained) in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(&ck.content)
    {
        let extras = retained.provider_extras.get("mc-provider");
        let raw = extras.and_then(|extras| extras.get("native_block"));
        let remains = !media_occurrences(block).is_empty();
        if !remains && raw.is_none_or(|raw| media_occurrences(raw).is_empty()) {
            continue;
        }
        let raw = raw.ok_or_else(constraint)?;
        validate_block_occurrences(block, raw)?;
        if !remains {
            continue;
        }
        let index = extras
            .and_then(|extras| extras.get("native_index"))
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(constraint)?;
        let captured = original
            .and_then(|message| message["content"].as_array())
            .and_then(|blocks| blocks.get(index))
            .ok_or_else(constraint)?;
        if captured != raw || origins.last().is_some_and(|previous| *previous >= index) {
            return Err(constraint());
        }
        validate_block_occurrences(block, captured)?;
        origins.push(index);
    }
    Ok(origins)
}

pub(super) fn validate_message(
    message: &Value,
    ck: &crate::ck_wire::CkWireMessage,
    original: Option<&Value>,
) -> Result<(), HandlerOutcome> {
    message_media_origins(message, ck, original).map(|_| ())
}

/// Check each surviving occurrence against its source message, block, and child position.
pub(super) fn validate_view<'a>(
    outbound: &codec::OutboundMessage,
    view: &transform::compaction::View,
    sources: impl Iterator<Item = (u64, &'a Value)>,
) -> Result<(), HandlerOutcome> {
    let sources: Vec<_> = sources.collect();
    let mut previous = None;
    for (message, ck) in outbound.replacement.iter().zip(&view.replacement) {
        let source = sources
            .iter()
            .find(|(ordinal, _)| Some(*ordinal) == ck.meta.ordinal);
        let origins = message_media_origins(message, ck, source.map(|(_, original)| *original))?;
        for index in origins {
            let origin = (source.ok_or_else(constraint)?.0, index);
            if previous.is_some_and(|previous| previous >= origin) {
                return Err(constraint());
            }
            previous = Some(origin);
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_result" || media_occurrences(block).is_empty() {
                continue;
            }
            let id = &block["tool_call_id"];
            let call_is_covered = sources.iter().any(|(ordinal, source)| {
                *ordinal >= view.range.from
                    && *ordinal < view.range.to
                    && source["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|block| block["type"] == "tool_call" && &block["tool_call_id"] == id)
            });
            if call_is_covered
                && !outbound.replacement.iter().any(|message| {
                    message["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|block| block["type"] == "tool_call" && &block["tool_call_id"] == id)
                })
            {
                return Err(error(
                    "provider_constraint",
                    "media tool_result requires its tool_call pair",
                ));
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
