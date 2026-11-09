//! Row-oriented checkpoints. Encode outside the transaction so unchanged rows
//! neither need cloning nor extend the store's write lock.
use super::{Header, Message, SessionRef, Snapshot};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_read_headers (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    header TEXT NOT NULL, PRIMARY KEY(runner,harness,session)
);
CREATE TABLE IF NOT EXISTS app_read_messages (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    row TEXT NOT NULL, PRIMARY KEY(runner,harness,session,message_id)
);
CREATE TABLE IF NOT EXISTS app_read_summaries (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    position INTEGER NOT NULL, row TEXT NOT NULL,
    PRIMARY KEY(runner,harness,session,position)
);";

pub(crate) struct Checkpoint {
    header: String,
    messages: Vec<(String, u64, u64, String)>,
    summaries: Option<Vec<String>>,
    removed: Vec<String>,
    reset: bool,
}

impl Checkpoint {
    pub(crate) fn new<'a>(
        header: &Header,
        messages: impl Iterator<Item = (&'a str, &'a Message)>,
        summaries: Option<&[Value]>,
        removed: impl Iterator<Item = &'a str>,
        reset: bool,
    ) -> Self {
        Self {
            header: header.json(),
            messages: messages
                .map(|(mid, m)| (mid.to_owned(), m.ordinal, m.at_ms, m.row.to_string()))
                .collect(),
            summaries: summaries.map(|rows| rows.iter().map(Value::to_string).collect()),
            removed: removed.map(str::to_owned).collect(),
            reset,
        }
    }

    pub(crate) fn full(s: &Snapshot) -> Self {
        Self::new(
            &Header {
                base: s.base,
                newest: s.newest,
                ready: s.ready,
                meta: s.meta.clone(),
                breakdown: s.breakdown.clone(),
            },
            s.messages.iter().map(|(mid, m)| (mid.as_str(), m)),
            Some(&s.compartments),
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
        if let Some(summaries) = &self.summaries {
            conn.execute(
                "DELETE FROM app_read_summaries WHERE runner=?1 AND harness=?2 AND session=?3",
                params![key.runner, key.harness, key.session],
            )?;
            let mut insert =
                conn.prepare_cached("INSERT INTO app_read_summaries VALUES(?1,?2,?3,?4,?5)")?;
            for (position, row) in summaries.iter().enumerate() {
                insert.execute(params![
                    key.runner,
                    key.harness,
                    key.session,
                    position as u64,
                    row
                ])?;
            }
        }
        Ok(())
    }
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
        match serde_json::from_str::<Snapshot>(&text) {
            Ok(snapshot) => {
                Checkpoint::full(&snapshot)
                    .write(conn, &key)
                    .map_err(|e| e.to_string())?;
                // A separately saved decision list is newer than the checkpoint.
                conn.execute("INSERT INTO app_read_decisions VALUES(?1,?2,?3,?4) ON CONFLICT(runner,harness,session) DO NOTHING", params![key.runner,key.harness,key.session,serde_json::to_string(&snapshot.decisions).expect("decision JSON")]).map_err(|e|e.to_string())?;
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

pub(crate) fn load(conn: &Connection) -> rusqlite::Result<Vec<Snapshot>> {
    let tx = conn.unchecked_transaction()?;
    let snapshots = load_rows(&tx)?;
    tx.commit()?;
    Ok(snapshots)
}

fn load_rows(conn: &Connection) -> rusqlite::Result<Vec<Snapshot>> {
    let mut headers = conn.prepare("SELECT runner,harness,session,header FROM app_read_headers")?;
    let rows = headers.query_map([], |row| {
        Ok((
            SessionRef::new(
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ),
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut messages = conn.prepare("SELECT message_id,ordinal,at_ms,row FROM app_read_messages WHERE runner=?1 AND harness=?2 AND session=?3")?;
    let mut summaries = conn.prepare("SELECT row FROM app_read_summaries WHERE runner=?1 AND harness=?2 AND session=?3 ORDER BY position")?;
    let mut snapshots = Vec::new();
    for row in rows {
        let (key, text) = row?;
        let result = (|| -> Result<Snapshot, String> {
            let h: Header = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let mut loaded = BTreeMap::new();
            for row in messages
                .query_map(params![key.runner, key.harness, key.session], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, u64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
            {
                let (mid, ordinal, at_ms, text) = row.map_err(|e| e.to_string())?;
                loaded.insert(
                    mid,
                    Message {
                        ordinal,
                        at_ms,
                        row: serde_json::from_str(&text).map_err(|e| e.to_string())?,
                    },
                );
            }
            let mut compartments = Vec::new();
            for row in summaries
                .query_map(params![key.runner, key.harness, key.session], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?
            {
                compartments.push(
                    serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?,
                );
            }
            Ok(Snapshot {
                key: key.clone(),
                base: h.base,
                newest: h.newest,
                ready: h.ready,
                meta: h.meta,
                breakdown: h.breakdown,
                messages: loaded,
                compartments,
                decisions: Vec::new(),
            })
        })();
        match result {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => tracing::warn!(
                "ck-mc: loading app checkpoint {}/{}/{}: {error}",
                key.runner,
                key.harness,
                key.session
            ),
        }
    }
    Ok(snapshots)
}
