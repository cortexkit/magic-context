use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct PiSessionMeta {
    pub session_id: String,
    pub jsonl_path: PathBuf,
    pub cwd: String,
    pub created: i64,
    pub modified: i64,
    pub message_count: u32,
    pub first_message: String,
    pub session_name: Option<String>,
    pub parent_session_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiSessionDetail {
    pub meta: PiSessionMeta,
    pub messages: Vec<PiMessage>,
    pub compaction_entries: Vec<PiCompactionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiMessage {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub timestamp_ms: i64,
    pub role: String,
    pub text_preview: String,
    pub usage: Option<PiUsage>,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiUsage {
    pub input: u32,
    pub output: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiCompactionEntry {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub timestamp_ms: i64,
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u32,
    pub from_hook: bool,
    pub raw_json: Value,
}

type MetaCache = HashMap<PathBuf, (SystemTime, Arc<PiSessionMeta>)>;
type DetailCache = HashMap<PathBuf, (SystemTime, Arc<PiSessionDetail>)>;

static META_CACHE: OnceLock<RwLock<MetaCache>> = OnceLock::new();
static DETAIL_CACHE: OnceLock<RwLock<DetailCache>> = OnceLock::new();
static TEST_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn meta_cache() -> &'static RwLock<MetaCache> {
    META_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn detail_cache() -> &'static RwLock<DetailCache> {
    DETAIL_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn test_root() -> &'static RwLock<Option<PathBuf>> {
    TEST_ROOT.get_or_init(|| RwLock::new(None))
}

pub fn pi_sessions_root() -> Option<PathBuf> {
    if let Ok(root) = test_root().read() {
        if let Some(path) = root.clone() {
            return Some(path);
        }
    }
    Some(dirs::home_dir()?.join(".pi/agent/sessions"))
}

pub fn scan_pi_session_dir() -> Vec<PiSessionMeta> {
    let Some(root) = pi_sessions_root() else {
        return Vec::new();
    };
    scan_pi_session_dir_at(&root)
}

pub fn scan_pi_session_dir_at(root: &Path) -> Vec<PiSessionMeta> {
    if !root.exists() {
        return Vec::new();
    }

    let mut metas = Vec::new();
    let Ok(project_dirs) = fs::read_dir(root) else {
        return metas;
    };

    for project_dir in project_dirs.flatten() {
        let Ok(file_type) = project_dir.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                if let Some(meta) = read_pi_session_meta(&path) {
                    metas.push(meta);
                }
            }
        }
    }

    metas.sort_by(|a, b| b.modified.cmp(&a.modified));
    metas
}

pub fn read_pi_session_meta(path: &Path) -> Option<PiSessionMeta> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = meta_cache().read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return Some((**cached).clone());
            }
        }
    }

    let meta = Arc::new(read_pi_session_meta_uncached(path, mtime)?);
    if let Ok(mut cache) = meta_cache().write() {
        cache.insert(path.to_path_buf(), (mtime, Arc::clone(&meta)));
    }
    Some((*meta).clone())
}

pub fn read_pi_session_detail(path: &Path) -> Option<PiSessionDetail> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = detail_cache().read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return Some((**cached).clone());
            }
        }
    }

    let detail = Arc::new(read_pi_session_detail_uncached(path, &mut HashSet::new())?);
    if let Ok(mut cache) = detail_cache().write() {
        cache.insert(path.to_path_buf(), (mtime, Arc::clone(&detail)));
    }
    Some((*detail).clone())
}

pub fn find_pi_session_path(session_id: &str) -> Option<PathBuf> {
    scan_pi_session_dir()
        .into_iter()
        .find(|meta| meta.session_id == session_id)
        .map(|meta| meta.jsonl_path)
}

fn read_pi_session_meta_uncached(path: &Path, mtime: SystemTime) -> Option<PiSessionMeta> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    let header = parse_json_line(&lines.next()?.ok()?)?;
    if header.get("type")?.as_str()? != "session" {
        return None;
    }

    let mut message_count = 0u32;
    let mut first_message = String::new();
    let mut session_name = None;
    let mut last_activity = None;

    for line in lines.map_while(Result::ok) {
        let Some(entry) = parse_json_line(&line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session_info") {
            session_name = entry
                .get("name")
                .and_then(Value::as_str)
                .map(normalize_title)
                .filter(|name| !name.is_empty());
        }
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        message_count = message_count.saturating_add(1);
        let Some(message) = entry.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str);
        if matches!(role, Some("user" | "assistant")) {
            if let Some(ts) = message_timestamp_ms(&entry, message) {
                last_activity = Some(last_activity.map_or(ts, |last: i64| last.max(ts)));
            }
        }
        if first_message.is_empty() && role == Some("user") {
            let text = normalize_title(&extract_text_content(message));
            if !text.is_empty() {
                first_message = text;
            }
        }
    }

    let created = parse_ts_ms(header.get("timestamp")).unwrap_or_else(|| system_time_ms(mtime));
    Some(PiSessionMeta {
        session_id: header.get("id")?.as_str()?.to_string(),
        jsonl_path: path.to_path_buf(),
        cwd: header
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created,
        modified: last_activity.unwrap_or_else(|| system_time_ms(mtime).max(created)),
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
        session_name,
        parent_session_path: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

fn read_pi_session_detail_uncached(
    path: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Option<PiSessionDetail> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return None;
    }

    let meta = read_pi_session_meta(path)?;
    let mut messages = Vec::new();
    let mut compaction_entries = Vec::new();

    if let Some(parent) = meta.parent_session_path.as_deref() {
        let parent_path = PathBuf::from(parent);
        let parent_path = if parent_path.is_absolute() {
            parent_path
        } else {
            path.parent().unwrap_or_else(|| Path::new("")).join(parent_path)
        };
        if let Some(parent_detail) = read_pi_session_detail_uncached(&parent_path, visited) {
            messages.extend(parent_detail.messages);
            compaction_entries.extend(parent_detail.compaction_entries);
        }
    }

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Some(entry) = parse_json_line(&line) else {
            continue;
        };
        if idx == 0 && entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(message) = pi_message_from_entry(entry) {
                    messages.push(message);
                }
            }
            Some("compaction") => {
                compaction_entries.push(pi_compaction_from_entry(&entry));
                messages.push(PiMessage {
                    entry_id: get_string(&entry, "id"),
                    parent_id: get_optional_string(&entry, "parentId"),
                    timestamp_ms: entry_timestamp_ms(&entry),
                    role: "compactionSummary".to_string(),
                    text_preview: truncate_preview(
                        entry.get("summary").and_then(Value::as_str).unwrap_or(""),
                    ),
                    usage: None,
                    raw_json: entry,
                });
            }
            Some("branch_summary") => messages.push(PiMessage {
                entry_id: get_string(&entry, "id"),
                parent_id: get_optional_string(&entry, "parentId"),
                timestamp_ms: entry_timestamp_ms(&entry),
                role: "branchSummary".to_string(),
                text_preview: truncate_preview(
                    entry.get("summary").and_then(Value::as_str).unwrap_or(""),
                ),
                usage: None,
                raw_json: entry,
            }),
            Some("custom_message") | Some("custom") => messages.push(PiMessage {
                entry_id: get_string(&entry, "id"),
                parent_id: get_optional_string(&entry, "parentId"),
                timestamp_ms: entry_timestamp_ms(&entry),
                role: "custom".to_string(),
                text_preview: truncate_preview(&extract_entry_text(&entry)),
                usage: None,
                raw_json: entry,
            }),
            _ => {}
        }
    }

    Some(PiSessionDetail {
        meta,
        messages,
        compaction_entries,
    })
}

fn pi_message_from_entry(entry: Value) -> Option<PiMessage> {
    let message = entry.get("message")?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    Some(PiMessage {
        entry_id: get_string(&entry, "id"),
        parent_id: get_optional_string(&entry, "parentId"),
        timestamp_ms: message_timestamp_ms(&entry, message).unwrap_or_else(|| entry_timestamp_ms(&entry)),
        role,
        text_preview: truncate_preview(&extract_text_content(message)),
        usage: extract_usage(message),
        raw_json: entry,
    })
}

fn pi_compaction_from_entry(entry: &Value) -> PiCompactionEntry {
    PiCompactionEntry {
        entry_id: get_string(entry, "id"),
        parent_id: get_optional_string(entry, "parentId"),
        timestamp_ms: entry_timestamp_ms(entry),
        summary: entry
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        first_kept_entry_id: get_string(entry, "firstKeptEntryId"),
        tokens_before: entry.get("tokensBefore").and_then(Value::as_u64).unwrap_or(0) as u32,
        from_hook: entry.get("fromHook").and_then(Value::as_bool).unwrap_or(false),
        raw_json: entry.clone(),
    }
}

fn extract_usage(message: &Value) -> Option<PiUsage> {
    let usage = message.get("usage").or_else(|| message.get("tokens"))?;
    let input = get_u32_any(usage, &["input", "inputTokens"]);
    let output = get_u32_any(usage, &["output", "outputTokens"]);
    let cache_read = usage
        .get("cache")
        .map(|cache| get_u32_any(cache, &["read", "cacheRead", "cache_read"]))
        .unwrap_or_else(|| get_u32_any(usage, &["cache_read", "cacheRead"]));
    let cache_write = usage
        .get("cache")
        .map(|cache| get_u32_any(cache, &["write", "cacheWrite", "cache_write"]))
        .unwrap_or_else(|| get_u32_any(usage, &["cache_write", "cacheWrite"]));
    let total = get_u32_any(usage, &["total", "totalTokens"])
        .max(input.saturating_add(output).saturating_add(cache_read).saturating_add(cache_write));
    Some(PiUsage {
        input,
        output,
        cache_read,
        cache_write,
        total,
    })
}

fn get_u32_any(value: &Value, keys: &[&str]) -> u32 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64).map(|n| n as u32))
        .unwrap_or(0)
}

fn extract_entry_text(entry: &Value) -> String {
    if let Some(content) = entry.get("content") {
        return extract_content_value(content);
    }
    entry.get("data")
        .map(extract_content_value)
        .unwrap_or_default()
}

fn extract_text_content(message: &Value) -> String {
    message
        .get("content")
        .map(extract_content_value)
        .unwrap_or_default()
}

fn extract_content_value(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text").and_then(Value::as_str).map(ToString::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    String::new()
}

fn normalize_title(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate_preview(text: &str) -> String {
    let normalized = normalize_title(text);
    const MAX_CHARS: usize = 500;
    if normalized.chars().count() <= MAX_CHARS {
        return normalized;
    }
    normalized.chars().take(MAX_CHARS).collect::<String>()
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn system_time_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_json_line(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn parse_ts_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .ok()
            .or_else(|| s.parse::<i64>().ok()),
        _ => None,
    }
}

fn entry_timestamp_ms(entry: &Value) -> i64 {
    parse_ts_ms(entry.get("timestamp")).unwrap_or(0)
}

fn message_timestamp_ms(entry: &Value, message: &Value) -> Option<i64> {
    parse_ts_ms(message.get("timestamp")).or_else(|| parse_ts_ms(entry.get("timestamp")))
}

fn get_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn get_optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(ToString::to_string)
}

#[cfg(test)]
pub fn clear_caches_for_tests() {
    if let Ok(mut cache) = meta_cache().write() {
        cache.clear();
    }
    if let Ok(mut cache) = detail_cache().write() {
        cache.clear();
    }
    if let Ok(mut root) = test_root().write() {
        *root = None;
    }
}

#[cfg(test)]
pub fn set_test_root_for_tests(path: PathBuf) {
    if let Ok(mut root) = test_root().write() {
        *root = Some(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_path(dir: &tempfile::TempDir, content: &str) -> PathBuf {
        let session_dir = dir.path().join("--tmp-proj--");
        fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("2026-01-01_test.jsonl");
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn round_trip_small_pi_jsonl_fixture() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello\nworld"}]}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input":10,"output":5,"cache":{"read":3,"write":2},"total":20}}}
{"type":"session_info","id":"i1","parentId":"a1","timestamp":"2026-01-01T00:00:03.000Z","name":" Named "}
"#,
        );
        set_test_root_for_tests(dir.path().to_path_buf());

        let metas = scan_pi_session_dir();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].session_id, "s1");
        assert_eq!(metas[0].cwd, "/tmp/proj");
        assert_eq!(metas[0].message_count, 2);
        assert_eq!(metas[0].first_message, "hello world");
        assert_eq!(metas[0].session_name.as_deref(), Some("Named"));

        let detail = read_pi_session_detail(&path).unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].usage.as_ref().unwrap().total, 20);
    }

    #[test]
    fn compaction_entry_handling() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"compaction","id":"c1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","summary":"old stuff","firstKeptEntryId":"u2","tokensBefore":123,"fromHook":true}
"#,
        );
        let detail = read_pi_session_detail(&path).unwrap();
        assert_eq!(detail.compaction_entries.len(), 1);
        assert_eq!(detail.compaction_entries[0].summary, "old stuff");
        assert_eq!(detail.messages[0].role, "compactionSummary");
    }

    #[test]
    fn empty_or_missing_session_header_returns_none() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let empty = fixture_path(&dir, "");
        assert!(read_pi_session_meta(&empty).is_none());
        let bad = fixture_path(&dir, r#"{"type":"message","id":"m1"}"#);
        assert!(read_pi_session_meta(&bad).is_none());
    }

    #[test]
    fn malformed_json_line_is_skipped() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
not json
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"ok"}}
"#,
        );
        let meta = read_pi_session_meta(&path).unwrap();
        assert_eq!(meta.message_count, 1);
        assert_eq!(meta.first_message, "ok");
    }

    #[test]
    fn mtime_cache_invalidation_reloads_file() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"first"}}
"#,
        );
        let first = read_pi_session_meta(&path).unwrap();
        assert_eq!(first.first_message, "first");

        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:02.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":\"second\"}}}}").unwrap();
        drop(file);

        let second = read_pi_session_meta(&path).unwrap();
        assert_eq!(second.message_count, 2);
    }
}
