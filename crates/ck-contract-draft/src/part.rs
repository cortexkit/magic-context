//! The neutral part model. Reads present every message as these parts, and
//! views address them, whatever the host stores (OpenCode parts, Pi journal
//! rows, Anthropic, OpenAI or Gemini blocks). The runner maps its host format
//! both ways; a provider never sees host JSON.
//!
//! The kinds cover every content type of the AI SDK's provider prompt
//! (`LanguageModelV4`), which every model provider maps to: text, reasoning,
//! tool calls with their results, files of any media type, and
//! provider-specific items the runner must send back as they are.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One part of a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Part {
    /// Stable for the life of the message, unique within it. Views address
    /// parts by it.
    pub id: String,
    /// The part's tag number, when it has one ([`is_numbered`]). The runner
    /// counts it: the checkpoint of the session's latest compaction marker
    /// plus the part's position among the numbered parts after the marker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<u64>,
    /// What the model provider checks when the part is sent back.
    #[serde(default, skip_serializing_if = "Seal::is_none")]
    pub seal: Seal,
    /// Checksum of the part without `id`, `tag` and `digest`
    /// ([`body_digest`]). A replace edit names the checksum it was computed
    /// from, so it never lands on a changed part.
    pub digest: String,
    #[serde(flatten)]
    pub body: PartBody,
}

/// What a runner renders in front of a numbered part's text (a text part's
/// text, a tool result's output): the number between section signs, then one
/// space, as in `§12§ `. Text in the neutral part model never carries it.
///
/// A model sees these numbers and starts its own reply with the next one, the
/// way a runner will number it. Its reply then reaches the next request with
/// exactly the bytes the model produced, which routes that continue from
/// earlier replies depend on (see [`crate::clean::clean_reply`]).
pub fn tag_prefix(tag: u64) -> String {
    format!("§{tag}§ ")
}

/// What a runner renders after the prefix for a finished tool result with no
/// text of its own (contract W4.7): `[image]` when every attachment is an
/// image, `[file]` otherwise. `None` for a result that has text, has no
/// attachments, or is still running.
pub fn empty_result_label(tool: &ToolPart) -> Option<&'static str> {
    if tool.output_bytes != Some(0) || tool.attachments.is_empty() {
        return None;
    }
    let all_images = tool.attachments.iter().all(
        |attachment| matches!(&attachment.item, AttachmentItem::File(file) if file.is_image()),
    );
    Some(if all_images { "[image]" } else { "[file]" })
}

/// Every tag number written as a prefix anywhere in `text`: a section sign,
/// one or more ASCII digits, a section sign. The runner checks view bytes with
/// it, so a summary or a replaced field cannot show the model a number that
/// would mislead its count.
pub fn tag_numbers_in(text: &str) -> Vec<u64> {
    let mut numbers = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('§') {
        let after_open = &rest[start + '§'.len_utf8()..];
        let digits = after_open.bytes().take_while(u8::is_ascii_digit).count();
        match after_open[digits..].strip_prefix('§') {
            Some(after_close) if digits > 0 => {
                if let Ok(number) = after_open[..digits].parse() {
                    numbers.push(number);
                }
                rest = after_close;
            }
            _ => rest = after_open,
        }
    }
    numbers
}

/// Whether a part takes a number: text parts of user, notice and assistant
/// entries, and tool parts the model provider did not run itself (the number
/// belongs to the result, whatever its format: text, JSON, error or denial
/// text, or attachments only). Reasoning, files, opaque items, the text of
/// system entries and provider-executed tool parts never take one: a
/// provider-run result is replayed by the host as it is and cannot carry a
/// prefix.
pub fn is_numbered(role: crate::read::Role, body: &PartBody) -> bool {
    match body {
        PartBody::Text { .. } => role != crate::read::Role::System,
        PartBody::Tool(tool) => !tool.provider_executed,
        PartBody::Reasoning { .. } | PartBody::File(_) | PartBody::Opaque(_) => false,
    }
}

impl Part {
    /// Build a part in full form, computing its checksum.
    pub fn new(id: impl Into<String>, tag: Option<u64>, seal: Seal, body: PartBody) -> Self {
        let digest = body_digest(seal, &body);
        Self {
            id: id.into(),
            tag,
            seal,
            digest,
            body,
        }
    }

    /// The compact form of a full part: tool output, the text of sends
    /// delivered with a tool result, and reasoning text are left out, and
    /// only their sizes remain. The checksum stays the one computed over the
    /// full content, so an edit computed from the compact form still names
    /// the exact part. Notices carry parts in this form.
    pub fn compact(&self) -> Part {
        let mut body = self.body.clone();
        match &mut body {
            PartBody::Tool(tool) => {
                tool.output = None;
                for delivered in &mut tool.delivered {
                    delivered.text = None;
                }
            }
            PartBody::Reasoning { text, .. } => *text = None,
            PartBody::Text { .. } | PartBody::File(_) | PartBody::Opaque(_) => {}
        }
        Part {
            id: self.id.clone(),
            tag: self.tag,
            seal: self.seal,
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
        /// The visible reasoning text or summary, when the model provider
        /// returned any. Left out in the compact form.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        /// The size of the visible text in bytes, in both forms.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_bytes: Option<u64>,
    },
    /// A tool call and its result as one item, at the call's position, even
    /// when the host stores the call and the result separately. Dropping a
    /// tool part removes both, so a call is never separated from its result.
    Tool(ToolPart),
    /// Media of any type, images included. The bytes never travel through
    /// this contract.
    File(FileMedia),
    /// Provider-specific content the runner sends back as it is (the AI SDK's
    /// `custom`). It can only be dropped.
    Opaque(Opaque),
}

/// What the model provider checks when a part is sent back.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Seal {
    /// Nothing to check.
    #[default]
    None,
    /// A provider signature binds the part to what came before it: Anthropic
    /// thinking and redacted thinking, Gemini thought signatures.
    /// [`crate::rules`] says which edits that forbids.
    Signed,
    /// Opaque provider content, not bound to earlier history: OpenAI
    /// reasoning with encrypted content.
    Encrypted,
}

impl Seal {
    pub fn is_none(&self) -> bool {
        *self == Seal::None
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolPart {
    pub call_id: String,
    pub name: String,
    /// The call's arguments, as the model wrote them: usually an object, but
    /// any JSON value.
    pub input: Value,
    /// The model provider ran the tool itself (web search, code execution,
    /// image generation), and its result is part of the assistant message.
    /// The host replays such a call as it is, so it can only be dropped.
    #[serde(default, skip_serializing_if = "is_false")]
    pub provider_executed: bool,
    pub status: ToolStatus,
    /// The result's text: the output when completed, the error text on
    /// `error`, the reason on `denied`. Absent while the call is running, and
    /// in the compact form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "OutputFormat::is_text")]
    pub output_format: OutputFormat,
    /// The size of `output` in bytes, in both forms. Absent while the call is
    /// running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
    /// Files and opaque items the result carries besides its text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// A provider-executed call's approval answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// Text sent with delivery `tool_result` and rendered after this result,
    /// in delivery order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivered: Vec<Delivered>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// Running, or waiting for approval.
    Running,
    Completed,
    Error,
    /// The call was not executed.
    Denied,
}

/// How a tool result's text is to be read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    #[default]
    Text,
    /// `output` is the canonical JSON text of a JSON result.
    Json,
}

impl OutputFormat {
    pub fn is_text(&self) -> bool {
        *self == OutputFormat::Text
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Text a module sent with delivery `tool_result`, rendered after the tool
/// result it rode on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivered {
    /// The module that sent it.
    pub sender: String,
    /// The plan template it was rendered from, when it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Left out in the compact form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub text_bytes: u64,
}

impl Delivered {
    pub fn new(sender: impl Into<String>, template: Option<String>, text: String) -> Self {
        Self {
            sender: sender.into(),
            template,
            text_bytes: text.len() as u64,
            text: Some(text),
        }
    }
}

/// An item a tool result carries besides its text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    /// Stable within its tool part; a replace of `attachments` keeps a subset
    /// by these ids.
    pub id: String,
    #[serde(flatten)]
    pub item: AttachmentItem,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentItem {
    File(FileMedia),
    Opaque(Opaque),
}

/// A file of any media type. A provider only needs to know what it is and how
/// big; the bytes stay with the runner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileMedia {
    /// The media type, for example `image/png`, `video/mp4`, `application/pdf`.
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub transport: Transport,
    /// Size in bytes, when the runner knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Pixels, for images and video, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// For audio and video, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// The model produced it as part of its reasoning (the AI SDK's
    /// `reasoning-file`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub reasoning: bool,
}

impl FileMedia {
    /// A file sent as bytes, with no size details beyond its byte count.
    pub fn inline(mime: impl Into<String>, size: Option<u64>) -> Self {
        Self {
            mime: mime.into(),
            name: None,
            transport: Transport::Inline,
            size,
            width: None,
            height: None,
            duration_ms: None,
            reasoning: false,
        }
    }

    pub fn is_image(&self) -> bool {
        self.mime.starts_with("image/")
    }
}

/// How the host sends a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    /// Bytes.
    Inline,
    Url,
    /// A model provider's file id.
    Reference,
    Text,
}

/// Provider-specific content, sent back as it is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Opaque {
    /// `provider.type`, for example `anthropic.compaction`.
    pub provider_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Checksum of a part without its `id`, `tag` and `digest`: its seal, kind
/// and kind fields.
pub fn body_digest(seal: Seal, body: &PartBody) -> String {
    #[derive(Serialize)]
    struct Digested<'a> {
        #[serde(skip_serializing_if = "Seal::is_none")]
        seal: Seal,
        #[serde(flatten)]
        body: &'a PartBody,
    }
    crate::digest::checksum(&Digested { seal, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(output: &str) -> PartBody {
        PartBody::Tool(ToolPart {
            call_id: "call_1".into(),
            name: "read".into(),
            input: json!({"path": "a.rs"}),
            provider_executed: false,
            status: ToolStatus::Completed,
            output: Some(output.into()),
            output_format: OutputFormat::Text,
            output_bytes: Some(output.len() as u64),
            attachments: vec![],
            approval: None,
            delivered: vec![],
        })
    }

    #[test]
    fn a_tool_part_round_trips_with_its_kind_inline() {
        let part = Part::new("p1", Some(42), Seal::None, tool("fn main() {}"));
        let wire = serde_json::to_value(&part).unwrap();
        assert_eq!(wire["kind"], "tool");
        assert_eq!(wire["tag"], 42);
        assert_eq!(wire["name"], "read");
        assert!(wire.get("seal").is_none());
        assert!(wire.get("provider_executed").is_none());
        let back: Part = serde_json::from_value(wire).unwrap();
        assert_eq!(back, part);
    }

    #[test]
    fn files_and_opaque_items_round_trip_as_parts_and_attachments() {
        let video = PartBody::File(FileMedia {
            duration_ms: Some(4_000),
            ..FileMedia::inline("video/mp4", Some(1 << 20))
        });
        let part = Part::new("p1", None, Seal::Signed, video);
        let wire = serde_json::to_value(&part).unwrap();
        assert_eq!(wire["kind"], "file");
        assert_eq!(wire["seal"], "signed");
        assert_eq!(serde_json::from_value::<Part>(wire).unwrap(), part);

        let attachment = Attachment {
            id: "a1".into(),
            item: AttachmentItem::Opaque(Opaque {
                provider_kind: "anthropic.container".into(),
                size: None,
            }),
        };
        let wire = serde_json::to_value(&attachment).unwrap();
        assert_eq!(wire["kind"], "opaque");
        assert_eq!(
            serde_json::from_value::<Attachment>(wire).unwrap(),
            attachment
        );
    }

    #[test]
    fn a_tool_result_with_only_attachments_renders_a_label() {
        let mut body = tool("");
        let PartBody::Tool(tool) = &mut body else {
            unreachable!()
        };
        assert_eq!(empty_result_label(tool), None);
        tool.attachments.push(Attachment {
            id: "a1".into(),
            item: AttachmentItem::File(FileMedia::inline("image/png", None)),
        });
        assert_eq!(empty_result_label(tool), Some("[image]"));
        tool.attachments.push(Attachment {
            id: "a2".into(),
            item: AttachmentItem::File(FileMedia::inline("application/pdf", None)),
        });
        assert_eq!(empty_result_label(tool), Some("[file]"));
        tool.output_bytes = Some(4);
        assert_eq!(empty_result_label(tool), None);
    }

    #[test]
    fn tag_numbers_are_found_anywhere_in_a_text() {
        assert_eq!(tag_numbers_in("[dropped §12§]"), vec![12]);
        assert_eq!(
            tag_numbers_in("§3§ then §40§ and §§ and §7 open"),
            vec![3, 40]
        );
        assert_eq!(tag_numbers_in("§§9§"), vec![9]);
        assert!(tag_numbers_in("no numbers § here").is_empty());
    }

    #[test]
    fn the_compact_form_keeps_sizes_and_the_full_checksum() {
        let full = Part::new(
            "p1",
            None,
            Seal::Signed,
            PartBody::Reasoning {
                text: Some("long thinking".into()),
                text_bytes: Some(13),
            },
        );
        let compact = full.compact();
        assert_eq!(compact.digest, full.digest);
        assert_eq!(
            compact.body,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(13),
            }
        );

        let mut body = tool("output");
        if let PartBody::Tool(tool) = &mut body {
            tool.delivered
                .push(Delivered::new("magic-context", None, "reminder".into()));
        }
        let compact = Part::new("p2", Some(1), Seal::None, body).compact();
        let PartBody::Tool(tool) = compact.body else {
            panic!("a tool part stays one");
        };
        assert_eq!(tool.output, None);
        assert_eq!(tool.output_bytes, Some(6));
        assert_eq!(tool.delivered[0].text, None);
        assert_eq!(tool.delivered[0].text_bytes, 8);
    }

    #[test]
    fn the_digest_follows_the_body_and_seal_not_the_id_or_tag() {
        let body = PartBody::Text {
            text: "hello".into(),
        };
        let one = Part::new("a", Some(1), Seal::None, body.clone());
        let two = Part::new("b", None, Seal::None, body.clone());
        assert_eq!(one.digest, two.digest);
        assert_ne!(
            one.digest,
            Part::new("a", Some(1), Seal::Signed, body).digest
        );
        let changed = Part::new(
            "a",
            Some(1),
            Seal::None,
            PartBody::Text {
                text: "hello!".into(),
            },
        );
        assert_ne!(one.digest, changed.digest);
    }

    #[test]
    fn provider_executed_tools_files_and_system_text_take_no_number() {
        use crate::read::Role;
        let text = PartBody::Text { text: "x".into() };
        assert!(is_numbered(Role::User, &text));
        assert!(is_numbered(Role::Assistant, &text));
        assert!(!is_numbered(Role::System, &text));
        let mut hosted = tool("result");
        if let PartBody::Tool(tool) = &mut hosted {
            tool.provider_executed = true;
        }
        assert!(is_numbered(Role::Assistant, &tool("result")));
        assert!(!is_numbered(Role::Assistant, &hosted));
        assert!(!is_numbered(
            Role::User,
            &PartBody::File(FileMedia::inline("image/png", None))
        ));
    }
}
