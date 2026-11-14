//! The paths and code names a memory cites, picked out of its text so the
//! module can look each up in the checkout before a verify batch is sent.
//!
//! What counts, each at least four characters:
//! - a backticked span without spaces (`` `mc-module` ``);
//! - a path-shaped token (`crates/x/y.rs`, `task.rs`, `crates/mc-module`),
//!   see [`bare_path`];
//! - a qualified name (`RecipeLane::Pi`) or a dotted operation name
//!   (`session.entries`);
//! - a command-line flag (`--shared-context-db`);
//! - an identifier written in `snake_case`, `SCREAMING_SNAKE`, or
//!   `camelCase`/`PascalCase` with an inner capital.
//!
//! A bare word joined by slashes is a path only when it looks like one of
//! the checkout's: it ends in a file name, starts at a name the checkout's
//! top level holds, or starts with `./`. English joins words with slashes
//! (`prompt/input/output`, `project/user-facing`), and such a phrase, read
//! as a path, would be absent from every checkout, so a rule that cites
//! nothing else would look like one whose subject is gone.
//!
//! A bare hyphenated word is never a code name, however it looks: English
//! makes compounds freely (`audit-flagged`, `zero-delta`, `Team-mode`), and no
//! word list can tell them from a `kebab-case` name, which counts only when
//! it is backticked, path-shaped or a flag. Plain English words are left out,
//! and so are ids (a segment of eight or more hexadecimal characters with a
//! digit), which name a session or a commit rather than code. A token inside
//! a span, path or name already taken is not taken again.

use std::collections::BTreeSet;
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

/// The ends of host names, which a dotted operation name never has.
const DOMAINS: &[&str] = &[
    "com", "org", "net", "io", "dev", "ai", "app", "co", "uk", "de", "edu",
];

/// Product names that look like file names.
const NOT_FILES: &[&str] = &[
    "node.js", "next.js", "vue.js", "nuxt.js", "deno.js", "three.js",
];

/// Common English words, lowercase. A backticked span that is one of them is
/// not a code name.
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
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
/// [`MAX_CITES`]. `top_level` holds the names at the top of the checkout
/// the memory is checked against (`Checkout::top_level`), which decide
/// whether a bare word joined by slashes is a path.
pub(crate) fn cites(content: &str, top_level: &BTreeSet<String>) -> Vec<Cite> {
    static SPAN: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    static QUALIFIED: OnceLock<Regex> = OnceLock::new();
    static DOTTED: OnceLock<Regex> = OnceLock::new();
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
        if matches!(before, Some('~' | ':' | '\\')) || !bare_path(text, top_level) {
            continue;
        }
        covered.push(range.clone());
        found.push((range.start, Cite::Path(text.to_owned())));
    }
    let before = |at: usize| content[..at].chars().next_back();
    let word_char = |ch: char| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$');
    for token in re(
        &QUALIFIED,
        r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+",
    )
    .find_iter(content)
    {
        let range = token.range();
        if overlaps(&covered, &range)
            || before(range.start).is_some_and(word_char)
            || token.as_str().chars().count() < MIN_LEN
            || is_id(token.as_str())
        {
            continue;
        }
        covered.push(range.clone());
        found.push((range.start, Cite::Name(token.as_str().to_owned())));
    }
    for token in re(&DOTTED, r"[a-z][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+").find_iter(content) {
        let range = token.range();
        if overlaps(&covered, &range) || !operation_name(content, range.clone()) {
            continue;
        }
        covered.push(range.clone());
        found.push((range.start, Cite::Name(token.as_str().to_owned())));
    }
    for token in re(&WORD, r"[A-Za-z0-9_$]+(?:-[A-Za-z0-9_$]+)*").find_iter(content) {
        let range = token.range();
        if overlaps(&covered, &range) {
            continue;
        }
        let text = token.as_str();
        // `--name`, after a space or the start, is a command-line flag.
        let flag = range.start >= 2
            && content[..range.start].ends_with("--")
            && !before(range.start - 2).is_some_and(|ch| word_char(ch) || ch == '-');
        if flag {
            if text.chars().any(|ch| ch.is_ascii_alphabetic()) && text.chars().count() >= 2 {
                found.push((range.start - 2, Cite::Name(format!("--{text}"))));
            }
            continue;
        }
        // A bare hyphenated word is English; only a code name written
        // inside it (`ContextDb-backed`) counts.
        let mut at = range.start;
        for part in text.split('-') {
            if identifier(part) {
                found.push((at, Cite::Name(part.to_owned())));
            }
            at += part.len() + 1;
        }
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

/// Whether a backticked `token` reads as a file or folder path inside a
/// checkout: a file name with a known extension, or a path with a `/` that
/// a sentence would not hold (`and/or`), because it ends in `/`, has two or
/// more `/`, or one of its parts holds `_`, `-` or `.`.
pub(crate) fn path_shaped(token: &str) -> bool {
    if !relative_path(token) {
        return false;
    }
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

/// Whether a bare (unbackticked) `token` reads as a file or folder path
/// inside a checkout whose top level holds `top_level`. Without a `/` it
/// must be a file name with a known extension. With one, a sentence holds
/// such words too (`prompt/input/output`, `SOFT/SOFT+/HARD`, `38520/`), so
/// it must start or end like a path: its last part is a file name, its
/// first part is a name at the top of the checkout (`crates/mc-module`,
/// `docs/cache-policy/`), or it starts with `./`, `../`, `~/` or `/`.
/// Digits and slashes alone are a number. A path that leaves the checkout
/// (`../x`, `~/x`, `/x`) is shaped like a path but never counts, as with a
/// backticked one: the checkout can't hold it.
fn bare_path(token: &str, top_level: &BTreeSet<String>) -> bool {
    if !token.contains('/') {
        return path_shaped(token);
    }
    if !relative_path(token) || token.chars().all(|ch| ch.is_ascii_digit() || ch == '/') {
        return false;
    }
    let parts: Vec<&str> = token.trim_end_matches('/').split('/').collect();
    file_name(parts.last().copied().unwrap_or_default())
        || top_level.contains(parts[0])
        || ["./", "../", "~/", "/"]
            .iter()
            .any(|start| token.starts_with(start))
}

/// Whether `token` could be a path inside a checkout at all: long enough,
/// not a package name (`@scope/package`), and relative without leaving the
/// folder it starts in.
fn relative_path(token: &str) -> bool {
    token.chars().count() >= MIN_LEN && !token.starts_with('@') && clean_path(token).is_some()
}

/// Whether `name` is a file name: a stem and a known extension, and not a
/// product named like a file (`node.js`).
fn file_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty()
            && EXTENSIONS.contains(&extension)
            && !NOT_FILES.contains(&name.to_lowercase().as_str())
    })
}

/// Whether the dotted token at `range` of `content` is an operation name
/// (`session.entries`) rather than an abbreviation, a host name, a file name
/// or part of a path: each part two or more characters, not after a word
/// character, `/`, `@` or `.`, not before `/`, and not ending in a host
/// name's end or a file extension.
fn operation_name(content: &str, range: Range<usize>) -> bool {
    let text = &content[range.clone()];
    let previous = content[..range.start].chars().next_back();
    let next = content[range.end..].chars().next();
    let last = text.rsplit('.').next().unwrap_or_default();
    text.chars().count() >= MIN_LEN
        && text.split('.').all(|part| part.chars().count() >= 2)
        && !previous.is_some_and(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '/' | '@' | '.')
        })
        && next != Some('/')
        && !DOMAINS.contains(&last)
        && !EXTENSIONS.contains(&last)
        && !is_id(text)
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

/// Whether a word without hyphens is a code name: `snake_case` (and
/// `SCREAMING_SNAKE`), or `camelCase`/`PascalCase` with an inner capital.
fn identifier(token: &str) -> bool {
    if token.chars().count() < MIN_LEN
        || !token.chars().any(|ch| ch.is_ascii_alphabetic())
        || is_id(token)
    {
        return false;
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
