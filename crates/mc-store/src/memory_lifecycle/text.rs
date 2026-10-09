//! Text rules shared with the TypeScript memory applier
//! (`packages/plugin/src/features/magic-context/memory/lifecycle-text.ts`).
//!
//! Every function here must produce byte-identical output to its TypeScript twin, so the
//! two applier implementations accept and refuse exactly the same evidence. JavaScript
//! strings are UTF-16, and the TypeScript rules count offsets, window sizes and "one
//! character" in UTF-16 code units, so this port works on UTF-16 code units too: every
//! offset in and out of this module is a UTF-16 offset, never a byte or `char` index.
//! The TypeScript implementation uses a few regular expressions; each is replaced here by
//! a hand-written matcher with the same semantics, noted beside it.
//!
//! The shared goldens live in `memory_lifecycle/text_goldens.json`; their expected values
//! were produced by running the TypeScript functions.

use sha2::{Digest, Sha256};

use super::constants::{CLAUSE_ABBREVIATIONS, CONCRETE_UNITS, NARROW_CHECK_WINDOW_MAX};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The lifecycle whitespace set. U+180E and U+FEFF are deliberately not whitespace.
pub fn is_lifecycle_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0x85
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
    )
}

fn ws_at(text: &[u16], index: usize) -> bool {
    text.get(index)
        .copied()
        .is_some_and(is_lifecycle_whitespace)
}

/// JavaScript's `\s`, used only where the TypeScript splitter detects list lines with a
/// regular expression. It differs from the lifecycle set: U+FEFF counts, U+0085 does not.
fn is_js_regex_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn is_ascii_digit(unit: u16) -> bool {
    (0x30..=0x39).contains(&unit)
}

fn is_ascii_letter(unit: u16) -> bool {
    (0x41..=0x5a).contains(&unit) || (0x61..=0x7a).contains(&unit)
}

fn is_ascii_alnum(unit: u16) -> bool {
    is_ascii_digit(unit) || is_ascii_letter(unit)
}

/// JavaScript's `[A-Za-z0-9_]`.
fn is_word_unit(unit: u16) -> bool {
    is_ascii_alnum(unit) || unit == u16::from(b'_')
}

fn word_at(text: &[u16], index: usize) -> bool {
    text.get(index).copied().is_some_and(is_word_unit)
}

fn digit_at(text: &[u16], index: usize) -> bool {
    text.get(index).copied().is_some_and(is_ascii_digit)
}

fn starts_with_at(text: &[u16], at: usize, needle: &[u16]) -> bool {
    text.len() >= at + needle.len() && &text[at..at + needle.len()] == needle
}

fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    if haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| &haystack[at..at + needle.len()] == needle)
}

/// Collapse every whitespace run to one U+0020 and trim.
pub fn normalize_lifecycle_text(text: &str) -> String {
    string(&normalized_offsets(&units(text)).text)
}

/// SHA-256 of the UTF-8 text, lowercase hex, as `lifecycleTextHash` computes it.
pub fn lifecycle_text_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// One clause of a memory, numbered from 1, with its UTF-16 offsets in the source text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Clause {
    pub ordinal: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

/// The TypeScript regex `^\s*(?:[-*+] |\d+[.)] )` applied to the line starting at `from`.
fn is_list_line(text: &[u16], from: usize) -> bool {
    let line_end = text[from.min(text.len())..]
        .iter()
        .position(|&unit| unit == u16::from(b'\n'))
        .map_or(text.len(), |offset| from + offset);
    let line = &text[from.min(text.len())..line_end];
    let mut at = 0;
    while at < line.len() && is_js_regex_whitespace(line[at]) {
        at += 1;
    }
    let space = u16::from(b' ');
    match line.get(at).copied() {
        Some(unit)
            if unit == u16::from(b'-') || unit == u16::from(b'*') || unit == u16::from(b'+') =>
        {
            line.get(at + 1) == Some(&space)
        }
        Some(unit) if is_ascii_digit(unit) => {
            while at < line.len() && is_ascii_digit(line[at]) {
                at += 1;
            }
            matches!(line.get(at).copied(), Some(unit) if unit == u16::from(b'.') || unit == u16::from(b')'))
                && line.get(at + 1) == Some(&space)
        }
        _ => false,
    }
}

/// The TypeScript regex `(?:^|[^A-Za-z])[A-Za-z]\.$` applied to `prefix`.
fn ends_with_single_letter_token(prefix: &[u16]) -> bool {
    let len = prefix.len();
    if len < 2 || prefix[len - 1] != u16::from(b'.') || !is_ascii_letter(prefix[len - 2]) {
        return false;
    }
    len == 2 || !is_ascii_letter(prefix[len - 3])
}

/// Split memory text into clauses that concatenate back to the input.
pub fn split_memory_clauses(input: &str) -> Vec<Clause> {
    let text = units(input);
    split_units(&text)
}

fn split_units(text: &[u16]) -> Vec<Clause> {
    let mut clauses: Vec<Clause> = Vec::new();
    let mut start = 0usize;
    let mut tick_width = 0usize;
    let mut list_line = is_list_line(text, 0);
    let emit = |clauses: &mut Vec<Clause>, start: &mut usize, end: usize| {
        if end > *start {
            clauses.push(Clause {
                ordinal: clauses.len() + 1,
                text: string(&text[*start..end]),
                start: *start,
                end,
            });
        }
        *start = end;
    };
    let backtick = u16::from(b'`');
    let newline = u16::from(b'\n');
    let em_dash = 0x2014u16;
    let mut i = 0usize;
    while i < text.len() {
        let unit = text[i];
        if unit == backtick {
            let mut end = i + 1;
            while end < text.len() && text[end] == backtick {
                end += 1;
            }
            let width = end - i;
            if tick_width == 0 {
                tick_width = width;
            } else if tick_width == width {
                tick_width = 0;
            }
            i = end;
            continue;
        }
        if tick_width != 0 {
            i += 1;
            continue;
        }
        if unit == newline {
            emit(&mut clauses, &mut start, i + 1);
            list_line = is_list_line(text, i + 1);
            i += 1;
            continue;
        }
        if list_line {
            i += 1;
            continue;
        }
        if unit == em_dash && i > 0 && ws_at(text, i - 1) && ws_at(text, i + 1) {
            let mut end = i + 1;
            while end < text.len() && text[end] != newline && is_lifecycle_whitespace(text[end]) {
                end += 1;
            }
            emit(&mut clauses, &mut start, end);
            i = end;
            continue;
        }
        let terminator =
            unit == u16::from(b'.') || unit == u16::from(b'!') || unit == u16::from(b'?');
        if !terminator || !ws_at(text, i + 1) {
            i += 1;
            continue;
        }
        if unit == u16::from(b'.') {
            let prefix = &text[start..=i];
            if CLAUSE_ABBREVIATIONS
                .iter()
                .any(|abbreviation| prefix.ends_with(&units(abbreviation)))
                || ends_with_single_letter_token(prefix)
                || (i > 0 && digit_at(text, i - 1) && digit_at(text, i + 1))
            {
                i += 1;
                continue;
            }
        }
        let mut end = i + 1;
        while end < text.len() && is_lifecycle_whitespace(text[end]) {
            end += 1;
        }
        if text[i + 1..end].contains(&newline) {
            list_line = is_list_line(text, end);
        }
        emit(&mut clauses, &mut start, end);
        i = end;
    }
    emit(&mut clauses, &mut start, text.len());
    clauses
}

/// One stored evidence block of a fact: the rendered message range and its parts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBlock {
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub role: String,
    pub parts: Vec<String>,
    pub joined_text: String,
}

/// The matched evidence span, in UTF-16 offsets within one stored part.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSpan {
    pub block_start_ordinal: i64,
    pub part_index: usize,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub window: String,
}

/// Strings the renderers insert into evidence. An excerpt containing any of them is not
/// evidence. `[N]`, `[N-M]` and `Messages N-M:` stand for formats with varying numbers,
/// which [`has_evidence_marker`] matches in full.
pub const EVIDENCE_MARKERS: &[&str] = &[
    " / ",
    "[N]",
    "[N-M]",
    "Messages N-M:",
    "...[truncated]",
    "[… tokens truncated by Magic Context to fit the historian window …]",
    "…",
    "… +N more",
    "[dropped]",
    "[dropped §",
    "[truncated §",
    "<!-- +",
];

/// The TypeScript regex `\[\d+(?:-\d+)?\]`, unanchored.
fn has_ordinal_prefix(text: &[u8]) -> bool {
    (0..text.len()).any(|at| {
        if text[at] != b'[' {
            return false;
        }
        let mut cursor = at + 1;
        let digits = |cursor: &mut usize| {
            let from = *cursor;
            while *cursor < text.len() && text[*cursor].is_ascii_digit() {
                *cursor += 1;
            }
            *cursor > from
        };
        if !digits(&mut cursor) {
            return false;
        }
        if text.get(cursor) == Some(&b'-') {
            cursor += 1;
            if !digits(&mut cursor) {
                return false;
            }
        }
        text.get(cursor) == Some(&b']')
    })
}

/// The TypeScript regex `Messages \d+-\d+:`, unanchored.
fn has_pi_header(text: &[u8]) -> bool {
    const HEAD: &[u8] = b"Messages ";
    (0..text.len()).any(|at| {
        if !text[at..].starts_with(HEAD) {
            return false;
        }
        let mut cursor = at + HEAD.len();
        let from = cursor;
        while cursor < text.len() && text[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == from || text.get(cursor) != Some(&b'-') {
            return false;
        }
        cursor += 1;
        let from = cursor;
        while cursor < text.len() && text[cursor].is_ascii_digit() {
            cursor += 1;
        }
        cursor > from && text.get(cursor) == Some(&b':')
    })
}

pub fn has_evidence_marker(text: &str) -> bool {
    EVIDENCE_MARKERS.iter().any(|marker| text.contains(marker))
        || has_ordinal_prefix(text.as_bytes())
        || has_pi_header(text.as_bytes())
}

struct Normalized {
    text: Vec<u16>,
    starts: Vec<usize>,
    ends: Vec<usize>,
}

fn normalized_offsets(text: &[u16]) -> Normalized {
    let mut normalized = Vec::with_capacity(text.len());
    let mut starts = Vec::with_capacity(text.len());
    let mut ends = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if is_lifecycle_whitespace(text[i]) {
            let start = i;
            while i < text.len() && is_lifecycle_whitespace(text[i]) {
                i += 1;
            }
            if !normalized.is_empty() && i < text.len() {
                normalized.push(u16::from(b' '));
                starts.push(start);
                ends.push(i);
            }
        } else {
            normalized.push(text[i]);
            starts.push(i);
            ends.push(i + 1);
            i += 1;
        }
    }
    Normalized {
        text: normalized,
        starts,
        ends,
    }
}

/// A cut never starts on the low half of a surrogate pair; the pair is dropped instead.
fn safe_start(text: &[u16], start: usize) -> usize {
    match text.get(start) {
        Some(unit) if (0xdc00..=0xdfff).contains(unit) => start + 1,
        _ => start,
    }
}

/// The narrow-check window around a matched span of `part` (UTF-16 offsets), or `None`
/// when the span alone exceeds [`NARROW_CHECK_WINDOW_MAX`].
pub fn extract_evidence_window(part: &str, start: usize, end: usize) -> Option<String> {
    window_units(&units(part), start, end).map(|window| string(&window))
}

fn window_units(part: &[u16], start: usize, end: usize) -> Option<Vec<u16>> {
    if end.saturating_sub(start) > NARROW_CHECK_WINDOW_MAX {
        return None;
    }
    let clauses = split_units(part);
    let first = clauses.iter().position(|clause| clause.end > start)?;
    let last = clauses.iter().position(|clause| clause.end >= end)?;
    let mut window_start = clauses[first].start;
    let mut window_end = clauses[last].end;
    if window_end - window_start > NARROW_CHECK_WINDOW_MAX {
        window_end = end;
        window_start = safe_start(part, end.saturating_sub(NARROW_CHECK_WINDOW_MAX));
    } else {
        for n in 1..=2 {
            let Some(previous) = first.checked_sub(n).and_then(|index| clauses.get(index)) else {
                break;
            };
            if window_end - previous.start > NARROW_CHECK_WINDOW_MAX {
                break;
            }
            window_start = previous.start;
        }
    }
    Some(part[window_start.min(window_end)..window_end].to_vec())
}

/// Match an excerpt against one stored part of the block cited by `ordinal`.
pub fn match_fact_evidence(
    blocks: &[EvidenceBlock],
    ordinal: i64,
    excerpt: &str,
) -> Option<EvidenceSpan> {
    if has_evidence_marker(excerpt) {
        return None;
    }
    let needle = normalized_offsets(&units(excerpt)).text;
    if needle.is_empty() {
        return None;
    }
    let block = blocks.iter().find(|block| block.start_ordinal == ordinal)?;
    for (part_index, part) in block.parts.iter().enumerate() {
        let part = units(part);
        let haystack = normalized_offsets(&part);
        let Some(offset) = index_of(&haystack.text, &needle, 0) else {
            continue;
        };
        let (Some(&start), Some(&end)) = (
            haystack.starts.get(offset),
            haystack.ends.get(offset + needle.len() - 1),
        ) else {
            continue;
        };
        let text = string(&part[start..end]);
        if has_evidence_marker(&text) {
            return None;
        }
        let window = window_units(&part, start, end)?;
        return Some(EvidenceSpan {
            block_start_ordinal: ordinal,
            part_index,
            start,
            end,
            text,
            window: string(&window),
        });
    }
    None
}

/// Strip the trailing run the TypeScript regex `[.,;:!?)}\]]+$` removes.
fn trim_word_punctuation(word: &[u16]) -> &[u16] {
    let mut end = word.len();
    while end > 0
        && b".,;:!?)}]"
            .iter()
            .any(|&punct| word[end - 1] == u16::from(punct))
    {
        end -= 1;
    }
    &word[..end]
}

/// The TypeScript regex `\.[A-Za-z0-9]{1,5}$`.
fn has_file_extension(word: &[u16]) -> bool {
    let run = word
        .iter()
        .rev()
        .take_while(|&&unit| is_ascii_alnum(unit))
        .count();
    (1..=5).contains(&run) && word.len() > run && word[word.len() - run - 1] == u16::from(b'.')
}

/// The TypeScript regex `^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$`.
fn is_config_key(word: &[u16]) -> bool {
    let segments: Vec<&[u16]> = word.split(|&unit| unit == u16::from(b'.')).collect();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            let lower_or_underscore =
                |unit: u16| (0x61..=0x7a).contains(&unit) || unit == u16::from(b'_');
            match segment.split_first() {
                Some((&head, tail)) => {
                    lower_or_underscore(head)
                        && tail
                            .iter()
                            .all(|&unit| lower_or_underscore(unit) || is_ascii_digit(unit))
                }
                None => false,
            }
        })
}

/// The TypeScript regex `^[A-Z0-9]+(?:_[A-Z0-9]+)+$`.
fn is_refusal_code(word: &[u16]) -> bool {
    let segments: Vec<&[u16]> = word.split(|&unit| unit == u16::from(b'_')).collect();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .iter()
                    .all(|&unit| is_ascii_digit(unit) || (0x41..=0x5a).contains(&unit))
        })
}

fn digits_from(text: &[u16], at: usize, count: usize) -> bool {
    (at..at + count).all(|index| digit_at(text, index))
}

/// The TypeScript regex `^(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2})(?![A-Za-z0-9_])` at `at`,
/// returning the match length. The first alternative is tried first and the second only
/// when the first fails, matching the regex engine's backtracking.
fn date_at(text: &[u16], at: usize) -> Option<usize> {
    let dash = u16::from(b'-');
    let colon = u16::from(b':');
    if digits_from(text, at, 4)
        && text.get(at + 4) == Some(&dash)
        && digits_from(text, at + 5, 2)
        && text.get(at + 7) == Some(&dash)
        && digits_from(text, at + 8, 2)
        && !word_at(text, at + 10)
    {
        return Some(10);
    }
    if digits_from(text, at, 2)
        && text.get(at + 2) == Some(&colon)
        && digits_from(text, at + 3, 2)
        && !word_at(text, at + 5)
    {
        return Some(5);
    }
    None
}

/// The TypeScript regex `^[><≥≤]?\d+(?:\.\d+)?` at `at`, returning the match length.
fn number_at(text: &[u16], at: usize) -> Option<usize> {
    let mut cursor = at;
    if matches!(
        text.get(cursor).copied(),
        Some(0x3e | 0x3c | 0x2265 | 0x2264)
    ) {
        cursor += 1;
    }
    let digits_start = cursor;
    while digit_at(text, cursor) {
        cursor += 1;
    }
    if cursor == digits_start {
        return None;
    }
    if text.get(cursor) == Some(&u16::from(b'.')) && digit_at(text, cursor + 1) {
        cursor += 1;
        while digit_at(text, cursor) {
            cursor += 1;
        }
    }
    Some(cursor - at)
}

/// Concrete tokens of `input`, in order. Whole paths, identifiers and dates are scanned
/// before numbers, so a number inside a longer word is never a token.
pub fn scan_concrete_tokens(input: &str) -> Vec<String> {
    let text = normalized_offsets(&units(input)).text;
    let mut unit_list: Vec<Vec<u16>> = CONCRETE_UNITS.iter().map(|unit| units(unit)).collect();
    // Longest first; a stable sort keeps the list order among equal lengths, as
    // JavaScript's `Array.prototype.sort` does.
    unit_list.sort_by_key(|unit| std::cmp::Reverse(unit.len()));
    let backtick = u16::from(b'`');
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        if text[i] == backtick {
            let mut tick_end = i;
            while tick_end < text.len() && text[tick_end] == backtick {
                tick_end += 1;
            }
            let ticks = &text[i..tick_end];
            if let Some(close) = index_of(&text, ticks, tick_end) {
                tokens.push(string(&text[i..close + ticks.len()]));
                i = close + ticks.len();
                continue;
            }
        }
        if is_lifecycle_whitespace(text[i]) {
            i += 1;
            continue;
        }
        let mut word_end = i;
        while word_end < text.len()
            && !is_lifecycle_whitespace(text[word_end])
            && text[word_end] != backtick
        {
            word_end += 1;
        }
        let raw = &text[i..word_end];
        let word = trim_word_punctuation(raw);
        if word.contains(&u16::from(b'/'))
            || has_file_extension(word)
            || is_config_key(word)
            || is_refusal_code(word)
        {
            tokens.push(string(word));
            i += raw.len();
            continue;
        }
        if let Some(length) = date_at(&text, i) {
            tokens.push(string(&text[i..i + length]));
            i += length;
            continue;
        }
        if let Some(length) = number_at(&text, i) {
            if !word_at(&text, i + length) {
                let mut end = i + length;
                let mut unit_start = end;
                while unit_start < text.len() && is_lifecycle_whitespace(text[unit_start]) {
                    unit_start += 1;
                }
                if let Some(unit) = unit_list.iter().find(|candidate| {
                    starts_with_at(&text, unit_start, candidate)
                        && !word_at(&text, unit_start + candidate.len())
                }) {
                    end = unit_start + unit.len();
                }
                tokens.push(string(&text[i..end]));
                i = end;
                continue;
            }
        }
        // Skip whole non-token words to avoid numeric and identifier suffix collisions.
        i += raw.len().max(1);
    }
    tokens
}
