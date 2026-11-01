//! Durable positive raw ordinals. Request order is not transcript identity.

use rusqlite::{params, Connection, OptionalExtension};

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS raw_archive_ordinals (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_ordinal INTEGER NOT NULL CHECK(message_ordinal > 0),
    PRIMARY KEY(session_id, message_id),
    UNIQUE(session_id, message_ordinal)
);
"#;

pub fn ordinal_for_id(
    db: &Connection,
    session_id: &str,
    message_id: &str,
) -> rusqlite::Result<Option<i64>> {
    db.query_row(
        "SELECT message_ordinal FROM raw_archive_ordinals WHERE session_id=?1 AND message_id=?2",
        params![session_id, message_id],
        |row| row.get(0),
    )
    .optional()
}

pub fn last_assigned(db: &Connection, session_id: &str) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT COALESCE(MAX(message_ordinal),0) FROM (
            SELECT message_ordinal FROM raw_archive_ordinals WHERE session_id=?1
            UNION ALL SELECT message_ordinal FROM message_history_source WHERE session_id=?1)",
        [session_id],
        |row| row.get(0),
    )
}

/// Zero requests an append. A positive ordinal is the one-based position in the
/// host's complete raw history, even when only one page of that history is supplied.
/// SQLite rejects collisions rather than guessing an anchor. An already-known ID
/// keeps its ordinal in reordered or incomplete requests so search still expands
/// the same message.
pub(crate) fn assign(
    db: &Connection,
    session_id: &str,
    message_id: &str,
    supplied: i64,
) -> rusqlite::Result<i64> {
    if let Some(ordinal) = ordinal_for_id(db, session_id, message_id)? {
        return Ok(ordinal);
    }
    let legacy: Option<i64> = db.query_row(
        "SELECT message_ordinal FROM message_history_source WHERE session_id=?1 AND message_id=?2",
        params![session_id, message_id], |row| row.get(0),
    ).optional()?;
    let ordinal = if let Some(ordinal) = legacy {
        ordinal
    } else if supplied > 0 {
        supplied
    } else {
        last_assigned(db, session_id)?
            .checked_add(1)
            .ok_or(rusqlite::Error::InvalidQuery)?
    };
    db.execute(
        "INSERT INTO raw_archive_ordinals(session_id,message_id,message_ordinal) VALUES (?1,?2,?3)",
        params![session_id, message_id, ordinal],
    )?;
    Ok(ordinal)
}

/// Only an explicit host revert may forget identities. Merely missing IDs in a
/// partial request must never call this function.
pub(crate) fn truncate(
    db: &Connection,
    session_id: &str,
    first_removed: i64,
) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM raw_archive_ordinals WHERE session_id=?1 AND message_ordinal>=?2",
        params![session_id, first_removed],
    )?;
    Ok(())
}
