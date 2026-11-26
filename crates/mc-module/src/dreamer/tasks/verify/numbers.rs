//! The numbers a memory states, read as quantities with their units, and the
//! forms code may write each one in. A confirmation's cited lines must hold
//! every number the memory states ([`super::confirm`]), in any equal form, or
//! the confirmation's `derive` must compute it from numbers they hold.
//!
//! What counts as one number ([`quantities`]):
//! - digits, with `_` or `,` separators (`64_000`, `64,000`), a decimal part
//!   (`0.05`) or an exponent (`1e6`);
//! - with a unit joined to it, after one space, or after a hyphen (`64k`,
//!   `5%`, `15 s`, `21-byte`, `64 MiB`). `k`/`K` multiply a count by 1,000
//!   and `M` by 1,000,000, joined only. A percent is its fraction (5% is
//!   0.05). A time is in milliseconds (ms, s, sec, min, h, hour, day). A size
//!   is in bytes (KB, MB, GB, TB by 1,000; KiB, MiB, GiB, TiB by 1,024).
//!
//! What is not a quantity, and is never checked:
//! - dates (`2026-11-16`, `16 Nov`, `Nov 16, 2026`) and times of day
//!   (`12:58`, `9am`);
//! - versions: three or more dotted parts (`0.49.55`), and two dotted parts
//!   next to a word that names a release (`since 0.49`, `the 0.50 line`,
//!   `0.49's`, `Opus 5.5`);
//! - references: after `#` or `§`, after a word that numbers things
//!   (`phase 3`, `row 12`, `step 2`), and line numbers (`task.rs:12`);
//! - hexadecimal hashes and ids (`7fca5ac695`);
//! - digits inside a code name or a path (`u64`, `MC-D12`, `m[0]`,
//!   `crates/v2/x.rs`), and digits joined to letters that are not a unit
//!   (`1st`, `3x`).
//!
//! Two quantities are equal ([`same`]) when they have the same kind and
//! value, or when one is a plain number the other can be written as: a time
//! in any of its units (15 s as 15 or 15000), a size in any of its units, a
//! percent as itself or its fraction (5% as 5 or 0.05).

use std::sync::OnceLock;

use regex::Regex;

use super::cites::path_shaped;

/// What a number measures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dim {
    Count,
    /// A share, held as its fraction.
    Percent,
    /// A duration, in milliseconds.
    Time,
    /// A size, in bytes.
    Bytes,
}

/// One number a text states.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Quantity {
    /// As the text writes it, unit included.
    pub raw: String,
    /// In the base unit of its kind ([`Dim`]).
    pub value: f64,
    pub dim: Dim,
}

/// Words after which a number names an item rather than counting anything:
/// `phase 3`, `row 12`, `step 2`.
const LABELS: &[&str] = &[
    "attempt",
    "batch",
    "case",
    "chapter",
    "commit",
    "day",
    "fence",
    "figure",
    "invariant",
    "issue",
    "item",
    "level",
    "line",
    "lines",
    "migration",
    "mode",
    "option",
    "page",
    "part",
    "phase",
    "pr",
    "round",
    "row",
    "rows",
    "rule",
    "run",
    "schema",
    "section",
    "spec",
    "stage",
    "step",
    "table",
    "tier",
    "version",
    "week",
];

/// Words before a two-part dotted number that make it a version: release
/// words, and the names of products and models that carry versions.
const RELEASE_BEFORE: &[&str] = &[
    "after", "before", "bun", "cargo", "claude", "context", "deepseek", "fable", "from", "gemini",
    "gpt", "haiku", "in", "mc", "mythos", "node", "npm", "omp", "on", "opencode", "opus", "pi",
    "post", "pre", "qwen", "release", "releases", "rust", "since", "sonnet", "through", "to",
    "until", "v", "version", "versions",
];

/// Words after a two-part dotted number that make it a version.
const RELEASE_AFTER: &[&str] = &[
    "branch",
    "build",
    "builds",
    "code",
    "crate",
    "dreamer",
    "era",
    "host",
    "hosts",
    "lane",
    "line",
    "lines",
    "module",
    "plugin",
    "release",
    "releases",
    "rust",
    "series",
    "transform",
    "typescript",
];

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a fixed number pattern"))
}

/// The unit `word` names, as its kind and how many base units one of it is.
/// `joined` says whether the word follows the digits without a space:
/// `k`, `K` and `M` count only then.
fn unit(word: &str, joined: bool) -> Option<(Dim, f64)> {
    if joined {
        match word {
            "k" | "K" => return Some((Dim::Count, 1e3)),
            "M" => return Some((Dim::Count, 1e6)),
            _ => {}
        }
    }
    let kib = 1024.0_f64;
    Some(match word.to_ascii_lowercase().as_str() {
        "ms" | "msec" | "msecs" | "millisecond" | "milliseconds" => (Dim::Time, 1.0),
        "s" | "sec" | "secs" | "second" | "seconds" => (Dim::Time, 1e3),
        "min" | "mins" | "minute" | "minutes" => (Dim::Time, 6e4),
        "h" | "hr" | "hrs" | "hour" | "hours" => (Dim::Time, 3.6e6),
        "day" | "days" => (Dim::Time, 8.64e7),
        "byte" | "bytes" => (Dim::Bytes, 1.0),
        "b" if word == "B" => (Dim::Bytes, 1.0),
        "kb" => (Dim::Bytes, 1e3),
        "mb" => (Dim::Bytes, 1e6),
        "gb" => (Dim::Bytes, 1e9),
        "tb" => (Dim::Bytes, 1e12),
        "kib" => (Dim::Bytes, kib),
        "mib" => (Dim::Bytes, kib.powi(2)),
        "gib" => (Dim::Bytes, kib.powi(3)),
        "tib" => (Dim::Bytes, kib.powi(4)),
        _ => return None,
    })
}

fn word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// The digits of a number token as a value: `_` separators dropped, `,`
/// separators dropped when they group thousands. `None` for a list such as
/// `1,2,3`.
fn digits_value(token: &str) -> Option<f64> {
    static THOUSANDS: OnceLock<Regex> = OnceLock::new();
    if token.contains(',')
        && !re(&THOUSANDS, r"^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$").is_match(token)
    {
        return None;
    }
    token.replace(['_', ','], "").parse::<f64>().ok()
}

/// The unit after a number, read from `rest`, the text right after its
/// digits: its kind, its size in base units, and how many bytes of `rest`
/// it takes. `Ok(None)` when no unit follows; `Err(())` when letters are
/// joined to the digits and are no unit, so the digits belong to a word.
fn unit_after(rest: &str) -> Result<Option<(Dim, f64, usize)>, ()> {
    if rest.starts_with('%') {
        return Ok(Some((Dim::Percent, 0.01, 1)));
    }
    if let Some(after_space) = rest.strip_prefix(' ') {
        if after_space.starts_with('%') {
            return Ok(Some((Dim::Percent, 0.01, 2)));
        }
    }
    let leading_word = |text: &str| -> usize {
        text.char_indices()
            .find(|(_, ch)| !ch.is_ascii_alphabetic())
            .map_or(text.len(), |(at, _)| at)
    };
    let ends_word = |text: &str| !text.chars().next().is_some_and(word_char);
    let joined = leading_word(rest);
    if joined > 0 {
        if !ends_word(&rest[joined..]) {
            return Err(());
        }
        return match unit(&rest[..joined], true) {
            Some((dim, size)) => Ok(Some((dim, size, joined))),
            None => Err(()),
        };
    }
    if rest.starts_with(char::is_alphanumeric) || rest.starts_with('_') {
        return Err(());
    }
    for gap in [" ", "-"] {
        let Some(after) = rest.strip_prefix(gap) else {
            continue;
        };
        let length = leading_word(after);
        if length == 0 || !ends_word(&after[length..]) {
            continue;
        }
        if let Some((dim, size)) = unit(&after[..length], false) {
            return Ok(Some((dim, size, gap.len() + length)));
        }
    }
    Ok(None)
}

/// Whether the bare number at byte `at` of `text` is part of a name: it
/// follows one space after a capitalized word that doesn't start its
/// sentence (`the Channel 1 nudge`), or one with a capital inside it at any
/// place (`OpenCode 2`, `GitHub 3`). Such a number names a product version
/// or an item (`Channel 2`, `Oh My Pi 19`) and is no quantity code must
/// hold; a sentence's own first word, such as `Keep 3 copies`, is read as
/// prose, so its number stays a quantity.
fn names_item(text: &str, at: usize) -> bool {
    let Some(head) = text[..at].strip_suffix(' ') else {
        return false;
    };
    let start = head
        .char_indices()
        .rev()
        .find(|(_, ch)| !(ch.is_alphanumeric() || *ch == '-'))
        .map_or(0, |(index, ch)| index + ch.len_utf8());
    let word = &head[start..];
    if !word.chars().next().is_some_and(char::is_uppercase) {
        return false;
    }
    if word.chars().skip(1).any(char::is_uppercase) {
        return true;
    }
    let before = head[..start].trim_end();
    !(before.is_empty() || before.ends_with(['.', '!', '?', ':', '\n']))
}

/// The lowercase word right before byte `at` of `text`, across spaces.
fn word_before(text: &str, at: usize) -> String {
    let head = text[..at].trim_end_matches([' ', '\t']);
    let start = head
        .char_indices()
        .rev()
        .find(|(_, ch)| !(ch.is_alphanumeric() || *ch == '-'))
        .map_or(0, |(at, ch)| at + ch.len_utf8());
    head[start..].to_lowercase()
}

/// The lowercase word that starts `text`, after spaces.
fn word_after(text: &str) -> String {
    let tail = text.trim_start_matches([' ', '\t']);
    tail.chars()
        .take_while(|ch| ch.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// `text` with every date, time of day, hexadecimal id and path blanked
/// out, byte for byte, so no number inside one is read.
fn mask(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?".to_owned(),
            r"\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\s?[AaPp]\.?[Mm]\.?|Z)?".to_owned(),
            r"\b[0-9]{1,2}\s?(?:am|pm|AM|PM)\b".to_owned(),
            format!(r"(?i)\b[0-9]{{1,2}}(?:st|nd|rd|th)?\s+{months}\b\.?(?:,?\s+[0-9]{{4}})?"),
            format!(r"(?i)\b{months}\.?\s+[0-9]{{1,2}}(?:st|nd|rd|th)?\b(?:,?\s+[0-9]{{4}})?"),
            format!(r"(?i)\b{months}\.?\s+[0-9]{{4}}\b"),
            r"\b[0-9a-fA-F]{7,}\b".to_owned(),
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("a fixed mask pattern"))
        .collect()
    });
    let mut bytes = text.as_bytes().to_vec();
    let mut blank = |range: std::ops::Range<usize>| bytes[range].fill(b' ');
    for (index, pattern) in patterns.iter().enumerate() {
        for found in pattern.find_iter(text) {
            let hex = index == patterns.len() - 1;
            let token = found.as_str();
            // Only an id holds both digits and letters; plain digits are a
            // number and plain letters a word.
            if hex
                && !(token.bytes().any(|byte| byte.is_ascii_digit())
                    && token.bytes().any(|byte| byte.is_ascii_alphabetic()))
            {
                continue;
            }
            blank(found.range());
        }
    }
    for found in re(&TOKEN, r"[A-Za-z0-9_.@+/~-]+").find_iter(text) {
        let token = found.as_str().trim_end_matches(['.', '-']);
        let slashed = token.contains('/')
            && !token
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == '/' || ch == '.');
        if slashed || path_shaped(token) {
            blank(found.range());
        }
    }
    String::from_utf8(bytes).expect("only whole characters are blanked")
}

/// Every quantity `text` states, in order (see the module's rules).
pub(crate) fn quantities(text: &str) -> Vec<Quantity> {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    static EXPONENT: OnceLock<Regex> = OnceLock::new();
    static LITERAL: OnceLock<Regex> = OnceLock::new();
    let masked = mask(text);
    let mut found = Vec::new();
    for token in re(&NUMBER, r"[0-9](?:[0-9_]|[.,][0-9])*").find_iter(&masked) {
        let (start, mut end) = (token.start(), token.end());
        let digits = token.as_str();
        // What precedes the number is read in the text itself: a blanked
        // path or id still makes `task.rs:12` a line number.
        let before = text[..start].chars().next_back();
        let before_that = before.and_then(|ch| text[..start - ch.len_utf8()].chars().next_back());
        match before {
            // Inside a word or a code name, a reference, or a decimal part.
            Some(ch) if word_char(ch) || matches!(ch, '#' | '§' | '.' | '$' | '@' | '\\') => {
                continue
            }
            // `MC-D12`, `m[0]`, `task.rs:12`, `a/2`: part of a name.
            Some('-' | '[' | ':' | '/') if before_that.is_some_and(word_char) => continue,
            _ => {}
        }
        let dots = digits.matches('.').count();
        if dots >= 2 {
            continue;
        }
        let Some(mut value) = digits_value(digits) else {
            // A list (`1,2,3`): each part on its own, without a unit.
            for part in digits.split(',') {
                if let Some(value) = digits_value(part) {
                    found.push(Quantity {
                        raw: part.to_owned(),
                        value,
                        dim: Dim::Count,
                    });
                }
            }
            continue;
        };
        if let Some(exponent) = re(&EXPONENT, r"^[eE][+-]?[0-9]+").find(&masked[end..]) {
            let next = masked[end + exponent.end()..].chars().next();
            if !next.is_some_and(word_char) {
                let power: i32 = exponent.as_str()[1..].parse().unwrap_or(0);
                value *= 10f64.powi(power);
                end += exponent.end();
            }
        }
        // A Rust literal's type (`15_000u64`, `0.05_f64`) is no unit.
        if let Some(suffix) = re(
            &LITERAL,
            r"^_?(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)\b",
        )
        .find(&masked[end..])
        {
            end += suffix.end();
        }
        let (dim, size, unit_length) = match unit_after(&masked[end..]) {
            Ok(Some(unit)) => unit,
            Ok(None) => (Dim::Count, 1.0, 0),
            Err(()) => continue,
        };
        if dim == Dim::Count && unit_length == 0 {
            if LABELS.contains(&word_before(&masked, start).as_str()) {
                continue;
            }
            if names_item(text, start) {
                continue;
            }
            let rest = &masked[end..];
            let release = dots == 1
                && (["'s", "’s", ".x", "+", "-era"]
                    .iter()
                    .any(|suffix| rest.starts_with(suffix))
                    || RELEASE_BEFORE.contains(&word_before(&masked, start).as_str())
                    || RELEASE_AFTER.contains(&word_after(rest).as_str()));
            if release {
                continue;
            }
        }
        let end = end + unit_length;
        found.push(Quantity {
            raw: text.get(start..end).unwrap_or(digits).to_owned(),
            value: in_base(value, dim, size),
            dim,
        });
    }
    found
}

/// `value`, written with a unit of kind `dim` that is `size` base units, in
/// base units. A percent is divided rather than multiplied, so 95% is
/// exactly 0.95.
fn in_base(value: f64, dim: Dim, size: f64) -> f64 {
    if dim == Dim::Percent {
        value / 100.0
    } else {
        value * size
    }
}

/// Whether two values are the same number, allowing for the rounding of
/// unit conversions.
fn equal(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-9 * left.abs().max(right.abs()).max(1.0)
}

/// The plain numbers `quantity` can be written as in code, which seldom
/// writes units: a time in each time unit, a size in each size unit, a
/// percent as itself or as its fraction.
fn written_as(quantity: &Quantity) -> Vec<f64> {
    let kib = 1024.0_f64;
    let units: &[f64] = match quantity.dim {
        Dim::Count => &[1.0],
        Dim::Percent => &[1.0, 0.01],
        Dim::Time => &[1.0, 1e3, 6e4, 3.6e6, 8.64e7],
        Dim::Bytes => &[
            1.0,
            1e3,
            kib,
            1e6,
            kib * kib,
            1e9,
            kib * kib * kib,
            1e12,
            kib * kib * kib * kib,
        ],
    };
    units.iter().map(|unit| quantity.value / unit).collect()
}

/// Whether `left` and `right` state the same number in equal forms: the
/// same kind and value, or one a plain number the other can be written as.
pub(crate) fn same(left: &Quantity, right: &Quantity) -> bool {
    (left.dim == right.dim && equal(left.value, right.value))
        || (right.dim == Dim::Count
            && written_as(left)
                .iter()
                .any(|form| equal(*form, right.value)))
        || (left.dim == Dim::Count
            && written_as(right)
                .iter()
                .any(|form| equal(*form, left.value)))
}

/// One step of a `derive`: a number the memory states, computed from numbers
/// the cited lines hold.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Derivation {
    /// As the reply writes it.
    pub raw: String,
    /// The left side: the number the memory states.
    pub result: Quantity,
    /// Each number of the right side, which the cited lines must hold.
    pub inputs: Vec<Quantity>,
}

/// Read a `derive` attribute: one or more steps separated by `;`, each
/// `<number with unit> = <expression>`, the expression over numbers with
/// optional units, `×` or `*`, `/`, `+`, `-` and parentheses. Each step's
/// arithmetic must hold, in base units: the expression's value equals the
/// left side's, or, for an expression without units, one of the plain
/// numbers the left side can be written as. `Err` says why not.
pub(crate) fn derivations(raw: &str) -> Result<Vec<Derivation>, String> {
    let mut steps = Vec::new();
    for step in raw
        .split(';')
        .map(str::trim)
        .filter(|step| !step.is_empty())
    {
        let (left, right) = step
            .split_once('=')
            .ok_or_else(|| format!("derive step {step:?} has no `=`"))?;
        let result = match Parser::new(left)?.tokens.as_slice() {
            [Token::Number(quantity)] => quantity.clone(),
            _ => {
                return Err(format!(
                    "the left side of derive step {step:?} is not one number"
                ))
            }
        };
        let mut parser = Parser::new(right)?;
        let value = parser.expression()?;
        if parser.at != parser.tokens.len() {
            return Err(format!(
                "derive step {step:?} can't be read past its expression"
            ));
        }
        let inputs: Vec<Quantity> = parser
            .tokens
            .iter()
            .filter_map(|token| match token {
                Token::Number(quantity) => Some(quantity.clone()),
                _ => None,
            })
            .collect();
        let unitless = inputs.iter().all(|input| input.dim == Dim::Count);
        let holds = equal(result.value, value)
            || (unitless && written_as(&result).iter().any(|form| equal(*form, value)));
        if !holds {
            return Err(format!(
                "derive step {step:?} does not hold: its expression comes to {value}"
            ));
        }
        steps.push(Derivation {
            raw: step.to_owned(),
            result,
            inputs,
        });
    }
    if steps.is_empty() {
        return Err("derive is empty".into());
    }
    Ok(steps)
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(Quantity),
    Op(char),
    Open,
    Close,
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    fn new(text: &str) -> Result<Self, String> {
        static NUMBER: OnceLock<Regex> = OnceLock::new();
        let number = re(&NUMBER, r"^[0-9](?:[0-9_]|[.,][0-9])*(?:[eE][+-]?[0-9]+)?");
        let mut tokens = Vec::new();
        let mut at = 0;
        while at < text.len() {
            let rest = &text[at..];
            let ch = rest.chars().next().expect("not at the end");
            if ch.is_whitespace() {
                at += ch.len_utf8();
                continue;
            }
            let op = match ch {
                '×' | '*' | '·' => Some('*'),
                '/' | '÷' => Some('/'),
                '+' => Some('+'),
                '-' | '−' => Some('-'),
                _ => None,
            };
            if let Some(op) = op {
                tokens.push(Token::Op(op));
                at += ch.len_utf8();
                continue;
            }
            if ch == '(' || ch == ')' {
                tokens.push(if ch == '(' { Token::Open } else { Token::Close });
                at += 1;
                continue;
            }
            let Some(found) = number.find(rest) else {
                return Err(format!("derive can't read {rest:?}"));
            };
            let raw_digits = found.as_str();
            let (digits, power) = match raw_digits.find(['e', 'E']) {
                Some(split) => (
                    &raw_digits[..split],
                    raw_digits[split + 1..].parse::<i32>().unwrap_or(0),
                ),
                None => (raw_digits, 0),
            };
            let value = digits_value(digits)
                .ok_or_else(|| format!("derive can't read the number {raw_digits:?}"))?
                * 10f64.powi(power);
            let mut end = found.end();
            let (dim, size) = match unit_after(&rest[end..]) {
                Ok(Some((dim, size, length))) => {
                    end += length;
                    (dim, size)
                }
                Ok(None) => (Dim::Count, 1.0),
                Err(()) => return Err(format!("derive can't read {rest:?}")),
            };
            tokens.push(Token::Number(Quantity {
                raw: rest[..end].to_owned(),
                value: in_base(value, dim, size),
                dim,
            }));
            at += end;
            // A word naming what is counted (`10 attempts`) is read past.
            let tail = &text[at..];
            let gap = tail.len() - tail.trim_start().len();
            let word: String = tail[gap..]
                .chars()
                .take_while(|ch| ch.is_alphabetic())
                .collect();
            if !word.is_empty() && dim == Dim::Count {
                at += gap + word.len();
            }
        }
        Ok(Self { tokens, at: 0 })
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn expression(&mut self) -> Result<f64, String> {
        let mut value = self.term()?;
        while let Some(Token::Op(op @ ('+' | '-'))) = self.peek().cloned() {
            self.at += 1;
            let right = self.term()?;
            value = if op == '+' {
                value + right
            } else {
                value - right
            };
        }
        Ok(value)
    }

    fn term(&mut self) -> Result<f64, String> {
        let mut value = self.factor()?;
        while let Some(Token::Op(op @ ('*' | '/'))) = self.peek().cloned() {
            self.at += 1;
            let right = self.factor()?;
            value = if op == '*' {
                value * right
            } else if right == 0.0 {
                return Err("derive divides by zero".into());
            } else {
                value / right
            };
        }
        Ok(value)
    }

    fn factor(&mut self) -> Result<f64, String> {
        match self.peek().cloned() {
            Some(Token::Op('-')) => {
                self.at += 1;
                Ok(-self.factor()?)
            }
            Some(Token::Number(quantity)) => {
                self.at += 1;
                Ok(quantity.value)
            }
            Some(Token::Open) => {
                self.at += 1;
                let value = self.expression()?;
                if self.peek() != Some(&Token::Close) {
                    return Err("derive has an unclosed parenthesis".into());
                }
                self.at += 1;
                Ok(value)
            }
            _ => Err("derive's expression is incomplete".into()),
        }
    }
}

#[cfg(test)]
#[path = "numbers_tests.rs"]
mod tests;
