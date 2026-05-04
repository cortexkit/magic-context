use regex::Regex;
use serde::Serialize;
use std::path::PathBuf;

/// Resolves the log file path.
/// Default: /tmp/magic-context.log (same as the plugin writes to)
pub fn resolve_log_path() -> PathBuf {
    std::env::temp_dir().join("magic-context.log")
}

#[derive(Debug, Serialize, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub component: String,
    pub session_id: String,
    pub message: String,
    pub raw: String,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub hit_ratio: Option<f64>,
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
    static ref LOG_LINE_RE: Regex = Regex::new(
        r"^\[([^\]]+)\]\s+\[magic-context\]\[([^\]]*)\]\s*(.*)"
    ).unwrap();

    static ref CACHE_STATS_RE: Regex = Regex::new(
        r"cache\.read=(\d+)\s+cache\.write=(\d+)"
    ).unwrap();

    static ref INPUT_TOKENS_RE: Regex = Regex::new(
        r"tokens\.input=(\d+)"
    ).unwrap();
}

pub fn parse_log_line(line: &str) -> Option<LogEntry> {
    // Format: [timestamp] [magic-context][session_id] message
    // Also handle: [timestamp] message (no component/session)
    if let Some(caps) = LOG_LINE_RE.captures(line) {
        let timestamp = caps.get(1)?.as_str().to_string();
        let session_id = caps.get(2)?.as_str().to_string();
        let message = caps.get(3)?.as_str().to_string();

        let component = if message.starts_with("event ") {
            "event".to_string()
        } else if message.starts_with("transform") {
            "transform".to_string()
        } else if message.starts_with("[dreamer]") || message.contains("dreamer") {
            "dreamer".to_string()
        } else if message.contains("historian") || message.contains("compartment") {
            "historian".to_string()
        } else if message.contains("nudge") {
            "nudge".to_string()
        } else if message.contains("note-nudge") || message.contains("note nudge") {
            "note-nudge".to_string()
        } else {
            "general".to_string()
        };

        let (cache_read, cache_write, hit_ratio) =
            if let Some(cache_caps) = CACHE_STATS_RE.captures(&message) {
                let read: i64 = cache_caps.get(1)?.as_str().parse().ok()?;
                let write: i64 = cache_caps.get(2)?.as_str().parse().ok()?;
                let total = read + write;
                let ratio = if total > 0 {
                    read as f64 / total as f64
                } else {
                    0.0
                };
                (Some(read), Some(write), Some(ratio))
            } else {
                (None, None, None)
            };

        return Some(LogEntry {
            timestamp,
            component,
            session_id,
            message,
            raw: line.to_string(),
            cache_read,
            cache_write,
            hit_ratio,
        });
    }

    // Fallback: simple timestamp pattern
    if line.starts_with('[') {
        if let Some(end) = line.find(']') {
            let timestamp = line[1..end].to_string();
            let rest = line[end + 1..].trim().to_string();
            return Some(LogEntry {
                timestamp,
                component: "general".to_string(),
                session_id: String::new(),
                message: rest,
                raw: line.to_string(),
                cache_read: None,
                cache_write: None,
                hit_ratio: None,
            });
        }
    }

    None
}

pub fn extract_cache_events(entries: &[LogEntry]) -> Vec<CacheEvent> {
    let mut events = Vec::new();
    let mut last: Option<(&str, i64, i64, i64)> = None;

    for (i, entry) in entries.iter().enumerate() {
        if let (Some(read), Some(write)) = (entry.cache_read, entry.cache_write) {
            let input_tokens = INPUT_TOKENS_RE
                .captures(&entry.message)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<i64>().ok())
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
        causes.dedup();
        causes.join(", ")
    }
}

/// Read the last N lines from the log file using seek-from-end
/// to avoid loading the entire file into memory.
pub fn read_log_tail(path: &PathBuf, max_lines: usize) -> Vec<LogEntry> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let file_len = match file.seek(SeekFrom::End(0)) {
        Ok(len) => len,
        Err(_) => return Vec::new(),
    };

    if file_len == 0 {
        return Vec::new();
    }

    // Read backwards in 64KB chunks until we have enough newlines
    let chunk_size: u64 = 65536;
    let mut tail_bytes = Vec::new();
    let mut newline_count = 0;
    let mut pos = file_len;

    while pos > 0 && newline_count <= max_lines {
        let read_size = std::cmp::min(chunk_size, pos);
        pos -= read_size;
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut buf = vec![0u8; read_size as usize];
        if file.read_exact(&mut buf).is_err() {
            break;
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

    lines[start..]
        .iter()
        .filter_map(|line| parse_log_line(line))
        .collect()
}
