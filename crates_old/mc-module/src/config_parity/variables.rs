//! Expand {env:} and {file:} only in user config text, escaping values before JSON
//! parsing. Relative file paths use the user file's directory, never the project cwd.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde_json::{Map, Value};

use super::Warning;

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    result
}

pub(crate) fn comments(text: &str) -> String {
    strip_comments(text, false).0
}
fn strip_comments(text: &str, recovering: bool) -> (String, bool) {
    let mut invalid = false;
    let mut chars = text.chars().peekable();
    let mut result = String::new();
    let (mut quoted, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if quoted {
            result.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' || recovering && (c == '\n' || c == '\r') {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            result.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            if recovering {
                result.push(' ');
            }
            chars.next();
            for c in chars.by_ref() {
                if c == '\n' || recovering && c == '\r' {
                    result.push(c);
                    break;
                }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            if recovering {
                result.push(' ');
            }
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    closed = true;
                    break;
                }
            }
            if !closed {
                invalid = true;
            }
        } else {
            result.push(c);
        }
    }
    (result, invalid)
}

fn escaped(text: &str) -> String {
    let quoted = serde_json::to_string(text).expect("string serialization");
    quoted[1..quoted.len() - 1].to_owned()
}

pub(crate) fn substitute(
    text: &str,
    path: &Path,
    project: bool,
    home: &Path,
    env: &BTreeMap<String, String>,
    warnings: &mut Vec<Warning>,
) -> (String, bool) {
    let env_pattern = Regex::new(r"\{env:([^}]+)\}").unwrap();
    let file_pattern = Regex::new(r"\{file:([^}]+)\}").unwrap();
    if project {
        let tokens = env_pattern.is_match(text) || file_pattern.is_match(text);
        if tokens {
            warnings.push(Warning::new(
                "project_substitution",
                "Project tokens remain literal; secret expansion is user-level only.",
            ));
        }
        return (text.to_owned(), tokens);
    }
    let before = warnings.len();
    let text = comments(text);
    let text = env_pattern.replace_all(&text, |m: &regex::Captures<'_>| {
        let key = trim(&m[1]);
        match env.get(key).filter(|v| !v.is_empty()) {
            Some(value) => escaped(value),
            None => {
                warnings.push(Warning::new(
                    "env_missing",
                    "Environment variable is not set; using empty string.",
                ));
                String::new()
            }
        }
    });
    let text = file_pattern.replace_all(&text, |m: &regex::Captures<'_>| {
        let raw = trim(&m[1]);
        let target = if let Some(relative) = raw.strip_prefix("~/") {
            home.join(relative)
        } else if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            path.parent().unwrap_or(Path::new(".")).join(raw)
        };
        let target = normalize(&target);
        if [".ssh", ".aws", ".gnupg", ".config/gh"]
            .iter()
            .any(|dir| target.starts_with(normalize(&home.join(dir))))
        {
            warnings.push(Warning::new(
                "file_sensitive",
                "User substitution reads a sensitive path; ensure this is intentional.",
            ));
        }
        if !target.exists() {
            warnings.push(Warning::new(
                "file_missing",
                "Substitution file is missing; using empty string.",
            ));
            return String::new();
        }
        match std::fs::read(&target) {
            Ok(bytes) => escaped(trim(&String::from_utf8_lossy(&bytes))),
            Err(_) => {
                warnings.push(Warning::new(
                    "file_read",
                    "Substitution file cannot be read; using empty string.",
                ));
                String::new()
            }
        }
    });
    (text.into_owned(), warnings.len() != before)
}

/// Keep recovered JSONC values, but report syntax errors so background work can pause.
/// Returns the object, syntax-error flag, rejected-key flag, and protected-tool key order.
pub(crate) fn parse(text: &str, warnings: &mut Vec<Warning>) -> (Value, bool, bool, Vec<String>) {
    let (cleaned, comment_error) = strip_comments(text, true);
    let mut parser = Parser {
        text: cleaned.trim_start_matches('\u{feff}').as_bytes(),
        at: 0,
        invalid: text.starts_with('\u{feff}') || comment_error,
        scope: Vec::new(),
        tool_order: Vec::new(),
    };
    let parsed = parser.value();
    if parsed.is_none() {
        parser.invalid = true;
    }
    let value = parsed.unwrap_or(Value::Null);
    parser.space();
    if parser.at != parser.text.len() {
        parser.invalid = true;
    }
    let mut value = if value.is_object() {
        value
    } else {
        Value::Object(Map::new())
    };
    let mut unsafe_keys = false;
    fn sanitize(value: &mut Value, unsafe_keys: &mut bool) {
        if let Some(object) = value.as_object_mut() {
            for key in ["__proto__", "constructor", "prototype"] {
                if object.remove(key).is_some() {
                    *unsafe_keys = true;
                }
            }
            for value in object.values_mut() {
                sanitize(value, unsafe_keys);
            }
        } else if let Some(array) = value.as_array_mut() {
            for value in array {
                sanitize(value, unsafe_keys);
            }
        }
    }
    sanitize(&mut value, &mut unsafe_keys);
    if parser.invalid {
        warnings.push(Warning::new(
            "file_parse",
            "Config syntax requires repair; recovered values were applied.",
        ));
    }
    if unsafe_keys {
        warnings.push(Warning::new(
            "unsafe_key",
            "Prototype-pollution keys are not allowed.",
        ));
    }
    parser.tool_order.sort_by_key(|key| {
        let index = key
            .parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == *key);
        (index.is_none(), index.unwrap_or(0))
    });
    (value, parser.invalid, unsafe_keys, parser.tool_order)
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
    invalid: bool,
    scope: Vec<String>,
    tool_order: Vec<String>,
}
impl Parser<'_> {
    fn space(&mut self) {
        while self
            .text
            .get(self.at)
            .is_some_and(|c| b" \t\r\n".contains(c))
        {
            self.at += 1;
        }
    }
    fn take(&mut self, c: u8) -> bool {
        self.space();
        if self.text.get(self.at) == Some(&c) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn string(&mut self) -> Option<String> {
        self.space();
        if self.text.get(self.at) != Some(&b'"') {
            self.invalid = true;
            if self.unknown() {
                return self.string();
            }
            return None;
        }
        self.at += 1;
        let mut units = Vec::new();
        while self.at < self.text.len() {
            let c = self.text[self.at];
            if c == b'"' {
                self.at += 1;
                return Some(String::from_utf16_lossy(&units));
            }
            if c == b'\n' || c == b'\r' {
                self.invalid = true;
                return Some(String::from_utf16_lossy(&units));
            }
            self.at += 1;
            if c == b'\\' {
                let Some(escape) = self.text.get(self.at).copied() else {
                    break;
                };
                self.at += 1;
                let character = match escape {
                    b'"' => Some('"'),
                    b'\\' => Some('\\'),
                    b'/' => Some('/'),
                    b'b' => Some('\u{8}'),
                    b'f' => Some('\u{c}'),
                    b'n' => Some('\n'),
                    b'r' => Some('\r'),
                    b't' => Some('\t'),
                    b'u' => {
                        let mut code = 0u16;
                        let mut digits = 0;
                        while digits < 4 {
                            let Some(digit) = self
                                .text
                                .get(self.at)
                                .and_then(|c| (*c as char).to_digit(16))
                            else {
                                break;
                            };
                            self.at += 1;
                            digits += 1;
                            code = (code << 4) | digit as u16;
                        }
                        if digits == 4 {
                            units.push(code);
                        } else {
                            self.invalid = true;
                        }
                        None
                    }
                    _ => {
                        self.invalid = true;
                        None
                    }
                };
                if let Some(character) = character {
                    units.push(character as u16);
                }
            } else {
                if c < 32 {
                    self.invalid = true;
                }
                if c < 128 {
                    units.push(c as u16);
                } else {
                    self.at -= 1;
                    let text = std::str::from_utf8(&self.text[self.at..]).ok()?;
                    let character = text.chars().next()?;
                    self.at += character.len_utf8();
                    units.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
        }
        self.invalid = true;
        Some(String::from_utf16_lossy(&units))
    }
    fn value(&mut self) -> Option<Value> {
        self.space();
        match self.text.get(self.at).copied()? {
            b'{' => {
                self.at += 1;
                let mut object = Map::new();
                while !self.take(b'}') && self.at < self.text.len() {
                    let key = match self.string() {
                        Some(key) => key,
                        None => {
                            self.skip();
                            if self.take(b',') {
                                continue;
                            }
                            break;
                        }
                    };
                    if !self.take(b':') {
                        self.invalid = true;
                        self.skip();
                        self.take(b',');
                        continue;
                    }
                    if self.scope == ["protected_tools"] && !self.tool_order.contains(&key) {
                        self.tool_order.push(key.clone());
                    }
                    self.scope.push(key.clone());
                    if let Some(value) = self.value() {
                        object.insert(key, value);
                    } else {
                        self.skip();
                    }
                    self.scope.pop();
                    if !self.take(b',') && self.text.get(self.at) != Some(&b'}') {
                        self.invalid = true;
                    }
                }
                if self.text.get(self.at.wrapping_sub(1)) != Some(&b'}') {
                    self.invalid = true;
                }
                Some(Value::Object(object))
            }
            b'[' => {
                self.at += 1;
                let mut array = Vec::new();
                while !self.take(b']') && self.at < self.text.len() {
                    let start = self.at;
                    if let Some(value) = self.value() {
                        array.push(value);
                    } else {
                        self.skip();
                    }
                    if !self.take(b',') && self.text.get(self.at) != Some(&b']') {
                        self.invalid = true;
                    }
                    if start == self.at
                        && !self.text.get(self.at).is_some_and(|c| b",]}".contains(c))
                    {
                        self.skip();
                    }
                }
                Some(Value::Array(array))
            }
            b'"' => self.string().map(Value::String),
            _ => {
                if self.text[self.at].is_ascii_digit()
                    || self.text[self.at] == b'-'
                        && self.text.get(self.at + 1).is_some_and(u8::is_ascii_digit)
                {
                    return self.number();
                }
                if self.unknown() {
                    return self.value();
                }
                let start = self.at;
                while self
                    .text
                    .get(self.at)
                    .is_some_and(|c| !b" \t\r\n{}[]\":,/".contains(c))
                {
                    self.at += 1;
                }
                if start == self.at {
                    self.invalid = true;
                    return None;
                }
                match &self.text[start..self.at] {
                    b"true" => Some(Value::Bool(true)),
                    b"false" => Some(Value::Bool(false)),
                    b"null" => Some(Value::Null),
                    _ => {
                        self.invalid = true;
                        None
                    }
                }
            }
        }
    }
    fn unknown(&mut self) -> bool {
        let Some(c) = self.text.get(self.at).copied() else {
            return false;
        };
        if b" \t\r\n{}[]\":,".contains(&c)
            || c.is_ascii_digit()
            || c == b'-' && self.text.get(self.at + 1).is_some_and(u8::is_ascii_digit)
        {
            return false;
        }
        let mut end = self.at;
        while self
            .text
            .get(end)
            .is_some_and(|c| !b" \t\r\n{}[]\":,/".contains(c))
        {
            end += 1;
        }
        if [b"true".as_slice(), b"false", b"null"].contains(&&self.text[self.at..end]) {
            return false;
        }
        self.at = end.max(self.at + 1);
        self.invalid = true;
        true
    }
    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        if self.text.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        if self.text.get(self.at) == Some(&b'0') {
            self.at += 1;
        } else {
            while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
        }
        if self.text.get(self.at) == Some(&b'.') {
            self.at += 1;
            let begin = self.at;
            while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
            if begin == self.at {
                self.invalid = true;
            }
        }
        let mut end = self.at;
        if self
            .text
            .get(self.at)
            .is_some_and(|c| *c == b'e' || *c == b'E')
        {
            self.at += 1;
            if self
                .text
                .get(self.at)
                .is_some_and(|c| *c == b'+' || *c == b'-')
            {
                self.at += 1;
            }
            let begin = self.at;
            while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                self.at += 1;
            }
            if begin == self.at {
                self.invalid = true;
            } else {
                end = self.at;
            }
        }
        let number = std::str::from_utf8(&self.text[start..end])
            .ok()?
            .parse::<f64>()
            .unwrap_or(0.0);
        Some(if !number.is_finite() {
            Value::Null
        } else if number.fract() == 0.0 && number >= i64::MIN as f64 && number < i64::MAX as f64 {
            Value::from(number as i64)
        } else {
            Value::from(number)
        })
    }
    fn skip(&mut self) {
        self.invalid = true;
        while self.text.get(self.at).is_some_and(|c| !b",]}".contains(c)) {
            if self.text[self.at] == b'"' {
                self.string();
            } else {
                self.at += 1;
            }
        }
    }
}
