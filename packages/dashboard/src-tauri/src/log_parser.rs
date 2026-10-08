use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Harness identifier — must match the strings used by the TypeScript-side
/// `HarnessId` type (`packages/plugin/src/shared/harness.ts`) and by the
/// per-harness temp-directory layout defined in
/// `packages/plugin/src/shared/data-path.ts:getMagicContextTempDir`.
#[derive(Debug, Clone, Copy)]
pub enum Harness {
    Opencode,
    /// The OpenCode 2 plugin logs under its own `opencode2` temp subtree.
    Opencode2,
    Pi,
    Omp,
}

impl Harness {
    fn as_str(self) -> &'static str {
        match self {
            Harness::Opencode => "opencode",
            Harness::Opencode2 => "opencode2",
            Harness::Pi => "pi",
            Harness::Omp => "omp",
        }
    }
}

/// Resolve the plugin log file for a specific harness.
///
/// The plugin writes separate logs per harness so a single machine running
/// each can produce an independent issue report:
///   - OpenCode → `${tmpdir}/opencode/magic-context/magic-context.log`
///   - OpenCode 2 → `${tmpdir}/opencode2/magic-context/magic-context.log`
///   - Pi       → `${tmpdir}/pi/magic-context/magic-context.log`
///   - OMP      → `${tmpdir}/omp/magic-context/magic-context.log`
///
/// Mirrors the resolution done in TypeScript at
/// `packages/plugin/src/shared/data-path.ts:getMagicContextLogPath`. Kept
/// in sync manually because the dashboard doesn't import any TypeScript
/// source.
pub fn resolve_log_path_for(harness: Harness) -> PathBuf {
    // Mirror the plugin's getMagicContextLogPath: an explicit override wins over
    // the harness temp-dir default so the dashboard reads the same file the
    // plugin writes when the user relocates it. Blank/whitespace is treated as
    // unset.
    if let Some(env_path) = std::env::var("MAGIC_CONTEXT_LOG_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(env_path);
    }

    resolve_log_path_from_temp_dir(&std::env::temp_dir(), harness)
}

fn resolve_log_path_from_temp_dir(temp_dir: &std::path::Path, harness: Harness) -> PathBuf {
    temp_dir
        .join(harness.as_str())
        .join("magic-context")
        .join("magic-context.log")
}

/// Resolve the module data directory using the same environment precedence as
/// the database reader. Log discovery must not depend on context.db existing.
fn resolve_storage_dir() -> Option<PathBuf> {
    if let Some(path) = std::env::var("MAGIC_CONTEXT_STORAGE_DIR")
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path.is_absolute().then_some(path);
    }
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))?;
    Some(data_home.join("cortexkit").join("magic-context"))
}

/// Return every distinct legacy and fleet log the dashboard can read.
pub fn resolve_log_paths() -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(10);
    if let Some(override_path) = std::env::var("MAGIC_CONTEXT_LOG_PATH")
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        paths.push(override_path);
    }
    for harness in [
        Harness::Opencode,
        Harness::Opencode2,
        Harness::Pi,
        Harness::Omp,
    ] {
        let path = resolve_log_path_from_temp_dir(&std::env::temp_dir(), harness);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if let Some(storage_dir) = resolve_storage_dir() {
        let logs = storage_dir.join("logs");
        for name in [
            "magic-context.opencode.log",
            "magic-context.opencode2.log",
            "magic-context.pi.log",
            "magic-context.omp.log",
            "magic-context.log",
        ] {
            let path = logs.join(name);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

#[derive(Debug, Serialize, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: Option<String>,
    pub component: String,
    /// Dotted logger name the r2 line writes before its colon
    /// (`magic-context.historian`); the bare module id for the two older
    /// grammars, which name only the module.
    pub logger: String,
    pub session_id: String,
    pub tags: Vec<String>,
    /// Context bound to a scope rather than to one event: r2's bracket, r1's
    /// leading `session=`. Values stay as written (`session=opencode:ses_x`);
    /// `session_id` above is the bare id the session pickers show.
    pub bound: HashMap<String, String>,
    pub message: String,
    pub kv: HashMap<String, String>,
    pub raw: String,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub hit_ratio: Option<f64>,
}

/// The three line shapes this reader accepts, discriminated by shape alone:
///   `FleetR2` — `<ts> <LEVEL> <logger>: [<bound fields>] <message> <fields>`
///   `FleetR1` — `<ts> <LEVEL> magic-context <session=…> <tag=…>* <message> <fields>`
///   `Legacy`  — `[<ts>] [magic-context][<session>] <message> <fields>`
/// r2 replaced r1's module column and `tag=` field with a dotted logger name
/// and moved the session into a bracket of bound context. Old files are never
/// rewritten, so all three keep parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogGrammar {
    FleetR2,
    FleetR1,
    Legacy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLogLine {
    pub ts: String,
    pub level: Option<String>,
    pub logger: String,
    pub session: Option<String>,
    pub tags: Vec<String>,
    pub bound: HashMap<String, String>,
    pub message: String,
    pub kv: HashMap<String, String>,
    pub grammar: LogGrammar,
}

#[derive(Debug, Serialize, Clone)]
pub struct CacheEvent {
    pub timestamp: String,
    pub session_id: String,
    pub cache_read: i64,
    pub cache_write: i64,
    pub input_tokens: i64,
    pub hit_ratio: f64,
    pub cause: Option<String>,
    pub severity: String, // "stable", "warning", "bust", "full_bust"
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionCacheStats {
    pub session_id: String,
    pub event_count: usize,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_input: i64,
    pub hit_ratio: f64,
    pub last_timestamp: String,
    pub bust_count: usize,
}

lazy_static::lazy_static! {
    static ref LEGACY_LOG_LINE_RE: Regex = Regex::new(
        r"^\[([^\]]+)\] \[magic-context\]\[([^\]]*)\]\s+(.*)$"
    ).unwrap();
    static ref FLEET_ENVELOPE_RE: Regex = Regex::new(
        r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (TRACE|DEBUG|INFO |WARN |ERROR) (.*)$"
    ).unwrap();
}

/// The module id the two pre-r2 grammars hard-code in their envelope.
const MODULE_ID: &str = "magic-context";

/// An r2 logger name: dotted segments of `[a-z][a-z0-9-]*`, rooted at the module id.
fn is_logger_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|segment| {
            let mut chars = segment.chars();
            matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
                && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        })
}

fn tokenize(input: &str, limit: usize) -> Option<Vec<(usize, &str)>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() && tokens.len() < limit {
        while index < bytes.len() && bytes[index] == b' ' {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let start = index;
        let mut quoted = false;
        let mut escaped = false;
        while index < bytes.len() {
            match bytes[index] {
                _ if escaped => escaped = false,
                b'\\' if quoted => escaped = true,
                b'"' => quoted = !quoted,
                b' ' if !quoted => break,
                _ => {}
            }
            index += 1;
        }
        if quoted || escaped {
            return None;
        }
        tokens.push((start, &input[start..index]));
    }
    Some(tokens)
}

fn decode_escapes(value: &str) -> Option<String> {
    let mut decoded = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.push(ch);
            continue;
        }
        match chars.next()? {
            'n' => decoded.push('\n'),
            '"' => decoded.push('"'),
            '\\' => decoded.push('\\'),
            'u' => {
                let mut codepoint = 0u32;
                for _ in 0..4 {
                    codepoint = codepoint * 16 + chars.next()?.to_digit(16)?;
                }
                decoded.push(char::from_u32(codepoint)?);
            }
            _ => return None,
        }
    }
    Some(decoded)
}

fn parse_field(token: &str) -> Option<(String, String)> {
    let (key, raw_value) = token.split_once('=')?;
    if key.is_empty()
        || !key.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_alphanumeric() || (index > 0 && ".-".contains(ch))
        })
        || key.chars().next()?.is_ascii_digit()
    {
        return None;
    }
    let value = if raw_value.starts_with('"') {
        if raw_value.len() < 2 || !raw_value.ends_with('"') {
            return None;
        }
        decode_escapes(&raw_value[1..raw_value.len() - 1])?
    } else {
        if raw_value.is_empty() || raw_value.contains('"') {
            return None;
        }
        raw_value.to_string()
    };
    Some((key.to_string(), value))
}

/// Every token of `input` as fields, or `None` when any token is not one.
fn parse_field_list(input: &str) -> Option<Vec<(String, String)>> {
    tokenize(input, usize::MAX)?
        .into_iter()
        .map(|(_, token)| parse_field(token))
        .collect()
}

/// Index of the `]` closing a bracket opened at index 0, or `None` when none
/// closes it. A `]` inside a quoted value is not the end of the bracket, which
/// is why r2 quotes a bound value containing a space.
fn bound_bracket_end(input: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in input.bytes().enumerate().skip(1) {
        match byte {
            _ if escaped => escaped = false,
            b'\\' if quoted => escaped = true,
            b'"' => quoted = !quoted,
            b']' if !quoted => return Some(index),
            _ => {}
        }
    }
    None
}

/// True when a bracketed field list trails the message. r2 puts bound context
/// before the message so its column is stable, so a line that binds after the
/// message is malformed rather than a line with late context.
fn trailing_bound_bracket(input: &str) -> bool {
    let trimmed = input.trim_end();
    if !trimmed.ends_with(']') {
        return false;
    }
    let Some(open) = trimmed.rfind('[') else {
        return false;
    };
    // A space before `[` keeps an event field value such as `args=[a=1]` out of
    // this check; a bracket at index 0 is the bound bracket itself.
    if open == 0 || trimmed.as_bytes()[open - 1] != b' ' {
        return false;
    }
    parse_field_list(&trimmed[open + 1..trimmed.len() - 1]).is_some_and(|fields| !fields.is_empty())
}

/// The bare session id a bound `session=<issuer>:<id>` carries, or `None` when
/// the value names nothing: an id without its issuer, or the old `global`
/// placeholder, is not a match key against any session store.
fn raw_session_id(value: &str) -> Option<&str> {
    if value.is_empty() || value == "global" {
        return None;
    }
    let (issuer, id) = value.split_once(':')?;
    (!issuer.is_empty() && !id.is_empty()).then_some(id)
}

fn trailing_token(input: &str, end: usize) -> Option<(usize, &str)> {
    let bytes = input.as_bytes();
    let mut index = end;
    let mut quoted = false;
    while index > 0 {
        match bytes[index - 1] {
            b'"' => {
                let mut slash_start = index - 1;
                while slash_start > 0 && bytes[slash_start - 1] == b'\\' {
                    slash_start -= 1;
                }
                if (index - 1 - slash_start) % 2 == 0 {
                    quoted = !quoted;
                }
                index = slash_start;
            }
            b' ' if !quoted => break,
            _ => index -= 1,
        }
    }
    (!quoted).then(|| (index, &input[index..end]))
}

/// `allow_empty_message`: r2 lets a record carry fields and no message at all
/// (`engram.retention: pruned=3 kept=14`), so its last remaining token may be
/// consumed as a field. The older grammars keep the first token as prose
/// instead, so a message that is itself `key=value` (`status=failed`) survives
/// as the message it was written as.
fn split_message_and_fields(
    input: &str,
    decode_message: bool,
    allow_empty_message: bool,
) -> (String, HashMap<String, String>) {
    // Message prose is opaque: only consume a well-formed field suffix from the right.
    // An unmatched quote earlier in the message must not hide the entire record.
    let mut message_end = input.trim_end().len();
    let mut suffix = Vec::new();
    while message_end > 0 {
        let Some((start, token)) = trailing_token(input, message_end) else {
            break;
        };
        let Some(field) = parse_field(token) else {
            break;
        };
        if start == 0 && !allow_empty_message {
            break;
        }
        suffix.push(field);
        message_end = start;
        while message_end > 0 && input.as_bytes()[message_end - 1] == b' ' {
            message_end -= 1;
        }
    }
    let raw_message = if suffix.is_empty() {
        input
    } else {
        &input[..message_end]
    };
    let message = if decode_message {
        decode_escapes(raw_message).unwrap_or_else(|| raw_message.to_string())
    } else {
        raw_message.to_string()
    };
    let fields = suffix.into_iter().rev().collect();
    (message, fields)
}

/// r2: `<logger>: [<bound fields>] <message> <event fields>`. The bracket is
/// absent whenever a scope binds nothing, never empty.
fn parse_fleet_r2(ts: String, level: String, logger: &str, body: &str) -> Option<ParsedLogLine> {
    if !is_logger_name(logger) {
        return None;
    }
    let mut remaining = body;
    let mut bound: HashMap<String, String> = HashMap::new();
    if remaining.starts_with('[') {
        if let Some(end) = bound_bracket_end(remaining) {
            let inner = &remaining[1..end];
            if inner.trim().is_empty() {
                return None;
            }
            // A bracketed phrase that is not a field list (`[dreamer] tick fired`)
            // is message prose: only a well-formed field list is lifted as context.
            if let Some(fields) = parse_field_list(inner) {
                bound = fields.into_iter().collect();
                remaining = remaining[end + 1..].trim_start();
            }
        }
    }
    if trailing_bound_bracket(remaining) {
        return None;
    }
    let session = match bound.get("session") {
        Some(value) => Some(raw_session_id(value)?.to_string()),
        None => None,
    };
    let (message, kv) = split_message_and_fields(remaining, true, true);
    Some(ParsedLogLine {
        ts,
        level: Some(level),
        logger: logger.to_string(),
        session,
        tags: logger.split('.').skip(1).map(str::to_string).collect(),
        bound,
        message,
        kv,
        grammar: LogGrammar::FleetR2,
    })
}

/// r1: `magic-context <session=…> <tag=…>* <message> <event fields>`.
fn parse_fleet_r1(ts: String, level: String, body: &str) -> Option<ParsedLogLine> {
    let mut remaining = body;
    let mut bound: HashMap<String, String> = HashMap::new();
    let mut session = None;
    let mut tags = Vec::new();
    if remaining.starts_with("session=") {
        let tokens = tokenize(remaining, 1)?;
        let token = tokens.first()?.1;
        if token.contains('\u{1b}') {
            return None;
        }
        let (_, value) = parse_field(token)?;
        session = Some(raw_session_id(&value)?.to_string());
        // r1 has no bracket; `session=` in the column before the message is the
        // one binding it expresses, so consumers read it from the same place.
        bound.insert("session".to_string(), value);
        remaining = remaining[token.len()..].trim_start();
    }
    while remaining.starts_with("tag=") {
        let tokens = tokenize(remaining, 1)?;
        let token = tokens.first()?.1;
        if token.contains('\u{1b}') {
            return None;
        }
        let (_, tag) = parse_field(token)?;
        if tag.is_empty() {
            return None;
        }
        tags.push(tag);
        remaining = remaining[token.len()..].trim_start();
    }
    let (message, kv) = split_message_and_fields(remaining, true, false);
    Some(ParsedLogLine {
        ts,
        level: Some(level),
        logger: MODULE_ID.to_string(),
        session,
        tags,
        bound,
        message,
        kv,
        grammar: LogGrammar::FleetR1,
    })
}

pub fn parse_log_record(line: &str) -> Option<ParsedLogLine> {
    if let Some(caps) = FLEET_ENVELOPE_RE.captures(line) {
        let ts = caps.get(1)?.as_str().to_string();
        chrono::DateTime::parse_from_rfc3339(&ts).ok()?;
        let level = caps.get(2)?.as_str().trim().to_string();
        let body = caps.get(3)?.as_str();
        // One envelope, two fleet grammars: r2 terminates its logger with a
        // colon and r1 puts the bare module id in the same column, so the colon
        // is the whole discriminator. Without it the name reads as the first
        // word of the message, which is why r2 requires it.
        let (head, remaining) = match body.find(' ') {
            Some(index) => (&body[..index], body[index + 1..].trim_start()),
            None => (body, ""),
        };
        if let Some(logger) = head.strip_suffix(':') {
            return parse_fleet_r2(ts, level, logger, remaining);
        }
        if head == MODULE_ID {
            return parse_fleet_r1(ts, level, remaining);
        }
        return None;
    }
    let caps = LEGACY_LOG_LINE_RE.captures(line)?;
    let ts = caps.get(1)?.as_str().to_string();
    chrono::DateTime::parse_from_rfc3339(&ts).ok()?;
    let raw_session = caps.get(2)?.as_str().trim();
    if raw_session.contains('\u{1b}') {
        return None;
    }
    let session = if raw_session.is_empty() || raw_session == "global" {
        None
    } else {
        Some(raw_session.to_string())
    };
    let (message, kv) = split_message_and_fields(caps.get(3)?.as_str(), false, false);
    Some(ParsedLogLine {
        ts,
        level: None,
        logger: MODULE_ID.to_string(),
        session,
        tags: Vec::new(),
        // The legacy session sits in a fixed bracket slot rather than in a field
        // list, so there is nothing to lift as bound context.
        bound: HashMap::new(),
        message,
        kv,
        grammar: LogGrammar::Legacy,
    })
}

/// Levels in ascending order; a record is emitted when its level is at or above
/// the threshold that applies to its logger.
const LEVELS: [&str; 5] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
/// No level clears this threshold, which is what `off` means.
const LEVEL_OFF: usize = usize::MAX;
/// The default when no directive applies and when a spec does not parse: info.
const LEVEL_DEFAULT: usize = 2;

fn level_rank(level: &str) -> Option<usize> {
    LEVELS
        .iter()
        .position(|name| name.eq_ignore_ascii_case(level.trim()))
}

fn level_threshold(token: &str) -> Option<usize> {
    if token.trim().eq_ignore_ascii_case("off") {
        return Some(LEVEL_OFF);
    }
    level_rank(token)
}

fn is_logger_prefix(prefix: &str, logger: &str) -> bool {
    logger == prefix
        || (logger.len() > prefix.len()
            && logger.starts_with(prefix)
            && logger.as_bytes()[prefix.len()] == b'.')
}

/// Parse a CK_LOG spec: comma-separated directives, each either a bare level
/// (the root default) or `<logger>=<level>`. A spec that does not parse falls
/// back to the default, info — a logging knob with a typo in it must not
/// silence the fleet.
fn parse_log_level_spec(spec: &str) -> (usize, Vec<(String, usize)>) {
    let fallback = (LEVEL_DEFAULT, Vec::new());
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return fallback;
    }
    let mut root = LEVEL_DEFAULT;
    let mut directives = Vec::new();
    for raw in trimmed.split(',') {
        let directive = raw.trim();
        if directive.is_empty() {
            return fallback;
        }
        match directive.split_once('=') {
            None => match level_threshold(directive) {
                Some(threshold) => root = threshold,
                None => return fallback,
            },
            Some((name, level)) => {
                let name = name.trim();
                match (is_logger_name(name), level_threshold(level)) {
                    (true, Some(threshold)) => directives.push((name.to_string(), threshold)),
                    _ => return fallback,
                }
            }
        }
    }
    (root, directives)
}

/// Would a record at (`level`, `logger`) be emitted under this CK_LOG spec?
///
/// A directive names a logger prefix and applies to it and every name beneath
/// it; the most specific matching directive decides. The prefix is matched on
/// dotted segments, not on characters, so `aft` covers `aft.index` but not
/// `aftershock`.
///
/// This reads the same grammar the writers filter on, so a reader can tell
/// which lines a given CK_LOG would have kept out of a file it is looking at.
pub fn log_spec_admits(spec: &str, level: &str, logger: &str) -> bool {
    let Some(rank) = level_rank(level) else {
        return false;
    };
    let (root, directives) = parse_log_level_spec(spec);
    let mut threshold = root;
    let mut matched_depth = 0;
    for (name, directive_threshold) in &directives {
        if !is_logger_prefix(name, logger) {
            continue;
        }
        let depth = name.split('.').count();
        if depth >= matched_depth {
            matched_depth = depth;
            threshold = *directive_threshold;
        }
    }
    rank >= threshold
}

pub fn parse_log_line(line: &str) -> Option<LogEntry> {
    let record = parse_log_record(line)?;
    // `component` stays a message heuristic and keeps its established
    // vocabulary (event/transform/dreamer/…) because the log page filters and
    // colours on those exact values. An r2 line also names its component in
    // `logger`, which is reported beside it rather than in place of it.
    let component = if record.message.starts_with("event ") {
        "event"
    } else if record.message.starts_with("transform") {
        "transform"
    } else if record.message.starts_with("[dreamer]") || record.message.contains("dreamer") {
        "dreamer"
    } else if record.message.contains("historian") || record.message.contains("compartment") {
        "historian"
    } else if record.message.contains("note-nudge") || record.message.contains("note nudge") {
        // Checked before the generic "nudge" match, which would otherwise
        // claim every note-nudge line too.
        "note-nudge"
    } else if record.message.contains("nudge") {
        "nudge"
    } else {
        "general"
    }
    .to_string();

    let cache_read = record
        .kv
        .get("cache.read")
        .and_then(|value| value.parse().ok());
    let cache_write = record
        .kv
        .get("cache.write")
        .and_then(|value| value.parse().ok());
    let hit_ratio = match (cache_read, cache_write) {
        (Some(read), Some(write)) => {
            let total = read + write;
            Some(if total > 0 {
                read as f64 / total as f64
            } else {
                0.0
            })
        }
        _ => None,
    };

    Some(LogEntry {
        timestamp: record.ts,
        level: record.level,
        component,
        logger: record.logger,
        session_id: record.session.unwrap_or_default(),
        tags: record.tags,
        bound: record.bound,
        message: record.message,
        kv: record.kv,
        raw: line.to_string(),
        cache_read,
        cache_write,
        hit_ratio,
    })
}

pub fn extract_cache_events(entries: &[LogEntry]) -> Vec<CacheEvent> {
    let mut events = Vec::new();
    let mut last: Option<(&str, i64, i64, i64)> = None;

    for (i, entry) in entries.iter().enumerate() {
        if let (Some(read), Some(write)) = (entry.cache_read, entry.cache_write) {
            let input_tokens = entry
                .kv
                .get("tokens.input")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);

            // Deduplicate consecutive identical events (message.updated fires twice)
            let key = (entry.session_id.as_str(), read, write, input_tokens);
            if last == Some(key) {
                continue;
            }
            last = Some(key);

            // Total prompt tokens = uncached input + cache read + cache write
            let total_prompt = input_tokens + read + write;
            if total_prompt == 0 {
                continue;
            }

            // Real cache hit rate: what fraction of prompt was served from cache
            let ratio = read as f64 / total_prompt as f64;

            // Determine severity and cause based on real hit ratio
            let (severity, cause) = if read == 0 && write > 0 {
                let cause = detect_bust_cause(entries, i);
                // First message and provider eviction are not real busts
                let sev = if cause.starts_with("First message") {
                    "info"
                } else if cause.starts_with("Provider-side") {
                    "warning"
                } else {
                    "full_bust"
                };
                (sev.to_string(), Some(cause))
            } else if ratio < 0.5 {
                let cause = detect_bust_cause(entries, i);
                ("bust".to_string(), Some(cause))
            } else if ratio < 0.9 {
                ("warning".to_string(), None)
            } else {
                ("stable".to_string(), None)
            };

            events.push(CacheEvent {
                timestamp: entry.timestamp.clone(),
                session_id: entry.session_id.clone(),
                cache_read: read,
                cache_write: write,
                input_tokens,
                hit_ratio: ratio,
                cause,
                severity,
            });
        }
    }

    events
}

/// Aggregate cache events into per-session stats, sorted by last activity (most recent first).
pub fn aggregate_session_cache_stats(
    events: &[CacheEvent],
    limit: usize,
) -> Vec<SessionCacheStats> {
    use std::collections::HashMap;

    struct Accum {
        event_count: usize,
        total_read: i64,
        total_write: i64,
        total_input: i64,
        last_timestamp: String,
        bust_count: usize,
    }

    let mut map: HashMap<String, Accum> = HashMap::new();

    for event in events {
        if event.session_id.is_empty() {
            continue;
        }
        let entry = map.entry(event.session_id.clone()).or_insert(Accum {
            event_count: 0,
            total_read: 0,
            total_write: 0,
            total_input: 0,
            last_timestamp: String::new(),
            bust_count: 0,
        });
        entry.event_count += 1;
        entry.total_read += event.cache_read;
        entry.total_write += event.cache_write;
        entry.total_input += event.input_tokens;
        entry.last_timestamp = event.timestamp.clone();
        if event.severity == "bust" || event.severity == "full_bust" {
            entry.bust_count += 1;
        }
    }

    let mut stats: Vec<SessionCacheStats> = map
        .into_iter()
        .map(|(session_id, acc)| {
            let total_prompt = acc.total_read + acc.total_write + acc.total_input;
            let hit_ratio = if total_prompt > 0 {
                acc.total_read as f64 / total_prompt as f64
            } else {
                0.0
            };
            SessionCacheStats {
                session_id,
                event_count: acc.event_count,
                total_cache_read: acc.total_read,
                total_cache_write: acc.total_write,
                total_input: acc.total_input,
                hit_ratio,
                last_timestamp: acc.last_timestamp,
                bust_count: acc.bust_count,
            }
        })
        .collect();

    // Sort by last_timestamp descending (most recent first)
    stats.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    stats.truncate(limit);
    stats
}

fn detect_bust_cause(entries: &[LogEntry], event_idx: usize) -> String {
    let event = &entries[event_idx];

    // Look at surrounding log entries for context
    let window_start = event_idx.saturating_sub(10);
    let window_end = std::cmp::min(event_idx + 3, entries.len());

    let mut causes = Vec::new();

    // Check if this is the first cache event for this session
    let is_first_session_event = !entries[..event_idx].iter().any(|e| {
        e.session_id == event.session_id
            && e.cache_read.is_some()
            && (e.cache_read.unwrap_or(0) > 0 || e.cache_write.unwrap_or(0) > 0)
    });

    if is_first_session_event {
        return "First message (new session)".to_string();
    }

    // Check if the transform was a defer pass (no plugin-side mutations)
    let is_defer_pass = entries[window_start..window_end]
        .iter()
        .any(|e| e.session_id == event.session_id && e.message.contains("decision=defer"));

    // If cache.read=0 on a defer pass, it's provider-side eviction
    if is_defer_pass && event.cache_read == Some(0) && event.cache_write.unwrap_or(0) > 0 {
        let has_plugin_mutation = entries[window_start..window_end].iter().any(|e| {
            e.session_id == event.session_id
                && (e.message.contains("Execute pass")
                    || e.message.contains("triggering flush")
                    || e.message.contains("system prompt hash changed")
                    || e.message.contains("variant change"))
        });
        if !has_plugin_mutation {
            return "Provider-side cache eviction".to_string();
        }
    }

    for entry in &entries[window_start..window_end] {
        if entry.session_id != event.session_id {
            continue;
        }
        let msg = &entry.message;
        if msg.contains("Execute pass") || (msg.contains("applied") && msg.contains("ops")) {
            causes.push("Execute pass".to_string());
        }
        if msg.contains("compartments") && msg.contains("→") {
            causes.push("Historian output".to_string());
        }
        if msg.contains("variant change") || msg.contains("Variant change") {
            causes.push("Variant change".to_string());
        }
        if msg.contains("system prompt hash") {
            causes.push("System prompt hash change".to_string());
        }
        if msg.contains("restart")
            || msg.contains("Restart")
            || msg.contains("injection cache cleared")
        {
            causes.push("App restart".to_string());
        }
        if msg.contains("note nudge") && msg.contains("deliver") {
            causes.push("Note nudge delivered".to_string());
        }
        if msg.contains("heuristic cleanup") || msg.contains("tool tags dropped") {
            causes.push("Heuristic cleanup".to_string());
        }
    }

    if causes.is_empty() {
        "Unknown cause".to_string()
    } else {
        // Several lines in the window can name the same cause, not always next
        // to each other; keep the first mention of each.
        let mut seen = std::collections::HashSet::new();
        causes.retain(|cause| seen.insert(cause.clone()));
        causes.join(", ")
    }
}

#[derive(Clone, PartialEq, Eq)]
struct LogFileStamp {
    identity: (u64, u64),
    len: u64,
    modified: SystemTime,
}

impl LogFileStamp {
    fn from_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        // Without a reliable file identity, do not risk serving a rotated file's
        // old contents merely because its size and timestamp happen to match.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                identity: (metadata.dev(), metadata.ino()),
                len: metadata.len(),
                modified: metadata.modified().ok()?,
            })
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            None
        }
    }
}

struct CachedLogTail {
    stamp: LogFileStamp,
    max_lines: usize,
    entries: Vec<LogEntry>,
    accessed: u64,
}

#[derive(Default)]
struct LogTailWork {
    #[cfg(test)]
    reads: u64,
    #[cfg(test)]
    parses: u64,
    #[cfg(test)]
    bytes: u64,
}

#[derive(Default)]
struct LogTailCache {
    files: HashMap<PathBuf, CachedLogTail>,
    clock: u64,
    work: LogTailWork,
}

impl LogTailCache {
    fn read(&mut self, path: &PathBuf, max_lines: usize) -> Vec<LogEntry> {
        self.clock += 1;
        let stamp = std::fs::metadata(path)
            .ok()
            .and_then(|metadata| LogFileStamp::from_metadata(&metadata));
        if let (Some(stamp), Some(cached)) = (&stamp, self.files.get_mut(path)) {
            if cached.stamp == *stamp && cached.max_lines == max_lines {
                cached.accessed = self.clock;
                return cached.entries.clone();
            }
        }
        self.files.remove(path);
        let Ok((entries, read_stamp)) = read_log_tail_uncached(path, max_lines, &mut self.work)
        else {
            return Vec::new();
        };
        // A writer can append/truncate/rotate while we read. Return this pass,
        // but only memoize a complete read of an unchanged file at this path.
        let after = std::fs::metadata(path)
            .ok()
            .and_then(|metadata| LogFileStamp::from_metadata(&metadata));
        if let Some(stamp) = read_stamp.filter(|value| Some(value) == after.as_ref()) {
            // Discovery normally yields ten paths. Bound retention even when
            // callers change overrides or ask for different sources over time.
            if self.files.len() >= 16 {
                if let Some(oldest) = self
                    .files
                    .iter()
                    .min_by_key(|(_, tail)| tail.accessed)
                    .map(|(path, _)| path.clone())
                {
                    self.files.remove(&oldest);
                }
            }
            self.files.insert(
                path.clone(),
                CachedLogTail {
                    stamp,
                    max_lines,
                    entries: entries.clone(),
                    accessed: self.clock,
                },
            );
        }
        entries
    }
}

/// Read the last N lines, reusing parsed tails only while file identity, length
/// and mtime are unchanged. A single latch also prevents concurrent IPC reads
/// from parsing the same unchanged tail twice.
pub fn read_log_tail(path: &PathBuf, max_lines: usize) -> Vec<LogEntry> {
    static CACHE: OnceLock<Mutex<LogTailCache>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(LogTailCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .read(path, max_lines)
}

/// Seek from the end rather than loading the entire log into memory.
fn read_log_tail_uncached(
    path: &PathBuf,
    max_lines: usize,
    work: &mut LogTailWork,
) -> std::io::Result<(Vec<LogEntry>, Option<LogFileStamp>)> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let stamp = LogFileStamp::from_metadata(&file.metadata()?);
    let file_len = file.seek(SeekFrom::End(0))?;

    if file_len == 0 {
        return Ok((Vec::new(), stamp));
    }

    // Read backwards in 64KB chunks until we have enough newlines
    let chunk_size: u64 = 65536;
    let mut tail_bytes = Vec::new();
    let mut newline_count = 0;
    let mut pos = file_len;

    while pos > 0 && newline_count <= max_lines {
        let read_size = std::cmp::min(chunk_size, pos);
        pos -= read_size;
        file.seek(SeekFrom::Start(pos))?;
        let mut buf = vec![0u8; read_size as usize];
        file.read_exact(&mut buf)?;
        #[cfg(test)]
        {
            work.reads += 1;
            work.bytes += read_size;
        }
        // Count newlines in this chunk
        newline_count += buf.iter().filter(|&&b| b == b'\n').count();
        // Prepend chunk
        buf.append(&mut tail_bytes);
        tail_bytes = buf;
    }

    let text = String::from_utf8_lossy(&tail_bytes);
    let lines: Vec<&str> = text.lines().collect();

    // Take only the last max_lines
    let start = if lines.len() > max_lines {
        lines.len() - max_lines
    } else {
        0
    };

    #[cfg(not(test))]
    let _ = work;
    #[cfg(test)]
    {
        work.parses += (lines.len() - start) as u64;
    }
    let entries = lines[start..]
        .iter()
        .filter_map(|line| parse_log_line(line))
        .collect();
    Ok((entries, stamp))
}

/// Read recent entries from every harness log, retaining the newest entries
/// across the combined stream. Plugin timestamps are ISO-8601 strings, so their
/// lexical order is chronological.
pub fn read_log_tails(paths: &[PathBuf], max_lines: usize) -> Vec<LogEntry> {
    let mut entries: Vec<LogEntry> = paths
        .iter()
        .flat_map(|path| read_log_tail(path, max_lines))
        .collect();
    entries.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));

    let first_to_keep = entries.len().saturating_sub(max_lines);
    entries.drain(0..first_to_keep);
    entries
}

#[cfg(test)]
mod tests {
    use super::{
        detect_bust_cause, extract_cache_events, log_spec_admits, parse_log_line, parse_log_record,
        read_log_tail, read_log_tail_uncached, read_log_tails, resolve_log_path_for,
        resolve_log_path_from_temp_dir, resolve_log_paths, Harness, LogEntry, LogGrammar,
        LogTailCache, LogTailWork, Regex,
    };
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn golden_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../cli/src/lib/__fixtures__/log_format_golden.json"
        ))
        .unwrap()
    }

    fn pairs(value: &serde_json::Value) -> HashMap<String, String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap().to_string(),
                    pair[1].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    // One event, written by the three producers a developer box can still have
    // on disk. Each line is the shape of exactly one grammar, and the reader
    // must not read any of them as another.
    const R2_LINE: &str = "2026-09-05T10:41:03.130Z WARN  magic-context.perf: [harness=opencode session=opencode:ses_00fc88222ffe] transform stage folded ms=412 retry=2";
    const R1_LINE: &str = "2026-09-05T10:41:03.130Z WARN  magic-context session=opencode:ses_00fc88222ffe tag=perf transform stage folded ms=412 retry=2";
    const LEGACY_LINE: &str = "[2026-09-05T10:41:03.130Z] [magic-context][ses_00fc88222ffe] transform stage folded ms=412 retry=2";

    /// The writer removes complete CSI escape sequences (7-bit `ESC [` or the C1
    /// byte U+009B, then parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F
    /// and one final byte 0x40-0x7E) before rendering, so a reader can never
    /// recover them. The fixture's `event` still holds the colored input; the
    /// expected record is the event with those sequences removed. A lone ESC and
    /// other control characters are escaped, not removed, and round-trip.
    fn strip_complete_csi(value: &str) -> String {
        let chars: Vec<char> = value.chars().collect();
        let mut out = String::with_capacity(value.len());
        let mut i = 0;
        while i < chars.len() {
            let start = if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&'[') {
                Some(i + 2)
            } else if chars[i] == '\u{9b}' {
                Some(i + 1)
            } else {
                None
            };
            if let Some(mut j) = start {
                while j < chars.len() && ('\u{30}'..='\u{3f}').contains(&chars[j]) {
                    j += 1;
                }
                while j < chars.len() && ('\u{20}'..='\u{2f}').contains(&chars[j]) {
                    j += 1;
                }
                if j < chars.len() && ('\u{40}'..='\u{7e}').contains(&chars[j]) {
                    i = j + 1;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }

    #[test]
    fn reads_every_render_case_of_the_authority_fleet_r2_fixture() {
        let fixture = golden_fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let event = &case["event"];
            let logger = event["logger"].as_str().unwrap();
            let bound = pairs(&event["bound"]);
            // The reader hands consumers the bare id: `session=` carries the
            // issuer so the id can be matched against a session store, and the
            // pickers that filter on it show the id alone.
            let session = bound
                .get("session")
                .map(|value| value.split_once(':').unwrap().1.to_string());

            let record = parse_log_record(case["line"].as_str().unwrap())
                .unwrap_or_else(|| panic!("{name} did not parse"));

            assert_eq!(
                record.level.as_deref(),
                Some(event["level"].as_str().unwrap().to_uppercase().as_str()),
                "{name}"
            );
            assert_eq!(record.logger, logger, "{name}");
            assert_eq!(record.session, session, "{name}");
            assert_eq!(
                record.tags,
                logger.split('.').skip(1).collect::<Vec<_>>(),
                "{name}"
            );
            assert_eq!(record.bound, bound, "{name}");
            assert_eq!(
                record.message,
                strip_complete_csi(event["message"].as_str().unwrap()),
                "{name}"
            );
            let mut expected_kv = pairs(&event["fields"]);
            for value in expected_kv.values_mut() {
                *value = strip_complete_csi(value);
            }
            assert_eq!(record.kv, expected_kv, "{name}");
            assert_eq!(record.grammar, LogGrammar::FleetR2, "{name}");
        }
    }

    #[test]
    fn admits_or_filters_every_ck_log_case_of_the_authority_fixture() {
        let fixture = golden_fixture();
        for case in fixture["level_filter"]["cases"].as_array().unwrap() {
            let spec = case["spec"].as_str().unwrap();
            let level = case["level"].as_str().unwrap();
            let logger = case["logger"].as_str().unwrap();
            assert_eq!(
                log_spec_admits(spec, level, logger),
                case["emit"].as_bool().unwrap(),
                "{spec} @ {level} {logger}"
            );
        }
    }

    #[test]
    fn reads_the_r2_shape_as_r2_and_nothing_else() {
        let record = parse_log_record(R2_LINE).unwrap();
        assert_eq!(record.grammar, LogGrammar::FleetR2);
        assert_eq!(record.ts, "2026-09-05T10:41:03.130Z");
        assert_eq!(record.level.as_deref(), Some("WARN"));
        assert_eq!(record.logger, "magic-context.perf");
        assert_eq!(record.session.as_deref(), Some("ses_00fc88222ffe"));
        assert_eq!(record.tags, vec!["perf"]);
        assert_eq!(
            record.bound,
            HashMap::from([
                ("harness".to_string(), "opencode".to_string()),
                (
                    "session".to_string(),
                    "opencode:ses_00fc88222ffe".to_string()
                ),
            ])
        );
        assert_eq!(record.message, "transform stage folded");
    }

    #[test]
    fn reads_the_r1_shape_as_r1_and_nothing_else() {
        let record = parse_log_record(R1_LINE).unwrap();
        assert_eq!(record.grammar, LogGrammar::FleetR1);
        assert_eq!(record.level.as_deref(), Some("WARN"));
        assert_eq!(record.logger, "magic-context");
        assert_eq!(record.session.as_deref(), Some("ses_00fc88222ffe"));
        assert_eq!(record.tags, vec!["perf"]);
        assert_eq!(
            record.bound,
            HashMap::from([(
                "session".to_string(),
                "opencode:ses_00fc88222ffe".to_string()
            )])
        );
        assert_eq!(record.message, "transform stage folded");
    }

    #[test]
    fn reads_message_updated_identifiers_as_fields() {
        let record = parse_log_record("[2026-09-05T10:41:03.130Z] [magic-context][ses_538] event message.updated: provider=mock model=test hasUsageTokens=true tokens.input=10 cache.read=2 cache.write=0 message.id=msg_538 session.id=ses_538").unwrap();
        assert_eq!(record.session.as_deref(), Some("ses_538"));
        assert_eq!(record.message, "event message.updated:");
        assert_eq!(
            record.kv.get("message.id").map(String::as_str),
            Some("msg_538")
        );
        assert_eq!(
            record.kv.get("session.id").map(String::as_str),
            Some("ses_538")
        );
    }

    #[test]
    fn reads_the_legacy_shape_as_legacy_and_maps_global_to_no_session() {
        let record = parse_log_record(LEGACY_LINE).unwrap();
        assert_eq!(record.grammar, LogGrammar::Legacy);
        assert_eq!(record.level, None);
        assert_eq!(record.logger, "magic-context");
        assert_eq!(record.session.as_deref(), Some("ses_00fc88222ffe"));
        assert!(record.tags.is_empty());
        assert!(record.bound.is_empty());
        assert_eq!(record.message, "transform stage folded");

        let global = parse_log_record(
            "[2026-09-05T10:41:04.130Z] [magic-context][global] transform complete cache.read=7 cache.write=2",
        )
        .unwrap();
        assert_eq!(global.session, None);
        assert_eq!(global.message, "transform complete");
        assert_eq!(global.kv.get("cache.read").map(String::as_str), Some("7"));
    }

    #[test]
    fn maps_one_event_written_in_all_three_grammars_onto_one_record_shape() {
        let records: Vec<_> = [R2_LINE, R1_LINE, LEGACY_LINE]
            .iter()
            .map(|line| parse_log_record(line).unwrap())
            .collect();
        assert_eq!(
            records
                .iter()
                .map(|record| record.grammar)
                .collect::<Vec<_>>(),
            vec![LogGrammar::FleetR2, LogGrammar::FleetR1, LogGrammar::Legacy]
        );
        let fields = HashMap::from([
            ("ms".to_string(), "412".to_string()),
            ("retry".to_string(), "2".to_string()),
        ]);
        for record in &records {
            assert_eq!(record.session.as_deref(), Some("ses_00fc88222ffe"));
            assert_eq!(record.message, "transform stage folded");
            assert_eq!(record.kv, fields);
        }
        // What r1 wrote as `tag=perf` is r2's logger component; the legacy
        // grammar had no way to express it at all.
        assert_eq!(
            records
                .iter()
                .map(|record| record.tags.clone())
                .collect::<Vec<_>>(),
            vec![vec!["perf".to_string()], vec!["perf".to_string()], vec![]]
        );
    }

    #[test]
    fn writer_side_fixture_sections_are_read_and_drive_no_reader() {
        // `segment_name` and `retention_prune` pin the WRITER: which file a
        // module opens for today's UTC day and which old segments it unlinks by
        // filename. magic-context still writes one `magic-context.log` rotated
        // to `.1` (packages/plugin/src/shared/logger.ts) and this reader
        // resolves no daemon log, so nothing here opens or prunes a dated
        // segment. Read the two sections anyway: when the writer does move,
        // this is the assertion that fails and asks for a dated-segment
        // resolver.
        let fixture = golden_fixture();
        assert!(!fixture["segment_name"]["cases"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(!fixture["retention_prune"]["cases"]
            .as_array()
            .unwrap()
            .is_empty());

        let dated = Regex::new(r"\.\d{4}-\d{2}-\d{2}\.log$").unwrap();
        let mut env = crate::test_env::EnvGuard::new();
        env.remove("MAGIC_CONTEXT_LOG_PATH");
        for path in resolve_log_paths() {
            assert!(!dated.is_match(&path.to_string_lossy()), "{path:?}");
        }
    }

    #[test]
    fn retains_opaque_bodies_without_field_or_escape_grammar() {
        for body in [
            "",
            "invalid \"",
            "invalid \"  ",
            r"invalid \q",
            "status=failed",
            "failure \u{1b}[31m",
        ] {
            for envelope in [
                "[2026-09-05T10:41:03.130Z] [magic-context][ses_opaque] ",
                "2026-09-05T10:41:03.130Z ERROR magic-context ",
            ] {
                assert_eq!(
                    parse_log_record(&format!("{envelope}{body}"))
                        .unwrap()
                        .message,
                    body
                );
            }
        }
    }

    #[test]
    fn log_tail_retains_opaque_messages_and_trailing_fields() {
        // The CLI test verifies these legacy fixture bytes against the real writer.
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../cli/src/lib/__fixtures__/opaque-log-messages.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let file = tempfile::NamedTempFile::new().unwrap();
            let line = fixture["line"].as_str().unwrap();
            std::fs::write(file.path(), format!("{line}\n")).unwrap();
            let entries = read_log_tail(&file.path().to_path_buf(), 10);
            assert_eq!(entries.len(), 1, "{}", fixture["name"]);
            assert_eq!(entries[0].raw, line);
            assert_eq!(entries[0].message, fixture["message"].as_str().unwrap());
            let expected = fixture["name"]
                .as_str()
                .unwrap()
                .ends_with("before-fields")
                .then_some(5);
            assert_eq!(entries[0].cache_read, expected);
        }
    }

    #[test]
    fn fleet_fields_feed_existing_cache_telemetry() {
        // The cache page keys on the event fields and the session id, so both
        // fleet grammars have to arrive at the same entry.
        for line in [
            "2026-09-05T10:41:03.130Z INFO  magic-context session=opencode:ses_cache cache event cache.read=70 cache.write=20 tokens.input=10",
            "2026-09-05T10:41:03.130Z INFO  magic-context.transform: [session=opencode:ses_cache] cache event cache.read=70 cache.write=20 tokens.input=10",
        ] {
            let entry = parse_log_line(line).unwrap();
            assert_eq!(entry.message, "cache event");
            assert_eq!(entry.session_id, "ses_cache");
            assert_eq!(entry.cache_read, Some(70));
            assert_eq!(entry.cache_write, Some(20));
            let events = extract_cache_events(&[entry]);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].input_tokens, 10);
            assert_eq!(events[0].hit_ratio, 0.7);
        }
    }

    #[test]
    fn note_nudge_lines_get_their_own_component() {
        let line = "2026-09-05T10:41:03.130Z INFO  magic-context session=opencode:ses_n note nudge delivered";
        assert_eq!(parse_log_line(line).unwrap().component, "note-nudge");
        let line = "2026-09-05T10:41:03.130Z INFO  magic-context session=opencode:ses_n nudge sent";
        assert_eq!(parse_log_line(line).unwrap().component, "nudge");
    }

    #[test]
    fn bust_causes_name_each_cause_once_even_when_not_adjacent() {
        let entries: Vec<LogEntry> = [
            "2026-09-05T10:41:01.000Z INFO  magic-context session=opencode:ses_b cache event cache.read=70 cache.write=20 tokens.input=10",
            "2026-09-05T10:41:02.000Z INFO  magic-context session=opencode:ses_b Execute pass started",
            "2026-09-05T10:41:02.100Z INFO  magic-context session=opencode:ses_b heuristic cleanup ran",
            "2026-09-05T10:41:02.200Z INFO  magic-context session=opencode:ses_b Execute pass finished",
            "2026-09-05T10:41:03.000Z INFO  magic-context session=opencode:ses_b cache event cache.read=0 cache.write=90 tokens.input=10",
        ]
        .iter()
        .map(|line| parse_log_line(line).unwrap())
        .collect();
        assert_eq!(
            detect_bust_cause(&entries, 4),
            "Execute pass, Heuristic cleanup"
        );
    }

    #[test]
    fn rejects_wrong_grammar_without_silently_splitting() {
        assert!(parse_log_record(
            "2026-09-05T10:41:03.130Z WARN magic-context session=opencode:ses_bad transform failed: boom"
        )
        .is_none());
        let fixture = golden_fixture();
        for case in fixture["parse_rejects"].as_array().unwrap() {
            assert!(
                parse_log_record(case["line"].as_str().unwrap()).is_none(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn resolve_log_path_for_uses_harness_fallback_when_env_unset() {
        let mut env = crate::test_env::EnvGuard::new();
        env.remove("MAGIC_CONTEXT_LOG_PATH");

        assert_eq!(
            resolve_log_path_for(Harness::Opencode),
            std::env::temp_dir()
                .join("opencode")
                .join("magic-context")
                .join("magic-context.log")
        );
        assert_eq!(
            resolve_log_path_for(Harness::Pi),
            std::env::temp_dir()
                .join("pi")
                .join("magic-context")
                .join("magic-context.log")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_log_paths_preserve_tmpdir_and_harness_subdirectories() {
        let tmpdir = Path::new("/var/folders/example/T");

        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Opencode),
            tmpdir.join("opencode/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Pi),
            tmpdir.join("pi/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Omp),
            tmpdir.join("omp/magic-context/magic-context.log")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_log_paths_preserve_temp_and_harness_subdirectories() {
        let tmpdir = Path::new(r"C:\Users\example\AppData\Local\Temp");

        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Opencode),
            tmpdir.join("opencode/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Pi),
            tmpdir.join("pi/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Omp),
            tmpdir.join("omp/magic-context/magic-context.log")
        );
    }

    #[test]
    fn resolve_log_paths_reads_all_harnesses_when_no_override_is_set() {
        let mut env = crate::test_env::EnvGuard::new();
        env.remove("MAGIC_CONTEXT_LOG_PATH");

        let paths = resolve_log_paths();
        for harness in [
            Harness::Opencode,
            Harness::Opencode2,
            Harness::Pi,
            Harness::Omp,
        ] {
            assert!(paths.contains(&resolve_log_path_for(harness)));
        }
        assert!(paths
            .iter()
            .any(|path| path.ends_with("opencode2/magic-context/magic-context.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.opencode2.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.opencode.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.pi.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.omp.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.log")));
    }

    #[test]
    fn resolve_log_paths_keeps_standard_families_with_a_shared_override() {
        let mut env = crate::test_env::EnvGuard::new();
        let custom = std::env::temp_dir()
            .join("custom")
            .join("magic-context.log");
        env.set(
            "MAGIC_CONTEXT_LOG_PATH",
            custom.to_string_lossy().to_string(),
        );

        let paths = resolve_log_paths();
        assert_eq!(paths.first(), Some(&custom));
        assert_eq!(paths.iter().filter(|path| *path == &custom).count(), 1);
        assert!(paths.contains(&resolve_log_path_from_temp_dir(
            &std::env::temp_dir(),
            Harness::Omp
        )));

        env.remove("MAGIC_CONTEXT_LOG_PATH");
    }

    #[test]
    fn read_log_tails_combines_harness_logs_in_timestamp_order() {
        let dir = tempfile::tempdir().unwrap();
        let opencode = dir.path().join("opencode.log");
        let pi = dir.path().join("pi.log");
        std::fs::write(
            &opencode,
            "[2026-01-01T00:00:00.000Z] [magic-context][opencode-session] OpenCode entry\n",
        )
        .unwrap();
        std::fs::write(
            &pi,
            "[2026-01-01T00:00:01.000Z] [magic-context][pi-session] Pi entry\n",
        )
        .unwrap();

        let entries = read_log_tails(&[opencode, pi], 10);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].session_id, "opencode-session");
        assert_eq!(entries[1].session_id, "pi-session");
    }

    #[cfg(unix)]
    #[test]
    fn unchanged_log_tails_measure_reads_and_parses_per_minute() {
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..10)
            .map(|source| {
                let path = directory.path().join(format!("{source}.log"));
                let text: String = (0..500)
                    .map(|line| {
                        format!(
                "[2026-01-01T00:00:00.000Z] [magic-context][source-{source}] line {line} {}\n",
                "x".repeat(160),
            )
                    })
                    .collect();
                std::fs::write(&path, text).unwrap();
                path
            })
            .collect();
        let mut before = LogTailWork::default();
        let mut after = LogTailCache::default();
        for _ in 0..20 {
            for path in &paths {
                let (expected, _) = read_log_tail_uncached(path, 500, &mut before).unwrap();
                let actual = after.read(path, 500);
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
            }
        }
        assert_eq!(before.reads, 400);
        assert_eq!(before.parses, 100_000);
        assert_eq!(after.work.reads, 20);
        assert_eq!(after.work.parses, 5_000);
        assert_eq!(before.bytes, after.work.bytes * 20);
        println!("Log work/minute, 10 unchanged 500-line files, 20 polls: before reads={} parses={} bytes={}; after reads={} parses={} bytes={}",
            before.reads, before.parses, before.bytes, after.work.reads, after.work.parses, after.work.bytes);
    }

    #[cfg(unix)]
    #[test]
    fn cached_log_tail_invalidates_on_rewrite_rotation_truncation_and_removal() {
        use std::fs::{File, FileTimes};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("current.log");
        let line =
            |message: &str| format!("[2026-01-01T00:00:00.000Z] [magic-context][s] {message}\n");
        std::fs::write(&path, line("first")).unwrap();
        let mut cache = LogTailCache::default();
        assert_eq!(cache.read(&path, 10)[0].message, "first");
        let original_time = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, line("other")).unwrap(); // Same size, new mtime.
        File::open(&path)
            .unwrap()
            .set_times(
                FileTimes::new().set_modified(original_time + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        assert_eq!(cache.read(&path, 10)[0].message, "other");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::rename(&path, directory.path().join("rotated.log")).unwrap();
        std::fs::write(&path, line("third")).unwrap(); // Same size AND mtime; inode must invalidate.
        File::open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(cache.read(&path, 10)[0].message, "third");
        std::fs::write(&path, "").unwrap();
        assert!(cache.read(&path, 10).is_empty());
        std::fs::write(&path, format!("{}{}", line("again"), line("newer"))).unwrap();
        assert_eq!(cache.read(&path, 1)[0].message, "newer");
        assert_eq!(cache.read(&path, 2).len(), 2); // A different limit must not reuse a shorter tail.
        std::fs::remove_file(&path).unwrap();
        assert!(cache.read(&path, 2).is_empty());
        std::fs::write(&path, line("fresh")).unwrap();
        assert_eq!(cache.read(&path, 2)[0].message, "fresh");
    }

    #[test]
    fn merged_cached_tails_keep_stable_ties_and_newest_limit() {
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<_> = ["a", "b", "c"].iter().map(|source| {
            let path = directory.path().join(source);
            std::fs::write(&path, format!(
                "[2026-01-01T00:00:00.000Z] [magic-context][{source}] old\n[2026-01-01T00:00:01.000Z] [magic-context][{source}] tied\n"
            )).unwrap();
            path
        }).collect();
        for _ in 0..2 {
            let actual: Vec<_> = read_log_tails(&paths, 4)
                .iter()
                .map(|entry| (entry.session_id.clone(), entry.message.clone()))
                .collect();
            assert_eq!(
                actual,
                [("c", "old"), ("a", "tied"), ("b", "tied"), ("c", "tied")]
                    .map(|(source, message)| (source.to_string(), message.to_string()))
            );
        }
        std::fs::write(
            &paths[1],
            "[2026-01-01T00:00:02.000Z] [magic-context][b] rotated\n",
        )
        .unwrap();
        let actual: Vec<_> = read_log_tails(&paths, 3)
            .iter()
            .map(|entry| (entry.session_id.clone(), entry.message.clone()))
            .collect();
        assert_eq!(
            actual,
            [("a", "tied"), ("c", "tied"), ("b", "rotated")]
                .map(|(source, message)| (source.to_string(), message.to_string()))
        );
    }

    #[test]
    fn resolve_log_path_for_honors_magic_context_log_path_override() {
        let mut env = crate::test_env::EnvGuard::new();
        let custom = std::env::temp_dir()
            .join("custom")
            .join("magic-context.log");
        env.set(
            "MAGIC_CONTEXT_LOG_PATH",
            custom.to_string_lossy().to_string(),
        );

        assert_eq!(
            resolve_log_path_for(Harness::Opencode),
            PathBuf::from(&custom)
        );
        assert_eq!(resolve_log_path_for(Harness::Pi), PathBuf::from(&custom));

        env.remove("MAGIC_CONTEXT_LOG_PATH");
    }

    #[test]
    fn resolve_log_path_for_ignores_blank_magic_context_log_path() {
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MAGIC_CONTEXT_LOG_PATH", "   ");

        assert_eq!(
            resolve_log_path_for(Harness::Pi),
            std::env::temp_dir()
                .join("pi")
                .join("magic-context")
                .join("magic-context.log")
        );

        env.remove("MAGIC_CONTEXT_LOG_PATH");
    }
}
