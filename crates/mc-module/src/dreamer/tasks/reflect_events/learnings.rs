//! A reflect reply's `<learnings>` list, and the checks a learning's own text
//! must pass before it is written.
//!
//! The text checks are the 0.49 retrospective's (`retrospective-learnings.ts`
//! in the plugin): no dates, no frustration phrases, and no run of words
//! copied from what the learning rests on, which here is the text of the
//! events it cites. Its quotation check is stricter than 0.49's: any
//! quotation mark refuses a learning, not only a quoted run of words. An
//! apostrophe between two letters or digits (don't, the agent's) is not a
//! quotation mark; backticks are allowed.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

/// One learning a reply proposes, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Learning {
    /// `memory` (a project memory) or `observation` (about the person).
    pub route: String,
    /// The category it names, by tag or id, as written.
    pub category: String,
    /// The event ids it cites (`e12` is 12), in order, without repeats.
    pub events: Vec<i64>,
    /// Its text, entities written out and whitespace collapsed.
    pub text: String,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed learnings pattern")
}

/// The text of an XML value: the five predefined entities written out.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// The text inside a reply's last complete `<learnings>` list; empty for a
/// `<learnings/>`. A model that shows an example list before its answer is
/// read by its answer.
fn list_body(text: &str) -> Result<&str, String> {
    let open = re(r#"(?i)<learnings\b((?:[^>"']|"[^"]*"|'[^']*')*)>"#);
    let Some(close) = re(r"(?i)</learnings\s*>").find_iter(text).last() else {
        if open
            .captures_iter(text)
            .any(|found| found[1].trim_end().ends_with('/'))
        {
            return Ok("");
        }
        return Err(if text.to_ascii_lowercase().contains("<learnings") {
            "the learnings list has no closing tag".into()
        } else {
            "the reply holds no learnings list".into()
        });
    };
    let before = &text[..close.start()];
    let Some(start) = open
        .find_iter(before)
        .filter(|found| {
            !found
                .as_str()
                .trim_end_matches('>')
                .trim_end()
                .ends_with('/')
        })
        .last()
    else {
        return Err("the learnings list has no opening tag".into());
    };
    Ok(&before[start.end()..])
}

/// The cited ids of an `events` attribute: `e12,e40` (a bare `12` too).
fn event_ids(listed: &str) -> Result<Vec<i64>, String> {
    let mut ids = Vec::new();
    for token in listed
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|token| !token.is_empty())
    {
        let digits = token.strip_prefix(['e', 'E']).unwrap_or(token);
        let id: i64 = digits
            .parse()
            .map_err(|_| format!("{token} is not an event id"))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Err("the learning cites no events".into());
    }
    Ok(ids)
}

/// One `<learning>` element: the learning, or why it can't be read.
fn learning(attributes: &str, inner: &str) -> Result<Learning, String> {
    let mut found = std::collections::HashMap::new();
    for attribute in
        re(r#"([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).captures_iter(attributes)
    {
        let value = attribute
            .get(2)
            .or(attribute.get(3))
            .map_or("", |value| value.as_str());
        found.insert(attribute[1].to_ascii_lowercase(), unescape(value));
    }
    let text = unescape(inner.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return Err("the learning has no text".into());
    }
    Ok(Learning {
        route: found
            .get("route")
            .map(|route| route.trim().to_ascii_lowercase())
            .unwrap_or_default(),
        category: found
            .get("category")
            .map(|category| category.trim().to_owned())
            .unwrap_or_default(),
        events: event_ids(found.get("events").map_or("", String::as_str))?,
        text,
    })
}

/// Read a reply's `<learnings>` list: each `<learning>` in order, as the
/// learning or why it can't be read. A reply without a complete list is
/// refused as a whole; an empty list is a valid answer.
pub(crate) fn parse_learnings(text: &str) -> Result<Vec<Result<Learning, String>>, String> {
    let body = list_body(text)?;
    let open = re(r#"(?i)<learning\b((?:[^>"']|"[^"]*"|'[^']*')*)>"#);
    let close = re(r"(?i)</learning\s*>");
    let mut found = Vec::new();
    let mut rest = body;
    while let Some(tag) = open.captures(rest) {
        let whole = tag.get(0).expect("a match has its text");
        let attributes = tag.get(1).map_or("", |value| value.as_str());
        let after = &rest[whole.end()..];
        if attributes.trim_end().ends_with('/') {
            found.push(Err("the learning has no text".into()));
            rest = after;
            continue;
        }
        let Some(end) = close.find(after) else {
            found.push(Err("a learning is not closed".into()));
            break;
        };
        found.push(learning(attributes, &after[..end.start()]));
        rest = &after[end.end()..];
    }
    Ok(found)
}

/// Quotation marks of every kind: straight, curly and low double quotes,
/// guillemets, and the single quotes that are never an apostrophe.
const QUOTES: &[char] = &[
    '"', '\u{201c}', '\u{201d}', '\u{201e}', '\u{201f}', '\u{00ab}', '\u{00bb}', '\u{2039}',
    '\u{203a}', '\u{2018}', '\u{201b}',
];
/// Single quotes that are an apostrophe between two letters or digits.
const APOSTROPHES: &[char] = &['\'', '\u{2019}'];

/// The first quotation mark in `text`, if any.
pub(crate) fn quotation_mark(text: &str) -> Option<char> {
    let chars: Vec<char> = text.chars().collect();
    chars.iter().enumerate().find_map(|(at, c)| {
        if QUOTES.contains(c) {
            return Some(*c);
        }
        if APOSTROPHES.contains(c) {
            let inside_a_word = at > 0
                && chars[at - 1].is_alphanumeric()
                && chars.get(at + 1).is_some_and(|next| next.is_alphanumeric());
            return (!inside_a_word).then_some(*c);
        }
        None
    })
}

fn date_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        re(r"(?i)\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}/\d{1,2}/20\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b")
    })
}

/// The strongest correction phrases, runs of no/wrong/again/stop, and bursts
/// of three or more `!` or `?`: session-local anger a durable learning must
/// not keep.
fn frustration_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        re(r"(?i)\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using)|(?:no|wrong|again|stop)(?:\W+\b(?:no|wrong|again|stop)\b)+)\b|[!?]{3,}")
    })
}

/// A copied run this many words long, or half the learning's own length for
/// a short learning (at least three words), counts as a near copy.
pub(crate) const MAX_SOURCE_WORD_RUN: usize = 7;
/// Only the first this many words of a learning are compared.
const MAX_OVERLAP_LEARNING_WORDS: usize = 200;

fn words(text: &str, cap: Option<usize>) -> Vec<String> {
    static NOT_A_WORD: OnceLock<Regex> = OnceLock::new();
    let cleaned = NOT_A_WORD
        .get_or_init(|| re(r"[^\p{L}\p{N}\s]"))
        .replace_all(&text.to_lowercase(), " ")
        .into_owned();
    let mut words: Vec<String> = cleaned.split_whitespace().map(str::to_owned).collect();
    if let Some(cap) = cap {
        words.truncate(cap);
    }
    words
}

/// Whether `text` shares a contiguous run of words with one of `sources`:
/// [`MAX_SOURCE_WORD_RUN`] words, or half the learning's own length (at
/// least three) when that is shorter. Every source is read whole.
pub(crate) fn copies_a_run(text: &str, sources: &[&str]) -> bool {
    let own = words(text, Some(MAX_OVERLAP_LEARNING_WORDS));
    if own.is_empty() {
        return false;
    }
    let run = MAX_SOURCE_WORD_RUN.min(own.len().div_ceil(2).max(3));
    if own.len() < run {
        return false;
    }
    let grams: HashSet<&[String]> = own.windows(run).collect();
    sources.iter().any(|source| {
        words(source, None)
            .windows(run)
            .any(|gram| grams.contains(gram))
    })
}

/// Why `text` can't be written as a learning resting on `sources` (the text
/// of the events it cites), or `None` when it passes every text check.
pub(crate) fn text_refusal(text: &str, sources: &[&str]) -> Option<String> {
    if let Some(mark) = quotation_mark(text) {
        return Some(format!("the text holds a quotation mark ({mark})"));
    }
    if let Some(date) = date_pattern().find(text) {
        return Some(format!("the text holds a date ({})", date.as_str()));
    }
    if let Some(phrase) = frustration_pattern().find(text) {
        return Some(format!(
            "the text keeps a frustration phrase ({})",
            phrase.as_str()
        ));
    }
    if copies_a_run(text, sources) {
        return Some("the text copies a run of words from the events it cites".into());
    }
    None
}

#[cfg(test)]
#[path = "learnings_tests.rs"]
mod tests;
