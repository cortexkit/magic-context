//! The paths and code names a memory cites, picked out of its text so the
//! module can look each up in the checkout before a verify batch is sent.
//!
//! Three kinds of text count: a backticked span without spaces, a
//! path-shaped token (`crates/x/y.rs`, `task.rs`, `crates/mc-module`), and an
//! identifier of four or more characters written in `snake_case`,
//! `camelCase`/`PascalCase` or `kebab-case`. Plain English words, hyphenated
//! ones like `read-only` included, are left out, and so are ids (a segment of
//! eight or more hexadecimal characters with a digit), which name a session
//! or a commit rather than code. A token inside a span or path already taken
//! is not taken again.

use std::ops::Range;
use std::sync::OnceLock;

use regex::Regex;

use crate::dreamer::checkout::clean_path;

/// At most this many citations are looked up for one memory.
pub(crate) const MAX_CITES: usize = 16;
/// A citation shorter than this says nothing by its absence.
const MIN_LEN: usize = 4;

/// File extensions that make a token without a `/` a file name.
const EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "md", "mdx",
    "toml", "yaml", "yml", "sql", "sh", "bash", "zsh", "py", "go", "txt", "lock", "css", "scss",
    "html", "swift", "kt", "java", "c", "h", "cc", "cpp", "hpp", "rb", "php", "cs", "proto",
    "wasm",
];

/// Product names that look like file names.
const NOT_FILES: &[&str] = &[
    "node.js", "next.js", "vue.js", "nuxt.js", "deno.js", "three.js",
];

/// Common English words, lowercase. A backticked span that is one of them,
/// or a hyphenated token made only of them, is not a code name.
const COMMON: &[&str] = &[
    "a", "about", "above", "after", "again", "against", "all", "also", "always", "an", "and",
    "any", "are", "as", "at", "back", "be", "because", "been", "before", "being", "below", "best",
    "between", "both", "built", "but", "by", "can", "case", "check", "co", "come", "could",
    "cross", "data", "day", "did", "do", "does", "done", "down", "during", "e", "each", "end",
    "even", "ever", "every", "fail", "false", "few", "file", "first", "for", "free", "from",
    "full", "get", "go", "good", "had", "half", "hand", "hard", "has", "have", "he", "her", "here",
    "high", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "keep",
    "kind", "know", "last", "late", "least", "left", "less", "level", "like", "line", "list",
    "live", "long", "look", "low", "made", "mail", "main", "make", "many", "may", "me", "mid",
    "might", "more", "most", "much", "multi", "must", "my", "name", "need", "never", "new", "next",
    "no", "non", "none", "not", "now", "of", "off", "old", "on", "once", "one", "only", "open",
    "or", "other", "our", "out", "over", "own", "part", "per", "post", "pre", "read", "real",
    "right", "run", "same", "see", "self", "set", "she", "short", "should", "side", "single", "so",
    "some", "start", "step", "still", "such", "take", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "thing", "third", "this", "those", "three", "through",
    "time", "to", "too", "top", "true", "turn", "two", "un", "under", "until", "up", "upon", "us",
    "use", "used", "very", "was", "way", "we", "well", "were", "what", "when", "where", "which",
    "while", "who", "whole", "why", "wide", "will", "with", "within", "without", "word", "work",
    "would", "write", "x", "yes", "yet", "you", "your",
];

/// One thing a memory cites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Cite {
    /// A file or folder, as the memory writes it.
    Path(String),
    /// A code name, looked up as literal text.
    Name(String),
}

impl Cite {
    pub(crate) fn text(&self) -> &str {
        match self {
            Self::Path(text) | Self::Name(text) => text,
        }
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a fixed citation pattern"))
}

/// What `content` cites, in the order it first appears, at most
/// [`MAX_CITES`].
pub(crate) fn cites(content: &str) -> Vec<Cite> {
    static SPAN: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    let mut found: Vec<(usize, Cite)> = Vec::new();
    let mut covered: Vec<Range<usize>> = Vec::new();
    let overlaps = |covered: &[Range<usize>], range: &Range<usize>| {
        covered
            .iter()
            .any(|taken| taken.start < range.end && range.start < taken.end)
    };

    for span in re(&SPAN, r"`([^`\n]+)`").captures_iter(content) {
        let inner = span.get(1).expect("a span has its text");
        let Some(cite) = span_cite(inner.as_str()) else {
            continue;
        };
        covered.push(inner.range());
        found.push((inner.start(), cite));
    }
    for token in re(&PATH, r"[A-Za-z0-9_.@+/-]+").find_iter(content) {
        let range = token.range();
        if overlaps(&covered, &range) {
            continue;
        }
        let text = token.as_str().trim_end_matches(['.', '-']);
        // A run that follows `~` or `:` is a home-folder path or a URL.
        let before = content[..range.start].chars().next_back();
        if matches!(before, Some('~' | ':' | '\\')) || !path_shaped(text) {
            continue;
        }
        covered.push(range.clone());
        found.push((range.start, Cite::Path(text.to_owned())));
    }
    for token in re(&WORD, r"[A-Za-z0-9_$]+(?:-[A-Za-z0-9_$]+)*").find_iter(content) {
        if overlaps(&covered, &token.range()) || !identifier(token.as_str()) {
            continue;
        }
        found.push((token.start(), Cite::Name(token.as_str().to_owned())));
    }

    found.sort_by_key(|(at, _)| *at);
    let mut cites: Vec<Cite> = Vec::new();
    for (_, cite) in found {
        if cites.len() == MAX_CITES {
            break;
        }
        if !cites.iter().any(|seen| seen.text() == cite.text()) {
            cites.push(cite);
        }
    }
    cites
}

/// What one backticked span cites: a path, a code name, or nothing when it
/// holds spaces, a placeholder, or a plain word.
fn span_cite(raw: &str) -> Option<Cite> {
    let text = raw.trim();
    let text = text.strip_suffix("()").unwrap_or(text);
    let text = text.trim_end_matches(['.', ',', ';', ':']);
    if text.chars().count() < MIN_LEN
        || text.chars().any(char::is_whitespace)
        || ["<", ">", "*", "{", "}", "…", "..."]
            .iter()
            .any(|mark| text.contains(mark))
        || !text.chars().any(|ch| ch.is_ascii_alphabetic())
        || is_id(text)
    {
        return None;
    }
    if path_shaped(text) {
        return Some(Cite::Path(text.to_owned()));
    }
    if text.contains('/') || text.starts_with('~') || COMMON.contains(&text.to_lowercase().as_str())
    {
        return None;
    }
    Some(Cite::Name(text.to_owned()))
}

/// Whether `token` reads as a file or folder path inside a checkout: a file
/// name with a known extension, or a path with a `/` that a sentence would
/// not hold (`and/or`), because it ends in `/`, has two or more `/`, or
/// one of its parts holds `_`, `-` or `.`.
pub(crate) fn path_shaped(token: &str) -> bool {
    // `@scope/package` names a package, not a file of the checkout.
    if token.chars().count() < MIN_LEN || token.starts_with('@') || clean_path(token).is_none() {
        return false;
    }
    let file_name = |name: &str| {
        name.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && EXTENSIONS.contains(&extension)
                && !NOT_FILES.contains(&name.to_lowercase().as_str())
        })
    };
    if !token.contains('/') {
        return file_name(token);
    }
    let parts: Vec<&str> = token.trim_end_matches('/').split('/').collect();
    file_name(parts.last().copied().unwrap_or_default())
        || token.ends_with('/')
        || parts.len() >= 3
        || parts.iter().any(|part| {
            part.contains(['_', '-', '.']) && part.chars().any(|ch| ch.is_ascii_alphabetic())
        })
}

/// Whether `token` is a code name the module can look up as literal text:
/// letters, digits, `_`, `$` and `-`, starting with a letter, `_` or `$`,
/// at least four characters, and not an id.
pub(crate) fn name_shaped(token: &str) -> bool {
    let mut chars = token.chars();
    token.chars().count() >= MIN_LEN
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '-'))
        && !is_id(token)
}

/// A session, run or commit id rather than a code name: some part, between
/// `_` or `-`, is eight or more hexadecimal characters with a digit.
fn is_id(token: &str) -> bool {
    token.split(['_', '-', ':', '.']).any(|part| {
        part.len() >= 8
            && part.bytes().all(|byte| byte.is_ascii_hexdigit())
            && part.bytes().any(|byte| byte.is_ascii_digit())
    })
}

/// Whether a word-shaped token is a code name: `snake_case`, `camelCase` or
/// `PascalCase` with an inner capital, or `kebab-case` not made only of
/// common words or numbers.
fn identifier(token: &str) -> bool {
    if token.chars().count() < MIN_LEN
        || !token.chars().any(|ch| ch.is_ascii_alphabetic())
        || is_id(token)
    {
        return false;
    }
    if token.contains('-') {
        return token.split('-').any(|part| {
            let part = part.to_lowercase();
            !COMMON.contains(&part.as_str()) && !part.bytes().all(|byte| byte.is_ascii_digit())
        });
    }
    if token.contains('_') {
        return token
            .split('_')
            .filter(|part| part.chars().any(|ch| ch.is_ascii_alphanumeric()))
            .count()
            >= 2;
    }
    let bytes = token.as_bytes();
    bytes.windows(2).any(|pair| {
        (pair[0].is_ascii_lowercase() || pair[0].is_ascii_digit()) && pair[1].is_ascii_uppercase()
    })
}

#[cfg(test)]
#[path = "cites_tests.rs"]
mod tests;
