//! Deterministic caveman-style text compression.
//!
//! This is a byte-for-byte Rust port of the current ("unicode-v2") rules of
//! `packages/plugin/src/hooks/magic-context/caveman.ts`. Keep the transformation
//! order, the Unicode word characters and JavaScript's whitespace set aligned with
//! that source: the committed differential fixture is the compatibility contract.
//! The TypeScript side also keeps the original ASCII rules for replay of sessions
//! compressed before; the module never re-derives a frozen payload, so it needs
//! only the current rules.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CavemanLevel {
    Lite,
    Full,
    Ultra,
}

#[derive(Debug, Clone)]
struct PreservedRegion {
    placeholder: String,
    original: String,
}

const FILLER_WORDS: &[&str] = &[
    "just",
    "really",
    "basically",
    "actually",
    "essentially",
    "simply",
    "clearly",
    "obviously",
    "quite",
    "very",
    "somewhat",
    "rather",
    "fairly",
    "sort of",
    "kind of",
    "a bit",
];

const HEDGING_PHRASES: &[&str] = &[
    "i think",
    "i believe",
    "i feel",
    "probably",
    "perhaps",
    "maybe",
    "it seems",
    "it appears",
    "arguably",
    "i suppose",
    "i guess",
];

const PLEASANTRIES: &[&str] = &["please", "thanks", "thank you", "kindly", "if possible"];

const AUXILIARIES: &[&str] = &[
    "was",
    "were",
    "is",
    "are",
    "am",
    "be",
    "been",
    "being",
    "has been",
    "had been",
    "have been",
    "will be",
    "would be",
    "could be",
    "should be",
    "might be",
    "may be",
];

const PHRASE_SHORTENINGS: &[(&str, &str)] = &[
    ("in order to", "to"),
    ("due to the fact that", "because"),
    ("at this point in time", "now"),
    ("at the moment", "now"),
    ("in the event that", "if"),
    ("for the purpose of", "for"),
    ("with regard to", "about"),
    ("in spite of the fact that", "though"),
    ("on the grounds that", "because"),
    ("for the reason that", "because"),
];

const ULTRA_CONNECTIVE_REPLACEMENTS: &[(&str, &str)] = &[
    ("and then", "→"),
    ("then after", "→"),
    ("afterwards", "→"),
    ("because of", "//"),
    ("therefore", "→"),
    ("because", "//"),
    ("however", "but"),
    ("furthermore", "+"),
    ("additionally", "+"),
    ("as well as", "+"),
    (" and ", " + "),
    (" or ", " | "),
];

const ULTRA_ABBREVIATIONS: &[(&str, &str)] = &[
    ("historian", "hist"),
    ("compartment", "cmpt"),
    ("compartments", "cmpts"),
    ("compressor", "cmp"),
    ("compression", "cmp"),
    ("context", "ctx"),
    ("message", "msg"),
    ("messages", "msgs"),
    ("session", "ses"),
    ("configuration", "cfg"),
    ("config", "cfg"),
    ("implementation", "impl"),
    ("implemented", "impl"),
    ("repository", "repo"),
    ("database", "db"),
    ("directory", "dir"),
];

/// JavaScript's `\s`: Unicode `White_Space` without U+0085, plus U+FEFF. The TypeScript oracle
/// matches whitespace with `\s`, so Rust's `char::is_whitespace` (which differs on exactly those
/// two characters) is never used here.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JavaScript `\s` without the line feed: whitespace a rule may consume without merging lines.
fn is_horizontal_space(ch: char) -> bool {
    ch != '\n' && is_js_whitespace(ch)
}

/// A word character: a letter, combining mark or number of any script, or `_`. This matches the
/// TypeScript class `[\p{L}\p{M}\p{N}_]`; an ASCII-only definition reads the final "a" of
/// "día" as a separate word.
fn is_word(ch: char) -> bool {
    if ch.is_ascii() {
        return ch.is_ascii_alphanumeric() || ch == '_';
    }
    static NON_ASCII_WORD: OnceLock<Regex> = OnceLock::new();
    let mut buffer = [0; 4];
    NON_ASCII_WORD
        .get_or_init(|| Regex::new(r"^[\p{L}\p{M}\p{N}]$").unwrap())
        .is_match(ch.encode_utf8(&mut buffer))
}

fn previous_char(text: &str, offset: usize) -> Option<char> {
    text[..offset].chars().next_back()
}

fn next_char(text: &str, offset: usize) -> Option<char> {
    text[offset..].chars().next()
}

fn has_word_boundary_before(text: &str, offset: usize) -> bool {
    !previous_char(text, offset).is_some_and(is_word)
}

fn has_word_boundary_after(text: &str, offset: usize) -> bool {
    !next_char(text, offset).is_some_and(is_word)
}

fn skip_horizontal_space(text: &str, mut offset: usize) -> usize {
    while let Some(ch) = next_char(text, offset).filter(|ch| is_horizontal_space(*ch)) {
        offset += ch.len_utf8();
    }
    offset
}

fn ascii_eq_at(text: &str, offset: usize, needle: &str) -> bool {
    let Some(candidate) = text.get(offset..offset.saturating_add(needle.len())) else {
        return false;
    };
    candidate.len() == needle.len() && candidate.eq_ignore_ascii_case(needle)
}

fn find_phrase_at<'a>(text: &str, offset: usize, phrases: &'a [&'a str]) -> Option<&'a str> {
    phrases.iter().copied().find(|phrase| {
        ascii_eq_at(text, offset, phrase)
            && has_word_boundary_before(text, offset)
            && has_word_boundary_after(text, offset + phrase.len())
    })
}

fn protect_regex(text: &str, regex: &Regex, preserved: &mut Vec<PreservedRegion>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for matched in regex.find_iter(text) {
        output.push_str(&text[cursor..matched.start()]);
        let placeholder = format!("\u{0}MC_PRES_{}\u{0}", preserved.len());
        preserved.push(PreservedRegion {
            placeholder: placeholder.clone(),
            original: matched.as_str().to_string(),
        });
        output.push_str(&placeholder);
        cursor = matched.end();
    }
    output.push_str(&text[cursor..]);
    output
}

fn protect_identifier_regions(text: &str, preserved: &mut Vec<PreservedRegion>) -> String {
    static IDENTIFIER: OnceLock<Regex> = OnceLock::new();
    let regex = IDENTIFIER.get_or_init(|| Regex::new(r"(?:msg|ses|toolu)_[A-Za-z0-9]+").unwrap());
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for matched in regex.find_iter(text) {
        // Only the start needs a boundary: `msg_abc_def` protects `msg_abc`, as the TypeScript
        // pattern does.
        if !has_word_boundary_before(text, matched.start()) {
            continue;
        }
        output.push_str(&text[cursor..matched.start()]);
        let placeholder = format!("\u{0}MC_PRES_{}\u{0}", preserved.len());
        preserved.push(PreservedRegion {
            placeholder: placeholder.clone(),
            original: matched.as_str().to_string(),
        });
        output.push_str(&placeholder);
        cursor = matched.end();
    }
    output.push_str(&text[cursor..]);
    output
}

fn protect_hash_regions(text: &str, preserved: &mut Vec<PreservedRegion>) -> String {
    static HASH: OnceLock<Regex> = OnceLock::new();
    let regex = HASH.get_or_init(|| Regex::new(r"[0-9a-fA-F]{7,40}").unwrap());
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for matched in regex.find_iter(text) {
        if previous_char(text, matched.start()).is_some_and(|ch| ch.is_ascii_alphanumeric())
            || next_char(text, matched.end()).is_some_and(|ch| ch.is_ascii_alphanumeric())
        {
            continue;
        }
        output.push_str(&text[cursor..matched.start()]);
        let placeholder = format!("\u{0}MC_PRES_{}\u{0}", preserved.len());
        preserved.push(PreservedRegion {
            placeholder: placeholder.clone(),
            original: matched.as_str().to_string(),
        });
        output.push_str(&placeholder);
        cursor = matched.end();
    }
    output.push_str(&text[cursor..]);
    output
}

fn protect_regions(text: &str) -> (String, Vec<PreservedRegion>) {
    let mut preserved = Vec::new();
    let mut working = text.to_string();

    static FENCED: OnceLock<Regex> = OnceLock::new();
    static INLINE: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    working = protect_regex(
        &working,
        FENCED.get_or_init(|| Regex::new(r"(?s)```.*?```").unwrap()),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        INLINE.get_or_init(|| Regex::new(r"`[^`\n]+`").unwrap()),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        // JavaScript `\S`: a URL ends at U+FEFF but runs through U+0085.
        URL.get_or_init(|| {
            Regex::new(
                r"https?://[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+",
            )
            .unwrap()
        }),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        TAG.get_or_init(|| Regex::new(r"§[0-9]+§").unwrap()),
        &mut preserved,
    );
    working = protect_identifier_regions(&working, &mut preserved);
    working = protect_regex(
        &working,
        PATH.get_or_init(|| {
            Regex::new(r"(?:\.{1,2}/)?(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_]{1,6}")
                .unwrap()
        }),
        &mut preserved,
    );
    working = protect_hash_regions(&working, &mut preserved);
    (working, preserved)
}

/// Restore placeholders to their original content.
///
/// A preserved region can contain placeholders of regions protected before it (a URL that
/// swallowed inline code), never of later ones, so expanding each placeholder recursively in one
/// pass gives the same text as replacing them one region at a time from the last to the first,
/// without rescanning the whole text once per region. That holds only while every NUL in the
/// text belongs to a placeholder; a source that already contains NUL characters takes the
/// region-at-a-time path so its output stays byte-identical to the TypeScript oracle.
fn restore_regions(text: &str, preserved: &[PreservedRegion], source_has_nul: bool) -> String {
    if preserved.is_empty() {
        return text.to_string();
    }
    if source_has_nul {
        let mut working = text.to_string();
        for region in preserved.iter().rev() {
            working = working.replace(&region.placeholder, &region.original);
        }
        return working;
    }
    let mut expanded: Vec<Option<String>> = vec![None; preserved.len()];
    let mut output = String::with_capacity(text.len());
    expand_placeholders(text, preserved, &mut expanded, &mut output);
    output
}

/// Parse a placeholder `\0MC_PRES_<index>\0` at the start of `text`, returning the region index
/// and the placeholder's byte length.
fn placeholder_at(text: &str) -> Option<(usize, usize)> {
    const OPEN: &str = "\u{0}MC_PRES_";
    let rest = text.strip_prefix(OPEN)?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || rest.as_bytes().get(digits) != Some(&0) {
        return None;
    }
    let index = rest[..digits].parse::<usize>().ok()?;
    Some((index, OPEN.len() + digits + 1))
}

fn expand_placeholders(
    text: &str,
    preserved: &[PreservedRegion],
    expanded: &mut Vec<Option<String>>,
    output: &mut String,
) {
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find('\0') {
        let start = cursor + offset;
        output.push_str(&text[cursor..start]);
        match placeholder_at(&text[start..]).filter(|(index, _)| *index < preserved.len()) {
            Some((index, length)) => {
                if expanded[index].is_none() {
                    let mut restored = String::with_capacity(preserved[index].original.len());
                    expand_placeholders(
                        &preserved[index].original,
                        preserved,
                        expanded,
                        &mut restored,
                    );
                    expanded[index] = Some(restored);
                }
                output.push_str(expanded[index].as_deref().unwrap_or_default());
                cursor = start + length;
            }
            None => {
                output.push('\0');
                cursor = start + 1;
            }
        }
    }
    output.push_str(&text[cursor..]);
}

/// Drop every phrase of a list without merging lines. In order of preference at each position:
/// at the start of a line, keep the indentation and drop the phrases there together with the
/// spaces after each; after spaces, drop the spaces and the phrase; anywhere else, drop just the
/// phrase. Mirrors `buildUnicodePhraseDropRegex` in caveman.ts.
fn drop_phrases(text: &str, phrases: &[&str]) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if cursor == 0 || text.as_bytes()[cursor - 1] == b'\n' {
            let indentation_end = skip_horizontal_space(text, cursor);
            let mut end = indentation_end;
            while let Some(phrase) = find_phrase_at(text, end, phrases) {
                end = skip_horizontal_space(text, end + phrase.len());
            }
            if end > indentation_end {
                output.push_str(&text[cursor..indentation_end]);
                cursor = end;
                continue;
            }
        }
        let ch = next_char(text, cursor).expect("cursor is on a character boundary");
        if is_horizontal_space(ch) {
            let run_end = skip_horizontal_space(text, cursor);
            if let Some(phrase) = find_phrase_at(text, run_end, phrases) {
                cursor = run_end + phrase.len();
            } else {
                // Every later start inside this run reaches the same miss, so keep the whole run
                // instead of rescanning its rest from each character (quadratic on long runs).
                output.push_str(&text[cursor..run_end]);
                cursor = run_end;
            }
            continue;
        }
        if let Some(phrase) = find_phrase_at(text, cursor, phrases) {
            cursor += phrase.len();
            continue;
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }
    output
}

fn drop_articles(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(ch) = next_char(text, cursor) else {
            break;
        };
        if (ch == 't' || ch == 'T' || ch == 'a' || ch == 'A')
            && has_word_boundary_before(text, cursor)
        {
            let word = if ascii_eq_at(text, cursor, "the") {
                "the"
            } else if ascii_eq_at(text, cursor, "an") {
                "an"
            } else if ascii_eq_at(text, cursor, "a") {
                "a"
            } else {
                ""
            };
            if !word.is_empty() && has_word_boundary_after(text, cursor + word.len()) {
                let end = cursor + word.len();
                let space_end = skip_horizontal_space(text, end);
                if space_end > end {
                    cursor = space_end;
                    continue;
                }
            }
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }
    collapse_ascii_spaces(&output)
}

fn collapse_ascii_spaces(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut previous_space = false;
    for ch in text.chars() {
        if ch == ' ' {
            if previous_space {
                continue;
            }
            previous_space = true;
        } else {
            previous_space = false;
        }
        output.push(ch);
    }
    output
}

fn matches_participle(text: &str, offset: usize) -> bool {
    let mut end = offset;
    while end < text.len() {
        let ch = next_char(text, end).unwrap();
        if !is_word(ch) {
            break;
        }
        end += ch.len_utf8();
    }
    let token = &text[offset..end].to_ascii_lowercase();
    // The suffix must follow at least one character: a bare "ed" or "ing" is not a participle.
    ["ed", "en", "ing", "ized", "ised"]
        .iter()
        .any(|suffix| token.len() > suffix.len() && token.ends_with(suffix))
}

/// Match an auxiliary at `offset`, its words separated by any horizontal space as in the
/// TypeScript `has[^\S\n]+been`, and return its end.
fn match_auxiliary_at(text: &str, offset: usize, auxiliary: &str) -> Option<usize> {
    let mut cursor = offset;
    for (index, word) in auxiliary.split(' ').enumerate() {
        if index > 0 {
            let space_end = skip_horizontal_space(text, cursor);
            if space_end == cursor {
                return None;
            }
            cursor = space_end;
        }
        if !ascii_eq_at(text, cursor, word) {
            return None;
        }
        cursor += word.len();
    }
    has_word_boundary_after(text, cursor).then_some(cursor)
}

fn drop_auxiliaries(text: &str) -> String {
    let mut auxiliaries = AUXILIARIES.to_vec();
    auxiliaries.sort_by_key(|aux| std::cmp::Reverse(aux.len()));

    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(ch) = next_char(text, cursor) else {
            break;
        };
        if is_horizontal_space(ch) {
            let space_end = skip_horizontal_space(text, cursor);
            let Some(aux_end) = auxiliaries
                .iter()
                .find_map(|aux| match_auxiliary_at(text, space_end, aux))
            else {
                output.push_str(&text[cursor..space_end]);
                cursor = space_end;
                continue;
            };
            let verb_start = skip_horizontal_space(text, aux_end);
            if verb_start > aux_end && matches_participle(text, verb_start) {
                output.push(' ');
                cursor = verb_start;
                continue;
            }
            // Keep the auxiliary but not the space after it: that space can start the next match
            // ("is is fixed" drops the second "is").
            output.push_str(&text[cursor..aux_end]);
            cursor = aux_end;
            continue;
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }
    collapse_ascii_spaces(&output)
}

fn replace_word_phrase(text: &str, phrase: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if ascii_eq_at(text, cursor, phrase)
            && has_word_boundary_before(text, cursor)
            && has_word_boundary_after(text, cursor + phrase.len())
        {
            output.push_str(replacement);
            cursor += phrase.len();
        } else {
            let ch = next_char(text, cursor).unwrap();
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    output
}

fn replace_literal_phrase(text: &str, phrase: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if ascii_eq_at(text, cursor, phrase) {
            output.push_str(replacement);
            cursor += phrase.len();
        } else {
            let ch = next_char(text, cursor).unwrap();
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    output
}

fn apply_phrase_shortenings(text: &str) -> String {
    PHRASE_SHORTENINGS
        .iter()
        .fold(text.to_string(), |working, (phrase, replacement)| {
            replace_word_phrase(&working, phrase, replacement)
        })
}

fn apply_ultra_connectives(text: &str) -> String {
    ULTRA_CONNECTIVE_REPLACEMENTS
        .iter()
        .fold(text.to_string(), |working, (phrase, replacement)| {
            if phrase.starts_with(' ') && phrase.ends_with(' ') {
                replace_literal_phrase(&working, phrase, replacement)
            } else {
                replace_word_phrase(&working, phrase, replacement)
            }
        })
}

fn count_word_occurrences(text: &str, term: &str) -> usize {
    let mut count = 0;
    let mut cursor = 0;
    while cursor < text.len() {
        if ascii_eq_at(text, cursor, term)
            && has_word_boundary_before(text, cursor)
            && has_word_boundary_after(text, cursor + term.len())
        {
            count += 1;
            cursor += term.len();
        } else {
            cursor += next_char(text, cursor).unwrap().len_utf8();
        }
    }
    count
}

fn apply_ultra_abbreviations(text: &str) -> String {
    ULTRA_ABBREVIATIONS
        .iter()
        .fold(text.to_string(), |working, (term, abbreviation)| {
            if count_word_occurrences(&working, term) < 3 {
                return working;
            }
            let mut output = String::with_capacity(working.len());
            let mut cursor = 0;
            while cursor < working.len() {
                if ascii_eq_at(&working, cursor, term)
                    && has_word_boundary_before(&working, cursor)
                    && has_word_boundary_after(&working, cursor + term.len())
                {
                    let first = working[cursor..].chars().next().unwrap();
                    if first.is_ascii_uppercase() {
                        let mut replacement = abbreviation.to_string();
                        if let Some(first) = replacement.get_mut(0..1) {
                            first.make_ascii_uppercase();
                        }
                        output.push_str(&replacement);
                    } else {
                        output.push_str(abbreviation);
                    }
                    cursor += term.len();
                } else {
                    let ch = next_char(&working, cursor).unwrap();
                    output.push(ch);
                    cursor += ch.len_utf8();
                }
            }
            output
        })
}

fn transform_preserving_user_lines(text: &str, transform: impl Fn(&str) -> String) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut output = Vec::with_capacity(lines.len());
    let mut buffer = Vec::new();
    for line in lines {
        if line.starts_with("U: ") {
            if !buffer.is_empty() {
                output.push(transform(&buffer.join("\n")));
                buffer.clear();
            }
            output.push(line.to_string());
        } else {
            buffer.push(line);
        }
    }
    if !buffer.is_empty() {
        output.push(transform(&buffer.join("\n")));
    }
    output.join("\n")
}

fn normalize_whitespace(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let mut normalized = String::with_capacity(line.len());
        let mut previous_space = false;
        for ch in line.chars() {
            if ch == ' ' || ch == '\t' {
                if previous_space {
                    continue;
                }
                normalized.push(' ');
                previous_space = true;
            } else {
                normalized.push(ch);
                previous_space = false;
            }
        }
        while normalized.ends_with([' ', '\t']) {
            normalized.pop();
        }
        lines.push(normalized);
    }
    let mut output = lines.join("\n");
    while output.contains("\n\n\n") {
        output = output.replace("\n\n\n", "\n\n");
    }
    output
}

/// Compress `text` using the same deterministic rules as the TypeScript oracle, with the English
/// word rules.
pub fn compress(text: &str, level: CavemanLevel) -> String {
    compress_with(text, level, true)
}

/// Compress `text`; without `english_word_rules` only the language-neutral passes run (region
/// protection, whitespace normalization and trimming), the same at every level. The English
/// word lists rewrite real words of other languages ("quite" is Spanish for "remove", "a" is a
/// Spanish preposition). Mirrors `cavemanCompress(..., wordRules)` in caveman.ts.
pub fn compress_with(text: &str, level: CavemanLevel, english_word_rules: bool) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let (protected_text, preserved) = protect_regions(text);
    let transformed = transform_preserving_user_lines(&protected_text, |chunk| {
        if !english_word_rules {
            return chunk.to_string();
        }
        let mut working = drop_phrases(chunk, FILLER_WORDS);
        working = drop_phrases(&working, HEDGING_PHRASES);
        working = drop_phrases(&working, PLEASANTRIES);
        working = apply_phrase_shortenings(&working);
        if matches!(level, CavemanLevel::Full | CavemanLevel::Ultra) {
            working = drop_auxiliaries(&working);
            working = drop_articles(&working);
        }
        if level == CavemanLevel::Ultra {
            working = apply_ultra_connectives(&working);
            working = apply_ultra_abbreviations(&working);
        }
        working
    });
    // Normalize while the protected regions are still placeholders, so fenced code keeps its
    // indentation. No region starts or ends with whitespace, so trimming here equals trimming the
    // restored text.
    let normalized = normalize_whitespace(&transformed);
    restore_regions(
        normalized.trim_matches(is_js_whitespace),
        &preserved,
        text.contains('\0'),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct GoldenCase {
        text: String,
        lite: String,
        full: String,
        ultra: String,
    }

    #[test]
    fn differential_golden_matches_typescript_oracle() {
        let cases: Vec<GoldenCase> =
            serde_json::from_str(include_str!("../testdata/caveman-golden.json"))
                .expect("valid caveman golden");
        for case in cases {
            assert_eq!(
                compress(&case.text, CavemanLevel::Lite),
                case.lite,
                "lite: {:?}",
                case.text
            );
            assert_eq!(
                compress(&case.text, CavemanLevel::Full),
                case.full,
                "full: {:?}",
                case.text
            );
            assert_eq!(
                compress(&case.text, CavemanLevel::Ultra),
                case.ultra,
                "ultra: {:?}",
                case.text
            );
        }
    }

    #[derive(Debug, Deserialize)]
    struct LanguageGolden {
        cases: Vec<LanguageCase>,
    }

    #[derive(Debug, Deserialize)]
    struct LanguageCase {
        text: String,
        neutral: String,
    }

    #[test]
    fn language_neutral_golden_matches_typescript_oracle() {
        let golden: LanguageGolden =
            serde_json::from_str(include_str!("../testdata/caveman-language-golden.json"))
                .expect("valid caveman language golden");
        assert!(golden.cases.len() > 60);
        for case in golden.cases {
            for level in [CavemanLevel::Lite, CavemanLevel::Full, CavemanLevel::Ultra] {
                assert_eq!(
                    compress_with(&case.text, level, false),
                    case.neutral,
                    "{level:?}: {:?}",
                    case.text
                );
            }
        }
        assert_eq!(
            compress_with("Voy a revisar la configuración.", CavemanLevel::Full, false),
            "Voy a revisar la configuración."
        );
    }

    #[test]
    fn english_word_rules_keep_the_english_golden_output() {
        let cases: Vec<GoldenCase> =
            serde_json::from_str(include_str!("../testdata/caveman-golden.json"))
                .expect("valid caveman golden");
        for case in cases {
            assert_eq!(
                compress_with(&case.text, CavemanLevel::Lite, true),
                case.lite
            );
            assert_eq!(
                compress_with(&case.text, CavemanLevel::Full, true),
                case.full
            );
            assert_eq!(
                compress_with(&case.text, CavemanLevel::Ultra, true),
                case.ultra
            );
        }
    }

    /// A long whitespace run used to rescan its rest from every character, and restoring
    /// placeholders rescanned the whole text once per preserved region. Both are linear now; the
    /// bounds are far above the linear cost and far below the old quadratic one.
    #[test]
    fn long_whitespace_runs_and_many_paths_compress_in_linear_time() {
        let spaces = format!("x{}y", " ".repeat(200_000));
        let started = std::time::Instant::now();
        for level in [CavemanLevel::Lite, CavemanLevel::Full, CavemanLevel::Ultra] {
            assert_eq!(compress(&spaces, level), "x y");
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "whitespace run took {:?}",
            started.elapsed()
        );

        let paths = (0..20_000)
            .map(|index| format!("see src/f{index}.ts"))
            .collect::<Vec<_>>()
            .join(" ");
        let started = std::time::Instant::now();
        assert_eq!(compress(&paths, CavemanLevel::Lite), paths);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "20k paths took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn nested_placeholders_and_source_nul_restore_like_the_region_at_a_time_replace() {
        // A URL swallows the inline-code placeholder protected before it.
        let nested = "open https://x.io/a`b c` now";
        assert_eq!(compress(nested, CavemanLevel::Lite), nested);
        // A literal placeholder in the source is restored region by region, as TS does.
        let literal = "keep \u{0}MC_PRES_0\u{0} and `code`";
        assert_eq!(
            compress(literal, CavemanLevel::Lite),
            "keep `code` and `code`"
        );
    }
}
