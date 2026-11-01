//! Payloads a runner serves as descriptors.
//!
//! ck-mc reads its async conversations with `session.read {media:
//! "descriptors"}` (compaction-provider §3). The runner then replaces every
//! byte-backed image, file, PDF or audio payload, and every other payload over
//! `PART_INLINE_MAX` (256 KiB), with a ref in place: `media_ref`, `text_ref`,
//! `args_ref` or `reasoning_ref` (llm-runner §4.2). No ck-mc path needs the
//! bytes behind a ref:
//!
//! - **Identity** comes from the runner's served `digest` and `part_digests`,
//!   never from hashing what was read.
//! - **Sizing** comes from the ref itself: an image's pixel dimensions, a
//!   text's byte size and carried head, other payloads' byte size
//!   ([`reference_tokens`]).
//! - **The engine and the summarizer** see a text ref as its carried head and a
//!   notice of how much more there is ([`expose`]). Media refs stay as written
//!   and decode as opaque parts, which every codec renders back byte for byte.
//! - **Views** never send a ref or its stand-in to the model: an edit to a
//!   part holding one is sent only when the new bytes hold neither
//!   (`providers::async_provider::ranges`), and bytes ck-mc authors drop refs
//!   ([`without_refs`]).
use cortexkit_role_llm_runner::read::descriptors::Reference;
use serde_json::Value;

pub(crate) const MEDIA_REF: &str = "media_ref";
pub(crate) const TEXT_REF: &str = "text_ref";
pub(crate) const ARGS_REF: &str = "args_ref";
pub(crate) const REASONING_REF: &str = "reasoning_ref";

/// How ck-mc marks where its view of a large text stops. The engine and the
/// summarizer see the carried head followed by this notice; sizing reads the
/// numbers back from it ([`text_tokens`]).
const NOTICE_OPEN: &str = "\n[ck-mc: text continues; ";
const NOTICE_CLOSE: &str = " bytes shown]";

/// Average bytes per token assumed when no text is available to measure:
/// the ratio the plugin's own fallback estimator uses.
const BYTES_PER_TOKEN: u64 = 4;

/// The ref `value` is, when it is one.
pub(crate) fn reference(value: &Value) -> Option<Reference> {
    let kind = value.get("type")?.as_str()?;
    if !matches!(kind, MEDIA_REF | TEXT_REF | ARGS_REF | REASONING_REF) {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}

/// Whether `value` holds a ref anywhere.
pub(crate) fn holds_descriptor(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, MEDIA_REF | TEXT_REF | ARGS_REF | REASONING_REF))
                || map.values().any(holds_descriptor)
        }
        Value::Array(items) => items.iter().any(holds_descriptor),
        _ => false,
    }
}

/// Whether `value` holds a ref or ck-mc's stand-in for one. Bytes like these
/// must never reach the model in a view: they are not the runner's content.
pub(crate) fn holds_stand_in(value: &Value) -> bool {
    holds_descriptor(value)
        || match value {
            Value::String(text) => text.contains(NOTICE_OPEN),
            Value::Object(map) => map.values().any(holds_stand_in),
            Value::Array(items) => items.iter().any(holds_stand_in),
            _ => false,
        }
}

/// The text the engine and the summarizer see for a large text: the head the
/// runner carried, then a notice of the whole size.
pub(crate) fn text_stand_in(head: &str, byte_size: u64, char_count: u64) -> String {
    format!(
        "{head}{NOTICE_OPEN}{byte_size} bytes and {char_count} characters in all, the first {}{NOTICE_CLOSE}",
        head.len()
    )
}

/// The text the engine sees for reasoning the runner described.
fn reasoning_stand_in(byte_size: u64) -> String {
    format!("[ck-mc: reasoning of {byte_size} bytes not shown]")
}

/// `message` with every `text_ref` and `reasoning_ref` replaced by the text
/// ck-mc's engine and summarizer see for it, or `None` when it holds neither.
/// Media and argument refs stay as written: they sit where the schema has an
/// object, and every codec carries such a part through unchanged.
pub(crate) fn expose(message: &Value) -> Option<Value> {
    fn walk(value: &mut Value, changed: &mut bool) {
        match reference(value) {
            Some(Reference::TextRef {
                byte_size,
                char_count,
                head,
                ..
            }) => {
                *value = Value::String(text_stand_in(&head, byte_size, char_count));
                *changed = true;
                return;
            }
            Some(Reference::ReasoningRef { byte_size, .. }) => {
                *value = Value::String(reasoning_stand_in(byte_size));
                *changed = true;
                return;
            }
            Some(_) => return,
            None => {}
        }
        match value {
            Value::Object(map) => map.values_mut().for_each(|child| walk(child, changed)),
            Value::Array(items) => items.iter_mut().for_each(|child| walk(child, changed)),
            _ => {}
        }
    }
    if !holds_descriptor(message) {
        return None;
    }
    let mut exposed = message.clone();
    let mut changed = false;
    walk(&mut exposed, &mut changed);
    changed.then_some(exposed)
}

/// `value` with no ref left, for bytes ck-mc authors itself (a fold of
/// covered messages): a ref that is a whole block in an array is left out,
/// and one in a member's place becomes text saying what it stood for (an
/// argument ref, an empty object, since tool inputs are objects). A large text
/// already reached the engine as its stand-in and stays that text.
pub(crate) fn without_refs(value: &Value) -> Value {
    fn stand_in(reference: &Reference) -> Value {
        match reference {
            Reference::MediaRef {
                kind, byte_size, ..
            } => Value::String(format!("[ck-mc: {kind} of {byte_size} bytes not shown]")),
            Reference::TextRef {
                byte_size,
                char_count,
                head,
                ..
            } => Value::String(text_stand_in(head, *byte_size, *char_count)),
            Reference::ReasoningRef { byte_size, .. } => {
                Value::String(reasoning_stand_in(*byte_size))
            }
            _ => Value::Object(Default::default()),
        }
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .filter(|item| reference(item).is_none())
                .map(without_refs)
                .collect(),
        ),
        Value::Object(map) => match reference(value) {
            Some(reference) => stand_in(&reference),
            None => Value::Object(
                map.iter()
                    .map(|(key, child)| (key.clone(), without_refs(child)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

/// Tokens the payload behind a ref costs the model.
///
/// - An image: from its pixel dimensions by the rule standalone applies on
///   every provider (`image_tokens::image_tokens_for_dimensions`), or
///   standalone's fallback when the runner could not read the header.
/// - A text: the carried head's token count, scaled to the whole byte size.
/// - Anything else: its byte size at four bytes a token; for other media
///   that is the decoded size, so it never counts base64's extra third.
pub(crate) fn reference_tokens(reference: &Reference) -> usize {
    match reference {
        Reference::MediaRef {
            kind,
            width,
            height,
            ..
        } if kind == "image" => match (width, height) {
            (Some(width), Some(height)) => {
                crate::image_tokens::image_tokens_for_dimensions(*width, *height) as usize
            }
            _ => crate::image_tokens::IMAGE_FALLBACK_TOKENS as usize,
        },
        Reference::TextRef {
            byte_size, head, ..
        } => scaled_text_tokens(head, *byte_size),
        other => other.byte_size().div_ceil(BYTES_PER_TOKEN) as usize,
    }
}

/// Tokens of a text of `byte_size` bytes that begins with `head`.
fn scaled_text_tokens(head: &str, byte_size: u64) -> usize {
    if head.is_empty() {
        return byte_size.div_ceil(BYTES_PER_TOKEN) as usize;
    }
    let head_tokens = mc_tokenizer::estimate_tokens(head) as u64;
    (head_tokens.saturating_mul(byte_size) / head.len() as u64).max(head_tokens) as usize
}

/// Tokens of a text the engine sees: the text tokenizer's count, except that
/// a large text's stand-in counts as the whole text it stands for.
pub(crate) fn text_tokens(text: &str) -> usize {
    let Some(open) = text.rfind(NOTICE_OPEN) else {
        return mc_tokenizer::estimate_tokens(text);
    };
    let notice = &text[open + NOTICE_OPEN.len()..];
    let Some(numbers) = notice.strip_suffix(NOTICE_CLOSE) else {
        return mc_tokenizer::estimate_tokens(text);
    };
    let fields = numbers
        .split(|c: char| !c.is_ascii_digit())
        .filter(|field| !field.is_empty())
        .filter_map(|field| field.parse::<u64>().ok())
        .collect::<Vec<_>>();
    let [byte_size, _chars, shown] = fields[..] else {
        return mc_tokenizer::estimate_tokens(text);
    };
    let Some(head) = open
        .checked_sub(shown as usize)
        .and_then(|start| text.get(start..open))
    else {
        return mc_tokenizer::estimate_tokens(text);
    };
    mc_tokenizer::estimate_tokens(&text[..open - head.len()]) + scaled_text_tokens(head, byte_size)
}

/// Tokens of a JSON value as the model sees it: each ref counts as the
/// payload it stands for, the rest by the text tokenizer over its JSON.
pub(crate) fn value_tokens(value: &Value) -> usize {
    fn strip(value: &mut Value, refs: &mut usize) {
        if let Some(reference) = reference(value) {
            *refs += reference_tokens(&reference);
            *value = Value::Null;
            return;
        }
        match value {
            Value::String(text) if text.contains(NOTICE_OPEN) => {
                *refs += text_tokens(text);
                *value = Value::Null;
            }
            Value::Object(map) => map.values_mut().for_each(|child| strip(child, refs)),
            Value::Array(items) => items.iter_mut().for_each(|child| strip(child, refs)),
            _ => {}
        }
    }
    if let Some(reference) = reference(value) {
        return reference_tokens(&reference);
    }
    if !holds_stand_in(value) {
        return mc_tokenizer::estimate_tokens(&serde_json::to_string(value).unwrap_or_default());
    }
    let mut stripped = value.clone();
    let mut refs = 0;
    strip(&mut stripped, &mut refs);
    refs + mc_tokenizer::estimate_tokens(&serde_json::to_string(&stripped).unwrap_or_default())
}

/// The tokens of a decoded block that holds a ref or its stand-in, or `None`
/// for a block that holds neither, which callers size as before.
pub(crate) fn block_tokens(kind: &mc_store::CkKind) -> Option<usize> {
    use mc_store::{CkKind, CkOutputKind};
    match kind {
        CkKind::Opaque(opaque) if holds_descriptor(&opaque.raw) => Some(value_tokens(&opaque.raw)),
        CkKind::Text { text } if text.contains(NOTICE_OPEN) => Some(text_tokens(text)),
        CkKind::ToolResult { output, .. } => match &output.kind {
            CkOutputKind::Text { text } | CkOutputKind::ErrorText { text }
                if text.contains(NOTICE_OPEN) =>
            {
                Some(text_tokens(text))
            }
            CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value }
                if holds_stand_in(value) =>
            {
                Some(value_tokens(value))
            }
            _ => None,
        },
        CkKind::ToolCall { input, .. } if holds_descriptor(input) => Some(value_tokens(input)),
        _ => None,
    }
}

/// Whether `value` is a `media_ref` the runner served in place of a part.
pub(crate) fn is_media_ref(value: &Value) -> bool {
    matches!(reference(value), Some(Reference::MediaRef { .. }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn image(width: Option<u64>, height: Option<u64>) -> Value {
        let mut value = json!({"type":"media_ref","part":"0","kind":"image","mime":"image/png",
            "byte_size":3,"sha256":"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"});
        if let (Some(width), Some(height)) = (width, height) {
            value["width"] = json!(width);
            value["height"] = json!(height);
        }
        value
    }

    /// A described image costs what its dimensions say, by standalone's rule
    /// (`image-token-estimate.ts`: one token per 750 pixels, at most 4,500),
    /// and standalone's 1,200-token fallback without dimensions; never the few
    /// tokens of the ref's own JSON.
    #[test]
    fn image_refs_are_sized_from_their_dimensions() {
        let sized = |value: &Value| reference_tokens(&reference(value).unwrap());
        assert_eq!(sized(&image(Some(1920), Some(1080))), 2765);
        assert_eq!(sized(&image(Some(10_000), Some(10_000))), 4500);
        assert_eq!(sized(&image(Some(1), Some(1))), 1);
        assert_eq!(sized(&image(None, None)), 1200);
        let parity: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/image-token-parity.json")).unwrap();
        let png = parity
            .iter()
            .find(|case| case["name"] == "png-1920x1080")
            .unwrap();
        assert_eq!(
            sized(&image(Some(1920), Some(1080))) as u64,
            png["tokens"].as_u64().unwrap()
        );
        // Nested in a tool result the image still counts by its dimensions.
        let result = json!([{"type":"text","text":"screenshot"}, image(Some(1920), Some(1080))]);
        assert!(value_tokens(&result) >= 2765);
        let block = mc_store::CkKind::Opaque(mc_store::OpaqueBlock {
            source: json!("anthropic"),
            kind: "media_ref".into(),
            raw: image(Some(1920), Some(1080)),
            arc: None,
        });
        assert_eq!(block_tokens(&block), Some(2765));
    }

    /// Bytes ck-mc authors carry no ref: a whole-block ref is left out, a
    /// member's ref becomes text, and nothing else changes.
    #[test]
    fn authored_bytes_never_carry_a_ref() {
        let message = json!({"role":"user","content":[
            {"type":"text","text":"see"},
            image(Some(2), Some(2)),
            {"type":"tool_result","tool_use_id":"c","content":[image(None, None)]},
            {"type":"tool_use","id":"c","name":"read","input":{"type":"args_ref","byte_size":9,
                "sha256":"0".repeat(64),"name":"read"}}
        ]});
        let clean = without_refs(&message);
        assert!(!holds_descriptor(&clean), "{clean}");
        assert_eq!(clean["content"].as_array().unwrap().len(), 3);
        assert_eq!(clean["content"][0], json!({"type":"text","text":"see"}));
        assert_eq!(clean["content"][1]["content"], json!([]));
        assert_eq!(clean["content"][2]["input"], json!({}));
        let plain = json!({"role":"user","content":"plain"});
        assert_eq!(without_refs(&plain), plain);
    }

    /// A large text counts as its whole size, scaled from the carried head,
    /// and its stand-in round-trips through `text_tokens`.
    #[test]
    fn large_text_is_sized_from_its_descriptor() {
        let line = "a line of ordinary tool output text\n";
        let whole = line.repeat(8_000);
        let head = &whole[..4096];
        let stand_in = text_stand_in(head, whole.len() as u64, whole.chars().count() as u64);
        let full = mc_tokenizer::estimate_tokens(&whole);
        let sized = text_tokens(&stand_in);
        assert!(
            sized * 10 >= full * 9 && sized * 10 <= full * 11,
            "stand-in sized {sized}, whole text {full}"
        );
        let value = json!({"type":"text_ref","byte_size":whole.len(),"sha256":"0".repeat(64),
            "char_count":whole.chars().count(),"head":head});
        let exposed = expose(&json!({"content":[{"type":"text","text":value}]})).unwrap();
        assert_eq!(exposed["content"][0]["text"], json!(stand_in));
        assert!(holds_stand_in(&exposed) && !holds_descriptor(&exposed));
        assert_eq!(text_tokens("plain"), mc_tokenizer::estimate_tokens("plain"));
    }
}
