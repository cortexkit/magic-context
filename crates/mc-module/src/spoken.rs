//! A head whose persona sends every word for the person through `say` can
//! have no reply text outside tool calls. The head is the session's primary
//! agent. `notify send` also carries the agent's words; tool results are
//! delivery receipts, not conversation.

use cortexkit_role_compaction::part::ToolPart;
use serde_json::Value;

enum PersonFacingTool {
    Say,
    Notify,
}

impl PersonFacingTool {
    fn named(name: &str) -> Option<Self> {
        let name = crate::neutral::without_tool_prefix(name);
        if name.eq_ignore_ascii_case("say") {
            Some(Self::Say)
        } else if name.eq_ignore_ascii_case("notify") {
            Some(Self::Notify)
        } else {
            None
        }
    }
}

/// These calls stay out of automatic reclaim even when they have no spoken text.
pub(crate) fn is_person_facing_tool(name: &str) -> bool {
    PersonFacingTool::named(name).is_some()
}

pub(crate) enum Format {
    Words,
    Transcript,
}

/// The words the agent composed, even if sending failed or has not finished.
/// Only the transcript decorates them with references; search indexes the words.
pub(crate) fn spoken_text(tool: &ToolPart, format: Format) -> Option<String> {
    let kind = PersonFacingTool::named(&tool.name)?;
    let input = tool.input.parse();
    let words = |key| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
    };
    match kind {
        PersonFacingTool::Say => {
            let text = words("text")?;
            Some(match format {
                Format::Words => text.to_owned(),
                Format::Transcript => decorate_say(text, &input),
            })
        }
        PersonFacingTool::Notify if input.get("action").and_then(Value::as_str) == Some("send") => {
            match (words("title"), words("body")) {
                (Some(title), Some(body)) => Some(format!("{title}\n{body}")),
                (title, body) => title.or(body).map(str::to_owned),
            }
        }
        PersonFacingTool::Notify => None,
    }
}

fn decorate_say(text: &str, input: &Value) -> String {
    use crate::js_text::truncate_arg;

    let mut line = if let Some(tag) = input.get("reply_to").and_then(Value::as_u64) {
        match input.get("quote").and_then(Value::as_str) {
            Some(quote) => format!("(to §{tag}§ \"{}\") {text}", truncate_arg(quote)),
            None => format!("(to §{tag}§) {text}"),
        }
    } else {
        text.to_owned()
    };
    let media: Vec<_> = input
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str().or_else(|| {
                ["path", "url", "artifact_id", "id"]
                    .iter()
                    .find_map(|field| item.get(field).and_then(Value::as_str))
            })
        })
        .map(truncate_arg)
        .collect();
    if !media.is_empty() {
        line.push_str(&format!(" [media: {}]", media.join(", ")));
    }
    line
}
