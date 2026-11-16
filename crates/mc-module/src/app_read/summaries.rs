//! A session's summaries, as the app reads need them.
//!
//! The replica holds only an index of a session's summaries: their ids and
//! ordinals, read from `context.db`, and the times it found for their first
//! and last message. A read that shows a summary's body reads that one row
//! from `context.db` and renders its JSON on the spot. The bodies are most of
//! a long session's memory, and no prompt is made from these reads.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use cortexkit_role_compaction::read::SessionRef;

/// One summary of a session: what places it among the session's messages,
/// and when its first and last message were written, as far as the replica
/// knows. Those times are the `first_at_ms` and `last_at_ms` of the
/// summary's JSON; the replica fills them in, `context.db` doesn't hold them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Summary {
    pub sequence: i64,
    pub first_message_id: Box<str>,
    pub last_message_id: Box<str>,
    pub first_message_ordinal: i64,
    pub last_message_ordinal: i64,
    /// The first message's time, then the last message's.
    pub at_ms: [Option<u64>; 2],
}

impl Summary {
    /// The id the apps name the summary by.
    pub(crate) fn id(&self) -> String {
        self.sequence.to_string()
    }

    /// The first message's id, then the last message's, each with its
    /// ordinal.
    pub(crate) fn boundaries(&self) -> [(&str, i64); 2] {
        [
            (&self.first_message_id, self.first_message_ordinal),
            (&self.last_message_id, self.last_message_ordinal),
        ]
    }

    /// Whether the summary covers the message at `ordinal`. An ordinal
    /// below zero bounds nothing: the summary covers no message.
    pub(crate) fn covers(&self, ordinal: u64) -> bool {
        u64::try_from(self.first_message_ordinal).unwrap_or(u64::MAX) <= ordinal
            && u64::try_from(self.last_message_ordinal).unwrap_or(0) >= ordinal
    }
}

/// A session's summaries, oldest first, by their ids and ordinals.
pub(crate) fn read_index(conn: &Connection, key: &SessionRef) -> rusqlite::Result<Vec<Summary>> {
    conn.prepare_cached(
        "SELECT sequence, start_message, end_message, COALESCE(start_message_id, ''),
                COALESCE(end_message_id, '')
           FROM compartments
          WHERE session_id = ?1 AND harness = ?2
          ORDER BY sequence",
    )?
    .query_map(params![key.session, key.harness], |row| {
        Ok(Summary {
            sequence: row.get(0)?,
            first_message_ordinal: row.get(1)?,
            last_message_ordinal: row.get(2)?,
            first_message_id: row.get::<_, String>(3)?.into(),
            last_message_id: row.get::<_, String>(4)?.into(),
            at_ms: [None; 2],
        })
    })?
    .collect()
}

/// A summary's row as `context.db` stores it, read as the session reads its
/// summaries (`ContextDb::read_compartments`).
pub(crate) struct Body {
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub importance: i32,
    pub episode_type: Option<String>,
    pub legacy: i32,
    pub created_at: i64,
}

const BODY_COLUMNS: &str = "sequence, start_message, end_message, COALESCE(start_message_id, ''),
    COALESCE(end_message_id, ''), title, content, p1, p2, p3, p4, importance, episode_type,
    legacy, created_at";

fn body(row: &rusqlite::Row<'_>) -> rusqlite::Result<Body> {
    Ok(Body {
        sequence: row.get(0)?,
        start_message: row.get(1)?,
        end_message: row.get(2)?,
        start_message_id: row.get(3)?,
        end_message_id: row.get(4)?,
        title: row.get(5)?,
        content: row.get(6)?,
        p1: row.get(7)?,
        p2: row.get(8)?,
        p3: row.get(9)?,
        p4: row.get(10)?,
        importance: row.get(11)?,
        episode_type: row.get(12)?,
        legacy: row.get(13)?,
        created_at: row.get(14)?,
    })
}

/// The session's summary with this sequence number, if `context.db` holds
/// it.
pub(crate) fn read_body(
    conn: &Connection,
    key: &SessionRef,
    sequence: i64,
) -> rusqlite::Result<Option<Body>> {
    conn.prepare_cached(&format!(
        "SELECT {BODY_COLUMNS} FROM compartments
          WHERE session_id = ?1 AND harness = ?2 AND sequence = ?3"
    ))?
    .query_row(params![key.session, key.harness, sequence], body)
    .optional()
}

/// The JSON the apps read for a summary (`context.compartment`), with its
/// first and last message times.
pub(crate) fn render(c: &Body, at_ms: [Option<u64>; 2]) -> Value {
    json!({"compartment_id":c.sequence.to_string(), "ordinal":c.sequence, "title":c.title, "first_message_id":c.start_message_id, "last_message_id":c.end_message_id, "first_message_ordinal":c.start_message, "last_message_ordinal":c.end_message, "first_at_ms":at_ms[0], "last_at_ms":at_ms[1], "message_count":(c.end_message-c.start_message+1).max(0), "importance":c.importance, "summary_markdown":c.content, "summary_markdown_bytes":c.content.len(), "summary_markdown_truncated":false, "tiers":{"p1":c.p1, "p2":c.p2, "p3":c.p3, "p4":c.p4}, "tiers_bytes":{"p1":c.p1.as_ref().map(String::len), "p2":c.p2.as_ref().map(String::len), "p3":c.p3.as_ref().map(String::len), "p4":c.p4.as_ref().map(String::len)}, "tiers_truncated":{"p1":false,"p2":false,"p3":false,"p4":false}, "created_at_ms":c.created_at, "legacy":c.legacy!=0, "episode_type":c.episode_type, "facts":{"attribution":"historian_run", "by_category":{}, "session_facts_cursor":null}})
}

/// The identity of a message search over the session: the version of
/// `[key, query, newest, summaries]`, with each of the session's summaries
/// as the JSON `context.compartment` reads. The summaries are read from
/// `context.db` and hashed one at a time, so a long session's summaries are
/// never all held at once.
pub(crate) fn search_identity(
    conn: &Connection,
    key: &SessionRef,
    query: &str,
    newest: u64,
    index: &[Summary],
) -> rusqlite::Result<String> {
    let mut hash = Sha256::new();
    let json = |value: &Value| serde_json::to_vec(value).expect("JSON");
    hash.update(b"[");
    hash.update(json(&json!(key)));
    hash.update(b",");
    hash.update(json(&json!(query)));
    hash.update(b",");
    hash.update(json(&json!(newest)));
    hash.update(b",[");
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {BODY_COLUMNS} FROM compartments
          WHERE session_id = ?1 AND harness = ?2 ORDER BY sequence"
    ))?;
    let mut rows = statement.query(params![key.session, key.harness])?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        let body = body(row)?;
        let at_ms = index
            .binary_search_by_key(&body.sequence, |summary| summary.sequence)
            .map_or([None; 2], |at| index[at].at_ms);
        if !first {
            hash.update(b",");
        }
        first = false;
        hash.update(json(&render(&body, at_ms)));
    }
    hash.update(b"]]");
    Ok(format!("mca1:{:x}", hash.finalize()))
}
