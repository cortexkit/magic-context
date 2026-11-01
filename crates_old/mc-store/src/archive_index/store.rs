//! Host-neutral raw archive. The host supplies stable IDs and positive canonical
//! ordinals for historical pages; zero means append after the last durable ID.
//! Context-schema bootstrap must run before installing these archive-owned tables.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{fts, ordinals};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawMessage {
    pub id: String,
    pub role: String,
    pub parts: Vec<Value>,
    /// One-based position in the host's full raw history, not a partial page's
    /// position. Zero requests assignment after the last durable message identity.
    pub ordinal: i64,
    pub created_at: Option<i64>,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub version: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub watermark: i64,
    pub dirty_floor: Option<i64>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestReceipt {
    pub assigned: Vec<(String, i64)>,
    pub inserted: usize,
    pub progress: Progress,
}

/// A bounded batch is a partial observation, not permission to remove omitted IDs.
/// `revert_from` positively certifies removal of the complete suffix starting there.
pub struct IngestBatch<'a> {
    pub session_id: &'a str,
    pub source_revision: &'a str,
    pub messages: &'a [RawMessage],
    pub revert_from: Option<i64>,
    pub index_limit: usize,
    pub now_ms: i64,
    pub harness: &'a str,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS raw_archive_messages (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_ordinal INTEGER NOT NULL CHECK(message_ordinal > 0),
    message_json TEXT NOT NULL,
    PRIMARY KEY(session_id,message_id),
    UNIQUE(session_id,message_ordinal)
);
CREATE TABLE IF NOT EXISTS raw_archive_state (
    session_id TEXT PRIMARY KEY,
    source_revision TEXT NOT NULL
);
"#;

pub fn install(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(ordinals::SCHEMA)?;
    db.execute_batch(SCHEMA)
}

pub fn progress(db: &Connection, session: &str) -> rusqlite::Result<Progress> {
    let (watermark, dirty): (i64, i64) = db.query_row(
        "SELECT last_indexed_ordinal,dirty_floor_ordinal FROM message_history_index WHERE session_id=?1",
        [session], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?.unwrap_or((0, 0));
    let revision = db
        .query_row(
            "SELECT source_revision FROM raw_archive_state WHERE session_id=?1",
            [session],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default();
    Ok(Progress {
        watermark,
        dirty_floor: (dirty > 0).then_some(dirty),
        revision,
    })
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

pub fn read_by_id(
    db: &Connection,
    session: &str,
    id: &str,
) -> rusqlite::Result<Option<RawMessage>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT message_json FROM raw_archive_messages WHERE session_id=?1 AND message_id=?2",
            params![session, id],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(json_error))
        .transpose()
}

/// Read original parts, not the lossy FTS projection. An explicit byte limit errors
/// rather than silently claiming a truncated expansion is the original transcript.
pub fn read_range(
    db: &Connection,
    session: &str,
    start: i64,
    end: i64,
    max_bytes: usize,
) -> rusqlite::Result<Vec<RawMessage>> {
    let mut statement = db.prepare(
        "SELECT message_json FROM raw_archive_messages WHERE session_id=?1
         AND message_ordinal BETWEEN ?2 AND ?3 ORDER BY message_ordinal",
    )?;
    let rows = statement.query_map(params![session, start, end], |row| row.get::<_, String>(0))?;
    let mut remaining = max_bytes;
    let mut messages = Vec::new();
    for raw in rows {
        let raw = raw?;
        remaining = remaining
            .checked_sub(raw.len())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        messages.push(serde_json::from_str(&raw).map_err(json_error)?);
    }
    Ok(messages)
}

#[derive(Clone)]
struct Source {
    message: RawMessage,
    content: String,
    content_hash: String,
    version: String,
}

impl Source {
    fn new(message: &RawMessage) -> Self {
        let content = indexable_content(&message.role, &message.parts);
        let version = match &message.version {
            Value::String(value) => format!("string:{value}"),
            Value::Number(value) => {
                let number = value.as_f64().unwrap();
                let rendered = if number == 0.0 {
                    "0".to_owned()
                } else if number.abs() >= 1e21 || number.abs() < 1e-6 {
                    let scientific = format!("{number:e}");
                    let (digits, exponent) = scientific.split_once('e').unwrap();
                    let exponent: i32 = exponent.parse().unwrap();
                    format!(
                        "{digits}e{}{exponent}",
                        if exponent >= 0 { "+" } else { "" }
                    )
                } else {
                    number.to_string()
                };
                format!("number:{rendered}")
            }
            _ => "null".to_owned(),
        };
        Self {
            message: message.clone(),
            content_hash: format!("{:x}", Sha256::digest(content.as_bytes())),
            content,
            version,
        }
    }
}

fn skip_key(session: &str, id: &str) -> String {
    format!(
        "message_index_skip:{}",
        serde_json::to_string(&[session, id]).unwrap()
    )
}

fn source_is_current(db: &Connection, session: &str, source: &Source) -> rusqlite::Result<bool> {
    let stored: Option<(i64, String, String, String)> = db
        .query_row(
            "SELECT message_ordinal,source_version,normalized_content_hash,role
         FROM message_history_source WHERE session_id=?1 AND message_id=?2",
            params![session, source.message.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    Ok(stored
        == Some((
            source.message.ordinal,
            source.version.clone(),
            source.content_hash.clone(),
            source.message.role.clone(),
        )))
}

fn write_source(
    db: &Connection,
    batch: &IngestBatch<'_>,
    source: &Source,
) -> rusqlite::Result<bool> {
    let m = &source.message;
    db.execute(
        "INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,
         normalized_content_hash,role,harness,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(session_id,message_id) DO UPDATE SET message_ordinal=excluded.message_ordinal,
         source_version=excluded.source_version,normalized_content_hash=excluded.normalized_content_hash,
         role=excluded.role,harness=excluded.harness,updated_at=excluded.updated_at",
        params![batch.session_id, m.id, m.ordinal, source.version, source.content_hash, m.role, batch.harness, batch.now_ms],
    )?;
    let key = skip_key(batch.session_id, &m.id);
    if source.content.len() > fts::MAX_FTS_BYTES {
        let value = serde_json::json!({"reason":"oversized","bytes":source.content.len(),
            "contentHash":source.content_hash,"ordinal":m.ordinal,"complete":true})
        .to_string();
        db.execute(
            "INSERT INTO schema_migrations_meta(key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        return Ok(false);
    }
    db.execute("DELETE FROM schema_migrations_meta WHERE key=?1", [key])?;
    Ok(!source.content.is_empty() && matches!(m.role.as_str(), "user" | "assistant"))
}

fn publish_source(
    db: &Connection,
    batch: &IngestBatch<'_>,
    source: &Source,
) -> rusqlite::Result<bool> {
    if source_is_current(db, batch.session_id, source)? {
        db.execute(
            "UPDATE message_fts_rowid_map SET message_time_ms=COALESCE(?3,message_time_ms)
             WHERE session_id=?1 AND message_ordinal=?2",
            params![
                batch.session_id,
                source.message.ordinal,
                source.message.created_at
            ],
        )?;
        return Ok(false);
    }
    fts::delete_message(db, batch.session_id, &source.message.id)?;
    let indexable = write_source(db, batch, source)?;
    if indexable {
        fts::insert(
            db,
            batch.session_id,
            &fts::FtsRow {
                ordinal: source.message.ordinal,
                id: source.message.id.clone(),
                role: source.message.role.clone(),
                content: source.content.clone(),
                created_at_ms: source.message.created_at,
            },
        )?;
    }
    Ok(indexable)
}

fn revert(db: &Connection, session: &str, floor: i64, watermark: i64) -> rusqlite::Result<()> {
    if floor <= 0 || !fts::range_is_mapped(db, session, floor, watermark)? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let ids: Vec<String> = {
        let mut statement = db.prepare(
            "SELECT message_id FROM raw_archive_ordinals WHERE session_id=?1 AND message_ordinal>=?2",
        )?;
        let rows = statement.query_map(params![session, floor], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for id in ids {
        db.execute(
            "DELETE FROM schema_migrations_meta WHERE key=?1",
            [skip_key(session, &id)],
        )?;
    }
    fts::delete_tail(db, session, floor)?;
    db.execute(
        "DELETE FROM message_history_source WHERE session_id=?1 AND message_ordinal>=?2",
        params![session, floor],
    )?;
    db.execute(
        "DELETE FROM raw_archive_messages WHERE session_id=?1 AND message_ordinal>=?2",
        params![session, floor],
    )?;
    ordinals::truncate(db, session, floor)
}

/// Archive, identity map, FTS projection, progress and revision share one IMMEDIATE
/// transaction. A failed write or process crash cannot publish a half-ingested batch.
/// A later empty batch resumes queued source rows without rereading the host.
pub fn ingest(db: &mut Connection, batch: &IngestBatch<'_>) -> rusqlite::Result<IngestReceipt> {
    if batch.messages.len() > fts::MAX_BACKFILL_ROWS
        || batch.session_id.is_empty()
        || batch
            .messages
            .iter()
            .any(|m| m.id.is_empty() || m.ordinal < 0)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let prepared: Vec<Source> = batch.messages.iter().map(Source::new).collect();
    let limit = batch.index_limit.clamp(1, fts::MAX_BACKFILL_ROWS);
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let prior = progress(&tx, batch.session_id)?;
    let mut watermark = prior.watermark;
    if let Some(floor) = batch.revert_from {
        revert(&tx, batch.session_id, floor, watermark)?;
        watermark = watermark.min(floor - 1);
    }
    let mut assigned = Vec::new();
    let mut updates = BTreeMap::new();
    for mut source in prepared {
        source.message.ordinal = ordinals::assign(
            &tx,
            batch.session_id,
            &source.message.id,
            source.message.ordinal,
        )?;
        assigned.push((source.message.id.clone(), source.message.ordinal));
        tx.execute(
            "INSERT INTO raw_archive_messages(session_id,message_id,message_ordinal,message_json)
             VALUES (?1,?2,?3,?4) ON CONFLICT(session_id,message_id) DO UPDATE SET
             message_ordinal=excluded.message_ordinal,message_json=excluded.message_json",
            params![
                batch.session_id,
                source.message.id,
                source.message.ordinal,
                serde_json::to_string(&source.message).map_err(json_error)?
            ],
        )?;
        updates.insert(source.message.ordinal, source);
    }
    let mut inserted = 0;
    let mut deferred_floor: Option<i64> = None;
    for (ordinal, source) in updates.iter().filter(|(ordinal, _)| **ordinal <= watermark) {
        if source_is_current(&tx, batch.session_id, source)?
            || fts::range_is_mapped(&tx, batch.session_id, *ordinal, *ordinal)?
        {
            inserted += usize::from(publish_source(&tx, batch, source)?);
        } else {
            deferred_floor = Some(deferred_floor.map_or(*ordinal, |floor| floor.min(*ordinal)));
        }
    }
    // Retry edits whose old FTS documents could not be deleted before rowid
    // backfill supplied their addresses; the dirty floor persists across restarts.
    if let Some(floor) = prior.dirty_floor.filter(|floor| *floor <= watermark) {
        let end = watermark.min(floor.saturating_add(limit as i64 - 1));
        for ordinal in floor..=end {
            let raw: Option<String> = tx.query_row(
                "SELECT message_json FROM raw_archive_messages WHERE session_id=?1 AND message_ordinal=?2",
                params![batch.session_id, ordinal], |row| row.get(0),
            ).optional()?;
            if let Some(raw) = raw {
                let message = serde_json::from_str(&raw).map_err(json_error)?;
                if fts::range_is_mapped(&tx, batch.session_id, ordinal, ordinal)? {
                    inserted += usize::from(publish_source(&tx, batch, &Source::new(&message))?);
                } else {
                    deferred_floor = Some(deferred_floor.unwrap_or(ordinal));
                }
            }
        }
        if end < watermark {
            deferred_floor = Some(deferred_floor.unwrap_or(end + 1));
        }
    }
    let pending: Vec<String> = {
        let mut statement = tx.prepare(
            "SELECT message_json FROM raw_archive_messages WHERE session_id=?1 AND message_ordinal>?2
             ORDER BY message_ordinal LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![batch.session_id, watermark, limit as i64], |row| {
                row.get(0)
            })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for raw in pending {
        let message: RawMessage = serde_json::from_str(&raw).map_err(json_error)?;
        if message.ordinal != watermark + 1 {
            break;
        }
        inserted += usize::from(publish_source(&tx, batch, &Source::new(&message))?);
        watermark += 1;
    }
    let last = ordinals::last_assigned(&tx, batch.session_id)?;
    let missing_floor = (watermark < last).then_some(watermark + 1);
    let dirty_floor = match (deferred_floor, missing_floor) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    tx.execute(
        "INSERT INTO message_history_index(session_id,last_indexed_ordinal,dirty_floor_ordinal,updated_at,harness)
         VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET
         last_indexed_ordinal=excluded.last_indexed_ordinal,dirty_floor_ordinal=excluded.dirty_floor_ordinal,
         updated_at=excluded.updated_at",
        params![batch.session_id, watermark, dirty_floor.unwrap_or(0), batch.now_ms, batch.harness],
    )?;
    tx.execute(
        "INSERT INTO raw_archive_state(session_id,source_revision) VALUES (?1,?2)
         ON CONFLICT(session_id) DO UPDATE SET source_revision=excluded.source_revision",
        params![batch.session_id, batch.source_revision],
    )?;
    let result = IngestReceipt {
        assigned,
        inserted,
        progress: Progress {
            watermark,
            dirty_floor,
            revision: batch.source_revision.to_owned(),
        },
    };
    tx.commit()?;
    Ok(result)
}

const INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";

// ECMAScript's whitespace set differs from Rust's at BOM and NEXT LINE.
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn reminders_removed(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut result = String::new();
    let mut cursor = 0;
    let mut search = 0;
    let mut depth: usize = 0;
    // Match TypeScript's nested-block scanner: an unclosed reminder hides its
    // entire remaining body, and unmatched closing tags are removed as well.
    while let Some(start) = lower[search..].find('<') {
        let start = search + start;
        search = start + 1;
        let closing = lower[search..].starts_with('/');
        let name_start = search + usize::from(closing);
        if !lower[name_start..].starts_with("system-reminder") {
            continue;
        }
        let name_end = name_start + "system-reminder".len();
        let Some(end) = lower[name_end..].find('>') else {
            break;
        };
        let end = name_end + end;
        let suffix = &text[name_end..end];
        if suffix.contains('<')
            || !(suffix.is_empty() || suffix == "/" || suffix.chars().next().is_some_and(js_space))
        {
            continue;
        }
        if depth == 0 {
            result.push_str(&text[cursor..start]);
        }
        if closing {
            depth = depth.saturating_sub(1);
        } else if !suffix.ends_with('/') {
            depth += 1;
        }
        cursor = end + 1;
        search = cursor;
    }
    if depth == 0 {
        result.push_str(&text[cursor..]);
    }
    trim(&result).to_owned()
}

fn clean_user_segment(text: &str) -> String {
    trim(&reminders_removed(text).replacen(INITIATOR_MARKER, "", 1)).to_owned()
}

fn clean_user(text: &str) -> String {
    const START: &str = "<system-reminder>\nThe user sent the following message:\n";
    const END: &str =
        "\n\nPlease address this message and continue with your tasks.\n</system-reminder>";
    let mut result = String::new();
    let mut cursor = 0;
    while let Some(start) = text[cursor..].find(START) {
        let start = cursor + start;
        let body = start + START.len();
        let Some(end) = text[body..].find(END) else {
            break;
        };
        let end = body + end + END.len();
        result.push_str(&reminders_removed(&text[cursor..start]).replacen(INITIATOR_MARKER, "", 1));
        result.push_str(&text[start..end]);
        cursor = end;
    }
    result.push_str(&reminders_removed(&text[cursor..]).replacen(INITIATOR_MARKER, "", 1));
    result
}

/// Preserve the search corpus of packages/plugin's message-index.ts: normalize
/// user/assistant text and omit injected reminders. Raw parts are stored separately
/// so ignored text, reasoning, media, tool inputs and outputs remain expandable.
pub fn indexable_content(role: &str, parts: &[Value]) -> String {
    fn text_of(part: &Value) -> Option<&str> {
        if part.get("type")?.as_str()? != "text" {
            return None;
        }
        part.get("text")?.as_str()
    }
    if role == "user" {
        let meaningful = parts.iter().any(|part| {
            if part.get("ignored") == Some(&Value::Bool(true)) {
                return false;
            }
            let Some(text) = text_of(part) else {
                return false;
            };
            let cleaned = clean_user_segment(text);
            !cleaned.is_empty() && !cleaned.starts_with("[SYSTEM DIRECTIVE: MAGIC-CONTEXT")
        });
        if !meaningful {
            return String::new();
        }
    } else if role != "assistant" {
        return String::new();
    }
    parts
        .iter()
        .filter_map(text_of)
        .map(trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            if role == "user" {
                clean_user(text)
            } else {
                reminders_removed(text)
            }
        })
        .map(|text| {
            text.split(js_space)
                .filter(|piece| !piece.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}
