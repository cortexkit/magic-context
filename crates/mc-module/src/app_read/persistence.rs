//! Row-oriented checkpoints. Encode outside the transaction so unchanged rows
//! neither need cloning nor extend the store's write lock.
//!
//! A message row is saved in [`Row::encode`]'s compact form. A session's
//! summaries are not saved here: the replica reads them from `context.db`.
use super::row::Row;
use super::{Breakdown, Header, Message, SessionRef, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_read_headers (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    header TEXT NOT NULL, PRIMARY KEY(runner,harness,session)
);
CREATE TABLE IF NOT EXISTS app_read_messages (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    row BLOB NOT NULL, PRIMARY KEY(runner,harness,session,message_id)
);";

pub(crate) struct Checkpoint {
    header: String,
    messages: Vec<(String, u64, u64, Vec<u8>)>,
    removed: Vec<String>,
    reset: bool,
}

impl Checkpoint {
    pub(crate) fn new<'a>(
        header: &Header,
        messages: impl Iterator<Item = (&'a str, &'a Message)>,
        removed: impl Iterator<Item = &'a str>,
        reset: bool,
    ) -> Self {
        Self {
            header: header.json(),
            messages: messages
                .map(|(mid, m)| (mid.to_owned(), m.ordinal, m.at_ms, m.row.encode()))
                .collect(),
            removed: removed.map(str::to_owned).collect(),
            reset,
        }
    }

    #[cfg(test)]
    pub(crate) fn full(s: &Snapshot) -> Self {
        Self::new(
            &Header {
                base: s.base,
                newest: s.newest,
                ready: s.ready,
                meta: s.meta.clone(),
                breakdown: s.breakdown.clone(),
            },
            s.messages.iter().map(|(mid, m)| (mid.as_str(), m.as_ref())),
            std::iter::empty(),
            true,
        )
    }

    // The caller owns the transaction, including schema migration. Reusing the
    // same statements keeps even a first checkpoint's large insert bounded.
    pub(crate) fn write(&self, conn: &Connection, key: &SessionRef) -> rusqlite::Result<()> {
        conn.execute("INSERT INTO app_read_headers VALUES(?1,?2,?3,?4) ON CONFLICT(runner,harness,session) DO UPDATE SET header=excluded.header", params![key.runner,key.harness,key.session,self.header])?;
        if self.reset {
            conn.execute(
                "DELETE FROM app_read_messages WHERE runner=?1 AND harness=?2 AND session=?3",
                params![key.runner, key.harness, key.session],
            )?;
        } else {
            let mut delete = conn.prepare_cached("DELETE FROM app_read_messages WHERE runner=?1 AND harness=?2 AND session=?3 AND message_id=?4")?;
            for mid in &self.removed {
                delete.execute(params![key.runner, key.harness, key.session, mid])?;
            }
        }
        let mut insert = conn.prepare_cached("INSERT INTO app_read_messages VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(runner,harness,session,message_id) DO UPDATE SET ordinal=excluded.ordinal,at_ms=excluded.at_ms,row=excluded.row")?;
        for (mid, ordinal, at_ms, row) in &self.messages {
            insert.execute(params![
                key.runner,
                key.harness,
                key.session,
                mid,
                ordinal,
                at_ms,
                row
            ])?;
        }
        Ok(())
    }
}

/// A session's projection as versions before 5 saved it, whole, in
/// `app_read_snapshots`. Its summaries, which it also held, are not read:
/// the replica reads them from `context.db`.
#[derive(Deserialize)]
struct LegacySnapshot {
    base: u64,
    newest: u64,
    ready: bool,
    meta: Value,
    breakdown: Breakdown,
    messages: BTreeMap<String, LegacyMessage>,
    decisions: Vec<Value>,
}

#[derive(Deserialize)]
struct LegacyMessage {
    ordinal: u64,
    at_ms: u64,
    row: Value,
}

pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT runner,harness,session,snapshot FROM app_read_snapshots")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                SessionRef::new(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ),
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, text) = row.map_err(|e| e.to_string())?;
        match serde_json::from_str::<LegacySnapshot>(&text) {
            Ok(legacy) => {
                let messages: Vec<(String, Message)> = legacy
                    .messages
                    .into_iter()
                    .map(|(mid, m)| {
                        let row = Row::from_json(&mid, m.row);
                        (
                            mid,
                            Message {
                                ordinal: m.ordinal,
                                at_ms: m.at_ms,
                                row,
                            },
                        )
                    })
                    .collect();
                Checkpoint::new(
                    &Header {
                        base: legacy.base,
                        newest: legacy.newest,
                        ready: legacy.ready,
                        meta: legacy.meta,
                        breakdown: legacy.breakdown,
                    },
                    messages.iter().map(|(mid, m)| (mid.as_str(), m)),
                    std::iter::empty(),
                    true,
                )
                .write(conn, &key)
                .map_err(|e| e.to_string())?;
                // A separately saved decision list is newer than the checkpoint.
                conn.execute("INSERT INTO app_read_decisions VALUES(?1,?2,?3,?4) ON CONFLICT(runner,harness,session) DO NOTHING", params![key.runner,key.harness,key.session,serde_json::to_string(&legacy.decisions).expect("decision JSON")]).map_err(|e|e.to_string())?;
            }
            Err(error) => tracing::warn!(
                "ck-mc: skipping app checkpoint {}/{}/{}: {error}",
                key.runner,
                key.harness,
                key.session
            ),
        }
    }
    drop(stmt);
    conn.execute_batch("DROP TABLE app_read_snapshots;")
        .map_err(|e| e.to_string())
}

/// Version 8: save every message row in its compact form, and drop the
/// summary rows, which the replica now reads from `context.db`.
///
/// The rows move into a new table declared with a `BLOB` row, which then
/// takes the old table's name. A row that is already compact is copied as
/// it is. A JSON row is typed when it has the shape the projection builds,
/// and otherwise kept as JSON inside the compact form. A row that is not
/// JSON at all is kept as the text it was, marked as JSON, so loading it
/// fails as loading it failed before.
///
/// The caller runs this in the transaction that sets the schema version, so
/// a crash part way through leaves the version-7 tables as they were and the
/// next open starts again. A table left from an earlier attempt is dropped
/// first.
pub(crate) fn migrate_compact_rows(conn: &Connection) -> Result<(), String> {
    let step = |error: rusqlite::Error| format!("compacting app rows: {error}");
    conn.execute_batch(
        "DROP TABLE IF EXISTS app_read_messages_compact;
         CREATE TABLE app_read_messages_compact (
             runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
             message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, at_ms INTEGER NOT NULL,
             row BLOB NOT NULL, PRIMARY KEY(runner,harness,session,message_id)
         );",
    )
    .map_err(step)?;
    {
        let mut select = conn
            .prepare("SELECT runner, harness, session, message_id, ordinal, at_ms, row FROM app_read_messages")
            .map_err(step)?;
        let mut insert = conn
            .prepare("INSERT INTO app_read_messages_compact VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
            .map_err(step)?;
        let mut rows = select.query([]).map_err(step)?;
        while let Some(row) = rows.next().map_err(step)? {
            let mid: String = row.get(3).map_err(step)?;
            let compact = compact_row(&mid, row.get_ref(6).map_err(step)?);
            insert
                .execute(params![
                    row.get::<_, String>(0).map_err(step)?,
                    row.get::<_, String>(1).map_err(step)?,
                    row.get::<_, String>(2).map_err(step)?,
                    mid,
                    row.get::<_, i64>(4).map_err(step)?,
                    row.get::<_, i64>(5).map_err(step)?,
                    compact
                ])
                .map_err(step)?;
        }
    }
    conn.execute_batch(
        "DROP TABLE app_read_messages;
         ALTER TABLE app_read_messages_compact RENAME TO app_read_messages;
         DROP TABLE IF EXISTS app_read_summaries;",
    )
    .map_err(step)
}

/// One stored row in its compact form.
fn compact_row(mid: &str, stored: rusqlite::types::ValueRef<'_>) -> Vec<u8> {
    use rusqlite::types::ValueRef;
    match stored {
        ValueRef::Blob(bytes) => bytes.to_vec(),
        ValueRef::Text(text) => match serde_json::from_slice::<Value>(text) {
            Ok(value) => Row::from_json(mid, value).encode(),
            Err(_) => Row::unreadable(text),
        },
        // Not a row any version wrote; kept so that loading it fails.
        other => Row::unreadable(format!("{other:?}").as_bytes()),
    }
}

pub(crate) fn load_session(
    conn: &Connection,
    key: &SessionRef,
) -> rusqlite::Result<Option<Snapshot>> {
    let tx = conn.unchecked_transaction()?;
    let snapshot = load_rows(&tx, key)?;
    tx.commit()?;
    Ok(snapshot)
}

#[cfg(test)]
pub(crate) fn load(conn: &Connection) -> rusqlite::Result<Vec<Snapshot>> {
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare("SELECT runner,harness,session FROM app_read_headers")?;
    let keys = stmt.query_map([], |row| {
        Ok(SessionRef::new(
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut snapshots = Vec::new();
    for key in keys {
        if let Some(snapshot) = load_rows(&tx, &key?)? {
            snapshots.push(snapshot);
        }
    }
    drop(stmt);
    tx.commit()?;
    Ok(snapshots)
}

fn load_rows(conn: &Connection, key: &SessionRef) -> rusqlite::Result<Option<Snapshot>> {
    let text: Option<String> = conn
        .query_row(
            "SELECT header FROM app_read_headers WHERE runner=?1 AND harness=?2 AND session=?3",
            params![key.runner, key.harness, key.session],
            |row| row.get(0),
        )
        .optional()?;
    let Some(text) = text else { return Ok(None) };
    let mut messages = conn.prepare("SELECT message_id,ordinal,at_ms,row FROM app_read_messages WHERE runner=?1 AND harness=?2 AND session=?3")?;
    let result = (|| -> Result<Snapshot, String> {
        let h: Header = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let mut loaded = BTreeMap::new();
        let mut rows = messages
            .query(params![key.runner, key.harness, key.session])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mid: String = row.get(0).map_err(|e| e.to_string())?;
            let ordinal: u64 = row.get(1).map_err(|e| e.to_string())?;
            let at_ms: u64 = row.get(2).map_err(|e| e.to_string())?;
            let bytes = row
                .get_ref(3)
                .map_err(|e| e.to_string())?
                .as_blob()
                .map_err(|e| format!("message {mid}: {e}"))?;
            let decoded = Row::decode(bytes).map_err(|e| format!("message {mid}: {e}"))?;
            loaded.insert(
                mid,
                Arc::new(Message {
                    ordinal,
                    at_ms,
                    row: decoded,
                }),
            );
        }
        let decisions = crate::store::newest_view_decisions(conn, key).unwrap_or_default();
        Ok(Snapshot {
            key: key.clone(),
            base: h.base,
            newest: h.newest,
            ready: h.ready,
            meta: h.meta,
            breakdown: h.breakdown,
            messages: loaded,
            compartments: Vec::new(),
            decisions,
        })
    })();
    match result {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(error) => {
            tracing::warn!(
                "ck-mc: loading app checkpoint {}/{}/{}: {error}",
                key.runner,
                key.harness,
                key.session
            );
            Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(error)),
            ))
        }
    }
}
