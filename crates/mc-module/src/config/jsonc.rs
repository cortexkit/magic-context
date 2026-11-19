//! Recovering JSONC reader for configuration. Like the plugin's jsonc-parser,
//! it keeps completed values after syntax errors and reports the first issue.
//! Reloads reject that issue; only the initial load uses recovered values.

use serde_json::{Map, Value};

pub(super) struct Parsed {
    pub value: Value,
    pub issue: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    OpenObject,
    CloseObject,
    OpenArray,
    CloseArray,
    Colon,
    Comma,
    String(String),
    Literal(Value),
    End,
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
    start: usize,
    token: Token,
    issue: Option<String>,
}

pub(super) fn parse(text: &str) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut parser = Parser {
        text,
        at: 0,
        start: 0,
        token: Token::End,
        issue: None,
    };
    parser.scan();
    let value = parser.value(0).unwrap_or_else(|| Value::Object(Map::new()));
    if parser.token != Token::End {
        parser.error("end of file expected");
    }
    Parsed {
        value,
        issue: parser.issue,
    }
}

impl Parser<'_> {
    fn error(&mut self, message: &str) {
        if self.issue.is_none() {
            let before = &self.text[..self.start];
            let line = before.bytes().filter(|byte| *byte == b'\n').count() + 1;
            let column = before
                .rsplit('\n')
                .next()
                .unwrap_or("")
                .encode_utf16()
                .count()
                + 1;
            self.issue = Some(format!("{line}:{column}: {message}"));
        }
    }

    fn scan(&mut self) {
        let bytes = self.text.as_bytes();
        loop {
            while self.at < bytes.len() && matches!(bytes[self.at], b' ' | b'\t' | b'\r' | b'\n') {
                self.at += 1;
            }
            self.start = self.at;
            let Some(&byte) = bytes.get(self.at) else {
                self.token = Token::End;
                return;
            };
            self.at += 1;
            self.token = match byte {
                b'{' => Token::OpenObject,
                b'}' => Token::CloseObject,
                b'[' => Token::OpenArray,
                b']' => Token::CloseArray,
                b':' => Token::Colon,
                b',' => Token::Comma,
                b'"' => Token::String(self.string()),
                b'/' if bytes.get(self.at) == Some(&b'/') => {
                    while self.at < bytes.len() && !matches!(bytes[self.at], b'\r' | b'\n') {
                        self.at += 1;
                    }
                    continue;
                }
                b'/' if bytes.get(self.at) == Some(&b'*') => {
                    self.at += 1;
                    while self.at + 1 < bytes.len() && &bytes[self.at..self.at + 2] != b"*/" {
                        self.at += 1;
                    }
                    if self.at + 1 < bytes.len() {
                        self.at += 2;
                    } else {
                        self.at = bytes.len();
                        self.error("unexpected end of comment");
                    }
                    continue;
                }
                b'/' => {
                    self.error("invalid symbol");
                    continue;
                }
                b'-' | b'0'..=b'9' => {
                    self.at = self.start;
                    if byte == b'-' {
                        self.at += 1;
                        if !bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                            self.error("invalid symbol");
                            continue;
                        }
                    }
                    Token::Literal(self.number())
                }
                _ => {
                    while self.at < bytes.len()
                        && !matches!(
                            bytes[self.at],
                            b' ' | b'\t'
                                | b'\r'
                                | b'\n'
                                | b'{'
                                | b'}'
                                | b'['
                                | b']'
                                | b':'
                                | b','
                                | b'"'
                                | b'/'
                        )
                    {
                        self.at += 1;
                    }
                    match &self.text[self.start..self.at] {
                        "true" => Token::Literal(Value::Bool(true)),
                        "false" => Token::Literal(Value::Bool(false)),
                        "null" => Token::Literal(Value::Null),
                        _ => {
                            self.error("invalid symbol");
                            continue;
                        }
                    }
                }
            };
            return;
        }
    }

    fn number(&mut self) -> Value {
        let bytes = self.text.as_bytes();
        let zero = bytes[self.at] == b'0';
        self.at += 1;
        if !zero {
            while bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
        }
        if bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.error("unexpected end of number");
                return self.number_literal(self.at);
            }
            while bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
        }
        let mut end = self.at;
        if bytes
            .get(self.at)
            .is_some_and(|byte| matches!(byte, b'e' | b'E'))
        {
            self.at += 1;
            if bytes
                .get(self.at)
                .is_some_and(|byte| matches!(byte, b'+' | b'-'))
            {
                self.at += 1;
            }
            if bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                while bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                    self.at += 1;
                }
                end = self.at;
            } else {
                self.error("unexpected end of number");
            }
        }
        self.number_literal(end)
    }

    fn number_literal(&self, end: usize) -> Value {
        // The plugin converts the scanner's recovered number spelling with
        // Number(), including a missing exponent's completed mantissa.
        let spelling = &self.text[self.start..end];
        serde_json::from_str(spelling).unwrap_or_else(|_| {
            let value = spelling.parse::<f64>().unwrap_or(0.0);
            serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
        })
    }

    fn string(&mut self) -> String {
        let mut out = String::new();
        let mut issue = None;
        while let Some(ch) = self.text[self.at..].chars().next() {
            self.at += ch.len_utf8();
            match ch {
                '"' => {
                    if let Some(issue) = issue {
                        self.error(issue);
                    }
                    return out;
                }
                '\r' | '\n' => {
                    self.at -= ch.len_utf8();
                    self.error("unexpected end of string");
                    return out;
                }
                '\\' => {
                    let Some(escape) = self.text[self.at..].chars().next() else {
                        break;
                    };
                    self.at += escape.len_utf8();
                    match escape {
                        '"' | '\\' | '/' => out.push(escape),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let end = self.at + 4;
                            let unit = self
                                .text
                                .get(self.at..end)
                                .and_then(|hex| u16::from_str_radix(hex, 16).ok());
                            if let Some(unit) = unit {
                                self.at = end;
                                let mut units = vec![unit];
                                if (0xd800..=0xdbff).contains(&unit)
                                    && self.text[self.at..].starts_with("\\u")
                                {
                                    if let Some(low) = self
                                        .text
                                        .get(self.at + 2..self.at + 6)
                                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                                        .filter(|low| (0xdc00..=0xdfff).contains(low))
                                    {
                                        units.push(low);
                                        self.at += 6;
                                    }
                                }
                                out.push_str(&String::from_utf16_lossy(&units));
                            } else {
                                while self
                                    .text
                                    .as_bytes()
                                    .get(self.at)
                                    .is_some_and(u8::is_ascii_hexdigit)
                                {
                                    self.at += 1;
                                }
                                issue = Some("invalid unicode");
                            }
                        }
                        _ => issue = Some("invalid escape character"),
                    }
                }
                ch if ch < '\u{20}' => {
                    issue = Some("invalid character");
                    out.push(ch);
                }
                _ => out.push(ch),
            }
        }
        self.error("unexpected end of string");
        out
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > 128 {
            self.error("nesting limit exceeded");
            self.token = Token::End;
            return None;
        }
        match self.token.clone() {
            Token::OpenObject => Some(self.object(depth + 1)),
            Token::OpenArray => Some(self.array(depth + 1)),
            Token::String(value) => {
                self.scan();
                Some(Value::String(value))
            }
            Token::Literal(value) => {
                self.scan();
                Some(value)
            }
            _ => {
                self.error("value expected");
                None
            }
        }
    }

    fn recover(&mut self, close: Token) {
        while self.token != Token::End && self.token != close && self.token != Token::Comma {
            self.scan();
        }
    }

    fn object(&mut self, depth: usize) -> Value {
        let mut map = Map::new();
        self.scan();
        let mut needs_comma = false;
        while !matches!(self.token, Token::CloseObject | Token::End) {
            if self.token == Token::Comma {
                if !needs_comma {
                    self.error("value expected");
                }
                self.scan();
                if self.token == Token::CloseObject {
                    break;
                }
            } else if needs_comma {
                self.error("comma expected");
            }
            if let Token::String(key) = self.token.clone() {
                self.scan();
                if self.token == Token::Colon {
                    self.scan();
                    if let Some(value) = self.value(depth) {
                        // These names cannot affect Rust objects, but discarding
                        // them matches the plugin's safe-object sanitizer.
                        if !matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
                            map.insert(key, value);
                        }
                    } else {
                        self.recover(Token::CloseObject);
                    }
                } else {
                    self.error("colon expected");
                    self.recover(Token::CloseObject);
                }
            } else {
                self.error("property name expected");
                self.recover(Token::CloseObject);
            }
            needs_comma = true;
        }
        if self.token == Token::CloseObject {
            self.scan();
        } else {
            self.error("close brace expected");
        }
        Value::Object(map)
    }

    fn array(&mut self, depth: usize) -> Value {
        let mut values = Vec::new();
        self.scan();
        let mut needs_comma = false;
        while !matches!(self.token, Token::CloseArray | Token::End) {
            if self.token == Token::Comma {
                if !needs_comma {
                    self.error("value expected");
                }
                self.scan();
                if self.token == Token::CloseArray {
                    break;
                }
            } else if needs_comma {
                self.error("comma expected");
            }
            if let Some(value) = self.value(depth) {
                values.push(value);
            } else {
                self.recover(Token::CloseArray);
            }
            needs_comma = true;
        }
        if self.token == Token::CloseArray {
            self.scan();
        } else {
            self.error("close bracket expected");
        }
        Value::Array(values)
    }
}

/// Where a value sits in the text: `start..end` are byte offsets.
#[cfg(any(test, feature = "managed-settings"))]
enum Node {
    Object {
        start: usize,
        end: usize,
        members: Vec<Member>,
    },
    Other {
        start: usize,
        end: usize,
    },
}

#[cfg(any(test, feature = "managed-settings"))]
impl Node {
    fn start(&self) -> usize {
        match self {
            Self::Object { start, .. } | Self::Other { start, .. } => *start,
        }
    }

    fn end(&self) -> usize {
        match self {
            Self::Object { end, .. } | Self::Other { end, .. } => *end,
        }
    }
}

/// One `"key": value` of an object, and the comma after it, if any.
#[cfg(any(test, feature = "managed-settings"))]
struct Member {
    key: String,
    key_start: usize,
    key_end: usize,
    value: Node,
    comma: Option<usize>,
}

#[cfg(any(test, feature = "managed-settings"))]
impl Parser<'_> {
    /// The value at the current token with the offsets of its parts, for a
    /// text that [`parse`] reads without an issue. `None` for anything else:
    /// an edit is only made to a file this reader understands completely.
    fn node(&mut self, depth: usize) -> Option<Node> {
        if depth > 128 {
            return None;
        }
        let start = self.start;
        match self.token.clone() {
            Token::OpenObject => {
                self.scan();
                let mut members = Vec::new();
                while self.token != Token::CloseObject {
                    let Token::String(key) = self.token.clone() else {
                        return None;
                    };
                    let (key_start, key_end) = (self.start, self.at);
                    self.scan();
                    if self.token != Token::Colon {
                        return None;
                    }
                    self.scan();
                    let value = self.node(depth + 1)?;
                    let comma = (self.token == Token::Comma).then_some(self.start);
                    members.push(Member {
                        key,
                        key_start,
                        key_end,
                        value,
                        comma,
                    });
                    if comma.is_some() {
                        self.scan();
                    } else if self.token != Token::CloseObject {
                        return None;
                    }
                }
                let end = self.at;
                self.scan();
                Some(Node::Object {
                    start,
                    end,
                    members,
                })
            }
            Token::OpenArray => {
                self.scan();
                while self.token != Token::CloseArray {
                    self.node(depth + 1)?;
                    if self.token == Token::Comma {
                        self.scan();
                    } else if self.token != Token::CloseArray {
                        return None;
                    }
                }
                let end = self.at;
                self.scan();
                Some(Node::Other { start, end })
            }
            Token::String(_) | Token::Literal(_) => {
                let end = self.at;
                self.scan();
                Some(Node::Other { start, end })
            }
            _ => None,
        }
    }
}

/// The top-level object of `text` with the offsets of its parts.
#[cfg(any(test, feature = "managed-settings"))]
fn tree(text: &str) -> Option<Node> {
    let mut parser = Parser {
        text,
        at: 0,
        start: 0,
        token: Token::End,
        issue: None,
    };
    parser.scan();
    let root = parser.node(0)?;
    (parser.token == Token::End && parser.issue.is_none() && matches!(root, Node::Object { .. }))
        .then_some(root)
}

/// Make `edits` to the text of a settings file, keeping its comments,
/// blank lines and layout everywhere outside the members they change. A
/// removed member takes its comma, and its line when nothing else is left
/// on it; a comment beside or above it stays. A new member goes after the
/// object's last member, on its own line when the object spans lines.
///
/// Refused, leaving the text as it is, when the file has a syntax issue, its
/// top level is not an object, an edit passes through a value that is not an
/// object, or the edited text would not read back as exactly the value the
/// edits make of the file's own value.
#[cfg(any(test, feature = "managed-settings"))]
pub(super) fn edit(text: &str, edits: &[super::edit::Edit]) -> Result<String, String> {
    let parsed = parse(text);
    if let Some(issue) = parsed.issue {
        return Err(format!("the file does not read cleanly ({issue})"));
    }
    let expected = super::edit::applied(&parsed.value, edits)?;
    let (bom, mut body) = match text.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest.to_owned()),
        None => ("", text.to_owned()),
    };
    for edit in edits {
        body = edit_once(&body, edit)?;
    }
    let reread = parse(&body);
    if reread.issue.is_some() || reread.value != expected {
        return Err("the edited file would not read back as the converted settings".into());
    }
    Ok(format!("{bom}{body}"))
}

#[cfg(any(test, feature = "managed-settings"))]
fn edit_once(text: &str, edit: &super::edit::Edit) -> Result<String, String> {
    use super::edit::Edit;

    let root = tree(text).ok_or("the file does not read cleanly")?;
    let keys = super::edit::keys(edit.pointer())?;
    let Some((last, parents)) = keys.split_last() else {
        return Err("an edit must name a member, not the whole file".into());
    };
    // Walk to the deepest object on the path that exists.
    let mut object = &root;
    let mut depth = 0;
    while depth < parents.len() {
        let Node::Object { members, .. } = object else {
            unreachable!("only objects are walked");
        };
        match members
            .iter()
            .rev()
            .find(|member| member.key == parents[depth])
        {
            Some(member) if matches!(member.value, Node::Object { .. }) => {
                object = &member.value;
                depth += 1;
            }
            Some(_) => {
                return Err(format!(
                    "{} passes through a value that is not an object",
                    edit.pointer()
                ))
            }
            None => break,
        }
    }
    let Node::Object { members, .. } = object else {
        unreachable!("only objects are walked");
    };
    let found = (depth == parents.len())
        .then(|| members.iter().rposition(|member| &member.key == last))
        .flatten();
    match edit {
        Edit::Set { value, .. } => match found {
            Some(index) => {
                let member = &members[index];
                Ok(splice(
                    text,
                    member.value.start(),
                    member.value.end(),
                    &render(value),
                ))
            }
            None => {
                // The new member nests the rest of the path around the value.
                let mut nested = value.clone();
                for key in keys[depth + 1..].iter().rev() {
                    nested = Value::Object(Map::from_iter([(key.clone(), nested)]));
                }
                Ok(insert_member(text, object, &keys[depth], &nested))
            }
        },
        Edit::Remove { .. } => {
            let mut text = text.to_owned();
            // A key written twice is read from its last spelling; every
            // spelling goes, so an earlier one cannot come back into effect.
            while let Some(index) = found_in(&text, &keys) {
                let root = tree(&text).ok_or("the file does not read cleanly")?;
                let parent = object_at(&root, parents).ok_or("the member's object is gone")?;
                text = remove_member(&text, parent, index);
            }
            Ok(text)
        }
        Edit::Rename { to, .. } => {
            let index = found.ok_or_else(|| format!("{} does not exist", edit.pointer()))?;
            if members.iter().any(|member| &member.key == to) {
                return Err(format!("{} already has a member {to:?}", edit.pointer()));
            }
            let member = &members[index];
            Ok(splice(
                text,
                member.key_start,
                member.key_end,
                &Value::String(to.clone()).to_string(),
            ))
        }
    }
}

/// The object a path of keys names, when every key on it is an object.
#[cfg(any(test, feature = "managed-settings"))]
fn object_at<'a>(root: &'a Node, keys: &[String]) -> Option<&'a Node> {
    let mut node = root;
    for key in keys {
        let Node::Object { members, .. } = node else {
            return None;
        };
        node = &members
            .iter()
            .rev()
            .find(|member| &member.key == key)?
            .value;
    }
    matches!(node, Node::Object { .. }).then_some(node)
}

/// The index, in its object, of the first member the full path names.
#[cfg(any(test, feature = "managed-settings"))]
fn found_in(text: &str, keys: &[String]) -> Option<usize> {
    let (last, parents) = keys.split_last()?;
    let root = tree(text)?;
    let Node::Object { members, .. } = object_at(&root, parents)? else {
        return None;
    };
    members.iter().position(|member| &member.key == last)
}

#[cfg(any(test, feature = "managed-settings"))]
fn splice(text: &str, start: usize, end: usize, with: &str) -> String {
    format!("{}{with}{}", &text[..start], &text[end..])
}

/// A value written inline: `{ "kind": "tokens", "tokens": 8000 }`, with a
/// union's `kind` first so the variant reads before its fields.
#[cfg(any(test, feature = "managed-settings"))]
fn render(value: &Value) -> String {
    match value {
        Value::Object(map) if map.is_empty() => "{}".to_owned(),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key != "kind");
            let entries: Vec<String> = entries
                .into_iter()
                .map(|(key, value)| format!("{}: {}", Value::String(key.clone()), render(value)))
                .collect();
            format!("{{ {} }}", entries.join(", "))
        }
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(render).collect();
            format!("[{}]", items.join(", "))
        }
        other => other.to_string(),
    }
}

/// The whitespace before `at` on its line, when only whitespace is there.
#[cfg(any(test, feature = "managed-settings"))]
fn line_indent(text: &str, at: usize) -> Option<&str> {
    let line_start = text[..at].rfind('\n').map_or(0, |newline| newline + 1);
    let before = &text[line_start..at];
    before
        .bytes()
        .all(|byte| matches!(byte, b' ' | b'\t'))
        .then_some(before)
}

#[cfg(any(test, feature = "managed-settings"))]
fn newline(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

#[cfg(any(test, feature = "managed-settings"))]
fn insert_member(text: &str, object: &Node, key: &str, value: &Value) -> String {
    let Node::Object {
        start,
        end,
        members,
    } = object
    else {
        unreachable!("members are inserted into objects");
    };
    let entry = format!("{}: {}", Value::String(key.to_owned()), render(value));
    let newline = newline(text);
    let Some(last) = members.last() else {
        // An empty object: the member goes right after its brace.
        if text[*start..*end].contains('\n') {
            let indent = line_indent(text, end - 1).unwrap_or("");
            return splice(
                text,
                start + 1,
                start + 1,
                &format!("{newline}{indent}  {entry}"),
            );
        }
        return splice(text, start + 1, start + 1, &format!(" {entry} "));
    };
    let after_value = last.comma.map_or(last.value.end(), |comma| comma + 1);
    if let Some(indent) = line_indent(text, last.key_start) {
        // The rest of the last member's line, past spaces and a line
        // comment, must end there for the new member to take a line of its
        // own below it.
        let bytes = text.as_bytes();
        let mut at = after_value;
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
            at += 1;
        }
        if text[at..].starts_with("//") {
            at += text[at..].find('\n').unwrap_or(text.len() - at);
        }
        let line_end = if text[at..].starts_with("\r\n") || text[at..].starts_with('\n') {
            Some(at)
        } else {
            None
        };
        if let Some(line_end) = line_end {
            // `at` sits on the `\n` of a `\r\n`; the member goes before both.
            let line_end = if line_end > 0 && bytes[line_end - 1] == b'\r' {
                line_end - 1
            } else {
                line_end
            };
            let text = splice(
                text,
                line_end,
                line_end,
                &format!("{newline}{indent}{entry}"),
            );
            return match last.comma {
                Some(_) => text,
                None => splice(&text, last.value.end(), last.value.end(), ","),
            };
        }
    }
    match last.comma {
        Some(comma) => splice(text, comma + 1, comma + 1, &format!(" {entry}")),
        None => splice(
            text,
            last.value.end(),
            last.value.end(),
            &format!(", {entry}"),
        ),
    }
}

#[cfg(any(test, feature = "managed-settings"))]
fn remove_member(text: &str, object: &Node, index: usize) -> String {
    let Node::Object { members, .. } = object else {
        unreachable!("members are removed from objects");
    };
    let member = &members[index];
    let previous_comma = index
        .checked_sub(1)
        .and_then(|previous| members[previous].comma);
    let (text, key_start) = match (member.comma, previous_comma) {
        (Some(comma), _) => (
            splice(text, member.key_start, comma + 1, ""),
            member.key_start,
        ),
        // The last member gives up the comma before it instead.
        (None, Some(comma)) => {
            let text = splice(text, member.key_start, member.value.end(), "");
            (splice(&text, comma, comma + 1, ""), member.key_start - 1)
        }
        (None, None) => (
            splice(text, member.key_start, member.value.end(), ""),
            member.key_start,
        ),
    };
    // A line left holding only whitespace goes too.
    let line_start = text[..key_start]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    let line_end = text[key_start..]
        .find('\n')
        .map_or(text.len(), |newline| key_start + newline);
    if text[line_start..line_end].trim().is_empty() {
        let through = (line_end + 1).min(text.len());
        return splice(&text, line_start, through, "");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_keeps_completed_values_and_reports_syntax_issues() {
        for (text, expected) in [
            (r#"\{"a":1}"#, json!({"a":1})),
            (r#"{"a":1 "b":2}"#, json!({"a":1,"b":2})),
            (r#"{"a":1,"b": [2, 3"#, json!({"a":1,"b":[2,3]})),
            (r#"{"bad" 1, "good":2}"#, json!({"good":2})),
            (r#"{"bad":, "good":2}"#, json!({"good":2})),
            (r#"{"a":1} true"#, json!({"a":1})),
            (r#"{"a":1} /* unfinished"#, json!({"a":1})),
            (r#"{"s":"unterminated"#, json!({"s":"unterminated"})),
            (r#"{"n":12e,"ok":true}"#, json!({"n":12,"ok":true})),
            (r#"{"n":01,"ok":true}"#, json!({"n":0,"ok":true})),
            (r#"{"s":"\u0x", "ok":true}"#, json!({"s":"x","ok":true})),
            (r#"{"flag":/false}"#, json!({"flag":false})),
            (r#"{"n":4.e4,"ok":true}"#, json!({"n":4.0,"ok":true})),
        ] {
            let parsed = parse(text);
            assert_eq!(parsed.value, expected, "{text}");
            assert!(parsed.issue.is_some(), "{text}");
        }
    }

    #[test]
    fn comments_do_not_join_tokens_and_strings_keep_unicode() {
        let parsed = parse(r#"{"a":tr/*comment*/ue,"s":"\ud83d\ude00", "t":"/* literal */",}"#);
        assert_eq!(parsed.value, json!({"s":"😀","t":"/* literal */"}));
        assert!(parsed.issue.is_some());
    }
}
