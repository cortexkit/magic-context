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

impl Part {
    /// Build a part, computing its checksum from the body.
    pub fn new(id: impl Into<String>, tag: Option<u64>, body: PartBody) -> Self {
        let digest = body_digest(&body);
        Self {
            id: id.into(),
            tag,
            digest,
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
        /// The visible reasoning text, when the provider returns any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
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
    /// failed. Absent while the call is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
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
