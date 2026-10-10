//! Non-executable historian templates. Twin of shared/historian-tool-template.ts.
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub type ExpansionMap = BTreeMap<String, Value>;
#[derive(Clone)]
enum Step {
    Field(String),
    Index(usize),
    Project(String),
}
#[derive(Clone)]
struct Expression {
    steps: Vec<Step>,
    each: Option<Vec<Node>>,
    join: Option<String>,
    count: bool,
    cap: Option<usize>,
}
#[derive(Clone)]
enum Node {
    Literal(String),
    Expression(Expression),
}
struct Parser<'a> {
    source: &'a str,
    pos: usize,
}
impl<'a> Parser<'a> {
    fn take(&mut self, value: &str) -> bool {
        if !self.source[self.pos..].starts_with(value) {
            return false;
        }
        self.pos += value.len();
        true
    }
    fn field(&mut self) -> Result<String, ()> {
        let start = self.pos;
        let bytes = self.source.as_bytes();
        if !bytes
            .get(self.pos)
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        {
            return Err(());
        }
        self.pos += 1;
        while bytes
            .get(self.pos)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        {
            self.pos += 1;
        }
        Ok(self.source[start..self.pos].to_string())
    }
    fn integer(&mut self) -> Result<usize, ()> {
        let start = self.pos;
        while self
            .source
            .as_bytes()
            .get(self.pos)
            .is_some_and(u8::is_ascii_digit)
        {
            self.pos += 1;
        }
        let n = self.source[start..self.pos]
            .parse::<u64>()
            .map_err(|_| ())?;
        if n > 9_007_199_254_740_991 {
            return Err(());
        }
        usize::try_from(n).map_err(|_| ())
    }
    fn quoted(&mut self) -> Result<String, ()> {
        let start = self.pos;
        if !self.take("\"") {
            return Err(());
        }
        while self.pos < self.source.len() {
            if self.take("\\") {
                let ch = self.source[self.pos..].chars().next().ok_or(())?;
                self.pos += ch.len_utf8();
            } else if self.take("\"") {
                return serde_json::from_str(&self.source[start..self.pos]).map_err(|_| ());
            } else {
                self.pos += self.source[self.pos..].chars().next().ok_or(())?.len_utf8();
            }
        }
        Err(())
    }
    fn expression(&mut self, relative: bool) -> Result<Expression, ()> {
        let mut steps = Vec::new();
        if !(relative && self.take(".")) {
            let root = self.field()?;
            if !relative && root != "input" && root != "output" {
                return Err(());
            }
            steps.push(Step::Field(root));
        }
        loop {
            if self.take("[") {
                if self.take("*].") {
                    steps.push(Step::Project(self.field()?));
                } else {
                    let index = self.integer()?;
                    if !self.take("]") {
                        return Err(());
                    }
                    steps.push(Step::Index(index));
                }
            } else {
                let tail = &self.source[self.pos..];
                let operation = tail.starts_with(".each(")
                    || tail.starts_with(".join(")
                    || tail.starts_with(".truncate(")
                    || tail
                        .strip_prefix(".count")
                        .is_some_and(|t| t.starts_with('.') || t.starts_with('}'));
                if !operation && self.take(".") {
                    steps.push(Step::Field(self.field()?));
                    if self.source[self.pos..].starts_with('(') {
                        return Err(());
                    }
                } else {
                    break;
                }
            }
        }
        let mut expr = Expression {
            steps,
            each: None,
            join: None,
            count: false,
            cap: None,
        };
        if self.take(".each(") {
            if relative {
                return Err(());
            }
            expr.each = Some(parse(&self.quoted()?, true)?);
            if !self.take(")") {
                return Err(());
            }
        }
        if self.take(".join(") {
            expr.join = Some(self.quoted()?);
            if !self.take(")") {
                return Err(());
            }
        }
        if self.take(".count") {
            if expr.each.is_some() || expr.join.is_some() {
                return Err(());
            }
            expr.count = true;
        }
        if self.take(".truncate(") {
            expr.cap = Some(self.integer()?);
            if !self.take(")") {
                return Err(());
            }
        }
        if !self.take("}") {
            return Err(());
        }
        Ok(expr)
    }
}
fn parse(source: &str, relative: bool) -> Result<Vec<Node>, ()> {
    let mut parser = Parser { source, pos: 0 };
    let mut nodes = Vec::new();
    while parser.pos < source.len() {
        let Some(next) = source[parser.pos..].find("${") else {
            nodes.push(Node::Literal(source[parser.pos..].to_string()));
            break;
        };
        nodes.push(Node::Literal(
            source[parser.pos..parser.pos + next].to_string(),
        ));
        parser.pos += next + 2;
        nodes.push(Node::Expression(parser.expression(relative)?));
    }
    Ok(nodes)
}
pub fn valid_template(source: &str) -> bool {
    parse(source, false).is_ok()
}
fn truncate(source: &str, cap: Option<usize>) -> String {
    let mut normalized = String::new();
    let mut newline = false;
    for ch in source.chars() {
        if matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !newline {
                normalized.push(' ');
            }
            newline = true;
        } else {
            normalized.push(ch);
            newline = false;
        }
    }
    let Some(cap) = cap else {
        return normalized;
    };
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() <= cap {
        return normalized;
    }
    // Explicit caps stop after sentence-ending punctuation so a cut is not
    // mistaken for an intact tool message. If no sentence fits, show only the marker.
    let mut end = 0;
    for i in 0..cap.min(chars.len()) {
        if !".!?。！？".contains(chars[i]) {
            continue;
        }
        let mut next = i + 1;
        while next < chars.len() && "\"'”’)]".contains(chars[next]) {
            next += 1;
        }
        if next <= cap
            && ("。！？".contains(chars[i])
                || next == chars.len()
                || matches!(chars[next], ' ' | '\t'))
        {
            end = next;
        }
    }
    let prefix: String = chars[..end].iter().collect();
    format!(
        "{prefix}{}[… {} more characters]",
        if end > 0 { " " } else { "" },
        chars.len() - end
    )
}
fn scalar(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => serde_jcs::to_string(v).unwrap_or_default(),
    }
}
fn render(nodes: &[Node], root: Option<&Value>, output_text: Option<&str>) -> String {
    nodes
        .iter()
        .map(|node| match node {
            Node::Literal(s) => s.clone(),
            Node::Expression(expr) => {
                if matches!(expr.steps.as_slice(), [Step::Field(f)] if f == "output")
                    && expr.each.is_none()
                    && !expr.count
                    && expr.join.is_none()
                {
                    if let Some(text) = output_text {
                        return truncate(text, expr.cap);
                    }
                }
                let mut value = root.cloned();
                let mut projected: Option<Vec<Option<Value>>> = None;
                let mut list = false;
                for step in &expr.steps {
                    value = match step {
                        Step::Field(f) => {
                            if let Some(items) = projected.as_mut() {
                                for item in items {
                                    *item =
                                        item.as_ref().and_then(|v| v.as_object()?.get(f)).cloned();
                                }
                                None
                            } else {
                                value.as_ref().and_then(|v| v.as_object()?.get(f)).cloned()
                            }
                        }
                        Step::Index(i) => {
                            if let Some(items) = projected.take() {
                                items.get(*i).cloned().flatten()
                            } else {
                                value
                                    .as_ref()
                                    .and_then(Value::as_array)
                                    .and_then(|a| a.get(*i))
                                    .cloned()
                            }
                        }
                        Step::Project(f) => {
                            list = true;
                            projected = value.as_ref().and_then(Value::as_array).map(|a| {
                                a.iter()
                                    .map(|v| v.as_object().and_then(|o| o.get(f)).cloned())
                                    .collect()
                            });
                            None
                        }
                    };
                }
                if expr.count {
                    return truncate(
                        &projected
                            .as_ref()
                            .map(Vec::len)
                            .or_else(|| value.as_ref().and_then(Value::as_array).map(Vec::len))
                            .map(|n| n.to_string())
                            .unwrap_or_default(),
                        expr.cap,
                    );
                }
                if expr.each.is_some() || list || expr.join.is_some() {
                    let array = projected.or_else(|| {
                        value
                            .as_ref()
                            .and_then(Value::as_array)
                            .map(|a| a.iter().cloned().map(Some).collect())
                    });
                    let Some(array) = array else {
                        return String::new();
                    };
                    let elements: Vec<String> = array
                        .iter()
                        .map(|v| {
                            if let Some(each) = &expr.each {
                                render(each, v.as_ref(), None)
                            } else {
                                scalar(v.as_ref())
                            }
                        })
                        .collect();
                    return truncate(
                        &elements.join(expr.join.as_deref().unwrap_or(if expr.each.is_some() {
                            "; "
                        } else {
                            ", "
                        })),
                        expr.cap,
                    );
                }
                truncate(&scalar(value.as_ref()), expr.cap)
            }
        })
        .collect()
}
pub fn render_template(source: &str, input: &Value, output: Option<&Value>) -> Option<String> {
    let nodes = parse(source, false).ok()?;
    let text = scalar(output);
    let structured = match output {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(Value::is_object),
        other => other.cloned(),
    };
    let mut root = serde_json::Map::new();
    root.insert("input".into(), input.clone());
    if let Some(output) = structured {
        root.insert("output".into(), output);
    }
    Some(truncate(
        &render(&nodes, Some(&Value::Object(root)), Some(&text)),
        None,
    ))
}
pub fn defaults() -> &'static ExpansionMap {
    static DEFAULTS: OnceLock<ExpansionMap> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/shared/historian-tool-defaults.json"
        ))
        .expect("built-in tool templates")
    })
}
pub fn expand(
    name: &str,
    input: &Value,
    output: Option<&Value>,
    overrides: &ExpansionMap,
) -> Option<String> {
    let template = overrides
        .get(name)
        .or_else(|| defaults().get(name))?
        .as_str()?;
    let labeled = if overrides.contains_key(name) {
        input.clone()
    } else {
        builtin_input(name, input)
    };
    render_template(template, &labeled, output)
}

// Room actions, private-message addresses and board lanes have multiple input
// shapes. Derive readable labels only for built-ins; configured template overrides
// keep the unmodified tool input, just as they do in the TypeScript renderer.
fn builtin_input(name: &str, input: &Value) -> Value {
    let Some(mut labeled) = input.as_object().cloned() else {
        return input.clone();
    };
    let text = |key: &str| input[key].as_str().filter(|s| !s.is_empty());
    match name {
        "peer_send" => {
            let recipient = if let Some(reply) = text("reply_to_pmid") {
                format!("reply to {reply}")
            } else if let Some(agent) = text("agent").or_else(|| text("agent_id")) {
                format!("to {agent}")
            } else if let Some(session) = input["external"]["session_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| text("session_id"))
            {
                format!("to session {session}")
            } else {
                "to unknown recipient".into()
            };
            labeled.insert("recipient".into(), Value::String(recipient));
        }
        "room" => {
            labeled.insert(
                "room_label".into(),
                Value::String(
                    text("room_id")
                        .or_else(|| text("title"))
                        .unwrap_or_default()
                        .into(),
                ),
            );
            let detail = if matches!(text("action"), Some("create" | "invite")) {
                Value::String(format!(
                    "invitees: {}",
                    render_template("${input.invitees}", input, None).unwrap_or_default()
                ))
            } else {
                input["text"].clone()
            };
            if !detail.is_null() {
                labeled.insert("room_detail".into(), detail);
            }
        }
        "board" => {
            labeled.insert(
                "board_lane".into(),
                Value::String(text("lane").map(|s| format!(" {s}")).unwrap_or_default()),
            );
            if let Some(ops) = input["ops"].as_array() {
                let ops = ops
                    .iter()
                    .map(|op| {
                        let Some(mut op_labeled) = op.as_object().cloned() else {
                            return op.clone();
                        };
                        let lane = op["lane"]
                            .as_str()
                            .or_else(|| op["lane"]["title"].as_str())
                            .or_else(|| op["lane"]["id"].as_str());
                        if let Some(lane) = lane {
                            op_labeled.insert("lane_label".into(), Value::String(lane.into()));
                        }
                        Value::Object(op_labeled)
                    })
                    .collect();
                labeled.insert("ops".into(), Value::Array(ops));
            }
        }
        _ => {}
    }
    Value::Object(labeled)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_historian_tool_expansion_goldens() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/historian-tool-expansions.json"))
                .unwrap();
        let cases = fixture["defaults"].as_array().unwrap();
        assert_eq!(cases.len(), defaults().len());
        for case in cases {
            assert_eq!(
                expand(
                    case["tool"].as_str().unwrap(),
                    &case["input"],
                    case.get("output"),
                    &BTreeMap::new()
                )
                .unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["tool"]
            );
        }
        for case in fixture["variants"].as_array().unwrap() {
            assert_eq!(
                expand(
                    case["tool"].as_str().unwrap(),
                    &case["input"],
                    case.get("output"),
                    &BTreeMap::new()
                )
                .unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["label"]
            );
        }
        for case in fixture["templates"].as_array().unwrap() {
            let mut input = case.get("input").cloned().unwrap_or(serde_json::json!({}));
            for key in ["repeatInput", "repeatArray"] {
                if let Some(spec) = case.get(key) {
                    let text = spec["text"]
                        .as_str()
                        .unwrap()
                        .repeat(spec["count"].as_u64().unwrap() as usize);
                    input[spec["field"].as_str().unwrap()] = if key == "repeatArray" {
                        serde_json::json!([text])
                    } else {
                        Value::String(text)
                    };
                }
            }
            let expected = if let Some(spec) = case.get("expectedRepeat") {
                spec["text"]
                    .as_str()
                    .unwrap()
                    .repeat(spec["count"].as_u64().unwrap() as usize)
                    + spec["suffix"].as_str().unwrap()
            } else {
                case["expected"].as_str().unwrap().to_string()
            };
            assert_eq!(
                render_template(
                    case["template"].as_str().unwrap(),
                    &input,
                    case.get("output")
                )
                .unwrap(),
                expected,
                "{}",
                case["label"]
            );
        }
        for source in fixture["invalid"].as_array().unwrap() {
            assert!(!valid_template(source.as_str().unwrap()), "{source}");
            assert_eq!(
                render_template(source.as_str().unwrap(), &Value::Null, None),
                None
            );
        }
    }

    #[test]
    fn shared_historian_expanded_chunk_golden() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/historian-tool-expansions.json"))
                .unwrap();
        let messages: Vec<crate::ck_wire::CkIngressMessage> = fixture["messages"].as_array().unwrap().iter().map(|message| {
            let mut content = Vec::new();
            for part in message["parts"].as_array().unwrap() {
                if part["type"] == "text" { content.push(serde_json::json!({"kind": {"type": "text", "text": part["text"]}})); }
                else {
                    content.push(serde_json::json!({"kind": {"type": "tool_call", "id": part["callID"], "name": part["tool"], "input": part["state"]["input"]}}));
                    if let Some(output) = part["state"].get("output") {
                        content.push(serde_json::json!({"kind": {"type": "tool_result", "id": part["callID"], "tool_name": part["tool"], "output": {"kind": {"type": "text", "text": output}}}}));
                    }
                }
            }
            serde_json::from_value(serde_json::json!({"mid": message["id"], "ordinal": message["ordinal"], "ck": {"role": message["role"], "content": content}})).unwrap()
        }).collect();
        let projection = crate::ck_wire::project_messages(&messages).unwrap();
        let chunk = crate::historian_chunk::build_historian_chunk(
            &messages,
            &projection.blocks,
            1,
            10_000,
            4,
        );
        assert_eq!(chunk.text, fixture["chunk"].as_str().unwrap());
        assert_eq!(
            chunk.token_estimate,
            mc_tokenizer::estimate_tokens(&chunk.text)
        );
    }
}
