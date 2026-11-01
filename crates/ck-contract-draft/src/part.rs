//! The neutral part model. Reads present every message as these parts, and
//! views address them, whatever the host stores (OpenCode parts, Pi journal
//! rows, Anthropic or OpenAI blocks). The runner maps its host format both
//! ways; a provider never sees host JSON.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One part of a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Part {
    /// Stable for the life of the message. Views address parts by it.
    pub id: String,
    /// The part's tag number, when it has one. The runner assigns a number
    /// when it first stores or sees the part, keeps it durably, and never
    /// reuses one, so a cut or a restart never changes it. Text parts and
    /// tool parts have numbers (a tool part's number belongs to its result);
    /// reasoning, images and files never do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<u64>,
    /// Checksum of [`Part::body`] ([`body_digest`]). A replace edit names the
    /// checksum it was computed from, so it never lands on a changed part.
    pub digest: String,
    #[serde(flatten)]
    pub body: PartBody,
}

/// What a runner renders in front of a tagged part's text (a text part's
/// text, a tool result's output): the number between section signs, then one
/// space, as in `§12§ `. Text in the neutral part model never carries it.
///
/// A model sees these numbers and starts its own reply with the next one, the
/// way a runner will number it. Its reply then reaches the next request with
/// exactly the bytes the model produced, which routes that continue from
/// earlier replies depend on (see [`split_self_tag`]).
pub fn tag_prefix(tag: u64) -> String {
    format!("§{tag}§ ")
}

/// Split the tag prefixes a model wrote at the start of a reply's text from
/// the text, returning the first number written and the rest. A runner stores
/// the rest and renders the number it assigns in front, so a reply whose
/// model wrote exactly that number, then one space, renders byte for byte as
/// written. Any other prefix (a different number, repeated prefixes, other
/// spacing) is replaced by the assigned one, and the reply's rendered bytes
/// then differ from what the model produced.
pub fn split_self_tag(text: &str) -> (Option<u64>, &str) {
    let mut rest = text;
    let mut first = None;
    while let Some(after_open) = rest.strip_prefix('§') {
        let digits = after_open.bytes().take_while(u8::is_ascii_digit).count();
        let Some(after_close) = after_open[digits..].strip_prefix('§') else {
            break;
        };
        if digits == 0 {
            break;
        }
        if first.is_none() {
            first = after_open[..digits].parse().ok();
        }
        rest = after_close.trim_start();
    }
    (first, rest)
}

impl Part {
    /// Build a part in full form, computing its checksum from the body.
    pub fn new(id: impl Into<String>, tag: Option<u64>, body: PartBody) -> Self {
        let digest = body_digest(&body);
        Self {
            id: id.into(),
            tag,
            digest,
            body,
        }
    }

    /// The compact form of a full part: tool output and reasoning text are
    /// left out, and only their sizes remain. The checksum stays the one
    /// computed over the full content, so an edit computed from the compact
    /// form still names the exact part. Notices carry parts in this form.
    pub fn compact(&self) -> Part {
        let mut body = self.body.clone();
        match &mut body {
            PartBody::Tool(tool) => tool.output = None,
            PartBody::Reasoning { text, .. } => *text = None,
            PartBody::Text { .. } | PartBody::Image(_) | PartBody::File(_) => {}
        }
        Part {
            id: self.id.clone(),
            tag: self.tag,
            digest: self.digest.clone(),
            body,
        }
    }
}

/// What a part holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PartBody {
    Text {
        text: String,
    },
    Reasoning {
        /// The visible reasoning text, when the provider returns any. Left
        /// out in the compact form.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        /// The size of the visible text in bytes, in both forms.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_bytes: Option<u64>,
        sealing: Sealing,
    },
    /// A tool call and its result as one item, at the call's position, even
    /// when the host stores the call and the result separately. Dropping a
    /// tool part removes both, so a call is never separated from its result.
    Tool(ToolPart),
    Image(Media),
    File(Media),
}

/// Whether reasoning carries provider-checked content the runner must send
/// back unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sealing {
    /// Plain text; nothing to verify.
    None,
    /// A provider signature binds it to what came before (Anthropic thinking).
    /// [`crate::rules`] says which edits that forbids.
    Signed,
    /// Content the provider encrypted (OpenAI reasoning); no visible text.
    Encrypted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolPart {
    pub call_id: String,
    pub name: String,
    /// The call's arguments, as the model wrote them.
    pub input: Map<String, Value>,
    pub status: ToolStatus,
    /// The result's text: the output when completed, the error text when it
    /// failed. Absent while the call is running, and in the compact form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// The size of the result's text in bytes, in both forms. Absent while
    /// the call is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
    /// Images and files the result carries besides its text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Completed,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    /// Stable within its tool part; a replace of `attachments` keeps a subset
    /// by these ids.
    pub id: String,
    #[serde(flatten)]
    pub media: Media,
}

/// An image or file. The bytes never travel through this contract; a
/// provider only needs to know what it is and how big.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Media {
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Size in bytes, when the runner knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Checksum of a part body.
pub fn body_digest(body: &PartBody) -> String {
    crate::digest::checksum(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_tool_part_round_trips_with_its_kind_inline() {
        let part = Part::new(
            "p1",
            Some(42),
            PartBody::Tool(ToolPart {
                call_id: "call_1".into(),
                name: "read".into(),
                input: json!({"path": "a.rs"}).as_object().unwrap().clone(),
                status: ToolStatus::Completed,
                output: Some("fn main() {}".into()),
                output_bytes: Some(12),
                attachments: vec![],
            }),
        );
        let wire = serde_json::to_value(&part).unwrap();
        assert_eq!(wire["kind"], "tool");
        assert_eq!(wire["tag"], 42);
        assert_eq!(wire["name"], "read");
        let back: Part = serde_json::from_value(wire).unwrap();
        assert_eq!(back, part);
    }

    #[test]
    fn a_correct_self_tag_splits_off_and_renders_back_byte_for_byte() {
        let written = "§12§ Done. §3§ was the old read.";
        let (number, rest) = split_self_tag(written);
        assert_eq!(number, Some(12));
        assert_eq!(format!("{}{rest}", tag_prefix(12)), written);
        assert_eq!(split_self_tag("§7§ §7§  twice"), (Some(7), "twice"));
        assert_eq!(split_self_tag("no prefix"), (None, "no prefix"));
        assert_eq!(split_self_tag("§§ empty"), (None, "§§ empty"));
        assert_eq!(split_self_tag("§12 open"), (None, "§12 open"));
    }

    #[test]
    fn the_compact_form_keeps_sizes_and_the_full_checksum() {
        let full = Part::new(
            "p1",
            None,
            PartBody::Reasoning {
                text: Some("long thinking".into()),
                text_bytes: Some(13),
                sealing: Sealing::Signed,
            },
        );
        let compact = full.compact();
        assert_eq!(compact.digest, full.digest);
        assert_eq!(
            compact.body,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(13),
                sealing: Sealing::Signed,
            }
        );
    }

    #[test]
    fn the_digest_follows_the_body_not_the_id_or_tag() {
        let body = PartBody::Text {
            text: "hello".into(),
        };
        let one = Part::new("a", Some(1), body.clone());
        let two = Part::new("b", None, body);
        assert_eq!(one.digest, two.digest);
        let changed = Part::new(
            "a",
            Some(1),
            PartBody::Text {
                text: "hello!".into(),
            },
        );
        assert_ne!(one.digest, changed.digest);
    }
}
