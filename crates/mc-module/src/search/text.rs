//! Text helpers for search: FTS query building, injected-block removal,
//! literal probes, previews and snippets. Each is the TypeScript plugin's,
//! with lengths and cuts in UTF-16 code units the way it measures them, so
//! both write the same index rows and render the same results.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::js_text::string_from_utf16_prefix;

/// Results show at most this many UTF-16 code units of text.
pub const PREVIEW_LIMIT: usize = 220;
/// The marker Oh My OpenCode puts on prompts it sends itself.
const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";
/// The start of a Magic Context directive written into a user message.
const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Length as JavaScript counts it: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The longest prefix of at most `units` UTF-16 code units that ends on a
/// character boundary (JavaScript's `slice(0, units)`, minus a split pair).
pub(crate) fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

/// Collapse whitespace runs to one space and trim, as `/\s+/g` does in
/// JavaScript.
pub fn collapse_whitespace(text: &str) -> String {
    text.split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Remove the tagged regions named in `names`, nested ones and ones never
/// closed included. Everything after an unclosed opening tag goes.
pub fn remove_nested_blocks(text: &str, names: &[&str]) -> String {
    let pattern = format!(r"(?i)<(/?)({})(?:\s[^<>]*?)?\s*(/?)>", names.join("|"));
    let tags = Regex::new(&pattern).expect("valid regex");
    let mut stack: Vec<String> = Vec::new();
    let mut end = 0;
    let mut result = String::new();
    for captures in tags.captures_iter(text) {
        let whole = captures.get(0).expect("match");
        if stack.is_empty() {
            result.push_str(&text[end..whole.start()]);
        }
        let name = captures[2].to_lowercase();
        if !captures[1].is_empty() {
            if stack.last() == Some(&name) {
                stack.pop();
            }
        } else if captures[3].is_empty() {
            stack.push(name);
        }
        end = whole.end();
    }
    if stack.is_empty() {
        result.push_str(&text[end..]);
    }
    result
}

pub fn remove_system_reminders(text: &str) -> String {
    remove_nested_blocks(text, &["system-reminder"])
        .trim()
        .to_owned()
}

pub fn remove_task_notifications(text: &str) -> String {
    remove_nested_blocks(text, &["task", "task_cohort"])
}

/// Text with injected notifications removed, for scoring and rendering.
pub fn clean_search_text(text: &str) -> String {
    collapse_whitespace(&remove_nested_blocks(
        text,
        &["system-reminder", "task", "task_cohort"],
    ))
}

/// OpenCode wraps a message the user typed mid-turn in this reminder. It is
/// the user's own text, so cleaning keeps it.
fn steering_wrapper() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"<system-reminder>\nThe user sent the following message:\n[\s\S]*?\n\nPlease address this message and continue with your tasks\.\n</system-reminder>",
    )
}

/// A user message's text with injected reminders removed, keeping the
/// user's own mid-turn messages.
pub fn clean_user_text(text: &str) -> String {
    let strip =
        |segment: &str| remove_system_reminders(segment).replace(OMO_INTERNAL_INITIATOR_MARKER, "");
    let mut result = String::new();
    let mut cursor = 0;
    for found in steering_wrapper().find_iter(text) {
        result.push_str(&strip(&text[cursor..found.start()]));
        result.push_str(found.as_str());
        cursor = found.end();
    }
    result.push_str(&strip(&text[cursor..]));
    result.trim().to_owned()
}

/// Whether a user text part carries anything the user wrote.
pub fn is_meaningful_user_text(text: &str) -> bool {
    let cleaned = remove_system_reminders(text)
        .replace(OMO_INTERNAL_INITIATOR_MARKER, "")
        .trim()
        .to_owned();
    !cleaned.is_empty() && !cleaned.trim_start().starts_with(SYSTEM_DIRECTIVE_PREFIX)
}

/// The text a message adds to the search index, or empty. User text loses
/// injected reminders and task notifications; assistant text loses task
/// notifications and reminders. Parts are joined with ` / `.
pub fn indexable_content(user: bool, texts: &[&str]) -> String {
    let texts: Vec<&str> = texts
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect();
    if user && !texts.iter().any(|text| is_meaningful_user_text(text)) {
        return String::new();
    }
    texts
        .iter()
        .map(|text| {
            let text = remove_task_notifications(text);
            let text = if user {
                clean_user_text(&text)
            } else {
                remove_system_reminders(&text)
            };
            collapse_whitespace(&text)
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

/// Every whitespace-separated token as a quoted FTS5 string, so `-`, `:`
/// and other operator characters match literally. The tokens are ANDed.
pub fn sanitize_fts_query(query: &str) -> String {
    query
        .replace('\0', " ")
        .split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn word_regex() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"[\p{L}\p{N}_]+")
}

/// For a query whose ANDed form found nothing: up to 16 distinct words
/// longer than two characters (or holding a digit), ORed.
pub fn relaxed_fts_query(query: &str) -> String {
    let mut seen = HashSet::new();
    word_regex()
        .find_iter(query)
        .map(|found| found.as_str())
        .filter(|token| seen.insert(*token))
        .filter(|token| utf16_len(token) > 2 || token.chars().any(|ch| ch.is_ascii_digit()))
        .take(16)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

const STOP_WORDS: &str = "a an and are as at be been by can could did do does for from how i in is it me my of on or our please should that the their them there these they this to us was we were what when where which who why will with would you your";

fn stop_words() -> &'static HashSet<&'static str> {
    static CELL: OnceLock<HashSet<&'static str>> = OnceLock::new();
    CELL.get_or_init(|| STOP_WORDS.split(' ').collect())
}

/// The distinct lowercased words of `text` that are not stop words.
fn terms(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut seen = HashSet::new();
    word_regex()
        .find_iter(&lowered)
        .map(|found| found.as_str().to_owned())
        .filter(|term| !stop_words().contains(term.as_str()))
        .filter(|term| seen.insert(term.clone()))
        .collect()
}

/// The share of distinct query terms present in `content`, times 0.8.
pub fn keyword_relevance(query: &str, content: &str) -> f64 {
    let needles = terms(query);
    if needles.is_empty() {
        return 0.0;
    }
    let words: HashSet<String> = terms(&clean_search_text(content)).into_iter().collect();
    0.8 * needles.iter().filter(|term| words.contains(*term)).count() as f64 / needles.len() as f64
}

fn cjk_run() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$",
    )
}

fn hint_terms(text: &str) -> Vec<String> {
    static CELL: OnceLock<Regex> = OnceLock::new();
    let runs = regex(
        &CELL,
        r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+",
    );
    let mut seen = HashSet::new();
    terms(text)
        .iter()
        .flat_map(|term| runs.find_iter(term).map(|found| found.as_str().to_owned()))
        .filter(|term| !stop_words().contains(term.as_str()))
        .filter(|term| seen.insert(term.clone()))
        .collect()
}

fn character_bigrams(run: &str) -> Vec<String> {
    let characters: Vec<char> = run.chars().collect();
    if characters.len() == 1 {
        vec![run.to_owned()]
    } else {
        characters
            .windows(2)
            .map(|pair| pair.iter().collect())
            .collect()
    }
}

/// Match unspaced clauses for hints without changing retrieval or snippet scoring.
pub fn hint_keyword_relevance(query: &str, content: &str) -> f64 {
    let needles = hint_terms(query);
    if needles.is_empty() {
        return 0.0;
    }
    let words: HashSet<String> = hint_terms(&clean_search_text(content))
        .into_iter()
        .collect();
    let runs: Vec<&String> = words
        .iter()
        .filter(|word| cjk_run().is_match(word))
        .collect();
    let bigrams: HashSet<String> = runs.iter().flat_map(|run| character_bigrams(run)).collect();
    let mut matched = 0.0;
    for needle in &needles {
        if !cjk_run().is_match(needle) {
            matched += f64::from(words.contains(needle));
            continue;
        }
        if needle.chars().count() == 1 {
            matched += f64::from(runs.iter().any(|run| run.contains(needle)));
            continue;
        }
        let grams = character_bigrams(needle);
        // Count each clause as one term so filler bigrams across word boundaries
        // do not dilute it; require half coverage so shared function words alone do not pass.
        matched += (grams.iter().filter(|gram| bigrams.contains(*gram)).count() as f64
            / grams.len().div_ceil(2) as f64)
            .min(1.0);
    }
    0.8 * matched / needles.len() as f64
}

/// The UTF-16 slice `[start, end)` of `units`, as text.
fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    let start = start.min(units.len());
    let end = end.clamp(start, units.len());
    String::from_utf16_lossy(&units[start..end])
}

/// The passage of `content` (cleaned) that covers the most query terms, at
/// most `cap` UTF-16 code units, with `…` where it was cut. Empty when no
/// query term occurs.
pub fn matched_snippet(content: &str, query: &str, cap: usize) -> String {
    let text = clean_search_text(content);
    let units: Vec<u16> = text.encode_utf16().collect();
    let needles: HashSet<String> = terms(query).into_iter().collect();
    // Each matching word's start, in UTF-16 code units.
    let matches: Vec<usize> = word_regex()
        .find_iter(&text)
        .filter(|found| needles.contains(&found.as_str().to_lowercase()))
        .map(|found| utf16_len(&text[..found.start()]))
        .collect();
    let Some(&first) = matches.first() else {
        return String::new();
    };
    let mut best_start = first;
    let mut best_coverage = -1.0;
    for &index in &matches {
        let start = index.saturating_sub(cap / 5);
        let coverage = keyword_relevance(query, &utf16_slice(&units, start, start + cap));
        if coverage > best_coverage {
            best_start = start;
            best_coverage = coverage;
        }
    }
    if best_start > 0 {
        let space = units[best_start..]
            .iter()
            .position(|unit| *unit == u16::from(b' '));
        if let Some(offset) = space {
            let boundary = best_start + offset;
            if boundary < *matches.last().expect("non-empty") {
                best_start = boundary + 1;
            }
        }
    }
    let passage = utf16_slice(&units, best_start, best_start + cap);
    format!(
        "{}{}{}",
        if best_start > 0 { "…" } else { "" },
        passage.trim(),
        if best_start + cap < units.len() {
            "…"
        } else {
            ""
        }
    )
}

/// Whitespace collapsed, and at most [`PREVIEW_LIMIT`] UTF-16 code units,
/// ending in `…` when cut.
pub fn preview(text: &str) -> String {
    let normalized = collapse_whitespace(text);
    let units: Vec<u16> = normalized.encode_utf16().collect();
    if units.len() <= PREVIEW_LIMIT {
        return normalized;
    }
    format!(
        "{}…",
        string_from_utf16_prefix(&units, PREVIEW_LIMIT - 1).trim_end()
    )
}

const MAX_PROBES: usize = 5;
const MIN_PROBE_LENGTH: usize = 3;

/// Literal symbols, commands, paths and identifiers in a query, most
/// specific shapes first, deduplicated without case and capped at five.
/// Plain prose yields none. Each probe is searched on its own, so a message
/// holding the literal but few of the query's other words is still found.
pub fn literal_probes(query: &str) -> Vec<String> {
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    static SLASH: OnceLock<Regex> = OnceLock::new();
    static ERROR_CODE: OnceLock<Regex> = OnceLock::new();
    static DOTTED: OnceLock<Regex> = OnceLock::new();
    static KEBAB: OnceLock<Regex> = OnceLock::new();
    static CAMEL: OnceLock<Regex> = OnceLock::new();
    static SHA: OnceLock<Regex> = OnceLock::new();
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |raw: &str| {
        let probe = raw.trim();
        if utf16_len(probe) < MIN_PROBE_LENGTH || !seen.insert(probe.to_lowercase()) {
            return;
        }
        ordered.push(probe.to_owned());
    };
    for captures in regex(&QUOTED, r#"["`]([^"`]{3,80})["`]"#).captures_iter(trimmed) {
        add(&captures[1]);
    }
    for found in regex(&SLASH, r"(?i)/[a-z][a-z0-9]*(?:-[a-z0-9]+)+").find_iter(trimmed) {
        add(found.as_str());
    }
    for found in regex(&ERROR_CODE, r"\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b").find_iter(trimmed) {
        add(found.as_str());
    }
    for found in regex(&DOTTED, r"(?i)[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+").find_iter(trimmed) {
        add(found.as_str());
    }
    for found in regex(&KEBAB, r"(?i)[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+").find_iter(trimmed) {
        add(found.as_str());
    }
    for found in regex(&CAMEL, r"\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b").find_iter(trimmed) {
        add(found.as_str());
    }
    for found in regex(&SHA, r"(?i)\b[0-9a-f]{7,40}\b").find_iter(trimmed) {
        if found.as_str().chars().any(|ch| ch.is_ascii_digit()) {
            add(found.as_str());
        }
    }
    ordered.truncate(MAX_PROBES);
    ordered
}

/// Whether one of `probes` occurs in `text`, ignoring case.
pub fn contains_probe_verbatim(text: &str, probes: &[String]) -> bool {
    let haystack = text.to_lowercase();
    probes
        .iter()
        .any(|probe| haystack.contains(&probe.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_scoring_preserves_space_separated_keyword_scores() {
        for (query, content, expected) in [
            ("explain historian cache wiring", "cache icons", 0.2),
            (
                "historian cache wiring",
                "historian cache wiring details",
                0.8000000000000002,
            ),
            (
                "please explain cache wiring to me",
                "cache wiring",
                0.5333333333333333,
            ),
            ("CACHE cache cache_timeout", "cache_timeout", 0.4),
            ("how are you", "how are you", 0.0),
            ("historian cache", "<task>historian cache</task>", 0.0),
            ("résumé über prüfen", "über prüfen", 0.5333333333333333),
            ("память кеш", "кеш", 0.4),
            ("ذاكرة تخزين", "تخزين", 0.4),
        ] {
            assert_eq!(keyword_relevance(query, content), expected, "{query}");
            assert_eq!(hint_keyword_relevance(query, content), expected, "{query}");
        }
    }

    #[test]
    fn only_hint_scoring_splits_unspaced_cjk_runs_into_character_bigrams() {
        assert_eq!(
            keyword_relevance("MC_Maze 残差怎样汇总？", "MC_Maze 残差按种子汇总。"),
            0.4
        );
        for (query, content, expected) in [
            ("残差", "残留", 0.0),
            ("差", "残差", 0.8),
            ("𠮷野家", "𠮷野川", 0.8),
            ("かながき", "かながきです", 0.8),
            ("カタカナ", "カタカナです", 0.8),
            ("프로젝트캐시", "프로젝트의캐시", 0.8),
            ("cache残差", "cache残差按种子汇总", 0.8),
            ("差", "<task>残差</task> unrelated", 0.0),
        ] {
            assert_eq!(hint_keyword_relevance(query, content), expected, "{query}");
        }
    }

    #[test]
    fn nested_and_unclosed_blocks_are_removed() {
        assert_eq!(
            remove_nested_blocks("a<task>b<task>c</task>d</task>e", &["task"]),
            "ae"
        );
        assert_eq!(
            remove_nested_blocks("keep <task id=\"1\">drop", &["task"]),
            "keep "
        );
        assert_eq!(remove_nested_blocks("a<task/>b", &["task"]), "ab");
    }

    #[test]
    fn user_text_keeps_mid_turn_messages_and_loses_reminders() {
        let text = "Hi <system-reminder>noise</system-reminder>\n<system-reminder>\nThe user sent the following message:\nstop that\n\nPlease address this message and continue with your tasks.\n</system-reminder>";
        let cleaned = clean_user_text(text);
        assert!(cleaned.starts_with("Hi") && cleaned.contains("stop that"));
        assert!(!cleaned.contains("noise"));
        assert_eq!(
            indexable_content(true, &["<system-reminder>only</system-reminder>"]),
            ""
        );
        assert_eq!(
            indexable_content(false, &["one\n two", "three"]),
            "one two / three"
        );
    }

    #[test]
    fn fts_queries_quote_every_token() {
        assert_eq!(
            sanitize_fts_query("ctx-status \"x\""),
            r#""ctx-status" """x""""#
        );
        assert_eq!(
            relaxed_fts_query("why did ctx-status fail on 2 runs"),
            r#""why" OR "did" OR "ctx" OR "status" OR "fail" OR "2" OR "runs""#
        );
    }

    #[test]
    fn probes_pick_literals_in_priority_order() {
        assert_eq!(
            literal_probes("why did /ctx-status call getMessageOrdinal in search.ts at 1a2b3c4d"),
            vec![
                "/ctx-status",
                "search.ts",
                "ctx-status",
                "getMessageOrdinal",
                "1a2b3c4d"
            ]
        );
        assert!(literal_probes("how does the summarizer decide").is_empty());
    }

    #[test]
    fn snippets_center_on_the_densest_match() {
        let content = format!(
            "{} the cache bust came from the hold {}",
            "x ".repeat(200),
            "y ".repeat(200)
        );
        let snippet = matched_snippet(&content, "cache bust hold", 60);
        assert!(
            snippet.starts_with('…') && snippet.ends_with('…'),
            "{snippet}"
        );
        assert!(
            snippet.contains("cache bust came from the hold"),
            "{snippet}"
        );
        assert_eq!(matched_snippet("nothing here", "cache", 60), "");
        assert_eq!(
            preview(&"a ".repeat(200)).encode_utf16().count(),
            PREVIEW_LIMIT
        );
    }
}
