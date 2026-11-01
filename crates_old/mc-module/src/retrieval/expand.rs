//! Recovery rendering over recorded raw-message pages. No store or host is opened.

use super::trim_query;
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fmt};

/// Object order matters for full tool input/output: TS uses JSON.stringify,
/// unlike the sorted maps used by serde_json::Value.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedValue {
    Object(Vec<(String, RecordedValue)>),
    Array(Vec<RecordedValue>),
    Scalar(Value),
}

impl<'de> Deserialize<'de> for RecordedValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Read;
        impl<'de> Visitor<'de> for Read {
            type Value = RecordedValue;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut pairs: Vec<(String, RecordedValue)> = Vec::new();
                while let Some((key, value)) = a.next_entry::<String, RecordedValue>()? {
                    if let Some(prior) = pairs.iter_mut().find(|(k, _)| *k == key) {
                        prior.1 = value;
                    } else {
                        pairs.push((key, value));
                    }
                }
                Ok(RecordedValue::Object(pairs))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = a.next_element()? {
                    values.push(value);
                }
                Ok(RecordedValue::Array(values))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(json!(v)))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(json!(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RecordedValue::Scalar(Value::Null))
            }
        }
        d.deserialize_any(Read)
    }
}

impl RecordedValue {
    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn text(&self) -> Option<&str> {
        match self {
            Self::Scalar(Value::String(s)) => Some(s),
            _ => None,
        }
    }
    fn object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    fn null(&self) -> bool {
        matches!(self, Self::Scalar(Value::Null))
    }
    fn stringify(&self) -> String {
        match self {
            Self::Object(pairs) => {
                let mut order: Vec<_> = pairs.iter().collect();
                // ECMAScript enumerates array-index keys first, then other keys
                // in insertion order. Stable sorting keeps that latter order.
                let index = |k: &str| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|i| *i != u32::MAX && i.to_string() == k)
                };
                order.sort_by_key(|(k, _)| index(k).map_or((1, 0), |i| (0, i)));
                format!(
                    "{{{}}}",
                    order
                        .into_iter()
                        .map(|(k, v)| format!("{}:{}", json!(k), v.stringify()))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            Self::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(Self::stringify)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Self::Scalar(v) => serde_jcs::to_string(v).expect("finite recorded JSON"),
        }
    }
    fn value(&self) -> Value {
        serde_json::from_str(&self.stringify()).expect("recorded JSON")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawMessage {
    pub ordinal: i64,
    pub role: String,
    pub parts: Vec<RecordedValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerboseRangeResult {
    pub text: String,
    pub last_ordinal: i64,
    pub truncated: bool,
}

pub type RecordedPages = Vec<Vec<RawMessage>>;
pub type ToolExpansionMap = BTreeMap<String, Value>;

fn role_label(role: &str) -> &str {
    match role {
        "assistant" => "A (assistant)",
        "user" => "U (user)",
        _ => role,
    }
}

fn truncate(text: &str, max: usize) -> String {
    let text = trim_query(text);
    let units: Vec<_> = text.encode_utf16().collect();
    if units.len() <= max {
        text.into()
    } else {
        format!("{}…", String::from_utf16_lossy(&units[..max]))
    }
}

struct ToolPart<'a> {
    name: &'a str,
    call_id: &'a str,
    title: Option<&'a str>,
    input: Option<&'a RecordedValue>,
    output: Option<String>,
}

fn string_field<'a>(part: &'a RecordedValue, field: &str) -> Option<&'a str> {
    part.get(field).and_then(RecordedValue::text)
}
fn output(value: Option<&RecordedValue>) -> Option<String> {
    value
        .filter(|v| !v.null())
        .map(|v| v.text().map(str::to_owned).unwrap_or_else(|| v.stringify()))
}

fn as_tool_part(part: &RecordedValue) -> Option<ToolPart<'_>> {
    match string_field(part, "type")? {
        "tool" => {
            let state = part.get("state").filter(|v| v.object());
            let title = state
                .and_then(|s| string_field(s, "title"))
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    state
                        .and_then(|s| s.get("metadata"))
                        .filter(|m| m.object())
                        .and_then(|m| string_field(m, "title"))
                        .filter(|s| !s.is_empty())
                });
            Some(ToolPart {
                name: string_field(part, "tool").unwrap_or("tool"),
                call_id: string_field(part, "callID").unwrap_or(""),
                title,
                input: state.and_then(|s| s.get("input")).filter(|v| v.object()),
                output: output(state.and_then(|s| s.get("output"))),
            })
        }
        "tool_use" => Some(ToolPart {
            name: string_field(part, "name").unwrap_or("tool"),
            call_id: string_field(part, "id").unwrap_or(""),
            title: None,
            input: part.get("input").filter(|v| v.object()),
            output: None,
        }),
        "tool_result" => Some(ToolPart {
            name: "tool_result",
            call_id: string_field(part, "tool_use_id").unwrap_or(""),
            title: None,
            input: None,
            output: output(part.get("content")),
        }),
        _ => None,
    }
}

fn render_part_full(part: &RecordedValue) -> Option<String> {
    if !part.object() {
        return None;
    }
    if string_field(part, "type") == Some("text") {
        if let Some(text) = string_field(part, "text") {
            return (!trim_query(text).is_empty()).then(|| format!("  [text]\n{text}"));
        }
    }
    if let Some(tool) = as_tool_part(part) {
        let suffix = if tool.call_id.is_empty() {
            String::new()
        } else {
            format!(" #{}", tool.call_id)
        };
        let mut lines = vec![format!("  [tool: {}{suffix}]", tool.name)];
        if let Some(title) = tool.title.filter(|t| !trim_query(t).is_empty()) {
            lines.push(format!("  description: {}", trim_query(title)));
        }
        if let Some(input) = tool.input {
            lines.push(format!("  input: {}", input.stringify()));
        }
        if let Some(output) = tool.output {
            lines.push(format!("  output:\n{output}"));
        }
        return Some(lines.join("\n"));
    }
    if string_field(part, "type") == Some("file") {
        let name = string_field(part, "filename")
            .filter(|s| !s.is_empty())
            .or_else(|| string_field(part, "url").filter(|s| !s.is_empty()));
        return Some(format!(
            "  [file]{}",
            name.map(|s| format!(" {s}")).unwrap_or_default()
        ));
    }
    None
}

pub fn render_message_by_ordinal(pages: &[Vec<RawMessage>], ordinal: i64) -> String {
    let Some(msg) = pages.iter().flatten().find(|m| m.ordinal == ordinal) else {
        return format!("No message at ordinal {ordinal} in this session's stored history — it was deleted (session prune/revert) or the ordinal is wrong, so it can't be recovered. Re-run the tool if you still need the data.");
    };
    let mut parts: Vec<_> = msg.parts.iter().filter_map(render_part_full).collect();
    if parts.is_empty() {
        parts.push(
            "  (no recoverable content — message had only structural/reasoning parts)".into(),
        );
    }
    format!(
        "[{}] {} — full recovery:\n\n{}",
        msg.ordinal,
        role_label(&msg.role),
        parts.join("\n")
    )
}

fn key_arg(input: Option<&RecordedValue>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    for key in [
        "filePath",
        "path",
        "pattern",
        "query",
        "symbol",
        "module",
        "action",
        "description",
    ] {
        if let Some(text) =
            string_field(input, key).filter(|s| key == "description" || !s.is_empty())
        {
            return truncate(text, 60);
        }
    }
    String::new()
}

fn render_part_preview(part: &RecordedValue, overrides: &ToolExpansionMap) -> Option<String> {
    if !part.object() {
        return None;
    }
    if let Some(expansion) = expand_tool_part(part, overrides) {
        return Some(format!(
            "    • tool {}: {expansion}",
            string_field(part, "tool").unwrap_or("tool")
        ));
    }
    if string_field(part, "type") == Some("text") {
        if let Some(text) = string_field(part, "text") {
            let text = truncate(text, 200);
            return (!text.is_empty()).then(|| format!("    • {text}"));
        }
    }
    if let Some(tool) = as_tool_part(part) {
        let arg = key_arg(tool.input);
        let head = if arg.is_empty() {
            tool.name.into()
        } else {
            format!("{}({arg})", tool.name)
        };
        return Some(match tool.output {
            Some(text) => format!(
                "    • tool {head} → output ~{} tok",
                mc_tokenizer::estimate_tokens(&text)
            ),
            None => format!("    • tool {head}"),
        });
    }
    let kind = string_field(part, "type").unwrap_or("part");
    if matches!(kind, "reasoning" | "thinking") {
        if let Some(text) = string_field(part, "text") {
            return Some(format!("    • [reasoning] {}", truncate(text, 120)));
        }
    }
    match kind {
        "file" => Some("    • [file]".into()),
        "step-start" | "step-finish" => None,
        _ => Some(format!("    • [{kind}]")),
    }
}

/// Pages retain the recorded visitor order. Including the first block even when
/// it exceeds the budget guarantees forward progress for recovery. This matches
/// the TypeScript renderVerboseRange contract, including its continuation marker.
pub fn render_verbose_range(
    pages: &[Vec<RawMessage>],
    start: i64,
    end: i64,
    token_budget: usize,
    overrides: &ToolExpansionMap,
) -> VerboseRangeResult {
    let mut result = VerboseRangeResult {
        text: String::new(),
        last_ordinal: start - 1,
        truncated: false,
    };
    let mut blocks = Vec::new();
    let mut used_tokens = 0;
    for msg in pages
        .iter()
        .flatten()
        .filter(|m| m.ordinal >= start && m.ordinal <= end)
    {
        let tool_results = msg.role == "user"
            && !msg.parts.is_empty()
            && msg.parts.iter().all(|p| {
                p.object()
                    && (string_field(p, "type") == Some("tool_result")
                        || (string_field(p, "type") == Some("tool")
                            && as_tool_part(p).is_some_and(|t| t.output.is_some())))
            });
        let role = if tool_results {
            "tool results"
        } else {
            role_label(&msg.role)
        };
        let mut lines = vec![format!("[{}] {role}", msg.ordinal)];
        lines.extend(
            msg.parts
                .iter()
                .filter_map(|p| render_part_preview(p, overrides)),
        );
        let block = lines.join("\n");
        let tokens = mc_tokenizer::estimate_tokens(&block);
        if used_tokens + tokens > token_budget && !blocks.is_empty() {
            result.truncated = true;
            break;
        }
        blocks.push(block);
        used_tokens += tokens;
        result.last_ordinal = msg.ordinal;
    }
    result.text = blocks.join("\n\n");
    result
}

fn legacy_cap(text: &str, cap: usize) -> String {
    let mut line = String::new();
    let mut newline = false;
    for c in text.chars() {
        if matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !newline {
                line.push(' ');
            }
            newline = true;
        } else {
            newline = false;
            line.push(c);
        }
    }
    if line.chars().count() > cap {
        format!("{}…", line.chars().take(cap).collect::<String>())
    } else {
        line
    }
}

fn scalar(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(v) => serde_jcs::to_string(v).expect("finite template JSON"),
        None => String::new(),
    }
}

fn quoted(source: &str) -> Option<(String, usize)> {
    let mut stream = serde_json::Deserializer::from_str(source).into_iter::<String>();
    let text = stream.next()?.ok()?;
    Some((text, stream.byte_offset()))
}

fn legacy_expression(expression: &str, root: &Value, output_text: &str) -> Option<String> {
    let mut pos = usize::from(expression.starts_with('.'));
    let mut value = Some(root.clone());
    let mut list = false;
    let mut first = true;
    let mut bare_output = false;
    loop {
        if expression[pos..].starts_with('[') {
            pos += 1;
            if expression[pos..].starts_with("*].") {
                pos += 3;
                list = true;
            } else {
                let end = expression[pos..].find(']')? + pos;
                let index: usize = expression[pos..end].parse().ok()?;
                value = value.and_then(|v| v.as_array().and_then(|a| a.get(index)).cloned());
                pos = end + 1;
                continue;
            }
        } else if !first {
            if !expression[pos..].starts_with('.') {
                break;
            }
            if [".each(", ".join(", ".count", ".truncate("]
                .iter()
                .any(|s| expression[pos..].starts_with(s))
            {
                break;
            }
            pos += 1;
        }
        let start = pos;
        while expression
            .as_bytes()
            .get(pos)
            .is_some_and(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        {
            pos += 1;
        }
        if start == pos {
            return None;
        }
        let key = &expression[start..pos];
        bare_output = first && key == "output";
        value = value.and_then(|v| {
            if list {
                v.as_array().map(|a| {
                    Value::Array(
                        a.iter()
                            .map(|item| {
                                item.get(key)
                                    .cloned()
                                    .unwrap_or_else(|| Value::String(String::new()))
                            })
                            .collect(),
                    )
                })
            } else {
                v.as_object().and_then(|o| o.get(key)).cloned()
            }
        });
        first = false;
        if expression.as_bytes().get(pos) == Some(&b'.')
            && ![".each(", ".join(", ".count", ".truncate("]
                .iter()
                .any(|s| expression[pos..].starts_with(s))
        {
            bare_output = false;
        }
        if expression.as_bytes().get(pos) == Some(&b'[') {
            bare_output = false;
        }
    }
    let mut each = None;
    let mut join = None;
    let mut count = false;
    let mut cap = 300;
    if expression[pos..].starts_with(".each(") {
        pos += 6;
        let (template, size) = quoted(&expression[pos..])?;
        pos += size;
        if expression.as_bytes().get(pos) != Some(&b')') {
            return None;
        }
        pos += 1;
        each = Some(template);
    }
    if expression[pos..].starts_with(".join(") {
        pos += 6;
        let (separator, size) = quoted(&expression[pos..])?;
        pos += size;
        if expression.as_bytes().get(pos) != Some(&b')') {
            return None;
        }
        pos += 1;
        join = Some(separator);
    }
    if expression[pos..].starts_with(".count") {
        pos += 6;
        count = true;
    }
    if expression[pos..].starts_with(".truncate(") {
        pos += 10;
        let end = expression[pos..].find(')')? + pos;
        cap = expression[pos..end].parse().ok()?;
        pos = end + 1;
    }
    if pos != expression.len() {
        return None;
    }
    let text = if count {
        value
            .as_ref()
            .and_then(Value::as_array)
            .map(|a| a.len().to_string())
            .unwrap_or_default()
    } else if each.is_some() || list || join.is_some() {
        let Some(array) = value.as_ref().and_then(Value::as_array) else {
            return Some(String::new());
        };
        let mut elements = Vec::new();
        for item in array.iter().take(10) {
            elements.push(legacy_cap(
                &match &each {
                    Some(template) => legacy_render(template, item, "")?,
                    None => scalar(Some(item)),
                },
                300,
            ));
        }
        if array.len() > 10 {
            elements.push(format!("… +{} more", array.len() - 10));
        }
        elements.join(
            join.as_deref()
                .unwrap_or(if each.is_some() { "; " } else { ", " }),
        )
    } else if bare_output {
        output_text.into()
    } else {
        scalar(value.as_ref())
    };
    Some(legacy_cap(&text, cap))
}

fn legacy_render(source: &str, root: &Value, output_text: &str) -> Option<String> {
    let mut remaining = source;
    let mut rendered = String::new();
    while let Some(start) = remaining.find("${") {
        rendered.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];
        let mut in_string = false;
        let mut escaped = false;
        let end = remaining.char_indices().find_map(|(index, c)| {
            if escaped {
                escaped = false;
                return None;
            }
            if in_string && c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = !in_string;
            } else if c == '}' && !in_string {
                return Some(index);
            }
            None
        })?;
        rendered.push_str(&legacy_expression(&remaining[..end], root, output_text)?);
        remaining = &remaining[end + 1..];
    }
    rendered.push_str(remaining);
    Some(rendered)
}

fn preview_default(name: &str) -> Option<&'static str> {
    match name {
        "ctx_note" => Some("Note ${input.action} ${input.note_ids}: ${input.content} → ${output.truncate(160)}"),
        "ctx_memory" => Some("Memory ${input.action} ${input.category} ${input.ids}: ${input.content} → ${output.truncate(160)}"),
        "todowrite" => Some("Todos (${input.todos.count}): ${input.todos.each(\"${status}: ${content}\")}"),
        "question" => Some("Asked user: ${input.questions[*].question.join(\" / \")} → ${output}"),
        "task" => Some("Task ${input.subagent_type}: ${input.prompt} → ${output.truncate(200)}"),
        "ask" => Some("Asked: ${input.question.truncate(250)} [options: ${input.options.join(\" / \")}] ${input.resolution} → ${output.truncate(300)}"),
        "peer_send" => Some("PM to ${input.agent}${input.agent_id}: ${input.message.truncate(400)}"),
        "board" => Some("Board ${input.verb}: ${input.ops.each(\"${op} ${item}${lane.title} ${state}${lane.status}${props.text} ${lane.items[*].text}\")}"),
        "room" => Some("Room ${input.action} ${input.room_id}: ${input.text.truncate(400)}"),
        "work" => Some("Work ${input.action} ${input.id}: ${input.prompt_file}${input.prompt.truncate(200)}${input.notes.truncate(200)} → ${output.truncate(160)}"),
        "knowhow" => Some("Looked up how-to: ${input.query}${input.id}"),
        _ => None,
    }
}

fn expand_tool_part(part: &RecordedValue, overrides: &ToolExpansionMap) -> Option<String> {
    if string_field(part, "type") != Some("tool") {
        return None;
    }
    let name = string_field(part, "tool")?;
    let template = match overrides.get(name) {
        Some(v) => v.as_str()?,
        None => preview_default(name)?,
    };
    if !crate::historian_tool_template::valid_template(template) {
        return None;
    }
    let state = part.get("state");
    let input = state.and_then(|s| s.get("input"));
    let output = state.and_then(|s| {
        s.get("output")
            .filter(|v| !v.null())
            .or_else(|| s.get("error"))
    });
    let output_value = output.map(RecordedValue::value);
    let output_text = scalar(output_value.as_ref());
    let structured = match output_value {
        Some(Value::String(s)) => serde_json::from_str::<Value>(&s)
            .ok()
            .filter(Value::is_object),
        value => value,
    };
    let mut root = serde_json::Map::new();
    if let Some(input) = input {
        root.insert("input".into(), input.value());
    }
    if let Some(output) = structured {
        root.insert("output".into(), output);
    }
    Some(legacy_cap(
        &legacy_render(template, &Value::Object(root), &output_text)?,
        1000,
    ))
}

// Expected values were generated by executing TypeScript at the provenance commit
// with recorded inputs; they are independent of the Rust implementation.
#[cfg(test)]
const FROZEN_EXPAND: &str = r####"{
  "provenance": {
    "commit": "282d9c08bce490346583a3b8c145c402499f980f",
    "sha256": {
      "packages/plugin/src/hooks/magic-context/token-count-exact.ts": "7e48906e5dbe57ccec12de2181b967a7fa132ba23d780e9ae5251c36ad8733e9",
      "packages/plugin/src/hooks/magic-context/read-session-formatting.ts": "5e5cdcb8027b4be256ad7eba45c254688583dd613cba21c6587a64044984c304",
      "packages/plugin/src/shared/historian-tool-template.ts": "74800c8fc681c84f9ccfa703c7d3b68cf02c289ece4f3a0c7b1f642e05b70d81",
      "packages/plugin/src/shared/historian-tool-preview-defaults.json": "b9246fdaad6ab38650f94c4c1d7e360d9e85d7d031c01760d0850d9a068cc13d",
      "packages/plugin/src/shared/historian-tool-defaults.json": "eb3891f2fe1f4b030dacc6b711b22037647a40ed7ae91e9979ac920f14e555cc",
      "packages/plugin/src/shared/historian-tool-expansions.ts": "bbbc7ac16ad1908e991497aab8835f40f3207cade6f0749eb694768ef9668071",
      "packages/plugin/src/tools/ctx-expand/render.ts": "2551e4025fd3b8abfd999fdca05ca804c2938d3facf4d62a30c4027ed6681d7a",
      "packages/plugin/src/features/magic-context/literal-probes.ts": "cb38519de49197dea3609fa26d6ac936c27c6bdbfdf0239f723e21647e1d93e6",
      "packages/plugin/src/features/magic-context/search-rerank.ts": "314a0a80a54136a154f8ae605bb20ee31cca81046170d389fadee0a1aebab855",
      "packages/plugin/src/tools/ctx-expand/tools.ts": "2e2fe2d9fb62b742d1a0fd93a9099146dcf7f46801ce5483dde5915e0c2959e0",
      "packages/plugin/src/tools/ctx-expand/constants.ts": "dcad832dcb04e12b8265de97e38e0a55a08563ef87d4d560b108e175d5d79292",
      "packages/plugin/src/features/magic-context/search.ts": "89a9913e7645f991e196ca3a5cfd2a1a4a1dd92770b74c200dfeb32e05eafda3"
    },
    "tokenEstimator": "tokenizer:43",
    "generator": "generate.ts: frozen source executed with recorded SQL rows, raw-message visitor and fake Synapse; no live store"
  },
  "expand": {
    "pages": [
      [
        {
          "ordinal": 1,
          "role": "user",
          "parts": [
            {
              "type": "text",
              "text": "  original text\nwith spacing  "
            },
            {
              "type": "file",
              "filename": "fixture.txt"
            },
            null,
            {
              "type": "step-start"
            }
          ]
        },
        {
          "ordinal": 2,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "read",
              "callID": "read-1",
              "state": {
                "title": "  Read fixture ",
                "input": {
                  "z": 1,
                  "path": "src/file.ts",
                  "a": [
                    true,
                    null
                  ]
                },
                "output": {
                  "z": 2,
                  "a": "value"
                }
              }
            },
            {
              "type": "reasoning",
              "text": "internal reasoning"
            },
            {
              "type": "mystery"
            }
          ]
        }
      ],
      [
        {
          "ordinal": 4,
          "role": "assistant",
          "parts": [
            {
              "type": "tool_use",
              "name": "shell",
              "id": "split",
              "input": {
                "command": "echo hello"
              }
            },
            {
              "type": "thinking",
              "text": "private"
            },
            {
              "type": "step-finish"
            }
          ]
        },
        {
          "ordinal": 5,
          "role": "user",
          "parts": [
            {
              "type": "tool_result",
              "tool_use_id": "split",
              "content": [
                {
                  "type": "text",
                  "text": "hello"
                }
              ]
            }
          ]
        },
        {
          "ordinal": 6,
          "role": "assistant",
          "parts": [
            {
              "type": "reasoning",
              "text": "hidden"
            },
            {
              "type": "step-finish"
            }
          ]
        },
        {
          "ordinal": 8,
          "role": "system",
          "parts": [
            {
              "type": "text",
              "text": "  long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long   "
            },
            {
              "type": "tool",
              "tool": "knowhow",
              "state": {
                "input": {
                  "query": "testing\nretrieval"
                },
                "output": "ok"
              }
            }
          ]
        }
      ],
      [
        {
          "ordinal": 9,
          "role": "user",
          "parts": [
            {
              "type": "tool",
              "tool": "other",
              "state": {
                "input": {
                  "description": "a fallback"
                },
                "output": ""
              }
            }
          ]
        },
        {
          "ordinal": 10,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "todowrite",
              "state": {
                "input": {
                  "todos": [
                    {
                      "status": "done",
                      "content": "one"
                    },
                    {
                      "status": "pending",
                      "content": "two"
                    }
                  ]
                },
                "output": "ok"
              }
            },
            {
              "type": "tool",
              "tool": "question",
              "state": {
                "input": {
                  "questions": [
                    {
                      "question": "why?"
                    },
                    {
                      "question": "what?"
                    }
                  ]
                },
                "output": "answer"
              }
            }
          ]
        },
        {
          "ordinal": 11,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "custom",
              "state": {
                "input": {
                  "z": 1,
                  "a": 2,
                  "items": [
                    {
                      "name": "a"
                    },
                    {
                      "name": "b"
                    }
                  ]
                },
                "output": "{\"z\":1,\"a\":2}"
              }
            }
          ]
        }
      ],
      [
        {
          "ordinal": 12,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "ctx_note",
              "state": {
                "input": {
                  "action": "add",
                  "content": "recorded note",
                  "note_ids": [
                    3,
                    2
                  ]
                },
                "output": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              }
            }
          ]
        },
        {
          "ordinal": 13,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "custom",
              "state": {
                "input": {
                  "items": [
                    {
                      "name": "n0"
                    },
                    {
                      "name": null
                    },
                    {
                      "name": "n2"
                    },
                    {
                      "name": "n3"
                    },
                    {
                      "name": "n4"
                    },
                    {
                      "name": "n5"
                    },
                    {
                      "name": "n6"
                    },
                    {
                      "name": "n7"
                    },
                    {
                      "name": "n8"
                    },
                    {
                      "name": "n9"
                    },
                    {
                      "name": "n10"
                    },
                    {
                      "name": "n11"
                    }
                  ]
                },
                "output": {
                  "z": 1e+30,
                  "a": 0
                }
              }
            }
          ]
        },
        {
          "ordinal": 14,
          "role": "assistant",
          "parts": [
            {
              "type": "tool",
              "tool": "board",
              "state": {
                "input": {
                  "verb": "set",
                  "ops": [
                    {
                      "op": "add",
                      "item": "i",
                      "lane": {
                        "title": "t",
                        "status": "open",
                        "items": [
                          {
                            "text": "one"
                          },
                          {
                            "text": "two"
                          }
                        ]
                      },
                      "props": {
                        "text": "notes"
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      ]
    ],
    "full": [
      {
        "ordinal": 1,
        "expected": "[1] U (user) — full recovery:\n\n  [text]\n  original text\nwith spacing  \n  [file] fixture.txt"
      },
      {
        "ordinal": 2,
        "expected": "[2] A (assistant) — full recovery:\n\n  [tool: read #read-1]\n  description: Read fixture\n  input: {\"z\":1,\"path\":\"src/file.ts\",\"a\":[true,null]}\n  output:\n{\"z\":2,\"a\":\"value\"}"
      },
      {
        "ordinal": 3,
        "expected": "No message at ordinal 3 in this session's stored history — it was deleted (session prune/revert) or the ordinal is wrong, so it can't be recovered. Re-run the tool if you still need the data."
      },
      {
        "ordinal": 4,
        "expected": "[4] A (assistant) — full recovery:\n\n  [tool: shell #split]\n  input: {\"command\":\"echo hello\"}"
      },
      {
        "ordinal": 5,
        "expected": "[5] U (user) — full recovery:\n\n  [tool: tool_result #split]\n  output:\n[{\"type\":\"text\",\"text\":\"hello\"}]"
      },
      {
        "ordinal": 6,
        "expected": "[6] A (assistant) — full recovery:\n\n  (no recoverable content — message had only structural/reasoning parts)"
      },
      {
        "ordinal": 8,
        "expected": "[8] system — full recovery:\n\n  [text]\n  long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long   \n  [tool: knowhow]\n  input: {\"query\":\"testing\\nretrieval\"}\n  output:\nok"
      },
      {
        "ordinal": 9,
        "expected": "[9] U (user) — full recovery:\n\n  [tool: other]\n  input: {\"description\":\"a fallback\"}\n  output:\n"
      },
      {
        "ordinal": 10,
        "expected": "[10] A (assistant) — full recovery:\n\n  [tool: todowrite]\n  input: {\"todos\":[{\"status\":\"done\",\"content\":\"one\"},{\"status\":\"pending\",\"content\":\"two\"}]}\n  output:\nok\n  [tool: question]\n  input: {\"questions\":[{\"question\":\"why?\"},{\"question\":\"what?\"}]}\n  output:\nanswer"
      },
      {
        "ordinal": 11,
        "expected": "[11] A (assistant) — full recovery:\n\n  [tool: custom]\n  input: {\"z\":1,\"a\":2,\"items\":[{\"name\":\"a\"},{\"name\":\"b\"}]}\n  output:\n{\"z\":1,\"a\":2}"
      },
      {
        "ordinal": 12,
        "expected": "[12] A (assistant) — full recovery:\n\n  [tool: ctx_note]\n  input: {\"action\":\"add\",\"content\":\"recorded note\",\"note_ids\":[3,2]}\n  output:\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      },
      {
        "ordinal": 13,
        "expected": "[13] A (assistant) — full recovery:\n\n  [tool: custom]\n  input: {\"items\":[{\"name\":\"n0\"},{\"name\":null},{\"name\":\"n2\"},{\"name\":\"n3\"},{\"name\":\"n4\"},{\"name\":\"n5\"},{\"name\":\"n6\"},{\"name\":\"n7\"},{\"name\":\"n8\"},{\"name\":\"n9\"},{\"name\":\"n10\"},{\"name\":\"n11\"}]}\n  output:\n{\"z\":1e+30,\"a\":0}"
      },
      {
        "ordinal": 14,
        "expected": "[14] A (assistant) — full recovery:\n\n  [tool: board]\n  input: {\"verb\":\"set\",\"ops\":[{\"op\":\"add\",\"item\":\"i\",\"lane\":{\"title\":\"t\",\"status\":\"open\",\"items\":[{\"text\":\"one\"},{\"text\":\"two\"}]},\"props\":{\"text\":\"notes\"}}]}"
      }
    ],
    "ranges": [
      {
        "start": 1,
        "end": 11,
        "budget": 10000,
        "expected": {
          "text": "[1] U (user)\n    • original text\nwith spacing\n    • [file]\n\n[2] A (assistant)\n    • tool read(src/file.ts) → output ~9 tok\n    • [reasoning] internal reasoning\n    • [mystery]\n\n[4] A (assistant)\n    • tool shell\n    • [reasoning] private\n\n[5] tool results\n    • tool tool_result → output ~10 tok\n\n[6] A (assistant)\n    • [reasoning] hidden\n\n[8] system\n    • long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long …\n    • tool knowhow: Looked up how-to: testing retrieval\n\n[9] tool results\n    • tool other(a fallback) → output ~0 tok\n\n[10] A (assistant)\n    • tool todowrite: Todos (2): done: one; pending: two\n    • tool question: Asked user: why? / what? → answer\n\n[11] A (assistant)\n    • tool custom → output ~9 tok",
          "lastOrdinal": 11,
          "truncated": false
        }
      },
      {
        "start": 1,
        "end": 11,
        "budget": 35,
        "expected": {
          "text": "[1] U (user)\n    • original text\nwith spacing\n    • [file]",
          "lastOrdinal": 1,
          "truncated": true
        }
      },
      {
        "start": 2,
        "end": 11,
        "budget": 0,
        "expected": {
          "text": "[2] A (assistant)\n    • tool read(src/file.ts) → output ~9 tok\n    • [reasoning] internal reasoning\n    • [mystery]",
          "lastOrdinal": 2,
          "truncated": true
        }
      },
      {
        "start": 3,
        "end": 3,
        "budget": 100,
        "expected": {
          "text": "",
          "lastOrdinal": 2,
          "truncated": false
        }
      },
      {
        "start": 4,
        "end": 5,
        "budget": 10000,
        "expected": {
          "text": "[4] A (assistant)\n    • tool shell\n    • [reasoning] private\n\n[5] tool results\n    • tool tool_result → output ~10 tok",
          "lastOrdinal": 5,
          "truncated": false
        }
      },
      {
        "start": 10,
        "end": 11,
        "budget": 10000,
        "expected": {
          "text": "[10] A (assistant)\n    • tool todowrite: Todos (2): done: one; pending: two\n    • tool question: Asked user: why? / what? → answer\n\n[11] A (assistant)\n    • tool custom → output ~9 tok",
          "lastOrdinal": 11,
          "truncated": false
        }
      },
      {
        "start": 11,
        "end": 11,
        "budget": 10000,
        "overrides": {
          "custom": "${input.items[*].name.join(\" / \")} ${output} ${output.a} ${input.z}"
        },
        "expected": {
          "text": "[11] A (assistant)\n    • tool custom: a / b {\"z\":1,\"a\":2} 2 1",
          "lastOrdinal": 11,
          "truncated": false
        }
      },
      {
        "start": 12,
        "end": 14,
        "budget": 10000,
        "overrides": {
          "custom": "${input.items[*].name.join(\" | \")} ${output}"
        },
        "expected": {
          "text": "[12] A (assistant)\n    • tool ctx_note: Note add [3,2]: recorded note → xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…\n\n[13] A (assistant)\n    • tool custom: n0 | null | n2 | n3 | n4 | n5 | n6 | n7 | n8 | n9 | … +2 more {\"a\":0,\"z\":1e+30}\n\n[14] A (assistant)\n    • tool board: Board set: add it opennotes one, two",
          "lastOrdinal": 14,
          "truncated": false
        }
      },
      {
        "start": 10,
        "end": 10,
        "budget": 10000,
        "overrides": {
          "todowrite": false,
          "question": "bad ${broken}"
        },
        "expected": {
          "text": "[10] A (assistant)\n    • tool todowrite → output ~1 tok\n    • tool question → output ~1 tok",
          "lastOrdinal": 10,
          "truncated": false
        }
      }
    ]
  }
}"####;

#[cfg(test)]
mod campaign_3a {
    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        expand: Cases,
    }
    #[derive(Deserialize)]
    struct Cases {
        pages: RecordedPages,
        full: Vec<Full>,
        ranges: Vec<Range>,
    }
    #[derive(Deserialize)]
    struct Full {
        ordinal: i64,
        expected: String,
    }
    #[derive(Deserialize)]
    struct Range {
        start: i64,
        end: i64,
        budget: usize,
        #[serde(default)]
        overrides: ToolExpansionMap,
        expected: VerboseRangeResult,
    }

    #[test]
    fn raw_message_expand_matches_frozen_ts_recorded_pages() {
        let f: Fixture = serde_json::from_str(FROZEN_EXPAND).unwrap();
        for case in f.expand.full {
            assert_eq!(
                render_message_by_ordinal(&f.expand.pages, case.ordinal),
                case.expected,
                "ordinal {}",
                case.ordinal
            );
        }
    }

    #[test]
    fn compartment_expand_matches_frozen_ts_recorded_pages() {
        let f: Fixture = serde_json::from_str(FROZEN_EXPAND).unwrap();
        for case in f.expand.ranges {
            assert_eq!(
                render_verbose_range(
                    &f.expand.pages,
                    case.start,
                    case.end,
                    case.budget,
                    &case.overrides
                ),
                case.expected,
                "range {}-{} budget {}",
                case.start,
                case.end,
                case.budget
            );
        }
    }
}
