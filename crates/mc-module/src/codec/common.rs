use serde_json::{json, Value};

use crate::ck_wire::{MediaBlock, MediaKind, OpaqueBlock, ResultBlockKind};

#[derive(Clone, Copy)]
pub(super) enum ToolResultChildAdapter {
    OpenCode,
    Pi,
}

pub(super) fn classify_tool_result_child(
    child: &Value,
    adapter: ToolResultChildAdapter,
) -> ResultBlockKind {
    if child.get("type").and_then(Value::as_str) == Some("text") {
        return match child.get("text").and_then(Value::as_str) {
            Some(text) => ResultBlockKind::Text {
                text: text.to_string(),
            },
            None => opaque_child(child, adapter),
        };
    }

    if is_media_candidate(child, adapter) {
        return match validated_media(child, adapter) {
            Some(media) => ResultBlockKind::Media { media },
            None => opaque_child(child, adapter),
        };
    }

    opaque_child(child, adapter)
}

fn is_media_candidate(child: &Value, adapter: ToolResultChildAdapter) -> bool {
    let typed_media = matches!(
        child.get("type").and_then(Value::as_str),
        Some("image" | "file")
    );
    match adapter {
        ToolResultChildAdapter::OpenCode => {
            typed_media || child.get("mime").is_some() || child.get("mimeType").is_some()
        }
        ToolResultChildAdapter::Pi => typed_media,
    }
}

fn validated_media(child: &Value, adapter: ToolResultChildAdapter) -> Option<MediaBlock> {
    let media_type = match adapter {
        ToolResultChildAdapter::OpenCode => {
            string_field(child, "mime").or_else(|| string_field(child, "mimeType"))
        }
        ToolResultChildAdapter::Pi => {
            string_field(child, "mimeType").or_else(|| string_field(child, "mime"))
        }
    }?;
    let source = if let Some(data) = string_field(child, "data") {
        json!({ "type": "data_base64", "data": data })
    } else {
        let url = string_field(child, "url")?;
        match adapter {
            ToolResultChildAdapter::OpenCode => {
                let prefix = format!("data:{media_type};base64,");
                match url.strip_prefix(&prefix) {
                    Some(data) => json!({ "type": "data_base64", "data": data }),
                    None => json!({ "type": "url", "url": url }),
                }
            }
            ToolResultChildAdapter::Pi => json!({ "type": "url", "url": url }),
        }
    };
    let filename = match adapter {
        ToolResultChildAdapter::OpenCode => {
            string_field(child, "filename").or_else(|| string_field(child, "name"))
        }
        ToolResultChildAdapter::Pi => string_field(child, "filename"),
    };

    Some(MediaBlock {
        kind: media_kind(&media_type),
        media_type,
        filename,
        source,
    })
}

fn opaque_child(child: &Value, adapter: ToolResultChildAdapter) -> ResultBlockKind {
    let fallback_kind = match adapter {
        ToolResultChildAdapter::OpenCode => "attachment",
        ToolResultChildAdapter::Pi => "unknown",
    };
    ResultBlockKind::Opaque {
        opaque: OpaqueBlock {
            source: json!({
                "type": "harness",
                "harness": match adapter {
                    ToolResultChildAdapter::OpenCode => "opencode",
                    ToolResultChildAdapter::Pi => "pi",
                }
            }),
            kind: string_field(child, "type").unwrap_or_else(|| fallback_kind.to_string()),
            raw: child.clone(),
            arc: None,
        },
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
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
