//! The production session source for the Rust retrospective: the module's own raw
//! message archive (`raw_archive_messages`, written by `mc_store::archive_index`) and
//! the context-store rows that map a session to its project.
//!
//! It mirrors the TypeScript OpenCode provider
//! (`packages/plugin/src/features/magic-context/dreamer/retrospective-raw-provider.ts`)
//! and the window rules `readRetrospectiveScanWindow` applies before calling it:
//!
//! - sessions: `listProjectSessions` (lines 122-147): `session_projects` rows of the
//!   project and harness, joined to their `retrospective_activity:<session>` time,
//!   skipping `session_meta.is_subagent` sessions, ordered by activity then id;
//! - frontier: `scanSinceMs = max(watermark, recencyCutoff - 1)` (line 270); a
//!   session is eligible when its activity is newer (line 277); the oldest pending
//!   message time orders the bounded scan (`readOldestMessageTimesSince`, 478-502);
//! - reads: the 80 oldest messages after the frontier, one more to detect
//!   truncation (`readOpenCodeMessagesSince`, 451-476), and up to 12 prior user
//!   lines from a 60-row window at or before the watermark
//!   (`readOpenCodeUserMessagesBefore`, 511-531);
//! - rows: genuine non-synthetic user text and tool metadata only, never assistant
//!   text or tool output (`normalizeOpenCodeMessage`, 626-696).
//!
//! The module never opens a host's own database. Where the archive tables are
//! absent (no ingestion has installed them), the reader reports no sessions.

use std::sync::{Arc, OnceLock};

use mc_store::McStore;
use regex::Regex;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::retrospective_host::SessionReader;
use crate::dream_tasks::retrospective::{Message, ScanOptions, SessionRead};

/// Source messages read per session and run; the TypeScript provider's
/// `RETROSPECTIVE_MAX_MESSAGES_PER_SESSION`.
pub const MAX_MESSAGES_PER_SESSION: usize = 80;
/// Sessions read per run, oldest pending first; the TypeScript provider's
/// `RETROSPECTIVE_MAX_SESSIONS_PER_RUN`.
pub const MAX_SESSIONS_PER_RUN: usize = 20;
/// Prior user lines re-read from before the watermark, so friction spanning two
/// runs is seen; `RETROSPECTIVE_OVERLAP_USER_LINES` in task-executor.ts.
pub const OVERLAP_USER_LINES: usize = 12;

const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";
const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

/// Reads one project's sessions from the archive for a retrospective run.
pub struct ArchiveSessionReader {
    pub store: Arc<McStore>,
    /// The `session_projects.harness` the TypeScript provider of this host reads.
    pub harness: String,
    /// The oldest message time still eligible; older messages expire unread.
    pub recency_cutoff_ms: Option<i64>,
}

impl SessionReader for ArchiveSessionReader {
    fn read_sessions(&self, project: &str, watermark_ms: i64) -> Result<Vec<SessionRead>, String> {
        let since = watermark_ms.max(
            self.recency_cutoff_ms
                .map_or(i64::MIN, |cutoff| cutoff.saturating_sub(1)),
        );
        let overlap = watermark_ms > 0
            && self
                .recency_cutoff_ms
                .is_none_or(|cutoff| watermark_ms >= cutoff);
        self.store
            .with_context_read(|db| {
                read_sessions(
                    db,
                    project,
                    &self.harness,
                    since,
                    overlap.then_some(watermark_ms),
                )
            })
            .map_err(|e| e.to_string())
    }
}

fn table_exists(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}

fn read_sessions(
    db: &Connection,
    project: &str,
    harness: &str,
    since: i64,
    overlap_before: Option<i64>,
) -> rusqlite::Result<Vec<SessionRead>> {
    if !table_exists(db, "raw_archive_messages")? {
        return Ok(Vec::new());
    }
    let listed: Vec<(String, Option<i64>)> = db
        .prepare(
            "SELECT sp.session_id, CAST(activity.value AS INTEGER) AS updated_at
               FROM session_projects sp
               JOIN schema_migrations_meta activity
                 ON activity.key = 'retrospective_activity:' || sp.session_id
               LEFT JOIN session_meta m ON m.session_id = sp.session_id
              WHERE sp.project_path = ?1 AND sp.harness = ?2
                AND COALESCE(m.is_subagent, 0) = 0
              ORDER BY updated_at ASC, sp.session_id ASC",
        )?
        .query_map(params![project, harness], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let eligible: Vec<_> = listed
        .into_iter()
        .filter(|(_, updated)| updated.unwrap_or(i64::MAX) > since)
        .collect();
    let mut sessions = Vec::with_capacity(eligible.len());
    for (session_id, updated_at) in &eligible {
        let oldest: Option<i64> = db.query_row(
            "SELECT MIN(json_extract(message_json,'$.createdAt')) FROM raw_archive_messages
              WHERE session_id=?1 AND json_extract(message_json,'$.createdAt') > ?2",
            params![session_id, since],
            |r| r.get(0),
        )?;
        sessions.push(SessionRead {
            project_path: project.to_owned(),
            session_id: session_id.clone(),
            updated_at: *updated_at,
            oldest_pending_ts: oldest,
            messages: Vec::new(),
            truncated: false,
            overlap: Vec::new(),
        });
    }
    // Only the sessions the bounded scan will select are read: those with pending
    // messages, oldest pending first, ties in listing order (a stable sort).
    let mut order: Vec<usize> = (0..sessions.len())
        .filter(|i| sessions[*i].oldest_pending_ts.is_some())
        .collect();
    order.sort_by_key(|i| sessions[*i].oldest_pending_ts);
    for index in order.into_iter().take(MAX_SESSIONS_PER_RUN) {
        let session = &mut sessions[index];
        let (messages, truncated) = read_since(db, &session.session_id, since)?;
        session.messages = messages;
        session.truncated = truncated;
        if let Some(before) = overlap_before {
            session.overlap = read_user_before(db, &session.session_id, before)?;
        }
    }
    Ok(sessions)
}

struct Row {
    role: String,
    parts: Vec<Value>,
    ts: i64,
}

fn rows(
    db: &Connection,
    sql: &str,
    session: &str,
    bound: i64,
    limit: usize,
) -> rusqlite::Result<Vec<Row>> {
    db.prepare(sql)?
        .query_map(params![session, bound, limit as i64], |r| {
            let raw: String = r.get(0)?;
            let ts: i64 = r.get(1)?;
            let value: Value = serde_json::from_str(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(Row {
                role: value["role"].as_str().unwrap_or("unknown").to_owned(),
                parts: value["parts"].as_array().cloned().unwrap_or_default(),
                ts,
            })
        })?
        .collect()
}

/// The oldest messages after `since`, plus whether more were left unread.
fn read_since(
    db: &Connection,
    session: &str,
    since: i64,
) -> rusqlite::Result<(Vec<Message>, bool)> {
    let mut read = rows(
        db,
        "SELECT message_json, json_extract(message_json,'$.createdAt') AS ts FROM raw_archive_messages
          WHERE session_id=?1 AND ts > ?2 ORDER BY ts ASC, message_id ASC LIMIT ?3",
        session,
        since,
        MAX_MESSAGES_PER_SESSION + 1,
    )?;
    let truncated = read.len() > MAX_MESSAGES_PER_SESSION;
    read.truncate(MAX_MESSAGES_PER_SESSION);
    Ok((normalize(session, &read), truncated))
}

/// The newest user lines at or before `before`, read from a bounded window of
/// mixed rows.
fn read_user_before(db: &Connection, session: &str, before: i64) -> rusqlite::Result<Vec<Message>> {
    let window = (OVERLAP_USER_LINES * 5).max(32);
    let mut read = rows(
        db,
        "SELECT message_json, json_extract(message_json,'$.createdAt') AS ts FROM raw_archive_messages
          WHERE session_id=?1 AND ts <= ?2 ORDER BY ts DESC, message_id DESC LIMIT ?3",
        session,
        before,
        window,
    )?;
    read.reverse();
    let users: Vec<_> = normalize(session, &read)
        .into_iter()
        .filter(|m| m.role == "user")
        .collect();
    let skip = users.len().saturating_sub(OVERLAP_USER_LINES);
    Ok(users.into_iter().skip(skip).collect())
}

/// Turn archived messages into retrospective rows; `ordinal` is the message's
/// one-based position in this read, shared by all rows it produces.
fn normalize(session: &str, read: &[Row]) -> Vec<Message> {
    let mut out = Vec::new();
    for (index, row) in read.iter().enumerate() {
        let ordinal = index + 1;
        if row.role == "user" {
            let text = genuine_user_text(&row.parts);
            if !text.is_empty() {
                out.push(Message {
                    session_id: session.to_owned(),
                    ordinal,
                    role: "user".into(),
                    text,
                    tool_name: None,
                    ts: row.ts,
                });
            }
        }
        for part in &row.parts {
            if part.get("type").and_then(Value::as_str) != Some("tool") {
                continue;
            }
            let Some(tool) = part.get("tool").and_then(Value::as_str) else {
                continue;
            };
            out.push(Message {
                session_id: session.to_owned(),
                ordinal,
                role: "tool".into(),
                text: String::new(),
                tool_name: Some(tool.to_owned()),
                ts: row.ts,
            });
        }
    }
    out
}

/// `extractGenuineUserText`: the text parts that are neither synthetic nor ignored,
/// each cleaned of injected reminders, when the message has meaningful text at all.
fn genuine_user_text(parts: &[Value]) -> String {
    // Non-object parts are kept, as the TypeScript filter keeps them.
    let kept: Vec<&Value> = parts
        .iter()
        .filter(|p| !p.is_object() || p.get("synthetic") != Some(&Value::Bool(true)))
        .collect();
    if !has_meaningful_user_text(&kept) {
        return String::new();
    }
    let texts: Vec<String> = kept
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter(|p| {
            p.get("ignored") != Some(&Value::Bool(true))
                && p.get("synthetic") != Some(&Value::Bool(true))
        })
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .map(js_trim)
        .filter(|t| !t.is_empty())
        .map(clean_user_text)
        .filter(|t| !t.is_empty())
        .collect();
    js_trim(&texts.join("\n")).to_owned()
}

/// `hasMeaningfulUserText` (read-session-formatting.ts).
fn has_meaningful_user_text(parts: &[&Value]) -> bool {
    parts.iter().any(|part| {
        if part.get("type").and_then(Value::as_str) != Some("text")
            || part.get("ignored") == Some(&Value::Bool(true))
        {
            return false;
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            return false;
        };
        let removed = reminder_regex().replace_all(text, "");
        let cleaned =
            js_trim(&js_trim(&removed).replacen(OMO_INTERNAL_INITIATOR_MARKER, "", 1)).to_owned();
        !cleaned.is_empty()
            && !cleaned
                .trim_start_matches(js_space)
                .starts_with(SYSTEM_DIRECTIVE_PREFIX)
    })
}

/// `cleanUserText` (read-session-chunk.ts): strip reminders and the initiator
/// marker outside the steering wrappers, which are kept verbatim.
fn clean_user_text(text: &str) -> String {
    let strip = |segment: &str| {
        reminder_regex()
            .replace_all(segment, "")
            .replacen(OMO_INTERNAL_INITIATOR_MARKER, "", 1)
    };
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    for wrapper in crate::transform::steering_wrapper_regex().find_iter(text) {
        result.push_str(&strip(&text[cursor..wrapper.start()]));
        result.push_str(wrapper.as_str());
        cursor = wrapper.end();
    }
    result.push_str(&strip(&text[cursor..]));
    js_trim(&result).to_owned()
}

fn reminder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<system-reminder>.*?</system-reminder>").unwrap())
}

/// ECMAScript's `String.prototype.trim` whitespace set, which differs from
/// Rust's at the byte-order mark and NEXT LINE.
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// What one retrospective run reads with: the reader, the scan bounds and whether
/// observations about the user are collected. Mirrors `runRetrospectiveTask` in
/// task-executor.ts: the recency cutoff is `max(1, floor(recency_days ?? 30))`
/// days before the run started, and observations are collected only while
/// review-user-memories has a schedule (task-config.ts
/// `userMemoryCollectionEnabled`).
pub fn retrospective_inputs(
    store: Arc<McStore>,
    settings: &Value,
    harness: &str,
    started_at_ms: i64,
) -> (ArchiveSessionReader, ScanOptions, bool) {
    let days = settings
        .pointer("/dreamer/tasks/retrospective/recency_days")
        .and_then(Value::as_f64)
        .map_or(30, |d| d.floor().max(1.0) as i64);
    let cutoff = started_at_ms - days * crate::dream_tasks::primers::DAY_MS;
    let collection = settings
        .pointer("/dreamer/tasks/review-user-memories/schedule")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let reader = ArchiveSessionReader {
        store,
        harness: harness.to_owned(),
        recency_cutoff_ms: Some(cutoff),
    };
    let options = ScanOptions {
        watermark_ms: 0,
        recency_cutoff_ms: Some(cutoff),
        max_messages: MAX_MESSAGES_PER_RUN,
        max_sessions: MAX_SESSIONS_PER_RUN,
        // The TypeScript dreamer admits against the smallest catalog window of
        // the configured models and falls back to 128K tokens; the module has no
        // model catalog, so it always uses that fallback.
        usable_input_tokens: Some(DEFAULT_USABLE_INPUT_TOKENS),
        indexed_oldest: true,
    };
    (reader, options, collection)
}

/// Messages admitted into one run's window across all sessions; the TypeScript
/// provider's `RETROSPECTIVE_MAX_MESSAGES_PER_RUN`.
pub const MAX_MESSAGES_PER_RUN: usize = 240;
/// The model input budget the window is admitted against when no model catalog
/// entry is known; `RETROSPECTIVE_DEFAULT_USABLE_INPUT_TOKENS` in task-executor.ts.
pub const DEFAULT_USABLE_INPUT_TOKENS: usize = 128_000;

/// The archive's own tables, as `mc_store::archive_index` store.rs installs them,
/// for tests that seed archived history.
#[cfg(test)]
pub(crate) fn install_archive_for_test(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS raw_archive_messages (
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            message_ordinal INTEGER NOT NULL CHECK(message_ordinal > 0),
            message_json TEXT NOT NULL,
            PRIMARY KEY(session_id,message_id),
            UNIQUE(session_id,message_ordinal)
        );",
    )
}

/// Store one archived message (`{id, role, parts, ordinal, createdAt, ...}`).
#[cfg(test)]
pub(crate) fn archive_for_test(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    message: &Value,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO raw_archive_messages(session_id,message_id,message_ordinal,message_json) VALUES (?1,?2,?3,?4)",
        params![session, message["id"].as_str(), message["ordinal"].as_i64(), message.to_string()],
    )?;
    Ok(())
}
