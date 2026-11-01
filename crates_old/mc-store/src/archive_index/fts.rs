//! Rowid-addressed archive FTS operations. The context bootstrap owns the FTS5
//! tokenizer and merge policy; this module never changes either configuration.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const MAX_FTS_BYTES: usize = 64 * 1024;
pub const MAX_BACKFILL_ROWS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FtsRow {
    pub ordinal: i64,
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at_ms: Option<i64>,
}

pub(crate) fn delete_message(db: &Connection, session: &str, id: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM message_history_fts WHERE rowid IN (
            SELECT map.fts_rowid FROM message_fts_rowid_map AS map
            JOIN message_history_source AS source
              ON source.session_id=map.session_id AND source.message_ordinal=map.message_ordinal
            WHERE source.session_id=?1 AND source.message_id=?2)",
        params![session, id],
    )?;
    db.execute(
        "DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal IN (
            SELECT message_ordinal FROM message_history_source WHERE session_id=?1 AND message_id=?2)",
        params![session, id],
    )?;
    Ok(())
}

pub(crate) fn delete_tail(db: &Connection, session: &str, floor: i64) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM message_history_fts WHERE rowid IN (
            SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal>=?2)",
        params![session, floor],
    )?;
    db.execute(
        "DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal>=?2",
        params![session, floor],
    )?;
    Ok(())
}

pub(crate) fn insert(db: &Connection, session: &str, row: &FtsRow) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content)
         VALUES (?1,?2,?3,?4,?5)",
        params![session, row.ordinal, row.id, row.role, row.content],
    )?;
    db.execute(
        "INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(session_id,message_ordinal) DO UPDATE SET
           fts_rowid=excluded.fts_rowid,
           message_time_ms=COALESCE(excluded.message_time_ms,message_fts_rowid_map.message_time_ms)",
        params![session, row.ordinal, db.last_insert_rowid(), row.created_at_ms],
    )?;
    Ok(())
}

/// The query must be an FTS5 expression. Content-only matching excludes role names.
/// Cutoff and inclusive timestamp bounds are applied before LIMIT.
pub fn search(
    db: &Connection,
    session: &str,
    query: &str,
    cutoff: i64,
    start_at_ms: Option<i64>,
    end_at_ms: Option<i64>,
    limit: usize,
) -> rusqlite::Result<Vec<FtsRow>> {
    let mut statement = db.prepare(
        "SELECT CAST(fts.message_ordinal AS INTEGER),fts.message_id,fts.role,fts.content,map.message_time_ms
         FROM message_history_fts AS fts
         JOIN message_fts_rowid_map AS map ON map.fts_rowid=fts.rowid
         WHERE fts.session_id=?1 AND message_history_fts MATCH ?2
           AND CAST(fts.message_ordinal AS INTEGER)<=?3
           AND (?4 IS NULL OR map.message_time_ms>=?4)
           AND (?5 IS NULL OR map.message_time_ms<=?5)
         ORDER BY bm25(message_history_fts),CAST(fts.message_ordinal AS INTEGER) ASC LIMIT ?6",
    )?;
    let rows = statement.query_map(
        params![
            session,
            format!("content : ({query})"),
            cutoff,
            start_at_ms,
            end_at_ms,
            limit as i64
        ],
        |row| {
            Ok(FtsRow {
                ordinal: row.get(0)?,
                id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at_ms: row.get(4)?,
            })
        },
    )?;
    rows.collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MapBackfillProgress {
    pub processed: usize,
    pub watermark_rowid: i64,
    pub completed: bool,
}

/// Resume a legacy rowid-map migration in at most 100 rows. Both the mappings
/// and their restart cursor are committed under the same writer lock.
pub fn backfill_rowid_map(
    db: &mut Connection,
    requested: usize,
    now: i64,
) -> rusqlite::Result<MapBackfillProgress> {
    let limit = requested.clamp(1, MAX_BACKFILL_ROWS);
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (mut watermark, completed): (i64, bool) = tx.query_row(
        "SELECT watermark_rowid,completed FROM message_fts_rowid_map_backfill_state WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if completed {
        return Ok(MapBackfillProgress {
            processed: 0,
            watermark_rowid: watermark,
            completed: true,
        });
    }
    let rows: Vec<(i64, String, i64)> = {
        let mut statement = tx.prepare(
            "SELECT rowid,session_id,CAST(message_ordinal AS INTEGER) FROM message_history_fts
             WHERE rowid>?1 ORDER BY rowid ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![watermark, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (rowid, session, ordinal) in &rows {
        tx.execute(
            "INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid)
             VALUES (?1,?2,?3) ON CONFLICT(session_id,message_ordinal) DO UPDATE SET fts_rowid=excluded.fts_rowid",
            params![session, ordinal, rowid],
        )?;
        watermark = *rowid;
    }
    let completed = rows.len() < limit;
    tx.execute(
        "UPDATE message_fts_rowid_map_backfill_state SET watermark_rowid=?1,completed=?2,updated_at=?3 WHERE id=1",
        params![watermark, completed, now],
    )?;
    tx.commit()?;
    Ok(MapBackfillProgress {
        processed: rows.len(),
        watermark_rowid: watermark,
        completed,
    })
}

/// A same-ID edit deletes the previous FTS document by mapped rowid. Wait for
/// legacy rowid backfill if that document cannot yet be addressed for deletion.
pub(crate) fn range_is_mapped(
    db: &Connection,
    session: &str,
    start: i64,
    end: i64,
) -> rusqlite::Result<bool> {
    if start > end {
        return Ok(true);
    }
    let completed: bool = db.query_row(
        "SELECT completed FROM message_fts_rowid_map_backfill_state WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    if completed {
        return Ok(true);
    }
    let (sources, expected, mapped): (i64, i64, i64) = db.query_row(
        "SELECT COUNT(DISTINCT source.message_ordinal),
         COUNT(DISTINCT CASE WHEN source.role IN ('user','assistant')
           AND source.normalized_content_hash<>?4 THEN source.message_ordinal END),
         COUNT(DISTINCT CASE WHEN source.role IN ('user','assistant')
           AND source.normalized_content_hash<>?4 AND map.fts_rowid IS NOT NULL
           THEN source.message_ordinal END)
         FROM message_history_source AS source LEFT JOIN message_fts_rowid_map AS map
         ON source.session_id=map.session_id AND source.message_ordinal=map.message_ordinal
         WHERE source.session_id=?1 AND source.message_ordinal BETWEEN ?2 AND ?3",
        params![
            session,
            start,
            end,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(sources == end - start + 1 && expected == mapped)
}
