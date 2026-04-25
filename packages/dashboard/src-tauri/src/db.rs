use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub fn resolve_db_path() -> Option<PathBuf> {
    // The magic-context plugin uses XDG_DATA_HOME or ~/.local/share on ALL platforms
    // (see packages/plugin/src/shared/data-path.ts). On Windows this means
    // C:\Users\<user>\.local\share — NOT %APPDATA%.
    //
    // Plugin v0.16+ stores data at the shared cortexkit path (cross-harness:
    // OpenCode + Pi share one DB). Older OpenCode-only installs lived under
    // opencode/storage/plugin/magic-context. We prefer the new location and
    // fall back to the legacy path so the dashboard keeps working when the
    // user hasn't restarted OpenCode since the upgrade.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });

    let shared_path = data_dir
        .join("cortexkit")
        .join("magic-context")
        .join("context.db");
    if shared_path.exists() {
        return Some(shared_path);
    }

    let legacy_path = data_dir
        .join("opencode")
        .join("storage")
        .join("plugin")
        .join("magic-context")
        .join("context.db");
    if legacy_path.exists() {
        Some(legacy_path)
    } else {
        None
    }
}

pub fn resolve_opencode_db_path() -> Option<PathBuf> {
    // OpenCode also uses XDG_DATA_HOME or ~/.local/share on all platforms.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });
    let db_path = data_dir.join("opencode").join("opencode.db");
    if db_path.exists() {
        Some(db_path)
    } else {
        None
    }
}

/// Opens a read-only connection to the database in WAL mode.
pub fn open_readonly(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // WAL mode is inherited from the plugin's read-write connection — no need to set it here.
    // busy_timeout is connection-local and safe on read-only connections.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(conn)
}

/// Opens a read-write connection for write operations (memory edits, queue entries).
pub fn open_readwrite(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

// ── Memory types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Memory {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub source_session_id: Option<String>,
    pub source_type: String,
    pub seen_count: i64,
    pub retrieval_count: i64,
    pub first_seen_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub last_retrieved_at: Option<i64>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub verification_status: String,
    pub verified_at: Option<i64>,
    pub superseded_by_memory_id: Option<i64>,
    pub merged_from: Option<String>,
    pub metadata_json: Option<String>,
    pub has_embedding: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryStats {
    pub total: i64,
    pub active: i64,
    pub permanent: i64,
    pub archived: i64,
    pub with_embeddings: i64,
    pub categories: Vec<CategoryCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

// ── Session types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub project_identity: Option<String>,
    pub compartment_count: i64,
    pub fact_count: i64,
    pub note_count: i64,
    pub first_compartment_start: Option<i64>,
    pub last_compartment_end: Option<i64>,
    pub last_response_time: Option<i64>,
    pub last_context_percentage: Option<f64>,
    pub is_subagent: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct Compartment {
    pub id: i64,
    pub session_id: String,
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    /// Resolved from OpenCode DB using start_message_id
    pub start_time: Option<i64>,
    /// Resolved from OpenCode DB using end_message_id
    pub end_time: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionFact {
    pub id: i64,
    pub session_id: String,
    pub category: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Note {
    pub id: i64,
    #[serde(rename = "type")]
    pub note_type: String,
    pub status: String,
    pub content: String,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub surface_condition: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_checked_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMetaRow {
    pub session_id: String,
    pub last_response_time: Option<i64>,
    pub cache_ttl: Option<String>,
    pub counter: i64,
    pub last_nudge_tokens: i64,
    pub last_nudge_band: String,
    pub is_subagent: bool,
    pub last_context_percentage: f64,
    pub last_input_tokens: i64,
    pub times_execute_threshold_reached: i64,
    pub compartment_in_progress: bool,
    pub system_prompt_hash: String,
    pub memory_block_count: i64,
}

// ── Dreamer types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DreamQueueEntry {
    pub id: i64,
    pub project_path: String,
    pub reason: String,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub retry_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamStateEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamRun {
    pub id: i64,
    pub project_path: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub holder_id: String,
    pub tasks_json: serde_json::Value,
    pub tasks_succeeded: i64,
    pub tasks_failed: i64,
    pub smart_notes_surfaced: i64,
    pub smart_notes_pending: i64,
    pub memory_changes_json: Option<serde_json::Value>,
}

// ── Note types ────────────────────────────────────────────────
// Unified Note struct replaces SessionNote and SmartNote
// Both session notes (type='session') and smart notes (type='smart') are stored in the notes table

// ── Context Token Breakdown ───────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ContextTokenBreakdown {
    pub total_input_tokens: i64,
    pub system_prompt_tokens: i64,
    pub compartment_tokens: i64,
    pub fact_tokens: i64,
    pub memory_tokens: i64,
    pub conversation_tokens: i64, // total - compartments - facts - memories - system_prompt
    pub compartment_count: i64,
    pub fact_count: i64,
    pub memory_count: i64,
}

// ── Cache diagnostics ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbCacheEvent {
    pub message_id: String,
    pub session_id: String,
    pub timestamp: i64,
    pub input_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub hit_ratio: f64,
    pub severity: String,
    pub cause: Option<String>,
    pub agent: Option<String>,
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

#[derive(Debug, Clone)]
struct RawDbCacheEvent {
    message_id: String,
    session_id: String,
    timestamp: i64,
    input_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    total_tokens: i64,
    agent: Option<String>,
}

#[derive(Debug, Clone)]
struct LogCauseCandidate {
    session_id: String,
    timestamp: i64,
    cause: String,
}

/// Estimate tokens using ~4 chars per token (CHARS_PER_TOKEN_ESTIMATE = 4)
fn estimate_tokens(chars: i64) -> i64 {
    (chars + 3) / 4 // Round up
}

/// XML overhead for compartments (approximate: <compartment title="...">...</compartment>)
const COMPARTMENT_XML_OVERHEAD: i64 = 50;

pub fn get_context_token_breakdown(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ContextTokenBreakdown>, rusqlite::Error> {
    // Get total input tokens and system prompt tokens from session_meta
    let (total_input_tokens, system_prompt_tokens): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(last_input_tokens, 0), COALESCE(system_prompt_tokens, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // If no input tokens recorded, return None (no data available)
    if total_input_tokens == 0 {
        return Ok(None);
    }

    // Get compartment content length and count
    let (compartment_chars, compartment_count): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + ?2), 0), COUNT(*) 
             FROM compartments WHERE session_id = ?1",
            rusqlite::params![session_id, COMPARTMENT_XML_OVERHEAD],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // Get fact content length and count
    let (fact_chars, fact_count): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(category) + LENGTH(content) + 20), 0), COUNT(*) 
             FROM session_facts WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // Get memory block cache (rendered XML) and count from session_meta
    let (memory_cache_str, memory_count): (Option<String>, i64) = conn
        .query_row(
            "SELECT memory_block_cache, COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, 0));

    let memory_chars = memory_cache_str
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.len() as i64)
        .unwrap_or(0);

    // Estimate tokens
    let compartment_tokens = estimate_tokens(compartment_chars);
    let fact_tokens = estimate_tokens(fact_chars);
    let memory_tokens = estimate_tokens(memory_chars);

    // Conversation tokens = total - all known sections
    let known_tokens = system_prompt_tokens + compartment_tokens + fact_tokens + memory_tokens;
    let conversation_tokens = if total_input_tokens > known_tokens {
        total_input_tokens - known_tokens
    } else {
        0
    };

    Ok(Some(ContextTokenBreakdown {
        total_input_tokens,
        system_prompt_tokens,
        compartment_tokens,
        fact_tokens,
        memory_tokens,
        conversation_tokens,
        compartment_count,
        fact_count,
        memory_count,
    }))
}

// ── Database health ───────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbHealth {
    pub exists: bool,
    pub path: String,
    pub size_bytes: u64,
    pub wal_size_bytes: u64,
    pub table_counts: Vec<TableCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TableCount {
    pub table_name: String,
    pub row_count: i64,
}

// ── Helpers ───────────────────────────────────────────────────

/// Compute a normalized hash matching the plugin's dedup logic:
/// lowercase → trim whitespace → hash as hex string.
/// Uses std::hash for portability (no SHA crate in deps); the exact
/// hash algorithm doesn't matter as long as it's consistent within
/// the dashboard. The plugin uses its own Bun-based hash path.
/// Match the plugin's `computeNormalizedHash`: lowercase → collapse whitespace → trim → MD5 hex.
fn normalize_hash(content: &str) -> String {
    let normalized = content.to_lowercase();
    // Collapse all whitespace runs into a single space (mirrors JS /\s+/g → " ")
    let normalized: String = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = md5::compute(normalized.as_bytes());
    format!("{:032x}", digest)
}

fn format_timestamp_iso(timestamp: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp.to_string())
}

fn parse_log_timestamp_millis(timestamp: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.timestamp_millis())
        .ok()
}

fn detect_log_cache_cause(
    entries: &[crate::log_parser::LogEntry],
    event_idx: usize,
) -> Option<String> {
    let event = &entries[event_idx];
    let window_start = event_idx.saturating_sub(10);
    let window_end = std::cmp::min(event_idx + 4, entries.len());
    let mut causes = Vec::new();

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
        if msg.contains("heuristic cleanup") || msg.contains("tool tags dropped") {
            causes.push("Heuristic cleanup".to_string());
        }
    }

    causes.dedup();
    if causes.is_empty() {
        None
    } else {
        Some(causes.join(", "))
    }
}

fn build_log_cause_candidates() -> Vec<LogCauseCandidate> {
    let log_path = crate::log_parser::resolve_log_path();
    let entries = crate::log_parser::read_log_tail(&log_path, 5000);

    entries
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| {
            if entry.session_id.is_empty()
                || entry.cache_read.is_none()
                || entry.cache_write.is_none()
            {
                return None;
            }

            let timestamp = parse_log_timestamp_millis(&entry.timestamp)?;
            let cause = detect_log_cache_cause(&entries, idx)?;

            Some(LogCauseCandidate {
                session_id: entry.session_id.clone(),
                timestamp,
                cause,
            })
        })
        .collect()
}

fn match_log_cause(
    candidates: &[LogCauseCandidate],
    session_id: &str,
    timestamp: i64,
) -> Option<String> {
    let mut matches: Vec<(i64, &str)> = candidates
        .iter()
        .filter(|candidate| candidate.session_id == session_id)
        .filter_map(|candidate| {
            let distance = (candidate.timestamp - timestamp).abs();
            if distance <= 5_000 {
                Some((distance, candidate.cause.as_str()))
            } else {
                None
            }
        })
        .collect();

    matches.sort_by_key(|(distance, _)| *distance);

    let mut deduped = Vec::new();
    for (_, cause) in matches {
        if !deduped.iter().any(|existing: &String| existing == cause) {
            deduped.push(cause.to_string());
        }
    }

    if deduped.is_empty() {
        None
    } else {
        Some(deduped.join(", "))
    }
}

fn load_raw_db_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Result<Vec<RawDbCacheEvent>, rusqlite::Error> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Ok(Vec::new());
    };

    let conn = open_readonly(&opencode_db_path)?;

    // Per-session windowing: each session gets up to `limit` recent events
    // (so a session-filtered timeline always has full bar coverage), capped
    // globally at `limit * 10` to bound memory across many concurrent sessions.
    // Without this, a 200-event global window split across e.g. 4 active
    // sessions left each session with only ~50 bars on the chart.
    let per_session_limit = limit as i64;
    let global_cap = per_session_limit.saturating_mul(10);

    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(since) =
        since_timestamp
    {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
                  AND m.time_created > ?1
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent
            FROM ranked
            WHERE rn <= ?2
            ORDER BY time_created DESC
            LIMIT ?3".to_string(),
            vec![
                Box::new(since) as Box<dyn rusqlite::types::ToSql>,
                Box::new(per_session_limit),
                Box::new(global_cap),
            ],
        )
    } else {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent
            FROM ranked
            WHERE rn <= ?1
            ORDER BY time_created DESC
            LIMIT ?2".to_string(),
            vec![
                Box::new(per_session_limit) as Box<dyn rusqlite::types::ToSql>,
                Box::new(global_cap),
            ],
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(RawDbCacheEvent {
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
        })
    })?;

    rows.collect()
}

fn build_db_cache_events(rows: Vec<RawDbCacheEvent>, enrich_causes: bool) -> Vec<DbCacheEvent> {
    let log_cause_candidates = if enrich_causes {
        build_log_cause_candidates()
    } else {
        Vec::new()
    };

    // Build a map of earliest timestamp per session in our window so we can
    // detect whether an event is truly the session's first message vs just
    // the oldest event in the current 200-event window.
    let mut earliest_ts_in_window: HashMap<String, i64> = HashMap::new();
    for row in &rows {
        earliest_ts_in_window
            .entry(row.session_id.clone())
            .and_modify(|ts| {
                if row.timestamp < *ts {
                    *ts = row.timestamp;
                }
            })
            .or_insert(row.timestamp);
    }

    // Check which sessions truly have their first-ever assistant message in our
    // window by computing each session's true-first assistant message timestamp
    // in a single GROUP BY query, then comparing to our window's earliest. With
    // N concurrent sessions this used to issue N sequential `EXISTS` queries
    // (one per session) — now it's one CTE-style aggregate scan.
    let true_first_sessions: HashSet<String> =
        if !earliest_ts_in_window.is_empty() {
            if let Some(opencode_db_path) = resolve_opencode_db_path() {
                if let Ok(conn) = open_readonly(&opencode_db_path) {
                    // Build IN-clause with placeholders for each session_id we care about.
                    let session_ids: Vec<String> = earliest_ts_in_window.keys().cloned().collect();
                    let placeholders = vec!["?"; session_ids.len()].join(",");
                    let sql = format!(
                        "SELECT session_id, MIN(time_created) AS first_ts
                         FROM message
                         WHERE session_id IN ({})
                           AND json_extract(data, '$.role') = 'assistant'
                           AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0
                         GROUP BY session_id",
                        placeholders
                    );
                    let session_id_refs: Vec<&dyn rusqlite::types::ToSql> =
                        session_ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
                    if let Ok(mut stmt) = conn.prepare(&sql) {
                        let rows = stmt.query_map(session_id_refs.as_slice(), |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                        });
                        if let Ok(rows) = rows {
                            // A session is "truly first" in our window if its
                            // window-earliest timestamp matches its DB-wide
                            // earliest assistant timestamp.
                            rows.filter_map(|r| r.ok())
                                .filter(|(sid, db_earliest)| {
                                    earliest_ts_in_window
                                        .get(sid)
                                        .map(|window_earliest| *window_earliest <= *db_earliest)
                                        .unwrap_or(false)
                                })
                                .map(|(sid, _)| sid)
                                .collect()
                        } else {
                            HashSet::new()
                        }
                    } else {
                        HashSet::new()
                    }
                } else {
                    HashSet::new()
                }
            } else {
                HashSet::new()
            }
        } else {
            HashSet::new()
        };

    let mut seen_sessions = HashSet::new();
    let mut chronological = Vec::with_capacity(rows.len());

    for row in rows.into_iter().rev() {
        let total_prompt = row.input_tokens + row.cache_read + row.cache_write;
        let hit_ratio = if total_prompt > 0 {
            row.cache_read as f64 / total_prompt as f64
        } else {
            0.0
        };

        let is_first_session_event = seen_sessions.insert(row.session_id.clone());
        let is_truly_first =
            is_first_session_event && true_first_sessions.contains(&row.session_id);
        let (severity, cause) = if is_truly_first {
            (
                "info".to_string(),
                Some("First message (new session)".to_string()),
            )
        } else if row.cache_read == 0 && row.cache_write > 0 {
            (
                "full_bust".to_string(),
                match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp),
            )
        } else if hit_ratio < 0.5 {
            (
                "bust".to_string(),
                match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp),
            )
        } else if hit_ratio < 0.9 {
            (
                "warning".to_string(),
                if enrich_causes {
                    match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp)
                } else {
                    None
                },
            )
        } else {
            ("stable".to_string(), None)
        };

        chronological.push(DbCacheEvent {
            message_id: row.message_id,
            session_id: row.session_id,
            timestamp: row.timestamp,
            input_tokens: row.input_tokens,
            cache_read: row.cache_read,
            cache_write: row.cache_write,
            total_tokens: row.total_tokens,
            hit_ratio,
            severity,
            cause,
            agent: row.agent,
        });
    }

    chronological
}

pub fn get_cache_events_from_db(limit: usize, since_timestamp: Option<i64>) -> Vec<DbCacheEvent> {
    load_raw_db_cache_events(limit, since_timestamp)
        .map(|rows| build_db_cache_events(rows, true))
        .unwrap_or_default()
}

pub fn get_session_cache_stats_from_db(limit: usize) -> Vec<SessionCacheStats> {
    // Reuse raw rows instead of re-querying + re-parsing logs
    let events = load_raw_db_cache_events(200, None)
        .map(|rows| build_db_cache_events(rows, false)) // skip log enrichment for stats
        .unwrap_or_default();
    let mut map: HashMap<String, (usize, i64, i64, i64, i64, usize)> = HashMap::new();

    for event in events {
        if event.session_id.is_empty() {
            continue;
        }

        let entry = map
            .entry(event.session_id.clone())
            .or_insert((0, 0, 0, 0, event.timestamp, 0));
        entry.0 += 1;
        entry.1 += event.cache_read;
        entry.2 += event.cache_write;
        entry.3 += event.input_tokens;
        entry.4 = entry.4.max(event.timestamp);
        if event.severity == "bust" || event.severity == "full_bust" {
            entry.5 += 1;
        }
    }

    let mut stats: Vec<(i64, SessionCacheStats)> = map
        .into_iter()
        .map(
            |(
                session_id,
                (
                    event_count,
                    total_cache_read,
                    total_cache_write,
                    total_input,
                    last_timestamp,
                    bust_count,
                ),
            )| {
                let total_prompt = total_cache_read + total_cache_write + total_input;
                let hit_ratio = if total_prompt > 0 {
                    total_cache_read as f64 / total_prompt as f64
                } else {
                    0.0
                };

                (
                    last_timestamp,
                    SessionCacheStats {
                        session_id,
                        event_count,
                        total_cache_read,
                        total_cache_write,
                        total_input,
                        hit_ratio,
                        last_timestamp: format_timestamp_iso(last_timestamp),
                        bust_count,
                    },
                )
            },
        )
        .collect();

    stats.sort_by(|a, b| b.0.cmp(&a.0));
    stats.truncate(limit);
    stats.into_iter().map(|(_, stat)| stat).collect()
}

// ── Project resolution ────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub identity: String,
    pub label: String,        // friendly name (directory basename or identity)
    pub path: Option<String>, // resolved filesystem path, if found
}

pub fn get_projects(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT project_path FROM memories
         UNION
         SELECT project_path FROM dream_queue
         UNION
         SELECT project_path FROM dream_runs
         ORDER BY project_path",
    )?;
    let identities: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve git:HASH identities via OpenCode's project table
    let hash_to_project = resolve_from_opencode_db(&identities);

    let projects = identities
        .into_iter()
        .map(|id| {
            let (label, path) = if let Some((name, worktree)) = hash_to_project.get(&id) {
                let display = if name.is_empty() {
                    // Use directory basename as label
                    std::path::Path::new(worktree)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| worktree.clone())
                } else {
                    name.clone()
                };
                (display, Some(worktree.clone()))
            } else if id.starts_with("git:") {
                let short = &id[4..std::cmp::min(id.len(), 14)];
                (format!("git:{short}…"), None)
            } else {
                (id.clone(), None)
            };
            ProjectInfo {
                identity: id,
                label,
                path,
            }
        })
        .collect();

    Ok(projects)
}

/// Look up project names and worktrees from OpenCode's own database.
/// OpenCode stores projects with `id` = git root commit hash and `worktree` = directory path.
fn resolve_from_opencode_db(
    identities: &[String],
) -> std::collections::HashMap<String, (String, String)> {
    let mut result = HashMap::new();

    let Some(opencode_db) = resolve_opencode_db_path() else {
        return result;
    };

    let conn = match open_readonly(&opencode_db) {
        Ok(c) => c,
        Err(_) => return result,
    };

    // Query all projects — the table is small
    let mut stmt = match conn.prepare("SELECT id, name, worktree FROM project") {
        Ok(s) => s,
        Err(_) => return result,
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return result,
    };

    // Build a hash → (name, worktree) map
    let mut oc_projects: HashMap<String, (String, String)> = HashMap::new();
    for row in rows.flatten() {
        let (id, name, worktree) = row;
        oc_projects.insert(id, (name.unwrap_or_default(), worktree));
    }

    // Match our git:HASH identities against opencode project IDs
    for identity in identities {
        if let Some(hash) = identity.strip_prefix("git:") {
            if let Some((name, worktree)) = oc_projects.get(hash) {
                result.insert(identity.clone(), (name.clone(), worktree.clone()));
            }
        }
    }

    result
}

// ── Query implementations ─────────────────────────────────────

pub fn get_memories(
    conn: &Connection,
    project_filter: Option<&str>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    let raw_search = search_query.unwrap_or("").trim().to_string();
    let has_search = !raw_search.is_empty();

    // Sanitize search query for FTS5: wrap each token in double quotes so
    // special characters (/, -, etc.) are treated as literals, matching the
    // plugin's sanitizeFtsQuery() approach.
    let sanitized_fts = if has_search {
        let tokens: Vec<String> = raw_search
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if tokens.is_empty() {
            String::new()
        } else {
            tokens.join(" ")
        }
    } else {
        String::new()
    };
    let use_fts = !sanitized_fts.is_empty();
    // For very short queries (< 3 chars) or if FTS sanitization produces nothing,
    // fall back to LIKE which handles partial matches better
    let use_like_fallback = has_search && (!use_fts || raw_search.len() < 3);
    let like_pattern = format!("%{}%", raw_search.replace('%', "\\%").replace('_', "\\_"));

    // Build WHERE clauses and params dynamically
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if use_fts && !use_like_fallback {
        params.push(Box::new(sanitized_fts.clone()));
        // FTS match uses the first param
    } else if has_search {
        params.push(Box::new(like_pattern.clone()));
        // LIKE uses the first param
    }

    if let Some(p) = project_filter {
        params.push(Box::new(p.to_string()));
        conditions.push(format!("m.project_path = ?{}", params.len()));
    }
    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("m.status = ?{}", params.len()));
    }
    if let Some(c) = category_filter {
        params.push(Box::new(c.to_string()));
        conditions.push(format!("m.category = ?{}", params.len()));
    }

    let where_extra = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    // Add limit and offset
    let limit_idx = params.len() + 1;
    let offset_idx = params.len() + 2;
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let sql = if use_fts && !use_like_fallback {
        // FTS5 search with sanitized query
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             INNER JOIN memories_fts ON memories_fts.rowid = m.id
             WHERE memories_fts MATCH ?1
             {}
             ORDER BY rank
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else if has_search {
        // LIKE fallback for short queries or special-character-heavy input
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else {
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE 1=1
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    };

    // Try FTS first; if it fails (e.g. malformed query despite sanitization), fall back to LIKE
    let result = {
        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
        rows.collect::<Result<Vec<_>, _>>()
    };

    match result {
        Ok(memories) if !memories.is_empty() || !use_fts => Ok(memories),
        Ok(_empty) if use_fts && !use_like_fallback => {
            // FTS returned nothing — retry with LIKE for better partial matching
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            // Rebuild params with LIKE pattern instead of FTS query
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            // Re-add filter params
            if let Some(p) = project_filter {
                like_params.push(Box::new(p.to_string()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        Err(e) if use_fts => {
            // FTS query failed — fall back to LIKE
            eprintln!("FTS search failed, falling back to LIKE: {}", e);
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            if let Some(p) = project_filter {
                like_params.push(Box::new(p.to_string()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        other => other,
    }
}

fn map_memory_row(row: &rusqlite::Row<'_>) -> Result<Memory, rusqlite::Error> {
    Ok(Memory {
        id: row.get(0)?,
        project_path: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        normalized_hash: row.get(4)?,
        source_session_id: row.get(5)?,
        source_type: row.get(6)?,
        seen_count: row.get(7)?,
        retrieval_count: row.get(8)?,
        first_seen_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_seen_at: row.get(12)?,
        last_retrieved_at: row.get(13)?,
        status: row.get(14)?,
        expires_at: row.get(15)?,
        verification_status: row.get(16)?,
        verified_at: row.get(17)?,
        superseded_by_memory_id: row.get(18)?,
        merged_from: row.get(19)?,
        metadata_json: row.get(20)?,
        has_embedding: row.get::<_, i64>(21)? != 0,
    })
}

pub fn get_memory_stats(
    conn: &Connection,
    project_filter: Option<&str>,
) -> Result<MemoryStats, rusqlite::Error> {
    let project_clause = if project_filter.is_some() {
        "WHERE project_path = ?1"
    } else {
        ""
    };
    let project_and = if project_filter.is_some() {
        "AND project_path = ?1"
    } else {
        ""
    };

    let total: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM memories {}", project_clause),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?
    };
    let active: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'active' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'active'",
            [],
            |r| r.get(0),
        )?
    };
    let permanent: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'permanent' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'permanent'",
            [],
            |r| r.get(0),
        )?
    };
    let archived: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'archived' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'archived'",
            [],
            |r| r.get(0),
        )?
    };
    let with_embeddings: i64 = if let Some(p) = project_filter {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_embeddings me JOIN memories m ON me.memory_id = m.id WHERE m.project_path = ?1",
            [p], |r| r.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))?
    };

    let cat_sql = if project_filter.is_some() {
        "SELECT category, COUNT(*) as cnt FROM memories WHERE status != 'archived' AND project_path = ?1 GROUP BY category ORDER BY cnt DESC"
    } else {
        "SELECT category, COUNT(*) as cnt FROM memories WHERE status != 'archived' GROUP BY category ORDER BY cnt DESC"
    };
    let mut stmt = conn.prepare(cat_sql)?;
    let categories: Vec<CategoryCount> = if let Some(p) = project_filter {
        stmt.query_map([p], |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    Ok(MemoryStats {
        total,
        active,
        permanent,
        archived,
        with_embeddings,
        categories,
    })
}

pub fn update_memory_status(
    conn: &Connection,
    memory_id: i64,
    new_status: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![new_status, now, memory_id],
    )?;
    Ok(())
}

pub fn update_memory_content(
    conn: &Connection,
    memory_id: i64,
    new_content: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    let new_hash = normalize_hash(new_content);
    conn.execute(
        "UPDATE memories SET content = ?1, normalized_hash = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![new_content, new_hash, now, memory_id],
    )?;
    // Delete stale embedding since content changed
    conn.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        rusqlite::params![memory_id],
    )?;
    Ok(())
}

pub fn delete_memory(conn: &Connection, memory_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM memories WHERE id = ?1",
        rusqlite::params![memory_id],
    )?;
    Ok(())
}

/// Bulk-update status for a set of memory IDs in one transaction.
///
/// We assemble an `IN (?,?,...)` clause dynamically because rusqlite has no
/// first-class array binding. IDs are integers so SQL-injection is not a
/// concern; each ID is still bound as a parameter.
///
/// Empty input is a no-op and returns 0 (affected rows).
pub fn bulk_update_memory_status(
    conn: &mut Connection,
    memory_ids: &[i64],
    new_status: &str,
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    let now = chrono::Utc::now().timestamp_millis();
    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id IN ({})",
        placeholders,
    );

    let tx = conn.transaction()?;
    let affected = {
        let mut stmt = tx.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + memory_ids.len());
        params.push(&new_status as &dyn rusqlite::ToSql);
        params.push(&now as &dyn rusqlite::ToSql);
        for id in memory_ids {
            params.push(id as &dyn rusqlite::ToSql);
        }
        stmt.execute(&params[..])?
    };
    tx.commit()?;
    Ok(affected)
}

/// Bulk-delete memories and their embeddings in one transaction.
///
/// Deletes from `memory_embeddings` first, then `memories`. Though
/// `memory_embeddings.memory_id` has a foreign key, we don't rely on
/// cascade delete here — explicit delete keeps the intent readable and
/// matches what single `delete_memory` implicitly gets via the FK.
pub fn bulk_delete_memory(
    conn: &mut Connection,
    memory_ids: &[i64],
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    let tx = conn.transaction()?;
    // Explicitly clear embeddings first; the FK would handle this too but
    // being explicit documents the intent and matches single-row delete logs.
    {
        let sql = format!("DELETE FROM memory_embeddings WHERE memory_id IN ({})", placeholders);
        let mut stmt = tx.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            memory_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(&params[..])?;
    }
    let affected = {
        let sql = format!("DELETE FROM memories WHERE id IN ({})", placeholders);
        let mut stmt = tx.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            memory_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(&params[..])?
    };
    tx.commit()?;
    Ok(affected)
}

// ── Session queries ─────────────────────────────────────────

pub fn get_sessions(conn: &Connection) -> Result<Vec<SessionSummary>, rusqlite::Error> {
    let sql = "
        WITH comp_stats AS (
            SELECT session_id,
                   COUNT(*) AS cnt,
                   MIN(start_message) AS first_start,
                   MAX(end_message) AS last_end
            FROM compartments GROUP BY session_id
        ),
        fact_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM session_facts GROUP BY session_id
        ),
        note_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM notes WHERE type = 'session' AND status = 'active' GROUP BY session_id
        )
        SELECT
            sm.session_id,
            COALESCE(cs.cnt, 0),
            COALESCE(fs.cnt, 0),
            COALESCE(ns.cnt, 0),
            cs.first_start,
            cs.last_end,
            sm.last_response_time,
            sm.last_context_percentage,
            sm.is_subagent
        FROM session_meta sm
        LEFT JOIN comp_stats cs ON cs.session_id = sm.session_id
        LEFT JOIN fact_stats fs ON fs.session_id = sm.session_id
        LEFT JOIN note_stats ns ON ns.session_id = sm.session_id
        ORDER BY sm.last_response_time DESC NULLS LAST
    ";
    let mut stmt = conn.prepare(sql)?;
    let mut sessions: Vec<SessionSummary> = stmt
        .query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: None,
                project_identity: None,
                compartment_count: row.get(1)?,
                fact_count: row.get(2)?,
                note_count: row.get(3)?,
                first_compartment_start: row.get(4)?,
                last_compartment_end: row.get(5)?,
                last_response_time: row.get(6)?,
                last_context_percentage: row.get(7)?,
                is_subagent: row.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve session titles and project IDs from OpenCode's DB
    let session_info = resolve_session_info(&sessions);
    for session in &mut sessions {
        if let Some(info) = session_info.get(&session.session_id) {
            session.title = Some(info.0.clone());
            if !info.1.is_empty() {
                session.project_identity = Some(format!("git:{}", info.1));
            }
        }
    }

    Ok(sessions)
}

/// Look up session titles and project IDs from OpenCode's database.
/// Returns HashMap<session_id, (title, project_id)>.
fn resolve_session_info(
    sessions: &[SessionSummary],
) -> std::collections::HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    if sessions.is_empty() {
        return result;
    }

    let Some(opencode_db) = resolve_opencode_db_path() else {
        return result;
    };

    let conn = match open_readonly(&opencode_db) {
        Ok(c) => c,
        Err(_) => return result,
    };

    let mut stmt = match conn.prepare("SELECT id, title, project_id FROM session") {
        Ok(s) => s,
        Err(_) => return result,
    };

    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        for row in rows.flatten() {
            result.insert(row.0, (row.1, row.2));
        }
    }

    result
}

pub fn get_compartments(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Compartment>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at
         FROM compartments WHERE session_id = ?1 ORDER BY sequence DESC",
    )?;
    let mut compartments: Vec<Compartment> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(Compartment {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sequence: row.get(2)?,
                start_message: row.get(3)?,
                end_message: row.get(4)?,
                start_message_id: row.get(5)?,
                end_message_id: row.get(6)?,
                title: row.get(7)?,
                content: row.get(8)?,
                created_at: row.get(9)?,
                start_time: None,
                end_time: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve message timestamps from OpenCode DB
    if let Some(opencode_db_path) = resolve_opencode_db_path() {
        if let Ok(oc_conn) = open_readonly(&opencode_db_path) {
            for comp in compartments.iter_mut() {
                if let Some(ref start_id) = comp.start_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![start_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.start_time = ts;
                    }
                }
                if let Some(ref end_id) = comp.end_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![end_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.end_time = ts;
                    }
                }
            }
        }
    }

    Ok(compartments)
}

pub fn get_session_facts(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionFact>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, category, content, created_at, updated_at
         FROM session_facts WHERE session_id = ?1 ORDER BY category, created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionFact {
            id: row.get(0)?,
            session_id: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_notes(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, type, status, content, session_id, project_path, surface_condition,
                created_at, updated_at, last_checked_at, ready_at, ready_reason
         FROM notes WHERE session_id = ?1 AND type = 'session' AND status = 'active'
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(Note {
            id: row.get(0)?,
            note_type: row.get(1)?,
            status: row.get(2)?,
            content: row.get(3)?,
            session_id: row.get(4)?,
            project_path: row.get(5)?,
            surface_condition: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            last_checked_at: row.get(9)?,
            ready_at: row.get(10)?,
            ready_reason: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn update_session_fact(
    conn: &Connection,
    fact_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE session_facts SET content = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![content, chrono::Utc::now().timestamp_millis(), fact_id],
    )
}

pub fn delete_session_fact(
    conn: &Connection,
    fact_id: i64,
) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM session_facts WHERE id = ?1", rusqlite::params![fact_id])
}

pub fn update_note(
    conn: &Connection,
    note_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![content, chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn delete_note(
    conn: &Connection,
    note_id: i64,
) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![note_id])
}

pub fn dismiss_note(
    conn: &Connection,
    note_id: i64,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn get_smart_notes(
    conn: &Connection,
    project_path: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, type, status, content, session_id, project_path, surface_condition,
                created_at, updated_at, last_checked_at, ready_at, ready_reason
         FROM notes
         WHERE project_path = ?1 AND type = 'smart' AND status != 'dismissed'
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_path], |row| {
        Ok(Note {
            id: row.get(0)?,
            note_type: row.get(1)?,
            status: row.get(2)?,
            content: row.get(3)?,
            session_id: row.get(4)?,
            project_path: row.get(5)?,
            surface_condition: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            last_checked_at: row.get(9)?,
            ready_at: row.get(10)?,
            ready_reason: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_meta(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionMetaRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens,
                last_nudge_band, is_subagent, last_context_percentage, last_input_tokens,
                times_execute_threshold_reached, compartment_in_progress, system_prompt_hash,
                memory_block_count
         FROM session_meta WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionMetaRow {
            session_id: row.get(0)?,
            last_response_time: row.get(1)?,
            cache_ttl: row.get(2)?,
            counter: row.get(3)?,
            last_nudge_tokens: row.get(4)?,
            last_nudge_band: row.get::<_, String>(5)?,
            is_subagent: row.get::<_, i64>(6)? != 0,
            last_context_percentage: row.get(7)?,
            last_input_tokens: row.get(8)?,
            times_execute_threshold_reached: row.get(9)?,
            compartment_in_progress: row.get::<_, i64>(10)? != 0,
            system_prompt_hash: row.get(11)?,
            memory_block_count: row.get(12)?,
        })
    })?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

// ── Dreamer queries ─────────────────────────────────────────

pub fn get_dream_queue(conn: &Connection) -> Result<Vec<DreamQueueEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_path, reason, enqueued_at, started_at, retry_count
         FROM dream_queue ORDER BY enqueued_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamQueueEntry {
            id: row.get(0)?,
            project_path: row.get(1)?,
            reason: row.get(2)?,
            enqueued_at: row.get(3)?,
            started_at: row.get(4)?,
            retry_count: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_dream_state(conn: &Connection) -> Result<Vec<DreamStateEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT key, value FROM dream_state")?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamStateEntry {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn parse_dream_run_json<T: serde::de::DeserializeOwned>(
    value: &str,
    column_index: usize,
) -> Result<T, rusqlite::Error> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column_index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_dream_run_row(row: &rusqlite::Row<'_>) -> Result<DreamRun, rusqlite::Error> {
    let tasks_json_str: String = row.get(5)?;
    let memory_changes_json_str: Option<String> = row.get(10)?;

    Ok(DreamRun {
        id: row.get(0)?,
        project_path: row.get(1)?,
        started_at: row.get(2)?,
        finished_at: row.get(3)?,
        holder_id: row.get(4)?,
        tasks_json: parse_dream_run_json(&tasks_json_str, 5)?,
        tasks_succeeded: row.get(6)?,
        tasks_failed: row.get(7)?,
        smart_notes_surfaced: row.get(8)?,
        smart_notes_pending: row.get(9)?,
        memory_changes_json: memory_changes_json_str
            .as_deref()
            .map(|value| parse_dream_run_json(value, 10))
            .transpose()?,
    })
}

pub fn get_dream_runs(
    conn: &Connection,
    project_path: Option<&str>,
    limit: usize,
) -> Result<Vec<DreamRun>, String> {
    let normalized_limit = std::cmp::max(limit, 1) as i64;
    let mut runs: Vec<DreamRun> = Vec::new();

    if let Some(project_path) = project_path {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json
                 FROM dream_runs
                 WHERE project_path = ?1
                 ORDER BY finished_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![project_path, normalized_limit])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json
                 FROM dream_runs
                 ORDER BY finished_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![normalized_limit])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    }

    Ok(runs)
}

pub fn enqueue_dream(
    conn: &Connection,
    project_path: &str,
    reason: &str,
) -> Result<i64, rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO dream_queue (project_path, reason, enqueued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![project_path, reason, now],
    )?;
    Ok(conn.last_insert_rowid())
}

// ── User Memory types ───────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct UserMemory {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub promoted_at: Option<i64>,
    pub source_candidate_ids: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct UserMemoryCandidate {
    pub id: i64,
    pub content: String,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub created_at: i64,
}

// ── User Memory queries ──────────────────────────────────────

pub fn get_user_memories(
    conn: &Connection,
    status_filter: Option<&str>,
) -> Result<Vec<UserMemory>, rusqlite::Error> {
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("status = ?{}", params.len()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at
         FROM user_memories
         {}
         ORDER BY created_at DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let source_candidate_ids: Option<String> = row.get(4)?;
        Ok(UserMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            status: row.get(2)?,
            promoted_at: row.get(3)?,
            source_candidate_ids: source_candidate_ids
                .as_deref()
                .map(|s| serde_json::from_str(s).ok())
                .flatten(),
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn get_user_memory_candidates(conn: &Connection) -> Result<Vec<UserMemoryCandidate>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, content, session_id, source_compartment_start, source_compartment_end, created_at
         FROM user_memory_candidates
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UserMemoryCandidate {
            id: row.get(0)?,
            content: row.get(1)?,
            session_id: row.get(2)?,
            source_compartment_start: row.get(3)?,
            source_compartment_end: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn dismiss_user_memory(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE user_memories SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )?;
    Ok(())
}

pub fn delete_user_memory(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM user_memories WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

pub fn delete_user_memory_candidate(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

pub fn promote_user_memory_candidate(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();

    // Read the candidate content
    let content: String = conn.query_row(
        "SELECT content FROM user_memory_candidates WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    )?;

    // Insert as a stable user memory
    conn.execute(
        "INSERT INTO user_memories (content, status, promoted_at, source_candidate_ids, created_at, updated_at) VALUES (?1, 'active', ?2, ?3, ?2, ?2)",
        rusqlite::params![content, now, format!("[{}]", id)],
    )?;

    // Delete the candidate
    conn.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        rusqlite::params![id],
    )?;

    Ok(())
}

// ── Database health ───────────────────────────────────────

pub fn get_db_health(db_path: &PathBuf) -> DbHealth {
    let exists = db_path.exists();
    let size_bytes: u64 = if exists {
        std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let wal_path = db_path.with_extension("db-wal");
    let wal_size_bytes: u64 = if wal_path.exists() {
        std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let mut table_counts = Vec::new();
    if exists {
        if let Ok(conn) = open_readonly(db_path) {
            let tables = [
                "memories",
                "compartments",
                "session_facts",
                "notes",
                "session_meta",
                "tags",
                "pending_ops",
                "dream_queue",
                "dream_state",
            ];
            for table in &tables {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
                    .unwrap_or(0);
                table_counts.push(TableCount {
                    table_name: table.to_string(),
                    row_count: count,
                });
            }
        }
    }

    DbHealth {
        exists,
        path: db_path.to_string_lossy().to_string(),
        size_bytes,
        wal_size_bytes,
        table_counts,
    }
}
