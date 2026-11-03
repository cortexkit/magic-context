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
